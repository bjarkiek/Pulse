// A Graph access token's audience is Graph, not this app — validate it by USING it:
// a successful GET /me proves it is a live Entra token. Accepted as identity proof
// ONLY because it arrives over the trusted DataCentral iframe handshake AND the
// tenant is pinned. Never expose this as a general API.
export async function validateGraphToken(token: string): Promise<
  { oid: string; upn: string; displayName: string; tid: string } | null
> {
  const pinnedTenant = process.env.AUTH_ENTRA_TENANT_ID;
  const tid = readTid(token);
  if (pinnedTenant && tid && tid.toLowerCase() !== pinnedTenant.toLowerCase()) return null;
  try {
    const res = await fetch(
      "https://graph.microsoft.com/v1.0/me?$select=id,userPrincipalName,displayName",
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: string; userPrincipalName?: string; displayName?: string };
    if (!body.id) return null;
    return {
      oid: body.id,
      upn: body.userPrincipalName ?? "",
      displayName: body.displayName ?? body.userPrincipalName ?? "",
      tid: tid ?? "",
    };
  } catch {
    return null;
  }
}

// Best-effort decode of the JWT payload "tid" claim; null when not a decodable JWT.
function readTid(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json.tid === "string" ? json.tid : null;
  } catch {
    return null;
  }
}
