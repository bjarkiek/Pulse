import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { verifyAccessToken } from "@/lib/server/mcp/tokens";
import { resolveBaseUrl } from "@/lib/server/mcp/base-url";
import { MCP_CORS_HEADERS, withCors, corsPreflight } from "@/lib/server/mcp/cors";
import { getChatTools, chatToolErrorMessage, buildAssistantInstructions } from "@/lib/server/chat/tool-registry";
import { getIdentityContext } from "@/lib/server/identity-repository";
import { isAzureSqlConfigured } from "@/lib/server/database";
import type { PulseIdentity } from "@/lib/domain";

export const dynamic = "force-dynamic";

function unauthorized(request: Request): Response {
  const metadata = `${resolveBaseUrl(request)}/.well-known/oauth-protected-resource/mcp`;
  return new Response(
    JSON.stringify({ error: "invalid_token", error_description: "Missing or invalid bearer token." }),
    { status: 401, headers: { ...MCP_CORS_HEADERS, "content-type": "application/json",
        // This exact challenge is how MCP clients bootstrap OAuth discovery.
        "www-authenticate": `Bearer resource_metadata="${metadata}"` } });
}

async function handleMcp(request: Request): Promise<Response> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const claims = token ? await verifyAccessToken(token) : null;
  if (!claims) return unauthorized(request);

  // Per-request user binding: re-check the user is still active and resolve
  // memberships on EVERY request (stateless — no session affinity).
  const probe: PulseIdentity = {
    id: claims.sub, email: claims.email, name: claims.name,
    organizationId: "", role: isAzureSqlConfigured() ? "Unknown" : "System admin",
    isInternal: !isAzureSqlConfigured(),
  };
  let context: Awaited<ReturnType<typeof getIdentityContext>>;
  try { context = await getIdentityContext(probe); }
  catch {
    return withCors(new Response(JSON.stringify({
      error: "invalid_token", error_description: "No active account is linked to this token.",
    }), { status: 403, headers: { "content-type": "application/json" } }));
  }
  const identity: PulseIdentity = { ...probe, organizationId: context.activeOrganizationId ?? "" };

  const authInfo: AuthInfo = {
    token: token!, clientId: claims.clientId, scopes: ["mcp"], expiresAt: claims.exp,
    extra: { identity },
  };

  const server = new McpServer(
    { name: "DataCentral Pulse", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: buildAssistantInstructions(identity, context) },
  );
  for (const tool of getChatTools()) {
    server.registerTool(tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly } },
      async (args: Record<string, unknown>, extra) => {
        const bound = (extra.authInfo?.extra as { identity: PulseIdentity }).identity;
        try {
          // Clone per call: requireMembership mutates identity.organizationId.
          return { content: [{ type: "text" as const, text: await tool.run({ ...bound }, args) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: chatToolErrorMessage(error) }], isError: true };
        }
      });
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true, // no sessionIdGenerator → stateless mode
  });
  await server.connect(transport);
  return withCors(await transport.handleRequest(request, { authInfo }));
}

export const POST = handleMcp;
export const GET = handleMcp;
export const DELETE = handleMcp;
export const OPTIONS = () => corsPreflight();
