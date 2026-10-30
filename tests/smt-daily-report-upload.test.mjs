import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const sourceRows = [
    ['製程','工單','料號','品名規格','良品數量','不良品數'],
    ['Back AOI','626100107','P1','M1',52,0],
    ['Front AOI','626100107','P1','M1',52,0],
    ['Back AOI','626100103','P2','M2',36,0],
    ['Back AOI','626100067','P3','M3',1534,18],
    ['Front AOI','626100067','P3','M3',1552,0],
    ['Front AOI','626100051','P4','M4',515,0],
    ['2D','626100107','P1','M1',99,0]
];

function createHarness({ missingOrder = null, rows = sourceRows, publishError = null } = {}) {
    const woKeys = [...new Set(rows.slice(1).filter(row => row[0] === 'Back AOI' || row[0] === 'Front AOI').map(row => `${row[1]}-${row[0] === 'Back AOI' ? 'BOT' : 'TOP'}`))];
    const orders = woKeys.map((key, index) => {
        const [wo_number, side] = key.split('-');
        return { id: String(100 + index), wo_number, line: 'SMT', target_quantity: 5000,
            models: { id: String(500 + index), line: 'SMT', name: `MODEL-${index}_${side}` } };
    }).filter(row => row.wo_number !== missingOrder);
    const calls = { from: [], rpc: [], cacheInvalidations: 0 };
    const data = { value: { workOrders: [], defectTypes: [{ id: 8, line: 'SMT', name: '缺件' }],
        defectLocations: [{ id: 9, line: 'SMT', code: 'C1' }] } };
    const ctx = { data, currentLine: { value: 'SMT' }, currentTab: { value: 'report' },
        toast: () => {}, loading: { value: false }, loadHistory: async () => {}, loadBaseData: async () => {},
        refreshDashboard: async () => {} };
    const window = { SMT: {}, getTaiwanDate: () => '2026-10-30',
        async invalidateDataCache() { calls.cacheInvalidations++; return true; } };
    const xlsx = { read(bytes) {
        if (bytes[0] === 1) return { Sheets: { Data: { tag: 'data' } }, SheetNames: ['Data','2D','Detail'] };
        return { Sheets: { CSV: { tag: 'defects' } }, SheetNames: ['CSV'] };
    }, utils: { sheet_to_json(sheet) { return sheet.tag === 'data' ? rows : [['瑕疵項目','C1'],['缺件',18]]; } } };
    const sandbox = vm.createContext({ window, console, XLSX: xlsx, crypto: webcrypto, TextEncoder,
        ref: value => ({ value }), computed: getter => ({ get value() { return getter(); } }),
        confirm: () => true,
        _supabase: {
            from(table) {
                const query = { table, filters: {} }; calls.from.push(query);
                const chain = {
                    select() { return chain; },
                    eq(key, value) { query.filters[key] = value; return chain; },
                    in(key, value) { query.filters[key] = value; return chain; },
                    then(resolve, reject) {
                        const result = table === 'work_orders' ? orders : table === 'daily_production' ? [] : [];
                        return Promise.resolve({ data: result, error: null }).then(resolve, reject);
                    }
                };
                return chain;
            },
            async rpc(name, args) {
                calls.rpc.push({ name, args });
                if (name === 'smt_publish_report_upload' && publishError) return { data: null, error: { message: publishError } };
                if (name === 'smt_publish_report_upload') return { data: { ok: true, duplicate: false, row_count: args.p_rows.length }, error: null };
                return { data: [], error: null };
            }
        }
    });
    sandbox.SMT = window.SMT;
    vm.runInContext(read('js/smt-import-validation.js'), sandbox);
    vm.runInContext(read('js/smt-report-upload.js'), sandbox);
    Object.assign(ctx, window.SMT.reportUpload(ctx));
    return { ctx, calls, sandbox };
}

test('Data parser keeps six AOI source rows independent, maps English A labels, ignores other process rows', () => {
    const window = { SMT: {} };
    const sandbox = vm.createContext({ window });
    sandbox.SMT = window.SMT;
    vm.runInContext(read('js/smt-report-upload.js'), sandbox);
    const parsed = window.SMT.parseSmtDailyReportData(sourceRows);
    assert.equal(parsed.rows.length, 6);
    assert.equal(parsed.excluded, 1);
    assert.deepEqual(Array.from(parsed.rows, row => row.input_qty), [52, 52, 36, 1552, 1552, 515]);
    assert.deepEqual(Array.from(parsed.rows, row => row.side), ['BOT','TOP','BOT','BOT','TOP','TOP']);
    assert.equal(parsed.rows[3].good_qty, 1534);
    assert.equal(parsed.rows[3].ng_qty, 18);
    assert.equal(parsed.rows[0].wo_number, '626100107');
});

