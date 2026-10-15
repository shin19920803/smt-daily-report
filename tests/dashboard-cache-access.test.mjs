import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

const source = readFileSync(new URL('../cloudflare/worker.js', import.meta.url), 'utf8');
function harness() {
    const entries = new Map();
    const valid = new Set(['session-a', 'session-b']);
    const calls = [];
    let cacheReads = 0;
    let cacheDeletes = 0;
    let validationOffline = false;
    const context = vm.createContext({ URL, Request, Response, Headers, TextEncoder, crypto: webcrypto,
        caches: { default: {
            async match(key) { cacheReads++; return entries.get(key.url)?.clone(); },
            async put(key, response) { entries.set(key.url, response.clone()); },
            async delete(key) { cacheDeletes++; return entries.delete(key.url); }
        } },
        fetch: async (input, init) => {
            const url = new URL(String(input));
            const token = new Headers(init.headers).get('x-dashboard-session');
            calls.push({ path: url.pathname, line: url.searchParams.get('line'), token });
            if (url.pathname.endsWith('/dashboard_session_validate')) {
                if (validationOffline) return new Response('{}', { status: 503 });
                return Response.json({ required: true, valid: valid.has(token) });
            }
            assert(valid.has(token), 'Supabase loader must receive its authenticated request token');
            return Response.json([{ id: 'existing-report', line: url.searchParams.get('line') }]);
        }
    });
    vm.runInContext(source.replace('export default {', 'globalThis.worker = {'), context);
    return {
        valid, calls, get cacheReads() { return cacheReads; }, get cacheDeletes() { return cacheDeletes; },
        offline() { validationOffline = true; },
        request(path, token, method = 'GET') {
            return context.worker.fetch(new Request(`https://cache.example${path}`, {
                method, headers: token ? { 'X-Dashboard-Session': token } : {}
            }), {}, {});
        }
    };
}

test('unlogged requests cannot read an existing shared cache entry', async () => {
    const h = harness();
    let response = await h.request('/api/daf-summary?line=DAF', 'session-a');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Production-Cache'), 'MISS');
    response = await h.request('/api/daf-summary?line=DAF', 'session-b');
    assert.equal(response.headers.get('X-Production-Cache'), 'HIT');
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    const reads = h.cacheReads;
    response = await h.request('/api/daf-summary?line=DAF');
    assert.equal(response.status, 401);
    assert.equal(h.cacheReads, reads);
    assert.equal(h.calls.filter(call => call.path.endsWith('/daf_log_batches')).length, 1);
});

test('revoked sessions immediately lose cached access; cache invalidation also needs login', async () => {
    const h = harness();
    await h.request('/api/daf-summary?line=DAF', 'session-a');
    h.valid.delete('session-a');
    assert.equal((await h.request('/api/daf-summary?line=DAF', 'session-a')).status, 401);
    assert.equal((await h.request('/api/cache/invalidate', null, 'POST')).status, 401);
    assert.equal(h.cacheDeletes, 0);
});

test('simultaneous users keep request-specific Supabase headers', async () => {
    const h = harness();
    await Promise.all([
        h.request('/api/daf-summary?line=DAF', 'session-a'),
        h.request('/api/daf-summary?line=FT1', 'session-b')
    ]);
    const dataCalls = h.calls.filter(call => call.path.endsWith('/daf_log_batches'));
    assert.deepEqual(dataCalls.map(call => [call.line, call.token]).sort(), [
        ['eq.DAF', 'session-a'], ['eq.FT1', 'session-b']
    ]);
});

test('validation outage fails closed before reading cached production data', async () => {
    const h = harness(); h.offline();
    assert.equal((await h.request('/api/daf-summary?line=DAF', 'session-a')).status, 503);
    assert.equal(h.cacheReads, 0);
    const options = await h.request('/api/daf-summary', null, 'OPTIONS');
    assert.match(options.headers.get('Access-Control-Allow-Headers'), /x-dashboard-session/);
});
