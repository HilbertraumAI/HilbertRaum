# Model benchmark protocol (Phase 29)

_The repeatable, fully-offline, judge-free protocol for ranking every catalog chat model on a
given laptop in ~a day, with numbers comparable across machines and re-runs. Authored for
[`model-catalog-expansion-plan.md`](model-catalog-expansion-plan.md) §5 (D19/D20); apply the
§5.4 decision rule with the results._

## 0. Hard constraints (do not violate)

- **Offline, Wi-Fi OFF.** All eval data is committed (`eval/`); all weights + the runtime are
  already on the drive (Phase 28). Nothing here touches the network.
- **No cloud judge, no telemetry.** Quality is scored by deterministic local string math
  ([`apps/desktop/tests/eval/score.ts`](../apps/desktop/tests/eval/score.ts)). Only summary
  CSVs + a per-item audit dump are written, and only those go in git — no user data, no weights.
- **Greedy decoding** (`temperature 0`) everywhere for reproducibility. (llama.cpp greedy is
  near-deterministic, not bit-exact across builds; record the median where a metric varies.)

## 1. Machines + fixed conditions

Run on **≥ 2 machines** (§5.5): the dev box + the **i7-1185G7 / Iris-Xe laptop** are the
natural pair. For each run record, in the CSV `notes`, the machine label, CPU, total RAM,
backend (cpu | vulkan), the runtime build (`runtime/llama.cpp/<os>/.paid-runtime.json`), and
the thread count. Fixed conditions: **AC power**, no other heavy load, fixed `-t <physical
cores>`, median of repeated runs.

