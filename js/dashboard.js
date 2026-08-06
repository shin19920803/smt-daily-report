window.SMT = window.SMT || {};
SMT.dashboard = function (ctx) {
        const { activeWoNumbers, currentTab, currentLine, data, loading, assemblyDefectNotes, saveAssemblyDefectNote, assemblyHourlyNotes, assemblyStatusNotes, getAssemblyReportForDate, getAssemblyUploadedDates, getDafDashboardForDate, getDafUploadedDates } = ctx;
        const dashboard = ref({ activeWoCount: 0, todayInput: 0, todayDefects: 0, todayYield: 100, monthOocCount: 0, weekAvgYield: 0 });
        const assemblyDashboardResult = ref(null);
        const dafDashboardResult = ref(null);
        const dashboardRecentProds = ref([]);
        const dashboardRecentOoc = ref([]);
        const dashDate = ref(new Date().toISOString().split('T')[0]);
        const dashboardDetail = ref({ show: false, title: '', subtitle: '', metrics: [], sections: [], allowNote: false, noteKey: '', note: '' });
        const smtDashboardData = ref({ production: [], byType: [], byLocation: [], byModel: [], byWorkOrder: [], weekDays: [], trendDays: [], weekRange: null });
        const assemblyWeekDays = ref([]);
        const dafWeekDays = ref([]);

        const closeDashboardDetail = () => {
            dashboardDetail.value = { show: false, title: '', subtitle: '', metrics: [], sections: [], allowNote: false, noteKey: '', note: '' };
        };
        const openDashboardDetail = detail => {
            dashboardDetail.value = { ...detail, show: true, metrics: detail.metrics || [], sections: detail.sections || [], allowNote: !!detail.allowNote, noteKey: detail.noteKey || '', note: detail.note || '' };
        };
        const openDashboardDetailItem = item => { if (item?.detail) openDashboardDetail(item.detail); };
        const saveDashboardNote = () => {
            if (!dashboardDetail.value.allowNote || !dashboardDetail.value.noteKey || !saveAssemblyDefectNote) return;
            saveAssemblyDefectNote(dashboardDetail.value.noteKey, dashboardDetail.value.note);
        };
        const hourlyNoteKey = (category, hour) => `${category}::${String(hour).padStart(2, '0')}`;
        const statusNoteKey = (date, hour) => `${date}::${String(hour).padStart(2, '0')}`;
        const listFromMap = (map, total, detailFactory) => Object.entries(map || {})
            .map(([key, qty]) => ({ key, label: key, qty, ratio: total ? (qty / total * 100).toFixed(1) : '0.0', detail: detailFactory ? detailFactory(key, qty) : { title: `${key} 明細`, subtitle: '目前儀表板連動資料', metrics: [toMetric('數量', qty, 'slate')], sections: [] } }))
            .sort((a, b) => b.qty - a.qty);
        const mapIncrement = (map, key, qty = 1) => { if (key) map[key] = (map[key] || 0) + qty; };
        const toMetric = (label, value, tone = 'slate') => ({ label, value: Number(value) || 0, tone });
        const makeProductionDetail = row => ({
            title: `${row.workOrder || '未識別工單'} 生產明細`,
            subtitle: `${row.model || '未識別機種'} · ${row.date || dashDate.value}`,
            metrics: [toMetric('投入數', row.input, 'slate'), toMetric('不良數', row.defects, 'red'), { label: '良率', value: row.yieldRate + '%', tone: 'green' }],
            sections: [{ title: '不良項目', icon: 'fa-bug', items: listFromMap(row.byType, row.defects) }]
        });
        const makeDistributionSection = (title, icon, items) => ({ title, icon, items: items || [] });

        // 良率一律無條件捨去至小數 2 位：只要有不良就不會被進位成 100%
        const calcYield = (input, defects) => {
            if (!input) return '100.00';
            return (Math.floor((input - defects) / input * 10000) / 100).toFixed(2);
        };
        const fmtDate = date => date.toISOString().split('T')[0];
        const getWeekRange = dateValue => {
            const start = new Date(`${dateValue}T00:00:00`);
            start.setDate(start.getDate() - start.getDay());
            const end = new Date(start);
            end.setDate(end.getDate() + 6);
            return { start: fmtDate(start), end: fmtDate(end) };
        };
        const loadSmtDateRows = async (start, end = start) => {
            let query = _supabase.from('daily_production')
                .select('id, production_date, input_quantity, work_orders!inner(id, wo_number, models(name)), defect_logs(quantity, defect_types(name), defect_locations(code))')
                .eq('line', 'SMT').gte('production_date', start).lte('production_date', end);
            const { data: rows, error } = await query;
            if (error) throw error;
            return rows || [];
        };
        const normalizeSmtRows = rows => (rows || []).map(row => {
            const byType = {}, byLocation = {};
            let defects = 0;
            (row.defect_logs || []).forEach(log => {
                const qty = Number(log.quantity) || 0;
                const type = log.defect_types?.name || '未分類不良';
                const location = log.defect_locations?.code || '未指定位置';
                defects += qty;
                mapIncrement(byType, type, qty);
                mapIncrement(byLocation, location, qty);
            });
            return {
                id: row.id, date: row.production_date, input: Number(row.input_quantity) || 0, defects,
                good: Math.max(0, (Number(row.input_quantity) || 0) - defects),
                workOrder: row.work_orders?.wo_number || '未識別工單', model: row.work_orders?.models?.name || '未識別機種',
                byType, byLocation, defect_logs: row.defect_logs || [], yieldRate: calcYield(Number(row.input_quantity) || 0, defects)
            };
        });
        const buildSmtDateDetail = (date, rows) => {
            const normalized = normalizeSmtRows(rows);
            const input = normalized.reduce((sum, row) => sum + row.input, 0);
            const defects = normalized.reduce((sum, row) => sum + row.defects, 0);
            const byType = {}, byLocation = {}, byModel = {}, byWorkOrder = {};
            normalized.forEach(row => {
                mapIncrement(byModel, row.model, row.input);
                mapIncrement(byWorkOrder, row.workOrder, row.input);
                Object.entries(row.byType).forEach(([key, qty]) => mapIncrement(byType, key, qty));
                Object.entries(row.byLocation).forEach(([key, qty]) => mapIncrement(byLocation, key, qty));
            });
            return {
                title: `${date} 生產明細`, subtitle: `投入 ${input.toLocaleString()} · 不良 ${defects.toLocaleString()}`,
                metrics: [toMetric('投入數', input, 'slate'), toMetric('不良數', defects, 'red'), { label: '良率', value: calcYield(input, defects) + '%', tone: 'green' }],
                sections: [
                    makeDistributionSection('工單投入數量', 'fa-file-alt', listFromMap(byWorkOrder, input)),
                    makeDistributionSection('機種良率', 'fa-microchip', listFromMap(byModel, input, model => ({ title: `${model} 良率`, subtitle: date, metrics: [{ label: '投入數', value: byModel[model], tone: 'slate' }], sections: [] }))),
                    makeDistributionSection('不良項目', 'fa-bug', listFromMap(byType, defects)),
                    makeDistributionSection('不良位置', 'fa-map-marker-alt', listFromMap(byLocation, defects))
                ]
            };
        };
        const buildSmtTrendData = rows => {
            const dayMap = {};
            normalizeSmtRows(rows).forEach(row => {
                const day = dayMap[row.date] || (dayMap[row.date] = { date: row.date, input: 0, defects: 0 });
                day.input += row.input;
                day.defects += row.defects;
            });
            return Object.values(dayMap)
                .filter(day => day.input > 0)
                .sort((a, b) => a.date.localeCompare(b.date))
                .map(day => ({ ...day, yieldRate: calcYield(day.input, day.defects) }));
        };
        const buildSmtDashboardData = (rows, weekRows, weekRange, trendRows = []) => {
            const normalized = normalizeSmtRows(rows);
            const typeAgg = {}, locationAgg = {}, modelAgg = {}, workOrderAgg = {};
            normalized.forEach(row => {
                if (!modelAgg[row.model]) modelAgg[row.model] = { input: 0, defects: 0, byType: {}, byLocation: {}, byWorkOrder: {} };
                if (!workOrderAgg[row.workOrder]) workOrderAgg[row.workOrder] = { input: 0, defects: 0, byType: {}, byLocation: {}, byModel: {} };
                modelAgg[row.model].input += row.input;
                modelAgg[row.model].defects += row.defects;
                workOrderAgg[row.workOrder].input += row.input;
                workOrderAgg[row.workOrder].defects += row.defects;
                mapIncrement(modelAgg[row.model].byWorkOrder, row.workOrder, row.input);
                mapIncrement(workOrderAgg[row.workOrder].byModel, row.model, row.input);
                Object.entries(row.byType).forEach(([type, qty]) => {
                    if (!typeAgg[type]) typeAgg[type] = { qty: 0, byLocation: {}, byModel: {}, byWorkOrder: {} };
                    typeAgg[type].qty += qty;
                    mapIncrement(typeAgg[type].byModel, row.model, qty);
                    mapIncrement(typeAgg[type].byWorkOrder, row.workOrder, qty);
                    mapIncrement(modelAgg[row.model].byType, type, qty);
                    mapIncrement(workOrderAgg[row.workOrder].byType, type, qty);
                });
                Object.entries(row.byLocation).forEach(([location, qty]) => {
                    if (!locationAgg[location]) locationAgg[location] = { qty: 0, byType: {}, byModel: {}, byWorkOrder: {} };
                    locationAgg[location].qty += qty;
                    mapIncrement(locationAgg[location].byModel, row.model, qty);
                    mapIncrement(locationAgg[location].byWorkOrder, row.workOrder, qty);
                    mapIncrement(modelAgg[row.model].byLocation, location, qty);
                    mapIncrement(workOrderAgg[row.workOrder].byLocation, location, qty);
                });
            });
            // 依單筆 LOG 不良明細重建位置交叉分佈，避免同一筆含多個不良時位置歸類失真。
            normalized.forEach(row => (row.defect_logs || []).forEach(log => {
                const qty = Number(log.quantity) || 0;
                const type = log.defect_types?.name || '未分類不良';
                const location = log.defect_locations?.code || '未指定位置';
                if (typeAgg[type]) mapIncrement(typeAgg[type].byLocation, location, qty);
                if (locationAgg[location]) mapIncrement(locationAgg[location].byType, type, qty);
            }));
            const input = normalized.reduce((sum, row) => sum + row.input, 0);
            const defects = normalized.reduce((sum, row) => sum + row.defects, 0);
            const typeDetail = (name, agg) => ({
                title: `${name} 不良明細`, subtitle: `當日 ${dashDate.value} · ${agg.qty} 件`,
                metrics: [toMetric('不良數', agg.qty, 'red')],
                sections: [
                    makeDistributionSection('不良位置', 'fa-map-marker-alt', listFromMap(agg.byLocation, agg.qty)),
                    makeDistributionSection('機種分佈', 'fa-microchip', listFromMap(agg.byModel, agg.qty)),
                    makeDistributionSection('工單分佈', 'fa-file-alt', listFromMap(agg.byWorkOrder, agg.qty))
                ]
            });
            const locationDetail = (name, agg) => ({
                title: `${name} 不良明細`, subtitle: `當日 ${dashDate.value} · ${agg.qty} 件`,
                metrics: [toMetric('不良數', agg.qty, 'red')],
                sections: [
                    makeDistributionSection('不良項目', 'fa-bug', listFromMap(agg.byType, agg.qty)),
                    makeDistributionSection('機種分佈', 'fa-microchip', listFromMap(agg.byModel, agg.qty)),
                    makeDistributionSection('工單分佈', 'fa-file-alt', listFromMap(agg.byWorkOrder, agg.qty))
                ]
            });
            const modelDetail = (name, agg) => ({
                title: `${name} 良率明細`, subtitle: `當日 ${dashDate.value}`,
                metrics: [toMetric('投入數', agg.input, 'slate'), toMetric('不良數', agg.defects, 'red'), { label: '良率', value: calcYield(agg.input, agg.defects) + '%', tone: 'green' }],
                sections: [
                    makeDistributionSection('工單分佈', 'fa-file-alt', listFromMap(agg.byWorkOrder, agg.input)),
                    makeDistributionSection('不良項目', 'fa-bug', listFromMap(agg.byType, agg.defects)),
                    makeDistributionSection('不良位置', 'fa-map-marker-alt', listFromMap(agg.byLocation, agg.defects))
                ]
            });
            const workOrderDetail = (name, agg) => ({
                title: `${name} 良率明細`, subtitle: `當日 ${dashDate.value}`,
                metrics: [toMetric('投入數', agg.input, 'slate'), toMetric('不良數', agg.defects, 'red'), { label: '良率', value: calcYield(agg.input, agg.defects) + '%', tone: 'green' }],
                sections: [
                    makeDistributionSection('機種分佈', 'fa-microchip', listFromMap(agg.byModel, agg.input)),
                    makeDistributionSection('不良項目', 'fa-bug', listFromMap(agg.byType, agg.defects)),
                    makeDistributionSection('不良位置', 'fa-map-marker-alt', listFromMap(agg.byLocation, agg.defects))
                ]
            });
            const weekMap = {};
            normalizeSmtRows(weekRows).forEach(row => {
                const day = weekMap[row.date] || (weekMap[row.date] = { date: row.date, input: 0, defects: 0 });
                day.input += row.input;
                day.defects += row.defects;
            });
            const weekDays = Object.values(weekMap).filter(day => day.input > 0).sort((a, b) => a.date.localeCompare(b.date)).map(day => ({ ...day, yieldRate: calcYield(day.input, day.defects), detail: buildSmtDateDetail(day.date, weekRows.filter(row => row.production_date === day.date)) }));
            return {
                production: normalized.map(row => ({ ...row, detail: makeProductionDetail(row) })),
                byType: listFromMap(Object.fromEntries(Object.entries(typeAgg).map(([key, value]) => [key, value.qty])), defects, (key) => typeDetail(key, typeAgg[key])),
                byLocation: listFromMap(Object.fromEntries(Object.entries(locationAgg).map(([key, value]) => [key, value.qty])), defects, (key) => locationDetail(key, locationAgg[key])),
                byModel: listFromMap(Object.fromEntries(Object.entries(modelAgg).map(([key, value]) => [key, value.input])), input, (key) => modelDetail(key, modelAgg[key])),
                byWorkOrder: listFromMap(Object.fromEntries(Object.entries(workOrderAgg).map(([key, value]) => [key, value.input])), input, (key) => workOrderDetail(key, workOrderAgg[key])),
                weekDays, trendDays: buildSmtTrendData(trendRows), weekRange
            };
        };

        const changeDashDate = (delta) => {
            const d = new Date(dashDate.value);
            d.setDate(d.getDate() + delta);
            dashDate.value = d.toISOString().split('T')[0];
        };

        let dashboardRefreshId = 0;
        const refreshDashboard = async () => {
            const requestId = ++dashboardRefreshId;
            const line = currentLine.value;
            if (currentLine.value === 'ASSY') {
                assemblyDashboardResult.value = getAssemblyReportForDate(dashDate.value);
                const uploadedDates = getAssemblyUploadedDates ? getAssemblyUploadedDates(200) : [];
                if (!assemblyDashboardResult.value.totalRecords && dashDate.value === new Date().toISOString().split('T')[0] && uploadedDates.length) {
                    dashDate.value = uploadedDates[uploadedDates.length - 1];
                    return false;
                }
                const weekRange = getWeekRange(dashDate.value);
                assemblyWeekDays.value = (getAssemblyUploadedDates ? getAssemblyUploadedDates(200) : [])
                    .filter(date => date >= weekRange.start && date <= weekRange.end)
                    .map(date => ({ date, report: getAssemblyReportForDate(date) }))
                    .filter(day => day.report.totalRecords > 0);
                const weeklyDowntime = assemblyWeekDays.value.map(day => Number(day.report.downtimeRate));
                dashboard.value = { activeWoCount: 0, todayInput: assemblyDashboardResult.value.totalSuccess, todayDefects: assemblyDashboardResult.value.totalDefects, todayYield: assemblyDashboardResult.value.downtimeRate, monthOocCount: 0, weekAvgYield: weeklyDowntime.length ? (weeklyDowntime.reduce((sum, value) => sum + value, 0) / weeklyDowntime.length).toFixed(2) : '0.00' };
                dashboardRecentProds.value = [];
                dashboardRecentOoc.value = [];
                return requestId === dashboardRefreshId;
            }
            if (currentLine.value === 'DAF') {
                const uploadedDates = getDafUploadedDates ? getDafUploadedDates(200) : [];
                if (!getDafDashboardForDate) {
                    dafDashboardResult.value = null;
                } else {
                    const current = getDafDashboardForDate(dashDate.value);
                    const fallbackDate = uploadedDates[uploadedDates.length - 1];
                    if (!current.sourceFiles.length && fallbackDate && dashDate.value !== fallbackDate) {
                        dashDate.value = fallbackDate;
                        return false;
                    }
                    if (requestId !== dashboardRefreshId || line !== currentLine.value) return false;
                    dafDashboardResult.value = current;
                    const weekRange = getWeekRange(dashDate.value);
                    dafWeekDays.value = (getDafUploadedDates ? getDafUploadedDates(200) : [])
                        .filter(date => date >= weekRange.start && date <= weekRange.end)
                        .map(date => ({ date, report: getDafDashboardForDate(date) }))
                        .filter(day => day.report.totalInput > 0);
                    const weeklyYield = dafWeekDays.value.map(day => Number(day.report.yieldRate));
                    dashboard.value = { activeWoCount: 0, todayInput: current.totalInput, todayDefects: current.totalDefects, todayYield: current.defectRate, monthOocCount: 0, weekAvgYield: weeklyYield.length ? (weeklyYield.reduce((sum, value) => sum + value, 0) / weeklyYield.length).toFixed(2) : '0.00' };
                }
                dashboardRecentProds.value = [];
                dashboardRecentOoc.value = [];
                return requestId === dashboardRefreshId;
            }
            dashboard.value.activeWoCount = activeWoNumbers.value.length;
            const targetDate = dashDate.value;
            const weekRange = getWeekRange(targetDate);
            const trendStartDate = new Date(`${targetDate}T00:00:00`);
            trendStartDate.setDate(trendStartDate.getDate() - 13);
            const trendStart = fmtDate(trendStartDate);
            const queryStart = [trendStart, weekRange.start, targetDate].sort()[0];
            const queryEnd = [targetDate, weekRange.end].sort().pop();
            const rangeRows = await loadSmtDateRows(queryStart, queryEnd);
            if (requestId !== dashboardRefreshId || line !== currentLine.value) return false;
            const todayRows = rangeRows.filter(row => row.production_date === targetDate);
            const weekRows = rangeRows.filter(row => row.production_date >= weekRange.start && row.production_date <= weekRange.end);
            const trendRows = rangeRows.filter(row => row.production_date >= trendStart && row.production_date <= targetDate);
            const smtData = buildSmtDashboardData(todayRows, weekRows, weekRange, trendRows);
            smtDashboardData.value = smtData;
            dashboardRecentProds.value = smtData.production;
            dashboardRecentOoc.value = [];
            const tInput = smtData.production.reduce((sum, row) => sum + row.input, 0);
            const tDefects = smtData.production.reduce((sum, row) => sum + row.defects, 0);
            const weekYields = smtData.weekDays.map(day => Number(day.yieldRate));
            dashboard.value = {
                activeWoCount: activeWoNumbers.value.length,
                todayInput: tInput,
                todayDefects: tDefects,
                todayYield: calcYield(tInput, tDefects),
                monthOocCount: 0,
                weekAvgYield: weekYields.length ? (weekYields.reduce((sum, value) => sum + value, 0) / weekYields.length).toFixed(2) : '0.00'
            };
            return true;
        };
        const openSmtInputDetail = () => openDashboardDetail({
            title: `${dashDate.value} 當日投入`, subtitle: `依工單查看投入數量`,
            metrics: [toMetric('投入總數', dashboard.value.todayInput, 'slate')],
            sections: [makeDistributionSection('工單投入數量', 'fa-file-alt', smtDashboardData.value.production.map(row => ({ label: row.workOrder, qty: row.input, ratio: dashboard.value.todayInput ? (row.input / dashboard.value.todayInput * 100).toFixed(1) : '0.0', meta: row.model, detail: row.detail })))]
        });
        const openSmtYieldDetail = () => openDashboardDetail({
            title: `${dashDate.value} 當日良率`, subtitle: `每個機種／工單的良率明細`,
            metrics: [toMetric('投入總數', dashboard.value.todayInput, 'slate'), toMetric('不良總數', dashboard.value.todayDefects, 'red'), { label: '當日良率', value: dashboard.value.todayYield + '%', tone: 'green' }],
            sections: [makeDistributionSection('機種／工單良率', 'fa-chart-line', smtDashboardData.value.production.map(row => ({ label: `${row.model} · ${row.workOrder}`, qty: row.input, ratio: row.yieldRate + '%', meta: `不良 ${row.defects}`, detail: row.detail })))]
        });
        const openSmtDefectDetail = () => openDashboardDetail({
            title: `${dashDate.value} 當日不良`, subtitle: `可從不良項目、位置、機種與工單繼續查看`,
            metrics: [toMetric('不良總數', dashboard.value.todayDefects, 'red')],
            sections: [
                makeDistributionSection('不良項目', 'fa-bug', smtDashboardData.value.byType),
                makeDistributionSection('不良位置', 'fa-map-marker-alt', smtDashboardData.value.byLocation),
                makeDistributionSection('機種', 'fa-microchip', smtDashboardData.value.byModel),
                makeDistributionSection('工單', 'fa-file-alt', smtDashboardData.value.byWorkOrder)
            ]
        });
        const openSmtWeekDetail = () => openDashboardDetail({
            title: `${smtDashboardData.value.weekRange?.start || ''} ～ ${smtDashboardData.value.weekRange?.end || ''} 本週良率`,
            subtitle: `週日到週六；只平均實際有投入資料的 ${smtDashboardData.value.weekDays.length} 天`,
            metrics: [{ label: '本週平均良率', value: dashboard.value.weekAvgYield + '%', tone: 'green' }],
            sections: [makeDistributionSection('每日良率', 'fa-calendar-days', smtDashboardData.value.weekDays.map(day => ({ label: day.date, qty: day.input, ratio: day.yieldRate + '%', meta: `不良 ${day.defects}`, detail: day.detail })))]
        });
        const openSmtActiveWoDetail = () => openDashboardDetail({
            title: '進行中工單', subtitle: '目前尚未完成的工單',
            sections: [makeDistributionSection('工單清單', 'fa-file-alt', data.value.workOrders.filter(wo => !wo.is_closed && (wo.target_quantity - (wo.current_input || 0)) > 0).map(wo => ({ label: wo.wo_number, qty: wo.target_quantity - (wo.current_input || 0), ratio: '', meta: wo.models?.name })))]
        });
        const openSmtDateDetail = async date => {
            try {
                loading.value = true;
                const rows = await loadSmtDateRows(date);
                openDashboardDetail(buildSmtDateDetail(date, rows));
            } catch (error) { /* 儀表板細項失敗不阻斷主畫面 */ }
            finally { loading.value = false; }
        };
        const openDafWeekDetail = () => openDashboardDetail({
            title: `${getWeekRange(dashDate.value).start} ～ ${getWeekRange(dashDate.value).end} DAF 週平均良率`,
            subtitle: `週日到週六；只平均實際有資料的 ${dafWeekDays.value.length} 天`,
            metrics: [{ label: '週平均良率', value: dashboard.value.weekAvgYield + '%', tone: 'green' }],
            sections: [makeDistributionSection('每日良率', 'fa-calendar-days', dafWeekDays.value.map(day => ({ label: day.date, qty: day.report.totalInput, ratio: day.report.yieldRate + '%', meta: `不良 ${day.report.totalDefects}`, detail: { title: `${day.date} DAF 生產明細`, subtitle: '每日投入、良品、不良與良率', metrics: [toMetric('投入數', day.report.totalInput, 'slate'), toMetric('良品數', day.report.totalGood, 'green'), toMetric('不良數', day.report.totalDefects, 'red'), { label: '良率', value: day.report.yieldRate + '%', tone: 'green' }], sections: [makeDistributionSection('工單投入', 'fa-file-alt', (day.report.byWorkOrder || []).map(row => ({ label: row.name, qty: row.input || row.qty, ratio: row.ratio + '%' })))] } })))]
        });
        const buildDafReasonDetail = row => ({
            title: `${row.name} 不良明細`, subtitle: `${dashDate.value} · ${row.qty} 件`,
            metrics: [toMetric('不良數', row.qty, 'red')],
            sections: [
                makeDistributionSection('機種分佈', 'fa-microchip', (row.byModel || []).map(item => ({ label: item.name, qty: item.qty, ratio: item.ratio + '%' }))),
                makeDistributionSection('工單分佈', 'fa-file-alt', (row.byWorkOrder || []).map(item => ({ label: item.name, qty: item.qty, ratio: item.ratio + '%' })))
            ]
        });
        const openDafInputDetail = () => openDashboardDetail({
            title: `${dashDate.value} DAF 當日投入`, subtitle: '依工單查看投入數量',
            metrics: [toMetric('投入總數', dafDashboardResult.value?.totalInput, 'slate')],
            sections: [makeDistributionSection('工單投入數量', 'fa-file-alt', (dafDashboardResult.value?.byWorkOrder || []).map(row => ({ label: row.name, qty: row.input || row.qty, ratio: row.ratio + '%', meta: row.model, detail: { title: `${row.name} 良率明細`, subtitle: dashDate.value, metrics: [toMetric('投入數', row.input || row.qty, 'slate'), toMetric('不良數', row.defects, 'red'), { label: '良率', value: row.yieldRate + '%', tone: 'green' }], sections: [makeDistributionSection('機種分佈', 'fa-microchip', (row.byModel || []).map(item => ({ label: item.name, qty: item.qty, ratio: item.ratio + '%' })))] } })))]
        });
        const openDafYieldDetail = () => openDashboardDetail({
            title: `${dashDate.value} DAF 當日良率`, subtitle: '每個機種／工單的良率明細',
            metrics: [toMetric('投入數', dafDashboardResult.value?.totalInput, 'slate'), toMetric('不良數', dafDashboardResult.value?.totalDefects, 'red'), { label: '良率', value: (dafDashboardResult.value?.yieldRate || '0') + '%', tone: 'green' }],
            sections: [makeDistributionSection('機種良率', 'fa-microchip', (dafDashboardResult.value?.byModel || []).map(row => ({ label: row.name, qty: row.input || row.qty, ratio: row.yieldRate + '%', meta: `不良 ${row.defects}`, detail: { title: `${row.name} 良率明細`, subtitle: dashDate.value, metrics: [toMetric('投入數', row.input || row.qty, 'slate'), toMetric('良品數', row.good, 'green'), toMetric('不良數', row.defects, 'red'), { label: '良率', value: row.yieldRate + '%', tone: 'green' }], sections: [makeDistributionSection('工單分佈', 'fa-file-alt', (row.byWorkOrder || []).map(item => ({ label: item.name, qty: item.qty, ratio: item.ratio + '%' })))] } })))]
        });
        const openDafModelDetail = row => openDashboardDetail({ title: `${row.name} 良率明細`, subtitle: dashDate.value, metrics: [toMetric('投入數', row.input || row.qty, 'slate'), toMetric('良品數', row.good, 'green'), toMetric('不良數', row.defects, 'red'), { label: '良率', value: row.yieldRate + '%', tone: 'green' }], sections: [makeDistributionSection('工單分佈', 'fa-file-alt', (row.byWorkOrder || []).map(item => ({ label: item.name, qty: item.qty, ratio: item.ratio + '%' })))] });
        const openDafWorkOrderDetail = row => openDashboardDetail({ title: `${row.name} 良率明細`, subtitle: dashDate.value, metrics: [toMetric('投入數', row.input || row.qty, 'slate'), toMetric('良品數', row.good, 'green'), toMetric('不良數', row.defects, 'red'), { label: '良率', value: row.yieldRate + '%', tone: 'green' }], sections: [makeDistributionSection('機種分佈', 'fa-microchip', (row.byModel || []).map(item => ({ label: item.name, qty: item.qty, ratio: item.ratio + '%' })))] });
        const openDafDefectDashboardDetail = () => openDashboardDetail({
            title: `${dashDate.value} DAF 不良`, subtitle: '點擊不良項目可查看機種與工單',
            metrics: [toMetric('不良總數', dafDashboardResult.value?.totalDefects, 'red')],
            sections: [makeDistributionSection('不良原因', 'fa-bug', (dafDashboardResult.value?.byType || []).map(row => ({ label: row.name, qty: row.qty, ratio: row.ratio + '%', detail: buildDafReasonDetail(row) })))]
        });
        const openDafDateDetail = date => {
            const result = getDafDashboardForDate(date);
            openDashboardDetail({ title: `${date} DAF 生產明細`, subtitle: '每日投入、良品、不良與良率', metrics: [toMetric('投入數', result.totalInput, 'slate'), toMetric('良品數', result.totalGood, 'green'), toMetric('不良數', result.totalDefects, 'red'), { label: '良率', value: result.yieldRate + '%', tone: 'green' }], sections: [makeDistributionSection('工單投入', 'fa-file-alt', (result.byWorkOrder || []).map(row => ({ label: row.name, qty: row.input || row.qty, ratio: row.ratio + '%' }))), makeDistributionSection('不良原因', 'fa-bug', (result.byType || []).map(row => ({ label: row.name, qty: row.qty, ratio: row.ratio + '%', detail: buildDafReasonDetail(row) })))] });
        };
        const assemblyReasonDetail = row => {
            return { title: `${row.name} 停機明細`, subtitle: `${dashDate.value} · ${row.qty} 次`, metrics: [toMetric('發生次數', row.qty, 'red')], allowNote: false, sections: [makeDistributionSection('每小時發生次數', 'fa-clock', (row.hourly || []).map(item => {
                const note = item.note || assemblyStatusNotes?.value?.[statusNoteKey(dashDate.value, item.hour)] || assemblyHourlyNotes?.value?.[hourlyNoteKey(row.name, item.hour)] || '';
                return { label: item.label, qty: item.qty, ratio: row.qty ? (item.qty / row.qty * 100).toFixed(1) + '%' : '0.0%', isHourlyNote: true, note };
            })), makeDistributionSection('LOG 原始細項', 'fa-list-ul', (row.sourceItems || []).map(item => ({ label: item.message, qty: item.qty, ratio: item.ratio + '%' })))] };
        };
        const openAssemblyReasonDashboard = row => openDashboardDetail(assemblyReasonDetail(row));
        const openAssemblyInputDetail = () => openDashboardDetail({ title: `${dashDate.value} Mylar 產出`, subtitle: '依每小時查看生產成功數量', metrics: [toMetric('產出成功', assemblyDashboardResult.value?.totalSuccess, 'green')], sections: [makeDistributionSection('每小時產出', 'fa-clock', (assemblyDashboardResult.value?.hourly || []).filter(row => row.total > 0).map(row => ({ label: row.label, qty: row.production, ratio: '', meta: `NG ${row.ng}` })))] });
        const openAssemblyRateDetail = () => openDashboardDetail({ title: `${dashDate.value} Mylar 停機率`, subtitle: '依 LOG 分類查看停機原因', metrics: [toMetric('產出成功', assemblyDashboardResult.value?.totalSuccess, 'green'), toMetric('停機／不良', assemblyDashboardResult.value?.totalDefects, 'red'), { label: '停機率', value: (assemblyDashboardResult.value?.downtimeRate || '0') + '%', tone: 'red' }], sections: [makeDistributionSection('停機原因', 'fa-bug', (assemblyDashboardResult.value?.byType || []).map(row => ({ label: row.name, qty: row.qty, ratio: row.ratio + '%', detail: assemblyReasonDetail(row) })))] });
        const openAssemblyDefectDashboardDetail = () => openAssemblyRateDetail();
        const openAssemblyDateDetail = date => {
            const result = getAssemblyReportForDate(date);
            openDashboardDetail({ title: `${date} Mylar 生產明細`, subtitle: '產出成功、停機不良與每小時明細', metrics: [toMetric('產出成功', result.totalSuccess, 'green'), toMetric('停機／不良', result.totalDefects, 'red'), { label: '停機率', value: result.downtimeRate + '%', tone: 'red' }], sections: [makeDistributionSection('停機原因', 'fa-bug', (result.byType || []).map(row => ({ label: row.name, qty: row.qty, ratio: row.ratio + '%', detail: assemblyReasonDetail(row) }))), makeDistributionSection('每小時產出', 'fa-clock', (result.hourly || []).filter(row => row.total > 0).map(row => ({ label: row.label, qty: row.production, ratio: '', meta: `NG ${row.ng}` })))] });
        };
        const openAssemblyWeekDetail = () => openDashboardDetail({
            title: `${getWeekRange(dashDate.value).start} ～ ${getWeekRange(dashDate.value).end} Mylar 週平均停機率`,
            subtitle: `週日到週六；只平均實際有資料的 ${assemblyWeekDays.value.length} 天`,
            metrics: [{ label: '週平均停機率', value: dashboard.value.weekAvgYield + '%', tone: 'red' }],
            sections: [makeDistributionSection('每日停機率', 'fa-calendar-days', assemblyWeekDays.value.map(day => ({ label: day.date, qty: day.report.totalSuccess, ratio: day.report.downtimeRate + '%', meta: `NG ${day.report.totalDefects}`, detail: { title: `${day.date} Mylar 生產明細`, subtitle: '產出成功、停機不良與每小時明細', metrics: [toMetric('產出成功', day.report.totalSuccess, 'green'), toMetric('停機／不良', day.report.totalDefects, 'red'), { label: '停機率', value: day.report.downtimeRate + '%', tone: 'red' }], sections: [makeDistributionSection('停機原因', 'fa-bug', (day.report.byType || []).map(row => ({ label: row.name, qty: row.qty, ratio: row.ratio + '%', detail: assemblyReasonDetail(row) })))] } })))]
        });
        let dashYieldChartInst = null;
        let dashInputChartInst = null;
        let dashAssemblyDowntimeChartInst = null;
        let dashAssemblyReasonChartInst = null;
        let dashDafDailyChartInst = null;
        let dashDafReasonChartInst = null;
        const disposeChart = (chart) => { if (chart) chart.dispose(); return null; };
        const ensureDashboardChart = (chart, el) => {
            if (!el) return disposeChart(chart);
            if (chart && chart.getDom() === el) return chart;
            if (chart) chart.dispose();
            const existing = echarts.getInstanceByDom ? echarts.getInstanceByDom(el) : null;
            if (existing) existing.dispose();
            return echarts.init(el);
        };
        const setDashboardOption = (chart, option) => {
            chart.clear();
            chart.setOption(option, { notMerge: true, lazyUpdate: false });
        };
        const waitForDashboardLayout = async () => {
            await Vue.nextTick();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        };
        let dashboardChartRequestId = 0;
        const canRenderDashboard = (requestId, line) => requestId === dashboardChartRequestId && currentTab.value === 'dashboard' && currentLine.value === line;
        const initAssemblyDashboardCharts = async (requestId, line) => {
            const target = dashDate.value;
            const days = getAssemblyUploadedDates(14);
            const reports = days.map(date => getAssemblyReportForDate(date));
            const labels = days.map(d => d.slice(5));
            const downtime = reports.map(result => result.totalRecords > 0 ? parseFloat(result.downtimeRate) : null);
            const current = assemblyDashboardResult.value || getAssemblyReportForDate(target);
            await waitForDashboardLayout();
            if (!canRenderDashboard(requestId, line)) return;
            const downtimeEl = document.getElementById('dashAssemblyDowntimeChart');
            if (downtimeEl) {
                dashAssemblyDowntimeChartInst = ensureDashboardChart(dashAssemblyDowntimeChartInst, downtimeEl);
                setDashboardOption(dashAssemblyDowntimeChartInst, {
                    grid:{top:28,right:20,bottom:36,left:48},
                    tooltip:{trigger:'axis',formatter:p=>{const v=p[0];return v.name+'<br/>'+(v.value!==null?'<b>'+v.value+'%</b>':'無資料');}},
                    xAxis:{type:'category',data:labels,axisLabel:{fontSize:10,color:'#9ca3af'},axisLine:{lineStyle:{color:'#e5e7eb'}},splitLine:{show:false}},
                    yAxis:{type:'value',min:0,axisLabel:{formatter:'{value}%',fontSize:10,color:'#9ca3af'},splitLine:{lineStyle:{color:'#f3f4f6'}}},
                    series:[{type:'line',data:downtime,smooth:true,symbol:'circle',symbolSize:5,lineStyle:{color:'#dc2626',width:2.5},itemStyle:{color:'#dc2626'},areaStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:'rgba(220,38,38,0.15)'},{offset:1,color:'rgba(220,38,38,0)'}]}}}]
                });
                if (dashAssemblyDowntimeChartInst.off) dashAssemblyDowntimeChartInst.off('click');
                if (dashAssemblyDowntimeChartInst.on) dashAssemblyDowntimeChartInst.on('click', params => { if (days[params.dataIndex]) openAssemblyDateDetail(days[params.dataIndex]); });
            }
            const reasonEl = document.getElementById('dashAssemblyReasonChart');
            if (reasonEl) {
                dashAssemblyReasonChartInst = ensureDashboardChart(dashAssemblyReasonChartInst, reasonEl);
                const rows = (current?.byType || []).slice(0, 10).reverse();
                setDashboardOption(dashAssemblyReasonChartInst, {
                    grid:{top:12,right:20,bottom:24,left:112},
                    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},formatter:p=>p[0].name+'<br/><b>'+p[0].value+' 次</b>'},
                    xAxis:{type:'value',splitLine:{lineStyle:{color:'#f3f4f6'}},axisLabel:{fontSize:10,color:'#9ca3af'}},
                    yAxis:{type:'category',data:rows.map(row=>row.name),axisLabel:{fontSize:10,color:'#6b7280'}},
                    series:[{type:'bar',data:rows.map(row=>row.qty),barMaxWidth:18,itemStyle:{color:'#dc2626',borderRadius:[0,4,4,0]},label:{show:true,position:'right',fontSize:10}}]
                });
                if (dashAssemblyReasonChartInst.off) dashAssemblyReasonChartInst.off('click');
                if (dashAssemblyReasonChartInst.on) dashAssemblyReasonChartInst.on('click', params => { const row = (current?.byType || []).find(item => item.name === params.name); if (row) openDashboardDetail(assemblyReasonDetail(row)); });
            }
        };
        const initDafDashboardCharts = async (requestId, line) => {
            if (!getDafDashboardForDate) {
                dashDafDailyChartInst = disposeChart(dashDafDailyChartInst);
                dashDafReasonChartInst = disposeChart(dashDafReasonChartInst);
                return;
            }
            const dates = getDafUploadedDates ? getDafUploadedDates(14) : [];
            const reports = dates.map(date => getDafDashboardForDate(date));
            const current = dafDashboardResult.value || getDafDashboardForDate(dashDate.value);
            await waitForDashboardLayout();
            if (!canRenderDashboard(requestId, line)) return;
            const dailyEl = document.getElementById('dashDafDailyChart');
            if (dailyEl && dates.length) {
                dashDafDailyChartInst = ensureDashboardChart(dashDafDailyChartInst, dailyEl);
                setDashboardOption(dashDafDailyChartInst, {
                    grid: { top: 30, right: 20, bottom: 36, left: 48 },
                    tooltip: { trigger: 'axis' },
                    legend: { top: 0, right: 0, textStyle: { fontSize: 11 } },
                    xAxis: { type: 'category', data: dates.map(date => date.slice(5)), axisLabel: { fontSize: 10, color: '#9ca3af' } },
                    yAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 10, color: '#9ca3af' } },
                    series: [
                        { name: '投入數', type: 'bar', data: reports.map(row => row.totalInput), barMaxWidth: 24, itemStyle: { color: '#7c3aed' } },
                        { name: '良品數', type: 'bar', data: reports.map(row => row.totalGood), barMaxWidth: 24, itemStyle: { color: '#16a34a' } },
                        { name: '不良數', type: 'bar', data: reports.map(row => row.totalDefects), barMaxWidth: 24, itemStyle: { color: '#dc2626' } }
                    ]
                });
                if (dashDafDailyChartInst.off) dashDafDailyChartInst.off('click');
                if (dashDafDailyChartInst.on) dashDafDailyChartInst.on('click', params => { if (dates[params.dataIndex]) openDafDateDetail(dates[params.dataIndex]); });
            } else dashDafDailyChartInst = disposeChart(dashDafDailyChartInst);
            const reasonEl = document.getElementById('dashDafReasonChart');
            if (reasonEl && current?.byType?.length) {
                dashDafReasonChartInst = ensureDashboardChart(dashDafReasonChartInst, reasonEl);
                const rows = current.byType.slice(0, 10).reverse();
                setDashboardOption(dashDafReasonChartInst, {
                    grid: { top: 12, right: 24, bottom: 24, left: 120 },
                    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: params => `${params[0].name}<br/><b>${params[0].value} 件</b>` },
                    xAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 10, color: '#9ca3af' } },
                    yAxis: { type: 'category', data: rows.map(row => row.name), axisLabel: { fontSize: 10, color: '#6b7280' } },
                    series: [{ type: 'bar', data: rows.map(row => row.qty), barMaxWidth: 18, itemStyle: { color: '#dc2626', borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', fontSize: 10 } }]
                });
                if (dashDafReasonChartInst.off) dashDafReasonChartInst.off('click');
                if (dashDafReasonChartInst.on) dashDafReasonChartInst.on('click', params => { const row = (current?.byType || []).find(item => item.name === params.name); if (row) openDashboardDetail(buildDafReasonDetail(row)); });
            } else dashDafReasonChartInst = disposeChart(dashDafReasonChartInst);
        };
        const initDashboardCharts = async () => {
            const requestId = ++dashboardChartRequestId;
            const line = currentLine.value;
            if (currentTab.value !== 'dashboard') return;
            if (line === 'ASSY') {
                dashYieldChartInst = disposeChart(dashYieldChartInst);
                dashInputChartInst = disposeChart(dashInputChartInst);
                dashDafDailyChartInst = disposeChart(dashDafDailyChartInst);
                dashDafReasonChartInst = disposeChart(dashDafReasonChartInst);
                await initAssemblyDashboardCharts(requestId, line);
                return;
            }
            if (line === 'DAF') {
                dashYieldChartInst = disposeChart(dashYieldChartInst);
                dashInputChartInst = disposeChart(dashInputChartInst);
                dashAssemblyDowntimeChartInst = disposeChart(dashAssemblyDowntimeChartInst);
                dashAssemblyReasonChartInst = disposeChart(dashAssemblyReasonChartInst);
                await initDafDashboardCharts(requestId, line);
                return;
            }
            dashAssemblyDowntimeChartInst = disposeChart(dashAssemblyDowntimeChartInst);
            dashAssemblyReasonChartInst = disposeChart(dashAssemblyReasonChartInst);
            await waitForDashboardLayout();
            if (!canRenderDashboard(requestId, line)) return;
            const days = (smtDashboardData.value.trendDays || []).map(row => row.date);
            const labels = days.map(d => d.slice(5));
            const yields = (smtDashboardData.value.trendDays || []).map(row => parseFloat(row.yieldRate));
            const inputs = (smtDashboardData.value.trendDays || []).map(row => row.input);
            const yieldEl = document.getElementById('dashYieldChart');
            if (yieldEl) {
                dashYieldChartInst = ensureDashboardChart(dashYieldChartInst, yieldEl);
                setDashboardOption(dashYieldChartInst, {
                    grid:{top:28,right:20,bottom:36,left:48},
                    tooltip:{trigger:'axis',formatter:p=>{const v=p[0];return v.name+'<br/>'+(v.value!==null?'<b>'+v.value+'%</b>':'無資料');}},
                    xAxis:{type:'category',data:labels,axisLabel:{fontSize:10,color:'#9ca3af'},axisLine:{lineStyle:{color:'#e5e7eb'}},splitLine:{show:false}},
                    yAxis:{type:'value',min:v=>Math.max(90,Math.floor(v.min-1)),max:100,axisLabel:{formatter:'{value}%',fontSize:10,color:'#9ca3af'},splitLine:{lineStyle:{color:'#f3f4f6'}}},
                    series:[{type:'line',data:yields,smooth:true,symbol:'circle',symbolSize:5,lineStyle:{color:'#7c3aed',width:2.5},itemStyle:{color:'#7c3aed'},areaStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:'rgba(124,58,237,0.15)'},{offset:1,color:'rgba(124,58,237,0)'}]}},markLine:{silent:true,lineStyle:{color:'#dc2626',type:'dashed',width:1},data:[{yAxis:98,label:{formatter:'目標98%',position:'end',fontSize:10,color:'#dc2626'}}]}}]
                });
                if (dashYieldChartInst.off) dashYieldChartInst.off('click');
                if (dashYieldChartInst.on) dashYieldChartInst.on('click', params => { if (days[params.dataIndex]) openSmtDateDetail(days[params.dataIndex]); });
            }
            const inputEl = document.getElementById('dashInputChart');
            if (inputEl) {
                dashInputChartInst = ensureDashboardChart(dashInputChartInst, inputEl);
                setDashboardOption(dashInputChartInst, {
                    grid:{top:28,right:20,bottom:36,left:48},
                    tooltip:{trigger:'axis',formatter:p=>p[0].name+'<br/><b>'+p[0].value+' pcs</b>'},
                    xAxis:{type:'category',data:labels,axisLabel:{fontSize:10,color:'#9ca3af'},axisLine:{lineStyle:{color:'#e5e7eb'}},splitLine:{show:false}},
                    yAxis:{type:'value',axisLabel:{fontSize:10,color:'#9ca3af'},splitLine:{lineStyle:{color:'#f3f4f6'}}},
                    series:[{type:'bar',data:inputs,barMaxWidth:28,itemStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:'#1E40AF'},{offset:1,color:'#93C5FD'}]},borderRadius:[4,4,0,0]},emphasis:{itemStyle:{color:'#17318A'}}}]
                });
                if (dashInputChartInst.off) dashInputChartInst.off('click');
                if (dashInputChartInst.on) dashInputChartInst.on('click', params => { if (days[params.dataIndex]) openSmtDateDetail(days[params.dataIndex]); });
            }
            requestAnimationFrame(() => requestAnimationFrame(() => {
                if (dashYieldChartInst) dashYieldChartInst.resize();
                if (dashInputChartInst) dashInputChartInst.resize();
            }));
        };
        // 容器剛插入 DOM 時寬度可能為 0，ECharts 會以預設寬度初始化 → 渲染後強制 resize
        const resizeDashboardCharts = () => {
            [dashYieldChartInst, dashInputChartInst, dashAssemblyDowntimeChartInst, dashAssemblyReasonChartInst, dashDafDailyChartInst, dashDafReasonChartInst].forEach(inst => { if (inst) inst.resize(); });
        };
        const refreshDashboardAndCharts = async () => {
            const refreshed = await refreshDashboard();
            if (refreshed !== false && currentTab.value === 'dashboard') await initDashboardCharts();
        };
        window.addEventListener('resize', () => { if (currentTab.value === 'dashboard') resizeDashboardCharts(); });

        watch(currentTab, async (tab) => {
            if (tab !== 'dashboard') {
                dashboardChartRequestId++;
                return;
            }
            const refreshed = await refreshDashboard();
            if (refreshed !== false && currentTab.value === 'dashboard') await initDashboardCharts();
        });
        watch(dashDate, async () => {
            if (currentTab.value !== 'dashboard') return;
            const refreshed = await refreshDashboard();
            if (refreshed !== false && currentTab.value === 'dashboard') await initDashboardCharts();
        });
        return {
            dashboard, assemblyDashboardResult, dafDashboardResult, dashboardRecentProds, dashboardRecentOoc, dashDate,
            dashboardDetail, smtDashboardData, assemblyWeekDays, dafWeekDays,
            changeDashDate, refreshDashboard, refreshDashboardAndCharts, initDashboardCharts,
            openDashboardDetail, openDashboardDetailItem, closeDashboardDetail, saveDashboardNote,
            openSmtInputDetail, openSmtYieldDetail, openSmtDefectDetail, openSmtWeekDetail, openSmtActiveWoDetail,
            openDafInputDetail, openDafYieldDetail, openDafDefectDashboardDetail, openDafWeekDetail,
            openDafModelDetail, openDafWorkOrderDetail,
            openAssemblyInputDetail, openAssemblyRateDetail, openAssemblyDefectDashboardDetail, openAssemblyReasonDashboard, openAssemblyWeekDetail
        };
};
