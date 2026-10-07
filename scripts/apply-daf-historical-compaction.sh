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
  printf '用法：%s <Supabase 主機> <資料庫使用者> <備份檔路徑（用於命名新備份）>\n' "$0" >&2
  exit 2
fi

for tool in psql pg_dump pg_restore awk; do
  command -v "$tool" >/dev/null 2>&1 || { printf '找不到必要工具：%s\n' "$tool" >&2; exit 127; }
done

pg_host=$1
pg_user=$2
backup_hint=$3
pg_port=${KOYA_PGPORT:-5432}
pg_database=postgres
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
migration_path="$repo_root/supabase/daf_historical_compaction.sql"
payload_path="$repo_root/supabase/daf_candidate_payload_slimming.sql"
schedule_path="$repo_root/supabase/daf_historical_compaction_schedule.sql"

[[ -f "$migration_path" && -f "$payload_path" && -f "$schedule_path" ]] || { printf '找不到封存 SQL 檔案。\n' >&2; exit 2; }
backup_dir=$(dirname "$backup_hint")
backup_stem=$(basename "$backup_hint")
backup_stem=${backup_stem%.dump}
[[ -d "$backup_dir" ]] || { printf '備份目錄不存在：%s\n' "$backup_dir" >&2; exit 2; }
backup_path="$backup_dir/${backup_stem}-pre-daf14-$(date '+%Y%m%d-%H%M%S').dump"
[[ ! -e "$backup_path" ]] || { printf '新備份檔已存在，拒絕覆寫：%s\n' "$backup_path" >&2; exit 2; }

pgpass_file=${KOYA_PGPASSFILE:-}
pgpass_owned=0
pgpass_dir=''
if [[ -n "$pgpass_file" ]]; then
  [[ -f "$pgpass_file" && -r "$pgpass_file" ]] || {
    printf '指定的暫存連線憑證無法讀取；拒絕連線。\n' >&2
    exit 2
  }
else
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
  printf '%s:%s:%s:%s:%s\n' \
    "$(escape_pgpass_field "$pg_host")" \
    "$(escape_pgpass_field "$pg_port")" \
    "$(escape_pgpass_field "$pg_database")" \
    "$(escape_pgpass_field "$pg_user")" \
    "$(escape_pgpass_field "$pg_password")" > "$pgpass_file"
  unset pg_password
  chmod 600 "$pgpass_file"
  pgpass_owned=1
fi

