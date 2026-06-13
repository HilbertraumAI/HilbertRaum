# Internationalization (i18n) plan — English + German UI (Phases 39–42)

_Status: **WORKING PAPER — drafted 2026-06-13. Phase 39 (foundation + proof slice) and
Phase 40 (renderer sweep) are DONE 2026-06-13; Phases 41–42 are open.** Per the CLAUDE.md doc lifecycle rule this
file exists while the work is open; on completion it gets condensed
into a design record (likely a new § in `architecture.md` + a `design-guidelines.md`
update for the German microcopy rules) and deleted. Phase numbering continues at **39**
(22 = signed updates and 30 = big slot are open but reserved). Decisions use the scoped
prefix **D-L#** (precedent: D-UI1–4) to avoid the D-number collision between the wave-3
and big-slot papers._

**Goal:** the entire user-visible surface is available in **English and German**, with
the language selectable in **Settings → General** (default: follow the OS). First-run /
unlock (the pre-settings gate) must already render in the right language. No new
runtime dependencies, no network, no behavior changes outside copy.

| Phase | Scope | Size | Hard dependency |
|---|---|---|---|
| 39 | ✅ DONE 2026-06-13 — i18n foundation: shared `t()` module + catalogs, `uiLanguage` setting + picker, pre-unlock resolution; App shell + Settings + WorkspaceGate migrated as the proof slice | M | none |
| 40 | ✅ DONE 2026-06-13 — Renderer string sweep: all remaining screens/components, pluralization, dates/numbers | L (mechanical) | 39 |
| 41 | Main-process boundary: transient errors/notices localized at emission; persisted-string display map; native dialog titles | M | 39 |
| 42 | German QA: full `de` review pass (Sie/glossary), text-expansion layout audit + eyeball walk, docs + known-limitations | M | 40 + 41 |

Recommended order: 39 → (40 ∥ 41) → 42. 40 and 41 touch disjoint files and can run as
parallel tracks after the foundation lands.

---

## 1. Hard rules inherited (bound every choice below)

- **Offline, no network, no telemetry.** Catalogs are bundled statically; nothing is
  fetched at runtime. This rules out any i18n library default that lazy-loads locale
  resources over HTTP.
- **Pure-JS, minimal-deps theme** (`node:sqlite` / `@noble/hashes` precedent): prefer a
  small hand-written, unit-tested module in `shared/` over a framework dependency.
