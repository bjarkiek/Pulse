import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { placeRoadmap } from "@/lib/server/operations-repository";
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    return json(
      {
        item: await placeRoadmap(
          await getIdentity(request),
          id,
          await request.json(),
        ),
      },
      {},
      correlation,
    );
  } catch (error) {
    return apiError(error, correlation);
  }
}
