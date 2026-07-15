import type { PulseIdentity, Tone } from "@/lib/domain";
import { requireInternalRole, requirePublishRole } from "./authorization";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";
import { getIdeaMemory, type IdeaRecord } from "./idea-repository";
import { listRequests, updateRequestStatus } from "./request-repository";
import { getRuntimeSettings } from "./settings-repository";

export type ProductIdea = IdeaRecord & {
  internalTitle: string;
  internalDescription: string;
  publishedTitle?: string;
  publishedDescription?: string;
  internalStatus:
    | "Discovery"
    | "Candidate"
    | "Planned"
    | "In progress"
    | "Released"
    | "Not planned"
    | "Archived";
  ownerId?: string;
  publishState: "Internal" | "Staged" | "Published";
  decisionRationale?: string;
  decisionReason?: string;
  deliveryReference?: string;
  deliveryException?: boolean;
  releaseNotes?: string;
  availability?: string;
  score?: number;
  linkedRequests?: number;
};
type IdeaInput = Partial<ProductIdea> & {
  internalTitle?: string;
  internalDescription?: string;
};
type ScoreInput = {
  impact: number;
  reach: number;
  strategicAlignment: number;
  commercialImpact: number;
  urgency: number;
  confidence: 50 | 80 | 100;
  effort: 1 | 2 | 3 | 5 | 8 | 13;
  mandatory?: boolean;
  rationale: string;
};

declare global {
  var pulseMemoryProducts: ProductIdea[] | undefined;
  var pulseMemoryLinks:
    Array<{ requestId: string; ideaId: string }> | undefined;
  var pulseMemoryScores:
    | Array<{
        ideaId: string;
        score: number;
        inputs: ScoreInput;
        createdAt: string;
      }>
    | undefined;
  var pulseMemoryIdeaAliases: Map<string, string> | undefined;
}
function statusTone(status: string): Tone {
  return status === "Released"
    ? "success"
    : ["Planned", "In progress"].includes(status)
      ? "violet"
      : status === "Not planned"
        ? "error"
        : "neutral";
}
function externalStatus(status: ProductIdea["internalStatus"]) {
  return status === "Discovery"
    ? "Under review"
    : status === "Candidate"
      ? "Considering"
      : status;
}
export function getProductMemory() {
  if (!globalThis.pulseMemoryProducts)
    globalThis.pulseMemoryProducts = getIdeaMemory().map((idea) => ({
      ...idea,
      internalTitle: idea.title,
      internalDescription: idea.description,
      publishedTitle: idea.title,
      publishedDescription: idea.description,
      internalStatus:
        idea.status === "Under review"
          ? "Discovery"
          : idea.status === "Considering"
            ? "Candidate"
            : (idea.status as ProductIdea["internalStatus"]),
      publishState: "Published",
      linkedRequests: 0,
    }));
  return globalThis.pulseMemoryProducts;
}
function products() {
  return getProductMemory();
}
function links() {
  globalThis.pulseMemoryLinks ||= [];
  return globalThis.pulseMemoryLinks;
}
function scores() {
  globalThis.pulseMemoryScores ||= [];
  return globalThis.pulseMemoryScores;
}
function memoryAudit(
  identity: PulseIdentity,
  action: string,
  entityId: string,
  after: unknown,
) {
  globalThis.pulseMemoryAudit ||= [];
  globalThis.pulseMemoryAudit.unshift({
    id: crypto.randomUUID(),
    actor: identity.name,
    organizationId: identity.organizationId,
    action,
    entityType: "Idea",
    entityId,
    after,
    correlationId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });
}
function validateTransition(item: IdeaInput) {
  if (item.internalStatus === "Planned" && !item.horizon)
    throw new Error("INVALID_PLANNED_REQUIRES_HORIZON");
  if (item.internalStatus === "In progress" && !item.ownerId)
    throw new Error("INVALID_IN_PROGRESS_REQUIRES_OWNER");
  if (
    item.internalStatus === "In progress" &&
    !item.deliveryReference &&
    !item.deliveryException
  )
    throw new Error("INVALID_IN_PROGRESS_REQUIRES_DELIVERY_REFERENCE");
  if (
    item.internalStatus === "Released" &&
    (!item.releaseNotes?.trim() || !item.availability?.trim())
  )
    throw new Error("INVALID_RELEASE_REQUIRES_NOTES_AND_AVAILABILITY");
  if (
    item.internalStatus === "Not planned" &&
    (!item.decisionReason?.trim() || !item.publishedDescription?.trim())
  )
    throw new Error("INVALID_NOT_PLANNED_REQUIRES_EXPLANATION");
  if (
    ["Planned", "Not planned"].includes(item.internalStatus || "") &&
    !item.decisionRationale?.trim()
  )
    throw new Error("INVALID_DECISION_REQUIRES_RATIONALE");
}
function mapSql(row: Record<string, unknown>): ProductIdea {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description),
    internalTitle: String(row.internalTitle),
    internalDescription: String(row.internalDescription),
    publishedTitle: row.publishedTitle ? String(row.publishedTitle) : undefined,
    publishedDescription: row.publishedDescription
      ? String(row.publishedDescription)
      : undefined,
    area: String(row.area || "Unclassified"),
    status: String(row.status),
    internalStatus: String(row.internalStatus) as ProductIdea["internalStatus"],
    tone: statusTone(String(row.status)),
    horizon: (row.horizon || "Later") as ProductIdea["horizon"],
    organizations: Number(row.organizations || 0),
    followers: Number(row.followers || 0),
    updated: `Updated ${new Date(row.updatedAt as string).toLocaleDateString("en-GB")}`,
    followed: Boolean(row.followed),
    ownerId: row.ownerId ? String(row.ownerId) : undefined,
    publishState: String(row.publishState) as ProductIdea["publishState"],
    decisionRationale: row.decisionRationale
      ? String(row.decisionRationale)
      : undefined,
    decisionReason: row.decisionReason ? String(row.decisionReason) : undefined,
    deliveryReference: row.deliveryReference
      ? String(row.deliveryReference)
      : undefined,
    deliveryException: Boolean(row.deliveryException),
    releaseNotes: row.releaseNotes ? String(row.releaseNotes) : undefined,
    availability: row.availability ? String(row.availability) : undefined,
    score: row.score == null ? undefined : Number(row.score),
    linkedRequests: Number(row.linkedRequests || 0),
  };
}

