import type { PulseIdentity } from "@/lib/domain";
import { requireMembership } from "./authorization";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";

export const notificationEventTypes = [
  "request.submitted",
  "request.needs-information",
  "request.linked",
  "request.status-changed",
  "comment.mention",
  "idea.status-changed",
  "release.published",
] as const;

export type NotificationEventType = (typeof notificationEventTypes)[number];
export type NotificationCadence = "Immediate" | "Daily" | "Weekly" | "Off";
export type NotificationPreference = {
  eventType: NotificationEventType;
  cadence: NotificationCadence;
  mandatory: boolean;
};

const mandatoryEvents = new Set<NotificationEventType>([
  "request.needs-information",
  "comment.mention",
]);

declare global {
  var pulseMemoryNotificationPreferences:
    | Map<string, NotificationCadence>
    | undefined;
}

function memoryPreferences() {
  globalThis.pulseMemoryNotificationPreferences ||= new Map();
  return globalThis.pulseMemoryNotificationPreferences;
}

function defaultCadence(eventType: NotificationEventType): NotificationCadence {
  return mandatoryEvents.has(eventType) ? "Immediate" : "Immediate";
}

export async function listNotificationPreferences(identity: PulseIdentity) {
  await requireMembership(identity);
  if (!isAzureSqlConfigured()) {
    const values = memoryPreferences();
    return notificationEventTypes.map((eventType) => ({
      eventType,
      cadence:
        values.get(`${identity.id}:${identity.organizationId}:${eventType}`) ||
        defaultCadence(eventType),
      mandatory: mandatoryEvents.has(eventType),
    }));
  }
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, identity.id)
    .input("organizationId", sql.NVarChar(32), identity.organizationId)
    .query(
      "SELECT event_type eventType,cadence FROM dbo.NotificationPreferences WHERE user_id=@userId AND organization_id=@organizationId",
    );
  const saved = new Map<string, NotificationCadence>(
    result.recordset.map((row) => [row.eventType, row.cadence]),
  );
  return notificationEventTypes.map((eventType) => ({
    eventType,
    cadence: saved.get(eventType) || defaultCadence(eventType),
    mandatory: mandatoryEvents.has(eventType),
  }));
}

export async function saveNotificationPreference(
  identity: PulseIdentity,
  eventType: string,
  cadence: string,
) {
  await requireMembership(identity);
  if (!notificationEventTypes.includes(eventType as NotificationEventType))
    throw new Error("INVALID_NOTIFICATION_EVENT");
  if (!(["Immediate", "Daily", "Weekly", "Off"] as string[]).includes(cadence))
    throw new Error("INVALID_NOTIFICATION_CADENCE");
  const typedEvent = eventType as NotificationEventType;
  const typedCadence = cadence as NotificationCadence;
  if (mandatoryEvents.has(typedEvent) && typedCadence !== "Immediate")
    throw new Error("MANDATORY_NOTIFICATION_MUST_BE_IMMEDIATE");

  if (!isAzureSqlConfigured()) {
    memoryPreferences().set(
      `${identity.id}:${identity.organizationId}:${typedEvent}`,
      typedCadence,
    );
    return {
      eventType: typedEvent,
      cadence: typedCadence,
      mandatory: mandatoryEvents.has(typedEvent),
    };
  }

  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const prior = await new sql.Request(transaction)
      .input("userId", sql.UniqueIdentifier, identity.id)
      .input("organizationId", sql.NVarChar(32), identity.organizationId)
      .input("eventType", sql.NVarChar(100), typedEvent)
      .query(
        "SELECT cadence FROM dbo.NotificationPreferences WITH (UPDLOCK,HOLDLOCK) WHERE user_id=@userId AND organization_id=@organizationId AND event_type=@eventType",
      );
    await new sql.Request(transaction)
      .input("userId", sql.UniqueIdentifier, identity.id)
      .input("organizationId", sql.NVarChar(32), identity.organizationId)
      .input("eventType", sql.NVarChar(100), typedEvent)
      .input("cadence", sql.NVarChar(32), typedCadence).query(`
        MERGE dbo.NotificationPreferences target
        USING(SELECT @userId user_id,@organizationId organization_id,@eventType event_type) source
        ON target.user_id=source.user_id AND target.organization_id=source.organization_id
          AND target.event_type=source.event_type
        WHEN MATCHED THEN UPDATE SET cadence=@cadence,updated_at=SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT(user_id,organization_id,event_type,cadence)
          VALUES(@userId,@organizationId,@eventType,@cadence);`);
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("organizationId", sql.NVarChar(32), identity.organizationId)
      .input("before", sql.NVarChar(sql.MAX), JSON.stringify(prior.recordset[0] || null))
      .input(
        "after",
        sql.NVarChar(sql.MAX),
        JSON.stringify({ eventType: typedEvent, cadence: typedCadence }),
      )
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,organization_id,action,entity_type,before_json,after_json,correlation_id) VALUES(@id,@actor,@organizationId,'notification.preference.updated','NotificationPreference',@before,@after,@correlation)",
      );
    await transaction.commit();
    return {
      eventType: typedEvent,
      cadence: typedCadence,
      mandatory: mandatoryEvents.has(typedEvent),
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
