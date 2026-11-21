-- Warehousing (purchase orders, parts & stock): one set of tables used by the Service Desk app (Supabase connector)
-- and the portal (/warehousing/, hello@ only through RLS is_intranet()).
alter table public.po_vendors add column if not exists street text, add column if not exists street2 text, add column if not exists suburb text,
  add column if not exists state text, add column if not exists postcode text, add column if not exists country text,
  add column if not exists phone text, add column if not exists account text, add column if not exists fb_client_id text;
alter table public.po_orders add column if not exists po_type text default 'normal', add column if not exists warranty jsonb;

-- Calls the "warehousing" edge function (same bridge key as fbw.call).
create or replace function fbw.wh_call(req jsonb) returns jsonb
language plpgsql security definer set search_path to 'fbw','public','extensions' as $$
declare u text; key text; r extensions.http_response;
begin
  select replace(v, '/freshbooks', '/warehousing') into u from fbw.settings where k='fn_url';
  select v into key from fbw.settings where k='bridge_key';
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS','45000');
  select * into r from extensions.http(('POST', u || '/api', array[extensions.http_header('x-hsd-key', key)], 'application/json', req::text)::extensions.http_request);
  begin return jsonb_build_object('http', r.status) || coalesce(r.content::jsonb, '{}'::jsonb);
  exception when others then return jsonb_build_object('http', r.status, 'ok', false, 'error', left(coalesce(r.content,''),300)); end;
end $$;
revoke all on function fbw.wh_call(jsonb) from public, anon, authenticated;

-- Portal Warehousing gateway: hello@ only. FreshBooks lists (read only), OneDrive upload, FreshBooks client record, email a PO.
create or replace function public.wh_tool(p jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare op text := p->>'op';
begin
  if not public.is_intranet() then raise exception 'Warehousing is only available on the hello@ account'; end if;
  if op in ('fb_list','upload') then return fbw.wh_call(p); end if;
  if op = 'client_create' then return fbw.call(p || '{"ref":"warehousing-vendor"}'); end if;
  if op = 'mail_send' then return fbw.call(p); end if;
  raise exception 'Unknown tool';
end $$;
revoke all on function public.wh_tool(jsonb) from public, anon;
grant execute on function public.wh_tool(jsonb) to authenticated;

-- Warranty requests from the Service Desk tickets (fbw.po_requests), for the portal page.
create or replace function public.wh_requests(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r jsonb;
begin
  if not public.is_intranet() then raise exception 'Warehousing is only available on the hello@ account'; end if;
  if p->>'op' = 'update' then
    update fbw.po_requests set status = p->>'status', po_number = coalesce(p->>'po_number', po_number),
      note = coalesce(p->>'note', note), updated_at = now() where id = (p->>'id')::bigint;
    return '{"ok":true}';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'ticket',ticket_num,'vendor',vendor,'status',status,'payload',payload,'created',created_at) order by id desc),'[]')
    into r from fbw.po_requests where kind='warranty' and status='pending';
  return r;
end $$;
revoke all on function public.wh_requests(jsonb) from public, anon;
grant execute on function public.wh_requests(jsonb) to authenticated;
