// Highway Service Desk: email one FreshBooks estimate (PDF attached) when staff choose "Email to customer".
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

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const [k] = await sql`select v from fbw.settings where k='bridge_key'`;
  if (!k || req.headers.get("x-hsd-key") !== k.v) return json({ ok: false, error: "forbidden" }, 403);
  const b = await req.json().catch(() => ({}));
  if (b.op !== "estimate_send") return json({ ok: false, error: "unknown op" }, 400);
  try { return json(await sendEstimate(b)); }
  catch (e) {
    const msg = (e as Error).message || String(e);
    await sql`insert into fbw.log(op,ref,ok,detail) values ('estimate_send',${b.ref || null},false,${sql.json({ error: msg })})`.catch(() => {});
    return json({ ok: false, error: msg });
  }
});
