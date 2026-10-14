import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { compileNonPath } from "next/dist/shared/lib/router/utils/prepare-destination";
import { NextRequest } from "next/server";
import nextConfig from "../next.config";
import { proxy } from "../proxy";
import type { PulseIdentity } from "../lib/domain";
import { ApiFailure, errorMessage } from "../lib/api-client";
import { IS, makeT } from "../lib/i18n";
import { createSessionToken } from "../lib/server/session";
import { requestHasBody } from "../lib/server/validation";
import { organizations, users } from "../lib/server/admin-repository";
import { memoryDeliveries, resetCommunicationMemory } from "../lib/server/communications/memory";
import { getDeliveryStore } from "../lib/server/communications/delivery-store";
import { DEFAULT_COMMUNICATION_SETTINGS, saveCommunicationSettings } from "../lib/server/communications/settings";
import { GET as communicationsGet, POST as communicationsPost } from "../app/api/v1/internal/communications/route";
import { GET as communicationGet, PATCH as communicationPatch, DELETE as communicationDelete } from "../app/api/v1/internal/communications/[id]/route";
import { POST as duplicatePost } from "../app/api/v1/internal/communications/[id]/duplicate/route";
import { GET as previewGet } from "../app/api/v1/internal/communications/[id]/preview/route";
import { GET as audienceGet } from "../app/api/v1/internal/communications/[id]/audience/route";
import { POST as testPost } from "../app/api/v1/internal/communications/[id]/test/route";
import { POST as sendPost } from "../app/api/v1/internal/communications/[id]/send/route";
import { POST as cancelPost } from "../app/api/v1/internal/communications/[id]/cancel/route";
import { GET as deliveriesGet } from "../app/api/v1/internal/communications/[id]/deliveries/route";
import { POST as retryPost } from "../app/api/v1/internal/communications/[id]/deliveries/retry/route";
import { GET as internalContactsGet, POST as internalContactsPost } from "../app/api/v1/internal/communications/contacts/route";
import { PATCH as internalContactPatch, DELETE as internalContactDelete } from "../app/api/v1/internal/communications/contacts/[contactId]/route";
import { GET as suppressionsGet, POST as suppressionsPost, DELETE as suppressionsDelete } from "../app/api/v1/internal/communications/suppressions/route";
import { GET as companyContactsGet, POST as companyContactsPost } from "../app/api/v1/communications/contacts/route";
import { PATCH as companyContactPatch, DELETE as companyContactDelete } from "../app/api/v1/communications/contacts/[contactId]/route";
import { POST as eventsPost } from "../app/api/v1/internal/communications/events/route";
import { POST as communicationsJobPost } from "../app/api/v1/internal/jobs/communications/route";
import { POST as notificationsJobPost } from "../app/api/v1/internal/jobs/notifications/route";
import { POST as retentionJobPost } from "../app/api/v1/internal/jobs/retention/route";
import { POST as webhooksJobPost } from "../app/api/v1/internal/jobs/webhooks/route";
import { GET as deliveryStatusGet, POST as deliveryStatusPost } from "../app/api/v1/admin/delivery/route";
import { GET as settingsGet, PATCH as settingsPatch } from "../app/api/v1/admin/communications/settings/route";
import { POST as settingsTestPost } from "../app/api/v1/admin/communications/settings/test/route";

// Memory mode (no AZURE_SQL_*, NODE_ENV !== production): an anonymous request resolves to the
// demo fallback identity in lib/server/auth.ts — the seeded System admin (ORG-001, isInternal).
// Route tests therefore exercise the real admin code paths without a session cookie, while
// customer-role paths (Company admin) are covered at the repository level in communications.test.ts.
function req(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { host: "localhost", origin: "http://localhost", "sec-fetch-site": "same-origin", "content-type": "application/json", ...(init.headers || {}) },
  });
}

beforeEach(() => {
  delete process.env.AZURE_SQL_CONNECTION_STRING;
  delete process.env.AZURE_SQL_SERVER;
  delete process.env.SENDGRID_API_KEY;
  delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
  globalThis.pulseMemoryUsers = undefined;
  globalThis.pulseMemoryOrganizations = undefined;
  globalThis.pulseMemoryAudit = undefined;
  globalThis.pulseMemoryIdempotency = undefined;
  resetCommunicationMemory();
});

const INTERNAL_CONTACTS = "/api/v1/internal/communications/contacts";
const SUPPRESSIONS = "/api/v1/internal/communications/suppressions";
const COMPANY_CONTACTS = "/api/v1/communications/contacts";
const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  req(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const forContact = (contactId: string) => ({ params: Promise.resolve({ contactId }) });
const contact = (over: Record<string, unknown> = {}) => ({
  organizationId: "ORG-001", email: "cio@origo.is", displayName: "CIO", locale: "is", topics: ["product-updates"], ...over,
});
async function createContact(over: Record<string, unknown> = {}) {
  const response = await internalContactsPost(send("POST", INTERNAL_CONTACTS, contact(over)));
  assert.equal(response.status, 201);
  return (await response.json()).item as { id: string; email: string; displayName: string; topics: string[] };
}

test("routes: internal contacts list, create and validation (demo System admin identity)", async () => {
  const bad = await internalContactsPost(req("/api/v1/internal/communications/contacts", { method: "POST", body: JSON.stringify({ organizationId: "ORG-001", email: "not-an-email", displayName: "x", topics: [] }) }));
  assert.equal(bad.status, 400);
  const created = await internalContactsPost(req("/api/v1/internal/communications/contacts", { method: "POST", body: JSON.stringify({ organizationId: "ORG-001", email: "cio@origo.is", displayName: "CIO", locale: "is", topics: ["product-updates"] }) }));
  assert.equal(created.status, 201);
  assert.equal((await created.json()).item.email, "cio@origo.is");
  const list = await internalContactsGet(req("/api/v1/internal/communications/contacts?organizationId=ORG-001"));
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("cache-control"), "no-store");
  assert.equal((await list.json()).items.length, 1);
});

test("routes: company contacts need a Company admin membership (the demo admin is not one → 404)", async () => {
  const response = await companyContactsGet(req("/api/v1/communications/contacts"));
  assert.equal(response.status, 404);
});

test("routes: the organisation filter narrows the list and the caller's correlation id comes back on success and on error", async () => {
  await createContact();
  const correlation = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const all = await internalContactsGet(send("GET", INTERNAL_CONTACTS, undefined, { "x-correlation-id": correlation }));
  assert.equal(all.status, 200);
  assert.equal(all.headers.get("x-correlation-id"), correlation);
  assert.equal((await all.json()).items.length, 1);
  const other = await internalContactsGet(send("GET", `${INTERNAL_CONTACTS}?organizationId=ORG-404`));
  assert.deepEqual(await other.json(), { items: [] });
  const bad = await internalContactsPost(send("POST", INTERNAL_CONTACTS, { email: "nope" }, { "x-correlation-id": correlation }));
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("x-correlation-id"), correlation);
  const error = (await bad.json()).error;
  assert.equal(error.code, "INVALID_INPUT");
  assert.equal(error.correlationId, correlation);
});

test("routes: an organisation filter, when given, is 1 to 32 characters; an empty or longer one is 400, not a query", async () => {
  for (const filter of ["", "x".repeat(33)]) {
    const refused = await internalContactsGet(send("GET", `${INTERNAL_CONTACTS}?organizationId=${filter}`));
    assert.equal(refused.status, 400, `a filter of ${filter.length} characters`);
    assert.equal((await refused.json()).error.code, "INVALID_INPUT");
  }
  const longest = await internalContactsGet(send("GET", `${INTERNAL_CONTACTS}?organizationId=${"x".repeat(32)}`));
  assert.equal(longest.status, 200);
  assert.deepEqual(await longest.json(), { items: [] });
});

test("routes: an edit and a removal go through the contact id in the URL, which wins over any id in the body", async () => {
  const { id } = await createContact();
  const stranger = "99999999-9999-4999-8999-999999999999";
  const edited = await internalContactPatch(
    send("PATCH", `${INTERNAL_CONTACTS}/${id}`, contact({ id: stranger, displayName: "Chief Information Officer", locale: "en", topics: ["service-notices", "general"] })),
    forContact(id),
  );
  assert.equal(edited.status, 200);
  const item = (await edited.json()).item;
  assert.equal(item.id, id);
  assert.equal(item.displayName, "Chief Information Officer");
  assert.deepEqual(item.topics, ["service-notices", "general"]);
  const listed = (await (await internalContactsGet(send("GET", INTERNAL_CONTACTS))).json()).items;
  assert.equal(listed.length, 1, "an edit never adds a second row");
  assert.equal(listed[0].displayName, "Chief Information Officer");

  const removed = await internalContactDelete(send("DELETE", `${INTERNAL_CONTACTS}/${id}`), forContact(id));
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ok: true });
  assert.deepEqual((await (await internalContactsGet(send("GET", INTERNAL_CONTACTS))).json()).items, []);
  assert.equal((await internalContactDelete(send("DELETE", `${INTERNAL_CONTACTS}/${id}`), forContact(id))).status, 404);
});

test("routes: editing a contact that does not exist, or whose id is malformed, is 404; a bad body is 400", async () => {
  const { id } = await createContact();
  const stranger = "99999999-9999-4999-8999-999999999999";
  const patch = (contactId: string, body: unknown) => internalContactPatch(send("PATCH", `${INTERNAL_CONTACTS}/${contactId}`, body), forContact(contactId));
  assert.equal((await patch(stranger, contact())).status, 404);
  assert.equal((await patch("not-a-uuid", contact())).status, 404);
  assert.equal((await patch(id, contact({ email: "not-an-email" }))).status, 400);
  assert.equal((await patch(id, contact({ topics: [] }))).status, 400);
  assert.equal((await internalContactDelete(send("DELETE", `${INTERNAL_CONTACTS}/not-a-uuid`), forContact("not-a-uuid"))).status, 404);
  assert.equal((await internalContactDelete(send("DELETE", `${INTERNAL_CONTACTS}/${stranger}`), forContact(stranger))).status, 404);
  const listed = (await (await internalContactsGet(send("GET", INTERNAL_CONTACTS))).json()).items;
  assert.equal(listed.length, 1, "none of the refused calls changed the list");
  assert.equal(listed[0].displayName, "CIO");
});

test("routes: a POST always creates; an id in the body is ignored and never edits or chooses the id of a contact", async () => {
  const a = await createContact({ email: "a@origo.is", displayName: "Alpha", topics: ["general"] });
  const edit = await internalContactsPost(send("POST", INTERNAL_CONTACTS, contact({ id: a.id, email: "b@origo.is", displayName: "Beta", topics: ["service-notices"] })));
  assert.equal(edit.status, 201);
  const b = (await edit.json()).item;
  assert.notEqual(b.id, a.id, "the contact named by the body id is not the one that was written");
  assert.equal(b.email, "b@origo.is");
  const stranger = "99999999-9999-4999-8999-999999999999";
  const chosen = await internalContactsPost(send("POST", INTERNAL_CONTACTS, contact({ id: stranger, email: "c@origo.is", displayName: "Gamma" })));
  assert.equal(chosen.status, 201, "an id that names no contact is no reason to refuse a create");
  assert.notEqual((await chosen.json()).item.id, stranger);
  const listed = (await (await internalContactsGet(send("GET", INTERNAL_CONTACTS))).json()).items as Array<{ id: string; email: string; displayName: string; topics: string[] }>;
  assert.equal(listed.length, 3);
  const first = listed.find((c) => c.id === a.id);
  assert.deepEqual([first?.email, first?.displayName, first?.topics], ["a@origo.is", "Alpha", ["general"]], "the contact the body id named is unchanged");
});

test("routes: a body with pasted lines imports contacts and reports what was skipped; the organisation is required", async () => {
  await createContact({ email: "jon@origo.is", displayName: "Jón" });
  const imported = await internalContactsPost(send("POST", INTERNAL_CONTACTS, {
    organizationId: "ORG-001", lines: "Jón, jon@origo.is\nAnna Sig, anna@origo.is\nnot an address", topics: ["service-notices"],
  }));
  assert.equal(imported.status, 201);
  const result = await imported.json();
  assert.deepEqual(result.created.map((c: { email: string }) => c.email), ["anna@origo.is"]);
  assert.deepEqual(result.created[0].topics, ["service-notices"]);
  assert.deepEqual(result.skipped, [{ line: 1, reason: "duplicate" }, { line: 3, reason: "invalid" }]);
  assert.equal((await (await internalContactsGet(send("GET", INTERNAL_CONTACTS))).json()).items.length, 2);
  assert.equal((await internalContactsPost(send("POST", INTERNAL_CONTACTS, { lines: "bob@origo.is" }))).status, 400);
  assert.equal((await internalContactsPost(send("POST", INTERNAL_CONTACTS, { organizationId: "ORG-001", lines: "" }))).status, 400);
  assert.equal((await internalContactsPost(send("POST", INTERNAL_CONTACTS, { organizationId: "ORG-404", lines: "bob@origo.is" }))).status, 404);
  assert.equal((await (await internalContactsGet(send("GET", INTERNAL_CONTACTS))).json()).items.length, 2, "the refused imports added nothing");
});

