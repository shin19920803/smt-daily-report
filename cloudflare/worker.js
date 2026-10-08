const SUPABASE_URL = 'https://ccwkcwriebxipndxkvyr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNjd2tjd3JpZWJ4aXBuZHhrdnlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkzODk4MTgsImV4cCI6MjA4NDk2NTgxOH0.fUHOdc7OZVTwv6XjkmYU7uSkJMIy83OTvM7rD1n81Ic';
const APP_ORIGIN = 'https://shin19920803.github.io';
const PROCESS_LINES = ['DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY'];
const LEGACY_NAMESPACE = String.fromCharCode(107, 111, 121, 97);
const SHARED_STATS_STATE_ID = '__shared_production_daf_stats_state_v1__';
const LEGACY_SHARED_STATS_STATE_ID = `__${LEGACY_NAMESPACE}_shared_daf_stats_state_v1__`;
const SUMMARY_COLUMNS = [
    'id', 'line', 'file_name', 'uploaded_at', 'model_name', 'product_code', 'work_order',
    'report_date', 'date_start', 'date_end', 'input_count', 'good_count', 'fail_count',
    'yield_rate', 'defect_rate', 'unknown_status_count', 'unknown_status_text',
    'row_count', 'raw_column_count'
].join(',');
const VERSION_COLUMNS = 'id,file_name,uploaded_at,model_name,product_code,work_order,report_date,date_start,date_end,row_count,raw_column_count,input_count,good_count,fail_count,yield_rate,defect_rate,unknown_status_count,unknown_status_text';

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
const dafDetailsGenerationKey = (requestUrl, line) => cacheKey(requestUrl, '/api/daf-details-generation', { line });
const readDafDetailsGeneration = async (requestUrl, line) => {
    const cached = await caches.default.match(dafDetailsGenerationKey(requestUrl, line));
    return cached ? cached.text() : '0';
};
const updateDafDetailsGeneration = async (requestUrl, line) => {
    await caches.default.put(dafDetailsGenerationKey(requestUrl, line), new Response(crypto.randomUUID(), {
        headers: { 'Cache-Control': 'public, max-age=86400' }
    }));
};

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
        url.searchParams.set('order', 'uploaded_at.desc,id.asc');
    });
    if (result.error) return result.error;
    return jsonResponse(result.rows, 200, { 'Cache-Control': 'public, max-age=60, s-maxage=600' });
};

const readDafDetailsFromSupabase = async (line, start = '', end = '') => {
    const stagedResponse = await fetch(`${SUPABASE_URL}/rest/v1/rpc/daf_get_log_process_details`, {
        method: 'POST',
        headers: { ...supabaseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_line: line, p_start: start, p_end: end })
    });
    if (stagedResponse.ok) {
        const rows = await stagedResponse.json();
        if (!Array.isArray(rows)) return jsonResponse({ error: 'Staged detail response is not an array' }, 502);
        return jsonResponse(rows, 200, { 'Cache-Control': 'public, max-age=60, s-maxage=60' });
    }
    const stagedError = await stagedResponse.text();
    if (!/PGRST202|42883|Could not find the function/i.test(stagedError)) {
        return jsonResponse({ error: 'Supabase staged detail query failed', details: stagedError, status: stagedResponse.status }, 502);
    }
    const result = await readSupabasePages('daf_log_batches', url => {
        url.searchParams.set('select', '*');
        url.searchParams.set('line', `eq.${line}`);
        if (start) url.searchParams.set('date_end', `gte.${start}`);
        if (end) url.searchParams.set('date_start', `lte.${end}`);
        url.searchParams.set('order', 'uploaded_at.desc,id.asc');
    }, 100);
    if (result.error) return result.error;
    // 只取涵蓋所選日期的批次，但每個批次保留完整 records，避免明細切片被當成完整資料。
    return jsonResponse(result.rows, 200, { 'Cache-Control': 'public, max-age=60, s-maxage=60' });
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
            row.id, row.file_name, row.uploaded_at, row.model_name, row.product_code, row.work_order,
            row.report_date, row.date_start, row.date_end, row.row_count, row.raw_column_count,
            row.input_count, row.good_count, row.fail_count, row.yield_rate, row.defect_rate,
            row.unknown_status_count, row.unknown_status_text
        ].join('|')).join('\n');
        return { line, version: await sha256(signature), count: result.rows.length };
    }));
    const failed = results.find(result => result.error);
    if (failed) return failed.error;
    results.forEach(result => { versions[result.line] = { version: result.version, count: result.count }; });
    return jsonResponse({ versions }, 200, { 'Cache-Control': 'public, max-age=15, s-maxage=60' });
};

