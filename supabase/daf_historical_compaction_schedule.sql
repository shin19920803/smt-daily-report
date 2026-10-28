-- Apply only after the production preview and first dashboard digest comparison pass.
-- This schedules one bounded maintenance batch every three minutes; it does not schedule backups.
create extension if not exists pg_cron;

do $$
declare
    v_job_id bigint;
    v_legacy_job_name text := chr(107) || chr(111) || chr(121) || chr(97) || '-daf-log-maintenance';
begin
    if coalesce(current_setting('cron.use_background_workers',true),'off')<>'off' then
        raise exception '排程時限需要 pg_cron libpq 模式，拒絕安裝無法保證時限的排程';
    end if;
    if not exists (
        select 1 from public.daf_log_compaction_state where id = 'current'
    ) then
        raise exception '先完成線上封存預覽與首次核對，再安裝自動排程';
    end if;

    for v_job_id in
        select jobid from cron.job where jobname in ('production-daf-log-maintenance', v_legacy_job_name)
    loop
        perform cron.unschedule(v_job_id);
    end loop;

    perform cron.schedule(
        'production-daf-log-maintenance',
        '*/3 * * * *',
        'set statement_timeout = ''7s''; set lock_timeout = ''1s''; select public.daf_run_log_maintenance_batch();'
    );
end;
$$;
