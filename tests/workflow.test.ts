import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import type { PulseIdentity } from "../lib/domain";
import {
  createIdea,
  linkRequest,
  mergeIdeas,
  moveRequestLink,
  publishIdea,
  scoreIdea,
  updateIdea,
} from "../lib/server/product-repository";
import { getIdea } from "../lib/server/idea-repository";
import {
  createRelease,
  publishRelease,
} from "../lib/server/operations-repository";
import {
  createRequest,
  editRequest,
  listRequests,
  requestAttachmentBytes,
  updateRequestStatus,
} from "../lib/server/request-repository";
import { executeIdempotent } from "../lib/server/idempotency";
import {
  deleteRequestDraft,
  getRequestDraft,
  saveRequestDraft,
} from "../lib/server/draft-repository";
import { getSettings, saveSettings } from "../lib/server/settings-repository";
import { listAudit } from "../lib/server/operations-repository";
import {
  addComment,
  editComment,
  listComments,
  removeComment,
} from "../lib/server/comment-repository";
import {
  createSavedView,
  deleteSavedView,
  listSavedViews,
} from "../lib/server/saved-view-repository";
import {
  exportAuthorizedRequests,
  getAnalyticsSummary,
} from "../lib/server/analytics-repository";
import { listTaxonomy, saveTaxonomy } from "../lib/server/taxonomy-repository";
import {
  listNotificationPreferences,
  saveNotificationPreference,
} from "../lib/server/notification-preference-repository";
import {
  addExternalLink,
  listExternalLinks,
  removeExternalLink,
} from "../lib/server/external-link-repository";
import { searchSuggestions } from "../lib/server/search-repository";
import { validateWebhookUrl } from "../lib/server/webhook-repository";
import { bulkUpdateTriage } from "../lib/server/triage-repository";

const internal: PulseIdentity = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "product@uidata.com",
  name: "Product Manager",
  organizationId: "ORG-001",
  role: "System admin",
  isInternal: true,
};
const otherTenant: PulseIdentity = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "other@example.com",
  name: "Other Customer",
  organizationId: "ORG-002",
  role: "Requester",
  isInternal: false,
};
const customer: PulseIdentity = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "customer@example.com",
  name: "Customer Requester",
  organizationId: "ORG-001",
  role: "Requester",
  isInternal: false,
};

beforeEach(() => {
  globalThis.pulseMemoryState = undefined;
  globalThis.pulseMemoryIdeas = undefined;
  globalThis.pulseMemoryProducts = undefined;
  globalThis.pulseMemoryLinks = undefined;
  globalThis.pulseMemoryScores = undefined;
  globalThis.pulseMemoryReleases = undefined;
  globalThis.pulseMemoryNotifications = undefined;
  globalThis.pulseMemoryAudit = undefined;
  globalThis.pulseMemoryIdempotency = undefined;
  globalThis.pulseMemoryDrafts = undefined;
  globalThis.pulseMemorySettings = undefined;
  globalThis.pulseMemoryComments = undefined;
  globalThis.pulseMemorySavedViews = undefined;
  globalThis.pulseMemoryTaxonomy = undefined;
  globalThis.pulseMemoryIdeaAliases = undefined;
  globalThis.pulseMemoryNotificationPreferences = undefined;
  globalThis.pulseMemoryExternalLinks = undefined;
  globalThis.pulseMemoryWebhooks = undefined;
});

test("notification preferences enforce mandatory immediate delivery", async () => {
  const saved = await saveNotificationPreference(
    customer,
    "release.published",
    "Weekly",
  );
  assert.equal(saved.cadence, "Weekly");
  await assert.rejects(
    () =>
      saveNotificationPreference(
        customer,
        "request.needs-information",
        "Off",
      ),
    /MANDATORY_NOTIFICATION_MUST_BE_IMMEDIATE/,
  );
  const preferences = await listNotificationPreferences(customer);
  assert.equal(
    preferences.find((item) => item.eventType === "release.published")
      ?.cadence,
    "Weekly",
  );
});

test("ideas support multiple audited HTTPS delivery links", async () => {
  const idea = await createIdea(internal, {
    internalTitle: "Delivery links",
    internalDescription: "Track multiple delivery systems",
  });
  const first = await addExternalLink(internal, idea.id, {
    label: "Azure Boards",
    url: "https://dev.azure.com/example/workitems/42",
  });
  await addExternalLink(internal, idea.id, {
    label: "Architecture notes",
    url: "https://docs.example.com/architecture",
  });
  assert.equal((await listExternalLinks(internal, idea.id)).length, 2);
  await assert.rejects(
    () =>
      addExternalLink(internal, idea.id, {
        label: "Unsafe",
        url: "http://example.com/not-secure",
      }),
    /INVALID_EXTERNAL_LINK_URL/,
  );
  await removeExternalLink(internal, idea.id, first.id);
  assert.equal((await listExternalLinks(internal, idea.id)).length, 1);
});

