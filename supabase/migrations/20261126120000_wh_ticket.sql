-- Warehousing: pull a service desk ticket's machine and troubleshooting details into a warranty PO.
-- Portal: hello@ (intranet) only. Service desk / MCP SQL (not the authenticated role): allowed.
create or replace function public.wh_ticket(p_ref text)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare n int := nullif(regexp_replace(coalesce(p_ref,''), '\D', '', 'g'), '')::int; r jsonb;
begin
  if current_user in ('authenticated','anon') and not public.is_intranet() then
    raise exception 'Warehousing is only available on the hello@ account';
  end if;
  if n is null then raise exception 'Type a ticket number, e.g. HSD-1001058'; end if;
  select jsonb_build_object('num', t.num, 'ref', 'HSD-' || t.num, 'customer', coalesce(t.customer_name, p.data->>'customer'),
    'machine_id', coalesce(t.machine_id, nullif(p.data->>'assetId','')), 'type', t.type, 'subtype', t.subtype, 'status', t.status,
    'summary', t.summary, 'created', t.created, 'brand', p.data->>'brand', 'model', coalesce(p.data->>'model', t.model),
    'description', p.data->>'description', 'errorCode', p.data->>'errorCode', 'notes', p.data->>'notes',
    'billTo', p.data->>'billTo', 'warranty', p.data->'warranty', 'mimakiReport', p.data#>'{mimakiReport,fields}',
    'serial', m.serial, 'machine', case when m.id is null then null else jsonb_build_object('id', m.id, 'brand', m.brand, 'model', m.model,
      'serial', m.serial, 'ink_set', m.ink_set, 'ink_type', m.ink_type, 'install_date', m.install_date, 'warranty_end', m.warranty_end,
      'location', coalesce(m.location, m.site), 'purchased_from', m.purchased_from, 'firmware', m.firmware, 'customer', c.name) end)
    into r
  from tickets t left join ticket_private p on p.num = t.num
  left join machines m on m.id = coalesce(t.machine_id, nullif(p.data->>'assetId',''))
  left join clients c on c.id = m.client_id
  where t.num = n;
  if r is null then raise exception 'Ticket HSD-% isn''t in the service desk', n; end if;
  return r;
end $function$;
revoke all on function public.wh_ticket(text) from public, anon;
grant execute on function public.wh_ticket(text) to authenticated;
