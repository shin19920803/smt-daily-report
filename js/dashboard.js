window.SMT = window.SMT || {};
SMT.dashboard = function (ctx) {
        const { activeWoNumbers, currentTab, currentLine, getAssemblyReportForDate } = ctx;
        const dashboard = ref({ activeWoCount: 0, todayInput: 0, todayDefects: 0, todayYield: 100, monthOocCount: 0, weekAvgYield: 0 });
        const assemblyDashboardResult = ref(null);
        const dashboardRecentProds = ref([]);
        const dashboardRecentOoc = ref([]);
        const dashDate = ref(new Date().toISOString().split('T')[0]);

        // 良率一律無條件捨去至小數 2 位：只要有不良就不會被進位成 100%
        const calcYield = (input, defects) => {
            if (!input) return '100.00';
            return (Math.floor((input - defects) / input * 10000) / 100).toFixed(2);
        };

        const changeDashDate = (delta) => {
            const d = new Date(dashDate.value);
            d.setDate(d.getDate() + delta);
            dashDate.value = d.toISOString().split('T')[0];
            refreshDashboard();
        };

        const refreshDashboard = async () => {
            if (currentLine.value === 'ASSY') {
                assemblyDashboardResult.value = getAssemblyReportForDate(dashDate.value);
                dashboard.value = { activeWoCount: 0, todayInput: assemblyDashboardResult.value.totalSuccess, todayDefects: assemblyDashboardResult.value.totalDefects, todayYield: assemblyDashboardResult.value.downtimeRate, monthOocCount: 0, weekAvgYield: 0 };
                dashboardRecentProds.value = [];
                dashboardRecentOoc.value = [];
                return;
            }
            dashboard.value.activeWoCount = activeWoNumbers.value.length;

            const targetDate = dashDate.value;
            const { data: todayProds } = await _supabase.from('daily_production').select('input_quantity, defect_logs(quantity)').eq('line', currentLine.value).eq('production_date', targetDate);
            let tInput = 0, tDefects = 0;
            (todayProds || []).forEach(p => { tInput += p.input_quantity; p.defect_logs.forEach(d => { tDefects += d.quantity; }); });
            dashboard.value.todayInput = tInput;
            dashboard.value.todayDefects = tDefects;
            dashboard.value.todayYield = calcYield(tInput, tDefects);

            const monthStart = targetDate.slice(0, 7) + '-01';
            const { data: oocMonth, count: oocCount } = await _supabase.from('ooc_records').select('id', { count: 'exact' }).eq('line', currentLine.value).gte('production_date', monthStart).lte('production_date', targetDate);
            dashboard.value.monthOocCount = oocCount || 0;

            const weekAgo = new Date(targetDate); weekAgo.setDate(weekAgo.getDate() - 7);
            const weekStr = weekAgo.toISOString().split('T')[0];
            const { data: weekProds } = await _supabase.from('daily_production').select('input_quantity, defect_logs(quantity)').eq('line', currentLine.value).gte('production_date', weekStr).lte('production_date', targetDate);
            let wInput = 0, wDefects = 0;
            (weekProds || []).forEach(p => { wInput += p.input_quantity; p.defect_logs.forEach(d => { wDefects += d.quantity; }); });
            dashboard.value.weekAvgYield = calcYield(wInput, wDefects);

            const { data: recentProds } = await _supabase.from('daily_production').select('*, work_orders(wo_number, models(name)), defect_logs(quantity)').eq('line', currentLine.value).eq('production_date', targetDate).order('production_date', { ascending: false }).limit(20);
            dashboardRecentProds.value = (recentProds || []).map(item => ({ ...item, defect_count: item.defect_logs.reduce((s, d) => s + (d.quantity || 0), 0) }));

            const { data: recentOoc } = await _supabase.from('ooc_records').select('*, work_orders(wo_number, models(name)), machines(name), ooc_causes(name)').eq('line', currentLine.value).eq('production_date', targetDate).order('production_date', {ascending:false}).limit(10);
            dashboardRecentOoc.value = recentOoc || [];
        };
        let dashYieldChartInst = null;
        let dashInputChartInst = null;
        let dashAssemblyDowntimeChartInst = null;
        let dashAssemblyReasonChartInst = null;
        const disposeChart = (chart) => { if (chart) chart.dispose(); return null; };
        const initAssemblyDashboardCharts = async () => {
            const target = dashDate.value;
            const days = [];
            for (let i = 13; i >= 0; i--) {
                const d = new Date(`${target}T00:00:00`); d.setDate(d.getDate() - i);
                days.push(d.toISOString().split('T')[0]);
            }
            const reports = days.map(date => getAssemblyReportForDate(date));
            const labels = days.map(d => d.slice(5));
            const downtime = reports.map(result => result.totalRecords > 0 ? parseFloat(result.downtimeRate) : null);
            const current = assemblyDashboardResult.value || getAssemblyReportForDate(target);
            await Vue.nextTick();
            const downtimeEl = document.getElementById('dashAssemblyDowntimeChart');
            if (downtimeEl) {
                if (!dashAssemblyDowntimeChartInst) dashAssemblyDowntimeChartInst = echarts.init(downtimeEl);
                dashAssemblyDowntimeChartInst.setOption({
                    grid:{top:28,right:20,bottom:36,left:48},
                    tooltip:{trigger:'axis',formatter:p=>{const v=p[0];return v.name+'<br/>'+(v.value!==null?'<b>'+v.value+'%</b>':'無資料');}},
                    xAxis:{type:'category',data:labels,axisLabel:{fontSize:10,color:'#9ca3af'},axisLine:{lineStyle:{color:'#e5e7eb'}},splitLine:{show:false}},
                    yAxis:{type:'value',min:0,axisLabel:{formatter:'{value}%',fontSize:10,color:'#9ca3af'},splitLine:{lineStyle:{color:'#f3f4f6'}}},
                    series:[{type:'line',data:downtime,smooth:true,symbol:'circle',symbolSize:5,lineStyle:{color:'#dc2626',width:2.5},itemStyle:{color:'#dc2626'},areaStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:'rgba(220,38,38,0.15)'},{offset:1,color:'rgba(220,38,38,0)'}]}}}]
                });
            }
            const reasonEl = document.getElementById('dashAssemblyReasonChart');
            if (reasonEl) {
                if (!dashAssemblyReasonChartInst) dashAssemblyReasonChartInst = echarts.init(reasonEl);
                const rows = (current?.byType || []).slice(0, 10).reverse();
                dashAssemblyReasonChartInst.setOption({
                    grid:{top:12,right:20,bottom:24,left:112},
                    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},formatter:p=>p[0].name+'<br/><b>'+p[0].value+' 次</b>'},
                    xAxis:{type:'value',splitLine:{lineStyle:{color:'#f3f4f6'}},axisLabel:{fontSize:10,color:'#9ca3af'}},
                    yAxis:{type:'category',data:rows.map(row=>row.name),axisLabel:{fontSize:10,color:'#6b7280'}},
                    series:[{type:'bar',data:rows.map(row=>row.qty),barMaxWidth:18,itemStyle:{color:'#dc2626',borderRadius:[0,4,4,0]},label:{show:true,position:'right',fontSize:10}}]
                });
            }
        };
        const initDashboardCharts = async () => {
            if (currentLine.value === 'ASSY') {
                dashYieldChartInst = disposeChart(dashYieldChartInst);
                dashInputChartInst = disposeChart(dashInputChartInst);
                await initAssemblyDashboardCharts();
                return;
            }
            dashAssemblyDowntimeChartInst = disposeChart(dashAssemblyDowntimeChartInst);
            dashAssemblyReasonChartInst = disposeChart(dashAssemblyReasonChartInst);
            const today = new Date();
            const days = [];
            for (let i = 13; i >= 0; i--) {
                const d = new Date(today); d.setDate(d.getDate() - i);
                days.push(d.toISOString().split('T')[0]);
            }
            const { data: prods } = await _supabase
                .from('daily_production')
                .select('production_date, input_quantity, defect_logs(quantity)')
                .eq('line', currentLine.value)
                .gte('production_date', days[0]).lte('production_date', days[days.length-1]);
            const dayMap = {};
            days.forEach(d => { dayMap[d] = { input: 0, defects: 0 }; });
            (prods || []).forEach(p => {
                if (dayMap[p.production_date]) {
                    dayMap[p.production_date].input += p.input_quantity;
                    dayMap[p.production_date].defects += (p.defect_logs||[]).reduce((s,d)=>s+d.quantity,0);
                }
            });
            const labels = days.map(d => d.slice(5));
            const yields = days.map(d => { const {input,defects}=dayMap[d]; return input>0?parseFloat(calcYield(input,defects)):null; });
            const inputs = days.map(d => dayMap[d].input);
            await Vue.nextTick();
            const yieldEl = document.getElementById('dashYieldChart');
            if (yieldEl) {
                if (!dashYieldChartInst) dashYieldChartInst = echarts.init(yieldEl);
                dashYieldChartInst.setOption({
                    grid:{top:28,right:20,bottom:36,left:48},
                    tooltip:{trigger:'axis',formatter:p=>{const v=p[0];return v.name+'<br/>'+(v.value!==null?'<b>'+v.value+'%</b>':'無資料');}},
                    xAxis:{type:'category',data:labels,axisLabel:{fontSize:10,color:'#9ca3af'},axisLine:{lineStyle:{color:'#e5e7eb'}},splitLine:{show:false}},
                    yAxis:{type:'value',min:v=>Math.max(90,Math.floor(v.min-1)),max:100,axisLabel:{formatter:'{value}%',fontSize:10,color:'#9ca3af'},splitLine:{lineStyle:{color:'#f3f4f6'}}},
                    series:[{type:'line',data:yields,smooth:true,symbol:'circle',symbolSize:5,lineStyle:{color:'#7c3aed',width:2.5},itemStyle:{color:'#7c3aed'},areaStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:'rgba(124,58,237,0.15)'},{offset:1,color:'rgba(124,58,237,0)'}]}},markLine:{silent:true,lineStyle:{color:'#dc2626',type:'dashed',width:1},data:[{yAxis:98,label:{formatter:'目標98%',position:'end',fontSize:10,color:'#dc2626'}}]}}]
                });
            }
            const inputEl = document.getElementById('dashInputChart');
            if (inputEl) {
                if (!dashInputChartInst) dashInputChartInst = echarts.init(inputEl);
                dashInputChartInst.setOption({
                    grid:{top:28,right:20,bottom:36,left:48},
                    tooltip:{trigger:'axis',formatter:p=>p[0].name+'<br/><b>'+p[0].value+' pcs</b>'},
                    xAxis:{type:'category',data:labels,axisLabel:{fontSize:10,color:'#9ca3af'},axisLine:{lineStyle:{color:'#e5e7eb'}},splitLine:{show:false}},
                    yAxis:{type:'value',axisLabel:{fontSize:10,color:'#9ca3af'},splitLine:{lineStyle:{color:'#f3f4f6'}}},
                    series:[{type:'bar',data:inputs,barMaxWidth:28,itemStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:'#1E40AF'},{offset:1,color:'#93C5FD'}]},borderRadius:[4,4,0,0]},emphasis:{itemStyle:{color:'#17318A'}}}]
                });
            }
            requestAnimationFrame(() => requestAnimationFrame(() => {
                if (dashYieldChartInst) dashYieldChartInst.resize();
                if (dashInputChartInst) dashInputChartInst.resize();
            }));
        };
        // 容器剛插入 DOM 時寬度可能為 0，ECharts 會以預設寬度初始化 → 渲染後強制 resize
        const resizeDashboardCharts = () => {
            [dashYieldChartInst, dashInputChartInst, dashAssemblyDowntimeChartInst, dashAssemblyReasonChartInst].forEach(inst => { if (inst) inst.resize(); });
        };
        window.addEventListener('resize', () => { if (currentTab.value === 'dashboard') resizeDashboardCharts(); });

        watch(currentTab, async (tab) => { if (tab === 'dashboard') { await refreshDashboard(); await initDashboardCharts(); } });
        watch(dashDate, async () => { if (currentTab.value === 'dashboard') { await refreshDashboard(); await initDashboardCharts(); } });
        return {
            dashboard, assemblyDashboardResult, dashboardRecentProds, dashboardRecentOoc, dashDate,
            changeDashDate, refreshDashboard, initDashboardCharts
        };
};
