"use client";

import { FormEvent, useState } from "react";

import {
  useT,
  type Company,
  type UserMembership,
  type ManagedUser,
  Icon,
  Status,
  Button,
  PageIntro,
} from "./shared";

export function UsersPage({
  users,
  companies,
  onChange,
  onToast,
}: {
  users: ManagedUser[];
  companies: Company[];
  onChange: (users: ManagedUser[]) => void;
  onToast: (message: string) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [companyFilter, setCompanyFilter] = useState("All companies");
  const [editing, setEditing] = useState<ManagedUser | "new" | null>(null);
  const visible = users.filter(
    (user) =>
      `${user.name} ${user.email}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (companyFilter === "All companies" ||
        user.memberships.some(
          (membership) => membership.companyId === companyFilter,
        )),
  );
  async function save(user: ManagedUser) {
    const response = await fetch("/api/v1/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(user),
    });
    if (!response.ok) {
      onToast("The user and memberships could not be saved.");
      return;
    }
    const saved = (await response.json()).item as ManagedUser;
    onChange(
      users.some((item) => item.id === saved.id)
        ? users.map((item) => (item.id === saved.id ? saved : item))
        : [...users, saved],
    );
    setEditing(null);
    onToast(
      `${saved.name} and ${saved.memberships.length} company membership${saved.memberships.length === 1 ? "" : "s"} were saved.`,
    );
  }
  return (
    <div className="page-stack management-page">
      <PageIntro
        eyebrow="Identity and access"
        title="Manage users and company access"
        description="A user has one identity and any number of explicit company memberships. Roles are assigned separately inside each company."
        action={
          <Button icon="plus" onClick={() => setEditing("new")}>
            {t("Invite user")}
          </Button>
        }
      />
      <div className="membership-callout">
        <Icon name="users" size={20} />
        <div>
          <strong>{t("Many-to-many access model")}</strong>
          <span>
            {t(
              "Internal employees are not global by default. Assign each employee only to the customer companies they support.",
            )}
          </span>
        </div>
      </div>
      <div className="management-toolbar">
        <div className="search-input">
          <Icon name="search" size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search users"
          />
        </div>
        <label className="select-wrap">
          <Icon name="building" size={15} />
          <select
            value={companyFilter}
            onChange={(event) => setCompanyFilter(event.target.value)}
          >
            <option value="All companies">{t("All companies")}</option>
            {companies.map((company) => (
              <option value={company.id} key={company.id}>
                {company.name}
              </option>
            ))}
          </select>
        </label>
        <span>
          {visible.length} {t("users")}
        </span>
      </div>
      <div className="management-table user-table">
        <div className="management-head">
          <span>{t("User")}</span>
          <span>{t("Authentication")}</span>
          <span>{t("Company access")}</span>
          <span>{t("Status")}</span>
          <span />
        </div>
        {visible.map((user) => (
          <div className="management-row" key={user.id}>
            <span className="record-name">
              <span className="user-avatar">
                {user.name
                  .split(" ")
                  .map((part) => part[0])
                  .slice(0, 2)
                  .join("")}
              </span>
              <span>
                <strong>{user.name}</strong>
                <code>{user.email}</code>
              </span>
            </span>
            <span className="auth-tags">
              <span>{user.authentication}</span>
            </span>
            <span className="membership-tags">
              {user.memberships.slice(0, 3).map((membership) => (
                <span key={membership.companyId}>
                  {
                    companies.find(
                      (company) => company.id === membership.companyId,
                    )?.name
                  }
                  <small>{membership.role}</small>
                </span>
              ))}
              {user.memberships.length > 3 && (
                <span>
                  +{user.memberships.length - 3} {t("more")}
                </span>
              )}
            </span>
            <Status
              tone={
                user.status === "Active"
                  ? "success"
                  : user.status === "Invited"
                    ? "warning"
                    : "error"
              }
            >
              {user.status}
            </Status>
            <Button variant="secondary" onClick={() => setEditing(user)}>
              {t("Edit access")}
            </Button>
          </div>
        ))}
      </div>
      {editing && (
        <UserEditor
          user={editing === "new" ? undefined : editing}
          companies={companies}
          nextNumber={users.length + 101}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </div>
  );
}

export function UserEditor({
  user,
  companies,
  nextNumber,
  onClose,
  onSave,
}: {
  user?: ManagedUser;
  companies: Company[];
  nextNumber: number;
  onClose: () => void;
  onSave: (user: ManagedUser) => void;
}) {
  const t = useT();
  const [name, setName] = useState(user?.name || "");
  const [email, setEmail] = useState(user?.email || "");
  const [status, setStatus] = useState<ManagedUser["status"]>(
    user?.status || "Invited",
  );
  const [authentication, setAuthentication] = useState<
    ManagedUser["authentication"]
  >(user?.authentication || "OTP");
  const [memberships, setMemberships] = useState<UserMembership[]>(
    user?.memberships || [],
  );
  function toggleCompany(companyId: string) {
    setMemberships((items) =>
      items.some((item) => item.companyId === companyId)
        ? items.filter((item) => item.companyId !== companyId)
        : [...items, { companyId, role: "Requester" }],
    );
  }
  function setRole(companyId: string, role: UserMembership["role"]) {
    setMemberships((items) =>
      items.map((item) =>
        item.companyId === companyId ? { ...item, role } : item,
      ),
    );
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !email.trim() || memberships.length === 0) return;
    onSave({
      id: user?.id || `USR-${nextNumber}`,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      status,
      authentication,
      memberships,
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
        className="management-modal user-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-editor-title"
      >
        <header>
          <div>
            <p className="eyebrow">{t("User identity")}</p>
            <h2 id="user-editor-title">
              {user ? `Edit ${user.name}` : "Invite user"}
            </h2>
            <p>
              {t(
                "Authentication proves identity. Membership determines company access.",
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
                {t("Full name")}
                <em>{t("Required")}</em>
              </span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Full name"
                required
              />
            </label>
            <label className="form-field">
              <span>
                {t("Email address")}
                <em>{t("Required")}</em>
              </span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@company.com"
                required
              />
            </label>
            <label className="form-field">
              <span>{t("Authentication")}</span>
              <select
                value={authentication}
                onChange={(event) =>
                  setAuthentication(
                    event.target.value as ManagedUser["authentication"],
                  )
                }
              >
                <option value="OTP">{t("OTP")}</option>
                <option value="Entra ID">{t("Entra ID")}</option>
              </select>
            </label>
            <label className="form-field">
              <span>{t("User status")}</span>
              <select
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as ManagedUser["status"])
                }
              >
                <option value="Active">{t("Active")}</option>
                <option value="Invited">{t("Invited")}</option>
                <option value="Suspended">{t("Suspended")}</option>
              </select>
            </label>
          </div>
          <fieldset className="membership-editor">
            <legend>
              {t("Company memberships")}
              <em>{t("Required")}</em>
            </legend>
            <p>
              {t(
                "Select every company this user may enter. Assign a role independently for each membership.",
              )}
            </p>
            {companies
              .filter((company) => company.status !== "Inactive")
              .map((company) => {
                const membership = memberships.find(
                  (item) => item.companyId === company.id,
                );
                return (
                  <div
                    className={membership ? "selected" : ""}
                    key={company.id}
                  >
                    <label>
                      <input
                        type="checkbox"
                        checked={!!membership}
                        onChange={() => toggleCompany(company.id)}
                      />
                      <span>
                        <strong>{company.name}</strong>
                        <small>
                          {company.type} · {company.domain}
                        </small>
                      </span>
                    </label>
                    {membership && (
                      <select
                        value={membership.role}
                        onChange={(event) =>
                          setRole(
                            company.id,
                            event.target.value as UserMembership["role"],
                          )
                        }
                      >
                        <option value="Company admin">
                          {t("Company admin")}
                        </option>
                        <option value="Requester">{t("Requester")}</option>
                        <option value="Viewer">{t("Viewer")}</option>
                        {company.type === "Internal" && (
                          <option value="Product manager">
                            {t("Product manager")}
                          </option>
                        )}
                      </select>
                    )}
                  </div>
                );
              })}
          </fieldset>
          <footer>
            <span>
              {t("Selected companies")}: {memberships.length}
            </span>
            <div>
              <Button variant="secondary" onClick={onClose}>
                {t("Cancel")}
              </Button>
              <Button
                type="submit"
                icon="check"
                disabled={
                  !name.trim() || !email.trim() || memberships.length === 0
                }
              >
                {user ? "Save access" : "Send invitation"}
              </Button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}
