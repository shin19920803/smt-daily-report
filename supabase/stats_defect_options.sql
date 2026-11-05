-- Return only historical defect labels that currently contribute to a dashboard.
-- The function is read-only; the Cloudflare Worker caches by process and the
-- existing data-cache invalidation route clears these entries after writes.
begin;
set local statement_timeout = '30s';

create or replace function public.dashboard_stats_defect_options(p_line text)
returns table(name text)
language sql
stable
security definer
set search_path = ''
as $$
    with access_check(allowed) as (
        select not coalesce((select enabled from dashboard_private.access_settings where id), false)
            or dashboard_private.current_account_id() is not null
    ), requested(line) as (
        select upper(btrim(coalesce(p_line, '')))
        from access_check
        where allowed
          and upper(btrim(coalesce(p_line, ''))) in
            ('SMT', 'ASSY', 'DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
    ), raw_names(name) as (
        -- SMT: only defect types referenced by a positive, saved defect log.
        select dt.name
        from requested r
        join public.daily_production p on p.line = r.line
        join public.defect_logs d on d.production_id = p.id and d.quantity > 0
        join public.defect_types dt on dt.id = d.defect_type_id
        where r.line = 'SMT'

        union all

        -- Mylar: legacy batches store compact dashboard buckets as JSON.
        select t.defect_name
        from requested r
        join public.assembly_log_batches b on b.line = r.line
        cross join lateral jsonb_each(
            case when jsonb_typeof(b.buckets) = 'object' then b.buckets else '{}'::jsonb end
        ) as day_bucket(report_date, bucket)
        cross join lateral jsonb_each(
            case when jsonb_typeof(day_bucket.bucket->'byType') = 'object'
                 then day_bucket.bucket->'byType' else '{}'::jsonb end
        ) as t(defect_name, qty)
        where r.line = 'ASSY'
          and coalesce(t.qty #>> '{}', '') ~ '^\d+(\.\d+)?$'
          and (t.qty #>> '{}')::numeric > 0

        union all

        select t.defect_name
        from requested r
        join public.assembly_log_batches b on b.line = r.line
        cross join lateral jsonb_each(
            case when jsonb_typeof(b.buckets) = 'object' then b.buckets else '{}'::jsonb end
        ) as day_bucket(report_date, bucket)
        cross join lateral jsonb_each(
            case when jsonb_typeof(day_bucket.bucket->'hourlyByType') = 'object'
                 then day_bucket.bucket->'hourlyByType' else '{}'::jsonb end
        ) as t(defect_name, hours)
        cross join lateral jsonb_each(
            case when jsonb_typeof(t.hours) = 'object' then t.hours else '{}'::jsonb end
        ) as hour_bucket(hour, qty)
        where r.line = 'ASSY'
          and coalesce(hour_bucket.qty #>> '{}', '') ~ '^\d+(\.\d+)?$'
          and (hour_bucket.qty #>> '{}')::numeric > 0

        union all

        select nullif(btrim(event.value->>'category'), '')
        from requested r
        join public.assembly_log_batches b on b.line = r.line
        cross join lateral jsonb_each(
            case when jsonb_typeof(b.buckets) = 'object' then b.buckets else '{}'::jsonb end
        ) as day_bucket(report_date, bucket)
        cross join lateral jsonb_array_elements(
            case when jsonb_typeof(day_bucket.bucket->'events') = 'array'
                 then day_bucket.bucket->'events' else '[]'::jsonb end
        ) as event(value)
        where r.line = 'ASSY'
          and event.value->>'type' = 'NG'

        union all

        -- The current winner set plus both compact historical representations.
        select coalesce(nullif(btrim(c.defect), ''),
            case when c.line = 'FT2' then '偵測失效' else '未填寫不良原因' end)
        from requested r
        join public.daf_log_candidates c on c.line = r.line
        join public.daf_log_winners w on w.candidate_id = c.id and w.line = c.line
        where r.line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
          and c.status = 'FAIL'

        union all

        select coalesce(nullif(btrim(f.defect), ''),
            case when f.line = 'FT2' then '偵測失效' else '未填寫不良原因' end)
        from requested r
        join public.daf_log_compact_facts f on f.line = r.line
        where r.line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
          and f.status = 'FAIL'

        union all

        select coalesce(nullif(btrim(g.defect), ''),
            case when g.line = 'FT2' then '偵測失效' else '未填寫不良原因' end)
        from requested r
        join public.daf_log_compact_groups g on g.line = r.line
        where r.line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')
          and g.quantity > 0
          and g.status = 'FAIL'
    )
    select distinct btrim(raw_names.name) as name
    from raw_names
    where nullif(btrim(raw_names.name), '') is not null
    order by 1;
$$;

revoke all on function public.dashboard_stats_defect_options(text) from public;
grant execute on function public.dashboard_stats_defect_options(text) to anon, authenticated;

comment on function public.dashboard_stats_defect_options(text) is
    'Returns distinct non-empty defect labels with positive dashboard data for exactly one process line; read-only.';

notify pgrst, 'reload schema';
commit;
