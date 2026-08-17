const { createApp, ref, computed, onMounted, watch, reactive } = Vue;
const { createClient } = supabase;

const SUPABASE_URL = 'https://ccwkcwriebxipndxkvyr.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNjd2tjd3JpZWJ4aXBuZHhrdnlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkzODk4MTgsImV4cCI6MjA4NDk2NTgxOH0.fUHOdc7OZVTwv6XjkmYU7uSkJMIy83OTvM7rD1n81Ic';
window.KOYA_DATA_CACHE_URL = 'https://koya-data-cache.shin19920803.workers.dev';

const KOYA_TIME_ZONE = 'Asia/Taipei';
const koyaTaiwanParts = value => {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: KOYA_TIME_ZONE,
        calendar: 'gregory',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
};
window.koyaTodayDate = () => {
    const parts = koyaTaiwanParts();
    return parts ? `${parts.year}-${parts.month}-${parts.day}` : '';
};
window.koyaShiftDate = (dateValue, offset = 0) => {
    const base = new Date(`${dateValue || window.koyaTodayDate()}T00:00:00Z`);
    if (Number.isNaN(base.getTime())) return '';
    base.setUTCDate(base.getUTCDate() + Number(offset || 0));
    return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}-${String(base.getUTCDate()).padStart(2, '0')}`;
};
window.koyaTaiwanTime = value => {
    const parts = koyaTaiwanParts(value);
    return parts ? `${parts.hour}:${parts.minute}:${parts.second}` : '';
};
window.koyaTaiwanDateTime = (value, includeSeconds = false) => {
    const parts = koyaTaiwanParts(value);
    if (!parts) return '';
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const time = includeSeconds ? `${parts.hour}:${parts.minute}:${parts.second}` : `${parts.hour}:${parts.minute}`;
    return `${date} ${time}`;
};

let cacheInvalidationPromise = null;
window.koyaInvalidateCache = () => {
    const base = String(window.KOYA_DATA_CACHE_URL || '').replace(/\/$/, '');
    if (!base) return Promise.resolve(false);
    if (cacheInvalidationPromise) return cacheInvalidationPromise;
    cacheInvalidationPromise = fetch(`${base}/api/cache/invalidate`, { method: 'POST' })
        .then(response => response.ok)
        .catch(() => false)
        .finally(() => { cacheInvalidationPromise = null; });
    return cacheInvalidationPromise;
};

let statsStateCacheInvalidationPromise = null;
window.koyaInvalidateStatsStateCache = () => {
    const base = String(window.KOYA_DATA_CACHE_URL || '').replace(/\/$/, '');
    if (!base) return Promise.resolve(false);
    if (statsStateCacheInvalidationPromise) return statsStateCacheInvalidationPromise;
    statsStateCacheInvalidationPromise = fetch(`${base}/api/daf-stats-state/invalidate`, { method: 'POST' })
        .then(response => response.ok)
        .catch(() => false)
        .finally(() => { statsStateCacheInvalidationPromise = null; });
    return statsStateCacheInvalidationPromise;
};

window.koyaFetchCachedJson = async (path, { force = false } = {}) => {
    const base = String(window.KOYA_DATA_CACHE_URL || '').replace(/\/$/, '');
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
    const isStatsStateWrite = String(init.body || '').includes('__koya_shared_daf_stats_state_v1__');
    const requestUrl = input instanceof Request ? input.url : String(input);
    const isDafMachineReferenceWrite = requestUrl.includes('__DAF_MACHINE_REFERENCE__') || String(init.body || '').includes('__DAF_MACHINE_REFERENCE__');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && response.ok && !isStatsStateWrite && !isDafMachineReferenceWrite) void window.koyaInvalidateCache();
    return response;
};
const _supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { global: { fetch: trackedFetch } });
