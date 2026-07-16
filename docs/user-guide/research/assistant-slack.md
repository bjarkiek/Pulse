# DataCentral Pulse — AI Assistant Surfaces (research notes)

All claims verified against code as of this commit. Citations are `file:line`.

---

## 1. In-app chat panel (`app/chat-panel.tsx`)

Self-contained floating launcher + panel, deliberately independent of `page.tsx` (app/chat-panel.tsx:3-6).

### Opening / closing

- A floating launcher button (class `chat-launcher`) toggles the panel. It shows the glyph `✦` when closed and `✕` when open; accessible names are **"Open assistant"** / **"Close assistant"** (app/chat-panel.tsx:233-241).
- The panel is a dialog labelled **"Assistant"** with the header **"✦ Assistant"** (app/chat-panel.tsx:242-249).
- Header buttons: `🗑` (**"Clear chat history"**, disabled while busy or when there are no messages) and `✕` (**"Close assistant"**) (app/chat-panel.tsx:251-265).
- Both launcher and panel carry the `no-print` class, so they never appear in printed pages (app/chat-panel.tsx:235, 244).

### First open, history, and the empty state

- History is lazy-loaded the **first time** the panel is opened (not on page load) via `GET /api/v1/chat/messages` (app/chat-panel.tsx:79-101). The GET returns `configured` plus the user's last **50** messages (app/api/v1/chat/messages/route.ts:10-17).
- When configured and the history is empty, two clickable example prompts are shown (app/chat-panel.tsx:275-287), exactly:
  - `Submit a request: exports to Excel time out for large orders`
  - `Sýndu mér hugmyndirnar sem ég fylgist með` (Icelandic: "Show me the ideas I follow") (app/chat-panel.tsx:31-34)

### Message flow

- Input is a textarea with placeholder **"Ask the assistant…"** (Icelandic locale: **"Skrifaðu skilaboð…"**); when the assistant is unconfigured the placeholder is **"Assistant unavailable"** / **"Aðstoðarmaður ekki tiltækur"** and the input is disabled (app/chat-panel.tsx:229, 326-342).
- Send button `➤`, accessible name **"Send message"** / **"Senda skilaboð"**, disabled while busy, unconfigured, or empty (app/chat-panel.tsx:364-372).
- **Enter** sends; **Shift+Enter** makes a newline (app/chat-panel.tsx:158-172). Pressing Enter on an **empty** input right after an assistant message sends a locale-appropriate confirmation — `"Yes"` (or `"Já"` in Icelandic) — a shortcut for answering the assistant's yes/no confirmation questions (app/chat-panel.tsx:162-170).
- Sending does `POST /api/v1/chat/messages` with `{ text }`; the user bubble is appended immediately, then the assistant reply bubble from `data.reply` (app/chat-panel.tsx:115-141). The server rejects empty text or text over **4000 characters** (`INVALID_CHAT_TEXT`) (app/api/v1/chat/messages/route.ts:28-29).
- While waiting, a busy bubble shows **"Thinking…"** / **"Í vinnslu…"** (app/chat-panel.tsx:314-318).
- On network/server failure a friendly bubble is shown instead of an error page: **"Sorry, something went wrong sending that. Please try again."** / **"Því miður tókst ekki að senda skilaboðin. Reyndu aftur síðar."** (app/chat-panel.tsx:36-40, 142-152).
- Assistant bubbles render Markdown (ReactMarkdown, `skipHtml`); links open in a new tab with `rel="noreferrer noopener"` (app/chat-panel.tsx:294-311). User bubbles are plain text (app/chat-panel.tsx:289-292).

### Server-side processing (`lib/server/chat/assistant-service.ts`)

