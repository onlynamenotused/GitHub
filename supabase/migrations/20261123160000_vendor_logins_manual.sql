-- Vendor logins are now only the email addresses staff add by hand (no more "anyone at @domain").
-- vendor_contacts: known vendor email addresses (from Outlook) that staff pick from when adding logins.
update public.supervisors set login_domains = '{}';

create table if not exists public.vendor_contacts (
  supervisor_id bigint not null references public.supervisors(id) on delete cascade,
  email text not null,
  name text,
  source text not null default 'outlook',
  updated_at timestamptz not null default now(),
  primary key (supervisor_id, email)
);
alter table public.vendor_contacts enable row level security;
drop policy if exists vc_staff on public.vendor_contacts;
create policy vc_staff on public.vendor_contacts for all to authenticated using (public.is_staff()) with check (public.is_staff());

insert into public.vendor_contacts (supervisor_id, email, name)
select s.id, lower(v.email), v.name from public.supervisors s
join (values
  ('Mimaki Australia','phong.vu@mimaki.com','Quoc Phong Vu'),('Mimaki Australia','techservice@mimaki.com','Tech service'),
  ('Mimaki Australia','mery.kho@mimaki.com','Mery Kho'),('Mimaki Australia','yoonie.lee@mimaki.com','Yoonie Lee'),
  ('Mimaki Australia','abe-s@mimaki.com','Satoshi Abe'),('Mimaki Australia','simon.leung@mimaki.com','Simon Leung'),
  ('Mimaki Australia','kohei_kobayashi@mimaki.com','Kohei Kobayashi'),('Mimaki Australia','jason.hay@mimaki.com','Jason Hay'),
  ('Mimaki Australia','order.au@mimaki.com','Orders AU'),('Mimaki Australia','accounts.au@mimaki.com','Accounts AU'),
  ('Mimaki Australia','stocktransfer.aus@mimaki.com','Stock transfer AU'),('Mimaki Australia','kuldeep.sharma@mimaki.com','Kuldeep Sharma'),
  ('Brother International','leo.rocha@brother.com.au','Leo Rocha'),('Brother International','michael.westell@brother.com.au','Michael Westell'),
  ('Brother International','greg.benardos@brother.com.au','Greg Benardos'),('Brother International','richard.vanrosmalen@brother.com.au','Richard van Rosmalen'),
  ('Brother International','spareparts@brother.com.au','Spare parts'),('Brother International','sales.admin@brother.com.au','Sales admin'),
  ('Brother International','credit.dept@brother.com.au','Credit department'),
  ('Mutoh Australia','tony_firkin@mutoh-au.com','Tony Firkin'),('Mutoh Australia','alan_fillery@mutoh-au.com','Alan Fillery'),
  ('Mutoh Australia','service@mutoh-au.com','Mutoh Service'),('Mutoh Australia','sales@mutoh-au.com','Mutoh Sales'),('Mutoh Australia','info@mutoh-au.com','Mutoh Info'),
  ('ALFEX CNC Australia','jason@alfex.com.au','Jason Lee'),('ALFEX CNC Australia','irwin@alfex.com.au','Irwin Isidro'),
  ('ALFEX CNC Australia','jordan@alfex.com.au','Jordan Buhagiar'),('ALFEX CNC Australia','christian@alfex.com.au','Christian Buhagiar'),
  ('ALFEX CNC Australia','leigh@alfex.com.au','Leigh Hope'),('ALFEX CNC Australia','maryanne@alfex.com.au','Maryanne Buhagiar'),
  ('ALFEX CNC Australia','fab@alfex.com.au','Fab De Fazio'),('ALFEX CNC Australia','david@alfex.com.au','David Wilson'),
  ('ALFEX CNC Australia','accounts@alfex.com.au','Accounts'),('ALFEX CNC Australia','accounts@alfexlaser.com.au','Accounts (alfexlaser)'),
  ('ALFEX CNC Australia','reception@alfex.com.au','Reception'),('ALFEX CNC Australia','warehouse@alfex.com.au','Warehouse')
) as v(sup, email, name) on v.sup = s.name
on conflict (supervisor_id, email) do update set name = excluded.name, updated_at = now();

-- Vendor logins: only addresses listed in supervisor_access.
create or replace function public.my_supervisor_ids() returns setof bigint
language sql stable security definer set search_path = public as $$
  select s.id from supervisors s
   where s.enabled and public.current_email() <> ''
     and exists (select 1 from supervisor_access sa where sa.supervisor_id = s.id and lower(sa.email) = public.current_email())
$$;
