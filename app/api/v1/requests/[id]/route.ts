import { readInput } from "@/lib/server/validation";
import { requestMutationSchema } from "@/lib/contracts";
import { checkedMutation } from "@/lib/server/versions";
import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import {
  editRequest,
  getRequest,
  getRequestHistory,
  updateRequestStatus,
} from "@/lib/server/request-repository";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const identity = await getIdentity(request);
    return json(
      {
        item: await getRequest(identity, id),
        history: await getRequestHistory(identity, id),
      },
      {},
      correlation,
    );
  } catch (error) {
    return apiError(error, correlation);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const body = await readInput(request, requestMutationSchema);
    const identity = await getIdentity(request);
    const item = await checkedMutation(
      identity,
      "Requests",
      id,
      request.headers.get("if-match"),
      async () =>
        body.status
          ? await updateRequestStatus(identity, id, body.status, {
              explanation: body.explanation,
              supportReference: body.supportReference,
            })
          : await editRequest(identity, id, {
              title: body.title,
              problem: body.problem,
            }),
    );
    return json({ item }, {}, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
