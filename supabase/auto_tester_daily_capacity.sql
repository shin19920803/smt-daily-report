-- Isolated daily-capacity store for the automatic tester station.
-- Raw CSV content and QR CODE values are never persisted.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table if not exists public.auto_tester_files (
    id uuid primary key default gen_random_uuid(),
    file_name text not null check (length(btrim(file_name)) between 1 and 255),
    file_sha256 bytea not null check (octet_length(file_sha256) = 32),
    uploaded_at timestamptz not null default now()
);
create unique index if not exists auto_tester_files_name_key_uq
    on public.auto_tester_files (lower(btrim(file_name)));

create table if not exists public.auto_tester_file_qr (
    file_id uuid not null references public.auto_tester_files(id) on delete cascade,
    report_date date not null,
    qr_hash bytea not null check (octet_length(qr_hash) = 32),
    primary key (file_id, report_date, qr_hash)
);
create index if not exists auto_tester_file_qr_date_hash_idx
    on public.auto_tester_file_qr (report_date, qr_hash, file_id);

create table if not exists public.auto_tester_daily_summary (
    report_date date primary key,
    daily_count integer not null check (daily_count >= 0),
    updated_at timestamptz not null default now()
);

create table if not exists public.auto_tester_state (
    id boolean primary key default true check (id),
    revision bigint not null default 0 check (revision >= 0),
    updated_at timestamptz not null default now()
);
insert into public.auto_tester_state(id) values (true) on conflict (id) do nothing;

alter table public.auto_tester_files enable row level security;
alter table public.auto_tester_file_qr enable row level security;
alter table public.auto_tester_daily_summary enable row level security;
alter table public.auto_tester_state enable row level security;
revoke all on public.auto_tester_files, public.auto_tester_file_qr,
    public.auto_tester_daily_summary, public.auto_tester_state from public, anon, authenticated;

create or replace function public.auto_tester_get_state()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_revision bigint;
begin
    if dashboard_private.current_account_id() is null then
        raise sqlstate 'PT401' using message = '請先登入後再讀取自動測試機資料';
    end if;
    select revision into v_revision from public.auto_tester_state where id = true;
    return pg_catalog.jsonb_build_object('revision', coalesce(v_revision, 0));
end;
$$;

create or replace function public.auto_tester_get_summary(p_start date, p_end date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_revision bigint; v_daily jsonb;
begin
    if dashboard_private.current_account_id() is null then
        raise sqlstate 'PT401' using message = '請先登入後再讀取自動測試機資料';
    end if;
    if p_start is null or p_end is null or p_end < p_start or p_end - p_start > 3660 then
        raise exception '統計日期區間無效，最多可查詢 10 年';
    end if;
    select revision into v_revision from public.auto_tester_state where id = true;
    select coalesce(
        pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'report_date', s.report_date, 'daily_count', s.daily_count
        ) order by s.report_date), '[]'::jsonb)
      into v_daily
      from public.auto_tester_daily_summary s
     where s.report_date between p_start and p_end;
    return pg_catalog.jsonb_build_object('revision', coalesce(v_revision, 0), 'daily', v_daily);
end;
$$;

create or replace function public.auto_tester_list_files(p_limit integer default 25, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_revision bigint; v_total bigint; v_files jsonb;
begin
    if dashboard_private.current_account_id() is null then
        raise sqlstate 'PT401' using message = '請先登入後再讀取自動測試機資料';
    end if;
    if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 10000000 then
        raise exception '檔案清單分頁參數無效';
    end if;
    select revision into v_revision from public.auto_tester_state where id = true;
    select count(*) into v_total from public.auto_tester_files;
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(page) order by page.uploaded_at desc, page.id), '[]'::jsonb)
      into v_files
      from (
          select f.id, f.file_name, f.uploaded_at,
                 count(q.qr_hash)::integer as qr_count,
                 coalesce(pg_catalog.jsonb_agg(distinct q.report_date order by q.report_date)
                     filter (where q.report_date is not null), '[]'::jsonb) as report_dates
            from public.auto_tester_files f
            left join public.auto_tester_file_qr q on q.file_id = f.id
           group by f.id
           order by f.uploaded_at desc, f.id
           limit p_limit offset p_offset
      ) page;
    return pg_catalog.jsonb_build_object('revision', coalesce(v_revision, 0), 'files', v_files, 'total_count', v_total);