test("routes: suppressions are listed, added by address and lifted by address", async () => {
  const empty = await suppressionsGet(send("GET", SUPPRESSIONS));
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get("cache-control"), "no-store");
  assert.deepEqual(await empty.json(), { items: [] });
  assert.equal((await suppressionsPost(send("POST", SUPPRESSIONS, { email: "not-an-email" }))).status, 400);
  const added = await suppressionsPost(send("POST", SUPPRESSIONS, { email: "Opt.Out@Example.com", note: "asked by phone" }));
  assert.equal(added.status, 201);
  const item = (await added.json()).item;
  assert.equal(item.email, "opt.out@example.com");
  assert.equal(item.reason, "Manual");
  assert.equal(item.source, "Admin");
  assert.deepEqual((await (await suppressionsGet(send("GET", SUPPRESSIONS))).json()).items.map((s: { email: string }) => s.email), ["opt.out@example.com"]);

  assert.equal((await suppressionsDelete(send("DELETE", SUPPRESSIONS))).status, 400, "a removal names the address in its body");
  assert.equal((await suppressionsDelete(send("DELETE", SUPPRESSIONS, { email: "not-an-email" }))).status, 400);
  assert.equal((await suppressionsDelete(send("DELETE", SUPPRESSIONS, { email: "someone-else@example.com" }))).status, 404);
  assert.equal((await (await suppressionsGet(send("GET", SUPPRESSIONS))).json()).items.length, 1, "the refused removals changed nothing");
  const lifted = await suppressionsDelete(send("DELETE", SUPPRESSIONS, { email: "OPT.out@example.com" }));
  assert.equal(lifted.status, 200);
  assert.deepEqual(await lifted.json(), { ok: true });
  assert.deepEqual((await (await suppressionsGet(send("GET", SUPPRESSIONS))).json()).items, []);
});

test("routes: the company routes serve only a Company admin of the active organisation, never the internal data paths", async () => {
  const { id } = await createContact();
  const refused = [
    await companyContactsGet(send("GET", COMPANY_CONTACTS)),
    await companyContactsPost(send("POST", COMPANY_CONTACTS, { email: "new@origo.is", displayName: "New", topics: ["general"] })),
    await companyContactsPost(send("POST", COMPANY_CONTACTS, { lines: "new@origo.is", topics: ["general"] })),
    await companyContactPatch(send("PATCH", `${COMPANY_CONTACTS}/${id}`, { email: "cio@origo.is", displayName: "Renamed", topics: ["general"] }), forContact(id)),
    await companyContactDelete(send("DELETE", `${COMPANY_CONTACTS}/${id}`), forContact(id)),
  ];
  assert.deepEqual(refused.map((response) => response.status), [404, 404, 404, 404, 404]);
  for (const response of refused) assert.equal((await response.json()).error.code, "FORBIDDEN");
  const listed = (await (await internalContactsGet(send("GET", INTERNAL_CONTACTS))).json()).items;
  assert.equal(listed.length, 1, "nothing was created or removed on the customer's behalf");
  assert.equal(listed[0].displayName, "CIO");
});

test("routes: a signed-in user who is not internal staff is refused by every internal route and every company route", async () => {
  const { id } = await createContact();
  const token = await createSessionToken({ sub: "22222222-2222-4222-8222-222222222222", email: "jon@origo.is", name: "Jón Jónsson", ext: "dev:test", amr: "dev" });
  const asUser = { authorization: `Bearer ${token}` };
  const refused = [
    await internalContactsGet(send("GET", INTERNAL_CONTACTS, undefined, asUser)),
    await internalContactsPost(send("POST", INTERNAL_CONTACTS, contact({ email: "extra@origo.is" }), asUser)),
    await internalContactsPost(send("POST", INTERNAL_CONTACTS, { organizationId: "ORG-001", lines: "extra@origo.is" }, asUser)),
    await internalContactPatch(send("PATCH", `${INTERNAL_CONTACTS}/${id}`, contact({ displayName: "Renamed" }), asUser), forContact(id)),
    await internalContactDelete(send("DELETE", `${INTERNAL_CONTACTS}/${id}`, undefined, asUser), forContact(id)),
    await suppressionsGet(send("GET", SUPPRESSIONS, undefined, asUser)),
    await suppressionsPost(send("POST", SUPPRESSIONS, { email: "extra@origo.is" }, asUser)),
    await suppressionsDelete(send("DELETE", SUPPRESSIONS, { email: "extra@origo.is" }, asUser)),
    await companyContactsGet(send("GET", COMPANY_CONTACTS, undefined, asUser)),
    await companyContactsPost(send("POST", COMPANY_CONTACTS, { email: "extra@origo.is", displayName: "Extra", topics: ["general"] }, asUser)),
  ];
  assert.deepEqual(refused.map((response) => response.status), refused.map(() => 404));
  for (const response of refused) assert.equal((await response.json()).error.code, "FORBIDDEN");
  const listed = (await (await internalContactsGet(send("GET", INTERNAL_CONTACTS))).json()).items;
  assert.deepEqual(listed.map((c: { email: string; displayName: string }) => [c.email, c.displayName]), [["cio@origo.is", "CIO"]]);
  assert.deepEqual((await (await suppressionsGet(send("GET", SUPPRESSIONS))).json()).items, []);
});

test("openapi: the request bodies of the contact and suppression operations list only the fields their routes accept", () => {
  const spec = JSON.parse(readFileSync(new URL("../public/openapi.json", import.meta.url), "utf8"));
  const fields = (path: string, method: string): string[] => {
    const ref: string = spec.paths[path][method].requestBody.content["application/json"].schema.$ref;
    return Object.keys(spec.components.schemas[ref.split("/").pop() as string].properties).sort();
  };
  const contactFields = ["displayName", "email", "locale", "note", "topics"];
  const internal = "/api/v1/internal/communications/contacts";
  const company = "/api/v1/communications/contacts";
  const suppressions = "/api/v1/internal/communications/suppressions";
  // No id: a POST always creates and the contact an edit changes is named by the URL. Customers never name the organisation.
  assert.deepEqual(fields(internal, "post"), [...contactFields, "organizationId"].sort());
  assert.deepEqual(fields(`${internal}/{contactId}`, "patch"), [...contactFields, "organizationId"].sort());
  assert.deepEqual(fields(company, "post"), contactFields);
  assert.deepEqual(fields(`${company}/{contactId}`, "patch"), contactFields);
  // A suppression carries an optional note; lifting one names the address only.
  assert.deepEqual(fields(suppressions, "post"), ["email", "note"]);
  assert.deepEqual(fields(suppressions, "delete"), ["email"]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Campaign routes. Same memory-mode setup as above: an anonymous request is the seeded System admin, who is a publisher too. The memory
// versions (`checkedMutation`) are module-private and outlive `beforeEach`, so every If-Match below is the version a response carried.

const CAMPAIGNS = "/api/v1/internal/communications";
const forCampaign = (id: string) => ({ params: Promise.resolve({ id }) });
/** The parts of a campaign response these tests read. */
type CampaignItem = { id: string; version: string; status: string; title: string; recipientCount: number; scheduledAt?: string; completedAt?: string; cancelledAt?: string; stats: { recipients: number; queued: number; cancelled: number; deadLettered: number } };
type DeliveryItem = { email: string; state: string; source: string; organizationId: string | null; locale: string };
const plainDraft = {
  templateKey: "plain", topic: "general", title: "Route test",
  content: { subject: { en: "Hello" }, body: { en: { title: "Hi", paragraphs: ["One"] } } },
  audience: { organizations: "all-customers" },
};
let keyCounter = 0;
/** A new Idempotency-Key: 8 to 100 characters of letters, digits and . _ : - */
const freshKey = () => `route-test-key-${++keyCounter}`;
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
const ADMIN: PulseIdentity = { id: "11111111-1111-4111-8111-111111111111", email: "bjarki@uidata.com", name: "Bjarki", organizationId: "ORG-INTERNAL", role: "System admin", isInternal: true };
/** Sending on: the provider key is set and the settings are enabled with safe mode off. A System admin saves them here through the repository; the settings route has tests of its own further down. */
async function enableSending() {
  process.env.SENDGRID_API_KEY = "SG.test";
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai", safeMode: { enabled: false, allowedDomains: [] } });
}
const ifMatch = (version?: string): Record<string, string> => (version === undefined ? {} : { "if-match": version });
async function createDraft(over: Record<string, unknown> = {}): Promise<CampaignItem> {
  const response = await communicationsPost(send("POST", CAMPAIGNS, { ...plainDraft, ...over }, { "idempotency-key": freshKey() }));
  assert.equal(response.status, 201);
  return (await response.json()).item;
}
async function getCampaign(id: string): Promise<CampaignItem> {
  const response = await communicationGet(send("GET", `${CAMPAIGNS}/${id}`), forCampaign(id));
  assert.equal(response.status, 200);
  return (await response.json()).item;
}
const patchCampaign = (id: string, body: unknown, version?: string) => communicationPatch(send("PATCH", `${CAMPAIGNS}/${id}`, body, ifMatch(version)), forCampaign(id));
const sendCampaign = (id: string, body: unknown, version?: string, key = freshKey()) =>
  sendPost(send("POST", `${CAMPAIGNS}/${id}/send`, body, { ...ifMatch(version), "idempotency-key": key }), forCampaign(id));
const cancelCampaign = (id: string, body: unknown, version?: string) => cancelPost(send("POST", `${CAMPAIGNS}/${id}/cancel`, body, ifMatch(version)), forCampaign(id));
const testSendCampaign = (id: string, body: unknown, key = freshKey()) => testPost(send("POST", `${CAMPAIGNS}/${id}/test`, body, { "idempotency-key": key }), forCampaign(id));
const duplicateCampaign = (id: string, key = freshKey()) => duplicatePost(send("POST", `${CAMPAIGNS}/${id}/duplicate`, undefined, { "idempotency-key": key }), forCampaign(id));
const retryCampaign = (id: string, key = freshKey()) => retryPost(send("POST", `${CAMPAIGNS}/${id}/deliveries/retry`, undefined, { "idempotency-key": key }), forCampaign(id));
async function deliveriesOf(id: string, query = ""): Promise<{ items: DeliveryItem[]; total: number }> {
  const response = await deliveriesGet(send("GET", `${CAMPAIGNS}/${id}/deliveries${query}`), forCampaign(id));
  assert.equal(response.status, 200);
  return response.json();
}
/** The status and the error code of a refused call. */
const refusal = async (response: Response) => [response.status, (await response.json()).error.code];
const auditCount = (action: string) => globalThis.pulseMemoryAudit?.filter((entry) => entry.action === action).length ?? 0;

test("routes: create needs an Idempotency-Key, then list and preview work (demo System admin identity)", async () => {
  const missingKey = await communicationsPost(req("/api/v1/internal/communications", { method: "POST", body: JSON.stringify(plainDraft) }));
  assert.equal(missingKey.status, 400);
  const created = await communicationsPost(req("/api/v1/internal/communications", { method: "POST", headers: { "idempotency-key": "route-test-create-1" }, body: JSON.stringify(plainDraft) }));
  assert.equal(created.status, 201);
  const id = (await created.json()).item.id as string;
  assert.match(id, /^COM-\d{3}$/);
  const list = await communicationsGet(req("/api/v1/internal/communications"));
  assert.equal(list.status, 200);
  assert.equal((await list.json()).items.length, 1);
  const preview = await previewGet(req(`/api/v1/internal/communications/${id}/preview?locale=is`), { params: Promise.resolve({ id }) });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(preview.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(await preview.text(), /Tilkynning/);
  const missing = await previewGet(req("/api/v1/internal/communications/COM-999/preview"), { params: Promise.resolve({ id: "COM-999" }) });
  assert.equal(missing.status, 404);
});

test("routes: creating is idempotent by key — a replay answers with the stored campaign, another body under the key is 409 — and a release pre-fill reaches the repository", async () => {
  const key = freshKey();
  const first = await communicationsPost(send("POST", CAMPAIGNS, plainDraft, { "idempotency-key": key }));
  assert.equal(first.status, 201);
  const created = await first.json();
  const replay = await communicationsPost(send("POST", CAMPAIGNS, plainDraft, { "idempotency-key": key }));
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), created, "the replay is the stored answer, not a second campaign");
  assert.equal((await (await communicationsGet(send("GET", CAMPAIGNS))).json()).items.length, 1);
  const other = await communicationsPost(send("POST", CAMPAIGNS, { ...plainDraft, title: "Another title" }, { "idempotency-key": key }));
  assert.deepEqual(await refusal(other), [409, "IDEMPOTENCY_CONFLICT"]);
  for (const bad of ["short", "has spaces in it", "x".repeat(101)]) {
    const refused = await communicationsPost(send("POST", CAMPAIGNS, plainDraft, { "idempotency-key": bad }));
    assert.deepEqual(await refusal(refused), [400, "INVALID_IDEMPOTENCY_KEY"], `a key of ${bad.length} characters`);
  }
  // A body with only fromReleaseId is a draft from that release; a release that does not exist is the repository's 404.
  const noRelease = await communicationsPost(send("POST", CAMPAIGNS, { fromReleaseId: "REL-404" }, { "idempotency-key": freshKey() }));
  assert.deepEqual(await refusal(noRelease), [404, "NOT_FOUND"]);
  assert.equal((await (await communicationsGet(send("GET", CAMPAIGNS))).json()).items.length, 1, "nothing was created by the refused calls");
});

test("routes: a draft is edited under its version, read back with its stats, and reviewed through the audience estimate", async () => {
  await enableSending();
  await createContact({ email: "cio@origo.is", displayName: "CIO", locale: "is", topics: ["general"] });
  const draft = await createDraft();
  assert.deepEqual([draft.status, draft.title, draft.recipientCount], ["Draft", "Route test", 0]);
  assert.equal(typeof draft.version, "string");
  const review = () => audienceGet(send("GET", `${CAMPAIGNS}/${draft.id}/audience`), forCampaign(draft.id));
  const before = await review();
  assert.equal(before.status, 200);
  assert.deepEqual((await before.json()).item, { organizations: 1, members: 1, contacts: 1, internal: 0, suppressed: {}, total: 2, sendable: 2 }, "the demo admin as a member and the contact");

  const edited = await patchCampaign(draft.id, { ...plainDraft, title: "Route test, edited", audience: { organizations: "all-customers", includeContacts: false } }, draft.version);
  assert.equal(edited.status, 200);
  const editedItem = (await edited.json()).item as CampaignItem;
  assert.deepEqual([editedItem.id, editedItem.title], [draft.id, "Route test, edited"]);
  assert.notEqual(editedItem.version, draft.version, "an edit moves the version");

  const read = await communicationGet(send("GET", `${CAMPAIGNS}/${draft.id}`), forCampaign(draft.id));
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "no-store");
  const item = (await read.json()).item as CampaignItem;
  assert.deepEqual([item.title, item.version, item.status], ["Route test, edited", editedItem.version, "Draft"]);
  assert.equal(item.stats.recipients, 0, "a read carries the delivery stats");

  const after = await review();
  assert.deepEqual((await after.json()).item, { organizations: 1, members: 1, contacts: 0, internal: 0, suppressed: {}, total: 1, sendable: 1 }, "the estimate follows the saved audience");
  assert.equal((await deliveriesOf(draft.id)).total, 0, "reviewing writes nothing");
});

test("routes: a test send queues the caller and the staff addresses named, is left out of the stats, and replays by key", async () => {
  await enableSending();
  users().push({ id: "33333333-3333-4333-8333-333333333333", name: "Staff", email: "staff@datacentral.ai", status: "Active", authentication: "Entra ID", memberships: [{ companyId: "ORG-001", role: "Internal contributor" }] });
  const draft = await createDraft();
  const noKey = await testPost(send("POST", `${CAMPAIGNS}/${draft.id}/test`, {}), forCampaign(draft.id));
  assert.deepEqual(await refusal(noKey), [400, "INVALID_IDEMPOTENCY_KEY"]);
  const body = { extraRecipients: ["Staff@DataCentral.ai", "stranger@example.com", "bjarki@uidata.com"] };
  const key = freshKey();
  const first = await testSendCampaign(draft.id, body, key);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { queued: 2 }, "the caller and the staff address; a stranger is ignored and the caller is not queued twice");
  const replay = await testSendCampaign(draft.id, body, key);
  assert.deepEqual(await replay.json(), { queued: 2 });
  assert.equal(auditCount("communication.test-sent"), 1, "the replay queued nothing again");
  const rows = (await deliveriesOf(draft.id)).items;
  assert.deepEqual(rows.map((r) => [r.email, r.source, r.state]).sort(), [["bjarki@uidata.com", "Test", "Queued"], ["staff@datacentral.ai", "Test", "Queued"]]);
  assert.equal((await getCampaign(draft.id)).stats.recipients, 0, "test rows never count");
  const bare = await testSendCampaign(draft.id, undefined);
  assert.deepEqual(await bare.json(), { queued: 1 }, "no body is no extra recipients");
});

