# Pulse implementation map

| PRD area | Implementation |
| --- | --- |
| Tenant isolation | Verified identity plus active membership check in `lib/server/auth.ts` and `request-repository.ts`; unauthorized entities return 404-style responses. |
| Customer intake | Responsive composer with two required fields, duplicate suggestions, SQL-backed user/company drafts plus device fallback, progressive context, visibility, revisions, and attachments. |
| Attachments | Allow list, 25/100 MB limits, private Blob keys, short-lived user-delegation SAS, quarantine, scanning callback, and authorization on download. |
| Product workflow | Safe staged publication, canonical request linking/merging, score snapshots, roadmap placement, releases, notification outbox with ACS delivery/retry worker, and audit inspection. |
| Administration | Companies, multi-company user roles, allowed authentication methods, attachment/retention/localization policy, and versioned score weights persist to SQL and emit audit events. |
| Azure SQL | Fifteen ordered migrations cover the core domain, drafts, revisions, links, interests, comments, releases, saved views, notification delivery state, scores, audit, idempotency, and customer communications. |
| Azure deployment | Standalone Next.js container, App Service/SQL/Blob managed identity, Key Vault references, application-level DataCentral/Entra/OTP sessions, ZRS Blob Storage, Application Insights resource, TLS/security headers. |
| API hardening | OpenAPI 3.1 contract, correlation IDs, tenant-safe 404s, same-origin mutation checks, rate limits, and replayable idempotent create/publish operations. |

## Security boundaries

Identity and authorization are separate. Pulse validates signed application sessions and MCP bearer tokens, then checks the current active account, revocation timestamp, active membership, organization status, and operation permissions. Entra OIDC and provisioned email OTP are standalone login options; DataCentral supports embedded launches. Easy Auth, if present, forwards anonymously. Raw identity headers never authenticate production requests. See [production hardening](production-hardening.md).

Attachments inherit request visibility. Completion captures the uploaded ETag; authenticated scan verdicts must match it. Downloads use a conditional Blob read for the approved ETag. Atomic SQL quota reservation prevents parallel uploads exceeding the request limit. Retention processing fails timed-out scans and removes abandoned quarantine objects. The Event Grid adapter and separate scanner template are included; deployed scanner acceptance remains required.

## Local adapter

Only in development, when both `AZURE_SQL_CONNECTION_STRING` and `AZURE_SQL_SERVER` are absent, a process-local seeded adapter is used. When `AZURE_STORAGE_ACCOUNT_NAME` is absent, attachment bytes are held in the same process and marked clean after upload. This makes local development credential-free while leaving production code paths explicit. Neither fallback is durable or suitable for production.

## Remaining production operations

The repository is deployable, but the following environment/organizational launch gates cannot be completed in source code alone: External ID tenant and user-flow creation, outbound email provider/domain approval, Defender event wiring, private networking policy, backup-restore drills, penetration testing, WCAG audit, Icelandic copy review, and load testing against the expected tenant/data volume.

## Single-instance constraints

SQL-backed rate limits are shared across web processes and keyed by verified identity or explicitly trusted ingress IP. The MCP authorization-code/consent cache is still process-local, and Slack Socket Mode still requires one active worker. Keep one application instance until those separately scoped P1 items are implemented.

## Write consistency

Idempotency resolves current authorization before every lookup, scopes keys to user/organization/operation, and hashes the target, body, and If-Match. SQL application locks serialize retries; business writes and replay responses commit together. Requests, ideas, and releases expose an opaque `version`; edit and publication APIs require `If-Match`. Chat/MCP tools require the same observed version. SQL locks hold the version check through the write; stale clients receive 412 and must reread.

## Frontend

Feature modules separate customer views, request composition/details, triage, ideas, releases, analytics, companies, users, authentication, audit, and settings. Internal screens load dynamically. Shared controls, resource loading with cancellation/retry, and dialog focus behavior are in `app/features`. User/org draft keys expire after 24 hours; server copies take precedence. Production data failures never substitute client-side sample records.
