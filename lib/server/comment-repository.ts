import type { PulseIdentity } from "@/lib/domain";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";
import { listAttachments, listRequests } from "./request-repository";

export type CommentRecord = {
  id: string;
  author: string;
  body: string;
  visibility: "Customer" | "Internal";
  createdAt: string;
  editedAt?: string;
  removed?: boolean;
  canEdit?: boolean;
  attachments?: Array<{
    id: string;
    fileName: string;
    sizeBytes: number;
    scanState: string;
  }>;
};
type MemoryComment = CommentRecord & {
  requestId: string;
  organizationId: string;
  authorId: string;
  revisions: string[];
};
declare global {
  var pulseMemoryComments: MemoryComment[] | undefined;
}
function memory() {
  globalThis.pulseMemoryComments ||= [];
  return globalThis.pulseMemoryComments;
}

async function canWriteInternal(identity: PulseIdentity) {
  if (!isAzureSqlConfigured()) return identity.isInternal;
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, identity.id)
    .query(
      "SELECT TOP (1) 1 allowed FROM dbo.Memberships m JOIN dbo.Organizations o ON o.id=m.organization_id WHERE m.user_id=@userId AND m.status='Active' AND o.type='Internal' AND m.role IN ('Product manager','System admin','Internal contributor')",
    );
  return result.recordset.length > 0;
}

export async function listComments(
  identity: PulseIdentity,
  requestId: string,
  includeInternal = false,
) {
  if (!(await listRequests(identity)).some((item) => item.id === requestId))
    throw new Error("NOT_FOUND");
  const internal = includeInternal && (await canWriteInternal(identity));
  if (!isAzureSqlConfigured())
    return memory()
      .filter(
        (item) =>
          item.requestId === requestId &&
          item.organizationId === identity.organizationId &&
          (internal || item.visibility === "Customer"),
      )
      .map((item) => ({
        ...item,
        body: item.removed ? "[Comment removed]" : item.body,
        canEdit:
          !item.removed &&
          (item.authorId === identity.id || Boolean(identity.isInternal)),
      }));
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("requestId", sql.NVarChar(32), requestId)
    .input("organizationId", sql.NVarChar(32), identity.organizationId)
    .input("internal", sql.Bit, internal)
    .input("userId", sql.UniqueIdentifier, identity.id)
    .query(
      "SELECT CAST(c.id AS nvarchar(36)) id,u.display_name author,CASE WHEN c.deleted_at IS NULL THEN c.body ELSE N'[Comment removed]' END body,c.visibility,c.created_at createdAt,c.edited_at editedAt,CAST(CASE WHEN c.deleted_at IS NULL THEN 0 ELSE 1 END AS bit) removed,CAST(CASE WHEN c.deleted_at IS NULL AND (c.author_user_id=@userId OR @internal=1) THEN 1 ELSE 0 END AS bit) canEdit,JSON_QUERY((SELECT CAST(a.id AS nvarchar(36)) id,a.file_name fileName,a.size_bytes sizeBytes,a.scan_state scanState FROM dbo.CommentAttachments ca JOIN dbo.Attachments a ON a.id=ca.attachment_id AND a.deleted_at IS NULL WHERE ca.comment_id=c.id FOR JSON PATH)) attachments FROM dbo.Comments c JOIN dbo.Requests r ON r.id=c.parent_id JOIN dbo.Users u ON u.id=c.author_user_id WHERE c.parent_type='Request' AND r.public_id=@requestId AND r.organization_id=@organizationId AND (c.visibility='Customer' OR @internal=1) ORDER BY c.created_at",
    );
  return result.recordset.map((row) => ({
    ...row,
    attachments:
      typeof row.attachments === "string"
        ? JSON.parse(row.attachments)
        : row.attachments || [],
  }));
}

