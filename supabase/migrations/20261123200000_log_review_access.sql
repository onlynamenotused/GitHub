-- Mimaki Log Review in the portal: per vendor login tick box (off by default). Staff always have it.
alter table public.supervisor_access add column if not exists log_review boolean not null default false;

create or replace function public.has_log_review() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff() or exists (
    select 1 from supervisor_access sa join supervisors s on s.id = sa.supervisor_id
     where s.enabled and sa.log_review and lower(sa.email) = public.current_email())
$$;
grant execute on function public.has_log_review() to authenticated;

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
    'logreview', public.has_log_review(),
    'customer', exists (select 1 from portal_access pa where lower(pa.email) = public.current_email() and pa.role = 'customer'),
    'supervisor', (select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name)) from supervisors s where s.id in (select public.my_supervisor_ids())))
$$;