test("duplicate discovery tolerates misspellings without crossing tenants", async () => {
  const results = await searchSuggestions(
    customer,
    "scheduld report SharePiont delivery",
    "Distribution",
  );
  assert.equal(results[0]?.id, "IDEA-327");
  assert.ok(results.every((item) => item.source !== "Your request" || item.id !== "DCI-2077"));
});

test("duplicate discovery can create distinct context already linked", async () => {
  const idea = await createIdea(internal, {
    internalTitle: "Linked from discovery",
    internalDescription: "Published duplicate suggestion",
  });
  await updateIdea(internal, idea.id, {
    publishedTitle: "Linked from discovery",
    publishedDescription: "A safe public description for discovery.",
  });
  await publishIdea(internal, idea.id, true);
  const request = await createRequest(customer, {
    title: "Our distinct linked context",
    problem: "Our organization has specific evidence for this same outcome.",
    area: "Governance",
    impact: "High",
    visibility: "Organization",
    linkedIdeaId: idea.id,
  });
  assert.equal(request.status, "Linked");
  assert.equal(request.linkedIdea, idea.id);
});

test("webhook endpoints reject private-network SSRF targets", async () => {
  await assert.rejects(
    () => validateWebhookUrl("https://127.0.0.1/internal"),
    /INVALID_WEBHOOK_URL/,
  );
  await assert.rejects(
    () => validateWebhookUrl("http://example.com/insecure"),
    /INVALID_WEBHOOK_URL/,
  );
});

test("bulk triage is bounded, authorized, and audited", async () => {
  const result = await bulkUpdateTriage(internal, {
    requestIds: ["DCI-1042"],
    ownerId: internal.id,
    triageDueAt: "2026-07-16T12:00:00Z",
  });
  assert.equal(result.updated, 1);
  await assert.rejects(
    () =>
      bulkUpdateTriage(internal, {
        requestIds: ["DCI-2077"],
        ownerId: internal.id,
      }),
    /NOT_FOUND/,
  );
  assert.ok(
    (await listAudit(internal)).some(
      (item) => item.action === "triage.bulk-updated",
    ),
  );
});

test("tenant isolation hides requests and prevents attachment probing", async () => {
  assert.equal((await listRequests(otherTenant)).length, 0);
  await assert.rejects(
    () =>
      requestAttachmentBytes(otherTenant, "DCI-1042", {
        fileName: "probe.txt",
        contentType: "text/plain",
        sizeBytes: 5,
      }),
    /NOT_FOUND/,
  );
});

test("request status changes enforce role and customer-safe explanations", async () => {
  await assert.rejects(
    () => updateRequestStatus(customer, "DCI-1042", "Needs information"),
    /FORBIDDEN/,
  );
  await assert.rejects(
    () => updateRequestStatus(internal, "DCI-1042", "Closed"),
    /CLOSURE_EXPLANATION/,
  );
  const withdrawn = await updateRequestStatus(
    customer,
    "DCI-1042",
    "Withdrawn",
  );
  assert.equal(withdrawn.status, "Withdrawn");
});

test("withdrawing the final linked request removes active organization interest", async () => {
  const idea = await createIdea(internal, {
    internalTitle: "Withdrawal signal",
    internalDescription: "Verify organization demand recalculation",
  });
  await linkRequest(internal, idea.id, "DCI-1042", "Initial evidence");
  assert.equal(idea.organizations, 1);
  await updateRequestStatus(customer, "DCI-1042", "Withdrawn");
  assert.equal(idea.organizations, 0);
});

test("editable customer requests preserve an audited revision", async () => {
  const edited = await editRequest(customer, "DCI-1042", {
    title: "Custom branding for governed report exports",
  });
  assert.equal(edited.title, "Custom branding for governed report exports");
  await assert.rejects(
    () => editRequest(otherTenant, "DCI-1042", { title: "Probe" }),
    /NOT_FOUND/,
  );
  assert.ok(
    (await listAudit(internal)).some(
      (item) => item.action === "request.edited",
    ),
  );
});

