const { createApp, ref, computed, onMounted, watch, reactive } = Vue;
const { createClient } = supabase;

// 將既有瀏覽器設定平順搬到中性鍵名；新鍵有不同內容時保留舊鍵，避免覆蓋使用者資料。
const migrateLegacyStorageKeys = () => {
    const legacyPrefix = String.fromCharCode(107, 111, 121, 97);
    try {
        const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(Boolean);
        keys.forEach(oldKey => {
            const lowerKey = oldKey.toLowerCase();
            if (!lowerKey.startsWith(legacyPrefix) || !['_', '-'].includes(lowerKey[legacyPrefix.length])) return;
            const newKey = `production${oldKey.slice(legacyPrefix.length)}`;
            const oldValue = localStorage.getItem(oldKey);
            const newValue = localStorage.getItem(newKey);
            if (newValue === null) {
                localStorage.setItem(newKey, oldValue);
                localStorage.removeItem(oldKey);
            } else if (newValue === oldValue) {
                localStorage.removeItem(oldKey);
            }
        });
    } catch (error) {
        // 儲存空間受限或停用時仍讓網站照常以 Supabase 資料運作。
    }
};
migrateLegacyStorageKeys();

const SUPABASE_URL = 'https://ccwkcwriebxipndxkvyr.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNjd2tjd3JpZWJ4aXBuZHhrdnlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkzODk4MTgsImV4cCI6MjA4NDk2NTgxOH0.fUHOdc7OZVTwv6XjkmYU7uSkJMIy83OTvM7rD1n81Ic';
const CACHE_SERVICE_NAMESPACE = String.fromCharCode(107, 111, 121, 97);
window.DATA_CACHE_URL = `https://${CACHE_SERVICE_NAMESPACE}-data-cache.shin19920803.workers.dev`;
const SHARED_STATS_STATE_ID = '__shared_production_daf_stats_state_v1__';
const LEGACY_SHARED_STATS_STATE_ID = `__${CACHE_SERVICE_NAMESPACE}_shared_daf_stats_state_v1__`;

const TAIWAN_TIME_ZONE = 'Asia/Taipei';
const getTaiwanDateParts = value => {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: TAIWAN_TIME_ZONE,
        calendar: 'gregory',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
};
window.getTaiwanDate = () => {
    const parts = getTaiwanDateParts();
    return parts ? `${parts.year}-${parts.month}-${parts.day}` : '';
};
window.shiftDateByDays = (dateValue, offset = 0) => {
    const base = new Date(`${dateValue || window.getTaiwanDate()}T00:00:00Z`);
    if (Number.isNaN(base.getTime())) return '';
    base.setUTCDate(base.getUTCDate() + Number(offset || 0));
    return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}-${String(base.getUTCDate()).padStart(2, '0')}`;
};
window.formatTaiwanTime = value => {
    const parts = getTaiwanDateParts(value);
    return parts ? `${parts.hour}:${parts.minute}:${parts.second}` : '';
};
window.formatTaiwanDateTime = (value, includeSeconds = false) => {
    const parts = getTaiwanDateParts(value);
    if (!parts) return '';
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const time = includeSeconds ? `${parts.hour}:${parts.minute}:${parts.second}` : `${parts.hour}:${parts.minute}`;
    return `${date} ${time}`;
};

let cacheInvalidationPromise = null;
let cacheInvalidationQueued = false;
window.invalidateDataCache = () => {
    const base = String(window.DATA_CACHE_URL || '').replace(/\/$/, '');
    if (!base) return Promise.resolve(false);
    if (cacheInvalidationPromise) {
        cacheInvalidationQueued = true;
        return cacheInvalidationPromise;
    }
    cacheInvalidationPromise = (async () => {
        let ok = true;
        do {
            cacheInvalidationQueued = false;
            try { ok = (await fetch(`${base}/api/cache/invalidate`, { method: 'POST' })).ok && ok; }
            catch (error) { ok = false; }
        } while (cacheInvalidationQueued);
        return ok;
    })().finally(() => { cacheInvalidationPromise = null; });
    return cacheInvalidationPromise;
};

let statsStateCacheInvalidationPromise = null;
let statsStateCacheInvalidationQueued = false;
window.invalidateStatsStateCache = () => {
    const base = String(window.DATA_CACHE_URL || '').replace(/\/$/, '');
    if (!base) return Promise.resolve(false);
    if (statsStateCacheInvalidationPromise) {
        statsStateCacheInvalidationQueued = true;
        return statsStateCacheInvalidationPromise;
    }
    statsStateCacheInvalidationPromise = (async () => {
        let ok = true;
        do {
            statsStateCacheInvalidationQueued = false;
            try { ok = (await fetch(`${base}/api/daf-stats-state/invalidate`, { method: 'POST' })).ok && ok; }
            catch (error) { ok = false; }
        } while (statsStateCacheInvalidationQueued);
        return ok;
    })().finally(() => { statsStateCacheInvalidationPromise = null; });
    return statsStateCacheInvalidationPromise;
};

window.fetchCachedJson = async (path, { force = false } = {}) => {
    const base = String(window.DATA_CACHE_URL || '').replace(/\/$/, '');
    if (!base) return null;
    const url = new URL(`${base}${path}`);
    if (force) url.searchParams.set('refresh', '1');
    // 不使用瀏覽器本機 HTTP 快取；資料仍由 Cloudflare Worker 快取，避免跨電腦讀到舊清單。
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Cloudflare HTTP ${response.status}`);
    return response.json();
};

const nativeFetch = window.fetch.bind(window);
const trackedFetch = async (input, init = {}) => {
    const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const response = await nativeFetch(input, init);
    const body = String(init.body || '');
    const isStatsStateWrite = body.includes(SHARED_STATS_STATE_ID) || body.includes(LEGACY_SHARED_STATS_STATE_ID);
    const requestUrl = input instanceof Request ? input.url : String(input);
    const isDafMachineReferenceWrite = requestUrl.includes('__DAF_MACHINE_REFERENCE__') || String(init.body || '').includes('__DAF_MACHINE_REFERENCE__');
    const isDafImportStagingRequest = /\/rpc\/daf_(log_import_pipeline_ready|start_log_import|stage_log_import_chunk|get_log_import_status|finalize_log_import|delete_log_file)(\?|$)/.test(requestUrl);
    const isDafMachineClassificationWrite = /\/rpc\/daf_update_machine_classification(\?|$)/.test(requestUrl);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && response.ok && !isStatsStateWrite && !isDafMachineReferenceWrite && !isDafImportStagingRequest && !isDafMachineClassificationWrite) void window.invalidateDataCache();
    return response;
};
const _supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { global: { fetch: trackedFetch } });
