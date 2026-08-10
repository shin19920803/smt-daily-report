window.SMT = window.SMT || {};

// DAF 檔案統計：依 Google Colab 版本的 C／E／F／G／I／J 欄位規則分析。
SMT.daf = function (ctx) {
    const { toast, loading, currentLine, currentTab, data, loadBaseData } = ctx;
    const STORAGE_KEY = 'koya_daf_log_batches_v1';
    const REMOTE_TABLE = 'daf_log_batches';
    const REMOTE_MIGRATED_KEY = 'koya_daf_log_remote_migrated_v1';
    const MODEL_MAPPING_STORAGE_KEY = 'koya_daf_model_mappings_v1';
    const COL_WORK_ORDER = 2;
    const COL_PRODUCT_CODE = 4;
    const COL_DEDUP_KEY = 5;
    const COL_DATE = 6;
    const COL_DEFECT = 8;
    const COL_STATUS = 9;
    const isDafLikeLine = () => ['DAF', 'FT1', 'FT2'].includes(currentLine.value);
    const currentDafLine = () => isDafLikeLine() ? currentLine.value : 'DAF';
    const currentDafStorageKey = () => currentDafLine() === 'DAF' ? STORAGE_KEY : `koya_${currentDafLine().toLowerCase()}_log_batches_v1`;
    const currentDafMigrationKey = () => currentDafLine() === 'DAF' ? REMOTE_MIGRATED_KEY : `koya_${currentDafLine().toLowerCase()}_log_remote_migrated_v1`;
    const currentDafLabel = () => currentDafLine();
    const defaultDafDefect = () => currentLine.value === 'FT2' ? '偵測失效' : '未填寫不良原因';

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
    const dafUploadSummary = ref({ files: 0, rows: 0, duplicates: 0, failed: [] });
    const dafModelMappings = ref({});
    const dafUnknownModelModal = ref({ show: false, fileName: '', items: [], currentIndex: 0, selectedModel: '', newModel: '' });
    const pendingDafUpload = ref(null);
    const dafDefectDetail = ref({ show: false, name: '', qty: 0, byModel: [], byWorkOrder: [] });
    const dafModelDetail = ref({ show: false, name: '', input: 0, good: 0, defects: 0, yieldRate: '0.00', byType: [] });
    const dafWorkOrderDetail = ref({ show: false, workOrder: '', model: '', input: 0, good: 0, defects: 0, yieldRate: '0.00', byType: [], byModel: [] });
    const dafOutputDetail = ref({ show: false, title: '', subtitle: '', result: null });
    const dafQuickMode = ref(null);
    const dafQuickOffset = ref(0);
    let applyingDafQuick = false;

    const cleanText = (value) => {
        if (value === null || value === undefined) return '';
        if (typeof value === 'number' && Number.isNaN(value)) return '';
        return String(value).replace(/\u00a0/g, ' ').replace(/[\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
    };
    const normalizeText = (value) => cleanText(value).toUpperCase();
    const normalizeModelName = value => normalizeText(value) || '未識別機種';
    const readModelMappings = () => {
        try {
            const parsed = JSON.parse(localStorage.getItem(MODEL_MAPPING_STORAGE_KEY) || '{}');
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? Object.fromEntries(Object.entries(parsed).map(([code, model]) => [normalizeText(code), normalizeModelName(model)]))
                : {};
        } catch (e) { return {}; }
    };
    const persistModelMappings = () => {
        try {
            const normalized = Object.fromEntries(Object.entries(dafModelMappings.value).map(([code, model]) => [normalizeText(code), normalizeModelName(model)]));
            dafModelMappings.value = normalized;
            localStorage.setItem(MODEL_MAPPING_STORAGE_KEY, JSON.stringify(normalized));
        } catch (e) {}
    };
    const learnModelMappings = (batches) => {
        let changed = false;
        (batches || []).forEach(batch => (batch.records || []).forEach(record => {
            const code = normalizeText(record.productCode);
            const model = normalizeModelName(record.model);
            if (code && model && model !== '未識別機種' && !dafModelMappings.value[code]) {
                dafModelMappings.value[code] = model;
                changed = true;
            }
        }));
        if (changed) persistModelMappings();
    };
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
    const parseDateTime = (value) => {
        if (value instanceof Date && validDate(value)) return value;
        const serialDate = excelDate(value);
        if (serialDate) return serialDate;
        let text = cleanText(value);
        if (!text) return null;
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
            if (validDate(date) && date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3])) return date;
        }
        const fallback = new Date(text);
        return validDate(fallback) ? fallback : null;
    };
    const parseDate = value => { const parsed = parseDateTime(value); return parsed ? fmtDate(parsed) : ''; };
    const normalizeDafRecord = record => {
        const raw = Array.isArray(record.raw) ? record.raw : [];
        const hasStoredTime = record.dedupTime !== null && record.dedupTime !== undefined && record.dedupTime !== '';
        const parsedTime = hasStoredTime && Number.isFinite(Number(record.dedupTime))
            ? Number(record.dedupTime)
            : (parseDateTime(raw[COL_DATE])?.getTime() || null);
        return {
            ...record,
            model: normalizeModelName(record.model),
            machine: '',
            dedupKey: normalizeText(record.dedupKey || raw[COL_DEDUP_KEY] || ''),
            dedupTime: parsedTime
        };
    };
    const normalizeBatchModels = batch => {
        const records = (batch.records || []).map(normalizeDafRecord);
        return {
            ...batch,
            machine: '',
            modelName: normalizeModelName(batch.modelName),
            records
        };
    };
    const deduplicateRows = rows => {
        const grouped = new Map();
        const passthrough = [];
        rows.forEach((row, index) => {
            const key = normalizeText(row[COL_DEDUP_KEY]);
            if (!key) {
                passthrough.push({ row, index });
                return;
            }
            const parsedTime = parseDateTime(row[COL_DATE]);
            const timestamp = parsedTime ? parsedTime.getTime() : Number.MAX_SAFE_INTEGER;
            const previous = grouped.get(key);
            if (!previous || timestamp < previous.timestamp) grouped.set(key, { row, index, timestamp });
        });
        return [...passthrough, ...grouped.values()]
            .sort((a, b) => a.index - b.index)
            .map(item => item.row);
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
        const rawValues = [...new Map(rows.map(row => {
            const raw = cleanText(row[COL_PRODUCT_CODE]);
            return [normalizeText(raw), raw];
        }).filter(([key, raw]) => key && !/產品|料號|product\s*code|part\s*number|型號|model/i.test(raw))).values()];
        const dynamicEntries = Object.entries(dafModelMappings.value).sort((a, b) => b[0].length - a[0].length);
        const matched = [];
        const unknownProductCodes = [];
        rawValues.forEach(raw => {
            const value = normalizeText(raw);
            const staticMatch = MAPPING_ENTRIES.find(([productCode]) => value.includes(productCode));
            const dynamicMatch = dynamicEntries.find(([productCode]) => value.includes(productCode));
            const match = staticMatch || dynamicMatch;
            if (match && !matched.some(item => item.productCode === match[0])) matched.push({ productCode: match[0], model: normalizeModelName(match[1]) });
            if (!match) unknownProductCodes.push(raw);
        });
        const unknownWorkOrders = new Map(unknownProductCodes.map(code => [normalizeText(code), new Set()]));
        rows.forEach(row => {
            const code = normalizeText(row[COL_PRODUCT_CODE]);
            const workOrder = cleanText(row[COL_WORK_ORDER]);
            if (unknownWorkOrders.has(code) && workOrder) unknownWorkOrders.get(code).add(workOrder);
        });
        const unknownProductDetails = unknownProductCodes.map(code => ({
            code,
            workOrders: [...(unknownWorkOrders.get(normalizeText(code)) || [])]
        }));
        const models = [...new Set(matched.map(item => item.model).filter(Boolean))];
        return {
            model: models.length ? models.map(normalizeModelName).join('、') : '未識別機種',
            productCode: matched.length ? [...new Set(matched.map(item => item.productCode))].join('、') : (unknownProductCodes.join('、') || '未識別產品代碼'),
            unknownProductCodes,
            unknownProductDetails
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
        const { rows: sourceRows, columnCount } = await readFileRows(file);
        const rows = deduplicateRows(sourceRows);
        const duplicateCount = sourceRows.length - rows.length;
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
            const parsedDateTime = parseDateTime(row[COL_DATE]);
            const parsedDate = parsedDateTime ? fmtDate(parsedDateTime) : '';
            const isDefect = status === 'FAIL';
            return {
                workOrder: cleanText(row[COL_WORK_ORDER]) || '未識別工單',
                productCode: cleanText(row[COL_PRODUCT_CODE]),
                dedupKey: normalizeText(row[COL_DEDUP_KEY]),
                dedupTime: parsedDateTime ? parsedDateTime.getTime() : null,
                date: parsedDate,
                defect: isDefect ? (cleanText(row[COL_DEFECT]) || defaultDafDefect()) : '',
                status,
                model: normalizeModelName(model.model),
                machine: '',
                inputIncluded: ['GOOD', 'FAIL'].includes(status),
                isDefect,
                raw: Array.from({ length: columnCount }, (_, index) => displayCell(row[index]))
            };
        });
        return {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            line: currentDafLine(),
            machine: '',
            fileName: file.name,
            uploadedAt: new Date().toISOString(),
            modelName: normalizeModelName(model.model),
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
            unknownProductCodes: model.unknownProductCodes,
            unknownProductDetails: model.unknownProductDetails,
            duplicateCount,
            rawRowCount: sourceRows.length,
            records
        };
    };

    const readStorage = () => {
        try {
            const parsed = JSON.parse(localStorage.getItem(currentDafStorageKey()) || '[]');
            return Array.isArray(parsed) ? parsed.map(normalizeBatchModels) : [];
        } catch (e) { return []; }
    };
    // 本機只保存統計所需欄位；原始 raw 欄位由 Supabase 批次資料保留，避免大量 LOG 撐滿 localStorage。
    const compactDafBatch = batch => ({
        ...batch,
        records: (batch.records || []).map(({ raw, ...record }) => record)
    });
    const persistStorage = () => {
        const compact = dafBatches.value.map(compactDafBatch);
        const attempts = [
            compact.slice(0, 100),
            compact.slice(0, 40),
            compact.slice(0, 15),
            compact.slice(0, 5).map(batch => ({ ...batch, records: batch.records.slice(0, 5000) })),
            compact.slice(0, 5).map(batch => ({ ...batch, records: [] }))
        ];
        for (const cache of attempts) {
            try {
                localStorage.setItem(currentDafStorageKey(), JSON.stringify(cache));
                return;
            } catch (e) {}
        }
        try { localStorage.removeItem(currentDafStorageKey()); } catch (e) {}
    };
    const hasMigrationFlag = () => {
        try { return localStorage.getItem(currentDafMigrationKey()) === '1'; } catch (e) { return false; }
    };
    const setMigrationFlag = () => {
        try { localStorage.setItem(currentDafMigrationKey(), '1'); } catch (e) {}
    };
    const toRemote = (batch) => ({
        id: batch.id, line: currentDafLine(), file_name: batch.fileName, uploaded_at: batch.uploadedAt,
        model_name: batch.modelName, product_code: batch.productCode, work_order: batch.workOrder,
        report_date: batch.reportDate, date_start: batch.dateStart || null, date_end: batch.dateEnd || null,
        input_count: batch.inputCount, good_count: batch.goodCount, fail_count: batch.failCount,
        yield_rate: Number(batch.yieldRate) || 0, defect_rate: Number(batch.defectRate) || 0,
        unknown_status_count: batch.unknownStatusCount, unknown_status_text: batch.unknownStatusText,
        row_count: batch.rowCount, raw_column_count: batch.rawColumnCount, records: batch.records
    });
    const fromRemote = (row) => normalizeBatchModels({
        id: row.id, line: row.line || currentDafLine(), fileName: row.file_name, uploadedAt: row.uploaded_at,
        modelName: normalizeModelName(row.model_name), productCode: row.product_code, workOrder: row.work_order,
        workOrderFileName: row.work_order, reportDate: row.report_date, dateStart: row.date_start || '', dateEnd: row.date_end || '',
        inputCount: row.input_count || 0, goodCount: row.good_count || 0, failCount: row.fail_count || 0,
        yieldRate: Number(row.yield_rate || 0).toFixed(2), defectRate: Number(row.defect_rate || 0).toFixed(2),
        unknownStatusCount: row.unknown_status_count || 0, unknownStatusText: row.unknown_status_text || '無',
        rowCount: row.row_count || 0, rawColumnCount: row.raw_column_count || 10,
        records: row.records || []
    });
    const saveRemote = async (batch) => {
        if (!dafRemoteReady.value) return false;
        const { error } = await _supabase.from(REMOTE_TABLE).upsert(toRemote(batch), { onConflict: 'id' });
        if (error) { dafRemoteError.value = error.message || `${currentDafLabel()} 共用資料庫寫入失敗`; return false; }
        return true;
    };
    const deleteRemote = async (id) => {
        if (!dafRemoteReady.value) return true;
        const { error } = await _supabase.from(REMOTE_TABLE).delete().eq('id', id).eq('line', currentDafLine());
        if (error) { toast(`${currentDafLabel()} 共用資料庫刪除失敗：` + error.message, 'error'); return false; }
        return true;
    };
    const loadDafRemoteRows = async (line = currentDafLine()) => {
        const pageSize = 500;
        const rows = [];
        for (let offset = 0; ; offset += pageSize) {
            const { data: page, error } = await _supabase.from(REMOTE_TABLE)
                .select('*').eq('line', line).order('uploaded_at', { ascending: false })
                .range(offset, offset + pageSize - 1);
            if (error) return { data: null, error };
            rows.push(...(page || []));
            if (!page || page.length < pageSize) return { data: rows, error: null };
        }
    };
    const rebuildDafBatch = batch => {
        const records = (batch.records || []).map(normalizeDafRecord);
        const inputRecords = records.filter(record => record.inputIncluded);
        const statuses = records.map(record => normalizeText(record.status));
        const dates = [...new Set(records.map(record => record.date).filter(Boolean))].sort();
        const workOrders = [...new Set(records.map(record => cleanText(record.workOrder)).filter(Boolean))];
        const products = [...new Set(records.map(record => cleanText(record.productCode)).filter(Boolean))];
        const models = [...new Set(records.map(record => normalizeModelName(record.model)).filter(model => model !== '未識別機種'))];
        const goodCount = inputRecords.filter(record => record.status === 'GOOD').length;
        const failCount = inputRecords.filter(record => record.status === 'FAIL').length;
        const unknownStatuses = [...new Set(statuses.filter(status => status && !['GOOD', 'FAIL'].includes(status)))];
        const dateStart = dates[0] || batch.dateStart || '';
        const dateEnd = dates[dates.length - 1] || batch.dateEnd || dateStart;
        return {
            ...batch,
            machine: '',
            modelName: models.length ? models.join('、') : normalizeModelName(batch.modelName),
            productCode: products.join('、') || batch.productCode || '未識別產品代碼',
            workOrder: workOrders.length ? workOrders.join('、') : (batch.workOrder || '未識別工單'),
            workOrderFileName: workOrders.length === 1 ? workOrders[0] : workOrders.length ? `${workOrders[0]}等${workOrders.length}筆工單` : (batch.workOrderFileName || '未識別工單'),
            reportDate: dateStart ? (dateStart === dateEnd ? dateStart : `${dateStart}～${dateEnd}`) : (batch.reportDate || '未識別日期'),
            dateStart,
            dateEnd,
            inputCount: inputRecords.length,
            goodCount,
            failCount,
            yieldRate: inputRecords.length ? (goodCount / inputRecords.length * 100).toFixed(2) : '0.00',
            defectRate: inputRecords.length ? (failCount / inputRecords.length * 100).toFixed(2) : '0.00',
            unknownStatusCount: statuses.filter(status => status && !['GOOD', 'FAIL'].includes(status)).length,
            unknownStatusText: unknownStatuses.join('、') || '無',
            rowCount: records.length,
            records
        };
    };
    const deduplicateDafBatches = batches => {
        const normalized = (batches || []).map(rebuildDafBatch);
        const selected = new Map();
        const duplicates = new Set();
        let duplicateCount = 0;
        normalized.forEach(batch => (batch.records || []).forEach(record => {
            if (!record.dedupKey) return;
            const hasTime = record.dedupTime !== null && record.dedupTime !== undefined && record.dedupTime !== '';
            const timestamp = hasTime && Number.isFinite(Number(record.dedupTime)) ? Number(record.dedupTime) : Number.MAX_SAFE_INTEGER;
            const previous = selected.get(record.dedupKey);
            if (!previous) {
                selected.set(record.dedupKey, { record, timestamp });
                return;
            }
            duplicateCount++;
            if (timestamp < previous.timestamp) {
                duplicates.add(previous.record);
                selected.set(record.dedupKey, { record, timestamp });
            } else {
                duplicates.add(record);
            }
        }));
        return {
            batches: normalized.map(batch => rebuildDafBatch({
                ...batch,
                records: (batch.records || []).filter(record => !duplicates.has(record))
            })),
            duplicateCount
        };
    };
    const dafBatchSignature = batch => (batch.records || []).map(record => [
        record.dedupKey, record.dedupTime, record.date, record.status,
        record.workOrder, record.productCode, record.defect, record.model
    ].join('|')).join('\n');
    const syncDafRemoteChanges = async (before, after) => {
        if (!dafRemoteReady.value) return true;
        const beforeIds = new Set((before || []).map(batch => batch.id));
        const afterById = new Map((after || []).map(batch => [batch.id, batch]));
        let success = true;
        for (const oldBatch of before || []) {
            const nextBatch = afterById.get(oldBatch.id);
            if (!nextBatch) {
                if (!(await deleteRemote(oldBatch.id))) success = false;
            } else if (dafBatchSignature(oldBatch) !== dafBatchSignature(nextBatch)) {
                if (!(await saveRemote(nextBatch))) success = false;
            }
        }
        for (const newBatch of after || []) {
            if (!beforeIds.has(newBatch.id) && !(await saveRemote(newBatch))) success = false;
        }
        return success;
    };
    const mergeDafBatch = async incoming => {
        const before = dafBatches.value.map(rebuildDafBatch);
        const merged = deduplicateDafBatches([...before, incoming]);
        const batches = merged.batches.filter(batch => !(batch.id === incoming.id && incoming.records?.length && !batch.records.length));
        const remoteSaved = await syncDafRemoteChanges(before, batches);
        dafBatches.value = batches;
        persistStorage();
        dafLastUpload.value = batches.find(batch => batch.id === incoming.id) || batches[0] || null;
        learnModelMappings(batches);
        return {
            batch: batches.find(batch => batch.id === incoming.id) || null,
            duplicateCount: merged.duplicateCount,
            remoteSaved
        };
    };
    let dafLoadRequestId = 0;
    const loadDafData = async () => {
        const requestId = ++dafLoadRequestId;
        const line = currentDafLine();
        const localBatches = deduplicateDafBatches(readStorage()).batches;
        if (!isDafLikeLine()) { dafBatches.value = localBatches; return; }
        const { data: remoteRows, error } = await loadDafRemoteRows(line);
        if (requestId !== dafLoadRequestId || line !== currentDafLine()) return;
        if (error) {
            dafRemoteReady.value = false;
            dafRemoteError.value = error.code === 'PGRST205' ? '尚未建立 DAF 檔案統計共用資料表' : (error.message || 'DAF 共用資料庫讀取失敗');
            dafBatches.value = localBatches;
        } else {
            dafRemoteReady.value = true;
            dafRemoteError.value = '';
            const remoteBatches = (remoteRows || []).map(fromRemote);
            const remoteState = deduplicateDafBatches(remoteBatches);
            let batches = remoteState.batches;
            if (!hasMigrationFlag() && localBatches.length && batches.length === 0) {
                const { error: migrationError } = await _supabase.from(REMOTE_TABLE).upsert(localBatches.map(toRemote), { onConflict: 'id' });
                if (!migrationError) { batches = localBatches; setMigrationFlag(); }
            } else if (!hasMigrationFlag()) setMigrationFlag();
            if (remoteState.duplicateCount) await syncDafRemoteChanges(remoteBatches, batches);
            dafBatches.value = batches;
            persistStorage();
        }
        learnModelMappings(dafBatches.value);
        dafLastUpload.value = dafBatches.value[0] || null;
        if (dafStatsResult.value) calculateDafStats(false);
    };

    let allRecordsCacheSource = null;
    let allRecordsCacheRows = [];
    const allRecords = () => {
        if (allRecordsCacheSource !== dafBatches.value) {
            allRecordsCacheSource = dafBatches.value;
            allRecordsCacheRows = dafBatches.value.flatMap(batch => (batch.records || []).map(record => ({ ...record, fileName: batch.fileName, batchId: batch.id })));
        }
        return allRecordsCacheRows;
    };
    let dafDateIndexSource = null;
    let dafRowsByDate = new Map();
    let dafInputCountByDate = new Map();
    const ensureDafDateIndex = () => {
        if (dafDateIndexSource === dafBatches.value) return;
        dafDateIndexSource = dafBatches.value;
        dafRowsByDate = new Map();
        dafInputCountByDate = new Map();
        allRecords().forEach(row => {
            if (!row.date) return;
            if (!dafRowsByDate.has(row.date)) dafRowsByDate.set(row.date, []);
            dafRowsByDate.get(row.date).push(row);
            if (row.inputIncluded) dafInputCountByDate.set(row.date, (dafInputCountByDate.get(row.date) || 0) + 1);
        });
    };
    const getDafRowsForDate = date => {
        ensureDafDateIndex();
        return dafRowsByDate.get(date) || [];
    };
    const dafBatchesByDate = computed(() => {
        const groups = {};
        dafBatches.value.forEach(batch => {
            const records = batch.records || [];
            const dates = [...new Set(records.map(record => record.date).filter(Boolean))];
            if (!dates.length) dates.push(batch.dateStart || '未識別日期');
            dates.forEach(date => {
                const dateRecords = records.filter(record => record.date === date);
                const inputRecords = dateRecords.filter(record => record.inputIncluded);
                const group = groups[date] || (groups[date] = { date, files: [], input: 0, good: 0, defects: 0 });
                group.input += inputRecords.length;
                group.good += inputRecords.filter(record => record.status === 'GOOD').length;
                group.defects += inputRecords.filter(record => record.status === 'FAIL').length;
                group.files.push({
                    ...batch,
                    key: `${batch.id}_${date}`,
                    dateRecords,
                    dateInput: inputRecords.length,
                    dateGood: inputRecords.filter(record => record.status === 'GOOD').length,
                    dateDefects: inputRecords.filter(record => record.status === 'FAIL').length
                });
            });
        });
        return Object.values(groups).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    });
    const dafModelOptions = computed(() => [...new Set([
        ...allRecords().map(row => normalizeModelName(row.model)),
        ...(data?.value?.models || []).map(model => normalizeModelName(model.name)),
        ...Object.values(dafModelMappings.value).map(normalizeModelName),
        ...Object.values(MODEL_MAPPING).map(normalizeModelName)
    ].filter(model => model && model !== '未識別機種'))].sort((a, b) => a.localeCompare(b, 'zh-Hant')));
    const dafWorkOrderOptions = computed(() => [...new Set(allRecords().map(row => row.workOrder).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant')));
    const filterRecords = () => allRecords().filter(row => {
        if (dafStatsFilter.value.start && (!row.date || row.date < dafStatsFilter.value.start)) return false;
        if (dafStatsFilter.value.end && (!row.date || row.date > dafStatsFilter.value.end)) return false;
        if (dafStatsFilter.value.model !== 'all' && row.model !== dafStatsFilter.value.model) return false;
        if (dafStatsFilter.value.workOrder !== 'all' && row.workOrder !== dafStatsFilter.value.workOrder) return false;
        return true;
    });
    const mapRate = (value, base) => base ? (value / base * 100).toFixed(2) : '0.00';
    const buildDafSummary = rows => {
        const inputRows = (rows || []).filter(row => row.inputIncluded);
        const goodRows = inputRows.filter(row => row.status === 'GOOD');
        const failRows = inputRows.filter(row => row.status === 'FAIL');
        const input = inputRows.length;
        const defects = failRows.length;
        const defectMap = {};
        const defectModelMap = {};
        const defectWorkOrderMap = {};
        const modelDefectMap = {};
        const workOrderDefectMap = {};
        const modelMap = {};
        const workOrderMap = {};
        const dayMap = {};
        failRows.forEach(row => {
            const defect = row.defect || defaultDafDefect();
            const model = row.model || '未識別機種';
            const workOrder = row.workOrder || '未識別工單';
            defectMap[defect] = (defectMap[defect] || 0) + 1;
            if (!defectModelMap[defect]) defectModelMap[defect] = {};
            if (!defectWorkOrderMap[defect]) defectWorkOrderMap[defect] = {};
            if (!modelDefectMap[model]) modelDefectMap[model] = {};
            if (!workOrderDefectMap[workOrder]) workOrderDefectMap[workOrder] = {};
            defectModelMap[defect][model] = (defectModelMap[defect][model] || 0) + 1;
            defectWorkOrderMap[defect][workOrder] = (defectWorkOrderMap[defect][workOrder] || 0) + 1;
            modelDefectMap[model][defect] = (modelDefectMap[model][defect] || 0) + 1;
            workOrderDefectMap[workOrder][defect] = (workOrderDefectMap[workOrder][defect] || 0) + 1;
        });
        inputRows.forEach(row => {
            const model = row.model || '未識別機種';
            const workOrder = row.workOrder || '未識別工單';
            if (!modelMap[model]) modelMap[model] = { input: 0, good: 0, defects: 0, byWorkOrder: {} };
            if (!workOrderMap[workOrder]) workOrderMap[workOrder] = { models: new Set(), input: 0, good: 0, defects: 0, byModel: {} };
            modelMap[model].input++;
            workOrderMap[workOrder].input++;
            workOrderMap[workOrder].models.add(model);
            modelMap[model].byWorkOrder[workOrder] = (modelMap[model].byWorkOrder[workOrder] || 0) + 1;
            workOrderMap[workOrder].byModel[model] = (workOrderMap[workOrder].byModel[model] || 0) + 1;
            if (row.status === 'GOOD') { modelMap[model].good++; workOrderMap[workOrder].good++; }
            if (row.status === 'FAIL') { modelMap[model].defects++; workOrderMap[workOrder].defects++; }
            if (row.date) {
                if (!dayMap[row.date]) dayMap[row.date] = { date: row.date, input: 0, good: 0, defects: 0, byType: {} };
                dayMap[row.date].input++;
                if (row.status === 'GOOD') dayMap[row.date].good++;
                if (row.status === 'FAIL') { dayMap[row.date].defects++; const defect = row.defect || defaultDafDefect(); dayMap[row.date].byType[defect] = (dayMap[row.date].byType[defect] || 0) + 1; }
            }
        });
        const detailRows = map => Object.entries(map || {}).map(([name, qty]) => ({ name, qty, ratio: mapRate(qty, Object.values(map).reduce((sum, value) => sum + value, 0)) })).sort((a, b) => b.qty - a.qty);
        const byType = Object.entries(defectMap).map(([name, qty]) => ({
            name, qty, inputRatio: mapRate(qty, input), ratio: mapRate(qty, defects),
            byModel: detailRows(defectModelMap[name]),
            byWorkOrder: detailRows(defectWorkOrderMap[name])
        })).sort((a, b) => b.qty - a.qty);
        const byModel = Object.entries(modelMap).map(([name, value]) => ({ name, input: value.input, good: value.good, defects: value.defects, yieldRate: mapRate(value.good, value.input), defectRate: mapRate(value.defects, value.input), ratio: mapRate(value.defects, defects), byType: detailRows(modelDefectMap[name]), byWorkOrder: detailRows(value.byWorkOrder) })).sort((a, b) => b.defects - a.defects || b.input - a.input);
        const byWorkOrder = Object.entries(workOrderMap).map(([workOrder, value]) => ({ workOrder, name: workOrder, model: [...value.models].join(' / '), input: value.input, good: value.good, defects: value.defects, yieldRate: mapRate(value.good, value.input), defectRate: mapRate(value.defects, value.input), ratio: mapRate(value.defects, defects), byType: detailRows(workOrderDefectMap[workOrder]), byModel: detailRows(value.byModel) })).sort((a, b) => b.defects - a.defects || b.input - a.input);
        const daily = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date)).map(day => ({ ...day, total: day.input, yieldRate: mapRate(day.good, day.input), defectRate: mapRate(day.defects, day.input) }));
        const unknownStatuses = [...new Set((rows || []).map(row => row.status).filter(status => status && !['GOOD', 'FAIL'].includes(status)))];
        const result = {
            totalInput: input, totalGood: goodRows.length, totalDefects: defects,
            yieldRate: mapRate(goodRows.length, input), defectRate: mapRate(defects, input),
            unknownStatusCount: (rows || []).filter(row => row.status && !['GOOD', 'FAIL'].includes(row.status)).length,
            unknownStatusText: unknownStatuses.join('、') || '無',
            totalDays: daily.length, totalRows: (rows || []).length, sourceFiles: [...new Set((rows || []).map(row => row.fileName).filter(Boolean))],
            byType, byModel, byWorkOrder, daily, rows: rows || []
        };
        return result;
    };
    const buildDafStats = () => buildDafSummary(filterRecords());
    let dafDashboardCacheSource = null;
    const dafDashboardCache = new Map();
    const getDafUploadedDates = (limit = 14) => {
        ensureDafDateIndex();
        return [...dafInputCountByDate.keys()]
            .filter(date => dafInputCountByDate.get(date) > 0)
            .sort()
            .slice(-limit);
    };
    const getDafDashboardForDate = date => {
        if (dafDashboardCacheSource !== dafBatches.value) {
            dafDashboardCacheSource = dafBatches.value;
            dafDashboardCache.clear();
        }
        if (dafDashboardCache.has(date)) return dafDashboardCache.get(date);
        const rows = getDafRowsForDate(date);
        const result = { ...buildDafSummary(rows), date };
        dafDashboardCache.set(date, result);
        return result;
    };
    const dafQuickRange = (mode, offset) => {
        const now = new Date(); now.setHours(0, 0, 0, 0);
        if (mode === 'day') {
            const date = new Date(now); date.setDate(date.getDate() + offset);
            return { start: date, end: date };
        }
        if (mode === 'week') {
            const start = new Date(now);
            start.setDate(start.getDate() - start.getDay() + offset * 7);
            const end = new Date(start); end.setDate(end.getDate() + 6);
            return { start, end };
        }
        const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
        const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
        return { start, end };
    };
    const dafQuickLabel = computed(() => {
        if (!dafQuickMode.value) return '';
        const { start, end } = dafQuickRange(dafQuickMode.value, dafQuickOffset.value);
        if (dafQuickMode.value === 'day') return `${fmtDate(start)} (週${['日', '一', '二', '三', '四', '五', '六'][start.getDay()]})`;
        if (dafQuickMode.value === 'week') return `${fmtDate(start)} ~ ${fmtDate(end)}`;
        return `${start.getFullYear()} 年 ${start.getMonth() + 1} 月`;
    });
    const dafQuickRelative = computed(() => {
        if (!dafQuickMode.value) return '';
        const offset = dafQuickOffset.value;
        const unit = { day: '日', week: '週', month: '月' }[dafQuickMode.value];
        if (offset === 0) return `本${unit}`;
        if (offset === -1) return `上一${unit}`;
        if (offset === 1) return `下一${unit}`;
        return offset < 0 ? `${Math.abs(offset)} ${unit}前` : `${offset} ${unit}後`;
    });
    const applyDafQuick = async () => {
        if (!dafQuickMode.value) return;
        const { start, end } = dafQuickRange(dafQuickMode.value, dafQuickOffset.value);
        applyingDafQuick = true;
        dafStatsFilter.value.start = fmtDate(start);
        dafStatsFilter.value.end = fmtDate(end);
        await Vue.nextTick();
        applyingDafQuick = false;
        calculateDafStats();
    };
    const setDafQuickMode = mode => {
        dafQuickMode.value = mode;
        dafQuickOffset.value = { day: 0, week: -1, month: -1 }[mode];
        applyDafQuick();
    };
    const shiftDafQuick = delta => {
        if (!dafQuickMode.value) return;
        dafQuickOffset.value += delta;
        applyDafQuick();
    };
    const calculateDafStats = (showToast = true) => {
        if (dafStatsFilter.value.start && dafStatsFilter.value.end && dafStatsFilter.value.start > dafStatsFilter.value.end) return toast('開始日期不能晚於結束日期', 'warning');
        dafDefectDetail.value = { show: false, name: '', qty: 0, byModel: [], byWorkOrder: [] };
        dafModelDetail.value = { show: false, name: '', input: 0, good: 0, defects: 0, yieldRate: '0.00', byType: [] };
        dafWorkOrderDetail.value = { show: false, workOrder: '', model: '', input: 0, good: 0, defects: 0, yieldRate: '0.00', byType: [], byModel: [] };
        dafStatsResult.value = buildDafStats();
        renderDafCharts();
        if (showToast) toast(`${currentDafLabel()} 統計完成，共 ${dafStatsResult.value.sourceFiles.length} 個檔案`);
    };
    const openDafDefectDetail = name => {
        const row = (dafStatsResult.value?.byType || []).find(item => item.name === name);
        dafDefectDetail.value = row
            ? { show: true, name: row.name, qty: row.qty, byModel: row.byModel || [], byWorkOrder: row.byWorkOrder || [] }
            : { show: false, name: '', qty: 0, byModel: [], byWorkOrder: [] };
    };
    const closeDafDefectDetail = () => {
        dafDefectDetail.value = { show: false, name: '', qty: 0, byModel: [], byWorkOrder: [] };
    };
    const openDafModelStatsDetail = name => {
        const row = (dafStatsResult.value?.byModel || []).find(item => item.name === name);
        dafModelDetail.value = row
            ? { show: true, name: row.name, input: row.input, good: row.good, defects: row.defects, yieldRate: row.yieldRate, byType: row.byType || [] }
            : { show: false, name: '', input: 0, good: 0, defects: 0, yieldRate: '0.00', byType: [] };
    };
    const closeDafModelStatsDetail = () => {
        dafModelDetail.value = { show: false, name: '', input: 0, good: 0, defects: 0, yieldRate: '0.00', byType: [] };
    };
    const openDafWorkOrderStatsDetail = workOrder => {
        const row = (dafStatsResult.value?.byWorkOrder || []).find(item => item.workOrder === workOrder);
        dafWorkOrderDetail.value = row
            ? { show: true, workOrder: row.workOrder, model: row.model, input: row.input, good: row.good, defects: row.defects, yieldRate: row.yieldRate, byType: row.byType || [], byModel: row.byModel || [] }
            : { show: false, workOrder: '', model: '', input: 0, good: 0, defects: 0, yieldRate: '0.00', byType: [], byModel: [] };
    };
    const closeDafWorkOrderStatsDetail = () => {
        dafWorkOrderDetail.value = { show: false, workOrder: '', model: '', input: 0, good: 0, defects: 0, yieldRate: '0.00', byType: [], byModel: [] };
    };
    const openDafOutputDetail = () => {
        const result = dafStatsResult.value;
        if (!result) return;
        dafOutputDetail.value = { show: true, title: `${currentDafLabel()} 產出與良率明細`, subtitle: '顯示目前篩選條件的總投入、良品、不良與良率', result };
    };
    const closeDafOutputDetail = () => {
        dafOutputDetail.value = { show: false, title: '', subtitle: '', result: null };
    };
    const ensureDafBaseSettings = async batch => {
        const modelNames = [...new Set((batch.records || []).flatMap(record => cleanText(record.model).split('、').map(cleanText).filter(model => model && model !== '未識別機種')))];
        const defectNames = [...new Set((batch.records || []).filter(record => record.isDefect).map(record => cleanText(record.defect)).filter(Boolean))];
        if (!modelNames.length && !defectNames.length) return;
        try {
            const [{ data: existingModels, error: modelReadError }, { data: existingDefects, error: defectReadError }] = await Promise.all([
                _supabase.from('models').select('name').eq('line', currentDafLine()),
                _supabase.from('defect_types').select('name').eq('line', currentDafLine())
            ]);
            if (modelReadError || defectReadError) throw modelReadError || defectReadError;
            const modelSet = new Set((existingModels || []).map(row => normalizeText(row.name)));
            const defectSet = new Set((existingDefects || []).map(row => normalizeText(row.name)));
            const missingModels = modelNames.filter(name => !modelSet.has(normalizeText(name)));
            const missingDefects = defectNames.filter(name => !defectSet.has(normalizeText(name)));
            let created = 0;
            for (const name of missingModels) {
                const { error } = await _supabase.from('models').insert({ name, line: currentDafLine() });
                if (!error) created++;
            }
            for (const name of missingDefects) {
                const { error } = await _supabase.from('defect_types').insert({ name, line: currentDafLine() });
                if (!error) created++;
            }
            if (created && loadBaseData) await loadBaseData();
            if (missingModels.length || missingDefects.length) {
                toast(`${currentDafLabel()} 已自動新增基礎設定：機種 ${missingModels.length} 項、不良現象 ${missingDefects.length} 項`, 'info');
            }
        } catch (error) {
            console.warn(`${currentDafLabel()} 基礎設定自動同步失敗`, error);
            toast(`${currentDafLabel()} 檔案已分析，但基礎設定自動新增失敗`, 'warning');
        }
    };
    const finishDafUploadQueue = queue => {
        persistStorage();
        dafUploadSummary.value = { files: queue.success, rows: queue.rows, duplicates: queue.duplicates, failed: queue.failed };
        if (dafStatsResult.value) dafStatsResult.value = buildDafStats();
        if (queue.success) toast(`${currentDafLabel()} 完成 ${queue.success} 個檔案，共 ${queue.rows.toLocaleString()} 列${queue.duplicates ? `，已排除重複 ${queue.duplicates} 列` : ''}${queue.failed.length ? '；有檔案失敗' : ''}`, queue.failed.length ? 'warning' : 'success');
        else toast(`${currentDafLabel()} 檔案全部處理失敗`, 'error');
    };
    const processDafUploadQueue = async queue => {
        for (let index = queue.index; index < queue.files.length; index++) {
            const file = queue.files[index];
            try {
                const batch = await analyzeFile(file);
                if (batch.unknownProductDetails?.length || batch.unknownProductCodes?.length) {
                    queue.index = index;
                    pendingDafUpload.value = queue;
                    const items = batch.unknownProductDetails?.length
                        ? batch.unknownProductDetails
                        : batch.unknownProductCodes.map(code => ({ code, workOrders: [] }));
                    dafUnknownModelModal.value = { show: true, fileName: file.name, items, currentIndex: 0, selectedModel: '', newModel: '' };
                    toast(`發現 ${items.length} 個未識別機種代號，請先完成歸類`, 'warning');
                    return false;
                }
                await ensureDafBaseSettings(batch);
                const merged = await mergeDafBatch(batch);
                queue.rows += merged.batch?.rowCount || 0;
                queue.duplicates += (batch.duplicateCount || 0) + merged.duplicateCount;
                queue.success++;
                if (dafRemoteReady.value && !merged.remoteSaved) queue.failed.push(`${file.name}：共用資料庫寫入失敗`);
            } catch (error) { queue.failed.push(`${file.name}：${error.message}`); }
        }
        finishDafUploadQueue(queue);
        return true;
    };
    const uploadDafFiles = async event => {
        const files = [...(event.target.files || [])];
        if (!files.length) return;
        const queue = { files, index: 0, success: 0, rows: 0, duplicates: 0, failed: [] };
        loading.value = true;
        try { await processDafUploadQueue(queue); }
        finally {
            loading.value = false;
            event.target.value = '';
        }
    };
    const resolveDafUnknownModel = async () => {
        const modal = dafUnknownModelModal.value;
        const current = modal.items[modal.currentIndex];
        const code = current?.code || current;
        const selected = cleanText(modal.selectedModel);
        const created = cleanText(modal.newModel);
        if (selected && created) return toast('請選擇既有機種或新增機種其中一種', 'warning');
        if (!selected && !created) return toast('請選擇既有機種或輸入新的機種名稱', 'warning');
        const modelName = created || selected;
        dafModelMappings.value = { ...dafModelMappings.value, [normalizeText(code)]: normalizeModelName(modelName) };
        persistModelMappings();
        if (modal.currentIndex < modal.items.length - 1) {
            dafUnknownModelModal.value = { ...modal, currentIndex: modal.currentIndex + 1, selectedModel: '', newModel: '' };
            return;
        }
        const queue = pendingDafUpload.value;
        pendingDafUpload.value = null;
        dafUnknownModelModal.value = { show: false, fileName: '', items: [], currentIndex: 0, selectedModel: '', newModel: '' };
        if (!queue) return;
        loading.value = true;
        try { await processDafUploadQueue(queue); }
        finally { loading.value = false; }
    };
    const cancelDafUnknownModel = () => {
        pendingDafUpload.value = null;
        dafUnknownModelModal.value = { show: false, fileName: '', items: [], currentIndex: 0, selectedModel: '', newModel: '' };
        toast(`已取消此次 ${currentDafLabel()} 上傳`, 'info');
    };
    const deleteDafBatch = async (id) => {
        const batch = dafBatches.value.find(item => item.id === id);
        if (!batch || !confirm(`確定刪除 ${batch.fileName} 的 ${currentDafLabel()} 統計？`)) return;
        if (!(await deleteRemote(id))) return;
        dafBatches.value = dafBatches.value.filter(item => item.id !== id);
        dafLastUpload.value = dafBatches.value[0] || null;
        persistStorage();
        if (dafStatsResult.value) dafStatsResult.value = buildDafStats();
        toast(`${currentDafLabel()} 檔案統計已刪除`, 'info');
    };

    const exportDafStats = () => {
        if (!dafStatsResult.value) return toast(`請先執行 ${currentDafLabel()} 統計`, 'warning');
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
        const defectModels = [['不良原因', '機種', '數量', '占該不良比例'], ...result.byType.flatMap(row => (row.byModel || []).map(item => [row.name, item.name, item.qty, item.ratio + '%']))];
        const defectWorkOrders = [['不良原因', '工單', '數量', '占該不良比例'], ...result.byType.flatMap(row => (row.byWorkOrder || []).map(item => [row.name, item.name, item.qty, item.ratio + '%']))];
        const modelDefects = [['機種', 'NG項目', '數量', '占該機種NG比例'], ...result.byModel.flatMap(row => (row.byType || []).map(item => [row.name, item.name, item.qty, item.ratio + '%']))];
        const models = [['機種', '投入數', '良品數', '不良數', '良率', '不良率', '占總不良比例'], ...result.byModel.map(row => [row.name, row.input, row.good, row.defects, row.yieldRate + '%', row.defectRate + '%', row.ratio + '%'])];
        const workOrders = [['工單', '機種', '投入數', '良品數', '不良數', '良率', '不良率', '占總不良比例'], ...result.byWorkOrder.map(row => [row.workOrder, row.model, row.input, row.good, row.defects, row.yieldRate + '%', row.defectRate + '%', row.ratio + '%'])];
        const workOrderDefects = [['工單', '機種', 'NG項目', '數量', '占該工單NG比例'], ...result.byWorkOrder.flatMap(row => (row.byType || []).map(item => [row.workOrder, row.model, item.name, item.qty, item.ratio + '%']))];
        const daily = [['日期', '投入數', '良品數', '不良數', '良率', '不良率'], ...result.daily.map(row => [row.date, row.input, row.good, row.defects, row.yieldRate + '%', row.defectRate + '%'])];
        const pareto = [['不良現象', '不良數量', '占不良比例'], ...result.byType.map(row => [row.name, row.qty, row.ratio + '%'])];
        const yieldTrend = [['日期', '投入數', '良品數', '不良數', '良率'], ...result.daily.map(row => [row.date, row.input, row.good, row.defects, row.yieldRate + '%'])];
        const outputTrend = [['日期', '投入數', '良品數', '不良數'], ...result.daily.map(row => [row.date, row.input, row.good, row.defects])];
        const rawHeader = ['系統識別機種', '系統識別產品代碼', '系統識別狀態', '是否列入投入數', '是否為不良', '系統解析日期'];
        const rawRows = result.rows.map(row => [row.model, row.productCode, row.status, row.inputIncluded ? '是' : '否', row.isDefect ? '是' : '否', row.date, ...(row.raw || [])]);
        const rawColumns = Math.max(10, ...result.rows.map(row => (row.raw || []).length));
        for (let index = 0; index < rawColumns; index++) rawHeader.push(`${String.fromCharCode(65 + index)}欄${[2, 4, 6, 8, 9].includes(index) ? ['工單', '產品代碼', '日期', '不良原因', '狀態'][[2, 4, 6, 8, 9].indexOf(index)] : ''}`);
        const wb = XLSX.utils.book_new();
        const sheets = [['生產統計', summary], ['良率趨勢', yieldTrend], ['Pareto分析', pareto], ['不良原因統計', defects], ['不良×機種', defectModels], ['不良×工單', defectWorkOrders], ['機種統計', models], ['機種×NG細項', modelDefects], ['工單統計', workOrders], ['工單×NG細項', workOrderDefects], ['每日統計', daily], ['原始資料', [rawHeader, ...rawRows]]];
        sheets.forEach(([name, sheetData]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetData), name));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(outputTrend), '產出趨勢');
        const modelPart = dafStatsFilter.value.model === 'all' ? '全部機種' : safeFilename(dafStatsFilter.value.model);
        const woPart = dafStatsFilter.value.workOrder === 'all' ? '全部工單' : safeFilename(dafStatsFilter.value.workOrder);
        XLSX.writeFile(wb, `${currentDafLabel()}_${modelPart}_${woPart}_${safeFilename(range, '不限日期')}_統計結果.xlsx`);
        toast(`${currentDafLabel()} 完整統計報表已導出`);
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
                const rows = result.byType.slice(0, 12);
                const names = rows.map(row => row.name);
                const quantities = rows.map(row => row.qty);
                reasonChart.setOption({
                    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
                    legend: { data: ['不良數量'], top: 8, right: 10, textStyle: { fontSize: 11, color: '#6b7280' } },
                    grid: { top: 64, right: 58, bottom: 64, left: 48 },
                    xAxis: { type: 'category', data: names, triggerEvent: true, axisLabel: { rotate: names.some(name => name.length > 5) ? 20 : 0, fontSize: 10, color: '#374151' }, axisLine: { lineStyle: { color: '#e5e7eb' } } },
                    yAxis: { type: 'value', name: '數量', nameTextStyle: { color: '#6b7280', fontSize: 10 }, axisLabel: { fontSize: 10, color: '#9ca3af' }, splitLine: { lineStyle: { color: '#f3f4f6' } } },
                    series: [{ name: '不良數量', type: 'bar', data: quantities, barMaxWidth: 40, itemStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: '#dc2626' }, { offset: 1, color: '#fca5a5' }] }, borderRadius: [4, 4, 0, 0] }, label: { show: true, position: 'top', fontSize: 10 } }]
                });
                if (reasonChart.off) reasonChart.off('click');
                if (reasonChart.on) reasonChart.on('click', params => { const name = params?.componentType === 'xAxis' ? params.value : params?.name; if (name) openDafDefectDetail(name); });
            } else reasonChart = disposeChart(reasonChart);
            if (trendEl && result?.daily?.length) {
                if (!trendChart || trendChart.getDom() !== trendEl) { trendChart = disposeChart(trendChart); trendChart = echarts.init(trendEl); }
                trendChart.setOption({ legend: { data: ['投入數', '良率'], top: 8, right: 10, textStyle: { fontSize: 11, color: '#6b7280' } }, grid: { top: 64, right: 58, bottom: 44, left: 48 }, tooltip: { trigger: 'axis', formatter: params => { let text = params[0]?.axisValue || ''; params.forEach(item => { text += `<br/>${item.marker}${item.seriesName}: <b>${item.seriesName === '良率' ? item.value + '%' : item.value.toLocaleString()}</b>`; }); return text; } }, xAxis: { type: 'category', data: result.daily.map(row => row.date.slice(5)), axisLabel: { fontSize: 10 } }, yAxis: [{ type: 'value', name: '投入', min: 0, axisLabel: { fontSize: 10, color: '#9ca3af' }, splitLine: { lineStyle: { color: '#f3f4f6' } } }, { type: 'value', name: '良率', min: 0, max: 100, axisLabel: { formatter: '{value}%', fontSize: 10 }, splitLine: { show: false } }], series: [{ name: '投入數', type: 'bar', data: result.daily.map(row => row.input), barMaxWidth: 24, itemStyle: { color: '#c4b5fd', borderRadius: [4, 4, 0, 0] } }, { name: '良率', type: 'line', yAxisIndex: 1, data: result.daily.map(row => Number(row.yieldRate)), smooth: true, symbol: 'circle', symbolSize: 6, lineStyle: { color: '#2563eb', width: 2.5 }, itemStyle: { color: '#2563eb' }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(37,99,235,0.16)' }, { offset: 1, color: 'rgba(37,99,235,0)' }] } }, label: { show: true, position: 'top', formatter: '{c}%', fontSize: 9 } }] });
            } else trendChart = disposeChart(trendChart);
        });
    };
    dafModelMappings.value = readModelMappings();
    dafBatches.value = deduplicateDafBatches(readStorage()).batches;
    learnModelMappings(dafBatches.value);
    watch(() => [dafStatsFilter.value.start, dafStatsFilter.value.end], () => { if (!applyingDafQuick) dafQuickMode.value = null; });
    watch(() => dafStatsResult.value, () => { if (currentTab.value === 'stats' && isDafLikeLine()) renderDafCharts(); });
    watch(currentTab, tab => {
        if (!isDafLikeLine()) return;
        if (tab === 'stats' && !dafStatsResult.value) calculateDafStats(false);
        else if (tab === 'stats' || tab === 'report') renderDafCharts();
    });
    watch(currentLine, line => {
        if (['DAF', 'FT1', 'FT2'].includes(line)) {
            dafStatsFilter.value = { start: '', end: '', model: 'all', workOrder: 'all' };
            dafQuickMode.value = null;
            dafQuickOffset.value = 0;
            dafUploadSummary.value = { files: 0, rows: 0, duplicates: 0, failed: [] };
            dafLastUpload.value = null;
            dafStatsResult.value = null;
            if (currentTab.value === 'stats') calculateDafStats(false);
        }
    });
    window.addEventListener('resize', () => { if (reasonChart) reasonChart.resize(); if (trendChart) trendChart.resize(); });

    return {
        dafBatches, dafBatchesByDate, dafStatsFilter, dafStatsResult, dafRemoteReady, dafRemoteError, dafLastUpload, dafUploadSummary,
        dafModelOptions, dafWorkOrderOptions, dafUnknownModelModal, dafDefectDetail, dafQuickMode, dafQuickLabel, dafQuickRelative,
        uploadDafFiles, loadDafData, calculateDafStats, exportDafStats, deleteDafBatch, resolveDafUnknownModel, cancelDafUnknownModel,
        openDafDefectDetail, closeDafDefectDetail, dafModelDetail, openDafModelStatsDetail, closeDafModelStatsDetail, dafWorkOrderDetail, openDafWorkOrderStatsDetail, closeDafWorkOrderStatsDetail, dafOutputDetail, openDafOutputDetail, closeDafOutputDetail, setDafQuickMode, shiftDafQuick,
        getDafUploadedDates, getDafDashboardForDate,
        renderDafCharts
    };
};
