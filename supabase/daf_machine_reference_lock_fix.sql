-- 使用 psql 執行（CONCURRENTLY 不可放入 transaction / DO 區塊）。
-- 增加查找索引與臨時映射統計，不變更資料、分類規則或製程鎖。
\set ON_ERROR_STOP on
set lock_timeout = '5s';
set statement_timeout = '120s';

-- 先確認現行函式可精確修補；版本不符時停止，不覆寫未知版本。
do $$
declare v_definition text;
begin
    v_definition := pg_get_functiondef(to_regprocedure('public.daf_update_machine_classification(jsonb)'));
    if v_definition is null or position('order by upper(btrim(m.dedup_key)),m.machine;' in v_definition) = 0 then
        raise exception '機台分類函式版本不符，未套用修正';
    end if;
end;
$$;

-- 中斷的 CREATE INDEX CONCURRENTLY 可能留下 invalid index；允許安全續跑。
select format('drop index concurrently public.%I;', c.relname)
from pg_index i join pg_class c on c.oid = i.indexrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and not i.indisvalid
  and c.relname in ('daf_candidates_machine_key_idx', 'daf_facts_machine_key_idx', 'daf_compact_e_machine_key_idx')
\gexec

-- 對應現行 RPC 的 upper(btrim(dedup_key))，保留空白／大小寫相容性。
create index concurrently if not exists daf_candidates_machine_key_idx
    on public.daf_log_candidates (upper(btrim(dedup_key)), line);
create index concurrently if not exists daf_facts_machine_key_idx
    on public.daf_log_compact_facts (upper(btrim(dedup_key)), line);
create index concurrently if not exists daf_compact_e_machine_key_idx
    on public.daf_log_compact_e_keys (upper(btrim(dedup_key)), line);

-- 讓 PostgreSQL 知道正規化識別碼的分布，避免在製程鎖內反覆掃描整表。
analyze public.daf_log_candidates;
analyze public.daf_log_compact_facts;
analyze public.daf_log_compact_e_keys;

do $$
declare v_definition text;
begin
    v_definition := pg_get_functiondef('public.daf_update_machine_classification(jsonb)'::regprocedure);
    if position('analyze _daf_machine_mapping;' in lower(v_definition)) = 0 then
        execute replace(v_definition, 'order by upper(btrim(m.dedup_key)),m.machine;',
            E'order by upper(btrim(m.dedup_key)),m.machine;\n    analyze _daf_machine_mapping;');
    end if;
    if (select count(*) from pg_index i join pg_class c on c.oid=i.indexrelid
        join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and i.indisvalid
        and c.relname in ('daf_candidates_machine_key_idx','daf_facts_machine_key_idx','daf_compact_e_machine_key_idx')) <> 3 then
        raise exception '機台查找索引尚未全部有效，請查看前面的錯誤';
    end if;
end;
$$;

select c.relname as index_name, i.indisvalid, pg_size_pretty(pg_relation_size(c.oid)) as index_size
from pg_index i join pg_class c on c.oid = i.indexrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in
    ('daf_candidates_machine_key_idx', 'daf_facts_machine_key_idx', 'daf_compact_e_machine_key_idx')
order by c.relname;
select position('analyze _daf_machine_mapping;' in lower(pg_get_functiondef(
    'public.daf_update_machine_classification(jsonb)'::regprocedure))) > 0 as mapping_statistics_enabled;
