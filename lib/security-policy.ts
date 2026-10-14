/**
 * A mail preview is a page of its own: images and inline styles and nothing else (no script, frame or font). The preview route sends it,
 * and next.config.ts sets it for the preview path too, because Next drops a route's own header when one of that name is already set
 * and the app-wide policy there would otherwise be the one that reaches the browser.
 */
export const PREVIEW_CONTENT_SECURITY_POLICY = "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'";

export function contentSecurityPolicy(nonce: string, ancestors = "'self'") {
  const development = process.env.NODE_ENV !== "production";
  return `default-src 'self'; base-uri 'self'; object-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'${development ? " 'unsafe-eval'" : ""}; connect-src 'self' https://*.blob.core.windows.net${development ? " ws: wss:" : ""}; frame-ancestors ${ancestors}; form-action 'self'`;
}
