# Big Slot + Embeddings — plan (Phase 30)

_Status: **WORKING PAPER — not started (created 2026-06-11).** Continues the model-catalog work:
the wave-1 catalog + benchmark (Phases 28–29) shipped and were condensed into
[`model-benchmarks.md`](model-benchmarks.md) §7 (decision **D21** deferred
this to Phase 30). Decision numbering continues the repo series (catalog D16–D22 → **this plan
D23–D28**). Per the CLAUDE.md doc lifecycle rule this is a working paper: condense into a design
record / fold into the topic docs once implemented. Two **independent** tracks (A = a bigger chat
model; B = a better embedder) that share the Phase-29 benchmark machinery but otherwise don't
depend on each other._

---

## 1. Summary (the decisions to make)

| # | Decision | Lean | Why |
|---|---|---|---|
| D23 | Track A candidate set | Fetch + benchmark **Gemma 4 26B-A4B** (MoE) first; **Mistral Small 3.2 24B** (dense) as the GPU/32 GB quality ceiling; **Granite 4.0 H-Small** only if its hybrid-Mamba arch loads on b9585 | Gemma 4 12B *won* its Phase-29 tier — the 26B-A4B is the obvious "does it scale up at near-4B speed"; the rest are secondary |
| D24 | Track A inclusion bar | A big model is **only** added/recommended if it beats the incumbent **Qwen3 30B-A3B** on the benchmark at a tg t/s that is still usable on CPU, OR is a clearly-better GPU-only ceiling | The 30B-A3B is already fast+accurate (Phase 29: 1/15 hallucinations, 4.7 tg t/s); a 200 GB download must earn its place |
| D25 | Track B embedder + dimensionality | Start with **Granite Embedding R2 small (384-dim)** — a same-dimension reindex, no storage change. Treat **1024-dim** models (BGE-M3, Qwen3-Embedding-0.6B) as a *separate* later question | 384-dim is a drop-in (reindex only); 1024-dim works mechanically but ~2.7× the vector storage + a bigger embedder — only worth it if the quality A/B is decisive |
| D26 | Track B adoption bar | Swap the default embedder only if it **measurably** beats E5 on the (hardened) `eval/rag_de_en.jsonl` retrieval A/B by a margin that justifies forcing every user to **re-index** | An embedder swap is the one change that invalidates a user's existing index — the bar is higher than for a chat model |
| D27 | Eval-set hardening (prerequisite for B, useful for A) | Extend `eval/rag_de_en.jsonl` with **harder** items (multi-hop, numeric reasoning, near-duplicate distractors) so retrieval/accuracy deltas are visible | Phase 29 found grounded **EM saturates** (~96–98 %) — the current set can't separate two strong retrievers/models on accuracy |
| D28 | MoE RAM-measurement method | For MoE models, calibrate `recommended_min_ram_gb` from **the weight-file size + KV headroom**, not just peak RSS | Phase 29 found mmap **undercounts** peak RSS for MoE (the 30B reported ~10 GiB resident but the file is ~18.6 GB) |

**Hard rules (inherited, unchanged):** no weights in git; verify-before-trust (`REPLACE_WITH_REAL_HASH`
→ `verify-models --generate`); `license_review: approved` before any drive bundles a model; offline
forever (fetch on the builder machine / triple-gated downloader); no cloud judge / no telemetry;
friendly copy if anything surfaces in UI.

## 2. What Phase 29 already gives us (so Track A is cheap)

Adding + ranking a chat model is now **manifest + run the existing benchmark** — all of this exists
and is committed:

- **The judge-free benchmark** — protocol [`docs/model-benchmarks.md`](model-benchmarks.md); scorer
  `apps/desktop/tests/eval/score.ts` (+ `text.mjs`); real-RAG-path harness
  `tests/manual/model-eval.test.ts`; the 100-item `eval/{corpus,rag}_de_en.jsonl`; speed/RSS via
  `scripts/benchmark-speed.ps1` + `scripts/measure-peak-rss.ps1`; `eval/rescore.mjs` +
  `eval/combine.mjs`.
