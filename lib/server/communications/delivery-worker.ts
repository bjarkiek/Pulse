import { isDemoDataActive } from "../database";
import { BACKOFF_BASE_MS, MAX_ATTEMPTS, getDeliveryStore, type DeliveryStore } from "./delivery-store";
import { classifySendError, createMailTransport, type MailTransport, type SendOutcome } from "./sendgrid";
import { getRuntimeCommunicationSettings } from "./settings";
import { renderCommunication } from "./templates/index";

// The worker drains the outbox: it claims a batch (one campaign, one locale, Test rows or real rows), renders the mail once for the batch, hands
// it to the transport as one request and settles the rows by the outcome. Logs carry counts, codes and campaign ids only, never an address, a
// subject or a body.

export type WorkerResult = {
  skipped: boolean; promoted: string[]; accepted: number; retried: number; deadLettered: number; completed: string[]; capReached: boolean;
  recovered: number; // rows whose claim had run out (a run that died): put back to be sent, or settled when their attempts were used up or their campaign was cancelled
};

/** Most rows one run takes, and most recipients in one request to the provider. */
const MAX_RUN_ROWS = 5000;
const MAX_REQUEST_ROWS = 500;
/** A provider's Retry-After is honoured up to this, so a wild value cannot park a row for years. */
const MAX_RETRY_WAIT_MS = 24 * 3_600_000;

export async function processCommunicationBatch(limit = 500, deps: { store?: DeliveryStore; transport?: MailTransport; now?: () => Date } = {}): Promise<WorkerResult> {
  const result: WorkerResult = { skipped: false, promoted: [], accepted: 0, retried: 0, deadLettered: 0, completed: [], capReached: false, recovered: 0 };
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
  let acceptedToday = await store.acceptedToday(now());
  const max = Math.min(Math.max(Math.floor(limit) || 1, 1), MAX_RUN_ROWS);
  let processed = 0;
  while (processed < max) {
    const room = settings.dailyCap - acceptedToday;
    if (room <= 0) { result.capReached = true; break; }
    const batch = await store.claimBatch(Math.min(MAX_REQUEST_ROWS, room, max - processed));
    if (!batch) break;
    const ids = batch.deliveries.map((d) => d.id);
    processed += ids.length;
    const isTest = batch.deliveries[0].source === "Test";
    let outcome: SendOutcome;
    try {
      // Rendering is inside the try: a campaign that cannot be rendered fails its batch like a rejected request does (retried, then a dead
      // letter), instead of throwing out of the run and leaving the batch with the worker until its claim runs out, again and again.
      const rendered = renderCommunication(batch.templateKey, batch.content, batch.locale, {
        publicUrl, boilerplate: settings.boilerplate[batch.locale], unsubscribeTags: settings.unsubscribeGroupId !== null, testPrefix: isTest,
      });
      outcome = await transport.sendBatch({
        subject: rendered.subject, html: rendered.html, text: rendered.text,
        recipients: batch.deliveries.map((d) => ({ email: d.email, name: d.displayName, customArgs: { deliveryId: d.id, communicationId: batch.communicationId } })),
        from: { email: settings.fromEmail, name: settings.fromName }, replyTo: settings.replyTo || null,
        categories: [settings.categoriesPrefix, `${settings.categoriesPrefix}-${isTest ? "test" : batch.topic}`, batch.communicationId],
        unsubscribeGroupId: settings.unsubscribeGroupId, tracking: settings.tracking, sandbox: settings.sandboxMode,
      });
    } catch (error) {
      const failure = classifySendError(error);
      const attempt = Math.max(...batch.deliveries.map((d) => d.attemptCount));
      const terminal = !failure.retryable || attempt >= MAX_ATTEMPTS;
      const wait = Math.min(Math.max(2 ** attempt * BACKOFF_BASE_MS, (failure.retryAfterSeconds ?? 0) * 1000), MAX_RETRY_WAIT_MS);
      await store.markFailed(ids, failure.code, terminal ? null : new Date(now().getTime() + wait));
      if (terminal) result.deadLettered += ids.length; else result.retried += ids.length;
      console.error(JSON.stringify({ level: "error", event: "communications.send.failed", communicationId: batch.communicationId, code: failure.code, recipients: ids.length, terminal }));
      if (failure.code === "HTTP_429") break; // give the provider the Retry-After window
      continue;
    }
    // Outside the try on purpose: the provider has accepted the mail, so an error from the database here is not a failed send. It ends the run
    // with the rows still claimed, and their claim running out is what puts them back. They are then sent again (mail is at-least-once), but
    // each such claim counts as an attempt, so a row that never settles is mailed MAX_ATTEMPTS times at most.
    await store.markAccepted(ids, outcome.providerMessageId, now());
    result.accepted += ids.length;
    acceptedToday += ids.length;
  }
  result.completed = await store.completeCampaigns(now());
  return result;
}
