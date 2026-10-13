import type { CommunicationRecord, ContactRecord, DeliveryRecord, SuppressionRecord } from "./types";
import type { CommunicationSettings } from "./settings";

declare global {
  var pulseMemoryCommunicationContacts: ContactRecord[] | undefined;
  var pulseMemoryCommunicationSuppressions: SuppressionRecord[] | undefined;
  var pulseMemoryCommunications: CommunicationRecord[] | undefined;
  var pulseMemoryCommunicationDeliveries: DeliveryRecord[] | undefined;
  var pulseMemoryCommunicationEvents: Set<string> | undefined;
  var pulseMemoryCommunicationSettings: CommunicationSettings | undefined;
  var pulseMemoryCommunicationCounter: number | undefined;
}
export const memoryContacts = () => (globalThis.pulseMemoryCommunicationContacts ||= []);
export const memorySuppressions = () => (globalThis.pulseMemoryCommunicationSuppressions ||= []);
export const memoryCommunications = () => (globalThis.pulseMemoryCommunications ||= []);
export const memoryDeliveries = () => (globalThis.pulseMemoryCommunicationDeliveries ||= []);
export const memoryEvents = () => (globalThis.pulseMemoryCommunicationEvents ||= new Set<string>());
export function nextMemoryPublicId() {
  globalThis.pulseMemoryCommunicationCounter = (globalThis.pulseMemoryCommunicationCounter || 0) + 1;
  return `COM-${String(globalThis.pulseMemoryCommunicationCounter).padStart(3, "0")}`;
}
/** Shared helper so every repository audits the same way in memory mode. */
export function memoryAuditEvent(
  identity: { id: string; name: string; organizationId: string },
  action: string,
  entityType: string,
  entityId: string | undefined,
  after: unknown,
  before?: unknown,
) {
  globalThis.pulseMemoryAudit ||= [];
  globalThis.pulseMemoryAudit.unshift({
    id: crypto.randomUUID(),
    actor: identity.name,
    organizationId: identity.organizationId,
    action,
    entityType,
    entityId,
    before,
    after,
    correlationId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });
}
export function resetCommunicationMemory() {
  globalThis.pulseMemoryCommunicationContacts = undefined;
  globalThis.pulseMemoryCommunicationSuppressions = undefined;
  globalThis.pulseMemoryCommunications = undefined;
  globalThis.pulseMemoryCommunicationDeliveries = undefined;
  globalThis.pulseMemoryCommunicationEvents = undefined;
  globalThis.pulseMemoryCommunicationSettings = undefined;
  globalThis.pulseMemoryCommunicationCounter = undefined;
}
