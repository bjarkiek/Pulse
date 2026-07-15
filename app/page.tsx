"use client";

import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import { ChatPanel } from "./chat-panel";

function mutationHeaders(json = true) {
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    "idempotency-key": crypto.randomUUID(),
  };
}

type Page =
  | "home"
  | "ideas"
  | "roadmap"
  | "requests"
  | "updates"
  | "triage"
  | "productIdeas"
  | "releases"
  | "audit"
  | "analytics"
  | "companies"
  | "users"
  | "authentication"
  | "settings";
type Tone = "success" | "warning" | "neutral" | "violet" | "error";

type Idea = {
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
type InternalIdea = Idea & {
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
type ReleaseItem = {
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
type AuditItem = {
  id: string;
  actor?: string;
  organizationId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  correlationId: string;
  createdAt: string;
};
type NotificationItem = {
  id: string;
  eventType: string;
  template: string;
  state: string;
  createdAt: string;
  readAt?: string;
  entityId?: string;
};
type NotificationPreferenceItem = {
  eventType: string;
  cadence: "Immediate" | "Daily" | "Weekly" | "Off";
  mandatory: boolean;
};
type ExternalLinkItem = {
  id: string;
  ideaId: string;
  label: string;
  url: string;
};
type WebhookSubscriptionItem = {
  id: string;
  url: string;
  events: string[];
  active: boolean;
};
type AnalyticsSummary = {
  requests: { total: number; open: number };
  serviceLevels: {
    averageFirstResponseHours: number;
    averageTriageHours: number;
  };
  notifications: Array<{ state: string; count: number }>;
  dataQuality: { missingOwner: number; missingClassification: number };
};
type SearchSuggestionItem = {
  id: string;
  title: string;
  description: string;
  area: string;
  status: string;
  tone: Tone;
  source: "Idea" | "Your request";
  why: string;
};

type RequestItem = {
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

type RequestAttachment = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanState: string;
  createdAt: string;
};
type RequestComment = {
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
type RequestHistoryItem = {
  id: string;
  action: string;
  actor?: string;
  after?: { status?: string };
  createdAt: string;
};

type Company = {
  id: string;
  name: string;
  type: "Customer" | "Partner" | "Internal";
  status: "Active" | "Onboarding" | "Inactive";
  domain: string;
  users: number;
  requests: number;
  authentication: ("OTP" | "Entra ID")[];
};

type UserMembership = {
  companyId: string;
  role: "Company admin" | "Requester" | "Viewer" | "Product manager";
};
type ManagedUser = {
  id: string;
  name: string;
  email: string;
  status: "Active" | "Invited" | "Suspended";
  authentication: "OTP" | "Entra ID";
  memberships: UserMembership[];
};

type PulseSettings = {
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

type OrganizationContext = {
  id: string;
  name: string;
  type: string;
  role: string;
};

type TaxonomyValue = {
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

const initialIdeas: Idea[] = [
  {
    id: "IDEA-318",
    title: "Audit log API",
    description:
      "Provide governed API access to tenant, authentication, report, and administrative audit events.",
    area: "Governance",
    status: "Planned",
    tone: "violet",
    horizon: "Next",
    organizations: 8,
    followers: 23,
    updated: "Updated 2 days ago",
    followed: true,
  },
  {
    id: "IDEA-327",
    title: "Scheduled report delivery to SharePoint",
    description:
      "Deliver governed PDF and Excel exports to a selected SharePoint library on a schedule.",
    area: "Distribution",
    status: "Under review",
    tone: "neutral",
    horizon: "Later",
    organizations: 5,
    followers: 14,
    updated: "Updated yesterday",
  },
  {
    id: "IDEA-301",
    title: "Display playlist scheduler",
    description:
      "Schedule screen playlists by day, time, tenant, and audience with clear override rules.",
    area: "Display",
    status: "In progress",
    tone: "violet",
    horizon: "Now",
    organizations: 6,
    followers: 18,
    updated: "Updated today",
    followed: true,
  },
  {
    id: "IDEA-284",
    title: "Self-service report keys",
    description:
      "Let delegated tenant administrators create and rotate report keys within governed policies.",
    area: "Administration",
    status: "Considering",
    tone: "neutral",
    horizon: "Later",
    organizations: 4,
    followers: 11,
    updated: "Updated 6 days ago",
  },
  {
    id: "IDEA-276",
    title: "Mobile dashboard improvements",
    description:
      "Improve navigation, filter behavior, and portrait layouts for embedded dashboards on mobile devices.",
    area: "Experience",
    status: "Released",
    tone: "success",
    horizon: "Released",
    organizations: 11,
    followers: 31,
    updated: "Released 8 July",
  },
  {
    id: "IDEA-312",
    title: "Entra group synchronization controls",
    description:
      "Add synchronization health, retry controls, and a clear history for group-based access changes.",
    area: "Authentication",
    status: "Planned",
    tone: "violet",
    horizon: "Next",
    organizations: 7,
    followers: 16,
    updated: "Updated 4 days ago",
  },
  {
    id: "IDEA-264",
    title: "Power BI app embedding",
    description:
      "Embed complete Power BI apps while preserving DataCentral authentication and access governance.",
    area: "Embedding",
    status: "Released",
    tone: "success",
    horizon: "Released",
    organizations: 9,
    followers: 27,
    updated: "Released 24 June",
  },
];

const initialRequests: RequestItem[] = [
  {
    id: "DCI-1042",
    title: "Custom branding for exported reports",
    problem:
      "Our external customers receive scheduled PDF reports. We need the export to use customer-specific logos and cover pages.",
    area: "Distribution",
    impact: "High",
    status: "Needs information",
    tone: "warning",
    visibility: "Organization",
    submitted: "10 Jul 2026",
    owner: "Óskar Jónsson",
  },
  {
    id: "DCI-1038",
    title: "Scheduled report delivery to SharePoint",
    problem:
      "Finance teams should receive governed report exports directly in their existing SharePoint libraries.",
    area: "Distribution",
    impact: "High",
    status: "Under review",
    tone: "neutral",
    visibility: "Organization",
    submitted: "3 Jul 2026",
    owner: "Filippus Jónsson",
    linkedIdea: "IDEA-327",
  },
  {
    id: "DCI-1019",
    title: "Audit log API",
    problem:
      "Our security team needs DataCentral events in the central SIEM without relying on manual export.",
    area: "Governance",
    impact: "Critical",
    status: "Planned",
    tone: "violet",
    visibility: "Organization",
    submitted: "14 Jun 2026",
    owner: "Bjarki Kristjánsson",
    linkedIdea: "IDEA-318",
  },
  {
    id: "DCI-1007",
    title: "Improve mobile dashboard navigation",
    problem:
      "Field managers struggle to move between dashboard pages and close the filter panel on iPhone.",
    area: "Experience",
    impact: "Medium",
    status: "Released",
    tone: "success",
    visibility: "Organization",
    submitted: "28 May 2026",
    owner: "Óskar Jónsson",
    linkedIdea: "IDEA-276",
  },
];

const initialCompanies: Company[] = [
  {
    id: "ORG-001",
    name: "Origo",
    type: "Customer",
    status: "Active",
    domain: "origo.is",
    users: 8,
    requests: 14,
    authentication: ["OTP", "Entra ID"],
  },
  {
    id: "ORG-002",
    name: "Landsnet",
    type: "Customer",
    status: "Active",
    domain: "landsnet.is",
    users: 12,
    requests: 9,
    authentication: ["Entra ID"],
  },
  {
    id: "ORG-003",
    name: "RARIK",
    type: "Customer",
    status: "Onboarding",
    domain: "rarik.is",
    users: 5,
    requests: 3,
    authentication: ["OTP", "Entra ID"],
  },
  {
    id: "ORG-004",
    name: "Crayon",
    type: "Partner",
    status: "Active",
    domain: "crayon.com",
    users: 4,
    requests: 7,
    authentication: ["Entra ID"],
  },
  {
    id: "ORG-005",
    name: "uiData",
    type: "Internal",
    status: "Active",
    domain: "uidata.com",
    users: 6,
    requests: 21,
    authentication: ["OTP", "Entra ID"],
  },
];

const initialManagedUsers: ManagedUser[] = [
  {
    id: "USR-101",
    name: "Bjarki Kristjánsson",
    email: "bjarki@uidata.com",
    status: "Active",
    authentication: "Entra ID",
    memberships: [
      { companyId: "ORG-001", role: "Company admin" },
      { companyId: "ORG-003", role: "Company admin" },
      { companyId: "ORG-005", role: "Product manager" },
    ],
  },
  {
    id: "USR-102",
    name: "Óskar Jónsson",
    email: "oskar@uidata.com",
    status: "Active",
    authentication: "Entra ID",
    memberships: [
      { companyId: "ORG-001", role: "Requester" },
      { companyId: "ORG-002", role: "Company admin" },
      { companyId: "ORG-005", role: "Product manager" },
    ],
  },
  {
    id: "USR-103",
    name: "Anna Guðmundsdóttir",
    email: "anna@origo.is",
    status: "Active",
    authentication: "Entra ID",
    memberships: [{ companyId: "ORG-001", role: "Company admin" }],
  },
  {
    id: "USR-104",
    name: "Jón Einarsson",
    email: "jon@landsnet.is",
    status: "Active",
    authentication: "OTP",
    memberships: [{ companyId: "ORG-002", role: "Requester" }],
  },
  {
    id: "USR-105",
    name: "Sara Magnúsdóttir",
    email: "sara@rarik.is",
    status: "Invited",
    authentication: "OTP",
    memberships: [{ companyId: "ORG-003", role: "Company admin" }],
  },
  {
    id: "USR-106",
    name: "Martin de Vries",
    email: "martin@crayon.com",
    status: "Active",
    authentication: "Entra ID",
    memberships: [
      { companyId: "ORG-001", role: "Viewer" },
      { companyId: "ORG-003", role: "Viewer" },
      { companyId: "ORG-004", role: "Company admin" },
    ],
  },
];

const navItems: { id: Page; label: string; icon: IconName }[] = [
  { id: "home", label: "Home", icon: "home" },
  { id: "ideas", label: "Browse ideas", icon: "spark" },
  { id: "roadmap", label: "Roadmap", icon: "map" },
  { id: "requests", label: "My requests", icon: "inbox" },
  { id: "updates", label: "Updates", icon: "bell" },
];

const pageTitles: Record<Page, string> = {
  home: "Home",
  ideas: "Browse ideas",
  roadmap: "Roadmap",
  requests: "My requests",
  updates: "Updates",
  triage: "Triage inbox",
  productIdeas: "Product ideas",
  releases: "Releases",
  audit: "Audit log",
  analytics: "Analytics",
  companies: "Companies",
  users: "Users",
  authentication: "Authentication",
  settings: "Settings",
};

type IconName =
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
  | "eye";

const iconPaths: Record<IconName, ReactNode> = {
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

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
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

function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`status status-${tone}`}>
      <span className="status-dot" />
      {children}
    </span>
  );
}

function Button({
  children,
  variant = "primary",
  icon,
  onClick,
  type = "button",
  className = "",
  disabled = false,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  icon?: IconName;
  onClick?: () => void;
  type?: "button" | "submit";
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`button button-${variant} ${className}`}
    >
      {icon && <Icon name={icon} size={16} />}
      {children}
    </button>
  );
}

function AppShell() {
  const [page, setPage] = useState<Page>("home");
  const [menuOpen, setMenuOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [detailRequest, setDetailRequest] = useState<RequestItem | null>(null);
  const [detailIdea, setDetailIdea] = useState<Idea | null>(null);
  const [ideas, setIdeas] = useState(initialIdeas);
  const [internalIdeas, setInternalIdeas] = useState<InternalIdea[]>([]);
  const [releases, setReleases] = useState<ReleaseItem[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [requests, setRequests] = useState(initialRequests);
  const [companies, setCompanies] = useState(initialCompanies);
  const [managedUsers, setManagedUsers] = useState(initialManagedUsers);
  const [toast, setToast] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [identityReady, setIdentityReady] = useState(false);
  const [organizationContexts, setOrganizationContexts] = useState<
    OrganizationContext[]
  >([]);
  // Set from /api/v1/me when this session was launched from inside the
  // DataCentral iframe. Cosmetic only — server authorization is unchanged.
  const [dcEmbed, setDcEmbed] = useState(false);
  // The /api/v1/me user payload (id/email/name/locale) — used to localize
  // the chat assistant panel.
  const [meUser, setMeUser] = useState<{
    id: string;
    email: string;
    name: string;
    locale: string;
  } | null>(null);
  // Bumped whenever the chat assistant reports it changed data server-side,
  // so identity-gated data-loading effects below refetch without a reload.
  const [dataVersion, setDataVersion] = useState(0);

  function openRequest(item: RequestItem) {
    setDetailRequest(item);
    const url = new URL(window.location.href);
    url.searchParams.set("request", item.id);
    window.history.replaceState({}, "", url);
  }

  function closeRequest() {
    setDetailRequest(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("request");
    window.history.replaceState({}, "", url);
  }

  useEffect(() => {
    fetch("/api/v1/me")
      .then(async (response) => {
        if (response.status === 401) {
          // Session missing/expired. Top-level: send the browser through the
          // login flow. Framed inside DataCentral: a top-level redirect would
          // just break the iframe, so reload and let the proxy route to
          // /dc-embed instead.
          if (window.self === window.top) {
            window.location.assign(
              "/auth/login?returnUrl=" +
                encodeURIComponent(
                  window.location.pathname + window.location.search,
                ),
            );
          } else {
            window.location.reload();
          }
          return null;
        }
        if (!response.ok) throw new Error("identity failed");
        return response.json();
      })
      .then(async (context) => {
        if (!context) return;
        setOrganizationContexts(context.organizations || []);
        setDcEmbed(Boolean(context.dcEmbed));
        setMeUser(context.user ?? null);
        const requested = new URLSearchParams(window.location.search).get(
          "organization",
        );
        const requestedIsAuthorized = context.organizations?.some(
          (organization: OrganizationContext) => organization.id === requested,
        );
        if (
          requested &&
          requestedIsAuthorized &&
          requested !== context.activeOrganizationId
        ) {
          const selected = await fetch("/api/v1/me/context", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ organizationId: requested }),
          });
          setIdentityReady(selected.ok);
          return;
        }
        setIdentityReady(Boolean(context.activeOrganizationId));
      })
      .catch(() =>
        setToast("Pulse could not resolve your organization access."),
      );
  }, []);

  useEffect(() => {
    if (!identityReady) return;
    const controller = new AbortController();
    fetch("/api/v1/requests", { signal: controller.signal })
      .then((response) =>
        response.ok
          ? response.json()
          : Promise.reject(new Error("load failed")),
      )
      .then((data) => setRequests(data.items))
      .catch((error) => {
        if (error.name !== "AbortError")
          setToast("Pulse is using the local preview data.");
      });
    return () => controller.abort();
  }, [identityReady, dataVersion]);

  useEffect(() => {
    if (detailRequest || !identityReady || !requests.length) return;
    const requestedId = new URLSearchParams(window.location.search).get(
      "request",
    );
    const requested = requests.find((item) => item.id === requestedId);
    if (requested) {
      const timer = window.setTimeout(() => setDetailRequest(requested), 0);
      return () => window.clearTimeout(timer);
    }
  }, [requests, detailRequest, identityReady]);

  useEffect(() => {
    if (!identityReady) return;
    const controller = new AbortController();
    Promise.all([
      fetch("/api/v1/internal/ideas", { signal: controller.signal }),
      fetch("/api/v1/internal/releases", { signal: controller.signal }),
      fetch("/api/v1/internal/audit?limit=100", { signal: controller.signal }),
    ])
      .then(async ([ideaResponse, releaseResponse, auditResponse]) => {
        if (ideaResponse.ok)
          setInternalIdeas((await ideaResponse.json()).items);
        if (releaseResponse.ok)
          setReleases((await releaseResponse.json()).items);
        if (auditResponse.ok) setAudit((await auditResponse.json()).items);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [identityReady, dataVersion]);

  useEffect(() => {
    if (!identityReady) return;
    const controller = new AbortController();
    Promise.all([
      fetch("/api/v1/admin/organizations", { signal: controller.signal }),
      fetch("/api/v1/admin/users", { signal: controller.signal }),
    ])
      .then(async ([organizationResponse, userResponse]) => {
        if (organizationResponse.ok)
          setCompanies((await organizationResponse.json()).items);
        if (userResponse.ok) setManagedUsers((await userResponse.json()).items);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [identityReady, dataVersion]);

  useEffect(() => {
    if (!identityReady) return;
    const controller = new AbortController();
    fetch("/api/v1/ideas", { signal: controller.signal })
      .then((response) =>
        response.ok
          ? response.json()
          : Promise.reject(new Error("load failed")),
      )
      .then((data) => setIdeas(data.items))
      .catch(() => {});
    return () => controller.abort();
  }, [identityReady, dataVersion]);

  useEffect(() => {
    if (toast) {
      const timer = window.setTimeout(() => setToast(null), 3200);
      return () => window.clearTimeout(timer);
    }
  }, [toast]);

  useEffect(() => {
    if (!identityReady) return;
    const controller = new AbortController();
    fetch("/api/v1/notifications", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((data) => setNotifications(data.items || []))
      .catch(() => {});
    return () => controller.abort();
  }, [identityReady, dataVersion]);

  function navigate(next: Page) {
    setPage(next);
    setMenuOpen(false);
    setNotificationsOpen(false);
  }

  function addRequest(request: RequestItem) {
    const next = [request, ...requests];
    setRequests(next);
    setComposerOpen(false);
    setPage("requests");
    setToast(`${request.id} was submitted for review.`);
  }

  async function followIdea(id: string, support = false) {
    const idea = ideas.find((item) => item.id === id);
    const response = await fetch(`/api/v1/ideas/${id}/follow`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ support }),
    });
    if (!response.ok) {
      setToast("The follow preference could not be changed.");
      return;
    }
    const result = await response.json();
    setIdeas((items) =>
      items.map((item) =>
        item.id === id
          ? { ...item, followed: result.followed, followers: result.followers }
          : item,
      ),
    );
    setToast(
      idea?.followed
        ? "You will no longer receive updates."
        : "You are now following this idea.",
    );
  }

  async function chooseOrganization(organizationId: string) {
    const response = await fetch("/api/v1/me/context", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId }),
    });
    if (!response.ok) {
      setToast("That organization context is no longer available.");
      return;
    }
    setIdentityReady(true);
  }

  if (!identityReady)
    return (
      <main className="context-gate">
        <Image
          src="/brand/datacentral-blacktext.svg"
          alt="DataCentral"
          width={160}
          height={30}
          priority
        />
        {organizationContexts.length > 1 ? (
          <section>
            <p className="eyebrow">DataCentral Pulse</p>
            <h1>Choose an organization</h1>
            <p>
              Your role and access are evaluated separately in each context.
            </p>
            <div>
              {organizationContexts.map((organization) => (
                <button
                  key={organization.id}
                  onClick={() => chooseOrganization(organization.id)}
                >
                  <strong>{organization.name}</strong>
                  <span>{organization.role}</span>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <p>Resolving your authorized organization…</p>
        )}
      </main>
    );

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand">
          <Image
            src="/brand/datacentral-blacktext.svg"
            alt="DataCentral"
            width={129}
            height={24}
            priority
          />
          <span>Pulse</span>
        </div>
        <nav className="nav" aria-label="Primary navigation">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              onClick={() => navigate(item.id)}
            >
              <Icon name={item.icon} size={17} />
              <span>{item.label}</span>
              {item.id === "updates" &&
                notifications.some((notification) => !notification.readAt) && (
                  <span className="nav-count">
                    {
                      notifications.filter(
                        (notification) => !notification.readAt,
                      ).length
                    }
                  </span>
                )}
            </button>
          ))}
          <div className="nav-section-label">DataCentral team</div>
          <button
            className={`nav-item ${page === "triage" ? "active" : ""}`}
            onClick={() => navigate("triage")}
          >
            <Icon name="layers" size={17} />
            <span>Triage inbox</span>
            <span className="nav-count">6</span>
          </button>
          <button
            className={`nav-item ${page === "productIdeas" ? "active" : ""}`}
            onClick={() => navigate("productIdeas")}
          >
            <Icon name="spark" size={17} />
            <span>Product ideas</span>
          </button>
          <button
            className={`nav-item ${page === "releases" ? "active" : ""}`}
            onClick={() => navigate("releases")}
          >
            <Icon name="check" size={17} />
            <span>Releases</span>
          </button>
          <button
            className={`nav-item ${page === "analytics" ? "active" : ""}`}
            onClick={() => navigate("analytics")}
          >
            <Icon name="map" size={17} />
            <span>Analytics</span>
          </button>
          <button
            className={`nav-item ${page === "companies" ? "active" : ""}`}
            onClick={() => navigate("companies")}
          >
            <Icon name="building" size={17} />
            <span>Companies</span>
          </button>
          <button
            className={`nav-item ${page === "users" ? "active" : ""}`}
            onClick={() => navigate("users")}
          >
            <Icon name="users" size={17} />
            <span>Users</span>
          </button>
          <button
            className={`nav-item ${page === "authentication" ? "active" : ""}`}
            onClick={() => navigate("authentication")}
          >
            <Icon name="settings" size={17} />
            <span>Authentication</span>
          </button>
          <button
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            onClick={() => navigate("settings")}
          >
            <Icon name="settings" size={17} />
            <span>Settings</span>
          </button>
          <button
            className={`nav-item ${page === "audit" ? "active" : ""}`}
            onClick={() => navigate("audit")}
          >
            <Icon name="clock" size={17} />
            <span>Audit log</span>
          </button>
        </nav>
        {!dcEmbed && (
          <div className="sidebar-profile">
            <div className="avatar">BK</div>
            <div className="profile-copy">
              <strong>Bjarki Kristjánsson</strong>
              <span>Origo · Customer admin</span>
            </div>
            <Icon name="chevron" size={15} />
          </div>
        )}
      </aside>

      {menuOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMenuOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <h1>{pageTitles[page]}</h1>
          </div>
          <div className="topbar-actions">
            {!dcEmbed && (
              <button className="workspace-switcher">
                <Icon name="building" size={15} />
                <span>Origo</span>
                <Icon name="chevron" size={13} />
              </button>
            )}
            <button
              className="icon-button notification-button"
              aria-label="Notifications"
              onClick={() => setNotificationsOpen(!notificationsOpen)}
            >
              <Icon name="bell" />
              <span />
            </button>
            <Button icon="plus" onClick={() => setComposerOpen(true)}>
              Submit a request
            </Button>
          </div>
          {notificationsOpen && (
            <NotificationsPopover
              items={notifications}
              onRead={async (id) => {
                await fetch(`/api/v1/notifications/${id}/read`, {
                  method: "POST",
                });
                setNotifications((items) =>
                  items.map((item) =>
                    item.id === id
                      ? { ...item, readAt: new Date().toISOString() }
                      : item,
                  ),
                );
              }}
              onOpenUpdates={() => navigate("updates")}
            />
          )}
        </header>

        <main className="content">
          {page === "home" && (
            <HomePage
              requests={requests}
              ideas={ideas}
              onSubmit={() => setComposerOpen(true)}
              onOpenRequest={openRequest}
              onOpenIdea={setDetailIdea}
              onNavigate={navigate}
              dcEmbed={dcEmbed}
            />
          )}
          {page === "ideas" && (
            <IdeasPage
              ideas={ideas}
              onOpen={setDetailIdea}
              onFollow={followIdea}
              onSubmit={() => setComposerOpen(true)}
            />
          )}
          {page === "roadmap" && (
            <RoadmapPage ideas={ideas} onOpen={setDetailIdea} />
          )}
          {page === "requests" && (
            <RequestsPage
              requests={requests}
              onOpen={openRequest}
              onSubmit={() => setComposerOpen(true)}
            />
          )}
          {page === "updates" && (
            <UpdatesPage
              ideas={ideas}
              notifications={notifications}
              onOpen={setDetailIdea}
            />
          )}
          {page === "triage" && (
            <TriagePage
              requests={requests}
              ideas={ideas}
              setRequests={setRequests}
              onToast={setToast}
            />
          )}
          {page === "productIdeas" && (
            <InternalIdeasPage
              ideas={internalIdeas}
              requests={requests}
              users={managedUsers}
              onChange={setInternalIdeas}
              onToast={setToast}
            />
          )}
          {page === "releases" && (
            <ReleasesPage
              releases={releases}
              ideas={internalIdeas}
              onChange={setReleases}
              onIdeasChange={setInternalIdeas}
              onToast={setToast}
            />
          )}
          {page === "audit" && <AuditPage items={audit} />}
          {page === "analytics" && (
            <AnalyticsPage
              requests={requests}
              ideas={ideas}
              onToast={setToast}
            />
          )}
          {page === "companies" && (
            <CompaniesPage
              companies={companies}
              users={managedUsers}
              onChange={setCompanies}
              onToast={setToast}
            />
          )}
          {page === "users" && (
            <UsersPage
              users={managedUsers}
              companies={companies}
              onChange={setManagedUsers}
              onToast={setToast}
            />
          )}
          {page === "authentication" && (
            <AuthenticationPage companies={companies} onToast={setToast} />
          )}
          {page === "settings" && <SettingsPage onToast={setToast} />}
        </main>
      </div>

      {composerOpen && (
        <RequestComposer
          onClose={() => setComposerOpen(false)}
          onSubmit={addRequest}
          onFollow={followIdea}
        />
      )}
      {detailRequest && (
        <RequestDrawer
          request={detailRequest}
          idea={ideas.find((idea) => idea.id === detailRequest.linkedIdea)}
          onClose={closeRequest}
          onToast={setToast}
          onChange={(updated) => {
            setRequests((items) =>
              items.map((item) => (item.id === updated.id ? updated : item)),
            );
            setDetailRequest(updated);
          }}
        />
      )}
      {detailIdea && (
        <IdeaDrawer
          idea={ideas.find((idea) => idea.id === detailIdea.id) || detailIdea}
          onClose={() => setDetailIdea(null)}
          onFollow={followIdea}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <span className="toast-icon">
            <Icon name="check" size={15} />
          </span>
          <span>{toast}</span>
        </div>
      )}
      <ChatPanel
        locale={meUser?.locale ?? "en"}
        onDataChanged={() => setDataVersion((v) => v + 1)}
      />
    </div>
  );
}

function HomePage({
  requests,
  ideas,
  onSubmit,
  onOpenRequest,
  onOpenIdea,
  onNavigate,
  dcEmbed,
}: {
  requests: RequestItem[];
  ideas: Idea[];
  onSubmit: () => void;
  onOpenRequest: (request: RequestItem) => void;
  onOpenIdea: (idea: Idea) => void;
  onNavigate: (page: Page) => void;
  dcEmbed: boolean;
}) {
  const [search, setSearch] = useState("");
  const matches =
    search.trim().length > 2
      ? ideas
          .filter((idea) =>
            `${idea.title} ${idea.description}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .slice(0, 3)
      : [];
  return (
    <div className="page-stack home-page">
      <section className="welcome-row">
        <div>
          <p className="eyebrow">Customer feedback</p>
          {!dcEmbed && <h2>Good morning, Bjarki</h2>}
          <p>
            Track your requests and help shape what DataCentral builds next.
          </p>
        </div>
        <div className="home-meta">
          <span>Last updated</span>
          <strong>14 July 2026 · 23:42Z</strong>
        </div>
      </section>

      <section className="ask-card">
        <div className="ask-copy">
          <div className="ask-icon">
            <Icon name="spark" size={22} />
          </div>
          <div>
            <h3>What would make DataCentral work better for your team?</h3>
            <p>Search existing ideas or describe a new requirement.</p>
          </div>
        </div>
        <div className="ask-search-row">
          <div className="search-input large">
            <Icon name="search" size={18} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search ideas and requests"
              aria-label="Search ideas and requests"
            />
          </div>
          <Button icon="plus" onClick={onSubmit}>
            Submit a request
          </Button>
        </div>
        {matches.length > 0 && (
          <div className="quick-results">
            <span>Related ideas</span>
            {matches.map((idea) => (
              <button key={idea.id} onClick={() => onOpenIdea(idea)}>
                <strong>{idea.title}</strong>
                <Status tone={idea.tone}>{idea.status}</Status>
                <Icon name="arrow" size={15} />
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="metric-grid">
        <button className="metric-card" onClick={() => onNavigate("requests")}>
          <div className="metric-icon">
            <Icon name="inbox" />
          </div>
          <div>
            <span>Active requests</span>
            <strong>
              {
                requests.filter(
                  (r) => !["Released", "Closed"].includes(r.status),
                ).length
              }
            </strong>
            <small>Across your organization</small>
          </div>
          <Icon name="chevron" size={16} />
        </button>
        <button
          className="metric-card warning"
          onClick={() => onNavigate("requests")}
        >
          <div className="metric-icon">
            <Icon name="message" />
          </div>
          <div>
            <span>Needs your input</span>
            <strong>
              {requests.filter((r) => r.status === "Needs information").length}
            </strong>
            <small>Response requested</small>
          </div>
          <Icon name="chevron" size={16} />
        </button>
        <button className="metric-card" onClick={() => onNavigate("updates")}>
          <div className="metric-icon">
            <Icon name="check" />
          </div>
          <div>
            <span>Recently released</span>
            <strong>
              {ideas.filter((i) => i.status === "Released").length}
            </strong>
            <small>In the last 30 days</small>
          </div>
          <Icon name="chevron" size={16} />
        </button>
      </section>

      <section className="home-grid">
        <div className="panel">
          <div className="panel-header">
            <div>
              <h3>Your requests</h3>
              <p>Latest activity from Origo</p>
            </div>
            <button
              className="text-link"
              onClick={() => onNavigate("requests")}
            >
              View all <Icon name="arrow" size={14} />
            </button>
          </div>
          <div className="request-list">
            {requests.slice(0, 3).map((request) => (
              <button
                className="request-row"
                key={request.id}
                onClick={() => onOpenRequest(request)}
              >
                <div className="request-state-icon">
                  <Icon
                    name={
                      request.status === "Needs information"
                        ? "message"
                        : request.status === "Planned"
                          ? "map"
                          : "clock"
                    }
                    size={17}
                  />
                </div>
                <div className="request-main">
                  <strong>{request.title}</strong>
                  <span>
                    <code>{request.id}</code> · {request.area} · Updated{" "}
                    {request.id === "DCI-1042" ? "today" : "3 days ago"}
                  </span>
                </div>
                <Status tone={request.tone}>{request.status}</Status>
                <Icon name="chevron" size={16} />
              </button>
            ))}
          </div>
        </div>
        <div className="panel shipped-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Recently shipped</p>
              <h3>Mobile dashboard improvements</h3>
            </div>
            <span className="release-mark">
              <Icon name="check" size={17} />
            </span>
          </div>
          <p>
            Navigation, filters, and portrait layouts now work more consistently
            across embedded mobile dashboards.
          </p>
          <div className="release-details">
            <span>Released</span>
            <code>8 JUL 2026</code>
          </div>
          <button
            className="text-link"
            onClick={() => onOpenIdea(ideas.find((i) => i.id === "IDEA-276")!)}
          >
            View release notes <Icon name="arrow" size={14} />
          </button>
        </div>
      </section>
    </div>
  );
}

function IdeasPage({
  ideas,
  onOpen,
  onFollow,
  onSubmit,
}: {
  ideas: Idea[];
  onOpen: (idea: Idea) => void;
  onFollow: (id: string) => void;
  onSubmit: () => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All statuses");
  const filtered = ideas.filter(
    (idea) =>
      `${idea.title} ${idea.description} ${idea.area}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (status === "All statuses" || idea.status === status),
  );
  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Product ideas"
        title="Browse customer-driven ideas"
        description="See what DataCentral is reviewing, planning, and delivering. Follow an idea to receive meaningful updates."
        action={
          <Button icon="plus" onClick={onSubmit}>
            Submit a request
          </Button>
        }
      />
      <div className="toolbar">
        <div className="search-input">
          <Icon name="search" size={17} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ideas"
          />
        </div>
        <label className="select-wrap">
          <Icon name="filter" size={16} />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option>All statuses</option>
            <option>Under review</option>
            <option>Considering</option>
            <option>Planned</option>
            <option>In progress</option>
            <option>Released</option>
          </select>
        </label>
        <span className="result-count">{filtered.length} ideas</span>
      </div>
      <div className="idea-grid">
        {filtered.map((idea) => (
          <article className="idea-card" key={idea.id}>
            <div className="idea-card-top">
              <Status tone={idea.tone}>{idea.status}</Status>
              <code>{idea.id}</code>
            </div>
            <button className="idea-title" onClick={() => onOpen(idea)}>
              {idea.title}
            </button>
            <p>{idea.description}</p>
            <div className="idea-tags">
              <span>{idea.area}</span>
              <span>{idea.horizon}</span>
            </div>
            <div className="idea-footer">
              <div>
                <Icon name="building" size={15} />
                <span>{idea.organizations} organizations</span>
              </div>
              <button
                className={idea.followed ? "following" : ""}
                onClick={() => onFollow(idea.id)}
              >
                <Icon name={idea.followed ? "check" : "bell"} size={14} />
                {idea.followed ? "Following" : "Follow"}
              </button>
            </div>
          </article>
        ))}
        {filtered.length === 0 && (
          <EmptyState
            title="No ideas match these filters"
            description="Adjust the search or submit the requirement your team needs."
            action="Submit a request"
            onAction={onSubmit}
          />
        )}
      </div>
    </div>
  );
}

function RoadmapPage({
  ideas,
  onOpen,
}: {
  ideas: Idea[];
  onOpen: (idea: Idea) => void;
}) {
  const columns: { title: Idea["horizon"]; note: string }[] = [
    { title: "Now", note: "Active delivery" },
    { title: "Next", note: "Approved and sequenced" },
    { title: "Later", note: "Validated, not committed" },
  ];
  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Directional roadmap"
        title="Where the product is heading"
        description="Roadmap horizons express current intent and may change as customer evidence and delivery constraints evolve."
      />
      <div className="roadmap-callout">
        <Icon name="map" size={19} />
        <div>
          <strong>Built from governed customer evidence</strong>
          <span>
            Roadmap items combine related requests while keeping each customer’s
            context private.
          </span>
        </div>
      </div>
      <div className="roadmap-board">
        {columns.map((column) => (
          <section className="roadmap-column" key={column.title}>
            <header>
              <div>
                <h3>{column.title}</h3>
                <p>{column.note}</p>
              </div>
              <span>
                {ideas.filter((i) => i.horizon === column.title).length}
              </span>
            </header>
            <div className="roadmap-items">
              {ideas
                .filter((i) => i.horizon === column.title)
                .map((idea) => (
                  <button
                    className="roadmap-card"
                    key={idea.id}
                    onClick={() => onOpen(idea)}
                  >
                    <div>
                      <Status tone={idea.tone}>{idea.status}</Status>
                      <code>{idea.id}</code>
                    </div>
                    <strong>{idea.title}</strong>
                    <p>{idea.description}</p>
                    <footer>
                      <span>{idea.area}</span>
                      <span>
                        <Icon name="building" size={13} /> {idea.organizations}
                      </span>
                    </footer>
                  </button>
                ))}
            </div>
          </section>
        ))}
      </div>
      <section className="released-strip">
        <div>
          <p className="eyebrow">Released</p>
          <h3>Recently delivered</h3>
        </div>
        {ideas
          .filter((i) => i.horizon === "Released")
          .map((idea) => (
            <button key={idea.id} onClick={() => onOpen(idea)}>
              <span className="release-mark">
                <Icon name="check" size={14} />
              </span>
              <span>
                <strong>{idea.title}</strong>
                <small>{idea.updated}</small>
              </span>
              <Icon name="chevron" size={15} />
            </button>
          ))}
      </section>
    </div>
  );
}

function RequestsPage({
  requests,
  onOpen,
  onSubmit,
}: {
  requests: RequestItem[];
  onOpen: (request: RequestItem) => void;
  onSubmit: () => void;
}) {
  const [filter, setFilter] = useState("All");
  const [query, setQuery] = useState("");
  const [area, setArea] = useState("All areas");
  const [filtersHydrated, setFiltersHydrated] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      setFilter(params.get("status") || "All");
      setQuery(params.get("q") || "");
      setArea(params.get("area") || "All areas");
      setFiltersHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!filtersHydrated) return;
    const params = new URLSearchParams(window.location.search);
    if (filter === "All") params.delete("status");
    else params.set("status", filter);
    if (query.trim()) params.set("q", query.trim());
    else params.delete("q");
    if (area === "All areas") params.delete("area");
    else params.set("area", area);
    const next = `${window.location.pathname}${params.size ? `?${params}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", next);
  }, [filter, query, area, filtersHydrated]);
  const visible = requests.filter((request) => {
    const statusMatch =
      filter === "All" ||
      (filter === "Active"
        ? !["Closed", "Withdrawn"].includes(request.status)
        : request.status === filter);
    const areaMatch = area === "All areas" || request.area === area;
    const searchMatch = `${request.id} ${request.title} ${request.problem}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase());
    return statusMatch && areaMatch && searchMatch;
  });
  const areas = [
    "All areas",
    ...Array.from(new Set(requests.map((request) => request.area))).sort(),
  ];
  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Your organization"
        title="Requests from Origo"
        description="Every request keeps its original context, status history, and link to the corresponding product idea."
        action={
          <Button icon="plus" onClick={onSubmit}>
            Submit a request
          </Button>
        }
      />
      <div className="tabs" role="tablist">
        {["All", "Active", "Needs information", "Closed"].map((tab) => (
          <button
            key={tab}
            className={filter === tab ? "active" : ""}
            onClick={() => setFilter(tab)}
          >
            {tab}
            <span>
              {tab === "All"
                ? requests.length
                : requests.filter((r) =>
                    tab === "Active"
                      ? !["Closed", "Withdrawn"].includes(r.status)
                      : r.status === tab,
                  ).length}
            </span>
          </button>
        ))}
      </div>
      <div className="toolbar">
        <label className="search-input">
          <Icon name="search" size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search request number, title, or problem"
            aria-label="Search requests"
          />
        </label>
        <label className="select-control">
          <Icon name="filter" size={15} />
          <select
            value={area}
            onChange={(event) => setArea(event.target.value)}
            aria-label="Filter by product area"
          >
            {areas.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <span className="result-count">{visible.length} requests</span>
      </div>
      <div className="table-panel">
        <div className="table-head">
          <span>Request</span>
          <span>Product area</span>
          <span>Submitted</span>
          <span>Status</span>
          <span />
        </div>
        {visible.map((request) => (
          <button
            className="table-row"
            key={request.id}
            onClick={() => onOpen(request)}
          >
            <span>
              <strong>{request.title}</strong>
              <code>{request.id}</code>
            </span>
            <span>{request.area}</span>
            <code>{request.submitted}</code>
            <Status tone={request.tone}>{request.status}</Status>
            <Icon name="chevron" size={15} />
          </button>
        ))}
        {visible.length === 0 && (
          <EmptyState
            title="No requests match these filters"
            description="Try a different phrase, product area, or status."
            action="Clear filters"
            onAction={() => {
              setFilter("All");
              setArea("All areas");
              setQuery("");
            }}
          />
        )}
      </div>
    </div>
  );
}

function UpdatesPage({
  ideas,
  notifications,
  onOpen,
}: {
  ideas: Idea[];
  notifications: NotificationItem[];
  onOpen: (idea: Idea) => void;
}) {
  const [preferences, setPreferences] = useState<NotificationPreferenceItem[]>(
    [],
  );
  const [preferenceStatus, setPreferenceStatus] = useState("");
  useEffect(() => {
    fetch("/api/v1/notifications/preferences", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((data) => setPreferences(data.items || []))
      .catch(() => setPreferences([]));
  }, []);

  async function updatePreference(eventType: string, cadence: string) {
    setPreferenceStatus("Saving…");
    const response = await fetch("/api/v1/notifications/preferences", {
      method: "PATCH",
      headers: mutationHeaders(),
      body: JSON.stringify({ eventType, cadence }),
    });
    if (!response.ok) {
      setPreferenceStatus("Could not save this preference.");
      return;
    }
    const saved = (await response.json()) as NotificationPreferenceItem;
    setPreferences((items) =>
      items.map((item) =>
        item.eventType === eventType ? saved : item,
      ),
    );
    setPreferenceStatus("Preferences saved.");
  }

  const durableEntries = notifications.map((notification) => ({
    date: new Date(notification.createdAt).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
    }),
    title: notification.eventType
      .replaceAll(".", " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase()),
    text: `${notification.template.replaceAll("-", " ")} · ${notification.state}`,
    idea: undefined,
    tone: (notification.eventType.includes("release")
      ? "success"
      : notification.eventType.includes("needs")
        ? "warning"
        : "violet") as Tone,
  }));
  const entries = durableEntries.length
    ? durableEntries
    : [
        {
          date: "14 Jul",
          title: "Display playlist scheduler moved to In progress",
          text: "Delivery work has started. The first release focuses on recurring schedules and tenant-level overrides.",
          idea: ideas.find((i) => i.id === "IDEA-301")!,
          tone: "violet" as Tone,
        },
        {
          date: "12 Jul",
          title: "Audit log API is planned",
          text: "The initial scope covers administrative, authentication, and report-access events with cursor-based retrieval.",
          idea: ideas.find((i) => i.id === "IDEA-318")!,
          tone: "violet" as Tone,
        },
        {
          date: "8 Jul",
          title: "Mobile dashboard improvements released",
          text: "The updated mobile experience is available to all tenants. No configuration change is required.",
          idea: ideas.find((i) => i.id === "IDEA-276")!,
          tone: "success" as Tone,
        },
        {
          date: "4 Jul",
          title: "More context requested",
          text: "We need an example of how customer branding should be selected for scheduled exports.",
          idea: undefined,
          tone: "warning" as Tone,
        },
      ];
  return (
    <div className="page-stack updates-layout">
      <PageIntro
        eyebrow="Product updates"
        title="Changes that matter to your team"
        description="A focused record of decisions, progress, and releases for requests you follow."
      />
      <section className="notification-preferences" aria-labelledby="notification-preferences-title">
        <header>
          <div>
            <h3 id="notification-preferences-title">Notification preferences</h3>
            <p>Choose when email updates arrive for this company context.</p>
          </div>
          <span role="status">{preferenceStatus}</span>
        </header>
        <div>
          {preferences.map((preference) => (
            <label key={preference.eventType}>
              <span>
                <strong>
                  {preference.eventType
                    .replaceAll(".", " ")
                    .replace(/\b\w/g, (letter) => letter.toUpperCase())}
                </strong>
                <small>
                  {preference.mandatory
                    ? "Mandatory service message · delivered immediately"
                    : "In-app updates remain available in Pulse"}
                </small>
              </span>
              <select
                aria-label={`${preference.eventType} email cadence`}
                value={preference.cadence}
                disabled={preference.mandatory}
                onChange={(event) =>
                  updatePreference(preference.eventType, event.target.value)
                }
              >
                <option>Immediate</option>
                <option>Daily</option>
                <option>Weekly</option>
                <option>Off</option>
              </select>
            </label>
          ))}
        </div>
      </section>
      <div className="updates-feed">
        {entries.map((entry, index) => (
          <article className="update-item" key={entry.title}>
            <div className={`timeline-dot ${entry.tone}`}>
              <Icon
                name={
                  entry.tone === "success"
                    ? "check"
                    : entry.tone === "warning"
                      ? "message"
                      : "spark"
                }
                size={15}
              />
            </div>
            <div className="update-body">
              <div className="update-meta">
                <code>{entry.date.toUpperCase()} 2026</code>
                {entry.idea && (
                  <Status tone={entry.idea.tone}>{entry.idea.status}</Status>
                )}
              </div>
              <h3>{entry.title}</h3>
              <p>{entry.text}</p>
              {entry.idea && (
                <button
                  className="text-link"
                  onClick={() => onOpen(entry.idea!)}
                >
                  View product idea <Icon name="arrow" size={14} />
                </button>
              )}
            </div>
            {index < entries.length - 1 && <span className="timeline-line" />}
          </article>
        ))}
      </div>
    </div>
  );
}

function TriagePage({
  requests,
  ideas,
  setRequests,
  onToast,
}: {
  requests: RequestItem[];
  ideas: Idea[];
  setRequests: (items: RequestItem[]) => void;
  onToast: (message: string) => void;
}) {
  const queue = useMemo(
    () => [
      ...requests,
      {
        id: "DCI-1048",
        title: "Role templates across tenants",
        problem:
          "Our managed customers need a consistent starting set of roles whenever a new tenant is provisioned.",
        area: "Administration",
        impact: "High",
        status: "Submitted",
        tone: "neutral" as Tone,
        visibility: "Organization",
        submitted: "14 Jul 2026",
        owner: "Unassigned",
      },
    ],
    [requests],
  );
  const [selectedId, setSelectedId] = useState(queue[0]?.id);
  const selected = queue.find((r) => r.id === selectedId) || queue[0];
  const [note, setNote] = useState("");
  async function addInternalNote() {
    if (!note.trim()) return;
    const response = await fetch(`/api/v1/requests/${selected.id}/comments`, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ body: note, visibility: "Internal" }),
    });
    if (!response.ok) {
      onToast("The internal note could not be saved.");
      return;
    }
    setNote("");
    onToast("Internal note added.");
  }
  async function updateStatus(
    status: string,
    tone: Tone,
    details: { explanation?: string; supportReference?: string } = {},
  ) {
    const response = await fetch(`/api/v1/requests/${selected.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, ...details }),
    });
    if (!response.ok) {
      onToast("The request could not be updated.");
      return;
    }
    const updated = requests.some((r) => r.id === selected.id)
      ? requests.map((r) =>
          r.id === selected.id
            ? { ...r, status, tone, owner: "Bjarki Kristjánsson" }
            : r,
        )
      : [
          { ...selected, status, tone, owner: "Bjarki Kristjánsson" },
          ...requests,
        ];
    setRequests(updated);
    onToast(`${selected.id} was updated to ${status}.`);
  }
  async function linkSuggestedIdea() {
    const idea = ideas[0];
    if (!idea) {
      onToast("Create a canonical idea before linking this request.");
      return;
    }
    const response = await fetch(`/api/v1/internal/ideas/${idea.id}/links`, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({
        requestId: selected.id,
        reason: "Confirmed as supporting the suggested canonical idea",
      }),
    });
    if (!response.ok) {
      onToast("The request-to-idea link could not be created.");
      return;
    }
    const updated = requests.map((request) =>
      request.id === selected.id
        ? {
            ...request,
            status: "Linked",
            tone: "violet" as Tone,
            linkedIdea: idea.id,
          }
        : request,
    );
    setRequests(updated);
    onToast(`${selected.id} was transactionally linked to ${idea.id}.`);
  }
  async function requestInformation() {
    const question = window
      .prompt("What information does the customer need to provide?")
      ?.trim();
    if (!question) return;
    const comment = await fetch(`/api/v1/requests/${selected.id}/comments`, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ body: question, visibility: "Customer" }),
    });
    if (!comment.ok) {
      onToast("The customer question could not be saved.");
      return;
    }
    await updateStatus("Needs information", "warning");
  }
  async function closeRequest() {
    const explanation = window
      .prompt("Customer-safe closure explanation")
      ?.trim();
    if (!explanation) return;
    await updateStatus("Closed", "neutral", { explanation });
  }
  async function routeToSupport() {
    const supportReference = window
      .prompt("Support case URL or reference")
      ?.trim();
    if (!supportReference) return;
    await updateStatus("Routed to support", "neutral", {
      supportReference,
      explanation:
        "This request is being handled through the customer support process.",
    });
  }
  async function bulkAssignVisible() {
    const requestIds = requests
      .filter((item) => ["Submitted", "Needs information"].includes(item.status))
      .slice(0, 6)
      .map((item) => item.id);
    if (!requestIds.length) {
      onToast("There are no visible unresolved requests to assign.");
      return;
    }
    const response = await fetch("/api/v1/internal/triage/bulk", {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ requestIds, ownerId: "me" }),
    });
    if (!response.ok) {
      onToast("The bulk assignment could not be completed.");
      return;
    }
    setRequests(
      requests.map((item) =>
        requestIds.includes(item.id)
          ? { ...item, owner: "Assigned to me" }
          : item,
      ),
    );
    onToast(`${requestIds.length} requests assigned in one audited operation.`);
  }
  return (
    <div className="triage-page">
      <div className="triage-summary">
        <div>
          <p className="eyebrow">Product workspace</p>
          <h2>Review customer evidence</h2>
          <p>Classify, consolidate, and communicate every request.</p>
        </div>
        <div className="triage-metrics">
          <span>
            <strong>6</strong> untriaged
          </span>
          <span>
            <strong>2</strong> overdue
          </span>
          <span>
            <strong>1.8d</strong> median triage
          </span>
        </div>
      </div>
      <div className="triage-workspace">
        <aside className="triage-queue">
          <div className="queue-toolbar">
            <div className="search-input">
              <Icon name="search" size={15} />
              <input placeholder="Search queue" />
            </div>
            <button className="icon-button">
              <Icon name="filter" size={16} />
            </button>
          </div>
          <div className="queue-tabs">
            <button className="active">
              Untriaged <span>6</span>
            </button>
            <button>
              Assigned to me <span>3</span>
            </button>
          </div>
          <div className="bulk-triage-actions">
            <span>Bulk actions never close or publish requests.</span>
            <Button variant="secondary" onClick={bulkAssignVisible}>
              Assign visible to me
            </Button>
          </div>
          <div className="queue-list">
            {queue.slice(0, 6).map((request) => (
              <button
                key={request.id}
                className={selected.id === request.id ? "active" : ""}
                onClick={() => setSelectedId(request.id)}
              >
                <div>
                  <code>{request.id}</code>
                  <span>{request.submitted}</span>
                </div>
                <strong>{request.title}</strong>
                <p>{request.problem}</p>
                <footer>
                  <span>{request.area}</span>
                  <Status tone={request.tone}>{request.status}</Status>
                </footer>
              </button>
            ))}
          </div>
        </aside>
        <section className="triage-detail">
          <div className="triage-detail-head">
            <div>
              <div className="record-meta">
                <code>{selected.id}</code>
                <span>Submitted by Origo</span>
                <span>{selected.submitted}</span>
              </div>
              <h2>{selected.title}</h2>
            </div>
            <button className="icon-button">
              <Icon name="settings" size={17} />
            </button>
          </div>
          <div className="triage-detail-grid">
            <div className="evidence-column">
              <section>
                <p className="field-label">Customer problem</p>
                <p className="evidence-text">{selected.problem}</p>
              </section>
              <section className="context-grid">
                <div>
                  <p className="field-label">Impact</p>
                  <strong>{selected.impact}</strong>
                </div>
                <div>
                  <p className="field-label">Product area</p>
                  <strong>{selected.area}</strong>
                </div>
                <div>
                  <p className="field-label">Visibility</p>
                  <strong>{selected.visibility}</strong>
                </div>
                <div>
                  <p className="field-label">Owner</p>
                  <strong>{selected.owner}</strong>
                </div>
              </section>
              <section>
                <div className="section-title">
                  <div>
                    <p className="field-label">Related product ideas</p>
                    <span>Suggested from title and context</span>
                  </div>
                </div>
                <div className="suggestion-list">
                  {ideas
                    .filter(
                      (i) =>
                        i.area === selected.area ||
                        selected.title
                          .toLowerCase()
                          .includes(i.title.split(" ")[0].toLowerCase()),
                    )
                    .slice(0, 2)
                    .map((idea) => (
                      <button key={idea.id}>
                        <div>
                          <Status tone={idea.tone}>{idea.status}</Status>
                          <code>{idea.id}</code>
                        </div>
                        <strong>{idea.title}</strong>
                        <span>
                          {idea.organizations} organizations · {idea.area}
                        </span>
                        <Icon name="link" size={16} />
                      </button>
                    ))}
                  {ideas.filter((i) => i.area === selected.area).length ===
                    0 && (
                    <div className="no-suggestion">
                      No strong match. Create a canonical product idea.
                    </div>
                  )}
                </div>
              </section>
              <section>
                <p className="field-label">Internal note</p>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Add evidence, constraints, or a decision rationale"
                />
                <div className="note-actions">
                  <span>Internal only</span>
                  <Button
                    variant="secondary"
                    icon="send"
                    disabled={!note.trim()}
                    onClick={addInternalNote}
                  >
                    Add note
                  </Button>
                </div>
              </section>
            </div>
            <aside className="decision-panel">
              <p className="field-label">Triage decision</p>
              <h3>Choose the next step</h3>
              <p>
                This updates the customer-visible request and records the
                decision.
              </p>
              <button
                onClick={() =>
                  onToast(
                    "Discovery started internally; the customer status remains Submitted until a publishable decision is made.",
                  )
                }
              >
                <span className="decision-icon">
                  <Icon name="search" size={17} />
                </span>
                <span>
                  <strong>Start discovery</strong>
                  <small>Valid problem; investigate options</small>
                </span>
                <Icon name="chevron" size={15} />
              </button>
              <button onClick={linkSuggestedIdea}>
                <span className="decision-icon">
                  <Icon name="link" size={17} />
                </span>
                <span>
                  <strong>Link to product idea</strong>
                  <small>Consolidate with existing demand</small>
                </span>
                <Icon name="chevron" size={15} />
              </button>
              <button onClick={requestInformation}>
                <span className="decision-icon">
                  <Icon name="message" size={17} />
                </span>
                <span>
                  <strong>Request information</strong>
                  <small>Ask the customer a clear question</small>
                </span>
                <Icon name="chevron" size={15} />
              </button>
              <button onClick={routeToSupport}>
                <span className="decision-icon">
                  <Icon name="message" size={17} />
                </span>
                <span>
                  <strong>Route to support</strong>
                  <small>Record the destination case reference</small>
                </span>
                <Icon name="chevron" size={15} />
              </button>
              <button onClick={closeRequest}>
                <span className="decision-icon">
                  <Icon name="x" size={17} />
                </span>
                <span>
                  <strong>Close request</strong>
                  <small>Requires a customer explanation</small>
                </span>
                <Icon name="chevron" size={15} />
              </button>
            </aside>
          </div>
        </section>
      </div>
    </div>
  );
}

