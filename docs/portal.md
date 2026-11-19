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
  My machines · Knowledge Base* · Parts Catalogue* · Contact & booking (* only if ticked for the
  customer; staff also get Intranet Knowledge and Customers). Sign out = `/#signout` from any page.

The KB and catalogue page files aren't in this repo (they were copied from the previous deployment by
content hash). To change them, publish the new HTML as `/_p/kb/index.html` / `/_p/catalogue/index.html`.

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

## Deploying
Pages direct upload: assets are keyed by blake3(base64(content)+ext)[:32]; manifest maps paths to keys;
`_worker.js` goes as a form field. The deploy on 19 Nov 2026 was done from the Cloudflare dashboard
session in Chrome. Previous production deployment before this change: `d28a0314` (rollback point).