export async function listInternalIdeas(identity: PulseIdentity) {
  await requireInternalRole(identity);
  if (!isAzureSqlConfigured()) return products();
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, identity.id)
    .query(
      `SELECT i.public_id id,i.internal_title internalTitle,i.internal_description internalDescription,i.published_title publishedTitle,i.published_description publishedDescription,COALESCE(i.published_title,i.internal_title) title,COALESCE(i.published_description,i.internal_description) description,COALESCE(i.product_area,'Unclassified') area,COALESCE(i.published_status,i.status) status,i.status internalStatus,COALESCE(i.roadmap_horizon,'Later') horizon,i.owner_user_id ownerId,i.publish_state publishState,i.decision_rationale decisionRationale,i.decision_reason decisionReason,i.delivery_reference deliveryReference,i.delivery_exception deliveryException,i.release_notes releaseNotes,i.availability,i.updated_at updatedAt,COUNT(DISTINCT CASE WHEN oi.active=1 THEN oi.organization_id END) organizations,COUNT(DISTINCT CASE WHEN f.active=1 THEN f.user_id END) followers,COUNT(DISTINCT CASE WHEN ril.active=1 THEN ril.request_id END) linkedRequests,MAX(CASE WHEN mine.active=1 THEN 1 ELSE 0 END) followed,(SELECT TOP(1) score FROM dbo.ScoreSnapshots s WHERE s.idea_id=i.id ORDER BY s.created_at DESC) score FROM dbo.Ideas i LEFT JOIN dbo.OrganizationInterests oi ON oi.idea_id=i.id LEFT JOIN dbo.Follows f ON f.idea_id=i.id LEFT JOIN dbo.Follows mine ON mine.idea_id=i.id AND mine.user_id=@userId LEFT JOIN dbo.RequestIdeaLinks ril ON ril.idea_id=i.id WHERE i.deleted_at IS NULL GROUP BY i.id,i.public_id,i.internal_title,i.internal_description,i.published_title,i.published_description,i.product_area,i.published_status,i.status,i.roadmap_horizon,i.owner_user_id,i.publish_state,i.decision_rationale,i.decision_reason,i.delivery_reference,i.delivery_exception,i.release_notes,i.availability,i.updated_at ORDER BY i.updated_at DESC`,
    );
  return result.recordset.map(mapSql);
}

