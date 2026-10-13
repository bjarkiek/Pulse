import { z } from "zod";
import { communicationContactCreateSchema, communicationContactImportSchema } from "@/lib/contracts";
import { getIdentity } from "@/lib/server/auth";
import { importContacts, listContacts, saveContact } from "@/lib/server/communications/contact-repository";
import { apiError, correlationId, json } from "@/lib/server/http";
import { readJson, parseInput } from "@/lib/server/validation";

/** The optional ?organizationId= filter is an organisation id as a contact names it; a filter that is present but empty or too long is bad input. */
const organizationFilterSchema = z.string().min(1).max(32);

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await getIdentity(request);
    const filter = new URL(request.url).searchParams.get("organizationId");
    const organizationId = filter === null ? undefined : parseInput(organizationFilterSchema, filter);
    return json({ items: await listContacts(identity, organizationId) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
/** Body is either a new contact (communicationContactCreateSchema) or an import ({ organizationId, lines, topics }). A POST always creates: an id in the body is ignored. */
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
    return json({ item: await saveContact(identity, parseInput(communicationContactCreateSchema, body)) }, { status: 201 }, id);
  } catch (error) {
    return apiError(error, id);
  }
}
