import { communicationSuppressionInputSchema, communicationSuppressionRemoveSchema } from "@/lib/contracts";
import { getIdentity } from "@/lib/server/auth";
import { addSuppression, listSuppressions, removeSuppression } from "@/lib/server/communications/suppression-repository";
import { apiError, correlationId, json } from "@/lib/server/http";
import { readInput } from "@/lib/server/validation";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json({ items: await listSuppressions(await getIdentity(request)) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await getIdentity(request);
    return json({ item: await addSuppression(identity, await readInput(request, communicationSuppressionInputSchema)) }, { status: 201 }, id);
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
