import type { PulseIdentity } from "@/lib/domain";
import {
  audienceMatches,
  TOUR_AUDIENCES,
  type OnboardingAdminPayload,
  type TourAudience,
  type TourPayload,
  type TourProgressItem,
  type TourSettingItem,
  type TourStatePayload,
  type TourStatus,
} from "@/lib/tours";
import { requireInternalRole } from "./authorization";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";
import {
  localizeSteps,
  pick,
  TOUR_CATALOG,
  tourStrings,
} from "./tour-catalog";

// Server side of the Driver.js onboarding kit (DataCentralEmbedOnboardingTours.md
// §5.5/§5.6): per-user eligibility + localized payloads, progress upserts with the
// review-driven invariants (Completed never downgrades, insert races retried),
// the per-user "hide forever" opt-out, and the System-admin settings/report surface.

const TOUR_STATUSES: TourStatus[] = ["InProgress", "Completed", "Dismissed"];

type TourSettingRow = {
  tourKey: string;
  enabled: boolean;
  audience: TourAudience;
  autoStart: boolean;
};

type TourProgressRow = TourProgressItem & {
  startedAt: string;
  completedAt: string | null;
};

declare global {
  var pulseMemoryOnboardingEnabled: boolean | undefined;
  var pulseMemoryTourSettings: TourSettingRow[] | undefined;
  var pulseMemoryTourProgress: TourProgressRow[] | undefined;
  var pulseMemoryTourOptOuts: Record<string, string> | undefined;
}

function memoryProgress() {
  globalThis.pulseMemoryTourProgress ||= [];
  return globalThis.pulseMemoryTourProgress;
}

function memoryOptOuts() {
  globalThis.pulseMemoryTourOptOuts ||= {};
  return globalThis.pulseMemoryTourOptOuts;
}

function pushMemoryAudit(
  identity: PulseIdentity,
  action: string,
  entityId: string | undefined,
  after: unknown,
) {
  globalThis.pulseMemoryAudit ||= [];
  globalThis.pulseMemoryAudit.unshift({
    id: crypto.randomUUID(),
    actor: identity.name,
    organizationId: identity.organizationId,
    action,
    entityType: "Onboarding",
    entityId,
    after,
    correlationId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });
}

// ---------- master switch (dbo.Settings key 'onboarding'; default ON when unset) ----------

export async function getOnboardingEnabled(): Promise<boolean> {
  if (!isAzureSqlConfigured())
    return globalThis.pulseMemoryOnboardingEnabled ?? true;
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("key", sql.NVarChar(100), "onboarding")
    .query("SELECT value_json value FROM dbo.Settings WHERE setting_key=@key");
  if (!result.recordset.length) return true;
  try {
    return JSON.parse(result.recordset[0].value)?.enabled !== false;
  } catch {
    return true;
  }
}

// ---------- per-tour settings (seeded lazily from the catalog) ----------

async function getSettingRows(): Promise<TourSettingRow[]> {
  if (!isAzureSqlConfigured()) {
    globalThis.pulseMemoryTourSettings ||= [];
    const rows = globalThis.pulseMemoryTourSettings;
    for (const def of TOUR_CATALOG)
      if (!rows.some((row) => row.tourKey === def.key))
        rows.push({
          tourKey: def.key,
          enabled: true,
          audience: def.defaultAudience,
          autoStart: def.defaultAutoStart,
        });
    return rows.map((row) => ({ ...row }));
  }
  const pool = await getSqlPool();
  const read = async () =>
    (
      await pool
        .request()
        .query(
          "SELECT tour_key tourKey,enabled,audience,auto_start autoStart FROM dbo.TourSettings",
        )
    ).recordset.map((row) => ({
      tourKey: row.tourKey as string,
      enabled: Boolean(row.enabled),
      audience: row.audience as TourAudience,
      autoStart: Boolean(row.autoStart),
    }));
  const rows = await read();
  const missing = TOUR_CATALOG.filter(
    (def) => !rows.some((row) => row.tourKey === def.key),
  );
  if (!missing.length) return rows;
  try {
    for (const def of missing)
      await pool
        .request()
        .input("key", sql.NVarChar(64), def.key)
        .input("audience", sql.NVarChar(32), def.defaultAudience)
        .input("autoStart", sql.Bit, def.defaultAutoStart)
        .query(
          "INSERT dbo.TourSettings(tour_key,enabled,audience,auto_start) VALUES(@key,1,@audience,@autoStart)",
        );
  } catch (error) {
    // another request seeded the same keys concurrently — theirs won (§5.6.2)
    if (!isDuplicateKeyError(error)) throw error;
  }
  return read();
}

