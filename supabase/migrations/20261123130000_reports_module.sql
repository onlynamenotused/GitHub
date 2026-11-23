-- Reports module (portal "Reports" tab): asset lists, usage and service history, exportable as CSV.
-- Customers: their own machines and jobs, when clients.reports_access is ticked (off by default).
-- Vendors / supervisors: only jobs billed to them (Bill to = the vendor), when supervisors.reports_access is ticked.
-- Staff (hello@): the whole service desk, always.

alter table public.clients add column if not exists reports_access boolean not null default false;
alter table public.supervisors add column if not exists reports_access boolean not null default true;

create or replace function public.has_reports_access() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff()
      or exists (select 1 from supervisors s where s.reports_access and s.id in (select public.my_supervisor_ids()))
      or exists (select 1 from portal_access pa join clients c on c.id = pa.client_id
                  where lower(pa.email) = public.current_email() and pa.role = 'customer' and c.reports_access)
$$;
grant execute on function public.has_reports_access() to authenticated;

-- Job rows for the Reports tab, by who is asking. Customers never see prices on jobs billed to someone else.
create or replace function public.report_jobs() returns jsonb
language sql stable security definer set search_path = public as $function$
  with me as (
    select public.is_staff() as staff,
           array(select lower(trim(s.bill_to)) from supervisors s
                  where s.reports_access and s.bill_to is not null and s.id in (select public.my_supervisor_ids())) as bills,
           array(select pa.client_id from portal_access pa join clients c on c.id = pa.client_id
                  where lower(pa.email) = public.current_email() and pa.role = 'customer' and c.reports_access) as clients
  ), rows as (
    select t.*, p.data as d, coalesce(nullif(trim(p.data->>'billTo'),''), 'Customer') as bill_to,
           me.staff as staff_view,
           (lower(trim(coalesce(p.data->>'billTo',''))) = any (me.bills)) as vendor_view
      from tickets t left join ticket_private p on p.num = t.num cross join me
     where not t.sample and (
       me.staff
       or lower(trim(coalesce(p.data->>'billTo',''))) = any (me.bills)
       or t.client_id = any (me.clients))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'num', r.num, 'client_id', r.client_id, 'customer', r.customer_name, 'machine_id', r.machine_id, 'type', r.type, 'subtype', r.subtype,
    'status', r.status, 'summary', r.summary, 'model', r.model, 'created', r.created, 'sched_date', r.sched_date,
    'error_code', r.d->>'errorCode', 'description', r.d->>'description', 'notes', r.d->>'notes',
    'completed', coalesce(r.d->>'completedAt', case when r.status in ('completed','invoiced') then r.d->>'modified' end), 'bill_to', r.bill_to, 'channel', case when r.staff_view then r.d->>'channel' end,
    'warranty', coalesce(r.d->>'warranty','') in ('true','yes','1'),
    'lines', case when r.staff_view or r.vendor_view or r.bill_to = 'Customer'
      then coalesce((select jsonb_agg(jsonb_build_object('code', l->>'code', 'desc', l->>'desc', 'qty', l->'qty', 'unit', l->'unit'))
                       from jsonb_array_elements(coalesce(r.d->'lines','[]')) l), '[]'::jsonb)
      else coalesce((select jsonb_agg(jsonb_build_object('code', l->>'code', 'desc', l->>'desc', 'qty', l->'qty', 'unit', 0))
                       from jsonb_array_elements(coalesce(r.d->'lines','[]')) l), '[]'::jsonb) end)
    order by r.num desc), '[]'::jsonb)
  from rows r
  where public.has_reports_access()
$function$;
grant execute on function public.report_jobs() to authenticated;

-- Menu flag
create or replace function public.portal_menu()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'email', public.current_email(),
    'staff', public.is_staff(),
    'intranet', public.is_intranet(),
    'kb', public.has_kb_access() or public.is_supervisor(),
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
