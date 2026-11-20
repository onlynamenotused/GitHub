-- Vector Converter access is a per-customer switch (staff tick it on the Customers page).
-- New customers start with it off. Existing customers with Mimaki, Roland, Brother or Epilog machines
-- (staff/imported machines only; machines a customer adds in the portal don't count) get it on.
-- Staff and vendor supervisors always have it.
alter table public.clients add column if not exists vector_access boolean not null default false;

update public.clients c set vector_access = true
 where exists (select 1 from public.machines m
                where m.client_id = c.id and coalesce(m.added_via,'') <> 'portal'
                  and m.brand in ('Mimaki','Mimaaki','Roland','Brother','Epilog'));

create or replace function public.has_vector_access() returns boolean
 language sql stable security definer set search_path to 'public' as $$
  select public.is_staff() or public.is_supervisor() or exists (
    select 1 from public.portal_access pa join public.clients c on c.id = pa.client_id
     where lower(pa.email) = public.current_email() and c.vector_access)
$$;
revoke all on function public.has_vector_access() from public, anon;
grant execute on function public.has_vector_access() to authenticated;

create or replace function public.portal_menu()
 returns jsonb language sql stable security definer set search_path to 'public' as $function$
  select jsonb_build_object(
    'email', public.current_email(),
    'staff', public.is_staff(),
    'intranet', public.is_intranet(),
    'kb', public.has_kb_access() or public.is_supervisor(),
    'cat', public.has_catalogue_access(),
    'cat_brands', to_jsonb(public.my_catalogue_brands()),
    'vector', public.has_vector_access(),
    'customer', exists (select 1 from portal_access pa where lower(pa.email) = public.current_email() and pa.role = 'customer'),
    'supervisor', (select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name)) from supervisors s where s.id in (select public.my_supervisor_ids())))
$function$;

-- Merging a service-desk-only client into its FreshBooks record keeps Vector Converter access if either had it.
create or replace function public.desk_client_id(p_fb text, p_ref text, p_name text)
 returns bigint language plpgsql security definer set search_path to 'public' as $function$
declare cid bigint; old bigint;
begin
  if nullif(p_fb,'') is not null then
    cid := p_fb::bigint;
    insert into clients(id, name) values (cid, coalesce(nullif(p_name,''), 'FreshBooks client '||cid))
      on conflict (id) do nothing;
    if nullif(p_ref,'') is not null then
      select id into old from clients where desk_ref = p_ref and id <> cid;
      if old is not null then
        update machines set client_id = cid where client_id = old;
        update tickets  set client_id = cid where client_id = old;
        insert into portal_access(email, client_id, full_name, role, created_at)
          select email, cid, full_name, role, created_at from portal_access where client_id = old
          on conflict do nothing;
        delete from portal_access where client_id = old;
        update clients c set email = coalesce(c.email, o.email), phone = coalesce(c.phone, o.phone),
               kb_access = c.kb_access or o.kb_access,
               vector_access = c.vector_access or o.vector_access,
               catalogue_brands = array(select distinct x from unnest(c.catalogue_brands || o.catalogue_brands) x)
          from clients o where c.id = cid and o.id = old;
        delete from clients where id = old;
      end if;
      update clients set desk_ref = p_ref where id = cid and desk_ref is null;
    end if;
    return cid;
  end if;
  if nullif(p_ref,'') is not null then
    select id into cid from clients where desk_ref = p_ref;
    if cid is not null then return cid; end if;
  end if;
  if nullif(p_name,'') is null then return null; end if;
  select id into cid from clients where lower(name) = lower(p_name) order by id limit 1;
  if cid is null then
    insert into clients(name, desk_ref) values (p_name, coalesce(nullif(p_ref,''), 'name:'||lower(p_name)))
      returning id into cid;
  elsif nullif(p_ref,'') is not null then
    update clients set desk_ref = coalesce(desk_ref, p_ref) where id = cid;
  end if;
  return cid;
end $function$;