export async function addComment(
  identity: PulseIdentity,
  requestId: string,
  body: string,
  visibility: "Customer" | "Internal",
  attachmentIds: string[] = [],
) {
  if (!body.trim() || body.length > 5000) throw new Error("INVALID_COMMENT");
  if (visibility === "Internal" && !(await canWriteInternal(identity)))
    throw new Error("FORBIDDEN");
  if (!(await listRequests(identity)).some((item) => item.id === requestId))
    throw new Error("NOT_FOUND");
  const uniqueAttachmentIds = [...new Set(attachmentIds)].slice(0, 5);
  if (uniqueAttachmentIds.length !== attachmentIds.length)
    throw new Error("INVALID_COMMENT_ATTACHMENTS");
  const availableAttachments = uniqueAttachmentIds.length
    ? await listAttachments(identity, requestId)
    : [];
  if (
    uniqueAttachmentIds.some(
      (id) => !availableAttachments.some((attachment) => attachment.id === id),
    )
  )
    throw new Error("NOT_FOUND");
  const item: CommentRecord = {
    id: crypto.randomUUID(),
    author: identity.name,
    body: body.trim(),
    visibility,
    createdAt: new Date().toISOString(),
    attachments: availableAttachments.map((attachment) => ({
      id: attachment.id,
      fileName: attachment.fileName,
      sizeBytes: attachment.sizeBytes,
      scanState: attachment.scanState,
    })),
  };
  if (!isAzureSqlConfigured()) {
    memory().push({
      ...item,
      requestId,
      organizationId: identity.organizationId,
      authorId: identity.id,
      revisions: [],
    });
    return item;
  }
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, item.id)
    .input("requestId", sql.NVarChar(32), requestId)
    .input("organizationId", sql.NVarChar(32), identity.organizationId)
    .input("author", sql.UniqueIdentifier, identity.id)
    .input("visibility", sql.NVarChar(32), visibility)
    .input("body", sql.NVarChar(sql.MAX), item.body)
    .query(
      "INSERT dbo.Comments(id,parent_type,parent_id,organization_id,author_user_id,visibility,body) SELECT @id,'Request',r.id,@organizationId,@author,@visibility,@body FROM dbo.Requests r WHERE r.public_id=@requestId AND r.organization_id=@organizationId; SELECT @@ROWCOUNT affected",
    );
  if (!result.recordset[0].affected) throw new Error("NOT_FOUND");
  if (uniqueAttachmentIds.length)
    await pool
      .request()
      .input("commentId", sql.UniqueIdentifier, item.id)
      .input("ids", sql.NVarChar(sql.MAX), JSON.stringify(uniqueAttachmentIds))
      .input("requestId", sql.NVarChar(32), requestId)
      .input("organizationId", sql.NVarChar(32), identity.organizationId)
      .query(
        "INSERT dbo.CommentAttachments(comment_id,attachment_id) SELECT @commentId,a.id FROM dbo.Attachments a JOIN dbo.Requests r ON r.id=a.request_id WHERE a.id IN(SELECT TRY_CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@ids)) AND r.public_id=@requestId AND a.organization_id=@organizationId AND a.deleted_at IS NULL",
      );
  await pool
    .request()
    .input("auditId", sql.UniqueIdentifier, crypto.randomUUID())
    .input("actor", sql.UniqueIdentifier, identity.id)
    .input("organizationId", sql.NVarChar(32), identity.organizationId)
    .input("entity", sql.UniqueIdentifier, item.id)
    .input(
      "after",
      sql.NVarChar(sql.MAX),
      JSON.stringify({ requestId, visibility }),
    )
    .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
    .query(
      "INSERT dbo.AuditEvents(id,actor_user_id,organization_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@auditId,@actor,@organizationId,'comment.created','Comment',@entity,@after,@correlation)",
    );
  if (visibility === "Internal") {
    const candidates = await pool
      .request()
      .input("organizationId", sql.NVarChar(32), identity.organizationId)
      .query(
        "SELECT DISTINCT u.id,u.display_name name FROM dbo.Users u JOIN dbo.Memberships internalMembership ON internalMembership.user_id=u.id AND internalMembership.status='Active' JOIN dbo.Organizations internalOrganization ON internalOrganization.id=internalMembership.organization_id AND internalOrganization.type='Internal' WHERE u.status='Active' AND EXISTS(SELECT 1 FROM dbo.Memberships customerMembership WHERE customerMembership.user_id=u.id AND customerMembership.organization_id=@organizationId AND customerMembership.status='Active')",
      );
    const normalized = item.body.toLocaleLowerCase();
    for (const mentioned of candidates.recordset.filter((user) =>
      normalized.includes(`@${String(user.name).toLocaleLowerCase()}`),
    ))
      await pool
        .request()
        .input("userId", sql.UniqueIdentifier, mentioned.id)
        .input("organizationId", sql.NVarChar(32), identity.organizationId)
        .input("dedup", sql.NVarChar(255), `comment-mention-${item.id}`)
        .query(
          "INSERT dbo.Notifications(id,user_id,organization_id,event_type,channel,template,deduplication_key) SELECT NEWID(),@userId,@organizationId,'comment.mention',channel,'comment-mentioned',@dedup FROM (VALUES('In-app'),('Email')) channels(channel) WHERE NOT EXISTS(SELECT 1 FROM dbo.Notifications n WHERE n.user_id=@userId AND n.channel=channels.channel AND n.deduplication_key=@dedup)",
        );
  }
  return item;
}

