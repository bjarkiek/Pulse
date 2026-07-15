import type { PulseIdentity } from "@/lib/domain";
import { requireInternalRole, requirePublishRole } from "./authorization";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";
import { getProductMemory } from "./product-repository";

export type ReleaseRecord = {
  id: string;
  title: string;
  date: string;
  summary: string;
  availability: string;
  documentationUrl?: string;
  rolloutNotes?: string;
  published: boolean;
  ideaIds: string[];
};
export type NotificationRecord = {
  id: string;
  eventType: string;
  template: string;
  state: string;
  createdAt: string;
  readAt?: string;
  entityId?: string;
};
export type AuditRecord = {
  id: string;
  actor?: string;
  organizationId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  correlationId: string;
  createdAt: string;
};
declare global {
  var pulseMemoryReleases: ReleaseRecord[] | undefined;
  var pulseMemoryNotifications: NotificationRecord[] | undefined;
  var pulseMemoryAudit: AuditRecord[] | undefined;
}
function releases() {
  globalThis.pulseMemoryReleases ||= [];
  return globalThis.pulseMemoryReleases;
}
function notifications() {
  globalThis.pulseMemoryNotifications ||= [];
  return globalThis.pulseMemoryNotifications;
}
function audits() {
  globalThis.pulseMemoryAudit ||= [];
  return globalThis.pulseMemoryAudit;
}
function memoryAudit(
  identity: PulseIdentity,
  action: string,
  entityType: string,
  entityId: string,
  after: unknown,
) {
  audits().unshift({
    id: crypto.randomUUID(),
    actor: identity.name,
    organizationId: identity.organizationId,
    action,
    entityType,
    entityId,
    after,
    correlationId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });
}

export async function listReleases(identity: PulseIdentity, internal = false) {
  if (internal) await requireInternalRole(identity);
  if (!isAzureSqlConfigured())
    return releases().filter((item) => internal || item.published);
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("internal", sql.Bit, internal)
    .query(
      "SELECT r.public_id id,r.title,CONVERT(nvarchar(10),r.release_date,23) date,r.summary,r.availability,r.documentation_url documentationUrl,r.rollout_notes rolloutNotes,r.published,i.public_id ideaId FROM dbo.Releases r LEFT JOIN dbo.ReleaseIdeas ri ON ri.release_id=r.id LEFT JOIN dbo.Ideas i ON i.id=ri.idea_id WHERE r.deleted_at IS NULL AND (r.published=1 OR @internal=1) ORDER BY r.release_date DESC",
    );
  const map = new Map<string, ReleaseRecord>();
  for (const row of result.recordset) {
    const item: ReleaseRecord = map.get(row.id) || {
      id: row.id,
      title: row.title,
      date: row.date,
      summary: row.summary,
      availability: row.availability,
      documentationUrl: row.documentationUrl,
      rolloutNotes: row.rolloutNotes,
      published: Boolean(row.published),
      ideaIds: [],
    };
    if (row.ideaId) item.ideaIds.push(row.ideaId);
    map.set(row.id, item);
  }
  return [...map.values()];
}

