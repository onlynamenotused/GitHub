-- Vendor supervisors: optional Parts Catalogue access (applies to every login of that vendor supervisor).
alter table public.supervisors add column if not exists catalogue_access boolean not null default false;

create or replace function public.has_catalogue_access()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select public.is_staff()
    or exists (
      select 1 from public.portal_access pa
      join public.clients c on c.id = pa.client_id
      where lower(pa.email) = public.current_email()
        and c.catalogue_access and pa.role <> 'subcontractor'
    )
    or exists (
      select 1 from public.supervisors s
      where s.catalogue_access and s.id in (select public.my_supervisor_ids())
    )
$function$;
