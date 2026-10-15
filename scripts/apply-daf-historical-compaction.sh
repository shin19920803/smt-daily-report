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
legacy_namespace=$'\x6b\x6f\x79\x61'
legacy_namespace_upper=$(printf '%s' "$legacy_namespace" | tr '[:lower:]' '[:upper:]')
failed_import_cleanup_job="${legacy_namespace}-daf-failed-import-cleanup"
legacy_port_var="${legacy_namespace_upper}_PGPORT"
legacy_passfile_var="${legacy_namespace_upper}_PGPASSFILE"
pg_port=${APP_PGPORT:-${!legacy_port_var:-5432}}
pg_database=postgres
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
migration_path="$repo_root/supabase/daf_historical_compaction.sql"
payload_path="$repo_root/supabase/daf_candidate_payload_slimming.sql"
aggregate_path="$repo_root/supabase/daf_aggregate_history.sql"
schedule_path="$repo_root/supabase/daf_historical_compaction_schedule.sql"
machine_index_path="$repo_root/supabase/daf_machine_reference_lock_fix.sql"
reuse_backup_path=${APP_REUSE_VALIDATED_BACKUP:-}
cron_paused=0
cron_schedule_updated=0
cron_original_jobs=''

[[ -f "$migration_path" && -f "$payload_path" && -f "$aggregate_path" && -f "$schedule_path" && -f "$machine_index_path" ]] || { printf '找不到封存 SQL 檔案。\n' >&2; exit 2; }
backup_dir=$(dirname "$backup_hint")
backup_stem=$(basename "$backup_hint")
backup_stem=${backup_stem%.dump}
[[ -d "$backup_dir" ]] || { printf '備份目錄不存在：%s\n' "$backup_dir" >&2; exit 2; }
if [[ -n "$reuse_backup_path" ]]; then
  backup_path=$reuse_backup_path
  [[ -f "$backup_path" && -s "$backup_path" ]] || { printf '指定的既有驗證備份不存在或為空，拒絕繼續。\n' >&2; exit 2; }
else
  backup_path="$backup_dir/${backup_stem}-pre-daf-seven-production-days-$(date '+%Y%m%d-%H%M%S').dump"
  [[ ! -e "$backup_path" ]] || { printf '新備份檔已存在，拒絕覆寫：%s\n' "$backup_path" >&2; exit 2; }
fi

pgpass_file=${APP_PGPASSFILE:-${!legacy_passfile_var:-}}
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
  pgpass_dir=$(mktemp -d "${TMPDIR:-/tmp}/production-compact-pgpass.XXXXXX")
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
  if [[ "$cron_paused" == 1 ]]; then
    restore_cron_jobs || printf '警告：自動維護排程未能自動恢復，需立即檢查 cron.job。\n' >&2
  fi
  unset pg_password PGPASSWORD APP_PGPASSFILE
  unset "$legacy_passfile_var"
  if [[ "$pgpass_owned" -eq 1 ]]; then
    rm -f -- "$pgpass_file"
    rmdir -- "$pgpass_dir" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

export PGPASSFILE="$pgpass_file"
export PGSSLMODE=require
export PGOPTIONS='-c statement_timeout=0 -c idle_in_transaction_session_timeout=0'

psql_exec() {
  psql --no-psqlrc --host="$pg_host" --port="$pg_port" --username="$pg_user" --dbname="$pg_database" "$@"
}

restore_cron_jobs() {
  [[ "$cron_paused" == 1 ]] || return 0
  while IFS='|' read -r saved_job_name saved_schedule saved_command; do
    [[ -n "$saved_job_name" ]] || continue
    if [[ "$cron_schedule_updated" == 1 && "$saved_job_name" != "$failed_import_cleanup_job" ]]; then
      continue
    fi
    saved_job_exists=$(psql_exec -At -v job_name="$saved_job_name" -f - <<'SQL'
select count(*) from cron.job where jobname = :'job_name';
SQL
    ) || return 1
    if [[ "$saved_job_exists" != 0 ]]; then
      psql_exec -v ON_ERROR_STOP=1 -v job_name="$saved_job_name" -f - >/dev/null <<'SQL' || return 1
select cron.unschedule(jobid) from cron.job where jobname = :'job_name';
SQL
    fi
    psql_exec -v ON_ERROR_STOP=1 -v job_name="$saved_job_name" \
      -v job_schedule="$saved_schedule" -v job_command="$saved_command" -f - >/dev/null <<'SQL' || return 1
select cron.schedule(:'job_name', :'job_schedule', :'job_command');
SQL
  done <<< "$cron_original_jobs"
  cron_paused=0
}