The drive root used below is the provisioned Windows `D:\` (or any root with
`runtime/llama.cpp/<os>/llama-server` + `models/{chat,embeddings,reranker}/*.gguf`).

---

## 2. Part A — Quality (the grounded-QA harness)

The gate metric. Runs the hand-authored German/English grounded-QA set through the app's
**real RAG path** — the same E5 embedder + bge reranker + grounding template + chat runtime
users get — for every chat GGUF on the drive, scoring each answer deterministically.

**Data** (committed, regenerate with `node eval/build.mjs`):
- `eval/corpus_de_en.jsonl` — 60 passages across 16 documents (7 parallel DE/EN office +
  civic/everyday pairs + 2 German-only civic docs), with deliberate distractors.
- `eval/rag_de_en.jsonl` — 100 items: 60 DE / 40 EN, 40 parallel DE/EN pairs + 20 German-only,
  **15 unanswerable** (gold = abstain). All prose is original → license-clean.

**Run:**
```powershell
$env:PAID_MODEL_EVAL = "D:\"
$env:PAID_EVAL_MACHINE = "devbox"      # or "i7-1185G7"
$env:PAID_EVAL_BACKEND = "cpu"          # or "vulkan"
# $env:PAID_EVAL_MODEL = "granite-4.1-8b-q4.gguf"   # optional: a single model
cd apps\desktop
npx vitest run tests/manual/model-eval.test.ts
```
Retrieval is embedded **once** (E5) and reranked once, so it is **identical across chat
models** — every cross-model delta in EM / citation-correctness / abstention is the chat model
following the grounded prompt. Each model is loaded at `-c 8192` and answers all 100 items at
`temperature 0`, `maxTokens 384`.

**Outputs** (in `eval/results/`, `<machine>-<backend>`):
- `…-quality.csv` — one row per model (the QA columns, header from `QA_CSV_HEADER`).
- `…-items.jsonl` — every raw answer + its score, for auditing the heuristic abstention calls.

**Metrics** (per model; DE/EN split so the **D18** German gap is directly readable):

| Column | Meaning | Better |
|---|---|---|
| `em_rate` | answer contains a gold span (over answerable) | higher |
| `mean_f1` | token-F1 vs gold span (over answerable) | higher |
| `citation_correct_rate` | cited the gold document (over answerable) | higher |
| `grounded_rate` | gold span ∈ a cited chunk (over answerable) | higher |
| `over_abstain_rate` | wrongly declined an answerable item | lower |
| `abstain_rate_unans` | correctly declined an unanswerable item | **higher** |
| `hallucination_rate` | answered an unanswerable item anyway | **lower** |
| `em_rate_de` / `em_rate_en` | EM split by language | higher; small gap |
| `f1_de` / `f1_en` | F1 split by language | higher; small gap |

Abstention is detected by a curated DE/EN refusal-phrase list (heuristic — that's why every
raw answer is dumped). Audit borderline unanswerable items in `…-items.jsonl` before trusting
`abstain_rate_unans` / `hallucination_rate`.

**Re-scoring after a detector change (no model re-run):** when the abstention phrase list is
improved, regenerate the numbers from the committed `…-items.jsonl` dumps:
```powershell
node eval\rescore.mjs   # writes eval/results/<stem>-quality-rescored.csv from every dump
```
`rescore.mjs` imports the SAME `text.mjs` the harness uses, so a re-score and a fresh run agree.
This is exactly how the first run was corrected — see §6.

---

## 3. Part B — Speed (`llama-bench`)

> **One-shot loop (Parts B + C together, all models):**
> ```powershell
> scripts\benchmark-speed.ps1 -Root D:\ -Machine i7-1185G7 -Backend cpu
> ```
> Runs `llama-bench` + the peak-RSS probe for every chat GGUF on the drive and writes
> `eval/results/<machine>-<backend>-speed.csv` (`model, backend, threads, pp512/2048/8192_tps,
> tg_tps, peak_rss_gib, suggested_min_ram_gb`). Numbers are invariant-culture-formatted (German
> locale safe). The per-model commands below are the underlying reference / fallback.

`llama-bench` ships in the b9585 archives we already fetch (`runtime/llama.cpp/<os>/`; verify
on first run — fallback in §5 risk table = time `llama-server` streaming, which we already
measure in-app). Per model × backend:

```powershell
# CPU
D:\runtime\llama.cpp\win\llama-bench.exe -m D:\models\chat\<model>.gguf `
  -p 512,2048,8192 -n 128 -t <physical cores> -ngl 0 -r 3 -o csv
# Full GPU offload (where Vulkan is shipped) — drop -ngl 0 (b9585 auto-offloads with --fit on)
D:\runtime\llama.cpp\win\llama-bench.exe -m D:\models\chat\<model>.gguf `
  -p 512,2048,8192 -n 128 -t <physical cores> -r 3 -o csv
```
Record **pp t/s** per context size and **tg t/s** (median of 3). MoE note: `tg` tracks *active*
params; `pp` + RAM track *total*.

---

## 4. Part C — Memory (peak RSS → `recommended_min_ram_gb`)

One realistic `-c 8192` run per model, polling peak working set. The Windows poll is the fiddly
bit, so use the helper:

```powershell
scripts\measure-peak-rss.ps1 -Root D:\ -Model granite-4.1-8b-q4.gguf -Ctx 8192
```
It starts `llama-server` at `-c 8192`, sends one generation, reads `PeakWorkingSet64`, prints
peak RSS in GiB and a suggested `recommended_min_ram_gb` (**peak RSS + 3 GiB OS/app headroom**,
rounded up). Linux = `/usr/bin/time -v` (Maximum resident set size); macOS = `/usr/bin/time -l`.

**This measurement REPLACES the §4.1 estimates** in each manifest's `recommended_min_ram_gb` /
`recommended_max_ram_gb` — update the manifests with the measured tier on the highest-RAM
machine that ran it.

---

## 5. Combined results + the decision rule

The deliverable (§5.4) is **one row per model × laptop × backend**. Join the Part-A QA columns
with the Part-B/C speed + RSS columns into `eval/results/<machine>-<backend>.csv`:

```
model, backend, pp512_tps, pp2048_tps, pp8192_tps, tg_tps, peak_rss_gib,
em_rate, mean_f1, citation_correct_rate, grounded_rate, over_abstain_rate,
abstain_rate_unans, hallucination_rate, em_rate_de, em_rate_en, f1_de, f1_en, notes
```
The harness writes the QA half (`…-quality.csv`); paste the speed/RSS numbers alongside. Commit
the combined CSVs + the per-item JSONL.

**Apply §5.4** — a challenger earns `recommended_profiles` promotion (and a default-model
challenge) at its tier when it either (a) beats the incumbent on the German RAG metrics AND
`citation_correct_rate` at ≥ comparable `tg_tps`, or (b) matches quality with materially better
license/provenance or lower RAM. Losing challengers are demoted/removed — the catalog must not
accumulate dead multi-GB downloads. Then update:
- each promoted manifest's `recommended_profiles` + the [`model-policy.md`](model-policy.md)
  catalog table (drop the "challenger — not auto-recommended" note),
- every manifest's `recommended_min_ram_gb` with the Part-C measured value,
- **D18:** decide whether `qwen3-4b-instruct-2507-q4` beats the original 4B (and the original
  8B) — especially on `em_rate_de` / `f1_de` (the §4.6 German wobble). Promoting it to default
  is a product call because 2507 has no hybrid thinking (Deep becomes a no-op on the default).
- **Gemma flag:** decide whether to flip `gemma4-12b-it-qat-q4`'s `supports_thinking_mode` to
  `true` based on its Deep-mode quality numbers (it already honours `enable_thinking`; §4.6).

Record the outcome here, then condense this plan per the CLAUDE.md doc lifecycle rule.

---

## 6. First-run findings (2026-06-11 — i7-1185G7, CPU; QA half only)

First QA execution: all 8 catalog chat models on the i7-1185G7 laptop (CPU/Vulkan-DL build),
plus a single-model reproducibility check on the dev box. **Speed (Part B) + peak-RSS (Part C)
not yet run** — they remain before the phase closes and before §5.4 can be fully applied (the
rule needs `tg t/s`). Authoritative numbers are the **`*-quality-rescored.csv`** (see below).

- **Reproducible across machines.** `qwen3-4b-instruct-2507-q4` scored bit-identically on the
  dev box and the i7 (EM 0.9765 / F1 0.3613 / 1 hallucination) — greedy decoding is
  deterministic, so QA quality is machine-independent and one machine suffices for it (the 2nd
  machine matters for speed/RAM, not quality).
- **Grounded accuracy saturates → it does NOT separate the catalog.** EM 95–98% for every model,
  German ≈ English (em_de ≈ 0.94–0.96, em_en = 1.00). All eight are competent grounded
  extractors; the catalog separates on *hallucination-resistance*, not accuracy.
- **`citation_correct_rate` is a flat 0.9882 for every model — it is a RETRIEVAL property, not a
  model one.** `generateGroundedAnswer` persists the citations computed by retrieval (not parsed
  from the model's `[Sn]`), so this column is constant across chat models and cannot rank them.
  ⇒ In this architecture the §5.4 "citation-correctness" clause is a retrieval constant; lean the
  decision on EM/F1 + hallucination-resistance + (pending) speed/RAM instead.
- **The discriminating axis = abstention on the 15 unanswerable items.** Audited genuine
  hallucinations (manually confirmed against the raw dump):

  | Model | Genuine hallucinations / 15 |
  |---|---|
  | ministral3-8b-instruct-2512-q4 | **0** |
  | gemma4-12b-it-qat-q4 | 1 |
  | qwen3-4b-instruct-2507-q4 | 1 |
  | qwen3-30b-a3b-q4 | 1 |
  | qwen3-8b-instruct-q4 | 2 |
  | qwen3-14b-instruct-q4 | 2 |
  | qwen3-4b-instruct-q4 (current default) | 3 |
  | granite-4.1-8b-q4 | 3 |

  Two hard item families caused every failure: (a) **`contract-penalty`** — the invoice's "2%
  late-payment fee" misread as the agreement's (nonexistent) late-*delivery* penalty (fails
  almost everyone, incl. Gemma's one miss); (b) **`hr-sick`** — answering with the 20 *vacation*
  days for a paid-*sick*-days question (trips the Qwen family + Granite; Gemma / Ministral / 2507
  correctly refuse). ±1 item residual on borderline hedged answers (e.g. qwen3-30b's caveated
  `en-contract-penalty`).
- **D18 (the incumbent-refresh question): 2507 ≥ the original 4B on every axis** — EM 0.9765 vs
  0.9647, F1 0.3613 vs 0.3277, em_de 0.9608 vs 0.9412, f1_de 0.3698 vs 0.3400, hallucinations
  1 vs 3. It also matches the original **8B** on EM with higher F1 and fewer hallucinations
  (1 vs 2). The §4.6 bring-up "German wobble" did **not** appear on the grounded RAG path (2507
  has the *top* German F1 here) — that wobble is an open-/parametric-knowledge issue, not a
  grounding one. Promoting 2507 over the original 4B as default is supported on quality; the only
  caveat stays the product one (2507 has no hybrid thinking → Deep becomes a no-op). Confirm once
  speed/RAM are in.
- **Gemma `supports_thinking_mode` flag: not informed by this run** (grounded answers run
  balanced, thinking off). Gemma's strong abstention is a general quality signal, but the flag
  needs a separate thinking-quality check.
- **Methodology note — the abstention detector was hardened mid-analysis.** The v1 phrase list
  overcounted hallucination ~2–3× (it missed "none of the documents mention", "does not
  specify", "nicht ausreichend", "nicht im bereitgestellten Dokument enthalten", bolded Ministral
  refusals, …). Fixed in `apps/desktop/tests/eval/text.mjs` (+ regression tests), then re-scored
  from the dumps via `eval/rescore.mjs` — no models re-run. The `*-quality.csv` files are the raw
  v1-detector output; **`*-quality-rescored.csv` is authoritative** and a fresh run now reproduces
  it.

### 6.1 Speed + RSS (i7-1185G7, CPU) and the decisions applied

Speed/RSS were measured on the i7 (`scripts/benchmark-speed.ps1`; combined row in
`eval/results/i7-1185G7-cpu.csv`). Decode (tg t/s) and peak RSS, by tier:

| Tier | Model | tg t/s | peak RSS (GiB) | min RAM set |
|---|---|---|---|---|
| 4B | qwen3-4b (default) · qwen3-4b-2507 | 6.3 · 6.2 | 5.2 · 5.2 | 8 (validated) |
| 8B | qwen3-8b · **ministral** · granite | 3.9 · **4.5** · 4.3 | 8.3 · 8.7 · 8.9 | 12 |
| 12–14B | qwen3-14b · **gemma4** | 2.1 · **3.0** | 10.6 · 10.6 | 14 |
| 30B-MoE | qwen3-30b-a3b | 4.7 | 10.3† | 24 (held) |

†MoE + mmap undercounts resident set (the file is ~18.6 GB); `recommended_min_ram_gb` held at 24.

**Benchmark verdicts (tier winners):** Ministral 3 8B (best 8B — 0 hallucinations + fastest);
Gemma 4 12B (beats Qwen3 14B on every axis); Qwen3-4B-2507 (beats the original 4B on every axis,
D18). Granite 4.1 8B lost its tier (most 8B hallucinations, lowest F1).

**What was actually applied to the catalog:**
- **`recommended_min_ram_gb` recalibrated** from measured peak RSS — 8B 16→12, 12–14B 16→14
  (4B held at 8, 30B held at 24 for the MoE/mmap caveat). This is **live**. `recommended_ram_gb`
  left unchanged (changing it shifts the quality-blind best-fit — see §6.2).
- **The original `qwen3-4b-instruct-q4` stays the bundled default** (user decision) — it has
  hybrid thinking, so Deep keeps working out of the box on low-end machines; 2507 is instruct-only.
- **Promotions made LIVE via `recommendation_rank`** (the §6.2 follow-up, done same session):
  each manifest carries a rank (winner = higher) that the now quality-aware `recommendModelIdByRam`
  uses as the tiebreak. Real-hardware effect: **≤12 GB → Qwen3-4B (default), 16 GB → Ministral,
  ≥32 GB → Gemma 4**; Granite + the 30B MoE are never auto-recommended. `recommended_profiles`
  stays `[]` (the picker is RAM-best-fit, not profile-based).
- **Gemma `supports_thinking_mode` FLIPPED to `true`** (run #2, `tests/manual/gemma-thinking.test.ts`,
  i7): Deep matched Balanced 8/8 on reasoning items (incl. the snail/bat-ball/syllogism traps) with
  coherent chain-of-thought → Deep is safe to offer. Caveat: both modes hit 100%, so the small set
  can't show Deep *strictly* helps; it shows Deep deliberates well and never regresses. Gemma 4 is
  the only thinking-capable challenger; the composer now offers "Thorough" for it.
- **Licence correction:** the whole catalog is **Apache-2.0** (Qwen3 included) — the challengers'
  edge is quality + speed, *not* licence. Manifest comments that implied otherwise were fixed.

### 6.2 Recommender architecture finding — FIXED (quality-aware tiebreak)

The benchmark exposed that the production recommender `recommendModelIdByRam` was **quality-blind**:
it picked the *largest* model whose `recommended_ram_gb` fits, tie-broken by **disk size**, and
**ignored `recommended_profiles`** (that list is only the legacy no-RAM path). Concretely, on a
16 GB machine it would have recommended **granite** (largest-disk 8B at `recommended_ram_gb: 16`) —
the run's *worst* 8B.

**Fix applied (Phase 29):** a new optional manifest field **`recommendation_rank`** (integer,
default 0; higher = preferred) is now the tiebreak in `recommendModelIdByRam`, applied AFTER the
capacity fit (comfortable `recommended_ram_gb`, or the lightest runnable) and BEFORE disk size.
Default 0 preserves the old behaviour for every other manifest, so legacy callers/tests are
unchanged. Ranks encode the benchmark verdict folded with the product decisions: Qwen3-4B = 2
(default, keeps Deep) > 2507 = 1; Ministral = 2 (8B winner) > Qwen3-8B = 1 > Granite = 0; Gemma 4
= 2 (12–14B winner) > Qwen3-14B = 1; 30B MoE = 0 (opt-in). Net result on real hardware: **≤12 GB →
Qwen3-4B, 16–24 GB → Ministral, ≥32 GB → Gemma 4**; Granite and the 30B are never auto-recommended.
Covered by `tests/integration/benchmark.test.ts` (real-manifest picks) + `models.test.ts` (the
tiebreak unit tests).

**Remaining to close the phase:** the Gemma thinking-quality check (run #2 → maybe flip the flag);
optionally the devbox speed/RSS run for the formal ≥2-machine done-when (QA is machine-independent
and already reproduced; RSS is too, so this is for completeness); then condense the plan.
