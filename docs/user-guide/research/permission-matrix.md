# DataCentral Pulse — Permission Matrix (verified against code)

All claims cite `file:line` in the repo at `C:/VS Code/Pulse`. Role names, statuses, and UI labels are quoted exactly as they appear in code.

## 1. The role model

Roles live on **memberships**, not on users. A user has one identity and any number of organization memberships; each membership carries its own role. The membership object shape used by the identity context and the assistant is `{ id, name, type, role, active }` (`lib/server/identity-repository.ts:4-10`; confirmed by the comment in `lib/server/chat/tool-registry.ts:26-29`: "Membership shape is the real one from identity-repository.ts: { id, name, type, role, active } — there is no organizationId/organizationName/organizationType/status field").

- The session/identity token never carries a trusted role — `getIdentity` stamps `role: "Unknown"` (`lib/server/auth.ts:50`) and every repository re-verifies membership and role from `dbo.Memberships` per request (comment at `lib/server/auth.ts:24-25`).
- Organizations have a `type` of `"Customer" | "Partner" | "Internal"` (`lib/server/admin-repository.ts:7`).
- **Customer-org roles** (assignable): `"Company admin" | "Requester" | "Viewer" | "Product manager"` (`lib/server/admin-repository.ts:23`).
- **Internal roles recognized by authorization**: `"Internal contributor", "Product manager", "System admin"` — the default role list of `requireInternalRole` (`lib/server/authorization.ts:28-31`).
- Server-side, `"Requester"` and `"Viewer"` behave identically — no repository ever branches on `"Viewer"` or `"Requester"` (only occurrences in `lib/` are the type/enum declarations, `lib/server/admin-repository.ts:23` and `lib/server/chat/tools-admin.ts:131`). `"Company admin"` only matters for withdrawing/editing other people's requests inside the org (`lib/server/request-repository.ts:399,441,552,590`).

### Persona → role mapping used in the matrix

| Matrix column | Concrete membership |
|---|---|
| Customer Member | role `Requester` or `Viewer` in a `Customer`-type org |
| Customer Company admin | role `Company admin` in a `Customer`-type org |
| Internal contributor | role `Internal contributor` in the `Internal`-type org |
| Product manager | role `Product manager` in the `Internal`-type org |
| System admin | role `System admin` in the `Internal`-type org |

### The three enforcement primitives

1. **`requireMembership(identity, organizationId?)`** — user must hold an **Active** membership in the target org (org itself not `Inactive`); throws `FORBIDDEN` otherwise (`lib/server/authorization.ts:4-26`, throw at :21). Internal staff are **not global**: viewing a customer org's requests requires a membership row in that org — the Users page callout states this exactly: "Internal employees are not global by default. Assign each employee only to the customer companies they support." (`app/page.tsx:3959-3963`).
2. **`requireInternalRole(identity, roles?)`** — Active membership in an `Internal`-type org with role in the list; default list is `["Internal contributor", "Product manager", "System admin"]` (`lib/server/authorization.ts:28-47`). **`requirePublishRole`** narrows it to `["Product manager", "System admin"]` (`lib/server/authorization.ts:49-51`).
3. **`assertAdmin`** (admin repository, private) — Active membership in an `Internal` org with role exactly `'System admin'` (`lib/server/admin-repository.ts:58-71`, SQL at :68). Guards `listOrganizations` (:73), `saveOrganization` (:91), `listUsers` (:140), `saveUser` (:165).

A fourth, comment-specific check: **`canWriteInternal`** — Active membership in an `Internal` org with role in `('Product manager','System admin','Internal contributor')` (`lib/server/comment-repository.ts:35-45`, SQL at :42). Gates seeing and writing `Internal`-visibility comments.

## 2. Permission matrix

Legend: **Yes** / **No** / **Partial** (see note). "Internal staff*" cells assume the internal person also has a membership in the relevant customer org where org-scoped data is involved (`requireMembership`, `lib/server/authorization.ts:4-26`).

