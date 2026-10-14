import { communicationSuppressionRemoveSchema } from "@/lib/contracts";
import { getIdentity } from "@/lib/server/auth";
import { addSuppression, listSuppressions, removeSuppression } from "@/lib/server/communications/suppression-repository";
import { apiError, correlationId, json } from "@/lib/server/http";
import { readInput, readJson } from "@/lib/server/validation";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json({ items: await listSuppressions(await getIdentity(request)) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
/** The repository authorises (System admin) and then validates the body against `communicationSuppressionInputSchema`, so anyone else is told 404 whatever the body is. */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await getIdentity(request);
    return json({ item: await addSuppression(identity, (await readJson(request)) as Parameters<typeof addSuppression>[1]) }, { status: 201 }, id);
  } catch (error) {
    return apiError(error, id);
  }
}
/** The address to lift is named in the body ({ email }), not in the URL. */
export async function DELETE(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await getIdentity(request);
    const { email } = await readInput(request, communicationSuppressionRemoveSchema);
    await removeSuppression(identity, email);
    return json({ ok: true }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
