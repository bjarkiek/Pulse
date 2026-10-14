import { atomicSql, getSqlPool, isContentSqlActive, sql } from "../database";
import { loadAudienceInput, resolveAudience, type AudienceBreakdown } from "./audience";
import { memoryCommunications, memoryDeliveries } from "./memory";
import { getRuntimeCommunicationSettings } from "./settings";
import type { CommunicationContent, CommunicationStats, CommunicationTopic, DeliveryRecord, DeliverySource, EmailLocale, TemplateKey } from "./types";

// Deliveries follow the content switch (`isContentSqlActive`) like the campaigns they belong to: with "Show demo data" on, a campaign, its
// deliveries and its versions all live in memory. A campaign is addressed by its public id (COM-###) here; SQL joins to the uuid.

export const BACKOFF_BASE_MS = 60_000;
export const MAX_ATTEMPTS = 5;
export type ClaimedDelivery = { id: string; email: string; displayName: string | null; source: DeliverySource; attemptCount: number };
export type ClaimedBatch = { communicationId: string; templateKey: TemplateKey; topic: CommunicationTopic; content: CommunicationContent; locale: EmailLocale; deliveries: ClaimedDelivery[] };
export type DeliveryStore = {
  promoteScheduled(now: Date): Promise<string[]>;          // Scheduled & due → freezeAudience → ids now Sending/Sent
  claimBatch(size: number): Promise<ClaimedBatch | null>;  // one campaign, one locale; Test rows claimable regardless of campaign status
  markAccepted(ids: string[], providerMessageId: string | null, now: Date): Promise<void>;
  markFailed(ids: string[], errorCode: string, nextAttemptAt: Date | null): Promise<void>; // null → Dead letter
  acceptedToday(now: Date): Promise<number>;
  completeCampaigns(now: Date): Promise<string[]>;         // Sending with no Queued/Retry/Processing non-test rows → Sent
};
const OPEN = new Set(["Queued", "Retry", "Processing"]);

/**
 * Resolves the audience of a Draft or Scheduled campaign and writes it: one delivery row per recipient (suppressed ones too, so the review can
 * show them) and the campaign moves to Sending, or straight to Sent when nobody is sendable. In SQL the campaign row is locked first, and the
 * rows and the campaign update commit together.
 * - `rejectEmpty` refuses an audience nobody belongs to (INVALID_AUDIENCE_EMPTY) before anything is written.
 * - `onlyIfDue` is the worker's guard: only a campaign that is still Scheduled for a time that has come is frozen, checked under the same lock.
 *   The worker lists the due campaigns first and freezes them one by one, and a person may unschedule or move a campaign in between; without
 *   the check that Draft, or that campaign not yet due, would be mailed.
 */
