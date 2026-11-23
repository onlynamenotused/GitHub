-- Vendor portal access by invoice (Mimaki now; Brother, Mutoh, Alfex ready to switch on).
-- A vendor with scope 'invoiced' sees every job billed to it, for any customer: its FreshBooks invoices
-- (service_records synced from the vendor's FreshBooks client) and service desk tickets whose Bill to is the vendor.
-- It sees only those jobs' customers and machines, not the customers' whole fleets (that is scope 'fleet', e.g. Avery Dennison).
-- Logins: emails in supervisor_access, or anyone signing in with an address at one of login_domains (e.g. mimaki.com).
-- enabled = false switches a vendor off without deleting it.

alter table public.supervisors
  add column if not exists scope text not null default 'fleet',
  add column if not exists enabled boolean not null default true,
  add column if not exists login_domains text[] not null default '{}';
do $$ begin
  alter table public.supervisors add constraint supervisors_scope_chk check (scope in ('fleet','invoiced'));
exception when duplicate_object then null; end $$;

create or replace function public.my_supervisor_ids() returns setof bigint
language sql stable security definer set search_path = public as $$
  select s.id from supervisors s
   where s.enabled and public.current_email() <> '' and (
     exists (select 1 from supervisor_access sa where sa.supervisor_id = s.id and lower(sa.email) = public.current_email())
     or split_part(public.current_email(), '@', 2) = any (select lower(d) from unnest(s.login_domains) d))
$$;
create or replace function public.is_supervisor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.my_supervisor_ids())
$$;

-- Jobs billed to my invoiced-scope vendors
create or replace function public.vendor_ticket_nums() returns setof bigint
language sql stable security definer set search_path = public as $$
  select t.num from tickets t join ticket_private p on p.num = t.num
   where not t.sample
     and lower(trim(coalesce(p.data->>'billTo',''))) in (
       select lower(trim(s.bill_to)) from supervisors s
        where s.scope = 'invoiced' and s.bill_to is not null and s.id in (select public.my_supervisor_ids()))
$$;
create or replace function public.vendor_client_ids() returns setof bigint
language sql stable security definer set search_path = public as $$
  select r.client_id from service_records r
   where r.client_id is not null and r.supervisor_id in (select s.id from supervisors s where s.scope = 'invoiced' and s.id in (select public.my_supervisor_ids()))
  union
  select t.client_id from tickets t where t.client_id is not null and t.num in (select public.vendor_ticket_nums())
$$;
create or replace function public.vendor_machine_ids() returns setof text
language sql stable security definer set search_path = public as $$
  select r.machine_id from service_records r
   where r.machine_id is not null and r.supervisor_id in (select s.id from supervisors s where s.scope = 'invoiced' and s.id in (select public.my_supervisor_ids()))
  union
  select t.machine_id from tickets t where t.machine_id is not null and t.num in (select public.vendor_ticket_nums())
$$;
grant execute on function public.vendor_ticket_nums(), public.vendor_client_ids(), public.vendor_machine_ids() to authenticated;

drop policy if exists clients_vendor on public.clients;
create policy clients_vendor on public.clients for select to authenticated using (id in (select public.vendor_client_ids()));
drop policy if exists machines_vendor on public.machines;
create policy machines_vendor on public.machines for select to authenticated using (id in (select public.vendor_machine_ids()));
drop policy if exists tickets_vendor on public.tickets;
create policy tickets_vendor on public.tickets for select to authenticated using (num in (select public.vendor_ticket_nums()));

-- Fleet reports job list: fleet supervisors as before, plus jobs billed to an invoiced-scope vendor.
create or replace function public.supervisor_jobs()
 returns jsonb language sql stable security definer set search_path = public as $function$
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
    or t.machine_id in (select m.id from machines m where m.supervisor_id in (select public.my_supervisor_ids()))
    or t.num in (select public.vendor_ticket_nums()))
$function$;

-- Linking a vendor's invoices to the end customer and machine.
-- Fleet vendors: only their contracted customers (as before). Invoiced vendors: any customer —
-- a machine serial on the invoice, then "End user: <name>" in the notes (the service desk writes this), then a customer name.
create or replace function public.service_records_link(p_sup bigint)
 returns integer language plpgsql security definer set search_path = public as $function$
