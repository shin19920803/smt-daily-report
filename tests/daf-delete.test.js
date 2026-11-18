const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../js/daf.js'), 'utf8');
function harness({ rpcError, remaining = {}, verifyError, refreshError } = {}) {
    const calls = [], notices = [];
    const c = {
        cleanText: x => String(x).trim(), REMOTE_TABLE: 'daf_log_batches', TEST_PROCESS_IDS: ['DAF','FT1','FT2','LIGHTING','ASSEMBLY'],
        dafRemoteError: { value: '' }, ref: value => ({ value }),
        isDafStagedImportReady: async () => true,
        withDafRequestTimeout: promise => promise,
        runDafImportRequest: async (...args) => {
            calls.push(args);
            if (args[0] === 'daf_log_file_exists') {
                if (verifyError) throw verifyError;
                return Object.values(remaining).some(rows => rows.length);
            }
            if (rpcError) throw rpcError;
            return true;
        },
        _supabase: { from: table => {
            const query = { select() { return this; }, in() { return this; }, eq() { return this; },
                limit() { return Promise.resolve({ data: remaining[table] || [], error: verifyError }); } };
            return query;
        } },
        dafBatches: { value: [] }, dafSummaryBatches: { value: [{ id: 'a', fileName: 'file.xlsx' }] },
        dafUploadInProgress: false, confirm: () => true, dafLoadRequestId: 0,
        removeLocalDafFileBatches: name => calls.push(['remove',name]),
        clearDafProcessDerivedState: line => calls.push(['invalidate', line]),
        invalidateDafSummaryCache: async () => true,
        loadDafData: async options => { calls.push(['refresh', options]); if (refreshError) throw refreshError; },
        dafRemoteReady: { value: true }, isUnifiedTestLine: () => false,
        toast: (...args) => notices.push(args), console
    };
    vm.createContext(c);
    vm.runInContext(source.slice(source.indexOf('    const deleteRemoteDafFileBatches ='),source.indexOf('    const removeLocalDafFileBatches ='))
        + source.slice(source.indexOf('    const dafDeletingFile ='),source.indexOf('    let reasonChart ='))
        + '\nthis.remove=deleteRemoteDafFileBatches;this.click=deleteDafBatch;this.busy=dafDeletingFile;this.failure=dafDeleteError;', c);
    return { c, calls, notices };
}
test('RPC 逾時但伺服器已刪除時確認兩個來源，不重複送刪除', async () => {
    const { c, calls } = harness({ rpcError: new Error('lost response') });
    assert.equal(await c.remove('file.xlsx'), true);
    assert.equal(calls.filter(call => call[0] === 'daf_delete_log_file').length, 1);
    assert.equal(calls[0][4], 1);
});
test('有效檔案或摘要任一仍存在，就不假報刪除成功', async () => {
    for (const table of ['daf_log_active_file_processes','daf_log_batches']) {
        const { c, calls, notices } = harness({ remaining: { [table]: [{ id: 'a' }] } });
        await c.click('a');
        assert.equal(c.busy.value, '');
        assert.match(c.failure.value, /仍保留/);
        assert.equal(calls.some(x => x[0] === 'remove'), false);
        assert.equal(notices.at(-1)[1], 'error');
    }
});
test('查核失敗保留清單並顯示原因', async () => {
    const { c } = harness({ verifyError: { message: '查核連線失敗', code: '57014' } });
    await c.click('a');
    assert.match(c.failure.value, /57014/);
});
test('已確認刪除後只允許權威清單刷新；同步失敗不誤報資料庫刪除失敗', async () => {
    const { c, calls } = harness({ refreshError: new Error('refresh timeout') });
    await c.click('a');
    assert.equal(calls.find(x => x[0] === 'refresh')[1].authoritative, true);
    assert.match(c.failure.value, /資料庫已刪除/);
    assert.equal(c.busy.value, '');
});
test('重複點擊及上傳期間不發出重複刪除', async () => {
    const { c, calls } = harness();
    let resolve;
    c.runDafImportRequest = name => { if (name === 'daf_log_file_exists') return false; calls.push(['rpc']); return new Promise(r => { resolve = r; }); };
    const first = c.click('a');
    await Promise.resolve();
    await c.click('a');
    resolve(true);
    await first;
    assert.equal(calls.filter(x => x[0] === 'rpc').length, 1);
    c.dafUploadInProgress = true;
    await c.click('a');
    assert.equal(calls.filter(x => x[0] === 'rpc').length, 1);
});
