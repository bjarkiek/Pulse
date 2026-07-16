# Gap report — completeness critique of the five research files

Scope: cross-check of `customer-features.md`, `internal-features.md`, `assistant-slack.md`, `architecture-auth-mcp.md`, `permission-matrix.md` against each other and against the code at `C:/VS Code/Pulse`. Every verdict below was verified directly in code.

Overall verdict: the five files are highly consistent — tool counts (24/23/11 = 58 + `switch_organization`), role model, session TTL (12 h), rate limits (30/30/60/180), status vocabularies, anti-enumeration (FORBIDDEN and NOT_FOUND both → HTTP 404), Slack identity/dedupe, and the publish/confirmation flows all agree across files and match the code. The issues found are below.

---

## 1. Contradictions between files (with the verified winner)

### 1.1 Who may withdraw a request — **permission-matrix.md is right**
- `customer-features.md` §5 states flatly: "Withdrawal is limited to the creator or a Company admin (else `NOT_FOUND`)" and §"flow": "The customer may set Withdrawn at any point (creator or Company admin)."
- `permission-matrix.md` says Product manager / System admin can withdraw any request in an org where they hold a membership ("Yes*").
- **Code**: `lib/server/request-repository.ts:435-445` — the creator/Company-admin ownership check is wrapped in `if (status === "Withdrawn" && !internal)`, where `internal` = `requirePublishRole` succeeded (`:377-384`). PM/SA (with an Active membership in the org) skip the ownership check entirely; memory path identical (`:395-401`). So the creator/Company-admin limit applies only to non-publish-role callers. permission-matrix is correct; customer-features is incomplete (acceptable in a customer-only doc, but the guide's shared matrix must follow permission-matrix).

### 1.2 Who may edit a request — **permission-matrix.md is right**
- `customer-features.md` §5: edit is "allowed for the creator, a **Company admin** of the org, or **internal staff**".
- `permission-matrix.md`: author / Company admin / `requirePublishRole` — with **Internal contributor explicitly "No (unless author)"**.
- **Code**: `lib/server/request-repository.ts:536-542` — `internal` is set only by `requirePublishRole` (PM/SA); gate at `:549-554` (memory) and `:587-592` (SQL). An Internal contributor is NOT "internal" here and gets `NOT_FOUND` on someone else's request. "Internal staff" in customer-features is overbroad.

### 1.3 Line-number citation for the SPA 401→login behavior — **customer-features.md is right**
- `architecture-auth-mcp.md` Path B step 1 cites "page.tsx:1118-1129" for "the SPA does the same on a 401 from `/api/v1/me`".
- **Code**: the 401 handling is at `app/page.tsx:787-805` (matches customer-features' `:790-804`); `page.tsx:1118-1129` is the sidebar profile-card area. Architecture file's claim is substantively correct, citation wrong.

### 1.4 CSV-export citation — **internal-features.md is right** (trivial)
- `customer-features.md` §10 cites `lib/server/analytics-repository.ts:90` for the CSV export gate; **code**: `:90` is `getAnalyticsSummary`'s gate; the export gate is `exportAuthorizedRequests` at `:11-12`. Substance (any internal role; 404 for customers) is correct in both files.

No other substantive contradictions found. Notably these agreed and were code-confirmed on spot-check: `AppReady` posted twice including the trailing-space variant (`app/dc-embed/route.ts:86-87`); mandatory notification events = `request.needs-information` + `comment.mention` (`notification-preference-repository.ts:23-26`); external status mapping Discovery→"Under review", Candidate→"Considering" (`product-repository.ts:71-77`); empty-Enter sends "Yes"/"Já" (`chat-panel.tsx:158-172`); MCP registers ALL tools relying on repo guards (`app/mcp/route.ts:53`); default model `claude-opus-4-8` (`assistant-service.ts:27`); Slack dedupe 15 min (`slack/dedupe.ts:12`); Requester/Viewer never branched on server-side (grep: only enum declarations at `admin-repository.ts:23`, `tools-admin.ts:131`); no logout control in `app/page.tsx` (grep: zero matches).

---

## 2. Missing topics a two-persona user guide needs (covered by no file)

1. **"One-time password" is not a working sign-in path in Pulse.** The admin UI presents OTP as an auth method everywhere (Companies checkbox `app/page.tsx:3854-3859`, Users editor option `:4175`, Authentication page card `:4298-4324` claiming "Status Active", "Code lifetime 10 minutes"), yet no OTP login route exists anywhere in the app — the only sign-in paths are DataCentral embed/launch, Entra OIDC, and dev fallback (architecture file, confirmed). The only code acknowledgment is a comment: "signed dcdata — universal, covers Entra AND external/OTP users" (`app/dc-auth/route.ts:35`), i.e. OTP users authenticate at DataCentral and can only reach Pulse embedded. The guide must tell admins what selecting "OTP" actually does (nothing inside Pulse today) and tell customers standalone browser sign-in requires Entra. No research file reconciles this; internal-features documents the OTP UI as if functional.
2. **"Send invitation" sends no email.** `saveUser` only upserts a user row with a `pending:{email}` external subject (`lib/server/admin-repository.ts:174-179, 203-211`); there is no mailer (grep: no mail/invite-sending code). The real onboarding step — the invited person simply signs in via Entra or DataCentral with the same email, which claims the pending row (`user-directory.ts`) — is the single most important admin-persona how-to and appears in no file.
3. **Language/locale end-to-end.** No file answers "how does a user get Icelandic?": the main UI is English-only; `dbo.Users.locale` drives only the assistant panel and notification-email language; there is no self-service UI to change locale; admin Settings "Editing language" is a platform default. Fragments exist (customer-features §11 one-liner, worker subjects in internal-features) but never assembled, and the mechanism for setting a user's locale is nowhere documented.
4. **Taxonomy has no effect on the forms.** Settings "Product taxonomy" manages Product-area values, but the customer composer (`app/page.tsx:2879-2885`) and internal idea editor (`:4926-4934`) use hard-coded lists, and `createRequest` validates only title/problem/visibility — never `area` (`request-repository.ts:180-186`, verified). An admin adding/deactivating a product area will see zero effect on either persona's dropdowns. No file states this.
5. **"Partner" organization type is unexplained.** Selectable in the Companies editor (`admin-repository.ts:7`), but authorization only ever distinguishes `type === "Internal"` — a Partner org behaves exactly like Customer. The guide should say so; no file does.
6. **The phantom "Draft" request status.** `lib/domain.ts:3-10` includes `Draft`, but no code path ever creates a Draft-status request (`createRequest` mints only Submitted/Linked, `request-repository.ts:201`; drafts live in a separate one-per-user store). A guide reader seeing the status vocabulary will look for Draft rows that cannot exist.
7. **User-facing "connect via MCP" steps.** architecture-auth-mcp documents the protocol thoroughly, but no file gives the task-oriented steps either persona needs: add `https://<host>/mcp` as a remote MCP server/connector, sign in with your normal Pulse account, review the "it will be able to do everything you can do. All actions are logged as you." consent, Allow. Needs synthesis in the guide.
8. **Internal-contributor triage pitfall.** The Triage decision panel is rendered for all internal roles, but "Request information" first posts the customer-visible comment (allowed for any member) and then fails the status PATCH for Internal contributors (PM/SA-only) — leaving a half-applied decision: the customer sees the question but the status never becomes "Needs information". Derivable from internal-features §3 but never called out; the internal guide should warn contributors off the decision buttons.

Minor (optional): `isVerified` is returned by `/api/v1/me` but consumed nowhere in the UI (grep: only tests/docs) — safe to omit from the guide; email-delivery troubleshooting (ACS unconfigured ⇒ emails silently undeliverable) is touched only via worker states.

---

## 3. Claims disproved (or citation-corrected) in code

1. **customer-features.md §5** — "Withdrawal is limited to the creator or a Company admin": disproved as an absolute; the gate is skipped for publish-role callers. `lib/server/request-repository.ts:435-445` (SQL), `:395-401` (memory).
2. **customer-features.md §5** — request edit "allowed for … internal staff": disproved for Internal contributor; only `requirePublishRole` (PM/SA) qualifies. `lib/server/request-repository.ts:536-542, 587-592`.
3. **architecture-auth-mcp.md** Path B step 1 — citation "page.tsx:1118-1129" is wrong; the 401→`/auth/login` logic is at `app/page.tsx:787-805`. (Behavior claim itself confirmed.)
4. **customer-features.md §10** — CSV export gate cited as `analytics-repository.ts:90`; actual export gate is `:11-12` (`:90` gates the summary). Behavior claim confirmed.

Everything else spot-checked (≈20 claims across the five files, listed at the end of §1) matched the code exactly.
