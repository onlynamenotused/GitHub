-- Large email attachments are staged in pieces (the Supabase connector limits the size of one call), then sent in one go.
create table if not exists fbw.mail_att (
  batch text not null, seq int not null, name text not null, content_type text not null, b64 text not null default '',
  created_at timestamptz not null default now(), primary key (batch, seq));
revoke all on fbw.mail_att from public, anon, authenticated;
create or replace function fbw.mail_send_staged(p jsonb) returns jsonb
language plpgsql security definer set search_path to 'fbw','public' as $$
declare b text := p->>'batch'; r jsonb;
begin
  r := fbw.call((p - 'batch') || jsonb_build_object('op','mail_send','attachments',
        coalesce((select jsonb_agg(jsonb_build_object('name',name,'contentType',content_type,'b64',b64) order by seq) from fbw.mail_att where batch=b),'[]'::jsonb)));
  delete from fbw.mail_att where batch=b or created_at < now() - interval '1 day';
  return r;
end $$;
revoke all on function fbw.mail_send_staged(jsonb) from public, anon, authenticated;
