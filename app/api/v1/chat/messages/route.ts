import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { clearChatHistory, getChatHistory } from "@/lib/server/chat/chat-repository";
import { isAssistantConfigured, sendChat } from "@/lib/server/chat/assistant-service";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await getIdentity(request);
    return json(
      {
        configured: isAssistantConfigured(),
        messages: await getChatHistory(identity, 50),
      },
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await getIdentity(request);
    const body = await request.json();
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim() || text.length > 4000) throw new Error("INVALID_CHAT_TEXT");
    const result = await sendChat(identity, text);
    const response = json(
      { reply: result.reply, dataChanged: result.dataChanged },
      {},
      id,
    );
    if (result.switchedOrganizationId) {
      const prod = process.env.NODE_ENV === "production";
      response.cookies.set("pulse-organization", result.switchedOrganizationId, {
        httpOnly: true,
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
        // Lax cookies are withheld inside a cross-site DataCentral iframe in
        // production, so switch to the CHIPS-partitioned None/Secure form there.
        ...(prod
          ? { sameSite: "none" as const, secure: true, partitioned: true }
          : { sameSite: "lax" as const, secure: false }),
      });
    }
    return response;
  } catch (error) {
    return apiError(error, id);
  }
}

export async function DELETE(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await getIdentity(request);
    await clearChatHistory(identity);
    return json({ cleared: true }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
