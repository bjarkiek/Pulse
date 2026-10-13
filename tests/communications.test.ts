import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PulseIdentity } from "../lib/domain";
import { memoryCommunications, memoryContacts, memoryDeliveries, resetCommunicationMemory } from "../lib/server/communications/memory";
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
import type { AudienceSpec, CommunicationTopic, DeliveryRecord } from "../lib/server/communications/types";
import {
  createCommunication, deleteCommunication, duplicateCommunication, findCommunicationUuid, getCommunication, listCommunications,
  prefillFromRelease, previewCommunication, updateCommunication,
} from "../lib/server/communications/campaign-repository";
import { sql } from "../lib/server/database";
import { createRelease, publishRelease } from "../lib/server/operations-repository";
import { createIdea, listInternalIdeas } from "../lib/server/product-repository";
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

test("audience: a member who is Off in any selected organisation is suppressed whichever of their rows comes first; a mandatory topic ignores Off", () => {
  const offAt = (organizationId: string, extra: Partial<AudienceInput["members"][number]> = {}) => member("u1", organizationId, "Multi@Origo.is", { preference: "Off", ...extra }); // the other row says multi@origo.is
  const onAt = (organizationId: string, extra: Partial<AudienceInput["members"][number]> = {}) => member("u1", organizationId, "multi@origo.is", extra);
  const bothOrders = (off: AudienceInput["members"][number], on: AudienceInput["members"][number]): Array<[string, AudienceInput["members"]]> =>
    [["Off row first", [off, on]], ["Off row last", [on, off]]];
  const run = (audience: AudienceSpec, topic: CommunicationTopic, members: AudienceInput["members"]) =>
    resolveAudience(audience, topic, { organizations: orgs, members, contacts: [], suppressions: new Map() }, openSettings);
  const states = (result: ReturnType<typeof run>) => result.recipients.map((r) => `${r.state}:${r.suppressedReason ?? ""}`);
  const bothSelected = { ...spec, includeOnboarding: true }; // ORG-001 and ORG-002

  for (const [order, members] of bothOrders(offAt("ORG-001"), onAt("ORG-002"))) {
    const product = run(bothSelected, "product-updates", members);
    assert.deepEqual(states(product), ["Suppressed:PreferenceOff"], order);
    assert.equal(product.breakdown.members, 1, `${order}: one address, however many memberships`);
    assert.deepEqual(product.breakdown.suppressed, { PreferenceOff: 1 }, `${order}: reported once`);
    assert.deepEqual(states(run(bothSelected, "security-advisories", members)), ["Queued:"], `${order}: a mandatory topic ignores Off`);
  }
  // ORG-002 is Onboarding, so the default audience does not select it: an Off there is not an Off in this audience.
  for (const [order, members] of bothOrders(offAt("ORG-002"), onAt("ORG-001")))
    assert.deepEqual(states(run(spec, "product-updates", members)), ["Queued:"], `${order}: an Off outside the audience does not count`);
  // The Viewer row is Off but this audience takes Company admins only; the address is still Off in a selected organisation.
  for (const [order, members] of bothOrders(offAt("ORG-001", { role: "Viewer" }), onAt("ORG-002", { role: "Company admin" })))
    assert.deepEqual(states(run({ ...bothSelected, memberRoles: ["Company admin"] }, "product-updates", members)), ["Suppressed:PreferenceOff"], `${order}: an Off row counts where the role filter drops it`);
});

