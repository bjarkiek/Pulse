import { getIdentity } from "@/lib/server/auth";
import { requireMembership } from "@/lib/server/authorization";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = getIdentity(request);
    const body = await request.json();
    await requireMembership(identity, body.organizationId);
    const response = json(
      { activeOrganizationId: body.organizationId },
      {},
      id,
    );
    response.cookies.set("pulse-organization", body.organizationId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  } catch (error) {
    return apiError(error, id);
  }
}
