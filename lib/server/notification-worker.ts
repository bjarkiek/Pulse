import { EmailClient } from "@azure/communication-email";
import { DefaultAzureCredential } from "@azure/identity";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";

type ClaimedNotification = {
  ids: string[];
  email: string;
  locale: string;
  organizationId: string;
  eventType: string;
  attemptCount: number;
  cadence: "Immediate" | "Daily" | "Weekly";
};

function localizedMessage(item: ClaimedNotification) {
  const icelandic = item.locale.toLowerCase().startsWith("is");
  const publicUrl = process.env.PULSE_PUBLIC_URL || "http://localhost:3000";
  const link = `${publicUrl}/?organization=${encodeURIComponent(item.organizationId)}`;
  const count = item.ids.length;
  const digest = item.cadence !== "Immediate";
  return {
    subject: icelandic
      ? digest
        ? `${item.cadence === "Daily" ? "Daglegt" : "Vikulegt"} yfirlit úr DataCentral Pulse`
        : "Uppfærsla í DataCentral Pulse"
      : digest
        ? `Your ${item.cadence.toLowerCase()} DataCentral Pulse digest`
        : "Update in DataCentral Pulse",
    body: icelandic
      ? `${count} ${count === 1 ? "uppfærsla bíður" : "uppfærslur bíða"} þín í DataCentral Pulse. Opnaðu örugga tengilinn til að skoða: ${link}`
      : `${count} ${count === 1 ? "update is" : "updates are"} waiting in DataCentral Pulse. Open the secure link to review: ${link}`,
  };
}

async function claimNext(): Promise<ClaimedNotification | null> {
  const pool = await getSqlPool();
  await pool.request().query(`
    UPDATE n SET state='Suppressed',last_error_code='RecipientInactive'
    FROM dbo.Notifications n
    LEFT JOIN dbo.Users u ON u.id=n.user_id AND u.status='Active'
    LEFT JOIN dbo.Memberships m ON m.user_id=n.user_id AND m.organization_id=n.organization_id AND m.status='Active'
    WHERE n.channel='Email' AND n.state IN ('Queued','Retry') AND (u.id IS NULL OR m.user_id IS NULL);
    UPDATE n SET state='Suppressed',last_error_code='PreferenceOff'
    FROM dbo.Notifications n
    JOIN dbo.NotificationPreferences p ON p.user_id=n.user_id AND p.organization_id=n.organization_id AND p.event_type=n.event_type
    WHERE n.channel='Email' AND n.state IN ('Queued','Retry') AND p.cadence='Off';`);
  const result = await pool.request().query(`
    ;WITH next_recipient AS (
      SELECT TOP (1) n.user_id,n.organization_id,COALESCE(p.cadence,'Immediate') cadence
      FROM dbo.Notifications n WITH (UPDLOCK,READPAST,ROWLOCK)
      JOIN dbo.Users u ON u.id=n.user_id AND u.status='Active'
      JOIN dbo.Memberships m ON m.user_id=n.user_id AND m.organization_id=n.organization_id AND m.status='Active'
      LEFT JOIN dbo.NotificationPreferences p ON p.user_id=n.user_id AND p.organization_id=n.organization_id AND p.event_type=n.event_type
      WHERE n.channel='Email' AND n.state IN ('Queued','Retry')
        AND (n.next_attempt_at IS NULL OR n.next_attempt_at<=SYSUTCDATETIME())
        AND COALESCE(p.cadence,'Immediate')<>'Off'
        AND (COALESCE(p.cadence,'Immediate')='Immediate'
          OR (p.cadence='Daily' AND n.created_at<=DATEADD(day,-1,SYSUTCDATETIME()))
          OR (p.cadence='Weekly' AND n.created_at<=DATEADD(day,-7,SYSUTCDATETIME())))
      ORDER BY n.created_at
    ), next_items AS (
      SELECT TOP (50) n.id,recipient.cadence
      FROM dbo.Notifications n
      JOIN next_recipient recipient ON recipient.user_id=n.user_id AND recipient.organization_id=n.organization_id
      LEFT JOIN dbo.NotificationPreferences p ON p.user_id=n.user_id AND p.organization_id=n.organization_id AND p.event_type=n.event_type
      WHERE n.channel='Email' AND n.state IN ('Queued','Retry')
        AND COALESCE(p.cadence,'Immediate')=recipient.cadence
        AND (n.next_attempt_at IS NULL OR n.next_attempt_at<=SYSUTCDATETIME())
        AND (recipient.cadence='Immediate'
          OR (recipient.cadence='Daily' AND n.created_at<=DATEADD(day,-1,SYSUTCDATETIME()))
          OR (recipient.cadence='Weekly' AND n.created_at<=DATEADD(day,-7,SYSUTCDATETIME())))
      ORDER BY n.created_at
    )
    UPDATE n SET state='Processing',attempt_count=attempt_count+1
    OUTPUT CAST(INSERTED.id AS nvarchar(36)) id,u.email,u.locale,
      INSERTED.organization_id organizationId,INSERTED.event_type eventType,
      INSERTED.attempt_count attemptCount,q.cadence
    FROM dbo.Notifications n
    JOIN next_items q ON q.id=n.id
    JOIN dbo.Users u ON u.id=n.user_id;`);
  if (!result.recordset.length) return null;
  return {
    ids: result.recordset.map((row) => row.id),
    email: result.recordset[0].email,
    locale: result.recordset[0].locale,
    organizationId: result.recordset[0].organizationId,
    eventType: result.recordset[0].eventType,
    attemptCount: Math.max(
      ...result.recordset.map((row) => Number(row.attemptCount)),
    ),
    cadence: result.recordset[0].cadence,
  };
}

