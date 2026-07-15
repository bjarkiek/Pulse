import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { searchSuggestions } from "@/lib/server/search-repository";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const url = new URL(request.url);
    return json(
      {
        items: await searchSuggestions(
          await getIdentity(request),
          url.searchParams.get("q") || "",
          url.searchParams.get("area") || undefined,
        ),
      },
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}
