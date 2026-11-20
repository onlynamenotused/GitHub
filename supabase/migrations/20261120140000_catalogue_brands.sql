-- Parts Catalogue access split by brand group: Mimaki, Mutoh, Brother, Epilog, Others.
-- catalogue_access stays as the on/off switch (true when at least one brand group is allowed).
alter table public.clients add column if not exists catalogue_brands text[] not null default '{}';
alter table public.supervisors add column if not exists catalogue_brands text[] not null default '{}';
update public.clients set catalogue_brands = '{Mimaki,Mutoh,Brother,Epilog,Others}' where catalogue_access and cardinality(catalogue_brands) = 0;
update public.supervisors set catalogue_brands = '{Mimaki,Mutoh,Brother,Epilog,Others}' where catalogue_access and cardinality(catalogue_brands) = 0;

create or replace function public.sync_catalogue_brands() returns trigger
 language plpgsql set search_path to 'public' as $$
declare allb text[] := '{Mimaki,Mutoh,Brother,Epilog,Others}';
begin
  if tg_op = 'UPDATE' and new.catalogue_brands is distinct from old.catalogue_brands then
    new.catalogue_brands := array(select b from unnest(allb) b where b = any(new.catalogue_brands));
    new.catalogue_access := cardinality(new.catalogue_brands) > 0;
  elsif tg_op = 'INSERT' and cardinality(new.catalogue_brands) > 0 then
    new.catalogue_brands := array(select b from unnest(allb) b where b = any(new.catalogue_brands));
    new.catalogue_access := cardinality(new.catalogue_brands) > 0;
  elsif new.catalogue_access and cardinality(new.catalogue_brands) = 0 then
    new.catalogue_brands := allb;           -- old-style "on" switch: all brands
  elsif not new.catalogue_access then
    new.catalogue_brands := '{}';
  end if;
  return new;
end $$;
drop trigger if exists clients_catalogue_brands on public.clients;
create trigger clients_catalogue_brands before insert or update on public.clients for each row execute function public.sync_catalogue_brands();
drop trigger if exists supervisors_catalogue_brands on public.supervisors;
create trigger supervisors_catalogue_brands before insert or update on public.supervisors for each row execute function public.sync_catalogue_brands();

-- Brand groups the signed-in user may see in the Parts Catalogue (staff: all).
create or replace function public.my_catalogue_brands() returns text[]
 language sql stable security definer set search_path to 'public' as $$
  select case when public.is_staff() then '{Mimaki,Mutoh,Brother,Epilog,Others}'::text[]
  else coalesce(array(
    select distinct b from (
      select unnest(c.catalogue_brands) b from public.portal_access pa join public.clients c on c.id = pa.client_id
       where lower(pa.email) = public.current_email() and pa.role <> 'subcontractor'
      union
      select unnest(s.catalogue_brands) from public.supervisors s where s.id in (select public.my_supervisor_ids())
    ) x), '{}') end
$$;

create or replace function public.portal_menu()
 returns jsonb language sql stable security definer set search_path to 'public' as $function$
  select jsonb_build_object(
    'email', public.current_email(),
    'staff', public.is_staff(),
    'intranet', public.is_intranet(),
    'kb', public.has_kb_access() or public.is_supervisor(),
    'cat', public.has_catalogue_access(),
    'cat_brands', to_jsonb(public.my_catalogue_brands()),
    'customer', exists (select 1 from portal_access pa where lower(pa.email) = public.current_email() and pa.role = 'customer'),
    'supervisor', (select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name)) from supervisors s where s.id in (select public.my_supervisor_ids())))
$function$;
