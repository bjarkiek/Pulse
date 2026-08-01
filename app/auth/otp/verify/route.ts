import { verifyOtpCode } from "@/lib/server/otp-login";
import { resolveUserForOtp } from "@/lib/server/user-directory";
import { createSessionToken, sessionSetCookie } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const fail = (status: number, error: string) => Response.json({ error }, { status });

// Exchanges e-mail + code for a Pulse session (amr: "otp"). Same inline
// same-origin guard as /dc-auth and /auth/otp/start.
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  let originMismatch = false;
  if (origin) {
    try { originMismatch = new URL(origin).host !== request.headers.get("host"); }
    catch { originMismatch = true; }
  }
  if (originMismatch || request.headers.get("sec-fetch-site") === "cross-site")
    return fail(403, "cross_site_rejected");

  const body = (await request.json().catch(() => ({}))) as { email?: string; code?: string };
  const email = body.email?.trim().toLowerCase();
  const code = body.code?.trim();
  if (!email || !code) return fail(400, "missing_credentials");

  const verdict = await verifyOtpCode(email, code);
  if (verdict !== "ok") return fail(401, verdict);

  let user;
  try {
    user = await resolveUserForOtp(email);
  } catch {
    // The account changed between code issue and verify (deactivated, switched
    // to Entra). The code was already consumed; refuse the session.
    return fail(401, "not_provisioned");
  }

  const token = await createSessionToken({
    sub: user.id, email: user.email, name: user.name,
    ext: user.externalSubject ?? `pending:${email}`, amr: "otp",
  });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": sessionSetCookie(token) },
  });
}
