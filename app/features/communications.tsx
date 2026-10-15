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
import {
  COMMUNICATION_STATUS_TONE,
  COMMUNICATION_TEMPLATE_LABELS,
} from "./communication-fields";
import { CommunicationDetail } from "./communication-detail";
import {
  CommunicationContactsTab,
  SuppressionsTab,
} from "./communication-contacts";
import { useResource } from "./use-resource";
import { ConfirmDialog } from "./communication-dialog";

type Tab = "campaigns" | "contacts" | "suppressions";
/**
 * `tour` is the anchor of a stop in the customer-communications tour. Its Recipients step highlights the Contacts tab, because the tab is on
 * the page whichever tab is open and the tour cannot switch one for the person: they click the highlighted tab, which opens its list and
 * carries the tour on (the next step is on this page too, so the list stays open).
 */
const TABS: Array<{ id: Tab; label: string; tour?: string }> = [
  { id: "campaigns", label: "Campaigns" },
  { id: "contacts", label: "Contacts", tour: "communications-contacts" },
  { id: "suppressions", label: "Suppressions" },
];
const API = "/api/v1/internal/communications";
const PARAM = "communication";

/**
 * What a new draft's English text says until the author replaces it. It is content, not interface, so it is English whatever language
 * the page is shown in (the draft's working title, a label for this list, is the one thing that is translated where it is made).
 */
const PLACEHOLDER = {
  title: "Untitled communication",
  announcement: "Write your announcement here.",
  notice: "Describe the notice here.",
  introduction: "Write the introduction here.",
  highlight: "First highlight",
  change: "Describe the change here.",
} as const;

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
  activeRole,
  onToast,
}: {
  companies: Company[];
  releases: ReleaseItem[];
  /** The role in the active company; Product managers and System admins may process the queue and archive. */
  activeRole: string;
  onToast: (message: string) => void;
}) {
  const t = useT();
  const canManage = activeRole === "Product manager" || activeRole === "System admin";
  // The communication being archived (confirmation open), and a guard so a second click does not start a second pass or archive.
  const [archiving, setArchiving] = useState<CommunicationItem | null>(null);
  const [processing, setProcessing] = useState(false);
  async function processQueue() {
    if (processing) return;
    setProcessing(true);
    try {
      const data = await apiFetch<{
        item: { skipped?: boolean; accepted: number; retried: number; deadLettered: number; completed: string[] };
      }>(`${API}/process`, { method: "POST", headers: mutationHeaders(false) });
      const r = data.item;
      onToast(
        r.skipped
          ? "Nothing was processed: sending is disabled in Settings."
          : `Queue processed: ${r.accepted} accepted, ${r.retried} to retry, ${r.deadLettered} failed.`,
      );
      reload();
    } catch (error) {
      onToast(errorMessage(error));
    } finally {
      setProcessing(false);
    }
  }
  const [tab, setTab] = useState<Tab>("campaigns");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<CommunicationItem | null>(null);
  const [creating, setCreating] = useState(false);
  // True while a copy is being made: a second click (on the list or on the detail) must not make a second copy.
  const [duplicating, setDuplicating] = useState(false);
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
          subject: { en: PLACEHOLDER.title },
          body: {
            en:
              templateKey === "plain"
                ? {
                    title: PLACEHOLDER.title,
                    paragraphs: [PLACEHOLDER.announcement],
                  }
                : templateKey === "service-notice"
                  ? {
                      title: PLACEHOLDER.title,
                      summary: PLACEHOLDER.notice,
                      actions: [],
                    }
                  : {
                      title: PLACEHOLDER.title,
                      intro: PLACEHOLDER.introduction,
                      sections: [
                        {
                          heading: PLACEHOLDER.highlight,
                          body: PLACEHOLDER.change,
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
    if (duplicating) return;
    setDuplicating(true);
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
    } finally {
      setDuplicating(false);
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
            {canManage && (
              <Button
                variant="ghost"
                disabled={processing}
                onClick={() => void processQueue()}
              >
                {processing ? t("Processing…") : t("Process queue now")}
              </Button>
            )}
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
            data-tour={entry.tour}
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
              // The empty state has no disabled look of its own, so a click while a draft is being created is ignored, like the buttons above.
              onAction={() => {
                if (!creating) void createDraft("product-update");
              }}
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
                  <Status tone={COMMUNICATION_STATUS_TONE[item.status]}>
                    {item.status}
                  </Status>
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
                      disabled={duplicating}
                      onClick={() => void duplicate(item)}
                    >
                      {t("Duplicate")}
                    </Button>
                    {canManage &&
                      ["Draft", "Sent", "Cancelled"].includes(item.status) && (
                        <Button
                          variant="ghost"
                          onClick={() => setArchiving(item)}
                        >
                          {t("Archive")}
                        </Button>
                      )}
                  </span>
                </div>
              ))}
            </div>
          )}
          {archiving && (
            <ConfirmDialog
              id="communication-archive-title"
              title={t("Archive this communication?")}
              keepLabel={t("Keep it")}
              confirmLabel={t("Archive")}
              onConfirm={async () => {
                const target = archiving;
                try {
                  await apiFetch(`${API}/${target.id}`, {
                    method: "DELETE",
                    headers: mutationHeaders(false),
                  });
                  onToast(`${target.id} was archived.`);
                  reload();
                } catch (error) {
                  onToast(errorMessage(error));
                }
                setArchiving(null);
              }}
              onClose={() => setArchiving(null)}
            >
              <p className="communication-confirm-subject">
                <strong>{archiving.id}</strong> · {archiving.title}
              </p>
              <p>
                {t(
                  "It leaves the list and cannot be opened again. Delivery records stay in the audit trail.",
                )}
              </p>
            </ConfirmDialog>
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