export async function freezeAudience(publicId: string, actorUserId: string | null, now = new Date(), options: { rejectEmpty?: boolean; onlyIfDue?: boolean } = {}): Promise<AudienceBreakdown> {
  const settings = await getRuntimeCommunicationSettings();
  const freezable = (status: string, scheduledAt: Date | string | null | undefined) =>
    options.onlyIfDue ? status === "Scheduled" && Boolean(scheduledAt) && new Date(scheduledAt!) <= now : ["Draft", "Scheduled"].includes(status);
  if (!isContentSqlActive()) {
    const item = memoryCommunications().find((c) => c.id === publicId);
    if (!item) throw new Error("NOT_FOUND");
    if (!freezable(item.status, item.scheduledAt)) throw new Error("INVALID_COMMUNICATION_STATE");
    const { recipients, breakdown } = resolveAudience(item.audience, item.topic, await loadAudienceInput(item.topic), settings);
    if (options.rejectEmpty && breakdown.total === 0) throw new Error("INVALID_AUDIENCE_EMPTY");
    const store = memoryDeliveries();
    for (const r of recipients)
      store.push({ id: crypto.randomUUID(), communicationId: publicId, ...r, attemptCount: 0, createdAt: now.toISOString() });
    item.recipientCount = breakdown.sendable;
    item.startedAt = now.toISOString();
    item.status = breakdown.sendable === 0 ? "Sent" : "Sending";
    if (breakdown.sendable === 0) item.completedAt = now.toISOString();
    item.scheduledAt = undefined; // as the SQL update does: once frozen, the campaign is no longer waiting for a time
    item.updatedAt = now.toISOString();
    return breakdown;
  }
  return atomicSql(async () => {
    const pool = await getSqlPool();
    const locked = await pool.request().input("id", sql.NVarChar(32), publicId)
      .query("SELECT CAST(id AS nvarchar(36)) id,topic,audience_json audience,status,scheduled_at scheduledAt FROM dbo.Communications WITH (UPDLOCK,HOLDLOCK) WHERE public_id=@id AND deleted_at IS NULL");
    const row = locked.recordset[0];
    if (!row) throw new Error("NOT_FOUND");
    if (!freezable(row.status, row.scheduledAt)) throw new Error("INVALID_COMMUNICATION_STATE");
    const { recipients, breakdown } = resolveAudience(JSON.parse(row.audience), row.topic, await loadAudienceInput(row.topic), settings);
    if (options.rejectEmpty && breakdown.total === 0) throw new Error("INVALID_AUDIENCE_EMPTY");
    for (let i = 0; i < recipients.length; i += 500)
      await pool.request().input("communicationId", sql.UniqueIdentifier, row.id).input("rows", sql.NVarChar(sql.MAX), JSON.stringify(recipients.slice(i, i + 500)))
        .query(`INSERT dbo.CommunicationDeliveries(id,communication_id,organization_id,email,display_name,locale,source,user_id,contact_id,state,suppressed_reason)
          SELECT NEWID(),@communicationId,organizationId,email,displayName,locale,source,TRY_CONVERT(uniqueidentifier,userId),TRY_CONVERT(uniqueidentifier,contactId),state,suppressedReason
          FROM OPENJSON(@rows) WITH (organizationId nvarchar(32),email nvarchar(320),displayName nvarchar(200),locale nvarchar(12),source nvarchar(16),userId nvarchar(36),contactId nvarchar(36),state nvarchar(32),suppressedReason nvarchar(40))`);
    const updated = await pool.request().input("id", sql.UniqueIdentifier, row.id).input("sendable", sql.Int, breakdown.sendable).input("actor", sql.UniqueIdentifier, actorUserId)
      .query(`UPDATE dbo.Communications SET status=CASE WHEN @sendable=0 THEN 'Sent' ELSE 'Sending' END,started_at=SYSUTCDATETIME(),
        completed_at=CASE WHEN @sendable=0 THEN SYSUTCDATETIME() ELSE NULL END,recipient_count=@sendable,sent_by_user_id=COALESCE(@actor,sent_by_user_id),scheduled_at=NULL,updated_at=SYSUTCDATETIME() WHERE id=@id`);
    if (!updated.rowsAffected[0]) throw new Error("NOT_FOUND");
    return breakdown;
  });
}

/**
 * Freezes each due campaign on its own. One that cannot be promoted (its audience grew over the limit, the database refused) stays Scheduled and
 * is tried again on the next run; it must not stop the other campaigns or the sending that follows, so the failure is logged and the loop goes on.
 * Only the campaign's id and an error code are logged: a driver message can quote an address. A campaign that was unscheduled, moved to a later
 * time or cancelled while the worker was on its way is not a failure and is skipped quietly (see `onlyIfDue`).
 */
async function promoteDue(ids: string[], now: Date): Promise<string[]> {
  const promoted: string[] = [];
  for (const id of ids) {
    try {
      await freezeAudience(id, null, now, { onlyIfDue: true });
      promoted.push(id);
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "UNEXPECTED";
      if (code !== "INVALID_COMMUNICATION_STATE" && code !== "NOT_FOUND")
        console.error(JSON.stringify({ level: "error", event: "communications.promote.failed", communicationId: id, code }));
    }
  }
  return promoted;
}