- `sendChat` persists the user message, replays the user's last **30** history messages to the model, and runs an Anthropic tool loop: model `ANTHROPIC_MODEL` env var or default `claude-opus-4-8`, `max_tokens: 4000`, adaptive thinking, `max_iterations: 16` (lib/server/chat/assistant-service.ts:27, 90-93, 110-117).
- API errors produce the reply **"The assistant ran into a problem completing that request. Please try again in a moment."**; unexpected errors produce **"The assistant hit an unexpected error. Please rephrase and try again."** (lib/server/chat/assistant-service.ts:125-137). The assistant reply (including these) is persisted to history (lib/server/chat/assistant-service.ts:140).
- System prompt = shared assistant instructions + a "Today is yyyy-MM-dd (weekday, ISO week N)." line + behavior rules (reply in the user's language, use tools, resolve relative dates, always `find_similar` before creating requests, confirm destructive/high-blast actions, ask one short clarifying question when ambiguous, be concise) (lib/server/chat/system-prompt.ts:38-56, lib/server/chat/tool-registry.ts:30-52).

### Voice dictation

- The mic button (`🎤`) is rendered **only** if the browser exposes the Web Speech API — feature detection `window.SpeechRecognition ?? window.webkitSpeechRecognition` (app/chat-panel.tsx:57-61, 343-363). Browsers without it (notably Firefox) simply never show the button. [Context, not code: Chrome, Edge, and Safari implement this API.]
- Accessible names: **"Start dictation"** / **"Stop dictation"** (**"Hefja upptöku"** / **"Stöðva upptöku"**) (app/chat-panel.tsx:347-355). Disabled while busy or unconfigured (app/chat-panel.tsx:356).
- Recognition language follows the app locale: `is-IS` for Icelandic, otherwise `en-US`; no interim results, single alternative (app/chat-panel.tsx:195-197).
- Microphone permission is requested by the **browser** when `recognition.start()` runs (app/chat-panel.tsx:207); there is no in-app permission UI. A denied permission fires `onerror`, which just resets the listening state (app/chat-panel.tsx:203).
- While recording, a bubble shows **"Listening…"** / **"Hlusta…"** (app/chat-panel.tsx:319-323). Dictation stops automatically when a result arrives, on error, or when the panel unmounts (app/chat-panel.tsx:69, 198-204).
- The raw transcript is POSTed to `/api/v1/chat/transcript` (app/chat-panel.tsx:174-188; app/api/v1/chat/transcript/route.ts:5-15). Server-side `cleanTranscript` sends it to Claude with this instruction: *"You clean up voice-dictation transcripts. Fix punctuation, casing and obvious mis-transcriptions, remove filler words and repetitions, but keep the language, meaning and all specifics (dates, numbers, names) exactly. Reply with ONLY the cleaned text."* (lib/server/chat/assistant-service.ts:144-147). If the API key is missing, the text is empty, or cleanup fails, the **raw transcript is returned unchanged** (lib/server/chat/assistant-service.ts:149-167); the panel likewise falls back to the raw transcript on fetch failure (app/chat-panel.tsx:181-187). The cleaned text is then sent as a normal chat message (app/chat-panel.tsx:184).

### Clear / history persistence

- History is **per user**: stored keyed by the user's id — in table `dbo.ChatMessages (id, user_id, role, content, created_at)` when Azure SQL is configured, otherwise an in-memory per-process Map (lib/server/chat/chat-repository.ts:28-75).
- Because history is per user id (not per surface), the **in-app panel and Slack share one conversation history** — both call the same `sendChat` (lib/server/chat/assistant-service.ts:90-92; lib/server/slack/event-handler.ts:65).
- Clearing: the `🗑` button asks `window.confirm` — **"Clear the entire chat history?"** / **"Hreinsa alla spjallsöguna?"** — then `DELETE /api/v1/chat/messages` deletes all of that user's messages (app/chat-panel.tsx:215-227; app/api/v1/chat/messages/route.ts:55-64; lib/server/chat/chat-repository.ts:77-87).

### `dataChanged` page refresh

- The chat host marks `dataChanged: true` whenever a **non-readOnly** tool call succeeds, or when `switch_organization` runs (lib/server/chat/assistant-service.ts:45-53, 65-72; contract note at lib/server/chat/tool-contract.ts:20).
- The POST response returns `{ reply, dataChanged }` (app/api/v1/chat/messages/route.ts:31-35). When `dataChanged` is true the panel calls `onDataChanged` (app/chat-panel.tsx:141), which bumps a `dataVersion` counter in `page.tsx` (app/page.tsx:1326-1329, 769-771). All identity-gated data-loading effects depend on `dataVersion`, so the page **refetches its data without a reload** (app/page.tsx:856, 887, 903, 917, 934).
- If the assistant switched the active organization, the route also sets the `pulse-organization` cookie (httpOnly, 30 days; CHIPS-partitioned `SameSite=None; Secure` in production) so the switch persists (app/api/v1/chat/messages/route.ts:36-48).

### Unconfigured notice (ANTHROPIC_API_KEY missing)

- `isAssistantConfigured()` is simply `Boolean(process.env.ANTHROPIC_API_KEY)` (lib/server/chat/assistant-service.ts:16-18).
- Panel notice (exact text): **"The assistant needs an API key. Ask an administrator to set ANTHROPIC_API_KEY."** (app/chat-panel.tsx:269-274). Input, mic, and send are all disabled (app/chat-panel.tsx:229, 339, 356, 368).
- If a message somehow reaches the server anyway, the reply is: **"The assistant isn't configured yet. Ask an administrator to set ANTHROPIC_API_KEY."** (lib/server/chat/assistant-service.ts:82-87).

---

## 2. Tool registry (`lib/server/chat/`)

### Architecture and permission model

- `getChatTools()` returns customer + internal + admin tools (lib/server/chat/tool-registry.ts:20-22). The same registry powers both the in-app chat and the MCP endpoint (lib/server/chat/tool-contract.ts:11-14).
- **Group gating**: every user gets the `customer` group; users with an Active membership in an `Internal`-type organization also get `internal`; and `admin` only if that internal role is **"System admin"** (lib/server/chat/assistant-service.ts:96-100). Gating is "prompt hygiene; repos are the braces" — real enforcement is in the repository layer (lib/server/chat/assistant-service.ts:32).
- **`withScope`**: every tool runs against a *copy* of the request identity with `organization_id` (if passed) as the active organization — tools never mutate the shared per-request identity (lib/server/chat/tool-contract.ts:41-63). Every tool's schema includes the optional `organization_id` parameter ("must be one of the user's memberships; defaults to the active organization") (lib/server/chat/tool-contract.ts:33-39).
- **Error mapping** (`chatToolErrorMessage`, lib/server/chat/tool-contract.ts:65-76): repository `FORBIDDEN` or `NOT_FOUND` both surface as the single non-leaking message **"That item doesn't exist or you don't have access to it."**; `UNAUTHORIZED` → **"You are not signed in."**; `INVALID_ACTIVE_ORGANIZATION_REQUIRED` → **"You belong to several organizations — pass organization_id (ask get_me for the list)."**; other validation codes are lower-cased into readable text; anything else → **"Unexpected error performing that action. Try rephrasing."**
- Membership/role checks throw `FORBIDDEN` from `requireMembership` / `requireInternalRole` (roles: Internal contributor, Product manager, System admin) (lib/server/authorization.ts:21, 28-47).
- `readOnly` flag semantics: MCP `readOnlyHint`; chat host flips `dataChanged` on any successful non-readOnly call (lib/server/chat/tool-contract.ts:20; lib/server/chat/assistant-service.ts:48).
- **Explicit confirmation**: four mutating tools refuse to act until re-called with a confirmation flag after the user explicitly agrees:
  - `bulk_triage` — `confirmed` (lib/server/chat/tools-internal.ts:105-110, 117-122)
  - `merge_ideas` — `confirmed` (lib/server/chat/tools-internal.ts:307-310, 317-322)
  - `publish_release` — `confirmed` (lib/server/chat/tools-internal.ts:508-511, 518-523)
  - `publish_idea` — `confirmed_safe` ("Set true ONLY after the user explicitly confirms the published wording is customer-safe"; unlike the other three, refusal on false is enforced in the repository call, not by an early return in the tool) (lib/server/chat/tools-internal.ts:218-241)
- **Chat-host-only extra tool** (not in the registry): `switch_organization` — switches the user's active organization for the session; verified via `requireMembership`; persists via the `pulse-organization` cookie (lib/server/chat/assistant-service.ts:56-77; app/api/v1/chat/messages/route.ts:36-48).

### Customer tools — 24 (`lib/server/chat/tools-customer.ts`) — available to every signed-in user

| Tool | R/W | One-liner |
|---|---|---|
| `get_me` | read | Your identity, organization memberships (role per org), and which org is active (tools-customer.ts:41-63) |
| `list_my_requests` | read | List your org's requests (DCI-####), optionally filtered by exact status (tools-customer.ts:65-88) |
| `get_request` | read | Full details + recent history for one request by DCI-#### id (tools-customer.ts:90-117) |
| `find_similar` | read | Search published ideas + your org's requests for duplicates of a new problem statement; always called before submit_request (tools-customer.ts:119-143) |
| `submit_request` | write | Create a new request (title ≤140, problem ≤5000, area, impact, visibility Private/Organization) (tools-customer.ts:145-173) |
| `edit_request` | write | Edit title/problem of your own request — only while status Submitted or Needs information (tools-customer.ts:175-196) |
| `set_request_status` | write | Change request status; customers may only Withdraw; Closed needs an explanation, Routed to support needs a supportReference (tools-customer.ts:198-233) |
| `get_request_draft` | read | Get the current unsubmitted request draft, if any (tools-customer.ts:235-251) |
| `save_request_draft` | write | Save/update the in-progress request draft without submitting (tools-customer.ts:253-278) |
| `discard_request_draft` | write | Discard the in-progress draft (tools-customer.ts:280-292) |
| `list_attachments` | read | List files attached to a request with virus-scan state; upload/download is UI-only (tools-customer.ts:294-315) |
| `list_comments` | read | List comments on a request; internal-only comments require internal access (tools-customer.ts:317-341) |
| `add_comment` | write | Comment on a request; visibility Customer or Internal (Internal rejected for customers) (tools-customer.ts:343-368) |
| `edit_comment` | write | Edit a comment you authored (customers have a limited time window) (tools-customer.ts:370-392) |
| `remove_comment` | write | Remove (redact) a comment, leaving a tombstone; reason required (tools-customer.ts:394-417) |
| `browse_ideas` | read | Browse published ideas (IDEA-###) by area and/or horizon (tools-customer.ts:419-446) |
| `get_idea` | read | Details of a published idea; merged-duplicate aliases redirect automatically (tools-customer.ts:448-468) |
| `follow_idea` | write | Toggle following an idea; optional markAsSolvesMyNeed (tools-customer.ts:470-488) |
| `view_roadmap` | read | Published roadmap grouped by horizon (Now, Next, Later, Released) (tools-customer.ts:490-509) |
| `list_releases` | read | Published releases with summary and availability (tools-customer.ts:511-525) |
| `list_notifications` | read | Your recent notifications, read/unread (tools-customer.ts:527-541) |
| `mark_notification_read` | write | Mark one notification as read (tools-customer.ts:543-557) |
| `get_notification_preferences` | read | Your delivery cadence per event type (tools-customer.ts:559-572) |
| `set_notification_preference` | write | Set a cadence (Immediate/Daily/Weekly/Off); mandatory event types must stay Immediate (tools-customer.ts:574-595) |

### Internal tools — 23 (`lib/server/chat/tools-internal.ts`) — DataCentral staff only

| Tool | R/W | One-liner |
|---|---|---|
| `list_triage_queue` | read | Requests for a chosen organization for triage; explicitly gated by `requireInternalRole` (tools-internal.ts:60-89) |
| `bulk_triage` | write, **confirmed** | Bulk-update owner/tags/triage due date for up to 100 requests (tools-internal.ts:90-131) |
| `list_internal_ideas` | read | All ideas including unpublished, with internal status, publish state, owner, score, linked request count (tools-internal.ts:132-156) |
| `create_idea` | write | New internal idea in Discovery status; not customer-visible until published (tools-internal.ts:157-177) |
| `update_idea` | write | Update wording/status/horizon/owner/rationale/etc.; editing a Published idea demotes it to Staged (tools-internal.ts:178-214) |
| `publish_idea` | write, **confirmed_safe** | Publish customer-visible wording onto the public roadmap/catalogue (tools-internal.ts:215-242) |
| `link_request_to_idea` | write | Link a DCI request to an IDEA as evidence; sets request to Linked; reason required (tools-internal.ts:243-268) |
| `move_request_link` | write | Move a request's link from one idea to another; reason required (tools-internal.ts:269-295) |
| `merge_ideas` | write, **confirmed** | Merge duplicate idea into survivor — destructive; source becomes an archived alias (tools-internal.ts:296-332) |
| `score_idea` | write | Record an ICE/RICE-style score snapshot (impact/reach/alignment/commercial/urgency 1-5, confidence 50/80/100, effort 1-13, rationale required); score computed server-side (tools-internal.ts:333-369) |
| `place_on_roadmap` | write | Place an idea at horizon Now/Next/Later, optional target quarter, confidence, publish flag (tools-internal.ts:370-397) |
| `list_external_links` | read | External reference links attached to an idea (tools-internal.ts:398-415) |
| `add_external_link` | write | Attach an https link (label + url) to an idea (tools-internal.ts:416-437) |
| `remove_external_link` | write | Remove an external link by id (tools-internal.ts:438-455) |
| `list_internal_releases` | read | All releases (REL-###) including unpublished drafts (tools-internal.ts:456-475) |
| `create_release` | write | Draft release with title, date, summary, availability, bundled idea ids (tools-internal.ts:476-499) |
| `publish_release` | write, **confirmed** | HIGH BLAST RADIUS: cascades bundled ideas to Released and notifies followers by email + in-app (tools-internal.ts:500-527) |
| `list_saved_views` | read | Your saved views plus shared internal views (tools-internal.ts:528-544) |
| `create_saved_view` | write | Save a filter set as a named view; 'Internal shared' scope requires System admin (tools-internal.ts:545-573) |
| `delete_saved_view` | write | Delete a saved view (own views; System admins any) (tools-internal.ts:574-591) |
| `analytics_summary` | read | Request volume, open count, area breakdown, service levels, notification delivery, data-quality gaps (tools-internal.ts:592-617) |
| `export_requests_csv` | read | Export authorized requests as CSV — returns row count + preview only, never the full file (tools-internal.ts:618-641) |
| `search_audit_log` | read | Search recent audit events by action/entity/actor; System admin only; max ~100 results (tools-internal.ts:642-686) |

### Admin tools — 11 (`lib/server/chat/tools-admin.ts`) — System admin only

| Tool | R/W | One-liner |
|---|---|---|
| `list_organizations` | read | All organizations with membership/request counts and auth methods (tools-admin.ts:21-42) |
| `save_organization` | write | Create or update an organization (type, status, domain, authentication methods) (tools-admin.ts:43-88) |
| `list_users` | read | All users with memberships (organization + role) (tools-admin.ts:89-111) |
| `save_user` | write | Create/update a user; WARNING: memberships array REPLACES the full set — omitted memberships are deactivated (tools-admin.ts:112-155) |
| `list_taxonomy` | read | Taxonomy values (product areas, request types, tags, strategic themes, reason categories) (tools-admin.ts:156-176) |
| `save_taxonomy` | write | Create/update a taxonomy value (tools-admin.ts:177-211) |
| `get_settings` | read | Score weights, formula version, attachment limits, retention, locale, roadmap disclaimer (tools-admin.ts:212-233) |
| `save_settings` | write | Update platform settings; scoreWeights must sum to exactly 100 and changing them bumps formulaVersion (tools-admin.ts:234-276) |
| `list_webhooks` | read | Configured webhook subscriptions (url, events, active state) (tools-admin.ts:277-296) |
| `create_webhook` | write | New webhook subscription; https only, no localhost/private addresses (tools-admin.ts:297-319) |
| `set_webhook_state` | write | Enable/disable a webhook subscription (tools-admin.ts:320-340) |

**Totals**: 24 customer + 23 internal + 11 admin = 58 registry tools (plus the chat-host-only `switch_organization`). Read/write split by `readOnly` flag: customer 13 read / 11 write; internal 8 read / 15 write; admin 5 read / 6 write.

---

## 3. Slack integration (`lib/server/slack/`, `docs/slack-setup.md`)

### Setup and activation

- Entirely optional: `startSlackAssistant()` no-ops unless **both** `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set; connection failures are logged, never thrown (lib/server/slack/socket-service.ts:29-48; docs/slack-setup.md:5). Runs over **Socket Mode** (no inbound webhook URL) (socket-service.ts:36-40; docs/slack-setup.md:42).
- The app is created from `slack-app-manifest.yaml` (repo root); bot identity **"DataCentral Pulse"**, display name **"pulse"**; scopes `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `reactions:write`, `users:read`, `users:read.email`; events `app_mention`, `message.im` (docs/slack-setup.md:9-15).
- Single-instance hosting requirement: do not scale out past one instance while Slack is configured (docs/slack-setup.md:44-48).

### DM vs @mention behavior

- Both entry points funnel into the same handler — same identity resolution, same `sendChat` brain (history, tools, permissions) (lib/server/slack/event-handler.ts:1-7, 65).
- **@mention** (`app_mention`): **always replies in a thread** rooted at the triggering message (`threadTs: event.ts`) (event-handler.ts:27-37). The `<@bot>` mention token is stripped from the text before processing (event-handler.ts:34, 88).
- **DM** (`message.im`): replies **inline**, or in-thread if the user asked inside a thread (`threadTs: m.thread_ts`) (event-handler.ts:39-50). Only human DMs are handled — bot messages, subtypes, and non-IM channels are ignored (event-handler.ts:41); mentions with no human author (bots/loops) are also ignored (event-handler.ts:28).
- While processing, the bot adds an `hourglass_flowing_sand` (⏳) reaction to the trigger message and removes it when done; reactions are best-effort (event-handler.ts:56-58, 82-85, 93; docs/slack-setup.md:40).
- On handler failure it posts: **"Something went wrong while handling your message. Please try again."** (message text is never logged — only error class + Slack user id) (event-handler.ts:67-80).

### Identity by verified email

- Identity comes **exclusively** from Slack's own user record: `users.info` (requires `users:read.email`) reads the workspace-verified `profile.email`, which is matched **exactly** against `dbo.Users.email`. Message text never influences identity (lib/server/slack/identity.ts:1-8; docs/slack-setup.md:28-30). The email lookup is cached per Slack user id for ~1 hour (identity.ts:25, 37-55).
- Exact refusal texts (identity.ts:58-63):
  - Unknown / unlinked email: **"Your Slack account isn't linked to a DataCentral Pulse user. Ask an administrator to add an account with the same email address as your Slack profile."**
  - User status not "Active": **"Your account is disabled — please contact an administrator."**
  - No active organization membership: **"Your account has no active organization membership. Ask an administrator to add you to an organization."**
- Only id/email/name are trusted from the matched row; org/role are placeholders that `getIdentityContext` and every repository re-verify (identity.ts:84-99). Active org defaults to the stored active organization, else the Internal org, else the first membership (identity.ts:103-107).
- Because Slack uses the same `sendChat` and per-user history, a Slack conversation and the in-app panel share the same chat history and the same tool permissions (event-handler.ts:65; lib/server/chat/chat-repository.ts:58-75).

### mrkdwn rendering

`toMrkdwn` converts assistant Markdown to Slack mrkdwn (lib/server/slack/mrkdwn.ts:1-43): fenced code blocks and inline code pass through untouched; in prose, `&`/`<`/`>` are escaped, `[text](url)` → `<url|text>`, `**bold**`/`__bold__` → `*bold*`, `#`–`######` headings → `*bold*`, and leading `- ` / `* ` bullets → `• `.

### Dedupe

Slack retries event deliveries, so each event is keyed (`client_msg_id`, falling back to `channel:ts`) and checked against an in-memory 15-minute dedupe window before any work happens (lib/server/slack/dedupe.ts:1-21; event-handler.ts:35, 48, 54).

---

## 4. Example prompts (grounded in real tool capabilities)

### Customer users

1. `Submit a request: exports to Excel time out for large orders` — built-in example prompt (app/chat-panel.tsx:32); triggers `find_similar` then `submit_request`.
2. `What's the status of DCI-1051?` — `get_request` (status, area, impact, owner, recent history).
3. `Show me my open requests` / `List my requests in status Needs information` — `list_my_requests` with a status filter.
4. `Is there already an idea about Excel export performance before I file a new request?` — `find_similar`.
5. `Follow IDEA-318 and mark it as solving our need` — `follow_idea` with `markAsSolvesMyNeed`.
6. `What's on the roadmap for Next?` — `view_roadmap` / `browse_ideas` by horizon.
7. `Add a comment to DCI-1051: the workaround stopped working after the last update` — `add_comment` (visibility Customer).
8. `Withdraw DCI-1062 — we solved it ourselves` — `set_request_status` (Withdrawn is the only transition customers may make).
9. `Set my notification cadence for status changes to Daily` — `set_notification_preference` (mandatory event types must remain Immediate).

### Internal users (DataCentral staff)

1. `Show the triage queue for ORG-014, only Submitted requests` — `list_triage_queue` with `organization_id` + status filter.
2. `Assign DCI-1051, DCI-1052 and DCI-1053 to me with triage due date 2026-07-20` — `bulk_triage` (assistant asks for confirmation before running).
3. `Link DCI-1051 to IDEA-318 — more evidence for the export performance work` — `link_request_to_idea` (reason required; sets the request to Linked).
4. `Score IDEA-318: impact 4, reach 3, alignment 4, commercial 3, urgency 2, confidence 80, effort 5 — big export customers keep asking` — `score_idea` (score computed server-side from weight configuration).
5. `Merge IDEA-322 into IDEA-318, they're duplicates` — `merge_ideas` (assistant explains the blast radius and asks to confirm).
6. `Publish the customer wording for IDEA-318` — `publish_idea` (assistant asks the user to confirm the wording is customer-safe first).
7. `Create a draft release for 2026-08-01 bundling IDEA-318 and IDEA-320, then publish it` — `create_release` + `publish_release` (publish requires explicit confirmation; notifies followers).
8. `How many open requests do we have, and what's our average first-response time?` — `analytics_summary`.
9. (System admin) `Add jane@contoso.is as a Requester at ORG-007` — `save_user` (assistant round-trips existing memberships via `list_users` first).

---

## Notable caveats for the guide

- Attachment upload/download is **UI-only** — the assistant can only list attachments (tools-customer.ts:296-298).
- The full CSV export is never returned in chat — row count + 20-row preview only (tools-internal.ts:620-640).
- Chat message length limit: 4000 characters per message (app/api/v1/chat/messages/route.ts:29).
- The assistant never sees tools outside the user's groups, but the real security boundary is the repository layer — a forbidden or nonexistent item always reads as "That item doesn't exist or you don't have access to it." (lib/server/chat/tool-contract.ts:67-68).
