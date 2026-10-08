const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(handler, initial = {}) {
    const calls = [];
    const storage = new Map(Object.entries(initial));
    let serial = 0;
    const context = {
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        window: { crypto: { randomUUID: () => `fresh-${++serial}` }, invalidateDataCache: async () => true },
        _supabase: { rpc: (name, args) => ({ abortSignal: () => {
            calls.push({ name, args });
            return handler(name, args);
        } }) },
        dafImportRetry: async callback => {
            const result = await callback(new AbortController().signal);
            if (result.error) throw result.error;
            return result.data;
        },
        withDafRequestTimeout: promise => promise,
        splitDafRecordsIntoChunks: records => [records],
        hashDafImportPayload: async () => 'hash',
        toRemote: batch => ({ ...batch }),
        currentDafLine: () => 'DAF', processLabel: line => line,
        setDafUploadProgress() {},
        DAF_IMPORT_CHUNK_REQUEST_TIMEOUT_MS: 60000, DAF_FINALIZE_REQUEST_TIMEOUT_MS: 60000,
        AbortController, console
    };
    const source = fs.readFileSync(require.resolve('../js/daf.js'), 'utf8');
    const block = source.slice(source.indexOf('    const DAF_FAILED_IMPORTS_KEY'), source.indexOf('    const saveRemote = async'));
    vm.runInNewContext(`${block}\nthis.upload = uploadDafBatchesStaged;`, context);
    return { upload: context.upload, calls, storage };
}
const file = { name: 'test.xlsx', size: 12, lastModified: 34 };
const batches = [{ line: 'DAF', records: [{ dedupKey: 'E' }] }];
const success = name => ({ data: name === 'daf_finalize_log_import'
    ? { published: true, accepted_count: 1 } : { status: 'receiving', cleared: true } });

test('each selection starts a fresh job rather than resuming previous chunks', async () => {
    const h = harness(success);
    await h.upload(file, batches);
    await h.upload(file, batches);
    const jobs = h.calls.filter(call => call.name === 'daf_start_log_import').map(call => call.args.p_job_id);
    assert.deepEqual(jobs, ['fresh-1', 'fresh-2']);
});
test('failed chunks are cleared and reported instead of silently resuming', async () => {
    const h = harness(name => name === 'daf_stage_log_import_chunk'
        ? { error: new Error('57014 timeout') }
        : name === 'daf_get_log_import_status' ? { data: { received_chunks: 0 } } : success(name));
    await assert.rejects(h.upload(file, batches), /本次未發布暫存已清除/);
    assert.ok(h.calls.some(call => call.name === 'daf_abort_log_import'));
    assert.ok(!h.calls.some(call => call.name === 'daf_finalize_log_import'));
});
test('unconfirmed previous cleanup prevents any fresh upload from starting', async () => {
    const h = harness(() => ({ error: new Error('network offline') }), {
        'production-daf-failed-import-cleanup-v1': '["previous-job"]'
    });
    await assert.rejects(h.upload(file, batches), /network offline/);
    assert.deepEqual(h.calls.map(call => call.name), ['daf_abort_log_import']);
});
test('lost publication response is treated as success and preserves published data', async () => {
    const h = harness(name => {
        if (name === 'daf_finalize_log_import') return { error: new Error('lost response') };
        if (name === 'daf_get_log_import_status') return { data: { status: 'unknown' } };
        if (name === 'daf_abort_log_import') return { data: { published: true, accepted_count: 1 } };
        return success(name);
    });
    assert.equal((await h.upload(file, batches)).acceptedCount, 1);
});
