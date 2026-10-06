\set ON_ERROR_STOP on

create role anon nologin;
create role authenticated nologin;
\ir ../supabase/daf_log_batches.sql
\ir ../supabase/daf_staged_imports.sql
\ir ../supabase/daf_historical_compaction.sql

select public.daf_start_log_import(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'old-test.xlsx',
    jsonb_build_array(jsonb_build_object(
        'id', 'old-test-summary', 'line', 'DAF', 'file_name', 'old-test.xlsx',
        'uploaded_at', '2026-01-10T08:00:00Z', 'date_start', '2026-01-10',
        'date_end', '2026-01-10', 'raw_column_count', 10
    ), jsonb_build_object(
        'id', 'old-ft1-summary', 'line', 'FT1', 'file_name', 'old-test.xlsx',
        'uploaded_at', '2026-01-10T08:00:00Z', 'date_start', '2026-01-10',
        'date_end', '2026-01-10', 'raw_column_count', 10
    ), jsonb_build_object(
        'id', 'old-ft2-summary', 'line', 'FT2', 'file_name', 'old-test.xlsx',
        'uploaded_at', '2026-01-10T08:00:00Z', 'date_start', '2026-01-10',
        'date_end', '2026-01-10', 'raw_column_count', 10
    ), jsonb_build_object(
        'id', 'old-lighting-summary', 'line', 'LIGHTING', 'file_name', 'old-test.xlsx',
        'uploaded_at', '2026-01-10T08:00:00Z', 'date_start', '2026-01-10',
        'date_end', '2026-01-10', 'raw_column_count', 10
    ), jsonb_build_object(
        'id', 'old-assembly-summary', 'line', 'ASSEMBLY', 'file_name', 'old-test.xlsx',
        'uploaded_at', '2026-01-10T08:00:00Z', 'date_start', '2026-01-10',
        'date_end', '2026-01-10', 'raw_column_count', 10
    )),
    5
);

select public.daf_stage_log_import_chunk(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'DAF', 0, 'old-chunk-1',
    '[
      {"dedupKey":"E-001","dedupTime":1768032000000,"date":"2026-01-10","workOrder":"WO-1","productCode":"P-1","model":"Model-1","status":"GOOD","defect":"","machine":"1號機","inputIncluded":true,"isDefect":false,"sourceFormat":"current-v2","raw":["DAF","WO-1","","P-1","E-001","2026-01-10 08:00:00","Y0176","","GOOD"]},
      {"dedupKey":"E-002","dedupTime":1768035600000,"date":"2026-01-10","workOrder":"WO-2","productCode":"P-2","model":"Model-2","status":"FAIL","defect":"焊點不良","machine":"2號機","inputIncluded":true,"isDefect":true,"sourceFormat":"current-v2","raw":["DAF","WO-2","","P-2","E-002","2026-01-10 09:00:00","Y0137","焊點不良","FAIL"]},
      {"dedupKey":"E-001","dedupTime":1768040000000,"date":"2026-01-10","workOrder":"WO-1","productCode":"P-1","model":"Model-1","status":"FAIL","defect":"重複列","machine":"1號機","inputIncluded":true,"isDefect":true,"sourceFormat":"current-v2","raw":["DAF","WO-1","","P-1","E-001","2026-01-10 10:00:00","Y0176","重複列","FAIL"]}
    ]'::jsonb
);
select public.daf_stage_log_import_chunk(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'FT1', 0, 'old-ft1-chunk',
    '[{"dedupKey":"E-FT1","dedupTime":1768032000000,"date":"2026-01-10","workOrder":"WO-FT1","productCode":"P-FT1","model":"Model-FT1","status":"GOOD","defect":"","machine":"未知機台","inputIncluded":true,"isDefect":false,"sourceFormat":"current-v2","raw":["FT1","WO-FT1","","P-FT1","E-FT1","2026-01-10 08:00:00","Y0137","","GOOD"]}]'::jsonb
);
select public.daf_stage_log_import_chunk(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'FT2', 0, 'old-ft2-chunk',
    '[{"dedupKey":"E-FT2","dedupTime":1768032000000,"date":"2026-01-10","workOrder":"WO-FT2","productCode":"P-FT2","model":"Model-FT2","status":"GOOD","defect":"","machine":"未知機台","inputIncluded":true,"isDefect":false,"sourceFormat":"current-v2","raw":["FT2","WO-FT2","","P-FT2","E-FT2","2026-01-10 08:00:00","","","GOOD"]}]'::jsonb
);
select public.daf_stage_log_import_chunk(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'LIGHTING', 0, 'old-lighting-chunk',
    '[{"dedupKey":"E-LIGHT","dedupTime":1768032000000,"date":"2026-01-10","workOrder":"WO-LIGHT","productCode":"P-LIGHT","model":"Model-LIGHT","status":"GOOD","defect":"","machine":"未知機台","inputIncluded":true,"isDefect":false,"sourceFormat":"current-v2","raw":["LIGHTING","WO-LIGHT","","P-LIGHT","E-LIGHT","2026-01-10 08:00:00","","","GOOD"]}]'::jsonb
);
select public.daf_stage_log_import_chunk(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'ASSEMBLY', 0, 'old-assembly-chunk',
    '[{"dedupKey":"E-ASSY","dedupTime":1768032000000,"date":"2026-01-10","workOrder":"WO-ASSY","productCode":"P-ASSY","model":"Model-ASSY","status":"GOOD","defect":"","machine":"未知機台","inputIncluded":true,"isDefect":false,"sourceFormat":"current-v2","raw":["ASSEMBLY","WO-ASSY","","P-ASSY","E-ASSY","2026-01-10 08:00:00","","","GOOD"]}]'::jsonb
);
select public.daf_finalize_log_import('00000000-0000-4000-8000-000000000001'::uuid);

