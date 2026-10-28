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

test.after(() => {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
    }
});
