import type { PulseIdentity } from "@/lib/domain";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";

export type MembershipContext = {
  id: string;
  name: string;
  type: string;
  role: string;
  active: boolean;
};

export async function getIdentityContext(identity: PulseIdentity) {
  if (!isAzureSqlConfigured())
    return {
      user: {
        id: identity.id,
        email: identity.email,
        name: identity.name,
        locale: "en",
      },
      organizations: [
        {
          id: "ORG-001",
          name: "Origo",
          type: "Customer",
          role: identity.role,
          active: true,
        },
      ],
      activeOrganizationId: identity.organizationId || "ORG-001",
    };
  const pool = await getSqlPool();
  const user = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, identity.id)
    .query(
      "SELECT CAST(id AS nvarchar(36)) id,email,display_name name,locale,status FROM dbo.Users WHERE id=@userId",
    );
  if (!user.recordset.length || user.recordset[0].status !== "Active")
    throw new Error("FORBIDDEN");
  const memberships = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, identity.id)
    .query(
      "SELECT o.id,o.name,o.type,m.role FROM dbo.Memberships m JOIN dbo.Organizations o ON o.id=m.organization_id WHERE m.user_id=@userId AND m.status='Active' AND o.status<>'Inactive' ORDER BY o.name",
    );
  if (!memberships.recordset.length) throw new Error("FORBIDDEN");
  const authorized = memberships.recordset.some(
    (membership) => membership.id === identity.organizationId,
  );
  const activeOrganizationId = authorized
    ? identity.organizationId
    : memberships.recordset.length === 1
      ? memberships.recordset[0].id
      : null;
  return {
    user: user.recordset[0],
    organizations: memberships.recordset.map((membership) => ({
      ...membership,
      active: membership.id === activeOrganizationId,
    })),
    activeOrganizationId,
  };
}
