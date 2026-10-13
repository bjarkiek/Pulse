import { communicationInputSchema } from "@/lib/contracts";
import type { PulseIdentity } from "@/lib/domain";
import type { z } from "zod";
import { requireInternalRole, requirePublishRole } from "../authorization";
import { atomicSql, getSqlPool, isAzureSqlConfigured, sql } from "../database";
import { listReleases } from "../operations-repository";
import { listInternalIdeas } from "../product-repository";
import { parseInput } from "../validation";
import { addVersions } from "../versions";
import { memoryAuditEvent, memoryCommunications, memoryDeliveries, nextMemoryPublicId } from "./memory";
import { getRuntimeCommunicationSettings } from "./settings";
import { renderCommunication, type RenderedEmail } from "./templates/index";
import type { CommunicationRecord, CommunicationStats, EmailLocale } from "./types";

export type CommunicationInput = z.infer<typeof communicationInputSchema>;

const EMPTY_STATS: CommunicationStats = { recipients: 0, queued: 0, accepted: 0, delivered: 0, bounced: 0, dropped: 0, deadLettered: 0, suppressed: 0, cancelled: 0, opened: 0, clicked: 0, byOrganization: [] };

const SELECT = `SELECT c.public_id id,c.template_key templateKey,c.topic,c.title,c.content_json contentJson,c.audience_json audienceJson,c.status,
  CONVERT(nvarchar(33),c.scheduled_at,127) scheduledAt,CONVERT(nvarchar(33),c.started_at,127) startedAt,CONVERT(nvarchar(33),c.completed_at,127) completedAt,
  CONVERT(nvarchar(33),c.cancelled_at,127) cancelledAt,c.recipient_count recipientCount,c.release_public_id releaseId,u.display_name createdBy,
  CONVERT(nvarchar(33),c.created_at,127) createdAt,CONVERT(nvarchar(33),c.updated_at,127) updatedAt
  FROM dbo.Communications c JOIN dbo.Users u ON u.id=c.created_by_user_id`;
function fromRow(row: Record<string, unknown>): CommunicationRecord {
  return {
    id: String(row.id), templateKey: row.templateKey as CommunicationRecord["templateKey"], topic: row.topic as CommunicationRecord["topic"], title: String(row.title),
    content: JSON.parse(String(row.contentJson)), audience: JSON.parse(String(row.audienceJson)), status: row.status as CommunicationRecord["status"],
    scheduledAt: (row.scheduledAt as string) || undefined, startedAt: (row.startedAt as string) || undefined, completedAt: (row.completedAt as string) || undefined,
    cancelledAt: (row.cancelledAt as string) || undefined, recipientCount: Number(row.recipientCount), releaseId: (row.releaseId as string) || undefined,
    createdBy: String(row.createdBy), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt),
  };
}

/** SQL twin of `memoryAuditEvent`. `entityId` is the campaign's uuid; the insert joins the open `atomicSql` transaction, if there is one. */
async function insertAudit(identity: PulseIdentity, action: string, entityId: string, after: unknown, before?: unknown) {
  await (await getSqlPool()).request().input("auditId", sql.UniqueIdentifier, crypto.randomUUID()).input("actor", sql.UniqueIdentifier, identity.id)
    .input("action", sql.NVarChar(100), action).input("entity", sql.UniqueIdentifier, entityId)
    .input("before", sql.NVarChar(sql.MAX), before === undefined ? null : JSON.stringify(before)).input("after", sql.NVarChar(sql.MAX), JSON.stringify(after))
    .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
    .query("INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,entity_id,before_json,after_json,correlation_id) VALUES(@auditId,@actor,@action,'Communication',@entity,@before,@after,@correlation)");
}

/** A campaign's public id is `COM-` and a number. Nothing else can exist, so anything else is NOT_FOUND (404) in both modes and never reaches the driver, which binds ids as `NVarChar(32)`. */
const PUBLIC_ID = /^COM-\d{1,20}$/;

/** SQL only, for the audit rows of this module and of the send side. */
export async function findCommunicationUuid(publicId: string): Promise<string> {
  if (!PUBLIC_ID.test(publicId)) throw new Error("NOT_FOUND");
  const result = await (await getSqlPool()).request().input("id", sql.NVarChar(32), publicId)
    .query("SELECT CAST(id AS nvarchar(36)) id FROM dbo.Communications WHERE public_id=@id AND deleted_at IS NULL");
  if (!result.recordset.length) throw new Error("NOT_FOUND");
  return result.recordset[0].id;
}

async function loadOne(publicId: string): Promise<CommunicationRecord> {
  if (!PUBLIC_ID.test(publicId)) throw new Error("NOT_FOUND");
  if (!isAzureSqlConfigured()) {
    const item = memoryCommunications().find((c) => c.id === publicId);
    if (!item) throw new Error("NOT_FOUND");
    return structuredClone(item);
  }
  const result = await (await getSqlPool()).request().input("id", sql.NVarChar(32), publicId).query(`${SELECT} WHERE c.public_id=@id AND c.deleted_at IS NULL`);
  if (!result.recordset.length) throw new Error("NOT_FOUND");
  return fromRow(result.recordset[0]);
}

