import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import {
  listNotificationPreferences,
  saveNotificationPreference,
} from "@/lib/server/notification-preference-repository";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json(
      { items: await listNotificationPreferences(await getIdentity(request)) },
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}

export async function PATCH(request: Request) {
  const id = correlationId(request);
  try {
    const body = await request.json();
    return json(
      await saveNotificationPreference(
        await getIdentity(request),
        String(body.eventType || ""),
        String(body.cadence || ""),
      ),
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}
