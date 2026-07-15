import { createHmac } from "node:crypto";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";
import { validateWebhookUrl } from "./webhook-repository";

type Delivery = {
  id: string;
  url: string;
  payload: string;
  attemptCount: number;
};

async function claimNext(): Promise<Delivery | null> {
  const pool = await getSqlPool();
  const result = await pool.request().query(`
    UPDATE d SET state='Suppressed',last_error_code='SubscriptionInactive'
    FROM dbo.WebhookDeliveries d JOIN dbo.WebhookSubscriptions s ON s.id=d.subscription_id
    WHERE d.state IN ('Queued','Retry') AND (s.active=0 OR s.deleted_at IS NOT NULL);
    ;WITH next_item AS (
      SELECT TOP (1) d.id FROM dbo.WebhookDeliveries d WITH (UPDLOCK,READPAST,ROWLOCK)
      JOIN dbo.WebhookSubscriptions s ON s.id=d.subscription_id AND s.active=1 AND s.deleted_at IS NULL
      WHERE d.state IN ('Queued','Retry') AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=SYSUTCDATETIME())
      ORDER BY d.created_at
    )
    UPDATE d SET state='Processing',attempt_count=attempt_count+1
    OUTPUT CAST(INSERTED.id AS nvarchar(36)) id,s.url,INSERTED.payload_json payload,INSERTED.attempt_count attemptCount
    FROM dbo.WebhookDeliveries d JOIN next_item n ON n.id=d.id
    JOIN dbo.WebhookSubscriptions s ON s.id=d.subscription_id;`);
  return result.recordset[0] || null;
}

export async function processWebhookBatch(limit = 20) {
  if (!isAzureSqlConfigured())
    return { delivered: 0, retried: 0, skipped: true };
  const secret = process.env.WEBHOOK_SIGNING_SECRET;
  if (!secret) throw new Error("INVALID_WEBHOOK_CONFIGURATION");
  const pool = await getSqlPool();
  let delivered = 0;
  let retried = 0;
  for (let index = 0; index < Math.min(Math.max(limit, 1), 100); index++) {
    const item = await claimNext();
    if (!item) break;
    try {
      const url = await validateWebhookUrl(item.url);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = createHmac("sha256", secret)
        .update(`${timestamp}.${item.payload}`)
        .digest("hex");
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pulse-delivery": item.id,
          "x-pulse-timestamp": timestamp,
          "x-pulse-signature": `sha256=${signature}`,
        },
        body: item.payload,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      await pool
        .request()
        .input("id", sql.UniqueIdentifier, item.id)
        .input("status", sql.Int, response.status)
        .query(
          "UPDATE dbo.WebhookDeliveries SET state='Delivered',delivered_at=SYSUTCDATETIME(),last_status=@status,next_attempt_at=NULL,last_error_code=NULL WHERE id=@id",
        );
      delivered++;
    } catch (error) {
      const terminal = item.attemptCount >= 8;
      const message = error instanceof Error ? error.message : "WebhookError";
      const status = /^HTTP_(\d+)$/.exec(message)?.[1];
      await pool
        .request()
        .input("id", sql.UniqueIdentifier, item.id)
        .input("state", sql.NVarChar(32), terminal ? "Dead letter" : "Retry")
        .input("status", sql.Int, status ? Number(status) : null)
        .input(
          "nextAttempt",
          sql.DateTime2,
          terminal ? null : new Date(Date.now() + 2 ** item.attemptCount * 60_000),
        )
        .input("error", sql.NVarChar(100), message.slice(0, 100))
        .query(
          "UPDATE dbo.WebhookDeliveries SET state=@state,last_status=@status,next_attempt_at=@nextAttempt,last_error_code=@error WHERE id=@id",
        );
      retried++;
    }
  }
  return { delivered, retried, skipped: false };
}
