# Pulse Plan B — Shared Tool Registry + In-App AI Chat + Slack

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one neutral tool registry over the existing repositories, the Anthropic Tool Runner assistant service, the floating voice-enabled ChatPanel, and the Slack Socket Mode front-end that reuses the same assistant.

**Architecture:** A single lib/server/chat/tool-registry.ts wraps every repository capability and is consumed by the in-app assistant (Anthropic beta Tool Runner). Slack rides the same sendChat over a Socket Mode connection started from instrumentation.ts.

**Dependency:** **Depends on Plan A** (async getIdentity, getCurrentUser, getIdentityContext). Execute AFTER Plan A. Plan C reuses the tool registry built here (Tasks 12–13), so build this before Plan C.

**Tech Stack:** Next.js 16.2.6 App Router (Node runtime, standalone output, Docker on Azure App Service single instance), TypeScript strict, `mssql` (hand-written T-SQL, dual SQL/in-memory mode), `jose` ^6, `openid-client` ^6, `@anthropic-ai/sdk`, `@slack/bolt` v4, `@modelcontextprotocol/sdk` ^1.29, `zod` ^4, Node built-in test runner via `tsx`.

## Global Constraints

Copied verbatim from the three specs (`C:\VS Code\DC-TimeRegistration\AI.MD`, `MCP-LLM-Instructions.md`, `DataCentralEmbedEntraAuthApp.md`) and repo conventions. Every task's requirements implicitly include this section.

- Default model: `claude-opus-4-8`, configurable via `ANTHROPIC_MODEL`; key via `ANTHROPIC_API_KEY`. Chat send flow uses `max_tokens: 4000`; transcript cleanup uses `max_tokens: 500`. Use the official `@anthropic-ai/sdk` only — never raw HTTP, never OpenAI-compatible shims. Adaptive thinking (`thinking: { type: "adaptive" }`); never `budget_tokens`, never `temperature`.
- **Security is server-side.** Identity and permissions never depend on prompt or message content. Every tool call re-checks authorization in the repositories (`requireMembership` / `requireInternalRole` / `requirePublishRole` / `assertAdmin`). The model is never trusted with authorization.
- **No secrets in the repo.** `.env.example` holds empty placeholders; dev uses `.env.local`; prod uses `@secure()` Bicep param → Key Vault secret → Key Vault-reference appSetting.
- **Degrade gracefully.** Missing `ANTHROPIC_API_KEY` → chat UI shows a friendly notice; missing Slack tokens → Slack off; missing `PULSE_SESSION_SECRET` in dev → dev fallback. The app always starts and runs without any of these configured.
- **configInfo.md in the repo root is a required final deliverable** (AI.MD §10), plus `docs/slack-setup.md` and a README section.
- DataCentral wire contract is fixed: URL params `dcdata`/`dcsig` (lowercase); headers `X-DC-Data`/`X-DC-Sig`; outgoing postMessage `{ type: 'AppReady ' }` **with trailing space** AND `{ type: 'AppReady' }` without (send both); incoming envelope in two shapes — `{ type: 'AccessToken', token, aadToken?, … }` and `{ accessToken, graphToken?, … }` — accept both; `dcsig = base64(HMAC_SHA256(secret, raw dcdata base64 string))` standard base64, sign the raw param value; `dcdata` may be doubly-encoded JSON (handle both); compare HMAC with `crypto.timingSafeEqual` after a length guard, never `==`.
- OAuth: PKCE **S256 only**, verifier length 43–128, fixed-time compare; authorization codes 5-minute TTL, **single use, removed from cache before validation**; consent nonce 10-minute TTL, single use, bound to the user who saw the page; refresh tokens stored as SHA-256 hashes only, rotated on every use, 60-day expiry; access JWTs HMAC-SHA256, 1 h, issuer + audience + lifetime validated with 60 s clock tolerance; redirect URIs exact-match, https anywhere, http loopback only, private-use schemes for native apps, no fragments; `token_endpoint_auth_methods_supported: ["none"]` (no client secrets); the 401 challenge header is exactly `WWW-Authenticate: Bearer resource_metadata="{base}/.well-known/oauth-protected-resource/mcp"`; CORS must expose `Mcp-Session-Id` and `WWW-Authenticate`; all four `/.well-known/*` path variants (bare + `/mcp` suffix) must exist.
- MCP transport is stateless: `WebStandardStreamableHTTPServerTransport` with **no** `sessionIdGenerator`, fresh `McpServer` per request, per-request user re-resolution and tool rebinding.
- Slack: Socket Mode only (outbound WSS, no new ingress); register Slack services only when both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are present; identity mapping exclusively via Slack `users.info` verified email ↔ `dbo.Users.email` exact match, never message text; 15-minute in-memory event dedupe; ⏳ reaction while working; threaded replies on mentions; Markdown → mrkdwn conversion (unit-tested); single-instance hosting requirement documented.
- Repo conventions: repositories are plain exported functions taking `identity: PulseIdentity` first with dual SQL/in-memory mode gated on `isAzureSqlConfigured()`; the SQL pool accessor is **`getSqlPool()`** (NOT `getPool`) and `sql` is re-exported, both from `@/lib/server/database`; in-memory state via `declare global` + `globalThis.pulseMemory*`; errors are string-coded `Error`s (`FORBIDDEN`, `NOT_FOUND`, `INVALID_*`) mapped by `apiError` (FORBIDDEN and NOT_FOUND both → 404, anti-enumeration; **codes with no mapping become 500** — see the getIdentity note in Task 9); parameterized T-SQL only; migrations `SET XACT_ABORT ON` + transaction, snake_case columns; route handlers follow the `correlationId` → try → `json()` / `apiError()` shape; path alias `@/*` = repo root; **test files are explicitly enumerated in the `test` script in `package.json`** — every new test file must be appended there; tests use `node:test` + `node:assert/strict` against the in-memory mode, resetting `globalThis.pulseMemory*` in `beforeEach`.
- **Test import paths MUST be extension-less** (`import { x } from "../lib/server/session"`, `from "../app/dc-auth/route"`, `from "../proxy"`). The code snippets in this plan write `.ts`/`.tsx` extensions for path clarity — **strip the extension when writing the actual file.** The repo uses `moduleResolution: "bundler"` without `allowImportingTsExtensions`, so `import … from "…/foo.ts"` fails the `tsc --noEmit` gate with TS5097 before any test runs (the existing `tests/workflow.test.ts` imports extension-less; match it). This applies to every `import` in every test and implementation file across all tasks.
- **`IdentityContext` is not an exported type.** Where a task's code or interface names `IdentityContext`, use `type IdentityContext = Awaited<ReturnType<typeof getIdentityContext>>` (define the alias locally) — `getIdentityContext` returns an inferred object, and Task 26 already uses the `Awaited<ReturnType<…>>` form. Its shape: `{ user: { id; email; name; locale; status }, organizations: Array<{ id; name; type; role; active }>, activeOrganizationId: string | null }` — memberships have **no** `organizationId`/`organizationName`/`organizationType`/`status`; use `id`/`name`/`type`/`role`/`active` (`active` = "is the currently selected org", already filtered to Active status in SQL).
- Commit style observed in repo: conventional-ish `feat:` prefix. Commit after every green task.
- Verification commands: `npm run typecheck` (tsc gate), `npm test` (typecheck + enumerated test files), `npm run lint`.
- Telemetry privacy: never log user chat text, request text, emails, or filenames.
- The legacy Vite/Cloudflare "Sites" stack (`vite.config.ts`, `worker/`, `db/`, `scripts/*.sh`) is excluded from tsconfig and NOT part of this work. Do not touch it. `app/chatgpt-auth.ts` is orphaned scaffold — do not wire it into anything (Task 9 deletes it).

