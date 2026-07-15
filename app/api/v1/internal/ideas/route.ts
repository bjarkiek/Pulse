import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeIdempotent } from "@/lib/server/idempotency";
import { createIdea, listInternalIdeas } from "@/lib/server/product-repository";
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json(
      { items: await listInternalIdeas(getIdentity(request)) },
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = getIdentity(request);
    const result = await executeIdempotent(
      request,
      identity,
      "idea.create",
      201,
      async () => ({ item: await createIdea(identity, await request.json()) }),
    );
    return json(result.body, { status: result.status }, id);
  } catch (error) {
    return apiError(error, id);
  }
}