declare r record; txt text; cid bigint; mid text; k text; n int := 0; sc text; eu text;
begin
  select scope into sc from supervisors where id = p_sup;
  for r in select * from service_records where supervisor_id = p_sup loop
    txt := lower(coalesce(r.po,'') || ' ' || coalesce(r.notes,'') || ' ' ||
           coalesce((select string_agg(coalesce(l->>'desc','') || ' ' || coalesce(l->>'code',''), ' ') from jsonb_array_elements(r.lines) l), ''));
    k := case when txt ~ 'install' then 'install'
              when exists (select 1 from jsonb_array_elements(r.lines) l where (l->>'code') ~* 'labou?r|hourly|callout|call-out|day rate|service') then 'service'
              else 'parts' end;
    if r.link_locked then
      update service_records set kind = k where id = r.id and kind is distinct from k;
      continue;
    end if;
    cid := null; mid := null;
    if sc = 'invoiced' then
      -- 0. a service desk ticket that this invoice was raised from (the desk records the invoice number on the ticket)
      select t.client_id, t.machine_id into cid, mid from tickets t join ticket_private p on p.num = t.num
       where t.client_id is not null and exists (select 1 from jsonb_array_elements_text(coalesce(p.data->'linked','[]')) x
                                                 where ltrim(x,'0') = ltrim(coalesce(r.number,''),'0') and ltrim(x,'0') <> '')
       order by t.num desc limit 1;
      if cid is null then
      select m.id, m.client_id into mid, cid from machines m
       where m.serial is not null and length(public.norm_serial(m.serial)) >= 5
         and position(public.norm_serial(m.serial) in public.norm_serial(txt)) > 0
       order by length(public.norm_serial(m.serial)) desc limit 1;
      if cid is null then
        eu := lower(trim(substring(coalesce(r.notes,'') || E'\n' || coalesce((select string_agg(coalesce(l->>'desc',''), E'\n') from jsonb_array_elements(r.lines) l), '')
                                   from '(?i)end user:[ \t]*([^\n\r]+)')));
        if coalesce(eu,'') <> '' then
          select c.id into cid from clients c where lower(c.name) = eu limit 1;
          if cid is null then
            select c.id into cid from clients c where length(c.name) >= 5 and (eu like '%' || lower(c.name) || '%' or lower(c.name) like '%' || eu || '%')
             order by length(c.name) desc limit 1;
          end if;
        end if;
      end if;
      if cid is null then
        select c.id into cid from clients c
         where length(c.name) >= 6 and c.id <> coalesce((select fb_client_id from supervisors where id = p_sup), -1)
           and txt like '%' || lower(c.name) || '%'
         order by length(c.name) desc limit 1;
      end if;
      -- trading name after "T/As", or the first two words of a customer's name, when only one customer fits
      if cid is null then
        select min(x.id) into cid from (
          select c.id, lower(trim(coalesce(nullif(substring(c.name from '(?i)\mt/?as?\M\s*(.+)$'),''), c.name))) nm from clients c
           where c.id <> coalesce((select fb_client_id from supervisors where id = p_sup), -1)) x
         where length(split_part(x.nm,' ',1) || ' ' || split_part(x.nm,' ',2)) >= 8 and split_part(x.nm,' ',2) <> ''
           and txt ~ ('\m' || regexp_replace(split_part(x.nm,' ',1) || ' ' || split_part(x.nm,' ',2), '([.^$*+?()\[\]{}|\\])', '\\\1', 'g') || '\M')
        having count(distinct x.id) = 1;
      end if;
      end if;
      if cid is not null and mid is null then
        select min(m.id) into mid from machines m where m.client_id = cid and m.status = 'active'
          and length(regexp_replace(lower(coalesce(m.model,'')),'[^a-z0-9]','','g')) >= 4
          and position(regexp_replace(lower(m.model),'[^a-z0-9]','','g') in regexp_replace(txt,'[^a-z0-9]','','g')) > 0
        having count(*) = 1;
      end if;
    else
      -- 1. a supervised machine's serial number on the invoice
      select m.id, m.client_id into mid, cid from machines m
       where m.client_id in (select client_id from supervisor_clients where supervisor_id = p_sup)
         and m.serial is not null and length(public.norm_serial(m.serial)) >= 5
         and position(public.norm_serial(m.serial) in public.norm_serial(txt)) > 0 limit 1;
      -- 2. the customer's name (match terms)
      if cid is null then
        select sc2.client_id into cid from supervisor_clients sc2 join clients c on c.id = sc2.client_id
         where sc2.supervisor_id = p_sup
           and exists (select 1 from unnest(case when cardinality(sc2.match_terms) > 0 then sc2.match_terms else array[c.name] end) t
                       where txt like '%' || lower(t) || '%')
         order by position(lower((case when cardinality(sc2.match_terms) > 0 then sc2.match_terms[1] else c.name end)) in txt) limit 1;
      end if;
    end if;
    update service_records set client_id = cid, machine_id = mid, kind = k where id = r.id
      and (client_id is distinct from cid or machine_id is distinct from mid or kind is distinct from k);
    n := n + 1;
  end loop;
  return n;
end $function$;

-- The vendors. Mimaki on; Brother, Mutoh and Alfex set up but off until switched on in the portal (Customers > Vendor supervisors).
insert into public.supervisors (name, bill_to, fb_client_id, scope, enabled, login_domains) values
  ('Mimaki Australia', 'Mimaki Australia', 264119, 'invoiced', true,  array['mimaki.com']),
  ('Brother International', 'Brother International', 260210, 'invoiced', false, array['brother.com.au']),
  ('Mutoh Australia', 'Mutoh Australia', 280727, 'invoiced', false, array['mutoh-au.com']),
  ('ALFEX CNC Australia', 'ALFEX CNC Australia', 205841, 'invoiced', false, array['alfex.com.au','alfexlaser.com.au'])
on conflict (name) do update set bill_to = excluded.bill_to, fb_client_id = excluded.fb_client_id, scope = excluded.scope, login_domains = excluded.login_domains;
