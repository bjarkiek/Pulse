"use client";
import { useEffect, useState } from "react";
import { ApiFailure, apiFetch, errorMessage } from "@/lib/api-client";
import {
  Button,
  EmptyState,
  PageIntro,
  Status,
  mutationHeaders,
  useT,
  type CommunicationItem,
  type Company,
  type ReleaseItem,
} from "./shared";
import { CommunicationEditor } from "./communication-editor";
import { COMMUNICATION_TEMPLATE_LABELS } from "./communication-fields";
import { CommunicationDetail } from "./communication-detail";
import {
  CommunicationContactsTab,
  SuppressionsTab,
} from "./communication-contacts";
import { useResource } from "./use-resource";

type Tab = "campaigns" | "contacts" | "suppressions";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "campaigns", label: "Campaigns" },
  { id: "contacts", label: "Contacts" },
  { id: "suppressions", label: "Suppressions" },
];
const STATUS_TONE = {
  Draft: "neutral",
  Scheduled: "warning",
  Sending: "violet",
  Sent: "success",
  Cancelled: "error",
} as const;
const API = "/api/v1/internal/communications";
const PARAM = "communication";

const readParam = () =>
  typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get(PARAM);

/** `?communication=COM-###`: the communication to open straight away (the Releases page hands a new draft over this way). */
export function useCommunicationQueryParam() {
  const [id, setId] = useState<string | null>(readParam);
  useEffect(() => {
    const sync = () => setId(readParam());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  return id;
}

/** The address is spent once the communication is open: the shell's navigation keeps the parameter, and it must not reopen the item later. */
function forgetParam() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(PARAM)) return;
  url.searchParams.delete(PARAM);
  window.history.replaceState({}, "", url);
}

/** A time from the server (UTC) as `2026-11-02 14:30`. */
const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

