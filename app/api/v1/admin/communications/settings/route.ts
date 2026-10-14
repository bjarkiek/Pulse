import { getIdentity } from "@/lib/server/auth";
import {
  communicationProviderStatus,
  getCommunicationSettings,
  saveCommunicationSettings,
  type CommunicationSettings,
} from "@/lib/server/communications/settings";
import { apiError, correlationId, json } from "@/lib/server/http";
import { readJson } from "@/lib/server/validation";

/** The settings and, beside them, what the environment says: whether the keys are set (never the keys), the webhook URL, the effective sending state. */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const item = await getCommunicationSettings(await getIdentity(request));
    return json({ item, status: communicationProviderStatus(item) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}

/**
 * Replaces the settings with the whole object in the body. System admin only (the repository decides), and audited. The repository authorises
 * first and then validates the body against `communicationSettingsInputSchema`, so a caller who may not save is told 404 whatever the body is.
 */
export async function PATCH(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await getIdentity(request);
    const item = await saveCommunicationSettings(
      identity,
      (await readJson(request)) as CommunicationSettings,
    );
    return json({ item, status: communicationProviderStatus(item) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
