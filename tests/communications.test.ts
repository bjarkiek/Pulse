import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PulseIdentity } from "../lib/domain";
import { memoryContacts, resetCommunicationMemory } from "../lib/server/communications/memory";
import {
  DEFAULT_COMMUNICATION_SETTINGS,
  getCommunicationSettings,
  getRuntimeCommunicationSettings,
  saveCommunicationSettings,
  communicationProviderStatus,
} from "../lib/server/communications/settings";
import { escapeHtml, inlineToText, renderInline } from "../lib/server/communications/html";
import { getTemplate, renderCommunication } from "../lib/server/communications/templates/index";
import { executeIdempotent } from "../lib/server/idempotency";
import { checkedMutation } from "../lib/server/versions";
import {
  communicationInputSchema,
  communicationSendInputSchema,
  communicationTestSendSchema,
  productUpdateBodySchema,
} from "../lib/contracts";
import {
  importCompanyContacts, importContacts, listCompanyContacts, listContacts, parseContactLines, removeContact,
  saveCompanyContact, saveContact, removeCompanyContact,
} from "../lib/server/communications/contact-repository";
import {
  addSuppression, listSuppressions, loadSuppressionMap, releaseAddress, removeSuppression, suppressAddress,
} from "../lib/server/communications/suppression-repository";
import { listUsers, organizations, users } from "../lib/server/admin-repository";
import { loadAudienceInput, resolveAudience, type AudienceInput } from "../lib/server/communications/audience";
import { COMMUNICATION_TOPICS, MANDATORY_TOPICS, topicEventType } from "../lib/server/communications/topics";
import type { AudienceSpec, CommunicationTopic } from "../lib/server/communications/types";
import { setUserLocaleById } from "../lib/server/identity-repository";
import {
  listNotificationPreferences, notificationEventTypes, saveNotificationPreference, type NotificationEventType,
} from "../lib/server/notification-preference-repository";

export const ADMIN: PulseIdentity = {
  id: "11111111-1111-4111-8111-111111111111", email: "bjarki@uidata.com",
  name: "Bjarki", organizationId: "ORG-INTERNAL", role: "System admin", isInternal: true,
};
export const PM: PulseIdentity = {
  id: "44444444-4444-4444-8444-444444444444", email: "pm@datacentral.ai",
  name: "Product Manager", organizationId: "ORG-INTERNAL", role: "Product manager", isInternal: true,
};
export const CONTRIBUTOR: PulseIdentity = {
  id: "33333333-3333-4333-8333-333333333333", email: "staff@datacentral.ai",
  name: "Staff", organizationId: "ORG-INTERNAL", role: "Internal contributor", isInternal: true,
};
export const COMPANY_ADMIN: PulseIdentity = {
  id: "55555555-5555-4555-8555-555555555555", email: "admin@origo.is",
  name: "Origo Admin", organizationId: "ORG-001", role: "Company admin", isInternal: false,
};
export const REQUESTER: PulseIdentity = {
  id: "22222222-2222-4222-8222-222222222222", email: "jon@origo.is",
  name: "Jón Jónsson", organizationId: "ORG-001", role: "Requester", isInternal: false,
};

beforeEach(() => {
  delete process.env.AZURE_SQL_CONNECTION_STRING;
  delete process.env.AZURE_SQL_SERVER;
  delete process.env.SENDGRID_API_KEY;
  delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
  globalThis.pulseMemoryUsers = undefined;
  globalThis.pulseMemoryOrganizations = undefined;
  globalThis.pulseMemoryAudit = undefined;
  globalThis.pulseMemoryNotificationPreferences = undefined;
  globalThis.pulseMemoryLocales = undefined;
  resetCommunicationMemory();
});

test("settings: defaults are safe (disabled, safe mode on, datacentral.ai allow-listed)", async () => {
  const settings = await getRuntimeCommunicationSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.safeMode.enabled, true);
  assert.deepEqual(settings.safeMode.allowedDomains, ["datacentral.ai"]);
  assert.equal(settings.dailyCap, 5000);
});

test("settings: only System admins read or save", async () => {
  await assert.rejects(getCommunicationSettings(PM), /FORBIDDEN/);
  await assert.rejects(saveCommunicationSettings(PM, DEFAULT_COMMUNICATION_SETTINGS), /FORBIDDEN/);
});

test("settings: enabling requires a from address; domains are normalised; audit written", async () => {
  await assert.rejects(
    saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "" }),
    /INVALID_INPUT/,
  );
  const saved = await saveCommunicationSettings(ADMIN, {
    ...DEFAULT_COMMUNICATION_SETTINGS,
    enabled: true,
    fromEmail: "Updates@DataCentral.ai",
    safeMode: { enabled: true, allowedDomains: ["DataCentral.AI", "origo.is"] },
  });
  assert.equal(saved.fromEmail, "updates@datacentral.ai");
  assert.deepEqual(saved.safeMode.allowedDomains, ["datacentral.ai", "origo.is"]);
  assert.equal(globalThis.pulseMemoryAudit?.[0]?.action, "communication.settings.updated");
  const status = communicationProviderStatus(saved);
  assert.equal(status.providerConfigured, false);
  assert.equal(status.effectiveSendingState, "provider-missing");
});

