"use client";

import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import Image from "next/image";

type Page = "home" | "ideas" | "roadmap" | "requests" | "updates" | "triage" | "companies" | "users" | "authentication";
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

type UserMembership = { companyId: string; role: "Company admin" | "Requester" | "Viewer" | "Product manager"; };
type ManagedUser = {
  id: string;
  name: string;
  email: string;
  status: "Active" | "Invited" | "Suspended";
  authentication: "OTP" | "Entra ID";
  memberships: UserMembership[];
};

const initialIdeas: Idea[] = [
  {
    id: "IDEA-318",
    title: "Audit log API",
    description: "Provide governed API access to tenant, authentication, report, and administrative audit events.",
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
    description: "Deliver governed PDF and Excel exports to a selected SharePoint library on a schedule.",
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
    description: "Schedule screen playlists by day, time, tenant, and audience with clear override rules.",
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
    description: "Let delegated tenant administrators create and rotate report keys within governed policies.",
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
    description: "Improve navigation, filter behavior, and portrait layouts for embedded dashboards on mobile devices.",
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
    description: "Add synchronization health, retry controls, and a clear history for group-based access changes.",
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
    description: "Embed complete Power BI apps while preserving DataCentral authentication and access governance.",
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
    problem: "Our external customers receive scheduled PDF reports. We need the export to use customer-specific logos and cover pages.",
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
    problem: "Finance teams should receive governed report exports directly in their existing SharePoint libraries.",
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
    problem: "Our security team needs DataCentral events in the central SIEM without relying on manual export.",
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
    problem: "Field managers struggle to move between dashboard pages and close the filter panel on iPhone.",
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
  { id: "ORG-001", name: "Origo", type: "Customer", status: "Active", domain: "origo.is", users: 8, requests: 14, authentication: ["OTP", "Entra ID"] },
  { id: "ORG-002", name: "Landsnet", type: "Customer", status: "Active", domain: "landsnet.is", users: 12, requests: 9, authentication: ["Entra ID"] },
  { id: "ORG-003", name: "RARIK", type: "Customer", status: "Onboarding", domain: "rarik.is", users: 5, requests: 3, authentication: ["OTP", "Entra ID"] },
  { id: "ORG-004", name: "Crayon", type: "Partner", status: "Active", domain: "crayon.com", users: 4, requests: 7, authentication: ["Entra ID"] },
  { id: "ORG-005", name: "uiData", type: "Internal", status: "Active", domain: "uidata.com", users: 6, requests: 21, authentication: ["OTP", "Entra ID"] },
];

const initialManagedUsers: ManagedUser[] = [
  { id: "USR-101", name: "Bjarki Kristjánsson", email: "bjarki@uidata.com", status: "Active", authentication: "Entra ID", memberships: [{ companyId: "ORG-001", role: "Company admin" }, { companyId: "ORG-003", role: "Company admin" }, { companyId: "ORG-005", role: "Product manager" }] },
  { id: "USR-102", name: "Óskar Jónsson", email: "oskar@uidata.com", status: "Active", authentication: "Entra ID", memberships: [{ companyId: "ORG-001", role: "Requester" }, { companyId: "ORG-002", role: "Company admin" }, { companyId: "ORG-005", role: "Product manager" }] },
  { id: "USR-103", name: "Anna Guðmundsdóttir", email: "anna@origo.is", status: "Active", authentication: "Entra ID", memberships: [{ companyId: "ORG-001", role: "Company admin" }] },
  { id: "USR-104", name: "Jón Einarsson", email: "jon@landsnet.is", status: "Active", authentication: "OTP", memberships: [{ companyId: "ORG-002", role: "Requester" }] },
  { id: "USR-105", name: "Sara Magnúsdóttir", email: "sara@rarik.is", status: "Invited", authentication: "OTP", memberships: [{ companyId: "ORG-003", role: "Company admin" }] },
  { id: "USR-106", name: "Martin de Vries", email: "martin@crayon.com", status: "Active", authentication: "Entra ID", memberships: [{ companyId: "ORG-001", role: "Viewer" }, { companyId: "ORG-003", role: "Viewer" }, { companyId: "ORG-004", role: "Company admin" }] },
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
  companies: "Companies",
  users: "Users",
  authentication: "Authentication",
};

type IconName = "home" | "spark" | "map" | "inbox" | "bell" | "search" | "plus" | "arrow" | "clock" | "check" | "users" | "message" | "chevron" | "menu" | "x" | "filter" | "layers" | "settings" | "building" | "send" | "link" | "eye";

const iconPaths: Record<IconName, ReactNode> = {
  home: <><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-7h6v7"/></>,
  spark: <><path d="m12 3-1.7 4.3L6 9l4.3 1.7L12 15l1.7-4.3L18 9l-4.3-1.7L12 3Z"/><path d="m5 15-.9 2.1L2 18l2.1.9L5 21l.9-2.1L8 18l-2.1-.9L5 15Z"/></>,
  map: <><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/></>,
  inbox: <><path d="M4 4h16v16H4z"/><path d="M4 14h4l2 3h4l2-3h4"/></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  arrow: <><path d="M5 12h14M13 6l6 6-6 6"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  check: <><path d="m5 12 4 4L19 6"/></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
  message: <><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z"/></>,
  chevron: <><path d="m9 18 6-6-6-6"/></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
  x: <><path d="m6 6 12 12M18 6 6 18"/></>,
  filter: <><path d="M4 5h16M7 12h10M10 19h4"/></>,
  layers: <><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
  building: <><path d="M3 21h18M6 21V5h8v16M14 9h4v12M9 8h2M9 12h2M9 16h2"/></>,
  send: <><path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/></>,
  link: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1"/></>,
  eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></>,
};

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg className="icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">{iconPaths[name]}</svg>;
}

function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`status status-${tone}`}><span className="status-dot" />{children}</span>;
}

function Button({ children, variant = "primary", icon, onClick, type = "button", className = "", disabled = false }: { children: ReactNode; variant?: "primary" | "secondary" | "ghost"; icon?: IconName; onClick?: () => void; type?: "button" | "submit"; className?: string; disabled?: boolean }) {
  return <button type={type} disabled={disabled} onClick={onClick} className={`button button-${variant} ${className}`}>{icon && <Icon name={icon} size={16} />}{children}</button>;
}

