import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PulseIdentity } from "../lib/domain";
import { memoryCommunications, memoryContacts, memoryDeliveries, memoryEvents, resetCommunicationMemory } from "../lib/server/communications/memory";
import {
  DEFAULT_COMMUNICATION_SETTINGS,
  getCommunicationSettings,
  getRuntimeCommunicationSettings,
  saveCommunicationSettings,
  communicationProviderStatus,
  type CommunicationSettings,
} from "../lib/server/communications/settings";
import { escapeHtml, inlineToText, renderInline } from "../lib/server/communications/html";
import { getTemplate, renderCommunication } from "../lib/server/communications/templates/index";
import { executeIdempotent } from "../lib/server/idempotency";
import { checkedMutation } from "../lib/server/versions";
import {
  communicationCancelInputSchema,
  communicationInputSchema,
  communicationSendInputSchema,
  communicationSettingsInputSchema,
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
import { blockedReason, domainAllowed, loadAudienceInput, resolveAudience, type AudienceInput } from "../lib/server/communications/audience";
import { COMMUNICATION_TOPICS, MANDATORY_TOPICS, topicEventType } from "../lib/server/communications/topics";
import type { AudienceSpec, CommunicationTopic, DeliveryRecord, DeliveryState, SuppressionReason } from "../lib/server/communications/types";
import {
  audienceEstimate, cancelCommunication, createCommunication, currentSendingState, deleteCommunication, duplicateCommunication, findCommunicationUuid, getCommunication,
  listCommunications, listDeliveries, prefillFromRelease, previewCommunication, retryDeadLetters, sendCommunication, testSendCommunication, updateCommunication,
} from "../lib/server/communications/campaign-repository";
import { BACKOFF_BASE_MS, communicationStats, freezeAudience, getDeliveryStore, LEASE_MS, MAX_ATTEMPTS, requeueDeadLetters, type DeliveryStore } from "../lib/server/communications/delivery-store";
import { buildSendGridMessage, classifySendError, createMailTransport, sendConfigurationTest, SendError, type MailTransport, type OutboundBatch } from "../lib/server/communications/sendgrid";
import { MAX_SPLIT_REQUESTS, processCommunicationBatch } from "../lib/server/communications/delivery-worker";
import { applyEvents, mapEvent, normalizePublicKey, parseEvents, verifyEventSignature, type SendGridEvent } from "../lib/server/communications/event-webhook";
import { deliveryStatus, retryDeliveries } from "../lib/server/delivery-status";
import { productionConfigurationErrors } from "../lib/server/production-config";
import { makeT } from "../lib/i18n";
import sgMail from "@sendgrid/mail";
import { z } from "zod";
import { parseInput } from "../lib/server/validation";
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
  assert.deepEqual(await getCommunicationSettings(ADMIN), saved, "a read gives back exactly what was saved");
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

test("settings: sending cannot go live without an unsubscribe group — enabled with safe mode off needs one; safe mode on, or sending off, does not", async () => {
  const live = { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai", safeMode: { enabled: false, allowedDomains: [] } };
  // The contract: the one issue is the group, and it names itself with a code.
  const refused = communicationSettingsInputSchema.safeParse(live);
  assert.ok(!refused.success, "enabled, safe mode off, no group");
  assert.deepEqual(refused.error.issues.map((issue) => [issue.path.join("."), issue.message]), [["unsubscribeGroupId", "INVALID_UNSUBSCRIBE_GROUP_REQUIRED"]]);
  const accepted: Array<[string, unknown]> = [
    ["with a group", { ...live, unsubscribeGroupId: 7 }],
    ["safe mode on, no group", { ...live, safeMode: { enabled: true, allowedDomains: ["datacentral.ai"] } }],
    ["sending off, safe mode off, no group", { ...live, enabled: false }],
  ];
  for (const [what, settings] of accepted) assert.ok(communicationSettingsInputSchema.safeParse(settings).success, what);
  assert.ok(!communicationSettingsInputSchema.safeParse({ ...live, unsubscribeGroupId: 0 }).success, "a group is a positive id, not 0");
  // The save: refused with the code, and nothing is stored or audited.
  await assert.rejects(saveCommunicationSettings(ADMIN, live), { message: "INVALID_UNSUBSCRIBE_GROUP_REQUIRED" });
  assert.equal(globalThis.pulseMemoryCommunicationSettings, undefined, "nothing was stored");
  assert.equal(globalThis.pulseMemoryAudit?.some((a) => a.action === "communication.settings.updated") ?? false, false, "and nothing was audited");
  // Another problem in the same body keeps the usual refusal: the code is told only when the group is all that is wrong.
  await assert.rejects(saveCommunicationSettings(ADMIN, { ...live, fromEmail: "" }), { message: "INVALID_INPUT" });
  const saved = await saveCommunicationSettings(ADMIN, { ...live, unsubscribeGroupId: 7 });
  assert.deepEqual([saved.enabled, saved.safeMode.enabled, saved.unsubscribeGroupId], [true, false, 7]);
  assert.equal((await getCommunicationSettings(ADMIN)).unsubscribeGroupId, 7);
  // Taking the group away again while sending is live is the same refusal.
  await assert.rejects(saveCommunicationSettings(ADMIN, { ...saved, unsubscribeGroupId: null }), { message: "INVALID_UNSUBSCRIBE_GROUP_REQUIRED" });
  assert.equal((await getCommunicationSettings(ADMIN)).unsubscribeGroupId, 7, "the group is still there");
});

test("parseInput: a check whose message is a code gives that code when it is all that is wrong; any other issue keeps INVALID_INPUT", () => {
  const schema = z
    .object({ a: z.number(), b: z.string() })
    .refine((v) => v.a > 0, { message: "INVALID_A_MUST_BE_POSITIVE" })
    .refine((v) => v.b !== "x", { message: "b must not be x" });
  assert.deepEqual(parseInput(schema, { a: 1, b: "y" }), { a: 1, b: "y" });
  assert.throws(() => parseInput(schema, { a: 0, b: "y" }), { message: "INVALID_A_MUST_BE_POSITIVE" });
  assert.throws(() => parseInput(schema, { a: 0, b: "x" }), { message: "INVALID_INPUT" }, "a plain message beside it: the generic refusal");
  assert.throws(() => parseInput(schema, { a: "0", b: "y" }), { message: "INVALID_INPUT" }, "a wrong type is not a named check");
  assert.throws(() => parseInput(schema, undefined), { message: "INVALID_INPUT" });
  const loose = z.object({ a: z.number() }).refine((v) => v.a > 0, { message: "INVALID_lowercase" });
  assert.throws(() => parseInput(loose, { a: 0 }), { message: "INVALID_INPUT" }, "only a message shaped like a code is taken for one");
});

test("settings and suppressions: a caller who may not write is refused before the input is looked at — a malformed body is FORBIDDEN, not INVALID_INPUT", async () => {
  await assert.rejects(saveCommunicationSettings(PM, { enabled: "yes" } as never), /FORBIDDEN/);
  await assert.rejects(saveCommunicationSettings(CONTRIBUTOR, null as never), /FORBIDDEN/);
  await assert.rejects(addSuppression(PM, { email: "not-an-address" }), /FORBIDDEN/);
  await assert.rejects(addSuppression(COMPANY_ADMIN, {} as never), /FORBIDDEN/);
  await assert.rejects(saveCommunicationSettings(ADMIN, { enabled: "yes" } as never), /INVALID_INPUT/, "the System admin is told what is wrong with the same input");
  await assert.rejects(addSuppression(ADMIN, { email: "not-an-address" }), /INVALID_INPUT/);
  assert.equal(globalThis.pulseMemoryCommunicationSettings, undefined, "nothing was stored");
  assert.deepEqual(await listSuppressions(ADMIN), [], "and nothing was suppressed");
});

test("sending state: every internal role reads what the worker would do now — the state the Settings card shows — and a customer is refused", async () => {
  const everyRole = async () => [await currentSendingState(PM), await currentSendingState(CONTRIBUTOR), await currentSendingState(ADMIN)];
  assert.deepEqual(await everyRole(), ["disabled", "disabled", "disabled"], "a new installation: sending is off");
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai" });
  assert.deepEqual(await everyRole(), ["provider-missing", "provider-missing", "provider-missing"], "on, without a key");
  process.env.SENDGRID_API_KEY = "SG.test";
  assert.deepEqual(await everyRole(), ["safe-mode", "safe-mode", "safe-mode"], "with a key: only the allow-listed domains");
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai", sandboxMode: true });
  assert.equal(await currentSendingState(PM), "sandbox", "sandbox comes before safe mode: nothing is delivered");
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai", unsubscribeGroupId: 42, safeMode: { enabled: false, allowedDomains: [] } });
  assert.deepEqual(await everyRole(), ["live", "live", "live"]);
  assert.equal(await currentSendingState(PM), communicationProviderStatus(await getCommunicationSettings(ADMIN)).effectiveSendingState, "the value the settings route computes");
  for (const customer of [COMPANY_ADMIN, REQUESTER]) await assert.rejects(currentSendingState(customer), /FORBIDDEN/);
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

test("contracts: a cancel input defaults to cancel, takes only cancel or unschedule and is strict", () => {
  assert.deepEqual(communicationCancelInputSchema.parse({}), { mode: "cancel" });
  assert.deepEqual(communicationCancelInputSchema.parse({ mode: "unschedule" }), { mode: "unschedule" });
  assert.deepEqual(communicationCancelInputSchema.parse({ mode: "cancel" }), { mode: "cancel" });
  assert.equal(communicationCancelInputSchema.safeParse({ mode: "delete" }).success, false);
  assert.equal(communicationCancelInputSchema.safeParse({ mode: "cancel", extra: 1 }).success, false);
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

test("versions: an id longer than the 32 characters it is bound as is NOT_FOUND before anything else is asked, for every entity and caller", async () => {
  let ran = 0;
  const work = async () => { ran++; return {}; };
  const fits = `COM-${"1".repeat(28)}`;
  const tooLong = `${fits}1`;
  assert.deepEqual([fits.length, tooLong.length], [32, 33]);
  await checkedMutation(PM, "Communications", fits, "1", work);
  assert.equal(ran, 1, "an id of 32 characters is let through");
  await assert.rejects(checkedMutation(PM, "Communications", tooLong, "1", work), /NOT_FOUND/);
  await assert.rejects(checkedMutation(PM, "Releases", tooLong, "1", work), /NOT_FOUND/, "whatever the entity");
  await assert.rejects(checkedMutation(CONTRIBUTOR, "Communications", tooLong, null, work), /NOT_FOUND/, "before the role and the version are checked, so the answer says nothing about either");
  assert.equal(ran, 1, "the work did not run");
  await withFakeSql([], async (calls, events) => {
    await assert.rejects(checkedMutation({ ...PM }, "Communications", tooLong, "1", work), /NOT_FOUND/);
    assert.deepEqual([calls, events], [[], []], "not a statement was sent and no transaction was opened: the driver binds the id as NVarChar(32)");
    await assert.rejects(checkedMutation({ ...PM }, "Communications", fits, "0x0000000000000001", work), /NOT_FOUND/);
    assert.ok(calls.some((c) => /FROM dbo\.Communications WITH \(UPDLOCK,HOLDLOCK\) WHERE public_id=@id/.test(c.text)), "an id that fits is looked up");
  });
});

test("idempotency: an operation name longer than the 100 characters an idempotency record stores is NOT_FOUND before anything else is asked", async () => {
  const request = () => new Request("https://pulse.test/api/v1/internal/communications/COM-001/send", {
    method: "POST", headers: { "idempotency-key": "communications-length-key" }, body: "{}",
  });
  let ran = 0;
  const work = async () => { ran++; return {}; };
  const fits = `communication.send:${"x".repeat(81)}`;
  const tooLong = `${fits}x`;
  assert.deepEqual([fits.length, tooLong.length], [100, 101]);
  await executeIdempotent(request(), PM, fits, 200, work);
  assert.equal(ran, 1, "an operation of 100 characters is let through");
  await assert.rejects(executeIdempotent(request(), PM, tooLong, 200, work), /NOT_FOUND/);
  await assert.rejects(executeIdempotent(request(), CONTRIBUTOR, tooLong, 200, work), /NOT_FOUND/, "before the role is checked, so the answer says nothing about the caller");
  assert.equal(ran, 1, "the work did not run");
  await withFakeSql([], async (calls, events) => {
    await assert.rejects(executeIdempotent(request(), { ...PM }, tooLong, 200, work), /NOT_FOUND/);
    assert.deepEqual([calls, events], [[], []], "not a statement was sent and no transaction was opened: the driver binds the operation as NVarChar(100)");
  });
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

test("preferences: a communication topic is on (Immediate) or off; Daily and Weekly are refused, and the mandatory topic stays Immediate", async () => {
  const cadenceOf = async (eventType: string) =>
    (await listNotificationPreferences(REQUESTER)).find((p) => p.eventType === eventType)?.cadence;
  for (const cadence of ["Off", "Immediate"] as const) {
    assert.equal((await saveNotificationPreference(REQUESTER, "communication.general", cadence)).cadence, cadence);
    assert.equal(await cadenceOf("communication.general"), cadence, `${cadence} is saved and listed`);
  }
  await saveNotificationPreference(REQUESTER, "communication.general", "Off");
  for (const eventType of notificationEventTypes.filter((type) => type.startsWith("communication."))) {
    for (const cadence of ["Daily", "Weekly"]) {
      await assert.rejects(
        saveNotificationPreference(REQUESTER, eventType, cadence),
        // The mandatory topic is refused for what it is, anything but Immediate; the rule about digests is for the others.
        eventType === "communication.security-advisories" ? /MANDATORY_NOTIFICATION_MUST_BE_IMMEDIATE/ : /INVALID_NOTIFICATION_CADENCE/,
        `${eventType} ${cadence}`,
      );
    }
  }
  assert.equal(await cadenceOf("communication.general"), "Off", "a refused cadence changes nothing");
  await assert.rejects(saveNotificationPreference(REQUESTER, "communication.security-advisories", "Off"), /MANDATORY_NOTIFICATION_MUST_BE_IMMEDIATE/);
  assert.equal((await saveNotificationPreference(REQUESTER, "communication.security-advisories", "Immediate")).mandatory, true);
  assert.equal((await saveNotificationPreference(REQUESTER, "release.published", "Weekly")).cadence, "Weekly", "the rule is about communications: other events keep their digests");
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
    // The resolver gives an address that belongs to several organisations to the first row it meets, so the rows must come in a fixed order.
    assert.match(calls.find((c) => /FROM dbo\.Memberships/.test(c.text))!.text, /ORDER BY m\.organization_id,\s*u\.email\s*$/, "members come in organisation, then address, order");
    assert.match(calls.find((c) => /FROM dbo\.CommunicationContacts/.test(c.text))!.text, /ORDER BY c\.organization_id,\s*c\.email\s*$/, "contacts come in organisation, then address, order");
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
async function makeRelease(
  ideas: Array<{ title: string; description: string }>,
  { publish = true, documentationUrl, title = "DataCentral 3.1.0", summary = "Summary.", availability = "General availability" }: { publish?: boolean; documentationUrl?: string; title?: string; summary?: string; availability?: string } = {},
) {
  const ideaIds: string[] = [];
  for (const idea of ideas)
    ideaIds.push((await createIdea(PM, { internalTitle: idea.title, internalDescription: idea.description, area: "Administration" } as never)).id);
  const release = await createRelease(PM, { title, date: "2026-11-01", summary, availability, ...(documentationUrl ? { documentationUrl } : {}), ideaIds });
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

test("campaigns: only a Draft is editable, only a Draft or a Cancelled campaign that no mail left for is deletable, and a copy is always a fresh Draft", async () => {
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
  // A cancelled campaign that mailed anyone stays: its rows are the record of who was mailed. A real row with the provider (or on its way there) or answered
  // for keeps it; rows that never left (waiting, cancelled, failed, suppressed) and test mails to staff do not.
  const row = (state: DeliveryState, source: "Member" | "Test" = "Member"): DeliveryRecord => ({
    id: crypto.randomUUID(), communicationId: created.id, organizationId: "ORG-001", email: `${state.toLowerCase().replace(" ", "-")}-${source.toLowerCase()}@origo.is`,
    displayName: null, locale: "en", source, state, attemptCount: 1, createdAt: new Date().toISOString(),
  });
  for (const state of ["Processing", "Accepted", "Deferred", "Delivered", "Bounced", "Dropped"] as const) {
    memoryDeliveries().push(row(state));
    await assert.rejects(deleteCommunication(PM, created.id), /INVALID_COMMUNICATION_NOT_DELETABLE/, `${state}: mail has left, or is leaving`);
    assert.deepEqual([memoryCommunications().length, memoryDeliveries().length], [2, 1], `${state}: the campaign and its row are still there`);
    memoryDeliveries().pop();
  }
  for (const [state, source] of [["Queued", "Member"], ["Retry", "Member"], ["Cancelled", "Member"], ["Dead letter", "Member"], ["Suppressed", "Member"], ["Accepted", "Test"], ["Delivered", "Test"]] as const)
    memoryDeliveries().push(row(state, source));
  await deleteCommunication(PM, created.id);
  await deleteCommunication(PM, copy.id);
  assert.deepEqual(memoryCommunications(), []);
  assert.deepEqual(memoryDeliveries(), [], "the rows of the deleted campaign went with it");
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
  const stats = (await getCommunication(PM, third.id)).stats;
  stats.recipients = 99;
  stats.byOrganization.push({ organizationId: "ORG-001", recipients: 1, delivered: 1, opened: 1 });
  const fresh = (await getCommunication(CONTRIBUTOR, first.id)).stats;
  assert.deepEqual([fresh.recipients, fresh.byOrganization], [0, []], "every call gets its own stats object, not a shared one");
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

type PrefilledBody = { title: string; subtitle: string; intro: string; sections: Array<{ heading: string; body: string }>; cta?: unknown };
const prefilledBody = async (releaseId: string) => (await prefillFromRelease(PM, releaseId)).content.body.en as PrefilledBody;

test("campaigns: a pre-fill always fits the content schema: long texts end in an ellipsis inside their limit and only the first eight ideas become sections", async () => {
  const ideas = Array.from({ length: 9 }, (_, i) => ({ title: `Idea ${i + 1} ${"t".repeat(190)}`, description: `Idea ${i + 1} ${"d".repeat(2500)}` }));
  const title = `DataCentral ${"V".repeat(188)}`; // 200 characters, the most a release title can have
  const summary = `${"S".repeat(4999)}.`; // 5000 characters, the most a release summary can have
  const release = await makeRelease(ideas, { title, summary });
  const prefill = await prefillFromRelease(PM, release.id);
  const parsed = communicationInputSchema.safeParse({ ...prefill, audience: { organizations: "all-customers" } });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  const body = prefill.content.body.en as PrefilledBody;
  assert.equal(body.title, `${title.slice(0, 139)}…`);
  assert.equal(body.intro, `${summary.slice(0, 1999)}…`);
  assert.deepEqual(body.sections.map((s) => s.heading.slice(0, 7)), [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `Idea ${n} `), "the first eight ideas, in order; the ninth is dropped");
  assert.ok(body.sections.every((s) => s.heading.length === 120 && s.heading.endsWith("…") && s.body.length === 2000 && s.body.endsWith("…")));
  assert.deepEqual([prefill.title, prefill.content.subject.en], [title, title], "the 200 characters of the title fit the subject and the working title");
  assert.equal(body.subtitle, "General availability");
  const created = await createCommunication(PM, { fromReleaseId: release.id });
  assert.deepEqual([created.releaseId, created.content], [release.id, prefill.content]);
  assert.equal(created.status, "Draft");
  // The single section a release gets when none of its ideas can be found is fitted too.
  const orphan = await createRelease(PM, { title, date: "2026-12-01", summary, availability: "General availability", ideaIds: ["IDEA-9999"] });
  assert.deepEqual((await prefilledBody(orphan.id)).sections, [{ heading: `${title.slice(0, 119)}…`, body: `${summary.slice(0, 1999)}…` }]);
  assert.equal((await createCommunication(PM, { fromReleaseId: orphan.id })).releaseId, orphan.id);
});

test("campaigns: a pre-fill leaves text that fits alone, cuts only past the limit, and cuts cleanly", async () => {
  const ideas = Array.from({ length: 8 }, (_, i) => ({ title: i === 0 ? "h".repeat(120) : `Idea ${i + 1}`, description: i === 0 ? "b".repeat(2000) : "Short." }));
  const exact = await prefilledBody((await makeRelease(ideas, { title: "T".repeat(140), summary: "s".repeat(2000), availability: "A".repeat(200), publish: false })).id);
  assert.deepEqual(
    [exact.title, exact.subtitle, exact.intro, exact.sections.length, exact.sections[0]],
    ["T".repeat(140), "A".repeat(200), "s".repeat(2000), 8, { heading: "h".repeat(120), body: "b".repeat(2000) }], "text at its limit and eight sections are not touched",
  );
  const padded = await makeRelease([{ title: "Admin report", description: "Built-in admin report." }], { summary: "s".repeat(2000) });
  padded.summary = `  ${padded.summary}\n`; // hand-edited data: the schema trims white space before it counts characters, and so does the pre-fill
  assert.equal((await prefilledBody(padded.id)).intro, "s".repeat(2000));
  const over = await prefilledBody((await makeRelease([{ title: "h".repeat(121), description: "b".repeat(2001) }], { title: "T".repeat(141), summary: "s".repeat(2001), publish: false })).id);
  assert.deepEqual([over.title, over.intro, over.sections[0]], [`${"T".repeat(139)}…`, `${"s".repeat(1999)}…`, { heading: `${"h".repeat(119)}…`, body: `${"b".repeat(1999)}…` }], "one character over the limit is cut to the limit");
  const clean = await prefilledBody((await makeRelease([
    { title: `${"x".repeat(118)} yyyyy`, description: "A cut after a space leaves no space before the ellipsis." },
    { title: `${"x".repeat(118)}\u{1F600}\u{1F600}`, description: "A cut inside an emoji drops the emoji." },
  ], { publish: false })).id);
  assert.deepEqual(clean.sections.map((s) => s.heading), [`${"x".repeat(118)}…`, `${"x".repeat(118)}…`]);
});

test("campaigns: a documentation URL the call to action cannot take is left out of the pre-fill instead of failing the draft", async () => {
  const release = await makeRelease([{ title: "Admin report", description: "Built-in admin report." }], { documentationUrl: `https://docs.datacentral.ai/${"a".repeat(2000)}` });
  const prefill = await prefillFromRelease(PM, release.id);
  assert.equal("cta" in (prefill.content.body.en as PrefilledBody), false);
  assert.equal(communicationInputSchema.safeParse({ ...prefill, audience: { organizations: "all-customers" } }).success, true);
  assert.equal((await createCommunication(PM, { fromReleaseId: release.id })).releaseId, release.id);
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

test("campaigns: a draft keeps its own copy of the content and audience it was created or edited with", async () => {
  const content = structuredClone(productUpdate);
  const audience = { ...draftInput.audience, organizations: ["ORG-001"] };
  const created = await createCommunication(PM, { ...draftInput, content, audience });
  content.body.en.sections[0].heading = "Changed by the caller afterwards";
  audience.organizations.push("ORG-002");
  const stored = await getCommunication(PM, created.id);
  assert.equal((stored.content.body.en as { sections: Array<{ heading: string }> }).sections[0].heading, "New built-in Admin Report");
  assert.deepEqual(stored.audience.organizations, ["ORG-001"]);
  const edit = structuredClone(productUpdate);
  const editedAudience = { ...draftInput.audience, organizations: ["ORG-003"] };
  await updateCommunication(PM, created.id, { ...draftInput, content: edit, audience: editedAudience });
  edit.body.en.sections[0].heading = "Changed by the caller afterwards";
  editedAudience.organizations.push("ORG-004");
  const edited = await getCommunication(PM, created.id);
  assert.equal((edited.content.body.en as { sections: Array<{ heading: string }> }).sections[0].heading, "New built-in Admin Report");
  assert.deepEqual(edited.audience.organizations, ["ORG-003"]);
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
  await withFakeSql(answers, async (calls, events) => {
    // The statements that read campaigns and their row versions, from `since` on: the unit of work they ran in is what keeps a row and its version together.
    const reads = (since: number) => calls.slice(since).filter((c) => /dbo\.Communications|OPENJSON/.test(c.text) && !/CommunicationDeliveries/.test(c.text));
    const list = await listCommunications(CONTRIBUTOR);
    assert.deepEqual(list.map((c) => [c.id, c.title, c.status, c.version, c.scheduledAt, c.releaseId]), [
      ["COM-008", "Newer", "Draft", "0x0000000000000008", undefined, undefined],
      ["COM-007", "3.0.0 announcement", "Scheduled", "0x0000000000000007", "2026-10-14T09:00:00.0000000", "REL-3"],
    ]);
    assert.deepEqual(list[0].content, productUpdate, "the JSON columns come back as objects");
    assert.deepEqual(list[0].audience, draftInput.audience);
    assert.match(calls.find((c) => /ORDER BY/.test(c.text))!.text, /WHERE c\.deleted_at IS NULL ORDER BY c\.created_at DESC/);
    assert.deepEqual(events, ["begin", "commit"], "the rows and their versions are read in one unit of work, so a write in between cannot pair old content with a new version");
    assert.deepEqual(reads(0).map((c) => c.inTransaction), [true, true], "both the list and the version read ran inside it");

    const seenGet = calls.length;
    const item = await getCommunication(CONTRIBUTOR, "COM-007");
    assert.deepEqual([item.id, item.createdBy, item.createdAt, item.updatedAt, item.recipientCount, item.version], ["COM-007", "Product Manager", "2026-10-13T09:00:00.0000000", "2026-10-13T09:30:00.0000000", 0, "0x0000000000000007"]);
    assert.match(calls.find((c) => /WHERE c\.public_id=@id/.test(c.text))!.text, /WHERE c\.public_id=@id AND c\.deleted_at IS NULL$/, "a deleted campaign is gone");
    assert.deepEqual(events, ["begin", "commit", "begin", "commit"], "a get is one unit of work as well");
    assert.deepEqual(reads(seenGet).map((c) => c.inTransaction), [true, true], "the row and its version ran inside it");
    const statsReads = calls.slice(seenGet).filter((c) => /FROM dbo\.CommunicationDeliveries/.test(c.text));
    assert.deepEqual(statsReads.map((c) => [c.inTransaction, c.inputs.id]), [[false, "COM-007"]], "the stats are counted from the delivery rows once, after the unit of work and outside it");
    assert.match(statsReads[0].text, /d\.source<>'Test'/, "test sends are not part of the stats");
    assert.equal((await previewCommunication(CONTRIBUTOR, "COM-007", "is")).subject, "DataCentral 3.0.0 (is)");
    await assert.rejects(getCommunication(CONTRIBUTOR, "COM-404"), /NOT_FOUND/, "a well-formed id that is not there");
    assert.deepEqual(events.slice(4), ["begin", "rollback"], "a read that finds nothing rolls its unit of work back");

    const seen = calls.length;
    for (const id of ["", "COM-", "com-7", "REL-7", "COM-7; DROP TABLE dbo.Communications", `COM-${"9".repeat(40)}`]) {
      await assert.rejects(getCommunication(CONTRIBUTOR, id), /NOT_FOUND/, id);
      await assert.rejects(previewCommunication(CONTRIBUTOR, id, "en"), /NOT_FOUND/, id);
      await assert.rejects(findCommunicationUuid(id), /NOT_FOUND/, id);
    }
    assert.deepEqual(calls.slice(seen).filter((c) => /dbo\.Communications/.test(c.text)), [], "no statement about campaigns was sent");
    assert.equal(events.length, 6, "and no transaction was opened for an id that cannot exist");
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

test("campaigns, SQL: a delete is one guarded soft-delete with its audit row, and only a Draft, or a Cancelled campaign that no mail left for, is touched", async () => {
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
  // Mail that left keeps a cancelled campaign: it is asked of the rows (real rows that are with the provider or answered for), only for a Cancelled
  // campaign, before any unit of work is opened; a Draft is never asked.
  const mailedRows = /SELECT TOP \(1\) 1 mailed FROM dbo\.CommunicationDeliveries d/;
  await withFakeSql([[mailedRows, { recordset: [{ mailed: 1 }] }], ...softDelete, ...sqlCampaign("COM-007", { status: "Cancelled" })], async (calls, events) => {
    await assert.rejects(deleteCommunication(PM, "COM-007"), /INVALID_COMMUNICATION_NOT_DELETABLE/);
    assert.deepEqual([sqlWrites(calls).length, events], [0, []], "nothing is written and no unit of work is opened");
    const asked = calls.filter((c) => mailedRows.test(c.text));
    assert.equal(asked.length, 1);
    assert.equal(asked[0].inputs.id, "COM-007");
    assert.equal(asked[0].text.replace(/\s+/g, " ").trim(),
      "SELECT TOP (1) 1 mailed FROM dbo.CommunicationDeliveries d JOIN dbo.Communications c ON c.id=d.communication_id WHERE c.public_id=@id AND d.source<>'Test' AND d.state IN ('Processing','Accepted','Deferred','Delivered','Bounced','Dropped')",
      "real rows only, in the states of mail that is leaving or has been answered for");
  });
  await withFakeSql([...softDelete, ...sqlCampaign("COM-007", { status: "Cancelled" })], async (calls) => {
    await deleteCommunication(PM, "COM-007");
    assert.equal(calls.filter((c) => mailedRows.test(c.text)).length, 1, "a cancelled campaign is asked once, and none of its rows is mail that left: it is deleted");
  });
  await withFakeSql([...softDelete, ...sqlCampaign("COM-007", { status: "Draft" })], async (calls) => {
    await deleteCommunication(PM, "COM-007");
    assert.equal(calls.filter((c) => mailedRows.test(c.text)).length, 0, "a draft has sent nothing, so nothing is asked");
  });
  await withFakeSql([[/^\s*UPDATE dbo\.Communications/, { rowsAffected: [0] }], ...sqlCampaign("COM-007")], async (calls, events) => {
    await assert.rejects(deleteCommunication(PM, "COM-007"), /NOT_FOUND/, "the UPDATE matched no row");
    assert.deepEqual(events, ["begin", "rollback"]);
    assert.equal(sqlWrites(calls).filter((c) => /AuditEvents/.test(c.text)).length, 0);
  });
});

test("campaigns, demo data: with SQL configured and the demo-data switch on, campaigns, versions, releases and ideas live in memory together; accounts and settings still use SQL", async () => {
  await withFakeSql([], async (calls, events) => {
    globalThis.pulseShowDemoData = true;
    try {
      const created = await createCommunication(PM, draftInput);
      assert.deepEqual([created.id, created.version], ["COM-001", "1"], "a memory campaign with a memory version");
      await updateCommunication(PM, created.id, { ...draftInput, title: "Renamed" });
      const copy = await duplicateCommunication(PM, created.id);
      assert.deepEqual((await listCommunications(CONTRIBUTOR)).map((c) => [c.id, c.title]), [[copy.id, "Renamed (copy)"], [created.id, "Renamed"]]);
      assert.equal((await getCommunication(CONTRIBUTOR, created.id)).title, "Renamed");
      assert.equal((await previewCommunication(CONTRIBUTOR, created.id, "en")).subject, "DataCentral 3.0.0");
      const release = await makeRelease([{ title: "Admin report", description: "Built-in admin report." }]);
      assert.equal((await createCommunication(PM, { fromReleaseId: release.id })).releaseId, release.id);
      await deleteCommunication(PM, copy.id);
      await assert.rejects(getCommunication(PM, copy.id), /NOT_FOUND/);
      assert.deepEqual(memoryCommunications().map((c) => c.id), [created.id, "COM-003"], "the campaigns are in the memory store");
      assert.deepEqual(calls.filter((c) => /dbo\.(Communications|AuditEvents|Releases|Ideas)|OPENJSON/.test(c.text)), [], "no campaign, release, idea, audit or version statement reached SQL");
      assert.deepEqual(events, [], "and no transaction was opened");
      assert.ok(calls.some((c) => /FROM dbo\.Users WHERE id=@id/.test(c.text)), "who the caller is was still asked of SQL");
      assert.ok(calls.some((c) => /FROM dbo\.Settings/.test(c.text)), "and so were the settings the preview reads");
    } finally {
      globalThis.pulseShowDemoData = undefined;
    }
  });
});

// Module scope: the worker, webhook and route tests of later tasks reuse both.
/** Sending on: the provider key is set and the settings are enabled with safe mode off, which the schema allows only with an unsubscribe group (42). */
async function enableSending() {
  process.env.SENDGRID_API_KEY = "SG.test";
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai", unsubscribeGroupId: 42, safeMode: { enabled: false, allowedDomains: [] } });
}
/** Two organisations and four people in the audience of "all customers": bjarki, jon (ORG-001 members), anna (ORG-002 member), and cio (an Icelandic contact of ORG-001). */
async function seedAudience() {
  await seedOrganizations();
  globalThis.pulseMemoryUsers!.push(
    { id: "22222222-2222-4222-8222-222222222222", name: "Jón", email: "jon@origo.is", status: "Active", authentication: "OTP", memberships: [{ companyId: "ORG-001", role: "Requester" }] },
    { id: "66666666-6666-4666-8666-666666666666", name: "Anna", email: "anna@advania.is", status: "Active", authentication: "OTP", memberships: [{ companyId: "ORG-002", role: "Company admin" }] },
  );
  await saveContact(PM, { organizationId: "ORG-001", email: "cio@origo.is", displayName: "CIO", locale: "is", topics: ["product-updates"] });
}

test("send: requires enabled settings and a provider, freezes the audience and moves to Sending", async () => {
  await seedAudience();
  const created = await createCommunication(PM, draftInput);
  await assert.rejects(sendCommunication(PM, created.id, {}), /INVALID_COMMUNICATIONS_DISABLED/);
  await enableSending();
  const estimate = await audienceEstimate(PM, created.id);
  assert.equal(estimate.sendable, 4); // bjarki + jon (ORG-001 members), cio (contact, is), anna (ORG-002 member)
  const sent = await sendCommunication(PM, created.id, {});
  assert.equal(sent.status, "Sending");
  assert.equal(sent.recipientCount, 4);
  const deliveries = await listDeliveries(CONTRIBUTOR, created.id, { page: 1, pageSize: 50 });
  assert.equal(deliveries.total, 4);
  assert.ok(deliveries.items.every((d) => d.state === "Queued"));
  assert.equal(deliveries.items.find((d) => d.email === "cio@origo.is")?.locale, "is");
  await assert.rejects(updateCommunication(PM, created.id, draftInput), /INVALID_COMMUNICATION_NOT_EDITABLE/);
  await assert.rejects(sendCommunication(PM, created.id, {}), /INVALID_COMMUNICATION_STATE/);
  assert.equal(globalThis.pulseMemoryAudit?.[0]?.action, "communication.sent");
});

test("send: schedule, unschedule and cancel; cancel keeps accepted rows", async () => {
  await seedAudience();
  await enableSending();
  const created = await createCommunication(PM, draftInput);
  await assert.rejects(sendCommunication(PM, created.id, { scheduledAt: new Date(Date.now() - 1000).toISOString() }), /INVALID_SCHEDULE_TIME/);
  const scheduled = await sendCommunication(PM, created.id, { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(scheduled.status, "Scheduled");
  assert.equal((await listDeliveries(PM, created.id, { page: 1, pageSize: 10 })).total, 0, "audience freezes at promotion, not at scheduling");
  const back = await cancelCommunication(PM, created.id, "unschedule");
  assert.equal(back.status, "Draft");
  const sending = await sendCommunication(PM, created.id, {});
  const store = getDeliveryStore();
  const batch = await store.claimBatch(1);
  await store.markAccepted([batch!.deliveries[0].id], "msg-1", new Date());
  const cancelled = await cancelCommunication(PM, created.id, "cancel");
  assert.equal(cancelled.status, "Cancelled");
  const rows = (await listDeliveries(PM, sending.id, { page: 1, pageSize: 10 })).items;
  assert.equal(rows.filter((r) => r.state === "Accepted").length, 1);
  assert.equal(rows.filter((r) => r.state === "Cancelled").length, 3);
});

test("send: an all-suppressed audience completes immediately as Sent with zero recipients", async () => {
  await seedAudience();
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai" }); // safe mode on, datacentral.ai only
  process.env.SENDGRID_API_KEY = "SG.test";
  const created = await createCommunication(PM, draftInput);
  const sent = await sendCommunication(PM, created.id, {});
  assert.equal(sent.status, "Sent");
  assert.equal(sent.recipientCount, 0);
  const stats = await communicationStats(created.id);
  assert.equal(stats.suppressed, 4);
});

test("send: an audience nobody belongs to is refused and leaves the draft as it was", async () => {
  await seedAudience();
  await enableSending();
  const created = await createCommunication(PM, { ...draftInput, audience: { ...draftInput.audience, organizations: [] } });
  await assert.rejects(sendCommunication(PM, created.id, {}), /INVALID_AUDIENCE_EMPTY/);
  const kept = await getCommunication(PM, created.id);
  assert.deepEqual([kept.status, kept.recipientCount, kept.startedAt, kept.completedAt], ["Draft", 0, undefined, undefined]);
  assert.equal(memoryDeliveries().length, 0, "no delivery row was written");
  assert.equal(globalThis.pulseMemoryAudit?.some((a) => a.action === "communication.sent"), false, "and nothing was audited as sent");
  assert.equal((await audienceEstimate(PM, created.id)).total, 0, "the estimate reports the empty audience instead of refusing it");
});

test("test send: queues Test rows for the caller and internal extras only; never counts in stats", async () => {
  await seedAudience();
  await enableSending();
  const created = await createCommunication(PM, draftInput);
  const result = await testSendCommunication(PM, created.id, ["staff@datacentral.ai", "jon@origo.is"]);
  assert.equal(result.queued, 1, "jon@origo.is is not internal staff; only the caller is queued");
  const batch = await getDeliveryStore().claimBatch(10);
  assert.equal(batch?.deliveries[0].source, "Test");
  assert.equal((await communicationStats(created.id)).recipients, 0);
});

test("deliveries: retry dead letters requeues only Dead letter rows", async () => {
  await seedAudience();
  await enableSending();
  const created = await createCommunication(PM, draftInput);
  await sendCommunication(PM, created.id, {});
  const store = getDeliveryStore();
  const batch = await store.claimBatch(10);
  await store.markFailed(batch!.deliveries.map((d) => d.id), "HTTP_400", null);
  assert.equal((await communicationStats(created.id)).deadLettered, 3);
  assert.deepEqual(await retryDeadLetters(PM, created.id), { requeued: 3, reopened: false });
  assert.equal((await communicationStats(created.id)).queued, 4, "3 requeued English rows plus the never-claimed Icelandic row");
});

test("freeze: only a Draft or Scheduled campaign freezes, and what it writes is the whole send", async () => {
  await seedAudience();
  await enableSending();
  const created = await createCommunication(PM, draftInput);
  const breakdown = await freezeAudience(created.id, PM.id);
  assert.deepEqual([breakdown.total, breakdown.sendable], [4, 4]);
  await assert.rejects(freezeAudience(created.id, PM.id), /INVALID_COMMUNICATION_STATE/, "a frozen campaign cannot freeze twice");
  await assert.rejects(freezeAudience("COM-404", PM.id), /NOT_FOUND/);
  assert.equal(memoryDeliveries().length, 4, "the second freeze added nothing");
});

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
/** How many of the rows are in each state. */
const countByState = (rows: Array<{ state: string }>) => rows.reduce<Record<string, number>>((counts, row) => ({ ...counts, [row.state]: (counts[row.state] ?? 0) + 1 }), {});
/** A delivery row for the stores to chew on; `extra` overrides any field. */
const deliveryRow = (communicationId: string, state: DeliveryRecord["state"], extra: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  id: crypto.randomUUID(), communicationId, organizationId: "ORG-001", email: `${crypto.randomUUID()}@origo.is`, displayName: null, locale: "en",
  source: "Member", state, attemptCount: 0, createdAt: new Date().toISOString(), ...extra,
});

test("send: only the publish roles send, cancel, test-send and retry, any internal role reads, and an unknown or malformed id is NOT_FOUND", async () => {
  await seedAudience();
  const created = await createCommunication(PM, draftInput);
  await assert.rejects(sendCommunication(CONTRIBUTOR, created.id, {}), /FORBIDDEN/, "the role is checked before the settings, so the answer says nothing about them");
  await assert.rejects(testSendCommunication(CONTRIBUTOR, created.id, []), /FORBIDDEN/);
  await enableSending();
  await assert.rejects(sendCommunication(CONTRIBUTOR, created.id, {}), /FORBIDDEN/);
  await assert.rejects(sendCommunication(CONTRIBUTOR, "COM-404", {}), /FORBIDDEN/, "the role is checked before the campaign is looked up");
  await assert.rejects(cancelCommunication(CONTRIBUTOR, created.id, "cancel"), /FORBIDDEN/);
  await assert.rejects(cancelCommunication(CONTRIBUTOR, created.id, "unschedule"), /FORBIDDEN/);
  await assert.rejects(testSendCommunication(CONTRIBUTOR, created.id, []), /FORBIDDEN/);
  await assert.rejects(retryDeadLetters(CONTRIBUTOR, created.id), /FORBIDDEN/);
  for (const customer of [COMPANY_ADMIN, REQUESTER]) {
    await assert.rejects(audienceEstimate(customer, created.id), /FORBIDDEN/);
    await assert.rejects(listDeliveries(customer, created.id, {}), /FORBIDDEN/);
    await assert.rejects(sendCommunication(customer, created.id, {}), /FORBIDDEN/);
  }
  assert.deepEqual([(await getCommunication(PM, created.id)).status, memoryDeliveries().length], ["Draft", 0], "the refused calls changed nothing");
  assert.equal((await audienceEstimate(CONTRIBUTOR, created.id)).sendable, 4, "any internal role reads the estimate");
  assert.equal((await listDeliveries(CONTRIBUTOR, created.id, {})).total, 0, "and the deliveries");
  for (const id of ["COM-404", "REL-1", "", "COM-1; DROP TABLE dbo.Communications"]) {
    await assert.rejects(audienceEstimate(PM, id), /NOT_FOUND/, id);
    await assert.rejects(sendCommunication(PM, id, {}), /NOT_FOUND/, id);
    await assert.rejects(sendCommunication(PM, id, { scheduledAt: inAnHour() }), /NOT_FOUND/, id);
    await assert.rejects(cancelCommunication(PM, id, "cancel"), /NOT_FOUND/, id);
    await assert.rejects(cancelCommunication(PM, id, "unschedule"), /NOT_FOUND/, id);
    await assert.rejects(testSendCommunication(PM, id, []), /NOT_FOUND/, id);
    await assert.rejects(listDeliveries(PM, id, {}), /NOT_FOUND/, id);
    await assert.rejects(retryDeadLetters(PM, id), /NOT_FOUND/, id);
  }
  assert.equal((await sendCommunication(ADMIN, created.id, {})).status, "Sending", "a System admin sends too");
});

test("send: sending needs the master switch and a provider key; the estimate, cancelling and retrying do not", async () => {
  await seedAudience();
  const created = await createCommunication(PM, draftInput);
  process.env.SENDGRID_API_KEY = "SG.test";
  await assert.rejects(sendCommunication(PM, created.id, {}), /INVALID_COMMUNICATIONS_DISABLED/, "the key alone is not enough");
  await assert.rejects(sendCommunication(PM, created.id, { scheduledAt: inAnHour() }), /INVALID_COMMUNICATIONS_DISABLED/, "scheduling is a send too");
  await assert.rejects(testSendCommunication(PM, created.id, []), /INVALID_COMMUNICATIONS_DISABLED/);
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai", unsubscribeGroupId: 42, safeMode: { enabled: false, allowedDomains: [] } });
  for (const key of [undefined, "", "   "]) {
    if (key === undefined) delete process.env.SENDGRID_API_KEY; else process.env.SENDGRID_API_KEY = key;
    await assert.rejects(sendCommunication(PM, created.id, {}), /INVALID_EMAIL_PROVIDER_CONFIGURATION/, `enabled settings and key ${JSON.stringify(key)}`);
    await assert.rejects(testSendCommunication(PM, created.id, []), /INVALID_EMAIL_PROVIDER_CONFIGURATION/);
  }
  assert.equal(memoryDeliveries().length, 0);
  assert.equal(globalThis.pulseMemoryAudit?.some((a) => /^communication\.(sent|scheduled|test-sent)$/.test(a.action)), false, "nothing was audited as sent");
  assert.equal((await audienceEstimate(PM, created.id)).sendable, 4, "the estimate needs neither the switch nor the key");
  assert.deepEqual(await retryDeadLetters(PM, created.id), { requeued: 0, reopened: false }, "nor does a retry");
  memoryCommunications()[0].status = "Scheduled";
  assert.equal((await cancelCommunication(PM, created.id, "unschedule")).status, "Draft", "nor does taking a campaign back");
});

test("send: a schedule must lie between a minute and 30 days ahead, an empty one is not 'now', scheduling again moves the time, and sending now freezes at once", async () => {
  await seedAudience();
  await enableSending();
  const created = await createCommunication(PM, draftInput);
  const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
  for (const bad of [ahead(-1000), ahead(30_000), ahead(31 * 86_400_000), "tomorrow", ""])
    await assert.rejects(sendCommunication(PM, created.id, { scheduledAt: bad }), /INVALID_SCHEDULE_TIME/, `${JSON.stringify(bad)} is not a time to send at (and must not be taken for a send now)`);
  assert.deepEqual([(await getCommunication(PM, created.id)).status, memoryDeliveries().length], ["Draft", 0], "a refused schedule changes nothing");
  const first = ahead(2 * 60_000);
  const scheduled = await sendCommunication(PM, created.id, { scheduledAt: first });
  assert.deepEqual([scheduled.status, scheduled.scheduledAt, scheduled.recipientCount], ["Scheduled", first, 0]);
  const later = ahead(29 * 86_400_000);
  const moved = await sendCommunication(PM, created.id, { scheduledAt: later });
  assert.deepEqual([moved.status, moved.scheduledAt], ["Scheduled", later], "scheduling again moves the time");
  await assert.rejects(updateCommunication(PM, created.id, draftInput), /INVALID_COMMUNICATION_NOT_EDITABLE/, "a scheduled campaign is no longer editable");
  const now = await sendCommunication(PM, created.id, {});
  assert.deepEqual([now.status, now.recipientCount, now.scheduledAt], ["Sending", 4, undefined], "sending a scheduled campaign now drops the schedule");
  assert.ok(now.startedAt && !now.completedAt);
  assert.deepEqual(globalThis.pulseMemoryAudit?.filter((a) => a.entityType === "Communication").map((a) => a.action).reverse(), ["communication.created", "communication.scheduled", "communication.scheduled", "communication.sent"]);
  assert.deepEqual(globalThis.pulseMemoryAudit?.find((a) => a.action === "communication.scheduled")?.after, { scheduledAt: later });
});

test("freeze: suppressed addresses are stored with their reason and not counted, and an audience over the limit writes nothing", async () => {
  await seedAudience();
  await enableSending();
  await suppressAddress("jon@origo.is", "Bounced", "Webhook");
  const created = await createCommunication(PM, draftInput);
  const sent = await sendCommunication(PM, created.id, {});
  assert.deepEqual([sent.status, sent.recipientCount], ["Sending", 3]);
  const rows = memoryDeliveries();
  assert.equal(rows.length, 4, "the suppressed address keeps a row so the review can show it");
  const jon = rows.find((d) => d.email === "jon@origo.is")!;
  assert.deepEqual([jon.state, jon.suppressedReason, jon.source, jon.organizationId], ["Suppressed", "Bounced", "Member", "ORG-001"]);
  assert.deepEqual(rows.filter((d) => d.state === "Queued").map((d) => d.email).sort(), ["anna@advania.is", "bjarki@uidata.com", "cio@origo.is"]);
  assert.ok(rows.every((d) => d.communicationId === created.id && d.attemptCount === 0 && d.createdAt), "every row belongs to the campaign and has not been tried");
  assert.deepEqual(globalThis.pulseMemoryAudit?.[0]?.after, { recipients: 3, suppressed: { Bounced: 1 } }, "the audit row carries counts, never addresses");
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai", unsubscribeGroupId: 42, safeMode: { enabled: false, allowedDomains: [] }, maxRecipientsPerCampaign: 2 });
  const big = await createCommunication(PM, draftInput);
  await assert.rejects(sendCommunication(PM, big.id, {}), /INVALID_AUDIENCE_TOO_LARGE/);
  assert.deepEqual([(await getCommunication(PM, big.id)).status, memoryDeliveries().filter((d) => d.communicationId === big.id).length], ["Draft", 0], "an audience over the limit writes nothing");
});

test("freeze: a scheduled campaign freezes with whatever the audience is then and drops its schedule", async () => {
  await seedAudience();
  await enableSending();
  const created = await createCommunication(PM, draftInput);
  await sendCommunication(PM, created.id, { scheduledAt: inAnHour() });
  globalThis.pulseMemoryUsers!.push({ id: "77777777-7777-4777-8777-777777777777", name: "Late", email: "late@origo.is", status: "Active", authentication: "OTP", memberships: [{ companyId: "ORG-001", role: "Viewer" }] });
  const breakdown = await freezeAudience(created.id, null); // what the worker does when the time comes
  assert.deepEqual([breakdown.total, breakdown.sendable], [5, 5], "a person who joined after the campaign was scheduled is included");
  const frozen = await getCommunication(PM, created.id);
  assert.deepEqual([frozen.status, frozen.recipientCount, frozen.scheduledAt], ["Sending", 5, undefined]);
  assert.ok(frozen.startedAt && !frozen.completedAt);
  const nobody = await createCommunication(PM, { ...draftInput, audience: { ...draftInput.audience, organizations: [] } });
  assert.deepEqual((await freezeAudience(nobody.id, null)).total, 0, "an empty audience is refused only when a person sends now");
  const empty = await getCommunication(PM, nobody.id);
  assert.deepEqual([empty.status, empty.recipientCount, Boolean(empty.completedAt)], ["Sent", 0, true]);
});

test("freeze: the worker's freeze takes a campaign only while it is still scheduled for a time that has come", async () => {
  await seedAudience();
  await enableSending();
  const unscheduled = await createCommunication(PM, draftInput); // a Draft again: its owner took it back after the worker had listed it
  const moved = await createCommunication(PM, draftInput);
  const due = await createCommunication(PM, draftInput);
  await sendCommunication(PM, moved.id, { scheduledAt: inAnHour() }); // and this one was moved to a later time
  await sendCommunication(PM, due.id, { scheduledAt: inAnHour() });
  const now = new Date();
  await assert.rejects(freezeAudience(unscheduled.id, null, now, { onlyIfDue: true }), /INVALID_COMMUNICATION_STATE/, "not sent, although a Draft can be sent by a person");
  await assert.rejects(freezeAudience(moved.id, null, now, { onlyIfDue: true }), /INVALID_COMMUNICATION_STATE/, "not sent before its new time");
  assert.deepEqual([memoryDeliveries().length, (await getCommunication(PM, unscheduled.id)).status, (await getCommunication(PM, moved.id)).status], [0, "Draft", "Scheduled"], "nothing was written");
  memoryCommunications().find((c) => c.id === due.id)!.scheduledAt = new Date(now.getTime() - 1000).toISOString();
  assert.equal((await freezeAudience(due.id, null, now, { onlyIfDue: true })).sendable, 4);
  assert.equal((await freezeAudience(unscheduled.id, PM.id, now)).sendable, 4, "a person can still send the draft");
});

test("cancel: unschedule takes back a Scheduled campaign only, cancel stops a Scheduled or Sending one and leaves what is in flight, and both are audited", async () => {
  await seedAudience();
  await enableSending();
  const draft = await createCommunication(PM, draftInput);
  await assert.rejects(cancelCommunication(PM, draft.id, "cancel"), /INVALID_COMMUNICATION_STATE/, "a draft has nothing to cancel");
  await assert.rejects(cancelCommunication(PM, draft.id, "unschedule"), /INVALID_COMMUNICATION_STATE/);
  await sendCommunication(PM, draft.id, { scheduledAt: inAnHour() });
  const back = await cancelCommunication(PM, draft.id, "unschedule");
  assert.deepEqual([back.status, back.scheduledAt], ["Draft", undefined]);
  assert.equal((await updateCommunication(PM, draft.id, { ...draftInput, title: "Edited again" })).title, "Edited again", "a draft taken back is editable again");
  await sendCommunication(PM, draft.id, { scheduledAt: inAnHour() });
  const early = await cancelCommunication(PM, draft.id, "cancel");
  assert.deepEqual([early.status, Boolean(early.cancelledAt), memoryDeliveries().length], ["Cancelled", true, 0], "a scheduled campaign has no deliveries yet");
  await assert.rejects(cancelCommunication(PM, draft.id, "cancel"), /INVALID_COMMUNICATION_STATE/, "it is cancelled already");
  await assert.rejects(cancelCommunication(PM, draft.id, "unschedule"), /INVALID_COMMUNICATION_STATE/);

  const second = await createCommunication(PM, draftInput);
  await sendCommunication(PM, second.id, {});
  await assert.rejects(cancelCommunication(PM, second.id, "unschedule"), /INVALID_COMMUNICATION_STATE/, "a campaign that is sending cannot go back to a draft");
  const store = getDeliveryStore();
  await store.claimBatch(3); // three rows are with the provider now
  await store.markFailed([memoryDeliveries().find((d) => d.email === "anna@advania.is")!.id], "HTTP_429", new Date(Date.now() + 3_600_000)); // one of them failed and is waiting to be retried
  const cancelled = await cancelCommunication(PM, second.id, "cancel");
  assert.deepEqual([cancelled.status, Boolean(cancelled.cancelledAt)], ["Cancelled", true]);
  const rows = (await listDeliveries(PM, second.id, {})).items;
  assert.deepEqual(countByState(rows), { Processing: 2, Cancelled: 2 }, "the waiting rows (Queued, Retry) are cancelled, the ones in flight are left");
  assert.equal(rows.find((d) => d.state === "Cancelled" && d.email === "anna@advania.is")?.nextAttemptAt, null, "a cancelled row has no next attempt");
  assert.equal(await store.claimBatch(10), null, "nothing of a cancelled campaign is claimed");
  await assert.rejects(cancelCommunication(PM, second.id, "cancel"), /INVALID_COMMUNICATION_STATE/);
  const sent = await createCommunication(PM, draftInput);
  await sendCommunication(PM, sent.id, {});
  memoryCommunications().find((c) => c.id === sent.id)!.status = "Sent";
  await assert.rejects(cancelCommunication(PM, sent.id, "cancel"), /INVALID_COMMUNICATION_STATE/, "a campaign that has been sent cannot be cancelled");
  const audit = (globalThis.pulseMemoryAudit ?? []).filter((a) => a.entityType === "Communication" && /scheduled|cancelled/.test(a.action)).reverse();
  assert.deepEqual(audit.map((a) => [a.action, a.entityId]), [
    ["communication.scheduled", draft.id], ["communication.unscheduled", draft.id], ["communication.scheduled", draft.id],
    ["communication.cancelled", draft.id], ["communication.cancelled", second.id],
  ]);
  assert.deepEqual([audit[1].after, audit[3].after, audit[4].after], [{}, { cancelledDeliveries: 0 }, { cancelledDeliveries: 2 }], "a cancel records how many deliveries it stopped");
});

test("promote: due scheduled campaigns freeze at that moment and start sending; the ones not due stay scheduled", async () => {
  await seedAudience();
  await enableSending();
  const due = await createCommunication(PM, draftInput);
  const later = await createCommunication(PM, draftInput);
  const nobody = await createCommunication(PM, { ...draftInput, audience: { ...draftInput.audience, organizations: [] } });
  for (const campaign of [due, later, nobody]) await sendCommunication(PM, campaign.id, { scheduledAt: inAnHour() });
  globalThis.pulseMemoryUsers!.push({ id: "77777777-7777-4777-8777-777777777777", name: "Late", email: "late@origo.is", status: "Active", authentication: "OTP", memberships: [{ companyId: "ORG-001", role: "Viewer" }] });
  for (const campaign of memoryCommunications().filter((c) => c.id !== later.id)) campaign.scheduledAt = new Date(Date.now() - 60_000).toISOString();
  const store = getDeliveryStore();
  assert.deepEqual(await store.promoteScheduled(new Date()), [due.id, nobody.id]);
  const started = await getCommunication(PM, due.id);
  assert.deepEqual([started.status, started.recipientCount, started.scheduledAt], ["Sending", 5, undefined], "the audience is the one at promotion, not at scheduling");
  assert.equal((await listDeliveries(PM, due.id, {})).total, 5);
  const emptied = await getCommunication(PM, nobody.id);
  assert.deepEqual([emptied.status, emptied.recipientCount], ["Sent", 0], "an audience that turned out empty completes instead of stopping the worker");
  assert.deepEqual([(await getCommunication(PM, later.id)).status, (await listDeliveries(PM, later.id, {})).total], ["Scheduled", 0]);
  assert.deepEqual(await store.promoteScheduled(new Date()), [], "promoting again does nothing");
});

test("promote: a campaign that cannot be promoted stays scheduled and does not stop the others; only its id and a code are logged", async () => {
  await seedAudience();
  process.env.SENDGRID_API_KEY = "SG.test";
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai", unsubscribeGroupId: 42, safeMode: { enabled: false, allowedDomains: [] }, maxRecipientsPerCampaign: 2 });
  const big = await createCommunication(PM, draftInput); // four recipients, over the limit of two
  const small = await createCommunication(PM, { ...draftInput, audience: { ...draftInput.audience, organizations: ["ORG-002"] } }); // anna only
  for (const campaign of [big, small]) await sendCommunication(PM, campaign.id, { scheduledAt: inAnHour() });
  for (const campaign of memoryCommunications()) campaign.scheduledAt = new Date(Date.now() - 60_000).toISOString();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  let promoted: string[];
  try {
    promoted = await getDeliveryStore().promoteScheduled(new Date());
  } finally {
    console.error = original;
  }
  assert.deepEqual(promoted, [small.id]);
  assert.deepEqual([(await getCommunication(PM, big.id)).status, (await getCommunication(PM, small.id)).status], ["Scheduled", "Sending"]);
  assert.equal(memoryDeliveries().filter((d) => d.communicationId === big.id).length, 0, "the campaign that failed wrote nothing");
  assert.equal(logged.length, 1);
  assert.deepEqual((({ level, communicationId, code }) => ({ level, communicationId, code }))(JSON.parse(logged[0])), { level: "error", communicationId: big.id, code: "INVALID_AUDIENCE_TOO_LARGE" });
  assert.ok(!/@/.test(logged[0]), "no address in the log");
});

test("claim: one campaign and one locale per batch, oldest first, never more than asked for, each row once, and the content is a copy", async () => {
  await seedAudience();
  await enableSending();
  const created = await createCommunication(PM, draftInput);
  await sendCommunication(PM, created.id, {});
  const store = getDeliveryStore();
  assert.equal(await store.claimBatch(0), null);
  assert.equal(await store.claimBatch(-1), null);
  assert.equal(countByState(memoryDeliveries()).Queued, 4, "asking for nothing claims nothing");
  const first = (await store.claimBatch(2))!;
  assert.deepEqual([first.communicationId, first.locale, first.templateKey, first.topic], [created.id, "en", "product-update", "product-updates"]);
  assert.deepEqual(first.deliveries.map((d) => [d.email, d.displayName, d.source, d.attemptCount]), [["bjarki@uidata.com", "Bjarki Kristjánsson", "Member", 1], ["jon@origo.is", "Jón", "Member", 1]]);
  first.content.subject.en = "Changed by the worker";
  assert.equal((await getCommunication(PM, created.id)).content.subject.en, "DataCentral 3.0.0", "the batch holds a copy of the campaign's content");
  assert.deepEqual(countByState(memoryDeliveries()), { Processing: 2, Queued: 2 });
  const second = (await store.claimBatch(500))!;
  assert.deepEqual([second.locale, second.deliveries.map((d) => d.email)], ["en", ["anna@advania.is"]], "the rest of the English rows");
  const third = (await store.claimBatch(500))!;
  assert.deepEqual([third.locale, third.deliveries.map((d) => d.email)], ["is", ["cio@origo.is"]], "then the Icelandic one, in a batch of its own");
  assert.equal(await store.claimBatch(500), null, "every row is claimed once");
  const other = await createCommunication(PM, draftInput);
  memoryDeliveries().push(deliveryRow(other.id, "Queued")); // a draft's real row: not claimable, only a Sending campaign's rows are
  assert.equal(await store.claimBatch(500), null, "a row of a campaign that is not sending is not claimed");
});

test("claim: a row waits for its next attempt, a failed row is retried or dead-lettered, and an accepted row keeps the provider's id", async () => {
  await seedAudience();
  await enableSending();
  const created = await createCommunication(PM, draftInput);
  await sendCommunication(PM, created.id, {});
  const store = getDeliveryStore();
  const [a, b, c] = (await store.claimBatch(3))!.deliveries.map((d) => d.id);
  const soon = new Date(Date.now() + 3_600_000);
  await store.markFailed([a], "HTTP_429", soon);
  await store.markFailed([b], "HTTP_400", null);
  await store.markAccepted([c], "msg-9", new Date("2026-10-14T10:00:00Z"));
  const row = (id: string) => memoryDeliveries().find((d) => d.id === id)!;
  assert.deepEqual([row(a).state, row(a).nextAttemptAt, row(a).lastErrorCode], ["Retry", soon.toISOString(), "HTTP_429"]);
  assert.deepEqual([row(b).state, row(b).nextAttemptAt, row(b).lastErrorCode], ["Dead letter", null, "HTTP_400"]);
  assert.deepEqual([row(c).state, row(c).providerMessageId, row(c).acceptedAt, row(c).nextAttemptAt, row(c).lastErrorCode], ["Accepted", "msg-9", "2026-10-14T10:00:00.000Z", null, null]);
  const next = (await store.claimBatch(10))!;
  assert.deepEqual([next.locale, next.deliveries.map((d) => d.email)], ["is", ["cio@origo.is"]], "only the Icelandic row is due; the Retry row waits for its time");
  assert.equal(await store.claimBatch(10), null);
  row(a).nextAttemptAt = new Date(Date.now() - 1000).toISOString();
  const again = (await store.claimBatch(10))!;
  assert.deepEqual(again.deliveries.map((d) => [d.id, d.attemptCount]), [[a, 2]], "once due it is claimed again, and the attempt is counted");
  await store.markAccepted([a], null, new Date());
  assert.deepEqual([row(a).state, row(a).providerMessageId, row(a).nextAttemptAt, row(a).lastErrorCode], ["Accepted", null, null, null], "accepting clears the error and the next attempt");
});

test("worker store: accepted rows are counted per UTC day, and a campaign completes once nothing of it is open", async () => {
  await seedAudience();
  await enableSending();
  const first = await createCommunication(PM, draftInput);
  const second = await createCommunication(PM, draftInput);
  const draft = await createCommunication(PM, draftInput);
  await sendCommunication(PM, first.id, {});
  await sendCommunication(PM, second.id, {});
  await testSendCommunication(PM, first.id, []);
  const store = getDeliveryStore();
  const real = (id: string) => memoryDeliveries().filter((d) => d.communicationId === id && d.source !== "Test");
  assert.deepEqual(await store.completeCampaigns(new Date()), [], "both campaigns still have open rows");
  const [one, two, three, four] = real(first.id).map((d) => d.id);
  await store.claimBatch(10); // the worker holds the first campaign's four real rows (three English, one Icelandic): only a row it holds becomes Accepted
  await store.claimBatch(10);
  await store.markAccepted([one, two], "msg-a", new Date("2026-10-14T00:00:01Z"));
  await store.markAccepted([three, four], "msg-b", new Date("2026-10-13T23:59:59Z"));
  assert.equal(await store.acceptedToday(new Date("2026-10-14T12:00:00Z")), 2);
  assert.equal(await store.acceptedToday(new Date("2026-10-13T08:00:00Z")), 2);
  assert.equal(await store.acceptedToday(new Date("2026-10-15T12:00:00Z")), 0);
  assert.deepEqual(await store.completeCampaigns(new Date("2026-10-14T13:00:00Z")), [first.id], "a Test row still queued does not hold the campaign open");
  await store.markAccepted([memoryDeliveries().find((d) => d.source === "Test")!.id], "msg-t", new Date("2026-10-14T01:00:00Z"));
  assert.equal(await store.acceptedToday(new Date("2026-10-14T12:00:00Z")), 3, "a test mail counts against the day's cap");
  const done = memoryCommunications().find((c) => c.id === first.id)!;
  assert.deepEqual([done.status, done.completedAt, done.updatedAt], ["Sent", "2026-10-14T13:00:00.000Z", "2026-10-14T13:00:00.000Z"]);
  assert.equal(memoryCommunications().find((c) => c.id === second.id)!.status, "Sending");
  assert.equal(memoryCommunications().find((c) => c.id === draft.id)!.status, "Draft");
  const [s1, s2, s3, s4] = real(second.id).map((d) => d.id);
  await store.claimBatch(10); // the worker takes the second campaign's rows (three English, one Icelandic): only a row it holds is settled by a failure
  await store.claimBatch(10);
  await store.markFailed([s1, s2, s3], "HTTP_400", null);
  await store.markFailed([s4], "HTTP_429", new Date(Date.now() + 3_600_000));
  assert.deepEqual(await store.completeCampaigns(new Date()), [], "a row waiting for a retry keeps the campaign open");
  memoryDeliveries().find((d) => d.id === s4)!.nextAttemptAt = new Date(Date.now() - 1000).toISOString(); // its time has come: the worker takes it again, and the provider refuses it for good
  await store.claimBatch(10);
  await store.markFailed([s4], "HTTP_400", null);
  assert.deepEqual(await store.completeCampaigns(new Date()), [second.id], "dead letters are finished");
  assert.deepEqual(await store.completeCampaigns(new Date()), [], "a campaign completes once");
});

test("stats: every state is counted once, test rows and other campaigns are left out, and the companies come in a fixed order", async () => {
  const created = await createCommunication(PM, draftInput);
  const other = await createCommunication(PM, draftInput);
  const at = "2026-10-14T09:00:00.000Z";
  memoryDeliveries().push(
    deliveryRow(created.id, "Processing", { organizationId: "ORG-002" }),
    deliveryRow(created.id, "Queued"), deliveryRow(created.id, "Retry"),
    deliveryRow(created.id, "Accepted"), deliveryRow(created.id, "Accepted", { organizationId: "ORG-002", openedAt: at }),
    deliveryRow(created.id, "Deferred", { organizationId: "ORG-002" }),
    deliveryRow(created.id, "Delivered", { openedAt: at, clickedAt: at }), deliveryRow(created.id, "Delivered", { organizationId: "ORG-002", openedAt: at }),
    deliveryRow(created.id, "Bounced", { organizationId: "ORG-002" }), deliveryRow(created.id, "Dropped"), deliveryRow(created.id, "Dead letter"),
    deliveryRow(created.id, "Suppressed", { suppressedReason: "SafeMode" }), deliveryRow(created.id, "Cancelled", { organizationId: "ORG-002" }),
    deliveryRow(created.id, "Delivered", { source: "Test", organizationId: null, openedAt: at, clickedAt: at }),
    deliveryRow(other.id, "Delivered", { openedAt: at }),
  );
  const expected = {
    recipients: 12, queued: 3, accepted: 5, delivered: 2, bounced: 1, dropped: 1, deadLettered: 1, suppressed: 1, cancelled: 1, opened: 3, clicked: 1,
    byOrganization: [
      { organizationId: "ORG-001", recipients: 6, delivered: 1, opened: 1 }, // the suppressed row is not a recipient
      { organizationId: "ORG-002", recipients: 6, delivered: 1, opened: 2 }, // although the first row counted belongs to this company
    ],
  };
  assert.deepEqual(await communicationStats(created.id), expected);
  assert.deepEqual((await getCommunication(CONTRIBUTOR, created.id)).stats, expected, "the campaign carries the same stats");
  assert.deepEqual((await communicationStats(other.id)).delivered, 1);
  assert.deepEqual((await communicationStats("COM-404")).byOrganization, [], "a campaign without rows has empty stats");
});

test("deliveries: the list filters by state and company, pages, clamps its paging inputs and hands out copies", async () => {
  await seedAudience();
  await enableSending();
  const created = await createCommunication(PM, draftInput);
  await sendCommunication(PM, created.id, {});
  const page1 = await listDeliveries(PM, created.id, { page: 1, pageSize: 3 });
  assert.deepEqual([page1.items.map((d) => d.email), page1.total], [["bjarki@uidata.com", "jon@origo.is", "anna@advania.is"], 4]);
  const page2 = await listDeliveries(PM, created.id, { page: 2, pageSize: 3 });
  assert.deepEqual([page2.items.map((d) => d.email), page2.total], [["cio@origo.is"], 4]);
  assert.deepEqual((await listDeliveries(PM, created.id, { page: 3, pageSize: 3 })).items, [], "past the end there is nothing, and the total still says 4");
  assert.deepEqual((await listDeliveries(PM, created.id, { organizationId: "ORG-002" })).items.map((d) => d.email), ["anna@advania.is"]);
  assert.deepEqual((await listDeliveries(PM, created.id, { organizationId: "ORG-001", state: "Queued" })).items.map((d) => d.email), ["bjarki@uidata.com", "jon@origo.is", "cio@origo.is"]);
  assert.equal((await listDeliveries(PM, created.id, { state: "Queued" })).total, 4);
  assert.equal((await listDeliveries(PM, created.id, { state: "Dead letter" })).total, 0);
  for (const page of [0, -3, Number.NaN, 1.5, undefined])
    assert.equal((await listDeliveries(PM, created.id, { page })).items.length, 4, `page ${page} is the first page`);
  const huge = await listDeliveries(PM, created.id, { page: 1e12 });
  assert.deepEqual([huge.items.length, huge.total], [0, 4], "a huge page is a page past the end, not an error");
  for (const [pageSize, expected] of [[0, 4], [-5, 1], [1000, 4], [2.9, 2], [undefined, 4]] as const)
    assert.equal((await listDeliveries(PM, created.id, { pageSize })).items.length, expected, `page size ${pageSize}`);
  assert.deepEqual((await listDeliveries(PM, created.id, { page: 2, pageSize: 2.9 })).items.map((d) => d.email), ["anna@advania.is", "cio@origo.is"], "a fractional page size pages by whole rows");
  const crowded = await createCommunication(PM, draftInput);
  memoryDeliveries().push(...Array.from({ length: 300 }, () => deliveryRow(crowded.id, "Queued")));
  const sizes = [];
  for (const filter of [{}, { pageSize: 1000 }, { pageSize: 50 }, { page: 2, pageSize: 250 }]) sizes.push((await listDeliveries(PM, crowded.id, filter)).items.length);
  assert.deepEqual(sizes, [100, 250, 50, 50], "a page is 100 rows unless asked otherwise, and never more than 250");
  const listed = await listDeliveries(PM, created.id, { pageSize: 1 });
  listed.items[0].email = "tampered@example.com";
  assert.equal(memoryDeliveries()[0].email, "bjarki@uidata.com", "the list hands out copies, never the store");
});

test("test send: staff addresses are queued once and normalised, a repeat queues the same rows again, and the audit row holds a count only", async () => {
  await seedAudience();
  users().push(
    { id: "88888888-8888-4888-8888-888888888888", name: "Staff", email: "Staff@DataCentral.ai", status: "Active", authentication: "Entra ID", memberships: [{ companyId: "ORG-INTERNAL", role: "Internal contributor" }] },
    { id: "99999999-9999-4999-8999-999999999999", name: "Gone", email: "gone@datacentral.ai", status: "Suspended", authentication: "Entra ID", memberships: [{ companyId: "ORG-INTERNAL", role: "Product manager" }] },
  );
  await enableSending();
  const created = await createCommunication(PM, draftInput);
  const first = await testSendCommunication(PM, created.id, [" STAFF@datacentral.ai ", "PM@datacentral.ai", "gone@datacentral.ai", "jon@origo.is"]);
  assert.deepEqual(first, { queued: 2 }, "the caller and the one staff address, however it is spelled; a suspended account and a customer are left out");
  const tests = () => memoryDeliveries().filter((d) => d.source === "Test");
  assert.deepEqual(tests().map((d) => [d.email, d.displayName, d.organizationId, d.locale, d.state, d.communicationId]), [
    ["pm@datacentral.ai", "Product Manager", null, "en", "Queued", created.id],
    ["staff@datacentral.ai", "staff@datacentral.ai", null, "en", "Queued", created.id],
  ]);
  const store = getDeliveryStore();
  const batch = (await store.claimBatch(10))!;
  assert.deepEqual([batch.deliveries.map((d) => d.source), batch.communicationId], [["Test", "Test"], created.id]);
  await store.markAccepted(batch.deliveries.map((d) => d.id), "msg-t", new Date());
  assert.deepEqual(await testSendCommunication(PM, created.id, ["staff@datacentral.ai", "STAFF@DataCentral.ai"]), { queued: 2 }, "an address named twice is queued once");
  assert.equal(tests().length, 2, "a second test send queues the same two rows again instead of adding rows");
  assert.deepEqual(tests().map((d) => [d.state, d.attemptCount, d.nextAttemptAt, d.lastErrorCode]), [["Queued", 0, null, null], ["Queued", 0, null, null]]);
  assert.deepEqual(await communicationStats(created.id), { recipients: 0, queued: 0, accepted: 0, delivered: 0, bounced: 0, dropped: 0, deadLettered: 0, suppressed: 0, cancelled: 0, opened: 0, clicked: 0, byOrganization: [] }, "test rows never count in the stats");
  assert.equal((await getCommunication(PM, created.id)).status, "Draft", "a test send leaves the campaign alone");
  const audit = (globalThis.pulseMemoryAudit ?? []).filter((a) => a.action === "communication.test-sent");
  assert.deepEqual(audit.map((a) => [a.entityId, a.after]), [[created.id, { queued: 2 }], [created.id, { queued: 2 }]]);
});

test("deliveries: retrying requeues the dead letters of that campaign only, starts their attempts over and is audited with a count", async () => {
  await seedAudience();
  await enableSending();
  const first = await createCommunication(PM, draftInput);
  const second = await createCommunication(PM, draftInput);
  await sendCommunication(PM, first.id, {});
  await sendCommunication(PM, second.id, {});
  const store = getDeliveryStore();
  const dead: string[] = [];
  for (let claimed = await store.claimBatch(10); claimed; claimed = await store.claimBatch(10)) dead.push(...claimed.deliveries.map((d) => d.id)); // every row of both campaigns is with the worker
  await store.markFailed(dead, "HTTP_400", null); // and is a dead letter
  const keep = memoryDeliveries().find((d) => d.communicationId === first.id && d.email === "cio@origo.is")!;
  Object.assign(keep, { state: "Bounced", attemptCount: 3 }); // and one of them is not
  Object.assign(memoryDeliveries().find((d) => d.communicationId === first.id && d.email === "jon@origo.is")!, { attemptCount: 5, nextAttemptAt: new Date().toISOString() });
  assert.deepEqual(await retryDeadLetters(PM, first.id), { requeued: 3, reopened: false });
  const rows = (await listDeliveries(PM, first.id, {})).items;
  assert.deepEqual(rows.map((d) => [d.email, d.state, d.attemptCount, d.nextAttemptAt, d.lastErrorCode]), [
    ["bjarki@uidata.com", "Queued", 0, null, null], ["jon@origo.is", "Queued", 0, null, null], ["anna@advania.is", "Queued", 0, null, null], ["cio@origo.is", "Bounced", 3, null, "HTTP_400"],
  ]);
  assert.deepEqual(countByState((await listDeliveries(PM, second.id, {})).items), { "Dead letter": 4 }, "the other campaign's dead letters are left alone");
  assert.deepEqual(await retryDeadLetters(PM, first.id), { requeued: 0, reopened: false }, "nothing is left to requeue");
  const retried = (globalThis.pulseMemoryAudit ?? []).filter((a) => a.action === "communication.deliveries.retried").reverse();
  assert.deepEqual(retried.map((a) => [a.entityId, a.after, a.before]), [[first.id, { requeued: 3 }, undefined], [first.id, { requeued: 0 }, undefined]], "the campaign was Sending and stays so: only the count is recorded");
  assert.equal((await getCommunication(PM, first.id)).status, "Sending");
});

test("deliveries: retrying the dead letters of a campaign that has completed reopens it, the worker claims the rows again and completes it once they settle", async () => {
  await seedAudience();
  await enableSending();
  const created = await createCommunication(PM, draftInput);
  await sendCommunication(PM, created.id, {});
  const store = getDeliveryStore();
  const ids = [(await store.claimBatch(10))!, (await store.claimBatch(10))!].flatMap((batch) => batch.deliveries.map((d) => d.id)); // the English batch, then the Icelandic one
  assert.equal(ids.length, 4);
  await store.markFailed(ids, "HTTP_400", null); // every row is a dead letter
  const doneAt = new Date("2026-10-14T13:00:00Z");
  assert.deepEqual(await store.completeCampaigns(doneAt), [created.id]);
  const completed = await getCommunication(PM, created.id);
  assert.deepEqual([completed.status, completed.completedAt, completed.stats.deadLettered, completed.stats.queued], ["Sent", doneAt.toISOString(), 4, 0]);
  assert.equal(await store.claimBatch(10), null, "nothing of a completed campaign is claimed");

  assert.deepEqual(await retryDeadLetters(PM, created.id), { requeued: 4, reopened: true });
  const reopened = await getCommunication(PM, created.id);
  assert.deepEqual([reopened.status, reopened.completedAt, reopened.startedAt, reopened.recipientCount], ["Sending", undefined, completed.startedAt, 4], "reopened: the completion is undone, the start and the recipient count are kept");
  assert.deepEqual([reopened.stats.queued, reopened.stats.deadLettered], [4, 0]);
  const english = (await store.claimBatch(10))!;
  assert.deepEqual([english.communicationId, english.locale, english.deliveries.map((d) => d.attemptCount)], [created.id, "en", [1, 1, 1]], "the worker claims the retried rows, their attempts started over");
  const icelandic = (await store.claimBatch(10))!;
  assert.deepEqual([icelandic.locale, icelandic.deliveries.map((d) => d.email)], ["is", ["cio@origo.is"]]);
  assert.deepEqual(await store.completeCampaigns(new Date()), [], "not while rows are with the provider");
  assert.equal((await getCommunication(PM, created.id)).status, "Sending");
  await store.markAccepted([...english.deliveries, ...icelandic.deliveries].map((d) => d.id), "msg-2", new Date());
  const finishedAt = new Date("2026-10-14T14:00:00Z");
  assert.deepEqual(await store.completeCampaigns(finishedAt), [created.id], "and completed again once the retried rows have settled");
  const finished = await getCommunication(PM, created.id);
  assert.deepEqual([finished.status, finished.completedAt, finished.startedAt, finished.stats.accepted, finished.stats.deadLettered], ["Sent", finishedAt.toISOString(), completed.startedAt, 4, 0]);
  const audit = (globalThis.pulseMemoryAudit ?? []).filter((a) => a.action === "communication.deliveries.retried");
  assert.deepEqual(audit.map((a) => [a.entityId, a.before, a.after]), [[created.id, { status: "Sent" }, { requeued: 4, status: "Sending" }]], "the audit row records the status change next to the count");
});

test("deliveries: a Test row alone does not reopen a completed campaign, and a cancelled campaign is neither retried nor reopened", async () => {
  await seedAudience();
  await enableSending();
  const store = getDeliveryStore();
  const sent = await createCommunication(PM, draftInput);
  await sendCommunication(PM, sent.id, {});
  const real = [(await store.claimBatch(10))!, (await store.claimBatch(10))!].flatMap((batch) => batch.deliveries.map((d) => d.id));
  await store.markAccepted(real, "msg-1", new Date());
  await testSendCommunication(PM, sent.id, []);
  const testRow = (await store.claimBatch(10))!; // a Test row is claimed whatever its campaign is
  assert.deepEqual(testRow.deliveries.map((d) => d.source), ["Test"]);
  await store.markFailed(testRow.deliveries.map((d) => d.id), "HTTP_400", null); // the test mail dead-letters
  assert.deepEqual(await store.completeCampaigns(new Date()), [sent.id]);
  assert.deepEqual(await retryDeadLetters(PM, sent.id), { requeued: 1, reopened: false });
  assert.equal((await getCommunication(PM, sent.id)).status, "Sent", "a test mail alone does not reopen the campaign");
  const again = (await store.claimBatch(10))!;
  assert.deepEqual([again.communicationId, again.deliveries.map((d) => d.source)], [sent.id, ["Test"]], "but the worker still sends it, as it sends any Test row");
  await store.markAccepted(again.deliveries.map((d) => d.id), "msg-2", new Date());
  assert.deepEqual((globalThis.pulseMemoryAudit ?? []).filter((a) => a.action === "communication.deliveries.retried").map((a) => [a.before, a.after]), [[undefined, { requeued: 1 }]]);
  const leftover = memoryDeliveries().find((d) => d.communicationId === sent.id && d.source !== "Test")!;
  leftover.state = "Queued"; // a real row waiting in a Sent campaign, however it got there: only a requeue reopens a campaign
  assert.deepEqual(await retryDeadLetters(PM, sent.id), { requeued: 0, reopened: false });
  assert.equal((await getCommunication(PM, sent.id)).status, "Sent");
  leftover.state = "Accepted";
  const draft = await createCommunication(PM, draftInput);
  memoryDeliveries().push(deliveryRow(draft.id, "Dead letter")); // however it got there: only a Sent campaign is reopened
  assert.deepEqual(await requeueDeadLetters(draft.id), { requeued: 1, reopened: false });
  assert.equal((await getCommunication(PM, draft.id)).status, "Draft");

  const cancelled = await createCommunication(PM, draftInput);
  await sendCommunication(PM, cancelled.id, {});
  const inFlight = (await store.claimBatch(10))!;
  await cancelCommunication(PM, cancelled.id, "cancel");
  const before = memoryDeliveries().find((d) => d.id === inFlight.deliveries[0].id)!;
  before.state = "Dead letter"; // a dead letter from before the cancel
  await assert.rejects(retryDeadLetters(PM, cancelled.id), /INVALID_COMMUNICATION_STATE/, "a cancelled campaign is not retried");
  assert.deepEqual(await requeueDeadLetters(cancelled.id), { requeued: 0, reopened: false }, "and the store does not requeue into it either (a retry racing the cancel)");
  assert.equal(before.state, "Dead letter");
  assert.equal((await getCommunication(PM, cancelled.id)).status, "Cancelled", "a cancelled campaign stays cancelled");
  assert.equal(await store.claimBatch(10), null, "and none of its rows is sent");
});

test("worker store: a batch that fails after its campaign was cancelled is cancelled with it, whether the failure is retryable or not; a Test row is still retried", async () => {
  await seedAudience();
  await enableSending();
  const store = getDeliveryStore();
  let last = "";
  for (const [label, next] of [["retryable", new Date(Date.now() + 3_600_000)], ["not retryable", null]] as const) {
    const created = await createCommunication(PM, draftInput);
    last = created.id;
    await sendCommunication(PM, created.id, {});
    const batch = (await store.claimBatch(10))!; // the three English rows are with the provider
    assert.equal(batch.communicationId, created.id, label);
    await cancelCommunication(PM, created.id, "cancel"); // the Icelandic row is cancelled now; the three in flight are left alone
    await store.markFailed(batch.deliveries.map((d) => d.id), "HTTP_429", next);
    const rows = (await listDeliveries(PM, created.id, {})).items;
    assert.deepEqual(rows.map((d) => [d.email, d.state, d.nextAttemptAt]), [
      ["bjarki@uidata.com", "Cancelled", null], ["jon@origo.is", "Cancelled", null], ["anna@advania.is", "Cancelled", null], ["cio@origo.is", "Cancelled", null],
    ], `${label}: nothing is left to try again`);
    assert.deepEqual(rows.slice(0, 3).map((d) => d.lastErrorCode), ["HTTP_429", "HTTP_429", "HTTP_429"], `${label}: the code of the failure is kept`);
    const stats = await communicationStats(created.id);
    assert.deepEqual([stats.queued, stats.deadLettered, stats.cancelled, stats.recipients], [0, 0, 4, 4], label);
    assert.equal(await store.claimBatch(10), null, `${label}: and the worker has nothing to claim`);
  }
  await testSendCommunication(PM, last, []); // a test mail of a cancelled campaign is still sent, so it is still retried
  const test = (await store.claimBatch(10))!;
  assert.deepEqual(test.deliveries.map((d) => d.source), ["Test"]);
  const again = new Date(Date.now() + 3_600_000);
  await store.markFailed(test.deliveries.map((d) => d.id), "HTTP_429", again);
  assert.deepEqual(memoryDeliveries().filter((d) => d.source === "Test").map((d) => [d.state, d.nextAttemptAt]), [["Retry", again.toISOString()]]);
});

test("send side: the audit trail records ids and counts only, never an address, a subject or a link", async () => {
  await seedAudience();
  await enableSending();
  const created = await createCommunication(PM, draftInput);
  await sendCommunication(PM, created.id, { scheduledAt: inAnHour() });
  await cancelCommunication(PM, created.id, "unschedule");
  await sendCommunication(PM, created.id, {});
  await testSendCommunication(PM, created.id, ["staff@datacentral.ai"]);
  const store = getDeliveryStore();
  await store.markFailed(((await store.claimBatch(1))!).deliveries.map((d) => d.id), "HTTP_400", null);
  await retryDeadLetters(PM, created.id);
  await cancelCommunication(PM, created.id, "cancel");
  const audit = [...(globalThis.pulseMemoryAudit ?? [])].reverse().filter((a) => a.entityType === "Communication");
  assert.deepEqual(audit.map((a) => [a.action, a.entityId, a.actor]), [
    ["communication.created", created.id, "Product Manager"],
    ["communication.scheduled", created.id, "Product Manager"],
    ["communication.unscheduled", created.id, "Product Manager"],
    ["communication.sent", created.id, "Product Manager"],
    ["communication.test-sent", created.id, "Product Manager"],
    ["communication.deliveries.retried", created.id, "Product Manager"],
    ["communication.cancelled", created.id, "Product Manager"],
  ]);
  const text = JSON.stringify(audit);
  for (const forbidden of ["@", "DataCentral 3.0.0", "New built-in Admin Report", "docs.datacentral.ai"]) assert.ok(!text.includes(forbidden), `the audit trail must not carry: ${forbidden}`);
});

/** Settings as SQL answers them: sending on and safe mode off unless `extra` says otherwise. The provider key comes from the environment. */
const sqlSettings = (extra: Record<string, unknown> = {}): SqlAnswers => [
  [/FROM dbo\.Settings/, { recordset: [{ value: JSON.stringify({ ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai", safeMode: { enabled: false, allowedDomains: [] }, ...extra }) }] }],
];
const sqlMember = (i: number, extra: Record<string, unknown> = {}) => ({
  userId: `AAAAAAAA-0000-4000-8000-${String(i).padStart(12, "0")}`, organizationId: "ORG-001", email: `user${i}@origo.is`, displayName: `User ${i}`, locale: "en", role: "Requester", preference: null, ...extra,
});
/** What SQL answers the audience loader: one Customer organisation, the given members and contacts, nobody suppressed. */
const sqlAudience = (members: Array<Record<string, unknown>>, contacts: Array<Record<string, unknown>> = []): SqlAnswers => [
  [/FROM dbo\.CommunicationSuppressions/, { recordset: [] }],
  [/FROM dbo\.Organizations WHERE status/, { recordset: [{ id: "ORG-001", name: "Origo", type: "Customer", status: "Active", isTest: false, locale: "en" }] }],
  [/FROM dbo\.Memberships m JOIN dbo\.Users u/, { recordset: members }],
  [/FROM dbo\.CommunicationContacts/, { recordset: contacts }],
];
/** The locked read a freeze starts with, for COM-007 in the given state (`extra` overrides any column, e.g. `scheduledAt`). */
const sqlLocked = (status: string, extra: Record<string, unknown> = {}): SqlAnswers => [
  [/UPDLOCK,HOLDLOCK\) WHERE public_id=@id/, (inputs) => ({ recordset: inputs.id === "COM-007" ? [{ id: SQL_UUID, topic: "product-updates", audience: JSON.stringify(draftInput.audience), status, scheduledAt: null, ...extra }] : [] })],
];
const sqlFrozen: SqlAnswers = [
  [/^\s*INSERT dbo\.CommunicationDeliveries/, { rowsAffected: [1] }],
  [/^\s*UPDATE dbo\.Communications SET status=CASE/, { rowsAffected: [1] }],
];

test("send, SQL: a send locks the campaign, writes the audience in batches of 500, moves the campaign and audits it, all in one unit of work", async () => {
  process.env.SENDGRID_API_KEY = "SG.test";
  const members = Array.from({ length: 1100 }, (_, i) => sqlMember(i));
  await withFakeSql([...sqlSettings(), ...sqlAudience(members), ...sqlLocked("Draft"), ...sqlFrozen, ...sqlCampaign("COM-007")], async (calls, events) => {
    const sent = await sendCommunication(PM, "COM-007", {});
    assert.deepEqual([sent.id, sent.version], ["COM-007", "0x0000000000000007"]);
    const writes = sqlWrites(calls);
    assert.equal(writes.length, 5, "three batches of rows, the campaign update and the audit row");
    const [first, second, third, update, audit] = writes;
    assert.deepEqual([first, second, third].map((c) => JSON.parse(String(c.inputs.rows)).length), [500, 500, 100]);
    assert.ok([first, second, third].every((c) => c.inputs.communicationId === SQL_UUID && /^\s*INSERT dbo\.CommunicationDeliveries\(id,communication_id,organization_id,email,display_name,locale,source,user_id,contact_id,state,suppressed_reason\)/.test(c.text)));
    assert.match(first.text, /FROM OPENJSON\(@rows\) WITH \(organizationId nvarchar\(32\),email nvarchar\(320\),displayName nvarchar\(200\),locale nvarchar\(12\),source nvarchar\(16\),userId nvarchar\(36\),contactId nvarchar\(36\),state nvarchar\(32\),suppressedReason nvarchar\(40\)\)/);
    assert.deepEqual(JSON.parse(String(first.inputs.rows))[0], { organizationId: "ORG-001", email: "user0@origo.is", displayName: "User 0", locale: "en", source: "Member", userId: "AAAAAAAA-0000-4000-8000-000000000000", contactId: null, state: "Queued", suppressedReason: null });
    assert.deepEqual([update.inputs.id, update.inputs.sendable, update.inputs.actor], [SQL_UUID, 1100, PM.id]);
    assert.match(update.text, /SET status=CASE WHEN @sendable=0 THEN 'Sent' ELSE 'Sending' END,started_at=SYSUTCDATETIME\(\),\s+completed_at=CASE WHEN @sendable=0 THEN SYSUTCDATETIME\(\) ELSE NULL END,recipient_count=@sendable,sent_by_user_id=COALESCE\(@actor,sent_by_user_id\),scheduled_at=NULL,updated_at=SYSUTCDATETIME\(\) WHERE id=@id$/);
    assert.deepEqual([audit.inputs.action, audit.inputs.entity, audit.inputs.actor, audit.inputs.before], ["communication.sent", SQL_UUID, PM.id, null]);
    assert.deepEqual(JSON.parse(String(audit.inputs.after)), { recipients: 1100, suppressed: {} });
    const lock = calls.find((c) => /UPDLOCK,HOLDLOCK/.test(c.text))!;
    assert.deepEqual([lock.inTransaction, lock.inputs.id, calls.indexOf(lock) < calls.indexOf(first)], [true, "COM-007", true], "the campaign is locked, inside the transaction, before anything is written");
    assert.ok(writes.every((c) => c.inTransaction), "every write ran inside the transaction");
    assert.deepEqual(events, ["begin", "commit"], "one unit of work");
  });
  // Safe mode suppresses everybody: the rows are still written, so the review can show them, and the campaign completes with nobody to send to.
  await withFakeSql([...sqlSettings({ safeMode: { enabled: true, allowedDomains: ["datacentral.ai"] } }), ...sqlAudience([sqlMember(1), sqlMember(2)]), ...sqlLocked("Draft"), ...sqlFrozen, ...sqlCampaign("COM-007")], async (calls) => {
    await sendCommunication(PM, "COM-007", {});
    const [insert, update, audit] = sqlWrites(calls);
    assert.deepEqual(JSON.parse(String(insert.inputs.rows)).map((r: { state: string; suppressedReason: string }) => [r.state, r.suppressedReason]), [["Suppressed", "SafeMode"], ["Suppressed", "SafeMode"]]);
    assert.equal(update.inputs.sendable, 0);
    assert.deepEqual(JSON.parse(String(audit.inputs.after)), { recipients: 0, suppressed: { SafeMode: 2 } });
  });
});

test("send, SQL: a send that cannot go through writes nothing that stays", async () => {
  process.env.SENDGRID_API_KEY = "SG.test";
  const refused = async (answers: SqlAnswers, expected: RegExp, check: (writes: SqlCall[], events: string[]) => void) =>
    withFakeSql([...sqlSettings(), ...answers, ...sqlCampaign("COM-007")], async (calls, events) => {
      await assert.rejects(sendCommunication(PM, "COM-007", {}), expected);
      check(sqlWrites(calls), events);
    });
  await refused([...sqlAudience([sqlMember(1)]), ...sqlLocked("Sending"), ...sqlFrozen], /INVALID_COMMUNICATION_STATE/, (writes, events) =>
    assert.deepEqual([writes.length, events], [0, ["begin", "rollback"]]), // the campaign was sent by somebody else between the read and the lock
  );
  await refused([...sqlAudience([sqlMember(1)]), [/UPDLOCK,HOLDLOCK/, { recordset: [] }], ...sqlFrozen], /NOT_FOUND/, (writes, events) =>
    assert.deepEqual([writes.length, events], [0, ["begin", "rollback"]]), // deleted between the read and the lock
  );
  await refused([...sqlAudience([]), ...sqlLocked("Draft"), ...sqlFrozen], /INVALID_AUDIENCE_EMPTY/, (writes, events) =>
    assert.deepEqual([writes.length, events], [0, ["begin", "rollback"]]), // nobody belongs to the audience: refused before a row is written
  );
  await withFakeSql([...sqlSettings({ maxRecipientsPerCampaign: 2 }), ...sqlAudience([sqlMember(1), sqlMember(2), sqlMember(3)]), ...sqlLocked("Draft"), ...sqlFrozen, ...sqlCampaign("COM-007")], async (calls, events) => {
    await assert.rejects(sendCommunication(PM, "COM-007", {}), /INVALID_AUDIENCE_TOO_LARGE/);
    assert.deepEqual([sqlWrites(calls).length, events], [0, ["begin", "rollback"]]);
  });
  await refused([...sqlAudience([sqlMember(1)]), ...sqlLocked("Draft"), [/^\s*INSERT dbo\.CommunicationDeliveries/, { rowsAffected: [1] }], [/^\s*UPDATE dbo\.Communications SET status=CASE/, { rowsAffected: [0] }]], /NOT_FOUND/, (writes, events) => {
    assert.deepEqual(writes.map((w) => w.text.trim().split(/\s/)[0]), ["INSERT", "UPDATE"], "the rows were written and the campaign update found no row: no audit row, and the rollback takes the rows back");
    assert.deepEqual(events, ["begin", "rollback"]);
  });
  await withFakeSql([...sqlSettings({ enabled: false }), ...sqlCampaign("COM-007")], async (calls, events) => {
    await assert.rejects(sendCommunication(PM, "COM-007", {}), /INVALID_COMMUNICATIONS_DISABLED/);
    assert.deepEqual([calls.filter((c) => /dbo\.Communications\b/.test(c.text)).length, events], [0, []], "switched off: no statement about the campaign, no transaction");
  });
});

test("send, SQL: scheduling is one guarded UPDATE with its audit row and freezes nothing; a refused schedule writes nothing", async () => {
  process.env.SENDGRID_API_KEY = "SG.test";
  const when = new Date(Date.now() + 3_600_000);
  const schedule: SqlAnswers = [[/^\s*UPDATE dbo\.Communications SET status='Scheduled'/, { rowsAffected: [1] }]];
  await withFakeSql([...sqlSettings(), ...schedule, ...sqlCampaign("COM-007")], async (calls, events) => {
    const scheduled = await sendCommunication(PM, "COM-007", { scheduledAt: when.toISOString() });
    assert.deepEqual([scheduled.id, scheduled.version], ["COM-007", "0x0000000000000007"]);
    const [write, audit, ...more] = sqlWrites(calls);
    assert.equal(more.length, 0);
    assert.match(write.text, /SET status='Scheduled',scheduled_at=@when,sent_by_user_id=@actor,updated_by_user_id=@actor,updated_at=SYSUTCDATETIME\(\)\s+WHERE public_id=@id AND status IN \('Draft','Scheduled'\) AND deleted_at IS NULL$/);
    assert.deepEqual([write.inputs.id, (write.inputs.when as Date).toISOString(), write.inputs.actor], ["COM-007", when.toISOString(), PM.id]);
    assert.deepEqual([audit.inputs.action, audit.inputs.entity, audit.inputs.actor], ["communication.scheduled", SQL_UUID, PM.id]);
    assert.deepEqual(JSON.parse(String(audit.inputs.after)), { scheduledAt: when.toISOString() });
    assert.ok(sqlWrites(calls).every((c) => c.inTransaction), "both writes ran inside the transaction");
    assert.deepEqual(events, ["begin", "commit"]);
    assert.equal(calls.some((c) => /CommunicationDeliveries|CommunicationContacts|Memberships m JOIN dbo\.Users/.test(c.text)), false, "no audience is resolved or frozen when a campaign is scheduled");
  });
  await withFakeSql([...sqlSettings(), [/^\s*UPDATE dbo\.Communications SET status='Scheduled'/, { rowsAffected: [0] }], ...sqlCampaign("COM-007")], async (calls, events) => {
    await assert.rejects(sendCommunication(PM, "COM-007", { scheduledAt: when.toISOString() }), /NOT_FOUND/, "a send or cancel won the race: the UPDATE matched no row");
    assert.deepEqual([sqlWrites(calls).filter((c) => /AuditEvents/.test(c.text)).length, events], [0, ["begin", "rollback"]]);
  });
  await withFakeSql([...sqlSettings(), ...schedule, ...sqlCampaign("COM-007")], async (calls, events) => {
    for (const bad of [new Date(Date.now() + 30_000).toISOString(), new Date(Date.now() + 31 * 86_400_000).toISOString(), "tomorrow", ""])
      await assert.rejects(sendCommunication(PM, "COM-007", { scheduledAt: bad }), /INVALID_SCHEDULE_TIME/, JSON.stringify(bad));
    assert.deepEqual([sqlWrites(calls).length, events], [0, []], "a refused schedule writes nothing and opens no transaction");
  });
  await withFakeSql([...sqlSettings(), ...schedule, ...sqlCampaign("COM-007", { status: "Sending" })], async (calls, events) => {
    await assert.rejects(sendCommunication(PM, "COM-007", { scheduledAt: when.toISOString() }), /INVALID_COMMUNICATION_STATE/);
    assert.deepEqual([sqlWrites(calls).length, events], [0, []]);
  });
});

test("cancel, SQL: unscheduling is one guarded UPDATE; cancelling stops the waiting deliveries and the campaign together; both are audited in the same unit of work", async () => {
  await withFakeSql([[/^\s*UPDATE dbo\.Communications SET status='Draft'/, { rowsAffected: [1] }], ...sqlCampaign("COM-007", { status: "Scheduled" })], async (calls, events) => {
    const back = await cancelCommunication(PM, "COM-007", "unschedule");
    assert.deepEqual([back.id, back.version], ["COM-007", "0x0000000000000007"]);
    const [write, audit, ...more] = sqlWrites(calls);
    assert.equal(more.length, 0);
    assert.match(write.text, /SET status='Draft',scheduled_at=NULL,updated_by_user_id=@actor,updated_at=SYSUTCDATETIME\(\) WHERE public_id=@id AND status='Scheduled' AND deleted_at IS NULL$/);
    assert.deepEqual([write.inputs.id, write.inputs.actor], ["COM-007", PM.id]);
    assert.deepEqual([audit.inputs.action, audit.inputs.entity, audit.inputs.after], ["communication.unscheduled", SQL_UUID, "{}"]);
    assert.ok(sqlWrites(calls).every((c) => c.inTransaction));
    assert.deepEqual(events, ["begin", "commit"]);
  });
  const stop: SqlAnswers = [
    [/^\s*UPDATE d SET state='Cancelled'/, { rowsAffected: [3] }],
    [/^\s*UPDATE dbo\.Communications SET status='Cancelled'/, { rowsAffected: [1] }],
  ];
  for (const status of ["Scheduled", "Sending"])
    await withFakeSql([...stop, ...sqlCampaign("COM-007", { status })], async (calls, events) => {
      const cancelled = await cancelCommunication(PM, "COM-007", "cancel");
      assert.equal(cancelled.id, "COM-007", status);
      const [deliveries, campaign, audit, ...more] = sqlWrites(calls);
      assert.equal(more.length, 0, status);
      assert.match(deliveries.text, /^UPDATE d SET state='Cancelled',next_attempt_at=NULL FROM dbo\.CommunicationDeliveries d JOIN dbo\.Communications c ON c\.id=d\.communication_id WHERE c\.public_id=@id AND d\.state IN \('Queued','Retry'\)$/, "only the rows still waiting");
      assert.equal(deliveries.inputs.id, "COM-007");
      assert.match(campaign.text, /^UPDATE dbo\.Communications SET status='Cancelled',cancelled_at=@now,updated_by_user_id=@actor,updated_at=SYSUTCDATETIME\(\) WHERE public_id=@id AND status IN \('Scheduled','Sending'\) AND deleted_at IS NULL$/);
      assert.deepEqual([campaign.inputs.id, campaign.inputs.actor, campaign.inputs.now instanceof Date], ["COM-007", PM.id, true], status);
      assert.deepEqual([audit.inputs.action, audit.inputs.entity], ["communication.cancelled", SQL_UUID]);
      assert.deepEqual(JSON.parse(String(audit.inputs.after)), { cancelledDeliveries: 3 }, status);
      assert.ok(sqlWrites(calls).every((c) => c.inTransaction), `${status}: all three writes ran inside the transaction`);
      assert.deepEqual(events, ["begin", "commit"], status);
    });
  await withFakeSql([[/^\s*UPDATE d SET state='Cancelled'/, { rowsAffected: [3] }], [/^\s*UPDATE dbo\.Communications SET status='Cancelled'/, { rowsAffected: [0] }], ...sqlCampaign("COM-007", { status: "Sending" })], async (calls, events) => {
    await assert.rejects(cancelCommunication(PM, "COM-007", "cancel"), /NOT_FOUND/, "the campaign changed after the read");
    assert.deepEqual([sqlWrites(calls).filter((c) => /AuditEvents/.test(c.text)).length, events], [0, ["begin", "rollback"]], "no audit row, and the rollback takes back the cancelled deliveries");
  });
  await withFakeSql([...stop, [/^\s*UPDATE dbo\.Communications SET status='Draft'/, { rowsAffected: [0] }], ...sqlCampaign("COM-007", { status: "Scheduled" })], async (calls, events) => {
    await assert.rejects(cancelCommunication(PM, "COM-007", "unschedule"), /NOT_FOUND/);
    assert.deepEqual([sqlWrites(calls).filter((c) => /AuditEvents/.test(c.text)).length, events], [0, ["begin", "rollback"]]);
  });
  for (const [mode, status] of [["cancel", "Draft"], ["cancel", "Sent"], ["cancel", "Cancelled"], ["unschedule", "Draft"], ["unschedule", "Sending"]] as const)
    await withFakeSql([...stop, ...sqlCampaign("COM-007", { status })], async (calls, events) => {
      await assert.rejects(cancelCommunication(PM, "COM-007", mode), /INVALID_COMMUNICATION_STATE/, `${mode} on ${status}`);
      assert.deepEqual([sqlWrites(calls).length, events], [0, []], `${mode} on ${status}: nothing is written and no transaction is opened`);
    });
});

test("worker store, SQL: promotion freezes each due campaign in a unit of work of its own, skips one that is no longer due and logs one that fails by its code only", async () => {
  process.env.SENDGRID_API_KEY = "SG.test";
  const now = new Date("2026-10-14T09:00:00Z");
  const due = new Date("2026-10-14T08:59:00Z");
  const locked: SqlAnswers = [[/UPDLOCK,HOLDLOCK\) WHERE public_id=@id/, (inputs) => {
    const row = { id: SQL_UUID, topic: "product-updates", audience: JSON.stringify(draftInput.audience) };
    if (inputs.id === "COM-007") return { recordset: [{ ...row, status: "Scheduled", scheduledAt: due }] };
    if (inputs.id === "COM-008") return { recordset: [{ ...row, status: "Scheduled", scheduledAt: new Date("2026-10-14T15:00:00Z") }] }; // moved to a later time
    if (inputs.id === "COM-009") return { recordset: [{ ...row, status: "Draft", scheduledAt: null }] }; // unscheduled
    throw new Error("Violation of UNIQUE KEY constraint 'UQ_CommunicationDeliveries_Recipient'. The duplicate key value is (c1, jon@origo.is, Member).");
  }]];
  const answers: SqlAnswers = [
    ...sqlSettings(), ...sqlAudience([sqlMember(1)]), ...locked, ...sqlFrozen,
    [/WHERE status='Scheduled' AND scheduled_at<=@now/, { recordset: [{ id: "COM-007" }, { id: "COM-008" }, { id: "COM-009" }, { id: "COM-010" }] }],
  ];
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    await withFakeSql(answers, async (calls, events) => {
      const promoted = await getDeliveryStore().promoteScheduled(now);
      assert.deepEqual(promoted, ["COM-007"]);
      const dueQuery = calls.find((c) => /WHERE status='Scheduled'/.test(c.text))!;
      assert.match(dueQuery.text, /SELECT public_id id FROM dbo\.Communications WHERE status='Scheduled' AND scheduled_at<=@now AND deleted_at IS NULL ORDER BY scheduled_at$/);
      assert.equal(dueQuery.inputs.now, now);
      assert.deepEqual(events, ["begin", "commit", "begin", "rollback", "begin", "rollback", "begin", "rollback"], "every campaign is frozen in a unit of work of its own, and a failed one is rolled back alone");
      const [insert, update, ...more] = sqlWrites(calls);
      assert.equal(more.length, 0, "only the campaign that was due wrote anything, and the worker writes no audit row");
      assert.deepEqual([JSON.parse(String(insert.inputs.rows)).length, update.inputs.actor, update.inputs.sendable], [1, null, 1], "no person sent it");
    });
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged.map((line) => JSON.parse(line)), [{ level: "error", event: "communications.promote.failed", communicationId: "COM-010", code: "UNEXPECTED" }], "a driver message is never logged, it can quote an address");
});

test("worker store, SQL: claim maps the batch of one campaign and locale; accept, fail, count and complete bind what they say", async () => {
  const batchRow = (n: number, extra: Record<string, unknown>) => ({
    id: `AAAAAAAA-0000-4000-8000-00000000000${n}`, email: `user${n}@origo.is`, displayName: `User ${n}`, source: "Member", attemptCount: n, locale: "is",
    communicationId: "COM-007", templateKey: "product-update", topic: "product-updates", contentJson: JSON.stringify(productUpdate), ...extra,
  });
  const answers: SqlAnswers = [
    [/WITH next_campaign AS/, (inputs) => ({ recordset: inputs.size === 5 ? [] : [batchRow(1, { source: "Contact" }), batchRow(2, { displayName: null, attemptCount: "1" })] })],
    [/SELECT COUNT\(\*\) count FROM dbo\.CommunicationDeliveries/, { recordset: [{ count: "7" }] }],
    [/OUTPUT INSERTED\.public_id id/, { recordset: [{ id: "COM-007" }, { id: "COM-008" }] }],
  ];
  await withFakeSql(answers, async (calls, events) => {
    const store = getDeliveryStore();
    const batch = (await store.claimBatch(2.9))!;
    assert.deepEqual([batch.communicationId, batch.templateKey, batch.topic, batch.locale], ["COM-007", "product-update", "product-updates", "is"]);
    assert.deepEqual(batch.content, productUpdate);
    assert.deepEqual(batch.deliveries, [
      { id: "AAAAAAAA-0000-4000-8000-000000000001", email: "user1@origo.is", displayName: "User 1", source: "Contact", attemptCount: 1 },
      { id: "AAAAAAAA-0000-4000-8000-000000000002", email: "user2@origo.is", displayName: null, source: "Member", attemptCount: 1 },
    ]);
    const claim = calls.find((c) => /WITH next_campaign AS/.test(c.text))!;
    assert.equal(claim.inputs.size, 2, "a fractional size is cut to whole rows");
    assert.match(claim.text, /FROM dbo\.CommunicationDeliveries d WITH \(UPDLOCK,READPAST,ROWLOCK\)/);
    assert.match(claim.text, /AND \(c\.status='Sending' OR d\.source='Test'\)/, "only a sending campaign's rows, and test rows whatever the campaign is");
    assert.match(claim.text, /OUTPUT CAST\(INSERTED\.id AS nvarchar\(36\)\) id,INSERTED\.email,INSERTED\.display_name displayName,INSERTED\.source,INSERTED\.attempt_count attemptCount,INSERTED\.locale,/);
    assert.equal(claim.text.match(/\(c\.status='Sending' OR d\.source='Test'\)/g)?.length, 3, "the gate applies where the campaign is chosen, where the rows are picked and where they are claimed");
    assert.equal(claim.text.match(/JOIN dbo\.Communications c ON c\.id=d\.communication_id AND c\.deleted_at IS NULL/g)?.length, 3, "and in all three places a deleted campaign has no rows to claim, test rows included");
    assert.match(claim.text, /JOIN dbo\.Communications c ON c\.id=d\.communication_id AND c\.deleted_at IS NULL\s+WHERE d\.state IN \('Queued','Retry'\) AND \(c\.status='Sending' OR d\.source='Test'\) AND \(CASE WHEN d\.source='Test' THEN 1 ELSE 0 END\)=\(CASE WHEN q\.source='Test' THEN 1 ELSE 0 END\);\s*$/, "the UPDATE itself claims only rows that are still waiting, of a campaign that is sending (or test rows), and of the kind (Test or real) that was picked");
    assert.equal(claim.inTransaction, false, "READPAST cannot run in a unit of work, which is SERIALIZABLE");
    const seen = calls.length;
    for (const size of [0, -1, Number.NaN, 0.5]) assert.equal(await store.claimBatch(size), null, `size ${size}`);
    assert.equal(calls.length, seen, "asking for no rows sends no statement");
    assert.equal(await store.claimBatch(5), null, "an empty answer is no batch");

    const at = new Date("2026-10-14T09:00:00Z");
    await store.markAccepted(["id-1", "id-2"], "msg-1", at);
    const accept = calls.find((c) => /THEN 'Accepted' ELSE state END/.test(c.text))!;
    assert.deepEqual([JSON.parse(String(accept.inputs.ids)), accept.inputs.message, accept.inputs.now], [["id-1", "id-2"], "msg-1", at]);
    assert.match(accept.text, /^UPDATE dbo\.CommunicationDeliveries SET state=CASE WHEN state='Processing' THEN 'Accepted' ELSE state END,provider_message_id=@message,accepted_at=@now,next_attempt_at=NULL,last_error_code=NULL WHERE id IN \(SELECT TRY_CONVERT\(uniqueidentifier,\[value\]\) FROM OPENJSON\(@ids\)\)$/, "only a row still Processing becomes Accepted (one the webhook has moved keeps its state), and every row named gets the message id and the time");
    await store.markAccepted(["id-3"], null, at);
    assert.equal(calls.filter((c) => /THEN 'Accepted' ELSE state END/.test(c.text)).at(-1)!.inputs.message, null, "a batch can be accepted without a message id");

    const retryAt = new Date("2026-10-14T10:00:00Z");
    await store.markFailed(["id-1"], "HTTP_429", retryAt);
    await store.markFailed(["id-2"], "X".repeat(150), null);
    const [retry, dead] = calls.filter((c) => /^UPDATE d SET state=CASE/.test(c.text));
    assert.deepEqual([retry.inputs.state, retry.inputs.next, retry.inputs.error, JSON.parse(String(retry.inputs.ids))], ["Retry", retryAt, "HTTP_429", ["id-1"]]);
    assert.deepEqual([dead.inputs.state, dead.inputs.next, dead.inputs.error], ["Dead letter", null, "X".repeat(100)], "a dead letter has no next attempt, and the code fits its column");
    assert.match(retry.text, /^UPDATE d SET state=CASE WHEN d\.state<>'Processing' THEN d\.state WHEN c\.status='Cancelled' AND d\.source<>'Test' THEN 'Cancelled' ELSE @state END,\s+next_attempt_at=CASE WHEN d\.state<>'Processing' THEN d\.next_attempt_at WHEN c\.status='Cancelled' AND d\.source<>'Test' THEN NULL ELSE @next END,last_error_code=@error\s+FROM dbo\.CommunicationDeliveries d JOIN dbo\.Communications c WITH \(READCOMMITTEDLOCK\) ON c\.id=d\.communication_id\s+WHERE d\.id IN \(SELECT TRY_CONVERT\(uniqueidentifier,\[value\]\) FROM OPENJSON\(@ids\)\)$/, "only a row still Processing is settled (one the webhook moved on keeps its state and its next attempt, and gets the code): a row of a cancelled campaign is cancelled, whatever the failure was, and a cancel that is committing is waited for; a test row keeps its retry");

    assert.equal(await store.acceptedToday(at), 7);
    const today = calls.find((c) => /SELECT COUNT\(\*\) count/.test(c.text))!;
    assert.equal(today.inputs.day, at);
    assert.match(today.text, /WHERE accepted_at>=@day AND accepted_at<DATEADD\(day,1,@day\)$/);

    assert.deepEqual(await store.completeCampaigns(at), ["COM-007", "COM-008"]);
    const complete = calls.find((c) => /OUTPUT INSERTED\.public_id id/.test(c.text))!;
    assert.equal(complete.inputs.now, at);
    assert.match(complete.text, /UPDATE c SET status='Sent',completed_at=@now,updated_at=@now OUTPUT INSERTED\.public_id id FROM dbo\.Communications c\s+WHERE c\.status='Sending' AND NOT EXISTS \(SELECT 1 FROM dbo\.CommunicationDeliveries d WITH \(READCOMMITTEDLOCK\) WHERE d\.communication_id=c\.id AND d\.source<>'Test' AND d\.state IN \('Queued','Retry','Processing'\)\)$/, "the rows are read with locks, so a retry that is committing is waited for under read-committed snapshot");
    assert.deepEqual(events, [], "the worker's statements run on their own, each one atomic, in no unit of work");
  });
});

test("deliveries, SQL: stats are counted from the rows, the list pages and maps them, a test send merges its rows and a retry requeues, each audited in one unit of work", async () => {
  process.env.SENDGRID_API_KEY = "SG.test";
  const opened = new Date("2026-10-14T09:05:00Z");
  const row = {
    id: "AAAAAAAA-0000-4000-8000-000000000001", communicationId: "COM-007", organizationId: "ORG-001", email: "jon@origo.is", displayName: "Jón", locale: "is", source: "Member",
    userId: "BBBBBBBB-0000-4000-8000-000000000001", contactId: null, state: "Retry", suppressedReason: null, attemptCount: 2, nextAttemptAt: "2026-10-14T10:00:00.0000000", providerMessageId: null,
    lastEvent: null, lastEventAt: null, openedAt: null, clickedAt: null, lastErrorCode: "HTTP_429", createdAt: "2026-10-14T09:00:00.0000000", acceptedAt: null,
  };
  const answers: SqlAnswers = [
    ...sqlSettings(),
    [/SELECT COUNT\(\*\) total/, { recordset: [{ total: "120" }] }],
    [/OFFSET @offset ROWS/, { recordset: [row] }],
    [/SELECT d\.organization_id organizationId,d\.state/, { recordset: [
      { organizationId: "ORG-002", state: "Dead letter", openedAt: null, clickedAt: null },
      { organizationId: "ORG-001", state: "Delivered", openedAt: opened, clickedAt: opened },
      { organizationId: "ORG-001", state: "Suppressed", openedAt: null, clickedAt: null },
    ] }],
    [/SELECT DISTINCT u\.email/, { recordset: [{ email: "Staff@DataCentral.ai" }] }],
    [/^\s*MERGE dbo\.CommunicationDeliveries/, { rowsAffected: [2] }],
    [/^\s*UPDATE d SET state='Queued'/, { rowsAffected: [3] }],
    ...sqlCampaign("COM-007"),
  ];
  await withFakeSql(answers, async (calls, events) => {
    const item = await getCommunication(CONTRIBUTOR, "COM-007");
    assert.deepEqual(item.stats, {
      recipients: 2, queued: 0, accepted: 1, delivered: 1, bounced: 0, dropped: 0, deadLettered: 1, suppressed: 1, cancelled: 0, opened: 1, clicked: 1,
      byOrganization: [{ organizationId: "ORG-001", recipients: 1, delivered: 1, opened: 1 }, { organizationId: "ORG-002", recipients: 1, delivered: 0, opened: 0 }],
    });

    const listed = await listDeliveries(CONTRIBUTOR, "COM-007", { state: "Retry", organizationId: "ORG-001", page: 3, pageSize: 40 });
    assert.equal(listed.total, 120);
    assert.deepEqual(listed.items, [row]);
    const page = calls.find((c) => /OFFSET @offset ROWS/.test(c.text))!;
    const count = calls.find((c) => /SELECT COUNT\(\*\) total/.test(c.text))!;
    assert.deepEqual([page.inputs.id, page.inputs.state, page.inputs.org, page.inputs.offset, page.inputs.pageSize], ["COM-007", "Retry", "ORG-001", 80, 40]);
    assert.deepEqual([count.inputs.id, count.inputs.state, count.inputs.org], ["COM-007", "Retry", "ORG-001"]);
    assert.match(page.text, /WHERE c\.public_id=@id AND \(@state IS NULL OR d\.state=@state\) AND \(@org IS NULL OR d\.organization_id=@org\) ORDER BY d\.created_at,d\.email,d\.source OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY$/);
    assert.match(page.text, /CONVERT\(nvarchar\(33\),d\.next_attempt_at,127\) nextAttemptAt/, "timestamps come out in the format the campaigns use");
    await listDeliveries(CONTRIBUTOR, "COM-007", {});
    const unfiltered = calls.filter((c) => /OFFSET @offset ROWS/.test(c.text)).at(-1)!;
    assert.deepEqual([unfiltered.inputs.state, unfiltered.inputs.org, unfiltered.inputs.offset, unfiltered.inputs.pageSize], [null, null, 0, 100], "no filter means no filter, and the first page of 100");
    await listDeliveries(CONTRIBUTOR, "COM-007", { page: 1e12, pageSize: 250 });
    const hugePage = calls.filter((c) => /OFFSET @offset ROWS/.test(c.text)).at(-1)!;
    assert.deepEqual([hugePage.inputs.offset, hugePage.inputs.pageSize], [99_999 * 250, 250], "a huge page is cut to page 100000, so the offset always fits an int");
    const seen = calls.length;
    assert.deepEqual(await listDeliveries(CONTRIBUTOR, "COM-007", { state: "x".repeat(40) }), { items: [], total: 0 });
    assert.deepEqual(await listDeliveries(CONTRIBUTOR, "COM-007", { organizationId: "O".repeat(33) }), { items: [], total: 0 });
    assert.equal(calls.slice(seen).filter((c) => /CommunicationDeliveries/.test(c.text)).length, 0, "a value longer than its column matches nothing and never reaches the driver");

    const before = events.length;
    assert.deepEqual(await testSendCommunication(PM, "COM-007", ["staff@datacentral.ai", "other@origo.is"]), { queued: 2 });
    const staffRead = calls.find((c) => /SELECT DISTINCT u\.email/.test(c.text))!;
    assert.match(staffRead.text, /JOIN dbo\.Organizations o ON o\.id=m\.organization_id AND o\.type='Internal' WHERE u\.status='Active'$/);
    assert.equal(staffRead.inTransaction, false, "who is staff is read before the unit of work");
    const merge = calls.find((c) => /^\s*MERGE/.test(c.text))!;
    assert.equal(merge.inputs.id, "COM-007");
    assert.deepEqual(JSON.parse(String(merge.inputs.rows)), [
      { email: "pm@datacentral.ai", displayName: "Product Manager", locale: "en" },
      { email: "staff@datacentral.ai", displayName: "staff@datacentral.ai", locale: "en" },
    ]);
    assert.match(merge.text, /MERGE dbo\.CommunicationDeliveries WITH \(HOLDLOCK\) target/);
    assert.match(merge.text, /CROSS JOIN OPENJSON\(@rows\) WITH \(email nvarchar\(320\),displayName nvarchar\(200\),locale nvarchar\(12\)\) r\s+WHERE c\.public_id=@id AND c\.deleted_at IS NULL\) incoming/);
    assert.match(merge.text, /ON target\.communication_id=incoming\.communicationId AND target\.email=incoming\.email AND target\.source='Test'/);
    assert.match(merge.text, /WHEN MATCHED THEN UPDATE SET state='Queued',attempt_count=0,next_attempt_at=NULL,last_error_code=NULL/);
    assert.match(merge.text, /WHEN NOT MATCHED THEN INSERT\(id,communication_id,organization_id,email,display_name,locale,source,state\)\s+VALUES\(NEWID\(\),incoming\.communicationId,NULL,incoming\.email,incoming\.displayName,incoming\.locale,'Test','Queued'\);$/);
    const testAudit = sqlWrites(calls).filter((c) => /AuditEvents/.test(c.text)).at(-1)!;
    assert.deepEqual([testAudit.inputs.action, testAudit.inputs.entity, JSON.parse(String(testAudit.inputs.after))], ["communication.test-sent", SQL_UUID, { queued: 2 }]);
    assert.ok(merge.inTransaction && testAudit.inTransaction);
    assert.deepEqual(events.slice(before), ["begin", "commit"], "the rows and their audit row share a unit of work");

    const beforeRetry = events.length;
    assert.deepEqual(await retryDeadLetters(PM, "COM-007"), { requeued: 3, reopened: false });
    const requeue = calls.find((c) => /^\s*UPDATE d SET state='Queued'/.test(c.text))!;
    assert.match(requeue.text, /^UPDATE d SET state='Queued',attempt_count=0,next_attempt_at=NULL,last_error_code=NULL FROM dbo\.CommunicationDeliveries d JOIN dbo\.Communications c ON c\.id=d\.communication_id WHERE c\.public_id=@id AND c\.status<>'Cancelled' AND d\.state='Dead letter'$/, "never into a cancelled campaign");
    assert.equal(requeue.inputs.id, "COM-007");
    const retryAudit = sqlWrites(calls).filter((c) => /AuditEvents/.test(c.text)).at(-1)!;
    assert.deepEqual([retryAudit.inputs.action, retryAudit.inputs.entity, JSON.parse(String(retryAudit.inputs.after))], ["communication.deliveries.retried", SQL_UUID, { requeued: 3 }]);
    assert.ok(requeue.inTransaction && retryAudit.inTransaction);
    assert.deepEqual(events.slice(beforeRetry), ["begin", "commit"]);
    const reopenTry = calls.find((c) => /^\s*UPDATE c SET status='Sending'/.test(c.text))!;
    assert.deepEqual([reopenTry.inTransaction, calls.indexOf(reopenTry) > calls.indexOf(requeue), retryAudit.inputs.before], [true, true, null], "the campaign was not Sent, so nothing was reopened and no status change is recorded");

    const beforeEstimate = calls.length;
    const sqlEstimate = await audienceEstimate(CONTRIBUTOR, "COM-007");
    assert.equal(sqlEstimate.total, 0, "no organisation or member answers: an empty audience is reported, not refused");
    assert.deepEqual(sqlWrites(calls.slice(beforeEstimate)), [], "an estimate writes nothing");
  });
});

test("deliveries, SQL: a retry that requeues rows of a completed campaign reopens it in the same unit of work and audits the status change", async () => {
  const requeueRows: SqlAnswers = [[/^\s*UPDATE d SET state='Queued'/, { rowsAffected: [3] }]];
  const reopen = (rows: number): SqlAnswers => [[/^\s*UPDATE c SET status='Sending'/, { rowsAffected: [rows] }]];
  await withFakeSql([...requeueRows, ...reopen(1), ...sqlCampaign("COM-007", { status: "Sent" })], async (calls, events) => {
    assert.deepEqual(await retryDeadLetters(PM, "COM-007"), { requeued: 3, reopened: true });
    const [requeue, campaign, audit, ...more] = sqlWrites(calls);
    assert.equal(more.length, 0);
    assert.match(requeue.text, /^UPDATE d SET state='Queued'/);
    assert.match(campaign.text, /^UPDATE c SET status='Sending',completed_at=NULL,updated_at=SYSUTCDATETIME\(\)\s+FROM dbo\.Communications c\s+WHERE c\.public_id=@id AND c\.status='Sent' AND c\.deleted_at IS NULL\s+AND EXISTS \(SELECT 1 FROM dbo\.CommunicationDeliveries d WHERE d\.communication_id=c\.id AND d\.source<>'Test' AND d\.state IN \('Queued','Retry','Processing'\)\)$/, "a Sent campaign with a real row waiting is Sending; started_at is not touched");
    assert.equal(campaign.inputs.id, "COM-007");
    assert.deepEqual([audit.inputs.action, audit.inputs.entity, JSON.parse(String(audit.inputs.before)), JSON.parse(String(audit.inputs.after))], ["communication.deliveries.retried", SQL_UUID, { status: "Sent" }, { requeued: 3, status: "Sending" }]);
    assert.ok(sqlWrites(calls).every((c) => c.inTransaction), "the requeue, the reopening and the audit row ran inside the transaction");
    assert.deepEqual(events, ["begin", "commit"], "one unit of work");
    const direct = calls.length;
    assert.deepEqual(await requeueDeadLetters("COM-007"), { requeued: 3, reopened: true });
    assert.deepEqual(sqlWrites(calls.slice(direct)).map((c) => c.inTransaction), [true, true], "called on its own, the requeue and the reopening still share a unit of work");
    assert.deepEqual(events.slice(2), ["begin", "commit"]);
  });
  await withFakeSql([[/^\s*UPDATE d SET state='Queued'/, { rowsAffected: [0] }], ...reopen(1), ...sqlCampaign("COM-007", { status: "Sent" })], async (calls) => {
    assert.deepEqual(await retryDeadLetters(PM, "COM-007"), { requeued: 0, reopened: false });
    assert.equal(calls.some((c) => /^\s*UPDATE c SET status='Sending'/.test(c.text)), false, "nothing was requeued, so nothing is reopened");
    const audit = sqlWrites(calls).find((c) => /AuditEvents/.test(c.text))!;
    assert.deepEqual([JSON.parse(String(audit.inputs.after)), audit.inputs.before], [{ requeued: 0 }, null]);
  });
  await withFakeSql([...requeueRows, ...reopen(0), ...sqlCampaign("COM-007", { status: "Sending" })], async (calls) => {
    assert.deepEqual(await retryDeadLetters(PM, "COM-007"), { requeued: 3, reopened: false });
    const audit = sqlWrites(calls).find((c) => /AuditEvents/.test(c.text))!;
    assert.deepEqual([JSON.parse(String(audit.inputs.after)), audit.inputs.before], [{ requeued: 3 }, null], "the campaign was not reopened (it is Sending already, or only a Test row waits), so only the count is recorded");
  });
  await withFakeSql([...requeueRows, ...reopen(1), ...sqlCampaign("COM-007", { status: "Cancelled" })], async (calls, events) => {
    await assert.rejects(retryDeadLetters(PM, "COM-007"), /INVALID_COMMUNICATION_STATE/, "a cancelled campaign is refused");
    assert.deepEqual([sqlWrites(calls).length, events], [0, []], "before anything is written or a unit of work is opened");
  });
});

test("send side, demo data: with SQL configured and the demo-data switch on, campaigns, deliveries and their audit stay in memory; accounts, settings, the audience and the staff list still come from SQL", async () => {
  process.env.SENDGRID_API_KEY = "SG.test";
  const answers: SqlAnswers = [...sqlSettings(), ...sqlAudience([sqlMember(1), sqlMember(2)]), [/SELECT DISTINCT u\.email/, { recordset: [{ email: "staff@datacentral.ai" }] }]];
  await withFakeSql(answers, async (calls, events) => {
    globalThis.pulseShowDemoData = true;
    try {
      const created = await createCommunication(PM, draftInput);
      assert.equal((await audienceEstimate(PM, created.id)).sendable, 2, "the audience is read from SQL");
      const sent = await sendCommunication(PM, created.id, {});
      assert.deepEqual([sent.status, sent.recipientCount, sent.version], ["Sending", 2, "1"], "frozen into memory, with a memory version");
      assert.equal(memoryDeliveries().length, 2);
      assert.equal((await listDeliveries(CONTRIBUTOR, created.id, {})).total, 2);
      assert.equal((await getCommunication(CONTRIBUTOR, created.id)).stats.recipients, 2);
      const store = getDeliveryStore();
      const batch = (await store.claimBatch(10))!;
      assert.deepEqual([batch.communicationId, batch.deliveries.map((d) => d.source)], [created.id, ["Member", "Member"]], "the worker's store is the memory one");
      await store.markFailed(batch.deliveries.map((d) => d.id), "HTTP_400", null);
      assert.deepEqual(await retryDeadLetters(PM, created.id), { requeued: 2, reopened: false });
      assert.deepEqual(await testSendCommunication(PM, created.id, ["staff@datacentral.ai"]), { queued: 2 }, "the staff list still comes from SQL");
      assert.equal((await cancelCommunication(PM, created.id, "cancel")).status, "Cancelled");
      const scheduled = await createCommunication(PM, draftInput);
      await sendCommunication(PM, scheduled.id, { scheduledAt: inAnHour() });
      memoryCommunications().find((c) => c.id === scheduled.id)!.scheduledAt = new Date(Date.now() - 1000).toISOString();
      assert.deepEqual(await store.promoteScheduled(new Date()), [scheduled.id]);
      assert.deepEqual(calls.filter((c) => /dbo\.(Communications|CommunicationDeliveries|AuditEvents)\b|OPENJSON/.test(c.text)), [], "no campaign, delivery, audit or version statement reached SQL");
      assert.deepEqual(events, [], "and no transaction was opened");
      assert.ok(calls.some((c) => /FROM dbo\.Users WHERE id=@id/.test(c.text)), "who the caller is was still asked of SQL");
      assert.ok(calls.some((c) => /FROM dbo\.Settings/.test(c.text)) && calls.some((c) => /FROM dbo\.Memberships m JOIN dbo\.Users u/.test(c.text)), "and so were the settings and the audience");
    } finally {
      globalThis.pulseShowDemoData = undefined;
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// SendGrid transport and delivery worker
// ---------------------------------------------------------------------------------------------------------------------

type FakeStep = "ok" | { status: number; retryAfter?: number; reset?: number };
// Module scope: the webhook and acceptance tests of later tasks reuse these two.
/**
 * Stands in for SendGrid: answers from `script` (past its end, "ok") and keeps every batch it was handed. A failure looks like the SDK's
 * ResponseError: the HTTP status in `code`, the headers and the parsed body in `response`.
 */
function fakeTransport(script: FakeStep[] = []) {
  const calls: OutboundBatch[] = [];
  const transport: MailTransport = {
    kind: "sendgrid",
    async sendBatch(batch) {
      calls.push(batch);
      const step = script.shift() ?? "ok";
      if (step === "ok") return { providerMessageId: `msg-${calls.length}` };
      throw Object.assign(new Error("sendgrid failure"), { code: step.status, response: { headers: { ...(step.retryAfter ? { "retry-after": String(step.retryAfter) } : {}), ...(step.reset ? { "x-ratelimit-reset": String(step.reset) } : {}) }, body: { errors: [{ message: "nope" }] } } });
    },
  };
  return { transport, calls };
}
/**
 * Stands in for a SendGrid that rejects, with `status`, every request that has a recipient `isBad` points at (as SendGrid answers 400 to a whole
 * request for one address it will not take); anything else is accepted with a message id of its own. Records the batches like `fakeTransport`.
 */
function pickyTransport(isBad: (email: string) => boolean, status = 400) {
  const calls: OutboundBatch[] = [];
  const transport: MailTransport = {
    kind: "sendgrid",
    async sendBatch(batch) {
      calls.push(batch);
      if (batch.recipients.some((r) => isBad(r.email))) throw Object.assign(new Error("sendgrid failure"), { code: status, response: { headers: {}, body: { errors: [{ message: "nope" }] } } });
      return { providerMessageId: `msg-${calls.length}` };
    },
  };
  return { transport, calls };
}
/** A campaign that has been sent to the four people `seedAudience` makes: Sending, with four Queued rows (three English, one Icelandic). */
async function readyCampaign() {
  return readyCampaignWith(0);
}
/** The same with `extraEnglish` more English-speaking contacts of ORG-001 in the audience: `extraEnglish + 3` English rows and the one Icelandic row. */
async function readyCampaignWith(extraEnglish: number) {
  await seedAudience();
  for (let i = 0; i < extraEnglish; i++) await saveContact(PM, { organizationId: "ORG-001", email: `extra${i}@origo.is`, displayName: `Extra ${i}`, locale: "en", topics: ["product-updates"] });
  await enableSending();
  const created = await createCommunication(PM, draftInput);
  await sendCommunication(PM, created.id, {});
  return created.id;
}
/** Runs `work` with console.<method> recording instead of printing; gives back what `work` returned and the lines it was handed. */
async function captured<T>(method: "log" | "warn" | "error", work: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console[method];
  console[method] = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    return { value: await work(), lines };
  } finally {
    console[method] = original;
  }
}
/** `work` with the worker's structured log lines (warn and error) recorded instead of printed, so that they stay out of the TAP stream; gives back what `work` returned. */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  return (await captured("warn", () => captured("error", work))).value.value;
}
const outbound = (over: Partial<OutboundBatch> = {}): OutboundBatch => ({
  subject: "S", html: "<p>h</p>", text: "t", from: { email: "updates@datacentral.ai", name: "DataCentral" }, replyTo: null,
  recipients: [{ email: "a@origo.is", name: "A", customArgs: { deliveryId: "d1", communicationId: "COM-001" } }],
  categories: ["pulse", "pulse-product-updates", "COM-001"], unsubscribeGroupId: null, tracking: { opens: true, clicks: true }, sandbox: false, ...over,
});

test("sendgrid: message builder maps recipients, custom args, categories, asm and tracking", () => {
  const message = buildSendGridMessage({
    subject: "S", html: "<p>h</p>", text: "t", from: { email: "updates@datacentral.ai", name: "DataCentral" }, replyTo: null,
    recipients: [{ email: "a@origo.is", name: "A", customArgs: { deliveryId: "d1", communicationId: "COM-001" } }],
    categories: ["pulse", "pulse-product-updates", "COM-001"], unsubscribeGroupId: 42, tracking: { opens: false, clicks: true }, sandbox: true,
  }) as { personalizations: Array<{ to: Array<{ email: string }>; customArgs: Record<string, string> }>; asm: { groupId: number }; trackingSettings: { openTracking: { enable: boolean } }; mailSettings: { sandboxMode: { enable: boolean } } };
  assert.equal(message.personalizations[0].to[0].email, "a@origo.is");
  assert.equal(message.personalizations[0].customArgs.deliveryId, "d1");
  assert.equal(message.asm.groupId, 42);
  assert.equal(message.trackingSettings.openTracking.enable, false);
  assert.equal(message.mailSettings.sandboxMode.enable, true);
});

test("sendgrid: the message leaves out what is not set — reply-to, unsubscribe group, a name — keeps a personalization per recipient and sends at most ten categories", () => {
  const batch = outbound({
    recipients: [{ email: "a@origo.is", name: null, customArgs: { deliveryId: "d1" } }, { email: "b@origo.is", name: "B", customArgs: { deliveryId: "d2" } }],
    categories: Array.from({ length: 12 }, (_, i) => `c${i}`), tracking: { opens: true, clicks: false },
  });
  const bare = buildSendGridMessage(batch);
  assert.equal("replyTo" in bare, false);
  assert.equal("asm" in bare, false);
  assert.deepEqual(bare.personalizations, [
    { to: [{ email: "a@origo.is" }], customArgs: { deliveryId: "d1" } },
    { to: [{ email: "b@origo.is", name: "B" }], customArgs: { deliveryId: "d2" } },
  ], "one personalization, with one address, each: nobody sees another recipient");
  assert.deepEqual(bare.categories, batch.categories.slice(0, 10));
  assert.equal(batch.categories.length, 12, "the batch itself is not cut");
  assert.deepEqual(bare.trackingSettings, { clickTracking: { enable: false, enableText: false }, openTracking: { enable: true } });
  assert.deepEqual(bare.mailSettings, { sandboxMode: { enable: false } });
  assert.deepEqual([bare.subject, bare.html, bare.text, bare.from], ["S", "<p>h</p>", "t", { email: "updates@datacentral.ai", name: "DataCentral" }]);
  const set = buildSendGridMessage({ ...batch, replyTo: "support@datacentral.ai", unsubscribeGroupId: 7 });
  assert.deepEqual([set.replyTo, set.asm], [{ email: "support@datacentral.ai" }, { groupId: 7 }]);
});

test("sendgrid: error classification", () => {
  assert.deepEqual([classifySendError({ code: 429, response: { headers: { "retry-after": "900" } } })].map((e) => [e.code, e.retryable, e.retryAfterSeconds]), [["HTTP_429", true, 900]]);
  assert.equal(classifySendError({ code: 400, response: { body: { errors: [{ message: "bad" }] } } }).retryable, false);
  assert.equal(classifySendError({ code: 503 }).retryable, true);
  assert.equal(classifySendError(new Error("ECONNRESET")).retryable, true);
});

test("sendgrid: classification — statuses, a missing or odd Retry-After, network errors, anything that is not an error, and a code that is never made of the message", () => {
  const summary = (error: unknown) => { const c = classifySendError(error); return [c.code, c.retryable, c.retryAfterSeconds]; };
  assert.deepEqual(summary({ code: 500 }), ["HTTP_500", true, null]);
  assert.deepEqual(summary({ code: 401 }), ["HTTP_401", false, null], "a rejected key is not worth retrying");
  assert.deepEqual(summary({ code: 413 }), ["HTTP_413", false, null]);
  assert.deepEqual(summary({ code: "429", response: { headers: { "retry-after": "30" } } }), ["HTTP_429", true, 30], "a status can arrive as text");
  for (const odd of ["soon", "0", "-5", ""]) assert.equal(classifySendError({ code: 429, response: { headers: { "retry-after": odd } } }).retryAfterSeconds, null, `Retry-After ${JSON.stringify(odd)} asks for no wait`);
  assert.equal(classifySendError({ code: 429, response: {} }).retryAfterSeconds, null);
  assert.deepEqual(summary(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })), ["ECONNRESET", true, null], "a network error has no status: its code is the code, when it is a known one");
  for (const code of ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "ECONNABORTED"]) assert.deepEqual(summary(Object.assign(new Error("whatever it says"), { code })), [code, true, null], `${code} is a known network code`);
  assert.deepEqual(summary(new Error("getaddrinfo EAI_AGAIN api.sendgrid.com")), ["EAI_AGAIN", true, null], "a known network code in the message counts when the error carries none");
  assert.deepEqual(summary(new Error("timeout of 30000ms exceeded")), ["SEND_FAILED", true, null], "any other failure is a generic one, however its message reads");
  for (const notAnError of [null, undefined, "boom", 42, {}]) assert.deepEqual(summary(notAnError), ["SEND_FAILED", true, null]);
  for (const notAStatus of [0, 99, "", null, "EPIPE", "ERR_BAD_REQUEST"]) assert.deepEqual(summary(Object.assign(new Error("odd code"), { code: notAStatus })), ["SEND_FAILED", true, null], `a code of ${JSON.stringify(notAStatus)} is neither an HTTP status nor a known network code`);
  // The message is never the code (it can carry an address) and, whatever it is, it does not throw.
  assert.equal(classifySendError(new Error("bad address jon@origo.is")).code, "SEND_FAILED");
  for (const message of [42, { not: "a string" }, ["ECONNRESET"], null, undefined]) assert.doesNotThrow(() => classifySendError({ message }), `a message of ${JSON.stringify(message)}`);
  assert.equal(classifySendError({ message: 42 }).code, "SEND_FAILED");
  const mine = new SendError("MINE", false, 5);
  assert.equal(classifySendError(mine), mine, "a SendError is already classified");
});

test("sendgrid: a 429 without a usable Retry-After waits until X-RateLimit-Reset (epoch seconds); a Retry-After wins, and a reset that has passed asks for no wait", () => {
  const now = 1_760_000_000_000; // ms; 1_760_000_000 s
  const wait = (headers: Record<string, string>, code = 429) => classifySendError({ code, response: { headers } }, now).retryAfterSeconds;
  assert.equal(wait({ "x-ratelimit-reset": "1760000120" }), 120);
  assert.equal(wait({ "x-ratelimit-reset": "1760000120", "retry-after": "30" }), 30, "Retry-After wins when it is there");
  assert.equal(wait({ "x-ratelimit-reset": "1760000120", "retry-after": "soon" }), 120, "and the reset is the fallback when it is no number");
  assert.equal(wait({ "x-ratelimit-reset": "1759999995" }), null, "a reset that has passed asks for no wait");
  assert.equal(wait({ "x-ratelimit-reset": "1760000000" }), null, "nor does one that is now");
  assert.equal(wait({ "x-ratelimit-reset": "soon" }), null);
  assert.equal(wait({}), null);
  assert.equal(classifySendError({ code: 429, response: { headers: { "x-ratelimit-reset": "1760000000.2" } } }, now - 1).retryAfterSeconds, 1, "a fraction of a second is a second");
  assert.equal(wait({ "x-ratelimit-reset": "1760000120" }, 503), null, "only a 429 is about the rate limit");
  assert.equal(wait({ "x-ratelimit-reset": "1760000120" }, 400), null);
  assert.equal(wait({ "x-ratelimit-reset": "1760000120", "retry-after": "30" }, 503), 30, "a Retry-After is read whatever the status");
});

test("sendgrid: the transport sends the built message, returns the provider's message id and turns every failure into a classified SendError", async () => {
  const handed: Array<Record<string, unknown>> = [];
  const answering = (statusCode: number, headers: Record<string, string> = {}) =>
    createMailTransport(DEFAULT_COMMUNICATION_SETTINGS, { send: async (message) => { handed.push(message); return { statusCode, headers }; } });
  const failing = (error: unknown) => createMailTransport(DEFAULT_COMMUNICATION_SETTINGS, { send: async () => { throw error; } });
  const isSendError = (code: string, retryable: boolean, retryAfterSeconds: number | null = null) => (e: unknown) =>
    e instanceof SendError && e.code === code && e.retryable === retryable && e.retryAfterSeconds === retryAfterSeconds;
  const batch = outbound();
  assert.equal(answering(202).kind, "sendgrid", "an injected sender makes the SendGrid transport, key or no key");
  assert.deepEqual(await answering(202, { "x-message-id": "sg-123" }).sendBatch(batch), { providerMessageId: "sg-123" });
  assert.deepEqual(handed, [buildSendGridMessage(batch)], "the sender is handed exactly the built message");
  assert.deepEqual(await answering(200).sendBatch(batch), { providerMessageId: null }, "sandbox mode answers 200 with no message id");
  await assert.rejects(answering(302).sendBatch(batch), isSendError("HTTP_302", false));
  await assert.rejects(answering(503).sendBatch(batch), isSendError("HTTP_503", true));
  await assert.rejects(failing({ code: 429, response: { headers: { "retry-after": "120" } } }).sendBatch(batch), isSendError("HTTP_429", true, 120));
  await assert.rejects(failing({ code: 400, response: { body: { errors: [{ message: "recipient@origo.is is not valid" }] } } }).sendBatch(batch), isSendError("HTTP_400", false));
  await assert.rejects(failing(new Error("socket hang up")).sendBatch(batch), isSendError("SEND_FAILED", true));
  await assert.rejects(failing(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" })).sendBatch(batch), isSendError("ECONNREFUSED", true));
  await assert.rejects(failing({ code: 429, response: { headers: { "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 300) } } }).sendBatch(batch), (e: unknown) => e instanceof SendError && e.code === "HTTP_429" && (e.retryAfterSeconds ?? 0) > 290 && (e.retryAfterSeconds ?? 0) <= 301, "the transport reads the reset from the real clock");
});

test("sendgrid: without an API key the transport is the console one: it sends nothing and logs a count, never an address", async () => {
  const transport = createMailTransport(DEFAULT_COMMUNICATION_SETTINGS);
  assert.equal(transport.kind, "console");
  const { value, lines } = await captured("log", () => transport.sendBatch(outbound({ sandbox: true })));
  assert.match(value.providerMessageId ?? "", /^console-[0-9a-f-]{36}$/);
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ level: "info", event: "communications.console-send", recipients: 1, sandbox: true }]);
  process.env.SENDGRID_API_KEY = "   ";
  assert.equal(createMailTransport(DEFAULT_COMMUNICATION_SETTINGS).kind, "console", "a blank key is no key");
  process.env.SENDGRID_API_KEY = "SG.test";
  assert.equal(createMailTransport(DEFAULT_COMMUNICATION_SETTINGS).kind, "sendgrid");
});

/** The HTTP client inside the SDK's `sgMail` singleton, where the key, the region and the request settle. It is not in the typings, hence the cast. */
type SdkClient = {
  request?: (data: unknown) => Promise<unknown>;
  createRequest(data: unknown): { baseURL: string; headers: Record<string, string>; data: Record<string, unknown>; timeout?: number };
  setDataResidency(region: string): unknown;
};
const sdkClient = () => (sgMail as unknown as { client: SdkClient }).client;

test("sendgrid, SDK: the batch reaches SendGrid as the v3 request body, with the key, in the region the settings name, and the response is read from the SDK's answer", async () => {
  process.env.SENDGRID_API_KEY = "  SG.test-key ";
  const client = sdkClient();
  const requests: Array<ReturnType<SdkClient["createRequest"]>> = [];
  // Nothing goes out: the SDK builds the request as it would, and this answers it instead of the network.
  client.request = async (data) => { requests.push(client.createRequest(data)); return [{ statusCode: 202, body: "", headers: { "x-message-id": "sg-sdk-1" } }, ""]; };
  try {
    const batch = outbound({ replyTo: "support@datacentral.ai", unsubscribeGroupId: 42, sandbox: true, tracking: { opens: false, clicks: true } });
    assert.deepEqual(await createMailTransport({ ...DEFAULT_COMMUNICATION_SETTINGS, dataResidency: "eu" }).sendBatch(batch), { providerMessageId: "sg-sdk-1" });
    await createMailTransport({ ...DEFAULT_COMMUNICATION_SETTINGS, dataResidency: "global" }).sendBatch(batch);
    assert.deepEqual(requests.map((r) => r.baseURL), ["https://api.eu.sendgrid.com/", "https://api.sendgrid.com/"], "MailService has no setDataResidency; the region is set on the client it sends through");
    assert.ok(requests.every((r) => r.headers.Authorization === "Bearer SG.test-key"), "the key, without its blanks");
    assert.ok(requests.every((r) => r.timeout === 30_000), "a request that hangs is given up after 30 seconds");
    assert.deepEqual(JSON.parse(JSON.stringify(requests[0].data)), { // what goes over the wire: the SDK's address objects serialize themselves
      from: { email: "updates@datacentral.ai", name: "DataCentral" },
      reply_to: { email: "support@datacentral.ai" },
      subject: "S",
      personalizations: [{ to: [{ email: "a@origo.is", name: "A" }], custom_args: { deliveryId: "d1", communicationId: "COM-001" } }],
      content: [{ type: "text/plain", value: "t" }, { type: "text/html", value: "<p>h</p>" }],
      categories: ["pulse", "pulse-product-updates", "COM-001"],
      asm: { group_id: 42 },
      tracking_settings: { click_tracking: { enable: true, enable_text: false }, open_tracking: { enable: false } },
      mail_settings: { sandbox_mode: { enable: true } },
    });
  } finally {
    delete client.request;
    client.setDataResidency("global");
  }
});

test("worker: sends one request per locale with ≤500 recipients, marks Accepted and completes the campaign", async () => {
  const id = await readyCampaign();
  const { transport, calls } = fakeTransport();
  const result = await processCommunicationBatch(500, { transport });
  assert.equal(calls.length, 2, "en and is batches");
  assert.ok(calls.every((c) => c.recipients.every((r) => r.customArgs.communicationId === id && r.customArgs.deliveryId)));
  assert.deepEqual(calls[0].categories, ["pulse", "pulse-product-updates", id]);
  assert.equal(result.accepted, 4);
  assert.deepEqual(result.completed, [id]);
  assert.equal((await getCommunication(PM, id)).status, "Sent");
  assert.ok((await listDeliveries(PM, id, {})).items.every((d) => d.state === "Accepted" && d.providerMessageId));
});

test("worker: the request carries the campaign's settings, the rendered mail for the batch's locale and the people of that batch only", async () => {
  await seedAudience();
  await saveCommunicationSettings(ADMIN, {
    ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai", fromName: "DC Updates", replyTo: "support@datacentral.ai", unsubscribeGroupId: 42,
    sandboxMode: true, tracking: { opens: false, clicks: true }, safeMode: { enabled: false, allowedDomains: [] }, categoriesPrefix: "pulse-test",
  });
  process.env.SENDGRID_API_KEY = "SG.test";
  const created = await createCommunication(PM, draftInput);
  await sendCommunication(PM, created.id, {});
  process.env.PULSE_PUBLIC_URL = "https://pulse.test///";
  const { transport, calls } = fakeTransport();
  try {
    await processCommunicationBatch(500, { transport });
  } finally {
    delete process.env.PULSE_PUBLIC_URL;
  }
  const [english, icelandic] = calls;
  assert.deepEqual(english.recipients.map((r) => [r.email, r.name]), [["bjarki@uidata.com", "Bjarki Kristjánsson"], ["jon@origo.is", "Jón"], ["anna@advania.is", "Anna"]]);
  assert.deepEqual(icelandic.recipients.map((r) => [r.email, r.name]), [["cio@origo.is", "CIO"]]);
  for (const call of calls) {
    assert.deepEqual([call.from, call.replyTo, call.unsubscribeGroupId, call.tracking, call.sandbox], [{ email: "updates@datacentral.ai", name: "DC Updates" }, "support@datacentral.ai", 42, { opens: false, clicks: true }, true]);
    assert.deepEqual(call.categories, ["pulse-test", "pulse-test-product-updates", created.id]);
    assert.match(call.html, /https:\/\/pulse\.test\/email\/datacentral-logo\.png/, "the logo comes from the public URL, without its trailing slashes");
    assert.match(call.html, /<%asm_group_unsubscribe_raw_url%>/, "an unsubscribe group puts the unsubscribe tag in the footer");
  }
  assert.equal(english.subject, "DataCentral 3.0.0");
  assert.equal(icelandic.subject, "DataCentral 3.0.0 (is)", "the Icelandic batch carries the Icelandic subject");
  assert.match(english.html, /<html lang="en">/);
  assert.match(icelandic.html, /<html lang="is">/);
  assert.ok(english.text.length > 0 && icelandic.text.length > 0);
});

test("worker: honours Retry-After when it exceeds the backoff; non-retryable errors dead-letter at once", async () => {
  const id = await readyCampaign();
  const start = Date.now();
  const throttled = await quietly(() => processCommunicationBatch(500, { transport: fakeTransport([{ status: 429, retryAfter: 900 }]).transport, now: () => new Date(start) }));
  assert.equal(throttled.retried, 3, "the English batch of three was throttled");
  assert.equal((await listDeliveries(PM, id, { state: "Queued" })).total, 1, "the Icelandic row is never claimed after the 429 stop");
  const retry = (await listDeliveries(PM, id, { state: "Retry" })).items[0];
  assert.ok(new Date(retry.nextAttemptAt!).getTime() >= start + 900_000);
  for (const d of globalThis.pulseMemoryCommunicationDeliveries!) d.nextAttemptAt = new Date(0).toISOString();
  // Every request is rejected: a lone recipient is a dead letter at once, and a batch is split until each of its recipients stands alone
  // (three in the English batch: the request itself, then 2 + 1 and 1 + 1, so four requests more).
  const rejected = await quietly(() => processCommunicationBatch(500, { transport: fakeTransport(Array.from({ length: 6 }, () => ({ status: 400 }))).transport }));
  assert.deepEqual([rejected.deadLettered, rejected.retried, rejected.splits], [4, 0, 4]);
  assert.equal((await listDeliveries(PM, id, { state: "Dead letter" })).total, 4);
});

test("worker: a Retry-After shorter than the backoff changes nothing, and one past a day waits a day, so a wild value cannot park a row for years", async () => {
  await readyCampaign();
  const start = Date.now();
  const waitAfter = async (retryAfter: number) => {
    for (const d of memoryDeliveries()) Object.assign(d, { state: "Queued", attemptCount: 0, nextAttemptAt: null });
    await quietly(() => processCommunicationBatch(500, { transport: fakeTransport([{ status: 429, retryAfter }]).transport, now: () => new Date(start) }));
    return new Date(memoryDeliveries().find((d) => d.state === "Retry")!.nextAttemptAt!).getTime() - start;
  };
  assert.equal(await waitAfter(30), 2 * BACKOFF_BASE_MS, "the first failure backs off two minutes; 30 seconds is less");
  assert.equal(await waitAfter(900), 900_000);
  assert.equal(await waitAfter(1e15), 24 * 3_600_000);
});

test("worker: five retryable failures dead-letter; master switch off skips; daily cap stops claiming", async () => {
  const id = await readyCampaign();
  const script = Array.from({ length: 10 }, () => ({ status: 500 }));
  for (let i = 0; i < 5; i++) {
    await quietly(() => processCommunicationBatch(500, { transport: fakeTransport(script).transport }));
    for (const d of globalThis.pulseMemoryCommunicationDeliveries!) d.nextAttemptAt = new Date(0).toISOString();
  }
  assert.equal((await communicationStats(id)).deadLettered, 4);
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: false });
  assert.equal((await processCommunicationBatch(500, { transport: fakeTransport().transport })).skipped, true);
  const second = await createCommunication(PM, draftInput);
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai", unsubscribeGroupId: 42, safeMode: { enabled: false, allowedDomains: [] }, dailyCap: 2 });
  await sendCommunication(PM, second.id, {});
  const capped = await processCommunicationBatch(500, { transport: fakeTransport().transport });
  assert.equal(capped.capReached, true);
  assert.equal((await communicationStats(second.id)).queued, 2, "cap of 2 leaves two of four recipients queued");
});

test("worker: promotes due scheduled campaigns and prefixes test sends", async () => {
  await seedAudience();
  await enableSending();
  const created = await createCommunication(PM, draftInput);
  await sendCommunication(PM, created.id, { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
  globalThis.pulseMemoryCommunications![0].scheduledAt = new Date(Date.now() - 1000).toISOString();
  const { transport, calls } = fakeTransport();
  const result = await processCommunicationBatch(500, { transport });
  assert.deepEqual(result.promoted, [created.id]);
  assert.equal(result.accepted, 4);
  const draft = await createCommunication(PM, draftInput);
  await testSendCommunication(PM, draft.id, []);
  await processCommunicationBatch(500, { transport });
  assert.ok(calls.at(-1)!.subject.startsWith("[TEST] "));
  assert.equal(calls.at(-1)!.recipients[0].email, PM.email);
});

test("worker: a test mail goes out alone with its own category, and a real batch never carries the test prefix", async () => {
  const id = await readyCampaign();
  await testSendCommunication(PM, id, []);
  const { transport, calls } = fakeTransport();
  const result = await processCommunicationBatch(500, { transport });
  assert.equal(result.accepted, 5);
  const testMails = calls.filter((c) => c.subject.startsWith("[TEST] "));
  const realMails = calls.filter((c) => !c.subject.startsWith("[TEST] "));
  assert.deepEqual([testMails.length, realMails.length], [1, 2], "the Test row is a batch of its own");
  assert.deepEqual(testMails[0].recipients.map((r) => r.email), [PM.email]);
  assert.deepEqual(testMails[0].categories, ["pulse", "pulse-test", id], "a test mail is counted apart from the campaign's topic");
  assert.deepEqual(realMails.map((c) => c.recipients.length), [3, 1]);
  assert.ok(realMails.every((c) => c.categories[1] === "pulse-product-updates"));
});

test("worker: a lease that has run out is recovered first, the rows go out again in the same run and the count is reported", async () => {
  const id = await readyCampaign();
  const store = getDeliveryStore();
  const crashed = (await store.claimBatch(500))!; // the English batch: with the provider when the run that claimed it died
  assert.equal(crashed.deliveries.length, 3);
  const row = (email: string) => memoryDeliveries().find((d) => d.email === email)!;
  for (const email of ["bjarki@uidata.com", "jon@origo.is"]) row(email).nextAttemptAt = new Date(Date.now() - 1000).toISOString(); // their leases ran out; anna's has not
  const { transport, calls } = fakeTransport();
  const { value: first, lines } = await captured("warn", () => processCommunicationBatch(500, { transport }));
  assert.equal(first.recovered, 2);
  assert.deepEqual(calls.map((c) => c.recipients.map((r) => r.email)), [["bjarki@uidata.com", "jon@origo.is"], ["cio@origo.is"]], "the recovered rows go out with the Icelandic one; anna's lease is still live");
  assert.deepEqual([first.accepted, first.completed], [3, []], "and the campaign waits for the row that is still with the worker");
  assert.deepEqual([row("bjarki@uidata.com").state, row("bjarki@uidata.com").attemptCount, row("anna@advania.is").state], ["Accepted", 2, "Processing"], "recovery keeps the attempts: the new claim counted the second");
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ level: "warn", event: "communications.recovered-stale", count: 2 }], "an abnormal event is logged, with a count");
  row("anna@advania.is").nextAttemptAt = new Date(Date.now() - 1000).toISOString();
  const second = await quietly(() => processCommunicationBatch(500, { transport }));
  assert.deepEqual([second.recovered, second.accepted, second.completed], [1, 1, [id]]);
  assert.deepEqual((await processCommunicationBatch(500, { transport })).recovered, 0, "nothing is recovered twice");
});

test("worker: with 'Show demo data' on nothing is mailed — a demo campaign's deliveries come from the real audience — and the switch off again lets the same rows go", async () => {
  await readyCampaign();
  const { transport, calls } = fakeTransport();
  globalThis.pulseShowDemoData = true;
  try {
    assert.deepEqual(await processCommunicationBatch(500, { transport }), { skipped: true, promoted: [], accepted: 0, retried: 0, deadLettered: 0, completed: [], capReached: false, recovered: 0, splits: 0 });
  } finally {
    globalThis.pulseShowDemoData = undefined;
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(countByState(memoryDeliveries()), { Queued: 4 }, "not even claimed");
  assert.equal((await processCommunicationBatch(500, { transport })).accepted, 4);
});

test("worker: in production the console transport is refused before anything is claimed, whether it was chosen for lack of a key or handed in; a real transport is not refused", async () => {
  await readyCampaign();
  const store = getDeliveryStore(); // the memory store, picked while NODE_ENV is not production (a production process without SQL does not start)
  const env = process.env as Record<string, string | undefined>;
  const before = env.NODE_ENV;
  env.NODE_ENV = "production";
  try {
    delete env.SENDGRID_API_KEY; // no key: createMailTransport falls back to the console transport ...
    await assert.rejects(processCommunicationBatch(500, { store }), /INVALID_EMAIL_PROVIDER_CONFIGURATION/, "... which a production worker must never use in silence");
    const consoleLike: MailTransport = { kind: "console", async sendBatch() { throw new Error("must not be called"); } };
    await assert.rejects(processCommunicationBatch(500, { store, transport: consoleLike }), /INVALID_EMAIL_PROVIDER_CONFIGURATION/, "nor one handed to it");
    assert.deepEqual(countByState(memoryDeliveries()), { Queued: 4 }, "nothing was claimed");
    const { transport, calls } = fakeTransport();
    assert.deepEqual([(await processCommunicationBatch(500, { store, transport })).accepted, calls.length], [4, 2]);
  } finally {
    if (before === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = before;
  }
});

test("worker: a batch that cannot be rendered fails like any other — retried, then a dead letter — and does not leave its rows with the worker or stop the run", async () => {
  const id = await readyCampaign();
  memoryCommunications().find((c) => c.id === id)!.templateKey = "no-such-template" as never;
  const { transport, calls } = fakeTransport();
  const { value: first, lines } = await captured("error", () => processCommunicationBatch(500, { transport }));
  assert.deepEqual([first.accepted, first.retried, first.deadLettered, calls.length], [0, 4, 0, 0], "both batches failed; the second was still tried");
  assert.deepEqual(countByState(memoryDeliveries()), { Retry: 4 });
  assert.ok(memoryDeliveries().every((d) => d.lastErrorCode === "RENDER_FAILED" && d.attemptCount === 1), "the code says what failed, not what the renderer's message said");
  assert.deepEqual(lines.map((line) => JSON.parse(line).code), ["RENDER_FAILED", "RENDER_FAILED"]);
  for (const d of memoryDeliveries()) Object.assign(d, { attemptCount: 4, nextAttemptAt: new Date(0).toISOString() });
  const last = await quietly(() => processCommunicationBatch(500, { transport }));
  assert.deepEqual([last.retried, last.deadLettered, last.splits], [0, 4, 0], "the fifth attempt is the last, and a render failure is no reason to split a batch");
});

test("worker: a failed batch is logged with its campaign, a code and a count — never an address, a subject or a body", async () => {
  const id = await readyCampaign();
  const { lines } = await captured("error", () => processCommunicationBatch(500, { transport: fakeTransport([{ status: 500 }, { status: 400 }]).transport }));
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [
    { level: "error", event: "communications.send.failed", communicationId: id, code: "HTTP_500", recipients: 3, terminal: false },
    { level: "error", event: "communications.send.failed", communicationId: id, code: "HTTP_400", recipients: 1, terminal: true },
  ]);
  for (const forbidden of ["@", "origo", "DataCentral 3.0.0", "Admin Report", "nope"]) assert.ok(lines.every((line) => !line.includes(forbidden)), `a log line must not carry: ${forbidden}`);
});

test("worker: an error from the store while it settles an accepted batch is not turned into a send failure — the rows keep their lease and go out again when it runs out", async () => {
  const id = await readyCampaign();
  const store = getDeliveryStore();
  const settled: string[] = [];
  const breaking: DeliveryStore = { ...store, markAccepted: async () => { settled.push("accepted"); throw new Error("SQL went away"); } };
  const { transport, calls } = fakeTransport();
  await assert.rejects(processCommunicationBatch(500, { store: breaking, transport }), /SQL went away/);
  assert.deepEqual([calls.length, settled], [1, ["accepted"]], "the run stops where the database failed");
  assert.deepEqual(countByState(memoryDeliveries()), { Processing: 3, Queued: 1 }, "the rows stay with the worker: their lease, not a bogus failure, decides when they go out again");
  assert.ok(memoryDeliveries().every((d) => d.lastErrorCode === undefined), "and no failure was recorded against them");
  for (const d of memoryDeliveries().filter((x) => x.state === "Processing")) d.nextAttemptAt = new Date(Date.now() - 1000).toISOString();
  const again = await quietly(() => processCommunicationBatch(500, { transport }));
  assert.deepEqual([again.recovered, again.accepted, again.completed], [3, 4, [id]]);
});

test("worker: the limit bounds the run — that many rows, never more than 500 in a request or 5000 in a run, and at least one", async () => {
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai", dailyCap: 1_000_000 });
  const sizes: number[] = [];
  let sequence = 0;
  const endless: DeliveryStore = {
    async promoteScheduled() { return []; },
    async recoverStale() { return 0; },
    async claimBatch(size) {
      sizes.push(size);
      return {
        communicationId: "COM-001", templateKey: "product-update", topic: "product-updates", content: productUpdate, locale: "en",
        deliveries: Array.from({ length: size }, () => ({ id: `d${++sequence}`, email: `u${sequence}@origo.is`, displayName: null, source: "Member" as const, attemptCount: 1 })),
      };
    },
    async markAccepted() {},
    async markFailed() {},
    async releaseBatch() {},
    async acceptedToday() { return 0; },
    async completeCampaigns() { return []; },
  };
  const run = async (limit: number) => {
    sizes.length = 0;
    const result = await processCommunicationBatch(limit, { store: endless, transport: fakeTransport().transport });
    return { accepted: result.accepted, sizes: [...sizes] };
  };
  assert.deepEqual(await run(1_000_000), { accepted: 5000, sizes: Array(10).fill(500) }, "a run is at most 5000 rows, in requests of 500, with no overshoot");
  assert.deepEqual(await run(1200), { accepted: 1200, sizes: [500, 500, 200] });
  assert.deepEqual(await run(2.7), { accepted: 2, sizes: [2] }, "a fraction is a whole number of rows");
  assert.deepEqual(await run(0), { accepted: 1, sizes: [1] }, "a run takes at least one row");
  assert.deepEqual(await run(-3), { accepted: 1, sizes: [1] });
  assert.deepEqual(await run(Number.NaN), { accepted: 1, sizes: [1] });
});

test("claim: Test rows and real rows never share a batch, whichever is older", async () => {
  await seedAudience();
  await enableSending();
  const store = getDeliveryStore();
  const drain = async () => {
    const batches: string[][] = [];
    for (let batch = await store.claimBatch(500); batch; batch = await store.claimBatch(500)) batches.push([batch.locale, ...batch.deliveries.map((d) => d.source)]);
    return batches;
  };
  const testFirst = await createCommunication(PM, draftInput);
  await testSendCommunication(PM, testFirst.id, []);
  await sendCommunication(PM, testFirst.id, {});
  assert.deepEqual(await drain(), [["en", "Test"], ["en", "Member", "Member", "Member"], ["is", "Contact"]], "an older Test row goes alone, and the real rows of its locale after it");
  const realFirst = await createCommunication(PM, draftInput);
  await sendCommunication(PM, realFirst.id, {});
  await testSendCommunication(PM, realFirst.id, []);
  assert.deepEqual(await drain(), [["en", "Member", "Member", "Member"], ["is", "Contact"], ["en", "Test"]], "an older real row goes without the Test row of its locale, which follows alone");
});

test("claim: a batch never mixes campaigns, even when two are sending to the same locale; the older campaign goes first", async () => {
  await seedAudience();
  await enableSending();
  const first = await createCommunication(PM, draftInput);
  const second = await createCommunication(PM, draftInput);
  await sendCommunication(PM, first.id, {});
  await sendCommunication(PM, second.id, {});
  const store = getDeliveryStore();
  const batches: Array<[string, string, number]> = [];
  for (let batch = await store.claimBatch(500); batch; batch = await store.claimBatch(500)) batches.push([batch.communicationId, batch.locale, batch.deliveries.length]);
  assert.deepEqual(batches, [[first.id, "en", 3], [first.id, "is", 1], [second.id, "en", 3], [second.id, "is", 1]]);
});

test("claim: a claimed row is leased for fifteen minutes, and accepting or failing it ends the lease", async () => {
  await readyCampaign();
  const store = getDeliveryStore();
  assert.equal(LEASE_MS, 15 * 60_000);
  const before = Date.now();
  const batch = (await store.claimBatch(2))!;
  const after = Date.now();
  const claimed = batch.deliveries.map((d) => memoryDeliveries().find((r) => r.id === d.id)!);
  assert.equal(claimed.length, 2);
  for (const d of claimed) {
    const lease = new Date(d.nextAttemptAt!).getTime();
    assert.ok(d.state === "Processing" && lease >= before + LEASE_MS && lease <= after + LEASE_MS, "the lease runs LEASE_MS from the claim");
  }
  assert.ok(memoryDeliveries().filter((d) => d.state === "Queued").every((d) => !d.nextAttemptAt), "a row nobody claimed has none");
  const [accepted, failed] = claimed;
  await store.markAccepted([accepted.id], "msg-1", new Date());
  assert.equal(accepted.nextAttemptAt, null, "accepting clears the lease");
  const retryAt = new Date(Date.now() + 120_000);
  await store.markFailed([failed.id], "HTTP_500", retryAt);
  assert.equal(failed.nextAttemptAt, retryAt.toISOString(), "a failure replaces the lease with the retry time");
});

test("recoverStale: a row whose lease has run out goes back to Retry with its attempts kept; a live lease, one that ends exactly now, no lease and rows in other states are left alone", async () => {
  const id = await readyCampaign();
  const store = getDeliveryStore();
  const english = (await store.claimBatch(500))!; // three rows with the worker
  const icelandic = (await store.claimBatch(500))!; // and one more
  const [a, b, c, d] = [...english.deliveries, ...icelandic.deliveries].map((x) => memoryDeliveries().find((r) => r.id === x.id)!);
  const unleased = deliveryRow(id, "Processing"); // however it got there: with no lease it never runs out
  memoryDeliveries().push(unleased);
  const now = new Date();
  assert.equal(await store.recoverStale(now), 0, "a lease just taken is live");
  a.nextAttemptAt = new Date(now.getTime() - 1).toISOString(); // ran out a millisecond ago
  b.nextAttemptAt = now.toISOString(); // runs out exactly now: not yet
  c.nextAttemptAt = new Date(now.getTime() + 1).toISOString();
  await store.markFailed([d.id], "HTTP_500", new Date(now.getTime() - 5000)); // an ordinary retry whose time has passed is not a stale lease
  assert.equal(await store.recoverStale(now), 1);
  assert.deepEqual([a.state, a.nextAttemptAt, a.attemptCount, a.lastErrorCode], ["Retry", null, 1, undefined], "due at once, attempts kept");
  assert.deepEqual([b.state, c.state, d.state, unleased.state], ["Processing", "Processing", "Retry", "Processing"]);
  assert.equal(await store.recoverStale(new Date(now.getTime() + 2)), 2, "b and c have run out by then; d is not Processing");
  assert.deepEqual([b.state, c.state, unleased.state], ["Retry", "Retry", "Processing"]);
  assert.equal(await store.recoverStale(new Date(now.getTime() + LEASE_MS * 10)), 0, "nothing is recovered twice");
  const again = (await store.claimBatch(500))!;
  assert.deepEqual(again.deliveries.map((x) => [x.email, x.attemptCount]), [["bjarki@uidata.com", 2], ["jon@origo.is", 2], ["anna@advania.is", 2]], "the recovered rows are claimed again and the attempt is counted");
});

test("recoverStale: a claim that ran out on the last attempt makes a dead letter, and a claim on the one before it a retry", async () => {
  const id = await readyCampaign();
  const store = getDeliveryStore();
  const lapsed = new Date(Date.now() - 1000).toISOString();
  const spent = deliveryRow(id, "Processing", { attemptCount: MAX_ATTEMPTS, nextAttemptAt: lapsed });
  const almost = deliveryRow(id, "Processing", { attemptCount: MAX_ATTEMPTS - 1, nextAttemptAt: lapsed });
  const spentTest = deliveryRow(id, "Processing", { attemptCount: MAX_ATTEMPTS, source: "Test", nextAttemptAt: lapsed });
  memoryDeliveries().push(spent, almost, spentTest);
  assert.equal(await store.recoverStale(new Date()), 3);
  assert.deepEqual([spent.state, spent.lastErrorCode, spent.nextAttemptAt, spent.attemptCount], ["Dead letter", "LEASE_EXPIRED", null, MAX_ATTEMPTS], "the fifth claim was the last: a row is not sent for ever when nothing it does settles it");
  assert.deepEqual([almost.state, almost.lastErrorCode, almost.attemptCount], ["Retry", undefined, MAX_ATTEMPTS - 1]);
  assert.deepEqual([spentTest.state, spentTest.lastErrorCode], ["Dead letter", "LEASE_EXPIRED"], "a Test row has the same five attempts");
  assert.equal((await communicationStats(id)).deadLettered, 1, "and it is counted with the dead letters, which a retry can queue again");
});

test("worker: a settle that always fails does not mail a row for ever — five sends, then the lease that runs out makes it a dead letter", async () => {
  await readyCampaign();
  const store = getDeliveryStore();
  const breaking: DeliveryStore = { ...store, markAccepted: async () => { throw new Error("SQL went away"); } };
  const { transport, calls } = fakeTransport();
  const run = () => quietly(() => processCommunicationBatch(500, { store: breaking, transport }));
  await assert.rejects(run(), /SQL went away/, "the database is down every time");
  for (let again = 0; again < 11; again++) {
    for (const d of memoryDeliveries().filter((x) => x.state === "Processing")) d.nextAttemptAt = new Date(Date.now() - 1000).toISOString(); // the lease of the run before runs out
    await run().catch(() => undefined);
  }
  const mailsTo = (email: string) => calls.filter((c) => c.recipients.some((r) => r.email === email)).length;
  assert.deepEqual([mailsTo("bjarki@uidata.com"), mailsTo("cio@origo.is")], [MAX_ATTEMPTS, MAX_ATTEMPTS], "each row went out five times and no more");
  assert.deepEqual(countByState(memoryDeliveries()), { "Dead letter": 4 });
  assert.ok(memoryDeliveries().every((d) => d.lastErrorCode === "LEASE_EXPIRED" && d.attemptCount === MAX_ATTEMPTS));
});

test("recoverStale: the real rows of a cancelled campaign are cancelled, not queued for a claim that never comes; a Test row is still retried", async () => {
  const id = await readyCampaign();
  await testSendCommunication(PM, id, []);
  const store = getDeliveryStore();
  while (await store.claimBatch(500)); // every row is with the worker: the four real ones and the Test row
  assert.deepEqual(countByState(memoryDeliveries()), { Processing: 5 });
  await cancelCommunication(PM, id, "cancel"); // rows with the provider are left alone by a cancel
  assert.deepEqual(countByState(memoryDeliveries()), { Processing: 5 });
  const lastAttempt = memoryDeliveries().find((d) => d.source !== "Test")!;
  lastAttempt.attemptCount = MAX_ATTEMPTS; // even a row on its last attempt is cancelled, not a dead letter
  assert.equal(await store.recoverStale(new Date(Date.now() + LEASE_MS + 1000)), 5);
  assert.deepEqual(memoryDeliveries().map((d) => [d.source === "Test" ? "Test" : "real", d.state, d.nextAttemptAt]).sort(), [
    ["Test", "Retry", null], ["real", "Cancelled", null], ["real", "Cancelled", null], ["real", "Cancelled", null], ["real", "Cancelled", null],
  ]);
  const stats = await communicationStats(id);
  assert.deepEqual([stats.queued, stats.cancelled, stats.recipients], [0, 4, 4], "the campaign holds no row that nothing will claim");
  const test = (await store.claimBatch(500))!;
  assert.deepEqual(test.deliveries.map((d) => d.source), ["Test"], "the Test row is claimed whatever its campaign's status is");
  assert.equal(await store.claimBatch(500), null);
});

// ---------------------------------------------------------------------------------------------------------------------
// The suppression list and safe mode at claim time. The freeze decides who is in the audience, but a row can wait long after it (a backoff, the
// daily cap, a dead letter that is requeued days later), and what has happened to its address meanwhile must still hold.
// ---------------------------------------------------------------------------------------------------------------------

/** The addresses a transport was handed, over all its requests. */
const sentTo = (calls: OutboundBatch[]) => calls.flatMap((call) => call.recipients.map((r) => r.email)).sort();
/** The real (non-test) delivery row of an address. */
const realRow = (email: string) => memoryDeliveries().find((d) => d.email === email && d.source !== "Test")!;

test("blockedReason: the suppression list's reason comes first, then safe mode, and the address is compared whatever its case — the one rule of the freeze and of the claim", () => {
  const list = new Map<string, SuppressionReason>([["blocked@origo.is", "Bounced"]]);
  const on = { enabled: true, allowedDomains: ["datacentral.ai"] };
  const off = { enabled: false, allowedDomains: [] };
  assert.equal(blockedReason("Blocked@Origo.IS", list, on), "Bounced", "on the list, in any case, and the list's reason wins over safe mode");
  assert.equal(blockedReason("Blocked@Origo.IS", list, off), "Bounced", "with safe mode off as well");
  assert.equal(blockedReason("someone@origo.is", list, on), "SafeMode", "not on the list, outside the allowed domains");
  assert.equal(blockedReason("Someone@DataCentral.AI", list, on), null, "inside them, whatever the case");
  assert.equal(blockedReason("x@datacentral.ai.attacker.com", list, on), "SafeMode", "the whole domain is compared");
  assert.equal(blockedReason("someone@origo.is", list, off), null, "safe mode off lets an address that is not on the list through");
  assert.equal(blockedReason("someone@origo.is", new Map(), on), "SafeMode");
});

test("claim: an address suppressed after the freeze is settled as Suppressed instead of being claimed — the transport never sees it, the others go out, the campaign completes", async () => {
  const id = await readyCampaign(); // bjarki, jon and anna (English) and cio (Icelandic), all Queued
  await suppressAddress("anna@advania.is", "Unsubscribed", "Webhook"); // an unsubscribe reported through another campaign, after this one was sent
  const { transport, calls } = fakeTransport();
  const result = await processCommunicationBatch(500, { transport });
  assert.deepEqual(sentTo(calls), ["bjarki@uidata.com", "cio@origo.is", "jon@origo.is"], "anna was not handed to the transport");
  const anna = realRow("anna@advania.is");
  assert.deepEqual([anna.state, anna.suppressedReason, anna.attemptCount, anna.nextAttemptAt ?? null, anna.providerMessageId ?? null], ["Suppressed", "Unsubscribed", 0, null, null], "settled with the list's reason, never claimed, never sent");
  assert.deepEqual(countByState(memoryDeliveries()), { Accepted: 3, Suppressed: 1 });
  assert.deepEqual([result.accepted, result.completed], [3, [id]], "a Suppressed row is settled, so the campaign completes in the same run");
  assert.equal((await getCommunication(PM, id)).status, "Sent");
  const stats = await communicationStats(id);
  assert.deepEqual([stats.recipients, stats.accepted, stats.suppressed], [3, 3, 1], "and the stats count it with the suppressed, not as a recipient");
});

test("claim: a campaign whose last waiting rows are all suppressed completes without a request being made", async () => {
  const id = await readyCampaign();
  for (const email of ["bjarki@uidata.com", "jon@origo.is", "anna@advania.is", "cio@origo.is"]) await suppressAddress(email, "SpamReport", "Webhook");
  const { transport, calls } = fakeTransport();
  const result = await processCommunicationBatch(500, { transport });
  assert.deepEqual([calls.length, result.accepted, result.completed], [0, 0, [id]]);
  assert.deepEqual(countByState(memoryDeliveries()), { Suppressed: 4 });
  assert.equal((await getCommunication(PM, id)).status, "Sent");
});

test("claim: safe mode turned on after the freeze holds back the rows outside its list as Suppressed/SafeMode, and a suppression keeps its own reason", async () => {
  const id = await readyCampaign(); // frozen with safe mode off
  await suppressAddress("anna@advania.is", "Bounced", "Webhook"); // outside the list as well: the list's reason wins, as it does in the audience
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai", unsubscribeGroupId: 42, safeMode: { enabled: true, allowedDomains: ["Origo.IS"] } });
  const { transport, calls } = fakeTransport();
  const result = await processCommunicationBatch(500, { transport });
  assert.deepEqual(sentTo(calls), ["cio@origo.is", "jon@origo.is"], "only the allow-listed domain is mailed");
  assert.deepEqual(["bjarki@uidata.com", "anna@advania.is"].map((email) => [realRow(email).state, realRow(email).suppressedReason]), [["Suppressed", "SafeMode"], ["Suppressed", "Bounced"]]);
  assert.deepEqual(countByState(memoryDeliveries()), { Accepted: 2, Suppressed: 2 });
  assert.deepEqual([result.accepted, result.completed], [2, [id]]);
});

test("claim: with safe mode off and nobody suppressed the claim settles nothing — the audience goes out whole", async () => {
  await readyCampaign();
  await suppressAddress("stranger@elsewhere.example", "Manual", "Admin"); // on the list, but not in this campaign
  const { transport, calls } = fakeTransport();
  await processCommunicationBatch(500, { transport });
  assert.deepEqual(sentTo(calls), ["anna@advania.is", "bjarki@uidata.com", "cio@origo.is", "jon@origo.is"]);
  assert.deepEqual(countByState(memoryDeliveries()), { Accepted: 4 });
});

test("claim: a dead letter requeued after its address was suppressed stays suppressed — a retry goes through the same claim", async () => {
  const id = await readyCampaign();
  const store = getDeliveryStore();
  const english = (await store.claimBatch(500))!; // bjarki, jon and anna are with the worker
  await store.markFailed(english.deliveries.map((d) => d.id), "HTTP_400", null); // and come back as dead letters
  assert.equal((await communicationStats(id)).deadLettered, 3);
  await suppressAddress("jon@origo.is", "SpamReport", "Webhook"); // jon reports a mail from another campaign afterwards
  assert.deepEqual(await retryDeadLetters(PM, id), { requeued: 3, reopened: false });
  const { transport, calls } = fakeTransport();
  const result = await processCommunicationBatch(500, { transport });
  assert.deepEqual(sentTo(calls), ["anna@advania.is", "bjarki@uidata.com", "cio@origo.is"], "jon is not mailed by the retry");
  const jon = realRow("jon@origo.is");
  assert.deepEqual([jon.state, jon.suppressedReason, jon.attemptCount, jon.lastErrorCode ?? null], ["Suppressed", "SpamReport", 0, null], "the requeue started his attempts over, and the claim settled him before the first");
  assert.deepEqual([result.accepted, result.completed], [3, [id]]);
});

test("claim: a Sent campaign that a retry reopens settles the dead letter whose address was suppressed meanwhile, and completes again", async () => {
  const id = await readyCampaign();
  await processCommunicationBatch(500, { transport: fakeTransport().transport }); // everything is accepted: the campaign is Sent
  assert.equal((await getCommunication(PM, id)).status, "Sent");
  Object.assign(realRow("jon@origo.is"), { state: "Dead letter", lastErrorCode: "HTTP_500", providerMessageId: null, acceptedAt: null }); // as if the provider had refused it for good
  await suppressAddress("jon@origo.is", "Unsubscribed", "Webhook");
  assert.deepEqual(await retryDeadLetters(PM, id), { requeued: 1, reopened: true });
  assert.equal((await getCommunication(PM, id)).status, "Sending");
  const { transport, calls } = fakeTransport();
  const result = await processCommunicationBatch(500, { transport });
  assert.deepEqual([calls.length, result.accepted, result.completed], [0, 0, [id]], "nothing is requested, and the reopened campaign completes again");
  assert.deepEqual([realRow("jon@origo.is").state, realRow("jon@origo.is").suppressedReason], ["Suppressed", "Unsubscribed"]);
  assert.equal((await getCommunication(PM, id)).status, "Sent");
});

test("claim: a row waiting for its next attempt is settled too; a Test row is not held to the list or to safe mode; a row of a campaign that is not sending is left alone", async () => {
  const id = await readyCampaign();
  const store = getDeliveryStore();
  const english = (await store.claimBatch(500))!; // bjarki, jon, anna
  await store.markFailed([english.deliveries[0].id], "HTTP_429", new Date(Date.now() + 3_600_000)); // bjarki waits in Retry for an hour
  await store.releaseBatch(english.deliveries.slice(1).map((d) => d.id)); // jon and anna are Queued again
  await testSendCommunication(PM, id, []); // a test mail to pm@datacentral.ai
  const draft = await createCommunication(PM, draftInput);
  memoryDeliveries().push(deliveryRow(draft.id, "Queued", { email: "anna@advania.is" })); // a draft's real row: nothing claims it
  for (const email of ["bjarki@uidata.com", "anna@advania.is", PM.email]) await suppressAddress(email, "Manual", "Admin");
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai", unsubscribeGroupId: 42, safeMode: { enabled: true, allowedDomains: ["origo.is"] } });
  const claimed: string[][] = [];
  for (let batch = await store.claimBatch(500); batch; batch = await store.claimBatch(500)) claimed.push(batch.deliveries.map((d) => d.email));
  assert.deepEqual(claimed, [["jon@origo.is"], ["cio@origo.is"], [PM.email]], "jon and cio are inside the list; the Test row is claimed although its address is suppressed and outside it");
  const real = memoryDeliveries().filter((d) => d.communicationId === id && d.source !== "Test");
  assert.deepEqual(real.map((d) => [d.email, d.state, d.suppressedReason ?? null]).sort(), [
    ["anna@advania.is", "Suppressed", "Manual"], ["bjarki@uidata.com", "Suppressed", "Manual"], ["cio@origo.is", "Processing", null], ["jon@origo.is", "Processing", null],
  ], "bjarki's Retry row was settled although it was not due; anna's Queued one with it");
  assert.equal(realRow("bjarki@uidata.com").nextAttemptAt ?? null, null, "a settled row has no next attempt");
  assert.equal(memoryDeliveries().find((d) => d.communicationId === draft.id)!.state, "Queued", "the draft's row was not touched");
  assert.equal(memoryDeliveries().find((d) => d.source === "Test")!.state, "Processing");
});

test("worker store, SQL: a claim first settles the waiting real rows of sending campaigns — those on the suppression list in one joined statement, those outside safe mode's list by id — and then claims", async () => {
  const stored = (safeMode: { enabled: boolean; allowedDomains: string[] }): SqlAnswers[number] => [/FROM dbo\.Settings/, { recordset: [{ value: JSON.stringify({ ...DEFAULT_COMMUNICATION_SETTINGS, safeMode }) }] }];
  const waiting = [
    { id: "AAAAAAAA-0000-4000-8000-000000000001", email: "inside@datacentral.ai" },
    { id: "AAAAAAAA-0000-4000-8000-000000000002", email: "Mixed.Case@DataCentral.AI" },
    { id: "AAAAAAAA-0000-4000-8000-000000000003", email: "out@evil-datacentral.ai" },
    { id: "AAAAAAAA-0000-4000-8000-000000000004", email: "out@datacentral.ai.attacker.com" },
    { id: "AAAAAAAA-0000-4000-8000-000000000005", email: "out@origo.is" },
  ];
  const readWaiting = /^SELECT CAST\(d\.id AS nvarchar\(36\)\) id,d\.email/;
  const kinds = (calls: SqlCall[]) => calls.map((c) =>
    /JOIN dbo\.CommunicationSuppressions s ON s\.email=d\.email/.test(c.text) ? "list" : /FROM dbo\.Settings/.test(c.text) ? "settings" : readWaiting.test(c.text) ? "waiting"
      : /suppressed_reason='SafeMode'/.test(c.text) ? "safe-mode" : /WITH next_campaign AS/.test(c.text) ? "claim" : "other");
  const text = (call: SqlCall) => call.text.replace(/\s+/g, " ").trim();
  await withFakeSql([stored({ enabled: true, allowedDomains: ["DataCentral.AI"] }), [readWaiting, { recordset: waiting }], [/WITH next_campaign AS/, { recordset: [] }]], async (calls) => {
    assert.equal(await getDeliveryStore().claimBatch(5), null);
    assert.deepEqual(kinds(calls), ["list", "settings", "waiting", "safe-mode", "claim"], "the list first, then the settings, the waiting rows, the rows outside safe mode, and last the claim");
    assert.ok(calls.every((c) => !c.inTransaction), "each statement stands on its own: the claim cannot run in a unit of work");
    const [bySuppression, , read, bySafeMode] = calls;
    assert.equal(text(bySuppression),
      "UPDATE d SET state='Suppressed',suppressed_reason=s.reason,next_attempt_at=NULL FROM dbo.CommunicationDeliveries d JOIN dbo.Communications c WITH (READCOMMITTEDLOCK) ON c.id=d.communication_id AND c.deleted_at IS NULL AND c.status='Sending' JOIN dbo.CommunicationSuppressions s ON s.email=d.email WHERE d.state IN ('Queued','Retry') AND d.source<>'Test'",
      "an address on the list: its reason, no next attempt; only real rows that are waiting, of a live campaign that is sending");
    assert.match(text(read), /c\.status='Sending' WHERE d\.state IN \('Queued','Retry'\) AND d\.source<>'Test'$/, "the waiting real rows of sending campaigns");
    assert.deepEqual(JSON.parse(String(bySafeMode.inputs.ids)), [waiting[2].id, waiting[3].id, waiting[4].id], "the rows outside the list, by the rule the audience uses: the whole domain, whatever its case");
    assert.equal(text(bySafeMode), "UPDATE dbo.CommunicationDeliveries SET state='Suppressed',suppressed_reason='SafeMode',next_attempt_at=NULL WHERE state IN ('Queued','Retry') AND source<>'Test' AND id IN (SELECT TRY_CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@ids))", "and a row that was claimed or settled in between is left alone");
  });
  // Safe mode off: the list is all that is asked before the claim.
  await withFakeSql([stored({ enabled: false, allowedDomains: [] }), [readWaiting, { recordset: waiting }], [/WITH next_campaign AS/, { recordset: [] }]], async (calls) => {
    assert.equal(await getDeliveryStore().claimBatch(5), null);
    assert.deepEqual(kinds(calls), ["list", "settings", "claim"]);
  });
  // Safe mode on and every waiting row inside the list: nothing is updated by id.
  await withFakeSql([stored({ enabled: true, allowedDomains: ["datacentral.ai"] }), [readWaiting, { recordset: waiting.slice(0, 2) }], [/WITH next_campaign AS/, { recordset: [] }]], async (calls) => {
    assert.equal(await getDeliveryStore().claimBatch(5), null);
    assert.deepEqual(kinds(calls), ["list", "settings", "waiting", "claim"]);
  });
  // More rows outside the list than one statement takes are settled in pieces of 1000.
  const many = Array.from({ length: 2500 }, (_, n) => ({ id: `AAAAAAAA-0000-4000-8000-${String(n).padStart(12, "0")}`, email: `out${n}@origo.is` }));
  await withFakeSql([stored({ enabled: true, allowedDomains: ["datacentral.ai"] }), [readWaiting, { recordset: many }], [/WITH next_campaign AS/, { recordset: [] }]], async (calls) => {
    assert.equal(await getDeliveryStore().claimBatch(5), null);
    assert.deepEqual(calls.filter((c) => /suppressed_reason='SafeMode'/.test(c.text)).map((c) => (JSON.parse(String(c.inputs.ids)) as string[]).length), [1000, 1000, 500]);
  });
});

test("worker store, SQL: a claim keeps Test and real rows apart where it picks and where it claims, and leases what it takes", async () => {
  await withFakeSql([[/WITH next_campaign AS/, { recordset: [] }]], async (calls) => {
    assert.equal(await getDeliveryStore().claimBatch(5), null);
    const claim = calls.find((c) => /WITH next_campaign AS/.test(c.text))!;
    assert.match(claim.text, /SELECT TOP \(1\) d\.communication_id,d\.locale,d\.source FROM dbo\.CommunicationDeliveries d WITH \(UPDLOCK,READPAST,ROWLOCK\)/, "the first row's source is carried along");
    assert.match(claim.text, /SELECT TOP \(@size\) d\.id,n\.source FROM dbo\.CommunicationDeliveries d\s+JOIN next_campaign n ON n\.communication_id=d\.communication_id AND n\.locale=d\.locale AND \(CASE WHEN d\.source='Test' THEN 1 ELSE 0 END\)=\(CASE WHEN n\.source='Test' THEN 1 ELSE 0 END\)/, "the pick is of the first row's campaign, locale and kind");
    assert.match(claim.text, /WHERE d\.state IN \('Queued','Retry'\) AND \(c\.status='Sending' OR d\.source='Test'\) AND \(CASE WHEN d\.source='Test' THEN 1 ELSE 0 END\)=\(CASE WHEN q\.source='Test' THEN 1 ELSE 0 END\);\s*$/, "and the UPDATE claims only rows of that kind");
    assert.equal(claim.text.match(/CASE WHEN d\.source='Test' THEN 1 ELSE 0 END/g)?.length, 2, "the kind is compared in the pick and in the claim, nowhere else");
    assert.match(claim.text, /UPDATE d SET state='Processing',attempt_count=attempt_count\+1,next_attempt_at=DATEADD\(second,@lease,SYSUTCDATETIME\(\)\)\s+OUTPUT/, "a claimed row is leased");
    assert.equal(claim.inputs.lease, LEASE_MS / 1000);
    assert.equal(claim.inputs.size, 5);
  });
});

test("worker store, SQL: recoverStale returns lapsed leases to Retry — a cancelled campaign's real rows to Cancelled, a last attempt to Dead letter — and says how many", async () => {
  const at = new Date("2026-10-14T09:00:00Z");
  await withFakeSql([[/WHERE d\.state='Processing'/, { rowsAffected: [3] }]], async (calls, events) => {
    assert.equal(await getDeliveryStore().recoverStale(at), 3);
    const recover = calls.find((c) => /WHERE d\.state='Processing'/.test(c.text))!;
    assert.deepEqual(recover.inputs, { maxAttempts: MAX_ATTEMPTS }, "the only input is the attempt limit: the clock is the database's, the one the claim stamps the lease with");
    assert.match(recover.text, /^UPDATE d SET state=CASE WHEN c\.status='Cancelled' AND d\.source<>'Test' THEN 'Cancelled' WHEN d\.attempt_count>=@maxAttempts THEN 'Dead letter' ELSE 'Retry' END,next_attempt_at=NULL,\s+last_error_code=CASE WHEN d\.attempt_count>=@maxAttempts THEN 'LEASE_EXPIRED' ELSE d\.last_error_code END\s+FROM dbo\.CommunicationDeliveries d JOIN dbo\.Communications c WITH \(READCOMMITTEDLOCK\) ON c\.id=d\.communication_id\s+WHERE d\.state='Processing' AND d\.next_attempt_at<SYSUTCDATETIME\(\)$/,
      "only a lease that has run out by the database's clock; the real rows of a cancelled campaign are cancelled (a cancel that is committing is waited for); a last attempt is a dead letter, with its reason; the attempts are not touched");
    assert.deepEqual(events, [], "one atomic statement, no unit of work");
  });
  await withFakeSql([], async () => assert.equal(await getDeliveryStore().recoverStale(at), 0, "nothing lapsed"));
});

/** The membership answer of a System admin: the delivery status and its retry are for them only (the harness answers as a Product manager unless an earlier entry says otherwise). */
const asSystemAdmin: SqlAnswers = [[/FROM dbo\.Memberships m JOIN dbo\.Organizations o/, { recordset: [{ role: "System admin", allowedAuth: '["OTP","Entra ID"]' }] }]];

test("delivery status, SQL: the Communications channel is counted next to Email and Webhook, for a System admin only", async () => {
  const rows = [{ channel: "Communications", state: "Dead letter", count: 3, oldest: "2026-10-14T08:00:00.000Z" }];
  await withFakeSql([...asSystemAdmin, [/UNION ALL SELECT 'Communications'/, { recordset: rows }]], async (calls) => {
    assert.deepEqual(await deliveryStatus(ADMIN), rows);
    const arms = calls.find((c) => /UNION ALL SELECT 'Communications'/.test(c.text))!.text.split("UNION ALL").map((arm) => arm.replace(/\s+/g, " ").trim());
    assert.equal(arms.length, 3);
    assert.match(arms[0], /^SELECT 'Email' channel,state,COUNT\(\*\) count,MIN\(created_at\) oldest FROM dbo\.Notifications WHERE channel='Email' AND state IN \('Queued','Retry','Processing','Dead letter'\) GROUP BY state$/);
    assert.match(arms[1], /^SELECT 'Webhook' channel,state,COUNT\(\*\) count,MIN\(created_at\) oldest FROM dbo\.WebhookDeliveries WHERE state IN \('Queued','Retry','Processing','Dead letter'\) GROUP BY state$/);
    assert.match(arms[2], /^SELECT 'Communications' channel,d\.state,COUNT\(\*\) count,MIN\(d\.created_at\) oldest FROM dbo\.CommunicationDeliveries d JOIN dbo\.Communications c ON c\.id=d\.communication_id AND c\.status<>'Cancelled' AND c\.deleted_at IS NULL WHERE d\.state IN \('Queued','Retry','Processing','Dead letter'\) GROUP BY d\.state$/,
      "the same campaigns as the retry: rows of a cancelled or deleted campaign are not counted, so the card never shows a dead letter its retry cannot requeue");
  });
  await withFakeSql([], async () => { await assert.rejects(deliveryStatus(PM), /FORBIDDEN/); });
});

test("delivery retry, SQL: the Communications channel requeues the dead letters of live campaigns that are not cancelled, reopens completed campaigns with rows waiting again and audits counts, in one unit of work", async () => {
  const correlation = crypto.randomUUID();
  const answers: SqlAnswers = [...asSystemAdmin, [/^UPDATE TOP\(100\) d SET state='Queued'/, { recordset: [{ id: "1" }, { id: "2" }, { id: "3" }] }], [/^UPDATE c SET status='Sending'/, { rowsAffected: [2] }]];
  await withFakeSql(answers, async (calls, events) => {
    assert.deepEqual(await retryDeliveries(ADMIN, "Communications", correlation), { requeued: 3 });
    const [requeue, reopen, audit, ...more] = sqlWrites(calls);
    assert.equal(more.length, 0);
    assert.match(requeue.text, /^UPDATE TOP\(100\) d SET state='Queued',attempt_count=0,next_attempt_at=NULL,last_error_code=NULL OUTPUT INSERTED\.id\s+FROM dbo\.CommunicationDeliveries d JOIN dbo\.Communications c ON c\.id=d\.communication_id AND c\.status<>'Cancelled' AND c\.deleted_at IS NULL\s+WHERE d\.state='Dead letter'$/,
      "a cancelled or deleted campaign's rows would never be claimed, so they are not requeued; the rows start their attempts over");
    assert.match(reopen.text, /^UPDATE c SET status='Sending',completed_at=NULL,updated_at=SYSUTCDATETIME\(\)\s+FROM dbo\.Communications c\s+WHERE c\.status='Sent' AND c\.deleted_at IS NULL\s+AND EXISTS \(SELECT 1 FROM dbo\.CommunicationDeliveries d WHERE d\.communication_id=c\.id AND d\.source<>'Test' AND d\.state IN \('Queued','Retry','Processing'\)\)$/,
      "a completed campaign with a real row waiting is Sending again; a Test row alone does not reopen it");
    assert.match(audit.text, /INSERT dbo\.AuditEvents\(id,actor_user_id,action,entity_type,after_json,correlation_id\) VALUES\(NEWID\(\),@actor,'delivery\.retry\.requested','Delivery',@after,@correlation\)/);
    assert.deepEqual([audit.inputs.actor, audit.inputs.correlation, JSON.parse(String(audit.inputs.after))], [ADMIN.id, correlation, { channel: "Communications", count: 3, reopened: 2 }], "the audit row holds counts only");
    assert.deepEqual([requeue, reopen, audit].map((c) => c.inTransaction), [true, true, true]);
    assert.deepEqual(events, ["begin", "commit"]);
  });
  await withFakeSql([...asSystemAdmin, [/^UPDATE TOP\(100\) d SET state='Queued'/, { recordset: [] }]], async (calls) => {
    assert.deepEqual(await retryDeliveries(ADMIN, "Communications", correlation), { requeued: 0 });
    assert.equal(sqlWrites(calls).filter((c) => /^UPDATE c SET status='Sending'/.test(c.text)).length, 0, "nothing requeued, nothing to reopen");
    assert.deepEqual(JSON.parse(String(sqlWrites(calls).at(-1)!.inputs.after)), { channel: "Communications", count: 0, reopened: 0 });
  });
});

test("delivery retry: Email and Webhook still run their own statements, an unknown channel is refused, and only a System admin may retry", async () => {
  const correlation = crypto.randomUUID();
  await withFakeSql([...asSystemAdmin, [/^UPDATE TOP\(100\) dbo\./, { recordset: [{ id: "1" }] }]], async (calls) => {
    assert.deepEqual(await retryDeliveries(ADMIN, "Email", correlation), { requeued: 1 });
    assert.deepEqual(await retryDeliveries(ADMIN, "Webhook", correlation), { requeued: 1 });
    const [email, webhook] = sqlWrites(calls).filter((c) => /^UPDATE TOP\(100\) dbo\./.test(c.text));
    assert.match(email.text, /^UPDATE TOP\(100\) dbo\.Notifications SET state='Retry',attempt_count=0,next_attempt_at=SYSUTCDATETIME\(\),last_error_code=NULL OUTPUT INSERTED\.id WHERE state='Dead letter' AND channel='Email'\s*$/);
    assert.match(webhook.text, /^UPDATE TOP\(100\) dbo\.WebhookDeliveries SET state='Retry',attempt_count=0,next_attempt_at=SYSUTCDATETIME\(\),last_error_code=NULL OUTPUT INSERTED\.id WHERE state='Dead letter'\s*$/);
    assert.deepEqual(sqlWrites(calls).filter((c) => /dbo\.AuditEvents/.test(c.text)).map((c) => JSON.parse(String(c.inputs.after))), [{ channel: "Email", count: 1 }, { channel: "Webhook", count: 1 }]);
    assert.equal(sqlWrites(calls).some((c) => /dbo\.Communications/.test(c.text)), false, "they never touch a campaign");
    await assert.rejects(retryDeliveries(ADMIN, "Fax" as never, correlation), /INVALID_CHANNEL/);
  });
  await withFakeSql([], async () => { await assert.rejects(retryDeliveries(PM, "Communications", correlation), /FORBIDDEN/); });
  assert.deepEqual(await retryDeliveries(ADMIN, "Communications", correlation), { requeued: 0 }, "without SQL there is nothing to requeue");
  assert.deepEqual(await deliveryStatus(ADMIN), []);
});

test("i18n: the Settings delivery card names the Communications channel", () => {
  assert.equal(makeT("is")("Communications"), "Samskipti");
  assert.equal(makeT("en")("Communications"), "Communications");
});

// ---------------------------------------------------------------------------------------------------------------------
// A rejected batch: a refused key gives it back, a rejected recipient is found by splitting it, each row is settled by its own attempts
// ---------------------------------------------------------------------------------------------------------------------

/** The delivery row of an address (the first, when a campaign has several). */
const rowOf = (email: string) => memoryDeliveries().find((d) => d.email === email)!;
const englishAddresses = () => memoryDeliveries().filter((d) => d.locale === "en" && d.source !== "Test").map((d) => d.email);
const isIcelandic = (call: OutboundBatch) => call.recipients.some((r) => r.email === "cio@origo.is");

for (const status of [401, 403] as const) {
  test(`worker: a ${status === 401 ? "refused key (401)" : "sender the provider will not accept (403)"} gives the batch back unclaimed, stops the tick and dead-letters nothing`, async () => {
    const id = await readyCampaign();
    const { transport, calls } = fakeTransport([{ status }, { status }]);
    const { value: result, lines } = await captured("error", () => processCommunicationBatch(500, { transport }));
    assert.deepEqual(result, { skipped: false, promoted: [], accepted: 0, retried: 0, deadLettered: 0, completed: [], capReached: false, recovered: 0, splits: 0 });
    assert.equal(calls.length, 1, "the tick stops at the first refusal: the Icelandic batch is never tried");
    assert.deepEqual(countByState(memoryDeliveries()), { Queued: 4 }, "every row is waiting again");
    assert.ok(memoryDeliveries().every((d) => d.attemptCount === 0 && !d.nextAttemptAt && d.lastErrorCode === undefined), "with the attempts it had: the refusal is not the rows' fault");
    assert.equal((await getCommunication(PM, id)).status, "Sending", "and the campaign is still sending, not completed with nothing sent");
    assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ level: "error", event: "communications.send.misconfigured", communicationId: id, code: `HTTP_${status}`, recipients: 3 }], "the code is logged once, with a count and the campaign");
    assert.ok(lines.every((line) => !line.includes("@") && !line.includes("origo")));
    const fixed = fakeTransport(); // the key is right again: the same rows go out, and each has been tried once
    const next = await processCommunicationBatch(500, { transport: fixed.transport });
    assert.deepEqual([next.accepted, next.completed], [4, [id]]);
    assert.ok(memoryDeliveries().every((d) => d.state === "Accepted" && d.attemptCount === 1));
  });
}

test("worker: a refusal in the middle of a split gives back the half that was refused and what was never tried, and keeps what was accepted", async () => {
  const id = await readyCampaignWith(1); // four English rows and the Icelandic one
  const { transport, calls } = fakeTransport([{ status: 400 }, "ok", { status: 401 }]); // the request is rejected, its first half accepted, its second half refused
  const { value: result, lines } = await captured("error", () => processCommunicationBatch(500, { transport }));
  assert.deepEqual([result.accepted, result.splits, result.retried, result.deadLettered, result.capReached], [2, 2, 0, 0, false]);
  assert.deepEqual(calls.map((c) => c.recipients.length), [4, 2, 2], "the request and its two halves; the tick stopped there");
  const [accepted, refused] = [calls[1], calls[2]].map((c) => c.recipients.map((r) => rowOf(r.email)));
  assert.ok(accepted.every((d) => d.state === "Accepted" && d.attemptCount === 1 && d.providerMessageId === "msg-2"));
  assert.ok(refused.every((d) => d.state === "Queued" && d.attemptCount === 0 && !d.nextAttemptAt), "the refused half is given back with its attempts as they were");
  assert.deepEqual([rowOf("cio@origo.is").state, rowOf("cio@origo.is").attemptCount], ["Queued", 0], "and the Icelandic row was not claimed");
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ level: "error", event: "communications.send.misconfigured", communicationId: id, code: "HTTP_401", recipients: 2 }]);
});

test("worker: a refusal of the first half of a split gives back both halves, the second never having been tried", async () => {
  await readyCampaignWith(1);
  const { transport, calls } = fakeTransport([{ status: 400 }, { status: 403 }]);
  const result = await quietly(() => processCommunicationBatch(500, { transport }));
  assert.deepEqual([result.accepted, result.splits, result.retried, result.deadLettered], [0, 1, 0, 0]);
  assert.equal(calls.length, 2);
  assert.deepEqual(countByState(memoryDeliveries()), { Queued: 5 });
  assert.ok(memoryDeliveries().every((d) => d.attemptCount === 0), "nothing was tried that stays tried");
});

test("worker: a throttle in the middle of a split settles the half that was throttled, gives back the half that was never tried and stops the tick", async () => {
  await readyCampaignWith(1);
  const start = Date.now();
  const { transport, calls } = fakeTransport([{ status: 400 }, { status: 429, retryAfter: 60 }]);
  const result = await quietly(() => processCommunicationBatch(500, { transport, now: () => new Date(start) }));
  assert.deepEqual([result.accepted, result.retried, result.deadLettered, result.splits, result.capReached], [0, 2, 0, 1, false]);
  assert.equal(calls.length, 2, "the other half and the Icelandic row wait for the next tick");
  const throttledAddresses = calls[1].recipients.map((r) => r.email);
  const throttled = throttledAddresses.map((email) => rowOf(email));
  const untried = englishAddresses().filter((email) => !throttledAddresses.includes(email)).map((email) => rowOf(email));
  assert.equal(untried.length, 2);
  assert.ok(throttled.every((d) => d.state === "Retry" && d.attemptCount === 1 && d.lastErrorCode === "HTTP_429" && new Date(d.nextAttemptAt!).getTime() === start + 2 * BACKOFF_BASE_MS), "the throttled half waits, by the backoff of its first attempt");
  assert.ok(untried.every((d) => d.state === "Queued" && d.attemptCount === 0), "the half that was never tried is given back");
});

test("worker: a request rejected with 400 is split in halves until the rejected recipient stands alone; only that row is a dead letter, the others are accepted with message ids of their own", async () => {
  const id = await readyCampaignWith(1); // four English rows and the Icelandic one
  const english = englishAddresses();
  assert.equal(english.length, 4);
  const bad = english[2];
  const { transport, calls } = pickyTransport((email) => email === bad);
  const result = await quietly(() => processCommunicationBatch(500, { transport }));
  assert.deepEqual([result.accepted, result.deadLettered, result.retried, result.splits], [4, 1, 0, 4], "three English rows and the Icelandic one are accepted, the bad address is a dead letter");
  const englishCalls = calls.filter((c) => !isIcelandic(c));
  assert.deepEqual(englishCalls.map((c) => c.recipients.length), [4, 2, 2, 1, 1], "the request, its two halves, and the two recipients of the half that holds the bad address");
  assert.equal(calls.length, 6, "and one request for the Icelandic row");
  assert.equal(new Set(englishCalls.map((c) => c.html + c.subject + c.text)).size, 1, "every request carries the same rendered mail");
  assert.deepEqual([rowOf(bad).state, rowOf(bad).lastErrorCode, rowOf(bad).attemptCount], ["Dead letter", "HTTP_400", 1]);
  const good = english.filter((e) => e !== bad);
  assert.ok(good.every((e) => rowOf(e).state === "Accepted" && rowOf(e).attemptCount === 1));
  assert.equal(new Set(good.map((e) => rowOf(e).providerMessageId)).size, 2, "the good half, and the good one of the other half, were accepted by requests of their own");
  assert.deepEqual(result.completed, [id], "every row is settled, so the campaign completes");
  assert.deepEqual([(await communicationStats(id)).deadLettered, (await communicationStats(id)).accepted], [1, 4]);
});

test("worker: finding one rejected recipient costs two requests per level of the split — 6 more for a batch of 8", async () => {
  await readyCampaignWith(5); // eight English rows and the Icelandic one
  const english = englishAddresses();
  assert.equal(english.length, 8);
  const { transport, calls } = pickyTransport((email) => email === english[5]);
  const result = await quietly(() => processCommunicationBatch(500, { transport }));
  assert.deepEqual([result.accepted, result.deadLettered, result.splits], [8, 1, 6]);
  assert.deepEqual(calls.filter((c) => !isIcelandic(c)).map((c) => c.recipients.length), [8, 4, 4, 2, 1, 1, 2], "the request, its good half, its bad half, that half's first half, its two recipients, and the good rest");
});

test("worker: two rejected recipients at the far ends of a batch of 16 cost 14 more requests, and nobody else is a dead letter", async () => {
  await readyCampaignWith(13); // sixteen English rows and the Icelandic one
  const english = englishAddresses();
  assert.equal(english.length, 16);
  const { transport } = pickyTransport((email) => email === english[0] || email === english[15]);
  const result = await quietly(() => processCommunicationBatch(500, { transport }));
  assert.deepEqual([result.accepted, result.deadLettered, result.retried, result.splits], [15, 2, 0, 14], "2 + 4 + 4 + 4: about 2 x log2(16) for each bad address, the top levels shared");
  assert.deepEqual(memoryDeliveries().filter((d) => d.state === "Dead letter").map((d) => d.email).sort(), [english[0], english[15]].sort());
});

test("worker: the splitting of one batch is capped, and what it has not isolated by then waits for the next tick instead of being dead-lettered", async () => {
  await readyCampaignWith(37); // forty English rows and the Icelandic one
  const start = Date.now();
  const { transport, calls } = pickyTransport(() => true); // every request is rejected, as one for a message the provider will not take at all: the whole tree of 79 requests would be needed
  const result = await quietly(() => processCommunicationBatch(500, { transport, now: () => new Date(start) }));
  assert.equal(result.splits, MAX_SPLIT_REQUESTS, "the extra requests stop at the cap");
  assert.equal(calls.filter((c) => !isIcelandic(c)).length, 1 + MAX_SPLIT_REQUESTS);
  assert.equal(result.accepted, 0);
  const english = memoryDeliveries().filter((d) => d.locale === "en");
  const dead = english.filter((d) => d.state === "Dead letter");
  const waiting = english.filter((d) => d.state === "Retry");
  assert.equal(dead.length + waiting.length, 40, "every English row is settled one way or the other");
  assert.ok(dead.length > 0 && waiting.length > 0, "some were rejected on their own; the rest were not isolated");
  assert.ok(dead.every((d) => d.lastErrorCode === "HTTP_400" && d.attemptCount === 1));
  assert.ok(waiting.every((d) => d.lastErrorCode === "HTTP_400" && d.attemptCount === 1 && new Date(d.nextAttemptAt!).getTime() === start + 2 * BACKOFF_BASE_MS), "they try again by the backoff of their first attempt, and are dead letters only after the fifth");
  assert.equal(rowOf("cio@origo.is").state, "Dead letter", "a recipient alone is a dead letter at once");
  assert.deepEqual([result.deadLettered, result.retried], [dead.length + 1, waiting.length]);
});

for (const status of [413, 422]) {
  test(`worker: an answer of ${status} is split like a 400`, async () => {
    await readyCampaignWith(1);
    const { transport, calls } = fakeTransport([{ status }]); // the request is rejected once, and then its halves are accepted
    const result = await quietly(() => processCommunicationBatch(500, { transport }));
    assert.deepEqual([result.accepted, result.deadLettered, result.splits], [5, 0, 2]);
    assert.deepEqual(calls.map((c) => c.recipients.length), [4, 2, 2, 1]);
  });
}

test("worker: a 5xx is not split, it is retried as a whole; an answer that is no 4xx and not retryable dead-letters the batch at once", async () => {
  await readyCampaignWith(1);
  const first = await quietly(() => processCommunicationBatch(500, { transport: fakeTransport([{ status: 502 }, "ok"]).transport }));
  assert.deepEqual([first.retried, first.deadLettered, first.splits, first.accepted], [4, 0, 0, 1], "the four English rows wait for a retry, the Icelandic one is accepted");
  for (const d of memoryDeliveries()) Object.assign(d, { state: "Queued", attemptCount: 0, nextAttemptAt: null });
  const { transport, calls } = fakeTransport([{ status: 302 }, "ok"]);
  const second = await quietly(() => processCommunicationBatch(500, { transport }));
  assert.deepEqual([second.retried, second.deadLettered, second.splits, second.accepted], [0, 4, 0, 1]);
  assert.deepEqual(calls.map((c) => c.recipients.length), [4, 1]);
});

test("worker: a 429 without a Retry-After waits for X-RateLimit-Reset, measured against the worker's clock", async () => {
  await readyCampaign();
  const at = Date.UTC(2030, 0, 1, 12); // a clock that is not the real one, so that the reset can only be read against the worker's own
  const { transport } = fakeTransport([{ status: 429, reset: at / 1000 + 600 }]);
  await quietly(() => processCommunicationBatch(500, { transport, now: () => new Date(at) }));
  const waits = memoryDeliveries().filter((d) => d.state === "Retry").map((d) => new Date(d.nextAttemptAt!).getTime() - at);
  assert.deepEqual(waits, [600_000, 600_000, 600_000], "longer than the two minutes of the first backoff");
});

test("worker: a failed batch is settled row by row — a row on its last attempt is a dead letter, and the others wait by the backoff of their own attempt", async () => {
  await readyCampaign();
  const start = Date.now();
  const [a, b, c] = ["bjarki@uidata.com", "jon@origo.is", "anna@advania.is"].map(rowOf);
  a.attemptCount = MAX_ATTEMPTS - 1; // the claim makes it the fifth attempt
  b.attemptCount = 1;
  c.attemptCount = 2;
  const store = getDeliveryStore();
  const settled: Array<[number, string, string | null]> = [];
  const recording: DeliveryStore = { ...store, markFailed: async (ids, code, next) => { settled.push([ids.length, code, next ? next.toISOString() : null]); return store.markFailed(ids, code, next); } };
  const result = await quietly(() => processCommunicationBatch(500, { store: recording, transport: fakeTransport([{ status: 500 }]).transport, now: () => new Date(start) }));
  assert.deepEqual([result.deadLettered, result.retried], [1, 2]);
  assert.deepEqual([a.state, a.attemptCount, a.nextAttemptAt], ["Dead letter", MAX_ATTEMPTS, null], "the last attempt is the end of that row, though the others of its batch have attempts left");
  assert.deepEqual([b.state, b.attemptCount, new Date(b.nextAttemptAt!).getTime() - start], ["Retry", 2, 2 ** 2 * BACKOFF_BASE_MS]);
  assert.deepEqual([c.state, c.attemptCount, new Date(c.nextAttemptAt!).getTime() - start], ["Retry", 3, 2 ** 3 * BACKOFF_BASE_MS], "each by the backoff of its own attempt");
  assert.deepEqual(settled.map(([count, code, next]) => [count, code, next === null]), [[1, "HTTP_500", true], [1, "HTTP_500", false], [1, "HTTP_500", false]], "the dead letter first, then one call for each attempt's rows");
});

test("worker: the failure is logged before the rows are settled, so a database that fails then still leaves its trace", async () => {
  const id = await readyCampaign();
  const store = getDeliveryStore();
  const failing: DeliveryStore = { ...store, markFailed: async () => { throw new Error("SQL went away"); }, releaseBatch: async () => { throw new Error("SQL went away"); } };
  const retried = await captured("error", async () => { await assert.rejects(processCommunicationBatch(500, { store: failing, transport: fakeTransport([{ status: 500 }]).transport }), /SQL went away/); });
  assert.deepEqual(retried.lines.map((line) => JSON.parse(line)), [{ level: "error", event: "communications.send.failed", communicationId: id, code: "HTTP_500", recipients: 3, terminal: false }]);
  const refused = await captured("error", async () => { await assert.rejects(processCommunicationBatch(500, { store: failing, transport: fakeTransport([{ status: 401 }]).transport }), /SQL went away/); });
  assert.deepEqual(refused.lines.map((line) => JSON.parse(line).code), ["HTTP_401"], "and so is a refusal");
});

test("releaseBatch: claimed rows go back to Queued as if never claimed — one attempt less, no lease; rows in other states and unknown ids are left alone", async () => {
  await readyCampaign();
  const store = getDeliveryStore();
  const english = (await store.claimBatch(500))!;
  const icelandic = (await store.claimBatch(500))!;
  const [a, b, c] = english.deliveries.map((d) => rowOf(d.email));
  const cio = rowOf(icelandic.deliveries[0].email);
  assert.deepEqual([a.attemptCount, a.state, Boolean(a.nextAttemptAt)], [1, "Processing", true]);
  await store.markAccepted([c.id], "msg-1", new Date()); // settled meanwhile, however: only a claimed row is given back
  await store.releaseBatch([a.id, b.id, c.id, "no-such-row"]);
  assert.deepEqual([a, b].map((d) => [d.state, d.attemptCount, d.nextAttemptAt]), [["Queued", 0, null], ["Queued", 0, null]]);
  assert.deepEqual([c.state, c.attemptCount, c.providerMessageId], ["Accepted", 1, "msg-1"], "an accepted row stays accepted");
  assert.equal(cio.state, "Processing", "and a row that was not named stays with the worker");
  await store.releaseBatch([]);
  const again = (await store.claimBatch(500))!;
  assert.deepEqual(again.deliveries.map((d) => [d.email, d.attemptCount]), [["bjarki@uidata.com", 1], ["jon@origo.is", 1]], "claimed again, the attempt counts as the first");
  a.state = "Processing"; a.attemptCount = 0; // however it got there: the count does not go below zero
  await store.releaseBatch([a.id]);
  assert.deepEqual([a.state, a.attemptCount], ["Queued", 0]);
});

test("releaseBatch: the real rows of a cancelled campaign are cancelled, not queued for a claim that never comes; a Test row is queued again", async () => {
  const id = await readyCampaign();
  await testSendCommunication(PM, id, []);
  const store = getDeliveryStore();
  const claimed: string[] = [];
  for (let batch = await store.claimBatch(500); batch; batch = await store.claimBatch(500)) claimed.push(...batch.deliveries.map((d) => d.id));
  assert.equal(claimed.length, 5);
  await cancelCommunication(PM, id, "cancel");
  await store.releaseBatch(claimed);
  assert.deepEqual(memoryDeliveries().map((d) => [d.source === "Test" ? "Test" : "real", d.state]).sort(), [["Test", "Queued"], ["real", "Cancelled"], ["real", "Cancelled"], ["real", "Cancelled"], ["real", "Cancelled"]]);
  const stats = await communicationStats(id);
  assert.deepEqual([stats.queued, stats.cancelled], [0, 4], "the campaign holds no row that nothing will claim");
});

test("worker store, SQL: releaseBatch gives back only rows that are still Processing, one attempt less, and cancels a cancelled campaign's real rows instead", async () => {
  await withFakeSql([], async (calls, events) => {
    await getDeliveryStore().releaseBatch(["id-1", "id-2"]);
    const release = calls.find((c) => /ELSE 'Queued' END/.test(c.text))!;
    assert.deepEqual(JSON.parse(String(release.inputs.ids)), ["id-1", "id-2"]);
    assert.match(release.text, /^UPDATE d SET state=CASE WHEN c\.status='Cancelled' AND d\.source<>'Test' THEN 'Cancelled' ELSE 'Queued' END,\s+attempt_count=CASE WHEN d\.attempt_count>0 THEN d\.attempt_count-1 ELSE 0 END,next_attempt_at=NULL\s+FROM dbo\.CommunicationDeliveries d JOIN dbo\.Communications c WITH \(READCOMMITTEDLOCK\) ON c\.id=d\.communication_id\s+WHERE d\.state='Processing' AND d\.id IN \(SELECT TRY_CONVERT\(uniqueidentifier,\[value\]\) FROM OPENJSON\(@ids\)\)$/,
      "only a row still claimed (not one a lease recovery or a cancel moved), the attempt the claim counted is taken back, and a cancel that is committing is waited for");
    await getDeliveryStore().releaseBatch([]);
    assert.equal(calls.length, 1, "nothing to give back, no statement");
    assert.deepEqual(events, [], "one atomic statement, no unit of work");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// SendGrid event webhook
// ---------------------------------------------------------------------------------------------------------------------

/** A key pair and a signature over `timestamp + body`, made the way SendGrid makes them; `offsetSeconds` moves the timestamp away from now. */
function signedPayload(body: string, offsetSeconds = 0) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const timestamp = String(Math.floor(Date.now() / 1000) + offsetSeconds);
  const signature = sign("sha256", Buffer.from(timestamp + body, "utf8"), privateKey).toString("base64");
  return { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), timestamp, signature };
}
/** Parses and applies a batch of events given as plain objects, the way the route does with the body it read. */
const applyAll = (...events: Array<Record<string, unknown>>) => applyEvents(parseEvents(JSON.stringify(events)));
const EVENT_DELIVERY = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
/** Which of the webhook's tables a recorded statement is about. */
const touches = (call: SqlCall) =>
  /^\s*INSERT dbo\.CommunicationEvents/.test(call.text) ? "ledger"
    : /^\s*UPDATE TOP\(1\) dbo\.CommunicationDeliveries/.test(call.text) ? "delivery"
      : /dbo\.CommunicationSuppressions/.test(call.text) ? "suppression" : "other";
/** The database as the webhook meets it: the ledger takes each event id once, and the delivery update finds `rows` rows. */
function sqlWebhook(rows = 1): SqlAnswers {
  const ledger = new Set<string>();
  return [
    [/^\s*INSERT dbo\.CommunicationEvents/, (inputs) => ({ rowsAffected: [ledger.has(String(inputs.id)) ? 0 : (ledger.add(String(inputs.id)), 1)] })],
    [/^\s*UPDATE TOP\(1\) dbo\.CommunicationDeliveries/, { rowsAffected: [rows] }],
  ];
}

test("webhook: ECDSA signature verification, PEM-armoured keys and the 10-minute window", () => {
  const body = JSON.stringify([{ sg_event_id: "e1", event: "delivered", email: "a@origo.is", timestamp: 1 }]);
  const { publicKey, timestamp, signature } = signedPayload(body);
  assert.equal(verifyEventSignature(publicKey, body, signature, timestamp), true);
  assert.equal(verifyEventSignature(`-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`, body, signature, timestamp), true);
  assert.equal(verifyEventSignature(publicKey, body + " ", signature, timestamp), false);
  assert.equal(verifyEventSignature(publicKey, body, signature, String(Number(timestamp) - 601)), false);
  assert.equal(verifyEventSignature(publicKey, body, null, timestamp), false);
});

test("webhook: the window is judged on a valid signature and is ten minutes either side of now; anything malformed is refused, never thrown", () => {
  const body = JSON.stringify([{ sg_event_id: "e1", event: "delivered", email: "a@origo.is", timestamp: 1 }]);
  const { publicKey, timestamp, signature } = signedPayload(body);
  const verifyAt = (seconds: number) => verifyEventSignature(publicKey, body, signature, timestamp, (Number(timestamp) + seconds) * 1000);
  assert.deepEqual([verifyAt(0), verifyAt(600), verifyAt(-600)], [true, true, true], "the edges are inside");
  assert.deepEqual([verifyAt(601), verifyAt(-601), verifyAt(86_400)], [false, false, false], "older is a replay, and newer is a clock that is wrong");
  for (const bad of ["", "abc", "12.5", "-1", "1e9", ` ${timestamp}`, "1".repeat(13)])
    assert.equal(verifyEventSignature(publicKey, body, signature, bad), false, `timestamp ${JSON.stringify(bad)}`);
  assert.equal(verifyEventSignature(publicKey, body, signature, null), false);
  // The format alone refuses a timestamp that is not a plain whole number, though it is near enough to now and was signed just as it stands.
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pairKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const signedAs = (text: string) => sign("sha256", Buffer.from(text + body, "utf8"), pair.privateKey).toString("base64");
  assert.equal(verifyEventSignature(pairKey, body, signedAs(timestamp), timestamp), true, "the control: the plain timestamp, signed, is accepted");
  for (const odd of [`${timestamp}.0`, `${timestamp}e0`, `+${timestamp}`, `${timestamp} `])
    assert.equal(verifyEventSignature(pairKey, body, signedAs(odd), odd), false, `signed as ${JSON.stringify(odd)}`);
  for (const bad of ["", "not base64 at all!", Buffer.from("short").toString("base64")])
    assert.equal(verifyEventSignature(publicKey, body, bad, timestamp), false, `signature ${JSON.stringify(bad)}`);
  for (const bad of ["", "   ", "not a key", Buffer.from("not a DER key").toString("base64"), signedPayload(body).publicKey])
    assert.equal(verifyEventSignature(bad, body, signature, timestamp), false, `key ${JSON.stringify(bad)}`);
});

test("webhook: a configured key may carry PEM armour, line breaks and padding", () => {
  assert.equal(normalizePublicKey("-----BEGIN PUBLIC KEY-----\r\nMFkw EwYH\nKoZI\n-----END PUBLIC KEY-----\n"), "MFkwEwYHKoZI");
  assert.equal(normalizePublicKey("  MFkwEwYHKoZI \t"), "MFkwEwYHKoZI");
  const body = "[]";
  const { publicKey, timestamp, signature } = signedPayload(body);
  const wrapped = `-----BEGIN PUBLIC KEY-----\r\n${publicKey.match(/.{1,64}/g)!.join("\r\n")}\r\n-----END PUBLIC KEY-----\r\n`;
  assert.equal(verifyEventSignature(wrapped, body, signature, timestamp), true, "the 64-column form that openssl writes");
  assert.equal(verifyEventSignature(`  ${publicKey}\n`, body, signature, timestamp), true);
});

test("webhook: event mapping", () => {
  assert.deepEqual(mapEvent({ sg_event_id: "1", event: "delivered", email: "a", timestamp: 1 }), { lastEvent: "delivered", state: "Delivered" });
  assert.deepEqual(mapEvent({ sg_event_id: "1", event: "bounce", type: "bounce", email: "a", timestamp: 1 }), { lastEvent: "bounce", state: "Bounced", suppress: "Bounced" });
  assert.deepEqual(mapEvent({ sg_event_id: "1", event: "bounce", type: "blocked", email: "a", timestamp: 1 }), { lastEvent: "bounce", state: "Bounced" });
  assert.deepEqual(mapEvent({ sg_event_id: "1", event: "dropped", reason: "Unsubscribed Address", email: "a", timestamp: 1 }), { lastEvent: "dropped", state: "Dropped", suppress: "Unsubscribed" });
  assert.deepEqual(mapEvent({ sg_event_id: "1", event: "group_resubscribe", email: "a", timestamp: 1 }), { lastEvent: "group_resubscribe", release: "Unsubscribed" });
  assert.deepEqual(mapEvent({ sg_event_id: "1", event: "open", email: "a", timestamp: 1 }), { lastEvent: "open", opened: true });
  assert.deepEqual(mapEvent({ sg_event_id: "1", event: "processed", email: "a", timestamp: 1 }), { lastEvent: "processed" });
});

test("webhook: the rest of the mapping table — deferrals, clicks, spam reports, unsubscribes, the reasons of a drop, and events that only move last_event", () => {
  const map = (event: string, extra: Partial<SendGridEvent> = {}) => mapEvent({ sg_event_id: "1", event, email: "a", timestamp: 1, ...extra });
  assert.deepEqual(map("deferred"), { lastEvent: "deferred", state: "Deferred" });
  assert.deepEqual(map("click"), { lastEvent: "click", clicked: true });
  assert.deepEqual(map("spamreport"), { lastEvent: "spamreport", suppress: "SpamReport" });
  assert.deepEqual(map("unsubscribe"), { lastEvent: "unsubscribe", suppress: "Unsubscribed" });
  assert.deepEqual(map("group_unsubscribe"), { lastEvent: "group_unsubscribe", suppress: "Unsubscribed" });
  assert.deepEqual(map("bounce"), { lastEvent: "bounce", state: "Bounced", suppress: "Bounced" }, "a bounce that names no type is a real one");
  for (const [reason, suppress] of [["Bounced Address", "Bounced"], ["unsubscribed address", "Unsubscribed"], ["Spam Reporting Address", "SpamReport"]] as const)
    assert.deepEqual(map("dropped", { reason }), { lastEvent: "dropped", state: "Dropped", suppress }, reason);
  for (const reason of [undefined, "", "Invalid", "Spam Content (if spam checker app enabled)"])
    assert.deepEqual(map("dropped", { reason }), { lastEvent: "dropped", state: "Dropped" }, `a drop for ${JSON.stringify(reason)} suppresses nothing`);
  for (const name of ["processed", "something_new"]) assert.deepEqual(map(name), { lastEvent: name });
});

test("webhook: parseEvents keeps well-formed events with the address trimmed and lower-cased, cuts each field to its column, and drops the rest", () => {
  const full = {
    sg_event_id: "e1", sg_message_id: "m.filter0001", event: "bounce", email: "  Jon@Origo.IS ", timestamp: 1_700_000_000, reason: "550 unknown", type: "bounce",
    deliveryId: "7C9E6679-7425-40DE-944B-E07FC1F90AE7", communicationId: "COM-001", category: ["not", "kept"],
  };
  assert.deepEqual(parseEvents(JSON.stringify([full])), [{
    sg_event_id: "e1", sg_message_id: "m.filter0001", event: "bounce", email: "jon@origo.is", timestamp: 1_700_000_000, reason: "550 unknown", type: "bounce",
    deliveryId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", communicationId: "COM-001",
  }], "what the handler uses, and nothing else");
  const [cut] = parseEvents(JSON.stringify([{
    sg_event_id: "i".repeat(150), event: "e".repeat(50), email: `${"a".repeat(400)}@x.is`, timestamp: 1, sg_message_id: "m".repeat(300), reason: "r".repeat(600),
    type: "t".repeat(50), communicationId: "C".repeat(50),
  }]));
  assert.deepEqual(
    [cut.sg_event_id.length, cut.event.length, cut.email.length, cut.sg_message_id?.length, cut.reason?.length, cut.type?.length, cut.communicationId?.length],
    [100, 32, 320, 200, 500, 32, 32], "each is cut to the width of its column",
  );
  const ok = { sg_event_id: "ok", event: "delivered", email: "a@origo.is", timestamp: 1 };
  for (const deliveryId of ["not-a-uuid", "-".repeat(36), "7c9e6679-7425-40de-944b-e07fc1f90ae7x", 7, null])
    assert.equal(parseEvents(JSON.stringify([{ ...ok, deliveryId }]))[0].deliveryId, undefined, `delivery id ${JSON.stringify(deliveryId)} is no delivery id`);
  const malformed: unknown[] = [
    null, 7, "text", [], {}, { event: "delivered" },
    { ...ok, sg_event_id: 4 }, { ...ok, sg_event_id: "" }, { ...ok, sg_event_id: "  " },
    { ...ok, event: undefined }, { ...ok, event: "" },
    { ...ok, email: undefined }, { ...ok, email: "" }, { ...ok, email: "   \t" },
    { ...ok, timestamp: "1" }, { ...ok, timestamp: -1 }, { ...ok, timestamp: 253_402_300_800 }, { ...ok, timestamp: "__INFINITY__" },
  ];
  const raw = JSON.stringify([...malformed, { ...ok, sg_event_id: "zero", timestamp: 0 }, { ...ok, sg_event_id: "last", timestamp: 253_402_300_799 }, ok]).replace('"__INFINITY__"', "1e999");
  assert.deepEqual(parseEvents(raw).map((e) => e.sg_event_id), ["zero", "last", "ok"], "no id, no event, no address (or one that is blank once trimmed) and no usable time: dropped; the first and the last second the ledger can hold: kept");
});

test("webhook: parseEvents refuses a body that is not a JSON array and reads at most 1000 events", () => {
  for (const body of ["{oops", ""]) assert.throws(() => parseEvents(body), /INVALID_JSON/, JSON.stringify(body));
  for (const body of ["{}", '{"sg_event_id":"e"}', '"text"', "7", "null"]) assert.throws(() => parseEvents(body), /INVALID_EVENTS/, body);
  assert.deepEqual(parseEvents("[]"), []);
  const many = Array.from({ length: 1200 }, (_, i) => ({ sg_event_id: `m${i}`, event: "delivered", email: "a@origo.is", timestamp: 1 }));
  const kept = parseEvents(JSON.stringify(many));
  assert.deepEqual([kept.length, kept[0].sg_event_id, kept[999].sg_event_id], [1000, "m0", "m999"]);
});

test("webhook: applies delivery states, bounce suppresses the address, duplicates and unknown ids are no-ops", async () => {
  const id = await readyCampaign();
  await processCommunicationBatch(500, { transport: fakeTransport().transport });
  const items = (await listDeliveries(PM, id, {})).items;
  const jon = items.find((d) => d.email === "jon@origo.is")!;
  const cio = items.find((d) => d.email === "cio@origo.is")!;
  const events = parseEvents(JSON.stringify([
    { sg_event_id: "e1", event: "delivered", email: jon.email, timestamp: 1, deliveryId: jon.id, communicationId: id },
    { sg_event_id: "e2", event: "open", email: jon.email, timestamp: 2, deliveryId: jon.id, communicationId: id },
    { sg_event_id: "e3", event: "bounce", type: "bounce", reason: "550 unknown", email: cio.email, timestamp: 3, deliveryId: cio.id, communicationId: id },
    { sg_event_id: "e1", event: "delivered", email: jon.email, timestamp: 1, deliveryId: jon.id, communicationId: id },
    { sg_event_id: "e4", event: "delivered", email: "ghost@x.is", timestamp: 1, deliveryId: crypto.randomUUID() },
    { event: "delivered" },
  ]));
  assert.equal(events.length, 5, "malformed event dropped by parseEvents");
  const result = await applyEvents(events);
  assert.deepEqual(result, { applied: 3, ignored: 2 });
  const after = (await listDeliveries(PM, id, {})).items;
  assert.equal(after.find((d) => d.id === jon.id)?.state, "Delivered");
  assert.ok(after.find((d) => d.id === jon.id)?.openedAt);
  assert.equal(after.find((d) => d.id === cio.id)?.state, "Bounced");
  assert.equal((await loadSuppressionMap()).get(cio.email), "Bounced");
  assert.equal((await listContacts(PM, "ORG-001")).find((c) => c.email === cio.email)?.status, "Bounced");
  // the bounced address is now excluded from the next campaign even though the contact still exists: a contact the webhook flagged is no longer
  // an audience member at all (the resolver takes Active contacts only), so it is absent rather than counted as suppressed — see the next test
  // for an address that the suppression list itself catches
  const next = await createCommunication(PM, draftInput);
  const estimate = await audienceEstimate(PM, next.id);
  assert.deepEqual([estimate.members, estimate.contacts, estimate.sendable, estimate.suppressed], [3, 0, 3, {}]);
  assert.equal((await listContacts(PM, "ORG-001")).some((c) => c.email === cio.email), true, "the contact itself is still there");
});

test("webhook: a member's bounced address stays in the next audience as a suppressed row, counted by its reason", async () => {
  const id = await readyCampaign();
  await processCommunicationBatch(500, { transport: fakeTransport().transport });
  const jon = rowOf("jon@origo.is");
  await applyAll({ sg_event_id: "b1", event: "bounce", type: "bounce", reason: "550 unknown", email: jon.email, timestamp: 1, deliveryId: jon.id, communicationId: id });
  assert.equal(jon.state, "Bounced");
  const next = await createCommunication(PM, draftInput);
  const estimate = await audienceEstimate(PM, next.id);
  assert.deepEqual([estimate.total, estimate.sendable, estimate.suppressed], [4, 3, { Bounced: 1 }], "a Pulse user is not a contact: the list is what keeps the address out");
});

test("webhook: an open or a click stamps the first time only, and with no delivery id the row is found by message id and address", async () => {
  await readyCampaign();
  await processCommunicationBatch(500, { transport: fakeTransport().transport });
  const [jon, anna, cio] = ["jon@origo.is", "anna@advania.is", "cio@origo.is"].map(rowOf);
  assert.equal(jon.providerMessageId, anna.providerMessageId, "one request, one message id");
  assert.notEqual(jon.providerMessageId, cio.providerMessageId);
  const message = `${jon.providerMessageId}.filter0001.1234.5678.0`; // SendGrid appends its own suffix to the id the request got
  const result = await applyAll(
    { sg_event_id: "o1", event: "open", email: "Jon@Origo.is", timestamp: 100, sg_message_id: message },
    { sg_event_id: "o2", event: "open", email: "jon@origo.is", timestamp: 200, sg_message_id: message },
    { sg_event_id: "c1", event: "click", email: "jon@origo.is", timestamp: 300, sg_message_id: message },
    { sg_event_id: "o3", event: "open", email: "cio@origo.is", timestamp: 400, sg_message_id: message }, // cio's request had another message id
    { sg_event_id: "o4", event: "open", email: "jon@origo.is", timestamp: 500 }, // nothing to find the row by
    { sg_event_id: "o5", event: "open", email: "stranger@origo.is", timestamp: 600, sg_message_id: message }, // not an address of that request
  );
  assert.deepEqual(result, { applied: 3, ignored: 3 });
  const at = (seconds: number) => new Date(seconds * 1000).toISOString();
  assert.deepEqual([jon.openedAt, jon.clickedAt, jon.lastEvent, jon.lastEventAt, jon.state], [at(100), at(300), "click", at(300), "Accepted"], "the first open stays, and neither an open nor a click moves the state");
  assert.deepEqual([anna, cio].map((d) => [d.openedAt ?? null, d.lastEvent ?? null]), [[null, null], [null, null]], "no other row was touched");
});

test("webhook: unsubscribes and spam reports suppress the address and flag its contacts; a resubscribe lifts an Unsubscribed suppression and nothing else", async () => {
  await seedAudience(); // cio@origo.is is a contact of ORG-001
  const state = async () => [(await loadSuppressionMap()).get("cio@origo.is") ?? null, (await listContacts(PM, "ORG-001")).find((c) => c.email === "cio@origo.is")?.status];
  let n = 0;
  const event = (name: string) => ({ sg_event_id: `u${++n}`, event: name, email: "CIO@origo.is", timestamp: n });
  await applyAll(event("group_unsubscribe"));
  assert.deepEqual(await state(), ["Unsubscribed", "Unsubscribed"]);
  await applyAll(event("spamreport"));
  assert.deepEqual(await state(), ["SpamReport", "Unsubscribed"]);
  await applyAll(event("group_resubscribe"));
  assert.deepEqual(await state(), ["SpamReport", "Unsubscribed"], "a resubscribe does not lift a spam report");
  await applyAll(event("unsubscribe"));
  assert.deepEqual(await state(), ["Unsubscribed", "Unsubscribed"]);
  await applyAll(event("group_resubscribe"));
  assert.deepEqual(await state(), [null, "Active"], "it lifts an unsubscribe, and the contact is active again");
  await applyAll(event("bounce"));
  assert.deepEqual(await state(), ["Bounced", "Bounced"]);
  await applyAll(event("group_resubscribe"));
  assert.deepEqual(await state(), ["Bounced", "Bounced"], "nor does it lift a bounce");
});

test("webhook: events never move a delivery backwards — a late deferral leaves Delivered, a late delivery leaves a bounce, a late bounce still counts — and last_event, opens and clicks are always recorded", async () => {
  await readyCampaign();
  await processCommunicationBatch(500, { transport: fakeTransport().transport });
  const row = rowOf("jon@origo.is");
  let n = 0;
  /** Starts the delivery as the provider accepted it, applies the events in the order they arrive (each carries the time it happened) and says where it ends. */
  const walk = async (...arrivals: Array<[event: string, at: number]>) => {
    Object.assign(row, { state: "Accepted", lastEvent: null, lastEventAt: null, openedAt: null, clickedAt: null });
    for (const [event, at] of arrivals) await applyAll({ sg_event_id: `w${++n}`, event, email: row.email, timestamp: at, deliveryId: row.id });
    return row.state;
  };
  const at = (seconds: number) => new Date(seconds * 1000).toISOString();
  assert.equal(await walk(["delivered", 200], ["deferred", 100]), "Delivered", "a deferral that arrives after the delivery it preceded");
  assert.equal(await walk(["deferred", 100], ["delivered", 200]), "Delivered", "the usual order");
  assert.equal(await walk(["deferred", 100], ["deferred", 200]), "Deferred");
  assert.equal(await walk(["processed", 50], ["delivered", 200], ["processed", 60]), "Delivered", "an event that sets no state moves nothing");
  assert.equal(await walk(["bounce", 200], ["delivered", 100]), "Bounced", "a delivery that arrives after the bounce it preceded");
  assert.equal(await walk(["bounce", 200], ["deferred", 100]), "Bounced");
  assert.equal(await walk(["delivered", 100], ["bounce", 200]), "Bounced", "a bounce after a delivery is a late bounce, and it counts");
  assert.equal(await walk(["dropped", 200], ["delivered", 100]), "Dropped");
  assert.equal(await walk(["dropped", 100], ["bounce", 200]), "Bounced", "a verdict of the same weight: the one that arrives later wins");
  assert.equal(await walk(["bounce", 100], ["dropped", 200]), "Dropped");
  await walk(["delivered", 200], ["deferred", 100]);
  assert.deepEqual([row.lastEvent, row.lastEventAt], ["deferred", at(100)], "last_event is the last event that arrived; the state is how far the provider got");
  await walk(["bounce", 200], ["open", 300], ["click", 400]);
  assert.deepEqual([row.state, row.openedAt, row.clickedAt], ["Bounced", at(300), at(400)], "opens and clicks are recorded whatever the state");
});

test("webhook: an event touches only a delivery the provider accepted — a row in a state the worker owns is left as it is — except that a verdict for a row still Processing is applied, the webhook having overtaken the worker", async () => {
  await readyCampaign(); // the worker has not run: the rows are Queued
  const row = rowOf("jon@origo.is");
  let n = 0;
  const arrive = (...names: string[]) => applyAll(...names.map((event) => ({ sg_event_id: `x${++n}`, event, email: row.email, timestamp: 1000 + n, deliveryId: row.id })));
  const reset = (state: DeliveryState) => Object.assign(row, { state, lastEvent: null, lastEventAt: null, openedAt: null, clickedAt: null });
  for (const state of ["Queued", "Retry", "Dead letter", "Suppressed", "Cancelled"] as const) {
    reset(state);
    assert.deepEqual(await arrive("delivered", "deferred", "open", "click", "processed"), { applied: 0, ignored: 5 }, `${state}: ignored`);
    assert.deepEqual([row.state, row.lastEvent, row.lastEventAt, row.openedAt, row.clickedAt], [state, null, null, null, null], `${state}: not touched at all`);
  }
  reset("Dead letter");
  assert.deepEqual(await arrive("bounce"), { applied: 1, ignored: 0 }, "a bounce still suppresses the address, which is not the row's to keep");
  assert.deepEqual([row.state, row.lastEvent], ["Dead letter", null]);
  assert.equal((await loadSuppressionMap()).get(row.email), "Bounced");
  reset("Processing");
  assert.deepEqual(await arrive("deferred", "open", "click", "processed"), { applied: 0, ignored: 4 }, "Processing: only a verdict is taken");
  assert.deepEqual([row.state, row.lastEvent, row.openedAt, row.clickedAt], ["Processing", null, null, null]);
  for (const [event, state] of [["delivered", "Delivered"], ["bounce", "Bounced"], ["dropped", "Dropped"]] as const) {
    reset("Processing");
    assert.deepEqual(await arrive(event), { applied: 1, ignored: 0 }, event);
    assert.deepEqual([row.state, row.lastEvent], [state, event], `a ${event} for a row still Processing: the row keeps the provider's state`);
  }
  // The same rule decides which row a message id and an address find.
  reset("Retry");
  Object.assign(row, { providerMessageId: "msg-found" });
  assert.deepEqual(await applyAll({ sg_event_id: "x-fallback", event: "delivered", email: row.email, timestamp: 1, sg_message_id: "msg-found.filter0001" }), { applied: 0, ignored: 1 });
  assert.equal(row.state, "Retry");
});

test("markAccepted: only a row still Processing becomes Accepted — one the webhook has already moved keeps what the provider told it — and every row named gets the message id and the time", async () => {
  await readyCampaign();
  const store = getDeliveryStore();
  const english = (await store.claimBatch(500))!; // bjarki, jon and anna, all Processing
  const icelandic = (await store.claimBatch(500))!; // cio
  const rowsOf = (batch: typeof english) => batch.deliveries.map((d) => memoryDeliveries().find((r) => r.id === d.id)!);
  const [bjarki, jon, anna] = rowsOf(english);
  const [cio] = rowsOf(icelandic);
  // The webhook overtakes the worker: the provider reports a delivery and a bounce before the requests have returned.
  assert.deepEqual(await applyAll(
    { sg_event_id: "race-1", event: "delivered", email: jon.email, timestamp: 100, deliveryId: jon.id },
    { sg_event_id: "race-2", event: "bounce", type: "bounce", email: cio.email, timestamp: 100, deliveryId: cio.id },
  ), { applied: 2, ignored: 0 });
  assert.deepEqual([jon.state, jon.providerMessageId ?? null, cio.state], ["Delivered", null, "Bounced"]);
  Object.assign(anna, { state: "Retry", nextAttemptAt: null }); // a row whose lease ran out was taken back meanwhile: no longer the worker's either
  const at = new Date("2026-10-14T10:00:00Z");
  await store.markAccepted(english.deliveries.map((d) => d.id), "msg-9", at);
  await store.markAccepted(icelandic.deliveries.map((d) => d.id), "msg-10", at);
  assert.deepEqual([bjarki, jon, anna, cio].map((d) => [d.state, d.providerMessageId, d.acceptedAt]), [
    ["Accepted", "msg-9", at.toISOString()], ["Delivered", "msg-9", at.toISOString()], ["Retry", "msg-9", at.toISOString()], ["Bounced", "msg-10", at.toISOString()],
  ], "only a row that is still Processing becomes Accepted; the id and the time are on every row named");
  assert.deepEqual([jon, cio].map((d) => [d.nextAttemptAt, d.lastErrorCode]), [[null, null], [null, null]], "and the lease is over, whatever the state");
  assert.equal(await store.acceptedToday(at), 4, "every row the provider accepted counts against the day's cap");
  // An event that names no delivery now finds the row by the message id that was recorded after the event had moved it.
  assert.deepEqual(await applyAll({ sg_event_id: "race-3", event: "open", email: jon.email, timestamp: 200, sg_message_id: "msg-9.filter0001.1234.0" }), { applied: 1, ignored: 0 });
  assert.equal(jon.openedAt, new Date(200_000).toISOString());
  // Later events go on from where the webhook left the row.
  await applyAll({ sg_event_id: "race-4", event: "deferred", email: jon.email, timestamp: 50, deliveryId: jon.id });
  assert.equal(jon.state, "Delivered");
});

test("worker: a delivery the provider reports while the batch is still with it is not undone when the worker records the acceptance", async () => {
  await readyCampaign();
  const transport: MailTransport = {
    kind: "sendgrid",
    async sendBatch(batch) {
      // SendGrid has delivered jon's mail and says so before the request that carried it has returned
      const jon = batch.recipients.find((r) => r.email === "jon@origo.is");
      if (jon) await applyAll({ sg_event_id: "race-w", event: "delivered", email: jon.email, timestamp: 100, deliveryId: jon.customArgs.deliveryId });
      return { providerMessageId: "msg-race" };
    },
  };
  const result = await processCommunicationBatch(500, { transport });
  assert.deepEqual([result.accepted, result.deadLettered, result.retried], [4, 0, 0]);
  assert.deepEqual(memoryDeliveries().map((d) => [d.email, d.state, d.providerMessageId]).sort(), [
    ["anna@advania.is", "Accepted", "msg-race"], ["bjarki@uidata.com", "Accepted", "msg-race"], ["cio@origo.is", "Accepted", "msg-race"], ["jon@origo.is", "Delivered", "msg-race"],
  ]);
  assert.deepEqual(result.completed.length, 1, "the campaign completes: nothing of it is open");
});

test("markFailed: a row the webhook has already moved keeps its state — a delivery reported before the settle is not turned back into a retry, a dead letter or a cancellation — and the code of the failure is still recorded", async () => {
  await seedAudience();
  await saveContact(PM, { organizationId: "ORG-001", email: "extra@origo.is", displayName: "Extra", locale: "en", topics: ["product-updates"] });
  await enableSending();
  const store = getDeliveryStore();
  const rowsOf = (batch: { deliveries: Array<{ id: string }> }) => batch.deliveries.map((d) => memoryDeliveries().find((r) => r.id === d.id)!);
  const future = new Date(Date.now() + 3_600_000);
  const first = await createCommunication(PM, draftInput);
  await sendCommunication(PM, first.id, {});
  const english = (await store.claimBatch(10))!; // bjarki, jon, anna and extra
  const icelandic = (await store.claimBatch(10))!; // cio
  const [bjarki, jon, anna, extra] = rowsOf(english);
  const [cio] = rowsOf(icelandic);
  const leases = [jon.nextAttemptAt, cio.nextAttemptAt];
  // The requests failed from the worker's side (a timeout, say) though the provider had taken them, and the webhook reports a delivery and a bounce before the worker settles.
  assert.deepEqual(await applyAll(
    { sg_event_id: "late-1", event: "delivered", email: jon.email, timestamp: 100, deliveryId: jon.id },
    { sg_event_id: "late-2", event: "bounce", type: "bounce", email: cio.email, timestamp: 100, deliveryId: cio.id },
  ), { applied: 2, ignored: 0 });
  Object.assign(extra, { state: "Retry", nextAttemptAt: future.toISOString() }); // and one row is not the worker's any more: its lease ran out meanwhile and it was taken back to wait for a retry
  await store.markFailed([bjarki.id, jon.id], "HTTP_500", future);
  await store.markFailed([anna.id, cio.id, extra.id], "HTTP_400", null);
  assert.deepEqual([bjarki, jon, anna, cio, extra].map((d) => [d.state, d.lastErrorCode]), [["Retry", "HTTP_500"], ["Delivered", "HTTP_500"], ["Dead letter", "HTTP_400"], ["Bounced", "HTTP_400"], ["Retry", "HTTP_400"]], "only a row still Processing is settled by the failure, and the code is recorded on every row named");
  assert.deepEqual([bjarki, jon, anna, cio, extra].map((d) => d.nextAttemptAt), [future.toISOString(), leases[0], null, leases[1], future.toISOString()], "the next attempt goes with the state: a row that moved on keeps what it had");
  // The same in a campaign that was cancelled meanwhile: the rows in flight become Cancelled, the row the webhook moved is not.
  const second = await createCommunication(PM, draftInput);
  await sendCommunication(PM, second.id, {});
  const claimed = (await store.claimBatch(10))!;
  assert.equal(claimed.communicationId, second.id);
  const [bjarki2, jon2, anna2] = rowsOf(claimed);
  await applyAll({ sg_event_id: "late-3", event: "delivered", email: jon2.email, timestamp: 100, deliveryId: jon2.id });
  await cancelCommunication(PM, second.id, "cancel"); // the Icelandic row is cancelled; the rows in flight are left alone
  await store.markFailed(claimed.deliveries.map((d) => d.id), "HTTP_429", future);
  assert.deepEqual([bjarki2, jon2, anna2].map((d) => [d.state, d.lastErrorCode]), [["Cancelled", "HTTP_429"], ["Delivered", "HTTP_429"], ["Cancelled", "HTTP_429"]]);
});

test("webhook: a Manual suppression is an admin's decision — webhook events neither replace it nor lift it, and the contacts keep the status it gave them", async () => {
  await seedOrganizations();
  await saveContact(PM, { organizationId: "ORG-002", email: "anna@advania.is", displayName: "Anna", locale: "en", topics: ["general"] });
  await addSuppression(ADMIN, { email: "anna@advania.is", note: "asked by phone" });
  const [manual] = await listSuppressions(ADMIN);
  assert.deepEqual([manual.reason, manual.source, manual.note], ["Manual", "Admin", "asked by phone"]);
  const status = async () => (await listContacts(PM, "ORG-002"))[0].status;
  assert.equal(await status(), "Unsubscribed");
  for (const [reason, note] of [["Bounced", "550 unknown"], ["Unsubscribed", undefined], ["SpamReport", "complaint"]] as const) await suppressAddress("Anna@Advania.is", reason, "Webhook", note);
  for (const reason of ["Unsubscribed", "Bounced", "SpamReport"] as const) await releaseAddress("anna@advania.is", reason);
  assert.deepEqual(await listSuppressions(ADMIN), [manual], "the row is as the admin left it: reason, source, note and creation time");
  assert.equal(await status(), "Unsubscribed", "and a bounce did not turn the contact into a Bounced one");
  await applyAll(
    { sg_event_id: "m1", event: "bounce", type: "bounce", reason: "550 unknown", email: "anna@advania.is", timestamp: 1 },
    { sg_event_id: "m2", event: "group_unsubscribe", email: "anna@advania.is", timestamp: 2 },
    { sg_event_id: "m3", event: "group_resubscribe", email: "anna@advania.is", timestamp: 3 },
  );
  assert.deepEqual(await listSuppressions(ADMIN), [manual], "the same through the webhook's own entry point");
  assert.equal(await status(), "Unsubscribed");
  // An admin's own call still edits the row and removing it still lifts it; once it is gone the webhook is heard again.
  await addSuppression(ADMIN, { email: "anna@advania.is", note: "second call" });
  assert.equal((await listSuppressions(ADMIN))[0].note, "second call");
  await removeSuppression(ADMIN, "anna@advania.is");
  assert.equal(await status(), "Active");
  await suppressAddress("anna@advania.is", "Bounced", "Webhook", "550 unknown");
  assert.deepEqual([(await loadSuppressionMap()).get("anna@advania.is"), await status()], ["Bounced", "Bounced"]);
  await addSuppression(ADMIN, { email: "anna@advania.is" });
  assert.deepEqual((await listSuppressions(ADMIN)).map((s) => [s.reason, s.source]), [["Manual", "Admin"]], "and an admin's Manual takes the row from a webhook's reason");
});

test("suppressions: an address that is empty once trimmed is ignored — no row, and in SQL no statement", async () => {
  for (const blank of ["", " ", "\t \n"]) await suppressAddress(blank, "Bounced", "Webhook", "550 unknown");
  assert.deepEqual([...(await loadSuppressionMap()).keys()], []);
  await withFakeSql([], async (calls) => {
    await suppressAddress("  ", "Bounced", "Webhook", "550 unknown");
    assert.deepEqual(calls, [], "nothing reached the database");
  });
});

test("suppressions: a note from the webhook is trimmed, a blank one is no note, and the cut is at 500 characters — in memory and in SQL", async () => {
  await suppressAddress("blank@origo.is", "Bounced", "Webhook", " \n\t ");
  await suppressAddress("padded@origo.is", "Bounced", "Webhook", "  550 user unknown \n");
  await suppressAddress("long@origo.is", "Bounced", "Webhook", ` ${"x".repeat(600)}`);
  const notes = Object.fromEntries((await listSuppressions(ADMIN)).map((s) => [s.email, s.note]));
  assert.deepEqual(notes, { "blank@origo.is": undefined, "padded@origo.is": "550 user unknown", "long@origo.is": "x".repeat(500) });
  await withFakeSql([], async (calls) => {
    await suppressAddress("blank@origo.is", "Bounced", "Webhook", " \n\t ");
    await suppressAddress("padded@origo.is", "Bounced", "Webhook", "  550 user unknown \n");
    assert.deepEqual(calls.map((c) => c.inputs.note), [null, "550 user unknown"]);
  });
});

test("suppressions, SQL: the upsert leaves a Manual row alone when the source is the webhook, and flags contacts only when it wrote a row", async () => {
  await withFakeSql([], async (calls) => {
    await suppressAddress(" Bounce@Origo.IS ", "Bounced", "Webhook", "550 user unknown");
    const [merge] = calls;
    assert.match(merge.text, /WHEN MATCHED AND NOT \(target\.reason='Manual' AND @source='Webhook'\) THEN UPDATE SET reason=@reason,source=@source,note=@note\s+WHEN NOT MATCHED THEN INSERT/);
    assert.match(merge.text, /\);\s+IF @@ROWCOUNT>0 UPDATE dbo\.CommunicationContacts SET status=@status,updated_at=SYSUTCDATETIME\(\) WHERE email=@email AND deleted_at IS NULL;\s*$/);
    assert.deepEqual([merge.inputs.email, merge.inputs.reason, merge.inputs.source, merge.inputs.note, merge.inputs.status], ["bounce@origo.is", "Bounced", "Webhook", "550 user unknown", "Bounced"]);
  });
});

test("webhook: nothing is logged for an event — not the address, not the reason, not a count", async () => {
  await seedAudience();
  const run = await captured("log", () => captured("warn", () => captured("error", () => applyAll(
    { sg_event_id: "l1", event: "bounce", type: "bounce", reason: "550 5.1.1 secret.person@origo.is does not exist", email: "secret.person@origo.is", timestamp: 1 },
    { sg_event_id: "l2", event: "group_unsubscribe", email: "secret.person@origo.is", timestamp: 2 },
    { sg_event_id: "l3", event: "group_resubscribe", email: "secret.person@origo.is", timestamp: 3 },
    { sg_event_id: "l4", event: "open", email: "secret.person@origo.is", timestamp: 4, sg_message_id: "x.filter0001" },
  ))));
  assert.deepEqual([run.lines, run.value.lines, run.value.value.lines], [[], [], []]);
  assert.deepEqual(run.value.value.value, { applied: 3, ignored: 1 });
});

test("webhook, SQL: an event is one unit of work — ledger row, delivery update and suppression — and a repeat stops at the ledger", async () => {
  const bounce = {
    sg_event_id: "s1", event: "bounce", type: "bounce", reason: "550 5.1.1 unknown", email: " Cio@Origo.is ", timestamp: 1_700_000_000,
    sg_message_id: "MSG.filter0001", deliveryId: EVENT_DELIVERY, communicationId: "COM-001",
  };
  await withFakeSql(sqlWebhook(), async (calls, events) => {
    assert.deepEqual(await applyAll(bounce, bounce), { applied: 1, ignored: 1 });
    assert.deepEqual(events, ["begin", "commit", "begin", "commit"], "a unit of work for each event");
    assert.deepEqual(calls.map((c) => [touches(c), c.inTransaction]), [["ledger", true], ["delivery", true], ["suppression", true], ["ledger", true]], "the suppression is written with the ledger row, so a retry can never find one without the other");
    const [ledger, delivery, suppression] = calls;
    assert.deepEqual([ledger.inputs.id, ledger.inputs.delivery, ledger.inputs.event, ledger.inputs.email, ledger.inputs.reason], ["s1", EVENT_DELIVERY, "bounce", "cio@origo.is", "550 5.1.1 unknown"]);
    assert.equal((ledger.inputs.occurred as Date).toISOString(), "2023-11-14T22:13:20.000Z");
    assert.equal(ledger.inputs.payload, JSON.stringify({ type: "bounce", sg_message_id: "MSG.filter0001" }), "the payload is trimmed to the two fields the ledger keeps");
    assert.deepEqual(
      [delivery.inputs.delivery, delivery.inputs.email, delivery.inputs.message, delivery.inputs.last, delivery.inputs.state, delivery.inputs.rank, delivery.inputs.opened, delivery.inputs.clicked],
      [EVENT_DELIVERY, "cio@origo.is", "MSG.filter0001", "bounce", "Bounced", 4, 0, 0],
    );
    assert.deepEqual([suppression.inputs.email, suppression.inputs.reason, suppression.inputs.source, suppression.inputs.note], ["cio@origo.is", "Bounced", "Webhook", "550 5.1.1 unknown"]);
  });
});

test("webhook, SQL: an event no delivery matches is ignored unless it suppresses or releases, and those still apply", async () => {
  await withFakeSql(sqlWebhook(0), async (calls) => {
    const result = await applyAll(
      { sg_event_id: "q1", event: "delivered", email: "ghost@x.is", timestamp: 1, deliveryId: EVENT_DELIVERY },
      { sg_event_id: "q2", event: "open", email: "ghost@x.is", timestamp: 2 },
      { sg_event_id: "q3", event: "unsubscribe", email: "ghost@x.is", timestamp: 3 },
      { sg_event_id: "q4", event: "group_resubscribe", email: "ghost@x.is", timestamp: 4 },
    );
    assert.deepEqual(result, { applied: 2, ignored: 2 });
    assert.deepEqual(calls.map(touches), ["ledger", "delivery", "ledger", "delivery", "ledger", "delivery", "suppression", "ledger", "delivery", "suppression"]);
    assert.ok(calls.filter((c) => touches(c) === "suppression").every((c) => c.inTransaction));
    assert.match(calls[6].text, /^\s*MERGE dbo\.CommunicationSuppressions/);
    assert.match(calls[9].text, /^\s*DELETE dbo\.CommunicationSuppressions/);
    assert.equal(calls[2].inputs.delivery, null, "an event that names no delivery has none in the ledger");
    assert.equal(calls[3].inputs.message, null, "and the update then has no message id to correlate by");
  });
});

test("webhook, SQL: the delivery update moves the state only forward, touches only rows the provider accepted, and takes a verdict for a row still Processing — by the same ranks as memory", async () => {
  await withFakeSql(sqlWebhook(), async (calls) => {
    const event = (n: number, name: string) => ({ sg_event_id: `k${n}`, event: name, email: "a@origo.is", timestamp: n, deliveryId: EVENT_DELIVERY });
    await applyAll(event(1, "delivered"), event(2, "deferred"), event(3, "bounce"), event(4, "dropped"), event(5, "open"), event(6, "processed"));
    const updates = calls.filter((c) => touches(c) === "delivery");
    assert.deepEqual(updates.map((c) => [c.inputs.state, c.inputs.rank]), [["Delivered", 3], ["Deferred", 2], ["Bounced", 4], ["Dropped", 4], [null, 0], [null, 0]], "each event says the state it sets and the weight of it");
    const text = updates[0].text;
    assert.deepEqual([...text.matchAll(/WHEN '(\w+)' THEN (\d)/g)].map((m) => [m[1], Number(m[2])]), [["Accepted", 1], ["Deferred", 2], ["Delivered", 3], ["Bounced", 4], ["Dropped", 4]], "the statement ranks the states as memory does");
    assert.match(text, /state=CASE WHEN @state IS NOT NULL AND @rank>=\(CASE state WHEN 'Accepted' THEN 1 .* ELSE 0 END\) THEN @state ELSE state END,/, "a state is set when the event has one that weighs at least what the row's does (a row still Processing has no rank: ELSE 0)");
    assert.match(text, /\)\s+AND \(state IN \('Accepted','Deferred','Delivered','Bounced','Dropped'\) OR \(state='Processing' AND @rank>=3\)\)\s*$/, "and only a row the provider accepted is touched, or one still Processing when the event is a verdict");
    assert.match(text, /WHERE \(\(@delivery IS NOT NULL AND id=@delivery\) OR \(@delivery IS NULL AND @message IS NOT NULL/, "the correlation is grouped, so the state condition applies to both ways of finding the row");
    assert.match(text, /provider_message_id IS NOT NULL AND email=@email AND LEFT\(@message,LEN\(provider_message_id\)\)=provider_message_id\)\)/, "without a delivery id the row is found by the stored message id being the start of the event's, compared exactly");
    assert.doesNotMatch(text, /LIKE/, "and not with LIKE: a base64url message id carries `_`, which LIKE reads as a wildcard");
  });
});

test("webhook, SQL: a suppression that fails rolls its event back, so SendGrid's retry finds neither a ledger row nor a half-applied event", async () => {
  const answers: SqlAnswers = [[/MERGE dbo\.CommunicationSuppressions/, () => { throw new Error("deadlock victim"); }], ...sqlWebhook()];
  await withFakeSql(answers, async (calls, events) => {
    await assert.rejects(applyAll({ sg_event_id: "f1", event: "spamreport", email: "a@origo.is", timestamp: 1, deliveryId: EVENT_DELIVERY }), /deadlock victim/);
    assert.deepEqual(events, ["begin", "rollback"]);
    assert.deepEqual(calls.map((c) => [touches(c), c.inTransaction]), [["ledger", true], ["delivery", true], ["suppression", true]]);
  });
});

test("webhook, demo data: with SQL configured and the switch on, events follow the in-memory deliveries — like the campaigns do — while suppressions still go to SQL", async () => {
  const row = deliveryRow("COM-001", "Accepted", { email: "jon@origo.is" });
  memoryDeliveries().push(row);
  await withFakeSql([], async (calls, events) => {
    globalThis.pulseShowDemoData = true;
    try {
      const bounce = { sg_event_id: "d1", event: "bounce", type: "bounce", reason: "550 unknown", email: "jon@origo.is", timestamp: 5, deliveryId: row.id };
      assert.deepEqual(await applyAll(bounce, bounce), { applied: 1, ignored: 1 });
      assert.equal(row.state, "Bounced");
      assert.equal(memoryEvents().has("d1"), true, "the ledger is the memory one");
      assert.deepEqual(calls.map(touches), ["suppression"], "only the suppression reached SQL");
      assert.deepEqual(events, [], "and no unit of work was opened");
    } finally {
      globalThis.pulseShowDemoData = undefined;
    }
  });
});

test("retention: the cleanup batch purges webhook events after 90 days, a limited number per run, and counts them", () => {
  const source = readFileSync(new URL("../lib/server/retention-worker.ts", import.meta.url), "utf8");
  assert.match(source, /DELETE TOP \(@limit\) FROM dbo\.CommunicationEvents WHERE received_at\s*<\s*DATEADD\(day,-90,SYSUTCDATETIME\(\)\);\s+SET @deleted\+=@@ROWCOUNT;/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The settings round trip, the configuration test and the production check
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Answers for the settings row in SQL: a System admin passes the role check, a save (the MERGE) keeps the JSON it was given and a read gives it
 * back, or nothing while nothing is stored. `initial` is a row that is there already.
 */
function settingsRow(initial: string | null = null): { answers: SqlAnswers; stored: () => string | null } {
  let stored = initial;
  return {
    stored: () => stored,
    answers: [
      [/FROM dbo\.Memberships m JOIN dbo\.Organizations o/, { recordset: [{ role: "System admin", allowedAuth: '["OTP","Entra ID"]' }] }],
      [/MERGE dbo\.Settings/, (inputs) => { stored = inputs.value as string; return {}; }],
      [/FROM dbo\.Settings/, () => ({ recordset: stored === null ? [] : [{ value: stored }] })],
    ],
  };
}
/** The defaults are shared by every test that follows: whatever a test did to their list of domains, put it back. */
const restoreDefaultDomains = (pristine: typeof DEFAULT_COMMUNICATION_SETTINGS) =>
  DEFAULT_COMMUNICATION_SETTINGS.safeMode.allowedDomains.splice(0, Infinity, ...pristine.safeMode.allowedDomains);

test("settings, SQL: with nothing stored a read is a copy of the defaults — nothing a caller does to it reaches DEFAULT_COMMUNICATION_SETTINGS", async () => {
  const pristine = structuredClone(DEFAULT_COMMUNICATION_SETTINGS);
  await withFakeSql(settingsRow().answers, async () => {
    try {
      const read = await getRuntimeCommunicationSettings();
      assert.deepEqual(read, pristine);
      read.safeMode.allowedDomains.push("attacker.example");
      read.boilerplate.en.footer = "changed";
      assert.deepEqual(DEFAULT_COMMUNICATION_SETTINGS, pristine, "the defaults are the defaults still");
      assert.deepEqual(await getRuntimeCommunicationSettings(), pristine, "and so is the next read");
    } finally {
      restoreDefaultDomains(pristine);
    }
  });
});

test("settings, SQL: a stored row that lacks newer fields is filled in from the defaults, and what it is filled in with is a copy", async () => {
  const pristine = structuredClone(DEFAULT_COMMUNICATION_SETTINGS);
  const older = settingsRow(JSON.stringify({ enabled: true, fromEmail: "updates@datacentral.ai", tracking: { opens: false } }));
  await withFakeSql(older.answers, async () => {
    try {
      const read = await getRuntimeCommunicationSettings();
      assert.deepEqual(read, { ...pristine, enabled: true, fromEmail: "updates@datacentral.ai", tracking: { opens: false, clicks: true } });
      read.safeMode.allowedDomains.push("attacker.example");
      assert.deepEqual(DEFAULT_COMMUNICATION_SETTINGS, pristine, "the row had no safeMode: its list of domains came from the defaults");
    } finally {
      restoreDefaultDomains(pristine);
    }
  });
});

test("settings, SQL: a save is one audited unit of work, and a read gives back exactly what it saved", async () => {
  const { answers, stored } = settingsRow();
  await withFakeSql(answers, async (calls, events) => {
    const first = await saveCommunicationSettings(ADMIN, {
      ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "Updates@DataCentral.ai",
      safeMode: { enabled: true, allowedDomains: ["DataCentral.AI", "datacentral.ai", "origo.is"] },
    });
    assert.deepEqual(first.safeMode.allowedDomains, ["datacentral.ai", "origo.is"], "normalised and without repeats");
    assert.equal(stored(), JSON.stringify(first), "the row holds what the save answered");
    assert.deepEqual(events, ["begin", "commit"]);
    assert.deepEqual(await getCommunicationSettings(ADMIN), first, "a read gives back exactly what was saved");
    const second = await saveCommunicationSettings(ADMIN, { ...first, fromName: "DC Updates", dailyCap: 100 });
    assert.deepEqual(await getCommunicationSettings(ADMIN), second);
    const audits = calls.filter((c) => /INSERT dbo\.AuditEvents/.test(c.text));
    assert.deepEqual(audits.map((a) => [a.inputs.before, a.inputs.after, a.inTransaction]), [[null, JSON.stringify(first), true], [JSON.stringify(first), JSON.stringify(second), true]], "each save writes what changed, in its own transaction");
  });
});

/** A verification key as SendGrid shows it: the base64 of a P-256 public key's SPKI. */
const verificationKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }).toString("base64");

test("production config: Key Vault placeholders for SendGrid values are rejected", () => {
  const errors = productionConfigurationErrors({ NODE_ENV: "production", SENDGRID_API_KEY: "@Microsoft.KeyVault(SecretUri=x)", SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: " " });
  assert.ok(errors.includes("SENDGRID_API_KEY"));
  assert.ok(errors.includes("SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY"));
});

test("production config: both SendGrid values are optional — unset or empty is fine — but a value that is there must be a resolved one of a real length", () => {
  const flagged = (env: Record<string, string>) => productionConfigurationErrors({ NODE_ENV: "production", ...env }).filter((name) => name.startsWith("SENDGRID_"));
  const apiKey = `SG.${"a".repeat(22)}.${"b".repeat(43)}`;
  assert.deepEqual(flagged({}), [], "neither is required");
  assert.deepEqual(flagged({ SENDGRID_API_KEY: "", SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: "" }), [], "infra/main.bicep writes an empty app setting when its parameter is left empty, and that is not set");
  assert.deepEqual(flagged({ SENDGRID_API_KEY: apiKey, SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: verificationKey }), [], "a real key and a real verification key");
  assert.deepEqual(flagged({ SENDGRID_API_KEY: apiKey }), [], "a key without the webhook key is allowed: the webhook answers 503 until it is set");
  assert.deepEqual(flagged({ SENDGRID_API_KEY: "   " }), ["SENDGRID_API_KEY"], "blank");
  assert.deepEqual(flagged({ SENDGRID_API_KEY: "SG.short" }), ["SENDGRID_API_KEY"], "too short to be a key");
  assert.deepEqual(flagged({ SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: "MFkwEwYHKoZIzj0C" }), ["SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY"], "too short to be a verification key");
  assert.deepEqual(flagged({ SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: "@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/sg/1)" }), ["SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY"], "a reference that did not resolve");
  assert.deepEqual(productionConfigurationErrors({ NODE_ENV: "development", SENDGRID_API_KEY: "   " }), [], "outside production nothing is checked");
});

/** Settings for the configuration tests: a sender, and safe mode on with the admin's own domain (uidata.com) allowed. */
const configurationSettings = (over: Partial<CommunicationSettings> = {}): CommunicationSettings => ({
  ...DEFAULT_COMMUNICATION_SETTINGS, fromEmail: "updates@datacentral.ai", safeMode: { enabled: true, allowedDomains: ["uidata.com"] }, ...over,
});
/** What went over the wire for one configuration test mail: the v3 request body, as the SDK would send it. */
type ConfigurationMail = {
  from: unknown; reply_to: unknown; subject: string; personalizations: unknown; categories: string[]; asm: unknown;
  tracking_settings: unknown; mail_settings: unknown; content: Array<{ type: string; value: string }>;
};

test("configuration test: System admin only, respects safe mode, uses the console transport without a key", async () => {
  await assert.rejects(sendConfigurationTest(PM), /FORBIDDEN/);
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, fromEmail: "updates@datacentral.ai", safeMode: { enabled: true, allowedDomains: ["datacentral.ai"] } });
  await assert.rejects(sendConfigurationTest(ADMIN), /INVALID_SAFE_MODE_BLOCKS_RECIPIENT/); // bjarki@uidata.com is not allow-listed
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, fromEmail: "updates@datacentral.ai", safeMode: { enabled: true, allowedDomains: ["uidata.com"] } });
  const { value: result, lines } = await captured("log", () => sendConfigurationTest(ADMIN));
  assert.equal(result.ok, true);
  assert.equal(result.transport, "console");
  await assert.rejects(sendConfigurationTest(ADMIN, { settingsOverride: { ...DEFAULT_COMMUNICATION_SETTINGS, fromEmail: "" } }), /INVALID_EMAIL_PROVIDER_CONFIGURATION/);
  assert.match(result.providerMessageId ?? "", /^console-[0-9a-f-]{36}$/);
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ level: "info", event: "communications.console-send", recipients: 1, sandbox: false }], "one log line: a count, never the address");
  assert.ok(lines.every((line) => !line.includes("uidata.com") && !line.includes("Bjarki")));
  assert.deepEqual(memoryDeliveries(), [], "it does not go through the worker's queue");
});

test("configuration test: one mail, to the caller alone, marked [TEST] and untracked, built from the saved settings — whether or not sending is enabled", async () => {
  process.env.SENDGRID_API_KEY = "SG.test-key";
  await saveCommunicationSettings(ADMIN, configurationSettings({
    enabled: false, fromName: "DC Updates", replyTo: "support@datacentral.ai", unsubscribeGroupId: 42, sandboxMode: true,
    tracking: { opens: true, clicks: true }, categoriesPrefix: "pulse-x",
  }));
  const client = sdkClient();
  const requests: Array<ReturnType<SdkClient["createRequest"]>> = [];
  // Nothing goes out: the SDK builds the request as it would, and this answers it instead of the network.
  client.request = async (data) => { requests.push(client.createRequest(data)); return [{ statusCode: 202, body: "", headers: { "x-message-id": "sg-config-1" } }, ""]; };
  const sent = async (settingsOverride?: CommunicationSettings) => {
    const { value, lines } = await captured("log", () => sendConfigurationTest(ADMIN, settingsOverride ? { settingsOverride } : {}));
    assert.deepEqual(lines, [], "nothing is logged");
    const request = requests[requests.length - 1];
    return { result: value, request, mail: JSON.parse(JSON.stringify(request.data)) as ConfigurationMail };
  };
  try {
    const { result, request, mail } = await sent();
    assert.deepEqual(result, { ok: true, transport: "sendgrid", providerMessageId: "sg-config-1" });
    assert.equal(requests.length, 1, "one request");
    assert.deepEqual([request.baseURL, request.headers.Authorization], ["https://api.sendgrid.com/", "Bearer SG.test-key"], "to the region the settings name, with the key from the environment");
    assert.deepEqual(mail.personalizations, [{ to: [{ email: "bjarki@uidata.com", name: "Bjarki" }], custom_args: { deliveryId: "configuration-test", communicationId: "configuration-test" } }], "to the signed-in admin and nobody else");
    assert.deepEqual([mail.from, mail.reply_to, mail.asm], [{ email: "updates@datacentral.ai", name: "DC Updates" }, { email: "support@datacentral.ai" }, { group_id: 42 }]);
    assert.equal(mail.subject, "[TEST] Pulse communications configuration test");
    assert.deepEqual(mail.categories, ["pulse-x", "pulse-x-configuration-test"]);
    assert.deepEqual(mail.tracking_settings, { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false } }, "a test mail is not tracked, whatever the settings say");
    assert.deepEqual(mail.mail_settings, { sandbox_mode: { enable: true } }, "and it is sandboxed when the settings are");
    const [text, html] = mail.content;
    assert.deepEqual([text.type, html.type], ["text/plain", "text/html"]);
    for (const part of [text.value, html.value]) assert.match(part, /Sending state: disabled\./, "sending is off in these settings, sandbox flag or not, and that is what the Settings card says");
    // The state line is the effective sending state the Settings card shows: what a campaign would do now.
    const states: Array<[Partial<CommunicationSettings>, string]> = [
      [{ enabled: true, sandboxMode: false }, "safe-mode"],
      [{ enabled: true, sandboxMode: false, safeMode: { enabled: false, allowedDomains: [] } }, "live"],
      [{ enabled: true, sandboxMode: true, safeMode: { enabled: false, allowedDomains: [] } }, "sandbox"],
      [{ enabled: false, sandboxMode: true }, "disabled"],
    ];
    for (const [over, state] of states) {
      const settings = configurationSettings(over);
      assert.equal(communicationProviderStatus(settings).effectiveSendingState, state, "the card's value");
      const other = await sent(settings);
      assert.match(other.mail.content[0].value, new RegExp(`Sending state: ${state}\\.`), state);
      assert.deepEqual(other.mail.mail_settings, { sandbox_mode: { enable: over.sandboxMode === true } });
    }
    const eu = await sent(configurationSettings({ dataResidency: "eu" }));
    assert.equal(eu.request.baseURL, "https://api.eu.sendgrid.com/", "an EU setting goes to the EU region, which is what the test is there to prove");
  } finally {
    delete client.request;
    client.setDataResidency("global");
  }
});

test("configuration test: safe mode compares the caller's whole domain, whatever its case; switched off it lets any address through", async () => {
  const as = (email: string, safeMode: CommunicationSettings["safeMode"]) => sendConfigurationTest({ ...ADMIN, email }, { settingsOverride: configurationSettings({ safeMode }) });
  const blocks = /INVALID_SAFE_MODE_BLOCKS_RECIPIENT/;
  await assert.rejects(as("bjarki@mail.uidata.com", { enabled: true, allowedDomains: ["uidata.com"] }), blocks, "a subdomain is not the domain");
  await assert.rejects(as("bjarki@uidata.com.attacker.example", { enabled: true, allowedDomains: ["uidata.com"] }), blocks, "nor is a domain that starts with it");
  await assert.rejects(as("bjarki@evil-uidata.com", { enabled: true, allowedDomains: ["uidata.com"] }), blocks, "nor one that ends with it");
  await assert.rejects(as("bjarki@uidata.com", { enabled: true, allowedDomains: [] }), blocks, "an empty list allows nobody");
  const { value } = await captured("log", async () => [
    await as("Bjarki@UiData.COM", { enabled: true, allowedDomains: ["uidata.com"] }),
    await as("bjarki@uidata.com", { enabled: true, allowedDomains: ["UIDATA.com"] }),
    await as("someone@anywhere.example", { enabled: false, allowedDomains: [] }),
  ]);
  assert.deepEqual(value.map((r) => r.ok), [true, true, true], "the case of the address or of the list is no difference, and with safe mode off nobody is blocked");
});

test("configuration test: a role other than System admin is refused before anything is read or sent — an override changes nothing", async () => {
  process.env.SENDGRID_API_KEY = "SG.test-key";
  await saveCommunicationSettings(ADMIN, configurationSettings({ safeMode: { enabled: false, allowedDomains: [] } }));
  const client = sdkClient();
  let requests = 0;
  client.request = async () => { requests++; return [{ statusCode: 202, body: "", headers: {} }, ""]; };
  try {
    const { lines } = await captured("log", async () => {
      for (const who of [PM, CONTRIBUTOR, COMPANY_ADMIN, REQUESTER, { ...ADMIN, role: "Product manager" }, { ...ADMIN, isInternal: false }])
        await assert.rejects(sendConfigurationTest(who), /FORBIDDEN/, `${who.role}, internal: ${who.isInternal}`);
      await assert.rejects(sendConfigurationTest(PM, { settingsOverride: configurationSettings({ fromEmail: "" }) }), /FORBIDDEN/, "the override is not looked at first");
    });
    assert.equal(requests, 0, "no request reached the provider");
    assert.deepEqual(lines, [], "and nothing reached the console transport");
  } finally {
    delete client.request;
    client.setDataResidency("global");
  }
});

test("configuration test, SQL: the role is the membership's, not the session's — a System admin in the session who is a Product manager in SQL is refused, and no setting is read", async () => {
  await withFakeSql([], async (calls) => { // the fake answers the membership check as a Product manager
    await assert.rejects(sendConfigurationTest(ADMIN), /FORBIDDEN/);
    assert.ok(calls.every((call) => !/dbo\.Settings/.test(call.text)), "the settings were not even read");
  });
  const { answers } = settingsRow(JSON.stringify(configurationSettings()));
  await withFakeSql(answers, async (calls) => {
    const { value, lines } = await captured("log", () => sendConfigurationTest(ADMIN));
    assert.deepEqual([value.ok, value.transport, lines.length], [true, "console", 1], "a System admin in SQL gets the settings from SQL and sends");
    assert.ok(calls.some((call) => /FROM dbo\.Settings/.test(call.text)));
  });
});

test("configuration test, production: without an API key it is refused as the worker refuses the console transport — before safe mode and before anything is logged — and with one it goes to the provider", async () => {
  const blocking = configurationSettings({ safeMode: { enabled: true, allowedDomains: ["datacentral.ai"] } }); // safe mode would also stop this admin, uidata.com
  const open = configurationSettings({ safeMode: { enabled: false, allowedDomains: [] } });
  const env = process.env as Record<string, string | undefined>; // NODE_ENV is typed as read-only
  const before = env.NODE_ENV;
  const client = sdkClient();
  const requests: unknown[] = [];
  client.request = async (data) => { requests.push(data); return [{ statusCode: 202, body: "", headers: { "x-message-id": "sg-prod-1" } }, ""]; };
  env.NODE_ENV = "production";
  try {
    await withFakeSql(settingsRow(JSON.stringify(blocking)).answers, async () => { // production has no memory mode: the settings and the roles come from SQL
      const { lines } = await captured("log", async () => {
        await assert.rejects(sendConfigurationTest(ADMIN), /INVALID_EMAIL_PROVIDER_CONFIGURATION/, "no key");
        env.SENDGRID_API_KEY = "   ";
        await assert.rejects(sendConfigurationTest(ADMIN), /INVALID_EMAIL_PROVIDER_CONFIGURATION/, "a blank key is no key");
        await assert.rejects(sendConfigurationTest(ADMIN, { settingsOverride: open }), /INVALID_EMAIL_PROVIDER_CONFIGURATION/, "settings that would let it through do not help");
        await assert.rejects(sendConfigurationTest(ADMIN, { settingsOverride: { ...open, fromEmail: "" } }), /INVALID_EMAIL_PROVIDER_CONFIGURATION/, "and no sender is the same error");
      });
      assert.deepEqual([lines, requests.length], [[], 0], "nothing reached the console transport or the provider");
      env.SENDGRID_API_KEY = "SG.test-key";
      await assert.rejects(sendConfigurationTest(ADMIN), /INVALID_SAFE_MODE_BLOCKS_RECIPIENT/, "with a key, safe mode is looked at");
      assert.deepEqual(await sendConfigurationTest(ADMIN, { settingsOverride: open }), { ok: true, transport: "sendgrid", providerMessageId: "sg-prod-1" });
      assert.equal(requests.length, 1);
    });
  } finally {
    if (before === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = before;
    delete client.request;
    client.setDataResidency("global");
  }
});

test("domainAllowed: the whole domain, whatever the case — the one rule behind safe mode for a campaign's audience and for the configuration test", () => {
  assert.deepEqual(
    [
      domainAllowed("bjarki@uidata.com", ["uidata.com"]),
      domainAllowed("Bjarki@UiData.COM", ["uidata.com"]),
      domainAllowed("bjarki@uidata.com", ["datacentral.ai", "UIDATA.com"]),
      domainAllowed("bjarki@mail.uidata.com", ["uidata.com"]),
      domainAllowed("bjarki@evil-uidata.com", ["uidata.com"]),
      domainAllowed("bjarki@uidata.com.attacker.example", ["uidata.com"]),
      domainAllowed("bjarki@uidata.com", []),
    ],
    [true, true, true, false, false, false, false],
  );
});

test("configuration test: a refusal from the provider is INVALID_EMAIL_PROVIDER_<code> — the code and nothing else, never the provider's words or the address — and nothing is logged", async () => {
  process.env.SENDGRID_API_KEY = "SG.test-key";
  await saveCommunicationSettings(ADMIN, configurationSettings());
  const client = sdkClient();
  const body = { errors: [{ message: "The provided authorization grant is invalid for bjarki@uidata.com", field: "from" }] };
  const failures: Array<[unknown, string]> = [
    [Object.assign(new Error("Unauthorized"), { code: 401, response: { headers: {}, body } }), "INVALID_EMAIL_PROVIDER_HTTP_401"],
    [Object.assign(new Error("Forbidden"), { code: 403, response: { headers: {}, body } }), "INVALID_EMAIL_PROVIDER_HTTP_403"],
    [Object.assign(new Error("Bad Request"), { code: 400, response: { headers: {}, body } }), "INVALID_EMAIL_PROVIDER_HTTP_400"],
    [Object.assign(new Error("Too Many Requests"), { code: 429, response: { headers: { "retry-after": "30" }, body } }), "INVALID_EMAIL_PROVIDER_HTTP_429"],
    [Object.assign(new Error("Service Unavailable"), { code: 503, response: { headers: {}, body } }), "INVALID_EMAIL_PROVIDER_HTTP_503"],
    [Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:443"), { code: "ECONNREFUSED" }), "INVALID_EMAIL_PROVIDER_ECONNREFUSED"],
    [new Error("socket hang up while sending to bjarki@uidata.com"), "INVALID_EMAIL_PROVIDER_SEND_FAILED"],
  ];
  try {
    for (const [error, expected] of failures) {
      client.request = async () => { throw error; };
      const run = await captured("log", () => captured("warn", () => captured("error", () => sendConfigurationTest(ADMIN).then(() => "sent", (e: unknown) => (e as Error).message))));
      assert.equal(run.value.value.value, expected, "the whole message is the code");
      assert.deepEqual([run.lines, run.value.lines, run.value.value.lines], [[], [], []], `${expected}: nothing is logged`);
    }
  } finally {
    delete client.request;
    client.setDataResidency("global");
  }
});
