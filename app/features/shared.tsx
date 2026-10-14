"use client";

import { createContext, useContext, ReactNode } from "react";

export const UserContext = createContext({ name: "", organization: "" });
export const DraftOwnerContext = createContext<string | null>(null);

export const LocaleContext = createContext<(s: string) => string>((s) => s);

export function useT() {
  return useContext(LocaleContext);
}

export function mutationHeaders(json = true, version?: string) {
  return {
    ...(version ? { "if-match": version } : {}),
    ...(json ? { "content-type": "application/json" } : {}),
    "idempotency-key": crypto.randomUUID(),
  };
}

export type Page =
  | "home"
  | "ideas"
  | "roadmap"
  | "requests"
  | "updates"
  | "triage"
  | "productIdeas"
  | "releases"
  | "communications"
  | "audit"
  | "analytics"
  | "companies"
  | "users"
  | "authentication"
  | "settings"
  | "help";

export type Tone = "success" | "warning" | "neutral" | "violet" | "error";

export type Idea = {
  version?: string;
  id: string;
  title: string;
  description: string;
  area: string;
  status: string;
  tone: Tone;
  horizon: "Now" | "Next" | "Later" | "Released";
  organizations: number;
  followers: number;
  updated: string;
  followed?: boolean;
};

export type InternalIdea = Idea & {
  internalTitle: string;
  internalDescription: string;
  publishedTitle?: string;
  publishedDescription?: string;
  internalStatus:
    | "Discovery"
    | "Candidate"
    | "Planned"
    | "In progress"
    | "Released"
    | "Not planned"
    | "Archived";
  ownerId?: string;
  publishState: "Internal" | "Staged" | "Published";
  decisionRationale?: string;
  decisionReason?: string;
  deliveryReference?: string;
  deliveryException?: boolean;
  releaseNotes?: string;
  availability?: string;
  score?: number;
  linkedRequests?: number;
};

export type ReleaseItem = {
  version?: string;
  id: string;
  title: string;
  date: string;
  summary: string;
  availability: string;
  documentationUrl?: string;
  rolloutNotes?: string;
  published: boolean;
  ideaIds: string[];
};

export type AuditItem = {
  id: string;
  actor?: string;
  organizationId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  correlationId: string;
  createdAt: string;
};

export type NotificationItem = {
  id: string;
  eventType: string;
  template: string;
  state: string;
  createdAt: string;
  readAt?: string;
  entityId?: string;
};

export type NotificationPreferenceItem = {
  eventType: string;
  cadence: "Immediate" | "Daily" | "Weekly" | "Off";
  mandatory: boolean;
};

export type ExternalLinkItem = {
  id: string;
  ideaId: string;
  label: string;
  url: string;
};

export type WebhookSubscriptionItem = {
  id: string;
  url: string;
  events: string[];
  active: boolean;
};

export type AnalyticsSummary = {
  requests: { total: number; open: number };
  serviceLevels: {
    averageFirstResponseHours: number;
    averageTriageHours: number;
  };
  notifications: Array<{ state: string; count: number }>;
  dataQuality: { missingOwner: number; missingClassification: number };
};

export type SearchSuggestionItem = {
  id: string;
  title: string;
  description: string;
  area: string;
  status: string;
  tone: Tone;
  source: "Idea" | "Your request";
  why: string;
};

export type RequestItem = {
  version?: string;
  id: string;
  title: string;
  problem: string;
  area: string;
  impact: string;
  status: string;
  tone: Tone;
  visibility: string;
  submitted: string;
  owner: string;
  linkedIdea?: string;
  attachmentCount?: number;
};

export type RequestAttachment = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanState: string;
  createdAt: string;
};

export type RequestComment = {
  id: string;
  author: string;
  body: string;
  visibility: "Customer" | "Internal";
  createdAt: string;
  editedAt?: string;
  removed?: boolean;
  canEdit?: boolean;
  attachments?: RequestAttachment[];
};

export type RequestHistoryItem = {
  id: string;
  action: string;
  actor?: string;
  after?: { status?: string };
  createdAt: string;
};

