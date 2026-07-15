import type { PulseIdentity, Tone } from "@/lib/domain";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";

export type IdeaRecord = {
  id: string;
  title: string;
  description: string;
  area: string;
  status: string;
  tone: Tone;
  horizon: "Now" | "Next" | "Later" | "Released";
  organizations: number;
  followers: number;
  updated: string;
  followed?: boolean;
};

const seed: IdeaRecord[] = [
  {
    id: "IDEA-318",
    title: "Audit log API",
    description:
      "Provide governed API access to tenant, authentication, report, and administrative audit events.",
    area: "Governance",
    status: "Planned",
    tone: "violet",
    horizon: "Next",
    organizations: 8,
    followers: 23,
    updated: "Updated 2 days ago",
    followed: true,
  },
  {
    id: "IDEA-327",
    title: "Scheduled report delivery to SharePoint",
    description:
      "Deliver governed PDF and Excel exports to a selected SharePoint library on a schedule.",
    area: "Distribution",
    status: "Under review",
    tone: "neutral",
    horizon: "Later",
    organizations: 5,
    followers: 14,
    updated: "Updated yesterday",
  },
  {
    id: "IDEA-301",
    title: "Display playlist scheduler",
    description:
      "Schedule screen playlists by day, time, tenant, and audience with clear override rules.",
    area: "Display",
    status: "In progress",
    tone: "violet",
    horizon: "Now",
    organizations: 6,
    followers: 18,
    updated: "Updated today",
    followed: true,
  },
  {
    id: "IDEA-284",
    title: "Self-service report keys",
    description:
      "Let delegated tenant administrators create and rotate report keys within governed policies.",
    area: "Administration",
    status: "Considering",
    tone: "neutral",
    horizon: "Later",
    organizations: 4,
    followers: 11,
    updated: "Updated 6 days ago",
  },
  {
    id: "IDEA-276",
    title: "Mobile dashboard improvements",
    description:
      "Improve navigation, filter behavior, and portrait layouts for embedded dashboards on mobile devices.",
    area: "Experience",
    status: "Released",
    tone: "success",
    horizon: "Released",
    organizations: 11,
    followers: 31,
    updated: "Released 8 July",
  },
  {
    id: "IDEA-312",
    title: "Entra group synchronization controls",
    description:
      "Add synchronization health, retry controls, and a clear history for group-based access changes.",
    area: "Authentication",
    status: "Planned",
    tone: "violet",
    horizon: "Next",
    organizations: 7,
    followers: 16,
    updated: "Updated 4 days ago",
  },
  {
    id: "IDEA-264",
    title: "Power BI app embedding",
    description:
      "Embed complete Power BI apps while preserving DataCentral authentication and access governance.",
    area: "Embedding",
    status: "Released",
    tone: "success",
    horizon: "Released",
    organizations: 9,
    followers: 27,
    updated: "Released 24 June",
  },
];

declare global {
  var pulseMemoryIdeas: IdeaRecord[] | undefined;
}
export function getIdeaMemory() {
  globalThis.pulseMemoryIdeas ||= structuredClone(seed);
  return globalThis.pulseMemoryIdeas;
}
function memory() {
  return getIdeaMemory();
}
function tone(status: string): Tone {
  return status === "Released"
    ? "success"
    : ["Planned", "In progress"].includes(status)
      ? "violet"
      : "neutral";
}

export async function listIdeas(
  identity: PulseIdentity,
): Promise<IdeaRecord[]> {
  if (!isAzureSqlConfigured()) return memory();
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, identity.id)
    .input("organizationId", sql.NVarChar(32), identity.organizationId).query(`
    SELECT i.public_id id,COALESCE(i.published_title,i.internal_title) title,COALESCE(i.published_description,i.internal_description) description,
      COALESCE(i.product_area,'Unclassified') area,COALESCE(i.published_status,i.status) status,COALESCE(i.roadmap_horizon,'Later') horizon,
      COUNT(DISTINCT CASE WHEN oi.active=1 THEN oi.organization_id END) organizations,
      COUNT(DISTINCT CASE WHEN f.active=1 THEN f.user_id END) followers,
      MAX(CASE WHEN mine.active=1 THEN 1 ELSE 0 END) followed,i.updated_at
    FROM dbo.Ideas i
    LEFT JOIN dbo.OrganizationInterests oi ON oi.idea_id=i.id
    LEFT JOIN dbo.Follows f ON f.idea_id=i.id
    LEFT JOIN dbo.Follows mine ON mine.idea_id=i.id AND mine.user_id=@userId AND mine.organization_id=@organizationId
    WHERE i.publish_state='Published' AND i.deleted_at IS NULL
    GROUP BY i.public_id,i.published_title,i.internal_title,i.published_description,i.internal_description,i.product_area,i.published_status,i.status,i.roadmap_horizon,i.updated_at
    ORDER BY i.updated_at DESC`);
  return result.recordset.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    area: row.area,
    status: row.status,
    tone: tone(row.status),
    horizon: row.horizon,
    organizations: row.organizations,
    followers: row.followers,
    followed: Boolean(row.followed),
    updated: `Updated ${new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-Math.max(0, Math.floor((Date.now() - new Date(row.updated_at).getTime()) / 86400000)), "day")}`,
  }));
}

