import type { PulseIdentity } from "@/lib/domain";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";
import { requireActiveAccount } from "./active-account";

export async function requireMembership(
  identity: PulseIdentity,
  organizationId = identity.organizationId,
) {
  await requireActiveAccount(identity);
  if (!isAzureSqlConfigured())
    return {
      role: identity.role,
      organizationType: identity.isInternal ? "Internal" : "Customer",
    };
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, identity.id)
    .input("organizationId", sql.NVarChar(32), organizationId || null)
    .query(
      "SELECT m.organization_id organizationId,m.role,o.type organizationType,o.allowed_auth_methods allowedAuth FROM dbo.Memberships m JOIN dbo.Organizations o ON o.id=m.organization_id WHERE m.user_id=@userId AND (@organizationId IS NULL OR m.organization_id=@organizationId) AND m.status='Active' AND o.status<>'Inactive' ORDER BY o.name",
    );
  if (!result.recordset.length) throw new Error("FORBIDDEN");
  if (!organizationId && result.recordset.length > 1)
    throw new Error("INVALID_ACTIVE_ORGANIZATION_REQUIRED");
  const method =
    identity.authMethod === "otp"
      ? "OTP"
      : identity.authMethod === "entra"
        ? "Entra ID"
        : null;
  if (
    method &&
    !JSON.parse(result.recordset[0].allowedAuth || "[]").includes(method)
  )
    throw new Error("FORBIDDEN");
  identity.organizationId = result.recordset[0].organizationId;
  return result.recordset[0];
}

export async function requireInternalRole(
  identity: PulseIdentity,
  roles = ["Internal contributor", "Product manager", "System admin"],
) {
  await requireActiveAccount(identity);
  if (!isAzureSqlConfigured()) {
    if (!identity.isInternal) throw new Error("FORBIDDEN");
    if (!roles.includes(identity.role)) throw new Error("FORBIDDEN");
    return identity.role;
  }
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, identity.id)
    .query(
      "SELECT m.role,o.allowed_auth_methods allowedAuth FROM dbo.Memberships m JOIN dbo.Organizations o ON o.id=m.organization_id WHERE m.user_id=@userId AND m.status='Active' AND o.type='Internal' AND o.status='Active'",
    );
  const method =
    identity.authMethod === "otp"
      ? "OTP"
      : identity.authMethod === "entra"
        ? "Entra ID"
        : null;
  const membership = result.recordset.find(
    (row) =>
      roles.includes(row.role) &&
      (!method || JSON.parse(row.allowedAuth || "[]").includes(method)),
  );
  if (!membership) throw new Error("FORBIDDEN");
  return membership.role as string;
}

export async function requirePublishRole(identity: PulseIdentity) {
  return requireInternalRole(identity, ["Product manager", "System admin"]);
}
