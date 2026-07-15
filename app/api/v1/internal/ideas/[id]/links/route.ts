import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeIdempotent } from "@/lib/server/idempotency";
import {
  linkRequest,
  moveRequestLink,
} from "@/lib/server/product-repository";
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
      `idea.link:${id}`,
      201,
      async () => {
        const body = await request.json();
        return linkRequest(identity, id, body.requestId, body.reason);
      },
    );
    return json(result.body, { status: result.status }, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const body = await request.json();
    return json(
      await moveRequestLink(
        await getIdentity(request),
        id,
        String(body.requestId || ""),
        String(body.targetIdeaId || ""),
        String(body.reason || ""),
      ),
      {},
      correlation,
    );
  } catch (error) {
    return apiError(error, correlation);
  }
}
