// Bridges the MCP authorization-code flow into Pulse's normal app sign-in:
// GET /oauth/authorize is a browser navigation, so instead of a 401 it must
// send an unauthenticated visitor through the existing /auth/login flow and
// let them land back on /oauth/authorize once a session exists. In dev (or
// with PULSE_ALLOW_DEMO_IDENTITY=true) getIdentity's demo fallback resolves a
// stable identity without any of this, so the redirect never fires locally.
import { getIdentity } from "../auth";
import type { PulseIdentity } from "@/lib/domain";

export async function requireBrowserIdentity(request: Request): Promise<PulseIdentity | Response> {
  try {
    return await getIdentity(request);
  } catch (e) {
    if (e instanceof Error && e.message === "UNAUTHORIZED") {
      const url = new URL(request.url);
      const returnUrl = url.pathname + url.search;
      return Response.redirect(`${url.origin}/auth/login?returnUrl=${encodeURIComponent(returnUrl)}`, 302);
    }
    throw e;
  }
}
