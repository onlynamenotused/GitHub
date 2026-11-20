-- Customers created in the service desk before they were in FreshBooks (client id 9000000+) can still self-quote:
-- the edge function matches them to their FreshBooks client by email and saves it here.
alter table public.clients add column if not exists fb_client_id bigint;
update public.clients set fb_client_id = 273805 where id = 9000004 and fb_client_id is null;   -- SeanDev test account

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
