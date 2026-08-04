-- 組裝測試 LOG 共用資料表
-- 請在 Supabase SQL Editor 執行一次，讓不同電腦共用上傳的分析結果。

create table if not exists public.assembly_log_batches (
    id text primary key,
    line text not null default 'ASSY',
    file_name text not null,
    uploaded_at timestamptz not null default now(),
    encoding text,
    line_count integer,
    parsed_line_count integer,
    ignored_count integer,
    unclassified_count integer,
    buckets jsonb not null default '{}'::jsonb
);

create index if not exists assembly_log_batches_line_uploaded_idx
    on public.assembly_log_batches (line, uploaded_at desc);

-- 目前系統使用 Supabase anon key，且既有資料表採用相同的公開 CRUD 模式。
alter table public.assembly_log_batches disable row level security;
grant select, insert, update, delete on public.assembly_log_batches to anon, authenticated;
