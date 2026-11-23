-- Per vendor login: hide pricing (supervisor_access.hide_prices).
-- Those logins read invoices through service_records_np (no totals, no line prices) and report_jobs returns no prices;
-- they can still download the FreshBooks invoice PDF itself (edge function fb-invoice-pdf).
alter table public.supervisor_access add column if not exists hide_prices boolean not null default false;

create or replace function public.my_hide_prices() returns boolean
language sql stable security definer set search_path = public as $$
  select not public.is_staff() and exists (
    select 1 from supervisor_access sa join supervisors s on s.id = sa.supervisor_id
     where s.enabled and sa.hide_prices and lower(sa.email) = public.current_email())
$$;
grant execute on function public.my_hide_prices() to authenticated;

drop policy if exists sr_no_prices on public.service_records;
create policy sr_no_prices on public.service_records as restrictive for select to authenticated
  using (public.is_staff() or not public.my_hide_prices());

-- Same rows the policies would give, without prices. Owner-rights view: the where clause is the access check.
create or replace view public.service_records_np with (security_invoker = false) as
  select r.id, r.supervisor_id, r.client_id, r.machine_id, r.number, r.issued, r.status, r.kind, r.po, r.notes,
         null::numeric as total_ex, null::numeric as total_inc,
         coalesce((select jsonb_agg(jsonb_build_object('code', l->>'code', 'desc', l->>'desc', 'qty', l->'qty')) from jsonb_array_elements(coalesce(r.lines,'[]')) l), '[]'::jsonb) as lines
    from public.service_records r
   where public.my_hide_prices() and coalesce(r.status,'') <> 'draft' and (
     r.supervisor_id in (select s.id from public.supervisors s where s.scope = 'invoiced' and s.id in (select public.my_supervisor_ids()))
     or (r.supervisor_id in (select public.my_supervisor_ids()) and r.client_id in (select public.supervised_client_ids()))
     or (r.supervisor_id is null and r.client_id in (select pa.client_id from public.portal_access pa where lower(pa.email) = public.current_email() and pa.role = 'customer')));
revoke all on public.service_records_np from anon;
grant select on public.service_records_np to authenticated;

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
    'lines', case when not public.my_hide_prices() and (r.staff_view or r.vendor_view or r.bill_to = 'Customer')
      then coalesce((select jsonb_agg(jsonb_build_object('code', l->>'code', 'desc', l->>'desc', 'qty', l->'qty', 'unit', l->'unit'))
                       from jsonb_array_elements(coalesce(r.d->'lines','[]')) l), '[]'::jsonb)
      else coalesce((select jsonb_agg(jsonb_build_object('code', l->>'code', 'desc', l->>'desc', 'qty', l->'qty', 'unit', 0))
                       from jsonb_array_elements(coalesce(r.d->'lines','[]')) l), '[]'::jsonb) end)
    order by r.num desc), '[]'::jsonb)
  from rows r
  where public.has_reports_access()
$function$;
