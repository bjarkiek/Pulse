import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import type { PulseIdentity } from "@/lib/domain";
import { requireInternalRole } from "./authorization";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";

export const webhookEvents = [
  "request.created",
  "request.status.changed",
  "request.linked",
  "idea.published",
  "idea.updated",
  "release.published",
] as const;

export type WebhookSubscription = {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
};

declare global {
  var pulseMemoryWebhooks: WebhookSubscription[] | undefined;
}

function subscriptions() {
  globalThis.pulseMemoryWebhooks ||= [];
  return globalThis.pulseMemoryWebhooks;
}

function privateAddress(address: string) {
  if (address === "::1" || address.startsWith("fc") || address.startsWith("fd"))
    return true;
  if (address.includes(":")) return false;
  const [first, second] = address.split(".").map(Number);
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first === 0
  );
}

export async function validateWebhookUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("INVALID_WEBHOOK_URL");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("INVALID_WEBHOOK_URL");
  if (url.hostname === "localhost" || url.hostname.endsWith(".local"))
    throw new Error("INVALID_WEBHOOK_URL");
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some((item) => privateAddress(item.address)))
    throw new Error("INVALID_WEBHOOK_URL");
  return url.toString();
}

function validateEvents(events: string[]) {
  const unique = [...new Set(events)];
  if (
    !unique.length ||
    unique.some((event) => !(webhookEvents as readonly string[]).includes(event))
  )
    throw new Error("INVALID_WEBHOOK_EVENTS");
  return unique;
}

export async function listWebhookSubscriptions(identity: PulseIdentity) {
  await requireInternalRole(identity, ["System admin"]);
  if (!isAzureSqlConfigured()) return subscriptions();
  const pool = await getSqlPool();
  const result = await pool.request().query(
    "SELECT CAST(id AS nvarchar(36)) id,url,events_json events,active,created_at createdAt FROM dbo.WebhookSubscriptions WHERE deleted_at IS NULL ORDER BY created_at DESC",
  );
  return result.recordset.map((row) => ({
    ...row,
    events: typeof row.events === "string" ? JSON.parse(row.events) : row.events,
    active: Boolean(row.active),
  }));
}

export async function createWebhookSubscription(
  identity: PulseIdentity,
  input: { url: string; events: string[] },
) {
  await requireInternalRole(identity, ["System admin"]);
  const url = await validateWebhookUrl(input.url);
  const events = validateEvents(input.events || []);
  const item: WebhookSubscription = {
    id: crypto.randomUUID(),
    url,
    events,
    active: true,
    createdAt: new Date().toISOString(),
  };
  if (!isAzureSqlConfigured()) {
    subscriptions().unshift(item);
    globalThis.pulseMemoryAudit ||= [];
    globalThis.pulseMemoryAudit.unshift({
      id: crypto.randomUUID(),
      actor: identity.name,
      organizationId: identity.organizationId,
      action: "webhook.created",
      entityType: "WebhookSubscription",
      entityId: item.id,
      after: { url: item.url, events: item.events },
      correlationId: crypto.randomUUID(),
      createdAt: item.createdAt,
    });
    return item;
  }
  const pool = await getSqlPool();
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, item.id)
    .input("url", sql.NVarChar(2000), url)
    .input("events", sql.NVarChar(sql.MAX), JSON.stringify(events))
    .input("actor", sql.UniqueIdentifier, identity.id)
    .query(
      "INSERT dbo.WebhookSubscriptions(id,url,events_json,created_by_user_id) VALUES(@id,@url,@events,@actor)",
    );
  await pool
    .request()
    .input("auditId", sql.UniqueIdentifier, crypto.randomUUID())
    .input("actor", sql.UniqueIdentifier, identity.id)
    .input("entity", sql.UniqueIdentifier, item.id)
    .input("after", sql.NVarChar(sql.MAX), JSON.stringify({ url, events }))
    .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
    .query(
      "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@auditId,@actor,'webhook.created','WebhookSubscription',@entity,@after,@correlation)",
    );
  return item;
}

export async function setWebhookSubscriptionState(
  identity: PulseIdentity,
  id: string,
  active: boolean,
) {
  await requireInternalRole(identity, ["System admin"]);
  if (!isAzureSqlConfigured()) {
    const item = subscriptions().find((subscription) => subscription.id === id);
    if (!item) throw new Error("NOT_FOUND");
    const before = item.active;
    item.active = active;
    globalThis.pulseMemoryAudit ||= [];
    globalThis.pulseMemoryAudit.unshift({
      id: crypto.randomUUID(),
      actor: identity.name,
      organizationId: identity.organizationId,
      action: "webhook.state.updated",
      entityType: "WebhookSubscription",
      entityId: id,
      before: { active: before },
      after: { active },
      correlationId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    return item;
  }
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .input("active", sql.Bit, active)
    .query(
      "UPDATE dbo.WebhookSubscriptions SET active=@active,updated_at=SYSUTCDATETIME() OUTPUT CAST(INSERTED.id AS nvarchar(36)) id,INSERTED.active WHERE id=@id AND deleted_at IS NULL",
    );
  if (!result.recordset.length) throw new Error("NOT_FOUND");
  await pool
    .request()
    .input("auditId", sql.UniqueIdentifier, crypto.randomUUID())
    .input("actor", sql.UniqueIdentifier, identity.id)
    .input("entity", sql.UniqueIdentifier, id)
    .input("after", sql.NVarChar(sql.MAX), JSON.stringify({ active }))
    .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
    .query(
      "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@auditId,@actor,'webhook.state.updated','WebhookSubscription',@entity,@after,@correlation)",
    );
  return { id, active };
}
