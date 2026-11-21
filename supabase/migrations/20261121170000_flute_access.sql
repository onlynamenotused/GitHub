-- Flute Practice player (/flute/): per-customer access, off for every customer by default.
-- apps_only: a customer whose logins only see their apps (no My machines / Contact & booking in the menu).
alter table public.clients add column if not exists flute_access boolean not null default false;
alter table public.clients add column if not exists apps_only boolean not null default false;

create or replace function public.has_flute_access() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.is_staff() or exists (
    select 1 from public.portal_access pa join public.clients c on c.id = pa.client_id
     where lower(pa.email) = public.current_email() and c.flute_access)
$$;

create or replace function public.is_apps_only() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select not public.is_staff() and not public.is_supervisor()
    and exists (select 1 from public.portal_access pa join public.clients c on c.id = pa.client_id
                 where lower(pa.email) = public.current_email() and c.apps_only)
    and not exists (select 1 from public.portal_access pa join public.clients c on c.id = pa.client_id
                     where lower(pa.email) = public.current_email() and not c.apps_only)
$$;

create or replace function public.portal_menu() returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'email', public.current_email(),
    'staff', public.is_staff(),
    'intranet', public.is_intranet(),
    'kb', public.has_kb_access() or public.is_supervisor(),
    'cat', public.has_catalogue_access(),
    'cat_brands', to_jsonb(public.my_catalogue_brands()),
    'vector', public.has_vector_access(),
    'flute', public.has_flute_access(),
    'apps_only', public.is_apps_only(),
    'lead', public.is_vector_lead(),
    'customer', exists (select 1 from portal_access pa where lower(pa.email) = public.current_email() and pa.role = 'customer'),
    'supervisor', (select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name)) from supervisors s where s.id in (select public.my_supervisor_ids())))
$$;

revoke all on function public.has_flute_access() from public;
revoke all on function public.is_apps_only() from public;
grant execute on function public.has_flute_access() to anon, authenticated;
grant execute on function public.is_apps_only() to anon, authenticated;
