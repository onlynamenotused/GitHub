-- 1. Vector Converter export log: every file a signed-in user downloads from the vector tool.
create table if not exists public.vector_exports (
  id         bigint generated always as identity primary key,
  email      text not null,
  client_id  bigint references public.clients(id) on delete set null,
  kind       text not null,
  created_at timestamptz not null default now()
);
create index if not exists vector_exports_client on public.vector_exports(client_id);
alter table public.vector_exports enable row level security;   -- no direct access; functions below only

create or replace function public.log_vector_export(p_kind text) returns void
 language plpgsql security definer set search_path = public as $$
declare em text := public.current_email(); cid bigint;
begin
  if em = '' or not public.has_vector_access() then return; end if;
  select pa.client_id into cid from portal_access pa where lower(pa.email) = em order by (pa.role = 'customer') desc, pa.created_at limit 1;
  insert into vector_exports(email, client_id, kind) values (em, cid, left(coalesce(nullif(p_kind,''),'file'), 40));
end $$;
revoke all on function public.log_vector_export(text) from public, anon;
grant execute on function public.log_vector_export(text) to authenticated;

-- Staff: totals per customer (for the Customers page)
create or replace function public.vector_export_counts() returns jsonb
 language sql stable security definer set search_path = public as $$
  select case when public.is_staff() then coalesce((
    select jsonb_object_agg(coalesce(client_id::text, 'none'), jsonb_build_object('n', n, 'last', last, 'kinds', kinds))
      from (select client_id, count(*) n, max(created_at) last, jsonb_object_agg(kind, kc) kinds
              from (select client_id, kind, count(*) kc, max(created_at) created_at from vector_exports group by client_id, kind) k
             group by client_id) t), '{}'::jsonb) else '{}'::jsonb end
$$;
revoke all on function public.vector_export_counts() from public, anon;
grant execute on function public.vector_export_counts() to authenticated;

-- 2. Customer self-serve quotes from the Parts Catalogue: priced by the edge function from the live catalogue,
--    created in FreshBooks and emailed to the customer. At most 5 per customer per hour.
create table if not exists public.portal_quotes (
  id          bigint generated always as identity primary key,
  client_id   bigint not null references public.clients(id) on delete cascade,
  email       text not null,
  machine_id  text,
  request     jsonb not null,
  status      text not null default 'creating',   -- creating | sent | failed
  fb_id       text,
  fb_number   text,
  total       numeric,
  lines       jsonb,
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists portal_quotes_client_time on public.portal_quotes(client_id, created_at desc);
alter table public.portal_quotes enable row level security;
drop policy if exists quotes_read on public.portal_quotes;
create policy quotes_read on public.portal_quotes for select to authenticated using (
  public.is_staff() or client_id in (select public.my_client_ids()));

-- Step 1 (fast, as the signed-in customer): check access, the hourly limit and the machine, and queue the quote.
-- Step 2: the portal worker passes the quote id + one-time token to the edge function, which prices it from the live
-- catalogue, creates the estimate in FreshBooks and emails it (too slow for a database request).
alter table public.portal_quotes add column if not exists token text;
create or replace function public.portal_quote_start(p jsonb) returns jsonb
 language plpgsql security definer set search_path = public as $$
declare em text := public.current_email(); cid bigint; nm text; qid bigint; tok text; mach record; mid text; mj jsonb;
        items jsonb := coalesce(p->'items', '[]'::jsonb); fit boolean := coalesce((p->>'fit')::boolean, false);
        hrs numeric := least(greatest(round(coalesce((p->>'hours')::numeric, 1) * 2) / 2, 1), 16);
begin
  if em = '' then raise exception 'Please sign in again.'; end if;
  if not public.has_catalogue_access() then raise exception 'The Parts Catalogue isn''t turned on for your account.'; end if;
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 then raise exception 'Add at least one part to the quote.'; end if;
  if jsonb_array_length(items) > 60 then raise exception 'A quote can have up to 60 parts.'; end if;
  if nullif(p->>'machine_id','') is not null then
    select m.* into mach from machines m where m.id = p->>'machine_id'
       and m.client_id in (select pa.client_id from portal_access pa where lower(pa.email) = em and pa.role = 'customer');
    if not found then raise exception 'That machine isn''t on your account.'; end if;
    cid := mach.client_id; mid := mach.id;
    mj := jsonb_build_object('id', mach.id, 'brand', mach.brand, 'model', mach.model, 'serial', mach.serial,
                             'address', coalesce(nullif(trim(mach.location),''), nullif(trim(mach.site),'')));
  elsif fit then
    raise exception 'Choose the machine the parts are for, so we can work out the callout.';
  else
    select pa.client_id into cid from portal_access pa where lower(pa.email) = em and pa.role = 'customer' order by pa.created_at limit 1;
  end if;
  if cid is null then raise exception 'Online quotes are for customer logins. Please call us on 1300 880 815.'; end if;
  if cid >= 9000000 then raise exception 'Your account isn''t set up for online quotes yet. Please email hello@highwaydigital.com.au and we''ll send one.'; end if;
  if (select count(*) from portal_quotes where client_id = cid and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'You can create up to 5 quotes an hour. Please try again a little later, or call us on 1300 880 815.';
  end if;
  select coalesce(nullif(trim(full_name),''), '') into nm from portal_access where lower(email) = em order by created_at limit 1;
  tok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into portal_quotes(client_id, email, machine_id, status, token, request)
  values (cid, em, mid, 'queued', tok, jsonb_build_object('items', items, 'fit', fit, 'hours', hrs, 'name', nm,
          'brands', to_jsonb(public.my_catalogue_brands()), 'note', left(coalesce(p->>'note',''), 1000),
          'machine', mj))
  returning id into qid;
  return jsonb_build_object('quote_id', qid, 'token', tok);
end $$;
revoke all on function public.portal_quote_start(jsonb) from public, anon;
grant execute on function public.portal_quote_start(jsonb) to authenticated;

-- The portal worker asks this before handing the raw catalogue file to the edge function (which holds the bridge key).
create or replace function public.bridge_key_ok(p_key text) returns boolean
 language sql stable security definer set search_path = public, fbw as $$
  select coalesce(length(p_key) >= 20 and p_key = (select s.v from fbw.settings s where s.k = 'bridge_key'), false)
$$;
revoke all on function public.bridge_key_ok(text) from public;
grant execute on function public.bridge_key_ok(text) to anon, authenticated;
