import type { CommunicationTopic, TemplateKey } from "./types";

export const COMMUNICATION_TOPICS: CommunicationTopic[] = [
  "product-updates",
  "service-notices",
  "security-advisories",
  "general",
];
export const MANDATORY_TOPICS = new Set<CommunicationTopic>(["security-advisories"]);
export const TEMPLATE_KEYS: TemplateKey[] = ["product-update", "service-notice", "plain"];

/**
 * NotificationPreferences event type that carries a member's opt-in for a topic. The template literal return type is
 * assignable to `NotificationEventType`, so a topic with no registered event type fails `tsc` where this is used.
 */
export function topicEventType(topic: CommunicationTopic): `communication.${CommunicationTopic}` {
  return `communication.${topic}`;
}
export function defaultTemplateForTopic(topic: CommunicationTopic): TemplateKey {
  return topic === "product-updates" ? "product-update" : topic === "service-notices" ? "service-notice" : "plain";
}
export function defaultTopicForTemplate(template: TemplateKey): CommunicationTopic {
  return template === "product-update" ? "product-updates" : template === "service-notice" ? "service-notices" : "general";
}
