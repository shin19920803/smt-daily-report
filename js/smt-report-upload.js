window.SMT = window.SMT || {};

SMT.parseSmtDailyReportData = rows => {
    const normalize = value => String(value ?? '').normalize('NFKC').replace(/[\s\uFEFF]/g, '').toUpperCase();
    const parseQty = (value, sourceRow, label) => {
        const raw = String(value ?? '').trim().replace(/,/g, '');
        if (!raw) return 0;
        if (!/^\d+$/.test(raw)) throw new Error(`Excel 第 ${sourceRow} 列 ${label} 必須是非負整數`);
        const number = Number(raw);
        if (!Number.isSafeInteger(number)) throw new Error(`Excel 第 ${sourceRow} 列 ${label} 超出可處理範圍`);
        return number;
    };
    const resolveSide = value => {
        const process = normalize(value);
        if (['背面AOI', 'BACKAOI', 'BACKSIDEAOI'].includes(process)) return 'BOT';
        if (['正面AOI', 'FRONTAOI', 'FRONTSIDEAOI'].includes(process)) return 'TOP';
        return null;
    };
    if (!Array.isArray(rows) || rows.length < 2) throw new Error('Data 分頁沒有生產資料');
    const headers = rows[0] || [];
    if (normalize(headers[0]) !== '製程' || normalize(headers[1]) !== '工單' ||
        normalize(headers[4]) !== '良品數量' || normalize(headers[5]) !== '不良品數') {
        throw new Error('Data 分頁欄位不符：A/B/E/F 欄需為製程、工單、良品數量、不良品數');
    }
    const parsed = [];
    let excluded = 0;
    for (let index = 1; index < rows.length; index++) {
        const source = rows[index] || [];
        if (!source.some(value => value !== null && String(value).trim() !== '')) continue;
        const side = resolveSide(source[0]);
        if (!side) { excluded++; continue; }
        const woNumber = String(source[1] ?? '').trim();
        if (!woNumber) throw new Error(`Excel 第 ${index + 1} 列 AOI 資料沒有工單號碼`);
        const goodQty = parseQty(source[4], index + 1, 'E 欄良品數量');
        const ngQty = parseQty(source[5], index + 1, 'F 欄不良品數');
        const inputQty = goodQty + ngQty;
        if (!Number.isSafeInteger(inputQty) || inputQty <= 0) throw new Error(`Excel 第 ${index + 1} 列投入數量必須大於 0`);
        parsed.push({ source_row: index + 1, wo_number: woNumber, side,
            good_qty: goodQty, ng_qty: ngQty, input_qty: inputQty, defects: [], defect_file_name: null,
            _defect_file_hash: null });
    }
    if (!parsed.length) throw new Error('Data 分頁沒有可匯入的正面／背面 AOI 資料');
    return { rows: parsed, excluded };
};

