# DataCentral Pulse — Architecture, Auth & MCP Reference (verified against code)

All claims cite `file:line` in the repo at `C:\VS Code\Pulse`. UI strings are quoted exactly as they appear in code.

---

## 1. Component inventory

### 1.1 Next.js application

| Component | What it is | Evidence |
| --- | --- | --- |
| `proxy.ts` (request gate) | Runs on matcher `["/api/:path*", "/", "/dc-embed", "/dc-auth", "/auth/:path*", "/mcp", "/oauth/:path*"]`. For non-`/api` paths: sets CSP + frame-ancestors, and redirects unauthenticated page loads to sign-in (302 to `/dc-embed?returnUrl=…` when the request looks embedded, else `/auth/login?returnUrl=…`). For `/api` paths: CSRF same-origin check on mutations (403 `CSRF_REJECTED`), fixed-window in-memory rate limits (429 `RATE_LIMITED`, buckets of 30/60/180 per minute), correlation-ID stamping, `x-ratelimit-limit`/`x-ratelimit-remaining` headers. | proxy.ts:136-138, 47-58, 80-90, 10-16, 92-133 |
| `app/page.tsx` | Single-page UI (~6,174 lines). Boots by fetching `GET /api/v1/me`; on 401 a top-level window goes to `/auth/login?returnUrl=…`, while a framed window reloads so the proxy routes it to `/dc-embed`. Hides chrome when `dcEmbed` is true (sidebar profile, workspace switcher button, "Good morning, Bjarki" heading). Mounts the floating `<ChatPanel>`. | Bash `wc -l`; page.tsx:788-1133, 813, 1124, 1157, 1367, 1326 |
| `app/chat-panel.tsx` | Floating assistant launcher + panel. Header "✦ Assistant"; input placeholder "Ask the assistant…"; talks to `GET/POST/DELETE /api/v1/chat/messages` and `POST /api/v1/chat/transcript`. | chat-panel.tsx:249, 337, 84, 126, 176, 222 |
| API routes `app/api/v1/**` | REST surface: `ideas`, `requests`, `releases`, `notifications`, `attachments`, `chat`, `search`, `me`, `admin/*` (organizations, users, taxonomy, settings), `internal/*` (triage, ideas, releases, saved-views, webhooks, analytics, audit, jobs), plus `app/api/health`. | file listing under `app/api/` |
| Auth routes | `app/auth/login`, `app/auth/callback`, `app/auth/logout`, `app/auth/error` (page), `app/dc-embed`, `app/dc-auth`. | file listing |
| OAuth AS routes (MCP authorization server) | `app/oauth/register`, `app/oauth/authorize`, `app/oauth/authorize/decision`, `app/oauth/token`, plus 4 discovery routes under `app/.well-known/`. | file listing |
| MCP endpoint | `app/mcp/route.ts` — Streamable HTTP MCP server (POST/GET/DELETE/OPTIONS), stateless (`enableJsonResponse: true`, no sessionIdGenerator), server name "DataCentral Pulse" v"1.0.0". | app/mcp/route.ts:49-51, 68-78 |
| `instrumentation.ts` | Next.js startup hook; `register()` runs once per server-process boot and starts the Slack Socket Mode assistant; SIGTERM/SIGINT stop it gracefully. | instrumentation.ts:6-18 |

### 1.2 Session layer

- Cookie name: `pulse-session` (session.ts:14).
- **TTL: `TTL_SECONDS = 60 * 60 * 12` — 12 hours** ("embed re-handshakes on expiry, standalone re-SSO-redirects") (session.ts:15).
- HS256 JWT signed with `PULSE_SESSION_SECRET` (min 32 chars; dev fallback string; production without secret ⇒ session auth disabled), issuer `pulse`, audience `pulse`, claim `ver: 1` (session.ts:17-35).
- Claims: `sub` (dbo.Users.id GUID), `email`, `name`, `ext` (Entra oid | `dc:{userId}` | `dev:local`), `amr` (`"entra" | "dc-hmac" | "dc-graph" | "dev"`), optional `dc_embed: true` (chrome-hiding), optional `tid` (session.ts:3-12).
- Production cookie attributes: `Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=None; Partitioned` (CHIPS — required to travel inside the cross-site DataCentral iframe); dev: `SameSite=Lax` (session.ts:57-62).
- Companion cookies: `pulse-organization` (org context hint, Max-Age 30 days, partitioned in prod — app/api/v1/me/route.ts:25-37) and transient `pulse-oidc` (below).

### 1.3 SQL vs memory repositories (dual-mode data layer)

