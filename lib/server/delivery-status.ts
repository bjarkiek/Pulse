import type { PulseIdentity } from "@/lib/domain";
import { requireInternalRole } from "./authorization";
import { atomicSql, getSqlPool, isAzureSqlConfigured, sql } from "./database";

export async function deliveryStatus(identity: PulseIdentity) {
  await requireInternalRole(identity, ["System admin"]);
  if (!isAzureSqlConfigured()) return [];
  return (
    await (await getSqlPool()).request().query(`
 SELECT 'Email' channel,state,COUNT(*) count,MIN(created_at) oldest FROM dbo.Notifications WHERE channel='Email' AND state IN ('Queued','Retry','Processing','Dead letter') GROUP BY state
 UNION ALL SELECT 'Webhook' channel,state,COUNT(*) count,MIN(created_at) oldest FROM dbo.WebhookDeliveries WHERE state IN ('Queued','Retry','Processing','Dead letter') GROUP BY state
 `)
  ).recordset as Array<{
    channel: "Email" | "Webhook";
    state: string;
    count: number;
    oldest: string;
  }>;
}
export async function retryDeliveries(
  identity: PulseIdentity,
  channel: "Email" | "Webhook",
  correlation: string,
) {
  await requireInternalRole(identity, ["System admin"]);
  if (!["Email", "Webhook"].includes(channel))
    throw new Error("INVALID_CHANNEL");
  if (!isAzureSqlConfigured()) return { requeued: 0 };
  return atomicSql(async () => {
    const pool = await getSqlPool();
    const result = await pool
      .request()
      .query(
        `UPDATE TOP(100) dbo.${channel === "Email" ? "Notifications" : "WebhookDeliveries"} SET state='Retry',attempt_count=0,next_attempt_at=SYSUTCDATETIME(),last_error_code=NULL OUTPUT INSERTED.id WHERE state='Dead letter' ${channel === "Email" ? "AND channel='Email'" : ""}`,
      );
    await pool
      .request()
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("correlation", sql.UniqueIdentifier, correlation)
      .input(
        "after",
        sql.NVarChar(sql.MAX),
        JSON.stringify({ channel, count: result.recordset.length }),
      )
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,after_json,correlation_id) VALUES(NEWID(),@actor,'delivery.retry.requested','Delivery',@after,@correlation)",
      );
    return { requeued: result.recordset.length };
  });
}
