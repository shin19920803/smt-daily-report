-- Apply only after the login frontend and both Worker endpoints are verified.
begin;
do $$
begin
    if not exists(select 1 from dashboard_private.accounts where is_owner and enabled) then
        raise exception '尚未建立最高權限帳號，拒絕啟用';
    end if;
    if exists(select 1 from public.daf_log_import_jobs where status = 'receiving') then
        raise exception '仍有上傳中的檔案，請完成後再啟用登入';
    end if;
    if exists(select 1 from pg_roles r, unnest(r.rolconfig) c
              where r.rolname='authenticator' and c like 'pgrst.db_pre_request=%'
                and c <> 'pgrst.db_pre_request=public.dashboard_require_session') then
        raise exception '已存在其他 API 存取保護，請先整合';
    end if;
end;
$$;
alter role authenticator set pgrst.db_pre_request = 'public.dashboard_require_session';
update dashboard_private.access_settings set enabled = true where id;
notify pgrst, 'reload config';
notify pgrst, 'reload schema';
commit;