test('same work order and model appearing on multiple source rows remains multiple report rows', async () => {
    const duplicatedRows = [...sourceRows.slice(0, 7), [...sourceRows[1]]];
    const { ctx } = createHarness({ rows: duplicatedRows });
    const file = { name: '1029-SMT.xlsx', async arrayBuffer() { return Uint8Array.of(1).buffer; } };
    await ctx.parseSmtReportFile({ target: { files: [file], value: '' } });
    const matching = ctx.smtUploadDraft.value.rows.filter(row => row.wo_number === '626100107' && row.side === 'BOT');
    assert.equal(ctx.smtUploadDraft.value.rows.length, 7);
    assert.equal(matching.length, 2);
    assert.equal(matching[0].wo_id, matching[1].wo_id);
    assert.equal(ctx.smtUploadDraft.value.issues.some(issue => issue.includes('重複')), false);
});

test('invalid Data sheet headers or numeric cells are rejected before database calls', () => {
    const window = { SMT: {} };
    const sandbox = vm.createContext({ window });
    sandbox.SMT = window.SMT;
    vm.runInContext(read('js/smt-report-upload.js'), sandbox);
    assert.throws(() => window.SMT.parseSmtDailyReportData([['A','B'],['Back AOI','1']]), /欄位不符/);
    const bad = sourceRows.map(row => [...row]);
    bad[1][4] = '52 pcs';
    assert.throws(() => window.SMT.parseSmtDailyReportData(bad), /非負整數/);
});

test('file preflight failure discards parsed rows and exposes only upload metadata and cause', async () => {
    const { ctx, calls } = createHarness({ missingOrder: '626100103' });
    const file = { name: '1029-SMT.xlsx', async arrayBuffer() { return Uint8Array.of(1).buffer; } };
    await ctx.parseSmtReportFile({ target: { files: [file], value: '' } });
    assert.equal(ctx.smtUploadDate.value, '2026-10-29');
    assert.equal(ctx.smtUploadDraft.value, null);
    assert.equal(ctx.smtUploadFailure.value.file_name, '1029-SMT.xlsx');
    assert.equal(ctx.smtUploadFailure.value.production_date, '2026-10-29');
    assert.match(ctx.smtUploadFailure.value.reason, /626100103/);
    assert.equal(calls.rpc.length, 0);
});

test('failed Excel parsing keeps no file bytes or parsed data and reports only file, date and reason', async () => {
    const badRows = [['製程','工單','料號','品名規格','良品數量','不良品數'],['Back AOI','626100107','P1','M1','bad',0]];
    const { ctx, calls } = createHarness({ rows: badRows });
    const file = { name: '1030-SMT.xlsx', async arrayBuffer() { return Uint8Array.of(1).buffer; } };
    await ctx.parseSmtReportFile({ target: { files: [file], value: '' } });
    assert.equal(ctx.smtUploadDraft.value, null);
    assert.deepEqual(Object.keys(ctx.smtUploadFailure.value).sort(), ['file_name','production_date','reason']);
    assert.equal(ctx.smtUploadFailure.value.file_name, file.name);
    assert.equal(ctx.smtUploadFailure.value.production_date, '2026-10-30');
    assert.match(ctx.smtUploadFailure.value.reason, /非負整數/);
    assert.equal(calls.rpc.length, 0);
});

test('invalid defect CSV discards the complete uncommitted workbook draft', async () => {
    const { ctx, calls } = createHarness();
    const file = { name: '1030-SMT.xlsx', async arrayBuffer() { return Uint8Array.of(1).buffer; } };
    await ctx.parseSmtReportFile({ target: { files: [file], value: '' } });
    const ngRow = ctx.smtUploadDraft.value.rows.find(row => row.ng_qty > 0);
    await ctx.parseSmtDefectFile({ target: { files: [{ name: 'wrong-work-order.csv', async arrayBuffer() { return Uint8Array.of(2).buffer; } }], value: '' } }, ngRow);
    assert.equal(ctx.smtUploadDraft.value, null);
    assert.equal(ctx.smtUploadFailure.value.file_name, '1030-SMT.xlsx');
    assert.equal(ctx.smtUploadFailure.value.production_date, '2026-10-30');
    assert.match(ctx.smtUploadFailure.value.reason, /wrong-work-order\.csv/);
    assert.equal(calls.rpc.length, 0);
});

