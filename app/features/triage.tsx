"use client";

import { useMemo, useState } from "react";

import {
  useT,
  mutationHeaders,
  type Tone,
  type Idea,
  type RequestItem,
  Icon,
  Status,
  Button,
} from "./shared";

export function TriagePage({
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
  const t = useT();
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
      headers: mutationHeaders(true, selected.version),
      body: JSON.stringify({ status, ...details }),
    });
    if (!response.ok) {
      onToast("The request could not be updated.");
      return;
    }
    const updated = requests.some((r) => r.id === selected.id)
      ? requests.map((r) =>
          r.id === selected.id ? { ...r, status, tone, owner: r.owner } : r,
        )
      : [{ ...selected, status, tone, owner: selected.owner }, ...requests];
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
      .filter((item) =>
        ["Submitted", "Needs information"].includes(item.status),
      )
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
          <p className="eyebrow">{t("Product workspace")}</p>
          <h2>{t("Review customer evidence")}</h2>
          <p>{t("Classify, consolidate, and communicate every request.")}</p>
        </div>
        <div className="triage-metrics">
          <span>
            <strong>6</strong> {t("untriaged")}
          </span>
          <span>
            <strong>2</strong> {t("overdue")}
          </span>
          <span>
            <strong>1.8d</strong> {t("median triage")}
          </span>
        </div>
      </div>
      <div className="triage-workspace" data-tour="triage-inbox">
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
              {t("Untriaged")}
              <span>6</span>
            </button>
            <button>
              {t("Assigned to me")}
              <span>3</span>
            </button>
          </div>
          <div className="bulk-triage-actions">
            <span>{t("Bulk actions never close or publish requests.")}</span>
            <Button variant="secondary" onClick={bulkAssignVisible}>
              {t("Assign visible to me")}
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
                <span>{t("Customer request")}</span>
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
                    <p className="field-label">{t("Related product ideas")}</p>
                    <span>{t("Suggested from title and context")}</span>
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
                          {idea.organizations} {t("organizations ·")}
                          {idea.area}
                        </span>
                        <Icon name="link" size={16} />
                      </button>
                    ))}
                  {ideas.filter((i) => i.area === selected.area).length ===
                    0 && (
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
                  placeholder="Add evidence, constraints, or a decision rationale"
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
                {t(
                  "This updates the customer-visible request and records the decision.",
                )}
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
                  <strong>{t("Start discovery")}</strong>
                  <small>{t("Valid problem; investigate options")}</small>
                </span>
                <Icon name="chevron" size={15} />
              </button>
              <button onClick={linkSuggestedIdea}>
                <span className="decision-icon">
                  <Icon name="link" size={17} />
                </span>
                <span>
                  <strong>{t("Link to product idea")}</strong>
                  <small>{t("Consolidate with existing demand")}</small>
                </span>
                <Icon name="chevron" size={15} />
              </button>
              <button onClick={requestInformation}>
                <span className="decision-icon">
                  <Icon name="message" size={17} />
                </span>
                <span>
                  <strong>{t("Request information")}</strong>
                  <small>{t("Ask the customer a clear question")}</small>
                </span>
                <Icon name="chevron" size={15} />
              </button>
              <button onClick={routeToSupport}>
                <span className="decision-icon">
                  <Icon name="message" size={17} />
                </span>
                <span>
                  <strong>{t("Route to support")}</strong>
                  <small>{t("Record the destination case reference")}</small>
                </span>
                <Icon name="chevron" size={15} />
              </button>
              <button onClick={closeRequest}>
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
      </div>
    </div>
  );
}
