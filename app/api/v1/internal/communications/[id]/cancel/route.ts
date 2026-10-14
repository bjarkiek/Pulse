import { communicationCancelInputSchema } from "@/lib/contracts";
import { getIdentity } from "@/lib/server/auth";
import { cancelCommunication } from "@/lib/server/communications/campaign-repository";
import { apiError, correlationId, json } from "@/lib/server/http";
import { parseInput, readJson, requestHasBody } from "@/lib/server/validation";
import { checkedMutation } from "@/lib/server/versions";

/** Stops a Scheduled or Sending campaign, or with `{ mode: "unschedule" }` turns a Scheduled one back into a Draft. Versioned, but not idempotent: a second cancel carries a stale version, or finds the campaign already stopped. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const identity = await getIdentity(request);
    const { mode } = parseInput(communicationCancelInputSchema, (await requestHasBody(request)) ? await readJson(request) : {});
    const item = await checkedMutation(identity, "Communications", id, request.headers.get("if-match"), () => cancelCommunication(identity, id, mode));
    return json({ item }, {}, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
