# DataCentral Pulse — Internal (DataCentral team) features research

Research target: what an INTERNAL DataCentral user can see and do in the Pulse web UI, and which internal role each action requires. All facts cite `file:line` in the repo at `C:\VS Code\Pulse`. UI labels are quoted exactly as rendered.

---

## 1. Internal roles and how authorization works

### 1.1 Role model

Defined in `lib/server/authorization.ts`:

- `requireInternalRole(identity, roles)` — default allowed roles: `"Internal contributor"`, `"Product manager"`, `"System admin"` (`lib/server/authorization.ts:28-31`). The user must hold one of these roles via an **Active membership in an organization of type `Internal`** (`lib/server/authorization.ts:37-46`; without Azure SQL it falls back to `identity.isInternal` + role check, `:32-35`).
- `requirePublishRole(identity)` — shorthand for `requireInternalRole(identity, ["Product manager", "System admin"])` (`lib/server/authorization.ts:49-51`). Referred to below as **PM/SA**.
- The Admin area uses a separate, stricter check `assertAdmin` in `lib/server/admin-repository.ts:58-71`: membership with `role='System admin'` in an Internal organization (in-memory fallback checks only `identity.isInternal`, `:59-62`).

Role vocabulary summary:

| Role | Grants |
|---|---|
| Internal contributor | Read internal data (triage queue, internal ideas, releases, external links, analytics, saved views), write internal notes |
| Product manager | Everything above + create/update/link/score/merge/publish ideas, roadmap placement, releases, triage decisions, bulk triage |
| System admin | Everything above + audit log, users, organizations, settings, taxonomy, webhooks, shared saved views |

### 1.2 UI gating (important caveat)

The sidebar internal section is rendered **unconditionally for every signed-in user** — there is no client-side role check on the nav (`app/page.tsx:1058-1122`). Authorization is enforced entirely server-side: the internal/admin data fetches simply do nothing when the API returns non-OK (`app/page.tsx:878-885` for ideas/releases/audit, `:896-903` for organizations/users). So a non-internal user can click e.g. "Audit log" and see an empty page; only authorized users see data, and mutations from unauthorized users fail with an error toast.

### 1.3 Organization context

Internal identity is resolved from `/api/v1/me` (`app/page.tsx:787-839`). Users with more than one membership see a gate screen: eyebrow "DataCentral Pulse", heading **"Choose an organization"**, text "Your role and access are evaluated separately in each context." (`app/page.tsx:999-1017`); selection is stored via `POST /api/v1/me/context` (`app/page.tsx:976-987`).

---

## 2. Navigation — the "DataCentral team" sidebar section

Sidebar section label: **"DataCentral team"** (`app/page.tsx:1058`). Items (exact labels, `app/page.tsx:1059-1122`):

| Nav label | Page id | Topbar page title (`app/page.tsx:516-531`) |
|---|---|---|
| Triage inbox (badge "6") | `triage` | "Triage inbox" |
| Product ideas | `productIdeas` | "Product ideas" |
| Releases | `releases` | "Releases" |
| Analytics | `analytics` | "Analytics" |
| Companies | `companies` | "Companies" |
| Users | `users` | "Users" |
| Authentication | `authentication` | "Authentication" |
| Settings | `settings` | "Settings" |
| Audit log | `audit` | "Audit log" |

The topbar also always shows the primary button **"Submit a request"** (`app/page.tsx:1172-1174`).

---

## 3. Triage (page: "Triage inbox")

UI component: `TriagePage` (`app/page.tsx:2054-2451`). Header: eyebrow "Product workspace", h2 **"Review customer evidence"**, subtitle "Classify, consolidate, and communicate every request." (`app/page.tsx:2224-2226`). Metrics strip shows "6 untriaged", "2 overdue", "1.8d median triage" — these three numbers are hardcoded in the component (`app/page.tsx:2228-2238`), as is the demo queue entry `DCI-1048` (`app/page.tsx:2068-2080`). Queue tabs: **"Untriaged"** (6) and **"Assigned to me"** (3) (`app/page.tsx:2251-2258`).

The queue list itself is fed from `GET /api/v1/requests` loaded by the app shell (`app/page.tsx:844`). A dedicated internal listing route `GET /api/v1/internal/triage` also exists (any internal role — `app/api/v1/internal/triage/route.ts:10`) but is **not called by the web UI** (API/agent use).

### 3.1 Triage decision panel

Panel labels: "Triage decision" / **"Choose the next step"** / "This updates the customer-visible request and records the decision." (`app/page.tsx:2383-2388`). Five decision buttons (`app/page.tsx:2389-2444`):

