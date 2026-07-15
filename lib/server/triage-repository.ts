import type { PulseIdentity } from "@/lib/domain";
import { requireInternalRole } from "./authorization";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";
import { listRequests } from "./request-repository";

export async function bulkUpdateTriage(
  identity: PulseIdentity,
  input: {
    requestIds: string[];
    ownerId?: string;
    tagIds?: string[];
    triageDueAt?: string;
  },
) {
  await requireInternalRole(identity, ["Product manager", "System admin"]);
  const requestIds = [...new Set(input.requestIds || [])];
  const tagIds = [...new Set(input.tagIds || [])];
  const ownerId = input.ownerId === "me" ? identity.id : input.ownerId;
  if (
    !requestIds.length ||
    requestIds.length > 100 ||
    (!ownerId && !tagIds.length && !input.triageDueAt)
  )
    throw new Error("INVALID_BULK_TRIAGE");
  const dueAt = input.triageDueAt ? new Date(input.triageDueAt) : undefined;
  if (dueAt && Number.isNaN(dueAt.getTime()))
    throw new Error("INVALID_TRIAGE_DUE_AT");

  if (!isAzureSqlConfigured()) {
    const available = await listRequests(identity);
    if (requestIds.some((id) => !available.some((item) => item.id === id)))
      throw new Error("NOT_FOUND");
    for (const item of available.filter((request) =>
      requestIds.includes(request.id),
    ))
      if (ownerId) item.owner = identity.name;
    globalThis.pulseMemoryAudit ||= [];
    globalThis.pulseMemoryAudit.unshift({
      id: crypto.randomUUID(),
      actor: identity.name,
      organizationId: identity.organizationId,
      action: "triage.bulk-updated",
      entityType: "Request",
      after: {
        requestIds,
        ownerId,
        tagCount: tagIds.length,
        triageDueAt: dueAt?.toISOString(),
      },
      correlationId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    return { updated: requestIds.length };
  }

  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const authorized = await new sql.Request(transaction)
      .input("ids", sql.NVarChar(sql.MAX), JSON.stringify(requestIds))
      .input("actor", sql.UniqueIdentifier, identity.id)
      .query(`
        SELECT r.id,r.public_id FROM dbo.Requests r
        JOIN dbo.Memberships m ON m.organization_id=r.organization_id AND m.user_id=@actor AND m.status='Active'
        WHERE r.public_id IN(SELECT [value] FROM OPENJSON(@ids)) AND r.deleted_at IS NULL;`);
    if (authorized.recordset.length !== requestIds.length)
      throw new Error("NOT_FOUND");
    if (ownerId) {
      const owner = await new sql.Request(transaction)
        .input("owner", sql.UniqueIdentifier, ownerId)
        .query(
          "SELECT TOP(1) 1 valid FROM dbo.Users u JOIN dbo.Memberships m ON m.user_id=u.id JOIN dbo.Organizations o ON o.id=m.organization_id WHERE u.id=@owner AND u.status='Active' AND m.status='Active' AND o.type='Internal'",
        );
      if (!owner.recordset.length) throw new Error("INVALID_TRIAGE_OWNER");
    }
    if (tagIds.length) {
      const tags = await new sql.Request(transaction)
        .input("tags", sql.NVarChar(sql.MAX), JSON.stringify(tagIds))
        .query(
          "SELECT id FROM dbo.TaxonomyValues WHERE id IN(SELECT TRY_CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@tags)) AND kind='Tag' AND active=1",
        );
      if (tags.recordset.length !== tagIds.length)
        throw new Error("INVALID_TRIAGE_TAG");
    }
    await new sql.Request(transaction)
      .input("ids", sql.NVarChar(sql.MAX), JSON.stringify(requestIds))
      .input("owner", sql.UniqueIdentifier, ownerId || null)
      .input("due", sql.DateTime2, dueAt || null)
      .query(
        "UPDATE dbo.Requests SET owner_user_id=COALESCE(@owner,owner_user_id),triage_due_at=COALESCE(@due,triage_due_at),updated_at=SYSUTCDATETIME() WHERE public_id IN(SELECT [value] FROM OPENJSON(@ids))",
      );
    if (tagIds.length)
      await new sql.Request(transaction)
        .input("ids", sql.NVarChar(sql.MAX), JSON.stringify(requestIds))
        .input("tags", sql.NVarChar(sql.MAX), JSON.stringify(tagIds))
        .input("actor", sql.UniqueIdentifier, identity.id).query(`
          MERGE dbo.RequestTags target
          USING(SELECT r.id request_id,t.id taxonomy_value_id FROM dbo.Requests r
            CROSS JOIN dbo.TaxonomyValues t
            WHERE r.public_id IN(SELECT [value] FROM OPENJSON(@ids))
              AND t.id IN(SELECT TRY_CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@tags))) source
          ON target.request_id=source.request_id AND target.taxonomy_value_id=source.taxonomy_value_id
          WHEN MATCHED THEN UPDATE SET active=1,assigned_by_user_id=@actor,updated_at=SYSUTCDATETIME()
          WHEN NOT MATCHED THEN INSERT(request_id,taxonomy_value_id,assigned_by_user_id)
            VALUES(source.request_id,source.taxonomy_value_id,@actor);`);
    await new sql.Request(transaction)
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("ids", sql.NVarChar(sql.MAX), JSON.stringify(requestIds))
      .input(
        "after",
        sql.NVarChar(sql.MAX),
        JSON.stringify({
          ownerId,
          tagIds,
          triageDueAt: dueAt?.toISOString(),
        }),
      )
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,organization_id,action,entity_type,entity_id,after_json,correlation_id) SELECT NEWID(),@actor,r.organization_id,'triage.bulk-updated','Request',r.id,@after,NEWID() FROM dbo.Requests r WHERE r.public_id IN(SELECT [value] FROM OPENJSON(@ids))",
      );
    await transaction.commit();
    return { updated: requestIds.length };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
