# Pulse AI Chat + MCP Server + DataCentral Embed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three connected capabilities to DataCentral Pulse: (1) an in-app Claude chat assistant with voice dictation plus a Slack front-end, (2) a remote MCP server with a self-hosted OAuth 2.1 authorization server so any MCP client can act as the signed-in user, and (3) DataCentral iframe-embed authentication with standalone Entra ID login replacing App Service Easy Auth.

**Architecture:** A new app-level auth layer (jose-signed `pulse-session` cookie; Entra OIDC via openid-client for standalone; HMAC-verified `dcdata`/`dcsig` + postMessage handshake for DataCentral embeds) replaces Easy Auth and feeds the existing `PulseIdentity` → repository authorization chain unchanged. One neutral tool registry (`lib/server/chat/tool-registry.ts`) wraps the existing repository functions and is consumed by two hosts: the in-app assistant (Anthropic SDK beta Tool Runner) and the MCP endpoint (`@modelcontextprotocol/sdk` stateless Streamable HTTP), each binding tools per-request to the acting user. Slack rides the same assistant service over a Socket Mode connection started from `instrumentation.ts`.

**Tech Stack:** Next.js 16.2.6 App Router (Node runtime, standalone output, Docker on Azure App Service single instance), TypeScript strict, `mssql` (hand-written T-SQL, dual SQL/in-memory mode), `@anthropic-ai/sdk` (beta Tool Runner + `betaZodTool`), `@slack/bolt` v4 (Socket Mode), `@modelcontextprotocol/sdk` ^1.29 (`WebStandardStreamableHTTPServerTransport`), `jose` ^6, `openid-client` ^6, `zod` ^4, Node built-in test runner via `tsx`.

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

# Phase 1 — DataCentral embed + Entra auth foundation

## Task 1: Session cookie module

**Files:**
- Create: `lib/server/session.ts`
- Create: `tests/dc-auth.test.ts`
- Modify: `package.json` (add `jose`; append test file to `test` script)

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `SessionClaims` type, `SESSION_COOKIE = "pulse-session"`, `createSessionToken(claims: Omit<SessionClaims,"ver">): Promise<string>`, `readSession(request: Request): Promise<SessionClaims | null>`, `sessionSetCookie(token: string): string`, `sessionClearCookie(): string`. Tasks 5, 7, 8, 9 consume these exact names.

- [ ] **Step 1: Install dependency**

Run: `npm install jose@^6`
Expected: `jose` added to `dependencies` in `package.json`.

- [ ] **Step 2: Write the failing test**

Create `tests/dc-auth.test.ts`:

```ts
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createSessionToken, readSession, sessionSetCookie, sessionClearCookie, SESSION_COOKIE,
} from "../lib/server/session.ts";

function requestWithCookie(token: string): Request {
  return new Request("http://localhost/api/v1/me", {
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
  });
}

beforeEach(() => {
  delete process.env.PULSE_SESSION_SECRET;
});

test("session token round-trips claims", async () => {
  const token = await createSessionToken({
    sub: "11111111-1111-4111-8111-111111111111",
    email: "bjarki@uidata.com", name: "Bjarki", ext: "dev:local", amr: "dev",
  });
  const claims = await readSession(requestWithCookie(token));
  assert.ok(claims);
  assert.equal(claims.sub, "11111111-1111-4111-8111-111111111111");
  assert.equal(claims.amr, "dev");
  assert.equal(claims.ver, 1);
});

test("tampered session token is rejected", async () => {
  const token = await createSessionToken({
    sub: "11111111-1111-4111-8111-111111111111",
    email: "a@b.c", name: "A", ext: "dev:local", amr: "dev",
  });
  const claims = await readSession(requestWithCookie(token.slice(0, -2) + "xx"));
  assert.equal(claims, null);
});

test("missing cookie yields null", async () => {
  const claims = await readSession(new Request("http://localhost/"));
  assert.equal(claims, null);
});

test("set-cookie strings carry the right attributes", () => {
  const set = sessionSetCookie("abc");
  assert.match(set, /^pulse-session=abc; Path=\/; Max-Age=\d+; HttpOnly/);
  assert.match(sessionClearCookie(), /Max-Age=0/);
});
```

- [ ] **Step 3: Run test to verify it fails**

First append the file to the `test` script in `package.json` — it becomes:
`"test": "npm run typecheck && node --import tsx --test --test-concurrency=1 tests/domain.test.mjs tests/openapi.test.mjs tests/workflow.test.ts tests/dc-auth.test.ts"`

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/server/session.ts'` (typecheck failure counts).

- [ ] **Step 4: Write the implementation**

Create `lib/server/session.ts`:

```ts
import { SignJWT, jwtVerify } from "jose";

export type SessionClaims = {
  sub: string;                 // dbo.Users.id (GUID) — what repositories consume
  email: string;
  name: string;
  ext: string;                 // external subject: Entra oid | "dc:{userId}" | "dev:local"
  amr: "entra" | "dc-hmac" | "dc-graph" | "dev";
  dc_embed?: true;             // chrome-hiding claim — set once at sign-in, travels with cookie
  tid?: string;                // Entra tenant id when applicable
  ver: 1;
};

export const SESSION_COOKIE = "pulse-session";
const TTL_SECONDS = 60 * 60 * 12; // 12h; embed re-handshakes on expiry, standalone re-SSO-redirects

function secret(): Uint8Array | null {
  const s = process.env.PULSE_SESSION_SECRET;
  if (s && s.length >= 32) return new TextEncoder().encode(s);
  if (process.env.NODE_ENV !== "production")
    return new TextEncoder().encode("pulse-dev-session-secret-not-for-production");
  return null; // production without secret => session auth disabled
}

export async function createSessionToken(claims: Omit<SessionClaims, "ver">): Promise<string> {
  const key = secret();
  if (!key) throw new Error("SESSION_NOT_CONFIGURED");
  return new SignJWT({ ...claims, ver: 1 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .setIssuer("pulse")
    .setAudience("pulse")
    .sign(key);
}

export async function readSession(request: Request): Promise<SessionClaims | null> {
  const key = secret();
  if (!key) return null;
  const cookie = request.headers.get("cookie")?.split(";")
    .map((v) => v.trim().split("="))
    .find(([n]) => n === SESSION_COOKIE)?.[1];
  if (!cookie) return null;
  try {
    const { payload } = await jwtVerify(decodeURIComponent(cookie), key, {
      issuer: "pulse", audience: "pulse",
    });
    return payload.ver === 1 ? (payload as unknown as SessionClaims) : null;
  } catch {
    return null;
  }
}

// Manual Set-Cookie so we control the Partitioned attribute (CHIPS).
// SameSite=None; Secure is mandatory for the cookie to travel inside the
// cross-site DataCentral iframe; Partitioned keeps CHIPS-enforcing browsers working.
export function sessionSetCookie(token: string): string {
  const prod = process.env.NODE_ENV === "production";
  return prod
    ? `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${TTL_SECONDS}; HttpOnly; Secure; SameSite=None; Partitioned`
    : `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${TTL_SECONDS}; HttpOnly; SameSite=Lax`;
}

export function sessionClearCookie(): string {
  const prod = process.env.NODE_ENV === "production";
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly${prod ? "; Secure; SameSite=None; Partitioned" : "; SameSite=Lax"}`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all files).

- [ ] **Step 6: Commit**

```bash
git add lib/server/session.ts tests/dc-auth.test.ts package.json package-lock.json
git commit -m "feat: add jose-signed pulse-session cookie module"
```

## Task 2: DataCentral launch verification module

**Files:**
- Create: `lib/server/datacentral.ts`
- Test: `tests/dc-auth.test.ts` (extend)

**Interfaces:**
- Consumes: `node:crypto`.
- Produces: `DataCentralLaunch` type, `verifyDcLaunch(dcdata: string, dcsig: string): DataCentralLaunch | null`, `checkDcSession(launch: DataCentralLaunch, accessToken: string | undefined): Promise<"session_invalid" | "identity_mismatch" | null>`. Tasks 5 and 9 consume these exact names.

- [ ] **Step 1: Write the failing tests**

Append to `tests/dc-auth.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { verifyDcLaunch } from "../lib/server/datacentral.ts";

const TEST_SECRET = "test-dc-app-secret";
const launchPayload = {
  userId: 42, userName: "jon", userDisplayName: "Jón Jónsson", userEmail: "jon@example.is",
  tenancyName: "Origo", tenantId: 7, roleDisplayNames: ["User"], roleIds: [3],
  clientUrl: "https://app.datacentral.ai", timeStamp: "2026-07-15T09:00:00Z",
};
function sign(dcdata: string): string {
  return createHmac("sha256", TEST_SECRET).update(dcdata, "utf8").digest("base64");
}

test("verifyDcLaunch accepts a correctly signed object-form payload", () => {
  process.env.DC_APP_SECRET = TEST_SECRET;
  const dcdata = Buffer.from(JSON.stringify(launchPayload), "utf8").toString("base64");
  const launch = verifyDcLaunch(dcdata, sign(dcdata));
  assert.ok(launch);
  assert.equal(launch.userId, 42);
  assert.equal(launch.userEmail, "jon@example.is");
});

test("verifyDcLaunch accepts the legacy doubly-encoded string form", () => {
  process.env.DC_APP_SECRET = TEST_SECRET;
  const dcdata = Buffer.from(JSON.stringify(JSON.stringify(launchPayload)), "utf8").toString("base64");
  const launch = verifyDcLaunch(dcdata, sign(dcdata));
  assert.ok(launch);
  assert.equal(launch.userDisplayName, "Jón Jónsson");
});

test("verifyDcLaunch rejects a tampered signature without throwing", () => {
  process.env.DC_APP_SECRET = TEST_SECRET;
  const dcdata = Buffer.from(JSON.stringify(launchPayload), "utf8").toString("base64");
  assert.equal(verifyDcLaunch(dcdata, "AAAA"), null);              // length mismatch — must not throw
  const wrong = sign(dcdata).replace(/^./, (c) => (c === "A" ? "B" : "A"));
  assert.equal(verifyDcLaunch(dcdata, wrong), null);
});

test("verifyDcLaunch rejects when secret is unset", () => {
  delete process.env.DC_APP_SECRET;
  const dcdata = Buffer.from(JSON.stringify(launchPayload), "utf8").toString("base64");
  assert.equal(verifyDcLaunch(dcdata, sign(dcdata)), null);
});
```

Also extend the existing `beforeEach` to `delete process.env.DC_APP_SECRET;`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `lib/server/datacentral.ts`:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export type DataCentralLaunch = {
  userId: number; userName: string; userDisplayName: string; userEmail?: string;
  tenancyName: string; tenantId: number;
  roleDisplayNames: string[]; roleIds: number[];
  clientUrl: string; timeStamp: string;
  allowedGroupIds?: Array<string | number>; language?: string; theme?: string;
};

