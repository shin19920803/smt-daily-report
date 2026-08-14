const SUPABASE_URL = 'https://ccwkcwriebxipndxkvyr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNjd2tjd3JpZWJ4aXBuZHhrdnlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkzODk4MTgsImV4cCI6MjA4NDk2NTgxOH0.fUHOdc7OZVTwv6XjkmYU7uSkJMIy83OTvM7rD1n81Ic';
const APP_ORIGIN = 'https://shin19920803.github.io';
const PROCESS_LINES = ['DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY'];
const SUMMARY_COLUMNS = [
    'id', 'line', 'file_name', 'uploaded_at', 'model_name', 'product_code', 'work_order',
    'report_date', 'date_start', 'date_end', 'input_count', 'good_count', 'fail_count',
    'yield_rate', 'defect_rate', 'unknown_status_count', 'unknown_status_text',
    'row_count', 'raw_column_count'
].join(',');

const corsHeaders = {
    'Access-Control-Allow-Origin': APP_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, apikey, authorization',
    'Vary': 'Origin'
};

const jsonResponse = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
});

const cacheKeyForLine = (requestUrl, line) => new Request(`${requestUrl.origin}/api/daf-summary?line=${encodeURIComponent(line)}`);

const readSummaryFromSupabase = async line => {
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
        const url = new URL(`${SUPABASE_URL}/rest/v1/daf_log_batches`);
        url.searchParams.set('select', SUMMARY_COLUMNS);
        url.searchParams.set('line', `eq.${line}`);
        url.searchParams.set('order', 'uploaded_at.desc');
        url.searchParams.set('offset', String(offset));
        url.searchParams.set('limit', '1000');
        const response = await fetch(url, {
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                Accept: 'application/json'
            }
        });
        if (!response.ok) return new Response(await response.text(), { status: response.status });
        const page = await response.json();
        rows.push(...(Array.isArray(page) ? page : []));
        if (!Array.isArray(page) || page.length < 1000) break;
    }
    return jsonResponse(rows, 200, { 'Cache-Control': 'public, max-age=60, s-maxage=600' });
};

const invalidateSummaryCache = async requestUrl => {
    const cache = caches.default;
    await Promise.all(PROCESS_LINES.map(line => cache.delete(cacheKeyForLine(requestUrl, line))));
};

export default {
    async fetch(request, env, ctx) {
        const requestUrl = new URL(request.url);
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

        if (requestUrl.pathname === '/api/health' && request.method === 'GET') {
            return jsonResponse({ ok: true, service: 'koya-data-cache' });
        }

        if (requestUrl.pathname === '/api/daf-summary') {
            if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);
            const line = requestUrl.searchParams.get('line');
            if (!PROCESS_LINES.includes(line)) return jsonResponse({ error: 'Invalid process' }, 400);

            const cache = caches.default;
            const key = cacheKeyForLine(requestUrl, line);
            const forceRefresh = requestUrl.searchParams.get('refresh') === '1';
            if (!forceRefresh) {
                const cached = await cache.match(key);
                if (cached) {
                    const headers = new Headers(cached.headers);
                    Object.entries(corsHeaders).forEach(([name, value]) => headers.set(name, value));
                    headers.set('X-Koya-Cache', 'HIT');
                    return new Response(cached.body, { status: cached.status, headers });
                }
            } else {
                await cache.delete(key);
            }

            const fresh = await readSummaryFromSupabase(line);
            if (!fresh.ok) return fresh;
            const cachedResponse = new Response(fresh.body, { status: fresh.status, headers: fresh.headers });
            await cache.put(key, cachedResponse.clone());
            const headers = new Headers(cachedResponse.headers);
            headers.set('X-Koya-Cache', forceRefresh ? 'REFRESH' : 'MISS');
            return new Response(cachedResponse.body, { status: cachedResponse.status, headers });
        }

        if (requestUrl.pathname === '/api/daf-summary/invalidate') {
            if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
            await invalidateSummaryCache(requestUrl);
            return jsonResponse({ ok: true, invalidated: PROCESS_LINES });
        }

        return jsonResponse({ error: 'Not found' }, 404);
    }
};