test("idea publication enforces staged wording and explicit safety confirmation", async () => {
  const idea = await createIdea(internal, {
    internalTitle: "Governed exports",
    internalDescription: "Internal customer evidence and constraints",
    area: "Governance",
  });
  await assert.rejects(
    () => publishIdea(internal, idea.id, true),
    /INVALID_PUBLISHED_WORDING_REQUIRED/,
  );
  const staged = await updateIdea(internal, idea.id, {
    internalStatus: "Candidate",
    publishedTitle: "Governed exports",
    publishedDescription: "Export governed records with clear access controls.",
  });
  assert.equal(staged.publishState, "Internal");
  await assert.rejects(
    () => publishIdea(internal, idea.id, false),
    /INVALID_SAFE_WORDING_CONFIRMATION_REQUIRED/,
  );
  const published = await publishIdea(internal, idea.id, true);
  assert.equal(published.publishState, "Published");
  assert.equal(published.status, "Considering");
});

test("planned and in-progress transitions enforce product evidence", async () => {
  const idea = await createIdea(internal, {
    internalTitle: "Status rules",
    internalDescription: "Exercise transition requirements",
  });
  await assert.rejects(
    () => updateIdea(internal, idea.id, { internalStatus: "Planned" }),
    /HORIZON/,
  );
  await assert.rejects(
    () =>
      updateIdea(internal, idea.id, {
        internalStatus: "In progress",
        ownerId: internal.id,
      }),
    /DELIVERY_REFERENCE/,
  );
  const planned = await updateIdea(internal, idea.id, {
    internalStatus: "Planned",
    horizon: "Next",
    decisionRationale: "Broad customer impact and strategic alignment",
  });
  assert.equal(planned.internalStatus, "Planned");
});

test("linking, scoring, and release publication close the feedback loop", async () => {
  const idea = await createIdea(internal, {
    internalTitle: "Workflow idea",
    internalDescription: "Full workflow evidence",
    area: "Governance",
  });
  await linkRequest(
    internal,
    idea.id,
    "DCI-1042",
    "Same governed customer outcome",
  );
  const score = await scoreIdea(internal, idea.id, {
    impact: 5,
    reach: 4,
    strategicAlignment: 5,
    commercialImpact: 3,
    urgency: 4,
    confidence: 80,
    effort: 3,
    rationale: "High impact across several customers",
  });
  assert.equal(score.formulaVersion, 1);
  assert.ok(score.score > 0);
  await updateIdea(internal, idea.id, {
    publishedTitle: "Workflow idea",
    publishedDescription: "A customer-safe workflow description.",
    internalStatus: "Candidate",
  });
  await publishIdea(internal, idea.id, true);
  const release = await createRelease(internal, {
    title: "July product update",
    date: "2026-07-15",
    summary: "The governed workflow is now available.",
    availability: "General availability",
    ideaIds: [idea.id],
  });
  const published = await publishRelease(internal, release.id);
  assert.equal(published.published, true);
  const audit = await listAudit(internal);
  assert.ok(audit.some((item) => item.action === "idea.scored"));
  assert.ok(audit.some((item) => item.action === "release.published"));
});

test("a request link can be moved through an audited repair", async () => {
  const source = await createIdea(internal, {
    internalTitle: "Source evidence cluster",
    internalDescription: "Original consolidation target",
  });
  const target = await createIdea(internal, {
    internalTitle: "Correct evidence cluster",
    internalDescription: "Controlled repair target",
  });
  await linkRequest(internal, source.id, "DCI-1042", "Initial match");
  const result = await moveRequestLink(
    internal,
    source.id,
    "DCI-1042",
    target.id,
    "Evidence review found a better canonical outcome",
  );
  assert.equal(result.targetIdeaPublicId, target.id);
  assert.ok(
    (await listAudit(internal)).some(
      (item) => item.action === "request.link.moved",
    ),
  );
});

test("idempotency replays the original response without repeating work", async () => {
  let calls = 0;
  const request = () =>
    new Request("http://pulse.test/api/v1/requests", {
      method: "POST",
      headers: { "idempotency-key": "stable-request-key" },
    });
  const first = await executeIdempotent(
    request(),
    internal,
    "request.create",
    201,
    async () => ({ id: ++calls }),
  );
  const second = await executeIdempotent(
    request(),
    internal,
    "request.create",
    201,
    async () => ({ id: ++calls }),
  );
  assert.equal(calls, 1);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.body, first.body);
});

test("drafts are scoped to the active user and organization", async () => {
  await saveRequestDraft(internal, {
    title: "Durable draft",
    problem: "Keep this work across devices",
    area: "Governance",
    impact: "High",
    visibility: "Private",
  });
  assert.equal((await getRequestDraft(internal))?.title, "Durable draft");
  assert.equal(await getRequestDraft(otherTenant), null);
  await deleteRequestDraft(internal);
  assert.equal(await getRequestDraft(internal), null);
});

