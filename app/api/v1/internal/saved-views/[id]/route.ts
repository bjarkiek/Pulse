import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { deleteSavedView } from "@/lib/server/saved-view-repository";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    await deleteSavedView(getIdentity(request), id);
    return json({ ok: true }, {}, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
