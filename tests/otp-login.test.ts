import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { issueOtpCode, verifyOtpCode } from "../lib/server/otp-login";
import { resolveUserForOtp } from "../lib/server/user-directory";
import { listUsers } from "../lib/server/admin-repository";

const admin = {
  id: "11111111-1111-4111-8111-111111111111", email: "bjarki@uidata.com",
  name: "Bjarki", organizationId: "ORG-INTERNAL", role: "System admin", isInternal: true,
} as never;

beforeEach(async () => {
  globalThis.pulseMemoryUsers = undefined;
  globalThis.pulseMemoryOrganizations = undefined;
  globalThis.pulseMemoryOtpCodes = undefined;
  // Seed an OTP-designated customer user next to the Entra-designated admin.
  await listUsers(admin);
  globalThis.pulseMemoryUsers!.push({
    id: "22222222-2222-4222-8222-222222222222",
    name: "Jón Jónsson", email: "jon@example.is", status: "Active",
    authentication: "OTP",
    memberships: [{ companyId: "ORG-001", role: "Requester" }],
  });
});

test("issue + verify round-trips and consumes the code (single use)", async () => {
  const { code } = await issueOtpCode("jon@example.is");
  assert.match(code, /^\d{6}$/);
  assert.equal(await verifyOtpCode("jon@example.is", code), "ok");
  assert.equal(await verifyOtpCode("jon@example.is", code), "invalid", "codes are single-use");
});

test("wrong codes count attempts and lock after 5", async () => {
  const { code } = await issueOtpCode("jon@example.is");
  for (let i = 0; i < 5; i++)
    assert.equal(await verifyOtpCode("jon@example.is", "000000"), "invalid");
  assert.equal(await verifyOtpCode("jon@example.is", code), "too_many_attempts",
    "even the right code is refused after the attempt cap");
});

test("expired codes are rejected", async () => {
  await issueOtpCode("jon@example.is");
  const entry = globalThis.pulseMemoryOtpCodes!["jon@example.is"];
  entry.expiresAt = Date.now() - 1000;
  assert.equal(await verifyOtpCode("jon@example.is", "123456"), "expired");
});

test("issuance is rate-limited per email", async () => {
  await issueOtpCode("jon@example.is");
  await issueOtpCode("jon@example.is");
  await issueOtpCode("jon@example.is");
  await assert.rejects(issueOtpCode("jon@example.is"), /RATE_LIMITED/);
});

test("a fresh code replaces the previous one", async () => {
  const first = await issueOtpCode("jon@example.is");
  const second = await issueOtpCode("jon@example.is");
  assert.equal(await verifyOtpCode("jon@example.is", first.code), "invalid");
  assert.equal(await verifyOtpCode("jon@example.is", second.code), "ok");
});

test("resolveUserForOtp resolves an Active OTP-designated user by email", async () => {
  const user = await resolveUserForOtp("jon@example.is");
  assert.equal(user.id, "22222222-2222-4222-8222-222222222222");
});

test("resolveUserForOtp refuses Entra-designated users (they must SSO)", async () => {
  await assert.rejects(resolveUserForOtp("bjarki@uidata.com"), /NOT_PROVISIONED/);
});

test("resolveUserForOtp refuses unknown emails", async () => {
  await assert.rejects(resolveUserForOtp("nobody@nowhere.example"), /NOT_PROVISIONED/);
});

// --- routes: /auth/otp/start, /auth/otp/verify, and the login screen ---
import { POST as otpStart } from "../app/auth/otp/start/route";
import { POST as otpVerify } from "../app/auth/otp/verify/route";
import { GET as loginGet } from "../app/auth/login/route";
import { readSession } from "../lib/server/session";

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost", host: "localhost", "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

test("otp start issues a code for an OTP-designated user", async () => {
  const res = await otpStart(post("/auth/otp/start", { email: "jon@example.is" }));
  assert.equal(res.status, 200);
  assert.ok(globalThis.pulseMemoryOtpCodes?.["jon@example.is"], "a code must be stored");
});

