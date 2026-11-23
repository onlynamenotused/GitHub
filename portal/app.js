import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const cfg = window.PORTAL_CONFIG || {};
const sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" }
});

const $ = (s) => document.querySelector(s);
const views = ["loading", "login", "view-machines", "view-machine", "view-add", "view-reports", "view-kb", "view-contact", "view-customers", "view-book", "view-kits"];
const state = { user: null, clients: [], machines: [], kb: null, resources: null, kbAccess: false, intranet: false, staff: false, access: null };

// ---------- helpers ----------
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
  return n;
}
function show(id) { for (const v of views) $("#" + v).hidden = v !== id; }
function fmtDate(d) {
  if (!d) return "—";
  const x = new Date(d + "T00:00:00");
  return isNaN(x) ? d : x.toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function pmStatus(m) {
  if (state.hideSchedule) return { cls: "none", label: "" };   // vendor logins: service schedules aren't set up for them yet
  if (!m.pm_next_due) return { cls: "none", label: "No service schedule" };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(m.pm_next_due + "T00:00:00");
  const days = Math.round((due - today) / 86400000);
  if (days < 0) return { cls: "over", label: "Service overdue" };
  if (days <= 30) return { cls: "soon", label: "Service due soon" };
  return { cls: "ok", label: "Service up to date" };
}
function machineName(m) { return [m.brand, m.model].filter(Boolean).join(" ") || "Machine"; }
function norm(s) { return String(s || "").toLowerCase(); }

// ---------- auth ----------
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#email").value.trim();
  const msg = $("#loginMsg");
  const btn = e.target.querySelector("button");
  btn.disabled = true; msg.className = "msg"; msg.textContent = "Sending…";
  const { error } = await sb.auth.signInWithOtp({
    email, options: { emailRedirectTo: location.origin + location.pathname }
  });
  btn.disabled = false;
  if (error) { msg.className = "msg err"; msg.textContent = "Couldn't send the link: " + error.message; return; }
  msg.className = "msg ok";
  msg.textContent = "Check your inbox for an email from Highway Digital (it can take a minute to arrive). Press Sign in in the email, or type the code from it below.";
  $("#codeForm").hidden = false; $("#codeMsg").textContent = ""; $("#otp").value = ""; $("#otp").focus();
});
// The sign-in email also carries a one-time code, so the email can be read on one device and the code typed on another.
$("#codeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#email").value.trim(), token = $("#otp").value.replace(/\D/g, "");
  const msg = $("#codeMsg"), btn = e.target.querySelector("button");
  if (!email) { msg.className = "msg err"; msg.textContent = "Enter your email address above first."; return; }
  if (token.length < 6) { msg.className = "msg err"; msg.textContent = "Type the code from the email (numbers only)."; return; }
  btn.disabled = true; msg.className = "msg"; msg.textContent = "Checking the code…";
  const { error } = await sb.auth.verifyOtp({ email, token, type: "email" });
  btn.disabled = false;
  if (error) { msg.className = "msg err"; msg.textContent = /expired|invalid/i.test(error.message) ? "That code is wrong or has expired. Check the latest email, or send a new one." : "Couldn't sign in: " + error.message; return; }
  msg.className = "msg ok"; msg.textContent = "Signed in.";
});
async function signOut() { await sb.auth.signOut(); setAccessCookie(null); history.replaceState(null, "", location.pathname); location.reload(); }

// ---------- shared menu (nav.js) ----------
const navHost = () => $("#hd-nav");
function drawNav(active) {
  window.HDNav?.render(navHost(), state.user
    ? { signedIn: true, email: state.user.email, staff: state.staff, intranet: state.intranet, kb: state.kbAccess || isSupervisor(), cat: state.catAccess, vector: state.vectorAccess, flute: state.fluteAccess, appsOnly: state.appsOnly, supervisor: isSupervisor(), reports: !!state.reportsAccess, active }
    : { signedIn: false });
}

// The KB and catalogue pages are checked by the server (_worker.js) using this cookie.
function setAccessCookie(session) {
  if (session?.access_token) {
    document.cookie = `hd_at=${encodeURIComponent(session.access_token)}; Path=/; Max-Age=${session.expires_in || 3600}; Secure; SameSite=Lax`;
  } else {
    document.cookie = "hd_at=; Path=/; Max-Age=0; Secure; SameSite=Lax";
  }
}
const okNext = (p) => typeof p === "string" && /^\/(kb|catalogue|vector|flute|warehousing)(\/[A-Za-z0-9._\-\/]*)?$/.test(p);
{
  const nx = new URLSearchParams(location.search).get("next");
  if (okNext(nx)) { try { localStorage.setItem("hd_next", nx); } catch (e) {} history.replaceState(null, "", location.pathname + location.hash); }
}

sb.auth.onAuthStateChange((evt, session) => {
  setAccessCookie(session);
  if (evt !== "SIGNED_IN" && evt !== "SIGNED_OUT") return;
  const was = state.user?.id;
  state.user = session?.user || null;
  if (state.user?.id !== was) boot();
});

// ---------- data ----------
async function loadCore() {
  const [c, m, k, s, g, it, ...rest] = await Promise.all([
    sb.from("clients").select("id,name,kb_access,vector_access,flute_access,apps_only,reports_access,catalogue_access,catalogue_brands").order("name"),
    sb.from("machines").select("*").eq("status", "active").order("brand").order("model"),
    sb.rpc("has_kb_access"),
    sb.rpc("is_staff"),
    sb.rpc("has_catalogue_access"),
    sb.rpc("is_intranet"),
    sb.from("machine_files").select("id,kind,name,machine_id,param_date,modified,size,fw").order("param_date", { ascending: false }),
    sb.from("fb_invoices").select("*").order("issued", { ascending: false }).limit(60),
    sb.from("fb_estimates").select("*").order("issued", { ascending: false }).limit(60),
    sb.from("supervisors").select("id,name,bill_to,scope"),
    sb.rpc("has_vector_access"),
    sb.rpc("has_flute_access"),
    sb.rpc("is_apps_only"),
    sb.rpc("has_reports_access")
  ]);
  const [mf, inv, est, sv, va, fa, ao, ra] = rest;
  state.reportsAccess = ra?.data === true;
  state.vectorAccess = va?.data === true;
  state.fluteAccess = fa?.data === true;
  state.appsOnly = ao?.data === true;
  state.supervisors = sv?.data || [];
  if (c.error) throw c.error;
  if (m.error) throw m.error;
  state.clients = c.data; state.machines = m.data;
  // Vendor logins (e.g. Mimaki) don't see service schedule dates: they aren't set up correctly for vendors yet.
  state.hideSchedule = !s.data && (state.supervisors || []).length > 0 && state.supervisors.every((x) => x.scope === "invoiced");
  if (state.hideSchedule) for (const x of state.machines) { x.pm_next_due = null; x.pm_last_done = null; x.pm_interval_months = null; }
  state.kbAccess = k.data === true; state.staff = s.data === true;
  state.catAccess = g.data === true;
  state.intranet = it.data === true;
  state.files = mf.data || []; state.invoices = inv.data || []; state.estimates = est.data || [];
  state.kits = {};
  if (isCustomer()) { const kq = await sb.rpc("my_service_kits"); state.kits = (kq && kq.data) || {}; }
  drawNav();
}
async function loadKb() {
  if (state.kb) return state.kb;
  const { data, error } = await sb.from("kb_public").select("*").order("brand").order("fault");
  if (error) throw error;
  return (state.kb = data);
}
async function loadResources() {
  if (state.resources) return state.resources;
  const { data, error } = await sb.from("machine_resources").select("*").order("sort").order("title");
  if (error) throw error;
  return (state.resources = data);
}
function kbForMachine(kb, m) {
  const model = norm(m.model);
  return kb.filter((a) =>
    norm(a.brand) === norm(m.brand) &&
    ((a.models || []).some((x) => model.includes(norm(x)) || norm(x).includes(model)) ||
     (a.family && model.includes(norm(a.family))))
  );
}
// model_match holds "|"-separated keys (letters and digits only). The most specific
// (longest) matching key wins, so a CJV300 doesn't also get the JV300's links.
const nz = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function resourcesForMachine(res, m) {
  const model = nz(m.model);
  let best = 0;
  const scored = [];
  for (const r of res) {
    if (norm(r.brand) !== norm(m.brand)) continue;
    if (!r.model_match) { scored.push([r, 0]); continue; }
    const s = Math.max(0, ...r.model_match.split("|").filter((k) => k && model.includes(k)).map((k) => k.length));
    if (s > 0) { scored.push([r, s]); best = Math.max(best, s); }
  }
  const seen = new Set();
  return scored.filter(([, s]) => s === 0 || s === best).map(([r]) => r)
    .filter((r) => !seen.has(r.url) && seen.add(r.url));
}

// ---------- views ----------
/* Machine filters: customer, brand, model (model choices follow the brand), plus the search box. */
function machineFilters() {
  const cs = $("#mfCust"), bs = $("#mfBrand"), ms = $("#mfModel");
  const cv = cs.value, bv = bs.value, mv = ms.value;
  const opt = (v, l, cur) => el("option", { value: v, selected: v === cur }, l);
  const custIds = [...new Set(state.machines.map((m) => m.client_id).filter(Boolean))];
  const cnames = custIds.map((id) => [String(id), state.clients.find((c) => c.id === id)?.name || "Customer " + id]).sort((a, b) => a[1].localeCompare(b[1]));
  cs.replaceChildren(opt("", "All customers (" + cnames.length + ")", cv), ...cnames.map(([id, n]) => opt(id, n, cv)));
  cs.hidden = cnames.length < 2;
  const inCust = state.machines.filter((m) => !cs.value || String(m.client_id) === cs.value);
  const brands = [...new Set(inCust.map((m) => m.brand).filter(Boolean))].sort();
  bs.replaceChildren(opt("", "All brands", bv), ...brands.map((b) => opt(b, b, bv)));
  if (bv && !brands.includes(bv)) bs.value = "";
  const models = [...new Set(inCust.filter((m) => !bs.value || m.brand === bs.value).map((m) => m.model).filter(Boolean))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  ms.replaceChildren(opt("", "All models", mv), ...models.map((x) => opt(x, x, mv)));
  if (mv && !models.includes(mv)) ms.value = "";
  [cs, bs, ms].forEach((x) => x.classList.toggle("on", !!x.value));
}
function renderMachines() {
  machineFilters();
  const q = norm($("#machineSearch").value), fc = $("#mfCust").value, fb = $("#mfBrand").value, fm = $("#mfModel").value;
  const cnm = (id) => state.clients.find((c) => c.id === id)?.name || "";
  const list = state.machines.filter((m) => (!fc || String(m.client_id) === fc) && (!fb || m.brand === fb) && (!fm || m.model === fm) &&
    (!q || [m.brand, m.model, m.serial, m.site, m.location, m.sub_category, cnm(m.client_id), machineName(m)].some((v) => norm(v).includes(q))));
  const filtered = !!(q || fc || fb || fm);
  $("#mfClear").hidden = !filtered;
  $("#mfCount").textContent = filtered ? list.length + " of " + state.machines.length + " machines" : state.machines.length + " machines";
  $("#clientTitle").textContent = state.staff ? "Customer Assets" : isSupervisor() ? supName() + (isVendorOnly() ? " jobs" : " fleet") : state.clients.length === 1 ? state.clients[0].name : "My machines";

  const counts = { over: 0, soon: 0, ok: 0 };
  for (const m of state.machines) { const s = pmStatus(m).cls; if (s in counts) counts[s]++; }
  $("#stats").replaceChildren(...[
    el("div", { class: "stat" }, el("div", { class: "n" }, state.machines.length), el("div", { class: "l" }, "Machines")),
    state.hideSchedule ? null : el("div", { class: "stat" }, el("div", { class: "n" }, counts.over), el("div", { class: "l" }, "Service overdue")),
    state.hideSchedule ? null : el("div", { class: "stat" }, el("div", { class: "n" }, counts.soon), el("div", { class: "l" }, "Due in the next 30 days"))
  ].filter(Boolean));

  const box = $("#machineList");
  $("#addMachineBtn").hidden = !isCustomer();
  const xh = $("#exportHost"); if (xh && !xh.firstChild && state.machines.length) xh.append(exportMenu());
  renderOpenJobs();
  if (!state.machines.length) {
    box.replaceChildren(el("div", { class: "card empty" },
      ...(isCustomer() ? ["No machines on your account yet. ", el("a", { href: "#add-machine" }, "Add your first machine"), " (you can scan its serial plate), or contact "]
        : ["No machines are linked to this email address yet. Contact "]),
      el("a", { href: "mailto:" + cfg.contactEmail }, cfg.contactEmail), " and we'll set it up."));
    return;
  }
  if (!list.length) { $("#machineHint").hidden = true; box.replaceChildren(el("div", { class: "empty" }, "No machines match that search.")); return; }
  renderBilling();
  $("#machineHint").hidden = false;
  if (state.staff) $("#machineHint").textContent = "Tap a machine to see its details, service history and files.";
  box.replaceChildren(...list.map((m) => {
    const s = pmStatus(m);
    return el("button", { class: "mcard", onclick: () => (location.hash = "#machine/" + encodeURIComponent(m.id)) },
      el("span", { class: "model" }, machineName(m)),
      el("span", { class: "muted small" }, [m.sub_category || m.category, m.serial && "SN " + m.serial].filter(Boolean).join(" · ")),
      (state.clients.length > 1 || state.staff) ? el("span", { class: "small cust" }, clientName(m.client_id)) : null,
      el("span", { class: "muted small" }, m.location || m.site || ""),
      s.label ? el("span", { class: "pill " + s.cls }, s.label + (m.pm_next_due ? " · " + fmtDate(m.pm_next_due) : "")) : null,
      m.added_via === "portal" && m.desk_seen === false ? el("span", { class: "muted small" }, "Added by you · we'll check the details") : null,
      filesFor(m).length ? el("span", { class: "muted small" }, "📄 " + filesFor(m).length + " parameter/log file" + (filesFor(m).length > 1 ? "s" : "")) : null,
      state.staff || isVendorOnly() ? null : el("span", { class: "mbook", role: "link", title: "Book a service or log a job for this machine",
        onclick: (e) => { e.stopPropagation(); location.hash = "#book/" + encodeURIComponent(m.id); } }, "Book"),
      isCustomer() && !isSupervisor() ? el("span", { class: "mquote", role: "button", tabindex: 0, title: kitFor(m) ? "Get a quote for this machine's service and PM parts, emailed to you now" : "Get a quote for a service visit, emailed to you now",
        onclick: (e) => { e.stopPropagation(); openServiceQuote(m.id); },
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); openServiceQuote(m.id); } } }, "Quote me") : null
    );
  }));
}

