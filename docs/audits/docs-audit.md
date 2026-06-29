# Documentation Audit Report

## Metadata

- **Audit date:** 2026-06-29
- **Repository branch:** `master`
- **Repository commit:** `5aaa050` (Merge audit-postmerge-phase8-closeout)
- **Command used:** `/docs-audit`
- **Scope audited:** All root documentation (`README.md`, `CLAUDE.md`, `CLAUDE_HilbertRaum_MVP.md`,
  `CONTRIBUTING.md`, `SECURITY.md`, `PRIVACY.md`, `LICENSE`, `BUILD_STATE.md`) plus the entire
  `docs/` tree (`architecture.md`, `rag-design.md`, `security-model.md`, `known-limitations.md`,
  `design-guidelines.md`, `model-policy.md`, `model-benchmarks.md`, `packaging.md`, `drive-layout.md`,
  `user-guide.md`, `troubleshooting.md`, `benchmark.md`, `big-slot-embeddings-plan.md`,
  `design-review/skills-s12/README.md`) and `model-manifests/README.md`. `node_modules/` excluded.
- **Auditor note:** This is a **documentation-only** audit. No application code was modified. Code
  and config were read **only** to verify factual documentation claims (npm scripts, script files,
  runtime pin, the image-history persistence behavior, the demo-mode button label).
- **Report status:** IN PROGRESS — Phase 1 (DOC-001, DOC-002, DOC-003) and Phase 2 (DOC-004,
  DOC-005, DOC-012) Fixed (2026-06-29); remaining phases (3–6) Open. See the Remediation log.

## How to use this report

- `/docs-audit` creates and updates this report (`docs/audits/docs-audit.md`).
- `/docs-fix` should fix **one phase or one finding set at a time**, then update this report.
- Every fix should update this report: do **not** delete findings — mark them
  `Fixed`, `Verified`, `Blocked`, or `Superseded`, and append a row to the Remediation log.
- Stable finding IDs (`DOC-001`, …) are never reused for a different issue.

## Executive summary

**Overall health: good.** The documentation set is unusually thorough, internally cross-linked, and
mostly accurate. The onboarding docs (`README.md`, `CONTRIBUTING.md`) match `package.json`, the
referenced scripts all exist, the runtime pin (`llama.cpp b9585`) is consistent across every doc, and
the RAM-tier model recommendations agree everywhere they appear. A repo-wide relative-link scan found
**zero** broken links in any doc except `BUILD_STATE.md`.

**Highest-priority risks (both user-facing accuracy):**

1. **DOC-001 (High) — image data-retention contradiction.** `docs/user-guide.md` §8 and
   `docs/troubleshooting.md` both still tell users analyzed images **"are not saved"** and are
   "gone when you remove the image or leave." The feature was **revised**: image-analysis history is
   now **persisted** to `workspace/images/`, encrypted at rest, and user-deletable — confirmed in
   code (`vision/history.ts`) and correctly documented in `README.md`, `PRIVACY.md`,
   `security-model.md`, and `known-limitations.md`. Two user-facing docs make a **false privacy
   promise**.
2. **DOC-002 (High) — false capability claim in `SECURITY.md`.** Line 78 states "Scanned-PDF OCR is
   **not** included in Lite." OCR shipped (Phase 38, "Make searchable (OCR)") and is documented as
   shipped in five other docs.

**Most important contradictions:** the two above, plus **DOC-003** — three docs (incl. `README.md`)
name a button **"Start mock runtime"** that was renamed **"Try in demo mode"** (the old literal is now
banned by a copy-tone test).

**Most important missing docs:** `CHANGELOG.md` (DOC-013) and `CODE_OF_CONDUCT.md` (DOC-014).

