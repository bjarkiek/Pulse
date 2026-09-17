import { readJson, parseInput } from "@/lib/server/validation";
import { draftInputSchema } from "@/lib/contracts";
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
    return json(
      { item: await getRequestDraft(await draftIdentity(request)) },
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}

export async function PUT(request: Request) {
  const id = correlationId(request);
  try {
    const body = parseInput(draftInputSchema, await readJson(request));
    return json(
      { item: await saveRequestDraft(await draftIdentity(request), body) },
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
    await deleteRequestDraft(await draftIdentity(request));
    return json({ ok: true }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}

async function draftIdentity(request: Request) {
  const identity = await getIdentity(request);
  const owner = request.headers.get("x-pulse-draft-owner");
  if (owner && owner !== identity.id) throw new Error("UNAUTHORIZED");
  return identity;
}
