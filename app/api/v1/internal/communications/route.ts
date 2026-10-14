import { getIdentity } from "@/lib/server/auth";
import { createCommunication, listCommunications } from "@/lib/server/communications/campaign-repository";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeIdempotent } from "@/lib/server/idempotency";
import { readJson } from "@/lib/server/validation";

type CreateInput = Parameters<typeof createCommunication>[1];

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json({ items: await listCommunications(await getIdentity(request)) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
/** The body is a whole campaign or just `{ fromReleaseId }` (a product update drafted from that release); the repository validates either. */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await getIdentity(request);
    const result = await executeIdempotent(request, identity, "communication.create", 201, async () => ({
      item: await createCommunication(identity, (await readJson(request)) as CreateInput),
    }));
    return json(result.body, { status: result.status }, id);
  } catch (error) {
    return apiError(error, id);
  }
}
