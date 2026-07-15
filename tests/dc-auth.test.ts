import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  createSessionToken, readSession, sessionSetCookie, sessionClearCookie, SESSION_COOKIE,
} from "../lib/server/session";
import { verifyDcLaunch } from "../lib/server/datacentral";
import { resolveUserForDcLaunch, resolveUserForEntra } from "../lib/server/user-directory";
import { listUsers } from "../lib/server/admin-repository";
import { POST as dcAuthPost } from "../app/dc-auth/route";
import { GET as dcEmbedGet } from "../app/dc-embed/route";
import { isEmbedRequest } from "../proxy";
import { NextRequest } from "next/server";

function requestWithCookie(token: string): Request {
  return new Request("http://localhost/api/v1/me", {
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
  });
}

beforeEach(() => {
  delete process.env.PULSE_SESSION_SECRET;
  delete process.env.DC_APP_SECRET;
  delete process.env.DC_SESSION_CHECK;
});

test("session token round-trips claims", async () => {
  const token = await createSessionToken({
    sub: "11111111-1111-4111-8111-111111111111",
    email: "bjarki@uidata.com", name: "Bjarki", ext: "dev:local", amr: "dev",
  });
  const claims = await readSession(requestWithCookie(token));
  assert.ok(claims);
  assert.equal(claims.sub, "11111111-1111-4111-8111-111111111111");
  assert.equal(claims.amr, "dev");
  assert.equal(claims.ver, 1);
});

test("tampered session token is rejected", async () => {
  const token = await createSessionToken({
    sub: "11111111-1111-4111-8111-111111111111",
    email: "a@b.c", name: "A", ext: "dev:local", amr: "dev",
  });
  const claims = await readSession(requestWithCookie(token.slice(0, -2) + "xx"));
  assert.equal(claims, null);
});

test("missing cookie yields null", async () => {
  const claims = await readSession(new Request("http://localhost/"));
  assert.equal(claims, null);
});

test("set-cookie strings carry the right attributes", () => {
  const set = sessionSetCookie("abc");
  assert.match(set, /^pulse-session=abc; Path=\/; Max-Age=\d+; HttpOnly/);
  assert.match(sessionClearCookie(), /Max-Age=0/);
});

const TEST_SECRET = "test-dc-app-secret";
const launchPayload = {
  userId: 42, userName: "jon", userDisplayName: "Jón Jónsson", userEmail: "jon@example.is",
  tenancyName: "Origo", tenantId: 7, roleDisplayNames: ["User"], roleIds: [3],
  clientUrl: "https://app.datacentral.ai", timeStamp: "2026-07-15T09:00:00Z",
};
function sign(dcdata: string): string {
  return createHmac("sha256", TEST_SECRET).update(dcdata, "utf8").digest("base64");
}

test("verifyDcLaunch accepts a correctly signed object-form payload", () => {
  process.env.DC_APP_SECRET = TEST_SECRET;
  const dcdata = Buffer.from(JSON.stringify(launchPayload), "utf8").toString("base64");
  const launch = verifyDcLaunch(dcdata, sign(dcdata));
  assert.ok(launch);
  assert.equal(launch.userId, 42);
  assert.equal(launch.userEmail, "jon@example.is");
});

test("verifyDcLaunch accepts the legacy doubly-encoded string form", () => {
  process.env.DC_APP_SECRET = TEST_SECRET;
  const dcdata = Buffer.from(JSON.stringify(JSON.stringify(launchPayload)), "utf8").toString("base64");
  const launch = verifyDcLaunch(dcdata, sign(dcdata));
  assert.ok(launch);
  assert.equal(launch.userDisplayName, "Jón Jónsson");
});

test("verifyDcLaunch rejects a tampered signature without throwing", () => {
  process.env.DC_APP_SECRET = TEST_SECRET;
  const dcdata = Buffer.from(JSON.stringify(launchPayload), "utf8").toString("base64");
  assert.equal(verifyDcLaunch(dcdata, "AAAA"), null);              // length mismatch — must not throw
  const wrong = sign(dcdata).replace(/^./, (c) => (c === "A" ? "B" : "A"));
  assert.equal(verifyDcLaunch(dcdata, wrong), null);
});

test("verifyDcLaunch rejects when secret is unset", () => {
  delete process.env.DC_APP_SECRET;
  const dcdata = Buffer.from(JSON.stringify(launchPayload), "utf8").toString("base64");
  assert.equal(verifyDcLaunch(dcdata, sign(dcdata)), null);
});

const admin = {
  id: "11111111-1111-4111-8111-111111111111", email: "bjarki@uidata.com",
  name: "Bjarki", organizationId: "ORG-INTERNAL", role: "System admin", isInternal: true,
};

beforeEach(() => {
  globalThis.pulseMemoryUsers = undefined;
  globalThis.pulseMemoryOrganizations = undefined;
  globalThis.pulseMemoryAudit = undefined;
});

test("dc launch resolves a provisioned user by email and claims the dc subject", async () => {
  const users = await listUsers(admin);
  const seeded = users.find((u) => u.email === "bjarki@uidata.com");
  assert.ok(seeded);
  const user = await resolveUserForDcLaunch({
    userId: 42, userName: "bjarki@uidata.com", userDisplayName: "Bjarki",
    userEmail: "bjarki@uidata.com", tenancyName: "Origo", tenantId: 1,
    roleDisplayNames: [], roleIds: [], clientUrl: "https://app.datacentral.ai",
    timeStamp: "2026-07-15T09:00:00Z",
  });
  assert.equal(user.id, seeded.id);
  assert.equal(user.externalSubject, "dc:42");
});

