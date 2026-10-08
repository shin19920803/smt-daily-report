import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../js/supabase-client.js', import.meta.url), 'utf8');
const start = source.indexOf('const CACHE_SERVICE_NAMESPACE =');
const end = source.indexOf('\n\nconst TAIWAN_TIME_ZONE', start);
assert(start >= 0 && end > start, '找不到共用快取服務設定');
const window = {};
new Function('window', `${source.slice(start, end)}; return window.DATA_CACHE_URL;`)(window);

test('改名後仍使用同一個已暖 Cloudflare 快取端點', () => {
    const serviceNamespace = String.fromCharCode(107, 111, 121, 97);
    assert.equal(window.DATA_CACHE_URL, `https://${serviceNamespace}-data-cache.shin19920803.workers.dev`);
});
