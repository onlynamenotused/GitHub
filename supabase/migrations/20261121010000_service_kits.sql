-- Service kits: the annual PM parts (and the 6-month caps / wipers / absorbers kit) for each model family, with the
-- fixed service price. Staff edit them on the portal's Service kits page; customers see "Quote me" on a machine only
-- once its kit is approved. Part prices in a kit are ex GST and are what the quote uses.
create table if not exists public.service_kits (
  id           bigint generated always as identity primary key,
  priority     int not null default 100,            -- lower wins when a model matches more than one kit
  name         text not null,
  brand        text not null,
  models       text[] not null default '{}',        -- model patterns (letters and digits only are compared; '' = every model of the brand)
  exclude      text[] not null default '{}',
  annual_fee   numeric(10,2) not null default 0,    -- fixed annual service price, ex GST, parts and callout extra
  six_fee      numeric(10,2),                       -- fixed 6-month service price; null = no 6-month option
  annual_hours numeric(4,1),                         -- hours on site for the service (staff record these)
  six_hours    numeric(4,1),
  annual_parts jsonb not null default '[]',         -- [{pn, name, qty, ex, note}]
  six_parts    jsonb not null default '[]',
  approved     boolean not null default false,
  source       text,
  notes        text,
  updated_at   timestamptz not null default now(),
  updated_by   text
);
alter table public.service_kits enable row level security;
drop policy if exists kits_staff on public.service_kits;
create policy kits_staff on public.service_kits for all to authenticated using (public.is_staff()) with check (public.is_staff());

create or replace function public.kit_norm(s text) returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(s,''), '[^A-Za-z0-9]', '', 'g')) $$;

create or replace function public.service_kit_for(p_brand text, p_model text, p_approved_only boolean default true) returns bigint
 language sql stable security definer set search_path = public as $$
  select k.id from service_kits k
   where left(kit_norm(p_brand), 4) = left(kit_norm(k.brand), 4)
     and (not p_approved_only or k.approved)
     and exists (select 1 from unnest(k.models) m where kit_norm(p_model) like '%' || kit_norm(m) || '%')
     and not exists (select 1 from unnest(k.exclude) x where kit_norm(x) <> '' and kit_norm(p_model) like '%' || kit_norm(x) || '%')
   order by k.priority, k.id limit 1
$$;
revoke all on function public.service_kit_for(text, text, boolean) from public, anon;
grant execute on function public.service_kit_for(text, text, boolean) to authenticated;

-- Customer: the approved kit for each of their active machines
create or replace function public.my_service_kits() returns jsonb
 language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(m.id, jsonb_build_object('id', k.id, 'name', k.name, 'annual_fee', k.annual_fee, 'six_fee', k.six_fee,
           'annual_hours', k.annual_hours, 'six_hours', k.six_hours, 'annual_parts', k.annual_parts, 'six_parts', k.six_parts)), '{}'::jsonb)
    from machines m
    join service_kits k on k.id = public.service_kit_for(m.brand, m.model, true)
   where m.status = 'active'
     and m.client_id in (select pa.client_id from portal_access pa where lower(pa.email) = public.current_email() and pa.role = 'customer')
$$;
revoke all on function public.my_service_kits() from public, anon;
grant execute on function public.my_service_kits() to authenticated;

-- Staff: active machines matched to each kit (approved or not), and the models no kit covers yet
create or replace function public.service_kit_coverage() returns jsonb
 language sql stable security definer set search_path = public as $$
  select case when not public.is_staff() then '{}'::jsonb else jsonb_build_object(
    'kits', coalesce((select jsonb_object_agg(kid, n) from (select public.service_kit_for(brand, model, false) kid, count(*) n
                         from machines where status = 'active' group by 1) t where kid is not null), '{}'::jsonb),
    'uncovered', coalesce((select jsonb_agg(jsonb_build_object('brand', brand, 'model', model, 'n', n) order by n desc, brand, model)
                         from (select brand, model, count(*) n from machines where status = 'active'
                                and public.service_kit_for(brand, model, false) is null group by 1, 2) u), '[]'::jsonb)) end
$$;
revoke all on function public.service_kit_coverage() from public, anon;
grant execute on function public.service_kit_coverage() to authenticated;

