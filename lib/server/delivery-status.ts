import type { PulseIdentity } from "@/lib/domain";
import { requireInternalRole } from "./authorization";
import { atomicSql, getSqlPool, isAzureSqlConfigured, sql } from "./database";

type DeliveryChannel = "Email" | "Webhook" | "Communications";

export async function deliveryStatus(identity: PulseIdentity) {
  await requireInternalRole(identity, ["System admin"]);
  if (!isAzureSqlConfigured()) return [];
  return (
    await (await getSqlPool()).request().query(`
 SELECT 'Email' channel,state,COUNT(*) count,MIN(created_at) oldest FROM dbo.Notifications WHERE channel='Email' AND state IN ('Queued','Retry','Processing','Dead letter') GROUP BY state
 UNION ALL SELECT 'Webhook' channel,state,COUNT(*) count,MIN(created_at) oldest FROM dbo.WebhookDeliveries WHERE state IN ('Queued','Retry','Processing','Dead letter') GROUP BY state
 UNION ALL SELECT 'Communications' channel,state,COUNT(*) count,MIN(created_at) oldest FROM dbo.CommunicationDeliveries WHERE state IN ('Queued','Retry','Processing','Dead letter') GROUP BY state
 `)
  ).recordset as Array<{
    channel: DeliveryChannel;
    state: string;
    count: number;
    oldest: string;
  }>;
}
export async function retryDeliveries(
  identity: PulseIdentity,
  channel: DeliveryChannel,
  correlation: string,
) {
  await requireInternalRole(identity, ["System admin"]);
  if (!["Email", "Webhook", "Communications"].includes(channel))
    throw new Error("INVALID_CHANNEL");
  if (!isAzureSqlConfigured()) return { requeued: 0 };
  return atomicSql(async () => {
    const pool = await getSqlPool();
    let requeued: number;
    let reopened: number | undefined;
    if (channel === "Communications") {
      // The campaign page's retry (requeueDeadLetters) for every campaign at once, with the same two rules. The worker claims a campaign's rows only
      // while it is Sending (a Test row: unless its campaign was deleted), so nothing is requeued into a Cancelled or deleted campaign, where no one
      // would ever claim or cancel the row again. And a campaign that had completed (Sent) and has a real row waiting again is Sending again, in the
      // same unit of work, with its completion undone: a Sent campaign with a real row waiting would otherwise never be sent. A Test row alone does
      // not reopen a campaign.
      const result = await pool
        .request()
        .query(
          `UPDATE TOP(100) d SET state='Queued',attempt_count=0,next_attempt_at=NULL,last_error_code=NULL OUTPUT INSERTED.id
            FROM dbo.CommunicationDeliveries d JOIN dbo.Communications c ON c.id=d.communication_id AND c.status<>'Cancelled' AND c.deleted_at IS NULL
            WHERE d.state='Dead letter'`,
        );
      requeued = result.recordset.length;
      reopened = 0;
      if (requeued) {
        const reopen = await pool
          .request()
          .query(
            `UPDATE c SET status='Sending',completed_at=NULL,updated_at=SYSUTCDATETIME()
              FROM dbo.Communications c
              WHERE c.status='Sent' AND c.deleted_at IS NULL
                AND EXISTS (SELECT 1 FROM dbo.CommunicationDeliveries d WHERE d.communication_id=c.id AND d.source<>'Test' AND d.state IN ('Queued','Retry','Processing'))`,
          );
        reopened = reopen.rowsAffected[0];
      }
    } else {
      const result = await pool
        .request()
        .query(
          `UPDATE TOP(100) dbo.${channel === "Email" ? "Notifications" : "WebhookDeliveries"} SET state='Retry',attempt_count=0,next_attempt_at=SYSUTCDATETIME(),last_error_code=NULL OUTPUT INSERTED.id WHERE state='Dead letter' ${channel === "Email" ? "AND channel='Email'" : ""}`,
        );
      requeued = result.recordset.length;
    }
    await pool
      .request()
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("correlation", sql.UniqueIdentifier, correlation)
      .input(
        "after",
        sql.NVarChar(sql.MAX),
        JSON.stringify({
          channel,
          count: requeued,
          ...(reopened === undefined ? {} : { reopened }),
        }),
      )
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,after_json,correlation_id) VALUES(NEWID(),@actor,'delivery.retry.requested','Delivery',@after,@correlation)",
      );
    return { requeued };
  });
}
