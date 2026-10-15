// Generates the four Pulse decks in this folder.
//   NODE_PATH=<dir with node_modules/pptxgenjs + sharp> node presentations/build-decks.cjs
// Brand: DataCentral design system (violet accent, neutral chrome, brand stripe on dark slides only).
// Screenshots come from public/help (captured by `npm run help:screenshots`).
const path = require("path");
const fs = require("fs");
const pptxgen = require("pptxgenjs");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..");
const OUT = __dirname;
const LOGOS = process.env.DC_LOGOS;
const TMP = process.env.DC_TMP;
const SKILL_PPTX = process.env.DC_PPTX_SKILL;
const { applyTheme } = require(path.join(SKILL_PPTX, "scripts", "apply_theme.js"));

const C = {
  violet: "7C3AED", violet50: "F5F3FF", violet100: "EDE9FE", violet300: "C4B5FD", violet700: "6D28D9",
  ink: "171717", muted: "737373", subtle: "A3A3A3", border: "E5E5E5", page: "FAFAFA", white: "FFFFFF",
  dark: "0A0A0A", darkCard: "171717", darkLine: "262626", amber100: "FEF3C7", amber700: "B45309",
  emerald100: "D1FAE5", emerald700: "047857",
};
const STRIPE = ["F9C815", "F07124", "ED0E78", "6640A2"];
const F = { head: "Space Grotesk", body: "IBM Plex Sans", mono: "IBM Plex Mono" };
const THEME = {
  name: "DataCentral Pulse",
  headFontFace: F.head,
  bodyFontFace: F.body,
  colors: {
    dk1: C.ink, lt1: C.white, dk2: C.dark, lt2: C.page,
    accent1: C.violet, accent2: C.violet700, accent3: "8B5CF6", accent4: "F59E0B", accent5: "10B981", accent6: C.muted,
    hlink: C.violet, folHlink: C.violet700,
  },
};
const W = 13.333, H = 7.5, M = 0.7;

// ---------- assets ----------
const logoCache = {};
async function logo(name) {
  if (!logoCache[name]) {
    const out = path.join(TMP, name + ".png");
    await sharp(path.join(LOGOS, name + ".svg"), { density: 300 }).resize({ width: 1400 }).png().toFile(out);
    logoCache[name] = out;
  }
  return logoCache[name];
}
const shotCache = {};
async function shot(name) {
  if (!shotCache[name]) {
    const out = path.join(TMP, name + ".jpg");
    await sharp(path.join(ROOT, "public", "help", name + ".png")).resize({ width: 1920 }).jpeg({ quality: 86 }).toFile(out);
    shotCache[name] = out;
  }
  return shotCache[name];
}
const LOGO_RATIO = 1640 / 216.09;

// ---------- deck scaffolding ----------
function newDeck(title, footer) {
  const pres = new pptxgen();
  pres.layout = "LAYOUT_WIDE";
  pres.title = title;
  pres.author = "DataCentral";
  pres.company = "DataCentral";
  pres.theme = { headFontFace: F.head, bodyFontFace: F.body };
  const foot = (color) => [
    { text: { text: footer, options: { x: M, y: 7.0, w: 8, h: 0.3, fontFace: F.body, fontSize: 10, color, margin: 0 } } },
  ];
  pres.defineSlideMaster({
    title: "LIGHT", background: { color: C.page },
    objects: foot(C.subtle),
    slideNumber: { x: W - M - 0.8, y: 7.0, w: 0.8, h: 0.3, fontFace: F.mono, fontSize: 10, color: C.subtle, align: "right", margin: 0 },
  });
  pres.defineSlideMaster({ title: "DARK", background: { color: C.dark } });
  return pres;
}

function stripe(slide) {
  const w = W / 4;
  STRIPE.forEach((c, i) =>
    slide.addShape("rect", { x: i * w, y: H - 0.1, w, h: 0.1, fill: { color: c }, line: { color: c, width: 0 }, objectName: "Brand stripe " + (i + 1) }),
  );
}

async function titleSlide(pres, { eyebrow, title, sub, tag }) {
  const s = pres.addSlide({ masterName: "DARK" });
  s.addImage({ path: await logo("datacentral-whitetext"), x: M, y: 0.6, w: 2.6, h: 2.6 / LOGO_RATIO, altText: "DataCentral" });
  s.addText(eyebrow.toUpperCase(), { x: M, y: 2.35, w: 10, h: 0.35, fontFace: F.body, fontSize: 14, bold: true, color: C.violet300, charSpacing: 3, margin: 0, isTextBox: true });
  s.addText(title, { x: M, y: 2.8, w: 11.4, h: 2.1, fontFace: F.head, fontSize: 38, bold: true, color: C.white, valign: "top", margin: 0, isTextBox: true });
  s.addText(sub, { x: M, y: 5.1, w: 9.6, h: 1.0, fontFace: F.body, fontSize: 18, color: C.subtle, valign: "top", margin: 0, isTextBox: true });
  s.addText(tag, { x: M, y: 6.55, w: 8, h: 0.3, fontFace: F.mono, fontSize: 12, color: C.subtle, margin: 0, isTextBox: true });
  stripe(s);
  return s;
}

function dividerSlide(pres, num, title, sub) {
  const s = pres.addSlide({ masterName: "DARK" });
  s.addText(num, { x: M, y: 2.5, w: 3, h: 0.6, fontFace: F.mono, fontSize: 20, color: C.violet300, margin: 0, isTextBox: true });
  s.addText(title, { x: M, y: 3.1, w: 11, h: 1.0, fontFace: F.head, fontSize: 40, bold: true, color: C.white, margin: 0, isTextBox: true });
  if (sub) s.addText(sub, { x: M, y: 4.2, w: 9, h: 0.9, fontFace: F.body, fontSize: 18, color: C.subtle, valign: "top", margin: 0, isTextBox: true });
  stripe(s);
  return s;
}

