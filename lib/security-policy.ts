export function contentSecurityPolicy(nonce: string, ancestors = "'self'") {
  const development = process.env.NODE_ENV !== "production";
  return `default-src 'self'; base-uri 'self'; object-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'${development ? " 'unsafe-eval'" : ""}; connect-src 'self' https://*.blob.core.windows.net${development ? " ws: wss:" : ""}; frame-ancestors ${ancestors}; form-action 'self'`;
}
