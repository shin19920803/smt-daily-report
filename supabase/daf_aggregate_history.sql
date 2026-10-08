-- Store immutable DAF/test-process history as weighted dashboard facts.
-- Install after daf_historical_compaction.sql. This file is additive; the
-- backfill function migrates one atomic batch per call and keeps the old facts
-- until each batch has been verified.

begin;
set local statement_timeout = '120s';

create table if not exists public.daf_log_compact_groups (
    group_id bigserial primary key,
    line text not null check (line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')),
    file_name text not null,
    report_date text not null,
    work_order text not null default '',
    product_code text not null default '',
    model_name text not null default '',
    status text not null default '',
    defect text not null default '',
    machine text not null default '',
    input_included boolean not null default false,
    is_defect boolean not null default false,
    source_format text not null default '',
    created_at timestamptz not null,
    quantity bigint not null check (quantity > 0),
    constraint daf_log_compact_groups_dims_unique unique (
        line, file_name, report_date, work_order, product_code, model_name,
        status, defect, machine, input_included, is_defect, source_format, created_at
    )
);
create index if not exists daf_log_compact_groups_line_date_idx
    on public.daf_log_compact_groups (line, report_date);
create index if not exists daf_log_compact_groups_file_idx
    on public.daf_log_compact_groups (line, file_name);
alter table public.daf_log_compact_groups enable row level security;
revoke all on public.daf_log_compact_groups from public, anon, authenticated;

-- The minimum E-column identity/time/source needed to preserve cross-file
-- earliest-wins comparison and DAF/FT1 machine reclassification. No raw rows.
create table if not exists public.daf_log_compact_e_keys (
    line text not null check (line in ('DAF', 'FT1', 'FT2', 'LIGHTING', 'ASSEMBLY')),
    dedup_key text not null,
    dedup_time bigint,
    file_name text not null,
    group_id bigint not null references public.daf_log_compact_groups(group_id) on delete restrict,
    primary key (line, dedup_key)
);
drop index if exists public.daf_log_compact_e_keys_file_idx;
create index if not exists daf_log_compact_e_keys_group_idx
    on public.daf_log_compact_e_keys (group_id);
alter table public.daf_log_compact_e_keys enable row level security;
revoke all on public.daf_log_compact_e_keys from public, anon, authenticated;

create or replace function public.daf_compact_dashboard_digest(p_cutoff date default null)
returns table(line text, dashboard_digest text, dashboard_quantity bigint, compact_group_count bigint)
language sql security definer stable set search_path = public
as $$
    with records(line,file_name,report_date,work_order,product_code,model_name,status,defect,
                 machine,input_included,is_defect,source_format,quantity) as (
        select c.line, c.file_name, c.report_date,
               coalesce(c.work_order,''), coalesce(c.product_code,''), coalesce(c.model_name,''),
               coalesce(c.status,''), coalesce(c.defect,''), coalesce(c.machine,''),
               c.input_included, c.is_defect, coalesce(c.source_format,''), 1::bigint as quantity
        from public.daf_log_candidates c
        join public.daf_log_winners w on w.candidate_id = c.id
        where p_cutoff is null or (public.daf_is_valid_iso_date(c.report_date) and c.report_date < p_cutoff::text)
        union all
        select f.line, f.file_name, f.report_date,
               coalesce(f.work_order,''), coalesce(f.product_code,''), coalesce(f.model_name,''),
               coalesce(f.status,''), coalesce(f.defect,''), coalesce(f.machine,''),
               f.input_included, f.is_defect, coalesce(f.source_format,''), 1::bigint
        from public.daf_log_compact_facts f
        where p_cutoff is null or (public.daf_is_valid_iso_date(f.report_date) and f.report_date < p_cutoff::text)
        union all
        select g.line, g.file_name, g.report_date, g.work_order, g.product_code, g.model_name,
               g.status, g.defect, g.machine, g.input_included, g.is_defect,
               g.source_format, g.quantity
        from public.daf_log_compact_groups g
        where p_cutoff is null or (public.daf_is_valid_iso_date(g.report_date) and g.report_date < p_cutoff::text)
    ), grouped as (
        select line, file_name, report_date, work_order, product_code, model_name,
               status, defect, machine, input_included, is_defect, source_format,
               sum(quantity)::bigint as quantity
        from records group by line, file_name, report_date, work_order, product_code,
             model_name, status, defect, machine, input_included, is_defect, source_format
    ), digests as (
        select line,
               md5(coalesce(string_agg(md5(to_jsonb(g)::text), '' order by to_jsonb(g)::text), '')) as digest,
               sum(quantity)::bigint as qty
        from grouped g group by line
    ), groups as (
        select line, count(*)::bigint as n from public.daf_log_compact_groups
        where p_cutoff is null or (public.daf_is_valid_iso_date(report_date) and report_date < p_cutoff::text)
        group by line
    ), lines(line) as (values ('DAF'), ('FT1'), ('FT2'), ('LIGHTING'), ('ASSEMBLY'))
    select l.line, coalesce(d.digest, md5('')), coalesce(d.qty,0), coalesce(g.n,0)
    from lines l left join digests d using (line) left join groups g using (line)
    order by l.line;
$$;

-- Resume-safe conversion of the previously structured row store. Upsert the
-- weighted facts and E-key map, check them, then delete only that locked batch.
create or replace function public.daf_migrate_compact_fact_batch(p_batch_size integer default 5000)
returns jsonb language plpgsql security definer set search_path = public
set statement_timeout = '55s' as $$
declare
    v_scanned integer;
    v_key_count integer;
    v_lock_line text;
begin
    if p_batch_size is null or p_batch_size < 1 or p_batch_size > 5000 then
        raise exception '每批筆數須介於 1 至 5000';
    end if;
    for v_lock_line in select line from (values ('DAF'),('FT1'),('FT2'),('LIGHTING'),('ASSEMBLY')) p(line) order by line loop
        perform pg_advisory_xact_lock(hashtextextended(v_lock_line, 92742));
    end loop;
    create temporary table _daf_fact_move on commit drop as
        select f.* from public.daf_log_compact_facts f
        order by f.candidate_id limit p_batch_size;
    select count(*)::integer into v_scanned from _daf_fact_move;
    if v_scanned = 0 then
        return jsonb_build_object('scanned',0,'moved',0,'keys',0,'done',true);
    end if;
    if exists (
        select 1 from _daf_fact_move m
        join public.daf_log_compact_e_keys k using (line,dedup_key)
        where m.dedup_key is not null
    ) then
        raise exception '來源明細的 E 欄鍵已存在於加權索引；為避免重複計數，本批已回滾';
    end if;

    insert into public.daf_log_compact_groups (
        line,file_name,report_date,work_order,product_code,model_name,status,defect,
        machine,input_included,is_defect,source_format,created_at,quantity
    )
    select line,file_name,report_date,coalesce(work_order,''),coalesce(product_code,''),
           coalesce(model_name,''),coalesce(status,''),coalesce(defect,''),coalesce(machine,''),
           input_included,is_defect,coalesce(source_format,''),created_at,count(*)::bigint
    from _daf_fact_move
    group by line,file_name,report_date,coalesce(work_order,''),coalesce(product_code,''),
             coalesce(model_name,''),coalesce(status,''),coalesce(defect,''),coalesce(machine,''),
             input_included,is_defect,coalesce(source_format,''),created_at
    on conflict (line,file_name,report_date,work_order,product_code,model_name,status,defect,
                 machine,input_included,is_defect,source_format,created_at)
    do update set quantity = public.daf_log_compact_groups.quantity + excluded.quantity;

    insert into public.daf_log_compact_e_keys(line,dedup_key,dedup_time,file_name,group_id)
    select m.line, m.dedup_key, m.dedup_time, m.file_name, g.group_id
    from _daf_fact_move m
    join public.daf_log_compact_groups g
      on g.line=m.line and g.file_name=m.file_name and g.report_date=m.report_date
     and g.work_order=coalesce(m.work_order,'') and g.product_code=coalesce(m.product_code,'')
     and g.model_name=coalesce(m.model_name,'') and g.status=coalesce(m.status,'')
     and g.defect=coalesce(m.defect,'') and g.machine=coalesce(m.machine,'')
     and g.input_included=m.input_included and g.is_defect=m.is_defect
     and g.source_format=coalesce(m.source_format,'') and g.created_at=m.created_at
    where m.dedup_key is not null
    on conflict (line,dedup_key) do nothing;
    select count(*)::integer into v_key_count from _daf_fact_move where dedup_key is not null;
    if exists (
        select 1 from _daf_fact_move m
        left join public.daf_log_compact_e_keys k using (line,dedup_key)
        join public.daf_log_compact_groups g on g.group_id=k.group_id
        where m.dedup_key is not null
          and (k.dedup_key is null or k.file_name is distinct from m.file_name
               or k.dedup_time is distinct from m.dedup_time
               or (g.line,g.file_name,g.report_date,g.work_order,g.product_code,g.model_name,
                   g.status,g.defect,g.machine,g.input_included,g.is_defect,g.source_format,g.created_at)
                  is distinct from
                  (m.line,m.file_name,m.report_date,coalesce(m.work_order,''),coalesce(m.product_code,''),
                   coalesce(m.model_name,''),coalesce(m.status,''),coalesce(m.defect,''),coalesce(m.machine,''),
                   m.input_included,m.is_defect,coalesce(m.source_format,''),m.created_at))
    ) then raise exception '歷史 E 欄映射核對失敗；本批已回滾'; end if;
    if (select count(*) from public.daf_log_compact_e_keys k join _daf_fact_move m using(line,dedup_key)) <> v_key_count then
        raise exception '歷史 E 欄映射筆數不一致；本批已回滾';
    end if;
    delete from public.daf_log_compact_facts f using _daf_fact_move m where f.candidate_id=m.candidate_id;
    get diagnostics v_scanned = row_count;
    if v_scanned <> (select count(*) from _daf_fact_move) then raise exception '歷史明細刪除筆數不一致；本批已回滾'; end if;
    return jsonb_build_object('scanned',v_scanned,'moved',v_scanned,'keys',v_key_count,'done',v_scanned < p_batch_size);
end;
$$;

revoke all on function public.daf_compact_dashboard_digest(date),
    public.daf_migrate_compact_fact_batch(integer) from public,anon,authenticated;

commit;

-- Compatibility RPC: compact rows carry quantity; active winners remain quantity 1.
create or replace function public.daf_get_log_process_details(p_line text, p_start text default '', p_end text default '')
returns table (
    id text, line text, file_name text, uploaded_at timestamptz, model_name text,
    product_code text, work_order text, report_date text, date_start text, date_end text,
    input_count integer, good_count integer, fail_count integer, yield_rate numeric,
    defect_rate numeric, unknown_status_count integer, unknown_status_text text,
    row_count integer, raw_column_count integer, records jsonb
)
language sql security definer stable set search_path = public
as $$
    select b.id,b.line,b.file_name,b.uploaded_at,b.model_name,b.product_code,b.work_order,
           b.report_date,b.date_start,b.date_end,b.input_count,b.good_count,b.fail_count,
           b.yield_rate,b.defect_rate,b.unknown_status_count,b.unknown_status_text,
           b.row_count,b.raw_column_count,
           coalesce((
               select jsonb_agg(r.record_json order by r.dedup_time nulls last,r.created_at,r.record_id)
               from (
                   select c.line,c.file_name,c.dedup_time,c.created_at,c.id::text as record_id,
                          c.report_date,public.daf_candidate_to_record(c)||jsonb_build_object('quantity',1) as record_json
                   from public.daf_log_winners w
                   join public.daf_log_candidates c on c.id=w.candidate_id
                   where w.line=b.line and w.file_name=b.file_name
                   union all
                   select f.line,f.file_name,f.dedup_time,f.created_at,f.candidate_id,
                          f.report_date,
                          jsonb_build_object('dedupTime',f.dedup_time,'date',f.report_date,
                              'workOrder',f.work_order,'productCode',f.product_code,'model',f.model_name,
                              'status',f.status,'defect',f.defect,'machine',f.machine,
                              'inputIncluded',f.input_included,'isDefect',f.is_defect,
                              'sourceFormat',f.source_format,'quantity',1,'raw','[]'::jsonb,'compacted',true)
                   from public.daf_log_compact_facts f
                   where f.line=b.line and f.file_name=b.file_name
                   union all
                   select g.line,g.file_name,null::bigint,g.created_at,g.group_id::text,
                          g.report_date,
                          jsonb_build_object('date',g.report_date,'workOrder',g.work_order,
                              'productCode',g.product_code,'model',g.model_name,'status',g.status,
                              'defect',g.defect,'machine',g.machine,'inputIncluded',g.input_included,
                              'isDefect',g.is_defect,'sourceFormat',g.source_format,
                              'quantity',g.quantity,'raw','[]'::jsonb,'compacted',true)
                   from public.daf_log_compact_groups g
                   where g.line=b.line and g.file_name=b.file_name
               ) r
               where (p_start='' or r.report_date>=p_start) and (p_end='' or r.report_date<=p_end)
           ),'[]'::jsonb) as records
    from public.daf_log_batches b
    join public.daf_log_active_file_processes h on h.line=b.line and h.file_name=b.file_name
    where b.line=p_line and p_line in ('DAF','FT1','FT2','LIGHTING','ASSEMBLY')
      and (p_start='' or b.date_end>=p_start) and (p_end='' or b.date_start<=p_end)
    order by b.uploaded_at desc,b.id asc;
$$;

create or replace function public.refresh_daf_log_batch_summaries(p_pairs jsonb)
returns void language plpgsql security definer set search_path = public
as $$
begin
    perform set_config(chr(107) || chr(111) || chr(121) || chr(97) || '.allow_daf_summary_write','on',true);
    delete from public.daf_log_batches b
    using jsonb_to_recordset(coalesce(p_pairs,'[]'::jsonb)) as p(line text,file_name text)
    where b.line=p.line and b.file_name=p.file_name
      and b.line in ('DAF','FT1','FT2','LIGHTING','ASSEMBLY');

    insert into public.daf_log_batches (
        id,line,file_name,uploaded_at,model_name,product_code,work_order,report_date,
        date_start,date_end,input_count,good_count,fail_count,yield_rate,defect_rate,
        unknown_status_count,unknown_status_text,row_count,raw_column_count,records
    )
    with targets as (
        select distinct p.line,p.file_name
        from jsonb_to_recordset(coalesce(p_pairs,'[]'::jsonb)) as p(line text,file_name text)
        where p.line in ('DAF','FT1','FT2','LIGHTING','ASSEMBLY')
    ), facts as (
        select c.line,c.file_name,c.report_date,c.work_order,c.product_code,c.model_name,
               c.status,c.input_included,1::bigint as quantity
        from public.daf_log_winners w join public.daf_log_candidates c on c.id=w.candidate_id
        union all
        select f.line,f.file_name,f.report_date,f.work_order,f.product_code,f.model_name,
               f.status,f.input_included,1::bigint
        from public.daf_log_compact_facts f
        union all
        select g.line,g.file_name,g.report_date,g.work_order,g.product_code,g.model_name,
               g.status,g.input_included,g.quantity
        from public.daf_log_compact_groups g
    ), aggregate_rows as (
        select h.line,h.file_name,h.metadata,h.metadata->>'id' as old_id,h.uploaded_at,
               coalesce(sum(f.quantity),0)::integer as row_count,
               coalesce(sum(f.quantity) filter(where f.input_included),0)::integer as input_count,
               coalesce(sum(f.quantity) filter(where f.input_included and upper(f.status)='GOOD'),0)::integer as good_count,
               coalesce(sum(f.quantity) filter(where f.input_included and upper(f.status)='FAIL'),0)::integer as fail_count,
               coalesce(sum(f.quantity) filter(where f.status<>'' and upper(f.status) not in ('GOOD','FAIL')),0)::integer as unknown_status_count,
               coalesce(string_agg(distinct nullif(f.model_name,''),'、'),h.metadata->>'model_name','未識別機種') as model_name,
               coalesce(string_agg(distinct nullif(f.product_code,''),'、'),h.metadata->>'product_code','未識別產品代碼') as product_code,
               coalesce(string_agg(distinct nullif(f.work_order,''),'、'),h.metadata->>'work_order','未識別工單') as work_order,
               coalesce(string_agg(distinct nullif(f.status,''),'、') filter(where f.status<>'' and upper(f.status) not in ('GOOD','FAIL')),'無') as unknown_status_text,
               coalesce(min(f.report_date) filter(where f.report_date ~ '^\d{4}-\d{2}-\d{2}$'),h.metadata->>'date_start') as date_start,
               coalesce(max(f.report_date) filter(where f.report_date ~ '^\d{4}-\d{2}-\d{2}$'),h.metadata->>'date_end') as date_end,
               coalesce((h.metadata->>'raw_column_count')::integer,10) as raw_column_count
        from targets t join public.daf_log_active_file_processes h using(line,file_name)
        left join facts f using(line,file_name)
        group by h.line,h.file_name,h.metadata,h.uploaded_at
    )
    select coalesce(a.old_id,'dafv2:'||a.line||':'||md5(a.file_name)),a.line,a.file_name,a.uploaded_at,
           a.model_name,a.product_code,a.work_order,
           case when a.date_start is null then coalesce(a.metadata->>'report_date','未識別日期')
                when a.date_start=a.date_end then a.date_start else a.date_start||'～'||a.date_end end,
           a.date_start,a.date_end,a.input_count,a.good_count,a.fail_count,
           case when a.input_count>0 then round(a.good_count::numeric*100/a.input_count,2) else 0 end,
           case when a.input_count>0 then round(a.fail_count::numeric*100/a.input_count,2) else 0 end,
           a.unknown_status_count,a.unknown_status_text,a.row_count,a.raw_column_count,'[]'::jsonb
    from aggregate_rows a;
end;
$$;

create or replace function public.daf_update_machine_classification(p_mappings jsonb)
returns integer language plpgsql security definer set search_path=public
set statement_timeout='55s' as $$
declare
    v_updated_candidates integer:=0;
    v_updated_facts integer:=0;
    v_group_updates integer:=0;
    v_lock_line text;
begin
    for v_lock_line in select line from (values ('DAF'),('FT1')) p(line) order by line loop
        perform pg_advisory_xact_lock(hashtextextended(v_lock_line,92742));
    end loop;
    create temporary table _daf_machine_mapping on commit drop as
    select distinct on (upper(btrim(m.dedup_key))) upper(btrim(m.dedup_key)) as dedup_key,m.machine
    from jsonb_to_recordset(coalesce(p_mappings,'[]'::jsonb)) as m(dedup_key text,machine text)
    where m.machine in ('1號機','2號機') and nullif(btrim(m.dedup_key),'') is not null
    order by upper(btrim(m.dedup_key)),m.machine;

    update public.daf_log_candidates c set machine=m.machine,
           record_json=case when c.record_storage_version=1 then jsonb_set(c.record_json,'{machine}',to_jsonb(m.machine),true) else c.record_json end
    from _daf_machine_mapping m
    where c.line in ('DAF','FT1') and upper(btrim(c.dedup_key))=m.dedup_key and c.machine is distinct from m.machine;
    get diagnostics v_updated_candidates=row_count;

    with mapping as (
        select dedup_key,machine from _daf_machine_mapping
    )
    update public.daf_log_compact_facts f set machine=m.machine
    from mapping m
    where f.line in ('DAF','FT1') and upper(btrim(f.dedup_key))=m.dedup_key
      and f.machine is distinct from m.machine;
    get diagnostics v_updated_facts=row_count;

    create temporary table _daf_machine_move on commit drop as
    select k.line,k.dedup_key,k.group_id as old_group_id,g.file_name,g.report_date,g.work_order,
           g.product_code,g.model_name,g.status,g.defect,g.input_included,g.is_defect,
           g.source_format,g.created_at,m.machine
    from public.daf_log_compact_e_keys k
    join public.daf_log_compact_groups g on g.group_id=k.group_id
    join _daf_machine_mapping m on upper(btrim(k.dedup_key))=m.dedup_key
    where k.line in ('DAF','FT1') and g.machine is distinct from m.machine;
    select count(*)::integer into v_group_updates from _daf_machine_move;
    if v_group_updates>0 then
        insert into public.daf_log_compact_groups (
            line,file_name,report_date,work_order,product_code,model_name,status,defect,
            machine,input_included,is_defect,source_format,created_at,quantity
        )
        select line,file_name,report_date,work_order,product_code,model_name,status,defect,
               machine,input_included,is_defect,source_format,created_at,count(*)::bigint
        from _daf_machine_move
        group by line,file_name,report_date,work_order,product_code,model_name,status,defect,
                 machine,input_included,is_defect,source_format,created_at
        on conflict (line,file_name,report_date,work_order,product_code,model_name,status,defect,
                     machine,input_included,is_defect,source_format,created_at)
        do update set quantity=public.daf_log_compact_groups.quantity+excluded.quantity;

        update public.daf_log_compact_e_keys k set group_id=g.group_id
        from _daf_machine_move m
        join public.daf_log_compact_groups g
          on g.line=m.line and g.file_name=m.file_name and g.report_date=m.report_date
         and g.work_order=m.work_order and g.product_code=m.product_code and g.model_name=m.model_name
         and g.status=m.status and g.defect=m.defect and g.machine=m.machine
         and g.input_included=m.input_included and g.is_defect=m.is_defect
         and g.source_format=m.source_format and g.created_at=m.created_at
        where k.line=m.line and k.dedup_key=m.dedup_key;

        delete from public.daf_log_compact_groups g
        using (select old_group_id,count(*)::bigint as n from _daf_machine_move group by old_group_id) m
        where g.group_id=m.old_group_id and g.quantity<=m.n;
        update public.daf_log_compact_groups g set quantity=g.quantity-m.n
        from (select old_group_id,count(*)::bigint as n from _daf_machine_move group by old_group_id) m
        where g.group_id=m.old_group_id and g.quantity>m.n;
    end if;
    return v_updated_candidates+v_updated_facts+v_group_updates;
end;
$$;

-- The cutoff/locks and pinning rules match the existing maintenance routine;
-- this version writes weighted facts instead of one historical row per unit.
create or replace function public.daf_compact_expired_log_batch(p_cutoff date,p_batch_size integer default 5000)
returns jsonb language plpgsql security definer set search_path=public
set statement_timeout='110s' as $$
declare
    v_cutoff date;
    v_retention_days integer;
    v_allowed_cutoff date;
    v_picked integer;
    v_expected_winners integer;
    v_deleted integer;
    v_unresolved integer;
    v_receiving integer;
    v_pairs jsonb;
    v_lock_line text;
begin
    if p_cutoff is null then raise exception '封存日期不可空白'; end if;
    if p_batch_size is null or p_batch_size<1 or p_batch_size>5000 then raise exception '每批筆數須介於 1 至 5000'; end if;
    for v_lock_line in select line from (values ('DAF'),('FT1'),('FT2'),('LIGHTING'),('ASSEMBLY')) p(line) order by line loop
        perform pg_advisory_xact_lock(hashtextextended(v_lock_line,92742));
    end loop;
    select coalesce(candidate_retention_days,30),cutoff_date
      into v_retention_days,v_cutoff from public.daf_log_compaction_state where id='current';
    if not found then v_retention_days:=30; v_cutoff:=null; end if;
    v_allowed_cutoff:=(now() at time zone 'Asia/Taipei')::date-v_retention_days;
    if p_cutoff>v_allowed_cutoff then
        raise exception '封存截止日必須至少早於今天 % 天（最晚可選 %）',v_retention_days,v_allowed_cutoff;
    end if;
    v_cutoff:=greatest(coalesce(v_cutoff,p_cutoff),p_cutoff);
    if exists (
        select 1 from public.daf_log_import_jobs j
        cross join lateral jsonb_to_recordset(coalesce(j.metadata,'[]'::jsonb)) as m(line text,date_start text,date_end text)
        where j.status='receiving' and m.line in ('DAF','FT1','FT2','LIGHTING','ASSEMBLY')
          and ((public.daf_is_valid_iso_date(m.date_start) and m.date_start<v_cutoff::text)
            or (public.daf_is_valid_iso_date(m.date_end) and m.date_end<v_cutoff::text))
    ) or exists (
        select 1 from public.daf_log_candidates c join public.daf_log_import_jobs j on j.id=c.job_id and j.status='receiving'
        where c.line in ('DAF','FT1','FT2','LIGHTING','ASSEMBLY')
          and public.daf_is_valid_iso_date(c.report_date) and c.report_date<v_cutoff::text
    ) then raise exception '有上傳中的工作涵蓋封存界線以前的日期；本批未推進界線'; end if;

    insert into public.daf_log_compaction_state(id,cutoff_date,candidate_retention_days)
    values ('current',v_cutoff,v_retention_days)
    on conflict(id) do update set cutoff_date=greatest(public.daf_log_compaction_state.cutoff_date,excluded.cutoff_date),updated_at=now();
    select count(*)::integer into v_unresolved
    from public.daf_log_candidates c join public.daf_log_winners w on w.candidate_id=c.id
    where c.line in ('DAF','FT1','FT2','LIGHTING','ASSEMBLY')
      and public.daf_is_valid_iso_date(c.report_date) and c.report_date<v_cutoff::text
      and public.daf_candidate_payload_mismatch(c);
    insert into public.daf_log_compacted_files(line,file_name)
    select distinct c.line,c.file_name from public.daf_log_candidates c
    join public.daf_log_winners w on w.candidate_id=c.id
    where c.line in ('DAF','FT1','FT2','LIGHTING','ASSEMBLY')
      and public.daf_is_valid_iso_date(c.report_date) and c.report_date<v_cutoff::text
      and public.daf_candidate_payload_mismatch(c)
    on conflict(line,file_name) do nothing;

    create temporary table _daf_aggregate_pick on commit drop as
    select c.* from public.daf_log_candidates c
    where public.daf_is_valid_iso_date(c.report_date) and c.report_date<v_cutoff::text
      and not exists(select 1 from public.daf_log_winners w where w.candidate_id=c.id and public.daf_candidate_payload_mismatch(c))
    order by c.line,c.report_date,c.id limit p_batch_size;
    select count(*)::integer into v_picked from _daf_aggregate_pick;
    if v_picked=0 then
        return jsonb_build_object('cutoff_date',v_cutoff,'compacted',0,'removed_candidates',0,
            'deferred_unresolved_rows',v_unresolved,'done',true);
    end if;
    select count(*)::integer into v_receiving
    from _daf_aggregate_pick p join public.daf_log_import_jobs j on j.id=p.job_id and j.status='receiving';
    if v_receiving>0 then raise exception '候選仍屬於上傳中工作，本批封存已取消'; end if;
    if exists (
        select 1 from _daf_aggregate_pick p join public.daf_log_winners w on w.candidate_id=p.id
        join public.daf_log_compact_e_keys k on k.line=p.line and k.dedup_key=p.dedup_key
    ) then raise exception '封存 E 欄鍵已存在於精簡庫；本批取消以避免數量重複'; end if;
    if exists (
        select 1 from _daf_aggregate_pick p join public.daf_log_winners w on w.candidate_id=p.id
        join public.daf_log_compact_facts f on f.line=p.line and f.dedup_key=p.dedup_key
        where p.dedup_key is not null
    ) then raise exception '封存 E 欄鍵已存在於舊精簡表；本批取消以避免數量重複'; end if;
    if exists (
        select 1 from _daf_aggregate_pick p
        join public.daf_log_candidates c on c.id=p.id
        join public.daf_log_winners w on w.candidate_id=p.id
        where public.daf_candidate_payload_mismatch(c)
    ) then raise exception '明細欄位與儲存欄位不一致；本批封存已取消'; end if;

    insert into public.daf_log_compacted_files(line,file_name)
    select distinct p.line,p.file_name from _daf_aggregate_pick p
    where public.daf_is_valid_iso_date(p.report_date)
    on conflict(line,file_name) do nothing;
    select count(*)::integer into v_expected_winners
    from _daf_aggregate_pick p join public.daf_log_winners w on w.candidate_id=p.id;

    insert into public.daf_log_compact_groups (
        line,file_name,report_date,work_order,product_code,model_name,status,defect,
        machine,input_included,is_defect,source_format,created_at,quantity
    )
    select p.line,p.file_name,p.report_date,coalesce(p.work_order,''),coalesce(p.product_code,''),
           coalesce(p.model_name,''),coalesce(p.status,''),coalesce(p.defect,''),coalesce(p.machine,''),
           p.input_included,p.is_defect,coalesce(p.source_format,''),p.created_at,count(*)::bigint
    from _daf_aggregate_pick p join public.daf_log_winners w on w.candidate_id=p.id
    group by p.line,p.file_name,p.report_date,coalesce(p.work_order,''),coalesce(p.product_code,''),
             coalesce(p.model_name,''),coalesce(p.status,''),coalesce(p.defect,''),coalesce(p.machine,''),
             p.input_included,p.is_defect,coalesce(p.source_format,''),p.created_at
    on conflict (line,file_name,report_date,work_order,product_code,model_name,status,defect,
                 machine,input_included,is_defect,source_format,created_at)
    do update set quantity=public.daf_log_compact_groups.quantity+excluded.quantity;

    insert into public.daf_log_compact_e_keys(line,dedup_key,dedup_time,file_name,group_id)
    select p.line,p.dedup_key,p.dedup_time,p.file_name,g.group_id
    from _daf_aggregate_pick p join public.daf_log_winners w on w.candidate_id=p.id
    join public.daf_log_compact_groups g
      on g.line=p.line and g.file_name=p.file_name and g.report_date=p.report_date
     and g.work_order=coalesce(p.work_order,'') and g.product_code=coalesce(p.product_code,'')
     and g.model_name=coalesce(p.model_name,'') and g.status=coalesce(p.status,'')
     and g.defect=coalesce(p.defect,'') and g.machine=coalesce(p.machine,'')
     and g.input_included=p.input_included and g.is_defect=p.is_defect
     and g.source_format=coalesce(p.source_format,'') and g.created_at=p.created_at
    where p.dedup_key is not null;
    if (select count(*) from public.daf_log_compact_e_keys k join _daf_aggregate_pick p using(line,dedup_key)
        join public.daf_log_winners w on w.candidate_id=p.id) <
       (select count(*) from _daf_aggregate_pick p join public.daf_log_winners w on w.candidate_id=p.id and p.dedup_key is not null)
    then raise exception '封存後 E 欄鍵核對失敗；本批已回滾'; end if;

    select coalesce(jsonb_agg(jsonb_build_object('line',line,'file_name',file_name)),'[]'::jsonb)
      into v_pairs from (select distinct line,file_name from _daf_aggregate_pick) p;
    delete from public.daf_log_candidates c using _daf_aggregate_pick p where c.id=p.id;
    get diagnostics v_deleted=row_count;
    if v_deleted<>v_picked then raise exception '封存候選刪除筆數不一致；本批已回滾'; end if;

    perform set_config(chr(107) || chr(111) || chr(121) || chr(97) || '.allow_daf_summary_write','on',true);
    update public.daf_log_batches b
       set records=case when jsonb_typeof(b.records)='array' then coalesce((
           select jsonb_agg(i.value order by i.ordinality)
           from jsonb_array_elements(b.records) with ordinality i(value,ordinality)
           where i.value<>'{}'::jsonb and not (
               public.daf_is_valid_iso_date(i.value->>'date') and i.value->>'date'<v_cutoff::text
           )
       ),'[]'::jsonb) else b.records end
    from jsonb_to_recordset(v_pairs) as p(line text,file_name text)
    where b.line=p.line and b.file_name=p.file_name
      and not exists(select 1 from public.daf_log_candidates c where c.line=p.line and c.file_name=p.file_name
        and public.daf_is_valid_iso_date(c.report_date) and c.report_date<v_cutoff::text);

    return jsonb_build_object('cutoff_date',v_cutoff,'compacted',v_expected_winners,
        'removed_candidates',v_deleted,'deferred_unresolved_rows',v_unresolved,
        'done',v_picked<p_batch_size);
end;
$$;

-- Preserve the established first-wins rule against the small E-key registry.
create or replace function public.daf_finalize_log_import(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path=public
set statement_timeout='55s' as $$
declare
    v_job public.daf_log_import_jobs%rowtype;
    v_current_heads jsonb;
    v_compaction_cutoff date;
    v_chunk_count integer;
    v_kept integer;
    v_duplicates integer;
    v_archived_duplicates integer;
    v_pairs jsonb;
    v_lock record;
begin
    select * into v_job from public.daf_log_import_jobs where id=p_job_id for update;
    if not found then raise exception 'upload job not found'; end if;
    if v_job.status='published' then return jsonb_build_object('published',true,'accepted_count',v_job.accepted_count,'duplicate_count',v_job.duplicate_count,'resumed',true); end if;
    if v_job.status<>'receiving' then raise exception 'upload job cannot be published'; end if;
    perform pg_advisory_xact_lock(hashtextextended(v_job.file_name,92741));
    select coalesce(jsonb_object_agg(line,job_id::text),'{}'::jsonb) into v_current_heads
    from public.daf_log_active_file_processes where file_name=v_job.file_name;
    if v_current_heads<>v_job.base_heads then raise exception '檔案已被其他上傳更新，請重新上傳'; end if;
    select count(*)::integer into v_chunk_count from public.daf_log_import_chunks where job_id=p_job_id;
    if v_chunk_count<>v_job.expected_chunks then raise exception '上傳分批未完成'; end if;
    if exists(select 1 from public.daf_log_import_chunks where job_id=p_job_id group by line
              having min(chunk_index)<>0 or max(chunk_index)+1<>count(*)) then raise exception '上傳分批序號不完整'; end if;

    create temporary table _daf_import_keys(line text,dedup_key text,primary key(line,dedup_key)) on commit drop;
    create temporary table _daf_import_pairs(line text,file_name text,primary key(line,file_name)) on commit drop;
    create temporary table _daf_import_old_jobs(job_id uuid primary key) on commit drop;
    insert into _daf_import_old_jobs select distinct job_id from public.daf_log_active_file_processes where file_name=v_job.file_name;
    insert into _daf_import_pairs select line,file_name from public.daf_log_winners where file_name=v_job.file_name on conflict do nothing;
    insert into _daf_import_keys select line,dedup_key from public.daf_log_winners where file_name=v_job.file_name and dedup_key is not null on conflict do nothing;
    insert into _daf_import_keys select distinct line,dedup_key from public.daf_log_candidates where job_id=p_job_id and dedup_key is not null on conflict do nothing;
    for v_lock in
        select affected.line from (
            select line from public.daf_log_active_file_processes where file_name=v_job.file_name
            union select m.value->>'line' from jsonb_array_elements(v_job.metadata) m(value)
             where m.value->>'line' in ('DAF','FT1','FT2','LIGHTING','ASSEMBLY')
        ) affected order by affected.line
    loop perform pg_advisory_xact_lock(hashtextextended(v_lock.line,92742)); end loop;

    select cutoff_date into v_compaction_cutoff from public.daf_log_compaction_state where id='current';
    if v_compaction_cutoff is not null and exists(
        select 1 from jsonb_to_recordset(coalesce(v_job.metadata,'[]'::jsonb)) as m(line text,date_start text,date_end text)
        where m.line in ('DAF','FT1','FT2','LIGHTING','ASSEMBLY') and
          ((public.daf_is_valid_iso_date(m.date_start) and m.date_start<v_compaction_cutoff::text)
           or (public.daf_is_valid_iso_date(m.date_end) and m.date_end<v_compaction_cutoff::text))
    ) then raise exception '上傳資料包含已封存日期（早於 %），為保留歷史統計，無法回補此區間',v_compaction_cutoff; end if;
    if v_compaction_cutoff is not null and exists(
        select 1 from public.daf_log_candidates c where c.job_id=p_job_id
         and c.line in ('DAF','FT1','FT2','LIGHTING','ASSEMBLY')
         and public.daf_is_valid_iso_date(c.report_date) and c.report_date<v_compaction_cutoff::text
    ) then raise exception '上傳明細包含已封存日期（早於 %），此次上傳已取消',v_compaction_cutoff; end if;

    select count(*)::integer into v_duplicates from public.daf_log_candidates incoming
    where incoming.job_id=p_job_id and incoming.dedup_key is not null and exists(
        select 1 from public.daf_log_winners existing where existing.line=incoming.line
          and existing.dedup_key=incoming.dedup_key and existing.file_name<>v_job.file_name
    );
    select count(*)::integer into v_archived_duplicates from public.daf_log_candidates incoming
    join (
        select line,dedup_key,dedup_time,file_name from public.daf_log_compact_e_keys
        union all
        select line,dedup_key,dedup_time,file_name from public.daf_log_compact_facts where dedup_key is not null
    ) archived on archived.line=incoming.line and archived.dedup_key=incoming.dedup_key
    where incoming.job_id=p_job_id and incoming.dedup_key is not null and archived.file_name<>v_job.file_name;
    if exists(
        select 1 from public.daf_log_candidates incoming
        join (
            select line,dedup_key,dedup_time,file_name from public.daf_log_compact_e_keys
            union all
            select line,dedup_key,dedup_time,file_name from public.daf_log_compact_facts where dedup_key is not null
        ) archived on archived.line=incoming.line and archived.dedup_key=incoming.dedup_key
        where incoming.job_id=p_job_id
          and coalesce(incoming.dedup_time,9223372036854775807::bigint)<coalesce(archived.dedup_time,9223372036854775807::bigint)
    ) then raise exception '新資料的 E 欄時間早於已封存勝出資料；為避免歷史統計錯誤，此次上傳已取消'; end if;

    insert into _daf_import_pairs select distinct w.line,w.file_name from public.daf_log_winners w
      join _daf_import_keys k using(line,dedup_key) on conflict do nothing;
    insert into _daf_import_pairs(line,file_name) values ('DAF',v_job.file_name),('FT1',v_job.file_name),
      ('FT2',v_job.file_name),('LIGHTING',v_job.file_name),('ASSEMBLY',v_job.file_name) on conflict do nothing;
    delete from public.daf_log_active_file_processes where file_name=v_job.file_name;
    insert into public.daf_log_active_file_processes(line,file_name,job_id,metadata,uploaded_at)
    select m.value->>'line',v_job.file_name,p_job_id,m.value,coalesce((m.value->>'uploaded_at')::timestamptz,v_job.created_at)
    from jsonb_array_elements(v_job.metadata) m(value)
    where m.value->>'line' in ('DAF','FT1','FT2','LIGHTING','ASSEMBLY');
    delete from public.daf_log_winners where file_name=v_job.file_name;
    delete from public.daf_log_winners w using _daf_import_keys k where w.line=k.line and w.dedup_key=k.dedup_key;
    insert into public.daf_log_winners(candidate_id,line,dedup_key,file_name,job_id)
    select picked.id,picked.line,picked.dedup_key,picked.file_name,picked.job_id from (
        select distinct on(c.line,c.dedup_key) c.id,c.line,c.dedup_key,c.file_name,c.job_id,c.dedup_time,c.created_at
        from public.daf_log_candidates c join public.daf_log_active_file_processes h
          on h.line=c.line and h.file_name=c.file_name and h.job_id=c.job_id
        join _daf_import_keys k on k.line=c.line and k.dedup_key=c.dedup_key
        where not exists(select 1 from public.daf_log_compact_e_keys e where e.line=c.line and e.dedup_key=c.dedup_key)
          and not exists(select 1 from public.daf_log_compact_facts f where f.line=c.line and f.dedup_key=c.dedup_key)
        order by c.line,c.dedup_key,c.dedup_time asc nulls last,c.created_at asc,c.id asc
    ) picked;
    insert into public.daf_log_winners(candidate_id,line,dedup_key,file_name,job_id)
    select c.id,c.line,null,c.file_name,c.job_id from public.daf_log_candidates c
    join public.daf_log_active_file_processes h on h.line=c.line and h.file_name=c.file_name and h.job_id=c.job_id
    where c.job_id=p_job_id and c.dedup_key is null;
    insert into _daf_import_pairs select distinct w.line,w.file_name from public.daf_log_winners w
      join _daf_import_keys k using(line,dedup_key) on conflict do nothing;
    update public.daf_log_import_jobs old_job set status='superseded',superseded_at=now()
    where old_job.id in(select job_id from _daf_import_old_jobs) and old_job.id<>p_job_id
      and old_job.status='published' and not exists(select 1 from public.daf_log_active_file_processes h where h.job_id=old_job.id);
    select count(*)::integer into v_kept from public.daf_log_winners where job_id=p_job_id;
    update public.daf_log_import_jobs set status='published',published_at=now(),error_text=null,
        accepted_count=v_kept,duplicate_count=v_duplicates+v_archived_duplicates where id=p_job_id;
    select coalesce(jsonb_agg(jsonb_build_object('line',line,'file_name',file_name)),'[]'::jsonb) into v_pairs from _daf_import_pairs;
    perform public.refresh_daf_log_batch_summaries(v_pairs);
    return jsonb_build_object('published',true,'accepted_count',v_kept,
        'duplicate_count',v_duplicates+v_archived_duplicates,'resumed',false);
end;
$$;

create or replace function public.guard_daf_compacted_file_delete()
returns trigger language plpgsql security definer set search_path=public as $$
begin
    if exists(select 1 from public.daf_log_compact_facts f where f.line=old.line and f.file_name=old.file_name)
       or exists(select 1 from public.daf_log_compact_groups g where g.line=old.line and g.file_name=old.file_name)
       or exists(select 1 from public.daf_log_compacted_files f where f.line=old.line and f.file_name=old.file_name) then
        raise exception '此檔案含有 14 天前已封存資料，無法刪除或覆蓋';
    end if;
    return old;
end;
$$;

revoke all on function public.daf_migrate_compact_fact_batch(integer),public.daf_compact_dashboard_digest(date) from public,anon,authenticated;
notify pgrst,'reload schema';

-- Keep the existing preview RPC shape, but its digest/count must include weighted groups.
create or replace function public.daf_preview_log_compaction(p_cutoff date)
returns table (
    line text,candidate_rows bigint,winner_rows bigint,removable_loser_rows bigint,
    missing_or_invalid_date_rows bigint,receiving_jobs_with_expired_range bigint,
    projection_mismatch_rows bigint,compacted_winner_rows bigint,dashboard_digest text,
    candidate_table_bytes bigint,winner_table_bytes bigint
)
language sql security definer stable set search_path=public
as $$
    with lines(line) as (values ('DAF'),('FT1'),('FT2'),('LIGHTING'),('ASSEMBLY')),
    old_candidates as (
        select c.*,exists(select 1 from public.daf_log_winners w where w.candidate_id=c.id) as is_winner
        from public.daf_log_candidates c
        where public.daf_is_valid_iso_date(c.report_date) and c.report_date<p_cutoff::text
    ), invalid_dates as (
        select c.line,count(*)::bigint as n from public.daf_log_candidates c
        where not public.daf_is_valid_iso_date(c.report_date) group by c.line
    ), receiving as (
        select m.value->>'line' as line,count(distinct j.id)::bigint as n
        from public.daf_log_import_jobs j cross join lateral jsonb_array_elements(j.metadata) m(value)
        where j.status='receiving' and m.value->>'line' in ('DAF','FT1','FT2','LIGHTING','ASSEMBLY')
          and ((public.daf_is_valid_iso_date(m.value->>'date_start') and m.value->>'date_start'<p_cutoff::text)
            or (public.daf_is_valid_iso_date(m.value->>'date_end') and m.value->>'date_end'<p_cutoff::text))
        group by m.value->>'line'
    ), mismatches as (
        select c.line,count(*)::bigint as n from public.daf_log_candidates c
        join public.daf_log_winners w on w.candidate_id=c.id
        where public.daf_is_valid_iso_date(c.report_date) and c.report_date<p_cutoff::text
          and public.daf_candidate_payload_mismatch(c) group by c.line
    ), compacted as (
        select q.line,sum(q.quantity)::bigint as n from (
            select f.line,f.report_date,1::bigint as quantity from public.daf_log_compact_facts f
            union all
            select g.line,g.report_date,g.quantity from public.daf_log_compact_groups g
        ) q where public.daf_is_valid_iso_date(q.report_date) and q.report_date<p_cutoff::text
        group by q.line
    ), digests as (
        select line,dashboard_digest from public.daf_compact_dashboard_digest(p_cutoff)
    )
    select l.line,count(o.id),count(o.id) filter(where o.is_winner),
           count(o.id) filter(where not o.is_winner),coalesce(i.n,0),coalesce(r.n,0),
           coalesce(m.n,0),coalesce(c.n,0),coalesce(d.dashboard_digest,md5('')),
           pg_total_relation_size('public.daf_log_candidates'::regclass),
           pg_total_relation_size('public.daf_log_winners'::regclass)
    from lines l left join old_candidates o on o.line=l.line
    left join invalid_dates i on i.line=l.line left join receiving r on r.line=l.line
    left join mismatches m on m.line=l.line left join compacted c on c.line=l.line
    left join digests d on d.line=l.line
    group by l.line,i.n,r.n,m.n,c.n,d.dashboard_digest order by l.line;
$$;

revoke all on function public.daf_preview_log_compaction(date) from public,anon,authenticated;