if [[ -n "$reuse_backup_path" ]]; then
  printf '重用最近建立的完整備份並重新驗證：%s\n' "$backup_path"
  if [[ ! -s "$backup_path" ]] \
      || ! pg_restore --list "$backup_path" >/dev/null \
      || ! pg_restore --exit-on-error --file=/dev/null "$backup_path"; then
    printf '既有備份讀取／驗證失敗；線上資料尚未修改。\n' >&2
    exit 3
  fi
else
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
fi
backup_mtime=$(stat -f '%m' "$backup_path")
backup_age=$(($(date +%s) - backup_mtime))
if (( backup_age < 0 )); then
  printf '即時備份時間異常；線上資料尚未修改，拒絕繼續。\n' >&2
  exit 3
fi
if [[ -n "$reuse_backup_path" ]]; then
  (( backup_age <= 3600 )) || { printf '既有備份超過一小時，拒絕重用。\n' >&2; exit 3; }
else
  (( backup_age <= 300 )) || { printf '即時備份時間異常；線上資料尚未修改，拒絕繼續。\n' >&2; exit 3; }
fi
if [[ -n "$reuse_backup_path" ]]; then
  backup_latest_job=$(psql_exec -At -c "select coalesce(extract(epoch from max(created_at))::bigint, 0) from public.daf_log_import_jobs")
  if [[ ! "$backup_latest_job" =~ ^[0-9]+$ ]] || (( backup_latest_job > backup_mtime )); then
    printf '備份建立後已有新的 LOG 上傳工作；拒絕重用舊備份。\n' >&2
    exit 3
  fi
fi
printf '完整備份驗證通過（%s bytes）。\n' "$(stat -f '%z' "$backup_path")"

size_report_sql="select 'database|' || pg_database_size(current_database()) || '|0|0|' || pg_database_size(current_database()) union all select c.relname || '|' || pg_relation_size(c.oid) || '|' || coalesce(pg_total_relation_size(c.reltoastrelid), 0) || '|' || pg_indexes_size(c.oid) || '|' || pg_total_relation_size(c.oid) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p') and c.relname in ('daf_log_candidates','daf_log_winners','daf_log_compact_facts','daf_log_compact_groups','daf_log_compact_e_keys','daf_log_batches','daf_log_import_jobs','daf_log_import_chunks','daf_log_active_file_processes','daf_log_compacted_files','daf_log_compaction_state') order by 1"
size_before=$(psql_exec -At -F '|' -c "$size_report_sql")
printf '線上資料庫／相關資料表精簡前空間（bytes；database 為整庫，資料表欄位為 heap|TOAST|indexes|total）：\n%s\n' "$size_before"

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

cron_original_jobs=$(psql_exec -At -F '|' -c "select jobname,schedule,command from cron.job where jobname in ('production-daf-log-maintenance', chr(107)||chr(111)||chr(121)||chr(97)||'-daf-log-maintenance', chr(107)||chr(111)||chr(121)||chr(97)||'-daf-failed-import-cleanup') and active order by jobname,jobid")
cron_paused=1
psql_exec -v ON_ERROR_STOP=1 -c "select cron.unschedule(jobid) from cron.job where jobname in ('production-daf-log-maintenance', chr(107)||chr(111)||chr(121)||chr(97)||'-daf-log-maintenance', chr(107)||chr(111)||chr(121)||chr(97)||'-daf-failed-import-cleanup') and active" >/dev/null
printf '暫停五大製程背景維護／失敗工作清理，等待正在執行的工作完成…\n'
cron_active_jobs=1
for attempt in $(seq 1 60); do
  cron_active_jobs=$(psql_exec -At -c "select count(*) from pg_stat_activity where application_name='pg_cron' and datname=current_database() and state in ('active','idle in transaction') and (query like '%daf_run_log_maintenance_batch%' or query like '%daf_prune_failed_log_imports%')")
  [[ "$cron_active_jobs" == 0 ]] && break
  sleep 1
done
if [[ "$cron_active_jobs" != 0 ]]; then
  printf '背景維護未能在 60 秒內排空；停止並恢復原排程，未開始精簡。\n' >&2
  exit 3
fi

printf '套用資料表與 RPC 相容層（此階段不刪除資料）…\n'
psql_exec -v ON_ERROR_STOP=1 --file="$migration_path"
printf '套用加權歷史摘要相容層（逐批搬移前仍同時讀取舊表）…\n'
psql_exec -v ON_ERROR_STOP=1 --file="$payload_path"
psql_exec -v ON_ERROR_STOP=1 --file="$aggregate_path"
printf '套用機台分類索引查詢修正並移除不再需要的表達式索引…\n'
psql_exec -v ON_ERROR_STOP=1 --file="$machine_index_path"

