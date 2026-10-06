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
  printf '用法：%s <Supabase 主機> <資料庫使用者> <既有完整備份檔>\n' "$0" >&2
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
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
migration_path="$repo_root/supabase/daf_candidate_payload_slimming.sql"

[[ -f "$backup_path" && -s "$backup_path" ]] || { printf '既有完整備份不存在或為空；拒絕修改線上資料。\n' >&2; exit 2; }
[[ -f "$migration_path" ]] || { printf '找不到精簡 SQL。\n' >&2; exit 2; }
pg_restore --list "$backup_path" >/dev/null || { printf '備份封存目錄無法讀取；拒絕修改線上資料。\n' >&2; exit 2; }
pg_restore --exit-on-error --file=/dev/null "$backup_path" || { printf '備份內容驗證失敗；拒絕修改線上資料。\n' >&2; exit 2; }

pgpass_file=${KOYA_PGPASSFILE:-}
pgpass_owned=0
pgpass_dir=''
if [[ -n "$pgpass_file" ]]; then
  [[ -f "$pgpass_file" && -r "$pgpass_file" ]] || { printf '指定的暫存連線憑證無法讀取。\n' >&2; exit 2; }
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
  pgpass_dir=$(mktemp -d "${TMPDIR:-/tmp}/koya-slim-pgpass.XXXXXX")
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

connection=$(psql_exec -At -F '|' -c "select current_database(), current_user, current_setting('server_version_num')")
IFS='|' read -r connected_database connected_user server_version <<< "$connection"
if [[ "$connected_database" != "$pg_database" ]]; then
  printf '連線資料庫不符（%s），拒絕修改。\n' "$connected_database" >&2
  exit 3
fi