// dcsig = base64(HMAC_SHA256(secret, raw dcdata base64 string)). Sign the raw
// param value, standard base64, fixed-time compare with a length guard first
// (timingSafeEqual throws on length mismatch).
export function verifyDcLaunch(dcdata: string, dcsig: string): DataCentralLaunch | null {
  const secret = process.env.DC_APP_SECRET;
  if (!dcdata || !dcsig || !secret) return null;
  const computed = createHmac("sha256", secret).update(dcdata, "utf8").digest("base64");
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(dcsig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const decoded = Buffer.from(dcdata, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    // Legacy hosts double-encode: base64 → JSON string → JSON object.
    return (typeof parsed === "string" ? JSON.parse(parsed) : parsed) as DataCentralLaunch;
  } catch {
    return null;
  }
}

// Optional hardening: confirm the live DataCentral session using the forwarded
// accessToken. Controlled by DC_SESSION_CHECK: "off" | "when-available" (default).
export async function checkDcSession(
  launch: DataCentralLaunch,
  accessToken: string | undefined,
): Promise<"session_invalid" | "identity_mismatch" | null> {
  if (!accessToken) return null;
  const base = process.env.DC_API_BASE_URL || launch.clientUrl;
  let url: URL;
  try {
    url = new URL("/api/services/app/Session/GetCurrentLoginInformations", base);
  } catch {
    return "session_invalid";
  }
  if (url.protocol !== "https:") return "session_invalid";
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "session_invalid";
    const body = (await res.json()) as { result?: { user?: { emailAddress?: string } } };
    const sessionEmail = body?.result?.user?.emailAddress;
    if (sessionEmail && launch.userEmail &&
        sessionEmail.toLowerCase() !== launch.userEmail.toLowerCase())
      return "identity_mismatch";
    return null;
  } catch {
    return "session_invalid";
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/server/datacentral.ts tests/dc-auth.test.ts
git commit -m "feat: add DataCentral dcdata/dcsig HMAC verification"
```

## Task 3: Users migration + user directory

**Files:**
- Create: `database/migrations/008_datacentral_auth.sql`
- Create: `lib/server/user-directory.ts`
- Modify: `lib/server/admin-repository.ts` (pending external_subject on new users)
- Test: `tests/dc-auth.test.ts` (extend)

**Interfaces:**
- Consumes: `isAzureSqlConfigured`, `getSqlPool` from `lib/server/database.ts`; `DataCentralLaunch` from Task 2; the in-memory user store `globalThis.pulseMemoryUsers` seeded by `admin-repository.ts`.
- Produces: `ProvisionedUser` type `{ id: string; email: string; name: string; status: string; externalSubject: string | null }`; `resolveUserForEntra(oid: string, tenantId: string, email: string, displayName: string): Promise<ProvisionedUser>`; `resolveUserForDcLaunch(launch: DataCentralLaunch): Promise<ProvisionedUser>`. Both throw `Error("NOT_PROVISIONED")` or `Error("USER_DISABLED")`. Tasks 5 and 7 consume these exact names.

- [ ] **Step 1: Write the migration**

Create `database/migrations/008_datacentral_auth.sql`:

```sql
SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- DataCentral embed + Entra OIDC identity linkage. The GUID PK is untouched;
-- sessions carry Users.id as sub, so every repository keeps working unchanged.
ALTER TABLE dbo.Users ADD
  external_subject nvarchar(128) NULL,   -- Entra oid (lowercase GUID string), 'dc:{userId}', or 'pending:{email}'
  entra_tenant_id nvarchar(64) NULL,
  last_login_at datetime2 NULL,
  last_login_method nvarchar(32) NULL;   -- 'entra' | 'dc-hmac' | 'dc-graph'

COMMIT TRANSACTION;
GO

-- NOTE: the index and backfill below are intentionally OUTSIDE the transaction,
-- in separate GO batches. T-SQL requires a batch boundary before a statement can
-- reference a column added earlier in the same batch — a single-transaction
-- migration here fails to compile. This is the deliberate exception to the repo's
-- "wrap the whole migration in one transaction" convention; do not "fix" it.
CREATE UNIQUE NONCLUSTERED INDEX UX_Users_ExternalSubject
  ON dbo.Users(external_subject)
  WHERE external_subject IS NOT NULL;
GO

-- Backfill: the legacy Easy Auth convention was Users.id == Entra object id.
UPDATE dbo.Users
SET external_subject = LOWER(CONVERT(nvarchar(36), id))
WHERE auth_method = 'Entra ID' AND external_subject IS NULL;
GO
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/dc-auth.test.ts` (in-memory mode; the memory path matches by email against `globalThis.pulseMemoryUsers` and stamps subjects; SQL mode never auto-provisions):

```ts
import { resolveUserForDcLaunch, resolveUserForEntra } from "../lib/server/user-directory.ts";
import { listUsers, saveUser } from "../lib/server/admin-repository.ts";

const admin = {
  id: "11111111-1111-4111-8111-111111111111", email: "bjarki@uidata.com",
  name: "Bjarki", organizationId: "ORG-INTERNAL", role: "System admin", isInternal: true,
};

beforeEach(() => {
  globalThis.pulseMemoryUsers = undefined;
  globalThis.pulseMemoryOrganizations = undefined;
  globalThis.pulseMemoryAudit = undefined;
});

test("dc launch resolves a provisioned user by email and claims the dc subject", async () => {
  const users = await listUsers(admin);
  const seeded = users.find((u) => u.email === "bjarki@uidata.com");
  assert.ok(seeded);
  const user = await resolveUserForDcLaunch({
    userId: 42, userName: "bjarki@uidata.com", userDisplayName: "Bjarki",
    userEmail: "bjarki@uidata.com", tenancyName: "Origo", tenantId: 1,
    roleDisplayNames: [], roleIds: [], clientUrl: "https://app.datacentral.ai",
    timeStamp: "2026-07-15T09:00:00Z",
  });
  assert.equal(user.id, seeded.id);
  assert.equal(user.externalSubject, "dc:42");
});

test("dc launch for an unknown email throws NOT_PROVISIONED", async () => {
  await assert.rejects(
    resolveUserForDcLaunch({
      userId: 99, userName: "nobody@nowhere.example", userDisplayName: "Nobody",
      userEmail: "nobody@nowhere.example", tenancyName: "X", tenantId: 1,
      roleDisplayNames: [], roleIds: [], clientUrl: "https://app.datacentral.ai",
      timeStamp: "2026-07-15T09:00:00Z",
    }),
    /NOT_PROVISIONED/,
  );
});

test("entra resolution matches legacy id-as-oid and stamps external_subject", async () => {
  const oid = "11111111-1111-4111-8111-111111111111";
  const user = await resolveUserForEntra(oid, "tenant-1", "bjarki@uidata.com", "Bjarki");
  assert.equal(user.id, oid);
  assert.equal(user.externalSubject, oid);
});
```

Note: in-memory `resolveUserForDcLaunch`/`resolveUserForEntra` must NOT auto-provision unknown users in this test path — the memory-mode convenience auto-provisioning is gated behind `process.env.PULSE_ALLOW_DEMO_IDENTITY === "true"`; tests leave it unset.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `lib/server/user-directory.ts` not found.

- [ ] **Step 4: Write the implementation**

Create `lib/server/user-directory.ts`. Requirements (mirror the dual-mode pattern of `admin-repository.ts`):

```ts
import sql from "mssql";
import { getSqlPool, isAzureSqlConfigured } from "@/lib/server/database";
import type { DataCentralLaunch } from "@/lib/server/datacentral";

export type ProvisionedUser = {
  id: string; email: string; name: string; status: string; externalSubject: string | null;
};

export async function resolveUserForEntra(
  oid: string, tenantId: string, email: string, displayName: string,
): Promise<ProvisionedUser> { /* see resolution order below */ }

export async function resolveUserForDcLaunch(
  launch: DataCentralLaunch,
): Promise<ProvisionedUser> { /* see resolution order below */ }
```

SQL-mode resolution order, each inside a transaction with `WITH (UPDLOCK)` on the matched row before stamping. **Load-bearing rule (spec §11/§15): existing Entra users match by email and keep their real oid — the `dc:` subject is stamped ONLY on rows that have no real identity yet.** The migration backfills `external_subject = oid` for the whole legacy user base, so an email match on a subject-bearing row must sign the user in, not refuse:

*Entra (`@oid` lowercase):* ① `SELECT ... FROM dbo.Users WITH (UPDLOCK) WHERE external_subject = @oid` → ② legacy `WHERE id = TRY_CONVERT(uniqueidentifier, @oid)` → stamp `external_subject = @oid, entra_tenant_id = @tid` → ③ `WHERE email = @email`: if `external_subject IS NULL OR external_subject LIKE 'pending:%'` → claim (stamp `@oid`); if `external_subject LIKE 'dc:%'` → **upgrade** to the real oid (the synthetic subject existed only because no oid was known); if it holds a **different real oid** → throw `NOT_PROVISIONED` (never rebind between two real identities) → ④ throw `NOT_PROVISIONED`. Any matched row with `status <> 'Active'` → throw `USER_DISABLED`. Always stamp `last_login_at = SYSUTCDATETIME(), last_login_method = 'entra'`.

*DC launch* (`@subject = 'dc:' + launch.userId`, `@email = launch.userEmail ?? launch.userName`): ① `WHERE external_subject = @subject` → ② `WHERE email = @email`: if `external_subject IS NULL OR external_subject LIKE 'pending:%'` → claim (stamp `@subject`); if it holds an **Entra oid** (including every backfilled legacy row) → **sign in without touching the subject** (spec: existing Entra users keep their oid); if it holds a **different `dc:` subject** → `NOT_PROVISIONED` → ③ `NOT_PROVISIONED`. `status <> 'Active'` → `USER_DISABLED`. Stamp `last_login_method = 'dc-hmac'`.

Add a regression test pinning the blocker this ordering prevents (a backfilled Entra user must pass the DC-launch path):

```ts
test("dc launch signs in a user whose subject was backfilled to an Entra oid, without rebinding", async () => {
  const oid = "11111111-1111-4111-8111-111111111111";
  await resolveUserForEntra(oid, "tenant-1", "bjarki@uidata.com", "Bjarki"); // stamps the real oid
  const user = await resolveUserForDcLaunch({
    userId: 77, userName: "bjarki@uidata.com", userDisplayName: "Bjarki",
    userEmail: "bjarki@uidata.com", tenancyName: "Origo", tenantId: 1,
    roleDisplayNames: [], roleIds: [], clientUrl: "https://app.datacentral.ai",
    timeStamp: "2026-07-15T09:00:00Z",
  });
  assert.equal(user.id, oid);
  assert.equal(user.externalSubject, oid); // oid kept — NOT rebound to dc:77
});
```

Memory-mode: search `globalThis.pulseMemoryUsers` (the same store `admin-repository.ts` seeds — reuse its seeding function by importing `listUsers`-adjacent internals or duplicating the seed guard) by ① subject, ② **legacy id-as-oid** (Entra path: `user.id === @oid` → stamp `external_subject = @oid`, matching the SQL step ②), then ③ email, with the same claim/disabled semantics; if not found AND `process.env.PULSE_ALLOW_DEMO_IDENTITY === "true"`, auto-provision an Active user into the store (dev convenience); else throw `NOT_PROVISIONED`. Include step ② so the "matches legacy id-as-oid" test exercises the id path rather than passing vacuously through the email claim.

Also modify `lib/server/admin-repository.ts` `saveUser`: when creating a **new** user without a known subject, set `external_subject = 'pending:' + email.toLowerCase()` (SQL: extra column in the INSERT; memory: extra field). This is the pre-provisioning surface the claim query accepts.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add database/migrations/008_datacentral_auth.sql lib/server/user-directory.ts lib/server/admin-repository.ts tests/dc-auth.test.ts
git commit -m "feat: add user identity linkage (external_subject) and pre-provisioned user resolution"
```

## Task 4: Graph token validator

**Files:**
- Create: `lib/server/graph-validate.ts`

**Interfaces:**
- Consumes: `fetch`, env `AUTH_ENTRA_TENANT_ID`.
- Produces: `validateGraphToken(token: string): Promise<{ oid: string; upn: string; displayName: string; tid: string } | null>`. Task 5 consumes it.

- [ ] **Step 1: Write the implementation** (no unit test — it is a thin fetch wrapper; it is covered by Task 5's handler test via the invalid-token path)

Create `lib/server/graph-validate.ts`:

```ts
// A Graph access token's audience is Graph, not this app — validate it by USING it:
// a successful GET /me proves it is a live Entra token. Accepted as identity proof
// ONLY because it arrives over the trusted DataCentral iframe handshake AND the
// tenant is pinned. Never expose this as a general API.
export async function validateGraphToken(token: string): Promise<
  { oid: string; upn: string; displayName: string; tid: string } | null
> {
  const pinnedTenant = process.env.AUTH_ENTRA_TENANT_ID;
  const tid = readTid(token);
  if (pinnedTenant && tid && tid.toLowerCase() !== pinnedTenant.toLowerCase()) return null;
  try {
    const res = await fetch(
      "https://graph.microsoft.com/v1.0/me?$select=id,userPrincipalName,displayName",
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: string; userPrincipalName?: string; displayName?: string };
    if (!body.id) return null;
    return {
      oid: body.id,
      upn: body.userPrincipalName ?? "",
      displayName: body.displayName ?? body.userPrincipalName ?? "",
      tid: tid ?? "",
    };
  } catch {
    return null;
  }
}

// Best-effort decode of the JWT payload "tid" claim; null when not a decodable JWT.
function readTid(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json.tid === "string" ? json.tid : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/server/graph-validate.ts
git commit -m "feat: add Graph /me token validator with tenant pin"
```

## Task 5: /dc-auth token exchange route

**Files:**
- Create: `app/dc-auth/route.ts`
- Test: `tests/dc-auth.test.ts` (extend)

**Interfaces:**
- Consumes: `verifyDcLaunch`, `checkDcSession` (Task 2), `validateGraphToken` (Task 4), `resolveUserForDcLaunch`, `resolveUserForEntra` (Task 3), `createSessionToken`, `sessionSetCookie` (Task 1).
- Produces: `POST /dc-auth` accepting JSON `{ dcData?, dcSig?, accessToken?, graphToken?, aadToken? }` (with `X-DC-Data`/`X-DC-Sig` header fallback), returning 200 + `Set-Cookie` on success; 400 `missing_credentials`; 401 `invalid_signature` / `invalid_token` / `session_invalid` / `identity_mismatch`; 403 `not_provisioned` / `disabled`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/dc-auth.test.ts`:

```ts
import { POST as dcAuthPost } from "../app/dc-auth/route.ts";

function dcAuthRequest(body: unknown): Request {
  return new Request("http://localhost/dc-auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("dc-auth with no credentials returns 400", async () => {
  const res = await dcAuthPost(dcAuthRequest({}));
  assert.equal(res.status, 400);
});

test("dc-auth with a bad signature returns 401", async () => {
  process.env.DC_APP_SECRET = TEST_SECRET;
  const dcdata = Buffer.from(JSON.stringify(launchPayload), "utf8").toString("base64");
  const res = await dcAuthPost(dcAuthRequest({ dcData: dcdata, dcSig: "bogus" + sign(dcdata).slice(5) }));
  assert.equal(res.status, 401);
});

test("dc-auth signed payload for provisioned user returns 200 with session cookie", async () => {
  process.env.DC_APP_SECRET = TEST_SECRET;
  process.env.DC_SESSION_CHECK = "off";
  const payload = { ...launchPayload, userEmail: "bjarki@uidata.com", userName: "bjarki@uidata.com" };
  const dcdata = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const res = await dcAuthPost(dcAuthRequest({ dcData: dcdata, dcSig: sign(dcdata) }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie") ?? "", /^pulse-session=/);
});

test("dc-auth signed payload for unknown user returns 403 not_provisioned", async () => {
  process.env.DC_APP_SECRET = TEST_SECRET;
  process.env.DC_SESSION_CHECK = "off";
  const payload = { ...launchPayload, userEmail: "nobody@nowhere.example", userName: "nobody@nowhere.example" };
  const dcdata = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const res = await dcAuthPost(dcAuthRequest({ dcData: dcdata, dcSig: sign(dcdata) }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "not_provisioned");
});
```

Extend `beforeEach`: also `delete process.env.DC_SESSION_CHECK;`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — route module not found.

- [ ] **Step 3: Write the implementation**

Create `app/dc-auth/route.ts`:

```ts
import { verifyDcLaunch, checkDcSession } from "@/lib/server/datacentral";
import { validateGraphToken } from "@/lib/server/graph-validate";
import { resolveUserForDcLaunch, resolveUserForEntra } from "@/lib/server/user-directory";
import { createSessionToken, sessionSetCookie } from "@/lib/server/session";

type Body = { dcData?: string; dcSig?: string; accessToken?: string; graphToken?: string; aadToken?: string };

const fail = (status: number, error: string) => Response.json({ error }, { status });

function provisioningError(e: unknown): Response | null {
  const code = e instanceof Error ? e.message : "";
  if (code === "NOT_PROVISIONED") return fail(403, "not_provisioned");
  if (code === "USER_DISABLED") return fail(403, "disabled");
  return null;
}

// The credential entry point for embedded sessions. Anonymous by design.
// NOTE: Task 8's proxy short-circuits /dc-auth BEFORE its /api CSRF block, so this
// handler carries its own inline same-origin guard (the /dc-embed fetch is genuinely
// same-origin — Origin is the app origin even inside the DataCentral iframe — so the
// guard is transparent to the legitimate flow while blocking cross-site login-CSRF).
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  const secFetchSite = request.headers.get("sec-fetch-site");
  if ((origin && new URL(origin).host !== new URL(request.url).host) ||
      secFetchSite === "cross-site")
    return fail(403, "cross_site_rejected");

  let body: Body = {};
  try { body = await request.json(); } catch { /* fall through to header fallback */ }
  const dcData = body.dcData ?? request.headers.get("x-dc-data") ?? undefined;
  const dcSig = body.dcSig ?? request.headers.get("x-dc-sig") ?? undefined;
  const graph = body.graphToken ?? body.aadToken;

  // Path 1 (FIRST): signed dcdata — universal, covers Entra AND external/OTP users.
  if (dcData && dcSig && process.env.DC_APP_SECRET) {
    const launch = verifyDcLaunch(dcData, dcSig);
    if (!launch) return fail(401, "invalid_signature");
    if (process.env.DC_SESSION_CHECK !== "off" && body.accessToken) {
      const err = await checkDcSession(launch, body.accessToken);
      if (err) return fail(401, err);
    }
    let user;
    try { user = await resolveUserForDcLaunch(launch); }
    catch (e) { const r = provisioningError(e); if (r) return r; throw e; }
    const token = await createSessionToken({
      sub: user.id, email: user.email, name: user.name,
      ext: user.externalSubject ?? `dc:${launch.userId}`, amr: "dc-hmac", dc_embed: true,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": sessionSetCookie(token) },
    });
  }

  // Path 2 (fallback): Graph token — Entra users only.
  if (graph) {
    const id = await validateGraphToken(graph);
    if (!id) return fail(401, "invalid_token");
    let user;
    try { user = await resolveUserForEntra(id.oid, id.tid, id.upn, id.displayName); }
    catch (e) { const r = provisioningError(e); if (r) return r; throw e; }
    const token = await createSessionToken({
      sub: user.id, email: user.email, name: user.name,
      ext: id.oid, amr: "dc-graph", dc_embed: true, tid: id.tid,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": sessionSetCookie(token) },
    });
  }

  return fail(400, "missing_credentials");
}
```

Hardening knob (record in configInfo.md): support `DC_SESSION_CHECK=required` as a third mode that rejects HMAC-only posts carrying no `accessToken` — closes the launch-URL replay window for DataCentral hosts that always forward the envelope. Default stays `when-available` (the spec's own pseudocode is equally lenient; replay exposure in the default mode is an accepted v1 posture, mitigated by URL cleanup in Tasks 6/10).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/dc-auth/route.ts tests/dc-auth.test.ts
git commit -m "feat: add /dc-auth token exchange (signed dcdata first, Graph fallback)"
```

## Task 6: /dc-embed handshake page

**Files:**
- Create: `app/dc-embed/route.ts`
- Test: `tests/dc-auth.test.ts` (extend)

**Interfaces:**
- Consumes: env `DC_ALLOWED_PARENT_ORIGINS`.
- Produces: `GET /dc-embed?returnUrl=…` → 200 HTML handshake page.

- [ ] **Step 1: Write the failing tests**

Append to `tests/dc-auth.test.ts`:

```ts
import { GET as dcEmbedGet } from "../app/dc-embed/route.ts";

test("dc-embed page contains both AppReady spellings, forwarding, and _top fallback", async () => {
  const res = await dcEmbedGet(new Request("http://localhost/dc-embed?returnUrl=%2F%3Fdcdata%3Dabc%26dcsig%3Ddef"));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('{ type: "AppReady " }'), "AppReady WITH trailing space");
  assert.ok(html.includes('{ type: "AppReady"  }') || html.includes('{ type: "AppReady" }'), "AppReady without space");
  assert.ok(html.includes("/dc-auth"));
  assert.ok(html.includes('target="_top"'));
  assert.ok(html.includes("dcdata"));
});

test("dc-embed rejects non-local returnUrl (open redirect guard)", async () => {
  const res = await dc
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test` — Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

Create `app/dc-embed/route.ts`. Handler:

```ts
export const dynamic = "force-dynamic";

// XSS guard: JSON.stringify alone is NOT safe inside an inline <script> — a
// returnUrl like "/</script><script>…" passes the local-URL check, terminates the
// script element, and executes (CSP allows 'unsafe-inline'). Escape <, >, & and the
// JS line separators after stringifying, and use replacement FUNCTIONS so "$&"-style
// patterns in the value are not interpreted by String.prototype.replace.
function jsStringLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let returnUrl = url.searchParams.get("returnUrl") || "/";
  if (!returnUrl.startsWith("/") || returnUrl.startsWith("//")) returnUrl = "/";
  const origins = (process.env.DC_ALLOWED_PARENT_ORIGINS || "https://app.datacentral.ai")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const html = HANDSHAKE_HTML
    .replace("__ORIGINS__", () => jsStringLiteral(origins))
    .replace("__RETURN__", () => jsStringLiteral(returnUrl));
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
```

`HANDSHAKE_HTML` is a module-level **template-literal** constant (backticks) with this exact content (`__ORIGINS__`/`__RETURN__` replaced server-side so the JS braces stay literal). **Backslash caution:** inside a JS/TS template literal, `\n`/`\t`/etc. are escape sequences — this HTML deliberately contains no bare backslash escapes (the diagnostic join uses `String.fromCharCode(10)` precisely to avoid one). If you add any `\`-containing string to the inline script, write it as `\\` in the template literal, or the emitted browser script will mis-parse and the whole handshake silently dies (Task 6's substring tests would still pass). A `tests/dc-auth.test.ts` assertion that the served HTML contains `String.fromCharCode(10)` (not a raw newline) guards this.

```html
<!doctype html><html><head><meta charset="utf-8"><title>Connecting…</title>
<style>body{font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;color:#444}
#fb{display:none;max-width:420px;text-align:center}</style></head><body>
<p id="wait">Connecting to DataCentral…</p>
<div id="fb"><p>Could not sign you in automatically.</p>
  <p><a href="/" target="_top">Open Pulse sign-in</a></p><pre id="diag" style="text-align:left;font-size:11px;color:#999"></pre></div>
<script>
(function () {
  var ALLOWED = __ORIGINS__, RETURN = __RETURN__;
  var done = false, log = [];
  function rec(s){ log.push(s); try{console.log("[dc-embed] "+s);}catch(e){} }
  function isAllowed(o){
    if (ALLOWED.indexOf(o) !== -1) return true;
    try { return new URL(o).hostname.endsWith(".datacentral.ai"); } catch(e){ return false; }
  }
  function showFallback(reason){
    rec("fallback: "+reason);
    document.getElementById("wait").style.display="none";
    var fb=document.getElementById("fb"); fb.style.display="block";
    document.getElementById("diag").textContent = log.join(String.fromCharCode(10));
  }
  // Loop guard: if cookies are blocked, /dc-auth "succeeds" but the reload bounces back here.
  var attempts = 0;
  try { attempts = parseInt(sessionStorage.getItem("dc-embed-attempts")||"0",10)+1;
        sessionStorage.setItem("dc-embed-attempts", String(attempts)); } catch(e){}
  if (attempts > 2) { showFallback("cookie appears blocked in this browser (attempt "+attempts+")"); return; }

  // dcdata/dcsig ride on the returnUrl (proxy preserved the original query) and/or our own URL.
  var here = new URL(location.href), ru = new URL(RETURN, location.origin);
  var DCDATA = here.searchParams.get("dcdata") || ru.searchParams.get("dcdata");
  var DCSIG  = here.searchParams.get("dcsig")  || ru.searchParams.get("dcsig");

  function authenticate(body, src){
    if (done) return; done = true;
    rec("POST /dc-auth ("+src+")");
    fetch("/dc-auth", { method:"POST", credentials:"include",
      headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) })
    .then(function(res){
      if (res.ok){ try{sessionStorage.removeItem("dc-embed-attempts");}catch(e){}
        ru.searchParams.delete("dcdata"); ru.searchParams.delete("dcsig");
        location.replace(ru.pathname + ru.search + ru.hash); return; }
      return res.text().then(function(t){ done=false; showFallback("/dc-auth "+res.status+" "+t); });
    }).catch(function(e){ done=false; showFallback("/dc-auth failed: "+e); });
  }

  window.addEventListener("message", function (event) {
    var d = event.data || {};
    rec("message from "+event.origin+(isAllowed(event.origin)?"":" [ORIGIN NOT ALLOWED]"));
    if (!isAllowed(event.origin)) return;
    var dcToken = d.accessToken || (d.type === "AccessToken" ? d.token : null);
    var graph   = d.graphToken  || d.aadToken;
    if (dcToken || graph)
      authenticate({ dcData: DCDATA, dcSig: DCSIG, accessToken: dcToken, graphToken: graph },
                   graph ? "envelope+graph" : "envelope");
  });

  function sendReady(){
    if (!window.parent || window.parent === window){ location.replace(RETURN); return; }
    window.parent.postMessage({ type: "AppReady " }, "*");
    window.parent.postMessage({ type: "AppReady"  }, "*");
    rec("sent AppReady");
  }
  if (document.readyState === "complete") sendReady();
  else window.addEventListener("load", sendReady);
  setTimeout(sendReady, 250); setTimeout(sendReady, 1000);

  // A signed payload is sufficient alone — POST after a short grace even if no envelope arrives.
  if (DCDATA && DCSIG) setTimeout(function(){
    if (!done) authenticate({ dcData: DCDATA, dcSig: DCSIG }, "hmac-only");
  }, 1500);
  setTimeout(function(){ if (!done) showFallback("timed out waiting for a token"); }, 8000);
})();
</script></body></html>
```

The trailing space in `{ type: "AppReady " }` is intentional and load-bearing — DataCentral's parent does an exact string compare. Do not "fix" it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/dc-embed/route.ts tests/dc-auth.test.ts
git commit -m "feat: add /dc-embed postMessage handshake page"
```

## Task 7: Standalone Entra OIDC login

**Files:**
- Create: `lib/server/entra-oidc.ts`
- Create: `app/auth/login/route.ts`
- Create: `app/auth/callback/route.ts`
- Create: `app/auth/logout/route.ts`
- Create: `app/auth/error/page.tsx`
- Modify: `package.json` (add `openid-client@^6`)

**Interfaces:**
- Consumes: `openid-client` v6 (fetch-based API — NOT the v5 `Issuer.discover` shapes), `jose` (transient `pulse-oidc` state cookie), `resolveUserForEntra` (Task 3), `createSessionToken`/`sessionSetCookie`/`sessionClearCookie` (Task 1). Env: `AUTH_ENTRA_TENANT_ID`, `AUTH_ENTRA_CLIENT_ID`, `AUTH_ENTRA_CLIENT_SECRET`, `PULSE_PUBLIC_URL`.
- Produces: `GET /auth/login?returnUrl=…` → 302 to Entra authorize URL (PKCE S256 + state + nonce, scope `openid profile email`); `GET /auth/callback` → code exchange → session cookie → 302 to returnUrl; `/auth/logout` clears the cookie (GET also 302 to Entra logout); `/auth/error?code=not_provisioned|disabled|oidc_failed` static page. Task 8's proxy and Task 25's `requireBrowserIdentity` redirect here.

- [ ] **Step 1: Install dependency**

Run: `npm install openid-client@^6`

- [ ] **Step 2: Write `lib/server/entra-oidc.ts`**

```ts
import * as oidc from "openid-client";

declare global { var pulseOidcConfig: Promise<oidc.Configuration> | undefined; }

export function isEntraConfigured(): boolean {
  return Boolean(process.env.AUTH_ENTRA_TENANT_ID && process.env.AUTH_ENTRA_CLIENT_ID
    && process.env.AUTH_ENTRA_CLIENT_SECRET);
}

// Discovery against the tenant-specific v2.0 authority pins the issuer to the tenant.
export function getOidcConfig(): Promise<oidc.Configuration> {
  globalThis.pulseOidcConfig ||= oidc.discovery(
    new URL(`https://login.microsoftonline.com/${process.env.AUTH_ENTRA_TENANT_ID}/v2.0`),
    process.env.AUTH_ENTRA_CLIENT_ID!,
    process.env.AUTH_ENTRA_CLIENT_SECRET!,
  );
  return globalThis.pulseOidcConfig;
}

export function redirectUri(): string {
  return new URL("/auth/callback", process.env.PULSE_PUBLIC_URL || "http://localhost:3000").toString();
}
```

- [ ] **Step 3: Write the login route** — `app/auth/login/route.ts`

Behavior (openid-client v6 API): sanitize `returnUrl` (must start with `/`, not `//`, else `/`); if `!isEntraConfigured()` → 302 to `/auth/error?code=oidc_failed`. Otherwise:

```ts
const config = await getOidcConfig();
const codeVerifier = oidc.randomPKCECodeVerifier();
const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
const state = oidc.randomState();
const nonce = oidc.randomNonce();
const authUrl = oidc.buildAuthorizationUrl(config, {
  redirect_uri: redirectUri(), scope: "openid profile email",
  code_challenge: codeChallenge, code_challenge_method: "S256", state, nonce,
});
```

Persist `{ cv: codeVerifier, state, nonce, ru: returnUrl }` in a signed JWT cookie `pulse-oidc` (jose HS256 with the session secret; `HttpOnly; SameSite=Lax; Max-Age=600`, `Secure` in prod — Lax is correct: the callback is a top-level GET navigation). Return 302 to `authUrl`.

- [ ] **Step 4: Write the callback route** — `app/auth/callback/route.ts`

Read + verify the `pulse-oidc` cookie (missing/expired → 302 `/auth/login`); then:

```ts
const tokens = await oidc.authorizationCodeGrant(config, new URL(request.url), {
  pkceCodeVerifier: cv, expectedState: state, expectedNonce: nonce,
});
const c = tokens.claims()!; // oid, tid, preferred_username, name, email?
```

Assert `c.tid === process.env.AUTH_ENTRA_TENANT_ID` (belt-and-braces) else 302 `/auth/error?code=oidc_failed`. Then `resolveUserForEntra(String(c.oid), String(c.tid), String(c.email ?? c.preferred_username), String(c.name ?? c.preferred_username))`; on `NOT_PROVISIONED` → 302 `/auth/error?code=not_provisioned`; on `USER_DISABLED` → 302 `/auth/error?code=disabled`. Else mint the session (`amr: "entra"`, `ext: oid`, `tid`, **no** `dc_embed`), respond 302 to `ru` with two Set-Cookie headers: the session cookie and an expiring `pulse-oidc`.

- [ ] **Step 5: Write logout route + error page**

`app/auth/logout/route.ts`: `POST` → 200 `{ ok: true }` + `sessionClearCookie()`. `GET` → 302 to `https://login.microsoftonline.com/${AUTH_ENTRA_TENANT_ID}/oauth2/v2.0/logout?post_logout_redirect_uri=${PULSE_PUBLIC_URL}` + clear cookie.

`app/auth/error/page.tsx`: server component; read `searchParams.code`; whitelist map — `not_provisioned` → "Your account has not been set up in Pulse yet. Ask a DataCentral administrator to add you (same email address)."; `disabled` → "Your account is disabled — please contact an administrator."; anything else → "Sign-in failed. Please try again." Static, no identifying detail, no external links.

- [ ] **Step 6: Typecheck + run tests**

Run: `npm test`
Expected: PASS (no new tests here — OIDC round-trip needs live Entra; verified in Task 10's checklist).

- [ ] **Step 7: Commit**

```bash
git add lib/server/entra-oidc.ts app/auth package.json package-lock.json
git commit -m "feat: add standalone Entra OIDC login via openid-client"
```

## Task 8: Route gate in proxy.ts + runtime frame-ancestors

**Files:**
- Modify: `proxy.ts`
- Modify: `next.config.ts` (remove `frame-ancestors 'self'` from the static CSP)
- Test: `tests/dc-auth.test.ts` (extend — embed-detection predicate)

**Interfaces:**
- Consumes: `readSession` (Task 1).
- Produces: page-gate behavior — unauthenticated `GET /` goes to `/auth/login?returnUrl=…` (top-level) or `/dc-embed?returnUrl=…` (embed detected); exported `isEmbedRequest(request: NextRequest): boolean` for testability. Existing `/api/*` CSRF + rate-limit logic unchanged.

- [ ] **Step 1: Write the failing test**

```ts
import { isEmbedRequest } from "../proxy.ts";
import { NextRequest } from "next/server";

test("embed detection: dcdata param or Sec-Fetch-Dest iframe", () => {
  assert.equal(isEmbedRequest(new NextRequest("http://localhost/?dcdata=x")), true);
  assert.equal(isEmbedRequest(new NextRequest("http://localhost/", {
    headers: { "sec-fetch-dest": "iframe" } })), true);
  assert.equal(isEmbedRequest(new NextRequest("http://localhost/")), false);
});
```

Run: `npm test` — Expected: FAIL (`isEmbedRequest` not exported).

- [ ] **Step 2: Implement the proxy changes**

In `proxy.ts` (keep every existing line of the CSRF/rate-limit logic for `/api/*`):

1. Widen matcher: `export const config = { matcher: ["/api/:path*", "/", "/dc-embed", "/dc-auth", "/auth/:path*", "/mcp", "/oauth/:path*"] };` (`/mcp` and `/oauth/*` are matched only so the proxy can stamp `frame-ancestors 'none'` on them — they self-authenticate and are excluded from the `/api` CSRF/rate-limit branch).
2. Add and export:

```ts
export function isEmbedRequest(request: NextRequest): boolean {
  return request.nextUrl.searchParams.has("dcdata") ||
    request.headers.get("sec-fetch-dest")?.toLowerCase() === "iframe";
}
```

3. Make `proxy` async. At the top, handle non-API paths:

```ts
const FRAME_ANCESTORS = process.env.DC_FRAME_ANCESTORS || "'self' https://*.datacentral.ai";

if (!path.startsWith("/api")) {
  const withFraming = (r: NextResponse) => {
    r.headers.set("content-security-policy", `frame-ancestors ${FRAME_ANCESTORS}`);
    return r;
  };
  // frame-ancestors 'none' on OAuth pages — the /oauth/authorize consent button
  // grants a full-power MCP token, so it must NEVER be frameable (anti-clickjacking).
  const denyFraming = (r: NextResponse) => {
    r.headers.set("content-security-policy", "frame-ancestors 'none'");
    return r;
  };
  if (path === "/mcp" || path.startsWith("/oauth"))
    return denyFraming(NextResponse.next());                    // MCP/OAuth: never framed, and self-authenticating
  if (path === "/dc-embed" || path === "/dc-auth" || path.startsWith("/auth"))
    return withFraming(NextResponse.next());                     // anonymous endpoints (embed needs DataCentral framing)
  const localAllowed = process.env.NODE_ENV !== "production" ||
    process.env.PULSE_ALLOW_DEMO_IDENTITY === "true";
  const session = await readSession(request);
  if (!session && !localAllowed && process.env.PULSE_SESSION_SECRET) {
    const returnUrl = request.nextUrl.pathname + request.nextUrl.search;
    const target = isEmbedRequest(request)
      ? `/dc-embed?returnUrl=${encodeURIComponent(returnUrl)}`   // intercept the challenge — never redirect an iframe to Entra
      : `/auth/login?returnUrl=${encodeURIComponent(returnUrl)}`;
    // Resolve against PULSE_PUBLIC_URL when set so App Service TLS termination
    // doesn't yield an http:// Location the Secure session cookie won't accompany.
    const base = process.env.PULSE_PUBLIC_URL || request.url;
    return NextResponse.redirect(new URL(target, base));
  }
  return withFraming(NextResponse.next());
}
```

Widen the matcher to include `/mcp` and `/oauth/:path*` **for the framing header only** — these paths still self-authenticate (bearer token / app sign-in) and are NOT subject to the `/api` CSRF or rate-limit block, which the proxy applies only under the `path.startsWith("/api")` branch. The `denyFraming` early-return runs before any CSRF logic, so `/oauth`'s cross-origin MCP POSTs are unaffected. Updated matcher: `["/api/:path*", "/", "/dc-embed", "/dc-auth", "/auth/:path*", "/mcp", "/oauth/:path*"]`.

Loop-safety: once the cookie is set, `readSession` succeeds and the interception never fires — no redirect loop. In `next.config.ts`, edit the CSP header value to remove `frame-ancestors 'self'` (all other directives unchanged) — `frame-ancestors` is now emitted solely by the proxy at runtime (two CSP headers combine by intersection; a CSP without the directive imposes no framing restriction). Any unmatched page path ships no framing header; that is acceptable because the only sensitive rendered pages (`/`, `/oauth/*`) are matched — but note it in `docs/architecture.md` as a follow-up to add a deny-by-default catch-all if new top-level pages are introduced.

- [ ] **Step 3: Run tests, typecheck, lint**

Run: `npm test && npm run lint` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add proxy.ts next.config.ts tests/dc-auth.test.ts
git commit -m "feat: gate pages on session, intercept embed challenge, runtime frame-ancestors"
```

## Task 9: getIdentity async refactor + getCurrentUser

**Files:**
- Modify: `lib/server/auth.ts` (async, new credential order)
- Modify: `lib/domain.ts` (`PulseIdentity` additive fields)
- Create: `lib/server/current-user.ts`
- Modify: all 43 route files under `app/api/v1/**` (mechanical `await getIdentity(request)` — 62 call sites; handlers are already async)
- Modify: `app/api/v1/me/route.ts` + `app/api/v1/me/context/route.ts` (`pulse-organization` cookie → `SameSite=None; Secure; Partitioned` in prod; `/me` response gains `authMethod`, `dcEmbed`, `isVerified`)
- Delete: `app/chatgpt-auth.ts` (orphaned scaffold)
- Test: `tests/dc-auth.test.ts` (extend)

**Interfaces:**
- Consumes: `readSession` (Task 1), `verifyDcLaunch` + `resolveUserForDcLaunch` (Tasks 2–3).
- Produces: `getIdentity(request: Request): Promise<PulseIdentity>` — credential order: ① `pulse-session` cookie ② `X-DC-Data`/`X-DC-Sig` headers (per-request re-verification) ③ Easy Auth headers only when `PULSE_TRUST_EASYAUTH_HEADERS === "true"` ④ demo fallback (unchanged condition) ⑤ throw `UNAUTHORIZED`. `PulseIdentity` gains `dcEmbed?: boolean; authMethod?: "entra"|"dc-hmac"|"dc-graph"|"easyauth"|"dev"; isVerified?: boolean`. `getCurrentUser(request): Promise<CurrentUser>` where `CurrentUser = { identity, userId, email, name, authMethod, isVerified, dcEmbed, activeOrganizationId, memberships }` — a convenience wrapper (`getIdentity` + `getIdentityContext` merged) used by the **`/api/v1/me` route** (which needs `authMethod`/`dcEmbed`/`isVerified` alongside the membership context). Phases 2–4 mostly call `getIdentity` and `getIdentityContext` directly (routes need the raw `getIdentity` for the `correlationId`/`apiError` shape; `sendChat`/Slack build their own identity), so do NOT refactor those to route through `getCurrentUser` — it exists to keep the `/me` handler tidy, not as a mandatory chokepoint.

- [ ] **Step 1: Write the failing tests**

```ts
import { getIdentity } from "../lib/server/auth.ts";

test("getIdentity resolves a session cookie to the session user", async () => {
  const token = await createSessionToken({
    sub: "11111111-1111-4111-8111-111111111111", email: "bjarki@uidata.com",
    name: "Bjarki", ext: "dev:local", amr: "entra",
  });
  const identity = await getIdentity(requestWithCookie(token));
  assert.equal(identity.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(identity.authMethod, "entra");
  assert.equal(identity.isVerified, true);
});

test("getIdentity falls back to demo identity outside production", async () => {
  const identity = await getIdentity(new Request("http://localhost/api/v1/me"));
  assert.equal(identity.authMethod, "dev");
  assert.equal(identity.isVerified, false);
});
```

Run: `npm test` — Expected: FAIL (getIdentity is sync; fields missing).

- [ ] **Step 2: Implement**

`lib/domain.ts` — extend `PulseIdentity` with the three optional fields (additive; no existing call site breaks).

`lib/server/auth.ts` — new body (preserve the existing org-hint resolution: `x-pulse-organization-id` header → `pulse-organization` cookie → `ORG-001` dev fallback; the active organization stays a request hint that repositories re-verify):

```ts
export async function getIdentity(request: Request): Promise<PulseIdentity> {
  const orgHint = resolveOrgHint(request); // existing header/cookie parsing, extracted to a helper

  const session = await readSession(request);
  if (session) return {
    id: session.sub, email: session.email, name: session.name,
    organizationId: orgHint, role: "Unknown", isInternal: false,
    dcEmbed: Boolean(session.dc_embed), authMethod: session.amr, isVerified: true,
  };

  const dcData = request.headers.get("x-dc-data");
  const dcSig = request.headers.get("x-dc-sig");
  if (dcData && dcSig) {
    const launch = verifyDcLaunch(dcData, dcSig);
    if (launch) {
      // Map provisioning errors to codes apiError understands — otherwise
      // NOT_PROVISIONED/USER_DISABLED fall through apiError's default → 500.
      let user;
      try { user = await resolveUserForDcLaunch(launch); }
      catch (e) {
        const code = e instanceof Error ? e.message : "";
        if (code === "NOT_PROVISIONED" || code === "USER_DISABLED") throw new Error("FORBIDDEN");
        throw e;
      }
      return { id: user.id, email: user.email, name: user.name,
        organizationId: orgHint, role: "Unknown", isInternal: false,
        dcEmbed: true, authMethod: "dc-hmac", isVerified: true };
    }
  }

  if (process.env.PULSE_TRUST_EASYAUTH_HEADERS === "true") {
    /* existing x-ms-client-principal* parsing, tagged authMethod: "easyauth", isVerified: true */
  }

  const localAllowed = process.env.NODE_ENV !== "production" ||
    process.env.PULSE_ALLOW_DEMO_IDENTITY === "true";
  if (localAllowed) return {
    id: "11111111-1111-4111-8111-111111111111", email: "bjarki@uidata.com",
    name: "Bjarki Kristjánsson", organizationId: orgHint || "ORG-001",
    role: "System admin", isInternal: true,
    dcEmbed: false, authMethod: "dev", isVerified: false,
  };

  throw new Error("UNAUTHORIZED");
}
```

`lib/server/current-user.ts`:

```ts
import { getIdentity } from "@/lib/server/auth";
import { getIdentityContext } from "@/lib/server/identity-repository";
import type { PulseIdentity } from "@/lib/domain";

export type CurrentUser = {
  identity: PulseIdentity;
  userId: string; email: string; name: string;
  authMethod: NonNullable<PulseIdentity["authMethod"]>;
  isVerified: boolean; dcEmbed: boolean;
  activeOrganizationId: string | null;
  memberships: Awaited<ReturnType<typeof getIdentityContext>>["organizations"];
};

export async function getCurrentUser(request: Request): Promise<CurrentUser> {
  const identity = await getIdentity(request);
  const context = await getIdentityContext(identity);
  return {
    identity: { ...identity, organizationId: context.activeOrganizationId ?? identity.organizationId },
    userId: identity.id, email: identity.email, name: identity.name,
    authMethod: identity.authMethod ?? "dev",
    isVerified: identity.isVerified ?? false,
    dcEmbed: identity.dcEmbed ?? false,
    activeOrganizationId: context.activeOrganizationId,
    memberships: context.organizations,
  };
}
```

Mechanical sweep: change every `const identity = getIdentity(request)` to `const identity = await getIdentity(request);` (62 sites; `npm run typecheck` finds them all — work through the error list until clean). Delete `app/chatgpt-auth.ts`. In the two `/me` routes, switch the `pulse-organization` cookie options in production to `sameSite: "none", secure: true, partitioned: true` (Lax cookies are withheld inside a cross-site iframe; keep Lax in dev) and add `authMethod`, `dcEmbed`, `isVerified` to the `/me` response body.

- [ ] **Step 3: Run tests + typecheck + lint**

Run: `npm test && npm run lint` — Expected: PASS, zero remaining sync `getIdentity` call sites.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: session-first async getIdentity, getCurrentUser helper, partitioned org cookie"
```

## Task 10: Embed chrome-hiding, infra, env, Phase 1 verification

**Files:**
- Modify: `app/page.tsx` (chrome hiding from `/me` payload; 401 handler)
- Modify: `infra/main.bicep` (neutralize Easy Auth; new secrets)
- Modify: `.env.example`
- Test: manual verification checklist

- [ ] **Step 1: Chrome hiding in `app/page.tsx`**

In `AppShell`, the `/api/v1/me` fetch already stores its payload; extend that state with `dcEmbed`, `authMethod`, `isVerified`. When `dcEmbed === true`: hide `.sidebar-profile` content and any sign-out affordance (cosmetic only — server authorization is unchanged). Add a 401-response handler on the `/me` fetch: top-level (`window.self === window.top`) → `location.assign("/auth/login?returnUrl=" + encodeURIComponent(location.pathname + location.search))`; framed → `location.reload()` (the proxy then routes to `/dc-embed`).

- [ ] **Step 2: Bicep + env**

`infra/main.bicep`: change `authsettingsV2.globalValidation.unauthenticatedClientAction` to `'AllowAnonymous'` with a comment that app-level session auth is now authoritative (an already-deployed authsettingsV2 does not disappear when the resource is omitted — the flip is an explicit operational step; document in configInfo.md). Add `@secure()` params `sessionSecret`, `entraClientSecret`, `dcAppSecret` → Key Vault secrets `pulse-session-secret`, `entra-client-secret`, `dc-app-secret` → Key Vault-reference appSettings `PULSE_SESSION_SECRET`, `AUTH_ENTRA_CLIENT_SECRET`, `DC_APP_SECRET`; plain appSettings `AUTH_ENTRA_TENANT_ID` (= existing `entraTenantId` param), `AUTH_ENTRA_CLIENT_ID` (= existing `entraClientId` param), `DC_ALLOWED_PARENT_ORIGINS`, `DC_FRAME_ANCESTORS`, `DC_SESSION_CHECK`, `PULSE_TRUST_EASYAUTH_HEADERS` (`'false'`).

**`PULSE_PUBLIC_URL` is now load-bearing** (it already exists in `.env.example` and the Bicep appSettings, set to `https://${namePrefix}-app.azurewebsites.net`). Verify it is present in the deployed appSettings — it is consumed as the OIDC `redirect_uri` base (Task 7), the Entra logout redirect (Task 7), and the OAuth issuer/discovery/`resource_metadata` base (`resolveBaseUrl`, Task 23) where the comment "never trust the Host header in production" makes it authoritative. Without it, `resolveBaseUrl` falls back to the (possibly `http://`) request origin and the Entra redirect silently becomes `http://localhost:3000/auth/callback`. If the value is missing on the deployed host, MCP discovery URLs and the Entra callback both break ("works in dev, dies on deploy"). No code change — this is a deploy-verification item; call it out in configInfo.md §4.

`.env.example` additions (commented placeholders):

```bash
# App-level auth (replaces App Service Easy Auth)
PULSE_SESSION_SECRET=
AUTH_ENTRA_TENANT_ID=
AUTH_ENTRA_CLIENT_ID=
AUTH_ENTRA_CLIENT_SECRET=
# DataCentral embed integration
DC_APP_SECRET=
DC_ALLOWED_PARENT_ORIGINS=https://app.datacentral.ai
DC_API_BASE_URL=
DC_SESSION_CHECK=when-available
DC_FRAME_ANCESTORS='self' https://*.datacentral.ai
PULSE_TRUST_EASYAUTH_HEADERS=false
```

- [ ] **Step 3: Phase 1 verification checklist** (dev server: `npx next dev --port 5199`; simulate prod gating with `NODE_ENV=production`-style checks where feasible; full checklist repeated in configInfo.md for the deployed host)

1. `npm test && npm run lint` green.
2. Dev, no cookie: `curl -s http://localhost:5199/api/v1/me` → 200 with `"authMethod":"dev","isVerified":false`.
3. `curl -s http://localhost:5199/dc-embed` → 200 HTML containing `AppReady ` (with space), `AppReady` (without), origins JSON, `/dc-auth`, `target="_top"`.
4. `curl -s -X POST http://localhost:5199/dc-auth -H "content-type: application/json" -d "{}"` → 400 `missing_credentials`; with `{"graphToken":"bogus"}` → 401 `invalid_token`.
5. Signed dcdata for the seeded user (sign locally with `DC_APP_SECRET` set) → 200 + `set-cookie: pulse-session=…`; replay the cookie against `/api/v1/me` → 200, `dcEmbed: true`.
6. With `AUTH_ENTRA_*` configured: `/auth/login` → 302 to `login.microsoftonline.com/...` containing `code_challenge`, `state`, `nonce`; full round-trip lands a session (needs a live tenant — defer to deployed verification if unavailable).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: embed chrome hiding, Easy Auth neutralization, auth env/infra wiring"
```

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

# Phase 4 — MCP server + OAuth 2.1 authorization server

## Task 21: OAuth crypto primitives

**Files:**
- Create: `lib/server/mcp/crypto.ts`
- Create: `tests/mcp-oauth.test.ts`
- Modify: `package.json` (add `@modelcontextprotocol/sdk@^1.29`; append test file to `test` script)

**Interfaces:**
- Produces: `randomToken(byteLength = 32): string` (base64url, no padding); `sha256Base64Url(input: string): string`; `verifyCodeChallenge(codeVerifier: string, codeChallenge: string): boolean` (RFC 7636 S256: verifier length 43–128 else false; fixed-time compare with length guard).

- [ ] **Step 1: Install** — `npm install @modelcontextprotocol/sdk@^1.29`

- [ ] **Step 2: Failing tests** — `tests/mcp-oauth.test.ts`:

```ts
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomToken, sha256Base64Url, verifyCodeChallenge } from "../lib/server/mcp/crypto.ts";

test("verifyCodeChallenge accepts the RFC 7636 appendix B vector", () => {
  // verifier and S256 challenge from RFC 7636 appendix B
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  assert.equal(verifyCodeChallenge(verifier, challenge), true);
});
test("verifyCodeChallenge rejects wrong verifier and out-of-bounds lengths", () => {
  assert.equal(verifyCodeChallenge("a".repeat(43), sha256Base64Url("b".repeat(43))), false);
  assert.equal(verifyCodeChallenge("a".repeat(42), sha256Base64Url("a".repeat(42))), false);
  assert.equal(verifyCodeChallenge("a".repeat(129), sha256Base64Url("a".repeat(129))), false);
});
test("randomToken is url-safe without padding", () => {
  const t = randomToken();
  assert.match(t, /^[A-Za-z0-9_-]+$/);
});
```

Append `tests/mcp-oauth.test.ts` to the `test` script. Run `npm test` — FAIL.

- [ ] **Step 3: Implement:**

```ts
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const b64url = (buf: Buffer) => buf.toString("base64url");

export function randomToken(byteLength = 32): string {
  return b64url(randomBytes(byteLength));
}
export function sha256Base64Url(input: string): string {
  return b64url(createHash("sha256").update(input, "ascii").digest());
}
// PKCE S256 (RFC 7636 §4.6): SHA-256(verifier) must equal the challenge.
export function verifyCodeChallenge(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || codeVerifier.length < 43 || codeVerifier.length > 128) return false;
  const computed = Buffer.from(sha256Base64Url(codeVerifier), "ascii");
  const expected = Buffer.from(codeChallenge, "ascii");
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}
```

- [ ] **Step 4: Run tests** — PASS. **Commit:** `git commit -m "feat: MCP OAuth crypto primitives (PKCE S256)"`

## Task 22: Token service + client store + migration

**Files:**
- Create: `lib/server/mcp/tokens.ts`
- Create: `lib/server/mcp/client-store.ts`
- Create: `database/migrations/010_mcp_oauth.sql`
- Test: `tests/mcp-oauth.test.ts` (extend)

**Interfaces:**
- Produces (`tokens.ts`): `MCP_ISSUER = "pulse"`, `MCP_AUDIENCE = "pulse-mcp"`, `ACCESS_TOKEN_SECONDS = 3600`, `issueAccessToken(user: { id; email; name }, clientId: string): Promise<string>` (jose HS256, sub/email/name/client_id/jti, iat/nbf/exp); `verifyAccessToken(token: string): Promise<{ sub; email; name; clientId; exp } | null>` (issuer + audience + lifetime, `clockTolerance: 60`, null on any failure); `createRefreshToken(userId, clientId): Promise<string>` (raw returned once; stores `sha256Base64Url(raw)`, 60-day expiry); `redeemRefreshToken(rawToken, clientId): Promise<string | null>` (**atomic single-use rotation** — SQL `UPDATE … SET revoked_at OUTPUT inserted.user_id WHERE token_hash=@hash AND client_id=@clientId AND revoked_at IS NULL AND expires_at > SYSUTCDATETIME()`, then reject non-Active users; memory mode mirrors claim-then-check). Signing key: `MCP_TOKEN_SIGNING_KEY` env (base64 ≥64 bytes) else a warned `globalThis` ephemeral key.
- Produces (`client-store.ts`): `McpClientRecord = { clientId; clientName; redirectUris: string[]; createdAt }`; `createMcpClient(clientName, redirectUris): Promise<McpClientRecord>`; `getMcpClient(clientId): Promise<McpClientRecord | null>`; `isAllowedRedirectUri(uri: string): boolean` (parse with `new URL` in try/catch; reject fragments; https → allow; http → loopback hosts only per RFC 8252 §7.3; other schemes of length > 1 → allow as private-use native schemes). Dual SQL/memory mode.

- [ ] **Step 1: Migration** — `database/migrations/010_mcp_oauth.sql`:

```sql
SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- OAuth clients registered via MCP Dynamic Client Registration (RFC 7591).
-- Public clients only (PKCE, no secret) — identity always comes from the user's sign-in.
CREATE TABLE dbo.McpClients (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  client_id nvarchar(64) NOT NULL,
  client_name nvarchar(200) NOT NULL,
  redirect_uris_json nvarchar(max) NOT NULL CHECK (ISJSON(redirect_uris_json) = 1),
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_McpClients_ClientId UNIQUE(client_id)
);

