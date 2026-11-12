const LOGO = '<img src="assets/datacentral-blacktext.svg" alt="DataCentral">';
const pill = (text, tone = "") => `<span class="pill ${tone}">${text}</span>`;
const head = (eyebrow, h1, sub) =>
  `<div class="eyebrow" data-at="0.15">${eyebrow}</div><h1 data-at="0.3">${h1}</h1>` +
  (sub ? `<div class="sub" data-at="0.9">${sub}</div>` : "");
const card = (at, h3, p, extra = "") =>
  `<div class="card grow" data-at="${at}" ${extra}><h3>${h3}</h3><p>${p}</p></div>`;
const listCard = (at, h3, items) =>
  `<div class="card grow" data-at="${at}"><h3>${h3}</h3><ul class="list">${items.map((i) => `<li>${i}</li>`).join("")}</ul></div>`;
const title = (dur, h1, sub, url) => ({
  dur, cls: "title", bare: true,
  html: `<div data-at="0.2">${LOGO}</div><h1 data-at="0.5">${h1}</h1><div class="sub" data-at="1.1">${sub}</div>` +
    (url ? `<div class="url" data-at="1.9">${url}</div>` : ""),
});
const row = (id, t, pillHtml, at) =>
  `<div class="row" data-at="${at}"><div class="l"><span class="${/^(DCI|IDEA)-/.test(id) ? "id" : "lbl"}">${id}</span><span class="t">${t}</span></div>${pillHtml}</div>`;
const decisions = (at, onAt) =>
  `<div class="stack">` +
  ["Link to product idea", "Request information", "Route to support", "Close request"]
    .map((d, i) => `<div class="chip" data-at="${(at + i * 0.25).toFixed(2)}" ${i === 0 ? `data-on="${onAt}"` : ""}>${d}</div>`)
    .join("") + `</div>`;
const merge = (at) =>
  `<div class="stack" style="width:520px">` +
  ["Company A", "Company B", "Company C"]
    .map((c, i) => `<div class="item" data-at="${(at + i * 0.3).toFixed(2)}"><span class="lbl">Private request</span><div class="t">${c}</div></div>`)
    .join("") +
  `</div><div class="arrow" data-at="${at + 1.3}">-&gt;</div>` +
  `<div class="card grow" data-at="${at + 1.8}"><span class="id">IDEA-214</span>
     <div class="ttl" style="margin:14px 0 26px">Scheduled delivery to SharePoint</div>
     <div style="display:flex;gap:16px;flex-wrap:wrap">${pill("Planned")}${pill("3 organizations interested")}</div></div>`;