test("dc launch for an unknown email throws NOT_PROVISIONED", async () => {
  await assert.rejects(
    resolveUserForDcLaunch({
      userId: 99, userName: "nobody@nowhere.example", userDisplayName: "Nobody",
      userEmail: "nobody@nowhere.example", tenancyName: "X", tenantId: 1,
      roleDisplayNames: [], roleIds: [], clientUrl: "https://app.datacentral.ai",
      timeStamp: "2026-07-15T09:00:00Z",
    }),
    /NOT_PROVISIONED/,
  );
});

test("entra resolution matches legacy id-as-oid and stamps external_subject", async () => {
  const oid = "11111111-1111-4111-8111-111111111111";
  const user = await resolveUserForEntra(oid, "tenant-1", "bjarki@uidata.com", "Bjarki");
  assert.equal(user.id, oid);
  assert.equal(user.externalSubject, oid);
});

test("dc launch signs in a user whose subject was backfilled to an Entra oid, without rebinding", async () => {
  const oid = "11111111-1111-4111-8111-111111111111";
  await resolveUserForEntra(oid, "tenant-1", "bjarki@uidata.com", "Bjarki"); // stamps the real oid
  const user = await resolveUserForDcLaunch({
    userId: 77, userName: "bjarki@uidata.com", userDisplayName: "Bjarki",
    userEmail: "bjarki@uidata.com", tenancyName: "Origo", tenantId: 1,
    roleDisplayNames: [], roleIds: [], clientUrl: "https://app.datacentral.ai",
    timeStamp: "2026-07-15T09:00:00Z",
  });
  assert.equal(user.id, oid);
  assert.equal(user.externalSubject, oid); // oid kept — NOT rebound to dc:77
});

function dcAuthRequest(body: unknown): Request {
  return new Request("http://localhost/dc-auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("dc-auth with no credentials returns 400", async () => {
  const res = await dcAuthPost(dcAuthRequest({}));
  assert.equal(res.status, 400);
});

test("dc-auth with a bad signature returns 401", async () => {
  process.env.DC_APP_SECRET = TEST_SECRET;
  const dcdata = Buffer.from(JSON.stringify(launchPayload), "utf8").toString("base64");
  const res = await dcAuthPost(dcAuthRequest({ dcData: dcdata, dcSig: "bogus" + sign(dcdata).slice(5) }));
  assert.equal(res.status, 401);
});

test("dc-auth signed payload for provisioned user returns 200 with session cookie", async () => {
  process.env.DC_APP_SECRET = TEST_SECRET;
  process.env.DC_SESSION_CHECK = "off";
  const payload = { ...launchPayload, userEmail: "bjarki@uidata.com", userName: "bjarki@uidata.com" };
  const dcdata = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const res = await dcAuthPost(dcAuthRequest({ dcData: dcdata, dcSig: sign(dcdata) }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie") ?? "", /^pulse-session=/);
});

test("dc-auth signed payload for unknown user returns 403 not_provisioned", async () => {
  process.env.DC_APP_SECRET = TEST_SECRET;
  process.env.DC_SESSION_CHECK = "off";
  const payload = { ...launchPayload, userEmail: "nobody@nowhere.example", userName: "nobody@nowhere.example" };
  const dcdata = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const res = await dcAuthPost(dcAuthRequest({ dcData: dcdata, dcSig: sign(dcdata) }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "not_provisioned");
});

test("dc-embed page contains both AppReady spellings, forwarding, and _top fallback", async () => {
  const res = await dcEmbedGet(new Request("http://localhost/dc-embed?returnUrl=%2F%3Fdcdata%3Dabc%26dcsig%3Ddef"));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('{ type: "AppReady " }'), "AppReady WITH trailing space");
  assert.ok(html.includes('{ type: "AppReady"  }') || html.includes('{ type: "AppReady" }'), "AppReady without space");
  assert.ok(html.includes("/dc-auth"));
  assert.ok(html.includes('target="_top"'));
  assert.ok(html.includes("dcdata"));
  assert.ok(html.includes("String.fromCharCode(10)"), "diagnostic join must not use a raw newline");
});

test("dc-embed rejects non-local returnUrl (open redirect guard)", async () => {
  const res = await dcEmbedGet(new Request("http://localhost/dc-embed?returnUrl=" + encodeURIComponent("https://evil.example/steal")));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('RETURN = "/"'), "non-local returnUrl must be coerced to /");
});

test("dc-embed escapes a script-breaking returnUrl instead of injecting raw markup", async () => {
  const malicious = "/</script><script>alert(1)</script>";
  const res = await dcEmbedGet(new Request("http://localhost/dc-embed?returnUrl=" + encodeURIComponent(malicious)));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes("<script>alert(1)</script>"), "raw malicious markup must not appear unescaped");
  assert.ok(html.includes("\\u003c/script\\u003e"), "the < and > around the injected tag must be escaped");
});

test("embed detection: dcdata param or Sec-Fetch-Dest iframe", () => {
  assert.equal(isEmbedRequest(new NextRequest("http://localhost/?dcdata=x")), true);
  assert.equal(isEmbedRequest(new NextRequest("http://localhost/", {
    headers: { "sec-fetch-dest": "iframe" } })), true);
  assert.equal(isEmbedRequest(new NextRequest("http://localhost/")), false);
});
