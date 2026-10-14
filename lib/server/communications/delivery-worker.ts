import { isDemoDataActive } from "../database";
import { BACKOFF_BASE_MS, MAX_ATTEMPTS, getDeliveryStore, type ClaimedDelivery, type DeliveryStore } from "./delivery-store";
import { SendError, classifySendError, createMailTransport, type MailTransport, type OutboundBatch, type SendOutcome } from "./sendgrid";
import { getRuntimeCommunicationSettings } from "./settings";
import { renderCommunication } from "./templates/index";

// The worker drains the outbox: it claims a batch (one campaign, one locale, Test rows or real rows), renders the mail once for the batch, hands
// it to the transport as one request and settles the rows by the answer (see `deliver`: accepted, given back, retried, split or dead-lettered).
// Logs carry counts, codes and campaign ids only, never an address, a subject or a body.

export type WorkerResult = {
  skipped: boolean; promoted: string[]; accepted: number; retried: number; deadLettered: number; completed: string[]; capReached: boolean;
  recovered: number; // rows whose claim had run out (a run that died): put back to be sent, or settled when their attempts were used up or their campaign was cancelled
  splits: number; // requests made beyond the first for a batch the provider rejected as a whole, to find the recipient it would not take
};

/** Most rows one run takes, and most recipients in one request to the provider. */
const MAX_RUN_ROWS = 5000;
const MAX_REQUEST_ROWS = 500;
/** A provider's Retry-After is honoured up to this, so a wild value cannot park a row for years. */
const MAX_RETRY_WAIT_MS = 24 * 3_600_000;
/**
 * Most extra requests the splitting of one batch may make. Finding one rejected recipient among n costs about 2 x log2(n) (18 of 500), so three of
 * them in a full batch fit. A message the provider will not take at all is rejected whoever it goes to, and splitting that down to single
 * recipients would take 2n - 2 requests; past the cap, the rows not yet isolated wait for the next tick.
 */
export const MAX_SPLIT_REQUESTS = 64;

/** What the settling of rows shares: the store, the clock, the counters of the run and the campaign the batch belongs to. */
type Settling = { store: DeliveryStore; now: () => Date; result: WorkerResult; communicationId: string };
/** A rendered batch ready to be sent: how to build the request for some of its rows, and how many extra requests the splitting may still make. */
type Batch = Settling & { transport: MailTransport; request(rows: ClaimedDelivery[]): OutboundBatch; splitsLeft: number };

const statusOf = (code: string) => { const match = /^HTTP_(\d{3})$/.exec(code); return match ? Number(match[1]) : null; };
const idsOf = (rows: ClaimedDelivery[]) => rows.map((d) => d.id);

export async function processCommunicationBatch(limit = 500, deps: { store?: DeliveryStore; transport?: MailTransport; now?: () => Date } = {}): Promise<WorkerResult> {
  const result: WorkerResult = { skipped: false, promoted: [], accepted: 0, retried: 0, deadLettered: 0, completed: [], capReached: false, recovered: 0, splits: 0 };
  // With "Show demo data" on, a campaign and its deliveries live in memory, but its audience is still the real people of the real organisations:
  // nothing of it may be mailed.
  if (isDemoDataActive()) return { ...result, skipped: true };
  const settings = await getRuntimeCommunicationSettings();
  if (!settings.enabled) return { ...result, skipped: true };
  const store = deps.store ?? getDeliveryStore();
  const transport = deps.transport ?? createMailTransport(settings);
  // No key means the console transport, which mails nobody: fine on a developer's machine, a misconfiguration in production, where every row
  // would be marked Accepted without a mail having left. So production stops here, before anything is claimed.
  if (transport.kind === "console" && process.env.NODE_ENV === "production") throw new Error("INVALID_EMAIL_PROVIDER_CONFIGURATION");
  const now = deps.now ?? (() => new Date());
  const publicUrl = (process.env.PULSE_PUBLIC_URL || "http://localhost:3000").replace(/\/+$/, "");
  result.recovered = await store.recoverStale(now());
  if (result.recovered) console.warn(JSON.stringify({ level: "warn", event: "communications.recovered-stale", count: result.recovered }));
  result.promoted = await store.promoteScheduled(now());
  const acceptedBefore = await store.acceptedToday(now());
  const max = Math.min(Math.max(Math.floor(limit) || 1, 1), MAX_RUN_ROWS);
  let processed = 0;
  while (processed < max) {
    const room = settings.dailyCap - acceptedBefore - result.accepted;
    if (room <= 0) { result.capReached = true; break; }
    const claimed = await store.claimBatch(Math.min(MAX_REQUEST_ROWS, room, max - processed));
    if (!claimed) break;
    processed += claimed.deliveries.length;
    const isTest = claimed.deliveries[0].source === "Test";
    const settling: Settling = { store, now, result, communicationId: claimed.communicationId };
    let rendered: ReturnType<typeof renderCommunication>;
    try {
      rendered = renderCommunication(claimed.templateKey, claimed.content, claimed.locale, {
        publicUrl, boilerplate: settings.boilerplate[claimed.locale], unsubscribeTags: settings.unsubscribeGroupId !== null, testPrefix: isTest,
      });
    } catch {
      // Rendering is inside a try: a campaign that cannot be rendered fails its batch like a rejected request does (retried, then a dead
      // letter), instead of throwing out of the run and leaving the batch with the worker until its claim runs out, again and again.
      await settleFailure(settling, claimed.deliveries, new SendError("RENDER_FAILED", true));
      continue;
    }
    const batch: Batch = {
      ...settling, transport, splitsLeft: MAX_SPLIT_REQUESTS,
      request: (rows) => ({
        subject: rendered.subject, html: rendered.html, text: rendered.text,
        recipients: rows.map((d) => ({ email: d.email, name: d.displayName, customArgs: { deliveryId: d.id, communicationId: claimed.communicationId } })),
        from: { email: settings.fromEmail, name: settings.fromName }, replyTo: settings.replyTo || null,
        categories: [settings.categoriesPrefix, `${settings.categoriesPrefix}-${isTest ? "test" : claimed.topic}`, claimed.communicationId],
        unsubscribeGroupId: settings.unsubscribeGroupId, tracking: settings.tracking, sandbox: settings.sandboxMode,
      }),
    };
    if (!(await deliver(batch, claimed.deliveries))) break;
  }
  result.completed = await store.completeCampaigns(now());
  return result;
}

