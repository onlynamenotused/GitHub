-- Tickets take their customer from the linked machine; never create customers from ticket free text.
-- (desk_sync's tickets branch calls desk_ticket_client(v); full desk_sync body as applied in Supabase,
--  identical to 20261119100000 except `cid := desk_ticket_client(v);` in the tickets branch.)
create or replace function public.desk_ticket_client(v jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare cid bigint;
begin
  select client_id into cid from machines where id = nullif(v->>'assetId','');
  if cid is not null then return cid; end if;
  if nullif(v->>'clientId','') is not null or nullif(v->>'newClientId','') is not null then
    return desk_client_id(v->>'clientId', nullif(v->>'newClientId',''), v->>'customer');
  end if;
  select id into cid from clients where lower(name) = lower(v->>'customer') order by id limit 1;
  return cid;
end $$;
revoke all on function public.desk_ticket_client(jsonb) from public, anon, authenticated;
