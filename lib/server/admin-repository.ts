import type { PulseIdentity } from "@/lib/domain";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";

export type OrganizationRecord = {
  id: string;
  name: string;
  type: "Customer" | "Partner" | "Internal";
  status: "Active" | "Onboarding" | "Inactive";
  domain: string;
  users: number;
  requests: number;
  authentication: ("OTP" | "Entra ID")[];
};
export type UserRecord = {
  id: string;
  name: string;
  email: string;
  status: "Active" | "Invited" | "Suspended";
  authentication: "OTP" | "Entra ID";
  externalSubject?: string | null;
  memberships: Array<{
    companyId: string;
    role: "Company admin" | "Requester" | "Viewer" | "Product manager";
  }>;
};
declare global {
  var pulseMemoryOrganizations: OrganizationRecord[] | undefined;
  var pulseMemoryUsers: UserRecord[] | undefined;
}
function organizations() {
  globalThis.pulseMemoryOrganizations ||= [
    {
      id: "ORG-001",
      name: "Origo",
      type: "Customer",
      status: "Active",
      domain: "origo.is",
      users: 2,
      requests: 14,
      authentication: ["OTP", "Entra ID"],
    },
  ];
  return globalThis.pulseMemoryOrganizations;
}
export function users() {
  globalThis.pulseMemoryUsers ||= [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Bjarki Kristjánsson",
      email: "bjarki@uidata.com",
      status: "Active",
      authentication: "Entra ID",
      memberships: [{ companyId: "ORG-001", role: "Company admin" }],
    },
  ];
  return globalThis.pulseMemoryUsers;
}
async function assertAdmin(identity: PulseIdentity) {
  if (!isAzureSqlConfigured()) {
    if (!identity.isInternal) throw new Error("FORBIDDEN");
    return;
  }
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, identity.id)
    .query(
      "SELECT TOP (1) 1 allowed FROM dbo.Memberships m JOIN dbo.Organizations o ON o.id=m.organization_id WHERE m.user_id=@userId AND m.status='Active' AND o.type='Internal' AND m.role='System admin'",
    );
  if (!result.recordset.length) throw new Error("FORBIDDEN");
}
export async function listOrganizations(identity: PulseIdentity) {
  await assertAdmin(identity);
  if (!isAzureSqlConfigured()) return organizations();
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .query(
      "SELECT o.id,o.name,o.type,o.status,COALESCE(o.verified_domain,'') domain,o.allowed_auth_methods authenticationJson,COUNT(DISTINCT m.user_id) users,COUNT(DISTINCT r.id) requests FROM dbo.Organizations o LEFT JOIN dbo.Memberships m ON m.organization_id=o.id AND m.status='Active' LEFT JOIN dbo.Requests r ON r.organization_id=o.id AND r.deleted_at IS NULL GROUP BY o.id,o.name,o.type,o.status,o.verified_domain,o.allowed_auth_methods ORDER BY o.name",
    );
  return result.recordset.map((row) => ({
    ...row,
    authentication: JSON.parse(row.authenticationJson || '["OTP","Entra ID"]'),
    authenticationJson: undefined,
  }));
}
export async function saveOrganization(
  identity: PulseIdentity,
  item: OrganizationRecord,
) {
  await assertAdmin(identity);
  if (!item.name.trim() || !item.domain.trim() || !item.authentication.length)
    throw new Error("INVALID_ORGANIZATION");
  if (!isAzureSqlConfigured()) {
    const found = organizations().findIndex((value) => value.id === item.id);
    if (found >= 0) organizations()[found] = item;
    else organizations().push(item);
    globalThis.pulseMemoryAudit ||= [];
    globalThis.pulseMemoryAudit.unshift({
      id: crypto.randomUUID(),
      actor: identity.name,
      organizationId: item.id,
      action: "organization.saved",
      entityType: "Organization",
      after: item,
      correlationId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    return item;
  }
  const pool = await getSqlPool();
  await pool
    .request()
    .input("id", sql.NVarChar(32), item.id)
    .input("name", sql.NVarChar(200), item.name)
    .input("type", sql.NVarChar(32), item.type)
    .input("status", sql.NVarChar(32), item.status)
    .input("domain", sql.NVarChar(255), item.domain)
    .input(
      "authentication",
      sql.NVarChar(100),
      JSON.stringify(item.authentication),
    )
    .query(
      "MERGE dbo.Organizations target USING(SELECT @id id) source ON target.id=source.id WHEN MATCHED THEN UPDATE SET name=@name,type=@type,status=@status,verified_domain=@domain,allowed_auth_methods=@authentication,updated_at=SYSUTCDATETIME() WHEN NOT MATCHED THEN INSERT(id,name,type,status,verified_domain,allowed_auth_methods) VALUES(@id,@name,@type,@status,@domain,@authentication);",
    );
  await pool
    .request()
    .input("auditId", sql.UniqueIdentifier, crypto.randomUUID())
    .input("actor", sql.UniqueIdentifier, identity.id)
    .input("organizationId", sql.NVarChar(32), item.id)
    .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
    .input("after", sql.NVarChar(sql.MAX), JSON.stringify(item))
    .query(
      "INSERT dbo.AuditEvents(id,actor_user_id,organization_id,action,entity_type,after_json,correlation_id) VALUES(@auditId,@actor,@organizationId,'organization.saved','Organization',@after,@correlation)",
    );
  return item;
}
export async function listUsers(identity: PulseIdentity) {
  await assertAdmin(identity);
  if (!isAzureSqlConfigured()) return users();
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .query(
      "SELECT CAST(u.id AS nvarchar(36)) id,u.display_name name,u.email,u.status,u.auth_method authentication,m.organization_id companyId,m.role FROM dbo.Users u LEFT JOIN dbo.Memberships m ON m.user_id=u.id AND m.status='Active' ORDER BY u.display_name",
    );
  const map = new Map<string, UserRecord>();
  for (const row of result.recordset) {
    const item: UserRecord = map.get(row.id) || {
      id: row.id,
      name: row.name,
      email: row.email,
      status: row.status,
      authentication: row.authentication,
      memberships: [],
    };
    if (row.companyId)
      item.memberships.push({ companyId: row.companyId, role: row.role });
    map.set(row.id, item);
  }
  return [...map.values()];
}
export async function saveUser(identity: PulseIdentity, item: UserRecord) {
  await assertAdmin(identity);
  if (!item.email.trim() || !item.name.trim() || !item.memberships.length)
    throw new Error("INVALID_USER");
  const id = /^[0-9a-f-]{36}$/i.test(item.id) ? item.id : crypto.randomUUID();
  const saved = { ...item, id };
  if (!isAzureSqlConfigured()) {
    const found = users().findIndex(
      (value) => value.id === id || value.email === item.email,
    );
    // New users have no real identity yet: stamp a 'pending:' placeholder
    // subject so the DataCentral/Entra resolvers can later claim this row by
    // email. Existing users keep whatever subject they already have (never
    // overwrite a real identity link with the caller-supplied payload).
    saved.externalSubject =
      found >= 0 ? users()[found].externalSubject : `pending:${item.email.toLowerCase()}`;
    if (found >= 0) users()[found] = saved;
    else users().push(saved);
    globalThis.pulseMemoryAudit ||= [];
    globalThis.pulseMemoryAudit.unshift({
      id: crypto.randomUUID(),
      actor: identity.name,
      organizationId: identity.organizationId,
      action: "user.memberships.saved",
      entityType: "User",
      entityId: id,
      after: saved,
      correlationId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    return saved;
  }
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    // A new row has no real identity yet, so it gets a 'pending:{email}'
    // placeholder subject; an existing row's external_subject is left
    // untouched here (the identity resolvers own that column from then on).
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, id)
      .input("name", sql.NVarChar(200), item.name)
      .input("email", sql.NVarChar(320), item.email)
      .input("status", sql.NVarChar(32), item.status)
      .input("auth", sql.NVarChar(32), item.authentication)
      .input("pendingSubject", sql.NVarChar(128), `pending:${item.email.toLowerCase()}`)
      .query(
        "MERGE dbo.Users target USING(SELECT @id id) source ON target.id=source.id WHEN MATCHED THEN UPDATE SET display_name=@name,email=@email,status=@status,auth_method=@auth,updated_at=SYSUTCDATETIME() WHEN NOT MATCHED THEN INSERT(id,email,display_name,status,auth_method,external_subject) VALUES(@id,@email,@name,@status,@auth,@pendingSubject);",
      );
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, id)
      .query(
        "UPDATE dbo.Memberships SET status='Inactive',updated_at=SYSUTCDATETIME() WHERE user_id=@id",
      );
    for (const membership of item.memberships)
      await new sql.Request(transaction)
        .input("membershipId", sql.UniqueIdentifier, crypto.randomUUID())
        .input("userId", sql.UniqueIdentifier, id)
        .input("organizationId", sql.NVarChar(32), membership.companyId)
        .input("role", sql.NVarChar(64), membership.role)
        .query(
          "MERGE dbo.Memberships target USING(SELECT @userId user_id,@organizationId organization_id) source ON target.user_id=source.user_id AND target.organization_id=source.organization_id WHEN MATCHED THEN UPDATE SET role=@role,status='Active',updated_at=SYSUTCDATETIME() WHEN NOT MATCHED THEN INSERT(id,user_id,organization_id,role,status) VALUES(@membershipId,@userId,@organizationId,@role,'Active');",
        );
    await new sql.Request(transaction)
      .input("auditId", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("entity", sql.UniqueIdentifier, id)
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .input(
        "after",
        sql.NVarChar(sql.MAX),
        JSON.stringify({
          status: item.status,
          authentication: item.authentication,
          memberships: item.memberships,
        }),
      )
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@auditId,@actor,'user.memberships.saved','User',@entity,@after,@correlation)",
      );
    await transaction.commit();
    return saved;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
