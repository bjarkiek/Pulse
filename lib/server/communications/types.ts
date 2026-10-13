export type CommunicationTopic =
  | "product-updates"
  | "service-notices"
  | "security-advisories"
  | "general";
export type TemplateKey = "product-update" | "service-notice" | "plain";
export type EmailLocale = "en" | "is";
export type LocalizedText = { en: string; is?: string };
export type LocalizedBody = { en: Record<string, unknown>; is?: Record<string, unknown> };

export type CommunicationContent = {
  subject: LocalizedText;
  preheader?: LocalizedText;
  body: LocalizedBody;
};

export type AudienceSpec = {
  organizations: "all-customers" | string[];
  includeOnboarding: boolean;
  includeTestOrganizations: boolean;
  includeMembers: boolean;
  memberRoles: Array<"Company admin" | "Requester" | "Viewer"> | null;
  includeContacts: boolean;
  includeInternalCopy: boolean;
};

export type CommunicationStatus = "Draft" | "Scheduled" | "Sending" | "Sent" | "Cancelled";

export type CommunicationRecord = {
  version?: string;
  id: string;                 // public id COM-###
  templateKey: TemplateKey;
  topic: CommunicationTopic;
  title: string;
  content: CommunicationContent;
  audience: AudienceSpec;
  status: CommunicationStatus;
  scheduledAt?: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  recipientCount: number;
  releaseId?: string;
  createdBy: string;          // display name
  createdAt: string;
  updatedAt: string;
};

export type ContactStatus = "Active" | "Unsubscribed" | "Bounced";
export type ContactSource = "Admin" | "Company admin" | "Import" | "Webhook";
export type ContactRecord = {
  id: string;
  organizationId: string;
  userId: string | null;
  email: string;
  displayName: string;
  locale: EmailLocale;
  topics: CommunicationTopic[];
  status: ContactStatus;
  source: ContactSource;
  note?: string;
  createdAt: string;
  updatedAt: string;
};

export type SuppressionReason = "Unsubscribed" | "Bounced" | "SpamReport" | "Manual";
export type SuppressionRecord = {
  email: string;
  reason: SuppressionReason;
  source: "Webhook" | "Admin";
  note?: string;
  createdAt: string;
};

export type DeliveryState =
  | "Queued" | "Processing" | "Retry" | "Accepted" | "Delivered" | "Deferred"
  | "Bounced" | "Dropped" | "Dead letter" | "Suppressed" | "Cancelled";
export type DeliverySource = "Member" | "Contact" | "Test";
export type SuppressedReason = SuppressionReason | "SafeMode" | "PreferenceOff";
export type DeliveryRecord = {
  id: string;
  communicationId: string;    // public id COM-###
  organizationId: string | null;
  email: string;
  displayName: string | null;
  locale: EmailLocale;
  source: DeliverySource;
  userId?: string | null;
  contactId?: string | null;
  state: DeliveryState;
  suppressedReason?: SuppressedReason | null;
  attemptCount: number;
  nextAttemptAt?: string | null;
  providerMessageId?: string | null;
  lastEvent?: string | null;
  lastEventAt?: string | null;
  openedAt?: string | null;
  clickedAt?: string | null;
  lastErrorCode?: string | null;
  createdAt: string;
  acceptedAt?: string | null;
};

export type CommunicationStats = {
  recipients: number;
  queued: number;
  accepted: number;
  delivered: number;
  bounced: number;
  dropped: number;
  deadLettered: number;
  suppressed: number;
  cancelled: number;
  opened: number;
  clicked: number;
  byOrganization: Array<{ organizationId: string; recipients: number; delivered: number; opened: number }>;
};
