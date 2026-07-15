# Pulse Plan A — DataCentral Embed + Entra Auth Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace App Service Easy Auth with an app-level auth layer: a jose-signed pulse-session cookie, standalone Entra OIDC login, and the DataCentral iframe-embed (dcdata/dcsig + postMessage) flow, feeding the existing PulseIdentity → repository authorization chain unchanged.

**Architecture:** A new app-level auth layer replaces Easy Auth. getIdentity becomes async and session-cookie-first; proxy.ts gates pages and intercepts the embed challenge; new /dc-embed, /dc-auth, and /auth/* routes handle the two sign-in shapes.

**Dependency:** **This is the foundation — execute FIRST. Plans B and C both depend on it** (it makes getIdentity async, provides getCurrentUser, and the OAuth authorize flow in Plan C redirects into the /auth/login it creates).

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


