-- Failed uploads own no visible data. Keep only a small failed-job tombstone
-- so delayed/retried start requests cannot recreate a cancelled upload.
begin;
alter table public.daf_log_import_jobs
    add column if not exists last_activity_at timestamptz not null default now();

create or replace function public.guard_daf_import_chunk_job()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_status text;
begin
    select status into v_status from public.daf_log_import_jobs
    where id=NEW.job_id for update;
    if not found or v_status <> 'receiving' then
        raise exception 'upload job is not receiving';
    end if;
    update public.daf_log_import_jobs set last_activity_at=now() where id=NEW.job_id;
    return NEW;
end;
$$;
drop trigger if exists guard_daf_import_chunk_job on public.daf_log_import_chunks;
create trigger guard_daf_import_chunk_job before insert on public.daf_log_import_chunks
for each row execute function public.guard_daf_import_chunk_job();

create or replace function public.daf_abort_log_import(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path=public
set statement_timeout='55s' as $$
declare v_job public.daf_log_import_jobs%rowtype;
begin
    select * into v_job from public.daf_log_import_jobs where id=p_job_id for update;
    if not found then
        -- A timed-out start may still arrive after cancellation. Reserve its UUID
        -- without retaining any uploaded data, so it cannot start again later.
        insert into public.daf_log_import_jobs(id,file_name,status,error_text,superseded_at)
        values(p_job_id,'__cancelled__','failed','上傳未完成，暫存已清除',now())
        on conflict(id) do nothing;
        select * into v_job from public.daf_log_import_jobs where id=p_job_id for update;
    end if;
    -- Publication locks the same job: a lost success response must never delete it.
    if v_job.status='published' then
        return jsonb_build_object('published',true,'accepted_count',v_job.accepted_count,
            'duplicate_count',v_job.duplicate_count);
    end if;
    if v_job.status not in ('receiving','failed')
       or exists(select 1 from public.daf_log_active_file_processes where job_id=p_job_id)
       or exists(select 1 from public.daf_log_winners where job_id=p_job_id)
       or exists(select 1 from public.daf_log_compact_facts
           where candidate_id >= p_job_id::text || ':' and candidate_id < p_job_id::text || ';') then
        raise exception '此上傳工作已有正式或歷史資料，拒絕清除';
    end if;
    delete from public.daf_log_candidates where job_id=p_job_id;
    delete from public.daf_log_import_chunks where job_id=p_job_id;
    update public.daf_log_import_jobs
    set status='failed',metadata='[]'::jsonb,base_heads='{}'::jsonb,
        expected_chunks=0,accepted_count=0,duplicate_count=0,
        error_text='上傳未完成，暫存已清除',superseded_at=now(),last_activity_at=now()
    where id=p_job_id;
    return jsonb_build_object('cleared',true);
end;
$$;

create or replace function public.daf_prune_failed_log_imports()
returns integer language plpgsql security definer set search_path=public
set statement_timeout='55s' as $$
declare v_job record; v_count integer:=0;
begin
    -- Only inactive jobs; never remove a job currently writing/publishing.
    for v_job in
        select j.id from public.daf_log_import_jobs j
        where (j.status='receiving' and j.last_activity_at < now()-interval '24 hours')
           or (j.status='failed' and (j.metadata <> '[]'::jsonb
               or exists(select 1 from public.daf_log_candidates c where c.job_id=j.id)
               or exists(select 1 from public.daf_log_import_chunks c where c.job_id=j.id)))
        order by j.last_activity_at limit 10 for update skip locked
    loop
        perform public.daf_abort_log_import(v_job.id);
        v_count:=v_count+1;
    end loop;
    -- Empty tombstones are not LOG data; expire them after delayed clients are gone.
    delete from public.daf_log_import_jobs j
    where j.status='failed' and j.last_activity_at < now()-interval '30 days'
      and not exists(select 1 from public.daf_log_candidates c where c.job_id=j.id)
      and not exists(select 1 from public.daf_log_import_chunks c where c.job_id=j.id)
      and not exists(select 1 from public.daf_log_active_file_processes h where h.job_id=j.id)
      and not exists(select 1 from public.daf_log_compact_facts f
          where f.candidate_id >= j.id::text || ':' and f.candidate_id < j.id::text || ';');
    return v_count;
end;
$$;
revoke all on function public.guard_daf_import_chunk_job(),
    public.daf_prune_failed_log_imports(),public.daf_abort_log_import(uuid)
from public,anon,authenticated;
grant execute on function public.daf_abort_log_import(uuid) to anon,authenticated;

do $$
declare v_id bigint;
begin
    for v_id in select jobid from cron.job where jobname='koya-daf-failed-import-cleanup'
    loop perform cron.unschedule(v_id); end loop;
    perform cron.schedule('koya-daf-failed-import-cleanup','*/5 * * * *',
        'select public.daf_prune_failed_log_imports();');
end;
$$;
notify pgrst,'reload schema';
commit;