-- Simulate a legacy duplicate full-record cache in the summary table.
begin;
select set_config('koya.allow_daf_summary_write', 'on', true);
update public.daf_log_batches b
set records = coalesce((
    select jsonb_agg(c.record_json order by c.id)
    from public.daf_log_winners w
    join public.daf_log_candidates c on c.id = w.candidate_id
    where w.line = b.line and w.file_name = b.file_name
), '[]'::jsonb)
where b.line = 'DAF' and b.file_name = 'old-test.xlsx';
commit;

-- Simulate a staged job that began before the compaction cutoff was committed.
select public.daf_start_log_import(
    '00000000-0000-4000-8000-000000000004'::uuid,
    'racing-old.xlsx',
    jsonb_build_array(jsonb_build_object(
        'id', 'racing-old-summary', 'line', 'DAF', 'file_name', 'racing-old.xlsx',
        'uploaded_at', '2026-03-01T08:00:00Z', 'date_start', '2026-03-01',
        'date_end', '2026-03-01', 'raw_column_count', 10
    )),
    1
);

-- A legacy raw-column fallback must be detected and must stop that batch.
begin;
update public.daf_log_candidates
set product_code = '', record_json = record_json - 'productCode'
where line = 'DAF' and dedup_key = 'E-001';
do $$
declare
    v_mismatches bigint;
    v_rejected boolean := false;
begin
    select projection_mismatch_rows into v_mismatches
    from public.daf_preview_log_compaction('2026-02-10'::date)
    where line = 'DAF';
    if coalesce(v_mismatches, 0) = 0 then raise exception 'Preview missed a raw-column fallback'; end if;
    begin
        perform public.daf_compact_expired_log_batch('2026-02-10'::date, 1000);
    exception when others then
        v_rejected := position('明細欄位與儲存欄位不一致' in sqlerrm) > 0;
    end;
    if not v_rejected then raise exception 'Unsafe compaction was not stopped'; end if;
end;
$$;
rollback;

create temporary table _before_dashboard as
select d.line, d.file_name,
       (to_jsonb(d) - 'records') || jsonb_build_object(
           'records', (select jsonb_agg(value - 'raw' order by value->>'dedupKey')
                       from jsonb_array_elements(d.records) item(value))
       ) as dashboard_payload
from (values ('DAF'), ('FT1'), ('FT2'), ('LIGHTING'), ('ASSEMBLY')) as process(line)
cross join lateral public.daf_get_log_process_details(process.line, '2026-01-10', '2026-01-10') d;

create temporary table _before_compaction_preview as
select * from public.daf_preview_log_compaction('2026-02-10'::date);

select public.daf_compact_expired_log_batch('2026-02-10'::date, 1000);

create temporary table _after_dashboard as
select d.line, d.file_name,
       (to_jsonb(d) - 'records') || jsonb_build_object(
           'records', (select jsonb_agg(value - 'raw' - 'compacted' order by value->>'dedupKey')
                       from jsonb_array_elements(d.records) item(value))
       ) as dashboard_payload
from (values ('DAF'), ('FT1'), ('FT2'), ('LIGHTING'), ('ASSEMBLY')) as process(line)
cross join lateral public.daf_get_log_process_details(process.line, '2026-01-10', '2026-01-10') d;

