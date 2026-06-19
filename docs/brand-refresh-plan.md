# Brand-refresh plan — apply the HilbertRaum brand kit to the app

**Status: WORKING PAPER (plan only — NOT implemented).** Created 2026-06-19. This is a
planning document per the CLAUDE.md doc-lifecycle rule: it stays a standalone plan file while
the work is open, and once fully implemented its durable decisions fold into
[`design-guidelines.md`](design-guidelines.md) as a §-numbered brand-refresh record and this
file is deleted (full original stays in git history).

**Scope discipline.** Renderer + static-assets + design-token work only. No backend, IPC,
persistence, schema, security, CSP, permission, encryption, or packaging-runtime changes —
the *only* allowed non-renderer touches are (a) vendoring static brand image assets, (b) the
existing `generate-icons.mjs` icon pipeline, and (c) user-facing string literals routed
through the EN/DE i18n catalogs. This mirrors the boundary every prior UI wave held
(design-guidelines §11.2 / §12.2). The brand-kit **website is a dev-time reference only**; the
app must never fetch from it at runtime (offline hard rule).

**Source of truth this plan rests on:** brand kit at
`https://oi-app-i8dij.ondigitalocean.app/brand/` (Logo 02 "the closed room", v1 · 2026-06),
the adopted [`design-guidelines.md`](design-guidelines.md) (binding — this refresh *evolves*
it, it does not replace it), and the repo inventory in §1 below.

---

## 0. The brand in one paragraph

The mark is **a complete, sealed rounded square** (the private room) **holding a single dot at
its exact centre** (your data). Nothing leaves the room. The **dot is always teal `#57D0A4`**;
the **square ink changes with the background** (dark ink `#11171F` on light surfaces, light ink
`#E8EDF2` on dark surfaces). That metaphor is *exactly* the product's existing posture —
offline, sealed, local, calm — so this is an evolution, not a pivot. The headline visual change
is: **the accent moves from generic blue (`#2f6fed` family) to HilbertRaum teal**, used rarely
and meaningfully, and **the placeholder blue-diamond `◈` mark becomes the sealed-room mark**.

---

## 1. Current-state audit (grounded in the repo)

### 1.1 Colours / design tokens

- **`apps/desktop/src/renderer/tokens.css`** — the single token source. Shared ramps
  (`--n-0…--n-950`, `--accent-300/500/600/700`, success/error/warning) are **theme-constant**;
  **role tokens** are defined under `:root` (light) and overridden under `[data-theme='dark']`
  (dark). The accent today is blue:
  - `--accent-700:#2257c9` (link on light / pressed) · `--accent-600:#2f6fed` (**primary fill,
    white text 4.55:1**) · `--accent-500:#4f8cff` (accent/link/focus on dark) · `--accent-300:#8fb4ff`.
  - Light roles: `--accent:var(--accent-600)`, `--link:#2257c9`, `--focus:#2f6fed`,
    `--row-selected-bar:var(--accent-600)`.
  - Dark roles: `--accent:var(--accent-500)`, `--link:#4f8cff`, `--focus:#4f8cff`,
    `--row-selected-bar:var(--accent-500)`.
  - Neutrals/surfaces: light `--bg:#f7f8fa` `--surface:#fff`; dark `--bg:#0f1115`
    `--surface:#171a21` `--surface-2:#1d212a`. **Note:** dark `--bg #0f1115` is *very close* to
    brand `Surface — dark #0E1319` — a near-zero-cost brand alignment (§3.3).
  - Typography is **system stacks, no web fonts** (`--font-sans`/`--font-mono`); brand kit
    requires no font, so this stays unchanged.
- **`apps/desktop/src/renderer/styles.css`** (~1724 lines) — every rule is expressed in role
  tokens (the only raw colour is white text on accent fills). This is what makes the token swap
  tractable: change the role-token *values*, not the rules.

### 1.2 Logo / icon / favicon assets

- **In-app placeholder mark:** the literal glyph `◈` — `App.tsx:211`
  (`<span className="brand-mark">◈</span>`, accent-coloured) in the nav rail, and the gate mark
  (`.gate-brand-mark`, `WorkspaceGate.tsx`). Both are the *blue diamond*, not the brand mark.
- **App/favicon assets (a blue diamond, `#2f6fed`, transparent bg):**
  - `apps/desktop/src/renderer/public/icon.svg` (favicon, 64-unit viewBox, two `<path>`
    diamonds) — referenced by `index.html` (`<link rel="icon" type="image/svg+xml" href="/icon.svg">`).
  - `apps/desktop/build/icon.svg` / `build/icon.png` (512) / `build/icon.ico` (multi-size).
  - **Icon pipeline:** `apps/desktop/scripts/generate-icons.mjs` renders the diamond geometry
    with `@napi-rs/canvas` (offline; a pdfjs transitive dep) and hand-assembles the `.ico` —
    `const ACCENT='#2f6fed'` and a `diamond()` path. **This script is the icon source of truth**
    and must be rewritten to render the sealed-room mark (§4.4).
