import { getIdentity } from "@/lib/server/auth";
import {
  deleteRequestDraft,
  getRequestDraft,
  saveRequestDraft,
} from "@/lib/server/draft-repository";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json({ item: await getRequestDraft(await getIdentity(request)) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}

export async function PUT(request: Request) {
  const id = correlationId(request);
  try {
    const body = await request.json();
    return json(
      { item: await saveRequestDraft(await getIdentity(request), body) },
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}

export async function DELETE(request: Request) {
  const id = correlationId(request);
  try {
    await deleteRequestDraft(await getIdentity(request));
    return json({ ok: true }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