function AppShell() {
  const [page, setPage] = useState<Page>("home");
  const [menuOpen, setMenuOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [detailRequest, setDetailRequest] = useState<RequestItem | null>(null);
  const [detailIdea, setDetailIdea] = useState<Idea | null>(null);
  const [ideas, setIdeas] = useState(initialIdeas);
  const [requests, setRequests] = useState(initialRequests);
  const [companies, setCompanies] = useState(initialCompanies);
  const [managedUsers, setManagedUsers] = useState(initialManagedUsers);
  const [toast, setToast] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem("dc-ideas-requests");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        const timer = window.setTimeout(() => setRequests(parsed), 0);
        return () => window.clearTimeout(timer);
      } catch { /* retain demo data */ }
    }
  }, []);

  useEffect(() => {
    if (toast) {
      const timer = window.setTimeout(() => setToast(null), 3200);
      return () => window.clearTimeout(timer);
    }
  }, [toast]);

  function navigate(next: Page) {
    setPage(next);
    setMenuOpen(false);
    setNotificationsOpen(false);
  }

  function addRequest(request: RequestItem) {
    const next = [request, ...requests];
    setRequests(next);
    window.localStorage.setItem("dc-ideas-requests", JSON.stringify(next));
    setComposerOpen(false);
    setPage("requests");
    setToast(`${request.id} was submitted for review.`);
  }

  function followIdea(id: string) {
    setIdeas((items) => items.map((item) => item.id === id ? { ...item, followed: !item.followed, followers: item.followers + (item.followed ? -1 : 1) } : item));
    const idea = ideas.find((item) => item.id === id);
    setToast(idea?.followed ? "You will no longer receive updates." : "You are now following this idea.");
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand">
          <Image src="/brand/datacentral-blacktext.svg" alt="DataCentral" width={129} height={24} priority />
          <span>Pulse</span>
        </div>
        <nav className="nav" aria-label="Primary navigation">
          {navItems.map((item) => (
            <button key={item.id} className={`nav-item ${page === item.id ? "active" : ""}`} onClick={() => navigate(item.id)}>
              <Icon name={item.icon} size={17} /><span>{item.label}</span>
              {item.id === "updates" && <span className="nav-count">3</span>}
            </button>
          ))}
          <div className="nav-section-label">DataCentral team</div>
          <button className={`nav-item ${page === "triage" ? "active" : ""}`} onClick={() => navigate("triage")}>
            <Icon name="layers" size={17} /><span>Triage inbox</span><span className="nav-count">6</span>
          </button>
          <button className={`nav-item ${page === "companies" ? "active" : ""}`} onClick={() => navigate("companies")}>
            <Icon name="building" size={17} /><span>Companies</span>
          </button>
          <button className={`nav-item ${page === "users" ? "active" : ""}`} onClick={() => navigate("users")}>
            <Icon name="users" size={17} /><span>Users</span>
          </button>
          <button className={`nav-item ${page === "authentication" ? "active" : ""}`} onClick={() => navigate("authentication")}>
            <Icon name="settings" size={17} /><span>Authentication</span>
          </button>
        </nav>
        <div className="sidebar-profile">
          <div className="avatar">BK</div>
          <div className="profile-copy"><strong>Bjarki Kristjánsson</strong><span>Origo · Customer admin</span></div>
          <Icon name="chevron" size={15} />
        </div>
      </aside>

      {menuOpen && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}

      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Icon name="menu" /></button>
            <h1>{pageTitles[page]}</h1>
          </div>
          <div className="topbar-actions">
            <button className="workspace-switcher"><Icon name="building" size={15} /><span>Origo</span><Icon name="chevron" size={13} /></button>
            <button className="icon-button notification-button" aria-label="Notifications" onClick={() => setNotificationsOpen(!notificationsOpen)}><Icon name="bell" /><span /></button>
            <Button icon="plus" onClick={() => setComposerOpen(true)}>Submit a request</Button>
          </div>
          {notificationsOpen && <NotificationsPopover onOpenUpdates={() => navigate("updates")} />}
        </header>

        <main className="content">
          {page === "home" && <HomePage requests={requests} ideas={ideas} onSubmit={() => setComposerOpen(true)} onOpenRequest={setDetailRequest} onOpenIdea={setDetailIdea} onNavigate={navigate} />}
          {page === "ideas" && <IdeasPage ideas={ideas} onOpen={setDetailIdea} onFollow={followIdea} onSubmit={() => setComposerOpen(true)} />}
          {page === "roadmap" && <RoadmapPage ideas={ideas} onOpen={setDetailIdea} />}
          {page === "requests" && <RequestsPage requests={requests} onOpen={setDetailRequest} onSubmit={() => setComposerOpen(true)} />}
          {page === "updates" && <UpdatesPage ideas={ideas} onOpen={setDetailIdea} />}
          {page === "triage" && <TriagePage requests={requests} ideas={ideas} setRequests={(next) => { setRequests(next); window.localStorage.setItem("dc-ideas-requests", JSON.stringify(next)); }} onToast={setToast} />}
          {page === "companies" && <CompaniesPage companies={companies} users={managedUsers} onChange={setCompanies} onToast={setToast} />}
          {page === "users" && <UsersPage users={managedUsers} companies={companies} onChange={setManagedUsers} onToast={setToast} />}
          {page === "authentication" && <AuthenticationPage companies={companies} onToast={setToast} />}
        </main>
      </div>

      {composerOpen && <RequestComposer ideas={ideas} requestCount={requests.length} onClose={() => setComposerOpen(false)} onSubmit={addRequest} onFollow={followIdea} />}
      {detailRequest && <RequestDrawer request={detailRequest} idea={ideas.find((idea) => idea.id === detailRequest.linkedIdea)} onClose={() => setDetailRequest(null)} onToast={setToast} />}
      {detailIdea && <IdeaDrawer idea={ideas.find((idea) => idea.id === detailIdea.id) || detailIdea} onClose={() => setDetailIdea(null)} onFollow={followIdea} />}
      {toast && <div className="toast" role="status"><span className="toast-icon"><Icon name="check" size={15} /></span><span>{toast}</span></div>}
    </div>
  );
}

