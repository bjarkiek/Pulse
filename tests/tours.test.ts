import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

test("audiences: the customer-communications tour is internal-only and never auto-starts", async () => {
  const internal = (await getTourState(CONTRIBUTOR)).tours.find((tour) => tour.key === "customer-communications");
  assert.ok(internal);
  assert.equal(internal?.autoStart, false);
  assert.ok(!(await getTourState(CUSTOMER)).tours.some((tour) => tour.key === "customer-communications"));
});

test("customer-communications: it starts on the Communications page, opens the Contacts tab by a click, and ends on the Settings card", async () => {
  const tour = (await getTourState(ADMIN)).tours.find((item) => item.key === "customer-communications");
  assert.ok(tour);
  assert.equal(tour.version, 1);
  assert.deepEqual(
    tour.steps.map((step) => [step.element, step.route]),
    [
      ["[data-tour='nav-communications']", "/communications"],
      ["[data-tour='communications-new']", "/communications"],
      ["[data-tour='communications-contacts']", "/communications"],
      ["[data-tour='settings-communications']", "/settings"],
    ],
  );
  // The Contacts tab is on the page from the first moment, so the person opens it by clicking the highlighted tab:
  // the tour has no way to switch a tab for them, and the section behind the tab is not there until it is open.
  assert.deepEqual(
    tour.steps.map((step) => step.advanceOnClick),
    [false, false, true, false],
  );
});

test("every tour step is written in both languages, and the Icelandic is not a copy of the English", () => {
  for (const def of TOUR_CATALOG) {
    for (const field of [def.title, ...def.steps.flatMap((step) => [step.title, step.description])]) {
      assert.ok(field.en.trim() && field.is.trim(), `${def.key}: both languages are written`);
      assert.notEqual(field.en, field.is, `${def.key}: "${field.en}" is not translated`);
    }
  }
});

test("every tour step points at an anchor that the app renders", () => {
  const appDirectory = fileURLToPath(new URL("../app", import.meta.url));
  const files = readdirSync(appDirectory, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".tsx"));
  const source = files.map((file) => readFileSync(join(appDirectory, file), "utf8")).join("\n");
  for (const def of TOUR_CATALOG) {
    for (const [index, step] of def.steps.entries()) {
      if (!step.element) continue;
      const name = /^\[data-tour='([a-z-]+)'\]$/.exec(step.element)?.[1];
      assert.ok(name, `${def.key} step ${index + 1}: ${step.element} is a data-tour selector`);
      // An anchor is written data-tour="x" or dataTour="x"; the tabs of the Communications page give theirs as the `tour` of the tab.
      const written = [`data-tour="${name}"`, `dataTour="${name}"`, `tour: "${name}"`];
      assert.ok(
        written.some((text) => source.includes(text)),
        `${def.key} step ${index + 1}: nothing in app/ carries data-tour="${name}"`,
      );
    }
  }
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

test("/help: the customer-communications chapter and its guide are for the DataCentral team, in both languages", async () => {
  // memory mode, no cookie → demo System-admin identity
  const html = await (await helpGet(new Request("http://localhost/help"))).text();
  assert.ok(html.includes('id="customer-communications"'), "the tour is a chapter of the admin manual");
  for (let step = 1; step <= 4; step++) {
    assert.ok(html.includes(`id="customer-communications-step-${step}"`), `step ${step}`);
    assert.ok(html.includes(`src="/help/customer-communications-step-${step}.png"`), `the screenshot of step ${step}`);
  }
  assert.ok(html.includes("Do: click the highlighted element to continue."), "the Contacts step is opened by a click");
  // the guide follows the chapters of the admin manual; it is not part of the user manual
  assert.ok(html.indexOf('id="admin"') < html.indexOf('id="communications-guide"'));
  assert.ok(html.indexOf('id="customer-communications"') < html.indexOf('id="communications-guide"'));
  for (const topic of [
    "Suppressions tab", "safe mode", "“Send test to me”", "“Send now”", "“Schedule”", "“Cancel sending”", "Dead letter",
    "“Retry dead letters”", "“Customer communications (SendGrid)”", "“Enable sending”",
  ])
    assert.ok(html.includes(topic), `the guide covers ${topic}`);

  const icelandic = await (await helpGet(new Request("http://localhost/help?lang=is"))).text();
  assert.ok(icelandic.includes('id="communications-guide"'));
  for (const topic of ["öruggur hamur", "„Senda prófun á mig“", "„Senda núna“", "„Hætta við sendingu“", "„Samskipti við viðskiptavini (SendGrid)“"])
    assert.ok(icelandic.includes(topic), `the Icelandic guide covers ${topic}`);
});

test("/help: the note for Company admins is in the user manual, for every reader and in both languages, and says nothing about the team's tools", async () => {
  const token = await createSessionToken({
    sub: CUSTOMER.id,
    email: CUSTOMER.email,
    name: CUSTOMER.name,
    ext: "dev:test",
    amr: "entra",
  });
  const read = async (query: string) => {
    const response = await helpGet(
      new Request(`http://localhost/help${query}`, {
        headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
      }),
    );
    assert.equal(response.status, 200);
    return response.text();
  };
  const english = await read("");
  assert.ok(english.includes('id="company-communications"'));
  assert.ok(english.includes("“Who receives DataCentral communications for your company”"));
  assert.ok(english.includes("“Notification preferences”"));
  assert.ok(english.indexOf('id="submit-request"') < english.indexOf('id="company-communications"'), "after the chapters of the user manual");
  const icelandic = await read("?lang=is");
  assert.ok(icelandic.includes('id="company-communications"'));
  assert.ok(icelandic.includes("„Hverjir fá samskipti frá DataCentral fyrir fyrirtækið þitt“"));
  assert.ok(icelandic.includes("„Tilkynningastillingar“"));
  for (const html of [english, icelandic]) {
    assert.ok(!html.includes('id="customer-communications"'), "no chapter of the team's tour");
    assert.ok(!html.includes('id="communications-guide"'), "no guide to the team's tools");
    assert.ok(!html.includes("SendGrid"));
    assert.ok(!html.includes('id="admin"'));
  }
  // the demo System admin reads the same note, before the admin manual starts
  const admin = await (await helpGet(new Request("http://localhost/help"))).text();
  assert.ok(admin.indexOf('id="company-communications"') < admin.indexOf('id="admin"'));
});

test("dc-auth stamps dc_onboard only when the launch carries the Onboard role", async () => {
  process.env.DC_APP_SECRET = "test-dc-app-secret";
  const makeBody = (roles: string[]) => {
    const payload = {
      userId: 42, userName: "bjarki@uidata.com", userDisplayName: "Bjarki",
      userEmail: "bjarki@uidata.com", tenancyName: "Origo", tenantId: 1,
      roleDisplayNames: roles, roleIds: [], clientUrl: "https://app.datacentral.ai",
      // Fresh timestamp: /dc-auth enforces a launch-freshness window (stale_payload).
      timeStamp: new Date().toISOString(),
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
        // host must accompany origin: the route's same-origin guard compares
        // Origin to the Host header (request.url is unreliable behind App
        // Service TLS termination) and fails closed when Host is missing.
        headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" },
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
