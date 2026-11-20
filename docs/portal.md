# Customer portal (portal.highwaydigital.com.au)

Cloudflare Pages project **highway-portal** (direct upload, no Git build). Source: `portal/`.

## Pages and the menu
- `index.html` + `app.js`: the app (My machines, machine pages, Contact & booking, Book a service,
  staff-only Intranet Knowledge and Customers).
- `/kb/` and `/catalogue/`: the Customer Knowledge Base and Service and Hardware Catalogue. Stored in
  the deployment at `/_p/kb/index.html` and `/_p/catalogue/index.html` (never served directly).
  `_worker.js` checks the `hd_at` cookie against Supabase (`portal_menu()`), serves the page only if
  the customer has access, and adds the shared menu.
- `nav.js` + `nav.css`: the one menu used on every page:
  My machines · Knowledge Base* · Parts Catalogue* · Vector Converter · Contact & booking (* only if
  ticked for the customer; staff also get Intranet Knowledge and Customers). Sign out = `/#signout` from any page.

The KB and catalogue page files aren't in this repo (they were copied from the previous deployment by
content hash). To change them, publish the new HTML as `/_p/kb/index.html` / `/_p/catalogue/index.html`.

## Vector Converter
`/vector/`: image-to-vector (SVG) tool for every signed-in customer. Runs entirely in the customer's
browser (VTracer WebAssembly + imagetracerjs fallback, both inlined); images are never uploaded.
Stored as `/_p/vector/index.html`; source in this repo at `portal/_p/vector/index.html`.

## Booking
1. Service desk (while open) publishes free times every 30 min to `portal_slots`
   (Outlook + service desk schedule, working hours/lead/horizon from its booking settings;
   2 h slots for faults, 4.5 h for service/installation).
2. Customer picks a slot under **Book a service** → `book_slot()` (own machines only, no double booking,
   max 3 unconfirmed per customer).
3. Service desk checks every 2 min (`desk_pending_bookings()`), creates the ticket, books it and its
   Outlook event (no customer email), then marks the booking booked with the job number.
   If the time now clashes, the ticket is created unscheduled and the booking shows "we'll contact you".
Code in the service desk: `docs/service-desk-portal-bookings.js`.

## Customers adding machines and logging jobs
- **+ Add a machine** on My machines (customer logins only): scan the serial plate (photo → barcode reader
  where the browser has one + Tesseract.js OCR in the browser → brand/model/serial filled in for the customer to
  check), machine details, their own service schedule (interval, last service, next due) and optionally a job.
- `portal_add_machine(p)` adds the machine (`added_via='portal'`, `desk_seen=false`), `portal_set_schedule()` lets
  them change the schedule on machines they added, `portal_log_job()` logs a job without a time (`portal_jobs`).
- The service desk (portal booking check, every 2 min) reads `desk_pending_machines()` → creates the asset with
  the same id and marks it seen, and `desk_pending_jobs()` → creates an unscheduled ticket and `desk_job_done()`.

## Vendor supervisors (Avery Dennison)
- `supervisors`, `supervisor_access` (logins), `supervisor_clients` (customers + words that identify them on invoices);
  `machines.supervisor_id` puts a single machine under a supervisor. Supervisors read those customers' machines, jobs,
  files and bookings (extra RLS policies), log jobs and add machines for them, and get **Fleet reports** (`#reports`).
- Service history: `service_records`, read from the supervisor's FreshBooks client by the bridge op `sync_invoices`
  (`desk_sync_supervisors()` from the service desk every 6 h, or the staff button under Customers), then matched to
  customer and machine (serial number first, then name) by `service_records_link()`.
- Open jobs: `supervisor_jobs()` (selected ticket fields only; `ticket_private` stays staff-only).

## Deploying
Pages direct upload: assets are keyed by blake3(base64(content)+ext)[:32]; manifest maps paths to keys;
`_worker.js` goes as a form field. The deploy on 19 Nov 2026 was done from the Cloudflare dashboard
session in Chrome. Previous production deployment before this change: `d28a0314` (rollback point).
The deployment's manifest (path → key) is in `GET …/pages/projects/highway-portal/deployments/{id}` → `result.files`;
reuse it so the /_p/ pages carry over. 20 Nov 2026: `df7972e0` (add machine, plate scan, jobs; rollback `965eaf16`).
