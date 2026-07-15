import { getIdentity } from "@/lib/server/auth";
import { removeExternalLink } from "@/lib/server/external-link-repository";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; linkId: string }> },
) {
  const correlation = correlationId(request);
  try {
    const { id, linkId } = await context.params;
    return json(
      await removeExternalLink(await getIdentity(request), id, linkId),
      {},
      correlation,
    );
  } catch (error) {
    return apiError(error, correlation);
  }
}
