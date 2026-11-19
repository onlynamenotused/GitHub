-- Highway Service Desk: core schema (single database for staff service desk + customer portal)
-- Project: highway-portal (Sydney). Apply once in the SQL editor or via `supabase db push`.
--
-- Design notes
-- * Every table keeps the original service-desk record in `data` (jsonb) so nothing is lost,
--   plus typed columns that the portal filters on and that row-level security uses.
-- * Customers never read `data` or any other confidential column directly: column-level
--   grants expose only safe columns to the `authenticated` role, and RLS limits rows.
-- * Staff = hello@highwaydigital.com.au (role 'staff' in portal_users).

create extension if not exists pgcrypto;

-- ---------- Who can sign in, and as what ----------
create table if not exists public.portal_users (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  email        text not null unique,
  role         text not null check (role in ('staff','customer','subcontractor')),
  customer_id  text,                 -- set for role = customer
  display_name text,
  created_at   timestamptz not null default now()
);

-- Helper functions (security definer so RLS policies can call them without recursion)
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as
$$ select role from public.portal_users where user_id = auth.uid() $$;

create or replace function public.my_customer_id() returns text
language sql stable security definer set search_path = public as
$$ select customer_id from public.portal_users where user_id = auth.uid() $$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce((select role = 'staff' from public.portal_users where user_id = auth.uid()), false) $$;

-- ---------- Customers ----------
-- id: 'fb-<FreshBooks client id>' for FreshBooks clients, or the service desk's 'NC-…' id for new clients
create table if not exists public.customers (
  id                text primary key,
  freshbooks_id     bigint unique,
  name              text not null,
  email             text,
  phone             text,
  suburb            text,
  kb_access         boolean not null default false,  -- staff checkbox: customer KB visible
  catalogue_access  boolean not null default false,  -- staff checkbox: parts catalogue visible
  portal_enabled    boolean not null default false,
  data              jsonb not null default '{}'::jsonb,
  updated_at        timestamptz not null default now()
);

-- ---------- Machines (asset register) ----------
create table if not exists public.machines (
  id               text primary key,          -- service desk asset id, e.g. at-…, fb-…, hd-…
  customer_id      text references public.customers(id) on update cascade on delete set null,
  customer_name    text,
  brand            text,
  model            text,
  serial           text,
  category         text,
  sub_category     text,
  location         text,
  status           text,                      -- active / inactive / decommissioned
  pm_interval      int,                       -- months; 0 = exempt
  pm_next_due      date,
  pm_last_done     date,
  purchase_date    date,
  warranty_end     date,
  data             jsonb not null default '{}'::jsonb,
  updated_at       timestamptz not null default now()
);
create index if not exists machines_customer_idx on public.machines(customer_id);

-- ---------- Tickets ----------
create table if not exists public.tickets (
  num              int primary key check (num between 1000000 and 9999999), -- 7-digit numbers only
  customer_id      text references public.customers(id) on update cascade on delete set null,
  customer_name    text,
  machine_id       text references public.machines(id) on update cascade on delete set null,
  type             text check (type in ('incident','request','problem')),
  subtype          text,
  status           text,
  summary          text,
  description      text,
  model            text,
  error_code       text,
  created          date,
  sched_date       date,
  sched_time       text,
  sched_hours      numeric,
  assigned_to      uuid references public.portal_users(user_id) on delete set null, -- sub-contractor
  sample           boolean not null default false,
  data             jsonb not null default '{}'::jsonb,  -- billing lines, invoice links, notes (staff only)
  updated_at       timestamptz not null default now()
);
create index if not exists tickets_customer_idx on public.tickets(customer_id);
create index if not exists tickets_assigned_idx on public.tickets(assigned_to);

-- ---------- Knowledge base ----------
create table if not exists public.kb_articles (
  id          text primary key,
  brand       text,
  family      text,
  models      text[],
  code        text,
  fault       text,
  resolution  text,
  confidence  text,
  visibility  text not null default 'intranet' check (visibility in ('intranet','customer')),
  data        jsonb not null default '{}'::jsonb,   -- invoice numbers, hit counts (staff only)
  updated_at  timestamptz not null default now()
);

-- ---------- Parts / inventory (also feeds the customer catalogue) ----------
create table if not exists public.parts (
  id            text primary key,
  part          text not null,
  description   text,
  maker         text,
  model         text,
  sell_ex_gst   numeric,
  in_catalogue  boolean not null default false,   -- show in customer catalogue
  superseded_by text,
  data          jsonb not null default '{}'::jsonb, -- buy price, stock counts (staff only)
  updated_at    timestamptz not null default now()
);

-- ---------- Everything else the service desk keeps (meta, outbox, stock moves, …) ----------
create table if not exists public.desk_docs (
  collection  text not null,
  id          text not null,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (collection, id)
);

-- ---------- Row-level security ----------
alter table public.portal_users enable row level security;
alter table public.customers    enable row level security;
alter table public.machines     enable row level security;
alter table public.tickets      enable row level security;
alter table public.kb_articles  enable row level security;
alter table public.parts        enable row level security;
alter table public.desk_docs    enable row level security;

