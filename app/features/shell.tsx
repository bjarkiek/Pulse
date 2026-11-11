"use client";
import { useDialogAccessibility } from "./use-dialog-accessibility";
import dynamic from "next/dynamic";

import { useEffect, useMemo, useState } from "react";

import { apiFetch, errorMessage, isFailureMessage } from "@/lib/api-client";

import { clearDeviceDrafts } from "@/lib/draft-storage";

import { makeT, type UiLocale } from "@/lib/i18n";

import Image from "next/image";

import { ChatPanel } from "../chat-panel";

import { TourHost } from "../tour-host";

import {
  mutationHeaders,
  isUntriaged,
  DraftOwnerContext,
  LocaleContext,
  UserContext,
  type Page,
  type Idea,
  type InternalIdea,
  type ReleaseItem,
  type AuditItem,
  type NotificationItem,
  type RequestItem,
  type OrganizationContext,
  type Company,
  type ManagedUser,
  type IconName,
  Icon,
  Button,
  SkeletonRows,
} from "./shared";

import {
  HomePage,
  IdeasPage,
  RoadmapPage,
  RequestsPage,
  UpdatesPage,
} from "./customer";

const TriagePage = dynamic(() => import("./triage").then((m) => m.TriagePage), {
  loading: () => <LoadingFeature />,
});

import { RequestComposer } from "./composer";

import { RequestDrawer, IdeaDrawer } from "./details";

const CompaniesPage = dynamic(
  () => import("./companies").then((m) => m.CompaniesPage),
  { loading: () => <LoadingFeature /> },
);

const UsersPage = dynamic(() => import("./users").then((m) => m.UsersPage), {
  loading: () => <LoadingFeature />,
});

const AuthenticationPage = dynamic(
  () => import("./authentication").then((m) => m.AuthenticationPage),
  { loading: () => <LoadingFeature /> },
);

const InternalIdeasPage = dynamic(
  () => import("./ideas").then((m) => m.InternalIdeasPage),
  { loading: () => <LoadingFeature /> },
);

const ReleasesPage = dynamic(
  () => import("./releases").then((m) => m.ReleasesPage),
  { loading: () => <LoadingFeature /> },
);

const CommunicationsPage = dynamic(
  () => import("./communications").then((m) => m.CommunicationsPage),
  { loading: () => <LoadingFeature /> },
);

const AuditPage = dynamic(() => import("./audit").then((m) => m.AuditPage), {
  loading: () => <LoadingFeature />,
});

const AnalyticsPage = dynamic(
  () => import("./analytics").then((m) => m.AnalyticsPage),
  { loading: () => <LoadingFeature /> },
);

const SettingsPage = dynamic(
  () => import("./settings").then((m) => m.SettingsPage),
  { loading: () => <LoadingFeature /> },
);

import { NotificationsPopover } from "./notifications";

type NavItem = { id: Page; label: string; icon: IconName; tour?: string };

export const navItems: NavItem[] = [
  { id: "home", label: "Home", icon: "home" },
  { id: "ideas", label: "Browse ideas", icon: "spark" },
  { id: "roadmap", label: "Roadmap", icon: "map" },
  { id: "requests", label: "My requests", icon: "inbox" },
  { id: "updates", label: "Updates", icon: "bell" },
  { id: "help", label: "Help", icon: "help", tour: "nav-help" },
];

/** The pages of the DataCentral team: any of the three internal roles may open them. */
const teamNavItems: NavItem[] = [
  { id: "triage", label: "Triage inbox", icon: "layers", tour: "nav-triage" },
  {
    id: "productIdeas",
    label: "Product ideas",
    icon: "spark",
    tour: "nav-product-ideas",
  },
  { id: "releases", label: "Releases", icon: "check", tour: "nav-releases" },
  {
    id: "communications",
    label: "Communications",
    icon: "send",
    tour: "nav-communications",
  },
  { id: "analytics", label: "Analytics", icon: "chart", tour: "nav-analytics" },
];

