import { getSqlPool, isAzureSqlConfigured, sql } from "./database";
import type { DataCentralLaunch } from "./datacentral";
import type { UserRecord } from "./admin-repository";

export type ProvisionedUser = {
  id: string;
  email: string;
  name: string;
  status: string;
  externalSubject: string | null;
};

// Same in-memory store admin-repository.ts seeds (globalThis.pulseMemoryUsers is
// declared there). The seed literal is duplicated here rather than imported so
// this module never has to route through admin-repository's assertAdmin gate —
// the `||=` guard means whichever module touches the store first wins and the
// other's guard is a no-op.
function memoryUsers(): UserRecord[] {
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

function toProvisioned(user: UserRecord): ProvisionedUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    externalSubject: user.externalSubject ?? null,
  };
}

function assertActive(user: UserRecord) {
  if (user.status !== "Active") throw new Error("USER_DISABLED");
}

const SELECT_COLUMNS =
  "CAST(id AS nvarchar(36)) id, email, display_name name, status, external_subject externalSubject";

// ---------------------------------------------------------------------------
// resolveUserForEntra
// ---------------------------------------------------------------------------

export async function resolveUserForEntra(
  oid: string,
  tenantId: string,
  email: string,
  displayName: string,
): Promise<ProvisionedUser> {
  if (!isAzureSqlConfigured()) return resolveUserForEntraMemory(oid, email, displayName);
  return resolveUserForEntraSql(oid, tenantId, email);
}

// Memory mode has no entra_tenant_id column to stamp, so tenantId is not
// threaded through here — it only matters for the SQL-mode audit trail.
function resolveUserForEntraMemory(
  oid: string,
  email: string,
  displayName: string,
): ProvisionedUser {
  const store = memoryUsers();
  const normalizedOid = oid.toLowerCase();
  const normalizedEmail = email.toLowerCase();

  // ① real oid already claimed
  let user = store.find((u) => u.externalSubject?.toLowerCase() === normalizedOid);

  // ② legacy convention: Users.id === Entra oid (pre-migration/pre-backfill rows)
  if (!user) user = store.find((u) => u.id.toLowerCase() === normalizedOid);

  if (user) {
    assertActive(user);
    user.externalSubject = oid;
    return toProvisioned(user);
  }

  // ③ email match — claim/upgrade a placeholder subject, refuse to rebind a real one
  user = store.find((u) => u.email.toLowerCase() === normalizedEmail);
  if (user) {
    assertActive(user);
    const subject = user.externalSubject;
    const claimable = !subject || subject.startsWith("pending:") || subject.startsWith("dc:");
    if (!claimable && subject !== oid) throw new Error("NOT_PROVISIONED");
    user.externalSubject = oid;
    return toProvisioned(user);
  }

  if (process.env.PULSE_ALLOW_DEMO_IDENTITY === "true") {
    const created: UserRecord = {
      id: crypto.randomUUID(),
      name: displayName,
      email,
      status: "Active",
      authentication: "Entra ID",
      externalSubject: oid,
      memberships: [],
    };
    store.push(created);
    return toProvisioned(created);
  }

  throw new Error("NOT_PROVISIONED");
}

async function resolveUserForEntraSql(
  oid: string,
  tenantId: string,
  email: string,
): Promise<ProvisionedUser> {
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    let row = (
      await new sql.Request(transaction)
        .input("oid", sql.NVarChar(128), oid)
        .query(`SELECT ${SELECT_COLUMNS} FROM dbo.Users WITH (UPDLOCK) WHERE external_subject=@oid`)
    ).recordset[0];

    // legacy convention: Users.id === Entra oid
    if (!row) {
      row = (
        await new sql.Request(transaction)
          .input("oid", sql.NVarChar(128), oid)
          .query(
            `SELECT ${SELECT_COLUMNS} FROM dbo.Users WITH (UPDLOCK) WHERE id = TRY_CONVERT(uniqueidentifier, @oid)`,
          )
      ).recordset[0];
    }

    if (!row) {
      const candidate = (
        await new sql.Request(transaction)
          .input("email", sql.NVarChar(320), email)
          .query(`SELECT ${SELECT_COLUMNS} FROM dbo.Users WITH (UPDLOCK) WHERE email=@email`)
      ).recordset[0];
      if (candidate) {
        const subject: string | null = candidate.externalSubject;
        const claimable = !subject || subject.startsWith("pending:") || subject.startsWith("dc:");
        if (!claimable && subject !== oid) throw new Error("NOT_PROVISIONED");
        row = candidate;
      }
    }

    if (!row) throw new Error("NOT_PROVISIONED");
    if (row.status !== "Active") throw new Error("USER_DISABLED");

    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, row.id)
      .input("oid", sql.NVarChar(128), oid)
      .input("tenantId", sql.NVarChar(64), tenantId)
      .query(
        "UPDATE dbo.Users SET external_subject=@oid, entra_tenant_id=@tenantId, last_login_at=SYSUTCDATETIME(), last_login_method='entra' WHERE id=@id",
      );
    await transaction.commit();
    return { id: row.id, email: row.email, name: row.name, status: row.status, externalSubject: oid };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// resolveUserForDcLaunch