| Button (bold label / small text) | What it does | API | Role | Confirmation / required input |
|---|---|---|---|---|
| **Start discovery** / "Valid problem; investigate options" | Toast only: "Discovery started internally; the customer status remains Submitted until a publishable decision is made." (`app/page.tsx:2389-2394`) | none | n/a | none |
| **Link to product idea** / "Consolidate with existing demand" | Links the selected request to the first suggested idea, sets request status "Linked" | `POST /api/v1/internal/ideas/{id}/links` (`app/page.tsx:2134`) | PM/SA (`lib/server/product-repository.ts:458`) | Reason auto-supplied: "Confirmed as supporting the suggested canonical idea" (`app/page.tsx:2139`) |
| **Request information** / "Ask the customer a clear question" | Posts a Customer-visible comment then sets status "Needs information" | `POST /api/v1/requests/{id}/comments` + `PATCH /api/v1/requests/{id}` (`app/page.tsx:2159-2174`) | Comment: any member; status change: PM/SA (`lib/server/request-repository.ts:377-384`) | `window.prompt("What information does the customer need to provide?")` (`app/page.tsx:2160-2162`) |
| **Route to support** / "Record the destination case reference" | Sets status "Routed to support" with support reference | `PATCH /api/v1/requests/{id}` (`app/page.tsx:2182-2192`) | PM/SA (`lib/server/request-repository.ts:379-388`) | `window.prompt("Support case URL or reference")` — required; server rejects without it (`INVALID_SUPPORT_REFERENCE_REQUIRED`, `lib/server/request-repository.ts:387-388`) |
| **Close request** / "Requires a customer explanation" | Sets status "Closed" with explanation | `PATCH /api/v1/requests/{id}` (`app/page.tsx:2175-2181`) | PM/SA | `window.prompt("Customer-safe closure explanation")` — required; server rejects without it (`INVALID_CLOSURE_EXPLANATION_REQUIRED`, `lib/server/request-repository.ts:385-386`) |

Server-side status rules (`lib/server/request-repository.ts:359-388`): allowed statuses are `Submitted`, `Needs information`, `Linked`, `Routed to support`, `Closed`, `Withdrawn`; every status change **except "Withdrawn" requires the publish role (PM/SA)** — "Withdrawn" is the customer path. Full request status vocabulary incl. `Draft`: `lib/domain.ts:3-10`.

### 3.2 Internal note

Section "Internal note" with textarea placeholder "Add evidence, constraints, or a decision rationale", caption "Internal only", button **"Add note"** (`app/page.tsx:2362-2380`). Calls `POST /api/v1/requests/{id}/comments` with `visibility: "Internal"` (`app/page.tsx:2087-2100`). Role: internal comments require an Active internal-org membership with role in `('Product manager','System admin','Internal contributor')` — i.e. any internal role (`lib/server/comment-repository.ts:35-47`, enforced at `:97`).

### 3.3 Bulk triage

UI: box text "Bulk actions never close or publish requests." with button **"Assign visible to me"** (`app/page.tsx:2259-2264`). It takes up to 6 visible requests in status `Submitted`/`Needs information` and calls `POST /api/v1/internal/triage/bulk` with `{ requestIds, ownerId: "me" }` (`app/page.tsx:2193-2219`). Success toast: "`{n}` requests assigned in one audited operation."

Server (`lib/server/triage-repository.ts:6-128`): **Role: PM/SA** (`:15`). Constraints: 1–100 unique request ids; at least one of `ownerId` / `tagIds` / `triageDueAt` (`:19-24`); `ownerId: "me"` resolves to the caller (`:18`); owner must be an active internal user (`:69-76`); tags must be active taxonomy values of kind `Tag` (`:77-85`). Audited as `triage.bulk-updated` per request (`:120`). Idempotent via `idempotency-key` header (`app/api/v1/internal/triage/bulk/route.ts:11-17`; header set by `mutationHeaders()`, `app/page.tsx:8-13`).

---

## 4. Internal ideas management (page: "Product ideas")

UI component: `InternalIdeasPage` (`app/page.tsx:4526-4658`). Header: eyebrow **"Internal product workspace"**, title **"Canonical product ideas"**, description "Consolidate customer evidence, score priorities, stage safe wording, and publish deliberate product decisions.", action button **"Create idea"** (`app/page.tsx:4566-4574`). Metric cards: "Active ideas", "Staged changes" ("Awaiting explicit publication"), "Unlinked evidence" (`app/page.tsx:4576-4598`). Search placeholder "Search internal ideas" (`app/page.tsx:4605`). Table columns: Idea / Status / Roadmap / Evidence / Score (`app/page.tsx:4611-4617`); each row shows `{id} · {publishState}` and a **"Manage"** button (`app/page.tsx:4627-4640`).

### 4.1 Vocabulary (exact values)

