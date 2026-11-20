/* Highway Service Desk: build-your-own quote on the Parts Catalogue page.
   Added to the catalogue page by _worker.js for customer logins. Customers tick parts, choose parts-only or fitted
   by Highway Digital (callout worked out from the machine's location + hourly labour), and the quote is created in
   FreshBooks and emailed to them. Prices shown here are a guide; the server prices every line from the catalogue. */
(function () {
  "use strict";
  const Q = window.HDQ || {};
  if (!Q.customer) return;
  let data = null;
  try { data = DATA; } catch (e) { return; }   // the catalogue's own item list (global const)
  const LABOUR = 150, LS = "hd_quote_" + (Q.email || "");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const money = (n) => "$" + (+n || 0).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const keyOf = (pn, name) => (pn && pn !== "—" ? pn : name);
  const PRICE = new Map();
  for (const f of data) for (const it of f.items || []) {
    const k = f.brand + "|" + keyOf(it[0], it[1]);
    if (!PRICE.has(k)) PRICE.set(k, { brand: f.brand, pn: it[0], name: it[1], ic: it[2], ex: it[3] });
  }
  let cart = [];
  try { cart = JSON.parse(localStorage.getItem(LS) || "[]").filter((c) => PRICE.has(c.id)); } catch (e) { cart = []; }
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(cart)); } catch (e) {} };
  const inCart = (id) => cart.find((c) => c.id === id);

  // ---- intro strip + floating quote button
  const cat = document.getElementById("cat");
  if (!cat) return;
  const intro = document.createElement("div");
  intro.className = "hdq-intro";
  intro.innerHTML = '<div><b>Build your own quote.</b> Tap <span class="hdq-chip">+ Quote</span> on any part, then create the quote. ' +
    'Choose parts only, or have us fit them (callout + labour billed hourly). Your quote is emailed to you straight away.</div>' +
    '<button type="button" class="hdq-btn" data-hdq="open">Create a quote</button>';
  cat.parentNode.insertBefore(intro, cat);
  const fab = document.createElement("button");
  fab.type = "button"; fab.className = "hdq-fab"; fab.dataset.hdq = "open";
  document.body.appendChild(fab);
  function syncFab() {
    const n = cart.reduce((s, c) => s + c.qty, 0);
    fab.innerHTML = "🧾 Quote" + (n ? ' <span class="hdq-count">' + n + "</span>" : "");
    fab.hidden = !n;
  }

  // ---- "+ Quote" buttons on every priced row (re-added after each catalogue render)
  function decorate() {
    for (const tr of cat.querySelectorAll("tbody tr")) {
      if (tr.querySelector(".hdq-add")) continue;
      const brandEl = tr.closest(".brand"), h2 = brandEl && brandEl.querySelector("h2");
      const pnEl = tr.querySelector(".pn"), nameEl = tr.querySelector(".name");
      if (!h2 || !pnEl || !nameEl) continue;
      const name = (nameEl.childNodes[0] && nameEl.childNodes[0].nodeType === 3 ? nameEl.childNodes[0].textContent : nameEl.textContent).trim();
      const id = h2.textContent.trim() + "|" + keyOf(pnEl.textContent.trim(), name);
      const it = PRICE.get(id);
      if (!it || it.ex == null || it.ic === "head") continue;
      const cell = tr.querySelector("td.price") || tr.lastElementChild;
      const b = document.createElement("button");
      b.type = "button"; b.className = "hdq-add"; b.dataset.id = id;
      cell.appendChild(b);
      paint(b);
    }
  }
  function paint(b) {
    const c = inCart(b.dataset.id);
    b.textContent = c ? "✓ In quote" + (c.qty > 1 ? " ×" + c.qty : "") : "+ Quote";
    b.classList.toggle("on", !!c);
    b.setAttribute("aria-pressed", c ? "true" : "false");
  }
  cat.addEventListener("click", (e) => {
    const b = e.target.closest(".hdq-add"); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const c = inCart(b.dataset.id);
    if (c) c.qty = Math.min(99, c.qty + 1); else cart.push({ id: b.dataset.id, qty: 1 });
    save(); paint(b); syncFab();
  }, true);
  new MutationObserver(decorate).observe(cat, { childList: true });
  decorate(); syncFab();

  // ---- quote panel
  const st = { fit: false, machine: "", hours: 1, note: "", busy: false, machines: null, result: null };
  const layer = document.createElement("div");
  layer.className = "hdq-layer"; layer.hidden = true;
  document.body.appendChild(layer);
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-hdq]"); if (!t) return;
    const a = t.dataset.hdq;
    if (a === "open") openPanel();
    else if (a === "close") { layer.hidden = true; document.body.classList.remove("hdq-lock"); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !layer.hidden) { layer.hidden = true; document.body.classList.remove("hdq-lock"); } });
  async function loadMachines() {
    if (st.machines) return st.machines;
    try { const r = await fetch("/catalogue/quote-machines", { credentials: "same-origin" }); const j = await r.json(); st.machines = j.machines || []; }
    catch (e) { st.machines = []; }
    return st.machines;
  }
  function openPanel() { st.result = null; layer.hidden = false; document.body.classList.add("hdq-lock"); draw(); loadMachines().then(draw); }
  function draw() {
    const rows = cart.map((c) => ({ c, it: PRICE.get(c.id) })).filter((x) => x.it);
    const parts = rows.reduce((s, x) => s + x.it.ex * x.c.qty, 0);
    const labour = st.fit ? LABOUR * st.hours : 0;
    const ms = st.machines;
    let h = '<div class="hdq-panel" role="dialog" aria-modal="true" aria-label="Your quote"><div class="hdq-head"><h2>Your quote</h2>' +
      '<button type="button" class="hdq-x" data-hdq="close" aria-label="Close">×</button></div>';
    if (st.result) {
      const r = st.result;
      h += r.ok
        ? '<div class="hdq-done"><p><b>Quote ' + esc(r.number || "") + " created" + (r.sent ? " and emailed to " + esc(r.email || Q.email) : "") + ".</b></p>" +
          (r.sent ? "<p>Check your inbox for an email from Highway Digital. You can accept the quote from that email.</p>" : "<p>" + esc(r.error || "We'll email it to you shortly.") + "</p>") +
          (r.total ? '<p class="hdq-muted">Total ' + money(r.total) + " inc GST.</p>" : "") +
          (r.skipped && r.skipped.length ? '<p class="hdq-muted">Not included (we\'ll follow up): ' + esc(r.skipped.join(", ")) + ".</p>" : "") +
          '<button type="button" class="hdq-btn" data-hdq="close">Done</button></div>'
        : '<div class="hdq-err">' + esc(r.error || "Something went wrong.") + "</div>";
      if (r.ok) { layer.innerHTML = h + "</div>"; return; }
    }
    if (!rows.length) {
      h += '<p class="hdq-muted">Your quote is empty. Tap <span class="hdq-chip">+ Quote</span> next to the parts and consumables you need.</p></div>';
      layer.innerHTML = h; return;
    }
    h += '<table class="hdq-tbl"><thead><tr><th>Part</th><th>Qty</th><th class="n">Ex GST</th><th></th></tr></thead><tbody>' +
      rows.map((x, i) => '<tr><td><div class="hdq-pn">' + esc(x.it.pn) + "</div>" + esc(x.it.name) + '<div class="hdq-muted">' + esc(x.it.brand) + "</div></td>" +
        '<td><input type="number" min="1" max="99" value="' + x.c.qty + '" data-qi="' + i + '" aria-label="Quantity"></td>' +
        '<td class="n">' + money(x.it.ex * x.c.qty) + '</td><td><button type="button" class="hdq-rm" data-ri="' + i + '" aria-label="Remove">✕</button></td></tr>').join("") +
      "</tbody></table>";
    h += '<fieldset class="hdq-opts"><legend>Fitting</legend>' +
      '<label><input type="radio" name="hdqfit" value="0"' + (st.fit ? "" : " checked") + "> Parts only <span class=\"hdq-muted\">(we'll confirm freight or pick-up)</span></label>" +
      '<label><input type="radio" name="hdqfit" value="1"' + (st.fit ? " checked" : "") + "> Highway Digital fits the parts</label></fieldset>";
    if (st.fit) {
      h += '<label class="hdq-f">Machine the parts are for<select id="hdqMachine"><option value="">' + (ms ? "Choose a machine" : "Loading…") + "</option>" +
        (ms || []).map((m) => '<option value="' + esc(m.id) + '"' + (m.id === st.machine ? " selected" : "") + ">" + esc([m.brand, m.model].filter(Boolean).join(" ") + (m.serial ? " · SN " + m.serial : "") + (m.location || m.site ? " · " + (m.location || m.site) : "")) + "</option>").join("") +
        "</select></label>" +
        '<label class="hdq-f">Estimated hours on site<select id="hdqHours">' + [1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8].map((v) => '<option value="' + v + '"' + (v === st.hours ? " selected" : "") + ">" + v + " hour" + (v === 1 ? "" : "s") + "</option>").join("") + "</select></label>" +
        '<div class="hdq-labour"><b>Labour is billed hourly</b> at ' + money(LABOUR) + " + GST per hour, for the actual time on site. The hours you choose here are an estimate only.</div>" +
        '<div class="hdq-muted">Callout is added automatically from the machine\'s location: $80 + GST within 30 km of the Perth CBD, $125 + GST within 100 km. Further away, travel is quoted separately.</div>';
    }
    h += '<label class="hdq-f">Anything we should know? <span class="hdq-muted">(optional)</span><textarea id="hdqNote" rows="2" maxlength="1000">' + esc(st.note) + "</textarea></label>";
    h += '<div class="hdq-sum"><div><span>Parts</span><b>' + money(parts) + "</b></div>" +
      (st.fit ? "<div><span>Labour (estimate, " + st.hours + " h)</span><b>" + money(labour) + "</b></div><div><span>Callout</span><b>worked out on the quote</b></div>" : "") +
      '<div class="hdq-tot"><span>Total ex GST' + (st.fit ? " (before callout)" : "") + "</span><b>" + money(parts + labour) + "</b></div>" +
      '<div class="hdq-muted">GST is added on the quote. Prices are confirmed when the quote is created.</div></div>';
    if (st.result && !st.result.ok) h += "";
    h += '<button type="button" class="hdq-btn hdq-go" id="hdqGo"' + (st.busy ? " disabled" : "") + ">" + (st.busy ? "Creating your quote…" : "Create quote and email it to me") + "</button>" +
      '<p class="hdq-muted">Sent to ' + esc(Q.email) + ". Up to 5 quotes an hour.</p></div>";
    layer.innerHTML = h;
    bind();
  }
  function bind() {
    layer.querySelectorAll("[data-qi]").forEach((inp) => inp.addEventListener("change", () => {
      const c = cart[+inp.dataset.qi]; if (!c) return;
      c.qty = Math.max(1, Math.min(99, Math.round(+inp.value || 1))); save(); syncFab(); repaintButtons(); draw();
    }));
    layer.querySelectorAll("[data-ri]").forEach((b) => b.addEventListener("click", () => { cart.splice(+b.dataset.ri, 1); save(); syncFab(); repaintButtons(); draw(); }));
    layer.querySelectorAll('input[name="hdqfit"]').forEach((r) => r.addEventListener("change", () => { st.fit = r.value === "1"; draw(); }));
    const m = layer.querySelector("#hdqMachine"); if (m) m.addEventListener("change", () => { st.machine = m.value; });
    const hr = layer.querySelector("#hdqHours"); if (hr) hr.addEventListener("change", () => { st.hours = +hr.value; draw(); });
    const n = layer.querySelector("#hdqNote"); if (n) n.addEventListener("input", () => { st.note = n.value; });
    const go = layer.querySelector("#hdqGo"); if (go) go.addEventListener("click", submit);
  }
  function repaintButtons() { cat.querySelectorAll(".hdq-add").forEach(paint); }
  async function submit() {
    if (st.busy) return;
    if (st.fit && !st.machine) { st.result = { ok: false, error: "Choose the machine the parts are for, so we can work out the callout." }; draw(); return; }
    st.busy = true; st.result = null; draw();
    const items = cart.map((c) => { const it = PRICE.get(c.id); return { brand: it.brand, key: keyOf(it.pn, it.name), qty: c.qty }; });
    let r;
    try {
      const res = await fetch("/catalogue/quote", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, fit: st.fit, hours: st.hours, machine_id: st.fit ? st.machine : "", note: st.note }) });
      r = await res.json();
    } catch (e) { r = { ok: false, error: "Couldn't reach the quote service. Please try again." }; }
    st.busy = false; st.result = r;
    if (r && r.ok) { cart = []; save(); syncFab(); repaintButtons(); st.note = ""; }
    draw();
  }
})();
