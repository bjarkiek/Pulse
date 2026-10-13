import { communicationSuppressionInputSchema } from "@/lib/contracts";
import type { PulseIdentity } from "@/lib/domain";
import { requireInternalRole } from "../authorization";
import { getSqlPool, isAzureSqlConfigured, sql } from "../database";
import { parseInput } from "../validation";
import { memoryAuditEvent, memoryContacts, memorySuppressions } from "./memory";
import type { ContactStatus, SuppressionReason, SuppressionRecord } from "./types";

/** Width of `dbo.CommunicationSuppressions.note`, and the cap the input schema already applies. */
const NOTE_MAX = 500;

function contactStatusFor(reason: SuppressionReason): ContactStatus {
  return reason === "Bounced" ? "Bounced" : "Unsubscribed";
}
/** Memory twin of `UPDATE dbo.CommunicationContacts SET status=…,updated_at=… WHERE email=… AND deleted_at IS NULL`. */
function setMemoryContactStatus(email: string, status: ContactStatus) {
  const now = new Date().toISOString();
  for (const contact of memoryContacts()) if (contact.email === email) { contact.status = status; contact.updatedAt = now; }
}
/** Both modes store a note the same way: its first 500 characters, or nothing when it is empty. */
const noteOf = (note?: string) => note?.slice(0, NOTE_MAX) || undefined;

/**
 * Webhook and worker path (no identity). The newest event wins: reason, source and note always describe the latest one,
 * while the row keeps its place and creation time. Contacts with this address, in every organisation, are flagged.
 */
export async function suppressAddress(email: string, reason: SuppressionReason, source: "Webhook" | "Admin", note?: string, actorId?: string) {
  const normalized = email.trim().toLowerCase();
  const text = noteOf(note);
  if (!isAzureSqlConfigured()) {
    const store = memorySuppressions();
    const existing = store.find((s) => s.email === normalized);
    const record: SuppressionRecord = { email: normalized, reason, source, note: text, createdAt: existing?.createdAt || new Date().toISOString() };
    if (existing) Object.assign(existing, record); else store.push(record);
    setMemoryContactStatus(normalized, contactStatusFor(reason));
    return;
  }
  const pool = await getSqlPool();
  await pool.request().input("email", sql.NVarChar(320), normalized).input("reason", sql.NVarChar(32), reason)
    .input("source", sql.NVarChar(32), source).input("note", sql.NVarChar(NOTE_MAX), text || null)
    .input("actor", sql.UniqueIdentifier, actorId || null).input("status", sql.NVarChar(32), contactStatusFor(reason))
    // HOLDLOCK keeps the upsert atomic: SendGrid can post two events for one new address at once (a bounce and a spam report) and only one may insert.
    .query(`MERGE dbo.CommunicationSuppressions WITH (HOLDLOCK) target USING(SELECT @email email) incoming ON target.email=incoming.email
      WHEN MATCHED THEN UPDATE SET reason=@reason,source=@source,note=@note
      WHEN NOT MATCHED THEN INSERT(email,reason,source,note,created_by_user_id) VALUES(@email,@reason,@source,@note,@actor);
      UPDATE dbo.CommunicationContacts SET status=@status,updated_at=SYSUTCDATETIME() WHERE email=@email AND deleted_at IS NULL;`);
}

/** Webhook and worker path (no identity). Lifts the suppression only while it still carries `reason`, so a resubscribe never lifts a bounce. */
export async function releaseAddress(email: string, reason: SuppressionReason) {
  const normalized = email.trim().toLowerCase();
  if (!isAzureSqlConfigured()) {
    const store = memorySuppressions();
    const index = store.findIndex((s) => s.email === normalized && s.reason === reason);
    if (index < 0) return;
    store.splice(index, 1);
    setMemoryContactStatus(normalized, "Active");
    return;
  }
  const pool = await getSqlPool();
  await pool.request().input("email", sql.NVarChar(320), normalized).input("reason", sql.NVarChar(32), reason)
    .query(`DELETE dbo.CommunicationSuppressions WHERE email=@email AND reason=@reason;
      IF @@ROWCOUNT>0 UPDATE dbo.CommunicationContacts SET status='Active',updated_at=SYSUTCDATETIME() WHERE email=@email AND deleted_at IS NULL;`);
}

