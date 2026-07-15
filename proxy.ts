import { NextRequest, NextResponse } from "next/server";
import { readSession } from "@/lib/server/session";

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

const FRAME_ANCESTORS = process.env.DC_FRAME_ANCESTORS || "'self' https://*.datacentral.ai";

export function isEmbedRequest(request: NextRequest): boolean {
  return request.nextUrl.searchParams.has("dcdata") ||
    request.headers.get("sec-fetch-dest")?.toLowerCase() === "iframe";
}

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  if (!path.startsWith("/api")) {
    const withFraming = (r: NextResponse) => {
      r.headers.set("content-security-policy", `frame-ancestors ${FRAME_ANCESTORS}`);
      return r;
    };
    // frame-ancestors 'none' on OAuth pages — the /oauth/authorize consent button
    // grants a full-power MCP token, so it must NEVER be frameable (anti-clickjacking).
    const denyFraming = (r: NextResponse) => {
      r.headers.set("content-security-policy", "frame-ancestors 'none'");
      return r;
    };
    if (path === "/mcp" || path.startsWith("/oauth"))
      return denyFraming(NextResponse.next());                    // MCP/OAuth: never framed, and self-authenticating
    if (path === "/dc-embed" || path === "/dc-auth" || path.startsWith("/auth"))
      return withFraming(NextResponse.next());                     // anonymous endpoints (embed needs DataCentral framing)
    const localAllowed = process.env.NODE_ENV !== "production" ||
      process.env.PULSE_ALLOW_DEMO_IDENTITY === "true";
    const session = await readSession(request);
    if (!session && !localAllowed && process.env.PULSE_SESSION_SECRET) {
      const returnUrl = request.nextUrl.pathname + request.nextUrl.search;
      const target = isEmbedRequest(request)
        ? `/dc-embed?returnUrl=${encodeURIComponent(returnUrl)}`   // intercept the challenge — never redirect an iframe to Entra
        : `/auth/login?returnUrl=${encodeURIComponent(returnUrl)}`;
      // Resolve against PULSE_PUBLIC_URL when set so App Service TLS termination
      // doesn't yield an http:// Location the Secure session cookie won't accompany.
      const base = process.env.PULSE_PUBLIC_URL || request.url;
      return NextResponse.redirect(new URL(target, base));
    }
    return withFraming(NextResponse.next());
  }

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

export const config = {
  matcher: ["/api/:path*", "/", "/dc-embed", "/dc-auth", "/auth/:path*", "/mcp", "/oauth/:path*"],
};
