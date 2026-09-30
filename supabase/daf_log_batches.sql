-- DAF 檔案統計共用資料表
-- 初次建表及更新檔案原子覆蓋功能時，在 Supabase SQL Editor 執行；可重複執行。

create table if not exists public.daf_log_batches (
    id text primary key,
    line text not null default 'DAF',
    file_name text not null,
    uploaded_at timestamptz not null default now(),
    model_name text,
    product_code text,
    work_order text,
    report_date text,
    date_start text,
    date_end text,
    input_count integer not null default 0,
    good_count integer not null default 0,
    fail_count integer not null default 0,
    yield_rate numeric not null default 0,
    defect_rate numeric not null default 0,
    unknown_status_count integer not null default 0,
    unknown_status_text text,
    row_count integer not null default 0,
    raw_column_count integer not null default 10,
    records jsonb not null default '[]'::jsonb
);

create index if not exists daf_log_batches_line_uploaded_idx
    on public.daf_log_batches (line, uploaded_at desc);

alter table public.daf_log_batches disable row level security;
grant select, insert, update, delete
on public.daf_log_batches
to anon, authenticated;

-- 同名檔案覆蓋使用單一資料庫交易，避免刪除舊檔後新檔寫入失敗。
create or replace function public.replace_daf_log_file_atomic(
    p_file_name text,
    p_delete_ids text[],
    p_rows jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
    if nullif(trim(p_file_name), '') is null then
        raise exception 'file_name is required';
    end if;

    delete from public.daf_log_batches
    where line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
      and file_name = p_file_name;

    delete from public.daf_log_batches
    where line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
      and id = any(coalesce(p_delete_ids, array[]::text[]));

    insert into public.daf_log_batches (
        id, line, file_name, uploaded_at, model_name, product_code, work_order,
        report_date, date_start, date_end, input_count, good_count, fail_count,
        yield_rate, defect_rate, unknown_status_count, unknown_status_text,
        row_count, raw_column_count, records
    )
    select
        row_data.id, row_data.line, row_data.file_name, row_data.uploaded_at,
        row_data.model_name, row_data.product_code, row_data.work_order,
        row_data.report_date, row_data.date_start, row_data.date_end,
        row_data.input_count, row_data.good_count, row_data.fail_count,
        row_data.yield_rate, row_data.defect_rate, row_data.unknown_status_count,
        row_data.unknown_status_text, row_data.row_count, row_data.raw_column_count,
        coalesce(row_data.records, '[]'::jsonb)
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as row_data (
        id text, line text, file_name text, uploaded_at timestamptz,
        model_name text, product_code text, work_order text, report_date text,
        date_start text, date_end text, input_count integer, good_count integer,
        fail_count integer, yield_rate numeric, defect_rate numeric,
        unknown_status_count integer, unknown_status_text text, row_count integer,
        raw_column_count integer, records jsonb
    )
    on conflict (id) do update set
        line = excluded.line,
        file_name = excluded.file_name,
        uploaded_at = excluded.uploaded_at,
        model_name = excluded.model_name,
        product_code = excluded.product_code,
        work_order = excluded.work_order,
        report_date = excluded.report_date,
        date_start = excluded.date_start,
        date_end = excluded.date_end,
        input_count = excluded.input_count,
        good_count = excluded.good_count,
        fail_count = excluded.fail_count,
        yield_rate = excluded.yield_rate,
        defect_rate = excluded.defect_rate,
        unknown_status_count = excluded.unknown_status_count,
        unknown_status_text = excluded.unknown_status_text,
        row_count = excluded.row_count,
        raw_column_count = excluded.raw_column_count,
        records = excluded.records;

    return true;
end;
$$;

grant execute on function public.replace_daf_log_file_atomic(text, text[], jsonb)
to anon, authenticated;

notify pgrst, 'reload schema';