test("routes: send freezes the audience and answers with the Sending campaign; the deliveries page and filter; cancel stops what is waiting", async () => {
  await enableSending();
  // Two companies, three recipients: the demo admin (a member of ORG-001), a contact of ORG-001 who reads Icelandic, and a contact of ORG-002.
  organizations().push({ id: "ORG-002", name: "Advania", type: "Customer", status: "Active", domain: "advania.is", users: 0, requests: 0, authentication: ["OTP"] });
  await createContact({ email: "cio@origo.is", displayName: "CIO", locale: "is", topics: ["general"] });
  await createContact({ organizationId: "ORG-002", email: "anna@advania.is", displayName: "Anna", locale: "en", topics: ["general"] });
  const draft = await createDraft();

  const sent = await sendCampaign(draft.id, {}, draft.version);
  assert.equal(sent.status, 200);
  const sentItem = (await sent.json()).item as CampaignItem;
  assert.deepEqual([sentItem.id, sentItem.status, sentItem.recipientCount], [draft.id, "Sending", 3]);
  assert.notEqual(sentItem.version, draft.version);

  const all = await deliveriesOf(draft.id);
  assert.equal(all.total, 3);
  assert.deepEqual(all.items.map((r) => [r.email, r.organizationId, r.source, r.state, r.locale]).sort(), [
    ["anna@advania.is", "ORG-002", "Contact", "Queued", "en"],
    ["bjarki@uidata.com", "ORG-001", "Member", "Queued", "en"],
    ["cio@origo.is", "ORG-001", "Contact", "Queued", "is"],
  ]);
  assert.equal((await deliveriesOf(draft.id, "?state=Queued")).total, 3);
  const delivered = await deliveriesOf(draft.id, "?state=Delivered");
  assert.deepEqual([delivered.items, delivered.total], [[], 0]);
  assert.deepEqual([(await deliveriesOf(draft.id, "?organizationId=ORG-001")).total, (await deliveriesOf(draft.id, "?organizationId=ORG-002")).total], [2, 1]);
  assert.deepEqual((await deliveriesOf(draft.id, "?organizationId=ORG-404")).items, []);
  const second = await deliveriesOf(draft.id, "?page=2&pageSize=2");
  assert.deepEqual([second.items.length, second.total], [1, 3], "the second page of two holds the third row");
  const first = await deliveriesOf(draft.id, "?page=1&pageSize=2");
  assert.deepEqual([first.items.length, first.total], [2, 3]);
  const junk = await deliveriesOf(draft.id, "?page=abc&pageSize=abc&state=&organizationId=");
  assert.deepEqual([junk.items.length, junk.total], [3, 3], "values that are not numbers or filters fall back to the defaults");

  // The campaign has left Draft: it cannot be edited, sent again or deleted.
  assert.deepEqual(await refusal(await patchCampaign(draft.id, plainDraft, sentItem.version)), [400, "INVALID_COMMUNICATION_NOT_EDITABLE"]);
  assert.deepEqual(await refusal(await sendCampaign(draft.id, {}, sentItem.version)), [400, "INVALID_COMMUNICATION_STATE"]);
  assert.deepEqual(await refusal(await communicationDelete(send("DELETE", `${CAMPAIGNS}/${draft.id}`), forCampaign(draft.id))), [400, "INVALID_COMMUNICATION_NOT_DELETABLE"]);

  const cancelled = await cancelCampaign(draft.id, undefined, sentItem.version);
  assert.equal(cancelled.status, 200);
  const cancelledItem = (await cancelled.json()).item as CampaignItem;
  assert.equal(cancelledItem.status, "Cancelled");
  assert.ok(cancelledItem.cancelledAt, "the cancel time is recorded");
  assert.notEqual(cancelledItem.version, sentItem.version);
  assert.equal((await deliveriesOf(draft.id, "?state=Cancelled")).total, 3, "everything still waiting is cancelled");
  assert.equal((await deliveriesOf(draft.id, "?state=Queued")).total, 0);
  const final = await getCampaign(draft.id);
  assert.deepEqual([final.stats.recipients, final.stats.cancelled, final.stats.queued], [3, 3, 0]);
  assert.deepEqual(await refusal(await cancelCampaign(draft.id, undefined, cancelledItem.version)), [400, "INVALID_COMMUNICATION_STATE"], "a cancelled campaign cannot be cancelled again");
});

test("routes: a send is replay-safe — the key returns the stored answer and mails nobody twice — and is bound to its body", async () => {
  await enableSending();
  const draft = await createDraft();
  const noKey = await sendPost(send("POST", `${CAMPAIGNS}/${draft.id}/send`, {}, ifMatch(draft.version)), forCampaign(draft.id));
  assert.deepEqual(await refusal(noKey), [400, "INVALID_IDEMPOTENCY_KEY"]);
  assert.equal((await getCampaign(draft.id)).status, "Draft", "a send without a key does nothing");

  const key = freshKey();
  const first = await sendCampaign(draft.id, {}, draft.version, key);
  assert.equal(first.status, 200);
  const stored = await first.json();
  const replay = await sendCampaign(draft.id, {}, draft.version, key);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), stored, "the replay is the stored answer even though the version it names has moved on");
  assert.equal((await deliveriesOf(draft.id)).total, 1);
  assert.equal(auditCount("communication.sent"), 1, "and it was sent once");
  const conflict = await sendCampaign(draft.id, { scheduledAt: inAnHour() }, draft.version, key);
  assert.deepEqual(await refusal(conflict), [409, "IDEMPOTENCY_CONFLICT"]);
});

test("routes: an Idempotency-Key belongs to the campaign it is used on — the same key is no replay, and no conflict, for another campaign", async () => {
  await enableSending();
  const a = await createDraft();
  const b = await createDraft();
  const key = freshKey();
  const answers = [
    await sendCampaign(a.id, {}, a.version, key), await sendCampaign(b.id, {}, b.version, key),
    await testSendCampaign(a.id, undefined, key), await testSendCampaign(b.id, undefined, key),
    await retryCampaign(a.id, key), await retryCampaign(b.id, key),
    await duplicateCampaign(a.id, key), await duplicateCampaign(b.id, key),
  ];
  assert.deepEqual(answers.map((response) => response.status), [200, 200, 200, 200, 200, 200, 201, 201]);
  assert.equal((await getCampaign(a.id)).status, "Sending");
  assert.equal((await getCampaign(b.id)).status, "Sending", "the second campaign was sent too, not answered with the first one's stored response");
});

test("routes: editing, sending and cancelling name the version they saw — none is 428, a stale one 412 — and a refused call changes nothing", async () => {
  await enableSending();
  const draft = await createDraft();
  const moved = await patchCampaign(draft.id, { ...plainDraft, title: "Moved on" }, draft.version); // draft.version is stale from here on
  assert.equal(moved.status, 200);
  const current = (await moved.json()).item as CampaignItem;
  const refused = [
    await patchCampaign(draft.id, { ...plainDraft, title: "Lost" }),
    await patchCampaign(draft.id, { ...plainDraft, title: "Lost" }, draft.version),
    await sendCampaign(draft.id, {}),
    await sendCampaign(draft.id, {}, draft.version),
    await cancelCampaign(draft.id, {}),
    await cancelCampaign(draft.id, {}, draft.version),
  ];
  assert.deepEqual(await Promise.all(refused.map(refusal)), [
    [428, "PRECONDITION_REQUIRED"], [412, "PRECONDITION_FAILED"],
    [428, "PRECONDITION_REQUIRED"], [412, "PRECONDITION_FAILED"],
    [428, "PRECONDITION_REQUIRED"], [412, "PRECONDITION_FAILED"],
  ]);
  const unchanged = await getCampaign(draft.id);
  assert.deepEqual([unchanged.title, unchanged.status, unchanged.version], ["Moved on", "Draft", current.version]);
  assert.equal((await deliveriesOf(draft.id)).total, 0, "nobody was mailed");

  const sent = await sendCampaign(draft.id, {}, current.version);
  assert.equal(sent.status, 200);
  assert.deepEqual(await refusal(await sendCampaign(draft.id, {}, current.version)), [412, "PRECONDITION_FAILED"], "a second send under the version the first one used, with a key of its own");
});

