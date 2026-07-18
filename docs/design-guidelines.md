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

Collapse the nav destinations into 7 primary + 1 utility:

- **Top group (everyday):** Home (genuine status hub: ready? model running? doc count? one
  big "Start chatting") · Chat · Documents · **Translate** (live text translation on the
  dedicated TranslateGemma sidecar — a first-class task surface parallel to Documents/Chat,
  distinct from the document-translation doc-task under Documents; TranslateGemma plan §2 D6)
  · **Images** (visual understanding of one local image via a local vision model — a
  first-class task surface, distinct from OCR and from any image generation;
  image-understanding §6) · **AI Model** (reframed from "Models" — singular mental model;
  checksums/quantization behind a "Technical details" disclosure) · **Skills** (the user's
  capability library — manage, import, enable; a first-class destination, *not* a Settings
  tab, since it is a thing the user builds up over time, not a knob).
  - _Why Translate is a primary destination, not a sub-mode (7th deliberate IA change):_
    translating pasted text is a distinct, complete task — text in, translation out — that
    stands parallel to Chat/Documents/Images, runs on its own model (TranslateGemma, not the
    chat model), and is how a non-technical user reaches translation without first importing a
    document. It shares the window planner + sidecar with the Documents translate action, but
    the surfaces are separate tasks. The single-word labels ("Translate"/"Übersetzen") fit the
    existing slim rail (sized for the longer "Einstellungen"), so the 7th item adds no reflow.
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
│ Imgs │ ── Earlier ──  │ │  │ …answer text…                        │ │ │
│ Model│ · Lease notes  │ │  │ ▸ Sources (3)                        │ │ │
│ Skill│                │ │  └──────────────────────────────────────┘ │ │
│ ──── │                │ │   ↺ Try again · Copy · Save (hover/focus) │ │
│ Set. │ (collapsible)  │ │                                           │ │
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

> **Superseded by the brand refresh (§13).** The blue accent ramp below was retired in 2026-06;
> the accent is now the HilbertRaum teal. The brand primitives + contrast facts are in §13.2;
> this row set is kept only as the historical record of the pre-refresh palette.

| Token | Hex | Use |
|---|---|---|
| `--brand-teal` | `#57D0A4` | the dot; primary-button fill (with dark-ink text); accent/link/focus on **dark** |
| `--brand-teal-dark` | `#1B7F5F` | accent/link/focus on **light** (4.9:1 on bg); solid-control fill w/ a white marker |
| `--brand-ink-dark` | `#11171F` | square ink on light; **text on teal fills** |
| `--brand-ink-light` | `#E8EDF2` | square ink on dark |
| _(retired)_ `--accent-700/600/500/300` | _blue_ | pre-refresh accent ramp (`#2257c9`/`#2f6fed`/`#4f8cff`/`#8fb4ff`) |
| `--success-600` | `#1a7f4b` | success text on light (5.0:1) |
| `--success-500` | `#3fbf7f` | success on dark (8.1:1) |
| `--error-600` | `#c0362c` | error text on light (5.5:1) |
| `--error-500` | `#ff6b6b` | error on dark (6.8:1) |
| `--warning-700` | `#8a5a00` | warning text on light (5.9:1) |
| `--warning-500` | `#e0b341` | warning on dark (9.6:1) |

✅ **Contrast fix (historical):** `#4f8cff` as a button fill with white text was **3.22:1 — fails AA**,
so pre-refresh filled buttons used `--accent-600 #2f6fed` (4.55:1). **Superseded by §13:** the primary
button is now teal fill + dark-ink text (`#57D0A4` on `#11171F`, ≈9.98:1). Semantic color always pairs
with a label or icon (WCAG 1.4.1).

### 4.3 Role tokens per theme

Implement as `:root` (light) + `[data-theme="dark"]` overriding role tokens only; ramps stay
constant.

| Role | Light | Dark |
|---|---|---|
| `--bg` | `#f7f8fa` | `#0E1319` (§13: brand-exact, was `#0f1115`) |
| `--surface` | `#ffffff` | `#171a21` |
| `--surface-2` | `#ffffff` + shadow | `#1d212a` |
| `--border` (hairline) | `#e2e5ea` | `#2a2f3a` |
| `--border-strong` (inputs) | `#9aa3b2` | `#4a515f` |
| `--text` | `#1b1f27` (16.5:1) | `#e6e8ec` (15.4:1) |
| `--text-muted` | `#5c6675` (5.8:1) | `#9aa3b2` (7.4:1) |
| `--link` | `#1B7F5F` (4.9:1) | `#57D0A4` (10.4:1) |
| `--focus` | `#1B7F5F` | `#57D0A4` |
| `--accent` | `#1B7F5F` | `#57D0A4` |
| `--row-selected-bar` | `#1B7F5F` | `#57D0A4` |

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

- **Buttons.** Three levels only: Primary (`--brand-teal` fill + **dark-ink** `--brand-ink-dark`
  text — **one per view**; teal+white fails contrast, see §13), Secondary (surface +
  `--border-strong` outline), Ghost (text only). Focus = 2px `--focus` ring with 2px offset via
  `:focus-visible`. Min height 36px; hit targets ≥24×24 (WCAG 2.5.8). Disabled = 50% opacity.
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
- **Toggles.** Switch for binary settings (track `--brand-teal-dark` when on — the white thumb
  needs ≥3:1, which bright teal fails; §13), checkbox for multi-select; 24×24 min target;
  clickable label; focus ring.

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
- **EP-1 review glossary** (native pass, P5 2026-07-18 — the legal-adjacent register for the
  evidence-review surface; the CANONICAL record — the `de.ts` header comment mirrors it):
  evidence → **Nachweis(e)** — the NOUN „Beleg“ is banned; the verb „belegen“ is the
  sanctioned form wherever supported-ness is stated (decision labels „Geprüft — belegt“,
  the disclaimers’ „Er allein belegt nicht …“) ·
  review (the artifact) → **Prüfung** (evidence review → Nachweis-Prüfung) · review item →
  **Prüfpunkt** · evidence pack → **Nachweispaket** · citation / source marker →
  **Quellenverweis** (never „Quellenangabe“/„Zitat“ — one term carries the honesty claim) ·
  whole-document provenance → **Herkunft aus einer Gesamtdokument-Analyse** (its negation is
  always „keine satzgenauen Quellenverweise“) · direct excerpt → **direkter Auszug** ·
  source (document) → **Quelle / Quelldokument** · reviewer → **Prüfer** (label) / **die
  prüfende Person** (prose) · mark ready / reopen → **Prüfung abschließen / Prüfung wieder
  öffnen** · outdated → **veraltet** · review creation is „**Anlegen** der Prüfung“ (the
  ANSWER is „erstellt“ — the two are never mixed).
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
| D-UI3 | **Home stays**, rebuilt as the readiness hub. Re-evaluated after Phase 26: it does NOT duplicate the Chat empty state (Chat teaches *what to ask*; Home answers *is the system ready*), and the Phase-27 first-run flow did not absorb its remediation duties (the starter step only routes; Home keeps live status + preflight). **Follow-up 2026-06-16 (§11.7): the hero CTA is now ADAPTIVE** — it leads with the top unmet prerequisite ("Choose a model" when a model is needed) instead of always "Start chatting", so it no longer dead-ends at the no-model empty state. | **RESOLVED — Home stays; hero adaptive.** |
| D-UI4 | Depth-mode ids stay `fast\|balanced\|deep` in code/IPC/persistence; only UI labels are Quick/Balanced/Thorough. No data migration. | **EXECUTED** (Phase 25 `DepthMenu`; tests pin the label↔id mapping). |