test("system settings validate weights and create audit history", async () => {
  const settings = await getSettings(internal);
  settings.defaultLocale = "is";
  settings.scoreWeights.impact = 31;
  settings.scoreWeights.reach = 19;
  const saved = await saveSettings(internal, settings);
  assert.equal(saved.formulaVersion, 2);
  assert.equal((await getSettings(internal)).defaultLocale, "is");
  assert.ok(
    (await listAudit(internal)).some(
      (item) => item.action === "settings.updated",
    ),
  );
});

test("comment edits preserve history and moderation leaves a tombstone", async () => {
  const comment = await addComment(
    internal,
    "DCI-1042",
    "Initial internal finding",
    "Internal",
  );
  await editComment(internal, "DCI-1042", comment.id, "Corrected finding");
  await assert.rejects(
    () => removeComment(internal, "DCI-1042", comment.id, ""),
    /MODERATION_REASON/,
  );
  await removeComment(
    internal,
    "DCI-1042",
    comment.id,
    "Contains obsolete customer context",
  );
  const visible = await listComments(internal, "DCI-1042", true);
  assert.equal(visible[0].body, "[Comment removed]");
  assert.equal(visible[0].removed, true);
  assert.ok(
    (await listAudit(internal)).some(
      (item) => item.action === "comment.removed",
    ),
  );
});

test("comment attachments inherit request authorization", async () => {
  const attachment = await requestAttachmentBytes(customer, "DCI-1042", {
    fileName: "example.png",
    contentType: "image/png",
    sizeBytes: 128,
  });
  const comment = await addComment(
    customer,
    "DCI-1042",
    "Attached is the requested example.",
    "Customer",
    [attachment.id],
  );
  assert.equal(comment.attachments?.[0].fileName, "example.png");
  await assert.rejects(
    () =>
      addComment(
        otherTenant,
        "DCI-1042",
        "Probe",
        "Customer",
        [attachment.id],
      ),
    /NOT_FOUND/,
  );
});

test("saved views keep private ownership and restrict shared publication", async () => {
  const view = await createSavedView(internal, {
    name: "Aging governance requests",
    scope: "Internal shared",
    resourceType: "Requests",
    query: { area: "Governance", age: "30d" },
  });
  assert.equal((await listSavedViews(internal)).length, 1);
  await assert.rejects(() => listSavedViews(customer), /FORBIDDEN/);
  await deleteSavedView(internal, view.id);
  assert.equal((await listSavedViews(internal)).length, 0);
});

test("authorized CSV exports are generated server-side and audited", async () => {
  const csv = await exportAuthorizedRequests(internal);
  assert.match(csv, /^\uFEFF"Request","Title"/);
  assert.ok(
    (await listAudit(internal)).some(
      (item) => item.action === "analytics.requests.exported",
    ),
  );
});

test("internal analytics reconcile to the authorized request set", async () => {
  const summary = await getAnalyticsSummary(internal);
  assert.equal(summary.requests.total, (await listRequests(internal)).length);
  await assert.rejects(() => getAnalyticsSummary(customer), /FORBIDDEN/);
});

test("taxonomy deactivation preserves the historical value and audits change", async () => {
  const existing = (await listTaxonomy(internal))[0];
  await saveTaxonomy(internal, { ...existing, active: false });
  const saved = (await listTaxonomy(internal)).find(
    (item) => item.id === existing.id,
  );
  assert.equal(saved?.active, false);
  assert.ok(
    (await listAudit(internal)).some(
      (item) => item.action === "taxonomy.saved",
    ),
  );
});

test("merged idea aliases resolve to the surviving published idea", async () => {
  const target = await createIdea(internal, {
    internalTitle: "Surviving idea",
    internalDescription: "Canonical target",
  });
  const source = await createIdea(internal, {
    internalTitle: "Duplicate idea",
    internalDescription: "Duplicate source",
  });
  for (const [idea, title] of [
    [target, "Surviving idea"],
    [source, "Duplicate idea"],
  ] as const) {
    await updateIdea(internal, idea.id, {
      internalStatus: "Candidate",
      publishedTitle: title,
      publishedDescription: `${title} customer-safe description.`,
    });
    await publishIdea(internal, idea.id, true);
  }
  await mergeIdeas(
    internal,
    target.id,
    source.id,
    "Confirmed duplicate after product review",
  );
  const resolved = await getIdea(customer, source.id);
  assert.equal(resolved.redirected, true);
  assert.equal(resolved.canonicalId, target.id);
});
