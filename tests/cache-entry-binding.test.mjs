import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../cloudflare/cache-entry.js', import.meta.url), 'utf8');
const loadWorker = () => new Function('Set', 'URL', 'Request', 'Response',
    source.replace('export default {', 'return {'))(Set, URL, Request, Response);

test('中性入口以 Service Binding 轉送原請求與查詢條件', async () => {
    const namespace = String.fromCharCode(107, 111, 121, 97);
    const oldHeader = `X-${namespace[0].toUpperCase()}${namespace.slice(1)}-Cache`;
    let forwarded;
    const worker = loadWorker();
    const response = await worker.fetch(
        new Request('https://production-data-cache.example/api/daf-summary?line=DAF'),
        { CACHE_BACKEND: { fetch: async request => {
            forwarded = request;
            return Response.json([{ id: 'preserved', input_count: 10 }], {
                headers: { [oldHeader]: 'HIT', 'Cache-Control': 'public, max-age=0' }
            });
        } } }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ id: 'preserved', input_count: 10 }]);
    assert.equal(new URL(forwarded.url).hostname, `${namespace}-data-cache.shin19920803.workers.dev`);
    assert.equal(new URL(forwarded.url).search, '?line=DAF');
    assert.equal(response.headers.get('X-Production-Cache'), 'HIT');
    assert.equal(response.headers.get(oldHeader), null);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://shin19920803.github.io');
});

test('中性入口不代理未知路徑，健康檢查不需讀取資料', async () => {
    let calls = 0;
    const worker = loadWorker();
    const env = { CACHE_BACKEND: { fetch: async () => { calls += 1; return new Response('{}'); } } };
    const health = await worker.fetch(new Request('https://production-data-cache.example/api/health'), env);
    assert.deepEqual(await health.json(), { ok: true, service: 'production-data-cache', cacheVersion: '20261008-neutral-entry-v1' });
    const missing = await worker.fetch(new Request('https://production-data-cache.example/private'), env);
    assert.equal(missing.status, 404);
    assert.equal(calls, 0);
});

test('中性入口保留全部 Dashboard API 路徑與 POST 失效請求內容', async () => {
    const worker = loadWorker();
    const cases = [
        ['GET', '/api/daf-summary?line=DAF'],
        ['GET', '/api/daf-details?line=FT1&start=2026-10-07&end=2026-10-07'],
        ['GET', '/api/daf-version?lines=DAF,FT1'],
        ['GET', '/api/daf-stats-state?line=DAF'],
        ['GET', '/api/smt-data'],
        ['GET', '/api/assembly-data'],
        ['POST', '/api/cache/invalidate'],
        ['POST', '/api/daf-summary/invalidate'],
        ['POST', '/api/daf-stats-state/invalidate']
    ];
    for (const [method, path] of cases) {
        let forwarded;
        const request = new Request(`https://production-data-cache.example${path}`, {
            method,
            body: method === 'POST' ? '{"probe":"unchanged"}' : undefined,
            headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined
        });
        const response = await worker.fetch(request, {
            CACHE_BACKEND: { fetch: async value => {
                forwarded = value;
                return Response.json({ same: true });
            } }
        });
        assert.equal(response.status, 200, `${method} ${path}`);
        assert.equal(new URL(forwarded.url).pathname + new URL(forwarded.url).search, path);
        assert.equal(forwarded.method, method);
        if (method === 'POST') assert.equal(await forwarded.text(), '{"probe":"unchanged"}');
        assert.deepEqual(await response.json(), { same: true });
    }
});
