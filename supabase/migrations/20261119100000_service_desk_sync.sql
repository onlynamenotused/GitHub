-- Highway Service Desk -> portal: tickets + live sync entry point.
-- Additive on top of the Stage 1 portal schema (clients, machines, kb_articles, portal_access, staff).
-- clients.id = FreshBooks client id; non-FreshBooks customers get ids from clients_portal_id_seq (9,000,000+).

-- 1. Customers created in the service desk (NC-… ids, or customers with no FreshBooks id)
alter table public.clients add column if not exists desk_ref text unique;
alter table public.clients add column if not exists email text;
alter table public.clients add column if not exists phone text;
alter table public.clients add column if not exists updated_at timestamptz not null default now();

-- 2. Tickets (portal-safe columns only; staff-only detail lives in ticket_private)
create table if not exists public.tickets (
  num            int primary key check (num between 1000000 and 9999999),
  client_id      bigint references public.clients(id) on delete set null,
  customer_name  text,
  machine_id     text references public.machines(id) on update cascade on delete set null,
  type           text check (type in ('incident','request','problem')),
  subtype        text,
  status         text,
  summary        text,
  model          text,
  created        date,
  sched_date     date,
  sched_time     text,
  sched_hours    numeric,
  assigned_email text,               -- sub-contractor login that may see this job
  sample         boolean not null default false,
  updated_at     timestamptz not null default now()
);
create index if not exists tickets_client_idx on public.tickets(client_id);
create index if not exists tickets_assigned_idx on public.tickets(lower(assigned_email));

create table if not exists public.ticket_private (
  num   int primary key references public.tickets(num) on delete cascade,
  data  jsonb not null default '{}'::jsonb   -- full service desk record: notes, billing lines, invoice refs
);

alter table public.tickets enable row level security;
alter table public.ticket_private enable row level security;

drop policy if exists tickets_staff_write on public.tickets;
create policy tickets_staff_write on public.tickets for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists tickets_read on public.tickets;
create policy tickets_read on public.tickets for select to authenticated using (
  public.is_staff()
  or (not sample and client_id in (select public.my_client_ids())
      and exists (select 1 from public.portal_access pa
                  where lower(pa.email) = public.current_email()
                    and pa.client_id = tickets.client_id and pa.role = 'customer'))
  or (lower(assigned_email) = public.current_email()
      and exists (select 1 from public.portal_access pa
                  where lower(pa.email) = public.current_email() and pa.role = 'subcontractor'))
);

drop policy if exists ticket_private_staff on public.ticket_private;
create policy ticket_private_staff on public.ticket_private for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- 3. Store for everything else the service desk keeps (inventory, outbox, meta, …) – staff only
create table if not exists public.desk_docs (
  collection text not null,
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);
alter table public.desk_docs enable row level security;
drop policy if exists desk_docs_staff on public.desk_docs;
create policy desk_docs_staff on public.desk_docs for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- 4. Resolve a service desk customer to a clients.id (creating the client if needed)
create or replace function public.desk_client_id(p_fb text, p_ref text, p_name text)
returns bigint language plpgsql security definer set search_path = public as $$
declare cid bigint;
begin
  if nullif(p_fb,'') is not null then
    cid := p_fb::bigint;
    insert into clients(id, name) values (cid, coalesce(nullif(p_name,''), 'FreshBooks client '||cid))
      on conflict (id) do nothing;
    return cid;
  end if;
  if nullif(p_ref,'') is not null then
    select id into cid from clients where desk_ref = p_ref;
    if cid is not null then return cid; end if;
  end if;
  if nullif(p_name,'') is null then return null; end if;
  select id into cid from clients where lower(name) = lower(p_name) order by id limit 1;
  if cid is null then
    insert into clients(name, desk_ref) values (p_name, coalesce(nullif(p_ref,''), 'name:'||lower(p_name)))
      returning id into cid;
  elsif nullif(p_ref,'') is not null then
    update clients set desk_ref = coalesce(desk_ref, p_ref) where id = cid;
  end if;
  return cid;
end $$;

