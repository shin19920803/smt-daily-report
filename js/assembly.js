window.SMT = window.SMT || {};

// Mylar 機台 LOG：瀏覽器版的 Python LOG 自動統計工具
SMT.assembly = function (ctx) {
    const { toast, loading, currentLine, currentTab, data, loadBaseData, requestPermission } = ctx;
    const STORAGE_KEY = 'koya_assy_log_batches_v1';
    const REMOTE_TABLE = 'assembly_log_batches';
    const REMOTE_MIGRATED_KEY = 'koya_assy_log_remote_migrated_v1';
    const MAPPING_STORAGE_KEY = 'koya_assy_log_mappings_v1';
    const MAPPING_TABLE = 'assembly_log_mappings';
    const MAPPING_MIGRATED_KEY = 'koya_assy_log_mapping_migrated_v1';
    const today = () => new Date().toISOString().split('T')[0];

    const assemblyUploadDate = ref(today());
    const assemblyBatches = ref([]);
    const assemblyLastFile = ref('');
    const assemblyReportResult = ref(null);
    const assemblyStatsFilter = ref({ start: today(), end: today() });
    const assemblyStatsResult = ref(null);
    const assemblyRemoteReady = ref(false);
    const assemblyRemoteError = ref('');
    const assemblyMappingRemoteReady = ref(false);
    const assemblyCloudReady = computed(() => assemblyRemoteReady.value && assemblyMappingRemoteReady.value);
    const assemblyMappings = ref([]);
    const pendingAssemblyUpload = ref(null);
    const assemblyUnknownModal = ref({ show: false, items: [], currentIndex: 0, selectedDefectName: '', newDefectName: '' });
    const assemblySourceDetail = ref({ show: false, category: '', items: [], total: 0 });
    const assemblyQuickMode = ref(null);
    const assemblyQuickOffset = ref(0);
    let applyingAssemblyQuick = false;

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
        byType: {}, sourceByType: {}, hourlySuccess: {}, hourlyNg: {}
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
                increment(bucket.hourlySuccess, parsed.time.slice(0, 2));
            } else {
                bucket.ng++;
                increment(bucket.byType, result.category);
                const sourceMessage = normalizeMessage(parsed.message);
                const sourceMap = bucket.sourceByType[result.category] || (bucket.sourceByType[result.category] = {});
                increment(sourceMap, sourceMessage);
                increment(bucket.hourlyNg, parsed.time.slice(0, 2));
            }
        });
        return { buckets, parsedLineCount, ignoredCount, unclassifiedCount, lineCount: lines.length, unknownMessages: [...unknownMap.values()] };
    };

    const inRange = (date, start, end) => (!start || date >= start) && (!end || date <= end);
    const aggregate = (batches, start = '', end = '') => {
        const byType = {}, byDate = {}, sourceByType = {}, hourlySuccess = {}, hourlyNg = {};
        let success = 0, ng = 0, ignored = 0, unclassified = 0, parsedLines = 0;
        (batches || []).forEach(batch => Object.entries(batch.buckets || {}).forEach(([date, source]) => {
            if (!inRange(date, start, end)) return;
            const day = byDate[date] || (byDate[date] = { date, success: 0, ng: 0, byType: {} });
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
        }));
        const totalRecords = success + ng;
        const byTypeList = Object.entries(byType).map(([name, qty]) => ({
            name, qty, ratio: ng ? (qty / ng * 100).toFixed(1) : '0.0',
            sourceItems: Object.entries(sourceByType[name] || {})
                .map(([message, sourceQty]) => ({ message, qty: sourceQty, ratio: qty ? (sourceQty / qty * 100).toFixed(1) : '0.0' }))
                .sort((a, b) => b.qty - a.qty)
        })).sort((a, b) => b.qty - a.qty);
        const daily = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)).map(day => ({
            ...day,
            total: day.success + day.ng,
            successRate: day.success + day.ng ? (day.success / (day.success + day.ng) * 100).toFixed(2) : '100.00',
            downtimeRate: (day.success ? day.ng / day.success * 100 : 0).toFixed(2),
            ngRate: day.success + day.ng ? (day.ng / (day.success + day.ng) * 100).toFixed(2) : '0.00'
        }));
        const hourly = Array.from({ length: 24 }, (_, i) => {
            const hour = String(i).padStart(2, '0');
            const production = hourlySuccess[hour] || 0;
            const hourlyNgCount = hourlyNg[hour] || 0;
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
            byType: byTypeList, daily, hourly, ignored, unclassified, parsedLines,
            totalDays: daily.length, topCause: byTypeList[0] || null
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
    const createAssemblyBatch = (pending, parsed) => ({
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        line: 'ASSY', fileName: pending.fileName, uploadedAt: new Date().toISOString(),
        encoding: pending.encoding, lineCount: parsed.lineCount,
        parsedLineCount: parsed.parsedLineCount, ignoredCount: parsed.ignoredCount,
        unclassifiedCount: parsed.unclassifiedCount, buckets: parsed.buckets
    });
    const saveAssemblyBatch = async (pending, parsed) => {
        const batch = createAssemblyBatch(pending, parsed);
        const remoteSaved = await saveBatchRemote(batch);
        assemblyBatches.value = [batch, ...assemblyBatches.value].slice(0, 100);
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
            const pending = pendingAssemblyUpload.value;
            pendingAssemblyUpload.value = null;
            assemblyUnknownModal.value = { show: false, items: [], currentIndex: 0, selectedDefectName: '', newDefectName: '' };
            if (pending) {
                const parsed = parseText(pending.text, pending.fallbackDate, assemblyMappings.value);
                if (parsed.unknownMessages.length) return toast('仍有未分類 LOG，請重新上傳處理', 'warning');
                await saveAssemblyBatch(pending, parsed);
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
        if (!(await requestPermission('刪除 Mylar LOG'))) return;
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
    const getAssemblyReportForDate = (date) => aggregate(assemblyBatches.value, date, date);
    const getAssemblyUploadedDates = (limit = 14) => {
        const dates = new Set();
        assemblyBatches.value.forEach(batch => Object.entries(batch.buckets || {}).forEach(([date, bucket]) => {
            if ((bucket.parsedLines || 0) > 0) dates.add(date);
        }));
        return [...dates].sort().slice(-limit);
    };
    const loadAssemblyData = async () => {
        const localBatches = readStorage();
        if (currentLine.value !== 'ASSY') {
            assemblyBatches.value = localBatches;
            refreshAssemblyReport();
            return;
        }
        const { data: remoteRows, error } = await _supabase.from(REMOTE_TABLE)
            .select('*').eq('line', 'ASSY').order('uploaded_at', { ascending: false }).limit(100);
        if (error) {
            assemblyRemoteReady.value = false;
            assemblyRemoteError.value = error.code === 'PGRST205'
                ? '尚未建立組裝 LOG 共用資料表'
                : (error.message || '共用資料庫讀取失敗');
            assemblyBatches.value = localBatches;
        } else {
            assemblyRemoteReady.value = true;
            assemblyRemoteError.value = '';
            let remoteBatches = (remoteRows || []).map(fromRemoteBatch);
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
            assemblyBatches.value = remoteBatches.slice(0, 100);
            persistStorage();
        }
        const localMappings = readMappingStorage();
        const { data: remoteMappingRows, error: mappingError } = await _supabase.from(MAPPING_TABLE)
            .select('*').eq('line', 'ASSY').order('created_at', { ascending: false }).limit(500);
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
        refreshAssemblyReport();
        if (currentLine.value === 'ASSY') {
            assemblyStatsResult.value = aggregate(assemblyBatches.value, assemblyStatsFilter.value.start, assemblyStatsFilter.value.end);
        }
    };

    const uploadAssemblyLog = async (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        loading.value = true;
        try {
            const decoded = decodeBytes(await file.arrayBuffer());
            const fallbackDate = today();
            const parsed = parseText(decoded.text, fallbackDate, assemblyMappings.value);
            setAssemblyDateFromParsedLog(parsed, fallbackDate);
            const pending = { text: decoded.text, fallbackDate, encoding: decoded.encoding, fileName: file.name };
            if (parsed.unknownMessages.length) {
                pendingAssemblyUpload.value = pending;
                assemblyUnknownModal.value = { show: true, items: parsed.unknownMessages, currentIndex: 0, selectedDefectName: '', newDefectName: '' };
                toast('發現 ' + parsed.unknownMessages.length + ' 個尚未分類的 LOG 訊息，請逐筆設定不良項目', 'warning');
            } else {
                await saveAssemblyBatch(pending, parsed);
            }
        } catch (e) {
            console.error(e);
            toast('LOG 分析失敗：' + e.message, 'error');
        } finally {
            loading.value = false;
            event.target.value = '';
        }
    };

    const calculateAssemblyStats = () => {
        if (assemblyStatsFilter.value.start && assemblyStatsFilter.value.end && assemblyStatsFilter.value.start > assemblyStatsFilter.value.end) {
            return toast('開始日期不能晚於結束日期', 'warning');
        }
        assemblySourceDetail.value = { show: false, category: '', items: [], total: 0 };
        assemblyStatsResult.value = aggregate(assemblyBatches.value, assemblyStatsFilter.value.start, assemblyStatsFilter.value.end);
        renderAssemblyStatsCharts();
    };
    const openAssemblySourceDetail = (category) => {
        const row = (assemblyStatsResult.value?.byType || []).find(item => item.name === category);
        assemblySourceDetail.value = {
            show: true,
            category,
            items: row?.sourceItems || [],
            total: row?.qty || 0
        };
    };
    const closeAssemblySourceDetail = () => {
        assemblySourceDetail.value = { show: false, category: '', items: [], total: 0 };
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
            ['停機率', result.downtimeRate + '%'], ['LOG 總紀錄', result.totalRecords],
            ['忽略行數', result.ignored], ['未分類行數', result.unclassified], [],
            ['停機／不良原因', '次數', '佔 NG 比例'],
            ...result.byType.map(row => [row.name, row.qty, row.ratio + '%'])
        ];
        const daily = [['日期', '生產成功', 'NG 次數', '成功與 NG 總紀錄', '停機率'],
            ...result.daily.map(row => [row.date, row.success, row.ng, row.total, row.downtimeRate + '%'])];
        const hourly = [['時段', '生產成功', 'NG 次數', '成功與 NG 總紀錄', '停機率'],
            ...result.hourly.map(row => [row.label, row.production, row.ng, row.total, row.downtimeRate + '%'])];
        const sourceDetails = [['停機／不良項目', 'LOG 原始訊息', '次數', '占該分類比例'],
            ...result.byType.flatMap(row => (row.sourceItems || []).map(item => [row.name, item.message, item.qty, item.ratio + '%']))];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), '統計');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(daily), '每日統計');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(hourly), '每小時統計');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sourceDetails), 'LOG原始細項');
        XLSX.writeFile(wb, 'KOYA_ASSY_LOG_' + (assemblyStatsFilter.value.start || today()) + '.xlsx');
        toast('Mylar LOG 報表已導出');
    };

    let reportChart = null, statsChart = null, statsPieChart = null, statsDailyChart = null;
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
    const renderAssemblyReportChart = () => renderChart('assemblyReportChart', assemblyReportResult.value, reportChart, value => { reportChart = value; });
    const renderPieChart = (id, result, previous, setPrevious) => {
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
            previous.setOption({
                tooltip: { trigger: 'item', formatter: '{b}<br/>數量：{c}<br/>比例：{d}%' },
                legend: { show: false },
                series: [{ type: 'pie', radius: ['38%', '68%'], center: ['34%', '50%'], avoidLabelOverlap: true,
                    itemStyle: { borderColor: '#fff', borderWidth: 2 },
                    label: { show: false },
                    labelLine: { show: false },
                    data: result.byType.map(row => ({ name: row.name, value: row.qty }))
                }]
            });
        });
    };
    const renderAssemblyStatsCharts = () => {
        renderChart('assemblyStatsChart', assemblyStatsResult.value, statsChart, value => { statsChart = value; }, openAssemblySourceDetail);
        renderPieChart('assemblyStatsPieChart', assemblyStatsResult.value, statsPieChart, value => { statsPieChart = value; });
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
                tooltip: { trigger: 'axis' },
                legend: { top: 0, right: 0, textStyle: { fontSize: 11 } },
                grid: { top: 32, right: 20, bottom: 44, left: 48 },
                xAxis: { type: 'category', data: result.daily.map(row => row.date.slice(5)), axisLabel: { fontSize: 10 } },
                yAxis: { type: 'value', name: '數量', minInterval: 1, axisLabel: { fontSize: 10 } },
                series: [
                    { name: '產出成功', type: 'bar', data: result.daily.map(row => row.success), barMaxWidth: 30, itemStyle: { color: '#2563eb' } },
                    { name: '停機／不良', type: 'bar', data: result.daily.map(row => row.ng), barMaxWidth: 30, itemStyle: { color: '#dc2626' } }
                ]
            });
        });
    };

    assemblyBatches.value = readStorage();
    refreshAssemblyReport();
    watch(assemblyUploadDate, refreshAssemblyReport);
    watch(assemblyReportResult, renderAssemblyReportChart);
    watch(assemblyStatsResult, renderAssemblyStatsCharts);
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
        if (statsPieChart) statsPieChart.resize();
        if (statsDailyChart) statsDailyChart.resize();
    });

    return {
        assemblyUploadDate, assemblyUploadDateLabel, assemblyUploadDateRelative, assemblyBatchesForDate,
        assemblyRemoteReady, assemblyRemoteError, assemblyMappingRemoteReady, assemblyCloudReady,
        assemblyBatches, assemblyLastFile, assemblyReportResult, assemblySourceDetail,
        assemblyStatsFilter, assemblyStatsResult, assemblyQuickMode, assemblyQuickOffset, assemblyQuickLabel, assemblyQuickRelative,
        assemblyDefectOptions, assemblyUnknownModal, assemblyUnknownCurrent,
        uploadAssemblyLog, refreshAssemblyReport, loadAssemblyData,
        getAssemblyReportForDate, getAssemblyUploadedDates,
        calculateAssemblyStats, exportAssemblyStats, deleteAssemblyBatch, shiftAssemblyUploadDate, openAssemblySourceDetail, closeAssemblySourceDetail,
        setAssemblyQuickMode, shiftAssemblyQuick, resolveAssemblyUnknown, cancelAssemblyUnknown,
        renderAssemblyReportChart, renderAssemblyStatsCharts
    };
};
