import { getIdentity } from "@/lib/server/auth";
import { addComment, listComments } from "@/lib/server/comment-repository";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeIdempotent } from "@/lib/server/idempotency";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const includeInternal =
      new URL(request.url).searchParams.get("includeInternal") === "true";
    return json(
      { items: await listComments(getIdentity(request), id, includeInternal) },
      {},
      correlation,
    );
  } catch (error) {
    return apiError(error, correlation);
  }
}

export async function POST(request: Request, context: Context) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const identity = getIdentity(request);
    const result = await executeIdempotent(
      request,
      identity,
      `comment.create:${id}`,
      201,
      async () => {
        const body = await request.json();
        return {
          item: await addComment(
            identity,
            id,
            body.body,
            body.visibility === "Internal" ? "Internal" : "Customer",
            Array.isArray(body.attachmentIds) ? body.attachmentIds : [],
          ),
        };
      },
    );
    return json(result.body, { status: result.status }, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
