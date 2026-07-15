// GET /oauth/authorize — the human-facing leg of the OAuth 2.1 authorization
// code + PKCE flow. This is a browser navigation (not a fetch/XHR call from
// the MCP client), so it ties into Pulse's normal app sign-in rather than
// speaking JSON: an unauthenticated visitor is bounced through /auth/login,
// and a signed-in one sees the consent page. Deliberately NOT wrapped in
// withCors (see cors.ts) since this never runs as a cross-origin fetch.
import { getMcpClient } from "@/lib/server/mcp/client-store";
import { randomToken } from "@/lib/server/mcp/crypto";
import { putOnce, type PendingConsent, CONSENT_TTL_MS } from "@/lib/server/mcp/code-cache";
import { requireBrowserIdentity } from "@/lib/server/mcp/browser-auth";
import { getIdentityContext } from "@/lib/server/identity-repository";
import { consentPage } from "@/lib/server/mcp/consent-page";

export const dynamic = "force-dynamic";

function textError(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

// Post-validation errors redirect BACK to the client's own redirect_uri (per
// RFC 6749 §4.1.2.1) rather than being rendered locally — the redirect_uri has
// already been confirmed to belong to the registered client by this point, so
// this is safe. (Never used before that check — see the open-redirect guard
// in GET below.)
function redirectError(redirectUri: string, error: string, description: string, state: string | null): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;

  // client_id and redirect_uri are validated BEFORE anything else, and their
  // failures are always a local 400 — never a redirect. This is the
  // open-redirect guard: until redirect_uri is confirmed to be one this
  // client registered, we must not be usable to bounce a browser anywhere an
  // attacker chooses.
  const clientId = params.get("client_id");
  const client = clientId ? await getMcpClient(clientId) : null;
  if (!client) return textError(400, "Unknown client_id.");

  const redirectUri = params.get("redirect_uri");
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return textError(400, "Unregistered redirect_uri.");
  }

  const state = params.get("state");

  const responseType = params.get("response_type");
  if (responseType !== "code") {
    return redirectError(redirectUri, "unsupported_response_type", 'response_type must be "code".', state);
  }

  const codeChallenge = params.get("code_challenge");
  const codeChallengeMethod = params.get("code_challenge_method");
  if (!codeChallenge || (codeChallengeMethod !== null && codeChallengeMethod !== "S256")) {
    return redirectError(redirectUri, "invalid_request", "PKCE with S256 is required.", state);
  }

  // Ties into the app's normal sign-in: an unauthenticated visitor is
  // redirected to /auth/login (not back to the MCP client) so they can
  // authenticate the same way as any other Pulse user.
  const identityOrResponse = await requireBrowserIdentity(request);
  if (identityOrResponse instanceof Response) return identityOrResponse;
  const identity = identityOrResponse;

  let context;
  try {
    context = await getIdentityContext(identity);
  } catch {
    return redirectError(redirectUri, "access_denied", "No active account.", state);
  }

  const nonce = randomToken(24);
  const pending: PendingConsent = {
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUri,
    codeChallenge,
    state,
    userId: identity.id,
    email: context.user.email,
    name: context.user.name,
  };
  putOnce("consent", nonce, pending, CONSENT_TTL_MS);

  const html = consentPage(client.clientName, redirectUri, context.user.name, context.user.email, nonce);
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
