# Customer communications (SendGrid emailer) — design

Status: draft for review · Date: 2026-10-13 · Author: Claude (with Bjarki)

## 1. Summary

Pulse gains a **Communications** subsystem: DataCentral staff compose branded customer emails (product updates, service notices, general announcements) from reusable templates, choose an audience built from Pulse's existing companies and memberships plus explicitly maintained contacts, preview and test-send, then send through **SendGrid**. Delivery, bounces, opens, clicks and unsubscribes flow back through the SendGrid Event Webhook and are visible per campaign and per recipient. Customer **Company admins** maintain their own company's recipient list inside Pulse, and every Pulse user controls their own subscriptions on the existing Updates page.

The first release is deliberately **semi-manual**: a person writes, reviews and presses Send. Scheduling, retries, suppression and tracking are automatic. Everything is built on the patterns Pulse already uses (SQL outbox + secret-protected worker job, JSON settings gated to System admins, audit events, en/is localization, in-memory dev mode, OpenAPI inventory).

## 2. How it fits into Pulse

Pulse already owns the pieces a customer emailer needs:

| Pulse today | Reused by Communications |
| --- | --- |
| `dbo.Organizations` (Customer / Partner / Internal), `dbo.Users`, `dbo.Memberships` with roles | The audience. Companies are the unit of targeting; members are default recipients. |
| `Company admin` role | Customer self-service: manages their company's contact list. |
| `dbo.NotificationPreferences` + the Updates page preference UI | Per-user opt-in/opt-out for communication topics. |
| Releases (`REL-###`, publish → notifications) | "Draft customer email from this release" pre-fills a product update. |
| Outbox workers (`notification-worker.ts`, `webhook-worker.ts`) and `POST /api/v1/internal/jobs/*` with `x-pulse-job-secret` | Same pattern for `CommunicationDeliveries` and `POST /api/v1/internal/jobs/communications`. |
| `dbo.Settings` JSON + Settings page (System admin) | SendGrid and sending policy configuration. |
| `dbo.AuditEvents`, `executeIdempotent`, `checkedMutation` (If-Match) | Audit trail, replay-safe Send, stale-edit protection. |
| Delivery status card (Settings) | Extended with the Communications channel. |
| `lib/i18n*.ts` en/is | UI strings and email chrome in both languages. |
| Chat assistant / MCP tool registry | Phase 2 tools (list campaigns, draft from release). |

Transactional email (OTP codes, request notifications) **stays on Azure Communication Services**. Broadcast communications go through SendGrid. Keeping the two separate isolates sender reputation (bulk traffic never affects OTP deliverability) and keeps the change surface small. A shared transport abstraction is listed under future improvements.

Placement in the product:

- Internal nav, "DataCentral team" section: new **Communications** page (between Releases and Analytics).
- Settings page: new **Customer communications (SendGrid)** card.
- Customer Updates page: communication topics join the existing notification preferences; Company admins additionally see **Company communication contacts**.
- Releases page: **Draft customer email** action on published releases.

## 3. Scope

### In scope (release 1)

1. Templates (code-defined, branded, en/is): `product-update`, `service-notice`, `plain` (general announcement).
2. Campaigns ("communications"): create, edit, duplicate, preview, test-send, audience estimate, send now or schedule, cancel, per-recipient delivery view, retry dead letters, stats.
3. Audience: selected companies or all customers; active members (filtered by topic preference and optional role filter) plus explicit contacts; global suppression list; safe-mode domain allow-list; test organisations excluded by default.
4. Contacts: per-company recipient list with name, email, locale, topics. Managed by System admins and Product managers for any company; by Company admins for their own company. Paste import (name, email per line).
5. Subscriptions: per-user topic toggles on the Updates page (reusing notification preferences); SendGrid unsubscribe group for one-click unsubscribe; webhook sync of unsubscribes, bounces and spam reports into the suppression list.
6. SendGrid integration: Mail Send v3 via `@sendgrid/mail`, batched personalizations, categories, custom args for correlation, sandbox mode, EU data residency option, Event Webhook with signature verification.
7. Settings: all non-secret options in the Settings page; secrets (API key, webhook verification key) in environment / Key Vault, with status shown in the UI and a "send configuration test" action.
8. Operations: worker job, Bicep parameters, `.env.example`, configInfo section, runbook jobs, README, migration `015`, OpenAPI inventory, tests, Icelandic strings.

### Out of scope (see §15 for the roadmap)

