-- Reuse one raw-retention watermark per import and bound maintenance work.
-- This migration changes no production facts, winners, summaries, or retention cutoff.
begin;

alter table public.daf_log_import_jobs
    add column if not exists raw_retention_cutoff date;

create or replace function public.daf_start_log_import(
    p_job_id uuid,
    p_file_name text,
    p_metadata jsonb,
    p_expected_chunks integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '55s'
-- A maintenance run that acquired the gate first is deliberately allowed to
-- finish; maintenance itself is now one small bounded task per minute.
set lock_timeout = '45s'
as $$
declare
    v_existing public.daf_log_import_jobs%rowtype;
    v_heads jsonb;
    v_cutoff date;
begin
    if p_job_id is null or nullif(trim(p_file_name), '') is null then raise exception 'job_id and file_name are required'; end if;
    if p_metadata is null or jsonb_typeof(p_metadata) <> 'array' or jsonb_array_length(p_metadata) > 5 then raise exception 'invalid process metadata'; end if;
    if p_expected_chunks < 0 or p_expected_chunks > 10000 then raise exception 'invalid expected chunk count'; end if;
    if exists (
        select 1 from jsonb_to_recordset(p_metadata) as m(line text)
        where m.line not in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
    ) then raise exception 'invalid process in import metadata'; end if;

    -- Serialize only upload creation against the short maintenance gate. Once
    -- the receiving job commits, maintenance sees it and defers for the upload.
    perform pg_advisory_xact_lock(hashtextextended('daf-upload-maintenance-gate', 92743));

    select * into v_existing from public.daf_log_import_jobs where id = p_job_id;
    if found then
        if v_existing.file_name <> p_file_name or v_existing.expected_chunks <> p_expected_chunks
           or v_existing.metadata is distinct from p_metadata then
            raise exception 'job id already belongs to another upload';
        end if;
        if v_existing.status not in ('receiving', 'published') then raise exception 'job is not resumable'; end if;
        if v_existing.raw_retention_cutoff is null then
            select raw_cutoff_date into v_cutoff
            from public.daf_log_compaction_state where id = 'current';
            if v_cutoff is null then v_cutoff := public.daf_latest_seven_production_days_cutoff(); end if;
            update public.daf_log_import_jobs
               set raw_retention_cutoff = v_cutoff
             where id = p_job_id and raw_retention_cutoff is null
             returning * into v_existing;
            if not found then select * into v_existing from public.daf_log_import_jobs where id = p_job_id; end if;
        end if;
        return jsonb_build_object('job_id', p_job_id, 'status', v_existing.status,
            'received_chunks', (select count(*) from public.daf_log_import_chunks where job_id = p_job_id),
            'expected_chunks', v_existing.expected_chunks, 'base_heads', v_existing.base_heads);
    end if;

    select raw_cutoff_date into v_cutoff
    from public.daf_log_compaction_state where id = 'current';
    if v_cutoff is null then v_cutoff := public.daf_latest_seven_production_days_cutoff(); end if;
    select coalesce(jsonb_object_agg(line, job_id::text), '{}'::jsonb) into v_heads
    from public.daf_log_active_file_processes where file_name = p_file_name;

    insert into public.daf_log_import_jobs(
        id, file_name, metadata, base_heads, expected_chunks, raw_retention_cutoff
    ) values (p_job_id, p_file_name, p_metadata, v_heads, p_expected_chunks, v_cutoff)
    on conflict (id) do nothing;

    select * into v_existing from public.daf_log_import_jobs where id = p_job_id;
    if v_existing.file_name <> p_file_name or v_existing.expected_chunks <> p_expected_chunks
       or v_existing.metadata is distinct from p_metadata then
        raise exception 'job id already belongs to another upload';
    end if;
    if v_existing.status not in ('receiving', 'published') then raise exception 'job is not resumable'; end if;
    if v_existing.raw_retention_cutoff is null then
        update public.daf_log_import_jobs set raw_retention_cutoff = v_cutoff where id = p_job_id;
    end if;
    return jsonb_build_object('job_id', p_job_id, 'status', v_existing.status,
        'received_chunks', (select count(*) from public.daf_log_import_chunks where job_id = p_job_id),
        'expected_chunks', v_existing.expected_chunks, 'base_heads', v_existing.base_heads);
end;
$$;

create or replace function public.daf_stage_log_import_chunk(
    p_job_id uuid,
    p_line text,
    p_chunk_index integer,
    p_content_hash text,
    p_records jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '55s'
set lock_timeout = '7s'
as $$
declare
    v_job public.daf_log_import_jobs%rowtype;
    v_cutoff date;
    v_record_count integer;
    v_inserted boolean;
begin
    select * into v_job from public.daf_log_import_jobs where id = p_job_id;
    if not found or v_job.status <> 'receiving' then raise exception 'upload job is not receiving'; end if;
    if p_line not in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY') then raise exception 'invalid process'; end if;
    if not exists (
        select 1 from jsonb_array_elements(v_job.metadata) m(value)
        where m.value->>'line' = p_line
    ) then raise exception 'process is not part of this upload'; end if;
    if p_chunk_index < 0 or p_chunk_index >= v_job.expected_chunks then raise exception 'chunk index out of range'; end if;
    if jsonb_typeof(p_records) <> 'array' then raise exception 'records must be a JSON array'; end if;
    v_record_count := jsonb_array_length(p_records);
    if v_record_count > 500 then raise exception 'chunk exceeds 500 records'; end if;

    v_cutoff := v_job.raw_retention_cutoff;
    if v_cutoff is null then
        select raw_cutoff_date into v_cutoff from public.daf_log_compaction_state where id = 'current';
    end if;
    if v_cutoff is null then v_cutoff := public.daf_latest_seven_production_days_cutoff(); end if;

    insert into public.daf_log_import_chunks(job_id, line, chunk_index, content_hash, row_count)
    values (p_job_id, p_line, p_chunk_index, p_content_hash, v_record_count)
    on conflict (job_id, line, chunk_index) do nothing
    returning true into v_inserted;
    if not coalesce(v_inserted, false) then
        if not exists (
            select 1 from public.daf_log_import_chunks c
            where c.job_id = p_job_id and c.line = p_line and c.chunk_index = p_chunk_index
              and c.content_hash = p_content_hash and c.row_count = v_record_count
        ) then raise exception 'chunk retry payload does not match the saved chunk'; end if;
        return jsonb_build_object('saved', true, 'resumed', true, 'rows', v_record_count);
    end if;

    with parsed as (
        select item.ordinality, item.value as original_json,
               nullif(upper(btrim(item.value->>'dedupKey')), '') as dedup_key,
               case when coalesce(item.value->>'dedupTime', '') ~ '^-?[0-9]+$'
                    then (item.value->>'dedupTime')::bigint else null end as dedup_time,
               nullif(item.value->>'date', '') as report_date,
               coalesce(item.value->>'workOrder', '') as work_order,
               coalesce(item.value->>'productCode', '') as product_code,
               coalesce(item.value->>'model', '') as model_name,
               coalesce(item.value->>'status', '') as status,
               coalesce(item.value->>'defect', '') as defect,
               coalesce(item.value->>'machine', '') as machine,
               coalesce((item.value->>'inputIncluded')::boolean, false) as input_included,
               coalesce((item.value->>'isDefect')::boolean, false) as is_defect,
               coalesce(item.value->>'sourceFormat', '') as source_format
        from jsonb_array_elements(p_records) with ordinality item(value, ordinality)
    ), expected as (
        select parsed.*, jsonb_build_object(
            'dedupKey', dedup_key, 'dedupTime', dedup_time, 'date', report_date,
            'workOrder', work_order, 'productCode', product_code, 'model', model_name,
            'status', status, 'defect', defect, 'machine', machine,
            'inputIncluded', input_included, 'isDefect', is_defect,
            'sourceFormat', source_format
        ) as expected_json from parsed
    ), compacted as (
        select expected.*,
               public.daf_try_slim_candidate_json(original_json, expected_json, v_cutoff) as slim_json
        from expected
    )
    insert into public.daf_log_candidates(
        id, job_id, line, file_name, dedup_key, dedup_time, report_date,
        work_order, product_code, model_name, status, defect, machine,
        input_included, is_defect, source_format, record_json,
        record_storage_version, created_at
    )
    select p_job_id::text || ':' || p_line || ':' || p_chunk_index::text || ':' || c.ordinality::text,
           p_job_id, p_line, v_job.file_name, c.dedup_key, c.dedup_time, c.report_date,
           c.work_order, c.product_code, c.model_name, c.status, c.defect, c.machine,
           c.input_included, c.is_defect, c.source_format,
           coalesce(c.slim_json, c.original_json),
           case when c.slim_json is null then 1 else 2 end,
           v_job.created_at
    from compacted c
    on conflict (id) do nothing;

    return jsonb_build_object('saved', true, 'resumed', false, 'rows', v_record_count);
end;
$$;

grant execute on function public.daf_start_log_import(uuid, text, jsonb, integer)
    to anon, authenticated;
grant execute on function public.daf_stage_log_import_chunk(uuid, text, integer, text, jsonb)
    to anon, authenticated;

-- PostgREST starts its statement timer before entering the RPC, so SET clauses
-- on the RPC functions cannot extend the authenticator's short API timeout.
-- Raise the transaction-local timeout in the existing pre-request hook only
-- for the staged-upload RPCs; all other dashboard/API requests keep their
-- existing timeout and the hook's session enforcement remains unchanged.
create or replace function public.dashboard_require_session()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_path text := coalesce(current_setting('request.path', true), '');
begin
    perform set_config('response.headers', '[{"Cache-Control":"private, no-store"}]', true);
    if (select enabled from dashboard_private.access_settings where id)
       and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') <> 'service_role'
       and v_path not in ('/rpc/dashboard_login', '/rpc/dashboard_session_validate')
       and dashboard_private.current_account_id() is null then
        raise sqlstate 'PT401' using message = '請先登入，或重新輸入帳號密碼';
    end if;

    if v_path in (
        '/rpc/daf_start_log_import',
        '/rpc/daf_stage_log_import_chunk',
        '/rpc/daf_finalize_log_import',
        '/rpc/daf_get_log_import_status',
        '/rpc/daf_abort_log_import'
    ) then
        perform set_config('statement_timeout', '60s', true);
    end if;
end;
$$;

notify pgrst, 'reload schema';
commit;
