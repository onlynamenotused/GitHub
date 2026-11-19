-- Portal booking: customers pick a real free slot; the service desk turns it into a ticket.
-- Slots are published by the service desk (Outlook + service desk schedule), one set per job length.

create table if not exists public.portal_slots (
  slot_start   timestamptz not null,
  slot_end     timestamptz not null,
  hours        numeric not null,          -- job length this slot was worked out for (2 = fault, 4.5 = service/install)
  published_at timestamptz not null default now(),
  primary key (slot_start, hours)
);
alter table public.portal_slots enable row level security;
drop policy if exists slots_read on public.portal_slots;
create policy slots_read on public.portal_slots for select to authenticated using (
  public.is_staff() or exists (select 1 from public.portal_access pa
                               where lower(pa.email) = public.current_email() and pa.role = 'customer'));

create table if not exists public.portal_bookings (
  id           bigint generated always as identity primary key,
  client_id    bigint not null references public.clients(id) on delete cascade,
  machine_id   text references public.machines(id) on update cascade on delete set null,
  kind         text not null check (kind in ('service','fault','install')),
  description  text,
  contact_name text,
  phone        text,
  email        text not null,
  slot_start   timestamptz not null,
  slot_end     timestamptz not null,
  status       text not null default 'pending' check (status in ('pending','booked','clash','cancelled')),
  ticket_num   int,
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists portal_bookings_slot_live on public.portal_bookings(slot_start)
  where status in ('pending','booked');
alter table public.portal_bookings enable row level security;
drop policy if exists bookings_read on public.portal_bookings;
create policy bookings_read on public.portal_bookings for select to authenticated using (
  public.is_staff() or client_id in (select public.my_client_ids()));

-- Customer books a slot (the only way to write a booking)
create or replace function public.book_slot(p_machine text, p_slot timestamptz, p_kind text,
                                            p_desc text, p_name text, p_phone text)
returns bigint language plpgsql security definer set search_path = public as $$
declare em text := public.current_email(); cid bigint; s portal_slots; want numeric; bid bigint;
begin
  if em = '' then raise exception 'Please sign in again.'; end if;
  if p_kind not in ('service','fault','install') then raise exception 'Choose what the visit is for.'; end if;
  select m.client_id into cid from machines m
   where m.id = p_machine and m.status = 'active'
     and exists (select 1 from portal_access pa where lower(pa.email) = em and pa.client_id = m.client_id and pa.role = 'customer');
  if cid is null then raise exception 'That machine isn''t on your account.'; end if;
  if (select count(*) from portal_bookings where client_id = cid and status = 'pending') >= 3 then
    raise exception 'You already have 3 bookings waiting for confirmation. Please call us on 1300 880 815.';
  end if;
  want := case p_kind when 'fault' then 2 else 4.5 end;
  select * into s from portal_slots where slot_start = p_slot and hours = want and slot_start > now() + interval '12 hours';
  if not found then raise exception 'Sorry, that time is no longer available. Please pick another.'; end if;
  begin
    insert into portal_bookings(client_id, machine_id, kind, description, contact_name, phone, email, slot_start, slot_end)
    values (cid, p_machine, p_kind, left(coalesce(p_desc,''),2000), left(p_name,120), left(p_phone,40), em, s.slot_start, s.slot_end)
    returning id into bid;
  exception when unique_violation then
    raise exception 'Sorry, that time was just taken. Please pick another.';
  end;
  delete from portal_slots where tstzrange(slot_start, slot_end) && tstzrange(s.slot_start, s.slot_end);
  return bid;
end $$;
revoke all on function public.book_slot(text,timestamptz,text,text,text,text) from public, anon;
grant execute on function public.book_slot(text,timestamptz,text,text,text,text) to authenticated;

-- One call for the menu on every page (used by the app and by the KB/catalogue worker)
create or replace function public.portal_menu()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'email', public.current_email(),
    'staff', public.is_staff(),
    'intranet', public.is_intranet(),
    'kb', public.has_kb_access(),
    'cat', public.has_catalogue_access(),
    'customer', exists (select 1 from portal_access pa where lower(pa.email) = public.current_email() and pa.role = 'customer'))
$$;
revoke all on function public.portal_menu() from public, anon;
grant execute on function public.portal_menu() to authenticated;

-- ---------- service desk side (Supabase connector only) ----------
create or replace function public.desk_publish_slots(p jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from portal_slots;
  insert into portal_slots(slot_start, slot_end, hours)
  select (x->>'start')::timestamptz, (x->>'end')::timestamptz, (x->>'hours')::numeric
    from jsonb_array_elements(p) x
   where not exists (select 1 from portal_bookings b where b.status in ('pending','booked')
                       and tstzrange(b.slot_start, b.slot_end) && tstzrange((x->>'start')::timestamptz, (x->>'end')::timestamptz))
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.desk_pending_bookings()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id, 'kind', b.kind, 'description', b.description, 'contact', b.contact_name, 'phone', b.phone,
    'email', b.email, 'start', b.slot_start, 'end', b.slot_end,
    'client_id', c.id, 'client_name', c.name, 'desk_ref', c.desk_ref,
    'machine_id', m.id, 'brand', m.brand, 'model', m.model, 'serial', m.serial, 'location', m.location)
    order by b.created_at), '[]'::jsonb)
  from portal_bookings b join clients c on c.id = b.client_id left join machines m on m.id = b.machine_id
  where b.status = 'pending'
$$;

create or replace function public.desk_booking_done(p_id bigint, p_status text, p_ticket int, p_note text)
returns void language sql security definer set search_path = public as $$
  update portal_bookings set status = p_status, ticket_num = p_ticket, note = p_note, updated_at = now() where id = p_id
$$;

revoke all on function public.desk_publish_slots(jsonb), public.desk_pending_bookings(),
  public.desk_booking_done(bigint,text,int,text) from public, anon, authenticated;