const memoryStore: DeliveryStore = {
  async promoteScheduled(now) {
    return promoteDue(memoryCommunications().filter((c) => c.status === "Scheduled" && c.scheduledAt && new Date(c.scheduledAt) <= now).map((c) => c.id), now);
  },
  async claimBatch(size) {
    const take = Math.floor(size);
    if (!(take >= 1)) return null;
    const now = Date.now();
    const campaigns = new Map(memoryCommunications().map((c) => [c.id, c]));
    const candidates = memoryDeliveries().filter((d) => {
      const campaign = campaigns.get(d.communicationId);
      return campaign && ["Queued", "Retry"].includes(d.state) && (!d.nextAttemptAt || new Date(d.nextAttemptAt).getTime() <= now) && (campaign.status === "Sending" || d.source === "Test");
    });
    const first = candidates[0];
    if (!first) return null;
    const campaign = campaigns.get(first.communicationId)!;
    const batch = candidates.filter((d) => d.communicationId === first.communicationId && d.locale === first.locale).slice(0, take);
    for (const d of batch) { d.state = "Processing"; d.attemptCount += 1; }
    return {
      communicationId: campaign.id, templateKey: campaign.templateKey, topic: campaign.topic, content: structuredClone(campaign.content), locale: first.locale,
      deliveries: batch.map((d) => ({ id: d.id, email: d.email, displayName: d.displayName, source: d.source, attemptCount: d.attemptCount })),
    };
  },
  async markAccepted(ids, providerMessageId, now) {
    for (const d of memoryDeliveries()) if (ids.includes(d.id)) Object.assign(d, { state: "Accepted", providerMessageId, acceptedAt: now.toISOString(), nextAttemptAt: null, lastErrorCode: null });
  },
  async markFailed(ids, errorCode, nextAttemptAt) {
    for (const d of memoryDeliveries()) if (ids.includes(d.id)) Object.assign(d, { state: nextAttemptAt ? "Retry" : "Dead letter", nextAttemptAt: nextAttemptAt?.toISOString() ?? null, lastErrorCode: errorCode });
  },
  async acceptedToday(now) {
    const day = now.toISOString().slice(0, 10);
    return memoryDeliveries().filter((d) => d.acceptedAt?.slice(0, 10) === day).length;
  },
  async completeCampaigns(now) {
    const completed: string[] = [];
    for (const c of memoryCommunications()) {
      if (c.status !== "Sending") continue;
      if (memoryDeliveries().some((d) => d.communicationId === c.id && d.source !== "Test" && OPEN.has(d.state))) continue;
      c.status = "Sent"; c.completedAt = now.toISOString(); c.updatedAt = now.toISOString();
      completed.push(c.id);
    }
    return completed;
  },
};

