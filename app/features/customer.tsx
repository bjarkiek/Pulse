"use client";

import dynamic from "next/dynamic";

import { useContext, useEffect, useState } from "react";

import {
  UserContext,
  useT,
  mutationHeaders,
  type Page,
  type Tone,
  type Idea,
  type NotificationItem,
  type NotificationPreferenceItem,
  type RequestItem,
  Icon,
  Status,
  Button,
  PageIntro,
  EmptyState,
} from "./shared";

// Only a Company admin has this section, and it brings the contact dialogs with it: it is loaded when it is first drawn.
const CompanyContactsSection = dynamic(() =>
  import("./company-contacts").then((m) => m.CompanyContactsSection),
);

export function HomePage({
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
  const t = useT();
  const user = useContext(UserContext);
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
          <p className="eyebrow">{t("Customer feedback")}</p>
          {!dcEmbed && (
            <h2>
              {t("Welcome")}
              {user.name ? `, ${user.name}` : ""}
            </h2>
          )}
          <p>
            {t(
              "Track your requests and help shape what DataCentral builds next.",
            )}
          </p>
        </div>
        <div className="home-meta">
          <strong>{t("Your product workspace")}</strong>
        </div>
      </section>

      <section className="ask-card" data-tour="ask-card">
        <div className="ask-copy">
          <div className="ask-icon">
            <Icon name="spark" size={22} />
          </div>
          <div>
            <h3>
              {t("What would make DataCentral work better for your team?")}
            </h3>
            <p>{t("Search existing ideas or describe a new requirement.")}</p>
          </div>
        </div>
        <div className="ask-search-row">
          <div className="search-input large">
            <Icon name="search" size={18} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("Search ideas and requests")}
              aria-label={t("Search ideas and requests")}
            />
          </div>
          <Button icon="plus" onClick={onSubmit}>
            {t("Submit a request")}
          </Button>
        </div>
        {matches.length > 0 && (
          <div className="quick-results">
            <span>{t("Related ideas")}</span>
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

      <section className="metric-grid" data-tour="metrics">
        <button className="metric-card" onClick={() => onNavigate("requests")}>
          <div className="metric-icon">
            <Icon name="inbox" />
          </div>
          <div>
            <span>{t("Active requests")}</span>
            <strong>
              {
                requests.filter(
                  (r) => !["Released", "Closed"].includes(r.status),
                ).length
              }
            </strong>
            <small>{t("Across your organization")}</small>
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
            <span>{t("Needs your input")}</span>
            <strong>
              {requests.filter((r) => r.status === "Needs information").length}
            </strong>
            <small>{t("Response requested")}</small>
          </div>
          <Icon name="chevron" size={16} />
        </button>
        <button className="metric-card" onClick={() => onNavigate("updates")}>
          <div className="metric-icon">
            <Icon name="check" />
          </div>
          <div>
            <span>{t("Recently released")}</span>
            <strong>
              {ideas.filter((i) => i.status === "Released").length}
            </strong>
            <small>{t("In the last 30 days")}</small>
          </div>
          <Icon name="chevron" size={16} />
        </button>
      </section>

      <section className="home-grid">
        <div className="panel" data-tour="your-requests">
          <div className="panel-header">
            <div>
              <h3>{t("Your requests")}</h3>
              <p>
                {t("Latest activity from")} {user.organization}
              </p>
            </div>
            <button
              className="text-link"
              onClick={() => onNavigate("requests")}
            >
              {t("View all")} <Icon name="arrow" size={14} />
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
                    <code>{request.id}</code> · {request.area} {t("· Updated")}{" "}
                    {request.submitted}
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
            <p className="eyebrow">{t("Recently shipped")}</p>
          </div>
          {ideas
            .filter((i) => i.status === "Released")
            .slice(0, 1)
            .map((idea) => (
              <div key={idea.id}>
                <h3>{idea.title}</h3>
                <p>{idea.description}</p>
                <button className="text-link" onClick={() => onOpenIdea(idea)}>
                  {t("View release notes")}
                </button>
              </div>
            ))}
          {!ideas.some((i) => i.status === "Released") && (
            <p>{t("No releases published yet.")}</p>
          )}
        </div>
      </section>
    </div>
  );
}

export function IdeasPage({
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
  const t = useT();
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
            {t("Submit a request")}
          </Button>
        }
      />
      <div className="toolbar">
        <div className="search-input">
          <Icon name="search" size={17} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Search ideas")}
          />
        </div>
        <label className="select-wrap">
          <Icon name="filter" size={16} />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="All statuses">{t("All statuses")}</option>
            <option value="Under review">{t("Under review")}</option>
            <option value="Considering">{t("Considering")}</option>
            <option value="Planned">{t("Planned")}</option>
            <option value="In progress">{t("In progress")}</option>
            <option value="Released">{t("Released")}</option>
          </select>
        </label>
        <span className="result-count">
          {filtered.length} {t("ideas")}
        </span>
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
                <span>
                  {idea.organizations} {t("organizations")}
                </span>
              </div>
              <button
                className={idea.followed ? "following" : ""}
                onClick={() => onFollow(idea.id)}
              >
                <Icon name={idea.followed ? "check" : "bell"} size={14} />
                {t(idea.followed ? "Following" : "Follow")}
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

export function RoadmapPage({
  ideas,
  onOpen,
}: {
  ideas: Idea[];
  onOpen: (idea: Idea) => void;
}) {
  const t = useT();
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
          <strong>{t("Built from governed customer evidence")}</strong>
          <span>
            {t(
              "Roadmap items combine related requests while keeping each customer’s context private.",
            )}
          </span>
        </div>
      </div>
      <div className="roadmap-board">
        {columns.map((column) => (
          <section className="roadmap-column" key={column.title}>
            <header>
              <div>
                <h3>{t(column.title)}</h3>
                <p>{t(column.note)}</p>
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
          <p className="eyebrow">{t("Released")}</p>
          <h3>{t("Recently delivered")}</h3>
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

export function RequestsPage({
  requests,
  onOpen,
  onSubmit,
}: {
  requests: RequestItem[];
  onOpen: (request: RequestItem) => void;
  onSubmit: () => void;
}) {
  const t = useT();
  const user = useContext(UserContext);
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
        title={t("Requests") + " · " + user.organization}
        description="Every request keeps its original context, status history, and link to the corresponding product idea."
        action={
          <Button icon="plus" onClick={onSubmit}>
            {t("Submit a request")}
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
            {t(tab)}
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
            placeholder={t("Search request number, title, or problem")}
            aria-label={t("Search requests")}
          />
        </label>
        <label className="select-control">
          <Icon name="filter" size={15} />
          <select
            value={area}
            onChange={(event) => setArea(event.target.value)}
            aria-label={t("Filter by product area")}
          >
            {areas.map((value) => (
              <option key={value} value={value}>
                {t(value)}
              </option>
            ))}
          </select>
        </label>
        <span className="result-count">
          {visible.length} {t("requests")}
        </span>
      </div>
      <div className="table-panel">
        <div className="table-head">
          <span>{t("Request")}</span>
          <span>{t("Product area")}</span>
          <span>{t("Submitted")}</span>
          <span>{t("Status")}</span>
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

/** What each communication topic is called on the Updates page and what it covers: words for the person, not the event type's name. */
const PREFERENCE_LABELS: Record<string, [string, string]> = {
  "communication.product-updates": [
    "Product updates from DataCentral",
    "Release announcements like new versions and features",
  ],
  "communication.service-notices": [
    "Service notices",
    "Planned maintenance and service changes",
  ],
  "communication.security-advisories": [
    "Security advisories",
    "Always delivered — security information for your company",
  ],
  "communication.general": [
    "General announcements",
    "Occasional news from the DataCentral team",
  ],
};

export function UpdatesPage({
  notifications,
  onOpen,
  activeRole,
  onToast,
}: {
  ideas: Idea[];
  notifications: NotificationItem[];
  onOpen: (idea: Idea) => void;
  /** The person's role in the active company: only a Company admin keeps the company's list of recipients. */
  activeRole: string;
  onToast: (message: string) => void;
}) {
  const t = useT();
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
    try {
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
        items.map((item) => (item.eventType === eventType ? saved : item)),
      );
      setPreferenceStatus("Preferences saved.");
    } catch {
      // The request got no answer at all (offline, the connection dropped): say so, rather than leave "Saving…" on the screen.
      setPreferenceStatus("Could not save this preference.");
    }
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
    idea: undefined as Idea | undefined,
    tone: (notification.eventType.includes("release")
      ? "success"
      : notification.eventType.includes("needs")
        ? "warning"
        : "violet") as Tone,
  }));
  const entries = durableEntries;
  return (
    <div className="page-stack updates-layout">
      <PageIntro
        eyebrow="Product updates"
        title="Changes that matter to your team"
        description="A focused record of decisions, progress, and releases for requests you follow."
      />
      <section
        className="notification-preferences"
        aria-labelledby="notification-preferences-title"
      >
        <header>
          <div>
            <h3 id="notification-preferences-title">
              {t("Notification preferences")}
            </h3>
            <p>
              {t("Choose when email updates arrive for this company context.")}
            </p>
          </div>
          <span role="status">{t(preferenceStatus)}</span>
        </header>
        <div>
          {preferences.map((preference) => {
            // A communication is sent when it is sent: for these topics the choice is on or off, never a digest.
            const isCommunication =
              preference.eventType.startsWith("communication.");
            const [label, hint] = PREFERENCE_LABELS[preference.eventType] ?? [
              preference.eventType
                .replaceAll(".", " ")
                .replace(/\b\w/g, (letter) => letter.toUpperCase()),
              preference.mandatory
                ? "Mandatory service message · delivered immediately"
                : "In-app updates remain available in Pulse",
            ];
            return (
              <label key={preference.eventType}>
                <span>
                  <strong>{t(label)}</strong>
                  <small>{t(hint)}</small>
                </span>
                {isCommunication ? (
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`${t(label)}: ${t("Email")}`}
                    checked={preference.cadence !== "Off"}
                    disabled={preference.mandatory}
                    onChange={(event) =>
                      updatePreference(
                        preference.eventType,
                        event.target.checked ? "Immediate" : "Off",
                      )
                    }
                  />
                ) : (
                  <select
                    aria-label={`${preference.eventType} email cadence`}
                    value={preference.cadence}
                    disabled={preference.mandatory}
                    onChange={(event) =>
                      updatePreference(preference.eventType, event.target.value)
                    }
                  >
                    <option value="Immediate">{t("Immediate")}</option>
                    <option value="Daily">{t("Daily")}</option>
                    <option value="Weekly">{t("Weekly")}</option>
                    <option value="Off">{t("Off")}</option>
                  </select>
                )}
              </label>
            );
          })}
        </div>
      </section>
      {activeRole === "Company admin" && (
        <CompanyContactsSection onToast={onToast} />
      )}
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
                <code>{entry.date.toUpperCase()}</code>
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
                  {t("View product idea")}
                  <Icon name="arrow" size={14} />
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
