const { createApp, ref, computed, onMounted, watch, reactive } = Vue;
const { createClient } = supabase;

const SUPABASE_URL = 'https://ccwkcwriebxipndxkvyr.supabase.co'; 
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNjd2tjd3JpZWJ4aXBuZHhrdnlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkzODk4MTgsImV4cCI6MjA4NDk2NTgxOH0.fUHOdc7OZVTwv6XjkmYU7uSkJMIy83OTvM7rD1n81Ic';
const _supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

createApp({
    setup() {
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
        
        // 報工用的工單清單：編輯模式下額外包含當前正在編輯的工單號碼
        const reportWoList = computed(() => {
            const list = new Set(activeWoNumbers.value);
            if (report.value.isEditing && report.value.selectedWoNumber) {
                list.add(report.value.selectedWoNumber);
            }
            return [...list];
        });
        const todayStr = new Date().toISOString().split('T')[0];
        const formatLocalDate = (date) => {
            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, '0');
            const d = String(date.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        };
        const getPreviousWorkday = () => {
            const d = new Date();
            const day = d.getDay(); // 0=Sun, 1=Mon...6=Sat
            if (day === 1) d.setDate(d.getDate() - 3); // Mon -> Fri
            else if (day === 0) d.setDate(d.getDate() - 2); // Sun -> Fri
            else d.setDate(d.getDate() - 1); // others -> yesterday
            return formatLocalDate(d);
        };

        // --- Dashboard ---
        const dashboard = ref({ activeWoCount: 0, todayInput: 0, todayDefects: 0, todayYield: 100, monthOocCount: 0, weekAvgYield: 0 });
        const dashboardRecentProds = ref([]);
        const dashboardRecentOoc = ref([]);
        const dashDate = ref(new Date().toISOString().split('T')[0]);

        const changeDashDate = (delta) => {
            const d = new Date(dashDate.value);
            d.setDate(d.getDate() + delta);
            dashDate.value = d.toISOString().split('T')[0];
            refreshDashboard();
        };

        const refreshDashboard = async () => {
            dashboard.value.activeWoCount = activeWoNumbers.value.length;

            const targetDate = dashDate.value;
            const { data: todayProds } = await _supabase.from('daily_production').select('input_quantity, defect_logs(quantity)').eq('production_date', targetDate);
            let tInput = 0, tDefects = 0;
            (todayProds || []).forEach(p => { tInput += p.input_quantity; p.defect_logs.forEach(d => { tDefects += d.quantity; }); });
            dashboard.value.todayInput = tInput;
            dashboard.value.todayDefects = tDefects;
            dashboard.value.todayYield = tInput ? ((tInput - tDefects) / tInput * 100).toFixed(1) : '100.0';

            const monthStart = targetDate.slice(0, 7) + '-01';
            const { data: oocMonth, count: oocCount } = await _supabase.from('ooc_records').select('id', { count: 'exact' }).gte('production_date', monthStart).lte('production_date', targetDate);
            dashboard.value.monthOocCount = oocCount || 0;

            const weekAgo = new Date(targetDate); weekAgo.setDate(weekAgo.getDate() - 7);
            const weekStr = weekAgo.toISOString().split('T')[0];
            const { data: weekProds } = await _supabase.from('daily_production').select('input_quantity, defect_logs(quantity)').gte('production_date', weekStr).lte('production_date', targetDate);
            let wInput = 0, wDefects = 0;
            (weekProds || []).forEach(p => { wInput += p.input_quantity; p.defect_logs.forEach(d => { wDefects += d.quantity; }); });
            dashboard.value.weekAvgYield = wInput ? ((wInput - wDefects) / wInput * 100).toFixed(1) : '100.0';

            const { data: recentProds } = await _supabase.from('daily_production').select('*, work_orders(wo_number, models(name)), defect_logs(quantity)').eq('production_date', targetDate).order('production_date', { ascending: false }).limit(20);
            dashboardRecentProds.value = (recentProds || []).map(item => ({ ...item, defect_count: item.defect_logs.reduce((s, d) => s + (d.quantity || 0), 0) }));

            const { data: recentOoc } = await _supabase.from('ooc_records').select('*, work_orders(wo_number, models(name)), machines(name), ooc_causes(name)').eq('production_date', targetDate).order('production_date', {ascending:false}).limit(10);
            dashboardRecentOoc.value = recentOoc || [];
        };

        // --- Report Logic (PRESERVED) ---
        const report = ref({ date: getPreviousWorkday(), wo_id: null, selectedWoNumber: null, inputQty: 0, currentId: null, logs: [], isEditing: false, originalDate: null });
        const defectForm = ref({ typeId: null, locationId: null, qty: 1 });
        const historyList = ref([]);
        const rawExportFilter = ref({ start: '', end: '', modelId: 'all', woId: 'all' });

        const availableModelsForSelectedWo = computed(() => !report.value.selectedWoNumber ? [] : data.value.workOrders.filter(w => w.wo_number === report.value.selectedWoNumber));
        const onWoNumberChange = () => { report.value.wo_id = null; report.value.currentId = null; report.value.logs = []; report.value.inputQty = 0; report.value.isEditing = false; report.value.originalDate = null; report.value.selectedWoNumber = null; };
        
        // 一鍵選定工單號碼+機種
        const selectReportWo = async (woNumber, woId) => {
            report.value.selectedWoNumber = woNumber;
            report.value.wo_id = woId;
            await fetchDailyRecord();
        };
        
        // 返回工單選擇 (編輯模式會整個取消，新增模式只清工單)
        const backToWoList = () => {
            if (report.value.isEditing) cancelEdit();
            else onWoNumberChange();
        };
        
        // 日期變更處理：編輯模式下不重新查詢，僅記錄新日期待儲存時一併更新
        const onDateChange = () => {
            if (report.value.isEditing && report.value.currentId) {
                // 編輯模式：不觸發 fetchDailyRecord，日期改變會在儲存時一起更新
                return;
            }
            fetchDailyRecord();
        };
        
        // 取消編輯模式
        const cancelEdit = () => {
            report.value.isEditing = false;
            report.value.originalDate = null;
            report.value.currentId = null;
            report.value.logs = [];
            report.value.inputQty = 0;
            report.value.date = getPreviousWorkday();
            report.value.wo_id = null;
            report.value.selectedWoNumber = null;
        };
        const loadHistory = async () => { const { data: list } = await _supabase.from('daily_production').select('*, work_orders(wo_number, models(name)), defect_logs(quantity)').order('production_date', { ascending: false }).limit(50); if (list) historyList.value = list.map(item => ({ ...item, defect_count: item.defect_logs.reduce((s, d) => s + (d.quantity || 0), 0) })); };
        const loadRecordForEdit = async (rec) => { report.value.date = rec.production_date; report.value.originalDate = rec.production_date; report.value.selectedWoNumber = rec.work_orders.wo_number; report.value.wo_id = rec.wo_id; report.value.isEditing = true; await fetchDailyRecord(); };
        const fetchDailyRecord = async () => { if (!report.value.wo_id || !report.value.date) return; loading.value = true; report.value.currentId = null; report.value.logs = []; report.value.inputQty = 0; const queryDate = report.value.isEditing && report.value.originalDate ? report.value.originalDate : report.value.date; try { const { data: prod } = await _supabase.from('daily_production').select('id, input_quantity').eq('wo_id', report.value.wo_id).eq('production_date', queryDate).maybeSingle(); if (prod) { report.value.currentId = prod.id; report.value.inputQty = prod.input_quantity; const { data: logs } = await _supabase.from('defect_logs').select('*, defect_types(name), defect_locations(code)').eq('production_id', prod.id).order('created_at', { ascending: false }); report.value.logs = logs || []; } } catch (e) { console.error(e); } finally { loading.value = false; } };
        
        const saveDailyInput = async () => { 
            if (!report.value.wo_id) return toast("請先選擇工單與機種", "warning"); 
            
            const currentInput = Number(report.value.inputQty) || 0;
            
            // Enhanced validation: must be > 0
            if (currentInput <= 0) return toast("投入數必須大於 0", "warning");
            
            const targetWo = data.value.workOrders.find(w => w.id === report.value.wo_id);
            
            loading.value = true; 
            
            if (targetWo) {
                try {
                    const { data: existingProds } = await _supabase
                        .from('daily_production')
                        .select('id, input_quantity')
                        .eq('wo_id', report.value.wo_id);
                        
                    let totalOtherInputs = 0;
                    if (existingProds) {
                        existingProds.forEach(p => {
                            if (p.id !== report.value.currentId) {
                                totalOtherInputs += (Number(p.input_quantity) || 0);
                            }
                        });
                    }
                    
                    const maxAllowed = Number(targetWo.target_quantity) || 0;
                    
                    if ((totalOtherInputs + currentInput) > maxAllowed) {
                        loading.value = false;
                        return toast(`投入總數超過工單預計！預計: ${maxAllowed}, 其他日已投入: ${totalOtherInputs}, 最多可輸入: ${maxAllowed - totalOtherInputs}`, "error");
                    }
                } catch(e) {
                    console.error("防呆檢查發生錯誤", e);
                }
            }

            try { 
                if (report.value.currentId) {
                    // 編輯模式：同時更新日期和投入數
                    const updatePayload = { input_quantity: currentInput };
                    if (report.value.isEditing && report.value.date !== report.value.originalDate) {
                        // 日期有變更，檢查新日期是否已有同工單紀錄
                        const { data: existsOnNewDate } = await _supabase.from('daily_production').select('id').eq('wo_id', report.value.wo_id).eq('production_date', report.value.date).neq('id', report.value.currentId).maybeSingle();
                        if (existsOnNewDate) {
                            loading.value = false;
                            return toast("該工單在目標日期已有紀錄，無法重複建立", "error");
                        }
                        updatePayload.production_date = report.value.date;
                    }
                    await _supabase.from('daily_production').update(updatePayload).eq('id', report.value.currentId);
                    // 更新成功後重設編輯狀態
                    report.value.originalDate = report.value.date;
                }
                else { const { data: newProd, error } = await _supabase.from('daily_production').insert({ wo_id: report.value.wo_id, production_date: report.value.date, input_quantity: currentInput }).select().single(); if (error) throw error; report.value.currentId = newProd.id; } 
                await loadHistory(); await loadBaseData(); toast("投入數已儲存"); 
            } catch (e) { toast("儲存失敗: " + e.message, "error"); } finally { loading.value = false; } 
        };

        const addDefect = async () => { if (!report.value.currentId) return toast("請先儲存投入數", "warning"); if (!defectForm.value.typeId || !defectForm.value.locationId) return toast("請選擇不良與位置", "warning"); loading.value = true; try { await _supabase.from('defect_logs').insert({ production_id: report.value.currentId, defect_type_id: defectForm.value.typeId, location_id: defectForm.value.locationId, quantity: defectForm.value.qty }); await fetchDailyRecord(); await loadHistory(); defectForm.value.qty = 1; toast("不良紀錄已新增"); } catch (e) { toast("新增失敗", "error"); } finally { loading.value = false; } };
        const deleteDefect = async (id) => { if(!confirm("確定刪除此紀錄？")) return; await _supabase.from('defect_logs').delete().eq('id', id); await fetchDailyRecord(); await loadHistory(); toast("已刪除", "info"); };

        const importDefectCsv = async (e) => {
            const file = e.target.files[0]; if (!file || !report.value.currentId) return toast('請先建立投入數', 'warning');
            loading.value = true;
            try {
                const ab = await file.arrayBuffer();
                const wb = XLSX.read(ab); const ws = wb.Sheets[wb.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
                if (rows.length < 2) { toast('CSV 無資料', 'warning'); loading.value = false; return; }
                const locCodes = rows[0].slice(1).map(c => String(c).trim());
                let addedTypes = 0, addedLocs = 0;
                for (const code of locCodes) {
                    if (!code) continue;
                    if (!data.value.defectLocations.find(l => l.code === code)) {
                        const { error } = await _supabase.from('defect_locations').insert({ code });
                        if (!error) addedLocs++;
                    }
                }
                for (let i = 1; i < rows.length; i++) {
                    const typeName = String(rows[i][0] || '').trim();
                    if (!typeName) continue;
                    if (!data.value.defectTypes.find(t => t.name === typeName)) {
                        const { error } = await _supabase.from('defect_types').insert({ name: typeName });
                        if (!error) addedTypes++;
                    }
                }
                if (addedTypes > 0 || addedLocs > 0) await loadBaseData();
                for (let i = 1; i < rows.length; i++) {
                    const typeName = String(rows[i][0] || '').trim(); if (!typeName) continue;
                    const typeObj = data.value.defectTypes.find(t => t.name === typeName); if (!typeObj) continue;
                    for (let j = 1; j < rows[i].length; j++) {
                        const qty = parseInt(rows[i][j]); if (!qty || qty <= 0) continue;
                        const locCode = locCodes[j - 1]; if (!locCode) continue;
                        const locObj = data.value.defectLocations.find(l => l.code === locCode); if (!locObj) continue;
                        await _supabase.from('defect_logs').insert({ production_id: report.value.currentId, defect_type_id: typeObj.id, location_id: locObj.id, quantity: qty });
                    }
                }
                await fetchDailyRecord(); await loadHistory();
                let msg = '匯入成功';
                if (addedTypes > 0) msg += `，新增 ${addedTypes} 個不良項目`;
                if (addedLocs > 0) msg += `，新增 ${addedLocs} 個位置代碼`;
                toast(msg);
            } catch(err) { toast('匯入失敗: ' + err.message, 'error'); } finally { loading.value = false; e.target.value = ''; }
        };

        const editingDefect = ref(null);
        const startEditDefect = (log) => {
            const typeObj = data.value.defectTypes.find(t => t.name === log.defect_types?.name);
            const locObj = data.value.defectLocations.find(l => l.code === log.defect_locations?.code);
            editingDefect.value = { id: log.id, typeId: typeObj?.id || null, locationId: locObj?.id || null, qty: log.quantity };
        };
        const saveEditDefect = async () => {
            if (!editingDefect.value || !editingDefect.value.typeId || !editingDefect.value.locationId) return toast('請選擇現象與位置', 'warning');
            loading.value = true;
            try {
                await _supabase.from('defect_logs').update({ defect_type_id: editingDefect.value.typeId, location_id: editingDefect.value.locationId, quantity: editingDefect.value.qty }).eq('id', editingDefect.value.id);
                editingDefect.value = null;
                await fetchDailyRecord(); await loadHistory(); toast('已更新');
            } catch(e) { toast('更新失敗', 'error'); } finally { loading.value = false; }
        };
        const deleteDailyRecord = async (id) => { if(!confirm("⚠️ 確定刪除整筆生產紀錄？")) return; loading.value = true; await _supabase.from('defect_logs').delete().eq('production_id', id); await _supabase.from('daily_production').delete().eq('id', id); await loadHistory(); await loadBaseData(); if (report.value.currentId === id) { report.value.currentId = null; report.value.logs = []; report.value.inputQty = 0; report.value.isEditing = false; report.value.originalDate = null; } loading.value = false; toast("紀錄已刪除", "info"); };
        
        // Raw Export (format preserved exactly)
        const exportRawData = async () => { loading.value = true; try { let query = _supabase.from('daily_production').select(`production_date, input_quantity, work_orders!inner (wo_number, models (name), model_id, id), defect_logs (quantity, defect_types (name), defect_locations (code))`); if (rawExportFilter.value.start) query = query.gte('production_date', rawExportFilter.value.start); if (rawExportFilter.value.end) query = query.lte('production_date', rawExportFilter.value.end); const { data: rows, error } = await query; if (error) throw error; let filtered = rows || []; if (rawExportFilter.value.modelId !== 'all') filtered = filtered.filter(r => r.work_orders.model_id == rawExportFilter.value.modelId); if (rawExportFilter.value.woId !== 'all') filtered = filtered.filter(r => r.work_orders.id == rawExportFilter.value.woId); const excelData = []; excelData.push(["日期", "工單號碼", "機種", "當日投入數", "不良現象", "不良位置", "不良數量"]); filtered.forEach(row => { const date = row.production_date; const wo = row.work_orders.wo_number; const model = row.work_orders.models.name; const input = row.input_quantity; if (row.defect_logs && row.defect_logs.length > 0) { row.defect_logs.forEach(log => { excelData.push([ date, wo, model, input, log.defect_types?.name || '', log.defect_locations?.code || '', log.quantity ]); }); } else { excelData.push([date, wo, model, input, "無不良", "", 0]); } }); const wb = XLSX.utils.book_new(); const ws = XLSX.utils.aoa_to_sheet(excelData); XLSX.utils.book_append_sheet(wb, ws, "Raw Data"); XLSX.writeFile(wb, `SMT_Raw_Data_${new Date().toISOString().slice(0,10)}.xlsx`); toast("Raw Data 已導出"); } catch (e) { toast("導出失敗: " + e.message, "error"); } finally { loading.value = false; } };

        // --- FPY Logic (PRESERVED) ---
        const fpyForm = ref({ id: null, date: new Date().toISOString().split('T')[0], selectedWoNumber: null, wo_id: null, spi: '', aoi: '', showAllWo: false });
        const fpyHistory = ref([]);
        const fpyFilter = ref({ start: '', end: '' });
        const showFpyModal = ref(false);
        const showFpyExportModal = ref(false);
        const selectedFpyId = ref(null);
        const fpyDayModal = ref({ show: false, date: '', list: [] });
        const isEditingFpy = ref(false);

        const availableModelsForFpy = computed(() => !fpyForm.value.selectedWoNumber ? [] : data.value.workOrders.filter(w => w.wo_number === fpyForm.value.selectedWoNumber));
        const fpyWoList = computed(() => { if (fpyForm.value.showAllWo) return uniqueWoNumbers.value; return activeWoNumbers.value; });

        const fpyCalendarDays = computed(() => {
            const y = calendarYear.value, m = calendarMonth.value, daysInMonth = new Date(y, m + 1, 0).getDate(), days = [];
            for (let i = 1; i <= daysInMonth; i++) {
                const dStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
                const dailyItems = fpyHistory.value.filter(rec => rec.production_date === dStr).map(rec => ({ id: rec.id, wo_id: rec.wo_id, wo_number: rec.work_orders.wo_number, model_name: rec.work_orders.models.name, spi: rec.spi_rate, aoi: rec.aoi_rate }));
                days.push({ dayNum: i, dateStr: dStr, items: dailyItems });
            } return days;
        });
        const openFpyModal = (rec = null) => { 
            if (rec) { isEditingFpy.value = true; fpyForm.value = { id: rec.id, date: rec.production_date, selectedWoNumber: rec.work_orders.wo_number, wo_id: rec.wo_id, spi: rec.spi_rate, aoi: rec.aoi_rate, showAllWo: true }; } 
            else { isEditingFpy.value = false; fpyForm.value = { id: null, date: getPreviousWorkday(), selectedWoNumber: null, wo_id: null, spi: '', aoi: '', showAllWo: false }; } 
            showFpyModal.value = true; 
        };
        const openFpyDayDetail = (day) => { fpyDayModal.value = { show: true, date: day.dateStr, list: day.items }; };
        
        const fetchFpyRecord = async () => { 
            if (isEditingFpy.value) return;
            if (!fpyForm.value.wo_id || !fpyForm.value.date) return; 
            loading.value = true; fpyForm.value.id = null; fpyForm.value.spi = ''; fpyForm.value.aoi = ''; 
            try { const { data: rec } = await _supabase.from('daily_fpy').select('*').eq('wo_id', fpyForm.value.wo_id).eq('production_date', fpyForm.value.date).maybeSingle(); if (rec) { fpyForm.value.id = rec.id; fpyForm.value.spi = rec.spi_rate; fpyForm.value.aoi = rec.aoi_rate; } } catch(e) { console.error(e); } finally { loading.value = false; } 
        };
        
        const saveFpy = async () => { 
            if (!fpyForm.value.wo_id) return toast("請選擇機種", "warning"); 
            loading.value = true; 
            try { 
                const spiVal = fpyForm.value.spi === '' ? null : fpyForm.value.spi;
                const aoiVal = fpyForm.value.aoi === '' ? null : fpyForm.value.aoi;
                const payload = { wo_id: fpyForm.value.wo_id, production_date: fpyForm.value.date, spi_rate: spiVal, aoi_rate: aoiVal }; 
                if (fpyForm.value.id) await _supabase.from('daily_fpy').update(payload).eq('id', fpyForm.value.id); 
                else await _supabase.from('daily_fpy').insert(payload); 
                await loadFpyHistory(); showFpyModal.value = false; toast("儲存成功"); 
            } catch(e) { toast("儲存失敗: " + e.message, "error"); } finally { loading.value = false; } 
        };

        const importFpyFile = async (e) => {
            const files = Array.from(e.target.files || []);
            if (files.length === 0) return;
            loading.value = true;
            try {
                let totalSuccess = 0, totalSkip = 0, allErrs = [];
                for (const file of files) {
                    const ab = await file.arrayBuffer();
                    const wb = XLSX.read(ab, { type: 'array', cellDates: false });
                    const ws = wb.Sheets[wb.SheetNames[0]];
                    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
                    if (rows.length < 2) { allErrs.push(`${file.name} 無資料`); continue; }
                    const headers = rows[0].map(h => String(h).trim());
                    const find = (...keys) => headers.findIndex(h => keys.some(k => h.includes(k)));
                    const iDate = find('日期'), iWo = find('工單'), iModel = find('機種'), iSpi = find('SPI'), iAoi = find('AOI');
                    if (iDate < 0 || iWo < 0) { allErrs.push(`${file.name} 缺少日期或工單欄位`); continue; }
                    for (let i = 1; i < rows.length; i++) {
                        const r = rows[i]; if (!r || !r[iDate] || !r[iWo]) continue;
                        let dateStr = String(r[iDate]).trim();
                        if (/^\d+(\.\d+)?$/.test(dateStr)) { const d = XLSX.SSF.parse_date_code(parseFloat(dateStr)); if (d) dateStr = `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`; }
                        else { const m = dateStr.replace(/[\/\.]/g,'-').match(/(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) dateStr = `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`; }
                        // 大小寫統一
                        const woNum = String(r[iWo]).trim().toUpperCase();
                        const modelName = iModel >= 0 ? String(r[iModel]).trim().toUpperCase() : '';
                        const parseRate = (v) => { if (v === '' || v == null) return null; const n = parseFloat(String(v).replace('%','').trim()); return isNaN(n) ? null : n; };
                        const spi = iSpi >= 0 ? parseRate(r[iSpi]) : null;
                        const aoi = iAoi >= 0 ? parseRate(r[iAoi]) : null;
                        if (spi === null && aoi === null) { totalSkip++; continue; }
                        const candidates = data.value.workOrders.filter(w => (w.wo_number||'').toUpperCase() === woNum);
                        if (candidates.length === 0) { allErrs.push(`${woNum} 找不到工單`); totalSkip++; continue; }
                        let wo = modelName ? (candidates.find(w => (w.models?.name||'').toUpperCase() === modelName) || candidates.find(w => (w.models?.name||'').toUpperCase().includes(modelName) || modelName.includes((w.models?.name||'').toUpperCase()))) : null;
                        if (!wo) wo = candidates[0];
                        const { data: existing } = await _supabase.from('daily_fpy').select('*').eq('wo_id', wo.id).eq('production_date', dateStr).maybeSingle();
                        const payload = { wo_id: wo.id, production_date: dateStr, spi_rate: spi !== null ? spi : (existing?.spi_rate ?? null), aoi_rate: aoi !== null ? aoi : (existing?.aoi_rate ?? null) };
                        if (existing) await _supabase.from('daily_fpy').update(payload).eq('id', existing.id);
                        else await _supabase.from('daily_fpy').insert(payload);
                        totalSuccess++;
                    }
                }
                await loadFpyHistory();
                let msg = `匯入完成：成功 ${totalSuccess} 筆`;
                if (totalSkip > 0) msg += `，跳過 ${totalSkip} 筆`;
                if (allErrs.length > 0) { msg += `，問題 ${allErrs.length} 筆`; console.warn('FPY 匯入問題:', allErrs); }
                toast(msg, totalSuccess > 0 ? 'success' : 'warning');
            } catch(err) { toast('匯入失敗: ' + err.message, 'error'); }
            finally { loading.value = false; e.target.value = ''; }
        };

        const loadFpyHistory = async () => { const { data: list } = await _supabase.from('daily_fpy').select('*, work_orders(wo_number, models(name))').order('production_date', {ascending:false}).limit(200); if (list) fpyHistory.value = list; };
        const deleteFpy = async (id) => { if(!confirm("確定刪除？")) return; await _supabase.from('daily_fpy').delete().eq('id', id); loadFpyHistory(); toast("已刪除", "info"); };
        const exportFpyData = async () => { loading.value = true; try { let query = _supabase.from('daily_fpy').select('*, work_orders(wo_number, models(name))'); if (fpyFilter.value.start) query = query.gte('production_date', fpyFilter.value.start); if (fpyFilter.value.end) query = query.lte('production_date', fpyFilter.value.end); const { data: rows } = await query; rows.sort((a, b) => { const woA = a.work_orders.wo_number; const woB = b.work_orders.wo_number; if (woA.localeCompare(woB) !== 0) return woA.localeCompare(woB); return new Date(a.production_date) - new Date(b.production_date); }); const excelData = [["日期", "工單號碼", "機種", "SPI 直通率", "AOI 直通率"]]; rows.forEach(r => { excelData.push([r.production_date, r.work_orders.wo_number, r.work_orders.models.name, r.spi_rate ? `${r.spi_rate}%` : '0%', r.aoi_rate ? `${r.aoi_rate}%` : '0%']); }); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(excelData), "FPY Report"); XLSX.writeFile(wb, `SMT_FPY_Report_${new Date().toISOString().slice(0,10)}.xlsx`); toast("FPY 報表已導出"); } catch(e) { toast("導出失敗", "error"); } finally { loading.value = false; } };

        // --- OOC Logic (PRESERVED + notes field) ---
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
                else await _supabase.from('ooc_records').insert(payload);
                await loadOocHistory(); showOocModal.value = false; toast("儲存成功");
            } catch(e) { toast("失敗: " + e.message + " (若無 notes 欄位請忽略此欄)", "error"); } finally { loading.value = false; }
        };
        const loadOocHistory = async () => { const { data: list } = await _supabase.from('ooc_records').select('*, work_orders(wo_number, models(name)), machines(name), ooc_causes(name)').order('production_date', {ascending:false}).limit(200); if(list) oocHistory.value = list; };
        const deleteOoc = async (id) => { if(!confirm("確定刪除？")) return; await _supabase.from('ooc_records').delete().eq('id', id); loadOocHistory(); toast("已刪除", "info"); };
        const openOocDayDetail = (day) => { oocDayModal.value = { show: true, date: day.dateStr, list: day.items }; };

        // --- Order & Calendar Logic (PRESERVED + markWoComplete) ---
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
        const saveWorkOrder = async () => { const { id, number, modelId, selectedModelIds, targetQty } = woForm.value; if (!number || !targetQty) return toast("請填寫工單號碼與數量", "warning"); loading.value = true; try { if (isEditingWo.value && id) { if (!modelId) return toast("請選擇機種", "warning"); await _supabase.from('work_orders').update({ wo_number: number, model_id: modelId, target_quantity: targetQty }).eq('id', id); } else { if (selectedModelIds.length === 0) return toast("請至少勾選一個機種", "warning"); for (const mId of selectedModelIds) { const isDuplicate = data.value.workOrders.some(w => w.wo_number === number && w.model_id === mId); if (!isDuplicate) await _supabase.from('work_orders').insert({ wo_number: number, model_id: mId, target_quantity: targetQty, is_closed: false }); } } showWoModal.value = false; loadBaseData(); toast(isEditingWo.value ? "更新成功" : "工單已建立"); } catch (e) { toast("操作失敗", "error"); } finally { loading.value = false; } };
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

        // --- Stats & Export (format preserved exactly) ---
        const statsFilter = ref({ start: '', end: '', modelId: 'all', woId: 'all' });
        const statsResult = ref(null);
        const selectedDefectType = ref(null);
        const selectedLocCode = ref(null);
        const openLocDetail = (code) => { selectedLocCode.value = code; };
        const typeLocBreakdown = computed(() => {
            if (!selectedDefectType.value || !statsResult.value?.typeLocMap) return [];
            const map = statsResult.value.typeLocMap[selectedDefectType.value] || {};
            return Object.entries(map).map(([code, qty]) => ({ code, qty })).sort((a, b) => b.qty - a.qty);
        });
        const typeLocTotal = computed(() => typeLocBreakdown.value.reduce((s, l) => s + l.qty, 0));
        const locWoBreakdown = computed(() => {
            if (!selectedLocCode.value || !statsResult.value?.locWoMap) return [];
            const map = statsResult.value.locWoMap[selectedLocCode.value] || {};
            return Object.entries(map).map(([wo, qty]) => ({ wo, qty })).sort((a, b) => b.qty - a.qty);
        });
        const locWoTotal = computed(() => locWoBreakdown.value.reduce((s, w) => s + w.qty, 0));
        const trendColors = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6'];
        const trendTypeColor = (typeName) => {
            if (!statsResult.value || !statsResult.value.topTypeNames) return '#6b7280';
            const idx = statsResult.value.topTypeNames.indexOf(typeName);
            return idx >= 0 ? trendColors[idx % trendColors.length] : '#6b7280';
        };
        
        // 趨勢圖座標計算
        const chartMaxRate = computed(() => {
            if (!statsResult.value?.trend) return 5;
            const max = Math.max(...statsResult.value.trend.map(d => parseFloat(d.defectRate)));
            return Math.max(1, Math.ceil(max * 1.2));
        });
        const chartMaxQty = computed(() => {
            if (!statsResult.value?.trend || !statsResult.value?.topTypeNames) return 10;
            let max = 0;
            statsResult.value.trend.forEach(d => { statsResult.value.topTypeNames.forEach(t => { if ((d.byType[t] || 0) > max) max = d.byType[t]; }); });
            return Math.max(5, Math.ceil(max * 1.2));
        });
        const trendY = (rate) => 40 + (1 - rate / chartMaxRate.value) * 160;
        const trendYQty = (qty) => 40 + (1 - qty / chartMaxQty.value) * 160;
        const trendLinePoints = (kind, typeName) => {
            if (!statsResult.value?.trend) return '';
            const trend = statsResult.value.trend;
            const w = Math.max(600, trend.length * 80);
            const step = (w - 100) / Math.max(1, trend.length - 1);
            return trend.map((d, i) => {
                const x = 80 + i * step;
                const y = kind === 'rate' ? trendY(parseFloat(d.defectRate)) : trendYQty(d.byType[typeName] || 0);
                return `${x},${y}`;
            }).join(' ');
        };
        const calculateStats = async () => { 
            loading.value = true; 
            try { 
                let query = _supabase.from('daily_production').select(`id, production_date, input_quantity, work_orders!inner (id, wo_number, model_id, models(name)), defect_logs (quantity, defect_types(name), defect_locations(code))`); 
                if (statsFilter.value.start) query = query.gte('production_date', statsFilter.value.start); 
                if (statsFilter.value.end) query = query.lte('production_date', statsFilter.value.end); 
                const { data: rows } = await query; 
                let filtered = rows || []; 
                if (statsFilter.value.modelId !== 'all') filtered = filtered.filter(r => r.work_orders.model_id == statsFilter.value.modelId); 
                if (statsFilter.value.woId !== 'all') filtered = filtered.filter(r => r.work_orders.wo_number === statsFilter.value.woId); 
                
                let totalInput = 0, totalDefects = 0, typeMap = {}, locMap = {}; 
                const typeLocMap = {}; // { typeName: { locCode: qty } }
                const locWoMap = {}; // { locCode: { woNumber: qty } }
                // Per-day data for trend
                const dayMap = {}; // { date: { input, defects, byType:{type:qty} } }
                // Location frequency: how many days each location appeared
                const locAppearance = {}; // { code: Set(dates) }
                // Location qty per day for baseline
                const locDayQty = {}; // { code: [qty, qty...] }
                
                filtered.forEach(day => { 
                    totalInput += day.input_quantity; 
                    if (!dayMap[day.production_date]) dayMap[day.production_date] = { date: day.production_date, input: 0, defects: 0, byType: {} };
                    dayMap[day.production_date].input += day.input_quantity;
                    
                    const dayLocQty = {};
                    day.defect_logs.forEach(log => { 
                        totalDefects += log.quantity; 
                        const tName = log.defect_types?.name || 'Unknown'; 
                        typeMap[tName] = (typeMap[tName] || 0) + log.quantity; 
                        const lCode = log.defect_locations?.code || 'Unknown'; 
                        locMap[lCode] = (locMap[lCode] || 0) + log.quantity; 
                        
                        if (!typeLocMap[tName]) typeLocMap[tName] = {};
                        typeLocMap[tName][lCode] = (typeLocMap[tName][lCode] || 0) + log.quantity;
                        
                        const woNum = day.work_orders?.wo_number || 'Unknown';
                        if (!locWoMap[lCode]) locWoMap[lCode] = {};
                        locWoMap[lCode][woNum] = (locWoMap[lCode][woNum] || 0) + log.quantity;
                        
                        dayMap[day.production_date].defects += log.quantity;
                        dayMap[day.production_date].byType[tName] = (dayMap[day.production_date].byType[tName] || 0) + log.quantity;
                        
                        if (!locAppearance[lCode]) locAppearance[lCode] = new Set();
                        locAppearance[lCode].add(day.production_date);
                        
                        dayLocQty[lCode] = (dayLocQty[lCode] || 0) + log.quantity;
                    }); 
                    Object.entries(dayLocQty).forEach(([code, qty]) => {
                        if (!locDayQty[code]) locDayQty[code] = [];
                        locDayQty[code].push(qty);
                    });
                }); 
                
                const byType = Object.entries(typeMap).map(([name, qty]) => ({ name, qty, ratio: totalDefects ? (qty/totalDefects*100).toFixed(1) : 0 })).sort((a,b) => b.qty - a.qty); 
                const byLocation = Object.entries(locMap).map(([code, qty]) => ({ code, qty })).sort((a,b) => b.qty - a.qty); 
                
                // Top 10 Location Pareto (with appearance count = 系統性指標)
                const totalDays = Object.keys(dayMap).length;
                const topLocations = byLocation.slice(0, 10).map(l => ({
                    ...l,
                    appearDays: locAppearance[l.code] ? locAppearance[l.code].size : 0,
                    totalDays,
                    isSystemic: locAppearance[l.code] && totalDays > 0 && (locAppearance[l.code].size / totalDays) >= 0.5
                }));
                
                // Trend (sorted by date)
                const trend = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date)).map(d => ({
                    date: d.date,
                    input: d.input,
                    defects: d.defects,
                    defectRate: d.input ? ((d.defects / d.input) * 100).toFixed(2) : '0.00',
                    byType: d.byType
                }));
                
                // Top types for trend coloring
                const topTypeNames = byType.slice(0, 5).map(t => t.name);
                
                // Baseline anomaly: for each location, compute mean+2σ from past days, check if latest exceeds
                const anomalies = [];
                Object.entries(locDayQty).forEach(([code, qtyList]) => {
                    if (qtyList.length < 3) return; // need at least 3 data points
                    const past = qtyList.slice(0, -1); // exclude latest
                    const latest = qtyList[qtyList.length - 1];
                    const mean = past.reduce((a, b) => a + b, 0) / past.length;
                    const variance = past.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / past.length;
                    const std = Math.sqrt(variance);
                    const threshold = mean + 2 * std;
                    if (latest > threshold && latest > mean) {
                        anomalies.push({ code, latest, baseline: mean.toFixed(1), threshold: threshold.toFixed(1), sigma: std.toFixed(2) });
                    }
                });
                anomalies.sort((a, b) => b.latest - a.latest);
                
                statsResult.value = { 
                    totalInput, totalDefects, 
                    yieldRate: totalInput ? ((totalInput - totalDefects) / totalInput * 100).toFixed(2) : 100, 
                    byType, byLocation, typeLocMap, locWoMap,
                    topLocations, trend, topTypeNames, anomalies, totalDays
                }; 
                toast("統計完成"); 
            } catch (e) { toast("統計失敗: " + e.message, "error"); } finally { loading.value = false; } 
        };
        
        const getStatsReportWeekNumber = () => {
            const dateSource = statsFilter.value.start || statsFilter.value.end || formatLocalDate(new Date());
            const [year, month, day] = dateSource.split('-').map(Number);
            const date = new Date(Date.UTC(year, month - 1, day));
            const weekDay = date.getUTCDay() || 7;
            date.setUTCDate(date.getUTCDate() + 4 - weekDay);
            const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
            return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
        };

        const exportToExcel = async () => {
            if (!statsResult.value) return toast("請先執行統計", "warning");
            loading.value = true;
            try {
                const combinedData = [["=== 總結報告 ==="], ["統計區間", `${statsFilter.value.start || '不限'} ~ ${statsFilter.value.end || '不限'}`], ["總投入數", statsResult.value.totalInput], ["總不良數", statsResult.value.totalDefects], ["良率", `${statsResult.value.yieldRate}%`], [], ["=== 不良現象分析 ==="], ["不良現象", "數量", "佔比"], ...statsResult.value.byType.map(d => [d.name, d.qty, `${d.ratio}%`]), [], ["=== 位置異常分析 ==="], ["位置", "數量"], ...statsResult.value.byLocation.map(d => [d.code, d.qty])];
                const wb = XLSX.utils.book_new();
                const wsYield = XLSX.utils.aoa_to_sheet(combinedData);
                XLSX.utils.book_append_sheet(wb, wsYield, "良率報告");

                let fpyQuery = _supabase.from('daily_fpy').select('*, work_orders(wo_number, models(name))');
                if (statsFilter.value.start) fpyQuery = fpyQuery.gte('production_date', statsFilter.value.start);
                if (statsFilter.value.end) fpyQuery = fpyQuery.lte('production_date', statsFilter.value.end);
                const { data: fpyRows } = await fpyQuery;
                
                let filteredFpy = fpyRows || [];
                if (statsFilter.value.modelId !== 'all') filteredFpy = filteredFpy.filter(r => r.work_orders.model_id == statsFilter.value.modelId); 
                
                filteredFpy.sort((a, b) => {
                    const woA = a.work_orders.wo_number;
                    const woB = b.work_orders.wo_number;
                    if (woA.localeCompare(woB) !== 0) return woA.localeCompare(woB);
                    return new Date(a.production_date) - new Date(b.production_date);
                });

                const fpyExcelData = [["日期", "工單號碼", "機種", "SPI 直通率", "AOI 直通率"]];
                filteredFpy.forEach(r => {
                    fpyExcelData.push([r.production_date, r.work_orders.wo_number, r.work_orders.models.name, r.spi_rate ? `${r.spi_rate}%` : '0%', r.aoi_rate ? `${r.aoi_rate}%` : '0%']);
                });
                
                const wsFpy = XLSX.utils.aoa_to_sheet(fpyExcelData);
                XLSX.utils.book_append_sheet(wb, wsFpy, "直通率報告");

                XLSX.writeFile(wb, `SMT第${getStatsReportWeekNumber()}週良率報表.xlsx`);
                toast("完整報表已導出");
            } catch(e) { toast("導出失敗: " + e.message, "error"); } finally { loading.value = false; }
        };

        // --- Equipment Management ---
        const eqTab = ref('feeder');
        const eqData = ref({ feederModels: [], nozzleModels: [] });
        const feederList = ref([]);
        const nozzleLogs = ref([]);
        const showFeederModal = ref(false);
        const showFeederLogModal = ref(false);
        const showNozzleLogModal = ref(false);
        const feederForm = ref({ id: null, feeder_model_id: null, slot_number: '', mes_code_left: '', mes_code_right: '', purchase_date: '', status: 'active' });
        const selectedFeederId = ref(null);
        const calHistory = ref([]);
        const feederLogForm = ref({ calibration_date: new Date().toISOString().split('T')[0], next_calibration_date: '', result: 'pass', notes: '', log_type: 'calibration' });
        const nozzleLogForm = ref({ nozzle_model_id: null, change_type: 'in', quantity: 1, log_date: new Date().toISOString().split('T')[0], notes: '' });
        const selectedNozzleModelId = ref(null);
        const eqSettingForm = ref({ feederBrand: '', feederModel: '', nozzleBrand: '', nozzleModel: '' });

        const selectedFeederObj = computed(() => feederList.value.find(f => f.id === selectedFeederId.value) || null);
        const selectedNozzleModelName = computed(() => { const ns = nozzleStock.value.find(s => s.model_id === selectedNozzleModelId.value); return ns ? `${ns.brand} ${ns.model}` : ''; });
        const filteredNozzleLogs = computed(() => { if (!selectedNozzleModelId.value) return nozzleLogs.value; return nozzleLogs.value.filter(l => l.nozzle_model_id === selectedNozzleModelId.value); });

        // --- Feeder Sort ---
        const feederSort = ref({ key: 'slot_number', dir: 'asc' });
        const setFeederSort = (key) => { if (feederSort.value.key === key) feederSort.value.dir = feederSort.value.dir === 'asc' ? 'desc' : 'asc'; else { feederSort.value.key = key; feederSort.value.dir = 'asc'; } };
        const feederSortIcon = (key) => { if (feederSort.value.key !== key) return 'fas fa-sort text-gray-300'; return feederSort.value.dir === 'asc' ? 'fas fa-sort-up text-teal-600' : 'fas fa-sort-down text-teal-600'; };
        const sortedFeederList = computed(() => {
            const list = [...feederList.value];
            const { key, dir } = feederSort.value;
            const mult = dir === 'asc' ? 1 : -1;
            list.sort((a, b) => {
                let va, vb;
                if (key === 'brand') { va = a.feeder_models?.brand || ''; vb = b.feeder_models?.brand || ''; }
                else if (key === 'model') { va = a.feeder_models?.model || ''; vb = b.feeder_models?.model || ''; }
                else { va = a[key] || ''; vb = b[key] || ''; }
                if (typeof va === 'string') return va.localeCompare(vb) * mult;
                return ((va > vb ? 1 : va < vb ? -1 : 0)) * mult;
            });
            return list;
        });

        // --- Nozzle Sort ---
        const nozzleSort = ref({ key: 'model', dir: 'asc' });
        const setNozzleSort = (key) => { if (nozzleSort.value.key === key) nozzleSort.value.dir = nozzleSort.value.dir === 'asc' ? 'desc' : 'asc'; else { nozzleSort.value.key = key; nozzleSort.value.dir = 'asc'; } };
        const nozzleSortIcon = (key) => { if (nozzleSort.value.key !== key) return 'fas fa-sort text-gray-300'; return nozzleSort.value.dir === 'asc' ? 'fas fa-sort-up text-orange-500' : 'fas fa-sort-down text-orange-500'; };
        const sortedNozzleStock = computed(() => {
            const list = [...nozzleStock.value];
            const { key, dir } = nozzleSort.value;
            const mult = dir === 'asc' ? 1 : -1;
            list.sort((a, b) => {
                let va, vb;
                if (key === 'model') { va = `${a.brand} ${a.model}`; vb = `${b.brand} ${b.model}`; return va.localeCompare(vb) * mult; }
                else { va = a[key] || 0; vb = b[key] || 0; return (va - vb) * mult; }
            });
            return list;
        });

        const selectFeeder = async (f) => {
            selectedFeederId.value = selectedFeederId.value === f.id ? null : f.id;
            if (selectedFeederId.value) {
                const { data: list } = await _supabase.from('feeder_calibrations').select('*').eq('feeder_id', f.id).order('calibration_date', { ascending: false });
                calHistory.value = list || [];
            } else { calHistory.value = []; }
        };
        const selectNozzleModel = (modelId) => { selectedNozzleModelId.value = selectedNozzleModelId.value === modelId ? null : modelId; };
        const openFeederLogModal = (type = 'calibration') => {
            feederLogForm.value = { calibration_date: new Date().toISOString().split('T')[0], next_calibration_date: '', result: type === 'calibration' ? 'pass' : '', notes: '', log_type: type };
            showFeederLogModal.value = true;
        };

        const loadEqData = async () => {
            const [fm, nm] = await Promise.all([
                _supabase.from('feeder_models').select('*').order('brand'),
                _supabase.from('nozzle_models').select('*').order('brand')
            ]);
            eqData.value.feederModels = fm.data || [];
            eqData.value.nozzleModels = nm.data || [];
        };

        const loadFeeders = async () => {
            const { data: list, error } = await _supabase.from('feeders').select('*, feeder_models(brand, model)').order('slot_number');
            if (error) { 
                console.error('loadFeeders join error, trying without join:', error);
                // Fallback: load without join, manually map model info
                const { data: rawList } = await _supabase.from('feeders').select('*').order('slot_number');
                const mapped = (rawList || []).map(f => {
                    const fm = eqData.value.feederModels.find(m => m.id === f.feeder_model_id);
                    return { ...f, feeder_models: fm || { brand: '-', model: '-' } };
                });
                feederList.value = mapped.map(f => ({ ...f, _calStatus: 'none', _lastCal: null }));
                return;
            }
            const todayDate = new Date().toISOString().split('T')[0];
            const soon = new Date(); soon.setDate(soon.getDate() + 30);
            const soonStr = soon.toISOString().split('T')[0];
            const feederIds = (list || []).map(f => f.id);
            let calMap = {};
            if (feederIds.length > 0) {
                const { data: cals } = await _supabase.from('feeder_calibrations').select('*').in('feeder_id', feederIds).order('calibration_date', { ascending: false });
                (cals || []).forEach(c => { if (!calMap[c.feeder_id]) calMap[c.feeder_id] = c; });
            }
            feederList.value = (list || []).map(f => {
                const lastCal = calMap[f.id];
                let _calStatus = 'none';
                if (lastCal && lastCal.next_calibration_date) {
                    if (lastCal.next_calibration_date < todayDate) _calStatus = 'overdue';
                    else if (lastCal.next_calibration_date <= soonStr) _calStatus = 'soon';
                    else _calStatus = 'ok';
                }
                return { ...f, _calStatus, _lastCal: lastCal };
            });
        };

        const loadNozzleLogs = async () => {
            const { data: list, error } = await _supabase.from('nozzle_inventory_logs').select('*, nozzle_models(brand, model)').order('log_date', { ascending: false }).limit(200);
            if (error) {
                console.error('loadNozzleLogs join error, trying without join:', error);
                const { data: rawList } = await _supabase.from('nozzle_inventory_logs').select('*').order('log_date', { ascending: false }).limit(200);
                nozzleLogs.value = (rawList || []).map(log => {
                    const nm = eqData.value.nozzleModels.find(m => m.id === log.nozzle_model_id);
                    return { ...log, nozzle_models: nm || { brand: '-', model: '-' } };
                });
                return;
            }
            nozzleLogs.value = list || [];
        };

        const nozzleStock = computed(() => {
            const map = {};
            nozzleLogs.value.forEach(log => {
                const mid = log.nozzle_model_id;
                if (!map[mid]) map[mid] = { model_id: mid, brand: log.nozzle_models?.brand, model: log.nozzle_models?.model, totalIn: 0, inUse: 0, damaged: 0 };
                if (log.change_type === 'in') map[mid].totalIn += log.quantity;
                else if (log.change_type === 'use') map[mid].inUse += log.quantity;
                else map[mid].damaged += log.quantity; // broken + scrap
            });
            // Also include models with no logs
            eqData.value.nozzleModels.forEach(m => {
                if (!map[m.id]) map[m.id] = { model_id: m.id, brand: m.brand, model: m.model, totalIn: 0, inUse: 0, damaged: 0 };
            });
            return Object.values(map).map(s => ({ ...s, stock: s.totalIn - s.inUse - s.damaged }));
        });

        const feederSummary = computed(() => {
            const inUse = feederList.value.filter(f => f.status === 'in_use').length;
            return { total: feederList.value.length, inUse, idle: feederList.value.length - inUse };
        });

        const toggleFeederStatus = async (newStatus) => {
            if (!selectedFeederId.value) return;
            loading.value = true;
            try {
                const { error } = await _supabase.from('feeders').update({ status: newStatus }).eq('id', selectedFeederId.value);
                if (error) throw error;
                // 寫入紀錄
                const logType = newStatus === 'in_use' ? 'use' : 'return';
                await _supabase.from('feeder_calibrations').insert({ feeder_id: selectedFeederId.value, calibration_date: new Date().toISOString().split('T')[0], log_type: logType, result: newStatus === 'in_use' ? '領用上機' : '歸還入庫', notes: null });
                await loadFeeders();
                // 刷新紀錄
                const { data: list } = await _supabase.from('feeder_calibrations').select('*').eq('feeder_id', selectedFeederId.value).order('calibration_date', { ascending: false });
                calHistory.value = list || [];
                toast(newStatus === 'in_use' ? '已標記為使用中' : '已歸還入庫');
            } catch(e) { toast('操作失敗: ' + e.message, 'error'); } finally { loading.value = false; }
        };

        const openFeederModal = (f = null) => {
            if (f) feederForm.value = { id: f.id, feeder_model_id: f.feeder_model_id, slot_number: f.slot_number, mes_code_left: f.mes_code_left || '', mes_code_right: f.mes_code_right || '', purchase_date: f.purchase_date || '', status: f.status || 'active' };
            else feederForm.value = { id: null, feeder_model_id: null, slot_number: '', mes_code_left: '', mes_code_right: '', purchase_date: new Date().toISOString().split('T')[0], status: 'active' };
            showFeederModal.value = true;
        };

        const saveFeeder = async () => {
            if (!feederForm.value.slot_number || !feederForm.value.feeder_model_id) return toast('請填寫料槍編號與型號', 'warning');
            loading.value = true;
            try {
                const editId = feederForm.value.id;
                const others = feederList.value.filter(f => f.id !== editId);
                
                // 檢查料槍編號重複
                if (others.some(f => f.slot_number === feederForm.value.slot_number)) {
                    loading.value = false;
                    return toast('料槍編號「' + feederForm.value.slot_number + '」已存在', 'error');
                }
                // 檢查 MES 左重複（有填才檢查）
                const mesL = feederForm.value.mes_code_left?.trim();
                if (mesL) {
                    const dupL = others.find(f => f.mes_code_left === mesL || f.mes_code_right === mesL);
                    if (dupL) { loading.value = false; return toast('MES 編號「' + mesL + '」已被 ' + dupL.slot_number + ' 使用', 'error'); }
                }
                // 檢查 MES 右重複（有填才檢查）
                const mesR = feederForm.value.mes_code_right?.trim();
                if (mesR) {
                    const dupR = others.find(f => f.mes_code_left === mesR || f.mes_code_right === mesR);
                    if (dupR) { loading.value = false; return toast('MES 編號「' + mesR + '」已被 ' + dupR.slot_number + ' 使用', 'error'); }
                }
                // 檢查左右不能相同
                if (mesL && mesR && mesL === mesR) { loading.value = false; return toast('MES 左右編號不能相同', 'error'); }

                const payload = { feeder_model_id: feederForm.value.feeder_model_id, slot_number: feederForm.value.slot_number, mes_code_left: mesL || null, mes_code_right: mesR || null, purchase_date: feederForm.value.purchase_date || null, status: feederForm.value.status };
                let error;
                if (editId) ({ error } = await _supabase.from('feeders').update(payload).eq('id', editId));
                else ({ error } = await _supabase.from('feeders').insert(payload));
                if (error) throw error;
                showFeederModal.value = false; await loadFeeders(); toast('Feeder 已儲存');
            } catch(e) { toast('儲存失敗: ' + e.message, 'error'); } finally { loading.value = false; }
        };

        const deleteFeeder = async (id) => { if (!confirm('確定刪除此 Feeder？相關校正紀錄也會一併刪除')) return; loading.value = true; await _supabase.from('feeder_calibrations').delete().eq('feeder_id', id); await _supabase.from('feeders').delete().eq('id', id); await loadFeeders(); loading.value = false; toast('已刪除', 'info'); };

        const saveCalibration = async () => {
            if (!feederLogForm.value.calibration_date || !selectedFeederId.value) return toast('請填日期', 'warning');
            loading.value = true;
            try {
                const payload = { feeder_id: selectedFeederId.value, calibration_date: feederLogForm.value.calibration_date, next_calibration_date: feederLogForm.value.next_calibration_date || null, result: feederLogForm.value.result || null, notes: feederLogForm.value.notes || null, log_type: feederLogForm.value.log_type || 'calibration' };
                const { error } = await _supabase.from('feeder_calibrations').insert(payload);
                if (error) throw error;
                const { data: list } = await _supabase.from('feeder_calibrations').select('*').eq('feeder_id', selectedFeederId.value).order('calibration_date', { ascending: false });
                calHistory.value = list || [];
                await loadFeeders();
                showFeederLogModal.value = false;
                toast('紀錄已新增');
            } catch(e) { toast('失敗: ' + e.message, 'error'); } finally { loading.value = false; }
        };

        const deleteCalibration = async (id) => { if (!confirm('確定刪除？')) return; await _supabase.from('feeder_calibrations').delete().eq('id', id); if (selectedFeederId.value) { const { data: list } = await _supabase.from('feeder_calibrations').select('*').eq('feeder_id', selectedFeederId.value).order('calibration_date', { ascending: false }); calHistory.value = list || []; } await loadFeeders(); toast('已刪除', 'info'); };

        const openNozzleLogModal = (type = 'in') => { nozzleLogForm.value = { nozzle_model_id: null, change_type: type, quantity: 1, log_date: new Date().toISOString().split('T')[0], notes: '' }; showNozzleLogModal.value = true; };

        const saveNozzleLog = async () => {
            if (!nozzleLogForm.value.nozzle_model_id || !nozzleLogForm.value.quantity) return toast('請填寫完整', 'warning');
            loading.value = true;
            try {
                const { error } = await _supabase.from('nozzle_inventory_logs').insert({ nozzle_model_id: nozzleLogForm.value.nozzle_model_id, change_type: nozzleLogForm.value.change_type, quantity: nozzleLogForm.value.quantity, log_date: nozzleLogForm.value.log_date, notes: nozzleLogForm.value.notes || null });
                if (error) throw error;
                showNozzleLogModal.value = false; await loadNozzleLogs(); toast('紀錄已新增');
            } catch(e) { toast('失敗: ' + e.message, 'error'); } finally { loading.value = false; }
        };

        const deleteNozzleLog = async (id) => { if (!confirm('確定刪除？')) return; await _supabase.from('nozzle_inventory_logs').delete().eq('id', id); await loadNozzleLogs(); toast('已刪除', 'info'); };

        // Equipment settings helpers
        const addFeederModel = async () => { const b = eqSettingForm.value.feederBrand.trim(); const m = eqSettingForm.value.feederModel.trim(); if (!b || !m) return toast('請填廠牌與型號', 'warning'); const { error } = await _supabase.from('feeder_models').insert({ brand: b, model: m }); if (error) return toast('新增失敗: ' + error.message + ' (請確認 RLS 已關閉或已設定 Policy)', 'error'); eqSettingForm.value.feederBrand = ''; eqSettingForm.value.feederModel = ''; await loadEqData(); toast('已新增'); };
        const addNozzleModel = async () => { const b = eqSettingForm.value.nozzleBrand.trim(); const m = eqSettingForm.value.nozzleModel.trim(); if (!b || !m) return toast('請填廠牌與型號', 'warning'); const { error } = await _supabase.from('nozzle_models').insert({ brand: b, model: m }); if (error) return toast('新增失敗: ' + error.message + ' (請確認 RLS 已關閉或已設定 Policy)', 'error'); eqSettingForm.value.nozzleBrand = ''; eqSettingForm.value.nozzleModel = ''; await loadEqData(); toast('已新增'); };
        const deleteEqModel = async (table, id) => { if (!confirm('確定刪除？')) return; const { error } = await _supabase.from(table).delete().eq('id', id); if (error) return toast('刪除失敗: ' + error.message, 'error'); await loadEqData(); toast('已刪除', 'info'); };

        // --- Settings (PRESERVED) ---
        const settingConfig = ref({ 
            models: { title: '機種清單', colorClass: 'text-indigo-600', btnColor: 'bg-indigo-600', input: '', placeholder: '新機種名稱', field: 'name' }, 
            defect_types: { title: '不良項目', colorClass: 'text-red-600', btnColor: 'bg-red-600', input: '', placeholder: '不良現象', field: 'name' }, 
            defect_locations: { title: '位置代碼', colorClass: 'text-green-600', btnColor: 'bg-green-600', input: '', placeholder: '位置代碼', field: 'code' },
            machines: { title: '機台清單', colorClass: 'text-purple-600', btnColor: 'bg-purple-600', input: '', placeholder: '機台名稱', field: 'name' },
            ooc_causes: { title: 'OOC 原因', colorClass: 'text-pink-600', btnColor: 'bg-pink-600', input: '', placeholder: '異常原因', field: 'name' }
        });
        const editingId = ref(null); const editingValue = ref('');
        const sortedList = (key) => { 
            let list = [];
            if(['models','defect_types','defect_locations'].includes(key)) list = data.value[key.replace(/_([a-z])/g, (g) => g[1].toUpperCase())] || data.value[key];
            else list = data.value[key.replace('ooc_causes', 'oocCauses')] || [];
            const field = settingConfig.value[key].field; 
            return [...list].sort((a, b) => a[field].localeCompare(b[field], 'zh-Hant')); 
        };
        const addSettingItem = async (key) => { const cfg = settingConfig.value[key]; const val = cfg.input.trim(); if (!val) return; await _supabase.from(key).insert({ [cfg.field]: val }); cfg.input = ''; loadBaseData(); toast("已新增"); };
        const deleteSettingItem = async (key, id) => { if(!confirm("確定刪除？")) return; await _supabase.from(key).delete().eq('id', id); loadBaseData(); toast("已刪除", "info"); };
        const startEdit = (id, val) => { editingId.value = id; editingValue.value = val; };
        const saveEdit = async (key, id, field) => { if (!editingValue.value.trim()) return; await _supabase.from(key).update({ [field]: editingValue.value }).eq('id', id); editingId.value = null; loadBaseData(); toast("已更新"); };

        // --- Base Data Load (PRESERVED) ---
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
        const sortedDefectTypes = computed(() => [...data.value.defectTypes].sort((a,b) => a.name.localeCompare(b.name)));
        const sortedLocations = computed(() => [...data.value.defectLocations].sort((a,b) => a.code.localeCompare(b.code)));

 
        // ==================== ECHARTS: DASHBOARD CHARTS ====================
        let dashYieldChartInst = null;
        let dashInputChartInst = null;
        let paretoChartInst = null;

        const initDashboardCharts = async () => {
            const today = new Date();
            const days = [];
            for (let i = 13; i >= 0; i--) {
                const d = new Date(today); d.setDate(d.getDate() - i);
                days.push(d.toISOString().split('T')[0]);
            }
            const { data: prods } = await _supabase
                .from('daily_production')
                .select('production_date, input_quantity, defect_logs(quantity)')
                .gte('production_date', days[0]).lte('production_date', days[days.length-1]);
            const dayMap = {};
            days.forEach(d => { dayMap[d] = { input: 0, defects: 0 }; });
            (prods || []).forEach(p => {
                if (dayMap[p.production_date]) {
                    dayMap[p.production_date].input += p.input_quantity;
                    dayMap[p.production_date].defects += (p.defect_logs||[]).reduce((s,d)=>s+d.quantity,0);
                }
            });
            const labels = days.map(d => d.slice(5));
            const yields = days.map(d => { const {input,defects}=dayMap[d]; return input>0?parseFloat(((input-defects)/input*100).toFixed(2)):null; });
            const inputs = days.map(d => dayMap[d].input);
            await Vue.nextTick();
            const yieldEl = document.getElementById('dashYieldChart');
            if (yieldEl) {
                if (!dashYieldChartInst) dashYieldChartInst = echarts.init(yieldEl);
                dashYieldChartInst.setOption({
                    grid:{top:28,right:20,bottom:36,left:48},
                    tooltip:{trigger:'axis',formatter:p=>{const v=p[0];return v.name+'<br/>'+(v.value!==null?'<b>'+v.value+'%</b>':'無資料');}},
                    xAxis:{type:'category',data:labels,axisLabel:{fontSize:10,color:'#9ca3af'},axisLine:{lineStyle:{color:'#e5e7eb'}},splitLine:{show:false}},
                    yAxis:{type:'value',min:v=>Math.max(90,Math.floor(v.min-1)),max:100,axisLabel:{formatter:'{value}%',fontSize:10,color:'#9ca3af'},splitLine:{lineStyle:{color:'#f3f4f6'}}},
                    series:[{type:'line',data:yields,smooth:true,symbol:'circle',symbolSize:5,lineStyle:{color:'#7c3aed',width:2.5},itemStyle:{color:'#7c3aed'},areaStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:'rgba(124,58,237,0.15)'},{offset:1,color:'rgba(124,58,237,0)'}]}},markLine:{silent:true,lineStyle:{color:'#dc2626',type:'dashed',width:1},data:[{yAxis:98,label:{formatter:'目標98%',position:'end',fontSize:10,color:'#dc2626'}}]}}]
                });
            }
            const inputEl = document.getElementById('dashInputChart');
            if (inputEl) {
                if (!dashInputChartInst) dashInputChartInst = echarts.init(inputEl);
                dashInputChartInst.setOption({
                    grid:{top:28,right:20,bottom:36,left:48},
                    tooltip:{trigger:'axis',formatter:p=>p[0].name+'<br/><b>'+p[0].value+' pcs</b>'},
                    xAxis:{type:'category',data:labels,axisLabel:{fontSize:10,color:'#9ca3af'},axisLine:{lineStyle:{color:'#e5e7eb'}},splitLine:{show:false}},
                    yAxis:{type:'value',axisLabel:{fontSize:10,color:'#9ca3af'},splitLine:{lineStyle:{color:'#f3f4f6'}}},
                    series:[{type:'bar',data:inputs,barMaxWidth:28,itemStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:'#2563eb'},{offset:1,color:'#93c5fd'}]},borderRadius:[4,4,0,0]},emphasis:{itemStyle:{color:'#1d4ed8'}}}]
                });
            }
        };

        const renderParetoChart = () => {
            Vue.nextTick(() => {
                const el = document.getElementById('paretoChart');
                if (!el || !statsResult.value || !statsResult.value.byType || statsResult.value.byType.length===0) return;
                if (!paretoChartInst) paretoChartInst = echarts.init(el);
                const sorted = [...statsResult.value.byType].sort((a,b)=>b.qty-a.qty);
                const names = sorted.map(x=>x.name); const qtys = sorted.map(x=>x.qty);
                const total = qtys.reduce((s,v)=>s+v,0);
                let cum=0; const cumPct=qtys.map(q=>{cum+=q;return parseFloat((cum/total*100).toFixed(1));});
                paretoChartInst.setOption({
                    tooltip:{trigger:'axis',axisPointer:{type:'shadow'}},
                    legend:{data:['不良數量','累積佔比'],top:4,right:10,textStyle:{fontSize:11,color:'#6b7280'}},
                    grid:{top:40,right:60,bottom:60,left:50},
                    xAxis:{type:'category',data:names,axisLabel:{fontSize:10,color:'#374151',rotate:names.some(n=>n.length>4)?20:0},axisLine:{lineStyle:{color:'#e5e7eb'}}},
                    yAxis:[{type:'value',name:'數量',nameTextStyle:{color:'#6b7280',fontSize:10},axisLabel:{fontSize:10,color:'#9ca3af'},splitLine:{lineStyle:{color:'#f3f4f6'}}},{type:'value',name:'累積%',min:0,max:100,nameTextStyle:{color:'#6b7280',fontSize:10},axisLabel:{formatter:'{value}%',fontSize:10,color:'#9ca3af'},splitLine:{show:false}}],
                    series:[
                        {name:'不良數量',type:'bar',data:qtys,barMaxWidth:40,itemStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:'#dc2626'},{offset:1,color:'#fca5a5'}]},borderRadius:[4,4,0,0]},label:{show:true,position:'top',fontSize:10,color:'#374151',formatter:'{c}'}},
                        {name:'累積佔比',type:'line',yAxisIndex:1,data:cumPct,smooth:true,symbol:'circle',symbolSize:5,lineStyle:{color:'#2563eb',width:2},itemStyle:{color:'#2563eb'},label:{show:true,position:'top',fontSize:9,color:'#2563eb',formatter:'{c}%'},markLine:{silent:true,lineStyle:{color:'#d97706',type:'dashed',width:1.5},data:[{yAxis:80,label:{formatter:'80%',position:'start',fontSize:10,color:'#d97706'}}]}}
                    ]
                });
            });
        };

        watch(() => statsResult.value, (val) => { if (val && currentTab.value==='stats') renderParetoChart(); });
        watch(currentTab, async (tab) => { if (tab==='dashboard') { await initDashboardCharts(); } else if (tab==='stats' && statsResult.value) { renderParetoChart(); } });

        // Close mobile menu when tab changes
        watch(currentTab, () => { showMobileMore.value = false; });

        onMounted(async () => { 
            loadFpyTargets();
            await loadBaseData(); 
            loadHistory(); 
            loadFpyHistory(); 
            loadOocHistory(); 
            refreshDashboard();
            loadEqData();
            loadFeeders();
            loadNozzleLogs();
            setTimeout(() => initDashboardCharts(), 800);
            const today = new Date(); 
            rawExportFilter.value.end = today.toISOString().split('T')[0]; 
            fpyFilter.value.end = today.toISOString().split('T')[0]; 
            today.setDate(today.getDate() - 7); 
            rawExportFilter.value.start = today.toISOString().split('T')[0]; 
            fpyFilter.value.start = today.toISOString().split('T')[0]; 
        });

        return {
            currentTab, loading, showWoModal, showMobileMore, data, toasts,
            getWoColor, fpyTargets, saveFpyTargets, isFpyBelowTarget, todayStr,
            dashboard, dashboardRecentProds, dashboardRecentOoc, refreshDashboard, dashDate, changeDashDate,
            report, defectForm, fetchDailyRecord, saveDailyInput, addDefect, deleteDefect, editingDefect, startEditDefect, saveEditDefect, importDefectCsv, historyList, loadRecordForEdit, deleteDailyRecord, loadHistory, onDateChange, cancelEdit, selectReportWo, backToWoList,
            woForm, isEditingWo, openWoModal, saveWorkOrder, deleteWorkOrder, markWoComplete, onWoNumberChange,
            statsFilter, statsResult, calculateStats, exportToExcel, trendTypeColor, chartMaxRate, chartMaxQty, trendY, trendYQty, trendLinePoints, selectedDefectType, typeLocBreakdown, typeLocTotal, selectedLocCode, openLocDetail, locWoBreakdown, locWoTotal,
            rawExportFilter, exportRawData,
            fpyForm, fpyHistory, fpyFilter, availableModelsForFpy, fetchFpyRecord, saveFpy, loadFpyHistory, deleteFpy, exportFpyData, importFpyFile, showFpyModal, showFpyExportModal, openFpyModal, selectedFpyId, fpyCalendarDays, fpyDayModal, openFpyDayDetail, fpyWoList, 
            oocForm, oocHistory, showOocModal, openOocModal, saveOoc, deleteOoc, selectedOocId, oocCalendarDays, availableModelsForOoc, 
            oocDayModal, openOocDayDetail, 
            activeWoNumbers, uniqueWoNumbers, reportWoList, availableModelsForSelectedWo,
            settingConfig, sortedList, addSettingItem, deleteSettingItem, editingId, editingValue, startEdit, saveEdit,
            sortedModels, sortedDefectTypes, sortedLocations, modelGroups, toggleModelGroup,
            orderSearch, processedWorkOrders, selectedWoId, selectWoForCalendar, 
            calendarYear, calendarMonth, calendarDays, calendarPadding, changeMonth, isToday, openDayDetail, dayDetailModal,
            // Equipment
            eqTab, eqData, feederList, nozzleLogs, nozzleStock,
            feederSort, setFeederSort, feederSortIcon, sortedFeederList,
            nozzleSort, setNozzleSort, nozzleSortIcon, sortedNozzleStock,
            showFeederModal, feederForm, openFeederModal, saveFeeder, deleteFeeder, feederSummary, toggleFeederStatus,
            selectedFeederId, selectedFeederObj, selectFeeder,
            showFeederLogModal, feederLogForm, openFeederLogModal, calHistory, saveCalibration, deleteCalibration,
            showNozzleLogModal, nozzleLogForm, openNozzleLogModal, saveNozzleLog, deleteNozzleLog,
            selectedNozzleModelId, selectedNozzleModelName, selectNozzleModel, filteredNozzleLogs,
            eqSettingForm, addFeederModel, addNozzleModel, deleteEqModel,
            renderParetoChart, initDashboardCharts
        };
    }
}).mount('#app');
