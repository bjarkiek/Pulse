import { atomicSql, getSqlPool, isContentSqlActive, sql } from "../database";
import { blockedReason, domainAllowed, loadAudienceInput, resolveAudience, type AudienceBreakdown } from "./audience";
import { memoryCommunications, memoryDeliveries } from "./memory";
import { getRuntimeCommunicationSettings } from "./settings";
import { loadSuppressionMap } from "./suppression-repository";
import type { CommunicationContent, CommunicationStats, CommunicationTopic, DeliveryRecord, DeliverySource, EmailLocale, TemplateKey } from "./types";

// Deliveries follow the content switch (`isContentSqlActive`) like the campaigns they belong to: with "Show demo data" on, a campaign, its
// deliveries and its versions all live in memory. A campaign is addressed by its public id (COM-###) here; SQL joins to the uuid.

export const BACKOFF_BASE_MS = 60_000;
export const MAX_ATTEMPTS = 5;
/**
 * How long a claim holds its rows. A row the worker has claimed is Processing; if the run dies before it settles the row (crash, deploy,
 * a database that went away), nothing else would ever move it, and its campaign would stay Sending for ever. So a claim is a lease: it stamps
 * `next_attempt_at` with the time it runs out, `recoverStale` puts rows whose lease has run out back to Retry, and accepting or failing a row
 * replaces the stamp. Far longer than a send (the transport gives a request up after 30 seconds), so a live run never loses its rows.
 * A lease that runs out is an attempt that never settled, and it counts like a failed one: after MAX_ATTEMPTS the row is a dead letter
 * (LEASE_EXPIRED) instead of going out once more, so a batch that kills the run, or whose settling always fails, is not mailed for ever.
 */
export const LEASE_MS = 15 * 60_000;
export type ClaimedDelivery = { id: string; email: string; displayName: string | null; source: DeliverySource; attemptCount: number };
export type ClaimedBatch = { communicationId: string; templateKey: TemplateKey; topic: CommunicationTopic; content: CommunicationContent; locale: EmailLocale; deliveries: ClaimedDelivery[] };
export type DeliveryStore = {
  promoteScheduled(now: Date): Promise<string[]>;          // Scheduled & due → freezeAudience → ids now Sending/Sent
  recoverStale(now: Date): Promise<number>;                // Processing whose lease ran out (next_attempt_at < now; SQL: by its own clock) → Retry, attempts kept (used up → Dead letter LEASE_EXPIRED); a Cancelled campaign's real rows → Cancelled; how many
  claimBatch(size: number): Promise<ClaimedBatch | null>;  // first settles the waiting real rows of Sending campaigns whose address was suppressed since the freeze, or that safe mode now excludes, as Suppressed (never claimed); then one campaign, one locale, Test rows or real rows (never both); Test rows claimable regardless of campaign status; leases what it takes
  markAccepted(ids: string[], providerMessageId: string | null, now: Date): Promise<void>; // the provider took the request: a row still Processing → Accepted, a row that moved on meanwhile (the webhook, a lapsed lease) keeps its state; every row named gets the message id and the time
  markFailed(ids: string[], errorCode: string, nextAttemptAt: Date | null): Promise<void>; // a row still Processing: null → Dead letter, else Retry, a row of a Cancelled campaign → Cancelled; a row that moved on meanwhile (the webhook, a lapsed lease) keeps its state; every row named gets the code
  releaseBatch(ids: string[]): Promise<void>;              // claimed rows given back unused: Processing → Queued, one attempt less, no lease (a Cancelled campaign's real rows → Cancelled)
  acceptedToday(now: Date): Promise<number>;
  completeCampaigns(now: Date): Promise<string[]>;         // Sending with no Queued/Retry/Processing non-test rows → Sent
};
const OPEN = new Set(["Queued", "Retry", "Processing"]);

/**
 * The check the freeze made, made again when the worker is about to claim. A row that has been waiting since the freeze (Queued, or Retry after a
 * failure, a backoff or a requeued dead letter) is not sent if its address has been suppressed meanwhile (an unsubscribe reported through another
 * campaign, a bounce, an admin's block) or if safe mode now leaves its domain out: it is settled as Suppressed, with the reason the audience resolver
 * gives for the same case (`blockedReason`), and no claim can take it. `completeCampaigns` counts a Suppressed row as settled, so a campaign whose
 * last waiting rows end here completes in the same run.
 * Real rows of a campaign that is Sending only. A test mail goes to the staff the sender named and was never held to the list or to safe mode; it is
 * claimed whatever the campaign is, so it is not settled here either.
 */