async function closingSlide(pres, title, sub, tag) {
  const s = pres.addSlide({ masterName: "DARK" });
  s.addImage({ path: await logo("datacentral-whitetext"), x: M, y: 0.6, w: 2.2, h: 2.2 / LOGO_RATIO, altText: "DataCentral" });
  s.addText(title, { x: M, y: 2.7, w: 11, h: 1.8, fontFace: F.head, fontSize: 38, bold: true, color: C.white, valign: "top", margin: 0, isTextBox: true });
  s.addText(sub, { x: M, y: 4.6, w: 9.6, h: 1.1, fontFace: F.body, fontSize: 18, color: C.subtle, valign: "top", margin: 0, isTextBox: true });
  s.addText(tag, { x: M, y: 6.55, w: 8, h: 0.3, fontFace: F.mono, fontSize: 12, color: C.subtle, margin: 0, isTextBox: true });
  stripe(s);
  return s;
}

function content(pres, eyebrow, title, notes) {
  const s = pres.addSlide({ masterName: "LIGHT" });
  s.addText(eyebrow.toUpperCase(), { x: M, y: 0.5, w: 10, h: 0.3, fontFace: F.body, fontSize: 12, bold: true, color: C.violet, charSpacing: 3, margin: 0, isTextBox: true, objectName: "Eyebrow" });
  s.addText(title, { x: M, y: 0.85, w: W - 2 * M, h: 0.95, fontFace: F.head, fontSize: 32, bold: true, color: C.ink, valign: "top", margin: 0, isTextBox: true, objectName: "Title" });
  if (notes) s.addNotes(notes);
  return s;
}

function card(s, x, y, w, h, { num, head, body, mono, tint }) {
  s.addShape("roundRect", {
    x, y, w, h, rectRadius: 0.08,
    fill: { color: tint ? C.violet50 : C.white }, line: { color: tint ? C.violet100 : C.border, width: 1 },
    shadow: { type: "outer", color: "171717", opacity: 0.06, blur: 8, offset: 2, angle: 90 },
    objectName: "Card",
  });
  let ty = y + 0.3;
  if (num !== undefined) {
    s.addShape("ellipse", { x: x + 0.3, y: y + 0.3, w: 0.5, h: 0.5, fill: { color: C.violet100 }, line: { color: C.violet100, width: 0 } });
    s.addText(String(num), { x: x + 0.3, y: y + 0.3, w: 0.5, h: 0.5, fontFace: F.mono, fontSize: 14, bold: true, color: C.violet, align: "center", valign: "middle", margin: 0, isTextBox: true });
    ty = y + 0.95;
  }
  s.addText(head, { x: x + 0.3, y: ty, w: w - 0.6, h: 0.75, fontFace: mono ? F.mono : F.head, fontSize: 18, bold: true, color: C.ink, valign: "top", margin: 0, isTextBox: true });
  s.addText(body, { x: x + 0.3, y: ty + 0.8, w: w - 0.6, h: h - (ty - y) - 1.05, fontFace: F.body, fontSize: 14, color: "404040", valign: "top", margin: 0, paraSpaceAfter: 6, isTextBox: true });
}

function cards(s, items, { y = 2.15, h = 3.7, tintFirst = false } = {}) {
  const n = items.length, gap = 0.3, w = (W - 2 * M - gap * (n - 1)) / n;
  items.forEach((it, i) => card(s, M + i * (w + gap), y, w, h, { ...it, tint: tintFirst && i === 0 }));
}

function bullets(s, items, x, y, w, h, size = 16) {
  s.addText(
    items.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i < items.length - 1 } })),
    { x, y, w, h, fontFace: F.body, fontSize: size, color: C.ink, valign: "top", margin: 0, paraSpaceAfter: 10, isTextBox: true },
  );
}

function stat(s, big, label, x, y, w, h, dark) {
  s.addShape("roundRect", { x, y, w, h, rectRadius: 0.08, fill: { color: C.white }, line: { color: C.border, width: 1 }, objectName: "Stat card" });
  s.addText(big, { x: x + 0.3, y: y + 0.25, w: w - 0.6, h: 1.1, fontFace: F.head, fontSize: 54, bold: true, color: C.violet, margin: 0, valign: "middle", isTextBox: true });
  s.addText(label, { x: x + 0.3, y: y + 1.4, w: w - 0.6, h: h - 1.6, fontFace: F.body, fontSize: 14, color: "404040", valign: "top", margin: 0, isTextBox: true });
}

function flow(s, steps, y = 2.3, h = 3.2) {
  const n = steps.length, gap = 0.45, w = (W - 2 * M - gap * (n - 1)) / n;
  steps.forEach((st, i) => {
    const x = M + i * (w + gap);
    card(s, x, y, w, h, { num: i + 1, head: st.head, body: st.body });
    if (i < n - 1)
      s.addText("→", { x: x + w, y: y + h / 2 - 0.25, w: gap, h: 0.5, fontFace: F.mono, fontSize: 20, color: C.violet, align: "center", margin: 0, isTextBox: true });
  });
}

