"use client";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ApiFailure, apiFetch, errorMessage } from "@/lib/api-client";
import {
  Button,
  COMMUNICATION_TOPIC_LABELS,
  Icon,
  mutationHeaders,
  useT,
  type AudienceBreakdownItem,
  type CommunicationItem,
  type CommunicationProviderStatus,
  type Company,
} from "./shared";
import { ModalDialog } from "./communication-dialog";
import {
  COMMUNICATION_TEMPLATE_LABELS,
  Field,
  PlainFields,
  ProductUpdateFields,
  ServiceNoticeFields,
  type TemplateBody,
} from "./communication-fields";

type Step = "content" | "audience" | "review";
type Locale = "en" | "is";
type Dialog = "send" | "discard" | null;

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "content", label: "Content" },
  { id: "audience", label: "Audience" },
  { id: "review", label: "Review & send" },
];

/** What the audience summary calls the people left out, by the reason the server records for each of them. */
const SUPPRESSION_LABELS: Record<string, string> = {
  SafeMode: "Safe mode",
  PreferenceOff: "Opted out of this topic",
  Unsubscribed: "Unsubscribed",
  Bounced: "Bounced",
  SpamReport: "Spam report",
  Manual: "Blocked manually",
};

const API = "/api/v1/internal/communications";

/**
 * The mail as the server renders it. It is fetched like every other call, so the bearer token of the DataCentral embed goes with it (a
 * document navigation to the same address could not carry it), and shown in the frame as its source.
 */
