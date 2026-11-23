// Highway Service Desk portal: download the FreshBooks PDF of one invoice the signed-in login can see
// (vendor logins with prices hidden included: the invoice itself is theirs to keep).
// Deployed with verify_jwt=true; the access check runs as the caller (role authenticated + their JWT claims),
// so it sees exactly the service_records / service_records_np rows the portal shows them.
import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
const env = (k: string) => Deno.env.get(k) ?? "";
const FB_ID = env("FRESHBOOKS_CLIENT_ID"), FB_SECRET = env("FRESHBOOKS_CLIENT_SECRET");
const FB_REDIRECT = "https://sfuuzcgwbbhdjqzrchvv.supabase.co/functions/v1/freshbooks/callback";
const FB_API = "https://api.freshbooks.com";
const ORIGINS = ["https://portal.highwaydigital.com.au"];
const cors = (req: Request) => {
  const o = req.headers.get("origin") || "";
  return { "access-control-allow-origin": ORIGINS.includes(o) || /\.pages\.dev$/.test(o) ? o : ORIGINS[0],
    "access-control-allow-headers": "authorization, apikey, content-type, x-client-info", "access-control-allow-methods": "POST, OPTIONS",
    "access-control-expose-headers": "content-disposition", vary: "origin" };
};

async function fbToken(body: Record<string, string>) {
  const r = await fetch(FB_API + "/auth/oauth/token", { method: "POST", headers: { "content-type": "application/json", "Api-Version": "alpha" },
    body: JSON.stringify({ client_id: FB_ID, client_secret: FB_SECRET, redirect_uri: FB_REDIRECT, ...body }) });
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
function claims(req: Request) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const p = t.split(".")[1]; if (!p) return null;
  try { return JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/"))); } catch { return null; }
}

Deno.serve(async (req) => {
  const h = cors(req);
  const fail = (error: string, status = 400) => new Response(JSON.stringify({ ok: false, error }), { status, headers: { ...h, "content-type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  if (req.method !== "POST") return fail("POST only", 405);
  const cl = claims(req);
  if (!cl || cl.role !== "authenticated" || !cl.email) return fail("Sign in first", 401);
  const b = await req.json().catch(() => ({}));
  const id = String(b.id || "");
  if (!/^fbinv-\d+$/.test(id)) return fail("No invoice");
  // Access check as the caller
  const row = await sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(cl)}, true)`;
    await tx.unsafe("set local role authenticated");
    const [r] = await tx`select id, number, status from public.service_records where id = ${id}
                         union all select id, number, status from public.service_records_np where id = ${id} limit 1`;
    return r;
  });
  if (!row || row.status === "draft") return fail("That invoice isn't available to this login", 403);
  try {
    const c = await token();
    const r = await fetch(`${FB_API}/accounting/account/${c.account_id}/invoices/invoices/${id.slice(6)}/pdf`,
      { headers: { authorization: "Bearer " + c.access_token, accept: "application/pdf", "Api-Version": "alpha" } });
    if (!r.ok) return fail("FreshBooks " + r.status, 502);
    const name = `Highway Digital invoice ${row.number}.pdf`;
    await sql`insert into fbw.log(op,ref,ok,fb_id,fb_number,detail) values ('invoice_pdf',${cl.email},true,${id.slice(6)},${row.number},${sql.json({})})`.catch(() => {});
    return new Response(r.body, { headers: { ...h, "content-type": "application/pdf", "content-disposition": `attachment; filename="${name}"` } });
  } catch (e) { return fail((e as Error).message || String(e), 502); }
});
