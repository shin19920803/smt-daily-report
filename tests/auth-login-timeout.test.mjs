import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../js/auth.js', import.meta.url), 'utf8');

function createHarness(fetchImpl) {
    const timers = new Map();
    const local = new Map();
    const session = new Map();
    let nextTimer = 0;
    let loginState;
    let mounts = 0;
    let reloads = 0;
    const context = vm.createContext({
        URL, Headers, Request, AbortController,
        window: { fetch: fetchImpl },
        Vue: {
            ref: value => ({ value }),
            watch() {},
            createApp(component) {
                return { mount() { loginState = component.setup(); return {}; } };
            }
        },
        localStorage: {
            getItem: key => local.get(key) ?? null,
            setItem: (key, value) => local.set(key, String(value)),
            removeItem: key => local.delete(key)
        },
        sessionStorage: {
            getItem: key => session.get(key) ?? null,
            setItem: (key, value) => session.set(key, String(value)),
            removeItem: key => session.delete(key)
        },
        location: { href: 'https://dashboard.example/', reload() { reloads++; } },
        document: { getElementById: () => ({ style: {} }) },
        addEventListener() {},
        setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); }
    });
    vm.runInContext(source, context);
    context.window.DashboardAuth.configure({ url: 'https://db.example', key: 'public-key', cacheUrl: 'https://cache.example' });
    context.window.DashboardAuth.mountLogin(() => { mounts++; });
    return {
        auth: context.window.DashboardAuth,
        get state() { return loginState; },
        get mounts() { return mounts; },
        get reloads() { return reloads; },
        local,
        expireTimers() {
            const pending = [...timers.values()];
            timers.clear();
            pending.forEach(timer => timer.callback());
            return pending;
        },
        get timerCount() { return timers.size; }
    };
}

const okResponse = body => ({ ok: true, status: 200, json: async () => body });
const validLogin = { ok: true, token: 'session-token', user: { id: 'user-1', username: 'Y0163' } };

test('登入 RPC 永不回應時逾時、abort 並解除登入中', async () => {
    let signal;
    const h = createHarness((_, init) => { signal = init.signal; return new Promise(() => {}); });
    h.state.username.value = 'Y0163'; h.state.password.value = 'secret';
    const login = h.state.login();
    assert.equal(h.state.busy.value, true);
    h.expireTimers();
    await login;
    assert.equal(signal.aborted, true);
    assert.equal(h.state.busy.value, false);
    assert.equal(h.state.password.value, '');
    assert.match(h.state.error.value, /逾時/);
    assert.equal(h.mounts, 0);
});

test('收到 HTTP 回應但 JSON 本文卡住時仍有逾時上限', async () => {
    let signal;
    const h = createHarness((_, init) => {
        signal = init.signal;
        return Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) });
    });
    h.state.username.value = 'Y0163'; h.state.password.value = 'secret';
    const login = h.state.login();
    await Promise.resolve(); await Promise.resolve();
    h.expireTimers();
    await login;
    assert.equal(signal.aborted, true);
    assert.equal(h.state.busy.value, false);
    assert.match(h.state.error.value, /逾時/);
});

test('逾時後即使舊請求晚到成功，也不會登入或掛載 Dashboard', async () => {
    let resolveFetch;
    const h = createHarness(() => new Promise(resolve => { resolveFetch = resolve; }));
    h.state.username.value = 'Y0163'; h.state.password.value = 'secret';
    const login = h.state.login();
    h.expireTimers();
    await login;
    resolveFetch(okResponse(validLogin));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.auth.user.value, null);
    assert.equal(h.mounts, 0);
    assert.equal(h.state.busy.value, false);
});

test('錯誤帳密解除忙碌狀態；後續正確登入成功且只掛載一次', async () => {
    let attempts = 0;
    const h = createHarness(async () => {
        attempts++;
        return okResponse(attempts === 1 ? { ok: false, message: '帳號或密碼錯誤' } : validLogin);
    });
    h.state.username.value = 'Y0163'; h.state.password.value = 'wrong';
    await h.state.login();
    assert.equal(h.state.busy.value, false);
    assert.match(h.state.error.value, /帳號或密碼錯誤/);
    h.state.remember.value = true;
    h.state.password.value = 'secret';
    await h.state.login();
    assert.equal(h.state.busy.value, false);
    assert.equal(h.auth.user.value.username, 'Y0163');
    assert.equal(h.mounts, 1);
    assert.equal(h.local.get('production_login_username'), 'Y0163');
    assert.equal([...h.local.keys()].some(key => /token|password/i.test(key)), false);
});

test('登入忙碌時重複送出不會再發第二個 RPC', async () => {
    let calls = 0;
    const h = createHarness(async () => { calls++; return okResponse(validLogin); });
    h.state.username.value = 'Y0163'; h.state.password.value = 'secret';
    const first = h.state.login();
    await h.state.login();
    await first;
    assert.equal(calls, 1);
    assert.equal(h.mounts, 1);
});

test('網路錯誤與無效 JSON 顯示可理解訊息並解除忙碌狀態', async t => {
    await t.test('網路錯誤', async () => {
        const h = createHarness(async () => { throw new TypeError('Failed to fetch'); });
        h.state.username.value = 'Y0163'; h.state.password.value = 'secret';
        await h.state.login();
        assert.match(h.state.error.value, /無法連線/);
        assert.equal(h.state.busy.value, false);
    });
    await t.test('非 JSON 回應', async () => {
        const h = createHarness(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('invalid json'); } }));
        h.state.username.value = 'Y0163'; h.state.password.value = 'secret';
        await h.state.login();
        assert.match(h.state.error.value, /回應格式錯誤/);
        assert.equal(h.state.busy.value, false);
    });
});

test('登入 RPC 失敗狀態碼會呈現服務忙碌訊息', async () => {
    const h = createHarness(async () => ({ ok: false, status: 503, json: async () => ({ message: 'database unavailable' }) }));
    h.state.username.value = 'Y0163'; h.state.password.value = 'secret';
    await h.state.login();
    assert.match(h.state.error.value, /登入服務目前忙碌/);
    assert.equal(h.state.busy.value, false);
});

test('PostgREST schema cache 失敗不會被誤報成帳密錯誤', async () => {
    const h = createHarness(async () => ({
        ok: false, status: 503,
        json: async () => ({ code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' })
    }));
    h.state.username.value = 'Y0163'; h.state.password.value = 'secret';
    await h.state.login();
    assert.match(h.state.error.value, /無法讀取資料庫結構/);
    assert.doesNotMatch(h.state.error.value, /帳號或密碼錯誤/);
    assert.equal(h.state.busy.value, false);
});

test('登出 RPC 卡住時仍會清除前端登入狀態並回登入頁', async () => {
    let calls = 0;
    const h = createHarness((_, init) => {
        calls++;
        if (calls === 1) return Promise.resolve(okResponse(validLogin));
        assert.equal(init.signal.aborted, false);
        return new Promise(() => {});
    });
    h.state.username.value = 'Y0163'; h.state.password.value = 'secret';
    await h.state.login();
    const logout = h.auth.logout();
    assert.equal(h.state.busy.value, false);
    h.expireTimers();
    await logout;
    assert.equal(h.auth.user.value, null);
    assert.equal(h.reloads, 1);
});