// ---------- parameter & log files ----------
function filesFor(m) { return (state.files || []).filter((f) => f.machine_id === m.id); }
function fmtSize(n) { return !n ? "" : n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(0) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
async function downloadFile(f, btn) {
  btn.disabled = true; const was = btn.textContent; btn.textContent = "Preparing…";
  try {
    const { data, error } = await sb.from("machine_files").select("content").eq("id", f.id).single();
    if (error || !data) throw error || new Error("missing");
    const url = URL.createObjectURL(new Blob([data.content || ""], { type: "text/csv" }));
    const a = el("a", { href: url, download: f.name || "parameters.csv" }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    btn.textContent = was;
  } catch (e) { btn.textContent = "Download failed"; }
  btn.disabled = false;
}
function filesCard(m) {
  const files = filesFor(m);
  const group = (kind, title) => {
    const fs = files.filter((f) => (kind === "log" ? f.kind === "log" : f.kind !== "log"));
    if (!fs.length) return null;
    return el("div", {}, el("h3", { class: "fhead" }, title),
      el("ul", { class: "files" }, ...fs.map((f) => {
        const b = el("button", { class: "btn small", onclick: () => downloadFile(f, b) }, "Download");
        return el("li", {},
          el("span", { class: "fname" }, el("b", {}, fmtDate(f.param_date || f.modified)), " ", el("span", { class: "muted small" }, [f.fw && "FW " + f.fw, fmtSize(f.size)].filter(Boolean).join(" · ")),
            el("br"), el("span", { class: "muted small" }, f.name)),
          b);
      })));
  };
  return el("div", { class: "card", style: "margin-top:14px" }, el("h2", {}, "Parameter & log files"),
    files.length ? el("div", { class: "stack" }, group("parameter", "Parameter backups"), group("log", "Logs"))
      : el("p", { class: "muted small" }, "No parameter or log files saved for this machine yet. We save a copy at each service."));
}

// ---------- invoices & estimates ----------
const INV_LABEL = { paid: "Paid", unpaid: "Unpaid", partial: "Part paid", overdue: "Overdue", disputed: "Disputed" };
const INV_CLS = { paid: "ok", unpaid: "soon", partial: "soon", overdue: "over", disputed: "over" };
const EST_LABEL = { sent: "Sent", viewed: "Viewed", replied: "Replied", accepted: "Accepted", invoiced: "Invoiced", declined: "Declined" };
const EST_CLS = { sent: "soon", viewed: "soon", replied: "soon", accepted: "ok", invoiced: "ok", declined: "over" };
function clientName(id) { return state.clients.find((c) => c.id === id)?.name || ""; }
function billingTable(rows, kind) {
  const isInv = kind === "inv", portal = cfg.freshbooksPortal || "https://my.freshbooks.com/";
  const multi = state.staff || state.clients.length > 1;
  return el("table", { class: "billing" },
    el("thead", {}, el("tr", {}, el("th", {}, "Date"), el("th", {}, isInv ? "Invoice" : "Estimate"), multi ? el("th", {}, "Customer") : null, el("th", {}, "Reference"), el("th", {}, "Status"), el("th", {}, ""))),
    el("tbody", {}, ...rows.map((r) => {
      const st = r.status, open = isInv ? st !== "paid" : ["sent", "viewed", "replied"].includes(st);
      return el("tr", {},
        el("td", { "data-l": "Date" }, fmtDate(r.issued)),
        el("td", { "data-l": isInv ? "Invoice" : "Estimate" }, el("b", {}, r.number)),
        multi ? el("td", { "data-l": "Customer" }, clientName(r.client_id)) : null,
        el("td", { "data-l": "Reference" }, r.reference || "—"),
        el("td", { "data-l": "Status" }, el("span", { class: "pill " + ((isInv ? INV_CLS : EST_CLS)[st] || "") }, (isInv ? INV_LABEL : EST_LABEL)[st] || st)),
        el("td", { class: "act" }, el("a", { class: "btn small" + (open && isInv ? " primary" : ""), href: portal, target: "_blank", rel: "noopener" },
          isInv ? (open ? "Pay now" : "View") : (open ? "Review & accept" : "View"))));
    })));
}
async function vendorInvoiceRows() {
  const ids = (state.supervisors || []).map((x) => x.id);
  const { data, error } = await allRows(() => sb.from("service_records").select("id,client_id,machine_id,number,issued,status,kind,po,total_ex,total_inc,lines").in("supervisor_id", ids).order("issued", { ascending: false }).order("id"));
  if (error) throw error;
  const head = ["Date", "Invoice", "Customer", "Machine", "Serial", "PO / reference", "Type", "Status", "Reported issue", "Parts", "Ex GST", "Inc GST"];
  return [head, (data || []).map((r) => { const m = state.machines.find((x) => x.id === r.machine_id); const lab = (r.lines || []).find((l) => /labou?r|day rate|hourly/i.test(l.code || ""));
    return [r.issued || "", r.number, state.clients.find((c) => c.id === r.client_id)?.name || "", m ? machineName(m) : "", m?.serial || "", r.po || "", KIND_NAMES[r.kind] || r.kind || "", r.status || "",
      (String((lab && lab.desc) || "").match(/reported issue:\s*([^\n]+)/i) || [])[1] || "", (r.lines || []).filter(isPart).map((l) => (Number(l.qty) || 1) + " x " + l.code).join("; "),
      (Number(r.total_ex) || 0).toFixed(2), (Number(r.total_inc) || 0).toFixed(2)]; })];
}
/* Vendor / supervisor logins: their own invoices from us (billed to the vendor), newest first. */
function vendorInvoicesCard() {
  const name = supName();
  const card = el("div", { class: "card vinv" }, el("div", { class: "bhead" }, el("h2", {}, "Recent invoices to " + name), el("a", { class: "btn small", href: "#reports" }, "All in Reports")),
    el("p", { class: "muted small" }, "Loading…"));
  (async () => {
    if (!state.vendorInv) {
      const ids = (state.supervisors || []).map((x) => x.id);
      const { data, error } = await sb.from("service_records").select("id,client_id,machine_id,number,issued,status,kind,po,total_ex,total_inc,lines")
        .in("supervisor_id", ids).order("issued", { ascending: false }).limit(15);
      if (error) { card.lastChild.replaceWith(el("p", { class: "msg err" }, "Couldn't load invoices.")); return; }
      state.vendorInv = data || [];
    }
    const rows = state.vendorInv;
    const total = rows.reduce((a, r) => a + (Number(r.total_ex) || 0), 0);
    const mOfId = (id) => state.machines.find((m) => m.id === id);
    const custOf = (id) => state.clients.find((c) => c.id === id)?.name || "Not matched to a customer";
    card.lastChild.replaceWith(rows.length ? el("div", { class: "tscroll" }, el("table", { class: "tbl rtbl" },
      el("thead", {}, el("tr", {}, ...["Date", "Invoice", "Customer", "Machine", "PO / reference", "Status", "Ex GST"].map((h) => el("th", { class: h === "Ex GST" ? "num" : null }, h)))),
      el("tbody", {}, ...rows.map((r) => { const m = mOfId(r.machine_id); const lab = (r.lines || []).find((l) => /labou?r|day rate|hourly/i.test(l.code || ""));
        return el("tr", { class: "rrow", tabindex: 0, title: lab ? String(lab.desc || "").split("\n").slice(0, 4).join(" · ") : "", onclick: () => { rep.f.q = r.number; rep.f.tab = "jobs"; location.hash = "#reports"; } },
          el("td", { "data-l": "Date" }, fmtDate(r.issued)), el("td", { class: "mono", "data-l": "Invoice" }, r.number), el("td", { "data-l": "Customer" }, custOf(r.client_id)),
          el("td", { "data-l": "Machine" }, m ? machineName(m) + (m.serial ? " · SN " + m.serial : "") : "—"), el("td", { "data-l": "PO" }, r.po || "—"),
          el("td", { "data-l": "Status" }, el("span", { class: "pill " + (r.status === "paid" ? "ok" : "soon") }, r.status || "")),
          el("td", { class: "num", "data-l": "Ex GST" }, money(r.total_ex))); }))),
      el("p", { class: "muted small" }, rows.length + " most recent · " + money(total) + " ex GST. Click one to open it in Reports with its full job notes and parts."))
      : el("p", { class: "muted small" }, "No invoices to " + name + " yet."));
  })();
  return card;
}
function renderBilling() {
  const box = $("#billing"); if (!box) return;
  const inv = (state.invoices || []).slice(0, 12), est = (state.estimates || []).slice(0, 12);
  const owing = (state.invoices || []).filter((r) => r.status !== "paid").length;
  const parts = [];
  if (isSupervisor() && !state.staff) parts.push(vendorInvoicesCard());   // vendor / supervisor: invoices billed to them
  if (!isVendorOnly()) parts.push(
    el("div", { class: "card" },
      el("div", { class: "bhead" }, el("h2", {}, "Recent invoices"), owing ? el("span", { class: "pill over" }, owing + " outstanding") : null),
      inv.length ? billingTable(inv, "inv") : el("p", { class: "muted small" }, "No invoices yet."),
      el("p", { class: "muted small" }, "Pay now and View open your FreshBooks client area. Sign in there with this email address to see the full invoice and pay by card.")),
    el("div", { class: "card" },
      el("h2", {}, "Estimates"),
      est.length ? billingTable(est, "est") : el("p", { class: "muted small" }, "No estimates have been sent to you yet.")));
  box.replaceChildren(...parts);
}

async function renderMachine(id) {
  const m = state.machines.find((x) => x.id === id);
  const v = $("#view-machine");
  if (!m) { v.replaceChildren(el("div", { class: "card empty" }, "Machine not found.")); return; }
  const s = pmStatus(m);
  const client = state.clients.find((c) => c.id === m.client_id);
  const relKb = el("div", { class: "stack" }, el("p", { class: "muted small" }, "Loading…"));
  const relRes = el("ul", { class: "links" }, el("li", { class: "muted small" }, "Loading…"));

  const flashMsg = state.flash; state.flash = "";
  v.replaceChildren(
    el("button", { class: "btn back", onclick: () => (location.hash = "#machines") }, "← All machines"),
    flashMsg ? el("p", { class: "msg ok", role: "status" }, flashMsg) : "",
    el("div", { class: "detail" },
      el("div", { class: "card" },
        el("h1", {}, machineName(m)),
        s.label ? el("p", {}, el("span", { class: "pill " + s.cls }, s.label)) : null,
        el("dl", { class: "kv" },
          el("dt", {}, "Customer"), el("dd", {}, client?.name || "—"),
          el("dt", {}, "Serial"), el("dd", {}, m.serial || "—"),
          el("dt", {}, "Type"), el("dd", {}, [m.category, m.sub_category].filter(Boolean).join(" · ") || "—"),
          m.ink_set && el("dt", {}, "Ink set"), m.ink_set && el("dd", {}, m.ink_set),
          el("dt", {}, "Location"), el("dd", {}, m.location || m.site || "—"),
          !state.hideSchedule && el("dt", {}, "Last service"), !state.hideSchedule && el("dd", {}, fmtDate(m.pm_last_done)),
          !state.hideSchedule && el("dt", {}, "Next service due"), !state.hideSchedule && el("dd", {}, fmtDate(m.pm_next_due)),
          m.pm_interval_months && el("dt", {}, "Service interval"), m.pm_interval_months && el("dd", {}, "Every " + m.pm_interval_months + " months"),
          m.warranty_end && el("dt", {}, "Warranty until"), m.warranty_end && el("dd", {}, fmtDate(m.warranty_end)),
          m.added_via === "portal" && el("dt", {}, "Added"), m.added_via === "portal" && el("dd", {}, m.desk_seen === false ? "By you, waiting for us to check" : "By you, checked by Highway Digital")
        ),
        el("p", { style: "display:flex;gap:8px;flex-wrap:wrap" }, el("a", { class: "btn primary", href: state.staff ? cfg.bookingUrl : "#book/" + encodeURIComponent(m.id), target: state.staff ? "_blank" : null, rel: state.staff ? "noopener" : null }, "Book a service"), el("a", { class: "btn", href: mailtoFor(m) }, "Email us about this machine"))
      ),
      el("div", { class: "card" }, el("h2", {}, "Manuals, drivers & software"), relRes)
    ),
    machineHistoryCard(m),
    filesCard(m),
    el("div", { id: "mExtras" }),
    ...(state.intranet ? [el("div", { class: "card", style: "margin-top:14px" }, el("h2", {}, "Intranet Knowledge for this machine"), relKb)] : [])
  );

  machineExtras(m, $("#mExtras"));
  try {
    const [kb, res] = await Promise.all([state.intranet ? loadKb() : Promise.resolve([]), loadResources()]);
    const arts = kbForMachine(kb, m);
    relKb.replaceChildren(...(arts.length ? arts.map(kbItem) : [el("p", { class: "muted small" }, "No articles for this model yet.")]));
    const links = resourcesForMachine(res, m);
    relRes.replaceChildren(...(links.length
      ? links.map((r) => el("li", {}, el("span", { class: "kind" }, r.kind), el("a", { href: r.url, target: "_blank", rel: "noopener" }, r.title)))
      : [el("li", { class: "muted small" }, "Links for this model are coming soon.")]));
  } catch (e) { relKb.replaceChildren(el("p", { class: "msg err" }, "Couldn't load articles.")); }
}

/* Machine page: open and recent service desk tickets for this machine, and its FreshBooks invoices.
   What each login sees is limited by the database (customers: theirs; vendors: billed to them; staff: all). */
const T_STATUS = { new: ["New", "soon"], scheduled: ["Scheduled", "soon"], "in-progress": ["In progress", "soon"], waiting: ["Waiting", "soon"], quote: ["Quote", "soon"], completed: ["Completed", "ok"], invoiced: ["Invoiced", "ok"] };
/* Open an invoice in FreshBooks: staff go straight to it; customers and vendors to their FreshBooks client area. */
function fbInvLink(x) {
  const fid = String(x.id || "").replace(/^fbinv-/, "");
  const owing = !["paid", "draft"].includes(String(x.status || ""));
  const href = state.staff && /^\d+$/.test(fid) ? "https://my.freshbooks.com/#/invoice/" + fid : (cfg.freshbooksPortal || "https://my.freshbooks.com/");
  return el("a", { class: "btn small" + (owing && !state.staff ? " primary" : ""), href, target: "_blank", rel: "noopener",
    title: state.staff ? "Open this invoice in FreshBooks" : "Opens your FreshBooks client area: sign in with this email address to see the full invoice" + (owing ? " and pay by card" : "") },
    owing && !state.staff ? "Pay now" : "View");
}
function machineHistoryCard(m) {
  const tBox = el("div", { class: "stack" }, el("p", { class: "muted small" }, "Loading…"));
  const iBox = el("div", {}, el("p", { class: "muted small" }, "Loading…"));
  (async () => {
    const [t, r] = await Promise.all([
      sb.from("tickets").select("num,type,subtype,status,summary,created,sched_date,sched_time").eq("machine_id", m.id).eq("sample", false).order("num", { ascending: false }).limit(25),
      sb.from("service_records").select("id,number,issued,status,kind,po,total_ex,lines").eq("machine_id", m.id).neq("status", "draft").order("issued", { ascending: false }).limit(25)]);
    if (t.error) tBox.replaceChildren(el("p", { class: "msg err" }, "Couldn't load tickets."));
    else {
      const done = (x) => ["completed", "invoiced"].includes(x.status);
      const list = [...t.data.filter((x) => !done(x)), ...t.data.filter(done).slice(0, 8)];
      tBox.replaceChildren(...(list.length ? list.map((x) => { const [lb, cl] = T_STATUS[x.status] || [x.status, "none"];
        return el("div", { class: "bkitem" + (done(x) ? "" : " open") },
          el("b", {}, "Job " + x.num + " · " + fmtDate(x.created)),
          el("div", { class: "muted small" }, String(x.summary || "").replace(/^[^/]*\/\s*/, "")),
          el("span", { class: "pill " + cl }, lb + (x.sched_date && !done(x) ? " · booked " + fmtDate(x.sched_date) + (x.sched_time ? " " + String(x.sched_time).slice(0, 5) : "") : ""))); })
        : [el("p", { class: "muted small" }, "No service desk tickets for this machine.")]));
    }
    if (r.error) iBox.replaceChildren(el("p", { class: "msg err" }, "Couldn't load invoices."));
    else iBox.replaceChildren(r.data.length ? el("div", { class: "tscroll" }, el("table", { class: "tbl rtbl" },
      el("thead", {}, el("tr", {}, ...["Date", "Invoice", "Work", "Status", "Ex GST", ""].map((h) => el("th", { class: h === "Ex GST" ? "num" : null }, h)))),
      el("tbody", {}, ...r.data.map((x) => { const lab = (x.lines || []).find((l) => /labou?r|day rate|hourly/i.test(l.code || ""));
        const ld = String((lab && lab.desc) || "");
        const issue = (ld.match(/reported issue:\s*([^\n]+)/i) || [])[1] || ld.split("\n").map((s) => s.trim()).filter((s) => s && !/^(date|model|job|serial|end user|install|work outstanding)/i.test(s))[0] || "";
        const work = [issue.replace(/^work performed:\s*/i, "").slice(0, 140), x.po && "PO " + x.po.replace(/^po\s*/i, "")].filter(Boolean).join(" · ") || ({ service: "Service", install: "Installation", parts: "Parts" }[x.kind] || "");
        const parts = (x.lines || []).filter(isPart).map((l) => (Number(l.qty) || 1) + "× " + l.code).slice(0, 4).join(", ");
        return el("tr", {}, el("td", { "data-l": "Date" }, fmtDate(x.issued)), el("td", { class: "mono", "data-l": "Invoice" }, x.number),
          el("td", { "data-l": "Work" }, work || "—", parts ? el("div", { class: "muted small" }, parts) : null),
          el("td", { "data-l": "Status" }, el("span", { class: "pill " + (x.status === "paid" ? "ok" : "soon") }, x.status || "")),
          el("td", { class: "num", "data-l": "Ex GST" }, money(x.total_ex)),
          el("td", { class: "act" }, fbInvLink(x))); }))))
      : el("p", { class: "muted small" }, "No FreshBooks invoices matched to this machine yet."));
  })();
  return el("div", { class: "card", style: "margin-top:14px" },
    el("h2", {}, "Tickets"), tBox,
    el("h2", { style: "margin-top:16px" }, "FreshBooks invoices"), iBox,
    el("p", { class: "muted small" }, (state.staff ? "" : "View and Pay now open your FreshBooks client area; sign in there with this email address to see the full invoice. ") +
      "Invoices are matched to a machine by its serial number or model on the invoice; some older invoices only show under the customer."));
}
function mailtoFor(m) {
  const subj = `Service request: ${machineName(m)}${m.serial ? " SN " + m.serial : ""}`;
  const body = `Machine: ${machineName(m)}\nSerial: ${m.serial || ""}\nLocation: ${m.location || ""}\n\nIssue:\n`;
  return `mailto:${cfg.contactEmail}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}`;
}

function kbItem(a) {
  return el("details", { class: "kb" },
    el("summary", {}, a.fault),
    el("div", { class: "meta" }, [a.brand, (a.models || []).join(", ")].filter(Boolean).join(" · ")),
    el("p", {}, a.resolution),
    (a.parts || []).length ? el("div", { class: "parts" }, "Parts: " + a.parts.map((p) => `${p.desc} (${p.code})`).join("; ")) : null
  );
}

async function renderKb() {
  const box = $("#kbList");
  if (!state.kb) box.replaceChildren(el("p", { class: "muted" }, "Loading…"));
  try {
    const kb = await loadKb();
    const q = norm($("#kbSearch").value);
    const brands = new Set(state.machines.map((m) => norm(m.brand)));
    const list = kb
      .filter((a) => !q || [a.fault, a.resolution, a.brand, a.family, ...(a.models || []), ...(a.keywords || [])].some((v) => norm(v).includes(q)))
      .sort((x, y) => (brands.has(norm(y.brand)) - brands.has(norm(x.brand))));
    box.replaceChildren(...(list.length ? list.map(kbItem) : [el("div", { class: "empty" }, q ? "No articles match that search." : "No articles published yet.")]));
  } catch (e) { box.replaceChildren(el("p", { class: "msg err" }, "Couldn't load articles.")); }
}

async function renderCustomers() {
  const body = $("#custRows");
  if (!state.staff) { body.replaceChildren(); return; }
  if (!renderCustomers.tabs) {
    renderCustomers.tabs = true;
    const showTab = (k) => {
      document.querySelectorAll("#custTabs [data-ctab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.ctab === k)));
      $("#custPanel").hidden = k !== "list"; $("#supAdmin").hidden = k !== "vendors"; $("#custSearch").hidden = k !== "list";
      if (k === "vendors" && !renderCustomers.sup) { renderCustomers.sup = true; renderSupervisorsAdmin($("#supAdmin")); }
      try { sessionStorage.setItem("hd-ctab", k); } catch (_) {}
    };
    document.querySelectorAll("#custTabs [data-ctab]").forEach((b) => { b.onclick = () => showTab(b.dataset.ctab); });
    let k0 = "list"; try { k0 = sessionStorage.getItem("hd-ctab") || "list"; } catch (_) {}
    showTab(k0 === "vendors" ? "vendors" : "list");
  }
  if (!state.access) {
    body.replaceChildren(el("tr", {}, el("td", { colspan: "10", class: "muted" }, "Loading…")));
    const [{ data, error }, vx] = await Promise.all([sb.from("portal_access").select("client_id,email"), sb.rpc("vector_export_counts")]);
    state.vexp = (vx && vx.data) || {};
    if (error) { body.replaceChildren(el("tr", {}, el("td", { colspan: "10", class: "msg err" }, "Couldn't load customers."))); return; }
    state.access = data;
  }
  const q = norm($("#custSearch").value);
  const mcount = {}, acount = {};
  for (const m of state.machines) if (m.client_id) mcount[m.client_id] = (mcount[m.client_id] || 0) + 1;
  for (const a of state.access) acount[a.client_id] = (acount[a.client_id] || 0) + 1;
  const list = state.clients.filter((c) => !q || norm(c.name).includes(q));
  const rows = [];
  for (const c of list) {
    const tick = (field, label) => {
      const note = el("span", { class: "saved" });
      const box = el("input", { type: "checkbox", "aria-label": label + " for " + c.name });
      box.checked = !!c[field];
      box.addEventListener("change", async () => {
        box.disabled = true; note.textContent = "";
        const { error } = await sb.from("clients").update({ [field]: box.checked }).eq("id", c.id);
        box.disabled = false;
        if (error) { box.checked = !box.checked; note.className = "saved msg err"; note.textContent = "Not saved"; return; }
        c[field] = box.checked; note.className = "saved"; note.textContent = "Saved";
        setTimeout(() => (note.textContent = ""), 2000);
      });
      return el("td", {}, el("label", {}, box, note));
    };
    const open = state.openClient === c.id;
    const btn = el("button", { class: "btn ghost small manage", type: "button", "aria-expanded": open ? "true" : "false",
      onclick: () => { state.openClient = open ? null : c.id; renderCustomers(); } }, open ? "Close" : "Manage");
    rows.push(el("tr", { class: open ? "openrow" : null },
      el("td", {}, el("div", { class: "cname" }, el("span", {}, c.name), btn)),
      el("td", {}, mcount[c.id] || 0),
      el("td", {}, acount[c.id] || 0),
      tick("kb_access", "Knowledge Base"),
      tick("vector_access", "Vector Converter"),
      tick("flute_access", "Flute Practice"),
      tick("apps_only", "Apps only"),
      tick("reports_access", "Reports"),
      el("td", { class: "num", title: vexpTitle(c.id) }, String(((state.vexp || {})[c.id] || {}).n || 0)),
      el("td", {}, catPicker(c, "clients", c.name))));
    if (open) {
      const cell = el("td", { colspan: "10", class: "panelcell" }, el("p", { class: "muted small" }, "Loading…"));
      rows.push(el("tr", { class: "panelrow" }, cell));
      renderManage(c, cell);
    }
  }
  body.replaceChildren(...rows);
}

function vexpTitle(id) {
  const v = (state.vexp || {})[id]; if (!v) return "No Vector Converter exports yet";
  const kinds = Object.entries(v.kinds || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => n + " " + k.replace(/^studio-/, "").toUpperCase()).join(", ");
  return v.n + " export" + (v.n === 1 ? "" : "s") + (kinds ? ": " + kinds : "") + (v.last ? ". Last on " + new Date(v.last).toLocaleDateString("en-AU") : "");
}
// ---------- staff: Parts Catalogue access by brand group ----------
const CAT_GROUPS = ["Mimaki", "Mutoh", "Brother", "Epilog", "Others"];
const CAT_HINT = { Epilog: "includes laser accessories", Others: "Kyocera, PC sales, network gear" };
function catPicker(row, table, label, onSaved) {
  const note = el("span", { class: "saved" });
  const boxes = CAT_GROUPS.map((g) => {
    const b = el("input", { type: "checkbox", "aria-label": g + " catalogue for " + label });
    b.checked = (row.catalogue_brands || []).includes(g);
    b.addEventListener("change", async () => {
      const want = CAT_GROUPS.filter((x, i) => boxes[i].checked);
      boxes.forEach((x) => (x.disabled = true)); note.textContent = "";
      const { data, error } = await sb.from(table).update({ catalogue_brands: want }).eq("id", row.id).select("catalogue_access,catalogue_brands").single();
      boxes.forEach((x) => (x.disabled = false));
      if (error) { b.checked = !b.checked; note.className = "saved msg err"; note.textContent = "Not saved"; return; }
      row.catalogue_brands = data.catalogue_brands; row.catalogue_access = data.catalogue_access;
      note.className = "saved"; note.textContent = "Saved"; setTimeout(() => (note.textContent = ""), 2000);
      if (onSaved) onSaved(row);
    });
    return b;
  });
  return el("div", { class: "catpick" }, ...CAT_GROUPS.map((g, i) => el("label", { title: CAT_HINT[g] || g }, boxes[i], el("span", {}, g))), note);
}

// ---------- staff: manage a customer's logins and machines ----------
const BRANDS = ["Mimaki", "Mutoh", "Roland", "Epilog", "Brother", "Kyocera", "Other"];
const MFIELDS = [
  ["brand", "Brand", "text"], ["model", "Model", "text"], ["serial", "Serial number", "text"],
  ["category", "Category", "text"], ["sub_category", "Sub-category", "text"], ["site", "Site", "text"],
  ["location", "Location / address", "text"], ["status", "Status", "status"],
  ["pm_interval_months", "Service every (months)", "number"], ["pm_last_done", "Last service", "date"],
  ["pm_next_due", "Next service due", "date"], ["install_date", "Install date", "date"], ["warranty_end", "Warranty ends", "date"],
  ["supervisor_id", "Vendor supervisor", "supervisor"]
];
const localIso = (d = new Date()) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
function addMonths(iso, n) {
  const d = new Date(iso + "T00:00:00"); if (isNaN(d) || !n) return null;
  d.setMonth(d.getMonth() + Number(n));
  return localIso(d);
}
function flash(node, text, ok = true) {
  node.className = ok ? "saved" : "saved msg err"; node.textContent = text;
  if (ok) setTimeout(() => { if (node.textContent === text) node.textContent = ""; }, 2500);
}
async function refreshAfterEdit() {
  const [m, a] = await Promise.all([
    sb.from("machines").select("*").eq("status", "active").order("brand").order("model"),
    sb.from("portal_access").select("client_id,email")
  ]);
  if (!m.error) state.machines = m.data;
  if (!a.error) state.access = a.data;
  const sel = $("#cfMachine"); if (sel) delete sel.dataset.ready;
}

async function renderManage(c, cell) {
  const [la, lm] = await Promise.all([
    sb.from("portal_access").select("email,full_name,role,created_at").eq("client_id", c.id).order("email"),
    sb.from("machines").select("*").eq("client_id", c.id).order("status").order("brand").order("model")
  ]);
  if (la.error || lm.error) { cell.replaceChildren(el("p", { class: "msg err" }, "Couldn't load this customer.")); return; }
  const note = el("span", { class: "saved" });

  // customer name
  const nameIn = el("input", { class: "field", value: c.name, "aria-label": "Customer name" });
  const nameForm = el("form", { class: "inline", onsubmit: async (e) => {
    e.preventDefault(); const v = nameIn.value.trim(); if (!v || v === c.name) return;
    const { error } = await sb.from("clients").update({ name: v }).eq("id", c.id);
    if (error) return flash(note, "Name not saved", false);
    c.name = v; state.clients.sort((x, y) => x.name.localeCompare(y.name)); flash(note, "Name saved");
  } }, el("label", { class: "lbl" }, "Customer name"), nameIn, el("button", { class: "btn", type: "submit" }, "Save name"),
     el("span", { class: "muted small" }, "ID " + c.id));

  // logins
  const loginRows = la.data.map((u) => {
    const rm = el("button", { class: "btn ghost small", type: "button", onclick: async () => {
      if (rm.dataset.sure !== "1") { rm.dataset.sure = "1"; rm.textContent = "Confirm remove"; rm.classList.add("danger"); return; }
      const { error } = await sb.from("portal_access").delete().eq("client_id", c.id).eq("email", u.email);
      if (error) return flash(note, "Login not removed", false);
      await refreshAfterEdit(); renderCustomers();
    } }, "Remove");
    return el("tr", {}, el("td", {}, u.email), el("td", {}, u.full_name || ""), el("td", {}, u.role === "subcontractor" ? "Sub-contractor" : "Customer"), el("td", {}, rm));
  });
  const em = el("input", { class: "field", type: "email", required: true, placeholder: "email@company.com.au", "aria-label": "Login email" });
  const fn = el("input", { class: "field", placeholder: "Name (optional)", "aria-label": "Login name" });
  const rl = el("select", { class: "field", "aria-label": "Login type" }, el("option", { value: "customer" }, "Customer"), el("option", { value: "subcontractor" }, "Sub-contractor"));
  const loginForm = el("form", { class: "inline", onsubmit: async (e) => {
    e.preventDefault();
    const email = em.value.trim().toLowerCase(); if (!email) return;
    const { error } = await sb.from("portal_access").insert({ email, client_id: c.id, full_name: fn.value.trim() || null, role: rl.value });
    if (error) return flash(note, error.code === "23505" ? "That email already has a login for this customer" : "Login not added: check the email address", false);
    await refreshAfterEdit(); renderCustomers();
  } }, em, fn, rl, el("button", { class: "btn primary", type: "submit" }, "Add login"));

  // machines
  const mForm = el("div", { class: "mform", hidden: true });
  const openMachineForm = (m) => {
    const ins = {};
    const grid = el("div", { class: "fgrid" }, ...MFIELDS.map(([k, label, type]) => {
      let input;
      if (type === "status") input = el("select", { class: "field" }, el("option", { value: "active" }, "Active"), el("option", { value: "inactive" }, "Inactive"));
      else if (type === "supervisor") input = el("select", { class: "field" }, el("option", { value: "" }, "None"), ...(state.supervisors || []).map((x) => el("option", { value: x.id }, x.name)));
      else input = el("input", { class: "field", type, min: type === "number" ? "1" : null, max: type === "number" ? "60" : null, list: k === "brand" ? "brandList" : null });
      input.value = m?.[k] ?? (k === "status" ? "active" : "");
      if (k === "model" || k === "brand") input.required = true;
      ins[k] = input;
      return el("label", { class: "f" }, el("span", {}, label), input);
    }));
    const save = el("button", { class: "btn primary", type: "submit" }, m ? "Save machine" : "Add machine");
    const cancel = el("button", { class: "btn ghost", type: "button", onclick: () => { mForm.hidden = true; mForm.replaceChildren(); } }, "Cancel");
    const f = el("form", { onsubmit: async (e) => {
      e.preventDefault();
      const row = { client_id: c.id };
      for (const [k, , type] of MFIELDS) { const v = ins[k].value.trim(); row[k] = v === "" ? null : type === "number" || type === "supervisor" ? Number(v) : v; }
      if (!row.pm_next_due && row.pm_last_done && row.pm_interval_months) row.pm_next_due = addMonths(row.pm_last_done, row.pm_interval_months);
      save.disabled = true;
      const { error } = m ? await sb.from("machines").update(row).eq("id", m.id) : await sb.from("machines").insert(row);
      save.disabled = false;
      if (error) return flash(note, "Machine not saved", false);
      await refreshAfterEdit(); renderCustomers();
    } }, el("h3", {}, m ? "Edit " + machineName(m) : "New machine"), grid,
       el("p", { class: "muted small" }, "Leave 'Next service due' empty to work it out from the last service and the interval."),
       el("div", { class: "acts" }, save, cancel));
    mForm.replaceChildren(f); mForm.hidden = false; ins.brand.focus();
  };
  const mRows = lm.data.map((m) => {
    const pm = pmStatus(m);
    return el("tr", { class: m.status === "active" ? null : "dim" },
      el("td", {}, machineName(m)), el("td", {}, m.serial || ""), el("td", {}, [m.site, m.location].filter(Boolean).join(" · ")),
      el("td", {}, m.status === "active" ? el("span", { class: "pill " + pm.cls }, m.pm_next_due ? pm.label + " · " + m.pm_next_due : pm.label) : "Inactive"),
      el("td", {}, el("button", { class: "btn ghost small", type: "button", onclick: () => openMachineForm(m) }, "Edit")));
  });

  cell.replaceChildren(el("div", { class: "manage" },
    el("datalist", { id: "brandList" }, ...BRANDS.map((b) => el("option", { value: b }))),
    nameForm, note,
    el("h3", {}, "Portal logins (" + la.data.length + ")"),
    el("p", { class: "muted small" }, "Adding a login sends nothing. The person signs in at portal.highwaydigital.com.au with this email when you tell them to."),
    la.data.length ? el("table", { class: "tbl sub" }, el("thead", {}, el("tr", {}, el("th", {}, "Email"), el("th", {}, "Name"), el("th", {}, "Type"), el("th", {}))), el("tbody", {}, ...loginRows)) : el("p", { class: "muted small" }, "No logins yet."),
    loginForm,
    el("h3", {}, "Machines (" + lm.data.length + ")"),
    lm.data.length ? el("table", { class: "tbl sub" }, el("thead", {}, el("tr", {}, el("th", {}, "Machine"), el("th", {}, "Serial"), el("th", {}, "Site"), el("th", {}, "Service"), el("th", {}))), el("tbody", {}, ...mRows)) : el("p", { class: "muted small" }, "No machines yet."),
    el("p", {}, el("button", { class: "btn", type: "button", onclick: () => openMachineForm(null) }, "+ Add machine")),
    mForm));
}

$("#addCustForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#newCustName").value.trim(); if (!name) return;
  const msg = $("#addCustMsg");
  const { data, error } = await sb.from("clients").insert({ name }).select("id,name,kb_access,vector_access,flute_access,apps_only,reports_access,catalogue_access,catalogue_brands").single();
  if (error) return flash(msg, "Customer not added", false);
  state.clients.push(data); state.clients.sort((x, y) => x.name.localeCompare(y.name));
  $("#newCustName").value = ""; $("#custSearch").value = name; state.openClient = data.id;
  flash(msg, "Added"); renderCustomers();
});

function renderContact() {
  const bl = $("#bookingLink");
  if (state.staff) { bl.href = cfg.bookingUrl; bl.target = "_blank"; }
  else { bl.href = "#book"; bl.removeAttribute("target"); }
  const sel = $("#cfMachine");
  if (!sel.dataset.ready) {
    for (const m of state.machines) sel.append(el("option", { value: m.id }, machineName(m) + (m.serial ? " · SN " + m.serial : "") + (m.site ? " · " + m.site : "")));
    sel.hidden = !state.machines.length;
    sel.dataset.ready = "1";
  }
  if (!$("#cfEmail").value && state.user) $("#cfEmail").value = state.user.email || "";
  if (!$("#cfCompany").value && state.clients.length === 1) $("#cfCompany").value = state.clients[0].name;
}

$("#cfMachine").addEventListener("change", (e) => {
  const m = state.machines.find((x) => String(x.id) === e.target.value);
  if (!m) return;
  $("#cfModel").value = machineName(m);
  $("#cfSerial").value = m.serial || "";
  const c = state.clients.find((x) => x.id === m.client_id);
  if (c) $("#cfCompany").value = c.name;
});

$("#contactForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = (id) => $("#" + id).value.trim();
  const subj = "Service enquiry" + (v("cfModel") ? ": " + v("cfModel") : "") + (v("cfSerial") ? " SN " + v("cfSerial") : "");
  const body = [
    ["Company", v("cfCompany")], ["Contact name", v("cfName")], ["Phone", v("cfPhone")], ["Email", v("cfEmail")],
    ["Equipment model", v("cfModel")], ["Serial number", v("cfSerial")], ["Fault", v("cfFault")], ["Address", v("cfAddress")]
  ].filter(([, x]) => x).map(([k, x]) => k + ": " + x).join("\n") + "\n\n" + v("cfMessage") + "\n\n(Sent from the Highway Service Desk)";
  location.href = `mailto:${cfg.contactEmail}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}`;
});