test('valid file publishes six separate report rows with exact E+F inputs and defect CSV bound to the NG row', async () => {
    const { ctx, calls } = createHarness();
    const file = { name: '1029-SMT.xlsx', async arrayBuffer() { return Uint8Array.of(1).buffer; } };
    await ctx.parseSmtReportFile({ target: { files: [file], value: '' } });
    assert.equal('bytes' in ctx.smtUploadDraft.value, false);
    assert.match(ctx.smtUploadDraft.value.content_hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(Array.from(ctx.smtUploadDraft.value.rows, row => row.input_qty), [52, 52, 36, 1552, 1552, 515]);
    const ngRow = ctx.smtUploadDraft.value.rows.find(row => row.ng_qty > 0);
    const defectFile = { name: `20261029_${ngRow.wo_number}.csv`, async arrayBuffer() { return Uint8Array.of(2).buffer; } };
    await ctx.parseSmtDefectFile({ target: { files: [defectFile], value: '' } }, ngRow);
    await ctx.publishSmtReportUpload();
    const published = calls.rpc.find(call => call.name === 'smt_publish_report_upload');
    assert.ok(published);
    assert.equal(published.args.p_production_date, '2026-10-29');
    assert.equal(published.args.p_rows.length, 6);
    assert.deepEqual(Array.from(published.args.p_rows, row => row.input_qty), [52, 52, 36, 1552, 1552, 515]);
    assert.equal(published.args.p_rows[3].defects[0].quantity, 18);
    assert.equal(published.args.p_rows[3].defect_file_name, defectFile.name);
    assert.equal(calls.cacheInvalidations, 1);
    assert.equal(ctx.smtUploadDraft.value, null);
});

test('database publish failure discards draft and displays only file name, date and error cause', async () => {
    const { ctx, calls } = createHarness({ publishError: 'statement timeout' });
    const file = { name: '1029-SMT.xlsx', async arrayBuffer() { return Uint8Array.of(1).buffer; } };
    await ctx.parseSmtReportFile({ target: { files: [file], value: '' } });
    const ngRow = ctx.smtUploadDraft.value.rows.find(row => row.ng_qty > 0);
    const defectFile = { name: `20261029_${ngRow.wo_number}.csv`, async arrayBuffer() { return Uint8Array.of(2).buffer; } };
    await ctx.parseSmtDefectFile({ target: { files: [defectFile], value: '' } }, ngRow);
    await ctx.publishSmtReportUpload();
    assert.equal(calls.rpc.filter(call => call.name === 'smt_publish_report_upload').length, 1);
    assert.equal(ctx.smtUploadDraft.value, null);
    assert.equal(ctx.smtUploadFailure.value.file_name, '1029-SMT.xlsx');
    assert.equal(ctx.smtUploadFailure.value.production_date, '2026-10-29');
    assert.match(ctx.smtUploadFailure.value.reason, /statement timeout/);
    assert.equal(Object.keys(ctx.smtUploadFailure.value).length, 3);
});

test('migration uses bigint production IDs, one insert per Excel row, and guards deletion of edited records', () => {
    const sql = read('supabase/smt_report_upload.sql');
    assert.match(sql, /v_production_id bigint/);
    assert.match(sql, /returning id into v_production_id/);
    assert.match(sql, /returning id into v_log_id/);
    assert.match(sql, /Deliberately insert one daily_production row per source Excel row/);
    assert.match(sql, /sum\(\(x\.value->>'input_qty'\)::integer\)/);
    assert.match(sql, /pg_advisory_xact_lock/);
    assert.match(sql, /current_account_id\(\)/);
    assert.match(sql, /Refuse to remove a batch if any production\/defect row has been edited or removed/);
    assert.match(sql, /production_date, content_hash/);
    assert.ok(sql.indexOf('Validate every report row') < sql.indexOf('insert into public.smt_report_upload_batches'));
    assert.ok(sql.indexOf('insert into public.smt_report_upload_batches') < sql.indexOf('insert into public.daily_production'));
});

test('SMT upload failure dialog only renders filename, date and cause', () => {
    const html = read('index.html');
    const start = html.indexOf('id="smt-upload-failure-title"');
    const end = html.indexOf('</div>\n            </div>', start);
    const dialog = html.slice(start, end);
    assert.match(dialog, /smtUploadFailure\.file_name/);
    assert.match(dialog, /smtUploadFailure\.production_date/);
    assert.match(dialog, /smtUploadFailure\.reason/);
    assert.doesNotMatch(dialog, /smtUploadDraft|source_row|wo_number|input_qty|defects/);
});
