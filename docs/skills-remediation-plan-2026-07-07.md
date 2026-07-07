# Skills remediation plan — audit 2026-07-07 (SK-1…SK-18)

Working paper for remediating [`docs/skills-audit-2026-07-07.md`](skills-audit-2026-07-07.md).
Delete both files (plan + report) at close-out after retiring the dispositions into the
architecture Skills record (CLAUDE.md doc-lifecycle rule).

## §0 How to execute (read this first, every phase)

**Context discipline.** Each phase is sized to run in a fresh session. Read ONLY:
this plan's §0 + the phase's own section, the audit report entries it cites, and the files the
phase lists. Do NOT re-read the whole audit report, the architecture record, or prior phases.

**Per-phase ritual (CLAUDE.md — mandatory).**
1. Before editing, grep `apps/desktop/tests` **and** `docs/` for every string the phase changes
   (each phase lists its grep terms) — pinned copies must move together.
2. `npm test` from the **repo root** (never bare `npx vitest` — wrong cwd breaks renderer suites)
   + `npm run typecheck`. Suite baseline: 3794 tests / 47 files — keep green, no skips.
3. Behavioral code fixes get a **teeth-check**: temporarily revert the fix, confirm the new test
   goes RED, restore.
4. Update affected `docs/` + `BUILD_STATE.md`; tick this plan's §1 tracker with a one-line
   outcome note; commit `fix(skills): <phase> — skills-audit-2026-07-07 SK-n[,SK-m]`.

**SKILL.md editing invariants (all phases).**
- The parity test (`tests/integration/skills-skillmd-parity.test.ts`) pins two things:
  `triggers.keywords` must equal `vocabulary.ts` `suggestTerms(id)` — **never edit a keywords
  list** — and paragraph 0 of every body must merge heading + honesty rules (SKA-15). When
  editing an honesty rule, edit **within** the existing first paragraph; never insert a blank
  line that splits it.
- YAML comments in frontmatter are parse-inert; body text is model-visible. Keep bodies English;
  `localized.de` only overrides title/description (D-L6).
- **Version convention (SK-12, adopted by this plan):** bump **minor** when the model-visible
  body changes, **patch** when only aux files / frontmatter comments change. Rationale: for app
  skills the version is display-only, but an exported copy re-imported as a *user* skill runs
  `compareSemver` upgrade decisions (`installer.ts:626,713`) — a frozen 1.0.0 defeats them.

## §1 Phase tracker

- [x] **Phase 1** — document-edit + document-redaction truth pass (SK-1, SK-8, SK-9, SK-11, SK-13, SK-14 part).
  DONE 2026-07-07: both SKILL.md bodies + versions→1.1.0 (SK-1 output matrix in both per D-P1a; SK-8
  placement; SK-9 steerable `[REDACTED]` clause; SK-11 narrowed; SK-13 char-for-char; SK-14 redaction
  autoFire comment). i18n placement copy swapped EN×5 ("just above the message box") + DE×5 ("direkt über
  dem Eingabefeld"); `docx-rewrite.ts` comment aligned. Routing tests read the catalog via `tr()` (no
  literal pins); no doc drift (user-guide/known-limitations already correct; design-guidelines §11.9/§11.10
  unrelated). typecheck clean, suite 3794/47 (baseline, no skips).
