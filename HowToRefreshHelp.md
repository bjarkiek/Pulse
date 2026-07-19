# How to refresh the Help site (/help)

A runbook for regenerating the Pulse help/user-manual after changes. Hand this
file to the assistant and say "refresh the help per HowToRefreshHelp.md" — it
contains everything needed, including the gotchas discovered when it was built.

## What the help system is

The `/help` page is **generated from the tour catalog at request time** — the
chapter list, step titles/descriptions, action lines, step counts, audience
gating and both languages all come from code. The only artifacts that go stale
are the **screenshots** and the **chapter intro texts**.

| Piece | File | Refresh needed when… |
| --- | --- | --- |
| Tour catalog (steps, anchors, en/is strings) | `lib/server/tour-catalog.ts` | you change tours — this IS the manual's content |
| Help page (layout, intros, about/admin-extra prose) | `app/help/route.ts` | a NEW tour needs a `CHAPTER_INTROS` entry; feature behavior described in the static prose changed |
| Manual split / audience gating | `getHelpData` in `lib/server/tour-repository.ts` | never, unless audience semantics change (All/Customers → user manual, Internal/SystemAdmins → admin manual) |
| Screenshots | `public/help/*.png` | tours changed, UI changed visibly, or anchors moved — **recapture** |
| Capture script | `scripts/capture-help-screenshots.mjs` | rarely; see contract below |
| Entry links | sidebar "Help" item + "📖 Open the help pages" in the ? menu (`app/page.tsx`, `app/tour-host.tsx`), "Open the admin manual" in the Settings onboarding card | never, unless menus are restructured |

Screenshot naming contract (the route derives `<img>` URLs from it — do not
rename): `public/help/{tourKey}-step-{N}.png` (N is 1-based) plus
`public/help/help-menu.png` (the ? menu open).

## Refresh procedure

### 1. Sync content

- If tours were added/changed: the manual picks up steps automatically from
  `lib/server/tour-catalog.ts`. For a **new tour**, add a matching entry to
  `CHAPTER_INTROS` in `app/help/route.ts` (en + is, one narration-style opener).
- If the changed behavior is described in the static prose ("The help system in
  one minute", "Administering onboarding" / `adminExtra`), update those strings
  in `app/help/route.ts` (both languages).
- Rule from the tour kit: any step whose anchor lives inside a conditionally
  rendered container (modal/drawer) must carry a pseudo-`route` that the
  TourHost glue can map to "open that container" — see `/compose` →
  `setComposerOpen(true)` in `app/page.tsx`. Without it, resume/deep-link into
  that step stalls silently AND its screenshot capture fails.

### 2. Recapture screenshots

Prereqs (already in the repo): `playwright` devDependency + Chromium
(`npx playwright install chromium` if this machine never ran it).

```bash
# 1. Fresh dev server in memory mode — REQUIRED, memory state must be clean so
#    the help-menu screenshot shows tours as not-started
#    (kill any running one first; the demo identity is a System admin and the
#    master switch defaults ON, so all four tours are capturable)
npm run dev

# 2. In another terminal:
npm run help:screenshots        # → node scripts/capture-help-screenshots.mjs
```

The script drives the **real Driver.js tours**: for every tour step it calls
`tourEngine.start(key, step)`, waits for the spotlight + popover, screenshots at
1440×900 @2x. It is side-effect free and screenshot-safe by construction:

- progress POSTs are blocked twice (network route abort + a `fetch` patch), so
  capturing never writes tour progress;
- the Next dev-overlay badge and the resume chip are hidden via injected CSS
  (the badge sits exactly over the ? button bottom-left and broke clicks).

Expected output: one line per step (currently 22 steps / 4 tours) plus
`help-menu`, ending `Done → …\public\help`. If it says "No tours in state",
the master switch is off or a tour was disabled — fix in Settings → Onboarding
(or restart the server to reset memory settings) and rerun.

### 3. Spot-check (do not skip)

Open 3–4 of the new PNGs and verify: spotlight on the right element, popover
text matches the catalog, **no dev-overlay badge**, no resume chip, and for
`submit-request-step-2..4` the composer modal is open. Then load
`http://localhost:3000/help` and `…/help?lang=is` and check images render and
chapters match the catalog.

### 4. Verify

```bash
npm test          # includes tests/tours.test.ts: /help audience gating
npm run lint && npm run build
```

If tour keys/audiences changed, update the assertions in `tests/tours.test.ts`
(they reference the keys `welcome`, `submit-request`, `team-workspace`,
`admin-settings` and assert customers never receive admin chapters — keep that
guarantee).

## Known quirks (not bugs — don't chase them)

- **A `welcome: InProgress` row appears in memory after a dev-server restart**
  even though the capture script writes nothing: any open browser tab
  auto-reloads when the dev server comes back, and the welcome tour auto-starts
  in it. Harmless; restart the server if you need a pristine help-menu shot and
  close other tabs first.
- The build prints pre-existing `instrumentation.ts` Edge-runtime warnings
  ("Ecmascript file had an error" then "Compiled successfully") — unrelated to
  the help system.
- Screenshots are English: memory mode resolves every user's locale to `en`.
  The Icelandic manual (`?lang=is`) intentionally reuses them.
- Screenshots are committed binaries (~300 KB each @2x). Recapture replaces
  them in place; commit them with the content change that motivated the
  refresh.

## Definition of done

- [ ] Every catalog tour has a chapter with matching step count on `/help`
- [ ] New tours have `CHAPTER_INTROS` entries (en + is)
- [ ] `public/help/` has `{key}-step-{N}.png` for every step + `help-menu.png`, all freshly captured and spot-checked
- [ ] `/help` and `/help?lang=is` render with no broken images
- [ ] Customer sessions get no admin chapters (test passes)
- [ ] `npm test`, `npm run lint`, `npm run build` green
