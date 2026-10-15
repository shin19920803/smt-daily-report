#!/usr/bin/env bash
# 專案資料庫憑證只持久保存在 macOS 鑰匙圈；提供短期 pgpass 給子程序。
set -euo pipefail
[[ $# -gt 0 ]] || { printf '用法：bash %s <psql / pg_dump 等指令與參數>\n' "$0" >&2; exit 2; }
for pg_bin_dir in /opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin; do
  if ! command -v psql >/dev/null 2>&1 && [[ -x "$pg_bin_dir/psql" ]]; then PATH="$pg_bin_dir:$PATH"; fi
done
command -v psql >/dev/null 2>&1 || { printf '找不到 psql。\n' >&2; exit 127; }
command -v security >/dev/null 2>&1 || { printf '需要 macOS 鑰匙圈工具 security。\n' >&2; exit 127; }

export PGHOST=aws-1-ap-south-1.pooler.supabase.com PGPORT=5432
export PGUSER=postgres.ccwkcwriebxipndxkvyr PGDATABASE=postgres PGSSLMODE=require
export PGCONNECT_TIMEOUT=10
# 不沿用外部明文密碼，避免蓋過本次已驗證的 pgpass。
unset PGPASSWORD
credential_service='smt-daily-report:ccwkcwriebxipndxkvyr:postgres'
umask 077
session_dir=$(mktemp -d "${TMPDIR:-/tmp}/production-db-session.XXXXXX")
export PGPASSFILE="$session_dir/pgpass"
export APP_PGPASSFILE="$PGPASSFILE"
cleanup() {
  unset task_password
  rm -f -- "$session_dir/pgpass" "$session_dir/connection.err"
  rmdir -- "$session_dir" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

write_session_credential() {
  escape_pgpass_field() {
    local value=${1//\\/\\\\}
    value=${value//:/\\:}
    printf '%s' "$value"
  }
  printf '%s:%s:%s:%s:%s\n' "$PGHOST" "$PGPORT" "$PGDATABASE" "$PGUSER" \
    "$(escape_pgpass_field "$task_password")" > "$PGPASSFILE"
  unset task_password
}
verify_connection() {
  local result
  if result=$(psql --no-psqlrc --no-password --set=ON_ERROR_STOP=1 -At \
      --command="select current_database()='postgres' and current_user='postgres'" 2>"$session_dir/connection.err"); then
    [[ "$result" == 't' ]] || { printf '連線身分不符，已停止。\n' >&2; return 2; }
    return 0
  fi
  return 1
}

needs_password=0
if task_password=$(security find-generic-password -s "$credential_service" -a "$PGUSER" -w 2>"$session_dir/connection.err"); then
  write_session_credential
  if verify_connection; then
    printf '已使用鑰匙圈憑證驗證 Supabase 連線。\n'
  elif [[ -s "$session_dir/connection.err" ]] && /usr/bin/grep -q 'password authentication failed' "$session_dir/connection.err"; then
    needs_password=1
  else
    /bin/cat "$session_dir/connection.err" >&2
    printf '連線未通過，未執行資料庫修改；保留鑰匙圈憑證。\n' >&2
    exit 3
  fi
else
  credential_status=$?
  if [[ "$credential_status" == 44 ]]; then needs_password=1
  else
    printf '無法存取 macOS 鑰匙圈；未執行資料庫修改。\n' >&2
    exit 3
  fi
fi

if [[ "$needs_password" == 1 ]]; then
  if [[ ! -t 0 ]]; then
    printf '目前沒有有效的專案憑證。請在本機終端機執行本指令一次，完成安全保存。\n' >&2
    exit 3
  fi
  printf '請在接下來的提示輸入 Supabase 資料庫密碼；驗證成功後將由鑰匙圈自動取用。\n'
  # -w 必須為最後一個參數：由 security 原生提示讀取，密碼不出現在 argv。
  security add-generic-password -U -s "$credential_service" -a "$PGUSER" -T /usr/bin/security -w
  task_password=$(security find-generic-password -s "$credential_service" -a "$PGUSER" -w)
  write_session_credential
  if ! verify_connection; then
    /bin/cat "$session_dir/connection.err" >&2
    if /usr/bin/grep -q 'password authentication failed' "$session_dir/connection.err"; then
      security delete-generic-password -s "$credential_service" -a "$PGUSER" >/dev/null 2>&1 || true
      printf '密碼未通過 Supabase 驗證，已移除本次保存的憑證；未執行資料庫修改。\n' >&2
    else
      printf '暫時無法驗證連線，已保留鑰匙圈憑證供下次自動確認；未執行資料庫修改。\n' >&2
    fi
    exit 3
  fi
  printf 'Supabase 連線驗證成功；憑證已安全保存，後續可自動取用。\n'
fi

"$@"