function HomePage({ requests, ideas, onSubmit, onOpenRequest, onOpenIdea, onNavigate }: { requests: RequestItem[]; ideas: Idea[]; onSubmit: () => void; onOpenRequest: (request: RequestItem) => void; onOpenIdea: (idea: Idea) => void; onNavigate: (page: Page) => void }) {
  const [search, setSearch] = useState("");
  const matches = search.trim().length > 2 ? ideas.filter((idea) => `${idea.title} ${idea.description}`.toLowerCase().includes(search.toLowerCase())).slice(0, 3) : [];
  return <div className="page-stack home-page">
    <section className="welcome-row">
      <div><p className="eyebrow">Customer feedback</p><h2>Good morning, Bjarki</h2><p>Track your requests and help shape what DataCentral builds next.</p></div>
      <div className="home-meta"><span>Last updated</span><strong>14 July 2026 · 23:42Z</strong></div>
    </section>

    <section className="ask-card">
      <div className="ask-copy"><div className="ask-icon"><Icon name="spark" size={22} /></div><div><h3>What would make DataCentral work better for your team?</h3><p>Search existing ideas or describe a new requirement.</p></div></div>
      <div className="ask-search-row">
        <div className="search-input large"><Icon name="search" size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search ideas and requests" aria-label="Search ideas and requests" /></div>
        <Button icon="plus" onClick={onSubmit}>Submit a request</Button>
      </div>
      {matches.length > 0 && <div className="quick-results">
        <span>Related ideas</span>
        {matches.map((idea) => <button key={idea.id} onClick={() => onOpenIdea(idea)}><strong>{idea.title}</strong><Status tone={idea.tone}>{idea.status}</Status><Icon name="arrow" size={15} /></button>)}
      </div>}
    </section>

    <section className="metric-grid">
      <button className="metric-card" onClick={() => onNavigate("requests")}><div className="metric-icon"><Icon name="inbox" /></div><div><span>Active requests</span><strong>{requests.filter((r) => !["Released", "Closed"].includes(r.status)).length}</strong><small>Across your organization</small></div><Icon name="chevron" size={16} /></button>
      <button className="metric-card warning" onClick={() => onNavigate("requests")}><div className="metric-icon"><Icon name="message" /></div><div><span>Needs your input</span><strong>{requests.filter((r) => r.status === "Needs information").length}</strong><small>Response requested</small></div><Icon name="chevron" size={16} /></button>
      <button className="metric-card" onClick={() => onNavigate("updates")}><div className="metric-icon"><Icon name="check" /></div><div><span>Recently released</span><strong>{ideas.filter((i) => i.status === "Released").length}</strong><small>In the last 30 days</small></div><Icon name="chevron" size={16} /></button>
    </section>

    <section className="home-grid">
      <div className="panel">
        <div className="panel-header"><div><h3>Your requests</h3><p>Latest activity from Origo</p></div><button className="text-link" onClick={() => onNavigate("requests")}>View all <Icon name="arrow" size={14} /></button></div>
        <div className="request-list">
          {requests.slice(0, 3).map((request) => <button className="request-row" key={request.id} onClick={() => onOpenRequest(request)}>
            <div className="request-state-icon"><Icon name={request.status === "Needs information" ? "message" : request.status === "Planned" ? "map" : "clock"} size={17} /></div>
            <div className="request-main"><strong>{request.title}</strong><span><code>{request.id}</code> · {request.area} · Updated {request.id === "DCI-1042" ? "today" : "3 days ago"}</span></div>
            <Status tone={request.tone}>{request.status}</Status><Icon name="chevron" size={16} />
          </button>)}
        </div>
      </div>
      <div className="panel shipped-panel">
        <div className="panel-header"><div><p className="eyebrow">Recently shipped</p><h3>Mobile dashboard improvements</h3></div><span className="release-mark"><Icon name="check" size={17} /></span></div>
        <p>Navigation, filters, and portrait layouts now work more consistently across embedded mobile dashboards.</p>
        <div className="release-details"><span>Released</span><code>8 JUL 2026</code></div>
        <button className="text-link" onClick={() => onOpenIdea(ideas.find((i) => i.id === "IDEA-276")!)}>View release notes <Icon name="arrow" size={14} /></button>
      </div>
    </section>
  </div>;
}

function IdeasPage({ ideas, onOpen, onFollow, onSubmit }: { ideas: Idea[]; onOpen: (idea: Idea) => void; onFollow: (id: string) => void; onSubmit: () => void }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All statuses");
  const filtered = ideas.filter((idea) => (`${idea.title} ${idea.description} ${idea.area}`.toLowerCase().includes(query.toLowerCase())) && (status === "All statuses" || idea.status === status));
  return <div className="page-stack">
    <PageIntro eyebrow="Product ideas" title="Browse customer-driven ideas" description="See what DataCentral is reviewing, planning, and delivering. Follow an idea to receive meaningful updates." action={<Button icon="plus" onClick={onSubmit}>Submit a request</Button>} />
    <div className="toolbar"><div className="search-input"><Icon name="search" size={17} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search ideas" /></div><label className="select-wrap"><Icon name="filter" size={16} /><select value={status} onChange={(e) => setStatus(e.target.value)}><option>All statuses</option><option>Under review</option><option>Considering</option><option>Planned</option><option>In progress</option><option>Released</option></select></label><span className="result-count">{filtered.length} ideas</span></div>
    <div className="idea-grid">
      {filtered.map((idea) => <article className="idea-card" key={idea.id}>
        <div className="idea-card-top"><Status tone={idea.tone}>{idea.status}</Status><code>{idea.id}</code></div>
        <button className="idea-title" onClick={() => onOpen(idea)}>{idea.title}</button>
        <p>{idea.description}</p>
        <div className="idea-tags"><span>{idea.area}</span><span>{idea.horizon}</span></div>
        <div className="idea-footer"><div><Icon name="building" size={15} /><span>{idea.organizations} organizations</span></div><button className={idea.followed ? "following" : ""} onClick={() => onFollow(idea.id)}><Icon name={idea.followed ? "check" : "bell"} size={14} />{idea.followed ? "Following" : "Follow"}</button></div>
      </article>)}
      {filtered.length === 0 && <EmptyState title="No ideas match these filters" description="Adjust the search or submit the requirement your team needs." action="Submit a request" onAction={onSubmit} />}
    </div>
  </div>;
}

function RoadmapPage({ ideas, onOpen }: { ideas: Idea[]; onOpen: (idea: Idea) => void }) {
  const columns: { title: Idea["horizon"]; note: string }[] = [
    { title: "Now", note: "Active delivery" }, { title: "Next", note: "Approved and sequenced" }, { title: "Later", note: "Validated, not committed" },
  ];
  return <div className="page-stack">
    <PageIntro eyebrow="Directional roadmap" title="Where the product is heading" description="Roadmap horizons express current intent and may change as customer evidence and delivery constraints evolve." />
    <div className="roadmap-callout"><Icon name="map" size={19} /><div><strong>Built from governed customer evidence</strong><span>Roadmap items combine related requests while keeping each customer’s context private.</span></div></div>
    <div className="roadmap-board">
      {columns.map((column) => <section className="roadmap-column" key={column.title}><header><div><h3>{column.title}</h3><p>{column.note}</p></div><span>{ideas.filter((i) => i.horizon === column.title).length}</span></header><div className="roadmap-items">
        {ideas.filter((i) => i.horizon === column.title).map((idea) => <button className="roadmap-card" key={idea.id} onClick={() => onOpen(idea)}><div><Status tone={idea.tone}>{idea.status}</Status><code>{idea.id}</code></div><strong>{idea.title}</strong><p>{idea.description}</p><footer><span>{idea.area}</span><span><Icon name="building" size={13} /> {idea.organizations}</span></footer></button>)}
      </div></section>)}
    </div>
    <section className="released-strip"><div><p className="eyebrow">Released</p><h3>Recently delivered</h3></div>{ideas.filter((i) => i.horizon === "Released").map((idea) => <button key={idea.id} onClick={() => onOpen(idea)}><span className="release-mark"><Icon name="check" size={14} /></span><span><strong>{idea.title}</strong><small>{idea.updated}</small></span><Icon name="chevron" size={15} /></button>)}</section>
  </div>;
}

