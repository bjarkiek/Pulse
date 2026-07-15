import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { recordSuggestionDismissal } from "@/lib/server/search-repository";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    return json(
      await recordSuggestionDismissal(await getIdentity(request), await request.json()),
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}
