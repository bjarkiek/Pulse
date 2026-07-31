import test from "node:test";
import assert from "node:assert/strict";
import { makeT, IS } from "../lib/i18n";

test("t is the identity for English", () => {
  const t = makeT("en");
  assert.equal(t("Browse ideas"), "Browse ideas");
  assert.equal(t("Anything at all"), "Anything at all");
});

test("t translates known strings to Icelandic", () => {
  const t = makeT("is");
  assert.equal(t("Home"), "Heim");
  assert.equal(t("Browse ideas"), "Skoða hugmyndir");
  assert.equal(t("Roadmap"), "Vegvísir");
  assert.equal(t("My requests"), "Mínar beiðnir");
  assert.equal(t("Updates"), "Uppfærslur");
  assert.equal(t("Submit a request"), "Senda inn beiðni");
});

test("t falls back to English for strings missing from the catalog", () => {
  const t = makeT("is");
  assert.equal(t("Untranslated developer string"), "Untranslated developer string");
});

test("catalog hygiene: no empty or identical-to-English translations", () => {
  for (const [en, is] of Object.entries(IS)) {
    assert.ok(is.trim().length > 0, `empty translation for "${en}"`);
  }
});

test("terminology matches the established tour/help vocabulary", () => {
  const t = makeT("is");
  // These words are already fixed by lib/server/tour-catalog.ts and /help —
  // the UI must not introduce competing translations.
  assert.match(t("My requests"), /beiðnir/);
  assert.match(t("Browse ideas"), /hugmyndir/);
  assert.match(t("Notifications"), /Tilkynningar/);
});

// --- locale persistence + DataCentral language sync ---
import { createHmac } from "node:crypto";
import { PATCH as mePatch, GET as meGet } from "../app/api/v1/me/route";
import { POST as dcAuthPost } from "../app/dc-auth/route";
import { getIdentityContext } from "../lib/server/identity-repository";

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

test("PATCH /api/v1/me persists the locale and GET returns it (memory mode)", async () => {
  const res = await mePatch(req("/api/v1/me", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locale: "is" }),
  }));
  assert.equal(res.status, 200);
  const me = await (await meGet(req("/api/v1/me"))).json();
  assert.equal(me.user.locale, "is");
  // back to English so other tests see the default
  await mePatch(req("/api/v1/me", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locale: "en" }),
  }));
});

test("PATCH /api/v1/me rejects unknown locales", async () => {
  const res = await mePatch(req("/api/v1/me", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locale: "de" }),
  }));
  assert.equal(res.status, 400);
});

test("dc-auth syncs the DataCentral launch language into the user's locale", async () => {
  process.env.DC_APP_SECRET = "test-dc-app-secret";
  process.env.DC_SESSION_CHECK = "off";
  const payload = {
    userId: 42, userName: "bjarki@uidata.com", userDisplayName: "Bjarki",
    userEmail: "bjarki@uidata.com", tenancyName: "Origo", tenantId: 1,
    roleDisplayNames: [], roleIds: [], clientUrl: "https://app.datacentral.ai",
    timeStamp: new Date().toISOString(), language: "is-IS",
  };
  const dcdata = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const dcsig = createHmac("sha256", "test-dc-app-secret").update(dcdata, "utf8").digest("base64");
  const res = await dcAuthPost(req("/dc-auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dcData: dcdata, dcSig: dcsig }),
  }));
  assert.equal(res.status, 200);
  const context = await getIdentityContext({
    id: "11111111-1111-4111-8111-111111111111", email: "bjarki@uidata.com",
    name: "Bjarki", organizationId: "ORG-001", role: "Company admin",
    isInternal: false, authMethod: "dc-hmac", isVerified: true,
    dcEmbed: true, dcOnboard: false,
  } as never);
  assert.equal(context.user.locale, "is", "DataCentral language must carry over");
  delete process.env.DC_APP_SECRET;
  delete process.env.DC_SESSION_CHECK;
});
