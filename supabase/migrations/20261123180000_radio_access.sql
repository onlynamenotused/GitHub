-- Radio tab on/off per customer (clients.radio_access) and per vendor/supervisor (supervisors.radio_access).
-- On by default, so nobody loses the tab when this ships. Staff always have it.
alter table public.clients add column if not exists radio_access boolean not null default true;
alter table public.supervisors add column if not exists radio_access boolean not null default true;

create or replace function public.has_radio_access() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff()
      or exists (select 1 from supervisors s where s.radio_access and s.id in (select public.my_supervisor_ids()))
      or exists (select 1 from portal_access pa join clients c on c.id = pa.client_id
                  where lower(pa.email) = public.current_email() and c.radio_access)
$$;
grant execute on function public.has_radio_access() to authenticated;

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
    'radio', public.has_radio_access(),
    'customer', exists (select 1 from portal_access pa where lower(pa.email) = public.current_email() and pa.role = 'customer'),
    'supervisor', (select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name)) from supervisors s where s.id in (select public.my_supervisor_ids())))
$$;
