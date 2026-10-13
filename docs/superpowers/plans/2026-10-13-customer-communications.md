# Customer Communications (SendGrid emailer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Communications subsystem to Pulse: branded customer emails (product updates, service notices, announcements) composed from code templates, targeted at companies/members/contacts, sent through SendGrid with delivery tracking, self-service contact lists for Company admins, and System-admin settings.

**Architecture:** New `lib/server/communications/*` repositories (dual SQL / in-memory like every other repository), a `CommunicationDeliveries` outbox drained by `POST /api/v1/internal/jobs/communications`, a SendGrid transport behind a small `MailTransport` interface, a signature-verified Event Webhook that writes delivery states and a global suppression list, and three UI surfaces (internal Communications page, Settings card, customer Updates-page sections). Templates are code modules rendering structured JSON to table-based HTML + plain text.

**Tech Stack:** Next.js 16 App Router (Node runtime), TypeScript strict, `mssql` hand-written T-SQL with in-memory mode, `zod` ^4, `@sendgrid/mail` 8.1.6 (new), `node:crypto` for webhook ECDSA verification, Node built-in test runner via `tsx`, Playwright (dev) to rasterise the email logo.

**Spec:** `docs/superpowers/specs/2026-10-13-customer-communications-design.md` — read it first; every section number referenced below (§x) points there.

## Global Constraints

- Repositories are plain exported functions taking `identity: PulseIdentity` first, dual-mode on `isAzureSqlConfigured()`; SQL pool via `getSqlPool()` and `sql` from `@/lib/server/database`; parameterised T-SQL only; in-memory state via `declare global` + `globalThis.pulseMemory*`.
- Authorisation only in repositories: `requireMembership`, `requireInternalRole`, `requirePublishRole` from `@/lib/server/authorization`. Errors are string-coded `Error`s (`FORBIDDEN`, `NOT_FOUND`, `INVALID_*`, `UNAUTHORIZED`, `RATE_LIMITED`, `PRECONDITION_*`) mapped by `apiError`; unmapped codes become 500, so every new code must start with `INVALID_` unless it is one of the mapped ones.
- Route handlers follow `const id = correlationId(request); try { … return json(body, init, id) } catch (error) { return apiError(error, id) }`. Mutations with side effects that must not replay use `executeIdempotent`; version-guarded mutations use `checkedMutation` with the `If-Match` header.
- Migrations: `SET XACT_ABORT ON; BEGIN TRANSACTION; … COMMIT TRANSACTION;`, snake_case columns, guarded with `IF OBJECT_ID('dbo.X','U') IS NULL`.
- Secrets never in the repo or the database: `.env.example` placeholders, `.env.local` for dev, `@secure()` Bicep param → Key Vault secret → Key Vault-reference app setting. Never log e-mail addresses, names, subjects or bodies.
- Test files are explicitly enumerated in the `test` script in `package.json`; tests use `node:test` + `node:assert/strict` in memory mode, resetting `globalThis.pulseMemory*` in `beforeEach`; **imports are extension-less** (`../lib/server/communications/audience`, never `.ts`).
- Path alias `@/*` = repo root in app/lib code; tests use relative imports.
- UI strings: English source in JSX through `t("…")`; add Icelandic to `lib/i18n-internal.ts` (staff screens) or `lib/i18n.ts` (customer screens). Sentence case, no emoji, DataCentral voice (§7.1 brand rules).
- Every new API route must be picked up by `npm run openapi:generate` (route inventory + `schemaNames` in `scripts/generate-openapi.ts` + curated entry in `docs/openapi-base.json`); `npm run openapi:check` is part of `npm run verify`.
- Commit after every green task with a `feat:`/`test:`/`docs:` message. Verification: `npm run typecheck`, `npm test`, `npm run lint`; `npm run verify` before the final hand-off.
- Spec values copied verbatim: batches ≤ 500 personalizations; 5 attempts then Dead letter; backoff `2 ** attempt * 60_000` ms honouring `Retry-After`; webhook timestamp window 10 minutes; raw webhook body ≤ 1 MiB; paste import ≤ 250 lines; defaults `safeMode.enabled = true`, `allowedDomains = ["datacentral.ai"]`, `dailyCap = 5000`, `maxRecipientsPerCampaign = 5000`, `tracking.opens = true`, `tracking.clicks = true`, `dataResidency = "global"`, `categoriesPrefix = "pulse"`, `enabled = false`; events purged after 90 days.

## Review Focus

Inputs the spec implies but no single feature test would naturally cover. Each is pinned to a test in the owning task.

1. **Same person twice with different e-mail casing** (member `Jon@Origo.is`, contact `jon@origo.is`): exactly one delivery, member wins → Task 7 test "dedupes member and contact rows case-insensitively".
2. **Hostile content**: `<script>` in a title, `javascript:` or `http:` link URLs, `**` and `[]()` inside escaped text: rendered inert or rejected by the schema → Task 2 tests "escapes HTML and only renders https links" and "rejects non-https links in content and unknown template bodies".
3. **Safe-mode domain matching must be exact**: `evil-datacentral.ai` and `datacentral.ai.attacker.com` are not allow-listed when `datacentral.ai` is → Task 7 test "safe mode matches the whole domain".
4. **Provider throttling**: SendGrid `429` with `Retry-After: 900` → `next_attempt_at` is at least 900 s away, not the 2-minute default → Task 11 test "honours Retry-After when it exceeds the backoff".
5. **Suppression beats membership**: a bounce event for an active member's address stops every later campaign to that address, and a duplicate `sg_event_id` or an unknown `deliveryId` is ignored without error → Task 12 test "applies delivery states, bounce suppresses the address, duplicates and unknown ids are no-ops"; Task 7 test "suppressed members are kept as Suppressed rows; safe mode matches the whole domain".
6. **Cross-company contact edit**: Company admin of ORG-001 patching a contact id that belongs to ORG-002 gets `NOT_FOUND` → Task 4 test.
7. **Cancel during Sending**: accepted deliveries stay Accepted, only Queued/Retry rows become Cancelled, and a Scheduled campaign promoted with an all-suppressed audience completes as Sent with `recipientCount = 0` → Task 9 and Task 11 tests.

## File structure

```text
database/migrations/015_customer_communications.sql     schema (§5.2)
lib/server/communications/
  types.ts            shared record and enum types
  topics.ts           topic list, preference event types, template→topic defaults
  memory.ts           all declare-global memory stores for this subsystem
  settings.ts         CommunicationSettings get/save/runtime/status (dbo.Settings key 'communications')
  html.ts             escapeHtml, renderInline, renderParagraphs, inlineToText
  templates/layout.ts branded shell + chrome strings (en/is) + footer
  templates/product-update.ts, service-notice.ts, plain.ts, index.ts (registry)
  contact-repository.ts        internal + customer-scoped contact functions, paste import
  suppression-repository.ts    global suppression list
  audience.ts                  pure resolver + loadAudienceInput (SQL/memory)
  campaign-repository.ts       campaigns, preview, release pre-fill, send/schedule/cancel, deliveries, stats
  sendgrid.ts                  MailTransport (sendgrid | console), message builder, error classification
  delivery-store.ts            DeliveryStore interface + SQL + memory implementations
  delivery-worker.ts           processCommunicationBatch
  event-webhook.ts             verifyEventSignature, parseEvents, applyEvents
lib/contracts.ts                 + communication* zod schemas (shared client/server)
app/api/v1/internal/communications/**                    campaign, contact, suppression, events routes
app/api/v1/internal/jobs/communications/route.ts         worker job
app/api/v1/admin/communications/settings/{route.ts,test/route.ts}
app/api/v1/communications/contacts/**                    customer self-service
app/features/communications.tsx                          internal page (list, editor, detail)
app/features/communication-contacts.tsx                  internal contacts + suppressions tabs
app/features/communication-settings.tsx                  Settings card
app/features/company-contacts.tsx                        customer Updates-page section
public/email/datacentral-logo.png                        email header logo (rasterised)
scripts/render-email-logo.mjs                            one-off Playwright rasteriser
tests/communications.test.ts                             repositories, templates, audience, worker, webhook
tests/communications-routes.test.ts                      route-level permission and webhook tests
```

Modified: `lib/server/versions.ts` (new entity), `lib/server/idempotency.ts` (operation prefix), `lib/server/notification-preference-repository.ts` (event types), `lib/server/admin-repository.ts` (export `organizations()`), `lib/server/delivery-status.ts` (+ channel), `lib/server/retention-worker.ts` (events purge), `lib/server/production-config.ts`, `proxy.ts`, `scripts/generate-openapi.ts`, `docs/openapi-base.json`, `app/features/{shared,shell,settings,customer,releases,delivery-status}.tsx`, `app/globals.css`, `lib/i18n.ts`, `lib/i18n-internal.ts`, `package.json`, `.env.example`, `infra/main.bicep`, `README.md`, `configInfo.md`, `docs/launch-runbook.md`, `docs/architecture.md`.

---

### Task 1: Schema, topics, types and communication settings

**Files:**
- Create: `database/migrations/015_customer_communications.sql`
- Create: `lib/server/communications/types.ts`
- Create: `lib/server/communications/topics.ts`
- Create: `lib/server/communications/memory.ts`
- Create: `lib/server/communications/settings.ts`
- Modify: `lib/contracts.ts` (append `communicationSettingsInputSchema`)
- Modify: `lib/server/notification-preference-repository.ts:6-14,24-27` (event types + mandatory)
- Modify: `README.md` (migration list, sequence grant)
- Create: `tests/communications.test.ts`
- Modify: `package.json` (`test` script)

**Interfaces:**
- Produces: `CommunicationTopic`, `TemplateKey`, `EmailLocale`, `ContactRecord`, `SuppressionRecord`, `CommunicationRecord`, `DeliveryRecord`, `DeliveryState`, `AudienceSpec`, `CommunicationContent` (types.ts); `COMMUNICATION_TOPICS`, `topicEventType(topic)`, `MANDATORY_TOPICS`, `defaultTemplateForTopic` (topics.ts); `getCommunicationSettings(identity)`, `saveCommunicationSettings(identity, input)`, `getRuntimeCommunicationSettings()`, `communicationProviderStatus(settings)`, `DEFAULT_COMMUNICATION_SETTINGS` (settings.ts); memory accessors `memoryContacts()`, `memorySuppressions()`, `memoryCommunications()`, `memoryDeliveries()`, `memoryEvents()` (memory.ts).

- [ ] **Step 1: Migration**

`database/migrations/015_customer_communications.sql`:

```sql
-- Customer communications: campaigns, per-recipient deliveries, explicit
-- contacts, global suppressions and the SendGrid event ledger (spec §5.2).
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID('dbo.CommunicationNumber','SO') IS NULL
  CREATE SEQUENCE dbo.CommunicationNumber AS bigint START WITH 1 INCREMENT BY 1;

IF OBJECT_ID('dbo.CommunicationContacts','U') IS NULL
BEGIN
  CREATE TABLE dbo.CommunicationContacts (
    id uniqueidentifier NOT NULL CONSTRAINT PK_CommunicationContacts PRIMARY KEY,
    organization_id nvarchar(32) NOT NULL CONSTRAINT FK_CommunicationContacts_Organizations REFERENCES dbo.Organizations(id),
    user_id uniqueidentifier NULL CONSTRAINT FK_CommunicationContacts_Users REFERENCES dbo.Users(id),
    email nvarchar(320) NOT NULL,
    display_name nvarchar(200) NOT NULL,
    locale nvarchar(12) NOT NULL CONSTRAINT DF_CommunicationContacts_Locale DEFAULT 'en',
    topics_json nvarchar(max) NOT NULL CONSTRAINT CK_CommunicationContacts_Topics CHECK (ISJSON(topics_json)=1),
    status nvarchar(32) NOT NULL CONSTRAINT DF_CommunicationContacts_Status DEFAULT 'Active'
      CONSTRAINT CK_CommunicationContacts_Status CHECK (status IN ('Active','Unsubscribed','Bounced')),
    source nvarchar(32) NOT NULL CONSTRAINT CK_CommunicationContacts_Source CHECK (source IN ('Admin','Company admin','Import','Webhook')),
    note nvarchar(500) NULL,
    created_by_user_id uniqueidentifier NOT NULL CONSTRAINT FK_CommunicationContacts_CreatedBy REFERENCES dbo.Users(id),
    created_at datetime2 NOT NULL CONSTRAINT DF_CommunicationContacts_CreatedAt DEFAULT SYSUTCDATETIME(),
    updated_at datetime2 NOT NULL CONSTRAINT DF_CommunicationContacts_UpdatedAt DEFAULT SYSUTCDATETIME(),
    deleted_at datetime2 NULL
  );
  CREATE UNIQUE INDEX UQ_CommunicationContacts_Org_Email ON dbo.CommunicationContacts(organization_id,email) WHERE deleted_at IS NULL;
  CREATE INDEX IX_CommunicationContacts_Email ON dbo.CommunicationContacts(email) WHERE deleted_at IS NULL;
END

IF OBJECT_ID('dbo.CommunicationSuppressions','U') IS NULL
BEGIN
  CREATE TABLE dbo.CommunicationSuppressions (
    email nvarchar(320) NOT NULL CONSTRAINT PK_CommunicationSuppressions PRIMARY KEY,
    reason nvarchar(32) NOT NULL CONSTRAINT CK_CommunicationSuppressions_Reason CHECK (reason IN ('Unsubscribed','Bounced','SpamReport','Manual')),
    source nvarchar(32) NOT NULL CONSTRAINT CK_CommunicationSuppressions_Source CHECK (source IN ('Webhook','Admin')),
    note nvarchar(500) NULL,
    created_by_user_id uniqueidentifier NULL CONSTRAINT FK_CommunicationSuppressions_CreatedBy REFERENCES dbo.Users(id),
    created_at datetime2 NOT NULL CONSTRAINT DF_CommunicationSuppressions_CreatedAt DEFAULT SYSUTCDATETIME()
  );
END

IF OBJECT_ID('dbo.Communications','U') IS NULL
BEGIN
  CREATE TABLE dbo.Communications (
    id uniqueidentifier NOT NULL CONSTRAINT PK_Communications PRIMARY KEY,
    public_id nvarchar(32) NOT NULL CONSTRAINT UQ_Communications_PublicId UNIQUE,
    template_key nvarchar(40) NOT NULL,
    topic nvarchar(40) NOT NULL,
    title nvarchar(200) NOT NULL,
    content_json nvarchar(max) NOT NULL CONSTRAINT CK_Communications_Content CHECK (ISJSON(content_json)=1),
    audience_json nvarchar(max) NOT NULL CONSTRAINT CK_Communications_Audience CHECK (ISJSON(audience_json)=1),
    status nvarchar(32) NOT NULL CONSTRAINT DF_Communications_Status DEFAULT 'Draft'
      CONSTRAINT CK_Communications_Status CHECK (status IN ('Draft','Scheduled','Sending','Sent','Cancelled')),
    scheduled_at datetime2 NULL,
    started_at datetime2 NULL,
    completed_at datetime2 NULL,
    cancelled_at datetime2 NULL,
    recipient_count int NOT NULL CONSTRAINT DF_Communications_RecipientCount DEFAULT 0,
    release_public_id nvarchar(32) NULL,
    created_by_user_id uniqueidentifier NOT NULL CONSTRAINT FK_Communications_CreatedBy REFERENCES dbo.Users(id),
    updated_by_user_id uniqueidentifier NULL CONSTRAINT FK_Communications_UpdatedBy REFERENCES dbo.Users(id),
    sent_by_user_id uniqueidentifier NULL CONSTRAINT FK_Communications_SentBy REFERENCES dbo.Users(id),
    created_at datetime2 NOT NULL CONSTRAINT DF_Communications_CreatedAt DEFAULT SYSUTCDATETIME(),
    updated_at datetime2 NOT NULL CONSTRAINT DF_Communications_UpdatedAt DEFAULT SYSUTCDATETIME(),
    deleted_at datetime2 NULL,
    row_version rowversion
  );
  CREATE INDEX IX_Communications_Status ON dbo.Communications(status,scheduled_at) WHERE deleted_at IS NULL;
END

IF OBJECT_ID('dbo.CommunicationDeliveries','U') IS NULL
BEGIN
  CREATE TABLE dbo.CommunicationDeliveries (
    id uniqueidentifier NOT NULL CONSTRAINT PK_CommunicationDeliveries PRIMARY KEY,
    communication_id uniqueidentifier NOT NULL CONSTRAINT FK_CommunicationDeliveries_Communications REFERENCES dbo.Communications(id),
    organization_id nvarchar(32) NULL CONSTRAINT FK_CommunicationDeliveries_Organizations REFERENCES dbo.Organizations(id),
    email nvarchar(320) NOT NULL,
    display_name nvarchar(200) NULL,
    locale nvarchar(12) NOT NULL,
    source nvarchar(16) NOT NULL CONSTRAINT CK_CommunicationDeliveries_Source CHECK (source IN ('Member','Contact','Test')),
    user_id uniqueidentifier NULL,
    contact_id uniqueidentifier NULL,
    state nvarchar(32) NOT NULL CONSTRAINT DF_CommunicationDeliveries_State DEFAULT 'Queued'
      CONSTRAINT CK_CommunicationDeliveries_State CHECK (state IN ('Queued','Processing','Retry','Accepted','Delivered','Deferred','Bounced','Dropped','Dead letter','Suppressed','Cancelled')),
    suppressed_reason nvarchar(40) NULL,
    attempt_count int NOT NULL CONSTRAINT DF_CommunicationDeliveries_Attempts DEFAULT 0,
    next_attempt_at datetime2 NULL,
    provider_message_id nvarchar(200) NULL,
    last_event nvarchar(32) NULL,
    last_event_at datetime2 NULL,
    opened_at datetime2 NULL,
    clicked_at datetime2 NULL,
    last_error_code nvarchar(100) NULL,
    created_at datetime2 NOT NULL CONSTRAINT DF_CommunicationDeliveries_CreatedAt DEFAULT SYSUTCDATETIME(),
    accepted_at datetime2 NULL,
    CONSTRAINT UQ_CommunicationDeliveries_Recipient UNIQUE(communication_id,email,source)
  );
  CREATE INDEX IX_CommunicationDeliveries_Work ON dbo.CommunicationDeliveries(state,next_attempt_at,created_at)
    INCLUDE(communication_id,locale,attempt_count,source);
  CREATE INDEX IX_CommunicationDeliveries_Accepted ON dbo.CommunicationDeliveries(accepted_at) WHERE accepted_at IS NOT NULL;
END

IF OBJECT_ID('dbo.CommunicationEvents','U') IS NULL
BEGIN
  CREATE TABLE dbo.CommunicationEvents (
    sg_event_id nvarchar(100) NOT NULL CONSTRAINT PK_CommunicationEvents PRIMARY KEY,
    delivery_id uniqueidentifier NULL CONSTRAINT FK_CommunicationEvents_Deliveries REFERENCES dbo.CommunicationDeliveries(id),
    event nvarchar(32) NOT NULL,
    email nvarchar(320) NOT NULL,
    occurred_at datetime2 NOT NULL,
    reason nvarchar(500) NULL,
    payload_json nvarchar(max) NULL CONSTRAINT CK_CommunicationEvents_Payload CHECK (payload_json IS NULL OR ISJSON(payload_json)=1),
    received_at datetime2 NOT NULL CONSTRAINT DF_CommunicationEvents_ReceivedAt DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_CommunicationEvents_Received ON dbo.CommunicationEvents(received_at);
END

COMMIT TRANSACTION;
```

- [ ] **Step 2: README** — in "Database setup" append `15. [015_customer_communications.sql](database/migrations/015_customer_communications.sql)` to the migration list and add `GRANT UPDATE ON OBJECT::dbo.CommunicationNumber TO [<app-service-name>];` to the grant block. In `docs/architecture.md` change "Fourteen ordered migrations" to "Fifteen ordered migrations … and customer communications".

- [ ] **Step 3: Types** — `lib/server/communications/types.ts`:

```ts
export type CommunicationTopic =
  | "product-updates"
  | "service-notices"
  | "security-advisories"
  | "general";
export type TemplateKey = "product-update" | "service-notice" | "plain";
export type EmailLocale = "en" | "is";
export type LocalizedText = { en: string; is?: string };
export type LocalizedBody = { en: Record<string, unknown>; is?: Record<string, unknown> };

export type CommunicationContent = {
  subject: LocalizedText;
  preheader?: LocalizedText;
  body: LocalizedBody;
};

export type AudienceSpec = {
  organizations: "all-customers" | string[];
  includeOnboarding: boolean;
  includeTestOrganizations: boolean;
  includeMembers: boolean;
  memberRoles: Array<"Company admin" | "Requester" | "Viewer"> | null;
  includeContacts: boolean;
  includeInternalCopy: boolean;
};

export type CommunicationStatus = "Draft" | "Scheduled" | "Sending" | "Sent" | "Cancelled";

export type CommunicationRecord = {
  version?: string;
  id: string;                 // public id COM-###
  templateKey: TemplateKey;
  topic: CommunicationTopic;
  title: string;
  content: CommunicationContent;
  audience: AudienceSpec;
  status: CommunicationStatus;
  scheduledAt?: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  recipientCount: number;
  releaseId?: string;
  createdBy: string;          // display name
  createdAt: string;
  updatedAt: string;
};

export type ContactStatus = "Active" | "Unsubscribed" | "Bounced";
export type ContactSource = "Admin" | "Company admin" | "Import" | "Webhook";
export type ContactRecord = {
  id: string;
  organizationId: string;
  userId: string | null;
  email: string;
  displayName: string;
  locale: EmailLocale;
  topics: CommunicationTopic[];
  status: ContactStatus;
  source: ContactSource;
  note?: string;
  createdAt: string;
  updatedAt: string;
};

export type SuppressionReason = "Unsubscribed" | "Bounced" | "SpamReport" | "Manual";
export type SuppressionRecord = {
  email: string;
  reason: SuppressionReason;
  source: "Webhook" | "Admin";
  note?: string;
  createdAt: string;
};

export type DeliveryState =
  | "Queued" | "Processing" | "Retry" | "Accepted" | "Delivered" | "Deferred"
  | "Bounced" | "Dropped" | "Dead letter" | "Suppressed" | "Cancelled";
export type DeliverySource = "Member" | "Contact" | "Test";
export type SuppressedReason = SuppressionReason | "SafeMode" | "PreferenceOff";
export type DeliveryRecord = {
  id: string;
  communicationId: string;    // public id COM-###
  organizationId: string | null;
  email: string;
  displayName: string | null;
  locale: EmailLocale;
  source: DeliverySource;
  userId?: string | null;
  contactId?: string | null;
  state: DeliveryState;
  suppressedReason?: SuppressedReason | null;
  attemptCount: number;
  nextAttemptAt?: string | null;
  providerMessageId?: string | null;
  lastEvent?: string | null;
  lastEventAt?: string | null;
  openedAt?: string | null;
  clickedAt?: string | null;
  lastErrorCode?: string | null;
  createdAt: string;
  acceptedAt?: string | null;
};

export type CommunicationStats = {
  recipients: number;
  queued: number;
  accepted: number;
  delivered: number;
  bounced: number;
  dropped: number;
  deadLettered: number;
  suppressed: number;
  cancelled: number;
  opened: number;
  clicked: number;
  byOrganization: Array<{ organizationId: string; recipients: number; delivered: number; opened: number }>;
};
```

- [ ] **Step 4: Topics** — `lib/server/communications/topics.ts`:

```ts
import type { CommunicationTopic, TemplateKey } from "./types";

export const COMMUNICATION_TOPICS: CommunicationTopic[] = [
  "product-updates",
  "service-notices",
  "security-advisories",
  "general",
];
export const MANDATORY_TOPICS = new Set<CommunicationTopic>(["security-advisories"]);
export const TEMPLATE_KEYS: TemplateKey[] = ["product-update", "service-notice", "plain"];

/** NotificationPreferences event type that carries a member's opt-in for a topic. */
export function topicEventType(topic: CommunicationTopic): string {
  return `communication.${topic}`;
}
export function defaultTemplateForTopic(topic: CommunicationTopic): TemplateKey {
  return topic === "product-updates" ? "product-update" : topic === "service-notices" ? "service-notice" : "plain";
}
export function defaultTopicForTemplate(template: TemplateKey): CommunicationTopic {
  return template === "product-update" ? "product-updates" : template === "service-notice" ? "service-notices" : "general";
}
```

- [ ] **Step 5: Preference event types** — in `lib/server/notification-preference-repository.ts` extend the tuple and mandatory set:

```ts
export const notificationEventTypes = [
  "request.submitted",
  "request.needs-information",
  "request.linked",
  "request.status-changed",
  "comment.mention",
  "idea.status-changed",
  "release.published",
  "communication.product-updates",
  "communication.service-notices",
  "communication.security-advisories",
  "communication.general",
] as const;
// …
const mandatoryEvents = new Set<NotificationEventType>([
  "request.needs-information",
  "comment.mention",
  "communication.security-advisories",
]);
```

- [ ] **Step 6: Memory stores** — `lib/server/communications/memory.ts`:

```ts
import type { CommunicationRecord, ContactRecord, DeliveryRecord, SuppressionRecord } from "./types";
import type { CommunicationSettings } from "./settings";

declare global {
  var pulseMemoryCommunicationContacts: ContactRecord[] | undefined;
  var pulseMemoryCommunicationSuppressions: SuppressionRecord[] | undefined;
  var pulseMemoryCommunications: CommunicationRecord[] | undefined;
  var pulseMemoryCommunicationDeliveries: DeliveryRecord[] | undefined;
  var pulseMemoryCommunicationEvents: Set<string> | undefined;
  var pulseMemoryCommunicationSettings: CommunicationSettings | undefined;
  var pulseMemoryCommunicationCounter: number | undefined;
}
export const memoryContacts = () => (globalThis.pulseMemoryCommunicationContacts ||= []);
export const memorySuppressions = () => (globalThis.pulseMemoryCommunicationSuppressions ||= []);
export const memoryCommunications = () => (globalThis.pulseMemoryCommunications ||= []);
export const memoryDeliveries = () => (globalThis.pulseMemoryCommunicationDeliveries ||= []);
export const memoryEvents = () => (globalThis.pulseMemoryCommunicationEvents ||= new Set<string>());
export function nextMemoryPublicId() {
  globalThis.pulseMemoryCommunicationCounter = (globalThis.pulseMemoryCommunicationCounter || 0) + 1;
  return `COM-${String(globalThis.pulseMemoryCommunicationCounter).padStart(3, "0")}`;
}
/** Shared helper so every repository audits the same way in memory mode. */
export function memoryAuditEvent(
  identity: { id: string; name: string; organizationId: string },
  action: string,
  entityType: string,
  entityId: string | undefined,
  after: unknown,
  before?: unknown,
) {
  globalThis.pulseMemoryAudit ||= [];
  globalThis.pulseMemoryAudit.unshift({
    id: crypto.randomUUID(),
    actor: identity.name,
    organizationId: identity.organizationId,
    action,
    entityType,
    entityId,
    before,
    after,
    correlationId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });
}
export function resetCommunicationMemory() {
  globalThis.pulseMemoryCommunicationContacts = undefined;
  globalThis.pulseMemoryCommunicationSuppressions = undefined;
  globalThis.pulseMemoryCommunications = undefined;
  globalThis.pulseMemoryCommunicationDeliveries = undefined;
  globalThis.pulseMemoryCommunicationEvents = undefined;
  globalThis.pulseMemoryCommunicationSettings = undefined;
  globalThis.pulseMemoryCommunicationCounter = undefined;
}
```

