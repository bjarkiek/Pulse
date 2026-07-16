# DataCentral Pulse — Customer-Facing Features (as implemented)

Research for the customer user guide. Every claim is cited as `file:line` against the working tree at `C:/VS Code/Pulse` (Next.js 16, single-page UI in `app/page.tsx`, API under `app/api/v1`, repositories in `lib/server`). UI strings are quoted **exactly** as rendered.

**Who this covers:** a non-internal user — `PulseIdentity.isInternal === false` (lib/domain.ts:49), belonging to an organization of type `"Customer"` with a membership role of `"Company admin"`, `"Requester"`, or `"Viewer"` (the role dropdown offers exactly these three for non-internal companies; `"Product manager"` is only offered for `Internal` companies — app/page.tsx:4235-4241). Server-side, internal-only capability requires an *active membership in an Internal-type organization* with role `"Internal contributor"`, `"Product manager"`, or `"System admin"` (lib/server/authorization.ts:28-47); customers fail that check with `FORBIDDEN`.

> **Demo-data caveat for screenshots:** the client ships hard-coded preview data (`initialIdeas` app/page.tsx:238, `initialRequests` :334, `initialCompanies` :392, `initialManagedUsers` :445) and several hard-coded strings ("Good morning, Bjarki" :1367, "Origo" workspace chip :1160, "Requests from Origo" :1785, "Last updated … 14 July 2026 · 23:42Z" :1373-1374, "Submitted by Origo" :2291, "Visible to Origo and DataCentral" :3476). If an API call fails, the UI keeps this local data and shows the toast **"Pulse is using the local preview data."** (app/page.tsx:853). Screenshot text may therefore include these fixed demo values.

---

## 1. Sign-in, identity, and organization context

### Standalone (browser, Microsoft Entra ID)
- Unauthenticated page loads are 302-redirected by the proxy to `/auth/login?returnUrl=…` (proxy.ts:50-58).
- `/auth/login` starts an Entra OIDC flow with PKCE S256 + state + nonce, scope `openid profile email`; on misconfiguration/failure it redirects to `/auth/error?code=oidc_failed` (app/auth/login/route.ts:21-52).
- A successful login yields the `pulse-session` cookie — an HS256 JWT valid **12 hours** (lib/server/session.ts:14-15). On expiry, "standalone re-SSO-redirects" (session.ts:15 comment). In production the cookie is `HttpOnly; Secure; SameSite=None; Partitioned` (session.ts:57-62).
- If the SPA gets a 401 from `/api/v1/me` at top level, it sends the browser to `/auth/login?returnUrl=…` (app/page.tsx:790-804).

### Embedded (DataCentral iframe)
- An unauthenticated **iframe** load (detected by `dcdata` query param or `sec-fetch-dest: iframe`, proxy.ts:24-27) is redirected to `/dc-embed?returnUrl=…` instead of Entra — "never redirect an iframe to Entra" (proxy.ts:52-54).
- `/dc-embed` serves a handshake page showing **"Connecting to DataCentral…"** (app/dc-embed/route.ts:31). It posts `AppReady` to the parent window (dc-embed/route.ts:84-92), accepts an `AccessToken` envelope / graph token from allowed `*.datacentral.ai` origins (:39-42, :73-82), and POSTs the signed launch payload to `/dc-auth` (:60-71). Fallback text on failure: **"Could not sign you in automatically."** with a link **"Open Pulse sign-in"** (:32-33).
- `/dc-auth` verifies the HMAC-signed `dcdata`/`dcsig` launch payload (or a Graph token) and mints the same 12-hour `pulse-session` cookie with the claim `dc_embed: true` (app/dc-auth/route.ts:36-76; claim defined session.ts:9).
- Inside the iframe, a 401 from `/api/v1/me` triggers `window.location.reload()` so the proxy can route back through `/dc-embed` (app/page.tsx:794-804).
- `dcEmbed` reaches the UI via `GET /api/v1/me` → `dcEmbed` field (app/api/v1/me/route.ts:19; lib/server/current-user.ts:36). It is **"Cosmetic only — server authorization is unchanged."** (app/page.tsx:758-759).

### What `dcEmbed=true` hides (embedded vs standalone)
Exactly three UI elements are hidden when embedded; everything else is identical:
1. The **sidebar profile card** (avatar "BK", "Bjarki Kristjánsson", "Origo · Customer admin") — `{!dcEmbed && (` app/page.tsx:1124-1133.
2. The **topbar workspace switcher** button (building icon, "Origo", chevron) — app/page.tsx:1157-1163. (Note: this button has no `onClick`; it is static chrome, not a functioning switcher.)
3. The Home greeting **"Good morning, Bjarki"** — `{!dcEmbed && <h2>…</h2>}` app/page.tsx:1367.

