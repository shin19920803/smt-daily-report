-- Read existing data; write only temporary tables and roll everything back.
\set ON_ERROR_STOP on
\timing on
begin;
set local statement_timeout = '40s';
set local jit = off;
create temp table _probe_keys on commit drop as
select distinct line,dedup_key from public.daf_log_candidates
where job_id=(select job_id from public.daf_log_candidates group by job_id order by count(*) desc limit 1)
and dedup_key is not null;
analyze _probe_keys;
create temp table _probe_old on commit drop as
select distinct on(c.line,c.dedup_key) c.id,c.line,c.dedup_key
from public.daf_log_candidates c join public.daf_log_active_file_processes h
on h.line=c.line and h.file_name=c.file_name and h.job_id=c.job_id
join _probe_keys k on k.line=c.line and k.dedup_key=c.dedup_key
where not exists(select 1 from public.daf_log_compact_e_keys e where e.line=c.line and e.dedup_key=c.dedup_key)
and not exists(select 1 from public.daf_log_compact_facts f where f.line=c.line and f.dedup_key=c.dedup_key)
order by c.line,c.dedup_key,c.dedup_time asc nulls last,c.created_at asc,c.id asc;
create temp table _probe_new on commit drop as
select picked.* from _probe_keys k cross join lateral (
select c.id,c.line,c.dedup_key from public.daf_log_candidates c
join public.daf_log_active_file_processes h on h.line=c.line and h.file_name=c.file_name and h.job_id=c.job_id
where c.line=k.line and c.dedup_key=k.dedup_key
and not exists(select 1 from public.daf_log_compact_e_keys e where e.line=c.line and e.dedup_key=c.dedup_key)
and not exists(select 1 from public.daf_log_compact_facts f where f.line=c.line and f.dedup_key=c.dedup_key)
order by c.dedup_time asc nulls last,c.created_at asc,c.id asc limit 1
) picked;
do $$ begin
if exists((select * from _probe_old except select * from _probe_new)
union all (select * from _probe_new except select * from _probe_old)) then
raise exception 'Winner mismatch: do not deploy'; end if;
end $$;
select (select count(*) from _probe_keys) as affected_keys,
       (select count(*) from _probe_new) as identical_winners;
rollback;
