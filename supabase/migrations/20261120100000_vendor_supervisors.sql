-- Vendor supervisors (e.g. Avery Dennison): a vendor pays for support on a fleet of customers' machines.
-- Their logins can see those customers' machines, jobs and service history, log jobs, and run fleet reports.

create table if not exists public.supervisors (
  id           bigint generated always as identity primary key,
  name         text not null unique,
  bill_to      text,                       -- service desk "Bill to" name for their jobs (e.g. 'Avery Dennison')
  fb_client_id bigint,                     -- FreshBooks client their invoices go to (service history is read from it)
  last_sync    timestamptz,
  created_at   timestamptz not null default now()
);
create table if not exists public.supervisor_access (
  supervisor_id bigint not null references public.supervisors(id) on delete cascade,
  email         text not null,
  full_name     text,
  created_at    timestamptz not null default now(),
  primary key (supervisor_id, email)
);
create table if not exists public.supervisor_clients (
  supervisor_id bigint not null references public.supervisors(id) on delete cascade,
  client_id     bigint not null references public.clients(id) on delete cascade,
  match_terms   text[] not null default '{}',  -- words that identify this customer on the vendor's invoices
  primary key (supervisor_id, client_id)
);
alter table public.machines add column if not exists supervisor_id bigint references public.supervisors(id) on delete set null;
alter table public.portal_jobs add column if not exists supervisor_id bigint references public.supervisors(id) on delete set null;

-- Service history from the vendor's FreshBooks invoices (one row per invoice)
create table if not exists public.service_records (
  id            text primary key,              -- 'fbinv-<invoice id>'
  supervisor_id bigint references public.supervisors(id) on delete cascade,
  client_id     bigint references public.clients(id) on delete set null,   -- end customer, when it could be matched
  machine_id    text references public.machines(id) on update cascade on delete set null,
  number        text,
  issued        date,
  status        text,                           -- draft / sent / paid …
  kind          text,                           -- service / install / parts
  po            text,
  notes         text,
  total_ex      numeric,
  total_inc     numeric,
  lines         jsonb not null default '[]',    -- [{code, desc, qty, unit, amount}]
  link_locked   boolean not null default false, -- staff set client/machine by hand
  updated_at    timestamptz not null default now()
);
create index if not exists service_records_sup on public.service_records(supervisor_id, issued);

-- Who am I supervising?
create or replace function public.my_supervisor_ids() returns setof bigint
language sql stable security definer set search_path = public as $$
  select sa.supervisor_id from supervisor_access sa where lower(sa.email) = public.current_email()
$$;
create or replace function public.is_supervisor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from supervisor_access sa where lower(sa.email) = public.current_email())
$$;
create or replace function public.supervised_client_ids() returns setof bigint
language sql stable security definer set search_path = public as $$
  select sc.client_id from supervisor_clients sc where sc.supervisor_id in (select public.my_supervisor_ids())
$$;
create or replace function public.supervises_machine(p_machine text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from machines m where m.id = p_machine and m.status = 'active'
    and (m.supervisor_id in (select public.my_supervisor_ids()) or m.client_id in (select public.supervised_client_ids())))
$$;
grant execute on function public.my_supervisor_ids(), public.is_supervisor(), public.supervised_client_ids(),
  public.supervises_machine(text) to authenticated;

-- Read access for supervisors (added alongside the existing policies; Postgres ORs them)
alter table public.supervisors enable row level security;
alter table public.supervisor_access enable row level security;
alter table public.supervisor_clients enable row level security;
alter table public.service_records enable row level security;

drop policy if exists sup_read on public.supervisors;
create policy sup_read on public.supervisors for select to authenticated using (public.is_staff() or id in (select public.my_supervisor_ids()));
drop policy if exists sup_staff on public.supervisors;
create policy sup_staff on public.supervisors for all to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists supa_read on public.supervisor_access;
create policy supa_read on public.supervisor_access for select to authenticated using (public.is_staff() or lower(email) = public.current_email());
drop policy if exists supa_staff on public.supervisor_access;
create policy supa_staff on public.supervisor_access for all to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists supc_read on public.supervisor_clients;
create policy supc_read on public.supervisor_clients for select to authenticated using (public.is_staff() or supervisor_id in (select public.my_supervisor_ids()));
drop policy if exists supc_staff on public.supervisor_clients;
create policy supc_staff on public.supervisor_clients for all to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists sr_read on public.service_records;
create policy sr_read on public.service_records for select to authenticated using (public.is_staff() or supervisor_id in (select public.my_supervisor_ids()));
drop policy if exists sr_staff on public.service_records;
create policy sr_staff on public.service_records for all to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists clients_supervisor on public.clients;
create policy clients_supervisor on public.clients for select to authenticated using (id in (select public.supervised_client_ids()));
drop policy if exists machines_supervisor on public.machines;
create policy machines_supervisor on public.machines for select to authenticated using (
  supervisor_id in (select public.my_supervisor_ids()) or client_id in (select public.supervised_client_ids()));
