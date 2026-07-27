import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  createSessionToken, readSession, sessionSetCookie, sessionClearCookie, SESSION_COOKIE,
} from "../lib/server/session";
import { verifyDcLaunch } from "../lib/server/datacentral";
import { resolveUserForDcLaunch, resolveUserForEntra } from "../lib/server/user-directory";
import { listUsers } from "../lib/server/admin-repository";
import { getIdentity } from "../lib/server/auth";
import { POST as dcAuthPost } from "../app/dc-auth/route";
import { GET as dcEmbedGet } from "../app/dc-embed/route";
import { GET as meGet } from "../app/api/v1/me/route";
import { isEmbedRequest, proxy } from "../proxy";
import { applyEmbedAuth } from "../lib/embed-auth";
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
  delete process.env.PULSE_TRUST_DC_HEADERS;
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

test("readSession accepts the session token via Authorization: Bearer (embed mode, no cookie)", async () => {
  // Embedded sessions carry the token in a header instead of a cookie, so auth
  // works even when the browser blocks third-party cookies in the iframe.
  const token = await createSessionToken({
    sub: "11111111-1111-4111-8111-111111111111",
    email: "bjarki@uidata.com", name: "Bjarki", ext: "dc:42", amr: "dc-hmac", dc_embed: true,
  });
  const claims = await readSession(new Request("http://localhost/api/v1/me", {
    headers: { authorization: `Bearer ${token}` },
  }));
  assert.ok(claims);
  assert.equal(claims.sub, "11111111-1111-4111-8111-111111111111");
  assert.equal(claims.amr, "dc-hmac");
});

test("readSession rejects a tampered bearer token", async () => {
  const token = await createSessionToken({
    sub: "11111111-1111-4111-8111-111111111111",
    email: "a@b.c", name: "A", ext: "dev:local", amr: "dev",
  });
  const claims = await readSession(new Request("http://localhost/api/v1/me", {
    headers: { authorization: `Bearer ${token.slice(0, -2)}xx` },
  }));
  assert.equal(claims, null);
});

test("readSession ignores non-Bearer authorization schemes", async () => {
  const claims = await readSession(new Request("http://localhost/api/v1/me", {
    headers: { authorization: "Basic dXNlcjpwYXNz" },
  }));
  assert.equal(claims, null);
});

test("missing cookie yields null", async () => {
  const claims = await readSession(new Request("http://localhost/"));
  assert.equal(claims, null);
});

