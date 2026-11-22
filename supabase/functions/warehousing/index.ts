// Highway Warehousing bridge (Supabase Edge Function "warehousing").
// Gives the portal's Warehousing page (hello@ only, via public.wh_tool) the same FreshBooks and OneDrive reach the
// Service Desk app gets from its connectors. Read-only on FreshBooks; OneDrive upload of PO PDFs / warranty forms only.
// Uses the same token store (fbw.conn, row-locked refresh) and bridge key as the "freshbooks" function.
//   POST /warehousing/api  {op:"fb_list", tool:"list_invoices"|"list_estimates"|"list_clients", page, per_page}
//                          {op:"upload", driveId, parentItemId, filename, contentType, b64}
//                          {op:"fb_contacts", client_id}  (Service Desk: who to email on a ticket)
import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const env = (k: string) => Deno.env.get(k) ?? "";
const FB_ID = env("FRESHBOOKS_CLIENT_ID"), FB_SECRET = env("FRESHBOOKS_CLIENT_SECRET");
const MS_ID = env("MS_CLIENT_ID"), MS_SECRET = env("MS_CLIENT_SECRET"), MS_TENANT = env("MS_TENANT_ID") || "organizations";
const FN_URL = "https://sfuuzcgwbbhdjqzrchvv.supabase.co/functions/v1/freshbooks";
const FB_REDIRECT = FN_URL + "/callback", MS_REDIRECT = FN_URL + "/ms-callback";
const FB_API = "https://api.freshbooks.com", GRAPH = "https://graph.microsoft.com/v1.0";
const MS_SCOPE = "offline_access User.Read Files.ReadWrite";
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