### Organization contexts and the switcher
- `GET /api/v1/me` returns `user` (id/email/name/locale), `organizations` (memberships), `activeOrganizationId`, `authMethod`, `dcEmbed`, `isVerified` (app/api/v1/me/route.ts:8-24) and sets a `pulse-organization` cookie for the active org (:25-37).
- Membership context comes from active `Memberships` joined to non-inactive `Organizations`; a user with no active membership gets `FORBIDDEN` (lib/server/identity-repository.ts:39-47). Users with exactly one membership enter it directly; with several and no valid hint, `activeOrganizationId` is `null` (:48-55).
- If more than one organization is available and no active one is resolved, the app shows a full-page gate: eyebrow **"DataCentral Pulse"**, heading **"Choose an organization"**, body **"Your role and access are evaluated separately in each context."**, then one button per organization showing its name and your role (app/page.tsx:999-1017). With one/zero orgs pending it shows **"Resolving your authorized organization…"** (:1019).
- Choosing posts `POST /api/v1/me/context` `{ organizationId }`; the server re-verifies membership via `requireMembership` before setting the cookie (app/api/v1/me/context/route.ts:8-27). Failure toast: **"That organization context is no longer available."** (app/page.tsx:983).
- Deep links can carry `?organization=ORG-XXX`; it is honored only if that org is in the user's authorized list (app/page.tsx:815-833).
- Identity resolution failure toast: **"Pulse could not resolve your organization access."** (app/page.tsx:837).

---

## 2. App shell and navigation

Sidebar brand: DataCentral logo + the word **"Pulse"** (app/page.tsx:1027-1036).

Customer navigation items (`navItems`, app/page.tsx:508-514):
| Label | Page title (topbar) |
|---|---|
| **Home** | "Home" |
| **Browse ideas** | "Browse ideas" |
| **Roadmap** | "Roadmap" |
| **My requests** | "My requests" |
| **Updates** | "Updates" (shows an unread-count badge when any notification lacks `readAt` — app/page.tsx:1046-1055) |

Below these, a section labeled **"DataCentral team"** lists: **Triage inbox** (with a hard-coded badge "6"), **Product ideas**, **Releases**, **Analytics**, **Companies**, **Users**, **Authentication**, **Settings**, **Audit log** (app/page.tsx:1058-1122). **This section is rendered unconditionally — customers see these nav entries too** (there is no role check in the sidebar). What they see after clicking is covered in §10.

Topbar (app/page.tsx:1145-1194): page title, workspace chip (standalone only), a bell **"Notifications"** icon button toggling the notifications popover, and the primary button **"Submit a request"** (:1172-1174), which is also repeated on Home, Browse ideas, and My requests.

A floating **assistant launcher** (✦ button) is always present (§9).

Toasts render bottom-of-screen with a check icon (app/page.tsx:1318-1325) and auto-dismiss after 3.2 s (:919-924).

---

## 3. Home page

Component `HomePage` (app/page.tsx:1334-1539).

- Welcome row: eyebrow **"Customer feedback"**, heading **"Good morning, Bjarki"** (standalone only; hard-coded name), body **"Track your requests and help shape what DataCentral builds next."** (:1366-1370). Right side: **"Last updated"** / **"14 July 2026 · 23:42Z"** (hard-coded, :1372-1375).
- Ask card: **"What would make DataCentral work better for your team?"** / **"Search existing ideas or describe a new requirement."** (:1384-1385), a large search input placeholder **"Search ideas and requests"** (:1394), and **"Submit a request"** (:1398-1400). Typing >2 characters shows up to 3 client-side matches under **"Related ideas"** with each idea's status pill (:1352-1361, 1402-1413).
- Three metric cards (each navigates on click):
  - **"Active requests"** — count of requests whose status is not `Released`/`Closed`; caption **"Across your organization"** (:1422-1430).
  - **"Needs your input"** — count with status `Needs information`; caption **"Response requested"** (:1442-1446).
  - **"Recently released"** — count of ideas with status `Released`; caption **"In the last 30 days"** (:1455-1459). (The 30-day text is fixed copy; the count is simply all Released ideas.)
- **"Your requests"** panel — first 3 requests, caption **"Latest activity from Origo"** (hard-coded org name), link **"View all"** (:1469-1509). Row icon varies by status: message icon for `Needs information`, map for `Planned`, clock otherwise (:1487-1496).
- **"Recently shipped"** panel — hard-coded to "Mobile dashboard improvements", released **"8 JUL 2026"**, link **"View release notes"** (opens the IDEA-276 drawer) (:1511-1535).

Data: `GET /api/v1/requests` (app/page.tsx:844) and `GET /api/v1/ideas` (:908), both after identity is ready.

---

## 4. Submitting a request

Opened via any **"Submit a request"** button → modal `RequestComposer` (app/page.tsx:2501-3036). Header: eyebrow **"New customer request"**, title **"Describe the outcome you need"**, body **"Start with the problem. DataCentral will assess the right product response."** (:2734-2739).

### Fields and client validation
| Field | Label / options | Constraints |
|---|---|---|
| Title | **"Short title"** with **"Required"** tag | `maxLength=140`, live counter "`{n}/140`" (app/page.tsx:2746-2758) |
| Problem | **"Problem or desired outcome"** with **"Required"** | `maxLength=5000`, counter "`{n}/5,000`" (:2841-2853) |
| Disclosure | **"Add impact and context"** / collapse: **"Hide additional context"** (:2854-2861) | optional section |
| Request type | **"Request type"**: `Feature`, `Improvement`, `Integration`, `Compliance` (:2865-2874) | default `Feature` (:2515) |
| Product area | **"Product area"**: `Distribution`, `Governance`, `Authentication`, `Embedding`, `Display`, `Administration`, `Experience` (:2877-2886) | default `Distribution` (:2512) |
| Impact | **"Business impact"**: `Low`, `Medium`, `High`, `Critical` (:2888-2898) | default `High` (:2513) |
| Affected users | **"Affected users"**, number, `min=1`, placeholder "Optional estimate" (:2900-2908) | optional |
| Desired timing | **"Desired timing"**, placeholder **"For example Q4 or 2026-11-01"** (:2910-2916) | optional |
| Workaround | **"Current workaround"**, placeholder **"How do you handle this today?"** (:2918-2924) | optional |

