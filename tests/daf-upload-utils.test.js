const test = require('node:test');
const assert = require('node:assert/strict');
const { splitRecordsIntoChunks, hashPayload, isRetryableUploadError } = require('../js/daf-upload-utils.js');

test('splits records at the row bound without changing order or contents', () => {
    const records = Array.from({ length: 1201 }, (_, index) => ({ index, raw: ['測試', index] }));
    const chunks = splitRecordsIntoChunks(records);
    assert.deepEqual(chunks.map(chunk => chunk.length), [500, 500, 201]);
    assert.deepEqual(chunks.flat(), records);
});

test('splits by UTF-8 payload bytes and keeps each chunk within its bound', () => {
    const records = Array.from({ length: 9 }, (_, index) => ({ index, raw: ['繁體中文字'.repeat(80)] }));
    const maxBytes = 2500;
    const chunks = splitRecordsIntoChunks(records, { maxRows: 20, maxBytes });
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) assert.ok(Buffer.byteLength(JSON.stringify(chunk), 'utf8') <= maxBytes);
    assert.deepEqual(chunks.flat(), records);
});

test('rejects a single record larger than the transport chunk limit', () => {
    assert.throws(() => splitRecordsIntoChunks([{ raw: ['x'.repeat(1024)] }], { maxBytes: 100 }), /超過分批上傳容量/);
});

test('creates repeatable content hashes and changes them when payload changes', async () => {
    const first = await hashPayload('[{"E":"A"}]');
    assert.equal(await hashPayload('[{"E":"A"}]'), first);
    assert.notEqual(await hashPayload('[{"E":"B"}]'), first);
});

test('does not retry PostgreSQL statement timeouts, but retries transient HTTP/network errors', () => {
    assert.equal(isRetryableUploadError({ code: '57014', message: 'canceling statement due to statement timeout' }), false);
    assert.equal(isRetryableUploadError({ status: 429 }), true);
    assert.equal(isRetryableUploadError({ code: '55P03', message: 'canceling statement due to lock timeout' }), true);
    assert.equal(isRetryableUploadError(new Error('Failed to fetch')), true);
    assert.equal(isRetryableUploadError(new Error('上傳請求逾時')), true);
    assert.equal(isRetryableUploadError({ code: '23505', message: 'unique violation' }), false);
});