- [x] **Phase 2** — what-changed: diff completeness + fence coherence (SK-2, SK-15, SK-3).
  DONE 2026-07-07: SK-2 (HIGH) as a design fix — `DIFF_RENDER_MAX=200` exported from `services/diff` as
  the single source of truth, passed explicitly to both renderers at both consumers; `retrieveCompareDiff`
  ORs `changes.length > DIFF_RENDER_MAX` into `truncated` (cap+flag can't drift); PARTIAL prompt wording
  generalized so it's true for BOTH truncation causes (budget + render cap drop LATER changes). Second
  consumer `doctasks/handlers/compare.ts` fixed too — explicit PARTIAL note under `## Exact changes` when
  the cap fires. SK-15+SK-3a: both what-changed honesty rules reworded inside paragraph 0 (rule 1 now
  discriminates on visible A/B-labels-or-diff vs plain passages; rule 3 names the real "Exact word-level
  changes (redline)" label and defers to the block's own PARTIAL/further-changes markers); version→1.1.0.
  SK-3b/D-P2a fence-suppression DECLINED, recorded in known-limitations.md. New teeth-checked unit file
  `tests/unit/rag-compare-diff-truncation.test.ts` (+2). rag.test.ts:227 assertion re-pinned to new wording.
  Docs: rag-design.md §14.6 render-cap invariant, known-limitations.md D-P2a. typecheck clean, suite 3796/47.
- [ ] **Phase 3** — instruction/tool text batch: deadline-finder, share-safe, invoice (SK-4, SK-7, SK-10, SK-14 part)
- [ ] **Phase 4** — bank-statement aux files + schema parity pin (SK-5, SK-6, SK-14 part)
- [ ] **Phase 5** — close-out: conventions, INFO records, retire report + plan (SK-12, SK-16/17/18, SK-3b record)

Phases 1–4 are independent of each other (no shared files) and can land in any order;
Phase 5 last.

---

## Phase 1 — document-edit + document-redaction truth pass

**Files:** `app-skills/document-edit/SKILL.md`, `app-skills/document-redaction/SKILL.md`,
`apps/desktop/src/renderer/i18n/en.ts` + `de.ts` (placement copy only),
`apps/desktop/src/main/services/skills/docx-rewrite.ts` (one comment).
**Grep first:** `plain .txt`, `plain-text copy`, `below the chat box`, `unten beim Chat`,
`byte-for-byte`, `byte-identical` — across `apps/desktop/tests`, `docs/`, and both i18n files.
(`tests/integration/skills-document-edit.test.ts` and the redaction tests assert routing copy —
expect hits.)

### SK-1 (HIGH) — replace the stale `.txt` sentence with the true output matrix
In `document-edit/SKILL.md`, replace the final sentence ("This phase writes a plain `.txt`
copy; keeping the original file format is a later step.") with:

> A Word document (`.docx`) is saved as a `.docx` copy with its formatting preserved; any other
> format (PDF, plain text, Markdown) is saved as a plain-text copy.

**Decision D-P1a — say the matrix in BOTH skills, not neither.** Redaction currently makes no
format claim (audit called that "correct"), but users ask "will it keep my formatting?" of both
tools, and the two skills share the identical Phase-9 seam (`run.ts:1519-1523` vs `:1781-1789`).
Symmetry beats silence: append the same one-liner to document-redaction's closing paragraph
(adapted: "the redacted copy" instead of "edited"). Alternative rejected: dropping the sentence
from document-edit only — leaves the model guessing on a real user question.
**Deliberately NOT claimed:** the corrupt-DOCX → `.txt` fallback (`run.ts:1696-1699`). It is a
rare degradation the save dialog makes visible (filename shows `.txt`); promising it in the body
would teach the model to hedge every DOCX answer. Record this choice in the §-record at close-out.

### SK-8 — fix "just below the chat box" everywhere at once
The `SkillRunBar` renders **above** the composer input (`ChatScreen.tsx:1721,1736`). Change, in
the same commit: both SKILL.md bodies ("just below the chat box" → "just above the message box"),
the EN routing copy, and the DE routing copy ("unten beim Chat" → "direkt über dem Eingabefeld" —
keep the formal register; `skill-i18n.test.ts` gates `Sie`-form regressions). SKILL.md, i18n, and
the on-screen reality must land together or the model's directions contradict the UI.

### SK-9 — mention the steerable fourth locate category
In document-redaction's third safety rule, after "…names, addresses, and organisation names for
the app to mask", add: "(when the user steers the scope with their own instruction, other located
items are masked as `[REDACTED]`)". One clause — the default stays described as the three
categories, matching `DEFAULT_LOCATE_DIRECTIVE` (`redaction-locate.ts:41-42`).

### SK-11 — narrow "never repeat document text" to what it actually protects
In document-edit's final safety rule, replace "and never repeat document text back to them" with:

> You may name the user's own find/replace terms when confirming, but never quote any other
> document text back.

Rationale: the find/replace strings are user-typed and already in the transcript; the privacy
target is *surrounding* document content. Keep redaction's stricter rule unchanged — there the
sensitive strings are app-detected, not user-typed.

### SK-13 — byte-for-byte → character-for-character
In document-edit's second safety rule: "stays **byte-for-byte** identical" → "stays identical,
character for character". Align the over-claiming comment at `docx-rewrite.ts:130-131` (byte-
identity holds for untouched nodes/parts; a rewritten node re-escapes entities, so unchanged
characters inside it are character- but not byte-stable). **No behavior change** — comment and
prose only. Alternative rejected: making the rewriter entity-preserving to rescue the byte claim —
real complexity for zero user-visible difference.

### SK-14 (this file's share) — clarify the threshold comment in document-redaction
In the `autoFire` frontmatter comment, after "the score ≥ 3 bar", add "(auto-fire bar; the
suggestion offer bar is score ≥ 2 with a mandatory keyword hit)". Comment-only.

**Versions:** document-edit `1.0.0 → 1.1.0`, document-redaction `1.0.0 → 1.1.0` (body changes).
**Tests:** update any routing-copy assertions found by the grep; full suite; no new tests needed
(text-only phase; the placement copy is pinned by existing i18n/routing tests).
**Docs:** grep `docs/` for "plain .txt copy" / "below the chat box" (design-guidelines §11.9/§11.10
and the arch §21–§23 beta-wave record may quote the old copy) and align.

---

## Phase 2 — what-changed: diff completeness + fence coherence

**Files:** `apps/desktop/src/main/services/diff/index.ts`, `apps/desktop/src/main/services/rag/index.ts`,
`apps/desktop/src/main/services/doctasks/compare.ts` (inspect; edit only if affected),
`app-skills/what-changed/SKILL.md`, one new unit test file, `docs/rag-design.md` (compare record),
`docs/known-limitations.md` (SK-3b decision).
**Grep first:** `complete and exact`, `Exact changes`, `renderChangesForModel`, `renderRedline`,
`truncated` in the compare tests (`tests/**/*compare*`, `tests/**/*diff*`).

### SK-2 (HIGH) — the 200-change render cap must set `truncated`
**Root cause:** `renderChangesForModel`/`renderRedline` default `max = 200`
(`diff/index.ts:284,309`); the call sites (`rag/index.ts:902,909`) pass no max and compute
`truncated` only from the token budget (`rag/index.ts:904,910`), so >200 changes within budget
yields a prompt asserting "complete and exact" (`rag/index.ts:1172-1176`) over a capped list.

**Fix (design, not a patch):**
1. In `diff/index.ts`, export the constant (e.g. `export const DIFF_RENDER_MAX = 200`) and use it
   as the parameter default — one source of truth, no magic 200 at call sites.
2. In `rag/index.ts`, compute `const renderCapped = diff.changes.length > DIFF_RENDER_MAX` and OR
   it into the existing truncated flag passed to `buildDiffResult` (`:910`). Pass `DIFF_RENDER_MAX`
   explicitly to both renderers so the cap and the flag can't drift apart.
3. **Read the actual PARTIAL prompt wording** (`rag/index.ts:1172-1176`). If it claims the list
   "covers only the beginning", generalize: the render cap drops *later* changes, not later
   *sections* — wording must be true for both truncation causes, e.g. "This list is PARTIAL —
   further changes exist that are not listed; do NOT describe anything as unchanged." Update any
   test pinning the old string.
4. **Audit the second consumer:** `doctasks/compare.ts` (the Compare button's materialized
   `Comparison: A vs B.md`, heading `## Exact changes (word-level diff)`, `:320-322`). If it
   renders through the same capped renderers without surfacing partiality beyond the in-band
   "(+N further change(s) not listed)" line, add an explicit partial note under the heading when
   capped. Same bug class, different surface — fixing one and not the other re-creates SK-2.

**Tests (new unit file, e.g. `tests/unit/rag-compare-diff-truncation.test.ts`):**
- Fixture pair with >200 coalesced changes (e.g. 250 numbered lines, each altered) that fits the
  token budget → `buildDiffResult` reports `truncated: true` AND the built prompt contains the
  PARTIAL line and no "complete and exact".
- Fixture with ≤200 changes → `truncated: false`, prompt asserts completeness (pin the good case
  so the fix can't over-trigger).
- Teeth-check: revert step 2 → first test RED.

### SK-15 + SK-3a — rewrite the two honesty rules
In `what-changed/SKILL.md` (both edits inside paragraph 0 — do not split it):

1. **Scope rule** (currently claims the app replies "before you are ever called" — false on the
   `intends()`-miss fallthrough, `registerRagIpc.ts:233-267,609-637`, and at 0 docs). Replace with
   a discriminator the model can actually see:

   > **The app handles document scope for you — do not police it.** When you are given a
   > comparison — documents labelled **A** and **B**, or an exact-changes block — the app has
   > already ensured these are exactly the two documents to compare: never tell the user to
   > select or narrow documents, get straight to comparing. If instead you receive ordinary
   > document passages with no A/B labels and no diff, simply answer the question from the
   > material provided.

2. **Diff rule**: name the block by its real runtime label (`rag/index.ts:1168`) and defer to the
   block's own completeness markers:

   > **When the app gives you a deterministic word-level diff** (an "Exact word-level changes
   > (redline)" block or a list of exact changes), treat it as **exact**, and as complete unless
   > the block itself notes otherwise — a PARTIAL notice or a "further changes not listed" line;
   > in that case say plainly that your comparison covers only the listed changes. If instead you
   > are given only document passages (no diff), compare carefully and use cautious wording for
   > anything the passages do not fully cover.

### SK-3b — decide and record: do NOT suppress the fence on fallthrough
**Decision D-P2a (declined runtime change):** suppressing the user's explicitly chosen skill
fence on the relevance path would silently drop instructions the user deliberately selected (the
per-message glyph shows the skill as applied), and the reworded rule 1 is coherent on both paths.
Record this as an accepted-with-rationale residual in `known-limitations.md` next to the A4/SKA-8
fall-through record. Revisit only if the gold set later shows comparison-framed answers on
non-compare fallthrough turns.

**Version:** what-changed `1.0.0 → 1.1.0`.
**Docs:** `rag-design.md` compare record — note the render-cap-sets-truncated invariant (the
next auditor should find it as designed behavior, not rediscover it).

---

## Phase 3 — instruction/tool text batch: deadline-finder, share-safe, invoice

**Files:** `app-skills/deadline-obligation-finder/SKILL.md`, `app-skills/share-safe-review/SKILL.md`,
`app-skills/invoice/SKILL.md`, `app-skills/meeting-protocol/SKILL.md` (SK-14 comment only).
**Grep first:** `one or more documents`, `one or more selected documents`, `Document Redaction`
(in docs + tests), `net plus tax` — plus the DE description strings being changed.

### SK-4 — deadline-finder: stop promising multi-doc
The whole-doc engine requires exactly one in-scope doc (`whole-doc-skills.ts:99-103`); at
multi-doc the W2 pre-pass narrows or asks (`registerRagIpc.ts:268-289`). Make the text match:
- Frontmatter `description`: "…and the obligations **in a document** — what to do, by when…";
  mirror in `localized.de.description` ("…in **einem Dokument** gefunden werden sollen…" — keep
  the formal register).
- Body: "across one or more selected documents" → "in the selected document". Add one scope
  sentence modeled on what-changed's rule (same philosophy, keeps the model out of scope-policing):
  "The app handles document scope — with several documents in scope it narrows to the matching
  one or asks the user to pick; do not police this yourself."
- The existing coverage-honesty rule ("I found these… in the available material") stays — it is
  the correct posture for the top-k fallback on generic questions.
**Alternative rejected:** building a multi-doc whole-doc sweep. Engine work, different risk
class, and the one-doc-at-a-time posture is the deliberate D45 design; if beta demand appears it
gets its own plan.

### SK-7 — share-safe: bilingual sibling reference + translated-boilerplate framing
- §4: "Run the **Document Redaction** skill" → "Run the **Document Redaction / Dokument
  schwärzen** skill" (SKA-42 precedent: name what the user's UI actually shows).
- §3 and §4 quote English strings the model must deliver in the user's language while the rule
  demands verbatim-looking quotes. Reframe both introductions: "Always include (in the user's
  language, equivalent to):" for §3, and "tell the user, in their language:" for §4. The English
  text stays as canonical content; the framing licenses translation.

### SK-10 — invoice: name the third validation check
The honesty rule lists two reconciliations; `validateInvoiceTotals` runs three
(`tools/invoice.ts:1109-1135`). Extend: "…the line items don't sum to the net, net plus tax
doesn't match the gross, **or the tax doesn't match the stated rate** — say so plainly…". Also
extend the closing paragraph's "check that the printed totals add up" → "…add up (including the
stated tax rate)".

### SK-14 (remaining files) — threshold-comment clarification
Apply the Phase-1 clause ("auto-fire bar; the suggestion offer bar is score ≥ 2 with a mandatory
keyword hit") to the `autoFire` comments in **invoice** and **meeting-protocol**. (bank-statement
gets it in Phase 4; redaction got it in Phase 1.)

**Versions:** deadline-finder → `1.1.0`, share-safe-review → `1.1.0`, invoice → `1.1.0` (body
changes); meeting-protocol → `1.1.1` (comment-only, patch).
**Tests:** no new tests; parity test guards keywords (untouched); `skill-i18n.test.ts` does not
cover SKILL.md `localized` strings, but re-read the changed DE description for register anyway.
**Docs:** grep `docs/` for the old deadline-finder description (user guide / skills record may
quote it) and align.

---

## Phase 4 — bank-statement aux files + schema parity pin

**Files:** `app-skills/bank-statement/examples/reading-a-statement.md`,
`app-skills/bank-statement/schemas/transaction.schema.json`,
`apps/desktop/src/main/services/skills/tools/bank-statement.ts` (export only),
one new unit test, `app-skills/bank-statement/SKILL.md` (SK-14 comment + version).
**Grep first:** `reading-a-statement`, `transaction.schema`, `instruction-only` (docs +
BUILD_STATE still reference the v1 framing per the audit).

### SK-5 — rewrite the aux files for the Tier-2 reality
These files are never injected at runtime but ship with every skill export
(`installer.ts:840-862`) and are the first thing a contributor reads — today they teach the
**opposite** of shipped behavior.

- **`examples/reading-a-statement.md`:** rewrite around the *stable honesty posture*, not the
  tool list (minimizes future drift — the rules change rarely, the tool set grows). Keep the
  same three-question structure: closing balance → quote the printed figure with provenance
  (unchanged); "how much did I spend?" → the app's tools compute it from the extracted table
  (never from prose), computed values are labelled as computed, and a reconciliation mismatch is
  surfaced before any total; truncated row → same caution as today (uncertain rows shown before
  totals). Add one line: exports always ask before saving. Drop the "What this version does not
  do" section entirely; replace with "Where the numbers come from" (extracted table + printed
  figures, never sentence-mining).
