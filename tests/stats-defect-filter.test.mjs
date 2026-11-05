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
