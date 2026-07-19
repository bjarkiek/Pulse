import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { PulseIdentity } from "../lib/domain";
import {
  createSessionToken,
  readSession,
  SESSION_COOKIE,
} from "../lib/server/session";
import { getIdentity } from "../lib/server/auth";
import { POST as dcAuthPost } from "../app/dc-auth/route";
import { GET as helpGet } from "../app/help/route";
import {
  getOnboardingAdmin,
  getOnboardingEnabled,
  getTourState,
  hideToursForever,
  reportTourProgress,
  restoreUserTours,
  saveOnboardingSettings,
} from "../lib/server/tour-repository";
import { TOUR_CATALOG } from "../lib/server/tour-catalog";

// All tests run in memory mode (no AZURE_SQL_* env), exercising the same
// eligibility/invariant code paths the SQL branch mirrors.

const CUSTOMER: PulseIdentity = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "customer@origo.is",
  name: "Customer",
  organizationId: "ORG-001",
  role: "Requester",
  isInternal: false,
};
const CONTRIBUTOR: PulseIdentity = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "staff@datacentral.ai",
  name: "Staff",
  organizationId: "ORG-INTERNAL",
  role: "Internal contributor",
  isInternal: true,
};
const ADMIN: PulseIdentity = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "bjarki@uidata.com",
  name: "Bjarki",
  organizationId: "ORG-INTERNAL",
  role: "System admin",
  isInternal: true,
};

beforeEach(() => {
  delete process.env.AZURE_SQL_CONNECTION_STRING;
  delete process.env.AZURE_SQL_SERVER;
  globalThis.pulseMemoryOnboardingEnabled = undefined;
  globalThis.pulseMemoryTourSettings = undefined;
  globalThis.pulseMemoryTourProgress = undefined;
  globalThis.pulseMemoryTourOptOuts = undefined;
  globalThis.pulseMemoryUsers = undefined;
  globalThis.pulseMemoryOrganizations = undefined;
  globalThis.pulseMemoryAudit = undefined;
});

test("audiences: customers only receive All/Customers tours", async () => {
  const state = await getTourState(CUSTOMER);
  assert.equal(state.suppressed, false);
  const keys = state.tours.map((tour) => tour.key);
  assert.ok(keys.includes("welcome"));
  assert.ok(keys.includes("submit-request"));
  assert.ok(!keys.includes("team-workspace"));
  assert.ok(!keys.includes("admin-settings"));
  const welcome = state.tours.find((tour) => tour.key === "welcome");
  assert.equal(welcome?.autoStart, true);
  assert.equal(welcome?.status, "NotStarted");
});

test("audiences: internal contributors get the team tour but not admin-settings", async () => {
  const keys = (await getTourState(CONTRIBUTOR)).tours.map((tour) => tour.key);
  assert.ok(keys.includes("team-workspace"));
  assert.ok(!keys.includes("admin-settings"));
});

test("audiences: System admins get every tour", async () => {
  const keys = (await getTourState(ADMIN)).tours.map((tour) => tour.key);
  for (const def of TOUR_CATALOG) assert.ok(keys.includes(def.key));
});

test("embed sessions are gated on the DataCentral Onboard role", async () => {
  const embedded = { ...CUSTOMER, dcEmbed: true, dcOnboard: false };
  assert.equal((await getTourState(embedded)).suppressed, true);
  const onboarded = { ...CUSTOMER, dcEmbed: true, dcOnboard: true };
  assert.equal((await getTourState(onboarded)).suppressed, false);
});

test("master switch suppresses everyone and only System admins can flip it", async () => {
  assert.equal(await getOnboardingEnabled(), true); // default ON when unset
  await saveOnboardingSettings(ADMIN, { enabled: false, tours: [] });
  assert.equal((await getTourState(CUSTOMER)).suppressed, true);
  assert.equal((await getTourState(ADMIN)).suppressed, true);
  await saveOnboardingSettings(ADMIN, { enabled: true, tours: [] });
  assert.equal((await getTourState(CUSTOMER)).suppressed, false);
  await assert.rejects(
    saveOnboardingSettings(CUSTOMER, { enabled: false, tours: [] }),
    /FORBIDDEN/,
  );
});

