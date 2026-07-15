import type { PulseIdentity } from "@/lib/domain";
import { requireInternalRole } from "./authorization";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";

export type PulseSettings = {
  formulaVersion: number;
  attachmentMaxMb: number;
  requestAttachmentMaxMb: number;
  retentionDays: number;
  defaultLocale: "en" | "is";
  roadmapDisclaimer: string;
  scoreWeights: {
    impact: number;
    reach: number;
    strategy: number;
    commercial: number;
    urgency: number;
  };
};

const defaults: PulseSettings = {
  formulaVersion: 1,
  attachmentMaxMb: 25,
  requestAttachmentMaxMb: 100,
  retentionDays: 2555,
  defaultLocale: "en",
  roadmapDisclaimer:
    "Roadmap content is directional, may change, and is not a contractual commitment.",
  scoreWeights: {
    impact: 30,
    reach: 20,
    strategy: 25,
    commercial: 15,
    urgency: 10,
  },
};

declare global {
  var pulseMemorySettings: PulseSettings | undefined;
}

export async function getRuntimeSettings() {
  if (!isAzureSqlConfigured()) {
    globalThis.pulseMemorySettings ||= structuredClone(defaults);
    return structuredClone(globalThis.pulseMemorySettings);
  }
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("key", sql.NVarChar(100), "system")
    .query("SELECT value_json value FROM dbo.Settings WHERE setting_key=@key");
  return result.recordset.length
    ? ({
        ...defaults,
        ...JSON.parse(result.recordset[0].value),
      } as PulseSettings)
    : defaults;
}

export async function getSettings(identity: PulseIdentity) {
  await requireInternalRole(identity, ["System admin"]);
  return getRuntimeSettings();
}

export async function saveSettings(
  identity: PulseIdentity,
  input: PulseSettings,
) {
  await requireInternalRole(identity, ["System admin"]);
  if (
    ![10, 25, 50].includes(Number(input.attachmentMaxMb)) ||
    ![50, 100, 250].includes(Number(input.requestAttachmentMaxMb)) ||
    input.requestAttachmentMaxMb < input.attachmentMaxMb ||
    !["en", "is"].includes(input.defaultLocale) ||
    input.retentionDays < 30 ||
    !input.roadmapDisclaimer?.trim()
  )
    throw new Error("INVALID_SETTINGS");
  const weightTotal = Object.values(input.scoreWeights).reduce(
    (sum, value) => sum + Number(value),
    0,
  );
  if (weightTotal !== 100) throw new Error("INVALID_SCORE_WEIGHTS");
  const saved = structuredClone(input);
  if (!isAzureSqlConfigured()) {
    const before = globalThis.pulseMemorySettings;
    saved.formulaVersion =
      before &&
      JSON.stringify(before.scoreWeights) !== JSON.stringify(saved.scoreWeights)
        ? before.formulaVersion + 1
        : before?.formulaVersion || 1;
    globalThis.pulseMemorySettings = saved;
    globalThis.pulseMemoryAudit ||= [];
    globalThis.pulseMemoryAudit.unshift({
      id: crypto.randomUUID(),
      actor: identity.name,
      organizationId: identity.organizationId,
      action: "settings.updated",
      entityType: "Settings",
      before,
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
    const prior = await new sql.Request(transaction)
      .input("key", sql.NVarChar(100), "system")
      .query(
        "SELECT value_json value FROM dbo.Settings WITH (UPDLOCK,HOLDLOCK) WHERE setting_key=@key",
      );
    const priorSettings = prior.recordset[0]?.value
      ? ({
          ...defaults,
          ...JSON.parse(prior.recordset[0].value),
        } as PulseSettings)
      : defaults;
    saved.formulaVersion =
      JSON.stringify(priorSettings.scoreWeights) !==
      JSON.stringify(saved.scoreWeights)
        ? priorSettings.formulaVersion + 1
        : priorSettings.formulaVersion;
    await new sql.Request(transaction)
      .input("key", sql.NVarChar(100), "system")
      .input("value", sql.NVarChar(sql.MAX), JSON.stringify(saved))
      .input("actor", sql.UniqueIdentifier, identity.id).query(`
        MERGE dbo.Settings target USING(SELECT @key setting_key) source
        ON target.setting_key=source.setting_key
        WHEN MATCHED THEN UPDATE SET value_json=@value,version=version+1,
          updated_by_user_id=@actor,updated_at=SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT(setting_key,value_json,updated_by_user_id)
          VALUES(@key,@value,@actor);`);
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("before", sql.NVarChar(sql.MAX), prior.recordset[0]?.value || null)
      .input("after", sql.NVarChar(sql.MAX), JSON.stringify(saved))
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,before_json,after_json,correlation_id) VALUES(@id,@actor,'settings.updated','Settings',@before,@after,@correlation)",
      );
    await transaction.commit();
    return saved;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
