window.SMT = window.SMT || {};
SMT.ooc = function (ctx) {
        const { data, toast, loading, calendarYear, calendarMonth, currentLine, requestPermission } = ctx;
        const oocForm = ref({ id: null, date: new Date().toISOString().split('T')[0], time: new Date().toTimeString().slice(0,5), selectedWoNumber: null, wo_id: null, machine_id: null, cause_id: null, notes: '' });
        const oocHistory = ref([]);
        const showOocModal = ref(false);
        const selectedOocId = ref(null);
        const oocDayModal = ref({ show: false, date: '', list: [] });

        const availableModelsForOoc = computed(() => !oocForm.value.selectedWoNumber ? [] : data.value.workOrders.filter(w => w.wo_number === oocForm.value.selectedWoNumber));
        const oocCalendarDays = computed(() => {
            const y = calendarYear.value, m = calendarMonth.value, daysInMonth = new Date(y, m + 1, 0).getDate(), days = [];
            for (let i = 1; i <= daysInMonth; i++) {
                const dStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
                const items = oocHistory.value.filter(rec => rec.production_date === dStr).map(rec => ({ id: rec.id, wo_id: rec.wo_id, wo_number: rec.work_orders.wo_number, model_name: rec.work_orders?.models?.name, cause: rec.ooc_causes?.name, machine: rec.machines?.name, time: rec.occurrence_time }));
                days.push({ dayNum: i, dateStr: dStr, items });
            } return days;
        });

        const openOocModal = (rec = null) => {
            if (rec) { oocForm.value = { id: rec.id, date: rec.production_date, time: rec.occurrence_time || '', selectedWoNumber: rec.work_orders.wo_number, wo_id: rec.wo_id, machine_id: rec.machine_id, cause_id: rec.cause_id, notes: rec.notes || '' }; }
            else { oocForm.value = { id: null, date: new Date().toISOString().split('T')[0], time: new Date().toTimeString().slice(0,5), selectedWoNumber: null, wo_id: null, machine_id: null, cause_id: null, notes: '' }; }
            showOocModal.value = true;
        };
        const saveOoc = async () => {
            if (!oocForm.value.wo_id || !oocForm.value.machine_id || !oocForm.value.cause_id) return toast("請填寫完整", "warning");
            loading.value = true;
            try {
                const payload = { production_date: oocForm.value.date, occurrence_time: oocForm.value.time, wo_id: oocForm.value.wo_id, machine_id: oocForm.value.machine_id, cause_id: oocForm.value.cause_id, notes: oocForm.value.notes || null };
                if (oocForm.value.id) await _supabase.from('ooc_records').update(payload).eq('id', oocForm.value.id);
                else await _supabase.from('ooc_records').insert({ ...payload, line: currentLine.value });
                await loadOocHistory(); showOocModal.value = false; toast("儲存成功");
            } catch(e) { toast("失敗: " + e.message + " (若無 notes 欄位請忽略此欄)", "error"); } finally { loading.value = false; }
        };
        const loadOocHistory = async () => { const { data: list } = await _supabase.from('ooc_records').select('*, work_orders(wo_number, models(name)), machines(name), ooc_causes(name)').eq('line', currentLine.value).order('production_date', {ascending:false}).limit(200); if(list) oocHistory.value = list; };
        const deleteOoc = async (id) => { if(!confirm("確定刪除？")) return; if (!(await requestPermission('刪除 OOC 紀錄'))) return; await _supabase.from('ooc_records').delete().eq('id', id); loadOocHistory(); toast("已刪除", "info"); };
        const openOocDayDetail = (day) => { oocDayModal.value = { show: true, date: day.dateStr, list: day.items }; };
        return {
            oocForm, oocHistory, showOocModal, selectedOocId, oocDayModal,
            availableModelsForOoc, oocCalendarDays,
            openOocModal, saveOoc, loadOocHistory, deleteOoc, openOocDayDetail
        };
};
