import { getIdentity } from "@/lib/server/auth";
import { sendConfigurationTest } from "@/lib/server/communications/sendgrid";
import { apiError, correlationId, json } from "@/lib/server/http";

/** Sends one test mail to the signed-in System admin with the saved settings. There is no body: it mails the caller and nobody else. */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    return json(
      await sendConfigurationTest(await getIdentity(request)),
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}