-- 5. Sync entry point: upsert a batch of service desk documents [{id, data}, …]
create or replace function public.desk_sync(p_collection text, p_docs jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare d jsonb; v jsonb; n int := 0; cid bigint;
begin
  for d in select * from jsonb_array_elements(p_docs) loop
    v := d->'data';

    if p_collection = 'newclients' then
      cid := desk_client_id(v->>'fbClientId', d->>'id', v->>'name');
      update clients set email = coalesce(nullif(v->>'email',''), email),
                         phone = coalesce(nullif(coalesce(nullif(v->>'mobile',''), v->>'phone'),''), phone),
                         updated_at = now()
       where id = cid;

    elsif p_collection = 'assets' then
      cid := desk_client_id(v->>'clientId', null, v->>'customer');
      insert into machines(id, client_id, brand, model, serial, category, sub_category, site, location, ink_set,
                           install_date, warranty_end, status, pm_interval_months, pm_last_done, pm_next_due, last_visit)
      values (d->>'id', cid, v->>'brand', v->>'model', nullif(v->>'serial',''), v->>'category',
              nullif(v->>'subCategory',''), nullif(v->>'site',''), nullif(v->>'location',''), nullif(v->>'inkSet',''),
              nullif(v->>'purchaseDate','')::date, nullif(v->>'warrantyEnd','')::date,
              coalesce(nullif(v->>'status',''),'active'),
              nullif(v#>>'{pm,interval}','')::int, nullif(v#>>'{pm,lastDone}','')::date,
              nullif(v#>>'{pm,nextDue}','')::date, nullif(v->>'lastVisit','')::date)
      on conflict (id) do update set client_id=excluded.client_id, brand=excluded.brand, model=excluded.model,
        serial=excluded.serial, category=excluded.category, sub_category=excluded.sub_category, site=excluded.site,
        location=excluded.location, ink_set=excluded.ink_set, install_date=excluded.install_date,
        warranty_end=excluded.warranty_end, status=excluded.status, pm_interval_months=excluded.pm_interval_months,
        pm_last_done=excluded.pm_last_done, pm_next_due=excluded.pm_next_due, last_visit=excluded.last_visit;

    elsif p_collection = 'tickets' then
      cid := desk_client_id(v->>'clientId', nullif(v->>'newClientId',''), v->>'customer');
      insert into tickets(num, client_id, customer_name, machine_id, type, subtype, status, summary, model, created,
                          sched_date, sched_time, sched_hours, assigned_email, sample, updated_at)
      values ((d->>'id')::int, cid, v->>'customer',
              (select id from machines where id = nullif(v->>'assetId','')),
              v->>'type', nullif(v->>'subtype',''), v->>'status', v->>'summary', v->>'model',
              nullif(v->>'created','')::date, nullif(v->>'schedDate','')::date, nullif(v->>'schedTime',''),
              nullif(v->>'schedHours','')::numeric, nullif(lower(v->>'assignedTo'),''),
              coalesce((v->>'sample')::boolean, false), now())
      on conflict (num) do update set client_id=excluded.client_id, customer_name=excluded.customer_name,
        machine_id=excluded.machine_id, type=excluded.type, subtype=excluded.subtype, status=excluded.status,
        summary=excluded.summary, model=excluded.model, created=excluded.created, sched_date=excluded.sched_date,
        sched_time=excluded.sched_time, sched_hours=excluded.sched_hours, assigned_email=excluded.assigned_email,
        sample=excluded.sample, updated_at=now();
      insert into ticket_private(num, data) values ((d->>'id')::int, v)
      on conflict (num) do update set data = excluded.data;

    elsif p_collection = 'kb' then
      insert into kb_articles(id, brand, family, models, fault, resolution, keywords, parts, invoices, confidence)
      values (d->>'id', v->>'brand', v->>'family',
              array(select jsonb_array_elements_text(coalesce(v->'models','[]'))),
              coalesce(v->>'fault',''), coalesce(v->>'resolution',''),
              array(select jsonb_array_elements_text(coalesce(v->'keywords','[]'))),
              coalesce(v->'parts','[]'),
              array(select jsonb_array_elements_text(coalesce(v->'invoices','[]'))),
              v->>'confidence')
      on conflict (id) do update set brand=excluded.brand, family=excluded.family, models=excluded.models,
        fault=excluded.fault, resolution=excluded.resolution, keywords=excluded.keywords, parts=excluded.parts,
        invoices=excluded.invoices, confidence=excluded.confidence, updated_at=now();

    else
      insert into desk_docs(collection, id, data) values (p_collection, d->>'id', v)
      on conflict (collection, id) do update set data = excluded.data, updated_at = now();
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.desk_remove(p_collection text, p_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_collection = 'tickets' then delete from tickets where num = p_id::int;
  elsif p_collection = 'assets' then update machines set status = 'decommissioned' where id = p_id;
  elsif p_collection = 'kb' then delete from kb_articles where id = p_id;
  elsif p_collection = 'newclients' then null;  -- customers are never deleted by the sync
  else delete from desk_docs where collection = p_collection and id = p_id;
  end if;
end $$;

-- Sync helpers are only for the service desk (via the Supabase connector) – not callable from the portal.
revoke all on function public.desk_client_id(text,text,text), public.desk_sync(text,jsonb),
  public.desk_remove(text,text) from public, anon, authenticated;
