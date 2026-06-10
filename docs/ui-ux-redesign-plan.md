# UI polish wave (Phases 23–27) — design record

_Status: **IMPLEMENTED** (Phases 23–27, 2026-06-10, branch `ui-phase-23-tokens-theming`).
This is the **condensed design record** per the doc lifecycle rule: the decisions, the facts
they rest on, and the UI as built. The durable design reference — tokens, layout, components,
voice, accessibility — is [`design-guidelines.md`](design-guidelines.md) (ADOPTED); this
record only captures the rollout decisions and as-built deviations. The full original phased
plan lives in git history — see "History" at the end._

---

## 1. Decisions (all resolved)

| ID | Decision | Outcome |
|---|---|---|
| D-UI1 | **Radix primitives, narrowly scoped** — `react-dialog@1.1.16`, `react-popover@1.1.16`, `react-dropdown-menu@2.1.17`, `react-tooltip@1.2.9`, pinned exact; 42 transitive packages license-reviewed (all MIT/pure-JS/no install scripts). Segmented control, switch, chips, badges, banners stay hand-rolled. | **EXECUTED** — Dialog (Phase 24), Popover + DropdownMenu (Phase 25), Tooltip (Phase 27, the ambient indicator). |
| D-UI2 | Theme setting `'system' \| 'light' \| 'dark'`, default `'system'`. The pre-unlock gate cannot read settings (encrypted DB) → **the gate always follows the OS theme**. | **IMPLEMENTED** as written (Phase 23; `renderer/theme.ts`). |
| D-UI3 | **Home stays**, rebuilt as the readiness hub. Re-evaluated after Phase 26: it does NOT duplicate the Chat empty state (Chat teaches *what to ask*; Home answers *is the system ready*), and the Phase-27 first-run flow did not absorb its remediation duties (the starter step only routes; Home keeps live status + preflight). | **RESOLVED — Home stays.** |
| D-UI4 | Depth-mode ids stay `fast\|balanced\|deep` in code/IPC/persistence; only UI labels are Quick/Balanced/Thorough. No data migration. | **EXECUTED** (Phase 25 `DepthMenu`; tests pin the label↔id mapping). |

## 2. Facts the wave rests on

- **Renderer-only, with two scoped exceptions:** the additive `AppSettings.theme` key
  (Phase 23) and user-facing main-process **string literals** (Phase 27 copy sweep — error
  messages/notices only, no logic/IPC/schema changes). All hard rules held: fully offline
  (no web fonts/CDNs — system font stacks per guidelines §4.4), no telemetry, Windows
  first-class.
- **Run vitest from `apps/desktop`** — repo-root runs break the renderer matchers.
- The old accent `#4f8cff` as a filled-button background fails AA (3.22:1); filled controls
  use `--accent-600 #2f6fed` (4.55:1) in both themes (guidelines §4.2).
- `listModels` needs an unlocked workspace, so the first-run "is a model installed?" check
  runs **after** create succeeds, before handing off to the shell.

## 3. As built, per phase

- **Phase 23 — tokens + theming.** `renderer/tokens.css` (ramps theme-constant; role tokens
  per theme: `:root` = light, `[data-theme="dark"]` = dark), full `styles.css` restyle onto
  role tokens, global a11y baseline (`:focus-visible` outline ring, reduced-motion
  kill-switch, ≥24px hit targets), additive enum-guarded `AppSettings.theme` + the Settings
  Appearance card. Components never theme-check.
- **Phase 24 — shared components.** `renderer/components/`: Button / Badge / Banner /
  Toast(+host) / Modal / ConfirmDialog / SegmentedControl / Switch / Chip / EmptyState /
  Progress per guidelines §6; every non-chat screen + the WorkspaceGate migrated; "Saved"
  feedback via polite-live-region toasts; last browser `confirm()` removed.
