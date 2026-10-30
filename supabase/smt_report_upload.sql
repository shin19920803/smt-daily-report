-- Atomic, minimal-provenance importer for SMT daily production spreadsheets.
-- The source workbook / CSV bytes are parsed in the browser and are never stored.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table if not exists public.smt_report_upload_batches (
    id uuid primary key default gen_random_uuid(),
    file_name text not null check (length(btrim(file_name)) between 1 and 255),
    content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
    production_date date not null,
    uploaded_at timestamptz not null default now(),
    row_manifest jsonb not null default '[]'::jsonb,
    unique (production_date, content_hash)
);
alter table public.smt_report_upload_batches enable row level security;
revoke all on public.smt_report_upload_batches from public, anon, authenticated;

create or replace function public.smt_publish_report_upload(
    p_file_name text, p_content_hash text, p_production_date date, p_rows jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_existing public.smt_report_upload_batches;
    v_batch public.smt_report_upload_batches;
    v_row jsonb;
    v_defect jsonb;
    v_wo record;
    v_production_id bigint;
    v_log_id bigint;
    v_side text;
    v_row_number integer;
    v_good integer;
    v_ng integer;
    v_input integer;
    v_existing_input bigint;
    v_file_input bigint;
    v_manifest jsonb := '[]'::jsonb;
    v_defect_ids jsonb;
    v_defect_manifest jsonb;
    v_seen_rows integer[] := '{}'::integer[];
    v_type_id bigint;
    v_location_id bigint;
    v_qty integer;
begin
    if dashboard_private.current_account_id() is null then
        raise sqlstate 'PT401' using message = '請先登入後再上傳 SMT 報工';
    end if;
    if coalesce(btrim(p_file_name), '') = '' or length(p_file_name) > 255
       or p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' or p_production_date is null
       or p_rows is null or jsonb_typeof(p_rows) <> 'array'
       or jsonb_array_length(p_rows) not between 1 and 1000 then
        raise exception '上傳資料不完整或超出單檔列數上限';
    end if;

    -- Serialize upload/delete for a predictable duplicate check and all-or-nothing publication.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('smt-report-upload', 0));
    select * into v_existing from public.smt_report_upload_batches
     where production_date = p_production_date and content_hash = p_content_hash;
    if found then
        return pg_catalog.jsonb_build_object('ok', true, 'duplicate', true,
            'batch_id', v_existing.id, 'row_count', pg_catalog.jsonb_array_length(v_existing.row_manifest));
    end if;

    -- Validate every report row, work order, capacity, same-day collision and defect
    -- reference before inserting any production data.
    for v_row in select value from pg_catalog.jsonb_array_elements(p_rows) loop
        v_row_number := (v_row->>'source_row')::integer;
        v_side := v_row->>'side';
        v_good := (v_row->>'good_qty')::integer;
        v_ng := (v_row->>'ng_qty')::integer;
        v_input := (v_row->>'input_qty')::integer;
        if v_row_number is null or v_row_number < 2 or v_side is null or v_side not in ('TOP', 'BOT')
           or v_good is null or v_ng is null or v_input is null
           or v_good < 0 or v_ng < 0 or v_input <= 0 or v_input <> v_good + v_ng then
            raise exception 'Excel 第 % 列數量或面別不合法', v_row_number;
        end if;
        if v_row_number = any(v_seen_rows) then
            raise exception 'Excel 來源列重複，請重新選擇原始檔案';
        end if;
        v_seen_rows := pg_catalog.array_append(v_seen_rows, v_row_number);

        select w.id, w.wo_number, w.target_quantity, m.name as model_name
          into v_wo
          from public.work_orders w
          join public.models m on m.id = w.model_id
         where w.id = (v_row->>'wo_id')::bigint and w.line = 'SMT' and m.line = 'SMT'
         for update of w;
        if not found or v_wo.wo_number <> v_row->>'wo_number'
           or pg_catalog.upper(coalesce(pg_catalog.substring(pg_catalog.upper(v_wo.model_name), '[_-](TOP|BOT)$'), '')) <> v_side
           or v_wo.model_name <> (v_row->>'model_name') then
            raise exception 'Excel 第 % 列工單或 TOP／BOT 機種對應已變更，請重新載入檔案', v_row_number;
        end if;
        if v_wo.target_quantity is null or v_wo.target_quantity <= 0 then
            raise exception '工單 % 尚未設定有效的預計數量', v_wo.wo_number;
        end if;
        select coalesce(pg_catalog.sum(input_quantity), 0) into v_existing_input
          from public.daily_production where wo_id = v_wo.id;
        select coalesce(pg_catalog.sum((x.value->>'input_qty')::integer), 0) into v_file_input
          from pg_catalog.jsonb_array_elements(p_rows) as x(value)
         where (x.value->>'wo_id')::bigint = v_wo.id;
        if v_existing_input + v_file_input > v_wo.target_quantity then
            raise exception '工單 % 投入後會超過預計數量（目前 %，本次 %，預計 %）',
                v_wo.wo_number, v_existing_input, v_file_input, v_wo.target_quantity;
        end if;
        if exists(select 1 from public.daily_production
                   where wo_id = v_wo.id and production_date = p_production_date) then
            raise exception '工單 % 在 % 已有報工紀錄，為避免重複請先檢查既有資料',
                v_wo.wo_number, p_production_date;
        end if;
        if pg_catalog.jsonb_typeof(coalesce(v_row->'defects', '[]'::jsonb)) <> 'array'
           or coalesce((select pg_catalog.sum((d->>'quantity')::integer)
                 from pg_catalog.jsonb_array_elements(coalesce(v_row->'defects','[]'::jsonb)) d), 0) <> v_ng then
            raise exception 'Excel 第 % 列不良明細合計與 F 欄不符', v_row_number;
        end if;
        for v_defect in select value from pg_catalog.jsonb_array_elements(coalesce(v_row->'defects','[]'::jsonb)) loop
            v_qty := (v_defect->>'quantity')::integer;
            if v_qty <= 0 then raise exception 'Excel 第 % 列不良明細數量必須大於 0', v_row_number; end if;
            select id into v_type_id from public.defect_types
             where line = 'SMT' and id = (v_defect->>'type_id')::bigint
               and name = v_defect->>'type_name';
            if not found then raise exception '不良項目已不存在或已變更：%', v_defect->>'type_name'; end if;
            select id into v_location_id from public.defect_locations
             where line = 'SMT' and id = (v_defect->>'location_id')::bigint
               and code = v_defect->>'location_code';
            if not found then raise exception '位置代碼已不存在或已變更：%', v_defect->>'location_code'; end if;
        end loop;
    end loop;

    insert into public.smt_report_upload_batches(file_name, content_hash, production_date)
    values (btrim(p_file_name), p_content_hash, p_production_date) returning * into v_batch;

    -- Deliberately insert one daily_production row per source Excel row; never aggregate.
    for v_row in select value from pg_catalog.jsonb_array_elements(p_rows) loop
        v_row_number := (v_row->>'source_row')::integer;
        v_side := v_row->>'side';
        v_good := (v_row->>'good_qty')::integer;
        v_ng := (v_row->>'ng_qty')::integer;
        v_input := (v_row->>'input_qty')::integer;
        insert into public.daily_production(wo_id, production_date, input_quantity, line)
        values ((v_row->>'wo_id')::bigint, p_production_date, v_input, 'SMT') returning id into v_production_id;

        v_defect_ids := '[]'::jsonb;
        v_defect_manifest := '[]'::jsonb;
        for v_defect in select value from pg_catalog.jsonb_array_elements(coalesce(v_row->'defects','[]'::jsonb)) loop
            insert into public.defect_logs(production_id, defect_type_id, location_id, quantity)
            values (v_production_id, (v_defect->>'type_id')::bigint,
                    (v_defect->>'location_id')::bigint, (v_defect->>'quantity')::integer)
            returning id into v_log_id;
            v_defect_ids := v_defect_ids || pg_catalog.jsonb_build_array(v_log_id);
            v_defect_manifest := v_defect_manifest || pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object('id', v_log_id, 'quantity', (v_defect->>'quantity')::integer,
                    'type_id', (v_defect->>'type_id')::bigint, 'location_id', (v_defect->>'location_id')::bigint));
        end loop;
        v_manifest := v_manifest || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'source_row', v_row_number, 'production_id', v_production_id,
            'wo_id', (v_row->>'wo_id')::bigint, 'wo_number', v_row->>'wo_number',
            'side', v_side, 'model_name', v_row->>'model_name',
            'good_qty', v_good, 'ng_qty', v_ng, 'input_qty', v_input,
            'defect_file_name', v_row->>'defect_file_name',
            'defect_log_ids', v_defect_ids, 'defects', v_defect_manifest));
    end loop;
    update public.smt_report_upload_batches set row_manifest = v_manifest where id = v_batch.id;
    return pg_catalog.jsonb_build_object('ok', true, 'duplicate', false,
        'batch_id', v_batch.id, 'row_count', pg_catalog.jsonb_array_length(v_manifest));
