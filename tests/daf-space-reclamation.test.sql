-- Run against an isolated, restored public-schema production snapshot only.
\set ON_ERROR_STOP on
\ir ../supabase/daf_historical_compaction.sql
\ir ../supabase/daf_candidate_payload_slimming.sql

create temp table reclaim_baseline as
select line, dashboard_digest
from public.daf_preview_log_compaction('9999-12-31');
create temp table reclaim_summaries as
select line, md5(string_agg(md5((to_jsonb(b) - 'records')::text), '' order by id)) digest
from public.daf_log_batches b group by line;

select public.daf_activate_14_day_candidate_retention();
select format('select public.daf_compact_expired_log_batch(%L::date, 5000);',
              (now() at time zone 'Asia/Taipei')::date - 14)
from generate_series(1, (
    select (count(*) / 5000 + 2)::integer from public.daf_log_candidates
    where public.daf_is_valid_iso_date(report_date)
      and report_date < ((now() at time zone 'Asia/Taipei')::date - 14)::text
))
\gexec
select format('select public.daf_strip_expired_log_raw_batch(%L::date, 1000);',
              (now() at time zone 'Asia/Taipei')::date + 1)
from generate_series(1, (
    select (count(*) / 1000 + 2)::integer from public.daf_log_candidates
    where record_json ? 'raw'
))
\gexec

-- Preserve exact physical rows through the rewrite, in addition to report inputs.
create temp table reclaim_row_hashes as
select 'candidates' name, md5(string_agg(md5(to_jsonb(c)::text), '' order by id)) digest
from public.daf_log_candidates c
union all
select 'winners', md5(string_agg(md5(to_jsonb(w)::text), '' order by line, candidate_id))
from public.daf_log_winners w
union all
select 'facts', md5(string_agg(md5(to_jsonb(f)::text), '' order by candidate_id))
from public.daf_log_compact_facts f;

select 'before_reclaim' phase, pg_database_size(current_database()) database_bytes;
vacuum (full, analyze) public.daf_log_winners;
vacuum (full, analyze) public.daf_log_candidates;
vacuum (full, analyze) public.daf_log_compact_facts;
select 'after_reclaim' phase, pg_database_size(current_database()) database_bytes;
select relname, pg_relation_size(oid) heap, pg_indexes_size(oid) indexes,
       pg_total_relation_size(oid) total
from pg_class where relname in ('daf_log_candidates','daf_log_winners','daf_log_compact_facts');

do $$
begin
    if exists (
        (select * from reclaim_baseline except select line, dashboard_digest
         from public.daf_preview_log_compaction('9999-12-31'))
        union all
        (select line, dashboard_digest from public.daf_preview_log_compaction('9999-12-31')
         except select * from reclaim_baseline)
    ) then raise exception 'Historical dashboard inputs changed'; end if;
    if exists (
        select 1 from reclaim_summaries a full join (
            select line, md5(string_agg(md5((to_jsonb(b) - 'records')::text), '' order by id)) digest
            from public.daf_log_batches b group by line
        ) b using (line) where a.digest is distinct from b.digest
    ) then raise exception 'Daily upload summaries changed'; end if;
    if exists (
        select 1 from reclaim_row_hashes a full join (
            select 'candidates' name, md5(string_agg(md5(to_jsonb(c)::text), '' order by id)) digest
            from public.daf_log_candidates c
            union all
            select 'winners', md5(string_agg(md5(to_jsonb(w)::text), '' order by line, candidate_id))
            from public.daf_log_winners w
            union all
            select 'facts', md5(string_agg(md5(to_jsonb(f)::text), '' order by candidate_id))
            from public.daf_log_compact_facts f
        ) b using (name) where a.digest is distinct from b.digest
    ) then raise exception 'Physical row content changed'; end if;
    raise notice 'Space reclamation: all history, upload summaries and exact rows unchanged';
end;
$$;

\ir ../supabase/daf_space_reclamation.sql
select public.daf_begin_space_reclamation();
do $$
begin
    if not exists (select 1 from public.daf_log_compact_facts) then
        raise exception 'Historical reads became empty during maintenance';
    end if;
    begin
        update public.daf_log_candidates set record_json=record_json where false;
        raise exception 'Maintenance allowed candidate mutations';
    exception when object_not_in_prerequisite_state then null; end;
    begin
        truncate public.daf_log_winners;
        raise exception 'Maintenance allowed a truncate';
    exception when object_not_in_prerequisite_state then null; end;
    begin
        perform public.daf_start_log_import('c813afbb-2665-49d6-8131-3f854933a99a',
            'reclaim-test.xlsx','[{"line":"DAF"}]',0);
        raise exception 'Maintenance allowed a new upload';
    exception when object_not_in_prerequisite_state then null; end;
    begin
        perform public.daf_begin_space_reclamation();
        raise exception 'Maintenance allowed a second owner';
    exception when raise_exception then
        if sqlerrm <> '已有空間回收程序；請先確認該程序狀態' then raise; end if;
    end;
end;
$$;
select public.daf_end_space_reclamation();
insert into public.daf_log_import_jobs(id,file_name,status,metadata)
values('c813afbb-2665-49d6-8131-3f854933a99a','reclaim-test.xlsx','receiving','[]');
do $$
begin
    begin
        perform public.daf_begin_space_reclamation();
        raise exception 'Maintenance ignored a receiving upload';
    exception when raise_exception then
        if sqlerrm <> '仍有接收中的上傳工作，尚未啟動空間回收' then raise; end if;
    end;
    if exists (select 1 from public.daf_log_reclamation_state where active) then
        raise exception 'Failed maintenance activation left writes blocked';
    end if;
    raise notice 'Maintenance barrier checks passed';
end;
$$;
delete from public.daf_log_import_jobs where id='c813afbb-2665-49d6-8131-3f854933a99a';
