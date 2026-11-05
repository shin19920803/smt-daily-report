import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../index.html');
const sql = read('../supabase/stats_defect_options.sql');
const stats = read('../js/stats.js');
const assembly = read('../js/assembly.js');
const daf = read('../js/daf.js');
const autoTester = read('../js/auto-tester.js');
const auth = read('../js/auth.js');
const supabaseClient = read('../js/supabase-client.js');
const defectIndex = read('../supabase/stats_defect_options_performance.sql');

test('所有統計介面日期欄位都與快捷區間同列，只有有不良分析的三類介面新增篩選', () => {
    assert.equal(((html + autoTester).match(/class="quick-date-fields"/g) || []).length, 4);
    assert.match(html, /v-model="statsFilter\.start"/);
    assert.match(html, /v-model="assemblyStatsFilter\.start"/);
    assert.match(html, /v-model="dafStatsFilter\.start"/);
    assert.match(autoTester, /v-model="statsStart"/);
    assert.equal((html.match(/v-model="(?:assemblyStatsFilter|dafStatsFilter|statsFilter)\.defectName"/g) || []).length, 3);
});

test('不良原因 RPC 嚴格限定各站別，只輸出實際有效原因名稱', () => {
    assert.match(sql, /returns table\(name text\)/i);
    assert.match(sql, /dashboard_private\.current_account_id\(\) is not null/i);
    assert.match(sql, /not coalesce\(\(select enabled from dashboard_private\.access_settings where id\), false\)/i);
    assert.match(sql, /'SMT', 'ASSY', 'DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY'/);
    assert.match(sql, /d\.quantity > 0/);
    assert.match(sql, /r\.line = 'ASSY'/);
    for (const line of ['DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY']) {
        assert.ok(sql.includes(`r.line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')`));
        assert.match(sql, new RegExp(`where r\\.line in \\('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY'\\)[\\s\\S]{0,180}${line === 'FT2' ? "'偵測失效'" : "'未填寫不良原因'"}`));
    }
    assert.match(sql, /select distinct btrim\(raw_names\.name\)/i);
    assert.doesNotMatch(sql, /record_json|select\s+\*/i);
});

test('選原因只改分析明細投影，不改 SMT／Mylar／五製程原始 KPI 總數', () => {
    assert.match(stats, /modelAgg\[modelName\]\.defects \+= q;[\s\S]*?dayMap\[day\.production_date\]\.defects \+= q;[\s\S]*?if \(selectedDefect !== 'all' && tName !== selectedDefect\) return;/);
    assert.match(stats, /yieldRate: totalInput \? \(\(totalInput - totalDefects\) \/ totalInput \* 100\)/);
    assert.match(assembly, /const assemblyStatsViewResult = computed\(\(\) => \{[\s\S]*?return \{ \.\.\.result, byType, byModel, topCause/);
    assert.match(daf, /const dafStatsDisplayResult = computed\(\(\) => \{[\s\S]*?return \{ \.\.\.result, byType, byModel, byWorkOrder, daily/);
    assert.match(daf, /dafDefectFilterByLine\.value\[line\]/);
});

test('Mylar Pareto 依數量降冪，第一筆顯示於最上方且不改原始陣列', () => {
    const helper = assembly.match(/const sortAssemblyParetoRows = ([^;]+);/)?.[1];
    assert.ok(helper, 'Pareto pure sorting helper should exist');
    const sortRows = new Function(`return (${helper})`)();
    const source = [{ name: '少', qty: 2 }, { name: '多', qty: 9 }, { name: '中', qty: 5 }];
    const result = sortRows(source);
    assert.deepEqual(result.map(row => row.name), ['多', '中', '少']);
    assert.deepEqual(source.map(row => row.name), ['少', '多', '中']);
    assert.match(assembly, /yAxis:\s*\{[^}]*inverse:\s*true/);
    assert.match(assembly, /const renderParetoChart = \(id, result, previous, setPrevious, onClick\) => \{[\s\S]*?const rows = sortAssemblyParetoRows\(result\.byType\)\.slice\(0, 12\)/);
});

test('五站清單遇 Cloudflare 暫時錯誤時走登入 RPC 備援、可強制重試且保留舊成功資料', () => {
    assert.match(daf, /fetchCachedJson\([^;]+\{ force, signal: controller\.signal \}\)/);
    assert.match(daf, /rows == null && typeof window\.DashboardAuth\?\.readStatsDefectOptions/);
    assert.match(daf, /window\.DashboardAuth\.readStatsDefectOptions\(line\)/);
    assert.match(daf, /typeof window\.DashboardAuth\?\.readStatsDefectOptions/);
    assert.match(daf, /HTTP\\s\+\(401\|403\)/);
    assert.match(daf, /ready: Boolean\(prior\.ready\)/);
    assert.match(daf, /loadDafHistoricalDefectOptions,?/);
    assert.match(html, /force: true[^>]*">重試清單/);
    assert.match(auth, /readStatsDefectOptions = async line/);
    assert.match(supabaseClient, /fetchCachedJson = async \(path, \{ force = false, signal \} = \{\}\)/);
});

test('五站 FAIL 候選清單有窄範圍覆蓋索引，不要求改全域 timeout 或讀取 LOG raw 欄位', () => {
    assert.match(defectIndex, /create index concurrently if not exists daf_log_candidates_fail_line_idx/i);
    assert.match(defectIndex, /on public\.daf_log_candidates \(line, id\) include \(defect\)/i);
    assert.match(defectIndex, /where status = 'FAIL'/i);
    assert.doesNotMatch(defectIndex, /record_json|alter role|set statement_timeout/i);
});
