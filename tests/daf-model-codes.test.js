const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const utils = require('../js/daf-upload-utils.js');
const source = fs.readFileSync(require.resolve('../js/daf.js'), 'utf8');

test('FP code extraction ignores packaging, operator codes, vendor suffixes and case', () => {
    for (const raw of ['PACKAGE,FP-D01607MB11', 'FP-D01607MB11,K9DYW,054.25141.0191',
        'RFPCBA,DAF, fp-d01607mb11', 'FP-D01607MB11\n', '品名：FP-D01607MB11，包裝']) {
        assert.equal(utils.normalizeProductCode(raw), 'FP-D01607MB11');
    }
    assert.equal(utils.normalizeProductCode('FP-D01820MB11,K9DYW,054.25141.0191'), 'FP-D01820MB11');
    assert.equal(utils.normalizeProductCode('XFP-D01607MB11'), '');
    assert.equal(utils.normalizeProductCode('FP-A,FP-B'), '');
    assert.equal(utils.normalizeProductCode('noise'), '');
});

test('all three non-FP exceptions retain recognition', () => {
    for (const code of ["RFPCB,DAF,TAROKO 14''", 'RFPCB,DAF,TAROKO 14,SYNAPTICS', 'MS3633-T07']) {
        assert.equal(utils.normalizeProductCode(code.toLowerCase()), code);
    }
});

test('alias memories collapse and the two user-confirmed overrides win over stale names', () => {
    const mappings = utils.normalizeModelMappings([
        ['RFPCBA,DAF,FP-D01321BE11', 'A01-ELAN'], ['FP-D01321BE11,6J75M', 'B24-ELAN'],
        ['PACKAGE,FP-D01524BK11,COMPAL', 'B27-GOODIX'], ['RFPCBA,DAF, FP-D01524BK11', 'B27-ELAN'],
        ['PACKAGE,FP-D01607MB11','TK14-GOODIX'], ['FP-D01607MB11','TK14-GOODIX']
    ]);
    assert.deepEqual(mappings, {
        'FP-D01321BE11':'B24-ELAN', 'FP-D01524BK11':'B27-ELAN', 'FP-D01607MB11':'TK14-GOODIX'
    });
});

function harness(initial = {}) {
    const storage = new Map(Object.entries(initial));
    const context = {
        SMT_DAF_UPLOAD_UTILS:utils, cleanText:value => String(value ?? '').trim(),
        currentDafMappingStorageKey:() => 'current', LEGACY_MODEL_MAPPING_STORAGE_KEYS:['legacy'],
        MODEL_MAPPING_REMOTE_PREFIX:'__PROCESS_MODEL_MAPPING__', MODEL_MAPPING_REMOTE_LINE:'__PROCESS_MODEL_MAPPING__',
        LEGACY_MODEL_MAPPING_REMOTE_LINE:'old', REMOTE_TABLE:'daf_log_batches', _supabase:null,
        dafModelMappings:{value:{}}, MODEL_MAPPING:{'FP-D01607MB11':'TK14-GOODIX','MS3633-T07':'HP-C-Deck'},
        localStorage:{ getItem:key => storage.get(key), setItem:(key,value) => storage.set(key,value), removeItem:key => storage.delete(key) },
        console
    };
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('    const normalizeText ='),source.indexOf('    let dafModelMappingsReadyPromise')) +
        '\nthis.read=readModelMappings;this.persist=persistModelMappings;this.row=modelMappingRemoteRow;', context);
    vm.runInContext(source.slice(source.indexOf('    const findDafModelMatch ='),source.indexOf('    const detectDateRange =')) +
        '\nthis.match=findDafModelMatch;this.detect=detectModel;',context);
    return {context,storage};
}

test('actual local memory migration removes legacy noise and writes canonical remote row/id/records', () => {
    const {context:c,storage} = harness({legacy:JSON.stringify({'PACKAGE,FP-D09999MB11':'New-Model'})});
    c.dafModelMappings.value = c.read();
    c.persist();
    assert.equal(storage.has('legacy'), false);
    assert.deepEqual(JSON.parse(storage.get('current')), {'FP-D09999MB11':'NEW-MODEL'});
    const row = c.row('FP-D09999MB11,K9DYW,054.25141.0191','New-Model');
    assert.equal(row.product_code, 'FP-D09999MB11');
    assert.equal(row.id, '__PROCESS_MODEL_MAPPING__FP-D09999MB11');
    assert.equal(row.records[0].productCode, 'FP-D09999MB11');
    assert.equal(c.match('PACKAGE,FP-D09999MB11')[1], 'NEW-MODEL');
    assert.equal(c.match('PACKAGE,FP-D01607MB110'), null, 'longer codes must not match a shorter prefix');
    assert.equal(c.match('MS3633-T07')[1], 'HP-C-Deck');
});

