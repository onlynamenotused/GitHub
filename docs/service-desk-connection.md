# Connecting the Highway Service Desk to the portal

## Decision (19 Nov 2026)
One database: Supabase project **highway-portal** (Sydney) holds customers, machines, tickets,
knowledge base and parts. The customer portal (portal.highwaydigital.com.au, Cloudflare) reads it;
the service desk writes it.

## How the service desk reaches Supabase
The service desk is a Claude artifact. Artifact pages can't make network calls to other sites,
but they can call the viewer's Claude connectors. So the service desk uses the **Supabase
connector** (same way it already uses FreshBooks and Microsoft 365):

1. **Initial copy** – a one-off "Copy everything to the portal" button sends every collection,
   in batches, to `public.desk_upsert(collection, docs)`.
2. **Live sync** – every save/delete in the service desk also calls `desk_upsert` / `desk_delete`,
   so the portal is always current. Failed calls queue in the service desk and retry.

Collections map to tables: `tickets → tickets`, `assets → machines` (+ customers),
`newclients` / FreshBooks clients → `customers`, `kb → kb_articles`, `inventory → parts`,
everything else → `desk_docs`.

## Privacy
- RLS: customers see only their own customer row, machines and (non-sample) tickets;
  sub-contractors see only tickets assigned to them; staff see everything.
- Column grants: `data` jsonb (invoice numbers, notes, buy prices) is never readable by
  customer or sub-contractor sessions.
- KB and catalogue are off per customer until staff tick `kb_access` / `catalogue_access`.
  KB articles default to `intranet` (staff only).
- `portal_enabled` must be ticked before a customer can see anything; no customer emails are sent
  until Sean says so.

## Migrations
`supabase/migrations/` – applied in the SQL editor or with `supabase db push`.
