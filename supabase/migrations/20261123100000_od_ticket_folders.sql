-- Ticket folders in OneDrive (Client Folders/<customer>/<ticket>-...): remembered customer folder per customer,
-- and fbw.call routes the OneDrive ticket ops to the small od-tickets function (media_chunk stays in "freshbooks").
create table if not exists fbw.client_folders (
  key text primary key,            -- normalised customer name
  folder_id text not null,
  name text,
  updated_at timestamptz not null default now()
);
revoke all on fbw.client_folders from public, anon, authenticated;

create or replace function fbw.call(req jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'fbw', 'public', 'extensions'
as $function$
declare u text; key text; r extensions.http_response;
begin
  select v into u from fbw.settings where k='fn_url';
  select v into key from fbw.settings where k='bridge_key';
  -- Emailing an estimate runs in its own small function (fb-estimate-send), sharing the FreshBooks connection.
  if req->>'op' = 'estimate_send' then u := replace(u, '/functions/v1/freshbooks', '/functions/v1/fb-estimate-send'); end if;
  -- Ticket folders, ticket copies and photo uploads go to the customer's OneDrive client folder (od-tickets).
  if req->>'op' in ('ticket_folder','ticket_copy','media_start','media_folder_link','media_delete') then
    u := replace(u, '/functions/v1/freshbooks', '/functions/v1/od-tickets');
  end if;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS','45000');
  select * into r from extensions.http((
    'POST', u || '/api',
    array[extensions.http_header('x-hsd-key', key)],
    'application/json', req::text)::extensions.http_request);
  begin
    return jsonb_build_object('http', r.status) || coalesce(r.content::jsonb, '{}'::jsonb);
  exception when others then
    return jsonb_build_object('http', r.status, 'ok', false, 'error', left(coalesce(r.content,''),300));
  end;
end $function$;