**Phase order rationale:** Phase 1 (auth) first because it converts `getIdentity` to async (touches all 43 route files — everything later builds on the new signature), and the MCP OAuth `/oauth/authorize` needs the app-level login. Phase 2 (tool registry + chat) before Phase 3 (Slack, which reuses `sendChat`) and Phase 4 (MCP, which reuses the tool registry). Phase 5 is docs + final acceptance.

Each phase produces working, independently testable software. If you prefer separate plan documents per subsystem, split at the phase boundaries — tasks are self-contained.

---


# Phase 2 — Shared tool registry + in-app AI chat

## Task 11: ChatMessages persistence

**Files:**
- Create: `database/migrations/009_chat_messages.sql`
- Create: `lib/server/chat/chat-repository.ts`
- Create: `tests/chat.test.ts`
- Modify: `package.json` (append `tests/chat.test.ts` to `test` script; add `@anthropic-ai/sdk`, `zod@^4`)

**Interfaces:**
- Consumes: `isAzureSqlConfigured`/`getSqlPool`, `PulseIdentity`.
- Produces: `ChatMessageRecord = { id: string; role: "user"|"assistant"; content: string; createdAt: string }`; `appendChatMessage(identity, role, content): Promise<ChatMessageRecord>`; `getChatHistory(identity, take = 30): Promise<ChatMessageRecord[]>` (most recent N, chronological order); `clearChatHistory(identity): Promise<void>`; `getUserByEmail(email: string): Promise<{ id; email; name; status } | null>` (identity-less — the Slack identity-mapping primitive, same precedent as `setAttachmentState`); `getUserById(id: string): Promise<{ id; email; name; status } | null>` (identity-less — consumed by the MCP token endpoint in Task 24 to issue JWTs with email+name and re-check Active status; `SELECT id, email, display_name AS name, status FROM dbo.Users WHERE id = @id`). Tasks 14, 15, 18, 24 consume these (chat send, chat routes, Slack identity, MCP token endpoint).

- [ ] **Step 1: Install dependencies**

Run: `npm install @anthropic-ai/sdk zod@^4`

- [ ] **Step 2: Migration** — `database/migrations/009_chat_messages.sql`:

```sql
SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- Per-user assistant conversation history, shared between the web chat panel
-- and Slack (keyed by user only, not organization, so a conversation follows
-- the user across org switches and channels).
CREATE TABLE dbo.ChatMessages (
  id uniqueidentifier NOT NULL CONSTRAINT PK_ChatMessages PRIMARY KEY,
  user_id uniqueidentifier NOT NULL
    CONSTRAINT FK_ChatMessages_Users REFERENCES dbo.Users(id),
  role nvarchar(16) NOT NULL
    CONSTRAINT CK_ChatMessages_Role CHECK (role IN ('user','assistant')),
  content nvarchar(max) NOT NULL,
  created_at datetime2(3) NOT NULL
    CONSTRAINT DF_ChatMessages_CreatedAt DEFAULT SYSUTCDATETIME()
);

CREATE INDEX IX_ChatMessages_User_Created
  ON dbo.ChatMessages (user_id, created_at DESC);

COMMIT TRANSACTION;
```

- [ ] **Step 3: Failing tests** — `tests/chat.test.ts`:

```ts
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  appendChatMessage, getChatHistory, clearChatHistory, getUserByEmail,
} from "../lib/server/chat/chat-repository.ts";

const identity = {
  id: "11111111-1111-4111-8111-111111111111", email: "bjarki@uidata.com",
  name: "Bjarki", organizationId: "ORG-001", role: "System admin", isInternal: true,
};

beforeEach(() => {
  globalThis.pulseMemoryChatMessages = undefined;
  globalThis.pulseMemoryUsers = undefined;
});

test("history windows to the most recent N in chronological order", async () => {
  for (let i = 1; i <= 35; i++) await appendChatMessage(identity, "user", `m${i}`);
  const history = await getChatHistory(identity, 30);
  assert.equal(history.length, 30);
  assert.equal(history[0].content, "m6");
  assert.equal(history[29].content, "m35");
});

test("clearChatHistory removes only this user's messages", async () => {
  await appendChatMessage(identity, "user", "mine");
  await appendChatMessage({ ...identity, id: "22222222-2222-4222-8222-222222222222" }, "user", "theirs");
  await clearChatHistory(identity);
  assert.equal((await getChatHistory(identity)).length, 0);
  assert.equal((await getChatHistory({ ...identity, id: "22222222-2222-4222-8222-222222222222" })).length, 1);
});

test("getUserByEmail finds the seeded user exactly, misses unknown", async () => {
  const hit = await getUserByEmail("bjarki@uidata.com");
  assert.ok(hit);
  assert.equal(hit.status, "Active");
  assert.equal(await getUserByEmail("nobody@nowhere.example"), null);
});
```

Append `tests/chat.test.ts` to the `test` script. Run: `npm test` — Expected: FAIL.

- [ ] **Step 4: Implement** `lib/server/chat/chat-repository.ts` with the dual-mode pattern: SQL path uses the queries `INSERT INTO dbo.ChatMessages (id, user_id, role, content) VALUES (@id, @userId, @role, @content)`, `SELECT TOP (@take) id, role, content, created_at AS createdAt FROM dbo.ChatMessages WHERE user_id = @userId ORDER BY created_at DESC, id DESC` (reverse in JS), `DELETE FROM dbo.ChatMessages WHERE user_id = @userId`, `SELECT id, email, display_name AS name, status FROM dbo.Users WHERE email = @email` (`getUserByEmail`), and `SELECT id, email, display_name AS name, status FROM dbo.Users WHERE id = @id` (`getUserById`). Memory path: `globalThis.pulseMemoryChatMessages: Map<string, ChatMessageRecord[]>` keyed by userId; `getUserByEmail`/`getUserById` read the same seeded store `admin-repository.ts` uses (import its seed accessor).

- [ ] **Step 5: Run tests** — `npm test` → PASS. **Commit:**

```bash
git add database/migrations/009_chat_messages.sql lib/server/chat/chat-repository.ts tests/chat.test.ts package.json package-lock.json
git commit -m "feat: chat message persistence with per-user history window"
```

## Task 12: Neutral tool registry — core + customer tools

**Files:**
- Create: `lib/server/chat/tool-registry.ts` (types, error mapper, instructions builder, registry assembly)
- Create: `lib/server/chat/tools-customer.ts`
- Test: `tests/chat.test.ts` (extend)

**Interfaces:**
- Consumes: every existing repository in `lib/server/*` (see tool table), `PulseIdentity`, `getIdentityContext`.
- Produces — **the single source of truth both hosts consume** (in-app assistant service Task 14, MCP endpoint Task 26):

```ts
import type { ZodRawShape } from "zod";

export type ChatTool = {
  name: string;                       // snake_case, e.g. "list_my_requests"
  title?: string;
  description: string;                // states WHEN to call it, prerequisites, id formats (DCI-####, IDEA-###), date format yyyy-MM-dd
  inputSchema: ZodRawShape;           // zod RAW SHAPE (not z.object) — MCP SDK takes shapes; chat host wraps with z.object()
  readOnly: boolean;                  // MCP readOnlyHint; chat host flips dataChanged on !readOnly success
  group: "customer" | "internal" | "admin";
  run: (identity: PulseIdentity, args: Record<string, unknown>) => Promise<string>;
};

export function getChatTools(): ChatTool[];
export function chatToolErrorMessage(error: unknown): string;
export function buildAssistantInstructions(identity: PulseIdentity, context: IdentityContext): string;
```