(`globalThis.pulseMemoryAudit` is already declared in `lib/server/operations-repository.ts`; importing that module's type is not needed because the global declaration is ambient.)

- [ ] **Step 7: Settings contract** — append to `lib/contracts.ts`:

```ts
const emailAddress = z.string().trim().toLowerCase().max(320).email();
const domainName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,63}$/);
const boilerplateSchema = z.object({
  signOff: z.string().trim().min(1).max(200),
  footer: z.string().trim().max(500),
  supportEmail: emailAddress,
});
export const communicationSettingsInputSchema = z
  .object({
    enabled: z.boolean(),
    fromName: z.string().trim().min(1).max(100),
    fromEmail: z.union([emailAddress, z.literal("")]),
    replyTo: z.union([emailAddress, z.literal("")]),
    dataResidency: z.enum(["global", "eu"]),
    unsubscribeGroupId: z.number().int().positive().nullable(),
    sandboxMode: z.boolean(),
    safeMode: z.object({ enabled: z.boolean(), allowedDomains: z.array(domainName).max(50) }),
    tracking: z.object({ opens: z.boolean(), clicks: z.boolean() }),
    dailyCap: z.number().int().min(1).max(1_000_000),
    maxRecipientsPerCampaign: z.number().int().min(1).max(100_000),
    categoriesPrefix: z.string().trim().regex(/^[a-z0-9-]{1,40}$/),
    boilerplate: z.object({ en: boilerplateSchema, is: boilerplateSchema }),
  })
  .refine((v) => !v.enabled || v.fromEmail !== "", { message: "fromEmail required when enabled" });
```

- [ ] **Step 8: Failing tests** — create `tests/communications.test.ts`:

```ts
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PulseIdentity } from "../lib/domain";
import { resetCommunicationMemory } from "../lib/server/communications/memory";
import {
  DEFAULT_COMMUNICATION_SETTINGS,
  getCommunicationSettings,
  getRuntimeCommunicationSettings,
  saveCommunicationSettings,
  communicationProviderStatus,
} from "../lib/server/communications/settings";

export const ADMIN: PulseIdentity = {
  id: "11111111-1111-4111-8111-111111111111", email: "bjarki@uidata.com",
  name: "Bjarki", organizationId: "ORG-INTERNAL", role: "System admin", isInternal: true,
};
export const PM: PulseIdentity = {
  id: "44444444-4444-4444-8444-444444444444", email: "pm@datacentral.ai",
  name: "Product Manager", organizationId: "ORG-INTERNAL", role: "Product manager", isInternal: true,
};
export const CONTRIBUTOR: PulseIdentity = {
  id: "33333333-3333-4333-8333-333333333333", email: "staff@datacentral.ai",
  name: "Staff", organizationId: "ORG-INTERNAL", role: "Internal contributor", isInternal: true,
};
export const COMPANY_ADMIN: PulseIdentity = {
  id: "55555555-5555-4555-8555-555555555555", email: "admin@origo.is",
  name: "Origo Admin", organizationId: "ORG-001", role: "Company admin", isInternal: false,
};
export const REQUESTER: PulseIdentity = {
  id: "22222222-2222-4222-8222-222222222222", email: "jon@origo.is",
  name: "Jón Jónsson", organizationId: "ORG-001", role: "Requester", isInternal: false,
};

beforeEach(() => {
  delete process.env.AZURE_SQL_CONNECTION_STRING;
  delete process.env.AZURE_SQL_SERVER;
  delete process.env.SENDGRID_API_KEY;
  delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
  globalThis.pulseMemoryUsers = undefined;
  globalThis.pulseMemoryOrganizations = undefined;
  globalThis.pulseMemoryAudit = undefined;
  globalThis.pulseMemoryNotificationPreferences = undefined;
  globalThis.pulseMemoryLocales = undefined;
  resetCommunicationMemory();
});

test("settings: defaults are safe (disabled, safe mode on, datacentral.ai allow-listed)", async () => {
  const settings = await getRuntimeCommunicationSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.safeMode.enabled, true);
  assert.deepEqual(settings.safeMode.allowedDomains, ["datacentral.ai"]);
  assert.equal(settings.dailyCap, 5000);
});

test("settings: only System admins read or save", async () => {
  await assert.rejects(getCommunicationSettings(PM), /FORBIDDEN/);
  await assert.rejects(saveCommunicationSettings(PM, DEFAULT_COMMUNICATION_SETTINGS), /FORBIDDEN/);
});

test("settings: enabling requires a from address; domains are normalised; audit written", async () => {
  await assert.rejects(
    saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "" }),
    /INVALID_INPUT/,
  );
  const saved = await saveCommunicationSettings(ADMIN, {
    ...DEFAULT_COMMUNICATION_SETTINGS,
    enabled: true,
    fromEmail: "Updates@DataCentral.ai",
    safeMode: { enabled: true, allowedDomains: ["DataCentral.AI", "origo.is"] },
  });
  assert.equal(saved.fromEmail, "updates@datacentral.ai");
  assert.deepEqual(saved.safeMode.allowedDomains, ["datacentral.ai", "origo.is"]);
  assert.equal(globalThis.pulseMemoryAudit?.[0]?.action, "communication.settings.updated");
  const status = communicationProviderStatus(saved);
  assert.equal(status.providerConfigured, false);
  assert.equal(status.effectiveSendingState, "provider-missing");
});

test("settings: effective sending state reflects provider, safe mode and sandbox", async () => {
  process.env.SENDGRID_API_KEY = "SG.test";
  const live = { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai", safeMode: { enabled: false, allowedDomains: [] } };
  assert.equal(communicationProviderStatus(live).effectiveSendingState, "live");
  assert.equal(communicationProviderStatus({ ...live, sandboxMode: true }).effectiveSendingState, "sandbox");
  assert.equal(communicationProviderStatus({ ...live, safeMode: { enabled: true, allowedDomains: ["datacentral.ai"] } }).effectiveSendingState, "safe-mode");
  assert.equal(communicationProviderStatus({ ...live, enabled: false }).effectiveSendingState, "disabled");
});
```

Append `tests/communications.test.ts` to the `test` script in `package.json` (after `tests/security.test.ts`, space-separated like the others).

- [ ] **Step 9: Run** — `npm test` → FAIL (module `settings` not found).

- [ ] **Step 10: Settings repository** — `lib/server/communications/settings.ts`:

```ts
import { communicationSettingsInputSchema } from "@/lib/contracts";
import type { PulseIdentity } from "@/lib/domain";
import { requireInternalRole } from "../authorization";
import { beginSqlTransaction, getSqlPool, isAzureSqlConfigured, sql } from "../database";
import { parseInput } from "../validation";
import { memoryAuditEvent } from "./memory";

export type CommunicationSettings = {
  enabled: boolean;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  dataResidency: "global" | "eu";
  unsubscribeGroupId: number | null;
  sandboxMode: boolean;
  safeMode: { enabled: boolean; allowedDomains: string[] };
  tracking: { opens: boolean; clicks: boolean };
  dailyCap: number;
  maxRecipientsPerCampaign: number;
  categoriesPrefix: string;
  boilerplate: {
    en: { signOff: string; footer: string; supportEmail: string };
    is: { signOff: string; footer: string; supportEmail: string };
  };
};

export const DEFAULT_COMMUNICATION_SETTINGS: CommunicationSettings = {
  enabled: false,
  fromName: "DataCentral",
  fromEmail: "",
  replyTo: "",
  dataResidency: "global",
  unsubscribeGroupId: null,
  sandboxMode: false,
  safeMode: { enabled: true, allowedDomains: ["datacentral.ai"] },
  tracking: { opens: true, clicks: true },
  dailyCap: 5000,
  maxRecipientsPerCampaign: 5000,
  categoriesPrefix: "pulse",
  boilerplate: {
    en: { signOff: "Best,\nThe DataCentral Team", footer: "DataCentral ehf. · Reykjavík, Iceland", supportEmail: "support@datacentral.ai" },
    is: { signOff: "Kær kveðja,\nDataCentral teymið", footer: "DataCentral ehf. · Reykjavík", supportEmail: "support@datacentral.ai" },
  },
};

const SETTING_KEY = "communications";

export type SendingState = "disabled" | "provider-missing" | "sandbox" | "safe-mode" | "live";
export function communicationProviderStatus(settings: CommunicationSettings) {
  const providerConfigured = Boolean(process.env.SENDGRID_API_KEY?.trim());
  const webhookConfigured = Boolean(process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY?.trim());
  const base = (process.env.PULSE_PUBLIC_URL || "http://localhost:3000").replace(/\/+$/, "");
  const effectiveSendingState: SendingState = !settings.enabled
    ? "disabled"
    : !providerConfigured
      ? "provider-missing"
      : settings.sandboxMode
        ? "sandbox"
        : settings.safeMode.enabled
          ? "safe-mode"
          : "live";
  return {
    providerConfigured,
    webhookConfigured,
    webhookUrl: `${base}/api/v1/internal/communications/events`,
    effectiveSendingState,
  };
}

function merge(stored: unknown): CommunicationSettings {
  const value = (stored && typeof stored === "object" ? stored : {}) as Partial<CommunicationSettings>;
  return {
    ...DEFAULT_COMMUNICATION_SETTINGS,
    ...value,
    safeMode: { ...DEFAULT_COMMUNICATION_SETTINGS.safeMode, ...(value.safeMode || {}) },
    tracking: { ...DEFAULT_COMMUNICATION_SETTINGS.tracking, ...(value.tracking || {}) },
    boilerplate: {
      en: { ...DEFAULT_COMMUNICATION_SETTINGS.boilerplate.en, ...(value.boilerplate?.en || {}) },
      is: { ...DEFAULT_COMMUNICATION_SETTINGS.boilerplate.is, ...(value.boilerplate?.is || {}) },
    },
  };
}

/** No authorisation: used by the worker, the webhook and the renderer. */
export async function getRuntimeCommunicationSettings(): Promise<CommunicationSettings> {
  if (!isAzureSqlConfigured())
    return structuredClone(globalThis.pulseMemoryCommunicationSettings || DEFAULT_COMMUNICATION_SETTINGS);
  const result = await (await getSqlPool())
    .request()
    .input("key", sql.NVarChar(100), SETTING_KEY)
    .query("SELECT value_json value FROM dbo.Settings WHERE setting_key=@key");
  return merge(result.recordset[0]?.value ? JSON.parse(result.recordset[0].value) : null);
}

export async function getCommunicationSettings(identity: PulseIdentity) {
  await requireInternalRole(identity, ["System admin"]);
  return getRuntimeCommunicationSettings();
}

export async function saveCommunicationSettings(identity: PulseIdentity, input: CommunicationSettings) {
  const parsed = parseInput(communicationSettingsInputSchema, input) as CommunicationSettings;
  await requireInternalRole(identity, ["System admin"]);
  const saved: CommunicationSettings = {
    ...parsed,
    safeMode: { ...parsed.safeMode, allowedDomains: [...new Set(parsed.safeMode.allowedDomains)] },
  };
  if (!isAzureSqlConfigured()) {
    const before = globalThis.pulseMemoryCommunicationSettings;
    globalThis.pulseMemoryCommunicationSettings = structuredClone(saved);
    memoryAuditEvent(identity, "communication.settings.updated", "Settings", undefined, saved, before);
    return structuredClone(saved);
  }
  const pool = await getSqlPool();
  const scope = await beginSqlTransaction(pool);
  try {
    const prior = await new sql.Request(scope.transaction)
      .input("key", sql.NVarChar(100), SETTING_KEY)
      .query("SELECT value_json value FROM dbo.Settings WITH (UPDLOCK,HOLDLOCK) WHERE setting_key=@key");
    await new sql.Request(scope.transaction)
      .input("key", sql.NVarChar(100), SETTING_KEY)
      .input("value", sql.NVarChar(sql.MAX), JSON.stringify(saved))
      .input("actor", sql.UniqueIdentifier, identity.id).query(`
        MERGE dbo.Settings target USING(SELECT @key setting_key) source ON target.setting_key=source.setting_key
        WHEN MATCHED THEN UPDATE SET value_json=@value,version=version+1,updated_by_user_id=@actor,updated_at=SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT(setting_key,value_json,updated_by_user_id) VALUES(@key,@value,@actor);`);
    await new sql.Request(scope.transaction)
      .input("id", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("before", sql.NVarChar(sql.MAX), prior.recordset[0]?.value || null)
      .input("after", sql.NVarChar(sql.MAX), JSON.stringify(saved))
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .query("INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,before_json,after_json,correlation_id) VALUES(@id,@actor,'communication.settings.updated','Settings',@before,@after,@correlation)");
    await scope.commit();
    return saved;
  } catch (error) {
    await scope.rollback();
    throw error;
  }
}
```

- [ ] **Step 11: Run** — `npm test` → PASS for the four settings tests (and all existing tests).

- [ ] **Step 12: Commit**

```bash
git add database/migrations/015_customer_communications.sql lib/server/communications lib/contracts.ts lib/server/notification-preference-repository.ts README.md docs/architecture.md tests/communications.test.ts package.json
git commit -m "feat(communications): schema, topics, types and SendGrid settings repository"
```

### Task 2: Content contracts, HTML helpers and branded templates

**Files:**
- Modify: `lib/contracts.ts` (append body schemas + `communicationInputSchema`)
- Create: `lib/server/communications/html.ts`
- Create: `lib/server/communications/templates/layout.ts`
- Create: `lib/server/communications/templates/product-update.ts`
- Create: `lib/server/communications/templates/service-notice.ts`
- Create: `lib/server/communications/templates/plain.ts`
- Create: `lib/server/communications/templates/index.ts`
- Create: `scripts/render-email-logo.mjs`, `public/email/datacentral-logo.png`
- Test: `tests/communications.test.ts` (extend)

**Interfaces:**
- Consumes: `CommunicationContent`, `TemplateKey`, `EmailLocale` (Task 1), `CommunicationSettings["boilerplate"]` (Task 1).
- Produces: `escapeHtml(s)`, `renderInline(s)`, `renderParagraphs(s)`, `inlineToText(s)` (html.ts); `templateBodySchemas: Record<TemplateKey, ZodType>`, `productUpdateBodySchema`, `serviceNoticeBodySchema`, `plainBodySchema`, `communicationInputSchema`, `audienceSpecSchema`, `localizedTextSchema`, `httpsUrl` (contracts.ts); `renderCommunication(templateKey, content, locale, ctx): RenderedEmail` and `getTemplate(key)`/`TEMPLATES` (templates/index.ts) where

```ts
export type RenderContext = {
  publicUrl: string;                 // PULSE_PUBLIC_URL without trailing slash
  boilerplate: { signOff: string; footer: string; supportEmail: string };
  unsubscribeTags: boolean;          // true when an ASM group is configured → footer renders <%asm_group_unsubscribe_raw_url%>
  testPrefix?: boolean;              // "[TEST] " subject prefix
};
export type RenderedEmail = { subject: string; preheader: string; html: string; text: string };
export type EmailTemplate = {
  key: TemplateKey;
  name: { en: string; is: string };
  bodySchema: z.ZodType;
  render(body: Record<string, unknown>, locale: EmailLocale, ctx: RenderContext): { html: string; text: string };
};
```

- [ ] **Step 1: Contracts** — append to `lib/contracts.ts`:

```ts
export const httpsUrl = z.string().trim().url().max(2000).refine((v) => v.startsWith("https://"));
const emailText = (max: number) => z.string().trim().max(max);
export const localizedTextSchema = z.object({ en: emailText(200).min(1), is: emailText(200).optional() });
const linkSchema = z.object({ label: emailText(120).min(1), url: httpsUrl });
export const productUpdateBodySchema = z.object({
  eyebrow: emailText(60).optional(),
  title: emailText(140).min(1),
  subtitle: emailText(200).optional(),
  intro: emailText(2000).min(1),
  highlightsLabel: emailText(60).optional(),
  sections: z
    .array(
      z.object({
        heading: emailText(120).min(1),
        body: emailText(2000).min(1),
        callout: z.object({ tone: z.enum(["warning", "info"]), label: emailText(80).optional(), text: emailText(600).min(1) }).optional(),
        link: linkSchema.optional(),
      }),
    )
    .min(1)
    .max(8),
  note: emailText(600).optional(),
  cta: linkSchema.optional(),
  signOff: emailText(200).optional(),
});
export const serviceNoticeBodySchema = z.object({
  title: emailText(140).min(1),
  summary: emailText(2000).min(1),
  window: z.object({ startsAt: emailText(40).min(1), endsAt: emailText(40).min(1), timezone: emailText(40).min(1) }).optional(),
  impact: emailText(1000).optional(),
  actions: z.array(emailText(300).min(1)).max(10).default([]),
  link: linkSchema.optional(),
  contact: emailText(200).optional(),
  signOff: emailText(200).optional(),
});
export const plainBodySchema = z.object({
  title: emailText(140).min(1),
  paragraphs: z.array(emailText(2000).min(1)).min(1).max(12),
  cta: linkSchema.optional(),
  signOff: emailText(200).optional(),
});
export const templateBodySchemas = {
  "product-update": productUpdateBodySchema,
  "service-notice": serviceNoticeBodySchema,
  plain: plainBodySchema,
} as const;
export const audienceSpecSchema = z.object({
  organizations: z.union([z.literal("all-customers"), z.array(z.string().min(1).max(32)).max(500)]),
  includeOnboarding: z.boolean().default(false),
  includeTestOrganizations: z.boolean().default(false),
  includeMembers: z.boolean().default(true),
  memberRoles: z.array(z.enum(["Company admin", "Requester", "Viewer"])).min(1).max(3).nullable().default(null),
  includeContacts: z.boolean().default(true),
  includeInternalCopy: z.boolean().default(false),
});
export const communicationInputSchema = z
  .object({
    templateKey: z.enum(["product-update", "service-notice", "plain"]),
    topic: z.enum(["product-updates", "service-notices", "security-advisories", "general"]),
    title: shortText.min(1),
    content: z.object({
      subject: localizedTextSchema,
      preheader: localizedTextSchema.partial({ en: true }).optional(),
      body: z.object({ en: z.record(z.string(), z.unknown()), is: z.record(z.string(), z.unknown()).optional() }),
    }),
    audience: audienceSpecSchema,
    fromReleaseId: z.string().regex(/^REL-\d+$/).optional(),
  })
  .superRefine((value, ctx) => {
    const schema = templateBodySchemas[value.templateKey];
    for (const locale of ["en", "is"] as const) {
      const body = value.content.body[locale];
      if (body === undefined) continue;
      const result = schema.safeParse(body);
      if (!result.success)
        ctx.addIssue({ code: "custom", path: ["content", "body", locale], message: "invalid template body" });
    }
  });
export const communicationSendInputSchema = z.object({ scheduledAt: z.iso.datetime().optional() }).strict();
export const communicationTestSendSchema = z.object({ extraRecipients: z.array(emailAddress).max(5).default([]) }).strict();
```

(`emailAddress` and `shortText` already exist in the file from Task 1 / earlier code.)

- [ ] **Step 2: Failing template tests** — append to `tests/communications.test.ts`:

```ts
import { escapeHtml, renderInline, inlineToText } from "../lib/server/communications/html";
import { renderCommunication } from "../lib/server/communications/templates/index";
import { communicationInputSchema, productUpdateBodySchema } from "../lib/contracts";

const ctx = {
  publicUrl: "https://pulse.test",
  boilerplate: { signOff: "Best,\nThe DataCentral Team", footer: "DataCentral ehf.", supportEmail: "support@datacentral.ai" },
  unsubscribeTags: true,
};
const productUpdate = {
  subject: { en: "DataCentral 3.0.0", is: "DataCentral 3.0.0 (is)" },
  body: {
    en: {
      title: "DataCentral 3.0.0",
      subtitle: "Better visibility and more efficient Power BI administration.",
      intro: "DataCentral 3.0.0 is now available.",
      sections: [
        {
          heading: "New built-in Admin Report",
          body: "See report activity, **adoption** and usage trends. [Setup guide](https://docs.datacentral.ai/admin-report)",
          callout: { tone: "warning", label: "Action required for existing tenants", text: "A Host Administrator must enable the Admin Report." },
          link: { label: "View the setup guide and video", url: "https://docs.datacentral.ai/admin-report" },
        },
      ],
      note: "DataCentral 3.0.0 also displays dates and times in each user's local time.",
      cta: { label: "Explore DataCentral 3.0.0", url: "https://app.datacentral.ai" },
    },
  },
};

test("html: escapes HTML and only renders https links", () => {
  assert.equal(escapeHtml(`<b>"x" & 'y'</b>`), "&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;");
  const html = renderInline("Hello **world** [docs](https://docs.datacentral.ai/a?b=1&c=2) [bad](javascript:alert(1)) <script>x</script>");
  assert.match(html, /<strong>world<\/strong>/);
  assert.match(html, /<a href="https:\/\/docs\.datacentral\.ai\/a\?b=1&amp;c=2"/);
  assert.ok(!html.includes('href="javascript:'), "non-https links stay literal (escaped) text, never an href");
  assert.ok(!html.includes("<script>"));
  assert.equal(inlineToText("Hello **world** [docs](https://x.test)"), "Hello world docs (https://x.test)");
});

test("templates: product update renders brand chrome, sections, callout, CTA and plain text", () => {
  const rendered = renderCommunication("product-update", productUpdate, "en", ctx);
  assert.equal(rendered.subject, "DataCentral 3.0.0");
  assert.match(rendered.html, /Product update/);
  assert.match(rendered.html, /#f9c815/); // brand stripe
  assert.match(rendered.html, /https:\/\/pulse\.test\/email\/datacentral-logo\.png/);
  assert.match(rendered.html, /Action required for existing tenants/);
  assert.match(rendered.html, /Explore DataCentral 3\.0\.0/);
  assert.match(rendered.html, /<%asm_group_unsubscribe_raw_url%>/);
  assert.match(rendered.text, /New built-in Admin Report/);
  assert.match(rendered.text, /Explore DataCentral 3\.0\.0: https:\/\/app\.datacentral\.ai/);
  assert.ok(!rendered.html.includes("<script"));
});

test("templates: Icelandic falls back to English body but uses Icelandic chrome and subject", () => {
  const rendered = renderCommunication("product-update", productUpdate, "is", ctx);
  assert.equal(rendered.subject, "DataCentral 3.0.0 (is)");
  assert.match(rendered.html, /Vöruuppfærsla/);
  assert.match(rendered.html, /Aðgerðar þörf|Action required for existing tenants/);
  assert.match(rendered.html, /Afskrá/);
});

test("templates: test prefix and missing unsubscribe group", () => {
  const rendered = renderCommunication("plain", { subject: { en: "Hello" }, body: { en: { title: "Hi", paragraphs: ["One"] } } }, "en", { ...ctx, unsubscribeTags: false, testPrefix: true });
  assert.equal(rendered.subject, "[TEST] Hello");
  assert.ok(!rendered.html.includes("asm_group_unsubscribe"));
  assert.match(rendered.html, /support@datacentral\.ai/);
});

test("contracts: rejects non-https links in content and unknown template bodies", () => {
  assert.equal(productUpdateBodySchema.safeParse({ ...productUpdate.body.en, cta: { label: "x", url: "http://x.test" } }).success, false);
  const invalid = communicationInputSchema.safeParse({
    templateKey: "product-update", topic: "product-updates", title: "t",
    content: { subject: { en: "s" }, body: { en: { title: "only" } } },
    audience: { organizations: "all-customers" },
  });
  assert.equal(invalid.success, false);
  const valid = communicationInputSchema.safeParse({
    templateKey: "product-update", topic: "product-updates", title: "t",
    content: productUpdate, audience: { organizations: ["ORG-001"] },
  });
  assert.equal(valid.success, true);
  assert.equal(valid.data?.audience.includeMembers, true);
});
```

- [ ] **Step 3: Run** — `npm test` → FAIL (`html` module not found).

- [ ] **Step 4: HTML helpers** — `lib/server/communications/html.ts`:

```ts
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}
const LINK = /\[([^\]\n]{1,200})\]\((https:\/\/[^\s)<>"']{1,2000})\)/g;
const BOLD = /\*\*([^*\n]{1,300})\*\*/g;
/** Escape first, then upgrade **bold**, [label](https://…) and newlines. Everything else stays literal. */
export function renderInline(value: string): string {
  return escapeHtml(value)
    .replace(LINK, (_m, label: string, url: string) => `<a href="${url}" style="color:#7c3aed;font-weight:600;text-decoration:underline;">${label}</a>`)
    .replace(BOLD, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}
export function renderParagraphs(value: string, style = "margin:0 0 14px 0;font-size:15px;line-height:24px;color:#171717;"): string {
  return value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p style="${style}">${renderInline(paragraph)}</p>`)
    .join("");
}
export function inlineToText(value: string): string {
  return value.replace(LINK, "$1 ($2)").replace(BOLD, "$1");
}
```

Note the escape runs before the link regex, so `&` inside a URL is already `&amp;` (correct inside an attribute) and quotes can never terminate the attribute.

- [ ] **Step 5: Layout** — `lib/server/communications/templates/layout.ts`:

```ts
import type { EmailLocale } from "../types";
import type { RenderContext } from "./index";
import { escapeHtml, inlineToText, renderInline } from "../html";

export const FONT_HEADING = "'Space Grotesk',Arial,Helvetica,sans-serif";
export const FONT_BODY = "'IBM Plex Sans','Segoe UI',Arial,Helvetica,sans-serif";
export const COLORS = {
  page: "#fafafa", card: "#ffffff", text: "#171717", muted: "#737373", border: "#e5e5e5",
  violet: "#7c3aed", violetSoft: "#faf8ff", violetBorder: "#ddd6fe",
  amberSoft: "#fffbeb", amberBorder: "#f59e0b", amberText: "#92400e",
  stripe: ["#f9c815", "#f07124", "#ed0e78", "#6640a2"],
};
export const CHROME = {
  en: {
    productUpdate: "Product update", serviceNotice: "Service notice", announcement: "Announcement",
    actionRequired: "Action required", highlights: "Key highlights", unsubscribe: "Unsubscribe",
    preferences: "Manage email preferences in Pulse", questions: "Questions? Write to",
    reason: "You receive this email because your organisation uses DataCentral.",
    window: "When", impact: "Impact", actions: "What you need to do",
  },
  is: {
    productUpdate: "Vöruuppfærsla", serviceNotice: "Þjónustutilkynning", announcement: "Tilkynning",
    actionRequired: "Aðgerðar þörf", highlights: "Helstu atriði", unsubscribe: "Afskrá",
    preferences: "Stjórna tölvupóststillingum í Pulse", questions: "Spurningar? Sendu póst á",
    reason: "Þú færð þennan póst vegna þess að fyrirtækið þitt notar DataCentral.",
    window: "Hvenær", impact: "Áhrif", actions: "Það sem þú þarft að gera",
  },
} satisfies Record<EmailLocale, Record<string, string>>;
export const chrome = (locale: EmailLocale) => CHROME[locale];

export function eyebrow(text: string) {
  return `<p style="margin:0 0 10px 0;font-family:${FONT_BODY};font-size:12px;line-height:16px;letter-spacing:0.13em;text-transform:uppercase;font-weight:700;color:${COLORS.violet};">${escapeHtml(text)}</p>`;
}
export function heading1(text: string) {
  return `<h1 style="margin:0 0 8px 0;font-family:${FONT_HEADING};font-size:28px;line-height:34px;letter-spacing:-0.01em;font-weight:700;color:${COLORS.text};">${escapeHtml(text)}</h1>`;
}
export function heading2(text: string) {
  return `<h2 style="margin:24px 0 8px 0;font-family:${FONT_HEADING};font-size:18px;line-height:24px;font-weight:700;color:${COLORS.text};">${escapeHtml(text)}</h2>`;
}
export function subtitle(text: string) {
  return `<p style="margin:0 0 20px 0;font-family:${FONT_BODY};font-size:16px;line-height:24px;color:${COLORS.muted};">${escapeHtml(text)}</p>`;
}
export function callout(tone: "warning" | "info", label: string | undefined, text: string) {
  const bg = tone === "warning" ? COLORS.amberSoft : COLORS.violetSoft;
  const bar = tone === "warning" ? COLORS.amberBorder : COLORS.violet;
  const labelHtml = label ? `<strong style="color:${tone === "warning" ? COLORS.amberText : COLORS.violet};">${escapeHtml(label)}:</strong> ` : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 16px 0;"><tr><td style="background:${bg};border-left:3px solid ${bar};padding:12px 16px;font-family:${FONT_BODY};font-size:14px;line-height:22px;color:${COLORS.text};">${labelHtml}${renderInline(text)}</td></tr></table>`;
}
export function linkRow(label: string, url: string) {
  return `<p style="margin:4px 0 20px 0;font-family:${FONT_BODY};font-size:15px;line-height:22px;"><a href="${escapeHtml(url)}" style="color:${COLORS.violet};font-weight:700;text-decoration:none;">${escapeHtml(label)} &rarr;</a></p>`;
}
export function divider() {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid ${COLORS.border};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>`;
}
export function ctaButton(label: string, url: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td style="background:${COLORS.violet};border-radius:6px;"><a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 28px;font-family:${FONT_HEADING};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a></td></tr></table>`;
}
export function signOff(text: string) {
  const [first, ...rest] = text.split("\n");
  return `<p style="margin:24px 0 0 0;font-family:${FONT_BODY};font-size:15px;line-height:22px;color:${COLORS.text};">${escapeHtml(first)}${rest.length ? `<br><strong>${escapeHtml(rest.join(" "))}</strong>` : ""}</p>`;
}

/** Wraps rendered body HTML in the branded shell: stripe, logo, card, footer. */
export function shell(bodyHtml: string, locale: EmailLocale, ctx: RenderContext, preheader: string, title: string) {
  const c = chrome(locale);
  const stripe = COLORS.stripe.map((color) => `<td width="25%" style="background:${color};height:6px;font-size:0;line-height:0;">&nbsp;</td>`).join("");
  const unsubscribe = ctx.unsubscribeTags
    ? ` &middot; <a href="<%asm_group_unsubscribe_raw_url%>" style="color:${COLORS.muted};">${c.unsubscribe}</a>`
    : "";
  return `<!DOCTYPE html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:${COLORS.page};">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${COLORS.page};">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page};"><tr><td align="center" style="padding:0 0 32px 0;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:${COLORS.card};">
<tr>${stripe}</tr>
<tr><td style="padding:28px 32px 8px 32px;"><img src="${ctx.publicUrl}/email/datacentral-logo.png" width="170" alt="DataCentral" style="display:block;width:170px;height:auto;border:0;"></td></tr>
<tr><td style="padding:16px 32px 32px 32px;">${bodyHtml}</td></tr>
<tr><td style="padding:0 32px 28px 32px;">${divider()}
<p style="margin:16px 0 0 0;font-family:${FONT_BODY};font-size:12px;line-height:18px;color:${COLORS.muted};">${c.reason} ${c.questions} <a href="mailto:${escapeHtml(ctx.boilerplate.supportEmail)}" style="color:${COLORS.muted};">${escapeHtml(ctx.boilerplate.supportEmail)}</a>.</p>
<p style="margin:8px 0 0 0;font-family:${FONT_BODY};font-size:12px;line-height:18px;color:${COLORS.muted};">${escapeHtml(ctx.boilerplate.footer)} &middot; <a href="${ctx.publicUrl}/?page=updates" style="color:${COLORS.muted};">${c.preferences}</a>${unsubscribe}</p>
</td></tr></table></td></tr></table></body></html>`;
}

/** Plain-text counterpart of shell(): title, body lines, sign-off, footer. */
export function textShell(lines: string[], locale: EmailLocale, ctx: RenderContext) {
  const c = chrome(locale);
  const footer = [
    "",
    "--",
    `${c.reason} ${c.questions} ${ctx.boilerplate.supportEmail}.`,
    `${ctx.boilerplate.footer} · ${c.preferences}: ${ctx.publicUrl}/?page=updates`,
    ...(ctx.unsubscribeTags ? [`${c.unsubscribe}: <%asm_group_unsubscribe_raw_url%>`] : []),
  ];
  return [...lines, ...footer].map((line) => inlineToText(line)).join("\n");
}
```

- [ ] **Step 6: Product update template** — `lib/server/communications/templates/product-update.ts`:

```ts
import { productUpdateBodySchema } from "@/lib/contracts";
import type { z } from "zod";
import type { EmailLocale } from "../types";
import { renderParagraphs } from "../html";
import type { EmailTemplate, RenderContext } from "./index";
import { callout, chrome, ctaButton, eyebrow, heading1, heading2, linkRow, signOff, subtitle } from "./layout";

type Body = z.infer<typeof productUpdateBodySchema>;

function renderHtml(body: Body, locale: EmailLocale, ctx: RenderContext) {
  const c = chrome(locale);
  const parts = [
    eyebrow(body.eyebrow || c.productUpdate),
    heading1(body.title),
    body.subtitle ? subtitle(body.subtitle) : "",
    renderParagraphs(body.intro),
    `<p style="margin:20px 0 4px 0;font-family:'IBM Plex Sans','Segoe UI',Arial,sans-serif;font-size:15px;font-weight:700;color:#171717;">${body.highlightsLabel ? body.highlightsLabel.replace(/[&<>"']/g, "") : c.highlights}</p>`,
  ];
  body.sections.forEach((section, index) => {
    parts.push(heading2(section.heading), renderParagraphs(section.body));
    if (section.callout) parts.push(callout(section.callout.tone, section.callout.label, section.callout.text));
    if (section.link) parts.push(linkRow(section.link.label, section.link.url));
    if (index < body.sections.length - 1)
      parts.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid #e5e5e5;font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>`);
  });
  if (body.note) parts.push(callout("info", undefined, body.note));
  if (body.cta) parts.push(ctaButton(body.cta.label, body.cta.url));
  parts.push(signOff(body.signOff || ctx.boilerplate.signOff));
  return parts.join("");
}

function renderText(body: Body, locale: EmailLocale, ctx: RenderContext) {
  const c = chrome(locale);
  const lines = [body.eyebrow || c.productUpdate, body.title.toUpperCase(), body.subtitle || "", "", body.intro, "", `${body.highlightsLabel || c.highlights}`];
  for (const section of body.sections) {
    lines.push("", `== ${section.heading} ==`, section.body);
    if (section.callout) lines.push("", `${section.callout.label ? `${section.callout.label}: ` : ""}${section.callout.text}`);
    if (section.link) lines.push(`${section.link.label}: ${section.link.url}`);
  }
  if (body.note) lines.push("", body.note);
  if (body.cta) lines.push("", `${body.cta.label}: ${body.cta.url}`);
  lines.push("", body.signOff || ctx.boilerplate.signOff);
  return lines;
}

export const productUpdateTemplate: EmailTemplate = {
  key: "product-update",
  name: { en: "Product update", is: "Vöruuppfærsla" },
  bodySchema: productUpdateBodySchema,
  render(raw, locale, ctx) {
    const body = productUpdateBodySchema.parse(raw);
    return { html: renderHtml(body, locale, ctx), text: renderText(body, locale, ctx).join("\n") };
  },
};
```

- [ ] **Step 7: Service notice and plain templates** — `service-notice.ts` renders: `eyebrow(c.serviceNotice)`, `heading1(title)`, `renderParagraphs(summary)`, optional `callout("warning", c.window, "startsAt – endsAt (timezone)")`, optional `heading2(c.impact)` + paragraphs, optional `heading2(c.actions)` + `<ol>` of escaped actions, optional `linkRow`, optional `renderParagraphs(contact)`, `signOff`. `plain.ts` renders `eyebrow(c.announcement)`, `heading1(title)`, each paragraph through `renderParagraphs`, optional `ctaButton`, `signOff`. Both provide a text renderer mirroring the product-update pattern (`== heading ==` lines, `label: url` for links). Both export `serviceNoticeTemplate` / `plainTemplate` with the same `EmailTemplate` shape.

- [ ] **Step 8: Registry** — `lib/server/communications/templates/index.ts`:

```ts
import type { z } from "zod";
import type { CommunicationContent, EmailLocale, TemplateKey } from "../types";
import { productUpdateTemplate } from "./product-update";
import { serviceNoticeTemplate } from "./service-notice";
import { plainTemplate } from "./plain";
import { shell, textShell } from "./layout";

export type RenderContext = {
  publicUrl: string;
  boilerplate: { signOff: string; footer: string; supportEmail: string };
  unsubscribeTags: boolean;
  testPrefix?: boolean;
};
export type RenderedEmail = { subject: string; preheader: string; html: string; text: string };
export type EmailTemplate = {
  key: TemplateKey;
  name: { en: string; is: string };
  bodySchema: z.ZodType;
  render(body: Record<string, unknown>, locale: EmailLocale, ctx: RenderContext): { html: string; text: string };
};

