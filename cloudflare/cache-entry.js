const APP_ORIGIN = 'https://shin19920803.github.io';
const ALLOWED_GET_ROUTES = new Set([
    '/api/daf-summary', '/api/daf-details', '/api/daf-version', '/api/daf-stats-state',
    '/api/smt-data', '/api/assembly-data'
]);
const ALLOWED_POST_ROUTES = new Set([
    '/api/cache/invalidate', '/api/daf-summary/invalidate', '/api/daf-stats-state/invalidate'
]);
const LEGACY_NAMESPACE = String.fromCharCode(107, 111, 121, 97);
const LEGACY_CACHE_HEADER = `X-${LEGACY_NAMESPACE[0].toUpperCase()}${LEGACY_NAMESPACE.slice(1)}-Cache`;
const LEGACY_BACKEND_ORIGIN = `https://${LEGACY_NAMESPACE}-data-cache.shin19920803.workers.dev`;
const corsHeaders = {
    'Access-Control-Allow-Origin': APP_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, apikey, authorization',
    'Vary': 'Origin'
};

const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', ...headers }
});

export default {
    async fetch(request, env) {
        const requestUrl = new URL(request.url);
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
        if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
            return jsonResponse({ ok: true, service: 'production-data-cache', cacheVersion: '20261008-neutral-entry-v1' });
        }
        if (!(request.method === 'GET' && ALLOWED_GET_ROUTES.has(requestUrl.pathname))
            && !(request.method === 'POST' && ALLOWED_POST_ROUTES.has(requestUrl.pathname))) {
            return jsonResponse({ error: 'Not found' }, 404);
        }
        if (!env.CACHE_BACKEND?.fetch) return jsonResponse({ error: 'Cache backend binding unavailable' }, 503);

        const backendUrl = new URL(requestUrl.pathname + requestUrl.search, LEGACY_BACKEND_ORIGIN);
        try {
            const upstream = await env.CACHE_BACKEND.fetch(new Request(backendUrl, request));
            const headers = new Headers(upstream.headers);
            const cacheStatus = headers.get(LEGACY_CACHE_HEADER) || headers.get('X-Production-Cache');
            headers.delete(LEGACY_CACHE_HEADER);
            Object.entries(corsHeaders).forEach(([name, value]) => headers.set(name, value));
            if (cacheStatus) headers.set('X-Production-Cache', cacheStatus);
            return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
        } catch (error) {
            return jsonResponse({ error: 'Cache service temporarily unavailable' }, 502);
        }
    }
};