function isDuplicateKeyError(error: unknown) {
  const number = (error as { number?: number })?.number;
  return number === 2627 || number === 2601;
}

// ---------- per-user access flags ----------

type TourAccess = {
  locale: string;
  toursHiddenAt: string | null;
  isInternal: boolean;
  isSystemAdmin: boolean;
};

async function getTourAccess(
  identity: PulseIdentity,
): Promise<TourAccess | null> {
  if (!isAzureSqlConfigured())
    return {
      locale: "en",
      toursHiddenAt: memoryOptOuts()[identity.id] ?? null,
      isInternal: identity.isInternal,
      isSystemAdmin: identity.isInternal && identity.role === "System admin",
    };
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, identity.id)
    .query(
      `SELECT u.locale, CONVERT(nvarchar(33), u.tours_hidden_at, 126) toursHiddenAt,
        (SELECT COUNT(*) FROM dbo.Memberships m JOIN dbo.Organizations o ON o.id=m.organization_id
          WHERE m.user_id=u.id AND m.status='Active' AND o.type='Internal' AND o.status='Active') internalCount,
        (SELECT COUNT(*) FROM dbo.Memberships m JOIN dbo.Organizations o ON o.id=m.organization_id
          WHERE m.user_id=u.id AND m.status='Active' AND o.type='Internal' AND o.status='Active' AND m.role='System admin') adminCount
      FROM dbo.Users u WHERE u.id=@userId AND u.status='Active'`,
    );
  if (!result.recordset.length) return null;
  const row = result.recordset[0];
  return {
    locale: row.locale || "en",
    toursHiddenAt: row.toursHiddenAt ?? null,
    isInternal: row.internalCount > 0,
    isSystemAdmin: row.adminCount > 0,
  };
}

// ---------- user-facing state ----------

export async function getTourState(
  identity: PulseIdentity,
): Promise<TourStatePayload> {
  const access = await getTourAccess(identity);
  const strings = tourStrings(access?.locale ?? "en");
  const suppressed =
    !access ||
    access.toursHiddenAt !== null ||
    !(await getOnboardingEnabled()) ||
    // DataCentral embeds: only sessions whose launch carried the "Onboard" role (§7)
    (Boolean(identity.dcEmbed) && !identity.dcOnboard);
  if (suppressed || !access) return { suppressed: true, tours: [], strings };

  const settings = await getSettingRows();
  const progress = await getProgressRows(identity.id);
  const tours: TourPayload[] = [];
  for (const def of TOUR_CATALOG) {
    const setting = settings.find((row) => row.tourKey === def.key);
    if (!setting?.enabled || !audienceMatches(setting.audience, access))
      continue;
    const row = progress.find((item) => item.tourKey === def.key);
    // a completed run of an older version counts as not-started when the tour re-offers
    const stale =
      row !== undefined && row.version < def.version && def.reofferOnNewVersion;
    const status = !row || stale ? "NotStarted" : row.status;
    tours.push({
      key: def.key,
      version: def.version,
      title: pick(def.title, access.locale),
      autoStart: setting.autoStart && status === "NotStarted",
      resumeAt: status === "InProgress" ? (row?.lastStepIndex ?? 0) : null,
      status,
      steps: localizeSteps(def, access.locale),
    });
  }
  return { suppressed: false, tours, strings };
}

async function getProgressRows(userId: string): Promise<TourProgressRow[]> {
  if (!isAzureSqlConfigured())
    return memoryProgress().filter((row) => row.userId === userId);
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .query(
      `SELECT CAST(user_id AS nvarchar(36)) userId,tour_key tourKey,version,status,
        last_step_index lastStepIndex,step_count stepCount,source,
        CONVERT(nvarchar(33), started_at, 126) startedAt,
        CONVERT(nvarchar(33), completed_at, 126) completedAt,
        CONVERT(nvarchar(33), updated_at, 126) updatedAt
      FROM dbo.TourProgress WHERE user_id=@userId`,
    );
  return result.recordset as TourProgressRow[];
}

// ---------- progress reporting ----------

