-- Reuse canonical B-tree keys for machine classification and reclaim the
-- temporary expression indexes created by the earlier lock-timeout fix.
-- Run with psql; DROP INDEX CONCURRENTLY must remain outside a transaction.
\set ON_ERROR_STOP on
set lock_timeout = '5s';
set statement_timeout = '120s';

do $$
declare
    v_definition text;
begin
    if exists (
        select 1 from public.daf_log_candidates
        where dedup_key is not null and dedup_key is distinct from upper(btrim(dedup_key))
    ) or exists (
        select 1 from public.daf_log_compact_facts
        where dedup_key is not null and dedup_key is distinct from upper(btrim(dedup_key))
    ) or exists (
        select 1 from public.daf_log_compact_e_keys
        where dedup_key is not null and dedup_key is distinct from upper(btrim(dedup_key))
    ) then
        raise exception '發現非標準 E 欄識別碼；保留既有機台索引，未進行回收';
    end if;

    if to_regclass('public.daf_log_candidates_key_time_idx') is null
       or to_regclass('public.daf_log_compact_e_keys_pkey') is null
       or to_regclass('public.daf_log_compact_facts_unique_e_idx') is null then
        raise exception '標準 E 欄查詢索引不完整；保留機台索引，未進行回收';
    end if;

    v_definition := pg_get_functiondef(to_regprocedure('public.daf_update_machine_classification(jsonb)'));
    if v_definition is null or position('order by upper(btrim(m.dedup_key)),m.machine;' in v_definition) = 0 then
        raise exception '機台分類函式版本不符，未套用修正';
    end if;

    v_definition := replace(v_definition, 'upper(btrim(c.dedup_key))=m.dedup_key', 'c.dedup_key=m.dedup_key');
    v_definition := replace(v_definition, 'upper(btrim(f.dedup_key))=m.dedup_key', 'f.dedup_key=m.dedup_key');
    v_definition := replace(v_definition, 'upper(btrim(k.dedup_key))=m.dedup_key', 'k.dedup_key=m.dedup_key');
    if position('c.dedup_key=m.dedup_key' in v_definition) = 0
       or position('k.dedup_key=m.dedup_key' in v_definition) = 0 then
        raise exception '機台分類未改用標準 E 欄索引，停止回收';
    end if;
    execute v_definition;
end;
$$;

analyze public.daf_log_candidates;
analyze public.daf_log_compact_facts;
analyze public.daf_log_compact_e_keys;

drop index concurrently if exists public.daf_candidates_machine_key_idx;
drop index concurrently if exists public.daf_facts_machine_key_idx;
drop index concurrently if exists public.daf_compact_e_machine_key_idx;

do $$
declare
    v_definition text;
begin
    v_definition := pg_get_functiondef('public.daf_update_machine_classification(jsonb)'::regprocedure);
    if position('c.dedup_key=m.dedup_key' in v_definition) = 0
       or position('k.dedup_key=m.dedup_key' in v_definition) = 0
       or position('upper(btrim(c.dedup_key))=m.dedup_key' in v_definition) > 0
       or position('upper(btrim(k.dedup_key))=m.dedup_key' in v_definition) > 0 then
        raise exception '機台分類函式未通過正規鍵核對';
    end if;
    if to_regclass('public.daf_candidates_machine_key_idx') is not null
       or to_regclass('public.daf_compact_e_machine_key_idx') is not null then
        raise exception '舊正規化索引仍存在';
    end if;
end;
$$;

select c.relname as index_name, i.indisvalid,
       pg_size_pretty(pg_relation_size(c.oid)) as index_size
from pg_index i join pg_class c on c.oid = i.indexrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('daf_log_candidates_key_time_idx', 'daf_log_compact_e_keys_pkey',
                    'daf_log_compact_facts_unique_e_idx')
order by c.relname;