export async function createIdea(identity: PulseIdentity, input: IdeaInput) {
  await requireInternalRole(identity, ["Product manager", "System admin"]);
  if (!input.internalTitle?.trim() || !input.internalDescription?.trim())
    throw new Error("INVALID_IDEA");
  if (!isAzureSqlConfigured()) {
    const id = `IDEA-${Math.max(327, ...products().map((item) => Number(item.id.split("-")[1]))) + 1}`;
    const item: ProductIdea = {
      id,
      title: input.internalTitle,
      description: input.internalDescription,
      internalTitle: input.internalTitle,
      internalDescription: input.internalDescription,
      area: input.area || "Unclassified",
      status: "Under review",
      internalStatus: "Discovery",
      tone: "neutral",
      horizon: input.horizon || "Later",
      organizations: 0,
      followers: 0,
      updated: "Updated now",
      publishState: "Internal",
      linkedRequests: 0,
    };
    products().unshift(item);
    memoryAudit(identity, "idea.created", id, { status: "Discovery" });
    return item;
  }
  const pool = await getSqlPool();
  const number = await pool
    .request()
    .query("SELECT NEXT VALUE FOR dbo.IdeaNumber value");
  const publicId = `IDEA-${number.recordset[0].value}`;
  const id = crypto.randomUUID();
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .input("publicId", sql.NVarChar(32), publicId)
    .input("title", sql.NVarChar(200), input.internalTitle.trim())
    .input(
      "description",
      sql.NVarChar(sql.MAX),
      input.internalDescription.trim(),
    )
    .input("area", sql.NVarChar(100), input.area || null)
    .query(
      "INSERT dbo.Ideas(id,public_id,internal_title,internal_description,product_area,status,publish_state) VALUES(@id,@publicId,@title,@description,@area,'Discovery','Internal')",
    );
  await pool
    .request()
    .input("auditId", sql.UniqueIdentifier, crypto.randomUUID())
    .input("actor", sql.UniqueIdentifier, identity.id)
    .input("entity", sql.UniqueIdentifier, id)
    .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
    .query(
      "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@auditId,@actor,'idea.created','Idea',@entity,N'{\"status\":\"Discovery\"}',@correlation)",
    );
  return (await listInternalIdeas(identity)).find(
    (item) => item.id === publicId,
  )!;
}

export async function updateIdea(
  identity: PulseIdentity,
  publicId: string,
  input: IdeaInput,
) {
  await requireInternalRole(identity, ["Product manager", "System admin"]);
  validateTransition(input);
  if (!isAzureSqlConfigured()) {
    const item = products().find((value) => value.id === publicId);
    if (!item) throw new Error("NOT_FOUND");
    Object.assign(item, input, {
      title: input.publishedTitle || input.internalTitle || item.title,
      description:
        input.publishedDescription ||
        input.internalDescription ||
        item.description,
      status: input.internalStatus
        ? externalStatus(input.internalStatus)
        : item.status,
      tone: input.internalStatus
        ? statusTone(externalStatus(input.internalStatus))
        : item.tone,
      updated: "Updated now",
      publishState:
        item.publishState === "Published" ? "Staged" : item.publishState,
    });
    memoryAudit(identity, "idea.updated", publicId, input);
    return item;
  }
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("publicId", sql.NVarChar(32), publicId)
    .input("internalTitle", sql.NVarChar(200), input.internalTitle || null)
    .input(
      "internalDescription",
      sql.NVarChar(sql.MAX),
      input.internalDescription || null,
    )
    .input("publishedTitle", sql.NVarChar(200), input.publishedTitle || null)
    .input(
      "publishedDescription",
      sql.NVarChar(sql.MAX),
      input.publishedDescription || null,
    )
    .input("area", sql.NVarChar(100), input.area || null)
    .input("status", sql.NVarChar(40), input.internalStatus || null)
    .input("horizon", sql.NVarChar(20), input.horizon || null)
    .input("ownerId", sql.UniqueIdentifier, input.ownerId || null)
    .input("rationale", sql.NVarChar(sql.MAX), input.decisionRationale || null)
    .input("reason", sql.NVarChar(100), input.decisionReason || null)
    .input("delivery", sql.NVarChar(1000), input.deliveryReference || null)
    .input("exception", sql.Bit, input.deliveryException || false)
    .input("releaseNotes", sql.NVarChar(sql.MAX), input.releaseNotes || null)
    .input("availability", sql.NVarChar(100), input.availability || null)
    .query(
      `UPDATE dbo.Ideas SET internal_title=COALESCE(@internalTitle,internal_title),internal_description=COALESCE(@internalDescription,internal_description),published_title=COALESCE(@publishedTitle,published_title),published_description=COALESCE(@publishedDescription,published_description),product_area=COALESCE(@area,product_area),status=COALESCE(@status,status),roadmap_horizon=COALESCE(@horizon,roadmap_horizon),owner_user_id=COALESCE(@ownerId,owner_user_id),decision_rationale=COALESCE(@rationale,decision_rationale),decision_reason=COALESCE(@reason,decision_reason),delivery_reference=COALESCE(@delivery,delivery_reference),delivery_exception=CASE WHEN @exception=1 THEN 1 ELSE delivery_exception END,release_notes=COALESCE(@releaseNotes,release_notes),availability=COALESCE(@availability,availability),publish_state=CASE WHEN publish_state='Published' THEN 'Staged' ELSE publish_state END,updated_at=SYSUTCDATETIME() OUTPUT INSERTED.id WHERE public_id=@publicId AND deleted_at IS NULL`,
    );
  if (!result.recordset.length) throw new Error("NOT_FOUND");
  await pool
    .request()
    .input("auditId", sql.UniqueIdentifier, crypto.randomUUID())
    .input("actor", sql.UniqueIdentifier, identity.id)
    .input("entity", sql.UniqueIdentifier, result.recordset[0].id)
    .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
    .input("after", sql.NVarChar(sql.MAX), JSON.stringify(input))
    .query(
      "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@auditId,@actor,'idea.updated','Idea',@entity,@after,@correlation)",
    );
  return (await listInternalIdeas(identity)).find(
    (item) => item.id === publicId,
  )!;
}

