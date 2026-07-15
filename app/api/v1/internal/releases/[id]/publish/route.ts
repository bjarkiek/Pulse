import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeIdempotent } from "@/lib/server/idempotency";
import { publishRelease } from "@/lib/server/operations-repository";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const identity = getIdentity(request);
    const result = await executeIdempotent(
      request,
      identity,
      `release.publish:${id}`,
      200,
      async () => ({ item: await publishRelease(identity, id) }),
    );
    return json(result.body, { status: result.status }, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