function RequestsPage({ requests, onOpen, onSubmit }: { requests: RequestItem[]; onOpen: (request: RequestItem) => void; onSubmit: () => void }) {
  const [filter, setFilter] = useState("All");
  const visible = filter === "All" ? requests : requests.filter((r) => filter === "Active" ? r.status !== "Released" : r.status === filter);
  return <div className="page-stack">
    <PageIntro eyebrow="Your organization" title="Requests from Origo" description="Every request keeps its original context, status history, and link to the corresponding product idea." action={<Button icon="plus" onClick={onSubmit}>Submit a request</Button>} />
    <div className="tabs" role="tablist">{["All", "Active", "Needs information", "Released"].map((tab) => <button key={tab} className={filter === tab ? "active" : ""} onClick={() => setFilter(tab)}>{tab}<span>{tab === "All" ? requests.length : requests.filter((r) => tab === "Active" ? r.status !== "Released" : r.status === tab).length}</span></button>)}</div>
    <div className="table-panel"><div className="table-head"><span>Request</span><span>Product area</span><span>Submitted</span><span>Status</span><span /></div>{visible.map((request) => <button className="table-row" key={request.id} onClick={() => onOpen(request)}><span><strong>{request.title}</strong><code>{request.id}</code></span><span>{request.area}</span><code>{request.submitted}</code><Status tone={request.tone}>{request.status}</Status><Icon name="chevron" size={15} /></button>)}</div>
  </div>;
}

function UpdatesPage({ ideas, onOpen }: { ideas: Idea[]; onOpen: (idea: Idea) => void }) {
  const entries = [
    { date: "14 Jul", title: "Display playlist scheduler moved to In progress", text: "Delivery work has started. The first release focuses on recurring schedules and tenant-level overrides.", idea: ideas.find((i) => i.id === "IDEA-301")!, tone: "violet" as Tone },
    { date: "12 Jul", title: "Audit log API is planned", text: "The initial scope covers administrative, authentication, and report-access events with cursor-based retrieval.", idea: ideas.find((i) => i.id === "IDEA-318")!, tone: "violet" as Tone },
    { date: "8 Jul", title: "Mobile dashboard improvements released", text: "The updated mobile experience is available to all tenants. No configuration change is required.", idea: ideas.find((i) => i.id === "IDEA-276")!, tone: "success" as Tone },
    { date: "4 Jul", title: "More context requested", text: "We need an example of how customer branding should be selected for scheduled exports.", idea: undefined, tone: "warning" as Tone },
  ];
  return <div className="page-stack updates-layout">
    <PageIntro eyebrow="Product updates" title="Changes that matter to your team" description="A focused record of decisions, progress, and releases for requests you follow." />
    <div className="updates-feed">{entries.map((entry, index) => <article className="update-item" key={entry.title}><div className={`timeline-dot ${entry.tone}`}><Icon name={entry.tone === "success" ? "check" : entry.tone === "warning" ? "message" : "spark"} size={15} /></div><div className="update-body"><div className="update-meta"><code>{entry.date.toUpperCase()} 2026</code>{entry.idea && <Status tone={entry.idea.tone}>{entry.idea.status}</Status>}</div><h3>{entry.title}</h3><p>{entry.text}</p>{entry.idea && <button className="text-link" onClick={() => onOpen(entry.idea!)}>View product idea <Icon name="arrow" size={14} /></button>}</div>{index < entries.length - 1 && <span className="timeline-line" />}</article>)}</div>
  </div>;
}

function TriagePage({ requests, ideas, setRequests, onToast }: { requests: RequestItem[]; ideas: Idea[]; setRequests: (items: RequestItem[]) => void; onToast: (message: string) => void }) {
  const queue = useMemo(() => [...requests, { id: "DCI-1048", title: "Role templates across tenants", problem: "Our managed customers need a consistent starting set of roles whenever a new tenant is provisioned.", area: "Administration", impact: "High", status: "Submitted", tone: "neutral" as Tone, visibility: "Organization", submitted: "14 Jul 2026", owner: "Unassigned" }], [requests]);
  const [selectedId, setSelectedId] = useState(queue[0]?.id);
  const selected = queue.find((r) => r.id === selectedId) || queue[0];
  const [note, setNote] = useState("");
  function updateStatus(status: string, tone: Tone) {
    const updated = requests.some((r) => r.id === selected.id) ? requests.map((r) => r.id === selected.id ? { ...r, status, tone, owner: "Bjarki Kristjánsson" } : r) : [{ ...selected, status, tone, owner: "Bjarki Kristjánsson" }, ...requests];
    setRequests(updated);
    onToast(`${selected.id} was updated to ${status}.`);
  }
  return <div className="triage-page">
    <div className="triage-summary"><div><p className="eyebrow">Product workspace</p><h2>Review customer evidence</h2><p>Classify, consolidate, and communicate every request.</p></div><div className="triage-metrics"><span><strong>6</strong> untriaged</span><span><strong>2</strong> overdue</span><span><strong>1.8d</strong> median triage</span></div></div>
    <div className="triage-workspace">
      <aside className="triage-queue"><div className="queue-toolbar"><div className="search-input"><Icon name="search" size={15} /><input placeholder="Search queue" /></div><button className="icon-button"><Icon name="filter" size={16} /></button></div><div className="queue-tabs"><button className="active">Untriaged <span>6</span></button><button>Assigned to me <span>3</span></button></div><div className="queue-list">{queue.slice(0, 6).map((request) => <button key={request.id} className={selected.id === request.id ? "active" : ""} onClick={() => setSelectedId(request.id)}><div><code>{request.id}</code><span>{request.submitted}</span></div><strong>{request.title}</strong><p>{request.problem}</p><footer><span>{request.area}</span><Status tone={request.tone}>{request.status}</Status></footer></button>)}</div></aside>
      <section className="triage-detail"><div className="triage-detail-head"><div><div className="record-meta"><code>{selected.id}</code><span>Submitted by Origo</span><span>{selected.submitted}</span></div><h2>{selected.title}</h2></div><button className="icon-button"><Icon name="settings" size={17} /></button></div>
        <div className="triage-detail-grid"><div className="evidence-column"><section><p className="field-label">Customer problem</p><p className="evidence-text">{selected.problem}</p></section><section className="context-grid"><div><p className="field-label">Impact</p><strong>{selected.impact}</strong></div><div><p className="field-label">Product area</p><strong>{selected.area}</strong></div><div><p className="field-label">Visibility</p><strong>{selected.visibility}</strong></div><div><p className="field-label">Owner</p><strong>{selected.owner}</strong></div></section><section><div className="section-title"><div><p className="field-label">Related product ideas</p><span>Suggested from title and context</span></div></div><div className="suggestion-list">{ideas.filter((i) => i.area === selected.area || selected.title.toLowerCase().includes(i.title.split(" ")[0].toLowerCase())).slice(0, 2).map((idea) => <button key={idea.id}><div><Status tone={idea.tone}>{idea.status}</Status><code>{idea.id}</code></div><strong>{idea.title}</strong><span>{idea.organizations} organizations · {idea.area}</span><Icon name="link" size={16} /></button>)}{ideas.filter((i) => i.area === selected.area).length === 0 && <div className="no-suggestion">No strong match. Create a canonical product idea.</div>}</div></section><section><p className="field-label">Internal note</p><textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add evidence, constraints, or a decision rationale" /><div className="note-actions"><span>Internal only</span><Button variant="secondary" icon="send" onClick={() => { setNote(""); onToast("Internal note added."); }}>Add note</Button></div></section></div>
          <aside className="decision-panel"><p className="field-label">Triage decision</p><h3>Choose the next step</h3><p>This updates the customer-visible request and records the decision.</p><button onClick={() => updateStatus("Under review", "neutral")}><span className="decision-icon"><Icon name="search" size={17} /></span><span><strong>Start discovery</strong><small>Valid problem; investigate options</small></span><Icon name="chevron" size={15} /></button><button onClick={() => updateStatus("Linked", "violet")}><span className="decision-icon"><Icon name="link" size={17} /></span><span><strong>Link to product idea</strong><small>Consolidate with existing demand</small></span><Icon name="chevron" size={15} /></button><button onClick={() => updateStatus("Needs information", "warning")}><span className="decision-icon"><Icon name="message" size={17} /></span><span><strong>Request information</strong><small>Ask the customer a clear question</small></span><Icon name="chevron" size={15} /></button><button onClick={() => updateStatus("Closed", "neutral")}><span className="decision-icon"><Icon name="x" size={17} /></span><span><strong>Close request</strong><small>Requires a customer explanation</small></span><Icon name="chevron" size={15} /></button></aside>
        </div>
      </section>
    </div>
  </div>;
}