export const TEMPLATES: Record<TemplateKey, EmailTemplate> = {
  "product-update": productUpdateTemplate,
  "service-notice": serviceNoticeTemplate,
  plain: plainTemplate,
};
export function getTemplate(key: string): EmailTemplate {
  const template = TEMPLATES[key as TemplateKey];
  if (!template) throw new Error("INVALID_TEMPLATE");
  return template;
}
/** Picks the locale variant (falling back to English) and wraps it in the branded shell. */
export function renderCommunication(templateKey: TemplateKey, content: CommunicationContent, locale: EmailLocale, ctx: RenderContext): RenderedEmail {
  const template = getTemplate(templateKey);
  const body = (locale === "is" && content.body.is) || content.body.en;
  const subjectRaw = (locale === "is" && content.subject.is) || content.subject.en;
  const subject = `${ctx.testPrefix ? "[TEST] " : ""}${subjectRaw}`;
  const preheader = (locale === "is" && content.preheader?.is) || content.preheader?.en || "";
  const rendered = template.render(body, locale, ctx);
  return {
    subject,
    preheader,
    html: shell(rendered.html, locale, ctx, preheader, subjectRaw),
    text: textShell([rendered.text], locale, ctx),
  };
}
```

- [ ] **Step 9: Logo asset** — `scripts/render-email-logo.mjs` (run once; commit the PNG):

```js
// Rasterises the black-text wordmark for email clients that cannot render SVG.
// Usage: node scripts/render-email-logo.mjs  → public/email/datacentral-logo.png (340px wide, 2x)
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
const svg = readFileSync("public/brand/datacentral-blacktext.svg", "utf8");
mkdirSync("public/email", { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 340, height: 120 }, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:#fff"><div id="logo" style="width:340px">${svg.replace(/<svg /, '<svg style="width:340px;height:auto" ')}</div></body></html>`);
const box = await page.locator("#logo svg").boundingBox();
await page.locator("#logo svg").screenshot({ path: "public/email/datacentral-logo.png", omitBackground: false });
console.log(`rendered ${Math.round(box.width)}x${Math.round(box.height)}`);
await browser.close();
```

Run: `node scripts/render-email-logo.mjs` → prints the size; verify `public/email/datacentral-logo.png` opens and looks like the wordmark on white.

- [ ] **Step 10: Run** — `npm test` → PASS. `npm run lint` → clean.

- [ ] **Step 11: Commit**

```bash
git add lib/contracts.ts lib/server/communications/html.ts lib/server/communications/templates scripts/render-email-logo.mjs public/email/datacentral-logo.png tests/communications.test.ts
git commit -m "feat(communications): content contracts and branded email templates"
```

---

### Task 3: Versioning and idempotency hooks

**Files:**
- Modify: `lib/server/versions.ts:5` (`VersionedEntity`)
- Modify: `lib/server/idempotency.ts:33-41` (operation prefix rule)
- Modify: `lib/server/admin-repository.ts:33` (export `organizations()`)
- Test: `tests/communications.test.ts` (extend)

**Interfaces:**
- Produces: `VersionedEntity` includes `"Communications"`; `executeIdempotent` treats operations starting with `communication.` as publish-role operations; `organizations()` exported from `admin-repository.ts` for memory-mode audience loading.

- [ ] **Step 1: Failing test**

```ts
import { executeIdempotent } from "../lib/server/idempotency";
import { checkedMutation } from "../lib/server/versions";

test("idempotency: communication.* operations require a publish role", async () => {
  const request = new Request("https://pulse.test/api/v1/internal/communications/COM-001/send", {
    method: "POST", headers: { "idempotency-key": "communications-test-key" }, body: "{}",
  });
  await assert.rejects(executeIdempotent(request, CONTRIBUTOR, "communication.send:COM-001", 200, async () => ({})), /FORBIDDEN/);
});

test("versions: Communications is a versioned entity", async () => {
  await assert.rejects(checkedMutation(PM, "Communications", "COM-001", null, async () => ({})), /PRECONDITION_REQUIRED/);
});
```

- [ ] **Step 2: Run** — `npm run typecheck` → FAIL (`"Communications"` not assignable to `VersionedEntity`).

- [ ] **Step 3: Implement** — `versions.ts`: `export type VersionedEntity = "Requests" | "Ideas" | "Releases" | "Communications";` (the SQL in `addVersions`/`checkedMutation` already selects `public_id`/`row_version` generically). `idempotency.ts`: change the regex to `/^(idea\.|release\.|triage\.|communication\.)/`. `admin-repository.ts`: `export function organizations() {`.

- [ ] **Step 4: Run** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/server/versions.ts lib/server/idempotency.ts lib/server/admin-repository.ts tests/communications.test.ts
git commit -m "feat(communications): version and idempotency hooks for campaigns"
```

---

### Task 4: Contact repository (internal and customer-scoped) with paste import

**Files:**
- Modify: `lib/contracts.ts` (append contact schemas)
- Create: `lib/server/communications/contact-repository.ts`
- Test: `tests/communications.test.ts` (extend)

**Interfaces:**
- Consumes: `ContactRecord`, `CommunicationTopic` (Task 1), `memoryContacts()`, `memoryAuditEvent()` (Task 1), `users()`/`organizations()` from `admin-repository` (memory seeds), `requireMembership`, `requireInternalRole`, `requirePublishRole`.
- Produces:
  - `listContacts(identity, organizationId?: string): Promise<ContactRecord[]>` — any internal role; `organizationId` filter optional.
  - `saveContact(identity, input: ContactInput): Promise<ContactRecord>` — Product manager / System admin; `input.id` empty for create.
  - `removeContact(identity, contactId): Promise<void>`.
  - `importContacts(identity, organizationId, lines: string): Promise<{ created: ContactRecord[]; skipped: Array<{ line: number; reason: "invalid" | "duplicate" }> }>`.
  - Customer-scoped: `listCompanyContacts(identity)`, `saveCompanyContact(identity, input)`, `removeCompanyContact(identity, contactId)`, `importCompanyContacts(identity, lines)` — `requireMembership(identity)` + role `Company admin`, always scoped to `identity.organizationId`.
  - `parseContactLines(text): { rows: Array<{ displayName: string; email: string }>; errors: number[] }` (pure).
  - `ContactInput = { id?: string; organizationId: string; email: string; displayName: string; locale: "en"|"is"; topics: CommunicationTopic[]; note?: string }`.

- [ ] **Step 1: Contracts** — append to `lib/contracts.ts`:

```ts
const topicEnum = z.enum(["product-updates", "service-notices", "security-advisories", "general"]);
export const communicationContactInputSchema = z.object({
  id: z.union([z.uuid(), z.literal("")]).optional(),
  organizationId: z.string().min(1).max(32),
  email: emailAddress,
  displayName: shortText.min(1),
  locale: z.enum(["en", "is"]).default("en"),
  topics: z.array(topicEnum).min(1).max(4),
  note: z.string().trim().max(500).optional(),
});
/** Customer self-service never names the organisation; it is the active membership. */
export const companyContactInputSchema = communicationContactInputSchema.omit({ organizationId: true });
export const communicationContactImportSchema = z.object({
  organizationId: z.string().min(1).max(32).optional(),
  lines: z.string().min(1).max(16000),
  topics: z.array(topicEnum).min(1).max(4).default(["product-updates", "service-notices"]),
});
```

- [ ] **Step 2: Failing tests** — append to `tests/communications.test.ts`:

```ts
import {
  importContacts, listCompanyContacts, listContacts, parseContactLines, removeContact,
  saveCompanyContact, saveContact, removeCompanyContact,
} from "../lib/server/communications/contact-repository";
import { listUsers } from "../lib/server/admin-repository";

async function seedOrganizations() {
  await listUsers(ADMIN); // seeds ORG-001 (Origo) and the default users
  globalThis.pulseMemoryOrganizations!.push({
    id: "ORG-002", name: "Advania", type: "Customer", status: "Active", domain: "advania.is",
    users: 0, requests: 0, authentication: ["OTP"],
  });
}

test("contacts: Product managers add contacts to any company; e-mails are normalised; duplicates rejected", async () => {
  await seedOrganizations();
  const saved = await saveContact(PM, { organizationId: "ORG-002", email: "Anna@Advania.IS", displayName: "Anna", locale: "is", topics: ["product-updates"] });
  assert.equal(saved.email, "anna@advania.is");
  assert.equal(saved.source, "Admin");
  await assert.rejects(
    saveContact(PM, { organizationId: "ORG-002", email: "anna@advania.is", displayName: "Dup", locale: "en", topics: ["general"] }),
    /INVALID_CONTACT_EXISTS/,
  );
  assert.equal((await listContacts(CONTRIBUTOR, "ORG-002")).length, 1);
  await assert.rejects(saveContact(CONTRIBUTOR, { organizationId: "ORG-002", email: "x@advania.is", displayName: "X", locale: "en", topics: ["general"] }), /FORBIDDEN/);
  await assert.rejects(saveContact(PM, { organizationId: "ORG-404", email: "x@y.is", displayName: "X", locale: "en", topics: ["general"] }), /NOT_FOUND/);
});

test("contacts: Company admins manage only their own company; requesters cannot", async () => {
  await seedOrganizations();
  const mine = await saveCompanyContact(COMPANY_ADMIN, { email: "cio@origo.is", displayName: "CIO", locale: "en", topics: ["product-updates", "service-notices"] });
  assert.equal(mine.organizationId, "ORG-001");
  assert.equal(mine.source, "Company admin");
  const other = await saveContact(PM, { organizationId: "ORG-002", email: "other@advania.is", displayName: "Other", locale: "en", topics: ["general"] });
  await assert.rejects(saveCompanyContact(COMPANY_ADMIN, { id: other.id, email: "other@advania.is", displayName: "Hijack", locale: "en", topics: ["general"] }), /NOT_FOUND/);
  await assert.rejects(removeCompanyContact(COMPANY_ADMIN, other.id), /NOT_FOUND/);
  assert.deepEqual((await listCompanyContacts(COMPANY_ADMIN)).map((c) => c.email), ["cio@origo.is"]);
  await assert.rejects(listCompanyContacts(REQUESTER), /FORBIDDEN/);
  await removeCompanyContact(COMPANY_ADMIN, mine.id);
  assert.equal((await listCompanyContacts(COMPANY_ADMIN)).length, 0);
  assert.equal(globalThis.pulseMemoryAudit?.[0]?.action, "communication.contact.removed");
});

test("contacts: paste import parses 'Name, email' and 'email' lines, skips invalid and duplicate rows, caps at 250", () => {
  const parsed = parseContactLines("Anna Á, Anna@advania.is\nbjorn@advania.is\nnot an email\n Anna Á , anna@advania.is ");
  assert.deepEqual(parsed.rows, [
    { displayName: "Anna Á", email: "anna@advania.is" },
    { displayName: "bjorn", email: "bjorn@advania.is" },
  ]);
  assert.deepEqual(parsed.errors, [3, 4]);
  const many = parseContactLines(Array.from({ length: 300 }, (_, i) => `u${i}@x.is`).join("\n"));
  assert.equal(many.rows.length, 250);
});

test("contacts: import creates rows with the chosen topics and reports duplicates", async () => {
  await seedOrganizations();
  await saveContact(PM, { organizationId: "ORG-002", email: "anna@advania.is", displayName: "Anna", locale: "en", topics: ["general"] });
  const result = await importContacts(PM, "ORG-002", "Anna, anna@advania.is\nBjörn, bjorn@advania.is", ["product-updates"]);
  assert.equal(result.created.length, 1);
  assert.deepEqual(result.created[0].topics, ["product-updates"]);
  assert.equal(result.created[0].source, "Import");
  assert.deepEqual(result.skipped, [{ line: 1, reason: "duplicate" }]);
});
```

- [ ] **Step 3: Run** — `npm test` → FAIL (module not found).

- [ ] **Step 4: Implement** — `lib/server/communications/contact-repository.ts`:

```ts
import { communicationContactInputSchema, companyContactInputSchema, communicationContactImportSchema } from "@/lib/contracts";
import type { PulseIdentity } from "@/lib/domain";
import { organizations } from "../admin-repository";
import { requireInternalRole, requireMembership, requirePublishRole } from "../authorization";
import { beginSqlTransaction, getSqlPool, isAzureSqlConfigured, sql } from "../database";
import { parseInput } from "../validation";
import { memoryAuditEvent, memoryContacts } from "./memory";
import type { CommunicationTopic, ContactRecord, ContactSource } from "./types";

export type ContactInput = {
  id?: string;
  organizationId: string;
  email: string;
  displayName: string;
  locale: "en" | "is";
  topics: CommunicationTopic[];
  note?: string;
};

const SELECT = `SELECT CAST(c.id AS nvarchar(36)) id,c.organization_id organizationId,CAST(c.user_id AS nvarchar(36)) userId,c.email,c.display_name displayName,c.locale,c.topics_json topicsJson,c.status,c.source,c.note,CONVERT(nvarchar(33),c.created_at,127) createdAt,CONVERT(nvarchar(33),c.updated_at,127) updatedAt FROM dbo.CommunicationContacts c`;
function fromRow(row: Record<string, unknown>): ContactRecord {
  return {
    id: String(row.id), organizationId: String(row.organizationId), userId: (row.userId as string) || null,
    email: String(row.email), displayName: String(row.displayName), locale: row.locale === "is" ? "is" : "en",
    topics: JSON.parse(String(row.topicsJson || "[]")), status: row.status as ContactRecord["status"],
    source: row.source as ContactSource, note: (row.note as string) || undefined,
    createdAt: String(row.createdAt), updatedAt: String(row.updatedAt),
  };
}

export function parseContactLines(text: string) {
  const rows: Array<{ displayName: string; email: string }> = [];
  const errors: number[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    if (rows.length >= 250) return;
    const parts = line.split(/[,;\t]/).map((p) => p.trim()).filter(Boolean);
    const email = (parts.length > 1 ? parts[parts.length - 1] : parts[0] || "").toLowerCase();
    const name = parts.length > 1 ? parts.slice(0, -1).join(" ") : email.split("@")[0];
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320 && name.length <= 200;
    if (!valid || seen.has(email)) { errors.push(index + 1); return; }
    seen.add(email);
    rows.push({ displayName: name, email });
  });
  return { rows, errors };
}

async function assertOrganizationExists(organizationId: string) {
  if (!isAzureSqlConfigured()) {
    if (!organizations().some((o) => o.id === organizationId && o.status !== "Inactive")) throw new Error("NOT_FOUND");
    return;
  }
  const result = await (await getSqlPool()).request().input("id", sql.NVarChar(32), organizationId)
    .query("SELECT 1 FROM dbo.Organizations WHERE id=@id AND status<>'Inactive'");
  if (!result.recordset.length) throw new Error("NOT_FOUND");
}

/** Shared write path; callers have already authorised and fixed organizationId. */
async function upsertContact(identity: PulseIdentity, input: ContactInput, source: ContactSource): Promise<ContactRecord> {
  const parsed = parseInput(communicationContactInputSchema, input);
  await assertOrganizationExists(parsed.organizationId);
  const now = new Date().toISOString();
  if (!isAzureSqlConfigured()) {
    const store = memoryContacts();
    const existing = parsed.id ? store.find((c) => c.id === parsed.id && c.organizationId === parsed.organizationId) : undefined;
    if (parsed.id && !existing) throw new Error("NOT_FOUND");
    if (store.some((c) => c.id !== existing?.id && c.organizationId === parsed.organizationId && c.email === parsed.email))
      throw new Error("INVALID_CONTACT_EXISTS");
    const record: ContactRecord = {
      id: existing?.id || crypto.randomUUID(), organizationId: parsed.organizationId, userId: existing?.userId ?? null,
      email: parsed.email, displayName: parsed.displayName, locale: parsed.locale, topics: [...new Set(parsed.topics)],
      status: existing?.status || "Active", source: existing?.source || source, note: parsed.note,
      createdAt: existing?.createdAt || now, updatedAt: now,
    };
    if (existing) Object.assign(existing, record); else store.push(record);
    memoryAuditEvent(identity, "communication.contact.saved", "CommunicationContact", record.id, { organizationId: record.organizationId, topics: record.topics, source: record.source }, existing && { topics: existing.topics });
    return structuredClone(record);
  }
  const pool = await getSqlPool();
  const scope = await beginSqlTransaction(pool);
  try {
    const id = parsed.id || crypto.randomUUID();
    const duplicate = await new sql.Request(scope.transaction)
      .input("org", sql.NVarChar(32), parsed.organizationId).input("email", sql.NVarChar(320), parsed.email).input("id", sql.UniqueIdentifier, id)
      .query("SELECT 1 FROM dbo.CommunicationContacts WITH (UPDLOCK,HOLDLOCK) WHERE organization_id=@org AND email=@email AND id<>@id AND deleted_at IS NULL");
    if (duplicate.recordset.length) throw new Error("INVALID_CONTACT_EXISTS");
    const result = await new sql.Request(scope.transaction)
      .input("id", sql.UniqueIdentifier, id).input("org", sql.NVarChar(32), parsed.organizationId)
      .input("email", sql.NVarChar(320), parsed.email).input("name", sql.NVarChar(200), parsed.displayName)
      .input("locale", sql.NVarChar(12), parsed.locale).input("topics", sql.NVarChar(sql.MAX), JSON.stringify([...new Set(parsed.topics)]))
      .input("source", sql.NVarChar(32), source).input("note", sql.NVarChar(500), parsed.note || null)
      .input("actor", sql.UniqueIdentifier, identity.id)
      .query(`MERGE dbo.CommunicationContacts target USING(SELECT @id id,@org organization_id) source
        ON target.id=source.id AND target.organization_id=source.organization_id AND target.deleted_at IS NULL
        WHEN MATCHED THEN UPDATE SET email=@email,display_name=@name,locale=@locale,topics_json=@topics,note=@note,updated_at=SYSUTCDATETIME()
        WHEN NOT MATCHED AND @id IS NOT NULL THEN INSERT(id,organization_id,user_id,email,display_name,locale,topics_json,source,note,created_by_user_id)
          VALUES(@id,@org,(SELECT TOP(1) u.id FROM dbo.Users u WHERE u.email=@email),@email,@name,@locale,@topics,@source,@note,@actor)
        OUTPUT $action action;`);
    if (parsed.id && result.recordset[0]?.action !== "UPDATE") throw new Error("NOT_FOUND");
    await new sql.Request(scope.transaction)
      .input("auditId", sql.UniqueIdentifier, crypto.randomUUID()).input("actor", sql.UniqueIdentifier, identity.id)
      .input("org", sql.NVarChar(32), parsed.organizationId).input("entity", sql.UniqueIdentifier, id)
      .input("after", sql.NVarChar(sql.MAX), JSON.stringify({ topics: parsed.topics, source }))
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .query("INSERT dbo.AuditEvents(id,actor_user_id,organization_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@auditId,@actor,@org,'communication.contact.saved','CommunicationContact',@entity,@after,@correlation)");
    const saved = await new sql.Request(scope.transaction).input("id", sql.UniqueIdentifier, id).query(`${SELECT} WHERE c.id=@id`);
    await scope.commit();
    return fromRow(saved.recordset[0]);
  } catch (error) {
    await scope.rollback();
    throw error;
  }
}

async function softDelete(identity: PulseIdentity, contactId: string, organizationId: string | null) {
  if (!isAzureSqlConfigured()) {
    const store = memoryContacts();
    const index = store.findIndex((c) => c.id === contactId && (!organizationId || c.organizationId === organizationId));
    if (index < 0) throw new Error("NOT_FOUND");
    const [removed] = store.splice(index, 1);
    memoryAuditEvent(identity, "communication.contact.removed", "CommunicationContact", removed.id, { organizationId: removed.organizationId });
    return;
  }
  const pool = await getSqlPool();
  const result = await pool.request().input("id", sql.UniqueIdentifier, contactId).input("org", sql.NVarChar(32), organizationId)
    .query("UPDATE dbo.CommunicationContacts SET deleted_at=SYSUTCDATETIME(),updated_at=SYSUTCDATETIME() OUTPUT INSERTED.organization_id organizationId WHERE id=@id AND deleted_at IS NULL AND (@org IS NULL OR organization_id=@org)");
  if (!result.recordset.length) throw new Error("NOT_FOUND");
  await pool.request().input("auditId", sql.UniqueIdentifier, crypto.randomUUID()).input("actor", sql.UniqueIdentifier, identity.id)
    .input("org", sql.NVarChar(32), result.recordset[0].organizationId).input("entity", sql.UniqueIdentifier, contactId)
    .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
    .query("INSERT dbo.AuditEvents(id,actor_user_id,organization_id,action,entity_type,entity_id,correlation_id) VALUES(@auditId,@actor,@org,'communication.contact.removed','CommunicationContact',@entity,@correlation)");
}

async function listScoped(organizationId: string | null): Promise<ContactRecord[]> {
  if (!isAzureSqlConfigured())
    return structuredClone(memoryContacts().filter((c) => !organizationId || c.organizationId === organizationId));
  const result = await (await getSqlPool()).request().input("org", sql.NVarChar(32), organizationId)
    .query(`${SELECT} WHERE c.deleted_at IS NULL AND (@org IS NULL OR c.organization_id=@org) ORDER BY c.display_name`);
  return result.recordset.map(fromRow);
}

async function importScoped(identity: PulseIdentity, organizationId: string, lines: string, topics: CommunicationTopic[], source: ContactSource) {
  const input = parseInput(communicationContactImportSchema, { organizationId, lines, topics });
  const parsed = parseContactLines(input.lines);
  const created: ContactRecord[] = [];
  const skipped: Array<{ line: number; reason: "invalid" | "duplicate" }> = parsed.errors.map((line) => ({ line, reason: "invalid" as const }));
  const lineOf = new Map(parsed.rows.map((row, i) => [row.email, i + 1]));
  for (const row of parsed.rows) {
    try {
      created.push(await upsertContact(identity, { organizationId, email: row.email, displayName: row.displayName, locale: "en", topics: input.topics }, source));
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_CONTACT_EXISTS") skipped.push({ line: lineOf.get(row.email) || 0, reason: "duplicate" });
      else throw error;
    }
  }
  return { created, skipped: skipped.sort((a, b) => a.line - b.line) };
}

// ---- internal (DataCentral staff) ----
export async function listContacts(identity: PulseIdentity, organizationId?: string) {
  await requireInternalRole(identity);
  return listScoped(organizationId || null);
}
export async function saveContact(identity: PulseIdentity, input: ContactInput) {
  await requirePublishRole(identity);
  return upsertContact(identity, input, "Admin");
}
export async function removeContact(identity: PulseIdentity, contactId: string) {
  await requirePublishRole(identity);
  return softDelete(identity, contactId, null);
}
export async function importContacts(identity: PulseIdentity, organizationId: string, lines: string, topics: CommunicationTopic[]) {
  await requirePublishRole(identity);
  return importScoped(identity, organizationId, lines, topics, "Import");
}

// ---- customer self-service (Company admin of the active organisation) ----
async function requireCompanyAdmin(identity: PulseIdentity) {
  const membership = await requireMembership(identity);
  if (membership.role !== "Company admin") throw new Error("FORBIDDEN");
  return identity.organizationId;
}
export async function listCompanyContacts(identity: PulseIdentity) {
  return listScoped(await requireCompanyAdmin(identity));
}
export async function saveCompanyContact(identity: PulseIdentity, input: Omit<ContactInput, "organizationId">) {
  const organizationId = await requireCompanyAdmin(identity);
  parseInput(companyContactInputSchema, input);
  return upsertContact(identity, { ...input, organizationId }, "Company admin");
}
export async function removeCompanyContact(identity: PulseIdentity, contactId: string) {
  return softDelete(identity, contactId, await requireCompanyAdmin(identity));
}
export async function importCompanyContacts(identity: PulseIdentity, lines: string, topics: CommunicationTopic[]) {
  const organizationId = await requireCompanyAdmin(identity);
  return importScoped(identity, organizationId, lines, topics, "Company admin");
}
```

Memory-mode note: `requireMembership` returns `identity.role` without checking seeded memberships, so the test's `COMPANY_ADMIN` identity works with `organizationId: "ORG-001"`; `assertOrganizationExists` reads the exported `organizations()` seed.

- [ ] **Step 5: Run** — `npm test` → PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/contracts.ts lib/server/communications/contact-repository.ts tests/communications.test.ts
git commit -m "feat(communications): contact lists with company self-service and paste import"
```

---

### Task 5: Suppression repository

**Files:**
- Modify: `lib/contracts.ts` (append `communicationSuppressionInputSchema`)
- Create: `lib/server/communications/suppression-repository.ts`
- Test: `tests/communications.test.ts` (extend)

**Interfaces:**
- Produces:
  - `listSuppressions(identity): Promise<SuppressionRecord[]>` — any internal role.
  - `addSuppression(identity, input: { email: string; note?: string }): Promise<SuppressionRecord>` — System admin, `reason: "Manual"`, `source: "Admin"`.
  - `removeSuppression(identity, email): Promise<void>` — System admin.
  - `suppressAddress(email, reason, source, note?): Promise<void>` — **no identity** (webhook + worker path); upserts and marks matching contacts `Unsubscribed`/`Bounced`.
  - `releaseAddress(email, reason): Promise<void>` — no identity; removes only when the stored reason matches (used by `group_resubscribe`).
  - `loadSuppressionMap(): Promise<Map<string, SuppressionReason>>` — no identity; consumed by the audience loader.

- [ ] **Step 1: Contract**

```ts
export const communicationSuppressionInputSchema = z.object({ email: emailAddress, note: z.string().trim().max(500).optional() }).strict();
```

- [ ] **Step 2: Failing tests**

```ts
import { addSuppression, listSuppressions, loadSuppressionMap, releaseAddress, removeSuppression, suppressAddress } from "../lib/server/communications/suppression-repository";

test("suppressions: System admin manages manually; others read only; contacts are flagged", async () => {
  await seedOrganizations();
  const contact = await saveContact(PM, { organizationId: "ORG-002", email: "anna@advania.is", displayName: "Anna", locale: "en", topics: ["general"] });
  await assert.rejects(addSuppression(PM, { email: "anna@advania.is" }), /FORBIDDEN/);
  const added = await addSuppression(ADMIN, { email: "Anna@Advania.is", note: "asked by phone" });
  assert.equal(added.email, "anna@advania.is");
  assert.equal(added.reason, "Manual");
  assert.equal((await listSuppressions(CONTRIBUTOR)).length, 1);
  assert.equal((await listContacts(PM, "ORG-002")).find((c) => c.id === contact.id)?.status, "Unsubscribed");
  await removeSuppression(ADMIN, "anna@advania.is");
  assert.equal((await loadSuppressionMap()).size, 0);
});

test("suppressions: webhook path upserts by reason and release only removes a matching reason", async () => {
  await suppressAddress("bounce@origo.is", "Bounced", "Webhook", "550 user unknown");
  await suppressAddress("bounce@origo.is", "Unsubscribed", "Webhook");
  assert.equal((await loadSuppressionMap()).get("bounce@origo.is"), "Unsubscribed");
  await releaseAddress("bounce@origo.is", "Bounced"); // reason mismatch → stays
  assert.equal((await loadSuppressionMap()).get("bounce@origo.is"), "Unsubscribed");
  await releaseAddress("bounce@origo.is", "Unsubscribed");
  assert.equal((await loadSuppressionMap()).has("bounce@origo.is"), false);
});
```

- [ ] **Step 3: Run** — `npm test` → FAIL.

- [ ] **Step 4: Implement** — `lib/server/communications/suppression-repository.ts`:

```ts
import { communicationSuppressionInputSchema } from "@/lib/contracts";
import type { PulseIdentity } from "@/lib/domain";
import { requireInternalRole } from "../authorization";
import { getSqlPool, isAzureSqlConfigured, sql } from "../database";
import { parseInput } from "../validation";
import { memoryAuditEvent, memoryContacts, memorySuppressions } from "./memory";
import type { SuppressionReason, SuppressionRecord } from "./types";

function contactStatusFor(reason: SuppressionReason) {
  return reason === "Bounced" ? "Bounced" : "Unsubscribed";
}

export async function suppressAddress(email: string, reason: SuppressionReason, source: "Webhook" | "Admin", note?: string, actorId?: string) {
  const normalized = email.trim().toLowerCase();
  if (!isAzureSqlConfigured()) {
    const store = memorySuppressions();
    const existing = store.find((s) => s.email === normalized);
    const record: SuppressionRecord = { email: normalized, reason, source, note, createdAt: existing?.createdAt || new Date().toISOString() };
    if (existing) Object.assign(existing, record); else store.push(record);
    for (const contact of memoryContacts()) if (contact.email === normalized) contact.status = contactStatusFor(reason);
    return;
  }
  const pool = await getSqlPool();
  await pool.request().input("email", sql.NVarChar(320), normalized).input("reason", sql.NVarChar(32), reason)
    .input("source", sql.NVarChar(32), source).input("note", sql.NVarChar(500), note?.slice(0, 500) || null)
    .input("actor", sql.UniqueIdentifier, actorId || null).input("status", sql.NVarChar(32), contactStatusFor(reason))
    .query(`MERGE dbo.CommunicationSuppressions target USING(SELECT @email email) source ON target.email=source.email
      WHEN MATCHED THEN UPDATE SET reason=@reason,source=@source,note=@note
      WHEN NOT MATCHED THEN INSERT(email,reason,source,note,created_by_user_id) VALUES(@email,@reason,@source,@note,@actor);
      UPDATE dbo.CommunicationContacts SET status=@status,updated_at=SYSUTCDATETIME() WHERE email=@email AND deleted_at IS NULL;`);
}

export async function releaseAddress(email: string, reason: SuppressionReason) {
  const normalized = email.trim().toLowerCase();
  if (!isAzureSqlConfigured()) {
    const store = memorySuppressions();
    const index = store.findIndex((s) => s.email === normalized && s.reason === reason);
    if (index < 0) return;
    store.splice(index, 1);
    for (const contact of memoryContacts()) if (contact.email === normalized) contact.status = "Active";
    return;
  }
  const pool = await getSqlPool();
  await pool.request().input("email", sql.NVarChar(320), normalized).input("reason", sql.NVarChar(32), reason)
    .query(`DELETE dbo.CommunicationSuppressions WHERE email=@email AND reason=@reason;
      IF @@ROWCOUNT>0 UPDATE dbo.CommunicationContacts SET status='Active',updated_at=SYSUTCDATETIME() WHERE email=@email AND deleted_at IS NULL;`);
}

export async function loadSuppressionMap(): Promise<Map<string, SuppressionReason>> {
  if (!isAzureSqlConfigured()) return new Map(memorySuppressions().map((s) => [s.email, s.reason]));
  const result = await (await getSqlPool()).request().query("SELECT email,reason FROM dbo.CommunicationSuppressions");
  return new Map(result.recordset.map((row) => [row.email as string, row.reason as SuppressionReason]));
}

export async function listSuppressions(identity: PulseIdentity): Promise<SuppressionRecord[]> {
  await requireInternalRole(identity);
  if (!isAzureSqlConfigured()) return structuredClone(memorySuppressions());
  const result = await (await getSqlPool()).request()
    .query("SELECT email,reason,source,note,CONVERT(nvarchar(33),created_at,127) createdAt FROM dbo.CommunicationSuppressions ORDER BY created_at DESC");
  return result.recordset as SuppressionRecord[];
}

export async function addSuppression(identity: PulseIdentity, input: { email: string; note?: string }) {
  const parsed = parseInput(communicationSuppressionInputSchema, input);
  await requireInternalRole(identity, ["System admin"]);
  await suppressAddress(parsed.email, "Manual", "Admin", parsed.note, identity.id);
  const record: SuppressionRecord = { email: parsed.email, reason: "Manual", source: "Admin", note: parsed.note, createdAt: new Date().toISOString() };
  if (!isAzureSqlConfigured()) memoryAuditEvent(identity, "communication.suppression.added", "CommunicationSuppression", undefined, { reason: "Manual" });
  else await (await getSqlPool()).request().input("auditId", sql.UniqueIdentifier, crypto.randomUUID()).input("actor", sql.UniqueIdentifier, identity.id)
    .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
    .query("INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,after_json,correlation_id) VALUES(@auditId,@actor,'communication.suppression.added','CommunicationSuppression',N'{\"reason\":\"Manual\"}',@correlation)");
  return record;
}

export async function removeSuppression(identity: PulseIdentity, email: string) {
  await requireInternalRole(identity, ["System admin"]);
  const normalized = email.trim().toLowerCase();
  if (!isAzureSqlConfigured()) {
    const store = memorySuppressions();
    const index = store.findIndex((s) => s.email === normalized);
    if (index < 0) throw new Error("NOT_FOUND");
    store.splice(index, 1);
    for (const contact of memoryContacts()) if (contact.email === normalized) contact.status = "Active";
    memoryAuditEvent(identity, "communication.suppression.removed", "CommunicationSuppression", undefined, {});
    return;
  }
  const pool = await getSqlPool();
  const result = await pool.request().input("email", sql.NVarChar(320), normalized)
    .query("DELETE dbo.CommunicationSuppressions OUTPUT DELETED.email WHERE email=@email; UPDATE dbo.CommunicationContacts SET status='Active',updated_at=SYSUTCDATETIME() WHERE email=@email AND deleted_at IS NULL;");
  if (!result.recordset.length) throw new Error("NOT_FOUND");
  await pool.request().input("auditId", sql.UniqueIdentifier, crypto.randomUUID()).input("actor", sql.UniqueIdentifier, identity.id)
    .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
    .query("INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,correlation_id) VALUES(@auditId,@actor,'communication.suppression.removed','CommunicationSuppression',@correlation)");
}
```

Audit rows deliberately carry no e-mail address (PII stays in the suppression table only).

- [ ] **Step 5: Run** — `npm test` → PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/contracts.ts lib/server/communications/suppression-repository.ts tests/communications.test.ts
git commit -m "feat(communications): global suppression list"
```

---

### Task 6: Contact and suppression API routes

**Files:**
- Create: `app/api/v1/internal/communications/contacts/route.ts` (GET, POST)
- Create: `app/api/v1/internal/communications/contacts/[contactId]/route.ts` (PATCH, DELETE)
- Create: `app/api/v1/internal/communications/suppressions/route.ts` (GET, POST, DELETE)
- Create: `app/api/v1/communications/contacts/route.ts` (GET, POST)
- Create: `app/api/v1/communications/contacts/[contactId]/route.ts` (PATCH, DELETE)
- Modify: `scripts/generate-openapi.ts:19-39` (`schemaNames`), `docs/openapi-base.json` (curated operationIds)
- Create: `tests/communications-routes.test.ts`
- Modify: `package.json` (`test` script)

**Interfaces:**
- Consumes: Task 4 and Task 5 functions; `getIdentity`, `readInput`, `json`, `apiError`, `correlationId`.
- Produces: HTTP surface used by Task 15/16/17 UI. Response shapes: list → `{ items }`, single → `{ item }`, import → `{ created, skipped }`, delete → `{ ok: true }`.

- [ ] **Step 1: Failing route tests** — `tests/communications-routes.test.ts`:

```ts
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetCommunicationMemory } from "../lib/server/communications/memory";
import { GET as internalContactsGet, POST as internalContactsPost } from "../app/api/v1/internal/communications/contacts/route";
import { GET as companyContactsGet } from "../app/api/v1/communications/contacts/route";

// Memory mode (no AZURE_SQL_*, NODE_ENV !== production): an anonymous request resolves to the
// demo fallback identity in lib/server/auth.ts — the seeded System admin (ORG-001, isInternal).
// Route tests therefore exercise the real admin code paths without a session cookie, while
// customer-role paths (Company admin) are covered at the repository level in communications.test.ts.
function req(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { host: "localhost", origin: "http://localhost", "sec-fetch-site": "same-origin", "content-type": "application/json", ...(init.headers || {}) },
  });
}

beforeEach(() => {
  delete process.env.AZURE_SQL_CONNECTION_STRING;
  delete process.env.AZURE_SQL_SERVER;
  globalThis.pulseMemoryUsers = undefined;
  globalThis.pulseMemoryOrganizations = undefined;
  globalThis.pulseMemoryAudit = undefined;
  globalThis.pulseMemoryIdempotency = undefined;
  resetCommunicationMemory();
});

test("routes: internal contacts list, create and validation (demo System admin identity)", async () => {
  const bad = await internalContactsPost(req("/api/v1/internal/communications/contacts", { method: "POST", body: JSON.stringify({ organizationId: "ORG-001", email: "not-an-email", displayName: "x", topics: [] }) }));
  assert.equal(bad.status, 400);
  const created = await internalContactsPost(req("/api/v1/internal/communications/contacts", { method: "POST", body: JSON.stringify({ organizationId: "ORG-001", email: "cio@origo.is", displayName: "CIO", locale: "is", topics: ["product-updates"] }) }));
  assert.equal(created.status, 201);
  assert.equal((await created.json()).item.email, "cio@origo.is");
  const list = await internalContactsGet(req("/api/v1/internal/communications/contacts?organizationId=ORG-001"));
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("cache-control"), "no-store");
  assert.equal((await list.json()).items.length, 1);
});

test("routes: company contacts need a Company admin membership (the demo admin is not one → 404)", async () => {
  const response = await companyContactsGet(req("/api/v1/communications/contacts"));
  assert.equal(response.status, 404);
});
```

Append `tests/communications-routes.test.ts` to the `test` script in `package.json`.

- [ ] **Step 2: Run** — `npm test` → FAIL (routes missing).

- [ ] **Step 3: Internal contacts route** — `app/api/v1/internal/communications/contacts/route.ts`:

```ts
import { communicationContactImportSchema, communicationContactInputSchema } from "@/lib/contracts";
import { getIdentity } from "@/lib/server/auth";
import { importContacts, listContacts, saveContact } from "@/lib/server/communications/contact-repository";
import { apiError, correlationId, json } from "@/lib/server/http";
import { readJson, parseInput } from "@/lib/server/validation";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const organizationId = new URL(request.url).searchParams.get("organizationId") || undefined;
    return json({ items: await listContacts(await getIdentity(request), organizationId) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
/** Body is either a single contact (communicationContactInputSchema) or an import ({ organizationId, lines, topics }). */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await getIdentity(request);
    const body = await readJson(request);
    if (typeof body.lines === "string") {
      const input = parseInput(communicationContactImportSchema, body);
      if (!input.organizationId) throw new Error("INVALID_INPUT");
      return json(await importContacts(identity, input.organizationId, input.lines, input.topics), { status: 201 }, id);
    }
    return json({ item: await saveContact(identity, parseInput(communicationContactInputSchema, body)) }, { status: 201 }, id);
  } catch (error) {
    return apiError(error, id);
  }
}
```

`[contactId]/route.ts`: `PATCH` reads the body, forces `id = contactId`, calls `saveContact`; `DELETE` calls `removeContact` and returns `{ ok: true }`.

- [ ] **Step 4: Suppressions route** — `GET` → `{ items: await listSuppressions(identity) }`; `POST` → `{ item: await addSuppression(identity, await readInput(request, communicationSuppressionInputSchema)) }` with status 201; `DELETE` → body `{ email }` parsed with `communicationSuppressionInputSchema.pick({ email: true })`, `removeSuppression`, `{ ok: true }`.

- [ ] **Step 5: Customer routes** — `app/api/v1/communications/contacts/route.ts` mirrors the internal one but calls `listCompanyContacts`, `saveCompanyContact` (body parsed with `companyContactInputSchema`) and `importCompanyContacts` (body `{ lines, topics }`); `[contactId]/route.ts` → `saveCompanyContact` with `id` forced / `removeCompanyContact`.

- [ ] **Step 6: OpenAPI** — in `scripts/generate-openapi.ts` add to `schemaNames`:

```ts
  "POST /api/v1/internal/communications/contacts": "communicationContactInputSchema",
  "PATCH /api/v1/internal/communications/contacts/{contactId}": "communicationContactInputSchema",
  "POST /api/v1/internal/communications/suppressions": "communicationSuppressionInputSchema",
  "DELETE /api/v1/internal/communications/suppressions": "communicationSuppressionInputSchema",
  "POST /api/v1/communications/contacts": "companyContactInputSchema",
  "PATCH /api/v1/communications/contacts/{contactId}": "companyContactInputSchema",
```

In `docs/openapi-base.json` add curated entries under `components` keyed by route, each `{ "<method>": { "operationId": "…", "responses": { "200": { "$ref": "#/components/responses/Ok" } } } }`: `listCommunicationContacts`/`saveCommunicationContact`, `updateCommunicationContact`/`removeCommunicationContact`, `listCommunicationSuppressions`/`addCommunicationSuppression`/`removeCommunicationSuppression`, `listCompanyContacts`/`saveCompanyContact`, `updateCompanyContact`/`removeCompanyContact`. Run `npm run openapi:generate` and commit `public/openapi.json`.

- [ ] **Step 7: Run** — `npm test` → PASS; `npm run openapi:check` → clean; `npm run lint` → clean.

- [ ] **Step 8: Commit**

```bash
git add app/api/v1/internal/communications/contacts app/api/v1/internal/communications/suppressions app/api/v1/communications scripts/generate-openapi.ts docs/openapi-base.json public/openapi.json tests/communications-routes.test.ts package.json
git commit -m "feat(communications): contact and suppression API routes"
```

---

### Task 7: Audience resolver

**Files:**
- Create: `lib/server/communications/audience.ts`
- Test: `tests/communications.test.ts` (extend)

**Interfaces:**
- Consumes: `AudienceSpec`, `CommunicationTopic`, `ContactRecord`, `DeliveryRecord`, `SuppressionReason` (Task 1); `MANDATORY_TOPICS`, `topicEventType` (Task 1); `loadSuppressionMap` (Task 5); `users()`, `organizations()` (admin-repository); `CommunicationSettings` (Task 1).
- Produces:

```ts
export type AudienceOrganization = { id: string; name: string; type: string; status: string; isTest: boolean; locale: "en" | "is" };
export type AudienceMember = { userId: string; organizationId: string; email: string; displayName: string; locale: "en" | "is"; role: string; preference: "Immediate" | "Daily" | "Weekly" | "Off" | null };
export type AudienceInput = {
  organizations: AudienceOrganization[];      // every non-Inactive organisation (all types)
  members: AudienceMember[];                  // Active users × Active memberships, with the topic preference joined
  contacts: ContactRecord[];                  // non-deleted contacts of every organisation
  suppressions: Map<string, SuppressionReason>;
};
export type AudienceRecipient = Pick<DeliveryRecord, "organizationId" | "email" | "displayName" | "locale" | "source" | "userId" | "contactId" | "state" | "suppressedReason">;
export type AudienceBreakdown = {
  organizations: number; members: number; contacts: number; internal: number;
  suppressed: Record<string, number>; total: number; sendable: number;
};
export function resolveAudience(spec: AudienceSpec, topic: CommunicationTopic, input: AudienceInput, settings: Pick<CommunicationSettings, "safeMode" | "maxRecipientsPerCampaign">): { recipients: AudienceRecipient[]; breakdown: AudienceBreakdown };
export async function loadAudienceInput(topic: CommunicationTopic): Promise<AudienceInput>;   // SQL or memory, no identity (callers authorise)
```

- [ ] **Step 1: Failing tests**

```ts
import { resolveAudience, type AudienceInput } from "../lib/server/communications/audience";
import { DEFAULT_COMMUNICATION_SETTINGS as DEFAULTS } from "../lib/server/communications/settings";

const orgs: AudienceInput["organizations"] = [
  { id: "ORG-001", name: "Origo", type: "Customer", status: "Active", isTest: false, locale: "is" },
  { id: "ORG-002", name: "Advania", type: "Customer", status: "Onboarding", isTest: false, locale: "en" },
  { id: "ORG-003", name: "Test Co", type: "Customer", status: "Active", isTest: true, locale: "en" },
  { id: "ORG-INTERNAL", name: "DataCentral", type: "Internal", status: "Active", isTest: false, locale: "en" },
];
const member = (userId: string, organizationId: string, email: string, extra: Partial<AudienceInput["members"][number]> = {}) => ({
  userId, organizationId, email, displayName: email.split("@")[0], locale: "en" as const, role: "Requester", preference: null, ...extra,
});
const contact = (id: string, organizationId: string, email: string, topics: string[] = ["product-updates"], extra: Partial<AudienceInput["contacts"][number]> = {}) => ({
  id, organizationId, userId: null, email, displayName: email, locale: "en" as const, topics: topics as never, status: "Active" as const,
  source: "Admin" as const, createdAt: "", updatedAt: "", ...extra,
});
const openSettings = { safeMode: { enabled: false, allowedDomains: [] }, maxRecipientsPerCampaign: 5000 };
const spec = { organizations: "all-customers" as const, includeOnboarding: false, includeTestOrganizations: false, includeMembers: true, memberRoles: null, includeContacts: true, includeInternalCopy: false };

test("audience: dedupes member and contact rows case-insensitively; member wins and keeps the user locale", () => {
  const input: AudienceInput = {
    organizations: orgs,
    members: [member("u1", "ORG-001", "Jon@Origo.is", { locale: "is" })],
    contacts: [contact("c1", "ORG-001", "jon@origo.is"), contact("c2", "ORG-001", "cio@origo.is")],
    suppressions: new Map(),
  };
  const { recipients, breakdown } = resolveAudience(spec, "product-updates", input, openSettings);
  assert.deepEqual(recipients.map((r) => [r.email, r.source, r.locale]), [["jon@origo.is", "Member", "is"], ["cio@origo.is", "Contact", "en"]]);
  assert.equal(breakdown.sendable, 2);
  assert.equal(breakdown.members, 1);
  assert.equal(breakdown.contacts, 1);
});

test("audience: organisation filters (selected ids, onboarding, test orgs) and role filter", () => {
  const input: AudienceInput = {
    organizations: orgs,
    members: [member("u1", "ORG-001", "a@origo.is", { role: "Company admin" }), member("u2", "ORG-001", "b@origo.is"), member("u3", "ORG-002", "c@advania.is"), member("u4", "ORG-003", "t@test.is")],
    contacts: [], suppressions: new Map(),
  };
  assert.equal(resolveAudience(spec, "product-updates", input, openSettings).breakdown.sendable, 2, "Onboarding and test orgs excluded by default");
  assert.equal(resolveAudience({ ...spec, includeOnboarding: true, includeTestOrganizations: true }, "product-updates", input, openSettings).breakdown.sendable, 4);
  assert.equal(resolveAudience({ ...spec, organizations: ["ORG-002"], includeOnboarding: true }, "product-updates", input, openSettings).breakdown.sendable, 1);
  assert.deepEqual(resolveAudience({ ...spec, memberRoles: ["Company admin"] }, "product-updates", input, openSettings).recipients.map((r) => r.email), ["a@origo.is"]);
});

test("audience: preference Off is honoured except for mandatory topics; contacts need the topic", () => {
  const input: AudienceInput = {
    organizations: orgs,
    members: [member("u1", "ORG-001", "off@origo.is", { preference: "Off" }), member("u2", "ORG-001", "on@origo.is", { preference: "Immediate" })],
    contacts: [contact("c1", "ORG-001", "news@origo.is", ["general"])],
    suppressions: new Map(),
  };
  const product = resolveAudience(spec, "product-updates", input, openSettings);
  assert.deepEqual(product.recipients.filter((r) => r.state === "Queued").map((r) => r.email), ["on@origo.is"]);
  assert.equal(product.breakdown.suppressed.PreferenceOff, 1);
  const security = resolveAudience(spec, "security-advisories", input, openSettings);
  assert.equal(security.recipients.filter((r) => r.state === "Queued").length, 2, "mandatory topic ignores Off");
});

test("audience: suppressed members are kept as Suppressed rows; safe mode matches the whole domain", () => {
  const input: AudienceInput = {
    organizations: orgs,
    members: [member("u1", "ORG-001", "bounced@origo.is"), member("u2", "ORG-001", "ok@datacentral.ai"), member("u3", "ORG-001", "x@evil-datacentral.ai"), member("u4", "ORG-001", "y@datacentral.ai.attacker.com")],
    contacts: [], suppressions: new Map([["bounced@origo.is", "Bounced"]]),
  };
  const result = resolveAudience(spec, "product-updates", input, { safeMode: { enabled: true, allowedDomains: ["datacentral.ai"] }, maxRecipientsPerCampaign: 5000 });
  const byEmail = Object.fromEntries(result.recipients.map((r) => [r.email, `${r.state}:${r.suppressedReason ?? ""}`]));
  assert.equal(byEmail["bounced@origo.is"], "Suppressed:Bounced");
  assert.equal(byEmail["ok@datacentral.ai"], "Queued:");
  assert.equal(byEmail["x@evil-datacentral.ai"], "Suppressed:SafeMode");
  assert.equal(byEmail["y@datacentral.ai.attacker.com"], "Suppressed:SafeMode");
  assert.equal(result.breakdown.sendable, 1);
});

test("audience: size limit and internal copy", () => {
  const members = Array.from({ length: 6 }, (_, i) => member(`u${i}`, "ORG-001", `u${i}@origo.is`));
  const input: AudienceInput = { organizations: orgs, members: [...members, member("staff", "ORG-INTERNAL", "staff@datacentral.ai")], contacts: [], suppressions: new Map() };
  assert.throws(() => resolveAudience(spec, "general", input, { ...openSettings, maxRecipientsPerCampaign: 5 }), /INVALID_AUDIENCE_TOO_LARGE/);
  const withInternal = resolveAudience({ ...spec, includeInternalCopy: true }, "general", input, openSettings);
  assert.equal(withInternal.breakdown.internal, 1);
  assert.equal(withInternal.breakdown.sendable, 7);
});
```

- [ ] **Step 2: Run** — `npm test` → FAIL.

- [ ] **Step 3: Implement** — `lib/server/communications/audience.ts`:

```ts
import type { AudienceSpec, CommunicationTopic, ContactRecord, DeliveryRecord, SuppressionReason } from "./types";
import type { CommunicationSettings } from "./settings";
import { MANDATORY_TOPICS, topicEventType } from "./topics";
import { loadSuppressionMap } from "./suppression-repository";
import { organizations, users } from "../admin-repository";
import { getSqlPool, isAzureSqlConfigured, sql } from "../database";

export type AudienceOrganization = { id: string; name: string; type: string; status: string; isTest: boolean; locale: "en" | "is" };
export type AudienceMember = { userId: string; organizationId: string; email: string; displayName: string; locale: "en" | "is"; role: string; preference: "Immediate" | "Daily" | "Weekly" | "Off" | null };
export type AudienceInput = { organizations: AudienceOrganization[]; members: AudienceMember[]; contacts: ContactRecord[]; suppressions: Map<string, SuppressionReason> };
export type AudienceRecipient = Pick<DeliveryRecord, "organizationId" | "email" | "displayName" | "locale" | "source" | "userId" | "contactId" | "state" | "suppressedReason">;
export type AudienceBreakdown = { organizations: number; members: number; contacts: number; internal: number; suppressed: Record<string, number>; total: number; sendable: number };

function domainAllowed(email: string, allowed: string[]) {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return allowed.some((d) => d.toLowerCase() === domain);
}

export function resolveAudience(spec: AudienceSpec, topic: CommunicationTopic, input: AudienceInput, settings: Pick<CommunicationSettings, "safeMode" | "maxRecipientsPerCampaign">) {
  const selected = new Map<string, AudienceOrganization>();
  for (const org of input.organizations) {
    if (org.type === "Internal" || org.status === "Inactive") continue;
    if (spec.organizations !== "all-customers" && !spec.organizations.includes(org.id)) continue;
    if (org.status === "Onboarding" && !spec.includeOnboarding) continue;
    if (org.isTest && !spec.includeTestOrganizations) continue;
    selected.set(org.id, org);
  }
  const internalIds = new Set(input.organizations.filter((o) => o.type === "Internal" && o.status !== "Inactive").map((o) => o.id));
  const mandatory = MANDATORY_TOPICS.has(topic);
  const byEmail = new Map<string, AudienceRecipient>();
  const breakdown: AudienceBreakdown = { organizations: selected.size, members: 0, contacts: 0, internal: 0, suppressed: {}, total: 0, sendable: 0 };
  const suppress = (recipient: AudienceRecipient, reason: NonNullable<AudienceRecipient["suppressedReason"]>) => {
    recipient.state = "Suppressed";
    recipient.suppressedReason = reason;
    breakdown.suppressed[reason] = (breakdown.suppressed[reason] || 0) + 1;
  };
  const add = (recipient: AudienceRecipient, preferenceOff: boolean) => {
    const key = recipient.email.toLowerCase();
    recipient.email = key;
    if (byEmail.has(key)) return false;
    if (preferenceOff && !mandatory) suppress(recipient, "PreferenceOff");
    byEmail.set(key, recipient);
    return true;
  };
  if (spec.includeMembers)
    for (const m of input.members) {
      if (!selected.has(m.organizationId)) continue;
      if (spec.memberRoles && !spec.memberRoles.includes(m.role as never)) continue;
      if (add({ organizationId: m.organizationId, email: m.email, displayName: m.displayName, locale: m.locale, source: "Member", userId: m.userId, contactId: null, state: "Queued", suppressedReason: null }, m.preference === "Off"))
        breakdown.members++;
    }
  if (spec.includeContacts)
    for (const c of input.contacts) {
      if (!selected.has(c.organizationId) || c.status !== "Active" || !c.topics.includes(topic)) continue;
      if (add({ organizationId: c.organizationId, email: c.email, displayName: c.displayName, locale: c.locale, source: "Contact", userId: c.userId, contactId: c.id, state: "Queued", suppressedReason: null }, false))
        breakdown.contacts++;
    }
  if (spec.includeInternalCopy)
    for (const m of input.members) {
      if (!internalIds.has(m.organizationId)) continue;
      if (add({ organizationId: m.organizationId, email: m.email, displayName: m.displayName, locale: m.locale, source: "Member", userId: m.userId, contactId: null, state: "Queued", suppressedReason: null }, false))
        breakdown.internal++;
    }
  for (const recipient of byEmail.values()) {
    if (recipient.state !== "Queued") continue;
    const reason = input.suppressions.get(recipient.email);
    if (reason) suppress(recipient, reason);
    else if (settings.safeMode.enabled && !domainAllowed(recipient.email, settings.safeMode.allowedDomains)) suppress(recipient, "SafeMode");
  }
  const recipients = [...byEmail.values()];
  breakdown.total = recipients.length;
  breakdown.sendable = recipients.filter((r) => r.state === "Queued").length;
  if (breakdown.sendable > settings.maxRecipientsPerCampaign) throw new Error("INVALID_AUDIENCE_TOO_LARGE");
  return { recipients, breakdown };
}

export async function loadAudienceInput(topic: CommunicationTopic): Promise<AudienceInput> {
  const suppressions = await loadSuppressionMap();
  const eventType = topicEventType(topic);
  if (!isAzureSqlConfigured()) {
    const prefs = globalThis.pulseMemoryNotificationPreferences;
    const members: AudienceMember[] = [];
    for (const user of users())
      if (user.status === "Active")
        for (const membership of user.memberships)
          members.push({
            userId: user.id, organizationId: membership.companyId, email: user.email, displayName: user.name,
            locale: globalThis.pulseMemoryLocales?.[user.id] === "is" ? "is" : "en", role: membership.role,
            preference: (prefs?.get(`${user.id}:${membership.companyId}:${eventType}`) as AudienceMember["preference"]) ?? null,
          });
    const { memoryContacts } = await import("./memory");
    return {
      organizations: organizations().map((o) => ({ id: o.id, name: o.name, type: o.type, status: o.status, isTest: false, locale: "en" })),
      members, contacts: structuredClone(memoryContacts()), suppressions,
    };
  }
  const pool = await getSqlPool();
  const [orgRows, memberRows, contactRows] = await Promise.all([
    pool.request().query("SELECT id,name,type,status,is_test isTest,locale FROM dbo.Organizations WHERE status<>'Inactive'"),
    pool.request().input("eventType", sql.NVarChar(100), eventType).query(
      `SELECT CAST(u.id AS nvarchar(36)) userId,m.organization_id organizationId,u.email,u.display_name displayName,u.locale,m.role,p.cadence preference
       FROM dbo.Memberships m JOIN dbo.Users u ON u.id=m.user_id AND u.status='Active'
       LEFT JOIN dbo.NotificationPreferences p ON p.user_id=m.user_id AND p.organization_id=m.organization_id AND p.event_type=@eventType
       WHERE m.status='Active'`),
    pool.request().query(
      `SELECT CAST(c.id AS nvarchar(36)) id,c.organization_id organizationId,CAST(c.user_id AS nvarchar(36)) userId,c.email,c.display_name displayName,c.locale,c.topics_json topicsJson,c.status,c.source
       FROM dbo.CommunicationContacts c WHERE c.deleted_at IS NULL`),
  ]);
  return {
    organizations: orgRows.recordset.map((o) => ({ id: o.id, name: o.name, type: o.type, status: o.status, isTest: Boolean(o.isTest), locale: o.locale === "is" ? "is" : "en" })),
    members: memberRows.recordset.map((m) => ({ ...m, locale: m.locale === "is" ? "is" : "en", preference: m.preference ?? null })),
    contacts: contactRows.recordset.map((c) => ({ ...c, userId: c.userId || null, locale: c.locale === "is" ? "is" : "en", topics: JSON.parse(c.topicsJson || "[]"), createdAt: "", updatedAt: "" })),
    suppressions,
  };
}
```

- [ ] **Step 4: Run** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/server/communications/audience.ts tests/communications.test.ts
git commit -m "feat(communications): audience resolver with suppression and safe mode"
```

---

### Task 8: Campaign repository — drafts, preview and release pre-fill

**Files:**
- Create: `lib/server/communications/campaign-repository.ts`
- Test: `tests/communications.test.ts` (extend)

**Interfaces:**
- Consumes: Tasks 1–3, 7; `listReleases(identity, true)` from `operations-repository`; `listInternalIdeas(identity)` from `product-repository`; `addVersions("Communications", …)`; `renderCommunication`, `getRuntimeCommunicationSettings`.
- Produces:
  - `CommunicationInput = z.infer<typeof communicationInputSchema>`.
  - `listCommunications(identity): Promise<CommunicationRecord[]>` — any internal role, newest first, excludes deleted.
  - `getCommunication(identity, id): Promise<CommunicationRecord & { stats: CommunicationStats }>` — any internal role (stats from Task 9's `communicationStats`; until Task 9 lands return zeros).
  - `createCommunication(identity, input: Partial<CommunicationInput> & { fromReleaseId?: string }): Promise<CommunicationRecord>` — publish role; when `fromReleaseId` is given the content is pre-filled from the release (§7.2) and a partial input is allowed.
  - `updateCommunication(identity, id, input: CommunicationInput): Promise<CommunicationRecord>` — Draft only (`INVALID_COMMUNICATION_NOT_EDITABLE`).
  - `duplicateCommunication(identity, id)`, `deleteCommunication(identity, id)` (Draft/Cancelled only).
  - `previewCommunication(identity, id, locale): Promise<RenderedEmail>` — any internal role.
  - `prefillFromRelease(identity, releaseId): Promise<Pick<CommunicationInput, "templateKey" | "topic" | "title" | "content">>` (pure helper exported for tests).
  - Internal helper `findCommunicationUuid(publicId)` (SQL) used by Task 9.

- [ ] **Step 1: Failing tests**

```ts
import {
  createCommunication, deleteCommunication, duplicateCommunication, getCommunication, listCommunications,
  prefillFromRelease, previewCommunication, updateCommunication,
} from "../lib/server/communications/campaign-repository";
import { createRelease, publishRelease } from "../lib/server/operations-repository";
import { createIdea } from "../lib/server/product-repository";

const draftInput = {
  templateKey: "product-update" as const, topic: "product-updates" as const, title: "3.0.0 announcement",
  content: productUpdate, audience: { organizations: "all-customers" as const, includeOnboarding: false, includeTestOrganizations: false, includeMembers: true, memberRoles: null, includeContacts: true, includeInternalCopy: false },
};

test("campaigns: create/list/get/update/duplicate/delete with publish-role gating and versions", async () => {
  await assert.rejects(createCommunication(CONTRIBUTOR, draftInput), /FORBIDDEN/);
  const created = await createCommunication(PM, draftInput);
  assert.match(created.id, /^COM-\d{3}$/);
  assert.equal(created.status, "Draft");
  assert.equal(created.version, "1");
  assert.equal((await listCommunications(CONTRIBUTOR)).length, 1);
  const updated = await updateCommunication(PM, created.id, { ...draftInput, title: "Renamed" });
  assert.equal(updated.title, "Renamed");
  const copy = await duplicateCommunication(PM, created.id);
  assert.notEqual(copy.id, created.id);
  assert.equal(copy.status, "Draft");
  assert.equal(copy.title, "Renamed (copy)");
  await deleteCommunication(PM, copy.id);
  await assert.rejects(getCommunication(PM, copy.id), /NOT_FOUND/);
  assert.equal(globalThis.pulseMemoryAudit?.some((a) => a.action === "communication.created"), true);
});

test("campaigns: preview renders the stored content for the requested locale", async () => {
  const created = await createCommunication(PM, draftInput);
  const preview = await previewCommunication(CONTRIBUTOR, created.id, "is");
  assert.equal(preview.subject, "DataCentral 3.0.0 (is)");
  assert.match(preview.html, /Vöruuppfærsla/);
});

test("campaigns: pre-fill from a published release", async () => {
  const idea = await createIdea(PM, { internalTitle: "Admin report", internalDescription: "Built-in admin report", area: "Administration" } as never);
  const release = await createRelease(PM, { title: "DataCentral 3.0.0", date: "2026-10-01", summary: "Better visibility.", availability: "General availability", documentationUrl: "https://docs.datacentral.ai/3-0", ideaIds: [idea.id] });
  await publishRelease(PM, release.id);
  const prefill = await prefillFromRelease(PM, release.id);
  assert.equal(prefill.templateKey, "product-update");
  assert.equal(prefill.content.subject.en, "DataCentral 3.0.0");
  const body = prefill.content.body.en as { title: string; intro: string; sections: Array<{ heading: string }>; cta?: { url: string } };
  assert.equal(body.title, "DataCentral 3.0.0");
  assert.equal(body.intro, "Better visibility.");
  assert.equal(body.sections[0].heading, "Admin report");
  assert.equal(body.cta?.url, "https://docs.datacentral.ai/3-0");
  const created = await createCommunication(PM, { fromReleaseId: release.id });
  assert.equal(created.releaseId, release.id);
});
```

(`createIdea` in memory mode accepts the fields shown; check `lib/server/product-repository.ts` `createIdeaCore` for required fields if the cast fails — `internalTitle`, `internalDescription` and `area` are enough.)

- [ ] **Step 2: Run** — `npm test` → FAIL.

- [ ] **Step 3: Implement** — `lib/server/communications/campaign-repository.ts` (memory path complete; SQL statements shown per operation — follow the same shape as `operations-repository.ts`):

```ts
import { communicationInputSchema } from "@/lib/contracts";
import type { PulseIdentity } from "@/lib/domain";
import type { z } from "zod";
import { requireInternalRole, requirePublishRole } from "../authorization";
import { atomicSql, getSqlPool, isAzureSqlConfigured, sql } from "../database";
import { listReleases } from "../operations-repository";
import { listInternalIdeas } from "../product-repository";
import { parseInput } from "../validation";
import { addVersions } from "../versions";
import { memoryAuditEvent, memoryCommunications, memoryDeliveries, nextMemoryPublicId } from "./memory";
import { getRuntimeCommunicationSettings } from "./settings";
import { renderCommunication, type RenderedEmail } from "./templates/index";
import type { CommunicationRecord, CommunicationStats, EmailLocale } from "./types";

export type CommunicationInput = z.infer<typeof communicationInputSchema>;

const EMPTY_STATS: CommunicationStats = { recipients: 0, queued: 0, accepted: 0, delivered: 0, bounced: 0, dropped: 0, deadLettered: 0, suppressed: 0, cancelled: 0, opened: 0, clicked: 0, byOrganization: [] };

const SELECT = `SELECT c.public_id id,c.template_key templateKey,c.topic,c.title,c.content_json contentJson,c.audience_json audienceJson,c.status,
  CONVERT(nvarchar(33),c.scheduled_at,127) scheduledAt,CONVERT(nvarchar(33),c.started_at,127) startedAt,CONVERT(nvarchar(33),c.completed_at,127) completedAt,
  CONVERT(nvarchar(33),c.cancelled_at,127) cancelledAt,c.recipient_count recipientCount,c.release_public_id releaseId,u.display_name createdBy,
  CONVERT(nvarchar(33),c.created_at,127) createdAt,CONVERT(nvarchar(33),c.updated_at,127) updatedAt
  FROM dbo.Communications c JOIN dbo.Users u ON u.id=c.created_by_user_id`;
function fromRow(row: Record<string, unknown>): CommunicationRecord {
  return {
    id: String(row.id), templateKey: row.templateKey as CommunicationRecord["templateKey"], topic: row.topic as CommunicationRecord["topic"], title: String(row.title),
    content: JSON.parse(String(row.contentJson)), audience: JSON.parse(String(row.audienceJson)), status: row.status as CommunicationRecord["status"],
    scheduledAt: (row.scheduledAt as string) || undefined, startedAt: (row.startedAt as string) || undefined, completedAt: (row.completedAt as string) || undefined,
    cancelledAt: (row.cancelledAt as string) || undefined, recipientCount: Number(row.recipientCount), releaseId: (row.releaseId as string) || undefined,
    createdBy: String(row.createdBy), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt),
  };
}

export async function findCommunicationUuid(publicId: string): Promise<string> {
  const result = await (await getSqlPool()).request().input("id", sql.NVarChar(32), publicId)
    .query("SELECT CAST(id AS nvarchar(36)) id FROM dbo.Communications WHERE public_id=@id AND deleted_at IS NULL");
  if (!result.recordset.length) throw new Error("NOT_FOUND");
  return result.recordset[0].id;
}

async function loadOne(publicId: string): Promise<CommunicationRecord> {
  if (!isAzureSqlConfigured()) {
    const item = memoryCommunications().find((c) => c.id === publicId);
    if (!item) throw new Error("NOT_FOUND");
    return structuredClone(item);
  }
  const result = await (await getSqlPool()).request().input("id", sql.NVarChar(32), publicId).query(`${SELECT} WHERE c.public_id=@id AND c.deleted_at IS NULL`);
  if (!result.recordset.length) throw new Error("NOT_FOUND");
  return fromRow(result.recordset[0]);
}

export async function prefillFromRelease(identity: PulseIdentity, releaseId: string) {
  const release = (await listReleases(identity, true)).find((r) => r.id === releaseId);
  if (!release) throw new Error("NOT_FOUND");
  const ideas = await listInternalIdeas(identity);
  const sections = release.ideaIds
    .map((ideaId) => ideas.find((i) => i.id === ideaId))
    .filter((i): i is NonNullable<typeof i> => Boolean(i))
    .map((idea) => ({ heading: idea.publishedTitle || idea.internalTitle, body: idea.releaseNotes || idea.publishedDescription || idea.internalDescription }));
  return {
    templateKey: "product-update" as const,
    topic: "product-updates" as const,
    title: release.title,
    content: {
      subject: { en: release.title },
      body: {
        en: {
          title: release.title,
          subtitle: release.availability,
          intro: release.summary,
          sections: sections.length ? sections : [{ heading: release.title, body: release.summary }],
          ...(release.documentationUrl ? { cta: { label: "Open the release notes", url: release.documentationUrl } } : {}),
        },
      },
    },
  };
}

export async function listCommunications(identity: PulseIdentity): Promise<CommunicationRecord[]> {
  await requireInternalRole(identity);
  if (!isAzureSqlConfigured()) return addVersions("Communications", structuredClone(memoryCommunications()).reverse());
  const result = await (await getSqlPool()).request().query(`${SELECT} WHERE c.deleted_at IS NULL ORDER BY c.created_at DESC`);
  return addVersions("Communications", result.recordset.map(fromRow));
}

export async function getCommunication(identity: PulseIdentity, id: string) {
  await requireInternalRole(identity);
  const [item] = await addVersions("Communications", [await loadOne(id)]);
  return { ...item, stats: EMPTY_STATS }; // Task 9 replaces EMPTY_STATS with `await communicationStats(id)`
}

export async function createCommunication(identity: PulseIdentity, input: Partial<CommunicationInput> & { fromReleaseId?: string }) {
  await requirePublishRole(identity);
  const base = input.fromReleaseId ? await prefillFromRelease(identity, input.fromReleaseId) : {};
  const parsed = parseInput(communicationInputSchema, {
    audience: { organizations: "all-customers" }, ...base, ...input,
    content: input.content ?? (base as { content?: unknown }).content,
  });
  const now = new Date().toISOString();
  if (!isAzureSqlConfigured()) {
    const record: CommunicationRecord = {
      id: nextMemoryPublicId(), templateKey: parsed.templateKey, topic: parsed.topic, title: parsed.title, content: parsed.content as CommunicationRecord["content"],
      audience: parsed.audience, status: "Draft", recipientCount: 0, releaseId: parsed.fromReleaseId, createdBy: identity.name, createdAt: now, updatedAt: now,
    };
    memoryCommunications().push(record);
    memoryAuditEvent(identity, "communication.created", "Communication", record.id, { templateKey: record.templateKey, topic: record.topic, releaseId: record.releaseId });
    return (await addVersions("Communications", [structuredClone(record)]))[0];
  }
  return atomicSql(async () => {
    const pool = await getSqlPool();
    const uuid = crypto.randomUUID();
    const created = await pool.request().input("id", sql.UniqueIdentifier, uuid).input("template", sql.NVarChar(40), parsed.templateKey)
      .input("topic", sql.NVarChar(40), parsed.topic).input("title", sql.NVarChar(200), parsed.title)
      .input("content", sql.NVarChar(sql.MAX), JSON.stringify(parsed.content)).input("audience", sql.NVarChar(sql.MAX), JSON.stringify(parsed.audience))
      .input("release", sql.NVarChar(32), parsed.fromReleaseId || null).input("actor", sql.UniqueIdentifier, identity.id)
      .query(`INSERT dbo.Communications(id,public_id,template_key,topic,title,content_json,audience_json,release_public_id,created_by_user_id,updated_by_user_id)
        OUTPUT INSERTED.public_id publicId VALUES(@id,CONCAT('COM-',FORMAT(NEXT VALUE FOR dbo.CommunicationNumber,'000')),@template,@topic,@title,@content,@audience,@release,@actor,@actor)`);
    const publicId = created.recordset[0].publicId as string;
    await pool.request().input("auditId", sql.UniqueIdentifier, crypto.randomUUID()).input("actor", sql.UniqueIdentifier, identity.id)
      .input("entity", sql.UniqueIdentifier, uuid).input("after", sql.NVarChar(sql.MAX), JSON.stringify({ publicId, templateKey: parsed.templateKey, topic: parsed.topic, releaseId: parsed.fromReleaseId }))
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .query("INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@auditId,@actor,'communication.created','Communication',@entity,@after,@correlation)");
    return (await addVersions("Communications", [await loadOne(publicId)]))[0];
  });
}

export async function updateCommunication(identity: PulseIdentity, id: string, input: CommunicationInput) {
  await requirePublishRole(identity);
  const parsed = parseInput(communicationInputSchema, input);
  const current = await loadOne(id);
  if (current.status !== "Draft") throw new Error("INVALID_COMMUNICATION_NOT_EDITABLE");
  if (!isAzureSqlConfigured()) {
    const item = memoryCommunications().find((c) => c.id === id)!;
    Object.assign(item, { templateKey: parsed.templateKey, topic: parsed.topic, title: parsed.title, content: parsed.content, audience: parsed.audience, updatedAt: new Date().toISOString() });
    memoryAuditEvent(identity, "communication.updated", "Communication", id, { title: item.title }, { title: current.title });
    return (await addVersions("Communications", [structuredClone(item)]))[0];
  }
  // SQL: UPDATE dbo.Communications SET template_key=@template,topic=@topic,title=@title,content_json=@content,audience_json=@audience,
  //      updated_by_user_id=@actor,updated_at=SYSUTCDATETIME() WHERE public_id=@id AND status='Draft' AND deleted_at IS NULL;
  //      then INSERT dbo.AuditEvents(… 'communication.updated' …) and return addVersions([loadOne(id)]).
  …
}

export async function duplicateCommunication(identity: PulseIdentity, id: string) {
  await requirePublishRole(identity);
  const source = await loadOne(id);
  const copy = await createCommunication(identity, { templateKey: source.templateKey, topic: source.topic, title: `${source.title} (copy)`, content: source.content as CommunicationInput["content"], audience: source.audience });
  if (!isAzureSqlConfigured()) memoryAuditEvent(identity, "communication.duplicated", "Communication", copy.id, { from: id });
  // SQL: INSERT dbo.AuditEvents(… 'communication.duplicated' …) with after_json {"from":id}
  return copy;
}

export async function deleteCommunication(identity: PulseIdentity, id: string) {
  await requirePublishRole(identity);
  const current = await loadOne(id);
  if (!["Draft", "Cancelled"].includes(current.status)) throw new Error("INVALID_COMMUNICATION_NOT_DELETABLE");
  if (!isAzureSqlConfigured()) {
    const store = memoryCommunications();
    store.splice(store.findIndex((c) => c.id === id), 1);
    const deliveries = memoryDeliveries();
    for (let i = deliveries.length - 1; i >= 0; i--) if (deliveries[i].communicationId === id) deliveries.splice(i, 1);
    memoryAuditEvent(identity, "communication.deleted", "Communication", id, {});
    return;
  }
  // SQL: UPDATE dbo.Communications SET deleted_at=SYSUTCDATETIME(),updated_by_user_id=@actor WHERE public_id=@id AND status IN ('Draft','Cancelled') AND deleted_at IS NULL;
  //      audit 'communication.deleted'.
  …
}

export async function previewCommunication(identity: PulseIdentity, id: string, locale: EmailLocale): Promise<RenderedEmail> {
  await requireInternalRole(identity);
  const item = await loadOne(id);
  const settings = await getRuntimeCommunicationSettings();
  return renderCommunication(item.templateKey, item.content, locale, {
    publicUrl: (process.env.PULSE_PUBLIC_URL || "http://localhost:3000").replace(/\/+$/, ""),
    boilerplate: settings.boilerplate[locale],
    unsubscribeTags: settings.unsubscribeGroupId !== null,
  });
}
```

Replace each `…` with the SQL branch described in the comment above it (parameterised `pool.request().input(...)` calls, `NOT_FOUND` when `rowsAffected[0] === 0`). Task 9 swaps `EMPTY_STATS` in `getCommunication` for `await communicationStats(id)` imported from `./delivery-store`.

- [ ] **Step 4: Run** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/server/communications/campaign-repository.ts tests/communications.test.ts
git commit -m "feat(communications): campaign drafts, preview and release pre-fill"
```

---

### Task 9: Delivery store, audience freeze, send / schedule / cancel / test, deliveries and stats

**Files:**
- Create: `lib/server/communications/delivery-store.ts`
- Modify: `lib/server/communications/campaign-repository.ts` (append send-side functions; make the `communicationStats` import static)
- Modify: `lib/contracts.ts` (append `communicationCancelInputSchema`)
- Test: `tests/communications.test.ts` (extend)

**Interfaces:**
- Consumes: Tasks 1, 7, 8; `resolveAudience`, `loadAudienceInput`; `getRuntimeCommunicationSettings`, `communicationProviderStatus`.
- Produces (delivery-store.ts):

```ts
export type ClaimedDelivery = { id: string; email: string; displayName: string | null; source: DeliverySource; attemptCount: number };
export type ClaimedBatch = {
  communicationId: string; templateKey: TemplateKey; topic: CommunicationTopic; content: CommunicationContent;
  locale: EmailLocale; deliveries: ClaimedDelivery[];
};
export type DeliveryStore = {
  promoteScheduled(now: Date): Promise<string[]>;          // Scheduled & due → freezeAudience → ids now Sending/Sent
  claimBatch(size: number): Promise<ClaimedBatch | null>;  // one campaign, one locale; Test rows claimable regardless of campaign status
  markAccepted(ids: string[], providerMessageId: string | null, now: Date): Promise<void>;
  markFailed(ids: string[], errorCode: string, nextAttemptAt: Date | null): Promise<void>; // null → Dead letter
  acceptedToday(now: Date): Promise<number>;
  completeCampaigns(now: Date): Promise<string[]>;         // Sending with no Queued/Retry/Processing non-test rows → Sent
};
export function getDeliveryStore(): DeliveryStore;
export async function freezeAudience(publicId: string, actorUserId: string | null, now?: Date): Promise<AudienceBreakdown>;
export async function communicationStats(publicId: string): Promise<CommunicationStats>;
export async function insertTestDeliveries(publicId: string, recipients: Array<{ email: string; displayName: string; locale: EmailLocale }>): Promise<number>;
export async function listDeliveryRows(publicId: string, filter: { state?: string; organizationId?: string; page: number; pageSize: number }): Promise<{ items: DeliveryRecord[]; total: number }>;
export async function requeueDeadLetters(publicId: string): Promise<number>;
export async function cancelOpenDeliveries(publicId: string, now: Date): Promise<number>;
export const BACKOFF_BASE_MS = 60_000;
export const MAX_ATTEMPTS = 5;
```

  and (campaign-repository.ts):

```ts
export async function audienceEstimate(identity, id): Promise<AudienceBreakdown & { recipients?: undefined }>;
export async function sendCommunication(identity, id, input: { scheduledAt?: string }): Promise<CommunicationRecord>;
export async function cancelCommunication(identity, id, mode: "cancel" | "unschedule"): Promise<CommunicationRecord>;
export async function testSendCommunication(identity, id, extraRecipients: string[]): Promise<{ queued: number }>;
export async function listDeliveries(identity, id, filter): Promise<{ items: DeliveryRecord[]; total: number }>;
export async function retryDeadLetters(identity, id): Promise<{ requeued: number }>;
```

- [ ] **Step 1: Contract** — `export const communicationCancelInputSchema = z.object({ mode: z.enum(["cancel", "unschedule"]).default("cancel") }).strict();`

- [ ] **Step 2: Failing tests**

```ts
import { audienceEstimate, cancelCommunication, listDeliveries, retryDeadLetters, sendCommunication, testSendCommunication } from "../lib/server/communications/campaign-repository";
import { communicationStats, freezeAudience, getDeliveryStore } from "../lib/server/communications/delivery-store";

async function enableSending() {
  process.env.SENDGRID_API_KEY = "SG.test";
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai", safeMode: { enabled: false, allowedDomains: [] } });
}
async function seedAudience() {
  await seedOrganizations();
  globalThis.pulseMemoryUsers!.push(
    { id: "22222222-2222-4222-8222-222222222222", name: "Jón", email: "jon@origo.is", status: "Active", authentication: "OTP", memberships: [{ companyId: "ORG-001", role: "Requester" }] },
    { id: "66666666-6666-4666-8666-666666666666", name: "Anna", email: "anna@advania.is", status: "Active", authentication: "OTP", memberships: [{ companyId: "ORG-002", role: "Company admin" }] },
  );
  await saveContact(PM, { organizationId: "ORG-001", email: "cio@origo.is", displayName: "CIO", locale: "is", topics: ["product-updates"] });
}

test("send: requires enabled settings and a provider, freezes the audience and moves to Sending", async () => {
  await seedAudience();
  const created = await createCommunication(PM, draftInput);
  await assert.rejects(sendCommunication(PM, created.id, {}), /INVALID_COMMUNICATIONS_DISABLED/);
  await enableSending();
  const estimate = await audienceEstimate(PM, created.id);
  assert.equal(estimate.sendable, 4); // bjarki + jon (ORG-001 members), cio (contact, is), anna (ORG-002 member)
  const sent = await sendCommunication(PM, created.id, {});
  assert.equal(sent.status, "Sending");
  assert.equal(sent.recipientCount, 4);
  const deliveries = await listDeliveries(CONTRIBUTOR, created.id, { page: 1, pageSize: 50 });
  assert.equal(deliveries.total, 4);
  assert.ok(deliveries.items.every((d) => d.state === "Queued"));
  assert.equal(deliveries.items.find((d) => d.email === "cio@origo.is")?.locale, "is");
  await assert.rejects(updateCommunication(PM, created.id, draftInput), /INVALID_COMMUNICATION_NOT_EDITABLE/);
  await assert.rejects(sendCommunication(PM, created.id, {}), /INVALID_COMMUNICATION_STATE/);
  assert.equal(globalThis.pulseMemoryAudit?.[0]?.action, "communication.sent");
});

test("send: schedule, unschedule and cancel; cancel keeps accepted rows", async () => {
  await seedAudience();
  await enableSending();
  const created = await createCommunication(PM, draftInput);
  await assert.rejects(sendCommunication(PM, created.id, { scheduledAt: new Date(Date.now() - 1000).toISOString() }), /INVALID_SCHEDULE_TIME/);
  const scheduled = await sendCommunication(PM, created.id, { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(scheduled.status, "Scheduled");
  assert.equal((await listDeliveries(PM, created.id, { page: 1, pageSize: 10 })).total, 0, "audience freezes at promotion, not at scheduling");
  const back = await cancelCommunication(PM, created.id, "unschedule");
  assert.equal(back.status, "Draft");
  const sending = await sendCommunication(PM, created.id, {});
  const store = getDeliveryStore();
  const batch = await store.claimBatch(1);
  await store.markAccepted([batch!.deliveries[0].id], "msg-1", new Date());
  const cancelled = await cancelCommunication(PM, created.id, "cancel");
  assert.equal(cancelled.status, "Cancelled");
  const rows = (await listDeliveries(PM, sending.id, { page: 1, pageSize: 10 })).items;
  assert.equal(rows.filter((r) => r.state === "Accepted").length, 1);
  assert.equal(rows.filter((r) => r.state === "Cancelled").length, 3);
});

test("send: an all-suppressed audience completes immediately as Sent with zero recipients", async () => {
  await seedAudience();
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai" }); // safe mode on, datacentral.ai only
  process.env.SENDGRID_API_KEY = "SG.test";
  const created = await createCommunication(PM, draftInput);
  const sent = await sendCommunication(PM, created.id, {});
  assert.equal(sent.status, "Sent");
  assert.equal(sent.recipientCount, 0);
  const stats = await communicationStats(created.id);
  assert.equal(stats.suppressed, 4);
});

test("test send: queues Test rows for the caller and internal extras only; never counts in stats", async () => {
  await seedAudience();
  await enableSending();
  const created = await createCommunication(PM, draftInput);
  const result = await testSendCommunication(PM, created.id, ["staff@datacentral.ai", "jon@origo.is"]);
  assert.equal(result.queued, 1, "jon@origo.is is not internal staff; only the caller is queued");
  const batch = await getDeliveryStore().claimBatch(10);
  assert.equal(batch?.deliveries[0].source, "Test");
  assert.equal((await communicationStats(created.id)).recipients, 0);
});

test("deliveries: retry dead letters requeues only Dead letter rows", async () => {
  await seedAudience();
  await enableSending();
  const created = await createCommunication(PM, draftInput);
  await sendCommunication(PM, created.id, {});
  const store = getDeliveryStore();
  const batch = await store.claimBatch(10);
  await store.markFailed(batch!.deliveries.map((d) => d.id), "HTTP_400", null);
  assert.equal((await communicationStats(created.id)).deadLettered, 3);
  assert.deepEqual(await retryDeadLetters(PM, created.id), { requeued: 3 });
  assert.equal((await communicationStats(created.id)).queued, 4, "3 requeued English rows plus the never-claimed Icelandic row");
});
```

- [ ] **Step 3: Run** — `npm test` → FAIL.

- [ ] **Step 4: Delivery store** — `lib/server/communications/delivery-store.ts` (memory implementation complete; SQL statements per method):

```ts
import { atomicSql, getSqlPool, isAzureSqlConfigured, sql } from "../database";
import { loadAudienceInput, resolveAudience, type AudienceBreakdown } from "./audience";
import { memoryCommunications, memoryDeliveries } from "./memory";
import { getRuntimeCommunicationSettings } from "./settings";
import type { CommunicationContent, CommunicationStats, CommunicationTopic, DeliveryRecord, DeliverySource, EmailLocale, TemplateKey } from "./types";

export const BACKOFF_BASE_MS = 60_000;
export const MAX_ATTEMPTS = 5;
export type ClaimedDelivery = { id: string; email: string; displayName: string | null; source: DeliverySource; attemptCount: number };
export type ClaimedBatch = { communicationId: string; templateKey: TemplateKey; topic: CommunicationTopic; content: CommunicationContent; locale: EmailLocale; deliveries: ClaimedDelivery[] };
export type DeliveryStore = {
  promoteScheduled(now: Date): Promise<string[]>;
  claimBatch(size: number): Promise<ClaimedBatch | null>;
  markAccepted(ids: string[], providerMessageId: string | null, now: Date): Promise<void>;
  markFailed(ids: string[], errorCode: string, nextAttemptAt: Date | null): Promise<void>;
  acceptedToday(now: Date): Promise<number>;
  completeCampaigns(now: Date): Promise<string[]>;
};
const OPEN = new Set(["Queued", "Retry", "Processing"]);

export async function freezeAudience(publicId: string, actorUserId: string | null, now = new Date()): Promise<AudienceBreakdown> {
  const settings = await getRuntimeCommunicationSettings();
  if (!isAzureSqlConfigured()) {
    const item = memoryCommunications().find((c) => c.id === publicId);
    if (!item) throw new Error("NOT_FOUND");
    if (!["Draft", "Scheduled"].includes(item.status)) throw new Error("INVALID_COMMUNICATION_STATE");
    const { recipients, breakdown } = resolveAudience(item.audience, item.topic, await loadAudienceInput(item.topic), settings);
    const store = memoryDeliveries();
    for (const r of recipients)
      store.push({ id: crypto.randomUUID(), communicationId: publicId, ...r, attemptCount: 0, createdAt: now.toISOString() });
    item.recipientCount = breakdown.sendable;
    item.startedAt = now.toISOString();
    item.status = breakdown.sendable === 0 ? "Sent" : "Sending";
    if (breakdown.sendable === 0) item.completedAt = now.toISOString();
    item.updatedAt = now.toISOString();
    return breakdown;
  }
  return atomicSql(async () => {
    const pool = await getSqlPool();
    const locked = await pool.request().input("id", sql.NVarChar(32), publicId)
      .query("SELECT CAST(id AS nvarchar(36)) id,topic,audience_json audience,status FROM dbo.Communications WITH (UPDLOCK,HOLDLOCK) WHERE public_id=@id AND deleted_at IS NULL");
    const row = locked.recordset[0];
    if (!row) throw new Error("NOT_FOUND");
    if (!["Draft", "Scheduled"].includes(row.status)) throw new Error("INVALID_COMMUNICATION_STATE");
    const { recipients, breakdown } = resolveAudience(JSON.parse(row.audience), row.topic, await loadAudienceInput(row.topic), settings);
    for (let i = 0; i < recipients.length; i += 500)
      await pool.request().input("communicationId", sql.UniqueIdentifier, row.id).input("rows", sql.NVarChar(sql.MAX), JSON.stringify(recipients.slice(i, i + 500)))
        .query(`INSERT dbo.CommunicationDeliveries(id,communication_id,organization_id,email,display_name,locale,source,user_id,contact_id,state,suppressed_reason)
          SELECT NEWID(),@communicationId,organizationId,email,displayName,locale,source,TRY_CONVERT(uniqueidentifier,userId),TRY_CONVERT(uniqueidentifier,contactId),state,suppressedReason
          FROM OPENJSON(@rows) WITH (organizationId nvarchar(32),email nvarchar(320),displayName nvarchar(200),locale nvarchar(12),source nvarchar(16),userId nvarchar(36),contactId nvarchar(36),state nvarchar(32),suppressedReason nvarchar(40))`);
    await pool.request().input("id", sql.UniqueIdentifier, row.id).input("sendable", sql.Int, breakdown.sendable).input("actor", sql.UniqueIdentifier, actorUserId)
      .query(`UPDATE dbo.Communications SET status=CASE WHEN @sendable=0 THEN 'Sent' ELSE 'Sending' END,started_at=SYSUTCDATETIME(),
        completed_at=CASE WHEN @sendable=0 THEN SYSUTCDATETIME() ELSE NULL END,recipient_count=@sendable,sent_by_user_id=COALESCE(@actor,sent_by_user_id),scheduled_at=NULL,updated_at=SYSUTCDATETIME() WHERE id=@id`);
    return breakdown;
  });
}

const memoryStore: DeliveryStore = {
  async promoteScheduled(now) {
    const due = memoryCommunications().filter((c) => c.status === "Scheduled" && c.scheduledAt && new Date(c.scheduledAt) <= now);
    for (const item of due) await freezeAudience(item.id, null, now);
    return due.map((c) => c.id);
  },
  async claimBatch(size) {
    const now = Date.now();
    const campaigns = new Map(memoryCommunications().map((c) => [c.id, c]));
    const candidates = memoryDeliveries().filter((d) => {
      const campaign = campaigns.get(d.communicationId);
      return campaign && ["Queued", "Retry"].includes(d.state) && (!d.nextAttemptAt || new Date(d.nextAttemptAt).getTime() <= now) && (campaign.status === "Sending" || d.source === "Test");
    });
    const first = candidates[0];
    if (!first) return null;
    const campaign = campaigns.get(first.communicationId)!;
    const batch = candidates.filter((d) => d.communicationId === first.communicationId && d.locale === first.locale).slice(0, size);
    for (const d of batch) { d.state = "Processing"; d.attemptCount += 1; }
    return {
      communicationId: campaign.id, templateKey: campaign.templateKey, topic: campaign.topic, content: campaign.content, locale: first.locale,
      deliveries: batch.map((d) => ({ id: d.id, email: d.email, displayName: d.displayName, source: d.source, attemptCount: d.attemptCount })),
    };
  },
  async markAccepted(ids, providerMessageId, now) {
    for (const d of memoryDeliveries()) if (ids.includes(d.id)) Object.assign(d, { state: "Accepted", providerMessageId, acceptedAt: now.toISOString(), nextAttemptAt: null, lastErrorCode: null });
  },
  async markFailed(ids, errorCode, nextAttemptAt) {
    for (const d of memoryDeliveries()) if (ids.includes(d.id)) Object.assign(d, { state: nextAttemptAt ? "Retry" : "Dead letter", nextAttemptAt: nextAttemptAt?.toISOString() ?? null, lastErrorCode: errorCode });
  },
  async acceptedToday(now) {
    const day = now.toISOString().slice(0, 10);
    return memoryDeliveries().filter((d) => d.acceptedAt?.slice(0, 10) === day).length;
  },
  async completeCampaigns(now) {
    const completed: string[] = [];
    for (const c of memoryCommunications()) {
      if (c.status !== "Sending") continue;
      if (memoryDeliveries().some((d) => d.communicationId === c.id && d.source !== "Test" && OPEN.has(d.state))) continue;
      c.status = "Sent"; c.completedAt = now.toISOString(); c.updatedAt = now.toISOString();
      completed.push(c.id);
    }
    return completed;
  },
};

const sqlStore: DeliveryStore = {
  async promoteScheduled(now) {
    const due = await (await getSqlPool()).request().input("now", sql.DateTime2, now)
      .query("SELECT public_id id FROM dbo.Communications WHERE status='Scheduled' AND scheduled_at<=@now AND deleted_at IS NULL");
    const ids: string[] = [];
    for (const row of due.recordset) { await freezeAudience(row.id, null, now); ids.push(row.id); }
    return ids;
  },
  async claimBatch(size) {
    const result = await (await getSqlPool()).request().input("size", sql.Int, size).query(`
      ;WITH next_campaign AS (
        SELECT TOP (1) d.communication_id,d.locale FROM dbo.CommunicationDeliveries d WITH (UPDLOCK,READPAST,ROWLOCK)
        JOIN dbo.Communications c ON c.id=d.communication_id
        WHERE d.state IN ('Queued','Retry') AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=SYSUTCDATETIME()) AND (c.status='Sending' OR d.source='Test')
        ORDER BY d.created_at
      ), next_items AS (
        SELECT TOP (@size) d.id FROM dbo.CommunicationDeliveries d JOIN next_campaign n ON n.communication_id=d.communication_id AND n.locale=d.locale
        WHERE d.state IN ('Queued','Retry') AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=SYSUTCDATETIME()) ORDER BY d.created_at
      )
      UPDATE d SET state='Processing',attempt_count=attempt_count+1
      OUTPUT CAST(INSERTED.id AS nvarchar(36)) id,INSERTED.email,INSERTED.display_name displayName,INSERTED.source,INSERTED.attempt_count attemptCount,INSERTED.locale,
        c.public_id communicationId,c.template_key templateKey,c.topic,c.content_json contentJson
      FROM dbo.CommunicationDeliveries d JOIN next_items q ON q.id=d.id JOIN dbo.Communications c ON c.id=d.communication_id;`);
    if (!result.recordset.length) return null;
    const first = result.recordset[0];
    return {
      communicationId: first.communicationId, templateKey: first.templateKey, topic: first.topic, content: JSON.parse(first.contentJson), locale: first.locale === "is" ? "is" : "en",
      deliveries: result.recordset.map((r) => ({ id: r.id, email: r.email, displayName: r.displayName, source: r.source, attemptCount: Number(r.attemptCount) })),
    };
  },
  async markAccepted(ids, providerMessageId, now) {
    await (await getSqlPool()).request().input("ids", sql.NVarChar(sql.MAX), JSON.stringify(ids)).input("message", sql.NVarChar(200), providerMessageId).input("now", sql.DateTime2, now)
      .query("UPDATE dbo.CommunicationDeliveries SET state='Accepted',provider_message_id=@message,accepted_at=@now,next_attempt_at=NULL,last_error_code=NULL WHERE id IN (SELECT TRY_CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@ids))");
  },
  async markFailed(ids, errorCode, nextAttemptAt) {
    await (await getSqlPool()).request().input("ids", sql.NVarChar(sql.MAX), JSON.stringify(ids)).input("state", sql.NVarChar(32), nextAttemptAt ? "Retry" : "Dead letter")
      .input("next", sql.DateTime2, nextAttemptAt).input("error", sql.NVarChar(100), errorCode.slice(0, 100))
      .query("UPDATE dbo.CommunicationDeliveries SET state=@state,next_attempt_at=@next,last_error_code=@error WHERE id IN (SELECT TRY_CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@ids))");
  },
  async acceptedToday(now) {
    const result = await (await getSqlPool()).request().input("day", sql.Date, now).query("SELECT COUNT(*) count FROM dbo.CommunicationDeliveries WHERE accepted_at>=@day AND accepted_at<DATEADD(day,1,@day)");
    return Number(result.recordset[0].count);
  },
  async completeCampaigns(now) {
    const result = await (await getSqlPool()).request().input("now", sql.DateTime2, now).query(`
      UPDATE c SET status='Sent',completed_at=@now,updated_at=@now OUTPUT INSERTED.public_id id FROM dbo.Communications c
      WHERE c.status='Sending' AND NOT EXISTS (SELECT 1 FROM dbo.CommunicationDeliveries d WHERE d.communication_id=c.id AND d.source<>'Test' AND d.state IN ('Queued','Retry','Processing'))`);
    return result.recordset.map((r) => r.id as string);
  },
};

export function getDeliveryStore(): DeliveryStore {
  return isAzureSqlConfigured() ? sqlStore : memoryStore;
}

export async function communicationStats(publicId: string): Promise<CommunicationStats> {
  const empty: CommunicationStats = { recipients: 0, queued: 0, accepted: 0, delivered: 0, bounced: 0, dropped: 0, deadLettered: 0, suppressed: 0, cancelled: 0, opened: 0, clicked: 0, byOrganization: [] };
  const rows: Array<Pick<DeliveryRecord, "organizationId" | "state" | "openedAt" | "clickedAt">> = isAzureSqlConfigured()
    ? (await (await getSqlPool()).request().input("id", sql.NVarChar(32), publicId).query(
        "SELECT d.organization_id organizationId,d.state,d.opened_at openedAt,d.clicked_at clickedAt FROM dbo.CommunicationDeliveries d JOIN dbo.Communications c ON c.id=d.communication_id WHERE c.public_id=@id AND d.source<>'Test'")).recordset
    : memoryDeliveries().filter((d) => d.communicationId === publicId && d.source !== "Test");
  const stats = { ...empty };
  const byOrg = new Map<string, { organizationId: string; recipients: number; delivered: number; opened: number }>();
  for (const row of rows) {
    if (row.state !== "Suppressed") stats.recipients++;
    if (["Queued", "Retry", "Processing"].includes(row.state)) stats.queued++;
    if (["Accepted", "Deferred"].includes(row.state)) stats.accepted++;
    if (row.state === "Delivered") { stats.accepted++; stats.delivered++; }
    if (row.state === "Bounced") stats.bounced++;
    if (row.state === "Dropped") stats.dropped++;
    if (row.state === "Dead letter") stats.deadLettered++;
    if (row.state === "Suppressed") stats.suppressed++;
    if (row.state === "Cancelled") stats.cancelled++;
    if (row.openedAt) stats.opened++;
    if (row.clickedAt) stats.clicked++;
    const org = byOrg.get(row.organizationId || "-") || { organizationId: row.organizationId || "-", recipients: 0, delivered: 0, opened: 0 };
    if (row.state !== "Suppressed") org.recipients++;
    if (row.state === "Delivered") org.delivered++;
    if (row.openedAt) org.opened++;
    byOrg.set(org.organizationId, org);
  }
  stats.byOrganization = [...byOrg.values()];
  return stats;
}

export async function insertTestDeliveries(publicId: string, recipients: Array<{ email: string; displayName: string; locale: EmailLocale }>) {
  const now = new Date().toISOString();
  if (!isAzureSqlConfigured()) {
    const store = memoryDeliveries();
    for (const r of recipients) {
      const existing = store.find((d) => d.communicationId === publicId && d.email === r.email && d.source === "Test");
      if (existing) Object.assign(existing, { state: "Queued", attemptCount: 0, nextAttemptAt: null, lastErrorCode: null });
      else store.push({ id: crypto.randomUUID(), communicationId: publicId, organizationId: null, email: r.email, displayName: r.displayName, locale: r.locale, source: "Test", userId: null, contactId: null, state: "Queued", suppressedReason: null, attemptCount: 0, createdAt: now });
    }
    return recipients.length;
  }
  // SQL: MERGE dbo.CommunicationDeliveries ON (communication_id,email,source='Test') — matched → reset to Queued/attempt 0; not matched → INSERT with organization_id NULL.
  …
}

export async function listDeliveryRows(publicId: string, filter: { state?: string; organizationId?: string; page: number; pageSize: number }) {
  if (!isAzureSqlConfigured()) {
    const all = memoryDeliveries().filter((d) => d.communicationId === publicId && (!filter.state || d.state === filter.state) && (!filter.organizationId || d.organizationId === filter.organizationId));
    const start = (filter.page - 1) * filter.pageSize;
    return { items: structuredClone(all.slice(start, start + filter.pageSize)), total: all.length };
  }
  // SQL: SELECT … FROM dbo.CommunicationDeliveries d JOIN dbo.Communications c ON c.id=d.communication_id WHERE c.public_id=@id AND (@state IS NULL OR d.state=@state)
  //      AND (@org IS NULL OR d.organization_id=@org) ORDER BY d.created_at OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY; plus SELECT COUNT(*) with the same WHERE.
  …
}

export async function requeueDeadLetters(publicId: string) {
  if (!isAzureSqlConfigured()) {
    let count = 0;
    for (const d of memoryDeliveries()) if (d.communicationId === publicId && d.state === "Dead letter") { Object.assign(d, { state: "Queued", attemptCount: 0, nextAttemptAt: null, lastErrorCode: null }); count++; }
    return count;
  }
  // SQL: UPDATE d SET state='Queued',attempt_count=0,next_attempt_at=NULL,last_error_code=NULL FROM dbo.CommunicationDeliveries d JOIN dbo.Communications c ON c.id=d.communication_id WHERE c.public_id=@id AND d.state='Dead letter'; return rowsAffected[0].
  …
}

export async function cancelOpenDeliveries(publicId: string, now: Date) {
  if (!isAzureSqlConfigured()) {
    let count = 0;
    for (const d of memoryDeliveries()) if (d.communicationId === publicId && ["Queued", "Retry"].includes(d.state)) { d.state = "Cancelled"; count++; }
    return count;
  }
  // SQL: UPDATE d SET state='Cancelled' FROM dbo.CommunicationDeliveries d JOIN dbo.Communications c ON c.id=d.communication_id WHERE c.public_id=@id AND d.state IN ('Queued','Retry'); return rowsAffected[0].
  …
}
```