| Capability | Customer Member | Customer Company admin | Internal contributor | Product manager | System admin | Enforcing code |
|---|---|---|---|---|---|---|
| View own org's requests | Yes | Yes | Yes* | Yes* | Yes* | `listRequests` → `requireMembership` (`request-repository.ts:94-101`); row filter `visibility='Organization' OR created_by OR owner` (`request-repository.ts:119-120`) |
| Submit request (`POST /api/v1/requests`) | Yes (incl. Viewer — no role check) | Yes | Yes* | Yes* | Yes* | `createRequest` → `requireMembership` only (`request-repository.ts:167-180`); route `app/api/v1/requests/route.ts:14-37` |
| Edit own request (only while `Submitted` / `Needs information`) | Yes (author only) | Yes (any request in org) | No (unless author) | Yes* | Yes* | `editRequest`: author or `Company admin` or `requirePublishRole` (`request-repository.ts:530-556` memory, :587-594 SQL); status guard :593-594 |
| Withdraw request (status `Withdrawn`) | Yes (author only) | Yes (any request in org) | No (unless author) | Yes* | Yes* | `updateRequestStatus`: non-internal may only set `Withdrawn` (`request-repository.ts:384`); withdraw needs author or `Company admin`, else `NOT_FOUND` (`request-repository.ts:396-401,435-445`) |
| Other status changes (`Needs information`, `Linked`, `Routed to support`, `Closed`) | No | No | **No** | Yes | Yes | `updateRequestStatus` → `requirePublishRole` try/catch; non-publish role → `FORBIDDEN` (`request-repository.ts:377-384`) |
| Comment on a request (`Customer` visibility) | Yes | Yes | Yes* | Yes* | Yes* | `addComment`: must see the request via `listRequests` (`comment-repository.ts:99-100`); visibility enum `"Customer" | "Internal"` (`comment-repository.ts:9`) |
| Edit own comment | Yes (15-min window) | Yes (15-min window) | Yes (no window) | Yes (no window) | Yes (no window) | 15-minute window for non-internal authors (`comment-repository.ts:215-220,236-241`); internal may edit any (`comment-repository.ts:213-214,234-235`) |
| Vote / register interest (follow idea, "solves my need") | Yes | Yes | Yes | Yes | Yes | `toggleFollow` requires Active membership (`idea-repository.ts:206-213`); `recordInterest` writes `OrganizationInterests` (`idea-repository.ts:236-244`); route `POST /api/v1/ideas/[id]/follow` |
| See internal notes (`Internal` comments) | No | No | **Yes** | Yes | Yes | `canWriteInternal` role list includes `Internal contributor` (`comment-repository.ts:42`); list filter (`comment-repository.ts:54,61,78`); write gate (`comment-repository.ts:97-98`) |
| Triage (view triage queue) | No | No | Yes* | Yes* | Yes* | `GET /api/v1/internal/triage` → `requireInternalRole` default list (`app/api/v1/internal/triage/route.ts:10`); chat tool `list_triage_queue` gates explicitly (`tools-internal.ts:75`) |
| Triage (act: status transitions, owner/tags/due) | No | No | **No** | Yes | Yes | Status: `requirePublishRole` (`request-repository.ts:379-384`); owner/tags/due only exists as bulk update, PM/SA (`triage-repository.ts:15`) |
| Bulk triage (`POST /api/v1/internal/triage/bulk`, ≤100 requests) | No | No | No | Yes* | Yes* | `bulkUpdateTriage` → `requireInternalRole(identity, ["Product manager", "System admin"])` (`triage-repository.ts:15`); every target must be in an org the actor is a member of, else `NOT_FOUND` (`triage-repository.ts:60-68`) |
| View internal ideas list (incl. unpublished) | No | No | Yes | Yes | Yes | `listInternalIdeas` → `requireInternalRole` default (`product-repository.ts:191-192`) |
| Manage ideas (create / update / score) | No | No | No | Yes | Yes | `createIdea` (`product-repository.ts:204-205`), `updateIdea` (:265-270) → `requireInternalRole(..., ["Product manager", "System admin"])`; `scoreIdea` → `requirePublishRole` (:657-662) |
| Link / move requests to ideas | No | No | No | Yes | Yes | `linkRequest` (`product-repository.ts:452-458`), `moveRequestLink` (:553-560) — both PM/SA |
| Merge ideas (destructive, reason required) | No | No | No | Yes | Yes | `mergeIdeas` → `requirePublishRole` (`product-repository.ts:744-752`); reason required (:751-752) |
| Publish idea to roadmap / place on roadmap | No | No | No | Yes | Yes | `publishIdea` → `requirePublishRole` + safe-wording confirmation (`product-repository.ts:339-352`); `placeRoadmap` → `requirePublishRole` (`operations-repository.ts:274-284`) |
| Idea external links (add/remove) | No | No | Partial (list only) | Yes | Yes | list: any internal (`external-link-repository.ts:33-37`); add/remove: PM/SA (:54-59, :112-117) |
| View draft releases | No | No | Yes | Yes | Yes | `listReleases(identity, true)` → `requireInternalRole` default (`operations-repository.ts:75-76`) |
| Create / publish release | No | No | No | Yes | Yes | `createRelease` (`operations-repository.ts:105-109`), `publishRelease` (:189-193) → `requirePublishRole`; routes `/api/v1/internal/releases`, `/api/v1/internal/releases/[id]/publish` |
| View published releases | Yes | Yes | Yes | Yes | Yes | `GET /api/v1/releases` → `listReleases(identity, false)` — no role gate (`operations-repository.ts:75-76`, `app/api/v1/releases/route.ts`) |
| Analytics summary / CSV export | No | No | Yes | Yes | Yes | `getAnalyticsSummary` (`analytics-repository.ts:89-90`), `exportAuthorizedRequests` (:11-12) → `requireInternalRole` default; routes `/api/v1/internal/analytics/summary`, `/api/v1/internal/analytics/requests.csv` |
| Saved views | No | No | Partial (Private only; delete own) | Partial (Private only; delete own) | Yes (incl. `Internal shared`; delete any) | list/create: internal (`saved-view-repository.ts:23-24,44-48`); scope `"Internal shared"` → System admin (:58-59); delete own-or-admin (:85-106) |
| View audit log | No | No | No | **No** | Yes | `listAudit` → `requireInternalRole(identity, ["System admin"])` (`operations-repository.ts:375-376`); route `GET /api/v1/internal/audit`; chat tool `search_audit_log` says "System admin only" (`tools-internal.ts:647`) |
| Manage users / organizations | No | No | No | No | Yes | `assertAdmin` — Internal org + role `'System admin'` (`admin-repository.ts:58-71`); routes `/api/v1/admin/users`, `/api/v1/admin/organizations` |
| Manage taxonomy / settings / webhooks | No | No | No | No | Yes | `saveTaxonomy`/`listTaxonomy` gates (`taxonomy-repository.ts:47,62`); settings (`settings-repository.ts:61,69`); webhooks (`webhook-repository.ts:78,95,149`) — all `requireInternalRole(..., ["System admin"])`; routes `/api/v1/admin/taxonomy`, `/api/v1/admin/settings`, `/api/v1/internal/webhooks` |
| Use chat assistant ("✦ Assistant" panel) | Yes | Yes | Yes | Yes | Yes | `POST /api/v1/chat/messages` — any authenticated identity (`app/api/v1/chat/messages/route.ts:23-30`); unknown/inactive users rejected via `getIdentityContext` → `FORBIDDEN` (`assistant-service.ts:89`, `identity-repository.ts:39-47`) |
| — assistant tool groups | customer | customer | customer + internal | customer + internal | customer + internal + admin | `groups = {"customer"}`; `+internal` if any Internal-org membership; `+admin` if that role is `"System admin"` (`assistant-service.ts:97-100`) |
| Use Slack assistant (DM or @mention) | Yes† | Yes† | Yes† | Yes† | Yes† | Same `sendChat` brain — "same identity resolution, same sendChat" (`slack/event-handler.ts:2-7,65`); † requires Slack workspace-verified email to exactly match an `Active` `dbo.Users` row with ≥1 active membership (`slack/identity.ts:76-109`) |
| Connect via MCP (`/mcp`, OAuth) | Yes | Yes | Yes | Yes | Yes | Bearer token verified per request; user re-checked as active with memberships on every call (`app/mcp/route.ts:24-42`); browser OAuth uses normal app sign-in (`lib/server/mcp/browser-auth.ts:10-21`) |
| Admin chat tools (list/save users & orgs, taxonomy, settings, webhooks) | No | No | No | No | Yes | In-app chat: `admin` group only added for `"System admin"` (`assistant-service.ts:100`); MCP registers ALL tools for everyone (`app/mcp/route.ts:53-66`) but every admin tool's repository call hits `assertAdmin` / `requireInternalRole(["System admin"])` — unauthorized callers get the not-found-style refusal |

