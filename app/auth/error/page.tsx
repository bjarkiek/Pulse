// Static, unauthenticated error page. Deliberately carries no identifying
// detail (no email, no oid, no tenant, no stack trace) and no external or
// "click to launch" links — just a whitelisted, friendly message.
const MESSAGES: Record<string, string> = {
  not_provisioned:
    "Your account has not been set up in Pulse yet. Ask a DataCentral administrator to add you (same email address).",
  disabled: "Your account is disabled — please contact an administrator.",
  oidc_failed: "Sign-in failed. Please try again.",
};

const DEFAULT_MESSAGE = MESSAGES.oidc_failed;

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const params = await searchParams;
  const code = Array.isArray(params.code) ? params.code[0] : params.code;
  const message = (code && MESSAGES[code]) || DEFAULT_MESSAGE;

  return (
    <main
      style={{
        display: "grid",
        placeItems: "center",
        minHeight: "100vh",
        padding: "24px",
        fontFamily: "system-ui, sans-serif",
        color: "#1f2328",
        background: "#f6f7f9",
      }}
    >
      <section style={{ maxWidth: 420, textAlign: "center" }}>
        <h1 style={{ fontSize: 20, marginBottom: 12 }}>Sign-in problem</h1>
        <p style={{ fontSize: 14, lineHeight: 1.5, color: "#444" }}>{message}</p>
      </section>
    </main>
  );
}