- [ ] **Step 5: Campaign send-side functions** — append to `campaign-repository.ts` (and change `getCommunication` to import `communicationStats` statically):

```ts
import { cancelOpenDeliveries, communicationStats, freezeAudience, insertTestDeliveries, listDeliveryRows, requeueDeadLetters } from "./delivery-store";
import { communicationProviderStatus } from "./settings";
import { users } from "../admin-repository";

async function assertSendable() {
  const settings = await getRuntimeCommunicationSettings();
  if (!settings.enabled) throw new Error("INVALID_COMMUNICATIONS_DISABLED");
  if (!communicationProviderStatus(settings).providerConfigured) throw new Error("INVALID_EMAIL_PROVIDER_CONFIGURATION");
  return settings;
}

export async function audienceEstimate(identity: PulseIdentity, id: string) {
  await requireInternalRole(identity);
  const item = await loadOne(id);
  const settings = await getRuntimeCommunicationSettings();
  return resolveAudience(item.audience, item.topic, await loadAudienceInput(item.topic), settings).breakdown;
}

export async function sendCommunication(identity: PulseIdentity, id: string, input: { scheduledAt?: string }) {
  await requirePublishRole(identity);
  await assertSendable();
  const current = await loadOne(id);
  if (!["Draft", "Scheduled"].includes(current.status)) throw new Error("INVALID_COMMUNICATION_STATE");
  const now = new Date();
  if (input.scheduledAt) {
    const when = new Date(input.scheduledAt);
    if (Number.isNaN(when.getTime()) || when.getTime() < now.getTime() + 60_000 || when.getTime() > now.getTime() + 30 * 86_400_000) throw new Error("INVALID_SCHEDULE_TIME");
    if (!isAzureSqlConfigured()) {
      const item = memoryCommunications().find((c) => c.id === id)!;
      Object.assign(item, { status: "Scheduled", scheduledAt: when.toISOString(), updatedAt: now.toISOString() });
      memoryAuditEvent(identity, "communication.scheduled", "Communication", id, { scheduledAt: when.toISOString() });
      return (await addVersions("Communications", [structuredClone(item)]))[0];
    }
    // SQL: UPDATE dbo.Communications SET status='Scheduled',scheduled_at=@when,sent_by_user_id=@actor,updated_by_user_id=@actor,updated_at=SYSUTCDATETIME()
    //      WHERE public_id=@id AND status IN ('Draft','Scheduled') AND deleted_at IS NULL; audit 'communication.scheduled'; return addVersions([loadOne(id)]).
    …
  }
  const breakdown = await freezeAudience(id, identity.id, now);
  if (!isAzureSqlConfigured()) memoryAuditEvent(identity, "communication.sent", "Communication", id, { recipients: breakdown.sendable, suppressed: breakdown.suppressed });
  // SQL: INSERT dbo.AuditEvents(… 'communication.sent' …) after_json = { recipients, suppressed }
  return (await addVersions("Communications", [await loadOne(id)]))[0];
}

export async function cancelCommunication(identity: PulseIdentity, id: string, mode: "cancel" | "unschedule") {
  await requirePublishRole(identity);
  const current = await loadOne(id);
  const now = new Date();
  if (mode === "unschedule") {
    if (current.status !== "Scheduled") throw new Error("INVALID_COMMUNICATION_STATE");
    // memory: status Draft, scheduledAt undefined; SQL: UPDATE … SET status='Draft',scheduled_at=NULL …; audit 'communication.unscheduled'
    …
  } else {
    if (!["Scheduled", "Sending"].includes(current.status)) throw new Error("INVALID_COMMUNICATION_STATE");
    const cancelled = await cancelOpenDeliveries(id, now);
    // memory: status Cancelled, cancelledAt now; SQL: UPDATE … SET status='Cancelled',cancelled_at=@now …; audit 'communication.cancelled' { cancelledDeliveries: cancelled }
    …
  }
  return (await addVersions("Communications", [await loadOne(id)]))[0];
}

async function internalStaffEmails(): Promise<Set<string>> {
  if (!isAzureSqlConfigured()) {
    const internalIds = new Set(organizations().filter((o) => o.type === "Internal").map((o) => o.id));
    return new Set(users().filter((u) => u.status === "Active" && u.memberships.some((m) => internalIds.has(m.companyId) || ["System admin", "Product manager", "Internal contributor"].includes(m.role))).map((u) => u.email.toLowerCase()));
  }
  const result = await (await getSqlPool()).request().query("SELECT DISTINCT u.email FROM dbo.Users u JOIN dbo.Memberships m ON m.user_id=u.id AND m.status='Active' JOIN dbo.Organizations o ON o.id=m.organization_id AND o.type='Internal' WHERE u.status='Active'");
  return new Set(result.recordset.map((r) => String(r.email).toLowerCase()));
}

export async function testSendCommunication(identity: PulseIdentity, id: string, extraRecipients: string[]) {
  await requirePublishRole(identity);
  await assertSendable();
  await loadOne(id);
  const staff = await internalStaffEmails();
  const recipients = [{ email: identity.email.toLowerCase(), displayName: identity.name, locale: "en" as const }];
  for (const extra of extraRecipients.map((e) => e.toLowerCase()))
    if (staff.has(extra) && !recipients.some((r) => r.email === extra)) recipients.push({ email: extra, displayName: extra, locale: "en" });
  const queued = await insertTestDeliveries(id, recipients);
  if (!isAzureSqlConfigured()) memoryAuditEvent(identity, "communication.test-sent", "Communication", id, { queued });
  // SQL: audit 'communication.test-sent'
  return { queued };
}

export async function listDeliveries(identity: PulseIdentity, id: string, filter: { state?: string; organizationId?: string; page?: number; pageSize?: number }) {
  await requireInternalRole(identity);
  await loadOne(id);
  return listDeliveryRows(id, { state: filter.state, organizationId: filter.organizationId, page: Math.max(1, filter.page || 1), pageSize: Math.min(Math.max(filter.pageSize || 100, 1), 250) });
}

export async function retryDeadLetters(identity: PulseIdentity, id: string) {
  await requirePublishRole(identity);
  await loadOne(id);
  const requeued = await requeueDeadLetters(id);
  if (!isAzureSqlConfigured()) memoryAuditEvent(identity, "communication.deliveries.retried", "Communication", id, { requeued });
  // SQL: audit 'communication.deliveries.retried'
  return { requeued };
}
```