function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <header className="page-intro"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p>{description}</p></div>{action}</header>;
}

function EmptyState({ title, description, action, onAction }: { title: string; description: string; action: string; onAction: () => void }) {
  return <div className="empty-state"><span><Icon name="search" size={22} /></span><h3>{title}</h3><p>{description}</p><Button variant="secondary" onClick={onAction}>{action}</Button></div>;
}

function RequestComposer({ ideas, requestCount, onClose, onSubmit, onFollow }: { ideas: Idea[]; requestCount: number; onClose: () => void; onSubmit: (request: RequestItem) => void; onFollow: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [problem, setProblem] = useState("");
  const [area, setArea] = useState("Distribution");
  const [impact, setImpact] = useState("High");
  const [visibility, setVisibility] = useState("Organization");
  const [showDetails, setShowDetails] = useState(false);
  const suggestions = title.length > 3 ? ideas.map((idea) => ({ idea, score: title.toLowerCase().split(" ").filter((word) => word.length > 3).reduce((sum, word) => sum + (`${idea.title} ${idea.description}`.toLowerCase().includes(word) ? 1 : 0), 0) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 3) : [];
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !problem.trim()) return;
    onSubmit({ id: `DCI-${1043 + requestCount}`, title: title.trim(), problem: problem.trim(), area, impact, status: "Submitted", tone: "neutral", visibility, submitted: "14 Jul 2026", owner: "Unassigned" });
  }
  return <div className="modal-layer" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className="composer" role="dialog" aria-modal="true" aria-labelledby="composer-title"><header><div><p className="eyebrow">New customer request</p><h2 id="composer-title">Describe the outcome you need</h2><p>Start with the problem. DataCentral will assess the right product response.</p></div><button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="x" /></button></header><form onSubmit={submit}>
    <label className="form-field"><span>Short title <em>Required</em></span><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} placeholder="For example: Scheduled report delivery to SharePoint" required /><small>{title.length}/140</small></label>
    {suggestions.length > 0 && <div className="duplicate-panel"><div><Icon name="spark" size={17} /><span><strong>Related ideas already exist</strong><small>Add your organization’s interest or continue with distinct context.</small></span></div>{suggestions.map(({ idea }) => <div className="duplicate-row" key={idea.id}><button type="button" className="duplicate-copy" onClick={() => onFollow(idea.id)}><span><Status tone={idea.tone}>{idea.status}</Status><code>{idea.id}</code></span><strong>{idea.title}</strong><small>{idea.organizations} organizations have raised this need</small></button><Button type="button" variant="secondary" onClick={() => { onFollow(idea.id); onClose(); }}>This solves my need</Button></div>)}</div>}
    <label className="form-field"><span>Problem or desired outcome <em>Required</em></span><textarea value={problem} onChange={(e) => setProblem(e.target.value)} maxLength={5000} placeholder="What are you trying to achieve, who is affected, and what happens today?" required /><small>{problem.length}/5,000</small></label>
    <button type="button" className="disclosure" onClick={() => setShowDetails(!showDetails)}><Icon name={showDetails ? "x" : "plus"} size={15} />{showDetails ? "Hide additional context" : "Add impact and context"}</button>
    {showDetails && <div className="form-grid"><label className="form-field"><span>Product area</span><select value={area} onChange={(e) => setArea(e.target.value)}><option>Distribution</option><option>Governance</option><option>Authentication</option><option>Embedding</option><option>Display</option><option>Administration</option><option>Experience</option></select></label><label className="form-field"><span>Business impact</span><select value={impact} onChange={(e) => setImpact(e.target.value)}><option>Low</option><option>Medium</option><option>High</option><option>Critical</option></select></label></div>}
    <div className="visibility-choice"><Icon name="eye" size={17} /><div><strong>Visible to {visibility === "Organization" ? "your organization" : "you and DataCentral"}</strong><span>Raw customer context is never shared with other customers.</span></div><select value={visibility} onChange={(e) => setVisibility(e.target.value)}><option>Organization</option><option>Private</option></select></div>
    <footer><span>Draft saved locally</span><div><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" icon="send" disabled={!title.trim() || !problem.trim()}>Submit request</Button></div></footer>
  </form></section></div>;
}

function Drawer({ children, onClose, wide = false }: { children: ReactNode; onClose: () => void; wide?: boolean }) {
  return <div className="drawer-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><aside className={`drawer ${wide ? "drawer-wide" : ""}`} role="dialog" aria-modal="true">{children}</aside></div>;
}

