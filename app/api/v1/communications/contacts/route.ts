import { communicationContactImportSchema, companyContactInputSchema } from "@/lib/contracts";
import { getIdentity } from "@/lib/server/auth";
import { importCompanyContacts, listCompanyContacts, saveCompanyContact } from "@/lib/server/communications/contact-repository";
import { apiError, correlationId, json } from "@/lib/server/http";
import { parseInput, readJson } from "@/lib/server/validation";

/** A Company admin never names the organisation: it is always the active membership, so an import body is just { lines, topics }. */
const importBodySchema = communicationContactImportSchema.omit({ organizationId: true });

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json({ items: await listCompanyContacts(await getIdentity(request)) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
/** Body is either a single contact (companyContactInputSchema) or an import ({ lines, topics }). */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await getIdentity(request);
    const body = await readJson(request);
    if (typeof body.lines === "string") {
      const input = parseInput(importBodySchema, body);
      return json(await importCompanyContacts(identity, input.lines, input.topics), { status: 201 }, id);
    }
    return json({ item: await saveCompanyContact(identity, parseInput(companyContactInputSchema, body)) }, { status: 201 }, id);
  } catch (error) {
    return apiError(error, id);
  }
}