function PageIntro({
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
  return (
    <header className="page-intro">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}

function EmptyState({
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
  return (
    <div className="empty-state">
      <span>
        <Icon name="search" size={22} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      <Button variant="secondary" onClick={onAction}>
        {action}
      </Button>
    </div>
  );
}

function RequestComposer({
  onClose,
  onSubmit,
  onFollow,
}: {
  onClose: () => void;
  onSubmit: (request: RequestItem) => void;
  onFollow: (id: string, support?: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const [problem, setProblem] = useState("");
  const [area, setArea] = useState("Distribution");
  const [impact, setImpact] = useState("High");
  const [visibility, setVisibility] = useState("Organization");
  const [requestType, setRequestType] = useState("Feature");
  const [affectedUsers, setAffectedUsers] = useState("");
  const [workaround, setWorkaround] = useState("");
  const [desiredTiming, setDesiredTiming] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [suggestions, setSuggestions] = useState<SearchSuggestionItem[]>([]);
  const [linkedIdeaId, setLinkedIdeaId] = useState("");
  const [dismissedQuery, setDismissedQuery] = useState("");
  const suggestionQuery = `${title} ${problem}`.trim();
  const visibleSuggestions =
    suggestionQuery.length >= 4 && dismissedQuery !== suggestionQuery
      ? suggestions
      : [];
  useEffect(() => {
    const query = `${title} ${problem}`.trim();
    if (query.length < 4 || dismissedQuery === query) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: query, area });
      fetch(`/api/v1/search/suggestions?${params}`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then((response) => (response.ok ? response.json() : { items: [] }))
        .then((data) => setSuggestions(data.items || []))
        .catch(() => undefined);
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [title, problem, area, dismissedQuery]);
  useEffect(() => {
    const saved = window.localStorage.getItem("pulse-request-draft");
    const timer = window.setTimeout(() => {
      if (saved) {
        try {
          const draft = JSON.parse(saved);
          setTitle(draft.title || "");
          setProblem(draft.problem || "");
          setArea(draft.area || "Distribution");
          setImpact(draft.impact || "High");
          setVisibility(draft.visibility || "Organization");
          setLinkedIdeaId(draft.linkedIdeaId || "");
          setRequestType(draft.requestType || "Feature");
          setAffectedUsers(draft.affectedUsers || "");
          setWorkaround(draft.workaround || "");
          setDesiredTiming(draft.desiredTiming || "");
        } catch {
          /* ignore an invalid device-local draft */
        }
      }
      fetch("/api/v1/requests/draft")
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          const draft = data?.item;
          if (!draft) return;
          setTitle(draft.title || "");
          setProblem(draft.problem || "");
          setArea(draft.area || "Distribution");
          setImpact(draft.impact || "High");
          setVisibility(draft.visibility || "Organization");
          setLinkedIdeaId(draft.linkedIdeaId || "");
          setRequestType(draft.requestType || "Feature");
          setAffectedUsers(draft.affectedUsers || "");
          setWorkaround(draft.workaround || "");
          setDesiredTiming(draft.desiredTiming || "");
        })
        .catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!title.trim() && !problem.trim()) return;
    const timer = window.setTimeout(async () => {
      window.localStorage.setItem(
        "pulse-request-draft",
        JSON.stringify({
          title,
          problem,
          area,
          impact,
          visibility,
          requestType,
          affectedUsers,
          workaround,
          desiredTiming,
          linkedIdeaId: linkedIdeaId || undefined,
        }),
      );
      await fetch("/api/v1/requests/draft", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          problem,
          area,
          impact,
          visibility,
          linkedIdeaId: linkedIdeaId || undefined,
          requestType,
          affectedUsers: affectedUsers ? Number(affectedUsers) : undefined,
          workaround,
          desiredTiming,
        }),
      }).catch(() => undefined);
    }, 10000);
    return () => window.clearTimeout(timer);
  }, [
    title,
    problem,
    area,
    impact,
    visibility,
    linkedIdeaId,
    requestType,
    affectedUsers,
    workaround,
    desiredTiming,
  ]);
  function addFiles(incoming: FileList | File[]) {
    const next = Array.from(incoming).filter(
      (file) => file.size <= 25 * 1024 * 1024,
    );
    setFiles((current) => [...current, ...next].slice(0, 10));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !problem.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/v1/requests", {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({
          title,
          problem,
          area,
          impact,
          visibility,
          linkedIdeaId: linkedIdeaId || undefined,
          requestType,
          affectedUsers: affectedUsers ? Number(affectedUsers) : undefined,
          workaround,
          desiredTiming,
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data?.error?.message || "Request submission failed");
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const init = await fetch(
          `/api/v1/requests/${data.item.id}/attachments`,
          {
            method: "POST",
            headers: mutationHeaders(),
            body: JSON.stringify({
              fileName: file.name,
              contentType: file.type || "application/octet-stream",
              sizeBytes: file.size,
            }),
          },
        );
        const target = await init.json();
        if (!init.ok)
          throw new Error(
            target?.error?.message || `Could not prepare ${file.name}`,
          );
        const upload = await fetch(target.uploadUrl, {
          method: "PUT",
          headers: {
            "content-type": file.type || "application/octet-stream",
            ...(target.uploadUrl.startsWith("http")
              ? { "x-ms-blob-type": "BlockBlob" }
              : {}),
          },
          body: file,
        });
        if (!upload.ok) throw new Error(`Could not upload ${file.name}`);
        if (target.uploadUrl.startsWith("http"))
          await fetch(`/api/v1/attachments/${target.attachment.id}/complete`, {
            method: "POST",
          });
        setUploadProgress(Math.round(((index + 1) / files.length) * 100));
      }
      window.localStorage.removeItem("pulse-request-draft");
      await fetch("/api/v1/requests/draft", { method: "DELETE" }).catch(
        () => undefined,
      );
      onSubmit({ ...data.item, attachmentCount: files.length });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Request submission failed",
      );
      setSubmitting(false);
    }
  }
  return (
    <div
      className="modal-layer"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="composer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="composer-title"
      >
        <header>
          <div>
            <p className="eyebrow">New customer request</p>
            <h2 id="composer-title">Describe the outcome you need</h2>
            <p>
              Start with the problem. DataCentral will assess the right product
              response.
            </p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <form onSubmit={submit}>
          <label className="form-field">
            <span>
              Short title <em>Required</em>
            </span>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={140}
              placeholder="For example: Scheduled report delivery to SharePoint"
              required
            />
            <small>{title.length}/140</small>
          </label>
          {visibleSuggestions.length > 0 && (
            <div className="duplicate-panel">
              <div>
                <Icon name="spark" size={17} />
                <span>
                  <strong>Related ideas already exist</strong>
                  <small>
                    Add your organization’s interest or continue with distinct
                    context.
                  </small>
                </span>
              </div>
              {visibleSuggestions.map((suggestion) => (
                <div className="duplicate-row" key={suggestion.id}>
                  <button
                    type="button"
                    className="duplicate-copy"
                    onClick={() => {
                      if (suggestion.source === "Idea")
                        onFollow(suggestion.id);
                    }}
                  >
                    <span>
                      <Status tone={suggestion.tone}>
                        {suggestion.status}
                      </Status>
                      <code>{suggestion.id}</code>
                    </span>
                    <strong>{suggestion.title}</strong>
                    <small>{suggestion.why}</small>
                  </button>
                  {suggestion.source === "Idea" && (
                    <div className="duplicate-actions">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => {
                          onFollow(suggestion.id, true);
                          onClose();
                        }}
                      >
                        This solves my need
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setLinkedIdeaId(suggestion.id)}
                      >
                        Add my context
                      </Button>
                    </div>
                  )}
                </div>
              ))}
              {linkedIdeaId && (
                <p className="linked-context-note">
                  Your new request will be linked to {linkedIdeaId} while
                  keeping your company context private.
                </p>
              )}
              <button
                className="text-link"
                type="button"
                onClick={() => {
                  const query = `${title} ${problem}`.trim();
                  setDismissedQuery(query);
                  setSuggestions([]);
                  fetch("/api/v1/search/suggestions/dismiss", {
                    method: "POST",
                    headers: mutationHeaders(),
                    body: JSON.stringify({
                      queryLength: query.length,
                      suggestionIds: visibleSuggestions.map((item) => item.id),
                    }),
                  }).catch(() => undefined);
                }}
              >
                Continue with a new request
              </button>
            </div>
          )}
          <label className="form-field">
            <span>
              Problem or desired outcome <em>Required</em>
            </span>
            <textarea
              value={problem}
              onChange={(e) => setProblem(e.target.value)}
              maxLength={5000}
              placeholder="What are you trying to achieve, who is affected, and what happens today?"
              required
            />
            <small>{problem.length}/5,000</small>
          </label>
          <button
            type="button"
            className="disclosure"
            onClick={() => setShowDetails(!showDetails)}
          >
            <Icon name={showDetails ? "x" : "plus"} size={15} />
            {showDetails ? "Hide additional context" : "Add impact and context"}
          </button>
          {showDetails && (
            <div className="form-grid">
              <label className="form-field">
                <span>Request type</span>
                <select
                  value={requestType}
                  onChange={(e) => setRequestType(e.target.value)}
                >
                  <option>Feature</option>
                  <option>Improvement</option>
                  <option>Integration</option>
                  <option>Compliance</option>
                </select>
              </label>
              <label className="form-field">
                <span>Product area</span>
                <select value={area} onChange={(e) => setArea(e.target.value)}>
                  <option>Distribution</option>
                  <option>Governance</option>
                  <option>Authentication</option>
                  <option>Embedding</option>
                  <option>Display</option>
                  <option>Administration</option>
                  <option>Experience</option>
                </select>
              </label>
              <label className="form-field">
                <span>Business impact</span>
                <select
                  value={impact}
                  onChange={(e) => setImpact(e.target.value)}
                >
                  <option>Low</option>
                  <option>Medium</option>
                  <option>High</option>
                  <option>Critical</option>
                </select>
              </label>
              <label className="form-field">
                <span>Affected users</span>
                <input
                  type="number"
                  min="1"
                  value={affectedUsers}
                  onChange={(e) => setAffectedUsers(e.target.value)}
                  placeholder="Optional estimate"
                />
              </label>
              <label className="form-field">
                <span>Desired timing</span>
                <input
                  value={desiredTiming}
                  onChange={(e) => setDesiredTiming(e.target.value)}
                  placeholder="For example Q4 or 2026-11-01"
                />
              </label>
              <label className="form-field form-field-wide">
                <span>Current workaround</span>
                <textarea
                  value={workaround}
                  onChange={(e) => setWorkaround(e.target.value)}
                  placeholder="How do you handle this today?"
                />
              </label>
            </div>
          )}
          <div
            className="upload-field"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              addFiles(event.dataTransfer.files);
            }}
          >
            <input
              id="request-files"
              type="file"
              multiple
              accept="image/*,.pdf,.txt,.csv,.zip,.docx,.xlsx,.pptx"
              onChange={(event) =>
                event.target.files && addFiles(event.target.files)
              }
            />
            <label htmlFor="request-files">
              <Icon name="plus" size={17} />
              <span>
                <strong>Add screenshots or files</strong>
                <small>
                  Drop files here or browse · 25 MB each, 100 MB total
                </small>
              </span>
            </label>
            {files.length > 0 && (
              <div className="upload-list">
                {files.map((file, index) => (
                  <div key={`${file.name}-${index}`}>
                    <span>
                      <strong>{file.name}</strong>
                      <small>{(file.size / 1024 / 1024).toFixed(1)} MB</small>
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      onClick={() =>
                        setFiles((items) => items.filter((_, i) => i !== index))
                      }
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="visibility-choice">
            <Icon name="eye" size={17} />
            <div>
              <strong>
                Visible to{" "}
                {visibility === "Organization"
                  ? "your organization"
                  : "you and DataCentral"}
              </strong>
              <span>
                Raw customer context is never shared with other customers.
              </span>
            </div>
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value)}
            >
              <option>Organization</option>
              <option>Private</option>
            </select>
          </div>
          <div className="privacy-reminder">
            <Icon name="eye" size={16} />
            <span>
              Do not upload credentials, personal data, secrets, or unredacted
              production data.
            </span>
          </div>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <footer>
            <span>
              {submitting && files.length
                ? `Uploading attachments · ${uploadProgress}%`
                : "Draft autosaves on this device"}
            </span>
            <div>
              <Button
                variant="secondary"
                onClick={onClose}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                icon="send"
                disabled={!title.trim() || !problem.trim() || submitting}
              >
                {submitting ? "Submitting…" : "Submit request"}
              </Button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}

function Drawer({
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

function RequestDrawer({
  request,
  idea,
  onClose,
  onToast,
  onChange,
}: {
  request: RequestItem;
  idea?: Idea;
  onClose: () => void;
  onToast: (message: string) => void;
  onChange: (request: RequestItem) => void;
}) {
  const [reply, setReply] = useState("");
  const [attachments, setAttachments] = useState<RequestAttachment[]>([]);
  const [comments, setComments] = useState<RequestComment[]>([]);
  const [history, setHistory] = useState<RequestHistoryItem[]>([]);
  const [commentFiles, setCommentFiles] = useState<File[]>([]);
  useEffect(() => {
    fetch(`/api/v1/requests/${request.id}/attachments`)
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((data) => setAttachments(data.items || []));
    fetch(`/api/v1/requests/${request.id}/comments`)
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((data) => setComments(data.items || []));
    fetch(`/api/v1/requests/${request.id}`)
      .then((response) => (response.ok ? response.json() : { history: [] }))
      .then((data) => setHistory(data.history || []));
  }, [request.id]);

  async function sendReply() {
    const attachmentIds: string[] = [];
    for (const file of commentFiles) {
      const init = await fetch(
        `/api/v1/requests/${request.id}/attachments`,
        {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify({
            fileName: file.name,
            contentType: file.type || "application/octet-stream",
            sizeBytes: file.size,
          }),
        },
      );
      const target = await init.json();
      if (!init.ok) {
        onToast(target?.error?.message || `Could not prepare ${file.name}.`);
        return;
      }
      const upload = await fetch(target.uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": file.type || "application/octet-stream",
          ...(target.uploadUrl.startsWith("http")
            ? { "x-ms-blob-type": "BlockBlob" }
            : {}),
        },
        body: file,
      });
      if (!upload.ok) {
        onToast(`Could not upload ${file.name}.`);
        return;
      }
      if (target.uploadUrl.startsWith("http"))
        await fetch(`/api/v1/attachments/${target.attachment.id}/complete`, {
          method: "POST",
        });
      attachmentIds.push(target.attachment.id);
    }
    const response = await fetch(`/api/v1/requests/${request.id}/comments`, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({
        body: reply,
        visibility: "Customer",
        attachmentIds,
      }),
    });
    if (!response.ok) {
      onToast("Your response could not be saved.");
      return;
    }
    const data = await response.json();
    setComments((items) => [...items, { ...data.item, canEdit: true }]);
    setReply("");
    setCommentFiles([]);
    onToast("Your response was added to the request.");
  }
  async function editReply(comment: RequestComment) {
    const body = window.prompt("Edit comment", comment.body)?.trim();
    if (!body || body === comment.body) return;
    const response = await fetch(
      `/api/v1/requests/${request.id}/comments/${comment.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
    if (!response.ok) {
      onToast("The comment could not be edited.");
      return;
    }
    setComments((items) =>
      items.map((item) =>
        item.id === comment.id
          ? { ...item, body, editedAt: new Date().toISOString() }
          : item,
      ),
    );
    onToast("Comment updated. The previous version is preserved.");
  }
  async function removeReply(comment: RequestComment) {
    if (
      !window.confirm("Remove this comment? Its audit tombstone will remain.")
    )
      return;
    const response = await fetch(
      `/api/v1/requests/${request.id}/comments/${comment.id}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Removed by author" }),
      },
    );
    if (!response.ok) {
      onToast("The comment could not be removed.");
      return;
    }
    setComments((items) =>
      items.map((item) =>
        item.id === comment.id
          ? {
              ...item,
              body: "[Comment removed]",
              removed: true,
              canEdit: false,
            }
          : item,
      ),
    );
  }
  async function editRequestDetails() {
    const title = window.prompt("Request title", request.title)?.trim();
    if (!title) return;
    const problem = window
      .prompt("Problem or desired outcome", request.problem)
      ?.trim();
    if (!problem) return;
    const response = await fetch(`/api/v1/requests/${request.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, problem }),
    });
    const data = await response.json();
    if (!response.ok) {
      onToast(data?.error?.message || "The request could not be edited.");
      return;
    }
    onChange({ ...request, ...data.item });
    onToast("Request updated. The previous revision is preserved.");
  }
  async function withdrawRequest() {
    if (!window.confirm("Withdraw this request? Its audit history will remain."))
      return;
    const response = await fetch(`/api/v1/requests/${request.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "Withdrawn" }),
    });
    const data = await response.json();
    if (!response.ok) {
      onToast(data?.error?.message || "The request could not be withdrawn.");
      return;
    }
    onChange({ ...request, status: "Withdrawn", tone: "neutral" });
    onToast("Request withdrawn. Its history remains available.");
  }
  return (
    <Drawer onClose={onClose}>
      <header className="drawer-head">
        <div>
          <code>{request.id}</code>
          <h2>{request.title}</h2>
          <Status tone={request.tone}>{request.status}</Status>
        </div>
        <button className="icon-button" onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>
      <div className="drawer-content">
        <section className="drawer-summary">
          <div>
            <span>Product area</span>
            <strong>{request.area}</strong>
          </div>
          <div>
            <span>Business impact</span>
            <strong>{request.impact}</strong>
          </div>
          <div>
            <span>Submitted</span>
            <code>{request.submitted}</code>
          </div>
          <div>
            <span>Internal owner</span>
            <strong>{request.owner}</strong>
          </div>
        </section>
        {request.status === "Needs information" && (
          <section className="action-callout">
            <Icon name="message" size={19} />
            <div>
              <strong>DataCentral needs more context</strong>
              <p>
                How should the correct customer brand be selected when the same
                report is delivered to several external organizations?
              </p>
            </div>
          </section>
        )}
        <section className="drawer-section">
          <p className="field-label">Original customer need</p>
          <p>{request.problem}</p>
          {["Submitted", "Needs information"].includes(request.status) && (
            <div className="request-edit-actions">
              <Button variant="secondary" onClick={editRequestDetails}>
                Edit request
              </Button>
              <Button variant="ghost" onClick={withdrawRequest}>
                Withdraw
              </Button>
            </div>
          )}
        </section>
        {attachments.length > 0 && (
          <section className="drawer-section">
            <p className="field-label">Attachments</p>
            <div className="attachment-list">
              {attachments.map((attachment) => (
                <a
                  key={attachment.id}
                  href={
                    attachment.scanState === "Clean"
                      ? `/api/v1/attachments/${attachment.id}/content`
                      : undefined
                  }
                  aria-disabled={attachment.scanState !== "Clean"}
                >
                  <span>
                    <strong>{attachment.fileName}</strong>
                    <small>
                      {(attachment.sizeBytes / 1024 / 1024).toFixed(1)} MB ·{" "}
                      {attachment.scanState}
                    </small>
                  </span>
                  <Status
                    tone={
                      attachment.scanState === "Clean" ? "success" : "warning"
                    }
                  >
                    {attachment.scanState}
                  </Status>
                </a>
              ))}
            </div>
          </section>
        )}
        {idea && (
          <section className="linked-idea">
            <p className="field-label">Linked product idea</p>
            <div>
              <span>
                <Status tone={idea.tone}>{idea.status}</Status>
                <code>{idea.id}</code>
              </span>
              <strong>{idea.title}</strong>
              <p>{idea.description}</p>
            </div>
          </section>
        )}
        {comments.length > 0 && (
          <section className="drawer-section">
            <p className="field-label">Discussion</p>
            <div className="comment-list">
              {comments.map((comment) => (
                <article key={comment.id}>
                  <header>
                    <strong>{comment.author}</strong>
                    <code>{new Date(comment.createdAt).toLocaleString()}</code>
                  </header>
                  <div className="comment-markdown">
                    <ReactMarkdown
                      skipHtml
                      components={{
                        a: ({ href, children }) => (
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            {children}
                          </a>
                        ),
                      }}
                    >
                      {comment.body}
                    </ReactMarkdown>
                  </div>
                  {comment.editedAt && !comment.removed && (
                    <small>Edited</small>
                  )}
                  {comment.attachments && comment.attachments.length > 0 && (
                    <div className="comment-attachments">
                      {comment.attachments.map((attachment) => (
                        <a
                          key={attachment.id}
                          href={
                            attachment.scanState === "Clean"
                              ? `/api/v1/attachments/${attachment.id}/content`
                              : undefined
                          }
                          aria-disabled={attachment.scanState !== "Clean"}
                        >
                          {attachment.fileName} · {attachment.scanState}
                        </a>
                      ))}
                    </div>
                  )}
                  {comment.canEdit && !comment.removed && (
                    <div className="comment-actions">
                      <button onClick={() => editReply(comment)}>Edit</button>
                      <button onClick={() => removeReply(comment)}>
                        Remove
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}
        <section className="drawer-section">
          <p className="field-label">History</p>
          <div className="history">
            {(history.length
              ? history
              : [
                  {
                    id: "submitted",
                    action: "request.created",
                    actor: "Requester",
                    createdAt: request.submitted,
                  },
                ]
            ).map((entry) => (
              <div key={entry.id}>
                <span />
                <div>
                  <strong>
                    {entry.after?.status ||
                      entry.action
                        .replaceAll(".", " ")
                        .replace(/\b\w/g, (letter) => letter.toUpperCase())}
                  </strong>
                  <p>{entry.actor ? `By ${entry.actor}` : "System event"}</p>
                  <code>
                    {Number.isNaN(new Date(entry.createdAt).getTime())
                      ? entry.createdAt.toUpperCase()
                      : new Date(entry.createdAt).toLocaleString()}
                  </code>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="reply-box">
          <label htmlFor="reply">Add context</label>
          <textarea
            id="reply"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Reply to DataCentral or add relevant information"
          />
          <label className="comment-file-picker">
            <Icon name="plus" size={14} />
            Attach files
            <input
              type="file"
              multiple
              accept="image/*,.pdf,.txt,.csv,.zip,.docx,.xlsx,.pptx"
              onChange={(event) =>
                setCommentFiles(
                  Array.from(event.target.files || [])
                    .filter((file) => file.size <= 25 * 1024 * 1024)
                    .slice(0, 5),
                )
              }
            />
          </label>
          {commentFiles.length > 0 && (
            <div className="comment-file-list">
              {commentFiles.map((file) => (
                <span key={`${file.name}-${file.lastModified}`}>
                  {file.name}
                </span>
              ))}
            </div>
          )}
          <div>
            <span>Visible to Origo and DataCentral</span>
            <Button icon="send" disabled={!reply.trim()} onClick={sendReply}>
              Send response
            </Button>
          </div>
        </section>
      </div>
    </Drawer>
  );
}

function IdeaDrawer({
  idea,
  onClose,
  onFollow,
}: {
  idea: Idea;
  onClose: () => void;
  onFollow: (id: string) => void;
}) {
  return (
    <Drawer onClose={onClose}>
      <header className="drawer-head">
        <div>
          <code>{idea.id}</code>
          <h2>{idea.title}</h2>
          <Status tone={idea.tone}>{idea.status}</Status>
        </div>
        <button className="icon-button" onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>
      <div className="drawer-content">
        <section className="idea-highlight">
          <p className="eyebrow">Product direction</p>
          <h3>
            {idea.horizon === "Released"
              ? "Available now"
              : `${idea.horizon} horizon`}
          </h3>
          <p>{idea.description}</p>
        </section>
        <section className="drawer-summary">
          <div>
            <span>Product area</span>
            <strong>{idea.area}</strong>
          </div>
          <div>
            <span>Organizations</span>
            <strong>{idea.organizations}</strong>
          </div>
          <div>
            <span>Followers</span>
            <strong>{idea.followers}</strong>
          </div>
          <div>
            <span>Last update</span>
            <strong>{idea.updated.replace("Updated ", "")}</strong>
          </div>
        </section>
        <section className="drawer-section">
          <p className="field-label">Latest update</p>
          <h3>
            {idea.status === "Released"
              ? "Released to eligible tenants"
              : `${idea.status}: scope is being refined`}
          </h3>
          <p>
            {idea.status === "In progress"
              ? "Delivery has started. The initial scope is focused on the highest-value customer workflow and governed administration."
              : idea.status === "Planned"
                ? "The capability has been approved for delivery. Detailed sequencing remains subject to technical dependencies and customer evidence."
                : "The product team is reviewing customer evidence, constraints, and the most appropriate implementation."}
          </p>
          <code>14 JUL 2026 · 14:30Z</code>
        </section>
        <section className="organization-evidence">
          <Icon name="building" size={18} />
          <div>
            <strong>Demand across {idea.organizations} organizations</strong>
            <span>
              Customer identities and raw request context remain private.
            </span>
          </div>
        </section>
      </div>
      <footer className="drawer-footer">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        <Button
          icon={idea.followed ? "check" : "bell"}
          onClick={() => onFollow(idea.id)}
        >
          {idea.followed ? "Following" : "Follow idea"}
        </Button>
      </footer>
    </Drawer>
  );
}

function CompaniesPage({
  companies,
  users,
  onChange,
  onToast,
}: {
  companies: Company[];
  users: ManagedUser[];
  onChange: (companies: Company[]) => void;
  onToast: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Company | "new" | null>(null);
  const visible = companies.filter((company) =>
    `${company.name} ${company.domain} ${company.type}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  async function save(company: Company) {
    const response = await fetch("/api/v1/admin/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(company),
    });
    if (!response.ok) {
      onToast("The company could not be saved.");
      return;
    }
    const saved = (await response.json()).item as Company;
    onChange(
      companies.some((item) => item.id === saved.id)
        ? companies.map((item) => (item.id === saved.id ? saved : item))
        : [...companies, saved],
    );
    setEditing(null);
    onToast(`${company.name} was saved.`);
  }
  return (
    <div className="page-stack management-page">
      <PageIntro
        eyebrow="Customer administration"
        title="Manage companies"
        description="Companies define the customer boundary. Requests, users, memberships, and authentication policies are scoped to a company."
        action={
          <Button icon="plus" onClick={() => setEditing("new")}>
            Add company
          </Button>
        }
      />
      <section className="admin-metric-grid">
        <div>
          <span>Active companies</span>
          <strong>
            {companies.filter((c) => c.status === "Active").length}
          </strong>
          <small>Customers, partners, and internal</small>
        </div>
        <div>
          <span>Customer companies</span>
          <strong>
            {companies.filter((c) => c.type === "Customer").length}
          </strong>
          <small>Governed data boundaries</small>
        </div>
        <div>
          <span>Multi-company users</span>
          <strong>
            {users.filter((u) => u.memberships.length > 1).length}
          </strong>
          <small>Explicit memberships only</small>
        </div>
      </section>
      <div className="management-toolbar">
        <div className="search-input">
          <Icon name="search" size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search companies"
          />
        </div>
        <span>{visible.length} companies</span>
      </div>
      <div className="management-table company-table">
        <div className="management-head">
          <span>Company</span>
          <span>Type</span>
          <span>Users</span>
          <span>Authentication</span>
          <span>Status</span>
          <span />
        </div>
        {visible.map((company) => {
          const memberCount = users.filter((user) =>
            user.memberships.some(
              (membership) => membership.companyId === company.id,
            ),
          ).length;
          return (
            <div className="management-row" key={company.id}>
              <span className="record-name">
                <span className="company-avatar">
                  {company.name.slice(0, 2).toUpperCase()}
                </span>
                <span>
                  <strong>{company.name}</strong>
                  <code>
                    {company.id} · {company.domain}
                  </code>
                </span>
              </span>
              <span>{company.type}</span>
              <span>
                <strong>{memberCount}</strong> members
              </span>
              <span className="auth-tags">
                {company.authentication.map((method) => (
                  <span key={method}>{method}</span>
                ))}
              </span>
              <Status
                tone={
                  company.status === "Active"
                    ? "success"
                    : company.status === "Onboarding"
                      ? "warning"
                      : "neutral"
                }
              >
                {company.status}
              </Status>
              <Button variant="secondary" onClick={() => setEditing(company)}>
                Manage
              </Button>
            </div>
          );
        })}
      </div>
      {editing && (
        <CompanyEditor
          company={editing === "new" ? undefined : editing}
          nextNumber={companies.length + 1}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </div>
  );
}

function CompanyEditor({
  company,
  nextNumber,
  onClose,
  onSave,
}: {
  company?: Company;
  nextNumber: number;
  onClose: () => void;
  onSave: (company: Company) => void;
}) {
  const [name, setName] = useState(company?.name || "");
  const [domain, setDomain] = useState(company?.domain || "");
  const [type, setType] = useState<Company["type"]>(
    company?.type || "Customer",
  );
  const [status, setStatus] = useState<Company["status"]>(
    company?.status || "Onboarding",
  );
  const [authentication, setAuthentication] = useState<("OTP" | "Entra ID")[]>(
    company?.authentication || ["OTP"],
  );
  function toggle(method: "OTP" | "Entra ID") {
    setAuthentication((items) =>
      items.includes(method)
        ? items.filter((item) => item !== method)
        : [...items, method],
    );
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !domain.trim() || authentication.length === 0) return;
    onSave({
      id: company?.id || `ORG-${String(nextNumber).padStart(3, "0")}`,
      name: name.trim(),
      domain: domain.trim().toLowerCase(),
      type,
      status,
      authentication,
      users: company?.users || 0,
      requests: company?.requests || 0,
    });
  }
  return (
    <div
      className="modal-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="management-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="company-editor-title"
      >
        <header>
          <div>
            <p className="eyebrow">Company record</p>
            <h2 id="company-editor-title">
              {company ? `Manage ${company.name}` : "Add customer company"}
            </h2>
            <p>
              Company membership controls which customer context a user may
              enter.
            </p>
          </div>
          <button className="icon-button" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <form onSubmit={submit}>
          <div className="form-grid">
            <label className="form-field">
              <span>
                Company name <em>Required</em>
              </span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Company name"
                required
              />
            </label>
            <label className="form-field">
              <span>
                Verified domain <em>Required</em>
              </span>
              <input
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                placeholder="example.com"
                required
              />
            </label>
            <label className="form-field">
              <span>Company type</span>
              <select
                value={type}
                onChange={(event) =>
                  setType(event.target.value as Company["type"])
                }
              >
                <option>Customer</option>
                <option>Partner</option>
                <option>Internal</option>
              </select>
            </label>
            <label className="form-field">
              <span>Status</span>
              <select
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as Company["status"])
                }
              >
                <option>Active</option>
                <option>Onboarding</option>
                <option>Inactive</option>
              </select>
            </label>
          </div>
          <fieldset className="auth-choice">
            <legend>Allowed authentication</legend>
            <label>
              <input
                type="checkbox"
                checked={authentication.includes("OTP")}
                onChange={() => toggle("OTP")}
              />
              <span>
                <strong>One-time password</strong>
                <small>Email-delivered OTP with no tenant configuration.</small>
              </span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={authentication.includes("Entra ID")}
                onChange={() => toggle("Entra ID")}
              />
              <span>
                <strong>Microsoft Entra ID</strong>
                <small>
                  Enterprise SSO after application configuration and consent.
                </small>
              </span>
            </label>
          </fieldset>
          <footer>
            <span>At least one authentication method is required.</span>
            <div>
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                icon="check"
                disabled={
                  !name.trim() || !domain.trim() || authentication.length === 0
                }
              >
                Save company
              </Button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}

function UsersPage({
  users,
  companies,
  onChange,
  onToast,
}: {
  users: ManagedUser[];
  companies: Company[];
  onChange: (users: ManagedUser[]) => void;
  onToast: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [companyFilter, setCompanyFilter] = useState("All companies");
  const [editing, setEditing] = useState<ManagedUser | "new" | null>(null);
  const visible = users.filter(
    (user) =>
      `${user.name} ${user.email}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (companyFilter === "All companies" ||
        user.memberships.some(
          (membership) => membership.companyId === companyFilter,
        )),
  );
  async function save(user: ManagedUser) {
    const response = await fetch("/api/v1/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(user),
    });
    if (!response.ok) {
      onToast("The user and memberships could not be saved.");
      return;
    }
    const saved = (await response.json()).item as ManagedUser;
    onChange(
      users.some((item) => item.id === saved.id)
        ? users.map((item) => (item.id === saved.id ? saved : item))
        : [...users, saved],
    );
    setEditing(null);
    onToast(
      `${saved.name} and ${saved.memberships.length} company membership${saved.memberships.length === 1 ? "" : "s"} were saved.`,
    );
  }
  return (
    <div className="page-stack management-page">
      <PageIntro
        eyebrow="Identity and access"
        title="Manage users and company access"
        description="A user has one identity and any number of explicit company memberships. Roles are assigned separately inside each company."
        action={
          <Button icon="plus" onClick={() => setEditing("new")}>
            Invite user
          </Button>
        }
      />
      <div className="membership-callout">
        <Icon name="users" size={20} />
        <div>
          <strong>Many-to-many access model</strong>
          <span>
            Internal employees are not global by default. Assign each employee
            only to the customer companies they support.
          </span>
        </div>
      </div>
      <div className="management-toolbar">
        <div className="search-input">
          <Icon name="search" size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search users"
          />
        </div>
        <label className="select-wrap">
          <Icon name="building" size={15} />
          <select
            value={companyFilter}
            onChange={(event) => setCompanyFilter(event.target.value)}
          >
            <option>All companies</option>
            {companies.map((company) => (
              <option value={company.id} key={company.id}>
                {company.name}
              </option>
            ))}
          </select>
        </label>
        <span>{visible.length} users</span>
      </div>
      <div className="management-table user-table">
        <div className="management-head">
          <span>User</span>
          <span>Authentication</span>
          <span>Company access</span>
          <span>Status</span>
          <span />
        </div>
        {visible.map((user) => (
          <div className="management-row" key={user.id}>
            <span className="record-name">
              <span className="user-avatar">
                {user.name
                  .split(" ")
                  .map((part) => part[0])
                  .slice(0, 2)
                  .join("")}
              </span>
              <span>
                <strong>{user.name}</strong>
                <code>{user.email}</code>
              </span>
            </span>
            <span className="auth-tags">
              <span>{user.authentication}</span>
            </span>
            <span className="membership-tags">
              {user.memberships.slice(0, 3).map((membership) => (
                <span key={membership.companyId}>
                  {
                    companies.find(
                      (company) => company.id === membership.companyId,
                    )?.name
                  }
                  <small>{membership.role}</small>
                </span>
              ))}
              {user.memberships.length > 3 && (
                <span>+{user.memberships.length - 3} more</span>
              )}
            </span>
            <Status
              tone={
                user.status === "Active"
                  ? "success"
                  : user.status === "Invited"
                    ? "warning"
                    : "error"
              }
            >
              {user.status}
            </Status>
            <Button variant="secondary" onClick={() => setEditing(user)}>
              Edit access
            </Button>
          </div>
        ))}
      </div>
      {editing && (
        <UserEditor
          user={editing === "new" ? undefined : editing}
          companies={companies}
          nextNumber={users.length + 101}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </div>
  );
}

function UserEditor({
  user,
  companies,
  nextNumber,
  onClose,
  onSave,
}: {
  user?: ManagedUser;
  companies: Company[];
  nextNumber: number;
  onClose: () => void;
  onSave: (user: ManagedUser) => void;
}) {
  const [name, setName] = useState(user?.name || "");
  const [email, setEmail] = useState(user?.email || "");
  const [status, setStatus] = useState<ManagedUser["status"]>(
    user?.status || "Invited",
  );
  const [authentication, setAuthentication] = useState<
    ManagedUser["authentication"]
  >(user?.authentication || "OTP");
  const [memberships, setMemberships] = useState<UserMembership[]>(
    user?.memberships || [],
  );
  function toggleCompany(companyId: string) {
    setMemberships((items) =>
      items.some((item) => item.companyId === companyId)
        ? items.filter((item) => item.companyId !== companyId)
        : [...items, { companyId, role: "Requester" }],
    );
  }
  function setRole(companyId: string, role: UserMembership["role"]) {
    setMemberships((items) =>
      items.map((item) =>
        item.companyId === companyId ? { ...item, role } : item,
      ),
    );
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !email.trim() || memberships.length === 0) return;
    onSave({
      id: user?.id || `USR-${nextNumber}`,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      status,
      authentication,
      memberships,
    });
  }
  return (
    <div
      className="modal-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="management-modal user-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-editor-title"
      >
        <header>
          <div>
            <p className="eyebrow">User identity</p>
            <h2 id="user-editor-title">
              {user ? `Edit ${user.name}` : "Invite user"}
            </h2>
            <p>
              Authentication proves identity. Membership determines company
              access.
            </p>
          </div>
          <button className="icon-button" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <form onSubmit={submit}>
          <div className="form-grid">
            <label className="form-field">
              <span>
                Full name <em>Required</em>
              </span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Full name"
                required
              />
            </label>
            <label className="form-field">
              <span>
                Email address <em>Required</em>
              </span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@company.com"
                required
              />
            </label>
            <label className="form-field">
              <span>Authentication</span>
              <select
                value={authentication}
                onChange={(event) =>
                  setAuthentication(
                    event.target.value as ManagedUser["authentication"],
                  )
                }
              >
                <option>OTP</option>
                <option>Entra ID</option>
              </select>
            </label>
            <label className="form-field">
              <span>User status</span>
              <select
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as ManagedUser["status"])
                }
              >
                <option>Active</option>
                <option>Invited</option>
                <option>Suspended</option>
              </select>
            </label>
          </div>
          <fieldset className="membership-editor">
            <legend>
              Company memberships <em>Required</em>
            </legend>
            <p>
              Select every company this user may enter. Assign a role
              independently for each membership.
            </p>
            {companies
              .filter((company) => company.status !== "Inactive")
              .map((company) => {
                const membership = memberships.find(
                  (item) => item.companyId === company.id,
                );
                return (
                  <div
                    className={membership ? "selected" : ""}
                    key={company.id}
                  >
                    <label>
                      <input
                        type="checkbox"
                        checked={!!membership}
                        onChange={() => toggleCompany(company.id)}
                      />
                      <span>
                        <strong>{company.name}</strong>
                        <small>
                          {company.type} · {company.domain}
                        </small>
                      </span>
                    </label>
                    {membership && (
                      <select
                        value={membership.role}
                        onChange={(event) =>
                          setRole(
                            company.id,
                            event.target.value as UserMembership["role"],
                          )
                        }
                      >
                        <option>Company admin</option>
                        <option>Requester</option>
                        <option>Viewer</option>
                        {company.type === "Internal" && (
                          <option>Product manager</option>
                        )}
                      </select>
                    )}
                  </div>
                );
              })}
          </fieldset>
          <footer>
            <span>
              {memberships.length} compan
              {memberships.length === 1 ? "y" : "ies"} selected
            </span>
            <div>
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                icon="check"
                disabled={
                  !name.trim() || !email.trim() || memberships.length === 0
                }
              >
                {user ? "Save access" : "Send invitation"}
              </Button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}

function AuthenticationPage({
  companies,
  onToast,
}: {
  companies: Company[];
  onToast: (message: string) => void;
}) {
  const [entraOpen, setEntraOpen] = useState(false);
  const [appId, setAppId] = useState("");
  const [tenantId, setTenantId] = useState("");
  return (
    <div className="page-stack management-page auth-page">
      <PageIntro
        eyebrow="Identity providers"
        title="Authentication"
        description="DataCentral Pulse supports email OTP and Microsoft Entra ID. Authentication identifies the person; company memberships authorize their customer access."
      />
      <div className="provider-grid">
        <article className="provider-card active">
          <header>
            <span className="provider-icon">
              <Icon name="message" size={21} />
            </span>
            <Status tone="success">Active</Status>
          </header>
          <h3>One-time password</h3>
          <p>
            Email-delivered OTP provides low-friction access without requiring a
            customer tenant application or guest account.
          </p>
          <dl>
            <div>
              <dt>Identifier</dt>
              <dd>Email address</dd>
            </div>
            <div>
              <dt>Code lifetime</dt>
              <dd>10 minutes</dd>
            </div>
            <div>
              <dt>Company access</dt>
              <dd>Explicit membership</dd>
            </div>
          </dl>
          <Button
            variant="secondary"
            onClick={() =>
              onToast("OTP policy is active for eligible companies.")
            }
          >
            Manage OTP policy
          </Button>
        </article>
        <article className="provider-card">
          <header>
            <span className="provider-icon">
              <Icon name="building" size={21} />
            </span>
            <Status tone="warning">Configuration pending</Status>
          </header>
          <h3>Microsoft Entra ID</h3>
          <p>
            Enterprise SSO using the DataCentral Pulse application registration.
            The App ID and Azure Tenant ID can be added later.
          </p>
          <dl>
            <div>
              <dt>Application ID</dt>
              <dd>
                <code>Not configured</code>
              </dd>
            </div>
            <div>
              <dt>Azure Tenant ID</dt>
              <dd>
                <code>Not configured</code>
              </dd>
            </div>
            <div>
              <dt>Account model</dt>
              <dd>Configured tenant</dd>
            </div>
          </dl>
          <Button onClick={() => setEntraOpen(true)}>Configure Entra ID</Button>
        </article>
      </div>
      <section className="access-model">
        <div>
          <p className="eyebrow">Sign-in resolution</p>
          <h3>One identity, several company contexts</h3>
          <p>
            After OTP or Entra ID authentication, the service loads active
            memberships. Users with one membership enter that company directly.
            Users with several memberships choose an active company and may
            switch without signing in again.
          </p>
        </div>
        <div className="access-flow">
          <span>
            <Icon name="users" size={18} />
            <strong>User identity</strong>
            <small>OTP or Entra ID</small>
          </span>
          <Icon name="arrow" size={17} />
          <span>
            <Icon name="link" size={18} />
            <strong>Memberships</strong>
            <small>User × company × role</small>
          </span>
          <Icon name="arrow" size={17} />
          <span>
            <Icon name="building" size={18} />
            <strong>Active company</strong>
            <small>Scoped requests and data</small>
          </span>
        </div>
      </section>
      <section className="company-auth-panel">
        <header>
          <div>
            <h3>Company authentication policy</h3>
            <p>Each company may allow one or both configured providers.</p>
          </div>
        </header>
        <div>
          {companies
            .filter((company) => company.status !== "Inactive")
            .map((company) => (
              <div key={company.id}>
                <span className="record-name">
                  <span className="company-avatar">
                    {company.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span>
                    <strong>{company.name}</strong>
                    <code>{company.domain}</code>
                  </span>
                </span>
                <span className="auth-tags">
                  {company.authentication.map((method) => (
                    <span key={method}>{method}</span>
                  ))}
                </span>
                <button
                  className="text-link"
                  onClick={() =>
                    onToast(`Authentication policy opened for ${company.name}.`)
                  }
                >
                  Manage <Icon name="arrow" size={13} />
                </button>
              </div>
            ))}
        </div>
      </section>
      {entraOpen && (
        <div
          className="modal-layer"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setEntraOpen(false);
          }}
        >
          <section
            className="management-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="entra-title"
          >
            <header>
              <div>
                <p className="eyebrow">Enterprise identity</p>
                <h2 id="entra-title">Configure Microsoft Entra ID</h2>
                <p>
                  Validate the identifiers before applying them through secure
                  Azure configuration.
                </p>
              </div>
              <button
                className="icon-button"
                onClick={() => setEntraOpen(false)}
              >
                <Icon name="x" />
              </button>
            </header>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setEntraOpen(false);
                onToast(
                  "Entra identifiers validated. Apply them through the Azure identity configuration.",
                );
              }}
            >
              <label className="form-field">
                <span>
                  Application (client) ID <em>Required</em>
                </span>
                <input
                  value={appId}
                  onChange={(event) => setAppId(event.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  required
                />
              </label>
              <label className="form-field">
                <span>
                  Azure Tenant ID <em>Required</em>
                </span>
                <input
                  value={tenantId}
                  onChange={(event) => setTenantId(event.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  required
                />
              </label>
              <div className="security-note">
                <Icon name="eye" size={17} />
                <span>
                  <strong>Client secrets are never entered in Pulse.</strong>
                  <small>
                    Use App Service Authentication and Key Vault references for
                    production identity configuration.
                  </small>
                </span>
              </div>
              <footer>
                <span>
                  Configuration is not activated until applied in Azure.
                </span>
                <div>
                  <Button
                    variant="secondary"
                    onClick={() => setEntraOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    icon="check"
                    disabled={!appId.trim() || !tenantId.trim()}
                  >
                    Validate identifiers
                  </Button>
                </div>
              </footer>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

function InternalIdeasPage({
  ideas,
  requests,
  users,
  onChange,
  onToast,
}: {
  ideas: InternalIdea[];
  requests: RequestItem[];
  users: ManagedUser[];
  onChange: (items: InternalIdea[]) => void;
  onToast: (message: string) => void;
}) {
  const [editing, setEditing] = useState<InternalIdea | "new" | null>(null);
  const [query, setQuery] = useState("");
  const visible = ideas.filter((idea) =>
    `${idea.id} ${idea.internalTitle} ${idea.area} ${idea.internalStatus}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  function saved(item: InternalIdea) {
    onChange(
      ideas.some((idea) => idea.id === item.id)
        ? ideas.map((idea) => (idea.id === item.id ? item : idea))
        : [item, ...ideas],
    );
    setEditing(item);
  }
  function merged(sourceId: string, targetId: string) {
    onChange(
      ideas.map((idea) =>
        idea.id === sourceId
          ? { ...idea, internalStatus: "Archived", publishState: "Internal" }
          : idea,
      ),
    );
    setEditing(ideas.find((idea) => idea.id === targetId) || null);
  }
  return (
    <div className="page-stack management-page">
      <PageIntro
        eyebrow="Internal product workspace"
        title="Canonical product ideas"
        description="Consolidate customer evidence, score priorities, stage safe wording, and publish deliberate product decisions."
        action={
          <Button icon="plus" onClick={() => setEditing("new")}>
            Create idea
          </Button>
        }
      />
      <section className="admin-metric-grid">
        <div>
          <span>Active ideas</span>
          <strong>
            {ideas.filter((idea) => idea.internalStatus !== "Archived").length}
          </strong>
          <small>Canonical product records</small>
        </div>
        <div>
          <span>Staged changes</span>
          <strong>
            {ideas.filter((idea) => idea.publishState === "Staged").length}
          </strong>
          <small>Awaiting explicit publication</small>
        </div>
        <div>
          <span>Unlinked evidence</span>
          <strong>
            {requests.filter((request) => !request.linkedIdea).length}
          </strong>
          <small>Requests needing consolidation</small>
        </div>
      </section>
      <div className="management-toolbar">
        <div className="search-input">
          <Icon name="search" size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search internal ideas"
          />
        </div>
        <span>{visible.length} ideas</span>
      </div>
      <div className="management-table idea-admin-table">
        <div className="management-head">
          <span>Idea</span>
          <span>Status</span>
          <span>Roadmap</span>
          <span>Evidence</span>
          <span>Score</span>
          <span />
        </div>
        {visible.map((idea) => (
          <div className="management-row" key={idea.id}>
            <span className="record-name">
              <span className="company-avatar">
                {idea.area.slice(0, 2).toUpperCase()}
              </span>
              <span>
                <strong>{idea.internalTitle}</strong>
                <code>
                  {idea.id} · {idea.publishState}
                </code>
              </span>
            </span>
            <Status tone={idea.tone}>{idea.internalStatus}</Status>
            <span>{idea.horizon}</span>
            <span>
              {idea.organizations} orgs · {idea.linkedRequests || 0} requests
            </span>
            <strong>{idea.score?.toFixed(2) || "—"}</strong>
            <Button variant="secondary" onClick={() => setEditing(idea)}>
              Manage
            </Button>
          </div>
        ))}
      </div>
      {editing && (
        <IdeaWorkflowEditor
          idea={editing === "new" ? undefined : editing}
          ideas={ideas}
          requests={requests}
          users={users}
          onClose={() => setEditing(null)}
          onSaved={saved}
          onMerged={merged}
          onToast={onToast}
        />
      )}
    </div>
  );
}

function IdeaWorkflowEditor({
  idea,
  ideas,
  requests,
  users,
  onClose,
  onSaved,
  onMerged,
  onToast,
}: {
  idea?: InternalIdea;
  ideas: InternalIdea[];
  requests: RequestItem[];
  users: ManagedUser[];
  onClose: () => void;
  onSaved: (item: InternalIdea) => void;
  onMerged: (sourceId: string, targetId: string) => void;
  onToast: (message: string) => void;
}) {
  const [internalTitle, setInternalTitle] = useState(idea?.internalTitle || "");
  const [internalDescription, setInternalDescription] = useState(
    idea?.internalDescription || "",
  );
  const [publishedTitle, setPublishedTitle] = useState(
    idea?.publishedTitle || "",
  );
  const [publishedDescription, setPublishedDescription] = useState(
    idea?.publishedDescription || "",
  );
  const [area, setArea] = useState(idea?.area || "Governance");
  const [status, setStatus] = useState(idea?.internalStatus || "Discovery");
  const [horizon, setHorizon] = useState<Idea["horizon"]>(
    idea?.horizon || "Later",
  );
  const [ownerId, setOwnerId] = useState(idea?.ownerId || "");
  const [rationale, setRationale] = useState(idea?.decisionRationale || "");
  const [reason, setReason] = useState(idea?.decisionReason || "");
  const [delivery, setDelivery] = useState(idea?.deliveryReference || "");
  const [deliveryException, setDeliveryException] = useState(
    idea?.deliveryException || false,
  );
  const [externalLinks, setExternalLinks] = useState<ExternalLinkItem[]>([]);
  const [externalLinkLabel, setExternalLinkLabel] = useState("");
  const [externalLinkUrl, setExternalLinkUrl] = useState("");
  const [releaseNotes, setReleaseNotes] = useState(idea?.releaseNotes || "");
  const [availability, setAvailability] = useState(idea?.availability || "");
  const [safe, setSafe] = useState(false);
  const [linkRequestId, setLinkRequestId] = useState(
    requests.find((request) => !request.linkedIdea)?.id || "",
  );
  const [linkReason, setLinkReason] = useState(
    "Consolidates the same customer outcome",
  );
  const [mergeSource, setMergeSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [score, setScore] = useState({
    impact: 3,
    reach: 3,
    strategicAlignment: 3,
    commercialImpact: 3,
    urgency: 3,
    confidence: 80,
    effort: 3,
    rationale: "Balanced against current customer evidence",
  });
  useEffect(() => {
    if (!idea) return;
    fetch(`/api/v1/internal/ideas/${idea.id}/external-links`, {
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((data) => setExternalLinks(data.items || []))
      .catch(() => setExternalLinks([]));
  }, [idea]);
  const payload = {
    internalTitle,
    internalDescription,
    publishedTitle,
    publishedDescription,
    area,
    internalStatus: status,
    horizon,
    ownerId: ownerId || undefined,
    decisionRationale: rationale,
    decisionReason: reason,
    deliveryReference: delivery,
    deliveryException,
    releaseNotes,
    availability,
  };
  async function call(url: string, options: RequestInit) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(url, options);
      const data = await response.json();
      if (!response.ok)
        throw new Error(data?.error?.message || "The operation failed");
      return data;
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The operation failed",
      );
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function addDeliveryLink() {
    if (!idea || !externalLinkLabel.trim() || !externalLinkUrl.trim()) return;
    const saved = await call(
      `/api/v1/internal/ideas/${idea.id}/external-links`,
      {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({
          label: externalLinkLabel,
          url: externalLinkUrl,
        }),
      },
    );
    if (!saved) return;
    setExternalLinks((items) => [...items, saved]);
    setExternalLinkLabel("");
    setExternalLinkUrl("");
  }
  async function removeDeliveryLink(linkId: string) {
    if (!idea) return;
    const removed = await call(
      `/api/v1/internal/ideas/${idea.id}/external-links/${linkId}`,
      { method: "DELETE", headers: mutationHeaders() },
    );
    if (removed)
      setExternalLinks((items) => items.filter((item) => item.id !== linkId));
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const data = await call(
      idea ? `/api/v1/internal/ideas/${idea.id}` : "/api/v1/internal/ideas",
      {
        method: idea ? "PATCH" : "POST",
        headers: idea
          ? { "content-type": "application/json" }
          : mutationHeaders(),
        body: JSON.stringify(payload),
      },
    );
    if (data?.item) {
      onSaved(data.item);
      onToast(`${data.item.id} was saved as ${data.item.publishState}.`);
    }
  }
  async function publish() {
    if (!idea) return;
    const data = await call(`/api/v1/internal/ideas/${idea.id}/publish`, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ confirmedSafe: safe }),
    });
    if (data?.item) {
      onSaved(data.item);
      onToast(`${idea.id} was published to customers.`);
    }
  }
  async function addScore() {
    if (!idea) return;
    const data = await call(`/api/v1/internal/ideas/${idea.id}/score`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(score),
    });
    if (data) {
      onSaved({ ...idea, score: data.score });
      onToast(`Priority score ${data.score.toFixed(2)} was recorded.`);
    }
  }
  async function link() {
    if (!idea || !linkRequestId) return;
    const data = await call(`/api/v1/internal/ideas/${idea.id}/links`, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ requestId: linkRequestId, reason: linkReason }),
    });
    if (data) {
      onSaved({ ...idea, linkedRequests: (idea.linkedRequests || 0) + 1 });
      onToast(`${linkRequestId} was linked transactionally.`);
    }
  }
  async function merge() {
    if (!idea || !mergeSource) return;
    const data = await call(`/api/v1/internal/ideas/${idea.id}/merge`, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({
        sourceIdeaId: mergeSource,
        reason: "Duplicate canonical idea consolidated after product review",
      }),
    });
    if (data) {
      onMerged(mergeSource, idea.id);
      onToast(`${mergeSource} now resolves to ${idea.id}.`);
    }
  }
  return (
    <div
      className="modal-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="management-modal idea-workflow-modal"
        role="dialog"
        aria-modal="true"
      >
        <header>
          <div>
            <p className="eyebrow">Canonical product record</p>
            <h2>
              {idea
                ? `${idea.id} · ${idea.internalTitle}`
                : "Create product idea"}
            </h2>
            <p>
              Internal evidence remains separate from explicitly reviewed
              customer wording.
            </p>
          </div>
          <button className="icon-button" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <form onSubmit={save}>
          <div className="workflow-columns">
            <div>
              <p className="field-label">Internal product record</p>
              <label className="form-field">
                <span>
                  Internal title <em>Required</em>
                </span>
                <input
                  value={internalTitle}
                  onChange={(event) => setInternalTitle(event.target.value)}
                  required
                />
              </label>
              <label className="form-field">
                <span>
                  Internal description <em>Required</em>
                </span>
                <textarea
                  value={internalDescription}
                  onChange={(event) =>
                    setInternalDescription(event.target.value)
                  }
                  required
                />
              </label>
              <div className="form-grid">
                <label className="form-field">
                  <span>Product area</span>
                  <select
                    value={area}
                    onChange={(event) => setArea(event.target.value)}
                  >
                    {[
                      "Governance",
                      "Distribution",
                      "Authentication",
                      "Embedding",
                      "Display",
                      "Administration",
                      "Experience",
                    ].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label className="form-field">
                  <span>Internal status</span>
                  <select
                    value={status}
                    onChange={(event) =>
                      setStatus(
                        event.target.value as InternalIdea["internalStatus"],
                      )
                    }
                  >
                    {[
                      "Discovery",
                      "Candidate",
                      "Planned",
                      "In progress",
                      "Released",
                      "Not planned",
                      "Archived",
                    ].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label className="form-field">
                  <span>Roadmap horizon</span>
                  <select
                    value={horizon}
                    onChange={(event) =>
                      setHorizon(event.target.value as Idea["horizon"])
                    }
                  >
                    {["Now", "Next", "Later", "Released"].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label className="form-field">
                  <span>Owner</span>
                  <select
                    value={ownerId}
                    onChange={(event) => setOwnerId(event.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {users
                      .filter((user) =>
                        user.memberships.some(
                          (membership) => membership.role === "Product manager",
                        ),
                      )
                      .map((user) => (
                        <option value={user.id} key={user.id}>
                          {user.name}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <label className="form-field">
                <span>Decision rationale</span>
                <textarea
                  value={rationale}
                  onChange={(event) => setRationale(event.target.value)}
                  placeholder="Required for Planned, Later, or Not planned"
                />
              </label>
              <div className="form-grid">
                <label className="form-field">
                  <span>Reason category</span>
                  <input
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
                <label className="form-field">
                  <span>Delivery reference</span>
                  <input
                    value={delivery}
                    onChange={(event) => setDelivery(event.target.value)}
                    placeholder="https://... or ADO-123"
                  />
                </label>
              </div>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={deliveryException}
                  onChange={(event) =>
                    setDeliveryException(event.target.checked)
                  }
                />
                <span>Explicit delivery-reference exception</span>
              </label>
              {idea && (
                <section className="external-link-editor">
                  <div className="field-label">External delivery links</div>
                  {externalLinks.map((link) => (
                    <div className="external-link-row" key={link.id}>
                      <a href={link.url} target="_blank" rel="noreferrer">
                        {link.label}
                      </a>
                      <button onClick={() => removeDeliveryLink(link.id)}>
                        Remove
                      </button>
                    </div>
                  ))}
                  <div className="external-link-inputs">
                    <input
                      aria-label="Delivery link label"
                      value={externalLinkLabel}
                      onChange={(event) =>
                        setExternalLinkLabel(event.target.value)
                      }
                      placeholder="Azure Boards"
                    />
                    <input
                      aria-label="Delivery link URL"
                      value={externalLinkUrl}
                      onChange={(event) =>
                        setExternalLinkUrl(event.target.value)
                      }
                      placeholder="https://…"
                    />
                    <Button
                      variant="secondary"
                      onClick={addDeliveryLink}
                      disabled={
                        busy ||
                        !externalLinkLabel.trim() ||
                        !externalLinkUrl.trim()
                      }
                    >
                      Add
                    </Button>
                  </div>
                </section>
              )}
            </div>
            <div>
              <p className="field-label">Customer-safe publication</p>
              <label className="form-field">
                <span>Published title</span>
                <input
                  value={publishedTitle}
                  onChange={(event) => setPublishedTitle(event.target.value)}
                />
              </label>
              <label className="form-field">
                <span>Published description / explanation</span>
                <textarea
                  value={publishedDescription}
                  onChange={(event) =>
                    setPublishedDescription(event.target.value)
                  }
                />
              </label>
              <label className="form-field">
                <span>Release notes</span>
                <textarea
                  value={releaseNotes}
                  onChange={(event) => setReleaseNotes(event.target.value)}
                />
              </label>
              <label className="form-field">
                <span>Availability</span>
                <input
                  value={availability}
                  onChange={(event) => setAvailability(event.target.value)}
                  placeholder="General availability, Preview…"
                />
              </label>
              {idea && (
                <>
                  <div className="workflow-action">
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={safe}
                        onChange={(event) => setSafe(event.target.checked)}
                      />
                      <span>
                        I reviewed the wording and confirm it is customer-safe.
                      </span>
                    </label>
                    <Button
                      type="button"
                      icon="eye"
                      disabled={!safe || busy}
                      onClick={publish}
                    >
                      Publish staged changes
                    </Button>
                  </div>
                  <div className="workflow-action">
                    <p className="field-label">Link customer evidence</p>
                    <select
                      value={linkRequestId}
                      onChange={(event) => setLinkRequestId(event.target.value)}
                    >
                      <option value="">Select request</option>
                      {requests.map((request) => (
                        <option key={request.id} value={request.id}>
                          {request.id} · {request.title}
                        </option>
                      ))}
                    </select>
                    <input
                      value={linkReason}
                      onChange={(event) => setLinkReason(event.target.value)}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      icon="link"
                      disabled={!linkRequestId || busy}
                      onClick={link}
                    >
                      Link request
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
          {idea && (
            <section className="score-workspace">
              <p className="field-label">Priority evidence</p>
              <div className="score-inputs">
                {(
                  [
                    "impact",
                    "reach",
                    "strategicAlignment",
                    "commercialImpact",
                    "urgency",
                  ] as const
                ).map((key) => (
                  <label key={key}>
                    <span>{key.replace(/([A-Z])/g, " $1")}</span>
                    <select
                      value={score[key]}
                      onChange={(event) =>
                        setScore({
                          ...score,
                          [key]: Number(event.target.value),
                        })
                      }
                    >
                      {[1, 2, 3, 4, 5].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                ))}
                <label>
                  <span>Confidence</span>
                  <select
                    value={score.confidence}
                    onChange={(event) =>
                      setScore({
                        ...score,
                        confidence: Number(event.target.value),
                      })
                    }
                  >
                    {[50, 80, 100].map((value) => (
                      <option key={value} value={value}>
                        {value}%
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Effort</span>
                  <select
                    value={score.effort}
                    onChange={(event) =>
                      setScore({ ...score, effort: Number(event.target.value) })
                    }
                  >
                    {[1, 2, 3, 5, 8, 13].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <Button type="button" variant="secondary" onClick={addScore}>
                  Record score
                </Button>
              </div>
            </section>
          )}
          {idea && (
            <section className="merge-workspace">
              <p className="field-label">Merge duplicate idea</p>
              <select
                value={mergeSource}
                onChange={(event) => setMergeSource(event.target.value)}
              >
                <option value="">Select source idea</option>
                {ideas
                  .filter(
                    (item) =>
                      item.id !== idea.id && item.internalStatus !== "Archived",
                  )
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id} · {item.internalTitle}
                    </option>
                  ))}
              </select>
              <Button
                type="button"
                variant="secondary"
                disabled={!mergeSource || busy}
                onClick={merge}
              >
                Merge into {idea.id}
              </Button>
            </section>
          )}
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <footer>
            <span>{idea?.publishState || "Internal draft"}</span>
            <div>
              <Button type="button" variant="secondary" onClick={onClose}>
                Close
              </Button>
              <Button
                type="submit"
                icon="check"
                disabled={
                  busy || !internalTitle.trim() || !internalDescription.trim()
                }
              >
                {busy ? "Saving…" : "Save internal changes"}
              </Button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}

function ReleasesPage({
  releases,
  ideas,
  onChange,
  onIdeasChange,
  onToast,
}: {
  releases: ReleaseItem[];
  ideas: InternalIdea[];
  onChange: (items: ReleaseItem[]) => void;
  onIdeasChange: (items: InternalIdea[]) => void;
  onToast: (message: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [summary, setSummary] = useState("");
  const [availability, setAvailability] = useState("General availability");
  const [documentationUrl, setDocumentationUrl] = useState("");
  const [ideaIds, setIdeaIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  async function create(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/v1/internal/releases", {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({
        title,
        date,
        summary,
        availability,
        documentationUrl,
        ideaIds,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data?.error?.message || "Release could not be created");
      return;
    }
    onChange([data.item, ...releases]);
    setCreating(false);
    setTitle("");
    setSummary("");
    setIdeaIds([]);
    onToast(`${data.item.id} was created as a draft.`);
  }
  async function publish(item: ReleaseItem) {
    const response = await fetch(
      `/api/v1/internal/releases/${item.id}/publish`,
      { method: "POST", headers: mutationHeaders(false) },
    );
    const data = await response.json();
    if (!response.ok) {
      onToast(data?.error?.message || "Release could not be published.");
      return;
    }
    onChange(
      releases.map((release) => (release.id === item.id ? data.item : release)),
    );
    onIdeasChange(
      ideas.map((idea) =>
        item.ideaIds.includes(idea.id)
          ? {
              ...idea,
              internalStatus: "Released",
              status: "Released",
              horizon: "Released",
              publishState: "Published",
              tone: "success",
            }
          : idea,
      ),
    );
    onToast(`${item.id} was published and eligible customers were notified.`);
  }
  return (
    <div className="page-stack management-page">
      <PageIntro
        eyebrow="Release communication"
        title="Releases"
        description="Publish availability, documentation, and safe release notes to requesters and followers."
        action={
          <Button icon="plus" onClick={() => setCreating(true)}>
            Create release
          </Button>
        }
      />
      <div className="release-list">
        {releases.length === 0 ? (
          <EmptyState
            title="No releases yet"
            description="Create a release when one or more ideas are ready to communicate."
            action="Create release"
            onAction={() => setCreating(true)}
          />
        ) : (
          releases.map((release) => (
            <article key={release.id}>
              <header>
                <div>
                  <code>{release.id}</code>
                  <h3>{release.title}</h3>
                </div>
                <Status tone={release.published ? "success" : "warning"}>
                  {release.published ? "Published" : "Draft"}
                </Status>
              </header>
              <p>{release.summary}</p>
              <footer>
                <span>
                  {release.date} · {release.availability} ·{" "}
                  {release.ideaIds.length} ideas
                </span>
                {!release.published && (
                  <Button onClick={() => publish(release)}>
                    Publish release
                  </Button>
                )}
              </footer>
            </article>
          ))
        )}
      </div>
      {creating && (
        <div
          className="modal-layer"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCreating(false);
          }}
        >
          <section className="management-modal" role="dialog" aria-modal="true">
            <header>
              <div>
                <p className="eyebrow">Release record</p>
                <h2>Create release</h2>
                <p>
                  Publishing will update included ideas and notify each eligible
                  user once.
                </p>
              </div>
              <button
                className="icon-button"
                onClick={() => setCreating(false)}
              >
                <Icon name="x" />
              </button>
            </header>
            <form onSubmit={create}>
              <div className="form-grid">
                <label className="form-field">
                  <span>
                    Title <em>Required</em>
                  </span>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    required
                  />
                </label>
                <label className="form-field">
                  <span>Release date</span>
                  <input
                    type="date"
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                    required
                  />
                </label>
              </div>
              <label className="form-field">
                <span>
                  Customer summary <em>Required</em>
                </span>
                <textarea
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                  required
                />
              </label>
              <div className="form-grid">
                <label className="form-field">
                  <span>Availability</span>
                  <select
                    value={availability}
                    onChange={(event) => setAvailability(event.target.value)}
                  >
                    {[
                      "Preview",
                      "Selected customers",
                      "General availability",
                      "Tenant-specific",
                    ].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label className="form-field">
                  <span>Documentation URL</span>
                  <input
                    type="url"
                    value={documentationUrl}
                    onChange={(event) =>
                      setDocumentationUrl(event.target.value)
                    }
                  />
                </label>
              </div>
              <fieldset className="membership-editor">
                <legend>
                  Included ideas <em>Required</em>
                </legend>
                {ideas
                  .filter((idea) => idea.internalStatus !== "Archived")
                  .map((idea) => (
                    <div
                      className={ideaIds.includes(idea.id) ? "selected" : ""}
                      key={idea.id}
                    >
                      <label>
                        <input
                          type="checkbox"
                          checked={ideaIds.includes(idea.id)}
                          onChange={() =>
                            setIdeaIds((items) =>
                              items.includes(idea.id)
                                ? items.filter((id) => id !== idea.id)
                                : [...items, idea.id],
                            )
                          }
                        />
                        <span>
                          <strong>
                            {idea.id} · {idea.internalTitle}
                          </strong>
                          <small>{idea.internalStatus}</small>
                        </span>
                      </label>
                    </div>
                  ))}
              </fieldset>
              {error && <div className="form-error">{error}</div>}
              <footer>
                <span>{ideaIds.length} ideas selected</span>
                <div>
                  <Button
                    variant="secondary"
                    onClick={() => setCreating(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    icon="check"
                    disabled={
                      !title.trim() || !summary.trim() || ideaIds.length === 0
                    }
                  >
                    Create draft
                  </Button>
                </div>
              </footer>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

function AuditPage({ items }: { items: AuditItem[] }) {
  return (
    <div className="page-stack management-page">
      <PageIntro
        eyebrow="Immutable history"
        title="Audit log"
        description="Security and business history for publication, roles, links, status, scoring, exports, and administrative changes."
      />
      <div className="management-toolbar">
        <span>{items.length} recent events</span>
      </div>
      <div className="audit-table">
        <div className="audit-head">
          <span>Time</span>
          <span>Action</span>
          <span>Entity</span>
          <span>Actor / organization</span>
          <span>Correlation</span>
        </div>
        {items.length === 0 ? (
          <EmptyState
            title="No audit events"
            description="Material mutations will appear here with actor and correlation context."
            action="Refresh"
            onAction={() => window.location.reload()}
          />
        ) : (
          items.map((item) => (
            <div className="audit-row" key={item.id}>
              <code>{new Date(item.createdAt).toLocaleString()}</code>
              <strong>{item.action}</strong>
              <span>
                {item.entityType} · {item.entityId?.slice(0, 12) || "—"}
              </span>
              <span>
                {item.actor || "System"}
                <small>{item.organizationId || "Global"}</small>
              </span>
              <code>{item.correlationId.slice(0, 8)}</code>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function AnalyticsPage({
  requests,
  ideas,
  onToast,
}: {
  requests: RequestItem[];
  ideas: Idea[];
  onToast: (message: string) => void;
}) {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  useEffect(() => {
    fetch("/api/v1/internal/analytics/summary", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data && setSummary(data))
      .catch(() => undefined);
  }, []);
  const areas = Array.from(
    new Set([
      ...requests.map((item) => item.area),
      ...ideas.map((item) => item.area),
    ]),
  )
    .map((area) => ({
      area,
      requests: requests.filter((item) => item.area === area).length,
      ideas: ideas.filter((item) => item.area === area).length,
    }))
    .sort((a, b) => b.requests - a.requests);
  function exportCsv() {
    const anchor = document.createElement("a");
    anchor.href = "/api/v1/internal/analytics/requests.csv";
    anchor.click();
    onToast("Authorized request results exported.");
  }
  return (
    <div className="page-stack management-page">
      <PageIntro
        eyebrow="Product intelligence"
        title="Feedback analytics"
        description="Demand, flow, and data quality across the currently authorized customer scope."
        action={
          <Button variant="secondary" icon="arrow" onClick={exportCsv}>
            Export CSV
          </Button>
        }
      />
      <section className="admin-metric-grid">
        <div>
          <span>Open requests</span>
          <strong>
            {summary?.requests.open ??
              requests.filter(
                (item) =>
                  !["Released", "Closed", "Withdrawn"].includes(item.status),
              ).length}
          </strong>
          <small>Current authorized scope</small>
        </div>
        <div>
          <span>Unique product areas</span>
          <strong>{areas.length}</strong>
          <small>Across requests and ideas</small>
        </div>
        <div>
          <span>Published releases</span>
          <strong>
            {ideas.filter((item) => item.status === "Released").length}
          </strong>
          <small>Customer-visible outcomes</small>
        </div>
      </section>
      <section className="admin-metric-grid">
        <div>
          <span>Average first response</span>
          <strong>
            {Number(summary?.serviceLevels.averageFirstResponseHours || 0).toFixed(1)}h
          </strong>
          <small>Authorized non-test organizations</small>
        </div>
        <div>
          <span>Average time to triage</span>
          <strong>
            {Number(summary?.serviceLevels.averageTriageHours || 0).toFixed(1)}h
          </strong>
          <small>Submitted to triaged</small>
        </div>
        <div>
          <span>Delivered notifications</span>
          <strong>
            {summary?.notifications.find((item) => item.state === "Delivered")
              ?.count || 0}
          </strong>
          <small>Delivery state from durable outbox</small>
        </div>
      </section>
      <section className="analytics-panel">
        <header>
          <div>
            <p className="eyebrow">Demand distribution</p>
            <h3>Requests by product area</h3>
          </div>
          <span>Unique organization counts remain internal</span>
        </header>
        <div className="analytics-bars">
          {areas.map((item) => {
            const width = Math.max(
              8,
              (item.requests /
                Math.max(1, ...areas.map((entry) => entry.requests))) *
                100,
            );
            return (
              <div key={item.area}>
                <span>{item.area}</span>
                <div>
                  <i style={{ width: `${width}%` }} />
                </div>
                <strong>{item.requests}</strong>
                <small>{item.ideas} ideas</small>
              </div>
            );
          })}
        </div>
      </section>
      <section className="data-quality">
        <div>
          <Icon name="check" size={18} />
          <span>
            <strong>Data quality checks</strong>
            <small>
              {summary?.dataQuality.missingOwner ??
                requests.filter((item) => item.owner === "Unassigned").length}{" "}
              requests need an owner ·{" "}
              {summary?.dataQuality.missingClassification ??
                requests.filter((item) => !item.area).length}{" "}
              need classification
            </small>
          </span>
        </div>
        <Button
          variant="secondary"
          onClick={() =>
            onToast("Data quality view is filtered to authorized records.")
          }
        >
          Review records
        </Button>
      </section>
    </div>
  );
}

function SettingsPage({ onToast }: { onToast: (message: string) => void }) {
  const [settings, setSettings] = useState<PulseSettings>({
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
  });
  const [saving, setSaving] = useState(false);
  const [taxonomy, setTaxonomy] = useState<TaxonomyValue[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookSubscriptionItem[]>([]);
  const [webhookUrl, setWebhookUrl] = useState("");
  useEffect(() => {
    Promise.all([
      fetch("/api/v1/admin/settings"),
      fetch("/api/v1/admin/taxonomy"),
      fetch("/api/v1/internal/webhooks"),
    ])
      .then(async ([settingsResponse, taxonomyResponse, webhooksResponse]) => {
        if (settingsResponse.ok)
          setSettings((await settingsResponse.json()).item);
        if (taxonomyResponse.ok)
          setTaxonomy((await taxonomyResponse.json()).items);
        if (webhooksResponse.ok)
          setWebhooks((await webhooksResponse.json()).items);
      })
      .catch(() => undefined);
  }, []);
  async function save() {
    setSaving(true);
    const response = await fetch("/api/v1/admin/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    const data = await response.json();
    setSaving(false);
    if (!response.ok) {
      onToast(data?.error?.message || "Settings could not be saved.");
      return;
    }
    setSettings(data.item);
    onToast("Product settings saved and added to the audit trail.");
  }
  function setWeight(key: keyof PulseSettings["scoreWeights"], value: number) {
    setSettings((current) => ({
      ...current,
      scoreWeights: { ...current.scoreWeights, [key]: value },
    }));
  }
  async function saveTaxonomy(item: TaxonomyValue) {
    const response = await fetch("/api/v1/admin/taxonomy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(item),
    });
    const data = await response.json();
    if (!response.ok) {
      onToast(data?.error?.message || "Taxonomy could not be saved.");
      return;
    }
    setTaxonomy((items) => {
      const exists = items.some((value) => value.id === data.item.id);
      return exists
        ? items.map((value) => (value.id === data.item.id ? data.item : value))
        : [...items, data.item];
    });
    onToast("Taxonomy saved and added to the audit trail.");
  }
  function addTaxonomy() {
    const value = window.prompt("New product area name")?.trim();
    if (!value) return;
    void saveTaxonomy({
      id: "new",
      kind: "Product area",
      value,
      active: true,
      sortOrder: taxonomy.filter((item) => item.kind === "Product area").length,
    });
  }
  async function addWebhook() {
    if (!webhookUrl.trim()) return;
    const response = await fetch("/api/v1/internal/webhooks", {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({
        url: webhookUrl,
        events: [
          "request.created",
          "request.status.changed",
          "request.linked",
          "idea.published",
          "release.published",
        ],
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      onToast(data?.error?.message || "Webhook could not be created.");
      return;
    }
    setWebhooks((items) => [data, ...items]);
    setWebhookUrl("");
    onToast("Signed webhook subscription created.");
  }
  async function toggleWebhook(item: WebhookSubscriptionItem) {
    const response = await fetch(`/api/v1/internal/webhooks/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: !item.active }),
    });
    if (!response.ok) {
      onToast("Webhook state could not be changed.");
      return;
    }
    setWebhooks((items) =>
      items.map((value) =>
        value.id === item.id ? { ...value, active: !value.active } : value,
      ),
    );
  }
  return (
    <div className="page-stack management-page">
      <PageIntro
        eyebrow="System administration"
        title="Product settings"
        description="Govern taxonomy, customer wording, retention, scoring, localization, and secure attachment policy."
      />
      <section className="settings-grid">
        <article className="settings-card">
          <header>
            <Icon name="plus" size={19} />
            <div>
              <h3>Attachment policy</h3>
              <p>
                Allow-listed files are quarantined until malware scanning
                reports clean.
              </p>
            </div>
          </header>
          <div className="form-grid">
            <label className="form-field">
              <span>Maximum per file</span>
              <select
                value={settings.attachmentMaxMb}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    attachmentMaxMb: Number(event.target.value),
                  })
                }
              >
                <option value="10">10 MB</option>
                <option value="25">25 MB</option>
                <option value="50">50 MB</option>
              </select>
            </label>
            <label className="form-field">
              <span>Maximum per request</span>
              <select
                value={settings.requestAttachmentMaxMb}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    requestAttachmentMaxMb: Number(event.target.value),
                  })
                }
              >
                <option value="50">50 MB</option>
                <option value="100">100 MB</option>
                <option value="250">250 MB</option>
              </select>
            </label>
          </div>
          <label className="form-field">
            <span>Retention period</span>
            <select
              value={settings.retentionDays}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  retentionDays: Number(event.target.value),
                })
              }
            >
              <option value="365">1 year</option>
              <option value="1095">3 years</option>
              <option value="2555">7 years</option>
            </select>
          </label>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save policy"}
          </Button>
        </article>
        <article className="settings-card">
          <header>
            <Icon name="map" size={19} />
            <div>
              <h3>Roadmap and localization</h3>
              <p>
                English is the source language with explicit Icelandic fallback.
              </p>
            </div>
          </header>
          <label className="form-field">
            <span>Editing language</span>
            <select
              value={settings.defaultLocale}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  defaultLocale: event.target.value as "en" | "is",
                })
              }
            >
              <option value="en">English</option>
              <option value="is">Icelandic</option>
            </select>
          </label>
          <label className="form-field">
            <span>Roadmap disclaimer</span>
            <textarea
              rows={4}
              value={settings.roadmapDisclaimer}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  roadmapDisclaimer: event.target.value,
                })
              }
            />
          </label>
          <Button variant="secondary" onClick={save} disabled={saving}>
            Save wording
          </Button>
        </article>
        <article className="settings-card">
          <header>
            <Icon name="layers" size={19} />
            <div>
              <h3>Priority formula</h3>
              <p>
                Scores support product judgment and never publish decisions
                automatically.
              </p>
            </div>
          </header>
          <div className="weight-list">
            {(
              [
                ["impact", "Customer impact"],
                ["reach", "Reach"],
                ["strategy", "Strategic alignment"],
                ["commercial", "Commercial impact"],
                ["urgency", "Urgency / risk"],
              ] as Array<[keyof PulseSettings["scoreWeights"], string]>
            ).map(([key, label]) => (
              <label key={key}>
                <span>{label}</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={settings.scoreWeights[key]}
                  onChange={(event) =>
                    setWeight(key, Number(event.target.value))
                  }
                  aria-label={`${label} weight`}
                />
                <strong>%</strong>
              </label>
            ))}
          </div>
          <Button variant="secondary" onClick={save} disabled={saving}>
            Save weights
          </Button>
        </article>
        <article className="settings-card">
          <header>
            <Icon name="layers" size={19} />
            <div>
              <h3>Product taxonomy</h3>
              <p>
                Deactivated values remain on history but cannot be selected for
                new records.
              </p>
            </div>
          </header>
          <div className="taxonomy-list">
            {taxonomy
              .filter((item) => item.kind === "Product area")
              .map((item) => (
                <div key={item.id}>
                  <span>{item.value}</span>
                  <button
                    onClick={() =>
                      saveTaxonomy({ ...item, active: !item.active })
                    }
                  >
                    {item.active ? "Deactivate" : "Reactivate"}
                  </button>
                </div>
              ))}
          </div>
          <Button variant="secondary" icon="plus" onClick={addTaxonomy}>
            Add product area
          </Button>
        </article>
        <article className="settings-card">
          <header>
            <Icon name="link" size={19} />
            <div>
              <h3>Signed outbound webhooks</h3>
              <p>
                HTTPS endpoints receive non-confidential event envelopes with
                HMAC signatures and retry tracking.
              </p>
            </div>
          </header>
          <div className="webhook-list">
            {webhooks.map((item) => (
              <div key={item.id}>
                <span>
                  <strong>{item.url}</strong>
                  <small>{item.events.length} selected events</small>
                </span>
                <button onClick={() => toggleWebhook(item)}>
                  {item.active ? "Disable" : "Enable"}
                </button>
              </div>
            ))}
          </div>
          <label className="form-field">
            <span>HTTPS endpoint</span>
            <input
              type="url"
              value={webhookUrl}
              onChange={(event) => setWebhookUrl(event.target.value)}
              placeholder="https://example.com/pulse-events"
            />
          </label>
          <Button
            variant="secondary"
            icon="plus"
            onClick={addWebhook}
            disabled={!webhookUrl.trim()}
          >
            Add webhook
          </Button>
        </article>
      </section>
    </div>
  );
}

