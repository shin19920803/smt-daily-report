#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
db_wrapper="$repo_root/scripts/with-supabase-db.sh"
backup_dir="$repo_root/../smt-daily-report-backups"
mkdir -p -- "$backup_dir"
timestamp=$(date '+%Y%m%d-%H%M%S')
backup_path="$backup_dir/smt-daf-upload-fix-pre-$timestamp.dump"

[[ ! -e "$backup_path" ]] || { printf '拒絕覆寫既有備份：%s\n' "$backup_path" >&2; exit 1; }
printf '建立線上資料庫回復備份：%s\n' "$backup_path"
bash "$db_wrapper" pg_dump --no-password --format=custom --file="$backup_path"
pg_restore --list "$backup_path" >/dev/null
pg_restore --exit-on-error --file=/dev/null "$backup_path"
printf '備份封存檢查通過。\n'

bash "$db_wrapper" psql --no-psqlrc --no-password --set=ON_ERROR_STOP=1 \
  --file="$repo_root/supabase/daf_upload_contention_fix.sql" \
  --file="$repo_root/supabase/daf_maintenance_contention_fix.sql" \
  --file="$repo_root/supabase/daf_finalize_plan_fix.sql"

bash "$db_wrapper" psql --no-psqlrc --no-password --set=ON_ERROR_STOP=1 --set=QUIET=1 \
  --command="do \$\$ begin
    if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='daf_log_import_jobs' and column_name='raw_retention_cutoff') then
      raise exception 'missing import cutoff snapshot column';
    end if;
    if not exists (select 1 from pg_proc where oid='public.daf_start_log_import(uuid,text,jsonb,integer)'::regprocedure and proconfig @> array['statement_timeout=55s','lock_timeout=45s']) then
      raise exception 'start RPC timeout configuration not installed';
    end if;
    if not exists (select 1 from pg_proc where oid='public.daf_stage_log_import_chunk(uuid,text,integer,text,jsonb)'::regprocedure and proconfig @> array['statement_timeout=55s','lock_timeout=7s']) then
      raise exception 'stage RPC timeout configuration not installed';
    end if;
    if not exists (select 1 from pg_proc where oid='public.daf_run_log_maintenance_batch()'::regprocedure and proconfig @> array['statement_timeout=7s','lock_timeout=1s']) then
      raise exception 'bounded maintenance timeout configuration not installed';
    end if;
    if not exists (select 1 from pg_proc where oid='public.dashboard_require_session()'::regprocedure and prosrc like '%/rpc/daf_finalize_log_import%' and prosrc like '%set_config(''statement_timeout'', ''60s'', true)%' and prosrc like '%dashboard_private.current_account_id()%' and prosrc like '%PT401%') then
      raise exception 'upload RPC pre-request timeout not installed';
    end if;
    if not exists (select 1 from pg_roles where rolname='authenticator' and rolconfig @> array['pgrst.db_pre_request=public.dashboard_require_session']) then
      raise exception 'existing dashboard pre-request hook is not active';
    end if;
    if not exists (select 1 from pg_roles where rolname='authenticator' and rolconfig @> array['statement_timeout=8s']) then
      raise exception 'global authenticator timeout unexpectedly changed';
    end if;
    if (select count(*) from cron.job where jobname='production-daf-log-maintenance' and active) <> 1 then
      raise exception 'maintenance schedule missing or duplicated';
    end if;
    if not exists (select 1 from cron.job where jobname='production-daf-log-maintenance' and active
      and command='set statement_timeout = ''7s''; set lock_timeout = ''1s''; select public.daf_run_log_maintenance_batch();') then
      raise exception 'maintenance deadline must be set before the SELECT, not only inside the function';
    end if;
  end \$\$;"

printf 'DAF 上傳逾時修正與線上設定驗證完成。\n備份：%s\n' "$backup_path"