async function settleBlockedInMemory() {
  const sending = new Set(memoryCommunications().filter((c) => c.status === "Sending").map((c) => c.id));
  const waiting = memoryDeliveries().filter((d) => d.source !== "Test" && ["Queued", "Retry"].includes(d.state) && sending.has(d.communicationId));
  if (!waiting.length) return;
  const suppressions = await loadSuppressionMap();
  const { safeMode } = await getRuntimeCommunicationSettings();
  for (const d of waiting) {
    const reason = blockedReason(d.email, suppressions, safeMode);
    if (reason) Object.assign(d, { state: "Suppressed", suppressedReason: reason, nextAttemptAt: null });
  }
}

/**
 * SQL twin of `settleBlockedInMemory`, in statements of their own (the claim itself cannot run in a unit of work: READPAST), each one atomic. The
 * suppression list is joined in the statement, so no address leaves the database for it; the campaign is read with locks (READCOMMITTEDLOCK), so a
 * cancel that is committing is waited for and its rows are not settled twice. Safe mode is asked of `domainAllowed`, the rule the audience uses, and
 * only when it is on: the waiting rows are read, those outside the list are settled by id, and a row that was claimed or settled in between is left
 * alone (the second statement checks the state again).
 */
async function settleBlockedInSql() {
  const pool = await getSqlPool();
  await pool.request().query(`UPDATE d SET state='Suppressed',suppressed_reason=s.reason,next_attempt_at=NULL
    FROM dbo.CommunicationDeliveries d
    JOIN dbo.Communications c WITH (READCOMMITTEDLOCK) ON c.id=d.communication_id AND c.deleted_at IS NULL AND c.status='Sending'
    JOIN dbo.CommunicationSuppressions s ON s.email=d.email
    WHERE d.state IN ('Queued','Retry') AND d.source<>'Test'`);
  const { safeMode } = await getRuntimeCommunicationSettings();
  if (!safeMode.enabled) return;
  const waiting = await pool.request().query(`SELECT CAST(d.id AS nvarchar(36)) id,d.email
    FROM dbo.CommunicationDeliveries d
    JOIN dbo.Communications c WITH (READCOMMITTEDLOCK) ON c.id=d.communication_id AND c.deleted_at IS NULL AND c.status='Sending'
    WHERE d.state IN ('Queued','Retry') AND d.source<>'Test'`);
  const outside = waiting.recordset.filter((row) => !domainAllowed(String(row.email), safeMode.allowedDomains)).map((row) => String(row.id));
  if (!outside.length) return;
  for (let i = 0; i < outside.length; i += 1000)
    await pool.request().input("ids", sql.NVarChar(sql.MAX), JSON.stringify(outside.slice(i, i + 1000)))
      .query(`UPDATE dbo.CommunicationDeliveries SET state='Suppressed',suppressed_reason='SafeMode',next_attempt_at=NULL
        WHERE state IN ('Queued','Retry') AND source<>'Test' AND id IN (SELECT TRY_CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@ids))`);
}

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
  async recoverStale(now) {
    // As markFailed: a real row of a campaign that was cancelled while the row was with the worker has nothing left to try again, so it is
    // cancelled rather than queued for a claim that will never come. A Test row is claimed whatever its campaign is, so it is retried. The
    // attempts are kept and the row is due at once, unless that claim was its last attempt: then it is a dead letter.
    const cancelled = new Set(memoryCommunications().filter((c) => c.status === "Cancelled").map((c) => c.id));
    let recovered = 0;
    for (const d of memoryDeliveries()) {
      if (d.state !== "Processing" || !d.nextAttemptAt || new Date(d.nextAttemptAt) >= now) continue;
      const exhausted = d.attemptCount >= MAX_ATTEMPTS;
      Object.assign(d, {
        state: d.source !== "Test" && cancelled.has(d.communicationId) ? "Cancelled" : exhausted ? "Dead letter" : "Retry",
        nextAttemptAt: null,
        ...(exhausted ? { lastErrorCode: "LEASE_EXPIRED" } : {}),
      });
      recovered++;
    }
    return recovered;
  },
  async claimBatch(size) {
    const take = Math.floor(size);
    if (!(take >= 1)) return null;
    await settleBlockedInMemory();
    const now = Date.now();
    const campaigns = new Map(memoryCommunications().map((c) => [c.id, c]));
    const candidates = memoryDeliveries().filter((d) => {
      const campaign = campaigns.get(d.communicationId);
      return campaign && ["Queued", "Retry"].includes(d.state) && (!d.nextAttemptAt || new Date(d.nextAttemptAt).getTime() <= now) && (campaign.status === "Sending" || d.source === "Test");
    });
    const first = candidates[0];
    if (!first) return null;
    const campaign = campaigns.get(first.communicationId)!;
    // One campaign, one locale and one kind: a test mail has its own subject prefix and category, so it never rides along with real recipients.
    const batch = candidates.filter((d) => d.communicationId === first.communicationId && d.locale === first.locale && (d.source === "Test") === (first.source === "Test")).slice(0, take);
    for (const d of batch) { d.state = "Processing"; d.attemptCount += 1; d.nextAttemptAt = new Date(now + LEASE_MS).toISOString(); }
    return {
      communicationId: campaign.id, templateKey: campaign.templateKey, topic: campaign.topic, content: structuredClone(campaign.content), locale: first.locale,
      deliveries: batch.map((d) => ({ id: d.id, email: d.email, displayName: d.displayName, source: d.source, attemptCount: d.attemptCount })),
    };
  },
  async markAccepted(ids, providerMessageId, now) {
    // Only a row that is still Processing becomes Accepted. The provider's webhook can overtake the worker (a delivery reported before this request has
    // returned), and a row whose lease ran out was taken back; setting such a row to Accepted would undo what it was told, or what the worker decided.
    // The acceptance itself is a fact about the request, so every row named gets the message id (an event that names no delivery is matched by it), the
    // time (it counts against the day's cap) and no lease or error.
    for (const d of memoryDeliveries()) if (ids.includes(d.id)) Object.assign(d, { state: d.state === "Processing" ? "Accepted" : d.state, providerMessageId, acceptedAt: now.toISOString(), nextAttemptAt: null, lastErrorCode: null });
  },
  async markFailed(ids, errorCode, nextAttemptAt) {
    // A row of a campaign that was cancelled while the row was with the provider has nothing left to try again, whatever the failure was: it is
    // cancelled, so a cancelled campaign never holds a row that nothing will claim. A Test row is claimed whatever its campaign is, so it keeps its retry.
    const cancelled = new Set(memoryCommunications().filter((c) => c.status === "Cancelled").map((c) => c.id));
    for (const d of memoryDeliveries()) {
      if (!ids.includes(d.id)) continue;
      d.lastErrorCode = errorCode;
      // Only a row that is still Processing is settled by the failure. One the webhook has already moved (the provider took a request that looked failed from
      // here, and reported the delivery first) keeps what it was told, and one the lease took back is not the caller's: turning either into a retry would mail
      // it again. The code is recorded all the same; the next attempt goes with the state, so it is left as it is.
      if (d.state !== "Processing") continue;
      const stopped = d.source !== "Test" && cancelled.has(d.communicationId);
      Object.assign(d, { state: stopped ? "Cancelled" : nextAttemptAt ? "Retry" : "Dead letter", nextAttemptAt: stopped ? null : nextAttemptAt?.toISOString() ?? null });
    }
  },
  async releaseBatch(ids) {
    // The rows were claimed and nothing came of it (the provider refused the key, say), so they are as they were before the claim, attempt
    // included. Only a row that is still claimed: one that settled or was recovered meanwhile is not the caller's any more. As in markFailed and
    // recoverStale, a real row of a campaign that was cancelled meanwhile is cancelled rather than queued for a claim that will never come.
    const cancelled = new Set(memoryCommunications().filter((c) => c.status === "Cancelled").map((c) => c.id));
    for (const d of memoryDeliveries()) {
      if (!ids.includes(d.id) || d.state !== "Processing") continue;
      Object.assign(d, { state: d.source !== "Test" && cancelled.has(d.communicationId) ? "Cancelled" : "Queued", attemptCount: Math.max(0, d.attemptCount - 1), nextAttemptAt: null });
    }
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
  async recoverStale() {
    // The lease runs out by the database's clock, the one the claim stamped it with (SYSUTCDATETIME), not the application's: two clocks a few
    // seconds apart would shorten or lengthen every lease by that much. So the caller's `now` is not used here (the memory store, which has one
    // clock, uses it).
    // As markFailed: a real row of a campaign that was cancelled meanwhile is cancelled, not queued for a claim that will never come, and a cancel
    // that is committing is waited for (READCOMMITTEDLOCK); a Test row is claimed whatever its campaign is, so it is retried. The attempts are kept,
    // and the row is due at once (no next attempt), unless that claim was its last attempt: then it is a dead letter, with the reason recorded.
    // One statement, so it is atomic on its own.
    const result = await (await getSqlPool()).request().input("maxAttempts", sql.Int, MAX_ATTEMPTS)
      .query(`UPDATE d SET state=CASE WHEN c.status='Cancelled' AND d.source<>'Test' THEN 'Cancelled' WHEN d.attempt_count>=@maxAttempts THEN 'Dead letter' ELSE 'Retry' END,next_attempt_at=NULL,
          last_error_code=CASE WHEN d.attempt_count>=@maxAttempts THEN 'LEASE_EXPIRED' ELSE d.last_error_code END
        FROM dbo.CommunicationDeliveries d JOIN dbo.Communications c WITH (READCOMMITTEDLOCK) ON c.id=d.communication_id
        WHERE d.state='Processing' AND d.next_attempt_at<SYSUTCDATETIME()`);
    return result.rowsAffected[0];
  },
  async claimBatch(size) {
    const take = Math.floor(size);
    if (!(take >= 1)) return null;
    await settleBlockedInSql();
    // Which rows may be claimed is decided in three places, all the same: a row of a live campaign that is Sending, or a Test row of any live
    // campaign (a deleted draft's test mail is never sent). `next_campaign` picks the campaign and locale; `next_items` fills the TOP from rows that
    // can be claimed, so rows that cannot (whatever left them waiting) never crowd out those that can; the closing WHERE is what claims a row.
    // Two workers can pick the same rows in `next_items`, but the UPDATE checks each row again under its own lock, so a row the other worker has
    // just set to Processing is skipped instead of being claimed, and mailed, a second time.
    // A batch is one campaign, one locale and one kind: Test rows (their own subject prefix and category) or real rows, whichever the oldest row is.
    // `next_campaign` carries that row's source, `next_items` takes only rows of the same kind, and the UPDATE checks it once more.
    // What the UPDATE claims it leases: `next_attempt_at` becomes the time the claim runs out (see LEASE_MS), which `recoverStale` looks for.
    const result = await (await getSqlPool()).request().input("size", sql.Int, take).input("lease", sql.Int, LEASE_MS / 1000).query(`
      ;WITH next_campaign AS (
        SELECT TOP (1) d.communication_id,d.locale,d.source FROM dbo.CommunicationDeliveries d WITH (UPDLOCK,READPAST,ROWLOCK)
        JOIN dbo.Communications c ON c.id=d.communication_id AND c.deleted_at IS NULL
        WHERE d.state IN ('Queued','Retry') AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=SYSUTCDATETIME()) AND (c.status='Sending' OR d.source='Test')
        ORDER BY d.created_at
      ), next_items AS (
        SELECT TOP (@size) d.id,n.source FROM dbo.CommunicationDeliveries d
        JOIN next_campaign n ON n.communication_id=d.communication_id AND n.locale=d.locale AND (CASE WHEN d.source='Test' THEN 1 ELSE 0 END)=(CASE WHEN n.source='Test' THEN 1 ELSE 0 END)
        JOIN dbo.Communications c ON c.id=d.communication_id AND c.deleted_at IS NULL
        WHERE d.state IN ('Queued','Retry') AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=SYSUTCDATETIME()) AND (c.status='Sending' OR d.source='Test') ORDER BY d.created_at
      )
      UPDATE d SET state='Processing',attempt_count=attempt_count+1,next_attempt_at=DATEADD(second,@lease,SYSUTCDATETIME())
      OUTPUT CAST(INSERTED.id AS nvarchar(36)) id,INSERTED.email,INSERTED.display_name displayName,INSERTED.source,INSERTED.attempt_count attemptCount,INSERTED.locale,
        c.public_id communicationId,c.template_key templateKey,c.topic,c.content_json contentJson
      FROM dbo.CommunicationDeliveries d JOIN next_items q ON q.id=d.id JOIN dbo.Communications c ON c.id=d.communication_id AND c.deleted_at IS NULL
      WHERE d.state IN ('Queued','Retry') AND (c.status='Sending' OR d.source='Test') AND (CASE WHEN d.source='Test' THEN 1 ELSE 0 END)=(CASE WHEN q.source='Test' THEN 1 ELSE 0 END);`);
    if (!result.recordset.length) return null;
    const first = result.recordset[0];
    return {
      communicationId: first.communicationId, templateKey: first.templateKey, topic: first.topic, content: JSON.parse(first.contentJson), locale: first.locale === "is" ? "is" : "en",
      deliveries: result.recordset.map((r) => ({ id: r.id, email: r.email, displayName: r.displayName, source: r.source, attemptCount: Number(r.attemptCount) })),
    };
  },
  async markAccepted(ids, providerMessageId, now) {
    // As in memory: the state changes only for a row that is still Processing; the message id, the time and the cleared lease and error go on every row named.
    await (await getSqlPool()).request().input("ids", sql.NVarChar(sql.MAX), JSON.stringify(ids)).input("message", sql.NVarChar(200), providerMessageId).input("now", sql.DateTime2, now)
      .query("UPDATE dbo.CommunicationDeliveries SET state=CASE WHEN state='Processing' THEN 'Accepted' ELSE state END,provider_message_id=@message,accepted_at=@now,next_attempt_at=NULL,last_error_code=NULL WHERE id IN (SELECT TRY_CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@ids))");
  },
  async markFailed(ids, errorCode, nextAttemptAt) {
    // As in memory: only a row still Processing is settled (one that moved on keeps its state and its next attempt, and gets the code); a row of a campaign
    // that was cancelled meanwhile is cancelled, not queued for another try; a Test row keeps its retry.
    // READCOMMITTEDLOCK, as in completeCampaigns: the campaign is read with a lock, so a cancel that is committing is waited for and seen.
    await (await getSqlPool()).request().input("ids", sql.NVarChar(sql.MAX), JSON.stringify(ids)).input("state", sql.NVarChar(32), nextAttemptAt ? "Retry" : "Dead letter")
      .input("next", sql.DateTime2, nextAttemptAt).input("error", sql.NVarChar(100), errorCode.slice(0, 100))
      .query(`UPDATE d SET state=CASE WHEN d.state<>'Processing' THEN d.state WHEN c.status='Cancelled' AND d.source<>'Test' THEN 'Cancelled' ELSE @state END,
        next_attempt_at=CASE WHEN d.state<>'Processing' THEN d.next_attempt_at WHEN c.status='Cancelled' AND d.source<>'Test' THEN NULL ELSE @next END,last_error_code=@error
        FROM dbo.CommunicationDeliveries d JOIN dbo.Communications c WITH (READCOMMITTEDLOCK) ON c.id=d.communication_id
        WHERE d.id IN (SELECT TRY_CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@ids))`);
  },
  async releaseBatch(ids) {
    // As in memory: only rows still claimed, one attempt less (never below zero), no lease; a cancelled campaign's real rows are cancelled, and a
    // cancel that is committing is waited for (READCOMMITTEDLOCK). One statement, so it is atomic on its own.
    if (!ids.length) return;
    await (await getSqlPool()).request().input("ids", sql.NVarChar(sql.MAX), JSON.stringify(ids))
      .query(`UPDATE d SET state=CASE WHEN c.status='Cancelled' AND d.source<>'Test' THEN 'Cancelled' ELSE 'Queued' END,
          attempt_count=CASE WHEN d.attempt_count>0 THEN d.attempt_count-1 ELSE 0 END,next_attempt_at=NULL
        FROM dbo.CommunicationDeliveries d JOIN dbo.Communications c WITH (READCOMMITTEDLOCK) ON c.id=d.communication_id
        WHERE d.state='Processing' AND d.id IN (SELECT TRY_CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@ids))`);
  },
  async acceptedToday(now) {
    const result = await (await getSqlPool()).request().input("day", sql.Date, now).query("SELECT COUNT(*) count FROM dbo.CommunicationDeliveries WHERE accepted_at>=@day AND accepted_at<DATEADD(day,1,@day)");
    return Number(result.recordset[0].count);
  },
  async completeCampaigns(now) {
    // READCOMMITTEDLOCK: under read-committed snapshot (the Azure SQL default) a plain read sees the rows as they were before a retry that is
    // committing, and the campaign would be completed with Queued rows behind it. With locks, the read waits for that retry and sees its rows.
    const result = await (await getSqlPool()).request().input("now", sql.DateTime2, now).query(`
      UPDATE c SET status='Sent',completed_at=@now,updated_at=@now OUTPUT INSERTED.public_id id FROM dbo.Communications c
      WHERE c.status='Sending' AND NOT EXISTS (SELECT 1 FROM dbo.CommunicationDeliveries d WITH (READCOMMITTEDLOCK) WHERE d.communication_id=c.id AND d.source<>'Test' AND d.state IN ('Queued','Retry','Processing'))`);
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

/** The states of a real row once mail is with the provider or has been answered for: Processing is on its way, the others are what the provider (and its events) made of it. */
const MAIL_OUT_STATES = ["Processing", "Accepted", "Deferred", "Delivered", "Bounced", "Dropped"];

/**
 * Whether mail has left for the campaign, or may be leaving: a real row (a test mail is for staff and does not count) that is with the provider or has
 * been answered for. The rows are the record of who was mailed (spec §11), so a campaign that has any is kept, not deleted. A cancelled campaign has
 * no row left for the worker to claim, so a row that is not Processing now cannot become one later.
 */
export async function hasMailedRows(publicId: string): Promise<boolean> {
  if (!isContentSqlActive()) return memoryDeliveries().some((d) => d.communicationId === publicId && d.source !== "Test" && MAIL_OUT_STATES.includes(d.state));
  const result = await (await getSqlPool()).request().input("id", sql.NVarChar(32), publicId).query(
    `SELECT TOP (1) 1 mailed FROM dbo.CommunicationDeliveries d JOIN dbo.Communications c ON c.id=d.communication_id
     WHERE c.public_id=@id AND d.source<>'Test' AND d.state IN (${MAIL_OUT_STATES.map((state) => `'${state}'`).join(",")})`);
  return result.recordset.length > 0;
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

/**
 * Queues the campaign's Dead letter rows again, attempts started over, and says how many it queued and whether it reopened the campaign.
 * The worker claims the rows of a Sending campaign only, and `completeCampaigns` finishes a campaign whose rows are all settled, dead letters
 * included. So a campaign that has completed (Sent) and gets a real row waiting again is Sending again, in the same unit of work as the
 * requeue: `completed_at` goes, `started_at` and the recipient count stay, and `completeCampaigns` completes it once the retried rows settle.
 * Nothing else is reopened: a Test row alone is claimed whatever its campaign is. Nothing is requeued into a Cancelled campaign at all, since
 * nothing would ever claim or cancel those rows again (`retryDeadLetters` refuses such a campaign; this guards a retry racing the cancel).
 */
export async function requeueDeadLetters(publicId: string): Promise<{ requeued: number; reopened: boolean }> {
  if (!isContentSqlActive()) {
    const campaign = memoryCommunications().find((c) => c.id === publicId);
    if (campaign?.status === "Cancelled") return { requeued: 0, reopened: false };
    let requeued = 0;
    for (const d of memoryDeliveries()) if (d.communicationId === publicId && d.state === "Dead letter") { Object.assign(d, { state: "Queued", attemptCount: 0, nextAttemptAt: null, lastErrorCode: null }); requeued++; }
    const reopened = requeued > 0 && campaign?.status === "Sent" && memoryDeliveries().some((d) => d.communicationId === publicId && d.source !== "Test" && OPEN.has(d.state));
    if (campaign && reopened) Object.assign(campaign, { status: "Sending", completedAt: undefined, updatedAt: new Date().toISOString() });
    return { requeued, reopened };
  }
  return atomicSql(async () => {
    const pool = await getSqlPool();
    const requeue = await pool.request().input("id", sql.NVarChar(32), publicId)
      .query("UPDATE d SET state='Queued',attempt_count=0,next_attempt_at=NULL,last_error_code=NULL FROM dbo.CommunicationDeliveries d JOIN dbo.Communications c ON c.id=d.communication_id WHERE c.public_id=@id AND c.status<>'Cancelled' AND d.state='Dead letter'");
    const requeued: number = requeue.rowsAffected[0];
    if (!requeued) return { requeued, reopened: false };
    // The invariant, stated once: a Sent campaign with a real row waiting is Sending. The requeue above is visible here, inside the same unit of work.
    const reopen = await pool.request().input("id", sql.NVarChar(32), publicId)
      .query(`UPDATE c SET status='Sending',completed_at=NULL,updated_at=SYSUTCDATETIME()
        FROM dbo.Communications c
        WHERE c.public_id=@id AND c.status='Sent' AND c.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM dbo.CommunicationDeliveries d WHERE d.communication_id=c.id AND d.source<>'Test' AND d.state IN ('Queued','Retry','Processing'))`);
    return { requeued, reopened: reopen.rowsAffected[0] > 0 };
  });
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
