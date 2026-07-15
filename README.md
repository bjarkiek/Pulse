# DataCentral Pulse

Pulse is a responsive customer-feedback and product-planning application based on the requirements in [prd.md](prd.md). It separates private customer requests from customer-safe canonical product ideas, supports internal triage, roadmap communication, company membership administration, analytics, and secured attachments.

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`. With no Azure environment variables the application uses a seeded, process-local repository and an authenticated local upload endpoint. This mode is intentionally non-durable and must not be enabled in production.

Copy `.env.example` to `.env.local` to connect Azure resources. Never commit the resulting file.

## Production architecture

- Next.js 16 standalone container on Azure App Service.
- Azure SQL is the source of truth for organizations, memberships, requests, ideas, attachments, comments, notifications, score snapshots, and audit events.
- Azure Blob Storage stores attachment bytes in a private container. Azure SQL stores ownership, visibility, content type, size, and scan state.
- The App Service managed identity authenticates to SQL and Blob Storage. No database passwords or storage keys are used.
- Key Vault stores the attachment-scanner callback secret; App Service receives only a Key Vault reference.
- Microsoft Entra External ID is the recommended identity front door: configure email one-time passcode and Microsoft Entra federation, then enable App Service Authentication so Pulse receives verified identity headers.
- Application Insights receives operational telemetry. Customer request text, email addresses, and filenames must not be added to telemetry.

All API reads and mutations resolve the active membership server-side. A caller-supplied organization header is only a context hint and never grants access. Users with several active memberships choose a context after sign-in; Pulse stores the authorized selection in a secure, HTTP-only, same-site cookie.

API mutation traffic is protected by same-origin checks and route-scoped rate limits. Request/idea/release create and publish operations require an `Idempotency-Key`. The OpenAPI 3.1 contract is available from `/api/v1/openapi` and as the static [`openapi.json`](public/openapi.json) artifact.

## Attachments

The request composer accepts screenshots, PDF, plain text, CSV, ZIP, Word, Excel, and PowerPoint files. Limits are 25 MB per file and 100 MB per request.

Production upload sequence:

1. `POST /api/v1/requests/{id}/attachments` validates access, file type, and quotas and creates quarantined metadata.
2. The API returns a ten-minute, write-only user-delegation SAS URL.
3. The browser uploads directly to Blob Storage.
4. `POST /api/v1/attachments/{id}/complete` marks the file as scanning.
5. Defender for Storage or the selected scanning service posts the result to `/scan-result` using `ATTACHMENT_SCAN_WEBHOOK_SECRET`.
6. Download remains locked until `scan_state` is `Clean`. Every download re-checks access to the parent request.

Blob Storage is preferred over Azure Files here: the files are application objects, not a shared SMB filesystem. Use the hot access tier initially, ZRS in production, lifecycle rules for retained or deleted content, and never enable anonymous blob access.

## Database setup

Run the versioned migrations in order against the Pulse database with an Entra administrator:

1. [001_initial.sql](database/migrations/001_initial.sql)
2. [002_product_workflow.sql](database/migrations/002_product_workflow.sql)
3. [003_operational_hardening.sql](database/migrations/003_operational_hardening.sql)
4. [004_comment_attachments.sql](database/migrations/004_comment_attachments.sql)
5. [005_webhooks.sql](database/migrations/005_webhooks.sql)
6. [006_triage_tags.sql](database/migrations/006_triage_tags.sql)
7. [007_draft_context.sql](database/migrations/007_draft_context.sql)

For a local Azure SQL development database, optionally run [seed-development.sql](database/seed-development.sql).

After deploying the App Service, create a contained database user for its managed identity and grant only the permissions required by the application:

```sql
CREATE USER [<app-service-name>] FROM EXTERNAL PROVIDER;
ALTER ROLE db_datareader ADD MEMBER [<app-service-name>];
ALTER ROLE db_datawriter ADD MEMBER [<app-service-name>];
GRANT SELECT ON OBJECT::dbo.RequestNumber TO [<app-service-name>];
GRANT SELECT ON OBJECT::dbo.IdeaNumber TO [<app-service-name>];
GRANT SELECT ON OBJECT::dbo.ReleaseNumber TO [<app-service-name>];
```

Production migrations should run from a dedicated deployment identity with schema permissions; the web application identity should not own schema changes.

## Azure deployment

The repository includes a multi-stage [Dockerfile](Dockerfile) and [Bicep infrastructure](infra/main.bicep). The Bicep deployment creates App Service, Azure SQL, Blob Storage, Application Insights, and the Blob Data Contributor assignment for the web app identity.

```bash
az deployment group create \
  --resource-group <resource-group> \
  --template-file infra/main.bicep \
  --parameters namePrefix=<globally-unique-prefix> \
               containerImage=<registry/image:tag> \
               sqlEntraAdminLogin=<entra-admin-name> \
               sqlEntraAdminObjectId=<entra-admin-object-id> \
               entraClientId=<external-id-application-client-id> \
               entraTenantId=<external-id-tenant-id> \
               scanWebhookSecret=<strong-secret> \
               notificationJobSecret=<different-strong-secret> \
               webhookSigningSecret=<webhook-hmac-secret> \
               communicationEmailEndpoint=<acs-endpoint> \
               communicationEmailSender=<verified-mail-from-address>
