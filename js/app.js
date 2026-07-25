const app = createApp({
    setup() {
        const ctx = {};
        [SMT.core, SMT.orders, SMT.report, SMT.fpy, SMT.ooc, SMT.dashboard, SMT.stats, SMT.equipment, SMT.settings]
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
    props: { items: { type: Array, default: () => [] }, clickable: Boolean, keyWidth: { type: String, default: '90px' } },
    emits: ['pick'],
    template: `
    <div class="space-y-1.5">
        <div v-for="(it, idx) in items" :key="it.key" @click="clickable && $emit('pick', it.key)"
             class="flex items-center gap-2 p-1.5 rounded-lg transition" :class="clickable ? 'cursor-pointer hover:bg-red-50' : ''">
            <div class="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0"
                 :class="idx < 3 ? 'bg-red-500 text-white' : 'bg-gray-200 text-gray-600'">{{ idx + 1 }}</div>
            <div class="font-mono text-xs font-bold text-gray-700 truncate shrink-0" :style="{width: keyWidth}" :title="it.key">{{ it.key }}</div>
            <div class="flex-1 min-w-[40px]"><div class="w-full bg-gray-100 rounded-full h-1.5"><div class="h-1.5 rounded-full bg-red-400 transition-all" :style="{width: (it.qty / items[0].qty * 100) + '%'}"></div></div></div>
            <div class="font-mono text-xs font-bold text-red-600 text-right whitespace-nowrap shrink-0">{{ it.qty }} <span class="text-gray-400 font-normal">({{ it.ratio }}%)</span></div>
        </div>
        <div v-if="!items || items.length === 0" class="text-center text-gray-300 text-xs py-3"><i class="fas fa-inbox mr-1"></i>無資料</div>
    </div>`
});

app.mount('#app');
