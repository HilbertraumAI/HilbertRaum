# Retrieval Quality — Phase 21 working paper (reranker + hybrid keyword search)

_Status: **WORKING PAPER** (drafted 2026-06-10, research gates resolved the same day).
This is the Phase-21 spec the wave-1 design record's §9 outline gated on research
([`post-mvp-functionality-plan.md`](post-mvp-functionality-plan.md) §9). Per the
CLAUDE.md doc lifecycle rule it will be condensed into a design record (or folded into
[`rag-design.md`](rag-design.md)) once implemented. Section numbers are stable; code
comments cite them (retrieval-plan §3–§7, §10 D8–D15)._

Scope: §9 items 1–3 of the wave-1 record — a cross-encoder **reranker** behind a
pass-through interface, **hybrid keyword + vector retrieval** over SQLite FTS5 with
reciprocal-rank fusion, and the **similarity floor** measurement. §9 item 4 (ANN index)
is explicitly NOT built (D15). §13 D1 (unified auto-RAG chat) is NOT reopened.

---

## 1. Research findings (verified 2026-06-10)

### 1.1 R1 — the b9585 rerank endpoint (RESOLVED: exists, shapes verified from source)

Verified against the **pinned llama.cpp `b9585` SOURCE** (files downloaded from the tag,
the same way Phase 20 resolved D5):

- **Routes:** `POST /rerank`, `/reranking`, `/v1/rerank`, `/v1/reranking` all map to the
  same handler (`tools/server/server.cpp` L201–204).
- **Flag:** `--rerank` (alias `--reranking`, env `LLAMA_ARG_RERANKING`) sets
  `params.embedding = true` **and** `params.pooling_type = LLAMA_POOLING_TYPE_RANK`
  (`common/arg.cpp` L2964–2971). No separate `--embedding`/`--pooling` args are needed —
  the one flag is the whole server-side switch. The handler hard-refuses when the server
  was not started that way (`tools/server/server-context.cpp` L4594–4597).
- **Request** (`server-context.cpp` L4600–4627): JSON body with required string `query`,
  required non-empty string array `documents` (alias `texts` selects the TEI response
  format; we use the Jina format via `documents`), optional `top_n` (default =
  `documents.length`). One internal rerank task is queued **per document**
  (L4630–4641).
- **Prompt construction** (`server-common.cpp` `format_prompt_rerank` L1540–1582): if
  the GGUF carries a chat template named `rerank`, it is used with `{query}`/`{document}`
  substitution; **otherwise the BERT-style cross-encoder sequence
  `BOS query EOS SEP document EOS`** is built from vocab metadata. bge-reranker-v2-m3
  (XLM-RoBERTa) uses the default path — no template required.
- **Response** (`server-common.cpp` `format_response_rerank` L1213–1258, per-task JSON
  `server-task.cpp` L1867–1873): Jina shape
  `{ model, object: "list", usage: { prompt_tokens, total_tokens }, results: [ { index,
  relevance_score } ] }`, sorted by score **descending**, truncated to `top_n`. `index`
  is the position in the request's `documents` array — results map back to inputs by
  `index`, not by order. **`relevance_score` is the raw model score (an unbounded
  logit, can be negative)** — it is NOT a cosine similarity and must never be compared
  to `ragMinSimilarity` (→ D12).

**Model choice (D8): `bge-reranker-v2-m3`**, GGUF from
`gpustack/bge-reranker-v2-m3-GGUF`, **FP16** file `bge-reranker-v2-m3-FP16.gguf`
(**1 159 776 896 bytes ≈ 1.08 GiB**; verified via the HF API 2026-06-10). License:
the base model `BAAI/bge-reranker-v2-m3` declares **Apache-2.0** (verified via the HF
API) and the GGUF repo also declares Apache-2.0 (mechanical conversion). Why not
`Qwen3-Reranker-0.6B` (also Apache-2.0): there is **no official GGUF**
(`Qwen/Qwen3-Reranker-0.6B-GGUF` does not exist publicly — HF API 401), it depends on
the GGUF-embedded `rerank` chat-template path with third-party conversions of mixed
provenance, and it is a causal 0.6B (slower per token on CPU) — while bge is exactly
the model family the b9585 default rerank path was built around. Why **FP16, not
q8_0/q4**: the recorded b9585 lesson (BUILD_STATE §9) — q8_0 quants of the XLM-R-family
E5 embedder **crash b9585 during warmup** (`binary_op: unsupported types: dst f32,
src1 q8_0`); bge-reranker-v2-m3 is the same architecture family, and F16 is the variant
proven to load. A live load + score sanity check is the **`PAID_RERANK_SMOKE`** manual
harness (CI never needs the model); the manifest ships with the established
`REPLACE_WITH_REAL_HASH` placeholder until a real fetch promotes the hash.

