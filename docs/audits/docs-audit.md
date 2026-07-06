# Documentation Audit Report

## Metadata

- **Audit date:** 2026-07-06
- **Branch:** `master`
- **Commit:** `0ac82648bd87bebcf3c7ba4a153f97a2378dcbc3` (2026-07-06)
- **Command used:** `/docs-audit` (scoped invocation)
- **Scope audited:** Five files only, per user request — `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `PRIVACY.md`, `SECURITY.md`, `apps/desktop/tests/real-data/README.md`. `CLAUDE.md`, `BUILD_STATE.md`, `docs/architecture.md`, `docs/security-model.md`, and implementation files were consulted **only to verify factual claims** made by the five in-scope files.
- **Auditor note:** Documentation-only audit. No application code was modified; code was inspected solely to check documentation claims.
- **Report status:** Phase 1 complete (DOC-001, DOC-002 **Fixed** 2026-07-06). Phase 2 complete (DOC-003, DOC-004, DOC-005 **Fixed** 2026-07-06). Phase 3 complete (DOC-006, DOC-007, DOC-008, DOC-010 **Fixed**; DOC-009 **tracked** — release blocker recorded in `BUILD_STATE.md` §5 item 1c; 2026-07-06). All findings resolved or tracked.

## How to use this report

- `/docs-audit` creates and updates this report.
- `/docs-fix` should fix **one phase or one set of findings at a time**.
- Every fix must update this report (finding status + remediation log).
- Findings are never removed; they are marked **Fixed / Verified / Blocked / Superseded**.

## Executive summary

**Overall health:** Good bones, drifting edges. All five files are well-written, and most operational claims verified against the code (commands, Node engine floor, gated harness env vars, gitignore protections, default-on downloads toggle, scripts↔TS mirror list). The problems are **staleness**: the two outward-facing trust documents — `PRIVACY.md` (last updated 2026-06-20) and `SECURITY.md` (2026-06-29) — predate two substantial shipped changes: the **translation sidecar** (TG wave, 2026-07-05: a second `llama-server` process, a Translate view, document translation with its own transient plaintext working files) and the **S1 audit-log content policy** (full-audit 2026-06-30: document filenames/titles removed from the audit log as content).

- **Biggest strengths:** Plain-language privacy notice with honest limitations; security policy that documents residual risks (plaintext working copy, SSD shred limits) instead of hiding them; the real-data README encodes its safety rules (gitignored corpus, aggregate-only output) in the doc itself.
- **Highest-priority risk:** `PRIVACY.md` states prepared commercial drives ship with model downloads **off** — the code ships them **permitted** (DOC-001). A privacy notice making a false claim about the sold product is the worst kind of doc bug, whichever side (doc or code) is the intended behavior.
- **Most important contradiction:** DOC-001 (above); second, `SECURITY.md` says the audit log records *filenames* when S1 deliberately removed them (DOC-003).
- **Most important missing docs:** Translation feature coverage in both `PRIVACY.md` and `SECURITY.md` (DOC-002, DOC-004).
- **Recommended first phase:** Phase 1 (PRIVACY.md — resolve the commercial-drive downloads contradiction, add translation).
- **Estimated effort:** 3 small phases, each well under one session.

## Document inventory

| Document | Purpose | Status | Notes |
|---|---|---|---|
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 CoC | **Good** | Standard, faithful adaptation; enforcement contact is a pre-release placeholder (DOC-009, acceptable for pre-1.0) |
| `CONTRIBUTING.md` | Contributor onboarding + ground rules | **Updated (Phase 3, 2026-07-06)** | CI-trigger wording corrected (draft-PR guidance, DOC-007); License + Security-issues sections added (DOC-008); commands/engines/scripts-mirror rule verified accurate |
| `PRIVACY.md` | Plain-language privacy notice | **Contradictory / Needs update** | One claim contradicts the code (DOC-001); predates the translation feature (DOC-002) |
| `SECURITY.md` | Security policy + threat-model summary | **Updated (Phase 2, 2026-07-06)** | DOC-003/004/005 fixed: audit-log field list corrected (statuses, no titles/filenames); change list + mitigations extended (translation sidecar, binary re-hash gate, skills); `main`→`master`. DOC-009/DOC-010 (contact placeholder, phase-number) still Phase 3 |
| `apps/desktop/tests/real-data/README.md` | Gated real-data harness manual | **Updated (Phase 3, 2026-07-06)** | Deleted-plan-file citations retargeted to `docs/architecture.md` §21 design record (DOC-006); "Phase 31" qualified as PDF-geometry (DOC-010); env vars, gating, corpus layout, expected.json schema, gitignore all verified accurate |

## Findings index

| ID | Title | Severity | Confidence | Category | Status | Document(s) | Phase |
|---|---|---|---|---|---|---|---|
| DOC-001 | PRIVACY claims commercial drives ship with model downloads off; code ships them permitted | High | High | Accuracy / Privacy docs | Fixed | PRIVACY.md | 1 |
| DOC-002 | PRIVACY predates the translation feature (no bullet, stale transient-file enumeration) | Medium | High | Completeness / Privacy docs | Fixed | PRIVACY.md | 1 |
| DOC-003 | SECURITY says the audit log records filenames; S1 removed them | Medium | High | Accuracy / Security docs | Fixed | SECURITY.md | 2 |
| DOC-004 | SECURITY change list & limitations predate translation sidecar, re-hash-before-spawn gate, skills | Medium | High | Completeness / Security docs | Fixed | SECURITY.md | 2 |
| DOC-005 | SECURITY says fixes target `main`; the repository branch is `master` | Low | High | Accuracy | Fixed | SECURITY.md | 2 |
| DOC-006 | real-data README cites the deleted PDF plan file for §/D anchors | Low | High | Navigation | Fixed | tests/real-data/README.md | 3 |
| DOC-007 | CONTRIBUTING says CI runs "on every push/PR"; branch pushes without a PR get no CI | Low | High | Accuracy / Clarity | Fixed | CONTRIBUTING.md | 3 |
| DOC-008 | CONTRIBUTING omits the project license and a SECURITY.md cross-link | Low | Medium | Completeness | Fixed | CONTRIBUTING.md | 3 |
| DOC-009 | CoC + SECURITY reporting contact is a placeholder with no concrete channel | Low | High | Clarity | Tracked | CODE_OF_CONDUCT.md, SECURITY.md | 3 (track) |
| DOC-010 | "Phase 31" means two different things across the audited docs | Low | High | Consistency | Fixed | SECURITY.md, tests/real-data/README.md | 3 |

## Detailed findings

### DOC-001: PRIVACY claims commercial drives ship with model downloads off; code ships them permitted

- **Status:** Fixed (2026-07-06, Phase 1) — owner confirmed the CODE is correct (drives ship with downloads **permitted** so buyers can add models; every download stays user-initiated + per-download confirmed, and a drive `policy` can still turn it off entirely). PRIVACY.md "Model downloads" condition 1 rewritten to match: *"drives — including prepared commercial drives — ship with this **permitted** so you can add models; a drive `policy` can turn it off entirely"*. No code changed. Re-verified against `commercial-drive.ts:312-315`, `drive.ts:198-204`, and `prepare-drive.ps1`/`.sh` (all write `allow_model_downloads: true`). The `SECURITY.md` "downloads disabled" example is left as-is (still valid as an *example* of enforcement, not a shipped default) — flag for Phase 2 if it reads as the default.
- **Severity:** High
- **Confidence:** High
- **Category:** Accuracy / Privacy docs
- **Affected document(s):** `PRIVACY.md`
- **Affected section(s):** "Model downloads — the app's only network feature", condition 1: *"The drive's policy permits model downloads (prepared commercial drives ship with this **off**)."*
- **Related code checked:**
  - `apps/desktop/src/main/services/drive.ts:198-204` — `buildPolicy` doc: *"`allow_model_downloads` is the POLICY CEILING … it is `true` by default so a prepared drive can pull additional models on demand."*
  - `apps/desktop/src/main/services/commercial-drive.ts:312-315` — the **sell gate** explicitly does *not* require downloads off: *"Model downloads are an explicit, user-initiated, per-download-confirmed action (the drive ships with them permitted so a buyer can add models), so they do NOT count as a network violation."*
  - `scripts/prepare-drive.ps1:138` and `scripts/prepare-drive.sh:188` — both write `allow_model_downloads: true`.
- **Description:** The privacy notice asserts that prepared commercial drives ship with the model-download policy disabled. The as-built system does the opposite by explicit, commented design: drives are prepared with downloads **permitted** (still gated per-download by user confirmation + the Settings toggle), and the commercial sell gate deliberately treats permitted downloads as compatible with "network denied" (which it defines as no update checks + no telemetry).
- **Evidence:** See code citations above; no code path writes `allow_model_downloads: false` for a commercial drive (grep over `scripts/` and `services/` found none).
- **Why it matters:** This is the user-facing privacy promise about the sold product. Either the doc must change (most likely — the code comments show a considered decision) or, if the doc records the intended commercial posture, the prepare/sell path has a real gap that must be surfaced to the owner — not silently "fixed" either way.
- **Recommended fix:** Confirm intent with the owner, then rewrite condition 1 to match the shipped behavior, e.g.: *"The drive's policy permits model downloads (drives ship with this permitted so you can add models; a policy can turn it off entirely)."* Also re-check the related `SECURITY.md` example *"Fail-closed packaged policy … (e.g. downloads disabled)"* — the example is still valid as an example of enforcement, but should not imply it is the shipped default.
- **Validation needed after fix:** Re-read `commercial-drive.ts` sell-gate comments and `prepare-drive.*` policy blocks; confirm the doc sentence matches.
- **Documentation update notes:** Bump the `_Last updated:_` line.
- **Suggested phase:** 1

### DOC-002: PRIVACY predates the translation feature

- **Status:** Fixed (2026-07-06, Phase 1) — added a "No translation upload" bullet (text + whole-document translation happen **on this device** by a local model, nothing sent off-device), matching the per-modality pattern; added a "Translated documents" line under "What data is stored, and where" (saved into `workspace/documents/` like any other document — verified: translation handler `materializeDocument` writes into `workspace/documents/`); extended the Encryption section's transient-decrypted-copy sentence to include "while a document is being translated" (verified against `docs/architecture.md` Translation-sidecar record TA-1: document translation decrypts to a transient `.parse` working file, shredded on lock/quit); bumped `_Last updated_` to 2026-07-06 with a translation note. "Deleting your data" already named "document summaries/translations", so it stayed consistent.
- **Severity:** Medium
- **Confidence:** High
- **Category:** Completeness / Privacy docs
- **Affected document(s):** `PRIVACY.md`
- **Affected section(s):** `_Last updated: 2026-06-20 (Image understanding…)_`; "No telemetry, no cloud" bullet list; "What data is stored, and where"; "Encryption" (transient-copy enumeration).
- **Related code/docs checked:** `docs/architecture.md:1538` "Translation sidecar — design record (TG wave)" — TranslateGemma manifest role, dedicated `llama-server` sidecar (~10 GB model), Translate view (text + document drag-and-drop), doc-task materialization; TA-1/H1-H2 record confirms document translation decrypts document text to a transient `.parse` working file.
- **Description:** The translation feature (shipped 2026-07-05, TG wave) is entirely absent:
  1. The "No X upload" bullet list covers audio, dictation, OCR, and images, but has **no translation bullet** — a user translating a sensitive document gets no explicit "translation happens on this device by a local model" assurance, though that is the pattern the doc uses for every other modality.
  2. "What data is stored" does not mention translated-document outputs (arguably covered by "Generated outputs", but the doc names every other artifact class specifically).
  3. The Encryption section enumerates transient decrypted copies as occurring "during re-indexing or when you open an image-analysis entry" — document **translation** also produces a transient decrypted working copy; the enumeration reads as exhaustive and is now incomplete.
  4. The `_Last updated_` stamp still names image understanding as the newest feature.
- **Why it matters:** PRIVACY.md's credibility rests on the per-feature explicitness it established; a shipped feature that processes whole documents through a second model process is exactly what its audience wants covered.
- **Recommended fix:** Add a "No translation upload" bullet (text and documents translated on-device by a local model); mention translated outputs in the stored-data list; extend the transient-copy sentence with translation; refresh the `_Last updated_` line.
- **Validation needed after fix:** Cross-check wording against `docs/architecture.md` "Translation sidecar — design record" (shred/lifecycle claims must match TA-1/TA-2 as-built behavior).
- **Suggested phase:** 1

### DOC-003: SECURITY says the audit log records filenames; S1 removed them

- **Status:** Fixed (2026-07-06, Phase 2) — audit-log mitigation bullet rewritten to *"records only ids, model ids, statuses, and counts; never chat content, document text, document titles/filenames, or passwords"*, with a parenthetical noting document names were removed as content in the 2026-06-30 hardening (`documentId`, not name, on record) and that model ids are not user content. Verified the stronger claim before asserting it: grepped every audit call site — `document_imported`/reindex/materialize emit `{documentId, status, chunkCount}` (`registerDocsIpc.ts:387-397`, confirmed by `audit.ts` header S1 invariant + `tests/integration/audit-ipc.test.ts` sentinel grep); model-download events (`downloads.ts:193/296/376`) record `modelId`/`jobId`/`sizeBytes`/`bytes`/`reason` — model ids + counts, never user filenames. No name/title field survives at any call site.
- **Severity:** Medium
- **Confidence:** High
- **Category:** Accuracy / Security docs
- **Affected document(s):** `SECURITY.md`
- **Affected section(s):** Primary mitigations → *"**Tamper-evident audit log** (Phase 19) — records only ids, model ids, filenames, and counts; never chat content, document text, or passwords."*
- **Related code checked:** `apps/desktop/src/main/ipc/registerDocsIpc.ts:387-397` — *"Audit: ids + counts only — the filename/title is CONTENT (S1, full-audit-2026-06-30) … the whole log is exfiltrated verbatim by the plaintext activity-log.json export"*; payload is `{documentId, status, chunkCount}`. Same pattern at `services/doctasks/handlers/shared.ts:133`.
- **Description:** The 2026-06-30 audit's S1 policy change deliberately removed document filenames/titles from audit events because a user-chosen filename is content (and the log is exportable as plaintext). `SECURITY.md` (last updated 2026-06-29, one day earlier) still lists "filenames" among the recorded fields. The doc now **over-reports** what is logged — the reality is stricter than the promise, which is the safe direction, but the doc is wrong and undersells a deliberate privacy hardening.
- **Recommended fix:** Change to something like *"records only ids, model ids, statuses, and counts — never chat content, document text, titles/filenames, or passwords"*, optionally noting that document names were removed as content (2026-06-30 hardening).
- **Validation needed after fix:** Grep audit-event call sites for any remaining name/title fields before asserting the stronger claim (model-download events may legitimately record model file names — model ids/filenames are not user content; phrase accordingly).
- **Suggested phase:** 2

### DOC-004: SECURITY change list & limitations predate the translation sidecar, the re-hash-before-spawn gate, and skills

- **Status:** Fixed (2026-07-06, Phase 2) — extended the header change list (translation sidecar, engine-binary re-hash-before-spawn, size-gated/sandboxed skill packs, + the 2026-06-30 audit-log content tightening from DOC-003). Added two Primary-mitigations bullets: **engine binaries re-hashed before every spawn** (verified `binary-verifier.ts` exists and `verifyBinaryBeforeSpawn` gates all three spawn sites — `runtime/sidecar.ts` LlamaServer.start, `runtime/gpu.ts` GPU probe, `transcriber/cli.ts` whisper; packaged-enforce/dev-inert) and **user skill packs are untrusted input** (size-gated on import + frozen document scope the tools cannot widen — `tool-registry.ts:327` `Object.freeze([...ctx.documentIds])`). Widened the transient-plaintext limitation bullet to name whole-document translation and image-history opening alongside re-indexing, and to name both `workspace/documents/` and `workspace/images/` for the startup sweep — matching the PRIVACY.md Encryption wording (kept in lockstep) and `docs/security-model.md` §Translate view (TG-4) `.parse`-transient / TG doc-task lock-window record. Kept summary-level; details remain in `docs/security-model.md`.
- **Severity:** Medium
- **Confidence:** High
- **Category:** Completeness / Security docs
- **Affected document(s):** `SECURITY.md`
- **Affected section(s):** The `_Last updated: 2026-06-29 …_` change list; "Primary mitigations"; "Known limitations".
- **Related code/docs checked:** `docs/architecture.md:1538` (translation sidecar record, incl. TA-1 quit/lock doc-task flush and the transient `.parse` working file); memory of vuln-scan 2026-06-21 item B (`binary-verifier.ts` session-cached re-hash gate at `LlamaServer.start`/GPU probe/whisper — verify the file exists before citing); full-audit-2026-06-30 S2 (skill drop-in size pre-check) and S3 (dictation lock-gating).
- **Description:** Security-relevant changes shipped after the doc's stamp are missing:
  1. **Translation sidecar** — a second long-lived `llama-server` process with its own lifecycle, plus document translation producing transient decrypted working files. The "Known limitations" bullet about transient plaintext copies names only re-indexing; translation (and vision history opening, already in PRIVACY.md) belong in the same sentence.
  2. **Engine-binary re-hash-before-spawn** (vuln-scan 2026-06-21 item B) — this closed the audit-2026-06-14 finding "engine-binary not re-hashed before spawn" and is a genuine primary mitigation, absent from the mitigations list.
  3. **Skills** — user drop-in `SKILL.md` packs are third-party content entering the app (with a size pre-check gate, S2); the threat-model summary doesn't acknowledge the surface.
  4. Minor: dictation lock-gating (S3) extends the lock story.
- **Why it matters:** `SECURITY.md` opens by enumerating "security-relevant changes since the Phase 9 baseline"; readers will assume that list is current.
- **Recommended fix:** Extend the change list (translation sidecar, binary re-hash gate, skills, audit-log content tightening from DOC-003); widen the transient-plaintext limitation bullet; consider one line on skills under mitigations or limitations. Keep it summary-level; details live in `docs/security-model.md`.
- **Validation needed after fix:** Confirm `binary-verifier.ts` exists and its gate points (start/probe/whisper) before naming them; confirm whether `docs/security-model.md` already covers translation (the FA-wave record says its content-free log class was confirmed unchanged) so the two docs stay consistent.
- **Suggested phase:** 2

### DOC-005: SECURITY says fixes target `main`; the repository branch is `master`

- **Status:** Fixed (2026-07-06, Phase 2) — "Supported versions" now reads *"Security fixes target the `master` branch only"*. Confirmed `master` is the live branch (`git`, `.github/workflows/ci.yml` `branches: [master]`).
- **Severity:** Low
- **Confidence:** High
- **Category:** Accuracy
- **Affected document(s):** `SECURITY.md` — "Supported versions": *"Security fixes target the `main` branch only…"*
- **Related config checked:** `git branch --show-current` → `master`; `.github/workflows/ci.yml:22` → `branches: [master]`.
- **Description:** The default/development branch is `master`, not `main`. Anyone following the security policy to the branch would find no `main`.
- **Recommended fix:** s/`main`/`master`/ (or "the default branch").
- **Suggested phase:** 2

### DOC-006: real-data README cites the deleted PDF plan file

- **Status:** Fixed (2026-07-06, Phase 3) — retargeted both plan-file citations to the surviving design record. The title paragraph's "PDF-plan **D57**" now reads `docs/architecture.md` §21 "Geometry-aware PDF bank-statement extraction", **D57** (verified: heading at `architecture.md:4338`, D57 anchor at `:4391`). The harness heading's "plan §3.4/§6" was **dropped** (the §-anchor legend at `architecture.md:4637-4640` maps only plan §3.1/§3.2/§3.5/D50–D58 → §21, so §3.4/§6 have no resolvable equivalent) in favor of the `docs/architecture.md` §21 + `gate D52` pointers (D52 anchor at `:4367`). Body D52/D56 references left as-is — they resolve within §21.
- **Severity:** Low
- **Confidence:** High
- **Category:** Navigation
- **Affected document(s):** `apps/desktop/tests/real-data/README.md`
- **Affected section(s):** Title paragraph *"(CLAUDE.md 'never commit user data' / **PDF-plan D57**)"*; harness heading *"(Phase 31, **plan §3.4/§6**, gate D52)"*; body references to D52/D56.
- **Related docs checked:** The PDF geometry plan file was deleted per the doc-lifecycle rule and folded into `docs/architecture.md` (D52 at `docs/architecture.md:4367`, D57 at `:4391` — the anchors resolve there). No `docs/*plan*.md` for PDF geometry remains (only `big-slot-embeddings-plan.md` and `result-tables-plan.md` exist).
- **Description:** The README points readers at "the plan" (`plan §3.4/§6`, "PDF-plan D57") — a file that no longer exists. The D-anchors are resolvable via the architecture design record's legend, but the README doesn't say so; a new contributor would search for a plan file and find nothing.
- **Recommended fix:** Replace "PDF-plan D57" / "plan §3.4/§6" with pointers to `docs/architecture.md` "PDF geometry extraction — design record" (its D52/D56/D57 anchors), matching how code comments were kept resolvable.
- **Validation needed after fix:** Confirm the exact section title in `docs/architecture.md` and that §3.4/§6 have legend equivalents (or drop the § refs and keep only D-anchors).
- **Suggested phase:** 3

### DOC-007: CONTRIBUTING says CI runs "on every push/PR"

- **Status:** Fixed (2026-07-06, Phase 3) — reworded to "on every PR and on pushes to `master`; a branch pushed **without** an open PR intentionally gets no CI — the PR is the gate, so open a **draft PR** to run CI on a WIP branch", matching the `ci.yml` triggers (`pull_request` + `push: branches: [master]`) and adopting the workflow file's own draft-PR guidance.
- **Severity:** Low
- **Confidence:** High
- **Category:** Accuracy / Clarity
- **Affected document(s):** `CONTRIBUTING.md` — *"The same `typecheck`/`build`/`test` chain runs in CI on every push/PR"*.
- **Related config checked:** `.github/workflows/ci.yml:16-22` — triggers are `pull_request` + `push: branches: [master]`, with an explicit comment: *"A branch pushed WITHOUT an open PR intentionally gets no CI — the PR is the gate (open a draft PR to run CI on a WIP branch)."*
- **Description:** A contributor pushing a feature branch and expecting CI will see nothing and may think CI is broken. The workflow file even anticipates this ("open a draft PR"), but that guidance never made it into CONTRIBUTING.
- **Recommended fix:** Reword to "on every PR and on pushes to `master`; a branch without an open PR gets no CI — open a draft PR to run CI on WIP."
- **Suggested phase:** 3

### DOC-008: CONTRIBUTING omits the license and a SECURITY.md cross-link

- **Status:** Fixed (2026-07-06, Phase 3) — added two short sections at the end of `CONTRIBUTING.md`: **"Security issues"** (report vulnerabilities privately per `SECURITY.md`, no public issue/PR) and **"License"** (GPL-3.0-or-later per `package.json` + root `LICENSE`, inbound = outbound). Both link targets verified to exist (`SECURITY.md`, `LICENSE`).
- **Severity:** Low
- **Confidence:** Medium
- **Category:** Completeness
- **Affected document(s):** `CONTRIBUTING.md`
- **Related config checked:** `package.json` → `"license": "GPL-3.0-or-later"`; root `LICENSE` exists; `SECURITY.md` exists and defines private vulnerability reporting.
- **Description:** Two conventional gaps: (1) no statement that contributions are accepted under the project license (GPL-3.0-or-later) — copyleft licenses especially warrant an explicit inbound=outbound sentence; (2) no pointer telling contributors to report vulnerabilities privately per `SECURITY.md` instead of opening issues/PRs.
- **Recommended fix:** One short "License" line and one "Security issues" line linking `SECURITY.md`.
- **Suggested phase:** 3

### DOC-009: Reporting/enforcement contact is a placeholder

- **Status:** Tracked (2026-07-06, Phase 3) — no doc rewrite; this is a release-blocking action, not a doc bug. Checked whether GitHub private vulnerability reporting is already enabled (which would let the gap close now by naming it): `GET /repos/comilionas/AI_Drive/private-vulnerability-reporting` → **404 (not enabled)**, so the current placeholder wording in `SECURITY.md`/`CODE_OF_CONDUCT.md` is accurate and stays. Recorded the pre-release action in `BUILD_STATE.md` §5 as item **1c** ("Publish a concrete security + CoC contact before the first public release" — publish a real address in both docs, or enable + link GitHub private vulnerability reporting) so it cannot be forgotten. Revisit at release time.
- **Severity:** Low
- **Confidence:** High
- **Category:** Clarity
- **Affected document(s):** `CODE_OF_CONDUCT.md` (Enforcement), `SECURITY.md` (Reporting a vulnerability)
- **Description:** Both docs defer to "a dedicated contact address will be published before the first public release" and ask people to contact "the maintainers privately" — without saying **how** (no email, no GitHub Security Advisories mention). The two docs are at least consistent with each other, and this is a reasonable pre-1.0 posture, but it is unactionable for an outsider today.
- **Recommended fix:** No immediate change required; add "publish CoC + security contact (or enable GitHub private vulnerability reporting and link it)" to the pre-release checklist so it cannot be forgotten. If GitHub private vulnerability reporting is already enabled on the repo, name it now — that resolves the gap immediately.
- **Suggested phase:** 3 (track; release-blocking item, not a doc rewrite)

### DOC-010: "Phase 31" means two different things across the audited docs

- **Status:** Fixed (2026-07-06, Phase 3) — disambiguated at point of use in the real-data README: the harness heading now reads "**PDF-geometry Phase 31**; `docs/architecture.md` §21, gate D52" (combined with the DOC-006 retarget). No global renumbering; `SECURITY.md`'s "Phase 31 (permission handler)" is left as-is (correct in the functionality-numbering track per `docs/security-model.md:35`), and the two mentions no longer collide ambiguously.
- **Severity:** Low
- **Confidence:** High
- **Category:** Consistency
- **Affected document(s):** `SECURITY.md` (*"deny-by-default renderer permission handler (Phase 31)"*), `apps/desktop/tests/real-data/README.md` (*"Stage-1 bank-statement gold set (Phase 31 …)"*)
- **Related docs checked:** `docs/security-model.md:35` confirms the permission handler is Phase 31 in the functionality numbering; `BUILD_STATE.md` entries for the `pdf-geometry-extraction` branch use "Phase 31–33" for the PDF geometry wave.
- **Description:** Two phase-numbering tracks collide on the same numbers. Within each doc the usage is internally consistent with its source, but a reader of both files gets "Phase 31 = permission handler" and "Phase 31 = PDF gold set". Cheap to disambiguate at the two mentions in the audited files (a global renumbering is out of scope and not recommended).
- **Recommended fix:** In the real-data README, qualify as "PDF-geometry Phase 31" or drop the phase number in favor of the design-record pointer (combines naturally with DOC-006).
- **Suggested phase:** 3

## Contradictions

| # | Documents / code involved | Conflicting statements | Likely source of truth | Resolution | Finding |
|---|---|---|---|---|---|
| 1 | `PRIVACY.md` vs `commercial-drive.ts:312-315`, `drive.ts:198-204`, `prepare-drive.ps1/.sh` | "prepared commercial drives ship with this off" vs. code ships downloads permitted, by commented design | Code (deliberate, documented decision) — but confirm with owner | Rewrite the PRIVACY sentence; if owner intended "off", it's a code gap to surface, not a doc fix | DOC-001 |
| 2 | `SECURITY.md` vs `registerDocsIpc.ts:387-397` (S1) | audit log "records … filenames" vs. ids + counts only, filenames removed as content | Code (S1 hardening postdates the doc) | Update the mitigation bullet | DOC-003 |
| 3 | `SECURITY.md` vs repo/`ci.yml` | "`main` branch" vs. `master` | Repo | s/main/master/ | DOC-005 |
| 4 | `CONTRIBUTING.md` vs `ci.yml:16-22` | "CI on every push/PR" vs. PRs + master pushes only | `ci.yml` (intentional, commented) | Reword | DOC-007 |
| 5 | `SECURITY.md` vs `tests/real-data/README.md` | "Phase 31" = permission handler vs. = PDF gold set | Both (two numbering tracks) | Qualify at point of use | DOC-010 |

## Missing documentation

| Topic | Why it matters | Suggested location | Priority | Finding |
|---|---|---|---|---|
| Translation: on-device bullet, stored outputs, transient decrypted copy | Flagship privacy doc omits a shipped whole-document feature | `PRIVACY.md` bullets + Encryption section | High | DOC-002 |
| Translation sidecar in the security change list / limitations | Change list presents itself as current | `SECURITY.md` header list + Known limitations | Medium | DOC-004 |
| Binary re-hash-before-spawn mitigation | A shipped primary mitigation, absent | `SECURITY.md` Primary mitigations | Medium | DOC-004 |
| Skills drop-in surface | Third-party content entering the app | `SECURITY.md` (one line) | Low-Medium | DOC-004 |
| License / inbound-contribution terms; security-report pointer | Conventional contributor expectations (GPL) | `CONTRIBUTING.md` | Low | DOC-008 |
| Concrete private reporting channel | Unactionable placeholder pre-release | Pre-release checklist (or enable GitHub private vuln reporting now) | Low (release-blocking later) | DOC-009 |

## Duplicated or overlapping documentation

- **`PRIVACY.md` ↔ `SECURITY.md`** — both describe the encrypted workspace, transient plaintext copies, shred-on-startup, and the plaintext-until-reindexed legacy documents, in near-identical language. Drift risk is real (the translation transient will need the *same* edit in both — see DOC-002/DOC-004). Acceptable duplication (different audiences), but fix both in lockstep and keep `docs/security-model.md` the canonical detail source. No separate finding; handled inside Phases 1–2.
- **`CONTRIBUTING.md` ↔ `CLAUDE.md`** — ground rules and the per-phase ritual are restated. Currently in sync (verified line-by-line); CONTRIBUTING already links CLAUDE.md as the source. No action.

## Broken or weak references

- `tests/real-data/README.md` → "PDF-plan D57" / "plan §3.4/§6": the plan file is deleted; anchors live in `docs/architecture.md` (DOC-006). **Broken pointer (conceptually), resolvable target exists.**
- `SECURITY.md` → "`main` branch": nonexistent branch name (DOC-005).
- Verified **good**: `CONTRIBUTING.md` → `BUILD_STATE.md`, `CLAUDE.md`, `CODE_OF_CONDUCT.md`, `README.md`, `docs/packaging.md` (all exist); `SECURITY.md`/`PRIVACY.md` → `docs/security-model.md` (exists); `CODE_OF_CONDUCT.md` → `SECURITY.md` + external Contributor Covenant links (well-formed).
- Verified **good** (commands/config): root `package.json` scripts match CONTRIBUTING's command list; `engines.node >=22.5` matches; `apps/desktop` has `test:watch`; `scripts/verify-electron.mjs` exists and is the `postinstall`; `HILBERTRAUM_SKIP_ELECTRON_CHECK` honored in `ci.yml`; the four canonical modules named by the scripts-mirror rule (`drive.ts`, `assets.ts`, `commercial-drive.ts`, `launcher.ts`) all exist; `HILBERTRAUM_PDF_GOLDSET`/`_DIR` gating and the `expected.json` schema (`trueRowCount`, `imageOnly`, balances) match `pdf-goldset.realdata.test.ts`; `apps/desktop/tests/real-data/corpus/` is gitignored (`.gitignore:31`); the downloads toggle default-ON claim matches `DEFAULT_SETTINGS.allowNetwork: true` (`shared/types.ts:269`).

## Documentation remediation plan

### Phase 1: PRIVACY.md — commercial-downloads contradiction + translation refresh

- **Goal:** Make the privacy notice factually correct and current.
- **Findings:** DOC-001, DOC-002
- **Documents affected:** `PRIVACY.md` (and, if DOC-001 resolves as a *code* gap, a note to the owner instead of a doc edit)
- **Exact intended changes:** (1) After owner confirmation, rewrite "Model downloads" condition 1 to match the shipped permitted-by-default drive policy. (2) Add a "No translation upload" bullet; mention translated outputs under stored data; extend the transient-decrypted-copy sentence in Encryption with document translation; bump `_Last updated_`.
- **Code/config verification required:** `commercial-drive.ts` sell gate, `prepare-drive.*` policy blocks, `docs/architecture.md` translation record (transient lifecycle wording).
- **Validation steps:** Re-read edited sections against the cited code comments; check PRIVACY↔SECURITY wording stays consistent.
- **Acceptance criteria:** No PRIVACY sentence contradicts the code; translation covered with the same explicitness as OCR/images/audio.
- **Risks:** DOC-001 might be an intent gap, not a doc bug — do not silently choose; ask the owner first.
- **Rollback:** Single-file doc edit; git revert.

### Phase 2: SECURITY.md — audit-log claim, change list, branch name  ✅ COMPLETE (2026-07-06)

- **Goal:** Bring the security policy up to the as-built 2026-07-06 state.
- **Findings:** DOC-003, DOC-004, DOC-005
- **Documents affected:** `SECURITY.md`
- **Exact intended changes:** Fix the audit-log mitigation bullet (ids/statuses/counts; document names removed as content); extend the header change list (translation sidecar, binary re-hash gate, skills size-gate, audit-log tightening); widen the transient-plaintext limitation to include translation; `main` → `master`; bump `_Last updated_`.
- **Code/config verification required:** Grep audit call sites for residual name fields; confirm `binary-verifier.ts` and its gate points; skim `docs/security-model.md` translation coverage for consistency.
- **Validation steps:** Each new claim traced to a code file or design record; no claim stronger than what code shows.
- **Acceptance criteria:** Change list current through the TG/FA waves; no stale field lists; correct branch name.
- **Risks:** Over-claiming in the stronger audit-log statement — verify model-download events first.
- **Rollback:** Single-file doc edit; git revert.

### Phase 3: Small fixes — CONTRIBUTING nits, real-data README pointers, phase-number disambiguation, contact tracking  ✅ COMPLETE (2026-07-06)

- **Goal:** Clear the low-severity accuracy/navigation debt.
- **Findings:** DOC-006, DOC-007, DOC-008, DOC-009 (track), DOC-010
- **Documents affected:** `CONTRIBUTING.md`, `apps/desktop/tests/real-data/README.md`; possibly `BUILD_STATE.md` §5/§6 (release-checklist note for DOC-009)
- **Exact intended changes:** Reword the CI sentence (draft-PR guidance); add license + security-report lines to CONTRIBUTING; retarget the real-data README's plan citations to the architecture design record and qualify/drop its "Phase 31"; record the publish-contact item where release tasks are tracked.
- **Code/config verification required:** Exact architecture.md section title for the PDF record; whether GitHub private vulnerability reporting is enabled.
- **Validation steps:** Follow every edited link/anchor to its target.
- **Acceptance criteria:** No reference in the five files points at a deleted file or nonexistent branch; CI behavior described matches `ci.yml`.
- **Risks:** Minimal.
- **Rollback:** Doc-only; git revert.

## Recommended execution order

**Phase 1 → Phase 2 → Phase 3.** Phase 1 first because DOC-001 is the only finding where a user-facing promise contradicts shipped behavior (and it needs an owner decision — start it early). Phase 2 next: SECURITY.md shares the translation wording with Phase 1's PRIVACY edits, so doing them adjacently keeps the two docs consistent. Phase 3 is independent cleanup and can run any time after.

**Progress:** Phase 1 ✅ (2026-07-06) · Phase 2 ✅ (2026-07-06) · Phase 3 ✅ (2026-07-06) — **all phases complete.** DOC-001…DOC-008 + DOC-010 **Fixed**; DOC-009 **Tracked** (release blocker in `BUILD_STATE.md` §5 item 1c). No open documentation-fix work remains. Recommended next command: none for remediation — re-run `/docs-audit` after the next feature wave, or revisit DOC-009 at release time.

## Remediation log

| Date | Phase / finding | Files changed | Summary | Validation | Result | Follow-up |
|---|---|---|---|---|---|---|
| 2026-07-06 | Phase 1 (DOC-001, DOC-002) | `PRIVACY.md`, `docs/audits/docs-audit.md` | DOC-001: rewrote "Model downloads" condition 1 to match the as-built permitted-by-default drive policy (owner decision — code is correct, no code change). DOC-002: added "No translation upload" bullet, "Translated documents" stored-data line, extended the transient-decrypted-copy sentence with document translation, bumped `_Last updated_` to 2026-07-06. | Re-read `commercial-drive.ts:312-315`, `drive.ts:198-204`, `prepare-drive.ps1`/`.sh` (all `allow_model_downloads: true`); traced translation claims to `docs/architecture.md` Translation-sidecar record (TA-1 `.parse` transient) and translation-handler `materializeDocument` → `workspace/documents/`; checked PRIVACY↔SECURITY wording stays consistent. | Fixed | DOC-003/DOC-004 (SECURITY.md, Phase 2) share the translation transient wording — keep in lockstep. Re-check the SECURITY.md "downloads disabled" example doesn't read as the shipped default (noted in DOC-001). |
| 2026-07-06 | Phase 3 (DOC-006, DOC-007, DOC-008, DOC-009, DOC-010) | `CONTRIBUTING.md`, `apps/desktop/tests/real-data/README.md`, `BUILD_STATE.md`, `docs/audits/docs-audit.md` | DOC-007: CI-trigger sentence reworded (PR + master-push; draft-PR guidance). DOC-008: added "Security issues" + "License" (GPL-3.0-or-later, inbound=outbound) sections to CONTRIBUTING. DOC-006: retargeted the real-data README's deleted-plan citations ("PDF-plan D57", "plan §3.4/§6") to `docs/architecture.md` §21 "Geometry-aware PDF bank-statement extraction" (D57/D52 anchors); §3.4/§6 dropped (no legend equivalent). DOC-010: qualified the README heading as "PDF-geometry Phase 31". DOC-009: no doc change — recorded the publish-contact release action in `BUILD_STATE.md` §5 item 1c. | Confirmed `architecture.md` §21 heading (`:4338`) + D57 (`:4391`)/D52 (`:4367`) anchors and the §-anchor legend (`:4637-4640`, no §3.4/§6 mapping); confirmed `LICENSE` + `SECURITY.md` exist for the new CONTRIBUTING links; reworded CI text against `ci.yml` triggers; GitHub private vulnerability reporting checked via API → 404 (not enabled), so DOC-009 placeholder wording stays accurate. | Fixed (DOC-006/007/008/010) · Tracked (DOC-009) | DOC-009 revisit at release time (publish contact or enable GitHub private vuln reporting). All other findings resolved. |
| 2026-07-06 | Phase 2 (DOC-003, DOC-004, DOC-005) | `SECURITY.md`, `docs/audits/docs-audit.md` | DOC-003: audit-log mitigation bullet now "ids, model ids, statuses, and counts; never … document titles/filenames …" with a 2026-06-30-hardening parenthetical. DOC-004: extended the header change list (translation sidecar, binary re-hash gate, size-gated/sandboxed skills, audit-log tightening); added two Primary-mitigations bullets (engine binaries re-hashed before every spawn; user skill packs untrusted/size-gated/frozen-scope); widened the transient-plaintext limitation to include whole-document translation + image-history opening and both `workspace/documents/`+`workspace/images/` sweep. DOC-005: `main`→`master`. Also closed the Phase-1 flag: reworded the "Fail-closed packaged policy" example so "downloads disabled" reads as an available restriction, not the shipped default. Bumped `_Last updated_` to 2026-07-06. | Grepped all audit call sites (`registerDocsIpc.ts`, `downloads.ts`, `registerModelIpc.ts`, `tool-registry.ts`, `index.ts`) — no user name/title fields; model events carry model ids/counts only. Confirmed `binary-verifier.ts` + `verifyBinaryBeforeSpawn` at all 3 spawn sites (`runtime/sidecar.ts`, `runtime/gpu.ts`, `transcriber/cli.ts`). Confirmed skills frozen-scope at `tool-registry.ts:327`. Cross-checked transient/translation wording against PRIVACY.md Encryption section + `docs/security-model.md` §Translate view (TG-4). `master` confirmed via `ci.yml`. | Fixed | Phase 3 remains (DOC-006/007/008/009/010). No code change. |
