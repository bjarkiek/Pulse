import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { listAudit } from "@/lib/server/operations-repository";
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const limit = Number(new URL(request.url).searchParams.get("limit") || 100);
    return json(
      { items: await listAudit(await getIdentity(request), limit) },
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}
