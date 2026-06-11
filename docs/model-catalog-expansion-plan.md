# Model Catalog Expansion & Benchmarking — design record (Phases 28–29) + Phase 30 outline

_Status: **DESIGN RECORD. Phase 28 (catalog wave 1) and Phase 29 (benchmark protocol + first
comparison run) are DONE (2026-06-10/11). Phase 30 (opt-in big slot + embeddings) is OUTLINE
ONLY — not started.** This was a working paper, condensed per the CLAUDE.md doc lifecycle rule
once 28–29 shipped; the full original (protocol drafts, bring-up checklists, the pre-measurement
RAM estimates) is in git history (`git show <pre-condense-hash>:docs/model-catalog-expansion-plan.md`).
Durable detail now lives in the topic docs: the benchmark protocol + first-run results in
[`docs/model-benchmarks.md`](model-benchmarks.md); the catalog + recommendation in
[`docs/model-policy.md`](model-policy.md). Decision numbering continues the repo series (post-MVP
D1–D7, retrieval D8–D15 → **D16–D22** here)._

---

## 1. Decisions (D16–D22)

| # | Decision | Choice | Why (short) |
|---|---|---|---|
| D16 | First challenger batch | **Ministral 3 8B Instruct 2512** + **Granite 4.1 8B** (mid tier) + **Gemma 4 12B QAT** (high tier) | All Apache-2.0, all with *vendor-published* GGUFs, all strong German — 2–3 challengers per tier without 200 GB of downloads |
| D17 | Challenger auto-recommendation | New manifests ship with **empty `recommended_profiles`** (selectable, never auto-recommended) until they earn it | A challenger must EARN promotion via the Phase-29 benchmark before the recommender offers it |
| D18 | Incumbent refresh | Evaluate **Qwen3-4B-Instruct-2507** as a 4th Phase-28 manifest | Report data: the 2507 4B beats the *original* 8B on most axes. ⚠️ 2507 is instruct-only (no hybrid thinking) — interacts with Phase-20 depth modes |
| D19 | Quality benchmark = judge-free, ours | Hand-rolled **German/English grounded-QA set** + deterministic string/F1/citation/abstain scoring; `llama-bench` for speed | No cloud judge (hard rule); tests exactly what the product does (RAG + citations + abstention); no new toolchain |
| D20 | Benchmark form | **Manual protocol doc first** (`docs/model-benchmarks.md` + a results CSV convention); automate only if the manual loop proves annoying | One developer, 2–3 laptops; don't build automation before the protocol has run once |
| D21 | Big/opt-in slot + embeddings | **Phase 30, outline only** — Gemma 4 26B-A4B vs the incumbent Qwen3 30B-A3B; Granite Embedding R2 small as the only near-drop-in embedder | MoE comparisons need Phase-29 numbers first; an embedder swap forces a reindex story — separate, later |
| D22 | License gate posture | Every new manifest lands with a **real `license_review` record** (approved, with source URLs) before merge | Licensing is the #1 disqualifier; the review work is cheap now (all picks verified Apache-2.0) and mandatory before any drive bundles them |

**Outcomes (as built):** D16 — all three challengers shipped + license-reviewed. **D17 evolved**:
the challengers kept `recommended_profiles: []`, but Phase 29 found the production recommender was
*quality-blind* (RAM-best-fit, ignores `recommended_profiles`; the legacy picker is one-model-per-
profile), so promotion is now carried by a new **`recommendation_rank`** manifest field that makes
RAM-best-fit quality-aware (§5). **D18 resolved**: 2507 shipped (via the unsloth fallback) and beat
the original 4B on *every* Phase-29 metric, but the original stays the **bundled default** (it has
hybrid thinking → keeps Deep working out of the box); 2507 is ranked just below it. D19/D20 — the
judge-free harness + protocol shipped and ran. D21 — Phase 30 still outline. D22 — all four
`license_review`s approved Apache-2.0.