Submit button **"Submit request"** (busy: **"Submitting…"**) is disabled until title and problem are non-blank (:3023-3029); **"Cancel"** closes (:3016-3021).

### Server validation (`createRequest`, lib/server/request-repository.ts:167-218)
- Membership required (`requireMembership`, :180).
- `INVALID_TITLE` if empty or >140 (:181-182); `INVALID_PROBLEM` if empty or >5000 (:183-184); `INVALID_VISIBILITY` unless `Private`/`Organization` (:185-186).
- Public id allocated as `DCI-<number>` (:187-194). Initial status: **"Submitted"**, or **"Linked"** when created with a `linkedIdeaId` (:201).
- Errors return as `{ error: { code, message, correlationId } }` with `INVALID_*` → HTTP 400 (lib/server/http.ts:14-45); the composer surfaces `error.message` in a red alert box (app/page.tsx:2668-2669, 3004-3008).
- Mutations are idempotent — every POST carries an `idempotency-key` header (app/page.tsx:8-13; app/api/v1/requests/route.ts:18-26).

Success: composer closes, view switches to **My requests**, toast **"{DCI-id} was submitted for review."** (app/page.tsx:942-948).

### Duplicate detection ("Related ideas already exist")
- While typing, once `title + problem` totals ≥4 characters, the composer debounces 300 ms and calls `GET /api/v1/search/suggestions?q=…&area=…` (app/page.tsx:2532-2550).
- Server: requires membership, needs ≥3 chars, tokenizes/stems, fuzzy-ranks the *published ideas* plus *your own org's requests*, and returns at most 5 with a `why` string — **"Matches {tokens}"** or **"Shared product area: {area}"** (lib/server/search-repository.ts:74-124). Request-sourced suggestions are labeled `"Your request"` (:103).
- Panel heading: **"Related ideas already exist"** / **"Add your organization's interest or continue with distinct context."** (app/page.tsx:2765-2769). For each Idea suggestion:
  - **"This solves my need"** — follows the idea *with support* (records organization interest server-side, lib/server/idea-repository.ts:236-244) and closes the composer (app/page.tsx:2793-2801).
  - **"Add my context"** — sets `linkedIdeaId` so the new request is created already linked; note shown: **"Your new request will be linked to {IDEA-id} while keeping your company context private."** (:2802-2819).
  - **"Continue with a new request"** — dismisses; the dismissal is recorded via `POST /api/v1/search/suggestions/dismiss` (only query length + suggestion count are stored, lib/server/search-repository.ts:126-161) (app/page.tsx:2820-2838).
- Creating with `linkedIdeaId` requires the target idea to be Published (else `NOT_FOUND`), creates a `Supports` link, records organization interest, and auto-follows the idea (lib/server/request-repository.ts:264-319).

### Visibility
Selector with options `Organization` (default) and `Private`; label shows **"Visible to your organization"** or **"Visible to you and DataCentral"** plus **"Raw customer context is never shared with other customers."** (app/page.tsx:2976-2995). Server-side, org members see a request only when `visibility='Organization'` OR they created it OR they are its owner (SQL WHERE, lib/server/request-repository.ts:119-120) — i.e. `Private` requests are visible only to the requester (and the internal owner).

Privacy reminder under the form: **"Do not upload credentials, personal data, secrets, or unredacted production data."** (app/page.tsx:2997-3003).

### Attachments at submission
- Drop zone: **"Add screenshots or files"** / **"Drop files here or browse · 25 MB each, 100 MB total"** (app/page.tsx:2945-2951). Accepted input: `image/*,.pdf,.txt,.csv,.zip,.docx,.xlsx,.pptx` (:2940). Client silently drops files >25 MB and caps the list at 10 (:2639-2644).
- Server allow-list (content-type ↔ extension must match): png, jpg/jpeg, webp, gif, pdf, txt, csv, zip, docx, xlsx, pptx (app/api/v1/requests/[id]/attachments/route.ts:14-30). Per-file limit: `attachmentMaxMb` (default **25 MB**) → `INVALID_ATTACHMENT` (:73-79; default lib/server/settings-repository.ts:23). Per-request total: `requestAttachmentMaxMb` (default **100 MB**) → `INVALID_REQUEST_ATTACHMENT_TOTAL` (lib/server/request-repository.ts:653-660; settings-repository.ts:24).
- Upload flow: `POST /api/v1/requests/{id}/attachments` → returns `uploadUrl` (Azure Blob SAS, or `/api/v1/attachments/{id}/content` in memory mode) → `PUT` the bytes → `POST /api/v1/attachments/{id}/complete` for blob uploads (app/page.tsx:2670-2704). Footer shows **"Uploading attachments · {n}%"** during upload (:3010-3013).
- Scan states: `"Pending upload" | "Scanning" | "Clean" | "Infected" | "Failed"` (lib/domain.ts:39). Downloads (`GET /api/v1/attachments/{id}/content`) return HTTP 423 **"Attachment is not available until malware scanning completes."** until state is `Clean` (app/api/v1/attachments/[id]/content/route.ts:7). The UI only makes the file a hyperlink when `scanState === "Clean"` and shows the state as a pill (app/page.tsx:3305-3330).

