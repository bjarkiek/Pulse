import { readInput } from "@/lib/server/validation";
import { settingsInputSchema } from "@/lib/contracts";
import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { getSettings, saveSettings } from "@/lib/server/settings-repository";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json(
      {
        item: await getSettings(await getIdentity(request)),
        // Production never shows demo data (saveSettings refuses it), so the
        // Settings card can disable the switch instead of letting a save fail.
        demoDataAvailable: process.env.NODE_ENV !== "production",
      },
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
        item: await saveSettings(
          await getIdentity(request),
          await readInput(request, settingsInputSchema),
        ),
      },
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}
