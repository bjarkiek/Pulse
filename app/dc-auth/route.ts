import { verifyDcLaunch, checkDcSession, isLaunchFresh, DC_ONBOARD_ROLE } from "@/lib/server/datacentral";
import { validateGraphToken } from "@/lib/server/graph-validate";
import { resolveUserForDcLaunch, resolveUserForEntra } from "@/lib/server/user-directory";
import { setUserLocaleById } from "@/lib/server/identity-repository";
import { createSessionToken, sessionSetCookie } from "@/lib/server/session";

type Body = { dcData?: string; dcSig?: string; accessToken?: string; graphToken?: string; aadToken?: string };

const fail = (status: number, error: string) => Response.json({ error }, { status });

function provisioningError(e: unknown, email?: string): Response | null {
  const code = e instanceof Error ? e.message : "";
  // Echo the attempted email on not_provisioned so the operator can see exactly
  // which identity to provision (seed-admin.ps1 / Users admin). No information
  // leak: the caller supplied that identity in its own credential material.
  if (code === "NOT_PROVISIONED")
    return Response.json({ error: "not_provisioned", ...(email ? { email } : {}) }, { status: 403 });
  if (code === "USER_DISABLED") return fail(403, "disabled");
  return null;
}

// The credential entry point for embedded sessions. Anonymous by design.
// NOTE: Task 8's proxy short-circuits /dc-auth BEFORE its /api CSRF block, so this
// handler carries its own inline same-origin guard (the /dc-embed fetch is genuinely
// same-origin — Origin is the app origin even inside the DataCentral iframe — so the
// guard is transparent to the legitimate flow while blocking cross-site login-CSRF).
export async function POST(request: Request): Promise<Response> {
  // Compare Origin to the Host header, NOT request.url: behind App Service TLS
  // termination request.url carries the internal http://localhost:3000 authority,
  // while the browser's Origin and the preserved Host header are both the public
  // host — so comparing against request.url 403s every legitimate embed login.
  // The genuine /dc-embed fetch is same-origin (Origin === Host). A malformed
  // Origin (e.g. the literal "null") makes new URL() throw — fail closed, not 500.
  const origin = request.headers.get("origin");
  const secFetchSite = request.headers.get("sec-fetch-site");
  let originMismatch = false;
  if (origin) {
    try { originMismatch = new URL(origin).host !== request.headers.get("host"); }
    catch { originMismatch = true; }
  }
  if (originMismatch || secFetchSite === "cross-site")
    return fail(403, "cross_site_rejected");

  let body: Body = {};
  try { body = await request.json(); } catch { /* fall through to header fallback */ }
  const dcData = body.dcData ?? request.headers.get("x-dc-data") ?? undefined;
  const dcSig = body.dcSig ?? request.headers.get("x-dc-sig") ?? undefined;
  const graph = body.graphToken ?? body.aadToken;

  // Path 1 (FIRST): signed dcdata — universal, covers Entra AND external/OTP users.
  if (dcData && dcSig && process.env.DC_APP_SECRET) {
    const launch = verifyDcLaunch(dcData, dcSig);
    if (!launch) return fail(401, "invalid_signature");
    // Signature valid but issued too long ago (or timestamp unreadable): the
    // launch-URL replay window is bounded — see isLaunchFresh.
    if (!isLaunchFresh(launch)) return fail(401, "stale_payload");
    // DC_SESSION_CHECK: "off" | "when-available" (default) | "required".
    // "required" closes the launch-URL replay window by refusing HMAC-only posts
    // that carry no accessToken to corroborate against the live DataCentral session.
    if (process.env.DC_SESSION_CHECK === "required" && !body.accessToken)
      return fail(401, "session_invalid");
    if (process.env.DC_SESSION_CHECK !== "off" && body.accessToken) {
      const err = await checkDcSession(launch, body.accessToken);
      // "when-available" is best-effort corroboration: an unreachable or
      // rejecting DataCentral API must not block a signature-verified launch —
      // the clientUrl may be a host this app can't reach, and an attacker could
      // simply omit accessToken to skip the check, so failing closed here adds
      // no security. Only a POSITIVE identity mismatch (the live session's user
      // differs from the signed payload's) rejects. "required" stays strict.
      if (err === "identity_mismatch") return fail(401, err);
      if (err && process.env.DC_SESSION_CHECK === "required") return fail(401, err);
    }
    let user;
    try { user = await resolveUserForDcLaunch(launch); }
    catch (e) { const r = provisioningError(e, launch.userEmail || launch.userName); if (r) return r; throw e; }
    // DataCentral's language setting carries into the user's locale on every
    // launch (the in-app toggle can override until the next launch). Only
    // known locales sync; failures never block sign-in.
    const lang = launch.language?.toLowerCase();
    const locale = lang?.startsWith("is") ? "is" : lang?.startsWith("en") ? "en" : null;
    if (locale) await setUserLocaleById(user.id, locale).catch(() => undefined);
    const token = await createSessionToken({
      sub: user.id, email: user.email, name: user.name,
      ext: user.externalSubject ?? `dc:${launch.userId}`, amr: "dc-hmac", dc_embed: true,
      // Embedded sessions only get onboarding tours when the signed launch
      // carried the DataCentral "Onboard" role (DataCentralEmbedOnboardingTours.md §7).
      ...(launch.roleDisplayNames?.includes(DC_ONBOARD_ROLE) ? { dc_onboard: true as const } : {}),
    });
    // The token travels BOTH ways: Set-Cookie for browsers that store it, and in
    // the body for the embed client to hold in sessionStorage and send as a
    // Bearer header — the path that survives third-party-cookie blocking.
    return new Response(JSON.stringify({ ok: true, token }), {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": sessionSetCookie(token) },
    });
  }

  // Path 2 (fallback): Graph token — Entra users only.
  if (graph) {
    const id = await validateGraphToken(graph);
    if (!id) return fail(401, "invalid_token");
    let user;
    try { user = await resolveUserForEntra(id.oid, id.tid, id.upn, id.displayName); }
    catch (e) { const r = provisioningError(e, id.upn); if (r) return r; throw e; }
    const token = await createSessionToken({
      sub: user.id, email: user.email, name: user.name,
      ext: id.oid, amr: "dc-graph", dc_embed: true, tid: id.tid,
    });
    return new Response(JSON.stringify({ ok: true, token }), {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": sessionSetCookie(token) },
    });
  }

  return fail(400, "missing_credentials");
}