end;
$$;

create or replace function public.auto_tester_publish_file(
    p_file_name text,
    p_file_sha256 text,
    p_entries jsonb,
    p_replace_file_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_name_key text := lower(btrim(coalesce(p_file_name, '')));
    v_file_sha bytea;
    v_existing_id uuid;
    v_existing_sha bytea;
    v_file_id uuid;
    v_day date;
    v_affected date[];
    v_count integer;
    v_revision bigint;
begin
    if dashboard_private.current_account_id() is null then
        raise sqlstate 'PT401' using message = '請先登入後再上傳自動測試機資料';
    end if;
    if p_file_name is null or length(v_name_key) not between 1 and 255 or p_file_name !~* '\.csv$'
       or position('/' in p_file_name) > 0 or position(chr(92) in p_file_name) > 0
       or p_file_name ~ '[[:cntrl:]]' then
        raise exception '檔案名稱無效，僅接受 CSV 檔案';
    end if;
    if p_file_sha256 is null or lower(p_file_sha256) !~ '^[0-9a-f]{64}$' then
        raise exception '檔案指紋格式無效';
    end if;
    if pg_catalog.jsonb_typeof(p_entries) is distinct from 'array'
       or pg_catalog.jsonb_array_length(p_entries) not between 1 and 25000
       or pg_catalog.octet_length(p_entries::text) > 5000000 then
        raise exception '檔案資料筆數或內容大小超過安全上限';
    end if;
    if exists (
        select 1 from pg_catalog.jsonb_array_elements(p_entries) e
         where pg_catalog.jsonb_typeof(e) is distinct from 'object'
            or coalesce(e->>'qr_hash', '') !~* '^[0-9a-f]{64}$'
            or coalesce(e->>'report_date', '') !~ '^\d{4}-\d{2}-\d{2}$'
    ) then
        raise exception '資料格式無效，請重新選取 CSV 檔案';
    end if;
    -- The round-trip check rejects dates PostgreSQL might otherwise normalize.
    if exists (
        select 1 from pg_catalog.jsonb_array_elements(p_entries) e
         where to_char((e->>'report_date')::date, 'YYYY-MM-DD') <> e->>'report_date'
    ) then
        raise exception '資料包含無效的生產日期';
    end if;

    v_file_sha := decode(lower(p_file_sha256), 'hex');
    -- All writes for the same normalized filename serialize before checking replacement state.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('auto-tester:file:' || v_name_key, 0));
    select id, file_sha256 into v_existing_id, v_existing_sha
      from public.auto_tester_files
     where lower(btrim(file_name)) = v_name_key
     for update;

    if v_existing_id is not null and v_existing_sha = v_file_sha then
        select revision into v_revision from public.auto_tester_state where id = true;
        return pg_catalog.jsonb_build_object('status', 'duplicate', 'file_id', v_existing_id, 'revision', v_revision);
    end if;
    if v_existing_id is not null and p_replace_file_id is null then
        select revision into v_revision from public.auto_tester_state where id = true;
        return pg_catalog.jsonb_build_object('status', 'confirmation_required', 'existing_file_id', v_existing_id, 'revision', v_revision);
    end if;
    if v_existing_id is not null and p_replace_file_id is distinct from v_existing_id then
        raise exception '檔案清單已變更，請重新整理後再確認取代';
    end if;
    if v_existing_id is null and p_replace_file_id is not null then
        raise exception '原檔案已不存在，請重新整理後再上傳';
    end if;

    select pg_catalog.array_agg(d.report_date order by d.report_date) into v_affected
      from (
          select q.report_date from public.auto_tester_file_qr q where q.file_id = v_existing_id
          union
          select (e->>'report_date')::date from pg_catalog.jsonb_array_elements(p_entries) e
      ) d;
    foreach v_day in array coalesce(v_affected, array[]::date[]) loop
        perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('auto-tester:date:' || v_day::text, 0));
    end loop;

    if v_existing_id is not null then
        delete from public.auto_tester_files where id = v_existing_id;
    end if;
    insert into public.auto_tester_files(file_name, file_sha256)
    values (btrim(p_file_name), v_file_sha)
    returning id into v_file_id;

    insert into public.auto_tester_file_qr(file_id, report_date, qr_hash)
    select v_file_id, (e->>'report_date')::date, decode(lower(e->>'qr_hash'), 'hex')
      from pg_catalog.jsonb_array_elements(p_entries) e
    on conflict (file_id, report_date, qr_hash) do nothing;

    foreach v_day in array coalesce(v_affected, array[]::date[]) loop
        select count(distinct q.qr_hash)::integer into v_count
          from public.auto_tester_file_qr q where q.report_date = v_day;
        if v_count > 0 then
            insert into public.auto_tester_daily_summary(report_date, daily_count, updated_at)
            values (v_day, v_count, now())
            on conflict (report_date) do update set daily_count = excluded.daily_count, updated_at = excluded.updated_at;
        else
            delete from public.auto_tester_daily_summary where report_date = v_day;
        end if;
    end loop;
    update public.auto_tester_state set revision = revision + 1, updated_at = now() where id = true returning revision into v_revision;
    return pg_catalog.jsonb_build_object('status', 'published', 'file_id', v_file_id,
        'unique_count', (select count(*) from public.auto_tester_file_qr where file_id = v_file_id), 'revision', v_revision);
