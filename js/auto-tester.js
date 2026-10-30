(function (root) {
    const MAX_FILE_BYTES = 10 * 1024 * 1024;
    const MAX_UNIQUE_RECORDS = 25000;

    const parseCsvRows = text => {
        const input = String(text || '').replace(/^\uFEFF/, '');
        const rows = [];
        let row = [], field = '', quoted = false;
        for (let i = 0; i < input.length; i++) {
            const char = input[i];
            if (quoted) {
                if (char === '"' && input[i + 1] === '"') { field += '"'; i++; }
                else if (char === '"') quoted = false;
                else field += char;
                continue;
            }
            if (char === '"' && field.length === 0) quoted = true;
            else if (char === ',') { row.push(field); field = ''; }
            else if (char === '\r' || char === '\n') {
                row.push(field); field = '';
                if (row.some(value => value !== '')) rows.push(row);
                row = [];
                if (char === '\r' && input[i + 1] === '\n') i++;
            } else field += char;
        }
        if (quoted) throw new Error('CSV 格式錯誤：欄位引號沒有成對。');
        if (field.length || row.length) {
            row.push(field);
            if (row.some(value => value !== '')) rows.push(row);
        }
        return rows;
    };

    const parseTaiwanProductionDate = value => {
        const match = String(value || '').trim().match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
        if (!match) return null;
        const [, year, month, day, hour, minute, second] = match;
        const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
        if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day) ||
            Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
        return `${year}-${month}-${day}`;
    };

    const parseAutoTesterCsv = text => {
        const rows = parseCsvRows(text);
        const normalizeHeader = value => String(value || '').trim().replace(/^\uFEFF/, '').replace(/\s+/g, '').toLowerCase();
        const headerIndex = rows.findIndex(row =>
            normalizeHeader(row[1]) === 'qrcode' && normalizeHeader(row[5]) === 'time');
        if (headerIndex < 0) throw new Error('找不到資料標題列：B 欄需為 QRCode，F 欄需為 Time。請確認上傳的是自動測試機 CSV。');

        const unique = new Map();
        let ignoredBlankQr = 0;
        for (let index = headerIndex + 1; index < rows.length; index++) {
            const row = rows[index];
            const qr = String(row[1] || '').trim();
            if (!qr) { ignoredBlankQr++; continue; }
            const reportDate = parseTaiwanProductionDate(row[5]);
            if (!reportDate) throw new Error(`第 ${index + 1} 列 B 欄有 QR CODE，但 F 欄時間格式無效：${String(row[5] || '').trim() || '空白'}。整份檔案未上傳。`);
            unique.set(`${reportDate}\u0000${qr}`, { reportDate, qr });
            if (unique.size > MAX_UNIQUE_RECORDS) throw new Error(`單一檔案超過 ${MAX_UNIQUE_RECORDS.toLocaleString()} 筆不同 QR CODE，為避免資料庫逾時已停止，未上傳任何資料。`);
        }
        if (!unique.size) throw new Error('檔案沒有可統計資料：請確認 B 欄 QR CODE 與 F 欄 Time 有值。');
        return { records: [...unique.values()], ignoredBlankQr, sourceRows: rows.length - headerIndex - 1 };
    };

    const toHex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
    const sha256 = async value => {
        const cryptoApi = root.crypto || globalThis.crypto;
        if (!cryptoApi?.subtle) throw new Error('此瀏覽器不支援安全雜湊，請使用最新版 Chrome、Edge、Firefox 或 Safari。');
        return toHex(await cryptoApi.subtle.digest('SHA-256', value));
    };

    const buildUploadPayload = async file => {
        if (!file || !/\.csv$/i.test(file.name || '')) throw new Error('僅接受 CSV 檔案。');
        if (file.size > MAX_FILE_BYTES) throw new Error('CSV 檔案不可大於 10 MB。');
        const bytes = await file.arrayBuffer();
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const parsed = parseAutoTesterCsv(text);
        const entries = [];
        const records = parsed.records;
        for (let start = 0; start < records.length; start += 16) {
            const batch = records.slice(start, start + 16);
            const hashes = await Promise.all(batch.map(record => sha256(new TextEncoder().encode(record.qr))));
            hashes.forEach((qrHash, index) => entries.push({ report_date: batch[index].reportDate, qr_hash: qrHash }));
        }
        return {
            fileName: file.name,
            fileSha256: await sha256(bytes),
            entries,
            uniqueCount: entries.length,
            ignoredBlankQr: parsed.ignoredBlankQr,
            sourceRows: parsed.sourceRows
        };
    };

    const dateShift = (date, offset) => root.shiftDateByDays(date, offset);
    const todayTaiwan = () => root.getTaiwanDate();

    const AutoTesterPanel = {
        props: { view: { type: String, default: 'dashboard' } },
        setup(props) {
            const { ref, computed, watch, onMounted, onBeforeUnmount } = root.Vue;
            const today = todayTaiwan();
            const dashboardDate = ref(today);
            const statsStart = ref(dateShift(today, -6));
            const statsEnd = ref(today);
            const statsQuickMode = ref(null);
            const statsQuickOffset = ref(-1);
            let applyingStatsQuick = false;
            const dashboardRows = ref([]);
            const statsRows = ref([]);
            const files = ref([]);
            const fileTotal = ref(0);
            const fileOffset = ref(0);
            const pageSize = 25;
            const revision = ref(null);
            const loading = ref(false);
            const statsLoading = ref(false);
            const uploadBusy = ref(false);
            const error = ref('');
            const notice = ref('');
            const uploadInput = ref(null);
            const pendingReplacement = ref(null);
            const deleteTarget = ref(null);
            let requestSequence = 0;
            let disposed = false;
            let summaryCache = null;
            let filesLoaded = false;
            let filesRevision = null;
            let uploadQueue = [];
            let uploadBatch = null;

            const callRpc = async (name, args = {}) => {
                // `_supabase` is a global lexical binding created by supabase-client.js;
                // top-level `const` does not create `window._supabase` in classic scripts.
                const client = typeof _supabase !== 'undefined' && typeof _supabase?.rpc === 'function'
                    ? _supabase
                    : null;
                if (!client) throw new Error('資料庫服務尚未就緒，請重新載入頁面；若仍無法使用，請聯絡管理者。');
                const { data, error: rpcError } = await client.rpc(name, args);
                if (rpcError) throw rpcError;
                return data;
            };
            const normalizedDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? value : '';
            const dashboardRange = () => ({ start: dateShift(dashboardDate.value, -29), end: dashboardDate.value });
            const activeSummaryRange = () => props.view === 'stats'
                ? { start: statsStart.value, end: statsEnd.value }
                : dashboardRange();
            const normalizeDaily = rows => (Array.isArray(rows) ? rows : []).map(row => ({
                report_date: String(row.report_date), daily_count: Number(row.daily_count) || 0
            }));
            const revisionOf = value => Number(value?.revision);

            const readSnapshot = async ({ range, withSummary, withFiles }) => {
                for (let attempt = 0; attempt < 3; attempt++) {
                    const before = await callRpc('auto_tester_get_state');
                    const [summary, filePage] = await Promise.all([
                        withSummary ? callRpc('auto_tester_get_summary', { p_start: range.start, p_end: range.end }) : Promise.resolve(null),
                        withFiles ? callRpc('auto_tester_list_files', { p_limit: pageSize, p_offset: fileOffset.value }) : Promise.resolve(null)
                    ]);
                    const after = await callRpc('auto_tester_get_state');
                    const expected = revisionOf(after);
                    const versionsMatch = expected === revisionOf(before) &&
                        (!summary || expected === revisionOf(summary)) && (!filePage || expected === revisionOf(filePage));
                    if (!versionsMatch) continue;
                    if (disposed) return null;
                    return { summary, filePage, revision: expected };
                }
                throw new Error('資料正由其他使用者更新，請稍候按重新整理；目前畫面未以不完整資料覆蓋。');
            };

            const isCoveredByCache = (range, expectedRevision = revision.value) => summaryCache &&
                summaryCache.revision === expectedRevision && range.start >= summaryCache.start && range.end <= summaryCache.end;
            const rowsFromCache = range => summaryCache.rows.filter(row => row.report_date >= range.start && row.report_date <= range.end);

            const loadCurrentView = async ({ force = false, checkVersion = false } = {}) => {
                const requestId = ++requestSequence;
                loading.value = false;
                statsLoading.value = false;
                error.value = '';
                if (checkVersion) {
                    try {
                        const state = await callRpc('auto_tester_get_state');
                        if (disposed || requestId !== requestSequence) return;
                        const currentRevision = revisionOf(state);
                        if (!force && currentRevision === revision.value) {
                            const range = activeSummaryRange();
                            if (props.view !== 'report' && isCoveredByCache(range, currentRevision)) {
                                const cached = rowsFromCache(range);
                                if (props.view === 'dashboard') dashboardRows.value = cached;
                                else statsRows.value = cached;
                                return;
                            }
                            if (props.view === 'report' && filesLoaded && filesRevision === currentRevision) return;
                        } else summaryCache = null;
                    } catch (stateError) {
                        if (!disposed && requestId === requestSequence) error.value = stateError.message || '無法確認資料版本，請重新整理。';
                        return;
                    }
                }
                const range = activeSummaryRange();
                if (!normalizedDate(range.start) || !normalizedDate(range.end) || range.start > range.end) {
                    error.value = '請確認日期區間有效，且開始日期不晚於結束日期。';
                    return;
                }
                const needFiles = props.view === 'report';
                const needSummary = props.view !== 'report';
                if (needSummary && !force && isCoveredByCache(range)) {
                    const cached = rowsFromCache(range);
                    if (props.view === 'dashboard') dashboardRows.value = cached;
                    else statsRows.value = cached;
                    return;
                }
                if (props.view === 'stats') statsLoading.value = true;
                else loading.value = true;
                try {
                    const snapshot = await readSnapshot({ range, withSummary: needSummary, withFiles: needFiles });
                    if (disposed || requestId !== requestSequence) return;
                    if (snapshot.filePage) {
                        const total = Number(snapshot.filePage.total_count) || 0;
                        const correctedOffset = total ? Math.floor((total - 1) / pageSize) * pageSize : 0;
                        if (fileOffset.value > correctedOffset) {
                            fileOffset.value = correctedOffset;
                            return await loadCurrentView({ force: true });
                        }
                    }
                    revision.value = snapshot.revision;
                    if (snapshot.summary) {
                        const rows = normalizeDaily(snapshot.summary.daily);
                        if (props.view === 'dashboard') dashboardRows.value = rows;
                        if (props.view === 'stats') statsRows.value = rows;
                        summaryCache = { start: range.start, end: range.end, revision: snapshot.revision, rows };
                    }
                    if (snapshot.filePage) {
                        files.value = Array.isArray(snapshot.filePage.files) ? snapshot.filePage.files : [];
                        fileTotal.value = Number(snapshot.filePage.total_count) || 0;
                        filesLoaded = true;
                        filesRevision = snapshot.revision;
                        if (fileOffset.value >= fileTotal.value && fileTotal.value > 0) fileOffset.value = Math.floor((fileTotal.value - 1) / pageSize) * pageSize;
                    }
                } catch (loadError) {
                    if (!disposed && requestId === requestSequence) error.value = loadError.message || '讀取失敗，請稍後重試。';
                } finally {
                    if (requestId === requestSequence) { loading.value = false; statsLoading.value = false; }
                }
            };

            const refresh = () => loadCurrentView({ force: true });
            const dailyCount = date => dashboardRows.value.find(row => row.report_date === date)?.daily_count || 0;
            const sumRows = rows => rows.reduce((sum, row) => sum + row.daily_count, 0);
            const todayCount = computed(() => dailyCount(dashboardDate.value));
            const lastSevenCount = computed(() => {
                const start = dateShift(dashboardDate.value, -6);
                return sumRows(dashboardRows.value.filter(row => row.report_date >= start && row.report_date <= dashboardDate.value));
            });
            const monthStart = computed(() => `${dashboardDate.value.slice(0, 7)}-01`);
            const monthCount = computed(() => sumRows(dashboardRows.value.filter(row => row.report_date >= monthStart.value && row.report_date <= dashboardDate.value)));
            const trendDays = computed(() => {
                const days = [];
                for (let offset = 13; offset >= 0; offset--) {
                    const date = dateShift(dashboardDate.value, -offset);
                    const count = dailyCount(date);
                    if (count > 0) days.push({ date, count });
                }
                return days;
            });
            const trendMax = computed(() => Math.max(1, ...trendDays.value.map(day => day.count)));
            const statsTotal = computed(() => sumRows(statsRows.value));
            const hasMoreFiles = computed(() => fileOffset.value + files.value.length < fileTotal.value);
            const filePageLabel = computed(() => fileTotal.value ? `${fileOffset.value + 1}–${Math.min(fileOffset.value + files.value.length, fileTotal.value)} / ${fileTotal.value}` : '0 筆');
            const formattedUploadedAt = value => root.formatTaiwanDateTime(value) || '—';

            const loadStats = async () => loadCurrentView({ force: true });
            const statsQuickRange = (mode, offset) => {
                const todayDate = new Date(`${todayTaiwan()}T00:00:00Z`);
                if (mode === 'day') {
                    const date = new Date(todayDate);
                    date.setUTCDate(date.getUTCDate() + offset);
                    const value = date.toISOString().slice(0, 10);
                    return { start: value, end: value };
                }
                if (mode === 'week') {
                    const start = new Date(todayDate);
                    start.setUTCDate(start.getUTCDate() - start.getUTCDay() + offset * 7);
                    const end = new Date(start);
                    end.setUTCDate(end.getUTCDate() + 6);
                    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
                }
                const start = new Date(Date.UTC(todayDate.getUTCFullYear(), todayDate.getUTCMonth() + offset, 1));
                const end = new Date(Date.UTC(todayDate.getUTCFullYear(), todayDate.getUTCMonth() + offset + 1, 0));
                return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
            };
            const statsQuickLabel = computed(() => {
                if (!statsQuickMode.value) return '';
                const { start, end } = statsQuickRange(statsQuickMode.value, statsQuickOffset.value);
                if (statsQuickMode.value === 'day') {
                    const weekday = ['日', '一', '二', '三', '四', '五', '六'][new Date(`${start}T00:00:00Z`).getUTCDay()];
                    return `${start} (週${weekday})`;
                }
                if (statsQuickMode.value === 'week') return `${start} ~ ${start.slice(0, 4) === end.slice(0, 4) ? end.slice(5) : end}`;
                const [year, month] = start.split('-');
                return `${year} 年 ${Number(month)} 月`;
            });
            const statsQuickRelative = computed(() => {
                if (!statsQuickMode.value) return '';
                const offset = statsQuickOffset.value;
                const unit = { day: '日', week: '週', month: '月' }[statsQuickMode.value];
                if (offset === 0) return `本${unit}`;
                if (offset === -1) return `上一${unit}`;
                if (offset === 1) return `下一${unit}`;
                return offset < 0 ? `${Math.abs(offset)} ${unit}前` : `${offset} ${unit}後`;
            });
            const applyStatsQuick = async () => {
                const range = statsQuickRange(statsQuickMode.value, statsQuickOffset.value);
                applyingStatsQuick = true;
                statsStart.value = range.start;
                statsEnd.value = range.end;
                await root.Vue.nextTick();
                applyingStatsQuick = false;
            };
            const setStatsQuickMode = mode => {
                if (!['day', 'week', 'month'].includes(mode)) return;
                statsQuickMode.value = mode;
                statsQuickOffset.value = { day: 0, week: -1, month: -1 }[mode];
                return applyStatsQuick();
            };
            const shiftStatsQuick = delta => {
                if (!statsQuickMode.value) return;
                statsQuickOffset.value += Number(delta) || 0;
                return applyStatsQuick();
            };
            const openFilePicker = () => {
                if (!uploadBusy.value && !pendingReplacement.value) uploadInput.value?.click();
            };
            const publishPayload = async (payload, replaceFileId = null) => {
                const result = await callRpc('auto_tester_publish_file', {
                    p_file_name: payload.fileName,
                    p_file_sha256: payload.fileSha256,
                    p_entries: payload.entries,
                    p_replace_file_id: replaceFileId
                });
                return result;
            };
            const recordUpload = (payload, result) => {
                if (!['published', 'duplicate'].includes(result?.status)) throw new Error('無法確認上傳結果，請重新上傳此檔案確認。');
                if (result.status === 'duplicate') uploadBatch.duplicates++;
                else uploadBatch.published++;
                uploadBatch.contributions.set(payload.fileName.trim().toLowerCase(), payload.entries);
            };
            const finishUploadBatch = async () => {
                const batch = uploadBatch;
                uploadBatch = null;
                uploadQueue = [];
                if (!batch || disposed) return;
                const combinedKeys = new Set();
                batch.contributions.forEach(entries => entries.forEach(entry => combinedKeys.add(`${entry.report_date}\u0000${entry.qr_hash}`)));
                if (batch.published || batch.duplicates) {
                    summaryCache = null;
                    await loadCurrentView({ force: true });
                }
                if (batch.total === 1 && batch.published) notice.value = `上傳完成：${combinedKeys.size.toLocaleString()} 筆 QR CODE，依日期去重。`;
                else if (batch.total === 1 && batch.duplicates) notice.value = '相同檔案已存在，未重複寫入。';
                else if (batch.total === 1 && batch.skipped) notice.value = '已取消此檔案的上傳，原資料保留。';
                else if (batch.total > 1) notice.value = `批次處理完成：上傳 ${batch.published} 個、重複 ${batch.duplicates} 個、略過 ${batch.skipped} 個、失敗 ${batch.failures.length} 個；本次成功檔案合併後 ${combinedKeys.size.toLocaleString()} 筆 QR CODE（同日去重）。`;
                if (batch.failures.length) error.value = [error.value, ...batch.failures].filter(Boolean).join('；');
            };
            const acceptUpload = (payload, result) => {
                if (result?.status === 'confirmation_required') {
                    pendingReplacement.value = { payload, existingFileId: result.existing_file_id };
                    return false;
                }
                recordUpload(payload, result);
                pendingReplacement.value = null;
                return true;
            };
            const drainUploadQueue = async () => {
                uploadBusy.value = true;
                try {
                    while (uploadQueue.length && !disposed) {
                        const file = uploadQueue.shift();
                        try {
                            const payload = await buildUploadPayload(file);
                            if (disposed) return;
                            if (!acceptUpload(payload, await publishPayload(payload))) return;
                        } catch (uploadError) {
                            uploadBatch.failures.push(`${file.name}：${uploadError.message || '未能確認上傳結果，請重試此檔案'}`);
                        }
                    }
                    await finishUploadBatch();
                } finally {
                    uploadBusy.value = false;
                    if (disposed) { uploadQueue = []; uploadBatch = null; }
                }
            };
            const handleUpload = async event => {
                const selectedFiles = Array.from(event.target.files || []);
                event.target.value = '';
                if (!selectedFiles.length || uploadBusy.value || pendingReplacement.value || disposed) return;
                error.value = ''; notice.value = '';
                uploadQueue = selectedFiles;
                uploadBatch = { total: selectedFiles.length, published: 0, duplicates: 0, skipped: 0, failures: [], contributions: new Map() };
                await drainUploadQueue();
            };
            const confirmReplacement = async () => {
                const pending = pendingReplacement.value;
                if (!pending || uploadBusy.value) return;
                uploadBusy.value = true; error.value = '';
                try {
                    if (acceptUpload(pending.payload, await publishPayload(pending.payload, pending.existingFileId))) await drainUploadQueue();
                }
                catch (uploadError) { error.value = uploadError.message || '檔案取代失敗，原資料仍保留。'; }
                finally { uploadBusy.value = false; }
            };
            const skipReplacement = async () => {
                if (!pendingReplacement.value || uploadBusy.value) return;
                pendingReplacement.value = null;
                error.value = '';
                uploadBatch.skipped++;
                await drainUploadQueue();
            };
            const askDelete = file => { deleteTarget.value = file; error.value = ''; };
            const confirmDelete = async () => {
                if (!deleteTarget.value || uploadBusy.value) return;
                uploadBusy.value = true; error.value = '';
                try {
                    const result = await callRpc('auto_tester_delete_file', { p_file_id: deleteTarget.value.id });
                    if (!result?.deleted) throw new Error('檔案已不存在，請重新整理清單。');
                    notice.value = `已刪除 ${deleteTarget.value.file_name}，每日產能已重新計算。`;
                    deleteTarget.value = null;
                    summaryCache = null;
                    fileOffset.value = Math.min(fileOffset.value, Math.max(0, Math.floor((Number(result.remaining_files || 0) - 1) / pageSize) * pageSize));
                    await loadCurrentView({ force: true });
                } catch (deleteError) { error.value = deleteError.message || '刪除失敗，請稍後重試。'; }
                finally { uploadBusy.value = false; }
            };
            const changeFilePage = delta => {
                const next = fileOffset.value + delta * pageSize;
                if (next < 0 || next >= fileTotal.value) return;
                fileOffset.value = next;
                void loadCurrentView({ force: true });
            };
            const onFocus = () => {
                if (document.visibilityState === 'visible') void loadCurrentView({ checkVersion: true });
            };

            watch(() => props.view, view => {
                void loadCurrentView({ checkVersion: true });
            });
            watch(dashboardDate, () => { if (props.view === 'dashboard') void loadCurrentView(); });
            watch([statsStart, statsEnd], () => {
                if (props.view !== 'stats') return;
                if (!applyingStatsQuick) statsQuickMode.value = null;
                requestSequence++;
                statsLoading.value = false;
                statsRows.value = [];
            });
            onMounted(() => {
                document.addEventListener('visibilitychange', onFocus);
                window.addEventListener('focus', onFocus);
                void loadCurrentView();
            });
            onBeforeUnmount(() => {
                disposed = true;
                requestSequence++;
                document.removeEventListener('visibilitychange', onFocus);
                window.removeEventListener('focus', onFocus);
            });

            return {
                dashboardDate, statsStart, statsEnd, statsQuickMode, statsQuickLabel, statsQuickRelative, dashboardRows, statsRows, files, fileTotal, loading, statsLoading, uploadBusy,
                error, notice, uploadInput, pendingReplacement, deleteTarget, today, todayCount, lastSevenCount, monthCount,
                trendDays, trendMax, statsTotal, hasMoreFiles, filePageLabel, formattedUploadedAt,
                refresh, loadStats, setStatsQuickMode, shiftStatsQuick, openFilePicker, handleUpload, confirmReplacement, skipReplacement, askDelete, confirmDelete, changeFilePage,
                previousDay: () => { dashboardDate.value = dateShift(dashboardDate.value, -1); },
                nextDay: () => { dashboardDate.value = dateShift(dashboardDate.value, 1); },
                setToday: () => { dashboardDate.value = todayTaiwan(); },
                formatCount: value => (Number(value) || 0).toLocaleString()
            };
        },
        template: `
        <section class="space-y-5 animate-fade-in" aria-live="polite">
            <div v-if="error" role="alert" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700"><i class="fas fa-circle-exclamation mr-2"></i>{{ error }}</div>
            <div v-if="notice" role="status" class="rounded-xl border border-green-200 bg-green-50 p-4 text-sm font-bold text-green-700"><i class="fas fa-circle-check mr-2"></i>{{ notice }}</div>

            <template v-if="view === 'dashboard'">
                <header class="flex flex-wrap items-center justify-between gap-3">
                    <div><h2 class="text-xl md:text-2xl font-black text-gray-900"><span class="inline-block w-1 h-6 rounded bg-cyan-600 mr-2 align-middle"></span>自動測試機總覽</h2><p class="text-sm text-gray-400 mt-1">依 B 欄 QR CODE 去重，統計每日產能</p></div>
                    <div class="flex flex-wrap items-center gap-2">
                        <button @click="previousDay" class="quick-arrow" aria-label="前一天"><i class="fas fa-chevron-left"></i></button>
                        <input v-model="dashboardDate" type="date" class="border border-gray-200 rounded-lg bg-white px-3 py-2 text-sm font-bold" aria-label="選擇日期">
                        <button @click="nextDay" class="quick-arrow" aria-label="後一天"><i class="fas fa-chevron-right"></i></button>
                        <button @click="setToday" class="btn-ghost text-sm">今天</button>
                        <button @click="refresh" :disabled="loading" class="btn-ghost text-sm disabled:opacity-50"><i class="fas fa-sync-alt" :class="loading ? 'fa-spin' : ''"></i><span class="ml-1">重新整理</span></button>
                    </div>
                </header>
                <p class="text-sm text-gray-500">{{ dashboardDate }} 每日產能</p>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div class="kpi-card"><div class="kpi-icon cyan"><i class="fas fa-qrcode"></i></div><div class="kpi-value">{{ formatCount(todayCount) }}</div><div class="kpi-label">當日去重 QR CODE</div></div>
                    <div class="kpi-card"><div class="kpi-icon blue"><i class="fas fa-calendar-week"></i></div><div class="kpi-value">{{ formatCount(lastSevenCount) }}</div><div class="kpi-label">近 7 日產能</div></div>
                    <div class="kpi-card"><div class="kpi-icon purple"><i class="fas fa-calendar-days"></i></div><div class="kpi-value">{{ formatCount(monthCount) }}</div><div class="kpi-label">本月產能</div></div>
                </div>
                <section class="section-card p-4 md:p-5">
                    <div class="flex flex-wrap items-center justify-between gap-2 mb-4"><h3 class="font-black text-gray-800">每日產能趨勢</h3><span class="text-xs text-gray-400">近 14 日投入量｜僅顯示有數據日期</span></div>
                    <div v-if="loading && dashboardRows.length === 0" class="empty-state py-10"><i class="fas fa-spinner fa-spin"></i><div class="hint">載入每日摘要…</div></div>
                    <template v-else-if="trendDays.length">
                        <div class="overflow-x-auto pb-3" role="img" aria-label="近 14 日每日產能直條圖">
                            <div class="flex items-end justify-center gap-2 min-w-[560px] h-52 border-b border-gray-200 px-2">
                                <div v-for="day in trendDays" :key="'bar-' + day.date" class="flex-1 min-w-[32px] h-full flex flex-col items-center justify-end gap-1" :title="day.date + '：' + formatCount(day.count) + ' 件'">
                                    <span class="text-[10px] font-bold text-gray-600">{{ formatCount(day.count) }}</span>
                                    <div class="w-full max-w-12 flex-1 max-h-36 flex items-end"><div class="w-full rounded-t-md bg-cyan-500" :style="{height: Math.max(6, day.count / trendMax * 100) + '%'}"></div></div>
                                    <span class="text-[10px] text-gray-500 font-mono">{{ day.date.slice(5) }}</span>
                                </div>
                            </div>
                        </div>
                        <div class="mt-3 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                            <div v-for="day in trendDays" :key="day.date" class="rounded-lg bg-gray-50 px-3 py-3 min-w-0" :title="day.date + '：' + formatCount(day.count) + ' 件'">
                                <div class="text-[11px] text-gray-500 font-mono">{{ day.date }}</div>
                                <div class="mt-2 h-2 rounded-full bg-gray-200 overflow-hidden"><div class="h-full rounded-full bg-cyan-500" :style="{width: (day.count / trendMax * 100) + '%'}"></div></div>
                                <div class="mt-2 text-sm font-black text-gray-800">{{ formatCount(day.count) }} 件</div>
                            </div>
                        </div>
                    </template>
                    <div v-else class="empty-state py-10"><i class="fas fa-inbox"></i><div class="hint">近 14 日沒有投入量資料</div></div>
                </section>
            </template>

            <template v-else-if="view === 'report'">
                <header><h2 class="text-xl md:text-2xl font-black text-gray-900"><span class="inline-block w-1 h-6 rounded bg-cyan-600 mr-2 align-middle"></span>自動測試機每日報工</h2><p class="text-sm text-gray-400 mt-1">只讀取 CSV 的 B 欄 QR CODE 與 F 欄 Time；原始 CSV 不會上傳或保存。</p></header>
                <section class="section-card p-4 md:p-6 border-l-4 border-cyan-500">
                    <div class="flex flex-wrap items-center justify-between gap-3">
                        <div><h3 class="font-black text-cyan-800"><i class="fas fa-file-arrow-up mr-2"></i>檔案上傳</h3><p class="text-xs text-gray-500 mt-1">同一天跨檔案 QR CODE 會一起去重，只保存雜湊、檔案關聯與每日數量。</p></div>
                        <span class="badge-hint text-green-700"><i class="fas fa-cloud"></i>共用資料庫</span>
                    </div>
                    <input ref="uploadInput" type="file" accept=".csv,text/csv" multiple class="hidden" @change="handleUpload">
                    <div class="mt-4 flex flex-wrap gap-2">
                        <button @click="openFilePicker" :disabled="uploadBusy || !!pendingReplacement" class="btn-primary disabled:opacity-50"><i class="fas" :class="uploadBusy ? 'fa-spinner fa-spin' : 'fa-upload'"></i><span class="ml-2">{{ uploadBusy ? '處理中…' : '選擇 CSV 檔案（可多選）' }}</span></button>
                        <button @click="refresh" :disabled="loading || uploadBusy" class="btn-ghost disabled:opacity-50"><i class="fas fa-sync-alt" :class="loading ? 'fa-spin' : ''"></i><span class="ml-2">重新整理清單</span></button>
                    </div>
                    <p class="text-xs text-gray-400 mt-3">B 欄 QR CODE 去除前後空白後計算 SHA-256。F 欄時間格式需為 YYYYMMDD-HHmmss。空白 QR CODE 不計入；有 QR CODE 但時間無效時整份檔案會拒絕上傳。</p>
                </section>
                <section class="section-card overflow-hidden">
                    <div class="card-header"><i class="fas fa-list text-cyan-600"></i><span>已上傳檔案</span><span class="ml-auto text-xs text-gray-400 font-normal">{{ filePageLabel }}</span></div>
                    <div v-if="loading && files.length === 0" class="empty-state py-12"><i class="fas fa-spinner fa-spin"></i><div class="hint">讀取共用清單…</div></div>
                    <div v-else class="overflow-x-auto">
                        <table class="data-table min-w-[760px]"><thead><tr><th>檔案名稱</th><th>資料日期</th><th class="text-right">檔案去重筆數</th><th>上傳時間（台灣）</th><th class="text-right">操作</th></tr></thead>
                            <tbody><tr v-for="file in files" :key="file.id"><td class="font-bold break-all">{{ file.file_name }}</td><td class="font-mono text-xs">{{ (file.report_dates || []).join('、') || '—' }}</td><td class="text-right font-mono">{{ formatCount(file.qr_count) }}</td><td class="font-mono text-xs">{{ formattedUploadedAt(file.uploaded_at) }}</td><td class="text-right"><button @click="askDelete(file)" :disabled="uploadBusy" class="text-red-600 hover:text-red-800 font-bold text-sm"><i class="fas fa-trash-can mr-1"></i>刪除</button></td></tr>
                                <tr v-if="files.length === 0"><td colspan="5" class="text-center text-gray-400 py-10">目前沒有上傳檔案</td></tr>
                            </tbody></table>
                    </div>
                    <div class="flex items-center justify-end gap-2 p-3 border-t border-gray-100"><button @click="changeFilePage(-1)" :disabled="fileOffset === 0 || loading" class="btn-ghost text-sm disabled:opacity-40"><i class="fas fa-chevron-left mr-1"></i>上一頁</button><button @click="changeFilePage(1)" :disabled="!hasMoreFiles || loading" class="btn-ghost text-sm disabled:opacity-40">下一頁<i class="fas fa-chevron-right ml-1"></i></button></div>
                </section>
            </template>

            <template v-else>
                <header><h2 class="text-xl md:text-2xl font-black text-gray-900"><span class="inline-block w-1 h-6 rounded bg-cyan-600 mr-2 align-middle"></span>自動測試機數據統計</h2><p class="text-sm text-gray-400 mt-1">每日以不同 QR CODE 數量計算；日期區間以每日產能加總。</p></header>
                <section class="section-card p-4">
                    <div class="quick-bar">
                        <span class="quick-bar-label"><i class="fas fa-bolt"></i>快捷區間</span>
                        <div class="quick-seg" role="group" aria-label="自動測試機快捷統計區間">
                            <button @click="setStatsQuickMode('day')" :class="{ 'is-active': statsQuickMode === 'day' }" :aria-pressed="statsQuickMode === 'day'">日</button>
                            <button @click="setStatsQuickMode('week')" :class="{ 'is-active': statsQuickMode === 'week' }" :aria-pressed="statsQuickMode === 'week'">週</button>
                            <button @click="setStatsQuickMode('month')" :class="{ 'is-active': statsQuickMode === 'month' }" :aria-pressed="statsQuickMode === 'month'">月</button>
                        </div>
                        <div v-if="statsQuickMode" class="quick-nav">
                            <button @click="shiftStatsQuick(-1)" class="quick-arrow" :title="'上一' + (statsQuickMode === 'day' ? '日' : statsQuickMode === 'week' ? '週' : '月')" aria-label="上一期"><i class="fas fa-chevron-left"></i></button>
                            <div class="quick-range"><span class="quick-range-text font-mono">{{ statsQuickLabel }}</span><span class="quick-range-rel">{{ statsQuickRelative }}</span></div>
                            <button @click="shiftStatsQuick(1)" class="quick-arrow" :title="'下一' + (statsQuickMode === 'day' ? '日' : statsQuickMode === 'week' ? '週' : '月')" aria-label="下一期"><i class="fas fa-chevron-right"></i></button>
                        </div>
                        <span v-else class="quick-hint">選擇後可用 <i class="fas fa-chevron-left mx-0.5"></i><i class="fas fa-chevron-right mx-0.5"></i> 快速切換期間</span>
                    </div>
                    <div class="flex flex-col sm:flex-row flex-wrap gap-3 items-end">
                        <label class="flex-1 min-w-[170px] text-xs font-bold text-gray-500">開始日期<input v-model="statsStart" type="date" class="mt-1 w-full border border-gray-200 rounded-lg bg-white p-2 text-sm"></label>
                        <label class="flex-1 min-w-[170px] text-xs font-bold text-gray-500">結束日期<input v-model="statsEnd" type="date" class="mt-1 w-full border border-gray-200 rounded-lg bg-white p-2 text-sm"></label>
                        <button @click="loadStats" :disabled="statsLoading" class="btn-primary disabled:opacity-50"><i class="fas" :class="statsLoading ? 'fa-spinner fa-spin' : 'fa-chart-column'"></i><span class="ml-2">{{ statsLoading ? '載入中…' : '執行統計' }}</span></button>
                        <button @click="refresh" :disabled="statsLoading" class="btn-ghost disabled:opacity-50" aria-label="重新整理"><i class="fas fa-sync-alt" :class="statsLoading ? 'fa-spin' : ''"></i></button>
                    </div>
                </section>
                <div v-if="statsRows.length" class="grid grid-cols-1 sm:grid-cols-2 gap-3"><div class="kpi-card"><div class="kpi-icon cyan"><i class="fas fa-qrcode"></i></div><div class="kpi-value">{{ formatCount(statsTotal) }}</div><div class="kpi-label">區間產能</div></div><div class="kpi-card"><div class="kpi-icon blue"><i class="fas fa-calendar-days"></i></div><div class="kpi-value">{{ statsRows.length }}</div><div class="kpi-label">有生產資料日期</div></div></div>
                <section class="section-card overflow-hidden">
                    <div class="card-header"><i class="fas fa-table text-cyan-600"></i><span>{{ statsStart }} 至 {{ statsEnd }} 每日產能</span></div>
                    <div v-if="statsLoading && statsRows.length === 0" class="empty-state py-12"><i class="fas fa-spinner fa-spin"></i><div class="hint">讀取每日摘要…</div></div>
                    <div v-else-if="statsRows.length" class="overflow-x-auto"><table class="data-table min-w-[420px]"><thead><tr><th>生產日期</th><th class="text-right">QR CODE 數量</th></tr></thead><tbody><tr v-for="row in [...statsRows].sort((a,b) => b.report_date.localeCompare(a.report_date))" :key="row.report_date"><td class="font-mono">{{ row.report_date }}</td><td class="text-right font-mono font-bold text-cyan-700">{{ formatCount(row.daily_count) }}</td></tr><tr class="bg-cyan-50"><td class="font-bold">區間合計</td><td class="text-right font-mono font-black text-cyan-800">{{ formatCount(statsTotal) }}</td></tr></tbody></table></div>
                    <div v-else class="empty-state py-12"><i class="fas fa-inbox"></i><div class="hint">此區間沒有已上傳的每日摘要</div></div>
                </section>
            </template>

            <div v-if="pendingReplacement" class="fixed inset-0 z-[90] bg-black/50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="auto-replace-title">
                <div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6"><h3 id="auto-replace-title" class="text-lg font-black text-gray-900"><i class="fas fa-triangle-exclamation text-amber-500 mr-2"></i>同名檔案已存在</h3><p class="text-sm text-gray-600 mt-3">{{ pendingReplacement.payload.fileName }} 的內容與已保存檔案不同。確認取代後，系統會在同一筆資料庫交易中重算受影響日期；若失敗，舊資料會完整保留。</p><div class="flex justify-end gap-2 mt-6"><button @click="skipReplacement" :disabled="uploadBusy" class="btn-ghost">略過此檔</button><button @click="confirmReplacement" :disabled="uploadBusy" class="btn-primary bg-amber-600 hover:bg-amber-700 disabled:opacity-50">{{ uploadBusy ? '處理中…' : '確認取代' }}</button></div></div>
            </div>
            <div v-if="deleteTarget" class="fixed inset-0 z-[90] bg-black/50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="auto-delete-title">
                <div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6"><h3 id="auto-delete-title" class="text-lg font-black text-gray-900"><i class="fas fa-trash-can text-red-600 mr-2"></i>刪除上傳檔案</h3><p class="text-sm text-gray-600 mt-3">確定刪除「{{ deleteTarget.file_name }}」？每日產能會依剩餘檔案重新計算；若其他檔案含有相同 QR CODE，該筆仍會保留在當日去重數量中。</p><div class="flex justify-end gap-2 mt-6"><button @click="deleteTarget=null" :disabled="uploadBusy" class="btn-ghost">取消</button><button @click="confirmDelete" :disabled="uploadBusy" class="btn-primary bg-red-600 hover:bg-red-700 disabled:opacity-50">{{ uploadBusy ? '處理中…' : '確認刪除' }}</button></div></div>
            </div>
        </section>`
    };

    root.SMT = root.SMT || {};
    root.SMT.AutoTesterCsv = { parseCsvRows, parseTaiwanProductionDate, parseAutoTesterCsv, buildUploadPayload, MAX_FILE_BYTES, MAX_UNIQUE_RECORDS };
    root.SMT.AutoTesterPanel = AutoTesterPanel;
    if (typeof module !== 'undefined' && module.exports) module.exports = root.SMT.AutoTesterCsv;
})(typeof window !== 'undefined' ? window : globalThis);