- WYSIWYG or database-stored template editor (templates are code; campaigns can be duplicated).
- Approval workflow (four-eyes) before sending.
- AI drafting / translation.
- Self-service preference centre for contacts who are not Pulse users (they use SendGrid's unsubscribe link).
- In-app archive of sent communications for customers.
- Migrating OTP / notification email from ACS to SendGrid.

## 4. Roles and permissions

Enforced server-side in repositories, exactly like the rest of Pulse (`requireInternalRole`, `requirePublishRole`, `requireMembership`). Unauthorised access returns the existing 404-style `FORBIDDEN`/`NOT_FOUND`.

| Capability | Customer member (Requester/Viewer) | Company admin | Internal contributor | Product manager | System admin |
| --- | --- | --- | --- | --- | --- |
| Manage own topic subscriptions (Updates page) | Yes | Yes | Yes | Yes | Yes |
| View / add / edit / remove **own company's** contacts | No | Yes | No | Yes | Yes |
| View / manage contacts of **any** company | No | No | Read | Yes | Yes |
| List campaigns, view deliveries and stats | No | No | Yes | Yes | Yes |
| Create / edit / duplicate / preview / test-send campaigns | No | No | No | Yes | Yes |
| Send, schedule, cancel, retry dead letters | No | No | No | Yes | Yes |
| Manage suppression list | No | No | Read | Read | Yes |
| Communication settings (SendGrid, policy, boilerplate) | No | No | No | No | Yes |

Rationale: sending a customer email is equivalent in weight to publishing a release, which Product managers already do. Settings and suppressions change who can ever be emailed, so they stay with System admins. A Company admin can never un-suppress an address (bounce/unsubscribe is global) and can only ever see their own company's list.

## 5. Concepts and data model

Migration `database/migrations/015_customer_communications.sql` (guarded with `IF OBJECT_ID(...) IS NULL`, `SET XACT_ABORT ON`, one transaction).

### 5.1 Topics

Fixed list in code (`lib/server/communications/topics.ts`):

| Topic key | Default template | Can members opt out? |
| --- | --- | --- |
| `product-updates` | `product-update` | Yes |
| `service-notices` | `service-notice` | Yes |
| `security-advisories` | `plain` | No (mandatory) |
| `general` | `plain` | Yes |

Member preferences reuse `dbo.NotificationPreferences` with new event types `communication.product-updates`, `communication.service-notices`, `communication.security-advisories` (mandatory), `communication.general`. Only `Immediate` and `Off` are meaningful for these; the UI renders them as on/off toggles. Default is on.

### 5.2 Tables

```text
dbo.CommunicationNumber            sequence → public ids COM-001 … (GRANT UPDATE like ReleaseNumber)

dbo.CommunicationContacts
  id                  uniqueidentifier PK
  organization_id     nvarchar(32) FK Organizations
  user_id             uniqueidentifier NULL FK Users      -- set when the contact mirrors a Pulse user
  email               nvarchar(320) NOT NULL              -- normalised lower-case
  display_name        nvarchar(200) NOT NULL
  locale              nvarchar(12) NOT NULL DEFAULT 'en'  -- 'en' | 'is'
  topics_json         nvarchar(max) NOT NULL CHECK ISJSON -- ["product-updates", …]
  status              nvarchar(32) NOT NULL DEFAULT 'Active'  -- Active | Unsubscribed | Bounced
  source              nvarchar(32) NOT NULL               -- Admin | Company admin | Import | Webhook
  note                nvarchar(500) NULL
  created_by_user_id  uniqueidentifier NOT NULL FK Users
  created_at / updated_at / deleted_at
  UNIQUE (organization_id, email) WHERE deleted_at IS NULL

dbo.CommunicationSuppressions                             -- global, keyed by e-mail
  email               nvarchar(320) PK
  reason              nvarchar(32) NOT NULL               -- Unsubscribed | Bounced | SpamReport | Manual
  source              nvarchar(32) NOT NULL               -- Webhook | Admin
  note                nvarchar(500) NULL
  created_by_user_id  uniqueidentifier NULL FK Users
  created_at

dbo.Communications                                        -- a campaign
  id                  uniqueidentifier PK
  public_id           nvarchar(32) NOT NULL UNIQUE         -- COM-###
  template_key        nvarchar(40) NOT NULL               -- product-update | service-notice | plain
  topic               nvarchar(40) NOT NULL
  title               nvarchar(200) NOT NULL              -- internal working title
  content_json        nvarchar(max) NOT NULL CHECK ISJSON -- { subject:{en,is?}, preheader?:{…}, body:{en:…, is?:…} }
  audience_json       nvarchar(max) NOT NULL CHECK ISJSON -- see §8.2
  status              nvarchar(32) NOT NULL DEFAULT 'Draft' -- Draft | Scheduled | Sending | Sent | Cancelled
  scheduled_at        datetime2 NULL
  started_at / completed_at / cancelled_at datetime2 NULL
  recipient_count     int NOT NULL DEFAULT 0              -- frozen at send time (excludes tests)
  release_public_id   nvarchar(32) NULL                   -- REL-### it was drafted from
  created_by_user_id / updated_by_user_id / sent_by_user_id FK Users
  created_at / updated_at / deleted_at
  row_version         rowversion                           -- If-Match via versions.ts

dbo.CommunicationDeliveries                               -- one row per recipient per campaign
  id                  uniqueidentifier PK
  communication_id    uniqueidentifier FK Communications
  organization_id     nvarchar(32) NULL FK Organizations   -- NULL for test sends
  email               nvarchar(320) NOT NULL
  display_name        nvarchar(200) NULL
  locale              nvarchar(12) NOT NULL
  source              nvarchar(16) NOT NULL               -- Member | Contact | Test
  user_id             uniqueidentifier NULL, contact_id uniqueidentifier NULL
  state               nvarchar(32) NOT NULL DEFAULT 'Queued'
      -- Queued | Processing | Retry | Accepted | Delivered | Deferred | Bounced | Dropped
      -- | Dead letter | Suppressed | Cancelled
  suppressed_reason   nvarchar(40) NULL                   -- Unsubscribed | Bounced | SpamReport | Manual | SafeMode | PreferenceOff
  attempt_count       int NOT NULL DEFAULT 0
  next_attempt_at     datetime2 NULL
  provider_message_id nvarchar(200) NULL                  -- SendGrid x-message-id
  last_event          nvarchar(32) NULL, last_event_at datetime2 NULL
  opened_at / clicked_at datetime2 NULL
  last_error_code     nvarchar(100) NULL
  created_at / accepted_at datetime2
  UNIQUE (communication_id, email, source)
  INDEX IX_CommunicationDeliveries_Work (state, next_attempt_at, created_at) INCLUDE (communication_id, locale, attempt_count)

dbo.CommunicationEvents                                   -- raw, idempotent webhook ledger
  sg_event_id         nvarchar(100) PK
  delivery_id         uniqueidentifier NULL FK CommunicationDeliveries
  event               nvarchar(32) NOT NULL
  email               nvarchar(320) NOT NULL
  occurred_at         datetime2 NOT NULL
  reason              nvarchar(500) NULL
  payload_json        nvarchar(max) NULL CHECK ISJSON     -- trimmed event (no headers)
  received_at         datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
```

Settings live in `dbo.Settings` under a new key `communications` (separate from `system`, with its own Zod schema and defaults) so the existing settings object does not grow and both can be saved independently.

### 5.3 In-memory mode

Every repository has the usual `isAzureSqlConfigured()` branch backed by `globalThis.pulseMemoryCommunication*` stores so local development and `node:test` work without Azure. The worker is written against a small `DeliveryStore` interface with SQL and memory implementations (unlike the existing workers, which are SQL-only) so its claim/retry/complete logic is unit-tested.

## 6. SendGrid integration and configuration

### 6.1 Secrets (environment / Key Vault only)

| Variable | Purpose |
| --- | --- |
| `SENDGRID_API_KEY` | Restricted API key with **Mail Send** permission only. Bicep `@secure()` param → Key Vault secret → App Service Key Vault reference, same as `ANTHROPIC_API_KEY`. |
| `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` | Verification key shown by SendGrid when "Signed Event Webhook" is enabled. Not secret, but environment-sourced so it cannot be changed from the UI. |

Secrets never enter `dbo.Settings`, the UI or logs; the Settings card only shows "configured / not configured". Storing an encrypted key in the database would need an application encryption key Pulse does not have today, so it is not proposed.

### 6.2 Settings (System admin, `dbo.Settings` key `communications`)

```ts
type CommunicationSettings = {
  enabled: boolean;                       // master switch for the worker and the Send action (default false)
  fromName: string;                       // default "DataCentral"
  fromEmail: string;                      // verified sender / authenticated domain; required when enabled
  replyTo: string;                        // optional
  dataResidency: "global" | "eu";         // sgMail.setDataResidency("eu") → api.eu.sendgrid.com
  unsubscribeGroupId: number | null;      // SendGrid ASM group → one-click List-Unsubscribe; required while enabled with safe mode off
  sandboxMode: boolean;                   // mail_settings.sandbox_mode (validate, do not deliver)
  safeMode: { enabled: boolean; allowedDomains: string[] };   // default on, ["datacentral.ai"]
  tracking: { opens: boolean; clicks: boolean };             // default both on
  dailyCap: number;                       // accepted deliveries per UTC day, default 5000
  maxRecipientsPerCampaign: number;       // default 5000
  categoriesPrefix: string;               // default "pulse"
  boilerplate: {
    en: { signOff: string; footer: string; supportEmail: string };
    is: { signOff: string; footer: string; supportEmail: string };
  };
};
```

The GET endpoint also returns derived, read-only status: `providerConfigured`, `webhookConfigured`, `webhookUrl` (`${PULSE_PUBLIC_URL}/api/v1/internal/communications/events`, for pasting into SendGrid), and `effectiveSendingState` (`disabled | provider-missing | sandbox | safe-mode | live`). The settings are for System admins, but the state is not secret: the audience estimate (`GET /{id}/audience`, §8.3) carries `effectiveSendingState` too, for every internal role, so the people who send see the warnings.

**Safe mode** is the main guard against an accidental blast: while on, recipients whose domain is not allow-listed are marked `Suppressed/SafeMode` at freeze time, and again when the worker claims a row that has been waiting since (§8.4), so turning safe mode on after a send holds back the rows still waiting; the review step shows the count. Production starts with safe mode on; a System admin turns it off deliberately, and only with an `unsubscribeGroupId` set (§6.5). `dailyCap` is a second brake, and a soft one: the worker stops claiming once the day's accepted count reaches the cap and the UI shows the backlog, but it reads that count once per run, so two runs that overlap can each use the room that was left.

### 6.3 Sending

- Transport module `lib/server/communications/sendgrid.ts` wraps `@sendgrid/mail` (pinned `8.1.6`). Interface:

  ```ts
  type MailTransport = {
    kind: "sendgrid" | "console";
    sendBatch(message: OutboundBatch): Promise<{ providerMessageId: string | null }>;
  };
  ```

  `createMailTransport(settings)` returns the SendGrid transport when `SENDGRID_API_KEY` is set, otherwise the console transport (logs a recipient count only — never addresses). Send, schedule and test send need the key in every environment (`INVALID_EMAIL_PROVIDER_CONFIGURATION` without it), so a delivery is never marked Accepted for mail that went nowhere; the console transport serves only the configuration test, outside production (§11).
- One SendGrid request per (campaign, locale, batch of ≤ 500 recipients): shared `subject`, `html`, `text`, `from`, `reply_to`, `categories: ["<prefix>", "<prefix>-<topic>", "<COM-id>"]`, `asm.group_id`, `tracking_settings`, `mail_settings.sandbox_mode`, and one `personalizations[]` entry per recipient carrying `to` and `custom_args: { deliveryId, communicationId }`. The response's `x-message-id` is stored on every delivery in the batch.
- Failures are per request: `429` or `5xx` → every delivery in the batch goes to `Retry` with exponential backoff (honouring `Retry-After`); `4xx` other than 429 → `Dead letter` with the SendGrid error code (configuration errors are not retried); after 5 attempts → `Dead letter`. Dead letters are retried from the campaign page or the Settings delivery card.
- Test sends use the same path with `source = 'Test'`, subject prefix `[TEST]`, category `<prefix>-test`, and are excluded from campaign counts and stats.

### 6.4 Event webhook

`POST /api/v1/internal/communications/events` (anonymous, signature-authenticated):

- Reads the **raw body** (limit 1 MiB) and verifies `X-Twilio-Email-Event-Webhook-Signature` / `-Timestamp` with `@sendgrid/eventwebhook` (`8.0.0`) against `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY`. Missing key → 503 (so SendGrid retries once configured); invalid signature → 401; timestamp older than 10 minutes → 401 (replay bound the SDK does not add).
- Idempotent on `sg_event_id` (primary key). Correlates by `custom_args.deliveryId`, falling back to `sg_message_id` prefix + email.
- Mapping: `delivered` → Delivered · `deferred` → Deferred · `bounce` (type bounce) → Bounced + suppress `Bounced` · `bounce` (type blocked) → Bounced, no suppression · `dropped` → Dropped, suppress when the reason is a bounced/unsubscribed/spam address · `open` → `opened_at` · `click` → `clicked_at` · `spamreport` → suppress `SpamReport` · `unsubscribe`, `group_unsubscribe` → suppress `Unsubscribed` and set matching contacts to `Unsubscribed` · `group_resubscribe` → remove an `Unsubscribed` suppression. `processed` only updates `last_event`.
- Events are applied by a state rank (Accepted < Deferred < Delivered < Bounced = Dropped), so events that arrive out of order never move a delivery backwards, and the states the worker owns (Queued, Retry, Dead letter, Suppressed, Cancelled) are never changed by an event; the one overlap is a row still Processing, which takes a verdict (Delivered, Bounced, Dropped) that overtakes the worker's own update.
- Proxy changes: this route is exempt from the JSON pre-parse (`validateStructure` would reject SendGrid's larger batches and the signature needs the untouched body) and gets its own rate-limit group (`webhook-in`, 600/min). CSRF checks are unaffected (server-to-server requests carry no `Origin`).

### 6.5 Unsubscribe

- With `unsubscribeGroupId` set, SendGrid injects `List-Unsubscribe` / `List-Unsubscribe-Post` headers and the `<%asm_group_unsubscribe_raw_url%>` link rendered in the footer. Unsubscribes come back through the webhook and land in the suppression list, so Pulse never emails that address again regardless of company or source.
- A suppression or a safe-mode change that comes after the freeze (an unsubscribe reported through another campaign, a bounce, an admin's block) holds for the rows still waiting: when the worker claims, it first settles every waiting real row of a sending campaign whose address is now on the list, or outside safe mode's allow-list, as `Suppressed` with the reason the audience uses (the list's, else `SafeMode`), and never hands it to the transport. A retry or a requeued dead letter therefore never mails an address that has been suppressed since. Test mails go to the staff the sender names and were never held to the list or to safe mode, so they are not settled here.
- Mail sent without an unsubscribe group has no `List-Unsubscribe` header and no unsubscribe link, so the settings cannot be saved with sending enabled and safe mode off while `unsubscribeGroupId` is empty (`INVALID_UNSUBSCRIBE_GROUP_REQUIRED`).
- Pulse users additionally toggle topics in the Updates page; those preferences are honoured at audience freeze.
- Security advisories are mandatory for members, but a global suppression (bounce, spam report, unsubscribe) still wins: Pulse never sends to a suppressed address.

## 7. Templates, content and rendering

### 7.1 Principles

- Templates are **code modules** registered in `lib/server/communications/templates/index.ts`: `{ key, topic, name, contentSchema (zod), render(content, locale, ctx) → { subject, preheader, html, text } }`. Adding a template is adding one module.
- Content is **structured JSON**, not HTML. Authors fill fields (title, intro, sections, callouts, links, CTA). Every string is HTML-escaped on render; links are only possible through explicit `url` fields validated as `https://`. A minimal inline syntax (`**bold**`, `[text](https://…)`) is supported inside paragraphs and rendered through the same escaper.
- Localised: `body.en` is required, `body.is` optional and falls back to English; the recipient's locale (user → contact → organisation → `en`) picks the variant. Fixed chrome strings ("Product update", "Action required", "Unsubscribe", sign-off) ship in both languages.
- Brand: layout from the DataCentral design system — 6 px four-colour stripe at the top (four table cells, hard stops), black-text logo (PNG, hosted at `${PULSE_PUBLIC_URL}/email/datacentral-logo.png`, added to `public/email/`), eyebrow in uppercase violet, headings in Space Grotesk with Arial fallback, body in IBM Plex Sans with Segoe UI/Arial fallback, violet-600 `#7c3aed` for links and the single CTA, amber callout for "action required", violet-50 callout for notes, neutral-200 dividers, footer with sign-off, company line, support address and unsubscribe/preferences links. Table-based, 600 px, inline styles, light background `#fafafa`; no external CSS, no scripts, no emoji. Plain-text alternative always generated.

### 7.2 Template `product-update` (matches the DataCentral 3.0.0 mail)

```ts
{
  eyebrow?: string;            // default "Product update" / "Vöruuppfærsla"
  title: string;               // "DataCentral 3.0.0"
  subtitle?: string;           // "Better visibility and more efficient Power BI administration."
  intro: string;               // paragraph(s)
  highlightsLabel?: string;    // default "Key highlights"
  sections: Array<{            // 1–8
    heading: string;
    body: string;
    callout?: { tone: "warning" | "info"; label?: string; text: string };   // "Action required for existing tenants: …"
    link?: { label: string; url: string };                                   // "View the setup guide and video →"
  }>;
  note?: string;               // violet note box ("DataCentral 3.0.0 also displays dates…")
  cta?: { label: string; url: string };   // "Explore DataCentral 3.0.0"
  signOff?: string;            // defaults to settings.boilerplate[locale].signOff
}
```

Pre-fill from a release: `title = release.title`, `subtitle = release.availability`, `intro = release.summary`, one section per included idea (`publishedTitle` / `releaseNotes`), `cta = { "Open the release notes", documentationUrl }` when present, `release_public_id` recorded.

### 7.3 Template `service-notice`

`title`, `summary`, `window: { startsAt, endsAt, timezone }`, `impact`, `actions: string[]`, `link?`, `contact?` — rendered with an amber "Planned maintenance" / "Service notice" header band.

### 7.4 Template `plain`

`title`, `paragraphs: string[]`, `cta?`, `signOff?` — the general announcement and the default for security advisories (topic selectable).

### 7.5 Preview

`GET /api/v1/internal/communications/{id}/preview?locale=en|is&format=html|text` returns the rendered mail with a strict response CSP (`default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'`). The editor shows it in a same-origin `<iframe sandbox>` (allowed by the app CSP's `frame-src 'self'` fallback), stacked under the form on narrow screens and beside it on wide ones, with its own scroll so it fits the ~600 px DataCentral embed height.

## 8. Campaign lifecycle

### 8.1 States

```text
Draft ──send now──▶ Sending ──all deliveries left Queued/Retry/Processing──▶ Sent
Draft ──schedule──▶ Scheduled ──worker at scheduled_at──▶ Sending
Scheduled ──unschedule──▶ Draft
Scheduled | Sending ──cancel──▶ Cancelled   (remaining Queued/Retry deliveries → Cancelled)
```

Send, schedule and cancel require `If-Match` (row_version through `checkedMutation`, new `VersionedEntity` `"Communications"`) and an `Idempotency-Key` (`executeIdempotent`, operation prefix `communication.` added to its publish-role rule). Content and audience are immutable once a campaign leaves Draft; duplicating creates a new Draft.

### 8.2 Audience specification (`audience_json`)

```ts
{
  organizations: "all-customers" | string[];   // Customer + Partner organisations
  includeOnboarding: boolean;                  // status Onboarding (default false; Inactive never)
  includeTestOrganizations: boolean;           // is_test = 1 (default false)
  includeMembers: boolean;                     // active memberships (default true)
  memberRoles: Array<"Company admin" | "Requester" | "Viewer"> | null;  // null = all
  includeContacts: boolean;                    // CommunicationContacts subscribed to the topic (default true)
  includeInternalCopy: boolean;                // active members of the Internal organisation (default false)
}
```

### 8.3 Audience resolution (`audience.ts`, pure and unit-tested)

Input rows (organisations, members with preferences, contacts, suppressions, settings) → output deliveries. Rules, in order:

1. Organisation filter (type, status, test flag).
2. Members: `Users.status = Active`, membership `Active`, role in `memberRoles`, preference for `communication.<topic>` not `Off` (mandatory topics ignore `Off`).
3. Contacts: `status = Active`, `deleted_at IS NULL`, topic in `topics_json`.
4. Dedupe by normalised e-mail; a member row wins over a contact row (locale from the user record).
5. Suppression list → row kept with `state = Suppressed`, reason from the list (visible in the review, never sent).
6. Safe mode → non-allow-listed domains → `Suppressed/SafeMode`.
7. `maxRecipientsPerCampaign` exceeded → `INVALID_AUDIENCE_TOO_LARGE`.

`GET /{id}/audience` returns the breakdown (companies, members, contacts, suppressed by reason, final count) without writing anything, and beside it the `effectiveSendingState` (§6.2). `send` runs the same function inside the transaction that inserts `CommunicationDeliveries` and sets `recipient_count`. Rules 5 and 6 are one function (`blockedReason`), which the worker applies again when it claims (§8.4).

### 8.4 Worker (`POST /api/v1/internal/jobs/communications`, every minute)

```text
promoteScheduled(now)                 Scheduled & due → Sending (+ freeze audience)
while claimed < limit:
  batch = store.claimBatch(size ≤ 500)        first settles waiting real rows whose address is now suppressed or outside safe mode's list as Suppressed;
                                              then one campaign, one locale, Queued/Retry due, UPDLOCK READPAST
  if dailyCap reached: stop
  render once per batch (content + locale + boilerplate)
  transport.sendBatch(...) → Accepted (+ x-message-id) | Retry | Dead letter
completeCampaigns()                   Sending with no open deliveries → Sent, completed_at
```

Returns `{ accepted, retried, deadLettered, completed, skipped }`. When `settings.enabled` is false or SQL is not configured it returns `{ skipped: true }` like the other workers. Multiple instances are safe (SQL claims).

### 8.5 Stats

Per campaign: recipient count, accepted, delivered, bounced, dropped, dead-lettered, suppressed, opened (unique), clicked (unique), plus per-company rows. Computed from `CommunicationDeliveries` on read (no counters to drift).

## 9. API surface

All routes follow the `correlationId → try → json() / apiError()` shape, Zod input schemas in `lib/contracts.ts`, and are registered in `scripts/generate-openapi.ts` + `docs/openapi-base.json`.

Internal (Product manager / System admin unless noted):

| Method & path | Purpose |
| --- | --- |
| `GET /api/v1/internal/communications` | List campaigns (any internal role) |
| `POST /api/v1/internal/communications` | Create draft (`fromReleaseId` optional pre-fill) |
| `GET /api/v1/internal/communications/{id}` | Campaign + stats (any internal role) |
| `PATCH /api/v1/internal/communications/{id}` | Edit draft (If-Match) |
| `DELETE /api/v1/internal/communications/{id}` | Soft-delete a draft, or a cancelled campaign that no mail left for (its delivery rows are the record of who was mailed) |
| `POST /api/v1/internal/communications/{id}/duplicate` | New draft from any campaign |
| `GET /api/v1/internal/communications/{id}/preview` | Rendered HTML/text (any internal role) |
| `GET /api/v1/internal/communications/{id}/audience` | Audience estimate and breakdown, with `effectiveSendingState` (any internal role) |
| `POST /api/v1/internal/communications/{id}/test` | Test send to self (+ optional internal addresses) |
| `POST /api/v1/internal/communications/{id}/send` | Send now or `scheduledAt` (If-Match, Idempotency-Key) |
| `POST /api/v1/internal/communications/{id}/cancel` | Cancel / unschedule (If-Match) |
| `GET /api/v1/internal/communications/{id}/deliveries` | Recipient states, filter by state/company, paged (any internal role) |
| `POST /api/v1/internal/communications/{id}/deliveries/retry` | Requeue dead letters |
| `GET/POST /api/v1/internal/communications/contacts` | List (filter `organizationId`; any internal role) / add or paste-import |
| `PATCH/DELETE /api/v1/internal/communications/contacts/{contactId}` | Edit / remove |
| `GET/POST/DELETE /api/v1/internal/communications/suppressions` | System admin manage (DELETE takes `{ email }` in the body); internal read |
| `POST /api/v1/internal/communications/events` | SendGrid Event Webhook (signature) |
| `POST /api/v1/internal/jobs/communications` | Worker (job secret) |

Admin (System admin): `GET/PATCH /api/v1/admin/communications/settings`, `POST /api/v1/admin/communications/settings/test` (sends a configuration test mail to the caller).

Customer (active organisation, Company admin for writes): `GET/POST /api/v1/communications/contacts`, `PATCH/DELETE /api/v1/communications/contacts/{contactId}`. Member subscriptions use the existing `GET/PATCH /api/v1/notifications/preferences`.

Assistant/MCP tools are not part of release 1 (listed in §15).

## 10. User interface

### 10.1 Internal — Communications page (`app/features/communications.tsx`, lazy-loaded)

Tabs: **Campaigns**, **Contacts**, **Suppressions** (System admin).

- Campaign list: `COM-012 · title · template · status pill · recipients · delivered % · opened % · sent at`, actions Open / Duplicate. Empty state with "New communication".
- Editor (page view, not a modal; survives the short embed height): header with working title, template and topic; three steps as tabs — **Content** (form fields per template, locale switch en/is with "copy from English"), **Audience** (company picker with search and "all customers", member/contact/internal-copy toggles, role filter, live estimate with breakdown), **Review & send** (subject per locale, warnings: safe mode on / sandbox on / provider not configured / sending disabled (from the `effectiveSendingState` of the audience estimate, so every sender sees them, not only System admins), recipient summary, "Send test to me", "Send now" / "Schedule for…"). Right-hand live preview iframe on wide screens. Save draft is explicit (plus autosave of the form into device storage via the existing draft helpers is a Phase 2 nicety).
- Confirmation dialog repeats the recipient and company counts and the sending state (`live`, `safe mode`, `sandbox`) before Send.
- Campaign detail: stat tiles, per-company table, deliveries table with state filter and search, Retry dead letters, Cancel (Scheduled/Sending), Duplicate.
- Contacts tab: company selector, table (name, e-mail, locale, topics, status, source), Add contact modal, Paste import (one `Name, email` per line, up to 250), Remove.
- Suppressions tab: table with reason/source/date, Add manual suppression, Remove (System admin).

### 10.2 Settings page — "Customer communications (SendGrid)" card (`app/features/communication-settings.tsx`)

Status line (API key configured / webhook key configured / effective sending state), all §6.2 options grouped as Provider, Sending policy, Tracking, Boilerplate (en/is), the webhook URL to copy, and **Send configuration test** (to the signed-in admin). The existing Background delivery card gains a `Communications` channel row and retry button.

### 10.3 Customer — Updates page

- Notification preferences list gains the four communication topics rendered as toggles (security advisories shown as "always on").
- For Company admins of the active organisation: **Company communication contacts** section — who at the company receives DataCentral communications, add/remove, topics. Copy explains that Pulse users receive updates automatically and control their own preferences.

### 10.4 Releases page

Published releases get **Draft customer email** → creates a `product-update` draft pre-filled from the release and navigates to the editor.

### 10.5 Localisation and help

All new UI strings get Icelandic entries (`lib/i18n-internal.ts` for staff screens, `lib/i18n.ts` for the Updates page). A "Customer communications" section in the help manual and a short internal tour are optional tasks at the end of the plan.

## 11. Security and privacy

- Authorisation in repositories only; routes never trust the client. Company admin writes are scoped by `requireMembership(identity)` and the membership role read from SQL.
- Customer addresses are PII: never logged (worker and webhook log counts and codes only), never in telemetry, hashed nowhere needed. Delivery rows carry the address so the audit question "who received COM-012" is answerable.
- Webhook: signature + timestamp window + idempotency; payloads trimmed before storage.
- Outbound: only SendGrid's API host; no user-supplied URLs are fetched server-side. Links in content must be `https://` and are rendered escaped.
- Secrets: environment / Key Vault only. The production configuration check validates only environment values: `SENDGRID_API_KEY` and `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` must be resolved, non-blank values (not a Key Vault placeholder) when they are set, and an empty value counts as not set. A valid `fromEmail` when `enabled` is enforced when the settings are saved, by the schema (`communicationSettingsInputSchema`), not at startup, because the settings live in the database. Send, schedule and test send refuse without `SENDGRID_API_KEY` in every environment (`INVALID_EMAIL_PROVIDER_CONFIGURATION`); the console transport serves only the configuration test, and in production the worker and the configuration test refuse it as well.
- Rate limits: internal routes under the existing `api` group; webhook in its own group.
- Audit events: `communication.created|updated|deleted|duplicated|test-sent|scheduled|unscheduled|sent|cancelled|deliveries.retried`, `communication.contact.saved|removed`, `communication.suppression.added|removed`, `communication.settings.updated`, each with `before/after` where applicable — these also feed the outbound webhook outbox automatically via the `AuditEvents` trigger.
- Retention: `CommunicationEvents` older than 90 days purged by the retention job; deliveries follow the campaign's lifetime.

## 12. Operations

- Scheduler: add `POST /api/v1/internal/jobs/communications` every minute next to notifications and webhooks (same `x-pulse-job-secret`).
- Infra: `infra/main.bicep` gains `sendgridApiKey` (`@secure()`, optional → Key Vault secret + app setting) and `sendgridEventWebhookPublicKey` (app setting). `.env.example`, `configInfo.md` (new section: restricted API key, sender authentication SPF/DKIM/DMARC, Event Webhook URL + signed webhook, unsubscribe group, EU residency, sandbox, verification steps), README (Communications section, migration 015, sequence grant, job), `docs/launch-runbook.md` (job + dead-letter alert).
- Monitoring: the Settings delivery card shows queued/retry/dead-letter counts per channel; job results are structured logs without PII.
- Database: `GRANT UPDATE ON OBJECT::dbo.CommunicationNumber` for the runtime identity.

## 13. Testing

`tests/communications.test.ts` (appended to the `test` script), all in memory mode:

- Templates: escaping, inline syntax, locale fallback, chrome strings in `is`, plain-text output, release pre-fill.
- Contacts: Company admin scoped to own organisation (other org → `NOT_FOUND`), Requester refused, System admin any org, e-mail normalisation and duplicate rejection, paste import limits.
- Audience: dedupe member vs contact, preference `Off`, mandatory topic, suppression, safe mode, test organisations, role filter, size limit.
- Campaign: state transitions, immutability after Draft, If-Match and publish role on send, idempotent send, cancel marks remaining deliveries, duplicate resets state.
- Worker: batches per locale ≤ 500, `202` → Accepted with message id, `429` → Retry with backoff, fifth failure → Dead letter, campaign completion, master switch off, daily cap, scheduled promotion.
- Webhook: signature verification with a generated P-256 key pair (valid, invalid, stale), idempotent `sg_event_id`, bounce → suppression, unsubscribe → suppression + contact status, open/click timestamps, unknown delivery ignored.
- Settings: schema validation (`fromEmail` required when enabled, domains normalised, caps bounded), System admin only.
- Proxy: webhook route bypasses JSON pre-parse; routes appear in `openapi:check`.

`npm run verify` (openapi drift, typecheck, tests, lint, build) stays the gate.

## 14. Assumptions and open decisions

Stated assumptions (correct me if wrong):

1. **Secrets stay in Key Vault / environment**, not in the Settings UI. The UI shows status and holds every non-secret option.
2. **Product managers may send**; System admins own settings and suppressions. No four-eyes approval in release 1.
3. **Transactional email stays on Azure Communication Services**; SendGrid is for broadcast communications only.
4. **Templates are code**, extended by adding modules; authors fill structured fields rather than editing HTML.
5. **Members are recipients by default** (opt-out per topic), external contacts are opt-in by being added. Security advisories cannot be opted out of by members.
6. **Safe mode starts on** in production with `datacentral.ai` allow-listed, so the first sends cannot reach customers until a System admin switches it off.
7. Open and click tracking are on by default (configurable). If data-protection review prefers opens off, flip the default.
8. Data residency defaults to `global`; switch to `eu` if the SendGrid account is EU-pinned.
9. Contact paste-import is good enough for release 1 (no CSV upload, no DataCentral tenant-admin sync yet).

Questions for you:

- Should Company admins also be allowed to invite colleagues as Pulse users from the contacts screen, or is a plain contact (no login) the intended default?
- Do you want an in-app "Sent communications" archive visible to customers in release 1, or is it fine as Phase 2?
- Any additional template kind needed on day one (for example "Security advisory" with severity, or a newsletter with multiple items)?

## 15. Future improvements (suggested roadmap)

Grouped by value; none are required for release 1.

### Authoring

1. AI assist (Anthropic API, already wired for the assistant): draft a product update from a release and its ideas, translate en→is, run a brand-voice check before send.
2. Database-backed template presets with versioning and a block editor; saved snippets (standard callouts, sign-offs).
3. Autosave of in-progress campaign content into the existing device/server draft helpers.
4. Assistant and MCP tools: `list_communications`, `get_communication_stats`, `draft_communication_from_release`, `list_communication_contacts`, `add_communication_contact`.
5. Per-recipient substitutions (`-name-`, `-company-`) in the personalizations, so a mail can greet each person by name and company.

### Audience and consent

1. Signed, login-free preference centre for external contacts (`/communications/preferences?token=…`) so non-Pulse recipients can pick topics, not only unsubscribe.
2. Organisation tags / segments (for example "Admin report enabled", "Power BI embedded", "DataCentral ≥ 3.0") as audience filters; populated manually or from the DataCentral API.
3. Pull DataCentral tenant administrators as contacts through the DataCentral API; nightly suppression reconciliation from SendGrid's suppression endpoints.
4. Bounce handling for Pulse users: surface bounced member addresses to System admins (and flag the user) so invitations and OTP codes do not go to dead addresses.

### Delivery and insight

1. Customer-visible archive of sent communications in the Updates page (and in the DataCentral embed), with "view in browser" links in the mail.
2. Per-company engagement report (delivered/opened/clicked by company and by person) with CSV export; "who at Origo opened COM-012".
3. Time-zone aware send windows and throttling; A/B subject tests.
4. Approval workflow (four-eyes) with a send lock, and a "frozen content" diff view.
5. Internal Slack/Teams notification when a campaign finishes with stats (the Slack bot already exists).

### Platform

1. Shared transport abstraction so OTP and notification mail can also use SendGrid (dynamic templates) or ACS can carry communications — one place to switch providers.
2. Dark-mode-aware email CSS and a rendering test matrix (Litmus / Email on Acid) as a release checklist item.
3. Deliverability runbook: domain authentication, DMARC alignment, link branding, dedicated IP and warm-up once volume justifies it.
4. Anonymise delivery addresses after the retention period and expose a per-address erasure action for data-subject requests.
