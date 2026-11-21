-- Service kits: the service price is worked out, not typed.
--   annual price   = annual hours x standard hourly rate + every annual kit part (qty x ex GST price)
--   6-month price  = 6-month hours x rate + the 6-month kit parts; no 6-month hours = no 6-month option
-- The callout is NOT in the kit price: it is added once per visit, only when the customer wants us on site.

create or replace function public.kit_labour_rate() returns numeric
language sql immutable as $$ select 150::numeric $$;  -- standard hourly rate, ex GST

create or replace function public.kit_parts_total(parts jsonb) returns numeric
language sql immutable as $$
  select coalesce(sum(greatest(1, coalesce((x->>'qty')::numeric, 1)) * (x->>'ex')::numeric), 0)
    from jsonb_array_elements(coalesce(parts, '[]'::jsonb)) x
   where nullif(x->>'ex', '') is not null
$$;

create or replace function public.service_kits_price() returns trigger
language plpgsql as $$
begin
  new.annual_fee := round(coalesce(new.annual_hours, 0) * public.kit_labour_rate() + public.kit_parts_total(new.annual_parts), 2);
  new.six_fee := case when coalesce(new.six_hours, 0) > 0
                      then round(new.six_hours * public.kit_labour_rate() + public.kit_parts_total(new.six_parts), 2) end;
  return new;
end $$;

drop trigger if exists service_kits_price on public.service_kits;
create trigger service_kits_price before insert or update on public.service_kits
  for each row execute function public.service_kits_price();

update public.service_kits set annual_hours = annual_hours;  -- recompute every kit now

-- Quote me: pass the customer's on-site choice through to the quote (callout only when we come to them).
create or replace function public.portal_service_quote_start(p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
            'hours', case when plan = 'six' then k.six_hours else k.annual_hours end, 'rate', public.kit_labour_rate(),
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
          'brands', to_jsonb(public.my_catalogue_brands()), 'note', left(coalesce(p->>'note',''), 1000),
          'onsite', coalesce((p->>'onsite')::boolean, true)))
  returning id into qid;
  return jsonb_build_object('quote_id', qid, 'token', tok);
end $function$;