end;
$$;

create or replace function public.auto_tester_delete_file(p_file_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_name_key text;
    v_day date;
    v_affected date[];
    v_count integer;
    v_revision bigint;
    v_remaining bigint;
begin
    if dashboard_private.current_account_id() is null then
        raise sqlstate 'PT401' using message = '請先登入後再刪除自動測試機資料';
    end if;
    select lower(btrim(file_name)) into v_name_key from public.auto_tester_files where id = p_file_id;
    if v_name_key is null then
        select revision into v_revision from public.auto_tester_state where id = true;
        select count(*) into v_remaining from public.auto_tester_files;
        return pg_catalog.jsonb_build_object('deleted', false, 'remaining_files', v_remaining, 'revision', v_revision);
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('auto-tester:file:' || v_name_key, 0));
    perform 1 from public.auto_tester_files where id = p_file_id for update;
    if not found then
        select revision into v_revision from public.auto_tester_state where id = true;
        select count(*) into v_remaining from public.auto_tester_files;
        return pg_catalog.jsonb_build_object('deleted', false, 'remaining_files', v_remaining, 'revision', v_revision);
    end if;
    select pg_catalog.array_agg(q.report_date order by q.report_date) into v_affected
      from (select distinct report_date from public.auto_tester_file_qr where file_id = p_file_id) q;
    foreach v_day in array coalesce(v_affected, array[]::date[]) loop
        perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('auto-tester:date:' || v_day::text, 0));
    end loop;
    delete from public.auto_tester_files where id = p_file_id;
    foreach v_day in array coalesce(v_affected, array[]::date[]) loop
        select count(distinct q.qr_hash)::integer into v_count
          from public.auto_tester_file_qr q where q.report_date = v_day;
        if v_count > 0 then
            update public.auto_tester_daily_summary set daily_count = v_count, updated_at = now() where report_date = v_day;
            if not found then
                insert into public.auto_tester_daily_summary(report_date, daily_count) values (v_day, v_count);
            end if;
        else
            delete from public.auto_tester_daily_summary where report_date = v_day;
        end if;
    end loop;
    update public.auto_tester_state set revision = revision + 1, updated_at = now() where id = true returning revision into v_revision;
    select count(*) into v_remaining from public.auto_tester_files;
    return pg_catalog.jsonb_build_object('deleted', true, 'remaining_files', v_remaining, 'revision', v_revision);
end;
$$;

revoke all on function public.auto_tester_get_state(),
    public.auto_tester_get_summary(date,date), public.auto_tester_list_files(integer,integer),
    public.auto_tester_publish_file(text,text,jsonb,uuid), public.auto_tester_delete_file(uuid) from public;
grant execute on function public.auto_tester_get_state(),
    public.auto_tester_get_summary(date,date), public.auto_tester_list_files(integer,integer),
    public.auto_tester_publish_file(text,text,jsonb,uuid), public.auto_tester_delete_file(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
