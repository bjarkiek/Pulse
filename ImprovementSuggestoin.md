# Pulse: production readiness review and improvement suggestions

Review date: **17 September 2026**  
Repository: `C:\VS Code\Pulse`  
Reviewed baseline: `main`, commit `8fb6d90`, including the existing working-tree edits to `app/globals.css`, `infra/DEPLOY.md`, and `infra/deploy.ps1`.

## Implementation update — selected batch

**Implemented locally on 17 September 2026:** all P0 items, P1-08, P1-13, and all P2 code/documentation work. The findings below are the original review baseline, not a description of the updated source. External acceptance work remains open; this is not a production readiness sign-off or a deployment.

| Item | Implemented change | Evidence / remaining acceptance |
| --- | --- | --- |
| P0-01 | Caller/org/body/target-bound replay keys, authorization before replay, expiry reuse, and one SQL transaction for business work plus response recording. | Memory and SQL retry/conflict/revocation/rollback regressions pass. |
| P0-02 | Shared active-account enforcement, authentication-policy checks, session issuance/revocation timestamps and MCP refresh/access-token checks. | Revocation and protected repository tests pass; repeat the complete cookie/bearer journey in staging. |
| P0-03 | ETag-bound completion, scan verdicts and downloads; serialized SQL quota reservations; authenticated Defender Event Grid adapter; CORS and quarantine cleanup. Migration 013 invalidates legacy approvals without an ETag. | SQL stale-verdict/quota tests, Bicep compilation and browser upload-retry test pass. Real Defender, malicious-file, overwrite, Blob CORS and cleanup acceptance remain required. |
| P0-04 | Updated Next.js/React and dependencies, pinned Node image digest, lockfile and CI security/build gates. | Production npm audit: zero vulnerabilities. Four moderate findings remain in legacy development tooling; see the hardening runbook. Linux CI/container build and image scanning remain required. |
| P0-05 | Production startup requires durable SQL/Blob and stable secrets, validates enabled providers, and rejects demo identity, trusted identity-header shortcuts and local/ephemeral adapters. | Configuration regressions pass; verify resolved Key Vault references and managed identity in staging. |
| P0-06 | HMAC OTP digests, SQL issuance/verification locks, atomic attempt/consume rules, generic start responses, shared throttling, and checked ACS send outcomes. | OTP and SQL concurrency regressions pass. Actual ACS delivery remains unverified. |
| P0-07 | User/org-scoped expiring device drafts, safe storage handling, server-first restoration, logout cleanup and explicit server draft-owner checks. | Storage isolation tests and browser save/reopen checks pass. |
| P1-08 | SQL-backed bounded rate limits using verified subjects/trusted ingress; DNS-pinned public-only HTTPS webhooks; nonce CSP; bounded DC launch expiry. | Address, spoofed-header, rate-limit, CSP and expiry regressions pass. Deployed proxy/embed/CSP acceptance remains required. |
| P1-13 | Shared Zod schemas, bounded JSON ingress, server-side role restrictions, row versions and conditional request/idea edits, roadmap changes and idea/release publication across REST/chat/MCP. | Wrong-type/body-limit and SQL lost-update tests pass; browser 412 recovery retains edits and requires rereading the latest version. |
| P2-01 | Replaced the monolithic page with feature modules, shared UI/hooks/API errors, reusable dialog behavior and lazy-loaded internal screens; formatted routes/features/CSS. | Typecheck, lint, build and browser workflow checks pass. |
| P2-02 | Updated migrations/auth/sequence grants/rotation/target documentation; generated OpenAPI from the route inventory and shared schemas; added contract drift checks. | All 57 API paths are inventoried and references resolve. Some less critical operation bodies remain generic object schemas; this is not exhaustive response conformance testing. |
| P2-03 | Expanded Icelandic catalog, scoped draft status, scan polling/retries, administrator delivery status/requeue, preserved edit/upload input, page/entity history URLs and support IDs. | Browser draft/dialog/navigation/locale/conflict/upload tests and SQL delivery authorization/requeue tests pass. Native Icelandic review and customer/internal pilot remain outstanding. |

### Verification of the implemented batch

