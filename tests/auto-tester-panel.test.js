const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');

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

test.after(() => {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
    }
});
