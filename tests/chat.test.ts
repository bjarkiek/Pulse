import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  appendChatMessage, getChatHistory, clearChatHistory, getUserByEmail,
} from "../lib/server/chat/chat-repository";

const identity = {
  id: "11111111-1111-4111-8111-111111111111", email: "bjarki@uidata.com",
  name: "Bjarki", organizationId: "ORG-001", role: "System admin", isInternal: true,
};

beforeEach(() => {
  globalThis.pulseMemoryChatMessages = undefined;
  globalThis.pulseMemoryUsers = undefined;
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
