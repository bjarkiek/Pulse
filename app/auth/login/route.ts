import * as oidc from "openid-client";
import {
  getOidcConfig, isEntraConfigured, oidcStateSetCookie, redirectUri, signOidcState,
} from "@/lib/server/entra-oidc";

export const dynamic = "force-dynamic";

function sanitizeReturnUrl(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function redirectTo(origin: string, path: string): Response {
  return new Response(null, { status: 302, headers: { location: new URL(path, origin).toString() } });
}

// Entry point for the standalone (non-embedded) sign-in flow. Redirects to
// Entra's authorize endpoint with PKCE S256 + state + nonce; the verifier,
// state, nonce, and sanitized returnUrl travel to /auth/callback in a signed
// transient cookie rather than server-side session storage.
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const returnUrl = sanitizeReturnUrl(url.searchParams.get("returnUrl"));

  // Graceful degradation: the app must still start (and every other route
  // must still work) when Entra isn't configured — only this flow fails.
  if (!isEntraConfigured()) return redirectTo(url.origin, "/auth/error?code=oidc_failed");

  try {
    const config = await getOidcConfig();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const authUrl = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri(), scope: "openid profile email",
      code_challenge: codeChallenge, code_challenge_method: "S256", state, nonce,
    });

    const token = await signOidcState({ cv: codeVerifier, state, nonce, ru: returnUrl });
    if (!token) return redirectTo(url.origin, "/auth/error?code=oidc_failed");

    return new Response(null, {
      status: 302,
      headers: { location: authUrl.toString(), "set-cookie": oidcStateSetCookie(token) },
    });
  } catch {
    // Discovery/network failure against login.microsoftonline.com — fail
    // into the same whitelisted error page rather than a raw 500.
    return redirectTo(url.origin, "/auth/error?code=oidc_failed");
  }
}
