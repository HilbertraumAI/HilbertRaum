# Whole-document analysis truncation — fix plan

**Status:** OPEN (working paper). **Phase 1 IMPLEMENTED (2026-07-04)** — see §3; Phases 2–4 remain
open. Fold into `docs/architecture.md` §19/§20 (skill-whole-doc engine) + `docs/rag-design.md` as a
§-numbered design record when fully implemented, then delete this file (CLAUDE.md doc-lifecycle rule).

**Owner-approved decisions (2026-07-04):** (1) close the gap band with an *on-the-fly map-reduce
over the raw chunks* — no waiting for a background tree; (2) commit each phase directly to `master`
per the per-phase ritual (tests + docs + BUILD_STATE); (3) stage explicit files only (concurrent
sessions share the tree — never `git add -A`).

---

## 1. Diagnosis (what the test conversation exposed)

A `contract-brief` (`analysis: whole-doc`) turn over a multi-page PDF hit **two independent
truncations**, both visible in the UI:

1. **Input truncation** — badge *"Covers the beginning of the document" + "…3 sections"*
   (`coverage.capped.beginning`). Only the first 3 chunks (~1.5 pages) reached the model.
2. **Output truncation** — badge *"Answer truncated — model context limit reached"*
   (`finishReason === 'length'`). The brief was cut off mid-sentence.

### Root cause #1 — the "gap band" (why only the beginning)

The deep-index **tree** map-reduce (`answerWholeDocFromTree`, [whole-doc-tree.ts][wdt]) is the
designed rescue for an over-budget whole-doc read — but it returns `null` unless the document has a
`ready` tree, and the tree **auto-builds far too late**. At the default 4096 context:

| Boundary | Source | Fires at |
| :--- | :--- | :--- |
| Single-turn whole-doc read truncates | `wholeDocumentFitBudgetTokens` ([rag/index.ts][rag] ~L1264) | **~1.5 pages** (~1 000 words) |
| Deep-index tree auto-builds | `planSummaryWindows().truncated`, >12 windows ([manager.ts][mgr] ~L176) | **~50 pages** (~30 000 words) |

Every document **between ~1.5 and ~50 pages** truncates to the beginning *and* never gets a tree —
the rescue is structurally unreachable. That is essentially every real contract. The screenshot's
`capped` badge (no *"it was too large"* tree suffix) confirms no tree existed.

### Root cause #2 — output reserve too small for a long deliverable

Generation reserves only `CHAT_RESPONSE_RESERVE_TOKENS = 1024` output tokens ([chat.ts][chat] L973)
and passes no `maxTokens` cap, so a 9-section brief (~2 000+ tokens) runs into `n_ctx` and is
stamped `truncated` ([rag/index.ts][rag] ~L1542). **This persists even after fixing #1** — the tree
and chunk map-reduce reduce steps use the same 1024 reserve.

### The underlying tension

At a small `n_ctx` you cannot both stuff a multi-page document **and** emit a long structured
deliverable in one call. The correct answer is map-reduce (bounded input windows), gated today
behind a tree that never builds for mid-size docs. Fixing coverage without fixing the reduce
budget just moves the cut.

[wdt]: ../apps/desktop/src/main/services/skills/analysis/whole-doc-tree.ts
[rag]: ../apps/desktop/src/main/services/rag/index.ts
[mgr]: ../apps/desktop/src/main/services/doctasks/manager.ts
[chat]: ../apps/desktop/src/main/services/chat.ts
[reg]: ../apps/desktop/src/main/ipc/registerRagIpc.ts
[cov]: ../apps/desktop/src/main/services/analysis/coverage.ts
[meter]: ../apps/desktop/src/renderer/components/CoverageMeter.tsx

---

## 2. Invariants to preserve (the "do not break" list)

Every phase MUST keep these true — the review and tests check them:

- **SEC-1 / capability ceiling.** No new DB/FS/network handle. Map-reduce = pure DB reads + the
  chat runtime, exactly like the tree path.
