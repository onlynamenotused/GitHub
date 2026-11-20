-- Customers add their own machines (with their own service schedule) and log jobs from the portal.
-- The service desk picks both up: new machines become assets, logged jobs become tickets.

alter table public.machines add column if not exists added_via   text;          -- 'portal' when a customer added it
alter table public.machines add column if not exists added_by    text;          -- email of the customer who added it
alter table public.machines add column if not exists desk_seen   boolean not null default true;  -- false until the service desk has it
alter table public.machines add column if not exists pm_source   text;          -- 'customer' when the customer set the schedule

-- Customer adds a machine to one of their own accounts. Returns the new machine id.
create or replace function public.portal_add_machine(p jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare em text := public.current_email(); cid bigint; nid text; iv int; last date; inst date; nxt date;
begin
  if em = '' then raise exception 'Please sign in again.'; end if;
  select pa.client_id into cid from portal_access pa
   where lower(pa.email) = em and pa.role = 'customer'
     and (nullif(p->>'client_id','') is null or pa.client_id = (p->>'client_id')::bigint)
   order by pa.client_id limit 1;
  if cid is null then raise exception 'Your login isn''t linked to a customer account yet. Please call us on 1300 880 815.'; end if;
  if coalesce(trim(p->>'model'),'') = '' then raise exception 'Add the machine model.'; end if;
  if (select count(*) from machines where client_id = cid and added_via = 'portal' and not desk_seen) >= 10 then
    raise exception 'You''ve added 10 machines we haven''t checked yet. Please call us on 1300 880 815.';
  end if;
  if nullif(trim(p->>'serial'),'') is not null and exists (select 1 from machines m where m.client_id = cid and m.status = 'active'
       and public.norm_serial(m.serial) = public.norm_serial(p->>'serial')) then
    raise exception 'A machine with that serial number is already on your account.';
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
                       status, pm_interval_months, pm_last_done, pm_next_due, added_via, added_by, desk_seen, pm_source, updated_at)
  values (nid, cid, left(nullif(trim(p->>'brand'),''),60), left(trim(p->>'model'),80), left(nullif(trim(p->>'serial'),''),60),
          left(nullif(trim(p->>'category'),''),60), left(nullif(trim(p->>'site'),''),120), left(nullif(trim(p->>'location'),''),200),
          left(nullif(trim(p->>'ink_set'),''),80), inst, 'active', iv, last, nxt, 'portal', em, false,
          case when iv is not null or nxt is not null then 'customer' end, now());
  return nid;
end $$;
revoke all on function public.portal_add_machine(jsonb) from public, anon;
grant execute on function public.portal_add_machine(jsonb) to authenticated;

-- Customer changes the service schedule on a machine they added themselves (until we've serviced it).
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
     and exists (select 1 from portal_access pa where lower(pa.email) = em and pa.client_id = m.client_id and pa.role = 'customer');
  if not found then raise exception 'You can only change the schedule on machines you added.'; end if;
end $$;
revoke all on function public.portal_set_schedule(text,int,date,date) from public, anon;
grant execute on function public.portal_set_schedule(text,int,date,date) to authenticated;

-- Jobs logged by customers (no time picked; we arrange the visit).
create table if not exists public.portal_jobs (
  id           bigint generated always as identity primary key,
  client_id    bigint not null references public.clients(id) on delete cascade,
  machine_id   text references public.machines(id) on update cascade on delete set null,
  kind         text not null check (kind in ('fault','service','install','other')),
  description  text,
  error_code   text,
  contact_name text,
  phone        text,
  email        text not null,
  status       text not null default 'pending' check (status in ('pending','created','cancelled')),
  ticket_num   int,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.portal_jobs enable row level security;
drop policy if exists jobs_read on public.portal_jobs;
create policy jobs_read on public.portal_jobs for select to authenticated using (
  public.is_staff() or client_id in (select public.my_client_ids()));

create or replace function public.portal_log_job(p_machine text, p_kind text, p_desc text, p_code text, p_name text, p_phone text)
returns bigint language plpgsql security definer set search_path = public as $$
declare em text := public.current_email(); cid bigint; jid bigint;
begin
  if em = '' then raise exception 'Please sign in again.'; end if;
  if p_kind not in ('fault','service','install','other') then raise exception 'Choose what the job is for.'; end if;
  if coalesce(trim(p_desc),'') = '' then raise exception 'Tell us what''s happening with the machine.'; end if;
  select m.client_id into cid from machines m
   where m.id = p_machine and m.status = 'active'
     and exists (select 1 from portal_access pa where lower(pa.email) = em and pa.client_id = m.client_id and pa.role = 'customer');
  if cid is null then raise exception 'That machine isn''t on your account.'; end if;
  if (select count(*) from portal_jobs where client_id = cid and status = 'pending') >= 5 then
    raise exception 'You already have 5 jobs waiting for us. Please call us on 1300 880 815.';
  end if;
  insert into portal_jobs(client_id, machine_id, kind, description, error_code, contact_name, phone, email)
  values (cid, p_machine, p_kind, left(p_desc,4000), left(nullif(trim(p_code),''),40), left(p_name,120), left(p_phone,40), em)
  returning id into jid;
  return jid;
end $$;
revoke all on function public.portal_log_job(text,text,text,text,text,text) from public, anon;
grant execute on function public.portal_log_job(text,text,text,text,text,text) to authenticated;

-- Service desk side (via the Supabase connector only)
create or replace function public.desk_pending_machines()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'client_id', c.id, 'client_name', c.name, 'desk_ref', c.desk_ref, 'brand', m.brand, 'model', m.model,
    'serial', m.serial, 'category', m.category, 'site', m.site, 'location', m.location, 'ink_set', m.ink_set,
    'install_date', m.install_date, 'pm_interval_months', m.pm_interval_months, 'pm_last_done', m.pm_last_done,
    'pm_next_due', m.pm_next_due, 'pm_source', m.pm_source, 'added_by', m.added_by) order by m.updated_at), '[]'::jsonb)
  from machines m join clients c on c.id = m.client_id
  where m.added_via = 'portal' and not m.desk_seen and m.status = 'active'
$$;
create or replace function public.desk_machine_seen(p_id text)
returns void language sql security definer set search_path = public as $$
  update machines set desk_seen = true where id = p_id
$$;
create or replace function public.desk_pending_jobs()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', j.id, 'kind', j.kind, 'description', j.description, 'error_code', j.error_code, 'contact', j.contact_name,
    'phone', j.phone, 'email', j.email, 'created', j.created_at,
    'client_id', c.id, 'client_name', c.name, 'desk_ref', c.desk_ref,
    'machine_id', m.id, 'brand', m.brand, 'model', m.model, 'serial', m.serial, 'location', m.location)
    order by j.created_at), '[]'::jsonb)
  from portal_jobs j join clients c on c.id = j.client_id left join machines m on m.id = j.machine_id
  where j.status = 'pending'
$$;
create or replace function public.desk_job_done(p_id bigint, p_ticket int)
returns void language sql security definer set search_path = public as $$
  update portal_jobs set status = 'created', ticket_num = p_ticket, updated_at = now() where id = p_id
$$;
revoke all on function public.desk_pending_machines(), public.desk_machine_seen(text),
  public.desk_pending_jobs(), public.desk_job_done(bigint,int) from public, anon, authenticated;
