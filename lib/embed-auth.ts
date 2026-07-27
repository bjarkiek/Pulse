// Embedded-session bearer auth (client-safe module, no React).
//
// Inside the DataCentral iframe the session cookie is a third-party cookie and
// browsers may refuse to store or send it (even with SameSite=None; Partitioned).
// The embed therefore holds the session token from /dc-auth's response body in
// sessionStorage and attaches it to every same-origin API request as an
// Authorization: Bearer header — the carrier that no cookie policy can block.
// Standalone (top-level) sessions keep using the HttpOnly cookie; when no token
// is stashed this module does nothing.

export const EMBED_TOKEN_KEY = "pulse-embed-token";

// Pure decision + header merge, unit-tested in isolation. Returns the init to
// use for fetch. Rules:
//  - only same-origin targets get the header (cross-origin — e.g. Azure Blob
//    SAS uploads — must NEVER see the session token);
//  - an explicit Authorization header set by the caller always wins;
//  - without a token the init passes through untouched.
export function applyEmbedAuth(
  input: string | URL,
  init: RequestInit | undefined,
  token: string | null,
  origin: string,
): RequestInit | undefined {
  if (!token) return init;
  let sameOrigin: boolean;
  try {
    sameOrigin = new URL(input, origin).origin === origin;
  } catch {
    return init; // unparseable target: leave the request alone
  }
  if (!sameOrigin) return init;
  const headers = new Headers(init?.headers);
  if (headers.has("authorization")) return init;
  headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers };
}

// Patch window.fetch once. The token is read from sessionStorage on every call
// so a re-handshake (fresh /dc-auth) takes effect without a reload. Requests
// built as Request objects pass through untouched — nothing in this app uses
// them, and rewriting them risks losing body/mode/credential semantics.
export function installEmbedAuthFetch(): void {
  if (typeof window === "undefined") return;
  const w = window as Window & { __pulseEmbedFetchInstalled?: boolean };
  if (w.__pulseEmbedFetchInstalled) return;
  w.__pulseEmbedFetchInstalled = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request) return original(input, init);
    let token: string | null = null;
    try { token = window.sessionStorage.getItem(EMBED_TOKEN_KEY); } catch { /* storage blocked */ }
    return original(input, applyEmbedAuth(input, init, token, window.location.origin));
  };
}
