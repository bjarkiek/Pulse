# configInfo.md — AI assistant, Slack, MCP, and DataCentral embed configuration

This is the operator setup guide for the three subsystems added on top of the
core Pulse app (see [`README.md`](README.md) for SQL/Storage/notification
configuration): the in-app AI assistant + Slack bot, the remote MCP server
with its self-hosted OAuth 2.1 authorization server, and DataCentral
iframe-embed authentication with standalone Entra ID login. Every variable
and command below is taken directly from [`.env.example`](.env.example),
[`infra/main.bicep`](infra/main.bicep), and the source files cited inline —
if reality and this document ever disagree, trust the code and file an
issue against this doc.

Related docs: [`docs/slack-setup.md`](docs/slack-setup.md) (Slack app
manifest + token walkthrough), [`docs/architecture.md`](docs/architecture.md)
(security boundaries and the single-instance constraint), and the design
plan at
[`docs/superpowers/plans/2026-07-15-ai-chat-mcp-datacentral-embed.md`](docs/superpowers/plans/2026-07-15-ai-chat-mcp-datacentral-embed.md).

Every secret below is optional to leave unset in isolation — the affected
subsystem degrades gracefully (chat panel shows "unconfigured", Slack never
connects, MCP tokens are ephemeral) — but a production deployment needs all
of them for the full feature set to work as designed.

---

## 1. Anthropic API key

The AI assistant (in-app chat panel + Slack bot) is powered by the Anthropic
API (`@anthropic-ai/sdk`, `lib/server/chat/assistant-service.ts`). Without a
key, `isAssistantConfigured()` returns `false` and the chat panel reports
itself as unconfigured; Slack never starts either (Slack also requires its
own tokens — see §2).

1. Create a key at <https://console.anthropic.com/> (Settings → API Keys).
2. **Dev** — add to `.env.local`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
3. **Prod** — pass the raw key as a Bicep parameter; the template creates the
   Key Vault secret and wires the App Service setting to a Key Vault
   reference for you (`infra/main.bicep`, `anthropicApiKeySecret` resource):
   ```bash
   az deployment group create \
     --resource-group <resource-group> \
     --template-file infra/main.bicep \
     --parameters ... anthropicApiKey='sk-ant-...'
   ```
   Leaving `anthropicApiKey` empty (its default) leaves `ANTHROPIC_API_KEY`
   unset in the deployed app and the assistant stays unconfigured.
4. **Optional model override** — env var `ANTHROPIC_MODEL`, Bicep parameter
   `anthropicModel`. Default (both in code and in the Bicep parameter
   default): `claude-opus-4-8`.
   ```
   ANTHROPIC_MODEL=claude-opus-4-8
   ```

## 2. Slack app

Slack is an optional second front-end for the same assistant (DMs and
`@mentions`, Socket Mode — no inbound webhook to expose). Full walkthrough,
including the exact bot scopes and events and the identity-matching rule, is
in [`docs/slack-setup.md`](docs/slack-setup.md); this section is the
condensed command/variable reference. `startSlackAssistant()`
(`lib/server/slack/socket-service.ts`) no-ops unless **both** tokens below
are set.

1. Create the app from the manifest (workspace admin, ~3 min):
   <https://api.slack.com/apps?new_app=1> → **From a manifest** → paste
   [`slack-app-manifest.yaml`](slack-app-manifest.yaml) (YAML mode) → **Create**.
2. Generate the app-level token — **Basic Information** → **App-Level
   Tokens** → **Generate Token and Scopes** → add scope `connections:write`
   (required for Socket Mode) → copy the `xapp-...` value. This is
   `SLACK_APP_TOKEN`.
3. Install the app — **Install App** → **Install to Workspace** → copy the
   **Bot User OAuth Token** (`xoxb-...`). This is `SLACK_BOT_TOKEN`.
4. **Dev** — add to `.env.local`:
   ```
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   ```
5. **Prod** — Bicep parameters `slackBotToken` / `slackAppToken` (both
   `@secure()`, each conditionally written to Key Vault only when non-empty):
   ```bash
   az deployment group create \
     --resource-group <resource-group> \
     --template-file infra/main.bicep \
     --parameters ... slackBotToken='xoxb-...' slackAppToken='xapp-...'
   ```

Never commit either token. Both flow through Key Vault references in
production, matching the pattern used for the other App Service secrets.

## 3. Identity prerequisites

Two independent sign-in surfaces exist — the DataCentral iframe embed
(`/dc-embed` → `/dc-auth`) and standalone Entra login (`/auth/login` →
`/auth/callback`) — plus, once either succeeds, a shared `pulse-session`
cookie (§4). Both require the caller to already exist in Pulse.