export async function prefillFromRelease(identity: PulseIdentity, releaseId: string): Promise<Pick<CommunicationInput, "templateKey" | "topic" | "title" | "content">> {
  const release = (await listReleases(identity, true)).find((r) => r.id === releaseId);
  if (!release) throw new Error("NOT_FOUND");
  const ideas = await listInternalIdeas(identity);
  const sections = release.ideaIds
    .map((ideaId) => ideas.find((i) => i.id === ideaId))
    .filter((i): i is NonNullable<typeof i> => Boolean(i))
    .map((idea) => ({ heading: idea.publishedTitle || idea.internalTitle, body: idea.releaseNotes || idea.publishedDescription || idea.internalDescription }));
  return {
    templateKey: "product-update" as const,
    topic: "product-updates" as const,
    title: release.title,
    content: {
      subject: { en: release.title },
      body: {
        en: {
          title: release.title,
          subtitle: release.availability,
          intro: release.summary,
          sections: sections.length ? sections : [{ heading: release.title, body: release.summary }],
          ...(release.documentationUrl ? { cta: { label: "Open the release notes", url: release.documentationUrl } } : {}),
        },
      },
    },
  };
}

export async function listCommunications(identity: PulseIdentity): Promise<CommunicationRecord[]> {
  await requireInternalRole(identity);
  if (!isAzureSqlConfigured()) return addVersions("Communications", structuredClone(memoryCommunications()).reverse());
  const result = await (await getSqlPool()).request().query(`${SELECT} WHERE c.deleted_at IS NULL ORDER BY c.created_at DESC`);
  return addVersions("Communications", result.recordset.map(fromRow));
}

export async function getCommunication(identity: PulseIdentity, id: string) {
  await requireInternalRole(identity);
  const [item] = await addVersions("Communications", [await loadOne(id)]);
  return { ...item, stats: EMPTY_STATS }; // Task 9 replaces EMPTY_STATS with `await communicationStats(id)`
}

export async function createCommunication(identity: PulseIdentity, input: Partial<CommunicationInput> & { fromReleaseId?: string }) {
  await requirePublishRole(identity);
  const base = input.fromReleaseId ? await prefillFromRelease(identity, input.fromReleaseId) : {};
  const parsed = parseInput(communicationInputSchema, {
    audience: { organizations: "all-customers" }, ...base, ...input,
    content: input.content ?? (base as { content?: unknown }).content,
  });
  const now = new Date().toISOString();
  if (!isAzureSqlConfigured()) {
    const record: CommunicationRecord = {
      id: nextMemoryPublicId(), templateKey: parsed.templateKey, topic: parsed.topic, title: parsed.title, content: structuredClone(parsed.content) as CommunicationRecord["content"],
      audience: parsed.audience, status: "Draft", recipientCount: 0, releaseId: parsed.fromReleaseId, createdBy: identity.name, createdAt: now, updatedAt: now,
    };
    memoryCommunications().push(record);
    memoryAuditEvent(identity, "communication.created", "Communication", record.id, { templateKey: record.templateKey, topic: record.topic, releaseId: record.releaseId });
    return (await addVersions("Communications", [structuredClone(record)]))[0];
  }
  return atomicSql(async () => {
    const pool = await getSqlPool();
    const uuid = crypto.randomUUID();
    const created = await pool.request().input("id", sql.UniqueIdentifier, uuid).input("template", sql.NVarChar(40), parsed.templateKey)
      .input("topic", sql.NVarChar(40), parsed.topic).input("title", sql.NVarChar(200), parsed.title)
      .input("content", sql.NVarChar(sql.MAX), JSON.stringify(parsed.content)).input("audience", sql.NVarChar(sql.MAX), JSON.stringify(parsed.audience))
      .input("release", sql.NVarChar(32), parsed.fromReleaseId || null).input("actor", sql.UniqueIdentifier, identity.id)
      .query(`INSERT dbo.Communications(id,public_id,template_key,topic,title,content_json,audience_json,release_public_id,created_by_user_id,updated_by_user_id)
        OUTPUT INSERTED.public_id publicId VALUES(@id,CONCAT('COM-',FORMAT(NEXT VALUE FOR dbo.CommunicationNumber,'000')),@template,@topic,@title,@content,@audience,@release,@actor,@actor)`);
    const publicId = created.recordset[0].publicId as string;
    await insertAudit(identity, "communication.created", uuid, { publicId, templateKey: parsed.templateKey, topic: parsed.topic, releaseId: parsed.fromReleaseId });
    return (await addVersions("Communications", [await loadOne(publicId)]))[0];
  });
}