-- Refresh tokens: only SHA-256 hashes stored; rotated (revoked_at set) atomically on every use.
CREATE TABLE dbo.McpRefreshTokens (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  token_hash nvarchar(64) NOT NULL,
  user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  client_id nvarchar(64) NOT NULL,
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  expires_at datetime2 NOT NULL,
  revoked_at datetime2 NULL,
  CONSTRAINT UQ_McpRefreshTokens_TokenHash UNIQUE(token_hash)
);
CREATE INDEX IX_McpRefreshTokens_User ON dbo.McpRefreshTokens(user_id, revoked_at);

COMMIT TRANSACTION;
```

- [ ] **Step 2: Failing tests** (redeem-twice rotation, wrong-client rejection, token verify round-trip, redirect-URI policy):

```ts
import { issueAccessToken, verifyAccessToken, createRefreshToken, redeemRefreshToken } from "../lib/server/mcp/tokens.ts";
import { isAllowedRedirectUri } from "../lib/server/mcp/client-store.ts";

beforeEach(() => {
  globalThis.pulseMemoryMcpRefreshTokens = undefined;
  globalThis.pulseMemoryMcpClients = undefined;
  globalThis.pulseMcpEphemeralKey = undefined;
  globalThis.pulseMemoryUsers = undefined;
  globalThis.pulseMcpCodeCache = undefined;
  // resolveBaseUrl prefers PULSE_PUBLIC_URL; clear it so the WWW-Authenticate and
  // discovery-URL assertions that hardcode http://localhost are deterministic
  // regardless of the developer's shell/.env.
  delete process.env.PULSE_PUBLIC_URL;
});

