-- Sign-in emails greet people by first name: "Hi {{ .Data.first_name }},".
-- The name comes from portal_access.full_name (filled from the FreshBooks client contact) and is kept in
-- each login's user metadata (first_name, full_name), which the Supabase email templates can read.
create or replace function public.login_name_meta(p_email text) returns jsonb
 language sql stable security definer set search_path to 'public' as $$
  select coalesce((
    select jsonb_build_object('full_name', trim(pa.full_name), 'first_name', split_part(trim(pa.full_name), ' ', 1))
      from public.portal_access pa
     where lower(pa.email) = lower(p_email) and nullif(trim(pa.full_name), '') is not null
     order by pa.created_at limit 1), '{}'::jsonb)
$$;
revoke all on function public.login_name_meta(text) from public, anon, authenticated;

-- New logins pick up their name as they are created (before the first sign-in email goes out).
create or replace function public.auth_user_name_meta() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
begin
  new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb) || public.login_name_meta(new.email);
  return new;
end $$;
drop trigger if exists auth_user_name_meta on auth.users;
create trigger auth_user_name_meta before insert on auth.users for each row execute function public.auth_user_name_meta();

-- A name added or changed on a portal login flows to an existing login.
create or replace function public.portal_access_name_sync() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
declare m jsonb := public.login_name_meta(new.email);
begin
  if m <> '{}'::jsonb then
    update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || m
     where lower(email) = lower(new.email);
  end if;
  return new;
end $$;
drop trigger if exists portal_access_name_sync on public.portal_access;
create trigger portal_access_name_sync after insert or update of full_name, email on public.portal_access
  for each row execute function public.portal_access_name_sync();

-- Existing logins.
update auth.users u set raw_user_meta_data = coalesce(u.raw_user_meta_data, '{}'::jsonb) || public.login_name_meta(u.email)
 where public.login_name_meta(u.email) <> '{}'::jsonb;
