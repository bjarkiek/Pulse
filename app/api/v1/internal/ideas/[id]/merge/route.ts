import { z } from "zod";
import { readInput } from "@/lib/server/validation";
import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeIdempotent } from "@/lib/server/idempotency";
import { mergeIdeas } from "@/lib/server/product-repository";
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
      `idea.merge:${id}`,
      200,
      async () => {
        const body = await readInput(
          request,
          z.object({
            sourceIdeaId: z.string().regex(/^IDEA-\d+$/),
            reason: z.string().trim().min(1).max(5000),
          }),
        );
        return mergeIdeas(identity, id, body.sourceIdeaId, body.reason);
      },
    );
    return json(result.body, { status: result.status }, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
