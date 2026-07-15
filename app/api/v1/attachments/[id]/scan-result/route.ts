import { apiError, correlationId, json } from "@/lib/server/http";
import { setAttachmentState } from "@/lib/server/request-repository";
import { timingSafeEqual } from "node:crypto";

function validSecret(value: string | null) {
  const expected = process.env.ATTACHMENT_SCAN_WEBHOOK_SECRET;
  if (!expected || !value) return false;
  const actualBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const correlation = correlationId(request);
  try {
    if (!validSecret(request.headers.get("x-pulse-scan-secret")))
      throw new Error("UNAUTHORIZED");
    const { id } = await context.params;
    const body = await request.json();
    const state =
      body.clean === true
        ? "Clean"
        : body.clean === false
          ? "Infected"
          : "Failed";
    await setAttachmentState(id, state);
    return json({ ok: true }, {}, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
