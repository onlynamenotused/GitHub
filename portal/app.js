import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const cfg = window.PORTAL_CONFIG || {};
const sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" }
});

const $ = (s) => document.querySelector(s);
const views = ["loading", "login", "view-machines", "view-machine", "view-add", "view-reports", "view-kb", "view-contact", "view-customers", "view-book"];
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
  msg.textContent = "Check your inbox for a sign-in link from Highway Digital. It can take a minute to arrive.";
});
async function signOut() { await sb.auth.signOut(); setAccessCookie(null); history.replaceState(null, "", location.pathname); location.reload(); }

// ---------- shared menu (nav.js) ----------
const navHost = () => $("#hd-nav");
function drawNav(active) {
  window.HDNav?.render(navHost(), state.user
    ? { signedIn: true, email: state.user.email, staff: state.staff, intranet: state.intranet, kb: state.kbAccess || isSupervisor(), cat: state.catAccess, supervisor: isSupervisor() || (state.staff && (state.supervisors || []).length > 0), active }
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
const okNext = (p) => typeof p === "string" && /^\/(kb|catalogue)(\/[A-Za-z0-9._\-\/]*)?$/.test(p);
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
    sb.from("clients").select("id,name,kb_access,catalogue_access").order("name"),
    sb.from("machines").select("*").eq("status", "active").order("brand").order("model"),
    sb.rpc("has_kb_access"),
    sb.rpc("is_staff"),
    sb.rpc("has_catalogue_access"),
    sb.rpc("is_intranet"),
    sb.from("machine_files").select("id,kind,name,machine_id,param_date,modified,size,fw").order("param_date", { ascending: false }),
    sb.from("fb_invoices").select("*").order("issued", { ascending: false }).limit(60),
    sb.from("fb_estimates").select("*").order("issued", { ascending: false }).limit(60),
    sb.from("supervisors").select("id,name,bill_to")
  ]);
  const [mf, inv, est, sv] = rest;
  state.supervisors = sv?.data || [];
  if (c.error) throw c.error;
  if (m.error) throw m.error;
  state.clients = c.data; state.machines = m.data;
  state.kbAccess = k.data === true; state.staff = s.data === true;
  state.catAccess = g.data === true;
  state.intranet = it.data === true;
  state.files = mf.data || []; state.invoices = inv.data || []; state.estimates = est.data || [];
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
function renderMachines() {
  const q = norm($("#machineSearch").value);
  const list = state.machines.filter((m) =>
    !q || [m.brand, m.model, m.serial, m.site, m.location, m.sub_category].some((v) => norm(v).includes(q)));
  $("#clientTitle").textContent = state.staff ? "Customer Assets" : isSupervisor() ? supName() + " fleet" : state.clients.length === 1 ? state.clients[0].name : "My machines";

  const counts = { over: 0, soon: 0, ok: 0 };
  for (const m of state.machines) { const s = pmStatus(m).cls; if (s in counts) counts[s]++; }
  $("#stats").replaceChildren(
    el("div", { class: "stat" }, el("div", { class: "n" }, state.machines.length), el("div", { class: "l" }, "Machines")),
    el("div", { class: "stat" }, el("div", { class: "n" }, counts.over), el("div", { class: "l" }, "Service overdue")),
    el("div", { class: "stat" }, el("div", { class: "n" }, counts.soon), el("div", { class: "l" }, "Due in the next 30 days"))
  );

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
  if (!list.length) { box.replaceChildren(el("div", { class: "empty" }, "No machines match that search.")); return; }
  renderBilling();
  box.replaceChildren(...list.map((m) => {
    const s = pmStatus(m);
    return el("button", { class: "mcard", onclick: () => (location.hash = "#machine/" + encodeURIComponent(m.id)) },
      el("span", { class: "model" }, machineName(m)),
      el("span", { class: "muted small" }, [m.sub_category || m.category, m.serial && "SN " + m.serial].filter(Boolean).join(" · ")),
      (state.clients.length > 1 || state.staff) ? el("span", { class: "small cust" }, clientName(m.client_id)) : null,
      el("span", { class: "muted small" }, m.location || m.site || ""),
      el("span", { class: "pill " + s.cls }, s.label + (m.pm_next_due ? " · " + fmtDate(m.pm_next_due) : "")),
      m.added_via === "portal" && m.desk_seen === false ? el("span", { class: "muted small" }, "Added by you · we'll check the details") : null,
      filesFor(m).length ? el("span", { class: "muted small" }, "📄 " + filesFor(m).length + " parameter/log file" + (filesFor(m).length > 1 ? "s" : "")) : null
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
function renderBilling() {
  const box = $("#billing"); if (!box) return;
  const inv = (state.invoices || []).slice(0, 12), est = (state.estimates || []).slice(0, 12);
  const owing = (state.invoices || []).filter((r) => r.status !== "paid").length;
  box.replaceChildren(
    el("div", { class: "card" },
      el("div", { class: "bhead" }, el("h2", {}, "Recent invoices"), owing ? el("span", { class: "pill over" }, owing + " outstanding") : null),
      inv.length ? billingTable(inv, "inv") : el("p", { class: "muted small" }, "No invoices yet."),
      el("p", { class: "muted small" }, "Pay now and View open your FreshBooks client area. Sign in there with this email address to see the full invoice and pay by card.")),
    el("div", { class: "card" },
      el("h2", {}, "Estimates"),
      est.length ? billingTable(est, "est") : el("p", { class: "muted small" }, "No estimates have been sent to you yet."))
  );
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
        el("p", {}, el("span", { class: "pill " + s.cls }, s.label)),
        el("dl", { class: "kv" },
          el("dt", {}, "Customer"), el("dd", {}, client?.name || "—"),
          el("dt", {}, "Serial"), el("dd", {}, m.serial || "—"),
          el("dt", {}, "Type"), el("dd", {}, [m.category, m.sub_category].filter(Boolean).join(" · ") || "—"),
          m.ink_set && el("dt", {}, "Ink set"), m.ink_set && el("dd", {}, m.ink_set),
          el("dt", {}, "Location"), el("dd", {}, m.location || m.site || "—"),
          el("dt", {}, "Last service"), el("dd", {}, fmtDate(m.pm_last_done)),
          el("dt", {}, "Next service due"), el("dd", {}, fmtDate(m.pm_next_due)),
          m.pm_interval_months && el("dt", {}, "Service interval"), m.pm_interval_months && el("dd", {}, "Every " + m.pm_interval_months + " months"),
          m.warranty_end && el("dt", {}, "Warranty until"), m.warranty_end && el("dd", {}, fmtDate(m.warranty_end)),
          m.added_via === "portal" && el("dt", {}, "Added"), m.added_via === "portal" && el("dd", {}, m.desk_seen === false ? "By you, waiting for us to check" : "By you, checked by Highway Digital")
        ),
        el("p", { style: "display:flex;gap:8px;flex-wrap:wrap" }, el("a", { class: "btn primary", href: state.staff ? cfg.bookingUrl : "#book/" + encodeURIComponent(m.id), target: state.staff ? "_blank" : null, rel: state.staff ? "noopener" : null }, "Book a service"), el("a", { class: "btn", href: mailtoFor(m) }, "Email us about this machine"))
      ),
      el("div", { class: "card" }, el("h2", {}, "Manuals, drivers & software"), relRes)
    ),
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
  if (!renderCustomers.sup) { renderCustomers.sup = true; renderSupervisorsAdmin($("#supAdmin")); }
  if (!state.access) {
    body.replaceChildren(el("tr", {}, el("td", { colspan: "5", class: "muted" }, "Loading…")));
    const { data, error } = await sb.from("portal_access").select("client_id,email");
    if (error) { body.replaceChildren(el("tr", {}, el("td", { colspan: "5", class: "msg err" }, "Couldn't load customers."))); return; }
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
      tick("catalogue_access", "Parts Catalogue")));
    if (open) {
      const cell = el("td", { colspan: "5", class: "panelcell" }, el("p", { class: "muted small" }, "Loading…"));
      rows.push(el("tr", { class: "panelrow" }, cell));
      renderManage(c, cell);
    }
  }
  body.replaceChildren(...rows);
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
  const { data, error } = await sb.from("clients").insert({ name }).select("id,name,kb_access,catalogue_access").single();
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
const bk = { slot: null, ready: false };

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
const bkKind = () => (document.querySelector('input[name="bkKind"]:checked') || {}).value || "service";
async function loadSlots() {
  const box = $("#bkSlots");
  bk.slot = null; $("#bkSubmit").disabled = true; $("#bkPicked").hidden = true;
  box.replaceChildren(el("p", { class: "muted small" }, "Loading available times…"));
  const since = new Date(Date.now() + 12 * 3600e3).toISOString();
  const { data, error } = await sb.from("portal_slots").select("slot_start,slot_end").eq("hours", KIND_HOURS[bkKind()]).gt("slot_start", since).order("slot_start").limit(40);
  if (error) { box.replaceChildren(el("p", { class: "msg err" }, "Couldn't load available times. Please try again shortly.")); return; }
  if (!data.length) {
    box.replaceChildren(el("p", { class: "muted" }, "No online times are available right now. Please call ", el("a", { href: "tel:1300880815" }, "1300 880 815"),
      " or email ", el("a", { href: "mailto:" + cfg.contactEmail }, cfg.contactEmail), " and we'll find a time."));
    return;
  }
  const days = new Map();
  for (const s of data) { const k = dayKey(s.slot_start); if (!days.has(k)) days.set(k, []); days.get(k).push(s); }
  box.replaceChildren(...[...days.values()].map((list) => el("div", { class: "sday" },
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
    return el("div", { class: "bkitem" },
      el("b", {}, fmtWhen(b.slot_start, { weekday: "short", day: "numeric", month: "short" }) + ", " + timeLbl(b.slot_start)),
      el("div", { class: "muted small" }, [KIND_LABEL[b.kind], m && machineName(m)].filter(Boolean).join(" · ")),
      el("span", { class: "pill " + cls }, t + (b.ticket_num && b.status === "booked" ? " · job " + b.ticket_num : "")));
  }));
}
$("#bookForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#bkMsg"), btn = $("#bkSubmit");
  const name = $("#bkName").value.trim(), phone = $("#bkPhone").value.trim();
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
const JOB_KINDS = [["fault", "Fault or repair"], ["service", "Scheduled service"], ["install", "Installation"], ["other", "Something else"]];
const isCustomer = () => !state.staff && state.clients.length > 0;

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
const money = (n) => "$" + (Number(n) || 0).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const KIND_NAMES = { service: "Service visit", install: "Installation", parts: "Parts order", fault: "Fault or repair", other: "Other" };
const rep = { data: null, loading: null, f: { from: "", to: "", client: "", machine: "", q: "", tab: "jobs" } };

async function loadReportData(force) {
  if (rep.data && !force) return rep.data;
  if (rep.loading) return rep.loading;
  rep.loading = (async () => {
    const [sr, tj, pj] = await Promise.all([
      sb.from("service_records").select("id,client_id,machine_id,number,issued,status,kind,po,notes,total_ex,total_inc,lines").order("issued", { ascending: false }),
      sb.rpc("supervisor_jobs"),
      sb.from("portal_jobs").select("id,client_id,machine_id,kind,description,error_code,status,ticket_num,created_at").order("created_at", { ascending: false })
    ]);
    if (sr.error) throw sr.error;
    const jobs = [];
    // Invoiced history (FreshBooks)
    for (const r of sr.data || []) {
      const lines = (r.lines || []).filter((l) => !/^(reports?|delivery)$/i.test(l.code || "") || Number(l.amount));
      const labour = lines.find((l) => /labou?r|day rate|hourly/i.test(l.code || ""));
      jobs.push({ key: "inv-" + r.id, ref: "Invoice " + r.number, date: r.issued, client_id: r.client_id, machine_id: r.machine_id, kind: r.kind,
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
        lines, amount: lines.reduce((s, l) => s + l.amount, 0), status: t.status, src: "ticket", error: t.error_code || "" });
    }
    for (const j of pj.data || []) if (j.status === "pending")
      jobs.push({ key: "p-" + j.id, ref: "Logged in portal", date: String(j.created_at).slice(0, 10), client_id: j.client_id, machine_id: j.machine_id,
        kind: j.kind, title: String(j.description || "").split("\n")[0], notes: j.description || "", detail: "", lines: [], amount: 0, status: "waiting", src: "portal", error: j.error_code || "" });
    jobs.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    rep.data = { jobs, invoicedCount: invoiced.size };
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
  if (!isSupervisor() && !state.staff) { v.replaceChildren(el("div", { class: "card empty" }, "Fleet reports are for vendor supervisor logins.")); return; }
  v.replaceChildren(el("div", { class: "head" }, el("h1", {}, "Fleet reports")), el("div", { class: "card center" }, el("span", { class: "spin" }), " Loading service history…"));
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
        [money(spend), "Billed ex GST"], [fleet.length, "Machines"], [overdue, "PM overdue"]]
      .map(([n, l]) => el("div", { class: "stat" }, el("div", { class: "n" }, n), el("div", { class: "l" }, l))));

  const tabs = [["jobs", "Job details"], ["parts", "Parts used"], ["trends", "Trends"], ["machines", "Machine stats"]];
  const tabBar = el("div", { class: "rtabs", role: "tablist" }, ...tabs.map(([k, l]) => el("button", { type: "button", role: "tab", class: "chipbtn", "aria-selected": String(f.tab === k), onclick: () => { f.tab = k; drawReports(); } }, l)));
  const body = f.tab === "parts" ? partsReport(jobs) : f.tab === "trends" ? trendsReport(jobs) : f.tab === "machines" ? machineReport(jobs, fleet) : jobsReport(jobs);
  v.replaceChildren(
    el("div", { class: "head" }, el("h1", {}, "Fleet reports"), el("span", { class: "muted small" }, supName() || "All supervised fleets")),
    el("p", { class: "muted small" }, "Service history for the customers whose support is contracted to Highway Digital through " + (supName() || "a vendor") + ": invoiced jobs from our accounts, plus open jobs from the service desk. Amounts are ex GST."),
    filters, kpis, tabBar, body);
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
    el("div", { class: "bhead" }, el("h2", {}, "Job details (" + jobs.length + ")"),
      el("button", { class: "btn small", type: "button", onclick: () => csvDownload("Fleet job details.csv", [["Date", "Ref", "Customer", "Machine", "Type", "Job", "Notes", "Parts", "Amount ex GST"],
        ...jobs.map((j) => [j.date, j.ref, cName(j.client_id), mLabel(j.machine_id), KIND_NAMES[j.kind] || j.kind, j.title, j.notes, j.lines.filter(isPart).map((l) => l.qty + "x " + l.code).join("; "), j.amount.toFixed(2)])]) }, "Download CSV")),
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
      el("button", { class: "btn small", type: "button", onclick: () => csvDownload("Fleet parts used.csv", [["Part", "Description", "Qty", "Times supplied", "Spend ex GST", "Last supplied", "Customers", "Machines"],
        ...list.map((p) => [p.code, p.desc, p.qty, p.orders, p.spend.toFixed(2), p.last, [...p.customers].join("; "), [...p.machines].join("; ")])]) }, "Download CSV")),
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
    el("div", { class: "card" }, el("h2", {}, "Service visits and repairs per month"),
      months.length > 1 ? el("p", { class: "muted small" }, b > a ? `Up: ${b} in the second half of this period against ${a} in the first.` : b < a ? `Down: ${b} in the second half of this period against ${a} in the first.` : "Steady across this period.") : null,
      bars(visits, (n) => String(n))),
    el("div", { class: "card" }, el("h2", {}, "Billed per month (ex GST)"), bars(spend, (n) => "$" + Math.round(n).toLocaleString("en-AU"))),
    el("div", { class: "card" }, el("h2", {}, "By customer"),
      el("table", { class: "tbl rtbl" }, el("thead", {}, el("tr", {}, el("th", {}, "Customer"), el("th", { class: "num" }, "Jobs"), el("th", { class: "num" }, "Billed ex GST"))),
        el("tbody", {}, ...[...byCust.entries()].sort((a, b) => b[1].s - a[1].s).map(([c, x]) => el("tr", {}, el("td", {}, c), el("td", { class: "num" }, x.n), el("td", { class: "num" }, money(x.s))))))),
    topCodes.length ? el("div", { class: "card" }, el("h2", {}, "Recurring error codes"), el("ul", { class: "links" }, ...topCodes.map(([c, n]) => el("li", {}, el("span", { class: "kind" }, n + "×"), c)))) : null);
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
    el("div", { class: "bhead" }, el("h2", {}, "Machine stats (" + rows.length + ")"),
      el("button", { class: "btn small", type: "button", onclick: () => csvDownload("Fleet machine stats.csv", [["Customer", "Machine", "Serial", "Installed", "Jobs", "Service visits", "Avg days between visits", "Parts fitted", "Billed ex GST", "Last job", "Next PM due", "PM status", "Firmware", "Parameter/log files", "Latest log"],
        ...rows.map((r) => [cName(r.m.client_id), machineName(r.m), r.m.serial || "", r.m.install_date || "", r.n, r.visits, r.gap ?? "", r.parts, r.spend.toFixed(2), r.last, r.m.pm_next_due || "", r.pm.label, r.fw, r.files, r.lastLog])]) }, "Download CSV")),
    el("div", { class: "tscroll" }, el("table", { class: "tbl rtbl" },
      el("thead", {}, el("tr", {}, ...["Machine", "Customer", "Jobs", "Visits", "Avg gap", "Parts", "Billed", "Last job", "Service", "Firmware / logs"].map((h) => el("th", { class: ["Jobs", "Visits", "Avg gap", "Parts", "Billed"].includes(h) ? "num" : null }, h)))),
      el("tbody", {}, ...rows.map((r) => el("tr", { class: "rrow", tabindex: 0, onclick: () => (location.hash = "#machine/" + encodeURIComponent(r.m.id)) },
        el("td", { "data-l": "Machine" }, el("b", {}, machineName(r.m)), el("br"), el("span", { class: "muted small" }, r.m.serial ? "SN " + r.m.serial : "")),
        el("td", { "data-l": "Customer" }, cName(r.m.client_id)), el("td", { class: "num", "data-l": "Jobs" }, r.n), el("td", { class: "num", "data-l": "Visits" }, r.visits),
        el("td", { class: "num", "data-l": "Avg gap" }, r.gap == null ? "—" : r.gap + " days"), el("td", { class: "num", "data-l": "Parts" }, r.parts),
        el("td", { class: "num", "data-l": "Billed" }, money(r.spend)), el("td", { "data-l": "Last job" }, fmtDate(r.last)),
        el("td", { "data-l": "Service" }, el("span", { class: "pill " + r.pm.cls }, r.pm.label + (r.m.pm_next_due ? " · " + fmtDate(r.m.pm_next_due) : ""))),
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
    return el("div", { class: "card", style: "margin-top:12px" },
      el("div", { class: "bhead" }, el("h3", {}, sup.name), el("span", { class: "muted small" }, "Bill to: " + (sup.bill_to || "—") + (sup.last_sync ? " · history updated " + new Date(sup.last_sync).toLocaleString("en-AU") : ""))),
      el("p", { class: "muted small" }, "Supervisor logins see every machine, job and service record for these customers, can log jobs and add machines for them, and get Fleet reports. Adding a login sends nothing."),
      el("label", { class: "check", style: "display:flex;gap:8px;align-items:flex-start;margin:4px 0 10px" },
        el("input", { type: "checkbox", checked: !!sup.catalogue_access, onchange: async (e) => {
          const on = e.target.checked; e.target.disabled = true;
          const { error } = await sb.from("supervisors").update({ catalogue_access: on }).eq("id", sup.id);
          e.target.disabled = false;
          if (error) { e.target.checked = !on; return flash(note, "Catalogue access not changed", false); }
          sup.catalogue_access = on; flash(note, on ? "Parts catalogue turned on for " + sup.name + " logins" : "Parts catalogue turned off for " + sup.name + " logins", true);
        } }),
        el("span", {}, "Parts catalogue access", el("br"), el("span", { class: "muted small" }, "Lets every " + sup.name + " login open the Parts Catalogue (prices ex/inc GST)."))),
      el("h3", {}, "Logins"),
      el("ul", { class: "links" }, ...logins.map((u) => el("li", {}, u.email + (u.full_name ? " (" + u.full_name + ")" : ""), " ",
        el("button", { class: "btn ghost small", type: "button", onclick: async () => { await sb.from("supervisor_access").delete().eq("supervisor_id", sup.id).eq("email", u.email); renderSupervisorsAdmin(host); } }, "Remove")))),
      el("form", { class: "inline", onsubmit: async (e) => { e.preventDefault(); if (!em.value.trim()) return;
        const { error } = await sb.from("supervisor_access").insert({ supervisor_id: sup.id, email: em.value.trim().toLowerCase(), full_name: fn.value.trim() || null });
        if (error) return flash(note, "Login not added", false); renderSupervisorsAdmin(host); } }, em, fn, el("button", { class: "btn small", type: "submit" }, "Add login")),
      el("h3", {}, "Customers (" + custs.length + ")"),
      el("ul", { class: "links" }, ...custs.map((x) => el("li", {}, cName(x.client_id), x.match_terms?.length ? el("span", { class: "muted small" }, "  matched on invoices by: " + x.match_terms.join(", ")) : "", " ",
        el("button", { class: "btn ghost small", type: "button", onclick: async () => { await sb.from("supervisor_clients").delete().eq("supervisor_id", sup.id).eq("client_id", x.client_id); renderSupervisorsAdmin(host); } }, "Remove")))),
      el("form", { class: "inline", onsubmit: async (e) => { e.preventDefault(); if (!pick.value) return;
        const cl = state.clients.find((x) => String(x.id) === pick.value);
        const { error } = await sb.from("supervisor_clients").insert({ supervisor_id: sup.id, client_id: Number(pick.value), match_terms: [norm(cl?.name || "")] });
        if (error) return flash(note, "Customer not added", false); renderSupervisorsAdmin(host); } }, pick, el("button", { class: "btn small", type: "submit" }, "Add customer")),
      el("p", {}, sync, " ", note));
  });
  host.replaceChildren(el("h2", { style: "margin-top:24px" }, "Vendor supervisors"), ...cards);
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
  const who = state.staff ? "Customer Assets" : isSupervisor() ? supName() + " fleet" : state.clients.map((c) => c.name).join(", ");
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
  const jobs = await loadJobs();
  const head = ["Date", "Reference", "Customer", "Machine", "Type", "Status", "Scheduled", "Problem / request", "Work done", "Parts used"];
  return [head, jobs.map((j) => [j.date || "", j.ref, clientName(j.client_id), machLabel(j.machine_id), j.type, j.status, j.scheduled || "", j.problem, j.work, j.parts])];
}
function exportMenu() {
  const msg = el("span", { class: "muted small", role: "status" });
  const go = (what, fmt) => async (e) => {
    e.preventDefault(); dd.open = false; msg.textContent = "Preparing…";
    try {
      const [head, rows] = what === "jobs" ? await jobExportRows() : machineExportRows();
      await exportTable(fmt, what === "jobs" ? "Highway Digital jobs" : "Highway Digital machines", what === "jobs" ? "Service jobs" : "Machines", head, rows);
      msg.textContent = "";
    } catch (er) { msg.textContent = "Export failed: " + (er.message || er); }
  };
  const item = (what, fmt, label) => el("button", { type: "button", class: "xopt", onclick: go(what, fmt) }, label);
  const dd = el("details", { class: "xmenu" }, el("summary", { class: "btn" }, "Export ▾"),
    el("div", { class: "xpanel" },
      el("div", { class: "xhd" }, "Machines (full asset details)"), item("machines", "xlsx", "Excel (.xlsx)"), item("machines", "csv", "CSV"), item("machines", "pdf", "PDF"),
      el("div", { class: "xhd" }, "All jobs (problem and work done)"), item("jobs", "xlsx", "Excel (.xlsx)"), item("jobs", "csv", "CSV"), item("jobs", "pdf", "PDF")));
  document.addEventListener("click", (e) => { if (dd.open && !dd.contains(e.target)) dd.open = false; });
  return el("span", { class: "xwrap" }, dd, msg);
}

// ---------- routing ----------
function route() {
  if (!state.user) return;
  const h = location.hash.replace(/^#/, "") || "machines";
  if (h === "signout") { signOut(); return; }
  const top = h.split("/")[0];
  window.HDNav?.setActive(navHost(), top === "machine" || top === "add-machine" ? "machines" : top === "reports" ? "reports" : top === "kb" ? "intranet" : top === "book" ? "contact" : top);
  if (h === "book" || h.startsWith("book/")) { show("view-book"); renderBook(decodeURIComponent(h.slice(5))); }
  else if (h.startsWith("machine/")) { show("view-machine"); renderMachine(decodeURIComponent(h.slice(8))); }
  else if (h === "add-machine") { show("view-add"); renderAddMachine(); }
  else if (h === "reports") { show("view-reports"); renderReports(); }
  else if (h === "kb" && state.intranet) { show("view-kb"); renderKb(); }
  else if (h === "customers" && state.staff) { show("view-customers"); renderCustomers(); }
  else if (h === "contact") { show("view-contact"); renderContact(); }
  else { show("view-machines"); renderMachines(); }
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);
$("#machineSearch").addEventListener("input", renderMachines);
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
