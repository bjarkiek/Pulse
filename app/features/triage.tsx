"use client";

import { useContext, useMemo, useState } from "react";

import { apiFetch, errorMessage } from "@/lib/api-client";

import { ModalDialog } from "./communication-dialog";

import {
  useT,
  mutationHeaders,
  isUntriaged,
  UserContext,
  type InternalIdea,
  type RequestItem,
  Icon,
  Status,
  Button,
  SkeletonRows,
} from "./shared";

type QueueTab = "untriaged" | "mine" | "all";

/** The decisions that need words from the person before they are recorded. */
type Decision =
  | { kind: "information" }
  | { kind: "support" }
  | { kind: "close" }
  | { kind: "link"; ideaId: string };

/** What a customer has not had an answer to yet: these are what "Assign visible to me" takes. */
const UNRESOLVED = ["Submitted", "Needs information"];

export function TriagePage({
  requests,
  ideas,
  canDecide,
  loading,
  setRequests,
  onToast,
}: {
  requests: RequestItem[];
  /** The requests have not arrived yet. */
  loading: boolean;
  /** The team's product ideas: a request is linked to one of these. */
  ideas: InternalIdea[];
  /** Whether this person's role records decisions (Product manager, System admin). An Internal contributor reviews and adds notes. */
  canDecide: boolean;
  setRequests: (items: RequestItem[]) => void;
  onToast: (message: string) => void;
}) {
  const t = useT();
  const me = useContext(UserContext).name;
  // Until the person picks a tab, the queue opens on what needs triage, or on everything when nothing does.
  const [pickedTab, setPickedTab] = useState<QueueTab | null>(null);
  const [query, setQuery] = useState("");
  const [area, setArea] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [decision, setDecision] = useState<Decision | null>(null);

  const counts = useMemo(
    () => ({
      untriaged: requests.filter(isUntriaged).length,
      mine: requests.filter((r) => me && r.owner === me).length,
      waiting: requests.filter((r) => r.status === "Needs information").length,
    }),
    [requests, me],
  );
  const tab: QueueTab = pickedTab ?? (counts.untriaged ? "untriaged" : "all");
  const areas = useMemo(
    () => [...new Set(requests.map((r) => r.area).filter(Boolean))].sort(),
    [requests],
  );
  const queue = useMemo(() => {
    const words = query.trim().toLowerCase();
    return requests.filter(
      (r) =>
        (tab === "all" ||
          (tab === "untriaged" ? isUntriaged(r) : Boolean(me) && r.owner === me)) &&
        (!area || r.area === area) &&
        (!words ||
          `${r.id} ${r.title} ${r.problem} ${r.area}`
            .toLowerCase()
            .includes(words)),
    );
  }, [requests, tab, area, query, me]);
  const selected = queue.find((r) => r.id === selectedId) ?? queue[0] ?? null;
  const openIdeas = useMemo(
    () => ideas.filter((idea) => idea.internalStatus !== "Archived"),
    [ideas],
  );
  const suggestions = selected
    ? openIdeas
        .filter(
          (idea) =>
            idea.area === selected.area ||
            selected.title
              .toLowerCase()
              .includes(idea.title.split(" ")[0].toLowerCase()),
        )
        .slice(0, 2)
    : [];

  function replace(item: RequestItem) {
    setRequests(requests.map((r) => (r.id === item.id ? { ...r, ...item } : r)));
  }
  /** Keeps the place in the queue when a decision takes the request out of the open tab. */
  function stayInPlace(id: string) {
    setPickedTab(tab);
    const index = queue.findIndex((r) => r.id === id);
    setSelectedId((queue[index + 1] ?? queue[index - 1])?.id ?? null);
  }

  async function addInternalNote() {
    if (!selected || !note.trim()) return;
    try {
      await apiFetch(`/api/v1/requests/${selected.id}/comments`, {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({ body: note, visibility: "Internal" }),
      });
      setNote("");
      onToast("Internal note added.");
    } catch (error) {
      onToast(errorMessage(error));
    }
  }

  /** Records a status. The server's answer carries the new version, which the next decision on the same request must send. */
  async function updateStatus(
    request: RequestItem,
    status: string,
    details: { explanation?: string; supportReference?: string } = {},
  ) {
    const data = await apiFetch<{ item: RequestItem }>(
      `/api/v1/requests/${request.id}`,
      {
        method: "PATCH",
        headers: mutationHeaders(true, request.version),
        body: JSON.stringify({ status, ...details }),
      },
    );
    // Closed here and not by the dialog: the request may leave the open tab, and the dialog must not reappear on the next one.
    setDecision(null);
    if (tab === "untriaged") stayInPlace(request.id);
    replace(data.item);
    onToast(`${request.id} was updated to ${status}.`);
  }

  async function linkIdea(request: RequestItem, ideaId: string, reason: string) {
    await apiFetch(`/api/v1/internal/ideas/${ideaId}/links`, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ requestId: request.id, reason }),
    });
    // The link changes the request on the server (its status and version), so the row is read again and not guessed.
    const fresh = await apiFetch<{ item: RequestItem }>(
      `/api/v1/requests/${request.id}`,
      { cache: "no-store" },
    ).catch(() => null);
    setDecision(null);
    if (tab === "untriaged") stayInPlace(request.id);
    replace(
      fresh?.item ?? {
        ...request,
        status: "Linked",
        tone: "violet",
        linkedIdea: ideaId,
      },
    );
    onToast(`${request.id} was linked to ${ideaId}.`);
  }

  async function assignVisible() {
    const requestIds = queue
      .filter((item) => UNRESOLVED.includes(item.status))
      .slice(0, 100)
      .map((item) => item.id);
    if (!requestIds.length) {
      onToast("There are no visible unresolved requests to assign.");
      return;
    }
    try {
      await apiFetch("/api/v1/internal/triage/bulk", {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({ requestIds, ownerId: "me" }),
      });
      setRequests(
        requests.map((item) =>
          requestIds.includes(item.id) ? { ...item, owner: me } : item,
        ),
      );
      onToast(
        `${requestIds.length} requests assigned in one audited operation.`,
      );
    } catch {
      onToast("The bulk assignment could not be completed.");
    }
  }

  const tabs: { id: QueueTab; label: string; count: number }[] = [
    { id: "untriaged", label: "Untriaged", count: counts.untriaged },
    { id: "mine", label: "Assigned to me", count: counts.mine },
    { id: "all", label: "All", count: requests.length },
  ];
  const decide = (next: Decision) => () => setDecision(next);

  return (
    <div className="triage-page">
      <div className="triage-summary">
        <div>
          <p>{t("Classify, consolidate, and communicate every request.")}</p>
        </div>
        <div className="triage-metrics">
          <span>
            <strong>{counts.untriaged}</strong> {t("untriaged")}
          </span>
          <span>
            <strong>{counts.waiting}</strong> {t("waiting on customer")}
          </span>
          <span>
            <strong>{counts.mine}</strong> {t("assigned to me")}
          </span>
        </div>
      </div>
      <div className="triage-workspace" data-tour="triage-inbox">
        <aside className="triage-queue">
          <div className="queue-toolbar">
            <div className="search-input">
              <Icon name="search" size={15} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("Search queue")}
                aria-label={t("Search queue")}
              />
            </div>
            <label className="select-wrap">
              <Icon name="filter" size={16} />
              <select
                value={area}
                onChange={(event) => setArea(event.target.value)}
                aria-label={t("Product area")}
              >
                <option value="">{t("All areas")}</option>
                {areas.map((name) => (
                  <option key={name} value={name}>
                    {t(name)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="queue-tabs">
            {tabs.map((item) => (
              <button
                key={item.id}
                className={tab === item.id ? "active" : ""}
                aria-pressed={tab === item.id}
                onClick={() => setPickedTab(item.id)}
              >
                {t(item.label)}
                <span>{item.count}</span>
              </button>
            ))}
          </div>
          <div className="bulk-triage-actions">
            <span>{t("Bulk actions never close or publish requests.")}</span>
            <Button
              variant="secondary"
              disabled={!canDecide}
              onClick={assignVisible}
            >
              {t("Assign visible to me")}
            </Button>
          </div>
          <div className="queue-list">
            {queue.map((request) => (
              <button
                key={request.id}
                className={selected?.id === request.id ? "active" : ""}
                aria-current={selected?.id === request.id ? "true" : undefined}
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
            {loading && <SkeletonRows count={4} />}
            {!loading && !queue.length && (
              <p className="queue-empty">
                {tab === "untriaged" && !query && !area
                  ? t("Nothing is waiting for triage.")
                  : t("No requests match this view.")}
              </p>
            )}
          </div>
        </aside>
        {selected ? (
          <section className="triage-detail">
            <div className="triage-detail-head">
              <div>
                <div className="record-meta">
                  <code>{selected.id}</code>
                  <span>{t("Customer request")}</span>
                  <span>{selected.submitted}</span>
                </div>
                <h2>{selected.title}</h2>
              </div>
              <Status tone={selected.tone}>{selected.status}</Status>
            </div>
            <div className="triage-detail-grid">
              <div className="evidence-column">
                <section>
                  <p className="field-label">{t("Customer problem")}</p>
                  <p className="evidence-text">{selected.problem}</p>
                </section>
                <section className="context-grid">
                  <div>
                    <p className="field-label">{t("Impact")}</p>
                    <strong>{selected.impact}</strong>
                  </div>
                  <div>
                    <p className="field-label">{t("Product area")}</p>
                    <strong>{selected.area}</strong>
                  </div>
                  <div>
                    <p className="field-label">{t("Visibility")}</p>
                    <strong>{selected.visibility}</strong>
                  </div>
                  <div>
                    <p className="field-label">{t("Owner")}</p>
                    <strong>{selected.owner}</strong>
                  </div>
                </section>
                <section>
                  <div className="section-title">
                    <div>
                      <p className="field-label">
                        {t("Related product ideas")}
                      </p>
                      <span>{t("Suggested from title and context")}</span>
                    </div>
                  </div>
                  <div className="suggestion-list">
                    {suggestions.map((idea) => (
                      <button
                        key={idea.id}
                        disabled={!canDecide}
                        onClick={decide({ kind: "link", ideaId: idea.id })}
                      >
                        <div>
                          <Status tone={idea.tone}>{idea.status}</Status>
                          <code>{idea.id}</code>
                        </div>
                        <strong>{idea.title}</strong>
                        <span>
                          {idea.organizations} {t("organizations ·")}
                          {idea.area}
                        </span>
                        <Icon name="link" size={16} />
                      </button>
                    ))}
                    {!suggestions.length && (
                      <div className="no-suggestion">
                        {t("No strong match. Create a canonical product idea.")}
                      </div>
                    )}
                  </div>
                </section>
                <section>
                  <p className="field-label">{t("Internal note")}</p>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={t(
                      "Add evidence, constraints, or a decision rationale",
                    )}
                    aria-label={t("Internal note")}
                  />
                  <div className="note-actions">
                    <span>{t("Internal only")}</span>
                    <Button
                      variant="secondary"
                      icon="send"
                      disabled={!note.trim()}
                      onClick={addInternalNote}
                    >
                      {t("Add note")}
                    </Button>
                  </div>
                </section>
              </div>
              <aside className="decision-panel">
                <p className="field-label">{t("Triage decision")}</p>
                <h3>{t("Choose the next step")}</h3>
                <p>
                  {canDecide
                    ? t(
                        "This updates the customer-visible request and records the decision.",
                      )
                    : t(
                        "Your role reviews requests and adds notes. A Product manager or System admin records the decision.",
                      )}
                </p>
                <button
                  disabled={!canDecide}
                  onClick={decide({
                    kind: "link",
                    ideaId: suggestions[0]?.id ?? "",
                  })}
                >
                  <span className="decision-icon">
                    <Icon name="link" size={17} />
                  </span>
                  <span>
                    <strong>{t("Link to product idea")}</strong>
                    <small>{t("Consolidate with existing demand")}</small>
                  </span>
                  <Icon name="chevron" size={15} />
                </button>
                <button
                  disabled={!canDecide}
                  onClick={decide({ kind: "information" })}
                >
                  <span className="decision-icon">
                    <Icon name="message" size={17} />
                  </span>
                  <span>
                    <strong>{t("Request information")}</strong>
                    <small>{t("Ask the customer a clear question")}</small>
                  </span>
                  <Icon name="chevron" size={15} />
                </button>
                <button
                  disabled={!canDecide}
                  onClick={decide({ kind: "support" })}
                >
                  <span className="decision-icon">
                    <Icon name="send" size={17} />
                  </span>
                  <span>
                    <strong>{t("Route to support")}</strong>
                    <small>{t("Record the destination case reference")}</small>
                  </span>
                  <Icon name="chevron" size={15} />
                </button>
                <button
                  disabled={!canDecide}
                  onClick={decide({ kind: "close" })}
                >
                  <span className="decision-icon">
                    <Icon name="x" size={17} />
                  </span>
                  <span>
                    <strong>{t("Close request")}</strong>
                    <small>{t("Requires a customer explanation")}</small>
                  </span>
                  <Icon name="chevron" size={15} />
                </button>
              </aside>
            </div>
          </section>
        ) : (
          <section className="triage-detail triage-detail-empty">
            <Icon name="layers" size={22} />
            <p>
              {loading
                ? t("Loading…")
                : requests.length
                  ? t("Select a request to review it.")
                  : t("No requests have been submitted yet.")}
            </p>
          </section>
        )}
      </div>
      {decision && selected && (
        <DecisionDialog
          key={`${selected.id}:${decision.kind}`}
          decision={decision}
          request={selected}
          ideas={openIdeas}
          onClose={() => setDecision(null)}
          onStatus={updateStatus}
          onLink={linkIdea}
        />
      )}
    </div>
  );
}

/**
 * The words a decision needs, asked in the page: a sandboxed frame such as DataCentral's may refuse `window.prompt`, and a prompt gives no
 * room to see what the customer wrote. A failure stays in the dialog with the typed text, so nothing has to be written twice.
 */
function DecisionDialog({
  decision,
  request,
  ideas,
  onClose,
  onStatus,
  onLink,
}: {
  decision: Decision;
  request: RequestItem;
  ideas: InternalIdea[];
  onClose: () => void;
  onStatus: (
    request: RequestItem,
    status: string,
    details?: { explanation?: string; supportReference?: string },
  ) => Promise<void>;
  onLink: (request: RequestItem, ideaId: string, reason: string) => Promise<void>;
}) {
  const t = useT();
  const [text, setText] = useState(
    decision.kind === "link" ? "Consolidates the same customer outcome" : "",
  );
  const [ideaId, setIdeaId] = useState(
    decision.kind === "link" ? decision.ideaId : "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  // "Request information" is two writes: the question, then the status. If the second fails the question is already on the request,
  // and a retry must not post it again.
  const [questionSaved, setQuestionSaved] = useState(false);

  const copy = {
    information: {
      title: "Request information",
      label: "Question for the customer",
      hint: "The customer sees this question on the request and is notified.",
      action: "Send question",
    },
    support: {
      title: "Route to support",
      label: "Support case URL or reference",
      hint: "The customer is told the request is handled through support.",
      action: "Route request",
    },
    close: {
      title: "Close request",
      label: "Explanation for the customer",
      hint: "The customer sees this explanation on the closed request.",
      action: "Close request",
    },
    link: {
      title: "Link to product idea",
      label: "Reason",
      hint: "The request follows the idea from now on, and its customer sees the idea's progress.",
      action: "Link request",
    },
  }[decision.kind];
  const ready =
    Boolean(text.trim()) && (decision.kind !== "link" || Boolean(ideaId));

  async function submit() {
    setPending(true);
    setError("");
    const words = text.trim();
    try {
      if (decision.kind === "information") {
        if (!questionSaved) {
          await apiFetch(`/api/v1/requests/${request.id}/comments`, {
            method: "POST",
            headers: mutationHeaders(),
            body: JSON.stringify({ body: words, visibility: "Customer" }),
          });
          setQuestionSaved(true);
        }
        try {
          await onStatus(request, "Needs information");
        } catch (failure) {
          setError(
            `${t("The question was saved, but the status could not be changed.")} ${t(errorMessage(failure))}`,
          );
          return;
        }
      } else if (decision.kind === "support")
        await onStatus(request, "Routed to support", {
          supportReference: words,
          explanation:
            "This request is being handled through the customer support process.",
        });
      else if (decision.kind === "close")
        await onStatus(request, "Closed", { explanation: words });
      else await onLink(request, ideaId, words);
      onClose();
    } catch (failure) {
      setError(t(errorMessage(failure)));
    } finally {
      setPending(false);
    }
  }

  return (
    <ModalDialog
      id="triage-decision-title"
      title={`${t(copy.title)} · ${request.id}`}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !pending) void submit();
        }}
      >
        <p className="decision-subject">{request.title}</p>
        {decision.kind === "link" && (
          <label className="form-field">
            <span>{t("Product idea")}</span>
            <select
              value={ideaId}
              onChange={(event) => setIdeaId(event.target.value)}
              autoFocus
            >
              <option value="">{t("Select a product idea")}</option>
              {ideas.map((idea) => (
                <option key={idea.id} value={idea.id}>
                  {idea.id} · {idea.internalTitle || idea.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="form-field">
          <span>{t(copy.label)}</span>
          {decision.kind === "information" || decision.kind === "close" ? (
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={5000}
              disabled={questionSaved}
              autoFocus
            />
          ) : (
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={200}
              autoFocus={decision.kind === "support"}
            />
          )}
        </label>
        <p className="decision-hint">{t(copy.hint)}</p>
        {error && (
          <p className="decision-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <span />
          <div>
            <Button variant="secondary" onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={!ready || pending}>
              {questionSaved ? t("Try again") : t(copy.action)}
            </Button>
          </div>
        </footer>
      </form>
    </ModalDialog>
  );
}
