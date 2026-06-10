# Model Catalog Expansion & Benchmarking — plan (Phases 28–30)

_Status: **WORKING PAPER — NOT IMPLEMENTED.** Created 2026-06-10 from an external model-candidate
research report (Claude web research, verified spot-checks below) + the planning discussion in
session. Per the CLAUDE.md doc lifecycle rule this plan gets condensed into a design record (or
folded into [`model-policy.md`](model-policy.md) / a new `docs/model-benchmarks.md`) once
implemented. Decision numbering continues the repo series: post-MVP plan D1–D7, retrieval plan
D8–D15 → **this plan D16–D22**. Phase numbers 28–30 are the next free numbers after the UI wave
(Phases 23–27); Phase 22 (signed update bundles) keeps its number and stays independent._

---

## 1. Summary (the decisions, in one screen)

| # | Decision | Choice | Why (short) |
|---|---|---|---|
| D16 | First challenger batch | **Ministral 3 8B Instruct 2512** + **Granite 4.1 8B** (mid tier) + **Gemma 4 12B QAT** (high tier) | All Apache-2.0, all with *vendor-published* GGUFs, all strong German — 2–3 challengers per tier without 200 GB of downloads |
| D17 | Challenger auto-recommendation | New manifests ship with **empty `recommended_profiles`** (selectable, never auto-recommended) | Same pattern as the 30B MoE: a challenger must EARN promotion via the Phase-29 benchmark before the recommender offers it |
| D18 | Incumbent refresh | Evaluate **Qwen3-4B-Instruct-2507** as a 4th Phase-28 manifest (probably also 30B-A3B-2507) | Report data: the 2507 4B beats the *original* 8B on most axes — possibly the cheapest quality win in the whole plan. ⚠️ 2507 is instruct-only (no hybrid thinking) — interacts with Phase-20 depth modes, see §4.4 |
| D19 | Quality benchmark = judge-free, ours | Hand-rolled **German/English grounded-QA set** (`eval/rag_de_en.jsonl`, ~50–100 items) + deterministic string/F1/citation/abstain scoring; `llama-bench` for speed | No cloud judge (hard rule); tests exactly what the product does (RAG + citations + abstention); no new toolchain (lm-eval-harness needs Python, not installed — optional appendix only) |
| D20 | Benchmark form | **Manual protocol doc first** (`docs/model-benchmarks.md` + a results CSV convention); a `scripts/benchmark-models.*` automation only if the manual loop proves annoying | One developer, 2–3 laptops; don't build automation before the protocol has run once |
| D21 | Big/opt-in slot + embeddings | **Phase 30, outline only** — Gemma 4 26B-A4B vs the incumbent Qwen3 30B-A3B; Granite Embedding R2 small as the only near-drop-in embedder | MoE comparisons need Phase-29 numbers first; embedder swap forces a reindex story — separate, later |
| D22 | License gate posture | Every new manifest lands with a **real `license_review` record** (approved, with source URLs) before merge; in-app download of non-approved stays behind the Phase-18 acknowledgment checkbox | Licensing is the #1 disqualifier; the review work is cheap now (all picks verified Apache-2.0) and mandatory before any drive bundles them |
| — | New npm deps / code changes | **None expected for Phase 28** (manifest-only); Phase 29 adds eval data + docs (+ maybe scripts); Phase 30 TBD | Adding a chat model is manifest-only by design (model-policy) |

**Disqualified (do not revisit without new facts):** EXAONE 4.x (NC license), Ministral
8B-Instruct-**2410** (Mistral Research License, non-commercial — the `-2512` name-twin trap),
Phi-4 (MIT but explicitly not multilingual → fails the German requirement), Mistral Large 3
(Apache but 675B — over every RAM ceiling). **Parked, not disqualified:** Llama 3.x (community
license workable but encumbered vs. all-Apache alternatives), GLM-4 (MIT, German quality
unproven — a fine Phase-29 extra if curiosity strikes), Gemma 3 (custom Gemma Terms —
superseded by Apache-2.0 Gemma 4, which our b9585 runtime supports).

