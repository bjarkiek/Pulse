import {
  scoreInputSchema,
  savedViewInputSchema,
  taxonomyInputSchema,
  triageInputSchema,
} from "../lib/contracts";
import { createRequest } from "../lib/server/request-repository";
import test from "node:test";
import assert from "node:assert/strict";
import { productionConfigurationErrors } from "../lib/server/production-config";
import { readJson, parseInput } from "../lib/server/validation";
import { requestInputSchema, userInputSchema } from "../lib/contracts";
import { canonicalJson, executeIdempotent } from "../lib/server/idempotency";
import { isPublicAddress, resolvePublicUrl } from "../lib/server/safe-outbound";
import { consumeLimit, trustedClientIp } from "../lib/server/rate-limit";
import { requireActiveAccount } from "../lib/server/active-account";
import { checkedMutation } from "../lib/server/versions";
import {
  readDeviceDraft,
  saveDeviceDraft,
  clearDeviceDrafts,
} from "../lib/draft-storage";
import { contentSecurityPolicy } from "../lib/security-policy";
import type { PulseIdentity } from "../lib/domain";

const user: PulseIdentity = {
  id: "88888888-8888-4888-8888-888888888888",
  email: "fixture@example.test",
  name: "Fixture",
  organizationId: "ORG-001",
  role: "Requester",
  isInternal: false,
};
const request = (body: unknown, key = "security-test-key") =>
  new Request("https://pulse.test/api/v1/requests", {
    method: "POST",
    headers: { "idempotency-key": key },
    body: JSON.stringify(body),
  });

