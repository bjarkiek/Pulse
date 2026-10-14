import { getIdentity } from "@/lib/server/auth";
import { audienceEstimate } from "@/lib/server/communications/campaign-repository";
import { apiError, correlationId, json } from "@/lib/server/http";

/** The counts of who a send would reach; nothing is written and no address is returned. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    return json({ item: await audienceEstimate(await getIdentity(request), id) }, {}, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
