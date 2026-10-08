import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../js/daf.js', import.meta.url), 'utf8');
const sharedStateStart = source.indexOf('    const parseSharedDafStatsState = row => {');
const sharedStateEnd = source.indexOf('    const saveSharedDafStatsStateInternal =', sharedStateStart);
assert(sharedStateStart >= 0 && sharedStateEnd > sharedStateStart, '找不到跨裝置統計快照解析函式');
const legacyNamespace = String.fromCharCode(107, 111, 121, 97);
const parseSharedState = new Function(
    'LEGACY_SHARED_STATS_KIND', 'LEGACY_STATS_SNAPSHOT_V1_KIND', 'LEGACY_STATS_SNAPSHOT_V2_KIND',
    `${source.slice(sharedStateStart, sharedStateEnd)}; return parseSharedDafStatsState;`
)(`${legacyNamespace}-shared-daf-stats-v1`, `${legacyNamespace}-daf-stats-snapshot-v1`, `${legacyNamespace}-daf-stats-snapshot-v2-weighted`);
for (const kind of ['production-daf-stats-snapshot-v1', 'production-daf-stats-snapshot-v2-weighted', `${legacyNamespace}-daf-stats-snapshot-v2-weighted`]) {
    const parsed = parseSharedState({ records: [{
        kind: 'shared-production-daf-stats-v1', start: '2026-09-01', end: '2026-09-30',
        snapshot: { kind, results: { DAF: { totalInput: 1 } } }
    }] });
    assert.equal(parsed?.snapshot?.kind, kind, `跨裝置統計快照 ${kind} 相容性失效`);
}
const legacyState = parseSharedState({ records: [{
    kind: `${legacyNamespace}-shared-daf-stats-v1`, start: '2026-09-01', end: '2026-09-30',
    snapshot: { kind: `${legacyNamespace}-daf-stats-snapshot-v2-weighted`, results: { DAF: { totalInput: 1 } } }
}] });
assert.ok(legacyState?.snapshot, '既有跨裝置統計快照無法讀取');
const rebuildStart = source.indexOf('    const rebuildDafBatch = batch => {');
const rebuildEnd = source.indexOf('    const deduplicateDafBatches =', rebuildStart);
assert(rebuildStart >= 0 && rebuildEnd > rebuildStart, '找不到每日報工摘要重建函式');
const rebuildBlock = source.slice(rebuildStart, rebuildEnd);
assert.match(rebuildBlock, /const inputCount = inputRecords\.reduce\(\(sum, record\) => sum \+ dafRecordQuantity\(record\), 0\)/,
    '每日報工摘要投入分母沒有按加權數量計算');
assert.match(rebuildBlock, /goodCount \/ inputCount/,
    '加權資料的良率分母錯誤');
assert.match(rebuildBlock, /failCount \/ inputCount/,
    '加權資料的不良率分母錯誤');
const dafRecordQuantity = record => Number.isFinite(Number(record?.quantity)) && Number(record.quantity) > 0
    ? Math.max(1, Math.trunc(Number(record.quantity))) : 1;
const rebuildDafBatch = new Function(
    'normalizeDafRecord', 'dafRecordQuantity', 'normalizeText', 'cleanText', 'normalizeModelName',
    `${rebuildBlock}; return rebuildDafBatch;`
)(record => record, dafRecordQuantity,
    value => String(value ?? '').trim().toUpperCase(), value => String(value ?? '').trim(), value => String(value || '未識別機種'));
const rebuilt = rebuildDafBatch({ line: 'DAF', records: [
    { date: '2026-09-20', model: 'M-A', workOrder: 'WO-1', productCode: 'P-1', status: 'GOOD', inputIncluded: true, quantity: 11 },
    { date: '2026-09-20', model: 'M-A', workOrder: 'WO-1', productCode: 'P-1', status: 'FAIL', inputIncluded: true, quantity: 3 },
    { date: '2026-09-20', model: 'M-A', workOrder: 'WO-1', productCode: 'P-1', status: 'RETEST', inputIncluded: false, quantity: 4 }
] });
assert.equal(rebuilt.inputCount, 14, '每日報工投入數應採加權數量');
assert.equal(rebuilt.goodCount, 11, '每日報工良品數應採加權數量');
assert.equal(rebuilt.failCount, 3, '每日報工不良數應採加權數量');
assert.equal(rebuilt.rowCount, 18, '每日報工總筆數應包含非投入狀態加權數量');
assert.equal(rebuilt.yieldRate, '78.57', '每日報工良率應以加權投入數計算');
assert.equal(rebuilt.defectRate, '21.43', '每日報工不良率應以加權投入數計算');
const start = source.indexOf('    const mapRate = (value, base) =>');
const end = source.indexOf('    const dafRowMatchesStatsFilter =', start);
assert(start >= 0 && end > start, '找不到 DAF 統計函式區塊');

