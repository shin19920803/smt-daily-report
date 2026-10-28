-- Fix existing jobs in place. Never touch production data, auth, retention,
-- job schedules or active flags. No costly backfill/VACUUM/schema reload.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '10s';
do $$
declare
    v_job record;
    v_task text;
    v_main_jobs integer := 0;
    v_cleanup_jobs integer := 0;
    v_prefix text := chr(107)||chr(111)||chr(121)||chr(97);
begin
    -- pg_cron's background-worker executor arms its timer before parsing the
    -- entire command string. A SET prefix alone is not sufficient in that mode.
    if coalesce(current_setting('cron.use_background_workers',true),'off')<>'off' then
        raise exception '此修正僅適用 pg_cron libpq 模式；背景工作模式需另外設定啟動前時限，未修改排程';
    end if;
    for v_job in select jobid,jobname,command from cron.job
        where jobname in ('production-daf-log-maintenance','production-daf-failed-import-cleanup',
            v_prefix||'-daf-log-maintenance',v_prefix||'-daf-failed-import-cleanup')
        order by jobid
    loop
        if v_job.jobname in ('production-daf-log-maintenance',v_prefix||'-daf-log-maintenance') then
            v_task := 'daf_run_log_maintenance_batch';
            v_main_jobs := v_main_jobs+1;
        else
            v_task := 'daf_prune_failed_log_imports';
            v_cleanup_jobs := v_cleanup_jobs+1;
        end if;
        if lower(btrim(v_job.command)) not in (
            'select public.'||v_task||'();',
            'set statement_timeout = ''7s''; set lock_timeout = ''1s''; select public.'||v_task||'();'
        ) then
            raise exception '排程 % 的指令與預期不符，拒絕覆蓋',v_job.jobname;
        end if;
        perform cron.alter_job(v_job.jobid,
            command := 'set statement_timeout = ''7s''; set lock_timeout = ''1s''; select public.'||v_task||'();');
    end loop;
    if v_main_jobs<>1 or v_cleanup_jobs<>1 then
        raise exception '維護排程缺少或重複（maintenance %, cleanup %），已回滾',v_main_jobs,v_cleanup_jobs;
    end if;
end;
$$;
commit;
