# Code-review prompt — whole-document-analysis wave (Phases 1–4)

> Scratch/working doc for the post-merge code review of the whole-document-analysis feature
> (merge commit `f3ae4e4` on `master`). Not a design record — delete once the review is done.
> The feature's design record lives in [`rag-design.md`](rag-design.md) §14.

## Scope

Review the full wave diff: `git diff 6c27cef master` (10 commits, range `6c27cef..f3ae4e4`).
Weight **Phase 4** most heavily (least prior review); Phases 1–3 had per-phase reviews, so for
them focus on integration seams and anything the merge surfaces.

## Prompt (copy-paste)

You are reviewing the whole-document-analysis feature just merged to `master` (merge commit
`f3ae4e4`). Review the full wave diff: `git diff 6c27cef master` (10 commits, `6c27cef..f3ae4e4`).
Weight **Phase 4** most heavily (it has had the least prior review); Phases 1–3 had per-phase
reviews already, so for them focus on integration seams and anything the merge surfaces.

**What HilbertRaum is (hard constraints — treat violations as high severity):** an open-source,
fully **offline**, local-first knowledge workspace on a portable USB drive. No cloud, no telemetry,
no hosted AI APIs. All user data local, often in a whole-file-encrypted vault. Windows-first, weak
CPU-only laptops. **Exactly one local model job at a time.** Chat = a small GGUF via llama-server
(4k–8k ctx); the embedder is a **separate CPU sidecar process** (`--device none`), distinct from
chat. Storage = `node:sqlite` (one shared `DatabaseSync` connection across chat, doc-tasks, and the
import loop). Document summaries, node vectors, extraction records, and the content cache are
**content** — must never be logged or audited; audit events carry ids/kinds/counts only.

**Primary files:**
- Phase 4: `apps/desktop/src/main/services/analysis/node-vectors.ts` (new), `doctasks/compare.ts`
  (`alignNodes`, `compareNodePairPrompt`, `compareAsymmetricNotice`, `comparePairOutputCap`),
  `doctasks/manager.ts` (`runCompare`, `runCompareSymmetricTrees`, `bothTreesReadyForSymmetric`).
- Cross-cutting: `analysis/model-slot-arbiter.ts`, `analysis/tree-build.ts`, `analysis/extract.ts`,
  `analysis/coverage.ts`, `analysis/router.ts`, `analysis/listing-answer.ts`, `db.ts` (schema),
  `ingestion/index.ts` + `ingestion/chunker.ts` (cap honesty), and the IPC seams
  `ipc/chat-stream.ts`, `ipc/registerRagIpc.ts`, `ipc/registerDocTasksIpc.ts`,
  `ipc/registerWorkspaceIpc.ts`.

**Priority focus areas (check each explicitly):**

1. **Shared-connection transaction safety [H11].** `node-vectors.ts` `ensureNodeEmbeddings`
   introduces a `BEGIN/COMMIT` on the one `DatabaseSync` shared with the concurrent import loop.
   Confirm: every `await` (the `embedder.embed` call) happens **outside** `BEGIN`; the transaction
   body is synchronous; a thrown insert hits `ROLLBACK` so the connection is never left
   mid-transaction. Same pattern audit for `tree-build.ts` and `extract.ts`.

2. **One-model-job-at-a-time / the arbiter handshake [H9/H10].** Verify the lazy node-embed runs on
   the **embedder sidecar**, not the chat slot, and that it sits inside the non-yielding compare
   DocTask (so chat is already refused). For the yielding tree/extract builds, verify the chat↔build
   handoff (`acquireForChat`/`reacquire`/`release`, `assertChatStreamReady` async branch) can't let
   builder and chat call `chatStream` concurrently, and that cancel/lock/quit/model-switch **reject**
   the parked `reacquire` (no hung `await`). Look for a TOCTOU at the node boundary.

3. **Embedder-staleness, no silent mixed-align [H5].** In `ensureNodeEmbeddings`, confirm node
   vectors are scoped by `embedding_model_id`: a node under a different embedder is re-embedded under
   the active one, never aligned as-is; and a degenerate/empty node set falls back rather than
   aligning over nothing. Check the cache-reuse path (`summary_cache`) can't hand back a vector from
   the wrong embedder.

4. **Mirror symmetry [H8].** `alignNodes` must be mirror-symmetric: swapping A/B yields the same
   matched set with Only-A↔Only-B swapped. Stress the tie-break (the canonical pair key) — is it
   genuinely swap-invariant under tied cosine scores? Is the greedy mutual-best-match deterministic?

5. **Grounding honesty [M2/C1].** Node summaries are derived context — confirm they are **never**
   emitted as `[Sn]` citations anywhere (compare notes, coverage provenance, any router "background"
   path). Confirm coverage never claims 100% / "whole document" unless `tree_status='ready'` **and**
   `fully_chunked` is set (the C1/C4 invariant), and that the over-cap reject fires **before** the
   destructive `DELETE FROM chunks` [M13].

6. **Offline / no-leak.** No network in any new path; no content (summaries, vectors, extracted
   values, alignment) in logs or audit metadata.

7. **Compare mode selection & cost.** `bothTreesReadyForSymmetric` gating, the 24-section ceiling →
   labelled asymmetric fallback, and `comparePairOutputCap`/reduce-budget belt — confirm the
   symmetric path can't blow the model context or run unbounded `generate` calls, and that the
   asymmetric fallback is always labelled.

**Intentionally deferred — do NOT flag as bugs** (documented in `docs/rag-design.md` §14.8): the
collection "tree of trees"; a live full-scan extract for unmapped record types; semi-global QA (node
summaries as derived context); node vectors in ordinary chunk retrieval; a symmetric compare above
the 24-section ceiling (falls back to labelled asymmetric). Also intentional: the compare
in-document notices are **English literals** (matching the existing `compareTruncationNotice`
precedent), not i18n keys — flag only if you think the materialized report needs localization.

**Test-coverage gap to weigh in your assessment:** the entire suite uses the **mock runtime + mock
embedder** (deterministic/hash-based), so it proves *structure* (alignment, lazy-embed/reuse, the
staleness guard, mirror) but **not** semantic diff quality. If you see correctness risks that only a
real model would surface, call them out as smoke-test candidates.

Report findings by severity with file:line references and a concrete fix for each.
