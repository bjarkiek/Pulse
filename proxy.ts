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

// Keep in sync with the Content-Security-Policy value in next.config.ts (this replaces, not merges with, that header on proxy-matched paths).
const BASE_CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://*.blob.core.windows.net";

export function isEmbedRequest(request: NextRequest): boolean {
  return request.nextUrl.searchParams.has("dcdata") ||
    request.headers.get("sec-fetch-dest")?.toLowerCase() === "iframe";
}

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  if (!path.startsWith("/api")) {
    const withFraming = (r: NextResponse) => {
      r.headers.set("content-security-policy", `${BASE_CSP}; frame-ancestors ${FRAME_ANCESTORS}`);
      return r;
    };
    // frame-ancestors 'none' on OAuth pages — the /oauth/authorize consent button
    // grants a full-power MCP token, so it must NEVER be frameable (anti-clickjacking).
    const denyFraming = (r: NextResponse) => {
      r.headers.set("content-security-policy", `${BASE_CSP}; frame-ancestors 'none'`);
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
      // Embedded (iframe) requests split on whether this is a fresh launch:
      //  - dcdata on the URL → run the /dc-embed handshake (AppReady exchange,
      //    POST /dc-auth) to establish the session;
      //  - no dcdata (the post-auth reload, or a revisit) → let the shell render
      //    ANONYMOUSLY. Third-party-cookie blocking means the reload may carry no
      //    cookie, and document navigations cannot carry an Authorization header;
      //    the client attaches its sessionStorage bearer token to every API call,
      //    so all data access stays authenticated. Redirecting here instead is
      //    what caused the /dc-embed ↔ reload loop under cookie blocking.
      if (isEmbedRequest(request)) {
        if (request.nextUrl.searchParams.has("dcdata"))
          return NextResponse.redirect(new URL(
            `/dc-embed?returnUrl=${encodeURIComponent(returnUrl)}`,
            process.env.PULSE_PUBLIC_URL || request.url), 302);
        return withFraming(NextResponse.next());
      }
      // Resolve against PULSE_PUBLIC_URL when set so App Service TLS termination
      // doesn't yield an http:// Location the Secure session cookie won't accompany.
      const base = process.env.PULSE_PUBLIC_URL || request.url;
      return NextResponse.redirect(new URL(`/auth/login?returnUrl=${encodeURIComponent(returnUrl)}`, base), 302);
    }
    return withFraming(NextResponse.next());
  }

  const correlationId =
    request.headers.get("x-correlation-id") || crypto.randomUUID();
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  // Compare Origin to the HOST HEADER, not request.nextUrl: behind App Service
  // TLS termination nextUrl carries the container's internal http://localhost:3000
  // authority while the browser's Origin and the preserved Host header are both
  // the public host — comparing against nextUrl would 403 every legitimate API
  // mutation in production (same trap as /dc-auth's same-origin guard).
  // Opaque/malformed Origin values (e.g. the literal string "null") make
  // `new URL(origin)` throw. Fail closed — treat anything unparseable as a
  // cross-site mismatch (rejected below) rather than letting the exception
  // escape as an uncaught 500.
  let originMismatch = false;
  if (origin) {
    try {
      const host = request.headers.get("host") ?? request.nextUrl.host;
      originMismatch = new URL(origin).host !== host;
    } catch {
      originMismatch = true;
    }
  }
  if (mutation && (originMismatch || fetchSite === "cross-site"))
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
  matcher: ["/api/:path*", "/", "/help", "/dc-embed", "/dc-auth", "/auth/:path*", "/mcp", "/oauth/:path*"],
};
