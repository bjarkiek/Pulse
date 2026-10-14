# Production hardening and acceptance

Implemented scope: P0-01–07, P1-08, P1-13, P2-01–03 from `ImprovementSuggestoin.md`.

## Configuration and rollout

1. Back up the database and apply migrations 001–015, in filename order, using the existing migration ledger. Do not rerun unguarded migrations. Use `sqlcmd -I` (QUOTED_IDENTIFIER ON) when running manually. Migration 013 intentionally clears old replay responses because they lack user/body bindings, and quarantines legacy Clean/Scanning attachments without byte-bound approval. Re-upload/rescan those files before use. Existing sessions without issuance milliseconds must sign in again after account revocation.
2. Runtime identity needs table SELECT/INSERT/UPDATE/DELETE and **UPDATE** on RequestNumber, IdeaNumber, ReleaseNumber and CommunicationNumber sequences (`NEXT VALUE FOR` requires UPDATE). Run schema changes with the separate deployment identity. `sp_getapplock` locks use transaction ownership, not session ownership.
3. Configure SQL, Blob Storage, `PULSE_SESSION_SECRET` (32+ characters), `MCP_TOKEN_SIGNING_KEY` (base64 encoding 64+ random bytes), scanner and job secrets (32+ characters), and HTTPS `PULSE_PUBLIC_URL`. Key Vault references must resolve before startup. Configure all values for each enabled provider. SendGrid is optional: `SENDGRID_API_KEY` and `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` may be left empty, but a value that is set must be resolved and non-blank. Without the API key production sends no customer communications. Demo data, local uploads, ephemeral MCP signing, trusted DC/EasyAuth headers, and disabled replay expiry are rejected in production.
4. Keep application-level authentication authoritative. Easy Auth forwards anonymously. Entra accounts use OIDC; only active provisioned OTP accounts can use email codes. Organization authentication policy and current memberships remain authoritative. Status/authentication changes revoke older sessions and MCP tokens.
5. Set `PULSE_TRUSTED_PROXY_HOPS` only after verifying the ingress overwrites/appends the expected forwarding chain and cannot be bypassed. No configured trust means a shared anonymous bucket. Authenticated limits use verified subjects. Limits live in SQL; expired rows are swept in bounded batches.
6. Build the digest-pinned Node image from the lockfile. Run `npm run verify` and `npm audit --omit=dev`. The legacy Sites toolchain is development tooling, not the Azure runtime. Revalidate the pinned image regularly; a clean npm audit does not replace image scanning.

## Scanning and recovery

Deploy `infra/scanning.bicep` **after** the app is reachable, supplying the existing storage account, public HTTPS URL and the same scanner secret as Key Vault. This enables billed Defender malware scanning with a configurable monthly cap. The template subscribes the authenticated `/api/v1/internal/attachments/scan-events` endpoint with a secret delivery header. The adapter validates account/container, event type, ETag and verdict; subscription validation never approves a blob. Source: [Defender event schema](https://learn.microsoft.com/en-us/azure/defender-for-cloud/defender-for-storage-configure-malware-scan#event-message-structure).

Completion captures the ETag. A verdict arriving first receives 503 for Event Grid retry. Replaced or terminal failed/infected versions cannot be approved by stale events. Download always supplies Blob If-Match for approved bytes; overwriting the upload therefore blocks download. Duplicate valid verdicts are idempotent. An infected record cannot be made clean through the completion endpoint.

Schedule the existing secret-protected retention job at least every five minutes. Scans pending for 30 minutes become Failed; uploads/quarantined failures older than 24 hours are marked deleted and removed from Blob Storage in batches. Deleted metadata cannot be revived by a late completion. A failed scan may be retried by re-uploading the file, then completing again; fresh upload triggers Defender. Configure an Event Grid dead-letter destination and alerting in staging before launch; investigate exhausted delivery retries and scan-cap events. The adapter remains fail-closed if scanning is unavailable.

Blob CORS in the main template permits the generated App Service origin. Add every actual custom browser origin explicitly; never use `*` with uploads. SAS URLs and webhook secrets must not appear in logs.

## API and client changes

- Idempotency keys are 8–100 safe characters, scoped to user, org, operation, path, body and If-Match. Changed payloads return 409. Replays reauthorize. SQL work and cached results share a transaction. Clients must keep the same key/body for a retry and use a new key for a new logical operation.
- Request/idea/release reads expose `version`. Request and idea edits, roadmap changes and idea/release publication require `If-Match: <version>`. Missing headers return 428; conflicts return 412. Read again and review the changed data before retrying. Chat and MCP tools use a required `version` input.
- JSON ingress is bounded to 64 KiB, 12 nesting levels, 250 array/object entries and 16,000 characters per string. Shared Zod repository schemas enforce product-specific limits, types and enums across API/chat/MCP. Two routes are exempt from this gate and read their own bodies: attachment upload (`PUT /api/v1/attachments/{id}/content`) and SendGrid's Event Webhook (`POST /api/v1/internal/communications/events`). The webhook verifies the signature over the raw signed body itself, and its batches (up to 1000 events, 1 MiB) exceed the limits above. It has a rate-limit group of its own.
- Errors return a support correlation ID. UI input stays present after a failed mutation. Device drafts are namespaced by authenticated user and org, expire after 24 hours, tolerate blocked storage, and clear on explicit sign-out. Server drafts take precedence. Successful request creation is retained while attachment uploads are retried.
- URLs preserve page and entity selection; back/forward restores them. Dialogs trap focus, support Escape and restore focus. Internal UI labels use the Icelandic catalog, while stored enum values stay English.

## Verification

`npm run verify` runs contract drift, typecheck/unit regressions, lint, and the production build. SQL tests are opt-in and require a **disposable** database with all migrations applied:

```powershell
$env:PULSE_SQL_TEST = '1'
$env:PULSE_TEST_SQL_CONNECTION_STRING = '<test-only SQL connection string>'
npm run test:sql
```

For Windows LocalDB, install optional `msnodesqlv8` outside the app runtime, set `NODE_PATH` to that tools directory, `PULSE_SQL_NATIVE=1`, and `UV_THREADPOOL_SIZE=16` before running. Native ODBC lock waits occupy worker threads; too small a thread pool can starve concurrent test queries. Default Azure SQL uses the production Tedious driver.

Release acceptance still requires the actual Linux image, managed identity permissions, deployed ingress/CSP/embed flows, real ACS delivery, real SendGrid delivery with signed webhook events, Defender clean/infected/overwrite tests, a restore drill, and tenant-scale load tests. Native Icelandic review and a pilot with representative customer/internal users cannot be replaced by automated code checks. Record those results and owners before declaring general production readiness. Other P1 findings were not included in this implementation batch.

For local Chromium regression checks, run `node scripts/preview-security.mjs` in one
terminal and `node scripts/browser-smoke.mjs` followed by
`node scripts/browser-conflict-smoke.mjs` and `node scripts/browser-upload-smoke.mjs` in another. The preview deliberately clears
cloud configuration and uses synthetic development data on port 3107. Stop it afterwards.
The tests cover scoped drafts, dialogs, navigation, translated enum values and stale-edit
recovery; they do not substitute for deployed accessibility or language acceptance.

The full development dependency audit currently has four moderate findings through
legacy `drizzle-kit` / `@esbuild-kit/core-utils` / `esbuild`. No production dependency
findings remain. Do not expose that development server; the legacy tooling is excluded
from the supported production artifact. CI blocks high/critical findings in either scope.