export async function publishIdea(
  identity: PulseIdentity,
  publicId: string,
  confirmedSafe: boolean,
) {
  await requirePublishRole(identity);
  if (!confirmedSafe)
    throw new Error("INVALID_SAFE_WORDING_CONFIRMATION_REQUIRED");
  if (!isAzureSqlConfigured()) {
    const item = products().find((value) => value.id === publicId);
    if (!item) throw new Error("NOT_FOUND");
    validateTransition(item);
    if (!item.publishedTitle?.trim() || !item.publishedDescription?.trim())
      throw new Error("INVALID_PUBLISHED_WORDING_REQUIRED");
    item.title = item.publishedTitle;
    item.description = item.publishedDescription;
    item.status = externalStatus(item.internalStatus);
    item.tone = statusTone(item.status);
    item.publishState = "Published";
    const publicIdea = getIdeaMemory().find((value) => value.id === publicId);
    if (publicIdea) Object.assign(publicIdea, item);
    else getIdeaMemory().push(item);
    memoryAudit(identity, "idea.published", publicId, {
      status: item.status,
      title: item.title,
    });
    return item;
  }
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const lookup = await new sql.Request(transaction)
      .input("publicId", sql.NVarChar(32), publicId)
      .query(
        "SELECT * FROM dbo.Ideas WHERE public_id=@publicId AND deleted_at IS NULL",
      );
    if (!lookup.recordset.length) throw new Error("NOT_FOUND");
    const row = lookup.recordset[0];
    const candidate: IdeaInput = {
      internalStatus: row.status,
      horizon: row.roadmap_horizon,
      ownerId: row.owner_user_id,
      decisionRationale: row.decision_rationale,
      decisionReason: row.decision_reason,
      deliveryReference: row.delivery_reference,
      deliveryException: row.delivery_exception,
      releaseNotes: row.release_notes,
      availability: row.availability,
      publishedDescription: row.published_description,
    };
    validateTransition(candidate);
    if (!row.published_title?.trim() || !row.published_description?.trim())
      throw new Error("INVALID_PUBLISHED_WORDING_REQUIRED");
    const publishedStatus = externalStatus(row.status);
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, row.id)
      .input("publishedStatus", sql.NVarChar(40), publishedStatus)
      .query(
        "UPDATE dbo.Ideas SET publish_state='Published',published_status=@publishedStatus,published_at=SYSUTCDATETIME(),updated_at=SYSUTCDATETIME() WHERE id=@id",
      );
    if (row.roadmap_horizon) {
      await new sql.Request(transaction)
        .input("ideaId", sql.UniqueIdentifier, row.id)
        .query(
          "UPDATE dbo.RoadmapPlacements SET active=0,ended_at=SYSUTCDATETIME() WHERE idea_id=@ideaId AND active=1",
        );
      await new sql.Request(transaction)
        .input("placementId", sql.UniqueIdentifier, crypto.randomUUID())
        .input("ideaId", sql.UniqueIdentifier, row.id)
        .input("horizon", sql.NVarChar(20), row.roadmap_horizon)
        .input("actor", sql.UniqueIdentifier, identity.id)
        .query(
          "INSERT dbo.RoadmapPlacements(id,idea_id,horizon,published,changed_by_user_id) VALUES(@placementId,@ideaId,@horizon,1,@actor)",
        );
    }
    await new sql.Request(transaction)
      .input("ideaId", sql.UniqueIdentifier, row.id)
      .input(
        "event",
        sql.NVarChar(100),
        `idea-published-${publicId}-${Date.now()}`,
      )
      .query(
        "INSERT dbo.Notifications(id,user_id,organization_id,event_type,channel,template,deduplication_key) SELECT NEWID(),f.user_id,f.organization_id,'idea.status.published',channels.channel,'idea-status',@event FROM dbo.Follows f CROSS JOIN (VALUES('In-app'),('Email')) channels(channel) WHERE f.idea_id=@ideaId AND f.active=1 AND NOT EXISTS(SELECT 1 FROM dbo.Notifications n WHERE n.user_id=f.user_id AND n.channel=channels.channel AND n.deduplication_key=@event)",
      );
    await new sql.Request(transaction)
      .input("auditId", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("entity", sql.UniqueIdentifier, row.id)
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .input(
        "after",
        sql.NVarChar(sql.MAX),
        JSON.stringify({
          publishState: "Published",
          status: publishedStatus,
          title: row.published_title,
        }),
      )
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@auditId,@actor,'idea.published','Idea',@entity,@after,@correlation)",
      );
    await transaction.commit();
    return (await listInternalIdeas(identity)).find(
      (item) => item.id === publicId,
    )!;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function linkRequest(
  identity: PulseIdentity,
  ideaPublicId: string,
  requestPublicId: string,
  reason: string,
) {
  await requireInternalRole(identity, ["Product manager", "System admin"]);
  if (!reason.trim()) throw new Error("INVALID_LINK_REASON");
  if (!isAzureSqlConfigured()) {
    const idea = products().find((item) => item.id === ideaPublicId);
    const request = (await listRequests(identity)).find(
      (item) => item.id === requestPublicId,
    );
    if (!idea || !request) throw new Error("NOT_FOUND");
    const alreadyLinked = links().some(
      (item) =>
        item.ideaId === ideaPublicId && item.requestId === requestPublicId,
    );
    if (
      !alreadyLinked
    )
      links().push({ ideaId: ideaPublicId, requestId: requestPublicId });
    request.linkedIdea = ideaPublicId;
    if (!alreadyLinked) idea.linkedRequests = (idea.linkedRequests || 0) + 1;
    idea.organizations = Math.max(1, idea.organizations);
    await updateRequestStatus(identity, requestPublicId, "Linked");
    memoryAudit(identity, "request.linked", ideaPublicId, {
      requestId: requestPublicId,
      reason,
    });
    return { linked: true };
  }
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const lookup = await new sql.Request(transaction)
      .input("idea", sql.NVarChar(32), ideaPublicId)
      .input("request", sql.NVarChar(32), requestPublicId)
      .input("actor", sql.UniqueIdentifier, identity.id)
      .query(
        "SELECT i.id ideaId,r.id requestId,r.organization_id organizationId,r.created_by_user_id requester FROM dbo.Ideas i CROSS JOIN dbo.Requests r WHERE i.public_id=@idea AND r.public_id=@request AND i.deleted_at IS NULL AND r.deleted_at IS NULL AND EXISTS(SELECT 1 FROM dbo.Memberships m WHERE m.user_id=@actor AND m.organization_id=r.organization_id AND m.status='Active')",
      );
    if (!lookup.recordset.length) throw new Error("NOT_FOUND");
    const row = lookup.recordset[0];
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, crypto.randomUUID())
      .input("ideaId", sql.UniqueIdentifier, row.ideaId)
      .input("requestId", sql.UniqueIdentifier, row.requestId)
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("reason", sql.NVarChar(1000), reason)
      .query(
        "IF NOT EXISTS(SELECT 1 FROM dbo.RequestIdeaLinks WHERE idea_id=@ideaId AND request_id=@requestId AND active=1) INSERT dbo.RequestIdeaLinks(id,request_id,idea_id,link_type,active,created_by_user_id,reason) VALUES(@id,@requestId,@ideaId,'Supports',1,@actor,@reason)",
      );
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, crypto.randomUUID())
      .input("ideaId", sql.UniqueIdentifier, row.ideaId)
      .input("organizationId", sql.NVarChar(32), row.organizationId)
      .input("actor", sql.UniqueIdentifier, identity.id)
      .query(
        "MERGE dbo.OrganizationInterests target USING(SELECT @organizationId organization_id,@ideaId idea_id) source ON target.organization_id=source.organization_id AND target.idea_id=source.idea_id WHEN MATCHED THEN UPDATE SET active=1,updated_by_user_id=@actor,updated_at=SYSUTCDATETIME() WHEN NOT MATCHED THEN INSERT(id,organization_id,idea_id,active,updated_by_user_id) VALUES(@id,@organizationId,@ideaId,1,@actor);",
      );
    await new sql.Request(transaction)
      .input("requestId", sql.UniqueIdentifier, row.requestId)
      .query(
        "UPDATE dbo.Requests SET status='Linked',updated_at=SYSUTCDATETIME() WHERE id=@requestId",
      );
    await new sql.Request(transaction)
      .input("notificationId", sql.UniqueIdentifier, crypto.randomUUID())
      .input("requester", sql.UniqueIdentifier, row.requester)
      .input("organizationId", sql.NVarChar(32), row.organizationId)
      .input(
        "dedup",
        sql.NVarChar(255),
        `request-linked-${requestPublicId}-${ideaPublicId}`,
      )
      .query(
        "INSERT dbo.Notifications(id,user_id,organization_id,event_type,channel,template,deduplication_key) SELECT NEWID(),@requester,@organizationId,'request.linked',channels.channel,'request-linked',@dedup FROM (VALUES('In-app'),('Email')) channels(channel) WHERE NOT EXISTS(SELECT 1 FROM dbo.Notifications n WHERE n.user_id=@requester AND n.channel=channels.channel AND n.deduplication_key=@dedup)",
      );
    await new sql.Request(transaction)
      .input("auditId", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("organizationId", sql.NVarChar(32), row.organizationId)
      .input("entity", sql.UniqueIdentifier, row.requestId)
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .input(
        "after",
        sql.NVarChar(sql.MAX),
        JSON.stringify({ idea: ideaPublicId, reason }),
      )
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,organization_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@auditId,@actor,@organizationId,'request.linked','Request',@entity,@after,@correlation)",
      );
    await transaction.commit();
    return { linked: true };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function moveRequestLink(
  identity: PulseIdentity,
  sourceIdeaPublicId: string,
  requestPublicId: string,
  targetIdeaPublicId: string,
  reason: string,
) {
  await requireInternalRole(identity, ["Product manager", "System admin"]);
  if (!reason.trim() || sourceIdeaPublicId === targetIdeaPublicId)
    throw new Error("INVALID_LINK_MOVE");
  if (!isAzureSqlConfigured()) {
    const source = products().find((item) => item.id === sourceIdeaPublicId);
    const target = products().find((item) => item.id === targetIdeaPublicId);
    const link = links().find(
      (item) =>
        item.ideaId === sourceIdeaPublicId && item.requestId === requestPublicId,
    );
    if (!source || !target || !link) throw new Error("NOT_FOUND");
    link.ideaId = targetIdeaPublicId;
    source.linkedRequests = Math.max(0, (source.linkedRequests || 1) - 1);
    target.linkedRequests = (target.linkedRequests || 0) + 1;
    memoryAudit(identity, "request.link.moved", targetIdeaPublicId, {
      requestId: requestPublicId,
      from: sourceIdeaPublicId,
      to: targetIdeaPublicId,
      reason,
    });
    return { moved: true, requestId: requestPublicId, targetIdeaPublicId };
  }

  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const found = await new sql.Request(transaction)
      .input("source", sql.NVarChar(32), sourceIdeaPublicId)
      .input("target", sql.NVarChar(32), targetIdeaPublicId)
      .input("request", sql.NVarChar(32), requestPublicId)
      .input("actor", sql.UniqueIdentifier, identity.id)
      .query(`
        SELECT source.id sourceId,target.id targetId,r.id requestId,r.organization_id organizationId
        FROM dbo.Ideas source CROSS JOIN dbo.Ideas target CROSS JOIN dbo.Requests r
        WHERE source.public_id=@source AND target.public_id=@target AND r.public_id=@request
          AND source.deleted_at IS NULL AND target.deleted_at IS NULL AND r.deleted_at IS NULL
          AND EXISTS(SELECT 1 FROM dbo.RequestIdeaLinks l WHERE l.idea_id=source.id AND l.request_id=r.id AND l.active=1)
          AND EXISTS(SELECT 1 FROM dbo.Memberships m WHERE m.user_id=@actor AND m.organization_id=r.organization_id AND m.status='Active');`);
    if (!found.recordset.length) throw new Error("NOT_FOUND");
    const row = found.recordset[0];
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, crypto.randomUUID())
      .input("source", sql.UniqueIdentifier, row.sourceId)
      .input("target", sql.UniqueIdentifier, row.targetId)
      .input("request", sql.UniqueIdentifier, row.requestId)
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("reason", sql.NVarChar(1000), reason).query(`
        UPDATE dbo.RequestIdeaLinks SET active=0
          WHERE idea_id=@source AND request_id=@request AND active=1;
        IF NOT EXISTS(SELECT 1 FROM dbo.RequestIdeaLinks WHERE idea_id=@target AND request_id=@request AND active=1)
          INSERT dbo.RequestIdeaLinks(id,request_id,idea_id,link_type,active,created_by_user_id,reason)
          VALUES(@id,@request,@target,'Supports',1,@actor,@reason);`);
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, crypto.randomUUID())
      .input("source", sql.UniqueIdentifier, row.sourceId)
      .input("target", sql.UniqueIdentifier, row.targetId)
      .input("organizationId", sql.NVarChar(32), row.organizationId)
      .input("actor", sql.UniqueIdentifier, identity.id).query(`
        MERGE dbo.OrganizationInterests target
        USING(SELECT @organizationId organization_id,@target idea_id) source
        ON target.organization_id=source.organization_id AND target.idea_id=source.idea_id
        WHEN MATCHED THEN UPDATE SET active=1,updated_by_user_id=@actor,updated_at=SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT(id,organization_id,idea_id,active,updated_by_user_id)
          VALUES(@id,@organizationId,@target,1,@actor);
        UPDATE dbo.OrganizationInterests SET active=CASE WHEN EXISTS(
          SELECT 1 FROM dbo.RequestIdeaLinks l JOIN dbo.Requests r ON r.id=l.request_id
          WHERE l.idea_id=@source AND l.active=1 AND r.organization_id=@organizationId AND r.deleted_at IS NULL
        ) THEN 1 ELSE 0 END,updated_by_user_id=@actor,updated_at=SYSUTCDATETIME()
        WHERE idea_id=@source AND organization_id=@organizationId;`);
    await new sql.Request(transaction)
      .input("auditId", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("organizationId", sql.NVarChar(32), row.organizationId)
      .input("entity", sql.UniqueIdentifier, row.requestId)
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .input(
        "before",
        sql.NVarChar(sql.MAX),
        JSON.stringify({ idea: sourceIdeaPublicId }),
      )
      .input(
        "after",
        sql.NVarChar(sql.MAX),
        JSON.stringify({ idea: targetIdeaPublicId, reason }),
      )
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,organization_id,action,entity_type,entity_id,before_json,after_json,correlation_id) VALUES(@auditId,@actor,@organizationId,'request.link.moved','Request',@entity,@before,@after,@correlation)",
      );
    await transaction.commit();
    return { moved: true, requestId: requestPublicId, targetIdeaPublicId };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function scoreIdea(
  identity: PulseIdentity,
  publicId: string,
  input: ScoreInput,
) {
  await requirePublishRole(identity);
  for (const value of [
    input.impact,
    input.reach,
    input.strategicAlignment,
    input.commercialImpact,
    input.urgency,
  ])
    if (value < 1 || value > 5) throw new Error("INVALID_SCORE_INPUT");
  if (
    ![50, 80, 100].includes(input.confidence) ||
    ![1, 2, 3, 5, 8, 13].includes(input.effort) ||
    !input.rationale.trim()
  )
    throw new Error("INVALID_SCORE_INPUT");
  const settings = await getRuntimeSettings();
  const weights = settings.scoreWeights;
  const value =
    input.impact * (weights.impact / 100) +
    input.reach * (weights.reach / 100) +
    input.strategicAlignment * (weights.strategy / 100) +
    input.commercialImpact * (weights.commercial / 100) +
    input.urgency * (weights.urgency / 100);
  const score = Number(
    ((value * (input.confidence / 100)) / input.effort).toFixed(4),
  );
  if (!isAzureSqlConfigured()) {
    const idea = products().find((item) => item.id === publicId);
    if (!idea) throw new Error("NOT_FOUND");
    idea.score = score;
    scores().push({
      ideaId: publicId,
      score,
      inputs: input,
      createdAt: new Date().toISOString(),
    });
    memoryAudit(identity, "idea.scored", publicId, {
      score,
      formulaVersion: settings.formulaVersion,
    });
    return { score, formulaVersion: settings.formulaVersion };
  }
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("publicId", sql.NVarChar(32), publicId)
    .query(
      "SELECT id FROM dbo.Ideas WHERE public_id=@publicId AND deleted_at IS NULL",
    );
  if (!result.recordset.length) throw new Error("NOT_FOUND");
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, crypto.randomUUID())
    .input("ideaId", sql.UniqueIdentifier, result.recordset[0].id)
    .input("inputs", sql.NVarChar(sql.MAX), JSON.stringify(input))
    .input("score", sql.Decimal(12, 4), score)
    .input("formulaVersion", sql.Int, settings.formulaVersion)
    .input("actor", sql.UniqueIdentifier, identity.id)
    .query(
      "INSERT dbo.ScoreSnapshots(id,idea_id,formula_version,inputs_json,score,actor_user_id) VALUES(@id,@ideaId,@formulaVersion,@inputs,@score,@actor)",
    );
  await pool
    .request()
    .input("auditId", sql.UniqueIdentifier, crypto.randomUUID())
    .input("actor", sql.UniqueIdentifier, identity.id)
    .input("entity", sql.UniqueIdentifier, result.recordset[0].id)
    .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
    .input(
      "after",
      sql.NVarChar(sql.MAX),
      JSON.stringify({
        score,
        formulaVersion: settings.formulaVersion,
        inputs: input,
      }),
    )
    .query(
      "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@auditId,@actor,'idea.scored','Idea',@entity,@after,@correlation)",
    );
  return { score, formulaVersion: settings.formulaVersion };
}

