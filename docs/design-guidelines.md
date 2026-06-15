# Design & UI/UX Guidelines — HilbertRaum

**Status:** ADOPTED 2026-06-10. Source: external design research (Claude web, 2026-06-10),
reviewed and adapted to this repo's constraints — adaptations are marked **[adapted]**.
This is the durable reference for all UI work. The UI polish wave (Phases 23–27) that rolled
these guidelines out is IMPLEMENTED; its condensed design record (decisions D-UI1–D-UI4,
load-bearing facts, as-built notes, verification pattern) is **§11** of this document.

**Goal:** make the app feel as calm and trustworthy as a well-made consumer privacy app
(1Password/Proton posture), not a hobbyist AI tool — and de-clutter the chat screen.
Audience: non-technical professionals (lawyers, doctors, accountants, consultants, HR).

---

## 1. Design principles

1. **Calm over clever.** Generous whitespace, one primary action per screen, muted color
   used only to signal meaning. Never decorative gradients, animated buttons, or kinetic type.
2. **Privacy is the ambient state, not a warning.** A quiet, persistent "Local · Offline"
   indicator that reads as reassuring. Never red alarm banners, lock icons everywhere, or
   scare copy.
3. **Speak human, hide the machinery.** "Ask my documents", "Answer detail", "AI model",
   "verifying files". Never checksums, GPU backends, or build hashes in the everyday path
   (Diagnostics / "Technical details" disclosures only).
4. **Progressive disclosure by default.** Depth modes, model internals, and scope management
   live one click away, not on the canvas. Never hide what's needed for the core task
   (ask a question, get a cited answer).
5. **Legibility is non-negotiable.** High-contrast text, 15–16px body, restrained
   translucency. Never glassmorphism / backdrop-blur behind text.
6. **Familiar Windows-grade conventions.** Standard focus rings, right-click where expected,
   primary dialog button on the right. Never mobile gestures, hamburger menus, novel nav.
7. **Quietly accountable.** Citations on every document-grounded answer and honest
   "I couldn't find this in your documents" states (already implemented — keep). Never
   confident answers without provenance.

---

## 2. Information architecture

Collapse 7 nav destinations into 4 primary + 1 utility:

- **Top group (everyday):** Home (genuine status hub: ready? model running? doc count? one
  big "Start chatting") · Chat · Documents · **AI Model** (reframed from "Models" — singular
  mental model; checksums/quantization behind a "Technical details" disclosure).
- **Bottom group (utility):** **Settings**, with **Privacy and Diagnostics folded in as
  sub-pages/tabs** ("Privacy & data", "Diagnostics (advanced)"). Privacy is a posture
  expressed everywhere, not a destination; Diagnostics is a support surface.

**First-run:** 3-step guided setup, full-window, no nav rail yet:
1. Welcome + trust framing ("Everything stays on this drive. No internet, no account.")
2. Create your password — **must allow paste / password managers** (WCAG 3.3.8), strength
   meter, show-password toggle, one honest "can't be recovered" warning.
3. First model + first documents — **[adapted]** on a commercial drive models are
   preinstalled, so this step only appears when no model is installed, and any download
   offer stays behind the existing triple gate (policy ∧ network setting ∧ per-download
   confirmation). Skippable; ends on the teaching Chat empty state.

---

## 3. Chat screen layout (the priority)

The canvas is the *conversation*. Everything else is (a) a quiet persistent affordance,
(b) an inline element attached to a message, or (c) progressively disclosed.

```
┌──────┬────────────────┬───────────────────────────────────────────────┐
│ NAV  │ CONVERSATIONS  │  [ Chat | Ask my documents ]      🔒 Local    │
│      │ + New chat     │ ┌───────────────────────────────────────────┐ │
│ Home │ ── Today ──    │ │  transcript, centered, max-width 720px    │ │
│ Chat │ · Contract…    │ │                                           │ │
│ Docs │ · Q3 figures   │ │  ┌ assistant answer ────────────────────┐ │ │
│ Model│ ── Earlier ──  │ │  │ …answer text…                        │ │ │
│      │ · Lease notes  │ │  │ ▸ Sources (3)                        │ │ │
│ ──── │                │ │  └──────────────────────────────────────┘ │ │
│ Set. │ (collapsible)  │ │   ↺ Try again · Copy · Save (hover/focus) │ │
│      │                │ └───────────────────────────────────────────┘ │
│      │                │ ┌───────────────────────────────────────────┐ │
│      │                │ │ Message…                            [ ➤ ] │ │
│      │                │ │ 📄 Using 3 documents · Detail: Balanced ▾ │ │
│      │                │ └───────────────────────────────────────────┘ │
└──────┴────────────────┴───────────────────────────────────────────────┘
```

Where each existing control goes:

