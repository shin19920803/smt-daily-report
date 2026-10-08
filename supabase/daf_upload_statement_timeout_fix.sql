-- Let each idempotent staged upload chunk use a bounded timeout above Supabase's
-- short default API timeout. Existing jobs/chunk indexes remain resumable.
do $$
begin
    if to_regprocedure('public.daf_stage_log_import_chunk(uuid,text,integer,text,jsonb)') is null then
        raise exception '五大製程分批上傳函式不存在；未套用逾時修正';
    end if;
end;
$$;

alter function public.daf_stage_log_import_chunk(uuid, text, integer, text, jsonb)
    set statement_timeout = '55s';

select p.proname, p.proconfig
from pg_proc p
where p.oid = 'public.daf_stage_log_import_chunk(uuid,text,integer,text,jsonb)'::regprocedure;