function RequestDrawer({ request, idea, onClose, onToast }: { request: RequestItem; idea?: Idea; onClose: () => void; onToast: (message: string) => void }) {
  const [reply, setReply] = useState("");
  return <Drawer onClose={onClose}><header className="drawer-head"><div><code>{request.id}</code><h2>{request.title}</h2><Status tone={request.tone}>{request.status}</Status></div><button className="icon-button" onClick={onClose}><Icon name="x" /></button></header><div className="drawer-content"><section className="drawer-summary"><div><span>Product area</span><strong>{request.area}</strong></div><div><span>Business impact</span><strong>{request.impact}</strong></div><div><span>Submitted</span><code>{request.submitted}</code></div><div><span>Internal owner</span><strong>{request.owner}</strong></div></section>{request.status === "Needs information" && <section className="action-callout"><Icon name="message" size={19} /><div><strong>DataCentral needs more context</strong><p>How should the correct customer brand be selected when the same report is delivered to several external organizations?</p></div></section>}<section className="drawer-section"><p className="field-label">Original customer need</p><p>{request.problem}</p></section>{idea && <section className="linked-idea"><p className="field-label">Linked product idea</p><div><span><Status tone={idea.tone}>{idea.status}</Status><code>{idea.id}</code></span><strong>{idea.title}</strong><p>{idea.description}</p></div></section>}<section className="drawer-section"><p className="field-label">History</p><div className="history"><div><span /><div><strong>{request.status}</strong><p>Status updated by {request.owner}</p><code>14 JUL 2026 · 10:24Z</code></div></div><div><span /><div><strong>Request submitted</strong><p>Visible to Origo</p><code>{request.submitted.toUpperCase()} · 09:12Z</code></div></div></div></section><section className="reply-box"><label htmlFor="reply">Add context</label><textarea id="reply" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply to DataCentral or add relevant information" /><div><span>Visible to Origo and DataCentral</span><Button icon="send" disabled={!reply.trim()} onClick={() => { setReply(""); onToast("Your response was added to the request."); }}>Send response</Button></div></section></div></Drawer>;
}

function IdeaDrawer({ idea, onClose, onFollow }: { idea: Idea; onClose: () => void; onFollow: (id: string) => void }) {
  return <Drawer onClose={onClose}><header className="drawer-head"><div><code>{idea.id}</code><h2>{idea.title}</h2><Status tone={idea.tone}>{idea.status}</Status></div><button className="icon-button" onClick={onClose}><Icon name="x" /></button></header><div className="drawer-content"><section className="idea-highlight"><p className="eyebrow">Product direction</p><h3>{idea.horizon === "Released" ? "Available now" : `${idea.horizon} horizon`}</h3><p>{idea.description}</p></section><section className="drawer-summary"><div><span>Product area</span><strong>{idea.area}</strong></div><div><span>Organizations</span><strong>{idea.organizations}</strong></div><div><span>Followers</span><strong>{idea.followers}</strong></div><div><span>Last update</span><strong>{idea.updated.replace("Updated ", "")}</strong></div></section><section className="drawer-section"><p className="field-label">Latest update</p><h3>{idea.status === "Released" ? "Released to eligible tenants" : `${idea.status}: scope is being refined`}</h3><p>{idea.status === "In progress" ? "Delivery has started. The initial scope is focused on the highest-value customer workflow and governed administration." : idea.status === "Planned" ? "The capability has been approved for delivery. Detailed sequencing remains subject to technical dependencies and customer evidence." : "The product team is reviewing customer evidence, constraints, and the most appropriate implementation."}</p><code>14 JUL 2026 · 14:30Z</code></section><section className="organization-evidence"><Icon name="building" size={18} /><div><strong>Demand across {idea.organizations} organizations</strong><span>Customer identities and raw request context remain private.</span></div></section></div><footer className="drawer-footer"><Button variant="secondary" onClick={onClose}>Close</Button><Button icon={idea.followed ? "check" : "bell"} onClick={() => onFollow(idea.id)}>{idea.followed ? "Following" : "Follow idea"}</Button></footer></Drawer>;
}

function CompaniesPage({ companies, users, onChange, onToast }: { companies: Company[]; users: ManagedUser[]; onChange: (companies: Company[]) => void; onToast: (message: string) => void }) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Company | "new" | null>(null);
  const visible = companies.filter((company) => `${company.name} ${company.domain} ${company.type}`.toLowerCase().includes(query.toLowerCase()));
  function save(company: Company) {
    onChange(companies.some((item) => item.id === company.id) ? companies.map((item) => item.id === company.id ? company : item) : [...companies, company]);
    setEditing(null);
    onToast(`${company.name} was saved.`);
  }
  return <div className="page-stack management-page">
    <PageIntro eyebrow="Customer administration" title="Manage companies" description="Companies define the customer boundary. Requests, users, memberships, and authentication policies are scoped to a company." action={<Button icon="plus" onClick={() => setEditing("new")}>Add company</Button>} />
    <section className="admin-metric-grid"><div><span>Active companies</span><strong>{companies.filter((c) => c.status === "Active").length}</strong><small>Customers, partners, and internal</small></div><div><span>Customer companies</span><strong>{companies.filter((c) => c.type === "Customer").length}</strong><small>Governed data boundaries</small></div><div><span>Multi-company users</span><strong>{users.filter((u) => u.memberships.length > 1).length}</strong><small>Explicit memberships only</small></div></section>
    <div className="management-toolbar"><div className="search-input"><Icon name="search" size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search companies" /></div><span>{visible.length} companies</span></div>
    <div className="management-table company-table"><div className="management-head"><span>Company</span><span>Type</span><span>Users</span><span>Authentication</span><span>Status</span><span /></div>{visible.map((company) => {
      const memberCount = users.filter((user) => user.memberships.some((membership) => membership.companyId === company.id)).length;
      return <div className="management-row" key={company.id}><span className="record-name"><span className="company-avatar">{company.name.slice(0,2).toUpperCase()}</span><span><strong>{company.name}</strong><code>{company.id} · {company.domain}</code></span></span><span>{company.type}</span><span><strong>{memberCount}</strong> members</span><span className="auth-tags">{company.authentication.map((method) => <span key={method}>{method}</span>)}</span><Status tone={company.status === "Active" ? "success" : company.status === "Onboarding" ? "warning" : "neutral"}>{company.status}</Status><Button variant="secondary" onClick={() => setEditing(company)}>Manage</Button></div>;
    })}</div>
    {editing && <CompanyEditor company={editing === "new" ? undefined : editing} nextNumber={companies.length + 1} onClose={() => setEditing(null)} onSave={save} />}
  </div>;
}

