import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { getIdentityContext } from "@/lib/server/identity-repository";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const context = await getIdentityContext(getIdentity(request));
    const response = json(context, {}, id);
    if (context.activeOrganizationId)
      response.cookies.set("pulse-organization", context.activeOrganizationId, {
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