test("production configuration rejects ephemeral, unresolved and bypass settings", () => {
  const errors = productionConfigurationErrors({
    NODE_ENV: "production",
    PULSE_SESSION_SECRET: "@Microsoft.KeyVault(SecretUri=test)",
    PULSE_ALLOW_DEMO_IDENTITY: "true",
    DC_LAUNCH_MAX_AGE_MINUTES: "0",
  });
  for (const name of [
    "AZURE_SQL_SERVER",
    "AZURE_STORAGE_ACCOUNT_NAME",
    "PULSE_SESSION_SECRET",
    "MCP_TOKEN_SIGNING_KEY",
    "PULSE_ALLOW_DEMO_IDENTITY",
    "DC_LAUNCH_MAX_AGE_MINUTES",
  ])
    assert.ok(errors.includes(name), name);
  assert.deepEqual(
    productionConfigurationErrors({ NODE_ENV: "development" }),
    [],
  );
});
test("bounded JSON reads reject oversized actual bytes and excessive nesting", async () => {
  await assert.rejects(
    readJson(request({ value: "x".repeat(2048) }), 1024),
    /PAYLOAD_TOO_LARGE/,
  );
  let nested: unknown = "end";
  for (let i = 0; i < 15; i++) nested = { nested };
  await assert.rejects(readJson(request(nested)), /INVALID_JSON_DEPTH/);
  await assert.rejects(
    readJson(request({ constructor: {} })),
    /INVALID_PROPERTY/,
  );
  assert.deepEqual(await readJson(request({ title: "valid" })), {
    title: "valid",
  });
});
test("shared contracts reject coercion, bad enums and oversized business fields", () => {
  const input = {
    title: "Example",
    problem: "Description",
    area: "Distribution",
    impact: "High",
    visibility: "Private",
  };
  assert.ok(parseInput(requestInputSchema, input));
  for (const change of [
    { affectedUsers: "5" },
    { visibility: "Public" },
    { impact: {} },
    { title: "x".repeat(141) },
  ])
    assert.throws(
      () => parseInput(requestInputSchema, { ...input, ...change }),
      /INVALID_INPUT/,
    );
  assert.throws(
    () =>
      parseInput(userInputSchema, {
        id: "new",
        name: "A",
        email: "a@example.test",
        status: "Active",
        authentication: "OTP",
        memberships: [{ companyId: "ORG-001", role: "Owner" }],
      }),
    /INVALID_INPUT/,
  );
});
test("idempotency binds user and body, canonicalizes properties, and rechecks disabled accounts", async () => {
  globalThis.pulseMemoryIdempotency = new Map();
  let calls = 0;
  const work = async () => ({ call: ++calls });
  const first = await executeIdempotent(
    request({ a: 1, b: 2 }),
    { ...user },
    "request.create",
    201,
    work,
  );
  const replay = await executeIdempotent(
    request({ b: 2, a: 1 }),
    { ...user },
    "request.create",
    201,
    work,
  );
  assert.deepEqual(first.body, replay.body);
  assert.equal(calls, 1);
  await assert.rejects(
    executeIdempotent(
      request({ a: 2, b: 2 }),
      { ...user },
      "request.create",
      201,
      work,
    ),
    /IDEMPOTENCY_CONFLICT/,
  );
  await executeIdempotent(
    request({ a: 1, b: 2 }),
    { ...user, id: "99999999-9999-4999-8999-999999999999" },
    "request.create",
    201,
    work,
  );
  assert.equal(calls, 2);
  const previous = globalThis.pulseMemoryUsers;
  globalThis.pulseMemoryUsers = [
    {
      id: user.id,
      name: user.name,
      email: user.email,
      status: "Suspended",
      authentication: "OTP",
      memberships: [],
    },
  ];
  try {
    await assert.rejects(
      executeIdempotent(
        request({ a: 1, b: 2 }),
        { ...user },
        "request.create",
        201,
        work,
      ),
      /FORBIDDEN/,
    );
    await assert.rejects(requireActiveAccount(user), /FORBIDDEN/);
  } finally {
    globalThis.pulseMemoryUsers = previous;
  }
  assert.equal(
    canonicalJson({ z: 1, a: [2, 3] }),
    canonicalJson({ a: [2, 3], z: 1 }),
  );
});
test("concurrent idempotent memory requests execute work only once", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  const first = executeIdempotent(
    request({ a: 1 }, "concurrent-key"),
    { ...user },
    "request.create",
    201,
    async () => {
      entered();
      await blocked;
      return { ok: true };
    },
  );
  await started;
  await assert.rejects(
    executeIdempotent(
      request({ a: 1 }, "concurrent-key"),
      { ...user },
      "request.create",
      201,
      async () => ({ ok: false }),
    ),
    /IDEMPOTENCY_IN_PROGRESS/,
  );
  release();
  await first;
});
test("version preconditions prevent stale and missing writes", async () => {
  const fixture = await createRequest(
    { ...user },
    {
      title: "Version fixture",
      problem: "Test versioned updates",
      area: "Distribution",
      impact: "High",
      visibility: "Private",
    },
  );
  let count = 0;
  await assert.rejects(
    checkedMutation(
      { ...user },
      "Requests",
      fixture.id,
      null,
      async () => ++count,
    ),
    /PRECONDITION_REQUIRED/,
  );
  await checkedMutation(
    { ...user },
    "Requests",
    fixture.id,
    "1",
    async () => ++count,
  );
  await assert.rejects(
    checkedMutation(
      { ...user },
      "Requests",
      fixture.id,
      "1",
      async () => ++count,
    ),
    /PRECONDITION_FAILED/,
  );
  assert.equal(count, 1);
});
test("outbound validation blocks private, mapped, reserved and mixed-purpose addresses", async () => {
  for (const address of [
    "127.0.0.1",
    "169.254.169.254",
    "10.1.1.1",
    "100.64.1.1",
    "192.0.2.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "2001:db8::1",
    "2002:7f00:1::",
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  for (const url of [
    "http://8.8.8.8",
    "https://127.0.0.1",
    "https://user:secret@8.8.8.8",
    "https://8.8.8.8:8080",
  ])
    await assert.rejects(resolvePublicUrl(url), /INVALID_WEBHOOK_URL/);
});
test("rate keys ignore forged identity hints and only trust configured ingress positions", async () => {
  const previous = process.env.PULSE_TRUSTED_PROXY_HOPS;
  try {
    delete process.env.PULSE_TRUSTED_PROXY_HOPS;
    const req = new Request("https://pulse.test", {
      headers: { "x-forwarded-for": "1.1.1.1, 8.8.8.8" },
    });
    assert.equal(trustedClientIp(req), "untrusted-ingress");
    process.env.PULSE_TRUSTED_PROXY_HOPS = "1";
    assert.equal(trustedClientIp(req), "8.8.8.8");
    await consumeLimit("security-rate-fixture", 1);
    await assert.rejects(
      consumeLimit("security-rate-fixture", 1),
      /RATE_LIMITED/,
    );
  } finally {
    if (previous === undefined) delete process.env.PULSE_TRUSTED_PROXY_HOPS;
    else process.env.PULSE_TRUSTED_PROXY_HOPS = previous;
  }
});
test("device drafts stay user/org scoped, expire and tolerate unavailable storage", () => {
  const data = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return data.size;
      },
      key: (n: number) => [...data.keys()][n] || null,
      getItem: (key: string) => data.get(key) || null,
      setItem: (key: string, v: string) => data.set(key, v),
      removeItem: (key: string) => data.delete(key),
    },
  });
  try {
    data.set("pulse-request-draft", "legacy private data");
    assert.equal(readDeviceDraft("user:org"), null);
    assert.equal(data.has("pulse-request-draft"), false);
    assert.equal(saveDeviceDraft("user:org", '{"title":"private"}'), true);
    assert.equal(readDeviceDraft("other:org"), null);
    assert.equal(readDeviceDraft("user:other"), null);
    data.set(
      "pulse-draft-v2:expired",
      JSON.stringify({ expires: 1, value: "expired" }),
    );
    assert.equal(readDeviceDraft("expired"), null);
    clearDeviceDrafts();
    assert.equal(data.size, 0);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage blocked");
      },
    });
    assert.equal(saveDeviceDraft("user:org", "data"), false);
    assert.equal(readDeviceDraft("user:org"), null);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
