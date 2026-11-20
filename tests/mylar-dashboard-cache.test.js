const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const source = fs.readFileSync(require.resolve('../js/assembly.js'), 'utf8');
function harness() {
    const c = { assemblyBatches: { value: [] }, assemblyModelSchedules: { value: [] },
        assemblyStatusNotes: { value: {} }, ASSEMBLY_MACHINE_DEFECT: '調機異常項目', ASSEMBLY_IGNORED_DEFECT: '偽異常項目', NO_MODEL: '未設定機種', console };
    vm.createContext(c);
    const slice = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
    vm.runInContext([
        slice('    const timeToMinutes =', '    const readDefectNotes ='),
        "const normalizeMessage = value => String(value || '').replace(/\\s+/g, ' ').trim();",
        slice('    const hourKey =', '    const loadAssemblyHistoricalDefectOptions ='),
        slice('    const normalizeSuccessDivisor =', '    const emptyBucket ='),
        slice('    const increment =', '    const parseText ='),
        slice('    const normalizeAssemblyBucketForAggregate =', '    const assemblyDefectOptions ='),
        slice('    let assemblyDayCacheSources =', '    const getAssemblyUploadedDates ='),
        'this.report=getAssemblyReportForDate; this.aggregate=aggregate; this.lookup=modelForLogTime;',
        'this.cacheSize=()=>assemblyDayReportCache.size; this.minuteCacheSize=()=>assemblyScheduleMinuteCache.size;'
    ].join('\n'), c);
    return c;
}
function fixture() {
    return [{ id: 'a', buckets: {
        '2026-11-01': { success: 3, ng: 1, byType: { '刮傷': 1 }, hourlySuccess: { '09': 3 }, hourlyNg: { '09': 1 }, hourlyByType: { '刮傷': { '09': 1 } },
            events: [{ time: '09:01', type: 'SUCCESS' }, { time: '09:02', type: 'SUCCESS' }, { time: '09:03', type: 'SUCCESS' }, { time: '09:04', type: 'NG', category: '刮傷' }] },
        '2026-11-02': { success: 5, ng: 1, successDivisor: 2, byType: { '偽異常項目': 1 }, hourlySuccess: { '09': 5 }, hourlyNg: { '09': 1 }, hourlyByType: { '偽異常項目': { '09': 1 } } }
    } }];
}
const serialize = value => JSON.stringify(value);
test('cached Mylar date reports preserve all aggregate fields, floor /2 and ignored NG', () => {
    const c = harness(); c.assemblyBatches.value = fixture();
    c.assemblyModelSchedules.value = [{ id: 's', date: '2026-11-01', startTime: '09:00', endTime: '10:00', model: 'MODEL-A' }];
    for (const date of ['2026-11-01','2026-11-02','2026-11-03']) {
        assert.equal(serialize(c.report(date)), serialize(c.aggregate(c.assemblyBatches.value, date, date)));
        assert.equal(c.report(date), c.report(date), 'unchanged date uses the completed report');
    }
    assert.equal(c.report('2026-11-02').totalSuccess, 2);
    assert.equal(c.report('2026-11-02').totalDefects, 0);
});
test('upload replacement, deletion, model schedules and status notes invalidate reports', () => {
    const c = harness(); c.assemblyBatches.value = fixture();
    const initial = c.report('2026-11-01');
    c.assemblyModelSchedules.value = [{ id: 's', date: '2026-11-01', startTime: '09:00', endTime: '10:00', model: 'NEW-MODEL' }];
    assert.notEqual(c.report('2026-11-01'), initial);
    assert.equal(c.report('2026-11-01').byModel[0].name, 'NEW-MODEL');
    c.assemblyStatusNotes.value = { '2026-11-01::09': '新備註' };
    assert.equal(c.report('2026-11-01').byType[0].hourly[0].note, '新備註');
    const replaced = fixture(); replaced[0].buckets['2026-11-01'].success = 8;
    c.assemblyBatches.value = replaced;
    assert.equal(c.report('2026-11-01').totalSuccess, 8);
    c.assemblyBatches.value = [];
    assert.equal(c.report('2026-11-01').totalRecords, 0);
});
test('minute cache preserves overlap priority and 23:59 end-of-day rules', () => {
    const c = harness();
    c.assemblyModelSchedules.value = [
        { id: 'ASSY_MODEL_1000000000000', date:'2026-11-01', startTime:'09:00', endTime:'23:59', model:'OLD' },
        { id: 'ASSY_MODEL_2000000000000', date:'2026-11-01', startTime:'09:00', endTime:'10:00', model:'NEW' }
    ];
    assert.equal(c.lookup('2026-11-01','09:59'), 'NEW');
    assert.equal(c.lookup('2026-11-01','10:00'), 'OLD');
    assert.equal(c.lookup('2026-11-01','23:59'), 'OLD');
    assert.equal(c.lookup('2026-11-01','bad-time'), '未設定機種');
    c.assemblyModelSchedules.value = [];
    assert.equal(c.lookup('2026-11-01','09:59'), '未設定機種');
    for (let index=0;index<70;index++) c.report('date-'+index);
    assert(c.cacheSize() <= 64);
});
test('repeated dashboard date switching reuses completed report rather than scanning events', () => {
    const c = harness(); const date = '2026-11-01';
    c.assemblyModelSchedules.value = Array.from({ length:137 },(_,i)=>({ id:'s'+i,date:i===0?date:'other-'+i,startTime:'00:00',endTime:'23:59',model:'M'+i }));
    const events = Array.from({length:20000}, (_,i)=>({type:'SUCCESS',time:`09:${String(i%60).padStart(2,'0')}`}));
    c.assemblyBatches.value = [{ id:'large',buckets:{ [date]:{success:events.length,ng:0,events,hourlySuccess:{'09':events.length}} } }];
    const baselineStart=performance.now(); let expected;
    for(let i=0;i<10;i++) expected=c.aggregate(c.assemblyBatches.value,date,date);
    const baselineMs=performance.now()-baselineStart;
    const cachedStart=performance.now(); let actual;
    for(let i=0;i<10;i++) actual=c.report(date);
    const cachedMs=performance.now()-cachedStart;
    assert.equal(serialize(actual),serialize(expected));
    console.log(`Mylar 20,000-event / 10 date lookups: aggregate=${baselineMs.toFixed(1)}ms cached=${cachedMs.toFixed(1)}ms`);
});
