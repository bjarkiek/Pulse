import { SignJWT, jwtVerify } from "jose";

export type SessionClaims = {
  sub: string;                 // dbo.Users.id (GUID) — what repositories consume
  email: string;
  name: string;
  ext: string;                 // external subject: Entra oid | "dc:{userId}" | "dev:local"
  amr: "entra" | "dc-hmac" | "dc-graph" | "dev";
  dc_embed?: true;             // chrome-hiding claim — set once at sign-in, travels with cookie
  tid?: string;                // Entra tenant id when applicable
  ver: 1;
};

export const SESSION_COOKIE = "pulse-session";
const TTL_SECONDS = 60 * 60 * 12; // 12h; embed re-handshakes on expiry, standalone re-SSO-redirects

export function secret(): Uint8Array | null {
  const s = process.env.PULSE_SESSION_SECRET;
  if (s && s.length >= 32) return new TextEncoder().encode(s);
  if (process.env.NODE_ENV !== "production")
    return new TextEncoder().encode("pulse-dev-session-secret-not-for-production");
  return null; // production without secret => session auth disabled
}

export async function createSessionToken(claims: Omit<SessionClaims, "ver">): Promise<string> {
  const key = secret();
  if (!key) throw new Error("SESSION_NOT_CONFIGURED");
  return new SignJWT({ ...claims, ver: 1 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .setIssuer("pulse")
    .setAudience("pulse")
    .sign(key);
}

export async function readSession(request: Request): Promise<SessionClaims | null> {
  const key = secret();
  if (!key) return null;
  const cookie = request.headers.get("cookie")?.split(";")
    .map((v) => v.trim().split("="))
    .find(([n]) => n === SESSION_COOKIE)?.[1];
  if (!cookie) return null;
  try {
    const { payload } = await jwtVerify(decodeURIComponent(cookie), key, {
      issuer: "pulse", audience: "pulse",
    });
    return payload.ver === 1 ? (payload as unknown as SessionClaims) : null;
  } catch {
    return null;
  }
}

// Manual Set-Cookie so we control the Partitioned attribute (CHIPS).
// SameSite=None; Secure is mandatory for the cookie to travel inside the
// cross-site DataCentral iframe; Partitioned keeps CHIPS-enforcing browsers working.
export function sessionSetCookie(token: string): string {
  const prod = process.env.NODE_ENV === "production";
  return prod
    ? `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${TTL_SECONDS}; HttpOnly; Secure; SameSite=None; Partitioned`
    : `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${TTL_SECONDS}; HttpOnly; SameSite=Lax`;
}

export function sessionClearCookie(): string {
  const prod = process.env.NODE_ENV === "production";
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly${prod ? "; Secure; SameSite=None; Partitioned" : "; SameSite=Lax"}`;
}