export async function reportTourProgress(
  identity: PulseIdentity,
  input: {
    key?: unknown;
    version?: unknown;
    stepIndex?: unknown;
    stepCount?: unknown;
    status?: unknown;
  },
) {
  const key = String(input.key ?? "");
  if (!TOUR_CATALOG.some((def) => def.key === key)) return; // unknown key — ignore, don't store garbage
  const version = Number(input.version);
  const stepIndex = Number(input.stepIndex);
  const stepCount = Number(input.stepCount);
  const status = input.status as TourStatus;
  if (
    !Number.isInteger(version) ||
    !Number.isInteger(stepIndex) ||
    !Number.isInteger(stepCount) ||
    version < 1 ||
    stepIndex < 0 ||
    stepCount < 1 ||
    stepCount > 100 ||
    stepIndex >= stepCount ||
    !TOUR_STATUSES.includes(status)
  )
    throw new Error("INVALID_TOUR_PROGRESS");
  // where the user engaged is a server-side fact, not client input
  const source = identity.dcEmbed ? "embed" : "standalone";

  if (!isAzureSqlConfigured()) {
    const rows = memoryProgress();
    const now = new Date().toISOString();
    let row = rows.find(
      (item) => item.userId === identity.id && item.tourKey === key,
    );
    if (!row) {
      row = {
        userId: identity.id,
        tourKey: key,
        version,
        status,
        lastStepIndex: 0,
        stepCount,
        source,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
      rows.push(row);
    } else if (row.version !== version) {
      row.lastStepIndex = 0; // a new tour version starts over
      row.startedAt = now;
      row.completedAt = null;
    } else if (row.status === "Completed" && status !== "Completed") {
      return; // re-running a finished tour never downgrades Completed (§5.6.1)
    }
    row.version = version;
    row.stepCount = stepCount;
    row.source = source;
    row.status = status;
    row.lastStepIndex = Math.max(row.lastStepIndex, stepIndex);
    row.updatedAt = now;
    if (status === "Completed") row.completedAt = now;
    return;
  }

  // Two attempts: a concurrent first report can insert the row between our
  // SELECT and INSERT (unique index user_id+tour_key) — on that conflict,
  // retry once as an update of the now-existing row (§5.6.2).
  const pool = await getSqlPool();
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await pool
      .request()
      .input("userId", sql.UniqueIdentifier, identity.id)
      .input("key", sql.NVarChar(64), key)
      .query(
        "SELECT version,status FROM dbo.TourProgress WHERE user_id=@userId AND tour_key=@key",
      );
    try {
      if (!existing.recordset.length) {
        await pool
          .request()
          .input("id", sql.UniqueIdentifier, crypto.randomUUID())
          .input("userId", sql.UniqueIdentifier, identity.id)
          .input("key", sql.NVarChar(64), key)
          .input("version", sql.Int, version)
          .input("status", sql.NVarChar(16), status)
          .input("stepIndex", sql.Int, stepIndex)
          .input("stepCount", sql.Int, stepCount)
          .input("source", sql.NVarChar(16), source)
          .query(
            `INSERT dbo.TourProgress(id,user_id,tour_key,version,status,last_step_index,step_count,source,completed_at)
             VALUES(@id,@userId,@key,@version,@status,@stepIndex,@stepCount,@source,
               CASE WHEN @status='Completed' THEN SYSUTCDATETIME() ELSE NULL END)`,
          );
        return;
      }
      const row = existing.recordset[0];
      if (
        row.version === version &&
        row.status === "Completed" &&
        status !== "Completed"
      )
        return; // Completed never downgrades for the same version (§5.6.1)
      await pool
        .request()
        .input("userId", sql.UniqueIdentifier, identity.id)
        .input("key", sql.NVarChar(64), key)
        .input("version", sql.Int, version)
        .input("status", sql.NVarChar(16), status)
        .input("stepIndex", sql.Int, stepIndex)
        .input("stepCount", sql.Int, stepCount)
        .input("source", sql.NVarChar(16), source)
        .query(
          `UPDATE dbo.TourProgress SET
             last_step_index = CASE WHEN version<>@version THEN @stepIndex
               WHEN last_step_index>@stepIndex THEN last_step_index ELSE @stepIndex END,
             started_at = CASE WHEN version<>@version THEN SYSUTCDATETIME() ELSE started_at END,
             completed_at = CASE WHEN @status='Completed' THEN SYSUTCDATETIME()
               WHEN version<>@version THEN NULL ELSE completed_at END,
             version=@version, step_count=@stepCount, source=@source, status=@status,
             updated_at=SYSUTCDATETIME()
           WHERE user_id=@userId AND tour_key=@key`,
        );
      return;
    } catch (error) {
      if (attempt === 0 && isDuplicateKeyError(error)) continue; // lost the insert race — reload and update
      throw error;
    }
  }
}