- **Fence at every step.** The SKILL.md fence rides in *every* map and reduce USER turn (§11.2/§14
  prompt-injection guard), never in the system prompt.
- **Coverage honesty (C1/L2).** `truncated:false` is claimed ONLY when the whole document was
  actually processed. A map-call-ceiling cut or a notes hard-truncation ⇒ `truncated:true`.
- **Provenance (M2).** `[Sn]` citations are real leaf **chunks** only — never node summaries.
- **Needle downgrade unchanged.** Single-fact lookups still downgrade to top-k *before* the
  whole-doc branch ([reg] ~L367) — map-reduce cost is paid only for deliverables.
- **Abort/Stop contract.** Once a model call is made the path returns a `Message` (partial on Stop,
  `emptyAssistantMessage` on Stop-before-first-token) — a cancel never triggers a second pass.
- **No `n_ctx` overflow.** `promptTokens + outputCap ≤ n_ctx` must hold at every context size
  (regression: the HTTP 400 "exceeds context size" the 1.5 safety divisor was added to prevent).
- **Relevance path byte-unchanged.** Only the whole-doc branch changes.

---

## 3. Phase 1 — Whole-document input coverage via chunk map-reduce ✅ IMPLEMENTED (2026-07-04)

**Goal:** an over-budget whole-doc analysis with **no tree** reaches the *whole* document via a
map-reduce over its raw chunks, stamping honest whole-document coverage — no beginning-only read.

**As built:** `streamWholeDocMapReduce(input)` (the shared map-reduce core) was extracted from
`answerWholeDocFromTree` in [whole-doc-tree.ts][wdt] — the tree path is a thin gate that calls it with
`coverageMode:'tree'` (behavior byte-identical, pinned by `rag-whole-doc-tree.test.ts`). New
`answerWholeDocFromChunks(deps)` in [rag/index.ts][rag] reads ALL de-overlapped chunks via the new
private `readWholeDocumentChunkTexts` (also now the single de-overlap home for `retrieveWholeDocument`),
packs windows, and calls the core with `coverageMode:'capped'`, honest `truncated:false` whole-doc
coverage, representative leaf-chunk citations (≤ `SUMMARY_MAP_CALL_CEILING`, M2), and the share-safe
`extraReduceBlock` (`buildShareSafeScanBlock(scan, false)`). Wired as `viaTree ?? viaChunks ?? (capped
floor)` in the `opts.wholeDocument` branch. Tests: new `rag-whole-doc-mapreduce.test.ts`; re-pointed the
old beginning-only defect assertions in `rag-whole-doc-truncation.test.ts` + `rag-whole-doc-skill.test.ts`.
The reduce output reserve is UNCHANGED (`CHAT_RESPONSE_RESERVE_TOKENS`) — that is Phase 2.

### Files
- `apps/desktop/src/main/services/skills/analysis/whole-doc-tree.ts` — extract the shared core.
- `apps/desktop/src/main/services/rag/index.ts` — new `answerWholeDocFromChunks` + wiring.
- `apps/desktop/tests/integration/rag-whole-doc-mapreduce.test.ts` — new.
- `apps/desktop/tests/integration/rag-whole-doc-truncation.test.ts` — **behavior-changing update**.

### Changes
1. **Extract `streamWholeDocMapReduce(input)`** from `answerWholeDocFromTree` (the body from the
   fence build through persist, current [wdt] L148–258). Signature:
   ```ts
   interface WholeDocMapReduceInput {
     db; runtime; conversationId; documentId; question; skill; contextTokens; signal;
     onToken?; answerPrefix?;
     sourceTexts: string[]          // node summaries (tree) OR de-overlapped chunk texts
     citations: Citation[]          // provenance for THIS source (leaf chunks — M2)
     chunksCovered: number; chunksTotal: number
     coverageMode: 'tree' | 'capped'
     treeLevels?: number            // tree only
     extraReduceBlock?: string      // e.g. share-safe scan block (see step 4)
   }
   ```
   The core computes `truncated` (ceiling cut and/or notes truncation) and stamps:
   ```ts
   coverage = coverageMode === 'tree'
     ? { mode:'tree', treeStatus:'ready', chunksCovered, chunksTotal, treeLevels, truncated }
     : { mode:'capped', chunksCovered, chunksTotal, truncated }
   ```
   `answerWholeDocFromTree` keeps its pre-model gate (ready tree + level-1 node summaries) then
   calls the core with `coverageMode:'tree'`. **Behavior byte-identical for the tree path** — pin
   with the existing `rag-whole-doc-tree.test.ts`.

