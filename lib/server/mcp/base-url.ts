// Resolves the externally-visible base URL used to build OAuth issuer/
// endpoint URLs. Never trust the inbound Host header for this — it's
// attacker-controlled — so prefer the operator-configured public URL and
// fall back to the request's own origin (App Service terminates TLS and
// forwards the true origin here, unlike Host).
export function resolveBaseUrl(request: Request): string {
  const configured = process.env.PULSE_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin;
}