cutoff=$(psql_exec -At -c "select public.daf_latest_seven_production_days_cutoff()::text")
if [[ ! "$cutoff" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  printf '至少一站尚未累積七個有效生產日期；已完成相容層安裝，未啟用刪除政策。\n' >&2
  exit 5
fi
raw_cutoff=$cutoff
printf '最近七個實際生產日期的封存／raw 清理界線：%s（台灣日期、只處理嚴格早於界線的資料）\n' "$cutoff"

dashboard_preview_sql="select line || '|' || dashboard_digest from public.daf_compact_dashboard_digest(null) order by line"
baseline_digests=$(psql_exec -At -c "$dashboard_preview_sql")
dashboard_digest_lines=$(printf '%s\n' "$baseline_digests" | awk 'NF { n++ } END { print n+0 }')
if [[ "$dashboard_digest_lines" != "5" ]]; then
  printf '修改前 Dashboard 基準指紋未完整回傳五站；拒絕繼續。\n' >&2
  exit 5
fi
summary_digest_sql="with processes(line) as (values ('DAF'), ('FT1'), ('FT2'), ('LIGHTING'), ('ASSEMBLY')) select p.line || '|' || md5(coalesce(string_agg(md5((to_jsonb(b) - 'records')::text), '' order by b.id), '')) from processes p left join public.daf_log_batches b on b.line = p.line group by p.line order by p.line"
baseline_summary_digests=$(psql_exec -At -c "$summary_digest_sql")

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

slimmed_digests=$(psql_exec -At -c "$dashboard_preview_sql")
slimmed_summary_digests=$(psql_exec -At -c "$summary_digest_sql")
if [[ "$baseline_digests" != "$slimmed_digests" || "$baseline_summary_digests" != "$slimmed_summary_digests" ]]; then
  printf '結構化轉換前後的 Dashboard 或每日報工摘要指紋不同；尚未啟用七個生產日期政策，停止。\n' >&2
  exit 5
fi

printf '逐批把歷史逐筆事實轉成加權摘要與最小 E 欄索引（每批核對成功才刪舊列）…\n'
aggregate_batch_number=0
while :; do
  aggregate_batch_number=$((aggregate_batch_number + 1))
  aggregate_result=$(psql_exec -At -F '|' -c "select r->>'scanned',r->>'moved',r->>'keys',r->>'done' from (select public.daf_migrate_compact_fact_batch(5000) r) q")
  IFS='|' read -r aggregate_scanned aggregate_moved aggregate_keys aggregate_done <<< "$aggregate_result"
  if [[ ! "$aggregate_scanned" =~ ^[0-9]+$ || ! "$aggregate_moved" =~ ^[0-9]+$ || ! "$aggregate_keys" =~ ^[0-9]+$ || ! "$aggregate_done" =~ ^(true|false)$ ]]; then
    printf '歷史加權搬移批次回傳資料不完整；停止，不宣告成功。\n' >&2
    exit 4
  fi
  printf '歷史批次 %s：搬移 %s 列、E 欄鍵 %s、完成=%s\n' "$aggregate_batch_number" "$aggregate_moved" "$aggregate_keys" "$aggregate_done"
  [[ "$aggregate_done" == true ]] && break
  [[ "$aggregate_scanned" -gt 0 ]] || { printf '歷史批次未前進，停止以避免無限重試。\n' >&2; exit 4; }
  (( aggregate_batch_number < 1000 )) || { printf '歷史批次超過安全上限，停止。\n' >&2; exit 4; }
done
aggregate_digests=$(psql_exec -At -c "$dashboard_preview_sql")
aggregate_summary_digests=$(psql_exec -At -c "$summary_digest_sql")
if [[ "$baseline_digests" != "$aggregate_digests" || "$baseline_summary_digests" != "$aggregate_summary_digests" ]]; then
  printf '歷史逐筆轉加權摘要前後 Dashboard 或每日報工指紋不同；停止所有後續清理。\n' >&2
  printf '搬移前：\n%s\n搬移後：\n%s\n' "$baseline_digests" "$aggregate_digests" >&2
  exit 5
fi

preview_sql="select line, candidate_rows, winner_rows, removable_loser_rows, missing_or_invalid_date_rows, receiving_jobs_with_expired_range, projection_mismatch_rows, compacted_winner_rows, dashboard_digest, candidate_table_bytes, winner_table_bytes from public.daf_preview_log_compaction('$cutoff'::date) order by line"
baseline_preview=$(psql_exec -At -F '|' -c "$preview_sql")
line_count=$(printf '%s\n' "$baseline_preview" | awk 'NF { n++ } END { print n+0 }')
if [[ "$line_count" != "5" ]]; then
  printf '預覽未完整回傳五站（%s 站），拒絕封存。\n' "$line_count" >&2
  exit 4
fi

printf '上線前逐站預覽：站別|候選原始列|目前勝出列|重複列|日期無效列|上傳中工作|欄位不一致|已精簡勝出列|候選表位元組|勝出表位元組\n'
printf '%s\n' "$baseline_preview" | awk -F '|' '{ printf "%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n", $1,$2,$3,$4,$5,$6,$7,$8,$10,$11 }'

unsafe=$(printf '%s\n' "$baseline_preview" | awk -F '|' 'NF && $6+0 != 0 { print $1 ": receiving=" $6 }')
if [[ -n "$unsafe" ]]; then
  printf '發現涵蓋封存界線以前的上傳中工作，已停止；尚未啟用新保留政策：\n%s\n' "$unsafe" >&2
  exit 5
fi
unresolved=$(printf '%s\n' "$baseline_preview" | awk -F '|' 'NF && $7+0 > 0 { print $1 ": " $7 " 筆保留完整 raw 的未解析勝出資料" }')
if [[ -n "$unresolved" ]]; then
  printf '以下少數欄位不一致資料會完整保留原候選與 raw，封存檔案仍會鎖定不可覆蓋／刪除：\n%s\n' "$unresolved"
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

psql_exec -v ON_ERROR_STOP=1 -c 'create extension if not exists pg_cron' >/dev/null
cron_schema=$(psql_exec -At -c "select to_regnamespace('cron') is not null")
if [[ "$cron_schema" != "t" ]]; then
  printf 'pg_cron 未能啟用；拒絕開始刪除資料。\n' >&2
  exit 5
fi

printf '預檢通過；在鎖定五站且確認沒有上傳中工作後，啟用七個實際生產日期界線…\n'
policy_result=$(psql_exec -At -c "select public.daf_activate_seven_production_days_retention()")
printf '保留政策：%s\n' "$policy_result"
cutoff=$(psql_exec -At -c "select cutoff_date::text from public.daf_log_compaction_state where id = 'current'")

printf '清除已被新版本取代、沒有勝出引用且非目前作用中檔案的候選列…\n'
prune_batch_number=0
while :; do
  prune_batch_number=$((prune_batch_number + 1))
  pruned=$(psql_exec -At -c "select public.daf_prune_superseded_log_candidates(5000)")
  [[ "$pruned" =~ ^[0-9]+$ ]] || { printf '候選清理回傳無效筆數，停止。\n' >&2; exit 4; }
  printf '取代候選清理批次 %s：移除 %s 列\n' "$prune_batch_number" "$pruned"
  [[ "$pruned" -gt 0 ]] || break
  (( prune_batch_number < 1000 )) || { printf '取代候選清理超過安全批次上限，停止。\n' >&2; exit 4; }
done

raw_preview=$(psql_exec -At -F '|' -c "select line, candidate_raw_rows, safe_candidate_rows, blocked_candidate_rows, candidate_raw_bytes, batch_raw_rows, safe_batch_rows, batch_raw_bytes from public.daf_preview_log_raw_retention('$raw_cutoff'::date) order by line")
raw_line_count=$(printf '%s\n' "$raw_preview" | awk 'NF { n++ } END { print n+0 }')
if [[ "$raw_line_count" != "5" ]]; then
  printf '啟用後的原始欄位預覽未完整回傳五站；停止後續清理。\n' >&2
  exit 5
fi
printf '啟用後原始欄位預覽：站別|候選含 raw|可安全清理|保留待確認|raw 位元組|舊摘要含 raw|可安全清理|raw 位元組\n'
printf '%s\n' "$raw_preview"

printf '開始逐批封存五站早於七個生產日期界線的可還原資料；無法確認的原始列會保留。\n'

batch_number=1
batch_result=$(psql_exec -At -F '|' -c "select result->>'done', result->>'removed_candidates', result->>'compacted', result->>'deferred_unresolved_rows' from (select public.daf_compact_expired_log_batch('$cutoff'::date, 5000) as result) batch")
IFS='|' read -r batch_done batch_removed batch_winners batch_unresolved <<< "$batch_result"
printf '批次 %s：移除候選列 %s、封存勝出列 %s、未解析保留 %s、完成=%s\n' "$batch_number" "$batch_removed" "$batch_winners" "$batch_unresolved" "$batch_done"

while [[ "$batch_done" != "true" ]]; do
  batch_number=$((batch_number + 1))
  batch_result=$(psql_exec -At -F '|' -c "select result->>'done', result->>'removed_candidates', result->>'compacted', result->>'deferred_unresolved_rows' from (select public.daf_compact_expired_log_batch('$cutoff'::date, 5000) as result) batch")
  IFS='|' read -r batch_done batch_removed batch_winners batch_unresolved <<< "$batch_result"
  printf '批次 %s：移除候選列 %s、封存勝出列 %s、未解析保留 %s、完成=%s\n' "$batch_number" "$batch_removed" "$batch_winners" "$batch_unresolved" "$batch_done"
done

printf '逐批移除可由結構化欄位還原的冗餘 raw 欄位；未解析列保留 raw…\n'
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
after_summary_digests=$(psql_exec -At -c "$summary_digest_sql")
if [[ "$baseline_digests" != "$after_digests" || "$baseline_summary_digests" != "$after_summary_digests" ]]; then
  psql_exec -v ON_ERROR_STOP=1 -c "do \$\$ declare v_job_id bigint; begin for v_job_id in select jobid from cron.job where jobname in ('production-daf-log-maintenance', chr(107)||chr(111)||chr(121)||chr(97)||'-daf-log-maintenance') loop perform cron.unschedule(v_job_id); end loop; end; \$\$;"
  printf '五站 Dashboard 或每日報工摘要指紋與處理前不同；已停止此任務的自動排程，請勿繼續清理。\n' >&2
  printf 'Dashboard 封存前：\n%s\n封存後：\n%s\n報工摘要封存前：\n%s\n封存後：\n%s\n' \
    "$baseline_digests" "$after_digests" "$baseline_summary_digests" "$after_summary_digests" >&2
  exit 6
fi

printf '更新精簡相關資料表統計並回收可重用頁面（不保證縮小配置容量）…\n'
psql_exec -v ON_ERROR_STOP=1 -c 'vacuum (analyze) public.daf_log_candidates'
psql_exec -v ON_ERROR_STOP=1 -c 'vacuum (analyze) public.daf_log_batches'
psql_exec -v ON_ERROR_STOP=1 -c 'vacuum (analyze) public.daf_log_compact_facts'
psql_exec -v ON_ERROR_STOP=1 -c 'vacuum (analyze) public.daf_log_compact_groups'
psql_exec -v ON_ERROR_STOP=1 -c 'vacuum (analyze) public.daf_log_compact_e_keys'
facts_rows=$(psql_exec -At -c 'select count(*) from public.daf_log_compact_facts')
if [[ "$facts_rows" == "0" ]]; then
  printf '歷史 facts 表為空；重建其索引以回收舊索引膨脹空間…\n'
  psql_exec -v ON_ERROR_STOP=1 -c "set lock_timeout = '5s'; reindex table public.daf_log_compact_facts"
else
  printf '歷史 facts 表仍有 %s 列，保留索引並跳過空表索引回收。\n' "$facts_rows"
fi
size_after=$(psql_exec -At -F '|' -c "$size_report_sql")
printf '線上資料庫／相關資料表精簡後空間（bytes；database 為整庫，資料表欄位為 heap|TOAST|indexes|total）：\n%s\n' "$size_after"

psql_exec -v ON_ERROR_STOP=1 --file="$schedule_path"
cron_schedule_updated=1
restore_cron_jobs
printf '五站全日期 Dashboard 與報工摘要指紋逐站一致；已啟用最近七個實際生產日期保留、候選去重清理、冗餘 raw 移除及 30 天未匹配機台參照清理。\n'
psql_exec -At -F '|' -c "select jobname, schedule, active from cron.job where jobname = 'production-daf-log-maintenance'"
before_database_bytes=$(printf '%s\n' "$size_before" | awk -F '|' '$1=="database" {print $2}')
after_database_bytes=$(printf '%s\n' "$size_after" | awk -F '|' '$1=="database" {print $2}')
if (( after_database_bytes >= before_database_bytes )); then
  printf '資料封存與報表核對完成；實體容量尚未縮減（%s → %s bytes）。需另執行已驗證的 reclaim-daf-storage.sh，不能把本次視為容量回收成功。\n' "$before_database_bytes" "$after_database_bytes"
else
  printf '資料封存與報表核對完成；整庫實測減少 %s bytes。\n' "$((before_database_bytes-after_database_bytes))"
fi
printf '未建立持續備份排程。\n'
