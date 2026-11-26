-- Op estimate_file (estimate PDF into the ticket's OneDrive folder, for Mimaki PO requests) goes to od-tickets.
create or replace function fbw.call(req jsonb)
 returns jsonb language plpgsql security definer set search_path to 'fbw', 'public', 'extensions'
as $function$
declare u text; key text; r extensions.http_response;
begin
  -- Mimaki Service Agent Agreement cl 9(c): Mimaki invoices must carry Mimaki's order number.
  if req->>'op' = 'invoice' and coalesce(req->>'billTo','') ~* 'mimaki' and coalesce(btrim(req->>'po'),'') = '' then
    return jsonb_build_object('ok', false, 'error', 'Mimaki invoices need Mimaki''s order number in PO / reference (agreement clause 9(c))');
  end if;
  select v into u from fbw.settings where k='fn_url';
  select v into key from fbw.settings where k='bridge_key';
  -- Emailing an estimate, the discount % and the ticket-number invoice number on a new draft run in fb-estimate-send, sharing the FreshBooks connection.
  if req->>'op' in ('estimate_send','doc_discount','doc_number') then u := replace(u, '/functions/v1/freshbooks', '/functions/v1/fb-estimate-send'); end if;
  -- Ticket folders, ticket copies and photo uploads go to the customer's OneDrive client folder (od-tickets).
  if req->>'op' in ('ticket_folder','ticket_copy','media_start','media_folder_link','media_delete','estimate_file') then
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
