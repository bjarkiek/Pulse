import type { AudienceSpec, CommunicationTopic, ContactRecord, DeliveryRecord, SuppressionReason } from "./types";
import type { CommunicationSettings } from "./settings";
import { MANDATORY_TOPICS, topicEventType } from "./topics";
import { loadSuppressionMap } from "./suppression-repository";
import { memoryContacts } from "./memory";
import { organizations, users } from "../admin-repository";
import { getSqlPool, isAzureSqlConfigured, sql } from "../database";
import type { NotificationEventType } from "../notification-preference-repository";

export type AudienceOrganization = { id: string; name: string; type: string; status: string; isTest: boolean; locale: "en" | "is" };
export type AudienceMember = { userId: string; organizationId: string; email: string; displayName: string; locale: "en" | "is"; role: string; preference: "Immediate" | "Daily" | "Weekly" | "Off" | null };
export type AudienceInput = {
  organizations: AudienceOrganization[];      // every non-Inactive organisation (all types)
  members: AudienceMember[];                  // Active users × Active memberships, with the topic preference joined
  contacts: ContactRecord[];                  // non-deleted contacts of every organisation
  suppressions: Map<string, SuppressionReason>;
};
export type AudienceRecipient = Pick<DeliveryRecord, "organizationId" | "email" | "displayName" | "locale" | "source" | "userId" | "contactId" | "state" | "suppressedReason">;
export type AudienceBreakdown = { organizations: number; members: number; contacts: number; internal: number; suppressed: Record<string, number>; total: number; sendable: number };

/** The form an address is deduplicated, matched against the suppression list and looked up under. */
const normalise = (email: string) => email.toLowerCase();

/**
 * Safe mode compares the whole domain, whatever its case: `x@evil-datacentral.ai` and `x@datacentral.ai.attacker.com` do not match `datacentral.ai`.
 * One rule for everything safe mode guards: the audience of a campaign and the configuration test mail.
 */
export function domainAllowed(email: string, allowed: string[]) {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return allowed.some((d) => d.toLowerCase() === domain);
}

/**
 * Why an address is not mailed although it is on a list: it is on the suppression list (that list's reason), or else safe mode is on and its
 * domain is not allow-listed (`SafeMode`). The one rule for both moments it is applied: when the audience is frozen into delivery rows, and again
 * when the worker claims a row that has been waiting since (see `claimBatch`), so an unsubscribe, a bounce or a change of the safe-mode list that
 * came after the freeze holds for a retry or a requeued dead letter as well.
 */
export function blockedReason(
  email: string,
  suppressions: ReadonlyMap<string, SuppressionReason>,
  safeMode: { enabled: boolean; allowedDomains: string[] },
): SuppressionReason | "SafeMode" | null {
  const reason = suppressions.get(normalise(email));
  if (reason) return reason;
  return safeMode.enabled && !domainAllowed(email, safeMode.allowedDomains) ? "SafeMode" : null;
}

/**
 * Pure: no I/O. Members come first, then contacts, then the optional internal copy, and the first row for an address wins
 * (so a member beats a contact). An address that belongs to a member who is Off for the topic in any selected organisation (even
 * on a row the role filter drops, and whether or not members are included) is kept as `Suppressed/PreferenceOff` when it is merged
 * as a member or as a contact, unless the topic is mandatory; the global suppression list and safe mode then suppress what is
 * left. Suppressed rows stay in the result so the review can show them, but only Queued rows are sent and count against
 * `maxRecipientsPerCampaign`.
 */
export function resolveAudience(
  spec: AudienceSpec,
  topic: CommunicationTopic,
  input: AudienceInput,
  settings: Pick<CommunicationSettings, "safeMode" | "maxRecipientsPerCampaign">,
): { recipients: AudienceRecipient[]; breakdown: AudienceBreakdown } {
  const selected = new Map<string, AudienceOrganization>();
  for (const org of input.organizations) {
    if (org.type === "Internal" || org.status === "Inactive") continue;
    if (spec.organizations !== "all-customers" && !spec.organizations.includes(org.id)) continue;
    if (org.status === "Onboarding" && !spec.includeOnboarding) continue;
    if (org.isTest && !spec.includeTestOrganizations) continue;
    selected.set(org.id, org);
  }
  const internalIds = new Set(input.organizations.filter((o) => o.type === "Internal" && o.status !== "Inactive").map((o) => o.id));
  const roles: readonly string[] | null = spec.memberRoles;
  const mandatory = MANDATORY_TOPICS.has(topic);
  const byEmail = new Map<string, AudienceRecipient>();
  const breakdown: AudienceBreakdown = { organizations: selected.size, members: 0, contacts: 0, internal: 0, suppressed: {}, total: 0, sendable: 0 };
  const suppress = (recipient: AudienceRecipient, reason: NonNullable<AudienceRecipient["suppressedReason"]>) => {
    recipient.state = "Suppressed";
    recipient.suppressedReason = reason;
    breakdown.suppressed[reason] = (breakdown.suppressed[reason] || 0) + 1;
  };
  // Consent must not depend on row order or on the list an address arrives by: a member who is Off in any selected organisation
  // is Off whichever of their rows comes first, and a contact with the same address is Off with them (even when members are not included).
  const optedOut = new Set<string>();
  for (const m of input.members) if (m.preference === "Off" && selected.has(m.organizationId)) optedOut.add(normalise(m.email));
  const add = (recipient: AudienceRecipient, honourOptOut: boolean) => {
    const key = normalise(recipient.email);
    recipient.email = key;
    if (byEmail.has(key)) return false;
    if (honourOptOut && !mandatory && optedOut.has(key)) suppress(recipient, "PreferenceOff");
    byEmail.set(key, recipient);
    return true;
  };
  if (spec.includeMembers)
    for (const m of input.members) {
      if (!selected.has(m.organizationId)) continue;
      if (roles && !roles.includes(m.role)) continue;
      if (add({ organizationId: m.organizationId, email: m.email, displayName: m.displayName, locale: m.locale, source: "Member", userId: m.userId, contactId: null, state: "Queued", suppressedReason: null }, true))
        breakdown.members++;
    }
  if (spec.includeContacts)
    for (const c of input.contacts) {
      if (!selected.has(c.organizationId) || c.status !== "Active" || !c.topics.includes(topic)) continue;
      if (add({ organizationId: c.organizationId, email: c.email, displayName: c.displayName, locale: c.locale, source: "Contact", userId: c.userId, contactId: c.id, state: "Queued", suppressedReason: null }, true))
        breakdown.contacts++;
    }
  // The staff copy is deliberate, so the opt-out set does not apply to it (an address already merged as a member or contact keeps that row).
  if (spec.includeInternalCopy)
    for (const m of input.members) {
      if (!internalIds.has(m.organizationId)) continue;
      if (add({ organizationId: m.organizationId, email: m.email, displayName: m.displayName, locale: m.locale, source: "Member", userId: m.userId, contactId: null, state: "Queued", suppressedReason: null }, false))
        breakdown.internal++;
    }
  for (const recipient of byEmail.values()) {
    if (recipient.state !== "Queued") continue;
    const reason = blockedReason(recipient.email, input.suppressions, settings.safeMode);
    if (reason) suppress(recipient, reason);
  }
  const recipients = [...byEmail.values()];
  breakdown.total = recipients.length;
  breakdown.sendable = recipients.filter((r) => r.state === "Queued").length;
  if (breakdown.sendable > settings.maxRecipientsPerCampaign) throw new Error("INVALID_AUDIENCE_TOO_LARGE");
  return { recipients, breakdown };
}

