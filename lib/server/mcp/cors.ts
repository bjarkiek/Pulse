// CORS for the MCP transport surface: /mcp, /oauth/register, /oauth/token,
// and the four .well-known discovery routes. NOT applied to /oauth/authorize
// (that's a browser navigation/redirect flow, not a fetch/XHR call).

export const MCP_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "access-control-expose-headers": "Mcp-Session-Id, WWW-Authenticate",
};

export function withCors(response: Response): Response {
  for (const [name, value] of Object.entries(MCP_CORS_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

export function corsPreflight(): Response {
  return withCors(new Response(null, { status: 204 }));
}
