# Remediation plan — full audit 2026-07-16

> **Working paper (open plan).** Executable playbook for fixing all 41 verified findings of
> [`docs/audit-2026-07-16.md`](audit-2026-07-16.md) (F-01…F-41; 14 Medium, 27 Low, 0 Critical/High).
> Each phase is sized for **one fresh orchestrator session**. The audit report stays on disk for
> the whole wave — it is the detail record (evidence, verifier reasoning, full blast radius);
> this plan is the execution order and the **wave ledger** (§L) that carries information between
> phases. Doc lifecycle: while this wave is open, this file is the repo's sanctioned open plan;
> at close-out (Phase 10) its durable content is folded into an `architecture.md` §-numbered
> design record and both working papers are deleted per the CLAUDE.md doc-lifecycle rule.

**Status: CLOSE-OUT (Phase 10 folding done 2026-07-17)** — all 41 findings dispositioned
(§L entries 0–9); the durable record is folded into `docs/architecture.md` **§50**; this file
awaits the owner-confirmed deletion (Phase 10 step 4) + the wave-close PR/merge/tag (steps 5–6).

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
| Q-1 | Phase 3 (F-05) | **#59 warning-copy half.** F-05 fixed the provisioning root cause (DIY `--with-assets` now fetches the `ocr` family), but the in-app scanned-PDF/photo dead-end warning (`shared/i18n/en.ts:488,1811` + de.ts counterparts) still says "OCR files not on this drive" without telling the user how to get them. Renderer-copy change: add an actionable EN+DE `unavailable → how to get it` hint keyed off the packaging docs (`fetch-runtime --family ocr`, or rebuild with `--with-assets`). Overlaps `user-guide.md:356-363` / `troubleshooting.md:185-197`. | Phase 7 | **resolved (P7, 2026-07-17)** — `docs.scan.ocrMissing` + `main.task.needsOcr` gained an EN+DE `--with-assets` / `fetch-runtime --family ocr` remedy hint; `imageNeedsOcr` (persist-canonical) left byte-stable, covered by docs; user-guide + troubleshooting cross-refs added. See §L Phase-7. |
| Q-2 | Phase 4 (F-02) | **Real-server error-frame smoke owed.** The F-02 in-band error-frame shapes (`data: {"error":{…}}` + bare `error: {…}` field line) are pinned from the TA-4-verified wire contract + hand-authored fixtures — CI green does NOT evidence the real b9849 wire format (TS-3(a)). At the next manual smoke-drive session, force a real llama-server mid-stream error (tiny ctx + context-shift disabled, `HILBERTRAUM_*` env) and verify the reader rejects + the friendly copy surfaces. Also watch the PARTIAL error-frame case: an error frame whose JSON is truncated mid-write (`data: {"error":{"mess` + close, no `[DONE]`) still parses as a keep-alive and the stream ends CLEANLY — inside Phase 4's §N close-without-`[DONE]` scope-out, and the real server is where it would surface if it occurs. COUPLES with Phase 9's F-40 b9849 re-capture — Phase 9: register this into the ONE consolidated smoke-session checklist (BUILD_STATE §5 item 7 TS-3 bullet) rather than as a scattered note. | Phase 9 | **resolved-by-registration (P9, 2026-07-17)** — folded into BUILD_STATE §5 item 7 TS-3 as new checklist item **(i)** "real-server mid-stream error-frame smoke (F-02 / §Q Q-2)" (tiny ctx + context-shift disabled, `HILBERTRAUM_*`, reader rejects + friendly `main.chat.streamError`; PARTIAL-frame `data: {"error":{"mess` + close, no `[DONE]` → keep-alive, clean end), coupled with F-40's re-capture item **(h)**. Runs at the next manual smoke-drive session. See §L Phase-9. |

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

