"use client";
import { useEffect, useState, type FormEvent } from "react";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { ConfirmDialog } from "./communication-dialog";
import { useResource } from "./use-resource";
import {
  Button,
  COMMUNICATION_TOPIC_LABELS,
  Icon,
  Status,
  useT,
  type Company,
  type ContactItem,
  type SuppressionItem,
} from "./shared";

const API = "/api/v1/internal/communications";
const TOPICS = Object.keys(COMMUNICATION_TOPIC_LABELS);
/** What a new contact is subscribed to until the person says otherwise. */
const DEFAULT_TOPICS = ["product-updates", "service-notices"];
/** How many skipped lines an import names in its notice: a pasted list of nonsense must not fill the screen. */
const SKIPPED_SHOWN = 10;

export function CommunicationContactsTab({
  companies,
  onToast,
}: {
  companies: Company[];
  onToast: (message: string) => void;
}) {
  const t = useT();
  const customers = companies.filter((company) => company.type !== "Internal");
  // The company the person picked, as long as it is still one; else the first customer company. The companies arrive after the page is
  // drawn, so the first one cannot be chosen once, at the start.
  const [picked, setPicked] = useState("");
  const organizationId = customers.some((company) => company.id === picked)
    ? picked
    : (customers[0]?.id ?? "");
  const [editing, setEditing] = useState<ContactItem | "new" | "import" | null>(
    null,
  );
  // The contact the open question ("Remove this contact?") is about.
  const [removing, setRemoving] = useState<ContactItem | null>(null);
  const [reload, setReload] = useState(0);
  // The answer for one company: it is shown only while that company is the one chosen, so a list is never shown under another's name.
  const [loaded, setLoaded] = useState<{
    organizationId: string;
    items: ContactItem[] | null;
    error: string;
  } | null>(null);
  const current = loaded?.organizationId === organizationId ? loaded : null;
  const items = current?.items ?? null;

  useEffect(() => {
    // Without a company there is nothing to ask for: an empty organizationId is refused by the server.
    if (!organizationId) return;
    const controller = new AbortController();
    apiFetch<{ items: ContactItem[] }>(
      `${API}/contacts?organizationId=${encodeURIComponent(organizationId)}`,
      { signal: controller.signal },
    )
      .then((data) =>
        setLoaded({ organizationId, items: data.items, error: "" }),
      )
      .catch((error) => {
        if (controller.signal.aborted) return;
        setLoaded((previous) => ({
          organizationId,
          items:
            previous?.organizationId === organizationId ? previous.items : null,
          error: errorMessage(error),
        }));
      });
    return () => controller.abort();
  }, [organizationId, reload]);

  const refresh = () => setReload((count) => count + 1);
  async function remove(contact: ContactItem) {
    try {
      await apiFetch(`${API}/contacts/${contact.id}`, { method: "DELETE" });
      onToast(t("Contact removed."));
    } catch (error) {
      onToast(errorMessage(error));
    }
    refresh();
    setRemoving(null);
  }
  const closeDialog = () => {
    setEditing(null);
    refresh();
  };

  return (
    <section className="page-stack" data-tour="communications-contacts">
      <div className="management-toolbar">
        <label className="select-wrap">
          <Icon name="building" size={15} />
          <select
            value={organizationId}
            onChange={(event) => setPicked(event.target.value)}
            aria-label={t("Company")}
          >
            {customers.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </select>
        </label>
        <span>
          {items?.length ?? 0} {t("contacts")}
        </span>
        <Button
          variant="secondary"
          icon="plus"
          disabled={!organizationId}
          onClick={() => setEditing("new")}
        >
          {t("Add contact")}
        </Button>
        <Button
          variant="ghost"
          disabled={!organizationId}
          onClick={() => setEditing("import")}
        >
          {t("Paste list")}
        </Button>
      </div>
      <p className="communication-release-hint">
        {t(
          "Pulse members of this company receive communications automatically and manage their own preferences; add people here who are not Pulse users.",
        )}
      </p>
      {current?.error && (
        <p className="form-error communication-load-error" role="alert">
          <span>{t(current.error)}</span>
          <Button variant="secondary" onClick={refresh}>
            {t("Retry")}
          </Button>
        </p>
      )}
      {items?.length === 0 && (
        <p className="communication-hint">
          {t("This company has no contacts yet.")}
        </p>
      )}
      {items && items.length > 0 && (
        <div className="management-table contact-table">
          <div className="management-head">
            <span>{t("Contact")}</span>
            <span>{t("Language")}</span>
            <span>{t("Topics")}</span>
            <span>{t("Status")}</span>
            <span>{t("Source")}</span>
            <span />
          </div>
          {items.map((contact) => (
            <div className="management-row" key={contact.id}>
              <span className="record-name">
                <span>
                  <strong>{contact.displayName}</strong>
                  <code>{contact.email}</code>
                </span>
              </span>
              <span>{contact.locale === "is" ? "Íslenska" : "English"}</span>
              <span className="membership-tags">
                {contact.topics.map((topic) => (
                  <span key={topic}>
                    {t(COMMUNICATION_TOPIC_LABELS[topic] ?? topic)}
                  </span>
                ))}
              </span>
              <Status tone={contact.status === "Active" ? "success" : "error"}>
                {contact.status}
              </Status>
              <span>{t(contact.source)}</span>
              <span className="communication-row-actions">
                <Button variant="secondary" onClick={() => setEditing(contact)}>
                  {t("Edit")}
                </Button>
                <Button variant="ghost" onClick={() => setRemoving(contact)}>
                  {t("Remove")}
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}
      {editing === "import" && (
        <ContactImportDialog
          endpoint={`${API}/contacts`}
          organizationId={organizationId}
          onClose={closeDialog}
          onToast={onToast}
        />
      )}
      {editing && editing !== "import" && (
        <ContactEditor
          contact={editing === "new" ? undefined : editing}
          endpoint={`${API}/contacts`}
          organizationId={organizationId}
          onClose={closeDialog}
          onToast={onToast}
        />
      )}
      {removing && (
        <ConfirmDialog
          id="contact-remove-title"
          title={t("Remove this contact?")}
          keepLabel={t("Keep contact")}
          confirmLabel={t("Remove")}
          onConfirm={() => remove(removing)}
          onClose={() => setRemoving(null)}
        >
          <p className="communication-confirm-subject">
            <strong>{removing.displayName}</strong>{" "}
            <code>{removing.email}</code>
          </p>
          <p>
            {t(
              "The contact stops receiving communications for this company. Earlier deliveries stay in their campaigns.",
            )}
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}

/** Shared by the internal tab and the customer section (Task 17): `endpoint` differs, the body shape is the same except organizationId. */
export function ContactEditor({
  contact,
  endpoint,
  organizationId,
  onClose,
  onToast,
}: {
  contact?: ContactItem;
  endpoint: string;
  organizationId?: string;
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  const t = useT();
  const [displayName, setDisplayName] = useState(contact?.displayName ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [locale, setLocale] = useState<"en" | "is">(contact?.locale ?? "en");
  const [topics, setTopics] = useState<string[]>(
    contact?.topics ?? DEFAULT_TOPICS,
  );
  const [note, setNote] = useState(contact?.note ?? "");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await apiFetch(contact ? `${endpoint}/${contact.id}` : endpoint, {
        method: contact ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(organizationId ? { organizationId } : {}),
          displayName,
          email,
          locale,
          topics,
          note: note || undefined,
        }),
      });
      onToast(contact ? t("Contact updated.") : t("Contact added."));
      onClose();
    } catch (error) {
      onToast(errorMessage(error));
    } finally {
      setBusy(false);
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
        className="management-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="contact-editor-title"
      >
        <header>
          <div>
            <p className="eyebrow">{t("Communication contact")}</p>
            <h2 id="contact-editor-title">
              {contact
                ? `${t("Edit")} ${contact.displayName}`
                : t("Add contact")}
            </h2>
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
          <div className="form-grid">
            <label className="form-field">
              <span>
                {t("Full name")}
                <em>{t("Required")}</em>
              </span>
              <input
                value={displayName}
                maxLength={200}
                onChange={(event) => setDisplayName(event.target.value)}
                required
              />
            </label>
            <label className="form-field">
              <span>
                {t("Email address")}
                <em>{t("Required")}</em>
              </span>
              <input
                type="email"
                value={email}
                maxLength={320}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label className="form-field">
              <span>{t("Language")}</span>
              <select
                value={locale}
                onChange={(event) =>
                  setLocale(event.target.value as "en" | "is")
                }
              >
                <option value="en">English</option>
                <option value="is">Íslenska</option>
              </select>
            </label>
            <label className="form-field">
              <span>{t("Note")}</span>
              <input
                value={note}
                maxLength={500}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
          </div>
          <TopicChoice topics={topics} onChange={setTopics} />
          <footer>
            <span>{t("At least one topic is required.")}</span>
            <div>
              <Button variant="secondary" onClick={onClose}>
                {t("Cancel")}
              </Button>
              <Button
                type="submit"
                icon="check"
                disabled={
                  busy || !displayName.trim() || !email.trim() || !topics.length
                }
              >
                {t("Save contact")}
              </Button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function ContactImportDialog({
  endpoint,
  organizationId,
  onClose,
  onToast,
}: {
  endpoint: string;
  organizationId?: string;
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  const t = useT();
  const [lines, setLines] = useState("");
  const [topics, setTopics] = useState<string[]>(DEFAULT_TOPICS);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await apiFetch<{
        created: unknown[];
        skipped: Array<{ line: number; reason: string }>;
      }>(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(organizationId ? { organizationId } : {}),
          lines,
          topics,
        }),
      });
      // Label, colon, number: the sentence reads the same in Icelandic, whatever the count.
      const added = `${t("Contacts added:")} ${result.created.length}.`;
      const skipped = result.skipped.map((entry) => entry.line);
      const named = skipped.slice(0, SKIPPED_SHOWN).join(", ");
      onToast(
        skipped.length
          ? `${added} ${t("Lines skipped:")} ${named}${skipped.length > SKIPPED_SHOWN ? ", …" : ""}.`
          : added,
      );
      onClose();
    } catch (error) {
      onToast(errorMessage(error));
    } finally {
      setBusy(false);
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
        className="management-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="contact-import-title"
      >
        <header>
          <div>
            <p className="eyebrow">{t("Paste list")}</p>
            <h2 id="contact-import-title">{t("Add several contacts")}</h2>
            <p>
              {t(
                "One per line: Name, email — or just the email. Up to 250 lines.",
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
          <label className="form-field">
            <span>{t("Lines")}</span>
            <textarea
              rows={8}
              value={lines}
              maxLength={16000}
              onChange={(event) => setLines(event.target.value)}
              placeholder={"Anna Jónsdóttir, anna@example.is\nbjorn@example.is"}
            />
          </label>
          <TopicChoice topics={topics} onChange={setTopics} />
          <footer>
            <span />
            <div>
              <Button variant="secondary" onClick={onClose}>
                {t("Cancel")}
              </Button>
              <Button
                type="submit"
                icon="check"
                disabled={busy || !lines.trim() || !topics.length}
              >
                {t("Add contacts")}
              </Button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}

/** The topics a contact receives: one checkbox for each, and the server wants at least one. */
function TopicChoice({
  topics,
  onChange,
}: {
  topics: string[];
  onChange: (topics: string[]) => void;
}) {
  const t = useT();
  return (
    <fieldset className="auth-choice">
      <legend>{t("Topics")}</legend>
      {TOPICS.map((topic) => (
        <label key={topic}>
          <input
            type="checkbox"
            checked={topics.includes(topic)}
            onChange={() =>
              onChange(
                topics.includes(topic)
                  ? topics.filter((chosen) => chosen !== topic)
                  : [...topics, topic],
              )
            }
          />
          <span>
            <strong>{t(COMMUNICATION_TOPIC_LABELS[topic])}</strong>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function SuppressionsTab({
  onToast,
}: {
  onToast: (message: string) => void;
}) {
  const t = useT();
  const list = useResource<{ items: SuppressionItem[] }>(`${API}/suppressions`);
  const items = list.data?.items;
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // The suppression the open question ("Remove this suppression?") is about.
  const [removing, setRemoving] = useState<SuppressionItem | null>(null);
  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await apiFetch(`${API}/suppressions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, note: note || undefined }),
      });
      setEmail("");
      setNote("");
      onToast(t("Address suppressed."));
      list.retry();
    } catch (error) {
      onToast(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function remove(item: SuppressionItem) {
    try {
      await apiFetch(`${API}/suppressions`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: item.email }),
      });
      onToast(t("Suppression removed."));
    } catch (error) {
      onToast(errorMessage(error));
    }
    list.retry();
    setRemoving(null);
  }
  return (
    <section className="page-stack" data-tour="communications-suppressions">
      <p className="communication-release-hint">
        {t(
          "Suppressed addresses never receive communications, whatever company or list they are on. Bounces, spam reports and unsubscribes arrive here automatically from SendGrid.",
        )}
      </p>
      <form
        className="management-toolbar communication-suppress-form"
        onSubmit={add}
      >
        <input
          type="email"
          value={email}
          maxLength={320}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="name@company.com"
          required
          aria-label={t("Email address")}
        />
        <input
          value={note}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
          placeholder={t("Reason (optional)")}
          aria-label={t("Note")}
        />
        <Button
          type="submit"
          variant="secondary"
          icon="plus"
          disabled={busy || !email.trim()}
        >
          {t("Suppress address")}
        </Button>
      </form>
      {list.error && (
        <p className="form-error communication-load-error" role="alert">
          <span>{t(list.error)}</span>
          <Button variant="secondary" onClick={list.retry}>
            {t("Retry")}
          </Button>
        </p>
      )}
      {items?.length === 0 && (
        <p className="communication-hint">
          {t("No addresses are suppressed.")}
        </p>
      )}
      {items && items.length > 0 && (
        <div className="management-table suppression-table">
          <div className="management-head">
            <span>{t("Email address")}</span>
            <span>{t("Reason")}</span>
            <span>{t("Source")}</span>
            <span>{t("Since")}</span>
            <span />
          </div>
          {items.map((item) => (
            <div className="management-row" key={item.email}>
              <span>
                <code>{item.email}</code>
              </span>
              <span>
                {item.reason}
                {item.note ? ` · ${item.note}` : ""}
              </span>
              <span>{t(item.source)}</span>
              <span>{item.createdAt.slice(0, 10)}</span>
              <span className="communication-row-actions">
                <Button variant="ghost" onClick={() => setRemoving(item)}>
                  {t("Remove")}
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}
      {removing && (
        <ConfirmDialog
          id="suppression-remove-title"
          title={t("Remove this suppression?")}
          keepLabel={t("Keep suppression")}
          confirmLabel={t("Remove")}
          onConfirm={() => remove(removing)}
          onClose={() => setRemoving(null)}
        >
          <p className="communication-confirm-subject">
            <code>{removing.email}</code>
          </p>
          <p>
            {t(
              "The address can receive communications again, and the contacts with it become active again. If it bounces or unsubscribes again, SendGrid reports it and it is suppressed again.",
            )}
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