const sqlStore: DeliveryStore = {
  async promoteScheduled(now) {
    const due = await (await getSqlPool()).request().input("now", sql.DateTime2, now)
      .query("SELECT public_id id FROM dbo.Communications WHERE status='Scheduled' AND scheduled_at<=@now AND deleted_at IS NULL ORDER BY scheduled_at");
    return promoteDue(due.recordset.map((row) => row.id as string), now);
  },
  async claimBatch(size) {
    const take = Math.floor(size);
    if (!(take >= 1)) return null;
    // The closing WHERE is what claims a row. Two workers can pick the same rows in `next_items`, but the UPDATE checks each row again under its
    // own lock, so a row the other worker has just set to Processing is skipped instead of being claimed, and mailed, a second time.
    const result = await (await getSqlPool()).request().input("size", sql.Int, take).query(`
      ;WITH next_campaign AS (
        SELECT TOP (1) d.communication_id,d.locale FROM dbo.CommunicationDeliveries d WITH (UPDLOCK,READPAST,ROWLOCK)
        JOIN dbo.Communications c ON c.id=d.communication_id
        WHERE d.state IN ('Queued','Retry') AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=SYSUTCDATETIME()) AND (c.status='Sending' OR d.source='Test')
        ORDER BY d.created_at
      ), next_items AS (
        SELECT TOP (@size) d.id FROM dbo.CommunicationDeliveries d JOIN next_campaign n ON n.communication_id=d.communication_id AND n.locale=d.locale
        WHERE d.state IN ('Queued','Retry') AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=SYSUTCDATETIME()) ORDER BY d.created_at
      )
      UPDATE d SET state='Processing',attempt_count=attempt_count+1
      OUTPUT CAST(INSERTED.id AS nvarchar(36)) id,INSERTED.email,INSERTED.display_name displayName,INSERTED.source,INSERTED.attempt_count attemptCount,INSERTED.locale,
        c.public_id communicationId,c.template_key templateKey,c.topic,c.content_json contentJson
      FROM dbo.CommunicationDeliveries d JOIN next_items q ON q.id=d.id JOIN dbo.Communications c ON c.id=d.communication_id
      WHERE d.state IN ('Queued','Retry');`);
    if (!result.recordset.length) return null;
    const first = result.recordset[0];
    return {
      communicationId: first.communicationId, templateKey: first.templateKey, topic: first.topic, content: JSON.parse(first.contentJson), locale: first.locale === "is" ? "is" : "en",
      deliveries: result.recordset.map((r) => ({ id: r.id, email: r.email, displayName: r.displayName, source: r.source, attemptCount: Number(r.attemptCount) })),
    };
  },
  async markAccepted(ids, providerMessageId, now) {
    await (await getSqlPool()).request().input("ids", sql.NVarChar(sql.MAX), JSON.stringify(ids)).input("message", sql.NVarChar(200), providerMessageId).input("now", sql.DateTime2, now)
      .query("UPDATE dbo.CommunicationDeliveries SET state='Accepted',provider_message_id=@message,accepted_at=@now,next_attempt_at=NULL,last_error_code=NULL WHERE id IN (SELECT TRY_CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@ids))");
  },
  async markFailed(ids, errorCode, nextAttemptAt) {
    await (await getSqlPool()).request().input("ids", sql.NVarChar(sql.MAX), JSON.stringify(ids)).input("state", sql.NVarChar(32), nextAttemptAt ? "Retry" : "Dead letter")
      .input("next", sql.DateTime2, nextAttemptAt).input("error", sql.NVarChar(100), errorCode.slice(0, 100))
      .query("UPDATE dbo.CommunicationDeliveries SET state=@state,next_attempt_at=@next,last_error_code=@error WHERE id IN (SELECT TRY_CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@ids))");
  },
  async acceptedToday(now) {
    const result = await (await getSqlPool()).request().input("day", sql.Date, now).query("SELECT COUNT(*) count FROM dbo.CommunicationDeliveries WHERE accepted_at>=@day AND accepted_at<DATEADD(day,1,@day)");
    return Number(result.recordset[0].count);
  },
  async completeCampaigns(now) {
    const result = await (await getSqlPool()).request().input("now", sql.DateTime2, now).query(`
      UPDATE c SET status='Sent',completed_at=@now,updated_at=@now OUTPUT INSERTED.public_id id FROM dbo.Communications c
      WHERE c.status='Sending' AND NOT EXISTS (SELECT 1 FROM dbo.CommunicationDeliveries d WHERE d.communication_id=c.id AND d.source<>'Test' AND d.state IN ('Queued','Retry','Processing'))`);
    return result.recordset.map((r) => r.id as string);
  },
};

export function getDeliveryStore(): DeliveryStore {
  return isContentSqlActive() ? sqlStore : memoryStore;
}

export async function communicationStats(publicId: string): Promise<CommunicationStats> {
  const empty: CommunicationStats = { recipients: 0, queued: 0, accepted: 0, delivered: 0, bounced: 0, dropped: 0, deadLettered: 0, suppressed: 0, cancelled: 0, opened: 0, clicked: 0, byOrganization: [] };
  const rows: Array<Pick<DeliveryRecord, "organizationId" | "state" | "openedAt" | "clickedAt">> = isContentSqlActive()
    ? (await (await getSqlPool()).request().input("id", sql.NVarChar(32), publicId).query(
        "SELECT d.organization_id organizationId,d.state,d.opened_at openedAt,d.clicked_at clickedAt FROM dbo.CommunicationDeliveries d JOIN dbo.Communications c ON c.id=d.communication_id WHERE c.public_id=@id AND d.source<>'Test'")).recordset
    : memoryDeliveries().filter((d) => d.communicationId === publicId && d.source !== "Test");
  const stats = { ...empty };
  const byOrg = new Map<string, { organizationId: string; recipients: number; delivered: number; opened: number }>();
  for (const row of rows) {
    if (row.state !== "Suppressed") stats.recipients++;
    if (["Queued", "Retry", "Processing"].includes(row.state)) stats.queued++;
    if (["Accepted", "Deferred"].includes(row.state)) stats.accepted++;
    if (row.state === "Delivered") { stats.accepted++; stats.delivered++; }
    if (row.state === "Bounced") stats.bounced++;
    if (row.state === "Dropped") stats.dropped++;
    if (row.state === "Dead letter") stats.deadLettered++;
    if (row.state === "Suppressed") stats.suppressed++;
    if (row.state === "Cancelled") stats.cancelled++;
    if (row.openedAt) stats.opened++;
    if (row.clickedAt) stats.clicked++;
    const org = byOrg.get(row.organizationId || "-") || { organizationId: row.organizationId || "-", recipients: 0, delivered: 0, opened: 0 };
    if (row.state !== "Suppressed") org.recipients++;
    if (row.state === "Delivered") org.delivered++;
    if (row.openedAt) org.opened++;
    byOrg.set(org.organizationId, org);
  }
  // In a fixed order, so the table does not reshuffle between two reads (SQL gives no order to rows it was not asked to order).
  stats.byOrganization = [...byOrg.values()].sort((a, b) => (a.organizationId < b.organizationId ? -1 : a.organizationId > b.organizationId ? 1 : 0));
  return stats;
}