test("routes: a refused call leaves its Idempotency-Key free — a 412 or an invalid body under a key does not stop the corrected call under the same key", async () => {
  await enableSending();
  const draft = await createDraft();
  const moved = await patchCampaign(draft.id, { ...plainDraft, title: "Moved on" }, draft.version);
  const current = (await moved.json()).item as CampaignItem;

  const sendKey = freshKey();
  const stale = await sendCampaign(draft.id, {}, draft.version, sendKey); // the version the caller read is behind
  assert.deepEqual(await refusal(stale), [412, "PRECONDITION_FAILED"]);
  const fixed = await sendCampaign(draft.id, {}, current.version, sendKey); // reloaded, and the same key again
  assert.equal(fixed.status, 200);
  assert.equal((await fixed.json()).item.status, "Sending");
  assert.equal((await deliveriesOf(draft.id)).total, 1, "and it was sent once");

  const createKey = freshKey();
  const invalid = await communicationsPost(send("POST", CAMPAIGNS, { ...plainDraft, title: "" }, { "idempotency-key": createKey }));
  assert.deepEqual(await refusal(invalid), [400, "INVALID_INPUT"]);
  const valid = await communicationsPost(send("POST", CAMPAIGNS, plainDraft, { "idempotency-key": createKey }));
  assert.equal(valid.status, 201);
  const created = (await valid.json()).item as CampaignItem;
  const replay = await communicationsPost(send("POST", CAMPAIGNS, plainDraft, { "idempotency-key": createKey }));
  assert.equal((await replay.json()).item.id, created.id, "the corrected call is the one that is stored and replayed");
});

test("routes: an id too long to name a campaign is 404 before the version, the key or the database is looked at", async () => {
  await enableSending();
  const draft = await createDraft();
  const long = `COM-${"1".repeat(36)}`; // 40 characters: more than the 32 an id is bound as
  const huge = `COM-${"1".repeat(116)}`; // 120: the operation name that carries it no longer fits the 100 characters an idempotency record stores
  assert.deepEqual([long.length, huge.length], [40, 120]);
  const call = (method: string, id: string, suffix: string, body: unknown, headers: Record<string, string> = {}) => send(method, `${CAMPAIGNS}/${id}${suffix}`, body, headers);
  const refused = [
    // no version, which a real id would answer with 428
    await communicationPatch(call("PATCH", long, "", plainDraft), forCampaign(long)),
    await sendPost(call("POST", long, "/send", {}, { "idempotency-key": freshKey() }), forCampaign(long)),
    await cancelPost(call("POST", long, "/cancel", {}), forCampaign(long)),
    // with one
    await communicationPatch(call("PATCH", long, "", plainDraft, ifMatch(draft.version)), forCampaign(long)),
    await sendPost(call("POST", long, "/send", {}, { ...ifMatch(draft.version), "idempotency-key": freshKey() }), forCampaign(long)),
    await cancelPost(call("POST", long, "/cancel", {}, ifMatch(draft.version)), forCampaign(long)),
    // no key, which a real id would answer with 400
    await duplicatePost(call("POST", huge, "/duplicate", undefined), forCampaign(huge)),
    await testPost(call("POST", huge, "/test", {}), forCampaign(huge)),
    await sendPost(call("POST", huge, "/send", {}, ifMatch(draft.version)), forCampaign(huge)),
    await retryPost(call("POST", huge, "/deliveries/retry", undefined), forCampaign(huge)),
    // with one
    await duplicateCampaign(huge),
    await testSendCampaign(huge, {}),
    await sendCampaign(huge, {}, draft.version),
    await retryCampaign(huge),
  ];
  assert.deepEqual(await Promise.all(refused.map(refusal)), refused.map(() => [404, "NOT_FOUND"]));
  // The same calls on a real id are refused for what they lack.
  assert.deepEqual(await refusal(await communicationPatch(call("PATCH", draft.id, "", plainDraft), forCampaign(draft.id))), [428, "PRECONDITION_REQUIRED"]);
  assert.deepEqual(await refusal(await sendPost(call("POST", draft.id, "/send", {}, ifMatch(draft.version)), forCampaign(draft.id))), [400, "INVALID_IDEMPOTENCY_KEY"]);
  const listed = (await (await communicationsGet(send("GET", CAMPAIGNS))).json()).items;
  assert.deepEqual([(await getCampaign(draft.id)).status, listed.length], ["Draft", 1], "nothing was created or sent");
});

test("routes: a send with scheduledAt schedules the campaign, and unscheduling makes it a Draft again", async () => {
  await enableSending();
  const draft = await createDraft();
  const past = await sendCampaign(draft.id, { scheduledAt: new Date(Date.now() - 60_000).toISOString() }, draft.version);
  assert.deepEqual(await refusal(past), [400, "INVALID_SCHEDULE_TIME"]);
  const when = inAnHour();
  const scheduled = await sendCampaign(draft.id, { scheduledAt: when }, draft.version);
  assert.equal(scheduled.status, 200, "the refused schedule moved nothing, so the same version still holds");
  const scheduledItem = (await scheduled.json()).item as CampaignItem;
  assert.deepEqual([scheduledItem.status, scheduledItem.scheduledAt], ["Scheduled", when]);
  assert.equal((await deliveriesOf(draft.id)).total, 0, "the audience freezes when the worker promotes the campaign, not when it is scheduled");

  const back = await cancelCampaign(draft.id, { mode: "unschedule" }, scheduledItem.version);
  assert.equal(back.status, 200);
  const backItem = (await back.json()).item as CampaignItem;
  assert.deepEqual([backItem.status, backItem.scheduledAt], ["Draft", undefined]);
  assert.equal((await patchCampaign(draft.id, { ...plainDraft, title: "Edited again" }, backItem.version)).status, 200, "a Draft is editable again");

  const rescheduled = await sendCampaign(draft.id, { scheduledAt: when }, (await getCampaign(draft.id)).version);
  const rescheduledItem = (await rescheduled.json()).item as CampaignItem;
  const cancelled = await cancelCampaign(draft.id, {}, rescheduledItem.version);
  assert.equal((await cancelled.json()).item.status, "Cancelled", "the default mode is cancel");
});

test("routes: bodies that do not fit their contract are 400 and change nothing", async () => {
  await enableSending();
  const draft = await createDraft();
  const key = () => ({ "idempotency-key": freshKey() });
  const noParagraphs = { ...plainDraft, content: { ...plainDraft.content, body: { en: { title: "Hi", paragraphs: [] } } } };
  const refused = [
    await communicationsPost(send("POST", CAMPAIGNS, { ...plainDraft, templateKey: "newsletter" }, key())),
    await communicationsPost(send("POST", CAMPAIGNS, noParagraphs, key())),
    await communicationsPost(send("POST", CAMPAIGNS, { ...plainDraft, title: "" }, key())),
    await communicationsPost(req(CAMPAIGNS, { method: "POST", headers: key(), body: "{not json" })),
    await communicationsPost(send("POST", CAMPAIGNS, [plainDraft], key())),
    await patchCampaign(draft.id, { ...plainDraft, title: "" }, draft.version),
    await patchCampaign(draft.id, noParagraphs, draft.version),
    await patchCampaign(draft.id, { ...plainDraft, title: "" }), // the body is read before the version is checked, so no If-Match does not turn this into a 428
    await communicationPatch(req(`${CAMPAIGNS}/${draft.id}`, { method: "PATCH", headers: ifMatch(draft.version), body: "{not json" }), forCampaign(draft.id)),
    await sendCampaign(draft.id, { scheduledAt: "" }, draft.version),
    await sendCampaign(draft.id, { scheduledAt: "tomorrow" }, draft.version),
    await sendCampaign(draft.id, { sendNow: true }, draft.version),
    await cancelCampaign(draft.id, { mode: "delete" }, draft.version),
    await cancelCampaign(draft.id, { mode: "cancel", extra: 1 }, draft.version),
    await testSendCampaign(draft.id, { extraRecipients: ["not-an-email"] }),
    await testSendCampaign(draft.id, { extraRecipients: "staff@datacentral.ai" }),
    await testSendCampaign(draft.id, { extraRecipients: ["a@x.is", "b@x.is", "c@x.is", "d@x.is", "e@x.is", "f@x.is"] }),
    await testSendCampaign(draft.id, { someoneElse: true }),
  ];
  const outcomes = await Promise.all(refused.map(refusal));
  assert.deepEqual(outcomes.map(([status]) => status), refused.map(() => 400));
  assert.deepEqual(outcomes.map(([, code]) => code), [
    "INVALID_INPUT", "INVALID_INPUT", "INVALID_INPUT", "INVALID_JSON", "INVALID_JSON_OBJECT",
    "INVALID_INPUT", "INVALID_INPUT", "INVALID_INPUT", "INVALID_JSON",
    "INVALID_INPUT", "INVALID_INPUT", "INVALID_INPUT", "INVALID_INPUT", "INVALID_INPUT",
    "INVALID_INPUT", "INVALID_INPUT", "INVALID_INPUT", "INVALID_INPUT",
  ]);
  const unchanged = await getCampaign(draft.id);
  assert.deepEqual([unchanged.title, unchanged.status, unchanged.version], ["Route test", "Draft", draft.version]);
  assert.deepEqual([(await (await communicationsGet(send("GET", CAMPAIGNS))).json()).items.length, (await deliveriesOf(draft.id)).total], [1, 0]);
});

test("routes: a campaign is duplicated as a new draft, once per key and per campaign, and only a Draft or Cancelled one is deleted", async () => {
  await enableSending();
  const original = await createDraft();
  const noKey = await duplicatePost(send("POST", `${CAMPAIGNS}/${original.id}/duplicate`), forCampaign(original.id));
  assert.deepEqual(await refusal(noKey), [400, "INVALID_IDEMPOTENCY_KEY"]);
  const key = freshKey();
  const copied = await duplicateCampaign(original.id, key);
  assert.equal(copied.status, 201);
  const copy = (await copied.json()).item as CampaignItem;
  assert.notEqual(copy.id, original.id);
  assert.deepEqual([copy.title, copy.status, copy.recipientCount], ["Route test (copy)", "Draft", 0]);
  const replay = await duplicateCampaign(original.id, key);
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).item.id, copy.id, "the replay is the stored copy");
  const items = (await (await communicationsGet(send("GET", CAMPAIGNS))).json()).items as CampaignItem[];
  assert.deepEqual(items.map((c) => c.id), [copy.id, original.id], "one copy only, newest first");
  const otherCopy = await duplicateCampaign(copy.id, key);
  assert.equal(otherCopy.status, 201, "the key is bound to the campaign it copies, so it is no replay for another");
  assert.notEqual((await otherCopy.json()).item.id, copy.id);
  assert.deepEqual(await refusal(await duplicateCampaign("COM-999")), [404, "NOT_FOUND"]);

  // Delete: a Draft goes, a Sending campaign stays, a Cancelled one goes.
  const removed = await communicationDelete(send("DELETE", `${CAMPAIGNS}/${copy.id}`), forCampaign(copy.id));
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ok: true });
  assert.deepEqual(await refusal(await communicationGet(send("GET", `${CAMPAIGNS}/${copy.id}`), forCampaign(copy.id))), [404, "NOT_FOUND"]);
  assert.deepEqual(await refusal(await communicationDelete(send("DELETE", `${CAMPAIGNS}/${copy.id}`), forCampaign(copy.id))), [404, "NOT_FOUND"], "a second delete finds nothing");
  const sent = (await (await sendCampaign(original.id, {}, original.version)).json()).item as CampaignItem;
  assert.deepEqual(await refusal(await communicationDelete(send("DELETE", `${CAMPAIGNS}/${original.id}`), forCampaign(original.id))), [400, "INVALID_COMMUNICATION_NOT_DELETABLE"]);
  assert.equal((await cancelCampaign(original.id, {}, sent.version)).status, 200);
  assert.equal((await communicationDelete(send("DELETE", `${CAMPAIGNS}/${original.id}`), forCampaign(original.id))).status, 200);
  assert.deepEqual((await (await communicationsGet(send("GET", CAMPAIGNS))).json()).items.map((c: CampaignItem) => c.title), ["Route test (copy) (copy)"]);
});

test("routes: retrying the dead letters requeues them, under a key, and a replay does not requeue again", async () => {
  await enableSending();
  await createContact({ email: "cio@origo.is", displayName: "CIO", locale: "en", topics: ["general"] });
  const draft = await createDraft();
  assert.equal((await sendCampaign(draft.id, {}, draft.version)).status, 200);
  const deadLetters = `?state=${encodeURIComponent("Dead letter")}`;
  const store = getDeliveryStore();
  const batch = await store.claimBatch(10);
  await store.markFailed(batch!.deliveries.map((d) => d.id), "HTTP_400", null);
  assert.equal((await deliveriesOf(draft.id, deadLetters)).total, 2);

  const noKey = await retryPost(send("POST", `${CAMPAIGNS}/${draft.id}/deliveries/retry`), forCampaign(draft.id));
  assert.deepEqual(await refusal(noKey), [400, "INVALID_IDEMPOTENCY_KEY"]);
  const key = freshKey();
  const retried = await retryCampaign(draft.id, key);
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), { requeued: 2, reopened: false }, "the campaign is still Sending, so nothing was reopened");
  assert.deepEqual([(await deliveriesOf(draft.id, "?state=Queued")).total, (await deliveriesOf(draft.id, deadLetters)).total], [2, 0]);
  const replay = await retryCampaign(draft.id, key);
  assert.deepEqual(await replay.json(), { requeued: 2, reopened: false }, "the stored answer");
  assert.equal(auditCount("communication.deliveries.retried"), 1);
  assert.deepEqual(await (await retryCampaign(draft.id)).json(), { requeued: 0, reopened: false }, "a call under a new key does the work again, and there is nothing left to requeue");
  assert.deepEqual(await refusal(await retryCampaign("COM-999")), [404, "NOT_FOUND"]);
});

