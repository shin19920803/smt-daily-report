window.SMT = window.SMT || {};
SMT.settings = function (ctx) {
        const { data, toast, loadBaseData, currentLine } = ctx;
        const settingConfig = ref({ 
            models: { title: '機種清單', colorClass: 'text-indigo-600', btnColor: 'bg-indigo-600', input: '', placeholder: '新機種名稱', field: 'name' }, 
            defect_types: { title: '不良項目', colorClass: 'text-red-600', btnColor: 'bg-red-600', input: '', placeholder: '不良現象', field: 'name' }, 
            defect_locations: { title: '位置代碼', colorClass: 'text-green-600', btnColor: 'bg-green-600', input: '', placeholder: '位置代碼', field: 'code' },
            machines: { title: '機台清單', colorClass: 'text-purple-600', btnColor: 'bg-purple-600', input: '', placeholder: '機台名稱', field: 'name' },
            ooc_causes: { title: 'OOC 原因', colorClass: 'text-pink-600', btnColor: 'bg-pink-600', input: '', placeholder: '異常原因', field: 'name' }
        });
        const editingId = ref(null); const editingValue = ref('');
        const sortedList = (key) => { 
            let list = [];
            if(['models','defect_types','defect_locations'].includes(key)) list = data.value[key.replace(/_([a-z])/g, (g) => g[1].toUpperCase())] || data.value[key];
            else list = data.value[key.replace('ooc_causes', 'oocCauses')] || [];
            const field = settingConfig.value[key].field; 
            return [...list].sort((a, b) => a[field].localeCompare(b[field], 'zh-Hant')); 
        };
        const addSettingItem = async (key) => { const cfg = settingConfig.value[key]; const val = cfg.input.trim(); if (!val) return; await _supabase.from(key).insert({ [cfg.field]: val, line: currentLine.value }); cfg.input = ''; loadBaseData(); toast("已新增"); };
        const deleteSettingItem = async (key, id) => { if(!confirm("確定刪除？")) return; await _supabase.from(key).delete().eq('id', id); loadBaseData(); toast("已刪除", "info"); };
        const startEdit = (id, val) => { editingId.value = id; editingValue.value = val; };
        const saveEdit = async (key, id, field) => { if (!editingValue.value.trim()) return; await _supabase.from(key).update({ [field]: editingValue.value }).eq('id', id); editingId.value = null; loadBaseData(); toast("已更新"); };
        return {
            settingConfig, sortedList, addSettingItem, deleteSettingItem,
            editingId, editingValue, startEdit, saveEdit
        };
};
