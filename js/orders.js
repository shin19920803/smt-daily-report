window.SMT = window.SMT || {};
SMT.orders = function (ctx) {
        const { data, toast, loading, loadBaseData, showWoModal, currentLine } = ctx;
        const woForm = ref({ id: null, number: '', modelId: null, selectedModelIds: [], targetQty: '' });
        const isEditingWo = ref(false);
        const orderSearch = ref('');
        const selectedWoId = ref(null);
        const today = new Date();
        const calendarYear = ref(today.getFullYear());
        const calendarMonth = ref(today.getMonth());
        const dayDetailModal = ref({ show: false, date: '', list: [] });

        const processedWorkOrders = computed(() => {
            let list = data.value.workOrders;
            if (orderSearch.value) { const q = orderSearch.value.toLowerCase(); list = list.filter(w => w.wo_number.toLowerCase().includes(q) || w.models.name.toLowerCase().includes(q)); }
            const groups = {};
            list.forEach(w => { if (!groups[w.wo_number]) groups[w.wo_number] = []; groups[w.wo_number].push(w); });
            const activeGroups = [], completedGroups = [];
            Object.values(groups).forEach(group => {
                const isCompleted = group.every(wo => { const rem = wo.target_quantity - (wo.current_input || 0); return rem <= 0 || wo.is_closed; });
                if (isCompleted) completedGroups.push(group); else activeGroups.push(group);
            });
            const sortByDateDesc = (groupA, groupB) => new Date(groupB[0].created_at) - new Date(groupA[0].created_at);
            activeGroups.sort(sortByDateDesc); completedGroups.sort(sortByDateDesc);
            const flattenGroup = (groupsArray) => { const flattened = []; groupsArray.forEach(group => { group.forEach((wo, index) => { flattened.push({ ...wo, _isFirstOfGroup: index === 0, _rowspan: group.length }); }); }); return flattened; };
            return { active: flattenGroup(activeGroups), completed: flattenGroup(completedGroups) };
        });

        const calendarDays = computed(() => {
            const y = calendarYear.value, m = calendarMonth.value, daysInMonth = new Date(y, m + 1, 0).getDate(), days = [];
            for (let i = 1; i <= daysInMonth; i++) {
                const dStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
                const dailyProds = [];
                data.value.workOrders.forEach(wo => { const prod = wo.daily_production.find(dp => dp.production_date === dStr); if (prod && prod.input_quantity > 0) dailyProds.push({ id: prod.id, wo_id: wo.id, wo_number: wo.wo_number, model_name: wo.models.name, qty: prod.input_quantity }); });
                days.push({ dayNum: i, dateStr: dStr, productions: dailyProds });
            } return days;
        });
        const calendarPadding = computed(() => new Date(calendarYear.value, calendarMonth.value, 1).getDay());
        const changeMonth = (delta) => { let newM = calendarMonth.value + delta; if (newM > 11) { calendarYear.value++; newM = 0; } else if (newM < 0) { calendarYear.value--; newM = 11; } calendarMonth.value = newM; };
        const isToday = (dStr) => dStr === new Date().toISOString().split('T')[0];
        const selectWoForCalendar = (wo) => { selectedWoId.value = selectedWoId.value === wo.id ? null : wo.id; };
        const openDayDetail = (day) => { dayDetailModal.value = { show: true, date: day.dateStr, list: day.productions }; };
        const openWoModal = (wo = null) => { if (wo) { isEditingWo.value = true; woForm.value = { id: wo.id, number: wo.wo_number, modelId: wo.model_id, selectedModelIds: [], targetQty: wo.target_quantity }; } else { isEditingWo.value = false; woForm.value = { id: null, number: '', modelId: null, selectedModelIds: [], targetQty: '' }; } showWoModal.value = true; };
        const saveWorkOrder = async () => { const { id, number, modelId, selectedModelIds, targetQty } = woForm.value; if (!number || !targetQty) return toast("請填寫工單號碼與數量", "warning"); loading.value = true; try { if (isEditingWo.value && id) { if (!modelId) return toast("請選擇機種", "warning"); await _supabase.from('work_orders').update({ wo_number: number, model_id: modelId, target_quantity: targetQty }).eq('id', id); } else { if (selectedModelIds.length === 0) return toast("請至少勾選一個機種", "warning"); for (const mId of selectedModelIds) { const isDuplicate = data.value.workOrders.some(w => w.wo_number === number && w.model_id === mId); if (!isDuplicate) await _supabase.from('work_orders').insert({ wo_number: number, model_id: mId, target_quantity: targetQty, is_closed: false, line: currentLine.value }); } } showWoModal.value = false; loadBaseData(); toast(isEditingWo.value ? "更新成功" : "工單已建立"); } catch (e) { toast("操作失敗", "error"); } finally { loading.value = false; } };
        const deleteWorkOrder = async (id) => { if(!confirm("⚠️ 警告：刪除工單將會移除所有相關數據！")) return; loading.value = true; await _supabase.from('work_orders').delete().eq('id', id); loadBaseData(); loading.value = false; toast("工單已刪除", "info"); };
        
        // NEW: Mark WO as complete
        const markWoComplete = async (id) => {
            if (!confirm("確定要手動標記此工單為已完成？")) return;
            loading.value = true;
            try {
                await _supabase.from('work_orders').update({ is_closed: true }).eq('id', id);
                await loadBaseData();
                toast("工單已標記為完成");
            } catch(e) { toast("操作失敗", "error"); } finally { loading.value = false; }
        };
        // 機種群組：去掉 _BOT/_TOP 後歸組，用於快速選取
        const modelGroups = computed(() => {
            const groups = {};
            data.value.models.forEach(m => {
                const base = m.name.replace(/[_\-](BOT|TOP)$/i, '');
                if (!groups[base]) groups[base] = { base, ids: [] };
                groups[base].ids.push(m.id);
            });
            // 只保留有 2 個以上的群組（有 BOT+TOP 的），或名稱本身就沒有後綴的也保留
            return Object.values(groups)
                .filter(g => g.ids.length >= 2 || !data.value.models.find(m => m.id === g.ids[0])?.name.match(/[_\-](BOT|TOP)$/i))
                .map(g => ({ ...g, allSelected: g.ids.every(id => woForm.value.selectedModelIds.includes(id)) }))
                .sort((a, b) => a.base.localeCompare(b.base));
        });
        const toggleModelGroup = (group) => {
            if (group.allSelected) {
                // 取消選取
                woForm.value.selectedModelIds = [];
            } else {
                // 單選：清掉全部，只選這組
                woForm.value.selectedModelIds = [...group.ids];
            }
        };
        return {
            woForm, isEditingWo, orderSearch, selectedWoId, dayDetailModal,
            processedWorkOrders, calendarYear, calendarMonth, calendarDays, calendarPadding,
            changeMonth, isToday, selectWoForCalendar, openDayDetail,
            openWoModal, saveWorkOrder, deleteWorkOrder, markWoComplete,
            modelGroups, toggleModelGroup
        };
};
