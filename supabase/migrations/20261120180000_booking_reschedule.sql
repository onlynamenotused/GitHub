-- Customers can move a portal booking to another free time (up to 24 hours before the current time).
-- Pending bookings just change time. Booked (or clashed) bookings are flagged so the service desk moves the ticket
-- and its Outlook calendar event. Staff moving a portal ticket in the service desk updates the booking here too.
alter table public.portal_bookings add column if not exists resync boolean not null default false;
alter table public.portal_bookings add column if not exists moved_from timestamptz;
alter table public.portal_bookings add column if not exists moved_at timestamptz;

create or replace function public.reschedule_booking(p_id bigint, p_slot timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare em text := public.current_email(); b portal_bookings; s portal_slots; want numeric;
begin
  if em = '' then raise exception 'Please sign in again.'; end if;
  select * into b from portal_bookings where id = p_id
     and client_id in (select pa.client_id from portal_access pa where lower(pa.email) = em and pa.role = 'customer')
     for update;
  if not found then raise exception 'That booking isn''t on your account.'; end if;
  if b.status not in ('pending','booked','clash') then raise exception 'That booking can''t be changed online. Please call us on 1300 880 815.'; end if;
  if b.status <> 'clash' and b.slot_start < now() + interval '24 hours' then
    raise exception 'Your booking is less than 24 hours away, so it can''t be changed online. Please call us on 1300 880 815.';
  end if;
  want := case b.kind when 'fault' then 2 else 4.5 end;
  select * into s from portal_slots where slot_start = p_slot and hours = want and slot_start > now() + interval '12 hours';
  if not found then raise exception 'Sorry, that time is no longer available. Please pick another.'; end if;
  if b.kind = 'service' and (s.slot_start at time zone 'Australia/Perth')::date < public.earliest_service_date() then
    raise exception 'Scheduled services need at least 5 business days'' notice so we can have parts ready. Please pick a day from % onwards.', to_char(public.earliest_service_date(), 'FMDay FMDD FMMonth');
  end if;
  begin
    update portal_bookings
       set moved_from = b.slot_start, moved_at = now(), slot_start = s.slot_start, slot_end = s.slot_end,
           resync = (b.status in ('booked','clash')) or b.resync, updated_at = now()
     where id = b.id;
  exception when unique_violation then
    raise exception 'Sorry, that time was just taken. Please pick another.';
  end;
  delete from portal_slots where tstzrange(slot_start, slot_end) && tstzrange(s.slot_start, s.slot_end);
end $$;
revoke all on function public.reschedule_booking(bigint, timestamptz) from public, anon;
grant execute on function public.reschedule_booking(bigint, timestamptz) to authenticated;

-- ---------- service desk side (Supabase connector only) ----------
create or replace function public.desk_pending_moves()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id, 'ticket_num', b.ticket_num, 'status', b.status, 'kind', b.kind, 'start', b.slot_start, 'end', b.slot_end,
    'moved_from', b.moved_from, 'client_name', c.name, 'email', b.email) order by b.moved_at), '[]'::jsonb)
  from portal_bookings b join clients c on c.id = b.client_id
  where b.resync
$$;

create or replace function public.desk_booking_moved(p_id bigint, p_ticket int)
returns void language sql security definer set search_path = public as $$
  update portal_bookings set resync = false, status = 'booked', ticket_num = coalesce(p_ticket, ticket_num), note = null, updated_at = now()
   where id = p_id
$$;

-- Staff moved (or unbooked) the ticket in the service desk: keep the customer's booking in step.
create or replace function public.desk_booking_set_time(p_id bigint, p_start timestamptz, p_end timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_start is null then
    update portal_bookings set status = 'clash', note = 'We''ll be in touch to arrange another time.', resync = false, updated_at = now()
     where id = p_id and status in ('pending','booked');
    return;
  end if;
  begin
    update portal_bookings set slot_start = p_start, slot_end = p_end, status = 'booked', resync = false, note = null, updated_at = now()
     where id = p_id and (slot_start is distinct from p_start or slot_end is distinct from p_end or status <> 'booked');
  exception when unique_violation then
    null;   -- another live booking already holds that exact start; leave this one as it was
  end;
end $$;

revoke all on function public.desk_pending_moves(), public.desk_booking_moved(bigint,int),
  public.desk_booking_set_time(bigint,timestamptz,timestamptz) from public, anon, authenticated;

-- ---------- scheduled services need notice so parts can be ordered ----------
-- A scheduled service (kind 'service') booked or moved by the customer can't fall within 5 business days
-- (Mon–Fri) of the day they book: the earliest day is the 6th business day after today (Perth time).
create or replace function public.earliest_service_date() returns date
 language plpgsql stable set search_path = public as $$
declare d date := (now() at time zone 'Australia/Perth')::date; n int := 0;
begin
  while n < 6 loop
    d := d + 1;
    if extract(isodow from d) < 6 then n := n + 1; end if;
  end loop;
  return d;
end $$;
grant execute on function public.earliest_service_date() to authenticated;

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
  if p_kind = 'service' and (s.slot_start at time zone 'Australia/Perth')::date < public.earliest_service_date() then
    raise exception 'Scheduled services need at least 5 business days'' notice so we can have parts ready. Please pick a day from % onwards.', to_char(public.earliest_service_date(), 'FMDay FMDD FMMonth');
  end if;
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
