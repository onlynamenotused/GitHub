-- Warehousing's Service Desk inbox: warranty claims and normal parts orders ('order') from tickets.
create or replace function public.wh_requests(p jsonb default '{}'::jsonb)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare r jsonb;
begin
  if not public.is_intranet() then raise exception 'Warehousing is only available on the hello@ account'; end if;
  if p->>'op' = 'update' then
    update fbw.po_requests set status = p->>'status', po_number = coalesce(p->>'po_number', po_number),
      note = coalesce(p->>'note', note), updated_at = now() where id = (p->>'id')::bigint;
    return '{"ok":true}';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'ticket',ticket_num,'vendor',vendor,'status',status,'payload',payload,'created',created_at) order by id desc),'[]')
    into r from fbw.po_requests where kind in ('warranty','order') and status='pending';
  return r;
end $function$;