test("getIdentity resolves a session cookie to the session user", async () => {
  const token = await createSessionToken({
    sub: "11111111-1111-4111-8111-111111111111", email: "bjarki@uidata.com",
    name: "Bjarki", ext: "dev:local", amr: "entra",
  });
  const identity = await getIdentity(requestWithCookie(token));
  assert.equal(identity.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(identity.authMethod, "entra");
  assert.equal(identity.isVerified, true);
});

test("getIdentity falls back to demo identity outside production", async () => {
  const identity = await getIdentity(new Request("http://localhost/api/v1/me"));
  assert.equal(identity.authMethod, "dev");
  assert.equal(identity.isVerified, false);
});

test("getIdentity confines the demo fallback to memory mode: SQL-configured + PULSE_ALLOW_DEMO_IDENTITY=true still throws UNAUTHORIZED", async () => {
  // isAzureSqlConfigured() reads these env vars directly (lib/server/database.ts);
  // setting one is enough to simulate a SQL-backed (i.e. production-shaped) box
  // without needing a real database connection — getIdentity's demo branch only
  // ever calls isAzureSqlConfigured() as a boolean, never getSqlPool().
  const originalServer = process.env.AZURE_SQL_SERVER;
  const originalFlag = process.env.PULSE_ALLOW_DEMO_IDENTITY;
  process.env.AZURE_SQL_SERVER = "fake-sql-server.database.windows.net";
  process.env.PULSE_ALLOW_DEMO_IDENTITY = "true";
  try {
    await assert.rejects(
      getIdentity(new Request("http://localhost/api/v1/me")),
      /UNAUTHORIZED/,
    );
  } finally {
    if (originalServer === undefined) delete process.env.AZURE_SQL_SERVER;
    else process.env.AZURE_SQL_SERVER = originalServer;
    if (originalFlag === undefined) delete process.env.PULSE_ALLOW_DEMO_IDENTITY;
    else process.env.PULSE_ALLOW_DEMO_IDENTITY = originalFlag;
  }
});

test("getIdentity still grants the demo identity when SQL is NOT configured and PULSE_ALLOW_DEMO_IDENTITY=true", async () => {
  const originalFlag = process.env.PULSE_ALLOW_DEMO_IDENTITY;
  process.env.PULSE_ALLOW_DEMO_IDENTITY = "true";
  try {
    const identity = await getIdentity(new Request("http://localhost/api/v1/me"));
    assert.equal(identity.authMethod, "dev");
    assert.equal(identity.role, "System admin");
  } finally {
    if (originalFlag === undefined) delete process.env.PULSE_ALLOW_DEMO_IDENTITY;
    else process.env.PULSE_ALLOW_DEMO_IDENTITY = originalFlag;
  }
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
  // Fresh timestamp: /dc-auth enforces a launch-freshness window (stale_payload),
  // so the shared "valid launch" fixture must always be recent.
  clientUrl: "https://app.datacentral.ai", timeStamp: new Date().toISOString(),
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

test("dc-auth when-available: an unreachable DataCentral API must NOT block a signature-verified launch", async () => {
  // In when-available mode the accessToken corroboration is best-effort: an
  // attacker can omit the token to skip the check entirely, so failing closed
  // on an unreachable/rejecting API adds no security — it only breaks logins
  // (clientUrl may be a host the app can't reach). Only a POSITIVE identity
  // mismatch rejects; strictness belongs to DC_SESSION_CHECK=required.
  process.env.DC_APP_SECRET = TEST_SECRET;
  process.env.DC_SESSION_CHECK = "when-available";
  const payload = {
    ...launchPayload, userEmail: "bjarki@uidata.com", userName: "bjarki@uidata.com",
    clientUrl: "https://127.0.0.1:9", // unreachable: connection refused immediately
  };
  const dcdata = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const res = await dcAuthPost(dcAuthRequest({
    dcData: dcdata, dcSig: sign(dcdata), accessToken: "some-forwarded-token",
  }));
  assert.equal(res.status, 200);
});

test("dc-auth required: an unreachable DataCentral API still fails closed", async () => {
  process.env.DC_APP_SECRET = TEST_SECRET;
  process.env.DC_SESSION_CHECK = "required";
  const payload = {
    ...launchPayload, userEmail: "bjarki@uidata.com", userName: "bjarki@uidata.com",
    clientUrl: "https://127.0.0.1:9",
  };
  const dcdata = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const res = await dcAuthPost(dcAuthRequest({
    dcData: dcdata, dcSig: sign(dcdata), accessToken: "some-forwarded-token",
  }));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "session_invalid");
});

test("dc-auth 200 body carries the session token, and readSession accepts it as a bearer", async () => {
  // Embedded clients cannot rely on the Set-Cookie being stored (third-party
  // cookie blocking), so the token must also come back in the response body.
  process.env.DC_APP_SECRET = TEST_SECRET;
  process.env.DC_SESSION_CHECK = "off";
  const payload = { ...launchPayload, userEmail: "bjarki@uidata.com", userName: "bjarki@uidata.com" };
  const dcdata = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const res = await dcAuthPost(dcAuthRequest({ dcData: dcdata, dcSig: sign(dcdata) }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.token, "response body must include the session token");
  const claims = await readSession(new Request("http://localhost/api/v1/me", {
    headers: { authorization: `Bearer ${body.token}` },
  }));
  assert.ok(claims, "the body token must round-trip through readSession");
  assert.equal(claims.email, "bjarki@uidata.com");
  assert.equal(claims.dc_embed, true);
});

test("dc-auth signed payload for unknown user returns 403 not_provisioned", async () => {
  process.env.DC_APP_SECRET = TEST_SECRET;
  process.env.DC_SESSION_CHECK = "off";
  const payload = { ...launchPayload, userEmail: "nobody@nowhere.example", userName: "nobody@nowhere.example" };
  const dcdata = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const res = await dcAuthPost(dcAuthRequest({ dcData: dcdata, dcSig: sign(dcdata) }));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, "not_provisioned");
  // Echo the attempted identity so the operator knows EXACTLY which email to
  // provision (the client sent dcdata, so it already knows this — no leak).
  assert.equal(body.email, "nobody@nowhere.example");
});

test("dc-auth rejects a signed but stale launch payload with 401 stale_payload", async () => {
  // An HMAC signature never expires on its own; the dcdata/dcsig pair rides the
  // iframe URL, so a captured launch must stop working after a bounded window.
  process.env.DC_APP_SECRET = TEST_SECRET;
  process.env.DC_SESSION_CHECK = "off";
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const payload = {
    ...launchPayload, userEmail: "bjarki@uidata.com", userName: "bjarki@uidata.com",
    timeStamp: twoHoursAgo,
  };
  const dcdata = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const res = await dcAuthPost(dcAuthRequest({ dcData: dcdata, dcSig: sign(dcdata) }));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "stale_payload");
});

test("dc-auth rejects a signed payload whose timestamp is unparseable (fail closed)", async () => {
  process.env.DC_APP_SECRET = TEST_SECRET;
  process.env.DC_SESSION_CHECK = "off";
  const payload = {
    ...launchPayload, userEmail: "bjarki@uidata.com", userName: "bjarki@uidata.com",
    timeStamp: "not-a-date",
  };
  const dcdata = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const res = await dcAuthPost(dcAuthRequest({ dcData: dcdata, dcSig: sign(dcdata) }));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "stale_payload");
});

