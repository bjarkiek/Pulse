import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import {
  getOnboardingAdmin,
  saveOnboardingSettings,
} from "@/lib/server/tour-repository";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json(
      { item: await getOnboardingAdmin(await getIdentity(request)) },
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
    return json(
      {
        item: await saveOnboardingSettings(
          await getIdentity(request),
          await request.json(),
        ),
      },
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}