const VIDEOS = {
  overview: {
    cut: "How it works",
    scenes: [
      title(6, "Pulse", "From customer request to shipped release. One governed loop."),
      { dur: 7.5, html: head("Who uses Pulse", "Three groups. One system of record.") +
        `<div class="body eq">` +
        card(1.3, "Customers", "Submit requests and follow them to release.") +
        card(1.7, "Product team", "Triage, consolidate and publish ideas.") +
        card(2.1, "System admins", "Govern access, policy and the audit log.") + `</div>` },
      { dur: 7.5, html: head("Step 1 · Customer", "A customer describes a need.", "The request stays private to their organization.") +
        `<div class="body"><div class="card grow" data-at="1.6">
           <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:22px">
             <span class="id">DCI-1038</span><span data-at="4.6">${pill("Submitted")}</span></div>
           <div class="ttl caret" style="font-size:58px;min-height:70px" data-type="2.1,2.0">Scheduled report delivery to SharePoint</div>
           <div class="meta" style="margin-top:22px" data-at="4.2">Distribution · 2 attachments</div>
         </div></div>` },
      { dur: 8, html: head("Step 2 · Product team", "The product team decides the next step.") +
        `<div class="body"><div class="stack grow">
           <div class="row" data-at="1.3"><div class="l"><span class="id">DCI-1038</span><span class="t">Scheduled report delivery to SharePoint</span></div>
             <span data-until="4.4">${pill("Submitted")}</span><span data-from="4.4">${pill("Linked", "ok")}</span></div>
           <div class="meta" data-at="4.7" style="font-size:36px;color:var(--body)">The customer sees the new status at once.</div>
         </div>${decisions(1.9, 3.8)}</div>` },
      { dur: 8.5, html: head("Step 3 · Product team", "Related requests become one product idea.", "Published in customer-safe language. No company sees another's request.") +
        `<div class="body">${merge(1.8)}</div>` },
      { dur: 7.5, html: head("Step 4 · Everyone", "The roadmap shows where it stands.") +
        `<div class="body top">
          <div class="col" data-at="1.2"><h3>Now</h3><div class="note">Active delivery</div>
            <div class="item" data-from="4.3"><span class="id">IDEA-214</span><div class="t">Scheduled delivery to SharePoint</div></div>
            <div class="item ghost"><i></i><i></i></div></div>
          <div class="col" data-at="1.5"><h3>Next</h3><div class="note">Approved and sequenced</div>
            <div class="item" data-at="2.3" data-until="4.3"><span class="id">IDEA-214</span><div class="t">Scheduled delivery to SharePoint</div></div>
            <div class="item ghost"><i></i><i></i></div></div>
          <div class="col" data-at="1.8"><h3>Later</h3><div class="note">Validated, not committed</div>
            <div class="item ghost"><i></i><i></i></div><div class="item ghost"><i></i><i></i></div></div>
        </div>` },
      { dur: 7.5, html: head("Step 5 · Customer", "Customers hear when it ships.", "Status changes arrive in the app and by email.") +
        `<div class="body"><div class="card" style="width:760px" data-at="1.7"><span class="lbl">Release notes</span>
            <div class="ttl" style="margin:14px 0 26px">Scheduled delivery to SharePoint</div>${pill("Released", "ok")}</div>
          <div class="stack grow">
            ${row("Updates", "Your idea was released", pill("New", "ok"), 2.6)}
            ${row("Email", "Release notes in your inbox", pill("Sent"), 3.1)}
          </div></div>` },
      title(6.5, "Pulse", "The system of record for what customers ask and what DataCentral ships.", "datacentral.ai"),
    ],
  },

  customers: {
    cut: "For customer teams",
    scenes: [
      title(6, "Pulse for customer teams", "Get your requests in front of the DataCentral product team."),
      { dur: 7.5, html: head("Sign in", "Open Pulse the way your organization set it up.") +
        `<div class="body eq">` +
        card(1.3, "From DataCentral", "Arrive signed in. No second login.") +
        card(1.7, "Microsoft sign-in", "Use your work account.") +
        card(2.1, "Email passcode", "A six-digit code sent to your inbox.") + `</div>` },
      { dur: 8, html: head("Search first", "Check what has already been asked.", "Following an existing idea adds weight without adding noise.") +
        `<div class="body"><div class="stack grow">
           <div class="field" data-at="1.5"><span class="caret" data-type="1.9,1.3">sharepoint delivery</span></div>
           <div class="row" data-at="3.6"><div class="l"><span class="id">IDEA-214</span><span class="t">Scheduled delivery to SharePoint</span></div>
             <div style="display:flex;gap:18px;align-items:center">${pill("Planned")}
               <span class="chip" data-until="5.4" style="padding:14px 30px">Follow</span><span class="chip on" data-from="5.4" style="padding:14px 30px">Following</span></div></div>
         </div></div>` },
      { dur: 8.5, html: head("Submit a request", "Describe the outcome, not the feature.") +
        `<div class="body"><div class="card grow" data-at="1.2">
           <div class="label">Title</div>
           <div class="field"><span class="caret" data-type="1.7,1.5">Custom branding for exported reports</span></div>
           <div class="label">What are you trying to achieve?</div>
           <div class="field"><span data-type="3.5,2.2">Reports sent to our clients should carry our logo.</span></div>
           <div style="display:flex;justify-content:space-between;align-items:center;margin-top:30px">
             <span class="meta" data-at="5.9">Attach files up to 25 MB each</span><span data-at="6.5">${pill("Submitted")}</span></div>
         </div></div>` },
      { dur: 7.5, html: head("My requests", "Follow every request from your organization.") +
        `<div class="body"><div class="stack grow">
           ${row("DCI-1042", "Custom branding for exported reports", pill("Needs information", "warn"), 1.3)}
           ${row("DCI-1038", "Scheduled report delivery to SharePoint", pill("Linked", "ok"), 1.7)}
           ${row("DCI-1019", "Audit log API", pill("Submitted"), 2.1)}
         </div></div>` },
      { dur: 8.5, html: head("Roles", "Access follows your role in each company.") +
        `<div class="body eq">` +
        listCard(1.3, "Member", ["Submit and comment on requests", "Follow ideas and the roadmap", "Read your organization's requests"]) +
        listCard(1.9, "Company admin", ["Everything a member can do", "Edit or withdraw any company request", "Keep the company's contacts"]) + `</div>` },
      { dur: 7, html: head("Updates", "Know when something moves.", "Notifications arrive in the app and by email.") +
        `<div class="body"><div class="stack grow">
           ${row("DCI-1042", "DataCentral asked for more information", pill("Needs information", "warn"), 1.7)}
           ${row("IDEA-214", "Scheduled delivery to SharePoint", pill("Released", "ok"), 2.2)}
         </div></div>` },
      title(6.5, "Your next request starts with a search.", "Open Pulse from DataCentral.", "datacentral.ai"),
    ],
  },

  team: {
    cut: "For the DataCentral team",
    scenes: [
      title(6, "Pulse for the DataCentral team", "Triage, publish, release and communicate."),
      { dur: 8.5, html: head("The weekly rhythm", "Four steps from request to release.") +
        `<div class="body eq">` +
        [["Triage", "Decide the next step for every new request."],
         ["Shape ideas", "Consolidate requests and score them."],
         ["Publish and release", "Customer-safe wording, bundled into releases."],
         ["Communicate", "Email the customers it affects."]]
          .map(([h, p], i) => `<div class="card grow" style="padding:34px" data-at="${(1.2 + i * 0.3).toFixed(1)}" data-on="${(2.8 + i * 1.3).toFixed(1)}" data-off="${(4.1 + i * 1.3).toFixed(1)}">
              <div class="num">0${i + 1}</div><h3 style="font-size:42px">${h}</h3><p style="font-size:31px">${p}</p></div>`).join("") + `</div>` },
      { dur: 8, html: head("Triage inbox", "Every new request lands in one queue.") +
        `<div class="body"><div class="stack grow">
           <div class="row" data-at="1.3"><div class="l"><span class="id">DCI-1048 · Company A</span><span class="t">Row-level export filters</span></div>
             <span data-until="4.6">${pill("Submitted")}</span><span data-from="4.6">${pill("Linked", "ok")}</span></div>
           ${row("DCI-1047 · Company B", "Report keys for partners", pill("Submitted"), 1.6)}
           ${row("DCI-1046 · Company C", "Usage by organization unit", pill("Needs information", "warn"), 1.9)}
         </div>${decisions(2.3, 4.0)}</div>` },
      { dur: 8.5, html: head("Product ideas", "One idea carries many requests.", "Consolidate, score and publish in customer-safe language.") +
        `<div class="body">${merge(1.8)}</div>` },
      { dur: 8.5, html: head("Releases and communications", "Ship it, then tell the customers it affects.") +
        `<div class="body eq"><div class="card grow" data-at="1.3"><span class="lbl">Release</span>
            <div class="ttl" style="margin:14px 0 26px">Scheduled delivery to SharePoint</div>
            <span data-until="3.2">${pill("Draft")}</span><span data-from="3.2">${pill("Published", "ok")}</span></div>
          <div class="arrow" data-at="3.4" style="align-self:center">-&gt;</div>
          <div class="card grow" data-at="3.8"><span class="lbl">Communication</span>
            <div class="ttl" style="margin:14px 0 8px">Product update</div>
            <div class="meta">To members and company contacts</div>
            <div class="guards" data-at="5.0">${pill("Safe mode")}${pill("Daily cap")}${pill("Suppression list")}</div></div></div>` },
      { dur: 9, html: head("Roles", "Each internal role has a defined scope.") +
        `<div class="body eq">` +
        listCard(1.2, "Internal contributor", ["Read requests and ideas", "Write internal notes", "View analytics"]) +
        listCard(1.8, "Product manager", ["Triage and link requests", "Score and publish ideas", "Create releases"]) +
        listCard(2.4, "System admin", ["Users and companies", "Settings and sign-in", "Audit log"]) + `</div>` },
      { dur: 8, html: head("Assistant", "Ask in plain language, within your own access.") +
        `<div class="body"><div class="stack grow">
           <div class="bubble" data-at="1.2"><span class="caret" data-type="1.6,1.8">Which requests are waiting on triage?</span></div>
           <div class="eqrow">` +
           card(3.8, "In the app", "The Assistant panel.") + card(4.2, "In Slack", "Direct message or mention.") + card(4.6, "Over MCP", "From your own AI client.") +
          `</div></div></div>` },
      title(6.5, "Pulse", "The system of record for what customers ask and what DataCentral ships.", "datacentral.ai"),
    ],
  },
};