cleanup() {
  unset pg_password PGPASSWORD KOYA_PGPASSFILE
  if [[ "$pgpass_owned" -eq 1 ]]; then
    rm -f -- "$pgpass_file"
    rmdir -- "$pgpass_dir" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM

export PGPASSFILE="$pgpass_file"
export PGSSLMODE=require
export PGOPTIONS='-c statement_timeout=0'

psql_exec() {
  psql --no-psqlrc --host="$pg_host" --port="$pg_port" --username="$pg_user" --dbname="$pg_database" "$@"
}

printf '建立即時完整 PostgreSQL 備份：%s\n' "$backup_path"
umask 077
if ! pg_dump --no-password --format=custom --no-owner --no-privileges \
    --host="$pg_host" --port="$pg_port" --username="$pg_user" --dbname="$pg_database" \
    --file="$backup_path"; then
  rm -f -- "$backup_path"
  printf '即時備份失敗；線上資料尚未修改。\n' >&2
  exit 3
fi
chmod 600 "$backup_path"
if [[ ! -s "$backup_path" ]] \
    || ! pg_restore --list "$backup_path" >/dev/null \
    || ! pg_restore --exit-on-error --file=/dev/null "$backup_path"; then
  printf '即時備份讀取／驗證失敗；線上資料尚未修改，保留備份供診斷：%s\n' "$backup_path" >&2
  exit 3
fi
backup_mtime=$(stat -f '%m' "$backup_path")
backup_age=$(($(date +%s) - backup_mtime))
if (( backup_age < 0 || backup_age > 300 )); then
  printf '即時備份時間異常；線上資料尚未修改，拒絕繼續。\n' >&2
  exit 3
fi
printf '即時完整備份驗證通過（%s bytes）。\n' "$(stat -f '%z' "$backup_path")"

cron_available=$(psql_exec -At -c "select count(*) from pg_available_extensions where name = 'pg_cron'")
if [[ "$cron_available" != "1" ]]; then
  printf 'Supabase 未提供 pg_cron；為避免只刪除而未啟用自動保留，停止執行。\n' >&2
  exit 3
fi
receiving_jobs=$(psql_exec -At -c "select count(*) from public.daf_log_import_jobs where status = 'receiving'")
if [[ "$receiving_jobs" != "0" ]]; then
  printf '目前有 %s 個上傳工作進行中；請等上傳完成後重跑，未修改線上資料。\n' "$receiving_jobs" >&2
  exit 3
fi

printf '套用資料表與 RPC 相容層（此階段不刪除資料）…\n'
psql_exec -v ON_ERROR_STOP=1 --file="$migration_path"
printf '安裝精簡寫入與舊資料逐筆還原檢查…\n'
psql_exec -v ON_ERROR_STOP=1 --file="$payload_path"

printf '將可安全還原的舊候選 JSON 分批轉成結構化格式…\n'
slim_after_id=''
slim_batch_number=0
while :; do
  slim_batch_number=$((slim_batch_number + 1))
  slim_result=$(psql_exec -At -v cursor="$slim_after_id" -v batch_size=500 -f - <<'SQL'
select r->>'scanned', r->>'converted', r->>'retained_original',
       coalesce(r->>'next_id',''), r->>'has_more'
from (select public.daf_slim_log_candidates_batch(:'batch_size'::integer, nullif(:'cursor','')) as r) q;
SQL
)
  IFS='|' read -r slim_scanned slim_converted slim_retained slim_after_id slim_has_more <<< "$slim_result"
  if [[ ! "$slim_scanned" =~ ^[0-9]+$ || ! "$slim_converted" =~ ^[0-9]+$ || ! "$slim_retained" =~ ^[0-9]+$ || ! "$slim_has_more" =~ ^(true|false)$ ]]; then
    printf '舊候選精簡批次回傳資料不完整；停止，不宣告成功。\n' >&2
    exit 4
  fi
  printf '舊資料批次 %s：掃描 %s、轉換 %s、保留不安全原格式 %s、尚有後續=%s\n' \
    "$slim_batch_number" "$slim_scanned" "$slim_converted" "$slim_retained" "$slim_has_more"
  [[ "$slim_has_more" == 'true' ]] || break
  [[ "$slim_scanned" -gt 0 && -n "$slim_after_id" ]] || {
    printf '精簡批次游標未前進，停止以避免無限重試。\n' >&2
    exit 4
  }
done

cutoff=$(psql_exec -At -c "select greatest(coalesce((select cutoff_date from public.daf_log_compaction_state where id = 'current'), (now() at time zone 'Asia/Taipei')::date - 30), (now() at time zone 'Asia/Taipei')::date - 30)::text")
printf '以台灣生產日期計算封存界線：%s（早於界線的日期才精簡）\n' "$cutoff"
raw_cutoff=$(psql_exec -At -c "select greatest(coalesce((select raw_cutoff_date from public.daf_log_compaction_state where id = 'current'), (now() at time zone 'Asia/Taipei')::date - 14), (now() at time zone 'Asia/Taipei')::date - 14)::text")
printf '原始欄位清理界線：%s（只移除可由結構化欄位還原的 raw；候選列仍留到 30 天）\n' "$raw_cutoff"

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

raw_preview=$(psql_exec -At -F '|' -c "select line, candidate_raw_rows, safe_candidate_rows, blocked_candidate_rows, candidate_raw_bytes, batch_raw_rows, safe_batch_rows, batch_raw_bytes from public.daf_preview_log_raw_retention('$raw_cutoff'::date) order by line")
raw_line_count=$(printf '%s\n' "$raw_preview" | awk 'NF { n++ } END { print n+0 }')
if [[ "$raw_line_count" != "5" ]]; then
  printf '原始欄位預覽未完整回傳五站；拒絕清理。\n' >&2
  exit 5
fi
printf '原始欄位預覽：站別|候選含 raw|可安全清理|保留待確認|raw 位元組|舊摘要含 raw|可安全清理|raw 位元組\n'
printf '%s\n' "$raw_preview"
blocked_raw=$(printf '%s\n' "$raw_preview" | awk -F '|' '$4+0 > 0 { print $1 ":" $4 " 筆候選因結構化欄位不足保留 raw" }')
if [[ -n "$blocked_raw" ]]; then
  printf '注意：以下候選不符合安全剝除條件，會保留 raw，不影響安全資料先行清理：\n%s\n' "$blocked_raw"
fi

dashboard_preview_sql="select line || '|' || dashboard_digest from public.daf_preview_log_compaction('$raw_cutoff'::date) order by line"
baseline_digests=$(psql_exec -At -c "$dashboard_preview_sql")
dashboard_digest_lines=$(printf '%s\n' "$baseline_digests" | awk 'NF { n++ } END { print n+0 }')
if [[ "$dashboard_digest_lines" != "5" ]]; then
  printf '14 天 Dashboard 基準指紋未完整回傳五站；拒絕清理。\n' >&2
  exit 5
fi

psql_exec -v ON_ERROR_STOP=1 -c 'create extension if not exists pg_cron' >/dev/null
cron_schema=$(psql_exec -At -c "select to_regnamespace('cron') is not null")
if [[ "$cron_schema" != "t" ]]; then
  printf 'pg_cron 未能啟用；拒絕開始刪除資料。\n' >&2
  exit 5
fi

printf '預檢通過；開始逐批精簡五站超過 30 天的原始明細。\n'

batch_number=1
batch_result=$(psql_exec -At -F '|' -c "select result->>'done', result->>'removed_candidates', result->>'compacted' from (select public.daf_compact_expired_log_batch('$cutoff'::date, 5000) as result) batch")
IFS='|' read -r batch_done batch_removed batch_winners <<< "$batch_result"
printf '批次 %s：刪除候選列 %s，保留精簡勝出列 %s，完成=%s\n' "$batch_number" "$batch_removed" "$batch_winners" "$batch_done"

while [[ "$batch_done" != "true" ]]; do
  batch_number=$((batch_number + 1))
  batch_result=$(psql_exec -At -F '|' -c "select result->>'done', result->>'removed_candidates', result->>'compacted' from (select public.daf_compact_expired_log_batch('$cutoff'::date, 5000) as result) batch")
  IFS='|' read -r batch_done batch_removed batch_winners <<< "$batch_result"
  printf '批次 %s：刪除候選列 %s，保留精簡勝出列 %s，完成=%s\n' "$batch_number" "$batch_removed" "$batch_winners" "$batch_done"
done

printf '開始逐批清除超過 14 天且可安全還原的 raw 欄位（不刪除 14–30 天結構化候選）…\n'
raw_batch_number=1
raw_result=$(psql_exec -At -F '|' -c "select result->>'done', result->>'stripped_candidates', result->>'stripped_batch_summaries', result->>'payload_bytes_saved' from (select public.daf_strip_expired_log_raw_batch('$raw_cutoff'::date, 1000) as result) batch")
IFS='|' read -r raw_done raw_candidates raw_summaries raw_bytes <<< "$raw_result"
printf 'raw 批次 %s：候選 %s、舊摘要列 %s、payload 約減少 %s bytes、完成=%s\n' \
  "$raw_batch_number" "$raw_candidates" "$raw_summaries" "$raw_bytes" "$raw_done"
while [[ "$raw_done" != "true" ]]; do
  raw_batch_number=$((raw_batch_number + 1))
  raw_result=$(psql_exec -At -F '|' -c "select result->>'done', result->>'stripped_candidates', result->>'stripped_batch_summaries', result->>'payload_bytes_saved' from (select public.daf_strip_expired_log_raw_batch('$raw_cutoff'::date, 1000) as result) batch")
  IFS='|' read -r raw_done raw_candidates raw_summaries raw_bytes <<< "$raw_result"
  printf 'raw 批次 %s：候選 %s、舊摘要列 %s、payload 約減少 %s bytes、完成=%s\n' \
    "$raw_batch_number" "$raw_candidates" "$raw_summaries" "$raw_bytes" "$raw_done"
done

after_digests=$(psql_exec -At -c "$dashboard_preview_sql")
if [[ "$baseline_digests" != "$after_digests" ]]; then
  psql_exec -v ON_ERROR_STOP=1 -c 'do $$ declare v_job_id bigint; begin for v_job_id in select jobid from cron.job where jobname = '\''koya-daf-log-maintenance'\'' loop perform cron.unschedule(v_job_id); end loop; end; $$;'
  printf '14 天區間 Dashboard 明細指紋與處理前不同；已停止此任務的自動排程，請勿繼續刪除資料。\n' >&2
  printf '封存前：\n%s\n封存後：\n%s\n' "$baseline_digests" "$after_digests" >&2
  exit 6
fi

psql_exec -v ON_ERROR_STOP=1 --file="$schedule_path"
printf '五站 14 天前至歷史 Dashboard 摘要指紋逐站一致；啟用每分鐘一批的 30 天封存、14 天 raw 清理及 30 天未配對機台參照清理。\n'
psql_exec -At -F '|' -c "select jobname, schedule, active from cron.job where jobname = 'koya-daf-log-maintenance'"
printf '線上精簡完成；未建立持續備份排程。\n'
