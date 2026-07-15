import type {
  AttachmentRecord,
  PulseIdentity,
  RequestRecord,
  Tone,
} from "@/lib/domain";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";
import { getRuntimeSettings } from "./settings-repository";
import { requireMembership, requirePublishRole } from "./authorization";

type StoredAttachment = AttachmentRecord & {
  organizationId: string;
  storageKey: string;
};
type MemoryState = {
  requests: RequestRecord[];
  attachments: StoredAttachment[];
  blobs: Map<string, Uint8Array>;
};

const seedRequests: RequestRecord[] = [
  {
    id: "DCI-1042",
    title: "Custom branding for exported reports",
    problem:
      "Our external customers receive scheduled PDF reports. We need the export to use customer-specific logos and cover pages.",
    area: "Distribution",
    impact: "High",
    status: "Needs information",
    tone: "warning",
    visibility: "Organization",
    submitted: "10 Jul 2026",
    owner: "Óskar Jónsson",
    organizationId: "ORG-001",
    createdById: "11111111-1111-4111-8111-111111111111",
    attachmentCount: 0,
  },
  {
    id: "DCI-1038",
    title: "Scheduled report delivery to SharePoint",
    problem:
      "Finance teams should receive governed report exports directly in their existing SharePoint libraries.",
    area: "Distribution",
    impact: "High",
    status: "Under review",
    tone: "neutral",
    visibility: "Organization",
    submitted: "3 Jul 2026",
    owner: "Filippus Jónsson",
    linkedIdea: "IDEA-327",
    organizationId: "ORG-001",
    createdById: "11111111-1111-4111-8111-111111111111",
    attachmentCount: 0,
  },
  {
    id: "DCI-1019",
    title: "Audit log API",
    problem:
      "Our security team needs DataCentral events in the central SIEM without relying on manual export.",
    area: "Governance",
    impact: "Critical",
    status: "Planned",
    tone: "violet",
    visibility: "Organization",
    submitted: "14 Jun 2026",
    owner: "Bjarki Kristjánsson",
    linkedIdea: "IDEA-318",
    organizationId: "ORG-001",
    createdById: "11111111-1111-4111-8111-111111111111",
    attachmentCount: 0,
  },
];

declare global {
  var pulseMemoryState: MemoryState | undefined;
}

function memory(): MemoryState {
  globalThis.pulseMemoryState ||= {
    requests: structuredClone(seedRequests),
    attachments: [],
    blobs: new Map(),
  };
  return globalThis.pulseMemoryState;
}

function toneFor(status: string): Tone {
  if (status === "Released") return "success";
  if (status === "Needs information") return "warning";
  if (["Linked", "Planned", "In progress"].includes(status)) return "violet";
  return "neutral";
}

async function assertMembership(identity: PulseIdentity) {
  await requireMembership(identity);
}

export async function listRequests(
  identity: PulseIdentity,
): Promise<RequestRecord[]> {
  await assertMembership(identity);
  if (!isAzureSqlConfigured())
    return memory().requests.filter(
      (item) => item.organizationId === identity.organizationId,
    );
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("organizationId", sql.NVarChar(32), identity.organizationId)
    .input("userId", sql.UniqueIdentifier, identity.id).query(`
    SELECT r.public_id id, r.title, r.problem, r.product_area area, r.impact, r.status,
      r.visibility, FORMAT(r.created_at, 'd MMM yyyy') submitted,
      COALESCE(owner.display_name, 'Unassigned') owner, link.idea_public_id linkedIdea,
      COUNT(a.id) attachmentCount
    FROM dbo.Requests r
    LEFT JOIN dbo.Users owner ON owner.id=r.owner_user_id
    OUTER APPLY (SELECT TOP (1) i.public_id idea_public_id FROM dbo.RequestIdeaLinks ril JOIN dbo.Ideas i ON i.id=ril.idea_id WHERE ril.request_id=r.id AND ril.active=1) link
    LEFT JOIN dbo.Attachments a ON a.request_id=r.id AND a.deleted_at IS NULL
    WHERE r.organization_id=@organizationId AND r.deleted_at IS NULL
      AND (r.visibility='Organization' OR r.created_by_user_id=@userId OR @userId=r.owner_user_id)
    GROUP BY r.public_id,r.title,r.problem,r.product_area,r.impact,r.status,r.visibility,r.created_at,owner.display_name,link.idea_public_id
    ORDER BY r.created_at DESC`);
  return result.recordset.map((row) => ({
    ...row,
    tone: toneFor(row.status),
    organizationId: identity.organizationId,
  }));
}