test("audience: a member's Off also stops a contact row with the same address, with members switched off or filtered out; a mandatory topic still sends it", () => {
  const input: AudienceInput = {
    organizations: orgs,
    members: [member("u1", "ORG-001", "viewer@origo.is", { role: "Viewer", preference: "Off" })],
    contacts: [
      contact("c1", "ORG-001", "Viewer@Origo.is", ["product-updates", "security-advisories"]), // the member's address, in another case
      contact("c2", "ORG-001", "other@origo.is", ["product-updates", "security-advisories"]),
    ],
    suppressions: new Map(),
  };
  const run = (audience: AudienceSpec, topic: CommunicationTopic) => resolveAudience(audience, topic, input, openSettings);
  const states = (result: ReturnType<typeof run>) => result.recipients.map((r) => `${r.email}:${r.source}:${r.state}:${r.suppressedReason ?? ""}`);
  const audiences: Array<[string, AudienceSpec]> = [
    ["members switched off", { ...spec, includeMembers: false }],
    ["the role filter drops the member row", { ...spec, memberRoles: ["Company admin"] }],
  ];
  for (const [why, audience] of audiences) {
    const product = run(audience, "product-updates");
    assert.deepEqual(states(product), ["viewer@origo.is:Contact:Suppressed:PreferenceOff", "other@origo.is:Contact:Queued:"], why);
    assert.deepEqual(product.breakdown.suppressed, { PreferenceOff: 1 }, why);
    assert.equal(product.breakdown.sendable, 1, why);
    assert.deepEqual(states(run(audience, "security-advisories")), ["viewer@origo.is:Contact:Queued:", "other@origo.is:Contact:Queued:"], `${why}: a mandatory topic ignores Off`);
  }
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

// Module scope: the send, worker and webhook tests of later tasks reuse it.
const draftInput = {
  templateKey: "product-update" as const, topic: "product-updates" as const, title: "3.0.0 announcement",
  content: productUpdate, audience: { organizations: "all-customers" as const, includeOnboarding: false, includeTestOrganizations: false, includeMembers: true, memberRoles: null, includeContacts: true, includeInternalCopy: false },
};

test("campaigns: create/list/get/update/duplicate/delete with publish-role gating and versions", async () => {
  await assert.rejects(createCommunication(CONTRIBUTOR, draftInput), /FORBIDDEN/);
  const created = await createCommunication(PM, draftInput);
  assert.match(created.id, /^COM-\d{3}$/);
  assert.equal(created.status, "Draft");
  assert.equal(created.version, "1");
  assert.equal((await listCommunications(CONTRIBUTOR)).length, 1);
  const updated = await updateCommunication(PM, created.id, { ...draftInput, title: "Renamed" });
  assert.equal(updated.title, "Renamed");
  const copy = await duplicateCommunication(PM, created.id);
  assert.notEqual(copy.id, created.id);
  assert.equal(copy.status, "Draft");
  assert.equal(copy.title, "Renamed (copy)");
  await deleteCommunication(PM, copy.id);
  await assert.rejects(getCommunication(PM, copy.id), /NOT_FOUND/);
  assert.equal(globalThis.pulseMemoryAudit?.some((a) => a.action === "communication.created"), true);
});

test("campaigns: preview renders the stored content for the requested locale", async () => {
  const created = await createCommunication(PM, draftInput);
  const preview = await previewCommunication(CONTRIBUTOR, created.id, "is");
  assert.equal(preview.subject, "DataCentral 3.0.0 (is)");
  assert.match(preview.html, /Vöruuppfærsla/);
});

test("campaigns: pre-fill from a published release", async () => {
  const idea = await createIdea(PM, { internalTitle: "Admin report", internalDescription: "Built-in admin report", area: "Administration" } as never);
  const release = await createRelease(PM, { title: "DataCentral 3.0.0", date: "2026-10-01", summary: "Better visibility.", availability: "General availability", documentationUrl: "https://docs.datacentral.ai/3-0", ideaIds: [idea.id] });
  await publishRelease(PM, release.id);
  const prefill = await prefillFromRelease(PM, release.id);
  assert.equal(prefill.templateKey, "product-update");
  assert.equal(prefill.content.subject.en, "DataCentral 3.0.0");
  const body = prefill.content.body.en as { title: string; intro: string; sections: Array<{ heading: string }>; cta?: { url: string } };
  assert.equal(body.title, "DataCentral 3.0.0");
  assert.equal(body.intro, "Better visibility.");
  assert.equal(body.sections[0].heading, "Admin report");
  assert.equal(body.cta?.url, "https://docs.datacentral.ai/3-0");
  const created = await createCommunication(PM, { fromReleaseId: release.id });
  assert.equal(created.releaseId, release.id);
});

/** A release with one idea per entry, the way the pre-fill finds them; `publish: false` leaves the ideas without release notes. */
async function makeRelease(ideas: Array<{ title: string; description: string }>, { publish = true, documentationUrl }: { publish?: boolean; documentationUrl?: string } = {}) {
  const ideaIds: string[] = [];
  for (const idea of ideas)
    ideaIds.push((await createIdea(PM, { internalTitle: idea.title, internalDescription: idea.description, area: "Administration" } as never)).id);
  const release = await createRelease(PM, { title: "DataCentral 3.1.0", date: "2026-11-01", summary: "Summary.", availability: "General availability", ...(documentationUrl ? { documentationUrl } : {}), ideaIds });
  if (publish) await publishRelease(PM, release.id);
  return release;
}

test("campaigns: any internal role reads, only the publish roles write, and an unknown id is NOT_FOUND", async () => {
  const created = await createCommunication(PM, draftInput);
  assert.equal((await getCommunication(CONTRIBUTOR, created.id)).title, "3.0.0 announcement");
  assert.equal((await previewCommunication(CONTRIBUTOR, created.id, "en")).subject, "DataCentral 3.0.0");
  for (const customer of [COMPANY_ADMIN, REQUESTER]) {
    await assert.rejects(listCommunications(customer), /FORBIDDEN/);
    await assert.rejects(getCommunication(customer, created.id), /FORBIDDEN/);
    await assert.rejects(previewCommunication(customer, created.id, "en"), /FORBIDDEN/);
    await assert.rejects(createCommunication(customer, draftInput), /FORBIDDEN/);
  }
  await assert.rejects(updateCommunication(CONTRIBUTOR, created.id, { ...draftInput, title: "Hijacked" }), /FORBIDDEN/);
  await assert.rejects(duplicateCommunication(CONTRIBUTOR, created.id), /FORBIDDEN/);
  await assert.rejects(deleteCommunication(CONTRIBUTOR, created.id), /FORBIDDEN/);
  await assert.rejects(createCommunication(CONTRIBUTOR, { fromReleaseId: "REL-404" }), /FORBIDDEN/, "the role is checked before the release is looked up");
  await assert.rejects(updateCommunication(CONTRIBUTOR, "COM-404", draftInput), /FORBIDDEN/, "the role is checked before the campaign is looked up");
  await assert.rejects(duplicateCommunication(CONTRIBUTOR, "COM-404"), /FORBIDDEN/, "the role is checked before the campaign is looked up");
  await assert.rejects(deleteCommunication(CONTRIBUTOR, "COM-404"), /FORBIDDEN/, "the role is checked before the campaign is looked up");
  assert.deepEqual((await listCommunications(ADMIN)).map((c) => c.title), ["3.0.0 announcement"], "the refused writes changed nothing");
  assert.equal((await createCommunication(ADMIN, draftInput)).createdBy, "Bjarki", "a System admin writes too");
  for (const id of ["COM-404", "REL-1", "", "COM-1; DROP TABLE dbo.Communications"]) {
    await assert.rejects(getCommunication(PM, id), /NOT_FOUND/, id);
    await assert.rejects(previewCommunication(PM, id, "en"), /NOT_FOUND/, id);
    await assert.rejects(updateCommunication(PM, id, draftInput), /NOT_FOUND/, id);
    await assert.rejects(duplicateCommunication(PM, id), /NOT_FOUND/, id);
    await assert.rejects(deleteCommunication(PM, id), /NOT_FOUND/, id);
  }
});

test("campaigns: only a Draft is editable, only a Draft or Cancelled campaign is deletable, and a copy is always a fresh Draft", async () => {
  const created = await createCommunication(PM, draftInput);
  const stored = memoryCommunications().find((c) => c.id === created.id)!;
  for (const status of ["Scheduled", "Sending", "Sent", "Cancelled"] as const) {
    stored.status = status;
    await assert.rejects(updateCommunication(PM, created.id, { ...draftInput, title: "Late edit" }), /INVALID_COMMUNICATION_NOT_EDITABLE/, status);
    assert.equal(stored.title, "3.0.0 announcement", `${status}: nothing was written`);
  }
  for (const status of ["Scheduled", "Sending", "Sent"] as const) {
    stored.status = status;
    await assert.rejects(deleteCommunication(PM, created.id), /INVALID_COMMUNICATION_NOT_DELETABLE/, status);
    assert.equal(memoryCommunications().length, 1, `${status}: the campaign is still there`);
  }
  Object.assign(stored, { status: "Sent", recipientCount: 42, scheduledAt: "2026-10-14T09:00:00.000Z", startedAt: "2026-10-14T09:00:01.000Z", completedAt: "2026-10-14T09:05:00.000Z", cancelledAt: "2026-10-14T09:06:00.000Z" });
  const copy = await duplicateCommunication(PM, created.id);
  assert.deepEqual(
    [copy.status, copy.recipientCount, copy.scheduledAt, copy.startedAt, copy.completedAt, copy.cancelledAt],
    ["Draft", 0, undefined, undefined, undefined, undefined], "a copy carries none of the sending history",
  );
  assert.deepEqual([copy.templateKey, copy.topic, copy.content, copy.audience], [stored.templateKey, stored.topic, stored.content, stored.audience], "but all of the content");
  stored.status = "Cancelled";
  await deleteCommunication(PM, created.id);
  await deleteCommunication(PM, copy.id);
  assert.deepEqual(memoryCommunications(), []);
});

test("campaigns: an edit replaces template, topic, content and audience, keeps the id, creator and release link, and invalid input changes nothing", async () => {
  const release = await makeRelease([{ title: "Admin report", description: "Built-in admin report." }]);
  const created = await createCommunication(PM, { fromReleaseId: release.id });
  const edited = await updateCommunication(ADMIN, created.id, {
    templateKey: "plain", topic: "general", title: "Plain note",
    content: { subject: { en: "Hello" }, body: { en: { title: "Hi", paragraphs: ["One"] } } },
    audience: { ...draftInput.audience, organizations: ["ORG-001"], includeContacts: false },
  });
  assert.deepEqual([edited.templateKey, edited.topic, edited.title, edited.content.subject.en], ["plain", "general", "Plain note", "Hello"]);
  assert.deepEqual([edited.audience.organizations, edited.audience.includeContacts], [["ORG-001"], false]);
  assert.deepEqual([edited.id, edited.status, edited.createdBy, edited.createdAt, edited.releaseId], [created.id, "Draft", "Product Manager", created.createdAt, release.id]);
  assert.ok(edited.updatedAt >= created.updatedAt);
  await assert.rejects(updateCommunication(PM, created.id, { ...draftInput, title: "" }), /INVALID_INPUT/);
  await assert.rejects(updateCommunication(PM, created.id, { ...draftInput, content: { subject: { en: "s" }, body: { en: { title: "no sections or intro" } } } }), /INVALID_INPUT/);
  await assert.rejects(updateCommunication(PM, created.id, { ...draftInput, audience: undefined } as never), /INVALID_INPUT/);
  const kept = await getCommunication(PM, created.id);
  assert.deepEqual([kept.templateKey, kept.title, kept.content.subject.en, kept.audience.organizations], ["plain", "Plain note", "Hello", ["ORG-001"]], "the draft is as the last good edit left it");
});

test("campaigns: every change is audited, without the subject, the body or the links", async () => {
  const created = await createCommunication(PM, draftInput);
  await updateCommunication(PM, created.id, { ...draftInput, title: "Renamed" });
  const copy = await duplicateCommunication(PM, created.id);
  await deleteCommunication(PM, copy.id);
  const audit = [...(globalThis.pulseMemoryAudit ?? [])].reverse().filter((a) => a.entityType === "Communication");
  assert.deepEqual(audit.map((a) => [a.action, a.entityId, a.actor]), [
    ["communication.created", created.id, "Product Manager"],
    ["communication.updated", created.id, "Product Manager"],
    ["communication.created", copy.id, "Product Manager"],
    ["communication.duplicated", copy.id, "Product Manager"],
    ["communication.deleted", copy.id, "Product Manager"],
  ]);
  assert.deepEqual(audit[1].before, { title: "3.0.0 announcement" });
  assert.deepEqual(audit[1].after, { title: "Renamed" });
  assert.deepEqual(audit[3].after, { from: created.id });
  const text = JSON.stringify(audit);
  for (const copyText of ["DataCentral 3.0.0 is now available", "New built-in Admin Report", "Explore DataCentral", "docs.datacentral.ai"])
    assert.ok(!text.includes(copyText), `the audit trail must not carry: ${copyText}`);
});

test("campaigns: deleting a campaign also drops its deliveries from memory, and nobody else's", async () => {
  const first = await createCommunication(PM, draftInput);
  const second = await createCommunication(PM, draftInput);
  const delivery = (communicationId: string, email: string): DeliveryRecord => ({
    id: crypto.randomUUID(), communicationId, organizationId: null, email, displayName: null, locale: "en", source: "Test", state: "Queued", attemptCount: 0, createdAt: new Date().toISOString(),
  });
  memoryDeliveries().push(delivery(first.id, "a@datacentral.ai"), delivery(second.id, "b@datacentral.ai"), delivery(first.id, "c@datacentral.ai"));
  await deleteCommunication(PM, first.id);
  assert.deepEqual(memoryDeliveries().map((d) => d.email), ["b@datacentral.ai"]);
});

test("campaigns: the list is newest first and leaves out deleted campaigns; reads hand out copies, never the store", async () => {
  const first = await createCommunication(PM, { ...draftInput, title: "First" });
  const second = await createCommunication(PM, { ...draftInput, title: "Second" });
  const third = await createCommunication(PM, { ...draftInput, title: "Third" });
  await deleteCommunication(PM, second.id);
  const list = await listCommunications(CONTRIBUTOR);
  assert.deepEqual(list.map((c) => [c.id, c.title]), [[third.id, "Third"], [first.id, "First"]]);
  list[0].title = "Tampered";
  list[0].content.subject.en = "Tampered";
  const item = await getCommunication(CONTRIBUTOR, third.id);
  item.audience.includeMembers = false;
  assert.deepEqual([(await getCommunication(PM, third.id)).title, (await getCommunication(PM, third.id)).content.subject.en, (await getCommunication(PM, third.id)).audience.includeMembers], ["Third", "DataCentral 3.0.0", true]);
  assert.equal((await getCommunication(PM, third.id)).stats.recipients, 0, "a campaign nobody was sent has empty stats");
  assert.deepEqual((await getCommunication(PM, third.id)).stats.byOrganization, []);
});

test("campaigns: the preview takes sign-off and footer from the settings for its locale, the logo from the public URL and the unsubscribe tag from the unsubscribe group", async () => {
  const created = await createCommunication(PM, draftInput);
  const original = process.env.PULSE_PUBLIC_URL;
  delete process.env.PULSE_PUBLIC_URL;
  try {
    const en = await previewCommunication(PM, created.id, "en");
    const is = await previewCommunication(PM, created.id, "is");
    assert.match(en.html, /Best,<br><strong>The DataCentral Team<\/strong>/);
    assert.match(is.html, /Kær kveðja,<br><strong>DataCentral teymið<\/strong>/);
    assert.match(en.html, /DataCentral ehf\. · Reykjavík, Iceland/);
    assert.match(is.html, /DataCentral ehf\. · Reykjavík &middot;/);
    assert.match(en.html, /src="http:\/\/localhost:3000\/email\/datacentral-logo\.png"/, "the public URL defaults to the local server");
    assert.ok(!en.html.includes("asm_group_unsubscribe") && !en.text.includes("asm_group_unsubscribe"), "no unsubscribe group, no unsubscribe tag");

    process.env.PULSE_PUBLIC_URL = "https://pulse.example.com//";
    await saveCommunicationSettings(ADMIN, {
      ...DEFAULT_COMMUNICATION_SETTINGS, unsubscribeGroupId: 42,
      boilerplate: { ...DEFAULT_COMMUNICATION_SETTINGS.boilerplate, en: { ...DEFAULT_COMMUNICATION_SETTINGS.boilerplate.en, signOff: "Cheers,\nThe Pulse crew", supportEmail: "help@datacentral.ai" } },
    });
    const configured = await previewCommunication(PM, created.id, "en");
    assert.match(configured.html, /src="https:\/\/pulse\.example\.com\/email\/datacentral-logo\.png"/, "trailing slashes of the public URL are dropped");
    assert.match(configured.html, /<%asm_group_unsubscribe_raw_url%>/);
    assert.match(configured.text, /<%asm_group_unsubscribe_raw_url%>/);
    assert.match(configured.html, /Cheers,<br><strong>The Pulse crew<\/strong>/);
    assert.match(configured.html, /help@datacentral\.ai/);
    assert.match((await previewCommunication(PM, created.id, "is")).html, /support@datacentral\.ai/, "the other locale keeps its own boilerplate");
  } finally {
    if (original === undefined) delete process.env.PULSE_PUBLIC_URL; else process.env.PULSE_PUBLIC_URL = original;
  }
});

test("campaigns: pre-fill uses the published wording, then the internal text, and the release notes once the release is published", async () => {
  // Not published yet, so the ideas have no release notes: the second idea's published wording and the first one's internal text are what is left.
  const release = await makeRelease([{ title: "Admin report", description: "Built-in admin report." }, { title: "Local time", description: "Internal wording." }], { publish: false });
  const second = (await listInternalIdeas(PM)).find((i) => i.id === release.ideaIds[1])!;
  Object.assign(second, { publishedTitle: "Times in your time zone", publishedDescription: "Dates and times now follow your local time." });
  type Prefilled = { subtitle: string; sections: Array<{ heading: string; body: string }>; cta?: unknown };
  const draft = (await prefillFromRelease(PM, release.id)).content.body.en as Prefilled;
  assert.deepEqual(draft.sections, [
    { heading: "Admin report", body: "Built-in admin report." },
    { heading: "Times in your time zone", body: "Dates and times now follow your local time." },
  ]);
  assert.equal(draft.subtitle, "General availability");
  assert.equal("cta" in draft, false, "no documentation URL, no call to action");
  await publishRelease(PM, release.id);
  const published = (await prefillFromRelease(PM, release.id)).content.body.en as Prefilled;
  assert.deepEqual(published.sections.map((s) => [s.heading, s.body]), [["Admin report", "Summary."], ["Times in your time zone", "Summary."]], "the release notes beat every other wording");
});

test("campaigns: pre-fill gives a release whose ideas are gone one section of its own, and an unknown release is NOT_FOUND", async () => {
  const release = await createRelease(PM, { title: "DataCentral 3.2.0", date: "2026-12-01", summary: "A short release.", availability: "Preview", documentationUrl: "https://docs.datacentral.ai/3-2", ideaIds: ["IDEA-9999"] });
  const prefill = await prefillFromRelease(PM, release.id);
  const body = prefill.content.body.en as { sections: unknown; cta: unknown };
  assert.deepEqual(body.sections, [{ heading: "DataCentral 3.2.0", body: "A short release." }]);
  assert.deepEqual(body.cta, { label: "Open the release notes", url: "https://docs.datacentral.ai/3-2" });
  assert.deepEqual(prefill.content.subject, { en: "DataCentral 3.2.0" });
  await assert.rejects(prefillFromRelease(PM, "REL-404"), /NOT_FOUND/);
  await assert.rejects(createCommunication(PM, { fromReleaseId: "REL-404" }), /NOT_FOUND/);
});

test("campaigns: creating from a release records the link, and what the caller sends wins over the pre-fill", async () => {
  const release = await makeRelease([{ title: "Admin report", description: "Built-in admin report." }]);
  const plain = await createCommunication(PM, { fromReleaseId: release.id });
  assert.deepEqual([plain.templateKey, plain.topic, plain.title, plain.content.subject.en, plain.releaseId], ["product-update", "product-updates", "DataCentral 3.1.0", "DataCentral 3.1.0", release.id]);
  assert.deepEqual(plain.audience, draftInput.audience, "the audience defaults to every customer with the schema defaults");
  const titled = await createCommunication(PM, { fromReleaseId: release.id, title: "Our own title", audience: { ...draftInput.audience, organizations: ["ORG-001"] } });
  assert.deepEqual([titled.title, titled.content.subject.en, titled.audience.organizations, titled.releaseId], ["Our own title", "DataCentral 3.1.0", ["ORG-001"], release.id]);
  const worded = await createCommunication(PM, { fromReleaseId: release.id, content: productUpdate });
  assert.deepEqual([worded.title, worded.content.subject.en, worded.releaseId], ["DataCentral 3.1.0", "DataCentral 3.0.0", release.id]);
  const unworded = await createCommunication(PM, { fromReleaseId: release.id, content: undefined });
  assert.deepEqual([unworded.content.subject.en, unworded.releaseId], ["DataCentral 3.1.0", release.id], "a content that is left out (undefined) leaves the pre-fill alone");
  await assert.rejects(createCommunication(PM, {}), /INVALID_INPUT/, "without a release the input has to be complete");
  assert.equal((await listCommunications(PM)).length, 4, "the failed create left nothing behind");
});

test("campaigns: a create or an edit takes the draft fields only, never an id, status or sending history from the client", async () => {
  const extras = { id: "COM-777", status: "Sent", recipientCount: 99, createdBy: "Someone else", scheduledAt: "2026-10-14T09:00:00.000Z", startedAt: "2026-10-14T09:00:01.000Z", releaseId: "REL-9" };
  const created = await createCommunication(PM, { ...draftInput, ...extras } as never);
  assert.deepEqual([created.id, created.status, created.recipientCount, created.createdBy, created.scheduledAt, created.startedAt, created.releaseId], ["COM-001", "Draft", 0, "Product Manager", undefined, undefined, undefined]);
  const edited = await updateCommunication(PM, created.id, { ...draftInput, title: "Renamed", ...extras } as never);
  assert.deepEqual([edited.id, edited.title, edited.status, edited.recipientCount, edited.createdBy, edited.scheduledAt, edited.startedAt, edited.releaseId], ["COM-001", "Renamed", "Draft", 0, "Product Manager", undefined, undefined, undefined]);
  assert.deepEqual((await listCommunications(PM)).map((c) => c.id), ["COM-001"]);
});

test("campaigns: a copy of a campaign whose title is at the limit still fits it, and never ends in half an emoji", async () => {
  const created = await createCommunication(PM, { ...draftInput, title: "T".repeat(200) });
  const copy = await duplicateCommunication(PM, created.id);
  assert.equal(copy.title, `${"T".repeat(193)} (copy)`);
  assert.equal(copy.title.length, 200);
  const emoji = await createCommunication(PM, { ...draftInput, title: `${"T".repeat(192)}\u{1F600}\u{1F600}` }); // the cut falls inside the first emoji
  assert.equal((await duplicateCommunication(PM, emoji.id)).title, `${"T".repeat(192)} (copy)`);
});

type SqlCall = { text: string; inputs: Record<string, unknown>; inTransaction: boolean };
type SqlAnswer = { recordset?: Array<Record<string, unknown>>; rowsAffected?: number[] };
type SqlAnswers = Array<[RegExp, SqlAnswer | ((inputs: Record<string, unknown>) => SqlAnswer)]>;
/**
 * Runs `work` against a stand-in for Azure SQL: the repository's real SQL branch executes, `atomicSql` included, because
 * `sql.Transaction` and `sql.Request` are swapped for recorders. A statement is answered by the first matching entry of
 * `answers`; the account and membership checks are answered as an active Product manager. Like SQL Server, a statement
 * that names a parameter nobody bound fails. `events` is the transaction's life: begin, then commit or rollback.
 */
async function withFakeSql<T>(answers: SqlAnswers, work: (calls: SqlCall[], events: string[]) => Promise<T>): Promise<T> {
  const calls: SqlCall[] = [];
  const events: string[] = [];
  const known: SqlAnswers = [
    ...answers,
    [/FROM dbo\.Users WHERE id=@id/, { recordset: [{ status: "Active", authMethod: "OTP", tokensValidAfter: null }] }],
    [/FROM dbo\.Memberships m JOIN dbo\.Organizations o/, { recordset: [{ role: "Product manager", allowedAuth: '["OTP","Entra ID"]' }] }],
  ];
  class FakeRequest {
    private inputs: Record<string, unknown> = {};
    constructor(private readonly transaction?: unknown) {} // set when the request was made for a transaction, as `getSqlPool()` does inside `atomicSql`
    input(name: string, ...typeAndValue: unknown[]) { this.inputs[name] = typeAndValue[typeAndValue.length - 1]; return this; }
    async query(text: string) {
      for (const [, name] of text.matchAll(/(?<!@)@(\w+)/g)) if (!(name in this.inputs)) throw new Error(`Must declare the scalar variable "@${name}".`);
      calls.push({ text, inputs: this.inputs, inTransaction: Boolean(this.transaction) });
      const entry = known.find(([pattern]) => pattern.test(text))?.[1] ?? {};
      const answer = typeof entry === "function" ? entry(this.inputs) : entry;
      return { recordset: answer.recordset ?? [], rowsAffected: answer.rowsAffected ?? [answer.recordset?.length ?? 0] };
    }
  }
  class FakeTransaction {
    async begin() { events.push("begin"); }
    async commit() { events.push("commit"); }
    async rollback() { events.push("rollback"); }
  }
  const real = { Request: sql.Request, Transaction: sql.Transaction };
  Object.assign(sql, { Request: FakeRequest, Transaction: FakeTransaction });
  process.env.AZURE_SQL_SERVER = "fake-sql-server";
  globalThis.pulseSqlPool = Promise.resolve({ request: () => new FakeRequest() } as unknown as import("mssql").ConnectionPool);
  try {
    return await work(calls, events);
  } finally {
    Object.assign(sql, real);
    delete process.env.AZURE_SQL_SERVER;
    globalThis.pulseSqlPool = undefined;
  }
}
const SQL_UUID = "AAAAAAAA-0000-4000-8000-0000000000C1";
const sqlRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id, templateKey: "product-update", topic: "product-updates", title: "3.0.0 announcement", contentJson: JSON.stringify(productUpdate), audienceJson: JSON.stringify(draftInput.audience),
  status: "Draft", scheduledAt: null, startedAt: null, completedAt: null, cancelledAt: null, recipientCount: 0, releaseId: null,
  createdBy: "Product Manager", createdAt: "2026-10-13T09:00:00.0000000", updatedAt: "2026-10-13T09:30:00.0000000", ...extra,
});
/** What the database answers for a campaign that exists: its row (found by `@id`), its uuid and its row version. */
const sqlCampaign = (id: string, extra: Record<string, unknown> = {}): SqlAnswers => [
  [/OPENJSON/, (inputs) => ({ recordset: (JSON.parse(String(inputs.ids)) as string[]).map((value) => ({ id: value, version: `0x${value.replace(/\D/g, "").padStart(16, "0")}` })) })],
  [/SELECT CAST\(id AS nvarchar\(36\)\) id FROM dbo\.Communications/, (inputs) => ({ recordset: inputs.id === id ? [{ id: SQL_UUID }] : [] })],
  [/FROM dbo\.Communications c JOIN dbo\.Users u[\s\S]*WHERE c\.public_id=@id/, (inputs) => ({ recordset: inputs.id === id ? [sqlRow(id, extra)] : [] })],
];
const sqlWrites = (calls: SqlCall[]) => calls.filter((c) => /^\s*(UPDATE|INSERT)/.test(c.text));

