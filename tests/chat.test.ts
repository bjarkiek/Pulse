import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  appendChatMessage, getChatHistory, clearChatHistory, getUserByEmail,
} from "../lib/server/chat/chat-repository";
import {
  getChatTools, chatToolErrorMessage, buildAssistantInstructions,
} from "../lib/server/chat/tool-registry";
import { isAssistantConfigured, sendChat } from "../lib/server/chat/assistant-service";
import { todayLine } from "../lib/server/chat/system-prompt";
import { GET as chatGet, POST as chatPost, DELETE as chatDelete } from "../app/api/v1/chat/messages/route";
import { POST as transcriptPost } from "../app/api/v1/chat/transcript/route";

const identity = {
  id: "11111111-1111-4111-8111-111111111111", email: "bjarki@uidata.com",
  name: "Bjarki", organizationId: "ORG-001", role: "System admin", isInternal: true,
};

beforeEach(() => {
  globalThis.pulseMemoryChatMessages = undefined;
  globalThis.pulseMemoryUsers = undefined;
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
  globalThis.pulseMemoryOrganizations = undefined;
  globalThis.pulseAnthropicClient = undefined;
  delete process.env.ANTHROPIC_API_KEY;
});

test("history windows to the most recent N in chronological order", async () => {
  for (let i = 1; i <= 35; i++) await appendChatMessage(identity, "user", `m${i}`);
  const history = await getChatHistory(identity, 30);
  assert.equal(history.length, 30);
  assert.equal(history[0].content, "m6");
  assert.equal(history[29].content, "m35");
});

test("clearChatHistory removes only this user's messages", async () => {
  await appendChatMessage(identity, "user", "mine");
  await appendChatMessage({ ...identity, id: "22222222-2222-4222-8222-222222222222" }, "user", "theirs");
  await clearChatHistory(identity);
  assert.equal((await getChatHistory(identity)).length, 0);
  assert.equal((await getChatHistory({ ...identity, id: "22222222-2222-4222-8222-222222222222" })).length, 1);
});

test("getUserByEmail finds the seeded user exactly, misses unknown", async () => {
  const hit = await getUserByEmail("bjarki@uidata.com");
  assert.ok(hit);
  assert.equal(hit.status, "Active");
  assert.equal(await getUserByEmail("nobody@nowhere.example"), null);
});

test("registry exposes groups and unique snake_case names", () => {
  const tools = getChatTools();
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.match(n, /^[a-z][a-z0-9_]+$/);
  assert.ok(tools.some((t) => t.group === "customer"));
});

test("error mapper preserves anti-enumeration", () => {
  assert.equal(
    chatToolErrorMessage(new Error("FORBIDDEN")),
    chatToolErrorMessage(new Error("NOT_FOUND")),
  );
  assert.match(chatToolErrorMessage(new Error("INVALID_REQUEST_TITLE")), /title/i);
});

test("submit_request tool creates a request via the repository", async () => {
  const tool = getChatTools().find((t) => t.name === "submit_request");
  assert.ok(tool);
  const text = await tool.run(identity, {
    title: "Chat-created request", problem: "Testing the tool layer",
    area: "Distribution", impact: "Medium", visibility: "Organization",
  });
  assert.match(text, /DCI-\d+/);
});

test("tenant isolation flows through tools (cross-org read reads as not found)", async () => {
  const tool = getChatTools().find((t) => t.name === "get_request");
  const otherTenant = { ...identity, id: "33333333-3333-4333-8333-333333333333",
    organizationId: "ORG-002", role: "Requester", isInternal: false };
  const text = await tool!.run(otherTenant, { id: "DCI-1042" });
  assert.match(text, /doesn't exist or you don't have access/);
});

test("internal tool refuses a customer identity via repository role gate", async () => {
  const tool = getChatTools().find((t) => t.name === "list_triage_queue");
  const customer = { ...identity, id: "44444444-4444-4444-8444-444444444444",
    role: "Requester", isInternal: false };
  const text = await tool!.run(customer, {});
  assert.match(text, /doesn't exist or you don't have access/);
});

test("publish_idea demands explicit confirmed_safe", () => {
  const tool = getChatTools().find((t) => t.name === "publish_idea");
  assert.match(tool!.description, /confirm/i);
  assert.ok("confirmed_safe" in tool!.inputSchema);
});

test("admin tool refuses a customer identity via repository admin gate", async () => {
  const tool = getChatTools().find((t) => t.name === "list_organizations");
  const customer = { ...identity, id: "55555555-5555-4555-8555-555555555555",
    role: "Requester", isInternal: false };
  const text = await tool!.run(customer, {});
  assert.match(text, /doesn't exist or you don't have access/);
});

test("registry assembles customer, internal, and admin groups with no duplicate names", () => {
  const tools = getChatTools();
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(tools.some((t) => t.group === "internal"));
  assert.ok(tools.some((t) => t.group === "admin"));
});

test("internal idea workflow: create, set published wording, publish with confirmation", async () => {
  const create = getChatTools().find((t) => t.name === "create_idea");
  const update = getChatTools().find((t) => t.name === "update_idea");
  const publish = getChatTools().find((t) => t.name === "publish_idea");
  const createText = await create!.run(identity, {
    internalTitle: "Bulk export API",
    internalDescription: "Let customers export in bulk via API.",
    area: "Distribution",
  });
  const created = createText.match(/IDEA-\d+/);
  assert.ok(created);
  const id = created[0];
  const updateText = await update!.run(identity, {
    id,
    publishedTitle: "Bulk export API",
    publishedDescription: "Export your data in bulk via API.",
  });
  assert.match(updateText, new RegExp(id));
  const rejected = await publish!.run(identity, { id, confirmed_safe: false });
  assert.match(rejected, /safe wording confirmation/i);
  const publishText = await publish!.run(identity, { id, confirmed_safe: true });
  assert.match(publishText, new RegExp(id));
  assert.doesNotMatch(publishText, /doesn't exist or you don't have access/);
});