// ---------- per-user "hide forever" ----------

export async function hideToursForever(identity: PulseIdentity) {
  if (!isAzureSqlConfigured()) {
    memoryOptOuts()[identity.id] ||= new Date().toISOString();
    return { hidden: true };
  }
  const pool = await getSqlPool();
  await pool
    .request()
    .input("userId", sql.UniqueIdentifier, identity.id)
    .query(
      "UPDATE dbo.Users SET tours_hidden_at=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME() WHERE id=@userId AND tours_hidden_at IS NULL",
    );
  return { hidden: true };
}

// ---------- admin: settings & monitoring (System admin only) ----------

function settingItems(rows: TourSettingRow[]): TourSettingItem[] {
  return TOUR_CATALOG.map((def) => {
    const row = rows.find((item) => item.tourKey === def.key);
    return {
      tourKey: def.key,
      title: pick(def.title, "en"),
      version: def.version,
      stepCount: def.steps.length,
      enabled: row?.enabled ?? true,
      audience: row?.audience ?? def.defaultAudience,
      autoStart: row?.autoStart ?? def.defaultAutoStart,
    };
  });
}

export async function getOnboardingAdmin(
  identity: PulseIdentity,
): Promise<OnboardingAdminPayload> {
  await requireInternalRole(identity, ["System admin"]);
  const enabled = await getOnboardingEnabled();
  const settings = settingItems(await getSettingRows());
  if (!isAzureSqlConfigured()) {
    const { users } = await import("./admin-repository");
    const optOuts = memoryOptOuts();
    const internalOrgIds = new Set(
      (globalThis.pulseMemoryOrganizations ?? [])
        .filter((org) => org.type === "Internal")
        .map((org) => org.id),
    );
    return {
      enabled,
      settings,
      users: users().map((user) => {
        // the demo identity is a System admin regardless of the seeded memberships
        const self = user.id === identity.id;
        const isInternal =
          self ||
          user.memberships.some((m) => internalOrgIds.has(m.companyId));
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          isInternal,
          isSystemAdmin: self ? identity.role === "System admin" : false,
          toursHiddenAt: optOuts[user.id] ?? null,
        };
      }),
      progress: memoryProgress().map((row) => ({
        userId: row.userId,
        tourKey: row.tourKey,
        version: row.version,
        status: row.status,
        lastStepIndex: row.lastStepIndex,
        stepCount: row.stepCount,
        source: row.source,
        updatedAt: row.updatedAt,
      })),
    };
  }
  const pool = await getSqlPool();
  const userRows = await pool.request().query(
    `SELECT CAST(u.id AS nvarchar(36)) id, u.display_name name, u.email,
        CONVERT(nvarchar(33), u.tours_hidden_at, 126) toursHiddenAt,
        MAX(CASE WHEN o.type='Internal' AND m.status='Active' AND o.status='Active' THEN 1 ELSE 0 END) internalFlag,
        MAX(CASE WHEN o.type='Internal' AND m.status='Active' AND o.status='Active' AND m.role='System admin' THEN 1 ELSE 0 END) adminFlag
      FROM dbo.Users u
      LEFT JOIN dbo.Memberships m ON m.user_id=u.id
      LEFT JOIN dbo.Organizations o ON o.id=m.organization_id
      WHERE u.status='Active'
      GROUP BY u.id,u.display_name,u.email,u.tours_hidden_at
      ORDER BY u.display_name`,
  );
  const progressRows = await pool.request().query(
    `SELECT CAST(user_id AS nvarchar(36)) userId,tour_key tourKey,version,status,
        last_step_index lastStepIndex,step_count stepCount,source,
        CONVERT(nvarchar(33), updated_at, 126) updatedAt
      FROM dbo.TourProgress`,
  );
  return {
    enabled,
    settings,
    users: userRows.recordset.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      isInternal: row.internalFlag === 1,
      isSystemAdmin: row.adminFlag === 1,
      toursHiddenAt: row.toursHiddenAt ?? null,
    })),
    progress: progressRows.recordset as TourProgressItem[],
  };
}