test("per-tour settings: disabling and audience changes filter the state payload", async () => {
  await saveOnboardingSettings(ADMIN, {
    enabled: true,
    tours: [
      { tourKey: "welcome", enabled: true, audience: "Internal", autoStart: true },
      { tourKey: "submit-request", enabled: false, audience: "All", autoStart: false },
    ],
  });
  const customerKeys = (await getTourState(CUSTOMER)).tours.map((t) => t.key);
  assert.ok(!customerKeys.includes("welcome")); // now Internal-only
  assert.ok(!customerKeys.includes("submit-request")); // disabled
  const staffKeys = (await getTourState(CONTRIBUTOR)).tours.map((t) => t.key);
  assert.ok(staffKeys.includes("welcome"));
  await assert.rejects(
    saveOnboardingSettings(ADMIN, {
      enabled: true,
      tours: [{ tourKey: "welcome", enabled: true, audience: "Everyone", autoStart: true }],
    }),
    /INVALID_ONBOARDING_SETTINGS/,
  );
});

test("progress: resume position tracks the furthest step and terminal statuses stick", async () => {
  await reportTourProgress(CUSTOMER, {
    key: "welcome", version: 1, stepIndex: 3, stepCount: 9, status: "InProgress",
  });
  await reportTourProgress(CUSTOMER, {
    key: "welcome", version: 1, stepIndex: 1, stepCount: 9, status: "InProgress",
  });
  let welcome = (await getTourState(CUSTOMER)).tours.find((t) => t.key === "welcome");
  assert.equal(welcome?.status, "InProgress");
  assert.equal(welcome?.resumeAt, 3); // max step wins
  assert.equal(welcome?.autoStart, false); // started → no auto-start

  await reportTourProgress(CUSTOMER, {
    key: "welcome", version: 1, stepIndex: 8, stepCount: 9, status: "Completed",
  });
  // re-running a finished tour must never downgrade Completed (§5.6.1)
  await reportTourProgress(CUSTOMER, {
    key: "welcome", version: 1, stepIndex: 2, stepCount: 9, status: "Dismissed",
  });
  welcome = (await getTourState(CUSTOMER)).tours.find((t) => t.key === "welcome");
  assert.equal(welcome?.status, "Completed");
});

test("progress: stale lower-version reports are ignored; only a forward bump resets", async () => {
  await reportTourProgress(CUSTOMER, {
    key: "welcome", version: 2, stepIndex: 8, stepCount: 9, status: "Completed",
  });
  // a delayed report from a client still holding version 1 must not touch the row
  await reportTourProgress(CUSTOMER, {
    key: "welcome", version: 1, stepIndex: 0, stepCount: 9, status: "InProgress",
  });
  let row = globalThis.pulseMemoryTourProgress?.find((r) => r.tourKey === "welcome");
  assert.equal(row?.version, 2);
  assert.equal(row?.status, "Completed");
  // a forward version bump legitimately starts the tour over
  await reportTourProgress(CUSTOMER, {
    key: "welcome", version: 3, stepIndex: 1, stepCount: 9, status: "InProgress",
  });
  row = globalThis.pulseMemoryTourProgress?.find((r) => r.tourKey === "welcome");
  assert.equal(row?.version, 3);
  assert.equal(row?.status, "InProgress");
  assert.equal(row?.lastStepIndex, 1);
  assert.equal(row?.completedAt, null);
});

test("progress: unknown keys are ignored, malformed reports rejected", async () => {
  await reportTourProgress(CUSTOMER, {
    key: "not-a-tour", version: 1, stepIndex: 0, stepCount: 3, status: "InProgress",
  });
  assert.equal(globalThis.pulseMemoryTourProgress?.length ?? 0, 0);
  await assert.rejects(
    reportTourProgress(CUSTOMER, {
      key: "welcome", version: 1, stepIndex: 5, stepCount: 3, status: "InProgress",
    }),
    /INVALID_TOUR_PROGRESS/,
  );
  await assert.rejects(
    reportTourProgress(CUSTOMER, {
      key: "welcome", version: 1, stepIndex: 0, stepCount: 9, status: "Paused",
    }),
    /INVALID_TOUR_PROGRESS/,
  );
});

test("hide forever suppresses tours until a System admin restores them", async () => {
  await hideToursForever(CUSTOMER);
  assert.equal((await getTourState(CUSTOMER)).suppressed, true);
  const admin = await getOnboardingAdmin(ADMIN);
  // the demo/in-memory user grid only tracks provisioned users; the opt-out
  // itself is keyed by user id and must round-trip through restore
  await assert.rejects(restoreUserTours(CUSTOMER, CUSTOMER.id), /FORBIDDEN/);
  await restoreUserTours(ADMIN, CUSTOMER.id);
  assert.equal((await getTourState(CUSTOMER)).suppressed, false);
  assert.ok(admin.settings.length >= TOUR_CATALOG.length);
});

