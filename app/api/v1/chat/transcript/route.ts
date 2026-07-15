import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { cleanTranscript } from "@/lib/server/chat/assistant-service";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    await getIdentity(request); // auth required; cleanup itself never fails
    const body = await request.json();
    const transcript = typeof body.transcript === "string" ? body.transcript : "";
    return json({ text: await cleanTranscript(transcript) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
