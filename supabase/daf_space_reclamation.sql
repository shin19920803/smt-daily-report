-- Administrative write barrier for physical reclamation; report reads stay enabled.
begin;
set local lock_timeout = '5s';
create table if not exists public.daf_log_reclamation_state (
    id text primary key check (id = 'current'),
    active boolean not null default false,
    started_at timestamptz,
    updated_at timestamptz not null default now()
);
insert into public.daf_log_reclamation_state(id) values ('current') on conflict do nothing;
alter table public.daf_log_reclamation_state enable row level security;
revoke all on public.daf_log_reclamation_state from public, anon, authenticated;

create or replace function public.guard_daf_space_reclamation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if exists (select 1 from public.daf_log_reclamation_state where id='current' and active) then
        raise exception using errcode='55000',
            message='五大製程資料庫正在回收空間，請稍後再上傳或刪除；既有資料仍保留';
    end if;
    return null;
end;
$$;

do $$
declare v_table text;
begin
    foreach v_table in array array[
        'daf_log_import_jobs','daf_log_import_chunks','daf_log_candidates',
        'daf_log_winners','daf_log_compact_facts','daf_log_compact_groups',
        'daf_log_compact_e_keys','daf_log_batches',
        'daf_log_active_file_processes','daf_log_compacted_files','daf_log_compaction_state'
    ] loop
        execute format('drop trigger if exists guard_daf_space_reclamation on public.%I',v_table);
        execute format('create trigger guard_daf_space_reclamation before insert or update or delete or truncate on public.%I for each statement execute function public.guard_daf_space_reclamation()',v_table);
    end loop;
end;
$$;

create or replace function public.daf_begin_space_reclamation()
returns void language plpgsql security definer set search_path=public as $$
begin
    -- Drain writers before exposing the barrier, rather than checking receiving once.
    lock table public.daf_log_import_jobs, public.daf_log_import_chunks,
        public.daf_log_candidates, public.daf_log_winners, public.daf_log_compact_facts,
        public.daf_log_compact_groups, public.daf_log_compact_e_keys,
        public.daf_log_batches, public.daf_log_active_file_processes,
        public.daf_log_compacted_files, public.daf_log_compaction_state
        in share row exclusive mode;
    if exists (select 1 from public.daf_log_import_jobs where status='receiving') then
        raise exception '仍有接收中的上傳工作，尚未啟動空間回收';
    end if;
    if exists (select 1 from public.daf_log_reclamation_state where id='current' and active) then
        raise exception '已有空間回收程序；請先確認該程序狀態';
    end if;
    update public.daf_log_reclamation_state
       set active=true, started_at=now(), updated_at=now() where id='current';
end;
$$;

create or replace function public.daf_end_space_reclamation()
returns void language sql security definer set search_path=public as $$
    update public.daf_log_reclamation_state set active=false, updated_at=now() where id='current';
$$;
revoke all on function public.guard_daf_space_reclamation(),
    public.daf_begin_space_reclamation(),public.daf_end_space_reclamation()
    from public,anon,authenticated;
-- Reuse released pages promptly during normal 14-day upload/deletion churn.
alter table public.daf_log_candidates set (
    autovacuum_vacuum_scale_factor=0.02, autovacuum_vacuum_threshold=1000
);
alter table public.daf_log_winners set (
    autovacuum_vacuum_scale_factor=0.02, autovacuum_vacuum_threshold=1000
);
commit;