### Draft autosave
- Footer note: **"Draft autosaves on this device"** (app/page.tsx:3013). Drafts persist to `localStorage` key `pulse-request-draft` *and* to the server (`PUT /api/v1/requests/draft`) every 10 s while title/problem are non-empty (:2591-2626).
- On reopening the composer, the local draft is restored first, then the server draft (`GET /api/v1/requests/draft`) overwrites it if present (:2551-2590). One draft per user per organization (lib/server/draft-repository.ts:28-30). Submitting clears both (`DELETE /api/v1/requests/draft`, app/page.tsx:2706-2709).

---

## 5. My requests

Component `RequestsPage` (app/page.tsx:1730-1876). Intro: eyebrow **"Your organization"**, title **"Requests from Origo"** (hard-coded org name), body **"Every request keeps its original context, status history, and link to the corresponding product idea."** (:1783-1786).

- Tabs with counts: **"All"**, **"Active"**, **"Needs information"**, **"Closed"** (:1793-1811). "Active" = status not in `Closed`/`Withdrawn` (:1768-1769).
- Toolbar: search placeholder **"Search request number, title, or problem"** (:1819), a **product area** dropdown (**"All areas"** + areas present in the data, :1823-1834), and result count **"{n} requests"** (:1835).
- Filters sync to the URL query string (`status`, `q`, `area`) and are restored on load (:1743-1764). Opening a request also writes `?request=DCI-…` to the URL for deep-linking (:773-785, restored :858-868).
- Table columns: **"Request"** (title + id), **"Product area"**, **"Submitted"**, **"Status"** (pill) (:1838-1859).
- Empty state: **"No requests match these filters"** / **"Try a different phrase, product area, or status."** with a **"Clear filters"** button (:1861-1872).

### Request detail drawer (`RequestDrawer`, app/page.tsx:3065-3485)
Loads `GET /api/v1/requests/{id}/attachments`, `GET /api/v1/requests/{id}/comments`, and `GET /api/v1/requests/{id}` (item + history) (:3083-3093).

- Header: id, title, status pill (:3246-3251).
- Summary grid: **"Product area"**, **"Business impact"**, **"Submitted"**, **"Internal owner"** (:3257-3273).
- When status is `Needs information`, a callout shows **"DataCentral needs more context"** (:3275-3286; the question paragraph beneath is currently fixed demo copy, :3280-3283 — the real question arrives as a Customer-visible comment in the Discussion section).
- **"Original customer need"** — the problem text (:3287-3289).
- **"Edit request"** and **"Withdraw"** buttons appear only while status is `Submitted` or `Needs information` (:3290-3299). Edit uses two prompts ("Request title", "Problem or desired outcome") and PATCHes title/problem (:3208-3227); success toast **"Request updated. The previous revision is preserved."** (:3226). Withdraw asks **"Withdraw this request? Its audit history will remain."**, PATCHes `{status:"Withdrawn"}`, toast **"Request withdrawn. Its history remains available."** (:3228-3243).
- **"Attachments"** — file name, size, scan state; download link only when `Clean` (:3301-3333).
- **"Linked product idea"** — status pill, id, title, description of the idea this request was consolidated into (:3334-3346).
- **"Discussion"** — comments rendered as Markdown (HTML skipped, links open in a new tab; :3350-3374). Edited comments show **"Edited"** (:3375-3377); comment attachments listed with scan state (:3378-3394). Own comments have **"Edit"** / **"Remove"** (:3395-3402); removal confirm: **"Remove this comment? Its audit tombstone will remain."** (:3178-3181); removed comments display **"[Comment removed]"** (:3200, server: lib/server/comment-repository.ts:65, 332).
- **"History"** — status/audit timeline from the request's audit events (:3408-3441; server lib/server/request-repository.ts:138-165).
- Reply box: label **"Add context"**, placeholder **"Reply to DataCentral or add relevant information"**, link **"Attach files"** (up to 5 files, ≤25 MB each, same accept list), footer **"Visible to Origo and DataCentral"**, button **"Send response"** (:3442-3481). Success toast: **"Your response was added to the request."** (:3152).

