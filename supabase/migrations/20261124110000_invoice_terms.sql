-- Invoice payment terms per FreshBooks client, used to set the due date on every new draft invoice the service desk makes.
-- rule 'net' = due {days} days after the invoice date; 'eom_next' = due on the last day of the month after the invoice date (Avery Dennison).
-- Seeded from FreshBooks: each client's usual gap between invoice date and due date over its last 8 invoices.
-- Clients with no history, and any new client, get 7 days. Staff change them in the service desk (Clients > Payment terms).
create table if not exists public.invoice_terms (
  fb_client_id bigint primary key,
  client_name text,
  rule text not null default 'net' check (rule in ('net','eom_next')),
  days int not null default 7 check (days between 0 and 365),
  source text not null default 'default' check (source in ('freshbooks','manual','default')),
  note text,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.invoice_terms enable row level security;
drop policy if exists it_staff on public.invoice_terms;
create policy it_staff on public.invoice_terms for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- Every client with FreshBooks invoices, the portal's clients and the vendors. (Other FreshBooks clients show as 7 days in the desk
-- until their terms are changed or their first invoice is made.)
insert into public.invoice_terms (fb_client_id, client_name)
select c.id, c.name from clients c on conflict (fb_client_id) do nothing;
insert into public.invoice_terms (fb_client_id, client_name)
select distinct f.client_id, coalesce(c.name, s.name) from fb_invoices f left join clients c on c.id = f.client_id left join supervisors s on s.fb_client_id = f.client_id
 where f.client_id is not null
on conflict (fb_client_id) do nothing;
insert into public.invoice_terms (fb_client_id, client_name)
select s.fb_client_id, s.name from supervisors s where s.fb_client_id is not null
on conflict (fb_client_id) do nothing;

-- Terms from FreshBooks history: the most common due gap on each client's last 8 invoices
with x as (select client_id, (due - issued) d, row_number() over (partition by client_id order by issued desc, number desc) rn
             from fb_invoices where due is not null and issued is not null and due >= issued),
     m as (select client_id, mode() within group (order by d) d from x where rn <= 8 group by client_id)
update public.invoice_terms t set rule = 'net', days = least(m.d, 365), source = 'freshbooks', updated_at = now()
  from m where m.client_id = t.fb_client_id and t.source <> 'manual';

-- Avery Dennison: due the last day of the month after the invoice date
update public.invoice_terms set rule = 'eom_next', days = 0, source = 'manual', note = 'Due the last day of the following month', updated_at = now()
 where fb_client_id = (select fb_client_id from supervisors where name = 'Avery Dennison');

-- Days from the invoice date to the due date for one client; a client with no terms yet gets 7 days (and a row, so it shows up to edit)
create or replace function public.invoice_due_days(p_client bigint, p_date date default (now() at time zone 'Australia/Perth')::date)
returns int language plpgsql security definer set search_path = public as $$
declare t invoice_terms;
begin
  select * into t from invoice_terms where fb_client_id = p_client;
  if t.fb_client_id is null then
    insert into invoice_terms (fb_client_id, client_name, rule, days, source)
    values (p_client, (select name from clients where id = p_client), 'net', 7, 'default') on conflict do nothing;
    return 7;
  end if;
  if t.rule = 'eom_next' then
    return ((date_trunc('month', p_date) + interval '2 months' - interval '1 day')::date - p_date);
  end if;
  return t.days;
end $$;
revoke all on function public.invoice_due_days(bigint, date) from public, anon;
grant execute on function public.invoice_due_days(bigint, date) to authenticated, service_role;
