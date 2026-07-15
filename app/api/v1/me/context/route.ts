import { getIdentity } from "@/lib/server/auth";
import { requireMembership } from "@/lib/server/authorization";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await getIdentity(request);
    const body = await request.json();
    await requireMembership(identity, body.organizationId);
    const response = json(
      { activeOrganizationId: body.organizationId },
      {},
      id,
    );
    const prod = process.env.NODE_ENV === "production";
    response.cookies.set("pulse-organization", body.organizationId, {
      httpOnly: true,
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
      // Lax cookies are withheld inside a cross-site DataCentral iframe in
      // production, so switch to the CHIPS-partitioned None/Secure form there.
      ...(prod
        ? { sameSite: "none" as const, secure: true, partitioned: true }
        : { sameSite: "lax" as const, secure: false }),
    });
    return response;
  } catch (error) {
    return apiError(error, id);
  }
}