- `internalStatus`: **Discovery, Candidate, Planned, In progress, Released, Not planned, Archived** (`lib/server/product-repository.ts:13-20`; UI select `app/page.tsx:4949-4957`).
- `publishState`: **Internal, Staged, Published** (`lib/server/product-repository.ts:22`). New editor footer shows "Internal draft" when creating (`app/page.tsx:5264`).
- Customer-facing status mapping: Discovery → **"Under review"**, Candidate → **"Considering"**, all other statuses pass through unchanged (`lib/server/product-repository.ts:71-77`).
- Roadmap horizon: **Now, Next, Later, Released** (`app/page.tsx:4970`); roadmap placement API accepts only Now/Next/Later (`lib/server/operations-repository.ts:286`).
- Product area options in the editor: Governance, Distribution, Authentication, Embedding, Display, Administration, Experience (`app/page.tsx:4926-4934`).

### 4.2 Idea workflow editor (modal `IdeaWorkflowEditor`, `app/page.tsx:4660-5284`)

Modal header: eyebrow "Canonical product record", h2 "`{id} · {internal title}`" or **"Create product idea"**; note "Internal evidence remains separate from explicitly reviewed customer wording." (`app/page.tsx:4876-4887`).

Left column "Internal product record": fields **"Internal title"** (Required), **"Internal description"** (Required), "Product area", "Internal status", "Roadmap horizon", "Owner" (options: "Unassigned" + users holding a `Product manager` membership, `app/page.tsx:4975-4993`), "Decision rationale" (placeholder "Required for Planned, Later, or Not planned"), "Reason category", "Delivery reference" (placeholder "https://... or ADO-123"), checkbox **"Explicit delivery-reference exception"** (`app/page.tsx:4896-5030`).

Right column "Customer-safe publication": "Published title", "Published description / explanation", "Release notes", "Availability" (placeholder "General availability, Preview…") (`app/page.tsx:5077-5108`).

Footer buttons: **"Close"** and **"Save internal changes"** (busy label "Saving…") (`app/page.tsx:5263-5278`).

| Action | UI element | API | Role | Notes / confirmations |
|---|---|---|---|---|
| List internal ideas | page load | `GET /api/v1/internal/ideas` (`app/page.tsx:874`) | any internal role (`lib/server/product-repository.ts:192`) | |
| Create idea | "Create idea" → "Save internal changes" | `POST /api/v1/internal/ideas` (`app/page.tsx:4798-4806`) | **PM/SA** (`lib/server/product-repository.ts:205`) | New ideas start `internalStatus='Discovery'`, `publishState='Internal'` (`:249`). Audited `idea.created`. |
| Update idea | "Save internal changes" on existing | `PATCH /api/v1/internal/ideas/{id}` (`app/page.tsx:4799`) | **PM/SA** (`lib/server/product-repository.ts:270`) | Editing a Published idea demotes it to **Staged** (`:321`, memory `:288-289`). Audited `idea.updated`. Toast: "`{id}` was saved as `{publishState}`." (`app/page.tsx:4810`) |
| Publish idea to public roadmap | Checkbox **"I reviewed the wording and confirm it is customer-safe."** + button **"Publish staged changes"** (button disabled until checked) (`app/page.tsx:5112-5129`) | `POST /api/v1/internal/ideas/{id}/publish` with body `{ confirmedSafe: true }` (`app/page.tsx:4813-4819`; route `app/api/v1/internal/ideas/[id]/publish/route.ts:22-27`) | **PM/SA** (`requirePublishRole`, `lib/server/product-repository.ts:344`) | Server hard-rejects without confirmation: `INVALID_SAFE_WORDING_CONFIRMATION_REQUIRED` (`:345-346`); requires non-empty published title AND description: `INVALID_PUBLISHED_WORDING_REQUIRED` (`:391-392`); runs status-transition validation; notifies followers (In-app + Email, event `idea.status.published`, `:415-424`); audited `idea.published`. Toast: "`{id}` was published to customers." (`app/page.tsx:4822`) |
| Link request (evidence) | "Link customer evidence" select ("Select request") + input (default reason "Consolidates the same customer outcome") + button **"Link request"** (`app/page.tsx:5131-5157`) | `POST /api/v1/internal/ideas/{id}/links` (`app/page.tsx:4837-4848`) | **PM/SA** (`lib/server/product-repository.ts:458`) | Reason required (`INVALID_LINK_REASON`, `:459`). Sets request status "Linked", records OrganizationInterest, notifies the requester (`request.linked`), audited `request.linked`. Toast: "`{requestId}` was linked transactionally." |
| Move a request link between ideas | no dedicated UI control — API/assistant only | `PATCH /api/v1/internal/ideas/{id}/links` (`app/api/v1/internal/ideas/[id]/links/route.ts:33-56`) | **PM/SA** (`lib/server/product-repository.ts:560`) | Reason required; source≠target (`:561-562`). Audited `request.link.moved`. |
| Record priority score | "Priority evidence" section: selects impact / reach / strategic alignment / commercial impact / urgency (1–5), Confidence (50%/80%/100%), Effort (1,2,3,5,8,13), button **"Record score"** (`app/page.tsx:5163-5226`) | `POST /api/v1/internal/ideas/{id}/score` (`app/page.tsx:4825-4835`) | **PM/SA** (`requirePublishRole`, `lib/server/product-repository.ts:662`) | Rationale required server-side (UI sends default "Balanced against current customer evidence", `app/page.tsx:4724`). Score = weighted sum × confidence% ÷ effort using admin-configured weights (`lib/server/product-repository.ts:677-687`). Audited `idea.scored`. Toast: "Priority score `{n}` was recorded." |
| Merge duplicate idea | "Merge duplicate idea" select ("Select source idea") + button **"Merge into `{id}`"** (`app/page.tsx:5229-5256`) | `POST /api/v1/internal/ideas/{id}/merge` (`app/page.tsx:4849-4858`) | **PM/SA** (`requirePublishRole`, `lib/server/product-repository.ts:750`) | Reason required (UI sends fixed reason "Duplicate canonical idea consolidated after product review", `app/page.tsx:4856`). **Destructive; no browser confirmation dialog in the UI** — the button acts immediately. Source idea becomes `Archived` + `publishState='Internal'` and its id becomes an alias to the survivor; links/follows/interests/release links move to the target (`lib/server/product-repository.ts:753-810`). Audited `idea.merged`. Toast: "`{source}` now resolves to `{target}`." |
| External delivery links — list | "External delivery links" section (existing ideas only) (`app/page.tsx:5031-5073`) | `GET /api/v1/internal/ideas/{id}/external-links` (`app/page.tsx:4728`) | any internal role (`lib/server/external-link-repository.ts:37`) | |
| External delivery links — add | Inputs "Delivery link label" (placeholder "Azure Boards") + "Delivery link URL" (placeholder "https://…") + button **"Add"** (`app/page.tsx:5044-5071`) | `POST /api/v1/internal/ideas/{id}/external-links` (`app/page.tsx:4769-4786`) | **PM/SA** (`lib/server/external-link-repository.ts:59`) | URL must be `https:` (`INVALID_EXTERNAL_LINK_URL`, `:23-31`). Audited `external-link.created`. |
| External delivery links — remove | **"Remove"** button per link (`app/page.tsx:5039-5041`) | `DELETE /api/v1/internal/ideas/{id}/external-links/{linkId}` (`app/page.tsx:4787-4795`) | **PM/SA** (`lib/server/external-link-repository.ts:117`) | No confirmation dialog. Audited `external-link.deleted`. |
| Roadmap placement | no dedicated UI control — API/assistant only | `PUT /api/v1/internal/ideas/{id}/roadmap` (`app/api/v1/internal/ideas/[id]/roadmap/route.ts:4-27`) | **PM/SA** (`requirePublishRole`, `lib/server/operations-repository.ts:284`) | Horizon Now/Next/Later, optional targetQuarter + confidence (50/80/100) + `publish` flag; publishing with `publish=false` on a Published idea demotes it to Staged (`:324`). Audited `roadmap.placed`. |

