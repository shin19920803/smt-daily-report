-- Atomic deletion; reuse indexed job/file/key access, never scan candidates by filename.
begin;
set local lock_timeout='5s';
set local statement_timeout='20s';
create or replace function public.daf_delete_log_file(p_file_name text)
returns boolean language plpgsql security definer
set search_path=public set jit=off set statement_timeout='55s' set lock_timeout='5s'
as $$
declare v_pairs jsonb; v_line text;
begin
    if nullif(trim(p_file_name),'') is null then return false; end if;
    perform pg_advisory_xact_lock(hashtextextended(p_file_name,92741));
    -- Same filename -> sorted process locks as publication, acquired before snapshots.
    for v_line in select unnest(array['ASSEMBLY','DAF','FT1','FT2','LIGHTING']) loop
        perform pg_advisory_xact_lock(hashtextextended(v_line,92742));
    end loop;
    create temporary table _daf_file_delete_keys(line text,dedup_key text,primary key(line,dedup_key)) on commit drop;
    create temporary table _daf_file_delete_pairs(line text,file_name text,primary key(line,file_name)) on commit drop;
    insert into _daf_file_delete_pairs
        select unnest(array['DAF','FT1','FT2','LIGHTING','ASSEMBLY']),p_file_name;
    insert into _daf_file_delete_keys
        select line,dedup_key from public.daf_log_winners
        where line in ('DAF','FT1','FT2','LIGHTING','ASSEMBLY') and file_name=p_file_name and dedup_key is not null;
    analyze pg_temp._daf_file_delete_keys;
    insert into _daf_file_delete_pairs
        select distinct w.line,w.file_name from public.daf_log_winners w
        join _daf_file_delete_keys k using(line,dedup_key) on conflict do nothing;
    -- Existing archive and maintenance triggers remain active.
    delete from public.daf_log_active_file_processes
        where line in ('DAF','FT1','FT2','LIGHTING','ASSEMBLY') and file_name=p_file_name;
    delete from public.daf_log_winners
        where line in ('DAF','FT1','FT2','LIGHTING','ASSEMBLY') and file_name=p_file_name;
    delete from public.daf_log_winners w using _daf_file_delete_keys k
        where w.line=k.line and w.dedup_key=k.dedup_key;
    insert into public.daf_log_winners(candidate_id,line,dedup_key,file_name,job_id)
    select picked.id,picked.line,picked.dedup_key,picked.file_name,picked.job_id
    from _daf_file_delete_keys k cross join lateral (
        select c.id,c.line,c.dedup_key,c.file_name,c.job_id
        from public.daf_log_candidates c join public.daf_log_active_file_processes h
          on h.line=c.line and h.file_name=c.file_name and h.job_id=c.job_id
        where c.line=k.line and c.dedup_key=k.dedup_key
        order by c.dedup_time asc nulls last,c.created_at asc,c.id asc limit 1
    ) picked;
    insert into _daf_file_delete_pairs
        select distinct w.line,w.file_name from public.daf_log_winners w
        join _daf_file_delete_keys k using(line,dedup_key) on conflict do nothing;
    update public.daf_log_import_jobs j set status='superseded',superseded_at=now()
        where j.file_name=p_file_name and j.status='published'
          and not exists(select 1 from public.daf_log_active_file_processes h where h.job_id=j.id);
    select coalesce(jsonb_agg(jsonb_build_object('line',line,'file_name',file_name)),'[]'::jsonb)
        into v_pairs from _daf_file_delete_pairs;
    perform public.refresh_daf_log_batch_summaries(v_pairs);
    return true;
end;
$$;
revoke all on function public.daf_delete_log_file(text) from public;
grant execute on function public.daf_delete_log_file(text) to anon,authenticated;
-- Internal heads are deliberately not readable directly by browser roles.
create or replace function public.daf_log_file_exists(p_file_name text)
returns boolean language plpgsql security definer stable set search_path=''
as $$
begin
    if coalesce((select enabled from dashboard_private.access_settings where id),false)
       and dashboard_private.current_account_id() is null then
        raise sqlstate 'PT401' using message='請先登入';
    end if;
    return exists(select 1 from public.daf_log_active_file_processes
        where line in ('DAF','FT1','FT2','LIGHTING','ASSEMBLY') and file_name=p_file_name)
       or exists(select 1 from public.daf_log_batches
        where line in ('DAF','FT1','FT2','LIGHTING','ASSEMBLY') and file_name=p_file_name);
end;
$$;
revoke all on function public.daf_log_file_exists(text) from public;
grant execute on function public.daf_log_file_exists(text) to anon,authenticated;
notify pgrst,'reload schema';
commit;