/** The pages the server gives to a System admin only. */
const adminNavItems: NavItem[] = [
  { id: "companies", label: "Companies", icon: "building" },
  { id: "users", label: "Users", icon: "users" },
  { id: "authentication", label: "Authentication", icon: "shield" },
  { id: "settings", label: "Settings", icon: "settings", tour: "nav-settings" },
  { id: "audit", label: "Audit log", icon: "clock" },
];

const TEAM_ROLES = ["Internal contributor", "Product manager", "System admin"];

/**
 * Which groups of pages the sidebar offers. This only decides what is shown: the server authorizes every request on its own.
 * The server grants the team pages to a membership in an Internal company, so that is what is read here. The local preview signs in
 * a System admin of a Customer company, so the two roles that only the team can hold count on any membership too: showing a page
 * the server then refuses is harmless, hiding one a person may use is not.
 */
export function navAccess(organizations: OrganizationContext[]) {
  const roles = organizations
    .filter(
      (o) =>
        (o.type === "Internal" && TEAM_ROLES.includes(o.role)) ||
        o.role === "System admin" ||
        o.role === "Internal contributor",
    )
    .map((o) => o.role);
  return {
    team: roles.length > 0,
    admin: roles.includes("System admin"),
    // The roles the server lets record a triage decision; an Internal contributor reviews and adds notes.
    decide: roles.some((r) => r === "Product manager" || r === "System admin"),
  };
}

export const pageTitles: Record<Page, string> = {
  home: "Home",
  ideas: "Browse ideas",
  roadmap: "Roadmap",
  requests: "My requests",
  updates: "Updates",
  triage: "Triage inbox",
  productIdeas: "Product ideas",
  releases: "Releases",
  communications: "Communications",
  audit: "Audit log",
  analytics: "Analytics",
  companies: "Companies",
  users: "Users",
  authentication: "Authentication",
  settings: "Settings",
  help: "Help",
};