test("campaigns, SQL: reads map the rows and attach row versions, and an id that cannot exist never reaches the database", async () => {
  const answers: SqlAnswers = [
    [/ORDER BY c\.created_at DESC/, { recordset: [sqlRow("COM-008", { title: "Newer" }), sqlRow("COM-007", { status: "Scheduled", scheduledAt: "2026-10-14T09:00:00.0000000", releaseId: "REL-3" })] }],
    ...sqlCampaign("COM-007"),
  ];
  await withFakeSql(answers, async (calls) => {
    const list = await listCommunications(CONTRIBUTOR);
    assert.deepEqual(list.map((c) => [c.id, c.title, c.status, c.version, c.scheduledAt, c.releaseId]), [
      ["COM-008", "Newer", "Draft", "0x0000000000000008", undefined, undefined],
      ["COM-007", "3.0.0 announcement", "Scheduled", "0x0000000000000007", "2026-10-14T09:00:00.0000000", "REL-3"],
    ]);
    assert.deepEqual(list[0].content, productUpdate, "the JSON columns come back as objects");
    assert.deepEqual(list[0].audience, draftInput.audience);
    assert.match(calls.find((c) => /ORDER BY/.test(c.text))!.text, /WHERE c\.deleted_at IS NULL ORDER BY c\.created_at DESC/);

    const item = await getCommunication(CONTRIBUTOR, "COM-007");
    assert.deepEqual([item.id, item.createdBy, item.createdAt, item.updatedAt, item.recipientCount, item.version], ["COM-007", "Product Manager", "2026-10-13T09:00:00.0000000", "2026-10-13T09:30:00.0000000", 0, "0x0000000000000007"]);
    assert.match(calls.find((c) => /WHERE c\.public_id=@id/.test(c.text))!.text, /WHERE c\.public_id=@id AND c\.deleted_at IS NULL$/, "a deleted campaign is gone");
    assert.equal((await previewCommunication(CONTRIBUTOR, "COM-007", "is")).subject, "DataCentral 3.0.0 (is)");
    await assert.rejects(getCommunication(CONTRIBUTOR, "COM-404"), /NOT_FOUND/, "a well-formed id that is not there");

    const seen = calls.length;
    for (const id of ["", "COM-", "com-7", "REL-7", "COM-7; DROP TABLE dbo.Communications", `COM-${"9".repeat(40)}`]) {
      await assert.rejects(getCommunication(CONTRIBUTOR, id), /NOT_FOUND/, id);
      await assert.rejects(previewCommunication(CONTRIBUTOR, id, "en"), /NOT_FOUND/, id);
      await assert.rejects(findCommunicationUuid(id), /NOT_FOUND/, id);
    }
    assert.deepEqual(calls.slice(seen).filter((c) => /dbo\.Communications/.test(c.text)), [], "no statement about campaigns was sent");
    assert.equal(await findCommunicationUuid("COM-007"), SQL_UUID);
    assert.match(calls.at(-1)!.text, /FROM dbo\.Communications WHERE public_id=@id AND deleted_at IS NULL$/, "the uuid of a deleted campaign is not handed out");
  });
});