test('actual model detection coalesces noisy aliases and keeps work orders for unknown canonical codes', () => {
    const {context:c} = harness();
    c.currentDafColumns = () => ({productCode:3,workOrder:1});
    const detected = c.detect([
        ['', 'WO1','','PACKAGE,FP-D09999MB11'], ['', 'WO2','','FP-D09999MB11,EXTRA']
    ]);
    assert.equal(detected.unknownProductCodes.length, 1);
    assert.equal(detected.unknownProductCodes[0], 'FP-D09999MB11');
    assert.deepEqual(Array.from(detected.unknownProductDetails[0].workOrders),['WO1','WO2']);
    assert.throws(() => c.detect([['','WO','','FP-A,FP-B']]), /產品代號無法辨識/);
});

test('five-process actual analysis retains earliest-E dedup, counts and machines while storing only FP codes', async () => {
    const {context:c} = harness();
    const columns = {process:0,workOrder:1,productCode:3,dedupKey:4,date:5,machineOperator:6,defect:7,status:8};
    const lines = ['DAF','FT1','FT2','LIGHTING','ASSEMBLY'];
    const rows = lines.flatMap(line => [
        [line,'WO','','PACKAGE,FP-D01607MB11','K1','2026-10-27T10:00:00','','later fail','FAIL'],
        [line,'WO','','FP-D01607MB11,noise','K1','2026-10-27T09:00:00','','','GOOD'],
        [line,'WO','','RFPCB,DAF,FP-D01607MB11','K2','2026-10-27T11:00:00','','刮傷','FAIL']
    ]);
    Object.assign(c, {
        currentDafColumns:() => columns, readFileRows:async () => ({rows:[['header'],...rows],columnCount:9}),
        parseDateTime:value => new Date(value), parseDate:value => String(value).slice(0,10),
        isDafMachineReference:() => false, isDafMachineLabel:value => ['1號機','2號機'].includes(value),
        isMachineClassifiedProcess:line => ['DAF','FT1'].includes(line),
        detectTestProcess:value => lines.includes(value) ? value : null,
        defaultDafDefect:() => '未填寫不良原因', fmtDate:date => date.toISOString().slice(0,10),
        displayCell:value => String(value ?? ''), CURRENT_SOURCE_FORMAT:'current-v2', DAF_MACHINE_UNKNOWN:'未分類機台'
    });
    vm.runInContext(source.slice(source.indexOf('    const deduplicateRows ='),source.indexOf('    const decodeBytes =')),c);
    vm.runInContext(source.slice(source.indexOf('    const detectDateRange ='),source.indexOf('    const toRemote =')) +
        '\nthis.analyze=analyzeFile;',c);
    const result = await c.analyze({name:'test.xlsx'}, new Map([['K1',{machine:'1號機'}],['K2',{machine:'2號機'}]]));
    assert.equal(result.length,5);
    for (const batch of result) {
        assert.equal(batch.rowCount,2);
        assert.equal(batch.duplicateCount,1);
        assert.equal(batch.inputCount,2);
        assert.equal(batch.goodCount,1);
        assert.equal(batch.failCount,1);
        assert.equal(batch.yieldRate,'50.00');
        assert.equal(batch.productCode,'FP-D01607MB11');
        for (const row of batch.records) assert.equal(row.productCode,'FP-D01607MB11');
        assert.equal(batch.records[0].status,'GOOD');
        assert.equal(batch.records[1].defect,'刮傷');
        if (['DAF','FT1'].includes(batch.line)) assert.equal(batch.records[0].machine,'1號機');
    }
});

test('unknown-model flow saves canonical memory remotely before continuing; save failure stays on the dialog', async () => {
    const {context:c} = harness();
    Object.assign(c, {
        dafUnknownModelModal:{value:{items:[{code:'PACKAGE,FP-D09999MB11'}, {code:'FP-NEXT'}],currentIndex:0,selectedModel:'New-Model',newModel:''}},
        toast:() => {}, pendingDafUpload:{value:null}
    });
    vm.runInContext(source.slice(source.indexOf('    const resolveDafUnknownModel ='),source.indexOf('    const cancelDafUnknownModel =')) +
        '\nthis.resolve=resolveDafUnknownModel;',c);
    await c.resolve();
    assert.equal(c.dafUnknownModelModal.value.currentIndex,0);
    assert.equal(Object.keys(c.dafModelMappings.value).length,0);
    let saved;
    c._supabase = {from:() => ({upsert:row => {
        saved = row;
        return {select:() => ({maybeSingle:async () => ({data:{id:row.id}})})};
    }})};
    await c.resolve();
    assert.equal(saved.product_code,'FP-D09999MB11');
    assert.equal(c.dafUnknownModelModal.value.currentIndex,1);
    assert.equal(c.match('FP-D09999MB11,ANOTHER-SUFFIX')[1],'NEW-MODEL');
});