**Important nuance (all internal roles, incl. System admin):** org-scoped data (requests, comments, attachments, drafts) always goes through `requireMembership` — there is no internal bypass. A System admin without a membership in ORG-002 cannot list ORG-002's requests (`authorization.ts:4-26`; `request-repository.ts:94-101`). Bulk triage likewise refuses (as `NOT_FOUND`) any request in an org the actor isn't a member of (`triage-repository.ts:60-68`).

## 3. Anti-enumeration principle

Both `FORBIDDEN` and `NOT_FOUND` map to **HTTP 404** in the API error handler:

```ts
// lib/server/http.ts:17-19
message === "UNAUTHORIZED" ? 401
  : message === "FORBIDDEN" || message === "NOT_FOUND" ? 404
```

(`lib/server/http.ts:14-25`. Precision note: the JSON body still carries the internal code — `error.code` is `"FORBIDDEN"` or `"NOT_FOUND"` with a lowercased `message` like `"forbidden"` / `"not found"` (`http.ts:26,31-44`) — but the HTTP **status** is identical, so status-code probing is defeated.)

The assistant/MCP layer collapses the two codes into one identical string:

```ts
// lib/server/chat/tool-contract.ts:67-68
if (code === "FORBIDDEN" || code === "NOT_FOUND")
  return "That item doesn't exist or you don't have access to it.";
```