create temporary table _after_compaction_preview as
select * from public.daf_preview_log_compaction('2026-02-10'::date);

do $$
declare
    v_rejected boolean := false;
begin
    if exists (
        (select line, file_name, dashboard_payload from _before_dashboard
         except all
         select line, file_name, dashboard_payload from _after_dashboard)
        union all
        (select line, file_name, dashboard_payload from _after_dashboard
         except all
         select line, file_name, dashboard_payload from _before_dashboard)
    ) then raise exception 'Dashboard payload changed across compaction'; end if;
    if exists (
        select 1 from _before_compaction_preview p where p.projection_mismatch_rows <> 0
    ) then raise exception 'A source record differs from the compact dashboard projection'; end if;
    if exists (
        select 1 from _before_compaction_preview b
        join _after_compaction_preview a using (line)
        where b.dashboard_digest <> a.dashboard_digest
    ) then raise exception 'Dashboard projection digest changed across compaction'; end if;
    if (select sum(compacted_winner_rows) from _after_compaction_preview) <> 6 then
        raise exception 'The preview digest does not count all compacted winners';
    end if;
    if exists (
        select 1 from public.daf_log_batches
        where line = 'DAF' and file_name = 'old-test.xlsx' and records <> '[]'::jsonb
    ) then raise exception 'Legacy raw record cache was not cleared after compaction'; end if;
    if (select count(*) from _after_dashboard) <> 5 then raise exception 'A process dashboard row disappeared'; end if;
    if exists (
        select 1 from (values ('DAF'), ('FT1'), ('FT2'), ('LIGHTING'), ('ASSEMBLY')) as process(line),
             lateral public.daf_get_log_process_details(process.line, '2026-01-10', '2026-01-10') d,
             lateral jsonb_array_elements(d.records) item(value)
        where item.value->'raw' <> '[]'::jsonb or item.value->>'compacted' <> 'true'
    ) then raise exception 'Compacted detail payload does not identify removed raw columns'; end if;
    if exists (select 1 from public.daf_log_candidates where report_date = '2026-01-10') then
        raise exception 'Expired candidate rows were not removed';
    end if;
    if (select count(*) from public.daf_log_compact_facts) <> 6 then
        raise exception 'Expected six compact winner facts across all five processes';
    end if;

    begin
        perform public.daf_compact_expired_log_batch('2026-09-30'::date, 1000);
    exception when others then
        v_rejected := position('30 天' in sqlerrm) > 0;
    end;
    if not v_rejected then raise exception 'A cutoff less than 30 days old was accepted'; end if;
end;
$$;

do $$
declare
    v_rejected boolean := false;
    v_error text;
begin
    begin
        perform public.daf_stage_log_import_chunk(
            '00000000-0000-4000-8000-000000000004'::uuid,
            'DAF', 0, 'racing-old-chunk',
            '[{"dedupKey":"E-RACE","dedupTime":1767945600000,"date":"2026-01-09","workOrder":"WO-RACE","productCode":"P-RACE","model":"Model-RACE","status":"GOOD","defect":"","machine":"未知機台","inputIncluded":true,"isDefect":false,"sourceFormat":"current-v2","raw":[]}]'::jsonb
        );
    exception when others then
        v_rejected := position('已封存日期' in sqlerrm) > 0;
    end;
    if not v_rejected then raise exception 'Candidate trigger did not reject an archived-date record'; end if;

    v_rejected := false;
    begin
        execute 'alter table public.daf_log_candidates disable trigger guard_daf_compacted_candidate_insert';
        perform public.daf_stage_log_import_chunk(
            '00000000-0000-4000-8000-000000000004'::uuid,
            'DAF', 0, 'racing-old-chunk',
            '[{"dedupKey":"E-RACE","dedupTime":1767945600000,"date":"2026-01-09","workOrder":"WO-RACE","productCode":"P-RACE","model":"Model-RACE","status":"GOOD","defect":"","machine":"未知機台","inputIncluded":true,"isDefect":false,"sourceFormat":"current-v2","raw":[]}]'::jsonb
        );
        execute 'alter table public.daf_log_candidates enable trigger guard_daf_compacted_candidate_insert';
        perform public.daf_finalize_log_import('00000000-0000-4000-8000-000000000004'::uuid);
    exception when others then
        v_error := sqlerrm;
        v_rejected := position('已封存日期' in sqlerrm) > 0;
    end;
    if not v_rejected then raise exception 'Finalize did not reject a staged archived-date record: %', v_error; end if;
    delete from public.daf_log_import_jobs where id = '00000000-0000-4000-8000-000000000004'::uuid;
