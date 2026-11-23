-- Discount % on new FreshBooks drafts: op doc_discount goes to fb-estimate-send (same FreshBooks connection).
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
  -- Emailing an estimate, and the discount % on a new draft, run in its own small function (fb-estimate-send), sharing the FreshBooks connection.
  if req->>'op' in ('estimate_send','doc_discount') then u := replace(u, '/functions/v1/freshbooks', '/functions/v1/fb-estimate-send'); end if;
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
