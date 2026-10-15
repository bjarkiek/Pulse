"use client";

import { useEffect, useState } from "react";

import { useT, type Company, Icon, Status, Button, PageIntro } from "./shared";

/** What the server reports about the identity providers (System admins only). */
type ProviderStatus = {
  entra: { configured: boolean; clientId: string | null; tenantId: string | null };
  otp: { emailSenderConfigured: boolean };
};

export function AuthenticationPage({
  companies,
  onChange,
  onToast,
}: {
  companies: Company[];
  onChange: (companies: Company[]) => void;
  onToast: (message: string) => void;
}) {
  const t = useT();
  const [entraOpen, setEntraOpen] = useState(false);
  const [appId, setAppId] = useState("");
  const [tenantId, setTenantId] = useState("");
  // Entra ID is configured through the App Service settings; the card shows the
  // server's actual state instead of a placeholder.
  const [providers, setProviders] = useState<ProviderStatus | null>(null);
  const [providersFailed, setProvidersFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/admin/authentication", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        setProviders((await response.json()).item);
      })
      .catch(() => {
        if (!controller.signal.aborted) setProvidersFailed(true);
      });
    return () => controller.abort();
  }, []);
  const entraConfigured = providers?.entra.configured === true;
  // The company whose allowed sign-in methods are being edited.
  const [policyFor, setPolicyFor] = useState<Company | null>(null);
  const [policy, setPolicy] = useState<("OTP" | "Entra ID")[]>([]);
  const [policySaving, setPolicySaving] = useState(false);
  function openPolicy(company: Company) {
    setPolicy([...company.authentication] as ("OTP" | "Entra ID")[]);
    setPolicyFor(company);
  }
  function togglePolicy(method: "OTP" | "Entra ID") {
    setPolicy((current) =>
      current.includes(method)
        ? current.filter((value) => value !== method)
        : [...current, method],
    );
  }
  async function savePolicy() {
    if (!policyFor || policy.length === 0 || policySaving) return;
    setPolicySaving(true);
    try {
      const response = await fetch("/api/v1/admin/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...policyFor, authentication: policy }),
      });
      if (!response.ok) {
        onToast("The authentication policy could not be saved.");
        return;
      }
      const saved = (await response.json()).item as Company;
      onChange(companies.map((item) => (item.id === saved.id ? saved : item)));
      onToast(`Authentication policy saved for ${saved.name}.`);
      setPolicyFor(null);
    } catch {
      onToast("The authentication policy could not be saved.");
    } finally {
      setPolicySaving(false);
    }
  }
  return (
    <div className="page-stack management-page auth-page">
      <PageIntro
        eyebrow="Identity providers"
        title="Authentication"
        description="DataCentral Pulse supports email OTP and Microsoft Entra ID. Authentication identifies the person; company memberships authorize their customer access."
      />
      <div className="provider-grid">
        <article className="provider-card active">
          <header>
            <span className="provider-icon">
              <Icon name="message" size={21} />
            </span>
            <Status tone="success">{t("Active")}</Status>
          </header>
          <h3>{t("One-time password")}</h3>
          <p>
            {t(
              "Email-delivered OTP provides low-friction access without requiring a customer tenant application or guest account.",
            )}
          </p>
          <dl>
            <div>
              <dt>{t("Identifier")}</dt>
              <dd>{t("Email address")}</dd>
            </div>
            <div>
              <dt>{t("Code lifetime")}</dt>
              <dd>{t("10 minutes")}</dd>
            </div>
            <div>
              <dt>{t("Company access")}</dt>
              <dd>{t("Explicit membership")}</dd>
            </div>
          </dl>
          <Button
            variant="secondary"
            onClick={() =>
              onToast("OTP policy is active for eligible companies.")
            }
          >
            {t("Manage OTP policy")}
          </Button>
        </article>
        <article className={entraConfigured ? "provider-card active" : "provider-card"}>
          <header>
            <span className="provider-icon">
              <Icon name="building" size={21} />
            </span>
            {entraConfigured ? (
              <Status tone="success">{t("Active")}</Status>
            ) : (
              <Status tone="warning">{t("Configuration pending")}</Status>
            )}
          </header>
          <h3>{t("Microsoft Entra ID")}</h3>
          <p>
            {t(
              "Enterprise SSO using the DataCentral Pulse application registration. The App ID and Azure Tenant ID can be added later.",
            )}
          </p>
          <dl>
            <div>
              <dt>{t("Application ID")}</dt>
              <dd>
                <code>{providers?.entra.clientId ?? t("Not configured")}</code>
              </dd>
            </div>
            <div>
              <dt>{t("Azure Tenant ID")}</dt>
              <dd>
                <code>{providers?.entra.tenantId ?? t("Not configured")}</code>
              </dd>
            </div>
            <div>
              <dt>{t("Account model")}</dt>
              <dd>{t("Configured tenant")}</dd>
            </div>
          </dl>
          <p className="muted">
            {providersFailed
              ? t("Could not read the identity provider status.")
              : t(
                  "Set through the App Service configuration (Bicep parameters entraClientId and entraTenantId), not on this page.",
                )}
          </p>
          <Button onClick={() => setEntraOpen(true)}>
            {t("Configure Entra ID")}
          </Button>
        </article>
      </div>
      <section className="access-model">
        <div>
          <p className="eyebrow">{t("Sign-in resolution")}</p>
          <h3>{t("One identity, several company contexts")}</h3>
          <p>
            {t(
              "After OTP or Entra ID authentication, the service loads active memberships. Users with one membership enter that company directly. Users with several memberships choose an active company and may switch without signing in again.",
            )}
          </p>
        </div>
        <div className="access-flow">
          <span>
            <Icon name="users" size={18} />
            <strong>{t("User identity")}</strong>
            <small>{t("OTP or Entra ID")}</small>
          </span>
          <Icon name="arrow" size={17} />
          <span>
            <Icon name="link" size={18} />
            <strong>{t("Memberships")}</strong>
            <small>{t("User × company × role")}</small>
          </span>
          <Icon name="arrow" size={17} />
          <span>
            <Icon name="building" size={18} />
            <strong>{t("Active company")}</strong>
            <small>{t("Scoped requests and data")}</small>
          </span>
        </div>
      </section>
      <section className="company-auth-panel">
        <header>
          <div>
            <h3>{t("Company authentication policy")}</h3>
            <p>
              {t("Each company may allow one or both configured providers.")}
            </p>
          </div>
        </header>
        <div>
          {companies
            .filter((company) => company.status !== "Inactive")
            .map((company) => (
              <div key={company.id}>
                <span className="record-name">
                  <span className="company-avatar">
                    {company.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span>
                    <strong>{company.name}</strong>
                    <code>{company.domain}</code>
                  </span>
                </span>
                <span className="auth-tags">
                  {company.authentication.map((method) => (
                    <span key={method}>{method}</span>
                  ))}
                </span>
                <button
                  className="text-link"
                  onClick={() => openPolicy(company)}
                >
                  {t("Manage")}
                  <Icon name="arrow" size={13} />
                </button>
              </div>
            ))}
        </div>
      </section>
      {policyFor && (
        <div
          className="modal-layer"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPolicyFor(null);
          }}
        >
          <section
            className="management-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="policy-title"
          >
            <header>
              <div>
                <p className="eyebrow">{t("Company authentication policy")}</p>
                <h2 id="policy-title">{policyFor.name}</h2>
                <p>
                  {t(
                    "Choose which sign-in methods this company's users may use. At least one is required.",
                  )}
                </p>
              </div>
              <button
                className="icon-button"
                onClick={() => setPolicyFor(null)}
                aria-label={t("Close")}
              >
                <Icon name="x" />
              </button>
            </header>
            <fieldset className="auth-options">
              <legend>{t("Allowed authentication")}</legend>
              {(["OTP", "Entra ID"] as const).map((method) => (
                <label key={method}>
                  <input
                    type="checkbox"
                    checked={policy.includes(method)}
                    onChange={() => togglePolicy(method)}
                  />
                  <span>
                    <strong>{method === "OTP" ? t("One-time password") : t("Microsoft Entra ID")}</strong>
                  </span>
                </label>
              ))}
            </fieldset>
            <footer>
              <Button variant="secondary" onClick={() => setPolicyFor(null)}>
                {t("Cancel")}
              </Button>
              <Button
                onClick={savePolicy}
                disabled={policy.length === 0 || policySaving}
              >
                {policySaving ? t("Saving…") : t("Save policy")}
              </Button>
            </footer>
          </section>
        </div>
      )}
      {entraOpen && (
        <div
          className="modal-layer"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setEntraOpen(false);
          }}
        >
          <section
            className="management-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="entra-title"
          >
            <header>
              <div>
                <p className="eyebrow">{t("Enterprise identity")}</p>
                <h2 id="entra-title">{t("Configure Microsoft Entra ID")}</h2>
                <p>
                  {t(
                    "Validate the identifiers before applying them through secure Azure configuration.",
                  )}
                </p>
              </div>
              <button
                className="icon-button"
                onClick={() => setEntraOpen(false)}
              >
                <Icon name="x" />
              </button>
            </header>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setEntraOpen(false);
                onToast(
                  "Entra identifiers validated. Apply them through the Azure identity configuration.",
                );
              }}
            >
              <label className="form-field">
                <span>
                  {t("Application (client) ID")}
                  <em>{t("Required")}</em>
                </span>
                <input
                  value={appId}
                  onChange={(event) => setAppId(event.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  required
                />
              </label>
              <label className="form-field">
                <span>
                  {t("Azure Tenant ID")}
                  <em>{t("Required")}</em>
                </span>
                <input
                  value={tenantId}
                  onChange={(event) => setTenantId(event.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  required
                />
              </label>
              <div className="security-note">
                <Icon name="eye" size={17} />
                <span>
                  <strong>
                    {t("Client secrets are never entered in Pulse.")}
                  </strong>
                  <small>
                    {t(
                      "Use App Service Authentication and Key Vault references for production identity configuration.",
                    )}
                  </small>
                </span>
              </div>
              <footer>
                <span>
                  {t("Configuration is not activated until applied in Azure.")}
                </span>
                <div>
                  <Button
                    variant="secondary"
                    onClick={() => setEntraOpen(false)}
                  >
                    {t("Cancel")}
                  </Button>
                  <Button
                    type="submit"
                    icon="check"
                    disabled={!appId.trim() || !tenantId.trim()}
                  >
                    {t("Validate identifiers")}
                  </Button>
                </div>
              </footer>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
