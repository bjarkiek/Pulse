"use client";
import { useT } from "./shared";

import { useEffect, useState } from "react";

import {
  type Idea,
  type AnalyticsSummary,
  type RequestItem,
  Icon,
  Button,
  PageIntro,
} from "./shared";

export function AnalyticsPage({
  requests,
  ideas,
  onToast,
}: {
  requests: RequestItem[];
  ideas: Idea[];
  onToast: (message: string) => void;
}) {
  const t = useT();
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  useEffect(() => {
    fetch("/api/v1/internal/analytics/summary", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data && setSummary(data))
      .catch(() => undefined);
  }, []);
  const areas = Array.from(
    new Set([
      ...requests.map((item) => item.area),
      ...ideas.map((item) => item.area),
    ]),
  )
    .map((area) => ({
      area,
      requests: requests.filter((item) => item.area === area).length,
      ideas: ideas.filter((item) => item.area === area).length,
    }))
    .sort((a, b) => b.requests - a.requests);
  function exportCsv() {
    const anchor = document.createElement("a");
    anchor.href = "/api/v1/internal/analytics/requests.csv";
    anchor.click();
    onToast("Authorized request results exported.");
  }
  return (
    <div className="page-stack management-page">
      <PageIntro
        eyebrow="Product intelligence"
        title="Feedback analytics"
        description="Demand, flow, and data quality across the currently authorized customer scope."
        action={
          <Button variant="secondary" icon="arrow" onClick={exportCsv}>
            {t("Export CSV")}
          </Button>
        }
      />
      <section className="admin-metric-grid">
        <div>
          <span>{t("Open requests")}</span>
          <strong>
            {summary?.requests.open ??
              requests.filter(
                (item) =>
                  !["Released", "Closed", "Withdrawn"].includes(item.status),
              ).length}
          </strong>
          <small>{t("Current authorized scope")}</small>
        </div>
        <div>
          <span>{t("Unique product areas")}</span>
          <strong>{areas.length}</strong>
          <small>{t("Across requests and ideas")}</small>
        </div>
        <div>
          <span>{t("Published releases")}</span>
          <strong>
            {ideas.filter((item) => item.status === "Released").length}
          </strong>
          <small>{t("Customer-visible outcomes")}</small>
        </div>
      </section>
      <section className="admin-metric-grid">
        <div>
          <span>{t("Average first response")}</span>
          <strong>
            {Number(
              summary?.serviceLevels.averageFirstResponseHours || 0,
            ).toFixed(1)}
            h
          </strong>
          <small>{t("Authorized non-test organizations")}</small>
        </div>
        <div>
          <span>{t("Average time to triage")}</span>
          <strong>
            {Number(summary?.serviceLevels.averageTriageHours || 0).toFixed(1)}h
          </strong>
          <small>{t("Submitted to triaged")}</small>
        </div>
        <div>
          <span>{t("Delivered notifications")}</span>
          <strong>
            {summary?.notifications.find((item) => item.state === "Delivered")
              ?.count || 0}
          </strong>
          <small>{t("Delivery state from durable outbox")}</small>
        </div>
      </section>
      <section className="analytics-panel">
        <header>
          <div>
            <p className="eyebrow">{t("Demand distribution")}</p>
            <h3>{t("Requests by product area")}</h3>
          </div>
          <span>{t("Unique organization counts remain internal")}</span>
        </header>
        <div className="analytics-bars">
          {areas.map((item) => {
            const width = Math.max(
              8,
              (item.requests /
                Math.max(1, ...areas.map((entry) => entry.requests))) *
                100,
            );
            return (
              <div key={item.area}>
                <span>{item.area}</span>
                <div>
                  <i style={{ width: `${width}%` }} />
                </div>
                <strong>{item.requests}</strong>
                <small>
                  {item.ideas} {t("ideas")}
                </small>
              </div>
            );
          })}
        </div>
      </section>
      <section className="data-quality">
        <div>
          <Icon name="check" size={18} />
          <span>
            <strong>{t("Data quality checks")}</strong>
            <small>
              {summary?.dataQuality.missingOwner ??
                requests.filter((item) => item.owner === "Unassigned")
                  .length}{" "}
              {t("requests need an owner ·")}{" "}
              {summary?.dataQuality.missingClassification ??
                requests.filter((item) => !item.area).length}{" "}
              {t("need classification")}
            </small>
          </span>
        </div>
        <Button
          variant="secondary"
          onClick={() =>
            onToast("Data quality view is filtered to authorized records.")
          }
        >
          {t("Review records")}
        </Button>
      </section>
    </div>
  );
}