- Switch: `isAzureSqlConfigured()` = `Boolean(AZURE_SQL_CONNECTION_STRING || AZURE_SQL_SERVER)` (lib/server/database.ts:7-11).
- SQL mode: `mssql` connection pool; on App Service authenticates with managed identity (`type: "azure-active-directory-msi-app-service"`), encrypted, pool max 20 (database.ts:13-31).
- Memory mode: process-local seeded adapter — "credential-free" local development; "Neither fallback is durable or suitable for production" (docs/architecture.md:20-22).
- 28 files in `lib/` branch on `isAzureSqlConfigured` — every repository (`request-`, `idea-`, `comment-`, `draft-`, `admin-`, `identity-`, `taxonomy-`, `triage-`, `saved-view-`, `search-`, `settings-`, `product-`, `operations-`, `notification-preference-`, `webhook-`, `external-link-`, `analytics-repository`), the workers (`notification-`, `retention-`, `webhook-worker`), `idempotency`, `authorization`, `auth`, `user-directory`, `chat/chat-repository`, and the MCP stores `mcp/tokens.ts` + `mcp/client-store.ts` (Grep result).

### 1.4 Chat tool registry — one registry, three consumers

- Registry: `getChatTools()` returns `[...customerTools, ...internalTools, ...adminTools]` (lib/server/chat/tool-registry.ts:20-22). Counts: **24 customer + 23 internal + 11 admin = 58 tools** (grep counts of `name: "` in tools-customer.ts / tools-internal.ts / tools-admin.ts). Each tool has `group: "customer" | "internal" | "admin"` (tool-contract.ts:21).
- Shared instructions: `buildAssistantInstructions()` is "consumed by BOTH the in-app chat system prompt … and the MCP ServerInstructions" (tool-registry.ts:24-32).
- **Consumer 1 — in-app chat panel:** `POST /api/v1/chat/messages` → `sendChat()` (app/api/v1/chat/messages/route.ts:30) → Anthropic `toolRunner` (model `ANTHROPIC_MODEL`, default `claude-opus-4-8`, `max_iterations: 16`) with tools filtered by the caller's groups (`customer` always; `internal` if member of an Internal org; `admin` if that role is "System admin") plus a chat-host-only `switch_organization` tool (assistant-service.ts:27, 33-79, 97-101, 110-117).
- **Consumer 2 — Slack Socket Mode:** started from `instrumentation.ts` `register()` (instrumentation.ts:6-9); no-op unless both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set (socket-service.ts:29-34). `app_mention` and DM events funnel into the same `sendChat()` "brain" (event-handler.ts:26-65). Identity comes exclusively from Slack's `users.info` workspace-verified `profile.email` matched exactly against `dbo.Users.email` (~1h cache) — never from message text (identity.ts:1-8, 25, 33-56).
- **Consumer 3 — MCP endpoint:** `app/mcp/route.ts` registers **all** `getChatTools()` tools (no group filter — "Group gating is prompt hygiene; repos are the braces", assistant-service.ts:32) with per-request identity binding and per-request membership re-resolution (mcp/route.ts:29-66).

### 1.5 Azure pieces (infra/main.bicep)

| Resource | Details | Evidence |
| --- | --- | --- |
| App Service plan | `{prefix}-plan`, Linux, **P1v3, capacity 1** — "Slack Socket Mode + in-memory OAuth/chat caches require a single instance — do not scale out." | main.bicep:203-211 |
| Web app | `{prefix}-app`, Linux container (`DOCKER|{containerImage}`), system-assigned managed identity, httpsOnly, alwaysOn, healthCheckPath `/api/health`, `WEBSITES_PORT` 3000 | main.bicep:213-231 |
| Key Vault | `{trimmed-prefix}-kv`, RBAC authorization, purge protection, 90-day soft delete. Secrets: `attachment-scan-webhook-secret`, `notification-job-secret`, `webhook-signing-secret`, `pulse-session-secret`, `entra-client-secret`, `dc-app-secret`, `mcp-token-signing-key`, optional `anthropic-api-key`, `slack-bot-token`, `slack-app-token`. App settings use `@Microsoft.KeyVault(SecretUri=…)` references. | main.bicep:69-141, 237-262 |
| Azure SQL | Server `{prefix}-sql` with Entra-only admin (`azureADOnlyAuthentication: true`); database `Pulse`, S1 Standard tier | main.bicep:170-201 |
| Blob storage | `{prefix}files`, Standard_ZRS, `allowBlobPublicAccess: false`, `allowSharedKeyAccess: false`, container `pulse-attachments` (publicAccess None) | main.bicep:143-168 |
| Observability | Log Analytics `{prefix}-logs` (30-day retention) + App Insights `{prefix}-insights` | main.bicep:54-67 |
| Role assignments | App identity gets Storage Blob Data Contributor on storage and Key Vault Secrets User on the vault | main.bicep:331-349 |
| Easy Auth | `authsettingsV2` deployed in `unauthenticatedClientAction: 'AllowAnonymous'` — Easy Auth no longer gates requests; app-level session auth is authoritative. `PULSE_TRUST_EASYAUTH_HEADERS` app setting is `'false'`. MCP/OAuth/well-known/token/register/jobs/health paths are excluded; `/oauth/authorize` deliberately NOT excluded. | main.bicep:268-305, 254 |
| Runtime | Docker: node:22-alpine, standalone Next.js build, `CMD ["node", "server.js"]`, port 3000, non-root user | Dockerfile:1-24 |