function NotificationsPopover({
  items,
  onRead,
  onOpenUpdates,
}: {
  items: NotificationItem[];
  onRead: (id: string) => void;
  onOpenUpdates: () => void;
}) {
  return (
    <div className="notification-popover">
      <header>
        <strong>Updates</strong>
        <button onClick={onOpenUpdates}>View all</button>
      </header>
      {items.length === 0 ? (
        <div className="notification-empty">No unread product updates.</div>
      ) : (
        items.slice(0, 5).map((item) => (
          <button
            key={item.id}
            onClick={() => onRead(item.id)}
            className={item.readAt ? "read" : ""}
          >
            <span
              className={`mini-icon ${item.eventType.includes("release") ? "success" : item.eventType.includes("needs") ? "warning" : "violet"}`}
            >
              <Icon
                name={
                  item.eventType.includes("release")
                    ? "check"
                    : item.eventType.includes("needs")
                      ? "message"
                      : "spark"
                }
                size={14}
              />
            </span>
            <span>
              <strong>
                {item.eventType
                  .replaceAll(".", " ")
                  .replace(/\b\w/g, (letter) => letter.toUpperCase())}
              </strong>
              <small>{new Date(item.createdAt).toLocaleString()}</small>
            </span>
          </button>
        ))
      )}
    </div>
  );
}

export default function Home() {
  return <AppShell />;
}