drop policy if exists tickets_supervisor on public.tickets;
create policy tickets_supervisor on public.tickets for select to authenticated using (not sample and (
  client_id in (select public.supervised_client_ids())
  or machine_id in (select m.id from public.machines m where m.supervisor_id in (select public.my_supervisor_ids()))));
drop policy if exists files_supervisor on public.machine_files;
create policy files_supervisor on public.machine_files for select to authenticated using (
  machine_id is not null and machine_id in (select m.id from public.machines m where m.status <> 'decommissioned'
    and (m.supervisor_id in (select public.my_supervisor_ids()) or m.client_id in (select public.supervised_client_ids()))));
drop policy if exists jobs_supervisor on public.portal_jobs;
create policy jobs_supervisor on public.portal_jobs for select to authenticated using (
  supervisor_id in (select public.my_supervisor_ids()) or client_id in (select public.supervised_client_ids()));
drop policy if exists bookings_supervisor on public.portal_bookings;
create policy bookings_supervisor on public.portal_bookings for select to authenticated using (client_id in (select public.supervised_client_ids()));

-- Menu flags: add supervisor
create or replace function public.portal_menu()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'email', public.current_email(),
    'staff', public.is_staff(),
    'intranet', public.is_intranet(),
    'kb', public.has_kb_access() or public.is_supervisor(),
    'cat', public.has_catalogue_access(),
    'customer', exists (select 1 from portal_access pa where lower(pa.email) = public.current_email() and pa.role = 'customer'),
    'supervisor', (select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name)) from supervisors s where s.id in (select public.my_supervisor_ids())))
$$;

-- Jobs: customers for their own machines, supervisors for machines they supervise
create or replace function public.portal_log_job(p_machine text, p_kind text, p_desc text, p_code text, p_name text, p_phone text)
returns bigint language plpgsql security definer set search_path = public as $$
declare em text := public.current_email(); cid bigint; sid bigint; jid bigint;
begin
  if em = '' then raise exception 'Please sign in again.'; end if;
  if p_kind not in ('fault','service','install','other') then raise exception 'Choose what the job is for.'; end if;
  if coalesce(trim(p_desc),'') = '' then raise exception 'Tell us what''s happening with the machine.'; end if;
  select m.client_id into cid from machines m
   where m.id = p_machine and m.status = 'active'
     and exists (select 1 from portal_access pa where lower(pa.email) = em and pa.client_id = m.client_id and pa.role = 'customer');
  if cid is null and public.supervises_machine(p_machine) then
    select m.client_id, coalesce(m.supervisor_id, (select sc.supervisor_id from supervisor_clients sc
             where sc.client_id = m.client_id and sc.supervisor_id in (select public.my_supervisor_ids()) limit 1))
      into cid, sid from machines m where m.id = p_machine;
  end if;
  if cid is null then raise exception 'That machine isn''t on your account.'; end if;
  if (select count(*) from portal_jobs where client_id = cid and status = 'pending') >= 5 then
    raise exception 'There are already 5 jobs waiting for us on this account. Please call us on 1300 880 815.';
  end if;
  insert into portal_jobs(client_id, machine_id, kind, description, error_code, contact_name, phone, email, supervisor_id)
  values (cid, p_machine, p_kind, left(p_desc,4000), left(nullif(trim(p_code),''),40), left(p_name,120), left(p_phone,40), em, sid)
  returning id into jid;
  return jid;
end $$;