Repositories reinforce this by throwing `NOT_FOUND` (not `FORBIDDEN`) when a caller can see an org but not act on an item: withdrawing or editing someone else's request as a non-admin throws `NOT_FOUND` (`request-repository.ts:401,445,554,592`); comment edits by non-authors throw `NOT_FOUND` (`comment-repository.ts:213-214,234-235`); saved-view deletes you don't own throw `NOT_FOUND` (`saved-view-repository.ts:93,106`); bulk triage with any unauthorized id throws `NOT_FOUND` (`triage-repository.ts:67-68`).

### Two customer-facing consequences (for the guide)

1. **URLs and IDs cannot be probed.** Requesting a `DCI-####`, `IDEA-###`, attachment id, or an `/api/v1/internal/...` or `/api/v1/admin/...` route you're not entitled to returns the same 404 status as an id that never existed — you cannot distinguish "exists but not mine" from "doesn't exist" by status code (`http.ts:17-19`).
2. **Assistant refusals read as not-found.** In the "✦ Assistant" panel, in Slack, and over MCP, asking about an item outside your access always yields: **"That item doesn't exist or you don't have access to it."** (`tool-contract.ts:67-68`; wired into the chat host at `assistant-service.ts:51` and the MCP host at `app/mcp/route.ts:63`). Users should not interpret this as the item being missing — it can equally mean "not yours".

Group gating in the in-app chat is explicitly cosmetic: "Group gating is prompt hygiene; repos are the braces." (`assistant-service.ts:32`). The MCP endpoint registers **all** tools for every connected user (`app/mcp/route.ts:53`) and relies entirely on the repository guards, so an unauthorized MCP tool call also returns the not-found-style message. The customer-facing system prompt tells the model: "They are a customer user: only their own organization's data is accessible. Politely refuse triage, internal, or admin actions." (`tool-registry.ts:42`).

## 4. How roles are assigned

