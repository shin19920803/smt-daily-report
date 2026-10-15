#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
for pg_bin_dir in /opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin; do
  if [[ -x "$pg_bin_dir/psql" ]]; then PATH="$pg_bin_dir:$PATH"; break; fi
done
command -v psql >/dev/null 2>&1 || { printf '找不到 psql。\n' >&2; exit 127; }
export PGSSLMODE=require
umask 077
report_dir="$repo_root/../smt-daily-report-backups"
mkdir -p -- "$report_dir"
report_path="$report_dir/daf-machine-reference-lock-fix-$(date '+%Y%m%d-%H%M%S').log"
# 密碼僅由 psql 的 Password 提示讀取，不放進指令、日誌或檔案。
psql --no-psqlrc --password --set=ON_ERROR_STOP=1 \
  --host=aws-1-ap-south-1.pooler.supabase.com --port=5432 \
  --username=postgres.ccwkcwriebxipndxkvyr --dbname=postgres \
  --file="$repo_root/supabase/daf_machine_reference_lock_fix.sql" | tee "$report_path"
printf '機台參照鎖定修正完成；驗證紀錄：%s\n' "$report_path" | tee -a "$report_path"
