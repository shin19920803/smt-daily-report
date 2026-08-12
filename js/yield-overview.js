window.SMT = window.SMT || {};

// 跨製程良率總覽：只讀取各製程既有資料，不改動原資料表。
SMT.yieldOverview = function (ctx) {
    const { currentTab, switchLine, toast } = ctx;
    const processLines = SMT.LINES.map(line => ({ id: line.id, label: line.label }));
    const dafLines = ['DAF', 'FT1', 'FT2', 'ASSEMBLY', 'LIGHTING'];
    const fmtDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const dateDaysAgo = days => { const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - days); return fmtDate(date); };
    const overviewFilter = ref({ start: dateDaysAgo(6), end: fmtDate(new Date()) });
    const overviewResult = ref(null);
    const overviewLoading = ref(false);
    let requestId = 0;

    const emptyProcess = line => ({ id: line.id, label: line.label, input: 0, output: 0, defects: 0, yieldRate: '0.00', defectRate: '0.00', days: 0 });
    const inRange = (date, start, end) => (!date || (!start || date >= start) && (!end || date <= end));
    const fetchRows = async (table, columns, configure = query => query) => {
        const rows = [];
        const pageSize = 1000;
        for (let offset = 0; ; offset += pageSize) {
            const { data, error } = await configure(_supabase.from(table).select(columns).range(offset, offset + pageSize - 1));
            if (error) throw error;
            rows.push(...(data || []));
            if (!data || data.length < pageSize) return rows;
        }
    };
    const add = (map, date, input, output, defects) => {
        const day = map[date] || (map[date] = { date, input: 0, output: 0, defects: 0 });
        day.input += Number(input) || 0;
        day.output += Number(output) || 0;
        day.defects += Number(defects) || 0;
    };
    const finalize = (line, dayMap) => {
        const days = Object.values(dayMap).filter(day => day.input > 0).sort((a, b) => a.date.localeCompare(b.date));
        const input = days.reduce((sum, day) => sum + day.input, 0);
        const output = days.reduce((sum, day) => sum + day.output, 0);
        const defects = days.reduce((sum, day) => sum + day.defects, 0);
        return {
            ...emptyProcess(line), input, output, defects,
            yieldRate: input ? (output / input * 100).toFixed(2) : '0.00',
            defectRate: input ? (defects / input * 100).toFixed(2) : '0.00',
            days,
            daysCount: days.length
        };
    };

    const loadSmt = async () => {
        const data = await fetchRows('daily_production', 'production_date, input_quantity, defect_logs(quantity)', query => {
            query = query.eq('line', 'SMT').order('production_date', { ascending: true });
            if (overviewFilter.value.start) query = query.gte('production_date', overviewFilter.value.start);
            if (overviewFilter.value.end) query = query.lte('production_date', overviewFilter.value.end);
            return query;
        });
        const dayMap = {};
        (data || []).forEach(row => {
            const defects = (row.defect_logs || []).reduce((sum, log) => sum + (Number(log.quantity) || 0), 0);
            add(dayMap, row.production_date, row.input_quantity, (Number(row.input_quantity) || 0) - defects, defects);
        });
        return finalize(processLines.find(line => line.id === 'SMT'), dayMap);
    };

    const loadDafLike = async () => {
        const result = Object.fromEntries(dafLines.map(id => [id, {}]));
        const data = await fetchRows('daf_log_batches', 'line, records', query => query.in('line', dafLines).order('uploaded_at', { ascending: false }));
        (data || []).forEach(batch => (batch.records || []).forEach(record => {
            if (!inRange(record.date, overviewFilter.value.start, overviewFilter.value.end) || !record.inputIncluded) return;
            const dayMap = result[batch.line] || (result[batch.line] = {});
            add(dayMap, record.date, 1, record.status === 'GOOD' ? 1 : 0, record.status === 'FAIL' ? 1 : 0);
        }));
        return Object.fromEntries(dafLines.map(id => [id, finalize(processLines.find(line => line.id === id), result[id])]));
    };

    const loadAssembly = async () => {
        const data = await fetchRows('assembly_log_batches', 'line, buckets', query => query.eq('line', 'ASSY').order('uploaded_at', { ascending: false }));
        const dayMap = {};
        (data || []).forEach(batch => Object.entries(batch.buckets || {}).forEach(([date, bucket]) => {
            if (!inRange(date, overviewFilter.value.start, overviewFilter.value.end)) return;
            const output = Number(bucket.success) || 0;
            const defects = Number(bucket.ng) || 0;
            add(dayMap, date, output + defects, output, defects);
        }));
        return finalize(processLines.find(line => line.id === 'ASSY'), dayMap);
    };

    const loadOverview = async (showToast = false) => {
        if (overviewFilter.value.start && overviewFilter.value.end && overviewFilter.value.start > overviewFilter.value.end) {
            return toast('開始日期不能晚於結束日期', 'warning');
        }
        const id = ++requestId;
        overviewLoading.value = true;
        try {
            const [smt, daf, assembly] = await Promise.allSettled([loadSmt(), loadDafLike(), loadAssembly()]);
            if (id !== requestId) return;
            const process = processLines.map(line => {
                if (line.id === 'SMT') return smt.status === 'fulfilled' ? smt.value : emptyProcess(line);
                if (line.id === 'ASSY') return assembly.status === 'fulfilled' ? assembly.value : emptyProcess(line);
                return daf.status === 'fulfilled' ? daf.value[line.id] : emptyProcess(line);
            });
            const days = {};
            process.forEach(item => (item.days || []).forEach(day => {
                const target = days[day.date] || (days[day.date] = { date: day.date, input: 0, output: 0, defects: 0 });
                target.input += day.input; target.output += day.output; target.defects += day.defects;
            }));
            const totalInput = process.reduce((sum, item) => sum + item.input, 0);
            const totalOutput = process.reduce((sum, item) => sum + item.output, 0);
            const totalDefects = process.reduce((sum, item) => sum + item.defects, 0);
            overviewResult.value = {
                process,
                days: Object.values(days).sort((a, b) => a.date.localeCompare(b.date)),
                totalInput, totalOutput, totalDefects,
                yieldRate: totalInput ? (totalOutput / totalInput * 100).toFixed(2) : '0.00',
                defectRate: totalInput ? (totalDefects / totalInput * 100).toFixed(2) : '0.00',
                errors: [smt, daf, assembly].filter(item => item.status === 'rejected').length
            };
            if (showToast) toast('科雅生產良率總覽已更新');
        } catch (error) {
            if (id === requestId) toast('總覽讀取失敗：' + error.message, 'error');
        } finally {
            if (id === requestId) overviewLoading.value = false;
        }
    };

    const resetOverviewRange = () => {
        overviewFilter.value = { start: dateDaysAgo(6), end: fmtDate(new Date()) };
        loadOverview();
    };
    const openProcessOverview = line => { if (line?.id) Promise.resolve(switchLine(line.id)).then(() => { currentTab.value = 'dashboard'; }); };

    watch(currentTab, tab => { if (tab === 'yieldOverview' && !overviewResult.value) loadOverview(); });
    if (currentTab.value === 'yieldOverview') loadOverview();

    return {
        processLines, overviewFilter, overviewResult, overviewLoading,
        loadOverview, resetOverviewRange, openProcessOverview
    };
};
