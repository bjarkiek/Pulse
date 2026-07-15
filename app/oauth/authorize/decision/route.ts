// POST /oauth/authorize/decision — burns the consent nonce minted by GET
// /oauth/authorize and, on "allow", mints the authorization code Task 24's
// /oauth/token redeems. This is a same-origin form POST from the consent
// page, not an MCP-client fetch, so it deliberately sits outside cors.ts.
// It's also outside proxy.ts's CSRF matcher (that only guards /api/*), so the
// same-origin check has to happen inline here.
import { getIdentity } from "@/lib/server/auth";
import { randomToken } from "@/lib/server/mcp/crypto";
import { takeOnce, putOnce, type PendingConsent, type IssuedCode, CODE_TTL_MS } from "@/lib/server/mcp/code-cache";

export const dynamic = "force-dynamic";

const CONSENT_EXPIRED_MESSAGE = "Consent request expired — restart the connection from your MCP client.";

function textError(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) {
    // Opaque/malformed Origin values (e.g. the literal string "null" browsers
    // send for sandboxed/file-origin requests) make `new URL(origin)` throw.
    // Fail closed — treat anything unparseable as NOT same-origin rather than
    // letting the exception escape as an uncaught 500.
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    if (originHost !== new URL(request.url).host) return false;
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  return true;
}

function redirectWithParams(redirectUri: string, params: Record<string, string>): Response {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return Response.redirect(url.toString(), 302);
}

export async function POST(request: Request): Promise<Response> {
  // ① Inline same-origin guard — this route is outside proxy.ts's CSRF
  // matcher (which only covers /api/*), so a cross-site POST here would
  // otherwise be able to burn a victim's pending consent.
  if (!isSameOrigin(request)) {
    return textError(403, "Cross-site request rejected.");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return textError(400, "Request body must be application/x-www-form-urlencoded.");
  }

  const nonce = form.get("nonce");
  const pending = typeof nonce === "string" && nonce ? takeOnce<PendingConsent>("consent", nonce) : null;
  if (!pending) {
    return textError(400, CONSENT_EXPIRED_MESSAGE);
  }

  // ③ The user who clicks Allow/Deny must be the same one the consent page
  // was rendered for — otherwise a signed-out-then-back-in-as-someone-else
  // browser tab could mint a code bound to the wrong account.
  let identity;
  try {
    identity = await getIdentity(request);
  } catch {
    return textError(400, "Signed-in user does not match the consent request.");
  }
  if (identity.id !== pending.userId) {
    return textError(400, "Signed-in user does not match the consent request.");
  }

  const action = form.get("action");
  if (action !== "allow") {
    return redirectWithParams(
      pending.redirectUri,
      pending.state ? { error: "access_denied", state: pending.state } : { error: "access_denied" },
    );
  }

  const code = randomToken(32);
  const issued: IssuedCode = {
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    userId: pending.userId,
  };
  putOnce("code", code, issued, CODE_TTL_MS);

  return redirectWithParams(pending.redirectUri, pending.state ? { code, state: pending.state } : { code });
}
