const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const utils = require('../js/daf-upload-utils.js');

const source = fs.readFileSync(require.resolve('../js/daf.js'), 'utf8');
function harness(handler, { staged = true } = {}) {
    const calls = [], delays = [];
    let invalidations = 0;
    const query = (kind, payload) => {
        const request = { kind, payload };
        const builder = {
            eq() { return builder; },
            in(column, ids) { request.payload = ids; return builder; },
            abortSignal(signal) { calls.push(request); return Promise.resolve(handler(request, signal)); }
        };
        return builder;
    };
    const ctx = {
        _supabase: {
            from: () => ({ upsert: rows => query('upsert', rows), delete: () => query('delete') }),
            rpc: (name, args) => query(name, args.p_mappings)
        },
        window: { SMT_DAF_UPLOAD_UTILS: utils, invalidateDataCache: async () => { invalidations++; } },
        isMissingDafImportRpc: error => ['PGRST202', '42883'].includes(error?.code),
        withDafRequestTimeout: promise => promise,
        DAF_REMOTE_REQUEST_TIMEOUT_MS: 20000, DAF_IMPORT_CHUNK_REQUEST_TIMEOUT_MS: 60000,
        setTimeout: (callback, delay) => { delays.push(delay); queueMicrotask(callback); },
        AbortController, console,
        REMOTE_TABLE: 'daf_log_batches', DAF_MACHINE_REFERENCE_LINE: '__DAF_MACHINE_REFERENCE__',
        DAF_MACHINE_REFERENCE_TTL_MS: 30 * 86400000,
        normalizeText: value => String(value || '').trim().toUpperCase(),
        isDafMachineLabel: value => ['1號機', '2號機'].includes(value),
        dafMachineReferenceId: key => `ref:${key}`,
        toDafMachineReferenceRemote: ref => ({ id: `ref:${ref.dedupKey}`, uploaded_at: ref.capturedAt, records: [ref] }),
        isDafStagedImportReady: async () => staged,
        dafMachineReferenceCache: new Map(), dafDetailLoadedLines: new Set(),
        dafStatsRawRowsCache: new Map(), dafDateIndexSource: null,
        dafDashboardCache: new Map(), dafStatsRangeCache: new Map()
    };
    const references = source.slice(source.indexOf('    const deleteDafMachineReferenceRows ='), source.indexOf('    const TEST_PROCESS_ALIASES ='));
    const retries = source.slice(source.indexOf('    const dafImportRetry ='), source.indexOf('    const DAF_FAILED_IMPORTS_KEY ='));
    vm.runInNewContext(`${references}\n${retries}\nthis.persist = persistDafMachineReferences;`, ctx);
    return { persist: ctx.persist, calls, delays, invalidations: () => invalidations };
}
const reference = (key, machine = '1號機') => ({ dedupKey: key, machine, capturedAt: '2026-10-14T01:02:03.000Z' });
const lockError = { code: '55P03', message: 'canceling statement due to lock timeout' };

test('機台參照鎖逾時後有限重試，內容與保存時間不變', async () => {
    let writes = 0;
    const h = harness(request => request.kind === 'upsert' && ++writes < 3 ? { error: lockError } : { data: 0 });
    const storedMap = new Map();
    assert.equal(await h.persist({ references: [reference('E2'), reference('E1')], storedMap }), true);
    const writesMade = h.calls.filter(call => call.kind === 'upsert');
    assert.equal(writesMade.length, 3);
    assert.deepEqual(writesMade[0].payload, writesMade[2].payload);
    assert.deepEqual(Array.from(writesMade[0].payload, row => row.id), ['ref:E1', 'ref:E2']);
    assert.equal(storedMap.size, 2);
    assert.equal(storedMap.get('E1').capturedAt, reference('E1').capturedAt);
    assert.ok(h.delays[0] >= 400 && h.delays[0] < 650);
    assert.ok(h.delays[1] >= 800 && h.delays[1] < 1050);
    assert.equal(h.calls.filter(call => call.kind === 'daf_update_machine_classification').length, 1);
});

test('既有機台分類被鎖時重試，成功後才清除相關快取', async () => {
    let updates = 0;
    const h = harness(request => request.kind === 'daf_update_machine_classification' && ++updates < 2
        ? { error: lockError } : { data: 1 });
    assert.equal(await h.persist({ references: [reference('E1')] }), true);
    assert.equal(updates, 2);
    assert.equal(h.invalidations(), 1);
});

test('刪除已比對參照遭鎖會重試，資料庫確認後才移除記憶體參照', async () => {
    let deletes = 0;
    const storedMap = new Map([['E1', { ...reference('E1'), id: 'ref:E1' }]]);
    const h = harness(request => {
        assert.equal(storedMap.size, 1);
        return request.kind === 'delete' && ++deletes === 1 ? { error: lockError } : { data: null };
    });
    assert.equal(await h.persist({ matchedKeys: ['E1'], storedMap }), true);
    assert.equal(deletes, 2);
    assert.equal(storedMap.size, 0);
});

test('持續鎖定最多四次，保留錯誤代碼與精確階段，不假報成功', async () => {
    const h = harness(() => ({ error: lockError }));
    const storedMap = new Map();
    let error;
    assert.equal(await h.persist({ references: [reference('E1')], storedMap, onError: value => { error = value; } }), false);
    assert.equal(h.calls.length, 4);
    assert.equal(error.code, '55P03');
    assert.match(error.message, /保存待比對機台參照/);
    assert.equal(storedMap.size, 0);
    assert.equal(h.invalidations(), 0);
});

test('非暫時性資料錯誤不重試，重複 E 欄只傳最後一筆', async () => {
    const h = harness(() => ({ error: { code: '23514', message: 'check constraint violation' } }));
    assert.equal(await h.persist({ references: [reference('E1'), reference('E1', '2號機')] }), false);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].payload.length, 1);
    assert.equal(h.calls[0].payload[0].records[0].machine, '2號機');
});
