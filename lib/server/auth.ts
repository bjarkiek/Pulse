import type { PulseIdentity } from "@/lib/domain";
import { readSession } from "@/lib/server/session";
import { verifyDcLaunch } from "@/lib/server/datacentral";
import { resolveUserForDcLaunch } from "@/lib/server/user-directory";

type ClientPrincipal = {
  claims?: Array<{ typ: string; val: string }>;
  userId?: string;
  userDetails?: string;
};

function parsePrincipal(value: string | null): ClientPrincipal | null {
  if (!value) return null;
  try {
    return JSON.parse(
      Buffer.from(value, "base64").toString("utf8"),
    ) as ClientPrincipal;
  } catch {
    return null;
  }
}

// The active organization is a request hint only. Repositories always verify
// the user has an active membership before reading or mutating tenant data.
function resolveOrgHint(request: Request): string {
  const contextCookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((value) => value.trim().split("="))
    .find(([name]) => name === "pulse-organization")?.[1];
  return (
    request.headers.get("x-pulse-organization-id") ||
    (contextCookie ? decodeURIComponent(contextCookie) : "") ||
    ""
  );
}

export async function getIdentity(request: Request): Promise<PulseIdentity> {
  const orgHint = resolveOrgHint(request);

  // ① pulse-session cookie — the primary credential once a session exists.
  const session = await readSession(request);
  if (session)
    return {
      id: session.sub,
      email: session.email,
      name: session.name,
      organizationId: orgHint,
      role: "Unknown",
      isInternal: false,
      dcEmbed: Boolean(session.dc_embed),
      authMethod: session.amr,
      isVerified: true,
    };

  // ② X-DC-Data/X-DC-Sig headers — per-request DataCentral launch re-verification,
  // for callers that carry the signed launch payload directly rather than a session.
  const dcData = request.headers.get("x-dc-data");
  const dcSig = request.headers.get("x-dc-sig");
  if (dcData && dcSig) {
    const launch = verifyDcLaunch(dcData, dcSig);
    if (launch) {
      // Map provisioning errors to codes apiError understands — otherwise
      // NOT_PROVISIONED/USER_DISABLED fall through apiError's default → 500.
      let user;
      try {
        user = await resolveUserForDcLaunch(launch);
      } catch (e) {
        const code = e instanceof Error ? e.message : "";
        if (code === "NOT_PROVISIONED" || code === "USER_DISABLED")
          throw new Error("FORBIDDEN");
        throw e;
      }
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        organizationId: orgHint,
        role: "Unknown",
        isInternal: false,
        dcEmbed: true,
        authMethod: "dc-hmac",
        isVerified: true,
      };
    }
  }

  // ③ Easy Auth headers — only trusted when explicitly enabled (e.g. behind
  // App Service authentication), since these headers are otherwise spoofable.
  if (process.env.PULSE_TRUST_EASYAUTH_HEADERS === "true") {
    const principal = parsePrincipal(
      request.headers.get("x-ms-client-principal"),
    );
    const email =
      request.headers.get("x-ms-client-principal-name") ||
      principal?.userDetails;
    const userId =
      request.headers.get("x-ms-client-principal-id") || principal?.userId;
    if (email && userId)
      return {
        id: userId,
        email,
        name: request.headers.get("x-pulse-user-name") || email,
        organizationId: orgHint,
        role: "Unknown",
        isInternal: false,
        dcEmbed: false,
        authMethod: "easyauth",
        isVerified: true,
      };
  }

  // ④ Demo fallback — local dev, or explicitly opted in via PULSE_ALLOW_DEMO_IDENTITY.
  const localAllowed =
    process.env.NODE_ENV !== "production" ||
    process.env.PULSE_ALLOW_DEMO_IDENTITY === "true";
  if (localAllowed)
    return {
      id: "11111111-1111-4111-8111-111111111111",
      email: "bjarki@uidata.com",
      name: "Bjarki Kristjánsson",
      organizationId: orgHint || "ORG-001",
      role: "System admin",
      isInternal: true,
      dcEmbed: false,
      authMethod: "dev",
      isVerified: false,
    };

  // ⑤ No credential resolved.
  throw new Error("UNAUTHORIZED");
}
