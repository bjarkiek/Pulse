import { EmailClient } from "@azure/communication-email";
import { DefaultAzureCredential } from "@azure/identity";
import { issueOtpCode } from "@/lib/server/otp-login";
import { resolveUserForOtp } from "@/lib/server/user-directory";

export const dynamic = "force-dynamic";

const fail = (status: number, error: string) => Response.json({ error }, { status });

// Requests a sign-in code for an e-mail. Anonymous by design (it IS the entry
// point), so it carries the same inline same-origin guard as /dc-auth, and it
// never reveals whether an account exists: unknown or non-OTP e-mails get the
// same success response, just without a code being issued or sent.
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  let originMismatch = false;
  if (origin) {
    try { originMismatch = new URL(origin).host !== request.headers.get("host"); }
    catch { originMismatch = true; }
  }
  if (originMismatch || request.headers.get("sec-fetch-site") === "cross-site")
    return fail(403, "cross_site_rejected");

  const body = (await request.json().catch(() => ({}))) as { email?: string };
  const email = body.email?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(400, "invalid_email");

  const endpoint = process.env.AZURE_COMMUNICATION_EMAIL_ENDPOINT;
  const sender = process.env.AZURE_COMMUNICATION_EMAIL_SENDER;
  const emailConfigured = Boolean(endpoint && sender);
  if (!emailConfigured && process.env.NODE_ENV === "production")
    return fail(503, "otp_unavailable");

  // Only Active, OTP-designated users get a code — but respond identically
  // either way (anti-enumeration).
  try {
    await resolveUserForOtp(email);
  } catch {
    return Response.json({ ok: true });
  }

  let code: string;
  try {
    ({ code } = await issueOtpCode(email));
  } catch (e) {
    if (e instanceof Error && e.message === "RATE_LIMITED") return fail(429, "rate_limited");
    throw e;
  }

  if (emailConfigured) {
    const client = new EmailClient(endpoint!, new DefaultAzureCredential());
    await client.beginSend({
      senderAddress: sender!,
      content: {
        subject: `${code} — Pulse sign-in code / innskráningarkóði`,
        plainText:
          `Your DataCentral Pulse sign-in code is: ${code}\n` +
          `It expires in 10 minutes. If you did not request it, ignore this e-mail.\n\n` +
          `Innskráningarkóðinn þinn fyrir DataCentral Pulse er: ${code}\n` +
          `Hann rennur út eftir 10 mínútur. Hafir þú ekki beðið um kóðann máttu hunsa þennan póst.`,
      },
      recipients: { to: [{ address: email }] },
    });
  } else {
    // Dev/local convenience only — production returns 503 above.
    console.log(JSON.stringify({ level: "info", route: "/auth/otp/start", devCode: code, email }));
  }
  return Response.json({ ok: true });
}