test("routes: retrying the dead letters of a campaign that has completed reopens it, and the answer says so", async () => {
  await enableSending();
  const draft = await createDraft();
  assert.equal((await sendCampaign(draft.id, {}, draft.version)).status, 200);
  const store = getDeliveryStore();
  const batch = await store.claimBatch(10);
  await store.markFailed(batch!.deliveries.map((d) => d.id), "HTTP_400", null); // the one recipient is a dead letter
  assert.deepEqual(await store.completeCampaigns(new Date()), [draft.id]);
  const done = await getCampaign(draft.id);
  assert.deepEqual([done.status, typeof done.completedAt, done.stats.deadLettered, done.stats.queued], ["Sent", "string", 1, 0]);

  const retried = await retryCampaign(draft.id);
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), { requeued: 1, reopened: true });
  const reopened = await getCampaign(draft.id);
  assert.deepEqual([reopened.status, reopened.completedAt, reopened.stats.queued, reopened.stats.deadLettered], ["Sending", undefined, 1, 0], "Sending again, so the worker claims the row; the completion is undone");

  const nothing = await retryCampaign(draft.id);
  assert.deepEqual(await nothing.json(), { requeued: 0, reopened: false }, "a retry that finds nothing to requeue reopens nothing");
});

test("routes: the preview serves the mail in the language and format asked for under a strict CSP; an unknown, malformed or deleted id is 404", async () => {
  const draft = await createDraft();
  const preview = (query: string, id = draft.id, headers: Record<string, string> = {}) => previewGet(send("GET", `${CAMPAIGNS}/${id}/preview${query}`, undefined, headers), forCampaign(id));
  const correlation = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const english = await preview("", draft.id, { "x-correlation-id": correlation });
  assert.equal(english.status, 200);
  assert.equal(english.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(english.headers.get("content-security-policy"), "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'");
  assert.equal(english.headers.get("cache-control"), "no-store");
  assert.equal(english.headers.get("x-correlation-id"), correlation);
  const html = await english.text();
  assert.match(html, /<html/i);
  assert.match(html, /Announcement/);
  assert.doesNotMatch(html, /Tilkynning/);
  assert.match(await (await preview("?locale=is")).text(), /Tilkynning/);
  assert.match(await (await preview("?locale=fr")).text(), /Announcement/, "an unknown language is English");
  assert.match(await (await preview("?format=bogus")).text(), /<html/i, "an unknown format is HTML");

  const text = await preview("?format=text");
  assert.equal(text.status, 200);
  assert.equal(text.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(text.headers.get("content-security-policy"), "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'");
  const plain = await text.text();
  assert.match(plain, /^hi$/im, "the title, as the text part sets it");
  assert.match(plain, /^One$/m);
  assert.doesNotMatch(plain, /<html/i);

  for (const id of ["COM-999", "COM-1; DROP TABLE dbo.Communications", "REL-1"]) {
    const missing = await preview("", id);
    assert.deepEqual(await refusal(missing), [404, "NOT_FOUND"], id);
    assert.match(missing.headers.get("content-type") ?? "", /^application\/json/, "an error is JSON, never a preview");
  }
  assert.equal((await communicationDelete(send("DELETE", `${CAMPAIGNS}/${draft.id}`), forCampaign(draft.id))).status, 200);
  assert.equal((await preview("")).status, 404);
});

test("routes: a signed-in user who is not internal staff is refused by every campaign route, and nothing changes", async () => {
  await enableSending();
  const draft = await createDraft();
  const token = await createSessionToken({ sub: "22222222-2222-4222-8222-222222222222", email: "jon@origo.is", name: "Jón Jónsson", ext: "dev:test", amr: "dev" });
  const as = { authorization: `Bearer ${token}` };
  const id = draft.id;
  const at = (suffix = "") => `${CAMPAIGNS}/${id}${suffix}`;
  const refused = [
    await communicationsGet(send("GET", CAMPAIGNS, undefined, as)),
    await communicationsPost(send("POST", CAMPAIGNS, plainDraft, { ...as, "idempotency-key": freshKey() })),
    await communicationGet(send("GET", at(), undefined, as), forCampaign(id)),
    await communicationPatch(send("PATCH", at(), plainDraft, { ...as, ...ifMatch(draft.version) }), forCampaign(id)),
    await communicationDelete(send("DELETE", at(), undefined, as), forCampaign(id)),
    await duplicatePost(send("POST", at("/duplicate"), undefined, { ...as, "idempotency-key": freshKey() }), forCampaign(id)),
    await previewGet(send("GET", at("/preview"), undefined, as), forCampaign(id)),
    await audienceGet(send("GET", at("/audience"), undefined, as), forCampaign(id)),
    await testPost(send("POST", at("/test"), {}, { ...as, "idempotency-key": freshKey() }), forCampaign(id)),
    await sendPost(send("POST", at("/send"), {}, { ...as, ...ifMatch(draft.version), "idempotency-key": freshKey() }), forCampaign(id)),
    await cancelPost(send("POST", at("/cancel"), {}, { ...as, ...ifMatch(draft.version) }), forCampaign(id)),
    await deliveriesGet(send("GET", at("/deliveries"), undefined, as), forCampaign(id)),
    await retryPost(send("POST", at("/deliveries/retry"), undefined, { ...as, "idempotency-key": freshKey() }), forCampaign(id)),
  ];
  assert.deepEqual(refused.map((response) => response.status), refused.map(() => 404));
  for (const response of refused) assert.equal((await response.json()).error.code, "FORBIDDEN");
  const unchanged = await getCampaign(id);
  assert.deepEqual([unchanged.title, unchanged.status, unchanged.version], ["Route test", "Draft", draft.version]);
  assert.deepEqual([(await (await communicationsGet(send("GET", CAMPAIGNS))).json()).items.length, (await deliveriesOf(id)).total], [1, 0], "no campaign was added or sent");
});

/**
 * The headers next.config.ts gives a path, as Next works them out (next/dist/server/lib/router-utils/resolve-routes): every `headers()` entry whose
 * source matches, in the order they are listed, and an entry that sets a header an earlier one set replaces it.
 */
async function configHeadersFor(pathname: string) {
  const sent: Record<string, string> = {};
  for (const rule of await nextConfig.headers!()) {
    const params = getPathMatch(rule.source)(pathname);
    if (!params) continue;
    for (const { key, value } of rule.headers) sent[compileNonPath(key, params).toLowerCase()] = compileNonPath(value, params);
  }
  return sent;
}

test("config: the mail preview is served under its own strict CSP — its next.config.ts entry follows the app-wide one, because the last entry wins and a handler's header is dropped once the name is set", async () => {
  const strict = "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'";
  const rules = await nextConfig.headers!();
  const appWide = rules.findIndex((rule) => rule.source === "/(.*)");
  const preview = rules.findIndex((rule) => rule.source === "/api/v1/internal/communications/:id/preview");
  assert.ok(appWide >= 0, "the app-wide entry is still there");
  assert.ok(preview > appWide, "and the preview's entry comes after it");
  assert.equal(rules[preview].headers.find((header) => header.key === "Content-Security-Policy")?.value, strict);

  const previewPath = "/api/v1/internal/communications/COM-001/preview";
  const sent = await configHeadersFor(previewPath);
  assert.equal(sent["content-security-policy"], strict, "what Next sends for the preview is the strict policy");
  assert.equal(sent["x-content-type-options"], "nosniff", "the other app-wide headers still apply to it");
  for (const other of ["/", "/api/v1/internal/communications", "/api/v1/internal/communications/COM-001", "/api/v1/internal/communications/COM-001/audience"]) {
    assert.match((await configHeadersFor(other))["content-security-policy"], /^default-src 'self'; /, `${other} keeps the app-wide policy`);
  }

  // The handler sets the same policy, so it holds wherever the config is not what serves the response.
  const draft = await createDraft();
  const response = await previewGet(send("GET", `${CAMPAIGNS}/${draft.id}/preview`), forCampaign(draft.id));
  assert.equal(response.headers.get("content-security-policy"), strict);
});

test("openapi: the campaign operations are curated — ids, success codes, preconditions, request bodies and the preview's media types", () => {
  const spec = JSON.parse(readFileSync(new URL("../public/openapi.json", import.meta.url), "utf8"));
  const root = "/api/v1/internal/communications";
  const operations: Array<[string, string, string, string]> = [
    [root, "get", "listCommunications", "200"],
    [root, "post", "createCommunication", "201"],
    [`${root}/{id}`, "get", "getCommunication", "200"],
    [`${root}/{id}`, "patch", "updateCommunication", "200"],
    [`${root}/{id}`, "delete", "deleteCommunication", "200"],
    [`${root}/{id}/duplicate`, "post", "duplicateCommunication", "201"],
    [`${root}/{id}/preview`, "get", "previewCommunication", "200"],
    [`${root}/{id}/audience`, "get", "communicationAudienceEstimate", "200"],
    [`${root}/{id}/test`, "post", "testSendCommunication", "200"],
    [`${root}/{id}/send`, "post", "sendCommunication", "200"],
    [`${root}/{id}/cancel`, "post", "cancelCommunication", "200"],
    [`${root}/{id}/deliveries`, "get", "listCommunicationDeliveries", "200"],
    [`${root}/{id}/deliveries/retry`, "post", "retryCommunicationDeliveries", "200"],
  ];
  for (const [path, method, operationId, success] of operations) {
    const operation = spec.paths[path]?.[method];
    assert.equal(operation?.operationId, operationId, `${method} ${path}`);
    const successes = Object.keys(operation.responses).filter((code) => code.startsWith("2"));
    assert.deepEqual(successes, [success], `${operationId} answers ${success}`);
  }
  const preview = spec.paths[`${root}/{id}/preview`].get.responses["200"];
  assert.deepEqual(preview.content["text/html"], { schema: { type: "string" } });
  const refs = (path: string, method: string): string[] => spec.paths[path][method].parameters.map((p: { $ref?: string; name?: string }) => p.$ref?.split("/").pop() ?? p.name);
  const body = (path: string, method: string) => spec.paths[path][method].requestBody?.content["application/json"].schema.$ref?.split("/").pop();
  // Idempotency-Key where the route is idempotent, If-Match where it is versioned; cancel is versioned only, an edit is not idempotent.
  for (const [path, method, key, match] of [
    [root, "post", true, false], [`${root}/{id}`, "patch", false, true], [`${root}/{id}/duplicate`, "post", true, false], [`${root}/{id}/test`, "post", true, false],
    [`${root}/{id}/send`, "post", true, true], [`${root}/{id}/cancel`, "post", false, true], [`${root}/{id}/deliveries/retry`, "post", true, false],
  ] as Array<[string, string, boolean, boolean]>) {
    assert.equal(refs(path, method).includes("IdempotencyKey"), key, `${method} ${path} Idempotency-Key`);
    assert.equal(refs(path, method).includes("IfMatch"), match, `${method} ${path} If-Match`);
  }
  assert.deepEqual(
    [body(root, "post"), body(`${root}/{id}`, "patch"), body(`${root}/{id}/send`, "post"), body(`${root}/{id}/test`, "post"), body(`${root}/{id}/cancel`, "post")],
    ["communicationInputSchema", "communicationInputSchema", "communicationSendInputSchema", "communicationTestSendSchema", "communicationCancelInputSchema"],
  );
  assert.equal(spec.paths[`${root}/{id}/duplicate`].post.requestBody, undefined, "a duplicate takes no body");
  assert.equal(spec.paths[`${root}/{id}/deliveries/retry`].post.requestBody, undefined, "and neither does a retry");
});

// ---------------------------------------------------------------------------------------------------------------------
// The worker's job route and the Settings card's retry
// ---------------------------------------------------------------------------------------------------------------------

const JOB = "/api/v1/internal/jobs/communications";
const JOB_SECRET = "job-secret-0123456789abcdef0123456789abcdef";
const job = (body?: unknown, headers: Record<string, string> = { "x-pulse-job-secret": JOB_SECRET }) => communicationsJobPost(send("POST", JOB, body, headers));
/** Runs `work` with the shared job secret configured, as it is in production, and takes it away again. */
async function withJobSecret<T>(work: () => Promise<T>): Promise<T> {
  process.env.NOTIFICATION_JOB_SECRET = JOB_SECRET;
  try {
    return await work();
  } finally {
    delete process.env.NOTIFICATION_JOB_SECRET;
  }
}

test("job route: it is closed without the shared secret, whoever asks", async () => {
  await withJobSecret(async () => {
    assert.deepEqual(await refusal(await job(undefined, {})), [401, "UNAUTHORIZED"], "no header: not even the demo System admin can open it");
    assert.deepEqual(await refusal(await job(undefined, { "x-pulse-job-secret": "wrong" })), [401, "UNAUTHORIZED"]);
    assert.deepEqual(await refusal(await job(undefined, { "x-pulse-job-secret": `${JOB_SECRET}x` })), [401, "UNAUTHORIZED"], "a longer value");
    assert.deepEqual(await refusal(await job(undefined, { "x-pulse-job-secret": JOB_SECRET.slice(0, -1) })), [401, "UNAUTHORIZED"], "a shorter one");
  });
  assert.deepEqual(await refusal(await job()), [401, "UNAUTHORIZED"], "a header cannot match a secret that is not configured");
});

test("job route: it runs the worker behind the secret — skipped while sending is off, then bounded by the limit — and the console transport mails nobody", async () => {
  await withJobSecret(async () => {
    const idle = await job();
    assert.equal(idle.status, 200);
    assert.equal(idle.headers.get("cache-control"), "no-store");
    assert.deepEqual(await idle.json(), { skipped: true, promoted: [], accepted: 0, retried: 0, deadLettered: 0, completed: [], capReached: false, recovered: 0, splits: 0 }, "sending is off until the settings say so");

    await enableSending();
    organizations().push({ id: "ORG-002", name: "Advania", type: "Customer", status: "Active", domain: "advania.is", users: 0, requests: 0, authentication: ["OTP"] });
    await createContact({ email: "cio@origo.is", displayName: "CIO", locale: "is", topics: ["general"] });
    await createContact({ organizationId: "ORG-002", email: "anna@advania.is", displayName: "Anna", locale: "en", topics: ["general"] });
    const draft = await createDraft();
    assert.equal((await sendCampaign(draft.id, {}, draft.version)).status, 200); // three recipients: two English, one Icelandic
    delete process.env.SENDGRID_API_KEY; // no key: the worker's transport is the console one, which sends nothing and logs a count — the SDK is never reached
    const logged: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    try {
      const first = await (await job({ limit: 1 })).json();
      assert.deepEqual([first.skipped, first.accepted, first.completed], [false, 1, []], "the limit bounds the run");
      const rest = await (await job({})).json();
      assert.deepEqual([rest.accepted, rest.completed], [2, [draft.id]], "the default limit takes what is left, and the campaign completes");
      const nothing = await (await job()).json();
      assert.deepEqual([nothing.skipped, nothing.accepted, nothing.completed], [false, 0, []]);
    } finally {
      console.log = original;
    }
    assert.equal((await getCampaign(draft.id)).status, "Sent");
    assert.deepEqual((await deliveriesOf(draft.id)).items.map((r) => r.state), ["Accepted", "Accepted", "Accepted"]);
    assert.deepEqual(logged.map((line) => JSON.parse(line).recipients), [1, 1, 1], "a count per request and nothing else");
    assert.ok(logged.every((line) => !line.includes("@")), "no address");
  });
});

test("job route: the limit is a whole number from 1 to 5000, and the body must be JSON", async () => {
  await withJobSecret(async () => {
    for (const limit of [0, -1, 1.5, 5001, "10", null]) assert.deepEqual(await refusal(await job({ limit })), [400, "INVALID_INPUT"], `limit ${JSON.stringify(limit)}`);
    assert.deepEqual(await refusal(await communicationsJobPost(req(JOB, { method: "POST", headers: { "x-pulse-job-secret": JOB_SECRET }, body: "{not json" }))), [400, "INVALID_JSON"]);
    assert.equal((await job({ limit: 1 })).status, 200);
    assert.equal((await job({ limit: 5000 })).status, 200);
  });
});

test("job route: without a limit a run takes up to 500 rows — the 13 recipients of this campaign go out in one run and one request", async () => {
  await withJobSecret(async () => {
    await enableSending();
    for (let i = 0; i < 12; i++) await createContact({ email: `person${i}@origo.is`, displayName: `Person ${i}`, locale: "en", topics: ["general"] });
    const draft = await createDraft();
    assert.equal((await sendCampaign(draft.id, {}, draft.version)).status, 200); // the 12 contacts and the demo admin, all English
    delete process.env.SENDGRID_API_KEY; // the console transport again: the SDK is never reached
    const logged: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    try {
      const run = await (await job()).json();
      assert.deepEqual([run.accepted, run.completed], [13, [draft.id]]);
    } finally {
      console.log = original;
    }
    assert.deepEqual(logged.map((line) => JSON.parse(line).recipients), [13], "one request");
  });
});

test("routes: the Settings card's retry takes the Communications channel next to Email and Webhook, and nothing else", async () => {
  const retry = (body: unknown) => deliveryStatusPost(send("POST", "/api/v1/admin/delivery", body));
  const ok = await retry({ channel: "Communications" });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { requeued: 0 }, "memory mode has no outbox in SQL: nothing to requeue");
  for (const channel of ["Email", "Webhook"]) assert.equal((await retry({ channel })).status, 200, channel);
  for (const body of [{ channel: "communications" }, { channel: "Fax" }, {}, { channel: "Communications", extra: true }]) assert.deepEqual(await refusal(await retry(body)), [400, "INVALID_INPUT"], JSON.stringify(body));
  const list = await deliveryStatusGet(send("GET", "/api/v1/admin/delivery"));
  assert.deepEqual([list.status, await list.json()], [200, { items: [] }]);
});

test("openapi: the worker's job route is documented behind the job secret", () => {
  const spec = JSON.parse(readFileSync(new URL("../public/openapi.json", import.meta.url), "utf8"));
  const operation = spec.paths[JOB]?.post;
  assert.equal(operation?.operationId, "processCommunicationOutbox");
  assert.deepEqual(operation.security, [{ notificationJobSecret: [] }]);
  assert.equal(operation["x-authorization"], "Job secret");
  assert.equal(operation["x-source-file"], "app/api/v1/internal/jobs/communications/route.ts");
  assert.ok(spec.components.securitySchemes.notificationJobSecret, "the scheme it names exists");
  assert.deepEqual(Object.keys(operation.responses).sort(), ["200", "400", "401", "404", "413", "429", "500"]);
  assert.ok(operation.requestBody, "it takes an optional JSON body with a limit");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The SendGrid Event Webhook: no session and no secret, only the signature SendGrid puts on the body
// ---------------------------------------------------------------------------------------------------------------------------------

const EVENTS = "/api/v1/internal/communications/events";
/** A POST to the webhook signed with a new key pair; `publicKeyEnv` says whether that key (or no key at all) is the one that is configured. */
function signedRequest(body: string, publicKeyEnv: boolean, offsetSeconds = 0) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const timestamp = String(Math.floor(Date.now() / 1000) + offsetSeconds);
  const signature = sign("sha256", Buffer.from(timestamp + body, "utf8"), privateKey).toString("base64");
  if (publicKeyEnv) process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  else delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
  return new Request(`http://localhost${EVENTS}`, {
    method: "POST", body,
    headers: { "content-type": "application/json", "x-twilio-email-event-webhook-signature": signature, "x-twilio-email-event-webhook-timestamp": timestamp },
  });
}
const EVENT_BODY = JSON.stringify([{ sg_event_id: "r1", event: "delivered", email: "a@origo.is", timestamp: 1 }]);

test("webhook route: 503 without a key, 401 on bad signature or stale timestamp, 200 when valid", async () => {
  assert.equal((await eventsPost(signedRequest(EVENT_BODY, false))).status, 503);
  assert.equal((await eventsPost(signedRequest(EVENT_BODY, true, -700))).status, 401);
  const tampered = signedRequest(EVENT_BODY, true);
  const wrong = new Request(tampered.url, { method: "POST", body: EVENT_BODY + " ", headers: tampered.headers });
  assert.equal((await eventsPost(wrong)).status, 401);
  const ok = await eventsPost(signedRequest(EVENT_BODY, true));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { applied: 0, ignored: 1 });
});

test("webhook route: without a key it answers 503 and asks SendGrid to come back, a blank key is no key, and a key that is not one refuses everything", async () => {
  const missing = await eventsPost(signedRequest(EVENT_BODY, false));
  assert.deepEqual([missing.status, missing.headers.get("retry-after"), missing.headers.get("cache-control")], [503, "300", "no-store"]);
  assert.equal((await missing.json()).error.code, "WEBHOOK_NOT_CONFIGURED");
  const blank = signedRequest(EVENT_BODY, false);
  process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY = "   ";
  assert.equal((await eventsPost(blank)).status, 503);
  const unusable = signedRequest(EVENT_BODY, true);
  process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY = "not a key";
  assert.deepEqual(await refusal(await eventsPost(unusable)), [401, "UNAUTHORIZED"]);
});

test("webhook route: the signature and the timestamp must both come with the request, and the demo System admin gets no way in without them", async () => {
  const good = signedRequest(EVENT_BODY, true);
  const post = (headers: Headers) => eventsPost(new Request(good.url, { method: "POST", body: EVENT_BODY, headers }));
  for (const name of ["x-twilio-email-event-webhook-signature", "x-twilio-email-event-webhook-timestamp"]) {
    const headers = new Headers(good.headers);
    headers.delete(name);
    assert.deepEqual(await refusal(await post(headers)), [401, "UNAUTHORIZED"], `without ${name}`);
  }
  const garbled = new Headers(good.headers);
  garbled.set("x-twilio-email-event-webhook-signature", "AAAA");
  assert.deepEqual(await refusal(await post(garbled)), [401, "UNAUTHORIZED"]);
  assert.deepEqual(await refusal(await post(new Headers({ "content-type": "application/json" }))), [401, "UNAUTHORIZED"], "only the signature opens this route");
});

test("webhook route: a signed body that is not a JSON array of events is 400 and applies nothing; an empty batch is fine", async () => {
  for (const [raw, code] of [["{not json", "INVALID_JSON"], ["", "INVALID_JSON"], ["{}", "INVALID_EVENTS"], ['"text"', "INVALID_EVENTS"]] as const)
    assert.deepEqual(await refusal(await eventsPost(signedRequest(raw, true))), [400, code], JSON.stringify(raw));
  const empty = await eventsPost(signedRequest("[]", true));
  assert.deepEqual([empty.status, await empty.json()], [200, { applied: 0, ignored: 0 }]);
});

test("webhook route: a body over 1 MiB is 413 — on its declared length and on what it carries — while 1 MiB itself is read", async () => {
  const limit = 1024 * 1024;
  const declared = signedRequest("[]", true);
  const headers = new Headers(declared.headers);
  headers.set("content-length", String(limit + 1));
  assert.deepEqual(await refusal(await eventsPost(new Request(declared.url, { method: "POST", body: "[]", headers }))), [413, "PAYLOAD_TOO_LARGE"], "declared");
  assert.deepEqual(await refusal(await eventsPost(signedRequest(`[${" ".repeat(limit - 1)}]`, true))), [413, "PAYLOAD_TOO_LARGE"], "carried, with no length declared");
  const exactly = await eventsPost(signedRequest(`[${" ".repeat(limit - 2)}]`, true));
  assert.deepEqual([exactly.status, await exactly.json()], [200, { applied: 0, ignored: 0 }]);
});

test("webhook route: a signed bounce reaches the delivery and the suppression list, a repeated batch changes nothing, and nothing is logged", async () => {
  await enableSending();
  await createContact({ email: "cio@origo.is", displayName: "CIO", locale: "is", topics: ["general"] });
  const draft = await createDraft();
  assert.equal((await sendCampaign(draft.id, {}, draft.version)).status, 200);
  // The worker has sent the mail: events only touch rows the provider accepted.
  const store = getDeliveryStore();
  for (let claimed = await store.claimBatch(500); claimed; claimed = await store.claimBatch(500)) await store.markAccepted(claimed.deliveries.map((d) => d.id), "msg-route", new Date());
  const idOf = (email: string) => memoryDeliveries().find((d) => d.email === email)!.id;
  const batch = JSON.stringify([
    { sg_event_id: "w1", event: "bounce", type: "bounce", reason: "550 5.1.1 cio@origo.is unknown", email: "CIO@origo.is", timestamp: 1_700_000_000, deliveryId: idOf("cio@origo.is"), communicationId: draft.id },
    { sg_event_id: "w2", event: "open", email: "bjarki@uidata.com", timestamp: 1_700_000_001, deliveryId: idOf("bjarki@uidata.com"), communicationId: draft.id },
  ]);
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  let first: Response;
  try {
    first = await eventsPost(signedRequest(batch, true));
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual([first.status, await first.json()], [200, { applied: 2, ignored: 0 }]);
  assert.deepEqual(lines, [], "the webhook logs nothing per event");
  assert.equal((await deliveriesOf(draft.id)).items.find((d) => d.email === "cio@origo.is")?.state, "Bounced");
  const listed: Array<{ email: string; reason: string; source: string; note?: string }> = (await (await suppressionsGet(send("GET", SUPPRESSIONS))).json()).items;
  assert.deepEqual(listed.map((s) => [s.email, s.reason, s.source, s.note]), [["cio@origo.is", "Bounced", "Webhook", "550 5.1.1 cio@origo.is unknown"]]);
  const again = await eventsPost(signedRequest(batch, true));
  assert.deepEqual(await again.json(), { applied: 0, ignored: 2 });
});

test("proxy: the SendGrid events route skips the JSON pre-parse so large batches reach the handler", async () => {
  const body = JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ sg_event_id: `p${i}`, event: "delivered", email: "a@origo.is", timestamp: 1 })));
  const res = await proxy(new NextRequest("http://localhost:3000/api/v1/internal/communications/events", {
    method: "POST", headers: { host: "localhost:3000", "content-type": "application/json" }, body,
  }));
  assert.notEqual(res.status, 400, "a 300-item array must not be rejected by the generic JSON gate");
  assert.equal(res.status, 200);
  const generic = await proxy(new NextRequest("http://localhost:3000/api/v1/requests", {
    method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" }, body,
  }));
  assert.equal(generic.status, 400, "other routes keep the 250-item limit");
  const otherMethod = await proxy(new NextRequest("http://localhost:3000/api/v1/internal/communications/events", {
    method: "PUT", headers: { host: "localhost:3000", "content-type": "application/json" }, body,
  }));
  assert.equal(otherMethod.status, 400, "the exemption is for the webhook's POST alone");
});