/**
 * Sends `rows` (a claimed batch, or a piece of one) as one request and settles them by the answer. False means the tick must stop.
 * - Accepted: the rows are Accepted, with the message id of this request.
 * - 401 or 403, the key or the sender is refused: that is the same for every recipient of every campaign, so no row is at fault. The rows are
 *   given back as if never claimed (attempts as they were), the code is logged once and the tick stops; the next tick tries again, once someone
 *   has fixed it. Nothing is dead-lettered.
 * - 429: the rows wait, and the tick stops to give the provider its window. 5xx and network failures: the rows wait and the tick goes on.
 * - Another 4xx (400, 413, 422 ...) is the provider refusing this request, and with more than one recipient it can be one address among them
 *   that spoils it for all. So the rows are split in halves, each half sent as a request of its own with the same rendered mail, the halves
 *   again, until the recipient the provider will not take stands alone; only that row is a dead letter, the others are accepted. A piece that the
 *   cap on extra requests leaves unsplit waits for the next tick, like a failed send, and is not dead-lettered unless its attempts are used up.
 * - A failure that is none of these and not worth retrying dead-letters the rows at once.
 * When a piece of a split makes the tick stop, the pieces not yet sent are given back unclaimed (they were never tried).
 */
async function deliver(batch: Batch, rows: ClaimedDelivery[]): Promise<boolean> {
  let outcome: SendOutcome;
  try {
    outcome = await batch.transport.sendBatch(batch.request(rows));
  } catch (error) {
    const failure = classifySendError(error, batch.now().getTime());
    const status = statusOf(failure.code);
    if (status === 401 || status === 403) {
      console.error(JSON.stringify({ level: "error", event: "communications.send.misconfigured", communicationId: batch.communicationId, code: failure.code, recipients: rows.length }));
      await batch.store.releaseBatch(idsOf(rows));
      return false;
    }
    if (!failure.retryable && status !== null && status >= 400 && status < 500 && rows.length > 1) {
      if (batch.splitsLeft < 2) {
        await settleFailure(batch, rows, new SendError(failure.code, true, failure.retryAfterSeconds));
        return true;
      }
      const middle = Math.ceil(rows.length / 2);
      const halves = [rows.slice(0, middle), rows.slice(middle)];
      batch.splitsLeft -= 2; // both halves are reserved now, so that the halves still to be sent further up are counted when a piece below decides
      for (const [index, half] of halves.entries()) {
        batch.result.splits += 1;
        if (await deliver(batch, half)) continue;
        const untried = halves.slice(index + 1).flat();
        if (untried.length) await batch.store.releaseBatch(idsOf(untried));
        return false;
      }
      return true;
    }
    await settleFailure(batch, rows, failure);
    return failure.code !== "HTTP_429";
  }
  // Outside the try on purpose: the provider has accepted the mail, so an error from the database here is not a failed send. It ends the run
  // with the rows still claimed, and their claim running out is what puts them back. They are then sent again (mail is at-least-once), but
  // each such claim counts as an attempt, so a row that never settles is mailed MAX_ATTEMPTS times at most.
  await batch.store.markAccepted(idsOf(rows), outcome.providerMessageId, batch.now());
  batch.result.accepted += rows.length;
  return true;
}

/**
 * Settles rows whose request failed, row by row: a row on its last attempt (or any row, when the failure is not worth retrying) is a dead
 * letter; the others wait for a retry, each by the backoff of its own attempt, or by the provider's Retry-After when that is longer. The
 * failure is logged first, so that it is on record even when the database then fails to take the settling.
 */
async function settleFailure(batch: Settling, rows: ClaimedDelivery[], failure: SendError) {
  const finished = rows.filter((d) => !failure.retryable || d.attemptCount >= MAX_ATTEMPTS);
  const waiting = new Map<number, ClaimedDelivery[]>();
  for (const d of rows) if (failure.retryable && d.attemptCount < MAX_ATTEMPTS) waiting.set(d.attemptCount, [...(waiting.get(d.attemptCount) ?? []), d]);
  console.error(JSON.stringify({ level: "error", event: "communications.send.failed", communicationId: batch.communicationId, code: failure.code, recipients: rows.length, terminal: finished.length === rows.length }));
  if (finished.length) {
    await batch.store.markFailed(idsOf(finished), failure.code, null);
    batch.result.deadLettered += finished.length;
  }
  for (const [attempt, group] of waiting) {
    const wait = Math.min(Math.max(2 ** attempt * BACKOFF_BASE_MS, (failure.retryAfterSeconds ?? 0) * 1000), MAX_RETRY_WAIT_MS);
    await batch.store.markFailed(idsOf(group), failure.code, new Date(batch.now().getTime() + wait));
    batch.result.retried += group.length;
  }
}