const user = { id: "11111111-1111-4111-8111-111111111111", email: "bjarki@uidata.com", name: "Bjarki" };

test("access token round-trips and binds issuer/audience/client", async () => {
  const token = await issueAccessToken(user, "client-1");
  const claims = await verifyAccessToken(token);
  assert.ok(claims);
  assert.equal(claims.sub, user.id);
  assert.equal(claims.clientId, "client-1");
  assert.equal(await verifyAccessToken(token.slice(0, -3) + "abc"), null);
});

test("refresh token rotates: second redeem fails, wrong client fails", async () => {
  const raw = await createRefreshToken(user.id, "client-1");
  assert.equal(await redeemRefreshToken(raw, "client-2"), null);
  assert.equal(await redeemRefreshToken(raw, "client-1"), user.id);
  assert.equal(await redeemRefreshToken(raw, "client-1"), null); // rotated — single use
});

test("redirect uri policy: https anywhere, http loopback only, no fragments", () => {
  assert.equal(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(isAllowedRedirectUri("http://127.0.0.1:33418/cb"), true);
  assert.equal(isAllowedRedirectUri("http://localhost:5199/cb"), true);
  assert.equal(isAllowedRedirectUri("http://evil.example/cb"), false);
  assert.equal(isAllowedRedirectUri("https://x.example/cb#frag"), false);
  assert.equal(isAllowedRedirectUri("myapp://cb"), true);
});
```

Run `npm test` — FAIL.

- [ ] **Step 3: Implement both modules** per the interface block (jose `SignJWT`/`jwtVerify`; dual-mode stores; wrong-client redeem must not revoke the token — check `client_id` inside the atomic claim predicate as shown in the interface).

- [ ] **Step 4: Run tests** — PASS. **Commit:** `git commit -m "feat: MCP self-issued JWTs, rotating refresh tokens, client registry"`

## Task 23: Code cache, discovery metadata, CORS, base URL

**Files:**
- Create: `lib/server/mcp/code-cache.ts`, `lib/server/mcp/discovery.ts`, `lib/server/mcp/cors.ts`, `lib/server/mcp/base-url.ts`
- Create: `app/.well-known/oauth-authorization-server/route.ts`, `app/.well-known/oauth-authorization-server/mcp/route.ts`, `app/.well-known/oauth-protected-resource/route.ts`, `app/.well-known/oauth-protected-resource/mcp/route.ts`
- Test: `tests/mcp-oauth.test.ts` (extend)

**Interfaces:**
- `code-cache.ts`: `PendingConsent = { clientId; clientName; redirectUri; codeChallenge; state: string | null; userId; email; name }`; `IssuedCode = { clientId; redirectUri; codeChallenge; userId }`; `CODE_TTL_MS = 5 * 60_000`; `CONSENT_TTL_MS = 10 * 60_000`; `putOnce(kind, key, value, ttlMs)`; `takeOnce<T>(kind, key): T | null` — **get → delete → THEN expiry check**; single-threaded event loop makes delete-before-return atomic, so replay burns the code. In-memory by design: single-instance App Service (P1v3 capacity 1, alwaysOn), ≤10-minute single-use low-value secrets; worst case on restart is redoing the consent flow. If the app ever scales out, this cache (and proxy rate limits) must move to a shared store — note added to `docs/architecture.md`.
- `discovery.ts`: `authorizationServerMetadata(baseUrl)` → `{ issuer, authorization_endpoint, token_endpoint, registration_endpoint, response_types_supported: ["code"], grant_types_supported: ["authorization_code","refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["mcp"] }`; `protectedResourceMetadata(baseUrl)` → `{ resource: baseUrl + "/mcp", authorization_servers: [baseUrl], scopes_supported: ["mcp"], bearer_methods_supported: ["header"] }`.
- `cors.ts`: `MCP_CORS_HEADERS` with `access-control-allow-origin: *`, allow-methods `GET, POST, DELETE, OPTIONS`, allow-headers `Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID`, **expose-headers `Mcp-Session-Id, WWW-Authenticate`**; `withCors(response)`; `corsPreflight()` (204). Applied to `/mcp`, `/oauth/register`, `/oauth/token`, all four well-known routes; NOT to `/oauth/authorize*` (browser navigation).
- `base-url.ts`: `resolveBaseUrl(request)` — `PULSE_PUBLIC_URL` (trimmed) else `new URL(request.url).origin`; never trust the Host header in production for issuer URLs.
- The four well-known route files: `export const dynamic = "force-dynamic"; export const GET = (req: Request) => withCors(Response.json(metadata(resolveBaseUrl(req)))); export const OPTIONS = corsPreflight;` — **all four variants must exist** (different MCP clients probe different paths).

- [ ] **Step 1: Failing tests** (takeOnce single-use + expiry; discovery route returns S256-only):

```ts
import { putOnce, takeOnce, CODE_TTL_MS } from "../lib/server/mcp/code-cache.ts";
import { GET as asMetadata } from "../app/.well-known/oauth-authorization-server/route.ts";

test("takeOnce returns the value exactly once", () => {
  globalThis.pulseMcpCodeCache = undefined;
  putOnce("code", "k1", { a: 1 }, CODE_TTL_MS);
  assert.deepEqual(takeOnce("code", "k1"), { a: 1 });
  assert.equal(takeOnce("code", "k1"), null);
});

test("authorization-server metadata advertises PKCE S256 and no client secrets", async () => {
  const res = await asMetadata(new Request("http://localhost/.well-known/oauth-authorization-server"));
  const body = await res.json();
  assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(body.token_endpoint_auth_methods_supported, ["none"]);
  assert.ok(res.headers.get("access-control-allow-origin"));
});
```

- [ ] **Step 2: Implement all six files.** Run `npm test` — PASS.

- [ ] **Step 3: Commit:** `git commit -m "feat: OAuth discovery documents, single-use code cache, MCP CORS"`

## Task 24: /oauth/register + /oauth/token

**Files:**
- Create: `app/oauth/register/route.ts`, `app/oauth/token/route.ts`
- Test: `tests/mcp-oauth.test.ts` (extend)

**Interfaces:**
- `POST /oauth/register` (anonymous + CORS) **plus `export const OPTIONS = corsPreflight`**: JSON body; failure → 400 `{ error: "invalid_client_metadata" | "invalid_redirect_uri", error_description }`; `redirect_uris` must be a **non-empty** array (empty → 400 `invalid_redirect_uri` "At least one redirect_uri is required.", per spec §6) and every entry validated with `isAllowedRedirectUri`; `client_name` default "MCP client", truncated to 200; response **201** `{ client_id, client_id_issued_at, client_name, redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code","refresh_token"], response_types: ["code"] }`. The OPTIONS handler is required — `/oauth/register` takes `content-type: application/json` (not a CORS-safelisted type), so browser-hosted MCP clients (claude.ai) preflight it; without an explicit CORS OPTIONS response registration fails silently in the browser while CLI/Desktop clients pass. In-handler fixed-window rate limit (10/min per first `x-forwarded-for` IP, own `globalThis` map) — `/oauth` is deliberately outside `proxy.ts`'s **CSRF/rate-limit** branch (its CSRF check would 403 browser-based MCP clients' cross-origin POSTs); it is matched only for the `frame-ancestors 'none'` header (Task 8).
- `POST /oauth/token` (anonymous + CORS, `application/x-www-form-urlencoded` via `request.formData()`) **plus `export const OPTIONS = corsPreflight`**: `client_id` required else 400 `invalid_client`. `grant_type=authorization_code` → `takeOnce<IssuedCode>("code", code)` (burn before validation), then client/redirect equality, then `verifyCodeChallenge`, then load user (Active) via `getUserById` — each failure 400 `invalid_grant` with a specific description; success → `{ access_token, token_type: "Bearer", expires_in: 3600, refresh_token, scope: "mcp" }` + `cache-control: no-store`. `grant_type=refresh_token` → `redeemRefreshToken` returns the userId → load the user via `getUserById` (re-check Active) → null/inactive ⇒ `invalid_grant`; success issues a fresh pair. Anything else → 400 `unsupported_grant_type`. Errors are RFC 6749-shaped `{ error, error_description }` — NOT the Pulse `apiError` envelope. **Dependency:** `getUserById(id: string): Promise<{ id; email; name; status } | null>` — add it to `lib/server/chat/chat-repository.ts` alongside `getUserByEmail` (Task 11), same identity-less dual-mode pattern (`SELECT id, email, display_name AS name, status FROM dbo.Users WHERE id = @id`). Both token grants use it so `issueAccessToken` receives `{ id, email, name }` and disabled users are rejected at token and refresh time (spec §10).

- [ ] **Step 1: Failing tests** (register happy/sad paths; token exchange with real PKCE pair; code replay burns):

```ts
import { POST as register } from "../app/oauth/register/route.ts";
import { POST as token } from "../app/oauth/token/route.ts";

test("register accepts valid uris and returns a public client", async () => {
  const res = await register(new Request("http://localhost/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
  }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.client_id);
  assert.equal(body.token_endpoint_auth_method, "none");
});

test("register rejects a non-loopback http redirect uri", async () => {
  const res = await register(new Request("http://localhost/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
  }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_redirect_uri");
});

test("token endpoint burns the code on first use", async () => {
  // seed: client + code via the cache, exchange once (200), replay (400 invalid_grant)
  // full assembly in Task 26's end-to-end test; here use putOnce directly:
  globalThis.pulseMcpCodeCache = undefined;
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  putOnce("code", "code-1", {
    clientId: "c1", redirectUri: "https://claude.ai/cb", codeChallenge: challenge,
    userId: "11111111-1111-4111-8111-111111111111",
  }, CODE_TTL_MS);
  const form = () => {
    const f = new URLSearchParams({ grant_type: "authorization_code", client_id: "c1",
      code: "code-1", redirect_uri: "https://claude.ai/cb", code_verifier: verifier });
    return new Request("http://localhost/oauth/token", { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: f.toString() });
  };
  const first = await token(form());
  assert.equal(first.status, 200);
  assert.ok((await first.json()).access_token);
  const replay = await token(form());
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, "invalid_grant");
});
```

- [ ] **Step 2: Implement, run tests, commit:** `git commit -m "feat: OAuth dynamic client registration and token endpoint"`

## Task 25: /oauth/authorize + consent + decision

**Files:**
- Create: `app/oauth/authorize/route.ts`, `app/oauth/authorize/decision/route.ts`
- Create: `lib/server/mcp/consent-page.ts`, `lib/server/mcp/browser-auth.ts`
- Test: `tests/mcp-oauth.test.ts` (extend)

**Interfaces:**
- `browser-auth.ts`: `requireBrowserIdentity(request): Promise<PulseIdentity | Response>` — `await getIdentity(request)`; on `UNAUTHORIZED` return `Response.redirect(origin + "/auth/login?returnUrl=" + encodeURIComponent(path + search), 302)` — the Phase 1 app login IS the spec's "authorize triggers the normal sign-in". In dev, the demo fallback signs the flow automatically.
- `GET /oauth/authorize`: validate `client_id` exists → 400 text "Unknown client_id."; `redirect_uri` exact-match against registration → 400 text (never redirect on mismatch). From here errors REDIRECT to the validated URI: `response_type !== "code"` → `unsupported_response_type`; missing `code_challenge` or `code_challenge_method` present-but-not-S256 → `invalid_request` "PKCE with S256 is required."; `getIdentityContext` failure → `access_denied` "No active account.". Then mint nonce `randomToken(24)`, `putOnce("consent", nonce, PendingConsent, CONSENT_TTL_MS)`, render the consent page (200, `text/html`, `cache-control: no-store`).
- `consent-page.ts`: `consentPage(clientName, redirectUri, displayName, email, nonce): string` — port of the spec's HTML with DataCentral Pulse branding; **HTML-encode every interpolation** (`escapeHtml` for `&<>"'`); show only `new URL(redirectUri).origin`; form POSTs to `/oauth/authorize/decision` with hidden `nonce` and two submit buttons named `action` valued `allow`/`deny`; copy: "**{client}** ({origin}) is asking to access DataCentral Pulse as **{name}** ({email}) — it will be able to do everything you can do. All actions are logged as you." Inline styles only (existing CSP allows `style-src 'unsafe-inline'`).
- `POST /oauth/authorize/decision`: ① inline same-origin guard (403 if `origin` header host ≠ request host or `sec-fetch-site === "cross-site"` — this endpoint is outside proxy.ts's CSRF matcher); ② `takeOnce<PendingConsent>("consent", nonce)` — expired/absent → 400 "Consent request expired — restart the connection from your MCP client."; ③ re-resolve the signed-in user; **must equal `pending.userId`** else 400; ④ `action !== "allow"` → redirect error `access_denied`; ⑤ `code = randomToken(32)`, `putOnce("code", …, CODE_TTL_MS)`, 302 to `redirectUri` with `code` + `state` (URL-encoded, `?`/`&` separator logic).

- [ ] **Step 1: Failing tests** (consent nonce single-use + user binding; full happy flow through decision):

```ts
import { GET as authorize } from "../app/oauth/authorize/route.ts";
import { POST as decision } from "../app/oauth/authorize/decision/route.ts";

test("authorize renders consent for a registered client (dev identity)", async () => {
  const reg = await register(/* as in Task 24 */);
  const { client_id } = await reg.json();
  const res = await authorize(new Request(
    `http://localhost/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}&response_type=code&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=xyz`));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Allow"));
  const nonce = html.match(/name="nonce" value="([^"]+)"/)?.[1];
  assert.ok(nonce);

  const dec = await decision(new Request("http://localhost/oauth/authorize/decision", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
    body: new URLSearchParams({ nonce, action: "allow" }).toString(),
  }));
  assert.equal(dec.status, 302);
  const location = dec.headers.get("location")!;
  assert.match(location, /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?code=.+&state=xyz$/);

  // replayed nonce is burned
  const replay = await decision(new Request("http://localhost/oauth/authorize/decision", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
    body: new URLSearchParams({ nonce, action: "allow" }).toString(),
  }));
  assert.equal(replay.status, 400);
});