### Server rules for customer request actions
- **Comments** (`POST /api/v1/requests/{id}/comments`): body required, ≤5000 chars → `INVALID_COMMENT` (lib/server/comment-repository.ts:96); customers can only post `visibility: "Customer"` — `Internal` requires an internal role, else `FORBIDDEN` (:97-98); max 5 attachment ids (:101). Customers **never receive Internal comments** — the list filters to `visibility='Customer'` unless the caller has an internal role (:54-61, SQL :78).
- **Comment edit/remove**: only the author (or internal staff); non-internal authors have a **15-minute window** after posting, after which `INVALID_COMMENT_EDIT_WINDOW_EXPIRED` (:213-220, 234-241). Prior versions are preserved as revisions (:254, 276-283).
- **Edit request**: only while status is `Submitted`/`Needs information` → else `INVALID_REQUEST_NOT_EDITABLE` (lib/server/request-repository.ts:555-556, 593-594); allowed for the creator, a **"Company admin"** of the org, or internal staff — others get `NOT_FOUND` (:549-554, 587-592). Title/problem revisions are versioned (:597-605).
- **Status changes**: the only status a non-internal user may set is **"Withdrawn"** — anything else throws `FORBIDDEN` (:377-384). Withdrawal is limited to the creator or a Company admin (else `NOT_FOUND`, :396-401, 435-445). Withdrawing deactivates the org's interest in a linked idea if no other active linked request remains (:404-419, 469-485).
- Internal-only transitions for reference: `Closed` requires an explanation (`INVALID_CLOSURE_EXPLANATION_REQUIRED`, :385-386); `Routed to support` requires a support reference (`INVALID_SUPPORT_REFERENCE_REQUIRED`, :387-388).

### Customer-visible request status vocabulary and flow
Canonical statuses (lib/domain.ts:3-10): **Draft, Submitted, Needs information, Linked, Routed to support, Closed, Withdrawn**. Valid PATCH values are the same minus Draft (lib/server/request-repository.ts:366-376).

Flow as implemented:
- Create → **"Submitted"** (or **"Linked"** immediately if attached to an idea during duplicate discovery, request-repository.ts:201).
- DataCentral triage moves it to **"Needs information"** (question arrives as a comment), **"Linked"** (consolidated into a product idea), **"Routed to support"**, or **"Closed"** (with a customer-safe explanation) — all internal-only transitions (app/page.tsx:2159-2192 triage actions; server gate request-repository.ts:384).
- The customer may set **"Withdrawn"** at any point (creator or Company admin).
- Status changes to `Needs information`/`Linked`/`Routed to support`/`Closed` queue notifications to the requester on In-app + Email channels (request-repository.ts:500-516).

Status pill colors (`toneFor`, request-repository.ts:87-92): `Released`→green (success), `Needs information`→amber (warning), `Linked`/`Planned`/`In progress`→violet, everything else neutral. (Seed/demo rows also display **"Under review"**, **"Planned"**, and **"Released"** as request statuses — e.g. request-repository.ts:45, app/page.tsx:355/369/383 — these come from demo data, not from the PATCH vocabulary.)

---

## 6. Browse ideas, idea drawer, voting/interest

### Browse ideas (`IdeasPage`, app/page.tsx:1541-1636)
- Intro: eyebrow **"Product ideas"**, title **"Browse customer-driven ideas"**, body **"See what DataCentral is reviewing, planning, and delivering. Follow an idea to receive meaningful updates."** (:1563-1566).
- Toolbar: search placeholder **"Search ideas"**, status dropdown with exactly: **"All statuses"**, **"Under review"**, **"Considering"**, **"Planned"**, **"In progress"**, **"Released"** (:1584-1591); count **"{n} ideas"** (:1593).
- Idea cards: status pill + `IDEA-###` id, title (click opens drawer), description, tags for **product area** and **horizon**, footer **"{n} organizations"** and a **"Follow"**/**"Following"** toggle (bell icon → check icon) (:1596-1623).
- Empty state: **"No ideas match these filters"** / **"Adjust the search or submit the requirement your team needs."** / button **"Submit a request"** (:1625-1632).

### What ideas customers can see (server)
- `GET /api/v1/ideas` returns only ideas with `publish_state='Published'`, using the **published** (customer-safe) title/description when present (`COALESCE(published_title, internal_title)`), plus organization-interest count, follower count, and whether *you* follow it (lib/server/idea-repository.ts:132-166; published filter :150).
- `GET /api/v1/ideas/{id}` resolves merged-idea aliases to the canonical idea (`redirected: true`) and 404s for unpublished/unknown ids (idea-repository.ts:168-190).

### Customer-visible idea status vocabulary vs internal
Internal statuses (app/page.tsx:50-57; also the internal editor's dropdown :4949-4957): **Discovery, Candidate, Planned, In progress, Released, Not planned, Archived**.
Published (customer) statuses via `externalStatus` (lib/server/product-repository.ts:71-77):
| Internal | Customer sees |
|---|---|
| Discovery | **"Under review"** |
| Candidate | **"Considering"** |
| Planned | "Planned" |
| In progress | "In progress" |
| Released | "Released" |
| Not planned | "Not planned" |

Idea pill tones (idea-repository.ts:124-130): Released→success, Planned/In progress→violet, others neutral.

### Following / interest ("voting")
- **Follow** button → `POST /api/v1/ideas/{id}/follow` with `{support:false}`; toggles follow and returns updated counts (app/page.tsx:950-974; app/api/v1/ideas/[id]/follow/route.ts:4). Toasts: **"You are now following this idea."** / **"You will no longer receive updates."** (:969-973); failure: **"The follow preference could not be changed."** (:958).
- `support: true` (sent by **"This solves my need"** in the composer) additionally records the **organization's interest** in the idea (idea-repository.ts:236-244), which feeds the "N organizations" demand count.
- Server verifies active membership before following (SQL mode, idea-repository.ts:206-213) and only allows following Published ideas (:222-224).
- There are **no customer comments on ideas** — comments exist only on requests (`parent_type='Request'`, comment-repository.ts:78).

### Idea drawer (`IdeaDrawer`, app/page.tsx:3487-3575)
- Highlight: eyebrow **"Product direction"**, heading **"Available now"** (Released) or **"{Now|Next|Later} horizon"**, description (:3509-3517).
- Summary: **"Product area"**, **"Organizations"**, **"Followers"**, **"Last update"** (:3518-3535).
- **"Latest update"** section with canned copy per status — e.g. Released → **"Released to eligible tenants"**; otherwise **"{status}: scope is being refined"** with one of three fixed paragraphs, and a fixed timestamp `14 JUL 2026 · 14:30Z` (:3536-3551; note: fixed demo copy).
- Evidence banner: **"Demand across {n} organizations"** / **"Customer identities and raw request context remain private."** (:3552-3560).
- Footer: **"Close"** and **"Follow idea"**/**"Following"** (:3562-3572).