const localeOf = (value: unknown): "en" | "is" => (value === "is" ? "is" : "en");

/**
 * No identity: the callers authorise. The SQL reads are awaited one after the other because `atomicSql` gives every request
 * the same transaction and a transaction carries a single request at a time (mssql answers a second one with EREQINPROG). Members and
 * contacts are read in organisation, then address, order: the resolver gives an address that belongs to several organisations to the
 * first row it meets, so the order must not depend on the plan the database picks.
 */
export async function loadAudienceInput(topic: CommunicationTopic): Promise<AudienceInput> {
  const suppressions = await loadSuppressionMap();
  const eventType: NotificationEventType = topicEventType(topic);
  if (!isAzureSqlConfigured()) {
    const preferences = globalThis.pulseMemoryNotificationPreferences;
    const members: AudienceMember[] = [];
    for (const user of users())
      if (user.status === "Active")
        for (const membership of user.memberships)
          members.push({
            userId: user.id, organizationId: membership.companyId, email: user.email, displayName: user.name,
            locale: localeOf(globalThis.pulseMemoryLocales?.[user.id]), role: membership.role,
            preference: preferences?.get(`${user.id}:${membership.companyId}:${eventType}`) ?? null,
          });
    return {
      organizations: organizations().filter((o) => o.status !== "Inactive")
        .map((o) => ({ id: o.id, name: o.name, type: o.type, status: o.status, isTest: false, locale: "en" })),
      members, contacts: structuredClone(memoryContacts()), suppressions,
    };
  }
  const pool = await getSqlPool();
  const orgRows = await pool.request().query("SELECT id,name,type,status,is_test isTest,locale FROM dbo.Organizations WHERE status<>'Inactive'");
  const memberRows = await pool.request().input("eventType", sql.NVarChar(100), eventType).query(
    `SELECT CAST(u.id AS nvarchar(36)) userId,m.organization_id organizationId,u.email,u.display_name displayName,u.locale,m.role,p.cadence preference
     FROM dbo.Memberships m JOIN dbo.Users u ON u.id=m.user_id AND u.status='Active'
     LEFT JOIN dbo.NotificationPreferences p ON p.user_id=m.user_id AND p.organization_id=m.organization_id AND p.event_type=@eventType
     WHERE m.status='Active' ORDER BY m.organization_id,u.email`);
  const contactRows = await pool.request().query(
    `SELECT CAST(c.id AS nvarchar(36)) id,c.organization_id organizationId,CAST(c.user_id AS nvarchar(36)) userId,c.email,c.display_name displayName,c.locale,c.topics_json topicsJson,c.status,c.source
     FROM dbo.CommunicationContacts c WHERE c.deleted_at IS NULL ORDER BY c.organization_id,c.email`);
  return {
    organizations: orgRows.recordset.map((o) => ({ id: o.id, name: o.name, type: o.type, status: o.status, isTest: Boolean(o.isTest), locale: localeOf(o.locale) })),
    members: memberRows.recordset.map((m) => ({
      userId: m.userId, organizationId: m.organizationId, email: m.email, displayName: m.displayName,
      locale: localeOf(m.locale), role: m.role, preference: m.preference ?? null,
    })),
    contacts: contactRows.recordset.map((c): ContactRecord => ({
      id: c.id, organizationId: c.organizationId, userId: c.userId || null, email: c.email, displayName: c.displayName,
      locale: localeOf(c.locale), topics: JSON.parse(c.topicsJson || "[]"), status: c.status, source: c.source, createdAt: "", updatedAt: "",
    })),
    suppressions,
  };
}