test("dc-auth accepts a stale payload when DC_LAUNCH_MAX_AGE_MINUTES=0 disables the check", async () => {
  process.env.DC_APP_SECRET = TEST_SECRET;
  process.env.DC_SESSION_CHECK = "off";
  process.env.DC_LAUNCH_MAX_AGE_MINUTES = "0";
  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const payload = {
      ...launchPayload, userEmail: "bjarki@uidata.com", userName: "bjarki@uidata.com",
      timeStamp: twoHoursAgo,
    };
    const dcdata = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    const res = await dcAuthPost(dcAuthRequest({ dcData: dcdata, dcSig: sign(dcdata) }));
    assert.equal(res.status, 200);
  } finally {
    delete process.env.DC_LAUNCH_MAX_AGE_MINUTES;
  }
});

function dcAuthEmbedRequest(
  body: unknown,
  opts: { url?: string; origin?: string; host?: string; secFetchSite?: string },
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.origin) headers.origin = opts.origin;
  if (opts.host) headers.host = opts.host;
  if (opts.secFetchSite) headers["sec-fetch-site"] = opts.secFetchSite;
  return new Request(opts.url ?? "http://localhost/dc-auth", {
    method: "POST", headers, body: JSON.stringify(body),
  });
}

test("dc-auth treats the embed POST as same-origin when App Service localizes request.url (Origin matches Host header, not request.url)", async () => {
  // Behind App Service TLS termination the container sees request.url as the
  // internal http://localhost:3000 authority, while the browser's Origin and the
  // preserved Host header are both the public host. The same-origin guard must
  // compare Origin to the Host header — comparing to request.url turns every
  // legitimate embedded login into a false cross_site_rejected (403).
  const res = await dcAuthPost(dcAuthEmbedRequest({}, {
    url: "http://localhost:3000/dc-auth",
    origin: "https://dcpulseprod-app.azurewebsites.net",
    host: "dcpulseprod-app.azurewebsites.net",
    secFetchSite: "same-origin",
  }));
  assert.notEqual((await res.clone().json()).error, "cross_site_rejected");
  assert.equal(res.status, 400); // no creds in body → falls through to missing_credentials
});

