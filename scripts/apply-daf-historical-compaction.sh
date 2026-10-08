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
aggregate_path="$repo_root/supabase/daf_aggregate_history.sql"
schedule_path="$repo_root/supabase/daf_historical_compaction_schedule.sql"

[[ -f "$migration_path" && -f "$payload_path" && -f "$aggregate_path" && -f "$schedule_path" ]] || { printf '找不到封存 SQL 檔案。\n' >&2; exit 2; }
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

printf '套用資料表與 RPC 相容層（此階段不刪除資料）…\n'
psql_exec -v ON_ERROR_STOP=1 --file="$migration_path"
printf '套用加權歷史摘要相容層（逐批搬移前仍同時讀取舊表）…\n'
psql_exec -v ON_ERROR_STOP=1 --file="$payload_path"
psql_exec -v ON_ERROR_STOP=1 --file="$aggregate_path"

cutoff=$(psql_exec -At -c "select greatest(coalesce((select cutoff_date from public.daf_log_compaction_state where id = 'current'), (now() at time zone 'Asia/Taipei')::date - 14), (now() at time zone 'Asia/Taipei')::date - 14)::text")
raw_cutoff=$(psql_exec -At -c "select (now() at time zone 'Asia/Taipei')::date + 1")
printf '14 天候選封存界線：%s；結構化資料可去除 raw 的界線：%s（台灣日期、嚴格早於界線）\n' "$cutoff" "$raw_cutoff"

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
  printf '結構化轉換前後的 Dashboard 或每日報工摘要指紋不同；尚未啟用 14 天政策，停止。\n' >&2
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
  printf '發現涵蓋 14 天界線以前的上傳中工作，已停止；尚未啟用新保留政策：\n%s\n' "$unsafe" >&2
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

printf '預檢通過；在鎖定五站且確認沒有上傳中工作後，啟用 14 天界線…\n'
policy_result=$(psql_exec -At -c "select public.daf_activate_14_day_candidate_retention()")
printf '保留政策：%s\n' "$policy_result"

raw_preview=$(psql_exec -At -F '|' -c "select line, candidate_raw_rows, safe_candidate_rows, blocked_candidate_rows, candidate_raw_bytes, batch_raw_rows, safe_batch_rows, batch_raw_bytes from public.daf_preview_log_raw_retention('$raw_cutoff'::date) order by line")
raw_line_count=$(printf '%s\n' "$raw_preview" | awk 'NF { n++ } END { print n+0 }')
if [[ "$raw_line_count" != "5" ]]; then
  printf '啟用 14 天後的原始欄位預覽未完整回傳五站；停止後續清理。\n' >&2
  exit 5
fi
printf '啟用後原始欄位預覽：站別|候選含 raw|可安全清理|保留待確認|raw 位元組|舊摘要含 raw|可安全清理|raw 位元組\n'
printf '%s\n' "$raw_preview"

printf '開始逐批封存五站早於 14 天界線的可還原資料；無法確認的原始列會保留。\n'

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

printf '逐批移除可由結構化欄位還原的重複 raw 欄位（包含 14 天內資料）；未解析列保留 raw…\n'
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
  psql_exec -v ON_ERROR_STOP=1 -c 'do $$ declare v_job_id bigint; begin for v_job_id in select jobid from cron.job where jobname = '\''koya-daf-log-maintenance'\'' loop perform cron.unschedule(v_job_id); end loop; end; $$;'
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
size_after=$(psql_exec -At -F '|' -c "$size_report_sql")
printf '線上資料庫／相關資料表精簡後空間（bytes；database 為整庫，資料表欄位為 heap|TOAST|indexes|total）：\n%s\n' "$size_after"

psql_exec -v ON_ERROR_STOP=1 --file="$schedule_path"
printf '五站全日期 Dashboard 與報工摘要指紋逐站一致；已啟用 14 天候選封存、raw 去重及 30 天未匹配機台參照清理。\n'
psql_exec -At -F '|' -c "select jobname, schedule, active from cron.job where jobname = 'koya-daf-log-maintenance'"
before_database_bytes=$(printf '%s\n' "$size_before" | awk -F '|' '$1=="database" {print $2}')
after_database_bytes=$(printf '%s\n' "$size_after" | awk -F '|' '$1=="database" {print $2}')
if (( after_database_bytes >= before_database_bytes )); then
  printf '資料封存與報表核對完成；實體容量尚未縮減（%s → %s bytes）。需另執行已驗證的 reclaim-daf-storage.sh，不能把本次視為容量回收成功。\n' "$before_database_bytes" "$after_database_bytes"
else
  printf '資料封存與報表核對完成；整庫實測減少 %s bytes。\n' "$((before_database_bytes-after_database_bytes))"
fi
printf '未建立持續備份排程。\n'