- **Icon component:** `apps/desktop/src/renderer/components/Icon.tsx` — a monochrome line-icon
  set using `currentColor` (`home`, `chat`, `file`, `brain`, `settings`, `lock`, `lock-open`,
  `refresh`, `puzzle`). The brand mark is **not** one of these and should stay separate (§4.5).
- **Packaging:** `apps/desktop/electron-builder.yml` — `directories.buildResources: build`;
  electron-builder auto-picks `build/icon.ico` (win) / `build/icon.png` (mac/linux). **No YAML
  edit needed** if we keep the `build/icon.*` filenames; only the *contents* change.

### 1.3 Shell, nav, indicator, screens, dialogs

- **App shell / nav rail:** `App.tsx` + `styles.css` `.app-shell{grid-template-columns:100px 1fr}`,
  `.sidebar`, `.nav-item`, `.nav-icon{color:var(--accent)}`. Nav icons are accent-coloured today
  (design-guidelines §12.1 #1).
- **Ambient privacy signal:** `components/LocalIndicator.tsx` — the single app-wide signal at the
  **rail foot** (`variant="sidebar"`), closed/open padlock + short label ("Offline" / "Downloads
  on"), muted (state, not accent). Helpers `localIndicatorLabel/ShortLabel/Detail`. This is the
  closest existing thing to the "closed room" metaphor (§2.3).
- **Workspace gate / first-run:** `screens/WorkspaceGate.tsx` (`.gate-brand`, `.gate-card`,
  3-step create path, single unlock screen). Gate **follows OS theme only** (settings unreadable
  pre-unlock — design-guidelines §11.2 / D-UI2): brand mark here must be **theme-aware via CSS**,
  not via the settings store.
- **Screens:** `screens/{HomeScreen,ChatScreen,DocumentsScreen,ModelsScreen,SkillsScreen,SettingsScreen}.tsx`
  (Settings has General / Privacy & data / Diagnostics tabs).
- **Primitives:** `components/{Button,Dialog,Modal,...}.tsx` + Radix-based menus/popovers; the
  **global focus ring** is `styles.css` `:focus-visible{outline:2px solid var(--focus);outline-offset:2px}`.
- **Theme mechanism:** `renderer/theme.ts` sets `[data-theme]` on `<html>`
  (`resolveTheme`/`initTheme`/`setThemeSetting`); Settings Appearance is `system|light|dark`,
  default `system`. **The brand refresh changes token values, not this mechanism.**

### 1.4 i18n

- `apps/desktop/src/shared/i18n/en.ts` (source of truth) + `de.ts` (typed `Record<keyof typeof en, string>`,
  informal „du", glossary pinned in a header comment). Any new visible copy goes through **both**.

### 1.5 Visual review (eyeball) + tests that must stay green

- **Eyeball walks:** `apps/desktop/scripts/walk-*.mjs` (Playwright `_electron`), e.g.
  `walk-home-privacy-aimodel.mjs`, `walk-docs-subnav.mjs`, `walk-rail-and-failed.mjs`,
  `walk-skills-composer.mjs`, `walk-docs-refinement.mjs`. Output under
  `docs/design-review/<area>/`. Recipe (design-guidelines §11.4): strip `ELECTRON_RUN_AS_NODE`,
  clear localStorage after first window, `emulateMedia` for theme, write
  `config/policy.json{encryption_required:true}` to exercise the gate. (The `electron-eyeball-driver`
  memory has the working harness details.)
- **Tests to preserve unchanged in behaviour** (update assertions only where a value legitimately
  changes): `tests/renderer/Theme.test.tsx`, `tests/renderer/Components.test.tsx`,
  `tests/renderer/WorkspaceGate.test.tsx`, the `InformationArchitecture` indicator test,
  `tests/unit/rail-labels.test.ts`, `tests/unit/copy-tone.test.ts`, and the i18n parity tests.
- **Run vitest from `apps/desktop`** (`npm test`) — repo-root runs break renderer matchers
  (memory: `run-vitest-from-desktop-workspace`).

---

## 2. Brand interpretation

### 2.1 How "the closed room" maps into the UI

- **The mark = the product's identity surface** (rail brand slot, gate, favicon, app icon,
  about/empty brand placement). It is the *one* place the sealed-room metaphor is stated
  literally. Everywhere else the metaphor is expressed *structurally*, not by drawing more
  squares-with-dots.
- **Teal = "your data / the live, private thing"** — so teal belongs on: the logo dot (always),
  the one primary action, restrained active/selected accents, and the local/offline reassurance.
  Teal is the colour of *the user's stuff staying put*, which is why it must stay rare.
- **The sealed rounded square = containment** — already echoed by the app's rounded cards,
  contained panels, and the rail-foot padlock. We lean into that *subtly* (consistent radii,
  the selected-row left-bar in teal) without turning components into logo imitations.

### 2.2 What changes vs. what stays

| Changes | Stays |
|---|---|
| Accent role tokens: blue → teal-derived set (§3) | Neutral ramp, surfaces, typography, spacing, radius, shadow, motion |
| The `◈` placeholder → sealed-room `BrandMark` (§4) | The `[data-theme]` theme mechanism + Settings Appearance |
| `icon.svg` / `build/icon.*` / `generate-icons.mjs` geometry + colour | electron-builder.yml (filenames kept) |
| Nav-icon / focus / link / selected-accent *colour* | Nav layout, IA (Home·Chat·Documents·AI Model·Skills ‖ Settings), §3 chat layout |
| Primary button: blue fill+white text → teal fill+dark-ink text (§3.4) | Three-button-level system, one-primary-per-view, all component anatomy |
| Dark `--bg` nudged `#0f1115`→`#0E1319` (optional, §3.3) | Light `--bg #f7f8fa` (unchanged) |

### 2.3 Risk of overusing the dot / metaphor

The single biggest failure mode is **"brand theatre"**: teal dots sprinkled across the UI,
teal-filled regions, a loud logo inside the chat transcript, the padlock turned into a marketing
moment. Guardrails baked into this plan: **teal stays a role accent, never a surface**; the mark
appears in identity slots only and **never inside the chat transcript**; the local indicator
stays *quieter*, not louder (no security theatre — design-guidelines §1.2). A concrete acceptance
gate (§7) is "teal not overused" judged by the eyeball pass.

---

## 3. Design-token plan

All edits in `tokens.css`. **Strategy: add brand primitives, then re-point the existing
`--accent*` / `--link` / `--focus` / selected-accent role tokens at teal-derived values.** Because
`styles.css` already consumes role tokens, almost nothing in `styles.css` changes.

### 3.1 Brand primitives (new, theme-constant)

```css
--brand-teal:        #57D0A4;  /* the dot; bright teal — for dark bg & fills only */
--brand-ink-light:   #E8EDF2;  /* square on dark */
--brand-ink-dark:    #11171F;  /* square on light; ALSO the text on teal fills */
--brand-surface-dark:#0E1319;  /* brand icon/social background */
--brand-teal-dark:   #1B7F5F;  /* DERIVED for light-mode links/focus — see 3.2; verify in test */
```

### 3.2 Contrast math (already computed — do not re-derive; the token test re-verifies)

- **`#57D0A4` on white ≈ 1.9:1** → fails text **and** the 3:1 UI/large threshold. **Teal must
  never be text, a link, a focus ring, or a thin boundary on a light surface.** This is the
  central constraint.
- **`#57D0A4` on dark surface `#0E1319` ≈ 9.8:1** → excellent. Teal is safe as link/focus/accent
  text on dark, used sparingly.
- **`#57D0A4` fill + `#11171F` dark-ink text ≈ 9.5:1** → the primary-button pairing (§3.4).
  (White text on `#57D0A4` ≈ 1.9:1 — **forbidden**.)
- **Derived `--brand-teal-dark #1B7F5F` on light `#f7f8fa` ≈ 4.6:1** → passes AA text; use for
  **light-mode links and the light-mode focus ring** (also clears 3:1 as a focus boundary).
  Implementer: treat `#1B7F5F` as the *starting* value and let the token-contrast test (§9) pick
  the final hex if it needs nudging darker.

### 3.3 Surface / neutral direction

- **Light:** keep `--bg #f7f8fa`, surfaces, neutrals **unchanged** (calm light neutral already
  reads brand-appropriate). Do **not** tint surfaces teal.
- **Dark:** **optionally** nudge `--bg #0f1115 → #0E1319` (brand `Surface — dark`) and re-verify
  the dark text pair (`--text #e6e8ec` on `#0E1319` ≈ 15.6:1, still ✓). This is a 1-LSB shift that
  buys exact brand alignment for free; if any dark contrast pairing regresses in the token test,
  drop it — it's a nicety, not load-bearing. Cards stay readable via `--surface`/`--surface-2`
  + borders (no glass/blur).

### 3.4 Role-token mapping (the actual swap)

| Role token | Light → new | Dark → new | Note |
|---|---|---|---|
| `--accent` | `var(--brand-teal-dark)` `#1B7F5F` | `var(--brand-teal)` `#57D0A4` | accent text/icon usage; dark can use bright teal directly |
| `--link` | `#1B7F5F` (4.6:1) | `#57D0A4` (9.8:1) | replaces `#2257c9` / `#4f8cff` |
| `--focus` | `#1B7F5F` | `#57D0A4` | focus ring; both clear 3:1 on their bg |
| `--row-selected-bar` | `#1B7F5F` | `#57D0A4` | the selected-row LEFT BAR (≥3:1 UI on both) |
| **Primary button fill** | `--brand-teal #57D0A4` | `--brand-teal #57D0A4` | **with `--brand-ink-dark #11171F` text**, both themes |
| Nav-icon colour | keep accent role, now teal | keep accent role, now teal | inherits the swap automatically |

- **Primary button is the one deliberate departure from "role token does it automatically":**
  today it's `--accent-600` fill + **white** text. The new primary is **teal fill + dark-ink
  text** in *both* themes (teal+white fails). Implement as an explicit `.btn.primary` rule using
  `--brand-teal` / `--brand-ink-dark`, NOT by routing through `--accent` (which differs per theme).
  Keep "one primary per view" (design-guidelines §6).
- **Hover/active/focus variants — define explicitly and verify:**
  - Primary fill **hover** ≈ `#48BE92` (slightly deeper), **active/pressed** ≈ `#3DAE84`; dark-ink
    text keeps ≥7:1 on all three. Verify each in the token test before committing the hex.
  - Light link/focus **hover** ≈ a touch darker than `#1B7F5F` (e.g. `#16good`→ pick so it stays
    ≥4.6:1). Dark link **hover** ≈ `#6FDAB4`.
  - Selected-row **fill** stays the existing neutral `--row-selected-bg` (NOT teal) — only the
    *bar* is teal. Selection must stay distinct from the `:focus-visible` ring (design-guidelines
    §11.6 #4 / §12.1 #3).
- **Semantic colours (success/error/warning) are untouched.** Teal never replaces a status colour.
- **Keep the old `--accent-600 #2f6fed` ramp value defined** only if something still references it;
  otherwise retire it. Grep `accent-600`/`accent-500`/`accent-700`/`accent-300` and re-point or
  remove. Do **not** leave a half-blue, half-teal accent set.

### 3.5 Forced-colors / reduced-motion

`prefers-reduced-motion` and Windows High-Contrast handling are unchanged — but **re-verify** the
focus ring still uses an `outline` (it does) so HC mode keeps it, and that no teal value is the
*sole* status signal (it isn't — semantics keep icon+word, design-guidelines §9).

---

## 4. Logo and asset plan

### 4.1 Vendoring location + what's source-controlled

- **Vendor source SVGs** into `apps/desktop/src/renderer/public/brand/` (served same-origin →
  satisfies the strict offline CSP, like the current `public/icon.svg`):
  - `mark-on-dark.svg`  ← from kit `mark-dark.svg` (light square `#E8EDF2` + teal dot)
  - `mark-on-light.svg` ← from kit `mark-light.svg` (dark square `#11171F` + teal dot)
  - `lockup-on-dark.svg` ← `lockup-dark.svg` · `lockup-on-light.svg` ← `lockup-light.svg`
  - (optional) `mark-mono-ink.svg`, `mark-mono-white.svg` for single-colour contexts.
  - **Semantic rename is mandatory** — the kit names are *background-semantic and confusing*
    (`mark-dark.svg` is a **light** square *for dark backgrounds*). **Open each SVG and confirm
    the actual `fill`/`stroke` before mapping** (the task's caution; the kit page confirms
    `mark-dark`=light-square, `mark-light`=dark-square, but verify at vendor time).
- **Replace the favicon + raster icons:**
  - `apps/desktop/src/renderer/public/icon.svg` → the sealed-room favicon (kit `favicon.svg`,
    re-saved same-origin; keep the `index.html` reference and filename so no HTML/CSP change).
  - `build/icon.svg` → the app-icon artwork (kit `app-icon.svg`: teal dot on `#0E1319` surface).
  - `build/icon.png` (512) and `build/icon.ico` are **generated** by the pipeline (§4.4) — they
    may be committed (they are product static assets, like today) **or** gitignored as
    derivatives. **Recommendation: keep committing them** (matches current repo state; packaging
    must not depend on running a generator). They are static product assets, not model/user
    data — appropriate to commit (CLAUDE.md only forbids weights/user-data/embeddings/logs).
- **Do not** vendor `og-image.*`, `site.webmanifest`, `apple-touch-icon.png`, PWA `icon-192/512`,
  `maskable*` — they are web/PWA assets with no surface in this Electron app. Skipping them avoids
  dead files and a misleading webmanifest.

### 4.2 `BrandMark` / `BrandLockup` component (new, tiny, renderer-only)

`apps/desktop/src/renderer/components/BrandMark.tsx`:

- `BrandMark({ size=24, title?, decorative=true })` renders an `<img>` of the **theme-correct**
  source: pick `mark-on-light.svg` vs `mark-on-dark.svg`. **Theme selection must be CSS/attribute
  driven, not JS settings-driven**, because the gate renders pre-unlock (no settings). Two robust
  options — choose one:
  1. Render **both** images and toggle visibility with `[data-theme='dark']` CSS (works pre- and
     post-unlock; no JS theme read). **Preferred** — simplest, gate-safe.
  2. Inline the SVG and drive square fill from `currentColor`/a CSS var; risk: the kit SVGs ship
     fixed fills, and the task says don't override fixed fills with CSS unless that's the intended
     mechanism. Option 1 avoids that entirely.
- `decorative` → `alt=""` + `aria-hidden`; when `title` given → `role="img"` + `aria-label`.
- **Enforce minimums in the component:** clamp `size` to **≥16px** (brand min); below 16 the kit
  says use raster favicons — but in-app we never render below 16, so just clamp + dev-warn.
  Reserve **clear space ≥ the inner-dot diameter** via padding baked into the wrapper.
- `BrandLockup({ variant })` — same theme-pair trick for `lockup-on-*`; use **only where there's
  horizontal room** (gate, maybe Home/about), never in the rail (too wide for 100px).

### 4.3 Where the mark goes (replace the `◈`)

| Surface | Asset | Notes |
|---|---|---|
| Nav rail brand slot (`App.tsx:211`) | `BrandMark size≈22–24` | replaces `<span className="brand-mark">◈`; keep `title="HilbertRaum"` + visually-hidden `.brand-name` for a11y |
| Workspace gate (`WorkspaceGate.tsx` `.gate-brand`) | `BrandLockup` (lockup) if width allows, else `BrandMark size≈34` | gate is theme-aware via CSS only (pre-unlock) |
| Home | optional `BrandLockup` or nothing | only if it aids recognition without clutter (design-guidelines §11.3 — Home is the readiness hub, keep it functional) |
| Chat transcript | **nothing** | never a large brand mark inside the conversation (centre of gravity) |
| About / empty brand placement | `BrandMark`/`BrandLockup` | wherever an identity moment already exists |
| Favicon / window icon | `public/icon.svg` + `build/icon.*` | via §4.1/§4.4 |

### 4.4 Icon pipeline rewrite (`scripts/generate-icons.mjs`)

- Rewrite the geometry from the `diamond()` path to the **sealed rounded square + centre dot**;
  set the artwork to the **app-icon** treatment (kit `app-icon.svg`: **teal dot `#57D0A4` on
  `#0E1319` surface**, light/ink square per the app-icon's own design — match the kit's
  `app-icon.svg` exactly; the OS icon has its own opaque background, unlike the transparent
  in-app mark). Keep the offline `@napi-rs/canvas` + hand-assembled `.ico` approach and the
  `[16,24,32,48,64,128,256]` size set.
- **Simplest robust route:** rather than re-implementing the path in canvas commands, render the
  vendored `app-icon.svg` to PNG. If `@napi-rs/canvas` can `loadImage` an SVG buffer, draw it at
  each size; otherwise port the square+dot path (rounded-rect + circle) into canvas calls. Keep
  the script fully offline and re-runnable: `node apps/desktop/scripts/generate-icons.mjs`.
- Update the script's header comment (it currently documents the diamond).
- `electron-builder.yml` needs **no change** (filenames preserved). The
  `tests/integration/packaging.test.ts` `@napi-rs/canvas` exclusion is unaffected.

### 4.5 Usage rules to encode

Never recolour the dot · never fill the square teal · never stretch/distort/rotate/redraw/add
effects · never below 16px · never on low-contrast backgrounds · always clear space ≥ dot
diameter · always the theme-correct ink variant.

---

## 5. Screen-by-screen plan

For each: **change / intentionally-keep / files / i18n / acceptance (both themes)**. Default
acceptance for every screen: nav-icon/link/focus/selected accents now read teal, **no teal text on
a light surface anywhere**, primary button is teal+dark-ink and passes contrast, layout unchanged.

### 5.1 Workspace gate / first-run / unlock
- **Change:** `.gate-brand-mark` `◈` → `BrandMark`/`BrandLockup` (theme-aware via CSS).
- **Keep:** 3-step create flow, strength meter, paste/WCAG-3.3.8, the single calm unlock screen,
  copy. Gate follows OS theme only — verify mark flips with `emulateMedia`.
- **Files:** `WorkspaceGate.tsx`, `styles.css` (`.gate-brand*`), new `BrandMark`.
- **i18n:** none (no copy change).
- **Accept:** mark renders correct ink in light **and** dark; clear space respected; nothing
  below 16px; gate reads calm/premium.

### 5.2 App shell + nav rail
- **Change:** rail brand `◈` → `BrandMark`; nav-icon colour now teal (via `--accent`). Rail-foot
  `LocalIndicator` stays muted (consider a closed-room nuance only if it stays *quieter*, §5.8).
- **Keep:** 100px grid, icon-over-label, active = soft neutral fill (NOT accent fill —
  design-guidelines §12.1 #1), rail labels one-line (`rail-labels.test.ts`).
- **Files:** `App.tsx`, `styles.css` (`.brand*`, `.nav-icon`).
- **Accept:** one mark top-of-rail; teal nav icons read calm not loud; active item still neutral
  fill; `rail-labels` test green.

### 5.3 Home (readiness hub)
- **Change:** accent reads teal; **adaptive hero primary** (design-guidelines §11.7) is now
  teal+dark-ink. Optional small `BrandLockup`.
- **Keep:** readiness hub behaviour, adaptive CTA logic, badges, preflight copy.
- **Files:** `HomeScreen.tsx` (only if a lockup is added), `styles.css`.
- **Accept:** exactly one loud (teal) primary; needs-model vs ready states both read calm.

### 5.4 Chat
- **Change:** focus ring / links / send button accent → teal; selected history row bar → teal.
- **Keep — emphatically:** **no brand mark in the transcript**; "You"/"HilbertRaum" labels;
  borderless assistant turns; composer-as-one-unit; segmented control; streaming/Thinking line.
- **Files:** `styles.css` (accent-consuming rules inherit automatically), `chat/*` only if a hard
  colour leaked.
- **Accept:** conversation stays the centre of gravity; teal appears only on focus/send/selection;
  user-turn tint stays neutral (not teal).

### 5.5 Documents
- **Change:** selected-row left-bar + accents → teal (inherits `--row-selected-bar`).
- **Keep:** compact rows, ⋯ overflow, badge cluster (one green readiness badge — **success stays
  green, not teal**), uniform neutral chips, selection toolbar, sub-nav groups.
- **Files:** `styles.css` (token-driven; likely zero rule edits).
- **Accept:** status green unchanged; selected-bar teal ≥3:1 both themes; no teal chips.

### 5.6 AI Model
- **Change:** accents/primary → teal; download progress bar accent → teal (verify the teal
  progress fill reads ≥3:1 on its track both themes; if light-mode bright teal on a light track is
  weak, the bar may need `--brand-teal-dark` in light).
- **Keep:** cards, "Technical details" disclosure, "Try in demo mode" copy, per-card button logic.
- **Files:** `styles.css` (progress), `ModelsScreen.tsx` only if needed.
- **Accept:** progress visible in both themes; "Technical details" unchanged.

### 5.7 Skills
- **Change:** accents → teal (inherited).
- **Keep:** capability-library layout (first-class destination).
- **Files:** `styles.css` (inherited).
- **Accept:** import/enable affordances read teal-accented, calm.

### 5.8 Settings — incl. Privacy & data / Diagnostics
- **Change:** Appearance `SegmentedControl`, toggles (switch track on = teal), links → teal.
- **Keep:** General/Privacy/Diagnostics tabs, the `system|light|dark` control wiring (mechanism
  unchanged), Diagnostics technicality.
- **Privacy & data:** the page that most invites "closed room" reinforcement — but keep it
  **reassuring, not theatrical** (design-guidelines §1.2). At most: the existing padlock copy +
  maybe the mark as a small calm header. **No alarm states, no red, no extra dots.**
- **Files:** `styles.css` (switch/segmented inherit), possibly `PrivacyTab` for a small mark.
- **i18n:** none unless a privacy line is added (then EN+DE).
- **Accept:** switch-on teal track passes 3:1; privacy reads calmer/safer, not advertised-to.

### 5.9 Dialogs / popovers / menus / buttons / inputs / focus rings
- **Change:** `--focus` → teal (light=`#1B7F5F`, dark=`#57D0A4`); primary button → teal+dark-ink;
  menu `[data-highlighted]` stays neutral `--surface-hover` (not teal).
- **Keep:** modal anatomy (focus trap, Esc, primary-right), three button levels, input borders.
- **Files:** `styles.css` (`:focus-visible`, `.btn.primary`, `.menu-item`, inputs).
- **Accept:** focus ring visible ≥3:1 on all surfaces both themes; HC mode keeps the outline.

### 5.10 Empty / error / notice / citation UI
- **Change:** link/accent → teal; citation "▸ Sources (N)" disclosure accent → teal.
- **Keep:** honest "not found" states, inline dismissible notices, semantic error colour (NOT
  teal), per-message action row.
- **Accept:** citations read calm; errors stay semantic; no teal on light-surface body text.

---

## 6. Implementation phases (gated)

Each phase ends with the §11.4 ritual: `npm run typecheck` + full vitest from `apps/desktop`
(`npm test`) + `npm run build`, plus the eyeball walk for touched screens, plus a `BUILD_STATE.md`
update. Work on a branch (e.g. `brand-refresh`).

### BR0 — audit + asset inventory (this doc)
- **Intent:** lock decisions so BR1+ don't re-decide. **Files:** this plan. **Verify:** human
  review of §3 contrast values + §4 asset mapping. **Risk:** low. **Rollback:** delete the doc.

### BR1 — vendor assets + icon pipeline
- **Intent:** bring the SVGs in-repo (semantic names), rewrite `generate-icons.mjs`, regenerate
  `build/icon.*`, swap `public/icon.svg`. **No UI wiring yet.**
- **Files:** `public/brand/*`, `public/icon.svg`, `build/icon.svg`, `scripts/generate-icons.mjs`,
  generated `build/icon.{png,ico}`.
- **Verify:** `node scripts/generate-icons.mjs` runs offline & writes valid ico/png; favicon shows
  in the dev window; `packaging.test.ts` green. **Risk:** ico assembly. **Rollback:** revert the
  asset commit (old diamond stays in git history).

### BR2 — tokens + theming + contrast tests
- **Intent:** brand primitives + role-token swap (§3); optional dark-bg nudge.
- **Files:** `tokens.css`, **new** `tests/.../token-contrast.test.ts` (§9), update
  `Theme.test.tsx` only if a tested value changed.
- **Verify:** token-contrast test green for every role pairing both themes; visual diff of one
  screen each theme. **Risk:** a derived-teal value failing AA. **Rollback:** revert tokens.css.

### BR3 — `BrandMark`/`BrandLockup` + shell/nav/gate
- **Intent:** wire the mark into rail + gate; remove `◈`.
- **Files:** `components/BrandMark.tsx`, `App.tsx`, `WorkspaceGate.tsx`, `styles.css`
  (`.brand*`, `.gate-brand*`), new `tests/.../BrandMark.test.tsx`.
- **Verify:** mark flips correctly by theme (incl. pre-unlock gate via `emulateMedia`); min-size
  + clear-space asserted; `rail-labels`/`WorkspaceGate` tests green. **Risk:** theme-pair CSS in
  the gate. **Rollback:** restore `◈` spans.

### BR4 — screen pass
- **Intent:** confirm Home/Chat/Documents/AI Model/Skills/Settings inherit cleanly; fix any
  leaked hard colours; teal progress-bar contrast.
- **Files:** mostly none beyond `styles.css`; targeted screen files only where a colour leaked.
- **Verify:** eyeball walk all six screens both themes both locales; update any assertion that
  legitimately moved. **Risk:** a screen with an inline blue. **Rollback:** per-file revert.

### BR5 — package icon / favicon smoke
- **Intent:** confirm the produced icon set is correct end-to-end.
- **Files:** none (consumes BR1 output). **Verify:** `build/icon.ico` opens with all sizes; dev
  window + favicon show the mark; (manual, network-touching) optional `npm run package:win` smoke
  per docs/packaging.md if a packaging owner runs it. **Risk:** low. **Rollback:** rerun BR1.

### BR6 — tests, eyeball, docs
- **Intent:** finalise guards, full eyeball review, fold the record into design-guidelines, update
  BUILD_STATE.
- **Files:** new `scripts/walk-brand-refresh.mjs`, `docs/design-guidelines.md` (brand record),
  `BUILD_STATE.md`. **Verify:** full green gate + eyeball checklist (§8) signed off. **Risk:** low.

---

## 7. Acceptance criteria (checklist)

- [ ] Light **and** dark both pass the full token-contrast test.
- [ ] Mark renders the **dark-ink** square on light surfaces, **light-ink** square on dark.
- [ ] Dot is exactly `#57D0A4` everywhere; never recoloured.
- [ ] Mark never stretched / distorted / rotated / redrawn / effected.
- [ ] Mark never below 16px; clear space ≥ dot diameter preserved.
- [ ] Primary buttons = teal fill + dark-ink text, pass ≥4.5:1; focus rings pass ≥3:1 both themes.
- [ ] **No teal text/links/thin boundaries on any light surface** (only `--brand-teal-dark`).
- [ ] Teal stays rare (eyeball: not overused); success stays green, error stays red.
- [ ] No new runtime network dependency; no CSP/offline-guard widening; no schema/IPC change.
- [ ] EN and DE both valid (any new copy in both; `copy-tone` + i18n parity green).
- [ ] `npm run typecheck`, `npm test` (from `apps/desktop`), `npm run build` all green; eyeball
      review passed.
- [ ] App still reads calm / premium / privacy-forward — not marketing-loud.

---

## 8. Eyeball visual-review plan

New `apps/desktop/scripts/walk-brand-refresh.mjs` following the §11.4 recipe (strip
`ELECTRON_RUN_AS_NODE`, clear localStorage after first window, `emulateMedia` per theme, write
`config/policy.json{encryption_required:true}` to hit the gate). Capture **both themes × both
locales (EN/DE)** for:

- workspace gate / first-run (mark + lockup, theme-flipped)
- Home needs-model **and** ready (one teal primary each)
- Chat empty state **and** a message + "▸ Sources (N)" citation state (confirm **no** mark in
  transcript)
- Documents empty, indexed list (selected-row teal bar; green readiness badge unchanged),
  selected-project if practical
- AI Model cards + "Technical details" disclosure + download progress (teal bar contrast)
- Skills screen
- Settings → Privacy & data **and** Diagnostics (switch-on teal track)
- a dialog/popover/menu open (teal focus ring, neutral menu highlight)

Output under **`docs/design-review/brand-refresh/`** (`before/` from current master, `after/`).
Ask eyeball to judge against the brand constraints: **mark correct by theme · mark not distorted ·
teal not overused · contrast OK · still calm/premium/offline-private · no accidental neon/marketing
feel.** Then a **manual human-review checklist** on the final captures: dot is teal & centred,
square ink matches background, clear space intact, no teal-on-white text, focus rings visible, DE
labels fit, primary buttons legible, privacy screen reads reassuring (not theatrical).

---

## 9. Tests & guards

- **New `token-contrast.test.ts`** — compute WCAG contrast for every role-token pairing in **both**
  themes (text-on-bg, text-on-surface, primary-fill-vs-its-text, focus-vs-bg, selected-bar-vs-row);
  assert ≥4.5:1 (text) / ≥3:1 (UI). This both verifies and **pins** the derived teal values, so a
  later careless edit can't silently fail AA. (The repo has no contrast test today — this is the
  most valuable new guard.)
- **New `BrandMark.test.tsx`** — asserts the theme-correct asset is chosen for light vs dark, min
  size is clamped ≥16, decorative vs labelled a11y wiring, and that `public/brand/*` imports
  resolve (asset-existence guard).
- **`copy-tone.test.ts`** — extend only if new copy is added (e.g. a privacy line); otherwise
  unchanged.
- **i18n parity** — if any key is added, EN+DE both carry it (existing parity test enforces).
- **Preserve unchanged:** `Theme.test.tsx`, `Components.test.tsx`, `WorkspaceGate.test.tsx`,
  `rail-labels.test.ts`, `InformationArchitecture` indicator test — update an assertion only when a
  value legitimately changed (e.g. a hex), never the behaviour.
- **Gate:** `npm run typecheck` · `npm test` (from `apps/desktop`) · `npm run build` ·
  `packaging.test.ts` green after the icon-pipeline change.

---

## 10. Docs / BUILD_STATE update plan

- After implementation completes, add a **condensed brand-refresh design record** as a new
  §-numbered section of [`design-guidelines.md`](design-guidelines.md) (decisions + the contrast
  facts they rest on + as-built file list + the eyeball pattern), in the same style as §11/§12.
- Update `BUILD_STATE.md` after **each** BR phase (status, decisions, data contracts unchanged,
  next actions, risks).
- Per the CLAUDE.md lifecycle rule, once BR6 lands and the record is folded in, **delete this plan
  file** (full original stays in git history). Until then it stays a working paper.

---

## 11. Open questions for human review (before BR1)

1. **Dark-bg nudge `#0f1115 → #0E1319`?** Tiny brand-exact alignment; drop if any dark pairing
   regresses. (Recommendation: do it — it's ~free.)
2. **Final `--brand-teal-dark` value** — `#1B7F5F` computes ~4.6:1 on light; accept that or let the
   token test pick a slightly darker hex for headroom?
3. **Commit `build/icon.{png,ico}` or gitignore as derivatives?** (Recommendation: keep committing
   — matches current repo + packaging mustn't depend on running a generator.)
4. **Lockup on Home?** Optional brand moment vs. keeping Home purely functional. (Recommendation:
   small lockup only if the eyeball pass shows it adds recognition without clutter.)
5. **Any in-app surface for the `og-image`/PWA assets?** This plan skips them as web-only — confirm
   no future web/landing surface needs them vendored here.
