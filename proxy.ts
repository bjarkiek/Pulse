import { readJsonValue } from "@/lib/server/validation";
import {
  apiError,
  correlationId as requestCorrelationId,
} from "@/lib/server/http";
import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { contentSecurityPolicy } from "@/lib/security-policy";
import { readSession } from "@/lib/server/session";

const FRAME_ANCESTORS =
  process.env.DC_FRAME_ANCESTORS || "'self' https://*.datacentral.ai";

export function isEmbedRequest(request: NextRequest): boolean {
  return (
    request.nextUrl.searchParams.has("dcdata") ||
    request.headers.get("sec-fetch-dest")?.toLowerCase() === "iframe"
  );
}

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(
    nonce,
    path.startsWith("/oauth") || path === "/mcp" ? "'none'" : FRAME_ANCESTORS,
  );
  const forwarded = new Headers(request.headers);
  forwarded.set("x-nonce", nonce);
  forwarded.set("content-security-policy", csp);
  const next = () => NextResponse.next({ request: { headers: forwarded } });
  if (path !== "/api/health") {
    const group =
      path.startsWith("/auth") || path === "/dc-auth"
        ? "auth"
        : path.startsWith("/oauth")
          ? "oauth"
          : path === "/mcp"
            ? "mcp"
            : path.includes("/chat/")
              ? "chat"
              : "api";
    try {
      await enforceRateLimit(
        request,
        group,
        group === "chat" ? 15 : group === "api" ? 180 : 60,
      );
    } catch (error) {
      const limited =
        error instanceof Error && error.message === "RATE_LIMITED";
      return NextResponse.json(
        {
          error: {
            code: limited ? "RATE_LIMITED" : "SERVICE_UNAVAILABLE",
            message: "Please try again shortly.",
          },
        },
        { status: limited ? 429 : 503, headers: { "retry-after": "60" } },
      );
    }
  }

  if (!path.startsWith("/api")) {
    const withFraming = (r: NextResponse) => {
      r.headers.set("content-security-policy", csp);
      return r;
    };
    // frame-ancestors 'none' on OAuth pages — the /oauth/authorize consent button
    // grants a full-power MCP token, so it must NEVER be frameable (anti-clickjacking).
    const denyFraming = (r: NextResponse) => {
      r.headers.set("content-security-policy", csp);
      return r;
    };
    if (path === "/mcp" || path.startsWith("/oauth"))
      return denyFraming(next()); // MCP/OAuth: never framed, and self-authenticating
    if (path === "/dc-embed" || path === "/dc-auth" || path.startsWith("/auth"))
      return withFraming(next()); // anonymous endpoints (embed needs DataCentral framing)
    const localAllowed = process.env.NODE_ENV !== "production";
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
          return NextResponse.redirect(
            new URL(
              `/dc-embed?returnUrl=${encodeURIComponent(returnUrl)}`,
              process.env.PULSE_PUBLIC_URL || request.url,
            ),
            302,
          );
        return withFraming(next());
      }
      // Resolve against PULSE_PUBLIC_URL when set so App Service TLS termination
      // doesn't yield an http:// Location the Secure session cookie won't accompany.
      const base = process.env.PULSE_PUBLIC_URL || request.url;
      return NextResponse.redirect(
        new URL(`/auth/login?returnUrl=${encodeURIComponent(returnUrl)}`, base),
        302,
      );
    }
    return withFraming(next());
  }

  const correlationId = requestCorrelationId(request);
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

  if (
    mutation &&
    request.body &&
    !(
      request.method === "PUT" &&
      /^\/api\/v1\/attachments\/[^/]+\/content$/.test(path)
    )
  ) {
    try {
      await readJsonValue(request.clone());
    } catch (error) {
      return apiError(error, correlationId);
    }
  }
  forwarded.set("x-correlation-id", correlationId);
  const response = next();
  response.headers.set("x-correlation-id", correlationId);
  return response;
}

export const config = {
  matcher: [
    "/api/:path*",
    "/",
    "/help",
    "/dc-embed",
    "/dc-auth",
    "/auth/:path*",
    "/mcp",
    "/oauth/:path*",
  ],
};