test("authorize with unregistered redirect_uri is a 400, not a redirect", async () => {
  const reg = await register(/* … */);
  const { client_id } = await reg.json();
  const res = await authorize(new Request(
    `http://localhost/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&response_type=code&code_challenge=x&code_challenge_method=S256`));
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Implement, run tests, commit:** `git commit -m "feat: OAuth authorize + consent flow bound to app sign-in"`

## Task 26: /mcp endpoint

**Files:**
- Create: `app/mcp/route.ts`
- Test: `tests/mcp-oauth.test.ts` (extend — 401 challenge; full flow token → tools/list)

**Interfaces:**
- Consumes: `verifyAccessToken` (Task 22), `getChatTools`/`chatToolErrorMessage`/`buildAssistantInstructions` (Tasks 12–13), `getIdentityContext`, `@modelcontextprotocol/sdk` — `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`, `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` (verified: takes a Web `Request`, returns a Web `Response`; omitting `sessionIdGenerator` = stateless mode; `handleRequest(req, { authInfo })` forwards authInfo to tool callbacks as `extra.authInfo`).
- Produces: `POST/GET/DELETE /mcp` (Streamable HTTP, stateless, JSON responses) + `OPTIONS` preflight.

- [ ] **Step 1: Failing tests:**

```ts
import { POST as mcp } from "../app/mcp/route.ts";

test("mcp without a bearer returns 401 with the resource_metadata challenge", async () => {
  const res = await mcp(new Request("http://localhost/mcp", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) }));
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "",
    /^Bearer resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource\/mcp"$/);
});

test("mcp with a valid token lists tools bound to the user", async () => {
  const token = await issueAccessToken(user, "client-1");
  const res = await mcp(new Request("http://localhost/mcp", { method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.result.tools.some((t: { name: string }) => t.name === "submit_request"));
});
```

(If the transport requires an `initialize` round first even in stateless JSON mode, adjust the second test to send `initialize` then `tools/list` in sequence — follow what the SDK's stateless mode actually requires; the assertion target stays the same.)

- [ ] **Step 2: Implement** `app/mcp/route.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { verifyAccessToken } from "@/lib/server/mcp/tokens";
import { resolveBaseUrl } from "@/lib/server/mcp/base-url";
import { MCP_CORS_HEADERS, withCors, corsPreflight } from "@/lib/server/mcp/cors";
import { getChatTools, chatToolErrorMessage, buildAssistantInstructions } from "@/lib/server/chat/tool-registry";
import { getIdentityContext } from "@/lib/server/identity-repository";
import { isAzureSqlConfigured } from "@/lib/server/database";
import type { PulseIdentity } from "@/lib/domain";

export const dynamic = "force-dynamic";

function unauthorized(request: Request): Response {
  const metadata = `${resolveBaseUrl(request)}/.well-known/oauth-protected-resource/mcp`;
  return new Response(
    JSON.stringify({ error: "invalid_token", error_description: "Missing or invalid bearer token." }),
    { status: 401, headers: { ...MCP_CORS_HEADERS, "content-type": "application/json",
        // This exact challenge is how MCP clients bootstrap OAuth discovery.
        "www-authenticate": `Bearer resource_metadata="${metadata}"` } });
}

async function handleMcp(request: Request): Promise<Response> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const claims = token ? await verifyAccessToken(token) : null;
  if (!claims) return unauthorized(request);

  // Per-request user binding: re-check the user is still active and resolve
  // memberships on EVERY request (stateless — no session affinity).
  const probe: PulseIdentity = {
    id: claims.sub, email: claims.email, name: claims.name,
    organizationId: "", role: isAzureSqlConfigured() ? "Unknown" : "System admin",
    isInternal: !isAzureSqlConfigured(),
  };
  let context: Awaited<ReturnType<typeof getIdentityContext>>;
  try { context = await getIdentityContext(probe); }
  catch {
    return withCors(new Response(JSON.stringify({
      error: "invalid_token", error_description: "No active account is linked to this token.",
    }), { status: 403, headers: { "content-type": "application/json" } }));
  }
  const identity: PulseIdentity = { ...probe, organizationId: context.activeOrganizationId ?? "" };

  const authInfo: AuthInfo = {
    token: token!, clientId: claims.clientId, scopes: ["mcp"], expiresAt: claims.exp,
    extra: { identity },
  };

  const server = new McpServer(
    { name: "DataCentral Pulse", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: buildAssistantInstructions(identity, context) },
  );
  for (const tool of getChatTools()) {
    server.registerTool(tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly } },
      async (args: Record<string, unknown>, extra) => {
        const bound = (extra.authInfo?.extra as { identity: PulseIdentity }).identity;
        try {
          // Clone per call: requireMembership mutates identity.organizationId.
          return { content: [{ type: "text" as const, text: await tool.run({ ...bound }, args) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: chatToolErrorMessage(error) }], isError: true };
        }
      });
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true, // no sessionIdGenerator → stateless mode
  });
  await server.connect(transport);
  return withCors(await transport.handleRequest(request, { authInfo }));
}

export const POST = handleMcp;
export const GET = handleMcp;
export const DELETE = handleMcp;
export const OPTIONS = () => corsPreflight();
```

Fresh `McpServer` + transport per request is the SDK-documented stateless pattern (and what Vercel's mcp-handler does internally); cost is schema construction only, no I/O. All tool groups are registered — internal/admin tools are safe for all users because the repositories return `FORBIDDEN` (rendered as "not found or not accessible") for unauthorized callers.

- [ ] **Step 3: Run tests** — PASS. **Commit:** `git commit -m "feat: stateless MCP endpoint with per-request user binding"`

## Task 27: MCP infra, env, end-to-end verification

**Files:**
- Modify: `infra/main.bicep`, `.env.example`, `docs/architecture.md`

- [ ] **Step 1: Bicep.** Add `@secure()` param `mcpTokenSigningKey` → Key Vault secret `mcp-token-signing-key` → appSetting `MCP_TOKEN_SIGNING_KEY`. Append to `authsettingsV2.globalValidation.excludedPaths` (relevant only while Easy Auth remains deployed in `AllowAnonymous`-transition mode): `'/mcp'`, `'/.well-known/oauth-authorization-server'`, `'/.well-known/oauth-authorization-server/mcp'`, `'/.well-known/oauth-protected-resource'`, `'/.well-known/oauth-protected-resource/mcp'`, `'/oauth/register'`, `'/oauth/token'`. Do NOT exclude `/oauth/authorize` or `/oauth/authorize/decision` — an unauthenticated browser hitting authorize must fall into the app's login redirect.

- [ ] **Step 2: Env.** `.env.example`: add commented `MCP_TOKEN_SIGNING_KEY=` with the generation hint `# openssl rand -base64 64` / PowerShell `[Convert]::ToBase64String((1..64 | % { Get-Random -Max 256 }))`. `docs/architecture.md`: add a paragraph documenting the single-instance constraint now shared by proxy rate limits, the OAuth code/consent cache, and Slack Socket Mode.

- [ ] **Step 3: End-to-end verification** (dev):

1. `npm test && npm run lint` green.
2. `npx next dev --port 5199`, then `claude mcp add --transport http pulse http://localhost:5199/mcp` (or add as a remote MCP server in any client).
3. Expected sequence: client gets 401 → fetches `/.well-known/oauth-protected-resource/mcp` → `/.well-known/oauth-authorization-server` → POST `/oauth/register` (201) → browser opens `/oauth/authorize` → (dev: demo identity) consent page → Allow → redirect with code → POST `/oauth/token` (200) → tools appear.
4. Verify a read tool (`list_my_requests`) returns data and a write tool respects permissions (a customer-role token cannot `publish_idea` — reads as "not found or not accessible").
5. `npm run build` then `node .next/standalone/server.js` — smoke `curl http://localhost:3000/.well-known/oauth-authorization-server` returns 200 JSON (dot-folder routing was verified in dev/Turbopack; this checks the production build — if it fails, move handlers to `app/well-known/**` and add `rewrites()` in `next.config.ts`).

- [ ] **Step 4: Commit:** `git commit -m "feat: MCP OAuth infra wiring and signing key config"`

---

# Phase 5 — Documentation + final acceptance

## Task 28: configInfo.md + README

**Files:**
- Create: `configInfo.md` (repo root — required deliverable, AI.MD §10)
- Modify: `README.md`

- [ ] **Step 1: Write `configInfo.md`** reflecting what was actually built, with these sections (concrete commands, not prose):

1. **Anthropic API key** — get one at console.anthropic.com; dev: `ANTHROPIC_API_KEY` in `.env.local`; prod: `az deployment group create … --parameters anthropicApiKey=sk-ant-…` (Key Vault reference); optional `ANTHROPIC_MODEL` (default `claude-opus-4-8`).
2. **Slack app** (workspace admin, ~3 min) — manifest flow, app-level token (`connections:write`) → `SLACK_APP_TOKEN`, install → `SLACK_BOT_TOKEN`; exact `.env.local` lines and Bicep params.
3. **Identity prerequisites** — users must be pre-provisioned (admin → Users, email must match Entra email or Slack profile email); Entra app registration needs web redirect URI `https://{host}/auth/callback` + a client secret (`AUTH_ENTRA_CLIENT_ID`, `AUTH_ENTRA_TENANT_ID`, `AUTH_ENTRA_CLIENT_SECRET`); DataCentral Tool config needs the shared secret (`DC_APP_SECRET`) and the host origins (`DC_ALLOWED_PARENT_ORIGINS`, `DC_FRAME_ANCESTORS`); Graph-token forwarding must be enabled for the Tool in DataCentral admin or no `graphToken` arrives (the `/dc-embed` page shows inline diagnostics).
4. **Session + MCP secrets** — `PULSE_SESSION_SECRET` (≥32 chars), `MCP_TOKEN_SIGNING_KEY` (base64 ≥64 bytes; `openssl rand -base64 64`); consequences when missing (session auth disabled / ephemeral MCP tokens per restart).
5. **Hosting** — single instance mandatory (Socket Mode + in-memory OAuth caches + rate limits); Always On already set; deploys drop the Slack connection briefly (auto-reconnect); future VNet egress lockdown must allow `wss://*.slack.com`, `https://slack.com`, `https://api.anthropic.com`, `https://graph.microsoft.com`, `https://login.microsoftonline.com`; Easy Auth flip to `AllowAnonymous` is an explicit deploy step on existing environments.
6. **Verification** — expected log line `Slack Socket Mode connected`; chat-panel smoke test; DM + mention test; `claude mcp add --transport http pulse https://{host}/mcp` full OAuth round trip; embed test from DataCentral (or the `Sec-Fetch-Dest: iframe` curl checks from Task 10); voice dictation browser note (Chrome/Edge/Safari; requires the shipped `Permissions-Policy: microphone=(self)` header).

- [ ] **Step 2: README** — add an "AI assistant, Slack, MCP, and DataCentral embedding" section linking `configInfo.md`, `docs/slack-setup.md`, and the plan/architecture docs.

- [ ] **Step 3: Commit:** `git commit -m "docs: configInfo, slack setup, README for assistant/MCP/embed"`

## Task 29: Final acceptance pass

- [ ] **Step 1: Run the full gate** — `npm test && npm run lint && npm run build` all green.

- [ ] **Step 2: Walk the three spec acceptance checklists** and record pass/fail inline in the PR description:

*AI.MD §11:* chat panel on every authenticated page; history persists per user and clear works; assistant performs real actions through tools with permissions verified (customer refused on others' data, internal flows work); replies follow the user's language; relative dates resolve; destructive bulk actions ask first; empty-Enter confirms; pages refresh after assistant mutations; 🎤 only when supported, dictation → cleaned transcript → executed; no key → friendly notice, nothing crashes; no Slack tokens → app runs; Slack DM + mention answered, identity by verified email only, unknown/disabled politely refused, ⏳ during work, threaded mention replies, mrkdwn rendering; duplicate deliveries produce one reply; mrkdwn tests pass; no secrets committed; `docs/slack-setup.md` + `configInfo.md` exist.

*MCP-LLM-Instructions §10 + §11:* every security-checklist row lands where Task 21–26 put it (spot-check: code replay burns, refresh rotation single-use, consent nonce user-bound, redirect exact-match, S256-only, signing key from config with warned fallback, per-request disabled-user rejection, WWW-Authenticate challenge exact); `claude mcp add` end-to-end connects, tools listed, read + permission-checked write verified, silent refresh works (force by restarting dev with the ephemeral key).

*DataCentralEmbedEntraAuthApp §12:* standalone unauthenticated → Entra redirect; embed-tagged request → `/dc-embed`, never Microsoft; handshake page contents; `/dc-auth` 400/401/403/200 matrix; cookie replay renders the app with no redirect loop both plain and iframe-tagged; `/me` exposes `authMethod`/`dcEmbed`/`isVerified`; unknown user → `not_provisioned`; chrome hidden when embedded.

- [ ] **Step 3: Commit any fixes; open the integration discussion** (merge / PR per team convention — use superpowers:finishing-a-development-branch).

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