The memory `internalStaffEmails` also accepts users holding an internal role in any organisation because the memory seed has no Internal-type organisation; the SQL branch is exact (Internal-type organisation membership).

- [ ] **Step 6: Run** — `npm test` → PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/contracts.ts lib/server/communications/delivery-store.ts lib/server/communications/campaign-repository.ts tests/communications.test.ts
git commit -m "feat(communications): audience freeze, send/schedule/cancel, test sends and delivery stats"
```

---

### Task 10: Campaign API routes

**Files:**
- Create: `app/api/v1/internal/communications/route.ts` (GET, POST)
- Create: `app/api/v1/internal/communications/[id]/route.ts` (GET, PATCH, DELETE)
- Create: `app/api/v1/internal/communications/[id]/duplicate/route.ts` (POST)
- Create: `app/api/v1/internal/communications/[id]/preview/route.ts` (GET)
- Create: `app/api/v1/internal/communications/[id]/audience/route.ts` (GET)
- Create: `app/api/v1/internal/communications/[id]/test/route.ts` (POST)
- Create: `app/api/v1/internal/communications/[id]/send/route.ts` (POST)
- Create: `app/api/v1/internal/communications/[id]/cancel/route.ts` (POST)
- Create: `app/api/v1/internal/communications/[id]/deliveries/route.ts` (GET)
- Create: `app/api/v1/internal/communications/[id]/deliveries/retry/route.ts` (POST)
- Modify: `scripts/generate-openapi.ts` (`schemaNames`), `docs/openapi-base.json`
- Test: `tests/communications-routes.test.ts` (extend)

**Interfaces:**
- Consumes: Task 8/9 functions, `executeIdempotent`, `checkedMutation`.
- Produces: HTTP surface for Task 16/17. Shapes: list `{ items }`; get `{ item }` (item includes `stats` and `version`); create/duplicate 201 `{ item }`; send/cancel `{ item }`; test `{ queued }`; audience `{ item: breakdown }`; deliveries `{ items, total }`; retry `{ requeued }`; preview → `text/html` or `text/plain`.

- [ ] **Step 1: Failing route tests**

```ts
import { GET as communicationsGet, POST as communicationsPost } from "../app/api/v1/internal/communications/route";
import { GET as previewGet } from "../app/api/v1/internal/communications/[id]/preview/route";

const plainDraft = {
  templateKey: "plain", topic: "general", title: "Route test",
  content: { subject: { en: "Hello" }, body: { en: { title: "Hi", paragraphs: ["One"] } } },
  audience: { organizations: "all-customers" },
};

test("routes: create needs an Idempotency-Key, then list and preview work (demo System admin identity)", async () => {
  const missingKey = await communicationsPost(req("/api/v1/internal/communications", { method: "POST", body: JSON.stringify(plainDraft) }));
  assert.equal(missingKey.status, 400);
  const created = await communicationsPost(req("/api/v1/internal/communications", { method: "POST", headers: { "idempotency-key": "route-test-create-1" }, body: JSON.stringify(plainDraft) }));
  assert.equal(created.status, 201);
  const id = (await created.json()).item.id as string;
  assert.match(id, /^COM-\d{3}$/);
  const list = await communicationsGet(req("/api/v1/internal/communications"));
  assert.equal(list.status, 200);
  assert.equal((await list.json()).items.length, 1);
  const preview = await previewGet(req(`/api/v1/internal/communications/${id}/preview?locale=is`), { params: Promise.resolve({ id }) });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(preview.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(await preview.text(), /Tilkynning/);
  const missing = await previewGet(req("/api/v1/internal/communications/COM-999/preview"), { params: Promise.resolve({ id: "COM-999" }) });
  assert.equal(missing.status, 404);
});
```

- [ ] **Step 2: Run** — `npm test` → FAIL.

- [ ] **Step 3: Routes** — collection route `app/api/v1/internal/communications/route.ts`:

```ts
import { getIdentity } from "@/lib/server/auth";
import { createCommunication, listCommunications } from "@/lib/server/communications/campaign-repository";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeIdempotent } from "@/lib/server/idempotency";
import { readJson } from "@/lib/server/validation";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json({ items: await listCommunications(await getIdentity(request)) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await getIdentity(request);
    const result = await executeIdempotent(request, identity, "communication.create", 201, async () => ({
      item: await createCommunication(identity, (await readJson(request)) as never),
    }));
    return json(result.body, { status: result.status }, id);
  } catch (error) {
    return apiError(error, id);
  }
}
```

Item route `[id]/route.ts`: `GET` → `{ item: await getCommunication(identity, id) }`; `PATCH` → `checkedMutation(identity, "Communications", id, request.headers.get("if-match"), () => updateCommunication(identity, id, await readInput(request, communicationInputSchema)))` (read the input before calling `checkedMutation`); `DELETE` → `deleteCommunication`, `{ ok: true }`.

Send route `[id]/send/route.ts` (the pattern for `test`, `duplicate`, `cancel`, `deliveries/retry` is identical with the operation name and repository call swapped):

```ts
import { communicationSendInputSchema } from "@/lib/contracts";
import { getIdentity } from "@/lib/server/auth";
import { sendCommunication } from "@/lib/server/communications/campaign-repository";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeIdempotent } from "@/lib/server/idempotency";
import { readJson, parseInput } from "@/lib/server/validation";
import { checkedMutation } from "@/lib/server/versions";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const identity = await getIdentity(request);
    const input = parseInput(communicationSendInputSchema, request.body ? await readJson(request.clone()) : {});
    const result = await executeIdempotent(request, identity, `communication.send:${id}`, 200, async () => ({
      item: await checkedMutation(identity, "Communications", id, request.headers.get("if-match"), () => sendCommunication(identity, id, input)),
    }));
    return json(result.body, { status: result.status }, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
```

`cancel` uses `communicationCancelInputSchema` and `checkedMutation` but no idempotency (cancelling twice is harmless); `test` uses `executeIdempotent(… \`communication.test:${id}\` …)` with `communicationTestSendSchema`; `duplicate` uses `executeIdempotent(… \`communication.duplicate:${id}\`, 201 …)`; `deliveries/retry` uses `executeIdempotent(… \`communication.retry:${id}\` …)`.

Preview route `[id]/preview/route.ts`:

```ts
import { getIdentity } from "@/lib/server/auth";
import { previewCommunication } from "@/lib/server/communications/campaign-repository";
import { apiError, correlationId } from "@/lib/server/http";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    const locale = url.searchParams.get("locale") === "is" ? "is" : "en";
    const format = url.searchParams.get("format") === "text" ? "text" : "html";
    const rendered = await previewCommunication(await getIdentity(request), id, locale);
    return new Response(format === "text" ? rendered.text : rendered.html, {
      headers: {
        "content-type": format === "text" ? "text/plain; charset=utf-8" : "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'",
        "cache-control": "no-store",
        "x-correlation-id": correlation,
      },
    });
  } catch (error) {
    return apiError(error, correlation);
  }
}
```

`audience/route.ts` → `{ item: await audienceEstimate(identity, id) }`; `deliveries/route.ts` → reads `state`, `organizationId`, `page`, `pageSize` from the query → `listDeliveries`.

- [ ] **Step 4: OpenAPI** — `schemaNames` additions:

```ts
  "POST /api/v1/internal/communications": "communicationInputSchema",
  "PATCH /api/v1/internal/communications/{id}": "communicationInputSchema",
  "POST /api/v1/internal/communications/{id}/send": "communicationSendInputSchema",
  "POST /api/v1/internal/communications/{id}/test": "communicationTestSendSchema",
  "POST /api/v1/internal/communications/{id}/cancel": "communicationCancelInputSchema",
```

Curated `docs/openapi-base.json` entries: `listCommunications`/`createCommunication` (201), `getCommunication`/`updateCommunication`/`deleteCommunication`, `duplicateCommunication` (201), `previewCommunication` (200 with `content: { "text/html": { schema: { type: "string" } } }`), `communicationAudienceEstimate`, `testSendCommunication`, `sendCommunication`, `cancelCommunication`, `listCommunicationDeliveries`, `retryCommunicationDeliveries`. Run `npm run openapi:generate`.

- [ ] **Step 5: Run** — `npm test`, `npm run openapi:check`, `npm run lint` → PASS.

- [ ] **Step 6: Commit**

```bash
git add app/api/v1/internal/communications scripts/generate-openapi.ts docs/openapi-base.json public/openapi.json tests/communications-routes.test.ts
git commit -m "feat(communications): campaign API routes with If-Match and idempotent send"
```

---

### Task 11: SendGrid transport, delivery worker and job route

**Files:**
- Create: `lib/server/communications/sendgrid.ts`
- Create: `lib/server/communications/delivery-worker.ts`
- Create: `app/api/v1/internal/jobs/communications/route.ts`
- Modify: `lib/server/communications/delivery-store.ts` (tighten `claimBatch`: never mix Test and real rows)
- Modify: `lib/server/delivery-status.ts`, `app/api/v1/admin/delivery/route.ts`, `app/features/delivery-status.tsx` (Communications channel)
- Modify: `package.json` (dependency), `docs/openapi-base.json`
- Test: `tests/communications.test.ts` (extend)

**Interfaces:**
- Consumes: `DeliveryStore`, `ClaimedBatch`, `BACKOFF_BASE_MS`, `MAX_ATTEMPTS` (Task 9); `renderCommunication` (Task 2); `getRuntimeCommunicationSettings` (Task 1).
- Produces (sendgrid.ts):

```ts
export type OutboundRecipient = { email: string; name: string | null; customArgs: Record<string, string> };
export type OutboundBatch = {
  subject: string; html: string; text: string; recipients: OutboundRecipient[];
  from: { email: string; name: string }; replyTo: string | null; categories: string[];
  unsubscribeGroupId: number | null; tracking: { opens: boolean; clicks: boolean }; sandbox: boolean;
};
export type SendOutcome = { providerMessageId: string | null };
export class SendError extends Error { code: string; retryable: boolean; retryAfterSeconds: number | null }
export type MailTransport = { kind: "sendgrid" | "console"; sendBatch(batch: OutboundBatch): Promise<SendOutcome> };
export function buildSendGridMessage(batch: OutboundBatch): Record<string, unknown>;          // pure
export function classifySendError(error: unknown): SendError;                                 // pure
export function createMailTransport(settings: CommunicationSettings, overrides?: { send?: (message: Record<string, unknown>) => Promise<{ statusCode: number; headers: Record<string, string> }> }): MailTransport;
```

  and (delivery-worker.ts):

```ts
export type WorkerResult = { skipped: boolean; promoted: string[]; accepted: number; retried: number; deadLettered: number; completed: string[]; capReached: boolean };
export async function processCommunicationBatch(limit = 500, deps?: { store?: DeliveryStore; transport?: MailTransport; now?: () => Date }): Promise<WorkerResult>;
```

- [ ] **Step 1: Dependency** — `npm install @sendgrid/mail@8.1.6` (exact pin; the package is the official Twilio SendGrid SDK and brings `@sendgrid/client` + `axios`). Run `npm audit --audit-level=high` — must stay clean.

- [ ] **Step 2: Failing tests**

```ts
import { buildSendGridMessage, classifySendError, type MailTransport, type OutboundBatch } from "../lib/server/communications/sendgrid";
import { processCommunicationBatch } from "../lib/server/communications/delivery-worker";

function fakeTransport(script: Array<"ok" | { status: number; retryAfter?: number }> = []) {
  const calls: OutboundBatch[] = [];
  const transport: MailTransport = {
    kind: "sendgrid",
    async sendBatch(batch) {
      calls.push(batch);
      const step = script.shift() ?? "ok";
      if (step === "ok") return { providerMessageId: `msg-${calls.length}` };
      throw Object.assign(new Error("sendgrid failure"), { code: step.status, response: { headers: step.retryAfter ? { "retry-after": String(step.retryAfter) } : {}, body: { errors: [{ message: "nope" }] } } });
    },
  };
  return { transport, calls };
}
async function readyCampaign() {
  await seedAudience();
  await enableSending();
  const created = await createCommunication(PM, draftInput);
  await sendCommunication(PM, created.id, {});
  return created.id;
}

test("sendgrid: message builder maps recipients, custom args, categories, asm and tracking", () => {
  const message = buildSendGridMessage({
    subject: "S", html: "<p>h</p>", text: "t", from: { email: "updates@datacentral.ai", name: "DataCentral" }, replyTo: null,
    recipients: [{ email: "a@origo.is", name: "A", customArgs: { deliveryId: "d1", communicationId: "COM-001" } }],
    categories: ["pulse", "pulse-product-updates", "COM-001"], unsubscribeGroupId: 42, tracking: { opens: false, clicks: true }, sandbox: true,
  }) as { personalizations: Array<{ to: Array<{ email: string }>; customArgs: Record<string, string> }>; asm: { groupId: number }; trackingSettings: { openTracking: { enable: boolean } }; mailSettings: { sandboxMode: { enable: boolean } } };
  assert.equal(message.personalizations[0].to[0].email, "a@origo.is");
  assert.equal(message.personalizations[0].customArgs.deliveryId, "d1");
  assert.equal(message.asm.groupId, 42);
  assert.equal(message.trackingSettings.openTracking.enable, false);
  assert.equal(message.mailSettings.sandboxMode.enable, true);
});

test("sendgrid: error classification", () => {
  assert.deepEqual([classifySendError({ code: 429, response: { headers: { "retry-after": "900" } } })].map((e) => [e.code, e.retryable, e.retryAfterSeconds]), [["HTTP_429", true, 900]]);
  assert.equal(classifySendError({ code: 400, response: { body: { errors: [{ message: "bad" }] } } }).retryable, false);
  assert.equal(classifySendError({ code: 503 }).retryable, true);
  assert.equal(classifySendError(new Error("ECONNRESET")).retryable, true);
});

test("worker: sends one request per locale with ≤500 recipients, marks Accepted and completes the campaign", async () => {
  const id = await readyCampaign();
  const { transport, calls } = fakeTransport();
  const result = await processCommunicationBatch(500, { transport });
  assert.equal(calls.length, 2, "en and is batches");
  assert.ok(calls.every((c) => c.recipients.every((r) => r.customArgs.communicationId === id && r.customArgs.deliveryId)));
  assert.deepEqual(calls[0].categories, ["pulse", "pulse-product-updates", id]);
  assert.equal(result.accepted, 4);
  assert.deepEqual(result.completed, [id]);
  assert.equal((await getCommunication(PM, id)).status, "Sent");
  assert.ok((await listDeliveries(PM, id, {})).items.every((d) => d.state === "Accepted" && d.providerMessageId));
});

test("worker: honours Retry-After when it exceeds the backoff; non-retryable errors dead-letter at once", async () => {
  const id = await readyCampaign();
  const start = Date.now();
  const throttled = await processCommunicationBatch(500, { transport: fakeTransport([{ status: 429, retryAfter: 900 }]).transport, now: () => new Date(start) });
  assert.equal(throttled.retried, 3, "the English batch of three was throttled");
  assert.equal((await listDeliveries(PM, id, { state: "Queued" })).total, 1, "the Icelandic row is never claimed after the 429 stop");
  const retry = (await listDeliveries(PM, id, { state: "Retry" })).items[0];
  assert.ok(new Date(retry.nextAttemptAt!).getTime() >= start + 900_000);
  for (const d of globalThis.pulseMemoryCommunicationDeliveries!) d.nextAttemptAt = new Date(0).toISOString();
  const rejected = await processCommunicationBatch(500, { transport: fakeTransport([{ status: 400 }, { status: 400 }]).transport });
  assert.ok(rejected.deadLettered >= 1);
  assert.ok((await listDeliveries(PM, id, { state: "Dead letter" })).total >= 1);
});

test("worker: five retryable failures dead-letter; master switch off skips; daily cap stops claiming", async () => {
  const id = await readyCampaign();
  const script = Array.from({ length: 10 }, () => ({ status: 500 }));
  for (let i = 0; i < 5; i++) {
    await processCommunicationBatch(500, { transport: fakeTransport(script).transport });
    for (const d of globalThis.pulseMemoryCommunicationDeliveries!) d.nextAttemptAt = new Date(0).toISOString();
  }
  assert.equal((await communicationStats(id)).deadLettered, 4);
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: false });
  assert.equal((await processCommunicationBatch(500, { transport: fakeTransport().transport })).skipped, true);
  const second = await createCommunication(PM, draftInput);
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, enabled: true, fromEmail: "updates@datacentral.ai", safeMode: { enabled: false, allowedDomains: [] }, dailyCap: 2 });
  await sendCommunication(PM, second.id, {});
  const capped = await processCommunicationBatch(500, { transport: fakeTransport().transport });
  assert.equal(capped.capReached, true);
  assert.equal((await communicationStats(second.id)).queued, 2, "cap of 2 leaves two of four recipients queued");
});

test("worker: promotes due scheduled campaigns and prefixes test sends", async () => {
  await seedAudience();
  await enableSending();
  const created = await createCommunication(PM, draftInput);
  await sendCommunication(PM, created.id, { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
  globalThis.pulseMemoryCommunications![0].scheduledAt = new Date(Date.now() - 1000).toISOString();
  const { transport, calls } = fakeTransport();
  const result = await processCommunicationBatch(500, { transport });
  assert.deepEqual(result.promoted, [created.id]);
  assert.equal(result.accepted, 4);
  const draft = await createCommunication(PM, draftInput);
  await testSendCommunication(PM, draft.id, []);
  await processCommunicationBatch(500, { transport });
  assert.ok(calls.at(-1)!.subject.startsWith("[TEST] "));
  assert.equal(calls.at(-1)!.recipients[0].email, PM.email);
});
```

- [ ] **Step 3: Run** — `npm test` → FAIL.

- [ ] **Step 4: Transport** — `lib/server/communications/sendgrid.ts`:

```ts
import sgMail from "@sendgrid/mail";
import type { CommunicationSettings } from "./settings";

export type OutboundRecipient = { email: string; name: string | null; customArgs: Record<string, string> };
export type OutboundBatch = {
  subject: string; html: string; text: string; recipients: OutboundRecipient[];
  from: { email: string; name: string }; replyTo: string | null; categories: string[];
  unsubscribeGroupId: number | null; tracking: { opens: boolean; clicks: boolean }; sandbox: boolean;
};
export type SendOutcome = { providerMessageId: string | null };
export class SendError extends Error {
  constructor(public code: string, public retryable: boolean, public retryAfterSeconds: number | null = null) {
    super(code);
    this.name = "SendError";
  }
}
export type MailTransport = { kind: "sendgrid" | "console"; sendBatch(batch: OutboundBatch): Promise<SendOutcome> };

/** Shape accepted by @sendgrid/mail (camelCase keys are converted by the SDK). */
export function buildSendGridMessage(batch: OutboundBatch) {
  return {
    from: batch.from,
    ...(batch.replyTo ? { replyTo: { email: batch.replyTo } } : {}),
    subject: batch.subject,
    html: batch.html,
    text: batch.text,
    personalizations: batch.recipients.map((r) => ({ to: [{ email: r.email, ...(r.name ? { name: r.name } : {}) }], customArgs: r.customArgs })),
    categories: batch.categories.slice(0, 10),
    ...(batch.unsubscribeGroupId ? { asm: { groupId: batch.unsubscribeGroupId } } : {}),
    trackingSettings: { clickTracking: { enable: batch.tracking.clicks, enableText: false }, openTracking: { enable: batch.tracking.opens } },
    mailSettings: { sandboxMode: { enable: batch.sandbox } },
  };
}

export function classifySendError(error: unknown): SendError {
  if (error instanceof SendError) return error;
  const e = error as { code?: unknown; response?: { headers?: Record<string, string>; body?: { errors?: Array<{ message?: string }> } }; message?: string };
  const status = typeof e?.code === "number" ? e.code : Number(e?.code);
  if (Number.isFinite(status) && status >= 100) {
    const retryAfter = Number(e.response?.headers?.["retry-after"]);
    return new SendError(`HTTP_${status}`, status === 429 || status >= 500, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
  }
  return new SendError((e?.message || "SEND_FAILED").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40), true);
}

const consoleTransport: MailTransport = {
  kind: "console",
  async sendBatch(batch) {
    console.log(JSON.stringify({ level: "info", event: "communications.console-send", recipients: batch.recipients.length, sandbox: batch.sandbox }));
    return { providerMessageId: `console-${crypto.randomUUID()}` };
  },
};

export function createMailTransport(settings: CommunicationSettings, overrides?: { send?: (message: Record<string, unknown>) => Promise<{ statusCode: number; headers: Record<string, string> }> }): MailTransport {
  const apiKey = process.env.SENDGRID_API_KEY?.trim();
  if (!apiKey && !overrides?.send) return consoleTransport;
  const send = overrides?.send ?? (async (message: Record<string, unknown>) => {
    sgMail.setApiKey(apiKey!);
    sgMail.setDataResidency(settings.dataResidency === "eu" ? "eu" : "global");
    const [response] = await sgMail.send(message as never);
    return { statusCode: response.statusCode, headers: response.headers as Record<string, string> };
  });
  return {
    kind: "sendgrid",
    async sendBatch(batch) {
      try {
        const response = await send(buildSendGridMessage(batch));
        if (response.statusCode < 200 || response.statusCode >= 300) throw new SendError(`HTTP_${response.statusCode}`, response.statusCode >= 500);
        return { providerMessageId: response.headers?.["x-message-id"] ?? null };
      } catch (error) {
        throw classifySendError(error);
      }
    },
  };
}
```

`sgMail.setDataResidency` exists in `@sendgrid/mail` ≥ 7.7 (`"eu"` routes to `api.eu.sendgrid.com`). The SDK's `ResponseError` carries the HTTP status in `code` and the parsed body/headers in `response`, which `classifySendError` reads; nothing from the error body is logged (it can echo recipient data).

- [ ] **Step 5: Tighten `claimBatch`** — in both store implementations only group rows that share the Test/real flag with the first claimed row: memory `candidates.filter((d) => … && (d.source === "Test") === (first.source === "Test"))`; SQL add `d.source source` to `next_campaign`'s select, and to `next_items` add `AND (CASE WHEN d.source='Test' THEN 1 ELSE 0 END)=(CASE WHEN n.source='Test' THEN 1 ELSE 0 END)`.

- [ ] **Step 6: Worker** — `lib/server/communications/delivery-worker.ts`:

```ts
import { BACKOFF_BASE_MS, MAX_ATTEMPTS, getDeliveryStore, type DeliveryStore } from "./delivery-store";
import { classifySendError, createMailTransport, type MailTransport, type OutboundBatch } from "./sendgrid";
import { getRuntimeCommunicationSettings } from "./settings";
import { renderCommunication } from "./templates/index";

export type WorkerResult = { skipped: boolean; promoted: string[]; accepted: number; retried: number; deadLettered: number; completed: string[]; capReached: boolean };

export async function processCommunicationBatch(limit = 500, deps: { store?: DeliveryStore; transport?: MailTransport; now?: () => Date } = {}): Promise<WorkerResult> {
  const result: WorkerResult = { skipped: false, promoted: [], accepted: 0, retried: 0, deadLettered: 0, completed: [], capReached: false };
  const settings = await getRuntimeCommunicationSettings();
  if (!settings.enabled) return { ...result, skipped: true };
  const store = deps.store ?? getDeliveryStore();
  const transport = deps.transport ?? createMailTransport(settings);
  if (transport.kind === "console" && process.env.NODE_ENV === "production") throw new Error("INVALID_EMAIL_PROVIDER_CONFIGURATION");
  const now = deps.now ?? (() => new Date());
  const publicUrl = (process.env.PULSE_PUBLIC_URL || "http://localhost:3000").replace(/\/+$/, "");
  result.promoted = await store.promoteScheduled(now());
  let acceptedToday = await store.acceptedToday(now());
  let processed = 0;
  while (processed < Math.min(Math.max(limit, 1), 5000)) {
    const room = settings.dailyCap - acceptedToday;
    if (room <= 0) { result.capReached = true; break; }
    const batch = await store.claimBatch(Math.min(500, room, limit - processed));
    if (!batch) break;
    const ids = batch.deliveries.map((d) => d.id);
    processed += ids.length;
    const isTest = batch.deliveries[0].source === "Test";
    const rendered = renderCommunication(batch.templateKey, batch.content, batch.locale, {
      publicUrl, boilerplate: settings.boilerplate[batch.locale], unsubscribeTags: settings.unsubscribeGroupId !== null, testPrefix: isTest,
    });
    const outbound: OutboundBatch = {
      subject: rendered.subject, html: rendered.html, text: rendered.text,
      recipients: batch.deliveries.map((d) => ({ email: d.email, name: d.displayName, customArgs: { deliveryId: d.id, communicationId: batch.communicationId } })),
      from: { email: settings.fromEmail, name: settings.fromName }, replyTo: settings.replyTo || null,
      categories: [settings.categoriesPrefix, `${settings.categoriesPrefix}-${isTest ? "test" : batch.topic}`, batch.communicationId],
      unsubscribeGroupId: settings.unsubscribeGroupId, tracking: settings.tracking, sandbox: settings.sandboxMode,
    };
    try {
      const outcome = await transport.sendBatch(outbound);
      await store.markAccepted(ids, outcome.providerMessageId, now());
      result.accepted += ids.length;
      acceptedToday += ids.length;
    } catch (error) {
      const failure = classifySendError(error);
      const attempt = Math.max(...batch.deliveries.map((d) => d.attemptCount));
      const terminal = !failure.retryable || attempt >= MAX_ATTEMPTS;
      const wait = Math.max(2 ** attempt * BACKOFF_BASE_MS, (failure.retryAfterSeconds ?? 0) * 1000);
      await store.markFailed(ids, failure.code, terminal ? null : new Date(now().getTime() + wait));
      if (terminal) result.deadLettered += ids.length; else result.retried += ids.length;
      console.error(JSON.stringify({ level: "error", event: "communications.send.failed", code: failure.code, recipients: ids.length, terminal }));
      if (failure.code === "HTTP_429") break; // give the provider the Retry-After window
    }
  }
  result.completed = await store.completeCampaigns(now());
  return result;
}
```

- [ ] **Step 7: Job route** — `app/api/v1/internal/jobs/communications/route.ts` is a copy of `app/api/v1/internal/jobs/notifications/route.ts` with `processCommunicationBatch(Number(body.limit || 500))` and the `limit` schema max `5000`. Add a curated entry `processCommunicationOutbox` in `docs/openapi-base.json` (`security: [{ notificationJobSecret: [] }]`).

- [ ] **Step 8: Delivery status card** — `lib/server/delivery-status.ts`: add a third `UNION ALL SELECT 'Communications' channel,state,COUNT(*) count,MIN(created_at) oldest FROM dbo.CommunicationDeliveries WHERE state IN ('Queued','Retry','Processing','Dead letter') GROUP BY state`; in `retryDeliveries` accept `"Communications"` and run `UPDATE TOP(100) dbo.CommunicationDeliveries SET state='Queued',attempt_count=0,next_attempt_at=NULL,last_error_code=NULL OUTPUT INSERTED.id WHERE state='Dead letter'`. Widen the channel type to `"Email" | "Webhook" | "Communications"` there, in the route's `z.enum`, and in `app/features/delivery-status.tsx`. Add `Communications: "Samskipti"` to `lib/i18n-internal.ts`.

- [ ] **Step 9: Run** — `npm test`, `npm run lint`, `npm run openapi:generate` → PASS.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json lib/server/communications/sendgrid.ts lib/server/communications/delivery-worker.ts lib/server/communications/delivery-store.ts app/api/v1/internal/jobs/communications lib/server/delivery-status.ts app/api/v1/admin/delivery/route.ts app/features/delivery-status.tsx lib/i18n-internal.ts docs/openapi-base.json public/openapi.json tests/communications.test.ts
git commit -m "feat(communications): SendGrid transport, delivery worker and job route"
```

---

### Task 12: SendGrid Event Webhook

**Files:**
- Create: `lib/server/communications/event-webhook.ts`
- Create: `app/api/v1/internal/communications/events/route.ts`
- Modify: `proxy.ts:31-45` (rate-limit group) and `:118-131` (JSON pre-parse exemption)
- Modify: `scripts/generate-openapi.ts` (`x-authorization` + security scheme), `docs/openapi-base.json`
- Modify: `lib/server/retention-worker.ts` (purge events after 90 days)
- Test: `tests/communications.test.ts`, `tests/communications-routes.test.ts` (extend)

**Interfaces:**
- Consumes: `memoryEvents()`, `memoryDeliveries()` (Task 1/9), `suppressAddress`, `releaseAddress` (Task 5).
- Produces:

```ts
export function normalizePublicKey(value: string): string;                      // strips PEM armour and whitespace
export function verifyEventSignature(publicKeyBase64: string, payload: string, signature: string | null, timestamp: string | null, nowMs?: number): boolean;
export type SendGridEvent = { sg_event_id: string; sg_message_id?: string; event: string; email: string; timestamp: number; reason?: string; type?: string; deliveryId?: string; communicationId?: string };
export function parseEvents(raw: string): SendGridEvent[];                      // ≤ 1000 well-formed events, others dropped
export type EventEffect = { lastEvent: string; state?: DeliveryState; opened?: true; clicked?: true; suppress?: SuppressionReason; release?: SuppressionReason };
export function mapEvent(event: SendGridEvent): EventEffect;                     // pure (§6.4 table)
export async function applyEvents(events: SendGridEvent[]): Promise<{ applied: number; ignored: number }>;
```

- [ ] **Step 1: Failing tests** — repository level (`tests/communications.test.ts`):

```ts
import { generateKeyPairSync, sign } from "node:crypto";
import { applyEvents, mapEvent, parseEvents, verifyEventSignature } from "../lib/server/communications/event-webhook";

function signedPayload(body: string, offsetSeconds = 0) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const timestamp = String(Math.floor(Date.now() / 1000) + offsetSeconds);
  const signature = sign("sha256", Buffer.from(timestamp + body, "utf8"), privateKey).toString("base64");
  return { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), timestamp, signature };
}