/** No identity: the audience loader and the worker read it. Keys are normalised (trimmed, lower-case) addresses. */
export async function loadSuppressionMap(): Promise<Map<string, SuppressionReason>> {
  if (!isAzureSqlConfigured()) return new Map(memorySuppressions().map((s) => [s.email, s.reason]));
  const result = await (await getSqlPool()).request().query("SELECT email,reason FROM dbo.CommunicationSuppressions");
  return new Map(result.recordset.map((row) => [row.email as string, row.reason as SuppressionReason]));
}

export async function listSuppressions(identity: PulseIdentity): Promise<SuppressionRecord[]> {
  await requireInternalRole(identity);
  // Rows are appended when created and keep their place when updated, so reversing the store is ORDER BY created_at DESC.
  if (!isAzureSqlConfigured()) return structuredClone([...memorySuppressions()].reverse());
  const result = await (await getSqlPool()).request()
    .query("SELECT email,reason,source,note,CONVERT(nvarchar(33),created_at,127) createdAt FROM dbo.CommunicationSuppressions ORDER BY created_at DESC");
  return result.recordset.map((row): SuppressionRecord => ({
    email: row.email, reason: row.reason, source: row.source, note: row.note || undefined, createdAt: row.createdAt,
  }));
}

export async function addSuppression(identity: PulseIdentity, input: { email: string; note?: string }) {
  const parsed = parseInput(communicationSuppressionInputSchema, input);
  await requireInternalRole(identity, ["System admin"]);
  await suppressAddress(parsed.email, "Manual", "Admin", parsed.note, identity.id);
  const record: SuppressionRecord = { email: parsed.email, reason: "Manual", source: "Admin", note: noteOf(parsed.note), createdAt: new Date().toISOString() };
  // Audit rows never carry the address or the note: the suppression table is the only place that PII lives.
  if (!isAzureSqlConfigured()) memoryAuditEvent(identity, "communication.suppression.added", "CommunicationSuppression", undefined, { reason: "Manual" });
  else await (await getSqlPool()).request().input("auditId", sql.UniqueIdentifier, crypto.randomUUID()).input("actor", sql.UniqueIdentifier, identity.id)
    .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
    .query("INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,after_json,correlation_id) VALUES(@auditId,@actor,'communication.suppression.added','CommunicationSuppression',N'{\"reason\":\"Manual\"}',@correlation)");
  return record;
}

export async function removeSuppression(identity: PulseIdentity, email: string) {
  await requireInternalRole(identity, ["System admin"]);
  const normalized = email.trim().toLowerCase();
  if (!isAzureSqlConfigured()) {
    const store = memorySuppressions();
    const index = store.findIndex((s) => s.email === normalized);
    if (index < 0) throw new Error("NOT_FOUND");
    store.splice(index, 1);
    setMemoryContactStatus(normalized, "Active");
    memoryAuditEvent(identity, "communication.suppression.removed", "CommunicationSuppression", undefined, {});
    return;
  }
  const pool = await getSqlPool();
  // As in memory mode, contacts are re-activated only when a suppression was actually removed.
  const result = await pool.request().input("email", sql.NVarChar(320), normalized)
    .query(`DELETE dbo.CommunicationSuppressions OUTPUT DELETED.email WHERE email=@email;
      IF @@ROWCOUNT>0 UPDATE dbo.CommunicationContacts SET status='Active',updated_at=SYSUTCDATETIME() WHERE email=@email AND deleted_at IS NULL;`);
  if (!result.recordset.length) throw new Error("NOT_FOUND");
  await pool.request().input("auditId", sql.UniqueIdentifier, crypto.randomUUID()).input("actor", sql.UniqueIdentifier, identity.id)
    .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
    .query("INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,correlation_id) VALUES(@auditId,@actor,'communication.suppression.removed','CommunicationSuppression',@correlation)");
}