Single-instance constraint: the MCP authorization-code/consent cache and the proxy rate limiter live in in-memory `globalThis` maps; Slack Socket Mode holds one persistent WebSocket — scaling out requires a shared store and moving Slack off Socket Mode (docs/architecture.md:28-30; code-cache.ts:1-7).

---

## 2. The three sign-in paths (exact step sequences)

### Credential precedence in `getIdentity` (lib/server/auth.ts:39-149)

1. **① `pulse-session` cookie** — "the primary credential once a session exists" (auth.ts:42-55).
2. **② `X-DC-Data`/`X-DC-Sig` headers** — per-request DataCentral launch re-verification; only when `PULSE_TRUST_DC_HEADERS === "true"`; "No code in the app emits these headers today" (auth.ts:57-97).
3. **③ Easy Auth headers** (`x-ms-client-principal*`) — only when `PULSE_TRUST_EASYAUTH_HEADERS === "true"` (deployed as `false`) (auth.ts:99-122; main.bicep:254).
4. **④ Demo fallback** — only when `isAzureSqlConfigured()` is **false** AND (`NODE_ENV !== "production"` OR `PULSE_ALLOW_DEMO_IDENTITY === "true"`). Identity: id `11111111-1111-4111-8111-111111111111`, email `bjarki@uidata.com`, name `Bjarki Kristjánsson`, default org `ORG-001`, role `System admin`, `isInternal: true`, `authMethod: "dev"`, `isVerified: false` (auth.ts:124-145).
5. **⑤** otherwise `throw new Error("UNAUTHORIZED")` (auth.ts:147-148).

The org context is only a **hint** (`x-pulse-organization-id` header or `pulse-organization` cookie); "Repositories always verify the user has an active membership before reading or mutating tenant data" (auth.ts:24-37).

### Path A — DataCentral embed (iframe → handshake → HMAC POST → cookie)

1. DataCentral frames Pulse as an iframe Tool. Proxy sees a page request with no `pulse-session` cookie; `isEmbedRequest()` is true if the URL has a `dcdata` query param OR `Sec-Fetch-Dest: iframe` (proxy.ts:24-27) → **302 to `/dc-embed?returnUrl=<original path+query>`** (never redirect an iframe to Entra) (proxy.ts:50-58).
2. `GET /dc-embed` serves a static handshake page — visible text: "Connecting to DataCentral…"; fallback block: "Could not sign you in automatically." with link "Open Pulse sign-in" (dc-embed/route.ts:31-33). `returnUrl` is sanitized to a local path; allowed parent origins come from `DC_ALLOWED_PARENT_ORIGINS` (default `https://app.datacentral.ai`) plus any `*.datacentral.ai` hostname (dc-embed/route.ts:16-19, 39-42).
3. The page posts **`{ type: "AppReady " }` (with trailing space) AND `{ type: "AppReady" }`** to `window.parent` on load, retried at 250 ms and 1000 ms (dc-embed/route.ts:84-92).
4. DataCentral replies via `postMessage` with an **AccessToken envelope** — either shape `{ accessToken, graphToken? }` or `{ type: "AccessToken", token }` (`aadToken` also accepted as the Graph token); only messages from allowed origins are processed (dc-embed/route.ts:73-82).
5. The page does **`POST /dc-auth`** with JSON `{ dcData, dcSig, accessToken, graphToken }` (`credentials: "include"`) (dc-embed/route.ts:60-64). `dcdata`/`dcsig` are read from the page's own URL and/or the `returnUrl` query (dc-embed/route.ts:55-58).
6. `/dc-auth` (anonymous by design, with an inline same-origin login-CSRF guard — dc-auth/route.ts:17-27):
   - **Path 1 (first):** signed `dcData`+`dcSig` — `dcsig = base64(HMAC_SHA256(DC_APP_SECRET, raw dcdata base64 string))`, fixed-time compare; `dcdata` may be doubly-encoded JSON (datacentral.ts:11-29). Optional live-session corroboration per `DC_SESSION_CHECK` (`"off" | "when-available"` (default) | `"required"`): when an `accessToken` is present it is checked against `GET {DC_API_BASE_URL || launch.clientUrl}/api/services/app/Session/GetCurrentLoginInformations` (https only, 5 s timeout, email must match) (dc-auth/route.ts:39-47; datacentral.ts:33-62). `"required"` refuses HMAC-only posts (closes the launch-URL replay window) (dc-auth/route.ts:40-43).
   - User is resolved against `dbo.Users` by `resolveUserForDcLaunch` (subject `dc:{userId}`, else email match; errors → 403 `not_provisioned` / `disabled`) (dc-auth/route.ts:48-50; user-directory.ts:165-277).
   - Mints the session token with `amr: "dc-hmac"`, **`dc_embed: true`**, and returns `Set-Cookie: pulse-session=…` (dc-auth/route.ts:51-58).
   - **Path 2 (fallback):** Graph token only (Entra users) — validated by `validateGraphToken`, resolved via `resolveUserForEntra`, `amr: "dc-graph"`, `dc_embed: true` (dc-auth/route.ts:61-76).
