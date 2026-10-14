import { getIdentity } from "@/lib/server/auth";
import { listDeliveries } from "@/lib/server/communications/campaign-repository";
import { apiError, correlationId, json } from "@/lib/server/http";

/** A value that is missing or empty is absent; one that is not a number reaches the repository as NaN, which falls back to its default. */
const numberOf = (value: string | null) => (value ? Number(value) : undefined);

/** One page of recipient rows, optionally narrowed by ?state= and ?organizationId=, with the total of the filter. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const query = new URL(request.url).searchParams;
    const page = await listDeliveries(await getIdentity(request), id, {
      state: query.get("state") || undefined,
      organizationId: query.get("organizationId") || undefined,
      page: numberOf(query.get("page")),
      pageSize: numberOf(query.get("pageSize")),
    });
    return json(page, {}, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
