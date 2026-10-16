import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = name => readFileSync(new URL(`../js/${name}`, import.meta.url), 'utf8');
const defects = [['瑕疵項目', 'C1', 'R6'], ['缺件', '', ''], ['立碑', '', 2]];
const fpy = [['日期', '工單號碼', '機種', 'SPI (%)', 'AOI (%)'], ['2026/10/15', '626090094', 'CY26-16-GOODIX_TOP', '', '99.98%']];
function harness({ line = 'SMT', existingFpy = null } = {}) {
    const writes = [], queries = [], messages = [];
    const ctx = {
        data: { value: {
            workOrders: [{ id: 'wo-1', wo_number: '626090094', models: { name: 'CY26-16-GOODIX_TOP' } }],
            defectLocations: [{ id: 'c1', code: 'C1' }, { id: 'r6', code: 'R6' }],
            defectTypes: [{ id: 'missing', name: '缺件' }, { id: 'standing', name: '立碑' }]
        } },
        loading: { value: false }, currentLine: { value: line }, currentTab: { value: 'report' },
        toast: (message, type) => messages.push({ message, type }),
        loadBaseData: async () => {}, activeWoNumbers: { value: [] }, uniqueWoNumbers: { value: [] },
        calendarYear: { value: 2026 }, calendarMonth: { value: 9 }
    };
    const window = { SMT: {}, getTaiwanDate: () => '2026-10-16', shiftDateByDays: () => '2026-10-15' };
    const sandbox = vm.createContext({ window, console: { warn() {}, error() {} },
        ref: value => ({ value }), computed: getter => ({ get value() { return getter(); } }),
        XLSX: {
            read: rows => ({ SheetNames: ['first'], Sheets: { first: rows } }),
            utils: { sheet_to_json: rows => rows }, SSF: { parse_date_code: () => ({ y: 2026, m: 10, d: 15 }) }
        },
        _supabase: { from(table) {
            queries.push(table);
            let single = false;
            const chain = {
                select() { return chain; }, eq() { return chain; }, order() { return chain; }, limit() { return chain; },
                maybeSingle() { single = true; return chain; },
                insert(payload) { writes.push({ table, operation: 'insert', payload: JSON.parse(JSON.stringify(payload)) }); return chain; },
                update(payload) { writes.push({ table, operation: 'update', payload: JSON.parse(JSON.stringify(payload)) }); return chain; },
                then(resolve, reject) {
                    const data = single ? (table === 'daily_fpy' ? existingFpy : { id: 'production-1', input_quantity: 100 }) : [];
                    return Promise.resolve({ data, error: null }).then(resolve, reject);
                }
            };
            return chain;
        } }
    });
    sandbox.SMT = window.SMT;
    vm.runInContext(read('smt-import-validation.js'), sandbox);
    vm.runInContext(read('report.js'), sandbox);
    vm.runInContext(read('fpy.js'), sandbox);
    const report = window.SMT.report(ctx);
    report.report.value.currentId = 'production-1'; report.report.value.wo_id = 'wo-1';
    const fp = window.SMT.fpy(ctx);
    const event = (...tables) => ({ target: { files: tables.map((rows, index) => ({ name: `upload-${index + 1}.csv`, arrayBuffer: async () => rows })), value: 'selected-file' } });
    return { ctx, report, fp, writes, queries, messages, event, validate: window.SMT.validateSmtImport };
}

test('SMT files cannot cross the two upload entry points; rejection performs zero database calls', async () => {
    const report = harness(); const reportEvent = report.event(fpy);
    const before = JSON.stringify(report.ctx.data.value);
    await report.report.importDefectCsv(reportEvent);
    assert.deepEqual(report.queries, []);
    assert.equal(JSON.stringify(report.ctx.data.value), before);
    assert.equal(report.report.report.value.currentId, 'production-1');
    assert.match(report.messages[0].message, /直通率管理/);
    assert.equal(reportEvent.target.value, ''); assert.equal(report.ctx.loading.value, false);
    const fp = harness(); const fpyEvent = fp.event(defects);
    await fp.fp.importFpyFile(fpyEvent);
    assert.deepEqual(fp.queries, []); assert.deepEqual(fp.writes, []);
    assert.match(fp.messages[0].message, /工單管理 → 每日報工/);
    assert.equal(fpyEvent.target.value, ''); assert.equal(fp.ctx.loading.value, false);
});

