"use client";
import { useState } from "react";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { ConfirmDialog } from "./communication-dialog";
import {
  COMMUNICATION_STATUS_TONE,
  COMMUNICATION_TEMPLATE_LABELS,
} from "./communication-fields";
import { useResource } from "./use-resource";
import {
  Button,
  Icon,
  Status,
  mutationHeaders,
  useT,
  type CommunicationItem,
  type Company,
  type DeliveryItem,
  type Tone,
} from "./shared";

const API = "/api/v1/internal/communications";
const POLL_MS = 15000;
const PAGE_SIZE = 100;

/** The tone of each state a recipient's mail can be in. The keys are also the choices of the state filter. */
const DELIVERY_TONE: Record<string, Tone> = {
  Delivered: "success",
  Accepted: "violet",
  Deferred: "warning",
  Queued: "neutral",
  Retry: "warning",
  Processing: "violet",
  Bounced: "error",
  Dropped: "error",
  "Dead letter": "error",
  Suppressed: "neutral",
  Cancelled: "neutral",
};

/** A time from the server (UTC) as `2026-11-02 14:30`. */
const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

export function CommunicationDetail({
  id,
  companies,
  onBack,
  onEdit,
  onDuplicate,
  onToast,
}: {
  id: string;
  companies: Company[];
  onBack: () => void;
  onEdit: (item: CommunicationItem) => void;
  onDuplicate: (item: CommunicationItem) => void;
  onToast: (message: string) => void;
}) {
  const t = useT();
  const [state, setState] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [page, setPage] = useState(1);
  // True while one of the header's actions is on its way: the buttons wait, so a second click cannot send it twice.
  const [busy, setBusy] = useState(false);
  // The version of the communication that the open question (cancel sending, unschedule) is about. The question goes away with that version:
  // once the communication has moved on it is a different question, and one that was not asked.
  const [confirming, setConfirming] = useState<{
    version: string | undefined;
  } | null>(null);
  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
  });
  if (state) query.set("state", state);
  if (organizationId) query.set("organizationId", organizationId);
  const item = useResource<{ item: CommunicationItem }>(
    `${API}/${id}`,
    POLL_MS,
  );
  const deliveries = useResource<{ items: DeliveryItem[]; total: number }>(
    `${API}/${id}/deliveries?${query}`,
    POLL_MS,
  );
  const name = (orgId: string | null) =>
    companies.find((company) => company.id === orgId)?.name ?? orgId ?? "—";
  const refresh = () => {
    item.retry();
    deliveries.retry();
  };

  /** Runs one of the header's actions. The view is read again whatever came of it: a refusal usually means it was out of date. */
  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      onToast(errorMessage(error));
    } finally {
      setBusy(false);
      refresh();
    }
  }
  const cancel = (record: CommunicationItem) =>
    run(async () => {
      await apiFetch(`${API}/${id}/cancel`, {
        method: "POST",
        headers: mutationHeaders(true, record.version),
        body: JSON.stringify({
          mode: record.status === "Scheduled" ? "unschedule" : "cancel",
        }),
      });
    });
  /** Queues the recipients that ran out of attempts again, and says what became of them. */
  const retryDeadLetters = () =>
    run(async () => {
      const result = await apiFetch<{ requeued: number; reopened: boolean }>(
        `${API}/${id}/deliveries/retry`,
        { method: "POST", headers: mutationHeaders(false) },
      );
      if (result.requeued === 0) {
        onToast(
          t("Nothing was requeued: no recipient had run out of attempts."),
        );
        return;
      }
      const queued = `${t("Recipients queued again:")} ${result.requeued}.`;
      // A communication that had completed is sending again: the worker picks the recipients up on its next run.
      onToast(
        result.reopened
          ? `${queued} ${t("The communication was reopened and is sending again.")}`
          : queued,
      );
    });

  const record = item.data?.item;
  const back = (
    <button
      className="icon-button"
      onClick={onBack}
      aria-label={t("Back to communications")}
    >
      <Icon name="chevron" />
    </button>
  );
  // Without the communication there is nothing to act on, but the way back must stay.
  if (!record)
    return (
      <div className="page-stack management-page">
        <header className="communication-editor-head">
          {back}
          {item.error ? (
            <p className="form-error communication-load-error" role="alert">
              <span>{t(item.error)}</span>
              <Button variant="secondary" onClick={item.retry}>
                {t("Retry")}
              </Button>
            </p>
          ) : (
            <p className="communication-hint" role="status">
              {t("Loading…")}
            </p>
          )}
        </header>
      </div>
    );

  const stats = record.stats;
  // A draft or a scheduled communication has not started: its audience is fixed when sending starts, so there is nothing to count yet (the list shows a dash for the same reason). Only test mails can be on it.
  const started = record.status !== "Draft" && record.status !== "Scheduled";
  const tiles: Array<[string, number]> = stats
    ? [
        ["Recipients", stats.recipients],
        ["Queued", stats.queued],
        ["Accepted", stats.accepted],
        ["Delivered", stats.delivered],
        ["Opened", stats.opened],
        ["Clicked", stats.clicked],
        ["Bounced", stats.bounced + stats.dropped],
        ["Dead letter", stats.deadLettered],
        ["Suppressed", stats.suppressed],
      ]
    : [];
  // Only a communication that was stopped has these; without them its tiles would not add up to its recipients.
  if (stats && stats.cancelled > 0) tiles.push(["Cancelled", stats.cancelled]);
  // A scheduled communication says when it goes out, as the list does.
  const statusText =
    record.status === "Scheduled" && record.scheduledAt
      ? `${t("Scheduled")} ${when(record.scheduledAt)}`
      : record.status;
  // A scheduled communication is taken back to a draft; one that is sending is stopped for good.
  const unschedule = record.status === "Scheduled";
  const rows = deliveries.data?.items ?? [];
  const total = deliveries.data?.total ?? 0;
  const first = (page - 1) * PAGE_SIZE + 1;
  return (
    <div
      className="page-stack management-page"
      data-tour="communications-detail"
    >
      <header className="communication-editor-head">
        {back}
        <div>
          <p className="eyebrow">
            {record.id} · {t(COMMUNICATION_TEMPLATE_LABELS[record.templateKey])}{" "}
            · {record.createdBy}
          </p>
          <h2>{record.title}</h2>
        </div>
        <div className="communication-editor-actions">
          <Status tone={COMMUNICATION_STATUS_TONE[record.status]}>
            {statusText}
          </Status>
          {record.status === "Draft" && (
            <Button onClick={() => onEdit(record)}>{t("Edit")}</Button>
          )}
          {(record.status === "Scheduled" || record.status === "Sending") && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setConfirming({ version: record.version })}
            >
              {unschedule ? t("Unschedule") : t("Cancel sending")}
            </Button>
          )}
          {/* A cancelled communication never sends again, so the server refuses to queue its recipients. */}
          {record.status !== "Cancelled" && stats && stats.deadLettered > 0 && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void retryDeadLetters()}
            >
              {t("Retry dead letters")}
            </Button>
          )}
          <Button variant="ghost" onClick={() => onDuplicate(record)}>
            {t("Duplicate")}
          </Button>
        </div>
      </header>
      {stats && started && (
        <section className="admin-metric-grid communication-stats">
          {tiles.map(([label, value]) => (
            <div key={label}>
              <span>{t(label)}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </section>
      )}
      {stats && started && stats.byOrganization.length > 0 && (
        <div className="management-table communication-org-table">
          <div className="management-head">
            <span>{t("Company")}</span>
            <span>{t("Recipients")}</span>
            <span>{t("Delivered")}</span>
            <span>{t("Opened")}</span>
          </div>
          {stats.byOrganization.map((row) => (
            <div className="management-row" key={row.organizationId}>
              <span>{name(row.organizationId)}</span>
              <span>{row.recipients}</span>
              <span>{row.delivered}</span>
              <span>{row.opened}</span>
            </div>
          ))}
        </div>
      )}
      <div className="management-toolbar">
        <label className="select-wrap">
          <Icon name="filter" size={15} />
          <select
            value={state}
            onChange={(event) => {
              setState(event.target.value);
              setPage(1);
            }}
            aria-label={t("Filter by state")}
          >
            <option value="">{t("All states")}</option>
            {Object.keys(DELIVERY_TONE).map((entry) => (
              <option key={entry} value={entry}>
                {t(entry)}
              </option>
            ))}
          </select>
        </label>
        <label className="select-wrap">
          <Icon name="building" size={15} />
          <select
            value={organizationId}
            onChange={(event) => {
              setOrganizationId(event.target.value);
              setPage(1);
            }}
            aria-label={t("Filter by company")}
          >
            <option value="">{t("All companies")}</option>
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </select>
        </label>
        <span>
          {total} {t("recipients")}
        </span>
      </div>
      {deliveries.error && (
        <p className="form-error communication-load-error" role="alert">
          <span>{t(deliveries.error)}</span>
          <Button variant="secondary" onClick={deliveries.retry}>
            {t("Retry")}
          </Button>
        </p>
      )}
      {deliveries.data && rows.length === 0 && (
        <p className="communication-hint">
          {started
            ? t("No recipients to show.")
            : t("Recipients are chosen when sending starts.")}
        </p>
      )}
      {rows.length > 0 && (
        <div className="management-table communication-delivery-table">
          <div className="management-head">
            <span>{t("Recipient")}</span>
            <span>{t("Company")}</span>
            <span>{t("Source")}</span>
            <span>{t("State")}</span>
            <span>{t("Last event")}</span>
            <span>{t("Opened")}</span>
          </div>
          {rows.map((delivery) => {
            // Why the mail did not go out (a suppression) or how it failed (an error code of the worker or the provider), beside the state.
            const note = delivery.suppressedReason || delivery.lastErrorCode;
            return (
              <div className="management-row" key={delivery.id}>
                <span className="record-name">
                  <span>
                    <strong>{delivery.displayName || delivery.email}</strong>
                    <code>{delivery.email}</code>
                  </span>
                </span>
                <span>{name(delivery.organizationId)}</span>
                <span>{t(delivery.source)}</span>
                <Status tone={DELIVERY_TONE[delivery.state] ?? "neutral"}>
                  {note ? `${t(delivery.state)} · ${note}` : delivery.state}
                </Status>
                <span>
                  {delivery.lastEvent
                    ? `${delivery.lastEvent} ${delivery.lastEventAt ? when(delivery.lastEventAt) : ""}`
                    : "—"}
                </span>
                <span>{delivery.openedAt ? when(delivery.openedAt) : "—"}</span>
              </div>
            );
          })}
        </div>
      )}
      {total > PAGE_SIZE && (
        <div className="communication-pager">
          <Button
            variant="secondary"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={page === 1}
          >
            {t("Previous")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => setPage((current) => current + 1)}
            disabled={page * PAGE_SIZE >= total}
          >
            {t("Next")}
          </Button>
          <span className="communication-hint">
            {first}–{Math.min(total, page * PAGE_SIZE)} / {total}
          </span>
        </div>
      )}
      {confirming &&
        confirming.version === record.version &&
        (record.status === "Scheduled" || record.status === "Sending") && (
          <ConfirmDialog
            id="communication-cancel-title"
            title={
              unschedule
                ? t("Unschedule this communication?")
                : t("Cancel sending this communication?")
            }
            keepLabel={unschedule ? t("Keep schedule") : t("Keep sending")}
            confirmLabel={unschedule ? t("Unschedule") : t("Cancel sending")}
            onConfirm={async () => {
              await cancel(record);
              setConfirming(null);
            }}
            onClose={() => setConfirming(null)}
          >
            {/* The id again: the dialog covers the header, and the wrong communication is the mistake to prevent. */}
            <p className="communication-confirm-subject">
              <strong>{record.id}</strong> · {record.title}
            </p>
            <p>
              {unschedule
                ? t(
                    "It will not be sent at the scheduled time and becomes a draft again, which you can edit and schedule again. Its recipients are not chosen yet, so nobody is affected.",
                  )
                : t(
                    "Recipients still waiting, including those to be tried again, will not receive it. Mail already handed to SendGrid is not recalled. This cannot be undone.",
                  )}
            </p>
          </ConfirmDialog>
        )}
    </div>
  );
}
