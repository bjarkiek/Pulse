import sgMail from "@sendgrid/mail";
import type { CommunicationSettings } from "./settings";

// The mail provider behind a small interface: the worker hands a batch to a `MailTransport` and learns whether it was accepted. Nothing from a
// provider error body is read or logged (it can echo recipient data); a failure is reduced to a code, whether it is worth retrying, and how long
// the provider asked to wait.

export type OutboundRecipient = { email: string; name: string | null; customArgs: Record<string, string> };
export type OutboundBatch = {
  subject: string; html: string; text: string; recipients: OutboundRecipient[];
  from: { email: string; name: string }; replyTo: string | null; categories: string[];
  unsubscribeGroupId: number | null; tracking: { opens: boolean; clicks: boolean }; sandbox: boolean;
};
export type SendOutcome = { providerMessageId: string | null };
export class SendError extends Error {
  constructor(public code: string, public retryable: boolean, public retryAfterSeconds: number | null = null) {
    super(code);
    this.name = "SendError";
  }
}
export type MailTransport = { kind: "sendgrid" | "console"; sendBatch(batch: OutboundBatch): Promise<SendOutcome> };

/** A request that gets no answer is given up after this long, so a dead connection cannot hold a run (and the leases of its rows) for ever. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Shape accepted by @sendgrid/mail (camelCase keys are converted by the SDK). */
export function buildSendGridMessage(batch: OutboundBatch): Record<string, unknown> {
  return {
    from: batch.from,
    ...(batch.replyTo ? { replyTo: { email: batch.replyTo } } : {}),
    subject: batch.subject,
    html: batch.html,
    text: batch.text,
    personalizations: batch.recipients.map((r) => ({ to: [{ email: r.email, ...(r.name ? { name: r.name } : {}) }], customArgs: r.customArgs })),
    categories: batch.categories.slice(0, 10),
    ...(batch.unsubscribeGroupId ? { asm: { groupId: batch.unsubscribeGroupId } } : {}),
    trackingSettings: { clickTracking: { enable: batch.tracking.clicks, enableText: false }, openTracking: { enable: batch.tracking.opens } },
    mailSettings: { sandboxMode: { enable: batch.sandbox } },
  };
}

export function classifySendError(error: unknown): SendError {
  if (error instanceof SendError) return error;
  const e = error as { code?: unknown; response?: { headers?: Record<string, string>; body?: { errors?: Array<{ message?: string }> } }; message?: string };
  const status = typeof e?.code === "number" ? e.code : Number(e?.code);
  if (Number.isFinite(status) && status >= 100) {
    const retryAfter = Number(e.response?.headers?.["retry-after"]);
    return new SendError(`HTTP_${status}`, status === 429 || status >= 500, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
  }
  return new SendError((e?.message || "SEND_FAILED").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40), true);
}

/** Development and tests without a key: nothing leaves the process. The worker refuses this transport in production. */
const consoleTransport: MailTransport = {
  kind: "console",
  async sendBatch(batch) {
    console.log(JSON.stringify({ level: "info", event: "communications.console-send", recipients: batch.recipients.length, sandbox: batch.sandbox }));
    return { providerMessageId: `console-${crypto.randomUUID()}` };
  },
};

/**
 * Points the SDK at SendGrid with the key, a request timeout and the region the account lives in. `@sendgrid/mail`'s `MailService` has no
 * data-residency setter of its own (its typings have none either): that belongs to the HTTP client it sends through, which is why it is reached here.
 */
function configureSdk(apiKey: string, residency: CommunicationSettings["dataResidency"]) {
  sgMail.setApiKey(apiKey);
  sgMail.setTimeout(REQUEST_TIMEOUT_MS);
  (sgMail as unknown as { client: { setDataResidency(region: "global" | "eu"): unknown } }).client.setDataResidency(residency === "eu" ? "eu" : "global");
}

export function createMailTransport(settings: CommunicationSettings, overrides?: { send?: (message: Record<string, unknown>) => Promise<{ statusCode: number; headers: Record<string, string> }> }): MailTransport {
  const apiKey = process.env.SENDGRID_API_KEY?.trim();
  if (!apiKey && !overrides?.send) return consoleTransport;
  const send = overrides?.send ?? (async (message: Record<string, unknown>) => {
    configureSdk(apiKey!, settings.dataResidency);
    const [response] = await sgMail.send(message as never);
    return { statusCode: response.statusCode, headers: response.headers as Record<string, string> };
  });
  return {
    kind: "sendgrid",
    async sendBatch(batch) {
      try {
        const response = await send(buildSendGridMessage(batch));
        if (response.statusCode < 200 || response.statusCode >= 300) throw new SendError(`HTTP_${response.statusCode}`, response.statusCode >= 500);
        return { providerMessageId: response.headers?.["x-message-id"] ?? null };
      } catch (error) {
        throw classifySendError(error);
      }
    },
  };
}
