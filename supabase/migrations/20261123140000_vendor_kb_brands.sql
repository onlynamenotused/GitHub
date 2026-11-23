-- Vendor logins see only their own brands in the Knowledge Base.
-- kb_brands holds Knowledge Base brand keys: mimaki, mutoh, gtx (Brother GTX), epilog, brother / kyocera (office lasers).
-- Empty = every brand (e.g. Avery Dennison). Staff and customer logins always see everything.
alter table public.supervisors add column if not exists kb_brands text[] not null default '{}';
update public.supervisors set kb_brands = array['mimaki'] where name = 'Mimaki Australia';
update public.supervisors set kb_brands = array['gtx','brother'] where name = 'Brother International';
update public.supervisors set kb_brands = array['mutoh'] where name = 'Mutoh Australia';
update public.supervisors set kb_brands = array['epilog'] where name = 'ALFEX CNC Australia';

create or replace function public.my_kb_only() returns text[]
language sql stable security definer set search_path = public as $$
  select case
    when public.is_staff() then null
    when exists (select 1 from portal_access pa where lower(pa.email) = public.current_email() and pa.role = 'customer') then null
    when not exists (select 1 from supervisors s where s.id in (select public.my_supervisor_ids())) then null
    when exists (select 1 from supervisors s where s.id in (select public.my_supervisor_ids()) and cardinality(s.kb_brands) = 0) then null
    else array(select distinct b from supervisors s, unnest(s.kb_brands) b where s.id in (select public.my_supervisor_ids()))
  end
$$;
grant execute on function public.my_kb_only() to authenticated;

create or replace function public.portal_menu()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'email', public.current_email(),
    'staff', public.is_staff(),
    'intranet', public.is_intranet(),
    'kb', public.has_kb_access() or public.is_supervisor(),
    'kb_only', to_jsonb(public.my_kb_only()),
    'cat', public.has_catalogue_access(),
    'cat_brands', to_jsonb(public.my_catalogue_brands()),
    'vector', public.has_vector_access(),
    'flute', public.has_flute_access(),
    'flute_admin', public.is_flute_admin(),
    'apps_only', public.is_apps_only(),
    'lead', public.is_vector_lead(),
    'reports', public.has_reports_access(),
    'customer', exists (select 1 from portal_access pa where lower(pa.email) = public.current_email() and pa.role = 'customer'),
    'supervisor', (select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name)) from supervisors s where s.id in (select public.my_supervisor_ids())))
$$;