compatible=$(psql_exec -At -c "select
  exists(select 1 from information_schema.columns where table_schema='public' and table_name='daf_log_candidates' and column_name='record_storage_version')
  and to_regprocedure('public.daf_candidate_canonical_json(public.daf_log_candidates)') is not null
  and to_regprocedure('public.daf_candidate_to_record(public.daf_log_candidates)') is not null
  and to_regprocedure('public.daf_candidate_payload_mismatch(public.daf_log_candidates)') is not null")
if [[ "$compatible" != 't' ]]; then
  printf '線上資料庫尚未安裝候選資料雙格式相容層；拒絕套用精簡寫入。\n' >&2
  exit 3
fi

snapshot_cutoff=$(psql_exec -At -c "select clock_timestamp()::text")
receiving_jobs=$(psql_exec -At -v snapshot_cutoff="$snapshot_cutoff" -c "select count(*) from public.daf_log_import_jobs where status='receiving' and created_at < :'snapshot_cutoff'::timestamptz")
if [[ "$receiving_jobs" != '0' ]]; then
  printf '目前有 %s 個上傳工作進行中；請等其完成後再套用，以免部署快照混入上傳變更。\n' "$receiving_jobs" >&2
  exit 3
fi

candidate_snapshot_sql="select line || '|' || count(*) || '|' || coalesce(min(id), '') || '|' || coalesce(max(id), '') || '|' || md5(coalesce(string_agg(md5((to_jsonb(c) - array['record_json','record_storage_version'])::text), '' order by id), '')) from public.daf_log_candidates c where c.created_at < :'snapshot_cutoff'::timestamptz group by line order by line"
winner_snapshot_sql="select w.line || '|' || count(*) || '|' || md5(coalesce(string_agg(md5(to_jsonb(w)::text), '' order by w.candidate_id), '')) from public.daf_log_winners w join public.daf_log_candidates c on c.id=w.candidate_id where c.created_at < :'snapshot_cutoff'::timestamptz group by w.line order by w.line"
candidate_before=$(psql_exec -At -v snapshot_cutoff="$snapshot_cutoff" -c "$candidate_snapshot_sql")
winner_before=$(psql_exec -At -v snapshot_cutoff="$snapshot_cutoff" -c "$winner_snapshot_sql")
size_before=$(psql_exec -At -c "select pg_total_relation_size('public.daf_log_candidates'::regclass)")

printf '連線成功：資料庫 %s，候選表目前 %s bytes。套用精簡相容寫入與批次轉換…\n' "$connected_database" "$size_before"
psql_exec -v ON_ERROR_STOP=1 --file="$migration_path"

preview=$(psql_exec -At -F '|' -c "select line, candidate_rows, eligible_rows, retained_full_rows, json_payload_bytes, estimated_slim_payload_bytes, estimated_payload_savings_bytes, raw_payload_bytes from public.daf_preview_candidate_slimming() order by line")
printf '上線前精簡預覽（站別|列數|可精簡|保留原格式|JSON bytes|精簡估計 bytes|估計節省 bytes|保留 raw bytes）：\n%s\n' "$preview"

after_id=''
batch_no=0
while :; do
  batch_no=$((batch_no + 1))
  result=$(psql_exec -At -F '|' -v cursor="$after_id" -c "select r->>'scanned', r->>'converted', r->>'retained_original', coalesce(r->>'next_id',''), r->>'has_more' from (select public.daf_slim_log_candidates_batch(5000, nullif(:'cursor','')) as r) q")
  IFS='|' read -r scanned converted retained after_id has_more <<< "$result"
  printf '批次 %s：掃描 %s、精簡 %s、保留原格式 %s、仍有後續=%s\n' "$batch_no" "$scanned" "$converted" "$retained" "$has_more"
  [[ "$has_more" == 'true' ]] || break
  [[ "$scanned" -gt 0 && -n "$after_id" ]] || { printf '批次游標未前進，停止以避免無限重試。\n' >&2; exit 4; }
done

psql_exec -v ON_ERROR_STOP=1 -c 'alter table public.daf_log_candidates validate constraint daf_log_candidates_slim_payload_check'
remaining_eligible=$(psql_exec -At -c "select count(*) from public.daf_log_candidates c join public.daf_log_import_jobs j on j.id=c.job_id where c.record_storage_version=1 and j.status <> 'receiving' and public.daf_try_slim_candidate_json(c.record_json, public.daf_candidate_canonical_json(c)) is not null")
if [[ "$remaining_eligible" != '0' ]]; then
  printf '仍有 %s 筆可精簡舊格式資料；停止宣告完成。\n' "$remaining_eligible" >&2
  exit 5
fi

# VACUUM makes dead tuple space reusable; it does not promise to reduce the
# allocated relation size. Use pg_repack separately only when available and
# after confirming its supported extension version and free-disk headroom.
psql_exec -v ON_ERROR_STOP=1 -c 'vacuum (analyze) public.daf_log_candidates'

candidate_after=$(psql_exec -At -v snapshot_cutoff="$snapshot_cutoff" -c "$candidate_snapshot_sql")
winner_after=$(psql_exec -At -v snapshot_cutoff="$snapshot_cutoff" -c "$winner_snapshot_sql")
if [[ "$candidate_before" != "$candidate_after" ]]; then
  printf '候選列 ID／統計欄位快照不一致；停止宣告完成。\n' >&2
  diff -u <(printf '%s\n' "$candidate_before") <(printf '%s\n' "$candidate_after") >&2 || true
  exit 6
fi
if [[ "$winner_before" != "$winner_after" ]]; then
  printf 'winner 清單快照不一致；停止宣告完成。\n' >&2
  diff -u <(printf '%s\n' "$winner_before") <(printf '%s\n' "$winner_after") >&2 || true
  exit 6
fi

size_after=$(psql_exec -At -c "select pg_total_relation_size('public.daf_log_candidates'::regclass)")
printf '逐站候選列與 winner 指紋一致；轉換完成。候選表配置大小：%s → %s bytes。\n' "$size_before" "$size_after"
printf 'VACUUM 只讓空間可重用，不保證縮小實際配置；若需立即回收磁碟，另須核對並執行 Supabase 支援的 pg_repack。\n'