export async function getIdea(identity: PulseIdentity, publicId: string) {
  if (!isAzureSqlConfigured()) {
    const canonicalId =
      globalThis.pulseMemoryIdeaAliases?.get(publicId) || publicId;
    const item = memory().find((idea) => idea.id === canonicalId);
    if (!item) throw new Error("NOT_FOUND");
    return { item, canonicalId, redirected: canonicalId !== publicId };
  }
  const pool = await getSqlPool();
  const alias = await pool
    .request()
    .input("publicId", sql.NVarChar(32), publicId)
    .query(
      "SELECT COALESCE(i.public_id,direct.public_id) canonicalId FROM (SELECT @publicId public_id) requested LEFT JOIN dbo.IdeaAliases a ON a.alias_public_id=requested.public_id LEFT JOIN dbo.Ideas i ON i.id=a.surviving_idea_id LEFT JOIN dbo.Ideas direct ON direct.public_id=requested.public_id WHERE COALESCE(i.publish_state,direct.publish_state)='Published' AND COALESCE(i.deleted_at,direct.deleted_at) IS NULL",
    );
  if (!alias.recordset.length) throw new Error("NOT_FOUND");
  const canonicalId = alias.recordset[0].canonicalId;
  const item = (await listIdeas(identity)).find(
    (idea) => idea.id === canonicalId,
  );
  if (!item) throw new Error("NOT_FOUND");
  return { item, canonicalId, redirected: canonicalId !== publicId };
}

export async function toggleFollow(
  identity: PulseIdentity,
  publicId: string,
  recordInterest = false,
) {
  if (!isAzureSqlConfigured()) {
    const item = memory().find((idea) => idea.id === publicId);
    if (!item) throw new Error("NOT_FOUND");
    const next = recordInterest ? true : !item.followed;
    if (next !== item.followed) item.followers += next ? 1 : -1;
    item.followed = next;
    return { followed: item.followed, followers: item.followers };
  }
  const pool = await getSqlPool();
  const membership = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, identity.id)
    .input("organizationId", sql.NVarChar(32), identity.organizationId)
    .query(
      "SELECT 1 allowed FROM dbo.Memberships WHERE user_id=@userId AND organization_id=@organizationId AND status='Active'",
    );
  if (!membership.recordset.length) throw new Error("FORBIDDEN");
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const current = await new sql.Request(transaction)
      .input("idea", sql.NVarChar(32), publicId)
      .input("userId", sql.UniqueIdentifier, identity.id)
      .input("organizationId", sql.NVarChar(32), identity.organizationId)
      .query(
        "SELECT i.id,COALESCE(f.active,0) active FROM dbo.Ideas i LEFT JOIN dbo.Follows f ON f.idea_id=i.id AND f.user_id=@userId AND f.organization_id=@organizationId WHERE i.public_id=@idea AND i.publish_state='Published' AND i.deleted_at IS NULL",
      );
    if (!current.recordset.length) throw new Error("NOT_FOUND");
    const followed = recordInterest ? true : !current.recordset[0].active;
    const ideaId = current.recordset[0].id;
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, crypto.randomUUID())
      .input("ideaId", sql.UniqueIdentifier, ideaId)
      .input("userId", sql.UniqueIdentifier, identity.id)
      .input("organizationId", sql.NVarChar(32), identity.organizationId)
      .input("active", sql.Bit, followed)
      .query(
        "MERGE dbo.Follows AS target USING (SELECT @userId user_id,@organizationId organization_id,@ideaId idea_id) source ON target.user_id=source.user_id AND target.organization_id=source.organization_id AND target.idea_id=source.idea_id WHEN MATCHED THEN UPDATE SET active=@active,updated_at=SYSUTCDATETIME() WHEN NOT MATCHED THEN INSERT(id,user_id,organization_id,idea_id,active) VALUES(@id,@userId,@organizationId,@ideaId,@active);",
      );
    if (recordInterest)
      await new sql.Request(transaction)
        .input("id", sql.UniqueIdentifier, crypto.randomUUID())
        .input("ideaId", sql.UniqueIdentifier, ideaId)
        .input("userId", sql.UniqueIdentifier, identity.id)
        .input("organizationId", sql.NVarChar(32), identity.organizationId)
        .query(
          "MERGE dbo.OrganizationInterests AS target USING (SELECT @organizationId organization_id,@ideaId idea_id) source ON target.organization_id=source.organization_id AND target.idea_id=source.idea_id WHEN MATCHED THEN UPDATE SET active=1,updated_by_user_id=@userId,updated_at=SYSUTCDATETIME() WHEN NOT MATCHED THEN INSERT(id,organization_id,idea_id,active,updated_by_user_id) VALUES(@id,@organizationId,@ideaId,1,@userId);",
        );
    const count = await new sql.Request(transaction)
      .input("ideaId", sql.UniqueIdentifier, ideaId)
      .query(
        "SELECT COUNT(*) followers FROM dbo.Follows WHERE idea_id=@ideaId AND active=1",
      );
    await transaction.commit();
    return { followed, followers: count.recordset[0].followers };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