test("settings: effective sending state reflects provider, safe mode and sandbox", async () => {
  process.env.SENDGRID_API_KEY = "SG.test";
  const live = { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai", safeMode: { enabled: false, allowedDomains: [] } };
  assert.equal(communicationProviderStatus(live).effectiveSendingState, "live");
  assert.equal(communicationProviderStatus({ ...live, sandboxMode: true }).effectiveSendingState, "sandbox");
  assert.equal(communicationProviderStatus({ ...live, safeMode: { enabled: true, allowedDomains: ["datacentral.ai"] } }).effectiveSendingState, "safe-mode");
  assert.equal(communicationProviderStatus({ ...live, enabled: false }).effectiveSendingState, "disabled");
});

const ctx = {
  publicUrl: "https://pulse.test",
  boilerplate: { signOff: "Best,\nThe DataCentral Team", footer: "DataCentral ehf.", supportEmail: "support@datacentral.ai" },
  unsubscribeTags: true,
};
const productUpdate = {
  subject: { en: "DataCentral 3.0.0", is: "DataCentral 3.0.0 (is)" },
  body: {
    en: {
      title: "DataCentral 3.0.0",
      subtitle: "Better visibility and more efficient Power BI administration.",
      intro: "DataCentral 3.0.0 is now available.",
      sections: [
        {
          heading: "New built-in Admin Report",
          body: "See report activity, **adoption** and usage trends. [Setup guide](https://docs.datacentral.ai/admin-report)",
          callout: { tone: "warning", label: "Action required for existing tenants", text: "A Host Administrator must enable the Admin Report." },
          link: { label: "View the setup guide and video", url: "https://docs.datacentral.ai/admin-report" },
        },
      ],
      note: "DataCentral 3.0.0 also displays dates and times in each user's local time.",
      cta: { label: "Explore DataCentral 3.0.0", url: "https://app.datacentral.ai" },
    },
  },
};

test("html: escapes HTML and only renders https links", () => {
  assert.equal(escapeHtml(`<b>"x" & 'y'</b>`), "&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;");
  const html = renderInline("Hello **world** [docs](https://docs.datacentral.ai/a?b=1&c=2) [bad](javascript:alert(1)) <script>x</script>");
  assert.match(html, /<strong>world<\/strong>/);
  assert.match(html, /<a href="https:\/\/docs\.datacentral\.ai\/a\?b=1&amp;c=2"/);
  assert.ok(!html.includes('href="javascript:'), "non-https links stay literal (escaped) text, never an href");
  assert.ok(!html.includes("<script>"));
  assert.equal(inlineToText("Hello **world** [docs](https://x.test)"), "Hello world docs (https://x.test)");
});

test("templates: product update renders brand chrome, sections, callout, CTA and plain text", () => {
  const rendered = renderCommunication("product-update", productUpdate, "en", ctx);
  assert.equal(rendered.subject, "DataCentral 3.0.0");
  assert.match(rendered.html, /Product update/);
  assert.match(rendered.html, /#f9c815/); // brand stripe
  assert.match(rendered.html, /https:\/\/pulse\.test\/email\/datacentral-logo\.png/);
  assert.match(rendered.html, /Action required for existing tenants/);
  assert.match(rendered.html, /Explore DataCentral 3\.0\.0/);
  assert.match(rendered.html, /<%asm_group_unsubscribe_raw_url%>/);
  assert.match(rendered.text, /New built-in Admin Report/);
  assert.match(rendered.text, /Explore DataCentral 3\.0\.0: https:\/\/app\.datacentral\.ai/);
  assert.ok(!rendered.html.includes("<script"));
});

test("templates: Icelandic falls back to English body but uses Icelandic chrome and subject", () => {
  const rendered = renderCommunication("product-update", productUpdate, "is", ctx);
  assert.equal(rendered.subject, "DataCentral 3.0.0 (is)");
  assert.match(rendered.html, /Vöruuppfærsla/);
  assert.match(rendered.html, /Aðgerðar þörf|Action required for existing tenants/);
  assert.match(rendered.html, /Afskrá/);
});

test("templates: test prefix and missing unsubscribe group", () => {
  const rendered = renderCommunication("plain", { subject: { en: "Hello" }, body: { en: { title: "Hi", paragraphs: ["One"] } } }, "en", { ...ctx, unsubscribeTags: false, testPrefix: true });
  assert.equal(rendered.subject, "[TEST] Hello");
  assert.ok(!rendered.html.includes("asm_group_unsubscribe"));
  assert.match(rendered.html, /support@datacentral\.ai/);
});

test("contracts: rejects non-https links in content and unknown template bodies", () => {
  assert.equal(productUpdateBodySchema.safeParse({ ...productUpdate.body.en, cta: { label: "x", url: "http://x.test" } }).success, false);
  const invalid = communicationInputSchema.safeParse({
    templateKey: "product-update", topic: "product-updates", title: "t",
    content: { subject: { en: "s" }, body: { en: { title: "only" } } },
    audience: { organizations: "all-customers" },
  });
  assert.equal(invalid.success, false);
  const valid = communicationInputSchema.safeParse({
    templateKey: "product-update", topic: "product-updates", title: "t",
    content: productUpdate, audience: { organizations: ["ORG-001"] },
  });
  assert.equal(valid.success, true);
  assert.equal(valid.data?.audience.includeMembers, true);
});

const serviceNotice = {
  subject: { en: "Planned maintenance on 20 October" },
  preheader: { en: "Pulse is read-only for two hours." },
  body: {
    en: {
      title: "Planned maintenance",
      summary: "We are upgrading **Pulse**.\n\nNo data is lost.",
      window: { startsAt: "2026-10-20 22:00", endsAt: "2026-10-21 00:00", timezone: "UTC" },
      impact: "Pulse is read-only during the window.",
      actions: ["Save your work before 22:00.", "Reload Pulse after 00:00 <b>please</b>."],
      link: { label: "Status page", url: "https://status.datacentral.ai" },
      contact: "Need help? Write to support@datacentral.ai",
    },
  },
};

test("templates: service notice renders window, impact, ordered actions, link and contact", () => {
  const rendered = renderCommunication("service-notice", serviceNotice, "en", ctx);
  assert.equal(rendered.subject, "Planned maintenance on 20 October");
  assert.equal(rendered.preheader, "Pulse is read-only for two hours.");
  assert.match(rendered.html, /Service notice/);
  assert.match(rendered.html, /<strong[^>]*>When:<\/strong> 2026-10-20 22:00 – 2026-10-21 00:00 \(UTC\)/);
  assert.match(rendered.html, /<h2[^>]*>Impact<\/h2>/);
  assert.match(rendered.html, /<h2[^>]*>What you need to do<\/h2>/);
  assert.match(
    rendered.html,
    /<ol [^>]*>\s*<li [^>]*>Save your work before 22:00\.<\/li>\s*<li [^>]*>Reload Pulse after 00:00 &lt;b&gt;please&lt;\/b&gt;\.<\/li>\s*<\/ol>/,
  );
  assert.match(rendered.html, /<strong>Pulse<\/strong>/);
  assert.match(rendered.html, /<a href="https:\/\/status\.datacentral\.ai"[^>]*>Status page &rarr;<\/a>/);
  assert.ok(rendered.html.indexOf("Need help?") > rendered.html.indexOf("Status page"), "contact follows the link");
  assert.ok(rendered.html.indexOf("The DataCentral Team") > rendered.html.indexOf("Need help?"), "sign-off comes last");
  assert.match(rendered.text, /^Service notice\nPLANNED MAINTENANCE\n\nWe are upgrading Pulse\.\n\nNo data is lost\.\n/);
  assert.match(rendered.text, /\nWhen: 2026-10-20 22:00 – 2026-10-21 00:00 \(UTC\)\n/);
  assert.match(rendered.text, /\n== Impact ==\nPulse is read-only during the window\.\n/);
  assert.match(rendered.text, /\n== What you need to do ==\n1\. Save your work before 22:00\.\n2\. Reload Pulse after 00:00 <b>please<\/b>\.\n/);
  assert.match(rendered.text, /\nStatus page: https:\/\/status\.datacentral\.ai\n\nNeed help\? Write to support@datacentral\.ai\n\nBest,\nThe DataCentral Team\n\n--\n/);

  const icelandic = renderCommunication("service-notice", serviceNotice, "is", ctx);
  assert.match(icelandic.html, /Þjónustutilkynning/);
  assert.match(icelandic.html, /Hvenær:/);
  assert.match(icelandic.html, /Það sem þú þarft að gera/);
});

test("templates: service notice omits every optional block that is not provided", () => {
  const rendered = renderCommunication("service-notice", { subject: { en: "Notice" }, body: { en: { title: "Heads up", summary: "Short." } } }, "en", ctx);
  assert.ok(!rendered.html.includes("<ol"));
  assert.ok(!rendered.html.includes("<h2"));
  assert.ok(!rendered.html.includes("When:"));
  assert.ok(!rendered.text.includes("=="));
  assert.ok(!rendered.text.includes("When:"));
  assert.match(rendered.text, /^Service notice\nHEADS UP\n\nShort\.\n\nBest,\nThe DataCentral Team\n/);
});

test("templates: plain announcement renders every paragraph, the CTA and a custom sign-off", () => {
  const rendered = renderCommunication(
    "plain",
    {
      subject: { en: "Security advisory" },
      body: {
        en: {
          title: "Rotate your API keys",
          paragraphs: ["First **paragraph**.", "Second\nline."],
          cta: { label: "Open Pulse", url: "https://app.datacentral.ai" },
          signOff: "Regards,\nSecurity",
        },
      },
    },
    "en",
    ctx,
  );
  assert.match(rendered.html, /Announcement/);
  assert.match(rendered.html, /<h1[^>]*>Rotate your API keys<\/h1>/);
  assert.match(rendered.html, /<p style="[^"]*font-family:'IBM Plex Sans'[^"]*">First <strong>paragraph<\/strong>\.<\/p>/, "paragraphs carry the brand body font");
  assert.match(rendered.html, /<p [^>]*>Second<br>line\.<\/p>/);
  assert.match(rendered.html, /<a href="https:\/\/app\.datacentral\.ai"[^>]*>Open Pulse<\/a>/);
  assert.match(rendered.html, /Regards,<br><strong>Security<\/strong>/);
  assert.ok(!rendered.html.includes("The DataCentral Team"), "a custom sign-off replaces the boilerplate sign-off");
  assert.match(rendered.text, /^Announcement\nROTATE YOUR API KEYS\n\nFirst paragraph\.\n\nSecond\nline\.\n\nOpen Pulse: https:\/\/app\.datacentral\.ai\n\nRegards,\nSecurity\n\n--\n/);
  const icelandic = renderCommunication("plain", { subject: { en: "s" }, body: { en: { title: "t", paragraphs: ["p"] } } }, "is", ctx);
  assert.match(icelandic.html, /Tilkynning/);
});

test("templates: author text is escaped in HTML, links stay attribute-safe, unknown template keys are rejected", () => {
  const hostile = `<img src=x onerror=alert(1)> "quoted" & 'single'`;
  const escaped = "&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot; &amp; &#39;single&#39;";
  const rendered = renderCommunication(
    "product-update",
    {
      subject: { en: hostile },
      preheader: { en: hostile },
      body: {
        en: {
          eyebrow: hostile, title: hostile, subtitle: hostile, intro: hostile, highlightsLabel: hostile,
          sections: [{ heading: hostile, body: hostile, callout: { tone: "info", label: hostile, text: hostile }, link: { label: hostile, url: "https://x.test/?a=1&b=2" } }],
          note: hostile, cta: { label: hostile, url: "https://x.test/?a=1&b=2" }, signOff: hostile,
        },
      },
    },
    "en",
    ctx,
  );
  assert.ok(!rendered.html.includes("<img src=x"), "no author-supplied tag survives");
  assert.ok(!rendered.html.includes('"quoted"'), "no author-supplied quote survives");
  // <title>, preheader, eyebrow, title, subtitle, intro, highlights label, heading, body, callout label and text, link label, note, CTA label, sign-off
  assert.equal(rendered.html.split(escaped).length - 1, 15, "every author field is rendered escaped, exactly once");
  assert.match(rendered.html, /<a href="https:\/\/x\.test\/\?a=1&amp;b=2"/);
  assert.ok(rendered.text.includes(hostile), "plain text is not HTML-escaped");
  assert.throws(() => getTemplate("newsletter"), /INVALID_TEMPLATE/);
  assert.throws(() => getTemplate("constructor"), /INVALID_TEMPLATE/, "inherited object members are not templates");
});

test("templates: logo, body and footer rows span all four stripe columns so content uses the full card width", () => {
  const { html } = renderCommunication("plain", { subject: { en: "s" }, body: { en: { title: "t", paragraphs: ["p"] } } }, "en", ctx);
  assert.equal(html.match(/<td width="25%"/g)?.length, 4, "four stripe cells");
  assert.equal(html.match(/<td colspan="4"/g)?.length, 3, "logo, body and footer cells each span all four columns");
});

test("templates: the default settings boilerplate flows into the sign-off, footer and support address of each locale", () => {
  for (const locale of ["en", "is"] as const) {
    const boilerplate = DEFAULT_COMMUNICATION_SETTINGS.boilerplate[locale];
    const { html, text } = renderCommunication(
      "plain",
      { subject: { en: "s" }, body: { en: { title: "t", paragraphs: ["p"] } } },
      locale,
      { publicUrl: "https://pulse.test", boilerplate, unsubscribeTags: false },
    );
    const [greeting, team] = boilerplate.signOff.split("\n");
    assert.ok(html.includes(`${escapeHtml(greeting)}<br><strong>${escapeHtml(team)}</strong>`), `${locale}: HTML sign-off`);
    assert.ok(html.includes(escapeHtml(boilerplate.footer)), `${locale}: HTML footer`);
    assert.ok(html.includes(`mailto:${boilerplate.supportEmail}`), `${locale}: support address`);
    assert.ok(text.includes(`${boilerplate.signOff}\n\n--\n`), `${locale}: text sign-off precedes the footer`);
    assert.ok(text.includes(boilerplate.footer), `${locale}: text footer`);
  }
});

test("contracts: per-locale bodies are validated, send and test-send inputs are strict and bounded", () => {
  const badIcelandic = communicationInputSchema.safeParse({
    templateKey: "product-update", topic: "product-updates", title: "t",
    content: { ...productUpdate, body: { en: productUpdate.body.en, is: { title: "" } } },
    audience: { organizations: "all-customers" },
  });
  assert.equal(badIcelandic.success, false);
  assert.deepEqual(badIcelandic.error?.issues[0]?.path, ["content", "body", "is"]);
  assert.equal(communicationSendInputSchema.safeParse({}).success, true);
  assert.equal(communicationSendInputSchema.safeParse({ scheduledAt: "2026-11-01T09:00:00Z" }).success, true);
  assert.equal(communicationSendInputSchema.safeParse({ scheduledAt: "tomorrow" }).success, false);
  assert.equal(communicationSendInputSchema.safeParse({ scheduledAt: "2026-11-01T09:00:00Z", extra: 1 }).success, false);
  assert.deepEqual(communicationTestSendSchema.parse({}), { extraRecipients: [] });
  assert.equal(communicationTestSendSchema.safeParse({ extraRecipients: ["a@b.co", "c@d.co", "e@f.co", "g@h.co", "i@j.co", "k@l.co"] }).success, false);
  assert.equal(communicationTestSendSchema.safeParse({ extraRecipients: ["not-an-email"] }).success, false);
});

test("assets: the email logo is a PNG at the 2x width the layout shows at 170px", () => {
  const png = readFileSync(new URL("../public/email/datacentral-logo.png", import.meta.url));
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(png.readUInt32BE(16), 340, "IHDR width");
  assert.ok(png.readUInt32BE(20) > 20 && png.readUInt32BE(20) < 120, "IHDR height is a single-line wordmark");
});

test("idempotency: communication.* operations require a publish role", async () => {
  const request = new Request("https://pulse.test/api/v1/internal/communications/COM-001/send", {
    method: "POST", headers: { "idempotency-key": "communications-test-key" }, body: "{}",
  });
  await assert.rejects(executeIdempotent(request, CONTRIBUTOR, "communication.send:COM-001", 200, async () => ({})), /FORBIDDEN/);
});

test("versions: Communications is a versioned entity", async () => {
  await assert.rejects(checkedMutation(PM, "Communications", "COM-001", null, async () => ({})), /PRECONDITION_REQUIRED/);
});

/** Seeds the default users (bjarki@uidata.com, member of ORG-001), ORG-001 (Origo) and ORG-002 (Advania). */
async function seedOrganizations() {
  await listUsers(ADMIN); // seeds the default users only; the organisation store is seeded by organizations()
  organizations().push({ // first call seeds ORG-001 (Origo), then ORG-002 joins it
    id: "ORG-002", name: "Advania", type: "Customer", status: "Active", domain: "advania.is",
    users: 0, requests: 0, authentication: ["OTP"],
  });
}

test("contacts: Product managers add contacts to any company; e-mails are normalised; duplicates rejected", async () => {
  await seedOrganizations();
  const saved = await saveContact(PM, { organizationId: "ORG-002", email: "Anna@Advania.IS", displayName: "Anna", locale: "is", topics: ["product-updates"] });
  assert.equal(saved.email, "anna@advania.is");
  assert.equal(saved.source, "Admin");
  await assert.rejects(
    saveContact(PM, { organizationId: "ORG-002", email: "anna@advania.is", displayName: "Dup", locale: "en", topics: ["general"] }),
    /INVALID_CONTACT_EXISTS/,
  );
  assert.equal((await listContacts(CONTRIBUTOR, "ORG-002")).length, 1);
  await assert.rejects(saveContact(CONTRIBUTOR, { organizationId: "ORG-002", email: "x@advania.is", displayName: "X", locale: "en", topics: ["general"] }), /FORBIDDEN/);
  await assert.rejects(saveContact(PM, { organizationId: "ORG-404", email: "x@y.is", displayName: "X", locale: "en", topics: ["general"] }), /NOT_FOUND/);
});

test("contacts: Company admins manage only their own company; requesters cannot", async () => {
  await seedOrganizations();
  const mine = await saveCompanyContact(COMPANY_ADMIN, { email: "cio@origo.is", displayName: "CIO", locale: "en", topics: ["product-updates", "service-notices"] });
  assert.equal(mine.organizationId, "ORG-001");
  assert.equal(mine.source, "Company admin");
  const other = await saveContact(PM, { organizationId: "ORG-002", email: "other@advania.is", displayName: "Other", locale: "en", topics: ["general"] });
  await assert.rejects(saveCompanyContact(COMPANY_ADMIN, { id: other.id, email: "other@advania.is", displayName: "Hijack", locale: "en", topics: ["general"] }), /NOT_FOUND/);
  await assert.rejects(removeCompanyContact(COMPANY_ADMIN, other.id), /NOT_FOUND/);
  assert.deepEqual((await listCompanyContacts(COMPANY_ADMIN)).map((c) => c.email), ["cio@origo.is"]);
  await assert.rejects(listCompanyContacts(REQUESTER), /FORBIDDEN/);
  await removeCompanyContact(COMPANY_ADMIN, mine.id);
  assert.equal((await listCompanyContacts(COMPANY_ADMIN)).length, 0);
  assert.equal(globalThis.pulseMemoryAudit?.[0]?.action, "communication.contact.removed");
});

test("contacts: paste import parses 'Name, email' and 'email' lines, skips invalid and duplicate rows, caps at 250", () => {
  const parsed = parseContactLines("Anna Á, Anna@advania.is\nbjorn@advania.is\nnot an email\n Anna Á , anna@advania.is ");
  assert.deepEqual(parsed.rows, [
    { displayName: "Anna Á", email: "anna@advania.is" },
    { displayName: "bjorn", email: "bjorn@advania.is" },
  ]);
  assert.deepEqual(parsed.errors, [3, 4]);
  const many = parseContactLines(Array.from({ length: 300 }, (_, i) => `u${i}@x.is`).join("\n"));
  assert.equal(many.rows.length, 250);
});

test("contacts: import creates rows with the chosen topics and reports duplicates", async () => {
  await seedOrganizations();
  await saveContact(PM, { organizationId: "ORG-002", email: "anna@advania.is", displayName: "Anna", locale: "en", topics: ["general"] });
  const result = await importContacts(PM, "ORG-002", "Anna, anna@advania.is\nBjörn, bjorn@advania.is", ["product-updates"]);
  assert.equal(result.created.length, 1);
  assert.deepEqual(result.created[0].topics, ["product-updates"]);
  assert.equal(result.created[0].source, "Import");
  assert.deepEqual(result.skipped, [{ line: 1, reason: "duplicate" }]);
});

test("contacts: editing keeps one row, keeps who added it and audits the previous topics as 'before'", async () => {
  await seedOrganizations();
  const created = await saveCompanyContact(COMPANY_ADMIN, { email: "cio@origo.is", displayName: "CIO", locale: "en", topics: ["general"] });
  assert.equal(created.source, "Company admin");
  // A Product manager (whose own source would be "Admin") edits the Company admin's row.
  const edited = await saveContact(PM, { id: created.id, organizationId: "ORG-001", email: "cio@origo.is", displayName: "CIO Á", locale: "is", topics: ["product-updates", "product-updates", "service-notices"] });
  assert.equal(edited.id, created.id);
  assert.equal(edited.source, "Company admin", "the source stays with whoever added the contact, not the editor");
  assert.deepEqual(edited.topics, ["product-updates", "service-notices"], "duplicate topics collapse");
  assert.deepEqual((await listContacts(PM, "ORG-001")).map((c) => [c.displayName, c.locale]), [["CIO Á", "is"]]);
  const audit = globalThis.pulseMemoryAudit?.[0];
  assert.equal(audit?.action, "communication.contact.saved");
  assert.deepEqual(audit?.before, { topics: ["general"] });
  assert.deepEqual((audit?.after as { topics: string[] }).topics, ["product-updates", "service-notices"]);
  assert.ok(!JSON.stringify(globalThis.pulseMemoryAudit).includes("cio@origo.is"), "audit rows never carry e-mail addresses");
});

test("contacts: editing keeps the status and source a webhook set and the original creation time", async () => {
  await seedOrganizations();
  const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  memoryContacts().push({
    id, organizationId: "ORG-002", userId: null, email: "anna@advania.is", displayName: "Anna", locale: "en", topics: ["general"],
    status: "Unsubscribed", source: "Webhook", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const edited = await saveContact(PM, { id, organizationId: "ORG-002", email: "anna@advania.is", displayName: "Anna Á", locale: "is", topics: ["product-updates"] });
  assert.equal(edited.status, "Unsubscribed", "an edit never re-subscribes a contact");
  assert.equal(edited.source, "Webhook");
  assert.equal(edited.createdAt, "2026-01-01T00:00:00.000Z");
  assert.ok(edited.updatedAt > "2026-01-01T00:00:00.000Z", "updatedAt moves forward");
  assert.deepEqual((await listContacts(PM, "ORG-002")).map((c) => [c.displayName, c.status]), [["Anna Á", "Unsubscribed"]]);
});

test("contacts: a contact links to a Pulse user only when that user belongs to the contact's own company, and the link follows e-mail changes", async () => {
  await seedOrganizations();
  const jon = "22222222-2222-4222-8222-222222222222";
  const anna = "66666666-6666-4666-8666-666666666666";
  users().push(
    { id: jon, name: "Jón", email: "jon@origo.is", status: "Active", authentication: "OTP", memberships: [{ companyId: "ORG-001", role: "Requester" }] },
    { id: anna, name: "Anna", email: "anna@advania.is", status: "Active", authentication: "OTP", memberships: [{ companyId: "ORG-002", role: "Company admin" }] },
  );
  // Origo's Company admin lists a colleague who is an Origo member, and an address that belongs to a Pulse user of another company.
  const colleague = await saveCompanyContact(COMPANY_ADMIN, { email: "Jon@Origo.is", displayName: "Jón", locale: "is", topics: ["general"] });
  assert.equal(colleague.userId, jon, "a member of the same company is linked");
  const foreign = await saveCompanyContact(COMPANY_ADMIN, { email: "anna@advania.is", displayName: "Anna", locale: "en", topics: ["general"] });
  assert.equal(foreign.userId, null, "a Pulse user of another company is neither linked nor revealed");
  // The same address inside that user's own company is linked.
  const own = await saveContact(PM, { organizationId: "ORG-002", email: "anna@advania.is", displayName: "Anna", locale: "en", topics: ["general"] });
  assert.equal(own.userId, anna);
  // Editing the address moves the link with it.
  const moved = await saveCompanyContact(COMPANY_ADMIN, { id: colleague.id, email: "jon.new@origo.is", displayName: "Jón", locale: "is", topics: ["general"] });
  assert.equal(moved.userId, null, "no member has the new address");
  const back = await saveCompanyContact(COMPANY_ADMIN, { id: colleague.id, email: "jon@origo.is", displayName: "Jón", locale: "is", topics: ["general"] });
  assert.equal(back.userId, jon);
  assert.deepEqual((await listCompanyContacts(COMPANY_ADMIN)).map((c) => [c.email, c.userId]), [["jon@origo.is", jon], ["anna@advania.is", null]]);
});

test("contacts: input is validated and Company admins cannot name another organisation", async () => {
  await seedOrganizations();
  const valid = { organizationId: "ORG-002", email: "x@advania.is", displayName: "X", locale: "en" as const, topics: ["general" as const] };
  await assert.rejects(saveContact(PM, { ...valid, email: "not-an-email" }), /INVALID_INPUT/);
  await assert.rejects(saveContact(PM, { ...valid, displayName: "" }), /INVALID_INPUT/);
  await assert.rejects(saveContact(PM, { ...valid, topics: [] }), /INVALID_INPUT/);
  await assert.rejects(saveCompanyContact(COMPANY_ADMIN, { ...valid, email: "not-an-email" }), /INVALID_INPUT/);
  const tampered = { ...valid, email: "cio@origo.is" }; // a body that still carries organizationId: ORG-002
  const saved = await saveCompanyContact(COMPANY_ADMIN, tampered);
  assert.equal(saved.organizationId, "ORG-001", "the active membership wins over any organizationId in the body");
  assert.equal((await listContacts(PM, "ORG-002")).length, 0);
});

test("contacts: a malformed contact id is NOT_FOUND on edit and removal and never reaches the store", async () => {
  await seedOrganizations();
  const valid = { organizationId: "ORG-001", email: "cio@origo.is", displayName: "CIO", locale: "en" as const, topics: ["general" as const] };
  // A row stored under a malformed id (impossible in production) shows the id is refused before any lookup; SQL would otherwise fail in the driver.
  memoryContacts().push({
    id: "not-a-uuid", organizationId: "ORG-001", userId: null, email: "cio@origo.is", displayName: "CIO", locale: "en", topics: ["general"],
    status: "Active", source: "Admin", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await assert.rejects(saveContact(PM, { ...valid, id: "not-a-uuid" }), /NOT_FOUND/);
  await assert.rejects(saveCompanyContact(COMPANY_ADMIN, { ...valid, id: "not-a-uuid" }), /NOT_FOUND/);
  await assert.rejects(removeContact(PM, "not-a-uuid"), /NOT_FOUND/);
  await assert.rejects(removeCompanyContact(COMPANY_ADMIN, "not-a-uuid"), /NOT_FOUND/);
  await assert.rejects(removeContact(PM, ""), /NOT_FOUND/);
  assert.deepEqual(memoryContacts().map((c) => [c.id, c.displayName]), [["not-a-uuid", "CIO"]], "the row was neither edited nor removed");
  await assert.rejects(removeContact(CONTRIBUTOR, "not-a-uuid"), /FORBIDDEN/, "authorisation still comes first");
});

test("contacts: removal needs a publish role; Company admin import is scoped to the active organisation", async () => {
  await seedOrganizations();
  const contact = await saveContact(PM, { organizationId: "ORG-002", email: "anna@advania.is", displayName: "Anna", locale: "en", topics: ["general"] });
  await assert.rejects(removeContact(CONTRIBUTOR, contact.id), /FORBIDDEN/);
  await assert.rejects(removeContact(COMPANY_ADMIN, contact.id), /FORBIDDEN/);
  await removeContact(PM, contact.id);
  assert.equal((await listContacts(CONTRIBUTOR, "ORG-002")).length, 0);
  assert.equal(globalThis.pulseMemoryAudit?.[0]?.action, "communication.contact.removed");
  await assert.rejects(removeContact(PM, contact.id), /NOT_FOUND/);

  await assert.rejects(importCompanyContacts(REQUESTER, "asa@origo.is", ["general"]), /FORBIDDEN/);
  await assert.rejects(importCompanyContacts(PM, "asa@origo.is", ["general"]), /FORBIDDEN/);
  const imported = await importCompanyContacts(COMPANY_ADMIN, "Ása, asa@origo.is\ngunnar@origo.is", ["service-notices"]);
  assert.deepEqual(imported.created.map((c) => [c.organizationId, c.source, c.topics]), [
    ["ORG-001", "Company admin", ["service-notices"]],
    ["ORG-001", "Company admin", ["service-notices"]],
  ]);
  assert.deepEqual(imported.skipped, []);
  assert.deepEqual((await listCompanyContacts(COMPANY_ADMIN)).map((c) => c.email), ["asa@origo.is", "gunnar@origo.is"]);
});

test("contacts: paste parsing applies the contact schema's address rules and records the physical line of every accepted row", () => {
  const parsed = parseContactLines("\nCarl, carl@advania.c\nDóra; dora@advania.is\n\tEyja\teyja@advania.is\n.dot@advania.is\nGunnar, gunnar@advania.is.");
  assert.deepEqual(parsed.rows.map((r) => r.email), ["dora@advania.is", "eyja@advania.is"]);
  assert.deepEqual(parsed.rowLines, [3, 4]);
  assert.deepEqual(parsed.errors, [2, 5, 6]);
});

test("contacts: import reports physical line numbers and skips addresses the contact schema rejects without aborting", async () => {
  await seedOrganizations();
  await saveContact(PM, { organizationId: "ORG-002", email: "anna@advania.is", displayName: "Anna", locale: "en", topics: ["general"] });
  const result = await importContacts(PM, "ORG-002", "\nnot an email\nAnna, anna@advania.is\nCarl, carl@advania.c\nDóra, dora@advania.is", ["general"]);
  assert.deepEqual(result.created.map((c) => c.email), ["dora@advania.is"]);
  assert.deepEqual(result.skipped, [
    { line: 2, reason: "invalid" },
    { line: 3, reason: "duplicate" },
    { line: 4, reason: "invalid" },
  ]);
  assert.equal((await listContacts(PM, "ORG-002")).length, 2, "the existing contact and the one new row");
});

test("suppressions: System admin manages manually; others read only; contacts are flagged", async () => {
  await seedOrganizations();
  const contact = await saveContact(PM, { organizationId: "ORG-002", email: "anna@advania.is", displayName: "Anna", locale: "en", topics: ["general"] });
  await assert.rejects(addSuppression(PM, { email: "anna@advania.is" }), /FORBIDDEN/);
  const added = await addSuppression(ADMIN, { email: "Anna@Advania.is", note: "asked by phone" });
  assert.equal(added.email, "anna@advania.is");
  assert.equal(added.reason, "Manual");
  assert.equal((await listSuppressions(CONTRIBUTOR)).length, 1);
  assert.equal((await listContacts(PM, "ORG-002")).find((c) => c.id === contact.id)?.status, "Unsubscribed");
  await removeSuppression(ADMIN, "anna@advania.is");
  assert.equal((await loadSuppressionMap()).size, 0);
});

test("suppressions: webhook path upserts by reason and release only removes a matching reason", async () => {
  await suppressAddress("bounce@origo.is", "Bounced", "Webhook", "550 user unknown");
  await suppressAddress("bounce@origo.is", "Unsubscribed", "Webhook");
  assert.equal((await loadSuppressionMap()).get("bounce@origo.is"), "Unsubscribed");
  await releaseAddress("bounce@origo.is", "Bounced"); // reason mismatch → stays
  assert.equal((await loadSuppressionMap()).get("bounce@origo.is"), "Unsubscribed");
  await releaseAddress("bounce@origo.is", "Unsubscribed");
  assert.equal((await loadSuppressionMap()).has("bounce@origo.is"), false);
});

test("suppressions: only a System admin writes, every internal role reads, customers do not, and bad input or an unknown address is refused", async () => {
  await assert.rejects(addSuppression(PM, { email: "a@origo.is" }), /FORBIDDEN/);
  await assert.rejects(addSuppression(CONTRIBUTOR, { email: "a@origo.is" }), /FORBIDDEN/);
  await assert.rejects(addSuppression(COMPANY_ADMIN, { email: "a@origo.is" }), /FORBIDDEN/);
  await assert.rejects(addSuppression(ADMIN, { email: "not-an-email" }), /INVALID_INPUT/);
  await assert.rejects(addSuppression(ADMIN, { email: "a@origo.is", note: "x".repeat(501) }), /INVALID_INPUT/);
  await assert.rejects(addSuppression(ADMIN, { email: "a@origo.is", reason: "Bounced" } as never), /INVALID_INPUT/, "the schema is strict");
  assert.equal((await loadSuppressionMap()).size, 0, "refused calls store nothing");
  await addSuppression(ADMIN, { email: "a@origo.is" });
  await assert.rejects(removeSuppression(PM, "a@origo.is"), /FORBIDDEN/);
  await assert.rejects(removeSuppression(CONTRIBUTOR, "a@origo.is"), /FORBIDDEN/);
  await assert.rejects(removeSuppression(COMPANY_ADMIN, "a@origo.is"), /FORBIDDEN/);
  await assert.rejects(removeSuppression(ADMIN, "nobody@origo.is"), /NOT_FOUND/);
  for (const reader of [ADMIN, PM, CONTRIBUTOR]) assert.equal((await listSuppressions(reader)).length, 1);
  await assert.rejects(listSuppressions(COMPANY_ADMIN), /FORBIDDEN/);
  await assert.rejects(listSuppressions(REQUESTER), /FORBIDDEN/);
  assert.deepEqual([...(await loadSuppressionMap()).keys()], ["a@origo.is"], "refused removals changed nothing");
});

test("suppressions: contacts follow the list in every organisation; Bounced flags Bounced, any other reason Unsubscribed; a matching release or a removal re-activates", async () => {
  await seedOrganizations();
  const contact = (organizationId: string, email: string) => ({ organizationId, email, displayName: "X", locale: "en" as const, topics: ["general" as const] });
  await saveContact(PM, contact("ORG-002", "shared@advania.is"));
  await saveContact(PM, contact("ORG-001", "shared@advania.is"));
  await saveContact(PM, contact("ORG-002", "other@advania.is"));
  const statuses = async () => Object.fromEntries((await listContacts(PM)).map((c) => [`${c.organizationId} ${c.email}`, c.status]));
  const shared = (status: string) => ({ "ORG-002 shared@advania.is": status, "ORG-001 shared@advania.is": status, "ORG-002 other@advania.is": "Active" });
  await suppressAddress("  Shared@Advania.IS ", "Bounced", "Webhook");
  assert.deepEqual(await statuses(), shared("Bounced"), "a bounce flags the address in every organisation and no other address");
  await suppressAddress("shared@advania.is", "SpamReport", "Webhook");
  assert.deepEqual(await statuses(), shared("Unsubscribed"), "any other reason reads as unsubscribed");
  await releaseAddress("shared@advania.is", "Bounced");
  assert.deepEqual(await statuses(), shared("Unsubscribed"), "a release for another reason leaves the contacts alone");
  await releaseAddress("SHARED@advania.is", "SpamReport");
  assert.deepEqual(await statuses(), shared("Active"), "a matching release re-activates, whatever the case of the address");
  await addSuppression(ADMIN, { email: "shared@advania.is" });
  assert.deepEqual(await statuses(), shared("Unsubscribed"));
  await removeSuppression(ADMIN, "shared@advania.is");
  assert.deepEqual(await statuses(), shared("Active"), "removing the suppression re-activates");
});

test("suppressions: removing an address that is not on the list changes nothing and is not audited", async () => {
  await seedOrganizations();
  const contact = await saveContact(PM, { organizationId: "ORG-002", email: "anna@advania.is", displayName: "Anna", locale: "en", topics: ["general"] });
  memoryContacts().find((c) => c.id === contact.id)!.status = "Unsubscribed"; // flagged by something other than the list
  const audited = globalThis.pulseMemoryAudit?.length;
  await assert.rejects(removeSuppression(ADMIN, "anna@advania.is"), /NOT_FOUND/);
  assert.equal((await listContacts(PM, "ORG-002"))[0].status, "Unsubscribed");
  assert.equal(globalThis.pulseMemoryAudit?.length, audited);
});

test("suppressions: flagging and re-activating a contact move its updatedAt, as the SQL statements do, and a release that matches nothing does not", async () => {
  await seedOrganizations();
  const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const old = "2026-01-01T00:00:00.000Z";
  memoryContacts().push({
    id, organizationId: "ORG-002", userId: null, email: "anna@advania.is", displayName: "Anna", locale: "en", topics: ["general"],
    status: "Active", source: "Admin", createdAt: old, updatedAt: old,
  });
  const row = () => memoryContacts().find((c) => c.id === id)!;
  await suppressAddress("anna@advania.is", "Unsubscribed", "Webhook");
  assert.equal(row().status, "Unsubscribed");
  assert.ok(row().updatedAt > old, "flagging moves updatedAt");
  row().updatedAt = old;
  await releaseAddress("anna@advania.is", "Bounced");
  assert.equal(row().status, "Unsubscribed");
  assert.equal(row().updatedAt, old, "a release for another reason touches nothing");
  await releaseAddress("anna@advania.is", "Unsubscribed");
  assert.equal(row().status, "Active");
  assert.ok(row().updatedAt > old, "re-activating moves updatedAt");
  await addSuppression(ADMIN, { email: "anna@advania.is" });
  row().updatedAt = old;
  await removeSuppression(ADMIN, "anna@advania.is");
  assert.equal(row().status, "Active");
  assert.ok(row().updatedAt > old, "removing a suppression moves updatedAt");
});

test("suppressions: audit rows record the action and the reason but never the address or the note, and the webhook path writes none", async () => {
  await addSuppression(ADMIN, { email: "anna@advania.is", note: "asked by phone" });
  await removeSuppression(ADMIN, "anna@advania.is");
  const [removed, added] = globalThis.pulseMemoryAudit ?? [];
  assert.equal(added?.action, "communication.suppression.added");
  assert.equal(added?.entityType, "CommunicationSuppression");
  assert.deepEqual(added?.after, { reason: "Manual" });
  assert.equal(removed?.action, "communication.suppression.removed");
  assert.equal(removed?.entityType, "CommunicationSuppression");
  assert.deepEqual(removed?.after, {});
  const trail = JSON.stringify(globalThis.pulseMemoryAudit);
  assert.ok(!trail.includes("anna@advania.is") && !trail.includes("asked by phone"), "audit rows never carry the address or the note");
  await suppressAddress("bounce@origo.is", "Bounced", "Webhook", "550 user unknown");
  await releaseAddress("bounce@origo.is", "Bounced");
  assert.equal(globalThis.pulseMemoryAudit?.length, 2, "the webhook and worker path has no actor and writes no audit row");
});

test("suppressions: the list is newest first and an update keeps the row's place and creation time", async () => {
  await suppressAddress("first@origo.is", "Bounced", "Webhook", "550 user unknown");
  await suppressAddress("second@origo.is", "SpamReport", "Webhook");
  await addSuppression(ADMIN, { email: "third@origo.is" });
  const listed = await listSuppressions(ADMIN);
  assert.deepEqual(listed.map((s) => s.email), ["third@origo.is", "second@origo.is", "first@origo.is"], "newest first, like ORDER BY created_at DESC in SQL");
  assert.deepEqual(listed.map((s) => [s.reason, s.source]), [["Manual", "Admin"], ["SpamReport", "Webhook"], ["Bounced", "Webhook"]]);
  assert.equal(listed[2].note, "550 user unknown");
  await suppressAddress("first@origo.is", "Unsubscribed", "Webhook");
  const again = await listSuppressions(ADMIN);
  assert.deepEqual(again.map((s) => s.email), ["third@origo.is", "second@origo.is", "first@origo.is"], "an update does not move the row");
  assert.equal(again[2].createdAt, listed[2].createdAt, "an update keeps the creation time");
  assert.equal(again[2].reason, "Unsubscribed");
  assert.equal(again[2].note, undefined, "the newest event replaces the note along with the reason");
});

test("suppressions: addresses are normalised and a note fits its column: cut at 500 characters, blank means none", async () => {
  await suppressAddress("  Mixed@Case.IS ", "Bounced", "Webhook", "x".repeat(600));
  await suppressAddress("blank@case.is", "Bounced", "Webhook", "");
  const manual = await addSuppression(ADMIN, { email: "Manual@Case.is", note: "   " });
  assert.equal(manual.email, "manual@case.is");
  assert.equal(manual.note, undefined, "a blank note is no note");
  const byEmail = Object.fromEntries((await listSuppressions(ADMIN)).map((s) => [s.email, s]));
  assert.deepEqual(Object.keys(byEmail).sort(), ["blank@case.is", "manual@case.is", "mixed@case.is"]);
  assert.equal(byEmail["mixed@case.is"].note?.length, 500, "the table column holds 500 characters");
  assert.equal(byEmail["blank@case.is"].note, undefined);
  assert.equal(byEmail["manual@case.is"].note, undefined);
  await releaseAddress(" MIXED@case.is", "Bounced");
  assert.equal((await loadSuppressionMap()).has("mixed@case.is"), false, "a release matches whatever the case or padding of the address");
});

const orgs: AudienceInput["organizations"] = [
  { id: "ORG-001", name: "Origo", type: "Customer", status: "Active", isTest: false, locale: "is" },
  { id: "ORG-002", name: "Advania", type: "Customer", status: "Onboarding", isTest: false, locale: "en" },
  { id: "ORG-003", name: "Test Co", type: "Customer", status: "Active", isTest: true, locale: "en" },
  { id: "ORG-INTERNAL", name: "DataCentral", type: "Internal", status: "Active", isTest: false, locale: "en" },
];
const member = (userId: string, organizationId: string, email: string, extra: Partial<AudienceInput["members"][number]> = {}) => ({
  userId, organizationId, email, displayName: email.split("@")[0], locale: "en" as const, role: "Requester", preference: null, ...extra,
});
const contact = (id: string, organizationId: string, email: string, topics: CommunicationTopic[] = ["product-updates"], extra: Partial<AudienceInput["contacts"][number]> = {}) => ({
  id, organizationId, userId: null, email, displayName: email, locale: "en" as const, topics, status: "Active" as const,
  source: "Admin" as const, createdAt: "", updatedAt: "", ...extra,
});
const openSettings = { safeMode: { enabled: false, allowedDomains: [] }, maxRecipientsPerCampaign: 5000 };
const spec = { organizations: "all-customers" as const, includeOnboarding: false, includeTestOrganizations: false, includeMembers: true, memberRoles: null, includeContacts: true, includeInternalCopy: false };

test("audience: dedupes member and contact rows case-insensitively; member wins and keeps the user locale", () => {
  const input: AudienceInput = {
    organizations: orgs,
    members: [member("u1", "ORG-001", "Jon@Origo.is", { locale: "is" })],
    contacts: [contact("c1", "ORG-001", "jon@origo.is"), contact("c2", "ORG-001", "cio@origo.is")],
    suppressions: new Map(),
  };
  const { recipients, breakdown } = resolveAudience(spec, "product-updates", input, openSettings);
  assert.deepEqual(recipients.map((r) => [r.email, r.source, r.locale]), [["jon@origo.is", "Member", "is"], ["cio@origo.is", "Contact", "en"]]);
  assert.equal(breakdown.sendable, 2);
  assert.equal(breakdown.members, 1);
  assert.equal(breakdown.contacts, 1);
});

test("audience: organisation filters (selected ids, onboarding, test orgs) and role filter", () => {
  const input: AudienceInput = {
    organizations: orgs,
    members: [member("u1", "ORG-001", "a@origo.is", { role: "Company admin" }), member("u2", "ORG-001", "b@origo.is"), member("u3", "ORG-002", "c@advania.is"), member("u4", "ORG-003", "t@test.is")],
    contacts: [], suppressions: new Map(),
  };
  assert.equal(resolveAudience(spec, "product-updates", input, openSettings).breakdown.sendable, 2, "Onboarding and test orgs excluded by default");
  assert.equal(resolveAudience({ ...spec, includeOnboarding: true, includeTestOrganizations: true }, "product-updates", input, openSettings).breakdown.sendable, 4);
  assert.equal(resolveAudience({ ...spec, organizations: ["ORG-002"], includeOnboarding: true }, "product-updates", input, openSettings).breakdown.sendable, 1);
  assert.deepEqual(resolveAudience({ ...spec, memberRoles: ["Company admin"] }, "product-updates", input, openSettings).recipients.map((r) => r.email), ["a@origo.is"]);
});

test("audience: preference Off is honoured except for mandatory topics; contacts need the topic", () => {
  const input: AudienceInput = {
    organizations: orgs,
    members: [member("u1", "ORG-001", "off@origo.is", { preference: "Off" }), member("u2", "ORG-001", "on@origo.is", { preference: "Immediate" })],
    contacts: [contact("c1", "ORG-001", "news@origo.is", ["general"])],
    suppressions: new Map(),
  };
  const product = resolveAudience(spec, "product-updates", input, openSettings);
  assert.deepEqual(product.recipients.filter((r) => r.state === "Queued").map((r) => r.email), ["on@origo.is"]);
  assert.equal(product.breakdown.suppressed.PreferenceOff, 1);
  const security = resolveAudience(spec, "security-advisories", input, openSettings);
  assert.equal(security.recipients.filter((r) => r.state === "Queued").length, 2, "mandatory topic ignores Off");
});

test("audience: suppressed members are kept as Suppressed rows; safe mode matches the whole domain", () => {
  const input: AudienceInput = {
    organizations: orgs,
    members: [member("u1", "ORG-001", "bounced@origo.is"), member("u2", "ORG-001", "ok@datacentral.ai"), member("u3", "ORG-001", "x@evil-datacentral.ai"), member("u4", "ORG-001", "y@datacentral.ai.attacker.com")],
    contacts: [], suppressions: new Map([["bounced@origo.is", "Bounced"]]),
  };
  const result = resolveAudience(spec, "product-updates", input, { safeMode: { enabled: true, allowedDomains: ["datacentral.ai"] }, maxRecipientsPerCampaign: 5000 });
  const byEmail = Object.fromEntries(result.recipients.map((r) => [r.email, `${r.state}:${r.suppressedReason ?? ""}`]));
  assert.equal(byEmail["bounced@origo.is"], "Suppressed:Bounced");
  assert.equal(byEmail["ok@datacentral.ai"], "Queued:");
  assert.equal(byEmail["x@evil-datacentral.ai"], "Suppressed:SafeMode");
  assert.equal(byEmail["y@datacentral.ai.attacker.com"], "Suppressed:SafeMode");
  assert.equal(result.breakdown.sendable, 1);
});

test("audience: size limit and internal copy", () => {
  const members = Array.from({ length: 6 }, (_, i) => member(`u${i}`, "ORG-001", `u${i}@origo.is`));
  const input: AudienceInput = { organizations: orgs, members: [...members, member("staff", "ORG-INTERNAL", "staff@datacentral.ai")], contacts: [], suppressions: new Map() };
  assert.throws(() => resolveAudience(spec, "general", input, { ...openSettings, maxRecipientsPerCampaign: 5 }), /INVALID_AUDIENCE_TOO_LARGE/);
  const withInternal = resolveAudience({ ...spec, includeInternalCopy: true }, "general", input, openSettings);
  assert.equal(withInternal.breakdown.internal, 1);
  assert.equal(withInternal.breakdown.sendable, 7);
});

test("audience: the member and contact switches work, only Active contacts count and the internal copy takes staff only", () => {
  const input: AudienceInput = {
    organizations: orgs,
    members: [member("u1", "ORG-001", "m@origo.is"), member("u2", "ORG-002", "onboarding@advania.is"), member("staff", "ORG-INTERNAL", "staff@datacentral.ai")],
    contacts: [
      contact("c1", "ORG-001", "c@origo.is"),
      contact("c2", "ORG-001", "gone@origo.is", ["product-updates"], { status: "Unsubscribed" }),
      contact("c3", "ORG-001", "bounced@origo.is", ["product-updates"], { status: "Bounced" }),
    ],
    suppressions: new Map(),
  };
  const emails = (audience: AudienceSpec) => resolveAudience(audience, "product-updates", input, openSettings).recipients.map((r) => r.email);
  assert.deepEqual(emails(spec), ["m@origo.is", "c@origo.is"], "Unsubscribed and Bounced contacts are left out");
  assert.deepEqual(emails({ ...spec, includeMembers: false }), ["c@origo.is"]);
  assert.deepEqual(emails({ ...spec, includeContacts: false }), ["m@origo.is"]);
  assert.deepEqual(emails({ ...spec, includeInternalCopy: true }), ["m@origo.is", "c@origo.is", "staff@datacentral.ai"], "a member of an excluded company is not a staff copy");
  assert.deepEqual(emails({ ...spec, includeMembers: false, includeContacts: false, includeInternalCopy: true }), ["staff@datacentral.ai"]);
});

test("audience: the size limit allows exactly the limit and counts sendable rows only; every address is counted once; a suppression beats a mandatory topic", () => {
  const input: AudienceInput = {
    organizations: orgs,
    members: [
      ...Array.from({ length: 5 }, (_, i) => member(`u${i}`, "ORG-001", `u${i}@origo.is`)),
      member("off", "ORG-001", "off@origo.is", { preference: "Off" }),
      member("bounced", "ORG-001", "bounced@origo.is"),
      member("both", "ORG-001", "both@origo.is", { preference: "Off" }),
    ],
    contacts: [], suppressions: new Map([["bounced@origo.is", "Bounced"], ["both@origo.is", "Unsubscribed"]]),
  };
  const atLimit = resolveAudience(spec, "product-updates", input, { ...openSettings, maxRecipientsPerCampaign: 5 });
  assert.equal(atLimit.breakdown.sendable, 5, "three suppressed rows do not count against the limit");
  assert.throws(() => resolveAudience(spec, "product-updates", input, { ...openSettings, maxRecipientsPerCampaign: 4 }), /INVALID_AUDIENCE_TOO_LARGE/);
  assert.equal(atLimit.breakdown.total, 8);
  assert.deepEqual(atLimit.breakdown.suppressed, { PreferenceOff: 2, Bounced: 1 }, "an address that is Off and listed is reported once, as PreferenceOff");
  const security = resolveAudience(spec, "security-advisories", input, openSettings);
  assert.equal(security.breakdown.sendable, 6, "a mandatory topic ignores Off");
  assert.deepEqual(security.breakdown.suppressed, { Bounced: 1, Unsubscribed: 1 }, "but never the suppression list");
});

test("topics: every communication topic maps to a registered notification event type with the same mandatory flag", async () => {
  // Compile-time half: a topic whose event type is no NotificationEventType stops `tsc`, not only this test.
  const eventTypes: readonly NotificationEventType[] = COMMUNICATION_TOPICS.map(topicEventType);
  const preferences = await listNotificationPreferences(REQUESTER);
  for (const topic of COMMUNICATION_TOPICS) {
    const eventType = topicEventType(topic);
    assert.ok((notificationEventTypes as readonly string[]).includes(eventType), `${topic} has no notification event type`);
    assert.equal(
      preferences.find((p) => p.eventType === eventType)?.mandatory, MANDATORY_TOPICS.has(topic),
      `${topic}: topics.ts and the preference repository disagree on the mandatory flag`,
    );
  }
  assert.deepEqual(
    notificationEventTypes.filter((type) => type.startsWith("communication.")).sort(), [...eventTypes].sort(),
    "every communication.* notification event type belongs to a topic",
  );
});

test("audience: the memory loader lists active members with their topic preference and locale, plus contacts and suppressions", async () => {
  await seedOrganizations(); // ORG-001 Origo, ORG-002 Advania and the seeded admin (bjarki@uidata.com, a Company admin of ORG-001)
  organizations().push({ id: "ORG-009", name: "Closed", type: "Customer", status: "Inactive", domain: "closed.is", users: 0, requests: 0, authentication: ["OTP"] });
  users().push(
    { id: REQUESTER.id, name: "Jón Jónsson", email: "jon@origo.is", status: "Active", authentication: "OTP", memberships: [{ companyId: "ORG-001", role: "Requester" }, { companyId: "ORG-002", role: "Viewer" }] },
    { id: "66666666-6666-4666-8666-666666666666", name: "Sigga", email: "sigga@origo.is", status: "Suspended", authentication: "OTP", memberships: [{ companyId: "ORG-001", role: "Requester" }] },
  );
  await setUserLocaleById(REQUESTER.id, "is");
  await saveNotificationPreference(REQUESTER, "communication.product-updates", "Off"); // saved for REQUESTER's company, ORG-001
  await saveContact(PM, { organizationId: "ORG-002", email: "anna@advania.is", displayName: "Anna", locale: "is", topics: ["product-updates"] });
  await suppressAddress("bounced@origo.is", "Bounced", "Webhook");

  const input = await loadAudienceInput("product-updates");
  assert.deepEqual(input.organizations.map((o) => o.id), ["ORG-001", "ORG-002"], "inactive organisations are not loaded");
  assert.deepEqual(
    input.members.map((m) => [m.email, m.organizationId, m.role, m.locale, m.preference]),
    [["bjarki@uidata.com", "ORG-001", "Company admin", "en", null], ["jon@origo.is", "ORG-001", "Requester", "is", "Off"], ["jon@origo.is", "ORG-002", "Viewer", "is", null]],
    "one row per membership of an active user; the preference is the one saved for that company and topic",
  );
  assert.deepEqual(input.contacts.map((c) => [c.email, c.organizationId]), [["anna@advania.is", "ORG-002"]]);
  assert.equal(input.suppressions.get("bounced@origo.is"), "Bounced");
  const security = await loadAudienceInput("security-advisories");
  assert.equal(security.members.find((m) => m.userId === REQUESTER.id && m.organizationId === "ORG-001")?.preference, null, "a preference belongs to one topic");
  input.contacts[0].displayName = "Changed";
  assert.equal(memoryContacts()[0].displayName, "Anna", "the loader hands out copies, never the store");
});

test("audience: the SQL loader sends its queries one at a time, as a transaction requires, and maps the rows", async () => {
  const rows: Array<[RegExp, Array<Record<string, unknown>>]> = [
    [/FROM dbo\.CommunicationSuppressions/, [{ email: "bounced@origo.is", reason: "Bounced" }]],
    [/FROM dbo\.Organizations/, [
      { id: "ORG-001", name: "Origo", type: "Customer", status: "Active", isTest: false, locale: "is" },
      { id: "ORG-003", name: "Test Co", type: "Customer", status: "Onboarding", isTest: true, locale: "fr" },
    ]],
    [/FROM dbo\.Memberships/, [
      { userId: "AAAAAAAA-0000-4000-8000-000000000001", organizationId: "ORG-001", email: "jon@origo.is", displayName: "Jón", locale: "is", role: "Requester", preference: "Off" },
      { userId: "AAAAAAAA-0000-4000-8000-000000000002", organizationId: "ORG-001", email: "ann@origo.is", displayName: "Ann", locale: "de", role: "Viewer", preference: null },
    ]],
    [/FROM dbo\.CommunicationContacts/, [
      { id: "CCCCCCCC-0000-4000-8000-000000000001", organizationId: "ORG-001", userId: null, email: "cio@origo.is", displayName: "CIO", locale: "is", topicsJson: '["product-updates","general"]', status: "Active", source: "Admin" },
    ]],
  ];
  const calls: Array<{ text: string; inputs: Record<string, unknown> }> = [];
  let running = false;
  // Stands in for the pool. Like a transaction (atomicSql), it refuses a request while another is in flight (mssql: EREQINPROG).
  const pool = {
    request() {
      const inputs: Record<string, unknown> = {};
      const request = {
        input(name: string, _type: unknown, value: unknown) { inputs[name] = value; return request; },
        async query(text: string) {
          if (running) throw new Error("EREQINPROG: Can't acquire connection for the request. There is another request in progress.");
          running = true;
          try {
            await new Promise((resolve) => setImmediate(resolve));
            calls.push({ text, inputs });
            return { recordset: rows.find(([pattern]) => pattern.test(text))?.[1] ?? [] };
          } finally {
            running = false;
          }
        },
      };
      return request;
    },
  };
  process.env.AZURE_SQL_SERVER = "fake-sql-server";
  globalThis.pulseSqlPool = Promise.resolve(pool as unknown as import("mssql").ConnectionPool);
  try {
    const input = await loadAudienceInput("product-updates");
    assert.deepEqual(input.organizations, [
      { id: "ORG-001", name: "Origo", type: "Customer", status: "Active", isTest: false, locale: "is" },
      { id: "ORG-003", name: "Test Co", type: "Customer", status: "Onboarding", isTest: true, locale: "en" },
    ]);
    assert.deepEqual(input.members, [
      { userId: "AAAAAAAA-0000-4000-8000-000000000001", organizationId: "ORG-001", email: "jon@origo.is", displayName: "Jón", locale: "is", role: "Requester", preference: "Off" },
      { userId: "AAAAAAAA-0000-4000-8000-000000000002", organizationId: "ORG-001", email: "ann@origo.is", displayName: "Ann", locale: "en", role: "Viewer", preference: null },
    ]);
    assert.deepEqual(input.contacts, [
      { id: "CCCCCCCC-0000-4000-8000-000000000001", organizationId: "ORG-001", userId: null, email: "cio@origo.is", displayName: "CIO", locale: "is", topics: ["product-updates", "general"], status: "Active", source: "Admin", createdAt: "", updatedAt: "" },
    ]);
    assert.deepEqual([...input.suppressions], [["bounced@origo.is", "Bounced"]]);
    assert.equal(calls.find((c) => /NotificationPreferences/.test(c.text))?.inputs.eventType, "communication.product-updates", "the preference join is bound to the topic's event type");
  } finally {
    delete process.env.AZURE_SQL_SERVER;
    globalThis.pulseSqlPool = undefined;
  }
});