### 11.2 Facts the wave rests on

- **Renderer-only, with two scoped exceptions:** the additive `AppSettings.theme` key
  (Phase 23) and user-facing main-process **string literals** (Phase 27 copy sweep — error
  messages/notices only, no logic/IPC/schema changes). All hard rules held: fully offline
  (no web fonts/CDNs — system font stacks per §4.4), no telemetry, Windows first-class.
- **Run vitest from `apps/desktop`** — repo-root runs break the renderer matchers.
- The old accent `#4f8cff` as a filled-button background fails AA (3.22:1); pre-refresh filled
  controls used `--accent-600 #2f6fed` (4.55:1) in both themes (§4.2). **(Superseded by the §13
  brand refresh — the accent ramp is now teal; the primary button is teal fill + dark ink, §4.2.)**
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
   `menuOpenId`). Contextual items appear only when applicable ("Read again (OCR)" on an
   already-OCR'd PDF, "Build deep index" until deeply indexed, "Export" for generated docs).
   A detected scan is a FAILED row — failed rows have no overflow, so its "Make searchable
   (OCR)" is an inline button on the row itself (OCR-R P1; see the architecture.md OCR
   remediation ledger).
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

**Follow-up — suggested-project removal + sub-nav regroup (2026-06-15).** Two changes to the
Documents screen. **(A) The auto "suggested project" feature was REMOVED** (intentional product
decision — it put a near-equal row affordance behind a low-value guess): the per-row suggestion
chip + Apply/Dismiss, the renderer state, the read-only `docs:filingSuggestions` IPC + its
preload bridge, the pure rule engine (`services/filing-suggestions.ts`), the `FilingSuggestion*`
types, the `AppSettings.dismissedFilingSuggestions` setting, the `docs.suggest.*` i18n keys
(EN+DE), and the `.doc-suggest*` styles are all gone (full original in git history). Filing
stays fully manual via the row **⋯** / selection toolbar (`addToCollection`/`createCollection`);
`source_folder_label` import metadata is retained. A `copy-tone` guard pins the removed strings
out of the source. **(B) The Documents sub-nav (`SectionRail`) was regrouped + densified +
made collapsible.** It was ~14 near-equal items with inconsistent grouping; now four headed
groups in order — **All documents** (default landing, no header, the slightly-emphasized active
fill) · **Projects** (header + "+", user-primary, per-project "⋯") · **Locations** (the system
buckets Library / Temporary / Generated / Archived under ONE header so they read as one set —
presentation only; the data model / exclusivity is untouched, see the location-taxonomy note in
`BUILD_STATE.md`) · **Views** (the common smart filters Recently added / Unfiled / Needs
re-index always visible; the rare diagnostics Large files / Failed imports / Audio / Scanned-OCR
folded behind a remembered **"More ▾"** disclosure — a real `<button aria-expanded>` — and an
empty rare view is hidden entirely so empty diagnostics don't sit on screen). Nav rows densified
to ~36px with a uniform hover highlight; the **active** item uses the `--row-selected-bg` fill +
`aria-current`, NOT a ring (so selection stays distinct from `:focus-visible`). The **whole
panel is collapsible** — a "«" handle hides it (the list then takes the full width) and a "»"
handle re-opens it, both remembered in localStorage (`hilbertraum.docs.railCollapsed` /
`…viewsMoreOpen`) — mirroring the chat `ConversationList` collapse pattern (§12.1) and resolving
the standing "sub-nav vs global-rail stacking" watch item: the second column is now dismissable,
not permanent. **Files:** `renderer/screens/DocumentsScreen.tsx` (SectionRail rewrite, collapse
state + "»" handle, suggestion removal), `renderer/styles.css` (`.docs-rail-head/-title/
-collapse/-show/-more`, density, `--row-selected-bg` active fill, `.docs-layout.rail-collapsed`),
`shared/i18n/{en,de}.ts` (+`docs.section.locations`, `docs.smart.more`, `docs.rail.hide/show`;
−`docs.suggest.*`). Verification per §11.4: typecheck + build clean, full vitest from
`apps/desktop` **1344 passed / 25 skipped** (suggestion tests/IPC/service/db-settings cases
removed; added a no-suggestion-renders guard + four-groups-in-order, More-toggles-via-keyboard-
with-aria-expanded, empty-rare-view-hidden, active-aria-current, and collapse-persists cases).
Playwright `_electron` eyeball walk in BOTH themes AND both locales (EN/DE): populated list with
no suggestion banner, the regrouped sub-nav with "More" collapsed + expanded, the sub-nav
collapsed (list full-width) + expanded, the active-item fill — German headers/labels fit without
hyphenation/overflow. Captures went to `docs/design-review/docs-subnav/`
(`scripts/walk-docs-subnav.mjs`).

**Follow-up — import-failure copy + failed-row actions + sub-nav density (2026-06-15, renderer +
one scoped main-process string).** Three Documents/shell polish fixes (+ a density nudge). **(A)
Import-failure copy localized + softened (§7).** A failed import persisted (and showed) the raw
English literal `Unsupported file type: .xyz` — leaking English into the German UI. It now routes
through a new **interpolated** persist-canonical key `main.ingest.unsupportedType` with an `{ext}`
param (EN: "This file type isn't supported (.xyz). Try TXT, PDF, DOCX, CSV, or a supported audio
format."; DE informal „du", D-L7). The persist site ([`ingestion/index.ts`](../apps/desktop/src/main/services/ingestion/index.ts))
writes canonical English via `t('en', …, { ext })` (the preview-path sibling throw uses `tMain`,
rule 2); because the value carries the interpolated extension it can't be exact-matched, so the
D-L4 display map ([`displayMap.ts`](../apps/desktop/src/renderer/lib/displayMap.ts)) gains an
**interpolated matcher** — a regex derived from the English template recovers `{ext}` and
re-renders in the target language. A **legacy matcher** (the old `Unsupported file type: …` form)
localizes rows persisted before this change so old failures don't leak English either. The
interpolated key is deliberately OUTSIDE `DISPLAY_MAP_KEYS` (the exact-match set) — it lives in the
new `INTERPOLATED_MAP_KEYS`; the copy-tone guard now bans the raw "Unsupported file type" literal.
**(B) Failed-row actions — Remove + Try again, never Preview.** A failed import never produced
extracted text, so the inline **Preview** is meaningless on a failed row. Failed rows now show
inline **Remove** (reuses the delete handler — clears the entry; works from both the All-documents
list and the "Failed imports" view, same row markup) and, **only when the failure is retryable**
(a transient read/parse error — `isRetryableFailure`, false for an unsupported type / file-too-
large / too-many-sections), **Try again** (re-index). No "⋯" overflow on a failed row (Re-index =
Try again, Delete = Remove are both inline). The red **Failed**/**Fehlgeschlagen** badge (icon +
word, §6) and the in-context error banner stay; the banner is now **compact** (`.doc-row-main
.banner` — tighter padding/margin + `--text-xs`) so a failed row no longer towers over the clean
~56px rows. **(C) Sub-nav density.** The four sections sat airy despite the prior "densified"
pass: inter-group margin `8px → 3px`, group-head padding `4px → 2px`, and the group label bumped
`11px → 12px` (§4.4 floor) — rows stay ~36px with the hover highlight intact. **Files:**
`shared/i18n/{en,de}.ts` (+`main.ingest.unsupportedType`, +`docs.failed.remove/removeTitle/retry/
retryTitle`), `main/services/ingestion/index.ts`, `renderer/lib/displayMap.ts`
(`INTERPOLATED_MAP_KEYS`, `unsupportedTypeExt`), `renderer/screens/DocumentsScreen.tsx`
(`isRetryableFailure`, the failed-row action branch, the failed-row context-menu guard),
`renderer/styles.css` (`.app-shell` 100px, `.nav-label` non-breaking + 12px, narrow breakpoints,
`.doc-row-main .banner` compact, sub-nav density). Verification per §11.4: typecheck + `npm run
build` clean; full vitest from `apps/desktop` **1356 passed / 25 skipped** (display-map
interpolated + legacy + hygiene cases; DocumentsScreen failed-row Remove/Try-again/no-Preview +
`isRetryableFailure`; new `rail-labels` guard; copy-tone stale-literal; ingestion persists the
softened English). Playwright `_electron` eyeball walk in BOTH themes AND both locales (EN/DE): the
rail on Home/Chat/Documents/AI Model/Settings with every label measured one-line/unclipped (longest
"Einstellungen" 72px in the 100px column), a Documents list with a failed import (localized
friendly banner, Remove not Preview, compact banner), the "Failed imports" view — captures in
`docs/design-review/rail-and-failed/` (`scripts/walk-rail-and-failed.mjs`).

### 11.7 Adaptive Home CTA + app-wide privacy indicator + AI-Model de-jargon (IMPLEMENTED 2026-06-16)

_A focused, **renderer + EN/DE i18n only** pass — no IPC/schema/data-contract/main-process logic
changes (one scoped exception: user-facing string literals in the i18n catalogs). Three changes,
each citing this section as **§11.7**._

1. **Home hero CTA is now adaptive to the top unmet prerequisite (D-UI3).** Home used to lead
   with a loud filled **"Start chatting"** even while the hub showed "⚠ Needs a model", so the
   click dead-ended at the "No model is running" empty state. The hero buttons are now driven by
   the SAME readiness signal the row badges render from (`needsModel = status != null &&
   !modelRunning && !status.activeModelId` — the warning-badge condition). When a model is needed,
   the loud primary becomes **"Choose a model" / „Modell auswählen"** (routes to AI Model) and
   "Start chatting" + "Ask my documents" demote to **secondary** (still clickable — the demo/mock
   runtime may allow chatting; never hard-disabled). When a model is ready (running, or selected +
   loading), the loud primary is **"Start chatting" / „Chat starten"** as before. **Exactly one
   loud primary at a time** (§6): the model row keeps its own *secondary* inline "Choose a model"
   (the inline affordance), so the remediation isn't duplicated as a second loud button. No new
   state — it reuses the hub's existing readiness reads.
2. **One quiet, honest privacy indicator, app-wide (§1.2/§7).** The ambient signal moved from the
   chat-header-only placement (§12.1 #2, now superseded) to a single **rail-foot** instance: the
   dormant `LocalIndicator variant="sidebar"` + `.local-indicator-sidebar` CSS were revived and
   restyled to MATCH the rail (icon-over-short-label, centered, 12px floor, the `.nav-item` column
   metrics; quiet/muted, not the accent the nav icons use — it's a state, not a destination), and
   the chat-header instance was **removed** so there is **exactly one** signal on EVERY screen. It
   reflects the **EFFECTIVE** state (`PolicyStatus.offlineMode`, owned by App, which folds the
   drive-policy ceiling AND the network toggle — so a `config/policy.json` that forces downloads
   off reads "Offline" even with the toggle on): internet off → **closed padlock + "Offline" /
   „Offline"**; internet allowed → **open padlock** (new `lock-open` `Icon` glyph) **+ "Downloads
   on" / „Downloads an"**, tooltip "Downloads allowed — chats and documents stay local." The full
   "Local · …" label is too wide for the 100px rail, so the sidebar variant shows the short
   one-word label (new `indicator.short.*` keys; the full reassurance is the tooltip); the label
   wraps cleanly at its space ("Downloads on" → two lines), the same discipline as the §12.1 #1
   rail-label fix. Clicking still opens Settings → Privacy & data (`settings:privacy`, unchanged).
3. **AI Model de-jargon (§3/§7 hide the machinery).** The developer-speak **"Start mock runtime"
   / „Demo-Runtime starten"** button is relabeled **"Try in demo mode" / „Im Demo-Modus testen"**,
   matching the page's existing "demo mode (visibly simulated answers)" banner; the start-title and
   the Diagnostics accel label were de-jargoned the same way ("Built-in demo mode" / „Eingebauter
   Demo-Modus"). The affordance is **already developer-gated in MAIN** (`startableAsMock = missing
   ∧ chat ∧ developerMode`, `services/models.ts`), so end users never see it — relabeling makes it
   honest even on the developer/demo path (chosen over hiding it, since it's a useful "try the app"
   action there). **Per-card buttons tidied:** the disabled **"Select"** is **hidden until the
   model is downloaded** (it's noise before the weights exist), and the not-installed-no-mock card
   drops its disabled "Start runtime" too — so a "Not downloaded" card's one clear action is
   **Download** (+ "Try in demo mode" on the dev path). Once downloaded, the card's action returns
   (**as of 2026-07-07 this is the single "Use this model" button — see §11.10**, superseding the
   original Select + Start runtime pair). "Technical details" stays the disclosure. A `copy-tone`
   guard now bans the stale "Start mock runtime" / „Demo-Runtime" literals.

**As built:** `renderer/screens/HomeScreen.tsx` (adaptive hero), `renderer/App.tsx` (rail-foot
indicator; drop the ChatScreen `offline` prop pass), `renderer/screens/ChatScreen.tsx` (remove the
header indicator + `offline` prop), `renderer/components/LocalIndicator.tsx`
(`localIndicatorShortLabel`, lock-open glyph, rail-foot copy), `renderer/components/Icon.tsx`
(`lock-open`), `renderer/screens/ModelsScreen.tsx` (hide disabled Select/Start when not downloaded;
demo button via the relabeled key), `renderer/styles.css` (`.local-indicator-sidebar` rail
metrics + `.local-indicator-label`), `shared/i18n/{en,de}.ts` (`indicator.short.offline/online`;
relabeled `models.startMock`/`startMockTitle`/`diag.accel.mock`). **Verification per §11.4:**
typecheck + `npm run build` clean; full vitest from `apps/desktop` **1365 passed / 25 skipped**
(updated the `InformationArchitecture` indicator test to assert the single rail-foot indicator +
the honest "Downloads on" state; `LocalIndicator` short-label + honest-state cases; `ChatHomeNav`
adaptive-CTA cases incl. exactly-one-loud-primary + both locales; `ModelsScreen` no-disabled-Select
+ "Try in demo mode"; removed the obsolete chat-header-indicator test; copy-tone stale-literal
guard). Playwright `_electron` eyeball walk in BOTH themes AND both locales (EN/DE): Home
needs-a-model (loud "Choose a model") vs ready (loud "Start chatting"); the rail-foot indicator on
Home/Chat/Documents/AI Model/Settings with internet OFF ("Offline") vs ON ("Downloads on"); AI
Model cards (new "Try in demo mode" label, no disabled Select when not downloaded) — captures in
`docs/design-review/home-privacy-aimodel/` (`scripts/walk-home-privacy-aimodel.mjs`).

### 11.8 Disclosure a11y — `aria-controls` on toggle/region (IMPLEMENTED 2026-06-30, full-audit follow-up Phase 5, FE-D)

The app's collapse/expand disclosures are hand-rolled `<button aria-expanded>` toggles (not native
`<details>`, by L15 — see §12). FE-D found three of them named their state but not their region: an AT
user heard "expanded" with no link to what expanded. **As built:** the toggle now carries
`aria-controls={regionId}` and the expanded panel is `role="region"` + `aria-labelledby={toggleId}`,
applied consistently to **Sources** (`SourcesDisclosure`), the live **Thinking…** line, and the
compaction **SummaryMarker** (all in `renderer/chat/`). React `useId()` mints the stable id pair. This
matches the careful a11y already shipped for `ContextMeter`/`StreamAnnouncer` and is pinned by
`tests/renderer/SourcesProvenance.test.tsx` + `TranscriptA11y.test.tsx` (aria-controls resolves to the
rendered region id when expanded). The **Sources** disclosure was also relabelled in the same pass for
whole-document answers (provenance, not inline citations) — that honesty record lives in
[`rag-design.md`](rag-design.md) §14.4 (FE-B / F11).

### 11.9 Conversation-memory meter — label a gauge, don't leave it a bare % (IMPLEMENTED 2026-07-07, beta-feedback #25 / D69)

A beta user (issue #25) read the composer-footer indicator — a bare `45%` with `role="progressbar"`
and no visible name — as **task/answer progress**. It actually shows how full *this conversation's
memory* is. A percentage attached to nothing, with the progressbar role, invites exactly that
misreading. **Rule this records:** a gauge of a *current level* (memory fullness, disk, battery) is a
**meter**, not a progress bar, and it must carry a **visible short name** — a number needs a noun. Only
a determinate *task* (import 12 of 30, a download) is a progress bar (§ "Progress / streaming").

**As built** (`renderer/chat/ContextMeter.tsx` + `styles.css` `.context-meter*`): a visible short label
(`chat.context.label` — EN **"Memory"** / DE **"Speicher"**) renders beside the bar + `%`; the role is
**`role="meter"`** (keeps `aria-valuemin/max/now` + `aria-valuetext`; `aria-label` is the label, the
token reading rides `aria-valuetext`/`title`). The tooltip teaches the mental model — EN *"Memory for
this conversation: {pct}% full (about {used} of {window} tokens)."* + the amber-band heads-up *"When it
fills up, older messages are summarized automatically to make room."* (DE mirror) — keeping the
approximate-token honesty. **No-jargon rule (§ "Words"):** the word *context*/*Kontext* stays OUT of the
visible label (it named the machinery, not the user's mental model). The calm/amber/near-full tone bands
and the 0.85 compaction trigger are unchanged — only the reading changed. Coverage (#24) is a separate,
answer-anchored statement and is deliberately NOT folded into this widget. Pinned by
`tests/renderer/ContextMeter.test.tsx` (meter-not-progressbar, visible EN/DE label, amber/near-full
copy, null-window guard) + the updated `ChatCompaction.test.tsx`.

### 11.10 One action on the model card — "Use this model" (IMPLEMENTED 2026-07-07, beta-feedback #27 / D70)

A first-time user (issue #27) faced a **"Select"** AND a **"Start runtime"** button on every installed
chat card and couldn't tell which led to chatting. **Rule this records:** when two adjacent controls are
almost always used together to reach one goal, collapse them into **one primary action named for the
goal**, not the mechanism. The card now shows a single primary **"Use this model" / „Dieses Modell
verwenden"** (`models.use`) that BOTH makes the model the active selection AND starts its runtime. The
old `models.select` / `models.startRuntime` / `models.startTitle` labels are retired (superseding the
§11.7 note's "Once downloaded, Select + Start runtime return").

**Why it must start, not just select:** selected models already auto-start at launch, so Select≠Start
only bit *mid-session*; and chat-send never auto-starts a runtime (the `registerChatIpc` contract), so a
select-only action would leave the user at a dead "no model running" chat. **As built:** a new
`useModel(modelId)` IPC (`registerModelIpc.ts`) does select-then-start MAIN-side — the §7.4 install gate
+ the RAM gate run once, the audit trail is one chain (`model_selected` then `runtime_started`), and a
non-chat role is rejected before any persist. A start failure leaves the fresh selection standing (auto-
start + a retry cover it — the same posture the old Select button had, which always persisted). The
renderer button is **not** disabled on `active` (an active-but-stopped model still needs it to start;
select is idempotent) — only the RAM gate / another button busy / another model mid-start disable it.
Stop, the disabled Starting… spinner, the Active/Running/state badges, the demo-mode developer button,
and the automatic non-chat roles (which show neither action nor Active badge) are all unchanged. Pinned
by `tests/renderer/ModelsScreen.test.tsx` (one action per installed card, disabled while RAM-gated /
busy / anyStarting, Starting… spinner, Stop when running, demo card, DE label) + the `useModel`
integration tests in `tests/integration/core-model-ipc.test.ts`.

### 11.11 First-answer warm-up hint — say the one-time cost out loud (IMPLEMENTED 2026-07-09, issue #39)

Beta testing (issue #39): the FIRST answer of a session is much slower than every later one — the
sidecar prefills + caches the long system prompt once (`cache_prompt: true`), and a just-started model
additionally pays the multi-GB load — but the UI never said so, and a new user can't tell "normal
one-time warm-up" from "stuck". First impressions form on exactly that turn. **Rule this records:**
when the app is *correctly* doing slow one-time work at a moment the user is likely to lose trust,
say so — calmly, only while it is actually true, and never as persistent chrome.

**As built:** a muted line under the pending answer (`.chat-warmup-hint`, `chat.warmup.hint` — EN
*"The first answer takes a little longer — the model is warming up. Later answers will be faster."*,
DE mirror) with three honesty gates, ALL required: (1) it appears only after `WARMUP_HINT_DELAY_MS`
(3 s) with **nothing** streamed — a fast GPU first turn never flashes it; (2) only when the runtime
itself reports this is its first generation since the model started — `RuntimeStatus.warmedUp ===
false`, from a new optional `ModelRuntime.warmedUp()` that `LadderRuntime`/`MockRuntime` flip on the
first streamed chunk of any real generation (answer token OR Deep-mode reasoning delta; a model
switch/restart builds a fresh instance, so the flag resets, and the hint truthfully returns for the
re-paid load). Deterministic no-model answers (routing/refusal/listing) never call `chatStream`, so
they never fake a warm-up; an absent `warmedUp` field (bare/older runtime) fails safe — no hint.
(3) It drops the instant anything streams and when the turn settles — `role="status"`, same quiet
vocabulary as the compaction notice, never an alert (the model is doing the right thing). Pinned by
`tests/renderer/ChatWarmupHint.test.tsx` (delay gate, warmed/absent-field negatives, no-flash,
reasoning-retires-it) + the `warm-up tracking (#39)` block in `tests/unit/runtime-ladder.test.ts`.
Related: #36 (the header `model · GPU/CPU` hint) names the *persistent* speed context; this names
the *one-time* cost.

### 11.12 Evidence-review workspace — EP-1 Phase 2 rollout (IMPLEMENTED 2026-07-18, plan §7)

The review workspace (`ReviewScreen.tsx` + `renderer/review/*`) is the first **handoff-only
full-window screen**: `ScreenId` gained `'review'` with NO nav-rail entry — the rail stays 8
items, and `resolveNavTarget('review')` deliberately falls through to home because the screen
is meaningless without App's `openReview(reviewId | messageId)` handoff slot (the `chatScope`
idiom). Entry points are quiet and progressive (spec §9): the message action row gains
**Review evidence / Continue review** last in row plus a text+glyph Draft/Ready chip
(`.msg-review-chip` — never color-only, §9), and the expanded SourcesDisclosure carries the
`.sources-review` footer link. Patterns this rollout added or reused, for future screens:

- **Two-pane workspace, drawer under 980px:** answer pane (immutable snapshot markdown via
  `AssistantMarkdown`, selectable item cards with `aria-current`) + evidence sidebar. On
  narrow windows the sidebar is NOT squeezed — it mounts as the existing `Modal width='wide'`
  opened per item ("View evidence"), inheriting the focus trap + focus-return for free. The
  breakpoint lives in ONE `matchMedia` subscription (`useSyncExternalStore`), not CSS
  `display:none` duplication, so tests and behavior can't diverge.
- **6-value decision chips as a radio group:** `review/DecisionControl.tsx` reimplements the
  SegmentedControl roving-tabindex idiom as WRAPPING chips (6 values don't fit a pill track):
  one tab stop per group, arrows move focus+selection, Home/End jump, each chip = glyph +
  localized text. Selection recolors via border+weight, never color alone.
- **Debounced auto-save with a labelled status line:** the repo's first auto-save
  (`lib/reviewSession.ts`, 600 ms debounce, loss-free flush; flush on screen exit and BEFORE
  vault lock). The UI voice is a quiet `role="status"` "Saving… / Saved" line and a
  `role="alert"` + retry on failure — no unlabeled spinner (§6), no toast spam.
- **Honesty captions are keys, not prose:** the evidence pane's per-mode caption
  (`review.evidence.captionRelevance|WholeDoc|Structured`) and the per-item
  "No direct source marker" / "Derived through whole-document analysis" notes are asserted
  BY EXACT KEY in tests — whole-document provenance is never worded as citations, and
  provenance cards render no `[Sn]` label (the SourcesDisclosure rule, reused via the
  exported `PROVENANCE_CARD_CAP` + card markup idiom).
- **Deliberate deviation from spec §11.2:** no per-screen "Local · Offline" header indicator —
  the rail-foot indicator is THE single ambient privacy signal on every screen (§12.1 #2);
  duplicating it per screen is exactly what that record forbids.
- **Conservative bulk actions only** (spec §14.4): headings→N/A, undecided→follow-up,
  clear-all (confirmed via ConfirmDialog). "Mark all supported" does not exist and a test
  pins its absence; the store exports no bulk pathway that can write a supported verdict.
- **Ready is read-only** (spec §18.4, fix round): a review marked Ready disables all
  item-level editing (decisions, notes, links; bulk hides) with a quiet "reopen to edit"
  hint by the status chip — main refuses those writes too, so `ready` + undecided is
  unreachable from both sides. Head edits (rename, reviewer label, general note) stay live.

Tests: `ReviewScreen.test.tsx` (journey, exact-key wording, D-7 gating, bulk absence,
keyboard walk §28.10, drawer focus-return), `ReviewEntryPoints.test.tsx` (visibility matrix +
D-2 delete-confirm count), `reviewSession.test.ts` (debounce/loss-free/purge), plus
`GermanSmoke`/`InformationArchitecture`/`LazyScreens` legs and the restart + lock/unlock
integration legs in `evidence-reviews-ipc.test.ts`. German copy is a DRAFT pending the
native review pass (Phase 6, D-L7 — flagged in `de.ts`). **(Superseded: the native pass
landed in P5 — §11.13; the draft flags are gone.)**

### 11.13 Evidence-review polish — EP-1 Phase 5 rollout (IMPLEMENTED 2026-07-18, plan §10)

Selections, source filter, back-to-conversation, the German native pass, and the recorded
§9 accessibility audit (the EP-1 exit-gate artifact). Patterns added:

- **Reviewer text selections select from the SOURCE text, not the rendering.** The stored
  offsets are UTF-16 code units into a block's `textSnapshot`, and main REFUSES misaligned
  boundaries (never clamps) — but `AssistantMarkdown`'s rendered DOM is NOT that string
  (markdown syntax dropped, `[S1]`→`[Q1]` localized, math rewritten to KaTeX output, soft
  breaks reflowed), so mapping a DOM selection back through it cannot be exact. The shipped
  surface is the plan-§10 honest fallback: "Review a passage separately" swaps in a
  **read-only `<textarea>` whose value IS the snapshot** — its native
  `selectionStart/End` ARE the offsets (exact by construction), keyboard selection
  (Shift+arrows) works natively (the WCAG 2.5.7 non-drag path), and the hint says the text
  is shown without formatting. A refusal from main surfaces as a quiet `role="status"`
  retry hint, never an error state; a success announces via toast and keeps the composer
  mounted (no focus loss). Selection items render as tagged plain-text quotes ("Reviewer
  text selection") with a Remove action — never through the markdown renderer (a
  mid-markdown slice is not valid markdown; the pack renders them as plain text too).
- **Large provenance sets: filter + stepped reveal, NO virtualization.** The evidence pane
  keeps the `PROVENANCE_CARD_CAP` (24) initial render and now reveals cap-sized batches
  ("Show 24 more" + a "{shown} of {total}" count line) plus a filter input once the set
  exceeds the cap. The filter matches the facts the card DISPLAYS: title / snippet /
  section / page / the marker in BOTH its raw machine form ("S3") and its localized
  display form via `formatCitationLabel` (DE "Q3" — fix round). The no-virtualization
  decision rests on the MEASUREMENT (plan §10 "measure first"): with 30 sources the full
  IPC open path runs in ~3 ms and the mounted DOM never exceeds the revealed batch
  (pinned in `ReviewEvidencePane.test.tsx` + `evidence-review-open-perf.test.ts`) — the
  cap+reveal already bounds the work, so virtualizing the pane buys nothing at these
  counts. (`@tanstack/react-virtual` itself pre-exists in the tree for DocumentsScreen's
  long list — availability was never the question; need was.)
- **Back to chat returns to the ORIGINATING conversation** (the named P2 UX debt): the
  review's `conversationId` flows App-side (`backToConversation` → `chatConversation`
  handoff slot, the chatScope idiom; cleared by every plain chat navigation) and ChatScreen
  gained a mount-time re-attach effect (the stream/skill-run idiom, `activeIdRef`-guarded).
  A deleted conversation degrades to chat home — never a phantom selection.
- **Perf pass (spec §26), recorded:** opening a review with 30 sources through the real
  IPC handlers — create 11.8 ms, open (detail read + freshness check) 3.0 ms, model
  runtime NEVER touched (tripwire), offline guard silent, no fixed sleeps anywhere
  (`evidence-review-open-perf.test.ts`; the 1 000 ms assert is the spec's own budget as an
  order-of-magnitude regression tripwire).
- **German native pass (D-L7) over ALL EP-1 keys** (`review.*` 152, `packExport.*` 96,
  `main.evidenceReviews.*` 6 — EN=DE parity, incl. the 15 new P5 keys: 6
  `review.evidence.*` + 8 `review.selection.*` + `review.item.selectionTag`): consistent du-form, legal-adjacent
  register, terminology per the §7 EP-1 glossary (Nachweis / Prüfung / Prüfpunkt /
  Quellenverweis / „Anlegen der Prüfung“); the „Prüfstand“ mistranslation and the
  Quellenangabe/Quellenverweis split are gone; ellipsis spacing unified; the ENTWURFSSTAND
  draft flags are REMOVED. One golden regenerated (`german.html` — the unified disclaimer
  line; single-line diff, hand-reviewed).

**§9 accessibility audit — recorded results (ReviewScreen + modals + banner + new UI):**

| §9 item | Result |
|---|---|
| Text ≥4.5:1, UI/icons ≥3:1 | PASS — all review UI on role tokens (§4.3 ratios); new tag/surface/filter inherit `--text`/`--text-muted`. |
| Visible focus, outline-based | PASS — global `:focus-visible` baseline (Phase 23); new controls are native button/textarea/input. |
| Sticky chrome obscuring focus (2.4.11) | PASS (trivially) — nothing on the review screen is sticky; panes scroll independently. |
| Targets ≥24×24 (2.5.8) | **2 FIXES**: `.msg-action` gained `min-height: 24px`, `.chip-remove` gained a 24×24 min box (both app-wide). Buttons/decision chips/inputs already ≥24 (36px primary). |
| Drag needs a non-drag path (2.5.7) | PASS — text selection via the read-only textarea works with keyboard (Shift+arrows) as well as pointer drag. |
| Password gate paste (3.3.8) | N/A on this surface. |
| `prefers-reduced-motion` | PASS — global kill-switch; the phase adds no motion. |
| Async states announced | PASS — SaveStateLine `role=status/alert` (P2), Outdated banner `role=status` (P4); NEW: the selection-refused hint and the filter no-match line are PERSISTENT `role=status` regions that mount EMPTY and fill on state change (fix round — a region first appearing WITH content is missed by some screen readers; `:empty` collapses the idle element). The shown-count line is deliberately NOT live (it changes only on the user's own reveal click, beside the button). Selection add announces via the polite toast region. |
| Never color-alone (1.4.1) | PASS — chips/badges are glyph+text; decision selection = border+weight+text; new states are text. |
| Spec §23: pane↔item association | PASS — the visible "Linking evidence for review item N" line IS the evidence region's programmatic DESCRIPTION: its id is the region's `aria-describedby` (fix round; the region NAME stays the stable "Evidence" title, and the SAME region component mounts in the wide aside and the narrow drawer, so both layouts carry it — pinned incl. the no-selection no-dangling-attribute case). `aria-controls` is deliberately NOT stamped on the non-interactive `<li>` rows (they are not widgets; the narrow drawer gets real dialog semantics from Radix). |
| Spec §23: progress as text · excerpts selectable/readable · 200 % zoom · drawer focus-return · localized markers | PASS — footer text gate; cards + surface are selectable text (surface line-height 1.5); the 980 px drawer reflow is the 200 % posture; focus-return pinned since P2; markers share the display regexes (P1). |
| Spec §23: exported PDF heading order | RESOLVED in P6: the PDF is printed from the same semantic h1→h2→h3 template with `generateTaggedPDF` + `generateDocumentOutline`; the real-Electron smoke verifies extractable text, the bookmark tree (depth 3, catalog titles, EN+DE) and the tagged (`/MarkInfo Marked`) structure. Scope stated honestly: Electron marks tagged output EXPERIMENTAL — accessible headings/reading order are best-effort, never a PDF/UA claim (known-limitations.md); the HTML pack remains the accessibility-first format. |

Tests: `ReviewSelections.test.tsx` (raw-source surface EN + DE — the DE leg pins the
textarea carrying the RAW `[S1]` snapshot while the rendered block shows `[Q1]`; exact
UTF-16 offsets incl. astral chars; refusal hint; delete; READY hides the composer and
disables Remove; D-7 exemption; back-nav callback), `ReviewEvidencePane.test.tsx`
(cap/stepped reveal/reveal-reset-on-filter-change/filter facets incl. DE `Q3` + section +
page/empty state/`aria-describedby` tie + no-dangling case),
`ChatBackToConversation.test.tsx` (handoff select, deleted-id degrade, baseline, and the
App-LEVEL one-shot-slot test: review → back → Documents → "Ask these documents" wins —
the FIX-1 blocker repro, mutation-verified), `reviewSession.test.ts` selection token-race
legs (post-purge create/delete + post-switch create), `evidence-review-open-perf.test.ts`
(spec §26 tripwire + numbers above).

---

## 12. Chat-UI polish pass — design record (IMPLEMENTED 2026-06-13)

_Branch `chat-ui-polish`. A focused, **renderer-only** calm/premium pass on the Chat screen +
conversation history, deepening §3/§7 (visual hierarchy: conversation → history → nav). No
backend/data-contract/IPC changes. Before/after eyeball captures lived in
`docs/design-review/chat-screenshots/` (before) and `…-after/` (after)._

### 12.1 What changed (decisions + the facts they rest on)

1. **App nav is a compact rail, not a panel.** `.app-shell` grid → `100px 1fr`; nav items are
   icon-over-short-label with a `title` tooltip for the full name. The conversation is the
   centre of gravity (§1/§2). Active state is a **soft neutral fill** (`--surface-hover`) with
   weight, *not* an accent fill — accent blue is reserved for the focus ring, links, and the
   one primary button (§7, fixes accent overuse).
   - **Rail labels never break mid-word** (follow-up 2026-06-15). The original rail wrapped
     long labels via SOFT HYPHENS (U+00AD) baked into the i18n strings + `hyphens: manual`,
     which rendered as "Docu-ments" / "Doku-mente" / "Einstel-lungen" — reads as broken. Fixed:
     the soft hyphens are **stripped from the nav labels**, `.nav-label` sets
     `hyphens: none; overflow-wrap: normal; word-break: normal` (no soft/auto break ever), and
     the **grid column was widened 80px → 100px** so the longest SINGLE-word label in EITHER
     locale ("Einstellungen", DE — ~72px) fits on one line at the **12px text floor** (§4.4; the
     rail label was also bumped 11px → 12px). 100px is "just enough" (72px label + the rail's
     ~26px padding/border ≈ 98px) and stays far slimmer than the original ~220px panel; the
     narrow-window breakpoints (≤760/≤520px) no longer shrink the column below this fit width
     (a single word can't wrap). Labels with a space or hyphen ("AI Model", "KI-Modell") may
     still wrap cleanly to two lines. Guard: `tests/unit/rail-labels.test.ts`.
2. **One privacy signal.** The duplicate lower-left sidebar `LocalIndicator` was removed; the
   ambient "Local · Offline" lived only in the chat header (the `variant="sidebar"` path +
   `.local-indicator-sidebar` CSS were dormant). The lock became a quiet rail button.
   - **Superseded (follow-up 2026-06-16, §11.7).** The chat-header-only placement left
     Home / Documents / AI Model / Settings with NO privacy signal, and the honest
     "downloads allowed" state was surfaced nowhere. The single indicator now lives at the
     **foot of the app rail** (`variant="sidebar"` revived) so it shows on EVERY screen, and
     the chat-header instance was removed — still **exactly one signal app-wide**. It is
     honest about the EFFECTIVE state (`PolicyStatus.offlineMode`, which folds the drive
     policy ceiling AND the network toggle): internet off / policy forces off → closed
     padlock + "Offline" / „Offline"; internet allowed → open padlock + "Downloads on" /
     „Downloads an", tooltip "Downloads allowed — chats and documents stay local." The rail
     is narrow, so the sidebar variant shows that SHORT one-word label (the full "Local · …"
     reassurance is the tooltip), wrapping cleanly at its space like "AI Model" does.
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

---

## 13. Brand refresh — design record (IMPLEMENTED 2026-06-19)

_Branch `design-adjustments`. Applied the HilbertRaum brand kit (Logo 02 "the closed room",
v1 · 2026-06) to the app: the accent moved from generic blue to the brand **teal**, and the
placeholder blue-diamond `◈` became the **sealed-room mark** (a rounded square holding a
single centre dot). **Renderer + static-assets + design-token work only** — no backend, IPC,
persistence, schema, security, CSP, permission, encryption, or packaging-runtime changes; the
only non-renderer touches were the vendored brand image assets, the `generate-icons.mjs`
pipeline, and the dark-theme pre-paint colour was deliberately left alone. The app stays fully
offline (assets vendored same-origin, no web fonts). This record condenses the former
`docs/brand-refresh-plan.md` (full original in git history); code/comments cite it as **§13**.
Shipped in six gated phases BR1–BR6; the eyeball captures were reviewed then removed to keep the
repo lean — they are reproducible any time via `apps/desktop/scripts/walk-brand-refresh.mjs`
(after `npm run build`)._

### 13.1 The brand in one line

A **sealed rounded square** (the private room) **holding a single teal dot** (your data) —
offline, contained, calm. The **dot is always teal `#57D0A4`**; the **square ink flips with the
background** (dark ink `#11171F` on light, light ink `#E8EDF2` on dark). Teal means "the user's
stuff staying put", so it stays **rare** — a role accent, never a surface.

### 13.2 Token decisions + the contrast facts they rest on

- **Brand primitives (theme-constant, `tokens.css`):** `--brand-teal #57D0A4`,
  `--brand-teal-hover #48BE92`, `--brand-teal-active #3DAE84`, `--brand-teal-dark #1B7F5F`,
  `--brand-ink-dark #11171F`, `--brand-ink-light #E8EDF2`, `--brand-surface-dark #0E1319`.
- **The central constraint:** bright teal `#57D0A4` on white is **~1.98:1** — it FAILS both the
  4.5:1 text and the 3:1 UI thresholds. So bright teal is **never** text/link/focus/a thin
  boundary on a light surface; light roles use the derived **`--brand-teal-dark #1B7F5F`**.
- **Role re-point** (the old blue ramp `--accent-700/600/500/300` is fully RETIRED):
  `--accent`/`--link`/`--focus`/`--row-selected-bar` = `#1B7F5F` on light, `#57D0A4` on dark.
- **Primary button — the one deliberate exception:** teal fill + **dark-ink** text in BOTH
  themes (not routed through `--accent`, which differs per theme). `#57D0A4`+`#11171F` ≈ **9.98:1**
  (hover `#48BE92` 8.2:1, active `#3DAE84` 6.8:1). **Teal + white is forbidden** (1.98:1).
- **Filled controls:** checkbox/`<progress>` use theme-aware `--accent` (Chromium auto-contrasts
  the checkmark; light dark-teal on a light track / dark bright-teal on a dark track, both ≥3:1).
  The custom **switch-on track** uses `--brand-teal-dark` in BOTH themes because the thumb is
  white `--n-0` — white on dark teal is **5.2:1** (white on bright teal would be 1.98:1).
- **Dark `--bg` nudged `#0f1115 → #0E1319`** (brand-exact; `--text` on it ≈16.9:1). Light surfaces
  unchanged. **Semantic success/error/warning are untouched** — teal never replaces a status colour.
- **Measured ratios (light bg `#f7f8fa` / dark bg `#0E1319`):** link/focus/accent 4.9:1 (light) /
  10.4:1 (dark); selected-bar ≥3:1 both; primary fill+ink 9.98:1; switch-on+thumb 5.2:1.
- **Pinned by a test:** `tests/unit/token-contrast.test.ts` parses `tokens.css`, resolves every
  `var()` chain per theme, and asserts each role pairing AA in both themes — INCLUDING the
  forbidden bright-teal-on-white < 3:1, so the value can't silently drift off the bright hex.

### 13.3 The mark — assets + component

- **Vendored same-origin under `public/brand/`** (offline CSP): `mark-on-{light,dark}.svg`,
  `lockup-on-{light,dark}.svg`, `mark-mono-{ink,white}.svg`. Kit names are **background-inverted**
  (`mark-dark.svg` = a LIGHT square FOR dark bg) — each was opened and its fill confirmed before
  the mandatory semantic rename. Favicon → `public/icon.svg` (theme-adaptive square ink via an
  internal `@media prefers-color-scheme`); app-icon → `build/icon.svg` (light square + teal dot on
  the opaque `#0E1319` surface).
- **`components/BrandMark.tsx`** (`BrandMark` + `BrandLockup`): the theme-correct asset is chosen
  by a **CSS `[data-theme]` pair toggle** (both `<img>` render; `.brand-img-light`/`-dark` show
  one) — **not** a JS theme read, so it works **pre-unlock in the gate** (which follows the OS
  theme via the `data-theme` attribute set at startup). `BrandMark` clamps size ≥16 (dev-warns
  below; the kit's raster floor), bakes clear-space ≥ the dot diameter, and is decorative by
  default. **Asset `src` MUST be RELATIVE** (`brand/…`, not `/brand/…`): the production renderer is
  `loadFile`'d over `file://`, where an absolute path resolves to the filesystem root and renders
  broken; the single-page renderer has no router, so a relative path resolves next to `index.html`
  under both dev (`http://localhost`) and prod (`file://`).
- **Placements:** rail brand slot (`App.tsx`, `size 24`) and the gate (`WorkspaceGate.tsx`,
  `size 36`, above the "HilbertRaum Lite" edition line). **Never inside the chat transcript** — the
  conversation stays the centre of gravity. The `◈` glyph is gone from `src/` entirely.
  **The rail slot is a real Home button** (issue #47, 2026-07-09): a logo heading a column of
  clickable rail items reads as "go Home" by universal convention, so a dead click there erodes
  trust. It shares `navigate('home')` with the labelled Home item, names itself
  `HilbertRaum — Home` (tooltip + `aria-label`, wordmark + destination), and carries
  `aria-current="page"` on Home — but the **visual** active highlight stays on the labelled Home
  row alone, so the rail never shows two lit selections. Hover fill + the global `:focus-visible`
  ring supply the affordance (`.brand` in `styles.css`).

### 13.4 Icon pipeline

`scripts/generate-icons.mjs` renders the rounded-square + centre-dot (`arcTo` corners) on the
opaque `#0E1319` surface (geometry ported from the 512-unit `build/icon.svg`), keeping the offline
`@napi-rs/canvas` draw + the hand-assembled PNG-embedded `.ico` + the `[16,24,32,48,64,128,256]`
size set. `build/icon.{png,ico}` are committed (packaging mustn't depend on running a generator);
`electron-builder.yml` is unchanged (filenames preserved). The window/taskbar icon is
`build/icon.png` via the BrowserWindow `icon` option (dev/Linux) / the embedded `.ico` (packaged
Windows) — not the document favicon.

### 13.5 Verification pattern (this wave)

Per phase: `npm run typecheck` + full vitest from `apps/desktop` (`npm test` — repo-root runs
break renderer matchers) + `npm run build`, then the Playwright `_electron` eyeball walk
(`scripts/walk-brand-refresh.mjs`) across all six screens in BOTH themes AND both locales (EN/DE).
**Eyeball-harness note:** `policy.json` is parsed NESTED at `policy.workspace.encryption_required`
— a flat `{encryption_required}` (as the old §11.4 recipe wrote) is ignored, so the unpackaged
(isDev) build falls back to `plaintext_dev` and BYPASSES the gate; force it with the nested shape
and drive the gate by CSS/`input[type=password]` (locale-independent — the dev machine boots
German). New guards added: `token-contrast.test.ts` (§13.2) and `tests/renderer/BrandMark.test.tsx`
(theme-asset choice, relative src, min-size clamp, clear-space, a11y, asset existence). Final suite:
**1852 passed / 27 skipped**; typecheck + build clean.
