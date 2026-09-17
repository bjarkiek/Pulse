import { readInput } from "@/lib/server/validation";
import { userInputSchema } from "@/lib/contracts";
import { getIdentity } from "@/lib/server/auth";
import { listUsers, saveUser } from "@/lib/server/admin-repository";
import { apiError, correlationId, json } from "@/lib/server/http";
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json({ items: await listUsers(await getIdentity(request)) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    return json(
      {
        item: await saveUser(
          await getIdentity(request),
          await readInput(request, userInputSchema),
        ),
      },
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}
