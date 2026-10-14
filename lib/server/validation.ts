import { z } from "zod";

export async function readJsonValue(
  request: Request,
  maxBytes = 64 * 1024,
): Promise<unknown> {
  if (Number(request.headers.get("content-length") || 0) > maxBytes)
    throw new Error("PAYLOAD_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("INVALID_JSON");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error("PAYLOAD_TOO_LARGE");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new Error("INVALID_JSON");
  }
  validateStructure(value);
  return value;
}
/**
 * Whether a request has a body to read. The server gives a handler a body stream for every method but GET and HEAD, an empty one when the client
 * sent none, so `request.body` alone cannot tell a POST with nothing to say from a POST with a body. A declared length decides when there is one
 * (0 is no body); without one the first chunk of a copy does, and only that chunk is read, so asking never buffers a large body or waits for the
 * end of a slow one. The request itself is left unread.
 */
export async function requestHasBody(request: Request): Promise<boolean> {
  if (!request.body) return false;
  const declared = request.headers.get("content-length");
  if (declared !== null) return Number(declared) !== 0;
  const reader = request.clone().body!.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return false;
      if (value.byteLength > 0) return true;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
function validateStructure(value: unknown, depth = 0) {
  if (depth > 12) throw new Error("INVALID_JSON_DEPTH");
  if (typeof value === "string" && value.length > 16000)
    throw new Error("INVALID_STRING_LENGTH");
  if (Array.isArray(value) && value.length > 250)
    throw new Error("INVALID_ARRAY_LENGTH");
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 250) throw new Error("INVALID_OBJECT_SIZE");
    for (const [key, child] of entries) {
      if (["__proto__", "constructor", "prototype"].includes(key))
        throw new Error("INVALID_PROPERTY");
      validateStructure(child, depth + 1);
    }
  }
}
export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("INVALID_INPUT");
  return result.data;
}
export const emailSchema = z.string().trim().toLowerCase().max(320).email();
export const otpStartSchema = z.object({ email: emailSchema }).strict();
export const otpVerifySchema = otpStartSchema.extend({
  code: z.string().regex(/^\d{6}$/),
});

export async function readJson(
  request: Request,
  maxBytes = 64 * 1024,
): Promise<Record<string, unknown>> {
  const value = await readJsonValue(request, maxBytes);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_JSON_OBJECT");
  return value as Record<string, unknown>;
}

export async function readInput<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  return parseInput(schema, await readJson(request));
}
