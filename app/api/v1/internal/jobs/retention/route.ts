import { timingSafeEqual } from "node:crypto";
import { apiError, correlationId, json } from "@/lib/server/http";
import { processRetentionBatch } from "@/lib/server/retention-worker";

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
    const body = await request.json().catch(() => ({}));
    return json(
      await processRetentionBatch(Number(body.limit || 50)),
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}
