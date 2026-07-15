# Pulse Plan C — MCP Server + OAuth 2.1 Authorization Server

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the same tool registry as a remote MCP server over stateless Streamable HTTP, protected by a self-hosted OAuth 2.1 authorization server that delegates authentication to the app's normal sign-in. Plus the combined configInfo.md and the final all-three-subsystem acceptance pass.

**Architecture:** MCP endpoint at /mcp (WebStandardStreamableHTTPServerTransport, stateless, per-request user binding) reusing the Plan B tool registry; a minimal OAuth AS (discovery, RFC 7591 registration, PKCE-S256 authorize+consent, token with rotating refresh) whose /oauth/authorize redirects into Plan A's /auth/login when unauthenticated.

**Dependency:** **Depends on Plan A** (getIdentity, /auth/login redirect target) **and Plan B** (the tool registry getChatTools/buildAssistantInstructions/chatToolErrorMessage, and getUserById in the chat repository). Execute LAST. Phase 5 (configInfo.md + final acceptance) covers all three subsystems and lives here because C is executed last.

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


