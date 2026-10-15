-- Isolated database only. All test users and sessions are rolled back.
begin;
do $$
declare
    v_login jsonb;
    v_owner_token text;
    v_member jsonb;
    v_member_token text;
    v_header text;
begin
    delete from dashboard_private.accounts;
    insert into dashboard_private.accounts(username, display_name, password_hash, is_owner)
    values('AUTH_TEST_OWNER','測試管理員',extensions.crypt('owner-test-secret',extensions.gen_salt('bf',4)),true);
    update dashboard_private.access_settings set enabled=true;
    perform set_config('request.headers','{}',true);
    perform set_config('request.path','/models',true);
    begin
        perform public.dashboard_require_session();
        raise exception 'Unauthenticated access was allowed';
    exception when sqlstate 'PT401' then null; end;
    if (public.dashboard_login('AUTH_TEST_OWNER','wrong')->>'ok')::boolean then raise exception 'Wrong password accepted'; end if;
    v_login := public.dashboard_login(' auth_test_owner ','owner-test-secret');
    if not (v_login->>'ok')::boolean then raise exception 'Owner login failed: %',v_login; end if;
    v_owner_token := v_login->>'token';
    if exists(select 1 from dashboard_private.sessions where token_hash = v_owner_token) then raise exception 'Plaintext session persisted'; end if;
    perform set_config('request.headers',jsonb_build_object('x-dashboard-session',v_owner_token)::text,true);
    perform public.dashboard_require_session();
    if not (public.dashboard_session_validate()->>'valid')::boolean then raise exception 'Session invalid'; end if;
    v_member := public.dashboard_user_save('member-test','一般使用者','member-test-secret');
    if (v_member->>'isOwner')::boolean then raise exception 'Member gained owner privileges'; end if;
    if public.dashboard_users_list()::text like '%password%' then raise exception 'Password metadata leaked'; end if;
    begin
        perform public.dashboard_user_delete((v_login->'user'->>'id')::uuid);
        raise exception 'Owner deletion was allowed';
    exception when raise_exception then
        if sqlerrm <> '最高權限帳號不可刪除' then raise; end if;
    end;
    v_member_token := public.dashboard_login('MEMBER-TEST','member-test-secret')->>'token';
    perform set_config('request.headers',jsonb_build_object('x-dashboard-session',v_member_token)::text,true);
    perform public.dashboard_require_session();
    begin
        perform public.dashboard_users_list();
        raise exception 'Member could list accounts';
    exception when sqlstate 'PT403' then null; end;
    begin
        perform public.dashboard_user_save('hacked','Hacked','some-password');
        raise exception 'Member could create accounts';
    exception when sqlstate 'PT403' then null; end;
    perform set_config('request.headers',jsonb_build_object('x-dashboard-session',v_owner_token)::text,true);
    perform public.dashboard_user_save('MEMBER-TEST','更新名稱','', (v_member->>'id')::uuid, false);
    perform set_config('request.headers',jsonb_build_object('x-dashboard-session',v_member_token)::text,true);
    if (public.dashboard_session_validate()->>'valid')::boolean then raise exception 'Disabled session remained active'; end if;
    if (public.dashboard_login('MEMBER-TEST','member-test-secret')->>'ok')::boolean then raise exception 'Disabled user could login'; end if;
    perform set_config('request.headers',jsonb_build_object('x-dashboard-session',v_owner_token)::text,true);
    perform public.dashboard_user_save('MEMBER-TEST','更新名稱','reset-test-secret',(v_member->>'id')::uuid,true);
    if (public.dashboard_login('MEMBER-TEST','member-test-secret')->>'ok')::boolean then raise exception 'Old password accepted'; end if;
    if not (public.dashboard_login('MEMBER-TEST','reset-test-secret')->>'ok')::boolean then raise exception 'Reset password failed'; end if;
    perform public.dashboard_user_delete((v_member->>'id')::uuid);
    if exists(select 1 from dashboard_private.sessions s where s.account_id=(v_member->>'id')::uuid) then raise exception 'Deleted sessions remained'; end if;
    perform public.dashboard_logout();
    if (public.dashboard_session_validate()->>'valid')::boolean then raise exception 'Logout left session active'; end if;
    perform set_config('request.path','/rpc/dashboard_login',true);
    perform public.dashboard_require_session();
    for i in 1..11 loop perform public.dashboard_login('AUTH_TEST_OWNER','wrong'); end loop;
    if (public.dashboard_login('AUTH_TEST_OWNER','owner-test-secret')->>'ok')::boolean then raise exception 'Login rate limit failed'; end if;
    raise notice 'PASS: login, API gate, roles, user changes, revocation, logout and rate limit';
end;
$$;
set local role anon;
do $$
begin
    if has_schema_privilege(current_user, 'dashboard_private', 'USAGE') then
        raise exception 'Anonymous role can access private credential storage';
    end if;
    perform set_config('request.path', '/models', true);
    begin
        perform public.dashboard_require_session();
        raise exception 'Anonymous database role bypassed the gate';
    exception when sqlstate 'PT401' then null; end;
    if (public.dashboard_session_validate()->>'valid')::boolean then raise exception 'Invalid session accepted'; end if;
    begin
        perform public.dashboard_users_list();
        raise exception 'Anonymous role could read accounts';
    exception when sqlstate 'PT403' then null; end;
    raise notice 'PASS: actual anonymous role cannot bypass the gate or read private accounts';
end;
$$;
rollback;