Rules baked into every tool:
1. `run` calls existing repository functions passing identity through — tenant isolation, role gates, audit, notifications apply unchanged.
2. Every tool's `inputSchema` includes `organization_id: z.string().max(32).optional().describe("Act in this organization (must be one of the user's memberships); defaults to the active organization")`; `run` scopes a **copy**: `const scoped = { ...identity, organizationId: (args.organization_id as string) ?? identity.organizationId }` — never hand repositories the shared per-request identity (`requireMembership` mutates it).
3. Errors returned as text via `chatToolErrorMessage`: `FORBIDDEN`/`NOT_FOUND` → `"That item doesn't exist or you don't have access to it."` (anti-enumeration preserved); `UNAUTHORIZED` → `"You are not signed in."`; `INVALID_ACTIVE_ORGANIZATION_REQUIRED` → `"You belong to several organizations — pass organization_id (ask get_me for the list)."`; other `INVALID_*`/`MANDATORY_*` → humanized (`code.replace(/^INVALID_/, "").replaceAll("_", " ").toLowerCase()`); unknown → `"Unexpected error performing that action. Try rephrasing."` + `console.error` without user text.
4. Returns are compact strings with public ids, e.g. `` `DCI-1051 'Export to Excel' — Submitted, area Distribution` ``.
5. Mutating tools do not use `executeIdempotent` (HTTP-header-scoped); descriptions of create tools say "do not retry on timeout".

- [ ] **Step 1: Failing tests** (registry shape + error mapping + a real tool run in memory mode):

```ts
import { getChatTools, chatToolErrorMessage } from "../lib/server/chat/tool-registry.ts";

test("registry exposes groups and unique snake_case names", () => {
  const tools = getChatTools();
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.match(n, /^[a-z][a-z0-9_]+$/);
  assert.ok(tools.some((t) => t.group === "customer"));
});

test("error mapper preserves anti-enumeration", () => {
  assert.equal(chatToolErrorMessage(new Error("FORBIDDEN")),
    chatToolErrorMessage(new Error("NOT_FOUND")));
  assert.match(chatToolErrorMessage(new Error("INVALID_REQUEST_TITLE")), /title/i);
});

test("submit_request tool creates a request via the repository", async () => {
  const tool = getChatTools().find((t) => t.name === "submit_request");
  assert.ok(tool);
  const text = await tool.run(identity, {
    title: "Chat-created request", problem: "Testing the tool layer",
    area: "Distribution", impact: "Medium", visibility: "Organization",
  });
  assert.match(text, /DCI-\d+/);
});

test("tenant isolation flows through tools (cross-org read reads as not found)", async () => {
  const tool = getChatTools().find((t) => t.name === "get_request");
  const otherTenant = { ...identity, id: "33333333-3333-4333-8333-333333333333",
    organizationId: "ORG-002", role: "Requester", isInternal: false };
  const text = await tool!.run(otherTenant, { id: "DCI-1042" });
  assert.match(text, /doesn't exist or you don't have access/);
});
```

(`beforeEach` additionally resets the `globalThis.pulseMemory*` stores used by the repositories under test — mirror the reset list in `tests/workflow.test.ts`.)

Run: `npm test` — Expected: FAIL.

- [ ] **Step 2: Implement** `tool-registry.ts` (types, `chatToolErrorMessage`, `withScope` helper implementing rule 2, assembly `getChatTools()` = customer ∪ internal ∪ admin) and `tools-customer.ts` with these tools (backing functions per the repository inventory):

| Tool | readOnly | Backing |
|---|---|---|
| `get_me` | ✓ | `getIdentityContext` — returns user, memberships (org ids + roles), active org |
| `list_my_requests` | ✓ | `listRequests` (optional `status` filter applied in-tool) |
| `get_request` | ✓ | `getRequest` + `getRequestHistory` (public id `DCI-####`) |
| `find_similar` | ✓ | `searchSuggestions` — description: "ALWAYS call before submit_request and mention duplicates to the user" |
| `submit_request` | ✗ | `createRequest` (title ≤140, problem ≤5000, visibility enum, optional linkedIdeaId, requestType, affectedUsers, workaround, desiredTiming) |
| `edit_request` | ✗ | `editRequest` (description: only while Submitted / Needs information) |
| `set_request_status` | ✗ | `updateRequestStatus` (description: customers may only Withdraw; Closed needs explanation; Routed to support needs supportReference) |
| `get_request_draft` / `save_request_draft` / `discard_request_draft` | ✓/✗/✗ | draft-repository |
| `list_attachments` | ✓ | `listAttachments(identity, requestId)` — read-only; lets the assistant tell a user which files are on a DCI and their scan state. Binary upload/download stay UI-only (out of chat scope) |
| `list_comments` | ✓ | `listComments` (`includeInternal` flag) |
| `add_comment` | ✗ | `addComment` (visibility enum Customer/Internal; Internal requires internal role — enforced in repo) |
| `edit_comment` / `remove_comment` | ✗ | `editComment` / `removeComment` (remove requires reason) |
| `browse_ideas` | ✓ | `listIdeas` (optional area/horizon filter in-tool) |
| `get_idea` | ✓ | `getIdea` (alias-aware, `IDEA-###`) |
| `follow_idea` | ✗ | `toggleFollow(identity, id, markAsSolvesMyNeed)` |
| `view_roadmap` | ✓ | `listIdeas` grouped by horizon Now/Next/Later/Released |
| `list_releases` | ✓ | `listReleases(identity, false)` |
| `list_notifications` / `mark_notification_read` | ✓/✗ | operations-repository |
| `get_notification_preferences` / `set_notification_preference` | ✓/✗ | notification-preference-repository |

Representative implementation shape (every other tool follows it):

```ts
{
  name: "submit_request",
  description:
    "Create a new customer request (DCI-####) in the user's active organization. " +
    "ALWAYS call find_similar first and mention duplicates to the user before creating. " +
    "Visibility 'Organization' is visible to colleagues; 'Private' only to the author and internal staff. " +
    "Do not retry on timeout.",
  inputSchema: {
    title: z.string().max(140).describe("Short title, max 140 chars"),
    problem: z.string().max(5000).describe("Problem or desired outcome, max 5000 chars"),
    area: z.string().describe("Product area, e.g. 'Distribution'"),
    impact: z.string().describe("Impact if unresolved, e.g. Low/Medium/High"),
    visibility: z.enum(["Private", "Organization"]),
    requestType: z.string().optional(),
    affectedUsers: z.number().int().positive().optional(),
    workaround: z.string().optional(),
    desiredTiming: z.string().optional(),
    linkedIdeaId: z.string().optional().describe("IDEA-### id of a PUBLISHED idea this supports"),
    organization_id: orgIdParam,
  },
  readOnly: false,
  group: "customer",
  run: (identity, args) =>
    withScope(identity, args, (scoped, input) =>
      createRequest(scoped, input as never).then(
        (r) => `Created ${r.id} '${r.title}' (status ${r.status}).`)),
}
```

- [ ] **Step 3: Run tests** — `npm test` → PASS. **Commit:** `git commit -m "feat: neutral chat tool registry with customer tools"`

## Task 13: Internal + admin tools

**Files:**
- Create: `lib/server/chat/tools-internal.ts`, `lib/server/chat/tools-admin.ts`
- Modify: `lib/server/chat/tool-registry.ts` (assembly)
- Test: `tests/chat.test.ts` (extend)

**Interfaces:** same `ChatTool` contract; `group: "internal" | "admin"`.

- [ ] **Step 1: Failing tests** — internal tool works for internal identity, reads as refusal text for customer identity (repo-enforced):

```ts
test("internal tool refuses a customer identity via repository role gate", async () => {
  const tool = getChatTools().find((t) => t.name === "list_triage_queue");
  const customer = { ...identity, id: "44444444-4444-4444-8444-444444444444",
    role: "Requester", isInternal: false };
  const text = await tool!.run(customer, {});
  assert.match(text, /doesn't exist or you don't have access/);
});

test("publish_idea demands explicit confirmed_safe", () => {
  const tool = getChatTools().find((t) => t.name === "publish_idea");
  assert.match(tool!.description, /confirm/i);
  assert.ok("confirmed_safe" in tool!.inputSchema);
});
```

