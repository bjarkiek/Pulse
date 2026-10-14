import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PulseIdentity } from "../lib/domain";
import { createSessionToken } from "../lib/server/session";
import { organizations, users } from "../lib/server/admin-repository";
import { resetCommunicationMemory } from "../lib/server/communications/memory";
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
type CampaignItem = { id: string; version: string; status: string; title: string; recipientCount: number; scheduledAt?: string; cancelledAt?: string; stats: { recipients: number; queued: number; cancelled: number } };
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
/** Sending on: the provider key is set and the settings are enabled with safe mode off. The settings have no route yet, so a System admin saves them through the repository. */
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
  assert.deepEqual(await retried.json(), { requeued: 2 });
  assert.deepEqual([(await deliveriesOf(draft.id, "?state=Queued")).total, (await deliveriesOf(draft.id, deadLetters)).total], [2, 0]);
  const replay = await retryCampaign(draft.id, key);
  assert.deepEqual(await replay.json(), { requeued: 2 }, "the stored answer");
  assert.equal(auditCount("communication.deliveries.retried"), 1);
  assert.deepEqual(await (await retryCampaign(draft.id)).json(), { requeued: 0 }, "a call under a new key does the work again, and there is nothing left to requeue");
  assert.deepEqual(await refusal(await retryCampaign("COM-999")), [404, "NOT_FOUND"]);
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
