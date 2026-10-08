#!/usr/bin/env bash
# VACUUM FULL preserves PostgreSQL tables atomically; never export/TRUNCATE/reimport.
set -euo pipefail
for task_pg_bin in /opt/homebrew/opt/postgresql@17/bin /opt/homebrew/opt/libpq/bin; do
  if [[ -x "$task_pg_bin/psql" ]]; then PATH="$task_pg_bin:$PATH"; export PATH; break; fi
done
[[ $# -eq 2 ]] || { printf '用法：bash %s <host> <user>\n' "$0" >&2; exit 2; }
task_host=$1
task_user=$2
task_port=${KOYA_PGPORT:-5432}
task_root=$(cd "$(dirname "$0")/.." && pwd)
task_free=${KOYA_DISK_FREE_BYTES:-0}
[[ "$task_free" =~ ^[0-9]+$ && "$task_free" -gt 0 ]] || {
  printf '先從 Supabase 磁碟容量／用量確認剩餘 bytes，再設定 KOYA_DISK_FREE_BYTES；未進行線上修改。\n' >&2
  exit 2
}
umask 077
task_credentials=$(mktemp -d "${TMPDIR:-/tmp}/koya-reclaim.XXXXXX")
task_barrier=0
task_pgpass="$task_credentials/pgpass"
export PGPASSFILE="$task_pgpass" PGSSLMODE=require
export PGOPTIONS='-c statement_timeout=0 -c lock_timeout=5s'
task_psql() { psql -X -w -v ON_ERROR_STOP=1 -h "$task_host" -p "$task_port" -U "$task_user" -d postgres "$@"; }
task_cleanup() {
  if [[ "$task_barrier" == 1 ]]; then
    task_psql -c 'select public.daf_end_space_reclamation();' ||
      printf '連線中斷，維護保護仍啟用；復原連線後執行 select public.daf_end_space_reclamation();\n' >&2
  fi
  rm -f -- "$task_pgpass"
  rmdir -- "$task_credentials" 2>/dev/null || true
}
trap task_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
read -r -s -p 'Supabase Database Password（輸入不會顯示）: ' task_password
printf '\n'
[[ -n "$task_password" ]] || exit 2
task_escape() { local value=${1//\\/\\\\}; value=${value//:/\\:}; printf '%s' "$value"; }
printf '%s:%s:postgres:%s:%s\n' "$(task_escape "$task_host")" "$task_port" \
  "$(task_escape "$task_user")" "$(task_escape "$task_password")" > "$task_pgpass"
unset task_password
task_psql -f "$task_root/supabase/daf_space_reclamation.sql"
task_psql -c 'select public.daf_begin_space_reclamation();'
task_barrier=1
task_backup="$task_root/../smt-daily-report-backups/smt-pre-reclaim-$(date +%Y%m%d-%H%M%S).dump"
pg_dump -w -Fc --no-owner --no-privileges -h "$task_host" -p "$task_port" -U "$task_user" -d postgres -f "$task_backup"
pg_restore --exit-on-error -f /dev/null "$task_backup"
printf '已驗證最新完整備份：%s\n' "$task_backup"

task_digest_sql="select line || '|' || dashboard_digest from public.daf_preview_log_compaction('9999-12-31') order by line"
task_rows_sql="select 'candidates|' || count(*) || '|' || md5(coalesce(string_agg(md5(to_jsonb(c)::text),'' order by id),'')) from public.daf_log_candidates c union all select 'winners|' || count(*) || '|' || md5(coalesce(string_agg(md5(to_jsonb(w)::text),'' order by candidate_id),'')) from public.daf_log_winners w union all select 'facts|' || count(*) || '|' || md5(coalesce(string_agg(md5(to_jsonb(f)::text),'' order by candidate_id),'')) from public.daf_log_compact_facts f union all select 'groups|' || count(*) || '|' || md5(coalesce(string_agg(md5(to_jsonb(g)::text),'' order by group_id),'')) from public.daf_log_compact_groups g union all select 'e_keys|' || count(*) || '|' || md5(coalesce(string_agg(md5(to_jsonb(k)::text),'' order by line,dedup_key),'')) from public.daf_log_compact_e_keys k union all select 'batches|' || count(*) || '|' || md5(coalesce(string_agg(md5(to_jsonb(b)::text),'' order by id),'')) from public.daf_log_batches b order by 1"
task_before=$(task_psql -At -c "$task_digest_sql")
task_rows_before=$(task_psql -At -c "$task_rows_sql")
task_size_before=$(task_psql -At -c 'select pg_database_size(current_database())')
[[ $(printf '%s\n' "$task_before" | awk 'NF {n++} END {print n+0}') -eq 5 ]] || exit 3

# Rewrite the smaller winner table first; its reclaimed pages fund the candidate rewrite.
# The current table size is a conservative rewrite upper bound; add WAL/sort reserve.
for task_table in daf_log_winners daf_log_candidates daf_log_compact_facts daf_log_compact_groups daf_log_compact_e_keys; do
  task_old=$(task_psql -At -c "select pg_total_relation_size('public.$task_table')")
  task_required=$((task_old + 134217728))
  if ((task_free < task_required)); then
    printf '%s 需要保守餘裕 %s bytes，目前確認餘裕 %s；停止本批回收，原表完整保留。\n' "$task_table" "$task_required" "$task_free" >&2
    exit 4
  fi
  printf '回收 %s，處理前 %s bytes；讀取短暫等待，上傳／刪除有維護保護。\n' "$task_table" "$task_old"
  task_psql -c "vacuum (full, analyze, verbose) public.$task_table"
  task_new=$(task_psql -At -c "select pg_total_relation_size('public.$task_table')")
  task_free=$((task_free + task_old - task_new))
  printf '%s：%s → %s bytes\n' "$task_table" "$task_old" "$task_new"
done
task_after=$(task_psql -At -c "$task_digest_sql")
task_rows_after=$(task_psql -At -c "$task_rows_sql")
[[ "$task_before" == "$task_after" && "$task_rows_before" == "$task_rows_after" ]] || {
  printf '指紋不同；保留原始完整備份，尚未通過核對。\n' >&2; exit 5;
}
task_size_after=$(task_psql -At -c 'select pg_database_size(current_database())')
((task_size_after < task_size_before)) || {
  printf '報表一致，但實體容量未減少：%s → %s bytes。\n' "$task_size_before" "$task_size_after" >&2; exit 6;
}
task_psql -At -c "select relname,pg_relation_size(oid),pg_indexes_size(oid),pg_total_relation_size(oid) from pg_class where relname in ('daf_log_winners','daf_log_candidates','daf_log_compact_facts','daf_log_compact_groups','daf_log_compact_e_keys') order by relname"
printf '回收核對通過：全歷史 Dashboard 與五大資料表逐列指紋一致；整庫 %s → %s bytes，減少 %s bytes。\n' "$task_size_before" "$task_size_after" "$((task_size_before-task_size_after))"
