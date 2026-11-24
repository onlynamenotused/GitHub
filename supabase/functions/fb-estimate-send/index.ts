// Highway Service Desk: email one FreshBooks estimate (PDF attached) when staff choose "Email to customer" (op estimate_send),
// and set the discount % on a just-created draft invoice/estimate (op doc_discount).
// Reached only through fbw.call() (op estimate_send), which holds the bridge key. Shares the FreshBooks
// connection (fbw.conn) with the "freshbooks" bridge function and refreshes it the same way.
// Deployed with verify_jwt=false (the x-hsd-key check below is the auth).
import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
const env = (k: string) => Deno.env.get(k) ?? "";
const FB_ID = env("FRESHBOOKS_CLIENT_ID"), FB_SECRET = env("FRESHBOOKS_CLIENT_SECRET");
const FB_REDIRECT = "https://sfuuzcgwbbhdjqzrchvv.supabase.co/functions/v1/freshbooks/callback";
const FB_API = "https://api.freshbooks.com";
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

async function fbToken(body: Record<string, string>) {
  const r = await fetch(FB_API + "/auth/oauth/token", {
    method: "POST", headers: { "content-type": "application/json", "Api-Version": "alpha" },
    body: JSON.stringify({ client_id: FB_ID, client_secret: FB_SECRET, redirect_uri: FB_REDIRECT, ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("FreshBooks token error: " + (j.error_description || j.error || r.status));
  return j;
}
async function token() {
  return await sql.begin(async (tx) => {
    const [c] = await tx`select * from fbw.conn where provider='freshbooks' for update`;
    if (!c || !c.refresh_token) throw new Error("not_connected:freshbooks");
    if (c.access_token && c.expires_at && new Date(c.expires_at).getTime() - Date.now() > 120000) return c;
    const t = await fbToken({ grant_type: "refresh_token", refresh_token: c.refresh_token });
    const [n] = await tx`update fbw.conn set access_token=${t.access_token}, refresh_token=${t.refresh_token || c.refresh_token},
      expires_at=${new Date(Date.now() + (t.expires_in || 3600) * 1000)}, last_error=null where provider='freshbooks' returning *`;
    return n;
  });
}
async function sendEstimate(d: any) {
  const id = parseInt(d.id, 10); if (!id) throw new Error("No estimate to send");
  const to = [].concat(d.to || []).map((x: any) => String(x).trim()).filter((x: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).slice(0, 5);
  if (!to.length) return { ok: false, error: "No valid email address" };
  const c = await token();
  const r = await fetch(`${FB_API}/accounting/account/${c.account_id}/estimates/estimates/${id}`, {
    method: "PUT", headers: { "content-type": "application/json", "Api-Version": "alpha", authorization: "Bearer " + c.access_token },
    body: JSON.stringify({ estimate: { action_email: true, email_recipients: to, email_include_pdf: true } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const errs = j?.response?.errors || j?.errors;
    throw new Error(`FreshBooks ${r.status}: ` + (Array.isArray(errs) ? errs.map((e: any) => e.message || e.errno).join("; ") : (j.message || r.statusText)));
  }
  const x = j?.response?.result?.estimate || {};
  await sql`insert into fbw.log(op,ref,ok,fb_id,fb_number,detail) values ('estimate_send',${d.ref || null},true,${String(id)},${String(x.estimate_number ?? "")},${sql.json({ to })})`;
  return { ok: true, id: String(id), number: String(x.estimate_number ?? ""), status: x.v3_status || x.ui_status || null, sentTo: to };
}

/* Discount % on a FreshBooks draft invoice or estimate (FreshBooks applies it to the subtotal, before tax).
   Called right after the service desk creates the draft; never sends anything. */
async function docDiscount(d: any) {
  const kind = d.kind === "invoice" ? "invoice" : d.kind === "estimate" ? "estimate" : "";
  const id = parseInt(d.id, 10); if (!kind || !id) throw new Error("No draft to discount");
  const pct = Math.round(Math.min(100, Math.max(0, +d.pct || 0)) * 100) / 100;
  const c = await token();
  const path = kind === "invoice" ? "invoices/invoices" : "estimates/estimates";
  const r = await fetch(`${FB_API}/accounting/account/${c.account_id}/${path}/${id}`, {
    method: "PUT", headers: { "content-type": "application/json", "Api-Version": "alpha", authorization: "Bearer " + c.access_token },
    body: JSON.stringify({ [kind]: { discount_value: String(pct) } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const errs = j?.response?.errors || j?.errors;
    throw new Error(`FreshBooks ${r.status}: ` + (Array.isArray(errs) ? errs.map((e: any) => e.message || e.errno).join("; ") : (j.message || r.statusText)));
  }
  const x = j?.response?.result?.[kind] || {};
  await sql`insert into fbw.log(op,ref,ok,fb_id,fb_number,total,detail) values ('doc_discount',${d.ref || null},true,${String(id)},${String(x.invoice_number ?? x.estimate_number ?? "")},${x.amount?.amount ?? null},${sql.json({ kind, pct })})`;
  return { ok: true, id: String(id), pct, total: x.amount?.amount ?? null };
}

/* Invoice number = the service desk ticket number (HSD-1001052), the customer's PO in Reference, and the due date
   from the client's payment terms (public.invoice_terms; 7 days for a new client; Avery: last day of next month).
   Called right after the desk creates a draft invoice. If FreshBooks already has that number, the next free
   "-2", "-3"… is used. Never sends anything. */
async function docNumber(d: any) {
  const kind = d.kind === "estimate" ? "estimate" : "invoice";
  const id = parseInt(d.id, 10); if (!id) throw new Error("No draft to number");
  const base = String(d.number || "").trim().slice(0, 22); if (!base) throw new Error("No ticket number");
  const c = await token();
  const path = kind === "invoice" ? "invoices/invoices" : "estimates/estimates";
  const field = kind === "invoice" ? "invoice_number" : "estimate_number";
  const start = Math.max(1, parseInt(d.start, 10) || 1);
  const extra: Record<string, unknown> = {};
  if (d.po != null && String(d.po).trim()) extra.po_number = String(d.po).trim().slice(0, 30);
  const cid = parseInt(d.clientId, 10);
  if (kind === "invoice" && cid) { const [t] = await sql`select public.invoice_due_days(${cid}) as n`; if (t && t.n != null) extra.due_offset_days = Number(t.n); }
  const put = async (body: Record<string, unknown>) => {
    const r = await fetch(`${FB_API}/accounting/account/${c.account_id}/${path}/${id}`, {
      method: "PUT", headers: { "content-type": "application/json", "Api-Version": "alpha", authorization: "Bearer " + c.access_token },
      body: JSON.stringify({ [kind]: body }),
    });
    const j = await r.json().catch(() => ({}));
    const errs = j?.response?.errors || j?.errors;
    return { ok: r.ok, x: j?.response?.result?.[kind] || {}, err: r.ok ? "" : `FreshBooks ${r.status}: ` + (Array.isArray(errs) ? errs.map((e: any) => e.message || e.errno).join("; ") : (j.message || r.statusText)) };
  };
  const done = async (x: any, numErr: string) => {
    const got = String(x[field] ?? "");
    await sql`insert into fbw.log(op,ref,ok,fb_id,fb_number,detail) values ('doc_number',${d.ref || null},${!numErr},${String(id)},${got},${sql.json({ kind, po: x.po_number ?? null, due: x.due_date ?? null, due_days: x.due_offset_days ?? null, numErr: numErr || null })})`;
    return { ok: true, id: String(id), number: got, po: x.po_number ?? null, due: x.due_date ?? null, dueDays: x.due_offset_days ?? extra.due_offset_days ?? null, numberError: numErr || undefined };
  };
  let last = "";
  for (let n = start; n < start + 6; n++) {
    const num = n === 1 ? base : `${base}-${n}`;
    const r = await put({ ...extra, [field]: num });
    if (r.ok) return await done(r.x, "");
    last = r.err;
    if (!/number|exist|unique|taken|duplicate/i.test(last)) break;   // only retry when the number is the problem
  }
  // The number wasn't taken: still set the PO and due date.
  if (Object.keys(extra).length) { const r = await put(extra); if (r.ok) return await done(r.x, last || "number not accepted"); }
  throw new Error(last || "FreshBooks didn't take the number");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const [k] = await sql`select v from fbw.settings where k='bridge_key'`;
  if (!k || req.headers.get("x-hsd-key") !== k.v) return json({ ok: false, error: "forbidden" }, 403);
  const b = await req.json().catch(() => ({}));
  if (b.op !== "estimate_send" && b.op !== "doc_discount" && b.op !== "doc_number") return json({ ok: false, error: "unknown op" }, 400);
  try { return json(b.op === "doc_discount" ? await docDiscount(b) : b.op === "doc_number" ? await docNumber(b) : await sendEstimate(b)); }
  catch (e) {
    const msg = (e as Error).message || String(e);
    await sql`insert into fbw.log(op,ref,ok,detail) values (${b.op},${b.ref || null},false,${sql.json({ error: msg })})`.catch(() => {});
    return json({ ok: false, error: msg });
  }
});
