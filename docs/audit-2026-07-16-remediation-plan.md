# Remediation plan — full audit 2026-07-16

> **Working paper (open plan).** Executable playbook for fixing all 41 verified findings of
> [`docs/audit-2026-07-16.md`](audit-2026-07-16.md) (F-01…F-41; 14 Medium, 27 Low, 0 Critical/High).
> Each phase is sized for **one fresh orchestrator session**. The audit report stays on disk for
> the whole wave — it is the detail record (evidence, verifier reasoning, full blast radius);
> this plan is the execution order and the **wave ledger** (§L) that carries information between
> phases. Doc lifecycle: while this wave is open, this file is the repo's sanctioned open plan;
> at close-out (Phase 10) its durable content is folded into an `architecture.md` §-numbered
> design record and both working papers are deleted per the CLAUDE.md doc-lifecycle rule.

**Status: IN PROGRESS** — Phase 0 complete 2026-07-17; §D decisions recorded below; ledger
entry 0 appended.

---

## §O. Orchestrator protocol (read first, every phase)

Every phase session runs this loop:

1. **Orient.** Read `CLAUDE.md`, then THIS file top-to-bottom **including the §L wave ledger**
   (later entries override earlier plan text — phases are allowed to re-scope successors via
   the ledger), then the full §3 audit-report entries for the findings in scope (the plan's
   per-finding specs are condensed; the report entry is the contract — especially its
   **blast radius**, which lists every test/doc/caller that must move in lockstep).
2. **Branch.** Stacked-branch convention for audit waves (owner-confirmed): create
   `fix/audit-2026-07-16-p<N>` **off the previous phase's branch** (Phase 1 branches off
   `master`). Never commit to `master`; never push to `master` (public repo, ruleset-enforced).
   Merge happens ONCE at wave close via PR with green `ci-success` (Phase 10) unless the owner
   opted for per-phase PRs at kickoff (decision D-E).
3. **Fix findings in the listed order.** For each finding:
   - Re-read its audit entry. If reality deviates from the recorded blast radius (more callers,
     an unlisted pinning test, a moved line), **stop and triage** (rule §N) before coding — no
     force-fits, no quick fixes.
   - Where behavior changes: write the characterization/regression test FIRST and watch it fail
     (red), then fix, then green. Where a new invariant/net is added: demonstrate its TEETH
     (plant the defect → test reddens → revert) — the repo's established ritual.
   - Move the blast-radius items in the same commit as the fix (tests pinning old behavior,
     sibling scripts, docs sentences), never in a follow-up.
4. **Gate.** Per phase: full `npm test` green (record the count), `npm run typecheck` clean,
   `npm run build` green if `apps/desktop/src` was touched. Every edited text file NUL-free,
   BOM-free, LF (the hygiene nets in `repo-hygiene.test.ts` also check this — run it early).
5. **Document.** Update the docs named in the phase + any doc the fix falsifies. Do NOT touch
   dated journal entries or the `architecture.md` §46–§49 ledgers (historical records). Then
   add a SHORT `BUILD_STATE.md` entry (outcome + pointer here — the narrative lives in §L).
6. **Hand off.** Append a §L ledger entry (template in §L). Commit on the phase branch with a
   message referencing the phase and finding IDs. Staging rule (shared working tree, possibly
   concurrent sessions): **stage explicit paths only — never `git add -A` / `git add .`**.
7. **Stop.** One phase per session. If a phase must split (rule §N), record the split in §L and
   end the session cleanly.

**Sub-agent use inside a phase (optional, context hygiene):** delegate read-heavy verification
(e.g. "grep every consumer of X and report shapes") to read-only sub-agents; keep ALL edits in
the orchestrator session so the ledger stays truthful. An independent review sub-agent over the
phase diff before commit is encouraged for Phases 4–6 (the behavior-changing ones).

## §N. New-findings + deviation protocol (the "react between phases" mechanism)

Anything discovered mid-phase that is not in the plan — a new defect, a wrong blast radius, a
pinning test the audit missed, a better fix shape — is handled exactly one of three ways, and
ALWAYS recorded in the §L entry (never silently absorbed or ignored):

- **(a) Fix now** — only if it is in the phase's files, small, and its own blast radius is
  fully understood in-session. Gets its own test + its own ledger line with a `NF-<n>` id.
