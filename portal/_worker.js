// Highway Service Desk portal: Cloudflare Pages worker.
// Everything is served as static files, except /kb/, /catalogue/ and /vector/, which are only for signed-in
// users with access. Those two pages are stored under /_p/ (never served directly) and get the
// shared portal menu (nav.js + nav.css) added at the top, with their old cross-links removed.
const SB_URL = "https://sfuuzcgwbbhdjqzrchvv.supabase.co";
const SB_KEY = "sb_publishable_uu0N60ZMVjJ1kl14FW1NBA_v-cm_U3_"; // publishable key: safe, RLS protects data
const V = "47";
const GATED = {
  kb: { page: "/_p/kb/", flag: "kb", name: "Knowledge Base" },
  catalogue: { page: "/_p/catalogue/", flag: "cat", name: "Parts Catalogue" },
  vector: { page: "/_p/vector/", flag: "vector", name: "Vector Converter" },  // staff, supervisors, customers with vector_access
  flute: { page: "/_p/flute/", flag: "flute", name: "Flute Practice player" },   // staff, customers with flute_access (off by default)
  warehousing: { page: "/_p/warehousing/", flag: "intranet", name: "Warehousing" }, // purchase orders, parts & stock: hello@ only
  radio: { page: "/_p/radio/", flag: "radio", name: "Radio" },   // free internet radio: staff, and customers / vendors with radio_access (on by default)
  logreview: { page: "/_p/logreview/", flag: "logreview", name: "Log Analysis" },
  weather: { page: "/_p/weather/", flag: null, name: "Weather" }   // every signed-in login   // staff, and vendor logins ticked for it (off by default)
};
// Files the Warehousing page loads next to itself (served only to the same signed-in hello@ account).
const WH_FILES = new Set(["catalog-mimaki.json", "warranty-mimaki.json", "logo-bw.png"]);

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
  const flags = JSON.stringify({ signedIn: true, email: f.email, staff: !!f.staff, intranet: !!f.intranet, kb: !!f.kb, cat: !!f.cat, vector: !!f.vector, flute: !!f.flute, radio: !!f.radio, logreview: !!f.logreview, appsOnly: !!f.apps_only, supervisor: !!f.supervisor, reports: !!f.reports, active });
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
  // Flute Practice admins: invite / list / remove flute-only users (the database checks the caller is a flute admin).
  if (p === "/flute/api/invites") {
    const r = await rpc("flute_invites_list", {}, token);
    return jres(r.ok ? { ok: true, invites: r.j || [] } : { ok: false, error: "Not allowed." }, r.ok ? 200 : 403);
  }
  if ((p === "/flute/api/invite" || p === "/flute/api/revoke") && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const r = p === "/flute/api/invite"
      ? await rpc("flute_invite", { p_email: String(b.email || ""), p_name: String(b.name || "") }, token)
      : await rpc("flute_revoke", { p_id: Number(b.id) || 0 }, token);
    return jres(r.ok ? r.j || { ok: true } : { ok: false, error: (r.j && (r.j.message || r.j.error)) || "Couldn't save that." });
  }
  // Radio: station directory (Radio Browser, a free community list) and "now playing" for one stream.
  // Mimaki Log Review (read-only portal copy): reviews only for machines this login can see.
  if (p.startsWith("/logreview/api/")) {
    const f = await menuFlags(token).catch(() => null);
    if (!f || !f.logreview) return jres({ ok: false, error: "Log Review isn't turned on for your account." }, 403);
    return logReviewData(env, url, p, token, f);
  }
  if (p.startsWith("/radio/api/")) {
    const f = await menuFlags(token).catch(() => null);
    if (!f || !f.radio) return jres({ ok: false, error: "Radio isn't turned on for your account." }, 403);
    if (p === "/radio/api/stations") return radioStations(url);
    if (p === "/radio/api/now") return radioNow(url);
  }
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
// ---------- Mimaki Log Review ----------
const normSerial = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
async function logReviewData(env, url, p, token, f) {
  const asset = (name) => env.ASSETS.fetch(new Request(new URL("/_p/logreview/" + name, url.origin))).then((r) => r.json());
  const priv = { "content-type": "application/json", "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
  if (p === "/logreview/api/profiles") {
    const j = await asset("profiles.json");
    if (!f.staff) for (const list of Object.values(j.models || {})) for (const x of list) { delete x.customer; delete x.folder; }
    return new Response(JSON.stringify(j), { headers: priv });
  }
  if (p === "/logreview/api/reviews") {
    const j = await asset("reviews.json");
    if (!f.staff) {
      const r = await fetch(SB_URL + "/rest/v1/machines?select=serial&serial=not.is.null", { headers: { apikey: SB_KEY, Authorization: "Bearer " + token } });
      const mine = new Set((r.ok ? await r.json() : []).map((m) => normSerial(m.serial)).filter((x) => x.length >= 5));
      j.reviews = (j.reviews || []).filter((x) => mine.has(normSerial(x.serial)));
      for (const x of j.reviews) { delete x.pdf; if (x.meta) { delete x.meta.source_folder; delete x.meta.sender; } }
    }
    return new Response(JSON.stringify(j), { headers: priv });
  }
  return jres({ ok: false }, 404);
}
// ---------- Radio ----------
const RB_HOSTS = ["de1.api.radio-browser.info", "nl1.api.radio-browser.info", "at1.api.radio-browser.info", "de2.api.radio-browser.info", "fi1.api.radio-browser.info"];
const RB_ALLOWED = new Set(["stations/search", "stations/topclick", "stations/topvote", "stations/byuuid", "countries", "tags"]);
async function radioStations(url) {
  const path = url.searchParams.get("path") || "stations/search";
  if (!RB_ALLOWED.has(path)) return jres({ ok: false, error: "Not allowed" }, 400);
  const q = new URLSearchParams(url.searchParams); q.delete("path");
  if (path.startsWith("stations")) { if (!q.has("hidebroken")) q.set("hidebroken", "true"); if (!q.has("limit")) q.set("limit", "60"); }
  for (const host of RB_HOSTS) {
    try {
      const r = await fetch(`https://${host}/json/${path}${path === "stations/topclick" || path === "stations/topvote" ? "/" + (q.get("limit") || "60") : ""}?${q}`,
        { headers: { "User-Agent": "HighwayServiceDesk/1.0 (portal.highwaydigital.com.au)" }, cf: { cacheTtl: 600, cacheEverything: true } });
      if (!r.ok) continue;
      return new Response(await r.text(), { headers: { "content-type": "application/json", "Cache-Control": "private, max-age=300" } });
    } catch (e) { /* next mirror */ }
  }
  return jres({ ok: false, error: "The station directory didn't answer. Try again shortly." }, 502);
}
// Reads the stream's ICY "StreamTitle" (artist - song) from the first metadata block, then looks up the album cover on iTunes.
async function radioNow(url) {
  const u = url.searchParams.get("u") || "";
  let su; try { su = new URL(u); } catch (e) { return jres({ ok: false }, 400); }
  if (!/^https?:$/.test(su.protocol)) return jres({ ok: false }, 400);
  let title = "";
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 7000);
  try {
    const r = await fetch(su.toString(), { headers: { "Icy-MetaData": "1", "User-Agent": "HighwayServiceDesk/1.0" }, signal: ctl.signal });
    const mi = parseInt(r.headers.get("icy-metaint") || "0", 10);
    if (r.ok && r.body && mi > 0 && mi < 200000) {
      const rd = r.body.getReader(); let got = 0, need = mi + 1 + 4080, buf = new Uint8Array(need), len = -1;
      while (got < need) {
        const { value, done } = await rd.read(); if (done) break;
        const n = Math.min(value.length, need - got); buf.set(value.subarray(0, n), got); got += n;
        if (len < 0 && got > mi) { len = buf[mi] * 16; need = mi + 1 + len; if (!len) break; }
      }
      rd.cancel().catch(() => {});
      if (len > 0 && got >= mi + 1 + len) {
        const meta = new TextDecoder("utf-8").decode(buf.subarray(mi + 1, mi + 1 + len)).replace(/\0+$/, "");
        const m = meta.match(/StreamTitle='([\s\S]*?)';/); title = m ? m[1].trim() : "";
      }
    } else if (r.body) r.body.cancel().catch(() => {});
  } catch (e) { /* no metadata */ } finally { clearTimeout(timer); }
  let artist = "", song = title;
  const sp = title.split(/\s+[-–—]\s+/);
  if (sp.length >= 2) { artist = sp[0].trim(); song = sp.slice(1).join(" - ").trim(); }
  let art = "", album = "", year = "";
  if (title && !/^(unknown|advert|commercial|station id)/i.test(title)) {
    try {
      const term = (artist ? artist + " " : "") + song.replace(/\(.*?\)|\[.*?\]/g, "");
      const r = await fetch("https://itunes.apple.com/search?" + new URLSearchParams({ term: term.slice(0, 120), media: "music", entity: "song", limit: "1", country: "AU" }),
        { cf: { cacheTtl: 86400, cacheEverything: true } });
      const j = await r.json().catch(() => ({}));
      const x = j.results && j.results[0];
      if (x) { art = String(x.artworkUrl100 || "").replace(/100x100bb/, "600x600bb"); album = x.collectionName || ""; year = String(x.releaseDate || "").slice(0, 4);
        if (!artist) artist = x.artistName || ""; }
    } catch (e) { /* no cover */ }
  }
  return jres({ ok: true, title, artist, song, art, album, year });
}
function quoteBlock(f) {
  const q = JSON.stringify({ customer: !!f.customer, email: f.email || "" });
  return `<script>window.HDQ=${q.replace(/</g, "\\u003c")};</script><link rel="stylesheet" href="/quote.css?v=${V}"><script src="/quote.js?v=${V}" defer></script>`;
}

