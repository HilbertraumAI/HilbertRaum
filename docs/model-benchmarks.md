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

**Remaining to close the phase:** Part B (`llama-bench`) + Part C (peak-RSS) on both machines →
join into the combined CSVs; then apply §5.4 (promote 2507 / others as the speed-RAM picture
allows, decide the Gemma flag, set measured `recommended_min_ram_gb`) and condense.