export async function getRequest(identity: PulseIdentity, id: string) {
  const item = (await listRequests(identity)).find(
    (request) => request.id === id,
  );
  if (!item) throw new Error("NOT_FOUND");
  return item;
}

export async function getRequestHistory(identity: PulseIdentity, id: string) {
  await getRequest(identity, id);
  if (!isAzureSqlConfigured())
    return (globalThis.pulseMemoryAudit || [])
      .filter(
        (event) => event.entityType === "Request" && event.entityId === id,
      )
      .map((event) => ({
        id: event.id,
        action: event.action,
        actor: event.actor,
        after: event.after,
        createdAt: event.createdAt,
      }));
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("publicId", sql.NVarChar(32), id)
    .input("organizationId", sql.NVarChar(32), identity.organizationId)
    .query(
      "SELECT CAST(a.id AS nvarchar(36)) id,a.action,u.display_name actor,a.after_json afterJson,a.created_at createdAt FROM dbo.AuditEvents a JOIN dbo.Requests r ON r.id=a.entity_id LEFT JOIN dbo.Users u ON u.id=a.actor_user_id WHERE a.entity_type='Request' AND r.public_id=@publicId AND r.organization_id=@organizationId ORDER BY a.created_at DESC",
    );
  return result.recordset.map((event) => ({
    ...event,
    after: event.afterJson ? JSON.parse(event.afterJson) : undefined,
    afterJson: undefined,
  }));
}