export function CommunicationsPage({
  companies,
  releases,
  onToast,
}: {
  companies: Company[];
  releases: ReleaseItem[];
  onToast: (message: string) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("campaigns");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<CommunicationItem | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useResource<{ items: CommunicationItem[] }>(API);
  const items = list.data?.items;
  const reload = list.retry;
  const requested = useCommunicationQueryParam();
  useEffect(() => {
    if (!requested) return;
    let current = true;
    apiFetch<{ item: CommunicationItem }>(
      `${API}/${encodeURIComponent(requested)}`,
    )
      .then((data) => {
        if (!current) return;
        if (data.item.status === "Draft") setEditing(data.item);
        else setSelectedId(data.item.id);
      })
      .catch((error) => {
        // The toast is translated where it is shown, like every message the page passes up.
        if (current)
          onToast(
            error instanceof ApiFailure && error.status === 404
              ? "That communication could not be found."
              : errorMessage(error),
          );
      })
      .finally(() => {
        if (current) forgetParam();
      });
    return () => {
      current = false;
    };
  }, [requested, onToast]);

  async function createDraft(templateKey: CommunicationItem["templateKey"]) {
    setCreating(true);
    try {
      const topic =
        templateKey === "product-update"
          ? "product-updates"
          : templateKey === "service-notice"
            ? "service-notices"
            : "general";
      const body = {
        templateKey,
        topic,
        title: t("Untitled communication"),
        // Placeholders satisfy the content schema's min(1) fields; authors replace them in the editor.
        content: {
          subject: { en: t("Untitled communication") },
          body: {
            en:
              templateKey === "plain"
                ? {
                    title: t("Untitled communication"),
                    paragraphs: [t("Write your announcement here.")],
                  }
                : templateKey === "service-notice"
                  ? {
                      title: t("Untitled communication"),
                      summary: t("Describe the notice here."),
                      actions: [],
                    }
                  : {
                      title: t("Untitled communication"),
                      intro: t("Write the introduction here."),
                      sections: [
                        {
                          heading: t("First highlight"),
                          body: t("Describe the change here."),
                        },
                      ],
                    },
          },
        },
        audience: {
          organizations: "all-customers",
          includeOnboarding: false,
          includeTestOrganizations: false,
          includeMembers: true,
          memberRoles: null,
          includeContacts: true,
          includeInternalCopy: false,
        },
      };
      const data = await apiFetch<{ item: CommunicationItem }>(API, {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify(body),
      });
      setEditing(data.item);
    } catch (error) {
      onToast(errorMessage(error));
    } finally {
      setCreating(false);
    }
  }
  async function duplicate(item: CommunicationItem) {
    try {
      const data = await apiFetch<{ item: CommunicationItem }>(
        `${API}/${item.id}/duplicate`,
        { method: "POST", headers: mutationHeaders(false) },
      );
      reload();
      setSelectedId(null);
      setEditing(data.item);
    } catch (error) {
      onToast(errorMessage(error));
    }
  }

  if (editing)
    return (
      <CommunicationEditor
        key={editing.id}
        item={editing}
        companies={companies}
        onClose={() => {
          setEditing(null);
          reload();
        }}
        onSaved={setEditing}
        onToast={onToast}
      />
    );
  if (selectedId)
    return (
      <CommunicationDetail
        id={selectedId}
        companies={companies}
        onBack={() => {
          setSelectedId(null);
          reload();
        }}
        onEdit={(item) => {
          setSelectedId(null);
          setEditing(item);
        }}
        onDuplicate={duplicate}
        onToast={onToast}
      />
    );
  return (
    <div className="page-stack management-page" data-tour="communications-page">
      <PageIntro
        eyebrow="Customer communication"
        title="Communications"
        description="Compose branded product updates and notices, choose the companies that receive them, and track delivery."
        action={
          <div className="communication-new">
            <Button
              icon="plus"
              dataTour="communications-new"
              disabled={creating}
              onClick={() => void createDraft("product-update")}
            >
              {t("New product update")}
            </Button>
            <Button
              variant="secondary"
              disabled={creating}
              onClick={() => void createDraft("service-notice")}
            >
              {t("Service notice")}
            </Button>
            <Button
              variant="secondary"
              disabled={creating}
              onClick={() => void createDraft("plain")}
            >
              {t("Announcement")}
            </Button>
          </div>
        }
      />
      <div className="communication-tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={tab === entry.id ? "active" : ""}
            onClick={() => setTab(entry.id)}
          >
            {t(entry.label)}
          </button>
        ))}
      </div>
      {tab === "contacts" && (
        <CommunicationContactsTab companies={companies} onToast={onToast} />
      )}
      {tab === "suppressions" && <SuppressionsTab onToast={onToast} />}
      {tab === "campaigns" && (
        <>
          {list.error && (
            <p className="form-error communication-load-error" role="alert">
              <span>{t(list.error)}</span>
              <Button variant="secondary" onClick={list.retry}>
                {t("Retry")}
              </Button>
            </p>
          )}
          {!items && !list.error && (
            <p className="communication-hint" role="status">
              {t("Loading…")}
            </p>
          )}
          {items && items.length === 0 && (
            <EmptyState
              title="No communications yet"
              description="Start with a product update, a service notice or a plain announcement."
              action="New product update"
              onAction={() => void createDraft("product-update")}
            />
          )}
          {items && items.length > 0 && (
            <div className="management-table communication-table">
              <div className="management-head">
                <span>{t("Communication")}</span>
                <span>{t("Template")}</span>
                <span>{t("Status")}</span>
                <span>{t("Recipients")}</span>
                <span>{t("Sent")}</span>
                <span />
              </div>
              {items.map((item) => (
                <div className="management-row" key={item.id}>
                  <span className="record-name">
                    <span>
                      <strong>{item.title}</strong>
                      <code>
                        {item.id}
                        {item.releaseId ? ` · ${item.releaseId}` : ""}
                      </code>
                    </span>
                  </span>
                  <span>
                    {t(COMMUNICATION_TEMPLATE_LABELS[item.templateKey])}
                  </span>
                  <Status tone={STATUS_TONE[item.status]}>{item.status}</Status>
                  <span>
                    {/* A scheduled communication freezes its audience when it starts to send, so until then there is no count. */}
                    {item.status === "Draft" || item.status === "Scheduled"
                      ? "—"
                      : item.recipientCount}
                  </span>
                  <span>
                    {item.completedAt
                      ? when(item.completedAt)
                      : item.scheduledAt
                        ? `${t("Scheduled")} ${when(item.scheduledAt)}`
                        : "—"}
                  </span>
                  <span className="communication-row-actions">
                    <Button
                      variant="secondary"
                      onClick={() =>
                        item.status === "Draft"
                          ? setEditing(item)
                          : setSelectedId(item.id)
                      }
                    >
                      {item.status === "Draft" ? t("Edit") : t("Open")}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => void duplicate(item)}
                    >
                      {t("Duplicate")}
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          )}
          {releases.some((release) => release.published) && (
            <p className="communication-release-hint">
              {t(
                "Tip: published releases offer “Draft customer email” on the Releases page.",
              )}
            </p>
          )}
        </>
      )}
    </div>
  );
}
