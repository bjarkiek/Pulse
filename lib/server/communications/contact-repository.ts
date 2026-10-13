import { communicationContactInputSchema, companyContactInputSchema, communicationContactImportSchema } from "@/lib/contracts";
import type { PulseIdentity } from "@/lib/domain";
import { organizations, users } from "../admin-repository";
import { requireInternalRole, requireMembership, requirePublishRole } from "../authorization";
import { beginSqlTransaction, getSqlPool, isAzureSqlConfigured, sql } from "../database";
import { emailSchema, parseInput } from "../validation";
import { memoryAuditEvent, memoryContacts } from "./memory";
import type { CommunicationTopic, ContactRecord, ContactSource } from "./types";

export type ContactInput = {
  id?: string;
  organizationId: string;
  email: string;
  displayName: string;
  locale: "en" | "is";
  topics: CommunicationTopic[];
  note?: string;
};

const SELECT = `SELECT CAST(c.id AS nvarchar(36)) id,c.organization_id organizationId,CAST(c.user_id AS nvarchar(36)) userId,c.email,c.display_name displayName,c.locale,c.topics_json topicsJson,c.status,c.source,c.note,CONVERT(nvarchar(33),c.created_at,127) createdAt,CONVERT(nvarchar(33),c.updated_at,127) updatedAt FROM dbo.CommunicationContacts c`;
/**
 * A contact links to a Pulse user only through a membership of the contact's own organisation. The link comes back to the
 * Company admin in `userId`, so a tenant-agnostic lookup would tell them which addresses are Pulse users elsewhere.
 * Memory mode (`memberUserId`) and SQL (`MEMBER_LOOKUP`) apply the same rule, on create and on every edit.
 */
const MEMBER_LOOKUP = "(SELECT TOP(1) u.id FROM dbo.Users u JOIN dbo.Memberships m ON m.user_id=u.id AND m.organization_id=@org AND m.status='Active' WHERE u.email=@email)";
function memberUserId(organizationId: string, email: string) {
  return users().find((u) => u.email.toLowerCase() === email && u.memberships.some((m) => m.companyId === organizationId))?.id ?? null;
}
function fromRow(row: Record<string, unknown>): ContactRecord {
  return {
    id: String(row.id), organizationId: String(row.organizationId), userId: (row.userId as string) || null,
    email: String(row.email), displayName: String(row.displayName), locale: row.locale === "is" ? "is" : "en",
    topics: JSON.parse(String(row.topicsJson || "[]")), status: row.status as ContactRecord["status"],
    source: row.source as ContactSource, note: (row.note as string) || undefined,
    createdAt: String(row.createdAt), updatedAt: String(row.updatedAt),
  };
}

/** `rowLines[i]` is the 1-based line of `rows[i]` in the pasted text; `errors` lists the 1-based lines that were skipped. */
export function parseContactLines(text: string) {
  const rows: Array<{ displayName: string; email: string }> = [];
  const rowLines: number[] = [];
  const errors: number[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    if (rows.length >= 250) return;
    const parts = line.split(/[,;\t]/).map((p) => p.trim()).filter(Boolean);
    const email = (parts.length > 1 ? parts[parts.length - 1] : parts[0] || "").toLowerCase();
    const name = parts.length > 1 ? parts.slice(0, -1).join(" ") : email.split("@")[0];
    // Same address rules as the contact schema, so a row accepted here can never fail validation when it is saved.
    const valid = emailSchema.safeParse(email).success && name.length <= 200;
    if (!valid || seen.has(email)) { errors.push(index + 1); return; }
    seen.add(email);
    rows.push({ displayName: name, email });
    rowLines.push(index + 1);
  });
  return { rows, rowLines, errors };
}

async function assertOrganizationExists(organizationId: string) {
  if (!isAzureSqlConfigured()) {
    if (!organizations().some((o) => o.id === organizationId && o.status !== "Inactive")) throw new Error("NOT_FOUND");
    return;
  }
  const result = await (await getSqlPool()).request().input("id", sql.NVarChar(32), organizationId)
    .query("SELECT 1 FROM dbo.Organizations WHERE id=@id AND status<>'Inactive'");
  if (!result.recordset.length) throw new Error("NOT_FOUND");
}