export async function insertTestDeliveries(publicId: string, recipients: Array<{ email: string; displayName: string; locale: EmailLocale }>): Promise<number> {
  const now = new Date().toISOString();
  if (!isContentSqlActive()) {
    const store = memoryDeliveries();
    for (const r of recipients) {
      const existing = store.find((d) => d.communicationId === publicId && d.email === r.email && d.source === "Test");
      if (existing) Object.assign(existing, { state: "Queued", attemptCount: 0, nextAttemptAt: null, lastErrorCode: null });
      else store.push({ id: crypto.randomUUID(), communicationId: publicId, organizationId: null, email: r.email, displayName: r.displayName, locale: r.locale, source: "Test", userId: null, contactId: null, state: "Queued", suppressedReason: null, attemptCount: 0, createdAt: now });
    }
    return recipients.length;
  }
  // One MERGE for all recipients: a test address that is already on the campaign is queued again (attempts start over), a new one is inserted.
  // A test row belongs to no organisation. HOLDLOCK keeps the upsert atomic when two test sends race.
  await (await getSqlPool()).request().input("id", sql.NVarChar(32), publicId).input("rows", sql.NVarChar(sql.MAX), JSON.stringify(recipients))
    .query(`MERGE dbo.CommunicationDeliveries WITH (HOLDLOCK) target
      USING (SELECT c.id communicationId,r.email,r.displayName,r.locale FROM dbo.Communications c
        CROSS JOIN OPENJSON(@rows) WITH (email nvarchar(320),displayName nvarchar(200),locale nvarchar(12)) r
        WHERE c.public_id=@id AND c.deleted_at IS NULL) incoming
      ON target.communication_id=incoming.communicationId AND target.email=incoming.email AND target.source='Test'
      WHEN MATCHED THEN UPDATE SET state='Queued',attempt_count=0,next_attempt_at=NULL,last_error_code=NULL
      WHEN NOT MATCHED THEN INSERT(id,communication_id,organization_id,email,display_name,locale,source,state)
        VALUES(NEWID(),incoming.communicationId,NULL,incoming.email,incoming.displayName,incoming.locale,'Test','Queued');`);
  return recipients.length;
}