2. **New `answerWholeDocFromChunks(deps)`** in `rag/index.ts` (co-located with the private
   `sameSegment`/`deOverlapAgainstPrev` — avoids a circular import back into `whole-doc-tree.ts`).
   - Read ALL chunks `ORDER BY chunk_index` (not budget-capped), de-overlapped via the existing
     helpers, into `sourceTexts` (drop empty). Reuse the exact de-overlap loop from
     `retrieveWholeDocument` — factor it into a private `readWholeDocumentChunkTexts(db, id)` that
     both call, so de-overlap logic stays in one place.
   - `citations`: one representative citation per packed window boundary (bounded to
     ≤ `SUMMARY_MAP_CALL_CEILING`), real leaf chunks — never every chunk (noise).
   - `chunksCovered = chunksTotal = documentChunkCount(...)` (the whole document is the source).
   - Return `null` only when there are zero non-empty chunk texts (defensive; the caller then
     uses the capped floor).

3. **Wire** into the `opts.wholeDocument` branch ([rag] ~L1328), after the tree attempt:
   ```ts
   if (whole.truncated) {
     const viaTree = await answerWholeDocFromTree({...}); if (viaTree) return viaTree
     const viaChunks = await answerWholeDocFromChunks({...}); if (viaChunks) return viaChunks
   }
   // capped beginning-only remains ONLY as a last-resort floor (0 chunks / disabled)
   ```
   Order: fits-budget → single read (unchanged); ready tree → tree map-reduce (unchanged);
   **no tree → chunk map-reduce (NEW, whole-doc)**; beginning-only floor.

   *Note (no extra latency for the common small case):* `budgetWords` (summary window ≈ 2 500
   words) is LARGER than `wholeDocumentFitBudgetTokens` (~1 000 words). A doc between them packs
   into **one window** → the reduce runs directly over the whole document in a single streamed call,
   no map step. Only docs > one window incur map calls.

4. **Share-safe (`wholeDocumentPiiScan`) parity.** Compute `buildShareSafeScanBlock(scan,
   truncated=false)` in `answerWholeDocFromChunks` and pass it as `extraReduceBlock` so the
   whole-doc PII count + verdict gate survive the new path (chunk map-reduce gives non-truncated
   coverage ⇒ the low-risk verdict is legitimately allowed). Placed in the reduce USER turn, never
   system. (Also closes the documented tree-path residual in known-limitations §"share-safe".)

