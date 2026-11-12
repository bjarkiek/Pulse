const arrowDefs = `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1l8 4-8 4" fill="none" stroke="#a3a3a3" stroke-width="1.5"/></marker></defs>`;

// A closed loop of five numbered steps.
const loop = (steps) => {
  const cx = 180, cy = 110, rx = 92, ry = 72;
  const pts = steps.map((_, i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / steps.length; return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]; });
  return `<svg class="ig" viewBox="0 0 360 220" role="img" aria-label="${steps.join(", then ")}, in a loop">
    <ellipse class="ln" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" stroke-dasharray="4 5"/>
    ${pts.map(([x, y], i) => `<circle class="dot" cx="${x}" cy="${y}" r="15"/><text class="n" x="${x}" y="${y + 5}" text-anchor="middle">${i + 1}</text>
      <text class="t" x="${x + (x < cx - 5 ? -22 : x > cx + 5 ? 22 : 0)}" y="${y + (Math.abs(x - cx) <= 5 ? -24 : 5)}" text-anchor="${x < cx - 5 ? "end" : x > cx + 5 ? "start" : "middle"}">${steps[i]}</text>`).join("")}
    <text x="${cx}" y="${cy + 5}" text-anchor="middle">One governed loop</text></svg>`;
};

// A left-to-right row of numbered steps.
const flow = (steps) => {
  const w = 360 / steps.length;
  return `<svg class="ig" viewBox="0 0 360 220" role="img" aria-label="${steps.map((s) => s[0]).join(", then ")}">${arrowDefs}
    ${steps.map(([t, d], i) => { const x = i * w + w / 2; return `
      ${i < steps.length - 1 ? `<path class="ln" marker-end="url(#a)" d="M${x + 22} 70H${x + w - 24}"/>` : ""}
      <circle class="dot" cx="${x}" cy="70" r="17"/><text class="n" x="${x}" y="75" text-anchor="middle">${i + 1}</text>
      <text class="t" x="${x}" y="118" text-anchor="middle">${t}</text>
      ${d.map((l, k) => `<text x="${x}" y="${140 + k * 18}" text-anchor="middle">${l}</text>`).join("")}`; }).join("")}</svg>`;
};

// Pulse Help links here with ?from=help (shows the way back) and, for customers, &for=customers (leaves out the team cut).
const query = new URLSearchParams(location.search);
const ALL_CUTS = [
  { v: "overview", title: "How it works", length: "59 s", who: "For everyone",
    text: "The loop from a customer request to a shipped release, and who acts at each step.",
    art: loop(["Request", "Triage", "Idea", "Roadmap", "Release"]) },
  { v: "customers", title: "For customer teams", length: "60 s", who: "For members and company admins",
    text: "Sign in, search before asking, submit a request and follow it to release.",
    art: flow([["Search", ["Check what", "exists"]], ["Submit", ["Describe the", "outcome"]], ["Follow", ["Know when", "it moves"]]]) },
  { v: "team", title: "For the DataCentral team", length: "63 s", who: "For contributors, product managers and admins",
    text: "The weekly rhythm: triage, shape ideas, publish and release, then communicate.",
    art: flow([["Triage", ["Decide the", "next step"]], ["Shape", ["Consolidate", "and score"]], ["Release", ["Publish", "safely"]], ["Tell", ["Email", "customers"]]]) },
];
const CUTS = query.get("for") === "customers" ? ALL_CUTS.filter((c) => c.v !== "team") : ALL_CUTS;
document.getElementById("lead").textContent = `${["", "One", "Two", "Three"][CUTS.length]} one-minute cuts. Each one is silent, captioned and loops.`;
if (query.get("from") === "help") {
  const help = document.getElementById("help");
  if (query.get("lang") === "is") help.href = "/help?lang=is";
  help.hidden = false;
}

const play = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg>`;
document.getElementById("grid").innerHTML = CUTS.map((c) => `
  <article class="card">
    <figure>${c.art}</figure>
    <div class="in">
      <h2>${c.title}</h2>
      <div class="meta">${c.who} · ${c.length}</div>
      <p>${c.text}</p>
      <div class="actions">
        <button class="btn" type="button" data-open="${c.v}">${play}Watch here</button>
        <a class="link" href="player.html?v=${c.v}">player.html?v=${c.v}</a>
      </div>
    </div>
  </article>`).join("");

// The open cut lives in the hash, so the browser's own back button closes the viewer too.
const frame = document.getElementById("frame");
function sync() {
  const cut = CUTS.find((c) => c.v === location.hash.slice(1));
  document.body.classList.toggle("viewing", !!cut);
  document.getElementById("now").textContent = cut ? cut.title : "";
  const src = cut ? `player.html?v=${cut.v}` : "about:blank";
  if (frame.getAttribute("src") !== src) frame.setAttribute("src", src);
  if (cut) document.getElementById("back").focus();
}
document.getElementById("grid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-open]");
  if (b) location.hash = b.dataset.open;
});
document.getElementById("back").addEventListener("click", () => {
  history.replaceState(null, "", location.pathname + location.search);
  sync();
});
addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("viewing")) document.getElementById("back").click(); });
addEventListener("hashchange", sync);
sync();
