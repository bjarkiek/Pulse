"use client";

import { FormEvent, useEffect, useState } from "react";

import {
  useT,
  mutationHeaders,
  type Idea,
  type InternalIdea,
  type ExternalLinkItem,
  type RequestItem,
  type ManagedUser,
  Icon,
  Status,
  Button,
  PageIntro,
} from "./shared";

export function InternalIdeasPage({
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
  const t = useT();
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
            {t("Create idea")}
          </Button>
        }
      />
      <section className="admin-metric-grid">
        <div>
          <span>{t("Active ideas")}</span>
          <strong>
            {ideas.filter((idea) => idea.internalStatus !== "Archived").length}
          </strong>
          <small>{t("Canonical product records")}</small>
        </div>
        <div>
          <span>{t("Staged changes")}</span>
          <strong>
            {ideas.filter((idea) => idea.publishState === "Staged").length}
          </strong>
          <small>{t("Awaiting explicit publication")}</small>
        </div>
        <div>
          <span>{t("Unlinked evidence")}</span>
          <strong>
            {requests.filter((request) => !request.linkedIdea).length}
          </strong>
          <small>{t("Requests needing consolidation")}</small>
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
        <span>
          {visible.length} {t("ideas")}
        </span>
      </div>
      <div className="management-table idea-admin-table">
        <div className="management-head">
          <span>{t("Idea")}</span>
          <span>{t("Status")}</span>
          <span>{t("Roadmap")}</span>
          <span>{t("Evidence")}</span>
          <span>{t("Score")}</span>
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
              {idea.organizations} {t("orgs ·")}
              {idea.linkedRequests || 0} {t("requests")}
            </span>
            <strong>{idea.score?.toFixed(2) || "—"}</strong>
            <Button variant="secondary" onClick={() => setEditing(idea)}>
              {t("Manage")}
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

export function IdeaWorkflowEditor({
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
  const t = useT();
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
        headers: idea ? mutationHeaders(true, idea.version) : mutationHeaders(),
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
      headers: mutationHeaders(true, idea.version),
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
            <p className="eyebrow">{t("Canonical product record")}</p>
            <h2>
              {idea
                ? `${idea.id} · ${idea.internalTitle}`
                : "Create product idea"}
            </h2>
            <p>
              {t(
                "Internal evidence remains separate from explicitly reviewed customer wording.",
              )}
            </p>
          </div>
          <button className="icon-button" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <form onSubmit={save}>
          <div className="workflow-columns">
            <div>
              <p className="field-label">{t("Internal product record")}</p>
              <label className="form-field">
                <span>
                  {t("Internal title")}
                  <em>{t("Required")}</em>
                </span>
                <input
                  value={internalTitle}
                  onChange={(event) => setInternalTitle(event.target.value)}
                  required
                />
              </label>
              <label className="form-field">
                <span>
                  {t("Internal description")}
                  <em>{t("Required")}</em>
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
                  <span>{t("Product area")}</span>
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
                  <span>{t("Internal status")}</span>
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
                  <span>{t("Roadmap horizon")}</span>
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
                  <span>{t("Owner")}</span>
                  <select
                    value={ownerId}
                    onChange={(event) => setOwnerId(event.target.value)}
                  >
                    <option value="">{t("Unassigned")}</option>
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
                <span>{t("Decision rationale")}</span>
                <textarea
                  value={rationale}
                  onChange={(event) => setRationale(event.target.value)}
                  placeholder="Required for Planned, Later, or Not planned"
                />
              </label>
              <div className="form-grid">
                <label className="form-field">
                  <span>{t("Reason category")}</span>
                  <input
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
                <label className="form-field">
                  <span>{t("Delivery reference")}</span>
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
                <span>{t("Explicit delivery-reference exception")}</span>
              </label>
              {idea && (
                <section className="external-link-editor">
                  <div className="field-label">
                    {t("External delivery links")}
                  </div>
                  {externalLinks.map((link) => (
                    <div className="external-link-row" key={link.id}>
                      <a href={link.url} target="_blank" rel="noreferrer">
                        {link.label}
                      </a>
                      <button onClick={() => removeDeliveryLink(link.id)}>
                        {t("Remove")}
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
                      {t("Add")}
                    </Button>
                  </div>
                </section>
              )}
            </div>
            <div>
              <p className="field-label">{t("Customer-safe publication")}</p>
              <label className="form-field">
                <span>{t("Published title")}</span>
                <input
                  value={publishedTitle}
                  onChange={(event) => setPublishedTitle(event.target.value)}
                />
              </label>
              <label className="form-field">
                <span>{t("Published description / explanation")}</span>
                <textarea
                  value={publishedDescription}
                  onChange={(event) =>
                    setPublishedDescription(event.target.value)
                  }
                />
              </label>
              <label className="form-field">
                <span>{t("Release notes")}</span>
                <textarea
                  value={releaseNotes}
                  onChange={(event) => setReleaseNotes(event.target.value)}
                />
              </label>
              <label className="form-field">
                <span>{t("Availability")}</span>
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
                        {t(
                          "I reviewed the wording and confirm it is customer-safe.",
                        )}
                      </span>
                    </label>
                    <Button
                      type="button"
                      icon="eye"
                      disabled={!safe || busy}
                      onClick={publish}
                    >
                      {t("Publish staged changes")}
                    </Button>
                  </div>
                  <div className="workflow-action">
                    <p className="field-label">{t("Link customer evidence")}</p>
                    <select
                      value={linkRequestId}
                      onChange={(event) => setLinkRequestId(event.target.value)}
                    >
                      <option value="">{t("Select request")}</option>
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
                      {t("Link request")}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
          {idea && (
            <section className="score-workspace">
              <p className="field-label">{t("Priority evidence")}</p>
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
                  <span>{t("Confidence")}</span>
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
                  <span>{t("Effort")}</span>
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
                  {t("Record score")}
                </Button>
              </div>
            </section>
          )}
          {idea && (
            <section className="merge-workspace">
              <p className="field-label">{t("Merge duplicate idea")}</p>
              <select
                value={mergeSource}
                onChange={(event) => setMergeSource(event.target.value)}
              >
                <option value="">{t("Select source idea")}</option>
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
                {t("Merge into")}
                {idea.id}
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
                {t("Close")}
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
