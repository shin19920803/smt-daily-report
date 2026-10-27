/* Login sessions stay in memory. Only the optional account name is remembered. */
window.DashboardAuth = (() => {
    const nativeFetch = window.fetch.bind(window);
    const RPC_TIMEOUT_MS = 15000;
    const LOGOUT_TIMEOUT_MS = 5000;
    const user = Vue.ref(null);
    let config;
    let token = '';
    let leaving = false;
    const rememberKey = 'production_login_username';
    const noticeKey = 'production_login_notice';
    const readStorage = (storage, key) => { try { return storage.getItem(key) || ''; } catch { return ''; } };
    const writeStorage = (storage, key, value) => {
        try { if (value) storage.setItem(key, value); else storage.removeItem(key); } catch { /* Optional preference only. */ }
    };
    const expire = () => {
        if (leaving) return;
        leaving = true;
        token = '';
        writeStorage(sessionStorage, noticeKey, '登入已到期或帳號設定已更新，請重新登入');
        location.reload();
    };
    const configure = options => {
        config = options;
        const origins = new Set([new URL(config.url).origin, new URL(config.cacheUrl).origin]);
        window.fetch = async (input, init = {}) => {
            const url = new URL(input instanceof Request ? input.url : String(input), location.href);
            if (!origins.has(url.origin)) return nativeFetch(input, init);
            const headers = new Headers(input instanceof Request ? input.headers : undefined);
            new Headers(init.headers).forEach((value, key) => headers.set(key, value));
            if (token) headers.set('X-Dashboard-Session', token);
            const response = await nativeFetch(input, { ...init, headers, cache: 'no-store' });
            if (response.status === 401 && token) expire();
            return response;
        };
        addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
    };
    const rpc = async (name, body = {}, { timeoutMs = RPC_TIMEOUT_MS } = {}) => {
        const controller = new AbortController();
        let timedOut = false;
        let timeoutId;
        const request = (async () => {
            const response = await nativeFetch(`${config.url}/rest/v1/rpc/${name}`, {
                method: 'POST', cache: 'no-store', signal: controller.signal, headers: {
                    apikey: config.key, Authorization: `Bearer ${config.key}`,
                    'Content-Type': 'application/json', 'X-Dashboard-Session': token
                }, body: JSON.stringify(body)
            });
            let result;
            try { result = await response.json(); }
            catch (cause) {
                if (response.status === 204 || response.status === 205) result = null;
                else throw Object.assign(new Error('登入服務回應格式錯誤，請稍後重試'), { code: 'DASHBOARD_INVALID_RESPONSE', cause });
            }
            if (!response.ok) {
                if (response.status === 401 && token) expire();
                const error = new Error(result?.message || '登入服務暫時無法使用，請稍後重試');
                error.status = response.status;
                error.code = result?.code || `HTTP_${response.status}`;
                throw error;
            }
            return result;
        })();
        const deadline = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                timedOut = true;
                controller.abort();
                reject(Object.assign(new Error('登入服務回應逾時，請稍後重試'), { code: 'DASHBOARD_RPC_TIMEOUT' }));
            }, timeoutMs);
        });
        try { return await Promise.race([request, deadline]); }
        catch (failure) {
            if (timedOut) throw Object.assign(new Error('登入服務回應逾時，請稍後重試'), { code: 'DASHBOARD_RPC_TIMEOUT' });
            if (failure?.name === 'AbortError') throw Object.assign(new Error('請求已取消，請重新操作'), { code: 'DASHBOARD_RPC_ABORTED' });
            if (failure instanceof TypeError || failure?.name === 'TypeError') {
                throw Object.assign(new Error('無法連線至登入服務，請檢查網路後重試'), { code: 'DASHBOARD_NETWORK', cause: failure });
            }
            throw failure;
        } finally { clearTimeout(timeoutId); }
    };
    const logout = async () => {
        if (leaving) return;
        leaving = true;
        try { await rpc('dashboard_logout', {}, { timeoutMs: LOGOUT_TIMEOUT_MS }); }
        catch (failure) { console.warn('登出服務未能確認，已清除本機登入狀態', failure?.code || failure?.status || 'network_error'); }
        finally { token = ''; user.value = null; location.reload(); }
    };
    const mountLogin = mountDashboard => {
        Vue.createApp({
            setup() {
                const remembered = readStorage(localStorage, rememberKey);
                const username = Vue.ref(remembered);
                const password = Vue.ref('');
                const remember = Vue.ref(Boolean(remembered));
                const busy = Vue.ref(false);
                const error = Vue.ref(readStorage(sessionStorage, noticeKey));
                writeStorage(sessionStorage, noticeKey, '');
                Vue.watch(remember, checked => { if (!checked) writeStorage(localStorage, rememberKey, ''); });
                const login = async () => {
                    if (busy.value || !username.value.trim() || !password.value) return;
                    busy.value = true;
                    error.value = '';
                    try {
                        const result = await rpc('dashboard_login', { p_username: username.value.trim(), p_password: password.value });
                        if (!result?.ok || typeof result.token !== 'string' || !result.token
                            || !result.user || typeof result.user !== 'object'
                            || !result.user.id || typeof result.user.username !== 'string') {
                            throw new Error(result?.message || '帳號或密碼錯誤');
                        }
                        token = result.token;
                        user.value = result.user;
                        password.value = '';
                        writeStorage(localStorage, rememberKey, remember.value ? result.user.username : '');
                        mountDashboard();
                        document.getElementById('login-root').style.display = 'none';
                    } catch (failure) {
                        token = '';
                        user.value = null;
                        if (failure?.code === 'DASHBOARD_RPC_TIMEOUT') error.value = '登入服務回應逾時，請確認網路後重試';
                        else if (failure?.code === 'DASHBOARD_NETWORK') error.value = '目前無法連線到登入服務，請檢查網路後重試';
                        else if (failure?.code === 'DASHBOARD_INVALID_RESPONSE') error.value = failure.message;
                        else if (failure?.status === 429 || failure?.message?.includes('登入嘗試過多')) error.value = '登入嘗試過多，請稍後再試';
                        else if (failure?.status >= 500) error.value = '登入服務目前忙碌，請稍後重試';
                        else error.value = failure.message || '登入失敗，請稍後再試';
                    } finally { password.value = ''; busy.value = false; }
                };
                return { username, password, remember, busy, error, login };
            }
        }).mount('#login-root');
    };

    const accountComponent = {
        emits: ['close'],
        setup(_, { emit }) {
            const accounts = Vue.ref([]);
            const busy = Vue.ref(false);
            const ready = Vue.ref(false);
            const error = Vue.ref('');
            const notice = Vue.ref('');
            const deleting = Vue.ref(null);
            const blank = () => ({ id: null, username: '', displayName: '', password: '', enabled: true, isOwner: false });
            const form = Vue.ref(blank());
            const reset = () => { form.value = blank(); error.value = ''; notice.value = ''; };
            const edit = account => { form.value = { ...account, password: '' }; error.value = ''; notice.value = ''; };
            const load = async () => { accounts.value = await rpc('dashboard_users_list'); ready.value = true; };
            Vue.onMounted(async () => { try { await load(); } catch (failure) { error.value = failure.message; } });
            const save = async () => {
                if (busy.value || !ready.value) return;
                busy.value = true; error.value = ''; notice.value = '';
                try {
                    const ownAccount = form.value.id === user.value.id;
                    await rpc('dashboard_user_save', {
                        p_user_id: form.value.id, p_username: form.value.username,
                        p_display_name: form.value.displayName, p_password: form.value.password, p_enabled: form.value.enabled
                    });
                    form.value.password = '';
                    if (ownAccount) { await logout(); return; }
                    reset(); await load(); notice.value = '已儲存，使用者可直接登入';
                } catch (failure) { error.value = failure.message; }
                finally { busy.value = false; }
            };
            const remove = async () => {
                if (!deleting.value || busy.value) return;
                busy.value = true; error.value = '';
                try {
                    await rpc('dashboard_user_delete', { p_user_id: deleting.value.id });
                    deleting.value = null; reset(); await load(); notice.value = '使用者已刪除';
                } catch (failure) { error.value = failure.message; }
                finally { busy.value = false; }
            };
            const close = () => { if (!busy.value) { form.value.password = ''; emit('close'); } };
            return { accounts, busy, ready, error, notice, deleting, form, reset, edit, save, remove, close };
        },
        template: `
        <div class="fixed inset-0 z-[120] bg-slate-950/60 flex items-center justify-center p-3 md:p-6" @click.self="close">
          <section role="dialog" aria-modal="true" aria-labelledby="account-panel-title" class="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] overflow-y-auto">
            <header class="p-5 border-b flex items-center justify-between"><h2 id="account-panel-title" class="font-black text-xl">使用者管理</h2><button @click="close" :disabled="busy" class="btn-ghost" aria-label="關閉使用者管理">關閉</button></header>
            <div class="p-5 space-y-4">
              <p v-if="error" role="alert" class="rounded-lg bg-red-50 text-red-700 p-3 text-sm">{{ error }}</p>
              <p v-if="notice" role="status" class="rounded-lg bg-green-50 text-green-700 p-3 text-sm">{{ notice }}</p>
              <p v-if="!ready && !error" class="text-sm text-gray-500">載入使用者中…</p>
              <div class="overflow-x-auto"><table class="data-table w-full min-w-[480px]"><thead><tr><th>名稱</th><th>帳號</th><th>狀態</th><th>操作</th></tr></thead>
                <tbody><tr v-for="account in accounts" :key="account.id"><td>{{ account.displayName }} <span v-if="account.isOwner" class="text-xs text-purple-700">最高權限</span></td><td class="font-mono">{{ account.username }}</td><td :class="account.enabled ? 'text-green-700' : 'text-gray-500'">{{ account.enabled ? '啟用' : '停用' }}</td><td><button @click="edit(account)" :disabled="busy" class="text-blue-700 font-bold mr-4">編輯</button><button v-if="!account.isOwner" @click="deleting=account" :disabled="busy" class="text-red-700 font-bold">刪除</button></td></tr></tbody>
              </table></div>
              <form @submit.prevent="save" class="bg-slate-50 border rounded-xl p-4 space-y-4">
                <div class="flex justify-between"><h3 class="font-bold">{{ form.id ? '編輯使用者' : '新增使用者' }}</h3><button v-if="form.id" type="button" @click="reset" :disabled="busy" class="text-blue-700 text-sm">改為新增</button></div>
                <div class="grid md:grid-cols-3 gap-3"><label class="text-sm font-bold">名稱<input v-model="form.displayName" required maxlength="80" :disabled="busy" class="mt-1 w-full border rounded-lg p-2.5 bg-white" autocomplete="off"></label><label class="text-sm font-bold">帳號<input v-model="form.username" required maxlength="64" pattern="[A-Za-z0-9_.@-]+" :disabled="busy" class="mt-1 w-full border rounded-lg p-2.5 bg-white" autocomplete="off" autocapitalize="none" spellcheck="false"></label><label class="text-sm font-bold">{{ form.id ? '新密碼（空白不修改）' : '密碼' }}<input v-model="form.password" type="password" :required="!form.id" minlength="5" maxlength="72" :disabled="busy" class="mt-1 w-full border rounded-lg p-2.5 bg-white" autocomplete="new-password"></label></div>
                <div class="flex flex-wrap items-center justify-between gap-3"><label class="text-sm flex gap-2 items-center"><input v-model="form.enabled" type="checkbox" :disabled="busy || form.isOwner">啟用帳號</label><button type="submit" :disabled="busy || !ready" class="btn-primary disabled:opacity-50">{{ busy ? '儲存中…' : '儲存使用者' }}</button></div>
                <p v-if="form.isOwner" class="text-xs text-gray-500">修改自己的設定後，將重新登入。</p>
              </form>
              <div v-if="deleting" role="alertdialog" aria-label="確認刪除使用者" class="border border-red-200 rounded-xl p-4 bg-red-50"><p class="text-sm font-bold">確定刪除 {{ deleting.displayName }}（{{ deleting.username }}）？</p><div class="flex gap-3 mt-3"><button @click="remove" :disabled="busy" class="btn-primary bg-red-700">確認刪除</button><button @click="deleting=null" :disabled="busy" class="btn-ghost">取消</button></div></div>
            </div>
          </section>
        </div>`
    };
    return { configure, mountLogin, logout, user, accountComponent };
})();
