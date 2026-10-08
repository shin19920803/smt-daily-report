-- Apply only after the production preview and first dashboard digest comparison pass.
-- This schedules one compaction batch per minute; it does not schedule backups.
create extension if not exists pg_cron;

do $$
declare
    v_job_id bigint;
    v_legacy_job_name text := chr(107) || chr(111) || chr(121) || chr(97) || '-daf-log-maintenance';
begin
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
        '*/1 * * * *',
        'select public.daf_run_log_maintenance_batch();'
    );
end;
$$;