---

## 7. Roadmap

Component `RoadmapPage` (app/page.tsx:1638-1728).

- Intro: eyebrow **"Directional roadmap"**, title **"Where the product is heading"**, body **"Roadmap horizons express current intent and may change as customer evidence and delivery constraints evolve."** (:1652-1655).
- Callout: **"Built from governed customer evidence"** / **"Roadmap items combine related requests while keeping each customer's context private."** (:1657-1666).
- Three columns with per-column notes and item counts (:1645-1649):
  - **"Now"** — "Active delivery"
  - **"Next"** — "Approved and sequenced"
  - **"Later"** — "Validated, not committed"
- Cards show status pill, id, title, description, area, and org-demand count; click opens the idea drawer (:1680-1701).
- Below the board: **"Released"** / **"Recently delivered"** strip listing ideas with horizon `Released` (:1706-1725).
- The roadmap uses the same published ideas feed (`GET /api/v1/ideas`); horizons are `Now | Next | Later | Released` (lib/server/idea-repository.ts:11). A configurable disclaimer exists in settings — default **"Roadmap content is directional, may change, and is not a contractual commitment."** (lib/server/settings-repository.ts:27-28) — [UNVERIFIED: not rendered anywhere in the current customer UI; only editable on the internal Settings page, app/page.tsx:5984-5994].

---

## 8. Updates and notifications

### Notifications popover (bell)
`NotificationsPopover` (app/page.tsx:6119-6170): header **"Updates"** with **"View all"** (goes to Updates page). Empty state: **"No unread product updates."** (:6135). Shows up to 5 items; icon/color derives from event type (release→green check, "needs"→amber message, otherwise violet spark) (:6137-6156). Clicking an item marks it read via `POST /api/v1/notifications/{id}/read` (:1179-1190; server scopes to the current user — lib/server/operations-repository.ts:354-374).

### Updates page (`UpdatesPage`, app/page.tsx:1878-2052)
- Intro: eyebrow **"Product updates"**, title **"Changes that matter to your team"**, body **"A focused record of decisions, progress, and releases for requests you follow."** (:1968-1971).
- **"Notification preferences"** section: **"Choose when email updates arrive for this company context."** (:1976-1977). Each event type row has a cadence select: **Immediate / Daily / Weekly / Off** (:2004-2007). Mandatory rows show **"Mandatory service message · delivered immediately"** and the select is disabled; others show **"In-app updates remain available in Pulse"** (:1990-1999). Status text: **"Saving…"**, **"Preferences saved."**, **"Could not save this preference."** (:1899-1915).
- Server (lib/server/notification-preference-repository.ts): event types are `request.submitted`, `request.needs-information`, `request.linked`, `request.status-changed`, `comment.mention`, `idea.status-changed`, `release.published` (:5-13); **mandatory** = `request.needs-information` and `comment.mention` (:23-26); default cadence Immediate (:39-41); attempting to change a mandatory event → `MANDATORY_NOTIFICATION_MUST_BE_IMMEDIATE` (:85-86). Preferences are per user per organization (:59-61). GET/PATCH at `/api/v1/notifications/preferences`.
- Feed: real notifications (`GET /api/v1/notifications`, user-scoped — operations-repository.ts:343-353) render as a timeline of event-type titles; when none exist, a fixed 4-entry demo feed is shown ("Display playlist scheduler moved to In progress", "Audit log API is planned", "Mobile dashboard improvements released", "More context requested") (app/page.tsx:1918-1965). Entries with an idea link show **"View product idea"** (:2037-2044).

### When notifications are generated for customers
- On submit: `request.submitted` (In-app + Email) (lib/server/request-repository.ts:344-350).
- On triage status change to Needs information / Linked / Routed to support / Closed: `request.needs-information` etc. to the requester (:500-516).
- On `@Name` mention in internal comments — internal-only mechanics (comment-repository.ts:174-193).
- On release publish (release.published) — published releases notify eligible users (internal Releases UI copy: **"Publishing will update included ideas and notify each eligible user once."**, app/page.tsx:5422-5425).

