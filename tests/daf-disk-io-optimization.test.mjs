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