### 4.3 Status-transition validation (server enforced on update and publish)

`validateTransition` (`lib/server/product-repository.ts:127-153`):

- **Planned** requires a roadmap horizon (`INVALID_PLANNED_REQUIRES_HORIZON`).
- **In progress** requires an owner (`INVALID_IN_PROGRESS_REQUIRES_OWNER`) and a delivery reference unless the "Explicit delivery-reference exception" checkbox is set (`INVALID_IN_PROGRESS_REQUIRES_DELIVERY_REFERENCE`).
- **Released** requires release notes + availability (`INVALID_RELEASE_REQUIRES_NOTES_AND_AVAILABILITY`).
- **Not planned** requires a reason category + published description (`INVALID_NOT_PLANNED_REQUIRES_EXPLANATION`).
- **Planned / Not planned** require a decision rationale (`INVALID_DECISION_REQUIRES_RATIONALE`).

---

## 5. Releases (page: "Releases")

UI component: `ReleasesPage` (`app/page.tsx:5286-5554`). Header: eyebrow **"Release communication"**, title **"Releases"**, description "Publish availability, documentation, and safe release notes to requesters and followers.", action **"Create release"** (`app/page.tsx:5363-5372`). Empty state: "No releases yet" / "Create a release when one or more ideas are ready to communicate." (`app/page.tsx:5376-5381`). Each release card shows status pill **"Published"** or **"Draft"** (`app/page.tsx:5390-5392`) and drafts show a **"Publish release"** button (`app/page.tsx:5400-5404`).

Create modal: eyebrow "Release record", h2 **"Create release"**, note "Publishing will update included ideas and notify each eligible user once." (`app/page.tsx:5418-5425`). Fields: "Title" (Required), "Release date", "Customer summary" (Required), "Availability" (options: **Preview, Selected customers, General availability, Tenant-specific**, `app/page.tsx:5473-5478`), "Documentation URL", fieldset "Included ideas" (Required, checkbox per non-archived idea). Footer: "`{n}` ideas selected", buttons **"Cancel"** / **"Create draft"** (disabled until title+summary+≥1 idea) (`app/page.tsx:5528-5546`).

