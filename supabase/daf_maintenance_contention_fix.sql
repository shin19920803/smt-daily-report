-- Keep the minute maintenance job from holding the five process locks for a
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
    -- the next scheduled minute instead.
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

    -- Do only one expensive path on each cron tick. The 3-minute rotation
    -- avoids holding the shared process locks through several maintenance
    -- operations in one transaction.
    v_task := extract(minute from (now() at time zone 'UTC'))::integer % 3;

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

-- Maintenance invokes these functions inside the seven-second wrapper above.
-- Administrative callers retain their own session-level timeout.
alter function public.daf_compact_expired_log_batch(date, integer)
    reset statement_timeout;
alter function public.daf_prune_superseded_log_candidates(integer)
    reset statement_timeout;
alter function public.daf_strip_expired_log_raw_batch(date, integer)
    reset statement_timeout;

notify pgrst, 'reload schema';
commit;