export async function createRelease(
  identity: PulseIdentity,
  input: Omit<ReleaseRecord, "id" | "published">,
) {
  await requirePublishRole(identity);
  if (
    !input.title?.trim() ||
    !input.summary?.trim() ||
    !input.date ||
    !input.availability?.trim()
  )
    throw new Error("INVALID_RELEASE");
  if (!isAzureSqlConfigured()) {
    const item: ReleaseRecord = {
      ...input,
      id: `REL-${releases().length + 1}`,
      published: false,
    };
    releases().unshift(item);
    memoryAudit(identity, "release.created", "Release", item.id, item);
    return item;
  }
  const pool = await getSqlPool();
  const number = await pool
    .request()
    .query("SELECT NEXT VALUE FOR dbo.ReleaseNumber value");
  const publicId = `REL-${number.recordset[0].value}`;
  const id = crypto.randomUUID();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, id)
      .input("publicId", sql.NVarChar(32), publicId)
      .input("title", sql.NVarChar(200), input.title)
      .input("date", sql.Date, input.date)
      .input("summary", sql.NVarChar(sql.MAX), input.summary)
      .input("availability", sql.NVarChar(100), input.availability)
      .input(
        "documentation",
        sql.NVarChar(1000),
        input.documentationUrl || null,
      )
      .input("rollout", sql.NVarChar(sql.MAX), input.rolloutNotes || null)
      .input("actor", sql.UniqueIdentifier, identity.id)
      .query(
        "INSERT dbo.Releases(id,public_id,title,release_date,summary,availability,documentation_url,rollout_notes,created_by_user_id) VALUES(@id,@publicId,@title,@date,@summary,@availability,@documentation,@rollout,@actor)",
      );
    for (const ideaPublicId of input.ideaIds || []) {
      const linked = await new sql.Request(transaction)
        .input("releaseId", sql.UniqueIdentifier, id)
        .input("ideaId", sql.NVarChar(32), ideaPublicId)
        .query(
          "INSERT dbo.ReleaseIdeas(release_id,idea_id) SELECT @releaseId,i.id FROM dbo.Ideas i WHERE i.public_id=@ideaId AND i.deleted_at IS NULL;SELECT @@ROWCOUNT affected",
        );
      if (!linked.recordset[0].affected) throw new Error("NOT_FOUND");
    }
    await new sql.Request(transaction)
      .input("auditId", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("entity", sql.UniqueIdentifier, id)
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .input(
        "after",
        sql.NVarChar(sql.MAX),
        JSON.stringify({
          publicId,
          title: input.title,
          ideaIds: input.ideaIds,
        }),
      )
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@auditId,@actor,'release.created','Release',@entity,@after,@correlation)",
      );
    await transaction.commit();
    return (await listReleases(identity, true)).find(
      (item) => item.id === publicId,
    )!;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function publishRelease(
  identity: PulseIdentity,
  publicId: string,
) {
  await requirePublishRole(identity);
  if (!isAzureSqlConfigured()) {
    const item = releases().find((value) => value.id === publicId);
    if (!item) throw new Error("NOT_FOUND");
    if (!item.ideaIds.length) throw new Error("INVALID_RELEASE_REQUIRES_IDEAS");
    item.published = true;
    for (const ideaId of item.ideaIds) {
      const idea = getProductMemory().find((value) => value.id === ideaId);
      if (idea) {
        idea.internalStatus = "Released";
        idea.status = "Released";
        idea.horizon = "Released";
        idea.releaseNotes = item.summary;
        idea.availability = item.availability;
        idea.publishState = "Published";
      }
    }
    notifications().push({
      id: crypto.randomUUID(),
      eventType: "release.published",
      template: "release-published",
      state: "Queued",
      createdAt: new Date().toISOString(),
      entityId: item.id,
    });
    memoryAudit(identity, "release.published", "Release", item.id, item);
    return item;
  }
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const lookup = await new sql.Request(transaction)
      .input("publicId", sql.NVarChar(32), publicId)
      .query(
        "SELECT id,summary,availability FROM dbo.Releases WHERE public_id=@publicId AND deleted_at IS NULL",
      );
    if (!lookup.recordset.length) throw new Error("NOT_FOUND");
    const release = lookup.recordset[0];
    const count = await new sql.Request(transaction)
      .input("releaseId", sql.UniqueIdentifier, release.id)
      .query(
        "SELECT COUNT(*) count FROM dbo.ReleaseIdeas WHERE release_id=@releaseId",
      );
    if (!count.recordset[0].count)
      throw new Error("INVALID_RELEASE_REQUIRES_IDEAS");
    await new sql.Request(transaction)
      .input("releaseId", sql.UniqueIdentifier, release.id)
      .query(
        "UPDATE dbo.Releases SET published=1,published_at=SYSUTCDATETIME(),updated_at=SYSUTCDATETIME() WHERE id=@releaseId;UPDATE i SET status='Released',published_status='Released',roadmap_horizon='Released',release_notes=r.summary,availability=r.availability,publish_state='Published',published_at=COALESCE(i.published_at,SYSUTCDATETIME()),updated_at=SYSUTCDATETIME() FROM dbo.Ideas i JOIN dbo.ReleaseIdeas ri ON ri.idea_id=i.id JOIN dbo.Releases r ON r.id=ri.release_id WHERE r.id=@releaseId",
      );
    const dedup = `release-published-${publicId}`;
    await new sql.Request(transaction)
      .input("releaseId", sql.UniqueIdentifier, release.id)
      .input("dedup", sql.NVarChar(255), dedup)
      .query(
        "INSERT dbo.Notifications(id,user_id,organization_id,event_type,channel,template,deduplication_key) SELECT NEWID(),eligible.user_id,eligible.organization_id,'release.published',channels.channel,'release-published',@dedup FROM(SELECT DISTINCT f.user_id,f.organization_id FROM dbo.ReleaseIdeas ri JOIN dbo.Follows f ON f.idea_id=ri.idea_id AND f.active=1 WHERE ri.release_id=@releaseId UNION SELECT DISTINCT r.created_by_user_id,r.organization_id FROM dbo.ReleaseIdeas ri JOIN dbo.RequestIdeaLinks ril ON ril.idea_id=ri.idea_id AND ril.active=1 JOIN dbo.Requests r ON r.id=ril.request_id WHERE ri.release_id=@releaseId)eligible CROSS JOIN(VALUES('In-app'),('Email'))channels(channel) WHERE NOT EXISTS(SELECT 1 FROM dbo.Notifications n WHERE n.user_id=eligible.user_id AND n.channel=channels.channel AND n.deduplication_key=@dedup)",
      );
    await new sql.Request(transaction)
      .input("auditId", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("entity", sql.UniqueIdentifier, release.id)
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .input(
        "after",
        sql.NVarChar(sql.MAX),
        JSON.stringify({ publicId, published: true }),
      )
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@auditId,@actor,'release.published','Release',@entity,@after,@correlation)",
      );
    await transaction.commit();
    return (await listReleases(identity, true)).find(
      (item) => item.id === publicId,
    )!;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function placeRoadmap(
  identity: PulseIdentity,
  ideaPublicId: string,
  input: {
    horizon: "Now" | "Next" | "Later";
    targetQuarter?: string;
    confidence?: 50 | 80 | 100;
    publish?: boolean;
  },
) {
  await requirePublishRole(identity);
  if (
    !["Now", "Next", "Later"].includes(input.horizon) ||
    (input.confidence &&
      !([50, 80, 100] as number[]).includes(input.confidence))
  )
    throw new Error("INVALID_ROADMAP_PLACEMENT");
  if (!isAzureSqlConfigured()) {
    const idea = getProductMemory().find((value) => value.id === ideaPublicId);
    if (!idea) throw new Error("NOT_FOUND");
    idea.horizon = input.horizon;
    if (input.publish) idea.publishState = "Published";
    memoryAudit(identity, "roadmap.placed", "Idea", ideaPublicId, input);
    return idea;
  }
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const idea = await new sql.Request(transaction)
      .input("publicId", sql.NVarChar(32), ideaPublicId)
      .query(
        "SELECT id FROM dbo.Ideas WHERE public_id=@publicId AND deleted_at IS NULL",
      );
    if (!idea.recordset.length) throw new Error("NOT_FOUND");
    const id = idea.recordset[0].id;
    await new sql.Request(transaction)
      .input("ideaId", sql.UniqueIdentifier, id)
      .query(
        "UPDATE dbo.RoadmapPlacements SET active=0,ended_at=SYSUTCDATETIME() WHERE idea_id=@ideaId AND active=1",
      );
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, crypto.randomUUID())
      .input("ideaId", sql.UniqueIdentifier, id)
      .input("horizon", sql.NVarChar(20), input.horizon)
      .input("quarter", sql.NVarChar(20), input.targetQuarter || null)
      .input("confidence", sql.Int, input.confidence || null)
      .input("published", sql.Bit, input.publish || false)
      .input("actor", sql.UniqueIdentifier, identity.id)
      .query(
        "INSERT dbo.RoadmapPlacements(id,idea_id,horizon,target_quarter,confidence,published,changed_by_user_id) VALUES(@id,@ideaId,@horizon,@quarter,@confidence,@published,@actor);UPDATE dbo.Ideas SET roadmap_horizon=@horizon,publish_state=CASE WHEN @published=1 THEN 'Published' WHEN publish_state='Published' THEN 'Staged' ELSE publish_state END,updated_at=SYSUTCDATETIME() WHERE id=@ideaId",
      );
    await new sql.Request(transaction)
      .input("auditId", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("entity", sql.UniqueIdentifier, id)
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .input("after", sql.NVarChar(sql.MAX), JSON.stringify(input))
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@auditId,@actor,'roadmap.placed','Idea',@entity,@after,@correlation)",
      );
    await transaction.commit();
    return { ideaId: ideaPublicId, ...input };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function listNotifications(identity: PulseIdentity) {
  if (!isAzureSqlConfigured()) return notifications();
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, identity.id)
    .query(
      "SELECT CAST(id AS nvarchar(36)) id,event_type eventType,template,state,created_at createdAt,read_at readAt FROM dbo.Notifications WHERE user_id=@userId ORDER BY created_at DESC",
    );
  return result.recordset;
}
export async function markNotificationRead(
  identity: PulseIdentity,
  id: string,
) {
  if (!isAzureSqlConfigured()) {
    const item = notifications().find((value) => value.id === id);
    if (!item) throw new Error("NOT_FOUND");
    item.readAt = new Date().toISOString();
    return item;
  }
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .input("userId", sql.UniqueIdentifier, identity.id)
    .query(
      "UPDATE dbo.Notifications SET read_at=SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id=@id AND user_id=@userId",
    );
  if (!result.recordset.length) throw new Error("NOT_FOUND");
  return { read: true };
}
export async function listAudit(identity: PulseIdentity, limit = 100) {
  await requireInternalRole(identity, ["System admin"]);
  if (!isAzureSqlConfigured()) return audits().slice(0, Math.min(limit, 500));
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("limit", sql.Int, Math.min(Math.max(limit, 1), 500))
    .query(
      "SELECT TOP (@limit) CAST(a.id AS nvarchar(36)) id,u.display_name actor,a.organization_id organizationId,a.action,a.entity_type entityType,CAST(a.entity_id AS nvarchar(36)) entityId,a.before_json beforeJson,a.after_json afterJson,CAST(a.correlation_id AS nvarchar(36)) correlationId,a.created_at createdAt FROM dbo.AuditEvents a LEFT JOIN dbo.Users u ON u.id=a.actor_user_id ORDER BY a.created_at DESC",
    );
  return result.recordset.map((row) => ({
    ...row,
    before: row.beforeJson ? JSON.parse(row.beforeJson) : undefined,
    after: row.afterJson ? JSON.parse(row.afterJson) : undefined,
    beforeJson: undefined,
    afterJson: undefined,
  }));
}