| Action | API | Role | Notes |
|---|---|---|---|
| List releases (incl. drafts) | `GET /api/v1/internal/releases` (`app/page.tsx:875`) | any internal role (`lib/server/operations-repository.ts:76`) | Public route `GET /api/v1/releases` returns only published ones. |
| Create release (draft) | `POST /api/v1/internal/releases` (`app/page.tsx:5309-5320`) | **PM/SA** (`requirePublishRole`, `lib/server/operations-repository.ts:109`) | Requires title, summary, date, availability (`INVALID_RELEASE`, `:110-116`). Ids look like `REL-1`. Audited `release.created`. Toast: "`{id}` was created as a draft." |
| Publish release | `POST /api/v1/internal/releases/{id}/publish` (`app/page.tsx:5333-5337`) | **PM/SA** (`requirePublishRole`, `lib/server/operations-repository.ts:193`) | **No confirmation dialog in the UI** — one click publishes. Server requires ≥1 bundled idea (`INVALID_RELEASE_REQUIRES_IDEAS`, `:197`/`:237-238`). Cascade: every bundled idea is set to status **Released**, `published_status='Released'`, horizon **Released**, `publish_state='Published'`, and inherits the release summary/availability as release notes/availability (`:239-243`); followers and linked requesters get one deduplicated notification each on In-app + Email channels (event `release.published`, `:244-250`). Audited `release.published`. Toast: "`{id}` was published and eligible customers were notified." (`app/page.tsx:5360`) |

---

## 6. Publishing ideas to the public roadmap — safety summary

- Ideas are never customer-visible until published: they start `publishState='Internal'`; edits to published ideas revert them to `Staged` (`lib/server/product-repository.ts:288-289`, `:321`).
- Publication (`publishIdea`) is **PM/SA-only** and requires an explicit safety confirmation flag (`confirmedSafe` / assistant `confirmed_safe`) — server error `INVALID_SAFE_WORDING_CONFIRMATION_REQUIRED` without it (`lib/server/product-repository.ts:339-346`).
- UI confirmation: checkbox "I reviewed the wording and confirm it is customer-safe." gates the "Publish staged changes" button (`app/page.tsx:5112-5129`).
- Publishing writes the published status, creates an active RoadmapPlacement when a horizon exists, queues follower notifications, and audits `idea.published` — all in one SQL transaction (`lib/server/product-repository.ts:367-449`).

---

## 7. Audit log (page: "Audit log")

UI component: `AuditPage` (`app/page.tsx:5556-5601`). Header: eyebrow **"Immutable history"**, title **"Audit log"**, description "Security and business history for publication, roles, links, status, scoring, exports, and administrative changes." Toolbar shows "`{n}` recent events". Table columns: **Time / Action / Entity / Actor / organization / Correlation** (`app/page.tsx:5568-5574`). Empty state: "No audit events" / "Material mutations will appear here with actor and correlation context." with a "Refresh" action.

- Data: `GET /api/v1/internal/audit?limit=100` loaded by the app shell (`app/page.tsx:876`).
- **Role: System admin only** — `listAudit` calls `requireInternalRole(identity, ["System admin"])` (`lib/server/operations-repository.ts:375-376`). Limit clamped to 1–500 (`:381`).
- Audit action vocabulary observed in code: `idea.created`, `idea.updated`, `idea.published`, `idea.scored`, `idea.merged`, `request.created`, `request.status.changed`, `request.edited`, `request.linked`, `request.link.moved`, `roadmap.placed`, `release.created`, `release.published`, `triage.bulk-updated`, `external-link.created`, `external-link.deleted`, `organization.saved`, `user.memberships.saved`, `settings.updated`, `taxonomy.saved`, `webhook.created`, `webhook.state.updated`, `analytics.requests.exported` (grep across `lib/server/*.ts`, e.g. `product-repository.ts:258,332,440,739,827`; `operations-repository.ts:177,262,333`; `triage-repository.ts:120`; `admin-repository.ts:135,242`; `settings-repository.ts:144`; `taxonomy-repository.ts:112`; `webhook-repository.ts:139,187`; `external-link-repository.ts:107,159`; `analytics-repository.ts:57`).

---

## 8. Analytics (page: "Analytics")

UI component: `AnalyticsPage` (`app/page.tsx:5603-5753`). Header: eyebrow **"Product intelligence"**, title **"Feedback analytics"**, description "Demand, flow, and data quality across the currently authorized customer scope.", action **"Export CSV"** (`app/page.tsx:5638-5647`).