end;
$$;

select public.daf_update_machine_classification('[{"dedup_key":"E-002","machine":"1號機"},{"dedup_key":"E-FT1","machine":"2號機"}]'::jsonb);
do $$
begin
    if not exists (
        select 1 from public.daf_get_log_process_details('DAF', '2026-01-10', '2026-01-10') d,
        lateral jsonb_array_elements(d.records) r(value)
        where r.value->>'dedupKey' = 'E-002' and r.value->>'machine' = '1號機'
    ) then raise exception 'Machine update did not reach compact history'; end if;
    if not exists (
        select 1 from public.daf_get_log_process_details('FT1', '2026-01-10', '2026-01-10') d,
        lateral jsonb_array_elements(d.records) r(value)
        where r.value->>'dedupKey' = 'E-FT1' and r.value->>'machine' = '2號機'
    ) then raise exception 'FT1 machine update did not reach compact history'; end if;
end;
$$;

select public.daf_start_log_import(
    '00000000-0000-4000-8000-000000000002'::uuid,
    'duplicate-test.xlsx',
    jsonb_build_array(jsonb_build_object(
        'id', 'duplicate-summary', 'line', 'DAF', 'file_name', 'duplicate-test.xlsx',
        'uploaded_at', '2026-03-01T08:00:00Z', 'date_start', '2026-03-01',
        'date_end', '2026-03-01', 'raw_column_count', 10
    )),
    1
);
select public.daf_stage_log_import_chunk(
    '00000000-0000-4000-8000-000000000002'::uuid,
    'DAF', 0, 'new-duplicate-chunk',
    '[{"dedupKey":"E-001","dedupTime":1772352000000,"date":"2026-03-01","workOrder":"WO-1","productCode":"P-1","model":"Model-1","status":"GOOD","defect":"","machine":"1號機","inputIncluded":true,"isDefect":false,"sourceFormat":"current-v2","raw":[]}]'::jsonb
);
select public.daf_finalize_log_import('00000000-0000-4000-8000-000000000002'::uuid);

do $$
declare v_rejected boolean := false;
begin
    begin
        perform public.daf_start_log_import(
            '00000000-0000-4000-8000-000000000003'::uuid,
            'too-old.xlsx',
            jsonb_build_array(jsonb_build_object(
                'line', 'DAF', 'file_name', 'too-old.xlsx', 'date_start', '2026-01-01', 'date_end', '2026-01-01'
            )),
            0
        );
    exception when others then
        v_rejected := position('已封存日期' in sqlerrm) > 0;
    end;
    if not v_rejected then raise exception 'An upload reaching the compacted date range was not rejected'; end if;

    v_rejected := false;
    begin
        perform public.daf_delete_log_file_process('DAF', 'old-test.xlsx');
    exception when others then
        v_rejected := position('已封存' in sqlerrm) > 0;
    end;
    if not v_rejected then raise exception 'Deletion of a compacted file was not rejected'; end if;
end;
$$;

do $$
begin
    if not exists (
        select 1 from public.daf_log_import_jobs
        where id = '00000000-0000-4000-8000-000000000002'::uuid
          and status = 'published' and accepted_count = 0 and duplicate_count = 1
    ) then raise exception 'Duplicate E value against compact history was not skipped'; end if;
    if not exists (
        select 1 from public.daf_log_batches
        where line = 'DAF' and file_name = 'old-test.xlsx'
          and input_count = 2 and good_count = 1 and fail_count = 1
    ) then raise exception 'File summary changed after compaction'; end if;
end;
$$;

insert into public.daf_log_batches(id, line, file_name, uploaded_at, records)
values
    ('old-machine-reference', '__DAF_MACHINE_REFERENCE__', 'machine-reference.xlsx', '2026-09-05T00:00:00Z', '[{"dedupKey":"OLD","machine":"1號機"}]'::jsonb),
    ('recent-machine-reference', '__DAF_MACHINE_REFERENCE__', 'machine-reference.xlsx', '2026-09-10T00:00:00Z', '[{"dedupKey":"NEW","machine":"2號機"}]'::jsonb);

do $$
begin
    if public.daf_prune_expired_machine_references('2026-10-06T00:00:00Z'::timestamptz) <> 1 then
        raise exception 'Machine reference retention did not delete exactly the expired row';
    end if;
    if not exists (
        select 1 from public.daf_log_batches where id = 'recent-machine-reference'
    ) then raise exception 'Machine reference retention removed a non-expired row'; end if;
end;
$$;

select 'daf historical compaction checks passed' as result;
