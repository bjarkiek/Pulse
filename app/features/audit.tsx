"use client";
import { useT } from "./shared";

import { type AuditItem, PageIntro, EmptyState } from "./shared";

export function AuditPage({ items }: { items: AuditItem[] }) {
  const t = useT();
  return (
    <div className="page-stack management-page">
      <PageIntro
        eyebrow="Immutable history"
        title="Audit log"
        description="Security and business history for publication, roles, links, status, scoring, exports, and administrative changes."
      />
      <div className="management-toolbar">
        <span>
          {items.length} {t("recent events")}
        </span>
      </div>
      <div className="audit-table">
        <div className="audit-head">
          <span>{t("Time")}</span>
          <span>{t("Action")}</span>
          <span>{t("Entity")}</span>
          <span>{t("Actor / organization")}</span>
          <span>{t("Correlation")}</span>
        </div>
        {items.length === 0 ? (
          <EmptyState
            title="No audit events"
            description="Material mutations will appear here with actor and correlation context."
            action="Refresh"
            onAction={() => window.location.reload()}
          />
        ) : (
          items.map((item) => (
            <div className="audit-row" key={item.id}>
              <code>{new Date(item.createdAt).toLocaleString()}</code>
              <strong>{item.action}</strong>
              <span>
                {item.entityType} · {item.entityId?.slice(0, 12) || "—"}
              </span>
              <span>
                {item.actor || "System"}
                <small>{item.organizationId || "Global"}</small>
              </span>
              <code>{item.correlationId.slice(0, 8)}</code>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
