import { getIdentity } from "@/lib/server/auth";
import { retryDeadLetters } from "@/lib/server/communications/campaign-repository";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeIdempotent } from "@/lib/server/idempotency";

/** Queues the campaign's dead-lettered recipients again and answers with how many it queued and whether that reopened a campaign that had completed. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const identity = await getIdentity(request);
    const result = await executeIdempotent(request, identity, `communication.retry:${id}`, 200, () => retryDeadLetters(identity, id));
    return json(result.body, { status: result.status }, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
