// Single-use, in-memory cache for OAuth authorization codes and pending
// consent records. Backed by a global Map rather than SQL because entries are
// low-value secrets (≤10-minute TTL, single redemption) and Pulse runs as a
// single-instance App Service (P1v3, capacity 1, alwaysOn) — worst case on a
// process restart is the user redoing the consent/authorize round trip. If
// the app ever scales out to multiple instances, this cache (and the proxy
// rate limiter) must move to a shared store — see docs/architecture.md.

export type PendingConsent = {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  userId: string;
  email: string;
  name: string;
};

export type IssuedCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: string;
};

export const CODE_TTL_MS = 5 * 60_000;
export const CONSENT_TTL_MS = 10 * 60_000;

type CacheKind = "code" | "consent";

type CacheEntry = {
  value: unknown;
  expiresAt: number;
};

declare global {
  var pulseMcpCodeCache: Map<string, CacheEntry> | undefined;
}

function cache(): Map<string, CacheEntry> {
  globalThis.pulseMcpCodeCache ||= new Map();
  return globalThis.pulseMcpCodeCache;
}

function cacheKey(kind: CacheKind, key: string): string {
  return `${kind}:${key}`;
}

export function putOnce(kind: CacheKind, key: string, value: unknown, ttlMs: number): void {
  cache().set(cacheKey(kind, key), { value, expiresAt: Date.now() + ttlMs });
}

// Single-use retrieval: the entry is deleted BEFORE the expiry check, not
// after. Node's single-threaded event loop means nothing can interleave
// between the get and the delete below, so this get-then-delete pair is the
// atomic claim — two rapid takeOnce calls for the same key can never both
// observe a value, which is what makes an authorization-code replay burn the
// code instead of succeeding. The expiry check only decides what we return
// for this call; it never changes whether the entry survives.
export function takeOnce<T>(kind: CacheKind, key: string): T | null {
  const k = cacheKey(kind, key);
  const entry = cache().get(k);
  cache().delete(k);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.value as T;
}
