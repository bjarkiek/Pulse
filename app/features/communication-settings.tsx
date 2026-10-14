"use client";
import { useEffect, useState } from "react";
import { apiFetch, errorMessage } from "@/lib/api-client";
import {
  Button,
  Icon,
  Status,
  useT,
  type CommunicationProviderStatus,
  type CommunicationSettingsItem,
} from "./shared";

const STATE_TONE = {
  disabled: "neutral",
  "provider-missing": "error",
  sandbox: "warning",
  "safe-mode": "warning",
  live: "success",
} as const;

export function CommunicationSettingsCard({
  onToast,
}: {
  onToast: (message: string) => void;
}) {
  const t = useT();
  const [settings, setSettings] = useState<CommunicationSettingsItem | null>(
    null,
  );
  const [status, setStatus] = useState<CommunicationProviderStatus | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [domains, setDomains] = useState("");
  useEffect(() => {
    apiFetch<{
      item: CommunicationSettingsItem;
      status: CommunicationProviderStatus;
    }>("/api/v1/admin/communications/settings")
      .then((data) => {
        setSettings(data.item);
        setStatus(data.status);
        setDomains(data.item.safeMode.allowedDomains.join(", "));
      })
      .catch(() => setSettings(null)); // non-System-admins get 404 → card never renders
  }, []);
  if (!settings || !status) return null;
  const update = (patch: Partial<CommunicationSettingsItem>) =>
    setSettings({ ...settings, ...patch });
  async function save() {
    setBusy(true);
    try {
      const body = {
        ...settings!,
        safeMode: {
          ...settings!.safeMode,
          allowedDomains: domains
            .split(/[,\s]+/)
            .map((d) => d.trim().toLowerCase())
            .filter(Boolean),
        },
      };
      const data = await apiFetch<{
        item: CommunicationSettingsItem;
        status: CommunicationProviderStatus;
      }>("/api/v1/admin/communications/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      setSettings(data.item);
      setStatus(data.status);
      onToast(t("Communication settings saved and added to the audit trail."));
    } catch (error) {
      onToast(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function sendTest() {
    setBusy(true);
    try {
      const result = await apiFetch<{ ok: boolean; transport: string }>(
        "/api/v1/admin/communications/settings/test",
        { method: "POST" },
      );
      onToast(
        result.transport === "console"
          ? t(
              "Configuration test logged to the server console (no SendGrid key configured).",
            )
          : t("Configuration test sent to your address."),
      );
    } catch (error) {
      onToast(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article
      className="settings-card communication-settings"
      data-tour="settings-communications"
    >
      <header>
        <Icon name="send" size={19} />
        <div>
          <h3>{t("Customer communications (SendGrid)")}</h3>
          <p>
            {t(
              "Broadcast product updates and notices to customer companies. Secrets live in Key Vault; everything else is configured here.",
            )}
          </p>
        </div>
      </header>
      <div className="communication-status-row">
        <Status tone={status.providerConfigured ? "success" : "error"}>
          {status.providerConfigured ? "API key configured" : "API key missing"}
        </Status>
        <Status tone={status.webhookConfigured ? "success" : "warning"}>
          {status.webhookConfigured
            ? "Event webhook verified"
            : "Event webhook key missing"}
        </Status>
        <Status
          tone={STATE_TONE[status.effectiveSendingState]}
        >{`Sending: ${status.effectiveSendingState}`}</Status>
      </div>
      <label className="form-field demo-toggle">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
        />
        <span>
          {t(
            "Enable sending — the worker and the Send action stay disabled until this is on.",
          )}
        </span>
      </label>
      <div className="form-grid">
        <label className="form-field">
          <span>{t("From name")}</span>
          <input
            value={settings.fromName}
            onChange={(e) => update({ fromName: e.target.value })}
          />
        </label>
        <label className="form-field">
          <span>{t("From address (verified in SendGrid)")}</span>
          <input
            type="email"
            value={settings.fromEmail}
            onChange={(e) => update({ fromEmail: e.target.value })}
            placeholder="updates@datacentral.ai"
          />
        </label>
        <label className="form-field">
          <span>{t("Reply-to")}</span>
          <input
            type="email"
            value={settings.replyTo}
            onChange={(e) => update({ replyTo: e.target.value })}
          />
        </label>
        <label className="form-field">
          <span>{t("Data residency")}</span>
          <select
            value={settings.dataResidency}
            onChange={(e) =>
              update({ dataResidency: e.target.value as "global" | "eu" })
            }
          >
            <option value="global">Global</option>
            <option value="eu">EU</option>
          </select>
        </label>
        <label className="form-field">
          <span>{t("Unsubscribe group id (ASM)")}</span>
          <input
            type="number"
            min="1"
            value={settings.unsubscribeGroupId ?? ""}
            onChange={(e) =>
              update({
                unsubscribeGroupId: e.target.value
                  ? Number(e.target.value)
                  : null,
              })
            }
          />
        </label>
        <label className="form-field">
          <span>{t("Daily cap")}</span>
          <input
            type="number"
            min="1"
            value={settings.dailyCap}
            onChange={(e) => update({ dailyCap: Number(e.target.value) })}
          />
        </label>
        <label className="form-field">
          <span>{t("Max recipients per communication")}</span>
          <input
            type="number"
            min="1"
            value={settings.maxRecipientsPerCampaign}
            onChange={(e) =>
              update({ maxRecipientsPerCampaign: Number(e.target.value) })
            }
          />
        </label>
        <label className="form-field">
          <span>{t("Category prefix")}</span>
          <input
            value={settings.categoriesPrefix}
            onChange={(e) => update({ categoriesPrefix: e.target.value })}
          />
        </label>
      </div>
      <label className="form-field demo-toggle">
        <input
          type="checkbox"
          checked={settings.safeMode.enabled}
          onChange={(e) =>
            update({
              safeMode: { ...settings.safeMode, enabled: e.target.checked },
            })
          }
        />
        <span>
          {t(
            "Safe mode — only send to the allow-listed domains below; everyone else is recorded as suppressed.",
          )}
        </span>
      </label>
      <label className="form-field">
        <span>{t("Allowed domains (comma separated)")}</span>
        <input
          value={domains}
          onChange={(e) => setDomains(e.target.value)}
          placeholder="datacentral.ai"
        />
      </label>
      <label className="form-field demo-toggle">
        <input
          type="checkbox"
          checked={settings.sandboxMode}
          onChange={(e) => update({ sandboxMode: e.target.checked })}
        />
        <span>
          {t("Sandbox mode — SendGrid validates requests without delivering.")}
        </span>
      </label>
      <div className="form-grid">
        <label className="form-field demo-toggle">
          <input
            type="checkbox"
            checked={settings.tracking.opens}
            onChange={(e) =>
              update({
                tracking: { ...settings.tracking, opens: e.target.checked },
              })
            }
          />
          <span>{t("Track opens")}</span>
        </label>
        <label className="form-field demo-toggle">
          <input
            type="checkbox"
            checked={settings.tracking.clicks}
            onChange={(e) =>
              update({
                tracking: { ...settings.tracking, clicks: e.target.checked },
              })
            }
          />
          <span>{t("Track clicks")}</span>
        </label>
      </div>
      {(["en", "is"] as const).map((locale) => (
        <fieldset className="communication-boilerplate" key={locale}>
          <legend>
            {locale === "en"
              ? t("Boilerplate (English)")
              : t("Boilerplate (Icelandic)")}
          </legend>
          <label className="form-field">
            <span>{t("Sign-off")}</span>
            <textarea
              rows={2}
              value={settings.boilerplate[locale].signOff}
              onChange={(e) =>
                update({
                  boilerplate: {
                    ...settings.boilerplate,
                    [locale]: {
                      ...settings.boilerplate[locale],
                      signOff: e.target.value,
                    },
                  },
                })
              }
            />
          </label>
          <label className="form-field">
            <span>{t("Footer line")}</span>
            <input
              value={settings.boilerplate[locale].footer}
              onChange={(e) =>
                update({
                  boilerplate: {
                    ...settings.boilerplate,
                    [locale]: {
                      ...settings.boilerplate[locale],
                      footer: e.target.value,
                    },
                  },
                })
              }
            />
          </label>
          <label className="form-field">
            <span>{t("Support address")}</span>
            <input
              type="email"
              value={settings.boilerplate[locale].supportEmail}
              onChange={(e) =>
                update({
                  boilerplate: {
                    ...settings.boilerplate,
                    [locale]: {
                      ...settings.boilerplate[locale],
                      supportEmail: e.target.value,
                    },
                  },
                })
              }
            />
          </label>
        </fieldset>
      ))}
      <p className="communication-webhook-url">
        <span>{t("Event webhook URL")}</span>
        <code>{status.webhookUrl}</code>
      </p>
      <div className="communication-settings-actions">
        <Button onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save communication settings"}
        </Button>
        <Button variant="secondary" onClick={sendTest} disabled={busy}>
          {t("Send configuration test")}
        </Button>
      </div>
    </article>
  );
}