-- Machines: supervisors can add one for a customer they supervise (p.client_id required)
create or replace function public.portal_add_machine(p jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare em text := public.current_email(); cid bigint; sid bigint; nid text; iv int; last date; inst date; nxt date;
begin
  if em = '' then raise exception 'Please sign in again.'; end if;
  select pa.client_id into cid from portal_access pa
   where lower(pa.email) = em and pa.role = 'customer'
     and (nullif(p->>'client_id','') is null or pa.client_id = (p->>'client_id')::bigint)
   order by pa.client_id limit 1;
  if cid is null and nullif(p->>'client_id','') is not null then
    select sc.client_id, sc.supervisor_id into cid, sid from supervisor_clients sc
     where sc.client_id = (p->>'client_id')::bigint and sc.supervisor_id in (select public.my_supervisor_ids()) limit 1;
  end if;
  if cid is null then raise exception 'Your login isn''t linked to that customer account. Please call us on 1300 880 815.'; end if;
  if coalesce(trim(p->>'model'),'') = '' then raise exception 'Add the machine model.'; end if;
  if (select count(*) from machines where client_id = cid and added_via = 'portal' and not desk_seen) >= 10 then
    raise exception 'There are 10 added machines we haven''t checked yet. Please call us on 1300 880 815.';
  end if;
  if nullif(trim(p->>'serial'),'') is not null and exists (select 1 from machines m where m.client_id = cid and m.status = 'active'
       and public.norm_serial(m.serial) = public.norm_serial(p->>'serial')) then
    raise exception 'A machine with that serial number is already on this account.';
  end if;
  iv   := nullif(p->>'pm_interval_months','')::int;
  if iv is not null and (iv < 1 or iv > 36) then raise exception 'Choose a service interval between 1 and 36 months.'; end if;
  last := nullif(p->>'pm_last_done','')::date;
  inst := nullif(p->>'install_date','')::date;
  nxt  := nullif(p->>'pm_next_due','')::date;
  if nxt is null and iv is not null then
    nxt := (coalesce(last, inst, current_date) + make_interval(months => iv))::date;
    while nxt < current_date loop nxt := (nxt + make_interval(months => iv))::date; end loop;
  end if;
  nid := 'portal-' || to_char(now() at time zone 'Australia/Perth', 'YYMMDD') || '-' || substr(md5(random()::text), 1, 6);
  insert into machines(id, client_id, brand, model, serial, category, site, location, ink_set, install_date,
                       status, pm_interval_months, pm_last_done, pm_next_due, added_via, added_by, desk_seen, pm_source, supervisor_id, updated_at)
  values (nid, cid, left(nullif(trim(p->>'brand'),''),60), left(trim(p->>'model'),80), left(nullif(trim(p->>'serial'),''),60),
          left(nullif(trim(p->>'category'),''),60), left(nullif(trim(p->>'site'),''),120), left(nullif(trim(p->>'location'),''),200),
          left(nullif(trim(p->>'ink_set'),''),80), inst, 'active', iv, last, nxt, 'portal', em, false,
          case when iv is not null or nxt is not null then 'customer' end, sid, now());
  return nid;
end $$;

-- Schedule edits: also by the supervisor on machines added in the portal for their customers
create or replace function public.portal_set_schedule(p_machine text, p_interval int, p_last date, p_next date)
returns void language plpgsql security definer set search_path = public as $$
declare em text := public.current_email(); nxt date := p_next;
begin
  if p_interval is not null and (p_interval < 1 or p_interval > 36) then raise exception 'Choose a service interval between 1 and 36 months.'; end if;
  if nxt is null and p_interval is not null then
    nxt := (coalesce(p_last, current_date) + make_interval(months => p_interval))::date;
    while nxt < current_date loop nxt := (nxt + make_interval(months => p_interval))::date; end loop;
  end if;
  update machines m set pm_interval_months = p_interval, pm_last_done = p_last, pm_next_due = nxt, pm_source = 'customer',
         desk_seen = false, updated_at = now()
   where m.id = p_machine and m.added_via = 'portal' and m.status = 'active'
     and (exists (select 1 from portal_access pa where lower(pa.email) = em and pa.client_id = m.client_id and pa.role = 'customer')
          or public.supervises_machine(m.id));
  if not found then raise exception 'You can only change the schedule on machines added in the portal.'; end if;
end $$;

-- Job details for supervisors' reports (ticket_private stays staff-only; only these fields are shared)
create or replace function public.supervisor_jobs()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'num', t.num, 'client_id', t.client_id, 'machine_id', t.machine_id, 'type', t.type, 'subtype', t.subtype,
    'status', t.status, 'summary', t.summary, 'model', t.model, 'created', t.created, 'sched_date', t.sched_date,
    'error_code', p.data->>'errorCode', 'description', p.data->>'description', 'notes', p.data->>'notes',
    'completed', p.data->>'completedAt', 'bill_to', p.data->>'billTo',
    'lines', coalesce((select jsonb_agg(jsonb_build_object('code', l->>'code', 'desc', l->>'desc', 'qty', l->'qty', 'unit', l->'unit'))
                       from jsonb_array_elements(coalesce(p.data->'lines','[]')) l), '[]'::jsonb))
    order by t.num desc), '[]'::jsonb)
  from tickets t left join ticket_private p on p.num = t.num
  where not t.sample and public.is_supervisor() and (
    t.client_id in (select public.supervised_client_ids())
    or t.machine_id in (select m.id from machines m where m.supervisor_id in (select public.my_supervisor_ids())))