- **`transaction.schema.json`:** fix the `description` to reality: produced by
  `extract_transactions`; mirrored by `TRANSACTION_ROW_SCHEMA` in `tools/bank-statement.ts`;
  pinned by the parity test added below. Do not change any property definitions (the shapes
  match today, field-for-field — audit §3).
**Alternative rejected:** deleting both files. The example carries real pedagogical value for
skill authors and export recipients, and the schema is the only machine-readable contract that
ships inside the package; correctness + a drift pin beats deletion.

### SK-6 — pin the schema file to the shipped shape
1. Export `TRANSACTION_ROW_SCHEMA` from `tools/bank-statement.ts` (currently module-private;
   export is test-motivated — note that in a comment).
2. New test `tests/unit/skills-transaction-schema-parity.test.ts`: load the JSON file (resolve
   the path from the repo root via `path.resolve(__dirname, ...)` — POSIX/Win32 safe, no
   hardcoded absolute paths) and structurally compare against the export: property-name set,
   per-property `type`/`pattern`/`minimum`, and the `required` list. Compare **structure, not
   prose** (descriptions may differ). Encode intentional deltas explicitly (e.g. if `category`
   is file-only because the extractor never produces it — assert that delta by name, so an
   unexplained new difference fails).
3. Teeth-check: temporarily change one `pattern` in the JSON → test RED.