- [ ] **Step 2: Implement.** Internal tools: `list_triage_queue` (requireInternalRole + listRequests), `bulk_triage` (≤100 ids; description: "bulk action — confirm with the user before running on more than 5 requests"), `list_internal_ideas`, `create_idea`, `update_idea` (description warns: editing a Published idea demotes it to Staged), `publish_idea` (`confirmed_safe: z.boolean()` — "set true ONLY after the user explicitly confirms the published wording is customer-safe"), `link_request_to_idea`, `move_request_link`, `merge_ideas` (destructive — confirm first), `score_idea` (ints 1–5, confidence enum 50/80/100, effort enum 1/2/3/5/8/13, rationale), `place_on_roadmap`, `list_external_links`/`add_external_link`/`remove_external_link`, `list_internal_releases`/`create_release`/`publish_release` (publish is high-blast: cascades Released + notifies — confirm first), `list_saved_views`/`create_saved_view`/`delete_saved_view`, `analytics_summary`, `export_requests_csv` (returns row count + first 20 lines + pointer to the CSV route — never dump the full CSV into context), `search_audit_log`. Admin tools: `list_organizations`/`save_organization`, `list_users`/`save_user`, `list_taxonomy`/`save_taxonomy`, `get_settings`/`save_settings` (description surfaces weights-sum-100 + formulaVersion bump), `list_webhooks`/`create_webhook`/`set_webhook_state`. Job-trigger endpoints are **not** exposed as tools. All authorization lives in the repositories; groups are prompt hygiene only.

- [ ] **Step 3: `buildAssistantInstructions`** in `tool-registry.ts` — used by BOTH the chat system prompt (Task 14) and MCP `ServerInstructions` (Task 26):

**Membership field names (verified against `lib/server/identity-repository.ts`):** each entry in `ctx.organizations` is `{ id, name, type, role, active }` — there is NO `organizationId`/`organizationName`/`organizationType`/`status` field. Use `o.id`, `o.name`, `o.type`, `o.role`, `o.active`. `ctx.activeOrganizationId` is the active org id; `ctx.user` is `{ id, email, name, locale, status }`.

```ts
export function buildAssistantInstructions(identity: PulseIdentity, ctx: IdentityContext): string {
  const membership = ctx.organizations.find((o) => o.id === (ctx.activeOrganizationId ?? identity.organizationId));
  const internal = ctx.organizations.find((o) => o.type === "Internal");
  return `DataCentral Pulse is the customer-feedback and product-roadmap tool where customers
submit requests (DCI-####) and follow product ideas (IDEA-###), and the DataCentral team
triages, links, scores, publishes and releases them.
You are acting as ${identity.name} (${identity.email})${membership ? `, active organization ${membership.name} (role: ${membership.role})` : ""}.
${internal ? `They are DataCentral staff (${internal.role}).` : "They are a customer user: only their own organization's data is accessible. Politely refuse triage, internal, or admin actions."}
Permissions are enforced server-side.

Rules: requests are private to their organization; ideas are the public catalogue.
Request statuses: Draft, Submitted, Needs information, Linked, Routed to support, Closed, Withdrawn —
customers may edit only while Submitted/Needs information and may only Withdraw.
Idea statuses: Discovery, Candidate, Planned, In progress, Released, Not planned, Archived;
publishing customer-visible wording requires an explicit safe-wording confirmation.
Use find_similar before submit_request. Titles ≤140 chars; text fields ≤5000. Dates are yyyy-MM-dd.
Refer to items by public ids (DCI-####, IDEA-###, REL-###).`;
}
```

(Field names verified above: `o.id`, `o.name`, `o.type`, `o.role`, `o.active`.)

- [ ] **Step 4: Run tests** — `npm test` → PASS. **Commit:** `git commit -m "feat: internal and admin chat tools + shared assistant instructions"`

## Task 14: Assistant service (client cache, sendChat, cleanTranscript)

**Files:**
- Create: `lib/server/chat/assistant-service.ts`
- Create: `lib/server/chat/system-prompt.ts`
- Test: `tests/chat.test.ts` (extend — configuration gate only; no network calls in tests)

**Interfaces:**
- Consumes: `getChatTools`, `chatToolErrorMessage`, `buildAssistantInstructions` (Tasks 12–13), chat repository (Task 11), `getIdentityContext`, `@anthropic-ai/sdk` (`client.beta.messages.toolRunner`, `betaZodTool` from `@anthropic-ai/sdk/helpers/beta/zod`).
- Produces: `isAssistantConfigured(): boolean`; `sendChat(identity: PulseIdentity, text: string): Promise<{ reply: string; dataChanged: boolean; switchedOrganizationId?: string }>`; `cleanTranscript(raw: string): Promise<string>`. Tasks 15 (chat routes) and 19 (Slack handler) consume `sendChat` unchanged.

- [ ] **Step 1: Failing test:**

```ts
import { isAssistantConfigured, sendChat } from "../lib/server/chat/assistant-service.ts";

test("unconfigured assistant returns a friendly notice and never throws", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(isAssistantConfigured(), false);
  const result = await sendChat(identity, "hello");
  assert.match(result.reply, /ANTHROPIC_API_KEY/);
  assert.equal(result.dataChanged, false);
});
```

- [ ] **Step 2: Implement `assistant-service.ts`:**

```ts
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { PulseIdentity } from "@/lib/domain";
import { getIdentityContext } from "@/lib/server/identity-repository";
import { requireMembership } from "@/lib/server/authorization";
import { appendChatMessage, getChatHistory } from "@/lib/server/chat/chat-repository";
import { getChatTools, chatToolErrorMessage, buildAssistantInstructions } from "@/lib/server/chat/tool-registry";
import { buildSystemPrompt } from "@/lib/server/chat/system-prompt";

declare global { var pulseAnthropicClient: { key: string; client: Anthropic } | undefined; }

export function isAssistantConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
function getClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY!;
  if (globalThis.pulseAnthropicClient?.key !== key)
    globalThis.pulseAnthropicClient = { key, client: new Anthropic({ apiKey: key }) };
  return globalThis.pulseAnthropicClient.client; // one client (and HTTP agent) per process — never per request
}
const MODEL = () => process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

type ChatToolState = { dataChanged: boolean; switchedOrganizationId?: string };

// Adapt the neutral registry to Anthropic runnable tools, bound to THIS request's
// mutable identity + state. Group gating is prompt hygiene; repos are the braces.
function buildRunnerTools(identity: PulseIdentity, groups: Set<string>, state: ChatToolState) {
  const tools = getChatTools()
    .filter((t) => groups.has(t.group))
    .map((t) => betaZodTool({
      name: t.name,
      description: t.description,
      inputSchema: z.object(t.inputSchema),
      run: async (input: Record<string, unknown>) => {
        try {
          const text = await t.run(identity, input);
          if (!t.readOnly) state.dataChanged = true;
          return text;
        } catch (error) { return chatToolErrorMessage(error); }
      },
    }));
  // Chat-host-only tool: durable org switching (cookie side effect in the route).
  tools.push(betaZodTool({
    name: "switch_organization",
    description: "Switch the user's active organization for this and future turns. Use get_me to list memberships.",
    inputSchema: z.object({ organizationId: z.string().max(32) }),
    run: async ({ organizationId }: { organizationId: string }) => {
      try {
        await requireMembership({ ...identity }, organizationId);
        identity.organizationId = organizationId;
        state.switchedOrganizationId = organizationId;
        return `Active organization switched to ${organizationId}.`;
      } catch (error) { return chatToolErrorMessage(error); }
    },
  }));
  return tools;
}