export async function listDeliveryRows(publicId: string, filter: { state?: string; organizationId?: string; page: number; pageSize: number }): Promise<{ items: DeliveryRecord[]; total: number }> {
  // A state or a company id longer than its column matches no row; answering here keeps an overlong query-string value away from the driver.
  if ((filter.state?.length ?? 0) > 32 || (filter.organizationId?.length ?? 0) > 32) return { items: [], total: 0 };
  if (!isContentSqlActive()) {
    const all = memoryDeliveries().filter((d) => d.communicationId === publicId && (!filter.state || d.state === filter.state) && (!filter.organizationId || d.organizationId === filter.organizationId));
    const start = (filter.page - 1) * filter.pageSize;
    return { items: structuredClone(all.slice(start, start + filter.pageSize)), total: all.length };
  }
  const pool = await getSqlPool();
  const where = "c.public_id=@id AND (@state IS NULL OR d.state=@state) AND (@org IS NULL OR d.organization_id=@org)";
  const filtered = () => pool.request().input("id", sql.NVarChar(32), publicId).input("state", sql.NVarChar(32), filter.state || null).input("org", sql.NVarChar(32), filter.organizationId || null);
  // The two reads go one after the other: inside a transaction a request is refused while another is in flight. Rows of one insert share a
  // created_at, so the address and source (with the campaign, a unique key) complete the order and keep the pages from overlapping.
  const page = await filtered().input("offset", sql.Int, (filter.page - 1) * filter.pageSize).input("pageSize", sql.Int, filter.pageSize)
    .query(`SELECT CAST(d.id AS nvarchar(36)) id,c.public_id communicationId,d.organization_id organizationId,d.email,d.display_name displayName,d.locale,d.source,
      CAST(d.user_id AS nvarchar(36)) userId,CAST(d.contact_id AS nvarchar(36)) contactId,d.state,d.suppressed_reason suppressedReason,d.attempt_count attemptCount,
      CONVERT(nvarchar(33),d.next_attempt_at,127) nextAttemptAt,d.provider_message_id providerMessageId,d.last_event lastEvent,CONVERT(nvarchar(33),d.last_event_at,127) lastEventAt,
      CONVERT(nvarchar(33),d.opened_at,127) openedAt,CONVERT(nvarchar(33),d.clicked_at,127) clickedAt,d.last_error_code lastErrorCode,
      CONVERT(nvarchar(33),d.created_at,127) createdAt,CONVERT(nvarchar(33),d.accepted_at,127) acceptedAt
      FROM dbo.CommunicationDeliveries d JOIN dbo.Communications c ON c.id=d.communication_id
      WHERE ${where} ORDER BY d.created_at,d.email,d.source OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`);
  const total = await filtered().query(`SELECT COUNT(*) total FROM dbo.CommunicationDeliveries d JOIN dbo.Communications c ON c.id=d.communication_id WHERE ${where}`);
  return {
    items: page.recordset.map((r): DeliveryRecord => ({
      id: r.id, communicationId: r.communicationId, organizationId: r.organizationId ?? null, email: r.email, displayName: r.displayName ?? null,
      locale: r.locale === "is" ? "is" : "en", source: r.source, userId: r.userId ?? null, contactId: r.contactId ?? null, state: r.state,
      suppressedReason: r.suppressedReason ?? null, attemptCount: Number(r.attemptCount), nextAttemptAt: r.nextAttemptAt ?? null,
      providerMessageId: r.providerMessageId ?? null, lastEvent: r.lastEvent ?? null, lastEventAt: r.lastEventAt ?? null,
      openedAt: r.openedAt ?? null, clickedAt: r.clickedAt ?? null, lastErrorCode: r.lastErrorCode ?? null, createdAt: r.createdAt, acceptedAt: r.acceptedAt ?? null,
    })),
    total: Number(total.recordset[0].total),
  };
}

/** Queues the campaign's Dead letter rows again, attempts started over, and returns how many. */
export async function requeueDeadLetters(publicId: string): Promise<number> {
  if (!isContentSqlActive()) {
    let count = 0;
    for (const d of memoryDeliveries()) if (d.communicationId === publicId && d.state === "Dead letter") { Object.assign(d, { state: "Queued", attemptCount: 0, nextAttemptAt: null, lastErrorCode: null }); count++; }
    return count;
  }
  const result = await (await getSqlPool()).request().input("id", sql.NVarChar(32), publicId)
    .query("UPDATE d SET state='Queued',attempt_count=0,next_attempt_at=NULL,last_error_code=NULL FROM dbo.CommunicationDeliveries d JOIN dbo.Communications c ON c.id=d.communication_id WHERE c.public_id=@id AND d.state='Dead letter'");
  return result.rowsAffected[0];
}

/** Cancels the deliveries of a campaign that are still waiting (Queued or Retry) and returns how many. Deliveries carry no cancel time of their own. */
export async function cancelOpenDeliveries(publicId: string): Promise<number> {
  if (!isContentSqlActive()) {
    let count = 0;
    for (const d of memoryDeliveries()) if (d.communicationId === publicId && ["Queued", "Retry"].includes(d.state)) { Object.assign(d, { state: "Cancelled", nextAttemptAt: null }); count++; }
    return count;
  }
  // Rows already Processing are with the provider and stay as they are; a cancelled row has no next attempt left.
  const result = await (await getSqlPool()).request().input("id", sql.NVarChar(32), publicId)
    .query("UPDATE d SET state='Cancelled',next_attempt_at=NULL FROM dbo.CommunicationDeliveries d JOIN dbo.Communications c ON c.id=d.communication_id WHERE c.public_id=@id AND d.state IN ('Queued','Retry')");
  return result.rowsAffected[0];
}
