import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeIdempotent } from "@/lib/server/idempotency";
import { createRequest, listRequests } from "@/lib/server/request-repository";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json({ items: await listRequests(getIdentity(request)) }, {}, id);
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
      "request.create",
      201,
      async () => ({
        item: await createRequest(identity, await request.json()),
      }),
    );
    return json(
      result.body,
      {
        status: result.status,
        headers: result.replayed ? { "idempotency-replayed": "true" } : {},
      },
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}
