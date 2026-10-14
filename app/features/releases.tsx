"use client";

import { FormEvent, useState } from "react";

import {
  useT,
  mutationHeaders,
  type InternalIdea,
  type ReleaseItem,
  Icon,
  Status,
  Button,
  PageIntro,
  EmptyState,
} from "./shared";

export function ReleasesPage({
  releases,
  ideas,
  onChange,
  onIdeasChange,
  onToast,
  onDraftEmail,
}: {
  releases: ReleaseItem[];
  ideas: InternalIdea[];
  onChange: (items: ReleaseItem[]) => void;
  onIdeasChange: (items: InternalIdea[]) => void;
  onToast: (message: string) => void;
  /** Makes a customer email of a published release and opens it for editing; it reports its own failure. */
  onDraftEmail: (release: ReleaseItem) => Promise<void> | void;
}) {
  const t = useT();
  const [creating, setCreating] = useState(false);
  // True while a draft is being made: a second click must not make a second draft of the same release.
  const [drafting, setDrafting] = useState(false);
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
      { method: "POST", headers: mutationHeaders(false, item.version) },
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
  async function draftEmail(item: ReleaseItem) {
    if (drafting) return;
    setDrafting(true);
    try {
      await onDraftEmail(item);
    } finally {
      setDrafting(false);
    }
  }
  return (
    <div className="page-stack management-page">
      <PageIntro
        eyebrow="Release communication"
        title="Releases"
        description="Publish availability, documentation, and safe release notes to requesters and followers."
        action={
          <Button icon="plus" onClick={() => setCreating(true)}>
            {t("Create release")}
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
                  {release.ideaIds.length} {t("ideas")}
                </span>
                {!release.published && (
                  <Button onClick={() => publish(release)}>
                    {t("Publish release")}
                  </Button>
                )}
                {release.published && (
                  <Button
                    variant="secondary"
                    icon="send"
                    disabled={drafting}
                    onClick={() => void draftEmail(release)}
                  >
                    {t("Draft customer email")}
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
                <p className="eyebrow">{t("Release record")}</p>
                <h2>{t("Create release")}</h2>
                <p>
                  {t(
                    "Publishing will update included ideas and notify each eligible user once.",
                  )}
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
                    {t("Title")}
                    <em>{t("Required")}</em>
                  </span>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    required
                  />
                </label>
                <label className="form-field">
                  <span>{t("Release date")}</span>
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
                  {t("Customer summary")}
                  <em>{t("Required")}</em>
                </span>
                <textarea
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                  required
                />
              </label>
              <div className="form-grid">
                <label className="form-field">
                  <span>{t("Availability")}</span>
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
                  <span>{t("Documentation URL")}</span>
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
                  {t("Included ideas")}
                  <em>{t("Required")}</em>
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
                <span>
                  {ideaIds.length} {t("ideas selected")}
                </span>
                <div>
                  <Button
                    variant="secondary"
                    onClick={() => setCreating(false)}
                  >
                    {t("Cancel")}
                  </Button>
                  <Button
                    type="submit"
                    icon="check"
                    disabled={
                      !title.trim() || !summary.trim() || ideaIds.length === 0
                    }
                  >
                    {t("Create draft")}
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