### 1.2 R2 — FTS5 in `node:sqlite` (RESOLVED: present in BOTH runtimes — hybrid is GO)

Probe (`CREATE VIRTUAL TABLE … USING fts5`, insert, `MATCH` + `bm25()`, `PRAGMA
compile_options`) run on 2026-06-10 in both runtimes that matter:

| Runtime | Node | SQLite | FTS5 |
|---|---|---|---|
| **Electron 37.10.3 main process** (the production `node:sqlite` — probed INSIDE Electron, the Phase-1 precedent) | v22.21.1 | 3.50.4, `ENABLE_FTS5` | ✅ works |
| **System Node** (what vitest runs under) | v24.13.0 | 3.50.4, `ENABLE_FTS5` | ✅ works |

Both also accept `contentless_delete=1` (SQLite ≥ 3.43), though the chosen index shape
(D13) doesn't need it. No native dependency, no descope.

### 1.3 R3 — similarity floor (PENDING: no measurement possible; default stays 0)

The provisioned `D:\` test drive is **not attached** (the current `D:\` is a personal
data disk — no `runtime/llama.cpp/`, no models, no indexed corpus), so no real E5 score
distributions can be measured. Per the research-gate rule: **`ragMinSimilarity` stays
at its locked default 0**, and the measurement (relevant + irrelevant query batches
against a real E5-indexed corpus) is recorded as a **pending manual item** alongside
the wave-1 manual acceptance list (BUILD_STATE §5 item 3). The floor's *semantics*
under reranking are still decided now (D12) so the measured value can drop in later
without a design change.

---

## 2. Hard rules inherited (unchanged, bound every choice below)

- Wave-1 record §2 in full: offline by default, no telemetry, graceful-fallback rule,
  friendly copy (spec §11.4 — never "stale index"), and the **locked contracts**:
  Float32 BLOB encoding, `VectorIndex.search` signature (ANN upgrade path),
  `[Sn]`-labels-per-query-never-stored (Citations persist **no scores**), the Phase-3
  streaming contract, per-conversation mode.
- **The grounding guard survives unchanged**: empty retrieval ⇒ the model is NEVER
  called; `NO_DOCUMENT_CONTEXT_ANSWER` / `REINDEX_NEEDED_ANSWER` keep their exact
  trigger semantics (§5.4 reconciles the keyword path with this).
- **No new npm deps. No second inference stack.** The reranker is the SAME shipped
  b9585 `llama-server` binary (no `runtime-sources.yaml` change); FTS5 is already inside
  `node:sqlite`. Localhost-only sidecars.
- `CHAT_SERVER_ARGS` (`--jinja --reasoning-format deepseek`) are chat-only and MUST NOT
  reach the reranker server (it composes `LlamaServer` directly, like the E5 embedder —
  asserted in tests).
- `askDocuments` stays balanced (Phase 20); no Phase-19 audit events are added (a
  retrieval-quality pass is chat-adjacent machinery; nothing new to record — the
  sentinel-grep surface is unchanged).

---

## 3. The retrieval pipeline as rebuilt (`rag/index.ts retrieve()`)

Today: embed → cosine `topKInitial` → `minSimilarity` → chunk join → dedup by doc/page
→ `topKFinal` + token budget → `[Sn]` labels. Phase 21 inserts two stages — keyword
search + fusion before, rerank after — keeping every locked stage where it was:

```
1. embed question → VectorIndex.search(topKInitial)         (scoped: embedder.id + documentIds)
2. drop vector hits with cosine < minSimilarity              (the floor, pre-fusion/pre-rerank — D12)
3. FTS5 keyword search (topKInitial)                         (scoped: documentIds + embedder-VISIBILITY join — §5.4)
4. RRF-fuse the two ranked lists (k = 60)                    (union ≤ 2×topKInitial — §5.3)
5. join candidates → chunks rows (text/source/page/section)
6. rerank(query, candidate texts) when a reranker is active  (reorder by relevance_score desc — §4; on failure: keep fused order)
7. dedup by (document_id, page)                              (unchanged; "best chunk per page" now means best by the CURRENT ordering)
8. trim to topKFinal under maxContextTokens                  (unchanged)
9. assign [S1]… labels per query                             (unchanged, never stored)
```

- **Pass-through default (byte-identical):** with no reranker selected AND no keyword
  hits (e.g. no lexical overlap), stages 3–4 contribute nothing and stage 6 is skipped —
  the result is exactly today's, ordering and all (RRF over a single list is monotone in
  rank). Tests assert this.
- **`RetrievedChunk.score` semantics change by stage** (recorded, since "score" used to
  mean cosine): vector-only candidates carry cosine into fusion; after fusion the
  working score is the RRF score; after rerank it is the rerank `relevance_score`.
  The score is internal (ordering + dedup keep-best); **citations never persist scores**
  (locked), so no stored shape changes.
- `topKInitial` does NOT rise when a reranker is active (D11): the reranker is
  CPU-pinned and its latency is linear in candidates; the fused union already widens
  the net to ≤ 2×`topKInitial`. The existing settings knob allows tuning once
  `PAID_RERANK_SMOKE` produces real latency numbers.

## 4. Reranker service (`services/reranker/`)

Mirrors `services/embeddings/` (the §9-prescribed E5 pattern):

- **`index.ts`** — the interface:
  ```ts
  interface RerankedHit { index: number; score: number }   // index into the input array
  interface Reranker {
    readonly id: string
    rerank(query: string, documents: string[]): Promise<RerankedHit[]>  // one hit per input
    stop?(): Promise<void>
  }
  ```
- **`llama.ts`** — `LlamaReranker` composes **`LlamaServer` directly** (third sidecar;
  E5Embedder precedent): spawn args = standard `LlamaServer` args + `extraArgs:
  ['--rerank', '--device', 'none']` — `--rerank` per R1; **`--device none` pins it to
  CPU** (same rationale as the E5 pin: a sub-1B scorer gains little from a GPU and must
  not contend for VRAM with the chat model). **No `CHAT_SERVER_ARGS`** (composition
  bypasses `LlamaRuntime`). Lazy start on first `rerank()` (shared in-flight start,
  stop-during-start safe — the E5 lifecycle, including the `stopped` latch).
  POSTs `/v1/rerank` `{ query, documents }`, maps `results[].{index, relevance_score}`
  back by `index`, validates one hit per input. Inputs are word-truncated to the
  context budget (the E5 `TOKENS_PER_WORD_ESTIMATE` approach): query ≤ 160 words,
  each document ≤ 320 words (≈ (320+160)·1.4 + specials ≪ 2048-token ctx) — bounds
  CPU latency per candidate; tune after the smoke run.
  **Failed-start latch:** if the sidecar fails to start (e.g. an incompatible GGUF —
  the E5 story), the instance marks itself unavailable for the session and later
  `rerank()` calls fail fast instead of re-spawning + re-waiting 60 s per question.
- **`factory.ts`** — `createSelectedReranker({ rootPath, model, … }) → Reranker | null`:
  real `LlamaReranker` **only when BOTH** the `llama-server` binary AND the reranker
  GGUF exist; **else `null`** (NOT a mock — a mock reranker would invent an ordering;
  `null` keeps retrieval byte-identical, the graceful-fallback rule). The model comes
  from the first `role: reranker` manifest (mirrors `resolveEmbeddingModel`; settings
  may be locked pre-unlock, so manifest-driven).
- **Failure at query time:** a present reranker that throws mid-`rerank()` logs a
  warning and the fused (unreranked) order is used — a quality pass must never break
  asking (spec §11.4; no scary errors).
- **Lifecycle wiring:** optional `AppContext.reranker`; stopped on `will-quit`
  (alongside runtime + embedder) AND in `lockWorkspace` (the sidecar's memory holds
  recent queries + chunk text — same reason Lock-now stops the others).

## 5. Hybrid keyword search (FTS5) + fusion (`services/rag/hybrid.ts`, migration in `db.ts`)

### 5.1 Index shape (D13)

A **self-contained FTS5 table keyed by chunk id** — deliberately NOT external-content
on `chunks.rowid`:

```sql
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, chunk_id UNINDEXED);
```

`chunks.id` is a TEXT UUID, so `chunks` has only an **implicit** rowid — and SQLite's
VACUUM is documented to renumber implicit rowids, which would silently desync an
external-content FTS index keyed on them. Nothing in the app VACUUMs today, but the
self-contained shape removes the foot-gun for the cost of duplicating chunk text inside
the same workspace DB (bounded by the 1 000-chunk/file cap; encrypted at rest exactly
like `chunks` — same DB file).

### 5.2 Sync = triggers (cannot be missed by any code path) + guarded migration

Three `AFTER INSERT / AFTER DELETE / AFTER UPDATE OF text` triggers on `chunks` keep
`chunks_fts` exact across **ingest, re-index (delete+insert), and delete** with zero
app-code sync sites. The migration in `openDatabase` is **guarded + additive** (the
`scope_json` precedent): if `chunks_fts` is absent in `sqlite_master`, create the table
+ triggers and **backfill** from existing `chunks` rows — a pre-Phase-21 workspace gets
a fully populated index on first open after upgrade.

### 5.3 Query + fusion rule

- The user question is sanitized into an FTS5 query in JS: extract `[\p{L}\p{N}]+`
  tokens, lowercase, **quote each as a phrase**, join with `OR`, cap at 32 tokens —
  FTS5 operator syntax in user text (`"`, `-`, `NEAR`, `*`) can never reach `MATCH`
  raw. Zero tokens ⇒ keyword search is skipped. (unicode61 tokenizes `INV-2024-001`
  into `inv 2024 001`; the same JS tokenization matches it.)
