import * as oidc from "openid-client";
import {
  getOidcConfig, isEntraConfigured, oidcStateClearCookie, readOidcState,
} from "@/lib/server/entra-oidc";
import { publicOrigin, publicCallbackUrl } from "@/lib/server/http";
import { resolveUserForEntra } from "@/lib/server/user-directory";
import { createSessionToken, sessionSetCookie } from "@/lib/server/session";

export const dynamic = "force-dynamic";

function redirectTo(origin: string, path: string, extraSetCookie?: string): Response {
  const headers = new Headers({ location: new URL(path, origin).toString() });
  if (extraSetCookie) headers.append("set-cookie", extraSetCookie);
  return new Response(null, { status: 302, headers });
}

// Completes the standalone sign-in flow started at /auth/login: exchanges
// the authorization code (with PKCE) for tokens, verifies state/nonce,
// re-pins the tenant, resolves the caller against dbo.Users, and mints the
// Pulse session cookie.
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (!isEntraConfigured()) return redirectTo(publicOrigin(request), "/auth/error?code=oidc_failed");

  // Missing/expired transient cookie (e.g. the user sat on the Entra
  // consent screen past the 10-minute window) — restart the flow.
  const oidcState = await readOidcState(request);
  if (!oidcState) return redirectTo(publicOrigin(request), "/auth/login");

  try {
    const config = await getOidcConfig();
    // publicCallbackUrl, NOT url: openid-client derives the token-exchange
    // redirect_uri from this URL, and it must match the registered public
    // callback — request.url carries the container's internal authority.
    const tokens = await oidc.authorizationCodeGrant(config, publicCallbackUrl(request), {
      pkceCodeVerifier: oidcState.cv,
      expectedState: oidcState.state,
      expectedNonce: oidcState.nonce,
    });
    const c = tokens.claims(); // oid, tid, preferred_username, name, email?
    if (!c) {
      console.error(JSON.stringify({ level: "error", route: "/auth/callback", message: "no ID token claims" }));
      return redirectTo(publicOrigin(request), "/auth/error?code=oidc_failed", oidcStateClearCookie());
    }

    // Belt-and-braces: discovery already pins the issuer to the tenant-specific
    // v2.0 authority, but assert the ID token's tid claim matches too.
    if (c.tid !== process.env.AUTH_ENTRA_TENANT_ID) {
      // Logs which account/tenant actually arrived — the classic cause is the
      // Microsoft account picker choosing a personal or other-tenant account.
      console.error(JSON.stringify({
        level: "error", route: "/auth/callback", message: "tenant pin mismatch",
        expectedTid: process.env.AUTH_ENTRA_TENANT_ID, actualTid: c.tid ?? null,
        account: typeof c.preferred_username === "string" ? c.preferred_username : null,
      }));
      return redirectTo(publicOrigin(request), "/auth/error?code=oidc_failed", oidcStateClearCookie());
    }

    let user;
    try {
      user = await resolveUserForEntra(
        String(c.oid), String(c.tid), String(c.email ?? c.preferred_username),
        String(c.name ?? c.preferred_username),
      );
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      if (code === "NOT_PROVISIONED")
        return redirectTo(publicOrigin(request), "/auth/error?code=not_provisioned", oidcStateClearCookie());
      if (code === "USER_DISABLED")
        return redirectTo(publicOrigin(request), "/auth/error?code=disabled", oidcStateClearCookie());
      throw e;
    }

    const sessionToken = await createSessionToken({
      sub: user.id, email: user.email, name: user.name,
      ext: String(c.oid), amr: "entra", tid: String(c.tid),
    });

    const headers = new Headers({ location: new URL(oidcState.ru, publicOrigin(request)).toString() });
    headers.append("set-cookie", sessionSetCookie(sessionToken));
    headers.append("set-cookie", oidcStateClearCookie());
    return new Response(null, { status: 302, headers });
  } catch (error) {
    // Token exchange failure, state/nonce mismatch, or any other unexpected
    // error — fail into the whitelisted error page, never a raw 500. Log the
    // real cause (server-side only) so oidc_failed is diagnosable from the
    // container logs instead of being a dead end.
    console.error(JSON.stringify({
      level: "error", route: "/auth/callback",
      message: error instanceof Error ? error.message : String(error),
    }));
    return redirectTo(publicOrigin(request), "/auth/error?code=oidc_failed", oidcStateClearCookie());
  }
}
