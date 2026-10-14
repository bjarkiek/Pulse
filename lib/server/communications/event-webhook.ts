import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { atomicSql, getSqlPool, isContentSqlActive, sql } from "../database";
import { memoryDeliveries, memoryEvents } from "./memory";
import { releaseAddress, suppressAddress } from "./suppression-repository";
import type { DeliveryRecord, DeliveryState, SuppressionReason } from "./types";

/** SendGrid signs `timestamp + body`. A request more than this many seconds from now, either way, is a replay (or a clock that is wrong): the SDK's own check has no such bound. */
const WINDOW_SECONDS = 600;
/** The most events one request is read for; SendGrid posts up to 1000 at a time. */
const MAX_EVENTS = 1000;
/** 9999-12-31T23:59:59Z, the last second `datetime2` can hold. A time before 1970 or past it is none that SendGrid sent, and would fail the whole batch at the driver. */
const MAX_EPOCH_SECONDS = 253_402_300_799;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SendGrid shows its key as bare base64; one copied from a PEM file or a vault secret may carry the armour and line breaks. */
export function normalizePublicKey(value: string) {
  return value.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
}

/**
 * Checks the ECDSA signature SendGrid puts on a request (`X-Twilio-Email-Event-Webhook-Signature`, over `timestamp + the raw body`) with the key
 * it showed when the signed webhook was switched on (base64 SPKI, PEM armour tolerated), and that the timestamp is within ten minutes of now.
 * Anything malformed — a missing header, a timestamp that is no whole number, a key that is no key — is simply `false`: this never throws.
 */
export function verifyEventSignature(publicKeyBase64: string, payload: string, signature: string | null, timestamp: string | null, nowMs = Date.now()) {
  if (!signature || !timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > WINDOW_SECONDS) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(normalizePublicKey(publicKeyBase64), "base64"), format: "der", type: "spki" });
    return cryptoVerify("sha256", Buffer.from(timestamp + payload, "utf8"), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/** The part of a SendGrid event the handler uses. `deliveryId` and `communicationId` are the custom arguments the worker sent with each recipient. */
export type SendGridEvent = { sg_event_id: string; sg_message_id?: string; event: string; email: string; timestamp: number; reason?: string; type?: string; deliveryId?: string; communicationId?: string };

/**
 * The events of a request body: at most the first 1000, each one with what the handler needs, cut to the width of its column. An entry that is not
 * well formed — no event id or name, no address (or one that is blank once trimmed), no usable time — is dropped, not an error, so one odd event
 * cannot make SendGrid post the whole batch again for a day. A body that is not a JSON array is the caller's error.
 */
export function parseEvents(raw: string): SendGridEvent[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("INVALID_JSON"); }
  if (!Array.isArray(value)) throw new Error("INVALID_EVENTS");
  return value.slice(0, MAX_EVENTS).flatMap((e): SendGridEvent[] => {
    if (!e || typeof e !== "object") return [];
    const v = e as Record<string, unknown>;
    if (typeof v.sg_event_id !== "string" || typeof v.event !== "string" || typeof v.email !== "string" || typeof v.timestamp !== "number") return [];
    const email = v.email.trim().toLowerCase().slice(0, 320);
    if (!email || !v.sg_event_id.trim() || !v.event.trim() || !(v.timestamp >= 0 && v.timestamp <= MAX_EPOCH_SECONDS)) return [];
    return [{
      sg_event_id: v.sg_event_id.slice(0, 100), sg_message_id: typeof v.sg_message_id === "string" ? v.sg_message_id.slice(0, 200) : undefined,
      event: v.event.slice(0, 32), email, timestamp: v.timestamp,
      reason: typeof v.reason === "string" ? v.reason.slice(0, 500) : undefined, type: typeof v.type === "string" ? v.type.slice(0, 32) : undefined,
      deliveryId: typeof v.deliveryId === "string" && UUID.test(v.deliveryId) ? v.deliveryId.toLowerCase() : undefined,
      communicationId: typeof v.communicationId === "string" ? v.communicationId.slice(0, 32) : undefined,
    }];
  });
}

/** What an event does: always the delivery's `last_event`, and perhaps its state, its open or click time, a suppression or the lifting of one. */
export type EventEffect = { lastEvent: string; state?: DeliveryState; opened?: true; clicked?: true; suppress?: SuppressionReason; release?: SuppressionReason };

/** The mapping table of the design (§6.4). Pure. */
export function mapEvent(event: SendGridEvent): EventEffect {
  const base: EventEffect = { lastEvent: event.event };
  switch (event.event) {
    case "delivered": return { ...base, state: "Delivered" };
    case "deferred": return { ...base, state: "Deferred" };
    case "bounce": return event.type === "blocked" ? { ...base, state: "Bounced" } : { ...base, state: "Bounced", suppress: "Bounced" };
    case "dropped": {
      const reason = (event.reason || "").toLowerCase();
      const suppress: SuppressionReason | undefined = reason.includes("bounced address") ? "Bounced" : reason.includes("unsubscribed address") ? "Unsubscribed" : reason.includes("spam reporting address") ? "SpamReport" : undefined;
      return suppress ? { ...base, state: "Dropped", suppress } : { ...base, state: "Dropped" };
    }
    case "open": return { ...base, opened: true };
    case "click": return { ...base, clicked: true };
    case "spamreport": return { ...base, suppress: "SpamReport" };
    case "unsubscribe": case "group_unsubscribe": return { ...base, suppress: "Unsubscribed" };
    case "group_resubscribe": return { ...base, release: "Unsubscribed" };
    default: return base;
  }
}