### Edge cases
- Empty/whitespace chunks filtered (parity with the tree path's node-summary filter).
- Stop mid-map / mid-reduce → core's existing try/catch (partial or empty message). No second pass.
- Degenerate single window → reduce-only over the whole doc, `truncated:false`.
- `truncated:true` only when windows > `SUMMARY_MAP_CALL_CEILING` (≥~50 pages) or notes hard-cut.

### Tests
- **New `rag-whole-doc-mapreduce.test.ts`** (mirror the truncation harness: ~11-page German doc,
  ctx 4096, NO tree):
  - coverage `mode:'capped', truncated:false`, `chunksCovered === chunksTotal`.
  - the runtime received **>1 model call** (map + reduce) — capture call count.
  - markers from the **whole** doc (first AND last `M####`) appear across the map inputs — proves
    whole-doc reach, not a prefix.
  - a small over-budget doc that packs into one window → exactly one (reduce) call, `truncated:false`.
  - Stop before first reduce token → `emptyAssistantMessage`, no capped second pass.
  - share-safe: `extraReduceBlock` present in the reduce user turn, absent from system.
- **Update `rag-whole-doc-truncation.test.ts`** — the `injects the in-prompt truncation notice…`
  case (L224–262) currently pins the no-tree ~11-page doc as `truncated:true` + "PARTIAL DOCUMENT".
  That *is* the defect. Re-point it to the map-reduce whole-doc assertions. The de-overlap unit
  tests in the same file stay valid (`retrieveWholeDocument` is unchanged and still used).

### Done criteria
- A multi-page contract with no tree analyses whole-doc; badge reads *"Covers the whole document"*.
- Tree path unchanged (existing tree tests green). `npm test` + `npm run typecheck` green; app launches.

---

## 4. Phase 2 — Complete the deliverable (safe, adaptive output reserve)

**Goal:** the reduce step emits as long a deliverable as the launched window *safely* allows,
without ever overflowing `n_ctx`. Removes the mid-sentence cut on any window ≥ ~6 k; shrinks it on
4 k. (The complete-at-any-size fix is optional Phase 4.)

### Why not just raise the reserve
At 4096 with a ~900-token fence, reserving 3072 output while notes fill ~3200 tokens ⇒ prompt +
output ≈ 7 300 > 4096 → **HTTP 400**. The reserve MUST be adaptive and the reduce notes budget MUST
be recomputed against it.

### Files
- `apps/desktop/src/main/services/chat.ts` — `ANALYSIS_RESPONSE_RESERVE_TOKENS = 3072` (+ doc).
- `apps/desktop/src/main/services/skills/analysis/whole-doc-tree.ts` — reduce budget math in the core.
- `apps/desktop/tests/unit/wholedoc-reduce-budget.test.ts` — new (pure budget math).

### Changes (in `streamWholeDocMapReduce`, reduce step only)
Compute, from the REAL launched `contextTokens`, fence tokens, and question tokens:
```ts
const CHROME = 128            // system + coverage line + labels
const MIN_NOTES = 512         // never starve the notes below this
const SAFETY = 1.3            // subword headroom (keeps prompt+cap under n_ctx)

const reduceOutputCap = clamp(
  ANALYSIS_RESPONSE_RESERVE_TOKENS,               // desired
  CHAT_RESPONSE_RESERVE_TOKENS,                   // floor (never worse than today)
  contextTokens - fenceTokens - questionTokens - CHROME - MIN_NOTES  // ceiling
)
const reduceNotesBudget = Math.max(
  MIN_NOTES,
  Math.floor((contextTokens - reduceOutputCap - fenceTokens - questionTokens - CHROME) / SAFETY)
)
// notes truncated to reduceNotesBudget (was: budgetWords); reduce streamed with maxTokens: reduceOutputCap
```
Guarantee: `prompt + reduceOutputCap ≤ contextTokens` at every size (worked example: 4096 → cap
≈ 2 476, notes ≈ 512, fits exactly; 8192 → cap 3072, notes ≈ 3 086). The `maxTokens` cap means a
cut is now a deliberate cap, not an `n_ctx` crash.

The MAP step is unchanged (`SUMMARY_OUTPUT_TOKENS = 512` — notes, not deliverable).

### Coupling note (deliberately NOT changed in this phase)
`wholeDocumentFitBudgetTokens` (single-turn input budget + needle-downgrade boundary) stays as-is,
so the truncation/needle decision boundaries don't shift. The single-turn capped path's output
(small docs that fit) keeps `CHAT_RESPONSE_RESERVE_TOKENS`; its residual output-cut is minor
(small doc ⇒ ample room) and, if needed, is resolved by Phase 4, not by widening a shared budget.

### Tests
- Pure math: at ctx ∈ {2048, 4096, 8192, 32768} assert `prompt + reduceOutputCap ≤ ctx`,
  `reduceNotesBudget ≥ MIN_NOTES`, `reduceOutputCap ≥ CHAT_RESPONSE_RESERVE_TOKENS`,
  `reduceOutputCap ≤ ANALYSIS_RESPONSE_RESERVE_TOKENS`.
- Integration: a reduce that would emit a long answer at ctx 8192 is NOT stamped `truncated` when
  it fits the cap; at ctx 4096 the honest badge still appears for a genuinely over-cap answer.

### Done criteria
No `n_ctx` overflow at any context; typical briefs complete on ≥8 k windows; `npm test` green.

---

## 5. Phase 3 — Progress affordance (perceived-latency UX)

**Goal:** the silent map calls before the first streamed token must not read as a hang.

### Files
- `apps/desktop/src/main/ipc/registerRagIpc.ts` (or the whole-doc branch in `rag/index.ts`) — fire
  the existing ephemeral notice `sendCompaction('analysis')` before the map loop (same channel the
  exhaustive path already uses, [reg] ~L464; cleared on the first answer token).
- `apps/desktop/src/shared/i18n/{en,de}.ts` — copy: EN *"Analysing the whole document, section by
  section…"* / DE *"Das ganze Dokument wird abschnittweise analysiert…"* (avoid the forbidden
  UI words chunk/tree/embedding).