async function getMutableComment(
  identity: PulseIdentity,
  requestId: string,
  commentId: string,
) {
  if (!(await listRequests(identity)).some((item) => item.id === requestId))
    throw new Error("NOT_FOUND");
  const internal = await canWriteInternal(identity);
  if (!isAzureSqlConfigured()) {
    const item = memory().find(
      (comment) =>
        comment.id === commentId &&
        comment.requestId === requestId &&
        comment.organizationId === identity.organizationId,
    );
    if (!item || item.removed) throw new Error("NOT_FOUND");
    if (item.authorId !== identity.id && !internal)
      throw new Error("NOT_FOUND");
    if (
      item.authorId === identity.id &&
      !internal &&
      Date.now() - new Date(item.createdAt).getTime() > 15 * 60_000
    )
      throw new Error("INVALID_COMMENT_EDIT_WINDOW_EXPIRED");
    return { item, internal };
  }
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("commentId", sql.UniqueIdentifier, commentId)
    .input("requestId", sql.NVarChar(32), requestId)
    .input("organizationId", sql.NVarChar(32), identity.organizationId)
    .query(
      "SELECT c.id,c.body,c.author_user_id authorId,c.created_at createdAt FROM dbo.Comments c JOIN dbo.Requests r ON r.id=c.parent_id WHERE c.id=@commentId AND r.public_id=@requestId AND r.organization_id=@organizationId AND c.deleted_at IS NULL",
    );
  if (!result.recordset.length) throw new Error("NOT_FOUND");
  const item = result.recordset[0];
  if (String(item.authorId) !== identity.id && !internal)
    throw new Error("NOT_FOUND");
  if (
    String(item.authorId) === identity.id &&
    !internal &&
    Date.now() - new Date(item.createdAt).getTime() > 15 * 60_000
  )
    throw new Error("INVALID_COMMENT_EDIT_WINDOW_EXPIRED");
  return { item, internal };
}