test('valid defect matrix preserves quantity/location/type; blank quantities remain allowed', async () => {
    const h = harness(); await h.report.importDefectCsv(h.event(defects));
    assert.deepEqual(h.writes, [{ table: 'defect_logs', operation: 'insert', payload: {
        production_id: 'production-1', defect_type_id: 'standing', location_id: 'r6', quantity: 2
    } }]);
    const zero = harness(); await zero.report.importDefectCsv(zero.event([['瑕疵項目', 'C1'], ['缺件', '']]));
    assert.deepEqual(zero.writes, []); assert.match(zero.messages.at(-1).message, /匯入成功/);
});

test('valid FPY preserves rate parsing, optional model and one blank rate', async () => {
    const h = harness(); await h.fp.importFpyFile(h.event(fpy));
    assert.deepEqual(JSON.parse(JSON.stringify(h.writes)), [{ table: 'daily_fpy', operation: 'insert', payload: {
        wo_id: 'wo-1', production_date: '2026-10-15', spi_rate: null, aoi_rate: 99.98, line: 'SMT'
    } }]);
    const existing = harness({ existingFpy: { id: 'fpy-1', spi_rate: 97.5 } });
    await existing.fp.importFpyFile(existing.event([['日期', '工單', 'SPI', 'AOI'], ['2026/10/15', '626090094', '', '100%']]));
    assert.equal(existing.writes[0].payload.spi_rate, 97.5);
    assert.equal(existing.writes[0].payload.aoi_rate, 100);
    assert.equal(existing.writes[0].operation, 'update');
});

test('mixed FPY batch only writes the valid file and identifies the rejected file', async () => {
    for (const files of [[fpy, defects], [defects, fpy]]) {
        const h = harness(); await h.fp.importFpyFile(h.event(...files));
        assert.equal(h.writes.length, 1); assert.equal(h.writes[0].table, 'daily_fpy');
        assert(h.messages.some(item => item.type === 'error' && /upload-\d.csv/.test(item.message)));
    }
});

test('missing/ambiguous headers are rejected; header whitespace, BOM and case are normalized', () => {
    const { validate } = harness();
    for (const rows of [[], [['日期', '工單'], ['2026/10/15', '626090094']],
        [['日期', '工單', 'AOI'], ['2026/10/15', '626090094', '100%']],
        [['日期工單', 'SPI', 'AOI'], ['2026/10/15', '', '100%']],
        [['日期', '工單', 'SPI AOI'], ['2026/10/15', '626090094', '100%']]]) {
        assert.throws(() => validate(rows, 'fpy'), /格式錯誤/);
    }
    const mixed = [['瑕疵項目', '日期', 'SPI', 'AOI', '工單'], ['缺件', '2026/10/15', '', '', '626090094']];
    assert.throws(() => validate(mixed, 'defects'), /同時包含/);
    assert.throws(() => validate(mixed, 'fpy'), /同時包含/);
    assert.throws(() => validate([['瑕疵項目'], ['缺件']], 'defects'), /位置代碼/);
    assert.doesNotThrow(() => validate([['\uFEFF 瑕疵項目 ', 'C1'], ['缺件', '']], 'defects'));
    assert.doesNotThrow(() => validate([[' 日期 ', '工單號碼', 'ｓｐｉ（％）', 'aoi (%)'], ['2026/10/15', '626090094', '', '100%']], 'fpy'));
});