- `npm run verify`: **209 tests passed**, zero failures/skips, TypeScript and contract drift checks passed, lint passed without warnings, production standalone build passed.
- Disposable Windows SQL LocalDB: **9 SQL tests passed**; migrations **001–014** also applied successfully to a separate fresh database. Production uses the Tedious driver and Azure managed identity, so deployed acceptance remains separate.
- Chromium: draft persistence, dialog focus/Escape, history navigation, Icelandic enum values, conflict/reload/save and failed-upload retry passed. No duplicate request or attachment reservation was created by the upload retry.
- `npm audit --omit=dev`: **0 vulnerabilities**. Full development audit: **4 moderate**, no high/critical findings, confined to the legacy Drizzle/esbuild tooling chain.
- Both Bicep templates compiled. The scanner template reports one secure-input linter warning on the public endpoint URL; its authentication secret is separately marked secure.
- No Azure deployment, external email/webhook delivery, customer-data mutation or Linux image execution was performed.

Deploy only after reviewing [the hardening and acceptance runbook](docs/production-hardening.md). Apply migrations 013–014 before this application version; migration 013 clears legacy idempotency responses and quarantines legacy Clean/Scanning attachments for re-upload/rescan. Configure the scanner subscription, scheduled jobs, dead-letter handling and alerts, then record actual integration results. The other P1 findings and release checklist below remain open unless independently accepted.

## Original review baseline

## Overall assessment

**Pulse has a substantial pre-production implementation, but should not yet be considered production ready.** The core product is implemented and its existing tests pass. The main remaining work concerns authorization consistency, attachment integrity, production configuration, dependency security, recovery, and evidence from the actual Azure deployment.

This review found concrete code issues as well as operational requirements that still need verification. Passing the existing tests does not resolve the findings below: much of the current suite exercises the memory adapter, while production uses different SQL implementations.

This was a source/configuration review with local checks and a live dependency audit. No Azure resources were changed, no deployment was performed, and no live customer data or credentials were used. Azure configuration, external integrations, browser accessibility, load capacity, backup recovery, and production acceptance remain unverified. Existing local edits were preserved.

## Baseline status and evidence

| Area | Current position |
| --- | --- |
| Product | Customer requests and drafts, comments and attachments, idea publication, triage, roadmap/release workflows, notifications, analytics, administration, tours, and English/Icelandic localization are implemented. |
| Integrations | Entra sign-in, email OTP, DataCentral embedding, Anthropic chat, Slack Socket Mode, and an MCP server with OAuth are present. Live operation was not verified. |
| Architecture | Next.js 16.2.6 / React 19.2.6, TypeScript, Azure SQL, Blob Storage, App Service, and a standalone container. A legacy Sites/Vinext path also remains. |
| Security foundations | Parameterized SQL, repository role/membership checks, signed sessions, OAuth PKCE, hashed refresh tokens, private attachments, short-lived SAS, same-origin checks, and audit records are present. The implementation gaps below still matter. |
| Deployment foundations | Bicep, Key Vault references, managed identities, ZRS attachment storage, a non-root container, and PowerShell provisioning/deployment scripts exist. |
| `npm test` | **Passed: 196 tests, 0 failures, 0 skipped**, including TypeScript checking. |
| `npm run lint` | **Passed with 2 warnings**: unused `url` in `app/auth/callback/route.ts:22` and unused `meUser` in `app/page.tsx:797`. |
| `npm run build` | **Passed:** Next.js production compilation, TypeScript, static page generation, and standalone output completed. This local Windows build does not establish Linux-container or deployed-service acceptance. |
| `npm audit --omit=dev --json` | **Failed security gate: 12 affected packages — 1 critical, 7 high, 4 moderate.** This is a package count, not a count of independently exploitable application vulnerabilities. |
| Additional isolated check | Reproduced idempotency replay across two different user IDs in the same organization: the second caller received the stored response and the authorization/work callback was not invoked. This check used synthetic data and the memory adapter; the SQL replay branch has the same authorization ordering. |
| API contract inventory | 55 `/api/v1` route files versus 45 documented OpenAPI paths; 10 implemented paths are missing from the contract. This was a path inventory, not full request/response conformance testing. |
| Runtime used for checks | Windows, Node.js `22.21.1`, npm `11.13.0`, existing installed dependencies. A clean Linux/container installation was not validated. |

## Priorities

- **P0 — launch blocker:** resolve before exposing the affected capability to real customer data. An optional feature can instead remain explicitly disabled until its gate passes.
- **P1 — production acceptance:** required for a supported general release; any deferral needs an owner, a documented impact, and a restricted operating scope.
- **P2 — planned improvement:** maintainability and product quality work that can follow the security and operational gates.

