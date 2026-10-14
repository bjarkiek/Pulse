"use client";
import { useState } from "react";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { ConfirmDialog } from "./communication-dialog";
import { ContactEditor, ContactImportDialog } from "./communication-contacts";
import { useResource } from "./use-resource";
import {
  Button,
  COMMUNICATION_TOPIC_LABELS,
  Status,
  useT,
  type ContactItem,
} from "./shared";

/** The company's own list: the server answers for the company the person is signed in to, so no organisation is named in a request. */
const ENDPOINT = "/api/v1/communications/contacts";

/**
 * "Who receives DataCentral communications for your company", on the Updates page: the people without a Pulse account that a Company
 * admin keeps on the company's list. Pulse members need no entry here, they receive communications as members.
 *
 * Only a Company admin of the active company gets an answer from the server. For anyone else the list is refused (a 404 is the normal
 * case), and the section is then not drawn at all, without an error: it was never meant for them.
 */
export function CompanyContactsSection({
  onToast,
}: {
  onToast: (message: string) => void;
}) {
  const t = useT();
  const list = useResource<{ items: ContactItem[] }>(ENDPOINT);
  const [editing, setEditing] = useState<ContactItem | "new" | "import" | null>(
    null,
  );
  // The recipient the open question ("Remove this recipient?") is about.
  const [removing, setRemoving] = useState<ContactItem | null>(null);
  const items = list.data?.items;
  if (!items) return null;

  async function remove(contact: ContactItem) {
    try {
      await apiFetch(`${ENDPOINT}/${contact.id}`, { method: "DELETE" });
      onToast(t("Contact removed."));
    } catch (error) {
      onToast(errorMessage(error));
    }
    // The question closes by itself when this is done; the list is read again whatever came of it.
    list.retry();
  }
  const closeDialog = () => {
    setEditing(null);
    list.retry();
  };

  return (
    <>
      <section
        className="company-contacts"
        aria-labelledby="company-contacts-title"
        data-tour="company-contacts"
      >
        <header>
          <div>
            <h3 id="company-contacts-title">
              {t("Who receives DataCentral communications for your company")}
            </h3>
            <p>
              {t(
                "Colleagues with a Pulse account receive updates automatically and manage their own preferences. Add people here who should receive product updates and notices without a Pulse account.",
              )}
            </p>
          </div>
          <div className="company-contacts-actions">
            <Button
              variant="secondary"
              icon="plus"
              onClick={() => setEditing("new")}
            >
              {t("Add recipient")}
            </Button>
            <Button variant="ghost" onClick={() => setEditing("import")}>
              {t("Paste list")}
            </Button>
          </div>
        </header>
        {list.error && (
          <p className="form-error communication-load-error" role="alert">
            <span>{t(list.error)}</span>
            <Button variant="secondary" onClick={list.retry}>
              {t("Retry")}
            </Button>
          </p>
        )}
        {items.length === 0 ? (
          <p className="communication-hint">
            {t("No additional recipients yet.")}
          </p>
        ) : (
          <div className="management-table contact-table">
            <div className="management-head">
              <span>{t("Recipient")}</span>
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
                <Status
                  tone={contact.status === "Active" ? "success" : "error"}
                >
                  {contact.status}
                </Status>
                <span>{t(contact.source)}</span>
                <span className="communication-row-actions">
                  <Button
                    variant="secondary"
                    onClick={() => setEditing(contact)}
                  >
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
      </section>
      {/* Beside the section, not inside it: the section's own rules for its rows must not reach the forms of the dialogs. */}
      {editing === "import" && (
        <ContactImportDialog
          endpoint={ENDPOINT}
          onClose={closeDialog}
          onToast={onToast}
        />
      )}
      {editing && editing !== "import" && (
        <ContactEditor
          contact={editing === "new" ? undefined : editing}
          endpoint={ENDPOINT}
          onClose={closeDialog}
          onToast={onToast}
        />
      )}
      {removing && (
        <ConfirmDialog
          id="company-contact-remove-title"
          title={t("Remove this recipient?")}
          keepLabel={t("Keep recipient")}
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
              "They stop receiving DataCentral communications for your company. Emails already sent are not recalled.",
            )}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