```

Supplying `entraClientId` enables App Service Authentication and requires sign-in on every route except health and the separately secret-authenticated scan callback. Configure the External ID application for email one-time passcode and Entra federation before customer onboarding.

Before a production launch, replace the `AllowAzureServices` SQL firewall rule with private endpoint/VNet integration where required by the organization’s network policy, wire Defender for Storage events to the scan-result endpoint, and complete the backup-restore, accessibility, penetration, and load-test gates described in the PRD.

## Notification delivery

In-app and email notifications are inserted transactionally with the change that caused them. Configure Azure Communication Services Email with a verified domain, grant the App Service managed identity permission to send email, and invoke `POST /api/v1/internal/jobs/notifications` from a Logic Apps recurrence or Azure Functions timer every minute using the Key Vault-backed `x-pulse-job-secret`. The worker re-checks active user membership, emits localized content without confidential subject text, retries transient failures with exponential delay, and dead-letters after five attempts.

The same scheduler identity should invoke `POST /api/v1/internal/jobs/webhooks` every minute and `POST /api/v1/internal/jobs/retention` daily. Webhook deliveries use an HMAC-SHA256 signature over `<timestamp>.<raw-body>`, reject private-network destinations, retry with backoff, and expose no customer text in the event envelope. Retention first removes eligible private blobs, then hard-deletes expired soft-deleted records using the administrator-configured retention period.

## AI assistant + Slack

Pulse includes an optional AI assistant (in-app chat panel, plus a Slack bot for DMs and `@mentions`) built on the Anthropic API. Both surfaces share the same identity, tool permissions, and conversation history.

- Set `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`) to enable the assistant. Without it, the chat panel reports itself as unconfigured and the Slack integration never starts.
- Set `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` to additionally enable the Slack bot over Socket Mode. See [`docs/slack-setup.md`](docs/slack-setup.md) for the full walkthrough: creating the app from [`slack-app-manifest.yaml`](slack-app-manifest.yaml), generating tokens, the Slack-email-to-`dbo.Users.email` identity prerequisite, and verification steps.
- Slack Socket Mode and the assistant's in-memory caches require running a single App Service instance — see the comment on the plan/SKU in [`infra/main.bicep`](infra/main.bicep).
- Full environment variable and infrastructure parameter reference is (or will be) in `configInfo.md`.

## Validation

```bash
npm test          # TypeScript and focused domain checks
npm run lint      # React/Next linting
npm run build     # Azure-targeted standalone production build
```

The legacy `npm run build:sites` command remains for the original Sites preview shell, but Azure deployment uses `npm run build` and the standalone container.
