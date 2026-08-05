window.SMT = window.SMT || {};

// ===== 產線（多線隔離的唯一依據）=====
// 每張根資料表都有 line 欄位，預設 'SMT'，所以既有資料自動歸屬 SMT。
SMT.LINES = [
    { id: 'SMT',  label: 'SMT',      icon: 'fa-microchip',   canImport: true  },
    { id: 'DAF',  label: 'DAF',      icon: 'fa-layer-group', canImport: false },
    { id: 'ASSY', label: '組裝測試', icon: 'fa-screwdriver-wrench', canImport: false }
];
SMT.LINE_KEY = 'koya_current_line';

SMT.core = function (ctx) {
        const currentTab = ref('dashboard');
        const loading = ref(false);
        const showWoModal = ref(false);
        const showMobileMore = ref(false);
        const data = ref({ workOrders: [], models: [], defectTypes: [], defectLocations: [], machines: [], oocCauses: [] });

        // --- 產線切換 ---
        const lines = SMT.LINES;
        const validLine = (id) => SMT.LINES.some(l => l.id === id) ? id : 'SMT';
        const currentLine = ref(validLine((() => { try { return localStorage.getItem(SMT.LINE_KEY); } catch(e) { return null; } })()));
        const currentLineMeta = computed(() => SMT.LINES.find(l => l.id === currentLine.value) || SMT.LINES[0]);
        // DAF／組裝測試先保留功能模組，但操作入口暫不顯示；SMT 維持原有入口。
        const hideLineTools = computed(() => ['DAF', 'ASSY'].includes(currentLine.value));
        const hideOrders = computed(() => currentLine.value === 'DAF');
        // 匯入格式因機台而異，DAF / 組裝測試的格式尚未定義，先只開放 SMT
        const canImport = computed(() => currentLineMeta.value.canImport);


        // --- Toast System ---
        const toasts = ref([]);
        let toastIdCounter = 0;
        const toast = (msg, type = 'success') => {
            const icons = { success: 'fas fa-check-circle', error: 'fas fa-times-circle', warning: 'fas fa-exclamation-triangle', info: 'fas fa-info-circle' };
            const id = ++toastIdCounter;
            toasts.value.push({ id, msg, type, icon: icons[type] || icons.info, leaving: false });
            setTimeout(() => { const t = toasts.value.find(x => x.id === id); if(t) t.leaving = true; }, 2500);
            setTimeout(() => { toasts.value = toasts.value.filter(x => x.id !== id); }, 2900);
        };

        // --- WO Color Helper ---
        const woColorCache = {};
        const getWoColor = (woNumber) => {
            if (woColorCache[woNumber]) return woColorCache[woNumber];
            let hash = 0;
            for (let i = 0; i < woNumber.length; i++) hash = woNumber.charCodeAt(i) + ((hash << 5) - hash);
            const hue = Math.abs(hash) % 360;
            woColorCache[woNumber] = { backgroundColor: `hsl(${hue}, 70%, 92%)`, color: `hsl(${hue}, 60%, 30%)`, borderColor: `hsl(${hue}, 60%, 78%)` };
            return woColorCache[woNumber];
        };

        // --- FPY Targets ---
        const fpyTargets = ref({ spi: 99.5, aoi: 98.5 });
        const saveFpyTargets = () => {
            try { localStorage.setItem('smt_fpy_targets', JSON.stringify(fpyTargets.value)); } catch(e) {}
            toast('FPY 目標值已儲存', 'success');
        };
        const loadFpyTargets = () => { try { const s = localStorage.getItem('smt_fpy_targets'); if(s) fpyTargets.value = JSON.parse(s); } catch(e) {} };
        const isFpyBelowTarget = (rate, type) => {
            if (rate === null || rate === undefined || rate === '') return false;
            const target = type === 'spi' ? fpyTargets.value.spi : fpyTargets.value.aoi;
            return Number(rate) < target;
        };

        // --- Shared Computed ---
        const activeWoNumbers = computed(() => {
            const active = data.value.workOrders.filter(w => {
                const remaining = w.target_quantity - (w.current_input || 0);
                return !w.is_closed && remaining > 0;
            }).map(w => w.wo_number);
            return [...new Set(active)];
        });
        const uniqueWoNumbers = computed(() => [...new Set(data.value.workOrders.map(w => w.wo_number))]);
        const todayStr = new Date().toISOString().split('T')[0];
        const loadBaseData = async () => {
            const L = currentLine.value;
            const [wo, mo, dt, dl, mac, oc] = await Promise.all([
                _supabase.from('work_orders').select('*, models(name), daily_production(production_date, input_quantity)').eq('line', L).order('created_at', {ascending: false}),
                _supabase.from('models').select('*').eq('line', L), _supabase.from('defect_types').select('*').eq('line', L), _supabase.from('defect_locations').select('*').eq('line', L),
                _supabase.from('machines').select('*').eq('line', L), _supabase.from('ooc_causes').select('*').eq('line', L)
            ]);
            data.value.workOrders = (wo.data || []).map(w => ({ ...w, current_input: w.daily_production.reduce((sum, d) => sum + d.input_quantity, 0) })); 
            data.value.models = mo.data || []; data.value.defectTypes = dt.data || []; data.value.defectLocations = dl.data || [];
            data.value.machines = mac.data || []; data.value.oocCauses = oc.data || [];
        };
        const sortedModels = computed(() => [...data.value.models].sort((a,b) => a.name.localeCompare(b.name)));
        const sortedDefectTypes = computed(() => [...data.value.defectTypes].sort((a,b) => a.name.localeCompare(b.name)));
        const sortedLocations = computed(() => [...data.value.defectLocations].sort((a,b) => a.code.localeCompare(b.code)));
        watch(currentTab, () => { showMobileMore.value = false; });

        // 切換產線：清掉所有跨線殘留狀態並重新載入該線資料
        const switchLine = async (lineId) => {
            const target = validLine(lineId);
            if (target === currentLine.value) return;
            if ((target === 'ASSY' && ['fpy', 'ooc', 'equipment'].includes(currentTab.value)) ||
                (target === 'DAF' && ['fpy', 'ooc', 'equipment', 'orders'].includes(currentTab.value))) {
                currentTab.value = 'dashboard';
            }
            currentLine.value = target;
            try { localStorage.setItem(SMT.LINE_KEY, target); } catch(e) {}
            loading.value = true;
            try {
                if (ctx.cancelEdit) ctx.cancelEdit();
                if (ctx.closeDrill) ctx.closeDrill();
                if (ctx.statsResult) ctx.statsResult.value = null;
                if (ctx.selectedFeederId) ctx.selectedFeederId.value = null;
                if (ctx.selectedNozzleModelId) ctx.selectedNozzleModelId.value = null;
                if (ctx.calHistory) ctx.calHistory.value = [];
                await loadBaseData();
                await Promise.all([
                    ctx.loadHistory && ctx.loadHistory(),
                    ctx.loadFpyHistory && ctx.loadFpyHistory(),
                    ctx.loadOocHistory && ctx.loadOocHistory(),
                    ctx.loadEqData && ctx.loadEqData(),
                    ctx.loadNozzleLogs && ctx.loadNozzleLogs(),
                    ctx.loadAssemblyData && ctx.loadAssemblyData(),
                    ctx.loadDafData && ctx.loadDafData()
                ]);
                if (ctx.loadFeeders) await ctx.loadFeeders();   // 需要 eqData 先就緒
                if (ctx.refreshDashboard) await ctx.refreshDashboard();
                if (ctx.initDashboardCharts && currentTab.value === 'dashboard') await ctx.initDashboardCharts();
            } finally { loading.value = false; }
            toast(`已切換至 ${currentLineMeta.value.label}`, 'info');
        };

        return {
            currentTab, loading, showWoModal, showMobileMore, data, toasts, toast,
            getWoColor, fpyTargets, saveFpyTargets, loadFpyTargets, isFpyBelowTarget, todayStr,
            activeWoNumbers, uniqueWoNumbers, loadBaseData,
            sortedModels, sortedDefectTypes, sortedLocations,
            lines, currentLine, currentLineMeta, hideLineTools, hideOrders, canImport, switchLine
        };
};