end;
$$;

create or replace function public.smt_list_report_uploads(p_limit integer default 100, p_offset integer default 0)
returns setof public.smt_report_upload_batches
language plpgsql stable security definer set search_path = '' as $$
begin
    if dashboard_private.current_account_id() is null then
        raise sqlstate 'PT401' using message = '請先登入後再讀取 SMT 上傳清單';
    end if;
    return query select b.* from public.smt_report_upload_batches b
      order by b.uploaded_at desc, b.id desc
      limit greatest(1, least(coalesce(p_limit, 100), 500))
      offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

create or replace function public.smt_delete_report_upload(p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_batch public.smt_report_upload_batches;
    v_row jsonb;
    v_expected_defect jsonb;
begin
    if dashboard_private.current_account_id() is null then
        raise sqlstate 'PT401' using message = '請先登入後再刪除 SMT 上傳資料';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('smt-report-upload', 0));
    select * into v_batch from public.smt_report_upload_batches where id = p_batch_id for update;
    if not found then return pg_catalog.jsonb_build_object('ok', true, 'deleted', false); end if;

    -- Refuse to remove a batch if any production/defect row has been edited or removed.
    for v_row in select value from pg_catalog.jsonb_array_elements(v_batch.row_manifest) loop
        if exists(select 1 from public.daily_production p where p.id = (v_row->>'production_id')::bigint)
           and not exists(select 1 from public.daily_production p
                where p.id = (v_row->>'production_id')::bigint
                  and p.wo_id = (v_row->>'wo_id')::bigint
                  and p.production_date = v_batch.production_date
                  and p.input_quantity = (v_row->>'input_qty')::integer
                  and p.line = 'SMT') then
            raise exception '工單 % 的報工資料已變更或不存在；為避免誤刪，請逐筆處理', v_row->>'wo_number';
        end if;
        if exists(select 1 from public.daily_production p where p.id = (v_row->>'production_id')::bigint)
           and (select pg_catalog.count(*) from public.defect_logs d
             where d.production_id = (v_row->>'production_id')::bigint)
           <> pg_catalog.jsonb_array_length(coalesce(v_row->'defects','[]'::jsonb)) then
            raise exception '工單 % 的不良明細已變更；為避免誤刪，請逐筆處理', v_row->>'wo_number';
        end if;
        if not exists(select 1 from public.daily_production p where p.id = (v_row->>'production_id')::bigint)
           and exists(select 1 from public.defect_logs d
             where d.production_id = (v_row->>'production_id')::bigint
               and not (coalesce(v_row->'defect_log_ids','[]'::jsonb) @> pg_catalog.jsonb_build_array(d.id))) then
            raise exception '工單 % 尚有未識別的不良明細；為避免誤刪，請逐筆處理', v_row->>'wo_number';
        end if;
        for v_expected_defect in select value from pg_catalog.jsonb_array_elements(coalesce(v_row->'defects','[]'::jsonb)) loop
            if exists(select 1 from public.defect_logs d where d.id = (v_expected_defect->>'id')::bigint)
               and not exists(select 1 from public.defect_logs d
                where d.id = (v_expected_defect->>'id')::bigint
                  and d.production_id = (v_row->>'production_id')::bigint
                  and d.quantity = (v_expected_defect->>'quantity')::integer
                  and d.defect_type_id = (v_expected_defect->>'type_id')::bigint
                  and d.location_id = (v_expected_defect->>'location_id')::bigint) then
                raise exception '工單 % 的不良明細已變更；為避免誤刪，請逐筆處理', v_row->>'wo_number';
            end if;
        end loop;
    end loop;

    delete from public.defect_logs d where d.production_id in
        (select (value->>'production_id')::bigint from pg_catalog.jsonb_array_elements(v_batch.row_manifest));
    delete from public.daily_production p where p.id in
        (select (value->>'production_id')::bigint from pg_catalog.jsonb_array_elements(v_batch.row_manifest));
    delete from public.smt_report_upload_batches where id = p_batch_id;
    return pg_catalog.jsonb_build_object('ok', true, 'deleted', true);
end;
$$;

revoke all on function public.smt_publish_report_upload(text, text, date, jsonb) from public, anon, authenticated;
revoke all on function public.smt_list_report_uploads(integer, integer) from public, anon, authenticated;
revoke all on function public.smt_delete_report_upload(uuid) from public, anon, authenticated;
grant execute on function public.smt_publish_report_upload(text, text, date, jsonb) to anon, authenticated;
grant execute on function public.smt_list_report_uploads(integer, integer) to anon, authenticated;
grant execute on function public.smt_delete_report_upload(uuid) to anon, authenticated;
commit;
