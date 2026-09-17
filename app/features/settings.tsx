"use client";

import { DeliveryStatus } from "./delivery-status";
import { useEffect, useState } from "react";

import {
  audienceMatches,
  TOUR_AUDIENCES,
  type OnboardingAdminPayload,
  type OnboardingUserItem,
  type TourAudience,
} from "@/lib/tours";

import {
  useT,
  mutationHeaders,
  type WebhookSubscriptionItem,
  type PulseSettings,
  type TaxonomyValue,
  Icon,
  Status,
  Button,
  PageIntro,
} from "./shared";

export function SettingsPage({
  onToast,
}: {
  onToast: (message: string) => void;
}) {
  const t = useT();
  const [settings, setSettings] = useState<PulseSettings>({
    formulaVersion: 1,
    attachmentMaxMb: 25,
    requestAttachmentMaxMb: 100,
    retentionDays: 2555,
    defaultLocale: "en",
    roadmapDisclaimer:
      "Roadmap content is directional, may change, and is not a contractual commitment.",
    showDemoData: false,
    dcOnlyAccess: true,
    scoreWeights: {
      impact: 30,
      reach: 20,
      strategy: 25,
      commercial: 15,
      urgency: 10,
    },
  });
  const [saving, setSaving] = useState(false);
  const [taxonomy, setTaxonomy] = useState<TaxonomyValue[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookSubscriptionItem[]>([]);
  const [webhookUrl, setWebhookUrl] = useState("");
  useEffect(() => {
    Promise.all([
      fetch("/api/v1/admin/settings"),
      fetch("/api/v1/admin/taxonomy"),
      fetch("/api/v1/internal/webhooks"),
    ])
      .then(async ([settingsResponse, taxonomyResponse, webhooksResponse]) => {
        if (settingsResponse.ok)
          setSettings((await settingsResponse.json()).item);
        if (taxonomyResponse.ok)
          setTaxonomy((await taxonomyResponse.json()).items);
        if (webhooksResponse.ok)
          setWebhooks((await webhooksResponse.json()).items);
      })
      .catch(() => undefined);
  }, []);
  async function save() {
    setSaving(true);
    const response = await fetch("/api/v1/admin/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    const data = await response.json();
    setSaving(false);
    if (!response.ok) {
      onToast(data?.error?.message || "Settings could not be saved.");
      return;
    }
    setSettings(data.item);
    onToast("Product settings saved and added to the audit trail.");
  }
  function setWeight(key: keyof PulseSettings["scoreWeights"], value: number) {
    setSettings((current) => ({
      ...current,
      scoreWeights: { ...current.scoreWeights, [key]: value },
    }));
  }
  async function saveTaxonomy(item: TaxonomyValue) {
    const response = await fetch("/api/v1/admin/taxonomy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(item),
    });
    const data = await response.json();
    if (!response.ok) {
      onToast(data?.error?.message || "Taxonomy could not be saved.");
      return;
    }
    setTaxonomy((items) => {
      const exists = items.some((value) => value.id === data.item.id);
      return exists
        ? items.map((value) => (value.id === data.item.id ? data.item : value))
        : [...items, data.item];
    });
    onToast("Taxonomy saved and added to the audit trail.");
  }
  function addTaxonomy() {
    const value = window.prompt("New product area name")?.trim();
    if (!value) return;
    void saveTaxonomy({
      id: "new",
      kind: "Product area",
      value,
      active: true,
      sortOrder: taxonomy.filter((item) => item.kind === "Product area").length,
    });
  }
  async function addWebhook() {
    if (!webhookUrl.trim()) return;
    const response = await fetch("/api/v1/internal/webhooks", {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({
        url: webhookUrl,
        events: [
          "request.created",
          "request.status.changed",
          "request.linked",
          "idea.published",
          "release.published",
        ],
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      onToast(data?.error?.message || "Webhook could not be created.");
      return;
    }
    setWebhooks((items) => [data, ...items]);
    setWebhookUrl("");
    onToast("Signed webhook subscription created.");
  }
  async function toggleWebhook(item: WebhookSubscriptionItem) {
    const response = await fetch(`/api/v1/internal/webhooks/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: !item.active }),
    });
    if (!response.ok) {
      onToast("Webhook state could not be changed.");
      return;
    }
    setWebhooks((items) =>
      items.map((value) =>
        value.id === item.id ? { ...value, active: !value.active } : value,
      ),
    );
  }
  return (
    <div className="page-stack management-page">
      <PageIntro
        eyebrow="System administration"
        title="Product settings"
        description="Govern taxonomy, customer wording, retention, scoring, localization, and secure attachment policy."
      />
      <section className="settings-grid">
        <DeliveryStatus />
        <article className="settings-card">
          <header>
            <Icon name="plus" size={19} />
            <div>
              <h3>{t("Attachment policy")}</h3>
              <p>
                {t(
                  "Allow-listed files are quarantined until malware scanning reports clean.",
                )}
              </p>
            </div>
          </header>
          <div className="form-grid">
            <label className="form-field">
              <span>{t("Maximum per file")}</span>
              <select
                value={settings.attachmentMaxMb}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    attachmentMaxMb: Number(event.target.value),
                  })
                }
              >
                <option value="10">{t("10 MB")}</option>
                <option value="25">{t("25 MB")}</option>
                <option value="50">{t("50 MB")}</option>
              </select>
            </label>
            <label className="form-field">
              <span>{t("Maximum per request")}</span>
              <select
                value={settings.requestAttachmentMaxMb}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    requestAttachmentMaxMb: Number(event.target.value),
                  })
                }
              >
                <option value="50">{t("50 MB")}</option>
                <option value="100">{t("100 MB")}</option>
                <option value="250">{t("250 MB")}</option>
              </select>
            </label>
          </div>
          <label className="form-field">
            <span>{t("Retention period")}</span>
            <select
              value={settings.retentionDays}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  retentionDays: Number(event.target.value),
                })
              }
            >
              <option value="365">{t("1 year")}</option>
              <option value="1095">{t("3 years")}</option>
              <option value="2555">{t("7 years")}</option>
            </select>
          </label>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save policy"}
          </Button>
        </article>
        <article className="settings-card">
          <header>
            <Icon name="map" size={19} />
            <div>
              <h3>{t("Roadmap and localization")}</h3>
              <p>
                {t(
                  "English is the source language with explicit Icelandic fallback.",
                )}
              </p>
            </div>
          </header>
          <label className="form-field">
            <span>{t("Editing language")}</span>
            <select
              value={settings.defaultLocale}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  defaultLocale: event.target.value as "en" | "is",
                })
              }
            >
              <option value="en">{t("English")}</option>
              <option value="is">{t("Icelandic")}</option>
            </select>
          </label>
          <label className="form-field">
            <span>{t("Roadmap disclaimer")}</span>
            <textarea
              rows={4}
              value={settings.roadmapDisclaimer}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  roadmapDisclaimer: event.target.value,
                })
              }
            />
          </label>
          <Button variant="secondary" onClick={save} disabled={saving}>
            {t("Save wording")}
          </Button>
        </article>
        <article className="settings-card">
          <header>
            <Icon name="settings" size={19} />
            <div>
              <h3>{t("Access")}</h3>
              <p>{t("Control how people are allowed to sign in to Pulse.")}</p>
            </div>
          </header>
          <label className="form-field demo-toggle">
            <input
              type="checkbox"
              checked={settings.dcOnlyAccess}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  dcOnlyAccess: event.target.checked,
                })
              }
            />
            <span>
              {t(
                "Only allow access via DataCentral — standalone Microsoft sign-in is disabled and visitors are told to open Pulse from DataCentral (or contact support@datacentral.ai). Uncheck to re-enable the standalone Microsoft sign-in flow.",
              )}
            </span>
          </label>
          <Button variant="secondary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save access policy"}
          </Button>
        </article>
        <article className="settings-card">
          <header>
            <Icon name="eye" size={19} />
            <div>
              <h3>{t("Demo data")}</h3>
              <p>
                {t(
                  "Showcase Pulse with the built-in sample content instead of live data.",
                )}
              </p>
            </div>
          </header>
          <label className="form-field demo-toggle">
            <input
              type="checkbox"
              checked={settings.showDemoData}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  showDemoData: event.target.checked,
                })
              }
            />
            <span>
              {t(
                "Show demo data — requests, ideas, releases, triage, and analytics come from the built-in sample set. Changes made while enabled are demo-only and reset on restart; live data is untouched and returns when switched off.",
              )}
            </span>
          </label>
          <Button variant="secondary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save demo mode"}
          </Button>
        </article>
        <article className="settings-card">
          <header>
            <Icon name="layers" size={19} />
            <div>
              <h3>{t("Priority formula")}</h3>
              <p>
                {t(
                  "Scores support product judgment and never publish decisions automatically.",
                )}
              </p>
            </div>
          </header>
          <div className="weight-list">
            {(
              [
                ["impact", "Customer impact"],
                ["reach", "Reach"],
                ["strategy", "Strategic alignment"],
                ["commercial", "Commercial impact"],
                ["urgency", "Urgency / risk"],
              ] as Array<[keyof PulseSettings["scoreWeights"], string]>
            ).map(([key, label]) => (
              <label key={key}>
                <span>{label}</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={settings.scoreWeights[key]}
                  onChange={(event) =>
                    setWeight(key, Number(event.target.value))
                  }
                  aria-label={`${label} weight`}
                />
                <strong>%</strong>
              </label>
            ))}
          </div>
          <Button variant="secondary" onClick={save} disabled={saving}>
            {t("Save weights")}
          </Button>
        </article>
        <article className="settings-card">
          <header>
            <Icon name="layers" size={19} />
            <div>
              <h3>{t("Product taxonomy")}</h3>
              <p>
                {t(
                  "Deactivated values remain on history but cannot be selected for new records.",
                )}
              </p>
            </div>
          </header>
          <div className="taxonomy-list">
            {taxonomy
              .filter((item) => item.kind === "Product area")
              .map((item) => (
                <div key={item.id}>
                  <span>{item.value}</span>
                  <button
                    onClick={() =>
                      saveTaxonomy({ ...item, active: !item.active })
                    }
                  >
                    {item.active ? "Deactivate" : "Reactivate"}
                  </button>
                </div>
              ))}
          </div>
          <Button variant="secondary" icon="plus" onClick={addTaxonomy}>
            {t("Add product area")}
          </Button>
        </article>
        <article className="settings-card">
          <header>
            <Icon name="link" size={19} />
            <div>
              <h3>{t("Signed outbound webhooks")}</h3>
              <p>
                {t(
                  "HTTPS endpoints receive non-confidential event envelopes with HMAC signatures and retry tracking.",
                )}
              </p>
            </div>
          </header>
          <div className="webhook-list">
            {webhooks.map((item) => (
              <div key={item.id}>
                <span>
                  <strong>{item.url}</strong>
                  <small>
                    {item.events.length} {t("selected events")}
                  </small>
                </span>
                <button onClick={() => toggleWebhook(item)}>
                  {item.active ? "Disable" : "Enable"}
                </button>
              </div>
            ))}
          </div>
          <label className="form-field">
            <span>{t("HTTPS endpoint")}</span>
            <input
              type="url"
              value={webhookUrl}
              onChange={(event) => setWebhookUrl(event.target.value)}
              placeholder="https://example.com/pulse-events"
            />
          </label>
          <Button
            variant="secondary"
            icon="plus"
            onClick={addWebhook}
            disabled={!webhookUrl.trim()}
          >
            {t("Add webhook")}
          </Button>
        </article>
      </section>
      <OnboardingSettings onToast={onToast} />
    </div>
  );
}

export const AUDIENCE_LABELS: Record<TourAudience, string> = {
  All: "Everyone",
  Customers: "Customers only",
  Internal: "DataCentral team",
  SystemAdmins: "System admins",
};

export const TOUR_STATUS_FILTERS = [
  ["NotStarted", "Not started"],
  ["InProgress", "In progress"],
  ["Completed", "Completed"],
  ["Dismissed", "Dismissed"],
] as const;

export function OnboardingSettings({
  onToast,
}: {
  onToast: (message: string) => void;
}) {
  const t = useT();
  const [data, setData] = useState<OnboardingAdminPayload | null>(null);
  const [saving, setSaving] = useState(false);
  const [filterTour, setFilterTour] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  useEffect(() => {
    fetch("/api/v1/admin/onboarding")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => payload && setData(payload.item))
      .catch(() => undefined);
  }, []);
  // Non-System-admins get a 404 from the endpoint above, so the whole
  // onboarding block simply never renders for them.
  if (!data) return null;

  async function save(next: OnboardingAdminPayload) {
    const previous = data;
    setSaving(true);
    setData(next);
    try {
      const response = await fetch("/api/v1/admin/onboarding", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: next.enabled,
          tours: next.settings.map(
            ({ tourKey, enabled, audience, autoStart }) => ({
              tourKey,
              enabled,
              audience,
              autoStart,
            }),
          ),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setData(previous); // optimistic state must not survive a failed save
        onToast(
          payload?.error?.message || "Onboarding settings could not be saved.",
        );
        return;
      }
      setData(payload.item);
      onToast("Onboarding settings saved and added to the audit trail.");
    } catch {
      setData(previous);
      onToast("Onboarding settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function restore(user: OnboardingUserItem) {
    try {
      const response = await fetch("/api/v1/admin/onboarding/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });
      if (!response.ok) {
        onToast("Tours could not be restored for this user.");
        return;
      }
    } catch {
      onToast("Tours could not be restored for this user.");
      return;
    }
    setData(
      (current) =>
        current && {
          ...current,
          users: current.users.map((item) =>
            item.id === user.id ? { ...item, toursHiddenAt: null } : item,
          ),
        },
    );
    onToast(`Tours restored for ${user.name}.`);
  }

  const hiddenUsers = data.users.filter((user) => user.toursHiddenAt);
  const gridRows = data.settings.flatMap((setting) => {
    if (filterTour && setting.tourKey !== filterTour) return [];
    const progressByUser = new Map(
      data.progress
        .filter((item) => item.tourKey === setting.tourKey)
        .map((item) => [item.userId, item]),
    );
    // audience-eligible users appear even without progress (Not started);
    // users with real historical progress stay visible even after an admin
    // narrows the tour's audience past them
    return data.users
      .filter(
        (user) =>
          audienceMatches(setting.audience, user) ||
          progressByUser.has(user.id),
      )
      .map((user) => {
        const row = progressByUser.get(user.id);
        return { setting, user, row, status: row?.status ?? "NotStarted" };
      })
      .filter((entry) => !filterStatus || entry.status === filterStatus);
  });

  return (
    <>
      <section className="settings-grid onboarding-settings">
        <article
          className={`settings-card onboarding-card ${data.enabled ? "" : "onboarding-off"}`}
          data-tour="settings-onboarding"
        >
          <header>
            <Icon name="map" size={19} />
            <div>
              <h3>{t("Onboarding tours")}</h3>
              <p>
                {t(
                  "Guided walkthroughs for new users. When the master switch is off, nobody sees tours or the ? help menu — regardless of the per-tour settings below. In DataCentral embeds, tours are additionally only active for users whose launch carries the “Onboard” role.",
                )}{" "}
                <a href="/help#admin" target="_blank" rel="noopener">
                  {t("Open the admin manual")}
                </a>
                .
              </p>
            </div>
          </header>
          <label className="onboarding-master">
            <input
              type="checkbox"
              checked={data.enabled}
              disabled={saving}
              onChange={(event) =>
                save({ ...data, enabled: event.target.checked })
              }
            />
            <strong>{t("Onboarding enabled (master switch)")}</strong>
          </label>
          <div className="onboarding-tour-list">
            {data.settings.map((setting) => {
              const eligible = data.users.filter((user) =>
                audienceMatches(setting.audience, user),
              );
              const eligibleIds = new Set(eligible.map((user) => user.id));
              // funnel counts scoped to the tour's *current* audience so
              // completion percentages cannot exceed 100%
              const rows = data.progress.filter(
                (item) =>
                  item.tourKey === setting.tourKey &&
                  eligibleIds.has(item.userId),
              );
              const completed = rows.filter(
                (item) => item.status === "Completed",
              ).length;
              return (
                <div className="onboarding-tour-row" key={setting.tourKey}>
                  <div className="onboarding-tour-head">
                    <strong>{setting.title}</strong>
                    <code>
                      {setting.tourKey} · v{setting.version} ·{" "}
                      {setting.stepCount} {t("steps")}
                    </code>
                  </div>
                  <p className="onboarding-tour-stats">
                    {eligible.length} {t("eligible ·")}
                    {rows.length} {t("started ·")} {completed}{" "}
                    {t("completed ·")}{" "}
                    {rows.filter((item) => item.status === "Dismissed").length}{" "}
                    {t("dismissed")}
                    {eligible.length > 0 && (
                      <strong>
                        {" "}
                        ({Math.round((100 * completed) / eligible.length)}%)
                      </strong>
                    )}
                  </p>
                  <div className="onboarding-tour-controls">
                    <label>
                      <input
                        type="checkbox"
                        checked={setting.enabled}
                        disabled={saving}
                        onChange={(event) =>
                          save({
                            ...data,
                            settings: data.settings.map((item) =>
                              item.tourKey === setting.tourKey
                                ? { ...item, enabled: event.target.checked }
                                : item,
                            ),
                          })
                        }
                      />
                      {t("Enabled")}
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={setting.autoStart}
                        disabled={saving}
                        onChange={(event) =>
                          save({
                            ...data,
                            settings: data.settings.map((item) =>
                              item.tourKey === setting.tourKey
                                ? { ...item, autoStart: event.target.checked }
                                : item,
                            ),
                          })
                        }
                      />
                      {t("Auto-start")}
                    </label>
                    <select
                      value={setting.audience}
                      disabled={saving}
                      aria-label={`${setting.title} audience`}
                      onChange={(event) =>
                        save({
                          ...data,
                          settings: data.settings.map((item) =>
                            item.tourKey === setting.tourKey
                              ? {
                                  ...item,
                                  audience: event.target.value as TourAudience,
                                }
                              : item,
                          ),
                        })
                      }
                    >
                      {TOUR_AUDIENCES.map((audience) => (
                        <option key={audience} value={audience}>
                          {AUDIENCE_LABELS[audience]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
          </div>
        </article>
      </section>
      <section
        className="panel tour-progress-panel"
        data-tour="onboarding-progress"
      >
        <div className="panel-header">
          <div>
            <h3>{t("Tour progress by user")}</h3>
            <p>{t("Who started what, how far they got, and where.")}</p>
          </div>
          <div className="tour-progress-filters">
            <select
              value={filterTour}
              aria-label="Filter by tour"
              onChange={(event) => setFilterTour(event.target.value)}
            >
              <option value="">{t("All tours")}</option>
              {data.settings.map((setting) => (
                <option key={setting.tourKey} value={setting.tourKey}>
                  {setting.title}
                </option>
              ))}
            </select>
            <select
              value={filterStatus}
              aria-label="Filter by status"
              onChange={(event) => setFilterStatus(event.target.value)}
            >
              <option value="">{t("All statuses")}</option>
              {TOUR_STATUS_FILTERS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {hiddenUsers.length > 0 && (
          <div className="tour-hidden-row">
            <span>
              {hiddenUsers.length === 1
                ? "1 user has hidden tours forever:"
                : `${hiddenUsers.length} users have hidden tours forever:`}
            </span>
            {hiddenUsers.map((user) => (
              <button
                type="button"
                key={user.id}
                onClick={() => restore(user)}
                title="Bring tours and the help menu back for this user"
              >
                {user.name} {t("· Restore")}
              </button>
            ))}
          </div>
        )}
        <div className="tour-progress-table">
          <div className="tour-progress-head">
            <span>{t("User")}</span>
            <span>{t("Tour")}</span>
            <span>{t("Status")}</span>
            <span>{t("Step")}</span>
            <span>{t("Where")}</span>
            <span>{t("Updated")}</span>
          </div>
          {gridRows.map(({ setting, user, row, status }) => (
            <div
              className="tour-progress-row"
              key={`${setting.tourKey}:${user.id}`}
            >
              <span className="tour-progress-user">
                {user.name}
                {user.toursHiddenAt && <em>{t("hidden")}</em>}
              </span>
              <span>{setting.title}</span>
              <span>
                {status === "Completed" && (
                  <Status tone="success">{t("Completed")}</Status>
                )}
                {status === "InProgress" && (
                  <Status tone="violet">{t("In progress")}</Status>
                )}
                {status === "Dismissed" && (
                  <Status tone="warning">{t("Dismissed")}</Status>
                )}
                {status === "NotStarted" && (
                  <Status tone="neutral">{t("Not started")}</Status>
                )}
              </span>
              <span>
                {row ? `${row.lastStepIndex + 1}/${row.stepCount}` : "—"}
              </span>
              <span>
                {row
                  ? row.source === "embed"
                    ? "DataCentral"
                    : "Standalone"
                  : "—"}
              </span>
              <span>
                {row ? row.updatedAt.slice(0, 16).replace("T", " ") : "—"}
              </span>
            </div>
          ))}
          {gridRows.length === 0 && (
            <div className="tour-progress-empty">
              {t("No users match the current filters.")}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
