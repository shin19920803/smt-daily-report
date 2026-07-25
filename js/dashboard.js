window.SMT = window.SMT || {};
SMT.dashboard = function (ctx) {
        const { activeWoNumbers, currentTab } = ctx;
        const dashboard = ref({ activeWoCount: 0, todayInput: 0, todayDefects: 0, todayYield: 100, monthOocCount: 0, weekAvgYield: 0 });
        const dashboardRecentProds = ref([]);
        const dashboardRecentOoc = ref([]);
        const dashDate = ref(new Date().toISOString().split('T')[0]);

        const changeDashDate = (delta) => {
            const d = new Date(dashDate.value);
            d.setDate(d.getDate() + delta);
            dashDate.value = d.toISOString().split('T')[0];
            refreshDashboard();
        };

        const refreshDashboard = async () => {
            dashboard.value.activeWoCount = activeWoNumbers.value.length;

            const targetDate = dashDate.value;
            const { data: todayProds } = await _supabase.from('daily_production').select('input_quantity, defect_logs(quantity)').eq('production_date', targetDate);
            let tInput = 0, tDefects = 0;
            (todayProds || []).forEach(p => { tInput += p.input_quantity; p.defect_logs.forEach(d => { tDefects += d.quantity; }); });
            dashboard.value.todayInput = tInput;
            dashboard.value.todayDefects = tDefects;
            dashboard.value.todayYield = tInput ? ((tInput - tDefects) / tInput * 100).toFixed(1) : '100.0';

            const monthStart = targetDate.slice(0, 7) + '-01';
            const { data: oocMonth, count: oocCount } = await _supabase.from('ooc_records').select('id', { count: 'exact' }).gte('production_date', monthStart).lte('production_date', targetDate);
            dashboard.value.monthOocCount = oocCount || 0;

            const weekAgo = new Date(targetDate); weekAgo.setDate(weekAgo.getDate() - 7);
            const weekStr = weekAgo.toISOString().split('T')[0];
            const { data: weekProds } = await _supabase.from('daily_production').select('input_quantity, defect_logs(quantity)').gte('production_date', weekStr).lte('production_date', targetDate);
            let wInput = 0, wDefects = 0;
            (weekProds || []).forEach(p => { wInput += p.input_quantity; p.defect_logs.forEach(d => { wDefects += d.quantity; }); });
            dashboard.value.weekAvgYield = wInput ? ((wInput - wDefects) / wInput * 100).toFixed(1) : '100.0';

            const { data: recentProds } = await _supabase.from('daily_production').select('*, work_orders(wo_number, models(name)), defect_logs(quantity)').eq('production_date', targetDate).order('production_date', { ascending: false }).limit(20);
            dashboardRecentProds.value = (recentProds || []).map(item => ({ ...item, defect_count: item.defect_logs.reduce((s, d) => s + (d.quantity || 0), 0) }));

            const { data: recentOoc } = await _supabase.from('ooc_records').select('*, work_orders(wo_number, models(name)), machines(name), ooc_causes(name)').eq('production_date', targetDate).order('production_date', {ascending:false}).limit(10);
            dashboardRecentOoc.value = recentOoc || [];
        };
        let dashYieldChartInst = null;
        let dashInputChartInst = null;
        const initDashboardCharts = async () => {
            const today = new Date();
            const days = [];
            for (let i = 13; i >= 0; i--) {
                const d = new Date(today); d.setDate(d.getDate() - i);
                days.push(d.toISOString().split('T')[0]);
            }
            const { data: prods } = await _supabase
                .from('daily_production')
                .select('production_date, input_quantity, defect_logs(quantity)')
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
            const yields = days.map(d => { const {input,defects}=dayMap[d]; return input>0?parseFloat(((input-defects)/input*100).toFixed(2)):null; });
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
                    series:[{type:'bar',data:inputs,barMaxWidth:28,itemStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:'#2563eb'},{offset:1,color:'#93c5fd'}]},borderRadius:[4,4,0,0]},emphasis:{itemStyle:{color:'#1d4ed8'}}}]
                });
            }
        };
        watch(currentTab, async (tab) => { if (tab === 'dashboard') { await initDashboardCharts(); } });
        return {
            dashboard, dashboardRecentProds, dashboardRecentOoc, dashDate,
            changeDashDate, refreshDashboard, initDashboardCharts
        };
};
