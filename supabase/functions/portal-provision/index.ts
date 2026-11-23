// Highway portal: set up (and confirm) the sign-in account for each customer login as soon as it is added to
// portal_access, so the customer's first sign-in email is the Magic Link email (button + 6-digit code) instead of
// Supabase's "Confirm signup" email. Called by the portal_access insert trigger through fbw (bridge key check).
// Deployed with verify_jwt=false (the x-hsd-key check below is the auth).
import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
const URL_ = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const admin = (path: string, init: RequestInit = {}) => fetch(`${URL_}/auth/v1/admin${path}`, {
  ...init, headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json", ...(init.headers || {}) },
});
const okEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

async function provision(email: string) {
  email = String(email || "").trim().toLowerCase();
  if (!okEmail(email)) return { email, ok: false, error: "bad email" };
  const [u] = await sql`select id, email_confirmed_at from auth.users where lower(email) = ${email} limit 1`;
  if (u && u.email_confirmed_at) return { email, ok: true, state: "already set up" };
  if (u) {
    const r = await admin(`/users/${u.id}`, { method: "PUT", body: JSON.stringify({ email_confirm: true }) });
    return { email, ok: r.ok, state: r.ok ? "confirmed existing" : "confirm failed", status: r.status };
  }
  const r = await admin(`/users`, { method: "POST", body: JSON.stringify({ email, email_confirm: true }) });
  const j = await r.json().catch(() => ({}));
  return { email, ok: r.ok, state: r.ok ? "created" : "create failed", status: r.status, error: r.ok ? undefined : (j.msg || j.message || j.error_description) };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const [k] = await sql`select v from fbw.settings where k='bridge_key'`;
  if (!k || req.headers.get("x-hsd-key") !== k.v) return json({ ok: false, error: "forbidden" }, 403);
  const b = await req.json().catch(() => ({}));
  const list: string[] = [].concat(b.emails || b.email || []).slice(0, 200);
  const out = [];
  for (const e of list) { try { out.push(await provision(e)); } catch (err) { out.push({ email: e, ok: false, error: String((err as Error).message || err) }); } }
  return json({ ok: out.every((x) => x.ok), results: out });
});
