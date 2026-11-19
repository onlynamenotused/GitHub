-- Merge a service-desk-only customer into its FreshBooks record once it has a FreshBooks id.
create or replace function public.desk_client_id(p_fb text, p_ref text, p_name text)
returns bigint language plpgsql security definer set search_path = public as $$
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
               kb_access = c.kb_access or o.kb_access, catalogue_access = c.catalogue_access or o.catalogue_access
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
end $$;
revoke all on function public.desk_client_id(text,text,text) from public, anon, authenticated;
