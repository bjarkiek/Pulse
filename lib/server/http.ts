import { NextResponse } from "next/server";

export function correlationId(request: Request) {
  return request.headers.get("x-correlation-id") || crypto.randomUUID();
}

export function json<T>(body: T, init: ResponseInit = {}, id?: string) {
  const headers = new Headers(init.headers);
  headers.set("x-correlation-id", id || crypto.randomUUID());
  headers.set("cache-control", "no-store");
  return NextResponse.json(body, { ...init, headers });
}

export function apiError(error: unknown, id: string) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  const status =
    message === "UNAUTHORIZED"
      ? 401
      : message === "FORBIDDEN" || message === "NOT_FOUND"
        ? 404
        : message === "IDEMPOTENCY_IN_PROGRESS"
          ? 409
          : message.startsWith("INVALID_")
            ? 400
            : 500;
  const code = status === 500 ? "INTERNAL_ERROR" : message;
  if (status === 500)
    console.error(
      JSON.stringify({ level: "error", correlationId: id, message }),
    );
  return json(
    {
      error: {
        code,
        message:
          status === 500
            ? "The operation could not be completed."
            : message.replaceAll("_", " ").toLowerCase(),
        correlationId: id,
      },
    },
    { status },
    id,
  );
}