export async function editComment(
  identity: PulseIdentity,
  requestId: string,
  commentId: string,
  body: string,
) {
  if (!body.trim() || body.length > 5000) throw new Error("INVALID_COMMENT");
  const mutable = await getMutableComment(identity, requestId, commentId);
  if (!isAzureSqlConfigured()) {
    mutable.item.revisions.push(mutable.item.body);
    mutable.item.body = body.trim();
    mutable.item.editedAt = new Date().toISOString();
    globalThis.pulseMemoryAudit ||= [];
    globalThis.pulseMemoryAudit.unshift({
      id: crypto.randomUUID(),
      actor: identity.name,
      organizationId: identity.organizationId,
      action: "comment.edited",
      entityType: "Comment",
      entityId: commentId,
      before: { body: mutable.item.revisions.at(-1) },
      after: { body: mutable.item.body },
      correlationId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    return mutable.item;
  }
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, crypto.randomUUID())
      .input("commentId", sql.UniqueIdentifier, commentId)
      .input("body", sql.NVarChar(sql.MAX), mutable.item.body)
      .input("actor", sql.UniqueIdentifier, identity.id)
      .query(
        "INSERT dbo.CommentRevisions(id,comment_id,revision_number,body,changed_by_user_id) SELECT @id,@commentId,COALESCE(MAX(revision_number),0)+1,@body,@actor FROM dbo.CommentRevisions WHERE comment_id=@commentId",
      );
    await new sql.Request(transaction)
      .input("commentId", sql.UniqueIdentifier, commentId)
      .input("body", sql.NVarChar(sql.MAX), body.trim())
      .query(
        "UPDATE dbo.Comments SET body=@body,edited_at=SYSUTCDATETIME() WHERE id=@commentId",
      );
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("entity", sql.UniqueIdentifier, commentId)
      .input(
        "before",
        sql.NVarChar(sql.MAX),
        JSON.stringify({ body: mutable.item.body }),
      )
      .input(
        "after",
        sql.NVarChar(sql.MAX),
        JSON.stringify({ body: body.trim() }),
      )
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,organization_id,action,entity_type,entity_id,before_json,after_json,correlation_id) VALUES(@id,@actor,NULL,'comment.edited','Comment',@entity,@before,@after,@correlation)",
      );
    await transaction.commit();
    return {
      id: commentId,
      body: body.trim(),
      editedAt: new Date().toISOString(),
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function removeComment(
  identity: PulseIdentity,
  requestId: string,
  commentId: string,
  reason: string,
) {
  const mutable = await getMutableComment(identity, requestId, commentId);
  if (mutable.internal && !reason.trim())
    throw new Error("INVALID_MODERATION_REASON_REQUIRED");
  if (!isAzureSqlConfigured()) {
    mutable.item.revisions.push(mutable.item.body);
    mutable.item.removed = true;
    mutable.item.body = "[Comment removed]";
    mutable.item.canEdit = false;
    globalThis.pulseMemoryAudit ||= [];
    globalThis.pulseMemoryAudit.unshift({
      id: crypto.randomUUID(),
      actor: identity.name,
      organizationId: identity.organizationId,
      action: "comment.removed",
      entityType: "Comment",
      entityId: commentId,
      before: { body: mutable.item.revisions.at(-1) },
      after: { reason: reason.trim() || "Removed by author" },
      correlationId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    return { id: commentId, removed: true };
  }
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    await new sql.Request(transaction)
      .input("revisionId", sql.UniqueIdentifier, crypto.randomUUID())
      .input("commentId", sql.UniqueIdentifier, commentId)
      .input("body", sql.NVarChar(sql.MAX), mutable.item.body)
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("reason", sql.NVarChar(500), reason.trim() || "Removed by author")
      .query(
        "INSERT dbo.CommentRevisions(id,comment_id,revision_number,body,changed_by_user_id) SELECT @revisionId,@commentId,COALESCE(MAX(revision_number),0)+1,@body,@actor FROM dbo.CommentRevisions WHERE comment_id=@commentId;UPDATE dbo.Comments SET deleted_at=SYSUTCDATETIME(),deleted_by_user_id=@actor,deletion_reason=@reason WHERE id=@commentId",
      );
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("entity", sql.UniqueIdentifier, commentId)
      .input(
        "before",
        sql.NVarChar(sql.MAX),
        JSON.stringify({ body: mutable.item.body }),
      )
      .input(
        "after",
        sql.NVarChar(sql.MAX),
        JSON.stringify({
          removed: true,
          reason: reason.trim() || "Removed by author",
        }),
      )
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,entity_id,before_json,after_json,correlation_id) VALUES(@id,@actor,'comment.removed','Comment',@entity,@before,@after,@correlation)",
      );
    await transaction.commit();
    return { id: commentId, removed: true };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
