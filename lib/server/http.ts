import { NextResponse } from "next/server";

export function correlationId(request: Request) {
  return request.headers.get("x-correlation-id") || crypto.randomUUID();
}

// The externally-visible origin for ABSOLUTE redirects. Behind App Service TLS
// termination request.url carries the container's internal bind authority
// (e.g. https://0.0.0.0:3000), which is unreachable from a browser — always
// prefer the operator-configured public URL.
export function publicOrigin(request: Request): string {
  const configured = process.env.PULSE_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin;
}

// The current request's URL rebuilt on the public origin, query preserved.
// Needed wherever the request URL is handed to a library that derives values
// from it — e.g. openid-client derives the token-exchange redirect_uri from
// the callback URL, and Entra rejects the exchange if it carries the
// container's internal authority instead of the registered public one.
export function publicCallbackUrl(request: Request): URL {
  const url = new URL(request.url);
  return new URL(url.pathname + url.search, publicOrigin(request));
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