export async function createRequest(
  identity: PulseIdentity,
  input: Pick<
    RequestRecord,
    "title" | "problem" | "area" | "impact" | "visibility"
  > & {
    linkedIdeaId?: string;
    requestType?: string;
    affectedUsers?: number;
    workaround?: string;
    desiredTiming?: string;
  },
) {
  await requireMembership(identity);
  if (!input.title?.trim() || input.title.length > 140)
    throw new Error("INVALID_TITLE");
  if (!input.problem?.trim() || input.problem.length > 5000)
    throw new Error("INVALID_PROBLEM");
  if (!(["Private", "Organization"] as string[]).includes(input.visibility))
    throw new Error("INVALID_VISIBILITY");
  let id = `DCI-${Math.floor(1000 + Math.random() * 9000)}`;
  if (isAzureSqlConfigured()) {
    const pool = await getSqlPool();
    const number = await pool
      .request()
      .query("SELECT NEXT VALUE FOR dbo.RequestNumber AS value");
    id = `DCI-${number.recordset[0].value}`;
  }
  const linkedIdeaId = input.linkedIdeaId?.trim();
  const record: RequestRecord = {
    ...input,
    id,
    title: input.title.trim(),
    problem: input.problem.trim(),
    status: linkedIdeaId ? "Linked" : "Submitted",
    tone: linkedIdeaId ? "violet" : "neutral",
    submitted: new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date()),
    owner: "Unassigned",
    organizationId: identity.organizationId,
    createdById: identity.id,
    attachmentCount: 0,
    linkedIdea: linkedIdeaId,
    requestType: input.requestType?.trim() || undefined,
    affectedUsers:
      Number(input.affectedUsers) > 0 ? Number(input.affectedUsers) : undefined,
    workaround: input.workaround?.trim() || undefined,
    desiredTiming: input.desiredTiming?.trim() || undefined,
  };
  if (!isAzureSqlConfigured()) {
    if (linkedIdeaId) {
      const idea = globalThis.pulseMemoryProducts?.find(
        (item) => item.id === linkedIdeaId && item.publishState === "Published",
      );
      const publicIdea = globalThis.pulseMemoryIdeas?.find(
        (item) => item.id === linkedIdeaId,
      );
      if (!idea && !publicIdea) throw new Error("NOT_FOUND");
      globalThis.pulseMemoryLinks ||= [];
      globalThis.pulseMemoryLinks.push({ requestId: id, ideaId: linkedIdeaId });
      if (idea) {
        idea.linkedRequests = (idea.linkedRequests || 0) + 1;
        idea.organizations = Math.max(1, idea.organizations);
      }
    }
    memory().requests.unshift(record);
    globalThis.pulseMemoryAudit ||= [];
    globalThis.pulseMemoryAudit.unshift({
      id: crypto.randomUUID(),
      actor: identity.name,
      organizationId: identity.organizationId,
      action: "request.created",
      entityType: "Request",
      entityId: record.id,
      after: { status: record.status, linkedIdeaId },
      correlationId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    globalThis.pulseMemoryNotifications ||= [];
    globalThis.pulseMemoryNotifications.push({
      id: crypto.randomUUID(),
      eventType: "request.submitted",
      template: "request-submitted",
      state: "Queued",
      createdAt: new Date().toISOString(),
      entityId: record.id,
    });
    return record;
  }
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const requestId = crypto.randomUUID();
    let linkedIdea: { id: string } | undefined;
    if (linkedIdeaId) {
      const lookup = await new sql.Request(transaction)
        .input("idea", sql.NVarChar(32), linkedIdeaId)
        .query(
          "SELECT id FROM dbo.Ideas WHERE public_id=@idea AND publish_state='Published' AND deleted_at IS NULL",
        );
      if (!lookup.recordset.length) throw new Error("NOT_FOUND");
      linkedIdea = lookup.recordset[0];
    }
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, requestId)
      .input("publicId", sql.NVarChar(32), id)
      .input("organizationId", sql.NVarChar(32), identity.organizationId)
      .input("userId", sql.UniqueIdentifier, identity.id)
      .input("title", sql.NVarChar(140), record.title)
      .input("problem", sql.NVarChar(sql.MAX), record.problem)
      .input("area", sql.NVarChar(100), record.area)
      .input("impact", sql.NVarChar(32), record.impact)
      .input("visibility", sql.NVarChar(32), record.visibility)
      .input("status", sql.NVarChar(32), record.status)
      .input("requestType", sql.NVarChar(100), record.requestType || null)
      .input("affectedUsers", sql.Int, record.affectedUsers || null)
      .input("workaround", sql.NVarChar(sql.MAX), record.workaround || null)
      .input("desiredTiming", sql.NVarChar(200), record.desiredTiming || null)
      .query(
        "INSERT dbo.Requests(id,public_id,organization_id,created_by_user_id,title,problem,product_area,request_type,impact,affected_users,workaround,desired_timing,status,visibility) VALUES(@id,@publicId,@organizationId,@userId,@title,@problem,@area,@requestType,@impact,@affectedUsers,@workaround,@desiredTiming,@status,@visibility)",
      );
    if (linkedIdea) {
      await new sql.Request(transaction)
        .input("id", sql.UniqueIdentifier, crypto.randomUUID())
        .input("requestId", sql.UniqueIdentifier, requestId)
        .input("ideaId", sql.UniqueIdentifier, linkedIdea.id)
        .input("actor", sql.UniqueIdentifier, identity.id)
        .query(
          "INSERT dbo.RequestIdeaLinks(id,request_id,idea_id,link_type,active,created_by_user_id,reason) VALUES(@id,@requestId,@ideaId,'Supports',1,@actor,N'Customer added distinct context from duplicate discovery')",
        );
      await new sql.Request(transaction)
        .input("id", sql.UniqueIdentifier, crypto.randomUUID())
        .input("organizationId", sql.NVarChar(32), identity.organizationId)
        .input("ideaId", sql.UniqueIdentifier, linkedIdea.id)
        .input("actor", sql.UniqueIdentifier, identity.id).query(`
          MERGE dbo.OrganizationInterests target
          USING(SELECT @organizationId organization_id,@ideaId idea_id) source
          ON target.organization_id=source.organization_id AND target.idea_id=source.idea_id
          WHEN MATCHED THEN UPDATE SET active=1,updated_by_user_id=@actor,updated_at=SYSUTCDATETIME()
          WHEN NOT MATCHED THEN INSERT(id,organization_id,idea_id,active,updated_by_user_id)
            VALUES(@id,@organizationId,@ideaId,1,@actor);`);
      await new sql.Request(transaction)
        .input("id", sql.UniqueIdentifier, crypto.randomUUID())
        .input("userId", sql.UniqueIdentifier, identity.id)
        .input("organizationId", sql.NVarChar(32), identity.organizationId)
        .input("ideaId", sql.UniqueIdentifier, linkedIdea.id)
        .query(
          "MERGE dbo.Follows target USING(SELECT @userId user_id,@organizationId organization_id,@ideaId idea_id) source ON target.user_id=source.user_id AND target.organization_id=source.organization_id AND target.idea_id=source.idea_id WHEN MATCHED THEN UPDATE SET active=1,updated_at=SYSUTCDATETIME() WHEN NOT MATCHED THEN INSERT(id,user_id,organization_id,idea_id,active) VALUES(@id,@userId,@organizationId,@ideaId,1);",
        );
    }
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, crypto.randomUUID())
      .input("requestId", sql.UniqueIdentifier, requestId)
      .input("title", sql.NVarChar(140), record.title)
      .input("problem", sql.NVarChar(sql.MAX), record.problem)
      .input("actor", sql.UniqueIdentifier, identity.id)
      .query(
        "INSERT dbo.RequestRevisions(id,request_id,revision_number,title,problem,changed_by_user_id) VALUES(@id,@requestId,1,@title,@problem,@actor)",
      );
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("organizationId", sql.NVarChar(32), identity.organizationId)
      .input("entityId", sql.UniqueIdentifier, requestId)
      .input(
        "after",
        sql.NVarChar(sql.MAX),
        JSON.stringify({ status: record.status, linkedIdeaId }),
      )
      .input("correlationId", sql.UniqueIdentifier, crypto.randomUUID())
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,organization_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@id,@actor,@organizationId,'request.created','Request',@entityId,@after,@correlationId)",
      );
    await new sql.Request(transaction)
      .input("userId", sql.UniqueIdentifier, identity.id)
      .input("organizationId", sql.NVarChar(32), identity.organizationId)
      .input("dedup", sql.NVarChar(255), `request-submitted-${id}`)
      .query(
        "INSERT dbo.Notifications(id,user_id,organization_id,event_type,channel,template,deduplication_key) SELECT NEWID(),@userId,@organizationId,'request.submitted',channel,'request-submitted',@dedup FROM (VALUES('In-app'),('Email')) channels(channel)",
      );
    await transaction.commit();
    return record;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function updateRequestStatus(
  identity: PulseIdentity,
  id: string,
  status: string,
  details: { explanation?: string; supportReference?: string } = {},
) {
  const membership = await requireMembership(identity);
  if (
    ![
      "Submitted",
      "Needs information",
      "Linked",
      "Routed to support",
      "Closed",
      "Withdrawn",
    ].includes(status)
  )
    throw new Error("INVALID_REQUEST_STATUS");
  let internal = false;
  try {
    await requirePublishRole(identity);
    internal = true;
  } catch {
    internal = false;
  }
  if (status !== "Withdrawn" && !internal) throw new Error("FORBIDDEN");
  if (status === "Closed" && !details.explanation?.trim())
    throw new Error("INVALID_CLOSURE_EXPLANATION_REQUIRED");
  if (status === "Routed to support" && !details.supportReference?.trim())
    throw new Error("INVALID_SUPPORT_REFERENCE_REQUIRED");
  if (!isAzureSqlConfigured()) {
    const item = memory().requests.find(
      (request) =>
        request.id === id && request.organizationId === identity.organizationId,
    );
    if (!item) throw new Error("NOT_FOUND");
    if (
      status === "Withdrawn" &&
      !internal &&
      item.createdById !== identity.id &&
      membership.role !== "Company admin"
    )
      throw new Error("NOT_FOUND");
    item.status = status;
    item.tone = toneFor(status);
    if (status === "Withdrawn" && item.linkedIdea) {
      const remaining = memory().requests.some(
        (request) =>
          request.id !== item.id &&
          request.organizationId === item.organizationId &&
          request.linkedIdea === item.linkedIdea &&
          !["Withdrawn", "Closed", "Routed to support"].includes(
            request.status,
          ),
      );
      const idea = globalThis.pulseMemoryProducts?.find(
        (value) => value.id === item.linkedIdea,
      );
      if (idea && !remaining)
        idea.organizations = Math.max(0, idea.organizations - 1);
    }
    globalThis.pulseMemoryAudit ||= [];
    globalThis.pulseMemoryAudit.unshift({
      id: crypto.randomUUID(),
      actor: identity.name,
      organizationId: identity.organizationId,
      action: "request.status.changed",
      entityType: "Request",
      entityId: id,
      after: { status, ...details },
      correlationId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    return item;
  }
  const pool = await getSqlPool();
  if (status === "Withdrawn" && !internal) {
    const authorized = await pool
      .request()
      .input("id", sql.NVarChar(32), id)
      .input("organizationId", sql.NVarChar(32), identity.organizationId)
      .input("userId", sql.UniqueIdentifier, identity.id)
      .input("companyAdmin", sql.Bit, membership.role === "Company admin")
      .query(
        "SELECT TOP (1) 1 allowed FROM dbo.Requests WHERE public_id=@id AND organization_id=@organizationId AND deleted_at IS NULL AND (created_by_user_id=@userId OR @companyAdmin=1)",
      );
    if (!authorized.recordset.length) throw new Error("NOT_FOUND");
  }
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const result = await new sql.Request(transaction)
      .input("id", sql.NVarChar(32), id)
      .input("organizationId", sql.NVarChar(32), identity.organizationId)
      .input("status", sql.NVarChar(40), status)
      .input(
        "explanation",
        sql.NVarChar(sql.MAX),
        details.explanation?.trim() || null,
      )
      .input(
        "supportReference",
        sql.NVarChar(1000),
        details.supportReference?.trim() || null,
      )
      .query(
        "UPDATE dbo.Requests SET status=@status,closure_explanation=COALESCE(@explanation,closure_explanation),support_reference=COALESCE(@supportReference,support_reference),withdrawn_at=CASE WHEN @status='Withdrawn' THEN SYSUTCDATETIME() ELSE withdrawn_at END,triaged_at=CASE WHEN @status IN ('Linked','Routed to support','Closed') THEN COALESCE(triaged_at,SYSUTCDATETIME()) ELSE triaged_at END,updated_at=SYSUTCDATETIME() OUTPUT INSERTED.id,INSERTED.created_by_user_id requester WHERE public_id=@id AND organization_id=@organizationId AND deleted_at IS NULL",
      );
    if (!result.recordset.length) throw new Error("NOT_FOUND");
    const row = result.recordset[0];
    if (status === "Withdrawn")
      await new sql.Request(transaction)
        .input("requestId", sql.UniqueIdentifier, row.id)
        .input("organizationId", sql.NVarChar(32), identity.organizationId)
        .input("actor", sql.UniqueIdentifier, identity.id)
        .query(`
          UPDATE oi SET active=CASE WHEN EXISTS(
            SELECT 1 FROM dbo.RequestIdeaLinks otherLink
            JOIN dbo.Requests otherRequest ON otherRequest.id=otherLink.request_id
            WHERE otherLink.idea_id=oi.idea_id AND otherLink.active=1
              AND otherRequest.organization_id=@organizationId
              AND otherRequest.status NOT IN ('Withdrawn','Closed','Routed to support')
              AND otherRequest.deleted_at IS NULL
          ) THEN 1 ELSE 0 END,updated_by_user_id=@actor,updated_at=SYSUTCDATETIME()
          FROM dbo.OrganizationInterests oi
          JOIN dbo.RequestIdeaLinks withdrawnLink ON withdrawnLink.idea_id=oi.idea_id AND withdrawnLink.request_id=@requestId
          WHERE oi.organization_id=@organizationId;`);
    await new sql.Request(transaction)
      .input("auditId", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("organizationId", sql.NVarChar(32), identity.organizationId)
      .input("entity", sql.UniqueIdentifier, row.id)
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .input(
        "after",
        sql.NVarChar(sql.MAX),
        JSON.stringify({ status, ...details }),
      )
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,organization_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@auditId,@actor,@organizationId,'request.status.changed','Request',@entity,@after,@correlation)",
      );
    if (
      ["Needs information", "Linked", "Routed to support", "Closed"].includes(
        status,
      )
    )
      await new sql.Request(transaction)
        .input("requester", sql.UniqueIdentifier, row.requester)
        .input("organizationId", sql.NVarChar(32), identity.organizationId)
        .input("dedup", sql.NVarChar(255), `request-status-${id}-${status}`)
        .input(
          "event",
          sql.NVarChar(100),
          `request.${status.toLowerCase().replaceAll(" ", "-")}`,
        )
        .query(
          "INSERT dbo.Notifications(id,user_id,organization_id,event_type,channel,template,deduplication_key) SELECT NEWID(),@requester,@organizationId,@event,channel,'request-status',@dedup FROM (VALUES('In-app'),('Email')) channels(channel) WHERE NOT EXISTS(SELECT 1 FROM dbo.Notifications n WHERE n.user_id=@requester AND n.channel=channels.channel AND n.deduplication_key=@dedup)",
        );
    await transaction.commit();
    return { id, status, tone: toneFor(status) };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function editRequest(
  identity: PulseIdentity,
  id: string,
  input: { title?: string; problem?: string },
) {
  const membership = await requireMembership(identity);
  const title = input.title?.trim();
  const problem = input.problem?.trim();
  if ((!title && !problem) || (title && title.length > 140))
    throw new Error("INVALID_TITLE");
  if (problem && problem.length > 5000) throw new Error("INVALID_PROBLEM");
  let internal = false;
  try {
    await requirePublishRole(identity);
    internal = true;
  } catch {
    internal = false;
  }
  if (!isAzureSqlConfigured()) {
    const item = memory().requests.find(
      (request) =>
        request.id === id && request.organizationId === identity.organizationId,
    );
    if (!item) throw new Error("NOT_FOUND");
    if (
      !internal &&
      item.createdById !== identity.id &&
      membership.role !== "Company admin"
    )
      throw new Error("NOT_FOUND");
    if (!["Submitted", "Needs information"].includes(item.status))
      throw new Error("INVALID_REQUEST_NOT_EDITABLE");
    const before = { title: item.title, problem: item.problem };
    if (title) item.title = title;
    if (problem) item.problem = problem;
    globalThis.pulseMemoryAudit ||= [];
    globalThis.pulseMemoryAudit.unshift({
      id: crypto.randomUUID(),
      actor: identity.name,
      organizationId: identity.organizationId,
      action: "request.edited",
      entityType: "Request",
      entityId: id,
      before,
      after: { title: item.title, problem: item.problem },
      correlationId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    return item;
  }
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const lookup = await new sql.Request(transaction)
      .input("publicId", sql.NVarChar(32), id)
      .input("organizationId", sql.NVarChar(32), identity.organizationId)
      .query(
        "SELECT id,title,problem,status,created_by_user_id createdBy,owner_user_id ownerId FROM dbo.Requests WITH (UPDLOCK) WHERE public_id=@publicId AND organization_id=@organizationId AND deleted_at IS NULL",
      );
    if (!lookup.recordset.length) throw new Error("NOT_FOUND");
    const current = lookup.recordset[0];
    if (
      !internal &&
      String(current.createdBy) !== identity.id &&
      membership.role !== "Company admin"
    )
      throw new Error("NOT_FOUND");
    if (!["Submitted", "Needs information"].includes(current.status))
      throw new Error("INVALID_REQUEST_NOT_EDITABLE");
    const nextTitle = title || current.title;
    const nextProblem = problem || current.problem;
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, crypto.randomUUID())
      .input("requestId", sql.UniqueIdentifier, current.id)
      .input("title", sql.NVarChar(140), nextTitle)
      .input("problem", sql.NVarChar(sql.MAX), nextProblem)
      .input("actor", sql.UniqueIdentifier, identity.id)
      .query(
        "INSERT dbo.RequestRevisions(id,request_id,revision_number,title,problem,changed_by_user_id) SELECT @id,@requestId,COALESCE(MAX(revision_number),0)+1,@title,@problem,@actor FROM dbo.RequestRevisions WHERE request_id=@requestId;UPDATE dbo.Requests SET title=@title,problem=@problem,updated_at=SYSUTCDATETIME() WHERE id=@requestId",
      );
    await new sql.Request(transaction)
      .input("auditId", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("organizationId", sql.NVarChar(32), identity.organizationId)
      .input("entity", sql.UniqueIdentifier, current.id)
      .input(
        "before",
        sql.NVarChar(sql.MAX),
        JSON.stringify({ title: current.title, problem: current.problem }),
      )
      .input(
        "after",
        sql.NVarChar(sql.MAX),
        JSON.stringify({ title: nextTitle, problem: nextProblem }),
      )
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,organization_id,action,entity_type,entity_id,before_json,after_json,correlation_id) VALUES(@auditId,@actor,@organizationId,'request.edited','Request',@entity,@before,@after,@correlation)",
      );
    if (current.ownerId && String(current.ownerId) !== identity.id)
      await new sql.Request(transaction)
        .input("owner", sql.UniqueIdentifier, current.ownerId)
        .input("organizationId", sql.NVarChar(32), identity.organizationId)
        .input("dedup", sql.NVarChar(255), `request-edited-${id}-${Date.now()}`)
        .query(
          "INSERT dbo.Notifications(id,user_id,organization_id,event_type,channel,template,deduplication_key) SELECT NEWID(),@owner,@organizationId,'request.edited',channel,'request-edited',@dedup FROM (VALUES('In-app'),('Email')) channels(channel)",
        );
    await transaction.commit();
    return getRequest(identity, id);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function requestAttachmentBytes(
  identity: PulseIdentity,
  requestId: string,
  attachment: Omit<
    AttachmentRecord,
    "id" | "requestId" | "scanState" | "createdAt"
  >,
) {
  await assertMembership(identity);
  const requests = await listRequests(identity);
  if (!requests.some((item) => item.id === requestId))
    throw new Error("NOT_FOUND");
  const existing = await listAttachments(identity, requestId);
  const settings = await getRuntimeSettings();
  if (
    existing.reduce((sum, item) => sum + item.sizeBytes, 0) +
      attachment.sizeBytes >
    settings.requestAttachmentMaxMb * 1024 * 1024
  )
    throw new Error("INVALID_REQUEST_ATTACHMENT_TOTAL");
  const id = crypto.randomUUID();
  const storageKey = `${identity.organizationId}/${requestId}/${id}/${attachment.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const record: StoredAttachment = {
    ...attachment,
    id,
    requestId,
    organizationId: identity.organizationId,
    storageKey,
    scanState: "Pending upload",
    createdAt: new Date().toISOString(),
  };
  if (!isAzureSqlConfigured()) {
    memory().attachments.push(record);
    return record;
  }
  const pool = await getSqlPool();
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .input("organizationId", sql.NVarChar(32), identity.organizationId)
    .input("requestPublicId", sql.NVarChar(32), requestId)
    .input("uploader", sql.UniqueIdentifier, identity.id)
    .input("storageKey", sql.NVarChar(1024), storageKey)
    .input("fileName", sql.NVarChar(255), record.fileName)
    .input("contentType", sql.NVarChar(255), record.contentType)
    .input("size", sql.BigInt, record.sizeBytes)
    .query(
      "INSERT dbo.Attachments(id,request_id,organization_id,uploaded_by_user_id,storage_key,file_name,content_type,size_bytes,scan_state,visibility) SELECT @id,r.id,@organizationId,@uploader,@storageKey,@fileName,@contentType,@size,'Pending upload',r.visibility FROM dbo.Requests r WHERE r.public_id=@requestPublicId AND r.organization_id=@organizationId",
    );
  return record;
}

export async function listAttachments(
  identity: PulseIdentity,
  requestId: string,
): Promise<StoredAttachment[]> {
  await assertMembership(identity);
  if (!isAzureSqlConfigured())
    return memory().attachments.filter(
      (item) =>
        item.requestId === requestId &&
        item.organizationId === identity.organizationId,
    );
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("requestId", sql.NVarChar(32), requestId)
    .input("organizationId", sql.NVarChar(32), identity.organizationId)
    .query(
      "SELECT CAST(a.id AS nvarchar(36)) id,r.public_id requestId,a.file_name fileName,a.content_type contentType,a.size_bytes sizeBytes,a.scan_state scanState,a.created_at createdAt,a.organization_id organizationId,a.storage_key storageKey FROM dbo.Attachments a JOIN dbo.Requests r ON r.id=a.request_id WHERE r.public_id=@requestId AND a.organization_id=@organizationId AND a.deleted_at IS NULL ORDER BY a.created_at",
    );
  return result.recordset;
}

export async function getAttachment(identity: PulseIdentity, id: string) {
  await assertMembership(identity);
  if (!isAzureSqlConfigured()) {
    const item = memory().attachments.find(
      (a) => a.id === id && a.organizationId === identity.organizationId,
    );
    if (!item) throw new Error("NOT_FOUND");
    return item;
  }
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .input("organizationId", sql.NVarChar(32), identity.organizationId)
    .query(
      "SELECT CAST(a.id AS nvarchar(36)) id,r.public_id requestId,a.file_name fileName,a.content_type contentType,a.size_bytes sizeBytes,a.scan_state scanState,a.created_at createdAt,a.organization_id organizationId,a.storage_key storageKey FROM dbo.Attachments a JOIN dbo.Requests r ON r.id=a.request_id WHERE a.id=@id AND a.organization_id=@organizationId AND a.deleted_at IS NULL",
    );
  if (!result.recordset.length) throw new Error("NOT_FOUND");
  return result.recordset[0] as StoredAttachment;
}

export async function setAttachmentState(
  id: string,
  scanState: AttachmentRecord["scanState"],
) {
  if (!isAzureSqlConfigured()) {
    const item = memory().attachments.find((a) => a.id === id);
    if (!item) throw new Error("NOT_FOUND");
    const parent = memory().requests.find((request) => request.id === item.requestId);
    item.scanState =
      scanState === "Clean" &&
      parent &&
      ["Withdrawn", "Closed", "Routed to support"].includes(parent.status)
        ? "Failed"
        : scanState;
    return;
  }
  const pool = await getSqlPool();
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .input("state", sql.NVarChar(32), scanState)
    .query(
      "UPDATE a SET scan_state=CASE WHEN @state='Clean' AND r.status IN ('Withdrawn','Closed','Routed to support') THEN 'Failed' ELSE @state END,deleted_at=CASE WHEN @state='Clean' AND r.status IN ('Withdrawn','Closed','Routed to support') THEN SYSUTCDATETIME() ELSE a.deleted_at END FROM dbo.Attachments a JOIN dbo.Requests r ON r.id=a.request_id WHERE a.id=@id",
    );
}

export function putMemoryBlob(key: string, bytes: Uint8Array) {
  memory().blobs.set(key, bytes);
}
export function getMemoryBlob(key: string) {
  return memory().blobs.get(key);
}
