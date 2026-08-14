const { createApp, ref, computed, onMounted, watch, reactive } = Vue;
const { createClient } = supabase;

const SUPABASE_URL = 'https://ccwkcwriebxipndxkvyr.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNjd2tjd3JpZWJ4aXBuZHhrdnlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkzODk4MTgsImV4cCI6MjA4NDk2NTgxOH0.fUHOdc7OZVTwv6XjkmYU7uSkJMIy83OTvM7rD1n81Ic';
window.KOYA_DATA_CACHE_URL = 'https://koya-data-cache.shin19920803.workers.dev';

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

window.koyaFetchCachedJson = async (path, { force = false } = {}) => {
    const base = String(window.KOYA_DATA_CACHE_URL || '').replace(/\/$/, '');
    if (!base) return null;
    const url = new URL(`${base}${path}`);
    if (force) url.searchParams.set('refresh', '1');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Cloudflare HTTP ${response.status}`);
    return response.json();
};

const nativeFetch = window.fetch.bind(window);
const trackedFetch = async (input, init = {}) => {
    const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const response = await nativeFetch(input, init);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && response.ok) void window.koyaInvalidateCache();
    return response;
};
const _supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { global: { fetch: trackedFetch } });
