import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeIdempotent } from "@/lib/server/idempotency";
import { publishIdea } from "@/lib/server/product-repository";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const identity = await getIdentity(request);
    const result = await executeIdempotent(
      request,
      identity,
      `idea.publish:${id}`,
      200,
      async () => {
        const body = await request.json();
        return {
          item: await publishIdea(identity, id, body.confirmedSafe === true),
        };
      },
    );
    return json(result.body, { status: result.status }, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
