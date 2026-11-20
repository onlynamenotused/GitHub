// Highway Service Desk portal: Cloudflare Pages worker.
// Everything is served as static files, except /kb/, /catalogue/ and /vector/, which are only for signed-in
// users with access. Those two pages are stored under /_p/ (never served directly) and get the
// shared portal menu (nav.js + nav.css) added at the top, with their old cross-links removed.
const SB_URL = "https://sfuuzcgwbbhdjqzrchvv.supabase.co";
const SB_KEY = "sb_publishable_uu0N60ZMVjJ1kl14FW1NBA_v-cm_U3_"; // publishable key: safe, RLS protects data
const V = "28";
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
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
      .on("body", { element(e) { e.prepend(navBlock(f, key), { html: true }); } })
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
