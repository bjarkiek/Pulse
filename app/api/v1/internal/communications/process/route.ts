import { getIdentity } from "@/lib/server/auth";
import { requirePublishRole } from "@/lib/server/authorization";
import { processCommunicationBatch } from "@/lib/server/communications/delivery-worker";
import { apiError, correlationId, json } from "@/lib/server/http";

/** Runs one pass of the delivery worker for a signed-in Product manager or System admin, the same pass the scheduled job runs. Needs no body. */
export async function POST(request: Request) {
  const correlation = correlationId(request);
  try {
    await requirePublishRole(await getIdentity(request));
    return json({ item: await processCommunicationBatch(500) }, {}, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
