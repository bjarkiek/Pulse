import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { listReleases } from "@/lib/server/operations-repository";
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json(
      { items: await listReleases(await getIdentity(request), false) },
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}