// Screenshot + explanation slide
async function shotSlide(pres, { eyebrow, title, image, step, head, body, tip }) {
  const s = content(pres, eyebrow, title);
  const iw = 7.9, ih = iw / 1.6, ix = M, iy = 2.0;
  s.addShape("roundRect", { x: ix - 0.04, y: iy - 0.04, w: iw + 0.08, h: ih + 0.08, rectRadius: 0.06, fill: { color: C.white }, line: { color: C.border, width: 1 }, objectName: "Screenshot frame" });
  s.addImage({ path: await shot(image), x: ix, y: iy, w: iw, h: ih, altText: `${head} — Pulse screenshot` });
  const tx = ix + iw + 0.45, tw = W - M - tx;
  if (step) s.addText(step, { x: tx, y: iy, w: tw, h: 0.3, fontFace: F.mono, fontSize: 12, bold: true, color: C.violet, margin: 0, isTextBox: true });
  s.addText(head, { x: tx, y: iy + 0.4, w: tw, h: 0.9, fontFace: F.head, fontSize: 22, bold: true, color: C.ink, valign: "top", margin: 0, isTextBox: true });
  s.addText(body, { x: tx, y: iy + 1.35, w: tw, h: tip ? 1.7 : 2.7, fontFace: F.body, fontSize: 15, color: "404040", valign: "top", margin: 0, isTextBox: true });
  if (tip) {
    s.addShape("roundRect", { x: tx, y: iy + 3.15, w: tw, h: 1.5, rectRadius: 0.08, fill: { color: C.violet50 }, line: { color: C.violet100, width: 1 }, objectName: "Tip" });
    s.addText([{ text: "TIP  ", options: { bold: true, color: C.violet, fontFace: F.body, fontSize: 11, charSpacing: 2 } }, { text: tip, options: { color: C.ink, fontFace: F.body, fontSize: 14 } }],
      { x: tx + 0.2, y: iy + 3.25, w: tw - 0.4, h: 1.3, valign: "top", margin: 0, isTextBox: true });
  }
  return s;
}

async function save(pres, name) {
  const file = path.join(OUT, name);
  await pres.writeFile({ fileName: file });
  await applyTheme(file, THEME);
  console.log("wrote", name);
}

// =====================================================================
// 1. Board overview (refresh)
// =====================================================================
async function board() {
  const pres = newDeck("DataCentral Pulse — board overview", "DataCentral Pulse · Board overview · 2026");
  await titleSlide(pres, {
    eyebrow: "DataCentral Pulse",
    title: "The system of record for what customers ask, and what DataCentral ships",
    sub: "Pulse turns scattered feedback into a scored, published roadmap, and closes the loop with the customer by email.",
    tag: "Board overview · October 2026",
  });

  let s = content(pres, "The problem", "Feedback has no system of record");
  cards(s, [
    { head: "Scattered by default", body: "Requests arrive by email, calls and Slack. DataCentral's product priorities live in someone's head, not in a shared record." },
    { head: "No shared status", body: "Customers cannot see what has already been asked for, or where it stands, without asking again." },
    { head: "Consolidation is manual", body: "The same request from three customers reads as three separate asks until someone happens to notice." },
  ]);

  s = content(pres, "Product", "One governed pipeline from request to release");
  flow(s, [
    { head: "Request", body: "A customer describes a problem. It stays private to their organization." },
    { head: "Triage and consolidate", body: "DataCentral links it to a canonical idea, or opens a new one." },
    { head: "Score and publish", body: "Prioritized internally, then published in customer-safe language." },
    { head: "Release and notify", body: "Shipped, bundled into a release, and communicated to customers." },
  ]);

  s = content(pres, "By design", "Private requests, public ideas, never confused");
  cards(s, [
    { head: "Request: private", body: "One customer's ask.\nProblem, impact, attachments.\nVisible only inside their organization.\nFull status history and comments.", tint: false },
    { head: "Idea: customer-safe", body: "DataCentral's canonical record.\nConsolidates every request behind it.\nScored, staged and explicitly published.\nShown on the public roadmap.", tint: true },
  ]);

  s = content(pres, "Who it is for", "One app, two sides of the same conversation");
  cards(s, [
    { head: "DataCentral customers", body: "Submit requests, track status and see what is shipping. Origo, Landsnet, RARIK and partners such as Crayon are on Pulse today." },
    { head: "Product and support", body: "Triage, consolidate, score and publish, with a full audit trail behind every decision." },
    { head: "One identity, many roles", body: "The same person can hold a different role at each customer company they belong to, enforced on every request." },
  ]);

  s = content(pres, "New this quarter", "Release emails close the loop with customers");
  cards(s, [
    { head: "Branded, bilingual templates", body: "Product updates, service notices and announcements in English and Icelandic. A published release offers a draft customer email in one click." },
    { head: "The right audience", body: "Target by company, role or contact. Pulse members receive communications automatically; contacts cover people without an account." },
    { head: "Delivery you can audit", body: "Every send is tracked per recipient. Bounces and unsubscribes feed a suppression list. Safe mode holds the first real send until an administrator confirms." },
  ], { h: 4.0 });

  s = content(pres, "New this quarter", "Sign-in that fits each customer");
  cards(s, [
    { head: "DataCentral launch", body: "Signed handshake from the DataCentral portal. The primary path for embedded use." },
    { head: "Microsoft Entra ID", body: "Standalone single sign-on for organizations that sign in directly." },
    { head: "Email passcode", body: "Six-digit, single-use code with a 10-minute lifetime for provisioned accounts. Administrators choose the method per user." },
  ], { h: 3.6 });

  s = content(pres, "Differentiator", "An assistant that can act, not just answer");
  cards(s, [
    { head: "In-app assistant", body: "A Claude-powered panel that reads and acts on your own data, limited to what you are permitted to see." },
    { head: "The same assistant in Slack", body: "Message it or mention it. No separate bot to learn, no context switch." },
    { head: "Guardrails on the risky actions", body: "Publishing or merging requires an explicit confirmation, every time." },
  ]);

  s = content(pres, "Differentiator", "Pulse speaks MCP, so any AI client can too");
  cards(s, [
    { head: "A standard, not a workaround", body: "Pulse runs its own OAuth-secured MCP server, the open standard Claude uses to connect to tools." },
    { head: "Signs in as a real person", body: "Every MCP connection authorizes as an actual Pulse user, never a shared service account." },
    { head: "Every action is logged", body: "The same audit trail as the web app, whether the request came from a browser or an AI agent." },
  ]);

  s = content(pres, "Pulse in numbers", "What has been built");
  const gw = (W - 2 * M - 0.3 * 3) / 4;
  [["77", "REST API paths in a published OpenAPI 3.1 contract"], ["59", "assistant tools: 24 customer, 24 internal, 11 admin"], ["15", "versioned database migrations, applied in order"], ["16", "test suites run on every change, including security cases"]]
    .forEach(([b, l], i) => stat(s, b, l, M + i * (gw + 0.3), 2.2, gw, 3.2));

  s = content(pres, "Proof point", "15 days from approved spec to a security-tested application");
  s.addText("Full authentication, an AI assistant, a Slack bot and an MCP server included. Source: project history, July 2026.", { x: M, y: 2.2, w: 9.5, h: 0.8, fontFace: F.body, fontSize: 18, color: "404040", valign: "top", margin: 0, isTextBox: true });
  stat(s, "15 days", "from approved product spec to a working, tested application", M, 3.3, 5.2, 3.0);

  s = content(pres, "Trust", "Held to the same bar DataCentral sells");
  cards(s, [
    { head: "No standing credentials", body: "Azure SQL and Blob Storage are reached only through managed identity. No passwords or keys to leak." },
    { head: "Every action is attributable", body: "Status changes, publishes and admin actions write to an audit trail, not just a log line." },
    { head: "Documented, not assumed", body: "A published OpenAPI contract and a typed request and response surface." },
  ]);

  s = content(pres, "Status", "Built fast. Launch gates are known, not hidden");
  cards(s, [
    { head: "Working today", body: "Full request-to-release workflow\nAI assistant, Slack bot and MCP server\nCustomer communications and release emails\nEmail-passcode, Entra and DataCentral sign-in\nBilingual UI (English and Icelandic)\nGuided tours and in-app help", tint: true },
    { head: "Before general launch", body: "Production identity tenant and verified email domain\nMalware scanning and private networking\nBackup restore drill and load testing\nPenetration test and operator rollback exercise\nWCAG 2.2 AA audit and Icelandic copy review" },
  ]);

  await closingSlide(pres, "Feedback has a home. Let's talk about what is next.", "Questions, a live walkthrough, or a look at the launch checklist.", "DataCentral Pulse");
  await save(pres, "DataCentral-Pulse-Board-Overview.pptx");
}

