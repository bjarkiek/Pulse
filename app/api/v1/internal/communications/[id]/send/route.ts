import { communicationSendInputSchema } from "@/lib/contracts";
import { getIdentity } from "@/lib/server/auth";
import { sendCommunication } from "@/lib/server/communications/campaign-repository";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeIdempotent } from "@/lib/server/idempotency";
import { readJson, parseInput, requestHasBody } from "@/lib/server/validation";
import { checkedMutation } from "@/lib/server/versions";

/** Sends the campaign now, or at `scheduledAt` when the body has one; no body is now. Under the version the caller read (If-Match), once per Idempotency-Key. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const identity = await getIdentity(request);
    const input = parseInput(communicationSendInputSchema, (await requestHasBody(request)) ? await readJson(request.clone()) : {});
    const result = await executeIdempotent(request, identity, `communication.send:${id}`, 200, async () => ({
      item: await checkedMutation(identity, "Communications", id, request.headers.get("if-match"), () => sendCommunication(identity, id, input)),
    }));
    return json(result.body, { status: result.status }, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