test("proxy: the SendGrid events route has a rate-limit group of its own, 600 a minute, apart from the 180 of the API", async () => {
  globalThis.pulseSharedLocalLimits = undefined; // every request below comes from the same address: start from an empty window
  try {
    const post = (path: string) => proxy(new NextRequest(`http://localhost:3000${path}`, { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json" }, body: "[]" }));
    const statuses: number[] = [];
    for (let i = 0; i < 601; i++) statuses.push((await post(EVENTS)).status);
    assert.deepEqual([statuses.slice(0, 600).every((status) => status === 200), statuses[600]], [true, 429], "600 pass and the 601st does not");
    assert.equal((await post("/api/v1/requests")).status, 200, "and the API's own group is untouched");
  } finally {
    globalThis.pulseSharedLocalLimits = undefined;
  }
});

test("openapi: the SendGrid events route is documented behind its signature, with the array body it takes", () => {
  const spec = JSON.parse(readFileSync(new URL("../public/openapi.json", import.meta.url), "utf8"));
  const operation = spec.paths[EVENTS]?.post;
  assert.equal(operation?.operationId, "receiveSendGridEvents");
  assert.deepEqual(operation.security, [{ sendgridEventSignature: [] }]);
  assert.equal(operation["x-authorization"], "SendGrid Event Webhook signature");
  assert.equal(operation["x-source-file"], "app/api/v1/internal/communications/events/route.ts");
  assert.deepEqual(spec.components.securitySchemes.sendgridEventSignature, { type: "apiKey", in: "header", name: "X-Twilio-Email-Event-Webhook-Signature" });
  assert.deepEqual(operation.requestBody.content["application/json"].schema, { type: "array", maxItems: 1000, items: { type: "object" } });
  assert.deepEqual(Object.keys(operation.responses).sort(), ["200", "400", "401", "404", "413", "429", "500", "503"]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The settings routes and the configuration test: System admin only (demo System admin identity, bjarki@uidata.com)
// ---------------------------------------------------------------------------------------------------------------------------------

const SETTINGS = "/api/v1/admin/communications/settings";
const SETTINGS_TEST = `${SETTINGS}/test`;
/** A whole settings object, as the PATCH takes it: the defaults with `over` laid on top. */
const settingsBody = (over: Record<string, unknown> = {}) => ({ ...structuredClone(DEFAULT_COMMUNICATION_SETTINGS), ...over });

test("settings routes: a System admin reads the settings with the provider status beside them, and saves them whole", async () => {
  process.env.PULSE_PUBLIC_URL = "https://pulse.test//";
  try {
    const read = await settingsGet(send("GET", SETTINGS));
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("cache-control"), "no-store");
    assert.deepEqual(await read.json(), {
      item: DEFAULT_COMMUNICATION_SETTINGS,
      status: { providerConfigured: false, webhookConfigured: false, webhookUrl: "https://pulse.test/api/v1/internal/communications/events", effectiveSendingState: "disabled" },
    });

    process.env.SENDGRID_API_KEY = "SG.route-test-key-0123456789";
    process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY = "route-test-verification-key-0123456789";
    const saved = await settingsPatch(send("PATCH", SETTINGS, settingsBody({
      enabled: true, fromEmail: "Updates@DataCentral.ai", safeMode: { enabled: true, allowedDomains: ["DataCentral.AI", "datacentral.ai", "origo.is"] },
    })));
    assert.equal(saved.status, 200);
    const body = await saved.json();
    assert.deepEqual([body.item.enabled, body.item.fromEmail, body.item.safeMode.allowedDomains], [true, "updates@datacentral.ai", ["datacentral.ai", "origo.is"]], "normalised, and without repeats");
    assert.deepEqual(body.status, { providerConfigured: true, webhookConfigured: true, webhookUrl: "https://pulse.test/api/v1/internal/communications/events", effectiveSendingState: "safe-mode" });
    assert.ok(!JSON.stringify(body).includes("route-test"), "neither key is in an answer, only whether it is set");
    assert.deepEqual(await (await settingsGet(send("GET", SETTINGS))).json(), body, "a read gives back what was saved");
    assert.equal(auditCount("communication.settings.updated"), 1);
  } finally {
    delete process.env.PULSE_PUBLIC_URL;
  }
});

test("settings routes: a body that does not fit the contract is 400 and saves nothing; what the contract does not name is dropped", async () => {
  const valid = settingsBody({ enabled: true, fromEmail: "updates@datacentral.ai" });
  const invalid: Array<[string, unknown]> = [
    ["enabled without a from address", { ...valid, fromEmail: "" }],
    ["a from address that is none", { ...valid, fromEmail: "not-an-address" }],
    ["a field missing", Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "tracking"))],
    ["a daily cap of zero", { ...valid, dailyCap: 0 }],
    ["a campaign size past the limit", { ...valid, maxRecipientsPerCampaign: 100_001 }],
    ["a region that is none", { ...valid, dataResidency: "us" }],
    ["an unsubscribe group that is no id", { ...valid, unsubscribeGroupId: 0 }],
    ["a category prefix with a space", { ...valid, categoriesPrefix: "Has Space" }],
    ["a domain that is none", { ...valid, safeMode: { enabled: true, allowedDomains: ["not a domain"] } }],
    ["boilerplate for one language only", { ...valid, boilerplate: { en: valid.boilerplate.en } }],
  ];
  for (const [what, body] of invalid) assert.deepEqual(await refusal(await settingsPatch(send("PATCH", SETTINGS, body))), [400, "INVALID_INPUT"], what);
  assert.deepEqual(await refusal(await settingsPatch(req(SETTINGS, { method: "PATCH", body: "{not json" }))), [400, "INVALID_JSON"]);
  assert.deepEqual(await refusal(await settingsPatch(req(SETTINGS, { method: "PATCH" }))), [400, "INVALID_JSON"], "no body");
  assert.deepEqual(await refusal(await settingsPatch(send("PATCH", SETTINGS, [valid]))), [400, "INVALID_JSON_OBJECT"], "a list is no settings");
  assert.deepEqual((await (await settingsGet(send("GET", SETTINGS))).json()).item, DEFAULT_COMMUNICATION_SETTINGS, "nothing was saved");
  assert.equal(auditCount("communication.settings.updated"), 0);
  const extra = await (await settingsPatch(send("PATCH", SETTINGS, { ...valid, apiKey: "SG.leak", id: "x" }))).json();
  assert.deepEqual(Object.keys(extra.item).sort(), Object.keys(DEFAULT_COMMUNICATION_SETTINGS).sort(), "only the settings are stored and answered");
});

test("settings routes: a signed-in user who is not a System admin is refused by the settings and the test, and nothing is saved or sent", async () => {
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, fromEmail: "updates@datacentral.ai", safeMode: { enabled: false, allowedDomains: [] } });
  const token = await createSessionToken({ sub: "22222222-2222-4222-8222-222222222222", email: "jon@origo.is", name: "Jón Jónsson", ext: "dev:test", amr: "dev" });
  const as = { authorization: `Bearer ${token}` };
  const logged: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  let refused: Response[];
  try {
    refused = [
      await settingsGet(send("GET", SETTINGS, undefined, as)),
      await settingsPatch(send("PATCH", SETTINGS, settingsBody({ enabled: true, fromEmail: "attacker@evil.example" }), as)),
      await settingsTestPost(send("POST", SETTINGS_TEST, undefined, as)),
    ];
  } finally {
    console.log = original;
  }
  assert.deepEqual(refused.map((response) => response.status), [404, 404, 404]);
  for (const response of refused) assert.equal((await response.json()).error.code, "FORBIDDEN");
  assert.deepEqual(logged, [], "no mail, not even to the console");
  const { item } = await (await settingsGet(send("GET", SETTINGS))).json();
  assert.deepEqual([item.enabled, item.fromEmail], [false, "updates@datacentral.ai"], "the settings are the admin's, as they were");
  assert.equal(auditCount("communication.settings.updated"), 1, "only the admin's own save");
});

test("settings routes: the configuration test mails the signed-in admin and says which transport took it; no sender, or safe mode, is a 400 with the reason", async () => {
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const post = () => settingsTestPost(send("POST", SETTINGS_TEST, undefined, { "x-correlation-id": id }));
  const noSender = await post();
  assert.deepEqual(await refusal(noSender), [400, "INVALID_EMAIL_PROVIDER_CONFIGURATION"], "there is no from address yet");
  assert.equal(noSender.headers.get("x-correlation-id"), id);
  assert.equal((await settingsPatch(send("PATCH", SETTINGS, settingsBody({ fromEmail: "updates@datacentral.ai" })))).status, 200); // sending is still off: the test does not need it on
  assert.deepEqual(await refusal(await post()), [400, "INVALID_SAFE_MODE_BLOCKS_RECIPIENT"], "bjarki@uidata.com is not on the default list, datacentral.ai");
  assert.equal((await settingsPatch(send("PATCH", SETTINGS, settingsBody({ fromEmail: "updates@datacentral.ai", safeMode: { enabled: true, allowedDomains: ["uidata.com"] } })))).status, 200);
  const logged: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  let answer: Response;
  try {
    answer = await post();
  } finally {
    console.log = original;
  }
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("cache-control"), "no-store");
  assert.equal(answer.headers.get("x-correlation-id"), id);
  const result = await answer.json();
  assert.deepEqual([result.ok, result.transport], [true, "console"], "no API key: the console transport took it");
  assert.match(result.providerMessageId, /^console-[0-9a-f-]{36}$/);
  assert.deepEqual(logged.map((line) => JSON.parse(line)), [{ level: "info", event: "communications.console-send", recipients: 1, sandbox: false }], "a count and no address");
});