SMT.reportUpload = function (ctx) {
    const { data, currentLine, currentTab, toast, loading } = ctx;
    const smtUploadDate = ref(window.getTaiwanDate());
    const smtUploadDraft = ref(null);
    const smtUploadHistory = ref([]);
    const smtUploadError = ref('');
    const smtUploadValidationOpen = ref(false);
    const smtUploadBusy = ref(false);

    const inferDateFromFilename = fileName => {
        const today = window.getTaiwanDate();
        const full = String(fileName).match(/(?:^|\D)(20\d{6})(?:\D|$)/);
        if (full) {
            const value = full[1];
            const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`);
            if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10).replace(/-/g, '') === value) return date.toISOString().slice(0, 10);
        }
        const short = String(fileName).match(/^(\d{2})(\d{2})(?:[-_\s.]|$)/);
        if (!short) return today;
        let year = Number(today.slice(0, 4));
        let date = `${year}-${short[1]}-${short[2]}`;
        const valid = new Date(`${date}T00:00:00Z`);
        if (Number.isNaN(valid.getTime()) || valid.toISOString().slice(0, 10) !== date) return today;
        if (date > today) { year--; date = `${year}-${short[1]}-${short[2]}`; }
        return date;
    };
    const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
        .map(value => value.toString(16).padStart(2, '0')).join('');

    const fetchWorkOrders = async rows => {
        const numbers = [...new Set(rows.map(row => row.wo_number))];
        const { data: matches, error } = await _supabase.from('work_orders')
            .select('id, wo_number, target_quantity, model_id, line, models!inner(id, name, line)')
            .eq('line', 'SMT').eq('models.line', 'SMT').in('wo_number', numbers);
        if (error) throw new Error(`查詢工單失敗：${error.message}`);
        return matches || [];
    };
    const resolveRows = async draft => {
        const issues = [];
        const orders = await fetchWorkOrders(draft.rows);
        const resolved = draft.rows.map(row => {
            const candidates = orders.filter(order => String(order.wo_number) === row.wo_number &&
                String(order.models?.name || '').match(/[_-](TOP|BOT)$/i)?.[1]?.toUpperCase() === row.side);
            if (candidates.length !== 1) {
                issues.push(`Excel 第 ${row.source_row} 列｜工單 ${row.wo_number}｜${row.side}：${candidates.length ? '機種對應不唯一' : '工單或對應面別機種不存在，請先建立工單與機種'}`);
                return row;
            }
            const order = candidates[0];
            if (!Number.isSafeInteger(Number(order.target_quantity)) || Number(order.target_quantity) <= 0)
                issues.push(`Excel 第 ${row.source_row} 列｜工單 ${row.wo_number}：未設定有效預計數量`);
            return { ...row, wo_id: String(order.id), model_name: order.models.name,
                target_quantity: Number(order.target_quantity), current_input: 0, has_same_day_record: false };
        });

        const ids = [...new Set(resolved.filter(row => row.wo_id).map(row => row.wo_id))];
        const plannedInputs = new Map();
        resolved.forEach(row => {
            if (row.wo_id) plannedInputs.set(row.wo_id, (plannedInputs.get(row.wo_id) || 0) + row.input_qty);
        });
        if (ids.length) {
            const { data: productions, error } = await _supabase.from('daily_production')
                .select('wo_id, production_date, input_quantity').eq('line', 'SMT').in('wo_id', ids);
            if (error) throw new Error(`查詢既有報工失敗：${error.message}`);
            const totals = new Map();
            const sameDate = new Set();
            const capacityChecked = new Set();
            for (const production of productions || []) {
                const id = String(production.wo_id);
                totals.set(id, (totals.get(id) || 0) + Number(production.input_quantity || 0));
                if (production.production_date === draft.production_date) sameDate.add(id);
            }
            for (const row of resolved) {
                if (!row.wo_id) continue;
                row.current_input = totals.get(row.wo_id) || 0;
                row.has_same_day_record = sameDate.has(row.wo_id);
                if (row.has_same_day_record) issues.push(`Excel 第 ${row.source_row} 列｜工單 ${row.wo_number}｜${row.model_name}：${draft.production_date} 已有報工，避免重複寫入，請先檢查既有紀錄`);
                if (!capacityChecked.has(row.wo_id)) {
                    capacityChecked.add(row.wo_id);
                    const fileInput = plannedInputs.get(row.wo_id) || 0;
                    if (row.current_input + fileInput > row.target_quantity)
                        issues.push(`Excel 第 ${row.source_row} 列｜工單 ${row.wo_number}｜${row.model_name}：本檔投入合計 ${fileInput} 後會超過預計數量（目前 ${row.current_input}，預計 ${row.target_quantity}）`);
                }
            }
        }
        draft.rows = resolved;
        draft.issues = issues;
        smtUploadDraft.value = draft;
        smtUploadValidationOpen.value = issues.length > 0;
        return draft;
    };
    const loadSmtUploadHistory = async () => {
        if (currentLine.value !== 'SMT') return;
        try {
            const { data: batches, error } = await _supabase.rpc('smt_list_report_uploads', { p_limit: 100, p_offset: 0 });
            if (error) throw error;
            smtUploadHistory.value = batches || [];
            smtUploadError.value = '';
        } catch (error) {
            smtUploadError.value = `讀取上傳清單失敗：${error.message}`;
        }
    };
    const parseSmtReportFile = async event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        smtUploadError.value = '';
        if (!file) return;
        if (!/\.xlsx?$/i.test(file.name)) {
            smtUploadError.value = '每日報工只接受 Excel 檔案（.xlsx／.xls）';
            return toast(smtUploadError.value, 'error');
        }
        loading.value = true;
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const book = XLSX.read(bytes, { type: 'array', cellDates: false });
            const sheet = book.Sheets.Data;
            if (!sheet) throw new Error('找不到名稱為 Data 的分頁，未寫入任何資料');
            const parsed = SMT.parseSmtDailyReportData(XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' }));
            const productionDate = inferDateFromFilename(file.name);
            smtUploadDate.value = productionDate;
            const draft = { file_name: file.name, bytes, rows: parsed.rows, excluded: parsed.excluded,
                production_date: productionDate, issues: [] };
            await resolveRows(draft);
        } catch (error) {
            smtUploadDraft.value = null;
            smtUploadError.value = error.message || 'Excel 解析失敗';
            toast(smtUploadError.value, 'error');
        } finally { loading.value = false; }
    };
    const parseSmtDefectFile = async (event, target) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file || !smtUploadDraft.value) return;
        loading.value = true;
        try {
            SMT.validateSmtReportFilename(file.name, target.wo_number);
            const bytes = new Uint8Array(await file.arrayBuffer());
            const book = XLSX.read(bytes, { type: 'array' });
            const sheet = book.Sheets[book.SheetNames[0]];
            if (!sheet) throw new Error('不良 CSV 沒有工作表');
            const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
            SMT.validateSmtImport(matrix, 'defects');
            const locations = matrix[0].slice(1).map(value => String(value ?? '').trim());
            const types = new Map(data.value.defectTypes.map(item => [item.name, item]));
            const locs = new Map(data.value.defectLocations.map(item => [item.code, item]));
            const defects = [];
            for (let i = 1; i < matrix.length; i++) {
                const typeName = String(matrix[i]?.[0] ?? '').trim();
                if (!typeName) continue;
                const type = types.get(typeName);
                if (!type || type.line !== 'SMT') throw new Error(`不良項目「${typeName}」尚未建立於 SMT 設定`);
                for (let j = 1; j < (matrix[i] || []).length; j++) {
                    const rawQty = String(matrix[i][j] ?? '').trim().replace(/,/g, '');
                    if (!rawQty) continue;
                    if (!/^\d+$/.test(rawQty) || !Number.isSafeInteger(Number(rawQty))) throw new Error(`CSV 第 ${i + 1} 列數量不合法`);
                    const quantity = Number(rawQty);
                    if (!quantity) continue;
                    const locationCode = locations[j - 1];
                    const location = locs.get(locationCode);
                    if (!location || location.line !== 'SMT') throw new Error(`位置代碼「${locationCode}」尚未建立於 SMT 設定`);
                    defects.push({ type_id: String(type.id), type_name: type.name,
                        location_id: String(location.id), location_code: location.code, quantity });
                }
            }
            const sum = defects.reduce((total, item) => total + item.quantity, 0);
            if (sum !== target.ng_qty) throw new Error(`不良明細合計 ${sum} 與此列 F 欄 ${target.ng_qty} 不符`);
            const fileHash = await digest(bytes);
            const rows = smtUploadDraft.value.rows.map(row => row.source_row === target.source_row
                ? { ...row, defects, defect_file_name: file.name, _defect_file_hash: fileHash } : row);
            smtUploadDraft.value = { ...smtUploadDraft.value, rows };
            toast(`第 ${target.source_row} 列不良明細已驗證`);
        } catch (error) {
            smtUploadError.value = error.message || '不良明細解析失敗';
            toast(smtUploadError.value, 'error');
        } finally { loading.value = false; }
    };
    const recheckSmtUpload = async () => {
        if (!smtUploadDraft.value) return;
        loading.value = true;
        try {
            smtUploadDraft.value.production_date = smtUploadDate.value;
            await resolveRows(smtUploadDraft.value);
        } catch (error) {
            smtUploadError.value = `工單檢查失敗：${error.message}`;
            toast(smtUploadError.value, 'error');
        } finally { loading.value = false; }
    };
    const publishSmtReportUpload = async () => {
        const draft = smtUploadDraft.value;
        if (currentLine.value !== 'SMT' || !draft || draft.issues?.length) return toast('請先完成工單／機種檢查', 'error');
        if (draft.production_date !== smtUploadDate.value) return toast('日期已變更，請重新檢查工單', 'warning');
        const missing = draft.rows.filter(row => row.ng_qty > 0 && !row.defect_file_name);
        if (missing.length) return toast(`尚有 ${missing.length} 筆不良資料未上傳明細`, 'warning');
        loading.value = true;
        smtUploadBusy.value = true;
        try {
            const excelHash = await digest(draft.bytes);
            const canonical = JSON.stringify({ date: smtUploadDate.value, excelHash,
                defectHashes: draft.rows.map(row => [row.source_row, row._defect_file_hash || null]) });
            const hash = await digest(new TextEncoder().encode(canonical));
            const rows = draft.rows.map(({ source_row, wo_id, wo_number, side, model_name, good_qty, ng_qty,
                input_qty, defects, defect_file_name }) => ({ source_row, wo_id, wo_number, side, model_name,
                good_qty, ng_qty, input_qty, defect_file_name, defects: (defects || []).map(({ type_id,
                    type_name, location_id, location_code, quantity }) => ({ type_id, type_name, location_id, location_code, quantity })) }));
            const { data: result, error } = await _supabase.rpc('smt_publish_report_upload', {
                p_file_name: draft.file_name, p_content_hash: hash,
                p_production_date: smtUploadDate.value, p_rows: rows
            });
            if (error) throw error;
            if (!result?.ok) throw new Error('資料庫未確認發佈成功');
            smtUploadDraft.value = null;
            smtUploadValidationOpen.value = false;
            await window.invalidateDataCache?.();
            await Promise.all([loadSmtUploadHistory(), ctx.loadHistory(), ctx.loadBaseData()]);
            await ctx.refreshDashboard?.({ force: true });
            toast(result.duplicate ? '相同檔案已上傳，未重複計入' : `上傳完成，共 ${result.row_count} 筆獨立報工`);
        } catch (error) {
            smtUploadError.value = `上傳失敗：${error.message}`;
            toast(smtUploadError.value, 'error');
        } finally { loading.value = false; smtUploadBusy.value = false; }
    };
    const deleteSmtUpload = async batch => {
        const count = batch.row_manifest?.length || 0;
        if (!confirm(`刪除此檔案上傳的 ${count} 筆報工及其不良明細？若資料已修改，系統會阻擋刪除。`)) return;
        loading.value = true;
        try {
            const { error } = await _supabase.rpc('smt_delete_report_upload', { p_batch_id: batch.id });
            if (error) throw error;
            await window.invalidateDataCache?.();
            await Promise.all([loadSmtUploadHistory(), ctx.loadHistory(), ctx.loadBaseData()]);
            await ctx.refreshDashboard?.({ force: true });
            toast('已刪除上傳資料');
        } catch (error) { toast(`刪除失敗：${error.message}`, 'error'); }
        finally { loading.value = false; }
    };
    const openSmtImportedRecord = async (batch, row) => {
        if (!row?.production_id || !row?.wo_id) return toast('這筆上傳明細缺少報工連結', 'error');
        const order = data.value.workOrders.find(item => String(item.id) === String(row.wo_id));
        if (!order) { toast('找不到對應工單，請重新整理後再試', 'error'); return; }
        currentTab.value = 'report';
        await ctx.loadRecordForEdit({ id: row.production_id, wo_id: row.wo_id,
            production_date: batch.production_date,
            work_orders: { wo_number: row.wo_number } });
    };
    return { smtUploadDate, smtUploadDraft, smtUploadHistory, smtUploadError, smtUploadValidationOpen,
        smtUploadBusy, parseSmtReportFile, parseSmtDefectFile, publishSmtReportUpload,
        loadSmtUploadHistory, deleteSmtUpload, openSmtImportedRecord, recheckSmtUpload };
};
