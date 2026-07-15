# Azure launch runbook

## 1. Build and publish

1. Run `npm test`, `npm run lint`, and `npm run build`.
2. Build the supplied multi-stage Docker image and publish it to the approved registry.
3. Generate independent high-entropy values for the scan callback, background jobs, and webhook HMAC signing.
4. Deploy `infra/main.bicep` with the parameters shown in `README.md`.

## 2. Database

1. Run migrations `001` through `007` in order using a dedicated deployment identity.
2. Create a contained Azure SQL user for the App Service managed identity.
3. Grant `db_datareader`, `db_datawriter`, and `SELECT` on the three public-number sequences; do not grant schema ownership.
4. Verify point-in-time restore configuration and complete a restore drill before pilot access.

## 3. Identity and authorization

1. Configure External ID email OTP and Entra federation with the deployed callback URLs.
2. Set the production client and tenant identifiers through Bicep; never place identity secrets in the client bundle.
3. Create the internal organization, system administrator membership, customer organizations, and explicit per-company memberships.
4. Verify cross-company denial for request, comment, attachment, search, export and notification APIs.

## 4. Attachments

1. Keep Blob public access and shared-key access disabled.
2. Enable Defender for Storage or an equivalent scanner on the private attachment container.
3. Deliver scan verdicts to `/api/v1/attachments/{id}/scan-result` with the scan secret.
4. Confirm a pending, infected, failed, or inactive-parent attachment cannot be downloaded.

## 5. Delivery jobs

Configure Logic Apps recurrence or a timer function to call with `x-pulse-job-secret`:

- `POST /api/v1/internal/jobs/notifications` every minute;
- `POST /api/v1/internal/jobs/webhooks` every minute;
- `POST /api/v1/internal/jobs/retention` daily.

Alert on dead-letter growth, job failures, high latency, and delivery backlog. Webhook consumers verify `x-pulse-signature` as HMAC-SHA256 of `<x-pulse-timestamp>.<raw-body>` and reject stale timestamps.

## 6. Pilot sign-off

Complete the PRD launch gates in a production-like environment: WCAG 2.2 AA, supported browsers, load targets, malware scanning, authorization regression, penetration test, backup/restore, email deliverability, webhook retry, telemetry privacy, and an operator rollback exercise.
