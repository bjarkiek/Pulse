import { communicationContactInputSchema } from "@/lib/contracts";
import { getIdentity } from "@/lib/server/auth";
import { removeContact, saveContact } from "@/lib/server/communications/contact-repository";
import { apiError, correlationId, json } from "@/lib/server/http";
import { parseInput, readJson } from "@/lib/server/validation";

type Context = { params: Promise<{ contactId: string }> };

/** The contact being edited is named by the URL, never by the body. */
const contactBodySchema = communicationContactInputSchema.omit({ id: true });

/** A malformed or unknown contact id is answered by the repository (NOT_FOUND → 404), not rejected here as bad input. */
export async function PATCH(request: Request, context: Context) {
  const id = correlationId(request);
  try {
    const { contactId } = await context.params;
    const identity = await getIdentity(request);
    const input = parseInput(contactBodySchema, await readJson(request));
    return json({ item: await saveContact(identity, { ...input, id: contactId }) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
export async function DELETE(request: Request, context: Context) {
  const id = correlationId(request);
  try {
    const { contactId } = await context.params;
    await removeContact(await getIdentity(request), contactId);
    return json({ ok: true }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
