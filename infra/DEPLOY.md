# Deploying DataCentral Pulse to Azure

Two PowerShell scripts stand the app up on Azure App Service with **Azure SQL
Database**, Key Vault, Storage, and a container registry:

| Script | Run it | What it does |
|--------|--------|--------------|
| `provision.ps1` | **once** per environment | Creates every Azure resource (deploys `main.bicep`) + a container registry, generates secrets into Key Vault, makes you the SQL admin, and wires managed-identity image pull. |
| `deploy.ps1` | **every release** | Builds the container image in ACR, points the Web App at it, grants the app's identity access to SQL, runs migrations, restarts, and health-checks. |

Everything uses **managed identity** — there are no SQL passwords, and the app's
secrets live only in Key Vault.

## Prerequisites

- **Azure CLI** — `az login` as an *interactive user* (you become the Azure SQL
  Entra admin). You need rights to create resources and role assignments.
- **PowerShell 7+** (`pwsh`).
- That's it for provisioning. `deploy.ps1` additionally uses the PowerShell
  `SqlServer` module (auto-installed for your user if missing) and builds the
  image **in the cloud** via ACR Tasks — no local Docker needed.

## 1. Provision

```powershell
cd infra
./provision.ps1 -NamePrefix dcpulseprod -Location westeurope
```

`-NamePrefix` (3–18 lowercase letters/digits/dashes) names every resource
(`dcpulseprod-app`, `dcpulseprod-sql`, `dcpulseprodacr`, …). It must be globally
unique enough for the storage account and registry.

Optional flags enable features up front (all can be added later by re-running):

```powershell
./provision.ps1 -NamePrefix dcpulseprod `
  -EntraClientId <app-client-id> -EntraClientSecret <secret> `   # standalone Microsoft sign-in
  -AnthropicApiKey sk-ant-... `                                   # AI assistant
  -SlackBotToken xoxb-... -SlackAppToken xapp-...                 # Slack assistant
```

Provision writes `infra/azure-env.<prefix>.json` (resource names/URLs, gitignored)
so `deploy.ps1` knows where to ship.

## 2. Deploy

```powershell
cd infra
./deploy.ps1 -NamePrefix dcpulseprod
```

Re-run it for every release. Migrations are tracked in `dbo.SchemaMigrations` and
applied only once each. Use `-SkipMigrations` for an image-only redeploy, and
`-Tag <tag>` to pin a specific image tag (defaults to the git short SHA).

When it finishes it prints the live URL and confirms `‹url›/api/health` returned
200.

## Signing in (important)

The demo login is **disabled in production**, so the app needs a real identity
source before anyone can sign in. Choose one:

- **Standalone Microsoft (Entra) sign-in** — register an Entra app, set its
  redirect URI to `https://<prefix>-app.azurewebsites.net/auth/callback`, and run
  provision (or re-run it) with `-EntraClientId`/`-EntraClientSecret`. Provision
  also sets `AUTH_ENTRA_TENANT_ID` to your tenant.
- **DataCentral embed** — configure the DataCentral host with the HMAC secret
  Pulse generated. Read it back from Key Vault:
  ```powershell
  az keyvault secret show --vault-name <prefix without dashes>-kv --name dc-app-secret --query value -o tsv
  ```
  and set `DC_ALLOWED_PARENT_ORIGINS` / `DC_FRAME_ANCESTORS` (in `main.bicep`) to
  your DataCentral origins.

Users must be **pre-provisioned** — an existing account whose email matches the
sign-in identity, with at least one organization membership. Seed the first
System-admin account directly in the database (the Users UI can't grant the
`System admin` role itself).

## What gets created

`namePrefix-app` (App Service, Linux container, P1v3, **single instance**),
`namePrefix-sql` + `Pulse` database (Azure SQL, Entra-only auth, S1),
`namePrefixacr` (Container Registry), `namePrefix…-kv` (Key Vault),
`namePrefix…files` (Storage, attachments), plus Log Analytics + App Insights.

> **Single instance is intentional** — the Slack Socket Mode connection and the
> in-memory OAuth/consent caches assume one instance. Do not scale out.

## Notes & troubleshooting

- **First provision** points the Web App at an image that doesn't exist yet, so
  the URL shows an error until the first `deploy.ps1`.
- **SQL firewall** — provision adds *your* current IP. If your IP changes or you
  deploy from elsewhere, add it:
  `az sql server firewall-rule create -g <rg> -s <prefix>-sql -n me --start-ip-address <ip> --end-ip-address <ip>`.
- **Secrets** are generated during provision and stored in Key Vault; they are
  never written to disk. Re-running `provision.ps1` **reuses** the existing Key
  Vault values (it does not rotate them), so adding a feature flag later won't
  invalidate sessions or break the DataCentral embed. To rotate a secret on
  purpose, update it in Key Vault and restart the app.
- **App SQL access** is granted automatically by `deploy.ps1`. It first tries
  `CREATE USER … FROM EXTERNAL PROVIDER`; if the SQL server can't read the
  directory (common in locked-down tenants), it falls back to creating the user
  by the managed identity's object id (no Microsoft Graph permission needed).
  You just need to be the SQL Entra admin (you are, from provisioning).
- **Logs**: `az webapp log tail -g <prefix>-rg -n <prefix>-app`.
- **Teardown**: `az group delete -n <prefix>-rg --yes`. (Key Vault has purge
  protection; fully removing it may require `az keyvault purge`.)
