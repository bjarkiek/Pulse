import { getCurrentUser } from "@/lib/server/current-user";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const current = await getCurrentUser(request);
    const response = json(
      {
        user: {
          id: current.userId,
          email: current.email,
          name: current.name,
          locale: current.locale,
        },
        organizations: current.memberships,
        activeOrganizationId: current.activeOrganizationId,
        authMethod: current.authMethod,
        dcEmbed: current.dcEmbed,
        isVerified: current.isVerified,
      },
      {},
      id,
    );
    if (current.activeOrganizationId) {
      const prod = process.env.NODE_ENV === "production";
      response.cookies.set("pulse-organization", current.activeOrganizationId, {
        httpOnly: true,
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
        // Lax cookies are withheld inside a cross-site DataCentral iframe in
        // production, so switch to the CHIPS-partitioned None/Secure form there.
        ...(prod
          ? { sameSite: "none" as const, secure: true, partitioned: true }
          : { sameSite: "lax" as const, secure: false }),
      });
    }
    return response;
  } catch (error) {
    return apiError(error, id);
  }
}
