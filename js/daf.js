window.SMT = window.SMT || {};

// DAF 檔案統計：依 Google Colab 版本的 C／E／G／I／J 欄位規則分析。
SMT.daf = function (ctx) {
    const { toast, loading, currentLine, currentTab } = ctx;
    const STORAGE_KEY = 'koya_daf_log_batches_v1';
    const REMOTE_TABLE = 'daf_log_batches';
    const REMOTE_MIGRATED_KEY = 'koya_daf_log_remote_migrated_v1';
    const COL_WORK_ORDER = 2;
    const COL_PRODUCT_CODE = 4;
    const COL_DATE = 6;
    const COL_DEFECT = 8;
    const COL_STATUS = 9;

    const MODEL_MAPPING = {
        'FP-D01607MB11': 'TK14-Goodix',
        'FP-D01809MB11': 'TK16-Goodix',
        'FP-D01630MB11': 'TK14-Synaptics',
        'FP-D01831MB11': 'TK16-Synaptics',
        'FP-D01608MB12': 'TK14-Goodix',
        'FP-D01631MB12': 'TK14-Synaptics',
        'FP-D01609MB11': 'TK13-Goodix',
        'FP-D01632MB11': 'TK13-Synaptics',
        'MS3633-T07': 'HP-C-Deck',
        'FP-D01614MB11': 'CY26-14-GOODIX',
        'FP-D01614MB12': 'CY26-14-GOODIX',
        'FP-D01634MB11': 'CY26-14-SYNAPTICS',
        'FP-D01634MB12': 'CY26-14-SYNAPTICS',
        'FP-D01810MB11': 'CY26-16-GOODIX',
        'FP-D01810MB12': 'CY26-16-GOODIX',
        'FP-D01820MB11': 'CY26-16-SYNAPTICS',
        'FP-D01820MB12': 'CY26-16-SYNAPTICS',
        'FP-D01304BE11': 'B24-GOODIX'
    };
    const MAPPING_ENTRIES = Object.entries(MODEL_MAPPING).sort((a, b) => b[0].length - a[0].length);

    const dafBatches = ref([]);
    const dafStatsFilter = ref({ start: '', end: '', model: 'all', workOrder: 'all' });
    const dafStatsResult = ref(null);
    const dafRemoteReady = ref(false);
    const dafRemoteError = ref('');
    const dafLastUpload = ref(null);
    const dafUploadSummary = ref({ files: 0, rows: 0, failed: [] });

    const cleanText = (value) => {
        if (value === null || value === undefined) return '';
        if (typeof value === 'number' && Number.isNaN(value)) return '';
        return String(value).replace(/\u00a0/g, ' ').replace(/[\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
    };
    const normalizeText = (value) => cleanText(value).toUpperCase();
    const safeFilename = (value, fallback = '未填寫') => {
        const text = cleanText(value).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^[._ ]+|[._ ]+$/g, '');
        return text || fallback;
    };
    const fmtDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const fmtDateTime = (date) => `${fmtDate(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
    const validDate = (date) => date instanceof Date && !Number.isNaN(date.getTime());

    const displayCell = (value) => value instanceof Date && validDate(value) ? fmtDateTime(value) : cleanText(value);
    const excelDate = (value) => {
        if (typeof value !== 'number' || !window.XLSX?.SSF?.parse_date_code) return null;
        const parts = XLSX.SSF.parse_date_code(value);
        if (!parts || !parts.y || !parts.m || !parts.d) return null;
        return new Date(parts.y, parts.m - 1, parts.d, parts.H || 0, parts.M || 0, parts.S || 0);
    };
    const parseDate = (value) => {
        if (value instanceof Date && validDate(value)) return fmtDate(value);
        const serialDate = excelDate(value);
        if (serialDate) return fmtDate(serialDate);
        let text = cleanText(value);
        if (!text) return '';
        const isPm = /下午|PM/i.test(text);
        const isAm = /上午|AM/i.test(text);
        text = text.replace(/上午|下午|AM|PM/ig, ' ').replace(/\s+/g, ' ').trim();
        const match = text.match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:\s+(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?)?/);
        if (match) {
            let hour = Number(match[4] || 0);
            const minute = Number(match[5] || 0);
            const second = Number(match[6] || 0);
            if (isPm && hour < 12) hour += 12;
            if (isAm && hour === 12) hour = 0;
            const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour, minute, second);
            if (validDate(date) && date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3])) return fmtDate(date);
        }
        const fallback = new Date(text);
        return validDate(fallback) ? fmtDate(fallback) : '';
    };
    const decodeBytes = (bytes) => {
        const attempts = ['utf-8', 'big5', 'windows-1252', 'gb18030'];
        for (const encoding of attempts) {
            try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); } catch (e) {}
        }
        return new TextDecoder('utf-8').decode(bytes);
    };
    const readFileRows = async (file) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!bytes.length) throw new Error('檔案是空白檔案');
        const extension = String(file.name || '').split('.').pop().toLowerCase();
        let workbook;
        if (['csv', 'txt'].includes(extension)) {
            workbook = XLSX.read(decodeBytes(bytes), { type: 'string', raw: true, cellDates: true });
        } else if (['xlsx', 'xls', 'xlsm'].includes(extension)) {
            workbook = XLSX.read(bytes, { type: 'array', raw: true, cellDates: true });
        } else {
            throw new Error('不支援的檔案格式，請使用 xlsx、xls、xlsm、csv 或 txt');
        }
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        if (!sheet) throw new Error('檔案沒有可讀取的工作表');
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' })
            .filter(row => row.some(cell => cleanText(cell) !== ''));
        const columnCount = Math.max(0, ...rows.map(row => row.length));
        if (columnCount < 10) throw new Error(`檔案目前只有 ${columnCount} 欄，至少需要 10 欄才能讀取 J 欄`);
        return { rows, columnCount };
    };

    const detectModel = (rows) => {
        const values = rows.map(row => normalizeText(row[COL_PRODUCT_CODE])).filter(Boolean);
        const matched = [];
        MAPPING_ENTRIES.forEach(([productCode, model]) => {
            if (values.some(value => value.includes(productCode)) && !matched.some(item => item.productCode === productCode)) matched.push({ productCode, model });
        });
        if (!matched.length) return { model: '未識別機種', productCode: '未識別產品代碼' };
        return {
            model: [...new Set(matched.map(item => item.model))].join('、'),
            productCode: [...new Set(matched.map(item => item.productCode))].join('、')
        };
    };
    const detectDateRange = (rows) => {
        const dates = rows.map(row => parseDate(row[COL_DATE])).filter(Boolean).sort();
        if (!dates.length) return { display: '未識別日期', start: '', end: '', dates: [] };
        const start = dates[0];
        const end = dates[dates.length - 1];
        return { display: start === end ? start : `${start}～${end}`, start, end, dates: [...new Set(dates)] };
    };
    const analyzeFile = async (file) => {
        const { rows, columnCount } = await readFileRows(file);
        const model = detectModel(rows);
        const dateRange = detectDateRange(rows);
        const statuses = rows.map(row => normalizeText(row[COL_STATUS]));
        const goodCount = statuses.filter(status => status === 'GOOD').length;
        const failCount = statuses.filter(status => status === 'FAIL').length;
        const inputCount = goodCount + failCount;
        const unknownStatuses = [...new Set(statuses.filter(status => status && !['GOOD', 'FAIL'].includes(status)))];
        const workOrders = [...new Set(rows.map(row => cleanText(row[COL_WORK_ORDER])).filter(Boolean))];
        const workOrderDisplay = workOrders.length ? workOrders.join('、') : '未識別工單';
        const workOrderFileName = workOrders.length === 1 ? workOrders[0] : workOrders.length ? `${workOrders[0]}等${workOrders.length}筆工單` : '未識別工單';
        const records = rows.map(row => {
            const status = normalizeText(row[COL_STATUS]);
            const parsedDate = parseDate(row[COL_DATE]);
            const isDefect = status === 'FAIL';
            return {
                workOrder: cleanText(row[COL_WORK_ORDER]) || '未識別工單',
                productCode: cleanText(row[COL_PRODUCT_CODE]),
                date: parsedDate,
                defect: isDefect ? (cleanText(row[COL_DEFECT]) || '未填寫不良原因') : '',
                status,
                model: model.model,
                inputIncluded: ['GOOD', 'FAIL'].includes(status),
                isDefect,
                raw: Array.from({ length: columnCount }, (_, index) => displayCell(row[index]))
            };
        });
        return {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            line: 'DAF',
            fileName: file.name,
            uploadedAt: new Date().toISOString(),
            modelName: model.model,
            productCode: model.productCode,
            workOrder: workOrderDisplay,
            workOrderFileName,
            reportDate: dateRange.display,
            dateStart: dateRange.start,
            dateEnd: dateRange.end,
            inputCount,
            goodCount,
            failCount,
            yieldRate: inputCount ? (goodCount / inputCount * 100).toFixed(2) : '0.00',
            defectRate: inputCount ? (failCount / inputCount * 100).toFixed(2) : '0.00',
            unknownStatusCount: unknownStatuses.reduce((count, status) => count + statuses.filter(item => item === status).length, 0),
            unknownStatusText: unknownStatuses.join('、') || '無',
            rowCount: rows.length,
            rawColumnCount: columnCount,
            records
        };
    };

    const readStorage = () => {
        try {
            const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) { return []; }
    };
    const persistStorage = () => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(dafBatches.value)); } catch (e) { toast('DAF 統計保存空間不足，可能無法保留資料', 'warning'); }
    };
    const hasMigrationFlag = () => {
        try { return localStorage.getItem(REMOTE_MIGRATED_KEY) === '1'; } catch (e) { return false; }
    };
    const setMigrationFlag = () => {
        try { localStorage.setItem(REMOTE_MIGRATED_KEY, '1'); } catch (e) {}
    };
    const toRemote = (batch) => ({
        id: batch.id, line: 'DAF', file_name: batch.fileName, uploaded_at: batch.uploadedAt,
        model_name: batch.modelName, product_code: batch.productCode, work_order: batch.workOrder,
        report_date: batch.reportDate, date_start: batch.dateStart || null, date_end: batch.dateEnd || null,
        input_count: batch.inputCount, good_count: batch.goodCount, fail_count: batch.failCount,
        yield_rate: Number(batch.yieldRate) || 0, defect_rate: Number(batch.defectRate) || 0,
        unknown_status_count: batch.unknownStatusCount, unknown_status_text: batch.unknownStatusText,
        row_count: batch.rowCount, raw_column_count: batch.rawColumnCount, records: batch.records
    });
    const fromRemote = (row) => ({
        id: row.id, line: row.line || 'DAF', fileName: row.file_name, uploadedAt: row.uploaded_at,
        modelName: row.model_name, productCode: row.product_code, workOrder: row.work_order,
        workOrderFileName: row.work_order, reportDate: row.report_date, dateStart: row.date_start || '', dateEnd: row.date_end || '',
        inputCount: row.input_count || 0, goodCount: row.good_count || 0, failCount: row.fail_count || 0,
        yieldRate: Number(row.yield_rate || 0).toFixed(2), defectRate: Number(row.defect_rate || 0).toFixed(2),
        unknownStatusCount: row.unknown_status_count || 0, unknownStatusText: row.unknown_status_text || '無',
        rowCount: row.row_count || 0, rawColumnCount: row.raw_column_count || 10, records: row.records || []
    });
    const saveRemote = async (batch) => {
        if (!dafRemoteReady.value) return false;
        const { error } = await _supabase.from(REMOTE_TABLE).upsert(toRemote(batch), { onConflict: 'id' });
        if (error) { dafRemoteError.value = error.message || 'DAF 共用資料庫寫入失敗'; return false; }
        return true;
    };
    const deleteRemote = async (id) => {
        if (!dafRemoteReady.value) return true;
        const { error } = await _supabase.from(REMOTE_TABLE).delete().eq('id', id).eq('line', 'DAF');
        if (error) { toast('DAF 共用資料庫刪除失敗：' + error.message, 'error'); return false; }
        return true;
    };
    const loadDafData = async () => {
        const localBatches = readStorage();
        if (currentLine.value !== 'DAF') { dafBatches.value = localBatches; return; }
        const { data: remoteRows, error } = await _supabase.from(REMOTE_TABLE).select('*').eq('line', 'DAF').order('uploaded_at', { ascending: false }).limit(200);
        if (error) {
            dafRemoteReady.value = false;
            dafRemoteError.value = error.code === 'PGRST205' ? '尚未建立 DAF 檔案統計共用資料表' : (error.message || 'DAF 共用資料庫讀取失敗');
            dafBatches.value = localBatches;
        } else {
            dafRemoteReady.value = true;
            dafRemoteError.value = '';
            let batches = (remoteRows || []).map(fromRemote);
            if (!hasMigrationFlag() && localBatches.length && batches.length === 0) {
                const { error: migrationError } = await _supabase.from(REMOTE_TABLE).upsert(localBatches.map(toRemote), { onConflict: 'id' });
                if (!migrationError) { batches = localBatches; setMigrationFlag(); }
            } else if (!hasMigrationFlag()) setMigrationFlag();
            dafBatches.value = batches.slice(0, 200);
            persistStorage();
        }
        dafLastUpload.value = dafBatches.value[0] || null;
        if (dafStatsResult.value) calculateDafStats(false);
    };

    const allRecords = () => dafBatches.value.flatMap(batch => (batch.records || []).map(record => ({ ...record, fileName: batch.fileName, batchId: batch.id })));
    const dafModelOptions = computed(() => [...new Set(allRecords().map(row => row.model).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant')));
    const dafWorkOrderOptions = computed(() => [...new Set(allRecords().map(row => row.workOrder).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant')));
    const filterRecords = () => allRecords().filter(row => {
        if (dafStatsFilter.value.start && (!row.date || row.date < dafStatsFilter.value.start)) return false;
        if (dafStatsFilter.value.end && (!row.date || row.date > dafStatsFilter.value.end)) return false;
        if (dafStatsFilter.value.model !== 'all' && row.model !== dafStatsFilter.value.model) return false;
        if (dafStatsFilter.value.workOrder !== 'all' && row.workOrder !== dafStatsFilter.value.workOrder) return false;
        return true;
    });
    const mapRate = (value, base) => base ? (value / base * 100).toFixed(2) : '0.00';
    const buildDafStats = () => {
        const rows = filterRecords();
        const inputRows = rows.filter(row => row.inputIncluded);
        const goodRows = inputRows.filter(row => row.status === 'GOOD');
        const failRows = inputRows.filter(row => row.status === 'FAIL');
        const input = inputRows.length;
        const defects = failRows.length;
        const defectMap = {};
        const modelMap = {};
        const workOrderMap = {};
        const dayMap = {};
        failRows.forEach(row => { defectMap[row.defect] = (defectMap[row.defect] || 0) + 1; });
        inputRows.forEach(row => {
            const model = row.model || '未識別機種';
            const workOrder = row.workOrder || '未識別工單';
            if (!modelMap[model]) modelMap[model] = { input: 0, good: 0, defects: 0 };
            if (!workOrderMap[workOrder]) workOrderMap[workOrder] = { models: new Set(), input: 0, good: 0, defects: 0 };
            modelMap[model].input++;
            workOrderMap[workOrder].input++;
            workOrderMap[workOrder].models.add(model);
            if (row.status === 'GOOD') { modelMap[model].good++; workOrderMap[workOrder].good++; }
            if (row.status === 'FAIL') { modelMap[model].defects++; workOrderMap[workOrder].defects++; }
            if (row.date) {
                if (!dayMap[row.date]) dayMap[row.date] = { date: row.date, input: 0, good: 0, defects: 0, byType: {} };
                dayMap[row.date].input++;
                if (row.status === 'GOOD') dayMap[row.date].good++;
                if (row.status === 'FAIL') { dayMap[row.date].defects++; dayMap[row.date].byType[row.defect] = (dayMap[row.date].byType[row.defect] || 0) + 1; }
            }
        });
        const byType = Object.entries(defectMap).map(([name, qty]) => ({ name, qty, inputRatio: mapRate(qty, input), ratio: mapRate(qty, defects) })).sort((a, b) => b.qty - a.qty);
        const byModel = Object.entries(modelMap).map(([name, value]) => ({ name, ...value, yieldRate: mapRate(value.good, value.input), defectRate: mapRate(value.defects, value.input), ratio: mapRate(value.defects, defects) })).sort((a, b) => b.defects - a.defects || b.input - a.input);
        const byWorkOrder = Object.entries(workOrderMap).map(([workOrder, value]) => ({ workOrder, model: [...value.models].join(' / '), input: value.input, good: value.good, defects: value.defects, yieldRate: mapRate(value.good, value.input), defectRate: mapRate(value.defects, value.input), ratio: mapRate(value.defects, defects) })).sort((a, b) => b.defects - a.defects || b.input - a.input);
        const daily = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date)).map(day => ({ ...day, total: day.input, yieldRate: mapRate(day.good, day.input), defectRate: mapRate(day.defects, day.input) }));
        const unknownStatuses = [...new Set(rows.map(row => row.status).filter(status => status && !['GOOD', 'FAIL'].includes(status)))];
        return {
            totalInput: input, totalGood: goodRows.length, totalDefects: defects,
            yieldRate: mapRate(goodRows.length, input), defectRate: mapRate(defects, input),
            unknownStatusCount: rows.filter(row => row.status && !['GOOD', 'FAIL'].includes(row.status)).length,
            unknownStatusText: unknownStatuses.join('、') || '無',
            totalDays: daily.length, totalRows: rows.length, sourceFiles: [...new Set(rows.map(row => row.fileName))],
            byType, byModel, byWorkOrder, daily, rows
        };
    };
    const calculateDafStats = (showToast = true) => {
        if (dafStatsFilter.value.start && dafStatsFilter.value.end && dafStatsFilter.value.start > dafStatsFilter.value.end) return toast('開始日期不能晚於結束日期', 'warning');
        dafStatsResult.value = buildDafStats();
        renderDafCharts();
        if (showToast) toast(`DAF 統計完成，共 ${dafStatsResult.value.sourceFiles.length} 個檔案`);
    };
    const uploadDafFiles = async (event) => {
        const files = [...(event.target.files || [])];
        if (!files.length) return;
        loading.value = true;
        const failed = [];
        let success = 0;
        let rows = 0;
        try {
            for (const file of files) {
                try {
                    const batch = await analyzeFile(file);
                    const remoteSaved = await saveRemote(batch);
                    dafBatches.value = [batch, ...dafBatches.value].slice(0, 200);
                    dafLastUpload.value = batch;
                    rows += batch.rowCount;
                    success++;
                    if (dafRemoteReady.value && !remoteSaved) failed.push(`${file.name}：共用資料庫寫入失敗`);
                } catch (error) { failed.push(`${file.name}：${error.message}`); }
            }
            persistStorage();
            dafUploadSummary.value = { files: success, rows, failed };
            if (dafStatsResult.value) dafStatsResult.value = buildDafStats();
            if (success) toast(`DAF 完成 ${success} 個檔案，共 ${rows.toLocaleString()} 列${failed.length ? '；有檔案失敗' : ''}`, failed.length ? 'warning' : 'success');
            else toast('DAF 檔案全部處理失敗', 'error');
        } finally {
            loading.value = false;
            event.target.value = '';
        }
    };
    const deleteDafBatch = async (id) => {
        const batch = dafBatches.value.find(item => item.id === id);
        if (!batch || !confirm(`確定刪除 ${batch.fileName} 的 DAF 統計？`)) return;
        if (!(await deleteRemote(id))) return;
        dafBatches.value = dafBatches.value.filter(item => item.id !== id);
        dafLastUpload.value = dafBatches.value[0] || null;
        persistStorage();
        if (dafStatsResult.value) dafStatsResult.value = buildDafStats();
        toast('DAF 檔案統計已刪除', 'info');
    };

    const exportDafStats = () => {
        if (!dafStatsResult.value) return toast('請先執行 DAF 統計', 'warning');
        const result = dafStatsResult.value;
        const range = `${dafStatsFilter.value.start || '不限'} ~ ${dafStatsFilter.value.end || '不限'}`;
        const summary = [
            ['統計區間', range], ['來源檔案數', result.sourceFiles.length], ['來源檔案', result.sourceFiles.join('、') || '無'],
            ['機種篩選', dafStatsFilter.value.model === 'all' ? '全部' : dafStatsFilter.value.model],
            ['工單篩選', dafStatsFilter.value.workOrder === 'all' ? '全部' : dafStatsFilter.value.workOrder],
            ['投入數', result.totalInput], ['良品數', result.totalGood], ['不良數', result.totalDefects],
            ['良率', result.yieldRate + '%'], ['不良率', result.defectRate + '%'], ['其他狀態數', result.unknownStatusCount], ['其他狀態內容', result.unknownStatusText]
        ];
        const defects = [['不良原因', '不良數量', '占投入比例', '占不良比例'], ...result.byType.map(row => [row.name, row.qty, row.inputRatio + '%', row.ratio + '%'])];
        const models = [['機種', '投入數', '良品數', '不良數', '良率', '不良率', '占總不良比例'], ...result.byModel.map(row => [row.name, row.input, row.good, row.defects, row.yieldRate + '%', row.defectRate + '%', row.ratio + '%'])];
        const workOrders = [['工單', '機種', '投入數', '良品數', '不良數', '良率', '不良率', '占總不良比例'], ...result.byWorkOrder.map(row => [row.workOrder, row.model, row.input, row.good, row.defects, row.yieldRate + '%', row.defectRate + '%', row.ratio + '%'])];
        const daily = [['日期', '投入數', '良品數', '不良數', '良率', '不良率'], ...result.daily.map(row => [row.date, row.input, row.good, row.defects, row.yieldRate + '%', row.defectRate + '%'])];
        const rawHeader = ['系統識別機種', '系統識別產品代碼', '系統識別狀態', '是否列入投入數', '是否為不良', '系統解析日期'];
        const rawRows = result.rows.map(row => [row.model, row.productCode, row.status, row.inputIncluded ? '是' : '否', row.isDefect ? '是' : '否', row.date, ...row.raw]);
        const rawColumns = Math.max(10, ...result.rows.map(row => row.raw.length));
        for (let index = 0; index < rawColumns; index++) rawHeader.push(`${String.fromCharCode(65 + index)}欄${[2, 4, 6, 8, 9].includes(index) ? ['工單', '產品代碼', '日期', '不良原因', '狀態'][[2, 4, 6, 8, 9].indexOf(index)] : ''}`);
        const wb = XLSX.utils.book_new();
        [['生產統計', summary], ['不良原因統計', defects], ['機種統計', models], ['工單統計', workOrders], ['每日統計', daily], ['原始資料', [rawHeader, ...rawRows]]].forEach(([name, data]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), name));
        const modelPart = dafStatsFilter.value.model === 'all' ? '全部機種' : safeFilename(dafStatsFilter.value.model);
        const woPart = dafStatsFilter.value.workOrder === 'all' ? '全部工單' : safeFilename(dafStatsFilter.value.workOrder);
        XLSX.writeFile(wb, `DAF_${modelPart}_${woPart}_${safeFilename(range, '不限日期')}_統計結果.xlsx`);
        toast('DAF 完整統計報表已導出');
    };

    let reasonChart = null;
    let trendChart = null;
    const disposeChart = (chart) => { if (chart) chart.dispose(); return null; };
    const renderDafCharts = () => {
        Vue.nextTick(() => {
            const result = dafStatsResult.value;
            const reasonEl = document.getElementById('dafReasonChart');
            const trendEl = document.getElementById('dafTrendChart');
            if (reasonEl && result?.byType?.length) {
                if (!reasonChart || reasonChart.getDom() !== reasonEl) { reasonChart = disposeChart(reasonChart); reasonChart = echarts.init(reasonEl); }
                const rows = result.byType.slice(0, 12).reverse();
                reasonChart.setOption({ grid: { top: 20, right: 40, bottom: 28, left: 120 }, tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: params => `${params[0].name}<br/><b>${params[0].value} 件</b>` }, xAxis: { type: 'value', axisLabel: { fontSize: 10 } }, yAxis: { type: 'category', data: rows.map(row => row.name), axisLabel: { fontSize: 10 } }, series: [{ type: 'bar', data: rows.map(row => row.qty), barMaxWidth: 20, itemStyle: { color: '#dc2626', borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', fontSize: 10 } }] });
            } else reasonChart = disposeChart(reasonChart);
            if (trendEl && result?.daily?.length) {
                if (!trendChart || trendChart.getDom() !== trendEl) { trendChart = disposeChart(trendChart); trendChart = echarts.init(trendEl); }
                trendChart.setOption({ grid: { top: 32, right: 24, bottom: 44, left: 48 }, tooltip: { trigger: 'axis' }, legend: { top: 0, right: 0, textStyle: { fontSize: 11 } }, xAxis: { type: 'category', data: result.daily.map(row => row.date.slice(5)), axisLabel: { fontSize: 10 } }, yAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%', fontSize: 10 } }, series: [{ name: '良率', type: 'line', smooth: true, data: result.daily.map(row => Number(row.yieldRate)), itemStyle: { color: '#16a34a' }, lineStyle: { color: '#16a34a', width: 2 } }, { name: '不良率', type: 'line', smooth: true, data: result.daily.map(row => Number(row.defectRate)), itemStyle: { color: '#dc2626' }, lineStyle: { color: '#dc2626', width: 2 } }] });
            } else trendChart = disposeChart(trendChart);
        });
    };
    dafBatches.value = readStorage();
    watch(() => dafStatsResult.value, () => { if (currentTab.value === 'stats' && currentLine.value === 'DAF') renderDafCharts(); });
    watch(currentTab, tab => { if ((tab === 'stats' || tab === 'report') && currentLine.value === 'DAF') renderDafCharts(); });
    watch(currentLine, line => { if (line === 'DAF') { dafStatsResult.value = null; loadDafData(); } });
    window.addEventListener('resize', () => { if (reasonChart) reasonChart.resize(); if (trendChart) trendChart.resize(); });

    return {
        dafBatches, dafStatsFilter, dafStatsResult, dafRemoteReady, dafRemoteError, dafLastUpload, dafUploadSummary,
        dafModelOptions, dafWorkOrderOptions, uploadDafFiles, loadDafData, calculateDafStats, exportDafStats, deleteDafBatch,
        renderDafCharts
    };
};