-- Step 1 of a "Quote me" service quote (step 2 is the edge function, as for parts quotes). Takes
--   {machines: [{id, plan: 'annual'|'six', remove: [pn...]}], extras: [{brand, key, qty}], note}
-- and snapshots each machine's kit (fee + parts left in) so the quote matches what the customer saw.
create or replace function public.portal_service_quote_start(p jsonb) returns jsonb
 language plpgsql security definer set search_path = public as $$
declare em text := public.current_email(); cid bigint; nm text; qid bigint; tok text; r jsonb; mach record; k record; has_kit boolean;
        plan text; rem jsonb; parts jsonb; ms jsonb := '[]'::jsonb; first_mid text; six_skipped jsonb;
        extras jsonb := coalesce(p->'extras', '[]'::jsonb);
begin
  if em = '' then raise exception 'Please sign in again.'; end if;
  if jsonb_typeof(p->'machines') <> 'array' or jsonb_array_length(p->'machines') = 0 then raise exception 'Choose at least one machine.'; end if;
  if jsonb_array_length(p->'machines') > 12 then raise exception 'A quote can cover up to 12 machines.'; end if;
  if jsonb_typeof(extras) <> 'array' or jsonb_array_length(extras) > 40 then raise exception 'Too many extra parts.'; end if;
  if jsonb_array_length(extras) > 0 and not public.has_catalogue_access() then raise exception 'Extra parts need the Parts Catalogue, which isn''t turned on for your account.'; end if;
  for r in select * from jsonb_array_elements(p->'machines') loop
    select m.* into mach from machines m where m.id = r->>'id' and m.status = 'active'
       and m.client_id in (select pa.client_id from portal_access pa where lower(pa.email) = em and pa.role = 'customer');
    if not found then raise exception 'One of those machines isn''t on your account.'; end if;
    if cid is null then cid := mach.client_id; first_mid := mach.id;
    elsif cid <> mach.client_id then raise exception 'Quote machines from one company at a time.'; end if;
    if ms @> jsonb_build_array(jsonb_build_object('id', mach.id)) then continue; end if;
    select * into k from service_kits where id = public.service_kit_for(mach.brand, mach.model, true);
    has_kit := found;
    if not has_kit then
      -- No approved PM kit for this model: a standard quote (1 hour labour + the visit's callout); parts quoted on inspection.
      ms := ms || jsonb_build_array(jsonb_build_object('id', mach.id, 'brand', mach.brand, 'model', mach.model, 'serial', mach.serial,
              'address', coalesce(nullif(trim(mach.location),''), nullif(trim(mach.site),'')), 'plan', 'standard', 'hours', 1, 'parts', '[]'::jsonb));
      continue;
    end if;
    plan := case when r->>'plan' = 'six' then 'six' else 'annual' end;
    if plan = 'six' and k.six_fee is null then raise exception 'The % has no 6-month service option.', k.name; end if;
    rem := case when jsonb_typeof(r->'remove') = 'array' then r->'remove' else '[]'::jsonb end;
    select coalesce(jsonb_agg(x), '[]'::jsonb) into parts
      from jsonb_array_elements(case when plan = 'six' then k.six_parts else k.annual_parts end) x
     where not rem ? (x->>'pn');
    six_skipped := '[]'::jsonb;
    if plan = 'six' then
      select coalesce(jsonb_agg(a->>'name' order by a->>'name'), '[]'::jsonb) into six_skipped
        from jsonb_array_elements(k.annual_parts) a
       where not exists (select 1 from jsonb_array_elements(k.six_parts) s where s->>'pn' = a->>'pn');
    end if;
    ms := ms || jsonb_build_array(jsonb_build_object('id', mach.id, 'brand', mach.brand, 'model', mach.model, 'serial', mach.serial,
            'address', coalesce(nullif(trim(mach.location),''), nullif(trim(mach.site),'')),
            'kit_id', k.id, 'kit', k.name, 'plan', plan, 'fee', case when plan = 'six' then k.six_fee else k.annual_fee end,
            'hours', case when plan = 'six' then k.six_hours else k.annual_hours end,
            'parts', parts, 'removed', (select coalesce(jsonb_agg(x->>'name'), '[]'::jsonb) from jsonb_array_elements(case when plan = 'six' then k.six_parts else k.annual_parts end) x where rem ? (x->>'pn')),
            'six_skipped', six_skipped));
  end loop;
  if (select count(*) from portal_quotes where client_id = cid and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'You can create up to 5 quotes an hour. Please try again a little later, or call us on 1300 880 815.';
  end if;
  select coalesce(nullif(trim(full_name),''), '') into nm from portal_access where lower(email) = em order by created_at limit 1;
  tok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into portal_quotes(client_id, email, machine_id, status, token, request)
  values (cid, em, first_mid, 'queued', tok, jsonb_build_object('kind', 'service', 'machines', ms, 'items', extras, 'name', nm,
          'brands', to_jsonb(public.my_catalogue_brands()), 'note', left(coalesce(p->>'note',''), 1000)))
  returning id into qid;
  return jsonb_build_object('quote_id', qid, 'token', tok);
end $$;
revoke all on function public.portal_service_quote_start(jsonb) from public, anon;
grant execute on function public.portal_service_quote_start(jsonb) to authenticated;

-- Draft kits from the Mimaki maintenance parts lists, the parts catalogue and the FreshBooks fixed-price service items.
-- All start unapproved: prices and quantities are for staff to check before customers can use them.
insert into public.service_kits(priority, name, brand, models, exclude, annual_fee, six_fee, annual_parts, six_parts, source, notes)
select * from (values
(10,'Mimaki UCJV300 / UCJV150','Mimaki',array['UCJV300','UCJV150']::text[],array[]::text[],415,250,'[{"pn": "MP-M020220", "name": "Cap base assy U", "qty": 1, "ex": 222.0}, {"pn": "SPA-0296", "name": "CP pad assy (cap absorber)", "qty": 1, "ex": 37.0}, {"pn": "SPA-0271", "name": "Wiper", "qty": 1, "ex": 33.0}, {"pn": "MP-M021054", "name": "LED mist filter assy", "qty": 1, "ex": 58.0}, {"pn": "MP-M018988", "name": "Selective path pump assy UV", "qty": 1, "ex": 168.0, "note": "UCJV300 only (manual: UCJV300 only)"}, {"pn": "MP-M014071", "name": "Tube pump 4 assy 2", "qty": 1, "ex": 127.0}, {"pn": "MP-M020235", "name": "Sub tank assy", "qty": 2, "ex": 223.0, "note": "Qty = print heads (UCJV150 has 1)"}, {"pn": "MP-M021124", "name": "Air vent unit assy", "qty": 1, "ex": 114.0}, {"pn": "MP-M015864", "name": "TS cartridge valve assy", "qty": 8, "ex": 45.0, "note": "Qty = ink bottle slots"}, {"pn": "MP-M018701", "name": "Tank assy", "qty": 8, "ex": null, "note": "Qty = ink bottle slots"}]'::jsonb,'[{"pn": "MP-M020220", "name": "Cap base assy U", "qty": 1, "ex": 222.0}, {"pn": "SPA-0296", "name": "CP pad assy (cap absorber)", "qty": 1, "ex": 37.0}, {"pn": "SPA-0271", "name": "Wiper", "qty": 1, "ex": 33.0}]'::jsonb,'Mimaki Maintenance Parts List D501318 (UCJV300/150) rank A + FreshBooks item ''UCJV300 Service M''',''),
(11,'Mimaki UCJV330','Mimaki',array['UCJV330']::text[],array[]::text[],415,250,'[{"pn": "SPA-0362", "name": "Cap G assy", "qty": 1, "ex": 104.0}, {"pn": "SPA-0271", "name": "Wiper", "qty": 1, "ex": 33.0}, {"pn": "MP-M027557", "name": "Selective path pump assy S", "qty": 1, "ex": 206.0}, {"pn": "MP-M028975", "name": "HC damper assy U", "qty": 1, "ex": null}, {"pn": "MP-M026935", "name": "D pump assy", "qty": 1, "ex": null}, {"pn": "MP-M026936", "name": "Buffer tank assy", "qty": 1, "ex": null}, {"pn": "MP-M026937", "name": "Wiping roller assy", "qty": 1, "ex": 81.0}, {"pn": "MP-M026938", "name": "Feeding roller assy", "qty": 1, "ex": 86.0}, {"pn": "MP-37DISCB-PPEP0500CC", "name": "Ink filter", "qty": 1, "ex": 85.0, "note": "Check qty per ink path"}, {"pn": "MP-M021054", "name": "LED mist filter assy", "qty": 1, "ex": 58.0}, {"pn": "MP-M018701", "name": "Tank assy", "qty": 1, "ex": null, "note": "Check qty"}]'::jsonb,'[{"pn": "SPA-0362", "name": "Cap G assy", "qty": 1, "ex": 104.0}, {"pn": "SPA-0271", "name": "Wiper", "qty": 1, "ex": 33.0}]'::jsonb,'Mimaki Maintenance Parts List D501601 (330 series) rank A ''replace once a year''','6-month kit: check cap absorber part for the 330 series.'),
(20,'Mimaki JV300 / CJV300 (incl. Plus)','Mimaki',array['CJV300','JV300']::text[],array['UCJV','UJV']::text[],260,160,'[{"pn": "MP-M905240", "name": "Cap head assembly (cap top)", "qty": 1, "ex": 77.0}, {"pn": "SPA-0257", "name": "Cap pad set", "qty": 1, "ex": 58.0}, {"pn": "SPA-0134", "name": "Rubber wiper with holder", "qty": 1, "ex": 19.0}, {"pn": "MP-M015266", "name": "Wiper cleaner assy", "qty": 1, "ex": 85.0}, {"pn": "MP-M602093", "name": "Wiper slider", "qty": 1, "ex": 4.0}, {"pn": "MP-M802118", "name": "W soak pad", "qty": 1, "ex": 5.0}, {"pn": "MP-M022253", "name": "Pressure damper", "qty": 8, "ex": 85.0, "note": "Qty = ink slots; check"}, {"pn": "MP-M015304", "name": "Cartridge valve assy", "qty": 8, "ex": 95.0, "note": "Qty = ink slots; check"}, {"pn": "MP-M022219", "name": "Filter assy, black 2", "qty": 1, "ex": 38.0, "note": "SS21 / SS22 ink only"}, {"pn": "MP-M018988", "name": "Selective path pump assy", "qty": 1, "ex": 168.0}]'::jsonb,'[{"pn": "MP-M905240", "name": "Cap head assembly (cap top)", "qty": 1, "ex": 77.0}, {"pn": "SPA-0257", "name": "Cap pad set", "qty": 1, "ex": 58.0}, {"pn": "SPA-0134", "name": "Rubber wiper with holder", "qty": 1, "ex": 19.0}]'::jsonb,'Rank A parts shared with JV/CJV300 in Mimaki parts lists D501664 (TxF) and CS241007-606 + FreshBooks item ''CJV150 Service M''',''),
(21,'Mimaki JV150 / CJV150','Mimaki',array['CJV150','JV150']::text[],array['UCJV','UJV']::text[],260,160,'[{"pn": "MP-M905240", "name": "Cap head assembly (cap top)", "qty": 1, "ex": 77.0}, {"pn": "SPA-0257", "name": "Cap pad set", "qty": 1, "ex": 58.0}, {"pn": "SPA-0134", "name": "Rubber wiper with holder", "qty": 1, "ex": 19.0}, {"pn": "MP-M015266", "name": "Wiper cleaner assy", "qty": 1, "ex": 85.0}, {"pn": "MP-M602093", "name": "Wiper slider", "qty": 1, "ex": 4.0}, {"pn": "MP-M802118", "name": "W soak pad", "qty": 1, "ex": 5.0}, {"pn": "MP-M022253", "name": "Pressure damper", "qty": 8, "ex": 85.0, "note": "Qty = ink slots; check"}, {"pn": "MP-M015304", "name": "Cartridge valve assy", "qty": 8, "ex": 95.0, "note": "Qty = ink slots; check"}, {"pn": "MP-M022219", "name": "Filter assy, black 2", "qty": 1, "ex": 38.0, "note": "SS21 / SS22 ink only"}, {"pn": "MP-M014070", "name": "Tube pump 3 assy 2", "qty": 1, "ex": 76.0}]'::jsonb,'[{"pn": "MP-M905240", "name": "Cap head assembly (cap top)", "qty": 1, "ex": 77.0}, {"pn": "SPA-0257", "name": "Cap pad set", "qty": 1, "ex": 58.0}, {"pn": "SPA-0134", "name": "Rubber wiper with holder", "qty": 1, "ex": 19.0}]'::jsonb,'Rank A parts shared with JV/CJV150 in Mimaki parts lists D501664 (TxF) and CS241007-606 + FreshBooks item ''CJV150 Service M''',''),
(22,'Mimaki JV200 / CJV200','Mimaki',array['CJV200','JV200']::text[],array[]::text[],260,160,'[{"pn": "MP-M028290", "name": "HC damper assy 2", "qty": 1, "ex": 64.0}, {"pn": "MP-M022253", "name": "Damper assy", "qty": 3, "ex": 85.0}, {"pn": "MP-M027324", "name": "Tube pump assy S", "qty": 1, "ex": null}, {"pn": "MP-M029658", "name": "Cartridge valve B assy", "qty": 8, "ex": null, "note": "Cartridge model (bottle model uses MP-M029853 x4)"}, {"pn": "MP-37DISCB-PPEP0500CC", "name": "Ink filter", "qty": 8, "ex": 85.0, "note": "Bottle model: 4"}, {"pn": "MP-M022219", "name": "Filter assy, black 2", "qty": 1, "ex": 38.0, "note": "SS21 / SS22 ink only"}, {"pn": "MP-M015313", "name": "D pump assy", "qty": 2, "ex": null}, {"pn": "MP-Q301791", "name": "SIJ check valve", "qty": 2, "ex": null}]'::jsonb,'[]'::jsonb,'Mimaki JV200/CJV200 Recommended Parts List CS241007-606 rank A (once a year)','Add the cap, wiper and absorber part numbers (6-month kit) from the maintenance parts list D501737.'),
(25,'Mimaki TxF150','Mimaki',array['TXF150']::text[],array[]::text[],300,180,'[{"pn": "MP-M905240", "name": "Cap head assembly", "qty": 1, "ex": 77.0}, {"pn": "MP-M602093", "name": "Wiper slider", "qty": 1, "ex": 4.0}, {"pn": "MP-M802118", "name": "W soak pad", "qty": 1, "ex": 5.0}, {"pn": "MP-M015266", "name": "Wiper cleaner assy", "qty": 1, "ex": 85.0}, {"pn": "MP-M022219", "name": "Filter assy, black 2", "qty": 1, "ex": 38.0}, {"pn": "MP-M022253", "name": "Pressure damper", "qty": 1, "ex": 85.0, "note": "Check qty"}, {"pn": "MP-M028290", "name": "HC damper assy 2", "qty": 1, "ex": 64.0}, {"pn": "MP-M028409", "name": "D pump assy aqua", "qty": 1, "ex": 379.0}, {"pn": "MP-M015304", "name": "Cartridge valve assy", "qty": 1, "ex": 95.0, "note": "Check qty"}, {"pn": "MP-M015864", "name": "TS cartridge valve assy", "qty": 1, "ex": 45.0, "note": "Check qty"}, {"pn": "MP-SFPA-MMK", "name": "Tube 1.6 x 2.6 (100 m)", "qty": 1, "ex": null}, {"pn": "MP-M014070", "name": "Tube pump 3 assy 2", "qty": 1, "ex": 76.0}]'::jsonb,'[{"pn": "MP-M905240", "name": "Cap head assembly", "qty": 1, "ex": 77.0}, {"pn": "MP-M602093", "name": "Wiper slider", "qty": 1, "ex": 4.0}, {"pn": "MP-M802118", "name": "W soak pad", "qty": 1, "ex": 5.0}, {"pn": "MP-M015266", "name": "Wiper cleaner assy", "qty": 1, "ex": 85.0}]'::jsonb,'Mimaki Maintenance Parts List D501664 (TxF series) rank A ''once a year''',''),
(26,'Mimaki TxF300','Mimaki',array['TXF300']::text[],array[]::text[],300,180,'[{"pn": "MP-M905240", "name": "Cap head assembly", "qty": 1, "ex": 77.0}, {"pn": "MP-M602093", "name": "Wiper slider", "qty": 1, "ex": 4.0}, {"pn": "MP-M802118", "name": "W soak pad", "qty": 1, "ex": 5.0}, {"pn": "MP-M015266", "name": "Wiper cleaner assy", "qty": 1, "ex": 85.0}, {"pn": "MP-M022219", "name": "Filter assy, black 2", "qty": 1, "ex": 38.0}, {"pn": "MP-M022253", "name": "Pressure damper", "qty": 1, "ex": 85.0, "note": "Check qty"}, {"pn": "MP-M028290", "name": "HC damper assy 2", "qty": 1, "ex": 64.0}, {"pn": "MP-M028409", "name": "D pump assy aqua", "qty": 1, "ex": 379.0}, {"pn": "MP-M015304", "name": "Cartridge valve assy", "qty": 1, "ex": 95.0, "note": "Check qty"}, {"pn": "MP-M015864", "name": "TS cartridge valve assy", "qty": 1, "ex": 45.0, "note": "Check qty"}, {"pn": "MP-SFPA-MMK", "name": "Tube 1.6 x 2.6 (100 m)", "qty": 1, "ex": null}, {"pn": "MP-M018988", "name": "Selective path pump assy UV", "qty": 1, "ex": 168.0}]'::jsonb,'[{"pn": "MP-M905240", "name": "Cap head assembly", "qty": 1, "ex": 77.0}, {"pn": "MP-M602093", "name": "Wiper slider", "qty": 1, "ex": 4.0}, {"pn": "MP-M802118", "name": "W soak pad", "qty": 1, "ex": 5.0}, {"pn": "MP-M015266", "name": "Wiper cleaner assy", "qty": 1, "ex": 85.0}]'::jsonb,'Mimaki Maintenance Parts List D501664 (TxF series) rank A ''once a year''',''),
(27,'Mimaki Tx300P / TS300P','Mimaki',array['TX300P','TS300P']::text[],array[]::text[],450,250,'[{"pn": "MP-M015950", "name": "Cap assy TS300", "qty": 1, "ex": 99.0}, {"pn": "SPA-0269", "name": "CP pad T set", "qty": 1, "ex": 93.0}, {"pn": "SPC-0830", "name": "W absorber assy", "qty": 1, "ex": 80.0}, {"pn": "MP-M018988", "name": "Selective path pump assy", "qty": 1, "ex": 168.0}, {"pn": "MP-M014071", "name": "Tube pump 4 assy 2", "qty": 1, "ex": 127.0}, {"pn": "MP-M015864", "name": "TS cartridge valve assy", "qty": 1, "ex": 45.0, "note": "Check qty"}]'::jsonb,'[{"pn": "MP-M015950", "name": "Cap assy TS300", "qty": 1, "ex": 99.0}, {"pn": "SPA-0269", "name": "CP pad T set", "qty": 1, "ex": 93.0}, {"pn": "SPC-0830", "name": "W absorber assy", "qty": 1, "ex": 80.0}]'::jsonb,'Parts catalogue (Tx300P family) + parts shared with Tx300P in D501318','Check against the Tx300P-1800 service documents D501144.'),
(30,'Mimaki JFX200 EX','Mimaki',array['JFX2002513EX','JFX2001213EX','JFX200EX']::text[],array[]::text[],600,350,'[{"pn": "MP-M020220", "name": "Cap base assy U", "qty": 1, "ex": 222.0}, {"pn": "MP-M915811", "name": "Under the ink absorber 3", "qty": 1, "ex": null}, {"pn": "MP-M915812", "name": "On the ink absorber 3", "qty": 1, "ex": null}, {"pn": "MP-M910576", "name": "Belt cover absorber", "qty": 1, "ex": null}, {"pn": "MP-M018701", "name": "Tank assy", "qty": 1, "ex": null, "note": "Check qty"}, {"pn": "MP-CBP-050BL1", "name": "Capsule filter", "qty": 1, "ex": 139.0}, {"pn": "MP-37DISCB-PPEP1000CC", "name": "Filter", "qty": 1, "ex": null, "note": "Check qty"}, {"pn": "MP-M014070", "name": "Tube pump 3 assy 2", "qty": 1, "ex": 76.0}, {"pn": "MP-M020235", "name": "Sub tank assy", "qty": 1, "ex": 223.0, "note": "Check qty"}, {"pn": "MP-M027170", "name": "Air vent unit assy EX", "qty": 1, "ex": null}, {"pn": "MP-E106684", "name": "Pressure control pump assy", "qty": 1, "ex": null}, {"pn": "MP-M014071", "name": "Tube pump 4 assy 2", "qty": 1, "ex": 127.0}, {"pn": "MP-M015864", "name": "TS cartridge valve assy", "qty": 1, "ex": 45.0, "note": "Check qty"}]'::jsonb,'[{"pn": "MP-M020220", "name": "Cap base assy U", "qty": 1, "ex": 222.0}, {"pn": "MP-M915811", "name": "Under the ink absorber 3", "qty": 1, "ex": null}, {"pn": "MP-M915812", "name": "On the ink absorber 3", "qty": 1, "ex": null}, {"pn": "MP-M910576", "name": "Belt cover absorber", "qty": 1, "ex": null}]'::jsonb,'Mimaki Maintenance Parts List D501466 (JFX200EX) rank A',''),
(31,'Mimaki JFX200 (non-EX)','Mimaki',array['JFX200']::text[],array[]::text[],600,350,'[{"pn": "MP-M020220", "name": "Cap base assy U", "qty": 1, "ex": 222.0}, {"pn": "MP-M915811", "name": "Under the ink absorber 3", "qty": 1, "ex": null}, {"pn": "MP-M915812", "name": "On the ink absorber 3", "qty": 1, "ex": null}, {"pn": "MP-M910576", "name": "Belt cover absorber", "qty": 1, "ex": null}, {"pn": "MP-M018701", "name": "Tank assy", "qty": 1, "ex": null, "note": "Check qty"}, {"pn": "MP-CBP-050BL1", "name": "Capsule filter", "qty": 1, "ex": 139.0}, {"pn": "MP-37DISCB-PPEP1000CC", "name": "Filter", "qty": 1, "ex": null, "note": "Check qty"}, {"pn": "MP-M014070", "name": "Tube pump 3 assy 2", "qty": 1, "ex": 76.0}, {"pn": "MP-M020235", "name": "Sub tank assy", "qty": 1, "ex": 223.0, "note": "Check qty"}, {"pn": "MP-M027170", "name": "Air vent unit assy EX", "qty": 1, "ex": null}, {"pn": "MP-E106684", "name": "Pressure control pump assy", "qty": 1, "ex": null}, {"pn": "MP-M014071", "name": "Tube pump 4 assy 2", "qty": 1, "ex": 127.0}, {"pn": "MP-M015864", "name": "TS cartridge valve assy", "qty": 1, "ex": 45.0, "note": "Check qty"}]'::jsonb,'[{"pn": "MP-M020220", "name": "Cap base assy U", "qty": 1, "ex": 222.0}, {"pn": "MP-M915811", "name": "Under the ink absorber 3", "qty": 1, "ex": null}, {"pn": "MP-M915812", "name": "On the ink absorber 3", "qty": 1, "ex": null}, {"pn": "MP-M910576", "name": "Belt cover absorber", "qty": 1, "ex": null}]'::jsonb,'Copied from JFX200 EX list D501466','Check against the JFX200-2513 maintenance parts list D501258 before approving.'),
(32,'Mimaki UJF-7151 plus / plusII / plusIIe','Mimaki',array['7151']::text[],array[]::text[],600,350,'[{"pn": "MP-M700970", "name": "Cap rubber", "qty": 8, "ex": null, "note": "plus: 6"}, {"pn": "MP-M702139", "name": "Cap rubber H (primer)", "qty": 1, "ex": null}, {"pn": "MP-U-3.2(170)-5-WM4 SET", "name": "Tube maintenance set", "qty": 2, "ex": null}, {"pn": "MP-E106658", "name": "3-way solenoid valve assy", "qty": 8, "ex": null, "note": "plus: 6"}, {"pn": "MP-37DISCB-PPEP1000CC", "name": "Filter", "qty": 8, "ex": null, "note": "plus: 6"}, {"pn": "MP-M018701", "name": "Tank assy", "qty": 8, "ex": null, "note": "plus: 6"}, {"pn": "MP-M017919", "name": "Ink supply diaphragm pump assy", "qty": 6, "ex": null}, {"pn": "MP-MAC-C-A100-7", "name": "Ink jet capsule", "qty": 8, "ex": null, "note": "plus: 6"}, {"pn": "MP-M014071", "name": "Tube pump 4 assy 2", "qty": 1, "ex": 127.0, "note": "plus uses MP-M014070"}]'::jsonb,'[{"pn": "MP-M700970", "name": "Cap rubber", "qty": 8, "ex": null, "note": "plus: 6"}, {"pn": "MP-M702139", "name": "Cap rubber H (primer)", "qty": 1, "ex": null}]'::jsonb,'Mimaki UJF-7151plus(II)(e) Recommended Parts List CS211005-413 rank A (once a year)',''),
(33,'Mimaki UJF-3042 / 6042 MkII','Mimaki',array['3042','6042']::text[],array[]::text[],450,250,'[{"pn": "MP-M026703", "name": "Cap assy H", "qty": 1, "ex": null}, {"pn": "MP-M021937", "name": "Sub tank assy CE", "qty": 1, "ex": null, "note": "Check qty"}, {"pn": "MP-M018988", "name": "Selective path pump assy UV", "qty": 1, "ex": 168.0}, {"pn": "MP-M015864", "name": "TS cartridge valve assy", "qty": 1, "ex": 45.0, "note": "Check qty"}, {"pn": "MP-M014071", "name": "Tube pump 4 assy 2", "qty": 1, "ex": 127.0}, {"pn": "MP-M018701", "name": "Tank assy", "qty": 1, "ex": null, "note": "MBIS; check qty"}, {"pn": "MP-M026688", "name": "Selective path pump assy 2", "qty": 1, "ex": null}]'::jsonb,'[{"pn": "MP-M026703", "name": "Cap assy H", "qty": 1, "ex": null}]'::jsonb,'Mimaki Maintenance Parts List D501204 (UJF-3042/6042MkII) rank A',''),
(5,'Mimaki UJV300DTF-75','Mimaki',array['UJV300DTF']::text[],array[]::text[],450,250,'[{"pn": "MP-M020220", "name": "Cap base assy U", "qty": 2, "ex": 222.0}, {"pn": "MP-M014071", "name": "Tube pump 4 assy 2", "qty": 2, "ex": 127.0}, {"pn": "MP-M015864", "name": "TS cartridge valve assy", "qty": 8, "ex": 45.0}, {"pn": "MP-M018701", "name": "Tank assy", "qty": 8, "ex": null}, {"pn": "MP-M018988", "name": "Selective path pump assy UV", "qty": 1, "ex": 168.0}, {"pn": "MP-M020235", "name": "Sub tank assy", "qty": 2, "ex": 223.0}, {"pn": "MP-M021054", "name": "LED mist filter assy", "qty": 1, "ex": 58.0}, {"pn": "MP-M027170", "name": "Air purge unit assy EX", "qty": 2, "ex": null}]'::jsonb,'[{"pn": "MP-M020220", "name": "Cap base assy U", "qty": 2, "ex": 222.0}]'::jsonb,'Mimaki UJV300DTF-75 Recommended Parts List CS250611-638 rank A (once a year)','6-month kit: add the wiper and absorber part numbers.'),
(40,'Mutoh XPJ-1641SR','Mutoh',array['XPJ1641SR']::text[],array[]::text[],300,180,'[{"pn": "DG-49312", "name": "Periodic maintenance kit", "qty": 1, "ex": 1089.0}]'::jsonb,'[{"pn": "DG-41179", "name": "Cap head assy", "qty": 1, "ex": 125.5}, {"pn": "DG-41001", "name": "Wiper assy", "qty": 1, "ex": 53.1}]'::jsonb,'Parts catalogue (Mutoh periodic maintenance kit DG-49312)','Check the kit contents against the XPJ-1641SR maintenance manual.'),
(45,'Brother GTX / GTX Pro','Brother',array['GTX']::text[],array['MINI']::text[],300,180,'[{"pn": "SB6673001", "name": "Wiper cleaner", "qty": 1, "ex": 36.96}, {"pn": "SC0935001", "name": "Flushing foam set", "qty": 1, "ex": 45.27}, {"pn": "SB5696001", "name": "Capping pouch", "qty": 1, "ex": 58.61}, {"pn": "SC0939301", "name": "Cap set supply", "qty": 1, "ex": 237.0}, {"pn": "SB7870001", "name": "Wiper holder supply assy", "qty": 1, "ex": 120.12}, {"pn": "SC7599001", "name": "Needle felt", "qty": 1, "ex": 15.0}, {"pn": "SB7007001", "name": "Fan filter set", "qty": 1, "ex": 16.18}]'::jsonb,'[{"pn": "SB6673001", "name": "Wiper cleaner", "qty": 1, "ex": 36.96}, {"pn": "SC0935001", "name": "Flushing foam set", "qty": 1, "ex": 45.27}, {"pn": "SB5696001", "name": "Capping pouch", "qty": 1, "ex": 58.61}]'::jsonb,'Parts catalogue (Brother GTX maintenance parts)','Check intervals against the GTX / GTX pro service manuals.'),
(50,'Epilog laser (all models)','Epilog',array['']::text[],array[]::text[],150,null,'[{"pn": "MCP-303", "name": "Optics cleaning kit", "qty": 1, "ex": 25.67}]'::jsonb,'[]'::jsonb,'FreshBooks item ''Epilog Laser Service''','Lasers have no caps, wipers or absorbers, so there''s no 6-month kit.')) v(priority, name, brand, models, exclude, annual_fee, six_fee, annual_parts, six_parts, source, notes)
where not exists (select 1 from public.service_kits);