// =====================================================================
// 2. Technical overview (refresh)
// =====================================================================
async function technical() {
  const pres = newDeck("DataCentral Pulse — technical overview", "DataCentral Pulse · Technical overview · 2026");
  await titleSlide(pres, {
    eyebrow: "DataCentral Pulse",
    title: "Technical overview",
    sub: "Architecture, integrations and security posture for the engineering team.",
    tag: "Engineering · October 2026",
  });

  dividerSlide(pres, "01", "Product and domain model");
  let s = content(pres, "Product", "Two objects, one governed workflow");
  cards(s, [
    { head: "Request · DCI-####", mono: true, body: "One customer's private submission: problem, impact, attachments and full status history." },
    { head: "Idea · IDEA-###", mono: true, body: "DataCentral's canonical record. Consolidates requests, gets scored, and is explicitly published in customer-safe language." },
    { head: "Guarded transitions", body: "validateTransition() enforces required fields per status. Released requires notes and an availability date. Edits and publishes carry an If-Match version." },
  ]);

  s = content(pres, "Data model", "Fifteen migrations, four groups of tables");
  cards(s, [
    { head: "Core", body: "Organizations, Users, Memberships, Requests and RequestRevisions, Ideas, RequestIdeaLinks" },
    { head: "Workflow", body: "Comments, Attachments, ScoreSnapshots, RoadmapPlacements, Releases and ReleaseIdeas, IdeaAliases" },
    { head: "Communications", body: "Communications, deliveries, events, contacts and suppressions" },
    { head: "Operational", body: "Notifications, AuditEvents, IdempotencyKeys, RateLimits, OtpCodes, TourProgress, TourSettings, Settings" },
  ]);

  dividerSlide(pres, "02", "Architecture");
  s = content(pres, "Architecture", "Request path, end to end");
  flow(s, [
    { head: "Client", body: "Browser, DataCentral iframe, Slack, MCP clients" },
    { head: "proxy.ts", body: "CSP, CSRF, same-origin checks, rate limits" },
    { head: "Next.js 16", body: "Standalone container on Azure App Service" },
    { head: "Azure SQL and Blob", body: "Managed identity, no stored credentials" },
    { head: "Key Vault", body: "Secrets, plus Application Insights telemetry" },
  ], 2.3, 3.4);

  s = content(pres, "Reality check", "One shell, feature modules, a versioned API");
  cards(s, [
    { head: "app/features is the UI", body: "app/page.tsx is a thin entry. Roughly 11,000 lines of feature components sit under app/features: triage, ideas, releases, communications, settings, analytics." },
    { head: "77 REST API paths", body: "The real surface lives under /api/v1, documented in a live OpenAPI 3.1 contract at /api/v1/openapi." },
    { head: "proxy.ts is the gatekeeper", body: "CSP, CSRF and rate limits run here, ahead of every request. Limits are stored in dbo.RateLimits so they hold across restarts." },
  ]);

  s = content(pres, "Data layer", "Hand-written SQL, not an ORM");
  cards(s, [
    { head: "Raw, parameterized queries", body: "Every repository talks to Azure SQL directly through mssql. drizzle-orm is present only as empty scaffolding." },
    { head: "Dual-mode repositories", body: "Without AZURE_SQL_* configured, the same code runs against a seeded in-memory adapter. The whole test suite runs this way." },
    { head: "Migrations, not model sync", body: "Fifteen versioned .sql files under database/migrations/, applied in order and tracked in dbo.SchemaMigrations." },
  ]);

  s = content(pres, "Concurrency", "Optimistic locking and idempotent writes");
  cards(s, [
    { head: "Opaque version", body: "Requests, ideas and releases expose a version. Edit and publish APIs require If-Match; stale clients receive 412 and must reread." },
    { head: "Idempotency-Key", body: "Create and publish operations replay safely. Keys are scoped to user, organization and operation, and bound to a hash of the body." },
    { head: "Same rule for chat and MCP", body: "Assistant and MCP tools must present the version they observed, so an agent cannot overwrite a human's newer edit." },
  ]);

  dividerSlide(pres, "03", "Identity and access");
  s = content(pres, "Authentication", "Four sign-in paths, one session");
  cards(s, [
    { head: "DataCentral embed", body: "HMAC-signed launch payload (dcData/dcSig) verified against DC_APP_SECRET. The primary path." },
    { head: "Standalone Entra ID", body: "OIDC with PKCE, state and nonce for direct /auth/login access." },
    { head: "Email passcode", body: "Six digits, HMAC digest at rest, 10-minute TTL, 5 attempts, 3 issues per 15 minutes. Only users designated OTP may use it." },
    { head: "One shared cookie", body: "All paths mint the same jose-signed pulse-session JWT, HS256, 12-hour TTL." },
  ]);

  s = content(pres, "Authorization", "Roles live on the membership, not the user");
  cards(s, [
    { head: "No global roles", body: "Access is per organization membership. The same person can be a Company admin at one customer and a Viewer at another." },
    { head: "Customer side", body: "Company admin, Requester, Viewer." },
    { head: "Internal side", body: "Internal contributor, Product manager, System admin. Enforced server-side on every call, not just hidden in the UI." },
  ]);

  dividerSlide(pres, "04", "AI, Slack and MCP");
  s = content(pres, "AI assistant", "59 tools, scoped to what the caller can see");
  cards(s, [
    { head: "Built on the Anthropic API", body: "Tool-use loop, default model claude-opus-4-8, capped at 16 iterations per turn." },
    { head: "24 customer, 24 internal, 11 admin", body: "Group gating is prompt hygiene. The repository layer underneath is the real authorization boundary." },
    { head: "Confirm before you break something", body: "Destructive tools such as publish or merge refuse to run without an explicit confirmation flag." },
  ]);

  s = content(pres, "Same assistant, more doors", "Slack and MCP reuse the same brain");
  cards(s, [
    { head: "Slack via Socket Mode", body: "Message or mention. No inbound webhook. Identity is matched by verified Slack email against dbo.Users." },
    { head: "A real MCP server", body: "claude mcp add --transport http pulse https://{host}/mcp exposes every tool over the Model Context Protocol." },
    { head: "Its own OAuth 2.1 server", body: "Dynamic client registration, mandatory PKCE and rotating 60-day refresh tokens, built in-house." },
  ]);

  dividerSlide(pres, "05", "Communications");
  s = content(pres, "Customer communications", "A queued, at-least-once delivery pipeline");
  flow(s, [
    { head: "Compose", body: "Branded bilingual templates. Optional draft from a published release." },
    { head: "Resolve audience", body: "Companies, roles, members and contacts, minus the suppression list." },
    { head: "Send via SendGrid", body: "Leased batches from a job endpoint. Safe mode until first real send." },
    { head: "Track events", body: "Signed Event Webhook records delivery, bounces and unsubscribes." },
  ], 2.3, 3.4);

  s = content(pres, "Communications", "Failure modes are named, alertable and recoverable");
  cards(s, [
    { head: "At-least-once", body: "A batch whose 15-minute lease expires is sent again, at most five times per delivery." },
    { head: "Misconfiguration stops the run", body: "A 401 or 403 from SendGrid logs communications.send.misconfigured, gives rows back and dead-letters nothing." },
    { head: "Dead letters are visible", body: "Settings shows the dead-letter count and requeues 100 per click." },
  ]);

  dividerSlide(pres, "06", "Security, testing and deployment");
  s = content(pres, "Security posture", "Zero passwords or storage keys in the codebase");
  stat(s, "0", "passwords or storage keys anywhere in the codebase. Azure SQL and Blob Storage are reached entirely through managed identity. Source: README.md, infra/main.bicep", M, 2.2, 5.6, 3.6);
  bullets(s, ["Attachments quarantined until a Defender for Storage verdict returns Clean", "Downloads re-check parent access and bind to the approved ETag", "Webhook payloads signed with HMAC-SHA256 and a timestamp", "Customer text, email addresses and filenames are kept out of telemetry"], 6.8, 2.3, 5.8, 3.6, 16);

  s = content(pres, "Quality", "Security edge cases, not just happy paths");
  cards(s, [
    { head: "16 suites, 11,000+ lines", body: "Domain rules, workflow, auth, OTP, chat, Slack, MCP OAuth, communications, tours and i18n." },
    { head: "Typecheck gates every run", body: "npm test runs tsc --noEmit before a single test executes." },
    { head: "Real attack scenarios", body: "CSRF, PKCE, token replay, tenant isolation and anti-enumeration are under test, not assumed." },
  ]);

  s = content(pres, "Deployment", "Two scripts, managed identity throughout");
  cards(s, [
    { head: "provision.ps1, once per environment", body: "Deploys the Bicep template, creates the registry and seeds Key Vault secrets." },
    { head: "deploy.ps1, every release", body: "Builds in Azure, applies pending SQL migrations, grants the app identity DB access, restarts and polls health." },
    { head: "Four scheduled jobs", body: "Notifications, webhooks and communications every minute; retention daily. Authenticated with x-pulse-job-secret." },
  ]);

  s = content(pres, "Launch gates", "What is between here and general availability");
  cards(s, [
    { head: "Identity and delivery", body: "External ID tenant and user flows. Verified outbound email domain and SendGrid event-webhook key." },
    { head: "Security and resilience", body: "Defender-for-Storage wiring, private networking, restore drills and a penetration test." },
    { head: "Quality and compliance", body: "WCAG 2.2 AA audit, Icelandic copy review, load testing at expected volume and a rollback exercise." },
  ]);

  await closingSlide(pres, "Code, docs and the live environment are ready for a walkthrough.", "docs/architecture.md, docs/launch-runbook.md and the OpenAPI contract at /api/v1/openapi are the fastest way in.", "DataCentral Pulse · Engineering");
  await save(pres, "DataCentral-Pulse-Technical-Overview.pptx");
}