async function storedToken(provider: string, refresh: (rt: string) => Promise<{ access_token: string; refresh_token?: string; expires_in: number }>) {
  return await sql.begin(async (tx) => {
    const [c] = await tx`select * from fbw.conn where provider=${provider} for update`;
    if (!c || !c.refresh_token) throw new Error("not_connected:" + provider);
    if (c.access_token && c.expires_at && new Date(c.expires_at).getTime() - Date.now() > 120000) return c;
    const t = await refresh(c.refresh_token);
    const [n] = await tx`update fbw.conn set access_token=${t.access_token}, refresh_token=${t.refresh_token || c.refresh_token},
      expires_at=${new Date(Date.now() + (t.expires_in || 3600) * 1000)}, last_error=null where provider=${provider} returning *`;
    return n;
  });
}
async function fbToken(body: Record<string, string>) {
  const r = await fetch(FB_API + "/auth/oauth/token", { method: "POST", headers: { "content-type": "application/json", "Api-Version": "alpha" },
    body: JSON.stringify({ client_id: FB_ID, client_secret: FB_SECRET, redirect_uri: FB_REDIRECT, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("FreshBooks token error: " + (j.error_description || j.error || r.status));
  return j;
}
async function fb(path: string) {
  const c = await storedToken("freshbooks", (rt) => fbToken({ grant_type: "refresh_token", refresh_token: rt }));
  const r = await fetch(FB_API + path.replace("{account}", c.account_id), { headers: { "content-type": "application/json", "Api-Version": "alpha", authorization: "Bearer " + c.access_token } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const errs = j?.response?.errors || j?.errors; throw new Error(`FreshBooks ${r.status}: ${Array.isArray(errs) ? errs.map((e: any) => e.message || e.errno).join("; ") : (j.message || r.statusText)}`); }
  return j;
}
async function msToken(body: Record<string, string>) {
  const r = await fetch(`https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: MS_ID, client_secret: MS_SECRET, redirect_uri: MS_REDIRECT, scope: MS_SCOPE, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("Microsoft token error: " + (j.error_description || j.error || r.status));
  return j;
}

/* FreshBooks lists, shaped like the FreshBooks connector's results so the page uses one code path. */
async function fbList(d: any) {
  const pg = Math.max(1, Math.min(40, parseInt(d.page, 10) || 1)), per = Math.max(1, Math.min(100, parseInt(d.per_page, 10) || 30));
  const A = "/accounting/account/{account}";
  const who = (x: any) => x.current_organization || x.organization || [x.fname, x.lname].filter(Boolean).join(" ");
  const lines = (x: any) => (x.lines || []).map((l: any) => ({ name: l.name || "", description: l.description || "", quantity: +l.qty || 0, unit_cost: +(l.unit_cost?.amount || 0) }));
  const live = (x: any) => !x.vis_state || +x.vis_state === 0;
  if (d.tool === "list_invoices") {
    const r = (await fb(`${A}/invoices/invoices?include[]=lines&per_page=${per}&page=${pg}&sort=invoice_number_desc`))?.response?.result || {};
    return { ok: true, total_pages: r.pages || 1, page: r.page || pg, invoices: (r.invoices || []).filter(live).map((x: any) => ({
      invoice_id: x.invoiceid ?? x.id, invoice_number: x.invoice_number, client: { name: who(x) }, po_number: x.po_number || "", create_date: x.create_date,
      display_status: x.display_status || x.v3_status || "", lines: lines(x) })) };
  }
  if (d.tool === "list_estimates") {
    const r = (await fb(`${A}/estimates/estimates?include[]=lines&per_page=${per}&page=${pg}&sort=estimate_number_desc`))?.response?.result || {};
    return { ok: true, total_pages: r.pages || 1, page: r.page || pg, estimates: (r.estimates || []).filter(live).map((x: any) => ({
      estimate_id: x.estimateid ?? x.id, estimate_number: x.estimate_number, client_name: who(x), po_number: x.po_number || "", create_date: x.create_date,
      display_status: x.display_status || x.v3_status || x.status || "", lines: lines(x) })) };
  }
  if (d.tool === "list_clients") {
    const r = (await fb(`${A}/users/clients?per_page=${per}&page=${pg}`))?.response?.result || {};
    return { ok: true, total_pages: r.pages || 1, page: r.page || pg, clients: (r.clients || []).map((c: any) => ({
      id: c.id ?? c.userid, organization: c.organization || "", display_name: c.organization || [c.fname, c.lname].filter(Boolean).join(" "),
      first_name: c.fname || "", last_name: c.lname || "", email: c.email || "", business_phone: c.bus_phone || "", mobile_phone: c.mob_phone || "", home_phone: c.home_phone || "",
      status: live(c) ? "active" : "archived",
      primary_mailing_address: { street: c.p_street || "", street2: c.p_street2 || "", city: c.p_city || "", province: c.p_province || "", postal_code: c.p_code || "" } })) };
  }
  throw new Error("Unknown FreshBooks list");
}

/* One client's people: the main contact plus FreshBooks "additional contacts". */
async function fbContacts(d: any) {
  const id = parseInt(d.client_id, 10); if (!id) throw new Error("client_id needed");
  const j = await fb(`/accounting/account/{account}/users/clients/${id}?include[]=contacts`);
  const c = j?.response?.result?.client || {};
  const people: any[] = [];
  const add = (name: string, email: string, role: string, phone = "") => { email = String(email || "").trim(); if (email && !people.some((p) => p.email.toLowerCase() === email.toLowerCase())) people.push({ name: name.trim(), email, role, phone }); };
  add([c.fname, c.lname].filter(Boolean).join(" "), c.email, "main", c.mob_phone || c.bus_phone || c.home_phone || "");
  for (const x of c.contacts || []) add([x.fname, x.lname].filter(Boolean).join(" "), x.email, "contact", x.phone1 || x.phone2 || "");
  return { ok: true, client_id: id, organization: c.organization || "", people };
}

/* OneDrive: put one PO PDF or warranty form in a vendor's folder. */
async function upload(d: any) {
  const drive = String(d.driveId || ""), parent = String(d.parentItemId || "");
  if (!/^[\w!.\-]+$/.test(drive) || !/^[\w!.\-]+$/.test(parent)) throw new Error("Set the vendor's OneDrive folder first");
  const bytes = Uint8Array.from(atob(String(d.b64 || "")), (ch) => ch.charCodeAt(0));
  if (!bytes.length || bytes.length > 3_500_000) throw new Error("File is empty or too large");
  const name = String(d.filename || "file").replace(/[\\/:*?"<>|#%]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 120) || "file";
  if (!/\.(pdf|xlsx)$/i.test(name)) throw new Error("Only PDF or XLSX files");
  const c = await storedToken("microsoft", (rt) => msToken({ grant_type: "refresh_token", refresh_token: rt }));
  const r = await fetch(`${GRAPH}/drives/${drive}/items/${parent}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=rename`, {
    method: "PUT", body: bytes, headers: { authorization: "Bearer " + c.access_token, "content-type": String(d.contentType || "application/octet-stream") } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OneDrive ${r.status}: ${j?.error?.message || r.statusText}`);
  return { ok: true, id: j.id, name: j.name, webUrl: j.webUrl };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method !== "POST" || !url.pathname.endsWith("/api")) return json({ ok: false, error: "not found" }, 404);
  const [k] = await sql`select v from fbw.settings where k='bridge_key'`;
  if (!k || req.headers.get("x-hsd-key") !== k.v) return json({ ok: false, error: "forbidden" }, 403);
  const b = await req.json().catch(() => ({}));
  try {
    if (b.op === "fb_list") return json(await fbList(b));
    if (b.op === "upload") return json(await upload(b));
    if (b.op === "fb_contacts") return json(await fbContacts(b));
    return json({ ok: false, error: "unknown op" }, 400);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message });
  }
});
