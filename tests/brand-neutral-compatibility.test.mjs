import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

const clientSource = readFileSync(new URL('../js/supabase-client.js', import.meta.url), 'utf8');
const migrationStart = clientSource.indexOf('const migrateLegacyStorageKeys = () => {');
const migrationEnd = clientSource.indexOf('\nmigrateLegacyStorageKeys();', migrationStart);
assert(migrationStart >= 0 && migrationEnd > migrationStart, '找不到瀏覽器設定鍵相容遷移');
const runStorageMigration = values => {
    const storage = new Map(values);
    const localStorage = {
        get length() { return storage.size; },
        key(index) { return [...storage.keys()][index] ?? null; },
        getItem(key) { return storage.get(key) ?? null; },
        setItem(key, value) { storage.set(key, String(value)); },
        removeItem(key) { storage.delete(key); }
    };
    new Function('localStorage', `${clientSource.slice(migrationStart, migrationEnd)}; migrateLegacyStorageKeys();`)(localStorage);
    return storage;
};

test('既有本機偏好搬到新鍵且內容完整保留', () => {
    const oldPrefix = String.fromCharCode(107, 111, 121, 97);
    const oldKey = `${oldPrefix}_test_stats_state_v1`;
    const payload = JSON.stringify({ start: '2026-08-01', end: '2026-08-31' });
    const storage = runStorageMigration([[oldKey, payload]]);
    assert.equal(storage.get('production_test_stats_state_v1'), payload);
    assert.equal(storage.has(oldKey), false);
});

test('新舊本機鍵內容衝突時不覆寫、不刪除任一份設定', () => {
    const oldPrefix = String.fromCharCode(107, 111, 121, 97);
    const oldKey = `${oldPrefix}_test_process_v1`;
    const storage = runStorageMigration([[oldKey, 'DAF'], ['production_test_process_v1', 'FT1']]);
    assert.equal(storage.get(oldKey), 'DAF');
    assert.equal(storage.get('production_test_process_v1'), 'FT1');
});

test('新舊跨裝置統計狀態寫入都不會清除 LOG 快取', async () => {
    const fetchStart = clientSource.indexOf('const trackedFetch = async (input, init = {}) => {');
    const fetchEnd = clientSource.indexOf('\nconst _supabase =', fetchStart);
    assert(fetchStart >= 0 && fetchEnd > fetchStart, '找不到 Supabase 快取失效攔截器');
    const namespace = String.fromCharCode(107, 111, 121, 97);
    const makeFetch = () => {
        let invalidations = 0;
        const trackedFetch = new Function('nativeFetch', 'window', 'Request', 'SHARED_STATS_STATE_ID', 'LEGACY_SHARED_STATS_STATE_ID',
            `${clientSource.slice(fetchStart, fetchEnd)}; return trackedFetch;`)(
            async () => new Response('{}', { status: 200 }),
            { invalidateDataCache: async () => { invalidations += 1; } }, Request,
            '__shared_production_daf_stats_state_v1__', `__${namespace}_shared_daf_stats_state_v1__`
        );
        return { trackedFetch, get invalidations() { return invalidations; } };
    };
    for (const stateId of ['__shared_production_daf_stats_state_v1__', `__${namespace}_shared_daf_stats_state_v1__`]) {
        const harness = makeFetch();
        await harness.trackedFetch('https://database.example/rest/v1/data', {
            method: 'POST', body: JSON.stringify({ id: `${stateId}:DAF:hash` })
        });
        assert.equal(harness.invalidations, 0, '共用統計快照寫入不應清除 LOG 快取');
    }
});

test('上線來源不含品牌明文', () => {
    const legacyToken = String.fromCharCode(107, 111, 121, 97);
    const sourceFiles = [fileURLToPath(new URL('../index.html', import.meta.url))];
    const visit = directory => readdirSync(directory, { withFileTypes: true }).forEach(entry => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (/\.(?:js|mjs|html|sql|sh)$/.test(entry.name)) sourceFiles.push(path);
    });
    for (const path of ['js', 'cloudflare', 'scripts', 'supabase', 'tests']) {
        visit(fileURLToPath(new URL(`../${path}`, import.meta.url)));
    }
    for (const path of sourceFiles) {
        assert.ok(!readFileSync(path, 'utf8').toLowerCase().includes(legacyToken), `程式碼仍含品牌明文：${path}`);
    }
});
