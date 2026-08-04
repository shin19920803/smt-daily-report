window.SMT = window.SMT || {};
SMT.report = function (ctx) {
        const { data, toast, loading, loadBaseData, activeWoNumbers, currentLine } = ctx;
        const report = ref({ date: new Date().toISOString().split('T')[0], wo_id: null, selectedWoNumber: null, inputQty: 0, currentId: null, logs: [], isEditing: false, originalDate: null });
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
            report.value.date = new Date().toISOString().split('T')[0];
            report.value.wo_id = null;
            report.value.selectedWoNumber = null;
        };
        const loadHistory = async () => { const { data: list } = await _supabase.from('daily_production').select('*, work_orders(wo_number, models(name)), defect_logs(quantity)').eq('line', currentLine.value).order('production_date', { ascending: false }).limit(50); if (list) historyList.value = list.map(item => ({ ...item, defect_count: item.defect_logs.reduce((s, d) => s + (d.quantity || 0), 0) })); };
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
                else { const { data: newProd, error } = await _supabase.from('daily_production').insert({ wo_id: report.value.wo_id, production_date: report.value.date, input_quantity: currentInput, line: currentLine.value }).select().single(); if (error) throw error; report.value.currentId = newProd.id; } 
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
                        const { error } = await _supabase.from('defect_locations').insert({ code, line: currentLine.value });
                        if (!error) addedLocs++;
                    }
                }
                for (let i = 1; i < rows.length; i++) {
                    const typeName = String(rows[i][0] || '').trim();
                    if (!typeName) continue;
                    if (!data.value.defectTypes.find(t => t.name === typeName)) {
                        const { error } = await _supabase.from('defect_types').insert({ name: typeName, line: currentLine.value });
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
        const exportRawData = async () => { loading.value = true; try { let query = _supabase.from('daily_production').select(`production_date, input_quantity, work_orders!inner (wo_number, models (name), model_id, id), defect_logs (quantity, defect_types (name), defect_locations (code))`).eq('line', currentLine.value); if (rawExportFilter.value.start) query = query.gte('production_date', rawExportFilter.value.start); if (rawExportFilter.value.end) query = query.lte('production_date', rawExportFilter.value.end); const { data: rows, error } = await query; if (error) throw error; let filtered = rows || []; if (rawExportFilter.value.modelId !== 'all') filtered = filtered.filter(r => r.work_orders.model_id == rawExportFilter.value.modelId); if (rawExportFilter.value.woId !== 'all') filtered = filtered.filter(r => r.work_orders.id == rawExportFilter.value.woId); const excelData = []; excelData.push(["日期", "工單號碼", "機種", "當日投入數", "不良現象", "不良位置", "不良數量"]); filtered.forEach(row => { const date = row.production_date; const wo = row.work_orders.wo_number; const model = row.work_orders.models.name; const input = row.input_quantity; if (row.defect_logs && row.defect_logs.length > 0) { row.defect_logs.forEach(log => { excelData.push([ date, wo, model, input, log.defect_types?.name || '', log.defect_locations?.code || '', log.quantity ]); }); } else { excelData.push([date, wo, model, input, "無不良", "", 0]); } }); const wb = XLSX.utils.book_new(); const ws = XLSX.utils.aoa_to_sheet(excelData); XLSX.utils.book_append_sheet(wb, ws, "Raw Data"); XLSX.writeFile(wb, `KOYA_${currentLine.value}_Raw_Data_${new Date().toISOString().slice(0,10)}.xlsx`); toast("Raw Data 已導出"); } catch (e) { toast("導出失敗: " + e.message, "error"); } finally { loading.value = false; } };
        // 報工用的工單清單：編輯模式下額外包含當前正在編輯的工單號碼
        const reportWoList = computed(() => {
            const list = new Set(activeWoNumbers.value);
            if (report.value.isEditing && report.value.selectedWoNumber) {
                list.add(report.value.selectedWoNumber);
            }
            return [...list];
        });
        return {
            report, defectForm, historyList, rawExportFilter,
            availableModelsForSelectedWo, reportWoList, onWoNumberChange, selectReportWo, backToWoList,
            onDateChange, cancelEdit, loadHistory, loadRecordForEdit, fetchDailyRecord,
            saveDailyInput, addDefect, deleteDefect, importDefectCsv,
            editingDefect, startEditDefect, saveEditDefect, deleteDailyRecord, exportRawData
        };
};
