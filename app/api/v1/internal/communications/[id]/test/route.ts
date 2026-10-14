import { communicationTestSendSchema } from "@/lib/contracts";
import { getIdentity } from "@/lib/server/auth";
import { testSendCommunication } from "@/lib/server/communications/campaign-repository";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeIdempotent } from "@/lib/server/idempotency";
import { parseInput, readJson } from "@/lib/server/validation";

/** A test mail to the caller and to any staff addresses in `extraRecipients`; no body is no extras. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const identity = await getIdentity(request);
    const { extraRecipients } = parseInput(communicationTestSendSchema, request.body ? await readJson(request.clone()) : {});
    const result = await executeIdempotent(request, identity, `communication.test:${id}`, 200, () => testSendCommunication(identity, id, extraRecipients));
    return json(result.body, { status: result.status }, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