function CompanyEditor({ company, nextNumber, onClose, onSave }: { company?: Company; nextNumber: number; onClose: () => void; onSave: (company: Company) => void }) {
  const [name, setName] = useState(company?.name || "");
  const [domain, setDomain] = useState(company?.domain || "");
  const [type, setType] = useState<Company["type"]>(company?.type || "Customer");
  const [status, setStatus] = useState<Company["status"]>(company?.status || "Onboarding");
  const [authentication, setAuthentication] = useState<("OTP" | "Entra ID")[]>(company?.authentication || ["OTP"]);
  function toggle(method: "OTP" | "Entra ID") { setAuthentication((items) => items.includes(method) ? items.filter((item) => item !== method) : [...items, method]); }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !domain.trim() || authentication.length === 0) return;
    onSave({ id: company?.id || `ORG-${String(nextNumber).padStart(3,"0")}`, name: name.trim(), domain: domain.trim().toLowerCase(), type, status, authentication, users: company?.users || 0, requests: company?.requests || 0 });
  }
  return <div className="modal-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="management-modal" role="dialog" aria-modal="true" aria-labelledby="company-editor-title"><header><div><p className="eyebrow">Company record</p><h2 id="company-editor-title">{company ? `Manage ${company.name}` : "Add customer company"}</h2><p>Company membership controls which customer context a user may enter.</p></div><button className="icon-button" onClick={onClose}><Icon name="x" /></button></header><form onSubmit={submit}><div className="form-grid"><label className="form-field"><span>Company name <em>Required</em></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Company name" required /></label><label className="form-field"><span>Verified domain <em>Required</em></span><input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="example.com" required /></label><label className="form-field"><span>Company type</span><select value={type} onChange={(event) => setType(event.target.value as Company["type"])}><option>Customer</option><option>Partner</option><option>Internal</option></select></label><label className="form-field"><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as Company["status"])}><option>Active</option><option>Onboarding</option><option>Inactive</option></select></label></div><fieldset className="auth-choice"><legend>Allowed authentication</legend><label><input type="checkbox" checked={authentication.includes("OTP")} onChange={() => toggle("OTP")} /><span><strong>One-time password</strong><small>Email-delivered OTP with no tenant configuration.</small></span></label><label><input type="checkbox" checked={authentication.includes("Entra ID")} onChange={() => toggle("Entra ID")} /><span><strong>Microsoft Entra ID</strong><small>Enterprise SSO after application configuration and consent.</small></span></label></fieldset><footer><span>At least one authentication method is required.</span><div><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" icon="check" disabled={!name.trim() || !domain.trim() || authentication.length === 0}>Save company</Button></div></footer></form></section></div>;
}

function UsersPage({ users, companies, onChange, onToast }: { users: ManagedUser[]; companies: Company[]; onChange: (users: ManagedUser[]) => void; onToast: (message: string) => void }) {
  const [query, setQuery] = useState("");
  const [companyFilter, setCompanyFilter] = useState("All companies");
  const [editing, setEditing] = useState<ManagedUser | "new" | null>(null);
  const visible = users.filter((user) => `${user.name} ${user.email}`.toLowerCase().includes(query.toLowerCase()) && (companyFilter === "All companies" || user.memberships.some((membership) => membership.companyId === companyFilter)));
  function save(user: ManagedUser) {
    onChange(users.some((item) => item.id === user.id) ? users.map((item) => item.id === user.id ? user : item) : [...users, user]);
    setEditing(null);
    onToast(`${user.name} and ${user.memberships.length} company membership${user.memberships.length === 1 ? "" : "s"} were saved.`);
  }
  return <div className="page-stack management-page">
    <PageIntro eyebrow="Identity and access" title="Manage users and company access" description="A user has one identity and any number of explicit company memberships. Roles are assigned separately inside each company." action={<Button icon="plus" onClick={() => setEditing("new")}>Invite user</Button>} />
    <div className="membership-callout"><Icon name="users" size={20} /><div><strong>Many-to-many access model</strong><span>Internal employees are not global by default. Assign each employee only to the customer companies they support.</span></div></div>
    <div className="management-toolbar"><div className="search-input"><Icon name="search" size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search users" /></div><label className="select-wrap"><Icon name="building" size={15} /><select value={companyFilter} onChange={(event) => setCompanyFilter(event.target.value)}><option>All companies</option>{companies.map((company) => <option value={company.id} key={company.id}>{company.name}</option>)}</select></label><span>{visible.length} users</span></div>
    <div className="management-table user-table"><div className="management-head"><span>User</span><span>Authentication</span><span>Company access</span><span>Status</span><span /></div>{visible.map((user) => <div className="management-row" key={user.id}><span className="record-name"><span className="user-avatar">{user.name.split(" ").map((part) => part[0]).slice(0,2).join("")}</span><span><strong>{user.name}</strong><code>{user.email}</code></span></span><span className="auth-tags"><span>{user.authentication}</span></span><span className="membership-tags">{user.memberships.slice(0,3).map((membership) => <span key={membership.companyId}>{companies.find((company) => company.id === membership.companyId)?.name}<small>{membership.role}</small></span>)}{user.memberships.length > 3 && <span>+{user.memberships.length - 3} more</span>}</span><Status tone={user.status === "Active" ? "success" : user.status === "Invited" ? "warning" : "error"}>{user.status}</Status><Button variant="secondary" onClick={() => setEditing(user)}>Edit access</Button></div>)}</div>
    {editing && <UserEditor user={editing === "new" ? undefined : editing} companies={companies} nextNumber={users.length + 101} onClose={() => setEditing(null)} onSave={save} />}
  </div>;
}

function UserEditor({ user, companies, nextNumber, onClose, onSave }: { user?: ManagedUser; companies: Company[]; nextNumber: number; onClose: () => void; onSave: (user: ManagedUser) => void }) {
  const [name, setName] = useState(user?.name || "");
  const [email, setEmail] = useState(user?.email || "");
  const [status, setStatus] = useState<ManagedUser["status"]>(user?.status || "Invited");
  const [authentication, setAuthentication] = useState<ManagedUser["authentication"]>(user?.authentication || "OTP");
  const [memberships, setMemberships] = useState<UserMembership[]>(user?.memberships || []);
  function toggleCompany(companyId: string) { setMemberships((items) => items.some((item) => item.companyId === companyId) ? items.filter((item) => item.companyId !== companyId) : [...items, { companyId, role: "Requester" }]); }
  function setRole(companyId: string, role: UserMembership["role"]) { setMemberships((items) => items.map((item) => item.companyId === companyId ? { ...item, role } : item)); }
  function submit(event: FormEvent) { event.preventDefault(); if (!name.trim() || !email.trim() || memberships.length === 0) return; onSave({ id: user?.id || `USR-${nextNumber}`, name: name.trim(), email: email.trim().toLowerCase(), status, authentication, memberships }); }
  return <div className="modal-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="management-modal user-editor" role="dialog" aria-modal="true" aria-labelledby="user-editor-title"><header><div><p className="eyebrow">User identity</p><h2 id="user-editor-title">{user ? `Edit ${user.name}` : "Invite user"}</h2><p>Authentication proves identity. Membership determines company access.</p></div><button className="icon-button" onClick={onClose}><Icon name="x" /></button></header><form onSubmit={submit}><div className="form-grid"><label className="form-field"><span>Full name <em>Required</em></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Full name" required /></label><label className="form-field"><span>Email address <em>Required</em></span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" required /></label><label className="form-field"><span>Authentication</span><select value={authentication} onChange={(event) => setAuthentication(event.target.value as ManagedUser["authentication"])}><option>OTP</option><option>Entra ID</option></select></label><label className="form-field"><span>User status</span><select value={status} onChange={(event) => setStatus(event.target.value as ManagedUser["status"])}><option>Active</option><option>Invited</option><option>Suspended</option></select></label></div><fieldset className="membership-editor"><legend>Company memberships <em>Required</em></legend><p>Select every company this user may enter. Assign a role independently for each membership.</p>{companies.filter((company) => company.status !== "Inactive").map((company) => { const membership = memberships.find((item) => item.companyId === company.id); return <div className={membership ? "selected" : ""} key={company.id}><label><input type="checkbox" checked={!!membership} onChange={() => toggleCompany(company.id)} /><span><strong>{company.name}</strong><small>{company.type} · {company.domain}</small></span></label>{membership && <select value={membership.role} onChange={(event) => setRole(company.id, event.target.value as UserMembership["role"])}><option>Company admin</option><option>Requester</option><option>Viewer</option>{company.type === "Internal" && <option>Product manager</option>}</select>}</div>; })}</fieldset><footer><span>{memberships.length} compan{memberships.length === 1 ? "y" : "ies"} selected</span><div><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" icon="check" disabled={!name.trim() || !email.trim() || memberships.length === 0}>{user ? "Save access" : "Send invitation"}</Button></div></footer></form></section></div>;
}

