import { checkedMutation } from "@/lib/server/versions";
import { roadmapInputSchema } from "@/lib/contracts";
import { readInput } from "@/lib/server/validation";
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
    const identity = await getIdentity(request);
    const body = await readInput(request, roadmapInputSchema);
    return json(
      {
        item: await checkedMutation(
          identity,
          "Ideas",
          id,
          request.headers.get("if-match"),
          () => placeRoadmap(identity, id, body),
        ),
      },
      {},
      correlation,
    );
  } catch (error) {
    return apiError(error, correlation);
  }
}