export async function updateCommunication(identity: PulseIdentity, id: string, input: CommunicationInput) {
  await requirePublishRole(identity);
  const parsed = parseInput(communicationInputSchema, input);
  const current = await loadOne(id);
  if (current.status !== "Draft") throw new Error("INVALID_COMMUNICATION_NOT_EDITABLE");
  if (!isAzureSqlConfigured()) {
    const item = memoryCommunications().find((c) => c.id === id)!;
    Object.assign(item, { templateKey: parsed.templateKey, topic: parsed.topic, title: parsed.title, content: structuredClone(parsed.content), audience: parsed.audience, updatedAt: new Date().toISOString() });
    memoryAuditEvent(identity, "communication.updated", "Communication", id, { title: item.title }, { title: current.title });
    return (await addVersions("Communications", [structuredClone(item)]))[0];
  }
  return atomicSql(async () => {
    const uuid = await findCommunicationUuid(id);
    // The status guard is repeated in the UPDATE: a send that wins the race leaves it with no row, and nothing is written.
    const result = await (await getSqlPool()).request().input("id", sql.NVarChar(32), id).input("template", sql.NVarChar(40), parsed.templateKey)
      .input("topic", sql.NVarChar(40), parsed.topic).input("title", sql.NVarChar(200), parsed.title)
      .input("content", sql.NVarChar(sql.MAX), JSON.stringify(parsed.content)).input("audience", sql.NVarChar(sql.MAX), JSON.stringify(parsed.audience))
      .input("actor", sql.UniqueIdentifier, identity.id)
      .query(`UPDATE dbo.Communications SET template_key=@template,topic=@topic,title=@title,content_json=@content,audience_json=@audience,
        updated_by_user_id=@actor,updated_at=SYSUTCDATETIME() WHERE public_id=@id AND status='Draft' AND deleted_at IS NULL`);
    if (!result.rowsAffected[0]) throw new Error("NOT_FOUND");
    await insertAudit(identity, "communication.updated", uuid, { title: parsed.title }, { title: current.title });
    return (await addVersions("Communications", [await loadOne(id)]))[0];
  });
}

/** The working title is limited to 200 characters (the title schema and the column). A copy keeps its whole suffix and gives up the end of a title that would otherwise not fit. */
function copyTitle(title: string) {
  const suffix = " (copy)";
  return `${title.slice(0, 200 - suffix.length).replace(/[\uD800-\uDBFF]$/, "")}${suffix}`;
}

export async function duplicateCommunication(identity: PulseIdentity, id: string) {
  await requirePublishRole(identity);
  const source = await loadOne(id);
  const input = { templateKey: source.templateKey, topic: source.topic, title: copyTitle(source.title), content: source.content as CommunicationInput["content"], audience: source.audience };
  if (!isAzureSqlConfigured()) {
    const copy = await createCommunication(identity, input);
    memoryAuditEvent(identity, "communication.duplicated", "Communication", copy.id, { from: id });
    return copy;
  }
  // One unit of work: the copy and both of its audit rows commit together (createCommunication joins this transaction).
  return atomicSql(async () => {
    const copy = await createCommunication(identity, input);
    await insertAudit(identity, "communication.duplicated", await findCommunicationUuid(copy.id), { from: id });
    return copy;
  });
}

export async function deleteCommunication(identity: PulseIdentity, id: string) {
  await requirePublishRole(identity);
  const current = await loadOne(id);
  if (!["Draft", "Cancelled"].includes(current.status)) throw new Error("INVALID_COMMUNICATION_NOT_DELETABLE");
  if (!isAzureSqlConfigured()) {
    const store = memoryCommunications();
    store.splice(store.findIndex((c) => c.id === id), 1);
    const deliveries = memoryDeliveries();
    for (let i = deliveries.length - 1; i >= 0; i--) if (deliveries[i].communicationId === id) deliveries.splice(i, 1);
    memoryAuditEvent(identity, "communication.deleted", "Communication", id, {});
    return;
  }
  await atomicSql(async () => {
    const uuid = await findCommunicationUuid(id);
    // Soft delete only: deliveries keep their foreign key, and the guard is repeated so a send that wins the race deletes nothing.
    const result = await (await getSqlPool()).request().input("id", sql.NVarChar(32), id).input("actor", sql.UniqueIdentifier, identity.id)
      .query("UPDATE dbo.Communications SET deleted_at=SYSUTCDATETIME(),updated_by_user_id=@actor,updated_at=SYSUTCDATETIME() WHERE public_id=@id AND status IN ('Draft','Cancelled') AND deleted_at IS NULL");
    if (!result.rowsAffected[0]) throw new Error("NOT_FOUND");
    await insertAudit(identity, "communication.deleted", uuid, {});
  });
}

export async function previewCommunication(identity: PulseIdentity, id: string, locale: EmailLocale): Promise<RenderedEmail> {
  await requireInternalRole(identity);
  const item = await loadOne(id);
  const settings = await getRuntimeCommunicationSettings();
  return renderCommunication(item.templateKey, item.content, locale, {
    publicUrl: (process.env.PULSE_PUBLIC_URL || "http://localhost:3000").replace(/\/+$/, ""),
    boilerplate: settings.boilerplate[locale],
    unsubscribeTags: settings.unsubscribeGroupId !== null,
  });
}