export function AppShell() {
  useDialogAccessibility();
  const [page, setPage] = useState<Page>("home");
  const [menuOpen, setMenuOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [detailRequest, setDetailRequest] = useState<RequestItem | null>(null);
  const [detailIdea, setDetailIdea] = useState<Idea | null>(null);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [internalIdeas, setInternalIdeas] = useState<InternalIdea[]>([]);
  const [releases, setReleases] = useState<ReleaseItem[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [managedUsers, setManagedUsers] = useState<ManagedUser[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [organizationMenuOpen, setOrganizationMenuOpen] = useState(false);
  const [identityReady, setIdentityReady] = useState(false);
  // Whether the first answer for each list has come (a failure counts: the list is then empty for a reason the toast gives).
  // They stay set through later refetches, so a list never flickers back to placeholders, and are cleared on a company switch.
  const [requestsLoaded, setRequestsLoaded] = useState(false);
  const [ideasLoaded, setIdeasLoaded] = useState(false);
  const [requestsFailed, setRequestsFailed] = useState(false);
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
  // Active UI language. Seeded from the profile (which the DataCentral launch
  // language also syncs into); the topbar toggle switches it live and persists
  // the choice back to the profile.
  const [locale, setLocale] = useState<UiLocale>("en");
  const t = useMemo(() => makeT(locale), [locale]);
  async function switchLocale(next: UiLocale) {
    setLocale(next);
    await fetch("/api/v1/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale: next }),
    }).catch(() => undefined);
  }

  useEffect(() => {
    const logout = (event: MouseEvent) => {
      if ((event.target as Element)?.closest('a[href*="/auth/logout"]'))
        clearDeviceDrafts();
    };
    document.addEventListener("click", logout);
    return () => document.removeEventListener("click", logout);
  }, []);

  function openRequest(item: RequestItem) {
    setDetailRequest(item);
    const url = new URL(window.location.href);
    url.searchParams.set("request", item.id);
    window.history.pushState({}, "", url);
  }

  function closeRequest() {
    setDetailRequest(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("request");
    window.history.pushState({}, "", url);
  }

  useEffect(() => {
    fetch("/api/v1/me")
      .then(async (response) => {
        if (response.status === 401) {
          // Session missing/expired. Top-level: send the browser through the
          // login flow. Framed inside DataCentral: a top-level redirect would
          // break the iframe, and the proxy now serves embed shells anonymously
          // (no /dc-embed bounce), so navigate to the handshake ourselves —
          // clearing any stale bearer token first so the retry starts clean.
          if (window.self === window.top) {
            // A full navigation resets the expired auth session and embed bootstrap.
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination
            window.location.assign(
              "/auth/login?returnUrl=" +
                encodeURIComponent(
                  window.location.pathname + window.location.search,
                ),
            );
          } else {
            try {
              sessionStorage.removeItem("pulse-embed-token");
            } catch {
              /* storage blocked */
            }
            window.location.replace(
              "/dc-embed?returnUrl=" +
                encodeURIComponent(
                  window.location.pathname + window.location.search,
                ),
            );
          }
          return null;
        }
        if (!response.ok) throw new Error("identity failed");
        return response.json();
      })
      .then(async (context) => {
        if (!context) return;
        setOrganizationContexts(
          (context.organizations || []).map((o: OrganizationContext) => ({
            ...o,
            active: o.id === context.activeOrganizationId,
          })),
        );
        setDcEmbed(Boolean(context.dcEmbed));
        setMeUser(context.user ?? null);
        setLocale(context.user?.locale === "is" ? "is" : "en");
        const requested =
          dataVersion === 0
            ? new URLSearchParams(window.location.search).get("organization")
            : null;
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
          if (selected.ok)
            setOrganizationContexts((items) =>
              items.map((o) => ({ ...o, active: o.id === requested })),
            );
          setIdentityReady(selected.ok);
          return;
        }
        setIdentityReady(Boolean(context.activeOrganizationId));
      })
      .catch(() =>
        setToast("Pulse could not resolve your organization access."),
      );
  }, [dataVersion]);

  useEffect(() => {
    if (!identityReady) return;
    const controller = new AbortController();
    fetch("/api/v1/requests", { signal: controller.signal })
      .then((response) =>
        response.ok
          ? response.json()
          : Promise.reject(new Error("load failed")),
      )
      .then((data) => {
        setRequests(data.items);
        setRequestsFailed(false);
        setRequestsLoaded(true);
      })
      .catch((error) => {
        if (error.name === "AbortError") return;
        setRequestsFailed(true);
        setRequestsLoaded(true);
        setToast("Unable to load requests. Please retry.");
      });
    return () => controller.abort();
  }, [identityReady, dataVersion]);

  useEffect(() => {
    const sync = () => {
      const params = new URLSearchParams(window.location.search);
      const next = params.get("page") || "home";
      if (Object.hasOwn(pageTitles, next)) setPage(next as Page);
      setDetailRequest(
        requests.find((item) => item.id === params.get("request")) || null,
      );
      setDetailIdea(
        ideas.find((item) => item.id === params.get("idea")) || null,
      );
    };
    const timer = window.setTimeout(sync, 0);
    window.addEventListener("popstate", sync);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("popstate", sync);
    };
  }, [requests, ideas]);

  function openIdea(item: Idea) {
    setDetailIdea(item);
    const url = new URL(window.location.href);
    url.searchParams.set("idea", item.id);
    window.history.pushState({}, "", url);
  }
  function closeIdea() {
    setDetailIdea(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("idea");
    window.history.pushState({}, "", url);
  }

  const access = useMemo(
    () => navAccess(organizationContexts),
    [organizationContexts],
  );

  // The team and admin lists are only asked for by the people the server answers.
  useEffect(() => {
    if (!identityReady || !access.team) return;
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
  }, [identityReady, dataVersion, access.team]);

  useEffect(() => {
    if (!identityReady || !access.admin) return;
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
  }, [identityReady, dataVersion, access.admin]);

  useEffect(() => {
    if (!identityReady) return;
    const controller = new AbortController();
    fetch("/api/v1/ideas", { signal: controller.signal })
      .then((response) =>
        response.ok
          ? response.json()
          : Promise.reject(new Error("load failed")),
      )
      .then((data) => {
        setIdeas(data.items);
        setIdeasLoaded(true);
      })
      .catch((error) => {
        if (error.name !== "AbortError") setIdeasLoaded(true);
      });
    return () => controller.abort();
  }, [identityReady, dataVersion]);

  // A failure is read, not glanced at: it stays longer and can be dismissed.
  const toastFailed = toast ? isFailureMessage(toast) : false;
  useEffect(() => {
    if (toast) {
      const timer = window.setTimeout(
        () => setToast(null),
        toastFailed ? 8000 : 3200,
      );
      return () => window.clearTimeout(timer);
    }
  }, [toast, toastFailed]);

  useEffect(() => {
    if (!organizationMenuOpen) return;
    const outside = (event: MouseEvent) => {
      if (!(event.target as Element)?.closest(".organization-switcher"))
        setOrganizationMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOrganizationMenuOpen(false);
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [organizationMenuOpen]);

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
    const url = new URL(window.location.href);
    url.searchParams.set("page", next);
    url.searchParams.delete("request");
    url.searchParams.delete("idea");
    window.history.pushState({}, "", url);
    setDetailRequest(null);
    setDetailIdea(null);
    setPage(next);
    setMenuOpen(false);
    setNotificationsOpen(false);
    setOrganizationMenuOpen(false);
  }

  function addRequest(request: RequestItem) {
    const next = [request, ...requests];
    setRequests(next);
    setComposerOpen(false);
    navigate("requests");
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
    setOrganizationContexts((items) =>
      items.map((o) => ({ ...o, active: o.id === organizationId })),
    );
    setComposerOpen(false);
    setDetailRequest(null);
    setDetailIdea(null);
    setRequests([]);
    setIdeas([]);
    setRequestsLoaded(false);
    setIdeasLoaded(false);
    setNotifications([]);
    setDataVersion((v) => v + 1);
    const url = new URL(window.location.href);
    url.searchParams.set("organization", organizationId);
    url.searchParams.delete("request");
    url.searchParams.delete("idea");
    window.history.replaceState({}, "", url);
    setIdentityReady(true);
  }

  /** Releases, "Draft customer email": makes a product update from the release and opens it in the editor of the Communications page. */
  async function draftEmailFromRelease(release: ReleaseItem) {
    try {
      const data = await apiFetch<{ item: { id: string } }>(
        "/api/v1/internal/communications",
        {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify({ fromReleaseId: release.id }),
        },
      );
      // The Communications page opens the draft named in the address when it is drawn, and forgets the name once it has.
      const url = new URL(window.location.href);
      url.searchParams.set("page", "communications");
      url.searchParams.set("communication", data.item.id);
      window.history.pushState({}, "", url);
      setPage("communications");
    } catch (error) {
      setToast(errorMessage(error));
    }
  }

  const draftScope =
    identityReady && meUser?.id
      ? `${meUser.id}:${organizationContexts.find((o) => o.active)?.id || ""}`
      : null;
  // The role in the company the person is signed in to: it decides what the Updates page offers.
  const activeOrganization = organizationContexts.find((o) => o.active);
  const activeRole = activeOrganization?.role ?? "";
  const unreadCount = notifications.filter((n) => !n.readAt).length;
  const untriagedCount = requests.filter(isUntriaged).length;
  // An address naming a page this person is not offered (an old bookmark, a shared link) lands on Home, not on an empty page.
  const pageAllowed =
    (!teamNavItems.some((item) => item.id === page) || access.team) &&
    (!adminNavItems.some((item) => item.id === page) || access.admin);
  const shownPage: Page = pageAllowed ? page : "home";
  const navButton = (item: NavItem, count = 0) => (
    <button
      key={item.id}
      className={`nav-item ${shownPage === item.id ? "active" : ""}`}
      aria-current={shownPage === item.id ? "page" : undefined}
      onClick={() => navigate(item.id)}
      data-tour={item.tour}
    >
      <Icon name={item.icon} size={17} />
      <span>{t(item.label)}</span>
      {count > 0 && <span className="nav-count">{count}</span>}
    </button>
  );

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
            <p className="eyebrow">{t("DataCentral Pulse")}</p>
            <h1>{t("Choose an organization")}</h1>
            <p>
              {t(
                "Your role and access are evaluated separately in each context.",
              )}
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
          <p>{t("Resolving your authorized organization…")}</p>
        )}
      </main>
    );

  return (
    <LocaleContext.Provider value={t}>
      <DraftOwnerContext.Provider value={draftScope}>
        <UserContext.Provider
          value={{
            name: meUser?.name || "",
            organization:
              organizationContexts.find((o) => o.active)?.name || "",
          }}
        >
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
                <span>{t("Pulse")}</span>
              </div>
              <nav
                className="nav"
                aria-label="Primary navigation"
                data-tour="nav"
              >
                {navItems.map((item) =>
                  navButton(item, item.id === "updates" ? unreadCount : 0),
                )}
                {access.team && (
                  <>
                    <div className="nav-section-label">
                      {t("DataCentral team")}
                    </div>
                    {teamNavItems.map((item) =>
                      navButton(
                        item,
                        item.id === "triage" ? untriagedCount : 0,
                      ),
                    )}
                  </>
                )}
                {access.admin && (
                  <>
                    <div className="nav-section-label">
                      {t("Administration")}
                    </div>
                    {adminNavItems.map((item) => navButton(item))}
                  </>
                )}
              </nav>
              {!dcEmbed && (
                <div className="sidebar-profile">
                  <div className="avatar">
                    {meUser?.name
                      .split(" ")
                      .map((n) => n[0])
                      .slice(0, 2)
                      .join("")}
                  </div>
                  <div className="profile-copy">
                    <strong>{meUser?.name}</strong>
                    <a
                      href="/auth/logout"
                      onClick={() => {
                        clearDeviceDrafts();
                        try {
                          sessionStorage.removeItem("pulse-embed-token");
                        } catch {}
                      }}
                    >
                      {t("Sign out")}
                    </a>
                    <span>
                      {activeOrganization?.name} · {t(activeRole)}
                    </span>
                    <span
                      className="build-version"
                      title={`Built ${process.env.NEXT_PUBLIC_BUILD_TIME ?? ""}`}
                    >
                      v{process.env.NEXT_PUBLIC_APP_VERSION} ·{" "}
                      {process.env.NEXT_PUBLIC_BUILD_COMMIT}
                    </span>
                  </div>
                </div>
              )}
            </aside>

            {menuOpen && (
              <button
                className="sidebar-backdrop"
                aria-label={t("Close navigation")}
                onClick={() => setMenuOpen(false)}
              />
            )}

            <div className="main-shell">
              <header className="topbar">
                <div className="topbar-left">
                  <button
                    className="icon-button mobile-menu"
                    aria-label={t("Open navigation")}
                    onClick={() => setMenuOpen(true)}
                  >
                    <Icon name="menu" />
                  </button>
                  <h1>{t(pageTitles[shownPage])}</h1>
                </div>
                <div className="topbar-actions">
                  <button
                    className="workspace-switcher locale-toggle"
                    onClick={() => switchLocale(locale === "is" ? "en" : "is")}
                    title={
                      locale === "is"
                        ? "Switch to English"
                        : "Skipta yfir í íslensku"
                    }
                    aria-label={
                      locale === "is"
                        ? "Switch to English"
                        : "Skipta yfir í íslensku"
                    }
                  >
                    {locale === "is" ? "EN" : "IS"}
                  </button>
                  {!dcEmbed &&
                    (organizationContexts.length > 1 ? (
                      <div className="organization-switcher">
                        <button
                          className="workspace-switcher"
                          aria-haspopup="menu"
                          aria-expanded={organizationMenuOpen}
                          aria-label={`${t("Switch organization")}: ${activeOrganization?.name ?? ""}`}
                          onClick={() => {
                            setNotificationsOpen(false);
                            setOrganizationMenuOpen(!organizationMenuOpen);
                          }}
                        >
                          <Icon name="building" size={15} />
                          <span>{activeOrganization?.name}</span>
                          <Icon name="chevron" size={13} />
                        </button>
                        {organizationMenuOpen && (
                          <div className="organization-menu" role="menu">
                            {organizationContexts.map((organization) => (
                              <button
                                key={organization.id}
                                role="menuitemradio"
                                aria-checked={Boolean(organization.active)}
                                onClick={() => {
                                  setOrganizationMenuOpen(false);
                                  if (!organization.active)
                                    void chooseOrganization(organization.id);
                                }}
                              >
                                <span>
                                  <strong>{organization.name}</strong>
                                  <small>{t(organization.role)}</small>
                                </span>
                                {organization.active && (
                                  <Icon name="check" size={15} />
                                )}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      // One company: nothing to switch to, so it is a label and not a button.
                      <span className="workspace-switcher workspace-label">
                        <Icon name="building" size={15} />
                        <span>{activeOrganization?.name}</span>
                      </span>
                    ))}
                  <button
                    className="icon-button notification-button"
                    aria-label={
                      unreadCount > 0
                        ? `${t("Notifications")} (${unreadCount})`
                        : t("Notifications")
                    }
                    aria-expanded={notificationsOpen}
                    data-tour="notifications"
                    onClick={() => {
                      setOrganizationMenuOpen(false);
                      setNotificationsOpen(!notificationsOpen);
                    }}
                  >
                    <Icon name="bell" />
                    {unreadCount > 0 && <span />}
                  </button>
                  <Button
                    icon="plus"
                    dataTour="submit-request"
                    onClick={() => setComposerOpen(true)}
                    ariaLabel={t("Submit a request")}
                  >
                    <span>{t("Submit a request")}</span>
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
                {shownPage === "home" && (
                  <HomePage
                    requests={requests}
                    ideas={ideas}
                    onSubmit={() => setComposerOpen(true)}
                    onOpenRequest={openRequest}
                    onOpenIdea={openIdea}
                    onNavigate={navigate}
                    dcEmbed={dcEmbed}
                    loading={!requestsLoaded}
                    ideasLoading={!ideasLoaded}
                  />
                )}
                {shownPage === "ideas" && (
                  <IdeasPage
                    ideas={ideas}
                    loading={!ideasLoaded}
                    onOpen={openIdea}
                    onFollow={followIdea}
                    onSubmit={() => setComposerOpen(true)}
                  />
                )}
                {shownPage === "roadmap" && (
                  <RoadmapPage ideas={ideas} onOpen={openIdea} />
                )}
                {shownPage === "requests" && (
                  <RequestsPage
                    requests={requests}
                    loading={!requestsLoaded}
                    failed={requestsFailed}
                    onRetry={() => {
                      setRequestsLoaded(false);
                      setDataVersion((v) => v + 1);
                    }}
                    onOpen={openRequest}
                    onSubmit={() => setComposerOpen(true)}
                  />
                )}
                {shownPage === "updates" && (
                  <UpdatesPage
                    ideas={ideas}
                    notifications={notifications}
                    onOpen={openIdea}
                    activeRole={activeRole}
                    onToast={setToast}
                  />
                )}
                {shownPage === "help" && (
                  // The server-rendered manual (audience-gated, with tour screenshots)
                  // shown in the content area; same-origin so CSP frame-src 'self' allows it.
                  <iframe
                    src={locale === "is" ? "/help?lang=is" : "/help"}
                    title="Pulse help"
                    className="help-frame"
                    data-tour="help-frame"
                  />
                )}
                {shownPage === "triage" && (
                  <TriagePage
                    requests={requests}
                    ideas={internalIdeas}
                    canDecide={access.decide}
                    loading={!requestsLoaded}
                    setRequests={setRequests}
                    onToast={setToast}
                  />
                )}
                {shownPage === "productIdeas" && (
                  <InternalIdeasPage
                    ideas={internalIdeas}
                    requests={requests}
                    users={managedUsers}
                    onChange={setInternalIdeas}
                    onToast={setToast}
                  />
                )}
                {shownPage === "releases" && (
                  <ReleasesPage
                    releases={releases}
                    ideas={internalIdeas}
                    onChange={setReleases}
                    onIdeasChange={setInternalIdeas}
                    onToast={setToast}
                    onDraftEmail={draftEmailFromRelease}
                  />
                )}
                {shownPage === "communications" && (
                  <CommunicationsPage
                    companies={companies}
                    releases={releases}
                    activeRole={activeRole}
                    onToast={setToast}
                  />
                )}
                {shownPage === "audit" && <AuditPage items={audit} />}
                {shownPage === "analytics" && (
                  <AnalyticsPage
                    requests={requests}
                    ideas={ideas}
                    onToast={setToast}
                  />
                )}
                {shownPage === "companies" && (
                  <CompaniesPage
                    companies={companies}
                    users={managedUsers}
                    onChange={setCompanies}
                    onToast={setToast}
                  />
                )}
                {shownPage === "users" && (
                  <UsersPage
                    users={managedUsers}
                    companies={companies}
                    onChange={setManagedUsers}
                    onToast={setToast}
                  />
                )}
                {shownPage === "authentication" && (
                  <AuthenticationPage
                    companies={companies}
                    onChange={setCompanies}
                    onToast={setToast}
                  />
                )}
                {shownPage === "settings" && <SettingsPage onToast={setToast} />}
              </main>
            </div>

            {composerOpen && (
              <RequestComposer
                key={draftScope}
                onClose={() => setComposerOpen(false)}
                onSubmit={addRequest}
                onFollow={followIdea}
              />
            )}
            {detailRequest && (
              <RequestDrawer
                key={detailRequest.id}
                request={detailRequest}
                idea={ideas.find(
                  (idea) => idea.id === detailRequest.linkedIdea,
                )}
                onClose={closeRequest}
                onToast={setToast}
                onChange={(updated) => {
                  setRequests((items) =>
                    items.map((item) =>
                      item.id === updated.id ? updated : item,
                    ),
                  );
                  setDetailRequest(updated);
                }}
              />
            )}
            {detailIdea && (
              <IdeaDrawer
                key={detailIdea.id}
                idea={
                  ideas.find((idea) => idea.id === detailIdea.id) || detailIdea
                }
                onClose={closeIdea}
                onFollow={followIdea}
              />
            )}
            {toast && (
              <div
                className={`toast ${toastFailed ? "toast-error" : ""}`}
                role={toastFailed ? "alert" : "status"}
              >
                <span className="toast-icon">
                  <Icon name={toastFailed ? "x" : "check"} size={15} />
                </span>
                <span>{t(toast)}</span>
                {toastFailed && (
                  <button
                    aria-label={t("Dismiss")}
                    onClick={() => setToast(null)}
                  >
                    <Icon name="x" size={14} />
                  </button>
                )}
              </div>
            )}
            <ChatPanel
              locale={locale}
              onDataChanged={() => setDataVersion((v) => v + 1)}
            />
            <TourHost
              ready={identityReady}
              view={shownPage}
              locale={locale}
              onNavigate={(next) => {
                // "compose" is a tour pseudo-view: the submit-request tour's later
                // steps anchor inside the composer modal, so resuming them must
                // reopen it (idempotent when it is already open)
                if (next === "compose") {
                  navigate("home");
                  setComposerOpen(true);
                  return;
                }
                navigate(next as Page);
              }}
            />
          </div>
        </UserContext.Provider>
      </DraftOwnerContext.Provider>
    </LocaleContext.Provider>
  );
}

function LoadingFeature() {
  return <SkeletonRows count={5} />;
}