const buildBlock = source.slice(start, end);
const buildDafSummary = new Function(
    'DAF_MACHINE_LABELS', 'DAF_MACHINE_UNKNOWN', 'dafRecordQuantity', 'defaultDafDefect',
    'isMachineClassifiedProcess', 'dafMachineForRecord', 'currentDafLine',
    `${buildBlock}; return buildDafSummary;`
)(['1號機', '2號機'], '未分類機台', dafRecordQuantity,
    line => line === 'FT2' ? '偵測失效' : '未填寫不良原因',
    line => line === 'DAF' || line === 'FT1',
    row => row?.machine || '未分類機台', () => 'DAF');

const fixture = [
    { date: '2026-09-20', model: 'M-A', workOrder: 'WO-1', status: 'GOOD', inputIncluded: true, machine: '1號機', quantity: 11 },
    { date: '2026-09-20', model: 'M-A', workOrder: 'WO-1', status: 'FAIL', inputIncluded: true, isDefect: true, defect: '刮傷', machine: '1號機', quantity: 3 },
    { date: '2026-09-20', model: 'M-B', workOrder: 'WO-2', status: 'FAIL', inputIncluded: true, isDefect: true, defect: '偏移', machine: '2號機', quantity: 2 },
    { date: '2026-09-21', model: 'M-B', workOrder: 'WO-2', status: 'GOOD', inputIncluded: true, machine: '2號機', quantity: 7 },
    { date: '2026-09-21', model: 'M-C', workOrder: 'WO-3', status: 'RETEST', inputIncluded: false, machine: '', quantity: 4 },
    { date: '2026-09-21', model: 'M-C', workOrder: 'WO-3', status: 'FAIL', inputIncluded: true, isDefect: true, defect: '', machine: '', quantity: 1 }
];

for (const line of ['DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY']) {
    const expanded = fixture.flatMap((row, rowIndex) => Array.from({ length: row.quantity }, (_, index) => ({
        ...row, quantity: 1, dedupKey: `${line}-${rowIndex}-${index}`
    })));
    const weighted = buildDafSummary(fixture, line);
    const unitRows = buildDafSummary(expanded, line);
    const { rows: _weightedRows, ...weightedMetrics } = weighted;
    const { rows: _unitRows, ...unitMetrics } = unitRows;
    assert.deepEqual(weightedMetrics, unitMetrics, `${line} 加權統計與逐筆統計不同`);
    assert.equal(weighted.totalRows, expanded.length, `${line} 總筆數錯誤`);

    const filters = [
        row => row.date === '2026-09-20',
        row => row.model === 'M-B',
        row => row.workOrder === 'WO-1',
        row => row.date === '2026-09-21' && row.status === 'FAIL'
    ];
    filters.forEach((matches, index) => {
        const weightedFiltered = buildDafSummary(fixture.filter(matches), line);
        const expandedFiltered = buildDafSummary(expanded.filter(matches), line);
        const { rows: _a, ...weightedResult } = weightedFiltered;
        const { rows: _b, ...expandedResult } = expandedFiltered;
        assert.deepEqual(weightedResult, expandedResult, `${line} 篩選案例 ${index + 1} 加權統計不同`);
    });
}

const machineStart = source.indexOf('    const detectDafMachine = value => {');
const machineEnd = source.indexOf('    };', machineStart) + 6;
assert(machineStart >= 0 && machineEnd > machineStart, '找不到 DAF 機台識別函式');
const detectDafMachine = new Function('normalizeText', `${source.slice(machineStart, machineEnd)}; return detectDafMachine;`)(
    value => String(value ?? '').trim().toUpperCase());
assert.equal(detectDafMachine('Y0176 林保芳'), '1號機', '包含 176 的操作員欄應判為 1 號機');
assert.equal(detectDafMachine('Y0137 林保芳'), '2號機', '包含 137 的操作員欄應判為 2 號機');
assert.equal(detectDafMachine('Y00176'), '1號機', '前綴不固定時仍應依 176 判為 1 號機');
assert.equal(detectDafMachine('一般操作員'), '', '沒有機台碼時不得誤分類');

process.stdout.write('通過：五製程加權統計與逐筆統計的第一層／第二層彙總一致。\n');
