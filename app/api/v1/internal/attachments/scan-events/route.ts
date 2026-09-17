import { apiError, correlationId, json } from "@/lib/server/http";
import { readJsonValue } from "@/lib/server/validation";
import {
  scannerAuthorized,
  processScanEvent,
} from "@/lib/server/attachment-scanner";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    if (!scannerAuthorized(request)) throw new Error("UNAUTHORIZED");
    const events = await readJsonValue(request);
    if (!Array.isArray(events) || events.length > 50)
      throw new Error("INVALID_SCAN_EVENTS");
    if (
      events.length === 1 &&
      events[0]?.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent"
    ) {
      const code = events[0]?.data?.validationCode;
      if (typeof code !== "string" || code.length > 128)
        throw new Error("INVALID_VALIDATION_CODE");
      return json({ validationResponse: code }, {}, id);
    }
    for (const event of events) await processScanEvent(event);
    return json({ ok: true }, {}, id);
  } catch (error) {
    if (error instanceof Error && error.message === "SCAN_COMPLETION_PENDING")
      return json(
        { retry: true },
        { status: 503, headers: { "retry-after": "30" } },
        id,
      );
    return apiError(error, id);
  }
}
