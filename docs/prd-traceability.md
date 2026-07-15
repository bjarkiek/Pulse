# Pulse PRD traceability

This document maps the MVP and first-production-release requirements in `prd.md` to the implementation. P2 and explicitly later-release features remain outside the launch implementation.

| Requirement | Implementation evidence |
| --- | --- |
| FR-01 Authentication and organization context | App Service Authentication principal parsing, Azure SQL memberships, verified active-organization cookie, `/api/v1/me` and `/api/v1/me/context`, multi-company selector, tenant-safe not-found behavior. |
| FR-02 Role-aware dashboard | Customer and internal workspaces, role-gated API operations, organization-scoped counts and navigation. |
| FR-03 Request composer | Required validation, progressive context, private device/server drafts, 10-second autosave, revision history, editing/withdrawal, paste/drop attachments and upload progress. |
| FR-04 Duplicate discovery | Tenant-aware server search over published ideas and the caller's organization requests, stemming/misspelling ranking, match explanations, follow/support, linked-context creation, and dismissal events without customer text. |
| FR-05 Request detail/history | Authorized detail API, customer-safe audit timeline, stable `?request=` deep links, attachments, comments, edit/withdraw actions, and Needs information response path. |
| FR-06 Browse/search/filter/saved views | URL-backed customer filters and search, internal triage filters, private/shared saved-view API with shared publication restricted to system administrators. |
| FR-07 Following and organization interest | Idempotent follow/support endpoint, unique organization-interest records, private internal demand evidence, and recalculation when the last active request is withdrawn. |
| FR-08 Comments and notes | Customer/internal visibility, Markdown with safe links and no raw HTML, mentions, five-file comment attachments, revision history, edit window, moderation tombstones, and audit events. |
| FR-09 Internal triage | Split queue/detail workspace, SLA fields, customer questions, transactional linking, route-to-support reference, close explanation, and bounded audited bulk owner/tag updates. |
| FR-10 Canonical ideas/consolidation | Internal/staged/published fields, safe publication confirmation, transactional request links, merge aliases, and controlled audited link moves for split/repair. |
| FR-11 Prioritization | Configurable weighted score formula with versioned immutable snapshots, rationale, evidence inputs, and decision-support labeling. |
| FR-12 Status model | Separate request and idea state machines with role checks and evidence requirements for Planned, In progress, Released, support, and closure paths. |
| FR-13 Roadmap/releases | Explicit publication, Now/Next/Later roadmap, target/confidence history, releases, availability, notes, and requester/follower notification outbox. |
| FR-14 Notifications | Durable in-app/email records, channel deduplication, per-user/per-company cadence controls, mandatory immediate events, daily/weekly batching, localized en/is email, membership recheck, retry and dead letter handling. |
| FR-15 Analytics | Authorized summary for volume, areas, first response, triage time, delivery states and data quality; customer access denied; filtered server-side CSV with audit event. |
| FR-16 Administration | Organization, user, membership, auth-method, taxonomy, scoring, attachment, retention, locale, roadmap, webhook and notification-preference management without direct database access. |
| FR-17 Integrations/API | Versioned REST API and OpenAPI document, multiple HTTPS delivery links, signed HMAC webhook outbox with SSRF protection/retries, idempotency for create/consolidation/bulk mutations, and CSV export. |
| FR-18 Audit/retention/deletion | Material-change audit events, soft deletion, request withdrawal, configurable hard-delete worker, Blob deletion before database deletion, preserved non-content audit integrity, and controlled merge/link repair. |

## Automated evidence

- `tests/domain.test.mjs` verifies attachment policy and non-sequential storage keys.
- `tests/openapi.test.mjs` verifies the launch-critical API contract and declared idempotency requirements.
- `tests/workflow.test.ts` covers tenant isolation, roles, publication, linking, withdrawal demand, scoring, releases, drafts, comments/attachments, notifications, search, analytics, exports, taxonomy, saved views, merge aliases, bulk triage, and webhook SSRF rejection.

## Azure environment gates

These are deployment or assurance activities rather than missing application code:

- Configure the External ID application, email OTP user flow, Entra federation, redirect URIs, and production users.
- Create the Azure Communication Services Email resource/domain, verify the sender, and grant the App Service managed identity send permission.
- Enable Defender for Storage malware scanning and route scan results to the secret-authenticated callback.
- Run migrations with a deployment identity, create the contained App Service managed-identity database user, and grant least-privilege data access.
- Schedule notification/webhook delivery every minute and retention daily using the Key Vault-backed job secret.
- Apply the organization's private networking policy and replace the bootstrap Azure-services SQL firewall rule when required.
- Execute WCAG 2.2 AA, backup/restore, penetration, load, browser, and operational alert tests with the deployed production-like environment.