test("admin settings round trip: get_settings then save_settings bumps formulaVersion on weight change", async () => {
  const getTool = getChatTools().find((t) => t.name === "get_settings");
  const saveTool = getChatTools().find((t) => t.name === "save_settings");
  const before = await getTool!.run(identity, {});
  assert.match(before, /Formula v1\b/);
  const saveText = await saveTool!.run(identity, {
    attachmentMaxMb: 25,
    requestAttachmentMaxMb: 100,
    retentionDays: 365,
    defaultLocale: "en",
    roadmapDisclaimer: "Directional only.",
    scoreWeights: { impact: 20, reach: 20, strategy: 20, commercial: 20, urgency: 20 },
  });
  assert.match(saveText, /formula v2/i);
});

test("buildAssistantInstructions reflects internal staff vs customer using the real membership shape", () => {
  const internalCtx = {
    user: { id: identity.id, email: identity.email, name: identity.name, locale: "en" },
    organizations: [
      { id: "ORG-DC", name: "DataCentral", type: "Internal", role: "System admin", active: true },
    ],
    activeOrganizationId: "ORG-DC",
  };
  const internalText = buildAssistantInstructions(identity, internalCtx);
  assert.match(internalText, /DataCentral staff/);

  const customerCtx = {
    user: { id: identity.id, email: identity.email, name: identity.name, locale: "en" },
    organizations: [
      { id: "ORG-001", name: "Origo", type: "Customer", role: "Requester", active: true },
    ],
    activeOrganizationId: "ORG-001",
  };
  const customerText = buildAssistantInstructions(identity, customerCtx);
  assert.match(customerText, /customer user/i);
  assert.match(customerText, /Origo/);
});

test("todayLine reports a self-consistent UTC calendar day regardless of server timezone", () => {
  // Independent reference implementation (nearest-Thursday method), deliberately
  // written differently from lib/server/chat/system-prompt.ts's isoWeek so this
  // is a real cross-check, not a restatement of the same algorithm.
  function referenceIsoWeek(date: Date): number {
    const target = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    const dayNr = (target.getUTCDay() + 6) % 7; // 0=Mon..6=Sun
    target.setUTCDate(target.getUTCDate() - dayNr + 3); // nearest Thursday
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
    return 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000));
  }

  const samples = [
    new Date(Date.UTC(2026, 0, 1)), // Thursday, ISO week 1
    new Date(Date.UTC(2025, 11, 29)), // Monday, ISO week 1 (of 2026)
    new Date(Date.UTC(2026, 6, 15, 23, 0, 0)), // near the next UTC day boundary
    new Date(Date.UTC(2020, 11, 31)), // Thursday, ISO week 53
  ];

  const originalTz = process.env.TZ;
  // A far-ahead offset (UTC+14) so local calendar getters would land on a
  // different day than the UTC ones for the near-midnight sample above —
  // this is exactly the divergence the UTC-only fix guards against.
  process.env.TZ = "Pacific/Kiritimati";
  try {
    for (const now of samples) {
      const isoDate = now.toISOString().slice(0, 10);
      const expectedWeekday = now.toLocaleDateString("en-US", {
        weekday: "long",
        timeZone: "UTC",
      });
      const expectedWeek = referenceIsoWeek(now);
      assert.equal(
        todayLine(now),
        `Today is ${isoDate} (${expectedWeekday}, ISO week ${expectedWeek}).`,
      );
    }
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test("unconfigured assistant returns a friendly notice and never throws", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(isAssistantConfigured(), false);
  const result = await sendChat(identity, "hello");
  assert.match(result.reply, /ANTHROPIC_API_KEY/);
  assert.equal(result.dataChanged, false);
});

test("chat GET reports configured=false without a key and returns history", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const res = await chatGet(new Request("http://localhost/api/v1/chat/messages"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.configured, false);
  assert.ok(Array.isArray(body.messages));
});

test("chat GET reflects history persisted for the resolved identity", async () => {
  await appendChatMessage(identity, "user", "hello there");
  await appendChatMessage(identity, "assistant", "hi!");
  const res = await chatGet(new Request("http://localhost/api/v1/chat/messages"));
  const messages = (await res.json()).messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content, "hello there");
  assert.equal(messages[1].role, "assistant");
});

test("chat POST validates empty text", async () => {
  const res = await chatPost(new Request("http://localhost/api/v1/chat/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "" }),
  }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, "INVALID_CHAT_TEXT");
});

test("chat POST validates oversized text", async () => {
  const res = await chatPost(new Request("http://localhost/api/v1/chat/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "x".repeat(4001) }),
  }));
  assert.equal(res.status, 400);
});

test("chat POST returns the unconfigured notice without making a network call", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const res = await chatPost(new Request("http://localhost/api/v1/chat/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.reply, /ANTHROPIC_API_KEY/);
  assert.equal(body.dataChanged, false);
});

test("chat DELETE clears only the caller's history", async () => {
  await appendChatMessage(identity, "user", "mine");
  const res = await chatDelete(new Request("http://localhost/api/v1/chat/messages", { method: "DELETE" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.cleared, true);
  assert.equal((await getChatHistory(identity)).length, 0);
});

test("transcript POST returns the raw text unmodified when the assistant is unconfigured", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const res = await transcriptPost(new Request("http://localhost/api/v1/chat/transcript", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript: "so, um, the the request is broken" }),
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.text, "so, um, the the request is broken");
});
