-- Run only in a new, isolated local PostgreSQL database.
\set ON_ERROR_STOP on
\ir ../supabase/daf_log_batches.sql
\ir ../supabase/daf_staged_imports.sql
\ir ../supabase/daf_historical_compaction.sql
\ir ../supabase/daf_candidate_payload_slimming.sql
-- Local fixture substitutes for pg_cron; never install these on Supabase.
create schema cron;
create table cron.job(jobid bigserial primary key,jobname text,schedule text,command text);
create function cron.unschedule(bigint) returns boolean language sql as
$$ delete from cron.job where jobid=$1 returning true $$;
create function cron.schedule(text,text,text) returns bigint language sql as
$$ insert into cron.job(jobname,schedule,command) values($1,$2,$3) returning jobid $$;
\ir ../supabase/daf_failed_import_cleanup.sql
\ir ../supabase/daf_upload_lock_contention_fix.sql
\ir ../supabase/daf_failed_import_cleanup.sql

do $$
declare
    v_id uuid; v_published uuid; v_result jsonb; v_date text;
    v_metadata jsonb; v_records jsonb; v_before text; v_after text;
begin
    v_date := (now() at time zone 'Asia/Taipei')::date::text;
    v_metadata := jsonb_build_array(jsonb_build_object('id','cleanup-summary','line','DAF',
        'file_name','cleanup-test.xlsx','date_start',v_date,'date_end',v_date,
        'uploaded_at',now(),'raw_column_count',10));
    v_records := jsonb_build_array(jsonb_build_object('dedupKey','cleanup-E',
        'dedupTime',1,'date',v_date,'workOrder','cleanup-WO','model','cleanup-model',
        'status','GOOD','machine','1號機','inputIncluded',true,'isDefect',false));
    v_published := gen_random_uuid();
    perform public.daf_start_log_import(v_published,'cleanup-test.xlsx',v_metadata,1);
    perform public.daf_stage_log_import_chunk(v_published,'DAF',0,'published-hash',v_records);
    perform public.daf_finalize_log_import(v_published);
    select md5(string_agg(to_jsonb(w)::text,'' order by candidate_id)) into v_before
    from public.daf_log_winners w;

    v_id := gen_random_uuid();
    perform public.daf_start_log_import(v_id,'cleanup-test.xlsx',v_metadata,2);
    perform public.daf_stage_log_import_chunk(v_id,'DAF',0,'partial-hash',v_records);
    if not exists(select 1 from public.daf_log_candidates where job_id=v_id) then
        raise exception 'fixture did not stage candidates'; end if;
    v_result := public.daf_abort_log_import(v_id);
    if v_result->>'cleared' <> 'true'
       or exists(select 1 from public.daf_log_candidates where job_id=v_id)
       or exists(select 1 from public.daf_log_import_chunks where job_id=v_id) then
        raise exception 'partial upload cleanup failed'; end if;
    perform public.daf_abort_log_import(v_id);
    begin
        perform public.daf_stage_log_import_chunk(v_id,'DAF',1,'late',v_records);
        raise exception 'TEST_UNEXPECTED_LATE_CHUNK';
    exception when others then
        if SQLERRM='TEST_UNEXPECTED_LATE_CHUNK' then raise; end if;
    end;
    begin
        perform public.daf_start_log_import(v_id,'cleanup-test.xlsx',v_metadata,2);
        raise exception 'TEST_UNEXPECTED_RESTART';
    exception when others then
        if SQLERRM='TEST_UNEXPECTED_RESTART' then raise; end if;
    end;
    v_id := gen_random_uuid();
    perform public.daf_abort_log_import(v_id);
    begin
        perform public.daf_start_log_import(v_id,'cleanup-test.xlsx',v_metadata,2);
        raise exception 'TEST_UNEXPECTED_DELAYED_START';
    exception when others then
        if SQLERRM='TEST_UNEXPECTED_DELAYED_START' then raise; end if;
    end;
    v_result := public.daf_abort_log_import(v_published);
    if v_result->>'published' <> 'true' then raise exception 'published upload not protected'; end if;
    select md5(string_agg(to_jsonb(w)::text,'' order by candidate_id)) into v_after
    from public.daf_log_winners w;
    if v_before is distinct from v_after then raise exception 'published report data changed'; end if;

    v_id := gen_random_uuid();
    perform public.daf_start_log_import(v_id,'cleanup-test.xlsx',v_metadata,2);
    perform public.daf_stage_log_import_chunk(v_id,'DAF',0,'inactive',v_records);
    update public.daf_log_import_jobs set last_activity_at=now()-interval '25 hours' where id=v_id;
    perform public.daf_prune_failed_log_imports();
    if exists(select 1 from public.daf_log_candidates where job_id=v_id) then
        raise exception 'inactive upload not cleaned'; end if;
    v_id := gen_random_uuid();
    perform public.daf_start_log_import(v_id,'cleanup-test.xlsx',v_metadata,2);
    perform public.daf_stage_log_import_chunk(v_id,'DAF',0,'active',v_records);
    perform public.daf_prune_failed_log_imports();
    if not exists(select 1 from public.daf_log_candidates where job_id=v_id) then
        raise exception 'active upload incorrectly cleaned'; end if;
    if (select count(*) from cron.job where jobname='production-daf-failed-import-cleanup')<>1 then
        raise exception 'cleanup schedule duplicated'; end if;
    raise notice 'PASS: partial cleanup, idempotency, delayed requests, published protection, inactive cleanup, active protection, unique schedule';
end;
$$;