**Users must be pre-provisioned.** There is no self-service signup for
either identity path. An administrator adds the user first, in the admin
panel's **Users** tab (`POST /api/v1/admin/users`, `lib/server/user-directory.ts`).
The email on that Pulse user record must **exactly** match:
- the user's Entra `preferred_username`/UPN, for standalone Entra login or
  the Graph-token fallback (see below), or
- their DataCentral launch profile email or workspace-verified Slack email,
  for the DataCentral embed and Slack paths respectively (Slack matching is
  covered in `docs/slack-setup.md` §3).

No fallback to display name or any other claim is attempted
(`resolveUserForEntra` / `resolveUserForDcLaunch` in `lib/server/user-directory.ts`).
An unprovisioned or disabled user is rejected with `403 not_provisioned` /
`403 disabled` from `/dc-auth`.

**Entra app registration** (needed for standalone login and for the Graph
fallback below):
- Redirect URI (web platform): `https://{host}/auth/callback` — confirmed
  route at `app/auth/callback/route.ts`; built from `PULSE_PUBLIC_URL` in
  `lib/server/entra-oidc.ts`'s `redirectUri()`.
- A client secret.
- Env vars (`lib/server/entra-oidc.ts`, gates `isEntraConfigured()`):
  ```
  AUTH_ENTRA_TENANT_ID=<tenant-guid>
  AUTH_ENTRA_CLIENT_ID=<application-client-id>
  AUTH_ENTRA_CLIENT_SECRET=<client-secret>
  ```
  Bicep parameters: `entraTenantId` (defaults to the deployment tenant),
  `entraClientId` (defaults empty — also gates Easy Auth, see §5),
  `entraClientSecret` (`@secure()`, required, no default).

**DataCentral Tool configuration** (needed for the embed):
- Shared HMAC secret, verifying the signed `dcdata`/`dcsig` launch payload
  (`lib/server/datacentral.ts`, `verifyDcLaunch`):
  ```
  DC_APP_SECRET=<shared-secret-from-datacentral-tool-config>
  ```
  Bicep parameter: `dcAppSecret` (`@secure()`, required, no default).
- Host allow-lists, both defaulting to `https://app.datacentral.ai` /
  `https://*.datacentral.ai` (`.env.example`, `app/dc-embed/route.ts`,
  `proxy.ts`):
  ```
  DC_ALLOWED_PARENT_ORIGINS=https://app.datacentral.ai
  DC_FRAME_ANCESTORS='self' https://*.datacentral.ai
  ```
  `DC_ALLOWED_PARENT_ORIGINS` is the comma-separated list of `postMessage`
  origins `/dc-embed`'s handshake script will accept (plus any
  `*.datacentral.ai` host, hard-coded). `DC_FRAME_ANCESTORS` is the
  `Content-Security-Policy: frame-ancestors` value the proxy sets on
  embeddable pages (`/dc-embed`, `/dc-auth`, `/auth/*`, and — when signed
  in — every non-API page). `/mcp` and `/oauth/*` are deliberately never
  framed (`frame-ancestors 'none'`, anti-clickjacking on the MCP consent
  screen) regardless of this setting.
- Optional: `DC_API_BASE_URL` overrides the base URL used for the live
  DataCentral session check (defaults to the launch payload's own
  `clientUrl`); `DC_SESSION_CHECK` controls that check's strictness — `off`
  | `when-available` (default) | `required` (`lib/server/datacentral.ts`,
  `checkDcSession`).

**Graph-token forwarding — correction to how this actually gates sign-in.**
The DataCentral embed's *primary* sign-in path is the signed `dcdata`/`dcsig`
launch payload alone (Path 1 in `app/dc-auth/route.ts`) — it authenticates
successfully with **no** Graph token at all, 1.5 s after page load, as long
as `DC_APP_SECRET` is configured. A forwarded Microsoft Graph access token
(`graphToken`/`aadToken` in the `postMessage` envelope, validated by
`lib/server/graph-validate.ts` via a live `GET https://graph.microsoft.com/v1.0/me`)
is only consulted as a **fallback** (Path 2), used when `dcData`/`dcSig`
never arrive at all. In a normally configured deployment (`DC_APP_SECRET`
set) that fallback is effectively dead code — so enabling Graph-token
forwarding for the Tool in DataCentral admin is not required for the embed
to sign in. It only matters if you deploy without `DC_APP_SECRET`, or add a
sign-in path that intentionally relies on the Graph fallback. Either way,
`/dc-embed` shows inline diagnostics: if no usable message ever arrives (or
the exchange fails), a fallback UI appears after ~8 s showing which parent
origins it saw, whether the `postMessage` envelope arrived, and the specific
`/dc-auth` error — confirmed in `app/dc-embed/route.ts`'s `HANDSHAKE_HTML`.