$$;
revoke all on function public.supervisor_jobs() from public, anon;
grant execute on function public.supervisor_jobs() to authenticated;

-- Match service history to the end customer and machine
create or replace function public.service_records_link(p_sup bigint)
returns int language plpgsql security definer set search_path = public as $$
declare r record; txt text; cid bigint; mid text; n int := 0;
begin
  for r in select * from service_records where supervisor_id = p_sup and not link_locked loop
    txt := lower(coalesce(r.po,'') || ' ' || coalesce(r.notes,'') || ' ' ||
           coalesce((select string_agg(coalesce(l->>'desc','') || ' ' || coalesce(l->>'code',''), ' ') from jsonb_array_elements(r.lines) l), ''));
    select sc.client_id into cid from supervisor_clients sc join clients c on c.id = sc.client_id
     where sc.supervisor_id = p_sup
       and exists (select 1 from unnest(case when cardinality(sc.match_terms) > 0 then sc.match_terms else array[c.name] end) t
                   where txt like '%' || lower(t) || '%')
     order by position(lower((case when cardinality(sc.match_terms) > 0 then sc.match_terms[1] else c.name end)) in txt) limit 1;
    mid := null;
    if cid is not null then
      select m.id into mid from machines m
       where m.client_id = cid and m.serial is not null and length(public.norm_serial(m.serial)) >= 5
         and position(public.norm_serial(m.serial) in public.norm_serial(txt)) > 0 limit 1;
    end if;
    update service_records set client_id = cid, machine_id = mid where id = r.id
      and (client_id is distinct from cid or machine_id is distinct from mid);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Pull the supervisor's FreshBooks invoices into service_records (service desk / staff only)
create or replace function public.desk_sync_supervisor(p_sup bigint)
returns jsonb language plpgsql security definer set search_path = public, fbw as $$
declare s supervisors; r jsonb;
begin
  select * into s from supervisors where id = p_sup;
  if s.fb_client_id is null then return jsonb_build_object('ok', false, 'error', 'no FreshBooks client'); end if;
  r := fbw.call(jsonb_build_object('op', 'sync_invoices', 'clientId', s.fb_client_id, 'supervisorId', s.id));
  if coalesce((r->>'ok')::boolean, false) then
    update supervisors set last_sync = now() where id = p_sup;
    perform public.service_records_link(p_sup);
  end if;
  return r;
end $$;
create or replace function public.desk_sync_supervisors()
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(public.desk_sync_supervisor(id)), '[]'::jsonb) from supervisors where fb_client_id is not null
$$;
create or replace function public.staff_sync_supervisor(p_sup bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Staff only'; end if;
  return public.desk_sync_supervisor(p_sup);
end $$;
revoke all on function public.service_records_link(bigint), public.desk_sync_supervisor(bigint), public.desk_sync_supervisors()
  from public, anon, authenticated;
revoke all on function public.staff_sync_supervisor(bigint) from public, anon;
grant execute on function public.staff_sync_supervisor(bigint) to authenticated;

-- Service desk: jobs carry the supervisor's billing name
create or replace function public.desk_pending_jobs()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', j.id, 'kind', j.kind, 'description', j.description, 'error_code', j.error_code, 'contact', j.contact_name,
    'phone', j.phone, 'email', j.email, 'created', j.created_at,
    'client_id', c.id, 'client_name', c.name, 'desk_ref', c.desk_ref,
    'machine_id', m.id, 'brand', m.brand, 'model', m.model, 'serial', m.serial, 'location', m.location,
    'supervisor', s.name, 'bill_to', s.bill_to)
    order by j.created_at), '[]'::jsonb)
  from portal_jobs j join clients c on c.id = j.client_id left join machines m on m.id = j.machine_id
       left join supervisors s on s.id = coalesce(j.supervisor_id, m.supervisor_id,
         (select sc.supervisor_id from supervisor_clients sc where sc.client_id = c.id order by sc.supervisor_id limit 1))
  where j.status = 'pending'
$$;
revoke all on function public.desk_pending_jobs() from public, anon, authenticated;
