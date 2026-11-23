-- Warranty parts returns: every part claimed on a warranty PO request (fbw.po_requests, kind 'warranty') is a
-- faulty part that may have to go back to the maker. One row per part, created automatically with the request.
-- Status: due -> sent (carrier / tracking) -> received; or not_required (maker says scrap it); cancelled with the claim.
-- Staff change anything (service desk and portal). The vendor (e.g. Mimaki) sees its own rows on its portal dashboard
-- and can mark a part received or not required.
create table if not exists public.warranty_returns (
  id bigserial primary key,
  request_id bigint not null,
  ticket_id text, ticket_num text, po_number text, request_status text,
  vendor text not null,
  customer text, client_id bigint, machine_id text, model text, serial text,
  part_code text, part_desc text, qty numeric not null default 1,
  claimed_at timestamptz not null default now(),
  due_by date,
  status text not null default 'due' check (status in ('due','sent','received','not_required','cancelled')),
  sent_on date, carrier text, tracking text, note text,
  updated_at timestamptz not null default now(), updated_by text,
  unique (request_id, part_code)
);
alter table public.warranty_returns enable row level security;

-- Per vendor login: show warranty parts returns or not (on by default).
alter table public.supervisor_access add column if not exists warranty_returns boolean not null default true;
-- Vendors (Bill to names) whose warranty returns this login may see.
create or replace function public.my_vendor_bills() returns setof text
language sql stable security definer set search_path = public as $$
  select lower(trim(s.bill_to)) from supervisors s join supervisor_access sa on sa.supervisor_id = s.id
   where s.enabled and s.bill_to is not null and sa.warranty_returns and lower(sa.email) = public.current_email()
$$;
grant execute on function public.my_vendor_bills() to authenticated;

drop policy if exists wr_staff on public.warranty_returns;
create policy wr_staff on public.warranty_returns for all to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists wr_vendor on public.warranty_returns;
create policy wr_vendor on public.warranty_returns for select to authenticated
  using (lower(trim(vendor)) in (select public.my_vendor_bills()));

-- Vendor logins: mark a part received / not required (or back to sent), with a note.
create or replace function public.vendor_return_update(p_id bigint, p_status text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r warranty_returns;
begin
  select * into r from warranty_returns where id = p_id;
  if r.id is null or not (public.is_staff() or lower(trim(r.vendor)) in (select public.my_vendor_bills())) then
    return jsonb_build_object('ok', false, 'error', 'Not allowed');
  end if;
  if p_status not in ('received','not_required','sent') then return jsonb_build_object('ok', false, 'error', 'Unknown status'); end if;
  update warranty_returns set status = p_status, note = coalesce(nullif(trim(p_note),''), note), updated_at = now(), updated_by = public.current_email()
   where id = p_id;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.vendor_return_update(bigint, text, text) to authenticated;

-- Rows from a warranty request (insert), and keep PO number / claim status in step (update).
create or replace function public.warranty_returns_from_request() returns trigger
language plpgsql security definer set search_path = public as $$
declare p jsonb := coalesce(new.payload, '{}'::jsonb); part jsonb; cid bigint;
begin
  if new.kind is distinct from 'warranty' then return new; end if;
  if tg_op = 'INSERT' then
    select c.id into cid from clients c where lower(c.name) = lower(trim(p->>'customer')) limit 1;
    for part in select * from jsonb_array_elements(coalesce(p->'parts','[]'::jsonb)) loop
      continue when coalesce((part->>'billable')::boolean, false);   -- customer-paid parts aren't claimed back
      insert into warranty_returns (request_id, ticket_id, ticket_num, po_number, request_status, vendor, customer, client_id, machine_id, model, serial,
                                    part_code, part_desc, qty, claimed_at, due_by)
      values (new.id, new.ticket_id, new.ticket_num, new.po_number, new.status, coalesce(nullif(new.vendor,''), p->>'vendor', ''),
              p->>'customer', cid, nullif(p->>'assetId',''), p->>'model', p->>'serial',
              coalesce(part->>'code',''), part->>'desc', coalesce((part->>'qty')::numeric, 1), new.created_at, (new.created_at + interval '30 days')::date)
      on conflict (request_id, part_code) do nothing;
    end loop;
  else
    update warranty_returns set po_number = new.po_number, request_status = new.status,
           status = case when new.status = 'cancelled' and status = 'due' then 'cancelled' else status end, updated_at = now()
     where request_id = new.id and (po_number is distinct from new.po_number or request_status is distinct from new.status);
  end if;
  return new;
end $$;
drop trigger if exists po_requests_warranty_returns on fbw.po_requests;
create trigger po_requests_warranty_returns after insert or update on fbw.po_requests
  for each row execute function public.warranty_returns_from_request();

-- Existing claims
insert into public.warranty_returns (request_id, ticket_id, ticket_num, po_number, request_status, vendor, customer, client_id, machine_id, model, serial,
                                     part_code, part_desc, qty, claimed_at, due_by)
select r.id, r.ticket_id, r.ticket_num, r.po_number, r.status, coalesce(nullif(r.vendor,''), r.payload->>'vendor', ''),
       r.payload->>'customer', (select c.id from clients c where lower(c.name) = lower(trim(r.payload->>'customer')) limit 1),
       nullif(r.payload->>'assetId',''), r.payload->>'model', r.payload->>'serial',
       coalesce(pt->>'code',''), pt->>'desc', coalesce((pt->>'qty')::numeric, 1), r.created_at, (r.created_at + interval '30 days')::date
  from fbw.po_requests r cross join lateral jsonb_array_elements(coalesce(r.payload->'parts','[]'::jsonb)) pt
 where r.kind = 'warranty' and not coalesce((pt->>'billable')::boolean, false)
on conflict (request_id, part_code) do nothing;

-- Menu flag for the dashboard card
create or replace function public.has_warranty_returns() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff() or exists (select public.my_vendor_bills())
$$;
grant execute on function public.has_warranty_returns() to authenticated;