export type Company = {
  id: string;
  name: string;
  type: "Customer" | "Partner" | "Internal";
  status: "Active" | "Onboarding" | "Inactive";
  domain: string;
  users: number;
  requests: number;
  authentication: ("OTP" | "Entra ID")[];
};

export type UserMembership = {
  companyId: string;
  role: "Company admin" | "Requester" | "Viewer" | "Product manager";
};

export type ManagedUser = {
  id: string;
  name: string;
  email: string;
  status: "Active" | "Invited" | "Suspended";
  authentication: "OTP" | "Entra ID";
  memberships: UserMembership[];
};

export type PulseSettings = {
  formulaVersion: number;
  attachmentMaxMb: number;
  requestAttachmentMaxMb: number;
  retentionDays: number;
  defaultLocale: "en" | "is";
  roadmapDisclaimer: string;
  showDemoData: boolean;
  dcOnlyAccess: boolean;
  scoreWeights: {
    impact: number;
    reach: number;
    strategy: number;
    commercial: number;
    urgency: number;
  };
};

export type OrganizationContext = {
  active?: boolean;
  id: string;
  name: string;
  type: string;
  role: string;
};

export type TaxonomyValue = {
  id: string;
  kind:
    | "Product area"
    | "Request type"
    | "Tag"
    | "Strategic theme"
    | "Reason category";
  value: string;
  active: boolean;
  sortOrder: number;
};

export type CommunicationStatus =
  "Draft" | "Scheduled" | "Sending" | "Sent" | "Cancelled";
export type CommunicationStatsItem = {
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
  byOrganization: Array<{
    organizationId: string;
    recipients: number;
    delivered: number;
    opened: number;
  }>;
};
export type CommunicationItem = {
  version?: string;
  id: string;
  templateKey: "product-update" | "service-notice" | "plain";
  topic:
    "product-updates" | "service-notices" | "security-advisories" | "general";
  title: string;
  content: {
    subject: { en: string; is?: string };
    preheader?: { en?: string; is?: string };
    body: { en: Record<string, unknown>; is?: Record<string, unknown> };
  };
  audience: {
    organizations: "all-customers" | string[];
    includeOnboarding: boolean;
    includeTestOrganizations: boolean;
    includeMembers: boolean;
    memberRoles: Array<"Company admin" | "Requester" | "Viewer"> | null;
    includeContacts: boolean;
    includeInternalCopy: boolean;
  };
  status: CommunicationStatus;
  scheduledAt?: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  recipientCount: number;
  releaseId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  stats?: CommunicationStatsItem;
};
export type AudienceBreakdownItem = {
  organizations: number;
  members: number;
  contacts: number;
  internal: number;
  suppressed: Record<string, number>;
  total: number;
  sendable: number;
};
export type DeliveryItem = {
  id: string;
  organizationId: string | null;
  email: string;
  displayName: string | null;
  locale: "en" | "is";
  source: "Member" | "Contact" | "Test";
  state: string;
  suppressedReason?: string | null;
  attemptCount: number;
  providerMessageId?: string | null;
  lastEvent?: string | null;
  lastEventAt?: string | null;
  openedAt?: string | null;
  clickedAt?: string | null;
  lastErrorCode?: string | null;
  createdAt: string;
};
export type ContactItem = {
  id: string;
  organizationId: string;
  userId: string | null;
  email: string;
  displayName: string;
  locale: "en" | "is";
  topics: string[];
  status: "Active" | "Unsubscribed" | "Bounced";
  source: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
};
export type SuppressionItem = {
  email: string;
  reason: string;
  source: string;
  note?: string;
  createdAt: string;
};
export type CommunicationSettingsItem = {
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
  boilerplate: Record<
    "en" | "is",
    { signOff: string; footer: string; supportEmail: string }
  >;
};
export type CommunicationProviderStatus = {
  providerConfigured: boolean;
  webhookConfigured: boolean;
  webhookUrl: string;
  effectiveSendingState:
    "disabled" | "provider-missing" | "sandbox" | "safe-mode" | "live";
};
export const COMMUNICATION_TOPIC_LABELS: Record<string, string> = {
  "product-updates": "Product updates",
  "service-notices": "Service notices",
  "security-advisories": "Security advisories",
  general: "General announcements",
};

