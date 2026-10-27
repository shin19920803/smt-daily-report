-- Mapping memory only: never rewrite production records, summaries or RAW.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

create or replace function public.daf_normalize_model_code(p_value text)
returns text language plpgsql immutable set search_path = pg_catalog as $$
declare
    v_text text := upper(btrim(regexp_replace(coalesce(p_value,''),'\s+',' ','g')));
    v_codes text[];
    v_exception text;
begin
    select array_agg(distinct m[2]) into v_codes
    from regexp_matches(v_text,'(^|[^A-Z0-9_-])(FP-[A-Z0-9]+(-[A-Z0-9]+)*)(?=$|[^A-Z0-9_-])','g') m;
    if cardinality(v_codes)>0 then
        return case when cardinality(v_codes)=1 then v_codes[1] else null end;
    end if;
    foreach v_exception in array array['RFPCB,DAF,TAROKO 14' || chr(39) || chr(39),
        'RFPCB,DAF,TAROKO 14,SYNAPTICS','MS3633-T07'] loop
        if strpos(v_text,v_exception)>0 then return v_exception; end if;
    end loop;
    return null;
end;
$$;

-- Protect against old browser tabs reintroducing prefixed/suffixed keys.
create or replace function public.daf_guard_model_code_memory()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_code text;
begin
    if new.line not in ('__PROCESS_MODEL_MAPPING__',
        '__' || chr(75)||chr(79)||chr(89)||chr(65) || '_MODEL_MAPPING__') then return new; end if;
    v_code := public.daf_normalize_model_code(coalesce(nullif(new.product_code,''),new.records->0->>'productCode'));
    if v_code is null then
        raise exception '機種記憶須包含一個 FP- 代號（或既有三項例外），未寫入';
    end if;
    new.line := '__PROCESS_MODEL_MAPPING__';
    new.id := '__PROCESS_MODEL_MAPPING__' || replace(replace(v_code,',','%2C'),' ','%20');
    new.product_code := v_code;
    new.model_name := case v_code when 'FP-D01321BE11' then 'B24-ELAN'
        when 'FP-D01524BK11' then 'B27-ELAN' else upper(btrim(new.model_name)) end;
    if coalesce(new.model_name,'') in ('','未識別機種') then raise exception '機種名稱不可空白'; end if;
    new.records := jsonb_build_array(jsonb_build_object('productCode',v_code,'model',new.model_name));
    return new;
end;
$$;
revoke all on function public.daf_normalize_model_code(text),public.daf_guard_model_code_memory()
from public,anon,authenticated;

-- Briefly block writers, not readers, so migration and legacy writes cannot race.
lock table public.daf_log_batches in share row exclusive mode;
create temporary table _daf_model_memory_source on commit drop as
select b.*,public.daf_normalize_model_code(coalesce(nullif(product_code,''),records->0->>'productCode')) as code
from public.daf_log_batches b
where line in ('__PROCESS_MODEL_MAPPING__','__' || chr(75)||chr(79)||chr(89)||chr(65) || '_MODEL_MAPPING__');
create temporary table _daf_model_untouched on commit drop as
select id,md5(to_jsonb(b)::text) as digest from public.daf_log_batches b
where line not in ('__PROCESS_MODEL_MAPPING__','__' || chr(75)||chr(79)||chr(89)||chr(65) || '_MODEL_MAPPING__');

do $$ begin
    if exists(select 1 from _daf_model_memory_source where code is null) then
        raise exception '存在無法精簡的機種記憶，整筆遷移已取消';
    end if;
    if exists(select 1 from _daf_model_memory_source
        where code not in ('FP-D01321BE11','FP-D01524BK11')
        group by code having count(distinct upper(btrim(model_name)))>1) then
        raise exception '存在未確認的機種衝突，整筆遷移已取消';
    end if;
end $$;

drop trigger if exists daf_model_code_memory_guard on public.daf_log_batches;
create trigger daf_model_code_memory_guard before insert or update on public.daf_log_batches
for each row when (new.line='__PROCESS_MODEL_MAPPING__' or
    new.line=('__' || chr(75)||chr(79)||chr(89)||chr(65) || '_MODEL_MAPPING__'))
execute function public.daf_guard_model_code_memory();

delete from public.daf_log_batches where id in (select id from _daf_model_memory_source);
insert into public.daf_log_batches
select (jsonb_populate_record(null::public.daf_log_batches,to_jsonb(s)-'code')).*
from (select distinct on (code) * from _daf_model_memory_source order by code,uploaded_at desc,id) s;

do $$ begin
    if exists(
        (select id,digest from _daf_model_untouched except
         select id,md5(to_jsonb(b)::text) from public.daf_log_batches b
         where line not in ('__PROCESS_MODEL_MAPPING__','__' || chr(75)||chr(79)||chr(89)||chr(65) || '_MODEL_MAPPING__'))
        union all
        (select id,md5(to_jsonb(b)::text) from public.daf_log_batches b
         where line not in ('__PROCESS_MODEL_MAPPING__','__' || chr(75)||chr(79)||chr(89)||chr(65) || '_MODEL_MAPPING__')
         except select id,digest from _daf_model_untouched)
    ) then raise exception '非機種記憶資料有差異，已取消遷移'; end if;
end $$;
commit;
