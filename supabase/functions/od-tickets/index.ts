// Highway Service Desk: ticket folders in OneDrive.
// Every ticket gets a folder inside the customer's folder under "Client Folders" (found by name, or created):
//   Client Folders/<customer>/<ticket number>-<model>-<serial>-<summary>
// A copy of the ticket (HTML) is saved there, and ticket photos/videos upload into the same folder.
// Ops (reached only through fbw.call(), which holds the bridge key; media_chunk stays in the "freshbooks" bridge):
//   ticket_folder {ref, customer, label, folderId?}  -> {folderId, folderUrl, name, customerFolder}
//   ticket_copy   {folderId, name, html}             -> {itemId, webUrl}
//   media_start   {ticket, name, size, folderId?}    -> {upload, folderId, folderUrl}
//   media_folder_link {ticket, folderId?}            -> view-only share link of the folder
//   media_delete  {itemId}                           -> recycle bin (only items in Client Folders or the old media folder)
//   estimate_file {estimateId, number, folderId? | ref+customer+label} -> PDF of the FreshBooks estimate saved in the
//                 ticket folder as "Estimate <number>.pdf", plus a view-only share link to it (for Mimaki PO requests)
// Deployed with verify_jwt=false (the x-hsd-key check below is the auth).
import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
const env = (k: string) => Deno.env.get(k) ?? "";
const MS_ID = env("MS_CLIENT_ID"), MS_SECRET = env("MS_CLIENT_SECRET"), MS_TENANT = env("MS_TENANT_ID") || "organizations";
const MS_REDIRECT = "https://sfuuzcgwbbhdjqzrchvv.supabase.co/functions/v1/freshbooks/ms-callback";
const MS_SCOPE = "offline_access User.Read Files.ReadWrite";
const GRAPH = "https://graph.microsoft.com/v1.0";
const CLIENT_ROOT = "Client Folders";
const OLD_MEDIA_ROOT = "Highway Service Desk/Ticket media";
const FB_ID = env("FRESHBOOKS_CLIENT_ID"), FB_SECRET = env("FRESHBOOKS_CLIENT_SECRET");
const FB_REDIRECT = "https://sfuuzcgwbbhdjqzrchvv.supabase.co/functions/v1/freshbooks/callback";
const FB_API = "https://api.freshbooks.com";
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

