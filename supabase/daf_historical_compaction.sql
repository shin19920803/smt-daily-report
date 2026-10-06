-- Historical DAF/test-process compaction.
-- Install on a restored local copy first. This migration creates the compact store
-- and guarded batch routine; it does not compact or delete any rows by itself.

begin;
set local statement_timeout = '120s';

create table if not exists public.daf_log_compact_facts (
    candidate_id text primary key,
    line text not null check (line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')),
    file_name text not null,
    dedup_key text,
    dedup_time bigint,
    report_date text not null,
    work_order text,
    product_code text,
    model_name text,
    status text,
    defect text,
    machine text,
    input_included boolean not null default false,
    is_defect boolean not null default false,
    source_format text,
    created_at timestamptz not null,
    compacted_at timestamptz not null default now()
);

create unique index if not exists daf_log_compact_facts_unique_e_idx
    on public.daf_log_compact_facts (line, dedup_key)
    where dedup_key is not null;
create index if not exists daf_log_compact_facts_line_date_idx
    on public.daf_log_compact_facts (line, report_date);
create index if not exists daf_log_compact_facts_file_idx
    on public.daf_log_compact_facts (line, file_name);

alter table public.daf_log_compact_facts enable row level security;
revoke all on public.daf_log_compact_facts from public, anon, authenticated;

create table if not exists public.daf_log_compaction_state (
    id text primary key check (id = 'current'),
    cutoff_date date not null,
    updated_at timestamptz not null default now()
);
alter table public.daf_log_compaction_state enable row level security;
revoke all on public.daf_log_compaction_state from public, anon, authenticated;

create or replace function public.daf_preview_log_compaction(p_cutoff date)
returns table (
    line text,
    candidate_rows bigint,
    winner_rows bigint,
    removable_loser_rows bigint,
    missing_or_invalid_date_rows bigint,
    receiving_jobs_with_expired_range bigint,
    projection_mismatch_rows bigint,
    compacted_winner_rows bigint,
    dashboard_digest text,
    candidate_table_bytes bigint,
    winner_table_bytes bigint
)
language sql
security definer
set search_path = public
stable
as $$
    with lines(line) as (
        values ('DAF'), ('FT1'), ('FT2'), ('LIGHTING'), ('ASSEMBLY')
    ), old_candidates as (
        select c.*, exists (
            select 1 from public.daf_log_winners w where w.candidate_id = c.id
        ) as is_winner
        from public.daf_log_candidates c
        where c.report_date ~ '^\d{4}-\d{2}-\d{2}$'
          and c.report_date < p_cutoff::text
    ), invalid_dates as (
        select c.line, count(*)::bigint as n
        from public.daf_log_candidates c
        where c.report_date is null or c.report_date !~ '^\d{4}-\d{2}-\d{2}$'
        group by c.line
    ), receiving as (
        select m.value->>'line' as line, count(distinct j.id)::bigint as n
        from public.daf_log_import_jobs j
        cross join lateral jsonb_array_elements(j.metadata) m(value)
        where j.status = 'receiving'
          and m.value->>'line' in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
          and m.value->>'date_start' ~ '^\d{4}-\d{2}-\d{2}$'
          and m.value->>'date_start' < p_cutoff::text
        group by m.value->>'line'
    ), projection_mismatches as (
        select c.line, count(*)::bigint as n
        from public.daf_log_candidates c
        join public.daf_log_winners w on w.candidate_id = c.id
        where c.report_date ~ '^\d{4}-\d{2}-\d{2}$'
          and c.report_date < p_cutoff::text
          and (
              nullif(upper(btrim(c.record_json->>'dedupKey')), '') is distinct from c.dedup_key
              or case when coalesce(c.record_json->>'dedupTime', '') ~ '^-?[0-9]+$'
                    then (c.record_json->>'dedupTime')::bigint else null end is distinct from c.dedup_time
              or nullif(c.record_json->>'date', '') is distinct from c.report_date
              or coalesce(c.record_json->>'workOrder', '') is distinct from c.work_order
              or coalesce(c.record_json->>'productCode', '') is distinct from c.product_code
              or coalesce(c.record_json->>'model', '') is distinct from c.model_name
              or coalesce(c.record_json->>'status', '') is distinct from c.status
              or coalesce(c.record_json->>'defect', '') is distinct from c.defect
              or coalesce(c.record_json->>'machine', '') is distinct from c.machine
              or coalesce((c.record_json->>'inputIncluded')::boolean, false) is distinct from c.input_included
              or coalesce((c.record_json->>'isDefect')::boolean, false) is distinct from c.is_defect
              or coalesce(c.record_json->>'sourceFormat', '') is distinct from c.source_format
              -- The browser has legacy raw-column fallbacks for product code, E key,
              -- and timestamp. Refuse compaction if any such fallback would be lost.
              or (coalesce(c.record_json->>'productCode', '') = '' and
                  coalesce(c.record_json->'raw'->>(case when c.source_format = 'current-v2' or c.line = 'FT1' then 3 else 4 end), '') <> '')
              or (coalesce(c.record_json->>'dedupKey', '') = '' and
                  coalesce(c.record_json->'raw'->>(case when c.source_format = 'current-v2' or c.line = 'FT1' then 4 else 5 end), '') <> '')
              or (coalesce(c.record_json->>'dedupTime', '') = '' and
                  coalesce(c.record_json->'raw'->>(case when c.source_format = 'current-v2' or c.line = 'FT1' then 5 else 6 end), '') <> '')
          )
        group by c.line
    ), compacted as (
        select f.line, count(*)::bigint as n
        from public.daf_log_compact_facts f
        where f.report_date ~ '^\d{4}-\d{2}-\d{2}$'
          and f.report_date < p_cutoff::text
        group by f.line
    ), dashboard_rows as (
        select c.line, c.id as candidate_id,
               md5(jsonb_build_object(
                   'fileName', c.file_name, 'dedupKey', c.dedup_key, 'dedupTime', c.dedup_time,
                   'date', c.report_date, 'workOrder', c.work_order, 'productCode', c.product_code,
                   'model', c.model_name, 'status', c.status, 'defect', c.defect,
                   'machine', c.machine, 'inputIncluded', c.input_included,
                   'isDefect', c.is_defect, 'sourceFormat', c.source_format,
                   'createdAt', c.created_at
               )::text) as row_digest
        from public.daf_log_candidates c
        join public.daf_log_winners w on w.candidate_id = c.id
        where c.report_date ~ '^\d{4}-\d{2}-\d{2}$'
          and c.report_date < p_cutoff::text
        union all
        select f.line, f.candidate_id,
               md5(jsonb_build_object(
                   'fileName', f.file_name, 'dedupKey', f.dedup_key, 'dedupTime', f.dedup_time,
                   'date', f.report_date, 'workOrder', f.work_order, 'productCode', f.product_code,
                   'model', f.model_name, 'status', f.status, 'defect', f.defect,
                   'machine', f.machine, 'inputIncluded', f.input_included,
                   'isDefect', f.is_defect, 'sourceFormat', f.source_format,
                   'createdAt', f.created_at
               )::text) as row_digest
        from public.daf_log_compact_facts f
        where f.report_date ~ '^\d{4}-\d{2}-\d{2}$'
          and f.report_date < p_cutoff::text
    ), dashboard_digests as (
        select line, md5(coalesce(string_agg(row_digest, '' order by candidate_id), '')) as digest
        from dashboard_rows
        group by line
    )
    select l.line,
           count(o.id),
           count(o.id) filter (where o.is_winner),
           count(o.id) filter (where not o.is_winner),
           coalesce(i.n, 0),
           coalesce(r.n, 0),
           coalesce(pm.n, 0),
           coalesce(cp.n, 0),
           coalesce(dd.digest, md5('')),
           pg_total_relation_size('public.daf_log_candidates'::regclass),
           pg_total_relation_size('public.daf_log_winners'::regclass)
    from lines l
    left join old_candidates o on o.line = l.line
    left join invalid_dates i on i.line = l.line
    left join receiving r on r.line = l.line
    left join projection_mismatches pm on pm.line = l.line
    left join compacted cp on cp.line = l.line
    left join dashboard_digests dd on dd.line = l.line
    group by l.line, i.n, r.n, pm.n, cp.n, dd.digest
    order by l.line;
$$;

create or replace function public.daf_compact_expired_log_batch(
    p_cutoff date,
    p_batch_size integer default 5000
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '110s'
as $$
declare
    v_cutoff date;
    v_oldest_allowed_cutoff date := (now() at time zone 'Asia/Taipei')::date - 30;
    v_ids text[];
    v_expected_winners integer;
    v_inserted integer;
    v_deleted integer;
    v_receiving integer;
    v_lock_line text;
    v_touched_pairs jsonb;
    v_refresh_pairs jsonb;
begin
    if p_cutoff is null then raise exception '封存日期不可空白'; end if;
    if p_cutoff > v_oldest_allowed_cutoff then
        raise exception '封存截止日必須至少早於今天 30 天（最晚可選 %）', v_oldest_allowed_cutoff;
    end if;
    if p_batch_size < 1 or p_batch_size > 10000 then raise exception '每批筆數須介於 1 至 10000'; end if;

    insert into public.daf_log_compaction_state(id, cutoff_date)
    values ('current', p_cutoff)
    on conflict (id) do update
       set cutoff_date = greatest(public.daf_log_compaction_state.cutoff_date, excluded.cutoff_date),
           updated_at = now();
    select cutoff_date into v_cutoff from public.daf_log_compaction_state where id = 'current';

    -- Match the line locks used by upload publication and file deletion.
    for v_lock_line in
        select line from (values ('DAF'), ('FT1'), ('FT2'), ('LIGHTING'), ('ASSEMBLY')) as process(line)
        order by line
    loop
        perform pg_advisory_xact_lock(hashtextextended(v_lock_line, 92742));
    end loop;

    select coalesce(array_agg(id), array[]::text[]) into v_ids from (
        select c.id
        from public.daf_log_candidates c
        where c.report_date ~ '^\d{4}-\d{2}-\d{2}$'
          and c.report_date < v_cutoff::text
        order by c.line, c.report_date, c.id
        limit p_batch_size
        for update skip locked
    ) picked
    ;
    if coalesce(array_length(v_ids, 1), 0) = 0 then
        return jsonb_build_object('cutoff_date', v_cutoff, 'compacted', 0, 'removed_candidates', 0, 'done', true);
    end if;

    select count(*)::integer into v_receiving
    from public.daf_log_candidates c
    join public.daf_log_import_jobs j on j.id = c.job_id
    where c.id = any(v_ids) and j.status = 'receiving';
    if v_receiving > 0 then raise exception '候選資料仍屬於上傳中的工作，先完成或清理該上傳再封存'; end if;

    select coalesce(jsonb_agg(jsonb_build_object('line', line, 'file_name', file_name)), '[]'::jsonb)
      into v_touched_pairs
    from (select distinct line, file_name from public.daf_log_candidates where id = any(v_ids)) touched;

    if exists (
        select 1
        from public.daf_log_candidates c
        join public.daf_log_winners w on w.candidate_id = c.id
        where c.id = any(v_ids)
          and (
              nullif(upper(btrim(c.record_json->>'dedupKey')), '') is distinct from c.dedup_key
              or case when coalesce(c.record_json->>'dedupTime', '') ~ '^-?[0-9]+$'
                    then (c.record_json->>'dedupTime')::bigint else null end is distinct from c.dedup_time
              or nullif(c.record_json->>'date', '') is distinct from c.report_date
              or coalesce(c.record_json->>'workOrder', '') is distinct from c.work_order
              or coalesce(c.record_json->>'productCode', '') is distinct from c.product_code
              or coalesce(c.record_json->>'model', '') is distinct from c.model_name
              or coalesce(c.record_json->>'status', '') is distinct from c.status
              or coalesce(c.record_json->>'defect', '') is distinct from c.defect
              or coalesce(c.record_json->>'machine', '') is distinct from c.machine
              or coalesce((c.record_json->>'inputIncluded')::boolean, false) is distinct from c.input_included
              or coalesce((c.record_json->>'isDefect')::boolean, false) is distinct from c.is_defect
              or coalesce(c.record_json->>'sourceFormat', '') is distinct from c.source_format
              or (coalesce(c.record_json->>'productCode', '') = '' and
                  coalesce(c.record_json->'raw'->>(case when c.source_format = 'current-v2' or c.line = 'FT1' then 3 else 4 end), '') <> '')
              or (coalesce(c.record_json->>'dedupKey', '') = '' and
                  coalesce(c.record_json->'raw'->>(case when c.source_format = 'current-v2' or c.line = 'FT1' then 4 else 5 end), '') <> '')
              or (coalesce(c.record_json->>'dedupTime', '') = '' and
                  coalesce(c.record_json->'raw'->>(case when c.source_format = 'current-v2' or c.line = 'FT1' then 5 else 6 end), '') <> '')
          )
    ) then raise exception '本批資料的明細欄位與儲存欄位不一致，為避免改變 Dashboard，已停止封存'; end if;

    select count(*)::integer into v_expected_winners
    from public.daf_log_candidates c
    join public.daf_log_winners w on w.candidate_id = c.id
    where c.id = any(v_ids);

    insert into public.daf_log_compact_facts (
        candidate_id, line, file_name, dedup_key, dedup_time, report_date,
        work_order, product_code, model_name, status, defect, machine,
        input_included, is_defect, source_format, created_at
    )
    select c.id, c.line, c.file_name, c.dedup_key, c.dedup_time, c.report_date,
           c.work_order, c.product_code, c.model_name, c.status, c.defect, c.machine,
           c.input_included, c.is_defect, c.source_format, c.created_at
    from public.daf_log_candidates c
    join public.daf_log_winners w on w.candidate_id = c.id
    where c.id = any(v_ids)
    on conflict (candidate_id) do nothing;
    get diagnostics v_inserted = row_count;

    if v_inserted <> v_expected_winners then
        -- A previously copied but not removed row must match byte-for-byte in all dashboard fields.
        if exists (
            select 1
            from public.daf_log_candidates c
            join public.daf_log_winners w on w.candidate_id = c.id
            left join public.daf_log_compact_facts f on f.candidate_id = c.id
            where c.id = any(v_ids)
              and (f.candidate_id is null
                or (f.line, f.file_name, f.dedup_key, f.dedup_time, f.report_date,
                    f.work_order, f.product_code, f.model_name, f.status, f.defect,
                    f.machine, f.input_included, f.is_defect, f.source_format, f.created_at)
                   is distinct from
                   (c.line, c.file_name, c.dedup_key, c.dedup_time, c.report_date,
                    c.work_order, c.product_code, c.model_name, c.status, c.defect,
                    c.machine, c.input_included, c.is_defect, c.source_format, c.created_at))
        ) then raise exception '封存資料核對不一致，已取消本批次'; end if;
    end if;

    delete from public.daf_log_candidates where id = any(v_ids);
    get diagnostics v_deleted = row_count;

    -- Once a file has no expired raw candidates left, trim only expired entries
    -- from its legacy duplicate JSON cache. Keep every summary metric byte-for-byte
    -- unchanged and retain any non-expired or undated cache entries.
    select coalesce(jsonb_agg(jsonb_build_object('line', p.line, 'file_name', p.file_name)), '[]'::jsonb)
      into v_refresh_pairs
    from jsonb_to_recordset(v_touched_pairs) as p(line text, file_name text)
    where not exists (
        select 1 from public.daf_log_candidates c
        where c.line = p.line and c.file_name = p.file_name
          and c.report_date ~ '^\d{4}-\d{2}-\d{2}$'
          and c.report_date < v_cutoff::text
    );
    if jsonb_array_length(v_refresh_pairs) > 0 then
        perform set_config('koya.allow_daf_summary_write', 'on', true);
        update public.daf_log_batches b
        set records = case when jsonb_typeof(b.records) = 'array' then coalesce((
            select jsonb_agg(item.value order by item.ordinality)
            from jsonb_array_elements(b.records) with ordinality item(value, ordinality)
            where not (
                item.value->>'date' ~ '^\d{4}-\d{2}-\d{2}$'
                and item.value->>'date' < v_cutoff::text
            )
        ), '[]'::jsonb) else b.records end
        from jsonb_to_recordset(v_refresh_pairs) as p(line text, file_name text)
        where b.line = p.line and b.file_name = p.file_name
          and b.line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY');
    end if;

    return jsonb_build_object(
        'cutoff_date', v_cutoff,
        'compacted', v_expected_winners,
        'removed_candidates', v_deleted,
        'done', v_deleted < p_batch_size
    );
end;
$$;

create or replace function public.daf_prune_expired_machine_references(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
set statement_timeout = '30s'
as $$
declare
    v_deleted integer;
begin
    delete from public.daf_log_batches
    where line = '__DAF_MACHINE_REFERENCE__'
      and uploaded_at < p_now - interval '30 days';
    get diagnostics v_deleted = row_count;
    return v_deleted;
end;
$$;

create or replace function public.daf_run_log_maintenance_batch()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '115s'
as $$
declare
    v_reference_rows integer;
    v_compaction jsonb;
begin
    v_reference_rows := public.daf_prune_expired_machine_references(now());
    v_compaction := public.daf_compact_expired_log_batch(
        (now() at time zone 'Asia/Taipei')::date - 30, 5000
    );
    return jsonb_build_object(
        'deleted_machine_reference_rows', v_reference_rows,
        'compaction', v_compaction
    );
end;
$$;

-- The RPC continues returning the same record shape as before; archived rows
-- omit only raw spreadsheet columns, which are not used by the dashboard charts.
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
           coalesce((
               select jsonb_agg(r.record_json order by r.dedup_time nulls last, r.created_at, r.record_id)
               from (
                   select c.line, c.file_name, c.dedup_time, c.created_at, c.id as record_id,
                          c.report_date, c.record_json
                   from public.daf_log_winners w
                   join public.daf_log_candidates c on c.id = w.candidate_id
                   where w.line = b.line and w.file_name = b.file_name
                   union all
                   select f.line, f.file_name, f.dedup_time, f.created_at, f.candidate_id,
                          f.report_date,
                          jsonb_build_object(
                              'dedupKey', f.dedup_key, 'dedupTime', f.dedup_time,
                              'date', f.report_date, 'workOrder', f.work_order,
                              'productCode', f.product_code, 'model', f.model_name,
                              'status', f.status, 'defect', f.defect, 'machine', f.machine,
                              'inputIncluded', f.input_included, 'isDefect', f.is_defect,
                              'sourceFormat', f.source_format, 'raw', '[]'::jsonb,
                              'compacted', true
                          )
                   from public.daf_log_compact_facts f
                   where f.line = b.line and f.file_name = b.file_name
               ) r
               where (p_start = '' or r.report_date >= p_start)
                 and (p_end = '' or r.report_date <= p_end)
           ), '[]'::jsonb) as records
    from public.daf_log_batches b
    join public.daf_log_active_file_processes h on h.line = b.line and h.file_name = b.file_name
    where b.line = p_line and p_line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
      and (p_start = '' or b.date_end >= p_start)
      and (p_end = '' or b.date_start <= p_end)
    order by b.uploaded_at desc, b.id asc;
$$;

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
    ), facts as (
        select c.id as fact_id, c.line, c.file_name, c.report_date,
               c.work_order, c.product_code, c.model_name, c.status,
               c.input_included, c.dedup_time, c.created_at
        from public.daf_log_winners w
        join public.daf_log_candidates c on c.id = w.candidate_id
        union all
        select f.candidate_id, f.line, f.file_name, f.report_date,
               f.work_order, f.product_code, f.model_name, f.status,
               f.input_included, f.dedup_time, f.created_at
        from public.daf_log_compact_facts f
    ), aggregate_rows as (
        select h.line, h.file_name, h.metadata,
               h.metadata->>'id' as old_id,
               h.uploaded_at,
               count(f.fact_id)::integer as row_count,
               count(*) filter (where f.input_included)::integer as input_count,
               count(*) filter (where f.input_included and upper(f.status) = 'GOOD')::integer as good_count,
               count(*) filter (where f.input_included and upper(f.status) = 'FAIL')::integer as fail_count,
               count(*) filter (where f.status <> '' and upper(f.status) not in ('GOOD', 'FAIL'))::integer as unknown_status_count,
               coalesce(string_agg(distinct nullif(f.model_name, ''), '、'), h.metadata->>'model_name', '未識別機種') as model_name,
               coalesce(string_agg(distinct nullif(f.product_code, ''), '、'), h.metadata->>'product_code', '未識別產品代碼') as product_code,
               coalesce(string_agg(distinct nullif(f.work_order, ''), '、'), h.metadata->>'work_order', '未識別工單') as work_order,
               coalesce(string_agg(distinct nullif(f.status, ''), '、') filter (where f.status <> '' and upper(f.status) not in ('GOOD', 'FAIL')), '無') as unknown_status_text,
               coalesce(min(f.report_date) filter (where f.report_date ~ '^\d{4}-\d{2}-\d{2}$'), h.metadata->>'date_start') as date_start,
               coalesce(max(f.report_date) filter (where f.report_date ~ '^\d{4}-\d{2}-\d{2}$'), h.metadata->>'date_end') as date_end,
               coalesce((h.metadata->>'raw_column_count')::integer, 10) as raw_column_count
        from targets t
        join public.daf_log_active_file_processes h on h.line = t.line and h.file_name = t.file_name
        left join facts f on f.line = t.line and f.file_name = t.file_name
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

create or replace function public.daf_update_machine_classification(p_mappings jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_updated_candidates integer := 0;
    v_updated_compact integer := 0;
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
    get diagnostics v_updated_candidates = row_count;

    with mapping as (
        select upper(btrim(dedup_key)) as dedup_key, machine
        from jsonb_to_recordset(coalesce(p_mappings, '[]'::jsonb)) as m(dedup_key text, machine text)
        where machine in ('1號機', '2號機') and nullif(btrim(dedup_key), '') is not null
    )
    update public.daf_log_compact_facts f
       set machine = m.machine
      from mapping m
     where f.line in ('DAF', 'FT1') and f.dedup_key = m.dedup_key and f.machine is distinct from m.machine;
    get diagnostics v_updated_compact = row_count;
    return v_updated_candidates + v_updated_compact;
end;
$$;

create or replace function public.guard_daf_compacted_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_cutoff date;
begin
    select cutoff_date into v_cutoff from public.daf_log_compaction_state where id = 'current';
    if v_cutoff is not null then
        if exists (
            select 1
            from jsonb_to_recordset(coalesce(new.metadata, '[]'::jsonb)) as m(line text, date_start text)
            where m.line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
              and m.date_start ~ '^\d{4}-\d{2}-\d{2}$'
              and m.date_start < v_cutoff::text
        ) then
            raise exception '上傳資料包含已封存日期（早於 %），為保留歷史統計，無法回補此區間', v_cutoff;
        end if;
        if exists (
            select 1
            from jsonb_to_recordset(coalesce(new.metadata, '[]'::jsonb)) as m(line text)
            join public.daf_log_compact_facts f on f.line = m.line and f.file_name = new.file_name
        ) then
            raise exception '此檔案已有超過 30 天的封存資料，不能覆蓋；請使用新檔名上傳未封存日期';
        end if;
    end if;
    return new;
end;
$$;

drop trigger if exists guard_daf_compacted_history_on_job on public.daf_log_import_jobs;
create trigger guard_daf_compacted_history_on_job
before insert on public.daf_log_import_jobs
for each row execute function public.guard_daf_compacted_history();

create or replace function public.guard_daf_compacted_candidate_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_cutoff date;
begin
    select cutoff_date into v_cutoff
    from public.daf_log_compaction_state where id = 'current';
    if v_cutoff is not null
       and new.line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
       and new.report_date ~ '^\d{4}-\d{2}-\d{2}$'
       and new.report_date < v_cutoff::text then
        raise exception '上傳明細包含已封存日期（早於 %），無法寫入原始資料', v_cutoff;
    end if;
    return new;
end;
$$;

drop trigger if exists guard_daf_compacted_candidate_insert on public.daf_log_candidates;
create trigger guard_daf_compacted_candidate_insert
before insert on public.daf_log_candidates
for each row execute function public.guard_daf_compacted_candidate_insert();

create or replace function public.guard_daf_compacted_file_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if exists (
        select 1 from public.daf_log_compact_facts f
        where f.line = old.line and f.file_name = old.file_name
    ) then
        raise exception '此檔案含有已封存的 30 天以前資料，無法刪除或覆蓋';
    end if;
    return old;
end;
$$;

drop trigger if exists guard_daf_compacted_file_delete on public.daf_log_active_file_processes;
create trigger guard_daf_compacted_file_delete
before delete on public.daf_log_active_file_processes
for each row execute function public.guard_daf_compacted_file_delete();

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
    v_compaction_cutoff date;
    v_chunk_count integer;
    v_kept integer;
    v_duplicates integer;
    v_archived_duplicates integer;
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
    select count(*)::integer into v_chunk_count
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

    -- A job may have started before compaction installed its cutoff. Recheck after
    -- acquiring the same process locks so a racing staged upload cannot reinsert
    -- data into an already archived date range.
    select cutoff_date into v_compaction_cutoff
    from public.daf_log_compaction_state where id = 'current';
    if v_compaction_cutoff is not null and exists (
        select 1
        from jsonb_to_recordset(coalesce(v_job.metadata, '[]'::jsonb)) as m(line text, date_start text)
        where m.line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
          and m.date_start ~ '^\d{4}-\d{2}-\d{2}$'
          and m.date_start < v_compaction_cutoff::text
    ) then
        raise exception '上傳資料包含已封存日期（早於 %），為保留歷史統計，無法回補此區間', v_compaction_cutoff;
    end if;
    if v_compaction_cutoff is not null and exists (
        select 1 from public.daf_log_candidates c
        where c.job_id = p_job_id
          and c.line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
          and c.report_date ~ '^\d{4}-\d{2}-\d{2}$'
          and c.report_date < v_compaction_cutoff::text
    ) then
        raise exception '上傳明細包含已封存日期（早於 %），此次上傳已取消', v_compaction_cutoff;
    end if;

    select count(*)::integer into v_duplicates
    from public.daf_log_candidates incoming
    where incoming.job_id = p_job_id and incoming.dedup_key is not null
      and exists (
          select 1 from public.daf_log_winners existing
          where existing.line = incoming.line and existing.dedup_key = incoming.dedup_key
            and existing.file_name <> v_job.file_name
      );
    select count(*)::integer into v_archived_duplicates
    from public.daf_log_candidates incoming
    join public.daf_log_compact_facts archived
      on archived.line = incoming.line and archived.dedup_key = incoming.dedup_key
    where incoming.job_id = p_job_id and incoming.dedup_key is not null
      and archived.file_name <> v_job.file_name;
    if exists (
        select 1
        from public.daf_log_candidates incoming
        join public.daf_log_compact_facts archived
          on archived.line = incoming.line and archived.dedup_key = incoming.dedup_key
        where incoming.job_id = p_job_id
          and coalesce(incoming.dedup_time, 9223372036854775807::bigint)
              < coalesce(archived.dedup_time, 9223372036854775807::bigint)
    ) then
        raise exception '新資料的 E 欄時間早於已封存勝出資料；為避免歷史統計錯誤，此次上傳已取消';
    end if;

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
        where not exists (
            select 1 from public.daf_log_compact_facts f
            where f.line = c.line and f.dedup_key = c.dedup_key
        )
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
        accepted_count = v_kept, duplicate_count = v_duplicates + v_archived_duplicates where id = p_job_id;
    select coalesce(jsonb_agg(jsonb_build_object('line', line, 'file_name', file_name)), '[]'::jsonb)
    into v_pairs from _daf_import_pairs;
    perform public.refresh_daf_log_batch_summaries(v_pairs);
    return jsonb_build_object('published', true, 'accepted_count', v_kept,
        'duplicate_count', v_duplicates + v_archived_duplicates, 'resumed', false);
end;
$$;

revoke all on function public.daf_preview_log_compaction(date),
    public.daf_compact_expired_log_batch(date, integer),
    public.daf_prune_expired_machine_references(timestamptz),
    public.daf_run_log_maintenance_batch(),
    public.guard_daf_compacted_history(), public.guard_daf_compacted_file_delete(),
    public.guard_daf_compacted_candidate_insert()
from public, anon, authenticated;

grant execute on function public.daf_get_log_process_details(text, text, text),
    public.daf_update_machine_classification(jsonb), public.daf_finalize_log_import(uuid)
to anon, authenticated;

notify pgrst, 'reload schema';
commit;
