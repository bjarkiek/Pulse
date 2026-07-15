import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { markNotificationRead } from "@/lib/server/operations-repository";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    return json(
      await markNotificationRead(getIdentity(request), id),
      {},
      correlation,
    );
  } catch (error) {
    return apiError(error, correlation);
  }
}
