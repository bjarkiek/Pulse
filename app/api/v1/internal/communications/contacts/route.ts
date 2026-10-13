import { communicationContactImportSchema, communicationContactInputSchema } from "@/lib/contracts";
import { getIdentity } from "@/lib/server/auth";
import { importContacts, listContacts, saveContact } from "@/lib/server/communications/contact-repository";
import { apiError, correlationId, json } from "@/lib/server/http";
import { readJson, parseInput } from "@/lib/server/validation";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const organizationId = new URL(request.url).searchParams.get("organizationId") || undefined;
    return json({ items: await listContacts(await getIdentity(request), organizationId) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
/** Body is either a single contact (communicationContactInputSchema) or an import ({ organizationId, lines, topics }). */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await getIdentity(request);
    const body = await readJson(request);
    if (typeof body.lines === "string") {
      const input = parseInput(communicationContactImportSchema, body);
      if (!input.organizationId) throw new Error("INVALID_INPUT");
      return json(await importContacts(identity, input.organizationId, input.lines, input.topics), { status: 201 }, id);
    }
    return json({ item: await saveContact(identity, parseInput(communicationContactInputSchema, body)) }, { status: 201 }, id);
  } catch (error) {
    return apiError(error, id);
  }
}