export async function sendChat(identity: PulseIdentity, text: string) {
  if (!isAssistantConfigured())
    return { reply: "The assistant isn't configured yet. Ask an administrator to set ANTHROPIC_API_KEY.", dataChanged: false };

  const context = await getIdentityContext(identity); // FORBIDDEN for unknown/inactive users → route maps via apiError
  await appendChatMessage(identity, "user", text);
  const history = await getChatHistory(identity, 30); // includes the message just persisted
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  while (messages.length && messages[0].role !== "user") messages.shift(); // first message must be user

  // Membership objects are { id, name, type, role, active }; the query already
  // filters to Active memberships, so no status field exists to check.
  const internal = context.organizations.find((o) => o.type === "Internal");
  const groups = new Set<string>(["customer"]);
  if (internal) groups.add("internal");
  if (internal?.role === "System admin") groups.add("admin");

  const state: ChatToolState = { dataChanged: false };
  const requestIdentity: PulseIdentity = { ...identity, organizationId: context.activeOrganizationId ?? identity.organizationId };

  let reply: string;
  try {
    const finalMessage = await getClient().beta.messages.toolRunner({
      model: MODEL(),
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      system: buildSystemPrompt(requestIdentity, context),
      messages,
      tools: buildRunnerTools(requestIdentity, groups, state),
      max_iterations: 16,
    });
    reply = finalMessage.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text).join("\n").trim() || "(no reply)";
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      console.warn(JSON.stringify({ level: "warn", message: "assistant api error", status: error.status }));
      reply = `The assistant hit an error: ${error.message}`;
    } else {
      console.error(JSON.stringify({ level: "error", message: "assistant unexpected error" }));
      reply = "The assistant hit an unexpected error. Please rephrase and try again.";
    }
  }

  await appendChatMessage(identity, "assistant", reply);
  return { reply, dataChanged: state.dataChanged, switchedOrganizationId: state.switchedOrganizationId };
}

const CLEAN_SYSTEM =
  "You clean up voice-dictation transcripts. Fix punctuation, casing and obvious mis-transcriptions, " +
  "remove filler words and repetitions, but keep the language, meaning and all specifics " +
  "(dates, numbers, names) exactly. Reply with ONLY the cleaned text.";

export async function cleanTranscript(raw: string): Promise<string> {
  if (!isAssistantConfigured() || !raw.trim()) return raw;
  try {
    const res = await getClient().messages.create({
      model: MODEL(), max_tokens: 500, system: CLEAN_SYSTEM,
      messages: [{ role: "user", content: raw }],
    });
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    return text || raw;
  } catch {
    console.warn(JSON.stringify({ level: "warn", message: "transcript cleanup failed" }));
    return raw;
  }
}
```

`system-prompt.ts` — `buildSystemPrompt(identity, ctx)` per AI.MD §2.4 skeleton: opens with `buildAssistantInstructions(identity, ctx)` (Task 13), then appends today's date (`Today is ${yyyy-MM-dd} (${weekday}, ISO week ${n}).`) and the behavior block:

```
Behavior:
- Reply in the SAME language the user writes in (English and Icelandic are common).
- Use the tools to actually perform what the user asks — don't just describe what could be done.
- Resolve relative dates ("today", "last week", "next Monday") yourself from today's date; weeks start on Monday.
- ALWAYS call find_similar and surface possible duplicates before creating a new request.
- Before destructive or high-blast actions (merging ideas, publishing ideas or releases, bulk triage
  over many requests, changing settings), confirm with the user first. Single adds/edits the user
  clearly requested may proceed directly.
- If a request is ambiguous, ask one short clarifying question.
- Be concise. After acting, summarize what changed in one or two sentences.
```

Note: `max_tokens: 4000` is shared by adaptive thinking + text. If complex multi-tool turns show `stop_reason: "max_tokens"` truncation in practice, raise `max_tokens` (spec pins 4000 — deviation needs sign-off) rather than disabling thinking.

- [ ] **Step 3: Run tests** — `npm test` → PASS. **Commit:** `git commit -m "feat: chat assistant service with Anthropic tool runner"`

## Task 15: Chat API routes

**Files:**
- Create: `app/api/v1/chat/messages/route.ts`
- Create: `app/api/v1/chat/transcript/route.ts`
- Test: `tests/chat.test.ts` (extend)

**Interfaces:**
- Consumes: `getIdentity` (async, Task 9), `sendChat`/`cleanTranscript`/`isAssistantConfigured` (Task 14), chat repository (Task 11), `json`/`apiError`/`correlationId` from `lib/server/http.ts`.
- Produces: `GET /api/v1/chat/messages` → `{ configured: boolean, messages: ChatMessageRecord[] }` (last 50); `POST /api/v1/chat/messages` body `{ text: string }` (1–4000 chars else `INVALID_CHAT_TEXT`) → `{ reply, dataChanged }`, setting the `pulse-organization` cookie when `switchedOrganizationId` is returned (same options as `/api/v1/me/context`); `DELETE /api/v1/chat/messages` → `{ cleared: true }`; `POST /api/v1/chat/transcript` body `{ transcript }` → `{ text }` (never fails — falls back to raw).

All handlers follow the exact repo shape: `const correlation = correlationId(request); try { const identity = await getIdentity(request); … return json(body, {}, correlation); } catch (e) { return apiError(e, correlation); }`. Rate limiting and CSRF come free from `proxy.ts` (`/api/:path*` matcher). Chat turns can run 30–120 s — the standalone Node server has no route timeout; the client must not set one.

- [ ] **Step 1: Failing tests** (unconfigured path — no network):

```ts
import { GET as chatGet, POST as chatPost, DELETE as chatDelete } from "../app/api/v1/chat/messages/route.ts";

test("chat GET reports configured=false without a key and returns history", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const res = await chatGet(new Request("http://localhost/api/v1/chat/messages"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.configured, false);
  assert.ok(Array.isArray(body.messages));
});

