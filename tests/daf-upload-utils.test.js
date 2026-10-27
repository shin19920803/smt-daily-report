const test = require('node:test');
const assert = require('node:assert/strict');
const { splitRecordsIntoChunks, hashPayload, isRetryableUploadError, selectWorkbookSheet, readWorkbookRows } = require('../js/daf-upload-utils.js');

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

test('selects the exact Detail worksheet regardless of its position', () => {
    for (const detailIndex of [0, 1, 2]) {
        const names = ['2D', 'Data', 'Detail'];
        [names[detailIndex], names[2]] = [names[2], names[detailIndex]];
        const sheets = Object.fromEntries(names.map(name => [name, { name, rows: [[name]] }]));
        assert.equal(selectWorkbookSheet({ SheetNames: names, Sheets: sheets }, { requireDetail: true }).name, 'Detail');
    }
});

test('reads only Detail rows and ignores decoy data in 2D and Data worksheets', () => {
    const workbook = {
        SheetNames: ['2D', 'Data', 'Detail'],
        Sheets: {
            '2D': { rows: [['DAF', 'DECOY_2D']] },
            Data: { rows: [['FT1', 'DECOY_DATA']] },
            Detail: { rows: [['DAF', 'REAL_DETAIL']] }
        }
    };
    const rows = readWorkbookRows(workbook, {
        requireDetail: true,
        sheetToJson: sheet => sheet.rows,
        isNonEmptyRow: row => row.some(cell => String(cell).trim())
    });
    assert.deepEqual(rows, [['DAF', 'REAL_DETAIL']]);
});

test('does not fall back to another sheet when Detail is missing or only a near-match exists', () => {
    for (const names of [['2D', 'Data'], ['Detail_backup', '2D', 'Data']]) {
        const sheets = Object.fromEntries(names.map(name => [name, { name }]));
        assert.throws(
            () => selectWorkbookSheet({ SheetNames: names, Sheets: sheets }, { requireDetail: true }),
            /找不到 Detail 工作表.*其他工作表不會匯入/
        );
    }
});

test('rejects a blank Detail worksheet without reading decoy sheets as a fallback', () => {
    const workbook = {
        SheetNames: ['2D', 'Data', 'Detail'],
        Sheets: { '2D': { rows: [['DAF']] }, Data: { rows: [['FT1']] }, Detail: { rows: [['', '  ']] } }
    };
    let convertedSheet;
    assert.throws(() => readWorkbookRows(workbook, {
        requireDetail: true,
        sheetToJson: sheet => { convertedSheet = sheet; return sheet.rows; },
        isNonEmptyRow: row => row.some(cell => String(cell).trim())
    }), /Detail 工作表是空白的/);
    assert.equal(convertedSheet, workbook.Sheets.Detail);
});

test('keeps CSV/TXT-style first-sheet selection unchanged', () => {
    const workbook = {
        SheetNames: ['第一頁', 'Detail'],
        Sheets: { 第一頁: { name: '第一頁' }, Detail: { name: 'Detail' } }
    };
    assert.equal(selectWorkbookSheet(workbook).name, '第一頁');
});
