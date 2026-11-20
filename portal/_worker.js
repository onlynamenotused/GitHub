// Highway Service Desk portal: Cloudflare Pages worker.
// Everything is served as static files, except /kb/, /catalogue/ and /vector/, which are only for signed-in
// users with access. Those two pages are stored under /_p/ (never served directly) and get the
// shared portal menu (nav.js + nav.css) added at the top, with their old cross-links removed.
const SB_URL = "https://sfuuzcgwbbhdjqzrchvv.supabase.co";
const SB_KEY = "sb_publishable_uu0N60ZMVjJ1kl14FW1NBA_v-cm_U3_"; // publishable key: safe, RLS protects data
const V = "32";
const GATED = {
  kb: { page: "/_p/kb/", flag: "kb", name: "Knowledge Base" },
  catalogue: { page: "/_p/catalogue/", flag: "cat", name: "Parts Catalogue" },
  vector: { page: "/_p/vector/", flag: "vector", name: "Vector Converter" }   // staff, supervisors, customers with vector_access
};

function readCookie(req, name) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : "";
}
async function menuFlags(token) {
  const r = await fetch(SB_URL + "/rest/v1/rpc/portal_menu", {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: "{}"
  });
  if (!r.ok) return null;
  return r.json();
}
// Parts Catalogue brand groups. The catalogue's DATA list uses finer brand names; map them to the groups staff tick.
const CAT_ALL = ["Mimaki", "Mutoh", "Brother", "Epilog", "Others"];
const catGroup = (b) => ({ Mimaki: "Mimaki", Mutoh: "Mutoh", Brother: "Brother", Epilog: "Epilog", "Laser accessories": "Epilog" })[b] || "Others";
function catKeep(brand, allow) {
  if (brand === "Cleaning swabs") return allow.has("Mimaki") || allow.has("Mutoh") || allow.has("Others");
  return allow.has(catGroup(brand));
}
// Removes catalogue sections for brand groups this viewer isn't allowed, before the page leaves the server.
function filterCatalogue(html, allow) {
  const start = html.indexOf("const DATA=[");
  if (start < 0) return null;
  const bodyStart = start + "const DATA=[".length, end = html.indexOf("\n];", bodyStart);
  if (end < 0) return null;
  const parts = html.slice(bodyStart, end).split("\n{brand:\"");
  const kept = [parts[0]];
  for (const p of parts.slice(1)) { const b = p.slice(0, p.indexOf("\"")); if (catKeep(b, allow)) kept.push(p); }
  return html.slice(0, bodyStart) + kept.join("\n{brand:\"") + html.slice(end);
}
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/</g, "&lt;");
function navBlock(f, active) {
  const flags = JSON.stringify({ signedIn: true, email: f.email, staff: !!f.staff, intranet: !!f.intranet, kb: !!f.kb, cat: !!f.cat, vector: !!f.vector, supervisor: !!f.supervisor, active });
  return `<div id="hd-nav" class="hdn-static" data-flags='${attr(flags)}'></div><script src="/nav.js?v=${V}"></script>`;
}
function notAvailable(name) {
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} · Highway Service Desk</title><meta name="robots" content="noindex">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=League+Spartan:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/styles.css?v=${V}"></head><body><main class="wrap"><section class="card login">
<h1>Not available on your account</h1><p>The ${name} isn't turned on for your account. Contact
<a href="mailto:hello@highwaydigital.com.au">hello@highwaydigital.com.au</a> if you'd like access.</p></section></main></body></html>`;
}

