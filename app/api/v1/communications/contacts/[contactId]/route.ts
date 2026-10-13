import { companyContactCreateSchema } from "@/lib/contracts";
import { getIdentity } from "@/lib/server/auth";
import { removeCompanyContact, saveCompanyContact } from "@/lib/server/communications/contact-repository";
import { apiError, correlationId, json } from "@/lib/server/http";
import { parseInput, readJson } from "@/lib/server/validation";

type Context = { params: Promise<{ contactId: string }> };

/**
 * An edit takes the fields of a create (companyContactCreateSchema, which has no id); the contact it changes is the one in the URL.
 * A malformed or unknown contact id is answered by the repository (NOT_FOUND → 404), not rejected here as bad input.
 */
export async function PATCH(request: Request, context: Context) {
  const id = correlationId(request);
  try {
    const { contactId } = await context.params;
    const identity = await getIdentity(request);
    const input = parseInput(companyContactCreateSchema, await readJson(request));
    return json({ item: await saveCompanyContact(identity, { ...input, id: contactId }) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
export async function DELETE(request: Request, context: Context) {
  const id = correlationId(request);
  try {
    const { contactId } = await context.params;
    await removeCompanyContact(await getIdentity(request), contactId);
    return json({ ok: true }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
