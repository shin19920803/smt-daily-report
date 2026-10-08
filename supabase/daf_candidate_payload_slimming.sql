-- Reduce duplicated JSON fields in five-process candidates without changing
-- the public RPC record shape. Apply after the compatible helpers in
-- daf_historical_compaction.sql have been installed.
begin;
set local statement_timeout = '300s';

do $$
begin
    if not exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'daf_log_candidates'
          and column_name = 'record_storage_version'
    ) then
        raise exception '先套用支援 record_storage_version 的 daf_historical_compaction.sql';
    end if;
    if to_regprocedure('public.daf_candidate_canonical_json(public.daf_log_candidates)') is null
       or to_regprocedure('public.daf_candidate_to_record(public.daf_log_candidates)') is null
       or to_regprocedure('public.daf_candidate_payload_mismatch(public.daf_log_candidates)') is null then
        raise exception '缺少相容讀取／封存函式，停止啟用精簡寫入';
    end if;
end;
$$;

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.daf_log_candidates'::regclass
          and conname = 'daf_log_candidates_slim_payload_check'
    ) then
        alter table public.daf_log_candidates
            add constraint daf_log_candidates_slim_payload_check
            check (
                record_storage_version = 1
                or (
                    jsonb_typeof(record_json) = 'object'
                    and not (record_json ?| array[
                        'dedupKey', 'dedupTime', 'date', 'workOrder', 'productCode', 'model',
                        'status', 'defect', 'machine', 'inputIncluded', 'isDefect', 'sourceFormat'
                    ])
                    and (not (record_json ? 'raw') or jsonb_typeof(record_json->'raw') = 'array')
                )
            ) not valid;
    end if;
end;
$$;