// ---------- book a service: pick a real free time; the service desk turns it into a job ----------
const KIND_HOURS = { service: 4.5, install: 4.5, fault: 2 };
const KIND_LABEL = { service: "Scheduled service", install: "Installation", fault: "Fault or repair" };
const PERTH = "Australia/Perth";
const fmtWhen = (iso, o) => new Date(iso).toLocaleString("en-AU", { timeZone: PERTH, ...o });
const dayKey = (iso) => fmtWhen(iso, { year: "numeric", month: "2-digit", day: "2-digit" });
const timeLbl = (iso) => fmtWhen(iso, { hour: "numeric", minute: "2-digit" }).replace(" ", "").toLowerCase();
const bk = { slot: null, ready: false, moving: null, earliest: null };
const perthDate = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: PERTH });   // YYYY-MM-DD
/* Scheduled services need 5 business days' notice (parts): the database works out the first day that's allowed. */
async function earliestService() {
  const today = perthDate(new Date().toISOString());
  if (bk.earliest && bk.earliest.today === today) return bk.earliest.date;
  const { data, error } = await sb.rpc("earliest_service_date");
  if (error || !data) return null;
  bk.earliest = { today, date: String(data).slice(0, 10) };
  return bk.earliest.date;
}

async function renderBook(machineId) {
  const sel = $("#bkMachine");
  if (state.staff) {
    $("#bookForm").replaceChildren(el("p", {}, "Bookings are made by customer logins. Use the service desk to book jobs, or ",
      el("a", { href: cfg.bookingUrl, target: "_blank", rel: "noopener" }, "the website booking page"), "."));
  }
  if (!bk.ready && !state.staff) {
    sel.replaceChildren(...state.machines.map((m) => el("option", { value: m.id }, machineName(m) + (m.serial ? " · SN " + m.serial : "") + (m.site ? " · " + m.site : ""))));
    for (const r of document.querySelectorAll('input[name="bkKind"]')) r.addEventListener("change", loadSlots);
    sel.addEventListener("change", () => {});
    bk.ready = true;
  }
  if (!state.staff) {
    if (machineId && state.machines.some((m) => m.id === machineId)) sel.value = machineId;
    if (!state.machines.length) { $("#bkMsg").className = "msg err"; $("#bkMsg").textContent = "There are no machines on your account yet, so online booking isn't available. Please call 1300 880 815."; }
    loadSlots();
  }
  loadBookings();
}
const bkKind = () => bk.moving ? bk.moving.kind : (document.querySelector('input[name="bkKind"]:checked') || {}).value || "service";
/* "Consumables order" needs no visit: no time to pick, the customer just describes the items. */
function bkModeUI() {
  const cons = !bk.moving && bkKind() === "consumables";
  $("#bkTimeHd").hidden = cons; $("#bkSlots").hidden = cons; if (cons) $("#bkPicked").hidden = true;
  $("#bkDescLbl").textContent = cons ? "What items do you need? (ink colours and sizes, cleaning kits, wipers, blades, part numbers if you have them, and quantities)"
    : "What's happening? (error codes, symptoms, anything we should bring)";
  $("#bkDesc").placeholder = cons ? "e.g. 2 x LUS-170 Cyan 1L, 1 x cleaning kit, 10 wipers" : "";
  $("#bkSubmit").textContent = cons ? "Send order request" : "Book this time";
  if (cons) $("#bkSubmit").disabled = false;
  return cons;
}
async function loadSlots() {
  if (bkModeUI()) return;
  const box = $("#bkSlots");
  bk.slot = null; $("#bkSubmit").disabled = true; $("#bkPicked").hidden = true;
  box.replaceChildren(el("p", { class: "muted small" }, "Loading available times…"));
  let since = new Date(Date.now() + 12 * 3600e3).toISOString(), notice = null;
  if (bkKind() === "service") {
    const first = await earliestService();
    if (first) {
      const from = new Date(first + "T00:00:00+08:00").toISOString();
      if (from > since) since = from;
      notice = el("p", { class: "muted small", style: "grid-column:1/-1;margin:0 0 6px" }, "Scheduled services need at least 5 business days' notice so we can have parts on hand. The first day you can book is ",
        el("b", {}, new Date(first + "T12:00:00+08:00").toLocaleDateString("en-AU", { timeZone: PERTH, weekday: "long", day: "numeric", month: "long" })), ".");
    }
  }
  const { data, error } = await sb.from("portal_slots").select("slot_start,slot_end").eq("hours", KIND_HOURS[bkKind()]).gt("slot_start", since).order("slot_start").limit(40);
  if (error) { box.replaceChildren(el("p", { class: "msg err" }, "Couldn't load available times. Please try again shortly.")); return; }
  if (!data.length) {
    box.replaceChildren(...[notice, el("p", { class: "muted" }, "No online times are available right now. Please call ", el("a", { href: "tel:1300880815" }, "1300 880 815"),
      " or email ", el("a", { href: "mailto:" + cfg.contactEmail }, cfg.contactEmail), " and we'll find a time.")].filter(Boolean));
    return;
  }
  const days = new Map();
  for (const s of data) { const k = dayKey(s.slot_start); if (!days.has(k)) days.set(k, []); days.get(k).push(s); }
  box.replaceChildren(...(notice ? [notice] : []), ...[...days.values()].map((list) => el("div", { class: "sday" },
    el("div", { class: "sdate" }, fmtWhen(list[0].slot_start, { weekday: "short", day: "numeric", month: "short" })),
    el("div", { class: "stimes" }, ...list.map((s) => el("button", { type: "button", class: "slot", "aria-pressed": "false", onclick: (e) => {
      for (const b of box.querySelectorAll(".slot")) b.setAttribute("aria-pressed", "false");
      e.currentTarget.setAttribute("aria-pressed", "true");
      bk.slot = s; $("#bkSubmit").disabled = false;
      const p = $("#bkPicked"); p.hidden = false;
      p.textContent = "Selected: " + fmtWhen(s.slot_start, { weekday: "long", day: "numeric", month: "long" }) + ", " + timeLbl(s.slot_start) + " to " + timeLbl(s.slot_end);
    } }, timeLbl(s.slot_start)))))));
}
async function loadBookings() {
  const box = $("#bkList");
  const { data, error } = await sb.from("portal_bookings").select("id,kind,slot_start,slot_end,status,ticket_num,note,machine_id,created_at").order("created_at", { ascending: false }).limit(10);
  if (error) { box.replaceChildren(el("p", { class: "msg err" }, "Couldn't load your bookings.")); return; }
  if (!data.length) { box.replaceChildren(el("p", { class: "muted small" }, "No bookings yet.")); return; }
  const lbl = { pending: ["Waiting for confirmation", "soon"], booked: ["Confirmed", "ok"], clash: ["We'll contact you to arrange a time", "over"], cancelled: ["Cancelled", "none"] };
  box.replaceChildren(...data.map((b) => {
    const m = state.machines.find((x) => x.id === b.machine_id);
    const [t, cls] = lbl[b.status] || [b.status, "none"];
    const live = ["pending", "booked", "clash"].includes(b.status);
    const changeable = !state.staff && live && (b.status === "clash" || new Date(b.slot_start).getTime() > Date.now() + 24 * 3600e3);
    return el("div", { class: "bkitem" + (bk.moving && bk.moving.id === b.id ? " moving" : "") },
      el("b", {}, fmtWhen(b.slot_start, { weekday: "short", day: "numeric", month: "short" }) + ", " + timeLbl(b.slot_start)),
      el("div", { class: "muted small" }, [KIND_LABEL[b.kind], m && machineName(m)].filter(Boolean).join(" · ")),
      el("span", { class: "pill " + cls }, t + (b.ticket_num && b.status === "booked" ? " · job " + b.ticket_num : "")),
      changeable ? el("button", { type: "button", class: "btn ghost small", onclick: () => startMove(b) }, b.status === "clash" ? "Pick a new time" : "Change date or time")
        : (live && !state.staff && new Date(b.slot_start).getTime() > Date.now() ? el("span", { class: "muted small" }, "Less than 24 hours away: call 1300 880 815 to change it.") : null));
  }));
}
/* Moving an existing booking: the same slot picker, for that booking's kind of visit. */
function startMove(b) {
  bk.moving = b;
  const m = state.machines.find((x) => x.id === b.machine_id);
  let bar = $("#bkMoving");
  if (!bar) { bar = el("div", { id: "bkMoving", class: "movebar" }); $("#bkSlots").before(bar); }
  bar.hidden = false;
  bar.replaceChildren(el("span", {}, "Changing your " + (KIND_LABEL[b.kind] || "booking").toLowerCase() + (m ? " for " + machineName(m) : "") + " on ",
    el("b", {}, fmtWhen(b.slot_start, { weekday: "long", day: "numeric", month: "long" }) + ", " + timeLbl(b.slot_start)), ". Pick a new time below."),
    el("button", { type: "button", class: "btn ghost small", onclick: endMove }, "Keep the current time"));
  for (const x of document.querySelectorAll("#bookForm .kinds, #bookForm .f, #bookForm .row2")) x.hidden = true;
  $("#bkSubmit").textContent = "Move my booking to this time";
  $("#bkMsg").textContent = ""; $("#bkMsg").className = "msg";
  loadSlots(); loadBookings();
  $("#bookForm").scrollIntoView({ behavior: "smooth", block: "start" });
}
function endMove() {
  bk.moving = null;
  const bar = $("#bkMoving"); if (bar) bar.hidden = true;
  for (const x of document.querySelectorAll("#bookForm .kinds, #bookForm .f, #bookForm .row2")) x.hidden = false;
  $("#bkSubmit").textContent = "Book this time";
  loadSlots(); loadBookings();
}
$("#bookForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#bkMsg"), btn = $("#bkSubmit");
  if (bk.moving) {
    if (!bk.slot) { msg.className = "msg err"; msg.textContent = "Pick a new time first."; return; }
    btn.disabled = true; msg.className = "msg"; msg.textContent = "Moving your booking…";
    const was = bk.moving, to = bk.slot;
    const { error } = await sb.rpc("reschedule_booking", { p_id: was.id, p_slot: to.slot_start });
    if (error) { msg.className = "msg err"; msg.textContent = error.message || "Couldn't move the booking."; btn.disabled = false; loadSlots(); return; }
    endMove();
    msg.className = "msg ok";
    msg.textContent = "Done. Your booking is now " + fmtWhen(to.slot_start, { weekday: "long", day: "numeric", month: "long" }) + " at " + timeLbl(to.slot_start) +
      (was.status === "pending" ? ". We'll confirm it shortly." : ". We've updated our calendar.");
    return;
  }
  const name = $("#bkName").value.trim(), phone = $("#bkPhone").value.trim();
  if (bkKind() === "consumables") {
    const items = $("#bkDesc").value.trim();
    if (!items) { msg.className = "msg err"; msg.textContent = "Describe the items you need."; $("#bkDesc").focus(); return; }
    if (!name || !phone) { msg.className = "msg err"; msg.textContent = "Please add a contact name and phone number."; return; }
    btn.disabled = true; msg.className = "msg"; msg.textContent = "Sending your order request…";
    try {
      const id = await logJob($("#bkMachine").value, { kind: "consumables", desc: items, code: "", name, phone });
      msg.className = "msg ok";
      msg.textContent = "Thanks, your consumables order request is in (request " + id + "). We'll check stock and pricing and get back to you, usually with a quote or invoice.";
      $("#bkDesc").value = "";
    } catch (err) { msg.className = "msg err"; msg.textContent = err.message || "Couldn't send the order request."; }
    btn.disabled = false;
    return;
  }
  if (!bk.slot) { msg.className = "msg err"; msg.textContent = "Pick a time first."; return; }
  if (!name || !phone) { msg.className = "msg err"; msg.textContent = "Please add a contact name and phone number."; return; }
  btn.disabled = true; msg.className = "msg"; msg.textContent = "Booking…";
  const { error } = await sb.rpc("book_slot", { p_machine: $("#bkMachine").value, p_slot: bk.slot.slot_start, p_kind: bkKind(),
    p_desc: $("#bkDesc").value.trim(), p_name: name, p_phone: phone });
  if (error) { msg.className = "msg err"; msg.textContent = error.message || "Couldn't book that time."; btn.disabled = false; loadSlots(); return; }
  msg.className = "msg ok";
  msg.textContent = "Thanks, your booking for " + fmtWhen(bk.slot.slot_start, { weekday: "long", day: "numeric", month: "long" }) + " at " + timeLbl(bk.slot.slot_start) +
    " is in. We'll confirm it shortly and it will show a job number under Your bookings.";
  $("#bkDesc").value = "";
  loadSlots(); loadBookings();
});

// ---------- customers add their own machines, scan the serial plate, set a service schedule, log jobs ----------
const PLATE_BRANDS = ["Mimaki", "Mutoh", "Roland", "Epilog", "Brother", "Kyocera", "Graphtec", "Summa", "Epson", "Canon", "HP", "Ricoh", "Lanier", "Trotec", "Tajima", "Alfex", "Agfa", "Fujifilm", "Ricoh", "Gerber", "Zund", "Stika"];
const PLATE_MODELS = ["UCJV300-160", "UCJV330-160", "CJV150-160", "CJV150-130", "CJV150-107", "CJV300-160", "CJV330-160", "JV300-160", "JV330-160", "JV150-160", "JV100-160", "TS100-1600", "TS330-1600", "TS55-1800", "TxF150-75", "TxF300-75", "UJF-3042MkII", "UJF-3042MkIIe", "UJF-6042MkII", "UJF-7151plusII", "JFX200-2513", "JFX200-2513EX", "JFX600-2513", "UJV100-160", "UJV55-320", "CG-60AR", "CG-130AR", "CG-130FXII", "CG-160FXII", "CG-75FXII", "CFL-605RT", "XpertJet 1641SR", "XpertJet 1682SR", "XpertJet 1462UF", "XPJ-661", "VJ-1638", "VJ-1624X", "VJ-628", "TrueVIS VG2-540", "TrueVIS SG2-540", "VersaUV LEF2-200", "Helix 24", "Fusion Pro 32", "Fusion Pro 48", "Fusion Edge", "Zing 24", "Mini 24", "GTX-422", "GTXpro", "PR1055X", "PR680W", "PR1050X"];
const MACHINE_TYPES = ["Sign printer", "Print & cut", "Flatbed UV printer", "Direct-to-film / textile printer", "Cutter / plotter", "Laser engraver", "Embroidery machine", "CNC router", "Office printer / copier", "Other"];
const compact = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const JOB_KINDS = [["fault", "Fault or repair"], ["service", "Scheduled service"], ["install", "Installation"], ["consumables", "Consumables order"], ["other", "Something else"]];
const isCustomer = () => !state.staff && state.clients.length > 0 && !isVendorOnly();

