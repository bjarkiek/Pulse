// Renders the human-facing consent screen for GET /oauth/authorize. clientName
// is attacker-controlled (any caller can POST /oauth/register with an arbitrary
// client_name), so every interpolation here MUST be HTML-escaped — this is the
// only thing standing between a malicious registration and stored XSS on a
// page whose "Allow" button mints a full-power MCP access token.
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

export function consentPage(
  clientName: string,
  redirectUri: string,
  displayName: string,
  email: string,
  nonce: string,
): string {
  const origin = new URL(redirectUri).origin;
  const safeClientName = escapeHtml(clientName);
  const safeOrigin = escapeHtml(origin);
  const safeDisplayName = escapeHtml(displayName);
  const safeEmail = escapeHtml(email);
  const safeNonce = escapeHtml(nonce);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connect to DataCentral Pulse</title>
</head>
<body style="margin:0; padding:0; min-height:100vh; display:grid; place-items:center; font-family:system-ui,-apple-system,Segoe UI,sans-serif; background:#f6f7f9; color:#1f2328;">
  <main style="max-width:440px; width:calc(100% - 48px); margin:24px; padding:32px; background:#ffffff; border-radius:12px; border:1px solid #e3e6ea; box-shadow:0 1px 3px rgba(0,0,0,0.08);">
    <p style="font-size:12px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; color:#6b7280; margin:0 0 8px;">DataCentral Pulse</p>
    <h1 style="font-size:18px; margin:0 0 16px; line-height:1.4;">Allow access to your account?</h1>
    <p style="font-size:14px; line-height:1.6; color:#333333; margin:0 0 28px;">
      <strong>${safeClientName}</strong> (${safeOrigin}) is asking to access DataCentral Pulse as
      <strong>${safeDisplayName}</strong> (${safeEmail}) &mdash; it will be able to do everything you can do.
      All actions are logged as you.
    </p>
    <form method="POST" action="/oauth/authorize/decision">
      <input type="hidden" name="nonce" value="${safeNonce}" />
      <div style="display:flex; gap:12px;">
        <button type="submit" name="action" value="deny" style="flex:1; padding:10px 16px; font-size:14px; font-weight:500; border-radius:8px; border:1px solid #d0d5dd; background:#ffffff; color:#1f2328; cursor:pointer;">Deny</button>
        <button type="submit" name="action" value="allow" style="flex:1; padding:10px 16px; font-size:14px; font-weight:500; border-radius:8px; border:none; background:#1f6feb; color:#ffffff; cursor:pointer;">Allow</button>
      </div>
    </form>
  </main>
</body>
</html>
`;
}
