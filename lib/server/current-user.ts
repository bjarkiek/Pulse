import { getIdentity } from "@/lib/server/auth";
import { getIdentityContext } from "@/lib/server/identity-repository";
import type { PulseIdentity } from "@/lib/domain";

export type CurrentUser = {
  identity: PulseIdentity;
  userId: string;
  email: string;
  name: string;
  locale: string;
  authMethod: NonNullable<PulseIdentity["authMethod"]>;
  isVerified: boolean;
  dcEmbed: boolean;
  activeOrganizationId: string | null;
  memberships: Awaited<ReturnType<typeof getIdentityContext>>["organizations"];
};

// Convenience wrapper merging getIdentity + getIdentityContext, used by the
// /api/v1/me route which needs authMethod/dcEmbed/isVerified alongside the
// membership context. Other routes should keep calling getIdentity and
// getIdentityContext directly — this is not a mandatory chokepoint.
export async function getCurrentUser(request: Request): Promise<CurrentUser> {
  const identity = await getIdentity(request);
  const context = await getIdentityContext(identity);
  return {
    identity: {
      ...identity,
      organizationId: context.activeOrganizationId ?? identity.organizationId,
    },
    userId: identity.id,
    email: context.user.email,
    name: context.user.name,
    locale: context.user.locale,
    authMethod: identity.authMethod ?? "dev",
    isVerified: identity.isVerified ?? false,
    dcEmbed: identity.dcEmbed ?? false,
    activeOrganizationId: context.activeOrganizationId,
    memberships: context.organizations,
  };
}