7. On 200 the page strips `dcdata`/`dcsig` from the returnUrl and `location.replace()`s to it; the app now loads with the cookie (dc-embed/route.ts:66-68).
8. Guards: `sessionStorage` loop counter — more than 2 attempts ⇒ fallback "cookie appears blocked in this browser" (dc-embed/route.ts:49-53); 8-second overall timeout ⇒ fallback "timed out waiting for a token" (dc-embed/route.ts:98).
9. In embed mode the SPA hides its own chrome (`dc_embed` claim → `/api/v1/me` `dcEmbed` field → `setDcEmbed`) (session.ts:9; app/api/v1/me/route.ts:19; page.tsx:813, 1124, 1157, 1367).

### Path A′ — DataCentral launch URL variant (dcdata/dcsig on the URL, no envelope)

Same steps 1–2 as Path A (the `dcdata` query param alone makes `isEmbedRequest()` true — proxy.ts:25). Difference at step 4–5: "A signed payload is sufficient alone" — if `dcdata`+`dcsig` are present, the page waits a 1500 ms grace period for a postMessage envelope and then **POSTs `/dc-auth` with `{ dcData, dcSig }` only** (source tag `"hmac-only"`) (dc-embed/route.ts:94-97). `/dc-auth` accepts it unless `DC_SESSION_CHECK === "required"` (dc-auth/route.ts:42-43). If the handshake page finds itself top-level (no parent frame), it immediately `location.replace(RETURN)` instead of posting AppReady (dc-embed/route.ts:85).

### Path B — Standalone Entra ID OIDC

1. Unauthenticated top-level page request → proxy 302 to **`/auth/login?returnUrl=…`** (proxy.ts:52-58); the SPA does the same on a 401 from `/api/v1/me` (page.tsx:1118-1129).
2. `GET /auth/login`: requires `AUTH_ENTRA_TENANT_ID` + `AUTH_ENTRA_CLIENT_ID` + `AUTH_ENTRA_CLIENT_SECRET` (entra-oidc.ts:7-10; otherwise → `/auth/error?code=oidc_failed`). Builds the Entra authorize URL with **PKCE S256 + state + nonce**, scope `openid profile email`, against the tenant-pinned authority `https://login.microsoftonline.com/{AUTH_ENTRA_TENANT_ID}/v2.0` (login/route.ts:29-38; entra-oidc.ts:13-20). Stores `{cv, state, nonce, ru}` in the signed transient **`pulse-oidc`** cookie, **TTL 600 s (10 min)**, `SameSite=Lax` (entra-oidc.ts:37-38, 81-84). 302 to Microsoft.
3. User authenticates with Microsoft; Entra redirects to **`GET /auth/callback`** (redirect URI = `{PULSE_PUBLIC_URL}/auth/callback` — entra-oidc.ts:22-24).
4. `/auth/callback`: missing/expired `pulse-oidc` cookie (e.g. user sat on the consent screen past the 10-minute window) → restart at `/auth/login` (callback/route.ts:25-28). Exchanges the code with PKCE verifier + expected state/nonce (callback/route.ts:31-36); asserts the ID token `tid` equals `AUTH_ENTRA_TENANT_ID` (callback/route.ts:40-43); resolves the user via `resolveUserForEntra` (oid → legacy id → email claim; never rebinds a claimed real subject) (user-directory.ts:42-159). Errors → `/auth/error?code=not_provisioned` | `disabled` | `oidc_failed`.
5. Mints `pulse-session` with `amr: "entra"` (no `dc_embed`), clears `pulse-oidc`, 302 to the sanitized returnUrl (callback/route.ts:60-68).
6. `/auth/error` page — heading "Sign-in problem"; messages: `not_provisioned` → "Your account has not been set up in Pulse yet. Ask a DataCentral administrator to add you (same email address)."; `disabled` → "Your account is disabled — please contact an administrator."; `oidc_failed` (default) → "Sign-in failed. Please try again." (auth/error/page.tsx:4-11, 35).
7. Logout: `POST /auth/logout` clears the cookie (fetch-style); `GET /auth/logout` also 302s to `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/logout?post_logout_redirect_uri={PULSE_PUBLIC_URL}` to end the IdP session (logout/route.ts:7-27).

