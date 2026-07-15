import { NextRequest, NextResponse } from "next/server";

type RateEntry = { count: number; resetAt: number };

declare global {
  var pulseRateLimits: Map<string, RateEntry> | undefined;
}

function limitFor(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path.includes("/attachments/")) return 30;
  if (path.includes("/comments")) return 30;
  if (request.method !== "GET" && request.method !== "HEAD") return 60;
  return 180;
}

export function proxy(request: NextRequest) {
  const correlationId =
    request.headers.get("x-correlation-id") || crypto.randomUUID();
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    mutation &&
    ((origin && new URL(origin).host !== request.nextUrl.host) ||
      fetchSite === "cross-site")
  )
    return NextResponse.json(
      {
        error: {
          code: "CSRF_REJECTED",
          message: "Cross-site mutation rejected.",
          correlationId,
        },
      },
      { status: 403, headers: { "x-correlation-id": correlationId } },
    );

  globalThis.pulseRateLimits ||= new Map();
  const now = Date.now();
  const principal =
    request.headers.get("x-ms-client-principal-id") ||
    request.headers.get("x-forwarded-for")?.split(",")[0] ||
    "anonymous";
  const bucket = `${principal}:${request.method}:${request.nextUrl.pathname}`;
  const limit = limitFor(request);
  const current = globalThis.pulseRateLimits.get(bucket);
  const entry =
    !current || current.resetAt <= now
      ? { count: 1, resetAt: now + 60_000 }
      : { ...current, count: current.count + 1 };
  globalThis.pulseRateLimits.set(bucket, entry);
  if (entry.count > limit)
    return NextResponse.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests. Please try again shortly.",
          correlationId,
        },
      },
      {
        status: 429,
        headers: {
          "retry-after": String(Math.ceil((entry.resetAt - now) / 1000)),
          "x-correlation-id": correlationId,
        },
      },
    );

  const headers = new Headers(request.headers);
  headers.set("x-correlation-id", correlationId);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("x-correlation-id", correlationId);
  response.headers.set("x-ratelimit-limit", String(limit));
  response.headers.set(
    "x-ratelimit-remaining",
    String(Math.max(0, limit - entry.count)),
  );
  return response;
}

export const config = { matcher: ["/api/:path*"] };