test("otp start does NOT reveal whether an account exists (same 200, no code stored)", async () => {
  const res = await otpStart(post("/auth/otp/start", { email: "nobody@nowhere.example" }));
  assert.equal(res.status, 200);
  assert.equal(globalThis.pulseMemoryOtpCodes?.["nobody@nowhere.example"], undefined);
});

test("otp start rejects cross-site posts", async () => {
  const res = await otpStart(new Request("http://localhost/auth/otp/start", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example", host: "localhost" },
    body: JSON.stringify({ email: "jon@example.is" }),
  }));
  assert.equal(res.status, 403);
});

test("otp verify with the right code mints a session (amr=otp)", async () => {
  await otpStart(post("/auth/otp/start", { email: "jon@example.is" }));
  const { code } = { code: await currentCode("jon@example.is") };
  const res = await otpVerify(post("/auth/otp/verify", { email: "jon@example.is", code }));
  assert.equal(res.status, 200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^pulse-session=/);
  const token = /pulse-session=([^;]+)/.exec(setCookie)![1];
  const claims = await readSession(new Request("http://localhost/", {
    headers: { cookie: `pulse-session=${token}` },
  }));
  assert.equal(claims?.amr, "otp");
  assert.equal(claims?.email, "jon@example.is");
});

test("otp verify with a wrong code is a 401", async () => {
  await otpStart(post("/auth/otp/start", { email: "jon@example.is" }));
  const res = await otpVerify(post("/auth/otp/verify", { email: "jon@example.is", code: "000000" }));
  assert.equal(res.status, 401);
});

test("login screen renders (dc-only OFF) with the OTP form", async () => {
  const { getRuntimeSettings } = await import("../lib/server/settings-repository");
  globalThis.pulseMemorySettings = { ...(await getRuntimeSettings()), dcOnlyAccess: false };
  // Entra configured -> the Microsoft button must render alongside the OTP form.
  process.env.AUTH_ENTRA_TENANT_ID = "t";
  process.env.AUTH_ENTRA_CLIENT_ID = "c";
  process.env.AUTH_ENTRA_CLIENT_SECRET = "s";
  try {
    const res = await loginGet(new Request("http://localhost/auth/login?returnUrl=%2F"));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("/auth/otp/start"), "OTP flow must be on the screen");
    assert.ok(html.includes("provider=microsoft") || html.includes("Microsoft"),
      "Microsoft option must be present (shown when configured)");
  } finally {
    globalThis.pulseMemorySettings = undefined;
    delete process.env.AUTH_ENTRA_TENANT_ID;
    delete process.env.AUTH_ENTRA_CLIENT_ID;
    delete process.env.AUTH_ENTRA_CLIENT_SECRET;
  }
});

test("login screen escapes a script-breaking returnUrl (XSS guard)", async () => {
  const { getRuntimeSettings } = await import("../lib/server/settings-repository");
  globalThis.pulseMemorySettings = { ...(await getRuntimeSettings()), dcOnlyAccess: false };
  try {
    const malicious = "/</script><script>alert(1)</script>";
    const res = await loginGet(new Request(
      "http://localhost/auth/login?returnUrl=" + encodeURIComponent(malicious)));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes("<script>alert(1)</script>"),
      "raw malicious markup must not appear unescaped");
    assert.ok(html.includes("\u003c/script\u003e"),
      "the injected tag's angle brackets must be escaped");
  } finally {
    globalThis.pulseMemorySettings = undefined;
  }
});

test("dc-only ON still blocks the login screen for ordinary destinations", async () => {
  globalThis.pulseMemorySettings = undefined; // defaults: ON
  const res = await loginGet(new Request("http://localhost/auth/login?returnUrl=%2F"));
  assert.equal(res.status, 302);
  assert.ok((res.headers.get("location") ?? "").includes("code=dc_only"));
});

// The memory store keeps only a hash; tests reach the plaintext via issueOtpCode's
// return, so re-issue deterministically through the internal API.
async function currentCode(email: string): Promise<string> {
  delete globalThis.pulseMemoryOtpCodes?.[email];
  const { code } = await issueOtpCode(email);
  return code;
}
