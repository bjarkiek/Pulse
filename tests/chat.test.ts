import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  appendChatMessage, getChatHistory, clearChatHistory, getUserByEmail,
} from "../lib/server/chat/chat-repository";
import { getChatTools, chatToolErrorMessage } from "../lib/server/chat/tool-registry";

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
