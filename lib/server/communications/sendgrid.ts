import sgMail from "@sendgrid/mail";
import type { PulseIdentity } from "@/lib/domain";
import { requireInternalRole } from "../authorization";
import { getRuntimeCommunicationSettings, type CommunicationSettings } from "./settings";
import { renderCommunication } from "./templates/index";

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

/**
 * The codes a failure without an HTTP status may be named by. Anything else is SEND_FAILED: an error message is free text (it can carry an
 * address, a host, a path) and does not belong in a log line or a column. ECONNABORTED is what axios raises when the request timeout passes.
 */
const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "ECONNABORTED"]);

/**
 * What a failed send means: the HTTP status as `HTTP_<status>` (retryable for 429 and 5xx), and how long the provider asked to wait, from
 * Retry-After or, for a 429, from X-RateLimit-Reset (epoch seconds; `nowMs` is the clock it is measured against). A failure without a status is
 * retryable and is named by a known network code, or SEND_FAILED.
 */
export function classifySendError(error: unknown, nowMs = Date.now()): SendError {
  if (error instanceof SendError) return error;
  const e = error as { code?: unknown; response?: { headers?: Record<string, string> }; message?: unknown } | null | undefined;
  const status = typeof e?.code === "number" ? e.code : Number(e?.code);
  if (Number.isFinite(status) && status >= 100) {
    const headers = e?.response?.headers;
    let wait = Number(headers?.["retry-after"]);
    if (!(Number.isFinite(wait) && wait > 0) && status === 429) {
      const reset = Number(headers?.["x-ratelimit-reset"]);
      wait = Number.isFinite(reset) && reset * 1000 > nowMs ? Math.ceil(reset - nowMs / 1000) : Number.NaN;
    }
    return new SendError(`HTTP_${status}`, status === 429 || status >= 500, Number.isFinite(wait) && wait > 0 ? wait : null);
  }
  const message = String(e?.message ?? "");
  const known = typeof e?.code === "string" && NETWORK_CODES.has(e.code) ? e.code : [...NETWORK_CODES].find((code) => message.includes(code));
  return new SendError(known ?? "SEND_FAILED", true);
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

/**
 * One test mail to the signed-in System admin, through the real transport and with the saved settings: how an admin finds out, before any campaign,
 * that the key, the sender and the region work. It does not go through the worker or its queue and does not need `enabled`, but safe mode holds:
 * the caller's own address must be on its list (compared by whole domain, as the audience does) or safe mode must be off.
 *
 * A refusal from the provider is named by its code alone, `INVALID_EMAIL_PROVIDER_<code>`: the body of an error can echo an address, so it is never read.
 * Nothing is logged here; without a key the console transport takes the mail and logs a count. `settingsOverride` is for tests, the route never passes it.
 */
export async function sendConfigurationTest(identity: PulseIdentity, options: { settingsOverride?: CommunicationSettings } = {}) {
  await requireInternalRole(identity, ["System admin"]);
  const settings = options.settingsOverride ?? (await getRuntimeCommunicationSettings());
  if (!settings.fromEmail) throw new Error("INVALID_EMAIL_PROVIDER_CONFIGURATION");
  const email = identity.email.toLowerCase();
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (settings.safeMode.enabled && !settings.safeMode.allowedDomains.some((allowed) => allowed.toLowerCase() === domain)) throw new Error("INVALID_SAFE_MODE_BLOCKS_RECIPIENT");
  const publicUrl = (process.env.PULSE_PUBLIC_URL || "http://localhost:3000").replace(/\/+$/, "");
  const rendered = renderCommunication("plain", {
    subject: { en: "Pulse communications configuration test" },
    body: { en: { title: "Configuration test", paragraphs: ["This message confirms that Pulse can send customer communications through SendGrid with the current settings.", `Sending state: ${settings.sandboxMode ? "sandbox" : settings.safeMode.enabled ? "safe mode" : "live"}.`] } },
  }, "en", { publicUrl, boilerplate: settings.boilerplate.en, unsubscribeTags: settings.unsubscribeGroupId !== null, testPrefix: true });
  const transport = createMailTransport(settings);
  try {
    const outcome = await transport.sendBatch({
      subject: rendered.subject, html: rendered.html, text: rendered.text,
      recipients: [{ email, name: identity.name, customArgs: { deliveryId: "configuration-test", communicationId: "configuration-test" } }],
      from: { email: settings.fromEmail, name: settings.fromName }, replyTo: settings.replyTo || null,
      categories: [settings.categoriesPrefix, `${settings.categoriesPrefix}-configuration-test`], unsubscribeGroupId: settings.unsubscribeGroupId, tracking: { opens: false, clicks: false }, sandbox: settings.sandboxMode,
    });
    return { ok: true as const, transport: transport.kind, providerMessageId: outcome.providerMessageId };
  } catch (error) {
    throw new Error(`INVALID_EMAIL_PROVIDER_${classifySendError(error).code}`);
  }
}
