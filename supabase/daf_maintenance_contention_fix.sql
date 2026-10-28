-- Keep the bounded maintenance job from holding the five process locks for a
-- large compaction or waiting behind an active upload.
begin;

create or replace function public.daf_run_log_maintenance_batch()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '7s'
set lock_timeout = '1s'
as $$
declare
    v_reference_rows integer;
    v_compaction jsonb;
    v_raw_retention jsonb;
    v_cutoff date;
    v_superseded_candidates integer := 0;
    v_task integer;
begin
    -- Never wait behind an upload start. If an upload owns the gate, retry on
    -- the next scheduled run instead.
    if not pg_try_advisory_xact_lock(hashtextextended('daf-upload-maintenance-gate', 92743)) then
        return jsonb_build_object('deferred_reason', 'upload_start_in_progress');
    end if;

    -- A recently-created job may not have uploaded its first chunk yet. Recent
    -- chunk timestamps keep long, active uploads protected from maintenance.
    if exists (
        select 1 from public.daf_log_import_jobs j
        where j.status = 'receiving'
          and (j.created_at >= now() - interval '15 minutes'
               or exists (select 1 from public.daf_log_import_chunks c
                          where c.job_id = j.id
                            and c.created_at >= now() - interval '15 minutes'))
    ) then
        return jsonb_build_object(
            'deferred_reason', 'recent_upload_in_progress', 'compaction', null,
            'deleted_superseded_candidates', 0, 'raw_retention', null);
    end if;

    v_reference_rows := public.daf_prune_expired_machine_references(now());

    -- The cron runs every three minutes and rotates one bounded task each run.
    -- Avoid repeated full cutoff scans every minute while keeping all three
    -- maintenance paths active (each path runs once every nine minutes).
    v_task := floor(extract(epoch from now()) / 180)::integer % 3;

    if v_task = 0 then
      begin
        v_cutoff := public.daf_latest_seven_production_days_cutoff();
        if v_cutoff is null then
            v_compaction := jsonb_build_object('done', true,
                'deferred_reason', '每站尚未累積七個生產日期');
        else
            -- Small batches bound how long the shared process locks are held.
            v_compaction := public.daf_compact_expired_log_batch(v_cutoff, 25);
        end if;
      exception
        when lock_not_available then
            return jsonb_build_object('deleted_machine_reference_rows', v_reference_rows,
                'deferred_reason', 'upload_lock_busy', 'compaction', null,
                'deleted_superseded_candidates', 0, 'raw_retention', null);
        when query_canceled then
            return jsonb_build_object('deleted_machine_reference_rows', v_reference_rows,
                'deferred_reason', 'maintenance_time_budget', 'compaction', null,
                'deleted_superseded_candidates', 0, 'raw_retention', null);
      end;
    elsif v_task = 1 then
      begin
        v_superseded_candidates := public.daf_prune_superseded_log_candidates(25);
      exception
        when lock_not_available then v_superseded_candidates := 0;
        when query_canceled then v_superseded_candidates := 0;
      end;
    else
      begin
        v_cutoff := public.daf_latest_seven_production_days_cutoff();
        v_raw_retention := public.daf_strip_expired_log_raw_batch(
            coalesce(v_cutoff, (now() at time zone 'Asia/Taipei')::date + 1), 25
        );
      exception
        when lock_not_available then
            v_raw_retention := jsonb_build_object('deferred_reason', 'upload_lock_busy',
                'stripped_candidates', 0);
        when query_canceled then
            v_raw_retention := jsonb_build_object('deferred_reason', 'maintenance_time_budget',
                'stripped_candidates', 0);
      end;
    end if;

    return jsonb_build_object(
        'deleted_machine_reference_rows', v_reference_rows,
        'compaction', v_compaction,
        'deleted_superseded_candidates', coalesce(v_superseded_candidates, 0),
        'raw_retention', v_raw_retention,
        'task_slot', v_task
    );
end;
$$;

-- A function-level SET cannot arm the timer for an already-started SELECT.
-- The cron command below sets its real deadline before invoking the wrapper.
-- Administrative callers retain their own session-level timeout.
alter function public.daf_compact_expired_log_batch(date, integer)
    reset statement_timeout;
alter function public.daf_prune_superseded_log_candidates(integer)
    reset statement_timeout;
alter function public.daf_strip_expired_log_raw_batch(date, integer)
    reset statement_timeout;

-- Update the schedule in the same transaction as the rotation interval so a
-- partial deployment cannot pin the worker on one task or run it every minute.
do $$
declare
    v_job_id bigint;
    v_legacy_job_name text := chr(107) || chr(111) || chr(121) || chr(97) || '-daf-log-maintenance';
begin
    if coalesce(current_setting('cron.use_background_workers',true),'off')<>'off' then
        raise exception '排程時限需要 pg_cron libpq 模式，拒絕安裝無法保證時限的排程';
    end if;
    for v_job_id in
        select jobid from cron.job
        where jobname in ('production-daf-log-maintenance', v_legacy_job_name)
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

notify pgrst, 'reload schema';
commit;