test("dc-auth still rejects a genuine cross-site POST (Origin host != Host header)", async () => {
  const res = await dcAuthPost(dcAuthEmbedRequest({}, {
    url: "http://localhost:3000/dc-auth",
    origin: "https://evil.example",
    host: "dcpulseprod-app.azurewebsites.net",
    secFetchSite: "cross-site",
  }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "cross_site_rejected");
});

test("dc-auth fails closed (403, not a throw) on a malformed Origin", async () => {
  // Browsers send the literal "null" as Origin for opaque origins; `new URL("null")`
  // throws. The guard must deny, not let the exception escape as a 500.
  const res = await dcAuthPost(dcAuthEmbedRequest({}, {
    origin: "null", host: "dcpulseprod-app.azurewebsites.net",
  }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "cross_site_rejected");
});

function dcHeaderRequest(dcData: string, dcSig: string): Request {
  return new Request("http://localhost/api/v1/me", {
    headers: { "x-dc-data": dcData, "x-dc-sig": dcSig },
  });
}

test("getIdentity gates the X-DC-Data/X-DC-Sig header path behind PULSE_TRUST_DC_HEADERS", async () => {
  process.env.DC_APP_SECRET = TEST_SECRET;
  const payload = { ...launchPayload, userEmail: "bjarki@uidata.com", userName: "bjarki@uidata.com" };
  const dcdata = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const request = () => dcHeaderRequest(dcdata, sign(dcdata));

  // Default off: valid signed headers alone must NOT resolve an identity — the branch
  // is skipped entirely and falls through to the demo fallback in this test env.
  delete process.env.PULSE_TRUST_DC_HEADERS;
  const unset = await getIdentity(request());
  assert.equal(unset.authMethod, "dev");
  assert.equal(unset.isVerified, false);

  // Opted in: the same signed headers now resolve via the dc-hmac header path.
  process.env.PULSE_TRUST_DC_HEADERS = "true";
  const enabled = await getIdentity(request());
  assert.equal(enabled.authMethod, "dc-hmac");
  assert.equal(enabled.isVerified, true);
  assert.equal(enabled.email, "bjarki@uidata.com");
});

test("GET /api/v1/me returns the canonical user shape with locale, name, and top-level auth fields", async () => {
  globalThis.pulseMemoryUsers = undefined;
  globalThis.pulseMemoryOrganizations = undefined;
  globalThis.pulseMemoryAudit = undefined;
  const res = await meGet(new Request("http://localhost/api/v1/me"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.user.locale, "user.locale must be present");
  assert.equal(body.user.locale, "en");
  assert.ok(body.user.name, "user.name must be present");
  assert.notEqual(body.authMethod, undefined);
  assert.notEqual(body.dcEmbed, undefined);
  assert.notEqual(body.isVerified, undefined);
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

test("dc-embed handshake stores the /dc-auth body token for bearer auth", async () => {
  const res = await dcEmbedGet(new Request("http://localhost/dc-embed?returnUrl=%2F"));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("pulse-embed-token"),
    "handshake must persist the token under the pulse-embed-token key");
  assert.ok(html.includes("res.json()"),
    "handshake must parse the /dc-auth JSON body (which carries the token)");
});

test("dc-embed loop-guard counter expires: stale attempts from an earlier session must not block the handshake", async () => {
  // The attempts counter lives in the tab's sessionStorage and survives every
  // iframe reload — without an expiry, failures from days ago (e.g. before a
  // fix was deployed) permanently trip the guard in that tab, before a single
  // auth attempt runs. A genuine redirect loop cycles in seconds, so only
  // recent attempts may count.
  const res = await dcEmbedGet(new Request("http://localhost/dc-embed?returnUrl=%2F"));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("dc-embed-attempts-at"),
    "guard must persist the time of the last attempt");
  assert.ok(html.includes("60000"),
    "attempts older than ~60s must reset instead of accumulating");
});

test("dc-embed authenticates top-level signed launches instead of bouncing (MCP consent path)", async () => {
  // A top-level (non-iframe) visit carrying dcdata/dcsig must POST the signed
  // payload to /dc-auth — establishing a FIRST-PARTY session cookie — rather
  // than location.replace away unauthenticated. This is how an operator gets a
  // top-level session for the MCP OAuth consent page while "Only allow access
  // via DataCentral" is on: open Pulse from DataCentral in a new tab.
  const res = await dcEmbedGet(new Request("http://localhost/dc-embed?returnUrl=%2F"));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("hmac-top-level"),
    "top-level branch must authenticate via the signed payload");
  assert.ok(html.includes('window.parent === window'),
    "top-level detection must remain");
  assert.ok(html.includes("location.replace(RETURN)"),
    "top-level WITHOUT a payload must still just navigate on");
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

test("proxy CSRF gate: a same-origin mutation passes when Origin matches the Host header even though request.url is the internal authority", async () => {
  // Behind App Service TLS termination request.nextUrl carries the container's
  // internal http://localhost:3000 authority while the browser's Origin and the
  // preserved Host header are both the public host — the same mismatch that
  // broke /dc-auth. Comparing Origin to nextUrl.host 403s EVERY legitimate API
  // mutation in production ("Cross-site mutation rejected").
  const res = await proxy(new NextRequest("http://localhost:3000/api/v1/requests", {
    method: "POST",
    headers: {
      origin: "https://dcpulseprod-app.azurewebsites.net",
      host: "dcpulseprod-app.azurewebsites.net",
      "sec-fetch-site": "same-origin",
    },
  }));
  assert.ok(res, "proxy must return a response");
  assert.notEqual(res.status, 403, "same-origin mutation must not be CSRF-rejected");
});

test("proxy CSRF gate still rejects a genuinely cross-site mutation (Origin != Host header)", async () => {
  const res = await proxy(new NextRequest("http://localhost:3000/api/v1/requests", {
    method: "POST",
    headers: {
      origin: "https://evil.example",
      host: "dcpulseprod-app.azurewebsites.net",
    },
  }));
  assert.ok(res);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, "CSRF_REJECTED");
});

test("proxy fails closed (403 CSRF_REJECTED, not a throw) on a malformed Origin during a mutation", async () => {
  // Browsers send the literal string "null" as Origin for opaque origins.
  // `new URL("null")` throws — an unguarded parse in the CSRF gate would 500
  // instead of denying the mutation, so this must land on the same
  // CSRF_REJECTED path as a genuine cross-site mismatch, not crash.
  const res = await proxy(new NextRequest("http://localhost/api/v1/requests", {
    method: "POST",
    headers: { origin: "null" },
  }));
  assert.ok(res, "proxy must return a response, not throw");
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error.code, "CSRF_REJECTED");
});

const APP_ORIGIN = "https://dcpulseprod-app.azurewebsites.net";

test("applyEmbedAuth attaches the bearer to relative (same-origin) requests", () => {
  const init = applyEmbedAuth("/api/v1/me", undefined, "tok-123", APP_ORIGIN);
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer tok-123");
});

test("applyEmbedAuth attaches the bearer to absolute same-origin URLs and preserves existing headers", () => {
  const init = applyEmbedAuth(`${APP_ORIGIN}/api/v1/requests`,
    { method: "POST", headers: { "content-type": "application/json" } }, "tok-123", APP_ORIGIN);
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("authorization"), "Bearer tok-123");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(init?.method, "POST");
});

test("applyEmbedAuth NEVER attaches the bearer cross-origin (blob SAS uploads must stay clean)", () => {
  const init = applyEmbedAuth("https://acct.blob.core.windows.net/c/b?sig=x",
    { method: "PUT" }, "tok-123", APP_ORIGIN);
  assert.equal(new Headers(init?.headers).get("authorization"), null);
});

test("applyEmbedAuth does not override an explicit Authorization header", () => {
  const init = applyEmbedAuth("/mcp", { headers: { authorization: "Bearer mcp-token" } },
    "tok-123", APP_ORIGIN);
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer mcp-token");
});

test("applyEmbedAuth is a no-op without a token", () => {
  const init = { method: "POST" };
  assert.equal(applyEmbedAuth("/api/v1/me", init, null, APP_ORIGIN), init);
});

async function withProductionGate<T>(fn: () => Promise<T>): Promise<T> {
  // The proxy's unauthenticated-page gate only engages when NODE_ENV=production
  // and a session secret is configured; emulate that and restore afterwards.
  const env = process.env.NODE_ENV;
  const secretBefore = process.env.PULSE_SESSION_SECRET;
  (process.env as Record<string, string>).NODE_ENV = "production";
  process.env.PULSE_SESSION_SECRET = "proxy-test-session-secret-0123456789abcdef";
  try { return await fn(); }
  finally {
    (process.env as Record<string, string>).NODE_ENV = env ?? "test";
    if (secretBefore === undefined) delete process.env.PULSE_SESSION_SECRET;
    else process.env.PULSE_SESSION_SECRET = secretBefore;
  }
}

test("proxy lets an unauthenticated iframe document WITHOUT dcdata through anonymously (bearer-auth shell)", async () => {
  // Embedded reloads carry no cookie when the browser blocks third-party
  // cookies, and document navigations cannot carry an Authorization header —
  // so the embed shell must render anonymously; the APIs stay authenticated.
  await withProductionGate(async () => {
    const res = await proxy(new NextRequest("http://localhost/", {
      headers: { "sec-fetch-dest": "iframe" },
    }));
    assert.ok(res, "proxy must return a response");
    assert.equal(res.status, 200, "embed shell must pass through, not redirect");
    assert.ok((res.headers.get("content-security-policy") ?? "").includes("frame-ancestors"),
      "pass-through must still carry the framing CSP");
  });
});

test("proxy still routes a fresh unauthenticated launch (dcdata on URL) to /dc-embed", async () => {
  await withProductionGate(async () => {
    const res = await proxy(new NextRequest("http://localhost/?dcdata=abc&dcsig=def", {
      headers: { "sec-fetch-dest": "iframe" },
    }));
    assert.ok(res);
    assert.equal(res.status, 302);
    const location = res.headers.get("location") ?? "";
    assert.ok(location.includes("/dc-embed"), `fresh launches still handshake (got ${location})`);
  });
});

test("proxy still redirects an unauthenticated standalone document to /auth/login", async () => {
  await withProductionGate(async () => {
    const res = await proxy(new NextRequest("http://localhost/"));
    assert.ok(res);
    assert.equal(res.status, 302);
    assert.ok((res.headers.get("location") ?? "").includes("/auth/login"));
  });
});

test("embed detection: dcdata param or Sec-Fetch-Dest iframe", () => {
  assert.equal(isEmbedRequest(new NextRequest("http://localhost/?dcdata=x")), true);
  assert.equal(isEmbedRequest(new NextRequest("http://localhost/", {
    headers: { "sec-fetch-dest": "iframe" } })), true);
  assert.equal(isEmbedRequest(new NextRequest("http://localhost/")), false);
});

// Next.js does NOT merge proxy-set headers with the static CSP from next.config.ts's
// headers() — it replaces it. The proxy must therefore compose the FULL policy itself
// on every branch, not just append frame-ancestors. This test locks that behavior in.
test("proxy composes the full CSP (base directives + frame-ancestors), not just frame-ancestors alone", async () => {
  const mcpRes = await proxy(new NextRequest("http://localhost/mcp"));
  assert.ok(mcpRes, "proxy must return a NextResponse for a matched path");
  const mcpCsp = mcpRes.headers.get("content-security-policy") ?? "";
  assert.ok(mcpCsp.includes("default-src 'self'"), "mcp CSP must retain base default-src");
  assert.ok(mcpCsp.includes("frame-ancestors 'none'"), "mcp CSP must deny framing");

  const rootRes = await proxy(new NextRequest("http://localhost/"));
  assert.ok(rootRes, "proxy must return a NextResponse for a matched path");
  const rootCsp = rootRes.headers.get("content-security-policy") ?? "";
  assert.ok(rootCsp.includes("default-src 'self'"), "root CSP must retain base default-src");
  assert.ok(
    rootCsp.includes("connect-src 'self' https://*.blob.core.windows.net"),
    "root CSP must retain base connect-src",
  );
  assert.ok(rootCsp.includes("frame-ancestors"), "root CSP must still declare frame-ancestors");
});

test("dc-only access (default ON): /auth/login shows the DataCentral-only notice instead of starting the Entra flow", async () => {
  const { GET: loginGet } = await import("../app/auth/login/route");
  globalThis.pulseMemorySettings = undefined; // reset to defaults (dcOnlyAccess: true)
  try {
    const res = await loginGet(new Request("http://localhost/auth/login?returnUrl=%2F"));
    assert.equal(res.status, 302);
    assert.ok((res.headers.get("location") ?? "").includes("/auth/error?code=dc_only"),
      `default must route to the dc_only notice (got ${res.headers.get("location")})`);
  } finally {
    globalThis.pulseMemorySettings = undefined;
  }
});

test("dc-only access OFF: /auth/login behaves as before (Entra flow / oidc_failed when unconfigured)", async () => {
  const { GET: loginGet } = await import("../app/auth/login/route");
  const { getRuntimeSettings } = await import("../lib/server/settings-repository");
  const current = await getRuntimeSettings();
  globalThis.pulseMemorySettings = { ...current, dcOnlyAccess: false };
  try {
    const res = await loginGet(new Request("http://localhost/auth/login?returnUrl=%2F"));
    assert.equal(res.status, 302);
    // Entra unconfigured in tests -> the pre-existing graceful degradation path.
    assert.ok((res.headers.get("location") ?? "").includes("/auth/error?code=oidc_failed"));
  } finally {
    globalThis.pulseMemorySettings = undefined;
  }
});
