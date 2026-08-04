const app = createApp({
    setup() {
        const ctx = {};
        [SMT.core, SMT.orders, SMT.report, SMT.assembly, SMT.fpy, SMT.ooc, SMT.dashboard, SMT.stats, SMT.equipment, SMT.settings]
            .forEach(mod => Object.assign(ctx, mod(ctx)));

        onMounted(async () => {
            ctx.loadFpyTargets();
            await ctx.loadBaseData();
            ctx.loadHistory();
            ctx.loadFpyHistory();
            ctx.loadOocHistory();
            ctx.refreshDashboard();
            ctx.loadEqData();
            ctx.loadFeeders();
            ctx.loadNozzleLogs();
            ctx.loadAssemblyData();
            ctx.renderAssemblyReportChart();
            ctx.renderAssemblyStatsCharts();
            setTimeout(() => ctx.initDashboardCharts(), 800);
            const today = new Date();
            ctx.rawExportFilter.value.end = today.toISOString().split('T')[0];
            ctx.fpyFilter.value.end = today.toISOString().split('T')[0];
            today.setDate(today.getDate() - 7);
            ctx.rawExportFilter.value.start = today.toISOString().split('T')[0];
            ctx.fpyFilter.value.start = today.toISOString().split('T')[0];
        });

        return ctx;
    }
});

// 共用排行清單元件：items = [{ key, qty, ratio }]
app.component('break-list', {
    props: { items: { type: Array, default: () => [] }, clickable: Boolean, keyWidth: { type: String, default: '96px' } },
    emits: ['pick'],
    template: `
    <div class="space-y-0.5">
        <component :is="clickable ? 'button' : 'div'" v-for="(it, idx) in items" :key="it.key"
             @click="clickable && $emit('pick', it.key)"
             class="break-row" :class="{ 'is-clickable': clickable, 'is-top': idx < 3 }"
             :title="clickable ? it.key + ' — 點擊繼續鑽取' : it.key">
            <span class="break-rank">{{ idx + 1 }}</span>
            <span class="break-key" :style="{minWidth: keyWidth}">{{ it.key }}</span>
            <span class="flex-1 min-w-[24px]"><span class="meter"><span class="meter-fill bg-red" :style="{width: (it.qty / items[0].qty * 100) + '%'}"></span></span></span>
            <span class="break-qty">{{ it.qty }} <span>({{ it.ratio }}%)</span></span>
        </component>
        <div v-if="!items || items.length === 0" class="empty-state" style="padding:16px 8px"><i class="fas fa-inbox"></i><div class="hint">無資料</div></div>
    </div>`
});

app.mount('#app');