test("webhook: ECDSA signature verification, PEM-armoured keys and the 10-minute window", () => {
  const body = JSON.stringify([{ sg_event_id: "e1", event: "delivered", email: "a@origo.is", timestamp: 1 }]);
  const { publicKey, timestamp, signature } = signedPayload(body);
  assert.equal(verifyEventSignature(publicKey, body, signature, timestamp), true);
  assert.equal(verifyEventSignature(`-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`, body, signature, timestamp), true);
  assert.equal(verifyEventSignature(publicKey, body + " ", signature, timestamp), false);
  assert.equal(verifyEventSignature(publicKey, body, signature, String(Number(timestamp) - 601)), false);
  assert.equal(verifyEventSignature(publicKey, body, null, timestamp), false);
});

test("webhook: event mapping", () => {
  assert.deepEqual(mapEvent({ sg_event_id: "1", event: "delivered", email: "a", timestamp: 1 }), { lastEvent: "delivered", state: "Delivered" });
  assert.deepEqual(mapEvent({ sg_event_id: "1", event: "bounce", type: "bounce", email: "a", timestamp: 1 }), { lastEvent: "bounce", state: "Bounced", suppress: "Bounced" });
  assert.deepEqual(mapEvent({ sg_event_id: "1", event: "bounce", type: "blocked", email: "a", timestamp: 1 }), { lastEvent: "bounce", state: "Bounced" });
  assert.deepEqual(mapEvent({ sg_event_id: "1", event: "dropped", reason: "Unsubscribed Address", email: "a", timestamp: 1 }), { lastEvent: "dropped", state: "Dropped", suppress: "Unsubscribed" });
  assert.deepEqual(mapEvent({ sg_event_id: "1", event: "group_resubscribe", email: "a", timestamp: 1 }), { lastEvent: "group_resubscribe", release: "Unsubscribed" });
  assert.deepEqual(mapEvent({ sg_event_id: "1", event: "open", email: "a", timestamp: 1 }), { lastEvent: "open", opened: true });
  assert.deepEqual(mapEvent({ sg_event_id: "1", event: "processed", email: "a", timestamp: 1 }), { lastEvent: "processed" });
});

test("webhook: applies delivery states, bounce suppresses the address, duplicates and unknown ids are no-ops", async () => {
  const id = await readyCampaign();
  await processCommunicationBatch(500, { transport: fakeTransport().transport });
  const items = (await listDeliveries(PM, id, {})).items;
  const jon = items.find((d) => d.email === "jon@origo.is")!;
  const cio = items.find((d) => d.email === "cio@origo.is")!;
  const events = parseEvents(JSON.stringify([
    { sg_event_id: "e1", event: "delivered", email: jon.email, timestamp: 1, deliveryId: jon.id, communicationId: id },
    { sg_event_id: "e2", event: "open", email: jon.email, timestamp: 2, deliveryId: jon.id, communicationId: id },
    { sg_event_id: "e3", event: "bounce", type: "bounce", reason: "550 unknown", email: cio.email, timestamp: 3, deliveryId: cio.id, communicationId: id },
    { sg_event_id: "e1", event: "delivered", email: jon.email, timestamp: 1, deliveryId: jon.id, communicationId: id },
    { sg_event_id: "e4", event: "delivered", email: "ghost@x.is", timestamp: 1, deliveryId: crypto.randomUUID() },
    { event: "delivered" },
  ]));
  assert.equal(events.length, 5, "malformed event dropped by parseEvents");
  const result = await applyEvents(events);
  assert.deepEqual(result, { applied: 3, ignored: 2 });
  const after = (await listDeliveries(PM, id, {})).items;
  assert.equal(after.find((d) => d.id === jon.id)?.state, "Delivered");
  assert.ok(after.find((d) => d.id === jon.id)?.openedAt);
  assert.equal(after.find((d) => d.id === cio.id)?.state, "Bounced");
  assert.equal((await loadSuppressionMap()).get(cio.email), "Bounced");
  assert.equal((await listContacts(PM, "ORG-001")).find((c) => c.email === cio.email)?.status, "Bounced");
  // the bounced address is now excluded from the next campaign even though the contact still exists
  const next = await createCommunication(PM, draftInput);
  assert.equal((await audienceEstimate(PM, next.id)).suppressed.Bounced, 1);
});
```

Route level (`tests/communications-routes.test.ts`):

```ts
import { generateKeyPairSync, sign } from "node:crypto";
import { POST as eventsPost } from "../app/api/v1/internal/communications/events/route";

function signedRequest(body: string, publicKeyEnv: boolean, offsetSeconds = 0) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const timestamp = String(Math.floor(Date.now() / 1000) + offsetSeconds);
  const signature = sign("sha256", Buffer.from(timestamp + body, "utf8"), privateKey).toString("base64");
  if (publicKeyEnv) process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  else delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
  return new Request("http://localhost/api/v1/internal/communications/events", {
    method: "POST", body,
    headers: { "content-type": "application/json", "x-twilio-email-event-webhook-signature": signature, "x-twilio-email-event-webhook-timestamp": timestamp },
  });
}
const body = JSON.stringify([{ sg_event_id: "r1", event: "delivered", email: "a@origo.is", timestamp: 1 }]);

test("webhook route: 503 without a key, 401 on bad signature or stale timestamp, 200 when valid", async () => {
  assert.equal((await eventsPost(signedRequest(body, false))).status, 503);
  assert.equal((await eventsPost(signedRequest(body, true, -700))).status, 401);
  const tampered = signedRequest(body, true);
  const wrong = new Request(tampered.url, { method: "POST", body: body + " ", headers: tampered.headers });
  assert.equal((await eventsPost(wrong)).status, 401);
  const ok = await eventsPost(signedRequest(body, true));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { applied: 0, ignored: 1 });
});
```

- [ ] **Step 2: Run** — `npm test` → FAIL.

- [ ] **Step 3: Implement** — `lib/server/communications/event-webhook.ts`:

```ts
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { getSqlPool, isAzureSqlConfigured, sql, atomicSql } from "../database";
import { memoryDeliveries, memoryEvents } from "./memory";
import { releaseAddress, suppressAddress } from "./suppression-repository";
import type { DeliveryState, SuppressionReason } from "./types";

export function normalizePublicKey(value: string) {
  return value.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
}
export function verifyEventSignature(publicKeyBase64: string, payload: string, signature: string | null, timestamp: string | null, nowMs = Date.now()) {
  if (!signature || !timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > 600) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(normalizePublicKey(publicKeyBase64), "base64"), format: "der", type: "spki" });
    return cryptoVerify("sha256", Buffer.from(timestamp + payload, "utf8"), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export type SendGridEvent = { sg_event_id: string; sg_message_id?: string; event: string; email: string; timestamp: number; reason?: string; type?: string; deliveryId?: string; communicationId?: string };
export function parseEvents(raw: string): SendGridEvent[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("INVALID_JSON"); }
  if (!Array.isArray(value)) throw new Error("INVALID_EVENTS");
  return value.slice(0, 1000).flatMap((e) => {
    if (!e || typeof e !== "object") return [];
    const v = e as Record<string, unknown>;
    if (typeof v.sg_event_id !== "string" || typeof v.event !== "string" || typeof v.email !== "string" || typeof v.timestamp !== "number") return [];
    return [{
      sg_event_id: v.sg_event_id.slice(0, 100), sg_message_id: typeof v.sg_message_id === "string" ? v.sg_message_id : undefined,
      event: v.event.slice(0, 32), email: v.email.toLowerCase().slice(0, 320), timestamp: v.timestamp,
      reason: typeof v.reason === "string" ? v.reason.slice(0, 500) : undefined, type: typeof v.type === "string" ? v.type : undefined,
      deliveryId: typeof v.deliveryId === "string" && /^[0-9a-f-]{36}$/i.test(v.deliveryId) ? v.deliveryId.toLowerCase() : undefined,
      communicationId: typeof v.communicationId === "string" ? v.communicationId.slice(0, 32) : undefined,
    }];
  });
}

export type EventEffect = { lastEvent: string; state?: DeliveryState; opened?: true; clicked?: true; suppress?: SuppressionReason; release?: SuppressionReason };
export function mapEvent(event: SendGridEvent): EventEffect {
  const base: EventEffect = { lastEvent: event.event };
  switch (event.event) {
    case "delivered": return { ...base, state: "Delivered" };
    case "deferred": return { ...base, state: "Deferred" };
    case "bounce": return event.type === "blocked" ? { ...base, state: "Bounced" } : { ...base, state: "Bounced", suppress: "Bounced" };
    case "dropped": {
      const reason = (event.reason || "").toLowerCase();
      const suppress: SuppressionReason | undefined = reason.includes("bounced address") ? "Bounced" : reason.includes("unsubscribed address") ? "Unsubscribed" : reason.includes("spam reporting address") ? "SpamReport" : undefined;
      return suppress ? { ...base, state: "Dropped", suppress } : { ...base, state: "Dropped" };
    }
    case "open": return { ...base, opened: true };
    case "click": return { ...base, clicked: true };
    case "spamreport": return { ...base, suppress: "SpamReport" };
    case "unsubscribe": case "group_unsubscribe": return { ...base, suppress: "Unsubscribed" };
    case "group_resubscribe": return { ...base, release: "Unsubscribed" };
    default: return base;
  }
}

export async function applyEvents(events: SendGridEvent[]) {
  let applied = 0;
  let ignored = 0;
  for (const event of events) {
    const effect = mapEvent(event);
    const occurredAt = new Date(event.timestamp * 1000).toISOString();
    if (!isAzureSqlConfigured()) {
      const seen = memoryEvents();
      if (seen.has(event.sg_event_id)) { ignored++; continue; }
      seen.add(event.sg_event_id);
      const delivery = memoryDeliveries().find((d) => (event.deliveryId && d.id === event.deliveryId) || (!event.deliveryId && event.sg_message_id && d.providerMessageId && event.sg_message_id.startsWith(d.providerMessageId) && d.email === event.email));
      if (delivery) {
        delivery.lastEvent = effect.lastEvent; delivery.lastEventAt = occurredAt;
        if (effect.state) delivery.state = effect.state;
        if (effect.opened) delivery.openedAt ||= occurredAt;
        if (effect.clicked) delivery.clickedAt ||= occurredAt;
      }
      if (effect.suppress) await suppressAddress(event.email, effect.suppress, "Webhook", event.reason);
      if (effect.release) await releaseAddress(event.email, effect.release);
      if (delivery || effect.suppress || effect.release) applied++; else ignored++;
      continue;
    }
    const outcome = await atomicSql(async () => {
      const pool = await getSqlPool();
      const inserted = await pool.request().input("id", sql.NVarChar(100), event.sg_event_id).input("delivery", sql.UniqueIdentifier, event.deliveryId || null)
        .input("event", sql.NVarChar(32), event.event).input("email", sql.NVarChar(320), event.email).input("occurred", sql.DateTime2, new Date(occurredAt))
        .input("reason", sql.NVarChar(500), event.reason || null).input("payload", sql.NVarChar(sql.MAX), JSON.stringify({ type: event.type, sg_message_id: event.sg_message_id }))
        .query(`INSERT dbo.CommunicationEvents(sg_event_id,delivery_id,event,email,occurred_at,reason,payload_json)
          SELECT @id,(SELECT id FROM dbo.CommunicationDeliveries WHERE id=@delivery),@event,@email,@occurred,@reason,@payload
          WHERE NOT EXISTS (SELECT 1 FROM dbo.CommunicationEvents WHERE sg_event_id=@id)`);
      if (!inserted.rowsAffected[0]) return "duplicate";
      const updated = await pool.request().input("delivery", sql.UniqueIdentifier, event.deliveryId || null).input("email", sql.NVarChar(320), event.email)
        .input("message", sql.NVarChar(200), event.sg_message_id || null).input("last", sql.NVarChar(32), effect.lastEvent).input("occurred", sql.DateTime2, new Date(occurredAt))
        .input("state", sql.NVarChar(32), effect.state || null).input("opened", sql.Bit, effect.opened ? 1 : 0).input("clicked", sql.Bit, effect.clicked ? 1 : 0)
        .query(`UPDATE TOP(1) dbo.CommunicationDeliveries SET last_event=@last,last_event_at=@occurred,state=COALESCE(@state,state),
          opened_at=CASE WHEN @opened=1 THEN COALESCE(opened_at,@occurred) ELSE opened_at END,clicked_at=CASE WHEN @clicked=1 THEN COALESCE(clicked_at,@occurred) ELSE clicked_at END
          WHERE (@delivery IS NOT NULL AND id=@delivery) OR (@delivery IS NULL AND @message IS NOT NULL AND provider_message_id IS NOT NULL AND email=@email AND @message LIKE provider_message_id+'%')`);
      return updated.rowsAffected[0] ? "applied" : "orphan";
    });
    if (outcome === "duplicate") { ignored++; continue; }
    if (effect.suppress) await suppressAddress(event.email, effect.suppress, "Webhook", event.reason);
    if (effect.release) await releaseAddress(event.email, effect.release);
    if (outcome === "applied" || effect.suppress || effect.release) applied++; else ignored++;
  }
  return { applied, ignored };
}
```

- [ ] **Step 4: Route** — `app/api/v1/internal/communications/events/route.ts`:

```ts
import { applyEvents, parseEvents, verifyEventSignature } from "@/lib/server/communications/event-webhook";
import { apiError, correlationId, json } from "@/lib/server/http";

const MAX_BYTES = 1024 * 1024;
async function readRawText(request: Request) {
  if (Number(request.headers.get("content-length") || 0) > MAX_BYTES) throw new Error("PAYLOAD_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("INVALID_JSON");
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { void reader.cancel().catch(() => undefined); throw new Error("PAYLOAD_TOO_LARGE"); }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const publicKey = process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY?.trim();
    if (!publicKey)
      return json({ error: { code: "WEBHOOK_NOT_CONFIGURED", message: "Configure SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY.", correlationId: id } }, { status: 503, headers: { "retry-after": "300" } }, id);
    const raw = await readRawText(request);
    const ok = verifyEventSignature(publicKey, raw, request.headers.get("x-twilio-email-event-webhook-signature"), request.headers.get("x-twilio-email-event-webhook-timestamp"));
    if (!ok) throw new Error("UNAUTHORIZED");
    return json(await applyEvents(parseEvents(raw)), {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
```

- [ ] **Step 5: Proxy** — in `proxy.ts` extend the group selection: `path === "/api/v1/internal/communications/events" ? "webhook-in" : …` with limit `group === "webhook-in" ? 600 : …`; and extend the JSON pre-parse exemption so the condition reads `!((request.method === "PUT" && /^\/api\/v1\/attachments\/[^/]+\/content$/.test(path)) || (request.method === "POST" && path === "/api/v1/internal/communications/events"))`. Add a comment: the webhook verifies the raw body itself and SendGrid batches exceed the 250-item/64 KiB JSON limits. Pin it with a test in `tests/communications-routes.test.ts` (the `proxy` + `NextRequest` pattern from `tests/dc-auth.test.ts`):

```ts
import { NextRequest } from "next/server";
import { proxy } from "../proxy";

test("proxy: the SendGrid events route skips the JSON pre-parse so large batches reach the handler", async () => {
  const body = JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ sg_event_id: `p${i}`, event: "delivered", email: "a@origo.is", timestamp: 1 })));
  const res = await proxy(new NextRequest("http://localhost:3000/api/v1/internal/communications/events", {
    method: "POST", headers: { host: "localhost:3000", "content-type": "application/json" }, body,
  }));
  assert.notEqual(res.status, 400, "a 300-item array must not be rejected by the generic JSON gate");
  const generic = await proxy(new NextRequest("http://localhost:3000/api/v1/requests", {
    method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" }, body,
  }));
  assert.equal(generic.status, 400, "other routes keep the 250-item limit");
});
```

- [ ] **Step 6: OpenAPI** — in `scripts/generate-openapi.ts` add a branch before the `/jobs/` check: `route.endsWith("/communications/events") ? "SendGrid Event Webhook signature" : …` for `x-authorization` and `[{ sendgridEventSignature: [] }]` for `security`; register `specification.components.securitySchemes.sendgridEventSignature = { type: "apiKey", in: "header", name: "X-Twilio-Email-Event-Webhook-Signature" }`. Curated entry `receiveSendGridEvents` with request body `{ type: "array", maxItems: 1000, items: { type: "object" } }`. Regenerate.

- [ ] **Step 7: Retention** — in `lib/server/retention-worker.ts` cleanup batch add `DELETE TOP (@limit) FROM dbo.CommunicationEvents WHERE received_at < DATEADD(day,-90,SYSUTCDATETIME()); SET @deleted+=@@ROWCOUNT;`.

- [ ] **Step 8: Run** — `npm test`, `npm run lint`, `npm run openapi:check` → PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/server/communications/event-webhook.ts app/api/v1/internal/communications/events proxy.ts scripts/generate-openapi.ts docs/openapi-base.json public/openapi.json lib/server/retention-worker.ts tests/communications.test.ts tests/communications-routes.test.ts
git commit -m "feat(communications): signature-verified SendGrid event webhook"
```

---

### Task 13: Settings routes, configuration test, production checks and operator docs

**Files:**
- Create: `app/api/v1/admin/communications/settings/route.ts` (GET, PATCH)
- Create: `app/api/v1/admin/communications/settings/test/route.ts` (POST)
- Modify: `lib/server/communications/sendgrid.ts` (append `sendConfigurationTest`)
- Modify: `lib/server/production-config.ts:12-60`
- Modify: `.env.example`, `infra/main.bicep`, `configInfo.md`, `README.md`, `docs/launch-runbook.md`, `docs/production-hardening.md`
- Modify: `scripts/generate-openapi.ts`, `docs/openapi-base.json`
- Test: `tests/communications.test.ts` (extend)

