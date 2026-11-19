-- Mimaki parameter files found in OneDrive (Client Folders), matched to machines by the serial inside
-- the file. Copied by the service desk; customers can download the files for their own machines only.
create table if not exists public.machine_files (
  id          text primary key,              -- OneDrive item id
  kind        text not null default 'parameter',
  serial      text,                           -- read from the file (Info > SERIAL No1-8)
  model       text,
  fw          text,
  name        text not null,
  param_date  date,                           -- date the machine last powered off before the file was saved
  modified    timestamptz,                    -- OneDrive last-modified
  size        int,
  content     text not null,
  machine_id  text references public.machines(id) on update cascade on delete set null,
  client_id   bigint references public.clients(id) on delete set null,
  updated_at  timestamptz not null default now()
);
create index if not exists machine_files_machine_idx on public.machine_files(machine_id);
create index if not exists machine_files_serial_idx on public.machine_files(upper(serial));
alter table public.machine_files enable row level security;

drop policy if exists files_staff on public.machine_files;
create policy files_staff on public.machine_files for all to authenticated
  using (public.is_staff()) with check (public.is_staff());
drop policy if exists files_customer on public.machine_files;
create policy files_customer on public.machine_files for select to authenticated using (
  machine_id is not null and client_id in (select public.my_client_ids())
  and exists (select 1 from public.machines m where m.id = machine_files.machine_id and m.status <> 'decommissioned'));

-- normalise a serial for matching ("GT49E399 SS22" -> "GT49E399SS22")
create or replace function public.norm_serial(s text) returns text language sql immutable as
$$ select nullif(upper(regexp_replace(coalesce(s,''), '[^A-Za-z0-9]', '', 'g')), '') $$;

-- link files to machines by serial (exact, else the machine serial starts with the file serial)
create or replace function public.desk_link_files()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with best as (
    select f.id fid, m.id mid, m.client_id cid
      from machine_files f
      cross join lateral (
        select mm.id, mm.client_id from machines mm
         where public.norm_serial(mm.serial) = public.norm_serial(f.serial)
            or (length(public.norm_serial(f.serial)) >= 8 and public.norm_serial(mm.serial) like public.norm_serial(f.serial) || '%')
         order by (public.norm_serial(mm.serial) = public.norm_serial(f.serial)) desc, (mm.status = 'active') desc
         limit 1) m
     where f.serial is not null)
  update machine_files f set machine_id = b.mid, client_id = b.cid, updated_at = now()
    from best b
   where f.id = b.fid and (f.machine_id is distinct from b.mid or f.client_id is distinct from b.cid);
  get diagnostics n = row_count;
  update machine_files f set machine_id = null, client_id = null
   where machine_id is not null and not exists (select 1 from machines m where m.id = f.machine_id
     and (public.norm_serial(m.serial) = public.norm_serial(f.serial) or public.norm_serial(m.serial) like public.norm_serial(f.serial) || '%'));
  return n;
end $$;

-- service desk: what it already has (so it only fetches new or changed files)
create or replace function public.desk_files_known()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(id, modified), '{}'::jsonb) from machine_files
$$;
-- service desk: add or replace one file
create or replace function public.desk_file_put(p jsonb)
returns void language sql security definer set search_path = public as $$
  insert into machine_files(id, kind, serial, model, fw, name, param_date, modified, size, content, updated_at)
  values (p->>'id', coalesce(p->>'kind','parameter'), nullif(upper(p->>'serial'),''), p->>'model', p->>'fw', p->>'name',
          nullif(p->>'param_date','')::date, nullif(p->>'modified','')::timestamptz, (p->>'size')::int, p->>'content', now())
  on conflict (id) do update set serial = excluded.serial, model = excluded.model, fw = excluded.fw, name = excluded.name,
    param_date = excluded.param_date, modified = excluded.modified, size = excluded.size, content = excluded.content, updated_at = now()
$$;
create or replace function public.desk_file_drop(p_ids jsonb)
returns int language sql security definer set search_path = public as $$
  with d as (delete from machine_files where id in (select jsonb_array_elements_text(p_ids)) returning 1) select count(*)::int from d
$$;
revoke all on function public.desk_link_files(), public.desk_files_known(), public.desk_file_put(jsonb), public.desk_file_drop(jsonb)
  from public, anon, authenticated;

-- new or re-serialled machines pick up their files automatically
create or replace function public.machines_relink_files() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.serial is distinct from old.serial or new.client_id is distinct from old.client_id then
    perform public.desk_link_files();
  end if;
  return new;
end $$;
drop trigger if exists machines_relink_files on public.machines;
create trigger machines_relink_files after insert or update of serial, client_id on public.machines
  for each row execute function public.machines_relink_files();