test("admin payload is System-admin only and scopes stats data", async () => {
  await assert.rejects(getOnboardingAdmin(CUSTOMER), /FORBIDDEN/);
  await assert.rejects(getOnboardingAdmin(CONTRIBUTOR), /FORBIDDEN/);
  await reportTourProgress(CUSTOMER, {
    key: "welcome", version: 1, stepIndex: 0, stepCount: 9, status: "InProgress",
  });
  const admin = await getOnboardingAdmin(ADMIN);
  assert.equal(admin.enabled, true);
  assert.equal(
    admin.progress.filter((row) => row.tourKey === "welcome").length,
    1,
  );
  assert.equal(admin.progress[0].source, "standalone");
});

test("/help shows the admin manual to the demo System admin, in the requested language", async () => {
  // memory mode, no cookie → demo System-admin identity
  const response = await helpGet(new Request("http://localhost/help"));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('id="admin"'));
  assert.ok(html.includes('id="team-workspace"'));
  assert.ok(html.includes('id="admin-settings"'));
  assert.ok(html.includes('id="welcome"'));
  const icelandic = await (
    await helpGet(new Request("http://localhost/help?lang=is"))
  ).text();
  assert.ok(icelandic.includes("Notendahandbók"));
});

test("/help never serves admin chapters to a customer session", async () => {
  // a session cookie yields a customer-shaped identity in memory mode
  // (role "Unknown", isInternal false) — the admin manual must be absent
  const token = await createSessionToken({
    sub: CUSTOMER.id,
    email: CUSTOMER.email,
    name: CUSTOMER.name,
    ext: "dev:test",
    amr: "entra",
  });
  const response = await helpGet(
    new Request("http://localhost/help", {
      headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    }),
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('id="welcome"'));
  assert.ok(html.includes('id="submit-request"'));
  assert.ok(!html.includes('id="admin"'));
  assert.ok(!html.includes('id="team-workspace"'));
  assert.ok(!html.includes('id="admin-settings"'));
  assert.ok(!html.includes("Triage inbox")); // no internal tour content leaks
});

test("dc-auth stamps dc_onboard only when the launch carries the Onboard role", async () => {
  process.env.DC_APP_SECRET = "test-dc-app-secret";
  const makeBody = (roles: string[]) => {
    const payload = {
      userId: 42, userName: "bjarki@uidata.com", userDisplayName: "Bjarki",
      userEmail: "bjarki@uidata.com", tenancyName: "Origo", tenantId: 1,
      roleDisplayNames: roles, roleIds: [], clientUrl: "https://app.datacentral.ai",
      timeStamp: "2026-07-15T09:00:00Z",
    };
    const dcData = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    const dcSig = createHmac("sha256", "test-dc-app-secret")
      .update(dcData, "utf8")
      .digest("base64");
    return JSON.stringify({ dcData, dcSig });
  };
  const post = (body: string) =>
    dcAuthPost(
      new Request("http://localhost/dc-auth", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body,
      }),
    );

  const withRole = await post(makeBody(["User", "Onboard"]));
  assert.equal(withRole.status, 200);
  const cookie = withRole.headers.get("set-cookie") ?? "";
  const token = /pulse-session=([^;]+)/.exec(cookie)?.[1] ?? "";
  const claims = await readSession(
    new Request("http://localhost/", {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    }),
  );
  assert.equal(claims?.dc_onboard, true);
  const identity = await getIdentity(
    new Request("http://localhost/api/v1/tours/state", {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    }),
  );
  assert.equal(identity.dcOnboard, true);
  assert.equal(identity.dcEmbed, true);

  const withoutRole = await post(makeBody(["User"]));
  assert.equal(withoutRole.status, 200);
  const plainToken =
    /pulse-session=([^;]+)/.exec(withoutRole.headers.get("set-cookie") ?? "")?.[1] ?? "";
  const plainClaims = await readSession(
    new Request("http://localhost/", {
      headers: { cookie: `${SESSION_COOKIE}=${plainToken}` },
    }),
  );
  assert.equal(plainClaims?.dc_onboard, undefined);
  delete process.env.DC_APP_SECRET;
});
