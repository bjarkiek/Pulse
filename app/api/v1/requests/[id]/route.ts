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
    const body = await request.json();
    const identity = await getIdentity(request);
    const item = body.status
      ? await updateRequestStatus(identity, id, body.status, {
          explanation: body.explanation,
          supportReference: body.supportReference,
        })
      : await editRequest(identity, id, {
          title: body.title,
          problem: body.problem,
        });
    return json({ item }, {}, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
