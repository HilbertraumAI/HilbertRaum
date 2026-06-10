# UI/UX Redesign Plan — Phases 23–27 (the UI polish wave)

**Status:** working paper (doc lifecycle rule: condense to a design record when implemented).
**Source of truth for the design itself:** [`design-guidelines.md`](design-guidelines.md)
(adopted 2026-06-10). This plan only sequences the work.

**Scope:** renderer-only. No IPC contract, schema, or main-process behavior changes except
the additive `AppSettings.theme` key (Phase 23) and user-facing string updates (Phase 27).
All hard rules hold: fully offline (no web fonts/CDNs), no telemetry, Windows first-class.

**Numbering:** Phases 21 (retrieval quality, DONE) and 22 (signed update bundles, blocked on
its key-management design) belong to the functionality wave — this UI wave starts at 23.

**Test note:** run vitest from the `apps/desktop` workspace (repo-root runs break renderer
matchers).

---

## Decisions

| ID | Decision | Status |
|---|---|---|
| D-UI1 | **Adopt Radix primitives, narrowly scoped:** `@radix-ui/react-dialog`, `react-popover`, `react-dropdown-menu`, `react-tooltip` only (focus traps, dismissal, positioning are easy to get wrong by hand). Pure JS, MIT, renderer-bundled — same class as `react-markdown`. Segmented control, switch, chips, badges, banners stay hand-rolled. | PROPOSED — confirm before Phase 24 |
| D-UI2 | **Theme setting `'system' \| 'light' \| 'dark'`, default `'system'`** (resolves to light when the OS reports nothing). The pre-unlock gate cannot read settings (encrypted DB) → the gate always follows the OS theme. | PROPOSED |
| D-UI3 | **Home stays**, rebuilt as a readiness hub ("is everything ready?" at a glance). Re-evaluate after Phase 26: if it duplicates the Chat empty state, fold it in. | PROPOSED |
| D-UI4 | **Depth-mode ids stay `fast\|balanced\|deep`** everywhere in code/IPC/persistence; only UI labels change to Quick/Balanced/Thorough. No data migration. | LOCKED (cheap, zero risk) |

---

## Phase 23 — Token foundation + light/dark theming

The mechanical base everything else builds on. App looks near-identical in dark; light
theme appears for the first time.

1. **Tokens:** new `apps/desktop/src/renderer/tokens.css` (imported before `styles.css`):
   neutral/accent/semantic ramps, role tokens (`:root` = light, `[data-theme="dark"]` =
   dark overrides), type scale, spacing, radii, shadows, motion durations + `--ease`,
   font stacks — exactly guidelines §4.
2. **Restyle `styles.css` onto role tokens.** Replace the 8 legacy vars (`--bg`, `--panel`,
   `--panel-2`, `--border`, `--text`, `--muted`, `--accent`, `--good`) with role tokens;
   delete the legacy block. Fix the AA failure: `.btn.primary` fill → `--accent-600`.
3. **Global a11y baseline in CSS:** `:focus-visible` ring (outline, not box-shadow only),
   `@media (prefers-reduced-motion: reduce)` kill-switch, minimum hit-target sizes on
   buttons/toggles.
4. **Theme plumbing:** additive `AppSettings.theme` (default `'system'`, enum-guarded in
   `updateSettings` like `gpuMode`). Renderer sets `data-theme` on `<html>` from the
   resolved setting + a `matchMedia('(prefers-color-scheme: dark)')` listener.
   `WorkspaceGate` (pre-unlock) follows the OS only.
5. **Settings UI:** "Appearance" card — System / Light / Dark segmented control.

**Tests:** settings-guard unit test (`theme` rejects junk), renderer test that `data-theme`
flips with the setting. **Manual:** every screen eyeballed in both themes.
**Docs:** `user-guide.md` (appearance setting).

## Phase 24 — Shared component layer

1. Resolve **D-UI1**; if Radix approved, add the four packages (dev-time install only —
   record in the license-review habit like prior dep adds).
2. New `apps/desktop/src/renderer/components/`: `Button`, `Badge` (status pill),
   `Banner`, `Toast` (+ a tiny toast host in `App.tsx`), `ConfirmDialog`,
   `SegmentedControl`, `Switch`, `Chip`, `EmptyState`, `Progress`. States/behavior per
   guidelines §6 (focus, ARIA, 24×24 targets, primary-on-the-right dialogs).
3. Migrate the **non-chat** screens (Home, Documents, Models, Settings, Privacy,
   Diagnostics, WorkspaceGate) off ad-hoc markup onto these components. Existing browser
   `confirm()` calls (e.g. conversation delete) → `ConfirmDialog`.
4. "Copied"/"Saved" feedback → toasts.

**Tests:** component unit tests (focus trap, Esc, roving tabindex on SegmentedControl);
existing renderer tests stay green. **Docs:** none beyond guidelines (already adopted).