### SK-14 (last file) — the same threshold-comment clause in bank-statement's frontmatter.

**Version:** bank-statement → `1.0.1` (aux + comment only, patch — body untouched).
**Docs:** `rag-design.md`/architecture skills record: one line noting the schema file is now
test-pinned to the TS contract (kills the audit's "hand-maintained mirror" drift risk).

---

## Phase 5 — close-out (docs + retire, no code)

**Files:** `docs/architecture.md` (Skills design record), `docs/known-limitations.md`,
`BUILD_STATE.md`, delete `docs/skills-audit-2026-07-07.md` + this plan.

1. **Retire the audit** into the architecture Skills record as a §-numbered subsection, repo
   pattern (cf. §34/§40/§41/§43): per-finding disposition table SK-1…SK-18 (fixed → phase +
   commit; declined → rationale; info → note), plus a **§-anchor legend** so `SK-n` code-comment
   citations (the diff-truncation test will carry one) stay resolvable.
2. **Record the deliberate non-fixes** in `known-limitations.md`:
   - SK-3b: compare fence rides fallthrough turns by design (user-chosen skill stays visible);
     reworded rule 1 keeps it coherent.
   - SK-16: `validate_statement_balances` = per-row chain; opening+Σ=closing lives in
     `assessCompleteness` — composition satisfies the SKILL.md honesty rule.
   - SK-17: live dictation produces composer text, not a document — meeting-protocol runs over
     imported audio documents only. (Watch beta feedback; a body clause is the cheap fix if hit.)
   - SK-18: invoice/bank `mimeTypes` deliberately omit `text/plain` — do not "fix" into a
     precision regression.
3. **Write down the version convention** (SK-12, §0 above) in the Skills design record so future
   waves bump versions as part of the SKILL.md-editing checklist.
4. `git rm` the report + this plan (recoverable in history), update `BUILD_STATE.md`
   (status, decisions D-P1a/D-P2a, next actions), final full suite run, commit.

---

## Risks / watch-list

- **Pinned copy strings** are the main breakage vector (routing copy, PARTIAL prompt line,
  compare headings). The per-phase grep-first step exists for exactly this; a phase that skips it
  will fail in `skills-document-edit.test.ts` / compare tests at best, or silently drift docs at
  worst.
- **Parity test structure**: honesty-rule edits must stay inside paragraph 0 (SKA-15 merge) —
  a stray blank line makes the fence trimmer drop the rules under budget pressure.
- **SK-2 fixture cost**: a 250-change fixture must stay small (short lines) so the token budget
  is NOT the truncation cause — otherwise the test passes for the wrong reason. Assert
  budget-truncation is false in the fixture setup.
- The suite is 3794/47 and slow-ish: run the targeted new/changed test files during development,
  full `npm test` once per phase before commit.
