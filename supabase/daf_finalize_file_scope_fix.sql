-- Reuse (line,file_name) indexes; never change winner ordering or publication semantics.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '20s';
do $migration$
declare definition text; old_predicate text;
begin
    select pg_get_functiondef('public.daf_finalize_log_import(uuid)'::regprocedure) into definition;
    if position('-- file-scope index lookup v1' in definition)>0 then return; end if;
    old_predicate := 'from public.daf_log_winners where file_name=v_job.file_name';
    if (length(definition)-length(replace(definition,old_predicate,'')))/length(old_predicate) <> 3 then
        raise exception 'Unexpected finalize file lookup definition; no changes applied';
    end if;
    definition := replace(definition,old_predicate,
        old_predicate||' and line in (''DAF'',''FT1'',''FT2'',''LIGHTING'',''ASSEMBLY'')');
    definition := replace(definition, '    v_job public.daf_log_import_jobs%rowtype;',
        '    -- file-scope index lookup v1'||chr(10)||'    v_job public.daf_log_import_jobs%rowtype;');
    execute definition;
end;
$migration$;
notify pgrst, 'reload schema';
commit;
