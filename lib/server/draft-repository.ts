import type { PulseIdentity } from "@/lib/domain";
import { requireMembership } from "./authorization";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";

export type RequestDraft = {
  title: string;
  problem: string;
  area: string;
  impact: string;
  visibility: "Private" | "Organization";
  requestType?: string;
  affectedUsers?: number;
  workaround?: string;
  desiredTiming?: string;
  linkedIdeaId?: string;
  updatedAt: string;
};

declare global {
  var pulseMemoryDrafts: Map<string, RequestDraft> | undefined;
}

function drafts() {
  globalThis.pulseMemoryDrafts ||= new Map();
  return globalThis.pulseMemoryDrafts;
}

function key(identity: PulseIdentity) {
  return `${identity.id}:${identity.organizationId}`;
}

export async function getRequestDraft(identity: PulseIdentity) {
  await requireMembership(identity);
  if (!isAzureSqlConfigured()) return drafts().get(key(identity)) || null;
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, identity.id)
    .input("organizationId", sql.NVarChar(32), identity.organizationId)
    .query(
      "SELECT title,problem,product_area area,impact,visibility,request_type requestType,affected_users affectedUsers,workaround,desired_timing desiredTiming,linked_idea_public_id linkedIdeaId,updated_at updatedAt FROM dbo.RequestDrafts WHERE user_id=@userId AND organization_id=@organizationId",
    );
  return result.recordset[0] || null;
}

export async function saveRequestDraft(
  identity: PulseIdentity,
  input: Partial<RequestDraft>,
) {
  await requireMembership(identity);
  if ((input.title || "").length > 140) throw new Error("INVALID_TITLE");
  if ((input.problem || "").length > 5000) throw new Error("INVALID_PROBLEM");
  const visibility = input.visibility || "Organization";
  if (!(["Private", "Organization"] as string[]).includes(visibility))
    throw new Error("INVALID_VISIBILITY");
  const item: RequestDraft = {
    title: input.title || "",
    problem: input.problem || "",
    area: input.area || "Distribution",
    impact: input.impact || "Medium",
    visibility,
    requestType: input.requestType?.trim() || undefined,
    affectedUsers:
      Number(input.affectedUsers) > 0 ? Number(input.affectedUsers) : undefined,
    workaround: input.workaround?.trim() || undefined,
    desiredTiming: input.desiredTiming?.trim() || undefined,
    linkedIdeaId: input.linkedIdeaId?.trim() || undefined,
    updatedAt: new Date().toISOString(),
  };
  if (!isAzureSqlConfigured()) {
    drafts().set(key(identity), item);
    return item;
  }
  const pool = await getSqlPool();
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, crypto.randomUUID())
    .input("userId", sql.UniqueIdentifier, identity.id)
    .input("organizationId", sql.NVarChar(32), identity.organizationId)
    .input("title", sql.NVarChar(140), item.title || null)
    .input("problem", sql.NVarChar(sql.MAX), item.problem || null)
    .input("area", sql.NVarChar(100), item.area || null)
    .input("impact", sql.NVarChar(32), item.impact || null)
    .input("visibility", sql.NVarChar(32), item.visibility)
    .input("requestType", sql.NVarChar(100), item.requestType || null)
    .input("affectedUsers", sql.Int, item.affectedUsers || null)
    .input("workaround", sql.NVarChar(sql.MAX), item.workaround || null)
    .input("desiredTiming", sql.NVarChar(200), item.desiredTiming || null)
    .input("linkedIdea", sql.NVarChar(32), item.linkedIdeaId || null).query(`
      MERGE dbo.RequestDrafts WITH (HOLDLOCK) target
      USING (SELECT @userId user_id,@organizationId organization_id) source
      ON target.user_id=source.user_id AND target.organization_id=source.organization_id
      WHEN MATCHED THEN UPDATE SET title=@title,problem=@problem,product_area=@area,
        impact=@impact,visibility=@visibility,request_type=@requestType,affected_users=@affectedUsers,
        workaround=@workaround,desired_timing=@desiredTiming,linked_idea_public_id=@linkedIdea,updated_at=SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT(id,user_id,organization_id,title,problem,product_area,impact,visibility,request_type,affected_users,workaround,desired_timing,linked_idea_public_id)
        VALUES(@id,@userId,@organizationId,@title,@problem,@area,@impact,@visibility,@requestType,@affectedUsers,@workaround,@desiredTiming,@linkedIdea);`);
  return item;
}

export async function deleteRequestDraft(identity: PulseIdentity) {
  await requireMembership(identity);
  if (!isAzureSqlConfigured()) {
    drafts().delete(key(identity));
    return;
  }
  const pool = await getSqlPool();
  await pool
    .request()
    .input("userId", sql.UniqueIdentifier, identity.id)
    .input("organizationId", sql.NVarChar(32), identity.organizationId)
    .query(
      "DELETE dbo.RequestDrafts WHERE user_id=@userId AND organization_id=@organizationId",
    );
}
