import { z } from "zod";
import { readInput } from "@/lib/server/validation";
import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { recordSuggestionDismissal } from "@/lib/server/search-repository";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    return json(
      await recordSuggestionDismissal(
        await getIdentity(request),
        await readInput(
          request,
          z.object({
            queryLength: z.number().int().min(0).max(500),
            suggestionIds: z.array(z.string().max(64)).max(100),
          }),
        ),
      ),
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}
