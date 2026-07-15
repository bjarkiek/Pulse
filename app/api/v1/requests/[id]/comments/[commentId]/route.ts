import { getIdentity } from "@/lib/server/auth";
import { editComment, removeComment } from "@/lib/server/comment-repository";
import { apiError, correlationId, json } from "@/lib/server/http";

type Context = { params: Promise<{ id: string; commentId: string }> };

export async function PATCH(request: Request, context: Context) {
  const correlation = correlationId(request);
  try {
    const { id, commentId } = await context.params;
    const body = await request.json();
    return json(
      {
        item: await editComment(await getIdentity(request), id, commentId, body.body),
      },
      {},
      correlation,
    );
  } catch (error) {
    return apiError(error, correlation);
  }
}

export async function DELETE(request: Request, context: Context) {
  const correlation = correlationId(request);
  try {
    const { id, commentId } = await context.params;
    const body = await request.json().catch(() => ({}));
    return json(
      {
        item: await removeComment(
          await getIdentity(request),
          id,
          commentId,
          body.reason || "",
        ),
      },
      {},
      correlation,
    );
  } catch (error) {
    return apiError(error, correlation);
  }
}