Metric cards (`app/page.tsx:5649-5697`): "Open requests", "Unique product areas", "Published releases", "Average first response", "Average time to triage", "Delivered notifications" ("Delivery state from durable outbox"). Panel "Requests by product area" with note "Unique organization counts remain internal" (`app/page.tsx:5698-5705`). "Data quality checks" strip: "`{n}` requests need an owner · `{n}` need classification" with button **"Review records"** (toast only) (`app/page.tsx:5727-5750`).

| Action | API | Role |
|---|---|---|
| Summary metrics | `GET /api/v1/internal/analytics/summary` (`app/page.tsx:5614`) | any internal role (`lib/server/analytics-repository.ts:90`) |
| Export CSV | `GET /api/v1/internal/analytics/requests.csv` (`app/page.tsx:5631-5635`); downloads as `pulse-authorized-requests.csv` (`app/api/v1/internal/analytics/requests.csv/route.ts:12-14`) | any internal role (`lib/server/analytics-repository.ts:12`) — export is itself audited (`analytics.requests.exported`, `:21`/`:57`) |

CSV columns: Request, Title, Product area, Request type, Impact, Status, Visibility, Organization, Created (`lib/server/analytics-repository.ts:60-70`). Scope: only organizations the caller has an Active membership in, excluding test organizations (`:34-38`).

---

## 9. Admin area

### 9.1 Companies (page: "Companies")

UI component: `CompaniesPage` (`app/page.tsx:3577-3725`). Header: eyebrow **"Customer administration"**, title **"Manage companies"**, action **"Add company"**; per-row **"Manage"** button. Table columns: Company / Type / Users / Authentication / Status (`app/page.tsx:3661-3667`).

Editor modal (`CompanyEditor`, `app/page.tsx:3727-3897`): h2 **"Add customer company"** or "Manage `{name}`". Fields: "Company name" (Required), "Verified domain" (Required), "Company type" (**Customer / Partner / Internal**), "Status" (**Active / Onboarding / Inactive**), fieldset "Allowed authentication" with **"One-time password"** and **"Microsoft Entra ID"** checkboxes; footer note "At least one authentication method is required."; buttons "Cancel" / **"Save company"**.

- API: `GET`/`POST /api/v1/admin/organizations` (`app/page.tsx:893`, `:3596`).
- **Role: System admin** (`assertAdmin`, `lib/server/admin-repository.ts:73` and `:91`). Audited `organization.saved`.

### 9.2 Users (page: "Users") — incl. creating users + memberships

UI component: `UsersPage` (`app/page.tsx:3899-4060`). Header: eyebrow **"Identity and access"**, title **"Manage users and company access"**, action **"Invite user"**; per-row **"Edit access"** button. Callout: "Many-to-many access model — Internal employees are not global by default. Assign each employee only to the customer companies they support." (`app/page.tsx:3956-3964`). Filter dropdown "All companies".

Editor modal (`UserEditor`, `app/page.tsx:4062-4271`): h2 **"Invite user"** or "Edit `{name}`", note "Authentication proves identity. Membership determines company access." Fields: "Full name" (Required), "Email address" (Required), "Authentication" (**OTP / Entra ID**), "User status" (**Active / Invited / Suspended**), fieldset **"Company memberships"** (Required) — checkbox per non-inactive company plus a role select per selected membership with options **Company admin, Requester, Viewer** and additionally **Product manager** only when the company type is `Internal` (`app/page.tsx:4234-4241`). Submit button: **"Send invitation"** (new) or **"Save access"** (existing) (`app/page.tsx:4263`).

- API: `GET`/`POST /api/v1/admin/users` (`app/page.tsx:894`, `:3924`).
- **Role: System admin** (`assertAdmin`, `lib/server/admin-repository.ts:140` and `:165`).
- Server behavior on save (`lib/server/admin-repository.ts:164-250`): upserts the user; new users get a `pending:{email}` external subject so identity providers can claim the row later (`:174-179`, `:203-211`); **all existing memberships are set Inactive and then the submitted list is re-activated** (`:213-226`); requires ≥1 membership (`INVALID_USER`, `:166-167`). Audited `user.memberships.saved`.
- Note: the UI role dropdown cannot assign "System admin" or "Internal contributor" — those internal roles are not offered in the Users editor (`app/page.tsx:4234-4241`); the API accepts arbitrary role strings (`role` column NVarChar(64), `:223`). [UNVERIFIED how System admin roles are provisioned in practice — likely seeded/DB-level.]

### 9.3 Authentication (page: "Authentication")

UI component: `AuthenticationPage` (`app/page.tsx:4273-4524`). Header: eyebrow **"Identity providers"**, title **"Authentication"**. Two provider cards: **"One-time password"** (Status "Active"; facts: Identifier "Email address", Code lifetime "10 minutes", Company access "Explicit membership"; button **"Manage OTP policy"** which only shows a toast, `app/page.tsx:4317-4324`) and **"Microsoft Entra ID"** (Status "Configuration pending"; button **"Configure Entra ID"**). Section "One identity, several company contexts" explains membership resolution. "Company authentication policy" list with per-company "Manage" links (toast only, `app/page.tsx:4416-4423`).