- Ranking: `ORDER BY bm25(chunks_fts)` (ascending = best), `LIMIT topKInitial`.
- **Fusion = Reciprocal Rank Fusion** with the standard constant `k = 60`:
  `score(c) = Σ_lists 1/(60 + rank_c)` (rank starts at 1). Rank-based, so the
  incomparable scales (cosine vs BM25) never mix; a chunk found by both paths
  outranks single-path chunks at equal ranks. Deterministic tie-break: vector rank,
  then chunk id.

### 5.4 Embedder-visibility reconciliation (the honesty rule)

`chunks.text` is embedder-agnostic — only vectors carry `embedding_model_id` — so a raw
keyword path would surface documents the active embedder cannot see and silently break
the Phase-17 re-index story (`staleEmbeddings` / `corpusNeedsReindex` /
`REINDEX_NEEDED_ANSWER`). **Rule: keyword hits are restricted to chunks that have a
vector under the active embedder** (join `embeddings ON chunk_id AND
embedding_model_id = ?`), composing with the `documentIds` scope exactly like the
vector path. Consequences, by construction:

- hybrid search can never see MORE documents than vector search could;
- a corpus invisible to the active embedder yields empty keyword hits too ⇒ retrieval
  stays empty ⇒ `corpusNeedsReindex` still fires `REINDEX_NEEDED_ANSWER` (tested);