### Tests / done
- Renderer: the notice shows during a multi-call whole-doc turn and clears on first token
  (mirror the existing compaction-notice renderer test). German smoke covers the DE string.

---

## 6. Phase 4 — (OPTIONAL) continue-generation for complete deliverables at small `n_ctx`

**Only if the owner wants zero output truncation even on 4 k models.** Phase 2 caps output to fit;
on a 4 k window a very long brief is still cut (honestly badged). Continue-generation removes the
ceiling.

**Approach:** when the reduce stream ends with `finishReason === 'length'`, re-prompt with the same
system + fence + notes + question plus *"Continue exactly from where you left off; do not repeat"*
and the last ~200 chars as an anchor; append, de-duplicating the seam overlap; cap at 2 extra
continuations. Applies to both the map-reduce reduce and (optionally) the single-turn grounded path.

**Risks to test:** seam duplication, drift, runaway loops. Tests: seam-overlap dedup, hard
continuation cap, Stop mid-continuation, no duplication when the first pass already finished.

**Recommendation:** ship Phases 1–3 first (they fix the reported UX); schedule Phase 4 only if
4 k-window truncation is still observed in practice.

---

## 7. Cross-cutting

### Docs to fold on close (per doc-lifecycle rule)
- `docs/architecture.md` §19/§20 — add the chunk map-reduce as the no-tree over-budget whole-doc
  engine; the adaptive reduce budget; the progress notice. Keep §-anchors stable.
- `docs/rag-design.md` — the coverage-stamp semantics for chunk map-reduce (`capped/untruncated`
  = whole-doc via map-reduce, already the meter's meaning — [meter] L45, [cov] L211).
- `docs/known-limitations.md` — the gap band is CLOSED; new residuals: (a) ≥~50-page tail still
  beginning-only (map-call ceiling); (b) 2–12 model calls of latency on mid-size analysis;
  (c) 4 k-window output cut remains until Phase 4.
- `BUILD_STATE.md` — status, data contracts (coverage stamp), next actions, risks, per phase.

### Commit plan (direct to `master`, one commit per phase, explicit staging)
1. `feat(rag): whole-doc chunk map-reduce closes the mid-size gap band (Phase 1)`
2. `fix(rag): adaptive reduce output reserve — no n_ctx overflow (Phase 2)`
3. `feat(ui): whole-doc analysis progress notice (Phase 3)`
4. *(optional)* `feat(rag): continue-generation for over-cap deliverables (Phase 4)`
Then a docs-fold commit retiring this plan file.

### Risk / rollback
- Each phase is independently revertable; Phase 1 is the load-bearing behavior change (revert = the
  old capped-beginning fallback, still honest). Phase 2 is pure budget math behind constants.
- Highest-risk item: the map-reduce/chunk-reader **de-overlap reuse** and the **reduce budget**
  ceiling. Both are pinned by dedicated tests above; the `prompt + cap ≤ n_ctx` assertion is the
  regression guard against the HTTP 400 class.