- **A quality-aware recommender** — the `recommendation_rank` manifest field + `recommendModelIdByRam`
  (Phase 29). A new big model competes for a recommendation slot by its rank, never by disk size.
- **A measured baseline for the incumbent** — Qwen3 30B-A3B: **1/15 hallucinations, 4.7 tg t/s,
  ~10 GiB resident** (mmap-undercounted; ~18.6 GB file), `recommended_min_ram_gb: 24`. Any Track-A
  challenger must beat *that*.

Track B is the genuinely new engineering (the embedder is wired deeper than a chat model).

## 3. Track A — opt-in big chat slot

**Goal:** decide whether any model above the 12–14B tier is worth recommending for 32 GB+/GPU
machines, or whether the incumbent Qwen3 30B-A3B stays the only big option.

### 3.1 Candidates (VERIFY at authoring time — same discipline as Phase 28 §3)

Each candidate must clear, before a manifest is written: (1) the repo + an **official or
established-quantizer GGUF** exists, (2) the license tag is **Apache-2.0** (or equivalently clean),
(3) the architecture **loads on our pinned b9585** (the riskiest unknown for the non-standard archs
below — confirm with a load smoke before committing).

| Candidate | Type | Why | Risk to verify |
|---|---|---|---|
| **Gemma 4 26B-A4B** | MoE, ~4B active | Gemma 4 12B won its Phase-29 tier; ~4B-active → near-4B CPU decode at ~26B quality; official Google QAT GGUF (per the report) | GGUF exists + loads on b9585 |
| **Mistral Small 3.2 24B** | dense, ~14 GB | The dense quality *ceiling* for 32 GB / GPU; CPU-slow but a good GPU pick | Apache + GGUF; CPU tg likely too low to recommend without a GPU |
| **Granite 4.0 H-Small** | hybrid-Mamba | A different-architecture bet; strong IBM provenance | **Mamba/hybrid layers on b9585** — most likely to fail the load smoke |

### 3.2 Procedure (reuse Phase 28 + 29 verbatim)

1. Author manifest(s) under `model-manifests/chat/` (`recommended_profiles: []`,
   `recommendation_rank: 0`, real `license_review`), fetch, promote real `sha256`.
2. **Bring-up smoke** (`tests/manual/bringup-smoke.test.ts` pattern): loads on b9585, German answer,
   no template leak. (This is where a Mamba/MoE arch would fail loudly.)
3. **Benchmark** via `tests/manual/model-eval.test.ts` + `scripts/benchmark-speed.ps1` on the same
   machines; join with `eval/combine.mjs`.
4. Apply **D24**: if a candidate beats the 30B-A3B on the benchmark at a usable CPU tg t/s, give it a
   `recommendation_rank` at the top tier (and recalibrate big-MoE RAM per **D28**); else record the
   numbers and **drop the manifest** (no dead multi-GB downloads — the Granite-loser precedent).

### 3.3 Done when

Candidates fetched + bring-up-smoked + benchmarked on ≥1 machine; the catalog reflects the decision
(promote via `recommendation_rank`, or remove); `model-policy.md` + README + BUILD_STATE updated.

## 4. Track B — better embedder (the harder track)

**Goal:** decide whether to replace E5-small as the default document embedder. This is the one swap
that **invalidates a user's existing index**, so the bar (D26) is high and the UX matters.

### 4.1 What makes it harder than a chat model

The embedder is wired through `services/embeddings/` (the `Embedder` interface, `E5Embedder` on
`llama-server --embedding`), the `VectorIndex` cosine scan, the locked Float32 BLOB encoding, and the
Phase-10 **id-scoped** mismatch guard (`embeddings.embedding_model_id`). The schema already stores
`dimensions` **per row** and scopes search by model id, so a different-dimension embedder works
*mechanically* — the cost is a **full re-index** + (for 1024-dim) ~2.7× the vector-blob storage.

### 4.2 Candidate + the dimensionality fork (D25)

- **Granite Embedding R2 small (~97M, 384-dim, Apache-2.0)** — the only **drop-in**: same 384 dims,
  so adopting it is "reindex with the new model," no storage change. **Start here.**