**Brand drift:** ~~a stale pre-rebrand product name survives in `packaging.md` ("Private AI Drive
Lite.app", DOC-004) and the example macOS volume label is inconsistent across docs
(`HILBERTRAUM` vs `PRIVATE_AI_DRIVE`, DOC-005).~~ ✅ **Fixed in Phase 2 (2026-06-29).**

**Recommended first phase:** ~~**Phase 1 — user-facing accuracy fixes** (DOC-001, DOC-002,
DOC-003)~~ ✅ **DONE (2026-06-29)**. ~~Phase 2 — brand & naming consistency (DOC-004, DOC-005,
DOC-012)~~ ✅ **DONE (2026-06-29)**. **Next:** Phase 3 — cross-link & anchor hygiene (DOC-006,
DOC-008, DOC-009): `/docs-fix phase 3`.

**Estimated effort:** Phase 1 ≈ 30 min. Whole remediation ≈ 3–4 hours, most of it the two new files
(CHANGELOG, CODE_OF_CONDUCT) and the header-freshness sweep.

## Document inventory

| Document | Apparent purpose | Status | Notes |
|---|---|---|---|
| `CLAUDE.md` | Agent operating manual / hard rules | Good | Accurate; commands match `package.json`. |
| `README.md` | Project front door, setup, model catalog | Good | DOC-003 button label fixed (Phase 1). No open findings. |
| `CONTRIBUTING.md` | Contributor workflow & ground rules | Good | Matches `package.json` engines + scripts. |
| `SECURITY.md` | Security policy & threat-model summary | Needs update | DOC-002 (OCR) fixed (Phase 1); DOC-007 stale header remains (Phase 4). |
| `PRIVACY.md` | Plain-language privacy notice | Good | Correct on image-history persistence. |
| `LICENSE` | GPL-3.0-or-later full text | Good | Matches `package.json` `license`. |
| `CLAUDE_HilbertRaum_MVP.md` | Original frozen product/architecture spec | Unclear | DOC-016: frozen historical spec; resolved "open questions" + superseded specifics may mislead. |
| `BUILD_STATE.md` | Live build-state / handoff log (~815 KB) | Needs update | DOC-006: 32 broken links (retired plans + `filing-suggestions.ts`). |
| `docs/architecture.md` | System design + design records (~477 KB) | Needs update | DOC-007 stale header (06-28 vs 06-29 content). Otherwise consistent. |
| `docs/rag-design.md` | Retrieval pipeline design records | Needs update | DOC-007 stale header; DOC-009 reranker size vs ledger. |
| `docs/security-model.md` | Threat model, vault, offline guard, audit log | Needs update | DOC-007 stale header. Content otherwise correct. |
| `docs/known-limitations.md` | Consciously-accepted gaps | Good | Correct on OCR + image history. References an unwritten `update-bundles-plan.md` (intended). |
| `docs/design-guidelines.md` | UI/UX + brand + copy guidelines | Needs update | DOC-010: §11.2 superseded blue accent not flagged. |
| `docs/model-policy.md` | Manifest schema, roles, license gate | Good | Detailed and consistent. |
| `docs/model-benchmarks.md` | Measured speed/RAM/quality + harness | Needs update | DOC-008: broken intra-doc anchor "§4.6". |
| `docs/packaging.md` | Portable build, sidecars, drive build | Good | DOC-004 (macOS `.app` example) fixed (Phase 2). No open findings. |
| `docs/drive-layout.md` | On-drive directory layout | Good | DOC-005 (`PRIVATE_AI_DRIVE`→`HILBERTRAUM`) fixed (Phase 2). No open findings. |
| `docs/user-guide.md` | End-user walkthrough of every screen | Needs update | DOC-001 (images) + DOC-003 fixed (Phase 1); DOC-011 remains (Phase 4). |
| `docs/troubleshooting.md` | Common problems & fixes | Good | DOC-001 (images) + DOC-003 fixed (Phase 1); DOC-005 fixed (Phase 2). No open findings. |
| `docs/benchmark.md` | Hardware benchmark & recommendation | Good | Consistent with `model-benchmarks.md`. |
| `docs/big-slot-embeddings-plan.md` | Open Phase-30 plan (working paper) | Unclear | DOC-015: "not started" since 2026-06-11; verify still open vs superseded. |
| `docs/design-review/skills-s12/README.md` | Design-review screenshot index | Good | Not deeply audited (review artifact). |
| `model-manifests/README.md` | Manifest authoring guide | Good | DOC-012 (embeddings F16, not "Q8") fixed (Phase 2). No open findings. |

## Findings index

| ID | Title | Severity | Confidence | Category | Status | Affected document(s) | Phase |
|---|---|---|---|---|---|---|---|
| DOC-001 | Image history documented as "not saved" (contradicts persisted encrypted history) | High | High | Accuracy / Privacy | Fixed | `user-guide.md`, `troubleshooting.md` | 1 |
| DOC-002 | `SECURITY.md` says OCR "not included in Lite" (OCR shipped) | High | High | Accuracy / Security | Fixed | `SECURITY.md` | 1 |
| DOC-003 | "Start mock runtime" button label renamed to "Try in demo mode" | Medium | High | Accuracy / Consistency | Fixed | `README.md`, `user-guide.md`, `troubleshooting.md`, `sample-data/README.md` | 1 |
| DOC-004 | Stale pre-rebrand product name "Private AI Drive Lite.app" | Medium | High | Consistency / Accuracy | Fixed | `packaging.md` | 2 |
| DOC-005 | Inconsistent example volume label (`HILBERTRAUM` vs `PRIVATE_AI_DRIVE`) | Medium | High | Consistency | Fixed | `drive-layout.md`, `troubleshooting.md` | 2 |
| DOC-006 | `BUILD_STATE.md` broken links to retired plans + source files | Low | High | Navigation | Open | `BUILD_STATE.md` | 3 |
| DOC-007 | Stale "Last updated" headers (content newer than header) | Low | High | Maintainability | Open | `architecture.md`, `rag-design.md`, `security-model.md`, `SECURITY.md` | 4 |
| DOC-008 | Broken intra-doc anchor "§4.6" (should be §7.3) | Low | High | Navigation | Open | `model-benchmarks.md` | 3 |
| DOC-009 | Reranker size "1.08 GiB" contradicts §26 ledger "1.16 GB" | Low | Medium | Consistency | Open | `rag-design.md` | 3 |
| DOC-010 | §11.2 present-tense blue accent superseded by teal, not flagged | Low | Medium | Accuracy / Clarity | Open | `design-guidelines.md` | 4 |
| DOC-011 | User guide documents a "Not recommended" status never produced | Low | Medium | Accuracy | Open | `user-guide.md` | 4 |
| DOC-012 | Manifests README calls embeddings "Q8" (shipped is F16) | Low | Medium | Clarity / Accuracy | Fixed | `model-manifests/README.md` | 2 |
| DOC-013 | Missing `CHANGELOG.md` | Medium | High | Completeness | Open | (new file) | 5 |
| DOC-014 | Missing `CODE_OF_CONDUCT.md` | Low | High | Completeness | Open | (new file) | 5 |
| DOC-015 | `big-slot-embeddings-plan.md` status reconcile ("not started" since 06-11) | Low | Medium | Accuracy / Maintainability | Open | `big-slot-embeddings-plan.md` | 6 |
| DOC-016 | Frozen original spec may mislead (resolved "open questions", superseded specifics) | Low | Medium | Clarity | Open | `CLAUDE_HilbertRaum_MVP.md` | 6 |

## Detailed findings

### DOC-001: Image-analysis history documented as "not saved" — contradicts the persisted, encrypted, deletable history

- **Status:** Fixed (2026-06-29) — Rewrote `user-guide.md` §8 (the closing "are not saved … gone
  when you leave" sentence, plus the "Remove … clears the thread" line) and the `troubleshooting.md`
  image bullet (≈line 253) to the persisted-history posture from `PRIVACY.md`: the picture/question/
  answer are **never uploaded** but **are saved** to the image history under `workspace/images/`,
  encrypted at rest on an encrypted workspace, revisitable from the Images screen, and user-deletable.
  Clarified the actual `Remove` semantics (verified in `ImagesScreen.tsx`: `Remove` returns to the
  landing view and does **not** delete the saved session; `Delete` from the history list shreds it).
  Validation: grep `user-guide.md`/`troubleshooting.md` for `not saved|never saved|nothing persists`
  → only the unrelated **voice-dictation** "never saved" (`user-guide.md:225`) remains, which is
  correct. No code touched.
- **Severity:** High
- **Confidence:** High
- **Category:** Accuracy / Privacy docs
- **Affected documents:** `docs/user-guide.md`, `docs/troubleshooting.md`
- **Affected sections:** user-guide.md §8 "Ask about an image" (lines 503–504); troubleshooting.md
  "Asking about an image is slow / 'Starting the vision model…'" (≈line 253)
- **Related code checked:** `apps/desktop/src/main/services/vision/history.ts` (lines 12–20),
  `apps/desktop/src/main/services/db.ts`, `workspace-vault.ts`
- **Description:** Two user-facing docs state that analyzed images and their Q&A are **not persisted**.
  The feature was deliberately changed: image-analysis history **is saved** under `workspace/images/`
  (encrypted as `.enc` sidecars when the vault is encrypted), survives leaving the screen, and is
  user-deletable. The other docs (`README.md`, `PRIVACY.md`, `security-model.md`,
  `known-limitations.md`, `architecture.md`, `model-policy.md`, `drive-layout.md`) describe the
  persisted behavior correctly.
- **Evidence:**
  - `user-guide.md:503` — "the picture, your question, and the answer are never uploaded and **are not
    saved**: they live only on the screen and are gone when you remove the image or leave."
  - `troubleshooting.md:253` — "The picture and answers are **never saved** — they clear when you
    remove the image or leave the screen."
  - `vision/history.ts:18` — "Privacy posture (**revised from 'nothing persists'** … the history is
    LOCAL-ONLY, encrypted at rest, and user-deletable."
  - `PRIVACY.md:49` — "Image-analysis history … is saved so you can revisit it — stored in
    `workspace/images/`; deletable at any time."
- **Why it matters:** This is a **privacy misstatement in user-facing docs**. A privacy-conscious user
  who reads the guide/troubleshooting will wrongly believe analyzed images leave no on-disk trace,
  when an encrypted copy is in fact written to the drive. It also directly contradicts `PRIVACY.md`
  and `README.md`.
- **Recommended fix:** Replace the "not saved / never saved / gone when you leave" wording in both
  docs with the persisted-history posture used in `PRIVACY.md` (saved to `workspace/images/`,
  encrypted at rest on an encrypted workspace, deletable at any time, never uploaded). If a transient
  "Remove clears the on-screen thread" UX nuance is real, phrase it as "Remove clears the current view
  — the saved history entry is deleted/kept per …" consistent with the actual delete semantics.
- **Validation needed after fix:** Re-read both passages against `PRIVACY.md` §"What data is stored"
  and `vision/history.ts`; confirm no remaining "not saved"/"never saved"/"nothing persists" phrasing
  for images via grep.
- **Documentation update notes:** Mark DOC-001 Fixed; add Remediation-log row.
- **Suggested phase:** 1

### DOC-002: `SECURITY.md` claims scanned-PDF OCR is "not included in Lite" (OCR has shipped)

- **Status:** Fixed (2026-06-29) — Replaced `SECURITY.md:78` ("Scanned-PDF OCR is **not** included in
  Lite.") with an accurate scoped statement: OCR ("Make searchable") runs **on-device only**, bundled
  German + English tesseract language files, no cloud OCR, recognition quality not guaranteed.
  Language scope (`{deu,eng}.traineddata.gz`) verified against `drive-layout.md` §"OCR language files
  (Phase 38)" and the tesseract.js/on-device claim against `model-policy.md` §"The OCR asset class
  (Phase 38)". "Lite" left intact elsewhere (it is the current edition name; only the OCR-exclusion
  claim was wrong). Note: the file's stale `_Last updated: 2026-06-15_` header (predates Phase 38) is
  the separate DOC-007 (Phase 4). Validation: grep `SECURITY.md` for "OCR" → only the corrected line.
- **Severity:** High
- **Confidence:** High
- **Category:** Accuracy / Security docs
- **Affected document:** `SECURITY.md`
- **Affected section:** "Known limitations" (line 78)
- **Related code/docs checked:** `docs/model-policy.md` "The OCR asset class (Phase 38)",
  `docs/drive-layout.md` "OCR language files (Phase 38)", `docs/troubleshooting.md` "Importing a PDF
  didn't extract any text", `docs/known-limitations.md` lines 695–728, `apps/desktop/package.json`
  (`tesseract.js` dependency)
- **Description:** OCR ("Make searchable (OCR)") shipped in Phase 38 (tesseract.js + `ocr/` language
  files) and is documented as shipped in at least five other docs. `SECURITY.md` still lists OCR as a
  not-included limitation. The claim is flatly false.
- **Evidence:** `SECURITY.md:78` — "Scanned-PDF OCR is **not** included in Lite." vs
  `model-policy.md:276` "## The OCR asset class (Phase 38)" and `troubleshooting.md` "Make searchable
  (OCR)".
- **Why it matters:** A false capability statement in a trust-critical, public-facing security policy
  doc. Readers treat `SECURITY.md` as authoritative.
- **Recommended fix:** Delete the line, or replace it with an accurate scoped statement (e.g.
  "Local OCR is on-device only — German + English language files, no cloud OCR"). Note: "Lite" is the
  current **edition name**, so don't blanket-replace "Lite"; only the OCR-exclusion claim is wrong.
- **Validation needed after fix:** grep `SECURITY.md` for "OCR"; confirm consistency with
  `model-policy.md`/`known-limitations.md`.
- **Documentation update notes:** Mark Fixed; this also overlaps DOC-007 (the file's stale 2026-06-15
  header predates Phase 38).
- **Suggested phase:** 1

### DOC-003: Docs name a "Start mock runtime" button that was renamed "Try in demo mode"

- **Status:** Fixed (2026-06-29) — Replaced "Start mock runtime" → "Try in demo mode" in
  `README.md:105`, `user-guide.md:138`, and `troubleshooting.md:56`, and aligned the nearby
  affordance prose with the app's vocabulary ("demo mode" / "simulated placeholders" / "demo
  answers"; troubleshooting heading section now says "built-in **demo mode**"). **Scope extension:**
  a fourth instructional instance not listed in the original finding — `sample-data/README.md:23` —
  was found by the validation grep and also fixed (same stale user-facing label). Verified the
  shipping label against `en.ts:700` (`'models.startMock': 'Try in demo mode'`) and the ban on the
  old literal against `copy-tone.test.ts:76`. Validation: grep all `*.md` for "Start mock runtime"
  → remaining hits are only the **intentional historical rename records** (`BUILD_STATE.md:5597`,
  `design-guidelines.md:664/676`) and this audit report; bare "mock runtime" hits are all
  internal/architectural/test-harness terminology the audit explicitly permits to remain.
- **Severity:** Medium
- **Confidence:** High
- **Category:** Accuracy / Consistency
- **Affected documents:** `README.md`, `docs/user-guide.md`, `docs/troubleshooting.md`
- **Affected sections:** README "1. Run the app" (line 105); user-guide.md §5 (line 138);
  troubleshooting.md "The answers look like placeholders" (line 56)
- **Related code checked:** `apps/desktop/src/shared/i18n/en.ts:700` (`'models.startMock': 'Try in
  demo mode'`); `apps/desktop/tests/unit/copy-tone.test.ts:76` (asserts no string literal says "Start
  mock runtime"); `design-guidelines.md` §11.7 records the relabel
- **Description:** The demo affordance button is labeled **"Try in demo mode"** in the shipping UI, and
  a copy-tone test explicitly bans the literal "Start mock runtime" (and "mock runtime"/"Demo-Runtime"
  as developer jargon). Three docs still instruct users to click "Start mock runtime".
- **Evidence:** `README.md:105`, `user-guide.md:138`, `troubleshooting.md:56` all say "Start mock
  runtime"; `en.ts:700` says the label is "Try in demo mode".
- **Why it matters:** Users searching the AI Model screen for "Start mock runtime" won't find it. The
  README is the project's front door, so the wrong label there is the most visible instance.
- **Recommended fix:** Replace "Start mock runtime" with "Try in demo mode" in all three docs; align
  surrounding "mock"/"mock answers" prose with the app's "demo mode"/"simulated answers" vocabulary
  where it refers to the user-visible affordance (internal/architectural "mock runtime" terminology
  may remain in developer docs).
- **Validation needed after fix:** grep all docs for "Start mock runtime"; cross-check against
  `en.ts` labels.
- **Documentation update notes:** Mark Fixed.
- **Suggested phase:** 1

### DOC-004: Stale pre-rebrand product name "Private AI Drive Lite.app" in `packaging.md`

- **Status:** Fixed (2026-06-29) — Changed the macOS `--app-artifact` example at `packaging.md:309`
  from `./apps/desktop/release/Private\ AI\ Drive\ Lite.app` to
  `./apps/desktop/release/HilbertRaum.app`, matching the rebrand and the Windows
  `HilbertRaum-0.1.0-portable.exe` example three lines above. Validation: grep docs for
  `Private AI Drive` → only the `BUILD_STATE.md` historical rebrand note and this audit report
  remain (both intended). No code touched.
- **Severity:** Medium
- **Confidence:** High
- **Category:** Consistency / Accuracy
- **Affected document:** `docs/packaging.md`
- **Affected section:** "The `build-commercial-drive` master pipeline" — macOS example (line 309)
- **Description:** The product was renamed from "Private AI Drive Lite" / "PAID" → "HilbertRaum"
  (recorded in `BUILD_STATE.md`). The Windows example three lines above correctly uses
  `HilbertRaum-0.1.0-portable.exe`, but the macOS example still passes
  `./apps/desktop/release/Private\ AI\ Drive\ Lite.app`.
- **Evidence:** `packaging.md:309` — `--app-artifact ./apps/desktop/release/Private\ AI\ Drive\
  Lite.app` vs `packaging.md:304` — `HilbertRaum-0.1.0-portable.exe`.
- **Why it matters:** Leftover from an incomplete rebrand; a copy-paste of the macOS example points at
  a non-existent artifact name and reintroduces the dead brand.
- **Recommended fix:** Change to `HilbertRaum.app` (match the rebrand and the `.exe` example's
  convention).
- **Validation needed after fix:** grep docs for "Private AI Drive"; confirm only `BUILD_STATE.md`'s
  historical rebrand note retains it.
- **Documentation update notes:** Mark Fixed.
- **Suggested phase:** 2

### DOC-005: Inconsistent example macOS volume label across docs (`HILBERTRAUM` vs `PRIVATE_AI_DRIVE`)

- **Status:** Fixed (2026-06-29) — Standardized the example macOS volume label on `HILBERTRAUM`:
  `drive-layout.md` prepared-drive sketch header `PRIVATE_AI_DRIVE/` → `HILBERTRAUM/` (line 57) and
  all four `/Volumes/PRIVATE_AI_DRIVE` prepare/verify examples (lines 149–152) → `/Volumes/HILBERTRAUM`;
  `troubleshooting.md:92` checksum example likewise. Now consistent with `README.md` and
  `packaging.md`. Validation: grep docs for `PRIVATE_AI_DRIVE` → only the frozen spec
  `CLAUDE_HilbertRaum_MVP.md` (per DOC-016), the `BUILD_STATE.md` historical note, and this report
  remain (all intended). Verified no script *logic* depends on the literal — `PRIVATE_AI_DRIVE` in
  `scripts/*.sh` (`fetch-models.sh`, `fetch-runtime.sh`, `prepare-drive.sh`, `verify-models.sh`,
  `setup-dev.sh`) appears **only** in `#` usage-comment examples and one `echo` help string (it is
  the user-supplied `--target` value). Those shell-script comments are outside the `/docs-fix`
  documentation scope and were left unchanged — see follow-up note in the Remediation log. No code
  touched.
- **Severity:** Medium
- **Confidence:** High
- **Category:** Consistency
- **Affected documents:** `docs/drive-layout.md`, `docs/troubleshooting.md` (vs `README.md`,
  `docs/packaging.md`)
- **Affected sections:** drive-layout.md prepared-drive sketch (line 57) and prepare/verify examples
  (lines 149–152); troubleshooting.md checksum example (line 92)
- **Description:** README and packaging.md use `/Volumes/HILBERTRAUM` for the example macOS mount;
  drive-layout.md and troubleshooting.md use `/Volumes/PRIVATE_AI_DRIVE` and a `PRIVATE_AI_DRIVE/`
  layout header — a residual pre-rebrand volume label.
- **Evidence:** `README.md:125` `--target /Volumes/HILBERTRAUM`; `drive-layout.md:149`
  `--target /Volumes/PRIVATE_AI_DRIVE`; `troubleshooting.md:92` `--target /Volumes/PRIVATE_AI_DRIVE`.
- **Why it matters:** Inconsistent example naming for the same concept across the docs a drive-builder
  reads back-to-back; reinforces the dead brand.
- **Recommended fix:** Standardize on `/Volumes/HILBERTRAUM` (and `HILBERTRAUM/` in the layout sketch)
  in drive-layout.md and troubleshooting.md. Note: the *physical dev smoke drive* literally named
  `paid-gpu-smoke-drive` / "PAID smoke drive" in `BUILD_STATE.md`/`architecture.md`/`model-benchmarks.md`
  is a real on-disk artifact name and is **out of scope** (do not rename).
- **Validation needed after fix:** grep docs for `PRIVATE_AI_DRIVE` (expect only the frozen spec
  `CLAUDE_HilbertRaum_MVP.md` to retain it, per DOC-016).
- **Documentation update notes:** Mark Fixed.
- **Suggested phase:** 2

### DOC-006: `BUILD_STATE.md` has broken links to retired plan files and a renamed source file

- **Status:** Open
- **Severity:** Low
- **Confidence:** High
- **Category:** Navigation
- **Affected document:** `BUILD_STATE.md`
- **Description:** A relative-link scan found 32 broken links, all in `BUILD_STATE.md`. Most point to
  plan files that were **intentionally deleted** per the CLAUDE.md doc-lifecycle rule (condensed into
  topic-doc design records): `image-understanding-plan.md`, `context-compaction-plan.md`,
  `brand-refresh-plan.md`, `full-doc-skills-plan.md`, `skills-s11-plan.md`, `skills-plan.md`,
  `whole-document-analysis-plan.md`, `document-organization-plan.md`,
  `performance-audit-2026-06-18.md`. Three point to source paths that appear renamed/removed:
  `apps/desktop/src/main/services/filing-suggestions.ts` and its two test files.
- **Evidence:** Link scan output (32 hits, all `BUILD_STATE.md`). The retired-plan links are
  consistent with the lifecycle rule (plans live in git history); the `filing-suggestions.ts` links
  suggest a stale code reference.
- **Why it matters:** `BUILD_STATE.md` is the "read first" handoff doc. Broken links degrade its
  navigability. Per the lifecycle rule the retired-plan links are *expected* to break, but they are
  still dead links a reader will click.
- **Recommended fix:** For retired plans, either (a) convert the inline links to plain text with a
  "(retired — see <topic-doc> §N; original in git history)" note, or (b) leave as-is by policy but
  record that decision here so future audits don't re-flag. For `filing-suggestions.ts`, verify the
  current path and update or de-link. **Low priority** given the file's size and historical nature.
- **Validation needed after fix:** Re-run the relative-link scan; confirm the count drops.
- **Documentation update notes:** If the team decides retired-plan links are acceptable-by-policy,
  mark this finding `Superseded` with that rationale rather than churning 800 KB of history.
- **Suggested phase:** 3

### DOC-007: Stale "Last updated" headers (header date older than the newest embedded content)

- **Status:** Open
- **Severity:** Low
- **Confidence:** High
- **Category:** Maintainability / Accuracy
- **Affected documents:** `docs/architecture.md`, `docs/rag-design.md`, `docs/security-model.md`,
  `SECURITY.md`
- **Description:** Several docs carry a `_Last updated:_` header whose date predates content embedded
  later in the same file.
  - `architecture.md` header "2026-06-28" but contains §27–§34 (the full post-merge **2026-06-29**
    audit, final suite count 2532).
  - `rag-design.md` header "2026-06-15" but body cites the 2026-06-27, 2026-06-28, and 2026-06-29
    audits.
  - `security-model.md` header "2026-06-20" but body documents the 2026-06-28/29 audits (F14/F15/F17,
    SEC-1).
  - `SECURITY.md` header "2026-06-15" predates Phase 38 (OCR) and the image-understanding work.
- **Why it matters:** A reader uses the header to judge freshness; a stale header undermines trust and
  can mask whether a doc reflects the latest state.
- **Recommended fix:** Update each `_Last updated:_` line to the date of its newest content (or adopt a
  convention of bumping it whenever a §-record is appended). Low-risk, mechanical.
- **Validation needed after fix:** Spot-check each header date ≥ the latest dated record in the file.
- **Documentation update notes:** Pairs naturally with DOC-002 (SECURITY.md) and DOC-010.
- **Suggested phase:** 4

### DOC-008: Broken intra-doc anchor "§4.6" in `model-benchmarks.md` (should be §7.3)

- **Status:** Open
- **Severity:** Low
- **Confidence:** High
- **Category:** Navigation
- **Affected document:** `docs/model-benchmarks.md`
- **Affected section:** line 157
- **Description:** Line 157 cites "the **§4.6** German wobble", but §4 has no subsections; the "German
  wobble" is documented in §7.3 (and line 209 of the same file correctly cites "§7.3").
- **Evidence:** `model-benchmarks.md:157` "(the **§4.6** German wobble)" vs `:209` "The §7.3 bring-up
  'German wobble'".
- **Why it matters:** Dangling internal cross-reference; minor but trivially fixable.
- **Recommended fix:** Change "§4.6" → "§7.3".
- **Validation needed after fix:** Confirm §7.3 exists and discusses the German wobble.
- **Suggested phase:** 3

### DOC-009: Reranker RSS "1.08 GiB" in `rag-design.md` contradicts the §26 ledger ("changed to 1.16 GB")

- **Status:** Open
- **Severity:** Low
- **Confidence:** Medium
- **Category:** Consistency
- **Affected document:** `docs/rag-design.md` (§12.3, ≈line 848); cross-ref `architecture.md` §26
  DOC-3 (≈line 4111)
- **Description:** `architecture.md` §26's audit ledger records that it corrected "rag-design.md §12.3"
  reranker size from "~1.08 GB" to "~1.16 GB" (to match the manifest `size_on_disk_gb: 1.16`), but
  rag-design.md §12.3 still reads "1.08 GiB". (Arithmetically 1.08 GiB ≈ 1.16 GB, so the figure isn't
  *wrong* — but it contradicts a ledger entry asserting this exact spot was changed, suggesting the
  edit didn't land or the ledger over-claimed.)
- **Recommended fix:** Reconcile: either update §12.3 to "~1.16 GB" (GB, matching the manifest and the
  ledger) or correct the §26 ledger to reflect that §12.3 intentionally uses GiB. Prefer matching the
  manifest unit (GB).
- **Validation needed after fix:** Confirm the reranker size string and unit match the manifest
  `bge-reranker-v2-m3.yaml` and the §26 ledger.
- **Suggested phase:** 3

### DOC-010: `design-guidelines.md` §11.2 states the retired blue accent in the present tense

- **Status:** Open
- **Severity:** Low
- **Confidence:** Medium
- **Category:** Accuracy / Clarity
- **Affected document:** `docs/design-guidelines.md` (§11.2, ≈lines 386–387)
- **Description:** §11.2 asserts (present tense, no superseded marker) that filled controls "use
  `--accent-600 #2f6fed` … in both themes", but §4.2 and §13 (the 2026-06 brand refresh) record that
  the blue ramp was retired in favor of teal (`#1B7F5F` light / `#57D0A4` dark). §4.2 flags its blue
  as historical; §11.2 does not.
- **Recommended fix:** Add a "(superseded by the §13 brand refresh — now teal)" note to §11.2, or
  update the value, so a reader doesn't take the blue as current.
- **Validation needed after fix:** Confirm §11.2 no longer presents `#2f6fed` as the current accent.
- **Suggested phase:** 4

### DOC-011: User guide lists a "Not recommended" model status that the code never produces

- **Status:** Open
- **Severity:** Low
- **Confidence:** Medium
- **Category:** Accuracy
- **Affected document:** `docs/user-guide.md` (§5 model-status list, ≈line 124)
- **Related doc checked:** `docs/known-limitations.md` (≈line 172) — `not_recommended` "is declared but
  never produced" (no code path sets it).
- **Description:** The guide documents a user-visible "Not recommended" status, but per
  known-limitations.md no code path ever emits it, so the user can never see it.
- **Recommended fix:** Either remove "Not recommended" from the user-facing status list, or footnote it
  as a declared-but-unused state. Cross-check against the actual statuses `services/models.ts` emits.
- **Validation needed after fix:** Confirm the documented statuses match what the renderer can display.
- **Suggested phase:** 4

### DOC-012: `model-manifests/README.md` describes the embeddings model as "Q8" (shipped is F16)

- **Status:** Fixed (2026-06-29) — Rewrote `model-manifests/README.md:9` from "(Multilingual E5
  Small, Q8)" to "(Multilingual E5 Small, F16; the manifest `id`/`local_path` keep a `-q8` suffix
  for historical stability … **not** a quant claim. Q8 is *not* the shipping quant — its q8_0
  conversion crashes the pinned runtime; see `../docs/model-policy.md`.)". Verified against the
  embeddings manifest (`multilingual-e5-small-q8.yaml`: `display_name: Multilingual E5 Small (F16)`,
  plus the header comment explaining the `-q8` id is a stable opaque identifier) and `model-policy.md`
  (line 32 "Multilingual E5 Small (F16)"; lines 37–46 "uses an F16 GGUF, not Q8 — the q8_0
  conversions … crash llama.cpp b9585"). No code touched.
- **Severity:** Low
- **Confidence:** Medium
- **Category:** Clarity / Accuracy
- **Affected document:** `model-manifests/README.md` (line 9)
- **Related doc checked:** `model-policy.md:32` ("Multilingual E5 Small (**F16**)") and the note that
  the q8_0 conversion crashes b9585.
- **Description:** The README lists "embeddings/ — embedding models (Multilingual E5 Small, **Q8**)".
  The shipped embedder is **F16**; the manifest *id* is `multilingual-e5-small-q8` (a deliberately
  stable opaque id), but the README's "Q8" reads as if Q8 is the shipping quant — which `model-policy.md`
  explicitly says it is **not** (Q8 crashes the pinned runtime).
- **Recommended fix:** Change to "Multilingual E5 Small (F16; the manifest id retains a `-q8` suffix for
  historical stability — see model-policy.md)" or simply "(F16)".
- **Validation needed after fix:** Cross-check with `model-policy.md` and the embeddings manifest's
  `display_name`.
- **Suggested phase:** 2

### DOC-013: Missing `CHANGELOG.md`

- **Status:** Open
- **Severity:** Medium
- **Confidence:** High
- **Category:** Completeness
- **Affected document:** (new file `CHANGELOG.md`)
- **Description:** No `CHANGELOG.md` exists. `CONTRIBUTING.md` mandates **Conventional Commits** and a
  per-phase doc ritual, and `package.json` is at `0.1.34`, but there is no human-readable release/version
  history. `BUILD_STATE.md` is a live state log, not a changelog.
- **Why it matters:** For an open-source project with versioned releases, a changelog is the standard
  way users and contributors track what changed between versions. Its absence is a notable completeness
  gap given the Conventional-Commits discipline already in place.
- **Recommended fix:** Add a `CHANGELOG.md` (Keep-a-Changelog format), seeded from the Conventional
  Commit history / `BUILD_STATE.md` milestones, and link it from `README.md`. Alternatively, document
  explicitly (in README or CONTRIBUTING) that `BUILD_STATE.md` is the changelog-of-record and why no
  separate file exists.
- **Validation needed after fix:** README links to it; format parses.
- **Suggested phase:** 5

### DOC-014: Missing `CODE_OF_CONDUCT.md`

- **Status:** Open
- **Severity:** Low
- **Confidence:** High
- **Category:** Completeness
- **Affected document:** (new file `CODE_OF_CONDUCT.md`)
- **Description:** No code of conduct exists. `CONTRIBUTING.md` welcomes contributions but there is no
  conduct policy — a common expectation for a public OSS repo, and one the `/docs-audit` checklist
  flags.
- **Recommended fix:** Add a `CODE_OF_CONDUCT.md` (e.g. Contributor Covenant) and link it from
  `CONTRIBUTING.md`/`README.md`. Low priority for a pre-1.0 project but cheap to add.
- **Validation needed after fix:** Linked from CONTRIBUTING/README.
- **Suggested phase:** 5

### DOC-015: `big-slot-embeddings-plan.md` status reconcile ("WORKING PAPER — not started" since 2026-06-11)

- **Status:** Open
- **Severity:** Low
- **Confidence:** Medium
- **Category:** Accuracy / Maintainability
- **Affected document:** `docs/big-slot-embeddings-plan.md`
- **Description:** This is the one standalone open plan file the CLAUDE.md lifecycle rule explicitly
  sanctions (work still open). Its header says "**WORKING PAPER — not started (created 2026-06-11)**"
  (Phase 30, tracks A/B). The project has since progressed through many later phases (image
  understanding, OCR, multiple audits through 2026-06-29). None of the plan's candidate models
  (Gemma 4 26B-A4B, Mistral Small 3.2 24B, Granite 4.0 H-Small, Granite Embedding R2) appear in the
  shipped catalog, and the default embedder is still E5 — consistent with "not started." This is **not
  a defect** under the lifecycle rule, but the "not started" status 18+ days on, amid heavy
  surrounding progress, is worth an explicit reconcile so the file doesn't quietly rot.
- **Recommended fix:** Add a one-line dated status note (still open / parked / superseded) at the top.
  If genuinely abandoned, fold any durable decisions into `model-benchmarks.md`/`model-policy.md` and
  delete per the lifecycle rule. If still planned, confirm "still open" with today's date.
- **Validation needed after fix:** Status line present and dated; matches reality of the catalog.
- **Suggested phase:** 6

### DOC-016: Frozen original spec may mislead a new reader (resolved "open questions", superseded specifics)

- **Status:** Open
- **Severity:** Low
- **Confidence:** Medium
- **Category:** Clarity
- **Affected document:** `CLAUDE_HilbertRaum_MVP.md`
- **Description:** `CLAUDE.md` points to this file as "the original product/architecture spec (source
  of truth for *what* to build)." It is a frozen historical spec and still contains items now resolved
  or superseded by the as-built topic docs: the dropped Qwen3-1.7B model, `windows/macos/linux`
  directory naming (reconciled to `win/mac/linux` in drive-layout.md), the `PRIVATE_AI_DRIVE` volume
  label, "OCR is not included in this Lite MVP" (now shipped), and an "Open questions" section several
  of whose entries are decided. The topic docs already record each reconciliation, but a new
  reader/agent told this is the "source of truth" could take a superseded specific at face value.
- **Recommended fix:** Add a short banner at the top of `CLAUDE_HilbertRaum_MVP.md`: "Frozen original
  spec (2026-06-13). Source of truth for **intent**; for the **as-built** system the topic docs under
  `docs/` and `BUILD_STATE.md` supersede any specific that has since changed (drive naming, the 1.7B
  model, OCR availability, resolved open questions)." No content rewrite needed.
- **Validation needed after fix:** Banner present; CLAUDE.md's pointer optionally notes the
  supersedence.
- **Suggested phase:** 6

## Contradictions

| # | Documents involved | Conflicting statements | Likely source of truth | Recommended resolution | Finding |
|---|---|---|---|---|---|
| C1 | `user-guide.md` / `troubleshooting.md` **vs** `PRIVACY.md` / `README.md` / `security-model.md` / `known-limitations.md` / code | "images … **are not saved** / **never saved** … gone when you leave" vs "image-analysis history **is saved** … encrypted … deletable" | The persisted-history docs + `vision/history.ts` ("revised from 'nothing persists'") | Rewrite the two guide passages to the persisted posture | DOC-001 (**Resolved**, Phase 1) |
| C2 | `SECURITY.md` **vs** `model-policy.md` / `drive-layout.md` / `troubleshooting.md` / `known-limitations.md` | "Scanned-PDF OCR is **not** included in Lite" vs "OCR asset class (Phase 38)" / "Make searchable (OCR)" | OCR is shipped (Phase 38, code + 5 docs) | Delete/rewrite the SECURITY.md line | DOC-002 (**Resolved**, Phase 1) |
| C3 | `README.md` / `user-guide.md` / `troubleshooting.md` **vs** app (`en.ts`) | "Start mock runtime" vs UI label "Try in demo mode" (literal banned by copy-tone test) | The app's i18n label | Replace label in all docs (also `sample-data/README.md`) | DOC-003 (**Resolved**, Phase 1) |
| C4 | `packaging.md` (macOS example) **vs** the rebrand + the `.exe` example | "Private AI Drive Lite.app" vs "HilbertRaum" | Rebrand → HilbertRaum | Rename the example artifact | DOC-004 (**Resolved**, Phase 2) |
| C5 | `drive-layout.md` / `troubleshooting.md` **vs** `README.md` / `packaging.md` | `/Volumes/PRIVATE_AI_DRIVE` vs `/Volumes/HILBERTRAUM` | Rebrand → HILBERTRAUM | Standardize on HILBERTRAUM | DOC-005 (**Resolved**, Phase 2) |
| C6 | `rag-design.md` §12.3 **vs** `architecture.md` §26 ledger | reranker "1.08 GiB" vs "changed to 1.16 GB" | Manifest `size_on_disk_gb: 1.16` | Reconcile to 1.16 GB | DOC-009 |
| C7 | `design-guidelines.md` §11.2 **vs** §4.2/§13 | present-tense blue `#2f6fed` vs retired-for-teal | §13 brand refresh (teal) | Mark §11.2 superseded | DOC-010 |
| C8 | `user-guide.md` **vs** `known-limitations.md` | documents a "Not recommended" status vs "declared but never produced" | known-limitations.md / code | Remove or footnote the status | DOC-011 |

## Missing documentation

| Topic | Why it matters | Suggested file/section | Priority | Finding |
|---|---|---|---|---|
| Release/version history | Conventional Commits + versioned `package.json` (0.1.34) with no human-readable change history | `CHANGELOG.md` (Keep-a-Changelog) | Medium | DOC-013 |
| Code of conduct | Standard for a public OSS contribution surface | `CODE_OF_CONDUCT.md` (Contributor Covenant) | Low | DOC-014 |
| Security contact | `SECURITY.md` says a contact "will be published before any public release" — no contact yet | `SECURITY.md` "Reporting a vulnerability" | Low (pre-1.0, acknowledged) | (note only) |
| Issue/PR templates | No `.github/ISSUE_TEMPLATE` or PR template; CONTRIBUTING covers the workflow in prose | `.github/` templates | Low | (note only) |

## Duplicated or overlapping documentation

| Documents involved | Duplicated topic | Risk of drift | Recommended consolidation | Finding |
|---|---|---|---|---|
| `SECURITY.md` (root) ↔ `docs/security-model.md` | Threat model, encryption, offline guard | **Realized** — root `SECURITY.md` drifted (OCR claim, stale header) while `security-model.md` stayed current | Keep `SECURITY.md` a short policy that **links** to `security-model.md` as the single source; trim duplicated mechanism detail; sync on each security change | DOC-002, DOC-007 |
| `PRIVACY.md` ↔ `docs/security-model.md` ↔ `docs/user-guide.md`/`troubleshooting.md` | Data retention / encryption / image history | **Realized** — guides drifted from the persisted-image posture in PRIVACY/security-model | Treat `PRIVACY.md` + `security-model.md` as the retention source of truth; make the guides defer to them for "what is stored" | DOC-001 |
| `README.md` ↔ `model-policy.md` ↔ `model-benchmarks.md` ↔ `benchmark.md` | Model catalog, RAM tiers, recommendations | Low — currently consistent | No action; keep the RAM-tier table in one canonical spot (model-policy) and have others cite it | — |
| `README.md` / `drive-layout.md` / `packaging.md` | Drive layout + prepare/fetch flow | Low–Medium — overlapping prepare-drive examples (and the volume-label drift, DOC-005) | Keep `drive-layout.md` canonical for the tree; README/packaging cite it (mostly already done) | DOC-005 |

## Broken or weak references

- **Broken relative links:** 32, **all in `BUILD_STATE.md`** (DOC-006) — retired plan files
  (`image-understanding-plan.md`, `context-compaction-plan.md`, `brand-refresh-plan.md`,
  `full-doc-skills-plan.md`, `skills-s11-plan.md`, `skills-plan.md`,
  `whole-document-analysis-plan.md`, `document-organization-plan.md`,
  `performance-audit-2026-06-18.md`) + source paths `apps/desktop/src/main/services/filing-suggestions.ts`
  and its two test files. **All other docs: zero broken links.**
- **Broken intra-doc anchor:** `model-benchmarks.md:157` "§4.6" (no such section; should be §7.3) —
  DOC-008.
- **References to not-yet-written docs (intended, not defects):** `known-limitations.md:199` →
  `docs/update-bundles-plan.md` (Phase 22 is explicitly still open; the doc is to be written before
  that code). No action.
- **Stale label reference (not a link):** "Start mock runtime" in README/user-guide/troubleshooting
  (and `sample-data/README.md`) → DOC-003 (**Resolved**, Phase 1; remaining hits are the intentional
  historical rename records in `BUILD_STATE.md`/`design-guidelines.md`).

## Documentation remediation plan

### Phase 1: User-facing accuracy fixes — ✅ DONE (2026-06-29)

- **Goal:** Eliminate the three flatly-wrong, trust-critical statements users will hit first.
- **Findings included:** DOC-001, DOC-002, DOC-003 — all Fixed. (Validation grep also surfaced a
  fourth DOC-003 instance, `sample-data/README.md`, which was fixed in the same pass.)
- **Documents affected:** `docs/user-guide.md`, `docs/troubleshooting.md`, `SECURITY.md`, `README.md`.
- **Exact intended changes:**
  - DOC-001: Rewrite user-guide.md §8 (lines 503–504) and troubleshooting.md (≈line 253) to the
    persisted-encrypted-deletable image-history posture from `PRIVACY.md`.
  - DOC-002: Remove/rewrite `SECURITY.md:78` ("Scanned-PDF OCR is not included in Lite").
  - DOC-003: Replace "Start mock runtime" with "Try in demo mode" in README.md:105, user-guide.md:138,
    troubleshooting.md:56 (and align nearby "mock" prose with "demo mode" where it names the affordance).
- **Code/config verification required:** Already done — `vision/history.ts`, `model-policy.md` OCR
  section, `en.ts:700`, `copy-tone.test.ts`. Re-confirm no behavior changed since this audit.
- **Validation steps:** grep all docs for `not saved|never saved|nothing persists` (images),
  `OCR.*not`, `Start mock runtime`; read each edited passage against its source-of-truth doc.
- **Acceptance criteria:** No doc claims analyzed images aren't saved; no doc claims OCR is unavailable;
  no doc says "Start mock runtime".
- **Risks:** Very low (wording-only).
- **Rollback notes:** Single-commit revert; no code touched.

### Phase 2: Brand & naming consistency — ✅ DONE (2026-06-29)

- **Goal:** Finish the rebrand and remove naming drift.
- **Findings included:** DOC-004, DOC-005, DOC-012 — all Fixed.
- **Documents affected:** `packaging.md`, `drive-layout.md`, `troubleshooting.md`,
  `model-manifests/README.md`.
- **Exact intended changes:** Rename `Private AI Drive Lite.app` → `HilbertRaum.app` (packaging.md:309);
  `PRIVATE_AI_DRIVE` → `HILBERTRAUM` in drive-layout.md (lines 57, 149–152) and troubleshooting.md:92;
  clarify embeddings as F16 in model-manifests/README.md:9.
- **Code/config verification required:** Confirm the embeddings manifest `display_name` ("F16") and
  that no script depends on the `PRIVATE_AI_DRIVE` literal (these are doc examples only).
- **Validation steps:** grep docs for `Private AI Drive`, `PRIVATE_AI_DRIVE` (expect only
  `CLAUDE_HilbertRaum_MVP.md` + `BUILD_STATE.md` historical note to remain).
- **Acceptance criteria:** Example brand/volume names consistent with `README.md`.
- **Risks:** Low. **Rollback:** single-commit revert.

### Phase 3: Cross-link & anchor hygiene

- **Goal:** Fix dead/contradictory references.
- **Findings included:** DOC-006, DOC-008, DOC-009.
- **Documents affected:** `BUILD_STATE.md`, `model-benchmarks.md`, `rag-design.md`.
- **Exact intended changes:** Fix `model-benchmarks.md:157` "§4.6"→"§7.3"; reconcile rag-design.md
  §12.3 reranker size to "1.16 GB"; decide BUILD_STATE.md retired-plan-link policy (de-link with a
  "retired" note, or record an accepted-by-policy decision here) and fix/de-link `filing-suggestions.ts`.
- **Code/config verification required:** Confirm `filing-suggestions.ts` current path; confirm reranker
  manifest size.
- **Validation steps:** Re-run the relative-link scan; confirm §7.3 exists.
- **Acceptance criteria:** Link scan count for non-BUILD_STATE docs stays 0; BUILD_STATE policy
  recorded; anchor + reranker figure consistent.
- **Risks:** Low (BUILD_STATE is large — prefer minimal edits). **Rollback:** revert.

### Phase 4: Header freshness & superseded markers

- **Goal:** Make "freshness" signals truthful.
- **Findings included:** DOC-007, DOC-010, DOC-011.
- **Documents affected:** `architecture.md`, `rag-design.md`, `security-model.md`, `SECURITY.md`,
  `design-guidelines.md`, `user-guide.md`.
- **Exact intended changes:** Bump each stale `_Last updated:_` to its newest content date; mark
  design-guidelines §11.2 as superseded by §13; remove/footnote the "Not recommended" status in
  user-guide §5.
- **Code/config verification required:** Confirm the model statuses `services/models.ts` actually emits
  (for DOC-011).
- **Validation steps:** Each header date ≥ newest dated record; §11.2 marked; status list matches code.
- **Risks:** Low. **Rollback:** revert.

### Phase 5: Completeness — new standard docs

- **Goal:** Add the missing OSS standard docs (or document why they're intentionally absent).
- **Findings included:** DOC-013, DOC-014.
- **Documents affected:** new `CHANGELOG.md`, new `CODE_OF_CONDUCT.md`; link from `README.md` /
  `CONTRIBUTING.md`.
- **Exact intended changes:** Seed a Keep-a-Changelog `CHANGELOG.md` from commit history/BUILD_STATE
  milestones (or document BUILD_STATE-as-changelog); add a Contributor Covenant `CODE_OF_CONDUCT.md`.
- **Validation steps:** Files parse; links resolve.
- **Risks:** Low (additive). **Rollback:** delete the new files.

### Phase 6: Historical-doc clarity

- **Goal:** Prevent the frozen spec and the open plan from misleading future readers.
- **Findings included:** DOC-015, DOC-016.
- **Documents affected:** `CLAUDE_HilbertRaum_MVP.md`, `big-slot-embeddings-plan.md` (and optionally a
  one-line note in `CLAUDE.md`).
- **Exact intended changes:** Add a "frozen historical spec — topic docs supersede" banner to
  `CLAUDE_HilbertRaum_MVP.md`; add a dated status line to `big-slot-embeddings-plan.md` (still
  open / parked / superseded), folding-and-deleting if abandoned per the lifecycle rule.
- **Validation steps:** Banner + status line present and accurate.
- **Risks:** Low. **Rollback:** revert.

## Recommended execution order

1. ~~**Phase 1**~~ ✅ **DONE (2026-06-29)** — fixed the statements that actively misled users about
   **privacy** (images on disk) and **capability** (OCR), and corrected the front-door README.
2. ~~**Phase 2**~~ ✅ **DONE (2026-06-29)** — finished the rebrand (macOS `.app` example, the
   `PRIVATE_AI_DRIVE`→`HILBERTRAUM` volume label, embeddings F16-not-Q8), removing drive-builder
   confusion.
3. **Phase 3** (NEXT) — reference hygiene; small and mechanical (defer the 815 KB BUILD_STATE edits or
   make them a policy decision to avoid churn).
4. **Phase 4** — header/freshness truthfulness; do after content fixes so dates reflect the final state.
5. **Phase 5** — additive new files; no risk to existing docs.
6. **Phase 6** — clarity polish on historical docs; least urgent.

Phases are independent and each fits a single fresh `/docs-fix` session. Phase 1 should not be batched
with others (it carries the user-trust risk and deserves a focused review).

## Remediation log

| Date | Phase / Finding | Files changed | Summary | Validation performed | Result | Follow-up needed |
|---|---|---|---|---|---|---|
| 2026-06-29 | Phase 1 — DOC-001, DOC-002, DOC-003 | `docs/user-guide.md`, `docs/troubleshooting.md`, `SECURITY.md`, `README.md`, `sample-data/README.md`, `docs/audits/docs-audit.md` | **DOC-001:** rewrote the user-guide §8 and troubleshooting image passages from "are not saved / never saved" to the persisted-encrypted-deletable image-history posture (`workspace/images/`, encrypted at rest, revisit + delete from Images screen); clarified that `Remove` returns to the landing view and does not delete the saved session. **DOC-002:** replaced `SECURITY.md:78` false "OCR not included in Lite" with an accurate on-device-only (deu+eng tesseract, no cloud OCR) statement. **DOC-003:** "Start mock runtime" → "Try in demo mode" + de-jargoned nearby prose in README/user-guide/troubleshooting **and** the audit-missed `sample-data/README.md`. | Re-read edited passages against `PRIVACY.md`, `vision/history.ts`, `ImagesScreen.tsx` (Remove vs Delete), `drive-layout.md`/`model-policy.md` (OCR scope), `en.ts:700`, `copy-tone.test.ts`. Greps: image `not saved/never saved` → only unrelated voice-dictation remains; `SECURITY.md` OCR → only corrected line; `Start mock runtime` → only intentional historical rename records remain. | Fixed | DOC-007 (SECURITY.md stale 2026-06-15 header) still open → Phase 4. No code changed; doc suite/links unaffected. |
| 2026-06-29 | Phase 2 — DOC-004, DOC-005, DOC-012 | `docs/packaging.md`, `docs/drive-layout.md`, `docs/troubleshooting.md`, `model-manifests/README.md`, `docs/audits/docs-audit.md` | **DOC-004:** macOS `--app-artifact` example `packaging.md:309` `Private\ AI\ Drive\ Lite.app` → `HilbertRaum.app` (matches the `.exe` example + the rebrand). **DOC-005:** standardized the example macOS volume label on `HILBERTRAUM` — `drive-layout.md` sketch header `PRIVATE_AI_DRIVE/`→`HILBERTRAUM/` (line 57) + all four `/Volumes/PRIVATE_AI_DRIVE` examples (lines 149–152), and `troubleshooting.md:92`. **DOC-012:** `model-manifests/README.md:9` embeddings "Q8" → "F16" with a note that the `-q8` manifest id is a stable opaque identifier, not a quant claim, and that Q8 crashes the pinned runtime. | Greps after fix: `Private AI Drive` → only `BUILD_STATE.md` historical note + this report; `PRIVATE_AI_DRIVE` (docs) → only the frozen spec `CLAUDE_HilbertRaum_MVP.md` (DOC-016) + `BUILD_STATE.md` note + this report. DOC-012 verified against `multilingual-e5-small-q8.yaml` (`display_name: …(F16)`) and `model-policy.md` (lines 32, 37–46). | Fixed | **Follow-up (out of `/docs-fix` scope):** the same stale `/Volumes/PRIVATE_AI_DRIVE` example string appears in `#` usage-comments + one `echo` in `scripts/{fetch-models,fetch-runtime,prepare-drive,verify-models,setup-dev}.sh`; no script *logic* depends on it (it is the user-supplied `--target`). Update those comments in a separate code-touching pass if desired. The frozen spec `CLAUDE_HilbertRaum_MVP.md` retains the old label by design (DOC-016, Phase 6). No code changed. |