async function msToken(rt: string) {
  const r = await fetch(`https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: MS_ID, client_secret: MS_SECRET, redirect_uri: MS_REDIRECT, scope: MS_SCOPE, grant_type: "refresh_token", refresh_token: rt }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("Microsoft token error: " + (j.error_description || j.error || r.status));
  return j;
}
async function token() {
  return await sql.begin(async (tx) => {
    const [c] = await tx`select * from fbw.conn where provider='microsoft' for update`;
    if (!c || !c.refresh_token) throw new Error("not_connected:microsoft");
    if (c.access_token && c.expires_at && new Date(c.expires_at).getTime() - Date.now() > 120000) return c;
    const t = await msToken(c.refresh_token);
    const [n] = await tx`update fbw.conn set access_token=${t.access_token}, refresh_token=${t.refresh_token || c.refresh_token},
      expires_at=${new Date(Date.now() + (t.expires_in || 3600) * 1000)}, last_error=null where provider='microsoft' returning *`;
    return n;
  });
}
async function graph(path: string, init: RequestInit = {}, raw = false) {
  const c = await token();
  const r = await fetch(path.startsWith("http") ? path : GRAPH + path, {
    ...init, headers: { ...(raw ? {} : { "content-type": "application/json" }), authorization: "Bearer " + c.access_token, ...(init.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`OneDrive ${r.status}: ${j?.error?.message || r.statusText}`), { status: r.status });
  return j;
}
const cleanName = (s: string, n = 120) => String(s || "").replace(/[\\/:*?"<>|#%~&{}]+/g, "-").replace(/[\u0000-\u001f]/g, "").replace(/\s+/g, " ").replace(/^[\s.-]+|[\s.]+$/g, "").slice(0, n).trim();
const pathEnc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const norm = (s: string) => String(s || "").toLowerCase().replace(/\b(pty|ltd|limited|the|t\/as|t\/a|co|inc|group|of|companies|company|and)\b/g, " ").replace(/[^a-z0-9]+/g, "");
const words = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["pty", "ltd", "the", "and", "group", "limited", "company", "companies"].includes(w));
// Words that many customers share: they never make two names "the same customer" on their own
// (e.g. "Piara Waters Senior High School" is not "Newman Senior High School").
const GENERIC = new Set(["school","senior","high","primary","college","college","university","academy","signs","sign","signage","print","printing","prints","graphics","graphic","design","designs","media","services","service","solutions","australia","australian","perth","wa","west","western","north","south","east","city","shire","council","department","dept","trust","centre","center","club","church","hospital","health","group","industries","enterprises","holdings","trading","studio","studios","shop","store","workshop","office","the","and"]);
const keyWords = (s: string) => words(s).filter((w) => !GENERIC.has(w));

async function children(id: string) {
  const out: any[] = [];
  let url: string | null = `/me/drive/items/${id}/children?$select=id,name,webUrl,folder&$top=999`;
  while (url) { const j = await graph(url); out.push(...(j.value || [])); url = j["@odata.nextLink"] || null; }
  return out.filter((x) => x.folder);
}
async function rootFolder() {
  try { return await graph(`/me/drive/root:/${pathEnc(CLIENT_ROOT)}`); }
  catch (e) {
    if ((e as any).status !== 404) throw e;
    return await graph(`/me/drive/root/children`, { method: "POST", body: JSON.stringify({ name: CLIENT_ROOT, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }) });
  }
}
async function mkdir(parentId: string, name: string) {
  try { return await graph(`/me/drive/items/${parentId}/children`, { method: "POST", body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }) }); }
  catch (e) { if ((e as any).status !== 409) throw e; return await graph(`/me/drive/items/${parentId}:/${encodeURIComponent(name)}`); }
}

/* The customer's folder: remembered match, else best name match among Client Folders, else a new folder. */
async function customerFolder(customer: string) {
  const key = norm(customer);
  if (!key) throw new Error("No customer on the ticket");
  const [m] = await sql`select folder_id from fbw.client_folders where key=${key}`;
  if (m) { try { return await graph(`/me/drive/items/${m.folder_id}?$select=id,name,webUrl,folder`); } catch (_) { /* moved or deleted: look again */ } }
  const root = await rootFolder();
  const list = await children(root.id);
  // "Trading name" after T/As counts too, e.g. "RJ Parkhouse T/As AS Design & Print" -> "AS Design & Print".
  const names = [customer, ...String(customer).split(/\bt\/?as?\b/i).slice(1)].map((s) => s.trim()).filter(Boolean);
  let hit = list.find((f) => names.some((n) => norm(f.name) === norm(n)));
  if (!hit) hit = list.find((f) => names.some((n) => { const a = norm(f.name), b = norm(n); return a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a)); }));
  if (!hit) {
    // Only distinctive words count, and every distinctive word of the folder name must be in the customer's name.
    const cw = new Set(names.flatMap(keyWords));
    const scored = list.map((f) => { const fw = keyWords(f.name); const k = fw.filter((w) => cw.has(w)).length; return { f, s: fw.length ? k / fw.length : 0, k }; })
      .filter((x) => x.k >= 1 && x.s === 1 && (x.k >= 2 || keyWords(customer).length === 1)).sort((a, b) => b.k - a.k);
    if (scored.length && (scored.length === 1 || scored[0].s > scored[1].s)) hit = scored[0].f;
  }
  if (!hit) hit = await mkdir(root.id, cleanName(customer, 100) || "Unknown customer");
  await sql`insert into fbw.client_folders(key, folder_id, name) values (${key}, ${hit.id}, ${hit.name}) on conflict (key) do update set folder_id=excluded.folder_id, name=excluded.name, updated_at=now()`;
  return hit;
}

async function ticketFolder(d: any) {
  if (d.folderId) { try { const f = await graph(`/me/drive/items/${String(d.folderId)}?$select=id,name,webUrl,folder,parentReference`); if (f.folder) return { ok: true, folderId: f.id, folderUrl: f.webUrl, name: f.name, existing: true }; } catch (_) { /* fall through */ } }
  const ref = cleanName(d.ref, 20); if (!ref) throw new Error("No ticket number");
  const cf = await customerFolder(String(d.customer || ""));
  const num = ref.replace(/\D+/g, "");
  const kids = await children(cf.id);
  let f = kids.find((k) => num && (k.name.startsWith(ref) || k.name.startsWith(num + "-") || k.name.startsWith(num + " ") || k.name === num));
  if (!f) f = await mkdir(cf.id, cleanName([num || ref, d.label].filter(Boolean).join("-"), 120));
  return { ok: true, folderId: f.id, folderUrl: f.webUrl, name: f.name, customerFolder: cf.name, customerFolderUrl: cf.webUrl };
}
async function ticketCopy(d: any) {
  const id = String(d.folderId || ""); if (!id) throw new Error("No ticket folder");
  const name = cleanName(d.name || "Ticket.html", 120) || "Ticket.html";
  const html = String(d.html || ""); if (!html || html.length > 3_000_000) throw new Error("Ticket copy is empty or too large");
  const c = await token();
  const r = await fetch(`${GRAPH}/me/drive/items/${id}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=replace`, {
    method: "PUT", headers: { authorization: "Bearer " + c.access_token, "content-type": "text/html; charset=utf-8" }, body: new TextEncoder().encode(html),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OneDrive ${r.status}: ${j?.error?.message || r.statusText}`);
  return { ok: true, itemId: j.id, webUrl: j.webUrl, name: j.name };
}
async function folderFor(d: any) {
  if (d.folderId) { try { const f = await graph(`/me/drive/items/${String(d.folderId)}?$select=id,webUrl,folder`); if (f.folder) return f; } catch (_) { /* fall back */ } }
  if (d.customer) { const t = await ticketFolder({ ref: d.ticket, customer: d.customer, label: d.label }); return { id: t.folderId, webUrl: t.folderUrl }; }
  // Older tickets with no customer: the original media folder.
  let parent = (await graph(`/me/drive/root`)).id;
  for (const part of [...OLD_MEDIA_ROOT.split("/"), cleanName(d.ticket || "unfiled", 40) || "unfiled"]) parent = (await mkdir(parent, part)).id;
  return await graph(`/me/drive/items/${parent}?$select=id,webUrl`);
}
async function mediaStart(d: any) {
  const f = await folderFor(d);
  const name = cleanName(d.name || "file", 120) || "file";
  const size = +d.size || 0;
  if (!size || size > 500 * 1024 * 1024) throw new Error("File must be under 500 MB");
  const s = await graph(`/me/drive/items/${f.id}:/${encodeURIComponent(name)}:/createUploadSession`, {
    method: "POST", body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "rename" } }),
  });
  const id = crypto.randomUUID();
  await sql`insert into fbw.uploads(id,upload_url,size,received,ticket,name,folder_id) values (${id},${s.uploadUrl},${size},0,${cleanName(d.ticket || "", 40)},${name},${f.id})`;
  return { ok: true, upload: id, folderUrl: f.webUrl, folderId: f.id };
}
async function shareLink(itemId: string) {
  try {
    const j = await graph(`/me/drive/items/${itemId}/createLink`, { method: "POST", body: JSON.stringify({ type: "view", scope: "anonymous" }) });
    return { url: j?.link?.webUrl as string, scope: "anyone" };
  } catch (e) {
    const j = await graph(`/me/drive/items/${itemId}/createLink`, { method: "POST", body: JSON.stringify({ type: "view", scope: "organization" }) });
    return { url: j?.link?.webUrl as string, scope: "organisation", note: (e as Error).message };
  }
}
async function mediaFolderLink(d: any) {
  const f = await folderFor(d);
  const link = await shareLink(f.id);
  return { ok: true, folderId: f.id, folderUrl: f.webUrl, shareUrl: link.url, shareScope: link.scope, shareNote: link.note || null };
}
async function mediaDelete(d: any) {
  const id = String(d.itemId || ""); if (!id) throw new Error("No item");
  const it = await graph(`/me/drive/items/${id}?$select=id,file,parentReference`);
  const p = decodeURIComponent(String(it?.parentReference?.path || ""));
  if (!it.file || !(p.includes("/" + CLIENT_ROOT + "/") || p.includes(OLD_MEDIA_ROOT))) throw new Error("Only ticket files can be removed from here");
  const c = await token();
  const r = await fetch(`${GRAPH}/me/drive/items/${id}`, { method: "DELETE", headers: { authorization: "Bearer " + c.access_token } });
  if (!r.ok && r.status !== 404) throw new Error("OneDrive delete " + r.status);
  return { ok: true };
}

