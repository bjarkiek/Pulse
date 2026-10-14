import test, { after, before, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { PulseIdentity } from "../lib/domain";
import { sql } from "../lib/server/database";
import { createSessionToken } from "../lib/server/session";
import { processRetentionBatch } from "../lib/server/retention-worker";
import { processCommunicationBatch } from "../lib/server/communications/delivery-worker";
import { getDeliveryStore } from "../lib/server/communications/delivery-store";
import { applyEvents } from "../lib/server/communications/event-webhook";
import { importContacts, listContacts, removeContact, saveContact } from "../lib/server/communications/contact-repository";
import { loadSuppressionMap, releaseAddress, suppressAddress } from "../lib/server/communications/suppression-repository";
import { SendError, type MailTransport } from "../lib/server/communications/sendgrid";
import * as communications from "../app/api/v1/internal/communications/route";
import * as communication from "../app/api/v1/internal/communications/[id]/route";
import * as duplicate from "../app/api/v1/internal/communications/[id]/duplicate/route";
import * as preview from "../app/api/v1/internal/communications/[id]/preview/route";
import * as audience from "../app/api/v1/internal/communications/[id]/audience/route";
import * as testSend from "../app/api/v1/internal/communications/[id]/test/route";
import * as send from "../app/api/v1/internal/communications/[id]/send/route";
import * as cancel from "../app/api/v1/internal/communications/[id]/cancel/route";
import * as deliveries from "../app/api/v1/internal/communications/[id]/deliveries/route";
import * as retry from "../app/api/v1/internal/communications/[id]/deliveries/retry/route";
import * as suppressions from "../app/api/v1/internal/communications/suppressions/route";
import * as companyContacts from "../app/api/v1/communications/contacts/route";
import * as companyContact from "../app/api/v1/communications/contacts/[contactId]/route";
import * as settings from "../app/api/v1/admin/communications/settings/route";
import * as preferences from "../app/api/v1/notifications/preferences/route";

// The customer-communications code against real SQL: the routes and repositories of the feature, the delivery worker and the event webhook's
// effect, run through a disposable database. Opt-in exactly like tests/sql-security.test.ts (PULSE_SQL_TEST=1, PULSE_TEST_SQL_CONNECTION_STRING,
// PULSE_SQL_NATIVE=1 for LocalDB): use a DISPOSABLE database with migrations 001-015 applied.
//
// Nothing is sent. The worker is given a stub transport, no route that mails (the job route, the settings' configuration test) is called, and
// SENDGRID_API_KEY is a made-up value that only makes the provider "configured". The suite makes its own companies, people and campaigns (every
// name carries a random tag), reaches its audiences only through those companies, and deletes everything it made, which `after` then checks. The
// worker and the retention batch work on the whole database, though: the suite refuses to start when the database already has a communication in
// flight, and skips the retention case when it holds attachments, but it belongs on a database nobody else uses.
const enabled = process.env.PULSE_SQL_TEST === "1";

type Person = { id: string; email: string; name: string; org: string; locale: "en" | "is" };
type SettingsRow = { value_json: string; version: number; updated_by_user_id: string | null; updated_at: Date };

/**
 * What one run of the suite is made of: a random tag, its companies and its people, and what `cleanup` needs to put the database right. The suite has one
 * (`main`, made ready by `before` and cleared away by `after`); the last case makes a second one, to see what a refusal leaves behind.
 */
function makeScope() {
  const tag = randomUUID().slice(0, 8);
  const domain = `${tag}.example`;
  const ORG = { internal: `t18i-${tag}`, a: `t18a-${tag}`, b: `t18b-${tag}`, test: `t18t-${tag}` };
  const person = (name: string, org: string, locale: "en" | "is" = "en"): Person => ({ id: randomUUID(), email: `${name}@${domain}`, name, org, locale });
  // admin is a System admin of the internal company and also a Company admin of company A (like the seeded admin of the development seed).
  const people = {
    admin: person("admin", ORG.internal),
    adminOfA: undefined as unknown as Person, // the same user, signed in to company A
    ben: person("ben", ORG.b, "is"), // Company admin of B, prefers Icelandic
    ann: person("ann", ORG.b), // Requester of B
    carl: person("carl", ORG.b), // Requester of B
    tess: person("tess", ORG.test), // Requester of the test company
  };
  people.adminOfA = { ...people.admin, org: ORG.a };
  return {
    tag, domain, otherDomain: `${tag}-other.example`, ORG, people,
    userIds: [people.admin.id, people.ben.id, people.ann.id, people.carl.id, people.tess.id],
    // Set as soon as the live settings row has been read, and not before: until then the suite has touched nothing, and `cleanup` must touch nothing either.
    prepared: false,
    settingsBefore: null as SettingsRow | null,
  };
}
type Scope = ReturnType<typeof makeScope>;
const main = makeScope();
const { tag, domain, otherDomain, ORG, people, userIds } = main;

let pool: import("mssql").ConnectionPool;
const envBefore = { AZURE_SQL_SERVER: process.env.AZURE_SQL_SERVER, AZURE_STORAGE_ACCOUNT_NAME: process.env.AZURE_STORAGE_ACCOUNT_NAME, SENDGRID_API_KEY: process.env.SENDGRID_API_KEY };

before(async () => {
  if (!enabled) return;
  const connectionString = process.env.PULSE_TEST_SQL_CONNECTION_STRING!;
  if (process.env.PULSE_SQL_NATIVE === "1") {
    const native = createRequire(import.meta.url)("mssql/msnodesqlv8");
    Object.assign(sql, { ConnectionPool: native.ConnectionPool, Transaction: native.Transaction, Request: native.Request });
    // Harness only, for the native driver (LocalDB). msnodesqlv8 opens a transaction with "set transaction isolation level serializable; begin tran"
    // and nothing resets that when the transaction ends, so the pooled connection stays SERIALIZABLE for the next plain request, and SQL Server then
    // refuses the READPAST hint of the worker's claim ("You can only specify the READPAST lock in the READ COMMITTED or REPEATABLE READ isolation
    // levels"). Tedious, the driver of production, scopes the level to the transaction, so the application is not changed for this: a plain request
    // is put back on READ COMMITTED here, and a request inside a transaction is left alone.
    const query = native.Request.prototype.query;
    native.Request.prototype.query = function (this: { parent?: unknown }, text: unknown, ...rest: unknown[]) {
      const plain = !(this.parent instanceof native.Transaction) && typeof text === "string";
      return query.call(this, plain ? `SET TRANSACTION ISOLATION LEVEL READ COMMITTED;\n${text}` : text, ...rest);
    };
    pool = await new native.ConnectionPool({ connectionString }).connect();
  } else {
    pool = await new sql.ConnectionPool(connectionString).connect();
  }
  process.env.AZURE_SQL_SERVER = "isolated-test-fixture"; // "SQL is configured": the pool below is the one the application uses
  process.env.AZURE_STORAGE_ACCOUNT_NAME = "fakestorageaccount"; // the retention batch asks for it; it touches no blob while there is no attachment
  process.env.SENDGRID_API_KEY = "SG.fake-key-for-the-sql-suite-never-sent-anywhere";
  globalThis.pulseSqlPool = Promise.resolve(pool);
  await prepare(main);
});

after(async () => {
  if (!pool) return;
  try {
    // Nothing at all when `before` refused, or failed before it had read the settings row: then the suite has made nothing and must not touch what is there.
    await cleanup(main);
  } finally {
    await pool.close();
    globalThis.pulseSqlPool = undefined;
    for (const [name, value] of Object.entries(envBefore)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

/** The worker takes every claimable row of the database, and the retention batch purges what is due in all of it: refuse a database that has communications in flight. */
async function assertIdle() {
  const busy = (
    await pool.request().query(`SELECT
      (SELECT COUNT(*) FROM dbo.CommunicationDeliveries WHERE state IN ('Queued','Retry','Processing')) deliveries,
      (SELECT COUNT(*) FROM dbo.Communications WHERE deleted_at IS NULL AND status IN ('Scheduled','Sending')) campaigns`)
  ).recordset[0];
  if (busy.deliveries || busy.campaigns)
    throw new Error("This database has communications in flight, and the worker of this suite would take them: use a disposable database.");
}

/** Makes the scope's companies and people. The refusal of a busy database comes first and writes nothing. */
async function prepare(scope: Scope) {
  await assertIdle();
  // The settings row is the one global thing the suite writes: keep what was there, start from nothing, put it back in `cleanup`.
  scope.settingsBefore = (await pool.request().query("SELECT value_json,version,updated_by_user_id,updated_at FROM dbo.Settings WHERE setting_key='communications'")).recordset[0] ?? null;
  scope.prepared = true;
  await pool.request().query("DELETE dbo.Settings WHERE setting_key='communications'");

  const { ORG: orgs, people: who, domain: scopeDomain } = scope;
  await pool
    .request()
    .input("internal", orgs.internal).input("a", orgs.a).input("b", orgs.b).input("test", orgs.test)
    .input("domain", scopeDomain)
    .query(`
      INSERT dbo.Organizations(id,name,type,verified_domain) VALUES(@internal,'SQL suite staff','Internal',@domain),(@a,'SQL suite company A','Customer',@domain),(@b,'SQL suite company B','Customer',@domain);
      INSERT dbo.Organizations(id,name,type,verified_domain,is_test) VALUES(@test,'SQL suite test company','Customer',@domain,1);`);
  for (const p of [who.admin, who.ben, who.ann, who.carl, who.tess])
    await pool.request().input("id", sql.UniqueIdentifier, p.id).input("email", p.email).input("name", p.name).input("locale", p.locale)
      .query("INSERT dbo.Users(id,email,display_name,status,auth_method,locale) VALUES(@id,@email,@name,'Active','Entra ID',@locale)");
  const memberships: Array<[Person, string, string]> = [
    [who.admin, orgs.internal, "System admin"], [who.admin, orgs.a, "Company admin"], [who.ben, orgs.b, "Company admin"],
    [who.ann, orgs.b, "Requester"], [who.carl, orgs.b, "Requester"], [who.tess, orgs.test, "Requester"],
  ];
  for (const [p, org, role] of memberships)
    await pool.request().input("user", sql.UniqueIdentifier, p.id).input("org", org).input("role", role)
      .query("INSERT dbo.Memberships(id,user_id,organization_id,role,status) VALUES(NEWID(),@user,@org,@role,'Active')");
}

/** Deletes everything the scope made, puts the settings row back, and checks that nothing of it is left. Does nothing for a scope that was never prepared. */
async function cleanup(scope: Scope) {
  if (!scope.prepared) return;
  const inputs = () =>
    pool
      .request()
      .input("orgs", sql.NVarChar(sql.MAX), JSON.stringify(Object.values(scope.ORG)))
      .input("users", sql.NVarChar(sql.MAX), JSON.stringify(scope.userIds))
      .input("admin", sql.UniqueIdentifier, scope.people.admin.id)
      .input("pattern", `%${scope.tag}%`);
  await inputs().query(`
    DELETE dbo.Settings WHERE setting_key='communications';
    DELETE dbo.CommunicationEvents WHERE sg_event_id LIKE @pattern;
    DELETE d FROM dbo.CommunicationDeliveries d JOIN dbo.Communications c ON c.id=d.communication_id WHERE c.created_by_user_id=@admin;
    DELETE dbo.Communications WHERE created_by_user_id=@admin;
    DELETE dbo.CommunicationContacts WHERE organization_id IN (SELECT value FROM OPENJSON(@orgs));
    DELETE dbo.CommunicationSuppressions WHERE email LIKE @pattern;
    DELETE dbo.NotificationPreferences WHERE user_id IN (SELECT TRY_CONVERT(uniqueidentifier,value) FROM OPENJSON(@users));
    DELETE dbo.AuditEvents WHERE actor_user_id IN (SELECT TRY_CONVERT(uniqueidentifier,value) FROM OPENJSON(@users)) OR organization_id IN (SELECT value FROM OPENJSON(@orgs));
    DELETE dbo.IdempotencyKeys WHERE organization_id IN (SELECT value FROM OPENJSON(@orgs));
    DELETE dbo.Memberships WHERE user_id IN (SELECT TRY_CONVERT(uniqueidentifier,value) FROM OPENJSON(@users));
    DELETE dbo.Users WHERE id IN (SELECT TRY_CONVERT(uniqueidentifier,value) FROM OPENJSON(@users));
    DELETE dbo.Organizations WHERE id IN (SELECT value FROM OPENJSON(@orgs));`);
  const snapshot = scope.settingsBefore;
  if (snapshot)
    await pool.request().input("value", snapshot.value_json).input("version", sql.Int, snapshot.version)
      .input("by", sql.UniqueIdentifier, snapshot.updated_by_user_id).input("at", sql.DateTime2, snapshot.updated_at)
      .query("INSERT dbo.Settings(setting_key,value_json,version,updated_by_user_id,updated_at) VALUES('communications',@value,@version,@by,@at)");
  // Nothing of the scope is left: no row of any table it wrote to names one of its companies or people, or carries its tag.
  const left = (
    await inputs().query(`SELECT
      (SELECT COUNT(*) FROM dbo.Organizations WHERE id IN (SELECT value FROM OPENJSON(@orgs))) organizations,
      (SELECT COUNT(*) FROM dbo.Users WHERE id IN (SELECT TRY_CONVERT(uniqueidentifier,value) FROM OPENJSON(@users))) users,
      (SELECT COUNT(*) FROM dbo.CommunicationContacts WHERE organization_id IN (SELECT value FROM OPENJSON(@orgs))) contacts,
      (SELECT COUNT(*) FROM dbo.CommunicationSuppressions WHERE email LIKE @pattern) suppressions,
      (SELECT COUNT(*) FROM dbo.CommunicationEvents WHERE sg_event_id LIKE @pattern) events,
      (SELECT COUNT(*) FROM dbo.CommunicationDeliveries WHERE organization_id IN (SELECT value FROM OPENJSON(@orgs)) OR email LIKE @pattern) deliveries,
      (SELECT COUNT(*) FROM dbo.Communications WHERE title LIKE @pattern) communications,
      (SELECT COUNT(*) FROM dbo.NotificationPreferences WHERE user_id IN (SELECT TRY_CONVERT(uniqueidentifier,value) FROM OPENJSON(@users))) preferences,
      (SELECT COUNT(*) FROM dbo.AuditEvents WHERE actor_user_id IN (SELECT TRY_CONVERT(uniqueidentifier,value) FROM OPENJSON(@users)) OR organization_id IN (SELECT value FROM OPENJSON(@orgs))) audit,
      (SELECT COUNT(*) FROM dbo.IdempotencyKeys WHERE organization_id IN (SELECT value FROM OPENJSON(@orgs))) idempotency`)
  ).recordset[0];
  assert.deepEqual(Object.values(left).filter(Boolean), [], `rows the suite left behind: ${JSON.stringify(left)}`);
}

const sqlTest = (name: string, fn: (t: TestContext) => Promise<void>) => test(name, { skip: !enabled }, fn);

// ---- helpers ---------------------------------------------------------------------------------------------------------------------------
type Handler = (request: Request, context?: any) => Promise<Response>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Reply = { status: number; json: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const cookies = new Map<string, string>();
async function cookieFor(who: Person) {
  if (!cookies.has(who.id))
    cookies.set(who.id, `pulse-session=${encodeURIComponent(await createSessionToken({ sub: who.id, email: who.email, name: who.name, ext: "dev:sql-suite", amr: "entra" }))}`);
  return cookies.get(who.id)!;
}
const freshKey = () => `sqlsuite-${randomUUID().slice(0, 12)}`;
/** A call to a route handler as a signed-in person, in the company named by the person: real session, real membership, real database. */
async function call(handler: Handler, method: string, path: string, options: { as?: Person; body?: unknown; headers?: Record<string, string>; params?: Record<string, string>; key?: boolean } = {}): Promise<Reply> {
  const who = options.as ?? people.admin;
  const init: RequestInit = {
    method,
    headers: {
      host: "localhost", origin: "http://localhost", "sec-fetch-site": "same-origin", cookie: await cookieFor(who), "x-pulse-organization-id": who.org,
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}), ...(options.key ? { "idempotency-key": freshKey() } : {}), ...options.headers,
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  };
  const response = await handler(new Request(`http://localhost${path}`, init), options.params ? { params: Promise.resolve(options.params) } : undefined);
  const text = await response.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* an HTML or text answer stays text */ }
  return { status: response.status, json };
}
/** The identity a repository function takes, for a person who is signed in (the repositories decide the role from the database). */
const identityOf = (who: Person): PulseIdentity => ({ id: who.id, email: who.email, name: who.name, organizationId: who.org, role: "Unknown", isInternal: false, authMethod: "entra", sessionIssuedAt: 1 });

const calls: Array<{ subject: string; recipients: string[]; sandbox: boolean }> = [];
/** The mail provider that never leaves the process: it records the request and answers as `behaviour` says (or throws). */
const stubTransport = (behaviour: () => { providerMessageId: string | null } = () => ({ providerMessageId: `${tag}-msg-${calls.length}` })): MailTransport => ({
  kind: "sendgrid",
  async sendBatch(batch) {
    calls.push({ subject: batch.subject, recipients: batch.recipients.map((r) => r.email), sandbox: batch.sandbox });
    return behaviour();
  },
});
/** The worker logs a failed send as a JSON line; keep the report readable. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const original = { error: console.error, warn: console.warn };
  console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.error = original.error; console.warn = original.warn; }
}
const q = async (text: string, inputs: Record<string, unknown> = {}) => {
  const request = pool.request();
  for (const [name, value] of Object.entries(inputs)) request.input(name, value);
  return (await request.query(text)).recordset;
};

const content = (title: string, withIcelandic = false) => ({
  subject: { en: `${title} subject`, ...(withIcelandic ? { is: `${title} efni` } : {}) },
  body: { en: { title, intro: "Intro text.", sections: [{ heading: "Highlight", body: "Body text." }] } },
});
/** All of the suite's customers: the two companies and the test company, which the audience leaves out by itself. Never "all customers", which would reach whatever else the database holds. */
const spec = { organizations: [ORG.a, ORG.b, ORG.test], includeOnboarding: false, includeTestOrganizations: false, includeMembers: true, memberRoles: null, includeContacts: true, includeInternalCopy: false };
const draftBody = (title: string, extra: Record<string, unknown> = {}) => ({ templateKey: "product-update", topic: "product-updates", title, content: content(title), audience: spec, ...extra });
const deliveriesOf = async (id: string, as: Person = people.admin) => (await call(deliveries.GET, "GET", `/api/v1/internal/communications/${id}/deliveries?pageSize=250`, { as, params: { id } })).json;
const campaign = async (id: string) => (await call(communication.GET, "GET", `/api/v1/internal/communications/${id}`, { params: { id } })).json.item;
const acceptedToday = () => getDeliveryStore().acceptedToday(new Date());

let one: any, two: any, three: any; // eslint-disable-line @typescript-eslint/no-explicit-any
let settingsSaved: any; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---- settings --------------------------------------------------------------------------------------------------------------------------
sqlTest("SQL settings: a System admin reads the defaults, saves the whole object and reads back what was saved (dbo.Settings JSON)", async () => {
  const first = await call(settings.GET, "GET", "/api/v1/admin/communications/settings");
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.item.enabled, false);
  const desired = { ...first.json.item, enabled: true, fromEmail: `updates@${domain}`, sandboxMode: true, safeMode: { enabled: true, allowedDomains: [domain] } };
  const saved = await call(settings.PATCH, "PATCH", "/api/v1/admin/communications/settings", { body: desired });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const again = await call(settings.GET, "GET", "/api/v1/admin/communications/settings");
  assert.deepEqual(again.json.item, saved.json.item);
  assert.equal(again.json.item.fromEmail, `updates@${domain}`);
  assert.equal(again.json.status.providerConfigured, true);
  assert.equal(again.json.status.effectiveSendingState, "sandbox");
  settingsSaved = again.json.item;
});

sqlTest("SQL settings: a member who is not staff gets 404 for the read and the save, and nothing is saved", async () => {
  assert.equal((await call(settings.GET, "GET", "/api/v1/admin/communications/settings", { as: people.ann })).status, 404);
  assert.equal((await call(settings.PATCH, "PATCH", "/api/v1/admin/communications/settings", { as: people.ann, body: { ...settingsSaved, fromEmail: `evil@${otherDomain}` } })).status, 404);
  assert.equal((await call(settings.GET, "GET", "/api/v1/admin/communications/settings")).json.item.fromEmail, `updates@${domain}`);
});

// ---- contacts, suppressions, preferences -----------------------------------------------------------------------------------------------
sqlTest("SQL contacts: save creates (MERGE with a subquery), an edit updates, a duplicate address is refused, a removed address can be added again", async () => {
  const admin = identityOf(people.admin);
  const cio = await saveContact(admin, { organizationId: ORG.a, email: `cio@${domain}`, displayName: "CIO", locale: "is", topics: ["product-updates", "service-notices"] });
  assert.deepEqual([cio.email, cio.locale, cio.source, cio.status], [`cio@${domain}`, "is", "Admin", "Active"]);
  const ops = await saveContact(admin, { organizationId: ORG.a, email: `ops@${domain}`, displayName: "Ops", locale: "en", topics: ["service-notices", "general"] });
  const edited = await saveContact(admin, { id: ops.id, organizationId: ORG.a, email: `ops@${domain}`, displayName: "Operations", locale: "is", topics: ["general"] });
  assert.equal(edited.id, ops.id);
  assert.equal(edited.displayName, "Operations");
  assert.deepEqual(edited.topics, ["general"]);
  await assert.rejects(saveContact(admin, { organizationId: ORG.a, email: `ops@${domain}`, displayName: "Again", locale: "en", topics: ["general"] }), /INVALID_CONTACT_EXISTS/);
  await assert.rejects(saveContact(admin, { id: randomUUID(), organizationId: ORG.a, email: `ghost@${domain}`, displayName: "Ghost", locale: "en", topics: ["general"] }), /NOT_FOUND/);
  // a contact whose address is a Pulse member of that company links to the user, through the membership of the contact's own company
  const linked = await saveContact(admin, { organizationId: ORG.b, email: people.ann.email, displayName: "Ann as a contact", locale: "en", topics: ["general"] });
  assert.equal(String(linked.userId).toLowerCase(), people.ann.id.toLowerCase());
  await removeContact(admin, linked.id);
  const again = await saveContact(admin, { organizationId: ORG.b, email: people.ann.email, displayName: "Ann again", locale: "en", topics: ["general"] });
  assert.notEqual(again.id, linked.id, "the unique index is filtered on deleted_at, so a removed address can come back");
  await removeContact(admin, again.id);
  assert.ok((await listContacts(admin, ORG.a)).some((c) => c.email === `cio@${domain}`));
});

sqlTest("SQL contacts: the paste import creates, and skips an invalid line and a duplicate", async () => {
  const admin = identityOf(people.admin);
  const result = await importContacts(admin, ORG.a, `Blocked One, blocked@${domain}\nnot an address\nOther, x@${otherDomain}\nCIO again, cio@${domain}\nSolo, solo@${domain}`, ["product-updates"]);
  assert.deepEqual(result.created.map((c) => c.email).sort(), [`blocked@${domain}`, `solo@${domain}`, `x@${otherDomain}`].sort());
  assert.deepEqual(result.skipped.map((s) => [s.line, s.reason]), [[2, "invalid"], [4, "duplicate"]]);
  await removeContact(admin, result.created.find((c) => c.email === `solo@${domain}`)!.id);
});

sqlTest("SQL company contacts (real identities): a Company admin lists, adds, edits and removes their own company's list; a Requester gets 404; no company reaches another's", async () => {
  assert.equal((await call(companyContacts.GET, "GET", "/api/v1/communications/contacts", { as: people.ann })).status, 404);
  const empty = await call(companyContacts.GET, "GET", "/api/v1/communications/contacts", { as: people.ben });
  assert.equal(empty.status, 200, JSON.stringify(empty.json));
  assert.deepEqual(empty.json.items, []);
  const created = await call(companyContacts.POST, "POST", "/api/v1/communications/contacts", { as: people.ben, body: { email: `it@${domain}`, displayName: "IT", locale: "en", topics: ["service-notices"] } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.item.source, "Company admin");
  const id = created.json.item.id;
  const edited = await call(companyContact.PATCH, "PATCH", `/api/v1/communications/contacts/${id}`, { as: people.ben, params: { contactId: id }, body: { email: `it@${domain}`, displayName: "IT desk", locale: "is", topics: ["service-notices", "general"] } });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.equal(edited.json.item.displayName, "IT desk");
  const own = await call(companyContacts.GET, "GET", "/api/v1/communications/contacts", { as: people.adminOfA });
  assert.equal(own.status, 200);
  assert.ok(own.json.items.some((c: { email: string }) => c.email === `cio@${domain}`) && !own.json.items.some((c: { email: string }) => c.email === `it@${domain}`), "only the company's own contacts");
  assert.equal((await call(companyContact.DELETE, "DELETE", `/api/v1/communications/contacts/${id}`, { as: people.adminOfA, params: { contactId: id } })).status, 404, "another company's admin cannot remove it");
  assert.equal((await call(companyContact.DELETE, "DELETE", `/api/v1/communications/contacts/${id}`, { as: people.ben, params: { contactId: id } })).status, 200);
  assert.deepEqual((await call(companyContacts.GET, "GET", "/api/v1/communications/contacts", { as: people.ben })).json.items, []);
});

sqlTest("SQL suppressions: add by hand, list, a Manual suppression is not replaced by an event, the newest event wins, a release lifts only its own reason, remove", async () => {
  const added = await call(suppressions.POST, "POST", "/api/v1/internal/communications/suppressions", { body: { email: `Blocked@${domain}`, note: "by hand" } });
  assert.equal(added.status, 201, JSON.stringify(added.json));
  assert.equal((await call(suppressions.POST, "POST", "/api/v1/internal/communications/suppressions", { body: { email: people.carl.email, note: "a member, by hand" } })).status, 201);
  const listed = (await call(suppressions.GET, "GET", "/api/v1/internal/communications/suppressions")).json.items;
  assert.ok(listed.some((s: { email: string; reason: string; source: string }) => s.email === `blocked@${domain}` && s.reason === "Manual" && s.source === "Admin"));
  await suppressAddress(`blocked@${domain}`, "Bounced", "Webhook", "a late bounce");
  assert.equal((await loadSuppressionMap()).get(`blocked@${domain}`), "Manual");
  await suppressAddress(`hard@${domain}`, "Bounced", "Webhook", "550");
  assert.equal((await loadSuppressionMap()).get(`hard@${domain}`), "Bounced");
  await suppressAddress(`hard@${domain}`, "SpamReport", "Webhook");
  assert.equal((await loadSuppressionMap()).get(`hard@${domain}`), "SpamReport");
  await releaseAddress(`hard@${domain}`, "Bounced");
  assert.equal((await loadSuppressionMap()).get(`hard@${domain}`), "SpamReport", "a release lifts only the reason it names");
  await releaseAddress(`hard@${domain}`, "SpamReport");
  assert.equal((await loadSuppressionMap()).has(`hard@${domain}`), false);
  assert.equal((await call(suppressions.DELETE, "DELETE", "/api/v1/internal/communications/suppressions", { as: people.ann, body: { email: `x@${domain}` } })).status, 404);
  assert.equal((await call(suppressions.DELETE, "DELETE", "/api/v1/internal/communications/suppressions", { body: { email: `nobody@${domain}` } })).status, 404);
  // blocked@ and carl@ stay on the list: the audience below leaves them out
});

sqlTest("SQL preferences (real identity): a member switches a topic off, saving the same choice again works, a mandatory topic is a 400 that names its code, Daily is refused", async () => {
  const off = await call(preferences.PATCH, "PATCH", "/api/v1/notifications/preferences", { as: people.ann, body: { eventType: "communication.product-updates", cadence: "Off" } });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  const read = await call(preferences.GET, "GET", "/api/v1/notifications/preferences", { as: people.ann });
  assert.equal(read.json.items.find((p: { eventType: string }) => p.eventType === "communication.product-updates").cadence, "Off");
  assert.equal((await call(preferences.PATCH, "PATCH", "/api/v1/notifications/preferences", { as: people.ann, body: { eventType: "communication.product-updates", cadence: "Off" } })).status, 200);
  const mandatory = await call(preferences.PATCH, "PATCH", "/api/v1/notifications/preferences", { as: people.ann, body: { eventType: "communication.security-advisories", cadence: "Off" } });
  assert.equal(mandatory.status, 400, JSON.stringify(mandatory.json));
  assert.equal(mandatory.json.error.code, "MANDATORY_NOTIFICATION_MUST_BE_IMMEDIATE");
  const digest = await call(preferences.PATCH, "PATCH", "/api/v1/notifications/preferences", { as: people.ann, body: { eventType: "communication.general", cadence: "Daily" } });
  assert.deepEqual([digest.status, digest.json.error.code], [400, "INVALID_NOTIFICATION_CADENCE"]);
});

// ---- campaign one: create, edit, preview, audience, test mail, send, worker, events -------------------------------------------------------
sqlTest("SQL campaign: create answers 201 with a COM- id and a version, and the same key and body replays instead of creating a second one", async () => {
  const key = freshKey();
  const body = draftBody(`${tag} one`);
  const created = await call(communications.POST, "POST", "/api/v1/internal/communications", { body, headers: { "idempotency-key": key } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.match(created.json.item.id, /^COM-\d{3,}$/);
  assert.match(created.json.item.version, /^0x[0-9A-F]{16}$/);
  one = created.json.item;
  const replay = await call(communications.POST, "POST", "/api/v1/internal/communications", { body, headers: { "idempotency-key": key } });
  assert.equal(replay.status, 201);
  assert.equal(replay.json.item.id, one.id);
  assert.equal((await call(communications.GET, "GET", "/api/v1/internal/communications")).json.items.filter((c: { title: string }) => c.title === `${tag} one`).length, 1);
  assert.equal((await call(communications.POST, "POST", "/api/v1/internal/communications", { as: people.ann, body: draftBody(`${tag} not allowed`), key: true })).status, 404, "a member cannot create");
});

sqlTest("SQL campaign: an edit under If-Match saves and gives a new version, a stale version is 412 and changes nothing, no version is 428", async () => {
  const stale = one.version;
  const edited = await call(communication.PATCH, "PATCH", `/api/v1/internal/communications/${one.id}`, { params: { id: one.id }, headers: { "if-match": one.version }, body: draftBody(`${tag} one`, { content: content(`${tag} one`, true) }) });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.notEqual(edited.json.item.version, stale);
  assert.equal(edited.json.item.content.subject.is, `${tag} one efni`);
  const again = await call(communication.PATCH, "PATCH", `/api/v1/internal/communications/${one.id}`, { params: { id: one.id }, headers: { "if-match": stale }, body: draftBody(`${tag} one changed again`) });
  assert.equal(again.status, 412, JSON.stringify(again.json));
  one = await campaign(one.id);
  assert.equal(one.title, `${tag} one`);
  assert.equal((await call(communication.PATCH, "PATCH", `/api/v1/internal/communications/${one.id}`, { params: { id: one.id }, body: draftBody(`${tag} one`) })).status, 428);
});

sqlTest("SQL campaign: the preview renders the saved draft in both languages", async () => {
  for (const locale of ["en", "is"]) {
    const response = await call(preview.GET, "GET", `/api/v1/internal/communications/${one.id}/preview?locale=${locale}&format=html`, { params: { id: one.id } });
    assert.equal(response.status, 200);
    assert.ok(String(response.json).includes(`${tag} one`), `${locale}: the title is in the mail`);
  }
});

sqlTest("SQL campaign: the audience estimate counts members by preference, contacts by topic, the suppression list, safe mode, and leaves the test company out", async () => {
  const estimate = await call(audience.GET, "GET", `/api/v1/internal/communications/${one.id}/audience`, { params: { id: one.id } });
  assert.equal(estimate.status, 200, JSON.stringify(estimate.json));
  const b = estimate.json.item;
  // Members: admin (company A), ann (Off for the topic), ben, carl (suppressed by hand). Contacts: cio, and x@ (outside the safe-mode domains); blocked@ is not in it at all,
  // because the Manual suppression flagged that contact Unsubscribed, which takes it out of the audience before the list is looked at; ops@ has other topics.
  assert.deepEqual({ organizations: b.organizations, members: b.members, contacts: b.contacts, internal: b.internal, total: b.total, sendable: b.sendable }, { organizations: 2, members: 4, contacts: 2, internal: 0, total: 6, sendable: 3 });
  assert.deepEqual(b.suppressed, { PreferenceOff: 1, Manual: 1, SafeMode: 1 });
});

sqlTest("SQL campaign: a test mail is queued while the campaign is a Draft, the worker takes it as its own [TEST] batch, and it never counts in the stats", async () => {
  const queued = await call(testSend.POST, "POST", `/api/v1/internal/communications/${one.id}/test`, { params: { id: one.id }, key: true, body: { extraRecipients: [] } });
  assert.equal(queued.status, 200, JSON.stringify(queued.json));
  assert.deepEqual(queued.json, { queued: 1 });
  assert.deepEqual((await call(testSend.POST, "POST", `/api/v1/internal/communications/${one.id}/test`, { params: { id: one.id }, key: true })).json, { queued: 1 }, "a second test send queues the same row again (MERGE matched)");
  assert.equal((await deliveriesOf(one.id)).items.filter((d: { source: string }) => d.source === "Test").length, 1);
  const before = await acceptedToday();
  const run = await quiet(() => processCommunicationBatch(500, { transport: stubTransport() }));
  assert.equal(run.accepted, 1, JSON.stringify(run));
  assert.ok(calls.at(-1)!.subject.startsWith("[TEST]"), calls.at(-1)!.subject);
  assert.deepEqual(calls.at(-1)!.recipients, [people.admin.email]);
  assert.equal(calls.at(-1)!.sandbox, true);
  assert.equal(run.completed.length, 0, "a Draft is not completed by its test mail");
  assert.equal((await acceptedToday()) - before, 1);
  const row = (await deliveriesOf(one.id)).items.find((d: { source: string }) => d.source === "Test");
  assert.equal(row.state, "Accepted");
  assert.ok(row.providerMessageId && row.acceptedAt);
  assert.equal((await campaign(one.id)).stats.recipients, 0, "test rows are not counted");
});

sqlTest("SQL campaign: send under If-Match and an Idempotency-Key freezes the audience (6 rows: 3 queued, 3 suppressed with their reasons), audits it, and replays", async () => {
  one = await campaign(one.id);
  const key = freshKey();
  const sent = await call(send.POST, "POST", `/api/v1/internal/communications/${one.id}/send`, { params: { id: one.id }, headers: { "if-match": one.version, "idempotency-key": key } });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.equal(sent.json.item.status, "Sending");
  assert.equal(sent.json.item.recipientCount, 3);
  assert.equal((await call(send.POST, "POST", `/api/v1/internal/communications/${one.id}/send`, { params: { id: one.id }, headers: { "if-match": one.version, "idempotency-key": key } })).status, 200);
  const rows = (await deliveriesOf(one.id)).items.filter((d: { source: string }) => d.source !== "Test");
  assert.equal(rows.length, 6, "the replay did not freeze the audience twice");
  const shape: Record<string, number> = {};
  for (const d of rows) shape[`${d.state}${d.suppressedReason ? `/${d.suppressedReason}` : ""}`] = (shape[`${d.state}${d.suppressedReason ? `/${d.suppressedReason}` : ""}`] || 0) + 1;
  assert.deepEqual(shape, { Queued: 3, "Suppressed/Manual": 1, "Suppressed/PreferenceOff": 1, "Suppressed/SafeMode": 1 });
  const stats = (await campaign(one.id)).stats;
  assert.deepEqual({ recipients: stats.recipients, queued: stats.queued, suppressed: stats.suppressed }, { recipients: 3, queued: 3, suppressed: 3 });
  assert.equal((await q("SELECT COUNT(*) n FROM dbo.AuditEvents WHERE action='communication.sent' AND actor_user_id=@admin", { admin: people.admin.id }))[0].n, 1);
  const second = await call(send.POST, "POST", `/api/v1/internal/communications/${one.id}/send`, { params: { id: one.id }, headers: { "if-match": one.version }, key: true });
  assert.ok([412, 400].includes(second.status), `a second send is refused: ${second.status} ${JSON.stringify(second.json)}`);
});

sqlTest("SQL worker: one batch per language (the claim with READPAST and OUTPUT), the rows are Accepted with the message id, and the campaign completes as Sent", async () => {
  const first = calls.length;
  const before = await acceptedToday();
  const run = await quiet(() => processCommunicationBatch(500, { transport: stubTransport() }));
  assert.equal(run.accepted, 3, JSON.stringify(run));
  assert.deepEqual(run.completed, [one.id]);
  const batches = calls.slice(first);
  assert.equal(batches.length, 2);
  // which language goes first is not defined: the rows of one send share a created_at, and the claim takes the oldest
  assert.deepEqual(batches.map((b) => b.recipients.slice().sort()).sort((x, y) => x.length - y.length), [[people.admin.email], [people.ben.email, `cio@${domain}`].sort()]);
  assert.ok(!batches.some((b) => b.subject.startsWith("[TEST]")));
  const rows = (await deliveriesOf(one.id)).items.filter((d: { source: string; state: string }) => d.source !== "Test" && d.state !== "Suppressed");
  assert.ok(rows.every((d: { state: string; providerMessageId: string; acceptedAt: string; attemptCount: number }) => d.state === "Accepted" && d.providerMessageId && d.acceptedAt && d.attemptCount === 1), JSON.stringify(rows));
  one = await campaign(one.id);
  assert.equal(one.status, "Sent");
  assert.ok(one.completedAt);
  assert.equal((await acceptedToday()) - before, 3);
});

sqlTest("SQL events: delivered, open, click, bounce (suppresses and flags the contact), a repeat, a late deferral, a match by message id, unsubscribe and resubscribe", async () => {
  const rows = (await deliveriesOf(one.id)).items.filter((d: { source: string; state: string }) => d.source !== "Test" && d.state !== "Suppressed");
  const byEmail: Record<string, { id: string; providerMessageId: string }> = Object.fromEntries(rows.map((d: { email: string }) => [d.email, d]));
  const t = Math.floor(Date.now() / 1000);
  const delivery = (email: string) => byEmail[email].id;
  const outcome = await applyEvents([
    { sg_event_id: `${tag}-evt-1`, event: "delivered", email: people.admin.email, timestamp: t, deliveryId: delivery(people.admin.email) },
    { sg_event_id: `${tag}-evt-2`, event: "open", email: people.ben.email, timestamp: t + 1, deliveryId: delivery(people.ben.email) },
    { sg_event_id: `${tag}-evt-3`, event: "click", email: people.ben.email, timestamp: t + 2, deliveryId: delivery(people.ben.email) },
    { sg_event_id: `${tag}-evt-4`, event: "bounce", type: "bounce", reason: "550 no such user", email: `cio@${domain}`, timestamp: t + 3, deliveryId: delivery(`cio@${domain}`) },
    { sg_event_id: `${tag}-evt-1`, event: "delivered", email: people.admin.email, timestamp: t, deliveryId: delivery(people.admin.email) },
    { sg_event_id: `${tag}-evt-5`, event: "deferred", email: people.admin.email, timestamp: t + 4, deliveryId: delivery(people.admin.email) },
    { sg_event_id: `${tag}-evt-6`, event: "processed", email: people.ben.email, timestamp: t + 5, sg_message_id: `${byEmail[people.ben.email].providerMessageId}.filter0001.1234` },
    { sg_event_id: `${tag}-evt-7`, event: "group_unsubscribe", email: people.ann.email, timestamp: t + 6 },
    { sg_event_id: `${tag}-evt-8`, event: "group_resubscribe", email: people.ann.email, timestamp: t + 7 },
    { sg_event_id: `${tag}-evt-9`, event: "delivered", email: `nobody@${domain}`, timestamp: t + 8, deliveryId: randomUUID() },
  ]);
  // applied: delivered, open, click, bounce, the late deferral (it still records its last_event), the match by message id, unsubscribe, resubscribe.
  // ignored: the repeat of evt-1 and the event for a delivery that does not exist.
  assert.deepEqual(outcome, { applied: 8, ignored: 2 });
  const after: Record<string, any> = Object.fromEntries((await deliveriesOf(one.id)).items.filter((d: { source: string }) => d.source !== "Test").map((d: { email: string }) => [d.email, d])); // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(after[people.admin.email].state, "Delivered");
  assert.equal(after[people.admin.email].lastEvent, "deferred", "the late deferral is the last event but does not move the state back");
  assert.ok(after[people.ben.email].openedAt && after[people.ben.email].clickedAt);
  assert.equal(after[people.ben.email].state, "Accepted");
  assert.equal(after[people.ben.email].lastEvent, "processed", "matched by the message id prefix and the address");
  assert.equal(after[`cio@${domain}`].state, "Bounced");
  assert.equal((await loadSuppressionMap()).get(`cio@${domain}`), "Bounced");
  assert.equal((await listContacts(identityOf(people.admin), ORG.a)).find((c) => c.email === `cio@${domain}`)!.status, "Bounced", "the contact with the bounced address is flagged");
  assert.equal((await loadSuppressionMap()).has(people.ann.email), false, "unsubscribe, then resubscribe, leaves no suppression");
  assert.equal((await q("SELECT COUNT(*) n FROM dbo.CommunicationEvents WHERE sg_event_id LIKE @pattern", { pattern: `${tag}-evt-%` }))[0].n, 9, "every distinct event id is in the ledger once");
  const stats = (await campaign(one.id)).stats;
  assert.deepEqual({ delivered: stats.delivered, bounced: stats.bounced, opened: stats.opened, clicked: stats.clicked }, { delivered: 1, bounced: 1, opened: 1, clicked: 1 });
});

sqlTest("SQL retention: a ledger row older than 90 days is purged by the retention batch and a recent one stays", async (t) => {
  // The real batch runs: it hard-deletes everything that is due in the whole database (and deletes the blobs of attachments), which is why this suite
  // belongs on a disposable database, and why this case is not run where there is an attachment to touch.
  if ((await q("SELECT COUNT(*) n FROM dbo.Attachments"))[0].n > 0) return t.skip("the database holds attachments, and the retention batch would delete their blobs");
  await q("UPDATE dbo.CommunicationEvents SET received_at=DATEADD(day,-100,SYSUTCDATETIME()) WHERE sg_event_id IN (@a,@b)", { a: `${tag}-evt-1`, b: `${tag}-evt-2` });
  const present = async (ids: string[]) =>
    (await q("SELECT sg_event_id id FROM dbo.CommunicationEvents WHERE sg_event_id IN (SELECT value FROM OPENJSON(@ids))", { ids: JSON.stringify(ids) })).map((r) => r.id as string);
  const old = [1, 2].map((n) => `${tag}-evt-${n}`);
  const recent = [3, 4, 5, 6, 7, 8, 9].map((n) => `${tag}-evt-${n}`);
  // A batch takes at most 250 rows, and other rows that are due may come first: go on until the suite's own two are gone (a bounded number of rounds).
  for (let round = 0; round < 50 && (await present(old)).length > 0; round++) assert.equal((await processRetentionBatch(250)).skipped, false);
  assert.deepEqual(await present(old), [], "the two ledger rows older than 90 days are gone");
  assert.deepEqual((await present(recent)).sort(), recent, "the recent ones stay");
});

sqlTest("SQL campaign: a copy of a Sent campaign is a new Draft; only a Draft or a Cancelled campaign can be deleted (soft), and then it is gone from the list", async () => {
  const copy = await call(duplicate.POST, "POST", `/api/v1/internal/communications/${one.id}/duplicate`, { params: { id: one.id }, key: true });
  assert.equal(copy.status, 201, JSON.stringify(copy.json));
  assert.equal(copy.json.item.status, "Draft");
  assert.equal(copy.json.item.title, `${tag} one (copy)`);
  assert.equal((await call(communication.DELETE, "DELETE", `/api/v1/internal/communications/${one.id}`, { params: { id: one.id } })).status, 400, "a Sent campaign cannot be deleted");
  assert.equal((await call(communication.DELETE, "DELETE", `/api/v1/internal/communications/${copy.json.item.id}`, { params: { id: copy.json.item.id } })).status, 200);
  assert.ok(!(await call(communications.GET, "GET", "/api/v1/internal/communications")).json.items.some((c: { id: string }) => c.id === copy.json.item.id));
  assert.equal((await call(communication.GET, "GET", `/api/v1/internal/communications/${copy.json.item.id}`, { params: { id: copy.json.item.id } })).status, 404);
});

// ---- campaign two: dead letter, retry, a failure worth retrying, lease recovery ------------------------------------------------------------
sqlTest("SQL worker: when the provider refuses the only recipient (422) the row is a dead letter at once, and the campaign completes as Sent", async () => {
  const created = await call(communications.POST, "POST", "/api/v1/internal/communications", {
    key: true,
    body: {
      templateKey: "service-notice", topic: "service-notices", title: `${tag} two`,
      content: { subject: { en: "Planned work" }, body: { en: { title: "Planned work", summary: "We will update the service.", actions: ["Nothing to do"] } } },
      audience: { ...spec, organizations: [ORG.b], memberRoles: ["Company admin"], includeContacts: false },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  two = created.json.item;
  const sent = await call(send.POST, "POST", `/api/v1/internal/communications/${two.id}/send`, { params: { id: two.id }, headers: { "if-match": two.version }, key: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.equal(sent.json.item.recipientCount, 1);
  const run = await quiet(() => processCommunicationBatch(500, { transport: stubTransport(() => { throw new SendError("HTTP_422", false); }) }));
  assert.equal(run.deadLettered, 1, JSON.stringify(run));
  assert.deepEqual(run.completed, [two.id]);
  const row = (await deliveriesOf(two.id)).items[0];
  assert.deepEqual([row.state, row.lastErrorCode], ["Dead letter", "HTTP_422"]);
  assert.equal((await campaign(two.id)).stats.deadLettered, 1);
});

sqlTest("SQL retry: dead letters are queued again (idempotent) and the Sent campaign is Sending again, with its audit row", async () => {
  const retried = await call(retry.POST, "POST", `/api/v1/internal/communications/${two.id}/deliveries/retry`, { params: { id: two.id }, key: true });
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  assert.deepEqual(retried.json, { requeued: 1, reopened: true });
  const item = await campaign(two.id);
  assert.equal(item.status, "Sending");
  assert.equal(item.completedAt, undefined);
  const row = (await deliveriesOf(two.id)).items[0];
  assert.deepEqual([row.state, row.attemptCount, row.lastErrorCode], ["Queued", 0, null]);
  assert.equal((await q("SELECT COUNT(*) n FROM dbo.AuditEvents WHERE action='communication.deliveries.retried' AND actor_user_id=@admin", { admin: people.admin.id }))[0].n, 1);
});

sqlTest("SQL worker: a failure worth retrying (503) leaves the row in Retry with a next attempt in the future, and it is not claimed before then", async () => {
  const run = await quiet(() => processCommunicationBatch(500, { transport: stubTransport(() => { throw new SendError("HTTP_503", true); }) }));
  assert.equal(run.retried, 1, JSON.stringify(run));
  assert.deepEqual(run.completed, [], "a campaign with a row in Retry is not complete");
  const row = (await deliveriesOf(two.id)).items[0];
  assert.deepEqual([row.state, row.attemptCount], ["Retry", 1]);
  assert.ok(row.nextAttemptAt && new Date(row.nextAttemptAt) > new Date(), row.nextAttemptAt);
  assert.equal((await quiet(() => processCommunicationBatch(500, { transport: stubTransport() }))).accepted, 0, "the row is not due yet");
});

sqlTest("SQL lease: a claimed row whose lease ran out goes back to Retry (by the database's clock), and the next run sends it and completes the campaign", async () => {
  await q("UPDATE dbo.CommunicationDeliveries SET next_attempt_at=NULL WHERE communication_id=(SELECT id FROM dbo.Communications WHERE public_id=@id)", { id: two.id });
  const claimed = await getDeliveryStore().claimBatch(10);
  assert.ok(claimed && claimed.communicationId === two.id && claimed.deliveries.length === 1, JSON.stringify(claimed));
  assert.equal(claimed.deliveries[0].attemptCount, 2);
  let row = (await deliveriesOf(two.id)).items[0];
  assert.equal(row.state, "Processing");
  assert.ok(new Date(row.nextAttemptAt) > new Date(Date.now() + 10 * 60_000), "the lease is about 15 minutes");
  assert.equal(await getDeliveryStore().recoverStale(new Date()), 0, "a live lease is left alone");
  await q("UPDATE dbo.CommunicationDeliveries SET next_attempt_at=DATEADD(minute,-1,SYSUTCDATETIME()) WHERE id=@id", { id: claimed.deliveries[0].id });
  assert.equal(await getDeliveryStore().recoverStale(new Date()), 1);
  row = (await deliveriesOf(two.id)).items[0];
  assert.deepEqual([row.state, row.attemptCount, row.nextAttemptAt], ["Retry", 2, null]);
  const run = await quiet(() => processCommunicationBatch(500, { transport: stubTransport() }));
  assert.equal(run.accepted, 1, JSON.stringify(run));
  assert.deepEqual(run.completed, [two.id]);
  assert.equal((await campaign(two.id)).status, "Sent");
});

sqlTest("SQL lease: one that ran out on the last attempt is a dead letter (LEASE_EXPIRED), and a cancelled campaign's real row is cancelled instead; nothing is requeued into a cancelled campaign", async () => {
  await q("UPDATE dbo.CommunicationDeliveries SET state='Processing',attempt_count=5,next_attempt_at=DATEADD(minute,-1,SYSUTCDATETIME()) WHERE communication_id=(SELECT id FROM dbo.Communications WHERE public_id=@id)", { id: two.id });
  assert.equal(await getDeliveryStore().recoverStale(new Date()), 1);
  let row = (await deliveriesOf(two.id)).items[0];
  assert.deepEqual([row.state, row.lastErrorCode], ["Dead letter", "LEASE_EXPIRED"]);
  await q("UPDATE dbo.CommunicationDeliveries SET state='Processing',attempt_count=1,next_attempt_at=DATEADD(minute,-1,SYSUTCDATETIME()) WHERE communication_id=(SELECT id FROM dbo.Communications WHERE public_id=@id)", { id: two.id });
  await q("UPDATE dbo.Communications SET status='Cancelled' WHERE public_id=@id", { id: two.id });
  assert.equal(await getDeliveryStore().recoverStale(new Date()), 1);
  row = (await deliveriesOf(two.id)).items[0];
  assert.equal(row.state, "Cancelled");
  assert.equal((await call(retry.POST, "POST", `/api/v1/internal/communications/${two.id}/deliveries/retry`, { params: { id: two.id }, key: true })).status, 400);
});

// ---- campaign three: schedule, unschedule, promote, cancel ------------------------------------------------------------------------------
sqlTest("SQL schedule: Scheduled with a time and no delivery rows, unschedule gives a Draft back, schedule again, and less than a minute ahead is refused", async () => {
  three = (await call(communications.POST, "POST", "/api/v1/internal/communications", { key: true, body: draftBody(`${tag} three`) })).json.item;
  const at = new Date(Date.now() + 3 * 60_000).toISOString();
  const scheduled = await call(send.POST, "POST", `/api/v1/internal/communications/${three.id}/send`, { params: { id: three.id }, headers: { "if-match": three.version }, key: true, body: { scheduledAt: at } });
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.json));
  assert.equal(scheduled.json.item.status, "Scheduled");
  assert.equal(new Date(scheduled.json.item.scheduledAt).toISOString(), at);
  assert.equal((await deliveriesOf(three.id)).total, 0, "a scheduled campaign has no recipients yet");
  const unscheduled = await call(cancel.POST, "POST", `/api/v1/internal/communications/${three.id}/cancel`, { params: { id: three.id }, headers: { "if-match": scheduled.json.item.version }, body: { mode: "unschedule" } });
  assert.equal(unscheduled.status, 200, JSON.stringify(unscheduled.json));
  assert.equal(unscheduled.json.item.status, "Draft");
  assert.equal(unscheduled.json.item.scheduledAt, undefined);
  const again = await call(send.POST, "POST", `/api/v1/internal/communications/${three.id}/send`, { params: { id: three.id }, headers: { "if-match": unscheduled.json.item.version }, key: true, body: { scheduledAt: at } });
  assert.equal(again.json.item.status, "Scheduled");
  const early = await call(send.POST, "POST", `/api/v1/internal/communications/${three.id}/send`, { params: { id: three.id }, headers: { "if-match": again.json.item.version }, key: true, body: { scheduledAt: new Date(Date.now() + 5_000).toISOString() } });
  assert.deepEqual([early.status, early.json.error.code], [400, "INVALID_SCHEDULE_TIME"]);
});

sqlTest("SQL promote: the worker's promotion freezes only a campaign whose time has come (checked under the lock), and then it is Sending with its rows", async () => {
  const store = getDeliveryStore();
  assert.deepEqual(await store.promoteScheduled(new Date()), [], "not due yet");
  assert.deepEqual(await store.promoteScheduled(new Date(Date.now() + 10 * 60_000)), [three.id]);
  const item = await campaign(three.id);
  assert.equal(item.status, "Sending");
  // cio's address bounced in campaign one, so that contact is out of this audience: admin and ben go out; ann (Off), carl (Manual) and x@ (safe mode) are rows that never go.
  assert.equal(item.recipientCount, 2);
  assert.equal(item.scheduledAt, undefined);
  assert.equal((await deliveriesOf(three.id)).total, 5);
});

sqlTest("SQL cancel: the waiting rows are Cancelled with the campaign, a cancelled campaign is not sent, and it can be deleted (soft)", async () => {
  const item = await campaign(three.id);
  const cancelled = await call(cancel.POST, "POST", `/api/v1/internal/communications/${three.id}/cancel`, { params: { id: three.id }, headers: { "if-match": item.version } });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  assert.equal(cancelled.json.item.status, "Cancelled");
  const rows = (await deliveriesOf(three.id)).items;
  assert.equal(rows.filter((d: { state: string }) => d.state === "Cancelled").length, 2);
  assert.equal(rows.filter((d: { state: string }) => d.state === "Suppressed").length, 3);
  assert.equal((await campaign(three.id)).stats.cancelled, 2);
  const run = await quiet(() => processCommunicationBatch(500, { transport: stubTransport(() => { throw new Error("a cancelled campaign must not be sent"); }) }));
  assert.equal(run.accepted + run.retried + run.deadLettered, 0);
  assert.equal((await call(communication.DELETE, "DELETE", `/api/v1/internal/communications/${three.id}`, { params: { id: three.id } })).status, 200);
});

// ---- the last campaigns: the list and safe mode at the claim, the unsubscribe group, what keeps a cancelled campaign, the message-id match ------------
const SETTINGS_URL = "/api/v1/admin/communications/settings";
/** The saved settings with `over` laid on top, saved through the route as the System admin. */
const saveSettings = async (over: Record<string, unknown>) => {
  const current = (await call(settings.GET, "GET", SETTINGS_URL)).json.item;
  return call(settings.PATCH, "PATCH", SETTINGS_URL, { body: { ...current, ...over } });
};
/** A security notice (plain template) to the contacts of one company who have asked for that topic; the suite's other audiences do not have it. */
const noticeBody = (title: string, org: string) => ({
  templateKey: "plain", topic: "security-advisories", title,
  content: { subject: { en: `${title} subject` }, body: { en: { title, paragraphs: ["Please read this notice."] } } },
  audience: { organizations: [org], includeOnboarding: false, includeTestOrganizations: false, includeMembers: false, memberRoles: null, includeContacts: true, includeInternalCopy: false },
});
const sendNotice = async (title: string, org: string) => {
  const created = await call(communications.POST, "POST", "/api/v1/internal/communications", { key: true, body: noticeBody(title, org) });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const sent = await call(send.POST, "POST", `/api/v1/internal/communications/${created.json.item.id}/send`, { params: { id: created.json.item.id }, headers: { "if-match": created.json.item.version }, key: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  return sent.json.item;
};
const rowsByEmail = async (id: string) => Object.fromEntries((await deliveriesOf(id)).items.filter((d: { source: string }) => d.source !== "Test").map((d: { email: string }) => [d.email, d])) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

sqlTest("SQL settings: sending cannot go live without an unsubscribe group — 400 with its own code and nothing saved — and the audience estimate tells the staff the sending state", async () => {
  const before = (await call(settings.GET, "GET", SETTINGS_URL)).json.item;
  const refused = await saveSettings({ enabled: true, fromEmail: `updates@${domain}`, sandboxMode: false, unsubscribeGroupId: null, safeMode: { enabled: false, allowedDomains: [] } });
  assert.deepEqual([refused.status, refused.json.error.code], [400, "INVALID_UNSUBSCRIBE_GROUP_REQUIRED"], JSON.stringify(refused.json));
  assert.deepEqual((await call(settings.GET, "GET", SETTINGS_URL)).json.item, before, "nothing was saved");
  const saved = await saveSettings({ enabled: true, fromEmail: `updates@${domain}`, sandboxMode: false, unsubscribeGroupId: 42, safeMode: { enabled: false, allowedDomains: [] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.status.effectiveSendingState, "live");
  const estimate = await call(audience.GET, "GET", `/api/v1/internal/communications/${one.id}/audience`, { params: { id: one.id } });
  assert.equal(estimate.status, 200, JSON.stringify(estimate.json));
  assert.equal(estimate.json.effectiveSendingState, "live", "the state travels with the counts");
  assert.ok(estimate.json.item && typeof estimate.json.item.sendable === "number");
  assert.equal((await call(audience.GET, "GET", `/api/v1/internal/communications/${one.id}/audience`, { as: people.ann, params: { id: one.id } })).status, 404, "a customer is refused, state and all");
});

sqlTest("SQL claim: an address suppressed after the freeze, and safe mode switched on after it, settle the waiting rows as Suppressed instead of being claimed — a requeued dead letter of a suppressed address included", async () => {
  const admin = identityOf(people.admin);
  const who = { stays: `k-stays@${domain}`, unsub: `k-unsub@${domain}`, outside: `k-outside@${otherDomain}`, dead: `k-dead@${domain}` };
  for (const email of Object.values(who)) await saveContact(admin, { organizationId: ORG.a, email, displayName: email.split("@")[0], locale: "en", topics: ["security-advisories"] });
  const frozen = await sendNotice(`${tag} four`, ORG.a); // sending is live with safe mode off: all four go into the audience
  assert.equal(frozen.recipientCount, 4);
  const rows = await rowsByEmail(frozen.id);
  assert.deepEqual(Object.values(rows).map((d: { state: string }) => d.state), ["Queued", "Queued", "Queued", "Queued"]);
  // One of them was dead-lettered by an earlier run; then, after the freeze, two addresses unsubscribe or report us, and safe mode is switched on.
  await q("UPDATE dbo.CommunicationDeliveries SET state='Dead letter',attempt_count=5,last_error_code='HTTP_422' WHERE id=@id", { id: rows[who.dead].id });
  await suppressAddress(who.unsub, "Unsubscribed", "Webhook");
  await suppressAddress(who.dead, "SpamReport", "Webhook");
  assert.equal((await saveSettings({ safeMode: { enabled: true, allowedDomains: [domain] } })).status, 200);
  const retried = await call(retry.POST, "POST", `/api/v1/internal/communications/${frozen.id}/deliveries/retry`, { params: { id: frozen.id }, key: true });
  assert.deepEqual(retried.json, { requeued: 1, reopened: false }, JSON.stringify(retried.json));
  const first = calls.length;
  const run = await quiet(() => processCommunicationBatch(500, { transport: stubTransport() }));
  assert.equal(run.accepted, 1, JSON.stringify(run));
  assert.deepEqual(run.completed, [frozen.id], "the settled rows count as done: the campaign completes in the same run");
  assert.deepEqual(calls.slice(first).flatMap((c) => c.recipients), [who.stays], "only the address that is still allowed reached the transport");
  const after = await rowsByEmail(frozen.id);
  const shape = (email: string) => [after[email].state, after[email].suppressedReason ?? null, after[email].attemptCount, after[email].nextAttemptAt ?? null];
  assert.deepEqual(shape(who.stays), ["Accepted", null, 1, null]);
  assert.deepEqual(shape(who.unsub), ["Suppressed", "Unsubscribed", 0, null], "on the list since the freeze: settled with the list's reason");
  assert.deepEqual(shape(who.dead), ["Suppressed", "SpamReport", 0, null], "the retry requeued it, the claim settled it before any attempt");
  assert.deepEqual(shape(who.outside), ["Suppressed", "SafeMode", 0, null], "outside the allow-list that came after the freeze");
  const stats = (await campaign(frozen.id)).stats;
  assert.deepEqual({ recipients: stats.recipients, accepted: stats.accepted, suppressed: stats.suppressed }, { recipients: 1, accepted: 1, suppressed: 3 });
  assert.equal((await campaign(frozen.id)).status, "Sent");
});

sqlTest("SQL campaign: a cancelled campaign that mailed anyone is kept, one that mailed nobody is deleted; an event is matched to its row by the exact start of the message id, an underscore included", async () => {
  const admin = identityOf(people.admin);
  const [a, b] = [`k-a@${domain}`, `k-b@${domain}`];
  for (const email of [a, b]) await saveContact(admin, { organizationId: ORG.b, email, displayName: email.split("@")[0], locale: "en", topics: ["security-advisories"] });
  const five = await sendNotice(`${tag} five`, ORG.b);
  assert.equal(five.recipientCount, 2);
  // The worker takes one row of the two; the provider's message id has underscores, as a base64url id does.
  const messageId = `${tag}_ab_cd`;
  const run = await quiet(() => processCommunicationBatch(1, { transport: stubTransport(() => ({ providerMessageId: messageId })) }));
  assert.equal(run.accepted, 1, JSON.stringify(run));
  const accepted = Object.values(await rowsByEmail(five.id)).find((d: { state: string }) => d.state === "Accepted") as { id: string; email: string };
  assert.ok(accepted, "one row was accepted");
  const t = Math.floor(Date.now() / 1000);
  const outcome = await applyEvents([
    // Differs from the stored id only where it has an underscore: LIKE would read that underscore as a wildcard and match the row; the exact start does not.
    { sg_event_id: `${tag}-msg-1`, event: "delivered", email: accepted.email, timestamp: t, sg_message_id: `${tag}_abXcd.filter0001.1.1.0` },
    { sg_event_id: `${tag}-msg-2`, event: "delivered", email: accepted.email, timestamp: t + 1, sg_message_id: `${messageId}.filter0001.1.1.0` },
  ]);
  assert.deepEqual(outcome, { applied: 1, ignored: 1 }, "the id with another character where the underscore is matches nothing; the real one matches");
  assert.equal((await rowsByEmail(five.id))[accepted.email].lastEventAt !== null, true);
  assert.equal((await rowsByEmail(five.id))[accepted.email].state, "Delivered");
  // Cancelled with one row Delivered and the other Cancelled: it mailed somebody, so it stays.
  const item = await campaign(five.id);
  const cancelled = await call(cancel.POST, "POST", `/api/v1/internal/communications/${five.id}/cancel`, { params: { id: five.id }, headers: { "if-match": item.version } });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  assert.deepEqual(Object.values(await rowsByEmail(five.id)).map((d: { state: string }) => d.state).sort(), ["Cancelled", "Delivered"]);
  const refused = await call(communication.DELETE, "DELETE", `/api/v1/internal/communications/${five.id}`, { params: { id: five.id } });
  assert.deepEqual([refused.status, refused.json.error.code], [400, "INVALID_COMMUNICATION_NOT_DELETABLE"], JSON.stringify(refused.json));
  assert.equal((await call(communication.GET, "GET", `/api/v1/internal/communications/${five.id}`, { params: { id: five.id } })).status, 200, "it is still there, with the record of who was mailed");
  // Cancelled before anything went out: nothing to keep.
  const six = await sendNotice(`${tag} six`, ORG.b);
  const cancelledSix = await call(cancel.POST, "POST", `/api/v1/internal/communications/${six.id}/cancel`, { params: { id: six.id }, headers: { "if-match": six.version } });
  assert.equal(cancelledSix.status, 200, JSON.stringify(cancelledSix.json));
  assert.equal((await call(communication.DELETE, "DELETE", `/api/v1/internal/communications/${six.id}`, { params: { id: six.id } })).status, 200);
  assert.equal((await call(communication.GET, "GET", `/api/v1/internal/communications/${six.id}`, { params: { id: six.id } })).status, 404);
});

// ---- the audit trail --------------------------------------------------------------------------------------------------------------------
sqlTest("SQL audit: the writes of the feature have their audit rows, and none of them carries a customer's address", async () => {
  const rows = await q(
    `SELECT action,COALESCE(after_json,'') after_json,COALESCE(before_json,'') before_json FROM dbo.AuditEvents
     WHERE (action LIKE 'communication%' OR action LIKE 'notification.preference%') AND actor_user_id IN (SELECT TRY_CONVERT(uniqueidentifier,value) FROM OPENJSON(@users))`,
    { users: JSON.stringify(userIds) },
  );
  const actions = new Set(rows.map((r) => r.action));
  for (const expected of [
    "communication.created", "communication.updated", "communication.sent", "communication.scheduled", "communication.unscheduled", "communication.cancelled",
    "communication.deleted", "communication.duplicated", "communication.test-sent", "communication.deliveries.retried", "communication.contact.saved",
    "communication.contact.removed", "communication.suppression.added", "notification.preference.updated",
  ])
    assert.ok(actions.has(expected), `an audit row for ${expected}`);
  // The settings audit names the sender, which is configuration and not a customer's address.
  const withAddress = rows.filter((r) => /@/.test(r.after_json) || /@/.test(r.before_json)).map((r) => r.action as string);
  assert.deepEqual([...new Set(withAddress)].filter((action) => !action.startsWith("communication.settings")), []);
});

// ---- what a refusal leaves behind ------------------------------------------------------------------------------------------------------
sqlTest("SQL suite: on a database with a communication in flight the setup refuses, and the cleanup after the refusal leaves the live settings and every other row alone", async () => {
  // A second scope, which `before` never saw. The main one has made the database ready, so the live settings row exists (the cases above saved it) and nothing is in flight.
  const probe = makeScope();
  const live = () => q("SELECT value_json,version,updated_by_user_id,updated_at FROM dbo.Settings WHERE setting_key='communications'");
  const shelf = await live();
  assert.equal(shelf.length, 1, "the live settings row, which the refusal must not touch");
  await assertIdle(); // idle, so what refuses below is the campaign added here and nothing else
  const inFlight = randomUUID();
  await q(
    `INSERT dbo.Communications(id,public_id,template_key,topic,title,content_json,audience_json,status,created_by_user_id,updated_by_user_id)
     VALUES(@id,@publicId,'plain','general',@title,'{}','{}','Sending',@admin,@admin)`,
    { id: inFlight, publicId: `COM-9${Date.now()}`, title: `${tag} in flight`, admin: people.admin.id },
  );
  try {
    await assert.rejects(prepare(probe), /in flight/);
    assert.equal(probe.prepared, false, "the refusal came before anything was touched");
    await cleanup(probe); // what `after` does with a scope that was refused
    assert.deepEqual(await live(), shelf, "the live settings row is untouched, with its version and time");
    assert.equal((await q("SELECT COUNT(*) n FROM dbo.Communications WHERE id=@id", { id: inFlight }))[0].n, 1, "so is the campaign that caused the refusal");
    assert.equal((await q("SELECT COUNT(*) n FROM dbo.Organizations WHERE id IN (@a,@b)", { a: probe.ORG.a, b: probe.ORG.b }))[0].n, 0, "and no company was made");
  } finally {
    await q("DELETE dbo.Communications WHERE id=@id", { id: inFlight });
    await cleanup(probe); // a no-op unless the refusal failed, and then it puts right what the setup did
  }
});
