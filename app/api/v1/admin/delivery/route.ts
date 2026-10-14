import { z } from "zod";
import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { readInput } from "@/lib/server/validation";
import { deliveryStatus, retryDeliveries } from "@/lib/server/delivery-status";
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json(
      { items: await deliveryStatus(await getIdentity(request)) },
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
    const body = await readInput(
      request,
      z.object({ channel: z.enum(["Email", "Webhook", "Communications"]) }).strict(),
    );
    return json(await retryDeliveries(identity, body.channel, id), {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
