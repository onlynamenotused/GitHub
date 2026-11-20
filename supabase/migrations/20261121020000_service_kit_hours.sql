-- Hours each service kit takes on site (annual and 6-month), recorded by staff on the Service kits page and shown on
-- the customer's quote. The function changes that carry them are in 20261121010000_service_kits.sql.
alter table public.service_kits add column if not exists annual_hours numeric(4,1);
alter table public.service_kits add column if not exists six_hours numeric(4,1);