/** Shared write path; callers have already authorised and fixed organizationId. */
async function upsertContact(identity: PulseIdentity, input: ContactInput, source: ContactSource): Promise<ContactRecord> {
  const parsed = parseInput(communicationContactInputSchema, input);
  await assertOrganizationExists(parsed.organizationId);
  const now = new Date().toISOString();
  if (!isAzureSqlConfigured()) {
    const store = memoryContacts();
    const existing = parsed.id ? store.find((c) => c.id === parsed.id && c.organizationId === parsed.organizationId) : undefined;
    if (parsed.id && !existing) throw new Error("NOT_FOUND");
    if (store.some((c) => c.id !== existing?.id && c.organizationId === parsed.organizationId && c.email === parsed.email))
      throw new Error("INVALID_CONTACT_EXISTS");
    const record: ContactRecord = {
      id: existing?.id || crypto.randomUUID(), organizationId: parsed.organizationId, userId: memberUserId(parsed.organizationId, parsed.email),
      email: parsed.email, displayName: parsed.displayName, locale: parsed.locale, topics: [...new Set(parsed.topics)],
      status: existing?.status || "Active", source: existing?.source || source, note: parsed.note,
      createdAt: existing?.createdAt || now, updatedAt: now,
    };
    const before = existing && { topics: [...existing.topics] };
    if (existing) Object.assign(existing, record); else store.push(record);
    memoryAuditEvent(identity, "communication.contact.saved", "CommunicationContact", record.id, { organizationId: record.organizationId, topics: record.topics, source: record.source }, before);
    return structuredClone(record);
  }
  const pool = await getSqlPool();
  const scope = await beginSqlTransaction(pool);
  try {
    const id = parsed.id || crypto.randomUUID();
    const duplicate = await new sql.Request(scope.transaction)
      .input("org", sql.NVarChar(32), parsed.organizationId).input("email", sql.NVarChar(320), parsed.email).input("id", sql.UniqueIdentifier, id)
      .query("SELECT 1 FROM dbo.CommunicationContacts WITH (UPDLOCK,HOLDLOCK) WHERE organization_id=@org AND email=@email AND id<>@id AND deleted_at IS NULL");
    if (duplicate.recordset.length) throw new Error("INVALID_CONTACT_EXISTS");
    const result = await new sql.Request(scope.transaction)
      .input("id", sql.UniqueIdentifier, id).input("org", sql.NVarChar(32), parsed.organizationId)
      .input("email", sql.NVarChar(320), parsed.email).input("name", sql.NVarChar(200), parsed.displayName)
      .input("locale", sql.NVarChar(12), parsed.locale).input("topics", sql.NVarChar(sql.MAX), JSON.stringify([...new Set(parsed.topics)]))
      .input("source", sql.NVarChar(32), source).input("note", sql.NVarChar(500), parsed.note || null)
      .input("actor", sql.UniqueIdentifier, identity.id).input("create", sql.Bit, !parsed.id)
      // An edit must never insert: an id that is unknown, soft-deleted or owned by another organisation matches nothing and ends in NOT_FOUND.
      .query(`MERGE dbo.CommunicationContacts target USING(SELECT @id id,@org organization_id) source
        ON target.id=source.id AND target.organization_id=source.organization_id AND target.deleted_at IS NULL
        WHEN MATCHED THEN UPDATE SET email=@email,display_name=@name,locale=@locale,topics_json=@topics,note=@note,user_id=${MEMBER_LOOKUP},updated_at=SYSUTCDATETIME()
        WHEN NOT MATCHED AND @create=1 THEN INSERT(id,organization_id,user_id,email,display_name,locale,topics_json,source,note,created_by_user_id)
          VALUES(@id,@org,${MEMBER_LOOKUP},@email,@name,@locale,@topics,@source,@note,@actor)
        OUTPUT $action action;`);
    if (parsed.id && result.recordset[0]?.action !== "UPDATE") throw new Error("NOT_FOUND");
    await new sql.Request(scope.transaction)
      .input("auditId", sql.UniqueIdentifier, crypto.randomUUID()).input("actor", sql.UniqueIdentifier, identity.id)
      .input("org", sql.NVarChar(32), parsed.organizationId).input("entity", sql.UniqueIdentifier, id)
      .input("after", sql.NVarChar(sql.MAX), JSON.stringify({ topics: parsed.topics, source }))
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .query("INSERT dbo.AuditEvents(id,actor_user_id,organization_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@auditId,@actor,@org,'communication.contact.saved','CommunicationContact',@entity,@after,@correlation)");
    const saved = await new sql.Request(scope.transaction).input("id", sql.UniqueIdentifier, id).query(`${SELECT} WHERE c.id=@id`);
    await scope.commit();
    return fromRow(saved.recordset[0]);
  } catch (error) {
    await scope.rollback();
    throw error;
  }
}

