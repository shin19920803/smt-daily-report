-- 僅限隔離的空白測試資料庫，禁止在線上執行此測試。
\set ON_ERROR_STOP on
create table public.daf_log_candidates as
select case when n%3=0 then 'FT2' when n%3=1 then 'DAF' else 'FT1' end as line,
       case when n=1 then ' e-1 ' else 'E-'||n::text end as dedup_key,
       '未分類機台'::text as machine
from generate_series(1,60000) n;
create table public.daf_log_compact_facts as table public.daf_log_candidates;
create table public.daf_log_compact_e_keys as table public.daf_log_candidates;
create function public.daf_update_machine_classification(p_mappings jsonb)
returns integer language plpgsql as $$
declare v_count integer;
begin
    create temporary table _daf_machine_mapping on commit drop as
    select distinct on (upper(btrim(m.dedup_key))) upper(btrim(m.dedup_key)) as dedup_key,m.machine
    from jsonb_to_recordset(coalesce(p_mappings,'[]'::jsonb)) as m(dedup_key text,machine text)
    where m.machine in ('1號機','2號機') and nullif(btrim(m.dedup_key),'') is not null
    order by upper(btrim(m.dedup_key)),m.machine;
    select count(*) into v_count from public.daf_log_candidates c join _daf_machine_mapping m
    on upper(btrim(c.dedup_key))=m.dedup_key where c.line in ('DAF','FT1');
    return v_count;
end;
$$;
create temp table before_function as
select pg_get_functiondef('public.daf_update_machine_classification(jsonb)'::regprocedure) definition;
create temp table before_matching as
select public.daf_update_machine_classification('[{"dedup_key":" e-1 ","machine":"1號機"}]') matches;
create temp table before_indexes as
select 'daf_log_candidates' name,md5(string_agg(row_to_json(c)::text,'' order by dedup_key)) digest from public.daf_log_candidates c
union all select 'daf_log_compact_facts',md5(string_agg(row_to_json(c)::text,'' order by dedup_key)) from public.daf_log_compact_facts c
union all select 'daf_log_compact_e_keys',md5(string_agg(row_to_json(c)::text,'' order by dedup_key)) from public.daf_log_compact_e_keys c;
\ir ../supabase/daf_machine_reference_lock_fix.sql
\ir ../supabase/daf_machine_reference_lock_fix.sql
analyze public.daf_log_candidates;
analyze public.daf_log_compact_facts;
analyze public.daf_log_compact_e_keys;
do $$
declare r record; after_digest text; query_plan json; matched integer; after_definition text;
begin
    select pg_get_functiondef('public.daf_update_machine_classification(jsonb)'::regprocedure) into after_definition;
    if replace(after_definition,E'\n    analyze _daf_machine_mapping;','') is distinct from (select definition from before_function) then
        raise exception '修改了既有函式邏輯';
    end if;
    for r in select * from before_indexes loop
        execute format('select md5(string_agg(row_to_json(c)::text, %L order by dedup_key)) from public.%I c','',r.name) into after_digest;
        if after_digest is distinct from r.digest then raise exception '資料被修改: %',r.name; end if;
        execute format('select count(*) from public.%I where line in (%L,%L) and upper(btrim(dedup_key))=%L',r.name,'DAF','FT1','E-1') into matched;
        if matched<>1 then raise exception '大小寫／空白比對改變: %',r.name; end if;
        execute format('explain (format json) select * from public.%I where line in (%L,%L) and upper(btrim(dedup_key))=%L',r.name,'DAF','FT1','E-1') into query_plan;
        if query_plan::text not like '%Index%' then raise exception '沒有使用索引: % %',r.name,query_plan; end if;
        raise notice 'PASS %: 資料雜湊相同、比對相同、使用索引',r.name;
    end loop;
end;
$$;
do $$
begin
    if public.daf_update_machine_classification('[{"dedup_key":" e-1 ","machine":"1號機"}]')
        is distinct from (select matches from before_matching) then raise exception '函式比對結果改變'; end if;
end;
$$;
-- 模擬實際 RPC 的 mapping join，避免只有單筆常數查詢快、批次查詢仍掃全表。
begin;
create temp table _daf_machine_mapping on commit drop as
select 'E-'||n::text dedup_key,'1號機'::text machine from generate_series(1,100) n;
analyze _daf_machine_mapping;
do $$
declare r record; query_plan json;
begin
    for r in select name from before_indexes loop
        execute format('explain (format json) select c.* from public.%I c join _daf_machine_mapping m on upper(btrim(c.dedup_key))=m.dedup_key where c.line in (%L,%L) and c.machine is distinct from m.machine',r.name,'DAF','FT1') into query_plan;
        if query_plan::text not like '%Index%' then raise exception '批次分類仍然掃全表: % %',r.name,query_plan; end if;
        raise notice 'PASS %: 實際批次 join 使用索引',r.name;
    end loop;
end;
$$;
commit;