// =====================================================================
// 3. Customer end-user tutorial
// =====================================================================
async function customer() {
  const pres = newDeck("DataCentral Pulse — customer guide", "DataCentral Pulse · Customer guide");
  await titleSlide(pres, {
    eyebrow: "Customer guide",
    title: "Get your ideas in front of the DataCentral product team",
    sub: "A ten-minute walkthrough of Pulse: finding what has already been asked, submitting a request, and following it to release.",
    tag: "DataCentral Pulse · For customer teams",
  });

  let s = content(pres, "Overview", "What Pulse does for your team");
  cards(s, [
    { num: 1, head: "Ask", body: "Search existing ideas, then submit a request when nothing matches." },
    { num: 2, head: "Follow", body: "See the status of every request from your organization, in one list." },
    { num: 3, head: "Know", body: "Get notified when a request moves, and see what has shipped." },
  ], { h: 3.2 });
  s.addText("Your requests stay private to your organization. DataCentral publishes ideas in customer-safe language, so nobody sees another company's raw request.", { x: M, y: 5.7, w: W - 2 * M, h: 0.8, fontFace: F.body, fontSize: 16, color: "404040", valign: "top", margin: 0, isTextBox: true });

  s = content(pres, "Signing in", "Open Pulse the way your organization set it up");
  cards(s, [
    { head: "From DataCentral", body: "Launch Pulse from your DataCentral portal. You arrive signed in, with no second login." },
    { head: "Microsoft sign-in", body: "Use your work account at the Pulse address if your organization signs in directly." },
    { head: "Email passcode", body: "Enter your email, then the six-digit code we send. It works once and expires after 10 minutes." },
  ], { h: 3.4 });
  s.addText("If you belong to several companies, Pulse asks which one to use after you sign in. You can switch from the company selector in the top bar.", { x: M, y: 5.8, w: W - 2 * M, h: 0.8, fontFace: F.body, fontSize: 16, color: "404040", valign: "top", margin: 0, isTextBox: true });

  await shotSlide(pres, { eyebrow: "Tour: Welcome", title: "Your home page", image: "welcome-step-1", step: "STEP 1 OF 9", head: "Start from Home", body: "Home shows your organization's active requests, items waiting on you, and what shipped recently. A short guided tour starts the first time you arrive." });
  await shotSlide(pres, { eyebrow: "Tour: Welcome", title: "Getting around", image: "welcome-step-2", step: "STEP 2 OF 9", head: "One menu for everything", body: "Home, Browse ideas, Roadmap, My requests and Updates all live in the left menu.", tip: "The DataCentral team section appears only for internal staff. Customers never see it." });
  await shotSlide(pres, { eyebrow: "Tour: Welcome", title: "Search before you ask", image: "welcome-step-3", step: "STEP 3 OF 9", head: "Check what already exists", body: "Search existing ideas before you submit. Another team may already have asked for the same thing, and you can add your organization's interest instead." });
  await shotSlide(pres, { eyebrow: "Tour: Welcome", title: "Your status at a glance", image: "welcome-step-5", step: "STEP 5 OF 9", head: "Three numbers that matter", body: "Active requests, requests that need your input, and recently released items. Select a tile to open the matching list." });
  await shotSlide(pres, { eyebrow: "Tour: Welcome", title: "Follow your requests", image: "welcome-step-6", step: "STEP 6 OF 9", head: "The latest activity", body: "Open a request to read comments, see attachments and review its status history. Edits are version-checked, so two colleagues never overwrite each other silently." });

  dividerSlide(pres, "01", "Submit a request", "Four steps, about three minutes.");
  await shotSlide(pres, { eyebrow: "Tour: Submitting a request", title: "Open the request form", image: "submit-request-step-1", step: "STEP 1 OF 4", head: "Select Submit a request", body: "The button sits in the top bar on every page, so you can start from wherever you noticed the problem." });
  await shotSlide(pres, { eyebrow: "Tour: Submitting a request", title: "Start with a short title", image: "submit-request-step-2", step: "STEP 2 OF 4", head: "A sharp title", body: "As you type, Pulse suggests existing ideas that look similar. If one fits, follow it instead of filing a duplicate.", tip: "Name the outcome, not the solution: “Scheduled report delivery to SharePoint”." });
  await shotSlide(pres, { eyebrow: "Tour: Submitting a request", title: "Describe the outcome", image: "submit-request-step-3", step: "STEP 3 OF 4", head: "What, who and why", body: "Explain what you are trying to achieve, who is affected, and what happens today. Impact and context help triage. Drafts save to your account and organization, and device copies expire after 24 hours." });
  await shotSlide(pres, { eyebrow: "Tour: Submitting a request", title: "Submit when ready", image: "submit-request-step-4", step: "STEP 4 OF 4", head: "Attach and send", body: "Add screenshots or files up to 25 MB each. Attachments are scanned before anyone can download them. Choose who in your organization can see the request.", tip: "Do not upload credentials, personal data or unredacted production data." });

  s = content(pres, "After you submit", "What happens to your request");
  flow(s, [
    { head: "Received", body: "Your request appears in My requests with a DCI number." },
    { head: "In review", body: "DataCentral triages it, may ask for information, or links it to an idea." },
    { head: "Planned", body: "The idea is scored and appears on the roadmap." },
    { head: "Released", body: "Release notes and an availability date are attached, and you are notified." },
  ], 2.3, 3.4);

  await shotSlide(pres, { eyebrow: "Tour: Welcome", title: "Notifications", image: "welcome-step-7", step: "STEP 7 OF 9", head: "Know when something changes", body: "Status changes and responses land here. Choose which events reach you by email in your notification preferences." });
  await shotSlide(pres, { eyebrow: "Tour: Welcome", title: "The assistant", image: "welcome-step-8", step: "STEP 8 OF 9", head: "Ask in plain language", body: "When the assistant is enabled for you, ask it to find similar ideas, summarize your open requests or draft a new request. It can only see what you can see." });
  await shotSlide(pres, { eyebrow: "Tour: Welcome", title: "Help and tours", image: "help-menu", step: "ALWAYS AVAILABLE", head: "The ? button", body: "Replay any tour or open the full help pages from the ? button at the bottom right. Help is available in English and Icelandic.", tip: "Use Hide tours forever if you prefer a clean screen. You can restore them later." });

  s = content(pres, "Roles", "What you can do depends on your role");
  cards(s, [
    { head: "Viewer", body: "Browse ideas and the roadmap, and read your organization's requests." },
    { head: "Requester", body: "Everything a Viewer can do, plus submit requests and comment on them." },
    { head: "Company admin", body: "Everything a Requester can do, plus manage your company's people and contacts." },
  ], { h: 3.3 });
  s.addText("The same person can hold a different role at each company they belong to.", { x: M, y: 5.7, w: W - 2 * M, h: 0.6, fontFace: F.body, fontSize: 16, color: "404040", valign: "top", margin: 0, isTextBox: true });

  s = content(pres, "Good requests", "Four habits that get requests moved faster");
  cards(s, [
    { num: 1, head: "Search first", body: "Following an existing idea adds weight without adding noise." },
    { num: 2, head: "State the outcome", body: "Describe the goal and who it affects, not the feature you imagine." },
    { num: 3, head: "Give the impact", body: "Frequency, severity and the workaround you use today." },
    { num: 4, head: "Attach evidence", body: "A screenshot or sample report removes a round of questions." },
  ], { h: 3.6 });

  await closingSlide(pres, "Your next request starts with a search.", "Open Pulse from DataCentral, or use the ? button for the full help pages.", "DataCentral Pulse · Customer guide");
  await save(pres, "DataCentral-Pulse-Customer-Guide.pptx");
}