- **Where:** the admin "Users" page (sidebar item "Users" under the "DataCentral team" nav section, `app/page.tsx:1058,1095-1101`; page title "Users", `app/page.tsx:528`). Page heading: **"Manage users and company access"**, eyebrow "Identity and access", description "A user has one identity and any number of explicit company memberships. Roles are assigned separately inside each company." (`app/page.tsx:3947-3949`). Primary action button: **"Invite user"** (`app/page.tsx:3952`).
- **Editor modal** ("Invite user" / "Edit {name}"): fields "Full name", "Email address", "Authentication" (`OTP` / `Entra ID`), "User status" (`Active` / `Invited` / `Suspended`) (`app/page.tsx:4129-4190`); fieldset **"Company memberships"** marked *Required* with helper text "Select every company this user may enter. Assign a role independently for each membership." (`app/page.tsx:4194-4200`). Role dropdown per membership: **"Company admin"**, **"Requester"**, **"Viewer"**, plus **"Product manager"** only when the company is `Internal`-type (`app/page.tsx:4235-4240`). Footer shows "{n} companies selected" and submits via **"Save access"** (existing user) or **"Send invitation"** (new user) (`app/page.tsx:4248-4264`).
- **Full-replace disclosure:** saving a user **replaces the entire membership set**. Server-side, `saveUser` first sets *all* the user's memberships to `status='Inactive'` and then re-activates exactly the submitted list (`admin-repository.ts:213-226`; memory path :170-181). The admin chat tool `save_user` warns verbatim: "WARNING: the `memberships` array REPLACES the user's full membership set — any existing membership you omit will be deactivated. Always call list_users first and round-trip the user's existing memberships" (`tools-admin.ts:113-120`), and its schema describes the field as "FULL REPLACEMENT of the user's memberships, not a delta" (`tools-admin.ts:135-138`). The UI editor naturally sends the complete checkbox set (`app/page.tsx:4083-4109`).
- **Membership shape** returned to clients (`GET /api/v1/me` → `organizations`): `{ id, name, type, role, active }` per membership (`identity-repository.ts:4-10,56-63`; `app/api/v1/me/route.ts`).
- **Active organization:** a request *hint* only — `pulse-organization` cookie or `x-pulse-organization-id` header (`auth.ts:26-37`), always re-verified by `requireMembership`. Users with several memberships must choose: the context gate screen says "Choose an organization" / "Your role and access are evaluated separately in each context." (`app/page.tsx:1002-1005`); switching is `POST /api/v1/me/context` → `requireMembership(identity, body.organizationId)` (`app/api/v1/me/context/route.ts:10`). The chat assistant has a `switch_organization` tool with the same check (`assistant-service.ts:59-77`).
- **[Verified discrepancy — worth a note in the guide]** The roles `"Internal contributor"` and `"System admin"` are enforced by `requireInternalRole`/`assertAdmin` (`authorization.ts:30`, `admin-repository.ts:68`) but are **not assignable** through the Users editor dropdown (`app/page.tsx:4235-4240`) or the `save_user` chat tool enum (`["Company admin", "Requester", "Viewer", "Product manager"]`, `tools-admin.ts:131`). They exist only as membership rows provisioned outside those two surfaces (e.g. directly in `dbo.Memberships`).
- **UI navigation is not role-gated.** The sidebar renders the customer items ("Home", "Browse ideas", "Roadmap", "My requests", "Updates", `app/page.tsx:508-514`) *and* the "DataCentral team" section ("Triage inbox", "Product ideas", "Releases", "Analytics", "Companies", "Users", "Authentication", "Settings", "Audit log") unconditionally (`app/page.tsx:1058-1122`); authorization happens at the API, where unauthorized data calls surface as 404s.

## 5. Assistant surfaces (for the matrix footnotes)

- **In-app chat:** floating "✦" launcher, panel header **"✦ Assistant"**, input placeholder **"Ask the assistant…"** (`app/chat-panel.tsx:240,249,337`). Requires `ANTHROPIC_API_KEY`; otherwise the panel shows "The assistant needs an API key. Ask an administrator to set ANTHROPIC_API_KEY." (`app/chat-panel.tsx:270-273`; server message `assistant-service.ts:83-86`). Voice dictation cleanup endpoint `POST /api/v1/chat/transcript` also requires sign-in (`app/api/v1/chat/transcript/route.ts:8`).
- **Slack:** DMs and @mentions route through the same `sendChat` (`slack/event-handler.ts:26-51,65`). Identity comes exclusively from Slack's workspace-verified profile email matched against `dbo.Users.email` (`slack/identity.ts:1-8`). Refusal texts: "Your Slack account isn't linked to a DataCentral Pulse user…", "Your account is disabled — please contact an administrator.", "Your account has no active organization membership…" (`slack/identity.ts:58-63`).
- **MCP:** `POST/GET/DELETE /mcp`, OAuth bearer tokens with 401 + `www-authenticate` resource-metadata challenge for discovery (`app/mcp/route.ts:14-21`); stateless, user re-validated every request (`app/mcp/route.ts:28-42`); server name "DataCentral Pulse" (`app/mcp/route.ts:50`). Tool inventory identical to in-app chat except `switch_organization` is chat-host-only (`assistant-service.ts:56-77`) — MCP callers pass `organization_id` per tool instead (`tool-contract.ts:33-39`).
