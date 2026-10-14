import { getIdentity } from "@/lib/server/auth";
import { audienceEstimate, currentSendingState } from "@/lib/server/communications/campaign-repository";
import { apiError, correlationId, json } from "@/lib/server/http";

/**
 * The counts of who a send would reach, and beside them what the worker would do with it now (`effectiveSendingState`, for every internal role: the
 * sender sees the warnings before pressing Send). Nothing is written and no address is returned.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const identity = await getIdentity(request);
    const item = await audienceEstimate(identity, id);
    return json({ item, effectiveSendingState: await currentSendingState(identity) }, {}, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