function knownModels() {
  return [...new Set([...PLATE_MODELS, ...state.machines.map((m) => m.model).filter(Boolean)])];
}
/* Read the plate text: brand, model and serial. Labels first (MODEL / SERIAL No. / S/N), then known model names. */
function parsePlate(text, codes = []) {
  const raw = String(text || "").replace(/[|]/g, "I");
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = { brand: "", model: "", serial: "", found: [] };
  const up = raw.toUpperCase();
  for (const b of PLATE_BRANDS) if (new RegExp("\\b" + b.toUpperCase() + "\\b").test(up)) { out.brand = b; break; }
  const clean = (v) => String(v || "").replace(/^[\s.:#=\-–]+/, "").replace(/[\s.,;:]+$/, "").trim();
  const grab = (re) => { for (const l of lines) { const m = l.match(re); if (m && clean(m[1]).length >= 3) return clean(m[1]); } return ""; };
  out.serial = grab(/(?:SERIAL\s*(?:NO|NUMBER|N[O0]\.?|#)?|S\s*\/\s*N|SER\.?\s*NO|MFG\.?\s*NO|PRODUCT\s*NO)\b\.?\s*[:.#]?\s*([A-Z0-9][A-Z0-9\-\/]{3,24})/i);
  out.model = grab(/(?:MODEL|MOD\.|TYPE)\s*(?:NO\.?|NAME|NUMBER)?\s*[:.#]?\s*([A-Z0-9][A-Z0-9\-\/+ ]{1,26}?)(?=\s{2,}|\s+(?:SERIAL|S\/N|INPUT|POWER|RATED|\d+\s*V)|$)/i);
  // A known model name anywhere on the plate beats a guess
  const cu = compact(raw);
  const hits = knownModels().filter((m) => compact(m).length >= 4 && cu.includes(compact(m))).sort((a, b) => compact(b).length - compact(a).length);
  if (hits.length && (!out.model || !compact(hits[0]).includes(compact(out.model)) || compact(hits[0]).length > compact(out.model).length)) out.model = hits[0];
  if (!out.brand && out.model) { const m = state.machines.find((x) => compact(x.model) === compact(out.model)); if (m) out.brand = m.brand || ""; }
  if (!out.brand && /^(UCJV|CJV|JV|TS\d|TXF|UJF|JFX|UJV|CG-)/i.test(out.model)) out.brand = "Mimaki";
  if (!out.brand && /^(XPERTJET|XPJ|VJ-)/i.test(out.model)) out.brand = "Mutoh";
  if (!out.brand && /^(HELIX|FUSION|ZING|MINI \d)/i.test(out.model)) out.brand = "Epilog";
  // Barcodes on the plate usually hold the serial number
  const bc = codes.map((c) => String(c).trim()).filter((c) => /^[A-Z0-9\-\/]{5,24}$/i.test(c));
  if (bc.length) {
    const s = bc.find((c) => out.serial && (compact(c).includes(compact(out.serial)) || compact(out.serial).includes(compact(c)))) || bc[0];
    if (!out.serial || compact(s).length >= compact(out.serial).length) out.serial = s;
  }
  if (out.model && out.serial && compact(out.model) === compact(out.serial)) out.serial = "";
  for (const k of ["brand", "model", "serial"]) if (out[k]) out.found.push(k);
  return out;
}
async function loadOcr() {
  if (window.Tesseract) return window.Tesseract;
  await new Promise((ok, no) => { const s = el("script", { src: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js" }); s.onload = ok; s.onerror = no; document.head.append(s); });
  return window.Tesseract;
}
async function prepImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const x = c.getContext("2d"); x.drawImage(bmp, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height), p = d.data;
  for (let i = 0; i < p.length; i += 4) { const g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]; const v = Math.max(0, Math.min(255, (g - 128) * 1.5 + 128)); p[i] = p[i + 1] = p[i + 2] = v; }
  x.putImageData(d, 0, 0);
  return { canvas: c, bmp };
}
async function readPlate(file, onStatus) {
  const { canvas, bmp } = await prepImage(file);
  let codes = [];
  if ("BarcodeDetector" in window) {
    try { const det = new window.BarcodeDetector(); codes = (await det.detect(bmp)).map((b) => b.rawValue).filter(Boolean); } catch (e) {}
  }
  onStatus("Reading the plate…");
  const T = await loadOcr();
  const r = await T.recognize(canvas, "eng", { logger: (m) => { if (m.status === "recognizing text") onStatus("Reading the plate… " + Math.round((m.progress || 0) * 100) + "%"); } });
  return { ...parsePlate(r?.data?.text || "", codes), text: r?.data?.text || "", codes };
}

function scheduleFields(m = {}) {
  const iv = el("select", { class: "field", id: "amIv" },
    el("option", { value: "" }, "Not sure yet: suggest one for me"),
    ...[3, 4, 6, 12, 24].map((n) => el("option", { value: n }, "Every " + n + " months")));
  iv.value = m.pm_interval_months || "";
  const last = el("input", { class: "field", type: "date", id: "amLast", value: m.pm_last_done || "" });
  const next = el("input", { class: "field", type: "date", id: "amNext", value: m.pm_next_due || "" });
  const hint = el("p", { class: "muted small" });
  let nextTouched = !!m.pm_next_due;
  const calc = () => {
    const n = Number(iv.value);
    if (!n) { hint.textContent = "We'll recommend a schedule for this model when we check it."; if (!nextTouched) next.value = ""; return; }
    if (!nextTouched) {
      const base = last.value || $("#amInst")?.value || localIso();
      let d = addMonths(base, n); const today = localIso();
      while (d && d < today) d = addMonths(d, n);
      next.value = d || "";
    }
    hint.textContent = next.value ? "First service due " + fmtDate(next.value) + ", then every " + n + " months. We'll remind you and you can book it here." : "";
  };
  iv.addEventListener("change", () => { nextTouched = false; calc(); }); last.addEventListener("change", () => { nextTouched = false; calc(); });
  next.addEventListener("input", () => { nextTouched = !!next.value; calc(); });
  setTimeout(calc, 0);
  return { node: el("div", { class: "stack" },
    el("div", { class: "row3" },
      el("label", { class: "f" }, el("span", {}, "How often should it be serviced?"), iv),
      el("label", { class: "f" }, el("span", {}, "Last serviced (if known)"), last),
      el("label", { class: "f" }, el("span", {}, "Next service due"), next)),
    hint), get: () => ({ pm_interval_months: iv.value || null, pm_last_done: last.value || null, pm_next_due: next.value || null }), recalc: calc };
}
function jobFields(prefix) {
  const kind = el("select", { class: "field", id: prefix + "Kind" }, ...JOB_KINDS.map(([k, l]) => el("option", { value: k }, l)));
  const desc = el("textarea", { class: "field", id: prefix + "Desc", rows: 4, placeholder: "What's happening? Symptoms, when it started, anything we should bring" });
  const code = el("input", { class: "field mono", id: prefix + "Code", placeholder: "e.g. 302 or C6600" });
  const name = el("input", { class: "field", id: prefix + "Name", autocomplete: "name" });
  const phone = el("input", { class: "field", id: prefix + "Phone", type: "tel", autocomplete: "tel" });
  try { const c = JSON.parse(localStorage.getItem("hd_contact") || "{}"); name.value = c.name || ""; phone.value = c.phone || ""; } catch (e) {}
  return { node: el("div", { class: "stack" },
    el("div", { class: "row2" }, el("label", { class: "f" }, el("span", {}, "What do you need?"), kind), el("label", { class: "f" }, el("span", {}, "Error code (if any)"), code)),
    el("label", { class: "f" }, el("span", {}, "Details*"), desc),
    el("div", { class: "row2" }, el("label", { class: "f" }, el("span", {}, "Contact name*"), name), el("label", { class: "f" }, el("span", {}, "Phone*"), phone))),
    get: () => ({ kind: kind.value, desc: desc.value.trim(), code: code.value.trim(), name: name.value.trim(), phone: phone.value.trim() }),
    check: () => !desc.value.trim() ? (desc.focus(), "Tell us what's happening with the machine.") : !name.value.trim() ? (name.focus(), "Add a contact name.") : !phone.value.trim() ? (phone.focus(), "Add a phone number.") : "" };
}
async function logJob(machineId, j) {
  try { localStorage.setItem("hd_contact", JSON.stringify({ name: j.name, phone: j.phone })); } catch (e) {}
  state.jobs = null;
  const { data, error } = await sb.rpc("portal_log_job", { p_machine: machineId, p_kind: j.kind, p_desc: j.desc, p_code: j.code, p_name: j.name, p_phone: j.phone });
  if (error) throw new Error(error.message || "Couldn't log the job");
  return data;
}

function renderAddMachine() {
  const v = $("#view-add");
  if (!isCustomer()) { v.replaceChildren(el("div", { class: "card empty" }, "Staff add machines from Customers.")); return; }
  const st = el("p", { class: "msg", role: "status" });
  const f = {};
  const inp = (k, attrs = {}) => (f[k] = el("input", { class: "field", id: "am_" + k, ...attrs }));
  const brandList = el("datalist", { id: "amBrands" }, ...[...new Set([...PLATE_BRANDS, ...state.machines.map((m) => m.brand).filter(Boolean)])].map((b) => el("option", { value: b })));
  const modelList = el("datalist", { id: "amModels" }, ...knownModels().map((m) => el("option", { value: m })));
  const type = (f.category = el("select", { class: "field", id: "am_category" }, el("option", { value: "" }, "Choose…"), ...MACHINE_TYPES.map((t) => el("option", { value: t }, t))));
  const acct = state.clients.length > 1 ? el("select", { class: "field", id: "amClient" }, ...state.clients.map((c) => el("option", { value: c.id }, c.name))) : null;
  const sched = scheduleFields();
  const job = jobFields("amJ");
  const jobOn = el("input", { type: "checkbox", id: "amJobOn" });
  const jobBox = el("div", { hidden: true }, job.node);
  jobOn.addEventListener("change", () => { jobBox.hidden = !jobOn.checked; });

  // Scan the serial plate
  const file = el("input", { type: "file", accept: "image/*", capture: "environment", hidden: true, id: "amPlate" });
  const prev = el("img", { class: "plateprev", alt: "Serial plate photo", hidden: true });
  const scanMsg = el("p", { class: "muted small", role: "status" }, "Take a clear, straight-on photo of the plate (usually on the back or side of the machine). We'll fill in the brand, model and serial number for you to check.");
  const scanBtn = el("button", { class: "btn primary", type: "button", onclick: () => file.click() }, "📷 Scan serial plate");
  file.addEventListener("change", async () => {
    const fl = file.files && file.files[0]; if (!fl) return;
    prev.src = URL.createObjectURL(fl); prev.hidden = false;
    scanBtn.disabled = true; scanMsg.className = "muted small"; scanMsg.textContent = "Getting the reader ready…";
    try {
      const r = await readPlate(fl, (t) => (scanMsg.textContent = t));
      const set = [];
      for (const k of ["brand", "model", "serial"]) if (r[k]) { f[k].value = r[k]; f[k].classList.add("filled"); set.push(k); }
      if (r.model && !f.category.value) { const like = state.machines.find((x) => compact(x.model) === compact(r.model)); if (like?.category) f.category.value = MACHINE_TYPES.find((t) => norm(t) === norm(like.category)) || ""; }
      scanMsg.className = set.length ? "msg ok" : "msg err";
      scanMsg.textContent = set.length ? "Filled in " + set.join(", ") + " from the plate. Please check them against the plate before saving." : "We couldn't read the plate. Try again closer, with no glare, or type the details in.";
      raw.textContent = r.text ? "Text read from the plate:\n" + r.text.trim() + (r.codes.length ? "\nBarcode: " + r.codes.join(", ") : "") : ""; rawWrap.hidden = !r.text;
    } catch (e) { scanMsg.className = "msg err"; scanMsg.textContent = "The plate reader couldn't start on this device. Type the details in instead."; }
    scanBtn.disabled = false; file.value = "";
  });
  const raw = el("pre", { class: "plateraw" }), rawWrap = el("details", { hidden: true }, el("summary", { class: "muted small" }, "What we read"), raw);
  ["brand", "model", "serial"].forEach((k) => setTimeout(() => f[k].addEventListener("input", () => f[k].classList.remove("filled")), 0));

  const save = el("button", { class: "btn primary send", type: "submit" }, "Add machine");
  const form = el("form", { class: "card bookform addm", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    const row = { brand: f.brand.value.trim(), model: f.model.value.trim(), serial: f.serial.value.trim(), category: f.category.value,
      site: f.site.value.trim(), location: f.location.value.trim(), install_date: f.install_date.value || null, ink_set: f.ink_set.value.trim(), ...sched.get() };
    row.client_id = acct ? acct.value : state.clients[0]?.id;
    if (!row.model) { st.className = "msg err"; st.textContent = "Add the model (scan the plate or type it in)."; f.model.focus(); return; }
    let j = null;
    if (jobOn.checked) { const err = job.check(); if (err) { st.className = "msg err"; st.textContent = err; return; } j = job.get(); }
    save.disabled = true; st.className = "msg"; st.textContent = "Saving…";
    const { data: id, error } = await sb.rpc("portal_add_machine", { p: row });
    if (error) { save.disabled = false; st.className = "msg err"; st.textContent = error.message || "Couldn't add the machine."; return; }
    let jobNote = "";
    if (j) { try { await logJob(id, j); jobNote = " and your job is logged"; } catch (er) { jobNote = ", but the job didn't go through: " + er.message; } }
    const { data: ms } = await sb.from("machines").select("*").eq("status", "active").order("brand").order("model");
    if (ms) state.machines = ms;
    state.flash = "Machine added" + jobNote + ". We'll check the details and add it to your service plan.";
    location.hash = "#machine/" + encodeURIComponent(id);
  } },
    el("h2", {}, "1. Machine details"),
    el("div", { class: "scanbox" }, scanBtn, file, scanMsg, prev, rawWrap),
    acct && el("label", { class: "f" }, el("span", {}, "Account"), acct),
    el("div", { class: "row3" },
      el("label", { class: "f" }, el("span", {}, "Brand"), inp("brand", { list: "amBrands", placeholder: "e.g. Mimaki", autocomplete: "off" })),
      el("label", { class: "f" }, el("span", {}, "Model*"), inp("model", { list: "amModels", placeholder: "e.g. UCJV300-160", autocomplete: "off", required: true })),
      el("label", { class: "f" }, el("span", {}, "Serial number"), inp("serial", { class: "field mono", placeholder: "From the plate", autocomplete: "off" }))),
    brandList, modelList,
    el("div", { class: "row3" },
      el("label", { class: "f" }, el("span", {}, "Type of machine"), type),
      el("label", { class: "f" }, el("span", {}, "Installed (if known)"), inp("install_date", { type: "date", id: "amInst" })),
      el("label", { class: "f" }, el("span", {}, "Ink set (if a printer)"), inp("ink_set", { placeholder: "e.g. CMYK + White" }))),
    el("div", { class: "row2" },
      el("label", { class: "f" }, el("span", {}, "Site name"), inp("site", { placeholder: "e.g. Head office, Factory 2" })),
      el("label", { class: "f" }, el("span", {}, "Address where the machine is"), inp("location", { placeholder: "Street, suburb", autocomplete: "street-address" }))),
    el("h2", {}, "2. Service schedule"),
    sched.node,
    el("h2", {}, "3. Need a job done on it?"),
    el("label", { class: "chk" }, jobOn, " Log a job for this machine now"),
    jobBox,
    save, st);
  f.install_date.addEventListener("change", sched.recalc);
  v.replaceChildren(el("button", { class: "btn back", type: "button", onclick: () => (location.hash = "#machines") }, "← All machines"),
    el("div", { class: "head" }, el("h1", {}, "Add a machine")), form);
}

/* Machine page extras: log a job, your jobs, and the schedule for machines the customer added */
async function machineExtras(m, host) {
  if (!isCustomer()) return;
  const jobs = el("div", { class: "stack" }, el("p", { class: "muted small" }, "Loading…"));
  const job = jobFields("mj");
  const st = el("p", { class: "msg", role: "status" });
  const send = el("button", { class: "btn primary", type: "submit" }, "Log job");
  const form = el("form", { class: "bookform", hidden: true, novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); const err = job.check(); if (err) { st.className = "msg err"; st.textContent = err; return; }
    send.disabled = true; st.className = "msg"; st.textContent = "Sending…";
    try { await logJob(m.id, job.get()); st.className = "msg ok"; st.textContent = "Thanks, your job is logged. We'll call you to arrange a time, and it gets a job number below."; form.querySelector("textarea").value = ""; loadJobs(); }
    catch (er) { st.className = "msg err"; st.textContent = er.message; }
    send.disabled = false;
  } }, job.node, el("div", { class: "acts" }, send, el("a", { class: "btn ghost", href: "#book/" + encodeURIComponent(m.id) }, "Or pick a time instead")));
  const open = el("button", { class: "btn primary", type: "button", onclick: () => { form.hidden = !form.hidden; if (!form.hidden) form.querySelector("textarea").focus(); } }, "Log a job");
  const lbl = { pending: ["Waiting for us", "soon"], created: ["Job created", "ok"], cancelled: ["Cancelled", "none"] };
  async function loadJobs() {
    const { data, error } = await sb.from("portal_jobs").select("id,kind,description,status,ticket_num,created_at").eq("machine_id", m.id).order("created_at", { ascending: false }).limit(10);
    if (error) { jobs.replaceChildren(el("p", { class: "msg err" }, "Couldn't load your jobs.")); return; }
    jobs.replaceChildren(...(data.length ? data.map((j) => { const [t, c] = lbl[j.status] || [j.status, "none"];
      return el("div", { class: "bkitem" }, el("b", {}, new Date(j.created_at).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) + " · " + (Object.fromEntries(JOB_KINDS)[j.kind] || j.kind)),
        el("div", { class: "muted small" }, String(j.description || "").slice(0, 160)),
        el("span", { class: "pill " + c }, t + (j.ticket_num ? " · job " + j.ticket_num : ""))); })
      : [el("p", { class: "muted small" }, "No jobs logged from the portal for this machine yet.")]));
  }
  const cards = [el("div", { class: "card", style: "margin-top:14px" }, el("div", { class: "bhead" }, el("h2", {}, "Jobs"), open), form, st, jobs)];
  if (m.added_via === "portal") {
    const sched = scheduleFields(m), ss = el("p", { class: "msg", role: "status" });
    const sv = el("button", { class: "btn", type: "submit" }, "Save schedule");
    cards.push(el("form", { class: "card bookform", style: "margin-top:14px", onsubmit: async (e) => {
      e.preventDefault(); const s = sched.get(); sv.disabled = true;
      const { error } = await sb.rpc("portal_set_schedule", { p_machine: m.id, p_interval: s.pm_interval_months ? Number(s.pm_interval_months) : null, p_last: s.pm_last_done, p_next: s.pm_next_due });
      sv.disabled = false;
      if (error) { ss.className = "msg err"; ss.textContent = error.message; return; }
      const { data: ms } = await sb.from("machines").select("*").eq("status", "active").order("brand").order("model"); if (ms) state.machines = ms;
      state.flash = "Service schedule saved."; renderMachine(m.id);
    } }, el("h2", {}, "Service schedule"), el("p", { class: "muted small" }, "You added this machine, so you can set how often it's serviced. We'll confirm it when we check the machine."), sched.node, el("div", { class: "acts" }, sv), ss));
  }
  host.append(...cards);
  loadJobs();
}

// ---------- vendor supervisors (e.g. Avery Dennison): fleet view and fleet reports ----------
const isSupervisor = () => !state.staff && (state.supervisors || []).length > 0;
const supName = () => (state.supervisors || []).map((s) => s.name).join(", ");
// A vendor login (scope "invoiced") sees only the jobs invoiced to it; a supervisor (scope "fleet") sees whole customer fleets.
const isVendorOnly = () => isSupervisor() && state.supervisors.every((s) => s.scope === "invoiced");
const money = (n) => "$" + (Number(n) || 0).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const KIND_NAMES = { service: "Service visit", install: "Installation", parts: "Parts order", consumables: "Consumables order", fault: "Fault or repair", other: "Other" };
const rep = { data: null, loading: null, f: { from: "", to: "", client: "", machine: "", q: "", tab: "jobs" } };

/* Supabase returns at most 1000 rows per request: page through the rest. */
async function allRows(q) {
  const out = []; const N = 1000;
  for (let i = 0; i < 50; i++) {
    const { data, error } = await q().range(i * N, i * N + N - 1);
    if (error) return { data: null, error };
    out.push(...(data || [])); if (!data || data.length < N) break;
  }
  return { data: out, error: null };
}
async function loadReportData(force) {
  if (rep.data && !force) return rep.data;
  if (rep.loading) return rep.loading;
  rep.loading = (async () => {
    const [sr, tj, pj] = await Promise.all([
      allRows(() => sb.from("service_records").select("id,client_id,machine_id,number,issued,status,kind,po,notes,total_ex,total_inc,lines").order("issued", { ascending: false }).order("id")),
      sb.rpc("report_jobs"),
      sb.from("portal_jobs").select("id,client_id,machine_id,kind,description,error_code,status,ticket_num,created_at").order("created_at", { ascending: false })
    ]);
    if (sr.error) throw sr.error;
    if (tj.error) throw tj.error;
    const jobs = [];
    // Invoiced history (FreshBooks)
    for (const r of sr.data || []) {
      const lines = (r.lines || []).filter((l) => !/^(reports?|delivery)$/i.test(l.code || "") || Number(l.amount));
      const labour = lines.find((l) => /labou?r|day rate|hourly/i.test(l.code || ""));
      jobs.push({ key: "inv-" + r.id, ref: "Invoice " + r.number, number: r.number, date: r.issued, client_id: r.client_id, machine_id: r.machine_id, kind: r.kind,
        title: r.po || (labour ? String(labour.desc || "").split("\n")[0] : "") || KIND_NAMES[r.kind], notes: r.notes || "",
        detail: labour ? labour.desc : "", lines, amount: Number(r.total_ex) || 0, status: r.status, src: "invoice" });
    }
    // Open and recent service desk jobs (not yet on an invoice)
    const invoiced = new Set((sr.data || []).map((r) => String(r.number).replace(/^0+/, "")));
    for (const t of tj.data || []) {
      const lines = (t.lines || []).map((l) => ({ code: l.code, desc: l.desc, qty: Number(l.qty) || 0, unit: Number(l.unit) || 0, amount: (Number(l.qty) || 0) * (Number(l.unit) || 0) }));
      jobs.push({ key: "t-" + t.num, ref: "Job " + t.num, date: t.created, client_id: t.client_id, machine_id: t.machine_id,
        kind: t.subtype === "installation" ? "install" : t.subtype === "pm" ? "service" : t.type === "incident" ? "fault" : "other",
        title: t.summary || "", notes: [t.description, t.error_code && "Error " + t.error_code].filter(Boolean).join(" · "), detail: t.notes || "",
        lines, amount: lines.reduce((s, l) => s + l.amount, 0), status: t.status, src: "ticket", error: t.error_code || "",
        num: t.num, type: t.type, subtype: t.subtype, created: t.created, completed: t.completed || "", bill_to: t.bill_to || "Customer", channel: t.channel || "", warranty: !!t.warranty, customer: t.customer || "" });
    }
    for (const j of pj.data || []) if (j.status === "pending")
      jobs.push({ key: "p-" + j.id, ref: "Logged in portal", date: String(j.created_at).slice(0, 10), client_id: j.client_id, machine_id: j.machine_id,
        kind: j.kind, title: String(j.description || "").split("\n")[0], notes: j.description || "", detail: "", lines: [], amount: 0, status: "waiting", src: "portal", error: j.error_code || "" });
    jobs.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    rep.data = { jobs, invoicedCount: invoiced.size, tickets: tj.data || [] };
    return rep.data;
  })();
  try { return await rep.loading; } finally { rep.loading = null; }
}

const cName = (id) => state.clients.find((c) => c.id === id)?.name || "Not matched to a customer";
const mOf = (id) => state.machines.find((m) => m.id === id);
const mLabel = (id) => { const m = mOf(id); return m ? machineName(m) + (m.serial ? " · SN " + m.serial : "") : ""; };
function repFiltered() {
  const f = rep.f, q = norm(f.q);
  return rep.data.jobs.filter((j) => (!f.from || j.date >= f.from) && (!f.to || j.date <= f.to) &&
    (!f.client || String(j.client_id) === f.client) && (!f.machine || j.machine_id === f.machine) &&
    (!q || norm([j.ref, j.title, j.notes, j.detail, cName(j.client_id), mLabel(j.machine_id), ...j.lines.map((l) => l.code + " " + l.desc)].join(" ")).includes(q)));
}
/* Download menu for report tables: Excel, CSV or PDF (name may end in .csv; rows[0] is the header row). */
function dlMenu(name, getRows) {
  const base = String(name).replace(/\.csv$/i, "");
  const go = (fmt) => async (e) => { e.preventDefault(); dd.open = false;
    try { const rows = getRows(); await exportTable(fmt, base, base, rows[0], rows.slice(1)); } catch (er) { console.error(er); } };
  const dd = el("details", { class: "xmenu" }, el("summary", { class: "btn small" }, "Download ▾"),
    el("div", { class: "xpanel" }, el("button", { type: "button", class: "xopt", onclick: go("xlsx") }, "Excel (.xlsx)"),
      el("button", { type: "button", class: "xopt", onclick: go("csv") }, "CSV"), el("button", { type: "button", class: "xopt", onclick: go("pdf") }, "PDF")));
  document.addEventListener("click", (e) => { if (dd.open && !dd.contains(e.target)) dd.open = false; });
  return dd;
}
function csvDownload(name, rows) {
  const csv = rows.map((r) => r.map((c) => { c = String(c ?? ""); return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
  const a = el("a", { href: url, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const isPart = (l) => /\d/.test(l.code || "") && !/\s{1,}/.test(String(l.code || "").trim()) && !/labou?r|callout|delivery|report|flight|hotel|accommodation|car hire|day rate|shipping/i.test(l.code || "");
const monthKey = (d) => String(d || "").slice(0, 7);
const monthLbl = (k) => { const [y, m] = k.split("-"); return new Date(+y, +m - 1, 1).toLocaleDateString("en-AU", { month: "short", year: "2-digit" }); };

async function renderReports() {
  const v = $("#view-reports");
  if (!state.reportsAccess) { v.replaceChildren(el("div", { class: "card empty" }, "Reports aren't turned on for your account. Contact hello@highwaydigital.com.au if you'd like them.")); return; }
  if (state.staff && rep.f.tab === "jobs" && !rep.staffTabSet) { rep.staffTabSet = true; rep.f.tab = "desk"; }
  v.replaceChildren(el("div", { class: "head" }, el("h1", {}, "Reports")), el("div", { class: "card center" }, el("span", { class: "spin" }), " Loading service history…"));
  try { await loadReportData(); } catch (e) { v.replaceChildren(el("div", { class: "card msg err" }, "Couldn't load the reports: " + (e.message || e))); return; }
  drawReports();
}
function drawReports() {
  const v = $("#view-reports"), f = rep.f;
  const jobs = repFiltered();
  const clientsUsed = [...new Set(rep.data.jobs.map((j) => j.client_id).concat(state.machines.map((m) => m.client_id)))].filter(Boolean)
    .map((id) => [String(id), cName(id)]).sort((a, b) => a[1].localeCompare(b[1]));
  const machinesUsed = state.machines.filter((m) => !f.client || String(m.client_id) === f.client);
  const ctl = (node, k, ev = "change") => { node.addEventListener(ev, () => { f[k] = node.value; if (k === "client") f.machine = ""; drawReports(); if (ev === "input") { const n = $("#rq"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }); return node; };
  const preset = (label, months) => el("button", { class: "btn small ghost", type: "button", onclick: () => { if (!months) { f.from = ""; f.to = ""; } else { const d = new Date(); d.setMonth(d.getMonth() - months); f.from = localIso(d); f.to = ""; } drawReports(); } }, label);
  const filters = el("div", { class: "card rfilters" },
    el("label", { class: "f" }, el("span", {}, "Customer"), ctl(el("select", { class: "field" }, el("option", { value: "" }, "All customers"), ...clientsUsed.map(([id, n]) => el("option", { value: id, selected: f.client === id }, n))), "client")),
    el("label", { class: "f" }, el("span", {}, "Machine"), ctl(el("select", { class: "field" }, el("option", { value: "" }, "All machines"), ...machinesUsed.map((m) => el("option", { value: m.id, selected: f.machine === m.id }, machineName(m) + (m.serial ? " · " + m.serial : "") + (f.client ? "" : " · " + cName(m.client_id))))), "machine")),
    el("label", { class: "f" }, el("span", {}, "From"), ctl(el("input", { class: "field", type: "date", value: f.from }), "from")),
    el("label", { class: "f" }, el("span", {}, "To"), ctl(el("input", { class: "field", type: "date", value: f.to }), "to")),
    el("label", { class: "f grow" }, el("span", {}, "Search"), ctl(el("input", { class: "field", id: "rq", type: "search", value: f.q, placeholder: "Part number, fault, customer…" }), "q", "input")),
    el("div", { class: "presets" }, preset("Last 3 months", 3), preset("Last 12 months", 12), preset("All time", 0)));

  const spend = jobs.reduce((s, j) => s + j.amount, 0);
  const cnt = (k) => jobs.filter((j) => j.kind === k).length;
  const fleet = state.machines.filter((m) => (!f.client || String(m.client_id) === f.client) && (!f.machine || m.id === f.machine));
  const overdue = fleet.filter((m) => pmStatus(m).cls === "over").length;
  const kpis = el("div", { class: "stats" },
    ...[[jobs.length, "Jobs"], [cnt("service") + cnt("fault"), "Service visits & repairs"], [cnt("install"), "Installations"], [cnt("parts"), "Parts orders"],
        [money(spend), "Billed ex GST"], [fleet.length, "Machines"], ...(state.hideSchedule ? [] : [[overdue, "PM overdue"]])]
      .map(([n, l]) => el("div", { class: "stat" }, el("div", { class: "n" }, n), el("div", { class: "l" }, l))));

  const tabs = [...(state.staff ? [["desk", "Service desk overview"]] : []), ["assets", "Assets"], ["machines", "Usage by machine"], ["jobs", "Service history"], ["parts", "Parts used"], ["trends", "Trends"]];
  const tabBar = el("div", { class: "rtabs", role: "tablist" }, ...tabs.map(([k, l]) => el("button", { type: "button", role: "tab", class: "chipbtn", "aria-selected": String(f.tab === k), onclick: () => { f.tab = k; drawReports(); } }, l)));
  const body = f.tab === "parts" ? partsReport(jobs) : f.tab === "trends" ? trendsReport(jobs) : f.tab === "machines" ? machineReport(jobs, fleet)
    : f.tab === "assets" ? assetsReport(fleet, jobs) : f.tab === "desk" && state.staff ? deskReport(jobs, fleet) : jobsReport(jobs);
  v.replaceChildren(
    el("div", { class: "head" }, el("h1", {}, "Reports"), el("span", { class: "muted small" }, state.staff ? "Whole service desk" : isSupervisor() ? supName() : state.clients.map((c) => c.name).join(", "))),
    el("p", { class: "muted small" }, state.staff
      ? "Every customer, machine and job in the service desk, with invoices from FreshBooks. Every table downloads as Excel, CSV or PDF. Amounts are ex GST."
      : isSupervisor()
        ? "Jobs billed to " + supName() + " (Bill to " + supName() + "), for any customer: invoices from our accounts and open service desk jobs, with the machines they were on. Every table downloads as Excel, CSV or PDF. Amounts are ex GST."
        : "Your machines, their service history and usage, from our service desk and invoices. Every table downloads as Excel, CSV or PDF. Amounts are ex GST."),
    ...[filters, f.tab === "desk" ? null : kpis, tabBar, body].filter(Boolean));
}
function jobsReport(jobs) {
  const rows = jobs.map((j) => {
    const det = el("tr", { class: "rdet", hidden: true }, el("td", { colspan: 7 },
      j.notes ? el("p", {}, j.notes) : null, j.detail ? el("pre", { class: "rpre" }, j.detail) : null,
      j.lines.length ? el("table", { class: "tbl sub" }, el("thead", {}, el("tr", {}, el("th", {}, "Item"), el("th", {}, "Description"), el("th", { class: "num" }, "Qty"), el("th", { class: "num" }, "Amount"))),
        el("tbody", {}, ...j.lines.map((l) => el("tr", {}, el("td", { class: "mono" }, l.code), el("td", {}, String(l.desc || "").split("\n")[0]), el("td", { class: "num" }, l.qty), el("td", { class: "num" }, l.amount ? money(l.amount) : ""))))) : null));
    const tr = el("tr", { class: "rrow", tabindex: 0, onclick: () => { det.hidden = !det.hidden; } },
      el("td", { "data-l": "Date" }, fmtDate(j.date)), el("td", { "data-l": "Ref" }, j.ref), el("td", { "data-l": "Customer" }, cName(j.client_id)),
      el("td", { "data-l": "Machine" }, mLabel(j.machine_id) || "—"), el("td", { "data-l": "Type" }, KIND_NAMES[j.kind] || j.kind),
      el("td", { "data-l": "Job" }, j.title), el("td", { class: "num", "data-l": "Amount" }, j.amount ? money(j.amount) : ""));
    return [tr, det];
  }).flat();
  return el("div", { class: "card" },
    el("div", { class: "bhead" }, el("h2", {}, "Service history (" + jobs.length + ")"),
      dlMenu("Service history.csv", () => [["Date", "Ref", "Customer", "Machine", "Type", "Job", "Notes", "Parts", "Amount ex GST"],
        ...jobs.map((j) => [j.date, j.ref, cName(j.client_id), mLabel(j.machine_id), KIND_NAMES[j.kind] || j.kind, j.title, j.notes, j.lines.filter(isPart).map((l) => l.qty + "x " + l.code).join("; "), j.amount.toFixed(2)])])),
    jobs.length ? el("div", { class: "tscroll" }, el("table", { class: "tbl rtbl" }, el("thead", {}, el("tr", {}, ...["Date", "Ref", "Customer", "Machine", "Type", "Job", "Amount"].map((h) => el("th", { class: h === "Amount" ? "num" : null }, h)))), el("tbody", {}, ...rows)))
      : el("p", { class: "muted small" }, "No jobs match these filters."),
    el("p", { class: "muted small" }, "Click a job to see the work notes and every line on it."));
}
function partsReport(jobs) {
  const by = new Map();
  for (const j of jobs) for (const l of j.lines) {
    if (!isPart(l)) continue;
    const k = String(l.code).trim().toUpperCase();
    const p = by.get(k) || { code: l.code, desc: String(l.desc || "").split("\n")[0], qty: 0, orders: 0, spend: 0, customers: new Set(), machines: new Set(), last: "" };
    p.qty += Number(l.qty) || 0; p.orders++; p.spend += Number(l.amount) || 0; p.customers.add(cName(j.client_id)); if (j.machine_id) p.machines.add(mLabel(j.machine_id));
    if (j.date > p.last) p.last = j.date; by.set(k, p);
  }
  const list = [...by.values()].sort((a, b) => b.spend - a.spend || b.qty - a.qty);
  return el("div", { class: "card" },
    el("div", { class: "bhead" }, el("h2", {}, "Parts used (" + list.length + " part numbers)"),
      dlMenu("Parts used.csv", () => [["Part", "Description", "Qty", "Times supplied", "Spend ex GST", "Last supplied", "Customers", "Machines"],
        ...list.map((p) => [p.code, p.desc, p.qty, p.orders, p.spend.toFixed(2), p.last, [...p.customers].join("; "), [...p.machines].join("; ")])])),
    list.length ? el("div", { class: "tscroll" }, el("table", { class: "tbl rtbl" },
      el("thead", {}, el("tr", {}, ...["Part", "Description", "Qty", "Times", "Spend", "Last supplied", "Customers"].map((h) => el("th", { class: ["Qty", "Times", "Spend"].includes(h) ? "num" : null }, h)))),
      el("tbody", {}, ...list.map((p) => el("tr", {}, el("td", { class: "mono", "data-l": "Part" }, p.code), el("td", { "data-l": "Description" }, p.desc), el("td", { class: "num", "data-l": "Qty" }, p.qty),
        el("td", { class: "num", "data-l": "Times" }, p.orders), el("td", { class: "num", "data-l": "Spend" }, money(p.spend)), el("td", { "data-l": "Last" }, fmtDate(p.last)), el("td", { "data-l": "Customers" }, [...p.customers].join(", ")))))))
      : el("p", { class: "muted small" }, "No parts in this period."));
}
function bars(series, fmt) {
  const max = Math.max(1, ...series.map((s) => s[1]));
  return el("div", { class: "rbars" }, ...series.map(([k, n]) => el("div", { class: "rbar", title: monthLbl(k) + ": " + fmt(n) },
    el("span", { class: "rv" }, n ? fmt(n) : ""), el("span", { class: "rb", style: "height:" + Math.round((n / max) * 100) + "%" }), el("span", { class: "rk" }, monthLbl(k)))));
}
function trendsReport(jobs) {
  const months = []; const dated = jobs.filter((j) => j.date);
  if (!dated.length) return el("div", { class: "card" }, el("p", { class: "muted small" }, "No jobs in this period."));
  const first = rep.f.from ? monthKey(rep.f.from) : monthKey(dated[dated.length - 1].date), last = rep.f.to ? monthKey(rep.f.to) : monthKey(localIso());
  let [y, m] = first.split("-").map(Number); const [ly, lm] = last.split("-").map(Number);
  while (y < ly || (y === ly && m <= lm)) { months.push(y + "-" + String(m).padStart(2, "0")); m++; if (m > 12) { m = 1; y++; } if (months.length > 60) break; }
  const per = (fn) => months.map((k) => [k, dated.filter((j) => monthKey(j.date) === k).reduce((s, j) => s + fn(j), 0)]);
  const visits = per((j) => (j.kind === "service" || j.kind === "fault" ? 1 : 0));
  const spend = per((j) => j.amount);
  const byCust = new Map(); for (const j of jobs) { const c = cName(j.client_id); const x = byCust.get(c) || { n: 0, s: 0 }; x.n++; x.s += j.amount; byCust.set(c, x); }
  // Most frequent issues: error codes and repeated words in job titles
  const codes = new Map(); for (const j of jobs) for (const c of String([j.error, j.title, j.notes].join(" ")).match(/\b(?:[A-Z]{1,2}\d{2,4}|\d{3,4}[A-Z]?)\b/g) || []) if (!/^(20\d\d|19\d\d)$/.test(c)) codes.set(c, (codes.get(c) || 0) + 1);
  const topCodes = [...codes.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const half = Math.floor(months.length / 2), a = visits.slice(0, half).reduce((s, x) => s + x[1], 0), b = visits.slice(half).reduce((s, x) => s + x[1], 0);
  return el("div", { class: "stack" },
    el("div", { class: "card" }, el("div", { class: "bhead" }, el("h2", {}, "Service visits and repairs per month"),
      dlMenu("Trends by month", () => [["Month", "Service visits & repairs", "Billed ex GST"], ...months.map((k, i) => [monthLbl(k), visits[i][1], spend[i][1].toFixed(2)])])),
      months.length > 1 ? el("p", { class: "muted small" }, b > a ? `Up: ${b} in the second half of this period against ${a} in the first.` : b < a ? `Down: ${b} in the second half of this period against ${a} in the first.` : "Steady across this period.") : null,
      bars(visits, (n) => String(n))),
    el("div", { class: "card" }, el("h2", {}, "Billed per month (ex GST)"), bars(spend, (n) => "$" + Math.round(n).toLocaleString("en-AU"))),
    el("div", { class: "card" }, el("div", { class: "bhead" }, el("h2", {}, "By customer"),
      dlMenu("Jobs by customer", () => [["Customer", "Jobs", "Billed ex GST"], ...[...byCust.entries()].sort((a, b) => b[1].s - a[1].s).map(([c, x]) => [c, x.n, x.s.toFixed(2)])])),
      el("table", { class: "tbl rtbl" }, el("thead", {}, el("tr", {}, el("th", {}, "Customer"), el("th", { class: "num" }, "Jobs"), el("th", { class: "num" }, "Billed ex GST"))),
        el("tbody", {}, ...[...byCust.entries()].sort((a, b) => b[1].s - a[1].s).map(([c, x]) => el("tr", {}, el("td", {}, c), el("td", { class: "num" }, x.n), el("td", { class: "num" }, money(x.s))))))),
    topCodes.length ? el("div", { class: "card" }, el("h2", {}, "Recurring error codes"), el("ul", { class: "links" }, ...topCodes.map(([c, n]) => el("li", {}, el("span", { class: "kind" }, n + "×"), c)))) : null);
}
/* Asset register: every machine in view with its details, warranty, service plan and job count. */
function assetsReport(fleet, jobs) {
  const today = localIso();
  const rows = fleet.slice().sort((a, b) => cName(a.client_id).localeCompare(cName(b.client_id)) || machineName(a).localeCompare(machineName(b))).map((m) => {
    const js = jobs.filter((j) => j.machine_id === m.id);
    const war = m.warranty_end ? (m.warranty_end >= today ? "In warranty to " + fmtDate(m.warranty_end) : "Ended " + fmtDate(m.warranty_end)) : "";
    return { m, n: js.length, last: js.map((j) => j.date).sort().pop() || m.last_visit || "", war, pm: pmStatus(m) };
  });
  const cols = ["Customer", "Brand", "Model", "Serial", "Category", "Location", "Installed", "Warranty", "Firmware", "Ink", "PM every", "Next PM", "PM status", "Jobs", "Last job"];
  const val = (r) => [cName(r.m.client_id), r.m.brand || "", r.m.model || "", r.m.serial || "", r.m.category || "", r.m.location || r.m.site || "", r.m.install_date || "", r.war,
    r.m.firmware || "", [r.m.ink_type, r.m.ink_set].filter(Boolean).join(" "), r.m.pm_interval_months ? r.m.pm_interval_months + " months" : "", r.m.pm_next_due || "", r.pm.label, r.n, r.last];
  return el("div", { class: "card" },
    el("div", { class: "bhead" }, el("h2", {}, "Assets (" + rows.length + ")"),
      dlMenu("Assets.csv", () => [cols, ...rows.map(val)])),
    rows.length ? el("div", { class: "tscroll" }, el("table", { class: "tbl rtbl" },
      el("thead", {}, el("tr", {}, ...["Machine", "Customer", "Location", "Installed", "Warranty", "Service plan", "Jobs", "Last job"].map((h) => el("th", { class: h === "Jobs" ? "num" : null }, h)))),
      el("tbody", {}, ...rows.map((r) => el("tr", { class: "rrow", tabindex: 0, onclick: () => (location.hash = "#machine/" + encodeURIComponent(r.m.id)) },
        el("td", { "data-l": "Machine" }, el("b", {}, machineName(r.m)), el("br"), el("span", { class: "muted small" }, [r.m.serial && "SN " + r.m.serial, r.m.firmware && "FW " + r.m.firmware].filter(Boolean).join(" · "))),
        el("td", { "data-l": "Customer" }, cName(r.m.client_id)), el("td", { "data-l": "Location" }, r.m.location || r.m.site || "—"),
        el("td", { "data-l": "Installed" }, r.m.install_date ? fmtDate(r.m.install_date) : "—"), el("td", { "data-l": "Warranty" }, r.war || "—"),
        el("td", { "data-l": "Service plan" }, r.pm.label ? el("span", { class: "pill " + r.pm.cls }, r.pm.label + (r.m.pm_next_due ? " · " + fmtDate(r.m.pm_next_due) : "")) : "—"),
        el("td", { class: "num", "data-l": "Jobs" }, r.n), el("td", { "data-l": "Last job" }, r.last ? fmtDate(r.last) : "—"))))))
      : el("p", { class: "muted small" }, "No machines match these filters."));
}
/* Staff only: the whole service desk at a glance. */
function deskReport(jobs, fleet) {
  const T = jobs.filter((j) => j.src === "ticket"), INV = jobs.filter((j) => j.src === "invoice");
  const open = T.filter((j) => !["completed", "invoiced", "closed", "cancelled"].includes(j.status));
  const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
  const today = localIso();
  const done = T.filter((j) => j.completed && j.created).map((j) => days(j.created, String(j.completed).slice(0, 10))).filter((d) => d >= 0);
  const avg = done.length ? Math.round(done.reduce((s, d) => s + d, 0) / done.length) : null;
  const age = (j) => days(j.created || j.date, today);
  const count = (arr, fn) => { const m = new Map(); for (const x of arr) { const k = fn(x) || "—"; m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  const sum = (arr, fn) => { const m = new Map(); for (const x of arr) { const k = fn(x) || "—"; const v = m.get(k) || { n: 0, s: 0 }; v.n++; v.s += x.amount; m.set(k, v); } return [...m.entries()].sort((a, b) => b[1].s - a[1].s); };
  const STN = { new: "New", scheduled: "Scheduled", "in-progress": "In progress", waiting: "Waiting on parts / customer", quote: "Quote", completed: "Completed", invoiced: "Invoiced" };
  const TYN = (j) => j.subtype === "installation" ? "Installation" : j.subtype === "pm" ? "PM service" : ({ incident: "Incident", request: "Request", problem: "Problem" }[j.type] || j.type);
  const mini = (title, rows, csvName, head) => el("div", { class: "card" },
    el("div", { class: "bhead" }, el("h2", {}, title), csvName ? dlMenu(csvName, () => [head, ...rows.map((r) => r.map((c) => (c && c.textContent != null ? c.textContent : c)))]) : null),
    rows.length ? el("div", { class: "tscroll" }, el("table", { class: "tbl rtbl" }, el("thead", {}, el("tr", {}, ...head.map((h, i) => el("th", { class: i ? "num" : null }, h)))),
      el("tbody", {}, ...rows.map((r) => el("tr", {}, ...r.map((c, i) => el("td", { class: i ? "num" : null }, c))))))) : el("p", { class: "muted small" }, "Nothing in this period."));
  const fleetDue = fleet.filter((m) => ["over", "soon"].includes(pmStatus(m).cls)).sort((a, b) => String(a.pm_next_due || "").localeCompare(String(b.pm_next_due || "")));
  const warSoon = fleet.filter((m) => m.warranty_end && m.warranty_end >= today && days(today, m.warranty_end) <= 90).sort((a, b) => a.warranty_end.localeCompare(b.warranty_end));
  const kp = [[T.length, "Tickets"], [open.length, "Open now"], [open.filter((j) => age(j) > 30).length, "Open over 30 days"], [avg == null ? "—" : avg + " days", "Average time to complete"],
    [INV.length, "Invoices"], [money(INV.reduce((s, j) => s + j.amount, 0)), "Invoiced ex GST"], [fleet.length, "Machines"], [fleetDue.length, "PM due or overdue"]];
  return el("div", { class: "stack" },
    el("div", { class: "stats" }, ...kp.map(([n, l]) => el("div", { class: "stat" }, el("div", { class: "n" }, n), el("div", { class: "l" }, l)))),
    el("div", { class: "rgrid" },
      mini("Tickets by status", count(T, (j) => STN[j.status] || j.status).map(([k, n]) => [k, n]), "Tickets by status.csv", ["Status", "Tickets"]),
      mini("Tickets by type", count(T, TYN).map(([k, n]) => [k, n]), "Tickets by type.csv", ["Type", "Tickets"]),
      mini("Billed to", sum(T, (j) => j.bill_to).map(([k, v]) => [k, v.n, money(v.s)]), "Tickets by bill to.csv", ["Bill to", "Tickets", "Lines ex GST"]),
      mini("How jobs came in", count(T, (j) => ({ phone: "Phone", sms: "Text", email: "Email", godaddy: "GoDaddy booking", portal: "Portal" }[j.channel] || j.channel || "Service desk")).map(([k, n]) => [k, n]), "Tickets by channel.csv", ["Came in by", "Tickets"])),
    mini("Open tickets, oldest first (" + open.length + ")", open.slice().sort((a, b) => age(b) - age(a)).map((j) => [j.ref + " · " + (j.customer || cName(j.client_id)), STN[j.status] || j.status, age(j) + " days", j.bill_to]),
      "Open tickets.csv", ["Ticket", "Status", "Age", "Bill to"]),
    mini("Top customers by invoiced ex GST", sum(INV, (j) => cName(j.client_id)).slice(0, 25).map(([k, v]) => [k, v.n, money(v.s)]), "Invoiced by customer.csv", ["Customer", "Invoices", "Invoiced ex GST"]),
    mini("Jobs by brand", count(jobs.filter((j) => j.machine_id), (j) => (mOf(j.machine_id) || {}).brand).map(([k, n]) => [k, n]), "Jobs by brand.csv", ["Brand", "Jobs"]),
    mini("PM due or overdue (" + fleetDue.length + ")", fleetDue.map((m) => [cName(m.client_id) + " · " + machineName(m) + (m.serial ? " · " + m.serial : ""), pmStatus(m).label, m.pm_next_due ? fmtDate(m.pm_next_due) : "—"]),
      "PM due.csv", ["Machine", "PM status", "Due"]),
    mini("Warranty ending in the next 90 days (" + warSoon.length + ")", warSoon.map((m) => [cName(m.client_id) + " · " + machineName(m) + (m.serial ? " · " + m.serial : ""), fmtDate(m.warranty_end)]),
      "Warranty ending.csv", ["Machine", "Warranty ends"]));
}
function machineReport(jobs, fleet) {
  const files = state.files || [];
  const rows = fleet.map((m) => {
    const js = jobs.filter((j) => j.machine_id === m.id).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const visits = js.filter((j) => j.kind === "service" || j.kind === "fault");
    const gaps = []; for (let i = 1; i < visits.length; i++) gaps.push((new Date(visits[i].date) - new Date(visits[i - 1].date)) / 86400000);
    const fs = files.filter((x) => x.machine_id === m.id), fw = fs.find((x) => x.fw)?.fw || "";
    const lastLog = fs.filter((x) => x.kind === "log").map((x) => x.param_date || x.modified).sort().pop() || "";
    return { m, n: js.length, visits: visits.length, parts: js.reduce((s, j) => s + j.lines.filter(isPart).reduce((t, l) => t + (Number(l.qty) || 0), 0), 0),
      spend: js.reduce((s, j) => s + j.amount, 0), last: js.length ? js[js.length - 1].date : m.last_visit || "", gap: gaps.length ? Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length) : null,
      fw, files: fs.length, lastLog, pm: pmStatus(m) };
  }).sort((a, b) => b.spend - a.spend);
  const unmatched = jobs.filter((j) => !j.machine_id).length;
  return el("div", { class: "card" },
    el("div", { class: "bhead" }, el("h2", {}, "Usage by machine (" + rows.length + ")"),
      dlMenu("Usage by machine.csv", () => [["Customer", "Machine", "Serial", "Installed", "Jobs", "Service visits", "Avg days between visits", "Parts fitted", "Billed ex GST", "Last job", "Next PM due", "PM status", "Firmware", "Parameter/log files", "Latest log"],
        ...rows.map((r) => [cName(r.m.client_id), machineName(r.m), r.m.serial || "", r.m.install_date || "", r.n, r.visits, r.gap ?? "", r.parts, r.spend.toFixed(2), r.last, r.m.pm_next_due || "", r.pm.label, r.fw, r.files, r.lastLog])])),
    el("div", { class: "tscroll" }, el("table", { class: "tbl rtbl" },
      el("thead", {}, el("tr", {}, ...["Machine", "Customer", "Jobs", "Visits", "Avg gap", "Parts", "Billed", "Last job", "Service", "Firmware / logs"].map((h) => el("th", { class: ["Jobs", "Visits", "Avg gap", "Parts", "Billed"].includes(h) ? "num" : null }, h)))),
      el("tbody", {}, ...rows.map((r) => el("tr", { class: "rrow", tabindex: 0, onclick: () => (location.hash = "#machine/" + encodeURIComponent(r.m.id)) },
        el("td", { "data-l": "Machine" }, el("b", {}, machineName(r.m)), el("br"), el("span", { class: "muted small" }, r.m.serial ? "SN " + r.m.serial : "")),
        el("td", { "data-l": "Customer" }, cName(r.m.client_id)), el("td", { class: "num", "data-l": "Jobs" }, r.n), el("td", { class: "num", "data-l": "Visits" }, r.visits),
        el("td", { class: "num", "data-l": "Avg gap" }, r.gap == null ? "—" : r.gap + " days"), el("td", { class: "num", "data-l": "Parts" }, r.parts),
        el("td", { class: "num", "data-l": "Billed" }, money(r.spend)), el("td", { "data-l": "Last job" }, fmtDate(r.last)),
        el("td", { "data-l": "Service" }, r.pm.label ? el("span", { class: "pill " + r.pm.cls }, r.pm.label + (r.m.pm_next_due ? " · " + fmtDate(r.m.pm_next_due) : "")) : "—"),
        el("td", { "data-l": "Firmware / logs" }, [r.fw && "FW " + r.fw, r.files ? r.files + " file" + (r.files > 1 ? "s" : "") : "", r.lastLog && "last log " + fmtDate(r.lastLog)].filter(Boolean).join(" · ") || "—")))))),
    el("p", { class: "muted small" }, "Usage figures (print volumes, ink use, running hours) come from the machine logs we save at each service; machines show their latest firmware and log date here. " +
      (unmatched ? unmatched + " job" + (unmatched > 1 ? "s" : "") + " in this period couldn't be tied to a specific machine and count only in the customer totals." : "")));
}

// ---------- staff: manage vendor supervisors ----------
async function renderSupervisorsAdmin(host) {
  const [s, a, c] = await Promise.all([
    sb.from("supervisors").select("*").order("name"), sb.from("supervisor_access").select("*").order("email"), sb.from("supervisor_clients").select("*")]);
  if (s.error) { host.replaceChildren(el("p", { class: "msg err" }, "Couldn't load vendor supervisors.")); return; }
  const note = el("span", { class: "saved" });
  const cards = s.data.map((sup) => {
    const logins = a.data.filter((x) => x.supervisor_id === sup.id), custs = c.data.filter((x) => x.supervisor_id === sup.id);
    const em = el("input", { class: "field", type: "email", placeholder: "name@vendor.com" }), fn = el("input", { class: "field", placeholder: "Full name" });
    const pick = el("select", { class: "field" }, el("option", { value: "" }, "Add a customer…"), ...state.clients.filter((x) => !custs.some((y) => y.client_id === x.id)).map((x) => el("option", { value: x.id }, x.name)));
    const sync = el("button", { class: "btn small", type: "button", onclick: async () => {
      sync.disabled = true; sync.textContent = "Reading FreshBooks…";
      const { data, error } = await sb.rpc("staff_sync_supervisor", { p_sup: sup.id });
      sync.disabled = false; sync.textContent = "Update service history from FreshBooks";
      flash(note, error ? "Sync failed: " + error.message : data?.ok ? data.invoices + " invoices read" : "Sync failed: " + (data?.error || ""), !error && data?.ok);
    } }, "Update service history from FreshBooks");
    const inv = sup.scope === "invoiced";
    const onBox = el("input", { type: "checkbox", checked: sup.enabled !== false, onchange: async () => {
      const { error } = await sb.from("supervisors").update({ enabled: onBox.checked }).eq("id", sup.id);
      if (error) { onBox.checked = !onBox.checked; return flash(note, "Not changed", false); }
      flash(note, onBox.checked ? sup.name + " portal access is on" : sup.name + " portal access is off", true);
      if (onBox.checked && inv && !sup.last_sync) sync.click();
    } });
    const KBB = [["mimaki", "Mimaki"], ["mutoh", "Mutoh"], ["gtx", "Brother GTX"], ["epilog", "Epilog"], ["brother", "Brother office"], ["kyocera", "Kyocera office"]];
    const kbSel = new Set(sup.kb_brands || []);
    const kbPick = el("span", { style: "display:inline-flex;flex-wrap:wrap;gap:10px" }, ...KBB.map(([k, l]) => el("label", { class: "small" }, el("input", { type: "checkbox", checked: kbSel.has(k), onchange: async (e) => {
      e.target.checked ? kbSel.add(k) : kbSel.delete(k);
      const { error } = await sb.from("supervisors").update({ kb_brands: [...kbSel] }).eq("id", sup.id);
      if (error) { e.target.checked = !e.target.checked; return flash(note, "Not saved", false); }
      flash(note, kbSel.size ? "Knowledge Base shows " + KBB.filter(([x]) => kbSel.has(x)).map(([, y]) => y).join(", ") : "Knowledge Base shows every brand", true);
    } }), " " + l)));
    const dom = el("input", { class: "field", value: (sup.login_domains || []).join(", "), placeholder: "e.g. mimaki.com", style: "max-width:260px" });
    const domForm = el("form", { class: "inline", onsubmit: async (e) => { e.preventDefault();
      const list = [...new Set(dom.value.split(/[\s,;]+/).map((x) => x.trim().toLowerCase().replace(/^@/, "")).filter((x) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(x)))];
      const { error } = await sb.from("supervisors").update({ login_domains: list }).eq("id", sup.id);
      flash(note, error ? "Not saved" : list.length ? "Anyone at " + list.map((d) => "@" + d).join(", ") + " can sign in as " + sup.name : "Only the logins below can sign in", !error);
    } }, dom, el("button", { class: "btn small", type: "submit" }, "Save domains"));
    return el("div", { class: "card", style: "margin-top:12px" + (sup.enabled === false ? ";opacity:.75" : "") },
      el("div", { class: "bhead" }, el("h3", {}, sup.name), el("span", { class: "muted small" }, "Bill to: " + (sup.bill_to || "—") + (sup.last_sync ? " · history updated " + new Date(sup.last_sync).toLocaleString("en-AU") : ""))),
      el("label", { class: "small", style: "display:flex;gap:8px;align-items:center;margin:4px 0 8px" }, onBox, el("b", {}, "Portal access"), el("span", { class: "muted" }, sup.enabled === false ? "off: these logins see nothing" : "on")),
      el("label", { class: "small", style: "display:flex;gap:8px;align-items:center;margin:0 0 8px" }, el("input", { type: "checkbox", checked: sup.reports_access !== false, onchange: async (e) => {
        const on = e.target.checked; const { error } = await sb.from("supervisors").update({ reports_access: on }).eq("id", sup.id);
        if (error) { e.target.checked = !on; return flash(note, "Not changed", false); } flash(note, "Reports " + (on ? "on" : "off") + " for " + sup.name, true); } }),
        el("b", {}, "Reports"), el("span", { class: "muted" }, "assets, usage and service history for jobs billed to " + (sup.bill_to || sup.name) + ", exportable as CSV")),
      inv
        ? el("p", { class: "muted small" }, "Vendor logins see every job invoiced to " + (sup.bill_to || sup.name) + ", for any customer: invoices from FreshBooks and service desk jobs with Bill to " + (sup.bill_to || sup.name) + ". They see only those jobs' customers and machines, and get Fleet reports. Adding a login sends nothing.")
        : el("p", { class: "muted small" }, "Supervisor logins see every machine, job and service record for these customers, can log jobs and add machines for them, and get Fleet reports. Adding a login sends nothing."),
      el("h3", {}, "Knowledge Base brands"),
      el("p", { class: "muted small" }, "Brands " + sup.name + " logins see in the Knowledge Base. Untick them all to show every brand."), kbPick,
      el("h3", {}, "Parts Catalogue access"),
      el("p", { class: "muted small" }, "Brands every " + sup.name + " login can see in the Parts Catalogue. Untick them all to remove access."),
      catPicker(sup, "supervisors", sup.name),
      el("h3", {}, "Logins"),
      el("p", { class: "muted small" }, "Email domains that can sign in as " + sup.name + " (anyone with an address there):"), domForm,
      el("ul", { class: "links" }, ...logins.map((u) => el("li", {}, u.email + (u.full_name ? " (" + u.full_name + ")" : ""), " ",
        el("button", { class: "btn ghost small", type: "button", onclick: async () => { await sb.from("supervisor_access").delete().eq("supervisor_id", sup.id).eq("email", u.email); renderSupervisorsAdmin(host); } }, "Remove")))),
      el("form", { class: "inline", onsubmit: async (e) => { e.preventDefault(); if (!em.value.trim()) return;
        const { error } = await sb.from("supervisor_access").insert({ supervisor_id: sup.id, email: em.value.trim().toLowerCase(), full_name: fn.value.trim() || null });
        if (error) return flash(note, "Login not added", false); renderSupervisorsAdmin(host); } }, em, fn, el("button", { class: "btn small", type: "submit" }, "Add login")),
      ...(inv ? [] : [el("h3", {}, "Customers (" + custs.length + ")"),
      el("ul", { class: "links" }, ...custs.map((x) => el("li", {}, cName(x.client_id), x.match_terms?.length ? el("span", { class: "muted small" }, "  matched on invoices by: " + x.match_terms.join(", ")) : "", " ",
        el("button", { class: "btn ghost small", type: "button", onclick: async () => { await sb.from("supervisor_clients").delete().eq("supervisor_id", sup.id).eq("client_id", x.client_id); renderSupervisorsAdmin(host); } }, "Remove")))),
      el("form", { class: "inline", onsubmit: async (e) => { e.preventDefault(); if (!pick.value) return;
        const cl = state.clients.find((x) => String(x.id) === pick.value);
        const { error } = await sb.from("supervisor_clients").insert({ supervisor_id: sup.id, client_id: Number(pick.value), match_terms: [norm(cl?.name || "")] });
        if (error) return flash(note, "Customer not added", false); renderSupervisorsAdmin(host); } }, pick, el("button", { class: "btn small", type: "submit" }, "Add customer"))]),
      el("p", {}, sync, " ", note));
  });
  host.replaceChildren(el("p", { class: "muted small" }, "Vendors see jobs invoiced to them; supervisors see their contracted customers' whole fleets."), ...cards);
}

// ---------- all jobs for the account: open jobs on My machines, and exports ----------
const JOB_OPEN = (s) => !["completed", "invoiced", "cancelled"].includes(s);
const TSTAT = { new: "Logged", scheduled: "Scheduled", "in-progress": "In progress", waiting: "Waiting on parts / info", quote: "Quote sent", completed: "Completed", invoiced: "Completed" };
const jobKind = (t) => t.subtype === "installation" ? "Installation" : t.subtype === "pm" ? "Scheduled service" : t.type === "incident" ? "Fault or repair" : "Request";
const kindName = (k) => ({ service: "Service visit", install: "Installation", parts: "Parts", fault: "Fault or repair", other: "Request" }[k] || k || "");
function labourField(desc, label) {
  const m = String(desc || "").match(new RegExp("^\\s*" + label + "[^:\\n]*:[ \\t]*([\\s\\S]*?)(?=\\n\\s*[A-Z][A-Za-z /()]{2,40}:|$)", "mi"));
  return m ? m[1].trim() : "";
}
async function loadJobs(force) {
  if (state.jobs && !force) return state.jobs;
  const { data, error } = await sb.rpc("my_jobs");
  if (error) throw error;
  const jobs = [];
  const ticketNums = new Set();
  for (const t of data.tickets || []) {
    ticketNums.add(String(t.num));
    jobs.push({ ref: "Job " + t.num, date: t.created, client_id: t.client_id, machine_id: t.machine_id, type: jobKind(t), status: TSTAT[t.status] || t.status, open: JOB_OPEN(t.status),
      scheduled: t.sched_date || "", problem: [t.problem || t.summary, t.error_code && "Error " + t.error_code].filter(Boolean).join(". "),
      work: t.work || "", parts: (t.parts || []).map((p) => (Number(p.qty) || 1) + " x " + p.code + (p.desc ? " " + p.desc : "")).join("; ") });
  }
  for (const r of data.history || []) {
    const labour = (r.lines || []).find((l) => /labou?r|hourly|day rate/i.test(l.code || "")) || {};
    const job = labourField(labour.desc, "Job");
    if (job && ticketNums.has(job.replace(/\D/g, ""))) continue; // already listed from the service desk
    const problem = labourField(labour.desc, "Reported Issue") || r.po || String(labour.desc || "").split("\n")[0] || "";
    const work = labourField(labour.desc, "Work Performed") || (labour.desc && !/Reported Issue|Work Performed/i.test(labour.desc) ? labour.desc : "");
    const parts = (r.lines || []).filter((l) => /\d/.test(l.code || "") && !/\s/.test(String(l.code).trim()) && !/labou?r|callout|delivery|report|flight|hotel|accommodation|car hire|day rate|shipping/i.test(l.code))
      .map((l) => (Number(l.qty) || 1) + " x " + l.code + (l.desc ? " " + String(l.desc).split("\n")[0] : "")).join("; ");
    jobs.push({ ref: "Invoice " + r.number, date: r.issued, client_id: r.client_id, machine_id: r.machine_id, type: kindName(r.kind), status: "Completed", open: false,
      scheduled: labourField(labour.desc, "Date Scheduled"), problem, work, parts });
  }
  for (const j of data.portal || []) if (j.status === "pending")
    jobs.push({ ref: "Portal request", date: String(j.created).slice(0, 10), client_id: j.client_id, machine_id: j.machine_id, type: kindName(j.kind), status: "Waiting for us", open: true,
      scheduled: "", problem: [j.description, j.error_code && "Error " + j.error_code].filter(Boolean).join(". "), work: "", parts: "" });
  jobs.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  state.jobs = jobs;
  return jobs;
}
const machLabel = (id) => { const m = state.machines.find((x) => x.id === id); return m ? machineName(m) + (m.serial ? " (SN " + m.serial + ")" : "") : ""; };

async function renderOpenJobs() {
  const box = $("#openJobs"); if (!box) return;
  if (state.staff) { box.hidden = true; return; }
  box.hidden = false;
  if (!state.jobs) box.replaceChildren(el("h2", {}, "Open jobs"), el("p", { class: "muted small" }, "Loading…"));
  let jobs;
  try { jobs = await loadJobs(); } catch (e) { box.replaceChildren(el("h2", {}, "Open jobs"), el("p", { class: "msg err" }, "Couldn't load your jobs.")); return; }
  const open = jobs.filter((j) => j.open);
  const multi = state.clients.length > 1;
  box.replaceChildren(
    el("div", { class: "bhead" }, el("h2", {}, "Open jobs"), el("span", { class: "pill " + (open.length ? "soon" : "ok") }, open.length ? open.length + " open" : "None open")),
    open.length ? el("div", { class: "tscroll" }, el("table", { class: "tbl rtbl" },
      el("thead", {}, el("tr", {}, ...["Logged", "Job", multi ? "Customer" : null, "Machine", "Type", "Problem / request", "Status", "Scheduled"].filter(Boolean).map((h) => el("th", {}, h)))),
      el("tbody", {}, ...open.map((j) => el("tr", { class: j.machine_id ? "rrow" : null, onclick: j.machine_id ? () => (location.hash = "#machine/" + encodeURIComponent(j.machine_id)) : null },
        el("td", { "data-l": "Logged" }, fmtDate(j.date)), el("td", { "data-l": "Job" }, j.ref),
        multi ? el("td", { "data-l": "Customer" }, clientName(j.client_id)) : null,
        el("td", { "data-l": "Machine" }, machLabel(j.machine_id) || "—"), el("td", { "data-l": "Type" }, j.type),
        el("td", { "data-l": "Problem" }, j.problem || "—"), el("td", { "data-l": "Status" }, el("span", { class: "pill soon" }, j.status)),
        el("td", { "data-l": "Scheduled" }, j.scheduled ? fmtDate(j.scheduled) : "To be arranged"))))))
      : el("p", { class: "muted small" }, "No open jobs right now. Log a job from any machine's page, or book a service."));
}

/* ---------- exports: CSV, Excel, PDF ---------- */
function loadScript(src, test) {
  if (test()) return Promise.resolve();
  return new Promise((ok, no) => { const s = el("script", { src }); s.onload = ok; s.onerror = () => no(new Error("Couldn't load " + src)); document.head.append(s); });
}
function saveBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function exportTable(fmt, base, title, head, rows) {
  const stamp = localIso(), name = `${base} ${stamp}`;
  if (fmt === "csv") {
    const csv = [head, ...rows].map((r) => r.map((c) => { c = String(c ?? ""); return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(",")).join("\r\n");
    return saveBlob(name + ".csv", new Blob(["﻿" + csv], { type: "text/csv" }));
  }
  if (fmt === "xlsx") {
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js", () => window.XLSX);
    const ws = XLSX.utils.aoa_to_sheet([head, ...rows]);
    ws["!cols"] = head.map((h, i) => ({ wch: Math.min(60, Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? "").split("\n")[0].length)) + 2) }));
    ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: head.length - 1 } }) };
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, title.slice(0, 31));
    return saveBlob(name + ".xlsx", new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  }
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js", () => window.jspdf);
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js", () => window.jspdf && window.jspdf.jsPDF.API.autoTable);
  const doc = new window.jspdf.jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const who = state.staff ? "Customer Assets" : isSupervisor() ? supName() + (isVendorOnly() ? " jobs" : " fleet") : state.clients.map((c) => c.name).join(", ");
  doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.text("Highway Digital · " + title, 12, 14);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(90);
  doc.text(`${who}  ·  ${rows.length} rows  ·  exported ${new Date().toLocaleString("en-AU")}  ·  portal.highwaydigital.com.au`, 12, 20);
  doc.autoTable({ startY: 24, head: [head], body: rows.map((r) => r.map((c) => String(c ?? ""))), margin: { left: 10, right: 10 },
    styles: { fontSize: 7.5, cellPadding: 1.6, overflow: "linebreak", valign: "top" }, headStyles: { fillColor: [20, 20, 20], textColor: [232, 185, 35] },
    alternateRowStyles: { fillColor: [246, 246, 246] },
    didDrawPage: (d) => { doc.setFontSize(8); doc.setTextColor(120); doc.text("Page " + doc.internal.getNumberOfPages(), doc.internal.pageSize.getWidth() - 25, doc.internal.pageSize.getHeight() - 6); } });
  saveBlob(name + ".pdf", doc.output("blob"));
}
function machineExportRows() {
  const head = ["Customer", "Brand", "Model", "Serial number", "Category", "Type", "Site", "Location", "Ink set", "Installed", "Warranty ends",
    "Service every (months)", "Last service", "Next service due", "Service status", "Last visit", "Parameter/log files", "Latest firmware", "Machine ID"];
  const rows = state.machines.map((m) => { const fs = filesFor(m); return [clientName(m.client_id), m.brand || "", m.model || "", m.serial || "", m.category || "", m.sub_category || "",
    m.site || "", m.location || "", m.ink_set || "", m.install_date || "", m.warranty_end || "", m.pm_interval_months || "", m.pm_last_done || "", m.pm_next_due || "",
    pmStatus(m).label, m.last_visit || "", fs.length || "", (fs.find((f) => f.fw) || {}).fw || "", m.id]; });
  return [head, rows];
}
async function jobExportRows() {
  if (isSupervisor() && !state.staff && isVendorOnly()) {   // vendors: jobs billed to them, from the Reports data
    const d = await loadReportData();
    const head = ["Date", "Reference", "Customer", "Machine", "Type", "Status", "Job", "Notes", "Work detail", "Parts used", "Amount ex GST"];
    return [head, d.jobs.map((j) => [j.date || "", j.ref, cName(j.client_id), mLabel(j.machine_id), KIND_NAMES[j.kind] || j.kind || "", j.status || "", j.title || "", j.notes || "",
      String(j.detail || ""), j.lines.filter(isPart).map((l) => (Number(l.qty) || 1) + " x " + l.code).join("; "), (Number(j.amount) || 0).toFixed(2)])];
  }
  const jobs = await loadJobs();
  const head = ["Date", "Reference", "Customer", "Machine", "Type", "Status", "Scheduled", "Problem / request", "Work done", "Parts used"];
  return [head, jobs.map((j) => [j.date || "", j.ref, clientName(j.client_id), machLabel(j.machine_id), j.type, j.status, j.scheduled || "", j.problem, j.work, j.parts])];
}
function exportMenu() {
  const msg = el("span", { class: "muted small", role: "status" });
  const go = (what, fmt) => async (e) => {
    e.preventDefault(); dd.open = false; msg.textContent = "Preparing…";
    try {
      const [head, rows] = what === "jobs" ? await jobExportRows() : what === "vinv" ? await vendorInvoiceRows() : machineExportRows();
      const t = what === "jobs" ? ["Highway Digital jobs", "Service jobs"] : what === "vinv" ? ["Highway Digital invoices to " + supName(), "Invoices to " + supName()] : ["Highway Digital machines", "Machines"];
      await exportTable(fmt, t[0], t[1], head, rows);
      msg.textContent = "";
    } catch (er) { msg.textContent = "Export failed: " + (er.message || er); }
  };
  const item = (what, fmt, label) => el("button", { type: "button", class: "xopt", onclick: go(what, fmt) }, label);
  const dd = el("details", { class: "xmenu" }, el("summary", { class: "btn" }, "Export ▾"),
    el("div", { class: "xpanel" },
      el("div", { class: "xhd" }, "Machines (full asset details)"), item("machines", "xlsx", "Excel (.xlsx)"), item("machines", "csv", "CSV"), item("machines", "pdf", "PDF"),
      el("div", { class: "xhd" }, "All jobs (problem and work done)"), item("jobs", "xlsx", "Excel (.xlsx)"), item("jobs", "csv", "CSV"), item("jobs", "pdf", "PDF"),
      ...(isSupervisor() && !state.staff ? [el("div", { class: "xhd" }, "Invoices to " + supName()), item("vinv", "xlsx", "Excel (.xlsx)"), item("vinv", "csv", "CSV"), item("vinv", "pdf", "PDF")] : [])));
  document.addEventListener("click", (e) => { if (dd.open && !dd.contains(e.target)) dd.open = false; });
  return el("span", { class: "xwrap" }, dd, msg);
}

// ---------- "Quote me": fixed-price service + PM kit parts, several machines on one callout ----------
const money2 = (n) => "$" + (Math.round((+n || 0) * 100) / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const STD_LABOUR = 150; // standard hourly rate (ex GST); no PM kit: 1 hour, parts quoted on inspection
// Kit price = hours on site x hourly rate + the kit parts (qty x ex GST). The callout is never in it: it's added once per visit, only for on-site visits.
const kitPartsTotal = (parts) => (parts || []).reduce((s, p) => s + (p.ex == null || p.ex === "" || isNaN(+p.ex) ? 0 : Math.max(1, Math.round(+p.qty || 1)) * +p.ex), 0);
const kitPrice = (hours, parts) => Math.round(((+hours || 0) * STD_LABOUR + kitPartsTotal(parts)) * 100) / 100;
const SQ = { open: false, sel: {}, extras: [], parts: null, note: "", onsite: true };
function kitFor(m) { return (state.kits || {})[m.id] || null; }
function sqMachines() { return state.machines; }
function sqPartsOf(mid) {
  const s = SQ.sel[mid], k = kitFor(state.machines.find((x) => x.id === mid));
  if (!s || !k) return [];
  return (s.plan === "six" ? k.six_parts : k.annual_parts) || [];
}
function openServiceQuote(mid) {
  if (!SQ.sel[mid]) SQ.sel[mid] = { plan: "annual", remove: new Set() };
  SQ.open = true; renderServiceQuote();
}
function closeServiceQuote() { SQ.open = false; document.body.classList.remove("sq-lock"); $("#sqLayer")?.remove(); }
function sqTotals() {
  let svc = 0, parts = 0, hrs = 0, n = 0;
  for (const [mid, s] of Object.entries(SQ.sel)) {
    const k = kitFor(state.machines.find((x) => x.id === mid));
    if (!k) { n++; svc += STD_LABOUR; hrs += 1; continue; }
    const h = +(s.plan === "six" ? k.six_hours : k.annual_hours) || 0;
    n++; svc += h * STD_LABOUR; hrs += h;
    for (const p of sqPartsOf(mid)) if (!s.remove.has(p.pn) && p.ex != null) parts += (+p.ex) * (+p.qty || 1);
  }
  for (const x of SQ.extras) parts += x.ex * x.qty;
  return { svc, parts, hrs, n };
}
function renderServiceQuote() {
  let layer = $("#sqLayer");
  if (!layer) {
    layer = el("div", { id: "sqLayer", class: "sq-layer", onclick: (e) => { if (e.target === layer) closeServiceQuote(); } });
    document.body.append(layer); document.body.classList.add("sq-lock");
    document.addEventListener("keydown", function esc(e) { if (e.key === "Escape") { closeServiceQuote(); document.removeEventListener("keydown", esc); } });
  }
  const list = sqMachines();
  const machineBlock = (m) => {
    const k = kitFor(m), s = SQ.sel[m.id], on = !!s;
    const head = el("label", { class: "sq-mhead" },
      el("input", { type: "checkbox", checked: on, onchange: (e) => { if (e.target.checked) SQ.sel[m.id] = { plan: "annual", remove: new Set() }; else delete SQ.sel[m.id]; renderServiceQuote(); } }),
      el("span", {}, el("b", {}, machineName(m)), el("span", { class: "muted small" }, " " + [m.serial && "SN " + m.serial, m.location || m.site].filter(Boolean).join(" · "))));
    if (!on) return el("div", { class: "sq-m" }, head);
    if (!k) return el("div", { class: "sq-m on" }, head,
      el("p", { class: "sq-warn" }, el("b", {}, "No PM kit found for this model. "),
        "We'll quote a standard service visit: 1 hour's labour (" + money2(STD_LABOUR) + " + GST, billed hourly for the actual time) plus the callout. All parts required will be quoted on inspection."));
    const parts = sqPartsOf(m.id);
    const planBtn = (val, label, fee, hrs) => el("label", { class: "sq-plan" + (s.plan === val ? " on" : "") },
      el("input", { type: "radio", name: "plan-" + m.id, checked: s.plan === val, onchange: () => { s.plan = val; s.remove = new Set(); renderServiceQuote(); } }),
      el("span", {}, el("b", {}, label), el("span", { class: "small" }, " " + money2(fee) + " incl. parts" + (+hrs ? " · " + (+hrs) + " h labour on site" : ""))));
    return el("div", { class: "sq-m on" }, head,
      el("div", { class: "sq-plans" }, planBtn("annual", "Annual service", k.annual_fee, k.annual_hours),
        k.six_fee != null ? planBtn("six", "6-month service", k.six_fee, k.six_hours) : null),
      s.plan === "six" ? el("p", { class: "sq-warn" }, el("b", {}, "Caps, wipers and absorbers only. "),
        "The 6-month service skips the annual PM parts (pumps, dampers, filters and valves). Skipping them can lead to a malfunction, so book the full annual service when you can.") : null,
      parts.length ? el("table", { class: "tbl sub sq-parts" },
        el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Part"), el("th", { class: "n" }, "Qty"), el("th", { class: "n" }, "Ex GST"))),
        el("tbody", {}, ...parts.map((p) => {
          const inc = !s.remove.has(p.pn);
          return el("tr", { class: inc ? "" : "off" },
            el("td", {}, el("input", { type: "checkbox", checked: inc, "aria-label": "Include " + p.name, onchange: (e) => { e.target.checked ? s.remove.delete(p.pn) : s.remove.add(p.pn); renderServiceQuote(); } })),
            el("td", {}, p.name, el("div", { class: "muted small mono" }, p.pn)),
            el("td", { class: "n" }, p.qty || 1),
            el("td", { class: "n" }, p.ex == null ? "On the quote" : money2(p.ex * (p.qty || 1))));
        }))) : el("p", { class: "muted small" }, "No parts in this kit."),
      s.remove.size ? el("p", { class: "muted small" }, "Untick a part to leave it off. Leaving PM parts out can lead to a malfunction.") : null);
  };
  const t = sqTotals();
  const extras = el("div", { class: "sq-extras" },
    el("h3", {}, "Other parts"),
    state.catAccess ? el("div", {},
      el("input", { class: "field", id: "sqSearch", type: "search", placeholder: "Search parts, e.g. wiper, damper, ink filter", oninput: sqSearch }),
      el("div", { id: "sqHits", class: "sq-hits" }),
      SQ.extras.length ? el("table", { class: "tbl sub" }, el("tbody", {}, ...SQ.extras.map((x, i) => el("tr", {},
        el("td", {}, x.name, el("div", { class: "muted small mono" }, x.pn || x.brand)),
        el("td", { class: "n" }, el("input", { class: "field sq-qty", type: "number", min: 1, max: 99, value: x.qty, "aria-label": "Quantity", onchange: (e) => { x.qty = Math.max(1, Math.min(99, Math.round(+e.target.value || 1))); renderServiceQuote(); } })),
        el("td", { class: "n" }, money2(x.ex * x.qty)),
        el("td", {}, el("button", { class: "btn ghost small", type: "button", onclick: () => { SQ.extras.splice(i, 1); renderServiceQuote(); } }, "Remove")))))) : null)
      : el("p", { class: "muted small" }, "To add other parts, ask us to turn on the Parts Catalogue for your account."));
  const msg = el("p", { class: "msg", role: "status" });
  const go = el("button", { class: "btn primary send", type: "button", disabled: !t.n, onclick: () => sendServiceQuote(go, msg) }, "Email me this quote");
  layer.replaceChildren(el("div", { class: "sq-panel", role: "dialog", "aria-modal": "true", "aria-label": "Service quote" },
    el("div", { class: "sq-headrow" }, el("h2", {}, "Service quote"), el("button", { class: "btn ghost", type: "button", "aria-label": "Close", onclick: closeServiceQuote }, "✕")),
    el("p", { class: "muted small" }, "Each service is the labour for the job at our hourly rate plus the PM parts it needs. Tick more machines to service them on the same visit: there's one callout for the whole visit when we come to you. We create the quote and email it to you straight away."),
    el("div", { class: "sq-list" }, ...list.map(machineBlock)),
    extras,
    el("label", { class: "f sq-note" }, el("span", { class: "small muted" }, "Anything we should know? (optional)"),
      el("textarea", { class: "field", rows: 2, maxlength: 1000, oninput: (e) => (SQ.note = e.target.value) }, SQ.note)),
    el("div", { class: "sq-sum" },
      el("div", {}, el("span", {}, "Labour" + (t.hrs ? " (" + t.hrs + " h at " + money2(STD_LABOUR) + "/h)" : "") + (t.n > 1 ? " · " + t.n + " machines" : "")), el("span", {}, money2(t.svc))),
      el("div", {}, el("span", {}, "Parts"), el("span", {}, money2(t.parts))),
      el("label", { class: "chk sq-onsite" }, el("input", { type: "checkbox", checked: SQ.onsite, onchange: (e) => { SQ.onsite = e.target.checked; renderServiceQuote(); } }),
        " We come to you (adds one callout for the visit)"),
      SQ.onsite ? el("div", {}, el("span", {}, "Callout (one for the visit)"), el("span", { class: "small" }, "$80 within 30 km · $125 within 100 km"))
        : el("div", { class: "muted small" }, "No callout: you bring the machine to us, or we arrange it with you."),
      el("div", { class: "sq-tot" }, el("span", {}, SQ.onsite ? "Estimate before callout" : "Estimate"), el("b", {}, money2(t.svc + t.parts) + " + GST")),
      t.hrs ? el("div", { class: "muted small" }, "About " + t.hrs + " hours on site in total.") : null,
      el("div", { class: "muted small" }, "Prices are ex GST. Service plan members' parts discount is applied on the quote.")),
    go, msg));
}
async function sqSearch(e) {
  const q = norm(e.target.value).trim(), box = $("#sqHits");
  if (!q || q.length < 2) { box.replaceChildren(); return; }
  if (!SQ.parts) {
    box.replaceChildren(el("p", { class: "muted small" }, "Loading parts…"));
    try { const r = await fetch("/service/parts", { credentials: "same-origin" }); SQ.parts = (await r.json()).parts || []; } catch (x) { SQ.parts = []; }
  }
  const words = q.split(/\s+/);
  const hits = SQ.parts.filter((p) => { const h = norm([p.pn, p.name, p.brand, p.fam].join(" ")); return words.every((w) => h.includes(w)); }).slice(0, 12);
  box.replaceChildren(...(hits.length ? hits.map((p) => el("button", { class: "sq-hit", type: "button", onclick: () => {
    const ex = SQ.extras.find((x) => x.brand === p.brand && x.key === p.key);
    if (ex) ex.qty++; else SQ.extras.push({ ...p, qty: 1 });
    renderServiceQuote(); } }, el("span", {}, p.name, el("span", { class: "muted small" }, " " + [p.pn, p.fam].filter(Boolean).join(" · "))), el("span", { class: "small" }, money2(p.ex) + " +"))) : [el("p", { class: "muted small" }, "No parts match.")]));
}
async function sendServiceQuote(btn, msg) {
  const machines = Object.entries(SQ.sel).map(([id, s]) => ({ id, plan: s.plan, remove: [...s.remove] }));
  if (!machines.length) return;
  btn.disabled = true; msg.className = "msg"; msg.textContent = "Creating your quote…";
  try {
    const r = await fetch("/service/quote", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machines, extras: SQ.extras.map((x) => ({ brand: x.brand, key: x.key, qty: x.qty })), note: SQ.note, onsite: SQ.onsite !== false }) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.error || "Couldn't create the quote.");
    const panel = btn.closest(".sq-panel");
    SQ.sel = {}; SQ.extras = []; SQ.note = ""; SQ.onsite = true;
    panel.replaceChildren(...[el("div", { class: "sq-headrow" }, el("h2", {}, "Quote sent"), el("button", { class: "btn ghost", type: "button", "aria-label": "Close", onclick: closeServiceQuote }, "✕")),
      el("p", {}, "Quote " + (j.number || "") + " for " + money2(j.total) + " inc GST " + (j.sent ? "has been emailed to " + j.email + "." : "has been created. " + (j.error || ""))),
      (j.skipped || []).length ? el("p", { class: "muted small" }, "Some parts couldn't be priced online, so we'll follow up on those.") : null,
      el("p", { class: "muted small" }, "Accept the quote from the email or from Estimates on this page, then press Book on the machine to choose a time."),
      el("button", { class: "btn primary", type: "button", onclick: closeServiceQuote }, "Done")].filter(Boolean));
  } catch (e) {
    msg.className = "msg err"; msg.textContent = e.message; btn.disabled = false;
  }
}

// ---------- staff: Service kits (annual and 6-month PM kits, fixed prices, hours) ----------
async function renderKits() {
  const v = $("#view-kits");
  if (!state.staff) { v.replaceChildren(); return; }
  v.replaceChildren(el("div", { class: "head" }, el("h1", {}, "Service kits")), el("p", { class: "muted" }, "Loading…"));
  const [{ data, error }, cov] = await Promise.all([sb.from("service_kits").select("*").order("priority").order("id"), sb.rpc("service_kit_coverage")]);
  if (error) { v.replaceChildren(el("p", { class: "msg err" }, "Couldn't load the kits: " + error.message)); return; }
  const kits = data || [], c = cov?.data || {}, used = c.kits || {};
  const unc = (c.uncovered || []).filter((u) => /^(mim|mut|bro|epi|rol)/i.test(u.brand || ""));
  v.replaceChildren(...[
    el("div", { class: "head" }, el("h1", {}, "Service kits"),
      el("button", { class: "btn", type: "button", onclick: async () => {
        const { error: e } = await sb.from("service_kits").insert({ name: "New kit", brand: "Mimaki", models: [], priority: 100 });
        if (e) alert(e.message); else renderKits(); } }, "+ New kit")),
    el("p", { class: "muted small" }, "Each kit is the hours on site and the parts for one model family; its price is worked out as hours × " + money2(STD_LABOUR) + " + parts (callout separate, on-site visits only). Customers see ",
      el("b", {}, "Quote me"), " on a machine only when its kit is ", el("b", {}, "approved"),
      ". The 6-month kit is the caps, wipers and absorbers only; leave its hours blank to offer annual only. Part prices are ex GST and are what the quote uses. A callout is added once per visit. Models are matched on letters and digits, so “CJV150” matches CJV150-160; lower priority numbers are checked first."),
    unc.length ? el("details", { class: "kb" }, el("summary", {}, unc.length + " customer models have no kit yet"),
      el("p", { class: "small" }, unc.map((u) => u.brand + " " + (u.model || "(no model)") + " ×" + u.n).join(" · "))) : null,
    ...kits.map((k) => kitCard(k, used[k.id] || 0))].filter(Boolean));
}
/* Parts finder for a kit: the model's parts from the Mimaki price list, a search, the OneDrive parts lists for the
   model (rank A = periodic replacement) and the Mimaki Australia supply page (consumables). Tick parts, then add them. */
function kitFinder(d, key, onAdd) {
  const box = el("div", { class: "kit-finder", hidden: true });
  const models = () => String(Array.isArray(d.models) ? d.models.join(",") : d.models || "").split(",").map((s) => s.trim()).filter(Boolean);
  let rows = [], msg = "";
  const status = el("p", { class: "muted small kf-msg" });
  const list = el("div", { class: "kf-list" });
  const say = (m) => { msg = m; status.textContent = m; };
  const merge = (items, src) => {
    for (const it of items) {
      if (!it.pn) continue;
      const ex = rows.find((r) => r.pn === it.pn);
      if (ex) { ex.src = [...new Set([...ex.src, src])]; if (it.rank && !ex.rank) ex.rank = it.rank; if (it.qty > ex.qty) ex.qty = it.qty; if (!ex.name && it.name) ex.name = it.name; if (it.tick) ex.tick = true; if (it.section && !ex.section) ex.section = it.section; }
      else rows.push({ pn: it.pn, name: it.name || "", qty: it.qty || 1, rank: it.rank || "", section: it.section || "", src: [src], tick: !!it.tick, ex: it.ex ?? null, cost: it.cost ?? null });
    }
  };
  const prices = async () => {
    const need = rows.filter((r) => r.ex == null).map((r) => r.pn);
    for (let i = 0; i < need.length; i += 100) {
      const { data } = await sb.from("part_prices").select("pn,name,rrp,cost").in("pn", need.slice(i, i + 100));
      for (const p of data || []) { const r = rows.find((x) => x.pn === p.pn); if (r) { r.ex = p.rrp != null && +p.rrp > 0 ? +p.rrp : null; r.cost = p.cost; if (p.name && (!r.name || r.src.includes("Parts list"))) r.name = p.name; } }
    }
  };
  const draw = () => {
    const inKit = new Set((d[key] || []).map((p) => p.pn));
    const order = (r) => (r.rank === "A" ? 0 : r.tick ? 1 : r.src.includes("Supply page") ? 2 : 3);
    const shown = rows.slice().sort((a, b) => order(a) - order(b) || a.pn.localeCompare(b.pn));
    list.replaceChildren(shown.length ? el("table", { class: "tbl sub kf-tbl" },
      el("thead", {}, el("tr", {}, ...["", "Part no.", "Name", "Qty", "Ex GST", "Found in"].map((h) => el("th", {}, h)))),
      el("tbody", {}, ...shown.map((r) => el("tr", { class: inKit.has(r.pn) ? "off" : "" },
        el("td", {}, inKit.has(r.pn) ? el("span", { class: "small muted" }, "in kit") : el("input", { type: "checkbox", checked: r.tick, onchange: (e) => { r.tick = e.target.checked; } })),
        el("td", { class: "mono small" }, r.pn),
        el("td", {}, r.name || "", r.rank ? el("span", { class: "pill " + (r.rank === "A" ? "ok" : "soon"), title: r.rank === "A" ? "Rank A: periodic replacement" : "Rank " + r.rank }, " " + r.rank) : null,
          r.section ? el("div", { class: "muted small" }, r.section) : null),
        el("td", {}, el("input", { class: "field n kf-qty", type: "number", min: 1, value: r.qty, oninput: (e) => (r.qty = Math.max(1, Math.round(+e.target.value || 1))) })),
        el("td", { class: "n" }, r.ex != null ? money2(r.ex) : el("span", { class: "muted small", title: r.cost != null ? "Mimaki cost " + money2(r.cost) : "" }, r.cost != null ? "cost " + money2(r.cost) : "—")),
        el("td", { class: "muted small" }, r.src.join(", ")))))) : el("p", { class: "muted small" }, "No parts yet. Search, or scan the parts lists."));
  };
  const run = async (label, fn) => { say(label); try { await fn(); await prices(); say(msg === label ? rows.length + " parts found. Tick the ones to add." : msg); } catch (e) { say((e && e.message) || "Something went wrong"); } draw(); };
  const tool = async (p) => { const { data, error } = await sb.rpc("staff_kit_tool", { p }); if (error) throw new Error(error.message); if (!data || data.ok === false) throw new Error((data && data.error) || "The tool didn't answer"); return data; };
  const search = el("input", { class: "field", type: "search", placeholder: "Search part no. or name, e.g. wiper, damper, SPA-0271" });
  let timer = 0;
  search.oninput = () => { clearTimeout(timer); timer = setTimeout(() => run("Searching…", async () => {
    const { data, error } = await sb.rpc("kit_part_search", { q: search.value, models: models(), lim: 60 });
    if (error) throw new Error(error.message);
    merge((data || []).map((p) => ({ pn: p.pn, name: p.name, ex: p.rrp != null && +p.rrp > 0 ? +p.rrp : null, cost: p.cost })), "Price list");
  }), 300); };
  const supply = el("input", { class: "field", type: "url", placeholder: "https://www.mimakiaus.com.au/product/…/supply.html", value: d.supply_url || "", oninput: (e) => (d.supply_url = e.target.value) });
  box.load = () => run("Looking up parts for " + (models().join(", ") || "this kit") + "…", async () => {
    const { data, error } = await sb.rpc("kit_part_search", { q: "", models: models(), lim: 200 });
    if (error) throw new Error(error.message);
    merge((data || []).map((p) => ({ pn: p.pn, name: p.name, ex: p.rrp != null && +p.rrp > 0 ? +p.rrp : null, cost: p.cost })), "Price list");
  });
  box.append(
    el("div", { class: "kf-tools" },
      el("label", { class: "f" }, el("span", { class: "small muted" }, "Search the Mimaki price list"), search),
      el("div", { class: "kf-btns" },
        el("button", { class: "btn small", type: "button", onclick: () => run("Scanning OneDrive parts lists for " + models().join(", ") + "…", async () => {
          const f = await tool({ op: "kit_manuals", models: models() });
          const files = (f.files || []).filter((x) => x.score >= 2).slice(0, 3);
          if (!files.length) { msg = "No parts list found in OneDrive for " + models().join(", ") + "."; return; }
          for (const file of files) {
            say("Reading " + file.name + "…");
            const r = await tool({ op: "kit_manual_parts", itemId: file.id });
            merge((r.parts || []).filter((p) => /^(MP-|SP[ABC]?-|SP-|ML|FL)/.test(p.pn)).map((p) => {
              const q = String(p.name || "").match(/\s(\d{1,3})\s*$/);
              return { pn: p.pn, name: String(p.name || "").replace(/\s\d{1,3}\s*$/, "").replace(/\s+(JFX|UJF|UCJV|TxF|CJV|JV|\d{3}).*$/i, "").trim(), qty: q ? +q[1] : 1, rank: p.rank, tick: p.rank === "A" };
            }), "Parts list");
          }
          msg = "Read " + files.map((x) => x.name).join(", ") + ". Rank A parts (periodic replacement) are ticked.";
        }) }, "Scan OneDrive parts lists"),
      )),
    el("div", { class: "kf-tools" },
      el("label", { class: "f" }, el("span", { class: "small muted" }, "Mimaki Australia supply page (consumables)"), supply),
      el("div", { class: "kf-btns" }, el("button", { class: "btn small", type: "button", onclick: () => run("Reading the Mimaki supply page…", async () => {
        if (!/mimakiaus\.com\.au/i.test(supply.value)) throw new Error("Paste the model's supply page link from mimakiaus.com.au first.");
        const r = await tool({ op: "mimaki_supply", url: supply.value.trim() });
        merge((r.items || []).filter((x) => !/ink$|^option/i.test(x.section)).map((x) => ({ pn: x.pn, name: x.name + (x.volume ? " (" + x.volume + ")" : ""), section: x.section, tick: false })), "Supply page");
        msg = (r.items || []).length + " items on the supply page (ink and options left out). Tick the consumables to include.";
      }) }, "Get consumables"))),
    status, list,
    el("div", { class: "kf-foot" },
      el("button", { class: "btn primary small", type: "button", onclick: () => {
        const inKit = new Set((d[key] || []).map((p) => p.pn));
        const pick = rows.filter((r) => r.tick && !inKit.has(r.pn));
        if (!pick.length) { say("Tick at least one part that isn't in the kit yet."); return; }
        onAdd(pick.map((r) => ({ pn: r.pn, name: r.name, qty: r.qty, ex: r.ex, ...(r.ex == null && r.cost != null ? { note: "Mimaki cost " + money2(r.cost) + "; set the price" } : {}) })));
        pick.forEach((r) => (r.tick = false)); say(pick.length + " part" + (pick.length === 1 ? "" : "s") + " added. Save the kit to keep them."); draw();
      } }, "Add ticked parts to this kit"),
      el("button", { class: "btn ghost small", type: "button", onclick: () => (box.hidden = true) }, "Close")));
  return box;
}
function kitCard(k, nMachines) {
  const d = JSON.parse(JSON.stringify(k));
  const note = el("span", { class: "saved" });
  const priceA = el("output", { class: "kit-price" }), priceS = el("output", { class: "kit-price" });
  const recalc = () => {
    const unA = (d.annual_parts || []).filter((p) => p.ex == null || p.ex === "").length, unS = (d.six_parts || []).filter((p) => p.ex == null || p.ex === "").length;
    const show = (box, hours, parts, un, none) => box.replaceChildren(...(none ? [el("span", { class: "muted" }, none)] : [
      el("b", {}, money2(kitPrice(hours, parts))), " ",
      el("span", { class: "muted small" }, (+hours || 0) + " h × " + money2(STD_LABOUR) + " = " + money2((+hours || 0) * STD_LABOUR) + " + parts " + money2(kitPartsTotal(parts)) + (un ? " · " + un + " part" + (un === 1 ? "" : "s") + " not priced yet" : ""))]));
    show(priceA, d.annual_hours, d.annual_parts, unA, (d.annual_hours === "" || d.annual_hours == null) && !kitPartsTotal(d.annual_parts) ? "Add the hours and part prices" : null);
    show(priceS, d.six_hours, d.six_parts, unS, +d.six_hours > 0 ? null : "No 6-month service (enter 6-month hours to offer one)");
  };
  const inp = (key, attrs = {}) => el("input", { class: "field", value: d[key] ?? "", ...attrs, oninput: (e) => { d[key] = e.target.value; recalc(); } });
  const partsEditor = (key, title) => {
    const box = el("div", { class: "kit-pbox" });
    const finder = kitFinder(d, key, (rows) => { for (const r of rows) { const ex = (d[key] = d[key] || []).find((p) => p.pn === r.pn); if (ex) ex.qty = Math.max(+ex.qty || 1, r.qty); else d[key].push(r); } draw(); recalc(); });
    const draw = () => box.replaceChildren(...[el("h4", {}, title),
      el("table", { class: "tbl sub kit-parts" },
        el("thead", {}, el("tr", {}, ...["Part no.", "Name", "Qty", "Ex GST each", "Note", ""].map((h) => el("th", {}, h)))),
        el("tbody", {}, ...(d[key] || []).map((p, i) => el("tr", {},
          el("td", {}, el("input", { class: "field", value: p.pn || "", oninput: (e) => (p.pn = e.target.value.trim()) })),
          el("td", {}, el("input", { class: "field", value: p.name || "", oninput: (e) => (p.name = e.target.value) })),
          el("td", {}, el("input", { class: "field n", type: "number", min: 1, value: p.qty ?? 1, oninput: (e) => { p.qty = Math.max(1, Math.round(+e.target.value || 1)); recalc(); } })),
          el("td", {}, el("input", { class: "field n" + (p.ex == null || p.ex === "" ? " need" : ""), type: "number", step: "0.01", min: 0, value: p.ex ?? "", placeholder: "price",
            oninput: (e) => { p.ex = e.target.value === "" ? null : +e.target.value; e.target.classList.toggle("need", e.target.value === ""); recalc(); } })),
          el("td", {}, el("input", { class: "field", value: p.note || "", oninput: (e) => (p.note = e.target.value) })),
          el("td", {}, el("button", { class: "btn ghost small", type: "button", onclick: () => { d[key].splice(i, 1); draw(); recalc(); } }, "Remove")))))),
      el("div", { class: "kit-addrow" },
        el("button", { class: "btn small", type: "button", onclick: () => { finder.hidden = !finder.hidden; if (!finder.hidden && !finder.dataset.loaded) { finder.dataset.loaded = "1"; finder.load(); } } }, "+ Add part"),
        el("button", { class: "btn ghost small", type: "button", onclick: () => { (d[key] = d[key] || []).push({ pn: "", name: "", qty: 1, ex: null }); draw(); } }, "Blank row")),
      finder,
      key === "six_parts" ? el("button", { class: "btn ghost small", type: "button", onclick: () => {
        const cap = (d.annual_parts || []).filter((p) => /cap|wip|absorb|pad|felt|foam|pouch/i.test(p.name || ""));
        d.six_parts = JSON.parse(JSON.stringify(cap)); draw(); recalc(); } }, "Copy caps / wipers / absorbers from the annual kit") : null].filter(Boolean));
    draw(); return box;
  };
  queueMicrotask(recalc);
  const approved = el("input", { type: "checkbox", checked: !!d.approved, onchange: (e) => (d.approved = e.target.checked) });
  const save = async (btn) => {
    const num = (x) => (x === "" || x == null ? null : +x);
    const missing = [...(d.annual_parts || []), ...(d.six_parts || [])].filter((p) => !p.pn || p.ex == null || p.ex === "" || isNaN(+p.ex));
    if (d.approved && missing.length) { note.className = "saved msg err"; note.textContent = "Price every part (and give it a part number) before approving: " + missing.map((p) => p.pn || p.name || "blank row").join(", "); return; }
    if (d.approved && num(d.annual_hours) == null) { note.className = "saved msg err"; note.textContent = "Add the annual hours before approving."; return; }
    const clean = (arr) => (arr || []).filter((p) => p.pn || p.name).map((p) => ({ pn: String(p.pn || "").trim(), name: String(p.name || "").trim(), qty: Math.max(1, Math.round(+p.qty || 1)), ex: p.ex == null || p.ex === "" ? null : Math.round(+p.ex * 100) / 100, ...(p.note ? { note: String(p.note) } : {}) }));
    const row = { name: String(d.name || "").trim() || "Kit", brand: String(d.brand || "").trim(), priority: Math.round(+d.priority || 100),
      models: String(Array.isArray(d.models) ? d.models.join(",") : d.models || "").split(",").map((s) => s.trim()).filter((s, i, a) => s || a.length === 1),
      exclude: String(Array.isArray(d.exclude) ? d.exclude.join(",") : d.exclude || "").split(",").map((s) => s.trim()).filter(Boolean),
      annual_fee: kitPrice(d.annual_hours, d.annual_parts), six_fee: +d.six_hours > 0 ? kitPrice(d.six_hours, d.six_parts) : null, // the database works these out too
      annual_hours: num(d.annual_hours), six_hours: num(d.six_hours),
      annual_parts: clean(d.annual_parts), six_parts: clean(d.six_parts), approved: !!d.approved, notes: d.notes || null, supply_url: String(d.supply_url || "").trim() || null,
      updated_at: new Date().toISOString(), updated_by: state.user?.email || null };
    if (!row.models.length) row.models = [""];
    btn.disabled = true; note.className = "saved"; note.textContent = "Saving…";
    const { error } = await sb.from("service_kits").update(row).eq("id", k.id);
    btn.disabled = false;
    if (error) { note.className = "saved msg err"; note.textContent = "Not saved: " + error.message; return; }
    const { data: fresh } = await sb.from("service_kits").select("annual_fee,six_fee").eq("id", k.id).maybeSingle();
    Object.assign(k, row, fresh || {}); note.className = "saved"; note.textContent = "Saved";
    summary.replaceChildren(...summaryBits(k, nMachines));
  };
  const summary = el("summary", {}, ...summaryBits(k, nMachines));
  const delBox = el("span", {});
  const askDelete = () => delBox.replaceChildren(el("span", { class: "small" }, "Delete this kit for good? "),
    el("button", { class: "btn danger small", type: "button", onclick: async () => { const { error } = await sb.from("service_kits").delete().eq("id", k.id); if (error) note.textContent = error.message; else renderKits(); } }, "Yes, delete"),
    el("button", { class: "btn ghost small", type: "button", onclick: () => delBox.replaceChildren() }, "No"));
  return el("details", { class: "kb kitcard" }, summary,
    el("div", { class: "fgrid kit-grid" },
      el("label", { class: "f" }, "Kit name", inp("name")),
      el("label", { class: "f" }, "Brand", inp("brand")),
      el("label", { class: "f" }, "Models (comma separated)", el("input", { class: "field", value: (d.models || []).join(", "), oninput: (e) => (d.models = e.target.value) })),
      el("label", { class: "f" }, "Not these models", el("input", { class: "field", value: (d.exclude || []).join(", "), oninput: (e) => (d.exclude = e.target.value) })),
      el("label", { class: "f" }, "Priority", inp("priority", { type: "number" })),
      el("label", { class: "f" }, "Annual service hours on site", inp("annual_hours", { type: "number", step: "0.5", min: 0, placeholder: "e.g. 3" })),
      el("div", { class: "f" }, el("span", {}, "Annual service price (ex GST, worked out)"), priceA),
      el("label", { class: "f" }, "6-month service hours on site (blank = none)", inp("six_hours", { type: "number", step: "0.5", min: 0, placeholder: "e.g. 1.5" })),
      el("div", { class: "f" }, el("span", {}, "6-month service price (ex GST, worked out)"), priceS)),
    el("p", { class: "muted small" }, "Prices are hours × " + money2(STD_LABOUR) + " per hour + the kit parts below. The callout isn't included: it's added once per visit, only when the customer wants us on site."),
    partsEditor("annual_parts", "Annual PM kit"),
    partsEditor("six_parts", "6-month kit (caps, wipers, absorbers)"),
    el("label", { class: "f" }, el("span", { class: "small muted" }, "Notes (staff only)"), el("textarea", { class: "field", rows: 2, oninput: (e) => (d.notes = e.target.value) }, d.notes || "")),
    k.source ? el("p", { class: "muted small" }, "Source: " + k.source) : null,
    el("div", { class: "kit-actions" },
      el("label", { class: "chk" }, approved, " Approved: customers can get this quote"),
      el("button", { class: "btn primary", type: "button", onclick: (e) => save(e.currentTarget) }, "Save"), note,
      el("button", { class: "btn ghost small", type: "button", onclick: askDelete }, "Delete kit"), delBox));
}
function summaryBits(k, n) {
  const priced = [...(k.annual_parts || []), ...(k.six_parts || [])].every((p) => p.ex != null);
  return [el("b", {}, k.name), " ",
    el("span", { class: "pill " + (k.approved ? "ok" : "soon") }, k.approved ? "Approved" : "Draft"), " ",
    el("span", { class: "muted small" }, [money2(k.annual_fee) + " annual" + (k.annual_hours ? " · " + k.annual_hours + " h" : " · hours not set"),
      k.six_fee != null ? money2(k.six_fee) + " 6-month" + (k.six_hours ? " · " + k.six_hours + " h" : "") : "no 6-month",
      (k.annual_parts || []).length + " annual parts", priced ? null : "some parts unpriced", n + " customer machine" + (n === 1 ? "" : "s")].filter(Boolean).join(" · "))];
}

// ---------- routing ----------
function route() {
  if (!state.user) return;
  const h = location.hash.replace(/^#/, "") || "machines";
  if (h === "signout") { signOut(); return; }
  // App-only logins have no machines or booking: send them to their first app.
  if (state.appsOnly && !state.staff && (state.fluteAccess || state.vectorAccess)) { location.replace(state.fluteAccess ? "/flute/" : "/vector/"); return; }
  const top = h.split("/")[0];
  window.HDNav?.setActive(navHost(), top === "machine" || top === "add-machine" ? "machines" : top === "reports" ? "reports" : top === "kb" ? "intranet" : top === "book" ? "contact" : top);
  if (h === "book" || h.startsWith("book/")) { show("view-book"); renderBook(decodeURIComponent(h.slice(5))); }
  else if (h.startsWith("machine/")) { show("view-machine"); renderMachine(decodeURIComponent(h.slice(8))); }
  else if (h === "add-machine") { show("view-add"); renderAddMachine(); }
  else if (h === "reports") { show("view-reports"); renderReports(); }
  else if (h === "kb" && state.intranet) { show("view-kb"); renderKb(); }
  else if (h === "customers" && state.staff) { show("view-customers"); renderCustomers(); }
  else if (h === "service-kits" && state.staff) { show("view-kits"); renderKits(); }
  else if (h === "contact") { show("view-contact"); renderContact(); }
  else { show("view-machines"); renderMachines(); }
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);
$("#machineSearch").addEventListener("input", renderMachines);
["#mfCust", "#mfBrand", "#mfModel"].forEach((id) => $(id).addEventListener("change", renderMachines));
$("#mfClear").addEventListener("click", () => { $("#machineSearch").value = ""; $("#mfCust").value = ""; $("#mfBrand").value = ""; $("#mfModel").value = ""; renderMachines(); $("#machineSearch").focus(); });
// keep the filter bar just under the menu: track the menu's height
{ const setNavH = () => { const n = document.getElementById("hd-nav"); document.documentElement.style.setProperty("--navh", (n && getComputedStyle(n).position === "sticky" ? n.offsetHeight : 0) + "px"); };
  addEventListener("resize", setNavH); setTimeout(setNavH, 300); setInterval(setNavH, 3000); }
$("#kbSearch").addEventListener("input", renderKb);
$("#custSearch").addEventListener("input", renderCustomers);

// ---------- view counter (one per page load, shown in the footer) ----------
sb.rpc("count_view", { p: "home" }).then(({ data }) => {
  if (typeof data !== "number" && typeof data !== "string") return;
  const v = $("#viewCount");
  v.textContent = "Views: " + Number(data).toLocaleString("en-AU");
  v.hidden = false;
});

// ---------- boot ----------
async function boot() {
  $("#contactEmail").textContent = cfg.contactEmail;
  $("#contactEmail").href = "mailto:" + cfg.contactEmail;
  $("#bookingLink").href = cfg.bookingUrl;
  $("#siteLink").href = cfg.websiteUrl;
  if (!state.user) {
    const { data } = await sb.auth.getSession();
    state.user = data.session?.user || null;
  }
  if (!state.user) {
    if (location.hash === "#signout") history.replaceState(null, "", location.pathname);
    drawNav(); show("login"); return;
  }
  drawNav(); show("loading");
  try {
    await loadCore();
    const { data: sd } = await sb.auth.getSession();
    setAccessCookie(sd.session);
    let nx = null; try { nx = localStorage.getItem("hd_next"); localStorage.removeItem("hd_next"); } catch (e) {}
    if (okNext(nx)) { location.replace(nx); return; }
    route();
  }
  catch (e) {
    show("view-machines");
    $("#machineList").replaceChildren(el("div", { class: "card empty" }, "Something went wrong loading your machines. Please try again shortly."));
  }
}
boot();
