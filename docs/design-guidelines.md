# Design & UI/UX Guidelines — Private AI Drive Lite

**Status:** ADOPTED 2026-06-10. Source: external design research (Claude web, 2026-06-10),
reviewed and adapted to this repo's constraints — adaptations are marked **[adapted]**.
This is the durable reference for all UI work; the phased rollout lives in
[`ui-ux-redesign-plan.md`](ui-ux-redesign-plan.md) (working paper — will be condensed when done).

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
| Thinking block | Single inline collapsed "Thinking…" line while generating (expand → "Reading your documents" / reasoning); auto-collapses when the answer streams. Stop stays available. ARIA live region for streaming. |
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

⚠️ **Contrast fix:** the current accent `#4f8cff` as a button fill with white text is
**3.22:1 — fails AA**. Filled buttons use `--accent-600 #2f6fed`; `#4f8cff` is reserved for
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