test("openapi: the settings operations are documented behind the System admin role, with the settings contract as the PATCH body and no body for the test", () => {
  const spec = JSON.parse(readFileSync(new URL("../public/openapi.json", import.meta.url), "utf8"));
  const settings = spec.paths[SETTINGS];
  const configurationTest = spec.paths[SETTINGS_TEST];
  assert.deepEqual([settings?.get?.operationId, settings?.patch?.operationId, configurationTest?.post?.operationId], ["getCommunicationSettings", "saveCommunicationSettings", "sendCommunicationConfigurationTest"]);
  assert.deepEqual([Object.keys(settings).sort(), Object.keys(configurationTest)], [["get", "patch"], ["post"]], "no other method");
  for (const operation of [settings.get, settings.patch, configurationTest.post]) {
    assert.equal(operation["x-authorization"], "System admin");
    assert.deepEqual(operation.security, [{ sessionCookie: [] }, { sessionBearer: [] }]);
    assert.deepEqual(Object.keys(operation.responses).sort(), ["200", "400", "401", "404", "413", "429", "500"]);
    assert.ok(operation.summary && operation.description, "curated: it says what it does");
  }
  assert.equal(settings.get["x-source-file"], "app/api/v1/admin/communications/settings/route.ts");
  assert.equal(configurationTest.post["x-source-file"], "app/api/v1/admin/communications/settings/test/route.ts");
  assert.equal(settings.get.requestBody, undefined);
  assert.equal(configurationTest.post.requestBody, undefined, "the test takes no body: it mails the caller");
  assert.deepEqual(settings.patch.requestBody, { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/communicationSettingsInputSchema" } } } });
  assert.deepEqual(Object.keys(spec.components.schemas.communicationSettingsInputSchema.properties).sort(), Object.keys(DEFAULT_COMMUNICATION_SETTINGS).sort(), "the contract names exactly the settings");
  for (const operation of [settings.get, settings.patch]) assert.deepEqual(operation.responses["200"].content["application/json"].schema, { $ref: "#/components/schemas/CommunicationSettingsResponse" });
  const response = spec.components.schemas.CommunicationSettingsResponse;
  assert.deepEqual(response.required, ["item", "status"]);
  assert.deepEqual(response.properties.item, { $ref: "#/components/schemas/communicationSettingsInputSchema" });
  assert.deepEqual(Object.keys(response.properties.status.properties).sort(), ["effectiveSendingState", "providerConfigured", "webhookConfigured", "webhookUrl"]);
  assert.deepEqual(response.properties.status.properties.effectiveSendingState.enum, ["disabled", "provider-missing", "sandbox", "safe-mode", "live"]);
  const answer = configurationTest.post.responses["200"].content["application/json"].schema;
  assert.deepEqual([answer.required, answer.properties.transport.enum], [["ok", "transport", "providerMessageId"], ["sendgrid", "console"]]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// A POST with nothing to say. The server hands a handler a body stream for every method but GET and HEAD, an empty one when the client sent no
// body, so the proxy's JSON gate has to tell an empty stream from a body: or a bare POST is refused as invalid JSON before its route is reached.
// ---------------------------------------------------------------------------------------------------------------------------------

const CONFIGURATION_TEST_URL = "http://localhost:3000/api/v1/admin/communications/settings/test";
const emptyStream = () => new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
/** A stream that delivers `parts` as chunks of their own, an empty one included. */
const chunks = (...parts: string[]) => new ReadableStream<Uint8Array>({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close(); } });
/** A POST to the configuration test, as the proxy gets it. `body` is what the client sent; leaving it out sends no body at all. */
const postTo = (body?: BodyInit | null, headers: Record<string, string> = {}) =>
  new NextRequest(CONFIGURATION_TEST_URL, {
    method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", ...headers },
    ...(body === undefined ? {} : { body, duplex: "half" }),
  } as ConstructorParameters<typeof NextRequest>[1]);

test("proxy: a POST with no body is not refused by the JSON gate and reaches its route, however the body is missing", async () => {
  globalThis.pulseSharedLocalLimits = undefined; // every request below comes from the same address: start from an empty window
  try {
    const bare: Array<[string, () => NextRequest]> = [
      ["no body at all", () => postTo()],
      ["an empty string", () => postTo("")],
      ["an empty stream and no content type, as a bare curl -X POST arrives", () => postTo(emptyStream())],
      ["an empty stream that says it is JSON", () => postTo(emptyStream(), { "content-type": "application/json" })],
      ["a declared length of 0", () => postTo("", { "content-length": "0" })],
      ["a declared length of 0 and a content type, as a browser's fetch sends it", () => postTo("", { "content-length": "0", "content-type": "application/json" })],
    ];
    for (const [what, make] of bare) assert.equal((await proxy(make())).status, 200, what);
  } finally {
    globalThis.pulseSharedLocalLimits = undefined;
  }
});

test("proxy: a POST with a body is still held to the JSON gate — an empty first chunk or a blank is not 'no body' — and the body is left whole for the route", async () => {
  globalThis.pulseSharedLocalLimits = undefined;
  try {
    const refused: Array<[string, () => NextRequest]> = [
      ["an unfinished object", () => postTo("{", { "content-type": "application/json" })],
      ["a blank", () => postTo(" ")],
      ["a stream whose first chunk is empty and whose second is not JSON", () => postTo(chunks("", "{"))],
      ["a body of a declared length that is not JSON", () => postTo("{", { "content-length": "1" })],
    ];
    for (const [what, make] of refused) {
      const response = await proxy(make());
      assert.deepEqual([response.status, (await response.json()).error.code], [400, "INVALID_JSON"], what);
    }
    const tooLarge = await proxy(postTo(JSON.stringify({ text: "x".repeat(70_000) }), { "content-type": "application/json" }));
    assert.deepEqual([tooLarge.status, (await tooLarge.json()).error.code], [413, "PAYLOAD_TOO_LARGE"], "the size limit is the gate's still");
    const accepted: Array<[string, () => NextRequest, string]> = [
      ["an empty object", () => postTo("{}", { "content-type": "application/json" }), "{}"],
      ["a stream of two chunks", () => postTo(chunks("{", "}")), "{}"],
      ["a stream whose first chunk is empty", () => postTo(chunks("", '{"a":1}')), '{"a":1}'],
    ];
    for (const [what, make, text] of accepted) {
      const request = make();
      assert.equal((await proxy(request)).status, 200, what);
      assert.equal(await request.text(), text, `${what}: looking at the body leaves it unread for the route`);
    }
  } finally {
    globalThis.pulseSharedLocalLimits = undefined;
  }
});

test("proxy: a body that fails while the gate looks at it is answered like any failure of the gate — a 500 with a support id, not an exception out of the proxy", async () => {
  globalThis.pulseSharedLocalLimits = undefined;
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("connection reset by peer")); } });
    const response = await proxy(postTo(broken));
    assert.deepEqual([response.status, (await response.json()).error.code], [500, "INTERNAL_ERROR"]);
    assert.ok(!logged.join(" ").includes("connection reset"), "and the reason is not logged");
  } finally {
    console.error = original;
    globalThis.pulseSharedLocalLimits = undefined;
  }
});