## 2. Hard rules (these bound every choice)

- **No model weights in git; manifests are the catalog.** Adding a model = one YAML in
  `model-manifests/chat/` with a `download` block + `license_review` (model-policy).
- **Verify-before-trust:** hashes start as `REPLACE_WITH_REAL_HASH`, get promoted via
  `verify-models --generate` after the first real fetch — same flow as the Qwen manifests.
- **License gate:** nothing bundles on a sold drive without `license_review.status: approved`;
  the review must record license, commercial-use, redistribution, attribution, and
  **quantization provenance** (vendor GGUF vs third-party requant).
- **Offline forever:** all fetching is the drive-builder's machine or the triple-gated Phase-18
  in-app downloader. The benchmark protocol must run with Wi-Fi off (pre-download eval data).
- **No cloud judge, no telemetry:** quality scoring is deterministic local string math; results
  stay local (committing summary CSVs to `eval/results/` is fine — they contain no user data).
- **Friendly copy (spec §11.4)** if any of this surfaces in UI (it mostly doesn't — challengers
  appear on the Models screen exactly like today's non-recommended models).

## 3. Verified research facts (2026-06-10 — what the plan rests on)

1. **Our pinned llama.cpp `b9585` is the 2026-06-09 release** (confirmed from
   `model-manifests/runtime-sources.yaml` + the GitHub tag) — NOT a late-2025 build. Therefore
   every candidate below runs on the runtime we already ship, **including Gemma 4** (needs
   ~b8607, April 2026). No runtime bump required for any phase of this plan.
2. **Gemma 4 is Apache-2.0** — first Gemma generation under an OSI license (Gemma 3 and earlier
   keep the custom Gemma Terms). Verified: Google blog
   (<https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/>), Google Open
   Source Blog (<https://opensource.googleblog.com/2026/03/gemma-4-expanding-the-gemmaverse-with-apache-20.html>).
   Official Google GGUF (QAT Q4_0): <https://huggingface.co/google/gemma-4-12B-it-qat-q4_0-gguf>.
3. **The entire Mistral 3 / Ministral 3 (2512) family is Apache-2.0** — verified on the official
   model card (<https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512>) and
   <https://mistral.ai/news/mistral-3/>. **Mistral publishes an official GGUF repo**
   (<https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512-GGUF>) — use it, not a
   third-party requant. ⚠️ The Oct-2024 `Ministral-8B-Instruct-2410` is **non-commercial**
   (Mistral Research License); the manifest pins the exact `-2512` URL so the trap is structural,
   but the license review must name it.
4. **Granite 4.1 is Apache-2.0 with official IBM GGUFs.** Repo naming gotcha: the instruct
   variant lives at <https://huggingface.co/ibm-granite/granite-4.1-8b-GGUF> (NO `-instruct`
   suffix — `granite-4.1-8b` *is* the instruct-tuned model). German is one of 12 officially
   supported languages. Dense decoder → trivially compatible with b9585.
5. **Our incumbents are the ORIGINAL Qwen3 instruct models** (hybrid thinking,
   `Qwen/Qwen3-*-GGUF`), not the 2507 refresh. Report benchmark table (Qwen3-VL tech report,
   <https://arxiv.org/pdf/2511.21631>): 4B-Instruct-**2507** scores MMLU-Pro 69.6 / IFEval 83.4 /
   MMLU-ProX 61.6 vs the original 4B's 58.0 / 81.2 / 49.6 — i.e. above the *original 8B*. Basis
   for D18.
6. **`--jinja` is already in `CHAT_SERVER_ARGS`** (`runtime/llama.ts`, Phase 20) — the server
   applies each GGUF's embedded chat template; we never hand-roll prompt formats. New-model
   bring-up therefore only needs a smoke check that the template renders (no code change
   expected). `--reasoning-format deepseek` is a no-op for non-thinking models.
7. **Candidate quality/speed expectations** (report; to be replaced by OUR Phase-29 numbers):
   Ministral 3 8B ≈ Qwen3 8B class, 256k ctx, multimodal-ignored; Granite 4.1 8B ≈ same class,
   128k ctx, strongest license/provenance story; Gemma 4 12B ≈ Qwen3 14B class, 140+ languages,
   QAT Q4_0 (higher quality than naive Q4 at similar size); Mistral Small 3.2 24B (Apache,
   ~14 GB) is the dense quality ceiling but CPU-slow → Phase-30 candidate, not wave 1.
8. **Embeddings:** our pipeline is built around the E5-small manifest's **384 dims**; switching
   embedders forces a reindex (the Phase-17 vector-tag rule keeps spaces from mixing meanwhile).
   **Granite Embedding R2 small (~97M, 384 dims, Apache-2.0)** is the only near-drop-in
   candidate; BGE-M3 / Qwen3-Embedding-0.6B are 1024-dim (Qwen3 truncatable to 384 via MRL) —
   all Phase-30 material.

The full candidate report (incl. the disqualification table, per-model dossiers, and the source
list) is an external working artifact; this plan embeds everything load-bearing.

---

## 4. Phase 28 — catalog wave 1 (manifest-only)

**Goal:** three Apache-2.0 challengers (+ optionally the 2507 incumbent refresh) installable
through every existing path — fetch scripts, in-app downloader, Models screen — with real
license reviews, real hashes, and a per-model bring-up smoke. **No code changes expected.**

### 4.1 New manifests

Create under `model-manifests/chat/` (fields per model-policy; sizes/byte counts pulled from the
HF repo file listings at authoring time, hashes promoted after first fetch):

| Manifest id (proposed) | Source (download.url repo) | ~Q4 size | min/rec RAM | Notes |
|---|---|---|---|---|
| `ministral3-8b-instruct-2512-q4` | `mistralai/Ministral-3-8B-Instruct-2512-GGUF`, Q4_K_M file | ~5 GB | 16 / 16 | Vendor GGUF; pin the `-2512` URL; text-only use (ignore any mmproj vision file — do NOT list it in the manifest) |
| `granite-4.1-8b-q4` | `ibm-granite/granite-4.1-8b-GGUF`, Q4_K_M file | ~5 GB | 16 / 16 | Vendor GGUF; repo name has no `-instruct` (it IS instruct) |
| `gemma4-12b-it-qat-q4` | `google/gemma-4-12B-it-qat-q4_0-gguf` | ~7–8 GB | 16 / 32 | Vendor QAT **Q4_0** (not Q4_K_M — that's fine, `format: gguf` is what the validator checks); mirror Qwen3-14B's RAM numbers, confirm against §5.2 memory runs |

Shared field choices: `runtime: llama_cpp`, `format: gguf`, `license: apache-2.0`,
`supports_thinking_mode: false` (none has Qwen-style hybrid thinking — Phase-20 depth modes
degrade gracefully: Deep simply behaves like Balanced), `bundled_on_preconfigured_drive: false`,
**`recommended_profiles: []`** (D17), `sha256: REPLACE_WITH_REAL_HASH` until first fetch.

### 4.2 License reviews (D22 — done at authoring time, not download time)

Each manifest's `license_review` lands as `approved` with notes recording: license verified
Apache-2.0 (URL from §3), redistribution permitted, attribution = ship LICENSE/NOTICE
(`download.license_url`), **quantization published by the model vendor itself** (all three picks
— that's why they were picked). The Ministral review additionally names the `-2410`
non-commercial trap. Format precedent: `qwen3-4b-instruct-q4.yaml`.

### 4.3 Bring-up checklist (per model, on the dev box or `D:\` test drive)

1. Fetch via `scripts/fetch-models` (or the in-app downloader — exercises Phase 18 on a real
   new manifest); `verify-models --generate` → promote the real `sha256`.
2. Model appears `installed` on the Models screen; RAM badge sane; select + start.
3. Chat smoke: template renders correctly through `--jinja` (no leaked role tokens / template
   artifacts in output), streaming + stop work, **German prompt answered in German**.
4. RAG smoke: grounded answer with citations on the standard test corpus; abstention on an
   unanswerable question (the `NO_DOCUMENT_CONTEXT_ANSWER` path is model-independent, but the
   citation-following behavior is not).
5. Depth-mode sanity: Fast/Balanced/Deep all produce answers (no thinking expected).
6. Note any quirk in the manifest comment block (the Qwen manifests' style).

### 4.4 D18 — the Qwen3 2507 incumbent refresh (decide during the phase)

Add `qwen3-4b-instruct-2507-q4` as a **fourth challenger manifest** (same empty
`recommended_profiles`) rather than touching the existing default's manifest. The original 4B
stays the default until Phase-29 numbers exist. Interaction to check before promoting 2507 to
default: it has **no hybrid thinking** (`supports_thinking_mode: false`) — promoting it would
make Deep mode a no-op on the default model, which is a product decision, not a bug
(record the outcome here). If the 2507 GGUF repo isn't vendor-published, fall back to the
established-quantizer rule and say so in the review.

### 4.5 Done when

Tests green (no code changed → suite proves manifests validate), the 3–4 new models install +
pass §4.3 on at least one machine, `docs/model-policy.md`'s catalog table gains the challengers
(marked "challenger — not auto-recommended"), README catalog updated, BUILD_STATE updated.

---

## 5. Phase 29 — benchmark protocol + first comparison run

**Goal:** one developer can rank every catalog model on a given laptop in ~a day, fully offline,
with numbers comparable across machines and re-runs. Output = `docs/model-benchmarks.md`
(protocol) + `eval/` (data + results) + a promotion/demotion decision for the catalog.

### 5.1 Speed — `llama-bench` (ships in the b9585 archives we already fetch — verify on first run)

Per model × laptop × backend (CPU; Vulkan where shipped): `llama-bench -m <gguf> -p 512,2048,8192
-n 128 -t <physical cores> -r 3 -o csv`, with `-ngl 0` (CPU) vs full offload. Record **pp t/s**
per context size + **tg t/s**. Fixed conditions: AC power, fixed threads, median of 3. MoE note:
tg tracks *active* params, pp + RAM track total.

### 5.2 Memory — peak RSS at the standard RAG window

One realistic run per model at `-c 8192`: Windows = poll Peak Working Set (`Get-Process`),
Linux = `/usr/bin/time -v`, macOS = `/usr/bin/time -l`. **This number calibrates the manifests'
`recommended_min_ram_gb`** (peak RSS + 2–3 GB OS/app headroom ≤ tier RAM) — replace the §4.1
estimates with measured values.

### 5.3 Quality — judge-free, license-clean, local (D19)

- **`eval/rag_de_en.jsonl`** (~50–100 items, authored by us → license-clean by construction):
  short German/English passage + question whose answer is a verbatim span + gold source id;
  **~15% unanswerable items** (gold = abstain). Scoring is deterministic: normalized
  exact-match + token-F1 (German-aware normalization), citation-present / citation-correct /
  grounding (answer string ∈ cited chunk), abstain-rate on unanswerables. Greedy decoding
  (`temperature 0`), fixed seed, run **through the app's real RAG path** where practical (it
  exercises retrieval + reranker + grounding template, which is what users get) — a
  `tests/manual/`-style harness gated on an env var, like `rag-quality.test.ts`, is the
  natural home.
- **Optional appendix, not the gate:** lm-eval-harness MCQ tasks (MMLU/IFEval/Belebele-de/…)
  against `llama-server`'s OpenAI endpoint — requires installing Python on the benchmarking
  machine (dev-time tool; doesn't touch the app's offline guarantee). Only if we want
  literature-comparable numbers.

### 5.4 Results + decision rule

One CSV row per model × laptop × backend in `eval/results/` (columns: pp512/2048/8192 t/s,
tg t/s, peak RSS@8k, RAG EM/F1 de+en, citation-correct %, abstain %, notes). **A challenger
earns `recommended_profiles` promotion** (and a default-model challenge) if at its tier it
(a) beats the incumbent on the German RAG metrics AND citation-correctness at ≥ comparable
tg t/s, or (b) matches quality with materially better license/provenance or lower RAM.
Demotions/removals of losing challengers are equally valid outcomes — the catalog should not
accumulate dead weight (each model is a multi-GB download someone might make).

### 5.5 Done when

Protocol doc exists and has been executed once on ≥ 2 machines (the dev box ± the i7-1185G7
Iris-Xe laptop are the natural pair) covering all incumbents + wave-1 challengers; results CSVs
committed; D17 promotions decided and applied to `recommended_profiles` + the model-policy
table; BUILD_STATE updated. This plan then condenses per the doc lifecycle rule.

---

## 6. Phase 30 — opt-in big slot + embeddings (OUTLINE ONLY — do not start before Phase 29)

- **Big slot shoot-out:** Gemma 4 26B-A4B (Apache, ~4B active → near-4B CPU tg; official Google
  QAT GGUF) and/or Granite 4.0 H-Small (Apache, hybrid-Mamba) vs the incumbent Qwen3 30B-A3B;
  Mistral Small 3.2 24B (Apache, dense ~14 GB) as the dense quality ceiling for 32 GB/GPU
  machines. Same manifest + benchmark machinery; all stay `recommended_profiles: []`.
- **Embeddings:** Granite Embedding R2 small (384-dim, Apache-2.0) is the only candidate that
  avoids a vector-schema question — but ANY embedder swap needs the reindex story surfaced to
  the user (the Phase-17 `staleEmbeddings` / Re-index-all machinery exists and is the hook).
  Needs its own mini-plan: GGUF provenance check, llama.cpp embedding-mode compatibility on
  b9585 (the E5 q8_0 crash precedent — test F16 first), retrieval-quality A/B on the
  `eval/rag_de_en.jsonl` corpus, and a decision on whether 1024-dim models (BGE-M3,
  Qwen3-Embedding) are worth the index migration. Coordinate with
  [`rag-design.md`](rag-design.md) §11 (reranker) — a better retriever may shift the reranker
  cost/benefit.

## 7. Risks / open items

| Risk | Mitigation |
|---|---|
| HF repo layouts / filenames drift between authoring and fetch (the report's "verify at download time" flags) | Manifests pin exact URLs; first fetch + `verify-models --generate` catches drift loudly; §4.1 sizes are re-checked at authoring |
| Gemma 4 GGUF needs a chat-template fix newer than its first upload (report: April-2026 template fixes) | Bring-up step §4.3.3 catches template artifacts; re-download the GGUF if the repo updated it |
| A challenger underperforms incumbents everywhere | Fine — D17 means users never saw it recommended; remove the manifest, record the numbers |
| Benchmark machines too few/too similar | The GPU hardware matrix (BUILD_STATE §5 item 1b) machines double as benchmark hosts over time; protocol records machine facts so late runs slot in |
| Eval set too small to separate models | 50–100 grounded-QA items separate citation/abstention behavior well even when MCQ scores tie; grow the set before trusting small deltas (record per-item outputs, not just aggregates) |
| `llama-bench` missing from a pinned archive | Verified on first §5.1 run; fallback = time `llama-cli`/server streaming ourselves (we already measure tok/s in-app) |
