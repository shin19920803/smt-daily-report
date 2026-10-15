-- 僅限隔離測試資料庫；驗證標準 B-tree 查找取代正規化表達式索引。
\set ON_ERROR_STOP on

create table public.daf_log_candidates as
select case when n%3=0 then 'FT2' when n%3=1 then 'DAF' else 'FT1' end as line,
       'E-'||n::text as dedup_key,
       '未分類機台'::text as machine,
       n::bigint as dedup_time,
       now() as created_at
from generate_series(1,60000) n;
create table public.daf_log_compact_facts as table public.daf_log_candidates;
create table public.daf_log_compact_e_keys as table public.daf_log_candidates;
create index daf_log_candidates_key_time_idx
    on public.daf_log_candidates(line,dedup_key,dedup_time,created_at);
create unique index daf_log_compact_facts_unique_e_idx
    on public.daf_log_compact_facts(line,dedup_key);
create unique index daf_log_compact_e_keys_pkey
    on public.daf_log_compact_e_keys(line,dedup_key);

create function public.daf_update_machine_classification(p_mappings jsonb)
returns integer language plpgsql as $$
declare v_count integer;
begin
    create temporary table _daf_machine_mapping on commit drop as
    select distinct on (upper(btrim(m.dedup_key))) upper(btrim(m.dedup_key)) as dedup_key,m.machine
    from jsonb_to_recordset(coalesce(p_mappings,'[]'::jsonb)) as m(dedup_key text,machine text)
    where m.machine in ('1號機','2號機') and nullif(btrim(m.dedup_key),'') is not null
    order by upper(btrim(m.dedup_key)),m.machine;
    analyze _daf_machine_mapping;
    select
        (select count(*) from public.daf_log_candidates c join _daf_machine_mapping m
            on upper(btrim(c.dedup_key))=m.dedup_key where c.line in ('DAF','FT1'))
      + (select count(*) from public.daf_log_compact_facts f join _daf_machine_mapping m
            on upper(btrim(f.dedup_key))=m.dedup_key where f.line in ('DAF','FT1'))
      + (select count(*) from public.daf_log_compact_e_keys k join _daf_machine_mapping m
            on upper(btrim(k.dedup_key))=m.dedup_key where k.line in ('DAF','FT1'))
      into v_count;
    return v_count;
end;
$$;

create temp table before_function as
select pg_get_functiondef('public.daf_update_machine_classification(jsonb)'::regprocedure) definition;
create temp table before_matching as
select public.daf_update_machine_classification('[{"dedup_key":" e-1 ","machine":"1號機"}]') matches;
create temp table before_rows as
select 'daf_log_candidates' name,md5(string_agg(row_to_json(c)::text,'' order by line,dedup_key)) digest
from public.daf_log_candidates c
union all select 'daf_log_compact_facts',md5(string_agg(row_to_json(c)::text,'' order by line,dedup_key))
from public.daf_log_compact_facts c
union all select 'daf_log_compact_e_keys',md5(string_agg(row_to_json(c)::text,'' order by line,dedup_key))
from public.daf_log_compact_e_keys c;

\ir ../supabase/daf_machine_reference_lock_fix.sql
\ir ../supabase/daf_machine_reference_lock_fix.sql

do $$
declare
    v_expected text;
    v_actual text;
    v_name text;
    v_digest text;
    v_matches integer;
begin
    select definition into v_expected from before_function;
    v_expected := replace(v_expected,'upper(btrim(c.dedup_key))=m.dedup_key','c.dedup_key=m.dedup_key');
    v_expected := replace(v_expected,'upper(btrim(f.dedup_key))=m.dedup_key','f.dedup_key=m.dedup_key');
    v_expected := replace(v_expected,'upper(btrim(k.dedup_key))=m.dedup_key','k.dedup_key=m.dedup_key');
    select pg_get_functiondef('public.daf_update_machine_classification(jsonb)'::regprocedure) into v_actual;
    if v_actual is distinct from v_expected then raise exception '機台函式除索引比對外被改動'; end if;
    for v_name,v_digest in select name,digest from before_rows loop
        if v_name='daf_log_candidates' and md5((select string_agg(row_to_json(c)::text,'' order by line,dedup_key) from public.daf_log_candidates c)) is distinct from v_digest then raise exception '候選資料被改動'; end if;
        if v_name='daf_log_compact_facts' and md5((select string_agg(row_to_json(c)::text,'' order by line,dedup_key) from public.daf_log_compact_facts c)) is distinct from v_digest then raise exception 'facts 資料被改動'; end if;
        if v_name='daf_log_compact_e_keys' and md5((select string_agg(row_to_json(c)::text,'' order by line,dedup_key) from public.daf_log_compact_e_keys c)) is distinct from v_digest then raise exception '歷史 E 欄資料被改動'; end if;
        execute format('select count(*) from public.%I where line in (%L,%L) and dedup_key=%L',v_name,'DAF','FT1','E-1') into v_matches;
        if v_matches<>1 then raise exception '機台鍵比對結果改變：%',v_name; end if;
        raise notice 'PASS %：資料指紋與標準 E 欄比對相同',v_name;
    end loop;
    if public.daf_update_machine_classification('[{"dedup_key":" e-1 ","machine":"1號機"}]')
        is distinct from (select matches from before_matching) then raise exception '函式實際比對結果改變'; end if;
end;
$$;

begin;
create temp table _daf_machine_mapping on commit drop as
select 'E-'||n::text dedup_key,'1號機'::text machine from generate_series(1,100) n;
analyze _daf_machine_mapping;
do $$
declare v_name text; v_plan json;
begin
    for v_name in select unnest(array['daf_log_candidates','daf_log_compact_facts','daf_log_compact_e_keys']) loop
        execute format(
            'explain (format json) select t.* from public.%I t join _daf_machine_mapping m on t.dedup_key=m.dedup_key where t.line in (%L,%L) and t.machine is distinct from m.machine',
            v_name,'DAF','FT1'
        ) into v_plan;
        if v_plan::text not like '%Index%' then raise exception '批次機台分類未使用標準索引：% %',v_name,v_plan; end if;
        raise notice 'PASS %：批次機台比對使用既有 B-tree 索引',v_name;
    end loop;
end;
$$;
commit;