create or replace function public.daf_try_slim_candidate_json(p_record jsonb, p_expected jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
    select case
        when jsonb_typeof(p_record) = 'object'
         and jsonb_typeof(p_expected) = 'object'
         and p_record ?& array[
        'dedupKey', 'dedupTime', 'date', 'workOrder', 'productCode', 'model',
        'status', 'defect', 'machine', 'inputIncluded', 'isDefect', 'sourceFormat'
         ]
         and p_expected ?& array[
        'dedupKey', 'dedupTime', 'date', 'workOrder', 'productCode', 'model',
        'status', 'defect', 'machine', 'inputIncluded', 'isDefect', 'sourceFormat'
         ]
         and p_record @> p_expected
         and (
             not (p_record ? 'raw')
             or (
                 jsonb_typeof(p_record->'raw') = 'array'
                 and (
                     nullif(btrim(coalesce(p_expected->>'productCode', '')), '') is not null
                     or coalesce(p_record->'raw'->>(case when p_record->>'sourceFormat' = 'current-v2' or p_record->'raw'->>0 = 'FT1' then 3 else 4 end), '') = ''
                 )
                 and (
                     nullif(btrim(coalesce(p_expected->>'dedupKey', '')), '') is not null
                     or coalesce(p_record->'raw'->>(case when p_record->>'sourceFormat' = 'current-v2' or p_record->'raw'->>0 = 'FT1' then 4 else 5 end), '') = ''
                 )
                 and (
                     nullif(btrim(coalesce(p_expected->>'dedupTime', '')), '') is not null
                     or coalesce(p_record->'raw'->>(case when p_record->>'sourceFormat' = 'current-v2' or p_record->'raw'->>0 = 'FT1' then 5 else 6 end), '') = ''
                 )
             )
         )
        then (p_record - array[
            'dedupKey', 'dedupTime', 'date', 'workOrder', 'productCode', 'model',
            'status', 'defect', 'machine', 'inputIncluded', 'isDefect', 'sourceFormat'
        ]) - 'raw'
        else null
    end;
$$;

create or replace function public.daf_preview_candidate_slimming()
returns table (
    line text,
    candidate_rows bigint,
    eligible_rows bigint,
    retained_full_rows bigint,
    json_payload_bytes bigint,
    estimated_slim_payload_bytes bigint,
    estimated_payload_savings_bytes bigint,
    raw_payload_bytes bigint
)
language sql
security definer
set search_path = public
stable
as $$
    with evaluated as (
        select c.line, c.record_json,
               public.daf_try_slim_candidate_json(
                   c.record_json, public.daf_candidate_canonical_json(c)
               ) as slim_json
        from public.daf_log_candidates c
        join public.daf_log_import_jobs j on j.id = c.job_id
        where c.record_storage_version = 1 and j.status <> 'receiving'
    )
    select e.line,
           count(*)::bigint,
           count(*) filter (where e.slim_json is not null)::bigint,
           count(*) filter (where e.slim_json is null)::bigint,
           coalesce(sum(pg_column_size(e.record_json)), 0)::bigint,
           coalesce(sum(pg_column_size(e.slim_json)) filter (where e.slim_json is not null), 0)::bigint,
           coalesce(sum(pg_column_size(e.record_json) - pg_column_size(e.slim_json)) filter (where e.slim_json is not null), 0)::bigint,
           coalesce(sum(pg_column_size(e.record_json->'raw')), 0)::bigint
    from evaluated e
    group by e.line
    order by e.line;
$$;

create or replace function public.daf_slim_log_candidates_batch(p_batch_size integer default 500, p_after_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '55s'
as $$
declare
    v_scanned integer := 0;
    v_converted integer := 0;
    v_unmodified integer := 0;
    v_next_id text;
    v_has_more boolean;
    v_json_bytes_before bigint := 0;
    v_json_bytes_after bigint := 0;
begin
    if p_batch_size is null or p_batch_size < 1 or p_batch_size > 5000 then
        raise exception '每批筆數須介於 1 至 5000';
    end if;

    if to_regclass('pg_temp._daf_candidate_slim_batch') is null then
        create temporary table _daf_candidate_slim_batch (
        id text primary key,
        original_json jsonb not null,
        slim_json jsonb,
        candidate_version smallint not null,
        created_at timestamptz not null
        ) on commit delete rows;
    end if;
    truncate table _daf_candidate_slim_batch;

    -- Same ordered per-process lock family used by publish, delete and compaction.
    perform pg_advisory_xact_lock(hashtextextended(v_line, 92742))
    from (values ('ASSEMBLY'), ('DAF'), ('FT1'), ('FT2'), ('LIGHTING')) as lines(v_line)
    order by v_line;

    if p_after_id is null then
        with picked as materialized (
            select c.id, c.record_json, c.created_at,
                   public.daf_try_slim_candidate_json(
                       c.record_json, public.daf_candidate_canonical_json(c)
                   ) as slim_json,
                   c.record_storage_version as candidate_version
            from public.daf_log_candidates c
            join public.daf_log_import_jobs j on j.id = c.job_id
            where j.status <> 'receiving' and c.record_storage_version = 1
            order by c.id
            limit p_batch_size
            for update of c
        )
        insert into _daf_candidate_slim_batch(id, original_json, slim_json, candidate_version, created_at)
        select id, record_json, slim_json, candidate_version, created_at from picked;
    else
        with picked as materialized (
            select c.id, c.record_json, c.created_at,
                   public.daf_try_slim_candidate_json(
                       c.record_json, public.daf_candidate_canonical_json(c)
                   ) as slim_json,
                   c.record_storage_version as candidate_version
            from public.daf_log_candidates c
            join public.daf_log_import_jobs j on j.id = c.job_id
            where j.status <> 'receiving'
              and c.record_storage_version = 1
              and c.id > p_after_id
            order by c.id
            limit p_batch_size
            for update of c
        )
        insert into _daf_candidate_slim_batch(id, original_json, slim_json, candidate_version, created_at)
        select id, record_json, slim_json, candidate_version, created_at from picked;
    end if;

    get diagnostics v_scanned = row_count;
    select max(id) into v_next_id from _daf_candidate_slim_batch;
    select coalesce(sum(pg_column_size(original_json)), 0),
           coalesce(sum(pg_column_size(coalesce(slim_json, original_json))), 0)
      into v_json_bytes_before, v_json_bytes_after
      from _daf_candidate_slim_batch;

    update public.daf_log_candidates c
       set record_json = b.slim_json,
           record_storage_version = 2
      from _daf_candidate_slim_batch b
     where c.id = b.id and b.slim_json is not null
       and b.candidate_version = 1 and c.record_storage_version = 1;
    get diagnostics v_converted = row_count;

    if exists (
        select 1
        from _daf_candidate_slim_batch b
        join public.daf_log_candidates c on c.id = b.id
        where b.slim_json is not null
          and public.daf_candidate_to_record(c) is distinct from
              (b.original_json - case when b.original_json ? 'raw' then array['raw']::text[] else array[]::text[] end)
    ) then
        raise exception '候選資料精簡後無法逐筆還原原 JSON，本批次已回復';
    end if;

    select count(*)::integer into v_unmodified
    from _daf_candidate_slim_batch where candidate_version = 1 and slim_json is null;
    -- An exact multiple causes one harmless empty final batch.
    v_has_more := v_scanned = p_batch_size;

    return jsonb_build_object(
        'scanned', v_scanned,
        'converted', v_converted,
        'retained_original', v_unmodified,
        'json_bytes_before', v_json_bytes_before,
        'json_bytes_after', v_json_bytes_after,
        'json_bytes_saved', v_json_bytes_before - v_json_bytes_after,
        'next_id', v_next_id,
        'has_more', v_has_more
    );
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
as $$
declare
    v_job public.daf_log_import_jobs%rowtype;
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

    insert into public.daf_log_import_chunks(job_id, line, chunk_index, content_hash, row_count)
    values (p_job_id, p_line, p_chunk_index, p_content_hash, v_record_count)
    on conflict (job_id, line, chunk_index) do nothing
    returning true into v_inserted;
    if not coalesce(v_inserted, false) then
        if not exists (
            select 1 from public.daf_log_import_chunks c
            where c.job_id = p_job_id and c.line = p_line and c.chunk_index = p_chunk_index
              and c.content_hash = p_content_hash and c.row_count = v_record_count
        ) then
            raise exception 'chunk retry payload does not match the saved chunk';
        end if;
        return jsonb_build_object('saved', true, 'resumed', true, 'rows', v_record_count);
    end if;

    with parsed as (
        select item.ordinality,
               item.value as original_json,
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
        select parsed.*,
               jsonb_build_object(
                   'dedupKey', dedup_key, 'dedupTime', dedup_time,
                   'date', report_date, 'workOrder', work_order,
                   'productCode', product_code, 'model', model_name,
                   'status', status, 'defect', defect, 'machine', machine,
                   'inputIncluded', input_included, 'isDefect', is_defect,
                   'sourceFormat', source_format
               ) as expected_json
        from parsed
    ), compacted as (
        select expected.*,
               public.daf_try_slim_candidate_json(original_json, expected_json) as slim_json
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

revoke all on function public.daf_try_slim_candidate_json(jsonb, jsonb),
    public.daf_preview_candidate_slimming(),
    public.daf_slim_log_candidates_batch(integer, text)
from public, anon, authenticated;
grant execute on function public.daf_stage_log_import_chunk(uuid, text, integer, text, jsonb)
to anon, authenticated;

notify pgrst, 'reload schema';
commit;