**Legacy per-request header auth** (rarely needed — off by default):
```
# PULSE_TRUST_DC_HEADERS=false
```
When `true`, `lib/server/auth.ts` additionally accepts a caller presenting
`X-DC-Data`/`X-DC-Sig` headers directly on every API request (re-verified
every time, no session). No code in the app emits these headers today; only
enable this if an external API client needs to authenticate by forwarding a
DataCentral launch payload itself.

## 4. Session + MCP secrets

Two independent HMAC/JWT signing secrets. Both are self-issued by Pulse (no
external IdP for these), and both have a documented degraded mode:

**`PULSE_SESSION_SECRET`** — signs/verifies the `pulse-session` cookie
(`lib/server/session.ts`) issued by both the DataCentral embed and the
standalone Entra flow, and the transient `pulse-oidc` state cookie
(`lib/server/entra-oidc.ts`) used mid-login. **Minimum 32 characters**,
enforced in code (`session.ts`: `if (s && s.length >= 32) return ...`).
```
PULSE_SESSION_SECRET=<32+ character random string>
```
Generate one with `openssl rand -base64 32` (or longer). Bicep parameter:
`sessionSecret` (`@secure()`, required, no default).

*Consequence when missing:* in dev (`NODE_ENV !== "production"`), a fixed
dev-only fallback string is used automatically — no local setup required. In
**production**, an unset or too-short secret makes `secret()` return `null`:
no session can be issued or verified, so both the DataCentral embed and the
standalone Entra login fail to establish a session, and every API call that
needs identity returns `401 UNAUTHORIZED`. (One further wrinkle: `proxy.ts`'s
own page-level "redirect anonymous visitors to login" gate is itself keyed
off `process.env.PULSE_SESSION_SECRET` being truthy — so when it's unset in
production, unauthenticated page requests are *not* redirected to
`/auth/login`/`/dc-embed`; they fall through and fail later, at the API
layer, with 401s rather than a clean login redirect.)

**`MCP_TOKEN_SIGNING_KEY`** — signs/verifies the self-issued HS256 MCP
access tokens and hashes the MCP refresh tokens (`lib/server/mcp/tokens.ts`,
used by `app/oauth/*` and `app/mcp`). **Base64, ≥64 bytes** decoded, enforced
in code (`tokens.ts`: `if (buf.length >= 64) return buf`).
```
MCP_TOKEN_SIGNING_KEY=<base64, decodes to 64+ bytes>
```
Generate with:
```bash
openssl rand -base64 64
```
PowerShell:
```powershell
[Convert]::ToBase64String((1..64 | % { Get-Random -Max 256 }))
```
Bicep parameter: `mcpTokenSigningKey` (`@secure()`, required, no default).

*Consequence when missing (or shorter than 64 bytes):* `signingKey()` falls
back to a per-process ephemeral key (`randomBytes(64)`, memoized on
`globalThis` so dev hot-reload doesn't regenerate it, but a real process
restart/redeploy does) and logs:
```
[mcp/tokens] MCP_TOKEN_SIGNING_KEY is not configured (or shorter than 64 bytes) —
using an ephemeral in-memory signing key. Issued MCP access/refresh tokens will
not survive a process restart. Set MCP_TOKEN_SIGNING_KEY (base64, >=64 bytes) in production.
```
Every MCP client's access and refresh tokens become invalid on the next
restart/deploy, forcing a fresh `claude mcp add` / re-authorization.

**`PULSE_PUBLIC_URL`** — not a secret, but load-bearing for both subsystems
above: it's the externally-visible base URL used to build the Entra
`redirect_uri` (`entra-oidc.ts`), the MCP OAuth issuer/endpoint URLs and the
`WWW-Authenticate` challenge (`lib/server/mcp/base-url.ts`, deliberately
*not* trusting the inbound `Host` header), and the post-logout/login
redirect targets. Set it to the app's real HTTPS origin in every non-local
environment:
```
PULSE_PUBLIC_URL=https://{host}
```

## 5. Hosting