## Phase 25 — Chat screen restructure ⟵ the priority

Implements guidelines §3 exactly. Renderer-only; chat/RAG IPC untouched.

1. **Split `ChatScreen.tsx` (676 lines)** into `chat/` components: `ConversationList`
   (collapsible, date-grouped, hover "⋯" menu with delete → ConfirmDialog),
   `Transcript` (centered, max-width 720px, `--text-md` body), `MessageActions`
   (hover/focus row: Try again · Copy · Save), `Composer` (auto-grow textarea, single
   Send/Stop button, footer row), `SourcesDisclosure` (from `SourcePanel`).
2. **Header:** SegmentedControl "Chat | Ask my documents" + "⋯" overflow (Save this
   conversation = the old Export) + the ambient local indicator placeholder (filled in
   Phase 27).
3. **Composer footer:** "Answer detail ▾" dropdown (Quick/Balanced/Thorough; Deep/Thorough
   hidden when the model lacks thinking support — current behavior preserved) and, in
   documents mode, "📄 Using N documents ▾" popover replacing the scope-chip row.
4. **Remove** the dismissible doc-hint banner; **add** the teaching empty state (example
   prompt chips; "Add documents to ask about them" nudge via the existing `navigate()`).
5. **Streaming:** collapsed inline "Thinking…" line (expand → reasoning; auto-collapse on
   first answer token), token buffering against layout thrash, ARIA live region, Stop
   reachable by keyboard.
6. Conversation-list collapse state remembered (localStorage — UI preference, not user
   data).

**Tests:** update `tests/renderer/ChatHomeNav` + chat renderer tests; new tests for empty
state, scope popover, per-message actions, mode segmented control. **Docs:**
`user-guide.md` chat section rewrite.

## Phase 26 — Information architecture regroup

1. **Nav 7 → 5** in `App.tsx`: Home · Chat · Documents · AI Model ‖ Settings.
   `SettingsScreen` becomes tabbed: General / Privacy & data (absorbs `PrivacyScreen`) /
   Diagnostics (absorbs `DiagnosticsScreen`, visually quieter). `navigate()` gains virtual
   targets (`'settings:privacy'`, `'settings:diagnostics'`) so existing entry points
   (offline badge, banners) keep working.
2. **Home rebuild:** readiness hub — workspace state, model running?, document count, one
   primary "Start chatting", quiet preflight warnings. (D-UI3 re-evaluation point.)
3. **Models → "AI Model":** active model first with plain-language size/speed hint,
   friendly picker, checksums/quantization/paths behind a "Technical details" disclosure;
   verify/download flows unchanged underneath.

**Tests:** nav/renderer tests updated; settings-tab routing test. **Docs:**
`user-guide.md`, `architecture.md` (screen list).

## Phase 27 — Microcopy, ambient trust signal, first-run

1. **Copy sweep** per guidelines §7 across renderer + user-facing main-process strings
   (error paths, runtime notices; `COMPATIBILITY_MODE_NOTICE` already matches the tone).
   Error codes stay visible only inside Diagnostics.
2. **Ambient indicator:** evolve the sidebar offline badge into the header "Local ·
   Offline" signal with the reassurance popover; honest variant while downloads are
   enabled ("Downloads allowed — chats and documents stay local").
3. **First-run (WorkspaceGate, create path only):** 3 steps — welcome/trust framing →
   create password (add show-password toggle + strength meter; paste/password managers
   must work — verify nothing blocks them) → optional "first model/documents" step that
   only renders when no model is installed and keeps every existing download gate
   (policy ∧ setting ∧ per-download confirmation). Unlock path stays a single calm screen.
4. **Final WCAG 2.2 AA sweep** (guidelines §9): contrast audit of every token use,
   full-keyboard pass, Windows High Contrast Mode check, reduced-motion check.

**Tests:** gate renderer tests (steps, paste, strength hint), copy-string tests where
asserted today. **Docs:** `user-guide.md` first-run section; close this plan out into a
design record per the doc lifecycle rule.

---

## Risks

- **No visual regression harness** — restyling 587 lines of CSS can silently break a
  screen. Mitigation: per-phase manual eyeball of all screens in both themes (the per-phase
  "app still launches" ritual, widened), keep phases small.
- **Renderer test churn** in Phase 23 — the chat tests assert today's DOM. Budget time to
  rewrite them against the new structure, not to patch selectors.
- **Radix dep (D-UI1)** — four new renderer deps need the usual license/offline review;
  if rejected, ConfirmDialog/popovers are hand-rolled in Phase 22 (+ ~1 phase of effort
  and a11y risk).
- **Light theme is net-new surface** — semantic colors (badges, warnings) have only ever
  been seen on dark; Phase 21's manual pass must check every badge/banner state on light.
