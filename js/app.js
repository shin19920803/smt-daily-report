const app = createApp({
    setup() {
        const ctx = {};
        [SMT.core, SMT.orders, SMT.report, SMT.assembly, SMT.daf, SMT.fpy, SMT.ooc, SMT.dashboard, SMT.stats, SMT.equipment, SMT.settings]
            .forEach(mod => Object.assign(ctx, mod(ctx)));

        onMounted(async () => {
            ctx.loading.value = true;
            try {
                ctx.loadFpyTargets();
                const isSmt = ctx.currentLine.value === 'SMT';
                // 首屏只等待基本設定與畫面資料；歷史資料在背景同步，避免資料量拖住整個頁面。
                const tasks = [
                    ctx.loadBaseData(),
                    ctx.loadAssemblyData({ background: true }),
                    ctx.loadDafData({ background: true })
                ];
                await Promise.all(tasks);
                const refreshed = await ctx.refreshDashboard();
                ctx.renderAssemblyReportChart();
                ctx.renderAssemblyStatsCharts();
                if (refreshed !== false) await ctx.initDashboardCharts();
                if (isSmt) {
                    // 這些資料只在切到對應功能時使用，不阻塞首頁顯示。
                    Promise.allSettled([
                        ctx.loadHistory(), ctx.loadFpyHistory(), ctx.loadOocHistory(), ctx.loadEqData(),
                        ctx.loadFeeders(), ctx.loadNozzleLogs()
                    ]).catch(error => console.warn('SMT 背景資料同步失敗', error));
                }
                const today = new Date();
                ctx.rawExportFilter.value.end = today.toISOString().split('T')[0];
                ctx.fpyFilter.value.end = today.toISOString().split('T')[0];
                today.setDate(today.getDate() - 7);
                ctx.rawExportFilter.value.start = today.toISOString().split('T')[0];
                ctx.fpyFilter.value.start = today.toISOString().split('T')[0];
            } finally {
                ctx.loading.value = false;
            }
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