- **Phase 25 — chat restructure (the priority).** `ChatScreen` split into `renderer/chat/`
  per guidelines §3: collapsible date-grouped ConversationList (hover "⋯" + ConfirmDialog),
  centered 720px Transcript with per-message Try again · Copy · Save and the inline
  "▸ Sources (N)" disclosure, header SegmentedControl + "⋯" overflow, composer-footer
  "Answer detail" dropdown + documents-scope popover, teaching empty state, buffered
  streaming with the auto-collapsing Thinking… line.
- **Phase 26 — IA regroup.** Nav 7→5 (Home · Chat · Documents · **AI Model** ‖ Settings);
  Privacy + Diagnostics became Settings tabs; `renderer/navigation.ts` `resolveNavTarget`
  with virtual `settings:*` targets + legacy `privacy`/`diagnostics` aliases; Home rebuilt
  as the readiness hub; AI Model screen with per-card "Technical details" disclosure.
- **Phase 27 — microcopy, ambient signal, first-run (closed the wave).**
  - *Copy sweep* (guidelines §7) across renderer + user-facing main-process strings: the
    stale "Models screen" errors, `NO_DOCUMENT_CONTEXT_ANSWER` (persisted — reword affects
    future answers only), the wrong-password message ("That password didn't unlock your
    workspace…"), start-refusal messages (checksum state code → "we couldn't verify its
    file"), Documents ingestion labels (Waiting/Reading/Preparing/Ready), benchmark
    "Fast Mode" leftover. A `tests/unit/copy-tone.test.ts` guard pins the tone and scans
    string literals for stale phrases.
  - *Ambient indicator:* `components/LocalIndicator.tsx` (Radix **Tooltip**) — quiet
    "🔒 Local · Offline" in the sidebar (replacing the offline badge; state passed live by
    App) and the chat header (self-fetching). Hover/focus = reassurance line; click =
    `settings:privacy`. Honest variant while downloads are enabled: "Local · Downloads
    allowed" / "Downloads allowed — chats and documents stay local."
  - *First-run (create path only):* 3 full-window steps in `WorkspaceGate` — welcome/trust
    framing → create password (hand-rolled advisory strength meter that never blocks; only
    the 8-char floor + confirm-match gate submission; Show/Hide toggle; paste + password
    managers work, WCAG 3.3.8; the one honest "can't be recovered" line) → optional starter
    step rendered only when no chat model is installed (it **routes** to AI Model /
    Documents — every download gate lives unchanged on the AI Model screen). Skippable;
    ends on Chat. `onUnlocked(state, landOn?)` lets App land on chat/models/documents;
    plain unlock stays a single calm screen and keeps the current screen.
  - *WCAG 2.2 AA sweep:* every role-token pairing contrast-computed in both themes — one
    real failure fixed (`--border-strong` 2.5:1/2.2:1 → `--n-500`, 4.77:1 light / 3.65:1
    dark; ramp value, no new hex); forced-colors (Windows High Contrast) rules for the
    Switch + strength meter; reduced-motion verified. Accepted items recorded in
    [`known-limitations.md`](known-limitations.md) §Accessibility.
  - *Found by the eyeball walk:* in the production rollup bundle a second tree-shaken copy
    of `workspace-vault` made `instanceof WrongPasswordError` fail, so the friendly
    wrong-password message was unreachable in the built app (vitest runs unbundled and
    never saw it). The handler now also matches `err.name`; the bundler quirk is recorded
    in `known-limitations.md`.

## 4. Verification pattern (kept for future UI work)

Each phase: `npm run typecheck` + full vitest from `apps/desktop` + `npm run build`, plus a
scripted Playwright `_electron` screenshot walk of every touched screen in BOTH themes
(workspace `%TEMP%\paid-eyeball`, per-phase `walk-phaseNN.mjs`; strip `ELECTRON_RUN_AS_NODE`,
clear localStorage after the first window, `emulateMedia` for theme/reduced-motion; write a
`config/policy.json` with `encryption_required: true` to exercise the gate). Suite grew
644 → 669 tests (+6 manual skips) over the wave.

## History

The full original plan (per-phase work lists, risks, test plans) is in git history:
`git log --follow docs/ui-ux-redesign-plan.md`; last full version before condensation:
`git show d2ecf5a:docs/ui-ux-redesign-plan.md`.
