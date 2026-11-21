-- Service kit tools for staff: a searchable supplier price list, and a gateway to the bridge's kit tools
-- (OneDrive parts-list scan, Mimaki supply page). Staff only.

create table if not exists public.part_prices (
  brand text not null default 'Mimaki',
  pn text not null,
  name text not null default '',
  models text[] not null default '{}',
  cost numeric(10,2),          -- supplier price to Highway Digital, ex GST
  rrp numeric(10,2),           -- supplier RRP, ex GST (what kits charge)
  source text,
  updated_at timestamptz not null default now(),
  primary key (brand, pn)
);
alter table public.part_prices enable row level security;
drop policy if exists part_prices_staff on public.part_prices;
create policy part_prices_staff on public.part_prices for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- Search the price list: text and/or the kit's models (letters and digits only, so "UJV300DTF" finds "UJV300DTF-75").
create or replace function public.kit_part_search(q text, models text[] default '{}', lim int default 40)
returns setof public.part_prices language sql stable security definer set search_path to 'public' as $$
  with m as (select coalesce(array_agg(public.kit_norm(x)) filter (where public.kit_norm(x) <> ''), '{}') ms from unnest(coalesce(models,'{}')) x)
  select p.* from public.part_prices p, m
   where public.is_staff()
     and (coalesce(trim(q),'') = '' or (p.pn || ' ' || p.name) ilike '%' || trim(q) || '%')
     and (coalesce(trim(q),'') <> '' or exists (select 1 from unnest(p.models) pm, unnest(m.ms) km where public.kit_norm(pm) like '%' || km || '%' or km like '%' || public.kit_norm(pm) || '%'))
   order by (exists (select 1 from unnest(p.models) pm, unnest(m.ms) km where public.kit_norm(pm) like '%' || km || '%' or km like '%' || public.kit_norm(pm) || '%')) desc, p.pn
   limit greatest(1, least(coalesce(lim,40), 200))
$$;
revoke all on function public.kit_part_search(text, text[], int) from public;
grant execute on function public.kit_part_search(text, text[], int) to authenticated;

-- Staff gateway to the bridge's kit tools. Only these ops, only for staff.
create or replace function public.staff_kit_tool(p jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare op text := p->>'op';
begin
  if not public.is_staff() then raise exception 'Staff only'; end if;
  if op not in ('kit_manuals','kit_manual_parts','mimaki_supply') then raise exception 'Unknown tool'; end if;
  return fbw.call(p);
end $$;
revoke all on function public.staff_kit_tool(jsonb) from public;
grant execute on function public.staff_kit_tool(jsonb) to authenticated;

-- Kits remember the Mimaki supply page they were checked against.
alter table public.service_kits add column if not exists supply_url text;
