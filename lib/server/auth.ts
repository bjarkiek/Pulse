import type { PulseIdentity } from "@/lib/domain";

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

export function getIdentity(request: Request): PulseIdentity {
  const principal = parsePrincipal(
    request.headers.get("x-ms-client-principal"),
  );
  const email =
    request.headers.get("x-ms-client-principal-name") || principal?.userDetails;
  const userId =
    request.headers.get("x-ms-client-principal-id") || principal?.userId;
  const localAllowed =
    process.env.NODE_ENV !== "production" ||
    process.env.PULSE_ALLOW_DEMO_IDENTITY === "true";
  const contextCookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((value) => value.trim().split("="))
    .find(([name]) => name === "pulse-organization")?.[1];

  if (!email && !localAllowed) throw new Error("UNAUTHORIZED");

  // The active organization is a request hint only. Repositories always verify
  // the user has an active membership before reading or mutating tenant data.
  return {
    id: userId || "11111111-1111-4111-8111-111111111111",
    email: email || "bjarki@uidata.com",
    name: request.headers.get("x-pulse-user-name") || "Bjarki Kristjánsson",
    organizationId:
      request.headers.get("x-pulse-organization-id") ||
      (contextCookie ? decodeURIComponent(contextCookie) : "") ||
      (localAllowed ? "ORG-001" : ""),
    role: localAllowed ? "System admin" : "Unknown",
    isInternal: localAllowed,
  };
}
