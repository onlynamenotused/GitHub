# Connecting the Highway Service Desk to the portal

## Decision (19 Nov 2026)
One database: Supabase project **highway-portal** (`sfuuzcgwbbhdjqzrchvv`, Sydney).
The portal (Stage 1 schema: `clients`, `machines`, `kb_articles`, `portal_access`, `staff`,
`machine_resources`) reads it; the service desk writes it.

## How the service desk reaches Supabase
Artifact pages can't call other websites, but they can call the viewer's Claude connectors, so the
service desk uses the **Supabase connector** (`execute_sql`), as it already does for FreshBooks and M365.

- Watches `newclients`, `assets`, `tickets`, `kb`, `inventory`.
- Changed records (hash differs from last sent) go in batches of 40 to `public.desk_sync(collection, docs)`;
  deletions go to `public.desk_remove`.
- Last-sent hashes are kept in service desk doc `meta/portalsync`; first open after release = full copy.
- Failures retry with back-off (max every 5 min). Header chip: *Portal: synced / N to send / not synced*;
  click to resend everything.
- Sync only runs while the service desk is open in a browser signed in to Claude.
- Code: `docs/service-desk-portal-sync.js`.

## Mapping
| Service desk | Supabase |
|---|---|
| `newclients` | `clients` (ids 9,000,000+, `desk_ref` = NC-… id) |
| `assets` | `machines` (same ids); customer by FreshBooks id, else by name |
| `tickets` | `tickets` (portal-safe columns) + `ticket_private.data` (full record, staff only) |
| `kb` | `kb_articles` (`public` flag untouched) |
| `inventory`, other | `desk_docs` (staff only) |

A service-desk-only customer later created in FreshBooks is merged into the FreshBooks record.

## Privacy
Customers: own non-sample tickets only. Sub-contractors: tickets whose `assigned_email` is their login.
Notes, billing lines, invoice refs: `ticket_private`, staff only. Sync functions not callable by portal users.

## Migrations
Stage 1 schema was created in the dashboard before this repo; files here are additions since.
