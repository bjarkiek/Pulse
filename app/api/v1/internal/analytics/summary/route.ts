import { getIdentity } from "@/lib/server/auth";
import { getAnalyticsSummary } from "@/lib/server/analytics-repository";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json(await getAnalyticsSummary(getIdentity(request)), {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