**Disqualified (do not revisit without new facts):** EXAONE 4.x (NC license), Ministral
8B-Instruct-**2410** (Mistral Research License, non-commercial — the `-2512` name-twin trap),
Phi-4 (MIT but not multilingual → fails German), Mistral Large 3 (Apache but 675B). **Parked:**
Llama 3.x (community license, encumbered vs all-Apache alternatives), GLM-4 (MIT, German unproven),
Gemma 3 (custom Gemma Terms — superseded by Apache-2.0 Gemma 4).

## 2. Hard rules (these bound every choice)

- **No model weights in git; manifests are the catalog.** Adding a model = one YAML in
  `model-manifests/chat/` with a `download` block + `license_review` (model-policy).
- **Verify-before-trust:** hashes start as `REPLACE_WITH_REAL_HASH`, promoted via
  `verify-models --generate` after the first real fetch.
- **License gate:** nothing bundles on a sold drive without `license_review.status: approved`;
  the review records license, commercial-use, redistribution, attribution, and **quantization
  provenance** (vendor GGUF vs third-party requant).
- **Offline forever:** all fetching is the drive-builder's machine or the triple-gated Phase-18
  in-app downloader. The benchmark runs with Wi-Fi off (eval data pre-committed).
- **No cloud judge, no telemetry:** quality scoring is deterministic local string math; results
  stay local (summary CSVs in `eval/results/` are fine — no user data).

## 3. Verified research facts (2026-06-10 — what the plan rested on; all confirmed live on b9585)

1. **Pinned llama.cpp `b9585` = the 2026-06-09 release** — every candidate (incl. Gemma 4, which
   needs ~b8607) runs on the runtime we already ship. No runtime bump. (Confirmed live in bring-up.)
2. **Gemma 4 is Apache-2.0** — first Gemma under an OSI license. Official Google QAT Q4_0 GGUF:
   <https://huggingface.co/google/gemma-4-12B-it-qat-q4_0-gguf>.
3. **Ministral 3 (2512) family is Apache-2.0**, official Mistral GGUF repo
   (<https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512-GGUF>). ⚠️ The Oct-2024
   `Ministral-8B-Instruct-2410` is **non-commercial** (Mistral Research License) — the manifest
   pins the exact `-2512` URL; the review names the trap.
4. **Granite 4.1 is Apache-2.0** with official IBM GGUFs at
   <https://huggingface.co/ibm-granite/granite-4.1-8b-GGUF> (NO `-instruct` suffix — that repo IS
   the instruct model). German is one of 12 official languages.
5. **Incumbents are the ORIGINAL Qwen3 instruct models** (hybrid thinking), not the 2507 refresh.
   Report table basis for D18: 2507-4B scores above the *original 8B* on MMLU-Pro/IFEval/MMLU-ProX.
6. **`--jinja` is already in `CHAT_SERVER_ARGS`** — the server applies each GGUF's embedded chat
   template; new-model bring-up only needs a render smoke. `--reasoning-format deepseek` is a no-op
   for non-thinking models.
7. **Embeddings:** the pipeline is built around E5-small's **384 dims**; switching embedders forces
   a reindex. **Granite Embedding R2 small (384-dim, Apache-2.0)** is the only near-drop-in
   candidate — Phase-30 material (BGE-M3 / Qwen3-Embedding are 1024-dim).

---

## 4. Phase 28 — catalog wave 1 (as built, manifest-only)

Four manifests under `model-manifests/chat/`, all Apache-2.0, all `license_review: approved`,
**no code changes** — the existing validator + committed-manifests discovery test cover them:

| id | source GGUF | notes |
|---|---|---|
| `ministral3-8b-instruct-2512-q4` | official `mistralai/…-2512-GGUF` Q4_K_M | text-only (mmproj vision file deliberately not referenced); review names the `-2410` NC trap |
| `granite-4.1-8b-q4` | official `ibm-granite/granite-4.1-8b-GGUF` Q4_K_M | repo name has no `-instruct` |
| `gemma4-12b-it-qat-q4` | official `google/gemma-4-12B-it-qat-q4_0-gguf` | vendor QAT **Q4_0**; file name lower-case `gemma-4-12b-…` |
| `qwen3-4b-instruct-2507-q4` (D18) | **unsloth** `Qwen3-4B-Instruct-2507-GGUF` Q4_K_M | the Qwen org publishes NO official 2507 GGUF → established-quantizer fallback; recorded as third-party requant in the review |

Provenance notes that survived to the manifests: vendor GGUF repos declare apache-2.0 via the HF
card tag only, so their `license_url` points at the canonical Apache-2.0 text (card URLs in the
review notes); only the Qwen 2507 base repo ships a LICENSE blob. Exact HF-tree byte sizes are
baked into `download.size_bytes`. Weights fetched + real `sha256` promoted; `verify-models -Target
D:\` reports **all 10 catalog weights VERIFIED**.

**Bring-up** (`tests/manual/bringup-smoke.test.ts`, real b9585): all four load, render the chat
template through `--jinja` with no leaked artifacts, stream tokens, and answer the German prompt in
German. Two findings were carried into Phase 29 and **resolved there**: (a) 2507 looked factually
wobbly in German on *open* knowledge — it did **not** recur on the grounded RAG path (2507 has the
top German F1 in the benchmark); (b) Gemma 4 honours `enable_thinking` — its
`supports_thinking_mode` was flipped **true** after the Phase-29 thinking-quality check. Catalog
table + recommendation story: [`model-policy.md`](model-policy.md).

---

## 5. Phase 29 — benchmark protocol + first comparison run (as built)

**Protocol = [`docs/model-benchmarks.md`](model-benchmarks.md)** (offline, judge-free): Part A
quality harness, Part B `llama-bench` speed, Part C peak-RSS memory, the combined CSV schema, the
§5.4 decision rule, and **§6 the first-run findings + the decisions applied**. Tooling, all
committed:

- **Scorer** `apps/desktop/tests/eval/score.ts` (+ `text.mjs`, 28 CI tests): German-aware
  normalization (umlauts/ß kept), containment-EM + token-F1, citation/grounding, a DE/EN
  refusal-phrase abstention heuristic, DE-vs-EN split aggregates.
- **Harness** `tests/manual/model-eval.test.ts` — the **real RAG path** (E5 + reranker + grounding
  template), retrieval embedded once so cross-model deltas isolate the chat model; `temperature 0`.
- **Eval set** `eval/{corpus,rag}_de_en.jsonl` (built + self-validated by `eval/build.mjs`): **100
  items, 60 DE / 40 EN, 40 parallel DE/EN pairs + 20 German-only, 15 unanswerable**; office +
  civic/everyday corpus with deliberate distractors.
- **Speed/RAM** `scripts/benchmark-speed.ps1` (loop) + `scripts/measure-peak-rss.ps1`;
  `eval/rescore.mjs` (re-score dumps after a detector change) + `eval/combine.mjs` (join QA+speed).

**First run:** i7-1185G7 (all 8 models, QA+speed+RSS — `eval/results/i7-1185G7-cpu.csv`); the dev
box reproduced the QA numbers **bit-for-bit** (greedy ⇒ quality is machine-independent).

**Findings (detail in `model-benchmarks.md` §6):**
- Grounded **EM saturates** (95–98 %, DE ≈ EN) → accuracy does not separate the catalog;
  `citation_correct` is a **retrieval constant** (citations come from retrieval, not the model).
  The discriminator is **hallucination-resistance** on the 15 unanswerable items.
- Audited genuine hallucinations / 15: **Ministral 0**, Gemma4/2507/30B **1**, Qwen3-8B/14B **2**,
  orig-4B/Granite **3**. (The v1 abstention heuristic overcounted hallucination ~2–3× — hardened
  after auditing the raw dumps, then re-scored via `rescore.mjs` with **no model re-run**.)
- Decode tg t/s: 4B ~6.2, **Ministral 4.5** (fastest 8B), Qwen3-8B 3.9, Granite 4.3, **Gemma 3.0**,
  Qwen3-14B 2.1 (slowest), 30B-A3B 4.7 (MoE).

**Decisions applied (live):**
- **`recommended_min_ram_gb` recalibrated** from measured peak RSS (8B 16→12, 12–14B 16→14; 4B
  held 8, 30B held 24 for the MoE/mmap caveat).
- **Recommender made quality-aware**: new optional `recommendation_rank` manifest field is the
  tiebreak in `recommendModelIdByRam` (after capacity fit, before disk size; default 0 = legacy
  behaviour). Net on real hardware: **≤12 GB → Qwen3-4B (default), 16–24 GB → Ministral, ≥32 GB →
  Gemma 4**; Granite (loser) and the 30B MoE (opt-in) are never auto-recommended.
- **Gemma `supports_thinking_mode` flipped true** — the run-#2 thinking check had Deep match
  Balanced 8/8 on reasoning items with coherent chain-of-thought.
- **Licence correction:** the whole catalog is Apache-2.0 (Qwen3 included) — the challenger edge is
  quality + speed, not licence.

**Not blocking / open:** a dev-box speed/RSS sweep for a formal 2nd machine (QA + RSS are
machine-independent and already reproduced); the eval set saturates EM, so a harder set would be
needed to separate models on accuracy (it already separates abstention well — see §6).

---

## 6. Phase 30 — opt-in big slot + embeddings (OUTLINE — drafted as its own plan)

> **Now has a dedicated working paper: [`big-slot-embeddings-plan.md`](big-slot-embeddings-plan.md)**
> (decisions D23–D28). The outline below is the seed; the plan doc has the candidates-to-verify,
> the two-track procedure (reusing the Phase-29 benchmark machinery), sequencing, and done-when.

- **Big-slot shoot-out:** Gemma 4 26B-A4B (Apache, ~4B active → near-4B CPU tg; official Google QAT
  GGUF) and/or Granite 4.0 H-Small (Apache, hybrid-Mamba) vs the incumbent Qwen3 30B-A3B; Mistral
  Small 3.2 24B (Apache, dense ~14 GB) as the dense quality ceiling for 32 GB/GPU machines. Same
  manifest + benchmark machinery; all start `recommended_profiles: []` / `recommendation_rank: 0`.
- **Embeddings:** Granite Embedding R2 small (384-dim, Apache-2.0) is the only candidate that avoids
  a vector-schema question — but ANY embedder swap needs the reindex story surfaced (the Phase-17
  `staleEmbeddings` / Re-index-all machinery is the hook). Needs its own mini-plan: GGUF provenance,
  llama.cpp embedding-mode compatibility on b9585 (test F16 first — the E5 q8_0 crash precedent),
  retrieval-quality A/B on `eval/rag_de_en.jsonl`, and whether 1024-dim models (BGE-M3,
  Qwen3-Embedding) are worth the index migration. Coordinate with [`rag-design.md`](rag-design.md)
  §11 (a better retriever may shift the reranker cost/benefit).

## 7. Risks / open items (still live)

| Risk | Mitigation |
|---|---|
| Eval set saturates EM (all models ~96–98 %) | Grow the set with harder/multi-hop + more distractor-heavy items before trusting accuracy deltas; per-item dumps are kept. Abstention already separates models |
| Benchmark machines too few/too similar | The protocol records machine facts; the GPU hardware matrix machines double as benchmark hosts over time (run the dev-box sweep for the formal 2nd machine) |
| HF repo layouts / filenames drift | Manifests pin exact URLs; first fetch + `verify-models --generate` catches drift loudly |
| Phase-30 embedder swap forces a reindex | Surface via the Phase-17 re-index machinery; its own mini-plan before any swap |
