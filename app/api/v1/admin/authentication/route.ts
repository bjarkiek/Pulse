import { getIdentity } from "@/lib/server/auth";
import { requireInternalRole } from "@/lib/server/authorization";
import { isEntraConfigured } from "@/lib/server/entra-oidc";
import { apiError, correlationId, json } from "@/lib/server/http";

// What the Authentication page shows System admins about the identity providers.
// Entra ID is configured through the App Service settings (Bicep parameters
// entraClientId / entraTenantId / entraClientSecret), never through the UI; the
// client and tenant ids are public identifiers, the secret is never returned.
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await getIdentity(request);
    await requireInternalRole(identity, ["System admin"]);
    return json(
      {
        item: {
          entra: {
            configured: isEntraConfigured(),
            clientId: process.env.AUTH_ENTRA_CLIENT_ID || null,
            tenantId: process.env.AUTH_ENTRA_TENANT_ID || null,
          },
          otp: {
            emailSenderConfigured: Boolean(
              process.env.AZURE_COMMUNICATION_EMAIL_ENDPOINT &&
                process.env.AZURE_COMMUNICATION_EMAIL_SENDER,
            ),
          },
        },
      },
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}
