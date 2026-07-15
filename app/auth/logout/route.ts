import { sessionClearCookie } from "@/lib/server/session";

export const dynamic = "force-dynamic";

// Fetch/XHR-style logout (e.g. from the app shell) — clears the session
// cookie without navigating the browser.
export async function POST(): Promise<Response> {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": sessionClearCookie() },
  });
}

// Top-level navigation logout — also ends the Entra session so a subsequent
// /auth/login doesn't silently re-authenticate via an existing IdP session.
export async function GET(request: Request): Promise<Response> {
  const tenantId = process.env.AUTH_ENTRA_TENANT_ID;
  const publicUrl = process.env.PULSE_PUBLIC_URL || new URL(request.url).origin;
  const location = tenantId
    ? `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/logout` +
      `?post_logout_redirect_uri=${encodeURIComponent(publicUrl)}`
    : publicUrl;
  return new Response(null, {
    status: 302,
    headers: { location, "set-cookie": sessionClearCookie() },
  });
}
