const SUPABASE_URL = 'https://ccwkcwriebxipndxkvyr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNjd2tjd3JpZWJ4aXBuZHhrdnlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkzODk4MTgsImV4cCI6MjA4NDk2NTgxOH0.fUHOdc7OZVTwv6XjkmYU7uSkJMIy83OTvM7rD1n81Ic';
const APP_ORIGIN = 'https://shin19920803.github.io';
const PROCESS_LINES = ['DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY'];
const SHARED_STATS_STATE_ID = '__koya_shared_daf_stats_state_v1__';
const SUMMARY_COLUMNS = [
    'id', 'line', 'file_name', 'uploaded_at', 'model_name', 'product_code', 'work_order',
    'report_date', 'date_start', 'date_end', 'input_count', 'good_count', 'fail_count',
    'yield_rate', 'defect_rate', 'unknown_status_count', 'unknown_status_text',
    'row_count', 'raw_column_count'
].join(',');
const VERSION_COLUMNS = 'id,uploaded_at,date_start,date_end,row_count,input_count,good_count,fail_count,yield_rate,defect_rate';

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

const supabaseHeaders = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    Accept: 'application/json'
};

const cacheKey = (requestUrl, pathname, params = {}) => {
    const url = new URL(`${requestUrl.origin}${pathname}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    return new Request(url.toString());
};

const cacheKeyForLine = (requestUrl, pathname, line) => cacheKey(requestUrl, pathname, { line });

const readSupabasePages = async (table, configure, pageSize = 1000) => {
    const rows = [];
    for (let offset = 0; ; offset += pageSize) {
        const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
        configure(url);
        url.searchParams.set('offset', String(offset));
        url.searchParams.set('limit', String(pageSize));
        const response = await fetch(url, { headers: supabaseHeaders });
        if (!response.ok) return { error: new Response(await response.text(), { status: response.status, headers: corsHeaders }) };
        const page = await response.json();
        if (!Array.isArray(page)) return { error: jsonResponse({ error: 'Supabase response is not an array' }, 502) };
        rows.push(...page);
        if (page.length < pageSize) break;
    }
    return { rows };
};

const readDafSummaryFromSupabase = async line => {
    const result = await readSupabasePages('daf_log_batches', url => {
        // 只傳摘要欄位，避免儀表板把 records 一起拉下來；新欄位不會影響既有欄位解析。
        url.searchParams.set('select', SUMMARY_COLUMNS);
        url.searchParams.set('line', `eq.${line}`);
        url.searchParams.set('order', 'uploaded_at.desc');
    });
    if (result.error) return result.error;
    return jsonResponse(result.rows, 200, { 'Cache-Control': 'public, max-age=60, s-maxage=600' });
};

const readDafDetailsFromSupabase = async (line, start = '', end = '') => {
    const result = await readSupabasePages('daf_log_batches', url => {
        url.searchParams.set('select', '*');
        url.searchParams.set('line', `eq.${line}`);
        // 先用批次日期在 Supabase 端縮小範圍，避免把其他日期的巨大 records 全部讀進 Worker 後才過濾。
        if (start) url.searchParams.set('date_end', `gte.${start}`);
        if (end) url.searchParams.set('date_start', `lte.${end}`);
        url.searchParams.set('order', 'uploaded_at.desc');
    }, 3);
    if (result.error) return result.error;
    const rows = start || end
        ? result.rows.map(row => {
            const records = Array.isArray(row.records) ? row.records.filter(record => {
                const date = String(record?.date || '').slice(0, 10);
                if (!date) return false;
                if (start && date < start) return false;
                if (end && date > end) return false;
                return true;
            }) : [];
            return records.length ? { ...row, records } : null;
        }).filter(Boolean)
        : result.rows;
    return jsonResponse(rows, 200, { 'Cache-Control': 'public, max-age=60, s-maxage=86400' });
};

const sha256 = async value => {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const readDafVersionsFromSupabase = async lines => {
    const versions = {};
    const results = await Promise.all(lines.map(async line => {
        const result = await readSupabasePages('daf_log_batches', url => {
            url.searchParams.set('select', VERSION_COLUMNS);
            url.searchParams.set('line', `eq.${line}`);
            url.searchParams.set('order', 'id.asc');
        }, 100);
        if (result.error) return { line, error: result.error };
        const signature = result.rows.map(row => [
            row.id, row.uploaded_at, row.date_start, row.date_end, row.row_count,
            row.input_count, row.good_count, row.fail_count, row.yield_rate, row.defect_rate
        ].join('|')).join('\n');
        return { line, version: await sha256(signature), count: result.rows.length };
    }));
    const failed = results.find(result => result.error);
    if (failed) return failed.error;
    results.forEach(result => { versions[result.line] = { version: result.version, count: result.count }; });
    return jsonResponse({ versions }, 200, { 'Cache-Control': 'public, max-age=15, s-maxage=60' });
};

const readDafStatsStateFromSupabase = async () => {
    const result = await readSupabasePages('daf_log_batches', url => {
        // 共用數據統計只讀一筆快照；完整 LOG 不經過這個端點。
        url.searchParams.set('select', 'uploaded_at,records');
        url.searchParams.set('id', `eq.${SHARED_STATS_STATE_ID}`);
    }, 1);
    if (result.error) return result.error;
    return jsonResponse(result.rows[0] || null, 200, { 'Cache-Control': 'public, max-age=0, s-maxage=60' });
};

const readSmtDataFromSupabase = async () => {
    const production = await readSupabasePages('daily_production', url => {
        url.searchParams.set('select', '*,work_orders!inner(*,models(*)),defect_logs(*,defect_types(*),defect_locations(*))');
        url.searchParams.set('line', 'eq.SMT');
        url.searchParams.set('order', 'production_date.asc');
    });
    if (production.error) return production.error;
    const fpy = await readSupabasePages('daily_fpy', url => {
        url.searchParams.set('select', '*,work_orders!inner(*,models(*))');
        url.searchParams.set('line', 'eq.SMT');
        url.searchParams.set('order', 'production_date.asc');
    });
    if (fpy.error) return fpy.error;
    return jsonResponse({ production: production.rows, fpy: fpy.rows }, 200, { 'Cache-Control': 'public, max-age=60, s-maxage=600' });
};

const readAssemblyDataFromSupabase = async () => {
    const result = await readSupabasePages('assembly_log_batches', url => {
        url.searchParams.set('select', '*');
        url.searchParams.set('line', 'eq.ASSY');
        url.searchParams.set('order', 'uploaded_at.desc');
    }, 100);
    if (result.error) return result.error;
    return jsonResponse(result.rows, 200, { 'Cache-Control': 'public, max-age=60, s-maxage=600' });
};

const withCache = async (requestUrl, pathname, params, forceRefresh, loader) => {
    const cache = caches.default;
    const key = cacheKey(requestUrl, pathname, params);
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
    const fresh = await loader();
    if (!fresh.ok) return fresh;
    await cache.put(key, fresh.clone());
    const headers = new Headers(fresh.headers);
    headers.set('X-Koya-Cache', forceRefresh ? 'REFRESH' : 'MISS');
    return new Response(fresh.body, { status: fresh.status, headers });
};

const invalidateCache = async requestUrl => {
    const cache = caches.default;
    const keys = [
        ...PROCESS_LINES.map(line => cacheKeyForLine(requestUrl, '/api/daf-summary', line)),
        ...PROCESS_LINES.map(line => cacheKeyForLine(requestUrl, '/api/daf-details', line)),
        cacheKey(requestUrl, '/api/daf-version', { lines: PROCESS_LINES.join(',') }),
        cacheKey(requestUrl, '/api/daf-stats-state'),
        cacheKey(requestUrl, '/api/smt-data'),
        cacheKey(requestUrl, '/api/assembly-data')
    ];
    await Promise.all(keys.map(key => cache.delete(key)));
    return keys.length;
};

const invalidateDafStatsStateCache = async requestUrl => {
    await caches.default.delete(cacheKey(requestUrl, '/api/daf-stats-state'));
    return 1;
};

export default {
    async fetch(request, env, ctx) {
        const requestUrl = new URL(request.url);
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

        if (requestUrl.pathname === '/api/health' && request.method === 'GET') {
            return jsonResponse({ ok: true, service: 'koya-data-cache', cacheVersion: '202608171730' });
        }

        if (request.method === 'GET' && requestUrl.pathname === '/api/daf-summary') {
            const line = requestUrl.searchParams.get('line');
            if (!PROCESS_LINES.includes(line)) return jsonResponse({ error: 'Invalid process' }, 400);
            return withCache(requestUrl, '/api/daf-summary', { line }, requestUrl.searchParams.get('refresh') === '1', () => readDafSummaryFromSupabase(line));
        }

        if (request.method === 'GET' && requestUrl.pathname === '/api/daf-details') {
            const line = requestUrl.searchParams.get('line');
            if (!PROCESS_LINES.includes(line)) return jsonResponse({ error: 'Invalid process' }, 400);
            const start = requestUrl.searchParams.get('start') || '';
            const end = requestUrl.searchParams.get('end') || '';
            const params = { line };
            if (start) params.start = start;
            if (end) params.end = end;
            return withCache(requestUrl, '/api/daf-details', params, requestUrl.searchParams.get('refresh') === '1', () => readDafDetailsFromSupabase(line, start, end));
        }

        if (request.method === 'GET' && requestUrl.pathname === '/api/daf-version') {
            const requestedLines = (requestUrl.searchParams.get('lines') || '').split(',').filter(Boolean);
            const lines = [...new Set(requestedLines)];
            if (!lines.length || lines.some(line => !PROCESS_LINES.includes(line))) return jsonResponse({ error: 'Invalid process' }, 400);
            return withCache(requestUrl, '/api/daf-version', { lines: lines.join(',') }, requestUrl.searchParams.get('refresh') === '1', () => readDafVersionsFromSupabase(lines));
        }

        if (request.method === 'GET' && requestUrl.pathname === '/api/daf-stats-state') {
            return withCache(requestUrl, '/api/daf-stats-state', {}, requestUrl.searchParams.get('refresh') === '1', readDafStatsStateFromSupabase);
        }

        if (request.method === 'GET' && requestUrl.pathname === '/api/smt-data') {
            return withCache(requestUrl, '/api/smt-data', {}, requestUrl.searchParams.get('refresh') === '1', readSmtDataFromSupabase);
        }

        if (request.method === 'GET' && requestUrl.pathname === '/api/assembly-data') {
            return withCache(requestUrl, '/api/assembly-data', {}, requestUrl.searchParams.get('refresh') === '1', readAssemblyDataFromSupabase);
        }

        if (requestUrl.pathname === '/api/cache/invalidate' || requestUrl.pathname === '/api/daf-summary/invalidate') {
            if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
            const invalidated = await invalidateCache(requestUrl);
            return jsonResponse({ ok: true, invalidated });
        }

        if (requestUrl.pathname === '/api/daf-stats-state/invalidate') {
            if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
            const invalidated = await invalidateDafStatsStateCache(requestUrl);
            return jsonResponse({ ok: true, invalidated });
        }

        return jsonResponse({ error: 'Not found' }, 404);
    }
};
