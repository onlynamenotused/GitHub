-- Customer asset reference (the customer's own name or tag for a machine, e.g. "Printer 2").
-- Set in the service desk (custRef) and editable by the customer in the portal.
-- A portal edit is held as pending until the desk has copied it in, so a desk sync can't overwrite it first.
alter table public.machines add column if not exists cust_ref text;
alter table public.machines add column if not exists cust_ref_pending boolean not null default false;
alter table public.machines add column if not exists cust_ref_by text;

-- Customer (or their fleet supervisor) sets the reference on one of their machines.
create or replace function public.portal_set_cust_ref(p_machine text, p_ref text)
 returns text language plpgsql security definer set search_path to 'public'
as $function$
declare em text := public.current_email(); v text := nullif(btrim(regexp_replace(coalesce(p_ref,''), '\s+', ' ', 'g')), '');
begin
  if length(v) > 60 then raise exception 'Keep the reference to 60 characters or fewer.'; end if;
  update machines m set cust_ref = v, cust_ref_pending = true, cust_ref_by = em, updated_at = now()
   where m.id = p_machine and m.status = 'active'
     and (exists (select 1 from portal_access pa where lower(pa.email) = em and pa.client_id = m.client_id and pa.role = 'customer')
          or public.supervises_machine(m.id));
  if not found then raise exception 'You can only change the reference on your own machines.'; end if;
  return v;
end $function$;
revoke all on function public.portal_set_cust_ref(text, text) from public, anon;
grant execute on function public.portal_set_cust_ref(text, text) to authenticated;

-- Desk: references customers changed in the portal, and the acknowledgement once copied in.
create or replace function public.desk_pending_refs()
 returns jsonb language sql stable security definer set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'cust_ref', m.cust_ref, 'by', m.cust_ref_by, 'client_name', c.name,
         'brand', m.brand, 'model', m.model, 'serial', m.serial) order by m.updated_at), '[]'::jsonb)
  from machines m left join clients c on c.id = m.client_id where m.cust_ref_pending
$function$;
create or replace function public.desk_ref_seen(p_id text, p_ref text)
 returns void language sql security definer set search_path to 'public'
as $function$
  update machines set cust_ref_pending = false where id = p_id and coalesce(cust_ref,'') = coalesce(nullif(btrim(p_ref),''),'')
$function$;
revoke all on function public.desk_pending_refs() from public, anon, authenticated;
revoke all on function public.desk_ref_seen(text, text) from public, anon, authenticated;

-- desk_sync: machines now carry cust_ref (kept as is while a portal edit is pending).
create or replace function public.desk_sync(p_collection text, p_docs jsonb)
 returns integer language plpgsql security definer set search_path to 'public'
as $function$
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
                           install_date, warranty_end, status, pm_interval_months, pm_last_done, pm_next_due, last_visit,
                           purchased_from, ink_type, mimaki_care, firmware, warranty_term, cust_ref)
      values (d->>'id', cid, v->>'brand', v->>'model', nullif(v->>'serial',''), v->>'category',
              nullif(v->>'subCategory',''), nullif(v->>'site',''), nullif(v->>'location',''), nullif(v->>'inkSet',''),
              nullif(v->>'purchaseDate','')::date, nullif(v->>'warrantyEnd','')::date,
              coalesce(nullif(v->>'status',''),'active'),
              nullif(v#>>'{pm,interval}','')::int, nullif(v#>>'{pm,lastDone}','')::date,
              nullif(v#>>'{pm,nextDue}','')::date, nullif(v->>'lastVisit','')::date,
              nullif(v->>'purchasedFrom',''), nullif(v->>'inkType',''), nullif(v->>'mimakiCare',''),
              nullif(v->>'firmware',''), nullif(v->>'warrantyTerm',''), nullif(btrim(v->>'custRef'),''))
      on conflict (id) do update set client_id=excluded.client_id, brand=excluded.brand, model=excluded.model,
        serial=excluded.serial, category=excluded.category, sub_category=excluded.sub_category, site=excluded.site,
        location=excluded.location, ink_set=excluded.ink_set, install_date=excluded.install_date,
        warranty_end=excluded.warranty_end, status=excluded.status, pm_interval_months=excluded.pm_interval_months,
        pm_last_done=excluded.pm_last_done, pm_next_due=excluded.pm_next_due, last_visit=excluded.last_visit,
        purchased_from=excluded.purchased_from, ink_type=excluded.ink_type, mimaki_care=excluded.mimaki_care,
        firmware=excluded.firmware, warranty_term=excluded.warranty_term,
        cust_ref = case when machines.cust_ref_pending then machines.cust_ref else excluded.cust_ref end;
    elsif p_collection = 'tickets' then
      cid := desk_ticket_client(v);
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
end $function$;

