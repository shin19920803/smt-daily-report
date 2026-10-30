const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

const saved = {
    Vue: globalThis.Vue,
    SMT: globalThis.SMT,
    _supabase: globalThis._supabase,
    crypto: globalThis.crypto,
    getTaiwanDate: globalThis.getTaiwanDate,
    shiftDateByDays: globalThis.shiftDateByDays,
    formatTaiwanDateTime: globalThis.formatTaiwanDateTime
};

globalThis.crypto = crypto.webcrypto;
globalThis.getTaiwanDate = () => '2026-10-28';
globalThis.shiftDateByDays = (dateValue, offset) => {
    const date = new Date(`${dateValue}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
};
globalThis.formatTaiwanDateTime = value => value || '';
let mountHook;
globalThis.Vue = {
    ref: value => ({ value }),
    computed: getter => Object.defineProperty({}, 'value', { get: getter }),
    watch: () => {},
    nextTick: () => Promise.resolve(),
    onMounted: callback => { mountHook = callback; },
    onBeforeUnmount: () => {}
};

const { AutoTesterPanel } = (() => {
    require('../js/auto-tester.js');
    return { AutoTesterPanel: globalThis.SMT.AutoTesterPanel };
})();

test('report upload sends only date and QR hashes, updates the shared file list, and reports completion', async () => {
    let revision = 0;
    const storedFiles = [];
    const calls = [];
    globalThis._supabase = { async rpc(name, args = {}) {
        calls.push({ name, args });
        if (name === 'auto_tester_get_state') return { data: { revision }, error: null };
        if (name === 'auto_tester_list_files') return { data: {
            revision,
            total_count: storedFiles.length,
            files: storedFiles.map(file => ({ ...file, report_dates: ['2026-10-21'], qr_count: 2 }))
        }, error: null };
        if (name === 'auto_tester_publish_file') {
            assert.equal(args.p_entries.length, 2, 'duplicate QR rows in one file are removed before upload');
            assert(args.p_entries.every(entry => Object.keys(entry).sort().join(',') === 'qr_hash,report_date'));
            const file = { id: 'test-file-id', file_name: args.p_file_name, uploaded_at: '2026-10-28 10:00:00' };
            storedFiles.push(file);
            revision++;
            return { data: { status: 'published', file_id: file.id, revision }, error: null };
        }
        throw new Error(`Unexpected RPC ${name}`);
    } };

    const panel = AutoTesterPanel.setup({ view: 'report' });
    const csv = 'ChipID,QRCode,PID,Result,Error,Time\nx,QR-A,p,Pass,,20261021-083630\nx,QR-A,p,Fail,,20261021-091737\nx,QR-B,p,Pass,,20261021-091748';
    const bytes = Buffer.from(csv, 'utf8');
    await panel.handleUpload({ target: { files: [{ name: 'test.csv', size: bytes.length,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }], value: 'selected' } });

    assert.equal(panel.error.value, '');
    assert.match(panel.notice.value, /上傳完成：2 筆 QR CODE/);
    assert.equal(panel.files.value.length, 1);
    assert.equal(panel.fileTotal.value, 1);
    const serializedPayload = JSON.stringify(calls.find(call => call.name === 'auto_tester_publish_file').args);
    assert.equal(serializedPayload.includes('QR-A'), false);
    assert.equal(serializedPayload.includes('QR-B'), false);
});

test('classic browser scripts can use the Supabase global lexical const without window._supabase', async () => {
    let revision = 0;
    const calls = [];
    const rpcClient = { async rpc(name, args = {}) {
        calls.push({ name, args });
        if (name === 'auto_tester_get_state') return { data: { revision }, error: null };
        if (name === 'auto_tester_get_summary') return { data: { revision, daily: [] }, error: null };
        if (name === 'auto_tester_list_files') return { data: { revision, total_count: 0, files: [] }, error: null };
        if (name === 'auto_tester_publish_file') {
            revision++;
            return { data: { status: 'published', file_id: 'browser-test-file', revision }, error: null };
        }
        throw new Error(`Unexpected RPC ${name}`);
    } };
    const browser = {
        Vue: {
            ref: value => ({ value }),
            computed: getter => Object.defineProperty({}, 'value', { get: getter }),
            watch: () => {},
            onMounted: () => {},
            onBeforeUnmount: () => {}
        },
        SMT: {},
        crypto: crypto.webcrypto,
        TextEncoder,
        TextDecoder,
        getTaiwanDate: () => '2026-10-28',
        shiftDateByDays: (dateValue, offset) => {
            const date = new Date(`${dateValue}T00:00:00Z`);
            date.setUTCDate(date.getUTCDate() + offset);
            return date.toISOString().slice(0, 10);
        },
        formatTaiwanDateTime: value => value || '',
        document: { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} },
        addEventListener: () => {},
        removeEventListener: () => {},
        supabaseMock: rpcClient
    };
    browser.window = browser;
    const context = vm.createContext(browser);
    vm.runInContext('const _supabase = supabaseMock; delete globalThis.supabaseMock;', context);
    assert.equal(vm.runInContext('typeof _supabase', context), 'object');
    assert.equal(vm.runInContext('typeof window._supabase', context), 'undefined');
    vm.runInContext(fs.readFileSync(require.resolve('../js/auto-tester.js'), 'utf8'), context);

    const panel = context.SMT.AutoTesterPanel.setup({ view: 'report' });
    await panel.refresh();
    assert(calls.some(call => call.name === 'auto_tester_list_files'), 'file-list RPC must use the lexical Supabase client');

    const csv = 'ChipID,QRCode,PID,Result,Error,Time\nx,QR-BROWSER,p,Pass,,20261028-083630';
    const bytes = Buffer.from(csv, 'utf8');
    await panel.handleUpload({ target: { files: [{ name: 'browser.csv', size: bytes.length,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }], value: 'selected' } });
    assert.equal(panel.error.value, '');
    assert.match(panel.notice.value, /上傳完成：1 筆 QR CODE/);
    assert(calls.some(call => call.name === 'auto_tester_publish_file'), 'upload RPC must use the lexical Supabase client');
});

test('missing Supabase client shows an actionable error and always clears loading state', async () => {
    const previousClient = globalThis._supabase;
    delete globalThis._supabase;
    try {
        const panel = AutoTesterPanel.setup({ view: 'report' });
        await panel.refresh();
        assert.match(panel.error.value, /資料庫服務尚未就緒/);
        assert.equal(panel.loading.value, false);
    } finally {
        if (previousClient === undefined) delete globalThis._supabase;
        else globalThis._supabase = previousClient;
    }
});

test('auto tester statistics quick ranges set Taiwan-date day, previous Sunday-Saturday week, and previous month without loading', async () => {
    const calls = [];
    globalThis._supabase = { async rpc(name) {
        calls.push(name);
        if (name === 'auto_tester_get_state') return { data: { revision: 1 }, error: null };
        if (name === 'auto_tester_get_summary') return { data: { revision: 1, daily: [] }, error: null };
        throw new Error(`Unexpected RPC ${name}`);
    } };
    const panel = AutoTesterPanel.setup({ view: 'stats' });

    await panel.setStatsQuickMode('day');
    assert.equal(panel.statsStart.value, '2026-10-28');
    assert.equal(panel.statsEnd.value, '2026-10-28');
    assert.equal(panel.statsQuickLabel.value, '2026-10-28 (週三)');
    assert.equal(panel.statsQuickRelative.value, '本日');
    await panel.shiftStatsQuick(-1);
    assert.equal(panel.statsStart.value, '2026-10-27');

    await panel.setStatsQuickMode('week');
    assert.equal(panel.statsStart.value, '2026-10-18');
    assert.equal(panel.statsEnd.value, '2026-10-24');
    assert.equal(panel.statsQuickLabel.value, '2026-10-18 ~ 10-24');
    await panel.setStatsQuickMode('month');
    assert.equal(panel.statsStart.value, '2026-09-01');
    assert.equal(panel.statsEnd.value, '2026-09-30');
    assert.equal(panel.statsQuickLabel.value, '2026 年 9 月');
    assert.deepEqual(calls, [], 'choosing or shifting a quick range does not request statistics automatically');
    assert.match(AutoTesterPanel.template, /自動測試機快捷統計區間/);
});

test('auto tester overview trend shows only nonzero production dates within the latest 14 days', () => {
    const panel = AutoTesterPanel.setup({ view: 'dashboard' });
    panel.dashboardRows.value = [
        { report_date: '2026-10-14', daily_count: 9 },
        { report_date: '2026-10-15', daily_count: 2 },
        { report_date: '2026-10-21', daily_count: 0 },
        { report_date: '2026-10-28', daily_count: 5 }
    ];
    assert.deepEqual(panel.trendDays.value, [
        { date: '2026-10-15', count: 2 },
        { date: '2026-10-28', count: 5 }
    ]);
    assert.match(AutoTesterPanel.template, /每日產能趨勢/);
    assert.match(AutoTesterPanel.template, /近 14 日投入量｜僅顯示有數據日期/);
    assert.match(AutoTesterPanel.template, /近 14 日每日產能直條圖/);
});

const csvFile = (name, rows) => {
    const bytes = Buffer.from('ChipID,QRCode,PID,Result,Error,Time\n' + rows.map(([qr, time = '20261028-083630']) => `x,${qr},p,Pass,,${time}`).join('\n'));
    return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
};
const uploadEvent = files => ({ target: { files, value: 'selected' } });
const batchStore = () => {
    const stored = new Map(), calls = [];
    let revision = 0, nextId = 1, failReplacement = false;
    globalThis._supabase = { async rpc(name, args = {}) {
        calls.push({ name, args });
        if (name === 'auto_tester_get_state') return { data: { revision }, error: null };
        if (name === 'auto_tester_list_files') return { data: { revision, total_count: stored.size,
            files: [...stored.values()].map(file => ({ id: file.id, file_name: file.name,
                qr_count: file.entries.length, report_dates: [...new Set(file.entries.map(row => row.report_date))] })) }, error: null };
        if (name === 'auto_tester_get_summary') {
            const days = new Map();
            for (const file of stored.values()) for (const row of file.entries) {
                if (row.report_date < args.p_start || row.report_date > args.p_end) continue;
                if (!days.has(row.report_date)) days.set(row.report_date, new Set());
                days.get(row.report_date).add(row.qr_hash);
            }
            return { data: { revision, daily: [...days].map(([report_date, keys]) => ({ report_date, daily_count: keys.size })) }, error: null };
        }
        if (name === 'auto_tester_publish_file') {
            const existing = stored.get(args.p_file_name);
            if (existing?.sha === args.p_file_sha256) return { data: { status: 'duplicate', revision }, error: null };
            if (existing && !args.p_replace_file_id) return { data: { status: 'confirmation_required', existing_file_id: existing.id }, error: null };
            if (existing && failReplacement) { failReplacement = false; return { data: null, error: { message: '模擬取代失敗' } }; }
            if (existing) assert.equal(args.p_replace_file_id, existing.id);
            const file = { id: `file-${nextId++}`, name: args.p_file_name, sha: args.p_file_sha256, entries: args.p_entries };
            stored.set(file.name, file);
            return { data: { status: 'published', file_id: file.id, revision: ++revision }, error: null };
        }
        throw new Error(`Unexpected RPC ${name}`);
    } };
    return { stored, calls, failNextReplacement: () => { failReplacement = true; } };
};

test('one multi-file selection merges overlapping QR codes by date and refreshes the combined statistics', async () => {
    const store = batchStore();
    const props = { view: 'report' }, panel = AutoTesterPanel.setup(props);
    const event = uploadEvent([
        csvFile('morning.csv', [['QR-A'], ['QR-B'], ['QR-A', '20261029-083630']]),
        csvFile('evening.csv', [['QR-B'], ['QR-C']])
    ]);
    await panel.handleUpload(event);
    assert.equal(event.target.value, '');
    assert.equal(panel.error.value, '');
    assert.equal(panel.uploadBusy.value, false);
    assert.equal(store.stored.size, 2);
    assert.equal(panel.fileTotal.value, 2);
    assert.match(panel.notice.value, /上傳 2 個/);
    assert.match(panel.notice.value, /合併後 4 筆 QR CODE/);
    assert.equal(store.calls.filter(call => call.name === 'auto_tester_list_files').length, 1,
        'batch completion refreshes once instead of querying the whole file list after each file');
    props.view = 'stats'; panel.statsStart.value = '2026-10-28'; panel.statsEnd.value = '2026-10-29';
    await panel.loadStats();
    assert.deepEqual(panel.statsRows.value, [
        { report_date: '2026-10-28', daily_count: 3 }, { report_date: '2026-10-29', daily_count: 1 }
    ]);
    assert.equal(panel.statsTotal.value, 4);
    props.view = 'dashboard'; await panel.refresh();
    assert.equal(panel.todayCount.value, 3);
    assert.equal(panel.lastSevenCount.value, 3);
    assert.equal(JSON.stringify(store.calls).includes('QR-A'), false, 'raw QR values never leave the browser');
    assert.match(AutoTesterPanel.template, /type="file"[^>]*\bmultiple\b/);
});

test('duplicate files in a batch do not inflate totals and an invalid file does not drop later valid files', async () => {
    const store = batchStore(), panel = AutoTesterPanel.setup({ view: 'report' });
    const a = csvFile('a.csv', [['QR-A']]);
    await panel.handleUpload(uploadEvent([a, a, csvFile('bad.csv', [['QR-B', 'invalid']]), csvFile('b.csv', [['QR-B']])]));
    assert.equal(store.stored.size, 2);
    assert.match(panel.notice.value, /上傳 2 個、重複 1 個、略過 0 個、失敗 1 個/);
    assert.match(panel.notice.value, /合併後 2 筆/);
    assert.match(panel.error.value, /bad.csv.*時間格式無效/);
    assert.equal(store.calls.some(call => call.name === 'auto_tester_publish_file' && call.args.p_file_name === 'bad.csv'), false);
    assert.equal(panel.uploadBusy.value, false);
});

test('replacement confirmation pauses and then continues the remaining batch without losing files', async () => {
    const store = batchStore(), panel = AutoTesterPanel.setup({ view: 'report' });
    await panel.handleUpload(uploadEvent([csvFile('same.csv', [['QR-OLD']])]));
    await panel.handleUpload(uploadEvent([
        csvFile('before.csv', [['QR-A']]), csvFile('same.csv', [['QR-NEW']]), csvFile('after.csv', [['QR-C']])
    ]));
    assert.equal(panel.pendingReplacement.value.payload.fileName, 'same.csv');
    assert.equal(store.stored.has('after.csv'), false);
    assert.equal(panel.uploadBusy.value, false);
    await panel.handleUpload(uploadEvent([csvFile('unrelated.csv', [['QR-X']])]));
    assert.equal(store.stored.has('unrelated.csv'), false, 'another selection cannot overwrite a paused batch');
    store.failNextReplacement();
    await panel.confirmReplacement();
    assert.match(panel.error.value, /模擬取代失敗/);
    assert.ok(panel.pendingReplacement.value);
    assert.equal(store.stored.has('after.csv'), false);
    await panel.confirmReplacement();
    assert.equal(panel.pendingReplacement.value, null);
    assert.equal(panel.error.value, '');
    assert.equal(store.stored.size, 3);
    assert.match(panel.notice.value, /上傳 3 個/);
    assert.match(panel.notice.value, /合併後 3 筆/);
});

test('skipping one replacement preserves its original content and continues the other selected files', async () => {
    const store = batchStore(), panel = AutoTesterPanel.setup({ view: 'report' });
    await panel.handleUpload(uploadEvent([csvFile('same.csv', [['QR-OLD']])]));
    const original = store.stored.get('same.csv');
    await panel.handleUpload(uploadEvent([csvFile('same.csv', [['QR-NEW']]), csvFile('next.csv', [['QR-B']])]));
    await panel.skipReplacement();
    assert.equal(panel.pendingReplacement.value, null);
    assert.equal(store.stored.get('same.csv'), original);
    assert.equal(store.stored.has('next.csv'), true);
    assert.match(panel.notice.value, /上傳 1 個、重複 0 個、略過 1 個/);
    assert.match(panel.notice.value, /合併後 1 筆/);
});

test('a concurrent upload event cannot replace the running file queue', async () => {
    const store = batchStore(), panel = AutoTesterPanel.setup({ view: 'report' });
    const first = panel.handleUpload(uploadEvent([csvFile('a.csv', [['QR-A']]), csvFile('b.csv', [['QR-B']])]));
    await panel.handleUpload(uploadEvent([csvFile('unexpected.csv', [['QR-C']])]));
    await first;
    assert.deepEqual([...store.stored.keys()], ['a.csv', 'b.csv']);
    assert.equal(panel.uploadBusy.value, false);
});

test('replacing the same filename within one selection removes its superseded contribution from the combined count', async () => {
    const store = batchStore(), props = { view: 'report' }, panel = AutoTesterPanel.setup(props);
    await panel.handleUpload(uploadEvent([
        csvFile('same.csv', [['QR-A'], ['QR-B']]), csvFile('same.csv', [['QR-C']])
    ]));
    assert.ok(panel.pendingReplacement.value);
    await panel.confirmReplacement();
    assert.equal(store.stored.size, 1);
    assert.equal(panel.fileTotal.value, 1);
    assert.match(panel.notice.value, /合併後 1 筆/);
    props.view = 'stats'; await panel.loadStats();
    assert.equal(panel.statsTotal.value, 1);
});

test.after(() => {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
    }
});