// =====================================================================
// 4. Pulse manager tutorial
// =====================================================================
async function manager() {
  const pres = newDeck("DataCentral Pulse — manager guide", "DataCentral Pulse · Manager guide");
  await titleSlide(pres, {
    eyebrow: "Manager guide",
    title: "Run Pulse: triage, publish, release and communicate",
    sub: "A working guide for DataCentral product managers and system administrators, with the screens you will use every week.",
    tag: "DataCentral Pulse · Internal",
  });

  let s = content(pres, "Overview", "Your weekly rhythm in Pulse");
  flow(s, [
    { head: "Triage", body: "Work the inbox. Decide the next step for every new request." },
    { head: "Shape ideas", body: "Consolidate requests into canonical ideas and score them." },
    { head: "Publish and release", body: "Publish in customer-safe language and bundle shipped ideas into releases." },
    { head: "Communicate", body: "Email affected customers, then read the analytics." },
  ], 2.3, 3.4);

  s = content(pres, "Access", "What each internal role can do");
  cards(s, [
    { head: "Internal contributor", body: "Read requests and ideas, comment internally and prepare triage notes." },
    { head: "Product manager", body: "Triage, consolidate, score, publish ideas, manage releases and send communications." },
    { head: "System admin", body: "Everything above, plus users, companies, authentication policy, settings and the audit log." },
  ], { h: 3.4 });

  await shotSlide(pres, { eyebrow: "Tour: Team workspace", title: "The team workspace", image: "team-workspace-step-1", step: "STEP 1 OF 6", head: "Internal views, hidden from customers", body: "The DataCentral team section holds triage, product ideas, releases, communications and analytics. Customers never see it." });
  await shotSlide(pres, { eyebrow: "Tour: Team workspace", title: "Triage inbox", image: "team-workspace-step-2", step: "STEP 2 OF 6", head: "Every new request lands here", body: "Review the queue for assessment, tagging and response. The counter shows what has not been picked up." });
  await shotSlide(pres, { eyebrow: "Tour: Team workspace", title: "Work the queue", image: "team-workspace-step-3", step: "STEP 3 OF 6", head: "Pick the next step", body: "Open a request, review the customer's context, then link it to a product idea, ask for information, or close it with a reason.", tip: "Required fields change by status. A request cannot reach Released without notes and an availability date." });
  await shotSlide(pres, { eyebrow: "Tour: Team workspace", title: "Product ideas", image: "team-workspace-step-4", step: "STEP 4 OF 6", head: "One idea, many requests", body: "Consolidate duplicate requests behind one canonical idea. Score it, stage it on the roadmap, and publish it explicitly in customer-safe language." });
  await shotSlide(pres, { eyebrow: "Tour: Team workspace", title: "Releases", image: "team-workspace-step-5", step: "STEP 5 OF 6", head: "Bundle what shipped", body: "Group ideas into a release with notes and an availability date. Publishing a release notifies the customers who asked.", tip: "Use Draft customer email on a published release to start a communication." });
  await shotSlide(pres, { eyebrow: "Tour: Team workspace", title: "Analytics", image: "team-workspace-step-6", step: "STEP 6 OF 6", head: "See the shape of demand", body: "Request volume, outcomes, response times and distribution across the portfolio, so prioritization rests on data." });

  dividerSlide(pres, "01", "Customer communications", "Tell customers what shipped, in their language.");
  await shotSlide(pres, { eyebrow: "Tour: Customer communications", title: "Compose a communication", image: "customer-communications-step-2", step: "STEP 2 OF 4", head: "Start from a template", body: "Choose a product update, service notice or plain announcement. Each template is branded and bilingual. Published releases also offer Draft customer email." });
  await shotSlide(pres, { eyebrow: "Tour: Customer communications", title: "Choose recipients", image: "customer-communications-step-3", step: "STEP 3 OF 4", head: "Members and contacts", body: "Pulse members receive communications automatically. Add contacts for people without a Pulse account. Company admins maintain their own company's list.", tip: "Unsubscribes and bounces enter the suppression list and are honored on every future send." });
  await shotSlide(pres, { eyebrow: "Tour: Customer communications", title: "SendGrid settings", image: "customer-communications-step-4", step: "STEP 4 OF 4", head: "Sending is switched on deliberately", body: "System admins enable sending, choose the sender, keep safe mode on until the first real send, and verify the configuration under Settings." });

  dividerSlide(pres, "02", "Administration", "System admin only.");
  await shotSlide(pres, { eyebrow: "Tour: Admin controls", title: "Product settings", image: "admin-settings-step-1", step: "STEP 1 OF 4", head: "Policy in one place", body: "Attachment policy, scoring weights, taxonomy, webhooks and onboarding are configured under Settings." });
  await shotSlide(pres, { eyebrow: "Tour: Admin controls", title: "Onboarding tours", image: "admin-settings-step-2", step: "STEP 2 OF 4", head: "Control who sees which tour", body: "The master switch turns the whole system on or off. Per tour you decide availability, audience and auto-start." });
  await shotSlide(pres, { eyebrow: "Tour: Admin controls", title: "Who has seen what", image: "admin-settings-step-3", step: "STEP 3 OF 4", head: "Progress by person", body: "See each user's status and last step per tour, and filter by tour or status. People can hide tours forever; only they can restore them." });
  await shotSlide(pres, { eyebrow: "Tour: Admin controls", title: "Background delivery", image: "admin-settings-step-4", step: "STEP 4 OF 4", head: "Watch the queues", body: "Failed deliveries stay visible until an administrator retries them. The card covers notifications, webhooks and communications, including dead letters." });

  s = content(pres, "Users and sign-in", "Provision people, then choose how they sign in");
  cards(s, [
    { num: 1, head: "Add the user", body: "Under Users, invite the person and set their organization membership and role." },
    { num: 2, head: "Pick the method", body: "Under Authentication, choose DataCentral launch, Microsoft Entra ID or email passcode per user." },
    { num: 3, head: "Verify access", body: "Check the audit log. Authentication identifies the person; membership authorizes their access." },
  ], { h: 3.4 });

  s = content(pres, "Operating Pulse", "A short weekly checklist");
  cards(s, [
    { head: "Monday", body: "Clear the triage inbox. Every request has a next step and an owner." },
    { head: "Midweek", body: "Consolidate duplicates, rescore ideas and publish the ones ready for customers." },
    { head: "Friday", body: "Release what shipped, send the customer email, and review delivery and dead letters." },
  ], { h: 3.2 });

  await closingSlide(pres, "Keep the loop closed: request, idea, release, email.", "The ? button replays every tour. The help pages hold the full manual for administrators.", "DataCentral Pulse · Manager guide");
  await save(pres, "DataCentral-Pulse-Manager-Guide.pptx");
}

(async () => {
  await board();
  await technical();
  await customer();
  await manager();
})().catch((e) => { console.error(e); process.exit(1); });
