import * as oidc from "openid-client";
import { SignJWT, jwtVerify } from "jose";

declare global { var pulseOidcConfig: Promise<oidc.Configuration> | undefined; }

export function isEntraConfigured(): boolean {
  return Boolean(process.env.AUTH_ENTRA_TENANT_ID && process.env.AUTH_ENTRA_CLIENT_ID
    && process.env.AUTH_ENTRA_CLIENT_SECRET);
}

// Discovery against the tenant-specific v2.0 authority pins the issuer to the tenant.
export function getOidcConfig(): Promise<oidc.Configuration> {
  globalThis.pulseOidcConfig ||= oidc.discovery(
    new URL(`https://login.microsoftonline.com/${process.env.AUTH_ENTRA_TENANT_ID}/v2.0`),
    process.env.AUTH_ENTRA_CLIENT_ID!,
    process.env.AUTH_ENTRA_CLIENT_SECRET!,
  );
  return globalThis.pulseOidcConfig;
}

export function redirectUri(): string {
  return new URL("/auth/callback", process.env.PULSE_PUBLIC_URL || "http://localhost:3000").toString();
}

// ---------------------------------------------------------------------------
// Transient `pulse-oidc` state cookie — carries the PKCE verifier, the
// state/nonce we expect back from Entra, and the sanitized post-login
// returnUrl across the redirect out to Entra and back to /auth/callback.
//
// Signed with the same secret material as the session cookie. session.ts's
// `secret()` helper is module-private and this task's file list does not
// include modifying session.ts, so the fallback (PULSE_SESSION_SECRET, with
// a fixed dev-only fallback string, disabled in production when unset) is
// mirrored here rather than imported.
// ---------------------------------------------------------------------------

export const OIDC_STATE_COOKIE = "pulse-oidc";
const OIDC_STATE_TTL_SECONDS = 600;

export type OidcState = { cv: string; state: string; nonce: string; ru: string };

function oidcStateSecret(): Uint8Array | null {
  const s = process.env.PULSE_SESSION_SECRET;
  if (s && s.length >= 32) return new TextEncoder().encode(s);
  if (process.env.NODE_ENV !== "production")
    return new TextEncoder().encode("pulse-dev-session-secret-not-for-production");
  return null; // production without secret => standalone OIDC state signing disabled
}

// Returns null when the secret isn't configured (production without
// PULSE_SESSION_SECRET) — callers treat that the same as OIDC being
// unconfigured and fail gracefully rather than signing with no key.
export async function signOidcState(state: OidcState): Promise<string | null> {
  const key = oidcStateSecret();
  if (!key) return null;
  return new SignJWT({ ...state })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${OIDC_STATE_TTL_SECONDS}s`)
    .setIssuer("pulse")
    .setAudience("pulse-oidc")
    .sign(key);
}

export async function readOidcState(request: Request): Promise<OidcState | null> {
  const key = oidcStateSecret();
  if (!key) return null;
  const cookie = request.headers.get("cookie")?.split(";")
    .map((v) => v.trim().split("="))
    .find(([n]) => n === OIDC_STATE_COOKIE)?.[1];
  if (!cookie) return null;
  try {
    const { payload } = await jwtVerify(decodeURIComponent(cookie), key, {
      issuer: "pulse", audience: "pulse-oidc",
    });
    const { cv, state, nonce, ru } = payload as Record<string, unknown>;
    if (typeof cv !== "string" || typeof state !== "string"
      || typeof nonce !== "string" || typeof ru !== "string") return null;
    return { cv, state, nonce, ru };
  } catch {
    return null;
  }
}

export function oidcStateSetCookie(token: string): string {
  const prod = process.env.NODE_ENV === "production";
  return `${OIDC_STATE_COOKIE}=${token}; Path=/; Max-Age=${OIDC_STATE_TTL_SECONDS}; HttpOnly; SameSite=Lax${prod ? "; Secure" : ""}`;
}

export function oidcStateClearCookie(): string {
  const prod = process.env.NODE_ENV === "production";
  return `${OIDC_STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${prod ? "; Secure" : ""}`;
}
