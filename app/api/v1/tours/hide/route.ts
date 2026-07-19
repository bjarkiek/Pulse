import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { hideToursForever } from "@/lib/server/tour-repository";

// The per-user "hide tours forever" opt-out. There is deliberately no
// user-facing undo — the help menu disappears with the tours. A System admin
// can restore the user from the onboarding settings grid.
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    return json(
      { item: await hideToursForever(await getIdentity(request)) },
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}