### Releases (customer visibility)
`GET /api/v1/releases` returns **published releases only** for non-internal callers (app/api/v1/releases/route.ts:8; lib/server/operations-repository.ts:75-84). The current customer UI does not render this endpoint anywhere — release news reaches customers through Updates/notifications and Released ideas; the endpoint is available to API/assistant consumers (the assistant tool `list_releases` — "List published product releases with their summary and availability.", lib/server/chat/tools-customer.ts:511-513).

### Saved views
Saved views are **internal-only** (`requireInternalRole`, lib/server/saved-view-repository.ts:24, 48) under `/api/v1/internal/saved-views`. Customers have no saved-views UI; their equivalent is URL-persisted filters on My requests (§5).

---

## 9. Assistant (chat panel)

`ChatPanel` is mounted for every user (app/page.tsx:1326-1329; component app/chat-panel.tsx).

- Floating launcher button (✦ / ✕), aria-labels "Open assistant"/"Close assistant" (chat-panel.tsx:233-241). Panel header: **"✦ Assistant"** with clear (🗑) and close buttons (:248-266). Clear confirm: **"Clear the entire chat history?"** (Icelandic: "Hreinsa alla spjallsöguna?") (:215-221).
- If no API key is configured server-side, notice: **"The assistant needs an API key. Ask an administrator to set ANTHROPIC_API_KEY."** (:269-274).
- Example prompts shown when empty: "Submit a request: exports to Excel time out for large orders" and "Sýndu mér hugmyndirnar sem ég fylgist með" (:31-34).
- Input placeholder **"Ask the assistant…"** (is: "Skrifaðu skilaboð…") (:330-338); Enter sends, Shift+Enter for newline (:158-172); optional microphone dictation via the Web Speech API where supported, language follows the user's locale (en-US / is-IS) (:190-208, 343-363). Busy indicator **"Thinking…"** ("Í vinnslu…") (:314-318).
- History and messages via `GET/POST/DELETE /api/v1/chat/messages`; a `dataChanged` reply flag triggers the app to refetch data (:126-141; app/page.tsx:769-771, 1328).
- Customer-scoped tools include: `get_me`, `list_my_requests`, `get_request`, `find_similar`, `submit_request`, `edit_request`, `set_request_status`, request-draft tools, `list_attachments`, comment tools, `browse_ideas`, `get_idea`, `follow_idea`, `view_roadmap`, `list_releases`, `list_notifications`, `mark_notification_read`, notification-preference tools (lib/server/chat/tools-customer.ts:41-574). Internal/admin tools exist but every tool re-checks authorization server-side (e.g. `requireInternalRole`, lib/server/chat/tools-internal.ts:75), and the system prompt states for customers: **"They are a customer user: only their own organization's data is accessible. Politely refuse triage, internal, or admin actions."** and **"Permissions are enforced server-side."** (lib/server/chat/tool-registry.ts:42-43).

---

## 10. What happens when a customer touches internal content

