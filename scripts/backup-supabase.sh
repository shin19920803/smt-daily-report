#!/usr/bin/env bash
set -euo pipefail

# Homebrew's libpq is keg-only on macOS, so pg_dump/pg_restore may not be on PATH.
for pg_bin_dir in /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin /opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin; do
  if [[ -x "$pg_bin_dir/pg_dump" && -x "$pg_bin_dir/pg_restore" ]]; then
    PATH="$pg_bin_dir:$PATH"
    export PATH
    break
  fi
done

if [[ $# -lt 4 || $# -gt 5 ]]; then
  printf '用法：%s <資料庫主機> <連接埠> <資料庫使用者> <既有備份資料夾> [指定備份檔完整路徑]\n' "$0" >&2
  exit 2
fi

for tool in pg_dump pg_restore shasum; do
  command -v "$tool" >/dev/null 2>&1 || {
    printf '找不到必要工具：%s\n' "$tool" >&2
    exit 127
  }
done

pg_host=$1
pg_port=$2
pg_user=$3
backup_dir=$4
pg_database=postgres

[[ "$pg_port" =~ ^[0-9]+$ ]] || { printf '連接埠必須是數字。\n' >&2; exit 2; }
[[ -d "$backup_dir" ]] || { printf '備份資料夾不存在，請先建立：%s\n' "$backup_dir" >&2; exit 2; }

timestamp=$(date '+%Y%m%d-%H%M%S')
if [[ $# -eq 5 ]]; then
  dump_path=$5
  [[ "$(dirname "$dump_path")" == "${backup_dir%/}" ]] || {
    printf '指定備份檔必須位於備份資料夾內：%s\n' "$backup_dir" >&2
    exit 2
  }
else
  dump_path="${backup_dir%/}/smt-production-${timestamp}.dump"
fi
dump_partial_path="${dump_path}.partial.$$.${RANDOM}"
[[ ! -e "$dump_path" && ! -e "$dump_partial_path" ]] || { printf '拒絕覆寫既有備份：%s\n' "$dump_path" >&2; exit 1; }

read -r -s -p 'Supabase Database Password（輸入不會顯示）: ' pg_password
printf '\n'
[[ -n "$pg_password" ]] || { printf '密碼不可空白。\n' >&2; exit 2; }

escape_pgpass_field() {
  local value=${1//\\/\\\\}
  value=${value//:/\\:}
  printf '%s' "$value"
}

umask 077
pgpass_dir=$(mktemp -d "${TMPDIR:-/tmp}/production-pgpass.XXXXXX")
pgpass_file="$pgpass_dir/pgpass"
backup_completed=0
cleanup() {
  unset pg_password PGPASSWORD
  rm -f -- "$pgpass_file"
  rmdir -- "$pgpass_dir" 2>/dev/null || true
  if [[ "$backup_completed" -eq 0 && -e "$dump_partial_path" ]]; then
    printf '備份未完成；部分檔案保留於：%s\n' "$dump_partial_path" >&2
  fi
}
trap cleanup EXIT HUP INT TERM

printf '%s:%s:%s:%s:%s\n' \
  "$(escape_pgpass_field "$pg_host")" \
  "$(escape_pgpass_field "$pg_port")" \
  "$(escape_pgpass_field "$pg_database")" \
  "$(escape_pgpass_field "$pg_user")" \
  "$(escape_pgpass_field "$pg_password")" > "$pgpass_file"
unset pg_password
chmod 600 "$pgpass_file"

export PGPASSFILE="$pgpass_file"
export PGSSLMODE=require
export PGOPTIONS="${PGOPTIONS:--c statement_timeout=0}"
printf '建立完整 PostgreSQL custom-format 備份：%s\n' "$dump_partial_path"
pg_dump --host="$pg_host" --port="$pg_port" --username="$pg_user" \
  --dbname="$pg_database" --format=custom --verbose --file="$dump_partial_path"

pg_restore --list "$dump_partial_path" >/dev/null
pg_restore --exit-on-error --file=/dev/null "$dump_partial_path"
checksum=$(shasum -a 256 "$dump_partial_path" | awk '{print $1}')
mv -- "$dump_partial_path" "$dump_path"
backup_completed=1
printf '%s  %s\n' "$checksum" "$dump_path"
printf '備份完成並通過 archive 清單驗證。\n'
