-- Additive account/session storage. Enforcement is activated separately after
-- both Worker endpoints and the login page have been deployed and verified.
begin;
set local lock_timeout = '5s';
create schema if not exists dashboard_private;
revoke all on schema dashboard_private from public, anon, authenticated;

create table if not exists dashboard_private.access_settings (
    id boolean primary key default true check (id),
    enabled boolean not null default false
);
insert into dashboard_private.access_settings(id) values(true) on conflict do nothing;
create table if not exists dashboard_private.accounts (
    id uuid primary key default gen_random_uuid(),
    username text not null unique check (username ~ '^[A-Z0-9_.@-]{1,64}$'),
    display_name text not null check (length(display_name) between 1 and 80),
    password_hash text not null,
    is_owner boolean not null default false,
    enabled boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    last_login_at timestamptz
);
create unique index if not exists dashboard_one_owner on dashboard_private.accounts(is_owner) where is_owner;
create table if not exists dashboard_private.sessions (
    token_hash text primary key,
    account_id uuid not null references dashboard_private.accounts(id) on delete cascade,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);
create index if not exists dashboard_sessions_account_idx on dashboard_private.sessions(account_id);
create index if not exists dashboard_sessions_expiry_idx on dashboard_private.sessions(expires_at);
create table if not exists dashboard_private.login_attempts (
    key_hash text primary key,
    attempts integer not null,
    window_start timestamptz not null default now()
);
create index if not exists dashboard_attempts_expiry_idx on dashboard_private.login_attempts(window_start);
revoke all on all tables in schema dashboard_private from public, anon, authenticated;

create or replace function dashboard_private.public_account(p_account dashboard_private.accounts)
returns jsonb language sql immutable set search_path = '' as $$
    select jsonb_build_object('id', p_account.id, 'username', p_account.username,
        'displayName', p_account.display_name, 'isOwner', p_account.is_owner,
        'enabled', p_account.enabled, 'lastLoginAt', p_account.last_login_at);
$$;

create or replace function dashboard_private.current_account_id()
returns uuid language sql stable security definer set search_path = '' as $$
    select a.id
    from dashboard_private.sessions s
    join dashboard_private.accounts a on a.id = s.account_id and a.enabled
    where s.token_hash = encode(extensions.digest(
        coalesce(nullif(current_setting('request.headers', true), '')::jsonb->>'x-dashboard-session', ''), 'sha256'), 'hex')
      and s.expires_at > now();
$$;

