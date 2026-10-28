import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dafSource = readFileSync(new URL('../js/daf.js', import.meta.url), 'utf8');
const maintenanceSource = readFileSync(new URL('../supabase/daf_maintenance_contention_fix.sql', import.meta.url), 'utf8');
const scheduleSource = readFileSync(new URL('../supabase/daf_historical_compaction_schedule.sql', import.meta.url), 'utf8');

test('五大製程版本先讀跨電腦 Cloudflare 快取，Supabase 僅作故障備援', () => {
    const start = dafSource.indexOf('const loadDafVersions = async (force = false) => {');
    const end = dafSource.indexOf('\n    const sameDafLineVersion', start);
    assert(start >= 0 && end > start, '找不到版本載入函式');
    const loader = dafSource.slice(start, end);
    const cacheHelperStart = dafSource.indexOf('const loadDafVersionsFromCache = async force => {');
    const cacheHelperEnd = dafSource.indexOf('\n    const loadDafVersions =', cacheHelperStart);
    assert(cacheHelperStart >= 0 && cacheHelperEnd > cacheHelperStart, '找不到 Cloudflare 版本快取讀取函式');
    const cacheHelper = dafSource.slice(cacheHelperStart, cacheHelperEnd);
    assert(loader.indexOf('loadDafVersionsFromCache(force)') < loader.indexOf('loadDafVersionsFromSupabase()'));
    assert.match(loader, /catch \(cacheError\)/);
    assert.match(cacheHelper, /window\.fetchCachedJson/);
    assert.match(cacheHelper, /\/api\/daf-version\?lines=/);
    assert.match(loader, /dafRemoteVersionsLoadedAt = Date\.now\(\)/);
});

test('維護排程每三分鐘執行一次，三條維護路徑仍輪替且每條路徑可持續執行', () => {
    assert.match(scheduleSource, /'\*\/3 \* \* \* \*'/);
    assert.match(maintenanceSource, /floor\(extract\(epoch from now\(\)\) \/ 180\)::integer % 3/);
    assert.match(maintenanceSource, /if v_task = 0 then/);
    assert.match(maintenanceSource, /elsif v_task = 1 then/);
    assert.match(maintenanceSource, /else\s+begin\s+v_cutoff := public\.daf_latest_seven_production_days_cutoff\(\)/);
});

test('部署驗證會套用新排程並拒絕舊的一分鐘排程', () => {
    assert.match(maintenanceSource, /cron\.schedule\([\s\S]*?'\*\/3 \* \* \* \*'/);
    assert.match(maintenanceSource, /cron\.unschedule\(v_job_id\)/);
    assert.match(maintenanceSource, /commit;/);
});

test('所有維護安裝入口在外層 SELECT 前設定真正的逾時，不靠函式內的 SET', () => {
    const cleanup = readFileSync(new URL('../supabase/daf_failed_import_cleanup.sql', import.meta.url), 'utf8');
    for (const sql of [scheduleSource,maintenanceSource,cleanup]) {
        assert.match(sql, /set statement_timeout = ''7s''; set lock_timeout = ''1s''; select public\.daf_/);
    }
    const migration = readFileSync(new URL('../supabase/daf_maintenance_statement_budget_fix.sql', import.meta.url), 'utf8');
    assert.match(migration, /cron\.alter_job/);
    assert.doesNotMatch(migration, /cron\.(unschedule|schedule)\(/);
    assert.doesNotMatch(migration, /active\s*:=|schedule\s*:=/);
    assert.match(migration, /v_main_jobs<>1 or v_cleanup_jobs<>1/);
    assert.match(migration, /current_setting\('cron\.use_background_workers',true\)/);
});

test('清理腳本接續舊檢查點時，不會恢復沒有外層時限的排程', () => {
    const script = readFileSync(new URL('../scripts/apply-daf-historical-compaction.sh',import.meta.url),'utf8');
    const start = script.indexOf('restore_cron_jobs() {');
    const block = script.slice(start,script.indexOf('\nif [[ -n "$reuse_backup_path"',start));
    assert.match(block,/case "\$saved_command" in/);
    assert.match(block,/daf_run_log_maintenance_batch\(\);/);
    assert.match(block,/daf_prune_failed_log_imports\(\);/);
    assert.match(block,/saved_command="set statement_timeout = '7s'; set lock_timeout = '1s'; \$saved_command"/);
});