### Path C — Dev demo fallback

- No cookie, no headers. `getIdentity` step ④ hands out the fixed demo identity (details above) — but **only in memory mode**: "a SQL-backed box (i.e. production) that mistakenly sets PULSE_ALLOW_DEMO_IDENTITY must not grant admin either" (auth.ts:124-145).
- The proxy's login redirect is also skipped when `NODE_ENV !== "production"` or `PULSE_ALLOW_DEMO_IDENTITY === "true"`, and entirely when `PULSE_SESSION_SECRET` is unset (proxy.ts:47-50). Bicep deploys `PULSE_ALLOW_DEMO_IDENTITY = 'false'` (main.bicep:243).

---

## 3. MCP OAuth 2.1 flow end-to-end

### Actors & endpoints

- MCP client (e.g. claude.ai) · Browser (the human user) · Pulse (single App Service instance).
- Endpoints: `/mcp`, `/oauth/register`, `/oauth/authorize`, `/oauth/authorize/decision`, `/oauth/token`, and 4 discovery documents.

### Lifetimes (verified constants)

| Artifact | Lifetime | Evidence |
| --- | --- | --- |
| Authorization code | **5 min, single-use** — `CODE_TTL_MS = 5 * 60_000`; burned before any other validation on redemption | code-cache.ts:27, 54-67; token/route.ts:65-69 |
| Consent nonce | **10 min, single-use** — `CONSENT_TTL_MS = 10 * 60_000` | code-cache.ts:28; authorize/route.ts:88; decision/route.ts:59-63 |
| Access token | **1 h** — `ACCESS_TOKEN_SECONDS = 3600`; HS256 JWT, iss `pulse`, aud `pulse-mcp`, signed with `MCP_TOKEN_SIGNING_KEY` (base64, ≥64 bytes; ephemeral in-memory fallback with warning), 60 s clock tolerance on verify | tokens.ts:9, 49-64, 70-114 |
| Refresh token | **60 d, rotating** — `REFRESH_TOKEN_DAYS = 60`; opaque 48-byte token stored as SHA-256 hash; atomic single-use rotation (revoked in the same statement that validates it; wrong-client redeem never revokes) | tokens.ts:10, 120-192 |

### Step sequence