export async function processNotificationBatch(limit = 10) {
  if (!isAzureSqlConfigured())
    return { delivered: 0, retried: 0, skipped: true };
  const endpoint = process.env.AZURE_COMMUNICATION_EMAIL_ENDPOINT;
  const senderAddress = process.env.AZURE_COMMUNICATION_EMAIL_SENDER;
  if (!endpoint || !senderAddress)
    throw new Error("INVALID_EMAIL_PROVIDER_CONFIGURATION");
  const client = new EmailClient(endpoint, new DefaultAzureCredential());
  const pool = await getSqlPool();
  let delivered = 0;
  let retried = 0;
  for (let index = 0; index < Math.min(Math.max(limit, 1), 50); index++) {
    const item = await claimNext();
    if (!item) break;
    try {
      const content = localizedMessage(item);
      const poller = await client.beginSend({
        senderAddress,
        content: { subject: content.subject, plainText: content.body },
        recipients: { to: [{ address: item.email }] },
      });
      await poller.pollUntilDone();
      await pool
        .request()
        .input("ids", sql.NVarChar(sql.MAX), JSON.stringify(item.ids))
        .query(
          "UPDATE dbo.Notifications SET state='Delivered',delivered_at=SYSUTCDATETIME(),next_attempt_at=NULL,last_error_code=NULL WHERE id IN(SELECT TRY_CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@ids))",
        );
      delivered += item.ids.length;
    } catch (error) {
      const terminal = item.attemptCount >= 5;
      await pool
        .request()
        .input("ids", sql.NVarChar(sql.MAX), JSON.stringify(item.ids))
        .input("state", sql.NVarChar(32), terminal ? "Dead letter" : "Retry")
        .input(
          "nextAttempt",
          sql.DateTime2,
          terminal
            ? null
            : new Date(Date.now() + 2 ** item.attemptCount * 60_000),
        )
        .input(
          "errorCode",
          sql.NVarChar(100),
          error instanceof Error ? error.name.slice(0, 100) : "EmailError",
        )
        .query(
          "UPDATE dbo.Notifications SET state=@state,next_attempt_at=@nextAttempt,last_error_code=@errorCode WHERE id IN(SELECT TRY_CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@ids))",
        );
      retried += item.ids.length;
    }
  }
  return { delivered, retried, skipped: false };
}