async function softDelete(identity: PulseIdentity, contactId: string, organizationId: string | null) {
  if (!isAzureSqlConfigured()) {
    const store = memoryContacts();
    const index = store.findIndex((c) => c.id === contactId && (!organizationId || c.organizationId === organizationId));
    if (index < 0) throw new Error("NOT_FOUND");
    const [removed] = store.splice(index, 1);
    memoryAuditEvent(identity, "communication.contact.removed", "CommunicationContact", removed.id, { organizationId: removed.organizationId });
    return;
  }
  const pool = await getSqlPool();
  const result = await pool.request().input("id", sql.UniqueIdentifier, contactId).input("org", sql.NVarChar(32), organizationId)
    .query("UPDATE dbo.CommunicationContacts SET deleted_at=SYSUTCDATETIME(),updated_at=SYSUTCDATETIME() OUTPUT INSERTED.organization_id organizationId WHERE id=@id AND deleted_at IS NULL AND (@org IS NULL OR organization_id=@org)");
  if (!result.recordset.length) throw new Error("NOT_FOUND");
  await pool.request().input("auditId", sql.UniqueIdentifier, crypto.randomUUID()).input("actor", sql.UniqueIdentifier, identity.id)
    .input("org", sql.NVarChar(32), result.recordset[0].organizationId).input("entity", sql.UniqueIdentifier, contactId)
    .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
    .query("INSERT dbo.AuditEvents(id,actor_user_id,organization_id,action,entity_type,entity_id,correlation_id) VALUES(@auditId,@actor,@org,'communication.contact.removed','CommunicationContact',@entity,@correlation)");
}

async function listScoped(organizationId: string | null): Promise<ContactRecord[]> {
  if (!isAzureSqlConfigured())
    return structuredClone(memoryContacts().filter((c) => !organizationId || c.organizationId === organizationId));
  const result = await (await getSqlPool()).request().input("org", sql.NVarChar(32), organizationId)
    .query(`${SELECT} WHERE c.deleted_at IS NULL AND (@org IS NULL OR c.organization_id=@org) ORDER BY c.display_name`);
  return result.recordset.map(fromRow);
}

async function importScoped(identity: PulseIdentity, organizationId: string, lines: string, topics: CommunicationTopic[], source: ContactSource) {
  const input = parseInput(communicationContactImportSchema, { organizationId, lines, topics });
  const parsed = parseContactLines(input.lines);
  const created: ContactRecord[] = [];
  const skipped: Array<{ line: number; reason: "invalid" | "duplicate" }> = parsed.errors.map((line) => ({ line, reason: "invalid" as const }));
  for (const [i, row] of parsed.rows.entries()) {
    try {
      created.push(await upsertContact(identity, { organizationId, email: row.email, displayName: row.displayName, locale: "en", topics: input.topics }, source));
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_CONTACT_EXISTS") skipped.push({ line: parsed.rowLines[i], reason: "duplicate" });
      else throw error;
    }
  }
  return { created, skipped: skipped.sort((a, b) => a.line - b.line) };
}

// ---- internal (DataCentral staff) ----
export async function listContacts(identity: PulseIdentity, organizationId?: string) {
  await requireInternalRole(identity);
  return listScoped(organizationId || null);
}
export async function saveContact(identity: PulseIdentity, input: ContactInput) {
  await requirePublishRole(identity);
  return upsertContact(identity, input, "Admin");
}
export async function removeContact(identity: PulseIdentity, contactId: string) {
  await requirePublishRole(identity);
  return softDelete(identity, contactId, null);
}
export async function importContacts(identity: PulseIdentity, organizationId: string, lines: string, topics: CommunicationTopic[]) {
  await requirePublishRole(identity);
  return importScoped(identity, organizationId, lines, topics, "Import");
}

// ---- customer self-service (Company admin of the active organisation) ----
async function requireCompanyAdmin(identity: PulseIdentity) {
  const membership = await requireMembership(identity);
  if (membership.role !== "Company admin") throw new Error("FORBIDDEN");
  return identity.organizationId;
}
export async function listCompanyContacts(identity: PulseIdentity) {
  return listScoped(await requireCompanyAdmin(identity));
}
export async function saveCompanyContact(identity: PulseIdentity, input: Omit<ContactInput, "organizationId">) {
  const organizationId = await requireCompanyAdmin(identity);
  parseInput(companyContactInputSchema, input);
  return upsertContact(identity, { ...input, organizationId }, "Company admin");
}
export async function removeCompanyContact(identity: PulseIdentity, contactId: string) {
  return softDelete(identity, contactId, await requireCompanyAdmin(identity));
}
export async function importCompanyContacts(identity: PulseIdentity, lines: string, topics: CommunicationTopic[]) {
  const organizationId = await requireCompanyAdmin(identity);
  return importScoped(identity, organizationId, lines, topics, "Company admin");
}
