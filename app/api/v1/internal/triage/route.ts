import { getIdentity } from "@/lib/server/auth";
import { requireInternalRole } from "@/lib/server/authorization";
import { apiError, correlationId, json } from "@/lib/server/http";
import { listRequests } from "@/lib/server/request-repository";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await getIdentity(request);
    await requireInternalRole(identity);
    return json({ items: await listRequests(identity) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
