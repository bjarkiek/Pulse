"use client";

import {
  useContext,
  useMemo,
  useRef,
  FormEvent,
  useEffect,
  useState,
} from "react";

import { apiFetch, ApiFailure, errorMessage } from "@/lib/api-client";

import {
  readDeviceDraft,
  saveDeviceDraft,
  removeDeviceDraft,
} from "@/lib/draft-storage";

import {
  DraftOwnerContext,
  useT,
  mutationHeaders,
  type SearchSuggestionItem,
  type RequestItem,
  Icon,
  Status,
  Button,
} from "./shared";

export function RequestComposer({
  onClose,
  onSubmit,
  onFollow,
}: {
  onClose: () => void;
  onSubmit: (request: RequestItem) => void;
  onFollow: (id: string, support?: boolean) => void;
}) {
  const t = useT();
  const draftScope = useContext(DraftOwnerContext);
  const scopeHeaders = useMemo(
    () => ({
      "x-pulse-organization-id": draftScope?.split(":")[1] || "",
      "x-pulse-draft-owner": draftScope?.split(":")[0] || "",
    }),
    [draftScope],
  );
  const [draftReady, setDraftReady] = useState(false);
  const [requestCreated, setRequestCreated] = useState(false);
  const submission = useRef<{
    key: string;
    item?: RequestItem;
    uploaded: Set<number>;
    targets: Map<
      number,
      {
        uploadUrl: string;
        expiresAt: string;
        attachment: { id: string; scanState: string };
        sent: boolean;
      }
    >;
  }>({ key: crypto.randomUUID(), uploaded: new Set(), targets: new Map() });
  const [draftStatus, setDraftStatus] = useState("");
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
    if (!draftScope) return;
    let cancelled = false;
    const controller = new AbortController();
    async function restore() {
      let draft;
      try {
        const response = await fetch("/api/v1/requests/draft", {
          signal: controller.signal,
          headers: scopeHeaders,
        });
        if (!response.ok) throw new Error("draft unavailable");
        draft = (await response.json()).item;
      } catch {
        /* The scoped device copy remains available during an outage. */
      }
      if (cancelled) return;
      if (!draft) {
        try {
          draft = JSON.parse(readDeviceDraft(draftScope) || "null");
        } catch {
          /* invalid device copy */
        }
      }
      if (draft) {
        setTitle(draft.title || "");
        setProblem(draft.problem || "");
        setArea(draft.area || "Distribution");
        setImpact(draft.impact || "High");
        setVisibility(draft.visibility || "Organization");
        setLinkedIdeaId(draft.linkedIdeaId || "");
        setRequestType(draft.requestType || "Feature");
        setAffectedUsers(String(draft.affectedUsers || ""));
        setWorkaround(draft.workaround || "");
        setDesiredTiming(draft.desiredTiming || "");
      }
      setDraftReady(true);
    }
    void restore();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [draftScope, scopeHeaders]);
  useEffect(() => {
    if (!draftScope || !draftReady || submitting || submission.current.item)
      return;
    const deviceSaved = saveDeviceDraft(
      draftScope,
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
    const timer = window.setTimeout(async () => {
      setDraftStatus(t("Saving draft…"));
      await fetch("/api/v1/requests/draft", {
        method: "PUT",
        headers: { "content-type": "application/json", ...scopeHeaders },
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
      })
        .then((response) =>
          setDraftStatus(
            response.ok
              ? t("Draft saved")
              : t(
                  deviceSaved
                    ? "Saved on this device. Server save failed; retry when connected."
                    : "Draft not saved. Keep this window open and try again.",
                ),
          ),
        )
        .catch(() =>
          setDraftStatus(
            t(
              deviceSaved
                ? "Saved on this device. Server save failed; retry when connected."
                : "Draft not saved. Keep this window open and try again.",
            ),
          ),
        );
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [
    draftScope,
    scopeHeaders,
    draftReady,
    submitting,
    t,
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
      let item = submission.current.item;
      if (!item) {
        const data = await apiFetch<{ item: RequestItem }>("/api/v1/requests", {
          method: "POST",
          headers: {
            ...scopeHeaders,
            ...mutationHeaders(),
            "idempotency-key": submission.current.key,
          },
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
        item = data.item as RequestItem;
        submission.current.item = item;
        setRequestCreated(true);
      }
      for (let index = 0; index < files.length; index++) {
        if (submission.current.uploaded.has(index)) continue;
        const file = files[index];
        let target = submission.current.targets.get(index);
        if (
          !target ||
          (!target.sent && Date.parse(target.expiresAt) <= Date.now() + 10_000)
        ) {
          const prepared = await apiFetch<{
            uploadUrl: string;
            expiresAt: string;
            attachment: { id: string; scanState: string };
          }>(`/api/v1/requests/${item.id}/attachments`, {
            method: "POST",
            headers: {
              ...scopeHeaders,
              ...mutationHeaders(),
              "idempotency-key": `${submission.current.key}-${index}`,
            },
            body: JSON.stringify({
              fileName: file.name,
              contentType: file.type || "application/octet-stream",
              sizeBytes: file.size,
            }),
          });
          if (["Clean", "Scanning"].includes(prepared.attachment.scanState)) {
            submission.current.uploaded.add(index);
            continue;
          }
          if (prepared.attachment.scanState !== "Pending upload")
            throw new Error(
              t("Upload failed. Remove the attachment and try again."),
            );
          target = { ...prepared, sent: false };
          submission.current.targets.set(index, target);
        }
        if (!target.sent) {
          const upload = await fetch(target.uploadUrl, {
            method: "PUT",
            headers: {
              "content-type": file.type || "application/octet-stream",
              ...(target.uploadUrl.startsWith("http")
                ? { "x-ms-blob-type": "BlockBlob" }
                : scopeHeaders),
            },
            body: file,
          });
          if (!upload.ok) throw new Error(`Could not upload ${file.name}`);
          target.sent = true;
        }
        if (target.uploadUrl.startsWith("http")) {
          await apiFetch(
            `/api/v1/attachments/${target.attachment.id}/complete`,
            {
              method: "POST",
              headers: scopeHeaders,
            },
          );
        }
        submission.current.uploaded.add(index);
        setUploadProgress(Math.round(((index + 1) / files.length) * 100));
      }
      removeDeviceDraft(draftScope);
      await fetch("/api/v1/requests/draft", {
        method: "DELETE",
        headers: scopeHeaders,
      }).catch(() => undefined);
      onSubmit({ ...item, attachmentCount: files.length });
    } catch (caught) {
      setError(
        caught instanceof ApiFailure
          ? t(errorMessage(caught))
          : caught instanceof Error
            ? caught.message
            : t("Request submission failed"),
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
            <p className="eyebrow">{t("New customer request")}</p>
            <p role="status" aria-live="polite">
              {draftStatus}
            </p>
            <h2 id="composer-title">{t("Describe the outcome you need")}</h2>
            <p>
              {t(
                "Start with the problem. DataCentral will assess the right product response.",
              )}
            </p>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label={t("Close")}
          >
            <Icon name="x" />
          </button>
        </header>
        <form onSubmit={submit}>
          <fieldset
            disabled={!draftReady || submitting || requestCreated}
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          >
            <label className="form-field" data-tour="composer-title">
              <span>
                {t("Short title")} <em>{t("Required")}</em>
              </span>
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={140}
                placeholder={t(
                  "For example: Scheduled report delivery to SharePoint",
                )}
                required
              />
              <small>{title.length}/140</small>
            </label>
            {visibleSuggestions.length > 0 && (
              <div className="duplicate-panel">
                <div>
                  <Icon name="spark" size={17} />
                  <span>
                    <strong>{t("Related ideas already exist")}</strong>
                    <small>
                      {t(
                        "Add your organization’s interest or continue with distinct context.",
                      )}
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
                          {t("This solves my need")}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => setLinkedIdeaId(suggestion.id)}
                        >
                          {t("Add my context")}
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
                {linkedIdeaId && (
                  <p className="linked-context-note">
                    {t("Your new request will be linked to")}
                    {linkedIdeaId}{" "}
                    {t("while keeping your company context private.")}
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
                        suggestionIds: visibleSuggestions.map(
                          (item) => item.id,
                        ),
                      }),
                    }).catch(() => undefined);
                  }}
                >
                  {t("Continue with a new request")}
                </button>
              </div>
            )}
            <label className="form-field" data-tour="composer-problem">
              <span>
                {t("Problem or desired outcome")} <em>{t("Required")}</em>
              </span>
              <textarea
                value={problem}
                onChange={(e) => setProblem(e.target.value)}
                maxLength={5000}
                placeholder={t(
                  "What are you trying to achieve, who is affected, and what happens today?",
                )}
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
              {showDetails
                ? "Hide additional context"
                : t("Add impact and context")}
            </button>
            {showDetails && (
              <div className="form-grid">
                <label className="form-field">
                  <span>{t("Request type")}</span>
                  <select
                    value={requestType}
                    onChange={(e) => setRequestType(e.target.value)}
                  >
                    <option value="Feature">{t("Feature")}</option>
                    <option value="Improvement">{t("Improvement")}</option>
                    <option value="Integration">{t("Integration")}</option>
                    <option value="Compliance">{t("Compliance")}</option>
                  </select>
                </label>
                <label className="form-field">
                  <span>{t("Product area")}</span>
                  <select
                    value={area}
                    onChange={(e) => setArea(e.target.value)}
                  >
                    <option value="Distribution">{t("Distribution")}</option>
                    <option value="Governance">{t("Governance")}</option>
                    <option value="Authentication">
                      {t("Authentication")}
                    </option>
                    <option value="Embedding">{t("Embedding")}</option>
                    <option value="Display">{t("Display")}</option>
                    <option value="Administration">
                      {t("Administration")}
                    </option>
                    <option value="Experience">{t("Experience")}</option>
                  </select>
                </label>
                <label className="form-field">
                  <span>{t("Business impact")}</span>
                  <select
                    value={impact}
                    onChange={(e) => setImpact(e.target.value)}
                  >
                    <option value="Low">{t("Low")}</option>
                    <option value="Medium">{t("Medium")}</option>
                    <option value="High">{t("High")}</option>
                    <option value="Critical">{t("Critical")}</option>
                  </select>
                </label>
                <label className="form-field">
                  <span>{t("Affected users")}</span>
                  <input
                    type="number"
                    min="1"
                    value={affectedUsers}
                    onChange={(e) => setAffectedUsers(e.target.value)}
                    placeholder={t("Optional estimate")}
                  />
                </label>
                <label className="form-field">
                  <span>{t("Desired timing")}</span>
                  <input
                    value={desiredTiming}
                    onChange={(e) => setDesiredTiming(e.target.value)}
                    placeholder={t("For example Q4 or 2026-11-01")}
                  />
                </label>
                <label className="form-field form-field-wide">
                  <span>{t("Current workaround")}</span>
                  <textarea
                    value={workaround}
                    onChange={(e) => setWorkaround(e.target.value)}
                    placeholder={t("How do you handle this today?")}
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
                  <strong>{t("Add screenshots or files")}</strong>
                  <small>
                    {t("Drop files here or browse · 25 MB each, 100 MB total")}
                  </small>
                </span>
              </label>
              {files.length > 0 && (
                <div className="upload-list">
                  {files.map((file, index) => (
                    <div key={`${file.name}-${index}`}>
                      <span>
                        <strong>{file.name}</strong>
                        <small>
                          {(file.size / 1024 / 1024).toFixed(1)} {t("MB")}
                        </small>
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${file.name}`}
                        onClick={() =>
                          setFiles((items) =>
                            items.filter((_, i) => i !== index),
                          )
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
                  {t("Visible to")}{" "}
                  {visibility === "Organization"
                    ? t("your organization")
                    : t("you and DataCentral")}
                </strong>
                <span>
                  {t(
                    "Raw customer context is never shared with other customers.",
                  )}
                </span>
              </div>
              <select
                value={visibility}
                onChange={(e) => setVisibility(e.target.value)}
              >
                <option value="Organization">{t("Organization")}</option>
                <option value="Private">{t("Private")}</option>
              </select>
            </div>
            <div className="privacy-reminder">
              <Icon name="eye" size={16} />
              <span>
                {t(
                  "Do not upload credentials, personal data, secrets, or unredacted production data.",
                )}
              </span>
            </div>
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
          </fieldset>
          <footer>
            <span>
              {submitting && files.length
                ? `${t("Uploading attachments")} · ${uploadProgress}%`
                : t("Draft autosaves on this device")}
            </span>
            <div>
              <Button
                variant="secondary"
                onClick={onClose}
                disabled={submitting}
              >
                {t("Cancel")}
              </Button>
              <Button
                type="submit"
                icon="send"
                dataTour="composer-submit"
                disabled={
                  !draftReady || !title.trim() || !problem.trim() || submitting
                }
              >
                {t(
                  submitting
                    ? "Submitting…"
                    : requestCreated
                      ? "Retry attachments"
                      : "Submit request",
                )}
              </Button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}