// ---- engine: everything on screen is a pure function of t, so frames can be captured one by one ----
const params = new URLSearchParams(location.search);
const video = VIDEOS[params.get("v")] || VIDEOS.overview;
const host = document.getElementById("scenes");
document.getElementById("cut").textContent = video.cut;
const clamp = (x) => Math.max(0, Math.min(1, x));
const ease = (x) => 1 - Math.pow(1 - clamp(x), 3);
let total = 0;
const scenes = video.scenes.map((s) => {
  const el = document.createElement("section");
  el.className = "scene " + (s.cls || "");
  el.innerHTML = s.html;
  host.appendChild(el);
  const q = (sel) => [...el.querySelectorAll(sel)];
  const typed = q("[data-type]").map((e) => {
    const [a, d] = e.dataset.type.split(",").map(Number);
    return { e, a, d, text: e.textContent };
  });
  const sc = { el, start: total, dur: s.dur, bare: !!s.bare, at: q("[data-at]"), gate: q("[data-from],[data-until]"), on: q("[data-on]"), typed };
  total += s.dur;
  return sc;
});
window.DURATION = total;

window.renderAt = function (t) {
  t = Math.max(0, Math.min(total, t));
  let bare = false;
  scenes.forEach((s, i) => {
    const lt = t - s.start;
    const last = i === scenes.length - 1;
    const vis = lt >= 0 && (lt < s.dur || last);
    s.el.style.display = vis ? "flex" : "none";
    if (!vis) return;
    bare = s.bare;
    const out = last ? 1 : 1 - ease((lt - (s.dur - 0.25)) / 0.25);
    s.el.style.opacity = Math.min(ease(lt / 0.3), out);
    s.at.forEach((e) => {
      const p = ease((lt - +e.dataset.at) / 0.35);
      e.style.opacity = p;
      e.style.transform = `translateY(${(1 - p) * 16}px)`;
    });
    s.gate.forEach((e) => {
      const from = e.dataset.from === undefined ? -1 : +e.dataset.from;
      const until = e.dataset.until === undefined ? Infinity : +e.dataset.until;
      const show = lt >= from && lt < until;
      if (e.dataset.at === undefined) e.style.display = show ? "" : "none";
      else if (!show) e.style.display = "none"; else e.style.display = "";
    });
    s.on.forEach((e) => {
      const off = e.dataset.off === undefined ? Infinity : +e.dataset.off;
      e.classList.toggle("on", lt >= +e.dataset.on && lt < off);
    });
    s.typed.forEach(({ e, a, d, text }) => {
      e.textContent = text.slice(0, Math.round(clamp((lt - a) / d) * text.length));
    });
  });
  document.getElementById("topbar").style.visibility = bare ? "hidden" : "visible";
  document.getElementById("bar").style.width = (t / total) * 100 + "%";
};

if (params.has("capture")) {
  renderAt(0);
} else {
  const stage = document.getElementById("stage");
  const fit = () => {
    const k = Math.min(innerWidth / 1920, innerHeight / 1080);
    stage.style.transform = `translate(${(innerWidth - 1920 * k) / 2}px, ${(innerHeight - 1080 * k) / 2}px) scale(${k})`;
  };
  addEventListener("resize", fit); fit();
  const t0 = performance.now();
  const tick = (now) => { renderAt(((now - t0) / 1000) % (total + 1)); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
