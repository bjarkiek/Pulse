import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { getTourState } from "@/lib/server/tour-repository";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json({ item: await getTourState(await getIdentity(request)) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
