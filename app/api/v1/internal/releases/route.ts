import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeIdempotent } from "@/lib/server/idempotency";
import {
  createRelease,
  listReleases,
} from "@/lib/server/operations-repository";
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json(
      { items: await listReleases(await getIdentity(request), true) },
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
    const identity = await getIdentity(request);
    const result = await executeIdempotent(
      request,
      identity,
      "release.create",
      201,
      async () => ({
        item: await createRelease(identity, await request.json()),
      }),
    );
    return json(result.body, { status: result.status }, id);
  } catch (error) {
    return apiError(error, id);
  }
}
