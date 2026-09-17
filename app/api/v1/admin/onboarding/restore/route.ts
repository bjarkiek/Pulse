import { z } from "zod";
import { readInput } from "@/lib/server/validation";
import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { restoreUserTours } from "@/lib/server/tour-repository";

// Clears a user's "hide tours forever" opt-out (System admin only).
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await getIdentity(request);
    const body = await readInput(
      request,
      z.object({ userId: z.uuid().optional() }),
    );
    return json(
      { item: await restoreUserTours(identity, body.userId) },
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}