The owner roles below are suggestions. There is no reliable delivery estimate until the team selects scope and validates the SQL/integration findings in staging.

## P0: resolve before customer launch

### P0-01 — Authorize every idempotent request, including replays

**Evidence:** [idempotency.ts](lib/server/idempotency.ts), particularly lines 36–69, and [request creation route](app/api/v1/requests/route.ts). The key is scoped by organization, operation, and caller-supplied key, but not user or request-body fingerprint. The route calls `executeIdempotent` before `createRequest` performs membership authorization. A stored result returns without executing that authorization. Similar wrappers exist on internal idea/release operations.

**Impact:** a caller who knows or reuses an existing key can obtain the cached response despite changed permissions; another user can collide with a private response. The organization is still an unverified request hint at lookup time. A caller with a single membership but no organization hint can also reach the SQL key insert before its actual organization has been resolved.

**Improve:** resolve an active account and authorized organization before any cache access; recheck operation/resource authorization on replay; bind keys to user, organization, operation, target, and a canonical body hash. Reject changed payloads with a conflict. Make result recording atomic with the business transaction or use a recoverable operation record. Currently a crash can leave a pending key, and failure after the business commit but before result persistence can allow duplicate work. Expired SQL keys are excluded from reads but still occupy the primary key; add safe expiry cleanup/reuse.

**Done when:** SQL-backed tests cover different users, different organizations, revoked access, missing organization context, changed payloads, concurrent retries, expiry, and a crash between business commit and response recording. One authorized logical operation produces one business result.

Suggested owner: backend/security.

### P0-02 — Enforce disabled-account status on every protected path

**Evidence:** [authorization.ts](lib/server/authorization.ts):19,42 checks memberships and organizations without joining `dbo.Users` to require `status='Active'`. [auth.ts](lib/server/auth.ts) accepts a valid session without consulting account status. [identity-repository.ts](lib/server/identity-repository.ts) does check the user, but it is not the common entry point for all APIs. [admin-repository.ts](lib/server/admin-repository.ts), `saveUser`, can save a disabled user while rebuilding active memberships. Chat history GET/DELETE also use the session identity directly.

**Impact:** disabling an account does not reliably terminate access through an already-issued session; sessions last 12 hours. The MCP handler has a stronger per-request account check than several ordinary APIs.

**Improve:** establish one reusable active-account check for API, chat, internal/admin, attachment, and tool execution. Keep the existing resource-level authorization. Add session revocation/versioning where required, and define how changing authentication policy invalidates existing sessions.

**Done when:** disable a signed-in customer and administrator without removing memberships; their existing cookies and bearer tokens immediately fail every protected read and mutation, including cached replays and chat history.

Suggested owner: backend/security.

### P0-03 — Bind malware approval to the exact attachment bytes

**Evidence:** [blob-storage.ts](lib/server/blob-storage.ts):40 grants `cw` permissions for ten minutes. Completion verifies only length. The [scan-result route](app/api/v1/attachments/[id]/scan-result/route.ts) approves an attachment ID without an ETag, version, or digest; [content download](app/api/v1/attachments/[id]/content/route.ts) reads the current blob by key.

**Impact:** a blob approved as clean can be overwritten while the SAS remains usable. A delayed scan result can then authorize bytes different from those scanned. There is also no complete scanner/Event Grid adapter in the supplied infrastructure, so end-to-end scanning remains a deployment dependency.

**Improve:** keep uploads in quarantine and publish an immutable scanned version to a separate read location, or record and enforce the scanned blob version/ETag on every read. Bind scan events to the upload/version and validate transitions, duplicate events, and out-of-order delivery. Add scan timeouts, failed-scan recovery, abandoned-upload cleanup, and atomic quota reservation. Configure browser Blob CORS for the actual application origins.

**Done when:** an actual staging upload is blocked before approval; overwriting after approval never exposes unscanned bytes; stale/duplicate verdicts cannot release a replacement; infected files remain blocked; authorized uploads/downloads work from the deployed browser origin.

Suggested owner: backend/platform/security.

### P0-04 — Remediate the current dependency audit

**Evidence:** [package.json](package.json), [package-lock.json](package-lock.json), and the audit run during this review. Affected package entries include `next`, `sharp`, `postcss`, `fast-uri`, `fast-xml-parser`, `ip-address`, `ws`, `hono`, `@hono/node-server`, `qs`, and `baseline-browser-mapping`.

