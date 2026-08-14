window.SMT = window.SMT || {};
SMT.equipment = function (ctx) {
        const { toast, loading, currentLine } = ctx;
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
        const feederLogForm = ref({ calibration_date: window.koyaTodayDate(), next_calibration_date: '', result: 'pass', notes: '', log_type: 'calibration' });
        const nozzleLogForm = ref({ nozzle_model_id: null, change_type: 'in', quantity: 1, log_date: window.koyaTodayDate(), notes: '' });
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
            feederLogForm.value = { calibration_date: window.koyaTodayDate(), next_calibration_date: '', result: type === 'calibration' ? 'pass' : '', notes: '', log_type: type };
            showFeederLogModal.value = true;
        };

        const loadEqData = async () => {
            const [fm, nm] = await Promise.all([
                _supabase.from('feeder_models').select('*').eq('line', currentLine.value).order('brand'),
                _supabase.from('nozzle_models').select('*').eq('line', currentLine.value).order('brand')
            ]);
            eqData.value.feederModels = fm.data || [];
            eqData.value.nozzleModels = nm.data || [];
        };

        const loadFeeders = async () => {
            const { data: list, error } = await _supabase.from('feeders').select('*, feeder_models(brand, model)').eq('line', currentLine.value).order('slot_number');
            if (error) { 
                console.error('loadFeeders join error, trying without join:', error);
                // Fallback: load without join, manually map model info
                const { data: rawList } = await _supabase.from('feeders').select('*').eq('line', currentLine.value).order('slot_number');
                const mapped = (rawList || []).map(f => {
                    const fm = eqData.value.feederModels.find(m => m.id === f.feeder_model_id);
                    return { ...f, feeder_models: fm || { brand: '-', model: '-' } };
                });
                feederList.value = mapped.map(f => ({ ...f, _calStatus: 'none', _lastCal: null }));
                return;
            }
            const todayDate = window.koyaTodayDate();
            const soonStr = window.koyaShiftDate(todayDate, 30);
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
            const { data: list, error } = await _supabase.from('nozzle_inventory_logs').select('*, nozzle_models(brand, model)').eq('line', currentLine.value).order('log_date', { ascending: false }).limit(200);
            if (error) {
                console.error('loadNozzleLogs join error, trying without join:', error);
                const { data: rawList } = await _supabase.from('nozzle_inventory_logs').select('*').eq('line', currentLine.value).order('log_date', { ascending: false }).limit(200);
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
                await _supabase.from('feeder_calibrations').insert({ feeder_id: selectedFeederId.value, calibration_date: window.koyaTodayDate(), log_type: logType, result: newStatus === 'in_use' ? '領用上機' : '歸還入庫', notes: null });
                await loadFeeders();
                // 刷新紀錄
                const { data: list } = await _supabase.from('feeder_calibrations').select('*').eq('feeder_id', selectedFeederId.value).order('calibration_date', { ascending: false });
                calHistory.value = list || [];
                toast(newStatus === 'in_use' ? '已標記為使用中' : '已歸還入庫');
            } catch(e) { toast('操作失敗: ' + e.message, 'error'); } finally { loading.value = false; }
        };

        const openFeederModal = (f = null) => {
            if (f) feederForm.value = { id: f.id, feeder_model_id: f.feeder_model_id, slot_number: f.slot_number, mes_code_left: f.mes_code_left || '', mes_code_right: f.mes_code_right || '', purchase_date: f.purchase_date || '', status: f.status || 'active' };
            else feederForm.value = { id: null, feeder_model_id: null, slot_number: '', mes_code_left: '', mes_code_right: '', purchase_date: window.koyaTodayDate(), status: 'active' };
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
                else ({ error } = await _supabase.from('feeders').insert({ ...payload, line: currentLine.value }));
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

        const openNozzleLogModal = (type = 'in') => { nozzleLogForm.value = { nozzle_model_id: null, change_type: type, quantity: 1, log_date: window.koyaTodayDate(), notes: '' }; showNozzleLogModal.value = true; };

        const saveNozzleLog = async () => {
            if (!nozzleLogForm.value.nozzle_model_id || !nozzleLogForm.value.quantity) return toast('請填寫完整', 'warning');
            loading.value = true;
            try {
                const { error } = await _supabase.from('nozzle_inventory_logs').insert({ nozzle_model_id: nozzleLogForm.value.nozzle_model_id, change_type: nozzleLogForm.value.change_type, quantity: nozzleLogForm.value.quantity, log_date: nozzleLogForm.value.log_date, notes: nozzleLogForm.value.notes || null, line: currentLine.value });
                if (error) throw error;
                showNozzleLogModal.value = false; await loadNozzleLogs(); toast('紀錄已新增');
            } catch(e) { toast('失敗: ' + e.message, 'error'); } finally { loading.value = false; }
        };

        const deleteNozzleLog = async (id) => { if (!confirm('確定刪除？')) return; await _supabase.from('nozzle_inventory_logs').delete().eq('id', id); await loadNozzleLogs(); toast('已刪除', 'info'); };

        // Equipment settings helpers
        const addFeederModel = async () => { const b = eqSettingForm.value.feederBrand.trim(); const m = eqSettingForm.value.feederModel.trim(); if (!b || !m) return toast('請填廠牌與型號', 'warning'); const { error } = await _supabase.from('feeder_models').insert({ brand: b, model: m, line: currentLine.value }); if (error) return toast('新增失敗: ' + error.message + ' (請確認 RLS 已關閉或已設定 Policy)', 'error'); eqSettingForm.value.feederBrand = ''; eqSettingForm.value.feederModel = ''; await loadEqData(); toast('已新增'); };
        const addNozzleModel = async () => { const b = eqSettingForm.value.nozzleBrand.trim(); const m = eqSettingForm.value.nozzleModel.trim(); if (!b || !m) return toast('請填廠牌與型號', 'warning'); const { error } = await _supabase.from('nozzle_models').insert({ brand: b, model: m, line: currentLine.value }); if (error) return toast('新增失敗: ' + error.message + ' (請確認 RLS 已關閉或已設定 Policy)', 'error'); eqSettingForm.value.nozzleBrand = ''; eqSettingForm.value.nozzleModel = ''; await loadEqData(); toast('已新增'); };
        const deleteEqModel = async (table, id) => { if (!confirm('確定刪除？')) return; const { error } = await _supabase.from(table).delete().eq('id', id); if (error) return toast('刪除失敗: ' + error.message, 'error'); await loadEqData(); toast('已刪除', 'info'); };
        return {
            eqTab, eqData, feederList, nozzleLogs, nozzleStock,
            feederSort, setFeederSort, feederSortIcon, sortedFeederList,
            nozzleSort, setNozzleSort, nozzleSortIcon, sortedNozzleStock,
            showFeederModal, feederForm, openFeederModal, saveFeeder, deleteFeeder, feederSummary, toggleFeederStatus,
            selectedFeederId, selectedFeederObj, selectFeeder,
            showFeederLogModal, feederLogForm, openFeederLogModal, calHistory, saveCalibration, deleteCalibration,
            showNozzleLogModal, nozzleLogForm, openNozzleLogModal, saveNozzleLog, deleteNozzleLog,
            selectedNozzleModelId, selectedNozzleModelName, selectNozzleModel, filteredNozzleLogs,
            eqSettingForm, addFeederModel, addNozzleModel, deleteEqModel,
            loadEqData, loadFeeders, loadNozzleLogs
        };
};
