-- 線上診斷：只用既有鍵驗證分類函式，所有資料修改一律 ROLLBACK。
-- 執行前後仍須比對 daf_compact_dashboard_digest 及每日報工資料雜湊。
\set ON_ERROR_STOP on
\timing on
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';
create temporary table _daf_reference_probe on commit drop as
select id from public.daf_log_batches where line='__DAF_MACHINE_REFERENCE__' order by id limit 10;
-- 實測與前端相同的參照 upsert／刪除鎖路徑，沿用既有內容，交易結束回滾。
with saved as (
    insert into public.daf_log_batches
    select b.* from public.daf_log_batches b join _daf_reference_probe p using(id) order by b.id
    on conflict(id) do update set records=excluded.records,uploaded_at=excluded.uploaded_at
    returning 1
)
select count(*) as rollback_reference_upserts from saved;
delete from public.daf_log_batches b using _daf_reference_probe p
where b.id=p.id and b.line='__DAF_MACHINE_REFERENCE__';
create temporary table _daf_machine_probe on commit drop as
with samples as (
    (select dedup_key, case when machine='1號機' then '2號機' else '1號機' end machine
     from public.daf_log_candidates where line in ('DAF','FT1') and dedup_key is not null limit 5)
    union all
    (select k.dedup_key, case when g.machine='1號機' then '2號機' else '1號機' end machine
     from public.daf_log_compact_e_keys k join public.daf_log_compact_groups g using(group_id)
     where k.line in ('DAF','FT1') limit 5)
)
select distinct on (dedup_key) dedup_key,machine from samples order by dedup_key,machine;
analyze _daf_machine_probe;
explain (analyze, buffers)
select c.id from public.daf_log_candidates c join _daf_machine_probe m
on upper(btrim(c.dedup_key))=m.dedup_key
where c.line in ('DAF','FT1') and c.machine is distinct from m.machine;
explain (analyze, buffers)
select k.group_id from public.daf_log_compact_e_keys k join _daf_machine_probe m
on upper(btrim(k.dedup_key))=m.dedup_key
where k.line in ('DAF','FT1');
select public.daf_update_machine_classification(coalesce(
    (select jsonb_agg(to_jsonb(m)) from _daf_machine_probe m),'[]'::jsonb)) as rollback_probe_updates;
rollback;
