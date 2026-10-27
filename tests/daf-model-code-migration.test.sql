-- Run ONLY against a disposable, empty local database with this exact name.
\set ON_ERROR_STOP on
do $$ begin
    if current_database()<>'daf_model_code_test' then raise exception 'Isolated test database required'; end if;
    if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
    if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
end $$;
\ir ../supabase/daf_log_batches.sql
insert into public.daf_log_batches(id,line,file_name,product_code,model_name,records) values
('old-a','__PROCESS_MODEL_MAPPING__','mapping','RFPCBA,DAF,FP-D01321BE11','A01-ELAN','[]'),
('old-b','__PROCESS_MODEL_MAPPING__','mapping','PACKAGE,FP-D01321BE11','B24-ELAN','[]'),
('old-c','__PROCESS_MODEL_MAPPING__','mapping','PACKAGE,FP-D01524BK11,COMPAL','B27-GOODIX','[]'),
('old-d','__PROCESS_MODEL_MAPPING__','mapping','FP-D01524BK11,CD9FV,PK09001AO0L','B27-ELAN','[]'),
('old-e','__PROCESS_MODEL_MAPPING__','mapping','RFPCB,DAF,TAROKO 14' || chr(39) || chr(39),'TK14-GOODIX','[]'),
('old-f','__PROCESS_MODEL_MAPPING__','mapping','RFPCB,DAF,TAROKO 14,SYNAPTICS','TK14-SYNAPTICS','[]'),
('old-g','__PROCESS_MODEL_MAPPING__','mapping','MS3633-T07','HP-C-DECK','[]'),
('production','DAF','production.xlsx','PACKAGE,FP-D01321BE11','A01-ELAN','[{"quantity":10,"raw":["keep"]}]'),
('machine','__DAF_MACHINE_REFERENCE__','reference','FP-D01321BE11',null,'[{"machine":"1號機"}]');
create table preserved as select id,md5(to_jsonb(b)::text) as digest from public.daf_log_batches b where id in ('production','machine');
\ir ../supabase/daf_model_code_normalization.sql
create table first_migration as select id,md5(to_jsonb(b)::text) as digest from public.daf_log_batches b;
\ir ../supabase/daf_model_code_normalization.sql
do $$ begin
    if exists((select * from first_migration except select id,md5(to_jsonb(b)::text) from public.daf_log_batches b)
        union all (select id,md5(to_jsonb(b)::text) from public.daf_log_batches b except select * from first_migration)) then
        raise exception 'Migration is not idempotent'; end if;
    if (select count(*) from public.daf_log_batches where line='__PROCESS_MODEL_MAPPING__')<>5 then
        raise exception 'Aliases not deduplicated or exceptions lost'; end if;
    if not exists(select 1 from public.daf_log_batches where product_code='FP-D01321BE11' and model_name='B24-ELAN')
        or not exists(select 1 from public.daf_log_batches where product_code='FP-D01524BK11' and model_name='B27-ELAN') then
        raise exception 'Confirmed mappings lost'; end if;
    if public.daf_normalize_model_code('FP-A,FP-B') is not null
        or public.daf_normalize_model_code('XFP-ABC') is not null
        or public.daf_normalize_model_code('package, fp-d01607mb11, extra')<>'FP-D01607MB11' then
        raise exception 'SQL extraction differs from JS'; end if;
end $$;
-- An old browser upsert must update the canonical row, not add a noisy alias.
insert into public.daf_log_batches(id,line,file_name,product_code,model_name,records)
values('stale-client','__PROCESS_MODEL_MAPPING__','mapping','PACKAGE,FP-D01524BK11,COMPAL','B27-GOODIX','[]')
on conflict(id) do update set product_code=excluded.product_code,model_name=excluded.model_name,records=excluded.records;
do $$ begin
    if exists(select 1 from public.daf_log_batches where id='stale-client') or
        (select count(*) from public.daf_log_batches where product_code='FP-D01524BK11')<>1 then
        raise exception 'Stale browser reintroduced a noisy or duplicate mapping'; end if;
    if exists(select 1 from public.daf_log_batches where product_code='FP-D01524BK11' and model_name<>'B27-ELAN') then
        raise exception 'Stale browser overrode confirmed model'; end if;
    begin
        insert into public.daf_log_batches(id,line,file_name,product_code,model_name)
        values('invalid','__PROCESS_MODEL_MAPPING__','mapping','NOISE','BAD');
        raise exception 'TEST invalid memory accepted';
    exception when raise_exception then
        if sqlerrm='TEST invalid memory accepted' then raise; end if;
    end;
    if exists(select id,digest from preserved except select id,md5(to_jsonb(b)::text) from public.daf_log_batches b) then
        raise exception 'Production data or machine references changed'; end if;
    raise notice 'PASS: normalization, approved conflicts, exceptions, idempotency, old client, production unchanged';
end $$;