**Interfaces:**
- Produces: `GET/PATCH /api/v1/admin/communications/settings` → `{ item: CommunicationSettings, status: { providerConfigured, webhookConfigured, webhookUrl, effectiveSendingState } }`; `POST …/settings/test` → `{ ok: true, transport: "sendgrid" | "console", providerMessageId }`; `sendConfigurationTest(identity): Promise<{ ok: true; transport: string; providerMessageId: string | null }>` (System admin; bypasses the worker and the `enabled` switch; never bypasses safe mode: the caller's own address must be allow-listed or safe mode off, otherwise `INVALID_SAFE_MODE_BLOCKS_RECIPIENT`).

- [ ] **Step 1: Failing tests**

```ts
import { sendConfigurationTest } from "../lib/server/communications/sendgrid";
import { productionConfigurationErrors } from "../lib/server/production-config";

test("configuration test: System admin only, respects safe mode, uses the console transport without a key", async () => {
  await assert.rejects(sendConfigurationTest(PM), /FORBIDDEN/);
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, fromEmail: "updates@datacentral.ai", safeMode: { enabled: true, allowedDomains: ["datacentral.ai"] } });
  await assert.rejects(sendConfigurationTest(ADMIN), /INVALID_SAFE_MODE_BLOCKS_RECIPIENT/); // bjarki@uidata.com is not allow-listed
  await saveCommunicationSettings(ADMIN, { ...DEFAULT_COMMUNICATION_SETTINGS, fromEmail: "updates@datacentral.ai", safeMode: { enabled: true, allowedDomains: ["uidata.com"] } });
  const result = await sendConfigurationTest(ADMIN);
  assert.equal(result.ok, true);
  assert.equal(result.transport, "console");
  await assert.rejects(sendConfigurationTest(ADMIN, { settingsOverride: { ...DEFAULT_COMMUNICATION_SETTINGS, fromEmail: "" } }), /INVALID_EMAIL_PROVIDER_CONFIGURATION/);
});

test("production config: Key Vault placeholders for SendGrid values are rejected", () => {
  const errors = productionConfigurationErrors({ NODE_ENV: "production", SENDGRID_API_KEY: "@Microsoft.KeyVault(SecretUri=x)", SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: " " });
  assert.ok(errors.includes("SENDGRID_API_KEY"));
  assert.ok(errors.includes("SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY"));
});
```

- [ ] **Step 2: Run** — `npm test` → FAIL.

- [ ] **Step 3: Configuration test** — append to `sendgrid.ts`:

```ts
import type { PulseIdentity } from "@/lib/domain";
import { requireInternalRole } from "../authorization";
import { getRuntimeCommunicationSettings } from "./settings";
import { renderCommunication } from "./templates/index";

export async function sendConfigurationTest(identity: PulseIdentity, options: { settingsOverride?: CommunicationSettings } = {}) {
  await requireInternalRole(identity, ["System admin"]);
  const settings = options.settingsOverride ?? (await getRuntimeCommunicationSettings());
  if (!settings.fromEmail) throw new Error("INVALID_EMAIL_PROVIDER_CONFIGURATION");
  const email = identity.email.toLowerCase();
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (settings.safeMode.enabled && !settings.safeMode.allowedDomains.includes(domain)) throw new Error("INVALID_SAFE_MODE_BLOCKS_RECIPIENT");
  const publicUrl = (process.env.PULSE_PUBLIC_URL || "http://localhost:3000").replace(/\/+$/, "");
  const rendered = renderCommunication("plain", {
    subject: { en: "Pulse communications configuration test" },
    body: { en: { title: "Configuration test", paragraphs: ["This message confirms that Pulse can send customer communications through SendGrid with the current settings.", `Sending state: ${settings.sandboxMode ? "sandbox" : settings.safeMode.enabled ? "safe mode" : "live"}.`] } },
  }, "en", { publicUrl, boilerplate: settings.boilerplate.en, unsubscribeTags: settings.unsubscribeGroupId !== null, testPrefix: true });
  const transport = createMailTransport(settings);
  try {
    const outcome = await transport.sendBatch({
      subject: rendered.subject, html: rendered.html, text: rendered.text,
      recipients: [{ email, name: identity.name, customArgs: { deliveryId: "configuration-test", communicationId: "configuration-test" } }],
      from: { email: settings.fromEmail, name: settings.fromName }, replyTo: settings.replyTo || null,
      categories: [settings.categoriesPrefix, `${settings.categoriesPrefix}-configuration-test`], unsubscribeGroupId: settings.unsubscribeGroupId, tracking: { opens: false, clicks: false }, sandbox: settings.sandboxMode,
    });
    return { ok: true as const, transport: transport.kind, providerMessageId: outcome.providerMessageId };
  } catch (error) {
    const failure = classifySendError(error);
    throw new Error(`INVALID_EMAIL_PROVIDER_${failure.code}`);
  }
}
```

- [ ] **Step 4: Routes** — `settings/route.ts`:

```ts
import { communicationSettingsInputSchema } from "@/lib/contracts";
import { getIdentity } from "@/lib/server/auth";
import { communicationProviderStatus, getCommunicationSettings, saveCommunicationSettings } from "@/lib/server/communications/settings";
import { apiError, correlationId, json } from "@/lib/server/http";
import { readInput } from "@/lib/server/validation";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const item = await getCommunicationSettings(await getIdentity(request));
    return json({ item, status: communicationProviderStatus(item) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
export async function PATCH(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await getIdentity(request);
    const item = await saveCommunicationSettings(identity, await readInput(request, communicationSettingsInputSchema) as never);
    return json({ item, status: communicationProviderStatus(item) }, {}, id);
  } catch (error) {
    return apiError(error, id);
  }
}
```

`settings/test/route.ts`: `POST` → `json(await sendConfigurationTest(await getIdentity(request)), {}, id)`. Add `"PATCH /api/v1/admin/communications/settings": "communicationSettingsInputSchema"` to `schemaNames`; curated operationIds `getCommunicationSettings`, `saveCommunicationSettings`, `sendCommunicationConfigurationTest`. Regenerate.

- [ ] **Step 5: Production config** — in `productionConfigurationErrors` after the provider groups: `if (env.SENDGRID_API_KEY !== undefined) required("SENDGRID_API_KEY", 10); if (env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY !== undefined) required("SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY", 40);` (both optional; when present they must be resolved, non-blank values).

- [ ] **Step 6: Environment and infrastructure**

`.env.example` (after the ACS block):

```text
# SendGrid (customer communications / Communications page). Restricted API key with
# Mail Send only. The Event Webhook verification key comes from SendGrid → Settings →
# Mail Settings → Event Webhook → Signed Event Webhook. Both optional; without the API
# key the console transport logs sends locally and production refuses to send.
SENDGRID_API_KEY=
SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY=
```

`infra/main.bicep`: parameters

```bicep
@description('SendGrid API key (Mail Send permission only) for customer communications. Leave empty to leave communications unconfigured.')
@secure()
param sendgridApiKey string = ''
@description('SendGrid Signed Event Webhook verification key (base64). Not secret; empty disables the webhook.')
param sendgridEventWebhookPublicKey string = ''
```

a conditional Key Vault secret `sendgrid-api-key` mirroring `anthropicApiKeySecret`, and app settings `{ name: 'SENDGRID_API_KEY', value: !empty(sendgridApiKey) ? '@Microsoft.KeyVault(SecretUri=${sendgridApiKeySecret!.properties.secretUriWithVersion})' : '' }` and `{ name: 'SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY', value: sendgridEventWebhookPublicKey }`. Add `sendgridApiKey=<restricted-api-key>` to the README deployment command list as optional.

- [ ] **Step 7: Operator docs**

`configInfo.md` — new section `## 7. SendGrid (customer communications)` with: (1) create a restricted API key with only *Mail Send* → `SENDGRID_API_KEY`; (2) authenticate the sending domain (SPF/DKIM via the SendGrid DNS records at the `datacentral.ai` zone; DMARC alignment) and set the verified address as *From address* in Pulse → Settings → Customer communications; (3) create an Unsubscribe Group (ASM) and enter its numeric id (enables one-click `List-Unsubscribe`); disable SendGrid's own *Subscription tracking* footer to avoid duplicate links; (4) Event Webhook: URL from the Settings card (`…/api/v1/internal/communications/events`), enable *Signed Event Webhook*, copy the verification key → `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY`, select events Processed, Delivered, Deferred, Bounce, Dropped, Open, Click, Spam Report, Unsubscribe, Group Unsubscribe, Group Resubscribe; (5) EU data residency: only if the SendGrid subuser is EU-pinned, set *Data residency: EU*; (6) rollout: keep *Safe mode* on with `datacentral.ai`, run *Send configuration test*, send a real campaign to internal recipients, then switch safe mode off; (7) verification checklist (test mail arrives, webhook shows `delivered` on the campaign, unsubscribe link suppresses the address).

`README.md` — "Customer communications" subsection under "Notification delivery": what it is, the job (`POST /api/v1/internal/jobs/communications` every minute), the env vars, and a pointer to configInfo §7 and the spec. `docs/launch-runbook.md` §5: add the job line and "alert on `Communications · Dead letter` growth in the Settings delivery card". `docs/production-hardening.md` §Configuration bullet 3: add `SENDGRID_API_KEY`/`SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` to "configure all values for each enabled provider".

- [ ] **Step 8: Run** — `npm test`, `npm run lint`, `npm run openapi:check` → PASS.

- [ ] **Step 9: Commit**

```bash
git add app/api/v1/admin/communications lib/server/communications/sendgrid.ts lib/server/production-config.ts .env.example infra/main.bicep configInfo.md README.md docs/launch-runbook.md docs/production-hardening.md scripts/generate-openapi.ts docs/openapi-base.json public/openapi.json tests/communications.test.ts
git commit -m "feat(communications): settings API, configuration test and operator documentation"
```

---

### Task 14: Shell wiring, client types and the Settings card

**Files:**
- Modify: `app/features/shared.tsx` (`Page` union, client types)
- Modify: `app/features/shell.tsx` (page title, nav item, lazy page, render)
- Create: `app/features/communication-settings.tsx`
- Modify: `app/features/settings.tsx` (mount the card)
- Modify: `app/globals.css` (card internals), `lib/i18n-internal.ts`

**Interfaces:**
- Produces client types in `shared.tsx` used by Tasks 15–17:

```ts
export type CommunicationStatus = "Draft" | "Scheduled" | "Sending" | "Sent" | "Cancelled";
export type CommunicationStatsItem = { recipients: number; queued: number; accepted: number; delivered: number; bounced: number; dropped: number; deadLettered: number; suppressed: number; cancelled: number; opened: number; clicked: number; byOrganization: Array<{ organizationId: string; recipients: number; delivered: number; opened: number }> };
export type CommunicationItem = {
  version?: string; id: string; templateKey: "product-update" | "service-notice" | "plain";
  topic: "product-updates" | "service-notices" | "security-advisories" | "general"; title: string;
  content: { subject: { en: string; is?: string }; preheader?: { en?: string; is?: string }; body: { en: Record<string, unknown>; is?: Record<string, unknown> } };
  audience: { organizations: "all-customers" | string[]; includeOnboarding: boolean; includeTestOrganizations: boolean; includeMembers: boolean; memberRoles: Array<"Company admin" | "Requester" | "Viewer"> | null; includeContacts: boolean; includeInternalCopy: boolean };
  status: CommunicationStatus; scheduledAt?: string; startedAt?: string; completedAt?: string; cancelledAt?: string; recipientCount: number; releaseId?: string; createdBy: string; createdAt: string; updatedAt: string;
  stats?: CommunicationStatsItem;
};
export type AudienceBreakdownItem = { organizations: number; members: number; contacts: number; internal: number; suppressed: Record<string, number>; total: number; sendable: number };
export type DeliveryItem = { id: string; organizationId: string | null; email: string; displayName: string | null; locale: "en" | "is"; source: "Member" | "Contact" | "Test"; state: string; suppressedReason?: string | null; attemptCount: number; providerMessageId?: string | null; lastEvent?: string | null; lastEventAt?: string | null; openedAt?: string | null; clickedAt?: string | null; lastErrorCode?: string | null; createdAt: string };
export type ContactItem = { id: string; organizationId: string; userId: string | null; email: string; displayName: string; locale: "en" | "is"; topics: string[]; status: "Active" | "Unsubscribed" | "Bounced"; source: string; note?: string; createdAt: string; updatedAt: string };
export type SuppressionItem = { email: string; reason: string; source: string; note?: string; createdAt: string };
export type CommunicationSettingsItem = { enabled: boolean; fromName: string; fromEmail: string; replyTo: string; dataResidency: "global" | "eu"; unsubscribeGroupId: number | null; sandboxMode: boolean; safeMode: { enabled: boolean; allowedDomains: string[] }; tracking: { opens: boolean; clicks: boolean }; dailyCap: number; maxRecipientsPerCampaign: number; categoriesPrefix: string; boilerplate: Record<"en" | "is", { signOff: string; footer: string; supportEmail: string }> };
export type CommunicationProviderStatus = { providerConfigured: boolean; webhookConfigured: boolean; webhookUrl: string; effectiveSendingState: "disabled" | "provider-missing" | "sandbox" | "safe-mode" | "live" };
export const COMMUNICATION_TOPIC_LABELS: Record<string, string> = { "product-updates": "Product updates", "service-notices": "Service notices", "security-advisories": "Security advisories", general: "General announcements" };
```

- [ ] **Step 1: Types and page** — add `"communications"` to the `Page` union in `shared.tsx` and the types above. In `shell.tsx`: `pageTitles.communications = "Communications"`; lazy import

```tsx
const CommunicationsPage = dynamic(() => import("./communications").then((m) => m.CommunicationsPage), { loading: () => <LoadingFeature /> });
```

nav button after Releases:

```tsx
<button className={`nav-item ${page === "communications" ? "active" : ""}`} onClick={() => navigate("communications")} data-tour="nav-communications">
  <Icon name="send" size={17} />
  <span>{t("Communications")}</span>
</button>
```

and in `<main>`: `{page === "communications" && <CommunicationsPage companies={companies} releases={releases} onToast={setToast} />}` (the `CommunicationsPage` props are defined in Task 15; until Task 15 lands, create the file with a stub export rendering `<PageIntro eyebrow="Customer communication" title="Communications" description="Loading…" />` so the build stays green).

- [ ] **Step 2: Settings card** — `app/features/communication-settings.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { Button, Icon, Status, useT, type CommunicationProviderStatus, type CommunicationSettingsItem } from "./shared";

const STATE_TONE = { disabled: "neutral", "provider-missing": "error", sandbox: "warning", "safe-mode": "warning", live: "success" } as const;

export function CommunicationSettingsCard({ onToast }: { onToast: (message: string) => void }) {
  const t = useT();
  const [settings, setSettings] = useState<CommunicationSettingsItem | null>(null);
  const [status, setStatus] = useState<CommunicationProviderStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [domains, setDomains] = useState("");
  useEffect(() => {
    apiFetch<{ item: CommunicationSettingsItem; status: CommunicationProviderStatus }>("/api/v1/admin/communications/settings")
      .then((data) => { setSettings(data.item); setStatus(data.status); setDomains(data.item.safeMode.allowedDomains.join(", ")); })
      .catch(() => setSettings(null)); // non-System-admins get 404 → card never renders
  }, []);
  if (!settings || !status) return null;
  const update = (patch: Partial<CommunicationSettingsItem>) => setSettings({ ...settings, ...patch });
  async function save() {
    setBusy(true);
    try {
      const body = { ...settings!, safeMode: { ...settings!.safeMode, allowedDomains: domains.split(/[,\s]+/).map((d) => d.trim().toLowerCase()).filter(Boolean) } };
      const data = await apiFetch<{ item: CommunicationSettingsItem; status: CommunicationProviderStatus }>("/api/v1/admin/communications/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      setSettings(data.item); setStatus(data.status);
      onToast(t("Communication settings saved and added to the audit trail."));
    } catch (error) { onToast(errorMessage(error)); } finally { setBusy(false); }
  }
  async function sendTest() {
    setBusy(true);
    try {
      const result = await apiFetch<{ ok: boolean; transport: string }>("/api/v1/admin/communications/settings/test", { method: "POST" });
      onToast(result.transport === "console" ? t("Configuration test logged to the server console (no SendGrid key configured).") : t("Configuration test sent to your address."));
    } catch (error) { onToast(errorMessage(error)); } finally { setBusy(false); }
  }
  return (
    <article className="settings-card communication-settings" data-tour="settings-communications">
      <header>
        <Icon name="send" size={19} />
        <div>
          <h3>{t("Customer communications (SendGrid)")}</h3>
          <p>{t("Broadcast product updates and notices to customer companies. Secrets live in Key Vault; everything else is configured here.")}</p>
        </div>
      </header>
      <div className="communication-status-row">
        <Status tone={status.providerConfigured ? "success" : "error"}>{status.providerConfigured ? "API key configured" : "API key missing"}</Status>
        <Status tone={status.webhookConfigured ? "success" : "warning"}>{status.webhookConfigured ? "Event webhook verified" : "Event webhook key missing"}</Status>
        <Status tone={STATE_TONE[status.effectiveSendingState]}>{`Sending: ${status.effectiveSendingState}`}</Status>
      </div>
      <label className="form-field demo-toggle">
        <input type="checkbox" checked={settings.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
        <span>{t("Enable sending — the worker and the Send action stay disabled until this is on.")}</span>
      </label>
      <div className="form-grid">
        <label className="form-field"><span>{t("From name")}</span><input value={settings.fromName} onChange={(e) => update({ fromName: e.target.value })} /></label>
        <label className="form-field"><span>{t("From address (verified in SendGrid)")}</span><input type="email" value={settings.fromEmail} onChange={(e) => update({ fromEmail: e.target.value })} placeholder="updates@datacentral.ai" /></label>
        <label className="form-field"><span>{t("Reply-to")}</span><input type="email" value={settings.replyTo} onChange={(e) => update({ replyTo: e.target.value })} /></label>
        <label className="form-field"><span>{t("Data residency")}</span>
          <select value={settings.dataResidency} onChange={(e) => update({ dataResidency: e.target.value as "global" | "eu" })}><option value="global">Global</option><option value="eu">EU</option></select></label>
        <label className="form-field"><span>{t("Unsubscribe group id (ASM)")}</span><input type="number" min="1" value={settings.unsubscribeGroupId ?? ""} onChange={(e) => update({ unsubscribeGroupId: e.target.value ? Number(e.target.value) : null })} /></label>
        <label className="form-field"><span>{t("Daily cap")}</span><input type="number" min="1" value={settings.dailyCap} onChange={(e) => update({ dailyCap: Number(e.target.value) })} /></label>
        <label className="form-field"><span>{t("Max recipients per communication")}</span><input type="number" min="1" value={settings.maxRecipientsPerCampaign} onChange={(e) => update({ maxRecipientsPerCampaign: Number(e.target.value) })} /></label>
        <label className="form-field"><span>{t("Category prefix")}</span><input value={settings.categoriesPrefix} onChange={(e) => update({ categoriesPrefix: e.target.value })} /></label>
      </div>
      <label className="form-field demo-toggle"><input type="checkbox" checked={settings.safeMode.enabled} onChange={(e) => update({ safeMode: { ...settings.safeMode, enabled: e.target.checked } })} /><span>{t("Safe mode — only send to the allow-listed domains below; everyone else is recorded as suppressed.")}</span></label>
      <label className="form-field"><span>{t("Allowed domains (comma separated)")}</span><input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="datacentral.ai" /></label>
      <label className="form-field demo-toggle"><input type="checkbox" checked={settings.sandboxMode} onChange={(e) => update({ sandboxMode: e.target.checked })} /><span>{t("Sandbox mode — SendGrid validates requests without delivering.")}</span></label>
      <div className="form-grid">
        <label className="form-field demo-toggle"><input type="checkbox" checked={settings.tracking.opens} onChange={(e) => update({ tracking: { ...settings.tracking, opens: e.target.checked } })} /><span>{t("Track opens")}</span></label>
        <label className="form-field demo-toggle"><input type="checkbox" checked={settings.tracking.clicks} onChange={(e) => update({ tracking: { ...settings.tracking, clicks: e.target.checked } })} /><span>{t("Track clicks")}</span></label>
      </div>
      {(["en", "is"] as const).map((locale) => (
        <fieldset className="communication-boilerplate" key={locale}>
          <legend>{locale === "en" ? t("Boilerplate (English)") : t("Boilerplate (Icelandic)")}</legend>
          <label className="form-field"><span>{t("Sign-off")}</span><textarea rows={2} value={settings.boilerplate[locale].signOff} onChange={(e) => update({ boilerplate: { ...settings.boilerplate, [locale]: { ...settings.boilerplate[locale], signOff: e.target.value } } })} /></label>
          <label className="form-field"><span>{t("Footer line")}</span><input value={settings.boilerplate[locale].footer} onChange={(e) => update({ boilerplate: { ...settings.boilerplate, [locale]: { ...settings.boilerplate[locale], footer: e.target.value } } })} /></label>
          <label className="form-field"><span>{t("Support address")}</span><input type="email" value={settings.boilerplate[locale].supportEmail} onChange={(e) => update({ boilerplate: { ...settings.boilerplate, [locale]: { ...settings.boilerplate[locale], supportEmail: e.target.value } } })} /></label>
        </fieldset>
      ))}
      <p className="communication-webhook-url"><span>{t("Event webhook URL")}</span><code>{status.webhookUrl}</code></p>
      <div className="communication-settings-actions">
        <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save communication settings"}</Button>
        <Button variant="secondary" onClick={sendTest} disabled={busy}>{t("Send configuration test")}</Button>
      </div>
    </article>
  );
}
```

Mount it in `SettingsPage` right after `<DeliveryStatus />`: `<CommunicationSettingsCard onToast={onToast} />`.

- [ ] **Step 3: CSS** — append to `app/globals.css`:

```css
.communication-settings { grid-column: 1 / -1; }
.communication-status-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.communication-boilerplate { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin: 12px 0; display: grid; gap: 10px; }
.communication-boilerplate legend { font-family: var(--font-heading); font-weight: 700; padding: 0 6px; }
.communication-webhook-url { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
.communication-webhook-url code { font-family: var(--font-mono); font-size: 12px; word-break: break-all; color: var(--text); }
.communication-settings-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
```

- [ ] **Step 4: Icelandic** — add to `lib/i18n-internal.ts` (new `Object.assign(internalTranslations, {...})` block): `Communications: "Samskipti"`, `"Customer communications (SendGrid)": "Samskipti við viðskiptavini (SendGrid)"`, `"Enable sending — the worker and the Send action stay disabled until this is on.": "Virkja sendingar — bakgrunnsverkið og Senda-hnappurinn eru óvirk þar til þetta er kveikt."`, `"From name": "Nafn sendanda"`, `"From address (verified in SendGrid)": "Netfang sendanda (staðfest í SendGrid)"`, `"Reply-to": "Svarnetfang"`, `"Data residency": "Gagnasvæði"`, `"Unsubscribe group id (ASM)": "Auðkenni afskráningarhóps (ASM)"`, `"Daily cap": "Hámark á dag"`, `"Max recipients per communication": "Hámarksfjöldi viðtakenda í hverri sendingu"`, `"Category prefix": "Forskeyti flokka"`, `"Safe mode — only send to the allow-listed domains below; everyone else is recorded as suppressed.": "Öruggur hamur — aðeins sent á lénin hér fyrir neðan; aðrir eru skráðir sem útilokaðir."`, `"Allowed domains (comma separated)": "Leyfð lén (aðskilin með kommu)"`, `"Sandbox mode — SendGrid validates requests without delivering.": "Prófunarhamur — SendGrid staðfestir beiðnir án þess að senda."`, `"Track opens": "Mæla opnanir"`, `"Track clicks": "Mæla smelli"`, `"Boilerplate (English)": "Fastur texti (enska)"`, `"Boilerplate (Icelandic)": "Fastur texti (íslenska)"`, `"Sign-off": "Kveðja"`, `"Footer line": "Fótlína"`, `"Support address": "Netfang þjónustu"`, `"Event webhook URL": "Slóð fyrir atburðavefkrók"`, `"Save communication settings": "Vista samskiptastillingar"`, `"Send configuration test": "Senda prófun á uppsetningu"`, `"Communication settings saved and added to the audit trail.": "Samskiptastillingar vistaðar og skráðar í atburðaskrá."`, `"Configuration test sent to your address.": "Prófun send á netfangið þitt."`, `"Configuration test logged to the server console (no SendGrid key configured).": "Prófun skráð í miðlaraskrá (enginn SendGrid-lykill stilltur)."`.

- [ ] **Step 5: Verify** — `npm run typecheck`, `npm run lint`, `npm run build` → PASS. Manually: `npm run dev`, sign in as the seeded admin (memory mode), open Settings → the card renders with "API key missing", save works, "Send configuration test" toasts the console message and the server log shows `communications.console-send` — safe mode blocks `bjarki@uidata.com` unless `uidata.com` is allow-listed (expected per Task 13).

- [ ] **Step 6: Commit**

```bash
git add app/features/shared.tsx app/features/shell.tsx app/features/communication-settings.tsx app/features/communications.tsx app/features/settings.tsx app/globals.css lib/i18n-internal.ts
git commit -m "feat(communications): settings card and navigation"
```

---

### Task 15: Communications page — list and editor

**Files:**
- Create/replace: `app/features/communications.tsx`
- Create: `app/features/communication-editor.tsx`
- Modify: `app/globals.css`, `lib/i18n-internal.ts`

**Interfaces:**
- Consumes: Task 10 routes; `Company`, `ReleaseItem`, `CommunicationItem`, `AudienceBreakdownItem` (Task 14); `mutationHeaders`, `apiFetch`, `errorMessage`.
- Produces: `CommunicationsPage({ companies, releases, onToast })`; `CommunicationEditor({ item, companies, onSaved, onClose, onToast })`; `useCommunicationQueryParam()` reads `?communication=COM-###` from the URL to open an item directly (used by the Releases hand-off in Task 17).

- [ ] **Step 1: Page skeleton** — `app/features/communications.tsx`:

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { Button, EmptyState, Icon, PageIntro, Status, mutationHeaders, useT, type Company, type CommunicationItem, type ReleaseItem } from "./shared";
import { CommunicationEditor } from "./communication-editor";
import { CommunicationDetail } from "./communication-detail";
import { CommunicationContactsTab, SuppressionsTab } from "./communication-contacts";

type Tab = "campaigns" | "contacts" | "suppressions";
const STATUS_TONE = { Draft: "neutral", Scheduled: "warning", Sending: "violet", Sent: "success", Cancelled: "error" } as const;

export function useCommunicationQueryParam() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    const sync = () => setId(new URLSearchParams(window.location.search).get("communication"));
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  return id;
}

export function CommunicationsPage({ companies, releases, onToast }: { companies: Company[]; releases: ReleaseItem[]; onToast: (message: string) => void }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("campaigns");
  const [items, setItems] = useState<CommunicationItem[]>([]);
  const [selected, setSelected] = useState<CommunicationItem | null>(null);
  const [editing, setEditing] = useState<CommunicationItem | null>(null);
  const requested = useCommunicationQueryParam();
  const reload = useCallback(() => apiFetch<{ items: CommunicationItem[] }>("/api/v1/internal/communications").then((d) => setItems(d.items)).catch((e) => onToast(errorMessage(e))), [onToast]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!requested) return;
    apiFetch<{ item: CommunicationItem }>(`/api/v1/internal/communications/${requested}`).then((d) => (d.item.status === "Draft" ? setEditing(d.item) : setSelected(d.item))).catch(() => undefined);
  }, [requested]);
  async function createDraft(templateKey: CommunicationItem["templateKey"]) {
    try {
      const topic = templateKey === "product-update" ? "product-updates" : templateKey === "service-notice" ? "service-notices" : "general";
      const body = {
        templateKey, topic, title: t("Untitled communication"),
        // Placeholders satisfy the content schema's min(1) fields; authors replace them in the editor.
        content: { subject: { en: t("Untitled communication") }, body: { en: templateKey === "plain" ? { title: t("Untitled communication"), paragraphs: [t("Write your announcement here.")] } : templateKey === "service-notice" ? { title: t("Untitled communication"), summary: t("Describe the notice here."), actions: [] } : { title: t("Untitled communication"), intro: t("Write the introduction here."), sections: [{ heading: t("First highlight"), body: t("Describe the change here.") }] } } },
        audience: { organizations: "all-customers", includeOnboarding: false, includeTestOrganizations: false, includeMembers: true, memberRoles: null, includeContacts: true, includeInternalCopy: false },
      };
      const data = await apiFetch<{ item: CommunicationItem }>("/api/v1/internal/communications", { method: "POST", headers: mutationHeaders(), body: JSON.stringify(body) });
      setEditing(data.item);
    } catch (error) { onToast(errorMessage(error)); }
  }
  async function duplicate(item: CommunicationItem) {
    try {
      const data = await apiFetch<{ item: CommunicationItem }>(`/api/v1/internal/communications/${item.id}/duplicate`, { method: "POST", headers: mutationHeaders(false) });
      await reload(); setEditing(data.item);
    } catch (error) { onToast(errorMessage(error)); }
  }
  if (editing) return <CommunicationEditor item={editing} companies={companies} onClose={() => { setEditing(null); void reload(); }} onSaved={(saved) => setEditing(saved)} onToast={onToast} />;
  if (selected) return <CommunicationDetail id={selected.id} companies={companies} onBack={() => { setSelected(null); void reload(); }} onEdit={(item) => { setSelected(null); setEditing(item); }} onDuplicate={duplicate} onToast={onToast} />;
  return (
    <div className="page-stack management-page" data-tour="communications-page">
      <PageIntro eyebrow="Customer communication" title="Communications" description="Compose branded product updates and notices, choose the companies that receive them, and track delivery."
        action={<div className="communication-new"><Button icon="plus" dataTour="communications-new" onClick={() => createDraft("product-update")}>{t("New product update")}</Button><Button variant="secondary" onClick={() => createDraft("service-notice")}>{t("Service notice")}</Button><Button variant="secondary" onClick={() => createDraft("plain")}>{t("Announcement")}</Button></div>} />
      <div className="communication-tabs" role="tablist">
        {(["campaigns", "contacts", "suppressions"] as Tab[]).map((value) => (
          <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{t(value === "campaigns" ? "Campaigns" : value === "contacts" ? "Contacts" : "Suppressions")}</button>
        ))}
      </div>
      {tab === "contacts" && <CommunicationContactsTab companies={companies} onToast={onToast} />}
      {tab === "suppressions" && <SuppressionsTab onToast={onToast} />}
      {tab === "campaigns" && (items.length === 0 ? (
        <EmptyState title="No communications yet" description="Start with a product update, a service notice or a plain announcement." action="New product update" onAction={() => createDraft("product-update")} />
      ) : (
        <div className="management-table communication-table">
          <div className="management-head"><span>{t("Communication")}</span><span>{t("Template")}</span><span>{t("Status")}</span><span>{t("Recipients")}</span><span>{t("Sent")}</span><span /></div>
          {items.map((item) => (
            <div className="management-row" key={item.id}>
              <span className="record-name"><span><strong>{item.title}</strong><code>{item.id}{item.releaseId ? ` · ${item.releaseId}` : ""}</code></span></span>
              <span>{item.templateKey}</span>
              <Status tone={STATUS_TONE[item.status]}>{item.status}</Status>
              <span>{item.status === "Draft" ? "—" : item.recipientCount}</span>
              <span>{item.completedAt ? item.completedAt.slice(0, 16).replace("T", " ") : item.scheduledAt ? `${t("Scheduled")} ${item.scheduledAt.slice(0, 16).replace("T", " ")}` : "—"}</span>
              <span className="communication-row-actions">
                <Button variant="secondary" onClick={() => (item.status === "Draft" ? setEditing(item) : setSelected(item))}>{item.status === "Draft" ? t("Edit") : t("Open")}</Button>
                <Button variant="ghost" onClick={() => duplicate(item)}>{t("Duplicate")}</Button>
              </span>
            </div>
          ))}
        </div>
      ))}
      <p className="communication-release-hint">{releases.some((r) => r.published) ? t("Tip: published releases offer “Draft customer email” on the Releases page.") : ""}</p>
    </div>
  );
}
```

- [ ] **Step 2: Editor** — `app/features/communication-editor.tsx` (content step for the product update shown in full; service notice and plain forms follow the same `Field` pattern with the fields listed below):

```tsx
"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { Button, Icon, Status, mutationHeaders, useT, type AudienceBreakdownItem, type Company, type CommunicationItem, COMMUNICATION_TOPIC_LABELS } from "./shared";

type Step = "content" | "audience" | "review";
type Locale = "en" | "is";
type Section = { heading: string; body: string; callout?: { tone: "warning" | "info"; label?: string; text: string }; link?: { label: string; url: string } };

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const t = useT();
  return <label className="form-field"><span>{t(label)}{hint && <em>{t(hint)}</em>}</span>{children}</label>;
}

export function CommunicationEditor({ item, companies, onSaved, onClose, onToast }: { item: CommunicationItem; companies: Company[]; onSaved: (item: CommunicationItem) => void; onClose: () => void; onToast: (message: string) => void }) {
  const t = useT();
  const [draft, setDraft] = useState<CommunicationItem>(item);
  const [locale, setLocale] = useState<Locale>("en");
  const [step, setStep] = useState<Step>("content");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [estimate, setEstimate] = useState<AudienceBreakdownItem | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  const [scheduleAt, setScheduleAt] = useState("");
  const [confirm, setConfirm] = useState(false);
  const body = (draft.content.body[locale] ?? draft.content.body.en) as Record<string, unknown>;
  const patch = (next: Partial<CommunicationItem>) => { setDraft({ ...draft, ...next }); setDirty(true); };
  const patchBody = (next: Record<string, unknown>) => patch({ content: { ...draft.content, body: { ...draft.content.body, [locale]: { ...body, ...next } } } });
  const patchSubject = (value: string) => patch({ content: { ...draft.content, subject: { ...draft.content.subject, [locale]: value } } });

  async function save(): Promise<CommunicationItem | null> {
    setBusy(true);
    try {
      const { templateKey, topic, title, content, audience } = draft;
      const data = await apiFetch<{ item: CommunicationItem }>(`/api/v1/internal/communications/${draft.id}`, { method: "PATCH", headers: mutationHeaders(true, draft.version), body: JSON.stringify({ templateKey, topic, title, content, audience }) });
      setDraft(data.item); setDirty(false); onSaved(data.item); setPreviewKey((k) => k + 1);
      return data.item;
    } catch (error) { onToast(errorMessage(error)); return null; } finally { setBusy(false); }
  }
  useEffect(() => {
    if (step !== "audience" && step !== "review") return;
    apiFetch<{ item: AudienceBreakdownItem }>(`/api/v1/internal/communications/${draft.id}/audience`).then((d) => setEstimate(d.item)).catch((e) => onToast(errorMessage(e)));
  }, [step, draft.id, draft.audience, onToast]);
  async function goTo(next: Step) { if (dirty && !(await save())) return; setStep(next); }
  async function sendTest() {
    if (dirty && !(await save())) return;
    try { const r = await apiFetch<{ queued: number }>(`/api/v1/internal/communications/${draft.id}/test`, { method: "POST", headers: mutationHeaders(), body: JSON.stringify({ extraRecipients: [] }) }); onToast(`${t("Test queued for")} ${r.queued} ${t("recipient(s)")}.`); }
    catch (error) { onToast(errorMessage(error)); }
  }
  async function send() {
    const saved = dirty ? await save() : draft;
    if (!saved) return;
    setBusy(true);
    try {
      const data = await apiFetch<{ item: CommunicationItem }>(`/api/v1/internal/communications/${saved.id}/send`, { method: "POST", headers: mutationHeaders(true, saved.version), body: JSON.stringify(scheduleAt ? { scheduledAt: new Date(scheduleAt).toISOString() } : {}) });
      onToast(data.item.status === "Scheduled" ? t("Communication scheduled.") : `${t("Sending to")} ${data.item.recipientCount} ${t("recipients")}.`);
      onClose();
    } catch (error) { onToast(errorMessage(error)); } finally { setBusy(false); setConfirm(false); }
  }
  const customers = useMemo(() => companies.filter((c) => c.type !== "Internal"), [companies]);
  const selectedIds = draft.audience.organizations === "all-customers" ? null : draft.audience.organizations;
  const sections = ((body.sections as Section[]) ?? []);

  return (
    <div className="page-stack management-page communication-editor" data-tour="communications-editor">
      <header className="communication-editor-head">
        <button className="icon-button" onClick={onClose} aria-label={t("Back to communications")}><Icon name="chevron" /></button>
        <div>
          <p className="eyebrow">{draft.id} · {draft.templateKey} · {COMMUNICATION_TOPIC_LABELS[draft.topic]}</p>
          <input className="communication-title" value={draft.title} onChange={(e) => patch({ title: e.target.value })} aria-label={t("Working title")} />
        </div>
        <div className="communication-editor-actions">
          <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)} aria-label={t("Content language")}><option value="en">English</option><option value="is">Íslenska</option></select>
          {locale === "is" && !draft.content.body.is && <Button variant="ghost" onClick={() => patch({ content: { ...draft.content, subject: { ...draft.content.subject, is: draft.content.subject.en }, body: { ...draft.content.body, is: structuredClone(draft.content.body.en) } } })}>{t("Copy from English")}</Button>}
          <Button variant="secondary" onClick={save} disabled={busy || !dirty}>{dirty ? "Save draft" : "Saved"}</Button>
        </div>
      </header>
      <nav className="communication-steps" aria-label={t("Editor steps")}>
        {(["content", "audience", "review"] as Step[]).map((s, i) => <button key={s} className={step === s ? "active" : ""} onClick={() => goTo(s)}>{i + 1}. {t(s === "content" ? "Content" : s === "audience" ? "Audience" : "Review & send")}</button>)}
      </nav>
      <div className="communication-editor-grid">
        <section className="communication-form">
          {step === "content" && (
            <>
              <Field label="Subject" hint="Required"><input value={draft.content.subject[locale] ?? ""} onChange={(e) => patchSubject(e.target.value)} /></Field>
              <Field label="Topic"><select value={draft.topic} onChange={(e) => patch({ topic: e.target.value as CommunicationItem["topic"] })}>{Object.entries(COMMUNICATION_TOPIC_LABELS).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</select></Field>
              {draft.templateKey === "product-update" && (
                <>
                  <Field label="Eyebrow"><input value={(body.eyebrow as string) ?? ""} placeholder={t("Product update")} onChange={(e) => patchBody({ eyebrow: e.target.value || undefined })} /></Field>
                  <Field label="Title" hint="Required"><input value={(body.title as string) ?? ""} onChange={(e) => patchBody({ title: e.target.value })} /></Field>
                  <Field label="Subtitle"><input value={(body.subtitle as string) ?? ""} onChange={(e) => patchBody({ subtitle: e.target.value || undefined })} /></Field>
                  <Field label="Introduction" hint="Required"><textarea rows={4} value={(body.intro as string) ?? ""} onChange={(e) => patchBody({ intro: e.target.value })} /></Field>
                  <fieldset className="communication-sections"><legend>{t("Highlights")}</legend>
                    {sections.map((section, index) => (
                      <div className="communication-section" key={index}>
                        <Field label="Heading" hint="Required"><input value={section.heading} onChange={(e) => patchBody({ sections: sections.map((s, i) => i === index ? { ...s, heading: e.target.value } : s) })} /></Field>
                        <Field label="Text" hint="**bold** and [label](https://…) are supported"><textarea rows={4} value={section.body} onChange={(e) => patchBody({ sections: sections.map((s, i) => i === index ? { ...s, body: e.target.value } : s) })} /></Field>
                        <div className="form-grid">
                          <Field label="Callout"><select value={section.callout?.tone ?? ""} onChange={(e) => patchBody({ sections: sections.map((s, i) => i === index ? { ...s, callout: e.target.value ? { tone: e.target.value as "warning" | "info", label: s.callout?.label, text: s.callout?.text ?? "" } : undefined } : s) })}><option value="">{t("None")}</option><option value="warning">{t("Action required (amber)")}</option><option value="info">{t("Note (violet)")}</option></select></Field>
                          {section.callout && <><Field label="Callout label"><input value={section.callout.label ?? ""} onChange={(e) => patchBody({ sections: sections.map((s, i) => i === index ? { ...s, callout: { ...s.callout!, label: e.target.value || undefined } } : s) })} /></Field><Field label="Callout text" hint="Required"><textarea rows={2} value={section.callout.text} onChange={(e) => patchBody({ sections: sections.map((s, i) => i === index ? { ...s, callout: { ...s.callout!, text: e.target.value } } : s) })} /></Field></>}
                          <Field label="Link label"><input value={section.link?.label ?? ""} onChange={(e) => patchBody({ sections: sections.map((s, i) => i === index ? { ...s, link: e.target.value || s.link?.url ? { label: e.target.value, url: s.link?.url ?? "" } : undefined } : s) })} /></Field>
                          <Field label="Link URL (https)"><input type="url" value={section.link?.url ?? ""} onChange={(e) => patchBody({ sections: sections.map((s, i) => i === index ? { ...s, link: e.target.value || s.link?.label ? { label: s.link?.label ?? "", url: e.target.value } : undefined } : s) })} /></Field>
                        </div>
                        <Button variant="ghost" onClick={() => patchBody({ sections: sections.filter((_, i) => i !== index) })} disabled={sections.length <= 1}>{t("Remove highlight")}</Button>
                      </div>
                    ))}
                    <Button variant="secondary" icon="plus" onClick={() => patchBody({ sections: [...sections, { heading: "", body: "" }] })} disabled={sections.length >= 8}>{t("Add highlight")}</Button>
                  </fieldset>
                  <Field label="Note (violet box)"><textarea rows={2} value={(body.note as string) ?? ""} onChange={(e) => patchBody({ note: e.target.value || undefined })} /></Field>
                  <div className="form-grid">
                    <Field label="Button label"><input value={(body.cta as { label?: string })?.label ?? ""} onChange={(e) => patchBody({ cta: e.target.value || (body.cta as { url?: string })?.url ? { label: e.target.value, url: (body.cta as { url?: string })?.url ?? "" } : undefined })} /></Field>
                    <Field label="Button URL (https)"><input type="url" value={(body.cta as { url?: string })?.url ?? ""} onChange={(e) => patchBody({ cta: e.target.value || (body.cta as { label?: string })?.label ? { label: (body.cta as { label?: string })?.label ?? "", url: e.target.value } : undefined })} /></Field>
                  </div>
                  <Field label="Sign-off (leave empty for the default)"><input value={(body.signOff as string) ?? ""} onChange={(e) => patchBody({ signOff: e.target.value || undefined })} /></Field>
                </>
              )}
              {draft.templateKey === "service-notice" && <ServiceNoticeFields body={body} patchBody={patchBody} />}
              {draft.templateKey === "plain" && <PlainFields body={body} patchBody={patchBody} />}
            </>
          )}
          {step === "audience" && (
            <>
              <fieldset className="membership-editor"><legend>{t("Companies")}</legend>
                <label><input type="radio" checked={selectedIds === null} onChange={() => patch({ audience: { ...draft.audience, organizations: "all-customers" } })} /> {t("All customer and partner companies")}</label>
                <label><input type="radio" checked={selectedIds !== null} onChange={() => patch({ audience: { ...draft.audience, organizations: [] } })} /> {t("Selected companies")}</label>
                {selectedIds !== null && customers.map((c) => (
                  <div key={c.id} className={selectedIds.includes(c.id) ? "selected" : ""}><label><input type="checkbox" checked={selectedIds.includes(c.id)} onChange={() => patch({ audience: { ...draft.audience, organizations: selectedIds.includes(c.id) ? selectedIds.filter((id) => id !== c.id) : [...selectedIds, c.id] } })} /><span><strong>{c.name}</strong><small>{c.status} · {c.type}</small></span></label></div>
                ))}
              </fieldset>
              {([["includeMembers", "Active Pulse members of those companies (respecting their preferences)"], ["includeContacts", "Communication contacts subscribed to this topic"], ["includeOnboarding", "Include companies still onboarding"], ["includeTestOrganizations", "Include test companies"], ["includeInternalCopy", "Send a copy to the DataCentral team"]] as const).map(([key, label]) => (
                <label className="form-field demo-toggle" key={key}><input type="checkbox" checked={draft.audience[key]} onChange={(e) => patch({ audience: { ...draft.audience, [key]: e.target.checked } })} /><span>{t(label)}</span></label>
              ))}
              <Field label="Member roles"><select value={draft.audience.memberRoles?.join(",") ?? ""} onChange={(e) => patch({ audience: { ...draft.audience, memberRoles: e.target.value ? (e.target.value.split(",") as Array<"Company admin" | "Requester" | "Viewer">) : null } })}><option value="">{t("All roles")}</option><option value="Company admin">{t("Company admins only")}</option><option value="Company admin,Requester">{t("Company admins and requesters")}</option></select></Field>
              {estimate && <AudienceSummary estimate={estimate} />}
            </>
          )}
          {step === "review" && (
            <>
              <dl className="communication-review">
                <dt>{t("Subject (English)")}</dt><dd>{draft.content.subject.en || "—"}</dd>
                <dt>{t("Subject (Icelandic)")}</dt><dd>{draft.content.subject.is || t("falls back to English")}</dd>
                <dt>{t("Template · topic")}</dt><dd>{draft.templateKey} · {COMMUNICATION_TOPIC_LABELS[draft.topic]}</dd>
              </dl>
              {estimate && <AudienceSummary estimate={estimate} />}
              <SendingStateNotice />
              <Field label="Schedule (optional, your local time)"><input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} /></Field>
              <div className="communication-settings-actions">
                <Button variant="secondary" onClick={sendTest} disabled={busy}>{t("Send test to me")}</Button>
                <Button onClick={() => setConfirm(true)} disabled={busy || !estimate || estimate.sendable === 0} dataTour="communications-send">{scheduleAt ? t("Schedule") : t("Send now")}</Button>
              </div>
            </>
          )}
        </section>
        <aside className="communication-preview">
          <div className="communication-preview-head"><strong>{t("Preview")}</strong>{dirty && <small>{t("Save the draft to refresh the preview.")}</small>}</div>
          <iframe key={`${previewKey}:${locale}`} title={t("Email preview")} sandbox="" src={`/api/v1/internal/communications/${draft.id}/preview?locale=${locale}`} />
        </aside>
      </div>
      {confirm && estimate && (
        <div className="modal-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirm(false); }}>
          <section className="management-modal" role="dialog" aria-modal="true" aria-labelledby="communication-confirm-title">
            <header><div><p className="eyebrow">{t("Confirm")}</p><h2 id="communication-confirm-title">{scheduleAt ? t("Schedule this communication?") : t("Send this communication now?")}</h2><p>{estimate.sendable} {t("recipients across")} {estimate.organizations} {t("companies")}. {Object.entries(estimate.suppressed).map(([k, v]) => `${v} ${k}`).join(", ")}</p></div><button className="icon-button" onClick={() => setConfirm(false)}><Icon name="x" /></button></header>
            <SendingStateNotice />
            <footer><span>{t("Content and audience are frozen once sent.")}</span><div><Button variant="secondary" onClick={() => setConfirm(false)}>{t("Cancel")}</Button><Button icon="send" onClick={send} disabled={busy}>{scheduleAt ? t("Schedule") : t("Send")}</Button></div></footer>
          </section>
        </div>
      )}
    </div>
  );
}

function AudienceSummary({ estimate }: { estimate: AudienceBreakdownItem }) {
  const t = useT();
  return (
    <section className="admin-metric-grid communication-audience">
      <div><span>{t("Companies")}</span><strong>{estimate.organizations}</strong></div>
      <div><span>{t("Members")}</span><strong>{estimate.members}</strong></div>
      <div><span>{t("Contacts")}</span><strong>{estimate.contacts}</strong></div>
      <div><span>{t("Will receive")}</span><strong>{estimate.sendable}</strong><small>{Object.entries(estimate.suppressed).map(([k, v]) => `${v} ${k}`).join(" · ") || t("nothing suppressed")}</small></div>
    </section>
  );
}

function SendingStateNotice() {
  const t = useT();
  const [state, setState] = useState<string | null>(null);
  useEffect(() => { apiFetch<{ status: { effectiveSendingState: string } }>("/api/v1/admin/communications/settings").then((d) => setState(d.status.effectiveSendingState)).catch(() => setState(null)); }, []);
  if (!state || state === "live") return null;
  return <p className="form-error" role="status">{t(state === "disabled" ? "Sending is disabled in Settings." : state === "provider-missing" ? "No SendGrid API key is configured." : state === "sandbox" ? "Sandbox mode: SendGrid will validate but not deliver." : "Safe mode: only allow-listed domains receive this communication.")}</p>;
}

