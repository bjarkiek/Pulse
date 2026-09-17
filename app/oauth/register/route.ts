import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJson } from "@/lib/server/validation";
// RFC 7591 dynamic client registration for the MCP authorization server.
// Anonymous + CORS: browser-hosted MCP clients (claude.ai) register with a
// preflighted cross-origin POST before they ever hold a session, so this
// route (and its OPTIONS handler) must work with no auth and permissive CORS.
import { createMcpClient, isAllowedRedirectUri } from "@/lib/server/mcp/client-store";
import { withCors, corsPreflight } from "@/lib/server/mcp/cors";

export const dynamic = "force-dynamic";

function errorResponse(status: number, error: string, error_description: string): Response {
  return withCors(Response.json({ error, error_description }, { status }));
}

export async function POST(request: Request) {
  try { await enforceRateLimit(request, "oauth-register", 10); } catch {
    return errorResponse(429, "rate_limited", "Too many registration requests. Try again shortly.");
  }

  let body: unknown;
  try {
    body = await readJson(request, 8192);
  } catch {
    return errorResponse(400, "invalid_client_metadata", "Request body must be valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse(400, "invalid_client_metadata", "Request body must be a JSON object.");
  }
  const metadata = body as Record<string, unknown>;

  const redirectUrisRaw = metadata.redirect_uris;
  if (!Array.isArray(redirectUrisRaw) || redirectUrisRaw.length === 0) {
    return errorResponse(400, "invalid_redirect_uri", "At least one redirect_uri is required.");
  }
  if (!redirectUrisRaw.every((uri): uri is string => typeof uri === "string")) {
    return errorResponse(400, "invalid_client_metadata", "redirect_uris must be an array of strings.");
  }
  const redirectUris = redirectUrisRaw;
  if (!redirectUris.every(isAllowedRedirectUri)) {
    return errorResponse(400, "invalid_redirect_uri", "One or more redirect_uris are not permitted.");
  }

  const clientNameRaw = metadata.client_name;
  const clientName = (typeof clientNameRaw === "string" && clientNameRaw.length > 0 ? clientNameRaw : "MCP client").slice(
    0,
    200,
  );

  const client = await createMcpClient(clientName, redirectUris);

  return withCors(
    Response.json(
      {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1000),
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      { status: 201 },
    ),
  );
}

export const OPTIONS = corsPreflight;