const readDafStatsStateFromSupabase = async line => {
    const result = await readSupabasePages('daf_log_batches', url => {
        // 只讀小型統計快照列；完整 LOG 不經過這個端點。
        url.searchParams.set('select', 'id,file_name,uploaded_at,records');
        url.searchParams.set('line', 'eq.__STATS_STATE__');
        url.searchParams.set('file_name', 'eq.系統共用數據統計狀態');
        url.searchParams.set('order', 'uploaded_at.desc,id.asc');
    }, 100);
    if (result.error) return result.error;
    const prefixes = line && PROCESS_LINES.includes(line)
        ? [SHARED_STATS_STATE_ID, LEGACY_SHARED_STATS_STATE_ID].map(id => `${id}:${line}`)
        : [];
    let rows = result.rows.filter(row => !prefixes.length || prefixes.some(prefix => row.id === prefix || row.id.startsWith(`${prefix}:`)));
    if (!rows.length) {
        for (const id of [SHARED_STATS_STATE_ID, LEGACY_SHARED_STATS_STATE_ID]) {
            const legacy = await readSupabasePages('daf_log_batches', url => {
                url.searchParams.set('select', 'id,file_name,uploaded_at,records');
                url.searchParams.set('id', `eq.${id}`);
            }, 1);
            if (legacy.error) return legacy.error;
            rows.push(...legacy.rows);
        }
    }
    return jsonResponse(rows, 200, { 'Cache-Control': 'public, max-age=0, s-maxage=60' });
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
            headers.set('X-Production-Cache', 'HIT');
            return new Response(cached.body, { status: cached.status, headers });
        }
    } else {
        await cache.delete(key);
    }
    const fresh = await loader();
    if (!fresh.ok) return fresh;
    await cache.put(key, fresh.clone());
    const headers = new Headers(fresh.headers);
    headers.set('X-Production-Cache', forceRefresh ? 'REFRESH' : 'MISS');
    return new Response(fresh.body, { status: fresh.status, headers });
};

const invalidateCache = async requestUrl => {
    const cache = caches.default;
    const keys = [
        ...PROCESS_LINES.map(line => cacheKeyForLine(requestUrl, '/api/daf-summary', line)),
        ...PROCESS_LINES.map(line => cacheKeyForLine(requestUrl, '/api/daf-details', line)),
        cacheKey(requestUrl, '/api/daf-version', { lines: PROCESS_LINES.join(',') }),
        ...PROCESS_LINES.map(line => cacheKey(requestUrl, '/api/daf-stats-state', { line })),
        cacheKey(requestUrl, '/api/daf-stats-state'),
        cacheKey(requestUrl, '/api/smt-data'),
        cacheKey(requestUrl, '/api/assembly-data')
    ];
    await Promise.all(keys.map(key => cache.delete(key)));
    await Promise.all(PROCESS_LINES.map(line => updateDafDetailsGeneration(requestUrl, line)));
    return keys.length;
};

const invalidateDafStatsStateCache = async requestUrl => {
    const cache = caches.default;
    const keys = [
        ...PROCESS_LINES.map(line => cacheKey(requestUrl, '/api/daf-stats-state', { line })),
        cacheKey(requestUrl, '/api/daf-stats-state')
    ];
    await Promise.all(keys.map(request => cache.delete(request)));
    return keys.length;
};

export default {
    async fetch(request, env, ctx) {
        const requestUrl = new URL(request.url);
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

        if (requestUrl.pathname === '/api/health' && request.method === 'GET') {
            return jsonResponse({ ok: true, service: 'production-data-cache', cacheVersion: '20261008-neutral-brand-v1' });
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
            const isDate = value => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
            if (!isDate(start) || !isDate(end) || (start && end && start > end)) return jsonResponse({ error: 'Invalid date range' }, 400);
            const generation = await readDafDetailsGeneration(requestUrl, line);
            const params = { line, start, end, generation };
            // 日期區間各自快取；資料更新會改 generation，使舊區間鍵不再被讀取。
            return withCache(requestUrl, '/api/daf-details', params, requestUrl.searchParams.get('refresh') === '1', () => readDafDetailsFromSupabase(line, start, end));
        }

        if (request.method === 'GET' && requestUrl.pathname === '/api/daf-version') {
            const requestedLines = (requestUrl.searchParams.get('lines') || '').split(',').filter(Boolean);
            const lines = [...new Set(requestedLines)];
            if (!lines.length || lines.some(line => !PROCESS_LINES.includes(line))) return jsonResponse({ error: 'Invalid process' }, 400);
            return withCache(requestUrl, '/api/daf-version', { lines: lines.join(',') }, requestUrl.searchParams.get('refresh') === '1', () => readDafVersionsFromSupabase(lines));
        }

        if (request.method === 'GET' && requestUrl.pathname === '/api/daf-stats-state') {
            const line = requestUrl.searchParams.get('line') || '';
            if (line && !PROCESS_LINES.includes(line)) return jsonResponse({ error: 'Invalid process' }, 400);
            const params = line ? { line } : {};
            return withCache(requestUrl, '/api/daf-stats-state', params, requestUrl.searchParams.get('refresh') === '1', () => readDafStatsStateFromSupabase(line));
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
