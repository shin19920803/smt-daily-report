-- Allow chunks in one upload to stage concurrently while excluding abort/finalize.
begin;
create or replace function public.guard_daf_import_chunk_job()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_status text;
begin
    select status into v_status from public.daf_log_import_jobs
    where id=NEW.job_id for share;
    if not found or v_status <> 'receiving' then
        raise exception 'upload job is not receiving';
    end if;
    return NEW;
end;
$$;
drop trigger if exists guard_daf_import_chunk_job on public.daf_log_import_chunks;
create trigger guard_daf_import_chunk_job before insert on public.daf_log_import_chunks
for each row execute function public.guard_daf_import_chunk_job();

create or replace function public.daf_prune_failed_log_imports()
returns integer language plpgsql security definer set search_path=public
set statement_timeout='55s' as $$
declare v_job record; v_count integer:=0;
begin
    -- Chunk timestamps count as activity without serializing parallel writes on
    -- the job row; clean only receiving jobs that have truly gone idle for 24h.
    for v_job in
        select j.id from public.daf_log_import_jobs j
        where (j.status='receiving' and j.last_activity_at < now()-interval '24 hours'
            and not exists(select 1 from public.daf_log_import_chunks c
                where c.job_id=j.id and c.created_at >= now()-interval '24 hours'))
           or (j.status='failed' and (j.metadata <> '[]'::jsonb
               or exists(select 1 from public.daf_log_candidates c where c.job_id=j.id)
               or exists(select 1 from public.daf_log_import_chunks c where c.job_id=j.id)))
        order by j.last_activity_at limit 10 for update skip locked
    loop
        perform public.daf_abort_log_import(v_job.id);
        v_count:=v_count+1;
    end loop;
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
notify pgrst,'reload schema';
commit;
