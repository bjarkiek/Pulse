import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { setWebhookSubscriptionState } from "@/lib/server/webhook-repository";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const body = await request.json();
    return json(
      await setWebhookSubscriptionState(
        await getIdentity(request),
        id,
        body.active === true,
      ),
      {},
      correlation,
    );
  } catch (error) {
    return apiError(error, correlation);
  }
}
