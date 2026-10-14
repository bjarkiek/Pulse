import { getIdentity } from "@/lib/server/auth";
import { duplicateCommunication } from "@/lib/server/communications/campaign-repository";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeIdempotent } from "@/lib/server/idempotency";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const identity = await getIdentity(request);
    const result = await executeIdempotent(request, identity, `communication.duplicate:${id}`, 201, async () => ({
      item: await duplicateCommunication(identity, id),
    }));
    return json(result.body, { status: result.status }, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