/** A POST as the server hands it to a route when the client sent no body: a body stream with nothing in it, not no stream. */
const emptyPost = (path: string, headers: Record<string, string> = {}) => req(path, { method: "POST", headers, body: "" });

test("routes: an empty body is no body — the campaign routes that take an optional body, and the idempotent ones, answer it as they answer a POST with none", async () => {
  await enableSending();
  const draft = await createDraft();
  const at = (suffix: string, headers: Record<string, string> = {}) => emptyPost(`${CAMPAIGNS}/${draft.id}${suffix}`, headers);
  const duplicated = await duplicatePost(at("/duplicate", { "idempotency-key": freshKey() }), forCampaign(draft.id));
  assert.equal(duplicated.status, 201, "duplicate takes no body, and is idempotent");
  const tested = await testPost(at("/test", { "idempotency-key": freshKey() }), forCampaign(draft.id));
  assert.deepEqual([tested.status, await tested.json()], [200, { queued: 1 }], "a test send with no extra recipients");
  const sendKey = freshKey();
  const sent = await sendPost(at("/send", { "if-match": draft.version, "idempotency-key": sendKey }), forCampaign(draft.id));
  assert.equal(sent.status, 200, "send with no body is send now");
  const campaign = (await sent.json()).item as CampaignItem;
  assert.equal(campaign.status, "Sending");
  assert.equal((await sendPost(at("/send", { "if-match": draft.version, "idempotency-key": sendKey }), forCampaign(draft.id))).status, 200, "and a replay under the same key is a replay");
  assert.deepEqual(await (await retryPost(at("/deliveries/retry", { "idempotency-key": freshKey() }), forCampaign(draft.id))).json(), { requeued: 0, reopened: false }, "retry takes no body, and is idempotent");
  assert.equal((await cancelPost(at("/cancel", { "if-match": campaign.version }), forCampaign(draft.id))).status, 200, "cancel with no body is cancel the remaining");
});

test("job routes: an empty body is no body — all four answer a POST that sends none as they answer one with none", async () => {
  await withJobSecret(async () => {
    const jobs: Array<[string, (request: Request) => Promise<Response>]> = [
      ["communications", communicationsJobPost], ["notifications", notificationsJobPost], ["retention", retentionJobPost], ["webhooks", webhooksJobPost],
    ];
    for (const [name, post] of jobs) {
      const response = await post(emptyPost(`/api/v1/internal/jobs/${name}`, { "x-pulse-job-secret": JOB_SECRET }));
      assert.equal(response.status, 200, name);
      assert.deepEqual(await refusal(await post(emptyPost(`/api/v1/internal/jobs/${name}`, { "x-pulse-job-secret": "wrong" }))), [401, "UNAUTHORIZED"], `${name}: the secret is still asked for`);
    }
  });
});

test("requestHasBody: a declared length decides when there is one; without one the first chunk of a copy does, and nothing more is read", async () => {
  const request = (body?: BodyInit | null, headers: Record<string, string> = {}) =>
    new Request("http://localhost/x", { method: "POST", headers, ...(body === undefined ? {} : { body, duplex: "half" }) } as RequestInit);
  assert.deepEqual(
    await Promise.all([request(), request(""), request(emptyStream()), request("", { "content-length": "0" }), request(chunks("", ""))].map((r) => requestHasBody(r))),
    [false, false, false, false, false],
    "no stream, an empty string, an empty stream, a declared length of 0, chunks without a byte",
  );
  assert.deepEqual(
    await Promise.all([request("{}"), request(chunks("", "{")), request("{}", { "content-length": "2" })].map((r) => requestHasBody(r))),
    [true, true, true],
    "a string, a stream whose first chunk is empty and whose second is not, a declared length above 0",
  );
  assert.deepEqual(
    await Promise.all([request("{}", { "content-length": "0" }), request("", { "content-length": "5" })].map((r) => requestHasBody(r))),
    [false, true],
    "the declared length decides when there is one: 0 is no body whatever follows, and a promised body is a body for the gate to judge",
  );
  const endless = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }); // one chunk, and no end
  assert.equal(await requestHasBody(request(endless)), true, "it does not wait for a stream to finish");
  const sent = request("abc");
  assert.equal(await requestHasBody(sent), true);
  assert.equal(await sent.text(), "abc", "and the request is left unread");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// What a card says when a request is refused (lib/api-client.ts). The server answers every refusal it can explain with a 400 and a code
// (INVALID_*); errorMessage turns the code into a sentence a person can act on, which the toasts and the error lines of the cards show.
// ---------------------------------------------------------------------------------------------------------------------------------

/** The codes the communications screens meet, and what a person is told for each. */
const REFUSAL_SENTENCES: Array<[string, string]> = [
  ["INVALID_SAFE_MODE_BLOCKS_RECIPIENT", "Safe mode is on and your address's domain is not allow-listed."],
  ["INVALID_EMAIL_PROVIDER_CONFIGURATION", "SendGrid is not configured: add the API key and a verified from address."],
  ["INVALID_COMMUNICATIONS_DISABLED", "Sending is disabled in Settings."],
  ["INVALID_AUDIENCE_EMPTY", "Nobody matches this audience."],
  ["INVALID_AUDIENCE_TOO_LARGE", "This audience exceeds the maximum recipients per communication."],
  ["INVALID_SCHEDULE_TIME", "Choose a time at least one minute ahead and within 30 days."],
  ["INVALID_COMMUNICATION_STATE", "This communication is no longer in a state that allows that action."],
  ["INVALID_CONTACT_EXISTS", "That address is already on this company's list."],
  ["INVALID_INPUT", "Some fields are missing or invalid."],
];

test("errorMessage: a 400 says what its code means, followed by the support id when there is one", () => {
  for (const [code, sentence] of REFUSAL_SENTENCES) {
    assert.equal(errorMessage(new ApiFailure(400, code)), sentence, code);
    assert.equal(errorMessage(new ApiFailure(400, code, "support-1")), `${sentence} Support ID: support-1`, `${code} with a support id`);
  }
});

test("errorMessage: a 400 whose code has no sentence of its own is told in the words of the code, and anything else keeps the usual text", () => {
  assert.equal(errorMessage(new ApiFailure(400, "INVALID_SOMETHING_NEW", "support-2")), "Something new. Support ID: support-2");
  assert.equal(errorMessage(new ApiFailure(400, "INVALID_EMAIL_PROVIDER_HTTP_401")), "Email provider http 401.", "the provider's own code stays in it");
  // only a 400 is a refusal that can be explained, and only an INVALID_ code has words to say
  const usual = "The operation failed. Please try again.";
  assert.equal(errorMessage(new ApiFailure(400, "REQUEST_FAILED")), usual, "a 400 without a code from the server");
  assert.equal(errorMessage(new ApiFailure(400, "INVALID_")), usual, "an INVALID_ with nothing after it");
  assert.equal(errorMessage(new ApiFailure(500, "INVALID_INPUT")), usual, "a code on another status");
  assert.equal(errorMessage(new ApiFailure(400, "constructor")), usual, "a name every object has is not a code");
  assert.equal(errorMessage(new ApiFailure(409, "IDEMPOTENCY_CONFLICT", "support-3")), `${usual} Support ID: support-3`);
});

test("errorMessage: the texts for an expired session, a changed item, a missing version and a lost connection are as they were", () => {
  assert.equal(errorMessage(new ApiFailure(401, "UNAUTHORIZED", "support-4")), "Your session expired. Your input is still here. Sign in and retry. Support ID: support-4");
  assert.equal(errorMessage(new ApiFailure(412, "VERSION_CONFLICT")), "This item changed. Reload it and review the latest version before saving.");
  assert.equal(errorMessage(new ApiFailure(428, "PRECONDITION_REQUIRED", "support-5")), "Reload this item before saving. Support ID: support-5");
  assert.equal(errorMessage(new TypeError("fetch failed")), "Unable to connect. Your input is still here; please retry.");
});

test("errorMessage: every sentence it says for a code has an Icelandic line, and the support id is carried over", () => {
  for (const [code, sentence] of REFUSAL_SENTENCES) {
    assert.ok(IS[sentence], `${code}: no Icelandic for "${sentence}"`);
    assert.notEqual(IS[sentence], sentence, code);
  }
  const is = makeT("is");
  assert.equal(is(errorMessage(new ApiFailure(400, "INVALID_AUDIENCE_EMPTY", "support-6"))), `${IS["Nobody matches this audience."]} Númer fyrir aðstoð: support-6`);
});
