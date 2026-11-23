-- Set up a confirmed sign-in account for every customer login as it is added, so the first sign-in email is the
-- Magic Link email (button + code) rather than Supabase's link-only "Confirm signup" email.
create or replace function fbw.provision_logins(p_emails text[])
returns jsonb language plpgsql security definer set search_path to 'fbw','public','extensions' as $$
declare u text; key text; r extensions.http_response;
begin
  select v into u from fbw.settings where k='fn_url';
  select v into key from fbw.settings where k='bridge_key';
  u := replace(u, '/functions/v1/freshbooks', '/functions/v1/portal-provision');
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS','60000');
  select * into r from extensions.http(('POST', u, array[extensions.http_header('x-hsd-key', key)], 'application/json',
    jsonb_build_object('emails', to_jsonb(p_emails))::text)::extensions.http_request);
  begin return jsonb_build_object('http', r.status) || coalesce(r.content::jsonb, '{}'::jsonb);
  exception when others then return jsonb_build_object('http', r.status, 'ok', false, 'error', left(coalesce(r.content,''),300)); end;
end $$;
revoke all on function fbw.provision_logins(text[]) from public, anon, authenticated;

create or replace function public.portal_access_provision()
returns trigger language plpgsql security definer set search_path to 'public','fbw' as $$
begin
  if not exists (select 1 from auth.users where lower(email)=lower(new.email) and email_confirmed_at is not null) then
    begin perform fbw.provision_logins(array[lower(new.email)]);
    exception when others then null;  -- never block adding a login; the customer can still sign in the old way
    end;
  end if;
  return new;
end $$;

drop trigger if exists portal_access_provision on public.portal_access;
create trigger portal_access_provision after insert on public.portal_access
  for each row execute function public.portal_access_provision();