-- staff: full access everywhere
do $$ declare t text; begin
  foreach t in array array['portal_users','customers','machines','tickets','kb_articles','parts','desk_docs'] loop
    execute format('drop policy if exists staff_all on public.%I', t);
    execute format('create policy staff_all on public.%I for all to authenticated using (public.is_staff()) with check (public.is_staff())', t);
  end loop;
end $$;

-- everyone signed in can read their own portal_users row
drop policy if exists own_row on public.portal_users;
create policy own_row on public.portal_users for select to authenticated using (user_id = auth.uid());

-- customers: own record, machines and tickets only
drop policy if exists customer_self on public.customers;
create policy customer_self on public.customers for select to authenticated
  using (id = public.my_customer_id() and portal_enabled);

drop policy if exists customer_machines on public.machines;
create policy customer_machines on public.machines for select to authenticated
  using (customer_id = public.my_customer_id() and status <> 'decommissioned');

drop policy if exists customer_tickets on public.tickets;
create policy customer_tickets on public.tickets for select to authenticated
  using (customer_id = public.my_customer_id() and not sample);

-- sub-contractors: only tickets assigned to them (and the machine/customer on those tickets)
drop policy if exists sub_tickets on public.tickets;
create policy sub_tickets on public.tickets for select to authenticated
  using (public.my_role() = 'subcontractor' and assigned_to = auth.uid());

drop policy if exists sub_machines on public.machines;
create policy sub_machines on public.machines for select to authenticated
  using (public.my_role() = 'subcontractor' and exists
    (select 1 from public.tickets t where t.machine_id = machines.id and t.assigned_to = auth.uid()));

-- customer knowledge base: only customer-visible articles, only when staff ticked kb_access
drop policy if exists customer_kb on public.kb_articles;
create policy customer_kb on public.kb_articles for select to authenticated
  using (visibility = 'customer' and exists
    (select 1 from public.customers c where c.id = public.my_customer_id() and c.kb_access));

-- parts catalogue: only catalogue items, only when staff ticked catalogue_access
drop policy if exists customer_catalogue on public.parts;
create policy customer_catalogue on public.parts for select to authenticated
  using (in_catalogue and exists
    (select 1 from public.customers c where c.id = public.my_customer_id() and c.catalogue_access));

-- ---------- Column-level privacy ----------
-- Non-staff roles can only ever see these columns; `data` (invoice numbers, notes, buy prices) stays hidden.
revoke all on public.customers, public.machines, public.tickets, public.kb_articles, public.parts, public.desk_docs from anon, authenticated;

grant select (id, name, email, phone, suburb, kb_access, catalogue_access) on public.customers to authenticated;
grant select (id, customer_id, customer_name, brand, model, serial, category, sub_category, location, status,
              pm_interval, pm_next_due, pm_last_done, purchase_date, warranty_end) on public.machines to authenticated;
grant select (num, customer_id, machine_id, type, subtype, status, summary, model, created,
              sched_date, sched_time, assigned_to) on public.tickets to authenticated;
grant select (id, brand, family, models, code, fault, resolution, visibility) on public.kb_articles to authenticated;
grant select (id, part, description, maker, model, sell_ex_gst, in_catalogue, superseded_by) on public.parts to authenticated;

-- Staff work through security-definer RPCs or the service role (used by the service desk sync),
-- so they don't need the full-table grant on the authenticated role.