create or replace function public.dashboard_login(p_username text, p_password text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_account dashboard_private.accounts;
    v_username text := upper(btrim(coalesce(p_username, '')));
    v_key text;
    v_attempts integer;
    v_token text;
    v_expiry timestamptz := now() + interval '12 hours';
begin
    if length(v_username) not between 1 and 64 or octet_length(coalesce(p_password, '')) not between 1 and 72 then
        return jsonb_build_object('ok', false, 'message', '帳號或密碼錯誤');
    end if;
    -- One rate limit per normalized account; failed attempts commit rather than
    -- raising an exception that would undo the counter.
    v_key := encode(extensions.digest(v_username, 'sha256'), 'hex');
    delete from dashboard_private.login_attempts where window_start < now() - interval '1 day';
    insert into dashboard_private.login_attempts(key_hash, attempts) values(v_key, 1)
    on conflict(key_hash) do update
       set attempts = case when dashboard_private.login_attempts.window_start < now() - interval '15 minutes'
                           then 1 else dashboard_private.login_attempts.attempts + 1 end,
           window_start = case when dashboard_private.login_attempts.window_start < now() - interval '15 minutes'
                               then now() else dashboard_private.login_attempts.window_start end
    returning attempts into v_attempts;
    if v_attempts > 10 then
        return jsonb_build_object('ok', false, 'message', '登入嘗試過多，請於 15 分鐘後再試');
    end if;
    select * into v_account from dashboard_private.accounts where username = v_username;
    if v_account.id is null or not v_account.enabled
       or extensions.crypt(p_password, v_account.password_hash) is distinct from v_account.password_hash then
        return jsonb_build_object('ok', false, 'message', '帳號或密碼錯誤');
    end if;
    delete from dashboard_private.login_attempts where key_hash = v_key;
    delete from dashboard_private.sessions where expires_at <= now();
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    insert into dashboard_private.sessions(token_hash, account_id, expires_at)
    values(encode(extensions.digest(v_token, 'sha256'), 'hex'), v_account.id, v_expiry);
    update dashboard_private.accounts set last_login_at = now() where id = v_account.id
    returning * into v_account;
    return jsonb_build_object('ok', true, 'token', v_token, 'expiresAt', v_expiry,
        'user', dashboard_private.public_account(v_account));
end;
$$;

create or replace function public.dashboard_session_validate()
returns jsonb language sql stable security definer set search_path = '' as $$
    select jsonb_build_object('required', (select enabled from dashboard_private.access_settings where id),
        'valid', dashboard_private.current_account_id() is not null);
$$;

create or replace function public.dashboard_require_session()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
    perform set_config('response.headers', '[{"Cache-Control":"private, no-store"}]', true);
    if not (select enabled from dashboard_private.access_settings where id) then return; end if;
    if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') = 'service_role' then return; end if;
    if current_setting('request.path', true) in ('/rpc/dashboard_login', '/rpc/dashboard_session_validate') then return; end if;
    if dashboard_private.current_account_id() is null then
        raise sqlstate 'PT401' using message = '請先登入，或重新輸入帳號密碼';
    end if;
end;
$$;

create or replace function public.dashboard_logout()
returns void language sql security definer set search_path = '' as $$
    delete from dashboard_private.sessions where token_hash = encode(extensions.digest(
        coalesce(nullif(current_setting('request.headers', true), '')::jsonb->>'x-dashboard-session', ''), 'sha256'), 'hex');
$$;

create or replace function public.dashboard_users_list()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
    if not exists(select 1 from dashboard_private.accounts where id = dashboard_private.current_account_id() and is_owner) then
        raise sqlstate 'PT403' using message = '僅最高權限帳號可以管理使用者';
    end if;
    return (select coalesce(jsonb_agg(dashboard_private.public_account(a) order by a.is_owner desc, a.username), '[]'::jsonb)
        from dashboard_private.accounts a);
end;
$$;

create or replace function public.dashboard_user_save(
    p_username text, p_display_name text, p_password text default '',
    p_user_id uuid default null, p_enabled boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_actor uuid := dashboard_private.current_account_id();
    v_account dashboard_private.accounts;
    v_username text := upper(btrim(coalesce(p_username, '')));
    v_name text := btrim(coalesce(p_display_name, ''));
begin
    if not exists(select 1 from dashboard_private.accounts where id = v_actor and is_owner and enabled) then
        raise sqlstate 'PT403' using message = '僅最高權限帳號可以管理使用者';
    end if;
    if v_username !~ '^[A-Z0-9_.@-]{1,64}$' or length(v_name) not between 1 and 80 then
        raise exception '請填寫名稱及有效帳號（英數字、_ . @ -，最多 64 字）';
    end if;
    if p_enabled is null or p_password is null then raise exception '使用者設定不完整'; end if;
    if (p_user_id is null or p_password <> '') and octet_length(p_password) not between 5 and 72 then
        raise exception '密碼須介於 5 至 72 個位元組';
    end if;
    if p_user_id is null then
        insert into dashboard_private.accounts(username, display_name, password_hash, enabled)
        values(v_username, v_name, extensions.crypt(p_password, extensions.gen_salt('bf', 10)), p_enabled)
        returning * into v_account;
    else
        select * into v_account from dashboard_private.accounts where id = p_user_id for update;
        if not found then raise exception '使用者不存在'; end if;
        if v_account.is_owner and not p_enabled then raise exception '最高權限帳號不可停用'; end if;
        update dashboard_private.accounts set username = v_username, display_name = v_name, enabled = p_enabled,
            password_hash = case when p_password = '' then password_hash else extensions.crypt(p_password, extensions.gen_salt('bf', 10)) end,
            updated_at = now()
        where id = p_user_id returning * into v_account;
        if p_password <> '' or not p_enabled then
            delete from dashboard_private.sessions where account_id = p_user_id;
        end if;
    end if;
    return dashboard_private.public_account(v_account);
exception when unique_violation then raise exception '帳號已存在，請使用其他帳號';
end;
$$;

create or replace function public.dashboard_user_delete(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
    if not exists(select 1 from dashboard_private.accounts where id = dashboard_private.current_account_id() and is_owner and enabled) then
        raise sqlstate 'PT403' using message = '僅最高權限帳號可以管理使用者';
    end if;
    if exists(select 1 from dashboard_private.accounts where id = p_user_id and is_owner) then
        raise exception '最高權限帳號不可刪除';
    end if;
    delete from dashboard_private.accounts where id = p_user_id;
end;
$$;

revoke all on all functions in schema dashboard_private from public, anon, authenticated;
revoke all on function public.dashboard_login(text,text), public.dashboard_session_validate(),
    public.dashboard_require_session(), public.dashboard_logout(), public.dashboard_users_list(),
    public.dashboard_user_save(text,text,text,uuid,boolean), public.dashboard_user_delete(uuid) from public;
grant execute on function public.dashboard_login(text,text), public.dashboard_session_validate(),
    public.dashboard_require_session(), public.dashboard_logout(), public.dashboard_users_list(),
    public.dashboard_user_save(text,text,text,uuid,boolean), public.dashboard_user_delete(uuid) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
