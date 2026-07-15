import { getIdentity } from "@/lib/server/auth";
import { exportAuthorizedRequests } from "@/lib/server/analytics-repository";
import { apiError, correlationId } from "@/lib/server/http";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const csv = await exportAuthorizedRequests(await getIdentity(request));
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition":
          'attachment; filename="pulse-authorized-requests.csv"',
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "x-correlation-id": id,
      },
    });
  } catch (error) {
    return apiError(error, id);
  }
}
