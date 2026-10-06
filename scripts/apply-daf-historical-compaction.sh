#!/usr/bin/env bash
set -euo pipefail

for pg_bin_dir in /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin /opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin; do
  if [[ -x "$pg_bin_dir/psql" && -x "$pg_bin_dir/pg_restore" ]]; then
    PATH="$pg_bin_dir:$PATH"
    export PATH
    break
  fi
done

if [[ $# -ne 3 ]]; then
  printf '用法：%s <Supabase 主機> <資料庫使用者> <已驗證的完整備份檔>\n' "$0" >&2
  exit 2
fi

for tool in psql pg_restore awk; do
  command -v "$tool" >/dev/null 2>&1 || { printf '找不到必要工具：%s\n' "$tool" >&2; exit 127; }
done

pg_host=$1
pg_user=$2
backup_path=$3
pg_port=5432
pg_database=postgres
migration_path="$(cd "$(dirname "$0")/.." && pwd)/supabase/daf_historical_compaction.sql"
schedule_path="$(cd "$(dirname "$0")/.." && pwd)/supabase/daf_historical_compaction_schedule.sql"

[[ -f "$backup_path" && -s "$backup_path" ]] || { printf '完整備份不存在或為空：%s\n' "$backup_path" >&2; exit 2; }
[[ -f "$migration_path" && -f "$schedule_path" ]] || { printf '找不到封存 SQL 檔案。\n' >&2; exit 2; }
pg_restore --list "$backup_path" >/dev/null || { printf '備份檔無法讀取，拒絕修改線上資料。\n' >&2; exit 2; }
pg_restore --exit-on-error --file=/dev/null "$backup_path" || { printf '備份內容驗證失敗，拒絕修改線上資料。\n' >&2; exit 2; }

read -r -s -p 'Supabase Database Password（輸入不會顯示）: ' pg_password
printf '\n'
[[ -n "$pg_password" ]] || { printf '密碼不可空白。\n' >&2; exit 2; }

escape_pgpass_field() {
  local value=${1//\\/\\\\}
  value=${value//:/\\:}
  printf '%s' "$value"
}

umask 077
pgpass_dir=$(mktemp -d "${TMPDIR:-/tmp}/koya-compact-pgpass.XXXXXX")
pgpass_file="$pgpass_dir/pgpass"
cleanup() {
  unset pg_password PGPASSWORD
  rm -f -- "$pgpass_file"
  rmdir -- "$pgpass_dir" 2>/dev/null || true
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
export PGOPTIONS='-c statement_timeout=0'

psql_exec() {
  psql --no-psqlrc --host="$pg_host" --port="$pg_port" --username="$pg_user" --dbname="$pg_database" "$@"
}

cron_available=$(psql_exec -At -c "select count(*) from pg_available_extensions where name = 'pg_cron'")
if [[ "$cron_available" != "1" ]]; then
  printf 'Supabase 未提供 pg_cron；為避免只刪除而未啟用自動保留，停止執行。\n' >&2
  exit 3
fi

printf '套用資料表與 RPC 相容層（此階段不刪除資料）…\n'
psql_exec -v ON_ERROR_STOP=1 --file="$migration_path"

cutoff=$(psql_exec -At -c "select greatest(coalesce((select cutoff_date from public.daf_log_compaction_state where id = 'current'), (now() at time zone 'Asia/Taipei')::date - 30), (now() at time zone 'Asia/Taipei')::date - 30)::text")
printf '以台灣生產日期計算封存界線：%s（早於界線的日期才精簡）\n' "$cutoff"

preview_sql="select line, candidate_rows, winner_rows, removable_loser_rows, missing_or_invalid_date_rows, receiving_jobs_with_expired_range, projection_mismatch_rows, compacted_winner_rows, dashboard_digest, candidate_table_bytes, winner_table_bytes from public.daf_preview_log_compaction('$cutoff'::date) order by line"
baseline_preview=$(psql_exec -At -F '|' -c "$preview_sql")
line_count=$(printf '%s\n' "$baseline_preview" | awk 'NF { n++ } END { print n+0 }')
if [[ "$line_count" != "5" ]]; then
  printf '預覽未完整回傳五站（%s 站），拒絕封存。\n' "$line_count" >&2
  exit 4
fi

printf '上線前逐站預覽：站別|候選原始列|目前勝出列|重複列|日期無效列|上傳中工作|欄位不一致|已精簡勝出列|候選表位元組|勝出表位元組\n'
printf '%s\n' "$baseline_preview" | awk -F '|' '{ printf "%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n", $1,$2,$3,$4,$5,$6,$7,$8,$10,$11 }'

unsafe=$(printf '%s\n' "$baseline_preview" | awk -F '|' 'NF && ($6+0 != 0 || $7+0 != 0) { print $1 ": receiving=" $6 ", projection_mismatch=" $7 }')
if [[ -n "$unsafe" ]]; then
  printf '發現上傳中工作或 Dashboard 欄位落差，已停止；尚未封存任何原始列：\n%s\n' "$unsafe" >&2
  exit 5
fi

psql_exec -v ON_ERROR_STOP=1 -c 'create extension if not exists pg_cron' >/dev/null
cron_schema=$(psql_exec -At -c "select to_regnamespace('cron') is not null")
if [[ "$cron_schema" != "t" ]]; then
  printf 'pg_cron 未能啟用；拒絕開始刪除資料。\n' >&2
  exit 5
fi

baseline_digests=$(printf '%s\n' "$baseline_preview" | awk -F '|' 'NF { print $1 "|" $9 }')
printf '預檢通過；開始逐批精簡五站超過 30 天的原始明細。\n'

batch_number=1
batch_result=$(psql_exec -At -F '|' -c "select result->>'done', result->>'removed_candidates', result->>'compacted' from (select public.daf_compact_expired_log_batch('$cutoff'::date, 5000) as result) batch")
IFS='|' read -r batch_done batch_removed batch_winners <<< "$batch_result"
printf '批次 %s：刪除候選列 %s，保留精簡勝出列 %s，完成=%s\n' "$batch_number" "$batch_removed" "$batch_winners" "$batch_done"

# Start the durable job after the first verified transaction so it can resume
# compaction automatically if this client disconnects during the initial run.
psql_exec -v ON_ERROR_STOP=1 --file="$schedule_path"

while [[ "$batch_done" != "true" ]]; do
  batch_number=$((batch_number + 1))
  batch_result=$(psql_exec -At -F '|' -c "select result->>'done', result->>'removed_candidates', result->>'compacted' from (select public.daf_compact_expired_log_batch('$cutoff'::date, 5000) as result) batch")
  IFS='|' read -r batch_done batch_removed batch_winners <<< "$batch_result"
  printf '批次 %s：刪除候選列 %s，保留精簡勝出列 %s，完成=%s\n' "$batch_number" "$batch_removed" "$batch_winners" "$batch_done"
done

after_preview=$(psql_exec -At -F '|' -c "$preview_sql")
after_digests=$(printf '%s\n' "$after_preview" | awk -F '|' 'NF { print $1 "|" $9 }')
if [[ "$baseline_digests" != "$after_digests" ]]; then
  printf '封存後 Dashboard 明細指紋與封存前不同；精簡資料仍保留於 compact facts，未安裝自動排程。\n' >&2
  printf '封存前：\n%s\n封存後：\n%s\n' "$baseline_digests" "$after_digests" >&2
  exit 6
fi

printf '五站 Dashboard 明細指紋逐站一致；啟用每分鐘一批的自動精簡及 30 天未配對機台參照清理。\n'
psql_exec -At -F '|' -c "select jobname, schedule, active from cron.job where jobname = 'koya-daf-log-maintenance'"
printf '線上精簡完成；未建立或排程任何備份。\n'
