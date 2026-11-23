-- Knowledge Base for vendor logins: only the vendor's own brands (supervisors.kb_brands), even when the same
-- email is also a customer login. Staff see everything; a vendor with no brands ticked sees everything.
create or replace function public.my_kb_only() returns text[]
language sql stable security definer set search_path = public as $$
  select case
    when public.is_staff() then null
    when not exists (select 1 from supervisors s where s.id in (select public.my_supervisor_ids())) then null
    when exists (select 1 from supervisors s where s.id in (select public.my_supervisor_ids()) and cardinality(s.kb_brands) = 0) then null
    else array(select distinct b from supervisors s, unnest(s.kb_brands) b where s.id in (select public.my_supervisor_ids()))
  end
$$;
