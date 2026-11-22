alter table public.po_orders add column if not exists sent_info jsonb; -- who/when a PO was emailed (vendor / internal)
