window.SMT = window.SMT || {};
SMT.fpy = function (ctx) {
        const { data, toast, loading, activeWoNumbers, uniqueWoNumbers, calendarYear, calendarMonth, currentLine } = ctx;
        const fpyForm = ref({ id: null, date: window.koyaTodayDate(), selectedWoNumber: null, wo_id: null, spi: '', aoi: '', showAllWo: false });
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
        const getPreviousWorkday = () => {
            const today = window.koyaTodayDate();
            const day = new Date(`${today}T00:00:00`).getDay(); // 0=Sun, 1=Mon...6=Sat
            if (day === 1) return window.koyaShiftDate(today, -3); // Mon → Fri
            if (day === 0) return window.koyaShiftDate(today, -2); // Sun → Fri
            return window.koyaShiftDate(today, -1); // others → yesterday
        };

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
                else await _supabase.from('daily_fpy').insert({ ...payload, line: currentLine.value }); 
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
                        else await _supabase.from('daily_fpy').insert({ ...payload, line: currentLine.value });
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

        const loadFpyHistory = async () => { const { data: list } = await _supabase.from('daily_fpy').select('*, work_orders(wo_number, models(name))').eq('line', currentLine.value).order('production_date', {ascending:false}).limit(200); if (list) fpyHistory.value = list; };
        const deleteFpy = async (id) => { if(!confirm("確定刪除？")) return; await _supabase.from('daily_fpy').delete().eq('id', id); loadFpyHistory(); toast("已刪除", "info"); };
        const exportFpyData = async () => { loading.value = true; try { let query = _supabase.from('daily_fpy').select('*, work_orders(wo_number, models(name))').eq('line', currentLine.value); if (fpyFilter.value.start) query = query.gte('production_date', fpyFilter.value.start); if (fpyFilter.value.end) query = query.lte('production_date', fpyFilter.value.end); const { data: rows } = await query; rows.sort((a, b) => { const woA = a.work_orders.wo_number; const woB = b.work_orders.wo_number; if (woA.localeCompare(woB) !== 0) return woA.localeCompare(woB); return new Date(a.production_date) - new Date(b.production_date); }); const excelData = [["日期", "工單號碼", "機種", "SPI 直通率", "AOI 直通率"]]; rows.forEach(r => { excelData.push([r.production_date, r.work_orders.wo_number, r.work_orders.models.name, r.spi_rate ? `${r.spi_rate}%` : '0%', r.aoi_rate ? `${r.aoi_rate}%` : '0%']); }); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(excelData), "FPY Report"); XLSX.writeFile(wb, `KOYA_${currentLine.value}_FPY_Report_${window.koyaTodayDate()}.xlsx`); toast("FPY 報表已導出"); } catch(e) { toast("導出失敗", "error"); } finally { loading.value = false; } };
        return {
            fpyForm, fpyHistory, fpyFilter, showFpyModal, showFpyExportModal, selectedFpyId,
            fpyDayModal, isEditingFpy, availableModelsForFpy, fpyWoList, fpyCalendarDays,
            openFpyModal, openFpyDayDetail, fetchFpyRecord, saveFpy, importFpyFile,
            loadFpyHistory, deleteFpy, exportFpyData
        };
};
