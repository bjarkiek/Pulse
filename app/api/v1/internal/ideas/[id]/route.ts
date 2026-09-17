import { readInput } from "@/lib/server/validation";
import { ideaInputSchema } from "@/lib/contracts";
import { checkedMutation } from "@/lib/server/versions";
import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { updateIdea } from "@/lib/server/product-repository";
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    return json(
      {
        item: await checkedMutation(
          await getIdentity(request),
          "Ideas",
          id,
          request.headers.get("if-match"),
          async () =>
            updateIdea(
              await getIdentity(request),
              id,
              await readInput(request, ideaInputSchema),
            ),
        ),
      },
      {},
      correlation,
    );
  } catch (error) {
    return apiError(error, correlation);
  }
}