The **"Configure Microsoft Entra ID"** modal (fields "Application (client) ID", "Azure Tenant ID", security note "Client secrets are never entered in Pulse.", footer "Configuration is not activated until applied in Azure.", submit **"Validate identifiers"**) makes **no API call** — submitting closes the modal with the toast "Entra identifiers validated. Apply them through the Azure identity configuration." (`app/page.tsx:4457-4465`). This page is informational/config-preview; no server-side role applies to it.

### 9.4 Settings (page: "Settings")

UI component: `SettingsPage` (`app/page.tsx:5755-6117`). Header: eyebrow **"System administration"**, title **"Product settings"**, description "Govern taxonomy, customer wording, retention, scoring, localization, and secure attachment policy."

Cards and actions:

| Card | Controls | Button | API | Role |
|---|---|---|---|---|
| "Attachment policy" | "Maximum per file" (10/25/50 MB), "Maximum per request" (50/100/250 MB), "Retention period" (1 year / 3 years / 7 years) | **"Save policy"** | `PATCH /api/v1/admin/settings` (`app/page.tsx:5794`) | **System admin** (`lib/server/settings-repository.ts:69`) |
| "Roadmap and localization" | "Editing language" (English/Icelandic), "Roadmap disclaimer" textarea | **"Save wording"** | same PATCH | System admin |
| "Priority formula" | weights: Customer impact, Reach, Strategic alignment, Commercial impact, Urgency / risk (must sum to 100 — `INVALID_SCORE_WEIGHTS`, `lib/server/settings-repository.ts:79-83`; changing weights bumps `formulaVersion`, `:87-91`/`:122-126`) | **"Save weights"** | same PATCH | System admin |
| "Product taxonomy" | list of Product area values with **"Deactivate"**/**"Reactivate"** toggle; **"Add product area"** uses `window.prompt("New product area name")` (`app/page.tsx:5833-5843`) | — | `GET`/`POST /api/v1/admin/taxonomy` (`app/page.tsx:5779`, `:5815`) | **System admin** (`lib/server/taxonomy-repository.ts:47`, `:62`) |
| "Signed outbound webhooks" | list with **"Disable"**/**"Enable"** toggle; "HTTPS endpoint" input (placeholder "https://example.com/pulse-events") + **"Add webhook"** | — | `GET`/`POST /api/v1/internal/webhooks` (`app/page.tsx:5780`, `:5846`), `PATCH /api/v1/internal/webhooks/{id}` (`:5870`) | **System admin** (`lib/server/webhook-repository.ts:78`, `:95`, `:149`) |

Settings reads are also System admin (`getSettings`, `lib/server/settings-repository.ts:60-63`) — non-admins see the built-in defaults rendered client-side. Settings save toast: "Product settings saved and added to the audit trail." (`app/page.tsx:5806`).

Webhook details: valid events are `request.created`, `request.status.changed`, `request.linked`, `idea.published`, `idea.updated`, `release.published` (`lib/server/webhook-repository.ts:7-14`); the UI subscribes new webhooks to five of these (everything except `idea.updated`, `app/page.tsx:5850-5857`). URLs must be HTTPS, non-local, and not resolve to private addresses (`lib/server/webhook-repository.ts:48-65`). Success toast: "Signed webhook subscription created."

Taxonomy kinds supported by the API: **Product area, Request type, Tag, Strategic theme, Reason category** (`lib/server/taxonomy-repository.ts:7-16`); the Settings UI manages only "Product area" values (`app/page.tsx:6053-6054`).

---

## 10. Saved views (no dedicated UI page)

Saved views exist as an internal API + assistant capability only; `app/page.tsx` never calls `/api/v1/internal/saved-views` (grep: no matches).

- `GET`/`POST /api/v1/internal/saved-views`, `DELETE /api/v1/internal/saved-views/{id}` (`app/api/v1/internal/saved-views/route.ts`, `.../[id]/route.ts`).
- Roles: list/create — any internal role (`lib/server/saved-view-repository.ts:24`, `:48`); creating with scope **"Internal shared"** additionally requires **System admin** (`:58-59`); delete — own views, or any view if System admin (`:85-106`). Scopes: `Private`, `Internal shared`; resource types: `Requests`, `Ideas`, `Roadmap` (`:5-12`).

---

## 11. Assistant chat panel (floating "✦" launcher)