test("CSP script policy uses nonces rather than unsafe-inline", () => {
  const policy = contentSecurityPolicy("noncevalue", "'none'");
  const script = policy
    .split(";")
    .find((v) => v.trim().startsWith("script-src"))!;
  assert.match(script, /'nonce-noncevalue'/);
  assert.doesNotMatch(script, /unsafe-inline/);
  assert.match(policy, /frame-ancestors 'none'/);
});

test("oversized cloned JSON rejects without waiting for the original stream", async () => {
  const req = request({ value: "x".repeat(4096) });
  await assert.rejects(
    Promise.race([
      readJson(req.clone(), 1024),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("reader stalled")), 1000),
      ),
    ]),
    /PAYLOAD_TOO_LARGE/,
  );
  void req.body?.cancel();
});

test("internal action schemas reject numeric text, coerced scores and malformed lists", () => {
  for (const [schema, input] of [
    [
      scoreInputSchema,
      {
        impact: "5",
        reach: 2,
        strategicAlignment: 2,
        commercialImpact: 2,
        urgency: 2,
        confidence: 80,
        effort: 3,
        rationale: "Test",
      },
    ],
    [
      savedViewInputSchema,
      { name: 42, scope: "Private", resourceType: "Requests", query: {} },
    ],
    [
      taxonomyInputSchema,
      { id: "new", kind: "Tag", value: "Tag", active: "false", sortOrder: 1 },
    ],
    [triageInputSchema, { requestIds: "DCI-1", ownerId: "me" }],
  ] as const)
    assert.throws(() => parseInput<unknown>(schema, input), /INVALID_INPUT/);
});

