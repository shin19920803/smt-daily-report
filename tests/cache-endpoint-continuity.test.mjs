import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../js/supabase-client.js', import.meta.url), 'utf8');
const cacheUrlMatch = source.match(/window\.DATA_CACHE_URL = ('[^']+');/);
assert(cacheUrlMatch, '找不到共用快取服務設定');
const cacheUrl = cacheUrlMatch[1].slice(1, -1);

test('前端只呼叫中性 Cloudflare 入口', () => {
    assert.equal(cacheUrl, 'https://production-data-cache.shin19920803.workers.dev');
});
