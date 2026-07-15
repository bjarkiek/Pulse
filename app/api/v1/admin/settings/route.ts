import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { getSettings, saveSettings } from "@/lib/server/settings-repository";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json({ item: await getSettings(await getIdentity(request)) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}

export async function PATCH(request: Request) {
  const id = correlationId(request);
  try {
    return json(
      {
        item: await saveSettings(await getIdentity(request), await request.json()),
      },
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}
