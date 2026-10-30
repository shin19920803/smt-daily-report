import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function createHarness() {
    const production = {
        id: 'production-1', wo_id: 'wo-1', production_date: '2026-10-22',
        input_quantity: 42, work_orders: { wo_number: '626090094' }
    };
    const defect = {
        id: 'defect-1', production_id: production.id, quantity: 2,
        defect_types: { name: '缺件' }, defect_locations: { code: 'C1' }
    };
    const queries = [];
    const workOrder = {
        id: production.wo_id, wo_number: production.work_orders.wo_number,
        target_quantity: 100, current_input: 42, is_closed: false,
        models: { name: 'MODEL-A' },
        daily_production: [{ id: production.id, production_date: production.production_date, input_quantity: production.input_quantity }]
    };
    const ctx = {
        data: { value: { workOrders: [workOrder], models: [], defectTypes: [], defectLocations: [] } },
        toast: () => {}, loading: { value: false }, loadBaseData: async () => {},
        showWoModal: { value: false }, currentLine: { value: 'SMT' }, currentTab: { value: 'orders' },
        activeWoNumbers: { value: [] }
    };
    const window = {
        SMT: {}, getTaiwanDate: () => '2026-10-30',
        shiftDateByDays: date => date === '2026-10-30' ? '2026-10-29' : '2026-10-28'
    };
    const sandbox = vm.createContext({ window, console, ref: value => ({ value }), computed: getter => ({ get value() { return getter(); } }),
        _supabase: { from(table) {
            const filters = {};
            queries.push({ table, filters });
            const chain = {
                select() { return chain; },
                eq(field, value) { filters[field] = value; return chain; },
                order() { return chain; },
                maybeSingle() { return Promise.resolve({ data: table === 'daily_production' ? production : null, error: null }); },
                then(resolve, reject) {
                    return Promise.resolve({ data: table === 'defect_logs' ? [defect] : [], error: null }).then(resolve, reject);
                }
            };
            return chain;
        } }
    });
    sandbox.SMT = window.SMT;
    vm.runInContext(read('js/orders.js'), sandbox);
    vm.runInContext(read('js/report.js'), sandbox);
    Object.assign(ctx, window.SMT.orders(ctx));
    Object.assign(ctx, window.SMT.report(ctx));
    return { ctx, production, defect, queries, sandbox };
}

test('calendar item opens the exact SMT daily-production record and its defect editor', async () => {
    const { ctx, production, defect, queries } = createHarness();
    const day = ctx.calendarDays.value.find(item => item.dateStr === production.production_date);

    assert.ok(day, 'calendar contains the production date');
    assert.equal(day.productions[0].id, production.id);
    ctx.openDayDetail(day);
    await ctx.openCalendarReport(ctx.dayDetailModal.value.list[0]);

    assert.equal(ctx.currentTab.value, 'report');
    assert.equal(ctx.dayDetailModal.value.show, false);
    assert.equal(ctx.report.value.currentId, production.id);
    assert.equal(ctx.report.value.wo_id, production.wo_id);
    assert.equal(ctx.report.value.date, production.production_date);
    assert.equal(ctx.report.value.selectedWoNumber, production.work_orders.wo_number);
    assert.equal(ctx.report.value.inputQty, production.input_quantity);
    assert.equal(ctx.report.value.isEditing, true);
    assert.equal(ctx.report.value.logs[0].id, defect.id);
    assert.equal(queries.find(query => query.table === 'daily_production').filters.id, production.id);
    assert.equal(queries.find(query => query.table === 'defect_logs').filters.production_id, production.id);
});

test('calendar entries expose a keyboard-accessible action and use the existing report editor', () => {
    const html = read('index.html');
    assert.match(html, /<button v-for="p in dayDetailModal\.list"[^>]*@click="openCalendarReport\(p\)"/);
    assert.match(html, /查看／編輯報工/);
    const orders = read('js/orders.js');
    const report = read('js/report.js');
    assert.match(orders, /ctx\.openCalendarProduction\(/);
    assert.match(report, /await loadRecordForEdit\(/);
});
