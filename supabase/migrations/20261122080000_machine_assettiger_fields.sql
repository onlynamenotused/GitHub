-- Machine details carried over from AssetTiger custom fields (dealer, ink type, Mimaki Care, firmware, warranty term).
alter table public.machines add column if not exists purchased_from text, add column if not exists ink_type text,
  add column if not exists mimaki_care text, add column if not exists firmware text, add column if not exists warranty_term text;

CREATE OR REPLACE FUNCTION public.desk_sync(p_collection text, p_docs jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
                           purchased_from, ink_type, mimaki_care, firmware, warranty_term)
      values (d->>'id', cid, v->>'brand', v->>'model', nullif(v->>'serial',''), v->>'category',
              nullif(v->>'subCategory',''), nullif(v->>'site',''), nullif(v->>'location',''), nullif(v->>'inkSet',''),
              nullif(v->>'purchaseDate','')::date, nullif(v->>'warrantyEnd','')::date,
              coalesce(nullif(v->>'status',''),'active'),
              nullif(v#>>'{pm,interval}','')::int, nullif(v#>>'{pm,lastDone}','')::date,
              nullif(v#>>'{pm,nextDue}','')::date, nullif(v->>'lastVisit','')::date,
              nullif(v->>'purchasedFrom',''), nullif(v->>'inkType',''), nullif(v->>'mimakiCare',''),
              nullif(v->>'firmware',''), nullif(v->>'warrantyTerm',''))
      on conflict (id) do update set client_id=excluded.client_id, brand=excluded.brand, model=excluded.model,
        serial=excluded.serial, category=excluded.category, sub_category=excluded.sub_category, site=excluded.site,
        location=excluded.location, ink_set=excluded.ink_set, install_date=excluded.install_date,
        warranty_end=excluded.warranty_end, status=excluded.status, pm_interval_months=excluded.pm_interval_months,
        pm_last_done=excluded.pm_last_done, pm_next_due=excluded.pm_next_due, last_visit=excluded.last_visit,
        purchased_from=excluded.purchased_from, ink_type=excluded.ink_type, mimaki_care=excluded.mimaki_care,
        firmware=excluded.firmware, warranty_term=excluded.warranty_term;
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
