import { checkedMutation } from "@/lib/server/versions";
import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeIdempotent } from "@/lib/server/idempotency";
import { publishRelease } from "@/lib/server/operations-repository";
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
      `release.publish:${id}`,
      200,
      async () => ({
        item: await checkedMutation(
          identity,
          "Releases",
          id,
          request.headers.get("if-match"),
          () => publishRelease(identity, id),
        ),
      }),
    );
    return json(result.body, { status: result.status }, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
