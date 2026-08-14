window.SMT = window.SMT || {};
SMT.stats = function (ctx) {
        const { toast, loading, currentTab, fpyTargets, currentLine, currentLineMeta } = ctx;

        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayValue = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
        const statsFilter = ref({ start: yesterdayValue, end: yesterdayValue, modelId: 'all', woId: 'all' });
        const statsResult = ref(null);
        let smtStatsDataCache = null;

        // 本區間是否真的有不良資料（決定圖表要不要顯示，避免殘留上一次查詢結果）
        const hasDefects = computed(() => !!statsResult.value && statsResult.value.byType.length > 0);

        // ================= 表格排序 =================
        // key 以 'type:<現象名>' 開頭者代表趨勢表的動態現象欄位
        // 用 reactive 而非 ref：ref 在 template 中會被自動解包，
        // 傳進 toggleSort/sortIcon 後就拿不到 .value 了。
        const modelSort = reactive({ key: 'defects', dir: 'desc' });
        const woSort    = reactive({ key: 'defects', dir: 'desc' });
        const trendSort = reactive({ key: 'date',    dir: 'desc' });   // 日期預設由近到遠

        const NUMERIC_KEYS = ['input', 'defects', 'rate', 'ratio', 'defectRate'];
        const DATE_KEYS = ['date'];
        const isNumericKey = (key) => NUMERIC_KEYS.includes(key) || key.startsWith('type:');
        const toggleSort = (s, key) => {
            if (s.key === key) {
                s.dir = s.dir === 'asc' ? 'desc' : 'asc';
            } else {
                // 數值與日期預設由大到小（最新/最嚴重在前），文字欄位由小到大
                s.key = key;
                s.dir = (isNumericKey(key) || DATE_KEYS.includes(key)) ? 'desc' : 'asc';
            }
        };
        const sortIcon = (s, key) => {
            if (s.key !== key) return 'fa-sort';
            return s.dir === 'asc' ? 'fa-sort-up' : 'fa-sort-down';
        };
        const ariaSort = (s, key) => {
            if (s.key !== key) return 'none';
            return s.dir === 'asc' ? 'ascending' : 'descending';
        };
        const applySort = (list, s) => {
            const { key, dir } = s;
            if (!key || !list) return list || [];
            const mult = dir === 'asc' ? 1 : -1;
            const isType = key.startsWith('type:');
            const isNum = isNumericKey(key);
            const pick = (row) => isType ? (row.byType?.[key.slice(5)] || 0) : row[key];
            return [...list].sort((a, b) => {
                const va = pick(a), vb = pick(b);
                if (isNum) {
                    const d = (parseFloat(va) || 0) - (parseFloat(vb) || 0);
                    return d !== 0 ? d * mult : 0;
                }
                return String(va ?? '').localeCompare(String(vb ?? ''), 'zh-Hant') * mult;
            });
        };

        const sortedByModel = computed(() => applySort(statsResult.value?.byModel, modelSort));
        const sortedByWo    = computed(() => applySort(statsResult.value?.byWo, woSort));
        const sortedTrend   = computed(() => applySort(statsResult.value?.trend, trendSort));

        // ================= 快捷區間：日 / 週(日–六) / 月 =================
        const quickMode = ref('day');     // 'day' | 'week' | 'month' | null(自訂)
        const quickOffset = ref(-1);      // 0=本期，-1=上一期
        let applyingQuick = false;

        // 用本地時間格式化，避免 toISOString() 的 UTC 位移導致跨日
        const fmtLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

        const quickRange = (mode, offset) => {
            const now = new Date(); now.setHours(0, 0, 0, 0);
            if (mode === 'day') {
                const d = new Date(now); d.setDate(d.getDate() + offset);
                return { start: d, end: d };
            }
            if (mode === 'week') {
                // 週日為一週起點
                const s = new Date(now);
                s.setDate(s.getDate() - s.getDay() + offset * 7);
                const e = new Date(s); e.setDate(e.getDate() + 6);
                return { start: s, end: e };
            }
            // month：當月 1 號 ~ 當月最後一天
            const s = new Date(now.getFullYear(), now.getMonth() + offset, 1);
            const e = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
            return { start: s, end: e };
        };

        const WEEKDAY_TW = ['日', '一', '二', '三', '四', '五', '六'];
        const quickLabel = computed(() => {
            if (!quickMode.value) return '';
            const { start, end } = quickRange(quickMode.value, quickOffset.value);
            if (quickMode.value === 'day') return `${fmtLocal(start)} (週${WEEKDAY_TW[start.getDay()]})`;
            if (quickMode.value === 'week') {
                const same = start.getFullYear() === end.getFullYear();
                return `${fmtLocal(start)} ~ ${same ? fmtLocal(end).slice(5) : fmtLocal(end)}`;
            }
            return `${start.getFullYear()} 年 ${start.getMonth() + 1} 月`;
        });
        // 相對描述：本日 / 昨日 / 本週 / 上週 / 本月 / 上月 …
        const quickRelative = computed(() => {
            if (!quickMode.value) return '';
            const o = quickOffset.value;
            const unit = { day: '日', week: '週', month: '月' }[quickMode.value];
            if (o === 0) return `本${unit}`;
            if (o === -1) return `上一${unit}`;
            if (o === 1) return `下一${unit}`;
            return o < 0 ? `${-o} ${unit}前` : `${o} ${unit}後`;
        });

        const applyQuick = async () => {
            const { start, end } = quickRange(quickMode.value, quickOffset.value);
            applyingQuick = true;
            statsFilter.value.start = fmtLocal(start);
            statsFilter.value.end = fmtLocal(end);
            await Vue.nextTick();
            applyingQuick = false;
            await calculateStats();
        };
        // 日→今天；週→上一週（本週尚未結束）；月→上個月（同理）
        const DEFAULT_OFFSET = { day: 0, week: -1, month: -1 };
        const setQuickMode = (mode) => {
            quickMode.value = mode;
            quickOffset.value = DEFAULT_OFFSET[mode];
            applyQuick();
        };
        const shiftQuick = (delta) => {
            if (!quickMode.value) return;
            quickOffset.value += delta;
            applyQuick();
        };
        // 手動改日期即脫離快捷模式，避免高亮標示與實際區間不符
        watch(() => [statsFilter.value.start, statsFilter.value.end], () => {
            if (!applyingQuick) quickMode.value = null;
        });

        // --- 通用：map -> 排序清單(含比例) ---
        const mapToList = (map) => {
            const list = Object.entries(map || {}).map(([key, qty]) => ({ key, qty })).sort((a, b) => b.qty - a.qty);
            const total = list.reduce((s, x) => s + x.qty, 0);
            return list.map(x => ({ ...x, ratio: total ? (x.qty / total * 100).toFixed(1) : '0.0' }));
        };

        // --- 下鑽彈窗：單一 modal + 麵包屑堆疊，任一維度可互跳 ---
        const drillStack = ref([]);
        const pushDrill = (kind, key) => {
            if (!key || !statsResult.value) return;
            const top = drillStack.value[drillStack.value.length - 1];
            if (top && top.kind === kind && top.key === key) return;
            drillStack.value.push({ kind, key });
        };
        const popDrill = () => { drillStack.value.pop(); };
        const closeDrill = () => { drillStack.value = []; };
        const openTypeDetail = (name) => pushDrill('type', name);
        const openLocDetail = (code) => pushDrill('loc', code);
        const openModelDetail = (name) => pushDrill('model', name);
        const openWoDetail = (wo) => pushDrill('wo', wo);
        const isDrill = (kind, key) => {
            const top = drillStack.value[drillStack.value.length - 1];
            return !!top && top.kind === kind && top.key === key;
        };

        // Esc：先返回上一層，最後一層才關閉
        window.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || drillStack.value.length === 0) return;
            drillStack.value.length > 1 ? popDrill() : closeDrill();
        });

        const DRILL_META = {
            type:  { label: '不良現象', icon: 'fa-bug',            accent: 'red' },
            loc:   { label: '不良位置', icon: 'fa-map-marker-alt', accent: 'amber' },
            model: { label: '機種',     icon: 'fa-microchip',      accent: 'indigo' },
            wo:    { label: '工單',     icon: 'fa-file-alt',       accent: 'blue' }
        };

        const drillView = computed(() => {
            const cur = drillStack.value[drillStack.value.length - 1];
            const r = statsResult.value;
            if (!cur || !r) return null;
            const meta = DRILL_META[cur.kind];
            const base = { kind: cur.kind, key: cur.key, meta, depth: drillStack.value.length };

            if (cur.kind === 'type') {
                const qty = (r.byType.find(x => x.name === cur.key) || {}).qty || 0;
                return { ...base, subtitle: `佔全區間不良 ${r.totalDefects ? (qty / r.totalDefects * 100).toFixed(1) : '0.0'}%`,
                    metrics: [{ label: '不良總數', value: qty, tone: 'red' }],
                    dailyTrend: (r.trend || []).map(day => ({
                        date: day.date,
                        qty: day.byType?.[cur.key] || 0,
                        ratio: day.defects ? ((day.byType?.[cur.key] || 0) / day.defects * 100).toFixed(2) : '0.00'
                    })),
                    groups: [
                        { label: '不良位置分佈', icon: 'fa-map-marker-alt', pick: 'loc',   items: mapToList(r.typeLocMap[cur.key]) },
                        { label: '機種分佈',     icon: 'fa-microchip',      pick: 'model', items: mapToList(r.typeModelMap[cur.key]) },
                        { label: '工單分佈',     icon: 'fa-file-alt',       pick: 'wo',    items: mapToList(r.typeWoMap[cur.key]) }
                    ] };
            }
            if (cur.kind === 'loc') {
                const qty = (r.byLocation.find(x => x.code === cur.key) || {}).qty || 0;
                return { ...base, subtitle: `佔全區間不良 ${r.totalDefects ? (qty / r.totalDefects * 100).toFixed(1) : '0.0'}%`,
                    metrics: [{ label: '不良總數', value: qty, tone: 'red' }],
                    groups: [
                        { label: '不良現象分佈', icon: 'fa-bug',       pick: 'type',  items: mapToList(r.locTypeMap[cur.key]) },
                        { label: '機種分佈',     icon: 'fa-microchip', pick: 'model', items: mapToList(r.locModelMap[cur.key]) },
                        { label: '工單分佈',     icon: 'fa-file-alt',  pick: 'wo',    items: mapToList(r.locWoMap[cur.key]) }
                    ] };
            }
            if (cur.kind === 'model') {
                const agg = r.modelAgg[cur.key]; if (!agg) return null;
                return { ...base, subtitle: `不良率 ${agg.input ? (agg.defects / agg.input * 100).toFixed(2) : '0.00'}%`,
                    metrics: [
                        { label: '投入數', value: agg.input, tone: 'slate' },
                        { label: '不良數', value: agg.defects, tone: 'red' }
                    ],
                    groups: [
                        { label: '不良現象分佈', icon: 'fa-bug',              pick: 'type', items: mapToList(agg.byType) },
                        { label: '不良位置分佈', icon: 'fa-map-marker-alt',   pick: 'loc',  items: mapToList(agg.byLoc) },
                        { label: '工單分佈',     icon: 'fa-file-alt',         pick: 'wo',   items: mapToList(agg.byWo) }
                    ] };
            }
            const agg = r.woAgg[cur.key]; if (!agg) return null;
            return { ...base, subtitle: `${[...agg.models].join(' / ')} · 不良率 ${agg.input ? (agg.defects / agg.input * 100).toFixed(2) : '0.00'}%`,
                metrics: [
                    { label: '投入數', value: agg.input, tone: 'slate' },
                    { label: '不良數', value: agg.defects, tone: 'red' }
                ],
                groups: [
                    { label: '不良現象分佈', icon: 'fa-bug',            pick: 'type', items: mapToList(agg.byType) },
                    { label: '不良位置分佈', icon: 'fa-map-marker-alt', pick: 'loc',  items: mapToList(agg.byLoc) }
                ] };
        });

        // --- 生產日明細表：Top 5 現象欄位的識別色 ---
        const trendColors = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6'];
        const trendTypeColor = (typeName) => {
            if (!statsResult.value || !statsResult.value.topTypeNames) return '#6b7280';
            const idx = statsResult.value.topTypeNames.indexOf(typeName);
            return idx >= 0 ? trendColors[idx % trendColors.length] : '#6b7280';
        };

        const filterSmtRows = rows => (rows || []).filter(row => {
            if (statsFilter.value.start && String(row.production_date) < statsFilter.value.start) return false;
            if (statsFilter.value.end && String(row.production_date) > statsFilter.value.end) return false;
            if (statsFilter.value.modelId !== 'all' && row.work_orders?.model_id != statsFilter.value.modelId) return false;
            if (statsFilter.value.woId !== 'all' && row.work_orders?.wo_number !== statsFilter.value.woId) return false;
            return true;
        });
        const loadSmtStatsData = async (force = false) => {
            if (!force && smtStatsDataCache) return smtStatsDataCache;
            if (window.koyaFetchCachedJson) {
                try {
                    const data = await window.koyaFetchCachedJson('/api/smt-data', { force });
                    if (Array.isArray(data?.production) && Array.isArray(data?.fpy)) {
                        smtStatsDataCache = data;
                        return data;
                    }
                } catch (error) { console.warn('SMT 共用統計快取讀取失敗，改由 Supabase 直讀', error); }
            }
            return null;
        };

        // --- 主統計 ---
        const calculateStats = async (showToast = true, { refreshRemote = showToast } = {}) => {
            loading.value = true;
            try {
                const sharedData = await loadSmtStatsData(refreshRemote);
                let filtered;
                if (sharedData) {
                    filtered = filterSmtRows(sharedData.production);
                } else {
                    let query = _supabase.from('daily_production').select(`id, production_date, input_quantity, work_orders!inner (id, wo_number, model_id, models(name)), defect_logs (quantity, defect_types(name), defect_locations(code))`).eq('line', currentLine.value);
                    if (statsFilter.value.start) query = query.gte('production_date', statsFilter.value.start);
                    if (statsFilter.value.end) query = query.lte('production_date', statsFilter.value.end);
                    const { data: rows } = await query;
                    filtered = rows || [];
                    if (statsFilter.value.modelId !== 'all') filtered = filtered.filter(r => r.work_orders.model_id == statsFilter.value.modelId);
                    if (statsFilter.value.woId !== 'all') filtered = filtered.filter(r => r.work_orders.wo_number === statsFilter.value.woId);
                }

                let totalInput = 0, totalDefects = 0, typeMap = {}, locMap = {};
                const typeLocMap = {};   // { 現象: { 位置: qty } }
                const typeModelMap = {}; // { 現象: { 機種: qty } }
                const typeWoMap = {};    // { 現象: { 工單: qty } }
                const locWoMap = {};     // { 位置: { 工單: qty } }
                const locModelMap = {};  // { 位置: { 機種: qty } }
                const locTypeMap = {};   // { 位置: { 現象: qty } }
                const modelAgg = {};     // { 機種: { input, defects, byType, byLoc, byWo } }
                const woAgg = {};        // { 工單: { models:Set, input, defects, byType, byLoc } }
                const dayMap = {};
                const locAppearance = {};

                filtered.forEach(day => {
                    const woNum = day.work_orders?.wo_number || 'Unknown';
                    const modelName = day.work_orders?.models?.name || 'Unknown';
                    totalInput += day.input_quantity;
                    if (!dayMap[day.production_date]) dayMap[day.production_date] = { date: day.production_date, input: 0, defects: 0, byType: {} };
                    dayMap[day.production_date].input += day.input_quantity;
                    if (!modelAgg[modelName]) modelAgg[modelName] = { input: 0, defects: 0, byType: {}, byLoc: {}, byWo: {} };
                    modelAgg[modelName].input += day.input_quantity;
                    if (!woAgg[woNum]) woAgg[woNum] = { models: new Set(), input: 0, defects: 0, byType: {}, byLoc: {} };
                    woAgg[woNum].models.add(modelName);
                    woAgg[woNum].input += day.input_quantity;

                    day.defect_logs.forEach(log => {
                        const q = log.quantity;
                        totalDefects += q;
                        const tName = log.defect_types?.name || 'Unknown';
                        typeMap[tName] = (typeMap[tName] || 0) + q;
                        const lCode = log.defect_locations?.code || 'Unknown';
                        locMap[lCode] = (locMap[lCode] || 0) + q;

                        if (!typeLocMap[tName]) typeLocMap[tName] = {};
                        typeLocMap[tName][lCode] = (typeLocMap[tName][lCode] || 0) + q;
                        if (!typeModelMap[tName]) typeModelMap[tName] = {};
                        typeModelMap[tName][modelName] = (typeModelMap[tName][modelName] || 0) + q;
                        if (!typeWoMap[tName]) typeWoMap[tName] = {};
                        typeWoMap[tName][woNum] = (typeWoMap[tName][woNum] || 0) + q;

                        if (!locWoMap[lCode]) locWoMap[lCode] = {};
                        locWoMap[lCode][woNum] = (locWoMap[lCode][woNum] || 0) + q;
                        if (!locModelMap[lCode]) locModelMap[lCode] = {};
                        locModelMap[lCode][modelName] = (locModelMap[lCode][modelName] || 0) + q;
                        if (!locTypeMap[lCode]) locTypeMap[lCode] = {};
                        locTypeMap[lCode][tName] = (locTypeMap[lCode][tName] || 0) + q;

                        modelAgg[modelName].defects += q;
                        modelAgg[modelName].byType[tName] = (modelAgg[modelName].byType[tName] || 0) + q;
                        modelAgg[modelName].byLoc[lCode] = (modelAgg[modelName].byLoc[lCode] || 0) + q;
                        modelAgg[modelName].byWo[woNum] = (modelAgg[modelName].byWo[woNum] || 0) + q;
                        woAgg[woNum].defects += q;
                        woAgg[woNum].byType[tName] = (woAgg[woNum].byType[tName] || 0) + q;
                        woAgg[woNum].byLoc[lCode] = (woAgg[woNum].byLoc[lCode] || 0) + q;

                        dayMap[day.production_date].defects += q;
                        dayMap[day.production_date].byType[tName] = (dayMap[day.production_date].byType[tName] || 0) + q;

                        if (!locAppearance[lCode]) locAppearance[lCode] = new Set();
                        locAppearance[lCode].add(day.production_date);
                    });
                });

                const byType = Object.entries(typeMap).map(([name, qty]) => ({ name, qty, ratio: totalDefects ? (qty / totalDefects * 100).toFixed(1) : 0 })).sort((a, b) => b.qty - a.qty);
                const byLocation = Object.entries(locMap).map(([code, qty]) => ({ code, qty, ratio: totalDefects ? (qty / totalDefects * 100).toFixed(1) : 0 })).sort((a, b) => b.qty - a.qty);
                const byModel = Object.entries(modelAgg).map(([name, m]) => ({
                    name, input: m.input, defects: m.defects,
                    rate: m.input ? (m.defects / m.input * 100).toFixed(2) : '0.00',
                    ratio: totalDefects ? (m.defects / totalDefects * 100).toFixed(1) : '0.0'
                })).sort((a, b) => b.defects - a.defects);
                const byWo = Object.entries(woAgg).map(([wo, w]) => ({
                    wo, model: [...w.models].join(' / '), input: w.input, defects: w.defects,
                    rate: w.input ? (w.defects / w.input * 100).toFixed(2) : '0.00',
                    ratio: totalDefects ? (w.defects / totalDefects * 100).toFixed(1) : '0.0'
                })).sort((a, b) => b.defects - a.defects);

                const totalDays = Object.keys(dayMap).length;
                const topLocations = byLocation.slice(0, 10).map(l => ({
                    ...l,
                    appearDays: locAppearance[l.code] ? locAppearance[l.code].size : 0,
                    totalDays,
                    isSystemic: locAppearance[l.code] && totalDays > 0 && (locAppearance[l.code].size / totalDays) >= 0.5
                }));

                const trend = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date)).map(d => ({
                    date: d.date, input: d.input, defects: d.defects,
                    defectRate: d.input ? ((d.defects / d.input) * 100).toFixed(2) : '0.00',
                    yieldRate: d.input ? (((d.input - d.defects) / d.input) * 100).toFixed(2) : '100.00',
                    byType: d.byType
                }));
                const topTypeNames = byType.slice(0, 5).map(t => t.name);

                // --- FPY 趨勢 (每日平均 SPI/AOI) ---
                let fpyTrend = [];
                try {
                    let ff;
                    if (sharedData) {
                        ff = filterSmtRows(sharedData.fpy);
                    } else {
                        let fq = _supabase.from('daily_fpy').select('production_date, spi_rate, aoi_rate, work_orders!inner(wo_number, model_id)').eq('line', currentLine.value);
                        if (statsFilter.value.start) fq = fq.gte('production_date', statsFilter.value.start);
                        if (statsFilter.value.end) fq = fq.lte('production_date', statsFilter.value.end);
                        const { data: fpyRows } = await fq;
                        ff = fpyRows || [];
                        if (statsFilter.value.modelId !== 'all') ff = ff.filter(r => r.work_orders.model_id == statsFilter.value.modelId);
                        if (statsFilter.value.woId !== 'all') ff = ff.filter(r => r.work_orders.wo_number === statsFilter.value.woId);
                    }
                    const fpyDayMap = {};
                    ff.forEach(r => {
                        if (!fpyDayMap[r.production_date]) fpyDayMap[r.production_date] = { spi: [], aoi: [] };
                        if (r.spi_rate !== null && r.spi_rate !== undefined) fpyDayMap[r.production_date].spi.push(Number(r.spi_rate));
                        if (r.aoi_rate !== null && r.aoi_rate !== undefined) fpyDayMap[r.production_date].aoi.push(Number(r.aoi_rate));
                    });
                    const avg = (arr) => arr.length ? parseFloat((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)) : null;
                    fpyTrend = Object.keys(fpyDayMap).sort().map(d => ({ date: d, spi: avg(fpyDayMap[d].spi), aoi: avg(fpyDayMap[d].aoi) }));
                } catch (e) { console.error('FPY 趨勢載入失敗', e); }

                closeDrill();
                statsResult.value = {
                    totalInput, totalDefects,
                    yieldRate: totalInput ? ((totalInput - totalDefects) / totalInput * 100).toFixed(2) : 100,
                    byType, byLocation, byModel, byWo,
                    typeLocMap, typeModelMap, typeWoMap, locWoMap, locModelMap, locTypeMap,
                    modelAgg, woAgg,
                    topLocations, trend, topTypeNames, totalDays, fpyTrend
                };
                if (showToast) toast("統計完成");
            } catch (e) { toast("統計失敗: " + e.message, "error"); } finally { loading.value = false; }
        };

        // --- Excel 導出 (原三分頁格式完全保留，僅新增「交叉分析」分頁) ---
        const exportToExcel = async () => {
            await calculateStats(false, { refreshRemote: true });
            if (!statsResult.value) return toast("請先執行統計", "warning");
            loading.value = true;
            try {
                const sharedData = await loadSmtStatsData(false);
                const combinedData = [["=== 總結報告 ==="], ["統計區間", `${statsFilter.value.start || '不限'} ~ ${statsFilter.value.end || '不限'}`], ["總投入數", statsResult.value.totalInput], ["總不良數", statsResult.value.totalDefects], ["良率", `${statsResult.value.yieldRate}%`], [], ["=== 不良現象分析 ==="], ["不良現象", "數量", "佔比"], ...statsResult.value.byType.map(d => [d.name, d.qty, `${d.ratio}%`]), [], ["=== 位置異常分析 ==="], ["位置", "數量"], ...statsResult.value.byLocation.map(d => [d.code, d.qty])];
                const wb = XLSX.utils.book_new();
                const wsYield = XLSX.utils.aoa_to_sheet(combinedData);
                XLSX.utils.book_append_sheet(wb, wsYield, "良率報告");

                const paretoData = [["不良現象", "數量", "佔比"], ...statsResult.value.byType.map(row => [row.name, row.qty, `${row.ratio}%`])];
                const yieldTrendData = [["日期", "投入", "不良", "良率"], ...statsResult.value.trend.map(row => [row.date, row.input, row.defects, `${row.yieldRate}%`])];
                const outputTrendData = [["日期", "投入", "良品", "不良"], ...statsResult.value.trend.map(row => [row.date, row.input, row.input - row.defects, row.defects])];
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(yieldTrendData), "良率趨勢");
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(outputTrendData), "產出趨勢");
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(paretoData), "Pareto分析");

                // === 每日明細分頁 ===
                let filteredDaily;
                if (sharedData) {
                    filteredDaily = filterSmtRows(sharedData.production);
                } else {
                    let dailyQuery = _supabase.from('daily_production').select(`production_date, input_quantity, work_orders!inner (wo_number, model_id, models(name)), defect_logs (quantity, defect_types(name), defect_locations(code))`).eq('line', currentLine.value);
                    if (statsFilter.value.start) dailyQuery = dailyQuery.gte('production_date', statsFilter.value.start);
                    if (statsFilter.value.end) dailyQuery = dailyQuery.lte('production_date', statsFilter.value.end);
                    const { data: dailyRows } = await dailyQuery;
                    filteredDaily = dailyRows || [];
                    if (statsFilter.value.modelId !== 'all') filteredDaily = filteredDaily.filter(r => r.work_orders.model_id == statsFilter.value.modelId);
                    if (statsFilter.value.woId !== 'all') filteredDaily = filteredDaily.filter(r => r.work_orders.wo_number === statsFilter.value.woId);
                }
                filteredDaily.sort((a, b) => a.production_date.localeCompare(b.production_date) || a.work_orders.wo_number.localeCompare(b.work_orders.wo_number));
                const dailyData = [["統計區間", `${statsFilter.value.start || '不限'} ~ ${statsFilter.value.end || '不限'}`], [], ["日期", "工單號碼", "機種", "投入量", "NG 數", "良率", "NG 項目明細", "NG 位置明細"]];
                filteredDaily.forEach(r => {
                    const ng = (r.defect_logs || []).reduce((s, d) => s + (d.quantity || 0), 0);
                    const yieldRate = r.input_quantity > 0 ? (((r.input_quantity - ng) / r.input_quantity) * 100).toFixed(2) + '%' : '-';
                    const typeMap = {}, locMap = {};
                    (r.defect_logs || []).forEach(d => {
                        const t = d.defect_types?.name || '?'; typeMap[t] = (typeMap[t] || 0) + (d.quantity || 0);
                        const l = d.defect_locations?.code || '?'; locMap[l] = (locMap[l] || 0) + (d.quantity || 0);
                    });
                    const typeStr = Object.entries(typeMap).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}x${v}`).join(', ');
                    const locStr = Object.entries(locMap).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}x${v}`).join(', ');
                    dailyData.push([r.production_date, r.work_orders.wo_number, r.work_orders.models?.name || '', r.input_quantity, ng, yieldRate, typeStr || '-', locStr || '-']);
                });
                const wsDaily = XLSX.utils.aoa_to_sheet(dailyData);
                XLSX.utils.book_append_sheet(wb, wsDaily, "每日明細");

                let filteredFpy;
                if (sharedData) {
                    filteredFpy = filterSmtRows(sharedData.fpy);
                } else {
                    let fpyQuery = _supabase.from('daily_fpy').select('*, work_orders(wo_number, models(name))').eq('line', currentLine.value);
                    if (statsFilter.value.start) fpyQuery = fpyQuery.gte('production_date', statsFilter.value.start);
                    if (statsFilter.value.end) fpyQuery = fpyQuery.lte('production_date', statsFilter.value.end);
                    const { data: fpyRows } = await fpyQuery;
                    filteredFpy = fpyRows || [];
                    if (statsFilter.value.modelId !== 'all') filteredFpy = filteredFpy.filter(r => r.work_orders.model_id == statsFilter.value.modelId);
                }

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

                // === 新增：交叉分析分頁 ===
                const r = statsResult.value;
                const flattenCross = (map) => {
                    const rows = [];
                    Object.entries(map || {}).forEach(([a, sub]) => {
                        const tot = Object.values(sub).reduce((s, v) => s + v, 0);
                        Object.entries(sub).sort((x, y) => y[1] - x[1]).forEach(([b, q]) => rows.push([a, b, q, tot ? `${(q / tot * 100).toFixed(1)}%` : '0%']));
                    });
                    return rows;
                };
                const crossData = [
                    ["統計區間", `${statsFilter.value.start || '不限'} ~ ${statsFilter.value.end || '不限'}`], [],
                    ["=== 機種彙總 ==="], ["機種", "投入數", "不良數", "不良率", "佔總不良比"],
                    ...r.byModel.map(m => [m.name, m.input, m.defects, `${m.rate}%`, `${m.ratio}%`]), [],
                    ["=== 工單彙總 ==="], ["工單號碼", "機種", "投入數", "不良數", "不良率", "佔總不良比"],
                    ...r.byWo.map(w => [w.wo, w.model, w.input, w.defects, `${w.rate}%`, `${w.ratio}%`]), [],
                    ["=== 不良現象 × 機種 ==="], ["不良現象", "機種", "數量", "佔該現象比"],
                    ...flattenCross(r.typeModelMap), [],
                    ["=== 不良現象 × 位置 ==="], ["不良現象", "位置", "數量", "佔該現象比"],
                    ...flattenCross(r.typeLocMap), [],
                    ["=== 不良現象 × 工單 ==="], ["不良現象", "工單號碼", "數量", "佔該現象比"],
                    ...flattenCross(r.typeWoMap), [],
                    ["=== 位置 × 機種 ==="], ["位置", "機種", "數量", "佔該位置比"],
                    ...flattenCross(r.locModelMap), [],
                    ["=== 位置 × 工單 ==="], ["位置", "工單號碼", "數量", "佔該位置比"],
                    ...flattenCross(r.locWoMap)
                ];
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(crossData), "交叉分析");

                XLSX.writeFile(wb, `KOYA_${currentLine.value}_Full_Report_${new Date().toISOString().slice(0,10)}.xlsx`);
                toast("完整報表已導出");
            } catch(e) { toast("導出失敗: " + e.message, "error"); } finally { loading.value = false; }
        };

        // ==================== ECHARTS ====================
        let paretoChartInst = null;
        let typeTrendChartInst = null;
        let heatmapChartInst = null;
        let yieldTrendChartInst = null;
        let fpyTrendChartInst = null;

        // 無資料時必須銷毀實例：否則舊圖表會殘留在畫面上，
        // 且容器被 v-if 移除後實例仍指向已卸離的 DOM，下次有資料時會渲染不出來。
        const disposePareto = () => { if (paretoChartInst) { paretoChartInst.dispose(); paretoChartInst = null; } };
        const disposeTypeTrend = () => { if (typeTrendChartInst) { typeTrendChartInst.dispose(); typeTrendChartInst = null; } };
        const disposeHeatmap = () => { if (heatmapChartInst) { heatmapChartInst.dispose(); heatmapChartInst = null; } };
        const disposeYieldTrend = () => { if (yieldTrendChartInst) { yieldTrendChartInst.dispose(); yieldTrendChartInst = null; } };
        const disposeFpyTrend = () => { if (fpyTrendChartInst) { fpyTrendChartInst.dispose(); fpyTrendChartInst = null; } };

        const renderTypeTrendChart = () => {
            Vue.nextTick(() => {
                const el = document.getElementById('smtParetoTrendChart');
                const trend = drillView.value?.kind === 'type' ? drillView.value.dailyTrend || [] : [];
                if (!el || !trend.length) { disposeTypeTrend(); return; }
                if (!typeTrendChartInst || typeTrendChartInst.getDom() !== el) { disposeTypeTrend(); typeTrendChartInst = echarts.init(el); }
                const labels = trend.map(row => row.date.slice(5));
                const quantities = trend.map(row => row.qty);
                const ratios = trend.map(row => Number(row.ratio));
                typeTrendChartInst.setOption({
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

        const renderParetoChart = () => {
            Vue.nextTick(() => {
                const el = document.getElementById('paretoChart');
                if (!statsResult.value || !statsResult.value.byType || statsResult.value.byType.length === 0) { disposePareto(); return; }
                if (!el) return;
                if (!paretoChartInst || paretoChartInst.getDom() !== el) { disposePareto(); paretoChartInst = echarts.init(el); }
                const sorted = [...statsResult.value.byType].sort((a,b)=>b.qty-a.qty);
                const names = sorted.map(x=>x.name); const qtys = sorted.map(x=>x.qty);
                paretoChartInst.setOption({
                    tooltip:{trigger:'axis',axisPointer:{type:'shadow'}},
                    legend:{data:['不良數量'],top:8,right:10,textStyle:{fontSize:11,color:'#6b7280'}},
                    grid:{top:64,right:20,bottom:60,left:50},
                    xAxis:{type:'category',data:names,triggerEvent:true,axisLabel:{fontSize:10,color:'#374151',rotate:names.some(n=>n.length>4)?20:0},axisLine:{lineStyle:{color:'#e5e7eb'}}},
                    yAxis:{type:'value',name:'數量',nameTextStyle:{color:'#6b7280',fontSize:10},axisLabel:{fontSize:10,color:'#9ca3af'},splitLine:{lineStyle:{color:'#f3f4f6'}}},
                    series:[{name:'不良數量',type:'bar',data:qtys,barMaxWidth:40,itemStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:'#dc2626'},{offset:1,color:'#fca5a5'}]},borderRadius:[4,4,0,0]},label:{show:true,position:'top',fontSize:10,color:'#374151',formatter:'{c}'}}]
                });
                // 點擊柱狀 / X 軸標籤即開啟該不良現象的交叉分析彈窗
                paretoChartInst.off('click');
                paretoChartInst.on('click', p => {
                    const name = p.componentType === 'xAxis' ? p.value : p.name;
                    if (!name) return;
                    paretoChartInst.dispatchAction({ type: 'hideTip' });
                    openTypeDetail(name);
                });
                el.style.cursor = 'pointer';
            });
        };

        const renderHeatmap = () => {
            Vue.nextTick(() => {
                const el = document.getElementById('typeLocHeatmap');
                const r = statsResult.value;
                if (!r || !r.byType.length || !r.byLocation.length) { disposeHeatmap(); return; }
                if (!el) return;
                if (!heatmapChartInst || heatmapChartInst.getDom() !== el) { disposeHeatmap(); heatmapChartInst = echarts.init(el); }
                const types = r.byType.slice(0, 8).map(t => t.name);
                const locs = r.byLocation.slice(0, 12).map(l => l.code);
                const dataArr = []; let maxV = 0;
                types.forEach((t, ti) => locs.forEach((l, li) => {
                    const v = (r.typeLocMap[t] || {})[l] || 0;
                    if (v > 0) { dataArr.push([li, ti, v]); if (v > maxV) maxV = v; }
                }));
                heatmapChartInst.setOption({
                    tooltip:{position:'top',formatter:p=>`${types[p.value[1]]} × ${locs[p.value[0]]}<br/><b>${p.value[2]} pcs</b>`},
                    grid:{top:10,right:20,bottom:70,left:90},
                    xAxis:{type:'category',data:locs,axisLabel:{fontSize:10,color:'#374151',rotate:30},splitArea:{show:true}},
                    yAxis:{type:'category',data:types,axisLabel:{fontSize:10,color:'#374151'},splitArea:{show:true}},
                    visualMap:{min:0,max:Math.max(1,maxV),calculable:false,orient:'horizontal',left:'center',bottom:0,inRange:{color:['#fff5f5','#fca5a5','#dc2626','#7f1d1d']},textStyle:{fontSize:10,color:'#6b7280'}},
                    series:[{type:'heatmap',data:dataArr,label:{show:true,fontSize:9,color:'#111'},emphasis:{itemStyle:{shadowBlur:6,shadowColor:'rgba(0,0,0,0.3)'}}}]
                });
                // 點擊格子 → 開啟該位置的交叉分析
                heatmapChartInst.off('click');
                heatmapChartInst.on('click', p => {
                    const code = locs[p.value[0]];
                    if (!code) return;
                    heatmapChartInst.dispatchAction({ type: 'hideTip' });
                    openLocDetail(code);
                });
                el.style.cursor = 'pointer';
            });
        };

        const renderFpyTrendChart = () => {
            Vue.nextTick(() => {
                const el = document.getElementById('statsFpyTrend');
                const r = statsResult.value;
                if (!r || !r.fpyTrend || r.fpyTrend.length === 0) { disposeFpyTrend(); return; }
                if (!el) return;
                if (!fpyTrendChartInst || fpyTrendChartInst.getDom() !== el) { disposeFpyTrend(); fpyTrendChartInst = echarts.init(el); }
                const dates = r.fpyTrend.map(d => d.date.slice(5));
                fpyTrendChartInst.setOption({
                    tooltip:{trigger:'axis',formatter:p=>{let s=p[0].name;p.forEach(v=>{s+=`<br/>${v.marker}${v.seriesName}: <b>${v.value!==null&&v.value!==undefined?v.value+'%':'無資料'}</b>`;});return s;}},
                    legend:{data:['SPI 直通率','AOI 直通率'],top:8,right:10,textStyle:{fontSize:11,color:'#6b7280'}},
                    grid:{top:56,right:20,bottom:40,left:50},
                    xAxis:{type:'category',data:dates,axisLabel:{fontSize:10,color:'#9ca3af'},axisLine:{lineStyle:{color:'#e5e7eb'}}},
                    yAxis:{type:'value',min:v=>Math.floor(Math.min(v.min-0.5, (fpyTargets.value.aoi||98)-1)),max:100,axisLabel:{formatter:'{value}%',fontSize:10,color:'#9ca3af'},splitLine:{lineStyle:{color:'#f3f4f6'}}},
                    series:[
                        {name:'SPI 直通率',type:'line',data:r.fpyTrend.map(d=>d.spi),smooth:true,connectNulls:true,symbol:'circle',symbolSize:5,lineStyle:{color:'#0d9488',width:2.5},itemStyle:{color:'#0d9488'},markLine:{silent:true,lineStyle:{color:'#0d9488',type:'dashed',width:1},data:[{yAxis:fpyTargets.value.spi,label:{formatter:`SPI目標${fpyTargets.value.spi}%`,position:'insideEndTop',fontSize:9,color:'#0d9488'}}]}},
                        {name:'AOI 直通率',type:'line',data:r.fpyTrend.map(d=>d.aoi),smooth:true,connectNulls:true,symbol:'circle',symbolSize:5,lineStyle:{color:'#7c3aed',width:2.5},itemStyle:{color:'#7c3aed'},markLine:{silent:true,lineStyle:{color:'#7c3aed',type:'dashed',width:1},data:[{yAxis:fpyTargets.value.aoi,label:{formatter:`AOI目標${fpyTargets.value.aoi}%`,position:'insideEndBottom',fontSize:9,color:'#7c3aed'}}]}}
                    ]
                });
            });
        };

        const renderYieldTrendChart = () => {
            Vue.nextTick(() => {
                const el = document.getElementById('statsYieldTrend');
                const r = statsResult.value;
                if (!r || !r.trend || r.trend.length === 0) { disposeYieldTrend(); return; }
                if (!el) return;
                if (!yieldTrendChartInst || yieldTrendChartInst.getDom() !== el) { disposeYieldTrend(); yieldTrendChartInst = echarts.init(el); }
                yieldTrendChartInst.setOption({
                    legend: { data: ['投入數', '良率'], top: 8, right: 10, textStyle: { fontSize: 11, color: '#6b7280' } },
                    tooltip: { trigger: 'axis', formatter: params => { let text = params[0]?.axisValue || ''; params.forEach(item => { text += `<br/>${item.marker}${item.seriesName}: <b>${item.seriesName === '良率' ? item.value + '%' : item.value.toLocaleString()}</b>`; }); return text; } },
                    grid: { top: 64, right: 58, bottom: 44, left: 50 },
                    xAxis: { type: 'category', data: r.trend.map(row => row.date.slice(5)), axisLabel: { fontSize: 10, color: '#9ca3af' }, axisLine: { lineStyle: { color: '#e5e7eb' } } },
                    yAxis: [{ type: 'value', name: '投入', min: 0, axisLabel: { fontSize: 10, color: '#9ca3af' }, splitLine: { lineStyle: { color: '#f3f4f6' } } }, { type: 'value', name: '良率', min: 0, max: 100, axisLabel: { formatter: '{value}%', fontSize: 10, color: '#9ca3af' }, splitLine: { show: false } }],
                    series: [{ name: '投入數', type: 'bar', data: r.trend.map(row => row.input), barMaxWidth: 24, itemStyle: { color: '#bfdbfe', borderRadius: [4, 4, 0, 0] } }, { name: '良率', type: 'line', yAxisIndex: 1, data: r.trend.map(row => Number(row.yieldRate)), smooth: true, symbol: 'circle', symbolSize: 6, lineStyle: { color: '#2563eb', width: 2.5 }, itemStyle: { color: '#2563eb' }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(37,99,235,0.16)' }, { offset: 1, color: 'rgba(37,99,235,0)' }] } }, label: { show: true, position: 'top', formatter: '{c}%', fontSize: 9 } }]
                });
            });
        };

        // 容器剛插入 DOM 時寬度可能尚未完成 layout，ECharts 會以預設寬度初始化；
        // 因此每次渲染後於下一動畫影格強制 resize 一次。
        const resizeStatsCharts = () => {
            [paretoChartInst, heatmapChartInst, yieldTrendChartInst, fpyTrendChartInst].forEach(inst => { if (inst) inst.resize(); });
        };
        const renderStatsCharts = () => {
            renderParetoChart(); renderHeatmap(); renderYieldTrendChart(); renderFpyTrendChart();
            requestAnimationFrame(() => requestAnimationFrame(resizeStatsCharts));
        };
        window.addEventListener('resize', () => { if (currentTab.value === 'stats') resizeStatsCharts(); if (typeTrendChartInst) typeTrendChartInst.resize(); });

        watch(() => statsResult.value, (val) => { if (val && currentTab.value === 'stats') renderStatsCharts(); });
        watch(drillView, renderTypeTrendChart);
        watch(currentTab, (tab) => {
            if (tab !== 'stats' || currentLine.value !== 'SMT') return;
            if (statsResult.value) renderStatsCharts();
            else calculateStats(false);
        });
        watch(currentLine, line => {
            if (line !== 'SMT') statsResult.value = null;
            else if (currentTab.value === 'stats') calculateStats(false);
        });

        return {
            statsFilter, statsResult, calculateStats, exportToExcel, hasDefects,
            quickMode, quickOffset, quickLabel, quickRelative, setQuickMode, shiftQuick,
            modelSort, woSort, trendSort, toggleSort, sortIcon, ariaSort,
            sortedByModel, sortedByWo, sortedTrend,
            drillView, drillStack, pushDrill, popDrill, closeDrill, isDrill,
            openTypeDetail, openLocDetail, openModelDetail, openWoDetail,
            trendTypeColor,
            renderParetoChart, renderStatsCharts
        };
};