`ChatPanel` is rendered on every page (`app/page.tsx:1326-1329`; component `app/chat-panel.tsx`). Launcher button toggles a dialog titled **"✦ Assistant"** (`app/chat-panel.tsx:249`); input placeholder "Ask the assistant…" (`:337`); optional dictation mic; **"Clear chat history"** button guarded by `window.confirm("Clear the entire chat history?")` (`app/chat-panel.tsx:215-227`). If no API key is configured it shows "The assistant needs an API key. Ask an administrator to set ANTHROPIC_API_KEY." (`:269-274`).

Internal assistant tools (`lib/server/chat/tools-internal.ts`) re-check authorization in the same repositories, so roles match the tables above: `list_triage_queue` (explicit `requireInternalRole`, `:75`), `bulk_triage` (requires `confirmed: true` after user confirmation, `:105-121`), `list_internal_ideas`, `create_idea`, `update_idea`, `publish_idea` (**requires `confirmed_safe: true`**, `:216-241`), `link_request_to_idea`, `move_request_link`, `merge_ideas` (requires `confirmed: true`, `:296-331`), `score_idea`, `place_on_roadmap`, `list_external_links`, `add_external_link`, `remove_external_link`, `list_internal_releases`, `create_release`, `publish_release` ("HIGH BLAST RADIUS", requires `confirmed: true`, `:500-527`), `list_saved_views`, `create_saved_view`, `delete_saved_view`, `analytics_summary`, `export_requests_csv`, `search_audit_log` (System admin via `listAudit`, `:642-686`).

---

## 12. Background workers (notification / retention / webhooks) — user visibility

The three job routes are **not role-gated and not reachable from the UI**; they require the shared-secret header `x-pulse-job-secret` matching env `NOTIFICATION_JOB_SECRET` (timing-safe compare):

- `POST /api/v1/internal/jobs/notifications` → `processNotificationBatch` (`app/api/v1/internal/jobs/notifications/route.ts:5-30`)
- `POST /api/v1/internal/jobs/retention` → `processRetentionBatch` (`app/api/v1/internal/jobs/retention/route.ts:5-30`)
- `POST /api/v1/internal/jobs/webhooks` → `processWebhookBatch` (`app/api/v1/internal/jobs/webhooks/route.ts:5-27`)

User-visible effects worth documenting:

- **Notification worker** delivers queued Email notifications via Azure Communication Services, honoring per-user cadence preferences (**Immediate / Daily / Weekly / Off**) and suppressing inactive recipients (`lib/server/notification-worker.ts:35-93`). Notification states: `Queued`, `Processing`, `Delivered`, `Retry`, `Dead letter`, `Suppressed` (`:38-46`, `:74`, `:121`, `:129`). Retry backoff doubles per attempt; ≥5 attempts → Dead letter (`:125-135`). Email subject examples: "Update in DataCentral Pulse" / "Your daily DataCentral Pulse digest" (Icelandic variants included) (`:21-32`). In-app notifications surface in the bell popover ("Updates" / "View all" / "No unread product updates.", `app/page.tsx:6119-6169`) and the Updates page; the Analytics page counts Delivered notifications (`app/page.tsx:5690-5696`).
- **Retention worker** permanently deletes soft-deleted attachments/comments/requests/ideas/saved views older than the admin-configured retention period (`retentionDays` from Settings; minimum 30 days server-side, `lib/server/settings-repository.ts:75`; deletion logic `lib/server/retention-worker.ts:5-103`). This is the enforcement behind the "Retention period" setting in the Settings page.
- **Webhook worker** delivers signed event envelopes to the System-admin-managed webhook subscriptions (`lib/server/webhook-worker.ts`; subscriptions per section 9.4).

---

## 13. Quick role → capability matrix (server-enforced)

| Capability | Internal contributor | Product manager | System admin |
|---|---|---|---|
| View triage queue, internal ideas, releases (incl. drafts), external links, analytics + CSV export | ✓ | ✓ | ✓ |
| Add internal notes (visibility "Internal") | ✓ | ✓ | ✓ |
| Private saved views (create/delete own) | ✓ | ✓ | ✓ |
| Triage decisions (status changes), bulk triage | — | ✓ | ✓ |
| Create/update ideas, link/move request evidence, external links add/remove | — | ✓ | ✓ |
| Score ideas, merge ideas, roadmap placement, publish ideas (`confirmedSafe`) | — | ✓ | ✓ |
| Create + publish releases | — | ✓ | ✓ |
| Audit log | — | — | ✓ |
| Users, Companies (organizations) admin | — | — | ✓ |
| Settings, taxonomy, webhooks, "Internal shared" saved views | — | — | ✓ |

Destructive/irreversible actions with explicit confirmation: idea publish (checkbox + server flag), request close / route-to-support / request-information (window.prompt for required text), chat history clear (window.confirm), assistant bulk triage / merge / release publish (`confirmed` flag). Destructive actions **without** any UI confirmation: idea merge button ("Merge into {id}"), release publish button ("Publish release"), external link "Remove", taxonomy "Deactivate", webhook "Disable".