test("chat POST validates text", async () => {
  const res = await chatPost(new Request("http://localhost/api/v1/chat/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "" }),
  }));
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Implement, run tests, commit:** `git commit -m "feat: chat API routes (messages, transcript)"`

## Task 16: ChatPanel UI + mount + data-changed refresh

**Files:**
- Create: `app/chat-panel.tsx` (`"use client"`, self-contained — own inline SVG icons; do not import from `page.tsx`)
- Modify: `app/page.tsx` (mount + `dataVersion` counter)
- Modify: `app/globals.css` (semantic `.chat-*` classes using existing tokens; print exclusion)
- Modify: `next.config.ts` (`Permissions-Policy: microphone=(self)` — currently `microphone=()` which blocks dictation entirely)
- Modify: `package.json` (dev dep `@types/dom-speech-recognition`)

**Interfaces:**
- Consumes: `GET/POST/DELETE /api/v1/chat/messages`, `POST /api/v1/chat/transcript` (Task 15); `react-markdown` (existing dependency) for assistant bubbles.
- Produces: `export function ChatPanel(props: { locale: string; onDataChanged: () => void }): JSX.Element`.

- [ ] **Step 1: Implement `ChatPanel`** with this exact behavior (AI.MD §4):
  - **Launcher:** fixed round 48 px `.chat-launcher`, bottom-right (`right: 22px; bottom: 76px` — clear of the toast at `bottom: 22px`), brand-gradient background, `✦` glyph flipping to `✕` when open, subtle hover scale, z-index 150 (above drawers z-100, below toast z-200).
  - **Panel:** `.chat-panel` fixed above the launcher, `width: 24rem; height: 34rem; max-width: calc(100vw - 2rem); max-height: calc(100vh - 8rem)`, rounded-2xl equivalent via existing radius token, border + shadow tokens, 180 ms translateY+opacity entry animation, `no-print` (add `@media print { .chat-panel, .chat-launcher { display: none } }`).
  - **Header:** gradient bar, "✦ Assistant" title, 🗑 clear-history button (`window.confirm` then `DELETE`), ✕ close.
  - **Message list:** scrollable; user bubbles right-aligned brand color, assistant left-aligned neutral; assistant content via `react-markdown`, user content `white-space: pre-wrap`; animated "Thinking…" bubble while busy, "Listening…" while dictating; auto-scroll effect depends on `messages.length` only — not on every keystroke.
  - **Empty states:** `configured === false` → amber `.chat-notice` "The assistant needs an API key. Ask an administrator to set ANTHROPIC_API_KEY."; empty history → two example prompts, one English ("Submit a request: exports to Excel time out for large orders") and one Icelandic ("Sýndu mér hugmyndirnar sem ég fylgist með").
  - **Input row:** auto-sizing textarea (reset height then `scrollHeight`), Enter = send / Shift+Enter = newline; 🎤 rendered only when `!!(window.SpeechRecognition || window.webkitSpeechRecognition)`; ➤ send; all disabled while busy/unconfigured.
  - **Empty-Enter = confirm:** Enter on empty input while the last message is from the assistant sends `locale === "is" ? "Já" : "Yes"`.
  - **History:** lazy-loaded on first open via `GET` (which also delivers `configured`).
  - **Send:** optimistic user bubble → `POST` → append reply → if `dataChanged`, call `props.onDataChanged()`; whole flow wrapped in try/catch appending a friendly error bubble — an assistant failure must never take down the page.
  - **Voice dictation:** direct Web Speech API in the component — `new (window.SpeechRecognition ?? window.webkitSpeechRecognition)()`, `lang = locale === "is" ? "is-IS" : "en-US"`, `interimResults = false`; on result → `POST /api/v1/chat/transcript` → send cleaned text exactly like a typed message; on error/empty → reset state; mic pulses red while listening; `useEffect(() => () => recognitionRef.current?.stop(), [])` for clean disposal.

- [ ] **Step 2: Mount in `app/page.tsx`:** add `const [dataVersion, setDataVersion] = useState(0);` in `AppShell`; append `dataVersion` to the dependency arrays of the existing identity-gated data-loading effects (requests, ideas, notifications, internal ideas/releases/audit, admin lists); render as a sibling of the toast at the bottom of the `.app-shell` JSX: `<ChatPanel locale={meUser?.locale ?? "en"} onDataChanged={() => setDataVersion((v) => v + 1)} />`. The `/api/v1/me` payload already carries `user.locale` (`getIdentityContext` selects it from `dbo.Users.locale`, values `"en"`/`"is"`), so wire the panel's `locale` prop to the `/me` state variable that holds the user object — this makes the `is-IS` dictation and Icelandic empty-Enter "Já" branches live rather than dead code. (Substitute the actual state var name AppShell uses for the `/me` user.) Mounting inside `AppShell` (not layout) means the panel appears only after `identityReady` — never over the org-chooser gate.

- [ ] **Step 3: Verify manually** (needs a real key): `ANTHROPIC_API_KEY=sk-ant-… npx next dev --port 5199` → open http://localhost:5199 → panel opens, "list my requests" returns real data, "submit a request …" creates a `DCI-####` and the requests view refreshes without a manual reload; without the key the amber notice shows and nothing crashes. Run `npm test && npm run lint`.

- [ ] **Step 4: Commit:** `git commit -m "feat: floating chat panel with voice dictation and data refresh"`

---


# Phase 3 — Slack integration

## Task 17: mrkdwn converter

**Files:**
- Create: `lib/server/slack/mrkdwn.ts`
- Create: `tests/mrkdwn.test.ts`
- Modify: `package.json` (append test file to `test` script)

**Interfaces:**
- Produces: `toMrkdwn(markdown: string): string` — pure function. Task 19 consumes it.

- [ ] **Step 1: Write the failing tests** — `tests/mrkdwn.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { toMrkdwn } from "../lib/server/slack/mrkdwn.ts";

test("escapes ampersand and angle brackets in order", () => {
  assert.equal(toMrkdwn("a & b < c > d"), "a &amp; b &lt; c &gt; d");
});
test("converts markdown links to slack form", () => {
  assert.equal(toMrkdwn("see [the request](https://x.example/r/1)"),
    "see <https://x.example/r/1|the request>");
});
test("converts bold and headings", () => {
  assert.equal(toMrkdwn("**bold** and __also__"), "*bold* and *also*");
  assert.equal(toMrkdwn("## Section"), "*Section*");
});
test("converts bullets", () => {
  assert.equal(toMrkdwn("- one\n* two"), "• one\n• two");
});
test("leaves fenced and inline code untouched", () => {
  const doc = "before\n```\n**not bold** <raw>\n```\nafter `x < y` end";
  const out = toMrkdwn(doc);
  assert.ok(out.includes("**not bold** <raw>"));
  assert.ok(out.includes("`x < y`"));
  assert.ok(out.includes("after"));
});
```

Append `tests/mrkdwn.test.ts` to the `test` script. Run `npm test` — Expected: FAIL.

- [ ] **Step 2: Implement** `toMrkdwn`: split the input on fenced blocks (```…```) and inline code (`…`), transform only the prose segments — escape `&` then `<` then `>`; `[text](url)` → `<url|text>`; `**bold**`/`__bold__` → `*bold*`; `^#{1,6}\s+(.+)$` → `*$1*` (multiline); leading `- ` / `* ` bullets → `• ` — and reassemble with code segments verbatim.

- [ ] **Step 3: Run tests** — `npm test` → PASS. **Commit:** `git commit -m "feat: markdown to slack mrkdwn converter"`

## Task 18: Slack identity mapping + event dedupe

**Files:**
- Create: `lib/server/slack/identity.ts`
- Create: `lib/server/slack/dedupe.ts`
- Test: `tests/chat.test.ts` (extend — dedupe + refusal strings; identity mapping against the in-memory user store)

**Interfaces:**
- Consumes: `getUserByEmail` (Task 11), `getIdentityContext`.
- Produces: `resolveSlackIdentity(client: { users: { info: Function } }, slackUserId: string): Promise<{ value: PulseIdentity } | { refusal: string }>`; `isDuplicate(key: string): boolean` (15-minute in-memory window, `globalThis.pulseSlackDedupe`, prunes expired entries on insert).

- [ ] **Step 1: Failing tests:**

```ts
import { isDuplicate } from "../lib/server/slack/dedupe.ts";
import { resolveSlackIdentity } from "../lib/server/slack/identity.ts";

test("dedupe: first occurrence passes, repeat within window is suppressed", () => {
  globalThis.pulseSlackDedupe = undefined;
  assert.equal(isDuplicate("C1:1626000000.000100"), false);
  assert.equal(isDuplicate("C1:1626000000.000100"), true);
});

function fakeSlackClient(email: string | null) {
  return { users: { info: async () => ({ user: { profile: { email } } }) } };
}

test("slack identity maps verified email to a Pulse user", async () => {
  const result = await resolveSlackIdentity(fakeSlackClient("bjarki@uidata.com") as never, "U123");
  assert.ok("value" in result);
  assert.equal(result.value.email, "bjarki@uidata.com");
  assert.ok(result.value.organizationId); // an active org was selected
});

test("slack identity refuses unknown emails politely", async () => {
  const result = await resolveSlackIdentity(fakeSlackClient("nobody@nowhere.example") as never, "U999");
  assert.ok("refusal" in result);
  assert.match(result.refusal, /isn't linked/);
});
```

- [ ] **Step 2: Implement.**

`dedupe.ts`:

```ts
declare global { var pulseSlackDedupe: Map<string, number> | undefined; }
const WINDOW_MS = 15 * 60_000;

export function isDuplicate(key: string): boolean {
  const map = (globalThis.pulseSlackDedupe ||= new Map());
  const now = Date.now();
  for (const [k, exp] of map) if (exp <= now) map.delete(k);
  if (map.has(key)) return true;
  map.set(key, now + WINDOW_MS);
  return false;
}
```

`identity.ts` — identity comes EXCLUSIVELY from Slack's user record (`users.info` → `profile.email`, requires the `users:read.email` scope), cached 1 h per Slack user id in `globalThis.pulseSlackEmailCache`, matched exactly against `dbo.Users.email` — never from message text:

```ts
export async function resolveSlackIdentity(client, slackUserId) {
  const email = await getVerifiedEmail(client, slackUserId); // users.info + 1h cache
  const notLinked = { refusal: "Your Slack account isn't linked to a DataCentral Pulse user. " +
    "Ask an administrator to add an account with the same email address as your Slack profile." };
  if (!email) return notLinked;
  const user = await getUserByEmail(email);
  if (!user) return notLinked;
  if (user.status !== "Active")
    return { refusal: "Your account is disabled — please contact an administrator." };

  const provisional: PulseIdentity = {
    id: user.id, email: user.email, name: user.name,
    organizationId: "", role: "Unknown", isInternal: false, // repos re-verify; never trust these fields
  };
  const ctx = await getIdentityContext(provisional); // memberships are { id, name, type, role, active }
  const active = ctx.activeOrganizationId
    ?? ctx.organizations.find((o) => o.type === "Internal")?.id
    ?? ctx.organizations[0]?.id;
  if (!active) return { refusal: "Your account has no active organization membership. Ask an administrator to add you to an organization." };
  return { value: { ...provisional, organizationId: active } };
}
```

**Verified against `identity-repository.ts`:** `getIdentityContext` **throws `FORBIDDEN`** when the user has no active membership (it does not return `activeOrganizationId: null` for the no-membership case; `null` is returned only for the *ambiguous* multi-membership case where the org hint doesn't match). So wrap the `getIdentityContext` call in try/catch and map a thrown `FORBIDDEN` to the "no active organization membership" refusal. When it returns with `activeOrganizationId: null` (multi-membership, no hint), the `?? Internal ?? first` fallback above selects one.

- [ ] **Step 3: Run tests** — `npm test` → PASS. **Commit:** `git commit -m "feat: slack identity mapping and event dedupe"`

## Task 19: Slack event handler + Socket Mode service + startup hook

**Files:**
- Create: `lib/server/slack/event-handler.ts`
- Create: `lib/server/slack/socket-service.ts`
- Create: `instrumentation.ts` (repo root)
- Modify: `next.config.ts` (`serverExternalPackages: ["@slack/bolt", "@slack/socket-mode", "@slack/web-api"]`)
- Modify: `package.json` (add `@slack/bolt@^4`)

**Interfaces:**
- Consumes: `sendChat` (Task 14), `resolveSlackIdentity`/`isDuplicate` (Task 18), `toMrkdwn` (Task 17).
- Produces: `startSlackAssistant(): Promise<void>` — no-op without both tokens, never throws; `registerSlackHandlers(app)`.

- [ ] **Step 1: Install** — `npm install @slack/bolt@^4`

- [ ] **Step 2: Implement `event-handler.ts`** (one handler for DMs and mentions):

```ts
export function registerSlackHandlers(app: App) {
  app.event("app_mention", async ({ event, client }) => {
    if (!event.user || (event as { bot_id?: string }).bot_id) return; // ignore events with no human author (bot mentions, loops)
    await handle(client, {
      channel: event.channel, ts: event.ts, threadTs: event.ts,   // mentions: always thread on the trigger
      user: event.user, text: stripMentions(event.text),
      key: event.client_msg_id || `${event.channel}:${event.ts}`,
    });
  });

  app.message(async ({ message, client }) => {
    const m = message as GenericMessageEvent;
    if (m.channel_type !== "im" || m.subtype || (m as { bot_id?: string }).bot_id || !m.user) return; // humans-in-DM only
    await handle(client, {
      channel: m.channel, ts: m.ts, threadTs: m.thread_ts,       // DMs: inline, or in-thread if asked in one
      user: m.user, text: m.text ?? "",
      key: m.client_msg_id || `${m.channel}:${m.ts}`,
    });
  });
}

async function handle(client: WebClient, msg: IncomingMsg) {
  if (isDuplicate(msg.key)) return;
  if (!msg.text.trim()) return;
  await best(() => client.reactions.add({ channel: msg.channel, timestamp: msg.ts, name: "hourglass_flowing_sand" }));
  try {
    const resolved = await resolveSlackIdentity(client, msg.user);
    if ("refusal" in resolved) { await post(client, msg, resolved.refusal); return; }
    const result = await sendChat(resolved.value, msg.text);      // same brain, history, tools, permissions
    await post(client, msg, toMrkdwn(result.reply));
  } catch (error) {
    // Log AND post (spec §5.4). Never log message text (telemetry-privacy rule) —
    // record the error class and the Slack user id only.
    console.error(JSON.stringify({ level: "error", message: "slack handler failed",
      slackUser: msg.user, error: error instanceof Error ? error.name : "unknown" }));
    await best(() => post(client, msg, "Something went wrong while handling your message. Please try again."));
  } finally {
    await best(() => client.reactions.remove({ channel: msg.channel, timestamp: msg.ts, name: "hourglass_flowing_sand" }));
  }
}

const stripMentions = (t: string) => (t ?? "").replace(/<@[^>]+>/g, "").trim();
const post = (client: WebClient, msg: IncomingMsg, text: string) =>
  client.chat.postMessage({ channel: msg.channel, thread_ts: msg.threadTs, text });
const best = (fn: () => Promise<unknown>) => fn().catch(() => undefined); // reactions are best-effort
```

`socket-service.ts`:

```ts
import pkg from "@slack/bolt";        // CJS package under "type":"module" — default-import then destructure
const { App } = pkg;

declare global { var pulseSlackApp: InstanceType<typeof App> | undefined; }

export function isSlackConfigured(): boolean {
  return Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);
}

export async function startSlackAssistant(): Promise<void> {
  if (!isSlackConfigured() || globalThis.pulseSlackApp) return;   // conditional registration + hot-reload guard
  try {
    const app = new App({
      token: process.env.SLACK_BOT_TOKEN,
      appToken: process.env.SLACK_APP_TOKEN,
      socketMode: true,
    });
    registerSlackHandlers(app);
    await app.start();
    globalThis.pulseSlackApp = app;
    console.log(JSON.stringify({ level: "info", message: "Slack Socket Mode connected" }));
  } catch {
    console.error(JSON.stringify({ level: "error", message: "Slack Socket Mode failed to start" }));
    // swallow — a bad token or Slack outage must never take the app down
  }
}
```

`instrumentation.ts` (repo root — Next calls `register()` exactly once per server-process boot, in dev, `next start`, and the standalone Docker `server.js`; the only sanctioned in-process startup hook):

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startSlackAssistant } = await import("@/lib/server/slack/socket-service");
  await startSlackAssistant();
  // Graceful disconnect on shutdown (spec §5.3). Idempotent — the guard in
  // startSlackAssistant plus this once-handler mean at most one connection and
  // one stop per process.
  const stop = () => { void globalThis.pulseSlackApp?.stop(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
```

- [ ] **Step 3: Verify** — `npm test && npm run lint` green; `npx next dev --port 5199` without tokens logs nothing Slack-related and the app runs normally; with test tokens, the log line `Slack Socket Mode connected` appears once (hot reload does not duplicate it).

- [ ] **Step 4: Commit:** `git commit -m "feat: slack socket-mode assistant with instrumentation startup"`

## Task 20: Slack manifest + setup docs + infra

**Files:**
- Create: `slack-app-manifest.yaml` (repo root)
- Create: `docs/slack-setup.md`
- Modify: `infra/main.bicep`, `.env.example`, `README.md`

- [ ] **Step 1: Manifest** — `slack-app-manifest.yaml` (AI.MD §5.2 template adapted):

```yaml
display_information:
  name: DataCentral Pulse
  description: Natural-language product feedback and roadmap — the DataCentral Pulse assistant, in Slack
  background_color: "#204242"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: pulse
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - im:history
      - im:read
      - im:write
      - reactions:write
      - users:read
      - users:read.email
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

- [ ] **Step 2: `docs/slack-setup.md`** — workspace-admin walkthrough: create app at https://api.slack.com/apps?new_app=1 → From a manifest → pick workspace → paste `slack-app-manifest.yaml`; Basic Information → App-Level Tokens → generate with scope `connections:write` → `xapp-…` = `SLACK_APP_TOKEN`; Install to Workspace → Bot User OAuth Token `xoxb-…` = `SLACK_BOT_TOKEN`; identity prerequisite (Slack profile email must exactly match the Pulse user's email); verification (DM the bot; `/invite @pulse` to a channel and mention it; expect the ⏳ reaction and a threaded reply).

- [ ] **Step 3: Infra + env.** `infra/main.bicep`: `@secure()` params `anthropicApiKey`, `slackBotToken`, `slackAppToken` (default `''`) → conditional Key Vault secrets (`if (!empty(param))`) → Key Vault-reference appSettings `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`; plain appSetting `ANTHROPIC_MODEL` (param default `claude-opus-4-8`); comment on the plan SKU: `// Slack Socket Mode + in-memory OAuth caches require a single instance — do not scale out`. `.env.example`: add commented `ANTHROPIC_API_KEY=`, `ANTHROPIC_MODEL=claude-opus-4-8`, `SLACK_BOT_TOKEN=`, `SLACK_APP_TOKEN=`. `README.md`: short "AI assistant + Slack" section linking `docs/slack-setup.md` and `configInfo.md`.

- [ ] **Step 4: Commit:** `git commit -m "feat: slack app manifest, setup docs, assistant infra wiring"`

---


---

# Self-review notes (plan author)

- **Spec coverage:** AI.MD §§1–11 → Tasks 11–20, 28–29 (voice §2.5/§4 → Tasks 14/16; Slack §5 → 17–20; config §7/§10 → 20/28). MCP-LLM-Instructions §§1–12 → Tasks 21–27 (architecture decisions preserved; §7 tool rules → Task 12; §8 per-user instructions → Tasks 13/26). DataCentralEmbedEntraAuthApp §§1–15 → Tasks 1–10 (§11 signed-dcdata path is Path 1 in Task 5; §13 chrome hiding → Task 10; §12 checklist → Tasks 10/29).
- **Deliberate deviations, called out where they occur:**
  - Pre-provisioned-only on BOTH embed and standalone paths (spec §11 allows standalone JIT — Pulse's membership model makes JIT users dead ends). Existing Entra users still match by email and keep their oid (Task 3, blocker fix).
  - No `dcdata` timestamp freshness check in v1. The `DC_SESSION_CHECK` live-session check is best-effort and only fires when the caller forwards an `accessToken`, so it is NOT a complete replay mitigation on its own; the accepted v1 posture is default `when-available` plus URL cleanup (Tasks 6/10), with a `DC_SESSION_CHECK=required` opt-in for hosts that always forward the envelope. Replay of a captured launch URL within the 12 h session TTL is a known residual risk in the default mode.
  - MCP tool mutations bypass HTTP idempotency (documented in tool descriptions; `executeIdempotent` is header-scoped).
  - Easy Auth replaced rather than coexisting (its top-level redirect breaks iframes unconditionally); `PULSE_TRUST_EASYAUTH_HEADERS` is the migration escape hatch.
  - Shared DataCentral secret lives in env/Key Vault (`DC_APP_SECRET`), not the spec's admin-UI encrypted-at-rest setting — Key Vault is an equal-or-stronger at-rest story but loses in-app rotation/visibility; the deferred admin-UI option is sketched but not built in v1.
  - `/mcp` returns 403 for a valid token whose user is inactive/unprovisioned, rather than the spec's "serve the session with a no-tools instructions string" — a 403 is a cleaner rejection and matches the anti-enumeration posture.
  - The `dataChanged` refresh signal fires only after a non-readOnly tool succeeds (not unconditionally per AI.MD §4). Rationale: a blanket refresh on every reply re-queries all open views even for pure Q&A turns. Residual gap: a mutating tool that partially applies then throws leaves views stale until the next reload — acceptable for v1; revisit if partial-apply tools are added.
  - Attachments: only read-only `list_attachments` is exposed to the assistant; binary upload/download stay UI-only.
  - Unconfigured-assistant notice is English-only (Pulse has no i18n framework; other user-facing strings that are trivially bilingual are localized).
  - In-memory (no-SQL dev) mode: the MCP probe identity and repositories inherit the demo-admin behavior of `getIdentity`'s dev fallback — dev/demo only; production always runs SQL-backed authorization. Do not run a staging box with seeded real users but `isAzureSqlConfigured() === false`. Note that memory-mode `getIdentityContext` returns a single **Customer** org, so the internal/admin tool groups never activate in dev/test — internal-tool behavior must be exercised against SQL mode (relevant to Task 29's acceptance walk).
  - `cleanTranscript` (Task 14) omits the `thinking` parameter, so on `claude-opus-4-8` it runs thinking-off — intentional for a cheap 500-token dictation-cleanup call (latency), a valid config (no 400). This is a deliberate narrowing of the "adaptive thinking on every call" constraint; `sendChat` keeps adaptive thinking.
- **Known verify-at-implementation-time items:** exact npm minor versions (`@anthropic-ai/sdk`, `@slack/bolt`, `openid-client`, `jose`, `zod`, `@modelcontextprotocol/sdk`); `getRequest`/`getIdea` public-id semantics; bolt v4 ESM interop; the MCP stateless transport's initialize handshake requirements; Easy Auth `/.auth/login/aad` fallback route; Entra External ID (CIAM) authority format if the tenant is CIAM (`{tenant}.ciamlogin.com`). *(Resolved during review: membership field names are `{id,name,type,role,active}`; `getIdentityContext` throws FORBIDDEN for no-membership and returns `activeOrganizationId: null` only for ambiguous multi-membership; the SQL pool accessor is `getSqlPool`; MCP SDK/jose API usage was empirically verified against the pinned versions.)*

---

# Review trail

This plan was adversarially verified by four critics (three spec-coverage — one per spec — plus one internal-consistency critic that read the actual codebase). All confirmed findings are folded in above: **1 blocker** (existing Entra users locked out of the embed path — Task 3 now matches by email and keeps the oid), **4 majors** (handshake-page XSS via unescaped `JSON.stringify` in an inline script; OAuth consent-page clickjacking after the global `frame-ancestors` removal; `PULSE_PUBLIC_URL` load-bearing for OAuth/OIDC URLs; the `\n`-in-template-literal handshake-script break — now `String.fromCharCode(10)`), the **`.ts`-import typecheck blocker** (Global Constraint added), and every actionable minor/note (membership field names `{id,name,type,role,active}`; `getSqlPool` not `getPool`; `NOT_PROVISIONED`→FORBIDDEN mapping in `getIdentity`; missing OAuth `OPTIONS` handlers; empty-`redirect_uris` check; `getUserById`; Slack shutdown/logging/mention-guard; `list_attachments` tool; voice locale from `user.locale`; stale forward-reference task numbers). Deliberate deviations are enumerated in the self-review above.