### Phase 10 (close-out folding) — 2026-07-17 — branch fix/audit-2026-07-16-p9 (on p9 @ 886be68) @ this commit
- Gate: **4,271 passed / 49 skipped** (docs-only — unchanged from Phase 9) · typecheck clean ·
  build n/a (nothing under `apps/desktop/src` touched). One full-run flake seen once (the P7
  ledger's one-flake class): `engine-download.test.ts` F-33 "threads the job cancel into the
  extractor" failed `expect(sawSignal).toBeDefined()` after `waitForStatus('extracting')` under
  parallel load — passes 31/31 in isolation and the full re-run was clean **4,271/49**;
  unrelated to this phase's three edited `.md` files (docs cannot reach that code path).
  Hygiene: both edited repo docs (`docs/architecture.md`, `BUILD_STATE.md`) + this plan
  byte-verified LF, BOM-free, NUL-free; architecture.md sits inside the repo-hygiene walk and
  its net ran green.
- Fixed: no findings (close-out). **Step 1 verified:** every F-01…F-41 has a §L disposition,
  cross-checked against the report §3 id list (41/41; plus Q-1/Q-2 resolved and NF-1 fixed).
  **Step 2 done:** durable record folded into `docs/architecture.md` as **§50** (after §49,
  house template §46/§49): intro + method + gate history (4,217/49 → 4,271/49, +54, with the
  Phase-0 baseline correction), the working-papers git-show pointers (report via
  `git show 886be68:docs/audit-2026-07-16.md`, unchanged since kickoff 8bf0fc7; plan at this
  close-out commit), the §D owner-decisions batch as executed, the 41-row per-finding
  disposition table (F-39 recorded as investigated→KEEP+documented; F-40's re-capture and Q-2's
  smoke recorded as REGISTERED to §5 item 7 items (h)/(i)), the Q-1/Q-2/NF-1 block, the
  P4/P5/P6 independent-review outcomes + §N-a deviations, the clean-verdicts bullets (report §1
  + Appendix B highlights), the residuals/watch list, and the §-anchor legend. The
  architecture.md layout block updated (§24–§49 → §24–§50). **Step 3 PARTIAL by design:**
  BUILD_STATE §5 item 14 gained the Phase-10 close-out block but stays OPEN, and the CLAUDE.md
  doc-lifecycle sentence is NOT yet restored — that restore is coupled to the owner-confirmed
  paper deletion (step 4), which has not happened at this commit. Steps 4–6 (delete papers,
  stacked-chain PR + merge on green `ci-success` + the #59 comment, version tag) are owner
  actions, listed in the BUILD_STATE item.
- Deviations from plan: none beyond the deliberate step-3/4 split above (the plan's step 3
  wording bundles the CLAUDE.md restore with close-out; restoring it while this file still
  exists on disk would make CLAUDE.md false, so it rides the deletion commit).
- New findings: none.
- Messages to later phases: none — the wave's remaining work is the owner-action list in
  BUILD_STATE §5 item 14 (delete papers + CLAUDE.md restore · PR/merge + #59 comment · tag).
- Docs touched: `docs/architecture.md` (new §50 + layout block), `BUILD_STATE.md` (§5 item 14
  Phase-10 close-out block), this plan (Status line + this entry). BUILD_STATE entry added: yes.

### Phase 9 — 2026-07-17 — branch fix/audit-2026-07-16-p9 (stacked on p8 @ 70a52b2); commits F-40+F-41+ratchet @ 29427a4, docs+§Q+ledger @ this commit
- Gate: **4,271 passed / 49 skipped** (baseline entering P9 was 4,270/49; +1 = the new ratchet
  test; the five cast conversions retyped stubs only — no test added/removed, no assertion
  changed). `typecheck` clean (both `tsconfig.node.json` + `tsconfig.web.json`, `--composite false`).
  `build` **n/a** — test-only phase; nothing under `apps/desktop/src` touched (the CONTRIBUTING +
  BUILD_STATE edits don't count as src). Hygiene: every edited/new file LF, BOM-free, NUL-free
  (byte-verified).
- Fixed (in listed order):
  - **F-40** — corrected the stale `tests/unit/gpu.test.ts:16-24` comment: the `--list-devices`
    fixture was *captured on b9585*; the runtime pin is now b9849 (runtime-sources.yaml:34), and a
    b9849 re-capture is OWED. Removed the false "if an upstream release changes the device-line
    shape, this fixture-backed parse fails in CI" guarantee (it only holds if the capture tracks
    the pin, which it doesn't — M-A5 is observation-triggered), replacing it with the honest scope:
    the frozen b9585 capture reddens only if the PARSER regresses against the b9585 shape, and it
    points at the consolidated smoke checklist. NO fixture bytes or assertions moved — the full
    b9849 re-capture (and the moving `gpu.test.ts` freeMb / `vision-sse.test.ts` split-UTF-8
    assertions) rides the next manual smoke-drive session, registered below.
  - **F-41** — converted the five heaviest `as never` stub-cast files to typed payloads, so the
    outer `stubApi(...)` re-engages the `Partial<PreloadApi>` check (method-name + return-shape
    renames now redden typecheck). Real casts removed per file: `fileTranslateSession` 28→0,
    `ImagesScreen` 23→0, `TranslateScreen` 21→0, `AppLock` 12→0, `translateSession` 9→0. Technique:
    typed builders returning the real shared type (`translateJob`, `unavailable(reason)`,
    `appStatus`/`docTask` already existed) + `Partial<PreloadApi>`-typed `api` bags; for the handful
    of DELIBERATELY-partial or contract-violating payloads (a "keep the shell calm" AppStatus/
    PreflightResult, a preview-only DecodedImage without `bytes`, the L6b malformed-`translateStart`
    resolve) a NARROW named `as unknown as <Type>` at exactly that value (the HomeScreenPoll
    pattern), never a blanket `} as never)`. **New one-way ratchet** `tests/unit/as-never-ratchet.test.ts`
    counts real `as never` casts under tests/ (comments stripped so prose mentions don't inflate it)
    and fails if the count exceeds **BASELINE = 110** — TEETH shown red-green: planted a real cast
    → 111 > 110 red → removed → green.
  - **Real top-5 vs the audit's list (ledgered delta per the orchestrator note):** the audit's HEAD
    census named ImagesScreen 23 / translateSession 9 / TranslateScreen 7 / doctasksStore 7 / +1.
    Phases 4–8 shifted counts; the current grep-census top by raw count was fileTranslateSession 28,
    ImagesScreen 23, TranslateScreen 21, settings-write-gate 15, AppLock 12, translateSession 9,
    doctasksStore 8. **settings-write-gate (15) was EXCLUDED** — its `as never` are deliberate
    invalid-VALUE casts (`null as never`, `42 as never`) testing the write-gate's runtime rejection,
    NOT PreloadApi stub-payload erasure (the audit's own "triage separately" class), so converting
    them to typed builders is meaningless. Actual F-41-class top-5 converted: fileTranslateSession,
    ImagesScreen, TranslateScreen, AppLock, translateSession. doctasksStore (8) is the next candidate
    for the fix-when-touched sweep.
- Deviations from plan: none material. F-40's full re-capture is deferred-by-design to the smoke
  session (the plan scoped Phase 9 to the interim comment fix + registration); the F-41 top-5 list
  was re-derived by current grep count with the ledgered exclusion above.
- New findings: none (NF-* none). No new §Q items.
- **§Q sweep — table now EMPTY (all rows resolved/registered):**
  - **Q-1** — resolved in Phase 7 (verified; the #59 copy half, `docs.scan.ocrMissing` +
    `main.task.needsOcr` EN+DE remedy hint).
  - **Q-2** — **resolved-by-registration** here: folded into BUILD_STATE §5 item 7 TS-3 as the ONE
    consolidated smoke-session checklist — new item **(i)** "real-server mid-stream error-frame
    smoke (F-02 / Q-2)" (tiny ctx + context-shift disabled, `HILBERTRAUM_*`; reader rejects +
    friendly `main.chat.streamError`; the PARTIAL-frame `data: {"error":{"mess` + close, no `[DONE]`
    → keep-alive → clean end), coupled with F-40's re-capture item **(h)**. No scattered duplicate
    left in the living §5 text (the Phase-4 §L note and the `gpu.test.ts` comment point here; dated
    journal entries left byte-untouched).
- Messages to later phases:
  - **Phase 10:** durable §50 dispositions — F-40 comment-corrected + the b9849 re-capture registered
    to the smoke checklist (items (h)/(i)); F-41 five-file typed-stub conversion + the `as never`
    ratchet (baseline 110) as a new standing invariant; the CONTRIBUTING "type stub payloads" bullet.
    §Q closed empty. No parked GitHub-issue text owed from this phase.
- Docs touched: `apps/desktop/tests/unit/gpu.test.ts` (comment), the five converted test files, new
  `apps/desktop/tests/unit/as-never-ratchet.test.ts`, `CONTRIBUTING.md` (test-guidance bullet),
  `BUILD_STATE.md` (§5 item 7 TS-3 items (h)/(i) + item 14 Phase-9 line), this plan (§Q Q-2 + §L).
  BUILD_STATE entry added: yes.

### Phase 8 — 2026-07-17 — branch fix/audit-2026-07-16-p8 (stacked on p7 @ c47c50d); commits F-29 @ 314ce66, F-30 @ 11a556c, F-31 @ 150fd0c, F-35 @ 42e5d32, F-39 @ 306f7bb, F-12 @ 88dd8f5, NF-1 @ 7b90210, docs+ledger @ this commit
- Gate: **4,270 passed / 49 skipped** (baseline entering P8 was 4,267/49; +3 = F-29 memo test + F-30
  cache test + F-31 coalescing test; F-35/F-39/F-12/NF-1 modified existing tests). `typecheck` clean;
  `build` green (`apps/desktop/src` touched). Hygiene: every edited file LF, BOM-free, NUL-free.
- Fixed (in listed order; F-29/F-30/F-31 red-green-demonstrated):
  - **F-29** — the SUGGESTION path re-materialized the in-scope `indexed` title+MIME set on every
    debounced composer pause; with the default install's doc-signal skills (bank/invoice) the common
    Library scope is the expensive one (`resolveScope` returns the built-in library COLLECTION, so it is
    a membership scan, not literally unfiltered). Added a resident cache in `scope-signals`
    (WeakMap-per-Db, single entry) keyed by the resolved scope fingerprint + a cheap corpus signature —
    `(COUNT, MAX(rowid))` over `indexed` documents **and** over `document_collections` (so a membership
    move invalidates too) + `includeArchived`. Hit serves byte-identical signals; auto-fire
    (`explicitDocumentsOnly`) reads live. `documentsInScope` semantics untouched (audit caution). Probe
    `__suggestSignalMaterializations`: 5 pauses → 1 materialization, +1 on import.
  - **F-30** — `loadPolicy` now caches the merged `LoadedPolicy` per config dir keyed by
    `isDev | fileSig(policy.json) | fileSig(drive.json)` where `fileSig = mtimeMs:size` (or `absent`).
    A `stat` per call replaces the two `readFileSync+JSON.parse`; re-parse only on a signature change, so
    the download gate / developerLeniency still see a live policy tightening. `buildPolicyStatus`
    signature unchanged. Probe `__policyMaterializations`: 3 polls → 1 parse, +1 on a content edit.
  - **F-31** — `DocumentsScreen.watchJob` **and** `watchReindex` route completion refreshes through
    `makeRefreshCoalescer` (leading edge + trailing throttle, `REFRESH_THROTTLE_MS = 1500`,
    piggybacked on the 400 ms poll ticks — no nested timer). The terminal `job.done` refresh stays
    immediate. The FE-7 exact-call-count pins (`DocumentsScreen.test.tsx`) are PRESERVED (single
    mid-import transition → +1; done → +2) since they exercise one transition; a NEW test proves 3 rapid
    completions in one window → 1 refresh (old code: +3). architecture.md FE-7 note amended.
  - **F-35 ⟨D-B⟩** — the drive-READ probe reads the 8 MB file back from the OS page cache (RAM, ~100×
    inflated). Relabelled `diag.bench.driveRead` → "Drive read (cached)" (EN + DE); `driveWriteMbps`
    stays the honest headline. `buildWarnings` gates the slow-drive warning on the fsync-bound WRITE only
    (the `min(read,write)` never fired on the cached read leg) — code now matches the documented
    "write < SLOW_DRIVE_MBPS". Old persisted inflated values render sanely under the new label (no
    migration). DiagnosticsCopySave test asserts the "(cached)" label; benchmark.md + data-contracts.md
    updated.
  - **F-39 ⟨D-D⟩ — VERDICT: KEEP + document.** Investigated by rendering KaTeX: valid math emits many
    per-expression inline `style="height:…;vertical-align:…"` attributes (e.g. `x^2 + y^2` → **11**;
    `\sum_{i=0}^{n} i` → 7). Inline STYLE ATTRIBUTES have no nonce/hash escape hatch (CSP nonces cover
    only `<style>`/`<link>`; `'unsafe-hashes'` can't hash dynamic values), so dropping `'unsafe-inline'`
    would render all math with sizing/alignment blocked. Residual risk bounded: `script-src 'self'`
    blocks script injection, `connect-src`/`img-src` close exfiltration → only same-origin cosmetic CSS
    effects. The CSP string, `window-security.test.ts` pin, and the index.html/ocr.html meta tags are
    **UNCHANGED**; rationale added to the `buildCsp` header + security-model.md.
  - **F-12 ⟨D-C⟩** — image-history store/open/delete were ~60 MiB of SYNC fs+crypto+shred on the main
    thread per image (≤20 MiB cap), the store firing inside the `done` emitter. Ported `vision/history.ts`
    to `encryptFileAsync`/`decryptFileAsync` + `fs.promises` + a new `shredFileAsync` twin
    (`workspace-vault.ts`), all three functions async. `registerImagesIpc.ensureSession` is async and
    **awaited before `base.done`** so `sessionId` still rides the done event; REL-5 delete ordering
    (row-first, shred-after) preserved; sync `shredFile`/`encryptFile` retained for crash-lock / export /
    DB-lifecycle. **Measurement** (dev box, local SSD, 16 MiB encrypted store ×5, `monitorEventLoopDelay`
    res 1 ms with a 1 ms breather-tick): SYNC max **94.8 ms** / mean **22.4 ms** / 20 ticks;
    ASYNC max **24.1 ms** / mean **3.37 ms** / 198 ticks. A real USB-stick + encrypted-workspace run was
    **not reproducible on the dev box** (recorded honestly — the target USB medium's stall scales with
    `(2–3×size)/throughput`, so the win is proportionally larger there; no USB numbers fabricated).
- Deviations from plan: F-29's cache key needed `document_collections` in the signature (not just the
  documents `(COUNT,MAX)` the plan named) because the "whole-corpus" scope resolves to the built-in
  Library COLLECTION, so a membership-scoped query — the plain documents signature would miss membership
  moves. Still sits strictly above `documentsInScope` per the caution. F-12 forced the images-ipc + a
  vision-security test to wait on the streamed done EVENT instead of the job STATE (job state flips before
  the async persistence) — the sanctioned lockstep move, mirroring the renderer's real signal.
- New findings: **NF-1** (fixed here) — `tests/integration/vision-security.test.ts` was an UNLISTED
  pinning test in F-12's blast radius (asserted the `.enc` sidecar after `waitForTerminal`/job state,
  which now races the async temp-shred). Fixed by waiting for `STREAM.imgDone` before the disk check.
- Messages to later phases:
  - **Phase 9:** F-30 seam — `loadPolicy` now has a module-level cache + `__resetPolicyCache`/
    `__policyMaterializations` test hooks; if any Phase-9 test edits policy.json in-place expecting a
    re-read, it must change the file's size/mtime (same-mtime+same-size in-place edits are cache hits).
  - **Phase 10:** durable §50 dispositions — F-29 resident-cache-above-`documentsInScope`; F-30
    mtime/size policy cache; F-31 `makeRefreshCoalescer` throttle (amends FE-7); F-35 "(cached)" label +
    write-only slow-drive gate (D-B); F-39 KEEP-verdict with the KaTeX inline-style evidence (D-D); F-12
    async image-history + `shredFileAsync`, retiring the §35 PERF-1 sync carve-out (D-C); NF-1.
- Docs touched: `docs/architecture.md` (FE-7 amend, §35 PERF-1 dated supersede, image-understanding
  history paragraph), `docs/benchmark.md`, `docs/data-contracts.md`, `docs/security-model.md`,
  `apps/desktop/src/main/window-security.ts` header, `BUILD_STATE.md` (§5 item 14 Phase-8 line), this
  plan (§L). BUILD_STATE entry added: yes.

### Phase 7 — 2026-07-17 — branch fix/audit-2026-07-16-p7 (stacked on p6 @ 748fc06); commits F-25 @ bbefe6e, F-26 @ ad1a176, F-28 @ 4a29e6f, F-36/F-38 @ 397a7fc, Q-1 @ ed69824, docs+ledger @ this commit
- Gate: **4,267 passed / 49 skipped** · typecheck clean · build green (`apps/desktop/src` touched).
  Baseline entering P7 was 4,265/49 (P6 + its review fix-up); +2 = 1 F-25 stop()-purge detach case
  (translate-ipc.test.ts) + 1 F-26 L6a busy-guard case (visionSession.test.ts); F-28/F-36/F-38/Q-1
  added no unit tests (typecheck-only / dev-harness / copy). One full-run flake seen once
  (`workspace-vault-durability.test.ts` threw in an encrypted-vault `openDatabase`→`seedCollections`
  under parallel load — passes in isolation, unrelated to any P7 file; a re-run was clean 4,267/49).
  Hygiene: every edited file LF, BOM-free, NUL-free (repo-hygiene net green in the full run; the DE
  `„…“` guillemets are pre-existing catalog convention, not new bytes).
- Fixed (in listed order):
  - **F-25** (`bbefe6e`) — `TranslateJobService.stop()` (the workspace-lock + quit purge) is a THIRD
    stream terminal the FA-1/F-4 detach missed: it aborts + clears the job map but emits neither
    trDone nor trError, and a lock does NOT destroy the window (App swaps the React shell in place),
    so each lock-during-in-flight text translation leaked one `destroyed` once-listener + one
    `detachers` entry (MaxListenersExceededWarning at ~11). Added `onStop(listener)` to the service
    (a purge-observer set fired at the end of `stop()`); `registerTranslateIpc` subscribes and runs
    every outstanding detach. Chose the purge-hook over routing-through-the-error-terminal (the
    audit's two options): a single observed terminal is cleaner than reconstructing per-job emitters,
    and lock/quit already call `stop()` (no new call site to remember — the exact class of bug F-25
    is). Characterization test watched RED first (listener count stayed 1 after `stop()`); green
    post-fix (back to 0). Annotated the architecture.md F-4 disposition record (design record, not a
    §46–§49 ledger).
  - **F-26** (`ad1a176`) — `visionSession.analyze` guard was `if (snapshot.activeJobId) return 'busy'`,
    but `activeJobId` isn't set until AFTER the `imageAnalyze` create round-trip; a second analyze in
    that window slipped through, main busy-rejected it, and its busy branch's `set({ analyzing:false })`
    clobbered the still-live first job's flag (re-enabling composer/drop-zone mid-stream, where a
    dropped image cancels the live analyze). Ported translateSession's L6a guard verbatim:
    `activeJobId || analyzing`. Store test (mirrors the translate L6a case) watched RED (second
    returned 'started', analyzing went false); green post-fix (second 'busy', analyzing stays true).
    The existing F8 superseded-teardown test still passes (its `selectImage` resets `analyzing:false`
    before the second analyze, as the audit noted).
  - **F-28** (`4a29e6f`) — preload `listDocuments` filter `smart` retyped from
    `'generated'|'archived'|'all'` to the shared `SmartListView` (imported); main's
    `DocumentListFilter` already accepts the full ten-member set (`filterDocuments` implements
    'recent' + `matchesSmartView` the rest), so the bridge no longer forbids values main supports.
    Also deleted `ChatOptions.useDocuments` — a pre-askDocuments relic with zero references repo-wide
    (grep-confirmed; no wire-shape change, the field was never sent). Type-only; `npm run typecheck`
    is the gate (clean). `docs/architecture.md:3358` already stated `smart?: SmartListView`, so the
    fix aligns code with docs (no doc edit needed).
  - **F-36** (`397a7fc`) — the marketing `getSettings` override forces `workspaceMode:'encrypted'`
    (PrivacyTab's encrypted card) but `getWorkspaceState` unconditionally returned `plaintext_dev`,
    and App gates the rail's Lock-now control on `workspace.mode==='encrypted'` — so every shell shot
    staged an impossible posture (encrypted card, no Lock-now button). Made the override case-aware
    (mirrors `getSettings`): `isMkt()` → `{ state:'unlocked', mode:'encrypted', plaintextAllowed:false,
    encryptionRequired:true }`, component cases keep the plaintext_dev base. Captures re-run + eyeballed
    (documents, privacy, salary dark+light, privacy-de): Lock-now now present in all shell shots, the
    privacy card is still encrypted, and the walker reaches every goal (the extra rail button doesn't
    shift matched labels).
  - **F-38** (`397a7fc`, same commit as F-36 — same file, verified together via the one capture re-run)
    — `body[data-marketing-ready]` was sticky: StagedShell `clearInterval`'d on success, making its own
    flag-delete unreachable, so a late settings-driven remount after readiness yielded a silently-wrong
    (reset-shell) capture. Took the audit's fix option (a) (fully local to StagedShell, no shared
    `screenshot.mjs`/waitReady change): keep observing after readiness (no clearInterval); a vanished
    goal now clears the flag and re-walks so waitReady re-blocks; the tries-cap give-up path now prints
    an actionable `console.warn`. Verified manually: an 800 ms `getSettings` settle-delay still captures
    the staged transcript, and a temporary low tries-cap (20) + bogus goal made the give-up print
    `[marketing] goal "…" never stabilized after 21 ticks — capture may be wrong` (both temp probes
    reverted; diff confirmed clean).
- **Q-1 (#59 copy half) — resolved** (`ed69824`): the scanned-PDF OCR dead-ends `docs.scan.ocrMissing`
  (renderer copy) and `main.task.needsOcr` (thrown-localized, dynamically exact-matched via
  `isFriendlyTaskError` against both catalogs) gained an actionable EN+DE remedy: re-run the drive setup
  with `--with-assets`, or fetch only the OCR family with `fetch-runtime --family ocr`. Offline-safe
  (names local scripts, no URLs — the packaging-doc keying the plan asked for). `main.ingest.imageNeedsOcr`
  (the photo path) is persist-canonical (`documents.error_message`) so LEFT byte-stable — changing its
  canonical English would strand legacy German rows without a legacy matcher, over-engineering for a
  hint; its identical remedy is now covered by the docs cross-ref. These two are exactly the §Q line refs
  (488 → docs.scan region, ~1811 → main.task region). Display-map round-trip + copy-tone + i18n tests
  green. §Q table marked resolved.
- Deviations from plan: none material. F-36 and F-38 share one file (preview.tsx) and one verification
  (the capture re-run), so they landed in one commit referencing both rather than one-per-finding — the
  blast radii are identical (dev-harness marketing captures). F-38 used fix option (a), so
  `scripts/screenshot.mjs` was untouched (the plan offered a-or-b).
- New findings: none (NF-* none). No new §Q items. Q-1 (the only §Q item assigned to P7) resolved above.
- Messages to later phases:
  - **Phase 10 — issue #59 comment now covers BOTH halves** (post verbatim after the wave merges to a
    pushed sha; supersedes/extends the Phase-3 parked text, which covered only the provisioning half):
    > Fixed both halves of #59 in the audit-2026-07-16 remediation wave.
    > **Provisioning (Phase 3):** `prepare-drive --with-assets` now fetches the `ocr` family (deu/eng
    > traineddata) in BOTH the `.ps1` and `.sh` siblings, so every DIY-built drive ships with
    > scanned-PDF/photo OCR working out of the box — previously only commercially-built drives got it.
    > A parity test (`prepare-drive-default-set.test.ts`) pins that both shells fetch it. Existing DIY
    > drives can be topped up with one command: `scripts/fetch-runtime.sh --target <drive> --family ocr`
    > (or `.ps1 -Family ocr`).
    > **In-app copy (Phase 7):** the scanned-PDF "Make searchable (OCR)" dead-end and the OCR-task
    > failure now tell the user how to get the files when they're missing — an EN+DE hint pointing at
    > `prepare-drive --with-assets` / `fetch-runtime --family ocr` (offline, no URLs). The User Guide and
    > Troubleshooting docs gained the same cross-ref. Closing as fully resolved.
  - **Phase 10:** durable dispositions for §50 — F-25's purge-hook (`onStop`) as the third-terminal
    seam; F-26 as the vision L6a port; F-36/F-38 as the marketing-capture truthfulness fixes; Q-1's
    persist-canonical scoping (why `imageNeedsOcr` was left byte-stable).
- Docs touched: `docs/architecture.md` (F-4 disposition record — F-25 addendum), `docs/user-guide.md`
  (§7 scanned-PDF how-to-get-OCR cross-ref), `docs/troubleshooting.md` (OCR-missing remedy paragraph),
  `BUILD_STATE.md` (§5 item 14 Phase-7 line), this plan (§Q Q-1 resolved + §L). BUILD_STATE entry
  added: yes.

### Phase 6 — 2026-07-17 — branch fix/audit-2026-07-16-p6 (stacked on p5 @ f59359c); commits F-11 @ facacad, F-22 @ c5297f9, F-24 @ e3a2ef2, F-23 @ 750860d, F-15 @ 5677f90 (+ typecheck fixup 18796f9), F-10 @ 9fb73cb, docs+ledger @ this commit
- Gate: **4,264 passed / 49 skipped** · typecheck clean · build green (`apps/desktop/src` touched).
  Baseline entering P6 was 4,248/49 (P5 + its review fix-up); +16 = 3 F-11 self-closing-`<w:t/>`
  cases (docx-rewrite.test.ts), 2 F-22 BOM round-trip cases (ingestion.test.ts), 3 F-24 surrogate/
  no-churn cases (chunker.test.ts), 3 F-23 empty-diff cases (diff.test.ts), 4 F-15 boundary cases
  (new citation-snippet-boundary.test.ts ×3 + whole-doc-analysis.test.ts ×1), 1 F-10 BOM'd-CSV
  re-import round-trip (ingestion.test.ts). Hygiene: every edited file LF, BOM-free, NUL-free (all
  BOM/lone-surrogate fixtures are constructed programmatically via `\uFEFF`/`\uD83D…` escapes — no
  bytes committed that the nets would fight).
- Fixed (in listed order, red-then-green demonstrated per finding; one commit per finding):
  - **F-11** (`facacad`) — `NODE_OR_PARA_RE` gained an explicit self-closing `<w:t(?:\s[^>]*)?\/>`
    alternative BEFORE the paired-tag one; `parseTextLayer` skips it as an EMPTY node (raw bytes
    survive verbatim — D77 byte-identity). Pre-fix the attribute-bearing self-closing form read as
    an OPENER and the lazy body swallowed all markup to the next `</w:t>`; a span overlapping the
    pseudo-node re-emitted that markup xmlEscape'd as visible text. RED first: text layer contained
    `</w:r><w:r>…` and the rewritten document.xml contained `&lt;w:` — both watched. Bare `<w:t/>`
    skip pinned as a regression case (passes pre- and post-fix, as the audit verified). Existing 6
    docx-rewrite tests + redaction/document-edit suites unchanged-green (no self-closing fixtures).
  - **F-22** (`c5297f9`) — one-line `replace(/^\uFEFF/, '')` after readFile in BOTH MarkdownParser
    and TxtParser. Round-trip proof: a transcript-shaped export built with the REAL `bomFor('…md')`
    prefix re-imports with section labels `['My Chat', 'Sub']` (was `[null, 'Sub']` pre-fix — the
    watched red); TxtParser BOM-strip case also red-first. ingestion.test.ts now mocks electron
    (bomFor's module imports it) — inert for the rest of the file.
  - **F-24** (`e3a2ef2`) — `atomize`'s over-long-word slice loop now RETRACTS the cut one code unit
    when it lands between a high/low surrogate (EXTENDS only in the degenerate sliceChars=1 case
    where retracting would empty the piece — a 2-unit pair is ≤1 approx token, still window-safe).
    Retract-not-extend is deliberate: a shorter piece can only cost fewer tokens, so the "window
    never over budget" guarantee is preserved (an extended sliceChars+1 piece could exceed the cap
    by one token when overlap=0). Boundary-only: BMP text hits byte-identical cut positions —
    chunk-count no-churn pinned in-file with PRE-FIX-computed counts (CJK 500/0 → 12, prose
    defaults → 3, CJK 500/80 → 3, glued Latin 500/80 → 2, Thai+prose defaults → 5). RED first:
    3001-unit glued-emoji run at defaults had lone surrogates at both chunk edges (the audit's
    exact repro); overlap-0 astral partition stays lossless (join === original). No migration —
    existing corpora re-chunk only on re-index (documented; known-limitations L10 clause updated).
  - **F-23** (`750860d`) — `wordDiff` early-returns an identical/empty DiffResult when BOTH token
    arrays are empty (chose the plan's early-return over resizing the Int32Array — it also states
    the contract). RED first: `('','')` and `('   ','\n')` returned null. Empty-vs-nonempty
    pure-insert/delete pinned as a regression guard. Latent-only today (both compare entry points
    gate on non-empty text, per the audit's verified reachability).
  - **F-15** (`5677f90` + fixup `18796f9`) — NEW leaf module `services/text.ts`
    (`codePointSlice` + `truncateByCodePoints`). Chose "shared codePointSlice" over "import rag's
    truncateSnippet" because rag/index.ts imports analysis/coverage → coverage importing rag would
    cycle. Both persisting sites (`coverage.ts` documentLeafProvenance, `common.ts`
    chunksToCitations) now cut at 280 CODE POINTS; cosmetic `compare.ts` oneLine uses
    codePointSlice(…, 400) (no ellipsis, matching its old shape); rag's `truncateSnippet` now
    delegates to codePointSlice with its trim/trimEnd shape byte-identical (RAG-2 pin green
    untouched). The P-6 `substr(text,1,281)` SQL stays: SQLite substr counts code points and the
    JS guard now does too, so the 281st-char sentinel still fires — proven against REAL
    node:sqlite in the new test (562-unit/281-cp head → truncates pair-safe). RED first at both
    persisting sites. Fixup commit: the new tests needed `?? ''` narrowing for the optional
    `Citation.snippet` (typecheck-only; vitest was green either way).
  - **F-10** (`9fb73cb`, per §D **D-A**) — `bomFor` covers `.csv`; `registerSkillsIpc.saveTextFile`
    prepends `bomFor(chosenPath)` (tableToCsv stays pure). Side effect the audit flagged as
    adjacent inconsistency, taken deliberately: `redacted.txt`/`edited.txt` (same boundary) now get
    the P4-mandated `.txt` BOM; JSON/XML/log stay BOM-free. BOTH no-BOM pins flipped WITH the fix
    in the same commit (save-export-bom.test.ts, result-tables.test.ts — the flips are the
    owner-decided D-A posture change, NOT assertion weakening) and the BOM'd-CSV re-import
    round-trip added (papaparse strips the BOM — proven through the real CsvParser). All flips +
    the round-trip watched RED pre-fix. Blast-radius docs moved in-commit: architecture.md
    result-tables record ("no BOM on .csv" → dated flip) + P4 record (dated supersede-in-part
    annotation).
- Deviations from plan (§N-a, both small + in-phase, ledgered):
  - **F-10 third pin.** The audit's blast radius claimed save-export-bom.test.ts:28 +
    result-tables.test.ts:144 were "the only two BOM pins in the tree; skill-lane export tests
    assert audit/content, not leading bytes" — but `skills-tool-run-ipc.test.ts:968`'s ANCHORED
    `/^date,…/` header regex on a CSV written through the real saveTextFile is a third, implicit
    no-BOM pin. Moved with the fix in the same commit (asserts BOM + header after it). Triage per
    §O step 3: same file family, same posture change, fully understood — no re-scope needed.
  - **F-15 test typecheck fixup** (`18796f9`): optional `Citation.snippet` narrowing in the two
    new test files, discovered at the typecheck gate. Assertion semantics unchanged.
- New findings: none (NF-* none). No §Q items were assigned to P6; none added.
- Messages to later phases:
  - **Phase 7 (renderer polish):** nothing re-scoped. FYI: `services/text.ts` (codePointSlice/
    truncateByCodePoints) now exists as the shared code-point cutting seam if any renderer copy
    needs it (it is main-side; do not import it in the renderer — mirror it if needed).
  - **Phase 9 (test-infra):** `tests/integration/ingestion.test.ts` now carries a `vi.mock('electron')`
    for bomFor's module — if the F-41 cast-conversion slice touches that file, keep the mock ABOVE
    the `import { bomFor }` line (vi.mock hoisting).
  - **Phase 10:** durable dispositions for §50 — the F-24 retract-not-extend rationale, the F-15
    leaf-module (cycle-avoidance) decision, the F-10 D-A execution incl. the redacted.txt/edited.txt
    BOM side effect + the third-pin deviation, and the known-limitations L10 narrowing.
- Docs touched: `docs/known-limitations.md` (L10 bullet narrowed with the F-24 clause; new
  "text/CSV exports carry a UTF-8 BOM" trade-off bullet covering F-10/D-A + the F-22 round-trip +
  the strict-consumer caveat), `docs/architecture.md` (result-tables record BOM clause flipped +
  P4 record supersede annotation — both in the F-10 commit; TA-wave L10 ledger line got a dated
  update annotation, text preserved), `BUILD_STATE.md` (§5 item 14 Phase-6 line), this plan (§L).
  BUILD_STATE entry added: yes.
- **Review note (2026-07-17, same branch; independent Phase-6 review verdict ACCEPT — no
  blockers/should-fixes; one nit, §N-recorded):** the F-24 EXTEND branch (`chunker.ts` atomize,
  `end = end + 1` — taken only when `sliceChars === 1` and retracting would empty the piece) had no
  test coverage: sliceChars = gcd(cap, overlap) is 20 for the production 500/80 config and = cap
  for overlap-0, so the branch needs a cap/overlap-COPRIME config plus a pair exactly at the cut.
  Resolved by ADDING the test (the reviewer's stronger option): `windowByTokens('😀'×30, 7, 3)`
  (gcd = 1 ⇒ every cut mid-pair ⇒ extend fires per piece) asserts every window is whole-emoji with
  no lone-surrogate edge. TEETH by mutation, per the reviewer's red-bar condition: flipping the
  branch to a plain retract hangs the slice loop (piece never advances) — the run errored with the
  fork killed after ~38 s, test never completing (the honest red); restored, chunker.ts
  byte-identical to the F-24 commit, 25/25 green. Suite count moves 4,264 → **4,265 / 49**.

### Phase 5 — 2026-07-17 — branch fix/audit-2026-07-16-p5 (stacked on p4 @ 0404ee6); commits F-13/F-34 @ eb50209, F-14 @ 7e55c6f, F-33 @ a7e61de, F-32 @ 9bc861b, docs+ledger @ this commit
- Gate: **4,247 passed / 49 skipped** · typecheck clean · build green (`apps/desktop/src` touched).
  Baseline entering P5 was 4,233/49 (entry 4); +14 = 3 F-13 complete-`.part`/416 cases, 1 F-34
  fsync wiring pin (new `download-fsync-durability.test.ts`), 2 F-14 vision M1 cases, 2 F-33
  extraction bound/concurrency cases, 5 F-32 per-family guard cases, 1 F-32 registry-partition
  case (sidecar.test.ts). Hygiene: every edited file LF, no BOM, no NUL (repo-hygiene net green in
  the full run). NOTE: `assets.test.ts`'s "committed runtime-sources.yaml" pins ENOENT-fail when
  that file is run in ISOLATION on this box (a cwd-relative read) — PRE-EXISTING, cwd-dependent,
  unrelated to this phase; they pass in the full `npm test` run (verified: 4247/49).
- Fixed (each red-then-green demonstrated; one commit per finding, F-33 isolated per plan):
  - **F-13** (commit `eb50209`, shared with F-34) — `runOne` no longer resumes a COMPLETE `.part`
    with an unsatisfiable `Range: bytes=<fullSize>-` (→ HTTP 416, which looped forever with no
    in-app remedy). A complete `.part` is now VERIFIED IN PLACE: reached by a pre-download
    short-circuit when `size_bytes` is known (`resumeFrom >= sizeBytes`, fetch never called) OR by
    a caught typed `RangeNotSatisfiableError` from `downloadToFile` when size is unknown. A match
    (or placeholder) renames into place; a mismatch discards the `.part` and restarts ONE clean
    download (`allowResume=false`, the ResumeOffsetMismatch treatment). Extracted a shared
    `finishVerifiedFile` (rename + checksum-cache prime) so the fresh-download and complete-part
    paths stay identical. RED first: all 3 cases failed pre-fix (`bytes=22-` sent / 416 thrown).
  - **F-34** (commit `eb50209`) — `downloadToFile` now fsyncs the `.part` to the DEVICE (open `r+`
    so Windows `FlushFileBuffers` succeeds; best-effort) before returning, so the caller's rename +
    `(size,mtime)` checksum-cache prime can't record a torn weight after a power cut/unplug. New
    `download-fsync-durability.test.ts` is a CODE-10 wiring pin (`vi.mock('node:fs')`) asserting the
    `.part` fsync precedes the rename — watched RED (no `.part` fsync) pre-fix.
  - **F-14** (commit `7e55c6f`) — ported TA-6 M1 verbatim: `VisionRuntime.ensureStarted` composes
    `LlamaServer` with an identity-compared `onUnexpectedExit` (`if (this.server === server)
    this.server = null`) so a healthy vision child dying on its own (OOM) drops the dead handle and
    the next `analyze()` cold-starts, instead of failing `runtimeFailed` for a full 120 s idle
    window while every retry re-arms the timer against the corpse. NO device-fallback twin (vision
    has no GPU/CPU ladder). Mirrored translation's two M1 cases; the crash→cold-start case watched
    RED pre-port (the identity/clobber case is a regression companion — passes either way, as in
    translation).
  - **F-33** (commit `a7e61de`, ISOLATED per plan) — `ExtractFn` gains an OPTIONAL `signal`;
    `extractWithTar` now has a 5-min deadline (`HILBERTRAUM_EXTRACT_DEADLINE_MS`-overridable) +
    SIGTERM→SIGKILL escalation (whisper REL-2) + abort handling, and `installOne` threads
    `controller.signal` through `install()` into the extractor. A `runSettled` latch makes
    `activeJob()`/`start()` treat a not-yet-settled `run()` as busy regardless of `job.status`,
    NARROWING the second-install-into-the-same-dir window to the ≤2 s SIGKILL grace (the extractor
    rejects after signalling the child, not after its exit — see the review fix-up block below;
    corrected from "closing"). Both new cases (signal reaches a
    signal-aware extract; a cancelled-but-unsettled run refuses a second start) watched RED.
    **Blast-radius deviation (smaller than the audit's estimate):** because `signal` is OPTIONAL,
    the ~12 injected 2-arg `extractImpl` sites AND `engine-extract-containment.test.ts` compile +
    pass UNCHANGED — no mechanical sweep of the injected sites was needed (a 3-arg-required
    signature would have forced it; optional is TS-assignable from a 2-arg fn and is the standard
    signal-threading shape). The real-tar deadline/escalation is verified by construction (mirrors
    the tested whisper pattern) — not unit-tested (would need a real wedged process); the injected
    signal path IS tested. Ledgered, not a scope change.
  - **F-32** (commit `9bc861b`) — the CODE-13 in-use guard covered only the chat runtime; widened
    per family. Partitioned the CODE-11 sidecar PID registry by `SidecarFamily`
    (`registerSidecarChild(pid, family)`; `registeredSidecarPids(family?)`; `killRegisteredSidecar
    Children` stays family-agnostic). `LlamaServer` registers `'llama_cpp'`, whisper-cli
    `'whisper_cpp'`. `StartEngineDownloadOptions` gains `llamaSidecarActive` + `whisperActive`; the
    guard refuses a `llama_cpp` install while chat OR any llama sidecar (embedder/reranker/vision/
    translation) is live, and a `whisper_cpp` install mid-transcription. `registerEngineIpc` exposes
    `llamaSidecarInUse()`/`whisperSidecarInUse()` (reading the registry) and passes both. Reused
    `main.engine.runtimeRunning` for the llama family; added an EN+DE `main.engine.transcription
    Running` pair (thrown-and-localized via `tMain`, session-only — same pattern as the sibling
    engine errors, no display-map). Both refusal cases watched RED (pre-fix `llamaSidecarActive:
    true`/`whisperActive: true` were ignored → install proceeded → fetch called). Updated the two
    existing `registerSidecarChild` test call sites to the 2-arg signature.
- Deviations from plan: only F-33's smaller blast radius (above) — the optional-signal choice made
  the ~12-site mechanical sweep unnecessary. No force-fits; no assertion weakened.
- New findings: none (NF-* none). No §Q items assigned to P5; none added.
- Messages to later phases:
  - **Phase 8 (F-30 caching, same IPC file family `registerEngineIpc.ts`):** F-32's guard shape
    matches the plan spec — no new activity getters on the services were needed. The final seam
    names Phase 8 will see in that file: `chatEngineInUse(runtime)` (unchanged), and the two NEW
    exported helpers `llamaSidecarInUse()` / `whisperSidecarInUse()` (both read
    `registeredSidecarPids(family)` from `runtime/sidecar.ts`). `StartEngineDownloadOptions` now
    carries `chatRuntimeActive` + `llamaSidecarActive` + `whisperActive`. The `downloadEngine`
    handler is unchanged in structure (just passes the two extra signals) — F-30's `loadPolicy`
    memo in the same file is untouched by any of this.
  - **Phase 10:** the durable per-finding dispositions above (esp. the F-33 optional-signal
    decision and F-32's registry-partition seam) fold into the §50 record.
- Docs touched: `docs/known-limitations.md` (downloader-edges: new complete-`.part`/416 recovery
  bullet + the F-34 fsync clause on the checksum-cache bullet), `docs/architecture.md`
  (Image-understanding §6 RUNTIME-4 living record: crash-recovery bullet for the F-14 vision port —
  additive, the dated TA-6 M1 row + §46–§49 ledgers untouched), `docs/packaging.md` (in-app
  engine-install record: extraction-bound + per-family-guard clauses), `BUILD_STATE.md` (§5 item 14
  Phase-5 line), this plan (§L). BUILD_STATE entry added: yes.
- **Review fix-up (2026-07-17, same branch @ the fix-up commit; independent Phase-5 review verdict
  FIX-UP NEEDED — 1 should-fix + 2 nits):**
  - **Should-fix (code):** the 416-CATCH-path invocation of `settleCompletePart` had no exception
    protection — a throw inside it (renameSync on an AV-interfered destination, an I/O fault out of
    the verify) escaped `runOne`, became an UNHANDLED REJECTION (`run()`/`start()` never catch),
    and stranded the job at non-terminal 'verifying' forever (no error copy; never pruned). The
    try-path settle was already safe (its throws fall into the same catch). Fixed by wrapping the
    catch-path settle: any throw now lands the job in 'failed' with `friendlyDownloadError` + the
    audit hook, mirroring the generic failure handling. RED first: new downloads.test.ts case
    (verifyImpl ok → `.part` vanishes before the rename, the AV-quarantine stand-in) timed out at
    'verifying' WITH a recorded unhandled rejection pre-fix; green post-fix (job 'failed', friendly
    copy, nothing half-renamed). Note: the first red attempt used dest-as-directory, which trips
    PLANNING (`verifyChecksum` EISDIR in `start()`) instead of the settle — replaced with the
    injectable verifyImpl shape; the honest red is the second run.
  - **Nit 2 (honesty clause — DOCS chosen, no code change):** the F-33 "concurrent-install window
    closed" phrasing was inaccurate — `extractWithTar`'s stop path rejects after SIGNALLING the
    child (arming the 2 s SIGKILL grace), not after its exit, so `run()` settles and a retry's
    pre-clean can interleave with the dying tar for up to ~2 s (longer if tar is wedged in
    uninterruptible I/O). Corrected to "narrowed to the ≤2 s kill grace (accepted residual)" in
    `packaging.md`, the BUILD_STATE Phase-5 line, and the F-33 bullet above. Deliberately NOT
    changed in code: rejecting only after the child's exit would reintroduce the unbounded wait
    F-33 removes for an unkillable child.
  - **Nit 3 (doc drift — DONE):** the audit F-13 blast radius named `model-policy.md` (~:276) and
    `data-contracts.md` (~:510) resume-contract sentences; both now carry the one-sentence
    complete-`.part` verify-in-place mention alongside the still-true partial-resume contract.

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
      failure path; benchmark.ts benign. Skills JSON-schema flows (reviewer correction): the
      pre-fix behavior was NOT "already failed visibly" everywhere — in
      `services/skills/categorizer.ts:308-316` a mid-stream error frame produced an unparseable
      truncated reply → one retry → the batch dropped HONESTLY to Uncategorized and the analysis
      COMPLETED. Post-fix a `ChatStreamError` propagates out of `streamBatchReply` (no catch in
      the loop) and fails the whole analysis turn via `withChatStream`'s friendly mapping — a
      real, sane, propagate-consistent behavior change in the categorizer/enricher/locate flows
      (fail-the-turn beats a degraded-but-complete answer built on a mid-generation server
      failure). Deliberately not test-pinned: these flows are computed-then-persisted (no half
      state to assert against) and the surfaced error is already covered by the friendly-mapping
      pin in `chat-stream.test.ts`.
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
