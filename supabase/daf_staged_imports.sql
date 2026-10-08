-- DAF / FT1 / FT2 / LIGHTING / ASSEMBLY staged import pipeline.
-- Run after daf_log_batches.sql. Legacy batches are copied into the indexed winner store;
-- their JSON payloads stay intact so a rollback remains possible.

begin;
set local statement_timeout = '300000';

create table if not exists public.daf_log_import_jobs (
    id uuid primary key,
    file_name text not null,
    status text not null default 'receiving' check (status in ('receiving', 'published', 'superseded', 'failed')),
    metadata jsonb not null default '[]'::jsonb,
    base_heads jsonb not null default '{}'::jsonb,
    expected_chunks integer not null default 0 check (expected_chunks >= 0),
    created_at timestamptz not null default now(),
    published_at timestamptz,
    superseded_at timestamptz,
    accepted_count integer not null default 0,
    duplicate_count integer not null default 0,
    error_text text
);
alter table public.daf_log_import_jobs add column if not exists accepted_count integer not null default 0;
alter table public.daf_log_import_jobs add column if not exists duplicate_count integer not null default 0;

create index if not exists daf_log_import_jobs_file_status_idx
    on public.daf_log_import_jobs (file_name, status, created_at desc);

create table if not exists public.daf_log_import_chunks (
    job_id uuid not null references public.daf_log_import_jobs(id) on delete cascade,
    line text not null check (line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')),
    chunk_index integer not null check (chunk_index >= 0),
    content_hash text not null,
    row_count integer not null check (row_count between 0 and 500),
    created_at timestamptz not null default now(),
    primary key (job_id, line, chunk_index)
);

create table if not exists public.daf_log_candidates (
    id text primary key,
    job_id uuid not null references public.daf_log_import_jobs(id) on delete cascade,
    line text not null check (line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')),
    file_name text not null,
    dedup_key text,
    dedup_time bigint,
    report_date text,
    work_order text,
    product_code text,
    model_name text,
    status text,
    defect text,
    machine text,
    input_included boolean not null default false,
    is_defect boolean not null default false,
    source_format text,
    record_json jsonb not null,
    created_at timestamptz not null default now()
);

create index if not exists daf_log_candidates_key_time_idx
    on public.daf_log_candidates (line, dedup_key, dedup_time, created_at)
    where dedup_key is not null;
create index if not exists daf_log_candidates_job_idx
    on public.daf_log_candidates (job_id, line);

create table if not exists public.daf_log_active_file_processes (
    line text not null check (line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')),
    file_name text not null,
    job_id uuid not null references public.daf_log_import_jobs(id),
    metadata jsonb not null default '{}'::jsonb,
    uploaded_at timestamptz not null default now(),
    primary key (line, file_name)
);

create table if not exists public.daf_log_winners (
    candidate_id text primary key references public.daf_log_candidates(id) on delete cascade,
    line text not null check (line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')),
    dedup_key text,
    file_name text not null,
    job_id uuid not null references public.daf_log_import_jobs(id)
);

create unique index if not exists daf_log_winners_unique_e_idx
    on public.daf_log_winners (line, dedup_key) where dedup_key is not null;
create index if not exists daf_log_winners_file_idx
    on public.daf_log_winners (line, file_name);
create index if not exists daf_log_winners_job_idx
    on public.daf_log_winners (job_id, line);

alter table public.daf_log_import_jobs disable row level security;
alter table public.daf_log_import_chunks disable row level security;
alter table public.daf_log_candidates disable row level security;
alter table public.daf_log_active_file_processes disable row level security;
alter table public.daf_log_winners disable row level security;

revoke all on public.daf_log_import_jobs, public.daf_log_import_chunks,
    public.daf_log_candidates, public.daf_log_active_file_processes,
    public.daf_log_winners from anon, authenticated;

-- One-time import of the active legacy batches. Re-running is safe and keeps their raw JSON intact.
create temporary table if not exists _daf_legacy_file_jobs (
    file_name text primary key,
    job_id uuid not null
) on commit drop;
truncate table _daf_legacy_file_jobs;
insert into _daf_legacy_file_jobs(file_name, job_id)
select distinct b.file_name,
       (substr(md5('koya-daf-legacy:' || b.file_name), 1, 8) || '-' ||
        substr(md5('koya-daf-legacy:' || b.file_name), 9, 4) || '-' ||
        substr(md5('koya-daf-legacy:' || b.file_name), 13, 4) || '-' ||
        substr(md5('koya-daf-legacy:' || b.file_name), 17, 4) || '-' ||
        substr(md5('koya-daf-legacy:' || b.file_name), 21, 12))::uuid
from public.daf_log_batches b
where b.line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
  and nullif(b.file_name, '') is not null;

insert into public.daf_log_import_jobs(id, file_name, status, metadata, expected_chunks, created_at, published_at)
select m.job_id, m.file_name, 'published',
       coalesce(jsonb_agg(to_jsonb(b) - 'records'), '[]'::jsonb), 0,
       max(b.uploaded_at), max(b.uploaded_at)
from _daf_legacy_file_jobs m
join public.daf_log_batches b on b.file_name = m.file_name
    and b.line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
group by m.job_id, m.file_name
on conflict (id) do nothing;

-- Keep only the latest same-name legacy batch per process, matching replacement semantics.
with latest as (
    select distinct on (line, file_name) *
    from public.daf_log_batches
    where line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
      and nullif(file_name, '') is not null
    order by line, file_name, uploaded_at desc, id asc
)
insert into public.daf_log_active_file_processes(line, file_name, job_id, metadata, uploaded_at)
select b.line, b.file_name, m.job_id, to_jsonb(b) - 'records', b.uploaded_at
from latest b
join _daf_legacy_file_jobs m using (file_name)
on conflict (line, file_name) do nothing;

with latest as (
    select distinct on (line, file_name) *
    from public.daf_log_batches
    where line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
      and nullif(file_name, '') is not null
    order by line, file_name, uploaded_at desc, id asc
), expanded as (
    select b.id || ':' || item.ordinality::text as candidate_id,
           m.job_id, b.line, b.file_name,
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
           coalesce(item.value->>'sourceFormat', '') as source_format,
           item.value as record_json,
           b.uploaded_at as created_at
    from latest b
    join _daf_legacy_file_jobs m using (file_name)
    cross join lateral jsonb_array_elements(coalesce(b.records, '[]'::jsonb)) with ordinality item(value, ordinality)
)
insert into public.daf_log_candidates(
    id, job_id, line, file_name, dedup_key, dedup_time, report_date, work_order,
    product_code, model_name, status, defect, machine, input_included, is_defect,
    source_format, record_json, created_at
)
select * from expanded
on conflict (id) do nothing;

-- Materialize one earliest row for each non-empty E value. Empty E values remain independent rows.
with ranked as (
    select c.id, c.job_id, c.line, c.dedup_key, c.file_name,
           row_number() over (
               partition by c.line, c.dedup_key
               order by c.dedup_time asc nulls last, c.created_at asc, c.id asc
           ) as row_number
    from public.daf_log_candidates c
    join public.daf_log_active_file_processes h
      on h.line = c.line and h.file_name = c.file_name and h.job_id = c.job_id
    where c.dedup_key is not null
)
insert into public.daf_log_winners(candidate_id, line, dedup_key, file_name, job_id)
select id, line, dedup_key, file_name, job_id from ranked where row_number = 1
on conflict (candidate_id) do nothing;

insert into public.daf_log_winners(candidate_id, line, dedup_key, file_name, job_id)
select c.id, c.line, null, c.file_name, c.job_id
from public.daf_log_candidates c
join public.daf_log_active_file_processes h
  on h.line = c.line and h.file_name = c.file_name and h.job_id = c.job_id
where c.dedup_key is null
on conflict (candidate_id) do nothing;

create or replace function public.refresh_daf_log_batch_summaries(p_pairs jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    perform set_config('koya.allow_daf_summary_write', 'on', true);
    delete from public.daf_log_batches b
    using jsonb_to_recordset(coalesce(p_pairs, '[]'::jsonb)) as p(line text, file_name text)
    where b.line = p.line and b.file_name = p.file_name
      and b.line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY');

    insert into public.daf_log_batches (
        id, line, file_name, uploaded_at, model_name, product_code, work_order,
        report_date, date_start, date_end, input_count, good_count, fail_count,
        yield_rate, defect_rate, unknown_status_count, unknown_status_text,
        row_count, raw_column_count, records
    )
    with targets as (
        select distinct p.line, p.file_name
        from jsonb_to_recordset(coalesce(p_pairs, '[]'::jsonb)) as p(line text, file_name text)
        where p.line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
    ), aggregate_rows as (
        select h.line, h.file_name, h.metadata,
               h.metadata->>'id' as old_id,
               h.uploaded_at,
               count(c.id)::integer as row_count,
               count(*) filter (where c.input_included)::integer as input_count,
               count(*) filter (where c.input_included and upper(c.status) = 'GOOD')::integer as good_count,
               count(*) filter (where c.input_included and upper(c.status) = 'FAIL')::integer as fail_count,
               count(*) filter (where c.status <> '' and upper(c.status) not in ('GOOD', 'FAIL'))::integer as unknown_status_count,
               coalesce(string_agg(distinct nullif(c.model_name, ''), '、'), h.metadata->>'model_name', '未識別機種') as model_name,
               coalesce(string_agg(distinct nullif(c.product_code, ''), '、'), h.metadata->>'product_code', '未識別產品代碼') as product_code,
               coalesce(string_agg(distinct nullif(c.work_order, ''), '、'), h.metadata->>'work_order', '未識別工單') as work_order,
               coalesce(string_agg(distinct nullif(c.status, ''), '、') filter (where c.status <> '' and upper(c.status) not in ('GOOD', 'FAIL')), '無') as unknown_status_text,
               coalesce(min(c.report_date) filter (where c.report_date ~ '^\d{4}-\d{2}-\d{2}$'), h.metadata->>'date_start') as date_start,
               coalesce(max(c.report_date) filter (where c.report_date ~ '^\d{4}-\d{2}-\d{2}$'), h.metadata->>'date_end') as date_end,
               coalesce((h.metadata->>'raw_column_count')::integer, 10) as raw_column_count
        from targets t
        join public.daf_log_active_file_processes h on h.line = t.line and h.file_name = t.file_name
        left join public.daf_log_winners w on w.line = t.line and w.file_name = t.file_name
        left join public.daf_log_candidates c on c.id = w.candidate_id
        group by h.line, h.file_name, h.metadata, h.uploaded_at
    )
    select coalesce(a.old_id, 'dafv2:' || a.line || ':' || md5(a.file_name)),
           a.line, a.file_name, a.uploaded_at, a.model_name, a.product_code, a.work_order,
           case when a.date_start is null then coalesce(a.metadata->>'report_date', '未識別日期')
                when a.date_start = a.date_end then a.date_start
                else a.date_start || '～' || a.date_end end,
           a.date_start, a.date_end, a.input_count, a.good_count, a.fail_count,
           case when a.input_count > 0 then round(a.good_count::numeric * 100 / a.input_count, 2) else 0 end,
           case when a.input_count > 0 then round(a.fail_count::numeric * 100 / a.input_count, 2) else 0 end,
           a.unknown_status_count, a.unknown_status_text, a.row_count, a.raw_column_count, '[]'::jsonb
    from aggregate_rows a;
end;
$$;

-- Rebuild every legacy summary once so cross-file E-column winners and empty
-- duplicate-only files agree with the normalized detail store after cutover.
select public.refresh_daf_log_batch_summaries(
    coalesce(
        (select jsonb_agg(jsonb_build_object('line', line, 'file_name', file_name)
                          order by line, file_name)
         from public.daf_log_active_file_processes),
        '[]'::jsonb
    )
);

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
as $$
declare
    v_existing public.daf_log_import_jobs%rowtype;
    v_heads jsonb;
begin
    if p_job_id is null or nullif(trim(p_file_name), '') is null then raise exception 'job_id and file_name are required'; end if;
    if p_metadata is null or jsonb_typeof(p_metadata) <> 'array' or jsonb_array_length(p_metadata) > 5 then raise exception 'invalid process metadata'; end if;
    if p_expected_chunks < 0 or p_expected_chunks > 10000 then raise exception 'invalid expected chunk count'; end if;
    if exists (
        select 1 from jsonb_to_recordset(p_metadata) as m(line text)
        where m.line not in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
    ) then raise exception 'invalid process in import metadata'; end if;

    select coalesce(jsonb_object_agg(line, job_id::text), '{}'::jsonb) into v_heads
    from public.daf_log_active_file_processes where file_name = p_file_name;

    insert into public.daf_log_import_jobs(id, file_name, metadata, base_heads, expected_chunks)
    values (p_job_id, p_file_name, p_metadata, v_heads, p_expected_chunks)
    on conflict (id) do nothing;
    select * into v_existing from public.daf_log_import_jobs where id = p_job_id;
    if v_existing.file_name <> p_file_name or v_existing.expected_chunks <> p_expected_chunks
       or v_existing.metadata is distinct from p_metadata then
        raise exception 'job id already belongs to another upload';
    end if;
    if v_existing.status not in ('receiving', 'published') then raise exception 'job is not resumable'; end if;
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
as $$
declare
    v_job public.daf_log_import_jobs%rowtype;
    v_record_count integer;
    v_inserted boolean;
    v_existing public.daf_log_import_chunks%rowtype;
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
        select * into v_existing from public.daf_log_import_chunks
        where job_id = p_job_id and line = p_line and chunk_index = p_chunk_index;
        if v_existing.content_hash <> p_content_hash or v_existing.row_count <> v_record_count then
            raise exception 'chunk retry payload does not match the saved chunk';
        end if;
        return jsonb_build_object('saved', true, 'resumed', true, 'rows', v_record_count);
    end if;

    insert into public.daf_log_candidates(
        id, job_id, line, file_name, dedup_key, dedup_time, report_date,
        work_order, product_code, model_name, status, defect, machine,
        input_included, is_defect, source_format, record_json, created_at
    )
    select p_job_id::text || ':' || p_line || ':' || p_chunk_index::text || ':' || item.ordinality::text,
           p_job_id, p_line, v_job.file_name,
           nullif(upper(btrim(item.value->>'dedupKey')), ''),
           case when coalesce(item.value->>'dedupTime', '') ~ '^-?[0-9]+$' then (item.value->>'dedupTime')::bigint else null end,
           nullif(item.value->>'date', ''), coalesce(item.value->>'workOrder', ''),
           coalesce(item.value->>'productCode', ''), coalesce(item.value->>'model', ''),
           coalesce(item.value->>'status', ''), coalesce(item.value->>'defect', ''),
           coalesce(item.value->>'machine', ''), coalesce((item.value->>'inputIncluded')::boolean, false),
           coalesce((item.value->>'isDefect')::boolean, false), coalesce(item.value->>'sourceFormat', ''),
           item.value, v_job.created_at
    from jsonb_array_elements(p_records) with ordinality item(value, ordinality)
    on conflict (id) do nothing;

    return jsonb_build_object('saved', true, 'resumed', false, 'rows', v_record_count);
end;
$$;

create or replace function public.daf_get_log_import_status(p_job_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
    select case when j.id is null then null else jsonb_build_object(
        'job_id', j.id, 'file_name', j.file_name, 'status', j.status,
        'received_chunks', (select count(*) from public.daf_log_import_chunks c where c.job_id = j.id),
        'expected_chunks', j.expected_chunks, 'error_text', j.error_text
    ) end
    from (select p_job_id as id) input
    left join public.daf_log_import_jobs j on j.id = input.id;
$$;

create or replace function public.daf_finalize_log_import(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '55s'
as $$
declare
    v_job public.daf_log_import_jobs%rowtype;
    v_current_heads jsonb;
    v_old_jobs uuid[];
    v_chunk_count integer;
    v_total integer;
    v_kept integer;
    v_duplicates integer;
    v_pairs jsonb;
    v_lock record;
begin
    select * into v_job from public.daf_log_import_jobs where id = p_job_id for update;
    if not found then raise exception 'upload job not found'; end if;
    if v_job.status = 'published' then
        return jsonb_build_object('published', true, 'accepted_count', v_job.accepted_count,
            'duplicate_count', v_job.duplicate_count, 'resumed', true);
    end if;
    if v_job.status <> 'receiving' then raise exception 'upload job cannot be published'; end if;
    perform pg_advisory_xact_lock(hashtextextended(v_job.file_name, 92741));

    select coalesce(jsonb_object_agg(line, job_id::text), '{}'::jsonb) into v_current_heads
    from public.daf_log_active_file_processes where file_name = v_job.file_name;
    if v_current_heads <> v_job.base_heads then raise exception '檔案已被其他上傳更新，請重新上傳'; end if;
    select count(*), coalesce(sum(row_count), 0)::integer
      into v_chunk_count, v_total
      from public.daf_log_import_chunks where job_id = p_job_id;
    if v_chunk_count <> v_job.expected_chunks then raise exception '上傳分批未完成'; end if;
    if exists (
        select 1 from public.daf_log_import_chunks
        where job_id = p_job_id
        group by line
        having min(chunk_index) <> 0 or max(chunk_index) + 1 <> count(*)
    ) then raise exception '上傳分批序號不完整'; end if;
    create temporary table _daf_import_keys(line text, dedup_key text, primary key(line, dedup_key)) on commit drop;
    create temporary table _daf_import_pairs(line text, file_name text, primary key(line, file_name)) on commit drop;
    create temporary table _daf_import_old_jobs(job_id uuid primary key) on commit drop;

    insert into _daf_import_old_jobs
    select distinct job_id from public.daf_log_active_file_processes where file_name = v_job.file_name;
    insert into _daf_import_pairs
    select line, file_name from public.daf_log_winners where file_name = v_job.file_name
    on conflict do nothing;
    insert into _daf_import_keys
    select line, dedup_key from public.daf_log_winners
    where file_name = v_job.file_name and dedup_key is not null
    on conflict do nothing;
    insert into _daf_import_keys
    select distinct line, dedup_key from public.daf_log_candidates
    where job_id = p_job_id and dedup_key is not null
    on conflict do nothing;
    for v_lock in
        select affected.line
        from (
            select line from public.daf_log_active_file_processes where file_name = v_job.file_name
            union
            select m.value->>'line' as line
            from jsonb_array_elements(v_job.metadata) m(value)
            where m.value->>'line' in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
        ) affected
        order by affected.line
    loop
        perform pg_advisory_xact_lock(hashtextextended(v_lock.line, 92742));
    end loop;
    select count(*)::integer into v_duplicates
    from public.daf_log_candidates incoming
    where incoming.job_id = p_job_id and incoming.dedup_key is not null
      and exists (
          select 1 from public.daf_log_winners existing
          where existing.line = incoming.line and existing.dedup_key = incoming.dedup_key
            and existing.file_name <> v_job.file_name
      );
    insert into _daf_import_pairs
    select distinct line, file_name from public.daf_log_winners w
    join _daf_import_keys k using (line, dedup_key)
    on conflict do nothing;
    insert into _daf_import_pairs(line, file_name) values
    ('DAF', v_job.file_name), ('FT1', v_job.file_name), ('FT2', v_job.file_name),
    ('LIGHTING', v_job.file_name), ('ASSEMBLY', v_job.file_name)
    on conflict do nothing;

    delete from public.daf_log_active_file_processes where file_name = v_job.file_name;
    insert into public.daf_log_active_file_processes(line, file_name, job_id, metadata, uploaded_at)
    select m.value->>'line', v_job.file_name, p_job_id, m.value,
           coalesce((m.value->>'uploaded_at')::timestamptz, v_job.created_at)
    from jsonb_array_elements(v_job.metadata) m(value)
    where m.value->>'line' in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY');

    delete from public.daf_log_winners where file_name = v_job.file_name;
    delete from public.daf_log_winners w using _daf_import_keys k
    where w.line = k.line and w.dedup_key = k.dedup_key;

    insert into public.daf_log_winners(candidate_id, line, dedup_key, file_name, job_id)
    select picked.id, picked.line, picked.dedup_key, picked.file_name, picked.job_id
    from (
        select distinct on (c.line, c.dedup_key)
               c.id, c.line, c.dedup_key, c.file_name, c.job_id, c.dedup_time, c.created_at
        from public.daf_log_candidates c
        join public.daf_log_active_file_processes h
          on h.line = c.line and h.file_name = c.file_name and h.job_id = c.job_id
        join _daf_import_keys k on k.line = c.line and k.dedup_key = c.dedup_key
        order by c.line, c.dedup_key, c.dedup_time asc nulls last, c.created_at asc, c.id asc
    ) picked;

    insert into public.daf_log_winners(candidate_id, line, dedup_key, file_name, job_id)
    select c.id, c.line, null, c.file_name, c.job_id
    from public.daf_log_candidates c
    join public.daf_log_active_file_processes h
      on h.line = c.line and h.file_name = c.file_name and h.job_id = c.job_id
    where c.job_id = p_job_id and c.dedup_key is null;

    insert into _daf_import_pairs
    select distinct w.line, w.file_name from public.daf_log_winners w
    join _daf_import_keys k using (line, dedup_key)
    on conflict do nothing;
    update public.daf_log_import_jobs old_job set status = 'superseded', superseded_at = now()
    where old_job.id in (select job_id from _daf_import_old_jobs)
      and old_job.id <> p_job_id and old_job.status = 'published'
      and not exists (select 1 from public.daf_log_active_file_processes h where h.job_id = old_job.id);
    select count(*)::integer into v_kept from public.daf_log_winners where job_id = p_job_id;
    update public.daf_log_import_jobs set status = 'published', published_at = now(), error_text = null,
        accepted_count = v_kept, duplicate_count = v_duplicates where id = p_job_id;
    select coalesce(jsonb_agg(jsonb_build_object('line', line, 'file_name', file_name)), '[]'::jsonb)
    into v_pairs from _daf_import_pairs;
    perform public.refresh_daf_log_batch_summaries(v_pairs);
    return jsonb_build_object('published', true, 'accepted_count', v_kept,
        'duplicate_count', v_duplicates, 'resumed', false);
end;
$$;

create or replace function public.daf_delete_log_file_process(p_line text, p_file_name text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_job uuid;
    v_pairs jsonb;
begin
    if p_line not in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY') or nullif(trim(p_file_name), '') is null then return false; end if;
    perform pg_advisory_xact_lock(hashtextextended(p_file_name, 92741));
    perform pg_advisory_xact_lock(hashtextextended(p_line, 92742));
    select job_id into v_job from public.daf_log_active_file_processes where line = p_line and file_name = p_file_name for update;
    if v_job is null then return true; end if;
    create temporary table _daf_delete_keys(line text, dedup_key text, primary key(line, dedup_key)) on commit drop;
    create temporary table _daf_delete_pairs(line text, file_name text, primary key(line, file_name)) on commit drop;
    insert into _daf_delete_pairs values (p_line, p_file_name);
    insert into _daf_delete_keys
    select line, dedup_key from public.daf_log_winners where line = p_line and file_name = p_file_name and dedup_key is not null
    on conflict do nothing;
    insert into _daf_delete_pairs
    select distinct w.line, w.file_name from public.daf_log_winners w join _daf_delete_keys k using (line, dedup_key)
    on conflict do nothing;
    delete from public.daf_log_active_file_processes where line = p_line and file_name = p_file_name;
    delete from public.daf_log_winners where line = p_line and file_name = p_file_name;
    delete from public.daf_log_winners w using _daf_delete_keys k where w.line = k.line and w.dedup_key = k.dedup_key;
    insert into public.daf_log_winners(candidate_id, line, dedup_key, file_name, job_id)
    select picked.id, picked.line, picked.dedup_key, picked.file_name, picked.job_id
    from (
        select distinct on (c.line, c.dedup_key) c.id, c.line, c.dedup_key, c.file_name, c.job_id, c.dedup_time, c.created_at
        from public.daf_log_candidates c
        join public.daf_log_active_file_processes h on h.line = c.line and h.file_name = c.file_name and h.job_id = c.job_id
        join _daf_delete_keys k on k.line = c.line and k.dedup_key = c.dedup_key
        order by c.line, c.dedup_key, c.dedup_time asc nulls last, c.created_at asc, c.id asc
    ) picked;
    insert into _daf_delete_pairs
    select distinct w.line, w.file_name from public.daf_log_winners w join _daf_delete_keys k using (line, dedup_key)
    on conflict do nothing;
    update public.daf_log_import_jobs j set status = 'superseded', superseded_at = now()
    where j.id = v_job and j.status = 'published'
      and not exists (select 1 from public.daf_log_active_file_processes h where h.job_id = j.id);
    select coalesce(jsonb_agg(jsonb_build_object('line', line, 'file_name', file_name)), '[]'::jsonb) into v_pairs from _daf_delete_pairs;
    perform public.refresh_daf_log_batch_summaries(v_pairs);
    return true;
end;
$$;

create or replace function public.daf_get_log_process_details(p_line text, p_start text default '', p_end text default '')
returns table (
    id text, line text, file_name text, uploaded_at timestamptz, model_name text,
    product_code text, work_order text, report_date text, date_start text, date_end text,
    input_count integer, good_count integer, fail_count integer, yield_rate numeric,
    defect_rate numeric, unknown_status_count integer, unknown_status_text text,
    row_count integer, raw_column_count integer, records jsonb
)
language sql
security definer
set search_path = public
stable
as $$
    select b.id, b.line, b.file_name, b.uploaded_at, b.model_name, b.product_code,
           b.work_order, b.report_date, b.date_start, b.date_end, b.input_count,
           b.good_count, b.fail_count, b.yield_rate, b.defect_rate,
           b.unknown_status_count, b.unknown_status_text, b.row_count, b.raw_column_count,
           coalesce(jsonb_agg(c.record_json order by c.dedup_time nulls last, c.created_at, c.id)
               filter (where c.id is not null), '[]'::jsonb) as records
    from public.daf_log_batches b
    join public.daf_log_active_file_processes h on h.line = b.line and h.file_name = b.file_name
    left join public.daf_log_winners w on w.line = b.line and w.file_name = b.file_name
    left join public.daf_log_candidates c on c.id = w.candidate_id
      and (p_start = '' or c.report_date >= p_start)
      and (p_end = '' or c.report_date <= p_end)
    where b.line = p_line and p_line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
      and (p_start = '' or b.date_end >= p_start)
      and (p_end = '' or b.date_start <= p_end)
    group by b.id, b.line, b.file_name, b.uploaded_at, b.model_name, b.product_code,
             b.work_order, b.report_date, b.date_start, b.date_end, b.input_count,
             b.good_count, b.fail_count, b.yield_rate, b.defect_rate,
             b.unknown_status_count, b.unknown_status_text, b.row_count, b.raw_column_count
    order by b.uploaded_at desc, b.id asc;
$$;

create or replace function public.daf_update_machine_classification(p_mappings jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_updated integer;
begin
    with mapping as (
        select upper(btrim(dedup_key)) as dedup_key, machine
        from jsonb_to_recordset(coalesce(p_mappings, '[]'::jsonb)) as m(dedup_key text, machine text)
        where machine in ('1號機', '2號機') and nullif(btrim(dedup_key), '') is not null
    )
    update public.daf_log_candidates c
       set machine = m.machine, record_json = jsonb_set(c.record_json, '{machine}', to_jsonb(m.machine), true)
      from mapping m
     where c.line in ('DAF', 'FT1') and c.dedup_key = m.dedup_key and c.machine is distinct from m.machine;
    get diagnostics v_updated = row_count;
    return v_updated;
end;
$$;

create or replace function public.daf_cleanup_log_imports()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_deleted integer;
begin
    delete from public.daf_log_import_jobs j
    where j.status in ('superseded', 'failed') and j.superseded_at < now() - interval '30 days'
      and not exists (select 1 from public.daf_log_active_file_processes h where h.job_id = j.id);
    get diagnostics v_deleted = row_count;
    delete from public.daf_log_import_jobs j
    where j.status = 'receiving' and j.created_at < now() - interval '30 days';
    return v_deleted;
end;
$$;

-- Keep old browser tabs from writing a second, divergent copy after cutover.
create or replace function public.guard_legacy_daf_batch_writes()
returns trigger
language plpgsql
as $$
begin
    if coalesce(current_setting('koya.allow_daf_summary_write', true), '') = 'on' then
        if TG_OP = 'DELETE' then return OLD; else return NEW; end if;
    end if;
    if coalesce(NEW.line, OLD.line) in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY') then
        raise exception '此頁面版本過舊，請重新整理後再上傳或刪除';
    end if;
    if TG_OP = 'DELETE' then return OLD; else return NEW; end if;
end;
$$;

drop trigger if exists guard_legacy_daf_batch_writes on public.daf_log_batches;
create trigger guard_legacy_daf_batch_writes
before insert or update or delete on public.daf_log_batches
for each row execute function public.guard_legacy_daf_batch_writes();

revoke all on function public.refresh_daf_log_batch_summaries(jsonb) from public, anon, authenticated;
grant execute on function public.daf_start_log_import(uuid, text, jsonb, integer),
    public.daf_stage_log_import_chunk(uuid, text, integer, text, jsonb),
    public.daf_get_log_import_status(uuid), public.daf_finalize_log_import(uuid),
    public.daf_delete_log_file_process(text, text),
    public.daf_get_log_process_details(text, text, text),
    public.daf_update_machine_classification(jsonb), public.daf_cleanup_log_imports()
to anon, authenticated;

create or replace function public.daf_log_import_pipeline_ready()
returns text
language sql
security definer
set search_path = public
stable
as $$ select 'staged-v1'::text; $$;

create or replace function public.daf_delete_log_file(p_file_name text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_pairs jsonb;
    v_lock record;
begin
    if nullif(trim(p_file_name), '') is null then return false; end if;
    perform pg_advisory_xact_lock(hashtextextended(p_file_name, 92741));
    create temporary table _daf_file_delete_keys(line text, dedup_key text, primary key(line, dedup_key)) on commit drop;
    create temporary table _daf_file_delete_pairs(line text, file_name text, primary key(line, file_name)) on commit drop;
    insert into _daf_file_delete_pairs
    select line, p_file_name from public.daf_log_active_file_processes where file_name = p_file_name
    on conflict do nothing;
    insert into _daf_file_delete_pairs
    select distinct line, file_name from public.daf_log_winners where file_name = p_file_name
    on conflict do nothing;
    insert into _daf_file_delete_keys
    select line, dedup_key from public.daf_log_winners where file_name = p_file_name and dedup_key is not null
    on conflict do nothing;
    for v_lock in select distinct line from _daf_file_delete_pairs order by line loop
        perform pg_advisory_xact_lock(hashtextextended(v_lock.line, 92742));
    end loop;
    insert into _daf_file_delete_pairs
    select distinct w.line, w.file_name from public.daf_log_winners w
    join _daf_file_delete_keys k using (line, dedup_key)
    on conflict do nothing;

    delete from public.daf_log_active_file_processes where file_name = p_file_name;
    delete from public.daf_log_winners where file_name = p_file_name;
    delete from public.daf_log_winners w using _daf_file_delete_keys k
    where w.line = k.line and w.dedup_key = k.dedup_key;
    insert into public.daf_log_winners(candidate_id, line, dedup_key, file_name, job_id)
    select picked.id, picked.line, picked.dedup_key, picked.file_name, picked.job_id
    from (
        select distinct on (c.line, c.dedup_key) c.id, c.line, c.dedup_key, c.file_name, c.job_id, c.dedup_time, c.created_at
        from public.daf_log_candidates c
        join public.daf_log_active_file_processes h on h.line = c.line and h.file_name = c.file_name and h.job_id = c.job_id
        join _daf_file_delete_keys k on k.line = c.line and k.dedup_key = c.dedup_key
        order by c.line, c.dedup_key, c.dedup_time asc nulls last, c.created_at asc, c.id asc
    ) picked;
    insert into _daf_file_delete_pairs
    select distinct w.line, w.file_name from public.daf_log_winners w
    join _daf_file_delete_keys k using (line, dedup_key)
    on conflict do nothing;
    update public.daf_log_import_jobs j set status = 'superseded', superseded_at = now()
    where j.status = 'published'
      and not exists (select 1 from public.daf_log_active_file_processes h where h.job_id = j.id)
      and j.id in (select distinct job_id from public.daf_log_candidates where file_name = p_file_name);
    select coalesce(jsonb_agg(jsonb_build_object('line', line, 'file_name', file_name)), '[]'::jsonb)
    into v_pairs from _daf_file_delete_pairs;
    perform public.refresh_daf_log_batch_summaries(v_pairs);
    return true;
end;
$$;

grant execute on function public.daf_log_import_pipeline_ready(), public.daf_delete_log_file(text)
to anon, authenticated;

notify pgrst, 'reload schema';
commit;
