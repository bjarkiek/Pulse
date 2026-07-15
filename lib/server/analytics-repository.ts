import type { PulseIdentity } from "@/lib/domain";
import { requireInternalRole } from "./authorization";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";
import { listRequests } from "./request-repository";

function csvValue(value: unknown) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

export async function exportAuthorizedRequests(identity: PulseIdentity) {
  await requireInternalRole(identity);
  let rows: Array<Record<string, unknown>>;
  if (!isAzureSqlConfigured()) {
    rows = await listRequests(identity);
    globalThis.pulseMemoryAudit ||= [];
    globalThis.pulseMemoryAudit.unshift({
      id: crypto.randomUUID(),
      actor: identity.name,
      organizationId: identity.organizationId,
      action: "analytics.requests.exported",
      entityType: "Export",
      after: { rowCount: rows.length },
      correlationId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
  } else {
    const pool = await getSqlPool();
    const result = await pool
      .request()
      .input("userId", sql.UniqueIdentifier, identity.id).query(`
        SELECT r.public_id id,r.title,r.product_area area,r.request_type requestType,
          r.impact,r.status,r.visibility,o.name organization,r.created_at createdAt
        FROM dbo.Requests r
        JOIN dbo.Organizations o ON o.id=r.organization_id AND o.is_test=0
        JOIN dbo.Memberships m ON m.organization_id=r.organization_id
          AND m.user_id=@userId AND m.status='Active'
        WHERE r.deleted_at IS NULL
        ORDER BY r.created_at DESC`);
    rows = result.recordset;
    await pool
      .request()
      .input("id", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input(
        "organizationId",
        sql.NVarChar(32),
        identity.organizationId || null,
      )
      .input(
        "after",
        sql.NVarChar(sql.MAX),
        JSON.stringify({ rowCount: rows.length }),
      )
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,organization_id,action,entity_type,after_json,correlation_id) VALUES(@id,@actor,@organizationId,'analytics.requests.exported','Export',@after,@correlation)",
      );
  }
  const headings = [
    "Request",
    "Title",
    "Product area",
    "Request type",
    "Impact",
    "Status",
    "Visibility",
    "Organization",
    "Created",
  ];
  const body = rows.map((row) =>
    [
      row.id,
      row.title,
      row.area,
      row.requestType,
      row.impact,
      row.status,
      row.visibility,
      row.organization,
      row.createdAt || row.submitted,
    ]
      .map(csvValue)
      .join(","),
  );
  return `\uFEFF${[headings.map(csvValue).join(","), ...body].join("\r\n")}`;
}

export async function getAnalyticsSummary(identity: PulseIdentity) {
  await requireInternalRole(identity);
  if (!isAzureSqlConfigured()) {
    const requests = await listRequests(identity);
    const notifications = globalThis.pulseMemoryNotifications || [];
    return {
      requests: {
        total: requests.length,
        open: requests.filter(
          (item) => !["Closed", "Withdrawn", "Routed to support"].includes(item.status),
        ).length,
      },
      areas: Object.entries(
        requests.reduce<Record<string, number>>((counts, item) => {
          counts[item.area || "Unclassified"] =
            (counts[item.area || "Unclassified"] || 0) + 1;
          return counts;
        }, {}),
      ).map(([area, count]) => ({ area, count })),
      serviceLevels: { averageFirstResponseHours: 0, averageTriageHours: 0 },
      notifications: Object.entries(
        notifications.reduce<Record<string, number>>((counts, item) => {
          counts[item.state] = (counts[item.state] || 0) + 1;
          return counts;
        }, {}),
      ).map(([state, count]) => ({ state, count })),
      dataQuality: {
        missingOwner: requests.filter((item) => item.owner === "Unassigned").length,
        missingClassification: requests.filter((item) => !item.area).length,
      },
    };
  }
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, identity.id).query(`
      SELECT COUNT(*) total,SUM(CASE WHEN r.status NOT IN ('Closed','Withdrawn','Routed to support') THEN 1 ELSE 0 END) [open]
      FROM dbo.Requests r JOIN dbo.Organizations o ON o.id=r.organization_id AND o.is_test=0
      JOIN dbo.Memberships m ON m.organization_id=r.organization_id AND m.user_id=@userId AND m.status='Active'
      WHERE r.deleted_at IS NULL;
      SELECT COALESCE(r.product_area,'Unclassified') area,COUNT(*) [count]
      FROM dbo.Requests r JOIN dbo.Organizations o ON o.id=r.organization_id AND o.is_test=0
      JOIN dbo.Memberships m ON m.organization_id=r.organization_id AND m.user_id=@userId AND m.status='Active'
      WHERE r.deleted_at IS NULL GROUP BY r.product_area ORDER BY [count] DESC;
      SELECT COALESCE(AVG(CASE WHEN r.first_response_at IS NOT NULL THEN DATEDIFF(minute,r.created_at,r.first_response_at)/60.0 END),0) averageFirstResponseHours,
        COALESCE(AVG(CASE WHEN r.triaged_at IS NOT NULL THEN DATEDIFF(minute,r.created_at,r.triaged_at)/60.0 END),0) averageTriageHours
      FROM dbo.Requests r JOIN dbo.Organizations o ON o.id=r.organization_id AND o.is_test=0
      JOIN dbo.Memberships m ON m.organization_id=r.organization_id AND m.user_id=@userId AND m.status='Active'
      WHERE r.deleted_at IS NULL;
      SELECT n.state,COUNT(*) [count] FROM dbo.Notifications n
      JOIN dbo.Memberships m ON m.organization_id=n.organization_id AND m.user_id=@userId AND m.status='Active'
      GROUP BY n.state ORDER BY [count] DESC;
      SELECT SUM(CASE WHEN r.owner_user_id IS NULL THEN 1 ELSE 0 END) missingOwner,
        SUM(CASE WHEN r.product_area IS NULL OR LTRIM(RTRIM(r.product_area))='' THEN 1 ELSE 0 END) missingClassification
      FROM dbo.Requests r JOIN dbo.Organizations o ON o.id=r.organization_id AND o.is_test=0
      JOIN dbo.Memberships m ON m.organization_id=r.organization_id AND m.user_id=@userId AND m.status='Active'
      WHERE r.deleted_at IS NULL;`);
  const recordsets = result.recordsets as unknown as Array<
    Array<Record<string, unknown>>
  >;
  return {
    requests:
      (recordsets[0][0] as { total: number; open: number } | undefined) ||
      { total: 0, open: 0 },
    areas: recordsets[1] as Array<{ area: string; count: number }>,
    serviceLevels:
      (recordsets[2][0] as
        | {
            averageFirstResponseHours: number;
            averageTriageHours: number;
          }
        | undefined) || {
      averageFirstResponseHours: 0,
      averageTriageHours: 0,
    },
    notifications: recordsets[3] as Array<{ state: string; count: number }>,
    dataQuality:
      (recordsets[4][0] as
        | { missingOwner: number; missingClassification: number }
        | undefined) || {
      missingOwner: 0,
      missingClassification: 0,
    },
  };
}
