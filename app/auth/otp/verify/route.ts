import { readJson, parseInput, otpVerifySchema } from "@/lib/server/validation";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { verifyOtpCode } from "@/lib/server/otp-login";
import { resolveUserForOtp } from "@/lib/server/user-directory";
import { createSessionToken, sessionSetCookie } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const fail = (status: number, error: string) =>
  Response.json({ error }, { status });

// Exchanges e-mail + code for a Pulse session (amr: "otp"). Same inline
// same-origin guard as /dc-auth and /auth/otp/start.
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  let originMismatch = false;
  if (origin) {
    try {
      originMismatch = new URL(origin).host !== request.headers.get("host");
    } catch {
      originMismatch = true;
    }
  }
  if (originMismatch || request.headers.get("sec-fetch-site") === "cross-site")
    return fail(403, "cross_site_rejected");

  let credentials;
  try {
    await enforceRateLimit(request, "otp", 20);
    credentials = parseInput(otpVerifySchema, await readJson(request, 2048));
  } catch (error) {
    return fail(
      error instanceof Error && error.message === "RATE_LIMITED" ? 429 : 400,
      "invalid_request",
    );
  }
  const { email, code } = credentials;

  let verdict;
  try {
    verdict = await verifyOtpCode(email, code);
  } catch {
    return fail(503, "temporarily_unavailable");
  }
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
    sub: user.id,
    email: user.email,
    name: user.name,
    ext: user.externalSubject ?? `pending:${email}`,
    amr: "otp",
  });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": sessionSetCookie(token),
    },
  });
}