// ---------------------------------------------------------------------------

export async function resolveUserForDcLaunch(
  launch: DataCentralLaunch,
): Promise<ProvisionedUser> {
  if (!isAzureSqlConfigured()) return resolveUserForDcLaunchMemory(launch);
  return resolveUserForDcLaunchSql(launch);
}

function resolveUserForDcLaunchMemory(launch: DataCentralLaunch): ProvisionedUser {
  const store = memoryUsers();
  const subject = `dc:${launch.userId}`;
  const email = (launch.userEmail ?? launch.userName).toLowerCase();

  // ① subject already claimed
  let user = store.find((u) => u.externalSubject === subject);
  if (user) {
    assertActive(user);
    return toProvisioned(user);
  }

  // ② email match
  user = store.find((u) => u.email.toLowerCase() === email);
  if (user) {
    assertActive(user);
    const existing = user.externalSubject;
    if (!existing || existing.startsWith("pending:")) {
      user.externalSubject = subject;
    } else if (existing.startsWith("dc:")) {
      if (existing !== subject) throw new Error("NOT_PROVISIONED");
    }
    // else: a real Entra oid — sign in without touching the subject.
    return toProvisioned(user);
  }

  if (process.env.PULSE_ALLOW_DEMO_IDENTITY === "true") {
    const created: UserRecord = {
      id: crypto.randomUUID(),
      name: launch.userDisplayName,
      email: launch.userEmail ?? launch.userName,
      status: "Active",
      authentication: "OTP",
      externalSubject: subject,
      memberships: [],
    };
    store.push(created);
    return toProvisioned(created);
  }

  throw new Error("NOT_PROVISIONED");
}

async function resolveUserForDcLaunchSql(launch: DataCentralLaunch): Promise<ProvisionedUser> {
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const subject = `dc:${launch.userId}`;
    const email = launch.userEmail ?? launch.userName;

    let row = (
      await new sql.Request(transaction)
        .input("subject", sql.NVarChar(128), subject)
        .query(`SELECT ${SELECT_COLUMNS} FROM dbo.Users WITH (UPDLOCK) WHERE external_subject=@subject`)
    ).recordset[0];

    let shouldStampSubject = false;
    if (!row) {
      const candidate = (
        await new sql.Request(transaction)
          .input("email", sql.NVarChar(320), email)
          .query(`SELECT ${SELECT_COLUMNS} FROM dbo.Users WITH (UPDLOCK) WHERE email=@email`)
      ).recordset[0];
      if (candidate) {
        const existing: string | null = candidate.externalSubject;
        if (!existing || existing.startsWith("pending:")) {
          shouldStampSubject = true;
        } else if (existing.startsWith("dc:")) {
          if (existing !== subject) throw new Error("NOT_PROVISIONED");
        }
        // else: a real Entra oid (including every backfilled legacy row) —
        // sign in without touching the subject.
        row = candidate;
      }
    }

    if (!row) throw new Error("NOT_PROVISIONED");
    if (row.status !== "Active") throw new Error("USER_DISABLED");

    if (shouldStampSubject) {
      await new sql.Request(transaction)
        .input("id", sql.UniqueIdentifier, row.id)
        .input("subject", sql.NVarChar(128), subject)
        .query(
          "UPDATE dbo.Users SET external_subject=@subject, last_login_at=SYSUTCDATETIME(), last_login_method='dc-hmac' WHERE id=@id",
        );
      row.externalSubject = subject;
    } else {
      await new sql.Request(transaction)
        .input("id", sql.UniqueIdentifier, row.id)
        .query("UPDATE dbo.Users SET last_login_at=SYSUTCDATETIME(), last_login_method='dc-hmac' WHERE id=@id");
    }
    await transaction.commit();
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      status: row.status,
      externalSubject: row.externalSubject,
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
