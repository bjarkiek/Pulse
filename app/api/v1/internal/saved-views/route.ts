import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeIdempotent } from "@/lib/server/idempotency";
import {
  createSavedView,
  listSavedViews,
} from "@/lib/server/saved-view-repository";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json({ items: await listSavedViews(await getIdentity(request)) }, {}, id);
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
      "saved-view.create",
      201,
      async () => ({
        item: await createSavedView(identity, await request.json()),
      }),
    );
    return json(result.body, { status: result.status }, id);
  } catch (error) {
    return apiError(error, id);
  }
}
