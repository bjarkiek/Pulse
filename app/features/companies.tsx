"use client";

import { FormEvent, useState } from "react";

import {
  useT,
  type Company,
  type ManagedUser,
  Icon,
  Status,
  Button,
  PageIntro,
} from "./shared";

export function CompaniesPage({
  companies,
  users,
  onChange,
  onToast,
}: {
  companies: Company[];
  users: ManagedUser[];
  onChange: (companies: Company[]) => void;
  onToast: (message: string) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Company | "new" | null>(null);
  const visible = companies.filter((company) =>
    `${company.name} ${company.domain} ${company.type}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  async function save(company: Company) {
    const response = await fetch("/api/v1/admin/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(company),
    });
    if (!response.ok) {
      onToast("The company could not be saved.");
      return;
    }
    const saved = (await response.json()).item as Company;
    onChange(
      companies.some((item) => item.id === saved.id)
        ? companies.map((item) => (item.id === saved.id ? saved : item))
        : [...companies, saved],
    );
    setEditing(null);
    onToast(`${company.name} was saved.`);
  }
  return (
    <div className="page-stack management-page">
      <PageIntro
        eyebrow="Customer administration"
        title="Manage companies"
        description="Companies define the customer boundary. Requests, users, memberships, and authentication policies are scoped to a company."
        action={
          <Button icon="plus" onClick={() => setEditing("new")}>
            {t("Add company")}
          </Button>
        }
      />
      <section className="admin-metric-grid">
        <div>
          <span>{t("Active companies")}</span>
          <strong>
            {companies.filter((c) => c.status === "Active").length}
          </strong>
          <small>{t("Customers, partners, and internal")}</small>
        </div>
        <div>
          <span>{t("Customer companies")}</span>
          <strong>
            {companies.filter((c) => c.type === "Customer").length}
          </strong>
          <small>{t("Governed data boundaries")}</small>
        </div>
        <div>
          <span>{t("Multi-company users")}</span>
          <strong>
            {users.filter((u) => u.memberships.length > 1).length}
          </strong>
          <small>{t("Explicit memberships only")}</small>
        </div>
      </section>
      <div className="management-toolbar">
        <div className="search-input">
          <Icon name="search" size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search companies"
          />
        </div>
        <span>
          {visible.length} {t("companies")}
        </span>
      </div>
      <div className="management-table company-table">
        <div className="management-head">
          <span>{t("Company")}</span>
          <span>{t("Type")}</span>
          <span>{t("Users")}</span>
          <span>{t("Authentication")}</span>
          <span>{t("Status")}</span>
          <span />
        </div>
        {visible.map((company) => {
          const memberCount = users.filter((user) =>
            user.memberships.some(
              (membership) => membership.companyId === company.id,
            ),
          ).length;
          return (
            <div className="management-row" key={company.id}>
              <span className="record-name">
                <span className="company-avatar">
                  {company.name.slice(0, 2).toUpperCase()}
                </span>
                <span>
                  <strong>{company.name}</strong>
                  <code>
                    {company.id} · {company.domain}
                  </code>
                </span>
              </span>
              <span>{company.type}</span>
              <span>
                <strong>{memberCount}</strong> {t("members")}
              </span>
              <span className="auth-tags">
                {company.authentication.map((method) => (
                  <span key={method}>{method}</span>
                ))}
              </span>
              <Status
                tone={
                  company.status === "Active"
                    ? "success"
                    : company.status === "Onboarding"
                      ? "warning"
                      : "neutral"
                }
              >
                {company.status}
              </Status>
              <Button variant="secondary" onClick={() => setEditing(company)}>
                {t("Manage")}
              </Button>
            </div>
          );
        })}
      </div>
      {editing && (
        <CompanyEditor
          company={editing === "new" ? undefined : editing}
          nextNumber={companies.length + 1}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </div>
  );
}

export function CompanyEditor({
  company,
  nextNumber,
  onClose,
  onSave,
}: {
  company?: Company;
  nextNumber: number;
  onClose: () => void;
  onSave: (company: Company) => void;
}) {
  const t = useT();
  const [name, setName] = useState(company?.name || "");
  const [domain, setDomain] = useState(company?.domain || "");
  const [type, setType] = useState<Company["type"]>(
    company?.type || "Customer",
  );
  const [status, setStatus] = useState<Company["status"]>(
    company?.status || "Onboarding",
  );
  const [authentication, setAuthentication] = useState<("OTP" | "Entra ID")[]>(
    company?.authentication || ["OTP"],
  );
  function toggle(method: "OTP" | "Entra ID") {
    setAuthentication((items) =>
      items.includes(method)
        ? items.filter((item) => item !== method)
        : [...items, method],
    );
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !domain.trim() || authentication.length === 0) return;
    onSave({
      id: company?.id || `ORG-${String(nextNumber).padStart(3, "0")}`,
      name: name.trim(),
      domain: domain.trim().toLowerCase(),
      type,
      status,
      authentication,
      users: company?.users || 0,
      requests: company?.requests || 0,
    });
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
        aria-labelledby="company-editor-title"
      >
        <header>
          <div>
            <p className="eyebrow">{t("Company record")}</p>
            <h2 id="company-editor-title">
              {company ? `Manage ${company.name}` : "Add customer company"}
            </h2>
            <p>
              {t(
                "Company membership controls which customer context a user may enter.",
              )}
            </p>
          </div>
          <button className="icon-button" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <form onSubmit={submit}>
          <div className="form-grid">
            <label className="form-field">
              <span>
                {t("Company name")}
                <em>{t("Required")}</em>
              </span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Company name"
                required
              />
            </label>
            <label className="form-field">
              <span>
                {t("Verified domain")}
                <em>{t("Required")}</em>
              </span>
              <input
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                placeholder="example.com"
                required
              />
            </label>
            <label className="form-field">
              <span>{t("Company type")}</span>
              <select
                value={type}
                onChange={(event) =>
                  setType(event.target.value as Company["type"])
                }
              >
                <option value="Customer">{t("Customer")}</option>
                <option value="Partner">{t("Partner")}</option>
                <option value="Internal">{t("Internal")}</option>
              </select>
            </label>
            <label className="form-field">
              <span>{t("Status")}</span>
              <select
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as Company["status"])
                }
              >
                <option value="Active">{t("Active")}</option>
                <option value="Onboarding">{t("Onboarding")}</option>
                <option value="Inactive">{t("Inactive")}</option>
              </select>
            </label>
          </div>
          <fieldset className="auth-choice">
            <legend>{t("Allowed authentication")}</legend>
            <label>
              <input
                type="checkbox"
                checked={authentication.includes("OTP")}
                onChange={() => toggle("OTP")}
              />
              <span>
                <strong>{t("One-time password")}</strong>
                <small>
                  {t("Email-delivered OTP with no tenant configuration.")}
                </small>
              </span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={authentication.includes("Entra ID")}
                onChange={() => toggle("Entra ID")}
              />
              <span>
                <strong>{t("Microsoft Entra ID")}</strong>
                <small>
                  {t(
                    "Enterprise SSO after application configuration and consent.",
                  )}
                </small>
              </span>
            </label>
          </fieldset>
          <footer>
            <span>{t("At least one authentication method is required.")}</span>
            <div>
              <Button variant="secondary" onClick={onClose}>
                {t("Cancel")}
              </Button>
              <Button
                type="submit"
                icon="check"
                disabled={
                  !name.trim() || !domain.trim() || authentication.length === 0
                }
              >
                {t("Save company")}
              </Button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}
