import { verifyDcLaunch, checkDcSession, DC_ONBOARD_ROLE } from "@/lib/server/datacentral";
import { validateGraphToken } from "@/lib/server/graph-validate";
import { resolveUserForDcLaunch, resolveUserForEntra } from "@/lib/server/user-directory";
import { createSessionToken, sessionSetCookie } from "@/lib/server/session";

type Body = { dcData?: string; dcSig?: string; accessToken?: string; graphToken?: string; aadToken?: string };

const fail = (status: number, error: string) => Response.json({ error }, { status });

function provisioningError(e: unknown): Response | null {
  const code = e instanceof Error ? e.message : "";
  if (code === "NOT_PROVISIONED") return fail(403, "not_provisioned");
  if (code === "USER_DISABLED") return fail(403, "disabled");
  return null;
}

// The credential entry point for embedded sessions. Anonymous by design.
// NOTE: Task 8's proxy short-circuits /dc-auth BEFORE its /api CSRF block, so this
// handler carries its own inline same-origin guard (the /dc-embed fetch is genuinely
// same-origin — Origin is the app origin even inside the DataCentral iframe — so the
// guard is transparent to the legitimate flow while blocking cross-site login-CSRF).
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  const secFetchSite = request.headers.get("sec-fetch-site");
  if ((origin && new URL(origin).host !== new URL(request.url).host) ||
      secFetchSite === "cross-site")
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
    // DC_SESSION_CHECK: "off" | "when-available" (default) | "required".
    // "required" closes the launch-URL replay window by refusing HMAC-only posts
    // that carry no accessToken to corroborate against the live DataCentral session.
    if (process.env.DC_SESSION_CHECK === "required" && !body.accessToken)
      return fail(401, "session_invalid");
    if (process.env.DC_SESSION_CHECK !== "off" && body.accessToken) {
      const err = await checkDcSession(launch, body.accessToken);
      if (err) return fail(401, err);
    }
    let user;
    try { user = await resolveUserForDcLaunch(launch); }
    catch (e) { const r = provisioningError(e); if (r) return r; throw e; }
    const token = await createSessionToken({
      sub: user.id, email: user.email, name: user.name,
      ext: user.externalSubject ?? `dc:${launch.userId}`, amr: "dc-hmac", dc_embed: true,
      // Embedded sessions only get onboarding tours when the signed launch
      // carried the DataCentral "Onboard" role (DataCentralEmbedOnboardingTours.md §7).
      ...(launch.roleDisplayNames?.includes(DC_ONBOARD_ROLE) ? { dc_onboard: true as const } : {}),
    });
    return new Response(JSON.stringify({ ok: true }), {
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
    catch (e) { const r = provisioningError(e); if (r) return r; throw e; }
    const token = await createSessionToken({
      sub: user.id, email: user.email, name: user.name,
      ext: id.oid, amr: "dc-graph", dc_embed: true, tid: id.tid,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": sessionSetCookie(token) },
    });
  }

  return fail(400, "missing_credentials");
}