function ServiceNoticeFields({ body, patchBody }: { body: Record<string, unknown>; patchBody: (next: Record<string, unknown>) => void }) { /* fields: title (required), summary (required, textarea), window startsAt / endsAt / timezone (three inputs, all-or-nothing), impact (textarea), actions (one input per line via textarea split on newlines), link label + link URL, contact, signOff */ … }
function PlainFields({ body, patchBody }: { body: Record<string, unknown>; patchBody: (next: Record<string, unknown>) => void }) { /* fields: title (required), paragraphs (textarea split on blank lines, min 1), button label + URL, signOff */ … }
```

Implement `ServiceNoticeFields` and `PlainFields` with the exact field lists in their comments using the same `Field` + `patchBody` calls as the product-update form (`patchBody({ actions: value.split("\n").map((s) => s.trim()).filter(Boolean) })`, `patchBody({ paragraphs: value.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean) })`). Non-System-admins get a 404 from the settings endpoint, so `SendingStateNotice` renders nothing for Product managers; the server still refuses with `INVALID_COMMUNICATIONS_DISABLED` and the toast explains.

- [ ] **Step 3: CSS**

```css
.communication-new { display: flex; flex-wrap: wrap; gap: 8px; }
.communication-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); }
.communication-tabs button { padding: 10px 14px; border: 0; background: none; font-family: var(--font-heading); font-weight: 700; color: var(--muted); border-bottom: 2px solid transparent; cursor: pointer; }
.communication-tabs button.active { color: var(--violet-700); border-bottom-color: var(--violet-600); }
.communication-table .management-head, .communication-table .management-row { grid-template-columns: minmax(220px, 2fr) 1fr 1fr 0.8fr 1.2fr auto; }
.communication-row-actions { display: flex; gap: 6px; }
.communication-release-hint { color: var(--muted); font-size: 13px; }
.communication-editor-head { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; }
.communication-title { font-family: var(--font-heading); font-size: 20px; font-weight: 700; border: 0; border-bottom: 1px dashed var(--border-strong); background: none; width: 100%; }
.communication-editor-actions { display: flex; gap: 8px; align-items: center; }
.communication-steps { display: flex; gap: 6px; }
.communication-steps button { padding: 8px 12px; border: 1px solid var(--border); border-radius: 999px; background: #fff; cursor: pointer; }
.communication-steps button.active { border-color: var(--violet-600); color: var(--violet-700); background: var(--violet-50); }
.communication-editor-grid { display: grid; gap: 20px; grid-template-columns: 1fr; }
@media (min-width: 1100px) { .communication-editor-grid { grid-template-columns: minmax(0, 1fr) minmax(360px, 480px); align-items: start; } }
.communication-form { display: grid; gap: 12px; }
.communication-sections { display: grid; gap: 12px; border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
.communication-section { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--neutral-100); border-radius: 8px; background: var(--neutral-50); }
.communication-preview { position: sticky; top: 12px; border: 1px solid var(--border); border-radius: 8px; background: #fff; overflow: hidden; }
.communication-preview-head { display: flex; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.communication-preview iframe { width: 100%; height: 480px; border: 0; background: var(--neutral-50); }
.communication-review { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
.communication-review dt { color: var(--muted); }
.communication-audience small { display: block; color: var(--muted); }
```

The preview iframe keeps its own scroll at 480 px so the editor fits the ~600 px DataCentral embed height; `sandbox=""` disables scripts and forms inside the preview.

- [ ] **Step 4: Icelandic** — add the editor/list strings to `lib/i18n-internal.ts` (every `t("…")` literal introduced above: "Campaigns"→"Herferðir", "Contacts"→"Tengiliðir", "Suppressions"→"Útilokanir", "New product update"→"Ný vöruuppfærsla", "Service notice"→"Þjónustutilkynning", "Announcement"→"Tilkynning", "Content"→"Efni", "Audience"→"Viðtakendur", "Review & send"→"Yfirfara og senda", "Subject"→"Efnislína", "Topic"→"Efnisflokkur", "Highlights"→"Helstu atriði", "Add highlight"→"Bæta við atriði", "Remove highlight"→"Fjarlægja atriði", "Send test to me"→"Senda prófun á mig", "Send now"→"Senda núna", "Schedule"→"Tímasetja", "Preview"→"Forskoðun", "Will receive"→"Fá sendingu", "Companies"→"Fyrirtæki", "Members"→"Meðlimir", "Save draft"→"Vista drög", "Saved"→"Vistað", "Copy from English"→"Afrita úr ensku", "Content and audience are frozen once sent."→"Efni og viðtakendur eru læst eftir sendingu.", plus the toggle labels and notices).

- [ ] **Step 5: Verify** — `npm run typecheck`, `npm run lint`, `npm run build` → PASS. Manual (memory mode): create a product update, fill the DataCentral 3.0.0 content from the spec screenshot, save, switch locale to Icelandic and "Copy from English", watch the preview update, open Audience (estimate shows the seeded Origo member), Review → "Send test to me" (console transport logs), enable sending in Settings with safe mode allow-listing `uidata.com`, "Send now" → list shows Sent with recipients.

- [ ] **Step 6: Commit**

```bash
git add app/features/communications.tsx app/features/communication-editor.tsx app/globals.css lib/i18n-internal.ts
git commit -m "feat(communications): communications page with campaign editor and live preview"
```

---

### Task 16: Campaign detail, contacts tab and suppressions tab

**Files:**
- Create: `app/features/communication-detail.tsx`
- Create: `app/features/communication-contacts.tsx`
- Modify: `app/globals.css`, `lib/i18n-internal.ts`

**Interfaces:**
- Produces: `CommunicationDetail({ id, companies, onBack, onEdit, onDuplicate, onToast })`, `CommunicationContactsTab({ companies, onToast })`, `SuppressionsTab({ onToast })` (imported by Task 15's page).

- [ ] **Step 1: Detail view** — `app/features/communication-detail.tsx`:

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { useResource } from "./use-resource";
import { Button, Icon, Status, mutationHeaders, useT, type Company, type CommunicationItem, type DeliveryItem } from "./shared";

const DELIVERY_TONE: Record<string, "success" | "warning" | "neutral" | "violet" | "error"> = { Delivered: "success", Accepted: "violet", Deferred: "warning", Queued: "neutral", Retry: "warning", Processing: "violet", Bounced: "error", Dropped: "error", "Dead letter": "error", Suppressed: "neutral", Cancelled: "neutral" };

export function CommunicationDetail({ id, companies, onBack, onEdit, onDuplicate, onToast }: { id: string; companies: Company[]; onBack: () => void; onEdit: (item: CommunicationItem) => void; onDuplicate: (item: CommunicationItem) => void; onToast: (message: string) => void }) {
  const t = useT();
  const [state, setState] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [page, setPage] = useState(1);
  const item = useResource<{ item: CommunicationItem }>(`/api/v1/internal/communications/${id}`, 15000);
  const deliveries = useResource<{ items: DeliveryItem[]; total: number }>(`/api/v1/internal/communications/${id}/deliveries?page=${page}&pageSize=100${state ? `&state=${encodeURIComponent(state)}` : ""}${organizationId ? `&organizationId=${encodeURIComponent(organizationId)}` : ""}`, 15000);
  const name = useCallback((orgId: string | null) => companies.find((c) => c.id === orgId)?.name ?? orgId ?? "—", [companies]);
  async function act(path: string, body?: unknown, version?: string) {
    try {
      await apiFetch(`/api/v1/internal/communications/${id}/${path}`, { method: "POST", headers: mutationHeaders(Boolean(body), version), body: body ? JSON.stringify(body) : undefined });
      item.retry(); deliveries.retry();
    } catch (error) { onToast(errorMessage(error)); }
  }
  const record = item.data?.item;
  const stats = record?.stats;
  useEffect(() => { setPage(1); }, [state, organizationId]);
  if (!record) return <p role="status">{item.error || t("Loading…")}</p>;
  return (
    <div className="page-stack management-page" data-tour="communications-detail">
      <header className="communication-editor-head">
        <button className="icon-button" onClick={onBack} aria-label={t("Back to communications")}><Icon name="chevron" /></button>
        <div><p className="eyebrow">{record.id} · {record.templateKey} · {record.createdBy}</p><h2>{record.title}</h2></div>
        <div className="communication-editor-actions">
          <Status tone={record.status === "Sent" ? "success" : record.status === "Cancelled" ? "error" : "warning"}>{record.status}</Status>
          {record.status === "Draft" && <Button onClick={() => onEdit(record)}>{t("Edit")}</Button>}
          {["Scheduled", "Sending"].includes(record.status) && <Button variant="secondary" onClick={() => act("cancel", { mode: record.status === "Scheduled" ? "unschedule" : "cancel" }, record.version)}>{record.status === "Scheduled" ? t("Unschedule") : t("Cancel sending")}</Button>}
          {stats && stats.deadLettered > 0 && <Button variant="secondary" onClick={() => act("deliveries/retry")}>{t("Retry dead letters")}</Button>}
          <Button variant="ghost" onClick={() => onDuplicate(record)}>{t("Duplicate")}</Button>
        </div>
      </header>
      {stats && (
        <section className="admin-metric-grid communication-stats">
          {([["Recipients", stats.recipients], ["Queued", stats.queued], ["Accepted", stats.accepted], ["Delivered", stats.delivered], ["Opened", stats.opened], ["Clicked", stats.clicked], ["Bounced", stats.bounced + stats.dropped], ["Dead letter", stats.deadLettered], ["Suppressed", stats.suppressed]] as const).map(([label, value]) => (
            <div key={label}><span>{t(label)}</span><strong>{value}</strong></div>
          ))}
        </section>
      )}
      {stats && stats.byOrganization.length > 0 && (
        <div className="management-table communication-org-table">
          <div className="management-head"><span>{t("Company")}</span><span>{t("Recipients")}</span><span>{t("Delivered")}</span><span>{t("Opened")}</span></div>
          {stats.byOrganization.map((row) => <div className="management-row" key={row.organizationId}><span>{name(row.organizationId)}</span><span>{row.recipients}</span><span>{row.delivered}</span><span>{row.opened}</span></div>)}
        </div>
      )}
      <div className="management-toolbar">
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label={t("Filter by state")}><option value="">{t("All states")}</option>{Object.keys(DELIVERY_TONE).map((s) => <option key={s} value={s}>{t(s)}</option>)}</select>
        <select value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} aria-label={t("Filter by company")}><option value="">{t("All companies")}</option>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <span>{deliveries.data?.total ?? 0} {t("recipients")}</span>
      </div>
      <div className="management-table communication-delivery-table">
        <div className="management-head"><span>{t("Recipient")}</span><span>{t("Company")}</span><span>{t("Source")}</span><span>{t("State")}</span><span>{t("Last event")}</span><span>{t("Opened")}</span></div>
        {(deliveries.data?.items ?? []).map((d) => (
          <div className="management-row" key={d.id}>
            <span className="record-name"><span><strong>{d.displayName || d.email}</strong><code>{d.email}</code></span></span>
            <span>{name(d.organizationId)}</span><span>{d.source}</span>
            <Status tone={DELIVERY_TONE[d.state] ?? "neutral"}>{d.suppressedReason ? `${d.state} · ${d.suppressedReason}` : d.lastErrorCode ? `${d.state} · ${d.lastErrorCode}` : d.state}</Status>
            <span>{d.lastEvent ? `${d.lastEvent} ${d.lastEventAt?.slice(0, 16).replace("T", " ") ?? ""}` : "—"}</span>
            <span>{d.openedAt ? d.openedAt.slice(0, 16).replace("T", " ") : "—"}</span>
          </div>
        ))}
      </div>
      {(deliveries.data?.total ?? 0) > 100 && <div className="communication-settings-actions"><Button variant="secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>{t("Previous")}</Button><Button variant="secondary" onClick={() => setPage((p) => p + 1)} disabled={page * 100 >= (deliveries.data?.total ?? 0)}>{t("Next")}</Button></div>}
    </div>
  );
}
```

- [ ] **Step 2: Contacts and suppressions tabs** — `app/features/communication-contacts.tsx`:

```tsx
"use client";
import { FormEvent, useEffect, useState } from "react";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { Button, Icon, Status, useT, type Company, type ContactItem, type SuppressionItem, COMMUNICATION_TOPIC_LABELS } from "./shared";

const TOPICS = Object.keys(COMMUNICATION_TOPIC_LABELS);

export function CommunicationContactsTab({ companies, onToast }: { companies: Company[]; onToast: (message: string) => void }) {
  const t = useT();
  const [organizationId, setOrganizationId] = useState(companies.find((c) => c.type !== "Internal")?.id ?? "");
  const [items, setItems] = useState<ContactItem[]>([]);
  const [editing, setEditing] = useState<ContactItem | "new" | "import" | null>(null);
  const load = () => organizationId && apiFetch<{ items: ContactItem[] }>(`/api/v1/internal/communications/contacts?organizationId=${encodeURIComponent(organizationId)}`).then((d) => setItems(d.items)).catch((e) => onToast(errorMessage(e)));
  useEffect(() => { void load(); }, [organizationId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function remove(contact: ContactItem) {
    if (!window.confirm(`${t("Remove")} ${contact.email}?`)) return;
    try { await apiFetch(`/api/v1/internal/communications/contacts/${contact.id}`, { method: "DELETE" }); onToast(t("Contact removed.")); void load(); } catch (error) { onToast(errorMessage(error)); }
  }
  return (
    <section className="page-stack" data-tour="communications-contacts">
      <div className="management-toolbar">
        <label className="select-wrap"><Icon name="building" size={15} /><select value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}>{companies.filter((c) => c.type !== "Internal").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <span>{items.length} {t("contacts")}</span>
        <Button variant="secondary" icon="plus" onClick={() => setEditing("new")}>{t("Add contact")}</Button>
        <Button variant="ghost" onClick={() => setEditing("import")}>{t("Paste list")}</Button>
      </div>
      <p className="communication-release-hint">{t("Pulse members of this company receive communications automatically and manage their own preferences; add people here who are not Pulse users.")}</p>
      <div className="management-table contact-table">
        <div className="management-head"><span>{t("Contact")}</span><span>{t("Language")}</span><span>{t("Topics")}</span><span>{t("Status")}</span><span>{t("Source")}</span><span /></div>
        {items.map((c) => (
          <div className="management-row" key={c.id}>
            <span className="record-name"><span><strong>{c.displayName}</strong><code>{c.email}</code></span></span>
            <span>{c.locale === "is" ? "Íslenska" : "English"}</span>
            <span className="membership-tags">{c.topics.map((topic) => <span key={topic}>{t(COMMUNICATION_TOPIC_LABELS[topic] ?? topic)}</span>)}</span>
            <Status tone={c.status === "Active" ? "success" : "error"}>{c.status}</Status>
            <span>{c.source}</span>
            <span className="communication-row-actions"><Button variant="secondary" onClick={() => setEditing(c)}>{t("Edit")}</Button><Button variant="ghost" onClick={() => remove(c)}>{t("Remove")}</Button></span>
          </div>
        ))}
      </div>
      {editing === "import" && <ContactImportDialog endpoint="/api/v1/internal/communications/contacts" organizationId={organizationId} onClose={() => { setEditing(null); void load(); }} onToast={onToast} />}
      {editing && editing !== "import" && <ContactEditor contact={editing === "new" ? undefined : editing} endpoint="/api/v1/internal/communications/contacts" organizationId={organizationId} onClose={() => { setEditing(null); void load(); }} onToast={onToast} />}
    </section>
  );
}

/** Shared by the internal tab and the customer section (Task 17): `endpoint` differs, the body shape is the same except organizationId. */
export function ContactEditor({ contact, endpoint, organizationId, onClose, onToast }: { contact?: ContactItem; endpoint: string; organizationId?: string; onClose: () => void; onToast: (message: string) => void }) {
  const t = useT();
  const [displayName, setDisplayName] = useState(contact?.displayName ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [locale, setLocale] = useState<"en" | "is">(contact?.locale ?? "en");
  const [topics, setTopics] = useState<string[]>(contact?.topics ?? ["product-updates", "service-notices"]);
  const [note, setNote] = useState(contact?.note ?? "");
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await apiFetch(contact ? `${endpoint}/${contact.id}` : endpoint, { method: contact ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(organizationId ? { organizationId } : {}), displayName, email, locale, topics, note: note || undefined }) });
      onToast(contact ? t("Contact updated.") : t("Contact added.")); onClose();
    } catch (error) { onToast(errorMessage(error)); }
  }
  return (
    <div className="modal-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="management-modal" role="dialog" aria-modal="true" aria-labelledby="contact-editor-title">
        <header><div><p className="eyebrow">{t("Communication contact")}</p><h2 id="contact-editor-title">{contact ? `${t("Edit")} ${contact.displayName}` : t("Add contact")}</h2></div><button className="icon-button" onClick={onClose}><Icon name="x" /></button></header>
        <form onSubmit={submit}>
          <div className="form-grid">
            <label className="form-field"><span>{t("Full name")}<em>{t("Required")}</em></span><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required /></label>
            <label className="form-field"><span>{t("Email address")}<em>{t("Required")}</em></span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
            <label className="form-field"><span>{t("Language")}</span><select value={locale} onChange={(e) => setLocale(e.target.value as "en" | "is")}><option value="en">English</option><option value="is">Íslenska</option></select></label>
            <label className="form-field"><span>{t("Note")}</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
          </div>
          <fieldset className="auth-choice"><legend>{t("Topics")}</legend>
            {TOPICS.map((topic) => <label key={topic}><input type="checkbox" checked={topics.includes(topic)} onChange={() => setTopics((v) => v.includes(topic) ? v.filter((x) => x !== topic) : [...v, topic])} /><span><strong>{t(COMMUNICATION_TOPIC_LABELS[topic])}</strong></span></label>)}
          </fieldset>
          <footer><span>{t("At least one topic is required.")}</span><div><Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button><Button type="submit" icon="check" disabled={!displayName.trim() || !email.trim() || topics.length === 0}>{t("Save contact")}</Button></div></footer>
        </form>
      </section>
    </div>
  );
}

export function ContactImportDialog({ endpoint, organizationId, onClose, onToast }: { endpoint: string; organizationId?: string; onClose: () => void; onToast: (message: string) => void }) {
  const t = useT();
  const [lines, setLines] = useState("");
  const [topics, setTopics] = useState<string[]>(["product-updates", "service-notices"]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const result = await apiFetch<{ created: unknown[]; skipped: Array<{ line: number; reason: string }> }>(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(organizationId ? { organizationId } : {}), lines, topics }) });
      onToast(`${result.created.length} ${t("contacts added")}${result.skipped.length ? `, ${result.skipped.length} ${t("skipped (lines")} ${result.skipped.map((s) => s.line).join(", ")})` : ""}.`);
      onClose();
    } catch (error) { onToast(errorMessage(error)); }
  }
  return (
    <div className="modal-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="management-modal" role="dialog" aria-modal="true" aria-labelledby="contact-import-title">
        <header><div><p className="eyebrow">{t("Paste list")}</p><h2 id="contact-import-title">{t("Add several contacts")}</h2><p>{t("One per line: Name, email — or just the email. Up to 250 lines.")}</p></div><button className="icon-button" onClick={onClose}><Icon name="x" /></button></header>
        <form onSubmit={submit}>
          <label className="form-field"><span>{t("Lines")}</span><textarea rows={8} value={lines} onChange={(e) => setLines(e.target.value)} placeholder={"Anna Jónsdóttir, anna@example.is\nbjorn@example.is"} /></label>
          <fieldset className="auth-choice"><legend>{t("Topics")}</legend>{TOPICS.map((topic) => <label key={topic}><input type="checkbox" checked={topics.includes(topic)} onChange={() => setTopics((v) => v.includes(topic) ? v.filter((x) => x !== topic) : [...v, topic])} /><span><strong>{t(COMMUNICATION_TOPIC_LABELS[topic])}</strong></span></label>)}</fieldset>
          <footer><span /><div><Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button><Button type="submit" icon="check" disabled={!lines.trim() || topics.length === 0}>{t("Add contacts")}</Button></div></footer>
        </form>
      </section>
    </div>
  );
}

export function SuppressionsTab({ onToast }: { onToast: (message: string) => void }) {
  const t = useT();
  const [items, setItems] = useState<SuppressionItem[]>([]);
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const load = () => apiFetch<{ items: SuppressionItem[] }>("/api/v1/internal/communications/suppressions").then((d) => setItems(d.items)).catch((e) => onToast(errorMessage(e)));
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function add(event: FormEvent) {
    event.preventDefault();
    try { await apiFetch("/api/v1/internal/communications/suppressions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, note: note || undefined }) }); setEmail(""); setNote(""); onToast(t("Address suppressed.")); void load(); } catch (error) { onToast(errorMessage(error)); }
  }
  async function remove(item: SuppressionItem) {
    try { await apiFetch("/api/v1/internal/communications/suppressions", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: item.email }) }); onToast(t("Suppression removed.")); void load(); } catch (error) { onToast(errorMessage(error)); }
  }
  return (
    <section className="page-stack" data-tour="communications-suppressions">
      <p className="communication-release-hint">{t("Suppressed addresses never receive communications, whatever company or list they are on. Bounces, spam reports and unsubscribes arrive here automatically from SendGrid.")}</p>
      <form className="management-toolbar" onSubmit={add}><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" required aria-label={t("Email address")} /><input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("Reason (optional)")} aria-label={t("Note")} /><Button type="submit" variant="secondary" icon="plus">{t("Suppress address")}</Button></form>
      <div className="management-table suppression-table">
        <div className="management-head"><span>{t("Email address")}</span><span>{t("Reason")}</span><span>{t("Source")}</span><span>{t("Since")}</span><span /></div>
        {items.map((item) => <div className="management-row" key={item.email}><span><code>{item.email}</code></span><span>{item.reason}{item.note ? ` · ${item.note}` : ""}</span><span>{item.source}</span><span>{item.createdAt.slice(0, 10)}</span><span><Button variant="ghost" onClick={() => remove(item)}>{t("Remove")}</Button></span></div>)}
      </div>
    </section>
  );
}
```

System admins see the Remove button work; Product managers get a 404 toast from the server on remove/add (read-only by design, matching §4).

- [ ] **Step 3: CSS and Icelandic** — grid columns for `.contact-table` (`2fr 1fr 2fr 1fr 1fr auto`), `.suppression-table` (`2fr 2fr 1fr 1fr auto`), `.communication-delivery-table` (`2fr 1.2fr 0.8fr 1.4fr 1.4fr 1fr`), `.communication-org-table` (`2fr 1fr 1fr 1fr`), `.communication-stats { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }`. Icelandic strings for every new `t("…")` literal (e.g. "Retry dead letters"→"Reyna aftur sendingar sem mistókust", "Cancel sending"→"Hætta við sendingu", "Unschedule"→"Aftengja tímasetningu", "Add contact"→"Bæta við tengilið", "Paste list"→"Líma lista", "Suppress address"→"Útiloka netfang", "Suppression removed."→"Útilokun fjarlægð.").

- [ ] **Step 4: Verify** — `npm run typecheck`, `npm run lint`, `npm run build`; manual: open a Sent communication → stats tiles and delivery rows; Contacts tab → add, edit, paste-import, remove; Suppressions tab → add and remove as the seeded System admin.

- [ ] **Step 5: Commit**

```bash
git add app/features/communication-detail.tsx app/features/communication-contacts.tsx app/globals.css lib/i18n-internal.ts
git commit -m "feat(communications): campaign detail, contacts and suppressions management"
```

---

### Task 17: Customer Updates page and the Releases hand-off

**Files:**
- Create: `app/features/company-contacts.tsx`
- Modify: `app/features/customer.tsx:586-700` (`UpdatesPage`)
- Modify: `app/features/shell.tsx` (pass `activeRole`; releases hand-off)
- Modify: `app/features/releases.tsx` (button)
- Modify: `lib/i18n.ts` (customer strings), `app/globals.css`

**Interfaces:**
- Consumes: customer routes (Task 6), `ContactEditor`/`ContactImportDialog` (Task 16), `/api/v1/notifications/preferences` (existing, event types from Task 1).
- Produces: `CompanyContactsSection({ onToast })`; `UpdatesPage` gains prop `activeRole: string`; `ReleasesPage` gains prop `onDraftEmail: (release: ReleaseItem) => void`.

- [ ] **Step 1: Preference labels and toggles** — in `UpdatesPage`, replace the generic `preference.eventType.replaceAll(".", " ")…` title with a label map and render communication topics as toggles:

```tsx
const PREFERENCE_LABELS: Record<string, [string, string]> = {
  "communication.product-updates": ["Product updates from DataCentral", "Release announcements like new versions and features"],
  "communication.service-notices": ["Service notices", "Planned maintenance and service changes"],
  "communication.security-advisories": ["Security advisories", "Always delivered — security information for your company"],
  "communication.general": ["General announcements", "Occasional news from the DataCentral team"],
};
// inside the map:
const isCommunication = preference.eventType.startsWith("communication.");
const [label, hint] = PREFERENCE_LABELS[preference.eventType] ?? [preference.eventType.replaceAll(".", " ").replace(/\b\w/g, (l) => l.toUpperCase()), preference.mandatory ? "Mandatory service message · delivered immediately" : "In-app updates remain available in Pulse"];
…
<strong>{t(label)}</strong><small>{t(hint)}</small>
…
{isCommunication ? (
  <input type="checkbox" role="switch" aria-label={`${t(label)} ${t("email")}`} checked={preference.cadence !== "Off"} disabled={preference.mandatory}
    onChange={(event) => updatePreference(preference.eventType, event.target.checked ? "Immediate" : "Off")} />
) : (<select …existing…/>)}
```

- [ ] **Step 2: Company contacts section** — `app/features/company-contacts.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { Button, Status, useT, type ContactItem, COMMUNICATION_TOPIC_LABELS } from "./shared";
import { ContactEditor, ContactImportDialog } from "./communication-contacts";

export function CompanyContactsSection({ onToast }: { onToast: (message: string) => void }) {
  const t = useT();
  const [items, setItems] = useState<ContactItem[] | null>(null);
  const [editing, setEditing] = useState<ContactItem | "new" | "import" | null>(null);
  const load = () => apiFetch<{ items: ContactItem[] }>("/api/v1/communications/contacts").then((d) => setItems(d.items)).catch(() => setItems(null)); // 404 for non-Company-admins → section hidden
  useEffect(() => { void load(); }, []);
  if (!items) return null;
  async function remove(contact: ContactItem) {
    if (!window.confirm(`${t("Remove")} ${contact.email}?`)) return;
    try { await apiFetch(`/api/v1/communications/contacts/${contact.id}`, { method: "DELETE" }); onToast(t("Contact removed.")); void load(); } catch (error) { onToast(errorMessage(error)); }
  }
  return (
    <section className="notification-preferences company-contacts" aria-labelledby="company-contacts-title" data-tour="company-contacts">
      <header>
        <div><h3 id="company-contacts-title">{t("Who receives DataCentral communications for your company")}</h3><p>{t("Colleagues with a Pulse account receive updates automatically and manage their own preferences. Add people here who should receive product updates and notices without a Pulse account.")}</p></div>
        <div className="communication-settings-actions"><Button variant="secondary" icon="plus" onClick={() => setEditing("new")}>{t("Add recipient")}</Button><Button variant="ghost" onClick={() => setEditing("import")}>{t("Paste list")}</Button></div>
      </header>
      <div className="management-table contact-table">
        {items.length === 0 && <p className="communication-release-hint">{t("No additional recipients yet.")}</p>}
        {items.map((c) => (
          <div className="management-row" key={c.id}>
            <span className="record-name"><span><strong>{c.displayName}</strong><code>{c.email}</code></span></span>
            <span>{c.locale === "is" ? "Íslenska" : "English"}</span>
            <span className="membership-tags">{c.topics.map((topic) => <span key={topic}>{t(COMMUNICATION_TOPIC_LABELS[topic] ?? topic)}</span>)}</span>
            <Status tone={c.status === "Active" ? "success" : "error"}>{c.status}</Status>
            <span>{c.source}</span>
            <span className="communication-row-actions"><Button variant="secondary" onClick={() => setEditing(c)}>{t("Edit")}</Button><Button variant="ghost" onClick={() => remove(c)}>{t("Remove")}</Button></span>
          </div>
        ))}
      </div>
      {editing === "import" && <ContactImportDialog endpoint="/api/v1/communications/contacts" onClose={() => { setEditing(null); void load(); }} onToast={onToast} />}
      {editing && editing !== "import" && <ContactEditor contact={editing === "new" ? undefined : editing} endpoint="/api/v1/communications/contacts" onClose={() => { setEditing(null); void load(); }} onToast={onToast} />}
    </section>
  );
}
```

Mount it in `UpdatesPage` after the preferences section: `{activeRole === "Company admin" && <CompanyContactsSection onToast={onToast} />}` — add `activeRole` and `onToast` props to `UpdatesPage` and pass them from the shell: `activeRole={organizationContexts.find((o) => o.active)?.role ?? ""}` and `onToast={setToast}`.

- [ ] **Step 3: Releases hand-off** — in `ReleasesPage` add the prop `onDraftEmail` and, inside each release `footer`, `{release.published && <Button variant="secondary" icon="send" onClick={() => onDraftEmail(release)}>{t("Draft customer email")}</Button>}`. In the shell:

```tsx
async function draftEmailFromRelease(release: ReleaseItem) {
  const response = await fetch("/api/v1/internal/communications", { method: "POST", headers: mutationHeaders(), body: JSON.stringify({ fromReleaseId: release.id }) });
  const data = await response.json();
  if (!response.ok) { setToast(data?.error?.message || "The communication could not be created."); return; }
  const url = new URL(window.location.href);
  url.searchParams.set("page", "communications");
  url.searchParams.set("communication", data.item.id);
  window.history.pushState({}, "", url);
  setPage("communications");
}
```

and pass `onDraftEmail={draftEmailFromRelease}` to `ReleasesPage`; add `mutationHeaders` to the `./shared` import list in `shell.tsx`. `navigate()` deletes only `request`/`idea` params, so `communication` survives; `useCommunicationQueryParam` (Task 15) opens the draft in the editor.

- [ ] **Step 4: Icelandic (customer catalogue `lib/i18n.ts`)** — "Product updates from DataCentral"→"Vöruuppfærslur frá DataCentral", "Release announcements like new versions and features"→"Tilkynningar um nýjar útgáfur og eiginleika", "Service notices"→"Þjónustutilkynningar", "Planned maintenance and service changes"→"Áætlað viðhald og þjónustubreytingar", "Security advisories"→"Öryggistilkynningar", "Always delivered — security information for your company"→"Alltaf sent — öryggisupplýsingar fyrir fyrirtækið þitt", "General announcements"→"Almennar tilkynningar", "Occasional news from the DataCentral team"→"Fréttir frá DataCentral teyminu af og til", "Who receives DataCentral communications for your company"→"Hverjir fá samskipti frá DataCentral fyrir fyrirtækið þitt", "Add recipient"→"Bæta við viðtakanda", "No additional recipients yet."→"Engir viðbótarviðtakendur enn.", "Draft customer email"→"Semja tölvupóst til viðskiptavina", plus the shared editor strings ("Full name", "Email address", "Language", "Topics", "Save contact", "Paste list", "Add contacts", "Remove", "Edit") where not already present.

- [ ] **Step 5: Verify** — `npm run typecheck`, `npm run lint`, `npm run build`; manual in memory mode: the seeded user is Company admin of Origo → Updates shows the toggles and the contacts section; add a recipient; as the same user (also System admin) publish a release and click "Draft customer email" → lands in the editor with the release content.

- [ ] **Step 6: Commit**

```bash
git add app/features/company-contacts.tsx app/features/customer.tsx app/features/shell.tsx app/features/releases.tsx lib/i18n.ts app/globals.css
git commit -m "feat(communications): customer preferences, company recipient list and release hand-off"
```

---

### Task 18: Help manual section, internal tour, seed data and final verification

**Files:**
- Modify: `app/help/route.ts` (admin section), `lib/server/tour-catalog.ts` (new tour), `scripts/capture-help-screenshots.mjs` (new tour steps), `public/help/*.png` (captured)
- Modify: `database/seed-development.sql` (one sample contact)
- Modify: `tests/tours.test.ts` (tour appears for internal roles only)

**Interfaces:**
- Consumes: `data-tour` anchors added in Tasks 14–17: `nav-communications`, `communications-page`, `communications-new`, `communications-editor`, `communications-send`, `communications-contacts`, `settings-communications`, `company-contacts`.
- Produces: tour key `customer-communications` (audience `Internal`, `defaultAutoStart: false`, version 1, `reofferOnNewVersion: false`).

- [ ] **Step 1: Failing test** — append to `tests/tours.test.ts`:

```ts
test("audiences: the customer-communications tour is internal-only and never auto-starts", async () => {
  const internal = (await getTourState(CONTRIBUTOR)).tours.find((tour) => tour.key === "customer-communications");
  assert.ok(internal);
  assert.equal(internal?.autoStart, false);
  assert.ok(!(await getTourState(CUSTOMER)).tours.some((tour) => tour.key === "customer-communications"));
});
```

- [ ] **Step 2: Run** — `npm test` → FAIL (tour missing).

- [ ] **Step 3: Tour** — append to `TOUR_CATALOG` in `lib/server/tour-catalog.ts`:

```ts
  {
    key: "customer-communications",
    version: 1,
    title: { en: "Customer communications", is: "Samskipti við viðskiptavini" },
    defaultAutoStart: false,
    defaultAudience: "Internal",
    reofferOnNewVersion: false,
    steps: [
      { element: "[data-tour='nav-communications']", route: "/communications", title: { en: "Communications", is: "Samskipti" }, description: { en: "Compose product updates, service notices and announcements for customer companies, then track every delivery.", is: "Semdu vöruuppfærslur, þjónustutilkynningar og tilkynningar fyrir fyrirtæki viðskiptavina og fylgstu með hverri sendingu." } },
      { element: "[data-tour='communications-new']", route: "/communications", title: { en: "Start from a template", is: "Byrjaðu með sniðmáti" }, description: { en: "Each template is branded and bilingual. Published releases also offer “Draft customer email”.", is: "Hvert sniðmát er með vörumerki og á tveimur tungumálum. Útgefnar útgáfur bjóða líka upp á „Semja tölvupóst til viðskiptavina“." } },
      { element: "[data-tour='communications-contacts']", route: "/communications", title: { en: "Recipients", is: "Viðtakendur" }, description: { en: "Pulse members receive communications automatically. Add contacts for people without a Pulse account; Company admins can maintain their own company's list.", is: "Meðlimir í Pulse fá samskipti sjálfkrafa. Bættu við tengiliðum fyrir fólk án Pulse-aðgangs; stjórnendur fyrirtækja geta viðhaldið sínum eigin lista." } },
      { element: "[data-tour='settings-communications']", route: "/settings", title: { en: "SendGrid settings", is: "SendGrid-stillingar" }, description: { en: "System admins enable sending, choose the sender, keep safe mode on until the first real send, and verify the configuration here.", is: "Kerfisstjórar virkja sendingar, velja sendanda, halda öruggum ham á þar til fyrsta raunverulega sendingin fer út og staðfesta uppsetninguna hér." } },
    ],
  },
```

- [ ] **Step 4: Help manual** — in `app/help/route.ts`, inside the `id="admin"` section (after the onboarding paragraphs), add a "Customer communications" subsection in both languages describing: where it lives (Communications in the DataCentral team menu), the three templates, the audience rules (members by preference, contacts by topic, suppression list, safe mode), test send and preview, send/schedule/cancel, the delivery states, and the Settings card. Add to the user section a short paragraph for Company admins: "Who receives DataCentral communications for your company" on the Updates page, and that everyone controls the topic toggles under Notification preferences. Keep sentences short and in the existing manual voice.

- [ ] **Step 5: Screenshots** — add the four tour steps to `scripts/capture-help-screenshots.mjs` in the same shape as the existing tours (route, anchor, file name `customer-communications-step-N.png`) and run `npm run help:screenshots` (requires `npm run dev` on port 3000 in memory mode; the script's prerequisites are documented in `HowToRefreshHelp.md`). Commit the PNGs.

- [ ] **Step 6: Seed** — append to `database/seed-development.sql` (guarded like the other inserts):

```sql
IF NOT EXISTS (SELECT 1 FROM dbo.CommunicationContacts WHERE organization_id='ORG-001' AND email='cio@origo.is')
  INSERT dbo.CommunicationContacts(id,organization_id,email,display_name,locale,topics_json,source,created_by_user_id)
  VALUES(NEWID(),'ORG-001','cio@origo.is',N'Origo CIO','is',N'["product-updates","service-notices"]','Admin',@UserId);
```

- [ ] **Step 7: Full verification** — `npm run verify` (openapi:check, typecheck, all tests, lint, production build) → PASS. Then the SQL acceptance run if a disposable database is available (`npm run test:sql` per `docs/production-hardening.md`) after applying `015_customer_communications.sql`.

- [ ] **Step 8: Commit**

```bash
git add lib/server/tour-catalog.ts app/help/route.ts scripts/capture-help-screenshots.mjs public/help database/seed-development.sql tests/tours.test.ts
git commit -m "docs(communications): help manual section, internal tour and seed contact"
```

---

## Execution notes

- **Order:** Tasks 1–3 (foundations) → 4–6 (contacts) → 7–10 (campaigns) → 11–13 (delivery, webhook, settings) → 14–17 (UI) → 18 (docs). Tasks 4/5, 7/8 and 14/16 are independent pairs and can run in parallel once their prerequisites are merged.
- **Memory mode caveat:** in memory mode an anonymous request resolves to the demo fallback identity (`lib/server/auth.ts` step ④: the seeded System admin, ORG-001, `isInternal`), and repositories decide roles through `requireMembership`/`requireInternalRole`, which in memory mode trust `identity.role`. Route tests therefore run admin paths without a session and assert concrete statuses; customer-role decisions (Company admin) are covered at the repository level with explicit identities. The seeded admin (`bjarki@uidata.com`, member of ORG-001) is part of every "all customers" audience in tests — the counts in Tasks 9, 11 and 12 include it.
- **Uncommitted work in the tree:** the working copy already carries unrelated changes to `app/features/delivery-status.tsx`, `app/help/route.ts`, `lib/server/tour-catalog.ts`, `app/tour-host.tsx`, `app/globals.css`, `scripts/capture-help-screenshots.mjs` and the help screenshots. Rebase or stash them before starting; Tasks 11, 14, 15, 16 and 18 touch the same files.
- **SQL branches:** every repository function has a memory path with tests and a SQL path written against migration 015. The `npm run test:sql` acceptance suite is the gate for the SQL branches; run it against a disposable database before release.
- **Deferred to the spec's §15 roadmap:** AI drafting/translation, database-backed template presets, approval workflow, customer-visible archive, login-free preference centre, DataCentral tenant-admin import, per-company engagement export, assistant/MCP tools, shared transport for OTP/notifications.
