-- Plan-only changes: preserve atomic publication, locks, retention and all counts.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '20s';
do $migration$
declare
    definition text;
begin
    select pg_get_functiondef('public.daf_finalize_log_import(uuid)'::regprocedure) into definition;
    if position('analyze pg_temp._daf_import_keys;' in definition) = 0 then
        if position('for v_lock in' in definition) = 0 then
            raise exception 'Unexpected finalize definition; no changes applied';
        end if;
        definition := replace(definition, 'for v_lock in',
            'analyze pg_temp._daf_import_keys; analyze pg_temp._daf_import_old_jobs; for v_lock in');
        execute definition;
    end if;
    -- Large estimated join costs must not trigger compilation on every upload.
    alter function public.daf_finalize_log_import(uuid) set jit = off;

    select pg_get_functiondef('public.refresh_daf_log_batch_summaries(jsonb)'::regprocedure) into definition;
    if position('join targets scoped' in definition) = 0 then
        if position('from public.daf_log_winners w join public.daf_log_candidates c on c.id=w.candidate_id' in definition) = 0
           or position('from public.daf_log_compact_facts f' in definition) = 0
           or position('from public.daf_log_compact_groups g' in definition) = 0 then
            raise exception 'Unexpected summary definition; no changes applied';
        end if;
        definition := replace(definition,
            'from public.daf_log_winners w join public.daf_log_candidates c on c.id=w.candidate_id',
            'from public.daf_log_winners w join targets scoped on scoped.line=w.line and scoped.file_name=w.file_name join public.daf_log_candidates c on c.id=w.candidate_id');
        definition := replace(definition, 'from public.daf_log_compact_facts f',
            'from public.daf_log_compact_facts f join targets scoped on scoped.line=f.line and scoped.file_name=f.file_name');
        definition := replace(definition, 'from public.daf_log_compact_groups g',
            'from public.daf_log_compact_groups g join targets scoped on scoped.line=g.line and scoped.file_name=g.file_name');
        execute definition;
    end if;
    alter function public.refresh_daf_log_batch_summaries(jsonb) set jit = off;
end;
$migration$;
notify pgrst, 'reload schema';
commit;