- the grounding guard's "empty ⇒ model never called" semantics are untouched.

## 6. Settings / selection surface (D14)

**Availability-driven, the embedder precedent — no new `AppSettings` keys, no UI
surface this phase.** The reranker activates when its weights + the binary exist
(provision the GGUF → quality improves; remove it → today's behavior); hybrid keyword
search is always on (pure SQLite, no model, no cost worth a knob). The existing
`rag*` settings keep their meanings (`ragMinSimilarity` = the PRE-rerank cosine floor,
D12). Since no renderer surface is added, no renderer tests are needed. The reranker
manifest carries a `download` block, so the Phase-18 in-app downloader can fetch it
with zero new code (triple-gated as ever).

## 7. Resource budget (third sidecar on an 8 GB machine) (D10)

| Component | Approx. RSS |
|---|---|
| Qwen3 4B Q4 chat sidecar | ~2.6 GB |
| E5-small F16 embedder sidecar | ~0.35 GB |
| **bge-reranker-v2-m3 FP16 reranker sidecar** | **~1.3 GB** (1.08 GiB weights + ctx 2048) |
| Electron + app | ~1 GB |

≈ 5.3 GB total on the smallest (TINY/8 GB) machines — workable but tight, which is why:
the reranker is **lazy** (spawns on the first documents question, not at startup),
**opt-in by provisioning** (not flagged `bundled_on_preconfigured_drive`; TINY drives
shouldn't bundle it — manifest `recommended_min_ram_gb: 6`, `recommended_profiles:
[LITE, BALANCED, PRO]`), and CPU-pinned (zero VRAM contention). Latency estimate at
FP16 on CPU: ≤ 24 truncated candidates × ≤ ~700 tokens ≈ 5–20 s per question on a
mid-range 8-thread CPU — acceptable for an opt-in quality pass, but **the headline
measurement `PAID_RERANK_SMOKE` must capture**; the §3 knobs (candidate cap,
truncation budgets) are the tuning levers.

## 8. Testing (existing harnesses only; CI stays zero-network/zero-model/zero-GPU)

- **`LlamaReranker`** via fake spawn + mocked loopback fetch (the e5-embedder pattern):
  spawn args contain `--rerank --device none --host 127.0.0.1` and NOT
  `--jinja`/`--reasoning-format`; request body shape; `results[].index` mapping
  (including the server's score-desc ordering ≠ input order); count/coverage
  validation; lazy single start; stop + stop-during-start; the failed-start latch;
  truncation.
- **Factory:** null without manifest/binary/weights; real with both (injected seams).
- **FTS migration + sync** on temp DBs: fresh DB has table + triggers; a
  **pre-Phase-21 DB** (built without the migration) gets backfilled on open (the
  `rag-scope` migration-test precedent); ingest/reindex/delete keep `chunks_fts` exact
  through the real ingestion service.
- **Keyword search + RRF:** exact-term hits embeddings miss; `documentIds` scoping;
  the **visibility case** (chunk with no vector under the active embedder is
  excluded); operator-laden questions never throw; fusion ordering + determinism.
- **`retrieve()` end-to-end with a fake reranker:** rerank order applied (reranker
  reverses → final order reversed); pass-through when absent (byte-identical case);
  reranker failure → fused order, no throw; **the grounding guard still never calls
  the model on empty retrieval**, including the keyword-only-invisible-corpus case
  (still `REINDEX_NEEDED_ANSWER`).
- **Manual:** `tests/manual/rerank-smoke.test.ts` behind
  `PAID_RERANK_SMOKE=<drive root>` (the gpu/thinking-smoke pattern): real binary +
  real bge GGUF — loads (the FP16-on-b9585 verification), scores a relevant doc above
  an irrelevant one, and reports wall-clock latency for a `topKInitial`-sized batch.
- Run from `apps/desktop` (root `npm test`); no renderer tests (no UI surface).

## 9. Docs impact (applied at phase end)

`rag-design.md` (new §11: hybrid + rerank pipeline) · `architecture.md` (third sidecar
+ FTS) · `model-policy.md` (bge-reranker-v2-m3 license entry) · `drive-layout.md` +
`drive.ts`/`prepare-drive.{ps1,sh}` (`models/reranker/`) · `known-limitations.md`
(R3 floor pending, rerank latency until measured, FTS text duplication) ·
`BUILD_STATE.md` §1/§3/§4/§5.

## 10. Decisions (continuing the wave-1 table at D8)

| # | Decision | Resolution |
|---|---|---|
| D8 | Reranker model + license | **bge-reranker-v2-m3** (Apache-2.0 base, verified via HF API 2026-06-10) — GGUF `gpustack/bge-reranker-v2-m3-GGUF` `bge-reranker-v2-m3-FP16.gguf` (1 159 776 896 B). **FP16, not q8_0** (the recorded b9585 XLM-R q8_0 warmup crash, BUILD_STATE §9). Qwen3-Reranker-0.6B rejected: no official GGUF (HF 401), template-path dependency, slower causal arch. Manifest `role: reranker` (the spec-§3.3 reserved role finally used) with `download` block + approved `license_review`; placeholder sha256 until a real fetch (established pattern) |
| D9 | Sidecar lifecycle | Third **`LlamaServer` composition** (`services/reranker/llama.ts`, the E5 pattern): `--rerank --device none` (CPU pin), lazy start on first `rerank()`, `stop()` on will-quit AND lock, NO chat args. `Reranker` interface; **factory default = `null`** (not a mock) ⇒ retrieval byte-identical to today (graceful-fallback rule). Query-time failure ⇒ log + fused order; start failure ⇒ session latch (no 60 s stall per question) |
| D10 | Resource budget (8 GB) | ~1.3 GB RSS when active (FP16 + ctx 2048); lazy + opt-in-by-provisioning + CPU-pinned makes the 8 GB worst case ≈ 5.3 GB total. NOT bundled for TINY (`recommended_min_ram_gb: 6`, profiles LITE/BALANCED/PRO, `bundled_on_preconfigured_drive: false`). Latency bounded by candidate cap (≤ 2×topKInitial) + word truncation (q ≤ 160, doc ≤ 320); real numbers = `PAID_RERANK_SMOKE` |
| D11 | Rerank placement + topKInitial | Between retrieval/fusion and dedup (wave-1 §9 as endorsed) — dedup then keeps the best-by-rerank chunk per page. **`topKInitial` does NOT rise** when a reranker is active (CPU latency is linear in candidates; the fused union already reaches ≤ 2×topKInitial; the settings knob remains for post-smoke tuning) |
| D12 | `minSimilarity` pre- vs post-rerank | **PRE-rerank, cosine-only** (status quo site + meaning): applied to vector hits before fusion. Rerank `relevance_score` is an unbounded logit — never compared to the floor. Keyword hits carry no cosine and bypass the floor by design (lexical evidence earns inclusion; the floor is a vector-space concept). R3 unmeasured ⇒ default stays 0; the measured value drops in later without redesign |
| D13 | FTS index shape + sync + fusion | Self-contained `chunks_fts` = `fts5(text, chunk_id UNINDEXED)` (NOT external-content on the implicit rowid — VACUUM renumbering foot-gun); sync via 3 triggers on `chunks` (ingest/reindex/delete can't miss); guarded additive migration + backfill in `openDatabase` (scope_json precedent). Fusion = **RRF, k = 60**, sanitized phrase-OR `MATCH` query. **Visibility rule: keyword hits require a vector under the active embedder** — hybrid never widens what retrieval can see; `REINDEX_NEEDED_ANSWER` semantics intact |
| D14 | Settings surface | **Availability-driven (embedder precedent): no new `AppSettings` keys, no toggle, no UI** this phase. Hybrid always-on (pure SQLite); reranker active iff binary + weights present; Phase-18 downloader covers the GGUF for free |
| D15 | ANN index | **NOT built** (wave-1 §9 item 4 evidence rule): sqlite-vec/HNSW are native deps against the project theme; the linear scan has no measured corpus outgrowing it. `VectorIndex.search` signature stays the upgrade path |

## 11. Out of scope (unchanged)

Unified auto-RAG chat (wave-1 §13 D1 — explicitly not reopened), deep-grounded answers
(Phase 20 note), ANN (D15), signed update bundles (Phase 22), wave-1 manual acceptance
items (BUILD_STATE §5 item 3).
