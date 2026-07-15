import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { getIdea } from "@/lib/server/idea-repository";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    return json(await getIdea(await getIdentity(request), id), {}, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