-- ---------- Sync helper: one call upserts a batch from the service desk ----------
-- Called by the service desk (through the Supabase connector) on every save, and once for the initial copy.
create or replace function public.desk_upsert(p_collection text, p_docs jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare d jsonb; n int := 0; v jsonb; cid text;
begin
  for d in select * from jsonb_array_elements(p_docs) loop
    v := d->'data';
    if p_collection = 'tickets' then
      cid := case when nullif(v->>'clientId','') is not null then 'fb-'||(v->>'clientId')
                  when nullif(v->>'newClientId','') is not null then v->>'newClientId' end;
      insert into tickets(num, customer_id, customer_name, machine_id, type, subtype, status, summary, description,
                          model, error_code, created, sched_date, sched_time, sched_hours, sample, data, updated_at)
      values ((d->>'id')::int,
              (select id from customers where id = cid),
              v->>'customer',
              (select id from machines where id = nullif(v->>'assetId','')),
              v->>'type', nullif(v->>'subtype',''), v->>'status', v->>'summary', v->>'description',
              v->>'model', nullif(v->>'errorCode',''),
              nullif(v->>'created','')::date, nullif(v->>'schedDate','')::date, nullif(v->>'schedTime',''),
              nullif(v->>'schedHours','')::numeric, coalesce((v->>'sample')::boolean,false), v, now())
      on conflict (num) do update set customer_id=excluded.customer_id, customer_name=excluded.customer_name,
        machine_id=excluded.machine_id, type=excluded.type, subtype=excluded.subtype, status=excluded.status,
        summary=excluded.summary, description=excluded.description, model=excluded.model,
        error_code=excluded.error_code, created=excluded.created, sched_date=excluded.sched_date,
        sched_time=excluded.sched_time, sched_hours=excluded.sched_hours, sample=excluded.sample,
        data=excluded.data, updated_at=now();

    elsif p_collection = 'assets' then
      cid := case when nullif(v->>'clientId','') is not null then 'fb-'||(v->>'clientId') end;
      if cid is not null then
        insert into customers(id, freshbooks_id, name) values (cid, (v->>'clientId')::bigint, v->>'customer')
        on conflict (id) do nothing;
      end if;
      insert into machines(id, customer_id, customer_name, brand, model, serial, category, sub_category, location, status,
                           pm_interval, pm_next_due, pm_last_done, purchase_date, warranty_end, data, updated_at)
      values (d->>'id', cid, v->>'customer', v->>'brand', v->>'model', nullif(v->>'serial',''),
              v->>'category', nullif(v->>'subCategory',''), nullif(v->>'location',''), v->>'status',
              nullif(v#>>'{pm,interval}','')::int, nullif(v#>>'{pm,nextDue}','')::date,
              nullif(v#>>'{pm,lastDone}','')::date, nullif(v->>'purchaseDate','')::date,
              nullif(v->>'warrantyEnd','')::date, v, now())
      on conflict (id) do update set customer_id=excluded.customer_id, customer_name=excluded.customer_name,
        brand=excluded.brand, model=excluded.model, serial=excluded.serial, category=excluded.category,
        sub_category=excluded.sub_category, location=excluded.location, status=excluded.status,
        pm_interval=excluded.pm_interval, pm_next_due=excluded.pm_next_due, pm_last_done=excluded.pm_last_done,
        purchase_date=excluded.purchase_date, warranty_end=excluded.warranty_end, data=excluded.data, updated_at=now();

    elsif p_collection = 'newclients' then
      insert into customers(id, freshbooks_id, name, email, phone, suburb, data, updated_at)
      values (d->>'id', nullif(v->>'fbClientId','')::bigint, v->>'name', nullif(v->>'email',''),
              nullif(coalesce(nullif(v->>'mobile',''), v->>'phone'),''), nullif(v->>'suburb',''), v, now())
      on conflict (id) do update set freshbooks_id=excluded.freshbooks_id, name=excluded.name, email=excluded.email,
        phone=excluded.phone, suburb=excluded.suburb, data=excluded.data, updated_at=now();

    elsif p_collection = 'fbclients' then   -- FreshBooks client list cached by the service desk
      insert into customers(id, freshbooks_id, name, email, phone, data, updated_at)
      values ('fb-'||(v->>'id'), (v->>'id')::bigint, coalesce(nullif(v->>'organization',''), v->>'name'),
              nullif(v->>'email',''), nullif(v->>'phone',''), v, now())
      on conflict (id) do update set name=excluded.name, email=coalesce(excluded.email, customers.email),
        phone=coalesce(excluded.phone, customers.phone), data=excluded.data, updated_at=now();

    elsif p_collection = 'kb' then
      insert into kb_articles(id, brand, family, models, code, fault, resolution, confidence, data, updated_at)
      values (d->>'id', v->>'brand', v->>'family',
              array(select jsonb_array_elements_text(coalesce(v->'models','[]'::jsonb))),
              nullif(v->>'code',''), v->>'fault', v->>'resolution', v->>'confidence', v, now())
      on conflict (id) do update set brand=excluded.brand, family=excluded.family, models=excluded.models,
        code=excluded.code, fault=excluded.fault, resolution=excluded.resolution,
        confidence=excluded.confidence, data=excluded.data, updated_at=now();

    elsif p_collection = 'inventory' then
      insert into parts(id, part, description, maker, model, sell_ex_gst, superseded_by, data, updated_at)
      values (d->>'id', v->>'part', v->>'desc', v->>'maker', nullif(v->>'model',''),
              nullif(v->>'sell','')::numeric, nullif(v->>'supersededBy',''), v, now())
      on conflict (id) do update set part=excluded.part, description=excluded.description, maker=excluded.maker,
        model=excluded.model, sell_ex_gst=excluded.sell_ex_gst, superseded_by=excluded.superseded_by,
        data=excluded.data, updated_at=now();

    else
      insert into desk_docs(collection, id, data, updated_at) values (p_collection, d->>'id', v, now())
      on conflict (collection, id) do update set data=excluded.data, updated_at=now();
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.desk_delete(p_collection text, p_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  case p_collection
    when 'tickets'    then delete from tickets where num = p_id::int;
    when 'assets'     then delete from machines where id = p_id;
    when 'kb'         then delete from kb_articles where id = p_id;
    when 'inventory'  then delete from parts where id = p_id;
    when 'newclients' then delete from customers where id = p_id and not exists
                             (select 1 from machines m where m.customer_id = p_id);
    else delete from desk_docs where collection = p_collection and id = p_id;
  end case;
end $$;

-- Only staff sessions or the service role (connector / server) may call the sync helpers.
revoke all on function public.desk_upsert(text, jsonb), public.desk_delete(text, text) from public, anon, authenticated;
