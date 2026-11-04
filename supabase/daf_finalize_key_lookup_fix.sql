-- Bound winner selection to affected keys. Preserve ordering, locks and publication transaction.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '20s';
do $migration$
declare definition text; old_query text; start_at integer; stop_at integer;
begin
    select pg_get_functiondef('public.daf_finalize_log_import(uuid)'::regprocedure) into definition;
    if position('-- affected-key lateral lookup v1' in definition) > 0 then return; end if;
    start_at := position('    select picked.id,picked.line,picked.dedup_key,picked.file_name,picked.job_id from (' in definition);
    if start_at = 0 then raise exception 'Unexpected winner selection; migration cancelled'; end if;
    stop_at := position('    insert into public.daf_log_winners' in substring(definition from start_at));
    if stop_at = 0 then raise exception 'Unexpected winner selection boundary'; end if;
    old_query := substring(definition from start_at for stop_at - 1);
    if position('select distinct on(c.line,c.dedup_key)' in old_query) = 0
       or position('order by c.line,c.dedup_key,c.dedup_time asc nulls last,c.created_at asc,c.id asc' in old_query) = 0 then
        raise exception 'Unexpected dedup order; migration cancelled';
    end if;
    definition := replace(definition, old_query, $replacement$
    -- affected-key lateral lookup v1
    select picked.id,picked.line,picked.dedup_key,picked.file_name,picked.job_id
    from _daf_import_keys k
    cross join lateral (
        select c.id,c.line,c.dedup_key,c.file_name,c.job_id
        from public.daf_log_candidates c
        join public.daf_log_active_file_processes h
          on h.line=c.line and h.file_name=c.file_name and h.job_id=c.job_id
        where c.line=k.line and c.dedup_key=k.dedup_key
          and not exists(select 1 from public.daf_log_compact_e_keys e where e.line=c.line and e.dedup_key=c.dedup_key)
          and not exists(select 1 from public.daf_log_compact_facts f where f.line=c.line and f.dedup_key=c.dedup_key)
        order by c.dedup_time asc nulls last,c.created_at asc,c.id asc
        limit 1
    ) picked;
$replacement$);
    execute definition;
end;
$migration$;
notify pgrst, 'reload schema';
commit;
