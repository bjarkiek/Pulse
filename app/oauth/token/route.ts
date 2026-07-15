// OAuth 2.1 token endpoint for the MCP authorization server: authorization_code
// (with PKCE) and refresh_token grants. Anonymous + CORS, form-encoded per
// RFC 6749 §4.1.3 / §6. All errors are RFC 6749-shaped { error, error_description }
// — this is a protocol endpoint consumed by MCP clients, not Pulse's own UI, so
// it deliberately does NOT use the Pulse apiError envelope.
import { getUserById, type ChatUserRecord } from "@/lib/server/chat/chat-repository";
import { verifyCodeChallenge } from "@/lib/server/mcp/crypto";
import { takeOnce, type IssuedCode } from "@/lib/server/mcp/code-cache";
import { withCors, corsPreflight } from "@/lib/server/mcp/cors";
import { ACCESS_TOKEN_SECONDS, createRefreshToken, issueAccessToken, redeemRefreshToken } from "@/lib/server/mcp/tokens";

export const dynamic = "force-dynamic";

function oauthError(status: number, error: string, error_description: string): Response {
  return withCors(Response.json({ error, error_description }, { status }));
}

function successResponse(accessToken: string, refreshToken: string): Response {
  const response = withCors(
    Response.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: refreshToken,
      scope: "mcp",
    }),
  );
  response.headers.set("cache-control", "no-store");
  return response;
}

// Shared by both grants: loads the user (must be Active — spec §10 rejects
// disabled users at token and refresh time) and issues a fresh access +
// refresh pair. Returns null on an inactive/missing user.
async function issueTokenPair(
  userId: string,
  clientId: string,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const user: ChatUserRecord | null = await getUserById(userId);
  if (!user || user.status !== "Active") return null;
  const [accessToken, refreshToken] = await Promise.all([
    issueAccessToken(user, clientId),
    createRefreshToken(user.id, clientId),
  ]);
  return { accessToken, refreshToken };
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError(400, "invalid_request", "Request body must be application/x-www-form-urlencoded.");
  }

  const clientId = form.get("client_id");
  if (typeof clientId !== "string" || !clientId) {
    return oauthError(400, "invalid_client", "client_id is required.");
  }

  const grantType = form.get("grant_type");

  if (grantType === "authorization_code") {
    const code = form.get("code");
    // Burn the code BEFORE any other validation — a replay must fail even if
    // client_id/redirect_uri/code_verifier are wrong on the second attempt.
    const record = typeof code === "string" ? takeOnce<IssuedCode>("code", code) : null;
    if (!record) {
      return oauthError(400, "invalid_grant", "The authorization code is invalid, expired, or already used.");
    }
    if (record.clientId !== clientId) {
      return oauthError(400, "invalid_grant", "The authorization code was not issued to this client.");
    }
    const redirectUri = form.get("redirect_uri");
    if (record.redirectUri !== redirectUri) {
      return oauthError(400, "invalid_grant", "redirect_uri does not match the authorization request.");
    }
    const verifier = form.get("code_verifier");
    if (typeof verifier !== "string" || !verifyCodeChallenge(verifier, record.codeChallenge)) {
      return oauthError(400, "invalid_grant", "PKCE verification failed.");
    }
    const pair = await issueTokenPair(record.userId, clientId);
    if (!pair) return oauthError(400, "invalid_grant", "The user account is not active.");
    return successResponse(pair.accessToken, pair.refreshToken);
  }

  if (grantType === "refresh_token") {
    const refreshToken = form.get("refresh_token");
    if (typeof refreshToken !== "string" || !refreshToken) {
      return oauthError(400, "invalid_grant", "refresh_token is required.");
    }
    const userId = await redeemRefreshToken(refreshToken, clientId);
    if (!userId) {
      return oauthError(400, "invalid_grant", "The refresh token is invalid, expired, or revoked.");
    }
    const pair = await issueTokenPair(userId, clientId);
    if (!pair) return oauthError(400, "invalid_grant", "The user account is not active.");
    return successResponse(pair.accessToken, pair.refreshToken);
  }

  return oauthError(400, "unsupported_grant_type", `Grant type "${String(grantType)}" is not supported.`);
}

export const OPTIONS = corsPreflight;
