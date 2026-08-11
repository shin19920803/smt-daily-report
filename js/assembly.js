window.SMT = window.SMT || {};

// Mylar 機台 LOG：瀏覽器版的 Python LOG 自動統計工具
SMT.assembly = function (ctx) {
    const { toast, loading, currentLine, currentTab, data, loadBaseData } = ctx;
    const STORAGE_KEY = 'koya_assy_log_batches_v1';
    const REMOTE_TABLE = 'assembly_log_batches';
    const REMOTE_MIGRATED_KEY = 'koya_assy_log_remote_migrated_v1';
    const MAPPING_STORAGE_KEY = 'koya_assy_log_mappings_v1';
    const MAPPING_TABLE = 'assembly_log_mappings';
    const MAPPING_MIGRATED_KEY = 'koya_assy_log_mapping_migrated_v1';
    const MODEL_SCHEDULE_STORAGE_KEY = 'koya_assy_model_schedules_v1';
    const MODEL_SCHEDULE_TABLE = 'assembly_model_schedules';
    const MODEL_SCHEDULE_MIGRATED_KEY = 'koya_assy_model_schedule_remote_migrated_v1';
    const NOTES_STORAGE_KEY = 'koya_assy_log_defect_notes_v1';
    const HOURLY_NOTES_STORAGE_KEY = 'koya_assy_log_hourly_notes_v1';
    const STATUS_NOTES_STORAGE_KEY = 'koya_assy_log_status_notes_v1';
    const today = () => new Date().toISOString().split('T')[0];

    const assemblyUploadDate = ref(today());
    const assemblyBatches = ref([]);
    const assemblyLastFile = ref('');
    const assemblyReportResult = ref(null);
    const assemblyStatsFilter = ref({ start: '', end: '' });
    const assemblyStatsResult = ref(null);
    const assemblyRemoteReady = ref(false);
    const assemblyRemoteError = ref('');
    const assemblyMappingRemoteReady = ref(false);
    const assemblyModelScheduleRemoteReady = ref(false);
    const assemblyModelScheduleRemoteError = ref('');
    const assemblyCloudReady = computed(() => assemblyRemoteReady.value && assemblyMappingRemoteReady.value && assemblyModelScheduleRemoteReady.value);
    const assemblyModelSchedules = ref([]);
    const assemblyModelScheduleModal = ref({ show: false });
    const assemblyModelScheduleForm = ref({ startTime: '00:00', endTime: '23:59', model: '' });
    const assemblyModelScheduleError = ref('');
    const assemblyMappings = ref([]);
    const assemblyDefectNotes = ref({});
    const assemblyHourlyNotes = ref({});
    const assemblyStatusNotes = ref({});
    const assemblyStatusNoteEditorOpen = ref(false);
    const assemblyStatusNoteHour = ref('09');
    const assemblyStatusNoteDraft = ref('');
    const pendingAssemblyUpload = ref(null);
    const assemblyUnknownModal = ref({ show: false, items: [], currentIndex: 0, selectedDefectName: '', newDefectName: '' });
    const assemblySourceDetail = ref({ show: false, category: '', items: [], hourly: [], hourlyTitle: '每小時發生次數', hourlyHint: '', total: 0, note: '', draftNote: '', dailyTrend: [] });
    const assemblyDailyDetail = ref({ show: false, date: '', success: 0, ng: 0, downtimeRate: '0.00', byType: [] });
    const assemblyQuickMode = ref(null);
    const assemblyQuickOffset = ref(0);
    let applyingAssemblyQuick = false;

    const NO_MODEL = '無機種區分';

    const WEEKDAY_TW = ['日', '一', '二', '三', '四', '五', '六'];
    const fmtLocal = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const dateFromValue = (value) => new Date(`${value}T00:00:00`);
    const dayOffset = (value, amount) => {
        const date = dateFromValue(value);
        date.setDate(date.getDate() + amount);
        return fmtLocal(date);
    };
    const assemblyUploadDateLabel = computed(() => {
        const date = dateFromValue(assemblyUploadDate.value);
        return `${assemblyUploadDate.value} (週${WEEKDAY_TW[date.getDay()]})`;
    });
    const assemblyUploadDateRelative = computed(() => {
        const diff = Math.round((dateFromValue(assemblyUploadDate.value) - dateFromValue(today())) / 86400000);
        if (diff === 0) return '今天';
        if (diff === -1) return '昨天';
        if (diff === 1) return '明天';
        return diff < 0 ? `${Math.abs(diff)} 天前` : `${diff} 天後`;
    });
    const shiftAssemblyUploadDate = (amount) => {
        assemblyUploadDate.value = dayOffset(assemblyUploadDate.value, amount);
    };
    const setAssemblyDateFromParsedLog = (parsed, fallbackDate) => {
        const dates = Object.keys(parsed?.buckets || {}).sort();
        assemblyUploadDate.value = dates[dates.length - 1] || fallbackDate;
    };

    const RULES = [
        { keywords: ['取图像成功', '取圖像成功'], category: '生產成功', type: 'SUCCESS' },
        { keywords: ['Mark1失敗', 'Mark1失败'], category: 'Mark點辨識失敗', type: 'NG' },
        { keywords: ['请手动清除', '請手動清除'], category: '吸取Mylar失敗', type: 'NG' },
        {
            keywords: [
                'HeadC1底部影像识别失败', 'HeadC2底部影像识别失败',
                'HeadC3底部影像识别失败', 'HeadC4底部影像识别失败',
                'HeadC1底部影像識別失敗', 'HeadC2底部影像識別失敗',
                'HeadC3底部影像識別失敗', 'HeadC4底部影像識別失敗',
                'Head底部影像识别失败', 'Head底部影像識別失敗'
            ],
            category: 'Head底部影像識別失敗', type: 'NG'
        },
        {
            keywords: [
                '錯誤軸未定位', '错误轴未定位', '軸未定位', '轴未定位',
                '單軸相對移動發生錯誤', '单轴相对移动发生错误',
                '板卡-第3軸異常', '板卡-第3轴异常',
                '錯誤碼2147483690', '错误码2147483690',
                'CZ2軸未到等待位置', 'CZ2轴未到等待位置'
            ],
            category: '調機時軸未定位', type: 'NG'
        },
        {
            keywords: ['吸嘴1取板失敗', '吸嘴1取板失败', '吸嘴2取料失敗', '吸嘴2取料失败'],
            category: '產品取件失敗', type: 'NG'
        },
        {
            keywords: ['吸嘴3取板失敗', '吸嘴3取板失败', '吸嘴4取板失敗', '吸嘴4取板失败'],
            category: '板子取回失敗', type: 'NG'
        },
        { keywords: ['防護門開啟', '防护门开启'], category: '防護門開啟', type: 'NG' },
        { keywords: ['等待減速信號超時', '等待减速信号超时'], category: '減速信號超時', type: 'NG' },
        {
            keywords: [
                '找Pcb目标匹配相识度低于', '找PCB目标匹配相识度低于',
                '找Pcb目標匹配相識度低於', '找PCB目標匹配相識度低於'
            ],
            category: '忽略', type: 'IGNORE'
        }
    ];

    const readStorage = () => {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.warn('組裝測試 LOG 歷史讀取失敗', e);
            return [];
        }
    };
    const readMappingStorage = () => {
        try {
            const raw = localStorage.getItem(MAPPING_STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.warn('組裝測試 LOG 對應讀取失敗', e);
            return [];
        }
    };
    const persistStorage = (batches = assemblyBatches.value) => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(batches));
        } catch (e) {
            console.warn('組裝測試 LOG 歷史保存失敗', e);
            toast('分析結果已載入，但瀏覽器儲存空間不足，重新整理後可能消失', 'warning');
        }
    };
    const persistMappingStorage = (mappings = assemblyMappings.value) => {
        try { localStorage.setItem(MAPPING_STORAGE_KEY, JSON.stringify(mappings)); } catch (e) {}
    };
    const normalizeModelSchedule = item => ({
        id: String(item?.id || ''),
        date: String(item?.date || item?.scheduleDate || item?.schedule_date || ''),
        startTime: String(item?.startTime || item?.start_time || ''),
        endTime: String(item?.endTime || item?.end_time || ''),
        model: String(item?.model || item?.modelName || item?.model_name || '').trim()
    });
    const readModelSchedules = () => {
        try {
            const parsed = JSON.parse(localStorage.getItem(MODEL_SCHEDULE_STORAGE_KEY) || '[]');
            return Array.isArray(parsed) ? parsed.map(normalizeModelSchedule).filter(item => item.id && item.date && item.startTime && item.endTime && item.model) : [];
        } catch (e) { return []; }
    };
    const persistModelSchedules = (schedules = assemblyModelSchedules.value) => {
        try { localStorage.setItem(MODEL_SCHEDULE_STORAGE_KEY, JSON.stringify(schedules)); } catch (e) {}
    };
    const assemblyModelOptions = computed(() => {
        const dafModels = ctx.dafModelOptions?.value || [];
        const currentModels = (data.value.models || []).map(item => item.name);
        const unique = new Map();
        [...dafModels, ...currentModels].forEach(item => {
            const name = String(item || '').trim();
            const key = name.toUpperCase();
            if (name && name !== '未識別機種' && !unique.has(key)) unique.set(key, name);
        });
        return [...unique.values()].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    });
    const assemblyModelSchedulesForDate = computed(() => assemblyModelSchedules.value
        .filter(item => item.date === assemblyUploadDate.value)
        .sort((a, b) => a.startTime.localeCompare(b.startTime)));
    const timeToMinutes = (value, isEnd = false) => {
        const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
        if (!match) return null;
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        if (hour > 23 || minute > 59) return null;
        // 23:59 作為當日最後一分鐘的結束點，採用半開區間可與下一時段銜接。
        return isEnd && hour === 23 && minute === 59 ? 1440 : hour * 60 + minute;
    };
    const modelForLogTime = (date, time) => {
        const minute = timeToMinutes(time);
        if (minute === null) return NO_MODEL;
        const schedule = assemblyModelSchedules.value.find(item => {
            if (item.date !== date) return false;
            const start = timeToMinutes(item.startTime);
            const end = timeToMinutes(item.endTime, true);
            return start !== null && end !== null && start <= minute && minute < end;
        });
        return schedule?.model || NO_MODEL;
    };
    const readDefectNotes = () => {
        try {
            const parsed = JSON.parse(localStorage.getItem(NOTES_STORAGE_KEY) || '{}');
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (e) { return {}; }
    };
    const persistDefectNotes = () => {
        try { localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(assemblyDefectNotes.value)); } catch (e) {}
    };
    const readHourlyNotes = () => {
        try {
            const parsed = JSON.parse(localStorage.getItem(HOURLY_NOTES_STORAGE_KEY) || '{}');
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (e) { return {}; }
    };
    const persistHourlyNotes = () => {
        try { localStorage.setItem(HOURLY_NOTES_STORAGE_KEY, JSON.stringify(assemblyHourlyNotes.value)); } catch (e) {}
    };
    const readStatusNotes = () => {
        try {
            const parsed = JSON.parse(localStorage.getItem(STATUS_NOTES_STORAGE_KEY) || '{}');
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (e) { return {}; }
    };
    const persistStatusNotes = () => {
        try { localStorage.setItem(STATUS_NOTES_STORAGE_KEY, JSON.stringify(assemblyStatusNotes.value)); } catch (e) {}
    };
    const hourlyNoteKey = (category, hour) => `${category}::${String(hour).padStart(2, '0')}`;
    const statusNoteKey = (date, hour) => `${date}::${String(hour).padStart(2, '0')}`;
    const assemblyStatusNoteHours = computed(() => Array.from({ length: 24 }, (_, hour) => {
        const value = String(hour).padStart(2, '0');
        return { value, label: `${value}:00–${value}:59`, hasNote: !!assemblyStatusNotes.value[statusNoteKey(assemblyUploadDate.value, value)] };
    }));
    const assemblyStatusNoteCurrent = computed(() => assemblyStatusNotes.value[statusNoteKey(assemblyUploadDate.value, assemblyStatusNoteHour.value)] || '');
    const syncAssemblyStatusNoteDraft = () => {
        assemblyStatusNoteDraft.value = assemblyStatusNoteCurrent.value;
    };
    const toggleAssemblyStatusNoteEditor = () => {
        assemblyStatusNoteEditorOpen.value = !assemblyStatusNoteEditorOpen.value;
        if (assemblyStatusNoteEditorOpen.value) syncAssemblyStatusNoteDraft();
    };
    const saveAssemblyStatusNote = () => {
        const value = String(assemblyStatusNoteDraft.value || '').trim();
        const key = statusNoteKey(assemblyUploadDate.value, assemblyStatusNoteHour.value);
        const next = { ...assemblyStatusNotes.value };
        if (value) next[key] = value;
        else delete next[key];
        assemblyStatusNotes.value = next;
        persistStatusNotes();
        assemblyReportResult.value = aggregate(assemblyBatches.value, assemblyUploadDate.value, assemblyUploadDate.value);
        if (assemblyStatsResult.value) assemblyStatsResult.value = aggregate(assemblyBatches.value, assemblyStatsFilter.value.start, assemblyStatsFilter.value.end);
        toast(value ? '機況備註已儲存' : '機況備註已清除', 'success');
    };

    const toRemoteBatch = (batch) => ({
        id: batch.id,
        line: 'ASSY',
        file_name: batch.fileName,
        uploaded_at: batch.uploadedAt,
        encoding: batch.encoding,
        line_count: batch.lineCount,
        parsed_line_count: batch.parsedLineCount,
        ignored_count: batch.ignoredCount,
        unclassified_count: batch.unclassifiedCount,
        buckets: batch.buckets
    });
    const toRemoteMapping = (mapping) => ({
        line: 'ASSY',
        log_message: mapping.logMessage,
        defect_name: mapping.defectName
    });
    const fromRemoteBatch = (row) => ({
        id: row.id,
        line: row.line || 'ASSY',
        fileName: row.file_name,
        uploadedAt: row.uploaded_at,
        encoding: row.encoding,
        lineCount: row.line_count,
        parsedLineCount: row.parsed_line_count,
        ignoredCount: row.ignored_count,
        unclassifiedCount: row.unclassified_count,
        buckets: row.buckets || {}
    });
    const fromRemoteMapping = (row) => ({
        line: row.line || 'ASSY',
        logMessage: row.log_message,
        defectName: row.defect_name
    });
    const toRemoteModelSchedule = schedule => ({
        id: schedule.id,
        line: 'ASSY',
        schedule_date: schedule.date,
        start_time: schedule.startTime,
        end_time: schedule.endTime,
        model_name: schedule.model
    });
    const fromRemoteModelSchedule = row => normalizeModelSchedule({
        id: row.id,
        date: row.schedule_date,
        startTime: row.start_time,
        endTime: row.end_time,
        model: row.model_name
    });
    const hasRemoteMigrationFlag = () => {
        try { return localStorage.getItem(REMOTE_MIGRATED_KEY) === '1'; } catch (e) { return false; }
    };
    const setRemoteMigrationFlag = () => {
        try { localStorage.setItem(REMOTE_MIGRATED_KEY, '1'); } catch (e) {}
    };
    const hasMappingMigrationFlag = () => {
        try { return localStorage.getItem(MAPPING_MIGRATED_KEY) === '1'; } catch (e) { return false; }
    };
    const setMappingMigrationFlag = () => {
        try { localStorage.setItem(MAPPING_MIGRATED_KEY, '1'); } catch (e) {}
    };
    const hasModelScheduleMigrationFlag = () => {
        try { return localStorage.getItem(MODEL_SCHEDULE_MIGRATED_KEY) === '1'; } catch (e) { return false; }
    };
    const setModelScheduleMigrationFlag = () => {
        try { localStorage.setItem(MODEL_SCHEDULE_MIGRATED_KEY, '1'); } catch (e) {}
    };
    const saveBatchRemote = async (batch) => {
        if (!assemblyRemoteReady.value) return false;
        const { error } = await _supabase.from(REMOTE_TABLE).upsert(toRemoteBatch(batch), { onConflict: 'id' });
        if (error) {
            console.error('組裝測試 LOG 共用資料庫寫入失敗', error);
            assemblyRemoteError.value = error.message || '共用資料庫寫入失敗';
            return false;
        }
        return true;
    };
    const deleteBatchRemote = async (id) => {
        if (!assemblyRemoteReady.value) return true;
        const { error } = await _supabase.from(REMOTE_TABLE).delete().eq('id', id).eq('line', 'ASSY');
        if (error) {
            console.error('組裝測試 LOG 共用資料庫刪除失敗', error);
            toast('共用資料庫刪除失敗：' + error.message, 'error');
            return false;
        }
        return true;
    };
    const saveMappingRemote = async (mapping) => {
        if (!assemblyMappingRemoteReady.value) return false;
        const { error } = await _supabase.from(MAPPING_TABLE).upsert(toRemoteMapping(mapping), { onConflict: 'line,log_message' });
        if (error) {
            console.error('組裝測試 LOG 對應共用資料庫寫入失敗', error);
            return false;
        }
        return true;
    };
    const saveModelScheduleRemote = async schedule => {
        if (!assemblyModelScheduleRemoteReady.value) return false;
        const { error } = await _supabase.from(MODEL_SCHEDULE_TABLE).upsert(toRemoteModelSchedule(schedule), { onConflict: 'id' });
        if (error) {
            assemblyModelScheduleRemoteError.value = error.message || '機種時段共用資料庫寫入失敗';
            console.error('Mylar 機種時段共用資料庫寫入失敗', error);
            return false;
        }
        return true;
    };
    const deleteModelScheduleRemote = async id => {
        if (!assemblyModelScheduleRemoteReady.value) return true;
        const { error } = await _supabase.from(MODEL_SCHEDULE_TABLE).delete().eq('id', id).eq('line', 'ASSY');
        if (error) {
            toast('機種時段共用資料庫刪除失敗：' + error.message, 'error');
            return false;
        }
        return true;
    };

    const decodeBytes = (arrayBuffer) => {
        const bytes = new Uint8Array(arrayBuffer);
        if (!bytes.length) throw new Error('上傳的檔案是空白檔案');
        const has = (a) => bytes.length >= a.length && a.every((v, i) => bytes[i] === v);
        const attempts = [];
        if (has([0xEF, 0xBB, 0xBF])) attempts.push(['utf-8', 'utf-8-sig']);
        if (has([0xFF, 0xFE, 0x00, 0x00])) attempts.push(['utf-32le', 'utf-32-le']);
        if (has([0x00, 0x00, 0xFE, 0xFF])) attempts.push(['utf-32be', 'utf-32-be']);
        if (has([0xFF, 0xFE])) attempts.push(['utf-16le', 'utf-16-le']);
        if (has([0xFE, 0xFF])) attempts.push(['utf-16be', 'utf-16-be']);
        const sample = bytes.slice(0, 4000);
        let oddNulls = 0, evenNulls = 0;
        sample.forEach((v, i) => { if (v === 0) (i % 2 === 0 ? evenNulls++ : oddNulls++); });
        if (oddNulls > sample.length * 0.2) attempts.push(['utf-16le', 'utf-16-le']);
        if (evenNulls > sample.length * 0.2) attempts.push(['utf-16be', 'utf-16-be']);
        ['utf-8', 'gb18030', 'big5', 'windows-1252'].forEach(enc => attempts.push([enc, enc]));
        const tried = new Set();
        for (const [encoding, label] of attempts) {
            if (tried.has(encoding)) continue;
            tried.add(encoding);
            try {
                const decoder = new TextDecoder(encoding, { fatal: true });
                return { text: decoder.decode(bytes), encoding: label };
            } catch (e) {}
        }
        throw new Error('無法辨識檔案編碼');
    };

    const normalizeDate = (value, fallback) => {
        const m = String(value || '').match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
        return m ? m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0') : fallback;
    };
    const normalizeMessage = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const hourKey = value => {
        const match = String(value || '').match(/^(\d{1,2})/);
        return match ? String(Math.min(23, Number(match[1]))).padStart(2, '0') : '';
    };

    const parseLogLine = (line, fallbackDate) => {
        const original = String(line || '').trim().replace(/\0/g, '');
        if (!original) return null;
        const parseCombined = (value, raw) => {
            const m = value.match(/^\s*(\d{4}[\/-]\d{1,2}[\/-]\d{1,2})\s+(\d{1,2}:\d{2}:\d{2})(?::|\.)?(\d{1,6})?\s*(.*)$/);
            if (!m) return null;
            const time = m[2] + (m[3] ? ':' + m[3] : '');
            return { date: normalizeDate(m[1], fallbackDate), time, message: m[4].trim(), original: raw };
        };
        const normal = parseCombined(original, original);
        if (normal) return normal;
        const columns = original.split('\t');
        if (columns.length >= 3) {
            const tabParsed = parseCombined(columns[0].trim() + ' ' + columns[1].trim() + ' ' + columns.slice(2).join('\t').trim(), original);
            if (tabParsed) return tabParsed;
            return { date: normalizeDate(columns[0].trim(), fallbackDate), time: columns[1].trim(), message: columns.slice(2).join('\t').trim(), original };
        }
        return { date: fallbackDate, time: '', message: original, original };
    };

    const classify = (message, mappingMap = new Map()) => {
        for (const rule of RULES) {
            for (const keyword of rule.keywords) {
                if (message.includes(keyword)) return { type: rule.type, category: rule.category, keyword };
            }
        }
        const mappedCategory = mappingMap.get(normalizeMessage(message));
        if (mappedCategory) return { type: 'NG', category: mappedCategory, keyword: 'user-mapping' };
        return null;
    };

    const emptyBucket = () => ({
        success: 0, ng: 0, ignored: 0, unclassified: 0, parsedLines: 0,
        byType: {}, sourceByType: {}, hourlySuccess: {}, hourlyNg: {}, hourlyByType: {}, events: []
    });
    const increment = (map, key, amount = 1) => { if (key) map[key] = (map[key] || 0) + amount; };

    const parseText = (text, fallbackDate, mappings = assemblyMappings.value) => {
        const buckets = {};
        const mappingMap = new Map((mappings || []).map(item => [item.logMessage, item.defectName]));
        const unknownMap = new Map();
        let ignoredCount = 0, unclassifiedCount = 0, parsedLineCount = 0;
        const lines = text.split(/\r?\n/);
        lines.forEach(line => {
            const parsed = parseLogLine(line, fallbackDate);
            if (!parsed || !parsed.message) return;
            parsedLineCount++;
            const result = classify(parsed.message, mappingMap);
            const date = parsed.date || fallbackDate;
            const bucket = buckets[date] || (buckets[date] = emptyBucket());
            bucket.parsedLines++;
            if (!result) {
                bucket.unclassified++;
                unclassifiedCount++;
                const key = normalizeMessage(parsed.message);
                const existing = unknownMap.get(key) || { key, message: parsed.message, original: parsed.original, count: 0 };
                existing.count++;
                unknownMap.set(key, existing);
                return;
            }
            if (result.type === 'IGNORE') {
                bucket.ignored++;
                ignoredCount++;
                return;
            }
            if (result.type === 'SUCCESS') {
                bucket.success++;
                bucket.events.push({ time: parsed.time, type: 'SUCCESS' });
                increment(bucket.hourlySuccess, hourKey(parsed.time));
            } else {
                bucket.ng++;
                bucket.events.push({ time: parsed.time, type: 'NG', category: result.category });
                increment(bucket.byType, result.category);
                const sourceMessage = normalizeMessage(parsed.message);
                const sourceMap = bucket.sourceByType[result.category] || (bucket.sourceByType[result.category] = {});
                increment(sourceMap, sourceMessage);
                const hour = hourKey(parsed.time);
                increment(bucket.hourlyNg, hour);
                const categoryHours = bucket.hourlyByType[result.category] || (bucket.hourlyByType[result.category] = {});
                increment(categoryHours, hour);
            }
        });
        return { buckets, parsedLineCount, ignoredCount, unclassifiedCount, lineCount: lines.length, unknownMessages: [...unknownMap.values()] };
    };

    const inRange = (date, start, end) => (!start || date >= start) && (!end || date <= end);
    const aggregate = (batches, start = '', end = '') => {
        const byType = {}, byDate = {}, sourceByType = {}, hourlySuccess = {}, hourlyNg = {}, hourlyByType = {}, byModel = {};
        const statusNotesByHour = {};
        Object.entries(assemblyStatusNotes.value).forEach(([key, note]) => {
            const separator = key.indexOf('::');
            if (separator < 0 || !note) return;
            const date = key.slice(0, separator);
            const hour = key.slice(separator + 2);
            if (!inRange(date, start, end)) return;
            (statusNotesByHour[hour] || (statusNotesByHour[hour] = [])).push({ date, note: String(note) });
        });
        Object.values(statusNotesByHour).forEach(items => items.sort((a, b) => a.date.localeCompare(b.date)));
        let success = 0, ng = 0, ignored = 0, unclassified = 0, parsedLines = 0;
        (batches || []).forEach(batch => Object.entries(batch.buckets || {}).forEach(([date, source]) => {
            if (!inRange(date, start, end)) return;
            const day = byDate[date] || (byDate[date] = { date, success: 0, ng: 0, byType: {}, byModel: {} });
            success += source.success || 0;
            ng += source.ng || 0;
            ignored += source.ignored || 0;
            unclassified += source.unclassified || 0;
            parsedLines += source.parsedLines || 0;
            day.success += source.success || 0;
            day.ng += source.ng || 0;
            Object.entries(source.byType || {}).forEach(([name, qty]) => {
                increment(byType, name, qty);
                increment(day.byType, name, qty);
            });
            Object.entries(source.sourceByType || {}).forEach(([category, messages]) => {
                const categoryMap = sourceByType[category] || (sourceByType[category] = {});
                Object.entries(messages || {}).forEach(([message, qty]) => increment(categoryMap, message, qty));
            });
            Object.entries(source.hourlySuccess || {}).forEach(([hour, qty]) => increment(hourlySuccess, hour, qty));
            Object.entries(source.hourlyNg || {}).forEach(([hour, qty]) => increment(hourlyNg, hour, qty));
            Object.entries(source.hourlyByType || {}).forEach(([category, hours]) => {
                const categoryHours = hourlyByType[category] || (hourlyByType[category] = {});
                Object.entries(hours || {}).forEach(([hour, qty]) => increment(categoryHours, hour, qty));
            });
            const sourceTotal = (source.success || 0) + (source.ng || 0);
            const detailedEvents = Array.isArray(source.events) && source.events.length === sourceTotal;
            const modelEntry = model => byModel[model] || (byModel[model] = { success: 0, ng: 0, byType: {} });
            if (detailedEvents) {
                source.events.forEach(event => {
                    const model = modelForLogTime(date, event.time);
                    const summary = modelEntry(model);
                    increment(day.byModel, model);
                    if (event.type === 'SUCCESS') summary.success++;
                    else if (event.type === 'NG') {
                        summary.ng++;
                        increment(summary.byType, event.category);
                    }
                });
            } else if (sourceTotal > 0) {
                // 舊批次沒有保存分鐘級 LOG 時間，保留資料並明確歸入未分機種。
                const summary = modelEntry(NO_MODEL);
                summary.success += source.success || 0;
                summary.ng += source.ng || 0;
                increment(day.byModel, NO_MODEL, sourceTotal);
                Object.entries(source.byType || {}).forEach(([name, qty]) => increment(summary.byType, name, qty));
            }
        }));
        const totalRecords = success + ng;
        const byTypeList = Object.entries(byType).map(([name, qty]) => ({
            name, qty, ratio: ng ? (qty / ng * 100).toFixed(1) : '0.0',
            sourceItems: Object.entries(sourceByType[name] || {})
                .map(([message, sourceQty]) => ({ message, qty: sourceQty, ratio: qty ? (sourceQty / qty * 100).toFixed(1) : '0.0' }))
                .sort((a, b) => b.qty - a.qty),
            hourly: Object.entries(hourlyByType[name] || {})
                .map(([hour, hourlyQty]) => {
                    const notes = statusNotesByHour[hour] || [];
                    return {
                        hour, label: hour + ':00–' + hour + ':59', qty: hourlyQty,
                        ratio: qty ? (hourlyQty / qty * 100).toFixed(1) : '0.0',
                        note: notes.map(item => notes.length > 1 ? `${item.date}：${item.note}` : item.note).join('\n')
                    };
                })
                .sort((a, b) => a.hour.localeCompare(b.hour))
        })).sort((a, b) => b.qty - a.qty);
        const byModelList = Object.entries(byModel).map(([name, summary]) => ({
            name,
            success: summary.success,
            ng: summary.ng,
            total: summary.success + summary.ng,
            successRate: summary.success + summary.ng ? (summary.success / (summary.success + summary.ng) * 100).toFixed(2) : '100.00',
            downtimeRate: (summary.success ? summary.ng / summary.success * 100 : 0).toFixed(2),
            byType: Object.entries(summary.byType || {}).map(([type, qty]) => ({
                name: type,
                qty,
                ratio: summary.ng ? (qty / summary.ng * 100).toFixed(1) : '0.0'
            })).sort((a, b) => b.qty - a.qty)
        })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh-Hant'));
        const daily = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)).map(day => ({
            ...day,
            total: day.success + day.ng,
            successRate: day.success + day.ng ? (day.success / (day.success + day.ng) * 100).toFixed(2) : '100.00',
            downtimeRate: (day.success ? day.ng / day.success * 100 : 0).toFixed(2),
            ngRate: day.success + day.ng ? (day.ng / (day.success + day.ng) * 100).toFixed(2) : '0.00'
        }));
        // 每小時平均只除以實際有成功或 NG 紀錄的作業日期，排除篩選區間內無作業的日期。
        const operationDays = daily.filter(day => day.success + day.ng > 0).length;
        const periodDays = Math.max(1, operationDays);
        const averagePerDay = value => Number((value / periodDays).toFixed(2));
        const hourly = Array.from({ length: 24 }, (_, i) => {
            const hour = String(i).padStart(2, '0');
            const production = averagePerDay(hourlySuccess[hour] || 0);
            const hourlyNgCount = averagePerDay(hourlyNg[hour] || 0);
            const total = production + hourlyNgCount;
            return {
                hour, label: hour + ':00–' + hour + ':59', production, ng: hourlyNgCount, total,
                successRate: total ? (production / total * 100).toFixed(2) : '100.00',
                downtimeRate: (production ? hourlyNgCount / production * 100 : 0).toFixed(2)
            };
        });
        const successRate = totalRecords ? success / totalRecords * 100 : 100;
        return {
            totalInput: success, totalSuccess: success, totalDefects: ng, totalRecords,
            yieldRate: successRate.toFixed(2),
            downtimeRate: (success ? ng / success * 100 : 0).toFixed(2),
            byType: byTypeList, byModel: byModelList, daily, hourly, ignored, unclassified, parsedLines,
            periodDays, totalDays: operationDays, topCause: byTypeList[0] || null
        };
    };

    const assemblyDefectOptions = computed(() => [...(data.value.defectTypes || [])].sort((a, b) => a.name.localeCompare(b.name)));
    const assemblyUnknownCurrent = computed(() => {
        const modal = assemblyUnknownModal.value;
        return modal.items[modal.currentIndex] || null;
    });
    const addAssemblyDefectType = async (name) => {
        const existing = (data.value.defectTypes || []).find(item => item.name === name);
        if (existing) return existing.name;
        const { error } = await _supabase.from('defect_types').insert({ name, line: 'ASSY' });
        if (error) {
            toast('新增不良項目失敗：' + error.message, 'error');
            return null;
        }
        await loadBaseData();
        return name;
    };
    const appendAssemblyMapping = async (logMessage, defectName) => {
        const mapping = { line: 'ASSY', logMessage: normalizeMessage(logMessage), defectName };
        assemblyMappings.value = [
            mapping,
            ...assemblyMappings.value.filter(item => item.logMessage !== mapping.logMessage)
        ];
        persistMappingStorage();
        if (assemblyMappingRemoteReady.value) {
            const saved = await saveMappingRemote(mapping);
            if (!saved) toast('對應已保存在本機，但共用資料庫寫入失敗', 'warning');
        }
    };
    const getAssemblyBatchDates = (batch) => Object.keys(batch?.buckets || {}).sort();
    const compactAssemblyBatches = (batches = []) => {
        const claimedDates = new Set();
        const cleanups = [];
        const compacted = [];
        const sorted = [...batches].sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')));
        sorted.forEach(batch => {
            const entries = Object.entries(batch.buckets || {});
            const remaining = entries.filter(([date]) => !claimedDates.has(date));
            if (!remaining.length) {
                if (batch.id) cleanups.push({ type: 'delete', id: batch.id });
                return;
            }
            const keptBatch = remaining.length === entries.length
                ? batch
                : { ...batch, buckets: Object.fromEntries(remaining) };
            if (keptBatch !== batch) cleanups.push({ type: 'upsert', batch: keptBatch });
            compacted.push(keptBatch);
            remaining.forEach(([date]) => claimedDates.add(date));
        });
        return { batches: compacted, cleanups };
    };
    const applyAssemblyBatchCleanups = async (cleanups = []) => {
        for (const cleanup of cleanups) {
            if (cleanup.type === 'upsert') await saveBatchRemote(cleanup.batch);
            else await deleteBatchRemote(cleanup.id);
        }
    };
    const createAssemblyBatch = (pending, parsed) => {
        const dates = getAssemblyBatchDates({ buckets: parsed.buckets });
        return {
        id: 'ASSY_' + (dates.join('_') || pending.fallbackDate),
        line: 'ASSY', fileName: pending.fileName, uploadedAt: new Date().toISOString(),
        encoding: pending.encoding, lineCount: parsed.lineCount,
        parsedLineCount: parsed.parsedLineCount, ignoredCount: parsed.ignoredCount,
        unclassifiedCount: parsed.unclassifiedCount, buckets: parsed.buckets
        };
    };
    const saveAssemblyBatch = async (pending, parsed) => {
        const batch = createAssemblyBatch(pending, parsed);
        const remoteSaved = await saveBatchRemote(batch);
        const newDates = new Set(getAssemblyBatchDates(batch));
        const prior = compactAssemblyBatches(assemblyBatches.value).batches;
        const cleanups = [];
        const retained = [];
        prior.forEach(oldBatch => {
            if (oldBatch.id === batch.id) return;
            const oldDates = getAssemblyBatchDates(oldBatch);
            const hasOverlap = oldDates.some(date => newDates.has(date));
            if (!hasOverlap) {
                retained.push(oldBatch);
                return;
            }
            const remainingEntries = Object.entries(oldBatch.buckets || {})
                .filter(([date]) => !newDates.has(date));
            if (remainingEntries.length) {
                const remainingBatch = { ...oldBatch, buckets: Object.fromEntries(remainingEntries) };
                retained.push(remainingBatch);
                cleanups.push({ type: 'upsert', batch: remainingBatch });
            } else {
                cleanups.push({ type: 'delete', id: oldBatch.id });
            }
        });
        if (assemblyRemoteReady.value && remoteSaved) await applyAssemblyBatchCleanups(cleanups);
        assemblyBatches.value = [batch, ...retained].slice(0, 100);
        persistStorage();
        assemblyLastFile.value = batch.fileName;
        const result = aggregate([batch]);
        await saveNewDefectTypes(result.byType.map(row => row.name));
        refreshAssemblyReport();
        assemblyStatsResult.value = aggregate(assemblyBatches.value, assemblyStatsFilter.value.start, assemblyStatsFilter.value.end);
        const dateCount = Object.keys(parsed.buckets).length;
        const storageNote = assemblyRemoteReady.value && !remoteSaved
            ? '；共用資料庫寫入失敗，目前只有本機可見'
            : (!assemblyRemoteReady.value ? '；共用資料表尚未設定，目前只有本機可見' : '');
        toast('LOG 分析完成：成功 ' + result.totalSuccess + '、NG ' + result.totalDefects + '，共 ' + dateCount + ' 天' + storageNote, storageNote ? 'warning' : 'success');
    };
    const resolveAssemblyUnknown = async () => {
        const modal = assemblyUnknownModal.value;
        const current = assemblyUnknownCurrent.value;
        if (!current) return;
        const selected = String(modal.selectedDefectName || '').trim();
        const created = String(modal.newDefectName || '').trim();
        if (selected && created) return toast('請選擇既有項目或新增項目其中一種', 'warning');
        if (!selected && !created) return toast('請選擇既有不良項目或輸入新的不良項目', 'warning');
        loading.value = true;
        try {
            const defectName = created ? await addAssemblyDefectType(created) : selected;
            if (!defectName) return;
            await appendAssemblyMapping(current.key, defectName);
            if (modal.currentIndex < modal.items.length - 1) {
                assemblyUnknownModal.value = { ...modal, currentIndex: modal.currentIndex + 1, selectedDefectName: '', newDefectName: '' };
                return;
            }
            const pendingState = pendingAssemblyUpload.value;
            pendingAssemblyUpload.value = null;
            assemblyUnknownModal.value = { show: false, items: [], currentIndex: 0, selectedDefectName: '', newDefectName: '' };
            if (pendingState) {
                const parsed = parseText(pendingState.pending.text, pendingState.pending.fallbackDate, assemblyMappings.value);
                if (parsed.unknownMessages.length) return toast('仍有未分類 LOG，請重新上傳處理', 'warning');
                await saveAssemblyBatch(pendingState.pending, parsed);
                pendingState.queue.success++;
                pendingState.queue.index++;
                await processAssemblyUploadQueue(pendingState.queue);
            }
        } finally {
            loading.value = false;
        }
    };
    const cancelAssemblyUnknown = () => {
        pendingAssemblyUpload.value = null;
        assemblyUnknownModal.value = { show: false, items: [], currentIndex: 0, selectedDefectName: '', newDefectName: '' };
        toast('已取消此次 LOG 上傳', 'info');
    };

    const assemblyBatchesForDate = computed(() => assemblyBatches.value.filter(batch => Object.prototype.hasOwnProperty.call(batch.buckets || {}, assemblyUploadDate.value)));
    const deleteAssemblyBatch = async (id) => {
        const batch = assemblyBatches.value.find(item => item.id === id);
        if (!batch || !confirm(`確定刪除 ${batch.fileName} 的 LOG 統計？`)) return;
        if (!(await deleteBatchRemote(id))) return;
        assemblyBatches.value = assemblyBatches.value.filter(item => item.id !== id);
        persistStorage();
        assemblyLastFile.value = assemblyBatches.value[0]?.fileName || '';
        refreshAssemblyReport();
        assemblyStatsResult.value = aggregate(assemblyBatches.value, assemblyStatsFilter.value.start, assemblyStatsFilter.value.end);
        toast('LOG 統計已刪除', 'info');
    };

    const assemblyQuickRange = (mode, offset) => {
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
    const assemblyQuickLabel = computed(() => {
        if (!assemblyQuickMode.value) return '';
        const { start, end } = assemblyQuickRange(assemblyQuickMode.value, assemblyQuickOffset.value);
        if (assemblyQuickMode.value === 'day') return `${fmtLocal(start)} (週${WEEKDAY_TW[start.getDay()]})`;
        if (assemblyQuickMode.value === 'week') {
            const sameYear = start.getFullYear() === end.getFullYear();
            return `${fmtLocal(start)} ~ ${sameYear ? fmtLocal(end).slice(5) : fmtLocal(end)}`;
        }
        return `${start.getFullYear()} 年 ${start.getMonth() + 1} 月`;
    });
    const assemblyQuickRelative = computed(() => {
        if (!assemblyQuickMode.value) return '';
        const offset = assemblyQuickOffset.value;
        const unit = { day: '日', week: '週', month: '月' }[assemblyQuickMode.value];
        if (offset === 0) return `本${unit}`;
        if (offset === -1) return `上一${unit}`;
        if (offset === 1) return `下一${unit}`;
        return offset < 0 ? `${Math.abs(offset)} ${unit}前` : `${offset} ${unit}後`;
    });
    const applyAssemblyQuick = async () => {
        if (!assemblyQuickMode.value) return;
        const { start, end } = assemblyQuickRange(assemblyQuickMode.value, assemblyQuickOffset.value);
        applyingAssemblyQuick = true;
        assemblyStatsFilter.value.start = fmtLocal(start);
        assemblyStatsFilter.value.end = fmtLocal(end);
        await Vue.nextTick();
        applyingAssemblyQuick = false;
        calculateAssemblyStats();
    };
    const setAssemblyQuickMode = (mode) => {
        assemblyQuickMode.value = mode;
        assemblyQuickOffset.value = { day: 0, week: -1, month: -1 }[mode];
        applyAssemblyQuick();
    };
    const shiftAssemblyQuick = (delta) => {
        if (!assemblyQuickMode.value) return;
        assemblyQuickOffset.value += delta;
        applyAssemblyQuick();
    };

    const saveNewDefectTypes = async (names) => {
        const existing = new Set((data.value.defectTypes || []).map(item => item.name));
        const newNames = [...new Set(names)].filter(name => name && !existing.has(name));
        if (!newNames.length) return;
        const failed = [];
        for (const name of newNames) {
            const { error } = await _supabase.from('defect_types').insert({ name, line: currentLine.value });
            if (error) failed.push(name);
        }
        if (newNames.length !== failed.length) await loadBaseData();
        if (failed.length) console.warn('組裝測試不良項目自動新增失敗', failed);
    };

    const refreshAssemblyReport = () => {
        if (currentLine.value !== 'ASSY') return;
        assemblyReportResult.value = aggregate(assemblyBatches.value, assemblyUploadDate.value, assemblyUploadDate.value);
    };
    const refreshAssemblyModelResults = () => {
        refreshAssemblyReport();
        if (assemblyStatsResult.value) assemblyStatsResult.value = aggregate(assemblyBatches.value, assemblyStatsFilter.value.start, assemblyStatsFilter.value.end);
        if (ctx.refreshDashboard && currentLine.value === 'ASSY') Promise.resolve(ctx.refreshDashboard()).catch(error => console.warn('Mylar 機種統計更新失敗', error));
    };
    const openAssemblyModelScheduleModal = () => {
        assemblyModelScheduleError.value = '';
        assemblyModelScheduleForm.value = {
            startTime: '00:00',
            endTime: '23:59',
            model: assemblyModelOptions.value[0] || ''
        };
        assemblyModelScheduleModal.value = { show: true };
    };
    const closeAssemblyModelScheduleModal = () => {
        assemblyModelScheduleModal.value = { show: false };
        assemblyModelScheduleError.value = '';
    };
    const formatAssemblyModelScheduleTime = field => {
        const digits = String(assemblyModelScheduleForm.value[field] || '').replace(/\D/g, '').slice(0, 4);
        assemblyModelScheduleForm.value[field] = digits.length >= 3
            ? `${digits.slice(0, 2)}:${digits.slice(2)}`
            : digits;
    };
    const addAssemblyModelSchedule = async () => {
        const form = assemblyModelScheduleForm.value;
        const start = timeToMinutes(form.startTime);
        const end = timeToMinutes(form.endTime, true);
        const model = String(form.model || '').trim();
        if (!/^\d{2}:\d{2}$/.test(String(form.startTime || '')) || !/^\d{2}:\d{2}$/.test(String(form.endTime || '')) || start === null || end === null) {
            assemblyModelScheduleError.value = '時間請使用 24 小時格式 HH:mm，例如 08:30。';
            return;
        }
        if (start >= end) {
            assemblyModelScheduleError.value = '開始時間必須早於結束時間。';
            return;
        }
        if (!model || !assemblyModelOptions.value.includes(model)) {
            assemblyModelScheduleError.value = '請選擇共用機種資料庫中的機種。';
            return;
        }
        const overlaps = assemblyModelSchedulesForDate.value.some(item => {
            const itemStart = timeToMinutes(item.startTime);
            const itemEnd = timeToMinutes(item.endTime, true);
            return itemStart !== null && itemEnd !== null && start < itemEnd && itemStart < end;
        });
        if (overlaps) {
            assemblyModelScheduleError.value = '此日期的時間區間與既有設定重疊，請調整後再新增。';
            return;
        }
        const schedule = {
            id: `ASSY_MODEL_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            date: assemblyUploadDate.value,
            startTime: form.startTime,
            endTime: form.endTime,
            model
        };
        assemblyModelSchedules.value = [...assemblyModelSchedules.value, schedule].sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
        persistModelSchedules();
        assemblyModelScheduleForm.value = { startTime: form.endTime === '23:59' ? '00:00' : form.endTime, endTime: '23:59', model: assemblyModelOptions.value[0] || '' };
        assemblyModelScheduleError.value = '';
        const remoteSaved = await saveModelScheduleRemote(schedule);
        refreshAssemblyModelResults();
        toast(remoteSaved || !assemblyModelScheduleRemoteReady.value ? 'Mylar 機種時段已新增' : '機種時段已儲存本機，共用資料庫寫入失敗', remoteSaved || !assemblyModelScheduleRemoteReady.value ? 'success' : 'warning');
    };
    const deleteAssemblyModelSchedule = async id => {
        const schedule = assemblyModelSchedules.value.find(item => item.id === id);
        if (!schedule || !confirm(`確定刪除 ${schedule.date} ${schedule.startTime}–${schedule.endTime} 的機種設定？`)) return;
        if (!(await deleteModelScheduleRemote(id))) return;
        assemblyModelSchedules.value = assemblyModelSchedules.value.filter(item => item.id !== id);
        persistModelSchedules();
        refreshAssemblyModelResults();
        toast('Mylar 機種時段已刪除', 'info');
    };
    const getAssemblyReportForDate = (date) => aggregate(assemblyBatches.value, date, date);
    const getAssemblyUploadedDates = (limit = 14) => {
        const dates = new Set();
        assemblyBatches.value.forEach(batch => Object.entries(batch.buckets || {}).forEach(([date, bucket]) => {
            const hasData = (bucket.parsedLines || 0) > 0 || (bucket.success || 0) + (bucket.ng || 0) + (bucket.ignored || 0) + (bucket.unclassified || 0) > 0;
            if (hasData) dates.add(date);
        }));
        return [...dates].sort().slice(-limit);
    };
    let assemblyLoadRequestId = 0;
    let assemblyRemoteLoadPromise = null;
    const refreshAssemblyAfterBackgroundLoad = () => {
        if (currentLine.value !== 'ASSY') return;
        refreshAssemblyReport();
        if (assemblyStatsResult.value) assemblyStatsResult.value = aggregate(assemblyBatches.value, assemblyStatsFilter.value.start, assemblyStatsFilter.value.end);
        if (!ctx.refreshDashboard) return;
        Promise.resolve(ctx.refreshDashboard()).then(refreshed => {
            if (refreshed !== false && currentTab.value === 'dashboard' && ctx.initDashboardCharts) return ctx.initDashboardCharts();
            return null;
        }).catch(error => console.warn('Mylar 儀表板背景更新失敗', error));
    };
    const loadAssemblyData = async ({ background = false } = {}) => {
        const localState = compactAssemblyBatches(readStorage());
        const localBatches = localState.batches;
        const localModelSchedules = readModelSchedules();
        assemblyModelSchedules.value = localModelSchedules;
        if (localState.cleanups.length) persistStorage(localBatches);
        if (currentLine.value !== 'ASSY') {
            assemblyLoadRequestId++;
            assemblyBatches.value = localBatches;
            refreshAssemblyReport();
            return;
        }
        if (assemblyRemoteLoadPromise) {
            if (background) return true;
            await assemblyRemoteLoadPromise;
            return true;
        }
        const requestId = ++assemblyLoadRequestId;
        const localBatchIdsAtStart = new Set(localBatches.map(batch => batch.id));
        assemblyBatches.value = localBatches;
        refreshAssemblyReport();
        const localMappings = readMappingStorage();
        const remotePromise = (async () => {
            const [{ data: remoteRows, error }, { data: remoteMappingRows, error: mappingError }, { data: remoteScheduleRows, error: scheduleError }] = await Promise.all([
                _supabase.from(REMOTE_TABLE)
                    .select('*').eq('line', 'ASSY').order('uploaded_at', { ascending: false }).limit(100),
                _supabase.from(MAPPING_TABLE)
                    .select('*').eq('line', 'ASSY').order('created_at', { ascending: false }).limit(500),
                _supabase.from(MODEL_SCHEDULE_TABLE)
                    .select('*').eq('line', 'ASSY').order('schedule_date', { ascending: true }).order('start_time', { ascending: true }).limit(1000)
            ]);
            if (requestId !== assemblyLoadRequestId || currentLine.value !== 'ASSY') return;
            if (error) {
                assemblyRemoteReady.value = false;
                assemblyRemoteError.value = error.code === 'PGRST205'
                    ? '尚未建立組裝 LOG 共用資料表'
                    : (error.message || '共用資料庫讀取失敗');
                assemblyBatches.value = compactAssemblyBatches(readStorage()).batches;
            } else {
                assemblyRemoteReady.value = true;
                assemblyRemoteError.value = '';
                let remoteBatches = (remoteRows || []).map(fromRemoteBatch);
                const latestLocalBatches = compactAssemblyBatches(readStorage()).batches;
                const pendingLocalBatches = latestLocalBatches.filter(batch => !localBatchIdsAtStart.has(batch.id));
                // 第一次建立資料表時，將這台電腦既有的本機批次搬到共用資料庫。
                if (!hasRemoteMigrationFlag() && localBatches.length && remoteBatches.length === 0) {
                    const { error: migrationError } = await _supabase.from(REMOTE_TABLE)
                        .upsert(localBatches.map(toRemoteBatch), { onConflict: 'id' });
                    if (!migrationError) {
                        remoteBatches = localBatches;
                        setRemoteMigrationFlag();
                    } else {
                        console.error('組裝測試 LOG 本機資料搬移失敗', migrationError);
                        assemblyRemoteError.value = migrationError.message || '本機資料搬移失敗';
                    }
                } else if (!hasRemoteMigrationFlag()) {
                    setRemoteMigrationFlag();
                }
                const remoteState = compactAssemblyBatches(remoteBatches);
                remoteBatches = remoteState.batches;
                await applyAssemblyBatchCleanups(remoteState.cleanups);
                for (const pendingBatch of pendingLocalBatches) await saveBatchRemote(pendingBatch);
                if (pendingLocalBatches.length) remoteBatches = compactAssemblyBatches([...remoteBatches, ...pendingLocalBatches]).batches;
                assemblyBatches.value = remoteBatches.slice(0, 100);
                persistStorage();
            }
            if (mappingError) {
                assemblyMappingRemoteReady.value = false;
                assemblyMappings.value = localMappings;
                if (!assemblyRemoteError.value) assemblyRemoteError.value = mappingError.code === 'PGRST205'
                    ? '尚未建立 LOG 不良對應資料表'
                    : (mappingError.message || 'LOG 對應資料庫讀取失敗');
            } else {
                assemblyMappingRemoteReady.value = true;
                let remoteMappings = (remoteMappingRows || []).map(fromRemoteMapping);
                if (!hasMappingMigrationFlag() && localMappings.length && remoteMappings.length === 0) {
                    const { error: mappingMigrationError } = await _supabase.from(MAPPING_TABLE)
                        .upsert(localMappings.map(toRemoteMapping), { onConflict: 'line,log_message' });
                    if (!mappingMigrationError) {
                        remoteMappings = localMappings;
                        setMappingMigrationFlag();
                    }
                } else if (!hasMappingMigrationFlag()) {
                    setMappingMigrationFlag();
                }
                assemblyMappings.value = remoteMappings;
                persistMappingStorage();
            }
            if (scheduleError) {
                assemblyModelScheduleRemoteReady.value = false;
                assemblyModelScheduleRemoteError.value = scheduleError.code === 'PGRST205'
                    ? '尚未建立 Mylar 機種時段資料表'
                    : (scheduleError.message || '機種時段資料庫讀取失敗');
                assemblyModelSchedules.value = localModelSchedules;
            } else {
                assemblyModelScheduleRemoteReady.value = true;
                assemblyModelScheduleRemoteError.value = '';
                let remoteSchedules = (remoteScheduleRows || []).map(fromRemoteModelSchedule);
                if (!hasModelScheduleMigrationFlag() && localModelSchedules.length && remoteSchedules.length === 0) {
                    const { error: scheduleMigrationError } = await _supabase.from(MODEL_SCHEDULE_TABLE)
                        .upsert(localModelSchedules.map(toRemoteModelSchedule), { onConflict: 'id' });
                    if (!scheduleMigrationError) {
                        remoteSchedules = localModelSchedules;
                        setModelScheduleMigrationFlag();
                    }
                } else if (!hasModelScheduleMigrationFlag()) {
                    setModelScheduleMigrationFlag();
                }
                const remoteScheduleIds = new Set(remoteSchedules.map(item => item.id));
                const pendingLocalSchedules = localModelSchedules.filter(item => !remoteScheduleIds.has(item.id));
                for (const pendingSchedule of pendingLocalSchedules) await saveModelScheduleRemote(pendingSchedule);
                assemblyModelSchedules.value = [...remoteSchedules, ...pendingLocalSchedules]
                    .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
                persistModelSchedules();
            }
            refreshAssemblyAfterBackgroundLoad();
        })();
        assemblyRemoteLoadPromise = remotePromise;
        const settled = remotePromise.finally(() => {
            if (assemblyRemoteLoadPromise === remotePromise) {
                assemblyRemoteLoadPromise = null;
                if (requestId !== assemblyLoadRequestId && currentLine.value === 'ASSY') loadAssemblyData({ background: true });
            }
        });
        if (background) {
            settled.catch(error => console.warn('Mylar 背景資料同步失敗', error));
            return true;
        }
        await settled;
        return true;
    };

    const finishAssemblyUploadQueue = queue => {
        if (queue.success) toast(`Mylar 完成 ${queue.success} 個檔案上傳${queue.failed.length ? `，失敗 ${queue.failed.length} 個` : ''}`, queue.failed.length ? 'warning' : 'success');
        else if (queue.failed.length) toast('Mylar 檔案全部處理失敗', 'error');
    };
    const processAssemblyUploadQueue = async queue => {
        for (let index = queue.index; index < queue.files.length; index++) {
            const file = queue.files[index];
            try {
                const decoded = decodeBytes(await file.arrayBuffer());
                const fallbackDate = today();
                const parsed = parseText(decoded.text, fallbackDate, assemblyMappings.value);
                setAssemblyDateFromParsedLog(parsed, fallbackDate);
                const pending = { text: decoded.text, fallbackDate, encoding: decoded.encoding, fileName: file.name };
                if (parsed.unknownMessages.length) {
                    queue.index = index;
                    pendingAssemblyUpload.value = { queue, pending };
                    assemblyUnknownModal.value = { show: true, items: parsed.unknownMessages, currentIndex: 0, selectedDefectName: '', newDefectName: '' };
                    toast('發現 ' + parsed.unknownMessages.length + ' 個尚未分類的 LOG 訊息，請逐筆設定不良項目', 'warning');
                    return false;
                }
                await saveAssemblyBatch(pending, parsed);
                queue.success++;
            } catch (error) {
                queue.failed.push(`${file.name}：${error.message}`);
            }
        }
        finishAssemblyUploadQueue(queue);
        return true;
    };
    const uploadAssemblyLog = async (event) => {
        const files = [...(event.target.files || [])].filter(file => /\.(txt|log|csv)$/i.test(file.name || ''));
        if (!files.length) return;
        const queue = { files, index: 0, success: 0, failed: [] };
        loading.value = true;
        try { await processAssemblyUploadQueue(queue); }
        finally {
            loading.value = false;
            event.target.value = '';
        }
    };

    const calculateAssemblyStats = () => {
        if (assemblyStatsFilter.value.start && assemblyStatsFilter.value.end && assemblyStatsFilter.value.start > assemblyStatsFilter.value.end) {
            return toast('開始日期不能晚於結束日期', 'warning');
        }
        assemblySourceDetail.value = { show: false, category: '', items: [], hourly: [], hourlyTitle: '每小時發生次數', hourlyHint: '', total: 0, note: '', draftNote: '', dailyTrend: [] };
        assemblyDailyDetail.value = { show: false, date: '', success: 0, ng: 0, downtimeRate: '0.00', byType: [] };
        assemblyStatsResult.value = aggregate(assemblyBatches.value, assemblyStatsFilter.value.start, assemblyStatsFilter.value.end);
        renderAssemblyStatsCharts();
    };
    const openAssemblySourceDetail = (category, result = assemblyStatsResult.value) => {
        const row = (result?.byType || []).find(item => item.name === category);
        const categoryHourly = row?.hourly || [];
        const hasCategoryHourly = categoryHourly.length > 0;
        const fallbackHourly = (result?.hourly || []).filter(item => item.total > 0).map(item => ({
            hour: item.hour,
            label: item.label,
            qty: item.ng,
            production: item.production,
            ratio: result?.totalDefects ? (item.ng / result.totalDefects * 100).toFixed(1) : '0.0',
            note: item.note || ''
        }));
        assemblySourceDetail.value = {
            show: true,
            category,
            items: row?.sourceItems || [],
            dailyTrend: (result?.daily || []).map(day => ({ date: day.date, qty: day.byType?.[category] || 0 })),
            hourly: (hasCategoryHourly ? categoryHourly : fallbackHourly).map(item => {
                const note = item.note || assemblyHourlyNotes.value[hourlyNoteKey(category, item.hour)] || '';
                return { ...item, note };
            }),
            hourlyTitle: hasCategoryHourly ? '每小時錯誤數' : '每小時錯誤數（當日總數）',
            hourlyHint: hasCategoryHourly ? '' : '此筆歷史資料未保存原因與小時的對應，以下顯示當日各時段錯誤數。',
            total: row?.qty || 0,
            note: assemblyDefectNotes.value[category] || '',
            draftNote: assemblyDefectNotes.value[category] || ''
        };
    };
    const openAssemblyReportSourceDetail = category => openAssemblySourceDetail(category, assemblyReportResult.value);
    const closeAssemblySourceDetail = () => {
        assemblySourceDetail.value = { show: false, category: '', items: [], hourly: [], hourlyTitle: '每小時發生次數', hourlyHint: '', total: 0, note: '', draftNote: '', dailyTrend: [] };
    };
    const openAssemblyDailyDetail = date => {
        const result = aggregate(assemblyBatches.value, date, date);
        const daily = result.daily.find(row => row.date === date);
        assemblyDailyDetail.value = {
            show: true,
            date,
            success: daily?.success || 0,
            ng: daily?.ng || 0,
            downtimeRate: daily?.downtimeRate || '0.00',
            byType: result.byType || []
        };
    };
    const closeAssemblyDailyDetail = () => {
        assemblyDailyDetail.value = { show: false, date: '', success: 0, ng: 0, downtimeRate: '0.00', byType: [] };
    };
    const saveAssemblyDefectNote = (category, note) => {
        const value = String(note || '').trim();
        assemblyDefectNotes.value = { ...assemblyDefectNotes.value, [category]: value };
        persistDefectNotes();
        assemblySourceDetail.value = { ...assemblySourceDetail.value, note: value, draftNote: value };
        toast('停機原因備註已儲存', 'success');
    };
    const saveAssemblyHourNote = (category, hour, note) => {
        const value = String(note || '').trim();
        const key = hourlyNoteKey(category, hour);
        assemblyHourlyNotes.value = { ...assemblyHourlyNotes.value, [key]: value };
        persistHourlyNotes();
        assemblySourceDetail.value = {
            ...assemblySourceDetail.value,
            hourly: assemblySourceDetail.value.hourly.map(item => item.hour === hour
                ? { ...item, note: value, draftNote: value }
                : item)
        };
        toast(value ? '每小時備註已儲存' : '每小時備註已清除', 'success');
    };
    watch(() => [assemblyStatsFilter.value.start, assemblyStatsFilter.value.end], () => {
        if (!applyingAssemblyQuick) assemblyQuickMode.value = null;
    });

    const exportAssemblyStats = () => {
        const result = assemblyStatsResult.value;
        if (!result) return toast('請先執行 Mylar 統計', 'warning');
        const range = (assemblyStatsFilter.value.start || '不限') + ' ~ ' + (assemblyStatsFilter.value.end || '不限');
        const summary = [
            ['統計區間', range], ['產出成功', result.totalSuccess], ['NG / 停機不良', result.totalDefects],
            ['停機率', result.downtimeRate + '%'], ['LOG 總紀錄', result.totalRecords], ['每小時平均天數', result.periodDays],
            ['忽略行數', result.ignored], ['未分類行數', result.unclassified], [],
            ['停機／不良原因', '次數', '佔 NG 比例'],
            ...result.byType.map(row => [row.name, row.qty, row.ratio + '%'])
        ];
        const daily = [['日期', '生產成功', 'NG 次數', '停機率'],
            ...result.daily.map(row => [row.date, row.success, row.ng, row.downtimeRate + '%'])];
        const models = [['機種', '產出成功', 'NG', '總數', '成功率', '停機率'],
            ...(result.byModel || []).map(row => [row.name, row.success, row.ng, row.total, row.successRate + '%', row.downtimeRate + '%'])];
        const pareto = [['停機／不良現象', '次數', '佔 NG 比例'],
            ...result.byType.map(row => [row.name, row.qty, row.ratio + '%'])];
        const yieldTrend = [['日期', '產出成功', '停機／不良', '良率'],
            ...result.daily.map(row => [row.date, row.success, row.ng, row.successRate + '%'])];
        const outputTrend = [['日期', '產出數', '停機／不良'],
            ...result.daily.map(row => [row.date, row.success, row.ng])];
        const hourly = [['時段', '平均每日生產成功', '平均每日 NG', '平均每日紀錄', '停機率'],
            ...result.hourly.map(row => [row.label, row.production, row.ng, row.total, row.downtimeRate + '%'])];
        const sourceDetails = [['停機／不良項目', 'LOG 原始訊息', '次數', '占該分類比例'],
            ...result.byType.flatMap(row => (row.sourceItems || []).map(item => [row.name, item.message, item.qty, item.ratio + '%']))];
        const dailyDefects = [['日期', 'NG 項目', '數量', '占當日 NG 比例'],
            ...result.daily.flatMap(day => Object.entries(day.byType || {}).map(([name, qty]) => [day.date, name, qty, day.ng ? (qty / day.ng * 100).toFixed(1) + '%' : '0.0%']))];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), '統計');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(yieldTrend), '良率趨勢');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(outputTrend), '產出趨勢');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(models), '機種統計');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pareto), 'Pareto分析');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(daily), '每日統計');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(hourly), '每小時統計');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dailyDefects), '每日NG細項');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sourceDetails), 'LOG原始細項');
        XLSX.writeFile(wb, 'KOYA_ASSY_LOG_' + (assemblyStatsFilter.value.start || today()) + '.xlsx');
        toast('Mylar LOG 報表已導出');
    };

    let reportChart = null, statsChart = null, statsDailyChart = null;
    const renderChart = (id, result, previous, setPrevious, onClick) => {
        Vue.nextTick(() => {
            const el = document.getElementById(id);
            if (!result || !el) {
                if (previous) previous.dispose();
                setPrevious(null);
                return;
            }
            if (!previous || previous.getDom() !== el) {
                if (previous) previous.dispose();
                previous = echarts.init(el);
                setPrevious(previous);
            }
            const rows = result.byType.slice(0, 12);
            const names = rows.map(row => row.name);
            previous.setOption({
                tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
                grid: { top: 28, right: 20, bottom: 70, left: 48 },
                xAxis: { type: 'category', data: names, axisLabel: { rotate: names.some(name => name.length > 5) ? 25 : 0, fontSize: 10 } },
                yAxis: { type: 'value', name: 'NG 次數' },
                series: [{ type: 'bar', data: rows.map(row => row.qty), barMaxWidth: 42, itemStyle: { color: '#dc2626', borderRadius: [4, 4, 0, 0] }, label: { show: true, position: 'top' } }]
            });
            if (previous.off) previous.off('click');
            if (onClick && previous.on) {
                previous.on('click', params => {
                    if (params?.componentType === 'series' && params.name) onClick(params.name);
                });
            }
        });
    };
    const renderAssemblyReportChart = () => renderChart('assemblyReportChart', assemblyReportResult.value, reportChart, value => { reportChart = value; }, openAssemblyReportSourceDetail);
    const renderParetoChart = (id, result, previous, setPrevious, onClick) => {
        Vue.nextTick(() => {
            const el = document.getElementById(id);
            if (!result || !result.byType.length || !el) {
                if (previous) previous.dispose();
                setPrevious(null);
                return;
            }
            if (!previous || previous.getDom() !== el) {
                if (previous) previous.dispose();
                previous = echarts.init(el);
                setPrevious(previous);
            }
            const rows = result.byType.slice(0, 12);
            const names = rows.map(row => row.name);
            const quantities = rows.map(row => row.qty);
            previous.setOption({
                tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
                legend: { data: ['停機／不良次數'], top: 8, right: 10, textStyle: { fontSize: 11, color: '#6b7280' } },
                grid: { top: 64, right: 58, bottom: 64, left: 48 },
                xAxis: { type: 'category', data: names, triggerEvent: true, axisLabel: { rotate: names.some(name => name.length > 5) ? 20 : 0, fontSize: 10, color: '#374151' }, axisLine: { lineStyle: { color: '#e5e7eb' } } },
                yAxis: { type: 'value', name: '次數', nameTextStyle: { color: '#6b7280', fontSize: 10 }, axisLabel: { fontSize: 10, color: '#9ca3af' }, splitLine: { lineStyle: { color: '#f3f4f6' } } },
                series: [{ name: '停機／不良次數', type: 'bar', data: quantities, barMaxWidth: 40, itemStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: '#dc2626' }, { offset: 1, color: '#fca5a5' }] }, borderRadius: [4, 4, 0, 0] }, label: { show: true, position: 'top', fontSize: 10 } }]
            });
            if (previous.off) previous.off('click');
            if (onClick && previous.on) {
                previous.on('click', params => {
                    if (params?.componentType === 'series' && params.name) onClick(params.name);
                });
            }
        });
    };
    const renderAssemblyStatsCharts = () => {
        renderParetoChart('assemblyStatsChart', assemblyStatsResult.value, statsChart, value => { statsChart = value; }, openAssemblySourceDetail);
        Vue.nextTick(() => {
            const el = document.getElementById('assemblyDailyChart');
            const result = assemblyStatsResult.value;
            if (!result?.daily?.length || !el) {
                if (statsDailyChart) statsDailyChart.dispose();
                statsDailyChart = null;
                return;
            }
            if (!statsDailyChart || statsDailyChart.getDom() !== el) {
                if (statsDailyChart) statsDailyChart.dispose();
                statsDailyChart = echarts.init(el);
            }
            statsDailyChart.setOption({
                tooltip: { trigger: 'axis', formatter: params => `${params[0]?.axisValue || ''}<br/>${params[0]?.marker || ''}產出數: <b>${Number(params[0]?.value || 0).toLocaleString()}</b>` },
                legend: { data: ['產出數'], top: 8, right: 0, textStyle: { fontSize: 11 } },
                grid: { top: 56, right: 20, bottom: 44, left: 48 },
                xAxis: { type: 'category', data: result.daily.map(row => row.date.slice(5)), axisLabel: { fontSize: 10 } },
                yAxis: { type: 'value', name: '產出', min: 0, axisLabel: { fontSize: 10, color: '#9ca3af' }, splitLine: { lineStyle: { color: '#f3f4f6' } } },
                series: [{ name: '產出數', type: 'bar', data: result.daily.map(row => row.success), barMaxWidth: 24, itemStyle: { color: '#fed7aa', borderRadius: [4, 4, 0, 0] }, label: { show: true, position: 'top', formatter: '{c}', fontSize: 9 } }]
            });
        });
    };

    let sourceTrendChart = null;
    const renderAssemblySourceTrendChart = () => {
        Vue.nextTick(() => {
            const el = document.getElementById('assemblySourceTrendChart');
            const trend = assemblySourceDetail.value?.dailyTrend || [];
            if (!el || !assemblySourceDetail.value.show || !trend.length) {
                if (sourceTrendChart) sourceTrendChart.dispose();
                sourceTrendChart = null;
                return;
            }
            if (!sourceTrendChart || sourceTrendChart.getDom() !== el) {
                if (sourceTrendChart) sourceTrendChart.dispose();
                sourceTrendChart = echarts.init(el);
            }
            const labels = trend.map(row => row.date.slice(5));
            const values = trend.map(row => row.qty);
            sourceTrendChart.setOption({
                tooltip: { trigger: 'axis', formatter: params => `${params[0]?.axisValue || ''}<br/>${params.map(item => `${item.marker}${item.seriesName}: <b>${Number(item.value || 0).toLocaleString()}</b>`).join('<br/>')}` },
                legend: { data: ['每日發生次數', '趨勢線'], top: 8, right: 10, textStyle: { fontSize: 11, color: '#6b7280' } },
                grid: { top: 58, right: 20, bottom: 44, left: 48 },
                xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 10, color: '#9ca3af' }, axisLine: { lineStyle: { color: '#e5e7eb' } } },
                yAxis: { type: 'value', name: '次數', min: 0, axisLabel: { fontSize: 10, color: '#9ca3af' }, splitLine: { lineStyle: { color: '#f3f4f6' } } },
                series: [
                    { name: '每日發生次數', type: 'bar', data: values, barMaxWidth: 24, itemStyle: { color: '#fca5a5', borderRadius: [4, 4, 0, 0] }, label: { show: true, position: 'top', fontSize: 9 } },
                    { name: '趨勢線', type: 'line', data: values, smooth: true, symbol: 'circle', symbolSize: 6, lineStyle: { color: '#dc2626', width: 2.5 }, itemStyle: { color: '#dc2626' } }
                ]
            });
        });
    };

    assemblyBatches.value = compactAssemblyBatches(readStorage()).batches;
    assemblyModelSchedules.value = readModelSchedules();
    assemblyDefectNotes.value = readDefectNotes();
    assemblyHourlyNotes.value = readHourlyNotes();
    assemblyStatusNotes.value = readStatusNotes();
    refreshAssemblyReport();
    watch(assemblyUploadDate, () => {
        refreshAssemblyReport();
        if (assemblyStatusNoteEditorOpen.value) syncAssemblyStatusNoteDraft();
    });
    watch(assemblyStatusNoteHour, () => {
        if (assemblyStatusNoteEditorOpen.value) syncAssemblyStatusNoteDraft();
    });
    watch(assemblyReportResult, renderAssemblyReportChart);
    watch(assemblyStatsResult, renderAssemblyStatsCharts);
    watch(assemblySourceDetail, renderAssemblySourceTrendChart);
    watch(currentTab, tab => {
        if (tab === 'report' && currentLine.value === 'ASSY') renderAssemblyReportChart();
        if (tab === 'stats' && currentLine.value === 'ASSY') renderAssemblyStatsCharts();
    });
    watch(currentLine, line => {
        if (line === 'ASSY') {
            refreshAssemblyReport();
            assemblyStatsResult.value = aggregate(assemblyBatches.value, assemblyStatsFilter.value.start, assemblyStatsFilter.value.end);
        }
    });
    window.addEventListener('resize', () => {
        if (reportChart) reportChart.resize();
        if (statsChart) statsChart.resize();
        if (statsDailyChart) statsDailyChart.resize();
        if (sourceTrendChart) sourceTrendChart.resize();
    });

    return {
        assemblyUploadDate, assemblyUploadDateLabel, assemblyUploadDateRelative, assemblyBatchesForDate,
        assemblyRemoteReady, assemblyRemoteError, assemblyMappingRemoteReady, assemblyCloudReady,
        assemblyModelScheduleRemoteReady, assemblyModelScheduleRemoteError, assemblyModelSchedules, assemblyModelSchedulesForDate,
        assemblyModelOptions, assemblyModelScheduleModal, assemblyModelScheduleForm, assemblyModelScheduleError,
        assemblyBatches, assemblyLastFile, assemblyReportResult, assemblySourceDetail, assemblyDailyDetail,
        assemblyStatsFilter, assemblyStatsResult, assemblyQuickMode, assemblyQuickOffset, assemblyQuickLabel, assemblyQuickRelative,
        assemblyDefectNotes, assemblyHourlyNotes, assemblyStatusNotes, assemblyStatusNoteHours, assemblyStatusNoteEditorOpen, assemblyStatusNoteHour, assemblyStatusNoteDraft, assemblyStatusNoteCurrent,
        assemblyDefectOptions, assemblyUnknownModal, assemblyUnknownCurrent,
        uploadAssemblyLog, refreshAssemblyReport, loadAssemblyData,
        getAssemblyReportForDate, getAssemblyUploadedDates,
        calculateAssemblyStats, exportAssemblyStats, deleteAssemblyBatch, shiftAssemblyUploadDate, openAssemblySourceDetail, openAssemblyReportSourceDetail, closeAssemblySourceDetail, openAssemblyDailyDetail, closeAssemblyDailyDetail, saveAssemblyDefectNote, saveAssemblyHourNote, toggleAssemblyStatusNoteEditor, saveAssemblyStatusNote,
        openAssemblyModelScheduleModal, closeAssemblyModelScheduleModal, formatAssemblyModelScheduleTime, addAssemblyModelSchedule, deleteAssemblyModelSchedule,
        setAssemblyQuickMode, shiftAssemblyQuick, resolveAssemblyUnknown, cancelAssemblyUnknown,
        renderAssemblyReportChart, renderAssemblyStatsCharts
    };
};