The pinned Next.js `16.2.6` falls within published critical advisories. The maintainer identifies `16.3.3` as a patched version for the [AVIF image-optimization issue](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4); the audit currently proposes `16.3.5` as its Next.js fix. The separate [Windows-hosted server advisory](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36) applies to Windows hosting, whereas the intended deployment here is Linux. Exposure depends on reachable features and deployment; this review did not demonstrate exploitation.

**Improve:** upgrade Next.js and compatible dependencies in a dedicated change, refresh transitive packages through their supported parents, and rerun the audit, regression tests, and Linux image build. Audit development/build dependencies separately and scan the resulting image. Pin the container base to a reviewed version/digest with an update process. Do not apply an unreviewed forced audit fix.

**Done when:** no unresolved applicable critical/high advisories remain in the shipped image; any exception has a documented reachability assessment, owner, and expiry. Recheck versions at implementation time because advisory data changes.

Suggested owner: engineering/platform.

### P0-05 — Make production configuration fail closed

**Evidence:** [database.ts](lib/server/database.ts):11–29 allows content to switch to memory when SQL is absent or the runtime `showDemoData` setting is enabled. [settings-repository.ts](lib/server/settings-repository.ts) exposes that setting without an environment restriction. The [local attachment PUT](app/api/v1/attachments/[id]/content/route.ts) stores bytes in memory and marks them clean whenever Blob configuration is absent. [MCP token signing](lib/server/mcp/tokens.ts) falls back to an ephemeral signing key even in production.

**Impact:** partial configuration can silently produce non-durable content or bypass actual attachment scanning. A production administrator can switch real users onto an ephemeral content store. The demo request-list path also omits the SQL path's private-request visibility predicate. These risks are distinct from demo identity: demo identity is already blocked when SQL is configured.

**Improve:** validate required configuration at startup and readiness time: durable SQL, Blob, public HTTPS origin, valid session/signing secrets, and required enabled-feature dependencies. Reject unresolved Key Vault references. Disable demo content and local clean-upload shortcuts in production; provide a separately deployed demo environment. Reject invalid replay-window settings and unsafe trust flags. Disabled optional integrations should be explicit rather than partially configured.

**Done when:** removing any required setting fails readiness with an operator-readable error; no production configuration combination enables memory-only customer writes, synthetic administrator identity, or automatic clean verdicts.

Suggested owner: backend/platform.

### P0-06 — Make OTP issuance and verification atomic and abuse resistant

**Evidence:** [otp-login.ts](lib/server/otp-login.ts):54–70 counts recent issues separately from invalidation/insertion; lines 92–111 select a code and then update attempts or consumption in separate statements. Concurrent requests can pass the same checks. [OTP start](app/auth/otp/start/route.ts) returns 429 only for an eligible account after repeated issuance, while unknown accounts keep returning 200, undermining the stated anti-enumeration behavior. `/auth/*` bypasses the proxy's API limiter. Successful memory verification deletes the issuance history too.

