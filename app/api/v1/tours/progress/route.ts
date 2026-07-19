import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { reportTourProgress } from "@/lib/server/tour-repository";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await getIdentity(request);
    await reportTourProgress(identity, await request.json());
    return json({ ok: true }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