- **(b) Queue** — otherwise: add it to the §Q queue below with a proposed target phase
  (default: Phase 9's sweep). Later phases MUST check §Q at orient time for items assigned to
  them.
- **(c) Re-scope** — if the deviation invalidates part of a later phase (e.g. Phase 4 changes
  an error contract Phase 7 was going to poll), write the re-scope instruction into §L
  addressed to that phase ("Phase 7: F-30 memo key must now also include …").

A phase that balloons (gates not reachable in-session) is split, not rushed: finish the
red-green-verified subset, ledger the remainder as `p<N>b`, and the next session runs `p<N>b`
before the next numbered phase.

## §Q. New-findings queue (append via §N-b; consume at orient time)

| id | found in | description + location | proposed phase | status |
|---|---|---|---|---|
| Q-1 | Phase 3 (F-05) | **#59 warning-copy half.** F-05 fixed the provisioning root cause (DIY `--with-assets` now fetches the `ocr` family), but the in-app scanned-PDF/photo dead-end warning (`shared/i18n/en.ts:488,1811` + de.ts counterparts) still says "OCR files not on this drive" without telling the user how to get them. Renderer-copy change: add an actionable EN+DE `unavailable → how to get it` hint keyed off the packaging docs (`fetch-runtime --family ocr`, or rebuild with `--with-assets`). Overlaps `user-guide.md:356-363` / `troubleshooting.md:185-197`. | Phase 7 | open |
| Q-2 | Phase 4 (F-02) | **Real-server error-frame smoke owed.** The F-02 in-band error-frame shapes (`data: {"error":{…}}` + bare `error: {…}` field line) are pinned from the TA-4-verified wire contract + hand-authored fixtures — CI green does NOT evidence the real b9849 wire format (TS-3(a)). At the next manual smoke-drive session, force a real llama-server mid-stream error (tiny ctx + context-shift disabled, `HILBERTRAUM_*` env) and verify the reader rejects + the friendly copy surfaces. COUPLES with Phase 9's F-40 b9849 re-capture — Phase 9: register this into the ONE consolidated smoke-session checklist (BUILD_STATE §5 item 7 TS-3 bullet) rather than as a scattered note. | Phase 9 | open |

---

## §D. Owner decisions — batch at Phase 0 (defaults recommended; phases consume the answers)

| id | Question | Recommendation | Consumed by |
|---|---|---|---|
| D-A | **F-10** CSV export BOM: prepend UTF-8 BOM to `.csv` exports (Excel-friendly; flips two tests pinning the no-BOM posture) — or keep no-BOM and document the Excel mojibake in known-limitations? | Add the BOM (Excel is the primary consumer of a transactions CSV; the posture was never a recorded decision, only pinned) | Phase 6 |
| D-B | **F-35** drive READ probe measures the page cache (~100× inflated): drop/relabel the read figure (honest, display-only change), or build a genuinely cold read? | Relabel: keep `driveWriteMbps` as the headline, mark the read figure "(cached)" or drop it; a true cold read is not worth the complexity now. Old persisted values must render sanely | Phase 8 |
| D-C | **F-12** image-history sync fs+crypto on the main thread (up to ~60 MiB/image; protected by the recorded §35 PERF-1 divergence decision): approve the async port? | Approve — the `DocumentCipher` async twins exist; the divergence decision predates them | Phase 8 |
| D-D | **F-39** CSP `style-src 'unsafe-inline'`: authorize the investigation outcome in advance — if KaTeX/streamdown don't need it, drop it (CSP pin test + security-model.md move in lockstep); if they do, keep + document why in the window-security header? | Yes, pre-authorize both outcomes of the investigation | Phase 8 |
| D-E | Merge strategy: stacked branches + ONE wave-close PR (the owner-confirmed audit-wave convention) or per-phase PRs (earlier CI signal, more merge overhead)? | Stacked + one PR at close; full local gates per phase compensate | All |

Decisions taken by the owner 2026-07-17 (Phase 0 batch — all five follow the recommendation):

- **D-A — Decision:** add the UTF-8 BOM to `.csv` exports; flip the two pinning tests in the
  same commit; add the BOM'd-CSV re-import round-trip test.
- **D-B — Decision:** relabel/drop the cached read figure; `driveWriteMbps` stays the headline;
  no cold-read build; already-persisted inflated values must render sanely.
- **D-C — Decision:** approve the async image-history port (async twins + `shredFileAsync`;
  the §35 PERF-1 divergence note gets a dated supersede annotation, not a rewrite).
- **D-D — Decision:** both investigation outcomes pre-authorized — drop `'unsafe-inline'` if
  KaTeX/streamdown render styled without it, else keep + document why; verdict ledgered.
- **D-E — Decision:** stacked branches `fix/audit-2026-07-16-p1…p9`, ONE wave-close PR at
  Phase 10 with green `ci-success`; full local gates per phase.

---

## Phase 0 — Wave kickoff (tiny; may share a session with Phase 1)

- **Goal:** decisions taken, wave registered, plan discoverable.
- **Steps:** (1) Put the §D questions to the owner; record answers in §D ("Decision:" line per
  row) and in §L. (2) Flip this file's Status line to IN PROGRESS. (3) Update the CLAUDE.md
  doc-lifecycle sentence ("none are currently open") to name this plan as the sanctioned open
  plan. (4) Add the wave to `BUILD_STATE.md` §5 as an open item pointing here. (5) Create
  `fix/audit-2026-07-16-p1` off `master`; commit the kickoff edits (this file + CLAUDE.md +
  BUILD_STATE) as the wave's first commit.
- **Gates:** suite/typecheck (docs-only — counts unchanged). **Ledger:** entry 0 with the §D answers.

## Phase 1 — Decision-record & docs accuracy (F-08, F-07, F-09, F-20, F-21, F-17, F-27, F-37)

- **Goal:** every doc/comment statement about the model catalog and its evaluation is true at
  HEAD; the owner's pending §5-item-8 ratification reads corrected numbers. Docs/comments only —
  zero runtime behavior.
- **Fix specs (order as listed):**
  - **F-08** `docs/model-benchmarks.md:338-339, 348-349` + `model-manifests/chat/qwen3.5-9b-ud-q4kxl.yaml:15-17`
    + `qwen3.5-4b-ud-q4kxl.yaml:14-15` + `docs/model-policy.md:26` — correct the incumbent eval
    figures from the committed CSVs (Ministral F1 .3111 / EM .9529, i7 Phase-29 run, cross-run
    caveat; qwen3-4b EM .9647); restate the 9B standing: edges Ministral on F1/EM within
    tolerance, ranked under it **only on the hallucination-trap axis**; fix the "~1 point EM"
    claim (9B tier spread is 2.36 points). `model-policy.md:25` (4B row) is accurate — leave it.
    BUILD_STATE's no-number "sat under Ministral" shorthand stands (dated entries; do not edit).
  - **F-07** `docs/benchmark.md:84-94` — replace the pre-promotion tier table with the four §6.4
    tiers (≤12 → qwen3.5-4b-ud-q4kxl, 16–20 → qwen3.5-9b-ud-q4kxl, 24 → qwen3.6-27b-q4,
    ≥32 → qwen3.6-27b-q5); keep the bundled-default note (qwen3-4b) separate; re-point the
    rank-rationale link §6.2 → §6.2–§6.4.
  - **F-09** `docs/model-policy.md:96-104` + `docs/model-benchmarks.md` §9 header region —
    add §6.3-style supersede annotations (4B/9B promoted to rank 3 on 2026-07-12 by owner
    decision, §6.4; 27B/35B-A3B remain rank 0; 4B smoke satisfied 2026-07-12, 9B/27B §9.1
    smokes still open). Annotate, don't rewrite history.
  - **F-20** `docs/data-contracts.md:112-115` + `:450-452` — "19 model manifests (14 chat)" →
    24 total / 19 chat, AND convert both counts to a pointer to the authoritative source
    (model-policy catalog) so the number can't rot a third time (it regressed DOC-3 once already).
  - **F-21** `docs/model-policy.md:95` — "presets 4k–32k" → "presets 4k–128k".
  - **F-17** both promoted Qwen3.5 manifests' `license_review.notes` — append a dated line
    recording the 2026-07-12 smoke + promotion (27B "Supersedes…" style); keep original text
    (audit trail). YAML values untouched — comments/notes only.
  - **F-27** `apps/desktop/src/preload/index.ts:434-437` — comment: "curated 10" → the closed
    51-code set (`TRANSLATION_LANGUAGE_CODES`, issue #31).
  - **F-37** `apps/desktop/src/shared/i18n/en.ts:15-17` (+ `de.ts:31-33` mirror) — rewrite the
    stale soft-hyphen comment: hyphens removed (bad4eaf); `preview.tsx` matches nav labels by
    exact textContent. Optionally harden `mktClickNav` with `.replace(/­/g,'')` — if done,
    re-run one marketing capture (that is a Phase-7-adjacent change; fine here, it is dev-only).
- **Tests:** none new (verified: no test pins any changed sentence). Full suite run proves
  docs-only neutrality — count must be unchanged.
- **Docs:** this IS the docs phase. BUILD_STATE short entry.
- **Acceptance:** greps are clean: no `.3262`/`.9765` credited to Ministral anywhere outside
  dated journals/CSVs; no "4k–32k"; no "19 model manifests"; no live pre-promotion tier table.
- **Blast radius notes:** keep §46–§49 ledgers + dated BUILD_STATE/build-log entries byte-
  untouched. The audit report itself quotes the wrong numbers as evidence — it is a frozen
  working paper, do not "fix" it.
- **Handoff:** ledger-list every file+line edited (Phase 2 stacks onto the same manifests).

## Phase 2 — Model-catalog data hygiene (F-06, F-16)

- **Goal:** the promoted catalog is internally coherent; the invariants that would have caught
  both defects run in CI.
- **Fix specs:**
  - **F-06** `model-manifests/chat/qwen3.5-9b-q8.yaml:9-14` — resolve the
    `recommended_context_tokens: 98304` vs `recommended_min_ram_gb: 14` incoherence. Default:
    drop ctx to the catalog's 8192 convention (capable owners re-raise via the in-app override);
    alternative (raise min-RAM to ~24) only if the owner prefers. Note: this manifest's G3
    license-provenance review (register D) is separate and stays open — don't conflate.
  - **F-16** `model-manifests/chat/qwen3.6-27b-q4.yaml:8` + `qwen3.6-27b-q5.yaml` — normalize
    `size_on_disk_gb` from GiB to the catalog's decimal-GB convention (16.8 / 19.5, derived from
    `size_bytes/1e9`).
  - **New invariants** in `apps/desktop/tests/integration/committed-catalog.test.ts`:
    (1) ctx-vs-min-RAM plausibility bound for every chat manifest; (2)
    `abs(size_on_disk_gb − size_bytes/1e9) < tol` for manifests with real download blocks.
    Red-green ritual: assert both invariants fail on the pre-fix values (temporarily revert the
    YAML) before landing green.
- **Tests:** the two invariants; `benchmark.test.ts` RAM mapping must be byte-unchanged
  (F-16's size feeds the picker tiebreak — currently not decisive for either 27B, re-verify).
- **Docs:** model-policy/README size cells if displayed sizes change (grep for `17.6`, `20.6`,
  the 27B size strings); BUILD_STATE entry.
- **Acceptance:** suite green incl. invariants; pinned recommendation mapping unchanged;
  ModelsScreen shows the corrected sizes (spot-check test fixture values don't collide —
  `ModelsScreen.test.tsx` 98304 literals are unrelated stub fixtures, leave them).
- **Handoff:** if the F-06 resolution changed the ctx convention, ledger-note it for Phase 1's
  benchmark.md table (already merged — verify no sentence quotes 98304) and for the §5-item-8
  owner sequence.

## Phase 3 — DIY drive & script parity (F-05, F-03, F-04, F-18, F-19)

- **Goal:** a `prepare-drive --with-assets` drive built on any OS is complete (incl. OCR); a
  mid-batch download failure degrades gracefully; the ps1/sh siblings converge.
- **Fix specs:**
  - **F-05** `scripts/prepare-drive.sh:234-266` + `prepare-drive.ps1` (after :308) — add the
    `ocr` family fetch to the `--with-assets` block in BOTH siblings (mirror the whisper_cpp
    call; OS-independent); update both header comments (sh:11-18, ps1:33-46). After merge,
    comment on issue **#59**: provisioning root cause fixed; the warning-copy half of #59
    (in-app dead-end message) remains open — queue it in §Q if not fixed here (it is a
    renderer-copy change; default: queue for Phase 7 with an EN+DE `unavailable → how to get it`
    hint keyed off the packaging docs).
  - **F-03** `scripts/prepare-drive.sh:23` region — bash-3.2-safe empty-array expansion:
    `${COMMON_MODEL_ARGS[@]+"${COMMON_MODEL_ARGS[@]}"}` (the repo's own M23 idiom), or make the
    array never-empty. Sweep the file for further empty-array expansions under `set -u`.
  - **F-04** `scripts/fetch-models.sh:21` + both call sites — failure-tolerant invocation
    (`handle_file … || true`; `had_failure` already aggregates and sets the exit code). Parity
    target: `fetch-models.ps1` behavior (continue + summary + exit 1).
  - **F-18** `scripts/setup-dev.ps1:30-39` — the `--use-system-ca` probe: EAP save/restore
    around the native call (the fetch-runtime.ps1 idiom) or probe via
    `node -p "process.allowedNodeEnvironmentFlags.has('--use-system-ca')"` (no stderr redirect).
  - **F-19** `scripts/fetch-runtime.sh:319-323` — strip query/fragment after basename:
    `ARCHIVE_NAME="${ARCHIVE_NAME%%\?*}"; ARCHIVE_NAME="${ARCHIVE_NAME%%#*}"` (ps1 already
    strips via `[uri].AbsolutePath`).
- **Tests:** extend `prepare-drive-default-set.test.ts` / `script-drift.test.ts` where the
  canonical TS plan exists so the ocr family is pinned in both siblings; manual `--dry-run` on
  both shells; forced-bad-URL batch check (later manifests attempted, summary printed, exit 1).
  Note the hygiene nets don't cover `.ps1`/`.sh` (§49 ④, known) — visual LF/BOM check.
- **Docs:** `packaging.md` (--with-assets contents now include ocr + size delta), README DIY
  sentence if it enumerates families; BUILD_STATE entry.
- **Acceptance:** dry-run output parity ps1↔sh; drift tests green; issue #59 commented.
- **Handoff:** ledger the exact new `--with-assets` size figure (Phase 1's docs used ~10.4 GB —
  if ocr data changes it, fix the README/packaging numbers here, not later).

## Phase 4 — Streaming honesty & extract freshness (F-02, F-01) — HIGHEST CARE, LAND ALONE

- **Goal:** a failed generation can never persist as a clean answer; extractions always
  reflect the current model on explicit re-runs. May split into p4a (F-02) / p4b (F-01) per §N.
- **Fix specs:**
  - **F-02** `apps/desktop/src/main/services/runtime/llama.ts:110-138` (readChatSSE/parseSseLine)
    — recognize in-band error frames (a `data:` JSON with top-level `error` object; optionally
    non-`data:` `error:` field lines) and reject the stream with a typed error instead of ending
    cleanly. **Characterization test FIRST** (tokens → error frame → close ⇒ generator rejects,
    partial not treated complete) — watched red. Pin the frame shape with b9849 provenance
    comments + the standing re-verify rider (TS-3(a)).
    **Consumer-semantics sweep (the real work, from the verified blast radius):** decide and
    test per consumer — `chat.ts:1347` main turn (partial persists with `truncated`/error
    surface, never silently complete), `chat/compaction.ts:241` (a failed summary must NOT be
    written as a compaction checkpoint), `rag/index.ts:1682` + `:1842` grounded paths (surface
    the friendly error). Route through chat-stream's existing friendly mapping; keep the error
    payload content-free (repo privacy posture).
  - **F-01** `apps/desktop/src/main/services/analysis/extract.ts:103-111` + `:221-224` — add
    `AND model_id = ?` (current pass's model) to the markerExists cache-hit lookup so a re-run
    under a different model re-extracts (commitChunk's delete-then-insert makes replacement
    clean). Do **NOT** fold the model id into `contentHashOf` — `analysis-extract-hash.test.ts`
    pins the hash and persisted rows must stay addressable. Regression: same-model re-run stays
    0-call (the #50 economy holds).
- **Tests:** the two characterization tests + regressions (well-formed streams byte-identical
  behavior; `read-chat-sse.test.ts`, `llama-runtime.test.ts`, extract suites). Full suite.
- **Docs:** `rag-design.md` §14.5 gains the error-frame clause; `data-contracts.md` streaming
  contract if the renderer-visible error surface changes shape; BUILD_STATE entry.
- **Acceptance:** red-then-green on both; no happy-path SSE test changed; ledger a NOTE that
  the real-server error-frame smoke (`HILBERTRAUM_*`) is owed at the next smoke-drive session
  (couples with Phase 9's F-40 re-capture — write it into §Q).
- **Rollback:** revert the PR/branch; no data migration involved. Do not batch anything else
  into this phase.

## Phase 5 — Download & sidecar recovery (F-13, F-14, F-34, F-33, F-32)

- **Goal:** every recovery dead-end in downloads and sidecar lifecycle closed.
- **Fix specs:**
  - **F-13** `services/downloads.ts:340-491` (runOne) — if `.part` size ≥ known sizeBytes (or
    on caught HTTP 416): skip to `verifyDownloadedFile` → matching hash renames into place;
    mismatch deletes `.part` and restarts clean (ResumeOffsetMismatch treatment). Optionally a
    typed 416 in `assets.ts downloadToFile`.
  - **F-14** `services/vision/runtime.ts:191-208` — port TA-6 M1 verbatim from
    `translation/runtime.ts:473-474`: `onUnexpectedExit` that nulls `this.server`
    identity-compared, so the next analyze cold-starts. Mirror translation's M1 test cases.
  - **F-34** `services/assets.ts:624-658` — fsync the `.part` fd on finish before resolving
    (CODE-10 idiom); wiring-pin test (`vi.mock('node:fs')` asserting fsync-before-rename).
  - **F-33** `services/runtime-download.ts:174` + `:214-227` — deadline (~5 min) + kill
    escalation (whisper `killWithEscalation` pattern) + AbortSignal threading for
    `extractWithTar`; make `activeJob()`/`start()` treat a not-yet-settled `run()` as busy.
    **Wide mechanical blast radius:** the injected `extractImpl` in ~12 engine-download test
    sites gains the signal param — keep this its own commit inside the phase.
  - **F-32** `ipc/registerEngineIpc.ts:25-27` + `runtime-download.ts:241-260,303-306` — widen
    the in-use guard per family: refuse a `llama_cpp` install while ANY llama-server-backed
    sidecar (embedder/reranker/vision/translation, not just chat) has a live child; refuse
    `whisper_cpp` mid-transcription/dictation. Reuse the existing `main.engine.runtimeRunning`
    copy if it fits both languages; else add an EN+DE key pair (D-L4 display-map rules).
- **Tests:** per fix in the existing mirror suites (downloads.test.ts ×3 cases from the audit
  entry, vision-runtime M1 cases, engine-download busy/refusal cases, fsync wiring pin) — each
  red-then-green.
- **Docs:** known-limitations downloader-edges bullet (the 416 dead-end + the resume note),
  architecture sidecar record one-liner for the vision port; BUILD_STATE entry.
- **Acceptance:** full suite green; no i18n hardcoded strings introduced.
- **Handoff:** if F-32's guard shape differs from spec (e.g. new activity getters), ledger the
  final seam names for Phase 8 (F-30 caching sits in the same IPC file family).

## Phase 6 — Ingestion & export correctness (F-11, F-22, F-24, F-23, F-15, F-10⟨D-A⟩)

- **Goal:** parser/chunker/diff/export edge cases closed; no lone surrogates in stored or
  exported text; CSV exports open correctly in Excel (per D-A).
- **Fix specs:**
  - **F-11** `services/export/docx-rewrite.ts:73` — handle self-closing `<w:t …/>` explicitly
    (empty-node alternative before the paired-tag alternative). Unit test with a
    `<w:t xml:space="preserve"/>` fixture: text layer contains no markup; span in the following
    run splices correctly. Sole importer is `skills/run.ts` (redaction + document-edit paths).
  - **F-22** `services/ingestion/parsers/markdown.ts:10` (+ txt parser) — strip one leading
    U+FEFF after readFile. Round-trip test: app-exported BOM'd `.md` re-imports with correct
    section labels (the app's own exports prepend a BOM via `bomFor`).
  - **F-24** `services/ingestion/chunker.ts:74-75` — boundary-only surrogate correction in the
    window slice (extend/retract one code unit when the cut lands between a high/low surrogate).
    Keep it boundary-only so chunk counts stay stable for non-astral content (no migration;
    existing corpora re-chunk only on re-index — documented behavior). Unit test: 3000-unit
    glued-emoji run → no chunk text matches `/(^[\uDC00-\uDFFF])|([\uD800-\uDBFF]$)/`.
  - **F-23** `services/diff/index.ts:105-139` — early-return identical/empty DiffResult when
    both token arrays are empty (or fix the Int32Array sizing). Tests: `('','')`,
    `('   ','\n')` → identical, zero stats; empty-vs-nonempty unchanged.
  - **F-15** `services/analysis/coverage.ts:114` + the sibling persisting site + cosmetic
    `compare.ts` oneLine — reuse the exported `truncateSnippet` (parameterize its cap or add a
    shared codePointSlice). Mind the audit entry's note on the SQL `substr(1,281)` sentinel
    (fetch 282+ or compare by code points). Boundary test mirroring the RAG-2 test per site.
  - **F-10** (per D-A decision) `ipc/save-export.ts:16-25` (+ `registerSkillsIpc.saveTextFile`
    csv path) — extend `bomFor` to `.csv` (keep `tableToCsv` pure). **Flip the two pinning
    tests** (`save-export-bom.test.ts:25-29`, `result-tables.test.ts:144`) in the same commit;
    add a BOM'd-CSV re-import round-trip test (papaparse strips input BOM itself — verified).
    If D-A chose no-BOM: document the Excel consequence in known-limitations instead.
- **Tests:** the six unit tests above; full suite.
- **Docs:** known-limitations (L10 gains the boundary-corruption clause or is superseded by
  F-24's fix; F-10 outcome either way; the `.md`-export BOM note); BUILD_STATE entry.
- **Acceptance:** suite green; round-trips proven; no chunk-count churn on the existing
  test corpora (assert in the F-24 test file).

## Phase 7 — Renderer & IPC correctness polish (F-25, F-26, F-28, F-36, F-38 [+#59 copy if queued])

- **Goal:** close the renderer/IPC leaks and races; make the marketing captures truthful.
- **Fix specs:**
  - **F-25** `ipc/registerTranslateIpc.ts:93-104` — the lock-purge terminal must run the
    existing detach path: export a purge hook called by lock/quit alongside
    `translateJobs.stop()`, or route stopped jobs through the bound emitter's error terminal.
    Test: start job → `service.stop()` → sender's `destroyed` listener count back to 0,
    detachers map empty.
  - **F-26** `renderer/lib/visionSession.ts:232` — port the translate L6a guard:
    `if (snapshot.activeJobId || snapshot.analyzing) return 'busy'`, and/or gate the
    busy-branch's `set({analyzing:false})` on the owning generation (`myGen` exists). Test
    mirrors translateSession's L6a case.
  - **F-28** `preload/index.ts:382-386` + `shared/types.ts` — type the listDocuments `smart`
    filter as `SmartListView` (import the shared type); delete (or `@deprecated`) the dead
    `ChatOptions.useDocuments`. Gate: `npm run typecheck` (type-only, zero runtime).
  - **F-36** `renderer/preview/preview.tsx:124-132` — make the `getWorkspaceState` override
    case-aware like `getSettings`: `{state:'unlocked', mode:'encrypted', plaintextAllowed:false,
    encryptionRequired:true}` under `isMkt()`. Regenerate marketing PNGs; eyeball the Lock-now
    rail control in all shell shots.
  - **F-38** `renderer/preview/preview.tsx:844-875` + `scripts/screenshot.mjs` — un-stick
    `body[data-marketing-ready]`: keep observing after readiness and clear the flag when the
    goal disappears (re-walk), or encode per-shot goal selectors in `MKT_SHOTS` and require
    goal AND flag. Manual check with an injected settle delay; confirm the give-up path prints.
  - **#59 copy half** (if queued from Phase 3): scanned-PDF warning gains an actionable hint
    (EN+DE) pointing at how to get the OCR files.
- **Tests:** the two unit tests above; typecheck; marketing capture re-run (dev harness — no
  packaged-app impact, `!out/preview/**` pinned).
- **Docs:** none beyond BUILD_STATE unless #59 copy lands (user-guide/troubleshooting cross-ref).
- **Acceptance:** suite + typecheck green; captures eyeballed; issue #59 closable if both
  halves are done — comment + close via the tracker if so.

## Phase 8 — Performance & posture (F-29, F-30, F-31, F-35⟨D-B⟩, F-39⟨D-D⟩, F-12⟨D-C⟩)

- **Goal:** take the measured perf wins; settle the two honesty items; execute the D-C port.
- **Fix specs (measure before/after per the audit entries — no unmeasured "optimizations"):**
  - **F-29** `renderer/screens/ChatScreen.tsx:1112-1125` + main suggest path — memoize
    whole-corpus signals keyed by the documents table's `(COUNT, MAX(rowid))` signature (the
    resident-cache idiom), or skip the doc query when no candidate skill declares
    filenamePatterns/mimeTypes. **Caution from the verified blast radius:** `documentsInScope`
    is shared by ~13 call sites across three layers — memoize at the suggest-only seam, do NOT
    change the shared helper's semantics.
  - **F-30** `ipc/registerCoreIpc.ts:32-70` — cache the loaded policy keyed by
    `(path, mtimeMs+size)` of policy.json + drive.json inside `loadPolicy`; keep
    `buildPolicyStatus`'s signature. Callers verified: getAppStatus (polled), getPolicy,
    startup tripwire.
  - **F-31** `renderer/screens/DocumentsScreen.tsx:277-306` — coalesce completion-triggered
    refreshes (trailing-edge throttle ~1-2 s; final done-refresh immediate) or merge via the
    existing `listDocumentsByIds` helper (CODE-21, `ingestion/index.ts:1646`). **Move the
    exact-call-count pins** in `DocumentsScreen.test.tsx:684-738` with the fix.
  - **F-35** (per D-B) `services/benchmark.ts:141-163` + Diagnostics surfaces — relabel/drop
    the cached read figure; handle already-persisted inflated values (render sanely, no
    migration); `DiagnosticsCopySave` tests move in lockstep; `benchmark.md` updated.
  - **F-39** (per D-D) — investigate: build with `'unsafe-inline'` removed from style-src; if
    KaTeX/streamdown render styled → drop it and update `window-security.test.ts:34-48` (exact
    CSP pin) + `security-model.md:39-44` in the same commit; if not → keep and document the
    reason in the window-security header + ledger the verdict.
  - **F-12** (per D-C) `services/vision/history.ts:72-86` + `ipc/registerImagesIpc.ts:206-223`
    — switch to `encryptFileAsync`/`decryptFileAsync` + `fs/promises`; add a `shredFileAsync`
    twin; make the three history functions async; **await `ensureSession` before `base.done`**
    so sessionId still rides the done event (pinned by `images-ipc.test.ts:430-…`). Validate
    with `monitorEventLoopDelay` (or 60 Hz IPC probe) on an encrypted workspace, USB stick,
    15-20 MiB JPEG — record numbers in the ledger.
- **Tests:** per fix as named; render-count/measurement evidence in the ledger; full suite.
- **Docs:** benchmark.md (F-35), security-model.md (F-39), known-limitations if F-12 changes
  the recorded posture — plus flip the §35 divergence note (that record gets a dated
  supersede annotation, not a rewrite); BUILD_STATE entry.
- **Acceptance:** suite + typecheck + build green; measurements recorded; marketing/Diagnostics
  eyeballs done where UI changed.

## Phase 9 — Test-infra hygiene + queue sweep (F-40, F-41, §Q)

- **Goal:** fixture provenance truthful; `as never` erosion stopped; every §Q item resolved or
  explicitly registered.
- **Fix specs:**
  - **F-40** `tests/unit/gpu.test.ts:16-24` — NOW: correct the comment ("captured on b9585;
    pin is b9849; re-capture owed"). The full b9849 re-capture (GPU `--list-devices`, vision
    SSE sample — with the pinned byte assertions moving) rides the next manual smoke-drive
    session together with Phase 4's real-server error-frame smoke and the standing TS-3(a)
    rider — put ONE consolidated smoke-session checklist into BUILD_STATE §5 item 7 (TS-3
    bullet) instead of three scattered notes.
  - **F-41** `tests/helpers/renderer.ts` + the heaviest cast files — bounded slice: convert the
    top-5 files (ImagesScreen 23, translateSession 9, TranslateScreen 7, doctasksStore 7, +1)
    to typed partial builders (the `HomeScreenPoll.test.tsx` pattern); add a ratchet guard
    (grep-count test: `as never` count in tests/ may only decrease — record the baseline
    number in the test). Rest is fix-when-touched; note it in CONTRIBUTING's test guidance.
  - **§Q sweep:** resolve every queued item: fix (with test), or register it properly
    (BUILD_STATE §5 / known-limitations / GitHub issue) with a one-line disposition in §L.
    Nothing may remain in §Q at phase end.
- **Tests:** typecheck after each cast-conversion slice; the ratchet test red-green ritual.
- **Docs:** CONTRIBUTING test-guidance line; BUILD_STATE entry.
- **Acceptance:** §Q empty; ratchet in place; typecheck green.

## Phase 10 — Wave close-out

- **Goal:** the wave is merged, durable, and the working papers are retired per repo convention.
- **Steps:**
  1. Verify every finding F-01…F-41 has a §L disposition (fixed@phase+commit / owner-declined
     with reason / registered-where). Cross-check against the audit report §3 list.
  2. Fold the durable record into `docs/architecture.md` as the next §-numbered ledger
     (**§50** if still free): per-finding disposition table, the §D decisions as executed, the
     clean verdicts worth preserving (audit report Appendix B highlights), deviations/new
     findings (NF-*) and where they landed, and a §-anchor legend so `audit 2026-07-16 F-xx`
     citations in commits/tests resolve. Update architecture.md's "layout of this file" block.
  3. BUILD_STATE: close the §5 wave item (short close-out entry, pointer to §50); restore the
     CLAUDE.md doc-lifecycle sentence to "none currently open".
  4. **Owner confirmation, then delete BOTH working papers** (`docs/audit-2026-07-16.md`,
     this plan). They are committed on the wave branch, so unlike prior rounds the full text
     stays in git history — record the final `git show <sha>:docs/audit-2026-07-16.md` pointer
     in the §50 legend.
  5. Merge: PR of the stacked chain into `master`, green `ci-success` required (or the last
     per-phase PR under D-E-alternative). Suggest a version checkpoint tag after merge
     (v0.1.51-style, owner-pushed per the standing tag policy).
  6. Final gates on the merge result: full suite (record the final count vs the 4,216/49
     baseline), typecheck, build.
- **Acceptance:** master green; §50 resolves every citation; no working paper left; BUILD_STATE
  within its size budget.

---

## §S. Standing rules (apply to every phase; violations are ledger-reportable)

1. **Solid over quick:** a fix that grows beyond its audit-verified blast radius is paused and
   re-triaged (§N), never forced. Characterization tests before behavior changes; TEETH
   demonstrations for new invariants; blast-radius items move in the same commit.
2. **Repo hard rules** (CLAUDE.md): no cloud/telemetry; offline-usable; never commit weights/
   user data/generated files; no dev-specific absolute paths; Windows first-class.
3. **Git:** feature branches only; no direct master pushes; explicit-path staging only
   (never `git add -A` — concurrent sessions share this tree); `npm ci` never `npm install`
   unless a dependency change is the point (there is none in this plan).
4. **Docs discipline:** dated journal entries and §46–§49 ledgers are historical — annotate,
   never rewrite; no `_Last updated` stamps; hygiene (LF, no NUL, no BOM) on every edited file.
5. **i18n:** any new user-visible string lands as an EN+DE catalog pair; main-process emissions
   follow the persist-canonical-English + display-map rules.
6. **Tests:** full `npm test` at phase end (count recorded in §L); targeted `npx vitest run`
   during work; never weaken an assertion to get green — that is a §N-a/b event.

## §L. Wave ledger (append-only; newest first; the inter-phase handoff channel)

> Template per entry — keep it complete but tight; this ledger is folded into architecture.md
> §50 at close-out:
>
> ```
> ### Phase <N> — <date> — branch fix/audit-2026-07-16-p<N> @ <commit>
> - Gate: <tests passed/skipped> · typecheck <clean?> · build <green/n-a>
> - Fixed: F-xx <one-line outcome + key decision taken>, F-yy …
> - Deviations from plan: <none | what + why + §N disposition>
> - New findings: NF-<n> <desc> → fixed here / queued §Q → phase <M> / registered <where>
> - Messages to later phases: <"Phase 7: …" | none>
> - Docs touched: <files> · BUILD_STATE entry added: <yes>
> ```

### Phase 4 — 2026-07-17 — branch fix/audit-2026-07-16-p4 @ this commit (stacked on p3 @ 16b6438; F-02 landed separately @ d57cfd9)
- Gate: **4,233 passed / 49 skipped** · typecheck clean · build green (`apps/desktop/src` touched).
  Baseline entering P4 was 4,221/49 (entry 3); +12 = 6 new `read-chat-sse` cases (4 error-frame
  characterizations + 2 regressions), 1 `chat-stream` friendly-mapping pin, 1 `chat.test` main-turn
  consumer pin, 1 `chat-compaction` mid-stream-failure pin, 2 `rag.test` grounded-path pins, 1
  `whole-doc-extract` model-swap characterization. Hygiene: all 15 edited files BOM-free, NUL-free
  (byte-checked); LF via `.gitattributes` normalization.
- Fixed (in listed order, one commit per finding per §O):
  - **F-02** (commit `d57cfd9`) — `parseSseLine` now recognizes BOTH in-band mid-stream failure
    carriers (a `data:` JSON with a top-level `error` object, and a bare `error: {…}` SSE field
    line — the plan's "optional" shape included deliberately: it is the exact TA-4 M3 carrier the
    repo verified for the same server, and completion.ts handles it; parity mirrored verbatim) and
    `readChatSSE` REJECTS with a new typed `ChatStreamError` (name/serverMessage/serverType,
    SEC-N3 structural-only posture) instead of ending cleanly — incl. the flushed-tail path (error
    frame with no trailing newline before close). Frame shapes pinned with b9849 provenance
    comments + the TS-3(a) re-verify rider in code AND fixtures. Characterization tests watched
    RED first: pre-fix, all 4 cases ended cleanly (err === null — the exact swallow). NOT built:
    a missing-`[DONE]`-terminal check (completion.ts M2 analog) — the plan's fix spec scopes F-02
    to error-frame recognition; a bare close-without-DONE keeps today's semantics (see §N note).
    **Consumer-semantics sweep (each decided + pinned by a test):**
    - `chat.ts` main turn → PROPAGATE (the CB-5 mid-stream precedent): partial never silently
      persisted as complete; regenerate's F2 guard restores the prior reply. NOT chosen: persisting
      the partial stamped `truncated` — that badge's copy claims a context-limit stop, which an
      error frame is not; consistency with the established RuntimeUnresponsive semantics won.
    - `chat/compaction.ts` → the existing R4/R6 catch absorbs the rejection: a summary stream that
      fails MID-WAY (tokens, then error frame) writes NO checkpoint, non-abort logged, turn answers
      on the L1 fallback. Pre-fix this was the worst case: the silently truncated summary WAS
      checkpointed, corrupting later turns' context.
    - `rag/index.ts:1682` (grounded relevance) + `:1842` (grounded-data) → PROPAGATE, nothing
      persists; both handlers run under the same `withChatStream` wrapper as plain chat, so the
      friendly mapping covers them with zero extra wiring.
    - `ipc/chat-stream.ts` → new mapping link (unresponsive → emptyCompletion → **streamError** →
      overflow → raw): `main.chat.streamError` EN+DE pair (i18n §S5; content-free — the structural
      reason goes to the local log only). Mapping teeth shown by temporary revert (raw
      "Chat stream failed: …" leaked → red → restored).
    - Remaining blast-radius consumers verified, no per-consumer change needed: whole-doc-tree
      (:248/:474/:583) + doctasks `generate` propagate into the existing friendly-task-failure
      envelope; vision/runtime.ts:285 (direct readChatSSE caller) rejects into the images-IPC
      failure path; benchmark.ts benign; skills JSON-schema flows already failed visibly on parse.
  - **F-01** (this commit) — `extract.ts` markerExists cache-hit lookup gains `AND model_id = ?`
    (the current pass's `deps.modelId`); the hash (`contentHashOf`) untouched — the
    `analysis-extract-hash.test.ts` byte-identity pin stays green, persisted rows stay
    addressable. Characterization test watched RED (corrected stub — see deviations): pre-fix a
    model-B re-run made 0 generate calls and rows stayed `extract-model`; post-fix it re-extracts,
    rows replaced (never mixed), same-model re-run stays 0-call and the #50 unparsed-retry +
    DATA-3 idempotency pins are unchanged. Stale comments corrected (file invariants block +
    `ExtractDeps.modelId` doc).
- Deviations from plan: none material.
  (1) The F-01 test's first red run used a spread-copied stub whose `calls` counter didn't share
  the factory closure — red for a partly wrong reason; corrected the stub and RE-demonstrated
  red→green against the pre-fix extract.ts via stash (the honest teeth are the re-run).
  (2) `data-contracts.md` was updated even though the renderer-visible surface did not change
  SHAPE (`chat:error:<id>` still carries an error string): one additive clause documents the new
  mid-stream rejection + friendly key — recorded here since the plan conditioned that edit.
  (3) `architecture.md` "Chat & streaming" record line (readChatSSE description) gained the
  error-frame clause per the audit's doc-updates note — a design-record annotation, not a
  §46–§49 ledger touch.
- New findings: none fixed in-phase (NF-* none). §N note, disposition (b)-adjacent: a graceful
  server close WITHOUT `[DONE]` and WITHOUT an error frame still ends the chat reader cleanly
  (translation's M2 `IncompleteStreamError` analog does not exist for chat). The audit's F-02
  entry mentions the M2 pattern as mirror-worthy but the plan's fix spec deliberately scopes to
  error frames; a terminal-frame requirement would change abort/close semantics for every
  consumer and deserves its own audit finding if wanted. Left as-is, noted for the record (the
  Q-2 smoke can observe whether the real server ever closes error-free mid-generation).
- §Q: added **Q-2** — the real-server error-frame smoke (TS-3(a) territory), targeted Phase 9,
  couples with F-40's b9849 re-capture; Phase 9 folds it into the ONE consolidated smoke-session
  checklist in BUILD_STATE §5 item 7.
- Messages to later phases:
  - **Phase 7 (F-25/F-26 renderer polish):** the chat error surface gained one new friendly copy
    key `main.chat.streamError` (EN+DE); no renderer code change was needed (the copy rides the
    existing `chat:error` string channel). Nothing else re-scoped.
  - **Phase 9:** consume §Q Q-2 into the consolidated smoke checklist (with F-40's re-capture and
    the standing TS-3(a) rider).
  - **Phase 10:** fold the F-02 consumer-semantics decisions above into the §50 record — they are
    the durable "decided semantics per consumer" table the audit asked for.
- Docs touched: `docs/rag-design.md` §14.5 (error-frame clause + model-keyed cache clause + the
  accepted one-re-extract-per-swap cost note), `docs/data-contracts.md` (streaming-contract
  additive clause), `docs/architecture.md` (Chat & streaming record line), `BUILD_STATE.md`
  (§5 item 14 Phase-4 line), this plan (§Q Q-2 + §L). BUILD_STATE entry added: yes.

### Phase 3 — 2026-07-17 — branch fix/audit-2026-07-16-p3 @ this commit (stacked on p2 @ 293a0e4)
- Gate: **4,221 passed / 49 skipped** · typecheck clean · build n/a (only `scripts/`, `docs/`, `README.md`,
  and one test file touched — nothing under `apps/desktop/src`). Baseline entering P3 was 4,219/49 (ledger
  entry 0 + P2's +2); +2 = the two new F-05 OCR-family parity assertions. Hygiene: all edited `.ps1`/`.sh`
  are outside the repo-hygiene nets (§49 ④, known); verified NUL-free + BOM-free, and `.gitattributes`
  (`* text=auto eol=lf`) normalizes every committed blob to LF (working-tree CRLF is just autocrlf checkout).
- Fixed (all five in listed order):
  - **F-05** — added the `ocr` family fetch to the `--with-assets` block in BOTH prepare-drive siblings
    (`prepare-drive.sh` after the whisper block; `prepare-drive.ps1` after its whisper block), mirroring the
    whisper_cpp call but fetched UNCONDITIONALLY like llama.cpp (OS-independent, ~4 MB — no best-effort
    wrapper, a failure aborts). Updated both header comments (sh:11-18 + the DEFAULT_MODEL_IDS block comment;
    ps1 `.PARAMETER WithAssets` + the `$DefaultModelIds` block comment). New parity net in
    `prepare-drive-default-set.test.ts` (describe "…OCR family in both siblings (F-05)") pins both siblings
    invoke fetch-runtime for `ocr` — there is NO canonical TS plan for the with-assets fetch-CALL set
    (drive.ts planPrepareDrive models layout/config/copies only), so this is a direct sh↔ps1 parity assertion,
    not a TS-drift one. TEETH: added the two assertions FIRST, watched both redden against the pre-fix scripts,
    then greened after the script edits. Dry-run parity confirmed (see below).
  - **F-03** — `prepare-drive.sh` COMMON_MODEL_ARGS empty-array expansion at both call sites (the `--all-models`
    single call + the default-set per-id loop) now uses the M23 idiom `${COMMON_MODEL_ARGS[@]+"${COMMON_MODEL_ARGS[@]}"}`;
    added a guard comment citing fetch-models.sh:161. Swept the file: COMMON_MODEL_ARGS was the only
    empty-capable array (DIRS/LICENSE_ARTIFACTS/DEFAULT_MODEL_IDS are literal-non-empty, RUNTIME_ARGS always
    carries --target — matches the audit's non-impact list).
  - **F-04** — `fetch-models.sh` handle_file now called failure-tolerantly at BOTH sites (`… || true`;
    the mmproj site wrapped as `[[ … ]] && { … || true; }` to keep the `|| true` bound to handle_file);
    had_failure still aggregates and drives the exit-1 gate. Now matches fetch-models.ps1 (continue +
    summary + exit 1).
  - **F-18** — `setup-dev.ps1` `--use-system-ca` probe rewritten to `node -p "process.allowedNodeEnvironmentFlags.has('--use-system-ca')"`
    (no stderr redirect at all), replacing `& node --use-system-ca -e 0 2>$null | Out-Null`. Under
    `$ErrorActionPreference='Stop'` PS 5.1 wrapped the redirected native stderr in ErrorRecords and
    terminated; the introspection probe prints True/False on stdout and exits 0 on every supported Node, so
    the EAP hazard is gone. Kept the same append-to-NODE_OPTIONS + fallback-note structure.
  - **F-19** — `fetch-runtime.sh:321` archive-name derivation now strips `?query` then `#fragment` after
    basename (`%%\?*` / `%%#*`), converging with fetch-runtime.ps1 ([uri].AbsolutePath) and assets.ts
    (split('?')[0]). Latent-until-edit (all current runtime-sources URLs are query-free) but the extraction
    dispatch keys on ARCHIVE_NAME, so an HF-style `?download=true` would have mis-routed a `.tar.gz` to unzip.
- Verification evidence (this box is Windows/win32; genuine bash-3.2 not available — GNU bash 5.3):
  - **Dry-run parity ps1↔sh** (`--with-assets --dry-run --accept-license`): both print the identical asset
    plan — 5 default models, llama.cpp win/vulkan @ b9849, whisper.cpp win/cpu @ v1.8.6, **and OCR deu/eng
    traineddata @ 4.0.0_best_int** into `ocr/`. F-05 confirmed on both shells.
  - **F-03** verified by idiom correctness (empty array under `set -u` → expands to nothing, no unbound error;
    filled array → expands verbatim) + the repo's own M23 precedent (fetch-models.sh:161 uses the same class).
    The bash-3.2 abort itself could NOT be reproduced here (bash 5.3 tolerates the bare empty expansion) — stated
    honestly per the orchestrator instruction; the fix is the exact idiom the repo already relies on.
  - **F-04** teeth shown against the REAL script: ran the committed (HEAD) `fetch-models.sh` vs the fixed one
    over 3 forced-bad-URL manifests (curl/sleep stubbed for instant failure). Pre-fix: aborts after the first
    FAIL, test-b/test-c never attempted, no summary. Fixed: all 3 attempted, `Planned 3 | fetched 0 | skipped 0`
    prints, exit 1.
  - **F-18** teeth under PS 5.1 + EAP Stop: NEW probe works on the real node (enable branch) AND on a stub node
    lacking the flag (fallback branch, no crash); the OLD stderr-redirect shape crashes with NativeCommandError
    on the same stub — the exact bug removed.
  - **F-19** verified: `build.tar.gz?download=true` and `build.tgz#frag` now strip to `.tar.gz`/`.tgz` and route
    to the tar case (were routed to unzip pre-fix).
- **--with-assets size figure (handoff):** unchanged at **~10.4 GB**. The OCR data is deu+eng `.traineddata.gz`
  ≈ **~4 MB total** — within the headline's rounding, so Phase 1's ~10.4 GB stands. Updated the enumerations in
  `docs/packaging.md` (default-set paragraph + the parity-test note) and `README.md` (lines ~84 and ~148-158) to
  LIST the OCR files; the GB figure was deliberately left at 10.4.
- Deviations from plan: none material. The condensed plan said "extend prepare-drive-default-set.test.ts /
  script-drift.test.ts where the canonical TS plan exists" — the audit F-05 blast radius confirms NO canonical
  TS plan exists for the with-assets fetch-call set, so the OCR pin is a direct sh↔ps1 parity assertion added to
  prepare-drive-default-set.test.ts (the audit's "a new parity assertion would be additive"). Not a scope change.
- New findings: none (NF-* none). §Q: added **Q-1** — the #59 warning-copy half (in-app dead-end message),
  targeted to **Phase 7** per the plan default (renderer-copy EN+DE hint).
- Messages to later phases:
  - **Phase 7:** consume §Q Q-1 (the #59 in-app scanned-PDF/photo warning still has no "how to get the OCR
    files" hint). The provisioning root cause is now fixed, so the copy can point at a concrete remedy:
    `fetch-runtime --family ocr` (or rebuild the drive with `--with-assets`).
  - **Phase 10:** do NOT let this wave close without commenting on issue **#59** — but only AFTER the wave is
    merged to a pushed sha (nothing is pushed pre-merge; a comment now would reference an unpushed commit).
    Ready-to-post comment text (post it verbatim after merge, filling the merge sha):
    > Fixed the provisioning root cause in the audit-2026-07-16 remediation wave (Phase 3): `prepare-drive
    > --with-assets` now fetches the `ocr` family (deu/eng traineddata) in BOTH the `.ps1` and `.sh` siblings,
    > so every DIY-built drive ships with scanned-PDF/photo OCR working out of the box — previously only
    > commercially-built drives got it. A parity test (`prepare-drive-default-set.test.ts`) now pins that both
    > shells fetch it, so it can't silently regress. Existing DIY drives can be topped up with one command:
    > `scripts/fetch-runtime.sh --target <drive> --family ocr` (or `.ps1 -Family ocr`). **Still open (this
    > issue's other half):** the in-app scanned-PDF warning copy doesn't yet point users to that remedy — that
    > renderer-copy fix is tracked for Phase 7 of the same wave.
- Docs touched: `docs/packaging.md`, `README.md`, `apps/desktop/tests/unit/prepare-drive-default-set.test.ts`
  (new describe block), the five scripts, `BUILD_STATE.md` (§5 item 14 Phase-3 line), this plan (§Q + §L).
  BUILD_STATE entry added: yes.

### Phase 2 — 2026-07-17 — branch fix/audit-2026-07-16-p2 @ this commit (stacked on p1 @ e8e1313)
- Gate: **4,219 passed / 49 skipped** · typecheck clean · build n/a (only `tests/`, `model-manifests/`,
  and docs touched — nothing under `apps/desktop/src`). Baseline was 4,217/49 (entry 0); +2 = the two
  new invariants. Hygiene: all six edited files LF, no BOM, no NUL (verified by byte count).
- Fixed:
  - **F-06** — `model-manifests/chat/qwen3.5-9b-q8.yaml`: `recommended_context_tokens` 98304 → **8192**
    (the DEFAULT resolution per §D — owner batch-accepted; drop ctx to the catalog convention, capable
    owners re-raise via the in-app Settings override). Rewrote the manifest's own sizing comment
    (lines ~11-14) to record the normalization + why (ctx becomes `--ctx-size` verbatim, min-RAM 14 is
    the hard gate, 96k KV ~12 GB + Q8 weight ~8.9 GB ≈ 22 GB > 14). The rank-0 posture, the private
    G3/register-D license-provenance review, and every other field are untouched (not conflated).
  - **F-16** — `qwen3.6-27b-q4.yaml` `size_on_disk_gb` 15.7 → **16.8**, `qwen3.6-27b-q5.yaml` 18.2 →
    **19.5** (decimal GB = `size_bytes/1e9`: 16,817,244,384 and 19,509,790,944). Blast-radius display
    cells moved in the same commit: `README.md:223-224`, `docs/model-policy.md:28-29`. Also made both
    manifests' incidental GiB-labelled comments decimal-GB-primary (`~16.8 GB (15.7 GiB)` /
    `~19.5 GB (18.2 GiB)`) so the field and its comment stop reading as a unit mismatch — q4's comment
    line is in the audit F-16 blast radius; q5's sibling line was matched for parity (same finding,
    same file family, §N-a in-scope). The new size invariant now fences any silent revert.
  - **New invariants** in `apps/desktop/tests/integration/committed-catalog.test.ts` (new describe block
    "internal coherence invariants (F-06, F-16)"): (1) every chat manifest's
    `recommended_context_tokens ≤ recommended_min_ram_gb × 2048` (tok/GB plausibility bound — whole
    committed catalog sits ≤ 1024 tok/GB, tightest gemma4-coding-q8 at 16384@16; 2x headroom); (2)
    `|size_on_disk_gb − size_bytes/1e9| < 0.15` for every manifest with a numeric `download.size_bytes`
    (single-file; the vision manifest carries no `size_bytes` — composite GGUF+mmproj — so the
    numeric guard excludes it; largest honest gap in the catalog is qwen3.5-0.8b at 0.061).
- TEETH (red-green ritual, plan-required): the YAML started at pre-fix values, so the invariants were
  added FIRST and run against pre-fix — **both reddened**: F-06 invariant "expected 98304 to be ≤ 28672
  (14 GB × 2048)"; F-16 invariant "expected 1.117 (15.7 vs 16.817) to be < 0.15". After the YAML fixes
  the whole `committed-catalog.test.ts` (13 tests) + `benchmark.test.ts` (31) run green.
- Recommendation mapping UNCHANGED — re-verified: `benchmark.test.ts` (31/31) byte-identical; the
  size tiebreak is not decisive for either 27B (24 GB tier decided rank-3 vs gemma4-12b rank-2; Q5 is
  the sole rank-3 at recRam 32), and ctx/size are not picker inputs at all for the 9B-Q8 (rank 0).
- Deviations from plan: none material. The q5 comment-line touch (F-16 parity) is the only edit beyond
  the condensed plan's literal list; it is the same finding in the same file, recorded here per §N-a.
- New findings: none. (Noted but NOT actioned: qwen3.5-0.8b declares `size_on_disk_gb: 0.7` vs 0.639
  actual — a 0.061 rounding-up, not the GiB/GB unit class F-16 targets; the audit did not flag it and
  it clears the 0.15 tolerance. Left as-is, not queued — mentioned for the record only.)
- Messages to later phases: **none owed.** Verified the Phase-1 benchmark.md four-tier table quotes no
  ctx value (F-06's ctx change needs no benchmark.md edit, as Phase 1 flagged). The §5-item-8 owner
  ratification sequence now reads a coherent 8192 ctx for qwen3.5-9b-q8 and decimal 16.8/19.5 sizes.
- Docs touched: `README.md`, `docs/model-policy.md`, three chat manifests
  (`qwen3.5-9b-q8.yaml`, `qwen3.6-27b-q4.yaml`, `qwen3.6-27b-q5.yaml`),
  `apps/desktop/tests/integration/committed-catalog.test.ts`, `BUILD_STATE.md` (§5 item 14 Phase-2
  line), this plan (§L). BUILD_STATE entry added: yes.

### Phase 1 — 2026-07-17 — branch fix/audit-2026-07-16-p1 @ this commit (sha is this Phase-1 commit; also carries the Phase-0 kickoff sha backfill)
- Gate: **4,217 passed / 49 skipped** · typecheck clean · build green (src comments touched, so
  built to be safe). Matches the entry-0 baseline exactly — docs/comment-only neutrality proven.
- Fixed (docs/comments only, zero runtime behavior):
  - **F-08** — corrected the incumbent eval figures misattributed to Ministral (its real committed
    row is F1 .3111 / EM .9529, i7-1185G7 Phase-29 rescored run; the .3262/.9765 quoted in the
    stale text is qwen3-8b's i9 row). Restated the 9B standing: EDGES Ministral on F1/EM within
    cross-run tolerance (F1 .3152/.3124 vs .3111, EM .9765 vs .9529), ranked under it only on the
    hallucination-trap (`en-contract-penalty`) axis. Fixed the 4B EM (tied .9647, not .9765) and
    the "~1 point EM" claim (widest 9B-tier gap is 2.36 pts). model-policy.md:25 (4B row) left as
    accurate. Sites: `docs/model-benchmarks.md` §6.4 (the EM-spread rationale line + the
    "what this supersedes" 4B/9B standing), `model-manifests/chat/qwen3.5-9b-ud-q4kxl.yaml` rank
    comment (~15-20), `qwen3.5-4b-ud-q4kxl.yaml` rank comment (~14-15), `docs/model-policy.md:26`.
  - **F-07** — `docs/benchmark.md` Recommendation table (~86-90) → the four §6.4 tiers (≤12 →
    qwen3.5-4b-ud-q4kxl, 16–20 → qwen3.5-9b-ud-q4kxl, 24 → qwen3.6-27b-q4, ≥32 → qwen3.6-27b-q5);
    added a separate bundled-default note (qwen3-4b unchanged); re-pointed the rank link §6.2 →
    §6.2–§6.4.
  - **F-09** — supersede annotations (§6.3 style): `docs/model-policy.md` "Qwen3.5 Unsloth wave"
    (fixed the 96-99 smoke sentence → 4B smoke SATISFIED 2026-07-12, 9B/27B/35B §9.1 smokes open;
    added a `_(Superseded 2026-07-12: …)_` note after the "None are auto-recommended" bullet) and
    `docs/model-benchmarks.md` §9 (three spots: the update-note supersede marker, the "stays rank
    0" rule-sentence supersede, and the committed-CSV status "now committed under eval/results/
    i9-9900X-vulkan-*").
  - **F-20** — `docs/data-contracts.md:112-115` and `:450-452`: dropped the rotting hard total
    ("19 model manifests (14 chat)") and converted both to a `model-policy.md` pointer (kept the
    6-role-dir enumeration, which is structural).
  - **F-21** — `docs/model-policy.md:95` "presets 4k–32k" → "presets 4k–128k".
  - **F-17** — appended a dated `UPDATE 2026-07-12: …` line to both promoted manifests'
    `license_review.notes` (9b-ud-q4kxl + 4b-ud-q4kxl), recording the smoke + rank-3 promotion,
    original text preserved, matching the 27B "Supersedes…" style. ASCII-only append (`<=`/`-`).
  - **F-27** — `apps/desktop/src/preload/index.ts` startDocTask JSDoc: "curated 10" → "closed
    51-code WMT24++ set (`TRANSLATION_LANGUAGE_CODES`, issue #31)".
  - **F-37** — rewrote the stale soft-hyphen comment in `apps/desktop/src/shared/i18n/en.ts`
    (~15-19) and `de.ts` (~31-35): hyphens removed in bad4eaf; preview.tsx matches nav labels by
    exact textContent, so re-adding U+00AD would break the marketing walker.
- Deviations from plan:
  - **F-37** also updated the THIRD stale copy of the comment in
    `apps/desktop/tests/renderer/InformationArchitecture.test.tsx` (~140-143) — comment-only, zero
    test churn. The condensed plan named only en.ts + de.ts, but the audit-report F-37 blast radius
    explicitly lists this test file as the third site, so this is executing the report contract, not
    scope creep. The `.replace(/­/g,'')` there is a harmless no-op guard, left in place.
  - **F-37 optional mktClickNav hardening: DEFERRED (not done).** It is optional per the plan and
    would require a marketing-capture re-run (heavy in this env). The latent re-add risk it guards is
    already fenced by CI (`rail-labels.test.ts` + `i18n.test.ts` block re-adding U+00AD, per the
    audit blast radius), so deferring leaves no unguarded hole. Not queued to §Q; if a future phase
    wants belt-and-suspenders, it is a one-line dev-harness change in preview.tsx.
- New findings: none. Cross-checked every eval figure against the committed CSVs
  (`eval/results/i7-1185G7-cpu-quality-rescored.csv`, `i9-9900X-vulkan-quality.csv`) before writing
  — all match. No unlisted pinning test surfaced (typecheck + full suite confirm).
- Messages to later phases: **Phase 2** — my F-08/F-17 manifest edits touched
  `qwen3.5-9b-ud-q4kxl.yaml` and `qwen3.5-4b-ud-q4kxl.yaml` (rank comments + license notes only;
  YAML values untouched). Phase 2's targets are `qwen3.5-9b-q8.yaml` and the two `qwen3.6-27b-*`
  manifests — no overlap, but you now stack on top of these two files. The benchmark.md tier table
  (F-07) is now the four-tier §6.4 mapping; no sentence in it quotes a ctx value, so a Phase-2 F-06
  ctx change needs no benchmark.md edit.
- Docs touched: `docs/model-benchmarks.md`, `docs/model-policy.md`, `docs/benchmark.md`,
  `docs/data-contracts.md`, two chat manifests, `preload/index.ts`, `i18n/en.ts`, `i18n/de.ts`,
  `InformationArchitecture.test.tsx`, `BUILD_STATE.md` (§5 item 14 Phase-1 line), this plan (§L).
  BUILD_STATE entry added: yes (short line under §5 item 14).

### Phase 0 — 2026-07-17 — branch fix/audit-2026-07-16-p1 @ 8bf0fc7 (sha backfilled post-commit; rides in the Phase 1 commit)
- Gate: **4,217 passed / 49 skipped** · typecheck clean · build n/a (docs-only).
  **Baseline correction for all later phases:** the plan's "4,216/49" figure predates PR #56's
  added Qwen3.6 promotion-facts pin (+1 test, BUILD_STATE 2026-07-12 entry); the true
  master-HEAD (`4e02a48`) baseline is **4,217/49** — docs-only phases must match THIS number.
- Fixed: no findings (kickoff). §D decisions taken by the owner in one batch, all five per
  recommendation: **D-A** add CSV BOM (Phase 6); **D-B** relabel/drop the cached read figure
  (Phase 8); **D-C** async image-history port approved (Phase 8); **D-D** CSP `'unsafe-inline'`
  investigation pre-authorized both ways (Phase 8); **D-E** stacked branches + ONE wave-close
  PR (Phase 10).
- Deviations from plan: one addition — `docs/audit-2026-07-16.md` (the frozen audit report) is
  committed in the kickoff commit alongside the plan. Phase 10 step 4 presumes both working
  papers are committed on the wave branch ("the full text stays in git history"); committing
  the report at kickoff is what makes that true. The report remains frozen — never edited.
- New findings: none.
- Messages to later phases: execution model for this wave — phases run as sub-agents of one
  orchestrator session (adapting §O's one-session-per-phase to one-sub-agent-per-phase);
  branches, gates, ledger discipline unchanged. Phases 4/5/6 additionally get an independent
  review agent over the phase diff before acceptance.
- Docs touched: this file (status, §D decisions, this entry), `CLAUDE.md` (doc-lifecycle
  sentence names this plan as the sanctioned open plan), `BUILD_STATE.md` §5 item 14 (wave
  registered as open). BUILD_STATE entry added: yes (§5 item 14; no dated journal entry —
  Phase 0's step list names only the §5 item).
