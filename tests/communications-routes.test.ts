import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createSessionToken } from "../lib/server/session";
import { resetCommunicationMemory } from "../lib/server/communications/memory";
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
