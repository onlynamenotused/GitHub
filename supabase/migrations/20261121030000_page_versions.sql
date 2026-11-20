-- Version labels on the portal's own pages ("Version 1.22 Beta · 21 Nov 2026" on the Knowledge Base and the
-- Parts Catalogue) now update themselves. The portal worker hashes each page as it serves it; when the file has
-- changed since the last view, the minor version goes up by one and the date becomes today (Perth). The worker
-- then writes the current version into the page, so the number in the file itself no longer matters.
create table if not exists public.page_versions (
  path     text primary key,           -- gated page key: kb, catalogue, vector
  hash     text,                       -- hash of the page file last seen (null = adopt the next one without a bump)
  major    int not null default 1,
  minor    int not null default 0,
  updated  date not null default (now() at time zone 'Australia/Perth')::date,
  bumped_at timestamptz
);
alter table public.page_versions enable row level security;   -- read and written only through page_version()

insert into public.page_versions(path, hash, major, minor, updated) values
  ('kb', null, 1, 22, '2026-11-21'),
  ('catalogue', null, 1, 21, '2026-11-13')
on conflict (path) do nothing;

create or replace function public.page_version(p_path text, p_hash text) returns jsonb
 language plpgsql security definer set search_path = public as $$
declare r page_versions; today date := (now() at time zone 'Australia/Perth')::date;
begin
  if p_path not in ('kb', 'catalogue', 'vector') or coalesce(p_hash, '') !~ '^[0-9a-f]{16,64}$' then return null; end if;
  select * into r from page_versions where path = p_path for update;
  if not found then
    insert into page_versions(path, hash, major, minor, updated) values (p_path, p_hash, 1, 0, today) returning * into r;
  elsif r.hash is null then
    update page_versions set hash = p_hash where path = p_path returning * into r;
  elsif r.hash <> p_hash and (r.bumped_at is null or r.bumped_at < now() - interval '2 minutes') then
    update page_versions set hash = p_hash, minor = minor + 1, updated = today, bumped_at = now() where path = p_path returning * into r;
  end if;
  return jsonb_build_object('v', r.major || '.' || lpad(r.minor::text, 2, '0'), 'date', to_char(r.updated, 'FMDD Mon YYYY'));
end $$;
revoke all on function public.page_version(text, text) from public, anon;
grant execute on function public.page_version(text, text) to authenticated;
