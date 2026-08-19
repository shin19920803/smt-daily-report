window.SMT = window.SMT || {};

// DAF／FT1／FT2／組裝檔案統計：新上傳格式統一使用 B／D／E／F／H／I；舊批次保留原本的 C／E／F／G／I／J 解析結果。
SMT.daf = function (ctx) {
    const { toast, loading, currentLine, currentLineMeta, currentTab, data, loadBaseData } = ctx;
    const REMOTE_TABLE = 'daf_log_batches';
    const SHARED_STATS_STATE_ID = '__koya_shared_daf_stats_state_v1__';
    const SHARED_STATS_STATE_LINE = '__STATS_STATE__';
    const REMOTE_SUMMARY_COLUMNS = 'id,line,file_name,uploaded_at,model_name,product_code,work_order,report_date,date_start,date_end,input_count,good_count,fail_count,yield_rate,defect_rate,unknown_status_count,unknown_status_text,row_count,raw_column_count';
    const REMOTE_DETAIL_COLUMNS = `${REMOTE_SUMMARY_COLUMNS},records`;
    // 非 SMT 站別共用機種對應；保留舊鍵讀取，避免既有使用者的對應遺失。
    const MODEL_MAPPING_STORAGE_KEY = 'koya_non_smt_model_mappings_v1';
    const LEGACY_MODEL_MAPPING_STORAGE_KEYS = [
        'koya_daf_model_mappings_v1',
        'koya_ft1_model_mappings_v1',
        'koya_ft2_model_mappings_v1',
        'koya_assembly_model_mappings_v1',
        'koya_lighting_model_mappings_v1'
    ];
    const LEGACY_COLUMNS = Object.freeze({ workOrder: 2, productCode: 4, dedupKey: 5, date: 6, defect: 8, status: 9, minColumns: 10 });
    const CURRENT_COLUMNS = Object.freeze({ process: 0, workOrder: 1, productCode: 3, dedupKey: 4, date: 5, machineOperator: 6, defect: 7, status: 8, minColumns: 9 });
    const DAF_MACHINE_LABELS = Object.freeze(['1號機', '2號機']);
    const DAF_MACHINE_UNKNOWN = '未分類機台';
    const DAF_MACHINE_REFERENCE_LINE = '__DAF_MACHINE_REFERENCE__';
    const DAF_MACHINE_REFERENCE_PREFIX = '__DAF_MACHINE_REF__';
    const DAF_MACHINE_REFERENCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    const DAF_MACHINE_CLASSIFICATION_VERSION = 'ft1-machine-v3';
    const MODEL_MAPPING_REMOTE_LINE = '__KOYA_MODEL_MAPPING__';
    const MODEL_MAPPING_REMOTE_PREFIX = '__KOYA_MODEL_MAPPING__';
    const CURRENT_SOURCE_FORMAT = 'current-v2';
    const LEGACY_SOURCE_FORMAT = 'legacy-v1';
    const TEST_PROCESS_OPTIONS = SMT.TEST_PROCESSES || [
        { id: 'DAF', label: 'DAF外觀檢查', shortLabel: 'DAF' },
        { id: 'FT1', label: '功能一測試', shortLabel: 'FT1' },
        { id: 'FT2', label: '功能二測試', shortLabel: 'FT2' },
        { id: 'LIGHTING', label: '外觀檢查點亮測試', shortLabel: '點亮測試' },
        { id: 'ASSEMBLY', label: '輝度機測試', shortLabel: '輝度機' }
    ];
    const TEST_PROCESS_IDS = TEST_PROCESS_OPTIONS.map(item => item.id);
    const TEST_PROCESS_STORAGE_KEY = 'koya_test_process_v1';
    const readStoredTestProcess = () => {
        try {
            const saved = localStorage.getItem(TEST_PROCESS_STORAGE_KEY);
            if (TEST_PROCESS_IDS.includes(saved)) return saved;
            const legacyLine = localStorage.getItem(SMT.LINE_KEY);
            return TEST_PROCESS_IDS.includes(legacyLine) ? legacyLine : 'DAF';
        } catch (e) { return 'DAF'; }
    };
    const dafProcess = ref(readStoredTestProcess());
    const dafProcessMeta = computed(() => TEST_PROCESS_OPTIONS.find(item => item.id === dafProcess.value) || TEST_PROCESS_OPTIONS[0]);
    const isUnifiedTestLine = () => currentLine.value === 'TEST';
    const isDafLikeLine = () => isUnifiedTestLine() || TEST_PROCESS_IDS.includes(currentLine.value);
    const currentDafLine = () => isUnifiedTestLine() ? dafProcess.value : (isDafLikeLine() ? currentLine.value : 'DAF');
    const currentDafColumns = () => CURRENT_COLUMNS;
    const recordColumns = record => record?.sourceFormat === CURRENT_SOURCE_FORMAT || currentDafLine() === 'FT1' ? CURRENT_COLUMNS : LEGACY_COLUMNS;
    const currentDafMappingStorageKey = () => MODEL_MAPPING_STORAGE_KEY;
    const currentDafLabel = () => isUnifiedTestLine() ? dafProcessMeta.value.label : currentLineMeta.value.label;
    const processLabel = line => TEST_PROCESS_OPTIONS.find(item => item.id === line)?.label || line;
    const defaultDafDefect = processLine => processLine === 'FT2' ? '偵測失效' : '未填寫不良原因';
    const isMachineClassifiedProcess = processLine => processLine === 'DAF' || processLine === 'FT1';
    const detectDafMachine = value => {
        const operator = normalizeText(value).replace(/[^A-Z0-9]/g, '');
        if (operator.includes('Y0176')) return '1號機';
        if (operator.includes('Y0137')) return '2號機';
        return '';
    };
    const isDafMachineReference = value => normalizeText(value).replace(/\s+/g, '').includes('DAF熱壓投入');
    const dafMachineForRecord = record => record?.machine || DAF_MACHINE_UNKNOWN;
    const isDafMachineLabel = value => DAF_MACHINE_LABELS.includes(value);
    const dafMachineReferenceId = key => `${DAF_MACHINE_REFERENCE_PREFIX}${encodeURIComponent(key)}`;
    const toDafMachineReferenceRemote = reference => ({
        id: dafMachineReferenceId(reference.dedupKey), line: DAF_MACHINE_REFERENCE_LINE,
        file_name: 'DAF熱壓投入待比對資料', uploaded_at: reference.capturedAt,
        model_name: null, product_code: null, work_order: null, report_date: null,
        date_start: null, date_end: null, input_count: 0, good_count: 0, fail_count: 0,
        yield_rate: 0, defect_rate: 0, unknown_status_count: 0, unknown_status_text: null,
        row_count: 1, raw_column_count: 0, records: [reference]
    });
    const normalizeDafMachineReference = row => {
        const reference = Array.isArray(row?.records) ? row.records[0] : row?.records;
        const dedupKey = normalizeText(reference?.dedupKey);
        const machine = cleanText(reference?.machine);
        const capturedAt = reference?.capturedAt || row?.uploaded_at || '';
        const capturedTime = Date.parse(capturedAt);
        if (!dedupKey || !isDafMachineLabel(machine) || !Number.isFinite(capturedTime)) return null;
        return {
            id: row.id || dafMachineReferenceId(dedupKey), dedupKey, machine,
            capturedAt: new Date(capturedTime).toISOString(), sourceFile: cleanText(reference?.sourceFile || row?.file_name)
        };
    };
    const deleteDafMachineReferenceRows = async ids => {
        const uniqueIds = [...new Set((ids || []).filter(Boolean))];
        for (let index = 0; index < uniqueIds.length; index += 100) {
            const chunk = uniqueIds.slice(index, index + 100);
            const { error } = await _supabase.from(REMOTE_TABLE).delete().eq('line', DAF_MACHINE_REFERENCE_LINE).in('id', chunk);
            if (error) return false;
        }
        return true;
    };
    const loadDafMachineReferences = async () => {
        const rows = [];
        for (let offset = 0; ; offset += 1000) {
            const { data: page, error } = await _supabase.from(REMOTE_TABLE)
                .select('id,uploaded_at,file_name,records').eq('line', DAF_MACHINE_REFERENCE_LINE)
                .order('uploaded_at', { ascending: true }).range(offset, offset + 999);
            if (error) return { map: new Map(), error };
            rows.push(...(page || []));
            if (!page || page.length < 1000) break;
        }
        const machineReferences = new Map();
        const expiredIds = [];
        const expiresBefore = Date.now() - DAF_MACHINE_REFERENCE_TTL_MS;
        rows.forEach(row => {
            const reference = normalizeDafMachineReference(row);
            if (!reference) return;
            if (Date.parse(reference.capturedAt) <= expiresBefore) expiredIds.push(reference.id);
            else machineReferences.set(reference.dedupKey, reference);
        });
        if (expiredIds.length) await deleteDafMachineReferenceRows(expiredIds);
        dafMachineReferenceCache.clear();
        machineReferences.forEach((reference, key) => dafMachineReferenceCache.set(key, reference));
        return { map: dafMachineReferenceCache, error: null };
    };
    const persistDafMachineReferences = async ({ references = [], matchedKeys = [], storedMap = new Map() } = {}) => {
        const matched = new Set(matchedKeys || []);
        const matchedIds = [...matched].map(key => storedMap.get(key)?.id).filter(Boolean);
        const referencesToStore = (references || []).filter(reference => isDafMachineLabel(reference.machine) && !matched.has(reference.dedupKey));
        if (matchedIds.length && !(await deleteDafMachineReferenceRows(matchedIds))) return false;
        if (referencesToStore.length) {
            const { error } = await _supabase.from(REMOTE_TABLE)
                .upsert(referencesToStore.map(toDafMachineReferenceRemote), { onConflict: 'id' });
            if (error) return false;
        }
        matched.forEach(key => storedMap.delete(key));
        referencesToStore.forEach(reference => storedMap.set(reference.dedupKey, { ...reference, id: dafMachineReferenceId(reference.dedupKey) }));
        dafMachineReferenceCache.clear();
        storedMap.forEach((reference, key) => dafMachineReferenceCache.set(key, reference));
        return true;
    };
    const TEST_PROCESS_ALIASES = Object.freeze({
        DAF: 'DAF', 'DAF外觀檢查': 'DAF',
        FT1: 'FT1', '功能一測試': 'FT1',
        FT2: 'FT2', '功能二測試': 'FT2',
        LIGHTING: 'LIGHTING', '點亮測試': 'LIGHTING', '外觀檢查點亮測試': 'LIGHTING',
        ASSEMBLY: 'ASSEMBLY', '輝度機': 'ASSEMBLY', '輝度機測試': 'ASSEMBLY'
    });
    const detectTestProcess = value => {
        const text = normalizeText(value).replace(/\s+/g, '');
        return text ? TEST_PROCESS_ALIASES[text] || null : null;
    };
    const setDafProcess = line => {
        if (!TEST_PROCESS_IDS.includes(line)) return;
        dafProcess.value = line;
        dafStatsResult.value = dafStatsResults.value[line] || null;
        try { localStorage.setItem(TEST_PROCESS_STORAGE_KEY, line); } catch (e) {}
        closeDafDefectDetail();
        closeDafModelStatsDetail();
        closeDafWorkOrderStatsDetail();
        closeDafOutputDetail();
        if (ctx.refreshDashboard) Promise.resolve(ctx.refreshDashboard()).then(() => ctx.initDashboardCharts?.());
    };

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
    // 儀表板只使用 Supabase 摘要；完整 records 僅在統計／明細明確載入時放入 dafBatches。
    const dafSummaryBatches = ref([]);
    const dafStatsFilter = ref({ start: '', end: '', model: 'all', workOrder: 'all' });
    const DAF_STATS_STATE_KEY = 'koya_test_stats_state_v1';
    const dafStatsResult = ref(null);
    const dafStatsResults = ref({});
    // 已載入的大日期區間可涵蓋較小區間；切換日期或製程時直接重算，不重抓明細。
    const dafStatsRangeCache = new Map();
    const dafStatsLoading = ref(false);
    let dafStatsLoadingCount = 0;
    let dafSharedStatsUpdatedAt = '';
    let dafSharedStatsLoadPromise = null;
    let dafSharedStatsForceQueued = false;
    let dafSharedStatsSnapshot = null;
    let applyingDafSharedStats = false;
    let dafRemoteVersions = null;
    let dafRemoteVersionsLoadedAt = 0;
    const dafRemoteReady = ref(false);
    const dafRemoteChecking = ref(false);
    const dafRemoteError = ref('');
    const dafLastUpload = ref(null);
    const dafUploadSummary = ref({ files: 0, rows: 0, duplicates: 0, referenceRows: 0, failed: [] });
    const dafModelMappings = ref({});
    const dafUnknownModelModal = ref({ show: false, fileName: '', items: [], currentIndex: 0, selectedModel: '', newModel: '' });
    const pendingDafUpload = ref(null);
    const dafDefectDetail = ref({ show: false, name: '', qty: 0, byModel: [], byWorkOrder: [], byMachine: [], dailyTrend: [] });
    const dafModelDetail = ref({ show: false, name: '', input: 0, good: 0, defects: 0, yieldRate: '0.00', byType: [], byMachine: [] });
    const dafWorkOrderDetail = ref({ show: false, workOrder: '', model: '', input: 0, good: 0, defects: 0, yieldRate: '0.00', byType: [], byModel: [], byMachine: [] });
    const dafOutputDetail = ref({ show: false, title: '', subtitle: '', result: null });
    const dafMachineReferenceCache = new Map();
    const dafQuickMode = ref(null);
    const dafQuickOffset = ref(0);
    let applyingDafQuick = false;
    const readDafStatsState = () => {
        try {
            const parsed = JSON.parse(localStorage.getItem(DAF_STATS_STATE_KEY) || '{}');
            if (parsed && typeof parsed === 'object' && ('start' in parsed || 'end' in parsed)) return parsed;
            if (parsed && typeof parsed === 'object') return parsed[dafProcess.value] || Object.values(parsed).find(item => item && typeof item === 'object') || {};
            return {};
        } catch (e) { return {}; }
    };
    const dafStatsState = readDafStatsState();
    const getYesterday = () => {
        return window.koyaShiftDate(window.koyaTodayDate(), -1);
    };
    const saveDafStatsState = () => {
        Object.assign(dafStatsState, { start: dafStatsFilter.value.start || '', end: dafStatsFilter.value.end || '', quickMode: dafQuickMode.value || null, quickOffset: Number(dafQuickOffset.value) || 0 });
        try { localStorage.setItem(DAF_STATS_STATE_KEY, JSON.stringify(dafStatsState)); } catch (e) {}
    };
    const restoreDafStatsState = () => {
        const yesterday = getYesterday();
        dafStatsFilter.value = { start: dafStatsState.start || yesterday, end: dafStatsState.end || yesterday, model: 'all', workOrder: 'all' };
        dafQuickMode.value = ['day', 'week', 'month'].includes(dafStatsState.quickMode) ? dafStatsState.quickMode : 'day';
        dafQuickOffset.value = Number.isFinite(Number(dafStatsState.quickOffset)) ? Number(dafStatsState.quickOffset) : -1;
    };
    restoreDafStatsState();

    const cleanText = (value) => {
        if (value === null || value === undefined) return '';
        if (typeof value === 'number' && Number.isNaN(value)) return '';
        return String(value).replace(/\u00a0/g, ' ').replace(/[\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
    };
    const normalizeText = (value) => cleanText(value).toUpperCase();
    const normalizeModelName = value => normalizeText(value) || '未識別機種';
    const readModelMappings = () => {
        const merged = {};
        [currentDafMappingStorageKey(), ...LEGACY_MODEL_MAPPING_STORAGE_KEYS].forEach(key => {
            try {
                const parsed = JSON.parse(localStorage.getItem(key) || '{}');
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
                Object.entries(parsed).forEach(([code, model]) => {
                    const normalizedCode = normalizeText(code);
                    const normalizedModel = normalizeModelName(model);
                    if (normalizedCode && normalizedModel !== '未識別機種' && !merged[normalizedCode]) merged[normalizedCode] = normalizedModel;
                });
            } catch (e) {}
        });
        return merged;
    };
    const persistModelMappings = () => {
        try {
            const normalized = Object.fromEntries(Object.entries(dafModelMappings.value).map(([code, model]) => [normalizeText(code), normalizeModelName(model)]));
            dafModelMappings.value = normalized;
            localStorage.setItem(currentDafMappingStorageKey(), JSON.stringify(normalized));
        } catch (e) {}
    };
    const modelMappingRemoteId = code => `${MODEL_MAPPING_REMOTE_PREFIX}${encodeURIComponent(normalizeText(code))}`;
    const modelMappingRemoteRow = (code, model) => {
        const normalizedCode = normalizeText(code);
        const normalizedModel = normalizeModelName(model);
        return {
            id: modelMappingRemoteId(normalizedCode), line: MODEL_MAPPING_REMOTE_LINE,
            file_name: '非 SMT 製程機種對應記憶', uploaded_at: new Date().toISOString(),
            model_name: normalizedModel, product_code: normalizedCode, work_order: null,
            report_date: null, date_start: null, date_end: null, input_count: 0,
            good_count: 0, fail_count: 0, yield_rate: 0, defect_rate: 0,
            unknown_status_count: 0, unknown_status_text: null, row_count: 1,
            raw_column_count: 0, records: [{ productCode: normalizedCode, model: normalizedModel }]
        };
    };
    const saveRemoteModelMapping = async (code, model) => {
        const normalizedCode = normalizeText(code);
        const normalizedModel = normalizeModelName(model);
        if (!normalizedCode || normalizedModel === '未識別機種' || !_supabase) return false;
        const { data, error } = await _supabase.from(REMOTE_TABLE)
            .upsert(modelMappingRemoteRow(normalizedCode, normalizedModel), { onConflict: 'id' })
            .select('id').maybeSingle();
        if (error || data?.id !== modelMappingRemoteId(normalizedCode)) {
            console.warn('機種對應記憶寫入 Supabase 失敗', error || '未確認寫入');
            return false;
        }
        return true;
    };
    const loadRemoteModelMappings = async () => {
        if (!_supabase) return false;
        const rows = [];
        for (let offset = 0; ; offset += 1000) {
            const { data: page, error } = await _supabase.from(REMOTE_TABLE)
                .select('id,product_code,model_name,records')
                .eq('line', MODEL_MAPPING_REMOTE_LINE)
                .order('uploaded_at', { ascending: false })
                .range(offset, offset + 999);
            if (error) {
                console.warn('機種對應記憶讀取 Supabase 失敗', error);
                return false;
            }
            rows.push(...(page || []));
            if (!page || page.length < 1000) break;
        }
        const remoteMappings = {};
        rows.forEach(row => {
            const record = Array.isArray(row.records) ? row.records[0] : row.records;
            const code = normalizeText(row.product_code || record?.productCode);
            const model = normalizeModelName(row.model_name || record?.model);
            if (code && model !== '未識別機種' && !remoteMappings[code]) remoteMappings[code] = model;
        });
        const localMappings = readModelMappings();
        const merged = { ...localMappings, ...remoteMappings };
        dafModelMappings.value = merged;
        persistModelMappings();
        const remoteCodes = new Set(Object.keys(remoteMappings));
        await Promise.all(Object.entries(localMappings)
            .filter(([code, model]) => !remoteCodes.has(code))
            .map(([code, model]) => saveRemoteModelMapping(code, model)));
        return true;
    };
    let dafModelMappingsReadyPromise = null;
    const ensureDafModelMappingsReady = () => {
        if (!dafModelMappingsReadyPromise) {
            dafModelMappingsReadyPromise = loadRemoteModelMappings().catch(error => {
                dafModelMappingsReadyPromise = null;
                console.warn('機種對應記憶初始化失敗，沿用本機既有設定', error);
                return false;
            });
        }
        return dafModelMappingsReadyPromise;
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
        const columns = recordColumns(record);
        const mappedModel = resolveDafModel(record.productCode || raw[columns.productCode]);
        const hasStoredTime = record.dedupTime !== null && record.dedupTime !== undefined && record.dedupTime !== '';
        const parsedTime = hasStoredTime && Number.isFinite(Number(record.dedupTime))
            ? Number(record.dedupTime)
            : (parseDateTime(raw[columns.date])?.getTime() || null);
        return {
            ...record,
            model: mappedModel !== '未識別機種' ? mappedModel : normalizeModelName(record.model),
            machine: cleanText(record.machine),
            dedupKey: normalizeText(record.dedupKey || raw[columns.dedupKey] || ''),
            dedupTime: parsedTime
        };
    };
    const normalizeBatchModels = batch => {
        const sourceFormat = batch.sourceFormat || (batch.line === 'FT1' ? CURRENT_SOURCE_FORMAT : LEGACY_SOURCE_FORMAT);
        const records = (batch.records || []).map(record => normalizeDafRecord({ ...record, sourceFormat: record.sourceFormat || sourceFormat }));
        return {
            ...batch,
            sourceFormat,
            machine: '',
            modelName: normalizeModelName(batch.modelName),
            records
        };
    };
    const deduplicateRows = rows => {
        const columns = currentDafColumns();
        const grouped = new Map();
        const passthrough = [];
        rows.forEach((row, index) => {
            const key = normalizeText(row[columns.dedupKey]);
            if (!key) {
                passthrough.push({ row, index });
                return;
            }
            const parsedTime = parseDateTime(row[columns.date]);
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
        const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
        const minColumns = currentDafColumns().minColumns;
        if (columnCount < minColumns) throw new Error(`${currentDafLabel()} 檔案目前只有 ${columnCount} 欄，至少需要 ${minColumns} 欄才能讀取狀態欄`);
        return { rows, columnCount };
    };

    const findDafModelMatch = value => {
        const normalized = normalizeText(value);
        if (!normalized) return null;
        const dynamicEntries = Object.entries(dafModelMappings.value).sort((a, b) => b[0].length - a[0].length);
        return MAPPING_ENTRIES.find(([productCode]) => normalized.includes(productCode))
            || dynamicEntries.find(([productCode]) => normalized.includes(productCode))
            || null;
    };
    const resolveDafModel = value => {
        const match = findDafModelMatch(value);
        return match ? normalizeModelName(match[1]) : '未識別機種';
    };
    const detectModel = (rows) => {
        const columns = currentDafColumns();
        const rawValues = [...new Map(rows.map(row => {
            const raw = cleanText(row[columns.productCode]);
            return [normalizeText(raw), raw];
        }).filter(([key, raw]) => key && !/產品|料號|product\s*code|part\s*number|型號|model/i.test(raw))).values()];
        const matched = [];
        const unknownProductCodes = [];
        rawValues.forEach(raw => {
            const match = findDafModelMatch(raw);
            if (match && !matched.some(item => item.productCode === match[0])) matched.push({ productCode: match[0], model: normalizeModelName(match[1]) });
            if (!match) unknownProductCodes.push(raw);
        });
        const unknownWorkOrders = new Map(unknownProductCodes.map(code => [normalizeText(code), new Set()]));
        rows.forEach(row => {
            const code = normalizeText(row[columns.productCode]);
            const workOrder = cleanText(row[columns.workOrder]);
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
        const columns = currentDafColumns();
        const dates = rows.map(row => parseDate(row[columns.date])).filter(Boolean).sort();
        if (!dates.length) return { display: '未識別日期', start: '', end: '', dates: [] };
        const start = dates[0];
        const end = dates[dates.length - 1];
        return { display: start === end ? start : `${start}～${end}`, start, end, dates: [...new Set(dates)] };
    };
    const analyzeFile = async (file, storedMachineReferences = new Map()) => {
        const columns = currentDafColumns();
        const { rows: sourceRows, columnCount } = await readFileRows(file);
        const dataRows = sourceRows.slice(1);
        const dafMachineByKey = new Map([...storedMachineReferences].map(([key, reference]) => [key, reference.machine]));
        const fileMachineReferences = new Map();
        const matchedMachineReferenceKeys = new Set();
        const capturedAt = new Date().toISOString();
        dataRows.forEach(row => {
            if (!isDafMachineReference(row[columns.process])) return;
            const key = normalizeText(row[columns.dedupKey]);
            const machine = detectDafMachine(row[columns.machineOperator]);
            if (!key || !machine) return;
            const previous = dafMachineByKey.get(key);
            const resolvedMachine = previous && previous !== machine ? DAF_MACHINE_UNKNOWN : machine;
            dafMachineByKey.set(key, resolvedMachine);
            fileMachineReferences.set(key, { dedupKey: key, machine: resolvedMachine, capturedAt, sourceFile: file.name });
        });
        const groupedRows = new Map();
        dataRows.forEach(row => {
            const processLine = detectTestProcess(row[0]);
            if (!processLine) return;
            const rows = groupedRows.get(processLine) || [];
            rows.push(row);
            groupedRows.set(processLine, rows);
        });
        const machineReferences = [...fileMachineReferences.values()].filter(reference => isDafMachineLabel(reference.machine));
        if (!groupedRows.size && !machineReferences.length) throw new Error('檔案沒有可辨識的製程資料，請確認 A 欄內容');
        const buildBatch = (processLine, sourceRowsForProcess) => {
            const rows = deduplicateRows(sourceRowsForProcess);
            const duplicateCount = sourceRowsForProcess.length - rows.length;
            const model = detectModel(rows);
            const dateRange = detectDateRange(rows);
            const statuses = rows.map(row => normalizeText(row[columns.status]));
            const goodCount = statuses.filter(status => status === 'GOOD').length;
            const failCount = statuses.filter(status => status === 'FAIL').length;
            const inputCount = goodCount + failCount;
            const unknownStatuses = [...new Set(statuses.filter(status => status && !['GOOD', 'FAIL'].includes(status)))];
            const workOrders = [...new Set(rows.map(row => cleanText(row[columns.workOrder])).filter(Boolean))];
            const workOrderDisplay = workOrders.length ? workOrders.join('、') : '未識別工單';
            const workOrderFileName = workOrders.length === 1 ? workOrders[0] : workOrders.length ? `${workOrders[0]}等${workOrders.length}筆工單` : '未識別工單';
            const records = rows.map(row => {
                const status = normalizeText(row[columns.status]);
                const parsedDateTime = parseDateTime(row[columns.date]);
                const parsedDate = parsedDateTime ? fmtDate(parsedDateTime) : '';
                const isDefect = status === 'FAIL';
                const dedupKey = normalizeText(row[columns.dedupKey]);
                const dafMachine = dafMachineByKey.get(dedupKey);
                if (processLine === 'DAF' && isDafMachineLabel(dafMachine)) matchedMachineReferenceKeys.add(dedupKey);
                return {
                    workOrder: cleanText(row[columns.workOrder]) || '未識別工單',
                    productCode: cleanText(row[columns.productCode]),
                    dedupKey,
                    dedupTime: parsedDateTime ? parsedDateTime.getTime() : null,
                    date: parsedDate,
                    defect: isDefect ? (cleanText(row[columns.defect]) || defaultDafDefect(processLine)) : '',
                    status,
                    model: resolveDafModel(row[columns.productCode]),
                    sourceFormat: CURRENT_SOURCE_FORMAT,
                    machine: isMachineClassifiedProcess(processLine)
                        ? (isDafMachineLabel(dafMachine)
                            ? dafMachine
                            : DAF_MACHINE_UNKNOWN)
                        : '',
                    inputIncluded: ['GOOD', 'FAIL'].includes(status),
                    isDefect,
                    raw: Array.from({ length: columnCount }, (_, index) => displayCell(row[index]))
                };
            });
            return {
                id: `${Date.now()}_${processLine}_${Math.random().toString(36).slice(2, 9)}`,
                line: processLine,
                sourceFormat: CURRENT_SOURCE_FORMAT,
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
                rawRowCount: sourceRowsForProcess.length,
                records
            };
        };
        const batches = [...groupedRows.entries()].map(([processLine, rows]) => buildBatch(processLine, rows));
        batches.machineReferences = machineReferences;
        batches.matchedMachineReferenceKeys = matchedMachineReferenceKeys;
        return batches;
    };

    const toRemote = (batch) => ({
        id: batch.id, line: batch.line || currentDafLine(), file_name: batch.fileName, uploaded_at: batch.uploadedAt,
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
    const isGhostDafRow = row => Number(row?.row_count) > 0 && Number(row?.input_count || 0) === 0 && Number(row?.good_count || 0) === 0 && Number(row?.fail_count || 0) === 0;
    const filterGhostDafRows = rows => (rows || []).filter(row => !isGhostDafRow(row));
    const saveRemote = async (batch) => {
        if (!dafRemoteReady.value) return false;
        const { data, error } = await _supabase.from(REMOTE_TABLE).upsert(toRemote(batch), { onConflict: 'id' }).select('id').maybeSingle();
        if (error || !data?.id) { dafRemoteError.value = error?.message || `${currentDafLabel()} 共用資料庫未確認寫入`; return false; }
        return data.id === batch.id;
    };
    const deleteRemote = async (id, batchOverride = null) => {
        if (!dafRemoteReady.value) return false;
        const batch = batchOverride || dafBatches.value.find(item => item.id === id);
        const line = batch?.line || currentDafLine();
        const { error } = await _supabase.from(REMOTE_TABLE).delete().eq('id', id).eq('line', line);
        if (error) { toast(`${currentDafLabel()} 共用資料庫刪除失敗：` + error.message, 'error'); return false; }
        const { data: remaining, error: verifyError } = await _supabase.from(REMOTE_TABLE)
            .select('id').eq('id', id).eq('line', line).limit(1);
        if (verifyError) {
            toast(`${currentDafLabel()} 刪除後無法確認共用資料庫狀態：` + verifyError.message, 'error');
            return false;
        }
        if (remaining?.length) {
            toast(`${currentDafLabel()} 共用資料庫仍保留此檔案，未更新畫面`, 'error');
            return false;
        }
        return true;
    };
    const getDafSummaryCacheUrl = path => {
        const base = String(window.KOYA_DATA_CACHE_URL || '').replace(/\/$/, '');
        return base ? `${base}${path}` : '';
    };
    const invalidateDafSummaryCache = async () => {
        const url = getDafSummaryCacheUrl('/api/daf-summary/invalidate');
        if (!url) return false;
        try {
            const response = await fetch(url, { method: 'POST' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return true;
        } catch (error) {
            console.warn('Cloudflare 摘要快取清除失敗，改由 Supabase 直讀', error);
            return false;
        }
    };
    const loadDafSummaryRows = async (line, force = false) => {
        const base = getDafSummaryCacheUrl('/api/daf-summary');
        if (!base) return null;
        try {
            const url = new URL(base);
            url.searchParams.set('line', line);
            if (force) url.searchParams.set('refresh', '1');
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (!Array.isArray(data)) throw new Error('摘要格式錯誤');
            return { data, error: null };
        } catch (error) {
            console.warn(`${processLabel(line)} Cloudflare 摘要讀取失敗，改由 Supabase 直讀`, error);
            return null;
        }
    };
    const loadDafDetailRows = async (line, start = '', end = '', force = false) => {
        if (!window.koyaFetchCachedJson) return null;
        try {
            const params = new URLSearchParams({ line });
            if (start) params.set('start', start);
            if (end) params.set('end', end);
            const data = await window.koyaFetchCachedJson(`/api/daf-details?${params.toString()}`, { force });
            if (!Array.isArray(data)) throw new Error('明細格式錯誤');
            return { data, error: null };
        } catch (error) {
            console.warn(`${processLabel(line)} Cloudflare 明細讀取失敗，改由 Supabase 直讀`, error);
            return null;
        }
    };
    const loadDafVersions = async (force = false) => {
        if (!force && dafRemoteVersions && Date.now() - dafRemoteVersionsLoadedAt < 60000) return dafRemoteVersions;
        if (!window.koyaFetchCachedJson) return null;
        try {
            const lines = TEST_PROCESS_IDS.join(',');
            const data = await window.koyaFetchCachedJson(`/api/daf-version?lines=${encodeURIComponent(lines)}`, { force });
            if (!data?.versions) throw new Error('版本資訊格式錯誤');
            dafRemoteVersions = data.versions;
            dafRemoteVersionsLoadedAt = Date.now();
            return dafRemoteVersions;
        } catch (error) {
            console.warn('測試製程版本資訊讀取失敗，改用既有快取', error);
            return null;
        }
    };
    const sameDafVersions = (left, right) => {
        if (!left || !right) return false;
        return TEST_PROCESS_IDS.every(line => left[line]?.version && left[line].version === right[line]?.version);
    };
    const stripSharedDafResult = result => {
        if (!result) return null;
        const { rows, ...summary } = result;
        return JSON.parse(JSON.stringify({ ...summary, rows: [], sharedSnapshot: true }));
    };
    const mergeSharedQtyRows = (target, rows, keyName = 'name') => {
        (rows || []).forEach(row => {
            const key = row?.[keyName] || row?.name;
            if (!key) return;
            target[key] = (target[key] || 0) + (Number(row.qty) || 0);
        });
    };
    const mergeSharedDetailRows = (target, rows) => {
        (rows || []).forEach(row => {
            const key = row?.name || row?.workOrder;
            if (!key) return;
            const item = target[key] || (target[key] = { qty: 0, byModel: {}, byWorkOrder: {}, byMachine: {} });
            item.qty += Number(row.qty) || 0;
            mergeSharedQtyRows(item.byModel, row.byModel);
            mergeSharedQtyRows(item.byWorkOrder, row.byWorkOrder);
            mergeSharedQtyRows(item.byMachine, row.byMachine);
        });
    };
    const mergeSharedAggregateRows = (target, rows) => {
        (rows || []).forEach(row => {
            const key = row?.name || row?.workOrder;
            if (!key) return;
            const item = target[key] || (target[key] = { input: 0, good: 0, defects: 0, byType: {}, byModel: {}, byWorkOrder: {}, byMachine: {} });
            item.input += Number(row.input) || 0;
            item.good += Number(row.good) || 0;
            item.defects += Number(row.defects) || 0;
            mergeSharedDetailRows(item.byType, row.byType);
            mergeSharedDetailRows(item.byModel, row.byModel);
            mergeSharedDetailRows(item.byWorkOrder, row.byWorkOrder);
            mergeSharedAggregateRows(item.byMachine, row.byMachine);
        });
    };
    const sharedQtyRows = (map, total) => Object.entries(map || {})
        .map(([name, qty]) => ({ name, qty, ratio: mapRate(qty, total) }))
        .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name, 'zh-Hant'));
    const sharedDetailRows = (map, total) => Object.entries(map || {})
        .map(([name, value]) => ({ name, qty: value.qty, ratio: mapRate(value.qty, total), byModel: sharedQtyRows(value.byModel, value.qty), byWorkOrder: sharedQtyRows(value.byWorkOrder, value.qty), byMachine: sharedQtyRows(value.byMachine, value.qty) }))
        .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name, 'zh-Hant'));
    const sharedAggregateRows = (map, totalDefects) => Object.entries(map || {})
        .map(([name, value]) => ({ name, input: value.input, good: value.good, defects: value.defects, yieldRate: mapRate(value.good, value.input), defectRate: mapRate(value.defects, value.input), ratio: mapRate(value.defects, totalDefects) }))
        .sort((a, b) => b.defects - a.defects || b.input - a.input);
    const mergeSharedDafResults = summaries => {
        const typeMap = {};
        const modelMap = {};
        const workOrderMap = {};
        const machineMap = {};
        const sourceFiles = new Set();
        const unknownStatuses = new Set();
        let totalInput = 0;
        let totalGood = 0;
        let totalDefects = 0;
        let totalRows = 0;
        let unknownStatusCount = 0;
        const daily = [];
        (summaries || []).forEach(summary => {
            if (!summary) return;
            totalInput += Number(summary.totalInput) || 0;
            totalGood += Number(summary.totalGood) || 0;
            totalDefects += Number(summary.totalDefects) || 0;
            totalRows += Number(summary.totalRows) || 0;
            unknownStatusCount += Number(summary.unknownStatusCount) || 0;
            String(summary.unknownStatusText || '').split('、').filter(text => text && text !== '無').forEach(text => unknownStatuses.add(text));
            (summary.sourceFiles || []).forEach(file => sourceFiles.add(file));
            daily.push(...(summary.daily || []));
            (summary.byType || []).forEach(row => {
                const target = typeMap[row.name] || (typeMap[row.name] = { qty: 0, byModel: {}, byWorkOrder: {}, byMachine: {} });
                target.qty += Number(row.qty) || 0;
                mergeSharedQtyRows(target.byModel, row.byModel);
                mergeSharedQtyRows(target.byWorkOrder, row.byWorkOrder);
                mergeSharedQtyRows(target.byMachine, row.byMachine);
            });
            (summary.byModel || []).forEach(row => {
                const target = modelMap[row.name] || (modelMap[row.name] = { input: 0, good: 0, defects: 0, byType: {}, byWorkOrder: {}, byMachine: {} });
                target.input += Number(row.input) || 0;
                target.good += Number(row.good) || 0;
                target.defects += Number(row.defects) || 0;
                mergeSharedDetailRows(target.byType, row.byType);
                mergeSharedDetailRows(target.byWorkOrder, row.byWorkOrder);
                mergeSharedAggregateRows(target.byMachine, row.byMachine);
            });
            (summary.byWorkOrder || []).forEach(row => {
                const key = row.workOrder || row.name;
                const target = workOrderMap[key] || (workOrderMap[key] = { input: 0, good: 0, defects: 0, byType: {}, byModel: {}, byMachine: {} });
                target.input += Number(row.input) || 0;
                target.good += Number(row.good) || 0;
                target.defects += Number(row.defects) || 0;
                mergeSharedDetailRows(target.byType, row.byType);
                mergeSharedDetailRows(target.byModel, row.byModel);
                mergeSharedAggregateRows(target.byMachine, row.byMachine);
            });
            (summary.byMachine || []).forEach(row => {
                const key = row?.name;
                if (!key) return;
                const target = machineMap[key] || (machineMap[key] = { input: 0, good: 0, defects: 0, byType: {}, byModel: {}, byWorkOrder: {} });
                target.input += Number(row.input) || 0;
                target.good += Number(row.good) || 0;
                target.defects += Number(row.defects) || 0;
                mergeSharedDetailRows(target.byType, row.byType);
                mergeSharedAggregateRows(target.byModel, row.byModel);
                mergeSharedAggregateRows(target.byWorkOrder, row.byWorkOrder);
            });
        });
        const byType = Object.entries(typeMap).map(([name, value]) => ({
            name,
            qty: value.qty,
            inputRatio: mapRate(value.qty, totalInput),
            ratio: mapRate(value.qty, totalDefects),
            byModel: sharedQtyRows(value.byModel, value.qty),
            byWorkOrder: sharedQtyRows(value.byWorkOrder, value.qty),
            byMachine: sharedQtyRows(value.byMachine, value.qty)
        })).sort((a, b) => b.qty - a.qty);
        const byModel = Object.entries(modelMap).map(([name, value]) => ({
            name,
            input: value.input,
            good: value.good,
            defects: value.defects,
            yieldRate: mapRate(value.good, value.input),
            defectRate: mapRate(value.defects, value.input),
            ratio: mapRate(value.defects, totalDefects),
            byType: sharedDetailRows(value.byType, value.defects),
            byWorkOrder: sharedDetailRows(value.byWorkOrder, value.input),
            byMachine: sharedAggregateRows(value.byMachine, value.defects)
        })).sort((a, b) => b.defects - a.defects || b.input - a.input);
        const byWorkOrder = Object.entries(workOrderMap).map(([workOrder, value]) => ({
            workOrder,
            name: workOrder,
            model: Object.keys(value.byModel).join(' / ') || '未識別機種',
            input: value.input,
            good: value.good,
            defects: value.defects,
            yieldRate: mapRate(value.good, value.input),
            defectRate: mapRate(value.defects, value.input),
            ratio: mapRate(value.defects, totalDefects),
            byType: sharedDetailRows(value.byType, value.defects),
            byModel: sharedDetailRows(value.byModel, value.input),
            byMachine: sharedAggregateRows(value.byMachine, value.defects)
        })).sort((a, b) => b.defects - a.defects || b.input - a.input);
        const byMachine = Object.entries(machineMap).map(([name, value]) => ({
            name,
            input: value.input,
            good: value.good,
            defects: value.defects,
            yieldRate: mapRate(value.good, value.input),
            defectRate: mapRate(value.defects, value.input),
            ratio: mapRate(value.defects, totalDefects),
            byType: sharedDetailRows(value.byType, value.defects),
            byModel: sharedAggregateRows(value.byModel, value.defects),
            byWorkOrder: sharedAggregateRows(value.byWorkOrder, value.defects)
        })).sort((a, b) => b.input - a.input);
        const sortedDaily = daily.sort((a, b) => String(a.date).localeCompare(String(b.date)));
        return {
            totalInput,
            totalGood,
            totalDefects,
            yieldRate: mapRate(totalGood, totalInput),
            defectRate: mapRate(totalDefects, totalInput),
            unknownStatusCount,
            unknownStatusText: [...unknownStatuses].join('、') || '無',
            totalDays: sortedDaily.length,
            totalRows,
            sourceFiles: [...sourceFiles],
            byType,
            byModel,
            byWorkOrder,
            byMachine,
            daily: sortedDaily,
            rows: [],
            sharedSnapshot: true
        };
    };
    const createSharedDafStatsSnapshot = versions => {
        const filter = dafStatsRangeInfo();
        const results = {};
        const days = {};
        TEST_PROCESS_IDS.forEach(line => {
            const result = dafStatsResults.value[line] || buildDafStats(line);
            results[line] = stripSharedDafResult(result);
            const groupedRows = {};
            (result?.rows || []).forEach(row => {
                if (!row.date) return;
                if (!groupedRows[row.date]) groupedRows[row.date] = [];
                groupedRows[row.date].push(row);
            });
            if (Object.keys(groupedRows).length) {
                days[line] = Object.fromEntries(Object.entries(groupedRows).map(([date, rows]) => [date, stripSharedDafResult(buildDafSummary(rows, line))]));
            } else {
                days[line] = Object.fromEntries(Object.entries(dafSharedStatsSnapshot?.days?.[line] || {})
                    .filter(([date]) => (!filter.start || date >= filter.start) && (!filter.end || date <= filter.end)));
            }
        });
        return { kind: 'koya-daf-stats-snapshot-v1', machineClassificationVersion: DAF_MACHINE_CLASSIFICATION_VERSION, filter, versions: versions || null, results, days };
    };
    const sharedDafSnapshotResult = (line, filter, snapshot = dafSharedStatsSnapshot) => {
        if (!snapshot?.filter || !snapshot?.days?.[line]) return null;
        if (snapshot.filter.model !== (filter.model || 'all') || snapshot.filter.workOrder !== (filter.workOrder || 'all')) return null;
        if (!dafStatsRangeContains(snapshot.filter, dafStatsRangeInfo(filter))) return null;
        const summaries = Object.entries(snapshot.days[line])
            .filter(([date]) => (!filter.start || date >= filter.start) && (!filter.end || date <= filter.end))
            .map(([, summary]) => summary);
        return mergeSharedDafResults(summaries);
    };
    const parseSharedDafStatsState = row => {
        const state = Array.isArray(row?.records) ? row.records[0] : row?.records;
        if (!state || state.kind !== 'koya-shared-daf-stats-v1') return null;
        const start = String(state.start || '');
        const end = String(state.end || '');
        if (!start || !end || start > end) return null;
        return {
            start,
            end,
            model: String(state.model || 'all'),
            workOrder: String(state.workOrder || 'all'),
            quickMode: ['day', 'week', 'month'].includes(state.quickMode) ? state.quickMode : null,
            quickOffset: Number.isFinite(Number(state.quickOffset)) ? Number(state.quickOffset) : 0,
            updatedAt: String(state.updatedAt || row.uploaded_at || ''),
            snapshot: state.snapshot?.kind === 'koya-daf-stats-snapshot-v1' ? state.snapshot : null
        };
    };
    const saveSharedDafStatsState = async versions => {
        if (!isUnifiedTestLine()) return true;
        const updatedAt = new Date().toISOString();
        const snapshot = createSharedDafStatsSnapshot(versions);
        dafSharedStatsSnapshot = snapshot;
        const cachedEntry = dafStatsRangeCache.get(dafStatsRangeKey());
        if (cachedEntry) cachedEntry.snapshot = snapshot;
        const state = {
            kind: 'koya-shared-daf-stats-v1',
            start: dafStatsFilter.value.start || '',
            end: dafStatsFilter.value.end || '',
            model: dafStatsFilter.value.model || 'all',
            workOrder: dafStatsFilter.value.workOrder || 'all',
            quickMode: dafQuickMode.value || null,
            quickOffset: Number(dafQuickOffset.value) || 0,
            versions: versions || null,
            machineClassificationVersion: DAF_MACHINE_CLASSIFICATION_VERSION,
            snapshot,
            updatedAt
        };
        const row = {
            id: SHARED_STATS_STATE_ID,
            line: SHARED_STATS_STATE_LINE,
            file_name: '系統共用數據統計狀態',
            uploaded_at: updatedAt,
            model_name: null,
            product_code: null,
            work_order: null,
            report_date: `${state.start}～${state.end}`,
            date_start: state.start,
            date_end: state.end,
            input_count: 0,
            good_count: 0,
            fail_count: 0,
            yield_rate: 0,
            defect_rate: 0,
            unknown_status_count: 0,
            unknown_status_text: null,
            row_count: 0,
            raw_column_count: 0,
            records: [state]
        };
        dafSharedStatsUpdatedAt = updatedAt;
        const { data: saved, error } = await _supabase.from(REMOTE_TABLE).upsert(row, { onConflict: 'id' }).select('id').maybeSingle();
        if (error || saved?.id !== SHARED_STATS_STATE_ID) {
            console.warn('共用數據統計狀態保存失敗', error);
            return false;
        }
        // 統計快照更新後只清除統計快取，不清除五站摘要與明細快取。
        if (window.koyaInvalidateStatsStateCache && !(await window.koyaInvalidateStatsStateCache())) {
            // 快取服務暫時不可用時不否定已成功寫入 Supabase 的統計結果；讀取端會直讀唯一資料源。
            console.warn('共用數據統計狀態快取清除失敗，保留 Supabase 已寫入結果');
        }
        return true;
    };
    const loadSharedDafStatsState = async ({ force = false } = {}) => {
        if (!isUnifiedTestLine() || currentTab.value !== 'stats') return false;
        if (dafSharedStatsLoadPromise) {
            if (force) dafSharedStatsForceQueued = true;
            return dafSharedStatsLoadPromise;
        }
        const request = (async () => {
            let row = null;
            let error = null;
            try {
                if (window.koyaFetchCachedJson) {
                    row = await window.koyaFetchCachedJson('/api/daf-stats-state', { force });
                } else {
                    ({ data: row, error } = await _supabase.from(REMOTE_TABLE)
                        .select('uploaded_at,records')
                        .eq('id', SHARED_STATS_STATE_ID)
                        .maybeSingle());
                }
            } catch (requestError) {
                error = requestError;
            }
            if (error) {
                // Cloudflare 失敗時仍只讀這一筆 Supabase 共用快照，不回退到本機資料或完整 LOG。
                console.warn('共用數據統計狀態讀取失敗，改由 Supabase 直讀', error);
                ({ data: row, error } = await _supabase.from(REMOTE_TABLE)
                    .select('uploaded_at,records')
                    .eq('id', SHARED_STATS_STATE_ID)
                    .maybeSingle());
            }
            if (error) {
                console.warn('共用數據統計狀態讀取失敗', error);
                return false;
            }
            const state = parseSharedDafStatsState(row);
            if (!state) return false;
            if (!force && state.updatedAt === dafSharedStatsUpdatedAt && dafStatsResult.value) return true;
            dafSharedStatsUpdatedAt = state.updatedAt;
            applyingDafSharedStats = true;
            dafStatsFilter.value = { start: state.start, end: state.end, model: state.model, workOrder: state.workOrder };
            dafQuickMode.value = state.quickMode;
            dafQuickOffset.value = state.quickOffset;
            await Vue.nextTick();
            applyingDafSharedStats = false;
            saveDafStatsState();
            if (state.snapshot) {
                dafSharedStatsSnapshot = state.snapshot;
                const snapshotNeedsRefresh = state.snapshot.machineClassificationVersion !== DAF_MACHINE_CLASSIFICATION_VERSION || TEST_PROCESS_IDS.some(line => {
                    const result = state.snapshot.results?.[line];
                    return result && !result.sourceFiles?.length && dafSummaryHasDataForRange(line, state);
                });
                if (snapshotNeedsRefresh) {
                    // 共用快照可能在某站明細尚未完成時被保存為 0 筆；不能把它當成最新統計結果。
                    dafStatsRangeCache.clear();
                    dafStatsResults.value = {};
                    dafStatsResult.value = null;
                    return Boolean(await calculateDafStats(false, { refreshRemote: true, publishShared: true }));
                }
                const sharedResults = Object.fromEntries(TEST_PROCESS_IDS.map(line => [line, stripSharedDafResult(state.snapshot.results?.[line]) || mergeSharedDafResults([])]));
                const localEntry = dafStatsRangeCache.get(dafStatsRangeKey());
                const canPreserveLocalRows = Boolean(localEntry && (!state.snapshot.versions || !localEntry.versions || sameDafVersions(localEntry.versions, state.snapshot.versions)));
                const results = Object.fromEntries(TEST_PROCESS_IDS.map(line => {
                    const sharedResult = sharedResults[line];
                    const localResult = canPreserveLocalRows ? localEntry.results?.[line] : null;
                    return [line, localResult && !localResult.sharedSnapshot && Array.isArray(localResult.rows)
                        ? { ...sharedResult, rows: localResult.rows, sharedSnapshot: false }
                        : sharedResult];
                }));
                dafStatsResults.value = results;
                dafStatsResult.value = results[currentDafLine()] || null;
                dafStatsRangeCache.set(dafStatsRangeKey(), {
                    filter: dafStatsRangeInfo(),
                    versions: state.snapshot.versions || null,
                    results,
                    snapshot: state.snapshot
                });
                renderDafCharts();
                return true;
            }
            await calculateDafStats(false);
            return Boolean(dafStatsResult.value);
        })().finally(() => {
            if (dafSharedStatsLoadPromise === request) dafSharedStatsLoadPromise = null;
            applyingDafSharedStats = false;
            if (dafSharedStatsForceQueued && !dafStatsLoading.value) {
                dafSharedStatsForceQueued = false;
                queueMicrotask(() => {
                    if (currentTab.value === 'stats' && isUnifiedTestLine()) void loadSharedDafStatsState({ force: true });
                });
            }
        });
        dafSharedStatsLoadPromise = request;
        return request;
    };
    const loadDafRemoteRows = async (line = currentDafLine(), includeRecords = false, { force = false, start = '', end = '' } = {}) => {
        if (!includeRecords) {
            const cachedResult = await loadDafSummaryRows(line, force);
            if (cachedResult) return cachedResult;
        } else {
            const cachedResult = await loadDafDetailRows(line, start, end, force);
            const cachedRows = cachedResult?.data || [];
            const cachedDetailLooksIncomplete = cachedResult && !cachedRows.length && dafSummaryHasDataForRange(line, { start, end });
            if (cachedResult && !cachedDetailLooksIncomplete) return cachedResult;
            if (cachedDetailLooksIncomplete && !force) {
                const refreshedResult = await loadDafDetailRows(line, start, end, true);
                if (refreshedResult) return refreshedResult;
            }
            if (cachedResult) return cachedResult;
        }
        let pageSize = includeRecords ? 3 : 100;
        const rows = [];
        let offset = 0;
        for (;;) {
            let query = _supabase.from(REMOTE_TABLE)
                .select(includeRecords ? REMOTE_DETAIL_COLUMNS : REMOTE_SUMMARY_COLUMNS).eq('line', line).order('uploaded_at', { ascending: false });
            if (includeRecords && start) query = query.gte('date_end', start);
            if (includeRecords && end) query = query.lte('date_start', end);
            const { data: page, error } = await query.range(offset, offset + pageSize - 1);
            if (error) {
                if (pageSize > 1 && /timeout|statement/i.test(error.message || '')) {
                    pageSize = 1;
                    continue;
                }
                return { data: rows, error };
            }
            rows.push(...(page || []));
            if (!page || page.length < pageSize) return { data: rows, error: null };
            offset += page.length;
        }
    };
    const rebuildDafBatch = batch => {
        const hasRecords = Array.isArray(batch.records) && batch.records.length > 0;
        if (!hasRecords && Number(batch.rowCount) > 0) return {
            ...batch,
            inputCount: Number(batch.inputCount) || 0,
            goodCount: Number(batch.goodCount) || 0,
            failCount: Number(batch.failCount) || 0,
            yieldRate: Number(batch.yieldRate || 0).toFixed(2),
            defectRate: Number(batch.defectRate || 0).toFixed(2),
            unknownStatusCount: Number(batch.unknownStatusCount) || 0,
            unknownStatusText: batch.unknownStatusText || '無',
            rowCount: Number(batch.rowCount) || 0,
            records: []
        };
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
            const timestamp = recordTimestamp(record);
            const key = `${batch.line || currentDafLine()}::${record.dedupKey}`;
            const previous = selected.get(key);
            if (!previous) {
                selected.set(key, { record, timestamp });
                return;
            }
            duplicateCount++;
            if (timestamp < previous.timestamp) {
                duplicates.add(previous.record);
                selected.set(key, { record, timestamp });
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
    const recordTimestamp = record => {
        const stored = Number(record?.dedupTime);
        if (Number.isFinite(stored) && stored > 0) return stored;
        const parsed = parseDateTime(record?.date);
        return parsed ? parsed.getTime() : Number.MAX_SAFE_INTEGER;
    };
    const earliestRecord = records => (records || []).reduce((earliest, record) => {
        if (!earliest || recordTimestamp(record) < recordTimestamp(earliest)) return record;
        return earliest;
    }, null);
    const dafBatchSignature = batch => (batch.records || []).map(record => [
        record.dedupKey, record.dedupTime, record.date, record.status,
        record.workOrder, record.productCode, record.defect, record.model, record.machine
    ].join('|')).join('\n');
    const syncDafRemoteChanges = async (before, after) => {
        if (!dafRemoteReady.value) return false;
        const beforeIds = new Set((before || []).map(batch => batch.id));
        const afterById = new Map((after || []).map(batch => [batch.id, batch]));
        let success = true;
        for (const oldBatch of before || []) {
            const nextBatch = afterById.get(oldBatch.id);
            if (!nextBatch) {
                if (!(await deleteRemote(oldBatch.id, oldBatch))) success = false;
            } else if (dafBatchSignature(oldBatch) !== dafBatchSignature(nextBatch)) {
                if (!(await saveRemote(nextBatch))) success = false;
            }
        }
        for (const newBatch of after || []) {
            if (!beforeIds.has(newBatch.id) && !(await saveRemote(newBatch))) success = false;
        }
        return success;
    };
    const collectDafMachineMap = () => {
        const machineMap = new Map();
        dafMachineReferenceCache.forEach((reference, key) => {
            if (isDafMachineLabel(reference?.machine)) machineMap.set(normalizeText(key), reference.machine);
        });
        dafBatches.value.filter(batch => (batch.line || 'DAF') === 'DAF').forEach(batch => {
            (batch.records || []).forEach(record => {
                const key = normalizeText(record.dedupKey);
                if (key && isDafMachineLabel(record.machine)) machineMap.set(key, record.machine);
            });
        });
        return machineMap;
    };
    const applyDafMachineMapToBatches = (batches, machineMap) => {
        let changed = false;
        const changedBatchIds = [];
        const nextBatches = (batches || []).map(batch => {
            if (!isMachineClassifiedProcess(batch.line) || !Array.isArray(batch.records) || !batch.records.length) return batch;
            let batchChanged = false;
            const records = batch.records.map(record => {
                const machine = machineMap.get(normalizeText(record.dedupKey));
                if (!isDafMachineLabel(machine) || record.machine === machine) return record;
                batchChanged = true;
                return { ...record, machine };
            });
            if (!batchChanged) return batch;
            changed = true;
            changedBatchIds.push(batch.id);
            return rebuildDafBatch({ ...batch, records });
        });
        return { batches: nextBatches, changed, changedBatchIds };
    };
    const syncDafMachineClassificationRemotely = async (batches, machineMap, changedBatchIds) => {
        const changedIds = new Set(changedBatchIds || []);
        for (const batch of (batches || []).filter(item => changedIds.has(item.id))) {
            const { data: remoteRow, error } = await _supabase.from(REMOTE_TABLE)
                .select(REMOTE_DETAIL_COLUMNS).eq('id', batch.id).eq('line', batch.line).maybeSingle();
            if (error || !remoteRow) return false;
            const remoteBatch = fromRemote(remoteRow);
            const remapped = applyDafMachineMapToBatches([remoteBatch], machineMap);
            if (remapped.changed && !(await saveRemote(remapped.batches[0]))) return false;
        }
        return true;
    };
    const syncLoadedDafMachineClassification = async (line, { start = '', end = '' } = {}) => {
        if (!isMachineClassifiedProcess(line)) return true;
        if (!dafMachineReferenceCache.size) await loadDafMachineReferences();
        let machineMap = collectDafMachineMap();
        if (line === 'FT1' && !dafDetailRangeLoaded('DAF', start, end)) {
            await ensureDafProcessDetails('DAF', { start, end });
            machineMap = collectDafMachineMap();
        }
        if (!machineMap.size) return true;
        const before = dafBatches.value;
        const applied = applyDafMachineMapToBatches(before, machineMap);
        if (!applied.changed) return true;
        if (!(await syncDafMachineClassificationRemotely(applied.batches, machineMap, applied.changedBatchIds))) return false;
        dafBatches.value = applied.batches;
        allRecordsCacheSource = null;
        dafDateIndexSource = null;
        dafStatsRangeCache.clear();
        dafDashboardCache.clear();
        return true;
    };
    const mergeDafBatch = async incoming => {
        const before = dafBatches.value.map(rebuildDafBatch);
        const incomingLine = incoming.line || currentDafLine();
        const existingByKey = new Map();
        before.forEach(batch => (batch.records || []).forEach(record => {
            const rawKey = normalizeText(record.dedupKey);
            if (!rawKey) return;
            const key = `${batch.line || currentDafLine()}::${rawKey}`;
            if (!existingByKey.has(key)) existingByKey.set(key, []);
            existingByKey.get(key).push(record);
        }));
        const incomingKeys = new Set((incoming.records || []).map(record => {
            const rawKey = normalizeText(record.dedupKey);
            return rawKey ? `${incoming.line || currentDafLine()}::${rawKey}` : null;
        }).filter(Boolean));
        const keepExisting = new Set();
        const existingRecordUpdates = new Map();
        const keepIncoming = new Set();
        let duplicateCount = 0;
        (incoming.records || []).forEach(record => {
            const rawKey = normalizeText(record.dedupKey);
            if (!rawKey) {
                keepIncoming.add(record);
                return;
            }
            const key = `${incoming.line || currentDafLine()}::${rawKey}`;
            const existingRecords = existingByKey.get(key) || [];
            if (!existingRecords.length) {
                keepIncoming.add(record);
                return;
            }
            duplicateCount++;
            const winner = earliestRecord([...existingRecords, record]);
            if (winner === record) keepIncoming.add(record);
            else {
                if ((!winner.machine || winner.machine === DAF_MACHINE_UNKNOWN) && record.machine && record.machine !== DAF_MACHINE_UNKNOWN) {
                    existingRecordUpdates.set(winner, { ...winner, machine: record.machine });
                }
                keepExisting.add(winner);
            }
        });
        const retained = before.map(batch => {
            const records = (batch.records || []).filter(record => {
                const rawKey = normalizeText(record.dedupKey);
                if (!rawKey) return true;
                const key = `${batch.line || currentDafLine()}::${rawKey}`;
                return !incomingKeys.has(key) || keepExisting.has(record);
            }).map(record => existingRecordUpdates.get(record) || record);
            return { ...batch, records };
        }).filter(batch => batch.records.length || (batch.line || currentDafLine()) !== incomingLine || Number(batch.rowCount) > 0);
        const incomingBatch = { ...incoming, records: (incoming.records || []).filter(record => keepIncoming.has(record)) };
        const merged = deduplicateDafBatches([...retained, incomingBatch]);
        const batches = merged.batches.filter(batch => !(batch.id === incoming.id && incoming.records?.length && !batch.records.length));
        const remoteSaved = await syncDafRemoteChanges(before, batches);
        if (!remoteSaved) return {
            batch: null,
            duplicateCount: duplicateCount + merged.duplicateCount,
            remoteSaved: false
        };
        dafBatches.value = batches;
        dafLastUpload.value = batches.find(batch => batch.id === incoming.id) || batches[0] || null;
        learnModelMappings(batches);
        return {
            batch: batches.find(batch => batch.id === incoming.id) || null,
            duplicateCount: duplicateCount + merged.duplicateCount,
            remoteSaved
        };
    };
    let dafLoadRequestId = 0;
    let dafRemoteLoadPromise = null;
    let dafRemoteLoadLine = '';
    const dafDetailLoadedLines = new Set();
    const dafDetailLoadPromises = new Map();
    let dafDetailLoadGeneration = 0;
    const invalidateDafDetailLoads = ({ clearBatches = false } = {}) => {
        dafDetailLoadGeneration += 1;
        dafDetailLoadedLines.clear();
        dafDetailLoadPromises.clear();
        if (clearBatches) dafBatches.value = [];
    };
    let dafRemoteChangeChannel = null;
    const probeDafRemote = async lines => {
        const results = await Promise.all(lines.map(line => _supabase.from(REMOTE_TABLE).select('id').eq('line', line).limit(1)));
        return results.find(result => result.error)?.error || null;
    };
    const ensureDafRemoteConnection = async () => {
        if (dafRemoteLoadPromise) {
            try { await dafRemoteLoadPromise; } catch (error) { console.warn(`${currentDafLabel()} 共用資料庫連線等待失敗`, error); }
            if (dafRemoteReady.value) return true;
        }
        if (dafRemoteReady.value) return true;
        dafRemoteChecking.value = true;
        if (window.koyaFetchCachedJson) {
            dafRemoteReady.value = true;
            dafRemoteChecking.value = false;
            dafRemoteError.value = '';
            return true;
        }
        const probeError = await probeDafRemote(TEST_PROCESS_IDS);
        if (probeError) {
            dafRemoteReady.value = false;
            dafRemoteChecking.value = false;
            dafRemoteError.value = probeError.code === 'PGRST205' ? '尚未建立 DAF 檔案統計共用資料表' : (probeError.message || '共用資料庫連線失敗');
            return false;
        }
        dafRemoteReady.value = true;
        dafRemoteChecking.value = false;
        dafRemoteError.value = '';
        return true;
    };
    const dafDetailRangeLoaded = (line, start = '', end = '') => [...dafDetailLoadedLines].some(key => {
        const [loadedLine, loadedStart = '', loadedEnd = ''] = key.split('|');
        if (loadedLine !== line) return false;
        const startCovered = !loadedStart || (start && loadedStart <= start);
        const endCovered = !loadedEnd || (end && loadedEnd >= end);
        return startCovered && endCovered;
    });
    const mergeDafDetailBatches = (existingBatches, remoteBatches, line, { replaceStart = '', replaceEnd = '' } = {}) => {
        const recordsOutsideRange = records => (records || []).filter(record => {
            if (!replaceStart && !replaceEnd) return false;
            const date = record.date || '';
            if (!date) return true;
            if (replaceStart && date < replaceStart) return true;
            if (replaceEnd && date > replaceEnd) return true;
            return false;
        });
        const batchMap = new Map();
        existingBatches.forEach(batch => {
            if (batch.line !== line) {
                batchMap.set(batch.id, batch);
                return;
            }
            const records = replaceStart || replaceEnd ? recordsOutsideRange(batch.records) : (batch.records || []);
            if (records.length) batchMap.set(batch.id, { ...batch, records });
        });
        remoteBatches.forEach(batch => {
            const previous = batchMap.get(batch.id);
            const mergedRecords = [];
            const identities = new Set();
            [...(previous?.records || []), ...(batch.records || [])].forEach(record => {
                const identity = [record.dedupKey || '', record.dedupTime ?? '', record.date || '', record.status || '', record.defect || '', record.workOrder || ''].join('|');
                if (identities.has(identity)) return;
                identities.add(identity);
                mergedRecords.push(record);
            });
            batchMap.set(batch.id, { ...(previous || {}), ...batch, records: mergedRecords });
        });
        return deduplicateDafBatches([...batchMap.values()]).batches;
    };
    const ensureDafProcessDetails = async (line, { force = false, start = '', end = '' } = {}) => {
        if (!TEST_PROCESS_IDS.includes(line)) return true;
        if (!(await ensureDafRemoteConnection())) return false;
        const detailKey = `${line}|${start}|${end}`;
        const loadGeneration = dafDetailLoadGeneration;
        if (force) dafDetailLoadedLines.delete(detailKey);
        if (!force && dafDetailRangeLoaded(line, start, end)) return true;
        if (dafDetailLoadPromises.has(detailKey)) return dafDetailLoadPromises.get(detailKey);
        const request = (async () => {
            const result = await loadDafRemoteRows(line, true, { force, start, end });
            if (loadGeneration !== dafDetailLoadGeneration) return false;
            if (result.error) {
                dafRemoteError.value = `${processLabel(line)} 明細載入失敗：${result.error.message || '資料讀取失敗'}`;
                return false;
            }
            const remoteBatches = filterGhostDafRows(result.data || []).map(fromRemote);
            dafBatches.value = mergeDafDetailBatches(dafBatches.value, remoteBatches, line, force ? { replaceStart: start, replaceEnd: end } : {});
            if (!(await syncLoadedDafMachineClassification(line, { start, end }))) {
                dafRemoteError.value = `${processLabel(line)} 機台分類同步失敗，已保留原始統計資料`;
            }
            dafDetailLoadedLines.add(detailKey);
            if (dafStatsResults.value[line]) {
                dafStatsResults.value = { ...dafStatsResults.value, [line]: buildDafStats(line) };
                if (currentDafLine() === line) dafStatsResult.value = dafStatsResults.value[line];
            }
            return true;
        })().finally(() => { if (dafDetailLoadPromises.get(detailKey) === request) dafDetailLoadPromises.delete(detailKey); });
        dafDetailLoadPromises.set(detailKey, request);
        return request;
    };
    const refreshDafAfterRemoteLoad = (line, { refreshDetails = false } = {}) => {
        if (currentLine.value !== line) return;
        if (refreshDetails && currentTab.value === 'stats') calculateDafStats(false, { publishShared: true });
        if (refreshDetails && currentTab.value === 'report') ensureDafProcessDetails(currentDafLine());
        if (!ctx.refreshDashboard) return;
        Promise.resolve(ctx.refreshDashboard()).then(refreshed => {
            if (refreshed !== false && currentTab.value === 'dashboard' && ctx.initDashboardCharts) return ctx.initDashboardCharts();
            return null;
        }).catch(error => console.warn(`${currentDafLabel()} 儀表板背景更新失敗`, error));
    };
    const loadDafData = async ({ background = false, force = false } = {}) => {
        const line = isUnifiedTestLine() ? 'TEST' : currentDafLine();
        if (dafRemoteLoadPromise && dafRemoteLoadLine === line) {
            if (background && !force) return true;
            await dafRemoteLoadPromise;
            if (!force) return true;
        }
        const requestId = ++dafLoadRequestId;
        if (!background) {
            invalidateDafDetailLoads({ clearBatches: true });
            dafStatsRangeCache.clear();
            dafRemoteVersions = null;
            dafRemoteVersionsLoadedAt = 0;
            dafSummaryBatches.value = [];
            dafStatsResult.value = null;
            dafStatsResults.value = {};
        }
        if (!isDafLikeLine()) return;
        if (!background) await invalidateDafSummaryCache();
        dafRemoteReady.value = false;
        dafRemoteChecking.value = true;
        dafRemoteError.value = '';
        dafRemoteLoadLine = line;
        const remotePromise = (async () => {
            const processLines = isUnifiedTestLine() ? TEST_PROCESS_IDS : [line];
            const probeError = window.koyaFetchCachedJson ? null : await probeDafRemote(processLines);
            if (requestId !== dafLoadRequestId || currentLine.value !== (isUnifiedTestLine() ? 'TEST' : line)) return;
            if (probeError) {
                dafRemoteReady.value = false;
                dafRemoteChecking.value = false;
                dafRemoteError.value = probeError.code === 'PGRST205' ? '尚未建立 DAF 檔案統計共用資料表' : (probeError.message || 'DAF 共用資料庫連線失敗');
                dafSummaryBatches.value = [];
                if (!background) dafBatches.value = [];
                dafLastUpload.value = null;
                return;
            }
            // 儀表板只讀摘要欄位；完整 records 延後到統計／明細明確操作時才讀取。
            // 五個製程只載入摘要欄位，並行取得後一次替換畫面，避免清單先只出現最新檔案或逐站等待。
            const remoteResults = await Promise.all(processLines.map(processLine => loadDafRemoteRows(processLine, false, { force })));
            const error = remoteResults.find(result => result.error)?.error || null;
            const remoteRows = remoteResults.flatMap(result => result.data || []);
            if (requestId !== dafLoadRequestId || currentLine.value !== (isUnifiedTestLine() ? 'TEST' : line)) return;
            if (error) {
                dafRemoteChecking.value = false;
                dafRemoteError.value = `資料庫已連線，但部分 LOG 載入失敗：${error.message || '資料讀取失敗'}`;
                // 手動重新整理只能顯示這次遠端讀取結果，不能把舊清單當成最新資料。
                if (!background) {
                    dafSummaryBatches.value = [];
                    dafBatches.value = [];
                    dafLastUpload.value = null;
                }
            } else {
                dafRemoteReady.value = true;
                dafRemoteChecking.value = false;
                dafRemoteError.value = '';
                const remoteBatches = filterGhostDafRows(remoteRows || []).map(fromRemote);
                dafSummaryBatches.value = remoteBatches;
                if (!background) dafBatches.value = [];
            }
            learnModelMappings(dafSummaryBatches.value);
            dafLastUpload.value = dafSummaryBatches.value[0] || null;
        })();
        dafRemoteLoadPromise = remotePromise;
        const settled = remotePromise.finally(() => {
            if (dafRemoteLoadPromise === remotePromise) {
                dafRemoteLoadPromise = null;
                dafRemoteLoadLine = '';
                if (requestId !== dafLoadRequestId && currentLine.value === line) loadDafData({ background: true });
            }
        });
        if (background) {
            settled.then(() => refreshDafAfterRemoteLoad(line)).catch(error => console.warn(`${currentDafLabel()} 背景資料同步失敗`, error));
            return true;
        }
        await settled;
        refreshDafAfterRemoteLoad(line, { refreshDetails: true });
        return true;
    };

    const clearDafRemoteDerivedState = ({ clearDetails = false } = {}) => {
        invalidateDafDetailLoads({ clearBatches: clearDetails });
        dafStatsRangeCache.clear();
        dafRemoteVersions = null;
        dafRemoteVersionsLoadedAt = 0;
        dafStatsResult.value = null;
        dafStatsResults.value = {};
        dafSharedStatsSnapshot = null;
        dafDateIndexSource = null;
        dafDashboardCache.clear();
    };
    const refreshDafViewsAfterRemoteChange = () => {
        if (!ctx.refreshDashboard) return;
        Promise.resolve(ctx.refreshDashboard()).then(refreshed => {
            if (refreshed !== false && currentTab.value === 'dashboard' && ctx.initDashboardCharts) return ctx.initDashboardCharts();
            return null;
        }).catch(error => console.warn(`${currentDafLabel()} 遠端變更畫面同步失敗`, error));
    };
    const applyDafRemoteDeletion = id => {
        if (!id) return;
        const hadStats = Object.keys(dafStatsResults.value || {}).length > 0;
        dafSummaryBatches.value = dafSummaryBatches.value.filter(batch => batch.id !== id);
        dafBatches.value = dafBatches.value.filter(batch => batch.id !== id);
        clearDafRemoteDerivedState();
        if (hadStats) {
            const nextResults = {};
            TEST_PROCESS_IDS.forEach(line => { nextResults[line] = buildDafStats(line); });
            dafStatsResults.value = nextResults;
            dafStatsResult.value = nextResults[currentDafLine()] || null;
        }
        dafLastUpload.value = dafBatches.value[0] || dafSummaryBatches.value[0] || null;
        refreshDafViewsAfterRemoteChange();
    };
    let dafRemoteSyncTimer = null;
    const scheduleDafRemoteRefresh = () => {
        clearTimeout(dafRemoteSyncTimer);
        dafRemoteSyncTimer = setTimeout(async () => {
            dafRemoteSyncTimer = null;
            if (!isDafLikeLine()) return;
            clearDafRemoteDerivedState({ clearDetails: true });
            try { await loadDafData({ background: true, force: true }); }
            catch (error) { console.warn(`${currentDafLabel()} 遠端變更資料同步失敗`, error); }
        }, 400);
    };
    const subscribeDafRemoteChanges = () => {
        if (!_supabase?.channel || dafRemoteChangeChannel) return;
        dafRemoteChangeChannel = _supabase.channel('koya-daf-log-sync')
            .on('postgres_changes', { event: '*', schema: 'public', table: REMOTE_TABLE }, payload => {
                const line = payload.new?.line || payload.old?.line;
                if (payload.new?.id === SHARED_STATS_STATE_ID || payload.old?.id === SHARED_STATS_STATE_ID || line === SHARED_STATS_STATE_LINE) {
                    if (currentTab.value === 'stats' && isUnifiedTestLine()) {
                        if (dafStatsLoading.value) dafSharedStatsForceQueued = true;
                        else void loadSharedDafStatsState({ force: true });
                    }
                    return;
                }
                if (!TEST_PROCESS_IDS.includes(line)) return;
                if (payload.eventType === 'DELETE') {
                    // DELETE 的 old payload 可能只包含主鍵；id 在五個製程間全域唯一，因此直接同步移除。
                    applyDafRemoteDeletion(payload.old?.id);
                    return;
                }
                scheduleDafRemoteRefresh();
            })
            .subscribe(status => {
                if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.warn('測試製程遠端同步連線失敗');
            });
    };

    let allRecordsCacheSource = null;
    let allRecordsCacheRows = [];
    const buildSummaryFallbackRecords = batch => {
        const inputCount = Math.max(0, Number(batch.inputCount) || 0);
        const goodCount = Math.min(inputCount, Math.max(0, Number(batch.goodCount) || 0));
        const failCount = Math.min(inputCount - goodCount, Math.max(0, Number(batch.failCount) || 0));
        const unknownCount = Math.max(0, (Number(batch.rowCount) || 0) - inputCount);
        const date = batch.dateStart || '';
        const unknownStatus = String(batch.unknownStatusText || '未分類狀態').split('、')[0] || '未分類狀態';
        return Array.from({ length: inputCount + unknownCount }, (_, index) => {
            const status = index < goodCount ? 'GOOD' : index < goodCount + failCount ? 'FAIL' : unknownStatus;
            return {
                workOrder: batch.workOrder || '未識別工單', productCode: batch.productCode || '',
                dedupKey: `${batch.id}::summary-${index}`, dedupTime: null, date,
                defect: status === 'FAIL' ? defaultDafDefect(batch.line || currentDafLine()) : '', status,
                model: normalizeModelName(batch.modelName), sourceFormat: batch.sourceFormat || LEGACY_SOURCE_FORMAT,
                machine: '', inputIncluded: ['GOOD', 'FAIL'].includes(status), isDefect: status === 'FAIL', raw: []
            };
        });
    };
    const allRecords = () => {
        if (allRecordsCacheSource !== dafBatches.value) {
            allRecordsCacheSource = dafBatches.value;
            allRecordsCacheRows = dafBatches.value.flatMap(batch => {
                const records = Array.isArray(batch.records) && batch.records.length ? batch.records : buildSummaryFallbackRecords(batch);
                return records.map(record => ({ ...record, processLine: batch.line || 'DAF', fileName: batch.fileName, batchId: batch.id }));
            });
        }
        return allRecordsCacheRows;
    };
    let dafDateIndexSource = null;
    let dafDateIndexProcess = '';
    let dafRowsByDate = new Map();
    let dafInputCountByDate = new Map();
    const ensureDafDateIndex = () => {
        if (dafDateIndexSource === dafBatches.value && dafDateIndexProcess === currentDafLine()) return;
        dafDateIndexSource = dafBatches.value;
        dafDateIndexProcess = currentDafLine();
        dafRowsByDate = new Map();
        dafInputCountByDate = new Map();
        allRecords().filter(row => row.processLine === currentDafLine()).forEach(row => {
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
        const detailedBatches = dafBatches.value.filter(batch => (batch.line || 'DAF') === currentDafLine());
        const batches = detailedBatches.length ? detailedBatches : summaryBatchesForCurrentLine();
        batches.forEach(batch => {
            const records = batch.records || [];
            if (!records.length) {
                // 首屏先用共用摘要顯示檔案與投入／良品／不良；完整 records 載入後會自動替換成精確每日明細。
                const date = summaryBatchDates(batch)[0] || batch.dateStart || '未識別日期';
                const group = groups[date] || (groups[date] = { date, files: [], input: 0, good: 0, defects: 0 });
                group.input += Number(batch.inputCount) || 0;
                group.good += Number(batch.goodCount) || 0;
                group.defects += Number(batch.failCount) || 0;
                group.files.push({
                    ...batch,
                    key: `${batch.id}_${date}`,
                    dateRecords: [],
                    machines: [],
                    dateInput: Number(batch.inputCount) || 0,
                    dateGood: Number(batch.goodCount) || 0,
                    dateDefects: Number(batch.failCount) || 0
                });
                return;
            }
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
                    machines: [...new Set(dateRecords.map(record => record.machine).filter(Boolean))],
                    dateInput: inputRecords.length,
                    dateGood: inputRecords.filter(record => record.status === 'GOOD').length,
                    dateDefects: inputRecords.filter(record => record.status === 'FAIL').length
                });
            });
        });
        return Object.values(groups).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    });
    const dafModelOptions = computed(() => [...new Set([
        ...allRecords().filter(row => row.processLine === currentDafLine()).map(row => normalizeModelName(row.model)),
        ...(dafStatsResult.value?.byModel || []).map(row => normalizeModelName(row.name)),
        ...(data?.value?.models || []).map(model => normalizeModelName(model.name)),
        ...Object.values(dafModelMappings.value).map(normalizeModelName),
        ...Object.values(MODEL_MAPPING).map(normalizeModelName)
    ].filter(model => model && model !== '未識別機種'))].sort((a, b) => a.localeCompare(b, 'zh-Hant')));
    const dafWorkOrderOptions = computed(() => [...new Set([
        ...allRecords().filter(row => row.processLine === currentDafLine()).map(row => row.workOrder),
        ...(dafStatsResult.value?.byWorkOrder || []).map(row => row.workOrder)
    ].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant')));
    const filterRecords = (processLine = currentDafLine(), filter = dafStatsFilter.value) => allRecords().filter(row => row.processLine === processLine).filter(row => {
        if (filter.start && (!row.date || row.date < filter.start)) return false;
        if (filter.end && (!row.date || row.date > filter.end)) return false;
        if (filter.model !== 'all' && row.model !== filter.model) return false;
        if (filter.workOrder !== 'all' && row.workOrder !== filter.workOrder) return false;
        return true;
    });
    const mapRate = (value, base) => base ? (value / base * 100).toFixed(2) : '0.00';
    const buildDafSummary = (rows, processLine = currentDafLine(), includeMachine = true) => {
        const sourceRows = rows || [];
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
        const machineValues = isMachineClassifiedProcess(processLine) && includeMachine && sourceRows.length
            ? [...new Set(sourceRows.map(dafMachineForRecord))]
            : [];
        const machineNames = machineValues.length
            ? [...DAF_MACHINE_LABELS, ...machineValues.filter(name => !DAF_MACHINE_LABELS.includes(name))]
            : [];
        failRows.forEach(row => {
            const defect = row.defect || defaultDafDefect(processLine);
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
                if (row.status === 'FAIL') { dayMap[row.date].defects++; const defect = row.defect || defaultDafDefect(processLine); dayMap[row.date].byType[defect] = (dayMap[row.date].byType[defect] || 0) + 1; }
            }
        });
        const detailRows = map => Object.entries(map || {}).map(([name, qty]) => ({ name, qty, ratio: mapRate(qty, Object.values(map).reduce((sum, value) => sum + value, 0)) })).sort((a, b) => b.qty - a.qty);
        const byType = Object.entries(defectMap).map(([name, qty]) => ({
            name, qty, inputRatio: mapRate(qty, input), ratio: mapRate(qty, defects),
            byModel: detailRows(defectModelMap[name]),
            byWorkOrder: detailRows(defectWorkOrderMap[name]),
            byMachine: machineNames.map(machine => {
                const machineQty = failRows.filter(row => dafMachineForRecord(row) === machine && (row.defect || defaultDafDefect(processLine)) === name).length;
                return { name: machine, qty: machineQty, ratio: mapRate(machineQty, qty) };
            })
        })).sort((a, b) => b.qty - a.qty);
        const byModel = Object.entries(modelMap).map(([name, value]) => ({
            name, input: value.input, good: value.good, defects: value.defects,
            yieldRate: mapRate(value.good, value.input), defectRate: mapRate(value.defects, value.input), ratio: mapRate(value.defects, defects),
            byType: detailRows(modelDefectMap[name]), byWorkOrder: detailRows(value.byWorkOrder),
            byMachine: machineNames.map(machine => {
                const machineRows = inputRows.filter(row => dafMachineForRecord(row) === machine && (row.model || '未識別機種') === name);
                const machineInput = machineRows.length;
                const machineGood = machineRows.filter(row => row.status === 'GOOD').length;
                const machineDefects = machineRows.filter(row => row.status === 'FAIL').length;
                return { name: machine, input: machineInput, good: machineGood, defects: machineDefects, yieldRate: mapRate(machineGood, machineInput), defectRate: mapRate(machineDefects, machineInput), ratio: mapRate(machineDefects, value.defects) };
            })
        })).sort((a, b) => b.defects - a.defects || b.input - a.input);
        const byWorkOrder = Object.entries(workOrderMap).map(([workOrder, value]) => ({
            workOrder, name: workOrder, model: [...value.models].join(' / '), input: value.input, good: value.good, defects: value.defects,
            yieldRate: mapRate(value.good, value.input), defectRate: mapRate(value.defects, value.input), ratio: mapRate(value.defects, defects),
            byType: detailRows(workOrderDefectMap[workOrder]), byModel: detailRows(value.byModel),
            byMachine: machineNames.map(machine => {
                const machineRows = inputRows.filter(row => dafMachineForRecord(row) === machine && (row.workOrder || '未識別工單') === workOrder);
                const machineInput = machineRows.length;
                const machineGood = machineRows.filter(row => row.status === 'GOOD').length;
                const machineDefects = machineRows.filter(row => row.status === 'FAIL').length;
                return { name: machine, workOrder, input: machineInput, good: machineGood, defects: machineDefects, yieldRate: mapRate(machineGood, machineInput), defectRate: mapRate(machineDefects, machineInput), ratio: mapRate(machineDefects, value.defects) };
            })
        })).sort((a, b) => b.defects - a.defects || b.input - a.input);
        const daily = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date)).map(day => ({
            ...day,
            total: day.input,
            yieldRate: mapRate(day.good, day.input),
            defectRate: mapRate(day.defects, day.input),
            byMachine: machineNames.map(machine => {
                const machineRows = inputRows.filter(row => row.date === day.date && dafMachineForRecord(row) === machine);
                const machineInput = machineRows.length;
                const machineGood = machineRows.filter(row => row.status === 'GOOD').length;
                const machineDefects = machineRows.filter(row => row.status === 'FAIL').length;
                return { name: machine, input: machineInput, good: machineGood, defects: machineDefects, yieldRate: mapRate(machineGood, machineInput), defectRate: mapRate(machineDefects, machineInput) };
            })
        }));
        const byMachine = machineNames.map(machine => {
            const machineResult = buildDafSummary(sourceRows.filter(row => dafMachineForRecord(row) === machine), processLine, false);
            const { rows: _machineRows, ...summary } = machineResult;
            return {
                name: machine,
                input: machineResult.totalInput,
                good: machineResult.totalGood,
                defects: machineResult.totalDefects,
                yieldRate: machineResult.yieldRate,
                defectRate: machineResult.defectRate,
                ...summary
            };
        });
        const unknownStatuses = [...new Set((rows || []).map(row => row.status).filter(status => status && !['GOOD', 'FAIL'].includes(status)))];
        const result = {
            totalInput: input, totalGood: goodRows.length, totalDefects: defects,
            yieldRate: mapRate(goodRows.length, input), defectRate: mapRate(defects, input),
            unknownStatusCount: (rows || []).filter(row => row.status && !['GOOD', 'FAIL'].includes(row.status)).length,
            unknownStatusText: unknownStatuses.join('、') || '無',
            totalDays: daily.length, totalRows: (rows || []).length, sourceFiles: [...new Set((rows || []).map(row => row.fileName).filter(Boolean))],
            byType, byModel, byWorkOrder, byMachine, daily, rows: rows || []
        };
        return result;
    };
    const buildDafStats = (processLine = currentDafLine(), filter = dafStatsFilter.value) => buildDafSummary(filterRecords(processLine, filter), processLine);
    const dafRowMatchesStatsFilter = (row, filter) => {
        if (filter.start && (!row.date || row.date < filter.start)) return false;
        if (filter.end && (!row.date || row.date > filter.end)) return false;
        if (filter.model !== 'all' && row.model !== filter.model) return false;
        if (filter.workOrder !== 'all' && row.workOrder !== filter.workOrder) return false;
        return true;
    };
    const buildDafStatsFromCachedEntry = (processLine, filter, entry) => {
        const cachedResult = entry?.results?.[processLine];
        if (!cachedResult || cachedResult.sharedSnapshot || !Array.isArray(cachedResult.rows)) return null;
        return buildDafSummary(cachedResult.rows.filter(row => dafRowMatchesStatsFilter(row, filter)), processLine);
    };
    const dafStatsRangeKey = (filter = dafStatsFilter.value) => [
        filter.start || '', filter.end || '', filter.model || 'all', filter.workOrder || 'all'
    ].join('|');
    const dafStatsRangeInfo = (filter = dafStatsFilter.value) => ({
        start: filter.start || '', end: filter.end || '', model: filter.model || 'all', workOrder: filter.workOrder || 'all'
    });
    const dafStatsRangeContains = (source, target) => {
        if (!source) return false;
        const sourceModel = source.model || 'all';
        const sourceWorkOrder = source.workOrder || 'all';
        const targetModel = target.model || 'all';
        const targetWorkOrder = target.workOrder || 'all';
        if ((sourceModel !== 'all' && sourceModel !== targetModel) || (sourceWorkOrder !== 'all' && sourceWorkOrder !== targetWorkOrder)) return false;
        const startCovered = !source.start || (target.start && source.start <= target.start);
        const endCovered = !source.end || (target.end && source.end >= target.end);
        return startCovered && endCovered;
    };
    const dafSummaryBatchCoversRange = (batch, filter) => {
        if (Number(batch.inputCount) <= 0) return false;
        const batchStart = batch.dateStart || '';
        const batchEnd = batch.dateEnd || batchStart;
        if (filter.start && batchEnd && batchEnd < filter.start) return false;
        if (filter.end && batchStart && batchStart > filter.end) return false;
        return true;
    };
    const dafSummaryHasDataForRange = (line, filter) => dafSummaryBatches.value.some(batch =>
        (batch.line || 'DAF') === line && dafSummaryBatchCoversRange(batch, filter)
    );
    const sharedDafEntryNeedsRefresh = (entry, line, filter) => {
        if (entry?.snapshot?.kind !== 'koya-daf-stats-snapshot-v1') return false;
        if (line === 'FT1' && entry.snapshot.machineClassificationVersion !== DAF_MACHINE_CLASSIFICATION_VERSION) return true;
        const result = entry.results?.[line];
        return Boolean(result && !result.sourceFiles?.length && dafSummaryHasDataForRange(line, filter));
    };
    let dafDashboardCacheSource = null;
    let dafDashboardSummaryCacheSource = null;
    const dafDashboardCache = new Map();
    const summaryBatchesForCurrentLine = () => dafSummaryBatches.value.filter(batch => (batch.line || 'DAF') === currentDafLine() && Number(batch.inputCount) > 0);
    const hasDafDetailedRecords = () => dafBatches.value.some(batch => (batch.line || 'DAF') === currentDafLine() && Array.isArray(batch.records) && batch.records.length);
    const summaryBatchDates = batch => {
        const start = batch.dateStart || '';
        const end = batch.dateEnd || start;
        if (!start) return [];
        if (start === end) return [start];
        // 舊批次可能跨日但沒有每日摘要；日期仍列入選擇器，精確不良明細由統計明細載入。
        return [...new Set([start, end])];
    };
    const getDafUploadedDates = (limit = 14) => {
        ensureDafDateIndex();
        const detailedDates = [...dafInputCountByDate.keys()].filter(date => dafInputCountByDate.get(date) > 0);
        const summaryDates = summaryBatchesForCurrentLine().flatMap(summaryBatchDates);
        return [...new Set([...summaryDates, ...detailedDates])].sort().slice(-limit);
    };
    const buildDafSummaryFromRemote = date => {
        const batches = summaryBatchesForCurrentLine().filter(batch => {
            const dates = summaryBatchDates(batch);
            return dates.includes(date) && ((batch.dateStart || '') === (batch.dateEnd || batch.dateStart || '') || date === batch.dateStart);
        });
        const totalInput = batches.reduce((sum, batch) => sum + (Number(batch.inputCount) || 0), 0);
        const totalGood = batches.reduce((sum, batch) => sum + (Number(batch.goodCount) || 0), 0);
        const totalDefects = batches.reduce((sum, batch) => sum + (Number(batch.failCount) || 0), 0);
        const modelMap = new Map();
        const workOrderMap = new Map();
        batches.forEach(batch => {
            const model = batch.modelName || '未識別機種';
            const workOrder = batch.workOrder || '未識別工單';
            const modelRow = modelMap.get(model) || { name: model, input: 0, good: 0, defects: 0, byWorkOrder: [] };
            modelRow.input += Number(batch.inputCount) || 0;
            modelRow.good += Number(batch.goodCount) || 0;
            modelRow.defects += Number(batch.failCount) || 0;
            modelMap.set(model, modelRow);
            const workOrderRow = workOrderMap.get(workOrder) || { name: workOrder, workOrder, model, input: 0, good: 0, defects: 0, byModel: [] };
            workOrderRow.input += Number(batch.inputCount) || 0;
            workOrderRow.good += Number(batch.goodCount) || 0;
            workOrderRow.defects += Number(batch.failCount) || 0;
            workOrderMap.set(workOrder, workOrderRow);
        });
        const byModel = [...modelMap.values()].map(row => ({ ...row, qty: row.input, yieldRate: mapRate(row.good, row.input), defectRate: mapRate(row.defects, row.input), ratio: mapRate(row.defects, totalDefects), byType: [] })).sort((a, b) => b.input - a.input);
        const byWorkOrder = [...workOrderMap.values()].map(row => ({ ...row, qty: row.input, yieldRate: mapRate(row.good, row.input), defectRate: mapRate(row.defects, row.input), ratio: mapRate(row.defects, totalDefects), byType: [] })).sort((a, b) => b.input - a.input);
        return {
            date, totalInput, totalGood, totalDefects,
            yieldRate: mapRate(totalGood, totalInput), defectRate: mapRate(totalDefects, totalInput),
            unknownStatusCount: batches.reduce((sum, batch) => sum + (Number(batch.unknownStatusCount) || 0), 0), unknownStatusText: '摘要未保存不良原因細項',
            totalDays: batches.length ? 1 : 0, totalRows: batches.reduce((sum, batch) => sum + (Number(batch.rowCount) || 0), 0),
            sourceFiles: [...new Set(batches.map(batch => batch.fileName).filter(Boolean))], byType: [], byModel, byWorkOrder, daily: [], rows: [], summaryOnly: true
        };
    };
    const getDafDashboardForDate = date => {
        if (dafDashboardCacheSource !== dafBatches.value || dafDashboardSummaryCacheSource !== dafSummaryBatches.value) {
            dafDashboardCacheSource = dafBatches.value;
            dafDashboardSummaryCacheSource = dafSummaryBatches.value;
            dafDashboardCache.clear();
        }
        if (dafDashboardCache.has(date)) return dafDashboardCache.get(date);
        const hasLoadedDate = dafDetailRangeLoaded(currentDafLine(), date, date);
        const result = hasLoadedDate
            ? { ...buildDafSummary(getDafRowsForDate(date)), date }
            : buildDafSummaryFromRemote(date);
        dafDashboardCache.set(date, result);
        return result;
    };
    const isDafDashboardDetailsLoaded = date => dafDetailRangeLoaded(currentDafLine(), date, date);
    const ensureDafDashboardDetails = (date, { force = false } = {}) => ensureDafProcessDetails(currentDafLine(), { start: date, end: date, force });
    const dafQuickRange = (mode, offset) => {
        const now = new Date(`${window.koyaTodayDate()}T00:00:00`);
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
    const activateDafCachedStats = (filter = dafStatsFilter.value) => {
        const rangeKey = dafStatsRangeKey(filter);
        const requestedRange = dafStatsRangeInfo(filter);
        const exactEntry = dafStatsRangeCache.get(rangeKey);
        const processLines = isUnifiedTestLine() ? TEST_PROCESS_IDS : [currentDafLine()];
        const reusableEntry = [exactEntry, ...dafStatsRangeCache.values()]
            .filter(Boolean)
            .find(entry => dafStatsRangeContains(entry.filter, requestedRange) && !processLines.some(line => sharedDafEntryNeedsRefresh(entry, line, requestedRange)));
        if (!reusableEntry) {
            dafStatsResults.value = {};
            dafStatsResult.value = null;
            return false;
        }
        const nextResults = {};
        const snapshot = reusableEntry.snapshot || dafSharedStatsSnapshot;
        processLines.forEach(line => {
            nextResults[line] = buildDafStatsFromCachedEntry(line, filter, reusableEntry)
                || exactEntry?.results?.[line]
                || sharedDafSnapshotResult(line, filter, snapshot)
                || buildDafStats(line, filter);
        });
        dafStatsResults.value = nextResults;
        dafStatsResult.value = nextResults[currentDafLine()] || null;
        if (!exactEntry) {
            dafStatsRangeCache.set(rangeKey, { ...reusableEntry, filter: requestedRange, results: nextResults, snapshot });
        }
        renderDafCharts();
        return true;
    };
    const applyDafQuick = async () => {
        if (!dafQuickMode.value) return;
        const { start, end } = dafQuickRange(dafQuickMode.value, dafQuickOffset.value);
        applyingDafQuick = true;
        dafStatsFilter.value.start = fmtDate(start);
        dafStatsFilter.value.end = fmtDate(end);
        await Vue.nextTick();
        applyingDafQuick = false;
        // 已載入的大區間可直接在本機切換日／週／月，不重抓遠端完整 LOG。
        activateDafCachedStats();
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
    const calculateDafStats = async (showToast = true, { refreshRemote = false, publishShared = showToast !== false } = {}) => {
        if (dafStatsFilter.value.start && dafStatsFilter.value.end && dafStatsFilter.value.start > dafStatsFilter.value.end) return toast('開始日期不能晚於結束日期', 'warning');
        const rangeKey = dafStatsRangeKey();
        const requestedRange = dafStatsRangeInfo();
        const processLines = isUnifiedTestLine() ? TEST_PROCESS_IDS : [currentDafLine()];
        const remoteVersions = await loadDafVersions(refreshRemote);
        const cachedEntry = dafStatsRangeCache.get(rangeKey);
        const matchingEntry = cachedEntry || [...dafStatsRangeCache.values()].find(entry => dafStatsRangeContains(entry.filter, requestedRange));
        const versionChanged = Boolean(matchingEntry?.versions && remoteVersions && !sameDafVersions(matchingEntry.versions, remoteVersions));
        const reusableEntry = !refreshRemote
            ? [...dafStatsRangeCache.values()].find(entry => dafStatsRangeContains(entry.filter, requestedRange) && (!remoteVersions || !entry.versions || sameDafVersions(entry.versions, remoteVersions)) && !processLines.some(line => sharedDafEntryNeedsRefresh(entry, line, requestedRange)))
            : null;
        if (reusableEntry) {
            const reusedResults = {};
            const snapshot = reusableEntry.snapshot || dafSharedStatsSnapshot;
            processLines.forEach(line => {
                reusedResults[line] = buildDafStatsFromCachedEntry(line, dafStatsFilter.value, reusableEntry)
                    || (reusableEntry === cachedEntry && reusableEntry.results?.[line]
                    ? reusableEntry.results[line]
                    : sharedDafSnapshotResult(line, dafStatsFilter.value, snapshot) || buildDafStats(line));
            });
            dafStatsResults.value = reusedResults;
            dafStatsResult.value = reusedResults[currentDafLine()] || null;
            if (reusableEntry !== cachedEntry) dafStatsRangeCache.set(rangeKey, { ...reusableEntry, filter: requestedRange, results: reusedResults, snapshot });
            renderDafCharts();
            if (publishShared && !(await saveSharedDafStatsState(remoteVersions))) toast('統計完成，但跨電腦同步狀態保存失敗', 'warning');
            return;
        }
        dafStatsLoadingCount += 1;
        dafStatsLoading.value = true;
        try {
            const shouldWaitForRemote = !!dafRemoteLoadPromise && !dafRemoteReady.value;
            const wasLoading = loading.value;
            if (shouldWaitForRemote && !wasLoading) loading.value = true;
            if (shouldWaitForRemote) {
                try { await dafRemoteLoadPromise; } catch (error) { console.warn(`${currentDafLabel()} 統計改用本機快取`, error); }
                if (!wasLoading) loading.value = false;
            }
            const processLines = isUnifiedTestLine() ? TEST_PROCESS_IDS : [currentDafLine()];
            const detailRange = { start: dafStatsFilter.value.start || '', end: dafStatsFilter.value.end || '' };
            const detailResults = await Promise.all(processLines.map(line => ensureDafProcessDetails(line, { ...detailRange, force: refreshRemote || versionChanged })));
            const failedLine = processLines.find((line, index) => detailResults[index] === false);
            if (failedLine) {
                if (showToast) toast(`${processLabel(failedLine)} 資料載入失敗，請稍後再試`, 'error');
                return;
            }
            dafDefectDetail.value = { show: false, name: '', qty: 0, byModel: [], byWorkOrder: [], byMachine: [], dailyTrend: [] };
            dafModelDetail.value = { show: false, name: '', input: 0, good: 0, defects: 0, yieldRate: '0.00', byType: [], byMachine: [] };
            dafWorkOrderDetail.value = { show: false, workOrder: '', model: '', input: 0, good: 0, defects: 0, yieldRate: '0.00', byType: [], byModel: [], byMachine: [] };
            const nextResults = { ...dafStatsResults.value };
            processLines.forEach(line => { nextResults[line] = buildDafStats(line); });
            dafStatsResults.value = nextResults;
            dafStatsRangeCache.set(rangeKey, { filter: requestedRange, versions: remoteVersions, results: nextResults });
            dafStatsResult.value = nextResults[currentDafLine()] || null;
            renderDafCharts();
            if (publishShared) {
                const sharedSaved = await saveSharedDafStatsState(remoteVersions);
                if (!sharedSaved) toast('統計完成，但跨電腦同步狀態保存失敗', 'warning');
            }
            if (showToast) toast(`${isUnifiedTestLine() ? '五個測試製程' : currentDafLabel()} 統計完成，共 ${dafStatsResult.value?.sourceFiles.length || 0} 個檔案`);
        } catch (error) {
            console.error('測試製程統計載入失敗', error);
            if (showToast) toast('統計資料載入失敗，請重新執行', 'error');
        } finally {
            dafStatsLoadingCount = Math.max(0, dafStatsLoadingCount - 1);
            dafStatsLoading.value = dafStatsLoadingCount > 0;
            if (!dafStatsLoading.value && dafSharedStatsForceQueued && !dafSharedStatsLoadPromise) {
                dafSharedStatsForceQueued = false;
                queueMicrotask(() => {
                    if (currentTab.value === 'stats' && isUnifiedTestLine()) void loadSharedDafStatsState({ force: true });
                });
            }
        }
    };
    const openDafDefectDetail = name => {
        const row = (dafStatsResult.value?.byType || []).find(item => item.name === name);
        dafDefectDetail.value = row
            ? { show: true, name: row.name, qty: row.qty, byModel: row.byModel || [], byWorkOrder: row.byWorkOrder || [], byMachine: row.byMachine || [], dailyTrend: (dafStatsResult.value?.daily || []).map(day => ({ date: day.date, qty: day.byType?.[row.name] || 0, ratio: day.defects ? ((day.byType?.[row.name] || 0) / day.defects * 100).toFixed(2) : '0.00' })) }
            : { show: false, name: '', qty: 0, byModel: [], byWorkOrder: [], byMachine: [], dailyTrend: [] };
    };
    const closeDafDefectDetail = () => {
        dafDefectDetail.value = { show: false, name: '', qty: 0, byModel: [], byWorkOrder: [], byMachine: [], dailyTrend: [] };
    };
    const openDafModelStatsDetail = name => {
        const row = (dafStatsResult.value?.byModel || []).find(item => item.name === name);
        dafModelDetail.value = row
            ? { show: true, name: row.name, input: row.input, good: row.good, defects: row.defects, yieldRate: row.yieldRate, byType: row.byType || [], byMachine: row.byMachine || [] }
            : { show: false, name: '', input: 0, good: 0, defects: 0, yieldRate: '0.00', byType: [], byMachine: [] };
    };
    const closeDafModelStatsDetail = () => {
        dafModelDetail.value = { show: false, name: '', input: 0, good: 0, defects: 0, yieldRate: '0.00', byType: [], byMachine: [] };
    };
    const openDafWorkOrderStatsDetail = workOrder => {
        const row = (dafStatsResult.value?.byWorkOrder || []).find(item => item.workOrder === workOrder);
        dafWorkOrderDetail.value = row
            ? { show: true, workOrder: row.workOrder, model: row.model, input: row.input, good: row.good, defects: row.defects, yieldRate: row.yieldRate, byType: row.byType || [], byModel: row.byModel || [], byMachine: row.byMachine || [] }
            : { show: false, workOrder: '', model: '', input: 0, good: 0, defects: 0, yieldRate: '0.00', byType: [], byModel: [], byMachine: [] };
    };
    const closeDafWorkOrderStatsDetail = () => {
        dafWorkOrderDetail.value = { show: false, workOrder: '', model: '', input: 0, good: 0, defects: 0, yieldRate: '0.00', byType: [], byModel: [], byMachine: [] };
    };
    const openDafOutputDetail = () => {
        const result = dafStatsResult.value;
        if (!result) return;
        dafOutputDetail.value = { show: true, title: `${currentDafLabel()} 產出與良率明細`, subtitle: '顯示目前篩選條件的總投入、良品、不良與良率', result };
    };
    const openDafTrendDetail = day => {
        if (!day) return;
        const result = {
            totalInput: Number(day.input) || 0,
            totalGood: Number(day.good) || 0,
            totalDefects: Number(day.defects) || 0,
            yieldRate: day.yieldRate || '0.00',
            defectRate: day.defectRate || '0.00',
            byMachine: day.byMachine || [],
            byModel: [],
            byWorkOrder: []
        };
        dafOutputDetail.value = { show: true, title: `${currentDafLabel()} ${day.date} 產出與良率明細`, subtitle: '依生產日查看投入、良品、不良與機台分佈', result };
    };
    const closeDafOutputDetail = () => {
        dafOutputDetail.value = { show: false, title: '', subtitle: '', result: null };
    };
    const ensureDafBaseSettings = async batch => {
        const processLine = batch.line || currentDafLine();
        const label = processLabel(processLine);
        const modelNames = [...new Set((batch.records || []).flatMap(record => cleanText(record.model).split('、').map(cleanText).filter(model => model && model !== '未識別機種')))];
        const defectNames = [...new Set((batch.records || []).filter(record => record.isDefect).map(record => cleanText(record.defect)).filter(Boolean))];
        if (!modelNames.length && !defectNames.length) return;
        try {
            const [{ data: existingModels, error: modelReadError }, { data: existingDefects, error: defectReadError }] = await Promise.all([
                _supabase.from('models').select('name').eq('line', processLine),
                _supabase.from('defect_types').select('name').eq('line', processLine)
            ]);
            if (modelReadError || defectReadError) throw modelReadError || defectReadError;
            const modelSet = new Set((existingModels || []).map(row => normalizeText(row.name)));
            const defectSet = new Set((existingDefects || []).map(row => normalizeText(row.name)));
            const missingModels = modelNames.filter(name => !modelSet.has(normalizeText(name)));
            const missingDefects = defectNames.filter(name => !defectSet.has(normalizeText(name)));
            let created = 0;
            for (const name of missingModels) {
                const { error } = await _supabase.from('models').insert({ name, line: processLine });
                if (!error) created++;
            }
            for (const name of missingDefects) {
                const { error } = await _supabase.from('defect_types').insert({ name, line: processLine });
                if (!error) created++;
            }
            if (created && loadBaseData) await loadBaseData();
            if (missingModels.length || missingDefects.length) {
                toast(`${label} 已自動新增基礎設定：機種 ${missingModels.length} 項、不良現象 ${missingDefects.length} 項`, 'info');
            }
        } catch (error) {
            console.warn(`${label} 基礎設定自動同步失敗`, error);
            toast(`${label} 檔案已分析，但基礎設定自動新增失敗`, 'warning');
        }
    };
    const finishDafUploadQueue = async queue => {
        dafUploadSummary.value = { files: queue.success, rows: queue.rows, duplicates: queue.duplicates, referenceRows: queue.referenceRows || 0, failed: queue.failed };
        const referenceText = queue.referenceRows ? `，保留待比對機台 ${queue.referenceRows.toLocaleString()} 筆` : '';
        if (queue.success) toast(`${currentDafLabel()} 完成 ${queue.success} 個檔案，共 ${queue.rows.toLocaleString()} 列${referenceText}${queue.duplicates ? `，已排除重複 ${queue.duplicates} 列` : ''}${queue.failed.length ? '；有檔案失敗' : ''}`, queue.failed.length ? 'warning' : 'success');
        else toast(`${currentDafLabel()} 檔案全部處理失敗`, 'error');
        // 上傳成功後立即以 Supabase 摘要重新整理；統計頁由 refreshDetails 再載入完整明細。
        if (queue.success) await loadDafData({ force: true });
    };
    const processDafUploadQueue = async queue => {
        await ensureDafModelMappingsReady();
        const referenceState = await loadDafMachineReferences();
        const storedMachineReferences = referenceState.error ? new Map() : referenceState.map;
        if (referenceState.error) toast('待比對機台資料讀取失敗，本次僅使用目前檔案內的比對資料', 'warning');
        for (let index = queue.index; index < queue.files.length; index++) {
            const file = queue.files[index];
            try {
                if (!(await ensureDafRemoteConnection())) {
                    queue.failed.push(`${file.name}：共用資料庫未連線，檔案未寫入`);
                    continue;
                }
                let batches = await analyzeFile(file, storedMachineReferences);
                if (batches.some(batch => (batch.line || '') === 'FT1')) {
                    const dates = batches.flatMap(batch => [batch.dateStart, batch.dateEnd]).filter(Boolean).sort();
                    await syncLoadedDafMachineClassification('FT1', { start: dates[0] || '', end: dates[dates.length - 1] || '' });
                    const applied = applyDafMachineMapToBatches(batches, collectDafMachineMap());
                    if (applied.changed) {
                        applied.batches.machineReferences = batches.machineReferences;
                        applied.batches.matchedMachineReferenceKeys = batches.matchedMachineReferenceKeys;
                        batches = applied.batches;
                    }
                }
                const machineReferences = batches.machineReferences || [];
                const matchedMachineReferenceKeys = batches.matchedMachineReferenceKeys || [];
                if (!batches.length) {
                    if (machineReferences.length) {
                        const savedReferences = await persistDafMachineReferences({ references: machineReferences, matchedKeys: matchedMachineReferenceKeys, storedMap: storedMachineReferences });
                        if (savedReferences) {
                            queue.success++;
                            queue.referenceRows = (queue.referenceRows || 0) + machineReferences.length;
                        } else queue.failed.push(`${file.name}：待比對機台資料寫入 Supabase 失敗`);
                        continue;
                    }
                    queue.failed.push(`${file.name}：A 欄沒有符合的五個製程，未寫入 Supabase`);
                    continue;
                }
                const unknownBatches = batches.filter(batch => batch.unknownProductDetails?.length || batch.unknownProductCodes?.length);
                if (unknownBatches.length) {
                    queue.index = index;
                    pendingDafUpload.value = queue;
                    const items = unknownBatches.flatMap(batch => (batch.unknownProductDetails?.length
                        ? batch.unknownProductDetails
                        : batch.unknownProductCodes.map(code => ({ code, workOrders: [] }))));
                    dafUnknownModelModal.value = { show: true, fileName: file.name, items, currentIndex: 0, selectedModel: '', newModel: '' };
                    toast(`發現 ${items.length} 個未識別機種代號，請先完成歸類`, 'warning');
                    return false;
                }
                let fileSaved = true;
                let dafBatchSaved = false;
                for (const batch of batches) {
                    if (!(await ensureDafProcessDetails(batch.line || currentDafLine()))) {
                        queue.failed.push(`${file.name}（${processLabel(batch.line)}）：明細載入失敗，檔案未完成同步`);
                        fileSaved = false;
                        continue;
                    }
                    await ensureDafBaseSettings(batch);
                    const merged = await mergeDafBatch(batch);
                    queue.rows += merged.batch?.rowCount || 0;
                    queue.duplicates += (batch.duplicateCount || 0) + merged.duplicateCount;
                    if (!merged.remoteSaved) {
                        queue.failed.push(`${file.name}（${processLabel(batch.line)}）：共用資料庫寫入失敗`);
                        fileSaved = false;
                    } else if (batch.line === 'DAF') dafBatchSaved = true;
                }
                const hasDafBatch = batches.some(batch => batch.line === 'DAF');
                if (machineReferences.length || matchedMachineReferenceKeys.length) {
                    if (!hasDafBatch || dafBatchSaved) {
                        const matchedKeys = new Set(matchedMachineReferenceKeys);
                        const savedReferences = await persistDafMachineReferences({ references: machineReferences, matchedKeys: matchedMachineReferenceKeys, storedMap: storedMachineReferences });
                        if (!savedReferences) {
                            queue.failed.push(`${file.name}：待比對機台資料寫入 Supabase 失敗`);
                            fileSaved = false;
                        } else {
                            queue.referenceRows = (queue.referenceRows || 0) + machineReferences.filter(reference => !matchedKeys.has(reference.dedupKey)).length;
                        }
                    }
                }
                if (fileSaved) queue.success++;
            } catch (error) { queue.failed.push(`${file.name}：${error.message}`); }
        }
        await finishDafUploadQueue(queue);
        return true;
    };
    const uploadDafFiles = async event => {
        const files = [...(event.target.files || [])];
        if (!files.length) return;
        const queue = { files, index: 0, success: 0, rows: 0, duplicates: 0, referenceRows: 0, failed: [] };
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
        await saveRemoteModelMapping(code, modelName);
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
        const batch = dafBatches.value.find(item => item.id === id) || dafSummaryBatches.value.find(item => item.id === id);
        if (!batch || !confirm(`確定刪除 ${batch.fileName} 的 ${currentDafLabel()} 統計？`)) return;
        if (!(await deleteRemote(id, batch))) return;
        await invalidateDafSummaryCache();
        // 刪除後立即以 Supabase 最新結果重建清單，避免只刪本機陣列，其他電腦或重新整理又把舊資料帶回來。
        await loadDafData({ force: true });
        if (isUnifiedTestLine()) await calculateDafStats(false, { refreshRemote: true, publishShared: true });
        toast(`${currentDafLabel()} 檔案統計已刪除`, 'info');
    };

    const exportDafStats = async () => {
        // 導出前重新從 Supabase 載入目前製程明細，避免沿用其他電腦的舊統計結果。
        await calculateDafStats(false, { refreshRemote: true });
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
        const machines = [['機台', '投入數', '良品數', '不良數', '良率', '不良率'], ...(result.byMachine || []).map(row => [row.name, row.input, row.good, row.defects, row.yieldRate + '%', row.defectRate + '%'])];
        const defectMachines = [['不良原因', '機台', '數量', '占該不良比例'], ...result.byType.flatMap(row => (row.byMachine || []).map(item => [row.name, item.name, item.qty, item.ratio + '%']))];
        const modelMachines = [['機種', '機台', '投入數', '良品數', '不良數', '良率'], ...result.byModel.flatMap(row => (row.byMachine || []).map(item => [row.name, item.name, item.input, item.good, item.defects, item.yieldRate + '%']))];
        const workOrderMachines = [['工單', '機台', '投入數', '良品數', '不良數', '良率'], ...result.byWorkOrder.flatMap(row => (row.byMachine || []).map(item => [row.workOrder, item.name, item.input, item.good, item.defects, item.yieldRate + '%']))];
        const daily = [['日期', '投入數', '良品數', '不良數', '良率', '不良率'], ...result.daily.map(row => [row.date, row.input, row.good, row.defects, row.yieldRate + '%', row.defectRate + '%'])];
        const dailyMachines = [['日期', '機台', '投入數', '良品數', '不良數', '良率', '不良率'], ...result.daily.flatMap(day => (day.byMachine || []).map(item => [day.date, item.name, item.input, item.good, item.defects, item.yieldRate + '%', item.defectRate + '%']))];
        const pareto = [['不良現象', '不良數量', '占不良比例'], ...result.byType.map(row => [row.name, row.qty, row.ratio + '%'])];
        const yieldTrend = [['日期', '投入數', '良品數', '不良數', '良率'], ...result.daily.map(row => [row.date, row.input, row.good, row.defects, row.yieldRate + '%'])];
        const outputTrend = [['日期', '投入數', '良品數', '不良數'], ...result.daily.map(row => [row.date, row.input, row.good, row.defects])];
        const rawHeader = ['系統識別機種', '系統識別產品代碼', '系統識別狀態', '是否列入投入數', '是否為不良', '系統解析日期', '機台', '原始欄位格式'];
        const rawRows = result.rows.map(row => [row.model, row.productCode, row.status, row.inputIncluded ? '是' : '否', row.isDefect ? '是' : '否', row.date, row.machine || DAF_MACHINE_UNKNOWN, row.sourceFormat === CURRENT_SOURCE_FORMAT ? '新格式 B／D／E／F／H／I' : '舊格式 C／E／F／G／I／J', ...(row.raw || [])]);
        const rawColumns = result.rows.reduce((max, row) => Math.max(max, (row.raw || []).length), Math.max(LEGACY_COLUMNS.minColumns, CURRENT_COLUMNS.minColumns));
        for (let index = 0; index < rawColumns; index++) rawHeader.push(`${String.fromCharCode(65 + index)}欄`);
        const wb = XLSX.utils.book_new();
        const sheets = [['生產統計', summary], ['良率趨勢', yieldTrend], ['Pareto分析', pareto], ['不良原因統計', defects], ['不良×機種', defectModels], ['不良×工單', defectWorkOrders], ['機種統計', models], ['機種×NG細項', modelDefects], ['工單統計', workOrders], ['工單×NG細項', workOrderDefects], ['機台統計', machines], ['不良×機台', defectMachines], ['機種×機台', modelMachines], ['工單×機台', workOrderMachines], ['每日統計', daily], ['每日×機台', dailyMachines], ['原始資料', [rawHeader, ...rawRows]]];
        sheets.forEach(([name, sheetData]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetData), name));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(outputTrend), '產出趨勢');
        const modelPart = dafStatsFilter.value.model === 'all' ? '全部機種' : safeFilename(dafStatsFilter.value.model);
        const woPart = dafStatsFilter.value.workOrder === 'all' ? '全部工單' : safeFilename(dafStatsFilter.value.workOrder);
        XLSX.writeFile(wb, `${currentDafLabel()}_${modelPart}_${woPart}_${safeFilename(range, '不限日期')}_統計結果.xlsx`);
        toast(`${currentDafLabel()} 完整統計報表已導出`);
    };

    let reasonChart = null;
    let trendChart = null;
    let defectTrendChart = null;
    const disposeChart = (chart) => { if (chart) chart.dispose(); return null; };
    const renderDafDefectTrendChart = () => {
        Vue.nextTick(() => {
            const el = document.getElementById('dafDefectTrendChart');
            const trend = dafDefectDetail.value?.dailyTrend || [];
            if (!el || !dafDefectDetail.value.show || !trend.length) { defectTrendChart = disposeChart(defectTrendChart); return; }
            if (!defectTrendChart || defectTrendChart.getDom() !== el) { defectTrendChart = disposeChart(defectTrendChart); defectTrendChart = echarts.init(el); }
            const labels = trend.map(row => row.date.slice(5));
            const quantities = trend.map(row => row.qty);
            const ratios = trend.map(row => Number(row.ratio));
            defectTrendChart.setOption({
                tooltip: { trigger: 'axis', formatter: params => `${params[0]?.axisValue || ''}<br/>${params.map(item => `${item.marker}${item.seriesName}: <b>${item.seriesName === '不良比例' ? Number(item.value || 0).toFixed(2) + '%' : Number(item.value || 0).toLocaleString()}</b>`).join('<br/>')}` },
                legend: { data: ['每日發生次數', '不良比例'], top: 8, right: 10, textStyle: { fontSize: 11, color: '#6b7280' } },
                grid: { top: 58, right: 58, bottom: 44, left: 48 },
                xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 10, color: '#9ca3af' }, axisLine: { lineStyle: { color: '#e5e7eb' } } },
                yAxis: [
                    { type: 'value', name: '次數', min: 0, axisLabel: { fontSize: 10, color: '#9ca3af' }, splitLine: { lineStyle: { color: '#f3f4f6' } } },
                    { type: 'value', name: '比例', min: 0, max: 100, axisLabel: { formatter: '{value}%', fontSize: 10, color: '#9ca3af' }, splitLine: { show: false } }
                ],
                series: [
                    { name: '每日發生次數', type: 'bar', data: quantities, barMaxWidth: 24, itemStyle: { color: '#fca5a5', borderRadius: [4, 4, 0, 0] }, label: { show: true, position: 'top', fontSize: 9 } },
                    { name: '不良比例', type: 'line', yAxisIndex: 1, data: ratios, smooth: true, symbol: 'circle', symbolSize: 6, lineStyle: { color: '#dc2626', width: 2.5 }, itemStyle: { color: '#dc2626' }, label: { show: true, position: 'top', formatter: '{c}%', fontSize: 9 } }
                ]
            });
        });
    };
    const renderDafCharts = () => {
        Vue.nextTick(() => {
            const result = dafStatsResult.value;
            const reasonEl = document.getElementById('dafReasonChart');
            const trendEl = document.getElementById('dafTrendChart');
            if (reasonEl && result?.byType?.length) {
                if (!reasonChart || reasonChart.getDom() !== reasonEl) { reasonChart = disposeChart(reasonChart); reasonChart = echarts.init(reasonEl); }
                const rows = result.byType.slice(0, 10).reverse();
                reasonChart.setOption({
                    grid: { top: 12, right: 24, bottom: 24, left: 120 },
                    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: params => `${params[0].name}<br/><b>${params[0].value} 件</b>` },
                    xAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 10, color: '#9ca3af' } },
                    yAxis: { type: 'category', data: rows.map(row => row.name), axisLabel: { fontSize: 10, color: '#6b7280' } },
                    series: [{ name: '不良數量', type: 'bar', data: rows.map(row => row.qty), barMaxWidth: 18, itemStyle: { color: '#dc2626', borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', fontSize: 10 } }]
                });
                if (reasonChart.off) reasonChart.off('click');
                if (reasonChart.on) reasonChart.on('click', params => { const name = params?.componentType === 'xAxis' ? params.value : params?.name; if (name) openDafDefectDetail(name); });
            } else reasonChart = disposeChart(reasonChart);
            if (trendEl && result?.daily?.length) {
                if (!trendChart || trendChart.getDom() !== trendEl) { trendChart = disposeChart(trendChart); trendChart = echarts.init(trendEl); }
                trendChart.setOption({ legend: { data: ['投入數', '良率'], top: 8, right: 10, textStyle: { fontSize: 11, color: '#6b7280' } }, grid: { top: 64, right: 58, bottom: 44, left: 48 }, tooltip: { trigger: 'axis', formatter: params => { let text = params[0]?.axisValue || ''; params.forEach(item => { text += `<br/>${item.marker}${item.seriesName}: <b>${item.seriesName === '良率' ? item.value + '%' : item.value.toLocaleString()}</b>`; }); return text; } }, xAxis: { type: 'category', data: result.daily.map(row => row.date.slice(5)), axisLabel: { fontSize: 10 } }, yAxis: [{ type: 'value', name: '投入', min: 0, axisLabel: { fontSize: 10, color: '#9ca3af' }, splitLine: { lineStyle: { color: '#f3f4f6' } } }, { type: 'value', name: '良率', min: 0, max: 100, axisLabel: { formatter: '{value}%', fontSize: 10 }, splitLine: { show: false } }], series: [{ name: '投入數', type: 'bar', data: result.daily.map(row => row.input), barMaxWidth: 24, itemStyle: { color: '#c4b5fd', borderRadius: [4, 4, 0, 0] } }, { name: '良率', type: 'line', yAxisIndex: 1, data: result.daily.map(row => Number(row.yieldRate)), smooth: true, symbol: 'circle', symbolSize: 6, lineStyle: { color: '#2563eb', width: 2.5 }, itemStyle: { color: '#2563eb' }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(37,99,235,0.16)' }, { offset: 1, color: 'rgba(37,99,235,0)' }] } }, label: { show: true, position: 'top', formatter: '{c}%', fontSize: 9 } }] });
                if (trendChart.off) trendChart.off('click');
                if (trendChart.on) trendChart.on('click', params => { const day = result.daily?.[params?.dataIndex]; if (day) openDafTrendDetail(day); });
            } else trendChart = disposeChart(trendChart);
        });
    };
    dafModelMappings.value = readModelMappings();
    void ensureDafModelMappingsReady();
    learnModelMappings(dafBatches.value);
    watch(() => [dafStatsFilter.value.start, dafStatsFilter.value.end], () => {
        if (!applyingDafQuick && !applyingDafSharedStats) {
            dafQuickMode.value = null;
            dafQuickOffset.value = 0;
            dafStatsResults.value = {};
            dafStatsResult.value = null;
        }
        saveDafStatsState();
    });
    watch(() => [dafStatsFilter.value.model, dafStatsFilter.value.workOrder], () => {
        if (applyingDafSharedStats) return;
        activateDafCachedStats();
    });
    watch(() => [dafQuickMode.value, dafQuickOffset.value], () => saveDafStatsState());
    watch(() => dafStatsResult.value, () => { if (currentTab.value === 'stats' && isDafLikeLine()) renderDafCharts(); });
    watch(dafDefectDetail, renderDafDefectTrendChart);
    watch(currentTab, tab => {
        if (!isDafLikeLine()) return;
        if (tab === 'report') ensureDafProcessDetails(currentDafLine());
        if (tab === 'stats') {
            renderDafCharts();
            if (isUnifiedTestLine()) void loadSharedDafStatsState();
        }
        if (tab === 'report') renderDafCharts();
    });
    watch(currentLine, line => {
        if (line === 'TEST') {
            dafModelMappings.value = readModelMappings();
            restoreDafStatsState();
            dafUploadSummary.value = { files: 0, rows: 0, duplicates: 0, failed: [] };
            dafLastUpload.value = null;
            dafStatsResult.value = dafStatsResults.value[dafProcess.value] || null;
            if (currentTab.value === 'stats') void loadSharedDafStatsState();
        }
    });
    watch(dafProcess, () => {
        try { localStorage.setItem(TEST_PROCESS_STORAGE_KEY, dafProcess.value); } catch (e) {}
        dafDateIndexSource = null;
        dafDashboardCache.clear();
        dafStatsResult.value = dafStatsResults.value[dafProcess.value] || null;
        if (ctx.refreshDashboard) Promise.resolve(ctx.refreshDashboard()).then(() => ctx.initDashboardCharts?.());
    });
    subscribeDafRemoteChanges();
    // 不做固定時間輪詢；由使用者手動重新整理、上傳完成或執行統計時取得最新資料。
    window.addEventListener('resize', () => { if (reasonChart) reasonChart.resize(); if (trendChart) trendChart.resize(); if (defectTrendChart) defectTrendChart.resize(); });

    return {
        dafBatches, dafSummaryBatches, dafBatchesByDate, dafStatsFilter, dafStatsResult, dafStatsLoading, dafRemoteReady, dafRemoteChecking, dafRemoteError, dafLastUpload, dafUploadSummary,
        dafModelOptions, dafWorkOrderOptions, dafUnknownModelModal, dafDefectDetail, dafQuickMode, dafQuickLabel, dafQuickRelative,
        dafProcess, dafProcessOptions: TEST_PROCESS_OPTIONS, dafProcessMeta, setDafProcess,
        uploadDafFiles, loadDafData, calculateDafStats, ensureDafProcessDetails, exportDafStats, deleteDafBatch, resolveDafUnknownModel, cancelDafUnknownModel,
        openDafDefectDetail, closeDafDefectDetail, dafModelDetail, openDafModelStatsDetail, closeDafModelStatsDetail, dafWorkOrderDetail, openDafWorkOrderStatsDetail, closeDafWorkOrderStatsDetail, dafOutputDetail, openDafOutputDetail, openDafTrendDetail, closeDafOutputDetail, setDafQuickMode, shiftDafQuick,
        getDafUploadedDates, getDafDashboardForDate, isDafDashboardDetailsLoaded, ensureDafDashboardDetails,
        renderDafCharts
    };
};
