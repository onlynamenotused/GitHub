// Highway Service Desk portal: Cloudflare Pages worker.
// Everything is served as static files, except /kb/ and /catalogue/, which are only for signed-in
// users with access. Those two pages are stored under /_p/ (never served directly) and get the
// shared portal menu (nav.js + nav.css) added at the top, with their old cross-links removed.
const SB_URL = "https://sfuuzcgwbbhdjqzrchvv.supabase.co";
const SB_KEY = "sb_publishable_uu0N60ZMVjJ1kl14FW1NBA_v-cm_U3_"; // publishable key: safe, RLS protects data
const V = "21";
const GATED = {
  kb: { page: "/_p/kb/", flag: "kb", name: "Knowledge Base" },
  catalogue: { page: "/_p/catalogue/", flag: "cat", name: "Parts Catalogue" }
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
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/</g, "&lt;");
function navBlock(f, active) {
  const flags = JSON.stringify({ signedIn: true, email: f.email, staff: !!f.staff, intranet: !!f.intranet, kb: !!f.kb, cat: !!f.cat, active });
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
    const key = /^\/kb(\/|$)/.test(p) ? "kb" : /^\/catalogue(\/|$)/.test(p) ? "catalogue" : null;
    if (!key) return env.ASSETS.fetch(req);
    if (p !== "/" + key + "/") return Response.redirect(url.origin + "/" + key + "/", 302);

    const token = readCookie(req, "hd_at");
    const f = token ? await menuFlags(token).catch(() => null) : null;
    if (!f || !f.email) return Response.redirect(url.origin + "/?next=" + encodeURIComponent("/" + key + "/"), 302);

    const g = GATED[key];
    const page = f[g.flag]
      ? await env.ASSETS.fetch(new Request(new URL(g.page, url.origin), { headers: req.headers }))
      : new Response(notAvailable(g.name), { headers: { "content-type": "text/html; charset=utf-8" } });

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
