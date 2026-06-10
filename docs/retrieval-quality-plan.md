# Retrieval Quality — Phase 21 design record (reranker + hybrid keyword search)

_Status: **IMPLEMENTED** (2026-06-10). This is the **condensed design record** per the
CLAUDE.md doc lifecycle rule: the research facts, the decisions (D8–D15), and the
load-bearing budgets. The full working paper (pipeline walkthrough, index-shape
discussion, testing plan) lives in git history: `git show b8feb46:docs/retrieval-quality-plan.md`.
The **design as built** is in [`rag-design.md`](rag-design.md) §11; the architecture notes
in [`architecture.md`](architecture.md). Section numbers are stable; code comments cite
them (retrieval-plan §1, §3–§5, §7, §10 D8–D15)._

Shipped: wave-1 record §9 items 1–3 ([`post-mvp-functionality-plan.md`](post-mvp-functionality-plan.md))
— item 3 with the measurement still pending (§1.3). Item 4 (ANN) explicitly NOT built (D15).
§13 D1 (unified auto-RAG chat) was not reopened.

---

## 1. Research findings (verified 2026-06-10)

### 1.1 R1 — the b9585 rerank endpoint (verified from the pinned tag's SOURCE)

- **Routes:** `POST /rerank`, `/reranking`, `/v1/rerank`, `/v1/reranking` → one handler
  (`tools/server/server.cpp` L201–204).
- **Flag:** `--rerank` (alias `--reranking`) sets `params.embedding = true` **and**
  `pooling_type = LLAMA_POOLING_TYPE_RANK` (`common/arg.cpp` L2964–2971) — the one flag
  is the whole switch; the handler refuses otherwise (`server-context.cpp` L4594–4597).
- **Request** (`server-context.cpp` L4600–4641): `{ query: string, documents: string[],
  top_n? }` (alias `texts` = TEI format; we use the Jina format). One internal task per
  document.
- **Prompting** (`server-common.cpp` L1540–1582): a GGUF-embedded `rerank` chat template
  if present, else **`BOS query EOS SEP document EOS`** — the BERT-style default path
  bge-reranker-v2-m3 uses (no template needed).
- **Response** (`server-common.cpp` L1213–1258; per-task `server-task.cpp` L1867–1873):
  `{ model, object: "list", usage, results: [{ index, relevance_score }] }` sorted by
  score **desc**, truncated to `top_n`; results map to inputs by `index`, not order.
  **`relevance_score` is an unbounded logit** — never a cosine (→ D12).

### 1.2 R2 — FTS5 in `node:sqlite` (GO)

Probed 2026-06-10 in BOTH runtimes that matter: **Electron 37.10.3 main process**
(Node 22.21.1 — probed INSIDE Electron, the Phase-1 precedent) and **system Node
24.13.0** (what vitest runs under). Both: SQLite **3.50.4** with `ENABLE_FTS5`;
virtual table + `MATCH` + `bm25()` all work. No native dependency, no descope.

### 1.3 R3 — similarity floor (PENDING)