**Improve:** atomically claim/consume a valid SQL code with expiry and attempt predicates; serialize issuance per normalized account and preserve a separate issuance ledger. Add bounded IP/account/global limits with consistent outward responses for eligible and ineligible accounts. Validate exact input types, email length, and six-digit code format. Use a keyed digest to protect the small code space if the code table is exposed. Track the ACS send operation and failures rather than discarding the poller returned by `beginSend`; see [Microsoft's email sending guidance](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/email/send-email).

**Done when:** parallel redemption permits one success, parallel issuance never exceeds its limit, attempt caps hold under concurrency, account existence cannot be inferred through the fourth request's response, and a failed email submission is observable and recoverable. Use real SQL tests rather than only the memory adapter.

Suggested owner: backend/security.

### P0-07 — Isolate device drafts by user and organization

**Evidence:** [app/page.tsx](app/page.tsx):2665,2708,2819 uses the single browser key `pulse-request-draft`. It restores that draft before the server response and leaves it in place if the server has no draft. [logout](app/auth/logout/route.ts) only clears the session cookie/redirects.

**Impact:** another person using the same browser profile, or a user switching company context, can see a previous private draft and potentially submit it under the wrong organization.

**Improve:** prefer the server draft; if device fallback is retained, namespace it by verified user and organization, include expiry, clear it on logout, and reset pending draft state when context changes. Do not restore a draft until identity/context is known. Handle blocked browser storage without breaking the composer.

**Done when:** switch between two organizations and two accounts on one browser, including offline/server-error scenarios; no previous account/company draft is displayed or submitted.

Suggested owner: frontend/security.

## P1: production acceptance work

### P1-01 — Separate liveness from readiness and recover SQL connections

**Evidence:** [health route](app/api/health/route.ts) always returns `status: "ok"` and only tests whether environment variables exist. Both Bicep and the deploy script depend on it. [database.ts](lib/server/database.ts):48 caches the connection promise without clearing an initial rejected promise; startup settings errors are swallowed in [instrumentation-node.ts](instrumentation-node.ts).

**Improve:** keep a cheap liveness endpoint and add readiness that checks required schema version and bounded SQL/Blob access. Report optional integration degradation separately. Reset failed pool initialization safely, handle pool errors, and close resources on shutdown. Deployments should also run an authenticated protected-resource smoke check. [App Service health guidance](https://learn.microsoft.com/en-us/azure/app-service/monitor-instances-health-check) describes checking critical dependencies.

**Done when:** invalid SQL permissions, missing migrations, or inaccessible storage prevent readiness; a transient startup SQL failure recovers without restarting the application; authenticated create/read succeeds after release.

### P1-02 — Recover interrupted notification and webhook jobs

**Evidence:** [notification-worker.ts](lib/server/notification-worker.ts):74 and [webhook-worker.ts](lib/server/webhook-worker.ts):24 mark rows `Processing`, but subsequent claims select only `Queued`/`Retry`. No expired processing lease/reclaimer was found. Schedulers are described in the runbook but are not provisioned in `main.bicep`.

**Improve:** add claim ownership, lease expiry, recovery, bounded execution time, and safe retry semantics. Retain stable delivery IDs and handle the case where a provider accepted a send before the SQL update failed. Add scheduler configuration, backlog/dead-letter dashboards, and audited replay controls. Track email provider completion/delivery status accurately.

**Done when:** killing a worker after claim or after provider acceptance does not strand work; a restart recovers the backlog; duplicate deliveries are controlled; real email/webhook failures alert an operator.

### P1-03 — Make migrations recoverable and verifiable

**Evidence:** [infra/deploy.ps1](infra/deploy.ps1):279–299 tracks migration filenames only and records completion in a separate call after the migration file commits. A process/connection failure between those steps leaves changed schema with no tracking row. Some migrations contain unconditional DDL, so retrying is not universally safe despite the deployment guide's broad idempotency claim.

**Improve:** add a deployment lock, checksums, transactional migration/tracking where supported, and explicit recovery for uncertain outcomes. Use expand/contract changes compatible with the previous application version. Keep schema credentials separate from runtime credentials. Test both a clean database and upgrade from the previous release.

**Done when:** interrupted and concurrent migrations have a deterministic recovery path; modified applied migrations are detected; rolling back the application still works against the upgraded schema.

### P1-04 — Establish enforced CI and production-path integration tests

**Evidence:** the checkout has no checked-in GitHub Actions or Azure Pipeline definition. `npm test` passes, but SQL, storage, scanner, email, actual browser flows, and real AI responses are not established by that run. The screenshot utility and legacy rendered-HTML test are not an Azure-targeted browser acceptance suite. Remote branch rules/pipelines were not inspected.

**Improve:** add a clean Linux CI job running installation, type checking, lint, unit tests, dependency/image scans, migration checks, and standalone build. Add disposable SQL integration tests for authorization, idempotency, OTP races, retention, and outbox recovery. Add browser tests for customer/admin roles, company switching, uploads, Entra/OTP, blocked third-party cookies, and MCP consent. Require relevant checks before merge/release.

**Done when:** a clean checkout passes the same gates as the release image, and deliberately breaking SQL authorization or a critical user journey fails CI.

### P1-05 — Make releases immutable and deployment failure explicit

**Evidence:** [infra/deploy.ps1](infra/deploy.ps1) builds the working directory using the current Git SHA as the default tag, also writes `latest`, directly changes the live app image, restarts it, and merely warns if health never succeeds. Dirty builds can share the same commit tag. No staging-slot acceptance or automatic rollback path is defined in this script.

**Improve:** build once from a recorded clean commit in CI, deploy by immutable digest, record schema/image versions, and fail the process with a nonzero exit when acceptance fails. Warm and test an isolated staging deployment before promotion. Plan slots carefully: staging and production must not both consume the same Slack socket/jobs. Retain the previous image and a tested rollback command.

**Done when:** failed acceptance blocks promotion and reports failure to automation; operators can identify exact running source/image versions and restore the previous release within the agreed recovery target.

### P1-06 — Prove telemetry and alert delivery

**Evidence:** [infra/main.bicep](infra/main.bicep) creates Application Insights and supplies its connection string. The checked-in application instrumentation starts settings/Slack, but no application telemetry SDK/OTel wiring or alert definitions were found. Platform-side instrumentation may exist externally; it was not verified. Repository audit operations often create fresh correlation IDs instead of propagating the request ID.

**Improve:** explicitly instrument requests, SQL/storage dependencies, errors, job durations/backlogs, sign-in failures, and AI latency/usage. Carry one validated correlation ID through HTTP, tools, SQL audit records, and jobs. Define dashboards, availability probes, alert owners, and escalation. Redact request text, tokens, email addresses, filenames, and SQL parameter values; avoid logging raw exception messages that can contain sensitive values.

**Done when:** a synthetic failed request/job can be traced end to end and an alert reaches the responsible person. Verify telemetry redaction with deliberately sensitive synthetic data.

### P1-07 — Decide and test the availability model

**Evidence:** [docs/architecture.md](docs/architecture.md) explicitly restricts operation to one instance because OAuth consent/code caches, rate limiting, and Slack integration hold process state. The Bicep plan has capacity 1. The PRD targets 99.9% monthly availability. Chat and demo settings introduce additional process-local behavior to consider.

**Improve:** either document a restricted single-instance pilot with measured restart/recovery behavior, or move shared state to a durable shared store and isolate Slack/background workers with coordinated ownership. Test process overlap during deployments as well as normal scale-out. Select capacity and redundancy from measured load and the agreed availability target.

**Done when:** restarting or replacing a process has a measured customer impact within the accepted target; any multi-instance design passes login, OTP/OAuth, limiting, and duplicate-work tests. Increasing App Service instance count alone is not sufficient.

### P1-08 — Strengthen request abuse controls and outbound URL validation

**Evidence:** [proxy.ts](proxy.ts) uses unbounded process maps and caller headers such as `x-ms-client-principal-id` to choose rate buckets even though Easy Auth trust is disabled by default. Most `/auth`, `/oauth`, and `/mcp` paths return before the API limiter; OAuth registration has a separate in-memory limit. [webhook-repository.ts](lib/server/webhook-repository.ts) resolves DNS for validation, then [webhook-worker.ts](lib/server/webhook-worker.ts) performs a new resolution when fetching; the custom address filter also leaves gaps for special-use IPv6 addresses. These are code risks, not a demonstrated production SSRF exploit.

**Improve:** derive identity from verified credentials and IP from an explicitly trusted ingress configuration; bound and expire limiter state and add shared limits for authentication, registration, MCP, and costly chat work. Validate all resolved addresses and pin the validated destination or enforce network egress controls; keep redirects disabled. Replace permissive script `unsafe-inline` CSP with a tested nonce/hash policy, including the hand-generated login/consent pages. Review the 60-minute DataCentral launch replay window and require live-session corroboration where the host supports it.

**Done when:** spoofed headers do not reset limits, unused buckets expire, private/special-use destinations and DNS changes cannot bypass outbound policy, and embed/login/consent still work under the tightened CSP.

### P1-09 — Bound queries and demonstrate performance at realistic volume

**Evidence:** [request-repository.ts](lib/server/request-repository.ts) lists all visible requests; `getRequest` loads that list and searches it in application memory. [search-repository.ts](lib/server/search-repository.ts) loads ideas and requests and runs fuzzy comparison in JavaScript. The PRD requires cursor pagination and P95 authenticated response below two seconds.

**Improve:** query a requested ID directly with the same visibility predicates, add cursor pagination and bounded projections, move search candidate selection into indexed SQL queries, and examine query plans/indexes with realistic organization sizes. Bound exports and add separate budgets for chat and upload workloads. Review frontend loading so inactive screens do not require unnecessary data.

**Done when:** an agreed realistic dataset and concurrent workload meet the PRD latency target with measured SQL CPU, pool use, application memory, and error rates. Record dataset size and load profile alongside results.

### P1-10 — Finish retention and deletion across all stored data

**Evidence:** [retention-worker.ts](lib/server/retention-worker.ts) handles selected soft-deleted content but has no cleanup for expired idempotency keys, old chat history, MCP clients/tokens, or delivery history. Comment revision deletion is independently limited before deleting parent comments, which can encounter remaining revision foreign keys. Multi-table cleanup is not wrapped in one SQL transaction.

**Improve:** define retention by data class, implement bounded restartable cleanup, and delete each selected entity's dependent rows consistently. Add orphaned/quarantined blob cleanup and retention metrics. Specify account export/deletion, audit retention, backup expiry, and AI/chat retention with the responsible data owner; do not assume content deletion removes all derived copies.

**Done when:** a large synthetic dataset with many revisions cleans successfully across repeated batches and injected failures; expired operational rows do not grow indefinitely; a requested account/content deletion has documented, verifiable coverage.

### P1-11 — Complete infrastructure, backup, and secret-rotation acceptance

**Evidence:** [infra/main.bicep](infra/main.bicep) enables public network access for SQL, Blob, and Key Vault and includes `AllowAzureServices`; this does not make the private blob container anonymously readable, but network exposure requires an explicit decision. Job schedulers, scanner wiring, alerting, and restore evidence are not supplied by this template. Key Vault references use `secretUriWithVersion`, while deployment notes imply that updating a secret and restarting is sufficient.

**Improve:** inspect/reuse the actual deployed resources and compare them with the intended baseline. Restrict SQL/network access according to the agreed architecture, use least-privilege runtime permissions, and verify email/scan/job identities. Preserve a browser-accessible upload path if Blob private networking is introduced: direct browser SAS uploads cannot reach a private endpoint without network access. Define backup retention, RPO/RTO, and a joint SQL/Blob recovery procedure. Either use versionless secret references with controlled refresh or update pinned references during rotation; document overlapping-key handling. See [App Service Key Vault reference behavior](https://learn.microsoft.com/en-us/azure/app-service/app-service-key-vault-references).

**Done when:** restore and rollback drills meet agreed RPO/RTO, the approved network design supports actual customer uploads, and rotating session/MCP/embed/job/scanner credentials behaves as documented without an unplanned outage.

### P1-12 — Add explicit controls for AI actions, cost, and conversation scope

**Evidence:** [assistant-service.ts](lib/server/chat/assistant-service.ts) permits up to 16 tool iterations and 4,000 output tokens per iteration, with no application-level spend budget or per-user concurrency control. [chat-repository.ts](lib/server/chat/chat-repository.ts) scopes history only by user, so web/Slack and organization contexts share history. High-impact tools accept model-supplied confirmation booleans; they do not independently prove a user approved the exact action.

**Improve:** set per-user/organization budgets, deadlines, concurrency limits, usage accounting, and kill switches. Validate the configured model with a real staging request. Make conversation organization/channel scope explicit and re-evaluate retained context after access changes. Use server-issued, short-lived confirmation records bound to the exact high-impact action and current user, including publishing, merging, and permission changes. Add prompt-injection and retry evaluations, and decide what data may be sent to the provider.

**Done when:** a malicious request/comment/tool result cannot cause an unapproved destructive or externally visible action; repeated calls cannot duplicate changes or exceed configured budgets; removed organization access does not expose its previous chat context. AI can remain disabled while the core product launches.

### P1-13 — Validate input consistently and prevent lost updates

**Evidence:** many REST handlers pass `request.json()` directly to repositories relying on TypeScript shapes and selective checks. OTP uses a type assertion before calling `.trim()`. `serverActions.bodySizeLimit` is configured, but it is not evidence of limits on these route handlers. SQL requests and ideas already have `row_version` columns in [001_initial.sql](database/migrations/001_initial.sql), but reviewed update paths do not enforce them through `If-Match` or equivalent version checks.

**Improve:** use shared runtime schemas for API/tool inputs, enforce body/array/string limits, validate enums and allowed authentication methods, and map malformed input to safe 4xx responses. Return row versions and require them for edits/publish decisions; provide a useful conflict response. Enforce privileged role changes server-side rather than relying on UI options.

**Done when:** wrong JSON types and oversized input consistently fail before expensive work; two people editing the same object cannot silently overwrite each other; UI and MCP/API callers have equivalent validation and privilege rules.

### P1-14 — Complete real-browser and accessibility acceptance

**Evidence:** the PRD requires WCAG 2.2 AA and supported-browser acceptance. The application contains custom dialogs, navigation, tours, chat, uploads, and iframe authentication. Existing tests do not demonstrate full keyboard behavior, focus restoration, screen-reader announcements, mobile layout, or production third-party-cookie behavior.

**Improve:** test the main customer and internal journeys in supported browsers, including narrow screens, keyboard-only use, zoom, screen readers, reduced motion, failed uploads, expired sessions, and blocked third-party cookies. Verify focus trapping/restoration and Escape behavior on every dialog and tour. Combine automated checks with manual assistive-technology review.

**Done when:** documented browser/accessibility acceptance passes against the production-like deployed application, with no critical journey blocked and each remaining issue assigned an owner.

## P2: maintainability and product improvements

### P2-01 — Break up the main application module

[app/page.tsx](app/page.tsx) is approximately 6,700 lines and combines customer views, administration, triage, dialogs, network calls, and draft persistence. Extract feature modules, shared accessible dialog/form components, typed API helpers, and focused data hooks. Lazy-load infrequently used internal/admin features. Keep the current workflows and permissions covered while refactoring. Format compressed route/CSS code so changes can be reviewed reliably. Success means a feature can be changed and reviewed without touching an unrelated part of the main screen.

### P2-02 — Make documentation and the API contract match the current release

The README/runbook list migrations only through `007`, while the repository contains `001`–`012`; the architecture document still says three migrations. Older identity sections describe Easy Auth as authoritative, whereas current configuration uses application sessions. SQL sequence grant guidance differs between the README and the deployment script.

Update those documents and identify Azure as the supported production target, with an explicit support status for the legacy Sites/Vinext path and examples. The 10 missing OpenAPI paths cover onboarding/restore, taxonomy, chat/transcript, tours, and individual external-link/webhook operations. Generate or verify contracts against runtime schemas and test all required routes, security schemes, errors, and examples. Critical deployment-document corrections should be completed alongside P1-03/P1-11 rather than deferred as cosmetic work.

### P2-03 — Improve user feedback, localization, and supportability

Finish translation of remaining internal/admin labels and error messages; use a native Icelandic review for customer-facing wording. Make draft-save failures, upload/scan progress, background delivery failures, and retry actions visible. Preserve unsent work after session expiry. Add shareable URLs for the selected page/entity and predictable back-button behavior. Give support staff a safe way to locate a problem using a correlation ID without copying private request text. Verify these changes through a short customer and internal-team pilot.

## Suggested delivery order

| Batch | Work | Exit evidence |
| --- | --- | --- |
| 1. Close customer-data risks | P0-01 through P0-07. Keep affected optional features disabled until fixed. | Regression tests for each finding, current dependency audit, fail-closed configuration checks, and SQL-backed concurrency/authorization results. |
| 2. Make operation repeatable | P1-01 through P1-06 and P1-10/P1-11. | Clean CI/image build, recoverable migrations/jobs, protected-resource smoke check, working alert, restore and rollback records. |
| 3. Validate the supported release | P1-07 through P1-09 and P1-12 through P1-14. | Measured availability/load behavior, abuse/security review, enabled-integration acceptance, browser/accessibility sign-off. |
| 4. Improve maintainability and adoption | P2 work and pilot feedback. | Smaller feature modules, current documentation/contracts, reviewed localization, and resolved pilot blockers. |

For a smaller first release, defer AI, Slack, MCP, or external webhooks through explicit configuration and UI feature gates. This reduces the acceptance surface but does not remove the core authorization, attachment, durable-storage, dependency, OTP-if-enabled, or draft-isolation requirements.

## Release decision checklist

- [ ] Every P0 item is fixed and verified, or its affected optional feature is disabled and inaccessible.
- [ ] A clean Linux build and shipped container pass the required checks and vulnerability review.
- [ ] SQL-backed tests prove account revocation, tenant/private-record isolation, retry safety, and concurrent OTP behavior.
- [ ] A deployed customer completes sign-in, company selection, request creation, scanned attachment upload/download, and notification receipt.
- [ ] A deployed internal user completes triage, publication, and release communication with correct authorization and audit records.
- [ ] Enabled embed, AI, Slack, MCP, scanner, email, and webhook integrations pass their actual integration tests.
- [ ] Readiness detects broken required dependencies; jobs recover from interruption; alerts reach the operator.
- [ ] Restore, rollback, credential rotation, and incident procedures are exercised, with agreed availability/RPO/RTO and named owners.
- [ ] The PRD performance, accessibility, supported-browser, and security gates have recorded acceptance evidence.
- [ ] Support ownership, deployment notes, API documentation, retention decisions, and pilot sign-off are current.

Production readiness should be declared against this evidence for a specific release and environment, not against the presence of infrastructure files or a passing unit-test suite alone.
