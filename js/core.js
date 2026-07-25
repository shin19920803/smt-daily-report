window.SMT = window.SMT || {};
SMT.core = function (ctx) {
        const currentTab = ref('dashboard');
        const loading = ref(false);
        const showWoModal = ref(false);
        const showMobileMore = ref(false);
        const data = ref({ workOrders: [], models: [], defectTypes: [], defectLocations: [], machines: [], oocCauses: [] });
        
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
            const [wo, mo, dt, dl, mac, oc] = await Promise.all([ 
                _supabase.from('work_orders').select('*, models(name), daily_production(production_date, input_quantity)').order('created_at', {ascending: false}), 
                _supabase.from('models').select('*'), _supabase.from('defect_types').select('*'), _supabase.from('defect_locations').select('*'),
                _supabase.from('machines').select('*'), _supabase.from('ooc_causes').select('*')
            ]); 
            data.value.workOrders = (wo.data || []).map(w => ({ ...w, current_input: w.daily_production.reduce((sum, d) => sum + d.input_quantity, 0) })); 
            data.value.models = mo.data || []; data.value.defectTypes = dt.data || []; data.value.defectLocations = dl.data || [];
            data.value.machines = mac.data || []; data.value.oocCauses = oc.data || [];
        };
        const sortedModels = computed(() => [...data.value.models].sort((a,b) => a.name.localeCompare(b.name)));
        const sortedDefectTypes = computed(() => [...data.value.defectTypes].sort((a,b) => a.name.localeCompare(b.name)));
        const sortedLocations = computed(() => [...data.value.defectLocations].sort((a,b) => a.code.localeCompare(b.code)));
        watch(currentTab, () => { showMobileMore.value = false; });
        return {
            currentTab, loading, showWoModal, showMobileMore, data, toasts, toast,
            getWoColor, fpyTargets, saveFpyTargets, loadFpyTargets, isFpyBelowTarget, todayStr,
            activeWoNumbers, uniqueWoNumbers, loadBaseData,
            sortedModels, sortedDefectTypes, sortedLocations
        };
};