async function fetchPreview(id: string, locale: Locale, signal: AbortSignal) {
  const response = await fetch(`${API}/${id}/preview?locale=${locale}`, {
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiFailure(
      response.status,
      data?.error?.code || "REQUEST_FAILED",
      response.headers.get("x-correlation-id") || undefined,
    );
  }
  return response.text();
}

export function CommunicationEditor({
  item,
  companies,
  onSaved,
  onClose,
  onToast,
}: {
  item: CommunicationItem;
  companies: Company[];
  onSaved: (item: CommunicationItem) => void;
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<CommunicationItem>(item);
  const [locale, setLocale] = useState<Locale>("en");
  const [step, setStep] = useState<Step>("content");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  // The numbers for one version of the draft; they are shown only while the draft is still at that version.
  const [estimated, setEstimated] = useState<{
    version: string | undefined;
    item: AudienceBreakdownItem;
  } | null>(null);
  // What the worker would do with a send now. It comes with the audience numbers, which every internal role may read, so the people who send see
  // the warnings too (the settings themselves are for System admins). undefined until the first answer.
  const [sendingState, setSendingState] = useState<
    CommunicationProviderStatus["effectiveSendingState"] | undefined
  >(undefined);
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  // Counts the edits, so that a save can tell whether the author kept typing while its request was on the way.
  const edits = useRef(0);
  const saving = useRef(false);
  // False once the editor is closed. A request can finish after "Discard changes"; its result must not reach the page then, or the page would open the editor again.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const body = (draft.content.body[locale] ??
    draft.content.body.en) as TemplateBody;
  const estimate =
    estimated && estimated.version === draft.version ? estimated.item : null;

  const update = (
    change: (current: CommunicationItem) => CommunicationItem,
  ) => {
    edits.current += 1;
    setDraft(change);
    setDirty(true);
  };
  const patch = (next: Partial<CommunicationItem>) =>
    update((current) => ({ ...current, ...next }));
  // Editing the Icelandic text of a draft that has none yet starts from the English one.
  const patchBody = (next: TemplateBody) =>
    update((current) => ({
      ...current,
      content: {
        ...current.content,
        body: {
          ...current.content.body,
          [locale]: {
            ...(current.content.body[locale] ?? current.content.body.en),
            ...next,
          },
        },
      },
    }));
  const patchAudience = (next: Partial<CommunicationItem["audience"]>) =>
    update((current) => ({
      ...current,
      audience: { ...current.audience, ...next },
    }));
  const toggleCompany = (id: string) =>
    update((current) => {
      const chosen =
        current.audience.organizations === "all-customers"
          ? []
          : current.audience.organizations;
      return {
        ...current,
        audience: {
          ...current.audience,
          organizations: chosen.includes(id)
            ? chosen.filter((chosenId) => chosenId !== id)
            : [...chosen, id],
        },
      };
    });
  const patchSubject = (value: string) =>
    update((current) => ({
      ...current,
      content: {
        ...current.content,
        subject: { ...current.content.subject, [locale]: value },
      },
    }));

  /** Someone else saved first: take the draft as it is now, and say so, instead of overwriting their work. */
  async function resolveConflict() {
    try {
      const data = await apiFetch<{ item: CommunicationItem }>(
        `${API}/${draft.id}`,
      );
      if (!mounted.current) return;
      setDraft(data.item);
      setDirty(false);
      onSaved(data.item);
      if (data.item.status !== "Draft") {
        onToast(
          t("This communication is no longer a draft and cannot be edited."),
        );
        onClose();
        return;
      }
      onToast(
        t(
          "This communication was changed by someone else. The latest version is loaded: review it and make your changes again.",
        ),
      );
    } catch (error) {
      onToast(errorMessage(error));
    }
  }

  async function save(): Promise<CommunicationItem | null> {
    if (saving.current) return null;
    saving.current = true;
    setBusy(true);
    const seen = edits.current;
    try {
      const { templateKey, topic, title, content, audience } = draft;
      const data = await apiFetch<{ item: CommunicationItem }>(
        `${API}/${draft.id}`,
        {
          method: "PATCH",
          headers: mutationHeaders(true, draft.version),
          body: JSON.stringify({
            templateKey,
            topic,
            title,
            content,
            audience,
          }),
        },
      );
      // Closed meanwhile: nothing is left to update or to tell, and onSaved would reopen the editor.
      if (!mounted.current) return null;
      onSaved(data.item);
      if (seen !== edits.current) {
        // The server holds the text as it was when the request left, so only the version moves on; the author's newer text stays unsaved.
        setDraft((current) => ({ ...current, version: data.item.version }));
        onToast(
          t("Your latest changes were not saved yet. Save the draft again."),
        );
        return null;
      }
      setDraft(data.item);
      setDirty(false);
      return data.item;
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 412)
        await resolveConflict();
      else onToast(errorMessage(error));
      return null;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  // The numbers come from the saved draft, so they are asked for again whenever a save has given it a new version.
  useEffect(() => {
    if (step === "content") return;
    let current = true;
    apiFetch<{
      item: AudienceBreakdownItem;
      effectiveSendingState?: CommunicationProviderStatus["effectiveSendingState"];
    }>(`${API}/${draft.id}/audience`)
      .then((data) => {
        if (!current) return;
        setEstimated({ version: draft.version, item: data.item });
        setSendingState(data.effectiveSendingState);
      })
      .catch((error) => {
        if (current) onToast(errorMessage(error));
      });
    return () => {
      current = false;
    };
  }, [step, draft.id, draft.version, onToast]);

  // The preview is the saved draft in the language being edited.
  useEffect(() => {
    const controller = new AbortController();
    fetchPreview(draft.id, locale, controller.signal)
      .then((html) => {
        setPreviewHtml(html);
        setPreviewError("");
      })
      .catch((error) => {
        if (!controller.signal.aborted) setPreviewError(errorMessage(error));
      });
    return () => controller.abort();
  }, [draft.id, draft.version, locale]);

  async function goTo(next: Step) {
    if (next === step) return;
    if (dirty && !(await save())) return;
    setStep(next);
  }
  async function sendTest() {
    const saved = dirty ? await save() : draft;
    if (!saved) return;
    setBusy(true);
    try {
      await apiFetch<{ queued: number }>(`${API}/${saved.id}/test`, {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({ extraRecipients: [] }),
      });
      onToast(t("Test email queued to your address."));
    } catch (error) {
      onToast(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    const saved = dirty ? await save() : draft;
    if (!saved) {
      setDialog(null);
      return;
    }
    setBusy(true);
    try {
      const data = await apiFetch<{ item: CommunicationItem }>(
        `${API}/${saved.id}/send`,
        {
          method: "POST",
          headers: mutationHeaders(true, saved.version),
          // `scheduledAt` is left out to send now: an empty one is refused as a malformed schedule.
          body: JSON.stringify(
            scheduleAt
              ? { scheduledAt: new Date(scheduleAt).toISOString() }
              : {},
          ),
        },
      );
      onToast(
        data.item.status === "Scheduled"
          ? t("Communication scheduled.")
          : `${t("Sending started. Recipients:")} ${data.item.recipientCount}`,
      );
      onClose();
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 412)
        await resolveConflict();
      else onToast(errorMessage(error));
    } finally {
      setBusy(false);
      setDialog(null);
    }
  }
  const leave = () => (dirty ? setDialog("discard") : onClose());

  const customers = useMemo(
    () => companies.filter((company) => company.type !== "Internal"),
    [companies],
  );
  const selectedIds =
    draft.audience.organizations === "all-customers"
      ? null
      : draft.audience.organizations;
  const topicLabel = t(COMMUNICATION_TOPIC_LABELS[draft.topic]);
  const noIcelandic = locale === "is" && !draft.content.body.is;

  return (
    <div
      className="page-stack management-page communication-editor"
      data-tour="communications-editor"
    >
      <header className="communication-editor-head">
        <button
          className="icon-button"
          onClick={leave}
          aria-label={t("Back to communications")}
        >
          <Icon name="chevron" />
        </button>
        <div>
          <p className="eyebrow">
            {draft.id} · {t(COMMUNICATION_TEMPLATE_LABELS[draft.templateKey])} ·{" "}
            {topicLabel}
          </p>
          <input
            className="communication-title"
            value={draft.title}
            maxLength={200}
            onChange={(event) => patch({ title: event.target.value })}
            aria-label={t("Working title")}
          />
        </div>
        <div className="communication-editor-actions">
          <select
            value={locale}
            onChange={(event) => setLocale(event.target.value as Locale)}
            aria-label={t("Content language")}
          >
            <option value="en">English</option>
            <option value="is">Íslenska</option>
          </select>
          {noIcelandic && (
            <Button
              variant="ghost"
              onClick={() =>
                update((current) => ({
                  ...current,
                  content: {
                    ...current.content,
                    subject: {
                      ...current.content.subject,
                      is: current.content.subject.en,
                    },
                    body: {
                      ...current.content.body,
                      is: structuredClone(current.content.body.en),
                    },
                  },
                }))
              }
            >
              {t("Copy from English")}
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => void save()}
            disabled={busy || !dirty}
          >
            {dirty ? "Save draft" : "Saved"}
          </Button>
        </div>
      </header>
      <nav className="communication-steps" aria-label={t("Editor steps")}>
        {STEPS.map((entry, index) => (
          <button
            key={entry.id}
            type="button"
            className={step === entry.id ? "active" : ""}
            aria-current={step === entry.id ? "step" : undefined}
            disabled={busy}
            onClick={() => void goTo(entry.id)}
          >
            {index + 1}. {t(entry.label)}
          </button>
        ))}
      </nav>
      <div className="communication-editor-grid">
        <section className="communication-form">
          {step === "content" && (
            <>
              {noIcelandic && (
                <p className="communication-hint">
                  {t(
                    "There is no Icelandic version yet: recipients who prefer Icelandic get the English one. Copy it from English to start translating.",
                  )}
                </p>
              )}
              <Field
                label="Subject"
                hint={locale === "en" ? "Required" : undefined}
              >
                <input
                  value={draft.content.subject[locale] ?? ""}
                  maxLength={200}
                  placeholder={
                    locale === "is" ? draft.content.subject.en : undefined
                  }
                  onChange={(event) => patchSubject(event.target.value)}
                />
              </Field>
              <Field label="Topic">
                <select
                  value={draft.topic}
                  onChange={(event) =>
                    patch({
                      topic: event.target.value as CommunicationItem["topic"],
                    })
                  }
                >
                  {Object.entries(COMMUNICATION_TOPIC_LABELS).map(
                    ([key, label]) => (
                      <option key={key} value={key}>
                        {t(label)}
                      </option>
                    ),
                  )}
                </select>
              </Field>
              {draft.templateKey === "product-update" && (
                <ProductUpdateFields body={body} patchBody={patchBody} />
              )}
              {draft.templateKey === "service-notice" && (
                <ServiceNoticeFields body={body} patchBody={patchBody} />
              )}
              {draft.templateKey === "plain" && (
                <PlainFields body={body} patchBody={patchBody} />
              )}
            </>
          )}
          {step === "audience" && (
            <>
              <fieldset className="membership-editor">
                <legend>{t("Companies")}</legend>
                <label>
                  <input
                    type="radio"
                    name="communication-companies"
                    checked={selectedIds === null}
                    onChange={() =>
                      patchAudience({ organizations: "all-customers" })
                    }
                  />{" "}
                  {t("All customer and partner companies")}
                </label>
                <label>
                  <input
                    type="radio"
                    name="communication-companies"
                    checked={selectedIds !== null}
                    onChange={() => patchAudience({ organizations: [] })}
                  />{" "}
                  {t("Selected companies")}
                </label>
                {selectedIds !== null &&
                  customers.map((company) => (
                    <div
                      key={company.id}
                      className={
                        selectedIds.includes(company.id) ? "selected" : ""
                      }
                    >
                      <label>
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(company.id)}
                          onChange={() => toggleCompany(company.id)}
                        />
                        <span>
                          <strong>{company.name}</strong>
                          <small>
                            {t(company.status)} · {t(company.type)}
                          </small>
                        </span>
                      </label>
                    </div>
                  ))}
              </fieldset>
              {(
                [
                  [
                    "includeMembers",
                    "Active Pulse members of those companies (respecting their preferences)",
                  ],
                  [
                    "includeContacts",
                    "Communication contacts subscribed to this topic",
                  ],
                  ["includeOnboarding", "Include companies still onboarding"],
                  ["includeTestOrganizations", "Include test companies"],
                  [
                    "includeInternalCopy",
                    "Send a copy to the DataCentral team",
                  ],
                ] as const
              ).map(([key, label]) => (
                <label className="form-field demo-toggle" key={key}>
                  <input
                    type="checkbox"
                    checked={draft.audience[key]}
                    onChange={(event) =>
                      patchAudience({ [key]: event.target.checked })
                    }
                  />
                  <span>{t(label)}</span>
                </label>
              ))}
              <Field label="Member roles">
                <select
                  value={draft.audience.memberRoles?.join(",") ?? ""}
                  onChange={(event) =>
                    patchAudience({
                      memberRoles: event.target.value
                        ? (event.target.value.split(
                            ",",
                          ) as CommunicationItem["audience"]["memberRoles"])
                        : null,
                    })
                  }
                >
                  <option value="">{t("All roles")}</option>
                  <option value="Company admin">
                    {t("Company admins only")}
                  </option>
                  <option value="Company admin,Requester">
                    {t("Company admins and requesters")}
                  </option>
                </select>
              </Field>
              {estimate && <AudienceSummary estimate={estimate} />}
              {estimate && dirty && (
                <p className="communication-hint">
                  {t("Save the draft to update these numbers.")}
                </p>
              )}
            </>
          )}
          {step === "review" && (
            <>
              <dl className="communication-review">
                <dt>{t("Subject (English)")}</dt>
                <dd>{draft.content.subject.en || "—"}</dd>
                <dt>{t("Subject (Icelandic)")}</dt>
                <dd>
                  {draft.content.subject.is || t("falls back to English")}
                </dd>
                <dt>{t("Template · topic")}</dt>
                <dd>
                  {t(COMMUNICATION_TEMPLATE_LABELS[draft.templateKey])} ·{" "}
                  {topicLabel}
                </dd>
              </dl>
              {estimate && <AudienceSummary estimate={estimate} />}
              <SendingStateNotice state={sendingState} />
              <Field label="Schedule (optional, your local time)">
                <input
                  type="datetime-local"
                  value={scheduleAt}
                  onChange={(event) => setScheduleAt(event.target.value)}
                />
              </Field>
              <div className="communication-settings-actions">
                <Button
                  variant="secondary"
                  onClick={() => void sendTest()}
                  disabled={busy}
                >
                  {t("Send test to me")}
                </Button>
                <Button
                  onClick={() => setDialog("send")}
                  disabled={busy || !estimate || estimate.sendable === 0}
                  dataTour="communications-send"
                >
                  {scheduleAt ? t("Schedule") : t("Send now")}
                </Button>
              </div>
              {estimate && estimate.sendable === 0 && (
                <p className="communication-hint">
                  {t("Nobody matches this audience.")}
                </p>
              )}
            </>
          )}
        </section>
        <aside className="communication-preview">
          <div className="communication-preview-head">
            <strong>{t("Preview")}</strong>
            {dirty && (
              <small>{t("Save the draft to refresh the preview.")}</small>
            )}
          </div>
          {previewError && (
            <p className="form-error" role="alert">
              {t(previewError)}
            </p>
          )}
          <PreviewFrame html={previewHtml} title={t("Email preview")} />
        </aside>
      </div>
      {dialog === "send" && estimate && (
        <ModalDialog
          id="communication-confirm-title"
          title={
            scheduleAt
              ? t("Schedule this communication?")
              : t("Send this communication now?")
          }
          onClose={() => setDialog(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <dl className="communication-review">
              <dt>{t("Will receive")}</dt>
              <dd>{estimate.sendable}</dd>
              <dt>{t("Companies")}</dt>
              <dd>{estimate.organizations}</dd>
              {Object.entries(estimate.suppressed).map(([reason, count]) => (
                <Fragment key={reason}>
                  <dt>{t(SUPPRESSION_LABELS[reason] ?? reason)}</dt>
                  <dd>{count}</dd>
                </Fragment>
              ))}
              {scheduleAt && (
                <>
                  <dt>{t("Scheduled for")}</dt>
                  <dd>{new Date(scheduleAt).toLocaleString()}</dd>
                </>
              )}
            </dl>
            <SendingStateNotice state={sendingState} />
            <footer>
              <span>{t("Content and audience are frozen once sent.")}</span>
              <div>
                <Button variant="secondary" onClick={() => setDialog(null)}>
                  {t("Cancel")}
                </Button>
                <Button icon="send" type="submit" disabled={busy}>
                  {scheduleAt ? t("Schedule") : t("Send")}
                </Button>
              </div>
            </footer>
          </form>
        </ModalDialog>
      )}
      {dialog === "discard" && (
        <ModalDialog
          id="communication-discard-title"
          title={t("Discard unsaved changes?")}
          onClose={() => setDialog(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onClose();
            }}
          >
            <p className="communication-hint">
              {t("Your changes to this draft have not been saved.")}
            </p>
            <footer>
              <span />
              <div>
                <Button onClick={() => setDialog(null)}>
                  {t("Keep editing")}
                </Button>
                <Button variant="secondary" type="submit">
                  {t("Discard changes")}
                </Button>
              </div>
            </footer>
          </form>
        </ModalDialog>
      )}
    </div>
  );
}

/** The width the mail is laid out for: its table is 600 px and does not shrink, so a narrower pane would cut every line short. */
const MAIL_WIDTH = 600;

/**
 * The preview frame. The mail is shown as the source of a sandboxed frame (no scripts, forms or same-origin access); a pane narrower
 * than the mail shows it scaled down to fit, and the frame keeps its own vertical scroll.
 */
function PreviewFrame({ html, title }: { html: string; title: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const observer = new ResizeObserver(() =>
      setScale(Math.min(1, node.clientWidth / MAIL_WIDTH)),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="communication-preview-frame" ref={host}>
      <iframe
        title={title}
        sandbox=""
        srcDoc={html}
        style={
          scale < 1
            ? {
                width: MAIL_WIDTH,
                height: `${100 / scale}%`,
                transform: `scale(${scale})`,
              }
            : undefined
        }
      />
    </div>
  );
}

function AudienceSummary({ estimate }: { estimate: AudienceBreakdownItem }) {
  const t = useT();
  const left = Object.entries(estimate.suppressed).map(
    ([reason, count]) => `${t(SUPPRESSION_LABELS[reason] ?? reason)}: ${count}`,
  );
  return (
    <section className="admin-metric-grid communication-audience">
      <div>
        <span>{t("Companies")}</span>
        <strong>{estimate.organizations}</strong>
      </div>
      <div>
        <span>{t("Members")}</span>
        <strong>{estimate.members}</strong>
      </div>
      <div>
        <span>{t("Contacts")}</span>
        <strong>{estimate.contacts}</strong>
      </div>
      <div>
        <span>{t("Will receive")}</span>
        <strong>{estimate.sendable}</strong>
        <small>{left.join(" · ") || t("nothing suppressed")}</small>
      </div>
    </section>
  );
}

function SendingStateNotice({
  state,
}: {
  state: CommunicationProviderStatus["effectiveSendingState"] | undefined;
}) {
  const t = useT();
  if (!state || state === "live") return null;
  return (
    <p className="form-error" role="status">
      {t(
        state === "disabled"
          ? "Sending is disabled in Settings."
          : state === "provider-missing"
            ? "No SendGrid API key is configured."
            : state === "sandbox"
              ? "Sandbox mode: SendGrid will validate but not deliver."
              : "Safe mode: only allow-listed domains receive this communication.",
      )}
    </p>
  );
}