function AuthenticationPage({ companies, onToast }: { companies: Company[]; onToast: (message: string) => void }) {
  const [entraOpen, setEntraOpen] = useState(false);
  const [appId, setAppId] = useState("");
  const [tenantId, setTenantId] = useState("");
  return <div className="page-stack management-page auth-page">
    <PageIntro eyebrow="Identity providers" title="Authentication" description="DataCentral Pulse supports email OTP and Microsoft Entra ID. Authentication identifies the person; company memberships authorize their customer access." />
    <div className="provider-grid"><article className="provider-card active"><header><span className="provider-icon"><Icon name="message" size={21} /></span><Status tone="success">Active</Status></header><h3>One-time password</h3><p>Email-delivered OTP provides low-friction access without requiring a customer tenant application or guest account.</p><dl><div><dt>Identifier</dt><dd>Email address</dd></div><div><dt>Code lifetime</dt><dd>10 minutes</dd></div><div><dt>Company access</dt><dd>Explicit membership</dd></div></dl><Button variant="secondary" onClick={() => onToast("OTP policy is active for eligible companies.")}>Manage OTP policy</Button></article><article className="provider-card"><header><span className="provider-icon"><Icon name="building" size={21} /></span><Status tone="warning">Configuration pending</Status></header><h3>Microsoft Entra ID</h3><p>Enterprise SSO using the DataCentral Pulse application registration. The App ID and Azure Tenant ID can be added later.</p><dl><div><dt>Application ID</dt><dd><code>Not configured</code></dd></div><div><dt>Azure Tenant ID</dt><dd><code>Not configured</code></dd></div><div><dt>Account model</dt><dd>Configured tenant</dd></div></dl><Button onClick={() => setEntraOpen(true)}>Configure Entra ID</Button></article></div>
    <section className="access-model"><div><p className="eyebrow">Sign-in resolution</p><h3>One identity, several company contexts</h3><p>After OTP or Entra ID authentication, the service loads active memberships. Users with one membership enter that company directly. Users with several memberships choose an active company and may switch without signing in again.</p></div><div className="access-flow"><span><Icon name="users" size={18} /><strong>User identity</strong><small>OTP or Entra ID</small></span><Icon name="arrow" size={17} /><span><Icon name="link" size={18} /><strong>Memberships</strong><small>User × company × role</small></span><Icon name="arrow" size={17} /><span><Icon name="building" size={18} /><strong>Active company</strong><small>Scoped requests and data</small></span></div></section>
    <section className="company-auth-panel"><header><div><h3>Company authentication policy</h3><p>Each company may allow one or both configured providers.</p></div></header><div>{companies.filter((company) => company.status !== "Inactive").map((company) => <div key={company.id}><span className="record-name"><span className="company-avatar">{company.name.slice(0,2).toUpperCase()}</span><span><strong>{company.name}</strong><code>{company.domain}</code></span></span><span className="auth-tags">{company.authentication.map((method) => <span key={method}>{method}</span>)}</span><button className="text-link" onClick={() => onToast(`Authentication policy opened for ${company.name}.`)}>Manage <Icon name="arrow" size={13} /></button></div>)}</div></section>
    {entraOpen && <div className="modal-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) setEntraOpen(false); }}><section className="management-modal" role="dialog" aria-modal="true" aria-labelledby="entra-title"><header><div><p className="eyebrow">Enterprise identity</p><h2 id="entra-title">Configure Microsoft Entra ID</h2><p>These values will be stored securely when the production identity layer is connected.</p></div><button className="icon-button" onClick={() => setEntraOpen(false)}><Icon name="x" /></button></header><form onSubmit={(event) => { event.preventDefault(); setEntraOpen(false); onToast("Entra ID configuration was saved in this prototype."); }}><label className="form-field"><span>Application (client) ID <em>Required</em></span><input value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="00000000-0000-0000-0000-000000000000" required /></label><label className="form-field"><span>Azure Tenant ID <em>Required</em></span><input value={tenantId} onChange={(event) => setTenantId(event.target.value)} placeholder="00000000-0000-0000-0000-000000000000" required /></label><div className="security-note"><Icon name="eye" size={17} /><span><strong>No client secret is required in this prototype.</strong><small>Production configuration must use a secure secret or certificate flow where required.</small></span></div><footer><span>Configuration is not activated until validated.</span><div><Button variant="secondary" onClick={() => setEntraOpen(false)}>Cancel</Button><Button type="submit" icon="check" disabled={!appId.trim() || !tenantId.trim()}>Save configuration</Button></div></footer></form></section></div>}
  </div>;
}

function NotificationsPopover({ onOpenUpdates }: { onOpenUpdates: () => void }) {
  return <div className="notification-popover"><header><strong>Updates</strong><button onClick={onOpenUpdates}>View all</button></header><button><span className="mini-icon violet"><Icon name="spark" size={14} /></span><span><strong>Display scheduler is in progress</strong><small>12 minutes ago</small></span></button><button><span className="mini-icon warning"><Icon name="message" size={14} /></span><span><strong>More context requested</strong><small>Custom export branding · 2 hours ago</small></span></button><button><span className="mini-icon success"><Icon name="check" size={14} /></span><span><strong>Mobile improvements released</strong><small>6 days ago</small></span></button></div>;
}

export default function Home() {
  return <AppShell />;
}