/* Weather page: what Hubble is observing. STScI publishes each week's planned observations as a plain-text
   "HST Observing Timeline Report" (stsci.edu/ftp/observing/weekly_timeline/timeline_MM_DD_YY). This reads the
   current and next week, keeps real targets (not darks, biases and other calibrations) and groups the exposures
   into visits: one row per target block, with begin/end time (UTC), instrument and investigator. Cached 30 min. */
const HST_TL = "https://www.stsci.edu/ftp/observing/weekly_timeline/";
const HST_CAL = /^(DARK|BIAS|DARK-NM|DARK-EARTH-CALIB|WAVEHITM|WAVELINE|WAVE|TUNGSTEN|INTFLAT|KSPOTS|DEUTERIUM|EARTH-CALIB|ANY|NONE|FLAT|LAMP|CCDFLAT|ORBIT-POLE|BIAS-\S*|DARK-\S*)$/i;
function hstParse(txt) {
  // Fixed-width report: the dashed line under the headings gives each column's start.
  const L = String(txt).split("\n");
  const dl = L.find((l) => /^-{8} -{8} -{8}\s+-+\s+-+/.test(l)); if (!dl) return [];
  const st = [...dl.matchAll(/-+/g)].map((m) => m.index);
  const col = (l, i, j = i + 1) => l.slice(st[i], j < st.length ? st[j] : undefined).trim();
  const out = [];
  for (const l of L) {
    if (!/^\d{4}\.\d{3} \d\d:\d\d:\d\d \d\d:\d\d:\d\d/.test(l)) continue;
    const su = col(l, 3), pi = col(l, 4), inst = col(l, 7);
    const target = col(l, 5, 7).split(/\s+/).slice(1).join(" ");   // "Exp #" then the target name
    if (!target || HST_CAL.test(target) || /^S\/C/.test(inst)) continue;
    const t = (s) => { const [a, b, c] = s.split(":").map(Number); return ((a * 60 + b) * 60 + c) * 1e3; };
    const base = Date.UTC(+l.slice(0, 4), 0, 1) + (+l.slice(5, 8) - 1) * 864e5;
    const b = base + t(l.slice(9, 17)); let e = base + t(l.slice(18, 26)); if (e < b) e += 864e5;
    out.push({ su, pi, target, inst: inst.split("/")[0], b, e });
  }
  // group exposures of one visit (same SU and target, gaps under 2 h)
  out.sort((a, c) => a.b - c.b);
  const visits = [];
  for (const x of out) {
    const v = [...visits].reverse().find((w) => w.su === x.su && w.target === x.target && x.b - w.e < 2 * 3600e3);
    if (v) { v.e = Math.max(v.e, x.e); if (!v.inst.includes(x.inst)) v.inst.push(x.inst); }
    else visits.push({ su: x.su, pi: x.pi, target: x.target, inst: [x.inst], b: x.b, e: x.e });
  }
  return visits;
}
async function hubbleFeed() {
  const cache = caches.default, ck = new Request("https://portal.highwaydigital.com.au/_cache/hubble-v1");
  const hit = await cache.match(ck); if (hit) return hit;
  let files = [];
  try {
    const idx = await (await fetch(HST_TL, { headers: { "user-agent": "HighwayServiceDesk/1.0 (weather page)" } })).text();
    files = [...new Set([...idx.matchAll(/href="(timeline_(\d\d)_(\d\d)_(\d\d))"/g)].map((m) => ({ f: m[1], t: Date.UTC(2000 + +m[4], +m[2] - 1, +m[3]) })).map((x) => JSON.stringify(x)))].map((s) => JSON.parse(s));
  } catch (e) { return jres({ ok: false, error: "Couldn't reach STScI" }, 502); }
  const now = Date.now();
  const pick = files.filter((x) => x.t <= now + 864e5).sort((a, b) => b.t - a.t).slice(0, 2);
  const next = files.filter((x) => x.t > now + 864e5).sort((a, b) => a.t - b.t).slice(0, 1);
  let visits = [];
  for (const x of [...pick, ...next]) {
    try { const t = await (await fetch(HST_TL + x.f, { headers: { "user-agent": "HighwayServiceDesk/1.0 (weather page)" } })).text(); visits.push(...hstParse(t)); } catch (e) { /* skip a week */ }
  }
  const seen = new Set();
  visits = visits.filter((v) => { const k = v.su + v.target + v.b; if (seen.has(k)) return false; seen.add(k); return v.e > now - 6 * 3600e3 && v.b < now + 4 * 864e5; }).sort((a, b) => a.b - b.b);
  const r = jres({ ok: true, source: "STScI HST Observing Timeline Report", at: new Date(now).toISOString(),
    visits: visits.slice(0, 120).map((v) => ({ target: v.target, inst: v.inst.join(" + "), pi: v.pi, prop: String(v.su).slice(0, 5), begin: new Date(v.b).toISOString(), end: new Date(v.e).toISOString() })) });
  const h = new Headers(r.headers); h.set("Cache-Control", "public, max-age=1800");
  const out = new Response(r.body, { status: 200, headers: h });
  await cache.put(ck, out.clone());
  return out;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/weather/api/hubble") return hubbleFeed();
    if (p === "/_src/catalogue" || p === "/vector/log" || p.startsWith("/flute/api/") || p.startsWith("/radio/api/") || p.startsWith("/logreview/api/") || p.startsWith("/catalogue/quote") || p.startsWith("/service/")) {
      const r = await apiRoute(req, env, url, p);
      if (r) return r;
    }
    if (p.startsWith("/_p/")) return new Response("Not found", { status: 404 });
    if (/^\/po(\/|$)/.test(p)) return Response.redirect(url.origin + "/warehousing/", 302);
    const key = /^\/kb(\/|$)/.test(p) ? "kb" : /^\/catalogue(\/|$)/.test(p) ? "catalogue" : /^\/vector(\/|$)/.test(p) ? "vector" : /^\/flute(\/|$)/.test(p) ? "flute" : /^\/warehousing(\/|$)/.test(p) ? "warehousing" : /^\/radio(\/|$)/.test(p) ? "radio" : /^\/logreview(\/|$)/.test(p) ? "logreview" : /^\/weather(\/|$)/.test(p) ? "weather" : null;
    if (!key) return env.ASSETS.fetch(req);
    const whFile = key === "warehousing" ? p.slice("/warehousing/".length) : "";
    if (whFile && WH_FILES.has(whFile)) {
      const tk = readCookie(req, "hd_at");
      const ff = tk ? await menuFlags(tk).catch(() => null) : null;
      if (!ff || !ff.intranet) return new Response("Not found", { status: 404 });
      const a = await env.ASSETS.fetch(new Request(new URL("/_p/warehousing/" + whFile, url.origin)));
      const h = new Headers(a.headers); h.set("Cache-Control", "private, max-age=300"); h.set("X-Robots-Tag", "noindex");
      return new Response(a.body, { status: a.status, headers: h });
    }
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
      .on("body", { element(e) { e.prepend(navBlock(f, key) + (key === "kb" && Array.isArray(f.kb_only) && f.kb_only.length
          ? `<script>window.KB_ONLY=${JSON.stringify(f.kb_only.map((b) => String(b).replace(/[^a-z]/g, "")))};</script>` : ""), { html: true }); if (key === "catalogue" && page.ok) e.append(quoteBlock(f), { html: true }); } })
      // the pages' own links back to the portal / to each other: the shared menu replaces them
      .on("header.band .meta > div:nth-child(2)", { element(e) { e.remove(); } })
      .on("header.band a.kblink", { element(e) { e.remove(); } })
      .on("header.band .plate small a", { element(e) { e.remove(); } })   // "← Highway Service Desk ·" on the catalogue
      .on("header.band .plate small", { text(t) { if (/^\s*·\s*/.test(t.text)) t.replace(t.text.replace(/^\s*·\s*/, "")); } })
      .transform(page);
    const h = new Headers(out.headers);
    h.set("Cache-Control", "private, no-store");
    h.set("X-Robots-Tag", "noindex");
    if (key === "flute") h.set("Permissions-Policy", "microphone=(self)");
    if (key === "radio") h.set("Permissions-Policy", "autoplay=(self)");
    if (key === "weather") h.set("Permissions-Policy", "geolocation=(self)");   // "Near me"   // the player listens to the customer playing
    h.delete("Content-Length");
    return new Response(out.body, { status: page.status, headers: h });
  }
};
