-- DAF 檔案統計共用資料表
-- 需要跨電腦共用 DAF 上傳結果時，在 Supabase SQL Editor 執行一次。

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

notify pgrst, 'reload schema';
