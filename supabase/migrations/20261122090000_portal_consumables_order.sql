-- Portal "Book a service" gets a 4th option: Consumables order (customer describes the items; no visit time).
alter table public.portal_jobs drop constraint if exists portal_jobs_kind_check;
alter table public.portal_jobs add constraint portal_jobs_kind_check check (kind = any (array['fault','service','install','other','consumables']));
-- portal_log_job: accepts kind 'consumables' (see live definition; same as before plus the new kind and its message).
