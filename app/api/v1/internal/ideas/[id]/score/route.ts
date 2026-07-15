import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { scoreIdea } from "@/lib/server/product-repository";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    return json(
      await scoreIdea(await getIdentity(request), id, await request.json()),
      {},
      correlation,
    );
  } catch (error) {
    return apiError(error, correlation);
  }
}
