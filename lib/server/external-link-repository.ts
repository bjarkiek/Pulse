import type { PulseIdentity } from "@/lib/domain";
import { requireInternalRole } from "./authorization";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";
import { getProductMemory } from "./product-repository";

export type ExternalLinkRecord = {
  id: string;
  ideaId: string;
  label: string;
  url: string;
  createdAt: string;
};

declare global {
  var pulseMemoryExternalLinks: ExternalLinkRecord[] | undefined;
}

function links() {
  globalThis.pulseMemoryExternalLinks ||= [];
  return globalThis.pulseMemoryExternalLinks;
}

function validateUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") throw new Error();
    return parsed.toString();
  } catch {
    throw new Error("INVALID_EXTERNAL_LINK_URL");
  }
}

export async function listExternalLinks(
  identity: PulseIdentity,
  ideaPublicId: string,
) {
  await requireInternalRole(identity);
  if (!isAzureSqlConfigured()) {
    if (!getProductMemory().some((idea) => idea.id === ideaPublicId))
      throw new Error("NOT_FOUND");
    return links().filter((link) => link.ideaId === ideaPublicId);
  }
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("idea", sql.NVarChar(32), ideaPublicId)
    .query(
      "SELECT CAST(el.id AS nvarchar(36)) id,i.public_id ideaId,el.label,el.url,el.created_at createdAt FROM dbo.Ideas i LEFT JOIN dbo.ExternalLinks el ON el.idea_id=i.id AND el.deleted_at IS NULL WHERE i.public_id=@idea AND i.deleted_at IS NULL ORDER BY el.created_at",
    );
  if (!result.recordset.length) throw new Error("NOT_FOUND");
  return result.recordset.filter((row) => row.id);
}

export async function addExternalLink(
  identity: PulseIdentity,
  ideaPublicId: string,
  input: { label: string; url: string },
) {
  await requireInternalRole(identity, ["Product manager", "System admin"]);
  if (!input.label?.trim()) throw new Error("INVALID_EXTERNAL_LINK_LABEL");
  const url = validateUrl(input.url);
  if (!isAzureSqlConfigured()) {
    if (!getProductMemory().some((idea) => idea.id === ideaPublicId))
      throw new Error("NOT_FOUND");
    const item = {
      id: crypto.randomUUID(),
      ideaId: ideaPublicId,
      label: input.label.trim(),
      url,
      createdAt: new Date().toISOString(),
    };
    links().push(item);
    globalThis.pulseMemoryAudit ||= [];
    globalThis.pulseMemoryAudit.unshift({
      id: crypto.randomUUID(),
      actor: identity.name,
      organizationId: identity.organizationId,
      action: "external-link.created",
      entityType: "Idea",
      entityId: ideaPublicId,
      after: item,
      correlationId: crypto.randomUUID(),
      createdAt: item.createdAt,
    });
    return item;
  }
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, crypto.randomUUID())
    .input("idea", sql.NVarChar(32), ideaPublicId)
    .input("label", sql.NVarChar(100), input.label.trim())
    .input("url", sql.NVarChar(2000), url)
    .input("actor", sql.UniqueIdentifier, identity.id).query(`
      INSERT dbo.ExternalLinks(id,idea_id,label,url,created_by_user_id)
      OUTPUT CAST(INSERTED.id AS nvarchar(36)) id,@idea ideaId,INSERTED.label,INSERTED.url,INSERTED.created_at createdAt
      SELECT @id,i.id,@label,@url,@actor FROM dbo.Ideas i WHERE i.public_id=@idea AND i.deleted_at IS NULL;`);
  if (!result.recordset.length) throw new Error("NOT_FOUND");
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, crypto.randomUUID())
    .input("actor", sql.UniqueIdentifier, identity.id)
    .input("entity", sql.NVarChar(36), result.recordset[0].id)
    .input("after", sql.NVarChar(sql.MAX), JSON.stringify(result.recordset[0]))
    .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
    .query(
      "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@id,@actor,'external-link.created','ExternalLink',TRY_CONVERT(uniqueidentifier,@entity),@after,@correlation)",
    );
  return result.recordset[0];
}

export async function removeExternalLink(
  identity: PulseIdentity,
  ideaPublicId: string,
  linkId: string,
) {
  await requireInternalRole(identity, ["Product manager", "System admin"]);
  if (!isAzureSqlConfigured()) {
    const index = links().findIndex(
      (link) => link.id === linkId && link.ideaId === ideaPublicId,
    );
    if (index < 0) throw new Error("NOT_FOUND");
    const [item] = links().splice(index, 1);
    globalThis.pulseMemoryAudit ||= [];
    globalThis.pulseMemoryAudit.unshift({
      id: crypto.randomUUID(),
      actor: identity.name,
      organizationId: identity.organizationId,
      action: "external-link.deleted",
      entityType: "Idea",
      entityId: ideaPublicId,
      before: item,
      correlationId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    return { deleted: true, item };
  }
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, linkId)
    .input("idea", sql.NVarChar(32), ideaPublicId)
    .query(
      "UPDATE el SET deleted_at=SYSUTCDATETIME() OUTPUT INSERTED.id FROM dbo.ExternalLinks el JOIN dbo.Ideas i ON i.id=el.idea_id WHERE el.id=@id AND i.public_id=@idea AND el.deleted_at IS NULL",
    );
  if (!result.recordset.length) throw new Error("NOT_FOUND");
  await pool
    .request()
    .input("auditId", sql.UniqueIdentifier, crypto.randomUUID())
    .input("actor", sql.UniqueIdentifier, identity.id)
    .input("entity", sql.UniqueIdentifier, linkId)
    .input(
      "before",
      sql.NVarChar(sql.MAX),
      JSON.stringify({ ideaId: ideaPublicId, linkId }),
    )
    .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
    .query(
      "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,entity_id,before_json,correlation_id) VALUES(@auditId,@actor,'external-link.deleted','ExternalLink',@entity,@before,@correlation)",
    );
  return { deleted: true };
}