**Single instance is mandatory.** Three components keep state in
in-process memory, not a shared store — see
[`docs/architecture.md`](docs/architecture.md#single-instance-constraint-mcp-oauth-cache-proxy-rate-limits-and-slack-socket-mode)
for the full explanation:
- the MCP OAuth authorization-code/consent cache (`lib/server/mcp/code-cache.ts`);
- the DataCentral/API proxy's per-route rate limiter (`proxy.ts`, `globalThis.pulseRateLimits`);
- Slack's Socket Mode connection (one persistent outbound WebSocket per process).

`infra/main.bicep` pins this: the App Service plan is `P1v3` with
`capacity: 1` and `alwaysOn: true`, with a comment (`// Slack Socket Mode +
in-memory OAuth/chat caches require a single instance — do not scale out.`)
directly above the resource. **Do not change the plan's `capacity` above 1
while Slack is configured or MCP OAuth is in use.**

Deploys briefly drop the Slack Socket Mode connection while the container
restarts; the Slack SDK reconnects automatically once the new instance is
up — no manual intervention needed, but expect a short gap (seconds) where
the bot doesn't respond.

**Future VNet/egress lockdown** must allow outbound access to, at minimum:
- `wss://*.slack.com` and `https://slack.com` — Slack Socket Mode + Web API;
- `https://api.anthropic.com` — the AI assistant;
- `https://graph.microsoft.com` — the Graph-token fallback validation path (§3);
- `https://login.microsoftonline.com` — Entra OIDC discovery/token exchange.

**Easy Auth → app-level auth migration.** `infra/main.bicep`'s
`authsettingsV2` resource (deployed only `if (!empty(entraClientId))`) sets
`unauthenticatedClientAction: 'AllowAnonymous'` with a comment explaining
why: the app's own session/DataCentral checks are now authoritative, and
Easy Auth's top-level redirect would otherwise break the DataCentral iframe
embed. The template also excludes `/mcp`, all four `/.well-known/oauth-*`
variants, `/oauth/register`, and `/oauth/token` from Easy Auth entirely
(each enforces its own bearer-token check) — but deliberately does **not**
exclude `/oauth/authorize` or `/oauth/authorize/decision`, so an
unauthenticated browser hitting `authorize` still falls through to Pulse's
own login redirect. Per the template's own comment: flipping
`unauthenticatedClientAction` in the Bicep source does **not** retroactively
change an already-deployed `authsettingsV2` resource — redeploying this
template to an existing environment is an explicit, intentional step, not
something that happens implicitly on the next unrelated deploy.
`PULSE_TRUST_EASYAUTH_HEADERS` (default `false`) is the separate app-level
switch that decides whether Pulse's own `getIdentity()` will additionally
trust Easy Auth's `X-MS-CLIENT-PRINCIPAL*` headers as an identity source —
keep it `false` unless you are mid-migration and intentionally relying on
Easy Auth headers again.

## 6. Verification

1. **Slack connects.** Start (or redeploy) with both Slack tokens set and
   confirm the log line (exact string, `lib/server/slack/socket-service.ts`):
   ```json
   {"level":"info","message":"Slack Socket Mode connected"}
   ```
2. **Chat panel smoke test.** With `ANTHROPIC_API_KEY` set, open Pulse, open
   the chat panel, and send a message — it should get a reply rather than an
   "unconfigured" notice.
3. **Slack DM + mention test.** DM the `pulse` bot directly, then
   `/invite @pulse` into a channel and `@mention` it. Both should show a ⏳
   reaction almost immediately, then a reply (threaded for the mention;
   threaded-or-inline for the first DM), with the ⏳ removed once the reply
   posts. Full detail in `docs/slack-setup.md` §4.
4. **MCP OAuth round trip.** With `MCP_TOKEN_SIGNING_KEY` set and a session
   available to authorize against:
   ```bash
   claude mcp add --transport http pulse https://{host}/mcp
   ```
   This should walk through dynamic client registration
   (`POST /oauth/register`), the authorize/consent screen
   (`GET /oauth/authorize` → `/oauth/authorize/decision`), and a token
   exchange (`POST /oauth/token`), then let the client call tools against
   `/mcp` with a working bearer token. A read tool (e.g. `list_my_requests`)
   should return data; a write tool the signed-in user lacks permission for
   should read as **"That item doesn't exist or you don't have access to
   it."** (the actual shipped message, `lib/server/chat/tool-contract.ts`
   `chatToolErrorMessage` — not the generic "not found or not accessible"
   phrasing from earlier planning notes) rather than leaking a permission
   error.
5. **DataCentral embed test.** Launch Pulse as a Tool from DataCentral and
   confirm it signs in without the `/dc-embed` fallback UI appearing.
   Without a live DataCentral session handy, the wiring can be spot-checked
   with curl against the proxy's embed-detection logic (`proxy.ts`,
   `isEmbedRequest`) — either signal is sufficient:
   ```bash
   curl -sI "https://{host}/?dcdata=x&dcsig=y"
   curl -sI -H "Sec-Fetch-Dest: iframe" "https://{host}/"
   ```
   Both should route to `/dc-embed` (unauthenticated) rather than
   `/auth/login`.
6. **Voice dictation.** Requires a Chromium-based browser (Chrome or Edge)
   or Safari — `SpeechRecognition`/`webkitSpeechRecognition` support varies
   by browser and isn't available in Firefox. Also requires the shipped
   `Permissions-Policy` header to allow the microphone in the app's own
   frame; the actual shipped value (`next.config.ts`) is:
   ```
   Permissions-Policy: camera=(), microphone=(self), geolocation=()
   ```
   (i.e. microphone is allowed for same-origin use, camera and geolocation
   are not requested by the app and stay blocked).
