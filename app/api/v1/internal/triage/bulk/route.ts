import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeIdempotent } from "@/lib/server/idempotency";
import { bulkUpdateTriage } from "@/lib/server/triage-repository";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = getIdentity(request);
    const result = await executeIdempotent(
      request,
      identity,
      "triage.bulk-update",
      200,
      async () => bulkUpdateTriage(identity, await request.json()),
    );
    return json(result.body, { status: result.status }, id);
  } catch (error) {
    return apiError(error, id);
  }
}