export async function mergeIdeas(
  identity: PulseIdentity,
  targetPublicId: string,
  sourcePublicId: string,
  reason: string,
) {
  await requirePublishRole(identity);
  if (targetPublicId === sourcePublicId || !reason.trim())
    throw new Error("INVALID_MERGE");
  if (!isAzureSqlConfigured()) {
    const target = products().find((item) => item.id === targetPublicId);
    const source = products().find((item) => item.id === sourcePublicId);
    if (!target || !source) throw new Error("NOT_FOUND");
    for (const link of links().filter((item) => item.ideaId === sourcePublicId))
      if (
        !links().some(
          (item) =>
            item.ideaId === targetPublicId && item.requestId === link.requestId,
        )
      )
        links().push({ ...link, ideaId: targetPublicId });
    source.internalStatus = "Archived";
    source.publishState = "Internal";
    globalThis.pulseMemoryIdeaAliases ||= new Map();
    globalThis.pulseMemoryIdeaAliases.set(sourcePublicId, targetPublicId);
    const publicSource = getIdeaMemory().findIndex(
      (item) => item.id === sourcePublicId,
    );
    if (publicSource >= 0) getIdeaMemory().splice(publicSource, 1);
    target.followers += source.followers;
    target.organizations = Math.max(target.organizations, source.organizations);
    memoryAudit(identity, "idea.merged", targetPublicId, {
      source: sourcePublicId,
      target: targetPublicId,
      reason,
    });
    return { survivor: targetPublicId, alias: sourcePublicId };
  }
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const found = await new sql.Request(transaction)
      .input("target", sql.NVarChar(32), targetPublicId)
      .input("source", sql.NVarChar(32), sourcePublicId)
      .query(
        "SELECT public_id,id FROM dbo.Ideas WHERE public_id IN(@target,@source) AND deleted_at IS NULL",
      );
    if (found.recordset.length !== 2) throw new Error("NOT_FOUND");
    const target = found.recordset.find(
      (row) => row.public_id === targetPublicId,
    ).id;
    const source = found.recordset.find(
      (row) => row.public_id === sourcePublicId,
    ).id;
    await new sql.Request(transaction)
      .input("target", sql.UniqueIdentifier, target)
      .input("source", sql.UniqueIdentifier, source)
      .query(
        "UPDATE dbo.RequestIdeaLinks SET active=0 WHERE idea_id=@source AND request_id IN(SELECT request_id FROM dbo.RequestIdeaLinks WHERE idea_id=@target AND active=1);UPDATE dbo.RequestIdeaLinks SET idea_id=@target WHERE idea_id=@source AND active=1;UPDATE dbo.OrganizationInterests SET active=0 WHERE idea_id=@source AND organization_id IN(SELECT organization_id FROM dbo.OrganizationInterests WHERE idea_id=@target);UPDATE dbo.OrganizationInterests SET idea_id=@target WHERE idea_id=@source AND active=1;UPDATE dbo.Follows SET active=0 WHERE idea_id=@source AND user_id IN(SELECT user_id FROM dbo.Follows WHERE idea_id=@target);UPDATE dbo.Follows SET idea_id=@target WHERE idea_id=@source AND active=1;INSERT dbo.ReleaseIdeas(release_id,idea_id) SELECT release_id,@target FROM dbo.ReleaseIdeas WHERE idea_id=@source AND NOT EXISTS(SELECT 1 FROM dbo.ReleaseIdeas x WHERE x.release_id=ReleaseIdeas.release_id AND x.idea_id=@target);DELETE dbo.ReleaseIdeas WHERE idea_id=@source;UPDATE dbo.Ideas SET status='Archived',publish_state='Internal',updated_at=SYSUTCDATETIME() WHERE id=@source",
      );
    await new sql.Request(transaction)
      .input("alias", sql.NVarChar(32), sourcePublicId)
      .input("target", sql.UniqueIdentifier, target)
      .input("actor", sql.UniqueIdentifier, identity.id)
      .query(
        "INSERT dbo.IdeaAliases(alias_public_id,surviving_idea_id,merged_by_user_id) VALUES(@alias,@target,@actor)",
      );
    await new sql.Request(transaction)
      .input("auditId", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("target", sql.UniqueIdentifier, target)
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .input(
        "after",
        sql.NVarChar(sql.MAX),
        JSON.stringify({
          source: sourcePublicId,
          target: targetPublicId,
          reason,
        }),
      )
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@auditId,@actor,'idea.merged','Idea',@target,@after,@correlation)",
      );
    await transaction.commit();
    return { survivor: targetPublicId, alias: sourcePublicId };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
