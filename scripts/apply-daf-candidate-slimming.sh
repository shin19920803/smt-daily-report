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
compatibility_path="$repo_root/supabase/daf_historical_compaction.sql"
migration_path="$repo_root/supabase/daf_candidate_payload_slimming.sql"

[[ -f "$backup_path" && -s "$backup_path" ]] || { printf '既有完整備份不存在或為空；拒絕修改線上資料。\n' >&2; exit 2; }
[[ -f "$compatibility_path" && -f "$migration_path" ]] || { printf '找不到相容層或精簡 SQL。\n' >&2; exit 2; }
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
  psql --no-psqlrc -v ON_ERROR_STOP=1 --host="$pg_host" --port="$pg_port" --username="$pg_user" --dbname="$pg_database" "$@"
}

connection=$(psql_exec -At -F '|' -c "select current_database(), current_user, current_setting('server_version_num')")
IFS='|' read -r connected_database connected_user server_version <<< "$connection"
if [[ "$connected_database" != "$pg_database" ]]; then
  printf '連線資料庫不符（%s），拒絕修改。\n' "$connected_database" >&2
  exit 3
fi

base_schema=$(psql_exec -At -c "select
  to_regclass('public.daf_log_candidates') is not null
  and to_regclass('public.daf_log_import_jobs') is not null
  and to_regclass('public.daf_log_import_chunks') is not null
  and to_regclass('public.daf_log_winners') is not null
  and to_regclass('public.daf_log_active_file_processes') is not null
  and to_regclass('public.daf_log_batches') is not null")
if [[ "$base_schema" != 't' ]]; then
  printf '五大製程資料表不完整；拒絕修改線上資料。\n' >&2
  exit 3
fi

if ! snapshot_cutoff=$(psql_exec -At -c "select clock_timestamp()::text") || [[ -z "$snapshot_cutoff" ]]; then
  printf '無法取得線上快照時間；停止，不修改資料。\n' >&2
  exit 3
fi
if ! receiving_jobs=$(psql_exec -At -v snapshot_cutoff="$snapshot_cutoff" -f - <<'SQL'
select count(*) from public.daf_log_import_jobs
where status='receiving' and created_at < :'snapshot_cutoff'::timestamptz;
SQL
) ; then
  printf '檢查進行中的上傳工作失敗；停止，不修改資料。\n' >&2
  exit 3
fi
if [[ "$receiving_jobs" != '0' ]]; then
  printf '目前有 %s 個上傳工作進行中；請等其完成後再套用，以免部署快照混入上傳變更。\n' "$receiving_jobs" >&2
  exit 3
fi

candidate_snapshot() {
  psql_exec -At -v snapshot_cutoff="$snapshot_cutoff" -f - <<'SQL'
select line || '|' || count(*) || '|' || coalesce(min(id), '') || '|' || coalesce(max(id), '')
from public.daf_log_candidates c
where c.created_at < :'snapshot_cutoff'::timestamptz
group by line order by line;
SQL
}

winner_snapshot() {
  psql_exec -At -v snapshot_cutoff="$snapshot_cutoff" -f - <<'SQL'
select w.line || '|' || count(*) || '|' || coalesce(min(w.candidate_id), '') || '|' ||
       coalesce(max(w.candidate_id), '')
from public.daf_log_winners w
join public.daf_log_candidates c on c.id=w.candidate_id
where c.created_at < :'snapshot_cutoff'::timestamptz
group by w.line order by w.line;
SQL
}

if ! candidate_before=$(candidate_snapshot); then
  printf '候選資料完整性快照逾時或失敗；停止，不修改候選資料。\n' >&2
  exit 3
fi
if ! winner_before=$(winner_snapshot); then
  printf 'winner 完整性快照逾時或失敗；停止，不修改候選資料。\n' >&2
  exit 3
fi
size_before=$(psql_exec -At -c "select pg_total_relation_size('public.daf_log_candidates'::regclass)")

compatible=$(psql_exec -At -c "select
  exists(select 1 from information_schema.columns where table_schema='public' and table_name='daf_log_candidates' and column_name='record_storage_version')
  and to_regprocedure('public.daf_candidate_canonical_json(public.daf_log_candidates)') is not null
  and to_regprocedure('public.daf_candidate_to_record(public.daf_log_candidates)') is not null
  and to_regprocedure('public.daf_candidate_payload_mismatch(public.daf_log_candidates)') is not null")
if [[ "$compatible" != 't' ]]; then
  printf '安裝缺少的雙格式相容讀取層（只建立／更新結構與函式，不執行封存刪除）…\n'
  psql_exec -v ON_ERROR_STOP=1 --file="$compatibility_path"
  compatible=$(psql_exec -At -c "select
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='daf_log_candidates' and column_name='record_storage_version')
    and to_regprocedure('public.daf_candidate_canonical_json(public.daf_log_candidates)') is not null
    and to_regprocedure('public.daf_candidate_to_record(public.daf_log_candidates)') is not null
    and to_regprocedure('public.daf_candidate_payload_mismatch(public.daf_log_candidates)') is not null")
  if [[ "$compatible" != 't' ]]; then
    printf '相容層安裝後檢查仍未通過；停止，尚未啟用精簡寫入。\n' >&2
    exit 3
  fi
fi

printf '連線成功：資料庫 %s，候選表目前 %s bytes。套用精簡相容寫入與批次轉換…\n' "$connected_database" "$size_before"
psql_exec -v ON_ERROR_STOP=1 --file="$migration_path"

printf '開始分批檢查並精簡；略過耗時的全表預掃描，每批完成後回報筆數與實際 JSON 節省量。\n'

after_id=''
batch_no=0
total_scanned=0
total_converted=0
total_retained=0
total_bytes_saved=0
batch_size=1000
while :; do
  batch_no=$((batch_no + 1))
  while :; do
    if result=$(psql_exec -At -F '|' -v cursor="$after_id" -v batch_size="$batch_size" -f - <<'SQL'
select r->>'scanned', r->>'converted', r->>'retained_original', r->>'json_bytes_saved',
       coalesce(r->>'next_id',''), r->>'has_more'
from (select public.daf_slim_log_candidates_batch(:'batch_size'::integer, nullif(:'cursor','')) as r) q;
SQL
    ); then
      break
    fi
    if (( batch_size <= 125 )); then
      printf '批次 %s 在最小批次大小 %s 仍失敗；停止，已完成批次可安全重跑。\n' "$batch_no" "$batch_size" >&2
      exit 4
    fi
    batch_size=$((batch_size / 2))
    printf '批次 %s 逾時或失敗，縮小批次至 %s 後重試同一游標。\n' "$batch_no" "$batch_size" >&2
  done
  IFS='|' read -r scanned converted retained bytes_saved after_id has_more <<< "$result"
  if [[ ! "$scanned" =~ ^[0-9]+$ || ! "$converted" =~ ^[0-9]+$ || ! "$retained" =~ ^[0-9]+$ || ! "$bytes_saved" =~ ^-?[0-9]+$ || ! "$has_more" =~ ^(true|false)$ ]]; then
    printf '批次 %s 回傳資料不完整；停止以免誤判成功。\n' "$batch_no" >&2
    exit 4
  fi
  total_scanned=$((total_scanned + scanned))
  total_converted=$((total_converted + converted))
  total_retained=$((total_retained + retained))
  total_bytes_saved=$((total_bytes_saved + bytes_saved))
  printf '批次 %s：掃描 %s、精簡 %s、保留原格式 %s、累計節省 %s bytes、仍有後續=%s\n' \
    "$batch_no" "$scanned" "$converted" "$retained" "$total_bytes_saved" "$has_more"
  [[ "$has_more" == 'true' ]] || break
  [[ "$scanned" -gt 0 && -n "$after_id" ]] || { printf '批次游標未前進，停止以避免無限重試。\n' >&2; exit 4; }
done
printf '分批轉換統計：共掃描 %s、精簡 %s、保留原格式 %s、JSON 累計節省 %s bytes。\n' \
  "$total_scanned" "$total_converted" "$total_retained" "$total_bytes_saved"

# The batch RPC scans every committed candidate and verifies each converted
# row round-trips exactly. Avoid a second full-table eligibility/constraint
# scan, which exceeds the hosted statement limit; the NOT VALID constraint
# still applies to all inserted or updated rows.
# VACUUM makes dead tuple space reusable; it does not promise to reduce the
# allocated relation size. Use pg_repack separately only when available and
# after confirming its supported extension version and free-disk headroom.
psql_exec -v ON_ERROR_STOP=1 -c 'vacuum (analyze) public.daf_log_candidates'

if ! candidate_after=$(candidate_snapshot); then
  printf '候選資料完成後快照逾時或失敗；停止宣告完成。\n' >&2
  exit 6
fi
if ! winner_after=$(winner_snapshot); then
  printf 'winner 完成後快照逾時或失敗；停止宣告完成。\n' >&2
  exit 6
fi
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
printf '逐站候選列與 winner 筆數／ID 範圍一致，批次逐筆還原檢查通過；轉換完成。候選表配置大小：%s → %s bytes。\n' "$size_before" "$size_after"
printf 'VACUUM 只讓空間可重用，不保證縮小實際配置；若需立即回收磁碟，另須核對並執行 Supabase 支援的 pg_repack。\n'