- **BGE-M3 / Qwen3-Embedding-0.6B (1024-dim)** — stronger retrievers but 1024 dims (Qwen3 is
  MRL-truncatable to 384). Mechanically supported (per-row dims) but ~2.7× vector storage and a
  heavier embedder — a *separate* decision, only if the 384-dim A/B disappoints.

### 4.3 Procedure

1. **Compatibility gate first** — GGUF provenance + load on b9585. **Test F16**, not q8_0: the E5
   `q8_0` conversion *crashes* b9585 (`binary_op: unsupported types … q8_0`), which is why E5 + the
   reranker are pinned F16. A new XLM-R/BERT-family embedder is the same hazard class.
2. **Retrieval A/B** on the **hardened** `eval/rag_de_en.jsonl` (D27 first — the current set
   saturates EM so a weak A/B would tie): embed the corpus with E5 vs the candidate, run the same
   harness, compare EM / F1 / citation-correct / abstention. The harness's "embed once, reranker
   fixed" design already isolates the retriever.
3. **Reindex UX** — surface the swap through the existing Phase-17 machinery (`staleEmbeddings` /
   `corpusNeedsReindex` / `REINDEX_NEEDED_ANSWER` / the Documents "Re-index all" action): on an
   embedder change the app must clearly say "your documents need re-indexing" and not silently mix
   spaces (the id-scoping already prevents mixing — the job is the honest prompt + the re-embed pass).
4. **Coordinate with the reranker** ([`rag-design.md`](rag-design.md) §11): a materially better
   retriever may shift whether the bge reranker still earns its CPU cost — re-measure the
   rerank-on/off delta on the new retriever before concluding.

### 4.4 Done when

The candidate's GGUF is verified + b9585-compatible (F16); the A/B vs E5 on the hardened eval set is
recorded; **D26** decided (adopt / reject / defer-1024-dim). If adopted: the embedder swap path + the
re-index UX ship and are tested; `recommended_*` + the reindex story documented; `rag-design.md` +
`model-policy.md` + BUILD_STATE updated.

**Rider — D1 re-evaluation trigger (decided 2026-06-12, recorded in `rag-design.md` §10):** if
Track B adopts an embedder that uses **query/passage prefixes** and the A/B shows a **measurable
relevance floor** (relevant vs irrelevant cosines separate, unlike prefix-less E5 — rag-design
§12.1 R3), then re-open **D1 (unified auto-RAG chat)**: a cheap floor would make auto-grounding
gateable without the reranker's per-message CPU cost. Until then the two-mode design stands.

## 5. Sequencing

1. **Track A** (quick — reuses everything): fetch Gemma-4-26B, bring-up smoke (catches arch/runtime
   issues early), benchmark, decide. Mistral-24B + Granite-H as time allows.
2. **D27 eval-set hardening** — needed before Track B's A/B can discriminate; also sharpens Track A.
3. **Track B** — compat gate → A/B → reindex UX → decision. The big one; do it last and on its own.

(A and B are independent — Track A can ship without Track B ever starting.)

## 6. Risks / open items

| Risk | Mitigation |
|---|---|
| A non-standard arch (Mamba/hybrid, a new MoE) won't load on b9585 | The §3.2 bring-up smoke is the gate; a runtime bump is out of scope for this plan (it would be its own phase, like the GPU work) |
| Eval set still can't separate strong models even after hardening | Grow it iteratively; lean on hallucination/abstention + speed/RAM (which *did* separate models in Phase 29) rather than EM |
| Embedder swap forces a reindex users don't expect | The Phase-17 re-index machinery + an explicit, friendly prompt; never silently mix vector spaces (id-scoping already enforces this) |
| 1024-dim migration tempting but costly | Hold it behind a *decisive* 384-dim A/B result (D25); ~2.7× storage + a heavier model is a real portable-drive cost |
| Big MoE RAM mis-calibrated (mmap undercount) | D28: size-from-file + KV headroom for MoE, not peak RSS alone |
| A big model is slower than the 30B-A3B for no quality gain | D24 lets the outcome be "add nothing" — the 30B-A3B is a strong incumbent; record the numbers and move on |