const FN_URL = SB_URL + "/functions/v1/freshbooks";
const jres = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "Cache-Control": "no-store" } });
async function rpc(name, body, token) {
  const r = await fetch(SB_URL + "/rest/v1/rpc/" + name, {
    method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + (token || SB_KEY), "Content-Type": "application/json" }, body: JSON.stringify(body || {})
  });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { ok: r.ok, status: r.status, j };
}
// "Version 1.22 Beta · 21 Nov 2026" on a page is kept current: the database bumps the minor version (and the date)
// the first time it sees a changed page file, and the label in the page is replaced with that.
const VER_RE = /Version \d+\.\d+ Beta · \d{1,2} [A-Za-z]{3} \d{4}/g;
async function withVersion(page, key, token) {
  const text = await page.text();
  if (!VER_RE.test(text)) return new Response(text, page);
  VER_RE.lastIndex = 0;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const hash = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const r = await rpc("page_version", { p_path: key, p_hash: hash }, token).catch(() => null);
  const v = r && r.ok && r.j && r.j.v ? r.j : null;
  const hd = new Headers(page.headers); hd.delete("Content-Length"); hd.delete("ETag");
  return new Response(v ? text.replace(VER_RE, `Version ${v.v} Beta · ${v.date}`) : text, { status: page.status, headers: hd });
}
// Small JSON endpoints used by the gated pages (same-origin, signed-in cookie).
async function apiRoute(req, env, url, p) {
  // The edge function reads the raw catalogue (for quote prices) with the bridge key, checked by the database.
  if (p === "/_src/catalogue") {
    const k = req.headers.get("x-hsd-key") || "";
    const ok = k.length >= 20 && (await rpc("bridge_key_ok", { p_key: k })).j === true;
    if (!ok) return new Response("Not found", { status: 404 });
    const a = await env.ASSETS.fetch(new Request(new URL("/_p/catalogue/", url.origin)));
    return new Response(await a.text(), { status: a.status, headers: { "content-type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  const token = readCookie(req, "hd_at");
  if (!token) return jres({ ok: false, error: "Please sign in again." }, 401);
  if (p === "/vector/log" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    await rpc("log_vector_export", { p_kind: String(b.kind || "file").slice(0, 40) }, token);
    return jres({ ok: true });
  }
  if (p === "/catalogue/quote-machines") {
    const r = await fetch(SB_URL + "/rest/v1/machines?select=id,brand,model,serial,site,location&status=eq.active&order=brand,model",
      { headers: { apikey: SB_KEY, Authorization: "Bearer " + token } });
    return jres(r.ok ? { ok: true, machines: await r.json() } : { ok: false, machines: [] });
  }
  if (p === "/catalogue/quote" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b) return jres({ ok: false, error: "Bad request" }, 400);
    const s = await rpc("portal_quote_start", { p: b }, token);
    if (!s.ok || !s.j || !s.j.quote_id) return jres({ ok: false, error: (s.j && (s.j.message || s.j.error)) || "Couldn't start the quote." });
    const r = await fetch(FN_URL + "/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quote_id: s.j.quote_id, token: s.j.token }) });
    const j = await r.json().catch(() => ({ ok: false, error: "The quote service didn't answer." }));
    return jres(j);
  }
  // "Quote me" service quotes from My machines: same two steps as parts quotes.
  if (p === "/service/quote" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b) return jres({ ok: false, error: "Bad request" }, 400);
    const s = await rpc("portal_service_quote_start", { p: b }, token);
    if (!s.ok || !s.j || !s.j.quote_id) return jres({ ok: false, error: (s.j && (s.j.message || s.j.error)) || "Couldn't start the quote." });
    const r = await fetch(FN_URL + "/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quote_id: s.j.quote_id, token: s.j.token }) });
    return jres(await r.json().catch(() => ({ ok: false, error: "The quote service didn't answer." })));
  }
  // Parts a customer may add to a service quote: the catalogue rows for the brands they're allowed, with ex-GST prices.
  if (p === "/service/parts") {
    const f = await menuFlags(token).catch(() => null);
    if (!f || !f.cat) return jres({ ok: true, parts: [] });
    const allow = new Set(Array.isArray(f.cat_brands) && f.cat_brands.length && !f.staff ? f.cat_brands : CAT_ALL);
    const html = await (await env.ASSETS.fetch(new Request(new URL("/_p/catalogue/", url.origin)))).text();
    const a = html.indexOf("const DATA=["), z = html.indexOf("\n];", a), out = [], seen = new Set();
    let brand = "", fam = "";
    if (a >= 0 && z > a) for (const line of html.slice(a, z).split("\n")) {
      const b = line.match(/^\{brand:"([^"]*)"(?:,family:"((?:[^"\\]|\\.)*)")?/);
      if (b) { brand = b[1]; try { fam = b[2] ? JSON.parse('"' + b[2] + '"') : ""; } catch (e) { fam = ""; } }
      const m = line.match(/^\s*\["((?:[^"\\]|\\.)*)","((?:[^"\\]|\\.)*)","((?:[^"\\]|\\.)*)",\s*(null|-?[\d.]+)/);
      if (!m || !brand || m[4] === "null" || m[3] === "head" || !catKeep(brand, allow)) continue;
      let pn, name; try { pn = JSON.parse('"' + m[1] + '"'); name = JSON.parse('"' + m[2] + '"'); } catch (e) { continue; }
      const key = pn && pn !== "—" ? pn : name;
      if (seen.has(brand + "|" + key)) continue; seen.add(brand + "|" + key);
      out.push({ brand, key, pn, name, fam, ex: +m[4] });
    }
    return new Response(JSON.stringify({ ok: true, parts: out }), { headers: { "content-type": "application/json", "Cache-Control": "private, max-age=300" } });
  }
  return null;
}
function quoteBlock(f) {
  const q = JSON.stringify({ customer: !!f.customer, email: f.email || "" });
  return `<script>window.HDQ=${q.replace(/</g, "\\u003c")};</script><link rel="stylesheet" href="/quote.css?v=${V}"><script src="/quote.js?v=${V}" defer></script>`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/_src/catalogue" || p === "/vector/log" || p.startsWith("/catalogue/quote") || p.startsWith("/service/")) {
      const r = await apiRoute(req, env, url, p);
      if (r) return r;
    }
    if (p.startsWith("/_p/")) return new Response("Not found", { status: 404 });
    const key = /^\/kb(\/|$)/.test(p) ? "kb" : /^\/catalogue(\/|$)/.test(p) ? "catalogue" : /^\/vector(\/|$)/.test(p) ? "vector" : null;
    if (!key) return env.ASSETS.fetch(req);
    if (p !== "/" + key + "/") return Response.redirect(url.origin + "/" + key + "/", 302);

    const token = readCookie(req, "hd_at");
    const f = token ? await menuFlags(token).catch(() => null) : null;
    if (!f || !f.email) return Response.redirect(url.origin + "/?next=" + encodeURIComponent("/" + key + "/"), 302);

    const g = GATED[key];
    let page = (!g.flag || f[g.flag])
      ? await env.ASSETS.fetch(new Request(new URL(g.page, url.origin), { headers: req.headers }))
      : new Response(notAvailable(g.name), { headers: { "content-type": "text/html; charset=utf-8" } });
    if ((!g.flag || f[g.flag]) && page.ok) page = await withVersion(page, key, token);
    if (key === "catalogue" && f.cat && !f.staff && page.ok) {
      const allow = new Set(Array.isArray(f.cat_brands) && f.cat_brands.length ? f.cat_brands : CAT_ALL);
      if (CAT_ALL.some((b) => !allow.has(b))) {
        const t = filterCatalogue(await page.text(), allow);
        const hd = new Headers(page.headers); hd.delete("Content-Length"); hd.delete("ETag");
        page = t ? new Response(t, { status: 200, headers: hd }) : new Response(notAvailable(g.name), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
    }

    const out = new HTMLRewriter()
      .on("head", { element(e) { e.append(`<link rel="stylesheet" href="/nav.css?v=${V}">`, { html: true }); } })
      .on("body", { element(e) { e.prepend(navBlock(f, key), { html: true }); if (key === "catalogue" && page.ok) e.append(quoteBlock(f), { html: true }); } })
      // the pages' own links back to the portal / to each other: the shared menu replaces them
      .on("header.band .meta > div:nth-child(2)", { element(e) { e.remove(); } })
      .on("header.band a.kblink", { element(e) { e.remove(); } })
      .on("header.band .plate small a", { element(e) { e.remove(); } })   // "← Highway Service Desk ·" on the catalogue
      .on("header.band .plate small", { text(t) { if (/^\s*·\s*/.test(t.text)) t.replace(t.text.replace(/^\s*·\s*/, "")); } })
      .transform(page);
    const h = new Headers(out.headers);
    h.set("Cache-Control", "private, no-store");
    h.set("X-Robots-Tag", "noindex");
    h.delete("Content-Length");
    return new Response(out.body, { status: page.status, headers: h });
  }
};