test("campaigns, SQL: a create is one insert with a sequence number and its audit row in one transaction", async () => {
  await withFakeSql([[/^\s*INSERT dbo\.Communications\(/, { recordset: [{ publicId: "COM-008" }], rowsAffected: [1] }], ...sqlCampaign("COM-008")], async (calls, events) => {
    const created = await createCommunication(PM, draftInput);
    assert.deepEqual([created.id, created.version, created.status], ["COM-008", "0x0000000000000008", "Draft"]);
    const [insert, audit, ...more] = sqlWrites(calls);
    assert.equal(more.length, 0);
    assert.match(insert.text, /CONCAT\('COM-',FORMAT\(NEXT VALUE FOR dbo\.CommunicationNumber,'000'\)\)/);
    assert.match(insert.text, /OUTPUT INSERTED\.public_id publicId/);
    assert.deepEqual([insert.inputs.template, insert.inputs.topic, insert.inputs.title, insert.inputs.release, insert.inputs.actor], ["product-update", "product-updates", "3.0.0 announcement", null, PM.id]);
    assert.deepEqual(JSON.parse(String(insert.inputs.content)), productUpdate);
    assert.deepEqual(JSON.parse(String(insert.inputs.audience)), draftInput.audience);
    assert.deepEqual([audit.inputs.action, audit.inputs.actor, audit.inputs.entity, audit.inputs.before], ["communication.created", PM.id, insert.inputs.id, null]);
    assert.deepEqual(JSON.parse(String(audit.inputs.after)), { publicId: "COM-008", templateKey: "product-update", topic: "product-updates" });
    assert.match(audit.text, /^INSERT dbo\.AuditEvents\(id,actor_user_id,action,entity_type,entity_id,before_json,after_json,correlation_id\) VALUES\(@auditId,@actor,@action,'Communication',@entity,@before,@after,@correlation\)$/);
    assert.ok(sqlWrites(calls).every((c) => c.inTransaction), "both writes ran inside the transaction");
    assert.deepEqual(events, ["begin", "commit"]);
  });
  await withFakeSql([], async (calls, events) => {
    await assert.rejects(createCommunication(PM, { ...draftInput, title: "" }), /INVALID_INPUT/);
    assert.deepEqual([sqlWrites(calls).length, events], [0, []], "invalid input opens no transaction and writes nothing");
  });
});

test("campaigns, SQL: creating from a release pre-fills from the release and ideas read through SQL, and records the release", async () => {
  const release = { id: "REL-3", title: "DataCentral 3.0.0", date: "2026-10-01", summary: "Better visibility.", availability: "General availability", documentationUrl: "https://docs.datacentral.ai/3-0", rolloutNotes: null, published: true, ideaId: "IDEA-5" };
  const idea = {
    id: "IDEA-5", title: "Admin report", description: "Built-in admin report", internalTitle: "Admin report (internal)", internalDescription: "Built-in admin report", publishedTitle: "Admin report", publishedDescription: null,
    area: "Administration", status: "Released", internalStatus: "Released", horizon: "Released", publishState: "Published", releaseNotes: "Better visibility.", updatedAt: "2026-10-01T00:00:00.000Z",
  };
  const answers: SqlAnswers = [
    [/^\s*INSERT dbo\.Communications\(/, { recordset: [{ publicId: "COM-008" }], rowsAffected: [1] }],
    [/FROM dbo\.Releases r LEFT JOIN/, { recordset: [release] }],
    [/FROM dbo\.Ideas i LEFT JOIN/, { recordset: [idea] }],
    ...sqlCampaign("COM-008", { releaseId: "REL-3" }),
  ];
  await withFakeSql(answers, async (calls) => {
    const created = await createCommunication(PM, { fromReleaseId: "REL-3" });
    assert.equal(created.releaseId, "REL-3");
    const [insert, audit, ...more] = sqlWrites(calls);
    assert.equal(more.length, 0);
    assert.deepEqual([insert.inputs.release, insert.inputs.title, insert.inputs.template, insert.inputs.topic], ["REL-3", "DataCentral 3.0.0", "product-update", "product-updates"]);
    const content = JSON.parse(String(insert.inputs.content));
    assert.equal(content.subject.en, "DataCentral 3.0.0");
    assert.deepEqual(content.body.en.sections, [{ heading: "Admin report", body: "Better visibility." }]);
    assert.equal(content.body.en.cta.url, "https://docs.datacentral.ai/3-0");
    assert.equal(JSON.parse(String(audit.inputs.after)).releaseId, "REL-3");
    await assert.rejects(createCommunication(PM, { fromReleaseId: "REL-404" }), /NOT_FOUND/);
    assert.equal(sqlWrites(calls).length, 2, "an unknown release writes nothing");
  });
});

test("campaigns, SQL: an edit is one guarded UPDATE with its audit row in one transaction, and a draft that stopped being one is not written", async () => {
  const update: SqlAnswers = [[/^\s*UPDATE dbo\.Communications/, { rowsAffected: [1] }], ...sqlCampaign("COM-007")];
  await withFakeSql(update, async (calls, events) => {
    const saved = await updateCommunication(PM, "COM-007", { ...draftInput, title: "Renamed" });
    assert.deepEqual([saved.id, saved.version], ["COM-007", "0x0000000000000007"]);
    const [write, audit, ...more] = sqlWrites(calls);
    assert.equal(more.length, 0);
    assert.match(write.text, /SET template_key=@template,topic=@topic,title=@title,content_json=@content,audience_json=@audience,\s+updated_by_user_id=@actor,updated_at=SYSUTCDATETIME\(\) WHERE public_id=@id AND status='Draft' AND deleted_at IS NULL$/);
    assert.deepEqual([write.inputs.id, write.inputs.template, write.inputs.topic, write.inputs.title, write.inputs.actor], ["COM-007", "product-update", "product-updates", "Renamed", PM.id]);
    assert.deepEqual(JSON.parse(String(write.inputs.content)), productUpdate);
    assert.deepEqual(JSON.parse(String(write.inputs.audience)), draftInput.audience);
    assert.deepEqual([audit.inputs.action, audit.inputs.entity], ["communication.updated", SQL_UUID]);
    assert.deepEqual(JSON.parse(String(audit.inputs.before)), { title: "3.0.0 announcement" });
    assert.deepEqual(JSON.parse(String(audit.inputs.after)), { title: "Renamed" });
    assert.ok(sqlWrites(calls).every((c) => c.inTransaction), "both writes ran inside the transaction");
    assert.deepEqual(events, ["begin", "commit"]);
  });
  await withFakeSql([[/^\s*UPDATE dbo\.Communications/, { rowsAffected: [0] }], ...sqlCampaign("COM-007")], async (calls, events) => {
    await assert.rejects(updateCommunication(PM, "COM-007", draftInput), /NOT_FOUND/, "the UPDATE matched no Draft row");
    assert.deepEqual(events, ["begin", "rollback"]);
    assert.equal(sqlWrites(calls).filter((c) => /AuditEvents/.test(c.text)).length, 0, "no audit row for a write that did not happen");
  });
  await withFakeSql(sqlCampaign("COM-007", { status: "Sent" }), async (calls, events) => {
    await assert.rejects(updateCommunication(PM, "COM-007", draftInput), /INVALID_COMMUNICATION_NOT_EDITABLE/);
    assert.deepEqual([sqlWrites(calls).length, events], [0, []], "a sent campaign is refused before anything is written");
  });
  await withFakeSql(sqlCampaign("COM-007"), async (calls) => {
    await assert.rejects(updateCommunication(PM, "COM-404", draftInput), /NOT_FOUND/);
    assert.equal(sqlWrites(calls).length, 0);
  });
});

test("campaigns, SQL: a duplicate commits the copy and both of its audit rows together", async () => {
  const answers: SqlAnswers = [ // the first matching entry answers, so the two campaigns' rows and uuids come before the generic ones
    [/^\s*INSERT dbo\.Communications\(/, { recordset: [{ publicId: "COM-009" }], rowsAffected: [1] }],
    [/SELECT CAST\(id AS nvarchar\(36\)\) id FROM dbo\.Communications/, (inputs) => ({ recordset: [{ id: inputs.id === "COM-009" ? "BBBBBBBB-0000-4000-8000-0000000000C2" : SQL_UUID }] })],
    [/FROM dbo\.Communications c JOIN dbo\.Users u[\s\S]*WHERE c\.public_id=@id/, (inputs) => ({ recordset: [sqlRow(String(inputs.id), inputs.id === "COM-009" ? {} : { status: "Sent" })] })],
    ...sqlCampaign("COM-007"),
  ];
  await withFakeSql(answers, async (calls, events) => {
    const copy = await duplicateCommunication(PM, "COM-007");
    assert.deepEqual([copy.id, copy.status, copy.version], ["COM-009", "Draft", "0x0000000000000009"]);
    const [insert, created, duplicated, ...more] = sqlWrites(calls);
    assert.equal(more.length, 0);
    assert.deepEqual([insert.inputs.title, insert.inputs.release, insert.inputs.actor], ["3.0.0 announcement (copy)", null, PM.id]);
    assert.deepEqual(JSON.parse(String(insert.inputs.content)), productUpdate, "the copy has the content of the source");
    assert.deepEqual([created.inputs.action, created.inputs.entity], ["communication.created", insert.inputs.id]);
    assert.deepEqual([duplicated.inputs.action, duplicated.inputs.entity, duplicated.inputs.actor], ["communication.duplicated", "BBBBBBBB-0000-4000-8000-0000000000C2", PM.id]);
    assert.deepEqual(JSON.parse(String(duplicated.inputs.after)), { from: "COM-007" });
    assert.ok(sqlWrites(calls).every((c) => c.inTransaction), "all three writes ran inside the transaction");
    assert.deepEqual(events, ["begin", "commit"], "one transaction for the copy and its audit rows");
  });
});

test("campaigns, SQL: a delete is one guarded soft-delete with its audit row, and only a Draft or Cancelled campaign is touched", async () => {
  const softDelete: SqlAnswers = [[/^\s*UPDATE dbo\.Communications/, { rowsAffected: [1] }]];
  for (const status of ["Draft", "Cancelled"]) {
    await withFakeSql([...softDelete, ...sqlCampaign("COM-007", { status })], async (calls, events) => {
      assert.equal(await deleteCommunication(PM, "COM-007"), undefined);
      const [write, audit, ...more] = sqlWrites(calls);
      assert.equal(more.length, 0, status);
      assert.match(write.text, /SET deleted_at=SYSUTCDATETIME\(\),updated_by_user_id=@actor,updated_at=SYSUTCDATETIME\(\) WHERE public_id=@id AND status IN \('Draft','Cancelled'\) AND deleted_at IS NULL/);
      assert.deepEqual([write.inputs.id, write.inputs.actor], ["COM-007", PM.id], status);
      assert.deepEqual([audit.inputs.action, audit.inputs.entity, audit.inputs.before, audit.inputs.after], ["communication.deleted", SQL_UUID, null, "{}"], status);
      assert.ok(sqlWrites(calls).every((c) => c.inTransaction), `${status}: both writes ran inside the transaction`);
      assert.deepEqual(events, ["begin", "commit"], status);
    });
  }
  for (const status of ["Scheduled", "Sending", "Sent"]) {
    await withFakeSql([...softDelete, ...sqlCampaign("COM-007", { status })], async (calls, events) => {
      await assert.rejects(deleteCommunication(PM, "COM-007"), /INVALID_COMMUNICATION_NOT_DELETABLE/, status);
      assert.deepEqual([sqlWrites(calls).length, events], [0, []], `${status}: nothing is written`);
    });
  }
  await withFakeSql([[/^\s*UPDATE dbo\.Communications/, { rowsAffected: [0] }], ...sqlCampaign("COM-007")], async (calls, events) => {
    await assert.rejects(deleteCommunication(PM, "COM-007"), /NOT_FOUND/, "the UPDATE matched no row");
    assert.deepEqual(events, ["begin", "rollback"]);
    assert.equal(sqlWrites(calls).filter((c) => /AuditEvents/.test(c.text)).length, 0);
  });
});
