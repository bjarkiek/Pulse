import { z } from "zod";
import { readInput } from "@/lib/server/validation";
import { getIdentity } from "@/lib/server/auth";
import { editComment, removeComment } from "@/lib/server/comment-repository";
import { apiError, correlationId, json } from "@/lib/server/http";

type Context = { params: Promise<{ id: string; commentId: string }> };

export async function PATCH(request: Request, context: Context) {
  const correlation = correlationId(request);
  try {
    const { id, commentId } = await context.params;
    const body = await readInput(
      request,
      z.object({ body: z.string().trim().min(1).max(5000) }),
    );
    return json(
      {
        item: await editComment(
          await getIdentity(request),
          id,
          commentId,
          body.body,
        ),
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
    const body = request.body
      ? await readInput(
          request,
          z.object({ reason: z.string().max(5000).optional() }),
        )
      : { reason: undefined };
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
