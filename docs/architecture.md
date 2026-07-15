# Pulse implementation map

| PRD area | Implementation |
| --- | --- |
| Tenant isolation | Verified identity plus active membership check in `lib/server/auth.ts` and `request-repository.ts`; unauthorized entities return 404-style responses. |
| Customer intake | Responsive composer with two required fields, duplicate suggestions, SQL-backed user/company drafts plus device fallback, progressive context, visibility, revisions, and attachments. |
| Attachments | Allow list, 25/100 MB limits, private Blob keys, short-lived user-delegation SAS, quarantine, scanning callback, and authorization on download. |
| Product workflow | Safe staged publication, canonical request linking/merging, score snapshots, roadmap placement, releases, notification outbox with ACS delivery/retry worker, and audit inspection. |
| Administration | Companies, multi-company user roles, allowed authentication methods, attachment/retention/localization policy, and versioned score weights persist to SQL and emit audit events. |
| Azure SQL | Three ordered migrations cover the core domain, drafts, revisions, links, interests, comments, releases, saved views, notification delivery state, scores, audit, and idempotency. |
| Azure deployment | Standalone Next.js container, App Service/SQL/Blob managed identity, Key Vault references, optional External ID authentication gate, ZRS Blob Storage, Application Insights resource, TLS/security headers. |
| API hardening | OpenAPI 3.1 contract, correlation IDs, tenant-safe 404s, same-origin mutation checks, rate limits, and replayable idempotent create/publish operations. |

## Security boundaries

Identity and authorization are intentionally separate. In Azure, App Service Authentication validates the configured External ID application. Pulse then verifies an active `Membership` for the selected company on every data operation. Multi-membership users explicitly select an authorized context, stored in an HTTP-only cookie. Storage keys include organization/request context for operations, but opaque database UUIDs remain the authoritative identifiers.

Attachments inherit request visibility and are not copied to ideas. The browser receives write-only SAS permissions; upload completion verifies the Blob size, and reads pass through Pulse so membership and scan state can be rechecked. Production storage scanning should use Defender for Storage malware scanning with an Event Grid/Function adapter that validates the event and calls the constant-time-secret-protected scan-result endpoint.

## Local adapter

When `AZURE_SQL_CONNECTION_STRING` is absent, a process-local seeded adapter is used. When `AZURE_STORAGE_ACCOUNT_NAME` is absent, attachment bytes are held in the same process and marked clean after upload. This makes local development credential-free while leaving production code paths explicit. Neither fallback is durable or suitable for production.

## Remaining production operations

The repository is deployable, but the following environment/organizational launch gates cannot be completed in source code alone: External ID tenant and user-flow creation, outbound email provider/domain approval, Defender event wiring, private networking policy, backup-restore drills, penetration testing, WCAG audit, Icelandic copy review, and load testing against the expected tenant/data volume.

## Single-instance constraint: MCP OAuth cache, proxy rate limits, and Slack Socket Mode

Three components require Pulse to run as a single instance. The MCP authorization-code/consent cache (`lib/server/mcp/code-cache.ts`) and the DataCentral proxy's rate limiter both keep their state in an in-memory `globalThis` map, which is correct only because Pulse runs as a single-instance App Service (P1v3, capacity 1, alwaysOn). Slack's Socket Mode integration adds a third: it holds a single persistent WebSocket connection from the process to Slack, so running multiple instances would either duplicate event handling (each instance opening its own socket and double-processing messages) or require Slack's own connection-count limits to arbitrate — neither of which Pulse's Socket Mode client coordinates across instances. If the app is ever scaled out to multiple instances, the OAuth cache and rate limiter must move to a shared store (e.g. Azure SQL or Redis), and Slack must move off Socket Mode to an HTTP Events API endpoint (or a dedicated single-instance worker) — a load-balanced deployment would otherwise let requests land on different instances and see inconsistent cache/rate-limit state or duplicated Slack event handling.
