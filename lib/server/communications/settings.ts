import { communicationSettingsInputSchema } from "@/lib/contracts";
import type { PulseIdentity } from "@/lib/domain";
import { requireInternalRole } from "../authorization";
import { beginSqlTransaction, getSqlPool, isAzureSqlConfigured, sql } from "../database";
import { parseInput } from "../validation";
import { memoryAuditEvent } from "./memory";

export type CommunicationSettings = {
  enabled: boolean;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  dataResidency: "global" | "eu";
  unsubscribeGroupId: number | null;
  sandboxMode: boolean;
  safeMode: { enabled: boolean; allowedDomains: string[] };
  tracking: { opens: boolean; clicks: boolean };
  dailyCap: number;
  maxRecipientsPerCampaign: number;
  categoriesPrefix: string;
  boilerplate: {
    en: { signOff: string; footer: string; supportEmail: string };
    is: { signOff: string; footer: string; supportEmail: string };
  };
};

export const DEFAULT_COMMUNICATION_SETTINGS: CommunicationSettings = {
  enabled: false,
  fromName: "DataCentral",
  fromEmail: "",
  replyTo: "",
  dataResidency: "global",
  unsubscribeGroupId: null,
  sandboxMode: false,
  safeMode: { enabled: true, allowedDomains: ["datacentral.ai"] },
  tracking: { opens: true, clicks: true },
  dailyCap: 5000,
  maxRecipientsPerCampaign: 5000,
  categoriesPrefix: "pulse",
  boilerplate: {
    en: { signOff: "Best,\nThe DataCentral Team", footer: "DataCentral ehf. · Reykjavík, Iceland", supportEmail: "support@datacentral.ai" },
    is: { signOff: "Kær kveðja,\nDataCentral teymið", footer: "DataCentral ehf. · Reykjavík", supportEmail: "support@datacentral.ai" },
  },
};

const SETTING_KEY = "communications";

export type SendingState = "disabled" | "provider-missing" | "sandbox" | "safe-mode" | "live";
export function communicationProviderStatus(settings: CommunicationSettings) {
  const providerConfigured = Boolean(process.env.SENDGRID_API_KEY?.trim());
  const webhookConfigured = Boolean(process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY?.trim());
  const base = (process.env.PULSE_PUBLIC_URL || "http://localhost:3000").replace(/\/+$/, "");
  const effectiveSendingState: SendingState = !settings.enabled
    ? "disabled"
    : !providerConfigured
      ? "provider-missing"
      : settings.sandboxMode
        ? "sandbox"
        : settings.safeMode.enabled
          ? "safe-mode"
          : "live";
  return {
    providerConfigured,
    webhookConfigured,
    webhookUrl: `${base}/api/v1/internal/communications/events`,
    effectiveSendingState,
  };
}

function merge(stored: unknown): CommunicationSettings {
  const value = (stored && typeof stored === "object" ? stored : {}) as Partial<CommunicationSettings>;
  return {
    ...DEFAULT_COMMUNICATION_SETTINGS,
    ...value,
    safeMode: { ...DEFAULT_COMMUNICATION_SETTINGS.safeMode, ...(value.safeMode || {}) },
    tracking: { ...DEFAULT_COMMUNICATION_SETTINGS.tracking, ...(value.tracking || {}) },
    boilerplate: {
      en: { ...DEFAULT_COMMUNICATION_SETTINGS.boilerplate.en, ...(value.boilerplate?.en || {}) },
      is: { ...DEFAULT_COMMUNICATION_SETTINGS.boilerplate.is, ...(value.boilerplate?.is || {}) },
    },
  };
}

/** No authorisation: used by the worker, the webhook and the renderer. */
export async function getRuntimeCommunicationSettings(): Promise<CommunicationSettings> {
  if (!isAzureSqlConfigured())
    return structuredClone(globalThis.pulseMemoryCommunicationSettings || DEFAULT_COMMUNICATION_SETTINGS);
  const result = await (await getSqlPool())
    .request()
    .input("key", sql.NVarChar(100), SETTING_KEY)
    .query("SELECT value_json value FROM dbo.Settings WHERE setting_key=@key");
  return merge(result.recordset[0]?.value ? JSON.parse(result.recordset[0].value) : null);
}

export async function getCommunicationSettings(identity: PulseIdentity) {
  await requireInternalRole(identity, ["System admin"]);
  return getRuntimeCommunicationSettings();
}

export async function saveCommunicationSettings(identity: PulseIdentity, input: CommunicationSettings) {
  const parsed = parseInput(communicationSettingsInputSchema, input) as CommunicationSettings;
  await requireInternalRole(identity, ["System admin"]);
  const saved: CommunicationSettings = {
    ...parsed,
    safeMode: { ...parsed.safeMode, allowedDomains: [...new Set(parsed.safeMode.allowedDomains)] },
  };
  if (!isAzureSqlConfigured()) {
    const before = globalThis.pulseMemoryCommunicationSettings;
    globalThis.pulseMemoryCommunicationSettings = structuredClone(saved);
    memoryAuditEvent(identity, "communication.settings.updated", "Settings", undefined, saved, before);
    return structuredClone(saved);
  }
  const pool = await getSqlPool();
  const scope = await beginSqlTransaction(pool);
  try {
    const prior = await new sql.Request(scope.transaction)
      .input("key", sql.NVarChar(100), SETTING_KEY)
      .query("SELECT value_json value FROM dbo.Settings WITH (UPDLOCK,HOLDLOCK) WHERE setting_key=@key");
    await new sql.Request(scope.transaction)
      .input("key", sql.NVarChar(100), SETTING_KEY)
      .input("value", sql.NVarChar(sql.MAX), JSON.stringify(saved))
      .input("actor", sql.UniqueIdentifier, identity.id).query(`
        MERGE dbo.Settings target USING(SELECT @key setting_key) source ON target.setting_key=source.setting_key
        WHEN MATCHED THEN UPDATE SET value_json=@value,version=version+1,updated_by_user_id=@actor,updated_at=SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT(setting_key,value_json,updated_by_user_id) VALUES(@key,@value,@actor);`);
    await new sql.Request(scope.transaction)
      .input("id", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("before", sql.NVarChar(sql.MAX), prior.recordset[0]?.value || null)
      .input("after", sql.NVarChar(sql.MAX), JSON.stringify(saved))
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .query("INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,before_json,after_json,correlation_id) VALUES(@id,@actor,'communication.settings.updated','Settings',@before,@after,@correlation)");
    await scope.commit();
    return saved;
  } catch (error) {
    await scope.rollback();
    throw error;
  }
}
