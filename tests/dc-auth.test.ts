import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  createSessionToken, readSession, sessionSetCookie, sessionClearCookie, SESSION_COOKIE,
} from "../lib/server/session";
import { verifyDcLaunch } from "../lib/server/datacentral";
import { resolveUserForDcLaunch, resolveUserForEntra } from "../lib/server/user-directory";
import { listUsers } from "../lib/server/admin-repository";

function requestWithCookie(token: string): Request {
  return new Request("http://localhost/api/v1/me", {
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
  });
}

beforeEach(() => {
  delete process.env.PULSE_SESSION_SECRET;
  delete process.env.DC_APP_SECRET;
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