The provisioned `D:\` test drive was not attached ⇒ no real E5 score distributions.
**`ragMinSimilarity` keeps its locked default 0**; the measurement (relevant +
irrelevant query batches on a real E5-indexed corpus → promote a measured default) is a
BUILD_STATE §5 manual item. The floor's *semantics* under reranking are decided (D12),
so the value drops in later without redesign.

## 2. Hard rules inherited

Wave-1 record §2 in full (offline, no telemetry, graceful fallback, §11.4 copy, locked
contracts incl. `[Sn]`-per-query + no persisted scores); the grounding guard unchanged
(empty retrieval ⇒ model never called); no new npm deps / no second inference stack
(same b9585 binary, FTS5 already in `node:sqlite`); `CHAT_SERVER_ARGS` never reach the
reranker; `askDocuments` stays balanced; no new audit events.

## 3. Pipeline (as built — full detail in `rag-design.md` §11)

vector topKInitial → cosine `minSimilarity` floor (pre-fusion/pre-rerank, D12) → FTS5
keyword topKInitial (visibility-scoped, §5.4) → RRF fusion (k = 60) → chunk join →
rerank when active (failure ⇒ fused order) → dedup by doc/page → topKFinal + token
budget → `[Sn]` labels. **Pass-through guarantee:** no reranker + no keyword hits ⇒
byte-identical (ordering AND scores) to the pre-Phase-21 pipeline. `RetrievedChunk.score`
is stage-dependent (cosine / RRF / rerank logit).

## 4. Reranker service (as built)

`services/reranker/`: `Reranker` interface; `LlamaReranker` = third `LlamaServer`
composition (`--rerank --device none`, lazy start, query ≤ 160 / doc ≤ 320 words,
failed-start session latch); `createSelectedReranker` → real iff binary + GGUF, else
**null** (no mock). Stopped on will-quit; `suspend()`ed on workspace lock (the lazy-
restart teardown — the fix that also unbroke the E5 embedder's post-lock restart).

## 5. Hybrid keyword search (as built)

`chunks_fts` = `fts5(text, chunk_id UNINDEXED)` — self-contained, NOT external-content
on `chunks`' implicit rowid (VACUUM may renumber implicit rowids → silent desync);
trigger-synced (insert/delete/update-of-text), guarded migration + one-time backfill in
`openDatabase`. Questions → sanitized phrase-OR `MATCH` queries (cap 32 tokens); `bm25()`
ranking; RRF k = 60 (§5.3). **§5.4 visibility rule:** keyword hits require a vector under
the active embedder — hybrid never widens what vector search sees; `REINDEX_NEEDED_ANSWER`
semantics intact.

## 6. Settings / selection surface

D14: availability-driven, no new `AppSettings` keys, no UI. The manifest's `download`
block makes the Phase-18 in-app downloader cover the GGUF with zero new code.

## 7. Resource budget (8 GB machines)

Reranker ≈ **1.3 GB RSS** when active (F16 1.08 GiB + ctx 2048); worst case alongside
4B chat (~2.6 GB) + E5 (~0.35 GB) + Electron (~1 GB) ≈ 5.3 GB — workable because the
reranker is lazy, CPU-pinned, and opt-in by provisioning (never bundled; manifest
`recommended_min_ram_gb: 6`, profiles LITE/BALANCED/PRO). CPU latency bounded by the
candidate cap (≤ 2×topKInitial) + word truncation; **the real number comes from
`PAID_RERANK_SMOKE`** (tests/manual/rerank-smoke.test.ts) and is still pending.

## 8. Testing (as held)

CI zero-network/zero-model/zero-GPU: `reranker.test.ts` (spawn args incl. no-chat-args +
CPU pin, index mapping, truncation, latch, stop/suspend, selector), `hybrid-search.test.ts`
(migration/backfill/sync, sanitization, visibility + scope, RRF, retrieve() e2e with a
fake reranker incl. both grounding-guard variants), e5 suspend, drive layout. Manual:
`PAID_RERANK_SMOKE` (real F16 load on b9585 — the q8_0-crash guard — relevance sanity,
latency). Gate at ship: typecheck clean, **601 tests**, build green.

## 9. Docs impact (applied)

`rag-design.md` §11 · `architecture.md` · `model-policy.md` (BGE license entry) ·
`drive-layout.md` + `drive.ts`/`prepare-drive.{ps1,sh}` (`models/reranker/`) ·
`known-limitations.md` · BUILD_STATE §1/§3/§4/§5. Phase commit: `b8feb46`.

## 10. Decisions (continuing the wave-1 table at D8)

| # | Decision | Resolution |
|---|---|---|
| D8 | Reranker model + license | **bge-reranker-v2-m3** (Apache-2.0 base, HF-API-verified 2026-06-10) — GGUF `gpustack/bge-reranker-v2-m3-GGUF` `bge-reranker-v2-m3-FP16.gguf` (1 159 776 896 B). **FP16, not q8_0** (the recorded b9585 XLM-R q8_0 warmup crash, BUILD_STATE §9). Qwen3-Reranker-0.6B rejected: no official GGUF (HF 401), template-path dependency, slower causal arch. Manifest `role: reranker` with `download` block + approved `license_review`; placeholder sha256 until a real fetch |
| D9 | Sidecar lifecycle | Third **`LlamaServer` composition** (E5 pattern): `--rerank --device none` (CPU pin), lazy start, `stop()` on will-quit / `suspend()` on lock, NO chat args. **Factory default = `null`** (not a mock) ⇒ retrieval byte-identical (graceful-fallback rule). Query-time failure ⇒ log + fused order; start failure ⇒ session latch |
| D10 | Resource budget (8 GB) | ~1.3 GB RSS when active; lazy + opt-in-by-provisioning + CPU-pinned ⇒ 8 GB worst case ≈ 5.3 GB. NOT bundled for TINY. Latency bounded by candidate cap + word truncation (q ≤ 160, doc ≤ 320); real numbers = `PAID_RERANK_SMOKE` (pending) |
| D11 | Rerank placement + topKInitial | Between fusion and dedup (wave-1 §9 as endorsed) — dedup keeps the best-by-rerank chunk per page. **`topKInitial` does NOT rise** when a reranker is active (CPU latency linear in candidates; the fused union already reaches ≤ 2×topKInitial; the settings knob remains for post-smoke tuning) |
| D12 | `minSimilarity` pre- vs post-rerank | **PRE-rerank, cosine-only** (status quo site + meaning): applied to vector hits before fusion. Rerank `relevance_score` is an unbounded logit — never compared to the floor. Keyword hits carry no cosine and bypass the floor by design. R3 unmeasured ⇒ default stays 0 |
| D13 | FTS index shape + sync + fusion | Self-contained `fts5(text, chunk_id UNINDEXED)` (NOT external-content on the implicit rowid — VACUUM foot-gun); 3 sync triggers; guarded additive migration + backfill (scope_json precedent). Fusion = **RRF, k = 60**, sanitized phrase-OR MATCH. **Visibility rule: keyword hits require a vector under the active embedder** — `REINDEX_NEEDED_ANSWER` semantics intact |
| D14 | Settings surface | **Availability-driven (embedder precedent): no new `AppSettings` keys, no toggle, no UI.** Hybrid always-on (pure SQLite); reranker active iff binary + weights present; Phase-18 downloader covers the GGUF |
| D15 | ANN index | **NOT built** (evidence rule, wave-1 §9 item 4): sqlite-vec/HNSW are native deps against the project theme; no measured corpus outgrows the linear scan. `VectorIndex.search` stays the upgrade path |

## 11. Out of scope (unchanged)

Unified auto-RAG chat (wave-1 §13 D1), deep-grounded answers, ANN (D15), signed update
bundles (Phase 22), wave-1 manual acceptance items.
