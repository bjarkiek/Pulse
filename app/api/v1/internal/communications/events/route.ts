import { applyEvents, parseEvents, verifyEventSignature } from "@/lib/server/communications/event-webhook";
import { apiError, correlationId, json } from "@/lib/server/http";

const MAX_BYTES = 1024 * 1024;
/** The body exactly as it came, up to 1 MiB: the signature is over its bytes, so it is read as text and parsed only after that check. */
async function readRawText(request: Request) {
  if (Number(request.headers.get("content-length") || 0) > MAX_BYTES) throw new Error("PAYLOAD_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("INVALID_JSON");
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { void reader.cancel().catch(() => undefined); throw new Error("PAYLOAD_TOO_LARGE"); }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

/**
 * SendGrid Event Webhook. Anonymous: no session, no secret in a header, only the signature SendGrid puts on the body. Nothing is logged per event
 * (addresses are personal data); a failure answers with a code and a correlation id, and SendGrid posts the batch again.
 */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const publicKey = process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY?.trim();
    if (!publicKey)
      return json({ error: { code: "WEBHOOK_NOT_CONFIGURED", message: "Configure SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY.", correlationId: id } }, { status: 503, headers: { "retry-after": "300" } }, id);
    const raw = await readRawText(request);
    const ok = verifyEventSignature(publicKey, raw, request.headers.get("x-twilio-email-event-webhook-signature"), request.headers.get("x-twilio-email-event-webhook-timestamp"));
    if (!ok) throw new Error("UNAUTHORIZED");
    return json(await applyEvents(parseEvents(raw)), {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