| Control | Placement |
|---|---|
| Mode tabs | One **segmented control in the header**: "Chat \| Ask my documents". Always visible. |
| Conversation history | **Collapsible** second column; date-grouped; delete via hover "⋯" menu + right-click, never permanent ✕ buttons. Remembers collapsed state. |
| Depth selector | **"Answer detail"** — quiet dropdown in the composer footer (Quick · Balanced · Thorough). Defaults Balanced; not a prominent 3-way toggle. |
| Scope chips | Single composer-footer affordance "📄 Using 3 documents ▾" → popover to add/remove. Only in documents mode. |
| Doc-awareness hint banner | **Deleted.** Replaced by the teaching empty state + mode control. |
| Thinking block | Single inline collapsed "Thinking…" line while generating (expand → the live reasoning text); auto-collapses when the answer streams. Stop stays available. ARIA live region for streaming. |
| Citations | Inline, attached to the answer: "▸ Sources (3)" → source cards (name + page + snippet). No separate panel. |
| Regenerate / Copy / Export | **Per-message action row** on hover/focus of an assistant answer ("Try again", "Copy", "Save"). Whole-conversation export → chat-header "⋯" overflow. |
| Errors / notices | Inline, in context, dismissible, rare. Never stacked at the top. |

**Empty state that teaches:** one friendly line ("Ask a question, or ask about your
documents."), 3–4 example prompt chips ("Summarize this contract", "What are the payment
terms?", "Find every mention of 'indemnity'") that fill the composer; if no documents yet,
an inline nudge button "Add documents to ask about them" → Documents.

---

## 4. Design tokens

Two themes, same scales. All text/UI pairs contrast-checked (ratios noted).

### 4.1 Neutrals (shared ramp)

| Token | Hex | | Token | Hex |
|---|---|---|---|---|
| `--n-0` | `#ffffff` | | `--n-600` | `#4d5563` |
| `--n-50` | `#f7f8fa` | | `--n-700` | `#353b46` |
| `--n-100` | `#eef0f4` | | `--n-800` | `#232830` |
| `--n-200` | `#e2e5ea` | | `--n-850` | `#1b1f27` |
| `--n-300` | `#d7dce3` | | `--n-900` | `#171a21` |
| `--n-400` | `#9aa3b2` | | `--n-950` | `#0f1115` |
| `--n-500` | `#6b7383` | | | |

### 4.2 Accent + semantic ramps

| Token | Hex | Use |
|---|---|---|
| `--accent-700` | `#2257c9` | link text on light; pressed fill |
| `--accent-600` | `#2f6fed` | **primary button fill** (white text = 4.55:1 ✓) |
| `--accent-500` | `#4f8cff` | accent/link on dark; focus ring |
| `--accent-300` | `#8fb4ff` | subtle accent backgrounds |
| `--success-600` | `#1a7f4b` | success text on light (5.0:1) |
| `--success-500` | `#3fbf7f` | success on dark (8.1:1) |
| `--error-600` | `#c0362c` | error text on light (5.5:1) |
| `--error-500` | `#ff6b6b` | error on dark (6.8:1) |
| `--warning-700` | `#8a5a00` | warning text on light (5.9:1) |
| `--warning-500` | `#e0b341` | warning on dark (9.6:1) |

✅ **Contrast fix (applied):** `#4f8cff` as a button fill with white text was **3.22:1 — fails AA**,
so filled buttons now use `--accent-600 #2f6fed` (4.55:1) and `#4f8cff` is reserved for
links/icons/focus on dark. Semantic color always pairs with a label or icon (WCAG 1.4.1).

### 4.3 Role tokens per theme

Implement as `:root` (light) + `[data-theme="dark"]` overriding role tokens only; ramps stay
constant.

| Role | Light | Dark |
|---|---|---|
| `--bg` | `#f7f8fa` | `#0f1115` |
| `--surface` | `#ffffff` | `#171a21` |
| `--surface-2` | `#ffffff` + shadow | `#1d212a` |
| `--border` (hairline) | `#e2e5ea` | `#2a2f3a` |
| `--border-strong` (inputs) | `#9aa3b2` | `#4a515f` |
| `--text` | `#1b1f27` (16.5:1) | `#e6e8ec` (15.4:1) |
| `--text-muted` | `#5c6675` (5.8:1) | `#9aa3b2` (7.4:1) |
| `--link` | `#2257c9` (6.4:1) | `#4f8cff` (5.9:1) |
| `--focus` | `#2f6fed` | `#4f8cff` |

### 4.4 Typography

No web fonts (offline). Bundled system stacks:

```css
--font-sans: -apple-system, "Segoe UI Variable", "Segoe UI", system-ui,
             Roboto, "Helvetica Neue", Arial, sans-serif;
--font-mono: "Cascadia Code", "SF Mono", Consolas, "Liberation Mono", monospace;
```

| Token | Size / line / weight | Use |
|---|---|---|
| `--text-xs` | 12 / 16 / 500 | metadata, captions, badges |
| `--text-sm` | 13 / 18 / 400 | secondary UI, table cells |
| `--text-base` | 15 / 24 / 400 | **default UI text** |
| `--text-md` | 16 / 26 / 400 | **chat body / document reading** |
| `--text-lg` | 18 / 26 / 600 | card titles, section heads |
| `--text-xl` | 22 / 30 / 600 | screen titles |
| `--text-2xl` | 28 / 36 / 700 | first-run / hero |

Nothing below 12px. Numbers and file names in mono; everything else sans.

### 4.5 Spacing, radius, elevation, motion

- **Spacing (4px base):** `--space-1..8` = 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64.
  Component padding `--space-3/4`; card padding `--space-5`; section gaps `--space-6`;
  screen gutters `--space-6/7`.
- **Radius:** `--radius-sm 6px` (inputs/chips/badges) · `--radius-md 10px` (buttons/cards) ·
  `--radius-lg 14px` (modals) · `--radius-full 999px` (status pills).
- **Elevation (soft depth, never blur behind text):**
  `--shadow-1: 0 1px 2px rgba(15,17,21,.06), 0 1px 1px rgba(15,17,21,.04)` (cards) ·
  `--shadow-2: 0 4px 12px rgba(15,17,21,.10)` (popovers) ·
  `--shadow-3: 0 16px 40px rgba(15,17,21,.18)` (modals).
  In dark theme lean on `--surface-2` lightening + borders; shadows read weakly on dark.
- **Motion:** `--dur-fast 120ms` (hovers) · `--dur-base 200ms` (dropdowns) ·
  `--dur-slow 320ms` (modals) · `--ease: cubic-bezier(.2,.8,.2,1)`. All non-essential
  motion behind `@media (prefers-reduced-motion: reduce)`.

---

## 5. Theme default: light, follow OS, manual override

Default to **light**, follow `prefers-color-scheme` on first run, persist an explicit user
choice (`system | light | dark` setting). Evidence: positive contrast polarity reads
faster/comprehends better and the advantage grows at smaller sizes (NN/g); light reads
"clean, professional, trustworthy" to office users; preference splits ~thirds so both ship.
The current dark palette survives as the dark theme (lightly tuned per §4.3).

---

## 6. Component guidelines

- **Buttons.** Three levels only: Primary (`--accent-600` fill, white text — **one per
  view**), Secondary (surface + `--border-strong` outline), Ghost (text only). Focus =
  2px `--focus` ring with 2px offset via `:focus-visible`. Min height 36px; hit targets
  ≥24×24 (WCAG 2.5.8). Disabled = 50% opacity.
- **Inputs / composer.** Surface fill, 1px `--border-strong`, `--radius-sm`, 36–40px min
  height. Composer auto-grows; Enter = send, Shift+Enter = newline. Never remove the focus
  outline.
- **Cards.** `--surface`, `--shadow-1`, `--radius-md`, `--space-5` padding. No nested cards.
- **Badges / status pills.** `--radius-full`, `--text-xs` 500, icon + word, three tones
  (neutral / success / warning-error). Never color-only dots.
- **Tabs / segmented control.** Pill track; selected segment gets `--surface` + `--shadow-1`.
  Roving tabindex + arrow keys.
- **Banners & toasts.** Banner = persistent, in-context, semantic left border + icon + text
  + optional action. Toast = transient confirmation (3–5s, polite ARIA live) for
  "Copied" / "Saved". Never toasts for actionable errors; never stacked top banners.
- **Modals.** `--shadow-3`, `--radius-lg`, max ~480px (confirm) / 640px (form). Focus trap,
  Esc closes, focus returns to trigger, primary button on the right. Destructive confirms
  and first-run only.
- **Chips.** `--radius-sm`, `--text-sm`; ✕ on hover/focus only. Example prompts + doc scope
  (in popover). Never permanent chip rows on the canvas.
- **Progress / streaming.** Determinate bars with plain labels ("Preparing 12 of 30…").
  Streaming = calm caret/pulse + "Thinking…" line; never a full-screen spinner; no
  unlabeled spinners on long operations.
- **Empty states.** Friendly headline + one line + one primary action (+ example chips in
  Chat). Used on Chat, Documents, AI Model.
- **Lists / tables.** Rows ≥40px, hover highlight, hover "⋯" + right-click for actions.
  Technical columns visually secondary.
- **Toggles.** Switch for binary settings (track `--accent-600` when on), checkbox for
  multi-select; 24×24 min target; clickable label; focus ring.

---

## 7. Voice & microcopy

Plain, calm, second person, present tense. Describe the problem and the next step; error
codes only in Diagnostics. No exclamation marks or humor in failure states. No jargon in
the everyday path.

| Before | After |
|---|---|
| "Ask Documents" | "Ask my documents" |
| "Fast / Balanced / Deep" | "Answer detail: Quick · Balanced · Thorough" |
| "Checksum verification failed." | "We couldn't verify this file — it may be incomplete. Try downloading it again." |
| "GPU acceleration auto-disabled." | "Running in standard mode for compatibility. Answers may be a little slower." |
| "Model failed to load (exit code 1)." | "That AI model couldn't start. Try restarting the app, or pick another model." |
| "Quantization: Q4_K_M" | "Balanced — works well on most laptops" (full label under "Technical details") |
| "Workspace decryption error." | "That password didn't unlock your workspace. Check it and try again." |
| "Embedding documents…" | "Preparing your documents so you can ask about them…" |
| "0 results returned for query." | "I didn't find a match. Try rephrasing, or check which documents you're asking about." |
| "Stop generation." | "Stop" |
| "Export conversation to .md" | "Save this conversation" |
| "Regenerate response" | "Try again" |
| "Telemetry disabled." | "Nothing leaves this drive. There's no tracking to turn off." |

**Ambient privacy signal:** small persistent status in the chat header / status bar —
subtle lock/shield glyph + "Local · Offline", neutral color. Hover/click popover:
"Everything stays on this drive. No internet connection is used."
**[adapted]** This evolves the existing sidebar offline badge; when the user has enabled
network for model downloads it must say so honestly (e.g. "Downloads allowed — chats and
documents stay local").

### German microcopy (D-L7, Phases 39–42 — `architecture.md` i18n record)

Everything above applies to the German copy too — **adapted, never translated literally**.
The spec-§11.4 rule ("never 'your hardware is bad'") binds the German rendering of every
warning and error: carry the same calm reassurance, not a word-for-word transfer
(e.g. "Pick a smaller model — quality stays great" → „Wähle ein kleineres Modell — die
Qualität bleibt top.").

- **Form of address: informal „du“** (user decision 2026-06-13 — a deliberate brand
  choice; modern consumer-software tone). Lowercase „du/dein“ mid-sentence, consistently —
  including errors and the gate. Imperatives use the colloquial short form where idiomatic
  („versuch“, „prüf“, „stell sicher“); verbs that need the -e keep it
  („öffne“, „wähle“, „indexiere“).
- **Glossary** (pinned as the comment block on top of `de.ts` — keep terms consistent
  across ALL German copy): workspace → Arbeitsbereich · drive → Laufwerk ·
  vault/encrypted workspace → verschlüsselter Arbeitsbereich · model → Modell (AI model →
  KI-Modell) · document → Dokument · re-index → neu indexieren · offline → offline ·
  "Ask my documents" → „Meine Dokumente fragen“ · lock/unlock → sperren/entsperren ·
  password → Passwort · settings → Einstellungen · plaintext (developer) mode →
  unverschlüsselt (Entwickler).
- **Screen-name references** match the German nav labels: KI-Modell-Bereich,
  Dokumente-Bereich, „in den Einstellungen“. A string that names a button quotes the
  button's exact German label („Neu indexieren“, „Durchsuchbar machen (OCR)“).
- **Typography:** German quotation marks „…“ (and ’ for apostrophes); German
  decimal/date conventions come from passing the resolved locale to
  `toLocaleString`/`Intl.NumberFormat`, never from hand-formatting.
- **Untranslated by design:** the product name / "Lite" brand line, language names in the
  picker, technical values (model ids, paths, profile codes, "llama.cpp <version>").
- **Text expansion is a layout problem:** German runs ~30 % longer — fix overflows with
  wrapping/min-widths/flex (the Phase-42 audit pattern: chat-header `flex-wrap`,
  empty-state chips wrap, `overflow-wrap: anywhere` on `.kv dd`), never by abbreviating
  copy.

---

## 8. What to avoid

Glassmorphism / blur behind text · expressive 2026 fads (jelly buttons, kinetic type, neon
gradients) · enterprise dashboard sprawl (nested cards, KPI tiles, equal-weight technical
readouts) · jargon in the everyday path · dark-only · security theater (red locks, WARNING
caps) · removed focus indicators, sub-24px targets, color-only status · permanent control
clutter on the chat canvas · heavy component frameworks (full MUI/Ant). Headless **Radix
primitives** (Dialog, Popover, DropdownMenu, Tabs, Switch, Tooltip) are the acceptable
amount of help — pure-JS, MIT, renderer-bundled like `react-markdown` **[adapted:
see plan, decision D-UI1]**.

---

## 9. Accessibility checklist (WCAG 2.2 AA)

- Text ≥ 4.5:1; large text + UI boundaries/icons ≥ 3:1 (token tables carry the ratios).
- Visible focus on everything (`:focus-visible`, ≥2px, ≥3:1); include an `outline` (not
  just `box-shadow`) so Windows High Contrast Mode keeps it.
- Sticky headers/composer must not obscure the focused element (2.4.11).
- Targets ≥ 24×24 CSS px; 36px+ for primary controls (2.5.8).
- Any drag interaction needs a non-drag path (2.5.7).
- Password gate allows paste and password managers (3.3.8).
- Honor `prefers-reduced-motion` everywhere.
- Streaming announced via ARIA live regions; keyboard users can Stop.
- Never color alone for status (1.4.1).

---

## 10. Sources

Key sources from the 2026-06-10 research round (full list in the research output,
`git log` this file's introduction commit): NN/g dark-vs-light-mode and error-message
guidelines; WCAG 2.2 AA criteria summaries (focus appearance 2.4.11, target size 2.5.8,
accessible auth 3.3.8); Apple's Liquid Glass legibility walk-back coverage; 2026 UI-trend
surveys (UXPin, Tubik, Envato) converging on calm/reduced-load UI; AI-chat UI pattern
write-ups (progressive disclosure, inline expandable citations, streaming states);
Proton/1Password trust-aesthetic comparisons.

---

## 11. Rollout record — UI polish wave (Phases 23–27, IMPLEMENTED 2026-06-10)

_The wave shipped on branch `ui-phase-23-tokens-theming`, merged to master 2026-06-10. This
section is the wave's condensed design record per the CLAUDE.md doc lifecycle rule (formerly
the separate `docs/ui-ux-redesign-plan.md`, folded in here during the 2026-06-12 docs
housekeeping; the full original phased plan is in git history —
`git show d2ecf5a:docs/ui-ux-redesign-plan.md`). Code comments cite the decisions below as
**D-UI1–D-UI4**._

### 11.1 Decisions (all resolved)

| ID | Decision | Outcome |
|---|---|---|
| D-UI1 | **Radix primitives, narrowly scoped** — `react-dialog@1.1.16`, `react-popover@1.1.16`, `react-dropdown-menu@2.1.17`, `react-tooltip@1.2.9`, pinned exact; 42 transitive packages license-reviewed (all MIT/pure-JS/no install scripts). Segmented control, switch, chips, badges, banners stay hand-rolled. | **EXECUTED** — Dialog (Phase 24), Popover + DropdownMenu (Phase 25), Tooltip (Phase 27, the ambient indicator). |
| D-UI2 | Theme setting `'system' \| 'light' \| 'dark'`, default `'system'`. The pre-unlock gate cannot read settings (encrypted DB) → **the gate always follows the OS theme**. | **IMPLEMENTED** as written (Phase 23; `renderer/theme.ts`). |
| D-UI3 | **Home stays**, rebuilt as the readiness hub. Re-evaluated after Phase 26: it does NOT duplicate the Chat empty state (Chat teaches *what to ask*; Home answers *is the system ready*), and the Phase-27 first-run flow did not absorb its remediation duties (the starter step only routes; Home keeps live status + preflight). | **RESOLVED — Home stays.** |
| D-UI4 | Depth-mode ids stay `fast\|balanced\|deep` in code/IPC/persistence; only UI labels are Quick/Balanced/Thorough. No data migration. | **EXECUTED** (Phase 25 `DepthMenu`; tests pin the label↔id mapping). |

### 11.2 Facts the wave rests on

- **Renderer-only, with two scoped exceptions:** the additive `AppSettings.theme` key
  (Phase 23) and user-facing main-process **string literals** (Phase 27 copy sweep — error
  messages/notices only, no logic/IPC/schema changes). All hard rules held: fully offline
  (no web fonts/CDNs — system font stacks per §4.4), no telemetry, Windows first-class.
- **Run vitest from `apps/desktop`** — repo-root runs break the renderer matchers.
- The old accent `#4f8cff` as a filled-button background fails AA (3.22:1); filled controls
  use `--accent-600 #2f6fed` (4.55:1) in both themes (§4.2).
- `listModels` needs an unlocked workspace, so the first-run "is a model installed?" check
  runs **after** create succeeds, before handing off to the shell.

### 11.3 As built, per phase

- **Phase 23 — tokens + theming.** `renderer/tokens.css` (ramps theme-constant; role tokens
  per theme: `:root` = light, `[data-theme="dark"]` = dark), full `styles.css` restyle onto
  role tokens, global a11y baseline (`:focus-visible` outline ring, reduced-motion
  kill-switch, ≥24px hit targets), additive enum-guarded `AppSettings.theme` + the Settings
  Appearance card. Components never theme-check.
- **Phase 24 — shared components.** `renderer/components/`: Button / Badge / Banner /
  Toast(+host) / Modal / ConfirmDialog / SegmentedControl / Switch / Chip / EmptyState /
  Progress per §6; every non-chat screen + the WorkspaceGate migrated; "Saved" feedback via
  polite-live-region toasts; last browser `confirm()` removed.
- **Phase 25 — chat restructure (the priority).** `ChatScreen` split into `renderer/chat/`
  per §3: collapsible date-grouped ConversationList (hover "⋯" + ConfirmDialog), centered
  720px Transcript with per-message Try again · Copy · Save and the inline "▸ Sources (N)"
  disclosure, header SegmentedControl + "⋯" overflow, composer-footer "Answer detail"
  dropdown + documents-scope popover, teaching empty state, buffered streaming with the
  auto-collapsing Thinking… line.
- **Phase 26 — IA regroup.** Nav 7→5 (Home · Chat · Documents · **AI Model** ‖ Settings);
  Privacy + Diagnostics became Settings tabs; `renderer/navigation.ts` `resolveNavTarget`
  with virtual `settings:*` targets + legacy `privacy`/`diagnostics` aliases; Home rebuilt
  as the readiness hub; AI Model screen with per-card "Technical details" disclosure.
- **Phase 27 — microcopy, ambient signal, first-run (closed the wave).**
  - *Copy sweep* (§7) across renderer + user-facing main-process strings: the stale "Models
    screen" errors, `NO_DOCUMENT_CONTEXT_ANSWER` (persisted — reword affects future answers
    only), the wrong-password message ("That password didn't unlock your workspace…"),
    start-refusal messages (checksum state code → "we couldn't verify its file"), Documents
    ingestion labels (Waiting/Reading/Preparing/Ready), benchmark "Fast Mode" leftover. A
    `tests/unit/copy-tone.test.ts` guard pins the tone and scans string literals for stale
    phrases.
  - *Ambient indicator:* `components/LocalIndicator.tsx` (Radix **Tooltip**) — quiet
    "🔒 Local · Offline" in the sidebar (replacing the offline badge; state passed live by
    App) and the chat header (self-fetching). **(Superseded by Phase 12 — the sidebar instance
    was removed; the indicator now lives only in the chat header. See §12.1, decision #2.)**
    Hover/focus = reassurance line; click = `settings:privacy`. Honest variant while downloads are enabled: "Local · Downloads
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

### 11.4 Verification pattern (kept for future UI work)

Each phase: `npm run typecheck` + full vitest from `apps/desktop` + `npm run build`, plus a
scripted Playwright `_electron` screenshot walk of every touched screen in BOTH themes
(workspace `%TEMP%\hilbertraum-eyeball`, per-phase `walk-phaseNN.mjs`; strip `ELECTRON_RUN_AS_NODE`,
clear localStorage after the first window, `emulateMedia` for theme/reduced-motion; write a
`config/policy.json` with `encryption_required: true` to exercise the gate). Suite grew
644 → 669 tests (+6 manual skips) over the wave.

### 11.6 Documents-screen refinement — design record (IMPLEMENTED 2026-06-15)

_A focused, **renderer-only** pass on the Documents screen that extends the Phase 23–27 wave —
no IPC, schema, persistence, or main-process changes. The document tasks (summarize, translate,
compare, re-index, build deep index, OCR, add-to-project, delete) keep their existing
handlers/IPC; only the **presentation** changed. Code/i18n comments cite this section as **§11.6**._

**Decisions (the facts they rest on):**
1. **Action bank → one inline Preview + a "⋯" overflow.** Each row had 6–7 equal-weight outline
   buttons (Preview · Summarize · Translate · Re-index · Build deep index · Add to project… ·
   Delete), violating §6 (three button levels, one primary per view) and §8 (control clutter /
   equal-weight readouts). Now: **Preview** is the single inline Secondary button; everything
   else lives in a **Radix `DropdownMenu`** ("⋯"), mirroring the chat `ConversationList` ⋯ +
   `ConfirmDialog` pattern (decision D-UI1, `react-dropdown-menu@2.1.17`). The trigger is
   `aria-label`led "More actions for <filename>", is keyboard-focusable/tabbable even though it
   is revealed on hover, and right-clicking the row opens the same menu (one controlled
   `menuOpenId`). Contextual items appear only when applicable ("Make searchable (OCR)" for a
   scan, "Build deep index" until deeply indexed, "Export" for generated docs).
2. **State = badges, not buttons.** The three scattered "done" signals — "✓ Ready" (top-right),
   "Summary ✓" (metadata row), and "✓ Deeply indexed" (a green *button* in the action row) — are
   consolidated into ONE right-aligned **Badge cluster** (`Badge`, icon + word, never color-only
   — 1.4.1): a processing/ready status badge + small **Summary** (neutral) and **Deeply indexed**
   (success) badges. "Build deep index" simply disappears from the overflow once the tree is
   ready; Summarize↔Summarize again flips on `d.summary`. Provenance for generated docs
   ("Translated from …", "Comparison of …") stays a quiet caption, not a badge.
3. **Locations/projects = one uniform Chip.** Library / Temporary / Generated / Archived AND
   project tags now all render as the SAME neutral `Chip`, grouped and visually separate from the
   green status badges. The old blue-outlined "Temporary" badge is gone (it read like a
   status/link and collided with the Temporary left-nav location). See the open risk in
   `BUILD_STATE.md` on whether Library/Temporary/Generated/Archived are mutually-exclusive
   locations vs additive flags — the data model was left untouched.
4. **Compact list rows (§6 lists/tables).** The tall cards became compact rows (≥40px; ~56px for
   the two-line name + muted meta): checkbox · file-type `Icon` · filename (`min-width:0` +
   ellipsis) with a muted meta line · chips · status badges · inline **Preview** · **⋯**. Hover
   highlights the row; selected rows reuse the nav/history selection treatment —
   `--row-selected-bg` fill + a `--row-selected-bar` accent **left bar** (new role tokens per
   theme), NOT an outline ring, so selection stays distinct from the `:focus-visible` ring (§9).
   Result: ~3× more documents per screen.
5. **MIME → friendly label (§7).** A pure, renderer-only `friendlyMimeLabel` maps the stored MIME
   to a short label ("application/pdf" → "PDF", "text/markdown" → "Markdown", audio/* → "Audio",
   …) — **display only**, the stored strings are unchanged (the copy-tone guard stays green). The
   whole meta strip ("PDF · 2.0 KB · 7 sections") is `--text-xs` + `--text-muted` (technical
   columns visually secondary, §6).
6. **Selection toolbar for multi-doc ops (§6 banners — never stacked).** Ticking checkboxes
   surfaces ONE sticky, non-stacking bar: **Ask these documents**, **Compare (2)** (enabled only
   at exactly two), **Add to project…**, mark Temporary/Archived, and a **Delete** behind a
   `ConfirmDialog` — keeping the per-row set minimal. The bar reuses the selected-row fill + left
   bar.
7. **Toolbar (Task 7).** **Refresh** became a quiet `icon-btn` (new `refresh` glyph in `Icon`,
   `aria-label` "Refresh") so Import files (Primary) + Import folder (Secondary) carry the
   toolbar.

**As built:** `renderer/screens/DocumentsScreen.tsx` (compact rows, "⋯" overflow, badge
cluster, uniform chips, selection toolbar, bulk-delete `ConfirmDialog`, `friendlyMimeLabel`),
`renderer/components/Icon.tsx` (`refresh`), `renderer/tokens.css` (`--row-selected-bg` /
`--row-selected-bar` per theme; reuse the ramp), `renderer/styles.css` (`.doc-row*`,
`.docs-selbar`, `.doc-row-menu-btn`, `.icon-btn`, `.btn.danger`, `.menu-sep`),
`shared/i18n/{en,de}.ts` (`docs.moreActions`, `docs.chip.generated/archived`,
`docs.meta.sectionsCount`, `docs.bulk.delete*`, `docs.selectionAria`). Verification per §11.4:
typecheck + build clean, full vitest from `apps/desktop` **1353 passed / 25 skipped** (+5;
updated tests that asserted the old per-card button set / equal-weight Delete / "✓ Deeply
indexed" button / blue "Temporary" badge / raw "application/pdf", and added overflow + MIME
helper + selection-toolbar + status-as-Badge cases). Both themes contrast-checked; the new
accent left bar reads ≥3:1 on both surfaces. German copy added in the same pass (D-L7 informal
„du").

**Follow-up refinement (same area, 2026-06-15 — renderer-only, presentation only):** four
visual fixes after the compact-row restructure shipped. (1) **Right-aligned trailing cluster +
reading column.** The chips/badges/Preview/"⋯" are wrapped in one `.doc-row-trailing`
(`flex-shrink:0`, right-aligned) sibling to the flex-filling `.doc-row-main` (`flex:1;
min-width:0`); the filename uses the available width and only ellipsizes when genuinely out of
room, while Preview + "⋯" form a clean aligned column down the list. The list is capped to a
~1000px reading column (`.doc-list`) and the **Documents screen widened past the 860px `.screen`
prose cap** (`.docs-screen { max-width: 1180px }`, left-aligned, NOT centred) because a list with
chips + three badges + actions needs more width than a reading column; `.docs-main { min-width:0 }`
is the grid-blowout guard so a long unbreakable filename ellipsizes instead of widening the row
and pushing Preview/"⋯" off the edge. (2) **Tags read as tags, not buttons.** The row tag Chips
are restyled (scoped to `.doc-row-chips .chip`) as a quiet **filled `--surface-hover` neutral with
no hard border**, `--text-xs` `--text-muted` — visibly quieter than and clearly distinct from the
bordered Secondary Preview button (muted text on `--surface-hover` computes ≥4.6:1 both themes, AA
text ✓). (3) **Status hierarchy — one green, the rest neutral.** Only the **readiness** badge is
green (`success`); **Summary** and **Deeply indexed** are demoted to **`neutral`** capability
badges, each with its **own glyph** (`≡` for Summary, `▦` for Deeply indexed) — separating "is it
ready" (green) from "what's been done to it" (neutral). All keep icon + word (1.4.1); exactly one
`pill-success` per row. (4) **"⋯" overflow** confirmed present, keyboard-focusable/tabbable even
though hover-revealed, `aria-label` "More actions for <filename>", holding the full secondary set
(Summarize/again, Translate, Re-index, Build deep index [until deeply indexed], Make searchable
(OCR) for scans, Add to project…/Keep in Library/lifecycle/remove-from-project, Export for
generated docs, and the separated danger **Delete → `ConfirmDialog`**). **No user-facing string
changes** (badge glyphs are decorative; the copy-tone guard stays green). Verification per §11.4:
typecheck + build clean, full vitest from `apps/desktop` **1357 passed / 25 skipped** (+4:
flex-fill/right-aligned-cluster, quiet-chip-distinct-from-Preview, one-green-status-hierarchy,
"⋯"-keyboard-focusable). Playwright `_electron` eyeball walk in BOTH themes (a long filename
ellipsizing cleanly with room beside it, the aligned Preview/"⋯" column, quiet chips vs the Preview
button, Ready-green-only with neutral Summary/Deeply-indexed, the "⋯" menu open incl. Delete) —
before/after captures in `docs/design-review/docs-refinement/{before,after}/`.

---

## 12. Chat-UI polish pass — design record (IMPLEMENTED 2026-06-13)

_Branch `chat-ui-polish`. A focused, **renderer-only** calm/premium pass on the Chat screen +
conversation history, deepening §3/§7 (visual hierarchy: conversation → history → nav). No
backend/data-contract/IPC changes. Before/after eyeball captures live in
`docs/design-review/chat-screenshots/` (before) and `…-after/` (after)._

### 12.1 What changed (decisions + the facts they rest on)

1. **App nav is a compact rail, not a panel.** `.app-shell` grid → `80px 1fr`; nav items are
   icon-over-short-label with a `title` tooltip for the full name. The conversation is the
   centre of gravity (§1/§2). Active state is a **soft neutral fill** (`--surface-hover`) with
   weight, *not* an accent fill — accent blue is reserved for the focus ring, links, and the
   one primary button (§7, fixes accent overuse).
2. **One privacy signal.** The duplicate lower-left sidebar `LocalIndicator` was removed; the
   ambient "Local · Offline" lives only in the chat header now (the `variant="sidebar"` path +
   `.local-indicator-sidebar` CSS are dormant). The lock became a quiet rail button.
3. **History rows read as a calm list.** Selected = a soft *fill* on the row, never a border
   outline (a bordered selection read as keyboard focus). `:focus-visible` keeps the accent
   ring (the global baseline), so selection and focus are visually distinct. Rows are
   structured (title + an optional quiet `📄 Documents` metadata line) and ≥40px tall; the
   loud filled `DOC` badge is gone (the glyph pairs with the word — never color-only, 1.4.1).
4. **Search mode is contextual.** A "Results for '{query}'" header (`chat.search.resultsFor`)
   sits above the hits; snippets clamp to 2 lines and the matched term renders in `--text`
   weight 600 (not loud accent). Empty copy softened to "I didn't find a match. Try
   rephrasing." (§7 voice). The searchbox/region ARIA names + the sr-only count are unchanged
   (the tested L14 contract holds).
5. **Messages are softer.** User turns → a neutral tinted surface (`--surface-hover`), no
   strong blue border that read like a focused input. Assistant turns are **borderless +
   shadowless** — they read as text on the page, not nested cards; source cards therefore sit
   one quiet level of nesting deep, not box-in-box (§4 "no nested cards"). Uppercase
   `USER`/`ASSISTANT` chips → quiet **You** / **HilbertRaum** labels (`chat.role.*`).
6. **Composer is one unit.** `.composer-row` is the bordered shell that owns the focus ring
   (`:focus-within`); the textarea is borderless inside it and the Send/Ask button sits in the
   shell — it reads as part of the composer (§6). Enter=send / Shift+Enter=newline,
   dictation, and stop-generation are unchanged.
7. **Truthful doc-scope copy.** Never "Using all 0 documents": zero indexed docs → the footer
   becomes a direct "📄 No documents yet · Add documents" jump (`chat.scope.none` →
   Documents); some selected → "Using N documents"; all (count>0) → "Using all documents" (no
   count). `chat.scope.usingAll.*` plurals were collapsed to a single `chat.scope.usingAll`.
8. **Responsive (§8).** History **auto-collapses ≤1150px** (`ChatScreen.LIST_AUTO_COLLAPSE_PX`
   via a `matchMedia('change')` listener; `effectiveCollapsed = narrow ? !narrowPeek :
   listCollapsed`, so the persisted desktop preference is untouched and a session "peek"
   override re-opens it while narrow). Screen gutters + `chat-layout` height tighten at
   ≤1280/≤1150px so nothing overflows down to 1024px; the 720px transcript stays centred.

### 12.2 Intentional non-changes

- **History was already collapsible** (`LIST_COLLAPSED_KEY`, the `«`/`»` handles) — this pass
  refined the collapsed handle, the header toggle, and *added* the responsive auto-collapse;
  it did **not** reimplement collapse.
- **No backend / IPC / schema changes.** Edits are confined to the renderer + the EN/DE i18n
  string catalogs (the two-rule main-process boundary is untouched).

### 12.3 As built — files + tests

`renderer/App.tsx` (rail markup, drop sidebar indicator), `renderer/styles.css` (rail,
rows, messages, composer shell, responsive media queries),
`renderer/chat/{ConversationList,Composer,ScopePopover}.tsx`, `renderer/screens/ChatScreen.tsx`
(responsive collapse), `shared/i18n/{en,de}.ts`. Verification per §11.4: typecheck clean,
build OK, vitest **1085 passed / 25 skipped** (the `InformationArchitecture` indicator test
now drives the **header** indicator; scope + no-match copy assertions updated). German copy
for the new/changed strings was completed in the D-L7 review pass (2026-06-14).
