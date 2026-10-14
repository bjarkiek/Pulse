import { z } from "zod";
import { readInput, requestHasBody } from "@/lib/server/validation";
import { timingSafeEqual } from "node:crypto";
import { apiError, correlationId, json } from "@/lib/server/http";
import { processCommunicationBatch } from "@/lib/server/communications/delivery-worker";

function authorized(request: Request) {
  const actual = request.headers.get("x-pulse-job-secret");
  const expected = process.env.NOTIFICATION_JOB_SECRET;
  if (!actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    if (!authorized(request)) throw new Error("UNAUTHORIZED");
    const body = (await requestHasBody(request))
      ? await readInput(
          request,
          z.object({ limit: z.number().int().min(1).max(5000).optional() }),
        )
      : { limit: undefined };
    return json(
      await processCommunicationBatch(Number(body.limit || 500)),
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}
