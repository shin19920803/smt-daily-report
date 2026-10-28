const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseCsvRows, parseTaiwanProductionDate, parseAutoTesterCsv, MAX_UNIQUE_RECORDS } = require('../js/auto-tester.js');

test('CSV parser handles BOM, CRLF, escaped quotes, embedded comma and multiline cells', () => {
    const rows = parseCsvRows('\uFEFFmeta,one\r\nChipID,QRCode,PID,Result,Error,Time,DetailMsg\r\n"id,1","QR""001",P,Pass,,20261021-083630,"line one\r\nline two"\r\n');
    assert.equal(rows.length, 3);
    assert.equal(rows[2][1], 'QR"001');
    assert.equal(rows[2][6], 'line one\r\nline two');
});

test('production timestamp accepts valid Taiwan date and rejects invalid calendar/time values', () => {
    assert.equal(parseTaiwanProductionDate('20261021-083630'), '2026-10-21');
    assert.equal(parseTaiwanProductionDate('20260229-083630'), null);
    assert.equal(parseTaiwanProductionDate('20261021-243630'), null);
    assert.equal(parseTaiwanProductionDate('2026-10-21 08:36:30'), null);
});

test('QRs are deduplicated by production date across rows, while date remains part of key', () => {
    const csv = [
        'metadata,ignored',
        'ChipID,QRCode,PID,Result,Error,Time,DetailMsg',
        'x, QR-001 ,p,Fail,,20261021-083630,reason',
        'x,QR-001,p,Pass,,20261021-091737,',
        'x,QR-002,p,Pass,,20261021-091748,',
        'x,QR-001,p,Pass,,20261022-001000,'
    ].join('\r\n');
    const result = parseAutoTesterCsv(csv);
    assert.equal(result.records.length, 3);
    assert.deepEqual(result.records.map(row => row.reportDate), ['2026-10-21', '2026-10-21', '2026-10-22']);
    assert.equal(result.ignoredBlankQr, 0);
});

test('invalid timestamp on a nonblank QR rejects the entire upload; blank QR rows are ignored', () => {
    const bad = 'ChipID,QRCode,PID,Result,Error,Time\nx,QR-001,p,Pass,,bad';
    assert.throws(() => parseAutoTesterCsv(bad), /整份檔案未上傳/);
    const blank = 'ChipID,QRCode,PID,Result,Error,Time\nx, ,p,Fail,,bad';
    assert.throws(() => parseAutoTesterCsv(blank), /沒有可統計資料/);
});

test('CSV with invalid quoting or wrong column headings is rejected explicitly', () => {
    assert.throws(() => parseCsvRows('"unterminated'), /引號沒有成對/);
    assert.throws(() => parseAutoTesterCsv('A,B,C,D,E,F\n1,2,3,4,5,6'), /找不到資料標題列/);
    assert.equal(parseAutoTesterCsv('A,QR CODE,C,D,E, Time \nx,QR-1,p,Pass,,20261021-083630').records.length, 1);
});

test('record guard is finite and leaves a clear per-file ceiling', () => {
    assert.equal(MAX_UNIQUE_RECORDS, 25000);
});