/** The suppression side of an event. The list keeps its own rules: the newest event wins, and a Manual suppression is never replaced or lifted from here. */
async function applySuppression(event: SendGridEvent, effect: EventEffect) {
  if (effect.suppress) await suppressAddress(event.email, effect.suppress, "Webhook", event.reason);
  if (effect.release) await releaseAddress(event.email, effect.release);
}

/**
 * Applies a batch, one event at a time. An event takes effect once: its `sg_event_id` goes into the ledger (`dbo.CommunicationEvents`, or the memory set),
 * and an id that is in it already is a repeat (SendGrid delivers at least once, and posts a batch again when the answer was not a 2xx) which does nothing.
 * An event updates the delivery it belongs to (by the `deliveryId` we sent as a custom argument; failing that, by the request's message id and the
 * address) and may suppress or release the address. `applied` counts the events that changed a delivery or the suppression list; `ignored` counts
 * the repeats and the events that match no delivery and suppress nothing.
 *
 * Ledger and deliveries follow `isContentSqlActive`, like the campaigns they belong to: with "Show demo data" on they are in memory while SQL is
 * configured, and the suppression list (which keeps `isAzureSqlConfigured`) is still the real one. In SQL an event is one unit of work, ledger row, delivery
 * update and suppression together: if the suppression fails, the ledger row goes with it, so SendGrid's retry applies the event instead of finding it
 * recorded as seen with its suppression never written.
 */
export async function applyEvents(events: SendGridEvent[]) {
  let applied = 0;
  let ignored = 0;
  const inMemory = !isContentSqlActive();
  for (const event of events) {
    const effect = mapEvent(event);
    const occurredAt = new Date(event.timestamp * 1000).toISOString();
    if (inMemory) {
      const seen = memoryEvents();
      if (seen.has(event.sg_event_id)) { ignored++; continue; }
      seen.add(event.sg_event_id);
      const belongs = (d: DeliveryRecord) => event.deliveryId
        ? d.id === event.deliveryId
        : Boolean(event.sg_message_id && d.providerMessageId && event.sg_message_id.startsWith(d.providerMessageId) && d.email === event.email);
      const delivery = memoryDeliveries().find(belongs);
      if (delivery) {
        delivery.lastEvent = effect.lastEvent; delivery.lastEventAt = occurredAt;
        if (effect.state) delivery.state = effect.state;
        if (effect.opened) delivery.openedAt ||= occurredAt;
        if (effect.clicked) delivery.clickedAt ||= occurredAt;
      }
      await applySuppression(event, effect);
      if (delivery || effect.suppress || effect.release) applied++; else ignored++;
      continue;
    }
    const outcome = await atomicSql(async () => {
      const pool = await getSqlPool();
      const inserted = await pool.request().input("id", sql.NVarChar(100), event.sg_event_id).input("delivery", sql.UniqueIdentifier, event.deliveryId || null)
        .input("event", sql.NVarChar(32), event.event).input("email", sql.NVarChar(320), event.email).input("occurred", sql.DateTime2, new Date(occurredAt))
        .input("reason", sql.NVarChar(500), event.reason || null).input("payload", sql.NVarChar(sql.MAX), JSON.stringify({ type: event.type, sg_message_id: event.sg_message_id }))
        .query(`INSERT dbo.CommunicationEvents(sg_event_id,delivery_id,event,email,occurred_at,reason,payload_json)
          SELECT @id,(SELECT id FROM dbo.CommunicationDeliveries WHERE id=@delivery),@event,@email,@occurred,@reason,@payload
          WHERE NOT EXISTS (SELECT 1 FROM dbo.CommunicationEvents WHERE sg_event_id=@id)`);
      if (!inserted.rowsAffected[0]) return "duplicate" as const;
      const updated = await pool.request().input("delivery", sql.UniqueIdentifier, event.deliveryId || null).input("email", sql.NVarChar(320), event.email)
        .input("message", sql.NVarChar(200), event.sg_message_id || null).input("last", sql.NVarChar(32), effect.lastEvent).input("occurred", sql.DateTime2, new Date(occurredAt))
        .input("state", sql.NVarChar(32), effect.state || null).input("opened", sql.Bit, effect.opened ? 1 : 0).input("clicked", sql.Bit, effect.clicked ? 1 : 0)
        .query(`UPDATE TOP(1) dbo.CommunicationDeliveries SET last_event=@last,last_event_at=@occurred,state=COALESCE(@state,state),
          opened_at=CASE WHEN @opened=1 THEN COALESCE(opened_at,@occurred) ELSE opened_at END,clicked_at=CASE WHEN @clicked=1 THEN COALESCE(clicked_at,@occurred) ELSE clicked_at END
          WHERE (@delivery IS NOT NULL AND id=@delivery) OR (@delivery IS NULL AND @message IS NOT NULL AND provider_message_id IS NOT NULL AND email=@email AND @message LIKE provider_message_id+'%')`);
      await applySuppression(event, effect);
      return updated.rowsAffected[0] ? "applied" as const : "orphan" as const;
    });
    if (outcome === "duplicate") { ignored++; continue; }
    if (outcome === "applied" || effect.suppress || effect.release) applied++; else ignored++;
  }
  return { applied, ignored };
}
