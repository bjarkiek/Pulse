import { communicationInputSchema } from "@/lib/contracts";
import { getIdentity } from "@/lib/server/auth";
import { deleteCommunication, getCommunication, updateCommunication } from "@/lib/server/communications/campaign-repository";
import { apiError, correlationId, json } from "@/lib/server/http";
import { readInput } from "@/lib/server/validation";
import { checkedMutation } from "@/lib/server/versions";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    return json({ item: await getCommunication(await getIdentity(request), id) }, {}, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
/** An edit replaces a draft's content and audience under the version the caller read (If-Match). The body is read first, so a malformed one is 400 whatever the version. */
export async function PATCH(request: Request, context: Context) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const identity = await getIdentity(request);
    const input = await readInput(request, communicationInputSchema);
    const item = await checkedMutation(identity, "Communications", id, request.headers.get("if-match"), () => updateCommunication(identity, id, input));
    return json({ item }, {}, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
export async function DELETE(request: Request, context: Context) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    await deleteCommunication(await getIdentity(request), id);
    return json({ ok: true }, {}, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