- **Friendly copy (spec §11.4)** applies in *both* languages — the German translation
  must carry the same tone ("pick a smaller model — quality stays great", never "your
  hardware is bad"), not be a literal word-for-word rendering.
- **Locked contracts stay locked:** the `PDF_SCAN_DETECTED_MESSAGE` exact-string
  contract (§2 fact 4), the Phase-3 streaming contract, async-with-polling jobs, the
  audit-log privacy rule (ids/filenames/counts, never content — a language code is fine,
  translated content is not).
- **Settings live inside the possibly-encrypted DB** and are unreadable pre-unlock —
  the gate cannot depend on a stored setting (theme precedent D-UI2).
- **No behavior change to model quality surfaces:** LLM prompts are pinned (Phase-29
  benchmark comparability) — see D-L6.

## 2. Facts the plan rests on (verified in code 2026-06-13)

1. **There is no i18n today.** No i18n dependency in any workspace `package.json`; all
   user-visible strings are hardcoded inline (JSX literals, label maps, exported
   constants). `index.html` hardcodes `<html lang="en">`.
2. **Scale:** renderer ≈ 41 TS/TSX files — 6 screens, 2 settings tabs, 8 chat
   components, 12 shared components, App shell — roughly **350–450 strings** including
   aria-labels/titles/placeholders and three big label maps (`STATUS_BADGE` in
   `DocumentsScreen.tsx`, `STATE_BADGE` in `ModelsScreen.tsx`, `AUDIT_TYPE_LABELS` ×26
   in `DiagnosticsTab.tsx`). Main process ≈ **60–80 strings**: parser-failure constants
   (`services/ingestion/parsers/*.ts`), document-task messages (`services/doctasks.ts`),
   download/policy refusals (`services/downloads.ts`), IPC guard errors
   (`ipc/registerDocsIpc.ts`), preflight problems (`services/preflight.ts`), GPU
   runtime notices (`main/index.ts`), `NO_DOCUMENT_CONTEXT_ANSWER`
   (`services/rag/index.ts`), two `dialog.showOpenDialog` titles.
3. **Settings pattern is established:** `AppSettings` + `DEFAULT_SETTINGS` in
   `shared/types.ts`; defaults-merge on read means a new key needs **no migration**;
   enum keys get an exact-value guard in `services/settings.ts` `updateSettings()`
   (the `theme`/`gpuMode` precedent); renderer reads/patches via
   `api.getSettings`/`api.updateSettings`; the Settings picker pattern is the
   `THEME_CHOICES` array + `SegmentedControl` (`SettingsScreen.tsx`).
4. **Two string contracts constrain where translation may happen:**
   - `scanDetected` is derived by **exact-matching the persisted** `documents.error_message`
     against `PDF_SCAN_DETECTED_MESSAGE` (`services/ingestion/index.ts:268`; the constant's
     doc comment declares the copy part of the contract). ⇒ what gets *written to the DB*
     must stay canonical, or the OCR offer breaks.
   - IPC rejection flattens to a prose string: custom `Error` properties do **not**
     survive `ipcMain.handle` → the renderer's `friendlyIpcError()`
     (`renderer/lib/errors.ts`) regex-strips Electron's transport prefix from
     `err.message`. ⇒ an "error codes over IPC" design would mean restructuring every
     handler's return shape — out of proportion for this wave.
5. **Persisted user-visible strings are a small, finite, static set:** the parser
   failure constants and `NO_DOCUMENT_CONTEXT_ANSWER` (persisted into
   `messages.content`). None of them interpolate values. Document-task errors surface
   through the in-memory polling status (transient), not the DB — re-verify this in
   Phase 41 before classifying them.
6. **Pre-unlock precedents exist on both sides:** the gate follows the OS theme via
   `nativeTheme` (D-UI2), and `ChatScreen.tsx` already uses `localStorage` for a
   "UI preference, not user data" (list-collapse key). Electron's `app.getLocale()`
   (main) and `navigator.language` (renderer) are available pre-unlock.
7. **A language pair already exists in the product:** the Phase-34 translation task
   models `TranslationTargetLang = 'de' | 'en'` (`shared/types.ts`) with hardcoded
   "To German (Deutsch)" / "To English" buttons — German is an established first-class
   target for this product's users.
8. **Date/number sites are minimal:** two `toLocale*String()` calls with no locale
   argument (`DocumentsScreen.tsx`, `DiagnosticsTab.tsx`); file sizes are formatted
   with `.` decimals. No other `Intl` usage.
9. **Tests assert on English copy ~323 times** (`getByText`/`getByRole({name})` across
   18 renderer test files) and several main-process tests match exact thrown messages.
   ⇒ a design where the default language is English **and `t()` is synchronous** keeps
   the entire existing suite green; only deliberately-changed strings need touching.

## 3. Design

### 3.1 The i18n module — hand-rolled, typed, in `shared/` (D-L1)

`apps/desktop/src/shared/i18n/` (importable from both processes, like `types.ts`):

- `en.ts` — the **source of truth** catalog: a flat `const en = { 'nav.home': 'Home', … } as const`.
  `export type MessageKey = keyof typeof en`.
- `de.ts` — `const de: Record<MessageKey, string>` ⇒ **`npm run typecheck` fails if any
  key is missing or stale**. No partial catalogs, ever.
- `index.ts` —
  - `type UiLanguage = 'en' | 'de'`; `type UiLanguageSetting = UiLanguage | 'system'`
  - `t(lang, key, params?)` — synchronous lookup + `{name}` interpolation; missing
    param or unknown key falls back to the English string (and logs in dev).
  - `tCount(lang, keyBase, count, params?)` — selects `<keyBase>.one` / `<keyBase>.other`
    (English and German share the `n === 1` plural rule, so two variants suffice; no ICU
    machinery needed).
  - `resolveUiLanguage(setting, osLocale)` — `'system'` → `de`-prefixed locale ⇒ `'de'`,
    else `'en'`.

**Why not i18next/react-intl (rejected):** adds a dependency whose ecosystem assumes
async resource loading; brings ICU complexity en/de don't need; an async init or
provider-suspense would churn hundreds of currently-green synchronous tests. The custom
module is ~100 lines, fully unit-testable, and the typecheck-enforced catalog parity is
*stronger* than what the libraries give by default. If a third language with complex
plurals ever lands, revisit (the catalog format migrates trivially).

### 3.2 The setting and its resolution (D-L2, D-L3)

- `AppSettings.uiLanguage: 'system' | 'en' | 'de'`, default **`'system'`** (mirrors
  `theme`). Enum guard in `updateSettings()`.
- **Renderer:** an `I18nProvider` context in `App.tsx` exposes `useT()` (returns a bound
  `t` + the resolved language). On settings load/patch it (a) re-resolves, (b) sets
  `document.documentElement.lang`, (c) mirrors the resolved language to
  `localStorage('paid.uiLanguage')` — a UI preference, not user data (fact 6 precedent).
- **Pre-unlock (gate):** resolved from the localStorage mirror, falling back to
  `navigator.language`. ⇒ first run on a German OS shows a German gate; a user who chose
  the non-OS language gets it back at the *next* gate render after one unlock (mirror
  written post-unlock). This beats the theme rule (gate = OS only) at zero risk because
  the mirror carries no user data.
- **Main process:** `services/i18n.ts` holds a cached resolved language:
  initialized from `app.getLocale()`, updated when settings become readable
  (post-unlock / plaintext startup) and inside `updateSettings()` when `uiLanguage`
  changes. Every main-side emission site calls `tMain(key, params)` which reads the
  cache. No new IPC channel needed.

### 3.3 The two-rule boundary for main-process strings (D-L4, D-L5)

- **Rule 1 — persist canonical, translate at display.** Anything *written to the DB*
  (parser failure → `documents.error_message`, `NO_DOCUMENT_CONTEXT_ANSWER` →
  `messages.content`) keeps being written as today's **exact English constants**. The
  `scanDetected` contract (fact 4) is untouched and pre-existing rows stay valid. The
  renderer translates at display time via a **display map**: an exact-match reverse
  lookup from the known English constants to their `MessageKey` (the persisted set is
  finite and static — fact 5). Unknown strings render as-is. Bonus: switching language
  retroactively re-translates old rows and old "couldn't find it in your documents"
  answers.
- **Rule 2 — emit localized.** Anything *ephemeral* (IPC `throw`, `runtime:notice`,
  preflight problems, task-status errors, `dialog.showOpenDialog` titles) is localized
  **in the main process at emission time** via `tMain()`. The renderer's
  `friendlyIpcError()` path is unchanged. (Renderer-side display-mapping was rejected
  here because transient messages interpolate values and can't be exact-matched.)
- The **product name "Private AI Drive Lite" is not translated** (window title, ambient
  indicator brand line stays; the *descriptive* parts of those strings are).

### 3.4 LLM prompts stay English (D-L6)

`BASE_SYSTEM_PROMPT`, the grounded template, and the task prompts are pinned: models
follow the language of the user's question naturally, and prompt changes would
invalidate the Phase-29 benchmark comparison. Consequence to document (not "fix"): a
one-click summary of a German document may come back in English depending on the model;
making task output language explicit is a separate future feature (it belongs with the
existing `TranslationTargetLang` machinery, not with UI i18n).

### 3.5 German style (D-L7 — RESOLVED 2026-06-13)

- **Form of address: informal „du"** (user decision 2026-06-13 — deliberate brand
  choice; modern consumer-software tone). Use lowercase „du/dein" mid-sentence,
  consistently across all copy including errors and the gate.
- A short **glossary** pinned at the top of `de.ts` keeps terms consistent, e.g.:
  workspace → Arbeitsbereich · drive → Laufwerk · vault/encrypted workspace →
  verschlüsselter Arbeitsbereich · model → Modell · document → Dokument · re-index →
  neu indexieren · offline → offline · "Ask my documents" → „Meine Dokumente fragen".
- German decimal/date conventions come free from passing the resolved locale to
  `toLocaleString`/`Intl.NumberFormat` (the two date sites + file-size formatting).

## 4. Phase 39 — foundation + proof slice ✅ DONE 2026-06-13

1. ✅ `shared/i18n/` module (`en.ts` source-of-truth catalog, `de.ts` typed
   `Record<MessageKey, string>` with the §3.5 glossary pinned on top, `index.ts` with
   `t`/`tCount`/`resolveUiLanguage`) + unit tests (`tests/unit/i18n.test.ts`: lookup,
   interpolation, plural, English fallback for unknown key/missing param,
   `resolveUiLanguage`, catalog hygiene incl. placeholder parity).
2. ✅ `AppSettings.uiLanguage` (+ default `'system'` + the theme/gpuMode-style enum
   guard in `updateSettings`); guard test in `tests/integration/db-settings.test.ts`.
3. ✅ Settings → General picker: `LANGUAGE_CHOICES` (`System` / `English` / `Deutsch` —
   language names shown untranslated) via `SegmentedControl`, patching like `theme`.
   ⚠️ As-built note: the General tab now has TWO radios named "System"
   (Appearance + Language) — `Theme.test.tsx` scopes its query to the Theme
   radiogroup; Phase-40 test edits should scope likewise rather than rename.
4. ✅ Renderer `renderer/i18n.tsx`: `I18nProvider` + `useT()` +
   `document.documentElement.lang` + the `paid.uiLanguage` localStorage mirror
   (written only when a real SETTING resolves, never from the pre-unlock guess);
   a functional English default context keeps provider-less component tests working.
   Main `services/i18n.ts` cache wired at startup (`app.getLocale()` after whenReady),
   plaintext startup + unlock/create (`registerWorkspaceIpc`), and `uiLanguage`
   patches (`registerCoreIpc` updateSettings handler).
5. ✅ Proof slice migrated: `App.tsx` (nav labels, lock button + tooltip, notice
   banner "Details"; the fatal-error/loading strings wait for the Phase-40 sweep),
   `SettingsScreen.tsx` (tab chrome + General tab fully incl. Change-password card),
   `WorkspaceGate.tsx` (all steps + error display); the wrong-password message is the
   first `tMain()` emission (D-L5), English value byte-identical.
6. ✅ Validation (was research gate R-L1) — **finding, measured on this de-AT
   Windows 11 machine (Electron 37):** after `whenReady`, `app.getLocale()` returns
   the **bare language tag `'de'`** (Chromium UI language — not always a full
   `de-DE`-style tag; `app.getSystemLocale()` gives `'de-AT'`), and the renderer's
   `navigator.language` matches (`'de'`, `navigator.languages` =
   `['de','de-DE','de-AT']`). ⇒ `resolveUiLanguage` accepts bare `'de'` as well as
   `de-*`/`de_*` prefixes. **Correction to a §4.7 assumption:** the dev machine is
   GERMAN-locale, not EN — the suite stays green anyway because the vitest
   environments are locale-independent (jsdom pins `navigator.language` to `en-US`;
   unit tests pass explicit locales), which is what the "resolves to 'en'" assertions
   actually pin.
7. ✅ Tests: full suite green (990 passed). New: picker patches `uiLanguage` +
   switches live + writes the mirror + `<html lang>` (`tests/renderer/I18n.test.tsx`),
   German render smoke of the gate (mirror seeded → „Entsperre deinen
   Arbeitsbereich“), default-English gate with zero stored state, and the
   main-process cache lifecycle + German wrong-password emission
   (`tests/unit/main-i18n.test.ts`).

## 5. Phase 40 — renderer sweep ✅ DONE 2026-06-13

Implemented in five batch commits (one per ①–⑤ below), suite green after each.
**As-built notes:**

- The catalogs grew from ~70 to ~440 keys per language; English values stayed
  byte-identical to the pre-sweep literals (D-L8 — the existing role+name assertions
  passed unchanged; only structural changes needed test edits).
- Label maps kept their structure with `labelKey: MessageKey` values resolved at
  render: `STATUS_BADGE` + `TASK_BUSY_LABEL/TITLE` (Documents), `STATE_BADGE` +
  `plainHintKey` (Models), `AUDIT_TYPE_LABELS` (Diagnostics), `DEPTH_LABEL_KEYS`
  (chat), `ConversationGroup.labelKey` (conversation list — the date-group test now
  asserts via `t('en', labelKey)`).
- Plurals via `tCount`: `home.docsReady` (wired), scope-popover document counts,
  audio-import recording count, preview OCR page count.
- Locale-aware formatting from `useT().lang`: the two `toLocaleString()` date sites
  (`DocumentsScreen` summary attribution, `DiagnosticsTab` benchmark/activity
  timestamps) plus file-size/RAM one-decimal numbers (`formatSize`, `fmtGb`, `fmt1`)
  — `useGrouping: false` keeps English output byte-identical to the old `toFixed`.
- Inline JSX islands (`<code>`, `<strong>`, `<b>`) are handled with before/after key
  pairs (e.g. `app.fatal.hintBefore/After`) — both languages order around the island.
- ⑤ as built: shared components RECEIVE a bound `t` prop/argument
  (`components/translator.ts` exports the `Translator` type and the
  `englishTranslator` default used when no `t` is passed — provider-less component
  tests keep working). Built-in copy migrated: Banner "Dismiss", Modal "Close",
  ConfirmDialog default "Cancel", Chip "Remove" fallback, PasswordField Show/Hide,
  strength labels (now `labelKey`/`hintKey` MessageKeys on `PasswordStrength`),
  LocalIndicator label/detail (the helper functions take `t` as an argument,
  defaulting to English). Toast has no built-in copy.
- Deliberately NOT migrated (Phase 41 / D-L4–D-L5 boundary): persisted
  `documents.error_message` rendering, `NO_DOCUMENT_CONTEXT_ANSWER` matching,
  `DOC_TASK_BUSY_MESSAGE` recognition (both sides untouched), raw IPC/job/task error
  strings (`friendlyIpcError` output, download `job.error`, audit `ev.message`,
  benchmark warnings). `MIC_BLOCKED_MESSAGE` stays canonical English in
  `lib/dictation.ts` (a pure module) and is exact-matched + localized at display in
  `DictationButton` — the renderer-internal analogue of the D-L4 display map.
- Untranslated by design: the product name / "Lite" brand line, the language names in
  the picker (`System`/`English`/`Deutsch`), technical values (model ids, paths,
  hardware-profile codes, "llama.cpp <version>").
- Tests: +9 German render smokes (`tests/renderer/GermanSmoke.test.tsx`: Home, Chat,
  Documents, Models, Privacy tab, Diagnostics tab, shared-component built-ins) on top
  of the Phase-39 gate smoke; structural assertions reference the `en` catalog.
- **Grep-audit result (the completeness heuristic below, run 2026-06-13):** after the
  sweep, the only remaining capitalized string literals in `renderer/` are (a) code
  comments / CSS comments, (b) developer-facing internal `throw new Error(...)`
  messages that never render in the UI (`main.tsx` root-element guard, `ocr/main.ts`
  worker guards, `lib/wav.ts` validation), (c) the canonical `MIC_BLOCKED_MESSAGE`
  constant (see above), (d) the untranslated-by-design brand/language-name strings,
  and (e) keyboard `e.key` names (`'Escape'`, `'Home'`, `'End'`). No user-visible
  literal remains.

Original batch plan — mechanical migration, batched per screen so each batch is
reviewable and the suite stays green between batches: ① Home + chat components (`Composer`, `ConversationList`,
`DepthMenu`, `Transcript`, `ScopePopover`, `SourcesDisclosure`, `MessageActions`,
`DictationButton`) ② Documents (incl. `STATUS_BADGE`, task buttons, translation-target
buttons) ③ Models (incl. `STATE_BADGE`, download confirm dialog, RAM badge) ④ Privacy +
Diagnostics tabs (incl. `AUDIT_TYPE_LABELS`) ⑤ shared components' built-in copy
(`Banner` "Dismiss", `PasswordField` show/hide + strength labels, `Toast`,
`LocalIndicator` label/detail functions — these take or receive `t` rather than
importing a global, keeping them pure).

Rules for the sweep:

- Label maps keep their structure; `label` values become `MessageKey`s resolved at
  render (`t(STATUS_BADGE[s].labelKey)`).
- Every `aria-label`, `title`, `placeholder`, and confirm-dialog string migrates —
  accessibility copy is user-visible copy.
- Hand-rolled plurals (`indexedCount === 1 ? 'document' : 'documents'`) →
  `tCount('home.docsReady', n)`.
- The two date sites + size formatting take the resolved locale.
- **Completeness audit:** a repeatable grep heuristic (capitalized string literals in
  JSX / suspicious `'…'` literals in `renderer/`) run at the end of the phase and
  recorded in the phase commit message; not a CI gate (too noisy), but a checklist.
- Test impact: keep querying by role+name; where a name moved behind `t()`, tests
  import `en` and assert against `t('en', key)` instead of a string literal — the
  assertion strength is identical and survives future copy edits.

## 6. Phase 41 — main-process boundary

1. Move the static constants into catalog entries **whose English values are
   byte-identical to today's strings** (so persisted-data contracts and exact-string
   tests don't move): parser messages, task messages, download/policy refusals, IPC
   guard errors, preflight problems, GPU notice copy.
2. Apply the two-rule boundary (§3.3): persist-sites keep writing `t('en', …)`
   (explicitly, with a comment citing this plan's §3.3); emission-sites switch to
   `tMain()`.
3. Renderer display map for the persisted static set (`documents.error_message`
   rendering in `DocumentsScreen`, and assistant messages equal to
   `NO_DOCUMENT_CONTEXT_ANSWER` in `Transcript`).
4. Verify the fact-5 classification of doctask errors (in-memory vs persisted) and
   place them on the right side of the rule.
5. `dialog.showOpenDialog` titles via `tMain()`. Window title stays the product name.
6. Tests: existing main-process exact-string tests stay green (English defaults); add
   one unit proving a German-cached language localizes an emitted error while the
   persisted row stays English; add a `scanDetected`-survives-language-switch test.

## 7. Phase 42 — German QA + closeout

1. Full `de.ts` review pass against the §3.5 glossary and du-form (D-L7); spec-§11.4
   tone check on every warning/error.
2. **Text-expansion audit:** German runs ~30% longer — walk buttons, badges, nav rail,
   the ambient indicator, dialog buttons at both window-size extremes; fix overflows
   with layout (wrapping/min-widths), not abbreviations.
3. **Eyeball walk in German** (the design-guidelines §11 Playwright screenshot-walk
   pattern) across all screens incl. first-run; plus the existing English walk to catch
   regressions.
4. Catalog hygiene tests: placeholder parity en↔de (`{name}` sets identical per key),
   no empty values, plural-variant pairs complete.
5. Docs: condense this plan into the design record (per the lifecycle rule);
   `known-limitations.md` entries — task/summary output language follows the model not
   the UI (D-L6); docs, `user-guide.md`, and `READ ME FIRST.txt` remain English-only
   for now (translating them is content work, tracked separately); audit-log *export*
   stays English (it's a diagnostic artifact). Update `BUILD_STATE.md` + commit per the
   ritual.

## 8. Decisions

| ID | Decision | Status |
|---|---|---|
| D-L1 | Hand-rolled typed i18n module in `shared/i18n/` (flat keys, `{name}` interpolation, `.one`/`.other` plurals); **no new dependency**. Typecheck enforces de↔en catalog parity. | **LOCKED** (Phase 39, as built) |
| D-L2 | `uiLanguage: 'system' \| 'en' \| 'de'`, default `'system'` (theme precedent); `de*` locale ⇒ German, else English. | **LOCKED** (Phase 39; incl. bare `'de'` — R-L1 finding §4.6) |
| D-L3 | Pre-unlock language: renderer = localStorage mirror (`paid.uiLanguage`) → `navigator.language` fallback; main = cached language from `app.getLocale()` until settings are readable. | **LOCKED** (Phase 39, as built) |
| D-L4 | **Persist canonical English, translate at display** (exact-match display map over the finite static persisted set). Keeps the `scanDetected` contract and old rows; makes persisted copy retroactively language-switchable. | proposed (Phase 41) |
| D-L5 | **Ephemeral main→user strings localized at emission** via `tMain()` + cached language; IPC error transport (`friendlyIpcError`) unchanged. | **LOCKED** (Phase 39 — first use: the gate's wrong-password message) |
| D-L6 | LLM prompts stay English and unchanged (benchmark comparability; models follow the question's language). Task-output language = future feature, noted in known-limitations. | proposed (document in Phase 42) |
| D-L7 | German address form = informal **„du"** (lowercase mid-sentence); glossary pinned in `de.ts`. | **RESOLVED** (user, 2026-06-13) — in use since Phase 39 |
| D-L8 | Default-English + synchronous `t()` keeps the existing ~323 copy assertions green; migrated assertions reference the `en` catalog, not re-typed literals. | **LOCKED** (Phase 39 — suite green with one scoping edit, §4.3 note) |

## 9. Risks

- **Missed strings** (the long tail of aria-labels/titles): mitigated by the Phase-40
  grep audit + the Phase-42 German eyeball walk (an untranslated string is visually
  obvious in an otherwise-German UI).
- **German overflow breaking layouts**: dedicated Phase-42 audit; fix with layout, not
  copy truncation.
- **Merge friction**: the sweep touches nearly every renderer file — land Phases 40/41
  promptly after 39 and avoid parallel feature branches during the sweep window.
- **Translation quality**: machine-drafted German must get a human review pass (Phase 42
  is gated on it); the user is the first reviewer.
- **Mixed-language artifacts**: a conversation transcript can legitimately contain both
  languages (old answers, model output) — accepted, documented.

## 10. Acceptance criteria

1. Settings → General offers System / English / Deutsch; switching is instant (no
   restart), persists, and updates `<html lang>`.
2. Fresh start on a German-locale machine: gate, first-run flow, and post-unlock UI are
   German with zero stored state.
3. Every screen, dialog, toast, badge, placeholder, and aria-label renders in the
   selected language; the German eyeball walk shows no English remnants (product name
   excepted).
4. A scanned-PDF import under German UI still offers "Make searchable (OCR)"
   (`scanDetected` intact), and its failure row displays in German — including rows
   created *before* the language switch.
5. Wrong-password and policy/download refusals arrive in the selected language.
6. `npm test` + `npm run typecheck` green; removing any `de.ts` key fails typecheck.
7. No new runtime dependency; no network access added; audit-log events unchanged.