### Server behavior (anti-enumeration)
- All `/api/v1/internal/*` and `/api/v1/admin/*` repositories call `requireInternalRole(...)` which throws `FORBIDDEN` for non-internal users (lib/server/authorization.ts:28-47; e.g. triage lib/server/triage-repository.ts:15, internal ideas lib/server/product-repository.ts:192, analytics lib/server/analytics-repository.ts:12, audit log — System admin only — lib/server/operations-repository.ts:375-376, settings/taxonomy/webhooks — System admin — lib/server/settings-repository.ts:61-69, lib/server/taxonomy-repository.ts:47-62, lib/server/webhook-repository.ts:78-149, saved views lib/server/saved-view-repository.ts:24-59).
- `apiError` maps **both `FORBIDDEN` and `NOT_FOUND` to HTTP 404** (lib/server/http.ts:17-19) — a customer probing internal endpoints (or another org's DCI/IDEA ids) cannot distinguish "exists but forbidden" from "does not exist". Response body: `{ "error": { "code": "FORBIDDEN" | "NOT_FOUND", "message": "forbidden" | "not found", "correlationId": … } }` (message is lower-cased with underscores replaced, http.ts:31-44).
- Cross-tenant record access is written as `NOT_FOUND` directly in repositories (e.g. request lookup lib/server/request-repository.ts:130-136; comments lib/server/comment-repository.ts:52-53; attachments :715-733).
- `UNAUTHORIZED` → 401; `INVALID_*` → 400; unexpected → 500 with generic **"The operation could not be completed."** (http.ts:16-38).

### UI behavior on the internal nav pages (customers can click them)
The AppShell always fetches internal data after login and **silently ignores failures** (`.catch(() => {})`): `/api/v1/internal/ideas`, `/api/v1/internal/releases`, `/api/v1/internal/audit?limit=100` (app/page.tsx:870-887) and `/api/v1/admin/organizations`, `/api/v1/admin/users` (:889-903). For a customer these all return 404, so:

| Nav item | What a customer sees |
|---|---|
| **Triage inbox** | The page renders using the customer's *own* request list plus a hard-coded demo row (DCI-1048) (app/page.tsx:2065-2083). Any decision action fails: status PATCH → toast **"The request could not be updated."** (:2112); internal note → **"The internal note could not be saved."** (:2095); link to idea → **"The request-to-idea link could not be created."** (:2143); bulk assign → **"The bulk assignment could not be completed."** (:2208). |
| **Product ideas** | Empty table (internal ideas never load); metric cards show 0; **"Create idea"**/**"Manage"** actions fail with the server error message shown in the modal's alert area (:4756-4767, 5258-5262). |
| **Releases** | Empty state **"No releases yet"** / **"Create a release when one or more ideas are ready to communicate."** (:5375-5381); creating fails with the error banner (:5322-5325). |
| **Analytics** | Summary stays `null` (fetch 404s, :5613-5618); page shows counts computed from the customer's own visible requests/ideas; **"Export CSV"** navigates to `/api/v1/internal/analytics/requests.csv`, which returns the 404 error JSON (lib/server/analytics-repository.ts:90). |
| **Companies / Users** | Fall back to the client-side demo constants (`initialCompanies`/`initialManagedUsers`) since the admin fetch fails silently (:750-751, 889-903). Saves fail: **"The company could not be saved."** (:3602) / **"The user and memberships could not be saved."** (:3930). |
| **Authentication** | Entirely static/informational UI (no privileged fetch); buttons only raise local toasts (:4273-4523). |
| **Settings** | Settings/taxonomy/webhooks fetches 404 silently (:5776-5791), so defaults render; every save fails, e.g. **"Settings could not be saved."** (:5802), **"Taxonomy could not be saved."** (:5822), **"Webhook could not be created."** (:5862). |
| **Audit log** | Empty state **"No audit events"** / **"Material mutations will appear here with actor and correlation context."** (:5575-5581). |

There is no dedicated "access denied" screen — for customers the internal pages render skeletons of demo/empty content and all privileged actions fail with the toasts above, while the API consistently answers 404.

---

## 11. Platform behaviors relevant to customers

- **Rate limits** (per user/IP + method + path, per minute): 30 for attachment paths, 30 for comment paths, 60 for other mutations, 180 for reads (proxy.ts:10-16). Exceeding returns HTTP 429 `{"error":{"code":"RATE_LIMITED","message":"Too many requests. Please try again shortly."}}` with `retry-after` (proxy.ts:106-122).
- **CSRF**: cross-site mutations are rejected with 403 `CSRF_REJECTED` "Cross-site mutation rejected." (proxy.ts:80-90).
- **Correlation ids**: every response carries `x-correlation-id`; error bodies include it (proxy.ts:63-64, 124-127; lib/server/http.ts:3-11).
- **Idempotency**: client mutations send an `idempotency-key` UUID header (app/page.tsx:8-13); replays return the original result with `idempotency-replayed: true` (app/api/v1/requests/route.ts:29-32).
- **Localization**: the user record has a `locale` (`en`/`is`) which currently drives only the assistant panel language (app/page.tsx:1326-1327; lib/server/current-user.ts:33).
- **Logout** (standalone): `/auth/logout` route exists (app/auth/logout/route.ts) — there is no logout control inside the Pulse UI chrome (no reference in app/page.tsx).

## 12. Quick reference — customer-callable API routes

| Route | Methods | Purpose |
|---|---|---|
| `/api/v1/me` | GET | identity, memberships, activeOrganizationId, dcEmbed (app/api/v1/me/route.ts) |
| `/api/v1/me/context` | POST | switch active organization (membership re-verified) |
| `/api/v1/requests` | GET, POST | list org-visible requests; submit (idempotent) |
| `/api/v1/requests/{id}` | GET, PATCH | detail + history; edit title/problem or set `Withdrawn` |
| `/api/v1/requests/{id}/comments` | GET, POST | Customer-visible discussion |
| `/api/v1/requests/{id}/comments/{commentId}` | PATCH, DELETE | edit/remove own comment (15-min window) |
| `/api/v1/requests/{id}/attachments` | GET, POST | list; init upload |
| `/api/v1/attachments/{id}/content` | GET, PUT | download (Clean only; else 423); memory-mode upload |
| `/api/v1/attachments/{id}/complete` | POST | finalize blob upload |
| `/api/v1/requests/draft` | GET, PUT, DELETE | server-side draft per user+org |
| `/api/v1/ideas` | GET | published ideas |
| `/api/v1/ideas/{id}` | GET | published idea (alias-redirecting) |
| `/api/v1/ideas/{id}/follow` | POST | follow toggle / support interest |
| `/api/v1/releases` | GET | published releases |
| `/api/v1/notifications` | GET | own notifications |
| `/api/v1/notifications/{id}/read` | POST | mark read |
| `/api/v1/notifications/preferences` | GET, PATCH | cadence per event type |
| `/api/v1/search/suggestions` | GET | duplicate-detection suggestions |
| `/api/v1/search/suggestions/dismiss` | POST | record dismissal (counts only) |
| `/api/v1/chat/messages` | GET, POST, DELETE | assistant conversation |
| `/api/v1/chat/transcript` | POST | clean up dictation transcript |

All `/api/v1/internal/*` and `/api/v1/admin/*` routes respond **404** (`FORBIDDEN` code) to customers (lib/server/http.ts:17-19).
