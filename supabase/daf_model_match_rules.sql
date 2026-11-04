-- Five-process model recognition rules. This is separate from FP-code memories and
-- production batches so free-text matching never changes existing report records.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

create table if not exists public.daf_model_match_rules (
    id text primary key,
    match_type text not null check (match_type in ('exact', 'contains')),
    match_text text not null check (length(match_text) between 1 and 180),
    match_key text not null unique,
    model_name text not null check (length(btrim(model_name)) > 0 and upper(btrim(model_name)) <> '未識別機種'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists daf_model_match_rules_updated_idx
    on public.daf_model_match_rules (updated_at desc);

create or replace function public.daf_normalize_model_match_rule()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
    new.match_text := upper(btrim(regexp_replace(normalize(new.match_text, NFKC), '\s+', ' ', 'g')));
    new.match_key := new.match_type || ':' || new.match_text;
    new.model_name := upper(btrim(new.model_name));
    if new.match_type not in ('exact', 'contains') or new.match_text = ''
       or length(new.match_text) > 180 or new.model_name = '' or new.model_name = '未識別機種' then
        raise exception '機種辨識規則內容無效，未寫入';
    end if;
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists daf_model_match_rule_normalize on public.daf_model_match_rules;
create trigger daf_model_match_rule_normalize
before insert or update on public.daf_model_match_rules
for each row execute function public.daf_normalize_model_match_rule();

-- Match the existing five-process shared table access pattern; do not alter other tables.
alter table public.daf_model_match_rules disable row level security;
grant select, insert, update, delete on public.daf_model_match_rules to anon, authenticated;

revoke all on function public.daf_normalize_model_match_rule() from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