1. **Challenge:** client calls `/mcp` without a token → **401** with `WWW-Authenticate: Bearer resource_metadata="{base}/.well-known/oauth-protected-resource/mcp"` — "This exact challenge is how MCP clients bootstrap OAuth discovery" (mcp/route.ts:14-21).
2. **Resource discovery:** `GET /.well-known/oauth-protected-resource/mcp` (and `/.well-known/oauth-protected-resource`) → `{ resource: "{base}/mcp", authorization_servers: ["{base}"], scopes_supported: ["mcp"], bearer_methods_supported: ["header"] }` (discovery.ts:39-46; both route files).
3. **AS discovery:** `GET /.well-known/oauth-authorization-server` (and `/.well-known/oauth-authorization-server/mcp`) → issuer `{base}`, `authorization_endpoint {base}/oauth/authorize`, `token_endpoint {base}/oauth/token`, `registration_endpoint {base}/oauth/register`, `response_types ["code"]`, `grant_types ["authorization_code","refresh_token"]`, PKCE `["S256"]`, `token_endpoint_auth_methods ["none"]` (public clients), scopes `["mcp"]` (discovery.ts:18-30). `{base}` is `PULSE_PUBLIC_URL` when set, never the attacker-controllable Host header (base-url.ts:6-10).
4. **Dynamic client registration (RFC 7591):** `POST /oauth/register` — anonymous + CORS `*`, in-handler rate limit **10/min/IP** (register/route.ts:20-34). Redirect-URI policy (RFC 8252 §7.3): `https` anywhere; `http` loopback only (`localhost`, `127.x.x.x`, `::1`); private-use native schemes allowed; fragments rejected (client-store.ts:78-99). Returns `client_id` (+ `token_endpoint_auth_method: "none"`, grants, response types) with **201** (register/route.ts:74-89). Clients persist to `dbo.McpClients` (SQL) or an in-memory map (client-store.ts:24-49).
5. **Authorization (browser leg):** `GET /oauth/authorize?client_id&redirect_uri&response_type=code&code_challenge&code_challenge_method=S256&state`. `client_id`/`redirect_uri` validated **before anything else** — failures are a local 400 ("Unknown client_id." / "Unregistered redirect_uri."), never a redirect (open-redirect guard); later failures redirect back to the client per RFC 6749 §4.1.2.1 (authorize/route.ts:36-60). Unauthenticated visitor → **302 `/auth/login?returnUrl=/oauth/authorize?...`** — the MCP flow reuses Pulse's normal sign-in (browser-auth.ts:10-21). Signed-in → consent nonce minted (10 min) and the consent page rendered (authorize/route.ts:77-94).
6. **Consent page** (title "Connect to DataCentral Pulse"): eyebrow "DataCentral Pulse", heading "Allow access to your account?", body "**{client}** ({origin}) is asking to access DataCentral Pulse as **{name}** ({email}) — it will be able to do everything you can do. All actions are logged as you.", buttons "**Deny**" and "**Allow**" posting to `/oauth/authorize/decision` (consent-page.ts:37-53). All interpolations HTML-escaped (client_name is attacker-controlled) (consent-page.ts:1-16).
7. **Decision:** `POST /oauth/authorize/decision` — inline same-origin guard (route is outside the proxy's `/api/*` CSRF matcher); nonce burned single-use (expired → "Consent request expired — restart the connection from your MCP client."); the signed-in user must equal the user the consent was rendered for; deny → 302 `redirect_uri?error=access_denied`; allow → mints a 32-byte code (5 min) and 302 `redirect_uri?code&state` (decision/route.ts:44-96).
8. **Token exchange:** `POST /oauth/token` (anonymous + CORS, `application/x-www-form-urlencoded`). `grant_type=authorization_code`: code burned **before** validation, then `client_id`, `redirect_uri`, and PKCE `code_verifier` (S256, 43–128 chars, constant-time compare) checked; user must be `Active` → `{ access_token, token_type: "Bearer", expires_in: 3600, refresh_token, scope: "mcp" }` with `cache-control: no-store` (token/route.ts:48-85, 18-30; crypto.ts:14-20).
9. **Refresh:** `grant_type=refresh_token` → atomic rotate-and-reissue; invalid/expired/revoked/wrong-client → `invalid_grant`; inactive user → `invalid_grant` "The user account is not active." (token/route.ts:87-99; tokens.ts:149-192).
10. **Authenticated MCP calls:** `Authorization: Bearer <access_token>` on `/mcp`. Every request re-verifies the JWT and re-resolves the user's active memberships (`getIdentityContext`) — 403 `invalid_token` "No active account is linked to this token." if the account is gone/disabled (mcp/route.ts:24-42). All 58 registry tools are registered with `readOnlyHint` annotations; each call runs with the token-bound identity clone; server instructions come from the shared `buildAssistantInstructions` (mcp/route.ts:49-66).
- CORS: `/mcp`, `/oauth/register`, `/oauth/token`, and the 4 discovery routes send `access-control-allow-origin: *` etc.; `/oauth/authorize` deliberately does not (browser navigation) (cors.ts:1-10; authorize/route.ts:5-6).
- Storage: codes + consents in an in-memory single-instance cache (worst case on restart: user redoes consent) (code-cache.ts:1-7); refresh tokens and clients in Azure SQL (`dbo.McpRefreshTokens`, `dbo.McpClients`) or memory maps in dev (tokens.ts:125-147; client-store.ts:34-49).

---

## 4. CSP / framing posture (who may frame what)

| Surface | frame-ancestors | Source |
| --- | --- | --- |
| `/`, `/dc-embed`, `/dc-auth`, `/auth/*` (proxy-matched pages) | `DC_FRAME_ANCESTORS` env, default **`'self' https://*.datacentral.ai`** — DataCentral (and Pulse itself) may frame the app | proxy.ts:18, 33-36, 45-46, 60; main.bicep:250 |
| `/mcp`, `/oauth/*` | **`frame-ancestors 'none'`** — "the /oauth/authorize consent button grants a full-power MCP token, so it must NEVER be frameable (anti-clickjacking)" | proxy.ts:37-44 |
| Everything else (incl. `/.well-known/*`, `/api/*`) | Base CSP from next.config.ts with **no frame-ancestors directive** | next.config.ts:14; proxy.ts:136-138 |

- Base CSP (identical string in both places; the proxy header **replaces** the next.config one on matched paths): `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://*.blob.core.windows.net` (proxy.ts:20-22; next.config.ts:14).
- Other global headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(self), geolocation=()` (next.config.ts:11-13).
- postMessage origin allow-list (separate from CSP): `DC_ALLOWED_PARENT_ORIGINS` (default `https://app.datacentral.ai`) plus any `*.datacentral.ai` hostname (dc-embed/route.ts:18-19, 39-42).
- API CSRF: cross-site mutations to `/api/*` rejected 403 `CSRF_REJECTED` (Origin host mismatch or `Sec-Fetch-Site: cross-site`; unparseable Origin fails closed) (proxy.ts:63-90). `/dc-auth` and `/oauth/authorize/decision` carry their own inline same-origin guards because they sit outside that matcher branch (dc-auth/route.ts:17-27; decision/route.ts:44-49).

---

## 5. Diagram-ready data

### 5.1 System architecture diagram — nodes & edges

**Nodes**

| ID | Label | Notes |
| --- | --- | --- |
| DC | DataCentral portal (`app.datacentral.ai`) | frames Pulse; posts AccessToken envelope |
| Browser | User's browser | SPA `app/page.tsx` + ChatPanel |
| Proxy | `proxy.ts` gate | CSP/frame-ancestors, login redirect, CSRF, rate limit, correlation IDs |
| Page | `app/page.tsx` SPA | single page, ~6,174 lines |
| API | `app/api/v1/**` routes | REST, `getIdentity()` per request |
| AuthRoutes | `/auth/login·callback·logout·error`, `/dc-embed`, `/dc-auth` | session minting |
| OAuthAS | `/oauth/register·authorize·authorize/decision·token` + 4 `/.well-known/*` docs | MCP authorization server |
| MCP | `/mcp` | stateless Streamable HTTP MCP server |
| Registry | `lib/server/chat/tool-registry.ts` | 58 tools (24 customer / 23 internal / 11 admin) |
| ChatSvc | `assistant-service.ts` → Anthropic API | model default `claude-opus-4-8` |
| SlackSvc | `instrumentation.ts` → `slack/socket-service.ts` | Socket Mode WebSocket to Slack |
| Session | `lib/server/session.ts` | `pulse-session` JWT cookie, 12 h |
| Repos | `lib/server/*-repository.ts` (dual-mode) | SQL ⟷ seeded memory switch `isAzureSqlConfigured()` |
| SQL | Azure SQL `Pulse` (S1) | Entra-only auth, managed identity |
| Blob | Azure Blob `pulse-attachments` | ZRS, no public access |
| KV | Azure Key Vault | 10 secrets via `@Microsoft.KeyVault` references |
| Plan | App Service P1v3 **capacity 1** | single instance — do not scale out |
| AI | Application Insights + Log Analytics | 30-day retention |
| Entra | Microsoft Entra ID (`login.microsoftonline.com/{tenant}/v2.0`) | OIDC IdP |
| Slack | Slack workspace | DMs + @mentions |
| MCPClient | MCP client (e.g. claude.ai) | OAuth 2.1 + Bearer |
| Anthropic | Anthropic API | chat + Slack brain |

**Edges:** DC —frames→ Browser; Browser →Proxy→ {Page, API, AuthRoutes}; MCPClient →(no proxy CSP exemption; matcher covers /mcp, /oauth)→ {OAuthAS, MCP}; AuthRoutes →mint→ Session; API →`getIdentity`→ Session; {API, MCP, ChatSvc, SlackSvc} →Registry→ Repos; Repos →{SQL | memory}; API →Blob (SAS); App →KV (managed identity); AuthRoutes ↔Entra; SlackSvc ↔Slack (outbound WebSocket); ChatSvc →Anthropic; everything runs inside Plan; telemetry → AI.

### 5.2 Auth-paths sequence diagram — steps

**Path A/A′ (DataCentral embed / launch URL):**
1. DC iframe → `GET /` (+`dcdata`&`dcsig` on the URL in the launch-URL variant)
2. proxy: no session, `isEmbedRequest` → `302 /dc-embed?returnUrl=…`
3. `/dc-embed` page → parent: `postMessage {type:"AppReady "}` + `{type:"AppReady"}`
4. DC parent → iframe: `postMessage {accessToken, graphToken?}` or `{type:"AccessToken", token}` *(A′: skipped — 1500 ms grace, then HMAC-only)*
5. iframe → `POST /dc-auth` `{dcData, dcSig, accessToken?, graphToken?}`
6. `/dc-auth`: verify HMAC (`DC_APP_SECRET`), optional `checkDcSession` → DataCentral `GET /api/services/app/Session/GetCurrentLoginInformations`; resolve user in `dbo.Users`
7. `/dc-auth` → `200` + `Set-Cookie: pulse-session` (`amr: dc-hmac` or `dc-graph`, `dc_embed: true`; 12 h; `SameSite=None; Secure; Partitioned`)
8. iframe: strip `dcdata/dcsig`, `location.replace(returnUrl)` → app loads authenticated (chrome hidden)

**Path B (standalone Entra OIDC):**
1. Browser → `GET /` → proxy `302 /auth/login?returnUrl=…`
2. `/auth/login`: PKCE S256 + state + nonce; `Set-Cookie: pulse-oidc` (10 min); `302 login.microsoftonline.com/{tenant}/v2.0/authorize`
3. User signs in at Microsoft → `302 /auth/callback?code&state`
4. `/auth/callback`: code+PKCE exchange, state/nonce verified, `tid` re-pinned, `resolveUserForEntra`
5. `302 returnUrl` + `Set-Cookie: pulse-session` (`amr: entra`) + clear `pulse-oidc`
6. Failure exits → `302 /auth/error?code=oidc_failed|not_provisioned|disabled`

**Path C (dev demo fallback):** request with no credential → `getIdentity` ④ → fixed "Bjarki Kristjánsson" System-admin identity (`amr: dev`) — memory mode only; no cookie ever minted.

### 5.3 MCP OAuth sequence diagram — steps

1. MCPClient → `POST /mcp` (no token) → **401** `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"`
2. MCPClient → `GET /.well-known/oauth-protected-resource/mcp` → resource + AS pointer
3. MCPClient → `GET /.well-known/oauth-authorization-server` → endpoints (authorize/token/register), PKCE S256, auth `none`
4. MCPClient → `POST /oauth/register` (RFC 7591) → **201** `client_id` (rate limit 10/min/IP)
5. Browser → `GET /oauth/authorize?client_id&redirect_uri&response_type=code&code_challenge(S256)&state` → (if signed out: `302 /auth/login` round trip) → consent page; **consent nonce, 10 min single-use**
6. Browser → clicks "Allow" → `POST /oauth/authorize/decision` (same-origin, nonce burned, user match) → `302 redirect_uri?code&state`; **code: 5 min single-use**
7. MCPClient → `POST /oauth/token` `grant_type=authorization_code&code&code_verifier&client_id&redirect_uri` → `{access_token (1 h JWT), refresh_token (60 d opaque), expires_in: 3600, scope: "mcp"}`
8. MCPClient → `/mcp` with `Authorization: Bearer …` → per-request user/membership re-check → 58 tools
9. On expiry: `POST /oauth/token` `grant_type=refresh_token` → **rotation**: old refresh token atomically revoked, new access+refresh pair issued
10. Revocation paths: user deactivated ⇒ token verification 403 at `/mcp` and `invalid_grant` at refresh (mcp/route.ts:36-41; token/route.ts:83, 97)

---

## 6. Notable exact strings for screenshots

- `/dc-embed`: "Connecting to DataCentral…", "Could not sign you in automatically.", "Open Pulse sign-in" (dc-embed/route.ts:31-33)
- `/auth/error`: "Sign-in problem" + the three whitelisted messages (auth/error/page.tsx:4-9, 35)
- Consent page: "Connect to DataCentral Pulse", "Allow access to your account?", "…it will be able to do everything you can do. All actions are logged as you.", buttons "Deny" / "Allow" (consent-page.ts:37-52)
- Consent expiry: "Consent request expired — restart the connection from your MCP client." (decision/route.ts:13)
- Chat panel: header "✦ Assistant", placeholder "Ask the assistant…", unconfigured notice "The assistant needs an API key. Ask an administrator to set" [ANTHROPIC_API_KEY] (chat-panel.tsx:249, 337, 271)
- Slack refusals: "Your Slack account isn't linked to a DataCentral Pulse user. Ask an administrator to add an account with the same email address as your Slack profile." / "Your account is disabled — please contact an administrator." / "Your account has no active organization membership. Ask an administrator to add you to an organization." (identity.ts:58-63)
- API error codes: `CSRF_REJECTED` ("Cross-site mutation rejected."), `RATE_LIMITED` ("Too many requests. Please try again shortly.") (proxy.ts:84-85, 110-111)