/* FreshBooks connection (shared with the freshbooks bridge; refreshed the same way). Read-only use here. */
async function fbToken() {
  return await sql.begin(async (tx) => {
    const [c] = await tx`select * from fbw.conn where provider='freshbooks' for update`;
    if (!c || !c.refresh_token) throw new Error("FreshBooks isn't connected");
    if (c.access_token && c.expires_at && new Date(c.expires_at).getTime() - Date.now() > 120000) return c;
    const r = await fetch(FB_API + "/auth/oauth/token", { method: "POST", headers: { "content-type": "application/json", "Api-Version": "alpha" },
      body: JSON.stringify({ client_id: FB_ID, client_secret: FB_SECRET, redirect_uri: FB_REDIRECT, grant_type: "refresh_token", refresh_token: c.refresh_token }) });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access_token) throw new Error("FreshBooks token error: " + (t.error_description || t.error || r.status));
    const [n] = await tx`update fbw.conn set access_token=${t.access_token}, refresh_token=${t.refresh_token || c.refresh_token},
      expires_at=${new Date(Date.now() + (t.expires_in || 3600) * 1000)}, last_error=null where provider='freshbooks' returning *`;
    return n;
  });
}
async function estimateFile(d: any) {
  const id = parseInt(d.estimateId, 10); if (!id) throw new Error("No FreshBooks estimate on this ticket");
  const f = await folderFor({ folderId: d.folderId, ticket: d.ref, customer: d.customer, label: d.label });
  const fb = await fbToken();
  const r = await fetch(`${FB_API}/accounting/account/${fb.account_id}/estimates/estimates/${id}/pdf`,
    { headers: { authorization: "Bearer " + fb.access_token, accept: "application/pdf", "Api-Version": "alpha" } });
  if (!r.ok) throw new Error("FreshBooks estimate PDF " + r.status);
  const pdf = new Uint8Array(await r.arrayBuffer());
  const name = cleanName(`Estimate ${d.number || id}.pdf`, 80);
  const c = await token();
  const u = await fetch(`${GRAPH}/me/drive/items/${f.id}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=replace`,
    { method: "PUT", headers: { authorization: "Bearer " + c.access_token, "content-type": "application/pdf" }, body: pdf });
  const j = await u.json().catch(() => ({}));
  if (!u.ok) throw new Error(`OneDrive ${u.status}: ${j?.error?.message || u.statusText}`);
  const link = await shareLink(j.id);
  await sql`insert into fbw.log(op,ref,ok,fb_id,fb_number,detail) values ('estimate_file',${d.ref || null},true,${String(id)},${String(d.number || "")},${sql.json({ item: j.id, scope: link.scope })})`.catch(() => {});
  return { ok: true, itemId: j.id, name: j.name, webUrl: j.webUrl, shareUrl: link.url, shareScope: link.scope, folderId: f.id, folderUrl: f.webUrl };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const [k] = await sql`select v from fbw.settings where k='bridge_key'`;
  if (!k || req.headers.get("x-hsd-key") !== k.v) return json({ ok: false, error: "forbidden" }, 403);
  const b = await req.json().catch(() => ({}));
  try {
    switch (b.op) {
      case "ticket_folder": return json(await ticketFolder(b));
      case "ticket_copy": return json(await ticketCopy(b));
      case "media_start": return json(await mediaStart(b));
      case "media_folder_link": return json(await mediaFolderLink(b));
      case "media_delete": return json(await mediaDelete(b));
      case "estimate_file": return json(await estimateFile(b));
      default: return json({ ok: false, error: "unknown op" }, 400);
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return json({ ok: false, error: msg.startsWith("not_connected") ? "OneDrive isn't connected" : msg });
  }
});