export async function saveOnboardingSettings(
  identity: PulseIdentity,
  input: {
    enabled?: unknown;
    tours?: Array<{
      tourKey?: unknown;
      enabled?: unknown;
      audience?: unknown;
      autoStart?: unknown;
    }>;
  },
): Promise<OnboardingAdminPayload> {
  await requireInternalRole(identity, ["System admin"]);
  const enabled = input.enabled !== false;
  const tours = Array.isArray(input.tours) ? input.tours : [];
  for (const tour of tours) {
    if (
      !TOUR_CATALOG.some((def) => def.key === tour.tourKey) ||
      !TOUR_AUDIENCES.includes(tour.audience as TourAudience) ||
      typeof tour.enabled !== "boolean" ||
      typeof tour.autoStart !== "boolean"
    )
      throw new Error("INVALID_ONBOARDING_SETTINGS");
  }
  const audit = {
    enabled,
    tours: tours.map((tour) => ({
      tourKey: tour.tourKey,
      enabled: tour.enabled,
      audience: tour.audience,
      autoStart: tour.autoStart,
    })),
  };
  if (!isAzureSqlConfigured()) {
    globalThis.pulseMemoryOnboardingEnabled = enabled;
    const rows = globalThis.pulseMemoryTourSettings ?? [];
    globalThis.pulseMemoryTourSettings = rows;
    for (const tour of tours) {
      const next: TourSettingRow = {
        tourKey: tour.tourKey as string,
        enabled: tour.enabled as boolean,
        audience: tour.audience as TourAudience,
        autoStart: tour.autoStart as boolean,
      };
      const found = rows.findIndex((row) => row.tourKey === next.tourKey);
      if (found >= 0) rows[found] = next;
      else rows.push(next);
    }
    pushMemoryAudit(identity, "onboarding.settings.updated", undefined, audit);
    return getOnboardingAdmin(identity);
  }
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    await new sql.Request(transaction)
      .input("key", sql.NVarChar(100), "onboarding")
      .input("value", sql.NVarChar(sql.MAX), JSON.stringify({ enabled }))
      .input("actor", sql.UniqueIdentifier, identity.id).query(`
        MERGE dbo.Settings target USING(SELECT @key setting_key) source
        ON target.setting_key=source.setting_key
        WHEN MATCHED THEN UPDATE SET value_json=@value,version=version+1,
          updated_by_user_id=@actor,updated_at=SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT(setting_key,value_json,updated_by_user_id)
          VALUES(@key,@value,@actor);`);
    for (const tour of tours)
      await new sql.Request(transaction)
        .input("key", sql.NVarChar(64), tour.tourKey as string)
        .input("enabled", sql.Bit, tour.enabled as boolean)
        .input("audience", sql.NVarChar(32), tour.audience as string)
        .input("autoStart", sql.Bit, tour.autoStart as boolean).query(`
          MERGE dbo.TourSettings target USING(SELECT @key tour_key) source
          ON target.tour_key=source.tour_key
          WHEN MATCHED THEN UPDATE SET enabled=@enabled,audience=@audience,
            auto_start=@autoStart,updated_at=SYSUTCDATETIME()
          WHEN NOT MATCHED THEN INSERT(tour_key,enabled,audience,auto_start)
            VALUES(@key,@enabled,@audience,@autoStart);`);
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("after", sql.NVarChar(sql.MAX), JSON.stringify(audit))
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,after_json,correlation_id) VALUES(@id,@actor,'onboarding.settings.updated','Onboarding',@after,@correlation)",
      );
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
  return getOnboardingAdmin(identity);
}

export async function restoreUserTours(
  identity: PulseIdentity,
  userId: unknown,
): Promise<{ ok: true }> {
  await requireInternalRole(identity, ["System admin"]);
  const id = String(userId ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("INVALID_USER");
  if (!isAzureSqlConfigured()) {
    delete memoryOptOuts()[id];
    pushMemoryAudit(identity, "onboarding.tours.restored", id, { userId: id });
    return { ok: true };
  }
  const pool = await getSqlPool();
  await pool
    .request()
    .input("userId", sql.UniqueIdentifier, id)
    .query(
      "UPDATE dbo.Users SET tours_hidden_at=NULL, updated_at=SYSUTCDATETIME() WHERE id=@userId",
    );
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, crypto.randomUUID())
    .input("actor", sql.UniqueIdentifier, identity.id)
    .input("entity", sql.UniqueIdentifier, id)
    .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
    .query(
      "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,entity_id,correlation_id) VALUES(@id,@actor,'onboarding.tours.restored','Onboarding',@entity,@correlation)",
    );
  return { ok: true };
}