export type IconName =
  | "home"
  | "spark"
  | "map"
  | "inbox"
  | "bell"
  | "search"
  | "plus"
  | "arrow"
  | "clock"
  | "check"
  | "users"
  | "message"
  | "chevron"
  | "menu"
  | "x"
  | "filter"
  | "layers"
  | "settings"
  | "building"
  | "send"
  | "link"
  | "eye"
  | "help";

export const iconPaths: Record<IconName, ReactNode> = {
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.4 9.2a2.6 2.6 0 1 1 3.6 2.4c-.7.3-1 .8-1 1.5v.6" />
      <path d="M12 17h.01" />
    </>
  ),
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M9 21v-7h6v7" />
    </>
  ),
  spark: (
    <>
      <path d="m12 3-1.7 4.3L6 9l4.3 1.7L12 15l1.7-4.3L18 9l-4.3-1.7L12 3Z" />
      <path d="m5 15-.9 2.1L2 18l2.1.9L5 21l.9-2.1L8 18l-2.1-.9L5 15Z" />
    </>
  ),
  map: (
    <>
      <path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z" />
      <path d="M9 3v15M15 6v15" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 4h16v16H4z" />
      <path d="M4 14h4l2 3h4l2-3h4" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  arrow: (
    <>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  check: (
    <>
      <path d="m5 12 4 4L19 6" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  message: (
    <>
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z" />
    </>
  ),
  chevron: (
    <>
      <path d="m9 18 6-6-6-6" />
    </>
  ),
  menu: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </>
  ),
  x: (
    <>
      <path d="m6 6 12 12M18 6 6 18" />
    </>
  ),
  filter: (
    <>
      <path d="M4 5h16M7 12h10M10 19h4" />
    </>
  ),
  layers: (
    <>
      <path d="m12 2 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5M3 17l9 5 9-5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  building: (
    <>
      <path d="M3 21h18M6 21V5h8v16M14 9h4v12M9 8h2M9 12h2M9 16h2" />
    </>
  ),
  send: (
    <>
      <path d="m22 2-7 20-4-9-9-4 20-7Z" />
      <path d="M22 2 11 13" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
    >
      {iconPaths[name]}
    </svg>
  );
}

export function Status({
  tone,
  children,
}: {
  tone: Tone;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <span className={`status status-${tone}`}>
      <span className="status-dot" />
      {typeof children === "string" ? t(children) : children}
    </span>
  );
}

export function Button({
  children,
  variant = "primary",
  icon,
  onClick,
  type = "button",
  className = "",
  disabled = false,
  dataTour,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  icon?: IconName;
  onClick?: () => void;
  type?: "button" | "submit";
  className?: string;
  disabled?: boolean;
  dataTour?: string;
}) {
  const t = useT();
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`button button-${variant} ${className}`}
      data-tour={dataTour}
    >
      {icon && <Icon name={icon} size={16} />}
      {typeof children === "string" ? t(children) : children}
    </button>
  );
}

export function PageIntro({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  const t = useT();
  return (
    <header className="page-intro">
      <div>
        <p className="eyebrow">{t(eyebrow)}</p>
        <h2>{t(title)}</h2>
        <p>{t(description)}</p>
      </div>
      {action}
    </header>
  );
}

export function EmptyState({
  title,
  description,
  action,
  onAction,
}: {
  title: string;
  description: string;
  action: string;
  onAction: () => void;
}) {
  const t = useT();
  return (
    <div className="empty-state">
      <span>
        <Icon name="search" size={22} />
      </span>
      <h3>{t(title)}</h3>
      <p>{t(description)}</p>
      <Button variant="secondary" onClick={onAction}>
        {t(action)}
      </Button>
    </div>
  );
}

export function Drawer({
  children,
  onClose,
  wide = false,
}: {
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className="drawer-layer"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        className={`drawer ${wide ? "drawer-wide" : ""}`}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </aside>
    </div>
  );
}
