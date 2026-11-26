/* Highway Service Desk: the one menu used on every portal page.
   The app (index.html) calls HDNav.render(); the Knowledge Base, Parts Catalogue and Vector Converter pages get it from
   _worker.js, which adds <div id="hd-nav" data-flags='…'> and this script to the top of the page. */
(function () {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function items(f) {
    // appsOnly: a login that only has apps (Flute Practice, Vector Converter): no machines, no booking.
    const out = f.appsOnly && !f.staff ? [] : [["machines", "/#machines", f.staff ? "Assets" : "My machines"]];
    if (f.intranet) out.push(["tickets", "/#tickets", "Tickets"]);
    if (f.intranet) out.push(["intranet", "/#kb", "Intranet"]);
    if (f.kb) out.push(["kb", "/kb/", "Knowledge"]);
    if (f.cat) out.push(["catalogue", "/catalogue/", "Parts Catalogue"]);
    if (f.vector) out.push(["vector", "/vector/", "Vector Converter"]);
    if (f.flute) out.push(["flute", "/flute/", "Flute Practice"]);
    if (f.logreview) out.push(["logreview", "/logreview/", "Log Analysis"]);
    if (f.radio) out.push(["radio", "/radio/", "Radio"]);
    out.push(["weather", "/weather/", "Weather"]);
    if (f.reports) out.push(["reports", "/#reports", "Reports"]);
    if (!(f.appsOnly && !f.staff)) out.push(["contact", "/#contact", "Contact & booking"]);
    if (f.staff) out.push(["customers", "/#customers", "Access"]);
    if (f.staff) out.push(["service-kits", "/#service-kits", "PM Kits"]);
    if (f.intranet) out.push(["warehousing", "/warehousing/", "Warehousing"]);
    return out;
  }
  // f: { signedIn, email, staff, intranet, kb, cat, vector, flute, radio, appsOnly, active }
  function render(host, f) {
    if (!host) return;
    f = f || {};
    host.innerHTML =
      '<div class="hdn-wrap hdn-bar">' +
        '<a class="hdn-brand" href="/" aria-label="Highway Service Desk"><img class="hdn-logo" src="/logo.png?v=20" alt="Highway Digital" width="600" height="104"><small>Highway Service Desk</small></a>' +
        '<span class="hdn-spacer"></span>' +
        (f.signedIn ? '<span class="hdn-who">' + esc(f.email) + '</span><a class="hdn-out" href="/#signout">Sign out</a>' : "") +
      "</div>" +
      (f.signedIn
        ? '<nav class="hdn-wrap hdn-tabs" aria-label="Highway Service Desk">' +
          items(f).map(([k, h, t]) => '<a href="' + h + '" data-nav="' + k + '"' + (k === f.active ? ' aria-current="page"' : "") + ">" + esc(t) + "</a>").join("") +
          "</nav>"
        : "");
  }
  function setActive(host, key) {
    if (!host) return;
    host.querySelectorAll("[data-nav]").forEach((a) => (a.dataset.nav === key ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  }
  window.HDNav = { render, setActive };
  const auto = document.getElementById("hd-nav");
  if (auto && auto.dataset.flags) { try { render(auto, JSON.parse(auto.dataset.flags)); } catch (e) {} }
})();
