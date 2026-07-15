import * as oidc from "openid-client";
import {
  getOidcConfig, isEntraConfigured, oidcStateClearCookie, readOidcState,
} from "@/lib/server/entra-oidc";
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

  if (!isEntraConfigured()) return redirectTo(url.origin, "/auth/error?code=oidc_failed");

  // Missing/expired transient cookie (e.g. the user sat on the Entra
  // consent screen past the 10-minute window) — restart the flow.
  const oidcState = await readOidcState(request);
  if (!oidcState) return redirectTo(url.origin, "/auth/login");

  try {
    const config = await getOidcConfig();
    const tokens = await oidc.authorizationCodeGrant(config, url, {
      pkceCodeVerifier: oidcState.cv,
      expectedState: oidcState.state,
      expectedNonce: oidcState.nonce,
    });
    const c = tokens.claims(); // oid, tid, preferred_username, name, email?
    if (!c) return redirectTo(url.origin, "/auth/error?code=oidc_failed", oidcStateClearCookie());

    // Belt-and-braces: discovery already pins the issuer to the tenant-specific
    // v2.0 authority, but assert the ID token's tid claim matches too.
    if (c.tid !== process.env.AUTH_ENTRA_TENANT_ID)
      return redirectTo(url.origin, "/auth/error?code=oidc_failed", oidcStateClearCookie());

    let user;
    try {
      user = await resolveUserForEntra(
        String(c.oid), String(c.tid), String(c.email ?? c.preferred_username),
        String(c.name ?? c.preferred_username),
      );
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      if (code === "NOT_PROVISIONED")
        return redirectTo(url.origin, "/auth/error?code=not_provisioned", oidcStateClearCookie());
      if (code === "USER_DISABLED")
        return redirectTo(url.origin, "/auth/error?code=disabled", oidcStateClearCookie());
      throw e;
    }

    const sessionToken = await createSessionToken({
      sub: user.id, email: user.email, name: user.name,
      ext: String(c.oid), amr: "entra", tid: String(c.tid),
    });

    const headers = new Headers({ location: new URL(oidcState.ru, url.origin).toString() });
    headers.append("set-cookie", sessionSetCookie(sessionToken));
    headers.append("set-cookie", oidcStateClearCookie());
    return new Response(null, { status: 302, headers });
  } catch {
    // Token exchange failure, state/nonce mismatch, or any other unexpected
    // error — fail into the whitelisted error page, never a raw 500.
    return redirectTo(url.origin, "/auth/error?code=oidc_failed", oidcStateClearCookie());
  }
}
