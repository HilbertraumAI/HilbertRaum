# Model benchmark protocol (Phase 29)

_The repeatable, fully-offline, judge-free protocol for ranking every catalog chat model on a
given laptop in ~a day, with numbers comparable across machines and re-runs. Authored for
Phase 29; decisions D19/D20 and the catalog design record are §7; apply the §5 decision rule
with the results._

> **Not to be confused with** [`benchmark.md`](benchmark.md) — that doc is the in-app
> **hardware** probe (can this machine run a model); this doc is the offline **model-quality**
> protocol and measured speed/RAM/quality results.

## 0. Hard constraints (do not violate)

- **Offline, Wi-Fi OFF.** All eval data is committed (`eval/`); all weights + the runtime are
  already on the drive (Phase 28). Nothing here touches the network.
- **No cloud judge, no telemetry.** Quality is scored by deterministic local string math
  ([`apps/desktop/tests/eval/score.ts`](../apps/desktop/tests/eval/score.ts)). Only summary
  CSVs + a per-item audit dump are written, and only those go in git — no user data, no weights.
- **Greedy decoding** (`temperature 0`) everywhere for reproducibility. (llama.cpp greedy is
  near-deterministic, not bit-exact across builds; record the median where a metric varies.)

## 1. Machines + fixed conditions

Run on **≥ 2 machines**: the dev box + the **i7-1185G7 / Iris-Xe laptop** are the
natural pair. For each run record, in the CSV `notes`, the machine label, CPU, total RAM,
backend (cpu | vulkan), the runtime build (`runtime/llama.cpp/<os>/.hilbertraum-runtime.json`), and
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
$env:HILBERTRAUM_MODEL_EVAL = "D:\"
$env:HILBERTRAUM_EVAL_MACHINE = "devbox"      # or "i7-1185G7"
$env:HILBERTRAUM_EVAL_BACKEND = "cpu"          # or "vulkan"
# $env:HILBERTRAUM_EVAL_MODEL = "granite-4.1-8b-q4.gguf"   # optional: a single model
# $env:HILBERTRAUM_EVAL_SPECULATIVE = "mtp"                # optional: run WITH the #182 MTP flags
cd apps\desktop
npx vitest run tests/manual/model-eval.test.ts
```
`HILBERTRAUM_EVAL_SPECULATIVE=mtp` spawns each scored model with the same code-owned flag pair
the start ladder's rung 1a passes (`MTP_SERVER_ARGS`, imported — this harness composes
`createLlamaRuntime` directly and never walks the ladder, so without the knob it is structurally
unable to score a model the way rung 1a runs it). Pair it with `HILBERTRAUM_EVAL_MODEL` (the
harness enumerates GGUF *files* and cannot tell which weight carries a draft head) and a distinct
`HILBERTRAUM_EVAL_MACHINE` label, so the run gets its own CSV stem instead of overwriting the
pre-MTP baseline. **The comparison is score parity within cross-run tolerance, never byte
identity** — see the §9.4 MTP addendum.

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
on first run — fallback = time `llama-server` streaming, which we already measure in-app).
Per model × backend:

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

**This measurement REPLACES the pre-measurement estimates** in each manifest's `recommended_min_ram_gb` /
`recommended_ram_gb` — update the manifests with the measured tier on the highest-RAM
machine that ran it.

---

## 5. Combined results + the decision rule

The deliverable is **one row per model × laptop × backend**. Join the Part-A QA columns
with the Part-B/C speed + RSS columns into `eval/results/<machine>-<backend>.csv`:

```
model, backend, pp512_tps, pp2048_tps, pp8192_tps, tg_tps, peak_rss_gib,
em_rate, mean_f1, citation_correct_rate, grounded_rate, over_abstain_rate,
abstain_rate_unans, hallucination_rate, em_rate_de, em_rate_en, f1_de, f1_en, notes
```
The harness writes the QA half (`…-quality.csv`); paste the speed/RSS numbers alongside. Commit
the combined CSVs + the per-item JSONL.

**The decision rule** — a challenger earns `recommended_profiles` promotion (and a default-model
challenge) at its tier when it either (a) beats the incumbent on the German RAG metrics AND
`citation_correct_rate` at ≥ comparable `tg_tps`, or (b) matches quality with materially better
license/provenance or lower RAM. Losing challengers are demoted/removed — the catalog must not
accumulate dead multi-GB downloads. Then update:
- each promoted manifest's `recommended_profiles` + the [`model-policy.md`](model-policy.md)
  catalog table (drop the "challenger — not auto-recommended" note),
- every manifest's `recommended_min_ram_gb` with the Part-C measured value,
- **D18:** decide whether `qwen3-4b-instruct-2507-q4` beats the original 4B (and the original
  8B) — especially on `em_rate_de` / `f1_de` (the §7.3 German wobble). Promoting it to default
  is a product call because 2507 has no hybrid thinking (Deep becomes a no-op on the default).
- **Gemma flag:** decide whether to flip `gemma4-12b-it-qat-q4`'s `supports_thinking_mode` to
  `true` based on its Deep-mode quality numbers (it already honours `enable_thinking`; §7.3).

(Both decisions were made — the outcomes are §6.1 and the §7 record.)

---

## 6. First-run findings (2026-06-11 — i7-1185G7, CPU; QA half only)

First QA execution: the 8 benchmarked catalog chat models on the i7-1185G7 laptop (CPU/Vulkan-DL build;
the 9th chat manifest, `qwen3.5-4b-ud-q4kxl`, shipped later and is not yet benchmarked),
plus a single-model reproducibility check on the dev box. Speed (Part B) + peak-RSS (Part C)
followed later the same day — **§6.1**. Authoritative QA numbers are the
**`*-quality-rescored.csv`** (see below).

- **Reproducible across machines.** `qwen3-4b-instruct-2507-q4` scored bit-identically on the
  dev box and the i7 (EM 0.9765 / F1 0.3613 / 1 hallucination) — greedy decoding is
  deterministic, so QA quality is machine-independent and one machine suffices for it (the 2nd
  machine matters for speed/RAM, not quality).
- **Grounded accuracy saturates → it does NOT separate the catalog.** EM 95–98% for every model,
  German ≈ English (em_de ≈ 0.94–0.96, em_en = 1.00). All eight benchmarked models are competent grounded
  extractors; the catalog separates on *hallucination-resistance*, not accuracy.
- **`citation_correct_rate` is a flat 0.9882 for every model — it is a RETRIEVAL property, not a
  model one.** `generateGroundedAnswer` persists the citations computed by retrieval (not parsed
  from the model's `[Sn]`), so this column is constant across chat models and cannot rank them.
  ⇒ In this architecture the decision rule's "citation-correctness" clause is a retrieval
  constant; lean the decision on EM/F1 + hallucination-resistance + speed/RAM (§6.1) instead.
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
  (1 vs 2). The §7.3 bring-up "German wobble" did **not** appear on the grounded RAG path (2507
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
  left unchanged (changing it shifts the quality-blind best-fit — see §6.2). *(Revised 2026-07-11:
  §6.3 recalibrated `recommended_ram_gb` for the 12–14B pair and the 8B once the ranked-only guard
  removed that blocker.)*
- **The original `qwen3-4b-instruct-q4` stays the bundled default** (user decision) — it has
  hybrid thinking, so Deep keeps working out of the box on low-end machines; 2507 is instruct-only.
- **Promotions made LIVE via `recommendation_rank`** (the §6.2 follow-up, done same session):
  each manifest carries a rank (winner = higher) that the now quality-aware `recommendModelIdByRam`
  uses as the tiebreak. Real-hardware effect: **≤12 GB → Qwen3-4B (default), 16–24 GB → Ministral,
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
(Superseded for 20–24 GB by §6.3, 2026-07-11: the 12–14B tier's honest comfortable RAM is 24, so
**≥24 GB → Gemma 4** and Ministral serves 16–20 GB.) Covered by
`tests/integration/benchmark.test.ts` (real-manifest picks) + `models.test.ts` (the
tiebreak unit tests).

**Phase 29 closed 2026-06-11:** the Gemma thinking-quality check ran (flag flipped true) and
the plan was condensed into §7 below. Only the OPTIONAL dev-box speed/RSS sweep remains, for
the formal ≥2-machine completeness (QA and RSS are machine-independent, already reproduced).

### 6.3 The 20–24 GB tier gap — FIXED (issue #48, 2026-07-11)

Issue #48 found that a 20–24 GB machine was recommended the same 8B as a 16 GB machine: every
12–14B model carried `recommended_ram_gb: 32`, so the comfortable-fit stage could never reach the
tier winner even though Gemma 4 12B (measured ~10.6 GiB peak RSS, hard min 14) runs comfortably
with the embedder/reranker/app/OS co-resident on 24 GB. §6.1 had deliberately left
`recommended_ram_gb` unchanged because "changing it shifts the quality-blind best-fit" — that
blocker is what the guard below removes. Two changes, applied together:

- **Data (honest comfortable RAM):** `gemma4-12b-it-qat-q4` and `qwen3-14b-instruct-q4`
  `recommended_ram_gb` 32→**24** (same measured RSS, same physical tier — they must stay in one
  capacity group so the §6.2 rank keeps deciding the tier winner); `qwen3-8b-instruct-q4` 32→**16**
  (measured 8.3 GiB — Ministral's tier; at 32 it would have sat alone in the top capacity group and
  hijacked the ≥32 GB pick once the 12–14B pair moved down).
- **Ranked-only guard (`recommendModelIdByRam`):** within each stage (comfortable, then runnable),
  a **rank-0** model is considered only when **no ranked model fits that stage at all**. Rank stays
  a within-tier tiebreak (capacity-first ordering is unchanged), but a never-evaled or
  benchmark-loser model can no longer win on capacity alone — which §9's "never auto-recommend
  rank 0" invariant previously got only from careful per-manifest RAM alignment (the fast-tier
  2B/0.8B manifests carry deliberately tier-aligned RAM lines for exactly that reason; with the
  guard, honest RAM lines become safe to ship **with** their eval). A role with no ranks at all
  (embeddings/reranker/…) is unchanged.

Net mapping (asserted in `benchmark.test.ts` at 8/12/16/20/24/32): **≤12 GB → Qwen3-4B,
16–20 GB → Ministral, ≥24 GB → Gemma 4**; Granite, the MoEs, and every rank-0 Qwen3.5 model are
never auto-recommended. The rest of issue #48 — promoting the Qwen3.5/3.6 generation — is NOT a
rank edit: it stays gated on the §9 eval + §9.1 smoke (owner, offline, real weights).
*(Superseded 2026-07-12: §6.4 promoted the Qwen3.5/3.6 generation by owner decision; the
mapping above is the historical Phase-29/issue-48 state.)*

### 6.4 Newest-Qwen promotion (owner decision, 2026-07-12)

**The decision.** The owner promoted the newest-generation Qwen models to `recommendation_rank: 3`
per RAM tier: `qwen3.5-4b-ud-q4kxl` (≤12 GB), `qwen3.5-9b-ud-q4kxl` (16–20 GB), `qwen3.6-27b-q4`
(24 GB, productized from its local-test stub with a real unsloth download source + HF-LFS hash),
and `qwen3.6-27b-q5` (≥32 GB, same productization). Net mapping (asserted in `benchmark.test.ts`
and `committed-catalog.test.ts`): **≤12 GB → Qwen3.5 4B, 16–20 GB → Qwen3.5 9B, 24 GB →
Qwen3.6 27B Q4, ≥32 GB → Qwen3.6 27B Q5**. Granite, both MoEs, the fast-tier 2B/0.8B, and the
superseded incumbents stay selectable, never auto-recommended. *(Amended 2026-08-16: the same
standing preference handed the 24 GB and ≥32 GB tiers to `qwen3.8-27b-q4` / `qwen3.8-27b-q5` at
the §9.4 wave ratification — full generational handover, the Qwen3.6 pair to rank 1. The 4B/9B
rows above are unchanged; the 12–15 GB row belongs to the #153 E2B promotion, §6.5.)*

**The rationale (recorded verbatim so the trade-off stays visible).** A subjective owner
judgment: newer model generations are expected to be better than the ones they replace (training
data, instruction tuning, and multilingual quality all move forward), and the current local
evidence is not strong enough to override that prior. The owner weighed the §9 tester eval and
judged it directional, not decisive: its primary quality signal (F1) is length-confounded (the
§9 scorer caveats; Qwen3.5's verbose house style), EM rates across the promoted set and the
incumbents are all high and close (the widest promoted-vs-incumbent EM gap is ~2.4 points — the
9B's .9765 vs Ministral's .9529), and the runs are single-machine, single-run, pending the
§5-item-8 scorer fixes. Follow-up benchmarks on BOTH axes (rescored quality, plus the missing
speed/peak-RSS rows) are planned and stay recorded as open work below. Where the eval IS clear
it AGREES with the promotion at the top end: Qwen3.6 27B Q5/Q4 lead the quality table outright
(F1 .3573/.3523, zero unanswerable-set hallucinations for Q5).

**What this supersedes.** The §-9/D17 rule "a challenger earns promotion only via the local
eval" is amended: the owner may also promote on product/positioning grounds, and the honest
eval standing must then be recorded next to the rank (done, in each promoted manifest and
here). Specifically: the 4B FAILED its §9 bar against `qwen3-4b-instruct-q4` (F1 .2728 vs
.3277, EM tied at .9647 — a cross-run i9-vs-i7 comparison) and the 9B actually EDGED Ministral
on F1/EM within cross-run tolerance (F1 .3152/.3124 vs Ministral's Phase-29 i7 .3111, EM .9765
vs .9529) but fell once for the `en-contract-penalty` invoice-distractor trap where Ministral's
record is clean — the tester's basis for proposing rank 1 under it (§9); they are recommended
anyway by this decision. The b9849 load gate is satisfied for all four
(the #48 tester ran the whole wave on the b9849 binary; the 4B additionally loaded + streamed
through the app from the portable drive on 2026-07-12).

**Still open after this decision** (unchanged from §5 item 8): the scorer follow-ups
(refusal-phrase list, `rescore.mjs` rerun), owner ratification of the tester CSVs as canonical
(the raw CSVs are now committed under `eval/results/i9-9900X-vulkan-*`), **speed + peak-RSS
rows for every promoted model** (the tester runs were QUALITY-ONLY; the promoted set has no §3/§4
rows yet, so their `recommended_min_ram_gb` values rest on file size + headroom convention, not
measured RSS), and the §9.1 through-the-app smoke for the 9B and both 27Bs. If the speed/RSS
rows or the rescored quality table later contradict a promoted rank, this decision is the one
to revisit, not silently override. *(All four CLOSED 2026-08-03 — scorer v3 + rescore landed,
both i9 runs ratified as the §9 record, the 2026-07-30 run supplied §3/§4 rows for the whole
promoted set (RAM lines confirmed on the vulkan basis; the Linux-cpu numbers are a
non-comparable mmap basis — §9.3 "§4 RSS"), and the 9B + both 27B §9.1 smokes PASSED. The
rescored table did NOT contradict the promoted ranks. Residuals live in the wave follow-up
issue: the Windows-basis RSS re-measure and the 35B-A3B §9.1 smoke — the latter PASSED
2026-08-09, §9.3 smokes record.)*

### 6.5 Signal-aware picker: the measured-tok/s step-down (issue #95 item 1, 2026-08-09)

**Status: design record for the option-2 signal-aware picker (issue #53's residue, tracked in
issue #95). Changes recommendation behavior for every benchmarked machine, so it carries the
BUILD_STATE §5 item 8 standing requirement: owner sign-off (@comilionas) in PR review before
merge. It also resolves issue #52's deferred downgrade question (see "What this resolves"
below).**

The RAM-best-fit picker (§6.2/§6.3) sees capacity only. Two machines with 16 GB get the same
pick even when one of them demonstrably generates text at a crawl (issue #53's weak-iGPU laptop
class). Since issue #52 the Diagnostics benchmark persists the honest pairing (`tokensPerSecond`
plus `measuredModelId`, the model that actually produced the number), so the picker can now
consume it. The rules:

1. **Required behavior.** A loaded-model tok/s probe under the threshold
   (`SLOW_PICK_TOKENS_PER_SECOND = 5`, strictly below) steps the RAM-best-fit recommendation
   down ONE size tier. At or above the threshold, or with no probe, nothing changes.
2. **Applicability predicate (the #52 lesson).** The crawl is a valid signal ONLY when
   `measuredModelId` resolves to a catalog manifest of the same role whose `recommended_ram_gb`
   is at or below the would-be pick's `recommended_ram_gb`. A crawl measured on an OVERSIZED
   loaded model (the user manually started something above their tier) is expected and never
   downgrades the pick. A `measuredModelId` that no longer resolves in the catalog is no
   signal. The signal applies to the CHAT recommendation only: the probe streams through a
   chat model, and the embeddings pick never moves on it.
3. **"One tier down" defined.** Re-run the §6.2 comfortable stage excluding the top band (every
   model sharing the winner's `recommended_ram_gb`), over RANKED models only: the §6.3
   ranked-only guard applies unchanged, and the step therefore can never land on a rank-0 model
   (`gemma4-e2b` stays unreachable until its own #95-item-2 gate resolves — *resolved
   2026-08-09, see the #153 amendment below*). If no lower ranked
   tier exists, KEEP the original pick: the step never lands on nothing. A pick that came from
   the runnable fallback stage (machine below every comfortable line) also keeps: it is already
   the lightest honest answer. Against the committed catalog today the step moves 24 GB boxes
   `qwen3.6-27b-q4` → `qwen3.5-9b-ud-q4kxl` and ≥32 GB boxes `qwen3.6-27b-q5` →
   `qwen3.6-27b-q4`; the 16 GB tier keeps its pick (no ranked band below 16 exists yet —
   *superseded 2026-08-09: the #153 E2B promotion created the sub-16 band; 16–20 GB crawls now
   step to `gemma4-e2b-it-qat-q4`*). The
   step's reach grows as RAM lines are retuned from measured RSS (#95 item 3) or lower tiers
   earn ranks (#95 item 2): the rule is structural, not a hardcoded mapping — the #153
   promotion exercised exactly this property (rank edit only, zero picker-code change).
4. **Stateless, single-step.** The stepped pick is derived fresh on every `listModels` call
   from the persisted `settings.lastBenchmark`; a re-benchmark replaces the sample. The base
   pick is always recomputed from RAM alone, so downgrades never compound across runs.
5. **No-signal path byte-identical.** No benchmark yet, probe skipped (no runtime was
   running), tok/s at/above threshold, or predicate fails: the result is today's pure
   RAM-best-fit answer, exactly. The no-signal mapping (≤12 → Qwen3.5 4B, 16–20 → Qwen3.5 9B,
   24 → Qwen3.6 27B Q4, ≥32 → Qwen3.6 27B Q5) stays pinned untouched in
   `committed-catalog.test.ts` and `benchmark.test.ts`. *(Amended 2026-08-09 by the #153 E2B
   promotion — a catalog change, not a picker change: 12–15 GB → Gemma 4 E2B, the new sub-16
   comfortable band; 8 GB keeps Qwen3.5 4B via the runnable stage. Pins updated in both files.)*
6. **Consistency across surfaces.** `runBenchmark` (the Diagnostics card's
   `recommendedModelId`) applies the same rule with the just-measured values, and
   `listModels` applies it with the persisted ones, so the two surfaces cannot disagree:
   both call the same `recommendModelIdByRam(manifests, ram, role, speedSignal)` picker.
7. **Surfacing.** When the step-down fires, the #52 named-warning family gains a sibling
   (`main.benchmark.warnRecommendationLowered`): it says the recommendation was moved down one
   size tier and names the measured model and the measured figure. EN + DE catalogs; persisted
   in `settings.lastBenchmark.warnings` as canonical English (i18n record §3.3 rule 1), display
   translated via the interpolated display map. The #110 slow-read warning upsert is untouched.

**What this resolves.** Issue #52 deliberately deferred the question "should the profile
downgrade be suppressed when the measured model is much larger than the recommendation?"
(recorded in `benchmark.md` "Profile classification"). Answer, as built: the legacy PROFILE
downgrade stays as-is (it feeds the profile table, a fallback surface), and the
RECOMMENDATION applies the predicate above instead: an oversized crawl never moves the pick,
a right-sized crawl moves it exactly one tier. The #52 warning keeps naming the measured
model; the new sibling warning names the consequence for the pick.

**#153 amendment (2026-08-09, owner-ratified): the E2B promotion gives the step-down its
sub-16 landing tier.** The weak-16 GB-box in-app Diagnostics leg (issue #153, successor to
#95 item 2) ran on the designated class (15.8 GB, i7-1185G7, Iris Xe iGPU, Vulkan b9849, AC +
idle, dev build of master `2d1d9db9`): settled tok/s `gemma4-e2b` **17.0** vs `qwen3.5-4b`
**9.0** vs bundled `qwen3-4b` **14.6** — the big-rig cpu ratio (~2× the promoted 4B) reproduces
on the iGPU basis (all three legs GPU/Vulkan per the chat header; basis + full runs in the #153
comment). With the §9.3 quality standing (E2B F1 .3373 > qwen3.5-4b .2728, equal-class audited
hallucinations) E2B wins the sub-16 band on both axes, so: `recommendation_rank` 0 → **3** and
`recommended_ram_gb` 16 → **12** (the honest retuned value; the old 16-floor existed only to
keep the then-rank-0 manifest from hijacking the comfortable stage — the §9.3 field-signal
note's "retune recommended_ram_gb" branch, executed). Consequences, all pinned: base mapping
12–15 GB → E2B (was the runnable-stage `qwen3.5-4b` fallback); stepped mapping 16–20 GB crawl
→ E2B (was rule-3 keep); 8 GB and ≥16 GB base picks unchanged. The §6.5 step-down was also
exercised on real hardware for the first time during the #153 measurement: it correctly did
NOT fire (all settled values ≥ 5 tok/s; recommendation stayed the 9B throughout). Deep 7/8
flip-rule guidance for E2B stands (§9.3 thinking table).

---

## 7. Design record — catalog expansion (Phases 28–29, decisions D16–D22)

_Formerly `docs/model-catalog-expansion-plan.md` (folded in here, 2026-06-12 docs
housekeeping; the full original working paper — protocol drafts, bring-up checklists, the
pre-measurement RAM estimates — is in git history via `git log --follow` on that path).
The catalog + recommendation story lives in [`model-policy.md`](model-policy.md) (incl. the
disqualified/parked candidate list under "License review gate"); the protocol + first-run
findings are §0–§6 of this document. Decision numbering continues the repo series
(post-MVP D1–D7 · retrieval D8–D15 → **D16–D22** here → wave-3 D23+)._

### 7.1 Decisions (D16–D22) and outcomes

| # | Decision | Choice | Why (short) |
|---|---|---|---|
| D16 | First challenger batch | **Ministral 3 8B Instruct 2512** + **Granite 4.1 8B** (mid tier) + **Gemma 4 12B QAT** (high tier) | All Apache-2.0, all with *vendor-published* GGUFs, all strong German — 2–3 challengers per tier without 200 GB of downloads |
| D17 | Challenger auto-recommendation | New manifests ship with **empty `recommended_profiles`** (selectable, never auto-recommended) until they earn it | A challenger must EARN promotion via the Phase-29 benchmark before the recommender offers it |
| D18 | Incumbent refresh | Evaluate **Qwen3-4B-Instruct-2507** as a 4th Phase-28 manifest | Report data: the 2507 4B beats the *original* 8B on most axes. ⚠️ 2507 is instruct-only (no hybrid thinking) — interacts with Phase-20 depth modes |
| D19 | Quality benchmark = judge-free, ours | Hand-rolled **German/English grounded-QA set** + deterministic string/F1/citation/abstain scoring; `llama-bench` for speed | No cloud judge (hard rule); tests exactly what the product does (RAG + citations + abstention); no new toolchain |
| D20 | Benchmark form | **Manual protocol doc first** (this document + a results CSV convention); automate only if the manual loop proves annoying | One developer, 2–3 laptops; don't build automation before the protocol has run once |
| D21 | Big/opt-in slot + embeddings | **Phase 30, outline only** — Gemma 4 26B-A4B vs the incumbent Qwen3 30B-A3B; Granite Embedding R2 small as the only near-drop-in embedder | MoE comparisons need Phase-29 numbers first; an embedder swap forces a reindex story — separate, later. Drafted as the Phase-30 plan (D38–D43); retired 2026-07-12 unimplemented — disposition §9.2 |
| D22 | License gate posture | Every new manifest lands with a **real `license_review` record** (approved, with source URLs) before merge | Licensing is the #1 disqualifier; the review work is cheap now (all picks verified Apache-2.0) and mandatory before any drive bundles them |

**Outcomes (as built):** D16 — all three challengers shipped + license-reviewed. **D17
evolved**: the challengers kept `recommended_profiles: []`, but Phase 29 found the
production recommender was *quality-blind* (RAM-best-fit, ignores `recommended_profiles`;
the legacy picker is one-model-per-profile), so promotion is now carried by the
**`recommendation_rank`** manifest field that makes RAM-best-fit quality-aware (§6.2).
**D18 resolved**: 2507 shipped (via the unsloth fallback) and beat the original 4B on
*every* Phase-29 metric, but the original stays the **bundled default** (it has hybrid
thinking → keeps Deep working out of the box); 2507 is ranked just below it. D19/D20 — the
judge-free harness + protocol shipped and ran (§2–§6). D21 — Phase 30 outline → the D38–D43
plan, retired 2026-07-12 unimplemented (§9.2). D22 — all four `license_review`s approved Apache-2.0.

### 7.2 Verified research facts (2026-06-10 — what the wave rested on; confirmed live on b9585)

1. **Pinned llama.cpp `b9585` = the 2026-06-09 release** — every candidate (incl. Gemma 4,
   which needs ~b8607) runs on the runtime we already ship. No runtime bump.
2. **Gemma 4 is Apache-2.0** — first Gemma under an OSI license. Official Google QAT Q4_0
   GGUF: <https://huggingface.co/google/gemma-4-12B-it-qat-q4_0-gguf>.
3. **Ministral 3 (2512) family is Apache-2.0**, official Mistral GGUF repo
   (<https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512-GGUF>). ⚠️ The Oct-2024
   `Ministral-8B-Instruct-2410` is **non-commercial** (Mistral Research License) — the
   manifest pins the exact `-2512` URL; the review names the trap.
4. **Granite 4.1 is Apache-2.0** with official IBM GGUFs at
   <https://huggingface.co/ibm-granite/granite-4.1-8b-GGUF> (NO `-instruct` suffix — that
   repo IS the instruct model). German is one of 12 official languages.
5. **Incumbents are the ORIGINAL Qwen3 instruct models** (hybrid thinking), not the 2507
   refresh. Report-table basis for D18: 2507-4B scores above the *original 8B* on
   MMLU-Pro/IFEval/MMLU-ProX.
6. **`--jinja` is already in `CHAT_SERVER_ARGS`** — the server applies each GGUF's embedded
   chat template; new-model bring-up only needs a render smoke. `--reasoning-format deepseek`
   is a no-op for non-thinking models.
7. **Embeddings:** the pipeline is built around E5-small's **384 dims**; switching embedders
   forces a reindex. **Granite Embedding R2 small (384-dim, Apache-2.0)** is the only
   near-drop-in candidate — Phase-30 material (BGE-M3 / Qwen3-Embedding are 1024-dim).

### 7.3 Phase 28 — catalog wave 1 (as built, manifest-only)

Four manifests under `model-manifests/chat/`, all Apache-2.0, all
`license_review: approved`, **no code changes** — the existing validator +
committed-manifests discovery test cover them:

| id | source GGUF | notes |
|---|---|---|
| `ministral3-8b-instruct-2512-q4` | official `mistralai/…-2512-GGUF` Q4_K_M | text-only (mmproj vision file deliberately not referenced); review names the `-2410` NC trap |
| `granite-4.1-8b-q4` | official `ibm-granite/granite-4.1-8b-GGUF` Q4_K_M | repo name has no `-instruct` |
| `gemma4-12b-it-qat-q4` | official `google/gemma-4-12B-it-qat-q4_0-gguf` | vendor QAT **Q4_0**; file name lower-case `gemma-4-12b-…` |
| `qwen3-4b-instruct-2507-q4` (D18) | **unsloth** `Qwen3-4B-Instruct-2507-GGUF` Q4_K_M | the Qwen org publishes NO official 2507 GGUF → established-quantizer fallback; recorded as third-party requant in the review |

Provenance notes that survived to the manifests: vendor GGUF repos declare apache-2.0 via
the HF card tag only, so their `license_url` points at the canonical Apache-2.0 text (card
URLs in the review notes); only the Qwen 2507 base repo ships a LICENSE blob. Exact HF-tree
byte sizes are baked into `download.size_bytes`. Weights fetched + real `sha256` promoted;
`verify-models -Target D:\` reports **all 10 catalog weights VERIFIED**.

**Bring-up** (`tests/manual/bringup-smoke.test.ts`, real b9585): all four load, render the
chat template through `--jinja` with no leaked artifacts, stream tokens, and answer the
German prompt in German. Two findings were carried into Phase 29 and **resolved there**:
(a) 2507 looked factually wobbly in German on *open* knowledge — it did **not** recur on
the grounded RAG path (2507 has the top German F1 in the benchmark); (b) Gemma 4 honours
`enable_thinking` — its `supports_thinking_mode` was flipped **true** after the Phase-29
thinking-quality check (`tests/manual/gemma-thinking.test.ts`).

### 7.4 Risks / open items (still live)

| Risk | Mitigation |
|---|---|
| Eval set saturates EM (all models ~96–98 %) | Grow the set with harder/multi-hop + more distractor-heavy items before trusting accuracy deltas; per-item dumps are kept. Abstention already separates models. (= big-slot plan D42) |
| Benchmark machines too few/too similar | The protocol records machine facts; the GPU hardware-matrix machines double as benchmark hosts over time (run the dev-box sweep for the formal 2nd machine) |
| HF repo layouts / filenames drift | Manifests pin exact URLs; first fetch + `verify-models --generate` catches drift loudly |
| Phase-30 embedder swap forces a reindex | Surface via the Phase-17 re-index machinery; its own mini-plan before any swap (big-slot plan Track B) |

---

## 8. Image understanding (vision) — V1 measurements + the V5 smoke protocol

The vision sidecar (image-understanding feature; design record in
[`architecture.md`](architecture.md) "Image understanding — design record") is a SEPARATE
benchmark axis from the chat catalog above — a different role (`vision`), a two-file model
(language GGUF + `mmproj` projector), and a CPU-bound multimodal prefill. Numbers below are the
**real V1 measurements** on the pinned **b9585** (a locally provisioned PAID smoke drive),
captured during the V1 research gate (BUILD_STATE V1); the **V5 manual harness re-runs them live**.

### 8.1 The manual smoke harness (`HILBERTRAUM_VISION_SMOKE`)

`tests/manual/vision-smoke.test.ts`, the same env-gated pattern as `gpu-smoke`/`rerank-smoke`
(skipped in CI — the green gate stays zero-binary/zero-model/zero-network):

```powershell
$env:HILBERTRAUM_VISION_SMOKE = "<your-smoke-drive>"   # root with runtime/llama.cpp/<os>/llama-server + models/vision/*.gguf
cd apps\desktop
npx vitest run tests/manual/vision-smoke.test.ts
```

It drives the REAL `VisionRuntime` end-to-end against the off-repo weights: cold start (`--mmproj`
loads multimodal), analyze the committed synthetic fixture (`tests/fixtures/vision/chart.png` — a
content-free, license-clean bar chart drawn by `make-fixtures.mjs`), STREAM the answer (real SSE →
`readChatSSE`), a warm follow-up (the `cache_prompt` reuse), then the RUNTIME-4 idle teardown +
cold restart. Peak RSS co-resident is captured separately with `scripts/measure-peak-rss.ps1`
(§C) against the running sidecar. **No multi-GB weights or user images are committed** — only the
~1.7 KB synthetic fixture.

### 8.2 Chosen production candidate — Qwen2.5-VL-3B-Instruct (V1, real)

| Datum | Value | Source / note |
|---|---|---|
| LM weight | `Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf` — 1.93 GB | ggml-org GGUF, Apache-2.0 (`sha256 d02fe9…486c12`) |
| Projector | `mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf` — 1.34 GB | the `--mmproj` CLIP projector (`sha256 b9160f…e60d5e`) |
| Combined on disk | **≈ 3.27 GB** | both files; install = both present + verified |
| **Peak RSS (sidecar alone)** | **≈ 4.6 GB** | CPU-pinned, ctx 4096; `PeakWorkingSet64` 4597 MB / private 5126 MB |
| Cold start | seconds (large GGUF off USB) | "Starting the vision model…"; idle teardown re-pays it later |
| Image tokens (full-res scan) | **2813** | a high-res page; the §11 downscale-to-1536 cuts this ~proportionally |
| **CPU prefill (full-res)** | **≈ 52 s** (~18.5 ms/image-token) | the headline latency risk — CPU off USB; downscale + GPU are the levers |
| Decode | **≈ 12 tok/s** | CPU-pinned |
| `cache_prompt` reuse | `cache_n:2812, prompt_n:1` on the 2nd question | the per-image thread pays the image prefill ONCE, not per follow-up |
| Capability | read a real German invoice correctly (doc-type + the German text) | the 256M reference garbled it |

Reference (fast mechanics-proof, not the product model) — **SmolVLM-256M-Instruct** (ggml-org,
Apache-2.0): also loads/answers; RSS ~402 MB (`sha256`s in BUILD_STATE V1).

### 8.3 The two levers + the tuned idle timeout

- **`--device none` / CPU-pin is the MVP default** (§19.11): GPU is the optimization lever **only
  if** CPU TTFA fails the bar — it adds VRAM contention with chat + driver-flakiness. The ~52 s
  full-res prefill is the number that decides this per machine.
- **Client downscale to 1536 px (§11) is a real LATENCY lever, not just payload** — fewer image
  tokens ⇒ proportionally less CPU prefill — and it normalizes EXIF orientation. Already on the
  real path (renderer `decode.ts`).
- **Idle-teardown default TUNED to 120 000 ms (2 min)** — the lower end of the §19.13 2–5 min
  band (`DEFAULT_VISION_IDLE_MS`, env `HILBERTRAUM_VISION_IDLE_MS`). Rationale: the follow-up
  prefill is already `cache_prompt`-cached, so a warm sidecar only saves the seconds-scale model
  *load*; meanwhile the idle ~4.6 GB sits co-resident with a 12B chat (PROD-1 pushes a real
  machine >16 GB), so reclaiming it sooner is the higher-value trade. 2 min spans a burst of
  follow-ups, then frees the RAM; the next image cold-restarts cleanly.

### 8.4 RAM co-residency (PROD-1) — the acceptance bar, honestly qualified

Vision peak ~4.6 GB + a 12B chat (~7 GB) + the E5 embedder ⇒ **>16 GB** — three `llama-server`
processes at peak. The idle teardown bounds the *window*, **not the active-use peak**. So vision
is realistically co-resident **only with a small chat model, or after the chat sidecar idles out**;
the manifest `recommended_min_ram_gb` / RAM-best-fit gate keeps a vision model off machines that
can't hold it. Recorded in [`known-limitations.md`](known-limitations.md).

**The same PROD-1 convention governs `recommended_min_ram_gb` catalog-wide (PR #30):** the hard
start gate is the **model-alone** floor (peak RSS + ~3 GiB headroom), never the co-residency floor.
Vision = 12 for its ~4.6 GiB peak; TranslateGemma = 13 for its 9.22 GiB peak (§11 D10). Co-residency
pressure lives in `recommended_ram_gb` and is absorbed at runtime by idle-teardown + the
RAM-best-fit picker — not by refusing to load the model. Baking a co-residency floor into the hard
min (TranslateGemma's original 17) locks the model out of machines that could run it alone, so no
manifest should do it.

## 9. Qwen3.5 Unsloth wave — PENDING candidates + the b9849 manual smoke (2026-07-01)

Four `qwen3.5`-family chat manifests are in the catalog as **pending benchmark candidates** — added
manifest-only, **rank 0**, **not bundled**, **not auto-recommended** (model-policy.md "Qwen3.5
Unsloth wave"). **No wins are claimed here.** They had NOT been through the §2–§6 harness when
this section was written, and the runtime pin they need (**b9849**, bumped from b9585) has not
been smoked on this project's drive. *(Update 2026-07-11: a tester has since run the §2 quality
half on their own machine — see "Tester eval runs (2026-07-09)" below. Ranks still unchanged:
ratification + the speed/RSS and §9.1 halves are owner work.)* *(Superseded 2026-07-12: §6.4
promoted `qwen3.5-4b-ud-q4kxl` and `qwen3.5-9b-ud-q4kxl` to `recommendation_rank: 3` by owner
decision — the "rank 0 / not auto-recommended / ranks unchanged" statements throughout this
section describe the pre-promotion state; `qwen3.5-27b-ud-q4kxl` and `qwen3.5-35b-a3b-ud-q4kxl`
remain rank 0. See §6.4.)*

| Candidate | Tier | Must beat (to earn a `recommendation_rank > 0`) |
|---|---|---|
| `qwen3.5-4b-ud-q4kxl` | 4B | `qwen3-4b-instruct-q4` (the bundled default) before promotion. |
| `qwen3.5-9b-ud-q4kxl` | 8B | `ministral3-8b-instruct-2512-q4` on hallucination rate, German/English grounded QA, citation correctness, AND speed. |
| `qwen3.5-27b-ud-q4kxl` | 12–14B+ | `gemma4-12b-it-qat-q4` and `qwen3-14b-instruct-q4` by enough to justify the size/RAM. |
| `qwen3.5-35b-a3b-ud-q4kxl` | MoE (opt-in) | `qwen3-30b-a3b-q4` on speed OR quality by enough to justify replacement. |

> **Public benchmark scores are NOT enough.** HilbertRaum promotion depends ONLY on the local,
> offline German/English grounded-QA eval (§2) + the speed/RSS sweep (§3/§4) + the manual smoke
> below. Qwen3.5 27B's public numbers may look stronger than 35B-A3B's on several categories — that
> is *not* a promotion signal here. Until the local eval gives a model a real rank, every Qwen3.5
> manifest stays `recommendation_rank: 0` (selectable manually, never auto-recommended, never
> bundled). *(Superseded 2026-07-12: §6.4 amended this "local eval only" rule — the 4B and 9B are
> now rank 3 by owner decision on product/positioning grounds; the 27B/35B-A3B stay rank 0.)* The
> §4 `recommended_min_ram_gb` values for these are **placeholders pending a real peak-RSS
> measurement** (24 GB for the 27B/35B is a conservative guess, not a measured floor).

**Tester eval runs (2026-07-09, recorded here 2026-07-11; full tables in issue #48's comments)** —
a tester ran the §2 grounded-QA harness (`tests/manual/model-eval.test.ts`) on their own machine
(i9-9900X + RTX 3090, Vulkan, the b9849 drive binary; 100 DE/EN items, temp 0, identical
retrieval) over **13 chat GGUFs** in two runs — all six wave candidates included. Raw CSV/JSONL
are now committed under `eval/results/i9-9900X-vulkan-*` (§6.4; originally kept on the tester's
drive). Cross-run calibration held (three overlap models
within ≤.022 F1 / ≤1 hallucination item of the committed Phase-29 i7 run), and the tester audited
all flagged hallucinations by hand. **Status: quality evidence, pending owner ratification —
NOT yet the §9 record and no rank has moved.** *(Ratified 2026-08-03 together with the
2026-07-30 evidence run — both i9 runs are now the §9 record and the detector-v3 rescored CSVs
are canonical; see the §9.3 wave outcome. The 35B-A3B's deferred rank resolved to rank 1 there.)*
Headline verdicts as reported:

- **Qwen3.6 27B (local-only manifests) sweeps the 20–24 GB tier** — Q5: best F1 ever measured on
  the harness (.3573), zero hallucinations, best DE F1; Q4 clean after audit. Proposal: Q5 →
  rank 2, Q4 → rank 1 — **blocked on productizing** (no `download:` block / upstream sha256 /
  license review; the #48 item-2 bar below).
- **`qwen3.5-4b-ud-q4kxl` FAILS its §9 bar** (issue #53's candidate): fewer real hallucinations
  than the bundled `qwen3-4b-instruct-q4` (2 vs 3) but F1 .2728 vs .3277 — a loss larger than the
  verbosity confound (below) plausibly explains at this size — and `qwen3-4b-instruct-2507`
  (F1 .3613, 1 halluc) dominates both. Phase-29 status quo stands on quality grounds.
- **`qwen3.5-2b-ud-q4kxl` should not be recommended anywhere**: worse F1 than the 0.8B and the
  worst unanswerable-discipline of all 13 models (4–5 real hallucinations); the 0.8B remains the
  honest floor.
- **`qwen3.5-9b-ud-q4kxl` does not clear the strict 8B bar** (edges Ministral on EM/F1 within
  tolerance but fell once for the `en-contract-penalty` invoice-distractor trap where Ministral's
  record is clean); tester proposes rank 1 under Ministral's rank 2.
- **`qwen3.5-35b-a3b-ud-q4kxl` is hallucination-clean after audit** (0 real vs the incumbent
  MoE's 2, EM parity, F1 gap within confound territory) — **rank deferred to the §3/§4 speed
  rows**, which is exactly the axis its 3B-active architecture should win.
- **Scorer confound + fixes (do BEFORE canonizing numbers):** token-F1 inversely tracks answer
  length (Qwen3.5 house style answers 125–215 chars vs Gemma/Qwen3.6's 87–93), so F1 partly
  measures style, not knowledge — read EM + audited hallucinations as primary for cross-family
  calls, or add a length-normalized column; and the refusal detector missed four abstentions
  across the runs (incl. a German "kein/keine … erwähnt" negation family) — extend the phrase
  list + rescore via the §2 `rescore.mjs` flow (no model re-runs needed). *(Detector fix DONE
  2026-08-03 — v3 phrase list + split-negation patterns, all four dumps rescored and the flips
  audited item-by-item; see §9.3 "Scorer v3". The length-normalized column remains a
  nice-to-have; EM + audited hallucinations stay the primary cross-family read.)*

**What the runs do NOT cover (why ranks are still unmoved):** owner ratification of a
tester-machine run as the §9 record; the §3/§4 speed/RSS sweep (decides the 35B-A3B and supplies
the measured peak RSS any RAM-line retune needs); the §9.1 through-the-app smoke (abort,
lock/quit teardown, thinking-mode toggles — the eval harness exercises the RAG path, not the app
UI); and committed raw results. The runs DO constitute strong informal b9849 load+stream evidence
for every model they scored.

**Field signal on the 4B (issue #53, 2026-07-11)** — recorded as eval input, NOT a promotion: a
tester on a weak 16 GB laptop (weak iGPU) reports `qwen3.5-4b-ud-q4kxl` at **~2 tok/s with usable
quality** as the best speed/quality trade-off of the catalog on that class of machine — the 16 GB
recommendation (Ministral 8B) is roughly twice the compute per token there, and the fast-tier
2B/0.8B give up more quality than they save. Running through the app is also an informal
load+stream datapoint for b9849 (the §9.1 smoke on this project's drive is still owed). Two
mechanics facts for the eventual promotion (verified against `recommendModelIdByRam`, recorded in
the manifest): **rank 1–2 wins nothing** (qwen3-4b takes ≤12 GB on the rank/size tiebreaks,
Ministral keeps 16–20 GB), and **rank ≥ 3 also steals 16/20 GB from Ministral** (both carry
`recommended_ram_gb: 16`) — so a low-end-only promotion must retune `recommended_ram_gb` from the
real peak-RSS measurement, or land with the signal-aware picker follow-up (issue #53 option 2:
feed the Diagnostics benchmark's measured tok/s — persisted with its `measuredModelId` since
issue #52 — into the recommendation, capturing the weak-16 GB-laptop case without misranking
capable 16 GB machines). *(Update 2026-07-11: the tester eval above scored the 4B and it FAILS
its quality bar against `qwen3-4b-instruct-q4` — so if that run is ratified, the #53 case reduces
entirely to the compute axis the quality harness doesn't measure, i.e. option 2, not a rank
edit.)*

Issue #48 (2026-07-10) extends this wave's scope, still under the same gate: the fast-tier
`qwen3.5-2b-ud-q4kxl` / `qwen3.5-0.8b-q6` have no incumbent to displace (low-risk promotions once
evaled), and the eval should record **context length** and **thinking-mode support** as
first-class criteria alongside grounded QA / citations / speed — the Qwen3.5 generation's native
262k window and hybrid thinking are product-relevant differences the §2 score alone does not
capture (the shipped `recommended_context_tokens` stays the safe local budget either way; a
promotion may raise it deliberately, per the D69/#43 context policy). Candidates that exist only
as local manifests elsewhere (e.g. a Qwen3.6 27B) need productizing first: a `download:` block,
a real upstream sha256, and a license review — same bar as the wave above.

**Thinking-checkpoint criterion for structured surfaces (STR-1 review §5.4, 2026-07-20):** Qwen
dropped hybrid thinking with the 2507 refresh — Instruct and Thinking are now SEPARATE
checkpoints, and an `enable_thinking` template kwarg is moot on a split checkpoint. The #50
lesson ("the model reasons anyway despite the kwarg and burns the extract token budget")
generalizes: for the app's grammar/extract/locate surfaces (D55 `responseSchema` consumers —
categorizer, enricher, both locate passes, the ingest extract pass), the robust control is
**which checkpoint the catalog recommends**, not a template kwarg. When ratifying this wave,
record each manifest's observed thinking-mode behavior as a first-class criterion for
**structured-surface suitability** (extend the two §9.1 thinking checkboxes' findings to the
extract/locate implications), and keep structured-surface calls pinned to non-thinking behavior
(a thinking-only checkpoint pays the #50 escalated-retry cost on every ingest chunk).
**Since wave R80 (issue #80, 2026-08-09) the router's skill-pointer classification
(`analysis/classify.ts`) is a further D55 `responseSchema` consumer** on this list — single-shot,
temp 0, tiny enum, run only on the #54-class/low-confidence trigger turns; a thinking checkpoint
that burns the 48-token budget on reasoning simply degrades it to `none` (no offer — the honest
fallback), so it fails soft, but the criterion above still applies. **Owner-run follow-up eval:**
the classifier's real-model precision on the promoted catalog is deliberately NOT gated in-repo
(the in-repo gate is the deterministic trigger boundary + the prefer-`none` prompt); the
`extract-router.test.ts` #80 golden set (bilingual trigger asks + near-miss distractors) doubles
as the eval input — run it against each promoted checkpoint and record per-model
offer-precision/none-rate here when ratifying a wave.

### 9.1 Manual smoke checklist — b9849 runtime + Qwen3.5 load (REQUIRED; not CI)

This is a human pre-promotion gate (offline / network / real GPUs can't run in CI). Record results
in BUILD_STATE. **Capture tokens/sec + peak RSS** where the existing manual harness (§3/§4,
`benchmark-speed.ps1`) supports it.

**1. Fetch/install the b9849 runtime** (`fetch-runtime`), per build:
- [ ] Windows Vulkan/full · [ ] Windows CPU safety-net · [ ] macOS arm64 (Metal) ·
  [ ] Linux Vulkan/full · [ ] Linux CPU safety-net

**2. Old models still load on b9849** (regression):
- [ ] `qwen3-4b-instruct-q4` · [ ] `ministral3-8b-instruct-2512-q4` ·
  [ ] `gemma4-12b-it-qat-q4` (if the machine has the RAM) ·
  [ ] embedding (`multilingual-e5-small-q8`) + reranker (`bge-reranker-v2-m3`) sidecars still load
  on b9849 — **or explicitly record if deferred to a later phase** (these were last verified on
  b9585; the F16 choice is documented in model-policy.md).

**3. New Qwen3.5 models load on b9849:**
- [ ] `qwen3.5-4b-ud-q4kxl` · [ ] `qwen3.5-9b-ud-q4kxl` ·
  [ ] `qwen3.5-27b-ud-q4kxl` (32 GB+ machine) · [x] `qwen3.5-35b-a3b-ud-q4kxl` (32 GB+ machine —
  PASSED 2026-08-09, all item-4 legs; see the §9.3 smokes record)

**4. For each Qwen3.5 smoke, through the APP (not raw llama.cpp):**
- [ ] start the model via the AI Model screen
- [ ] one normal chat prompt streams a coherent answer
- [ ] one document-grounded prompt (if documents are available) answers from the corpus
- [ ] streaming begins and can be **aborted** mid-stream
- [ ] **lock / quit teardown leaves no `llama-server` sidecar running**
- [ ] Deep/Thorough mode toggles `enable_thinking` correctly (reasoning frames appear)
- [ ] Balanced/non-thinking mode disables thinking where supported (esp. the ≤9B models, which
      default reasoning OFF unless `enable_thinking=true`)
- [ ] no `mmproj`/projector is required for text-only chat (these are text-only manifests)

**6. Vision sidecar (Qwen2.5-VL-3B) on b9849 — DONE 2026-07-01 (the gap that shipped the salad bug):**
The original §9 checklist omitted the vision sidecar (items 2–4 cover chat + embedder/reranker only).
A large real image then produced multilingual token-salad on b9849 — root cause = b9849's
`n_slots = 4` + unified KV starves a large image's ~1700–3000 vision tokens; fixed with `--parallel 1`
(`VISION_SLOT_ARGS`). Full record: architecture.md §3 (RUNTIME-5) + BUILD_STATE. Re-smoke this after
ANY future pin bump — a tiny fixture is NOT sufficient (the salad only appears above ~1000 vision
tokens):
- [ ] through the APP, analyze a LARGE photo (≥1536 px long side) → COHERENT description
- [ ] analyze a SECOND large image on the same warm sidecar (no restart) → still coherent (guards the
      KV-reuse/oversubscription path)
- [ ] the sidecar stderr shows `n_slots = 1, kv_unified = false` and NO `failed to find a memory
      slot` / `failed to process image` lines

**5. If `UD-Q4_K_XL` fails to load on b9849 but plain `Q4_K_M` loads:** add the experimental
`qwen3.5-27b-q4km.yaml` / `qwen3.5-35b-a3b-q4km.yaml` fallback (hashes recorded in the manifest
templates in the wave plan), keep `UD-Q4_K_XL` as the preferred quant. Do NOT add a fallback
pre-emptively.

### 9.2 Phase-30 "big slot + embeddings" plan — RETIRED unimplemented (2026-07-12; D38–D43 disposition)

The standalone plan (`docs/big-slot-embeddings-plan.md`, drafted 2026-06-11; deleted 2026-07-12 —
full text: `git show 1e5d17e:docs/big-slot-embeddings-plan.md`) was retired without implementation:
neither track had started, and the facts moved underneath it (the b9585→b9849 pin bump, the Qwen3.5
wave, the §9 tester evidence). Disposition of its decisions:

- **D38 (Track A candidate set: Gemma 4 26B-A4B / Mistral Small 3.2 24B / Granite 4.0 H-Small) —
  SUPERSEDED, none ever fetched.** The §9 tester eval answered Track A's question ("is anything
  above the 12–14B tier worth recommending?") with different candidates: Qwen3.6 27B sweeps the
  20–24 GB tier and the 35B-A3B challenges the MoE incumbent. The live big-slot work is the §9
  promotion pipeline (BUILD_STATE §5 item 8); fetching the old candidate list would duplicate it.
  *(Update 2026-07-23: partially overtaken — the Gemma 4 26B-A4B has since been fetched,
  hash-verified, and CLI-load-smoked as part of the Gemma 4 QAT wave (§9.3, issue #82), which puts
  it IN the §9 promotion pipeline as the headline 24 GB challenger. The D38 disposition itself
  stands: Track A as drafted was never run; the candidate re-entered through the front door — an
  official Google QAT quant with a verified hash — not via the retired plan.)*
- **D39 (inclusion bar: a big model must beat the incumbent at usable speed, or be a clear GPU-only
  ceiling) — CARRIED FORWARD**: restated as §9's "must beat" table.
- **D42 (eval-set hardening) — STILL NEEDED, merged into §5 item 8 step (a)**: the tester run
  confirmed the scorer can't separate strong models (length-confounded F1 + refusal-detector gaps,
  §9 "Scorer confound").
- **D43 (MoE RAM from weight-file size + KV headroom, not mmap-undercounted RSS) — STILL OPEN**,
  carried into item 8's §3/§4 speed/RSS step (the 27B/35B RAM lines are placeholders).
- **D40/D41 (Track B — the default-embedder swap) — DEFERRED post-MVP, decisions unmade.** Durable
  facts for whoever reopens it (registration: BUILD_STATE §5 item 4):
  1. Start with a **384-dim drop-in** (reindex only, no storage change); 1024-dim models (~2.7×
     vector-blob storage, a heavier embedder) are a separate, later decision. The schema already
     supports a different-dimension embedder mechanically (per-row `dimensions`, id-scoped search) —
     the real work is the retrieval A/B plus the Phase-17 reindex UX (an embedder change must
     honestly prompt "your documents need re-indexing"; id-scoping already prevents silent
     vector-space mixing).
  2. **Adoption bar: a measurable win on the hardened eval set** — a default-embedder swap
     invalidates every user's existing index, so the bar is higher than for a chat model, and it
     gets more expensive the larger the install base (an argument for deciding early post-MVP).
  3. **Compat hazard:** the E5 q8_0 conversion CRASHED the old b9585 runtime (`binary_op:
     unsupported types … q8_0`) — the reason E5 + the reranker pin F16. Re-verify this hazard class
     on the current b9849 pin before any embedder work; test candidate GGUFs as F16 first.
  4. Re-verify the candidate landscape at reopen time — the plan's pick (Granite Embedding R2
     small, ~97M, 384-dim, Apache-2.0) dates from 2026-06.
  5. A materially better retriever may change whether the bge reranker still earns its CPU cost —
     re-measure rerank-on/off on the new retriever (rag-design §11).
- **D1 rider — UNCHANGED, now recorded solely in rag-design §10**: a prefix-using embedder with a
  measurable relevance floor re-opens D1 (unified auto-RAG chat).

### 9.3 Gemma 4 QAT wave — PENDING candidates (2026-07-23, issue #82)

Four `gemma4`-family chat manifests joined the catalog as **pending benchmark candidates** —
official Google QAT Q4_0 GGUFs around the shipped Phase-29 winner `gemma4-12b-it-qat-q4`, added
manifest-only, **rank 0**, **not bundled**, **never auto-recommended** (model-policy.md "Gemma 4
QAT wave" carries the full research record; wave tracking: issue #82). The promotion gate is the
same as the Qwen3.5 wave above — the local, offline German/English grounded-QA eval (§2) + the
speed/RSS sweep (§3/§4) + the §9.1 manual smoke, per size; **public scores do not count**.

| Candidate | Tier | Must beat (to earn a `recommendation_rank > 0`) |
|---|---|---|
| `gemma4-e2b-it-qat-q4` | 4B low-end | `qwen3-4b-instruct-q4` (bundled default) AND `qwen3.5-4b-ud-q4kxl` (rank 3) — the issue-#53 weak-hardware case is the prize. |
| `gemma4-e4b-it-qat-q4` | 8B | `ministral3-8b-instruct-2512-q4` (Phase-29 tier winner) and `qwen3.5-9b-ud-q4kxl` (rank 3) on the §2 axes. |
| `gemma4-26b-a4b-it-qat-q4` | MoE (headline) | `qwen3.6-27b-q4` (rank 3, the 24 GB pick) and `gemma4-12b-it-qat-q4`; also decides whether either opt-in Qwen MoE still earns its 4–8 GB more disk. |
| `gemma4-31b-it-qat-q4` | Dense ceiling (opt-in) | the Qwen3.6 27B pair — AND `gemma4-26b-a4b-it-qat-q4`: if the MoE matches its quality, drop the 31B before it ever ranks. |

The §9.1 checklist applies per size (read its items 3/4 as "the wave models"), with one
wave-specific addition from the 2026-07-23 smokes: **E4B and 26B-A4B think BY DEFAULT** (reasoning
arrives on the `reasoning_content` channel first — unlike the shipped 12B), so the per-size smoke
MUST verify `enable_thinking: false` actually suppresses reasoning — Balanced mode and the #50
extract path depend on it (see the STR-1 §5.4 thinking-checkpoint criterion recorded at the end of
§9's main body: structured surfaces need pinned non-thinking behavior). *(Correction from the
2026-07-30 run: the shipped 12B ALSO thinks by default on b9849 linux-vulkan (`--jinja
--reasoning-format deepseek`) — the "unlike the shipped 12B" contrast did not reproduce and was
likely win-vulkan/0.1.48-specific or stale; the suppression requirement itself is what matters,
and it holds for every size. See the wave outcome below.)*

Smoke state at wave open (2026-07-23, DIY test drive, 0.1.48 portable + b9849 win-vulkan): E2B +
E4B **in-app smoke PASSED** (owner); 26B-A4B loads + answers via CLI but needs a ≥24 GB machine
for in-app use + peak RSS (a 16 GB box mmap-thrashes at ~170 s/reply — the RAM gate works); 31B
un-smoked (same dense arch string as the 12B — lowest risk). All four hashes are real HF-LFS OIDs,
independently re-verified against the HF tree API + resolve-endpoint headers at merge review
(PR #83); E2B/E4B/26B-A4B additionally confirmed by fetch + on-disk SHA-256. RAM lines are
ESTIMATES pending the §4 peak-RSS measurement (each manifest carries its recalibration note).

**Wave outcome — RATIFIED (owner, 2026-08-03).** The full §2 + §3/§4 + thinking + §9.1 evidence
for all four sizes landed 2026-07-30 (contributor run: i9-9900X, 128 GB, RTX 3090, Ubuntu
22.04.5, pinned b9849 linux-vulkan, repo base `7b0203c5`; raw files committed via PR #92 —
`eval/results/i9-9900X-gemma4wave-vulkan-*`, `i9-9900X-{vulkan,cpu}-speed.csv`,
`gemma-thinking-i9-9900X-*.json`; full tables in the issue-#82 comment). Anchor calibration
against the committed 2026-07-09 run held (gemma4-12b F1 delta .0007; qwen3.6-27b-q4
byte-identical), so the two i9 runs are comparable, and **both are hereby ratified as the §9
record** (BUILD_STATE item 8 step (b)), with the **detector-v3 rescored CSVs as the canonical
numbers** (step (a) — see "Scorer v3" below). Decisions against the must-beat table above, each
recorded next to the rank in its manifest:

| Candidate | Decision | Basis (rescored numbers) |
|---|---|---|
| `gemma4-26b-a4b-it-qat-q4` | **rank 2** — ranked runner-up / MoE speed alternative | EM parity with the 24 GB pick `qwen3.6-27b-q4` (.9765 both), ZERO audited hallucinations (both), ~4× its decode (tg 155.8 vs 40.1 t/s vulkan; 15.6 vs 2.8 cpu) at 2.5 GB less disk — but F1 .3307 vs .3523 keeps the Qwen the tier pick (both families share the terse house style, so the §9 length confound does not explain the gap). Never the auto-pick while a rank-3 model fits (pinned in `committed-catalog.test.ts`). |
| `gemma4-31b-it-qat-q4` | **rank 0 forever — DO NOT PROMOTE** | Issue #82's drop condition is met: ties the 26B-A4B within .003 F1 (.3334 vs .3307; both 0 hallucinations, both the same two cautious DE over-abstentions) while decoding 4.2× (vulkan) / 6× (cpu) slower at +3.3 GB disk. Stays selectable as the Apache-2.0 GPU-box quality ceiling; catalog removal deliberately not taken (shipped in v0.1.55). |
| `gemma4-e4b-it-qat-q4` | **rank 0** — missed the 8B bar | F1 .2999 vs Ministral .3111 / `qwen3.5-9b` .3152 / `qwen3-8b` .3262; hallucination-honest after audit (1 real). |
| `gemma4-e2b-it-qat-q4` | **rank 0** — gated on the owed weak-hardware datapoint *(resolved 2026-08-09: the #153 leg landed and promoted it to **rank 3** — see §6.5 "#153 amendment")* | F1 .3373 edges the bundled `qwen3-4b` (.3277) with equal audited hallucinations (3) and the fastest cpu decode measured (24.3 t/s tg) — but `qwen3-4b-2507` keeps the tier quality lead (.3613, 1 real), Deep failed the flip rule at this size (7/8 vs Balanced 8/8), and the issue-#53 weak-16 GB-box measured-tok/s leg is still owed. That datapoint decides (wave follow-up issue). |
| `qwen3.5-35b-a3b-ud-q4kxl` *(§9's deferred-to-speed rank)* | **rank 1** — ranked MoE alternative | The §9 bar ("beat `qwen3-30b-a3b-q4` on speed OR quality by enough") is met on both axes: 0 real hallucinations vs the incumbent MoE's 2 at EM parity (quality), and the 3B-active speed case confirmed (tg 140.9 t/s vulkan / 12.1 cpu vs the dense 27B-Q4's 40.1 / 2.8). *(Residual settled: its §9.1 in-app smoke PASSED 2026-08-09 — see the smokes record below.)* |

Nothing in the run contradicts the §6.4 promoted ranks — where the eval is clear it agrees at the
top end (the Qwen3.6 pair still leads the quality table on the rescored numbers).

**Thinking per size (2026-07-30):** all four wave sizes (and the 12B control) think by default on
the raw b9849 linux-vulkan server and **suppress cleanly with `enable_thinking: false`** (0
reasoning chars, content intact) — the #50 short-cap empty-content class reproduces only in
raw-default mode, which the app never sends, and the #50 extract path is safe on every size.
Deep-vs-Balanced (8-item set, committed JSONs): E4B / 26B-A4B / 31B all 8/8 vs 8/8 (flip rule
satisfied); E2B Deep 7/8 (train-arrival arithmetic slip) — flip rule says NO for E2B.
`supports_thinking_mode` stays true on all four (the mechanism verifiably works; E2B's Deep
*value* is recorded here and in its manifest). The 12B-contrast correction is noted at the
checklist paragraph above.

**§4 RSS / RAM lines (2026-08-03 decision): lines KEPT, measured values recorded per manifest.**
The in-app/vulkan peaks confirm the committed lines (26B-A4B 14.28 GiB → min 20 ✓; 31B 17.78 →
24 ✓; E2B 4.40 cpu → 8 ✓; E4B 7.32 cpu → 12 ✓; `qwen3.6-27b-q4` 16.87 → formula-exact 20 ✓; Q5
19.38 → 23 ≤ 24 ✓; 9B 6.57/7.93 → ≤ 12 ✓; 4B 3.44/4.22 → 8 ✓; 35B 21.46 → 25 vs 24, within the
basis question). The Linux **pure-CPU** max-RSS values (26B 27.5 GiB, 31B 36.2, 27B-Q4 26.9, 35B
32.4) count mmap-resident weight pages and are NOT comparable to the Windows-PeakWorkingSet basis
the catalog lines were calibrated on — the same sweep read the 27B-Q5 (19.6) BELOW the Q4 (26.9),
a page-cache artifact, so no line is retuned from that basis. A Windows-basis re-measure is the
recorded follow-up; a cpu-only 24 GB box running the 27B-Q4 is acknowledged tight.

**§9.1 smokes (2026-07-30, through the real UI via CDP, b9849 linux-vulkan):** 26B-A4B and 31B
PASS every leg (start / stream / grounded+cited / mid-stream abort / stop+quit teardown / Deep
on + Balanced suppressed; in-app peaks 14.28 / 17.78 GiB) — closing the two open per-size smokes;
E2B/E4B were owner-PASSED 2026-07-23 (win-vulkan) and this run adds the missing linux legs via
harness+eval. The still-owed §6.4 smokes for the promoted set also PASSED: `qwen3.5-9b`,
`qwen3.6-27b-q4`, `qwen3.6-27b-q5` — all legs, in-app peaks 6.57 / 16.87 / 19.38 GiB. No
`llama-server` survived a stop or quit in any smoke. Open smokes after this wave: the 35B-A3B
(rank 1, no auto-pick exposure) — tracked in the follow-up issue. *(Closed 2026-08-09, below.)*

**§9.1 smoke — `qwen3.5-35b-a3b-ud-q4kxl` (2026-08-09, through the real UI via CDP, b9849
linux-vulkan):** the last owed promoted-set smoke, run on the same rig + reusable eval drive
as the 2026-07-30 evidence run (i9-9900X, 125.5 GB, RTX 3090, Ubuntu 22.04.5, dev build of
repo head at `f2a152df`; issue #95 item 4). PASS on every leg: in-app checksum verify of the
22.2 GB sha256-pinned weight (81 s); start via the AI Model screen (spawn-to-running 14 s,
real `llama-server` sidecar on the 35B GGUF, GPU backend shown in the chat header); normal
chat prompt streams coherently; document-grounded ask in "Ask my documents" mode answers from
the corpus with a correct `[S1]` citation; mid-stream abort (stream ended 203 ms after Stop);
Deep shows the reasoning line, Balanced suppresses it cleanly (0 reasoning surfaced —
consistent with the §9.3 thinking table); stop teardown and quit-while-running teardown both
leave NO new `llama-server` (asserted twice; a pre-existing orphaned sidecar from an earlier
unrelated session was recorded and excluded). Sidecar peak `VmHWM` 22.07 GiB (Linux basis,
consistent with the 21.46 GiB vulkan peak above; the Windows-basis question is unchanged).
Weights were already on the eval drive from the 2026-07-30 run; the in-app SHA-256 verify
this run re-confirmed the manifest pin, so no re-download was performed.

**Scorer v3 (step (a), 2026-08-03):** the refusal detector missed 9 genuine abstentions across
the two i9 runs (4 in 2026-07-09 incl. the "kein/keine … erwähnt" family; 5 in 2026-07-30:
"keine spezifische Information", "kann … keine … finden", "I do not have information", "do not
state", "there is no … mentioned"). `ABSTAIN_PHRASES` was extended and split-negation
`ABSTAIN_PATTERNS` added (`tests/eval/text.mjs`, regression-pinned with the verbatim run answers
in `score.test.ts` — including the audited REAL hallucinations that must stay non-matches), and
`eval/rescore.mjs` re-ran over all four dumps. Effect audited item-by-item: the two i9 runs flip
EXACTLY the nine audited items (no answerable-item flips); the committed i7 rescore changes one
cell (`qwen3-8b` over-abstain .0118→.0235 — an answerable refusal previously read as plain
wrong); devbox is byte-identical. Canonical rescored deltas vs the raw CSVs: `qwen3.6-27b-q4`
hallucinations .0667→0 (both runs), `qwen3-8b` .2→.1333, `qwen3.5-35b-a3b` .0667→0,
`qwen3.5-2b` .3333→.2667 (its audit's "4–5 real" resolves to 4), E2B .40→.20 (3 real), E4B
.1333→.0667 (1 real). EM/F1/citation columns are abstention-independent and unchanged.

### 9.4 Qwen3.8-27B wave — measured, PENDING ratification (2026-08-15)

Unsloth published `Qwen3.8-27B-GGUF` (dense 27B, vision-language upstream, thinking on by
default, arch string `qwen35`) and four quants were measured the same day on the i9-9900X +
RTX 3090 box: `Q4_K_M`, `UD-Q4_K_XL`, `Q5_K_M`, `Q6_K`. **No manifests yet, no ranks moved** —
this section records the evidence; productization (manifest + hash + license review) and the
§9.1 in-app smoke are open follow-ups. Text-only measurement; the upstream mmproj/vision side
was not exercised (same posture as the `qwen3.6-27b` chat manifests).

**Runtime caveat:** measured on the **b10430** ubuntu-vulkan release (not the b9849 pin) — the
arch loads on b9849-era builds (`qwen35`), but the speed rows are NOT directly comparable to
the b9849 CSVs and live in their own file: `eval/results/i9-9900X-vulkan-b10430-speed.csv`.

**Quality (§2 harness, one combined 4-model run; raw files
`eval/results/i9-9900X-qwen38-vulkan-{quality.csv,quality-rescored.csv,items.jsonl}`):**
all four quants land inside a .0026 F1 band — quantization does not move this eval.

| Model | mean F1 | EM | halluc | abstain(unans) | vs `qwen3.6-27b-q4` (.3523) |
|---|---|---|---|---|---|
| `qwen3.8-27b-q4` | .3500 | .9765 | 0 | 1.0000 | −.0023 (inside cross-run noise) |
| `qwen3.8-27b-ud-q4kxl` | .3507 | .9765 | 0 | 1.0000 | −.0016 |
| `qwen3.8-27b-q5` | .3523 | .9765 | 0 | 1.0000 | ties; `qwen3.6-27b-q5` (.3573) stays the table lead |
| `qwen3.8-27b-q6` | .3503 | .9765 | 0 | 1.0000 | −.0020 |

Zero hallucinations and perfect unanswerable-abstention on ALL four quants (the only other
models with that profile: `qwen3.6-27b-q5`, `gemma-4-26b-q4`, and post-rescore `qwen3.6-27b-q4`
+ `qwen3.5-35b-a3b`). Thinking suppresses cleanly via `chat_template_kwargs.enable_thinking:
false` (the harness's Balanced-mode default; verified — reasoning lands on `reasoning_content`
and content stays intact). Determinism note: a repeated single-model q6 run differed by ±.002
F1 (Vulkan reduction nondeterminism); immaterial at the decision scale.

**Speed/RSS (§3/§4, b10430 vulkan, each quant measured solo from a ≤45 °C GPU):** rows in
`i9-9900X-vulkan-b10430-speed.csv`. Method notes that matter for reproduction: `tg` is highly
thermally sensitive on this box (Q6 dropped 31.7→23.6 t/s when run 4th in a back-to-back
sweep — GDDR6X memory-clock throttle), so per-quant cool-start runs are the recorded numbers;
`pp512` under-reads on Vulkan because the burst is shorter than the boost-clock ramp (reps
climb monotonically), so the pp512 column is the **median of 3 reps after an in-invocation
pp2048 warm-up**, while pp2048/pp8192/tg are plain llama-bench averages of 3.

| Quant | pp512 | pp2048 | pp8192 | tg128 | peak VRAM bench / server 8k ctx | peak RSS | min RAM |
|---|---|---|---|---|---|---|---|
| Q4_K_M | 1085 | 1208 | 1168 | 39.9 | 17.1 / 17.2 GiB | 17.16 GiB | 21 |
| UD-Q4_K_XL | 997 | 1096 | 1060 | 35.0 | 17.9 / 17.9 GiB | 17.92 GiB | 21 |
| Q5_K_M | 1057 | 1134 | 1097 | 35.9 | 19.5 / 20.0 GiB | 19.70 GiB | 23 |
| Q6_K | 985 | 1122 | 1092 | 31.7 | 22.2 / 22.7 GiB | 22.54 GiB | 26 |

`qwen3.8-27b-q4` reproduces the `qwen3.6-27b-q4` envelope almost exactly (tg 39.9 vs 40.1,
peak RSS 17.16 vs 16.87 GiB) — same tier, same formula minimum. `Q5_K_M` out-decodes the
smaller `UD-Q4_K_XL` (35.9 vs 35.0 t/s; K-quant kernel efficiency), which weakens the UD
quant's case at this size. **`Q6_K` fully fits a 24 GB GPU at ctx 8192** (22.7 GiB peak VRAM,
no spill) — a genuine new option the 3.6 wave never had measured. CPU leg (Q4_K_M, `-ngl 0`,
same build): pp512 118.4 / pp2048 120.1 / pp8192 118.3 / tg 2.83 t/s — the `qwen3.6-27b-q4`
CPU envelope reproduced (tg 2.79 on b9849); peak-RSS cells left empty (not re-measured on the
CPU basis — the §9.3 Windows-basis standing rule applies before any manifest carries a number).

**Wave outcome — RATIFIED (owner, 2026-08-16).** The provisional read became the decision, as a
**full generational handover** (owner call at ratification, one step beyond the default
demote-to-rank-2 option): `qwen3.8-27b-q4` **rank 3** takes 24 GB, `qwen3.8-27b-q5` **rank 3**
takes ≥32 GB, and the Qwen3.6 pair drops to **rank 1** (below the gemma rank-2 runner-ups;
still ranked + selectable; its Q5 keeps the all-time F1 record .3573 — recorded honestly in
both manifests, the handover is the §6.4 generational call, not a quality verdict).
`qwen3.8-27b-q6` enters at **rank 0 BY DESIGN** — the q5 sibling wins the ≥32 GB RAM tier
(faster at equal quality) and Q6_K's real niche (fully fits a 24 GB GPU at ctx 8192) is not
expressible in the RAM-tier picker; it stays the selectable "24 GB GPU quality ceiling" (the
gemma4-31b precedent). `UD-Q4_K_XL` earns no manifest (out-decoded by the larger q5 at equal
quality). Productization discharged at ratification: all three manifests carry real HF-LFS
hashes independently confirmed by on-disk SHA-256, and the apache-2.0 license review is
recorded per manifest (full record: `offline-intelligence-private/legal/`
`model-licensing-qwen38-addendum-2026-08-16.md`). Mapping pins updated in `benchmark.test.ts` +
`committed-catalog.test.ts` (new Qwen3.8 wave block). §9.1 smoke: see the wave smoke record
below.

**§9.1 smokes — all three quants PASSED (2026-08-16, through the app's real IPC/runtime path
via CDP/Playwright `_electron`, dev build of this branch, i9-9900X + RTX 3090, drive runtime =
the pinned b9849 linux-vulkan):** the smoke drive's runtime is the b9849 pin, so this ALSO
discharges the §9.4 "b10430 measurement basis" runtime-compat caveat — the pinned binary loads
and serves the `qwen35`-arch GGUFs. Per quant (q4 / q5 / q6): in-app SHA-256 verify of the
manifest-pinned weight (66 / 76 / 90 s) then start via the app's model path (`useModel`, GPU
backend, real `llama-server` sidecar); balanced chat streams coherently with ZERO reasoning
frames (suppression verified); Deep surfaces reasoning frames (34 / 36 / 35); grounded ask
answers from an imported document with the exact fact and a correct `[S1]` citation (DE);
mid-stream abort ends the stream in 5 / 4 / 3 ms; sidecar `VmHWM` 17.14 / 19.68 / 22.52 GiB
(Linux basis — consistent with the §4 llama-server peaks); `stopRuntime` teardown leaves no
chat sidecar and quit-while-running teardown leaves no `llama-server` of any role (embeddings /
reranker sidecars legitimately idle past a chat stop and are excluded from the stop leg only).
Text-only chat needed no mmproj on any quant.

**MTP speculative decoding — measured 2026-08-17; ADOPTED 2026-08-19 for the Q4/Q5 manifests
(issue #182); both hardware gates PASSED 2026-08-19.** _Adoption record: `architecture.md` "MTP
speculative decoding — design record (issue #182, §1–§7)". The two manifests carry
`speculative_decoding: mtp`; the runtime gates the flags on a probed GPU with the weight +
3.5 GiB free VRAM and falls back to the plain GPU rung otherwise. Issue gate 3 (CPU-only path)
is closed by construction: the runtime drops the flags off-GPU. The RAM/VRAM rows below and in
the manifests stay the PRE-MTP measurements until re-measured with the flag on._

**Gate results (2026-08-19, i9-9900X + RTX 3090, drive runtime = the pinned b9849
linux-vulkan; Wi-Fi off, each timed run from a ≤45 °C GPU):**

- **§2 grounded-QA re-run with MTP on, both quants: score parity HELD.** Run per quant with
  `HILBERTRAUM_EVAL_SPECULATIVE=mtp` under its own machine label; the flag pair was verified on
  every scored server's argv, and a standalone b9849 spawn of the same weight logged
  `draft acceptance = 0.81` with no `blk.64.nextn.*` "unused tensor" warnings, so the head was
  live, not a no-op. Against the committed pre-MTP baseline: `qwen3.8-27b-q4` mean F1 .3499 vs
  .3500, `qwen3.8-27b-q5` .3518 vs .3523 (f1_de .3532/.3568 both exactly reproduced; f1_en
  −.0004/−.0014), EM .9765, citation-correct .9882, grounded .9765 all unchanged, and the two
  hard metrics held on both quants: hallucinations 0, unanswerable-abstention 1.0000. Every
  delta sits inside the ±.002 §9.4 determinism floor, and the parity also spans the build
  difference (baseline measured on b10430, this re-run on the b9849 pin). Item audit: 92/100
  (q4) and 91/100 (q5) answers byte-identical; each changed answer is a near-tie token flip
  (rephrase or citation formatting) with the same facts and the same abstention decision.
  Raw files committed: `eval/results/i9-9900X-qwen38-mtp-q{4,5}-vulkan-{quality.csv,items.jsonl}`.
- **§9.1 smoke legs with the flag on, b9849 pin, both quants PASSED** (through the app's real
  IPC/runtime path via CDP/Playwright `_electron`, dev build of the #191 branch, same driver
  shape as the 2026-08-16 wave smokes). Per quant (q4 / q5): rung 1a taken (log shows
  `Speculative decoding enabled (MTP draft head)` and `started via rung 1a (GPU auto-offload +
  MTP speculative decoding) (backend: gpu)`; sidecar argv carries the flag pair); **full
  offload with 24 GB headroom, no spill: peak VRAM 19.7 / 21.5 GiB** (pre-MTP server peaks
  17.2 / 20.0 GiB, so the draft head cost ~2.5 / ~1.5 GiB here); balanced chat streams
  coherently with ZERO reasoning frames; Deep surfaces 32 / 31 reasoning frames; grounded DE
  ask answers with the exact fact and a correct `[S1]` citation; mid-stream abort ends the
  stream in 3 / 3 ms; sidecar `VmHWM` 17.14 / 19.68 GiB, byte-for-byte the pre-MTP §9.1
  record (the draft head and its KV live in VRAM), recorded only: no `recommended_min_ram_gb`
  touched; `stopRuntime` leaves no chat sidecar and quit-while-running leaves no `llama-server`
  of any role. **Fall-through + re-arm also exercised** (q4, a shim binary rejecting
  `--spec-type`): rung 1a fails with `error: invalid argument: --spec-type`, the model comes up
  on plain rung 1 at `backend: gpu`, `gpuAutoDisabled` stays false, the next start in the same
  session skips 1a with `latched off for this session by an earlier attempt`, and Diagnostics'
  "Try GPU again" re-arms the rung (a fresh 1a attempt on the following start). Teardown clean.

The measurement record, unchanged: the Qwen3.8 GGUFs ship a trained-in draft head (`blk.64.nextn.*` — 15
tensors the server loads and ignores by default; visible as "unused tensor" warnings in every
§4 log). `--spec-type draft-mtp --spec-draft-n-max 2` activates it with no extra files and
measured **+38–45% server-level decode** on the i9/3090 (Q4_K_M, b10430 vulkan, steady-state
temp-0 completions: ~25 → 35.3 prose / 36.6 code t/s, draft acceptance 77–91%). Verified
facts an adoption must respect: (1) works on the **b9849 pin** too (functionally verified);
(2) costs ~2 GiB VRAM (draft head + its KV; the `--spec-draft-type-k/v q8_0` +
`--cache-type-k/v q8_0` quartet recovers ~1.6 GiB) — Q4/Q5 keep 24 GB headroom, **Q6_K + MTP
does not fit 24 GB** at ctx 8192; (3) breaks temp-0 byte-reproducibility (batched-verification
near-tie flips; distribution-equivalent output — the §2 harness must be re-run as the adoption
gate); (4) draft depths n=3/4 neither break nor help (n=4 acceptance falls to 64%) — the
"n=4 emits junk" claim circulating publicly did not reproduce on this stack; n=2 is the pick.
`-np 1` showed no throughput effect at ctx 8192 (default `n_slots=4`, unified KV).

### 9.5 The Qwen3.8 wave lost its upstream files (2026-08-20, issue #196)

**What happened.** Four days after the §9.4 promotion, unsloth restructured
`unsloth/Qwen3.8-27B-GGUF` for their Dynamic 3.0 rollout and **deleted the plain static
K-quants**. All three files the wave pins return HTTP 404 (verified 2026-08-20 with `HEAD`
requests on the exact manifest URLs); the repo now publishes `UD-*` files plus legacy
`Q4_0/Q4_1/Q8_0` — different weights, different hashes. Hash pinning did its job: we can never
silently receive substituted weights. We also cannot fetch these exact files again.

**Blast radius, measured not assumed.** Every committed `download.url` in the catalog was
re-checked the same day (28 URLs, `HEAD` + redirects): **only the three Qwen3.8 manifests are
dead.** The Qwen3.6 pair is intact — URL alive AND the upstream LFS OIDs still equal the
committed hashes (`5ed60d0a…` / `cfecab16…`), so the tier fallback below rests on a live,
unchanged source. Drives that already carry a Qwen3.8 weight are unaffected in every way: the
local file still matches the pinned SHA-256, verification passes, the model starts, and MTP
speculative decoding (§9.4 addendum) still applies.

**Decision (interim, 2026-08-20).** The measurements of §9.4 stand — nothing about the models
changed, only their obtainability — so the manifests are **kept as installed-base records** with
the dead URL, hash and size intact (option 2 of issue #196, the posture prior waves used for
weight changes), plus a new machine-readable `download.withdrawn` note. Two consequences:

1. **Ranks.** `qwen3.8-27b-q4` and `-q5` go **rank 3 → 0** (selectable, never auto-recommended —
   the existing rank-0 convention, cf. the q6 sibling and gemma4-31b). The §9.4 generational
   handover is **reverted**: `qwen3.6-27b-q4` retakes 24 GB and `qwen3.6-27b-q5` retakes ≥32 GB
   at **rank 3**. Rationale: a recommendation the user cannot act on is worse than a
   slightly-older recommendation they can — and the Qwen3.6 pair is the best-measured pair on
   this harness whose weights can still be downloaded (q5 still holds the all-time F1 record
   .3573). The §6.5 stepped picks move with it (≥32 GB crawl now lands on `qwen3.6-27b-q4`).
2. **No estimated successors.** The `UD-Q4_K_M` / `UD-Q5_K_M` / `UD-Q6_K` candidates are NOT
   productized here. Manifest numbers are measured, never estimated, and the successor files
   need the full per-quant wave on the i9-9900X + RTX 3090 rig (§9.4 method): SHA-256 on disk,
   §2 grounded-QA vs the committed baseline, §3/§4 speed + peak VRAM/RSS at ctx 8192, §9.1
   in-app smokes on the b9849 pin. **One extra gate for the successors:** Dynamic 3.0 publishes
   the MTP module as a SEPARATE file (`MTP/mtp-Qwen3.8-27B-Q4_0.gguf`, 1.37 GB), so the
   `speculative_decoding: mtp` claim — which asserts a draft head *inside the same GGUF*, with
   no `--model-draft` — must be re-verified per successor file and dropped if the modules are
   no longer in-GGUF. Verified upstream facts as of 2026-08-20 (HF LFS metadata), so the wave
   starts from data rather than a re-lookup:

   | successor candidate | size (bytes) | LFS OID (= SHA-256) |
   |---|---|---|
   | `Qwen3.8-27B-UD-Q4_K_M.gguf` | 16,464,440,224 | `322e194ff79741c7baa497c240f677f54b201b0efab44ca8e50f122b39123482` |
   | `Qwen3.8-27B-UD-Q5_K_M.gguf` | 19,771,509,664 | `2de73110cb254cbf09b54b717578dadff12ef1194e7271527e68202f39ba4bfd` |
   | `Qwen3.8-27B-UD-Q6_K.gguf`   | 21,983,677,344 | `c9c206812fbe4ac7b76a729e25928b63f2ae89d37f69da7a71c20aec763cd436` |

   These are upstream metadata, NOT a promotion: a hash only becomes a manifest pin after the
   file is downloaded and hashed on disk (model-policy.md's checksum-honesty rule).

**Product change shipped with this record** (so the failure is legible instead of an HTTP 404):
the manifest field `download.withdrawn` — see model-policy.md "Withdrawn upstream sources
(`download.withdrawn`)" for the schema, the planner status, the in-app copy and the fetch-script
behaviour. License posture is unchanged (same upstream repo, apache-2.0); nothing was
redistributed, so no DRIVE-NOTICES regeneration is implied.

---

## 10. Skills extraction & real-model smoke (skills-remediation T1, audit §7)

Two offline guards for the skills extract/analysis paths — one always-on, one opt-in — added by
skills-remediation Phase T1. They close the two audit §7 test-blindness classes: committed extractor
fixtures were synthetic and post-hoc (built to match the parser, so every real-layout incident —
INVOICE-TOTALS-1, the HVB zero-transactions case, the §5.3 NBSP/Unicode family — slipped through), and NO
skill path was ever exercised against a real model (the same class that shipped the RUNTIME-5/6 vision
salad).

### 10.1 Real-layout fixture corpus + output-snapshot guard (always on, in `npm test`)

`tests/fixtures/real-layouts/corpus.ts` is the single committed home for the extractor incident-class
fixtures — constructed AT/DE/CH bank statements + invoices (**never real user documents**, special
characters written as `\u` escapes so a git/editor normalization can't silently defeat the incident class)
carrying the layouts that actually broke: NBSP / narrow-NBSP thousands grouping, U+2212 / en-dash minus
signs, the German `Summe` / `Summe netto` / `Endbetrag` / `Rechnungssumme` totals labels, SEPA rows,
`dd.mm.yy` + cross-year dates, and wrapped descriptions.
[`tests/integration/extractor-realworld.test.ts`](../apps/desktop/tests/integration/extractor-realworld.test.ts)
runs the corpus through the REAL production extractors (the same currency-vote / date-order / anchor
inference the tool does) and asserts the parsed figures, AND pins a per-fixture hash of the full extractor
output in `extractor-output.snapshot.json`, keyed by `BANK_EXTRACTOR_VERSION` / `INVOICE_EXTRACTOR_VERSION`.
Each entry also stores an **input hash** so the guard can tell a *corpus edit* apart from an *extractor
change*: an output change on UNCHANGED fixture input means the extractor moved, and MUST bump the version;
an output change because a fixture was edited needs no bump. Any output change FAILS the default suite until
the snapshot is regenerated — and regeneration itself REFUSES to write when the output moved for unchanged
input without a version bump, so the rule cannot be silenced by regenerating alone:

```powershell
UPDATE_EXTRACTOR_SNAPSHOT=1 npx vitest run tests/integration/extractor-realworld.test.ts
```

This is the mechanical backstop for the repo rule "every extractor behaviour change bumps the version by
exactly 1 so stale rows re-extract" — no model, no network.

### 10.2 The opt-in real-model smoke (`SKILLS_SMOKE_MODEL`)

[`tests/e2e-model/skills-smoke.test.ts`](../apps/desktop/tests/e2e-model/skills-smoke.test.ts), the same
env-gated pattern as the vision / gpu / rerank smokes (§8.1) — `describe.runIf` keeps it COLLECTED (the
full-suite guard) but SKIPPED in CI, so the green gate stays zero-model / zero-network:

```powershell
$env:SKILLS_SMOKE_MODEL = "D:\models\chat\qwen3.5-4b-ud-q4kxl.gguf"
cd apps\desktop
npx vitest run tests/e2e-model/skills-smoke.test.ts
```

It drives the REAL production answer paths against a local chat GGUF (CPU-pinned, `--device none`): the
invoice + bank THIRD MODE (grounded-data — the model NARRATES the deterministically-verified extract with
the figure echo appended verbatim beneath) over the real-layout corpus, plus one German whole-document
minutes turn. It asserts STRUCTURE + FIGURES (the third mode engaged; the deterministic totals / cashflow
echo rides under the model answer; whole-doc coverage is capped + not truncated; end-of-transcript items
present) — **never prose / wording**. This is the autonomous stand-in for the manual GUI smoke of the three
complaint flows (bank statement, invoice, minutes). Overrides: `HILBERTRAUM_LLAMA_BIN`, `SKILLS_SMOKE_ROOT`
(defaults target `D:\`).

---

## 11. Translation model (TranslateGemma 12B) — TG-6 measurements + the promotion bar

The `translation` role (design record in [`architecture.md`](architecture.md) "Translation sidecar
— design record") is a THIRD benchmark axis, separate from the chat catalog (§1–§7) and the vision
sidecar (§8): a different role (`translation`), served by its OWN lazy `llama-server` on the raw
`/completion` endpoint (NO `--jinja`, `--chat-template gemma`, `--parallel 1`, `--ctx-size 4096`;
since issue #42 the device posture follows `gpuMode`/`gpuAutoDisabled` — GPU auto-offload by
default, `--device none` when forced to CPU). The §11.2 numbers below are the **CPU-decode**
measurements (recorded under the original TG-2/TG-6 CPU pin); the GPU posture's tokens/sec is the
open §11.4 re-smoke. The only shipped model is
**`translategemma-12b-it` (mradermacher Q4_K_M, 7.30 GB, sha256 `b7aac4b4…a528`)**. Numbers below
are the **real b9849 Vulkan-pin measurements** captured by the TG-6 run of the manual smoke +
`llama-tokenize` (drive root junctioned to `D:\`, 2026-07-05).

### 11.1 The manual smoke harness (`HILBERTRAUM_TRANSLATEGEMMA_SMOKE`)

[`tests/manual/translategemma-smoke.test.ts`](../apps/desktop/tests/manual/translategemma-smoke.test.ts),
the same env-gated pattern as vision/gpu/rerank/skills (§8.1, §10.2) — SKIPPED in CI (zero
model/binary/network). It composes `LlamaServer` with the SHIPPING `translationServerArgs(device)`
and drives the SHIPPING prompt builder + `/completion` reader, so it proves model + prompt +
endpoint fidelity on the real pin AND records the calibration numbers. The device posture defaults
to the shipping `'auto'` (GPU auto-offload); set `HILBERTRAUM_TRANSLATEGEMMA_SMOKE_DEVICE=cpu` to
re-measure the forced-CPU posture the §11.2 numbers were recorded on:

```powershell
$env:HILBERTRAUM_TRANSLATEGEMMA_SMOKE = "<root with runtime/llama.cpp/<os>/llama-server + models/{translation,embeddings,chat}/*.gguf>"
cd apps\desktop
npx vitest run tests/manual/translategemma-smoke.test.ts
```

Legs: (1) load on the pin (#22908 risk); (2) `/props` chat_template = `gemma` (V1 reconcile); (3–6)
DE↔EN sanity + verbatim identifiers + injection-resistance + no `<end_of_turn>` leak; (7) sidecar
peak RSS; (8) per-language round-trip for the curated 10; (9) Gemma tokens-per-word (input via
`/tokenize` per source lang; output per source word into the heavy targets); (10) co-residency peak
RSS (translation + E5 + a resident chat). GATE: if the pin can't load or `/completion` breaks
(#20305-adjacent), STOP — do not ship. (Tokens-per-word amortized over realistic-length prose is
measured with `llama-tokenize` directly — the per-window planner operates on hundreds of words, so
the short in-smoke sentences over-state the ratio; §11.2 uses the amortized numbers.)

### 11.2 Measured (real b9849 Vulkan pin, CPU decode)

| Datum | Value | Note |
|---|---|---|
| Weight | `translategemma-12b-it.Q4_K_M.gguf` — 7.30 GB | Gemma license; downloadable behind the license-ack gate; NOT bundled |
| **Peak RSS (sidecar alone)** | **≈ 9.3 GiB** | `--device none`, ctx 4096 (`PeakWorkingSetSize`; TG-2 saw ≈9.5) |
| **Peak RSS (co-resident)** | **≈ 13.2 GiB** | translation ≈9.2 + E5 embedder ≈0.14 + a 4B chat ≈3.9, all warm at once — the doc-task materialize shape (D9) |
| Cold load | ≈ 26–37 s | warm OS cache ~26 s; cold-from-USB ~37 s (TG-2) |
| **CPU decode** | **≈ 3–4 tok/s** (nominal) | ranged 1.1–4.4 across the TG-6 run under machine load; TG-2 clean run 3.7–4.0 |
| **Input tok/word (Gemma, prose)** | en 1.11 · de 1.43 · nl 1.65 · uk 2.13 · pl 2.19 · **cs 2.26** | `llama-tokenize` over realistic office prose; a token-dense 20-word invoice line peaks ~2.8 |
| **Output tok/source-word (prose)** | en→de 1.39 · de→pl 1.79 · de→uk 1.90 · **de→cs 1.96** | word-sparse German source → token-dense target, the worst case; dense short samples reach ~3.06 |
| Fidelity (curated 10) | round-trip OK for all ten; invoice no. + model code verbatim; numbers LOCALIZED; injection resisted; no stop-token leak | the recorded evidence the widened `TranslationLangCode` cites |

_Issue #31 (2026-07-07) widened the SHIPPED language set from these curated 10 to the 51-code
WMT24++ production tier (architecture.md "Translation sidecar" record, issue-#31 bullet). The
fidelity row above remains the LOCAL evidence for the original 10; the widened 41 ship on the
model's own WMT24++ evaluation (12B: MetricX-24 3.60 / COMET22 83.5). The smoke's calibration leg
still measures the 10 (`SMOKE_LANGS`) — a 51-language sweep at ~3–4 tok/s CPU would run for hours;
add a sample there to promote a widened language into the measured set. The tokens-per-word planner
ceilings stay safe on the widened space-less scripts (ja/zh/th/…): `approxTokenCount` charges those
per-character, which over-counts vs the real tokenizer — the same over-chunk-never-overflow
direction._

**The load-bearing TG-6 finding — the Qwen-era planner constants were unsafe on the Gemma
tokenizer.** The chat path's `1.3` input / `2.0` output tokens-per-word (measured on Qwen3-4B,
carried as "conservative defaults" through TG-3) are ~HALF the real Gemma weight (up to 2.26 input /
1.96 output on realistic prose, higher on dense content). Left unfixed, a full ~1,150-word window
(what the chat estimate implied) would have been ~3,200+ input tokens ALONE — blowing past both the
2K trained input AND the launched 4096 context (silent input/output truncation). TG-6 replaced them
with measured-then-rounded-UP ceilings (`TRANSLATION_INPUT_TOKENS_PER_WORD = 2.5`,
`TRANSLATION_OUTPUT_TOKENS_PER_WORD = 3.0`, `doctasks/translation.ts` — a translation-specific input
constant, NOT the shared chat-model `SUMMARY_TOKENS_PER_WORD`) so a window can only ever OVER-chunk
(harmless), never overflow. Consequence: **~690-word windows** at ctx 4096 (more, smaller than the
old estimate; `windowMaxTokens` ≈ 2,071), the honest cost of the heavy tokenizer. Over-chunking is
the only failure mode; the doc-task suite's "fit property" proves input estimate + output cap ≤ the
usable context at every context size.

**Decisions revisited at TG-6:**
- **D8 (GPU) — TG-6 kept the CPU pin for v1** (~3–4 tok/s tolerable for a BACKGROUND doc-task with
  per-window progress + instant cancel; the smoke drive was Windows Vulkan where #25142, the
  parallel-translation hang, was the live risk; GPU deferred, not rejected). **Superseded by issue
  #42 (2026-07-09):** the sidecar now honours `gpuMode`/`gpuAutoDisabled` per cold start (GPU
  auto-offload by default) with a forced-CPU fallback + session latch on a GPU fault — see §11.4
  for the ladder and the OPEN GPU-decode re-smoke. #25142 stays contained by `--parallel 1` in
  both postures. The per-window request timeout stays at the CPU-sized **45 min**
  (`DEFAULT_REQUEST_TIMEOUT_MS`): a ~2,070-token full window at the observed-worst ~1.1 tok/s is
  ~30 min, so 45 min never false-kills a live slow CPU decode while still bounding a true hang
  (user cancel stays instant; on a GPU decode the bound is simply generous).
- **D9 (chat-during-translation relaxation) — KEEP serialization.** The co-residency measurement is
  the reason: translation ≈9.2 GiB + a resident chat + embedder already reaches ≈13.2 GiB with a 4B
  chat; a 12B chat (≈6.5 GiB) pushes the pair PAST a 16 GB machine. Letting chat DECODE during a
  translation would put two large models under active compute + full RAM at once — infeasible on the
  target hardware. The doc-task lane + the view-job `docTaskBusy` guard stay.
- **min-RAM (D10):** `recommended_min_ram_gb` = **13**, `recommended_ram_gb` = **24** (PR #30,
  2026-07-07 — corrected from the TG-6 initial 17/32). `recommended_min_ram_gb` is the HARD start
  gate (`registerModelIpc` §11.4 refuses a model whose min exceeds the machine's RAM), and the
  catalog convention — every chat manifest and the vision role model (§4 / §8.4 PROD-1) — is that
  this gate is the **model-alone** floor: the §4 rule (peak + ~3 GiB headroom, rounded up) applied
  to TranslateGemma's OWN peak RSS **9.22 GiB** ⇒ 9.22 + 3 = 12.22 → **13**. That lands with the
  rest of the catalog (ministral 8.7→12, gemma4-12b 10.6→14) and, crucially, **clears the gate on a
  standard 16 GB machine**. The **co-residency** floor (translation ≈9.22 + E5 ≈0.14 + a small 4B
  chat ≈3.89 = **13.24 GiB**, excluding the Electron shell + OS) belongs in `recommended_ram_gb`,
  not the hard gate — a 12B resident chat (≈6.5 GiB more) pushes the pair toward ~24. On a 16 GB box
  that co-residency pressure is handled exactly as for vision (§8.4): the chat sidecar's
  idle-teardown + the RAM-best-fit picker, **not** by blocking the model from ever loading.
  **Why the change:** the original 17 baked the co-residency floor into the hard min — the *only*
  manifest to do so — which locked translation out of every 16 GB machine even though the model
  alone fits with headroom. The D9 serialization decision above (chat does not decode during
  translation) is what keeps the co-resident case safe; the hard gate does not need to. Regression
  is guarded by `tests/integration/committed-catalog.test.ts` ("RAM start-gate invariants").

### 11.3 The promotion bar — what a future translation candidate must beat

Same discipline as §9 (the Qwen3.5 wave) and §8.3 (vision): **public MT benchmark scores are NOT a
promotion signal here.** WMT24++ MetricX/COMET (4B 5.32/80.1, 12B 3.60/83.5, 27B 3.09/84.4) is why
the 12B was chosen over the 4B, but a NEW candidate (a TranslateGemma 4B/27B — manifest-only
follow-ups per the plan's O3/§6 — or a successor family) earns `recommendation_rank > 0` ONLY by
beating the shipped 12B on the LOCAL evidence:

1. **The TG-6 smoke passes on the pin** — loads, `/completion` clean (no #20305/#22908), the curated
   10 round-trip with verbatim identifier/number preservation, injection-resistant, no stop-token
   leak.
2. **Tokens-per-word re-measured** for its own tokenizer (the planner constants are model-specific —
   a different tokenizer needs its own `llama-tokenize` sweep; do NOT inherit the 2.5/3.0).
3. **Peak RSS (sidecar-alone AND co-resident)** measured → its own `recommended_min_ram_gb`.
4. **CPU tok/s** measured → the per-window timeout + the D8 GPU decision re-run for that model.
5. **Translation quality** judged on the SAME per-language round-trips (fidelity, localization,
   injection-resistance) — a smaller model must not regress German/Slavic/Cyrillic fidelity, a
   larger one must justify the RAM/latency it costs.

A candidate that only looks better on paper stays `recommendation_rank: 0` (manual, never
auto-recommended, never bundled) until the local evidence gives it a real rank. Image translation
(the model is image-text→text; mmproj projectors exist) stays out of scope (the plan's §6): a later
Images-screen integration, not a benchmark axis here.

### 11.4 GPU offload (issue #42) — the device ladder + the OPEN GPU-decode re-smoke

Issue #42 (2026-07-09) pulled TG-6's deferred D8 forward. As built (`translation/runtime.ts`,
regression-pinned in `translation-runtime.test.ts`'s "GPU device ladder" suite):

- **Signals:** the sidecar reads the SAME Settings callbacks the chat ladder gets (`gpuMode` +
  `gpuAutoDisabled`, one shared `gpuSignals` object in `main/index.ts`) — re-read per **cold
  start**, so with the 2-min idle teardown a Settings flip takes effect on the next translate, no
  restart.
- **Postures:** allowed ⇒ `translationServerArgs('auto')` — NO device args (b9849 ngl=auto +
  fit=on VRAM-aware offload; a GPU-less machine lands on CPU exactly as before). `gpuMode: 'off'`,
  a persisted `gpuAutoDisabled`, or the session fallback latch ⇒ `translationServerArgs('cpu')`
  (`--device none` — never `-ngl`).
- **Fallback:** a non-bind-race GPU start failure retries ONCE at forced CPU within the same start;
  a mid-session crash of a GPU-composed sidecar arms the same session latch (the chat §5.3
  auto-fallback shape). Only the final CPU rung failing arms the permanent `startFailed` latch
  (F-7). The latch is session-only and never writes the global `gpuAutoDisabled` — a 12B
  translation fault must not force the (smaller) chat model into compatibility mode; chat's own
  ladder owns that flag.
- **#25142 containment:** `--parallel 1` ships in BOTH postures — the upstream hang was under
  *parallel* Vulkan translation load; translation stays strictly sequential.
- **Cold-start observability (issue #42 reopen, 2026-07-10):** the runtime parses the server's own
  load log (`load_tensors: offloaded X/Y layers to GPU` on stderr — the only place the real `--fit`
  outcome is reported; `/props` does not carry it) and (a) logs every successful cold start
  (`"Translation sidecar started"` with posture + the layer split, symmetric with the chat
  ladder's `"started via rung …"` line), and (b) exposes it as `TranslationRuntime.deviceStatus()`
  → `getAppStatus().translationDevice` → the Translate screen's muted #36-style device hint. The
  hint's PARTIAL-offload form ("{done}/{total} layers — about processor speed", tooltip naming the
  cause + remedy) is the point: without it a `--fit` partial offload is indistinguishable from
  "GPU translation not working". Last-known values survive the idle teardown (`live: false`) so a
  finished run stays explainable. Pinned in `translation-runtime.test.ts` ("cold-start device
  observability"), `core-model-ipc.test.ts` (the status feed), and `TranslateScreen.test.tsx`
  (the hint forms).

**Field datapoint (issue #42 reopen — v0.1.46, RTX 3090 24 GB, Linux/Vulkan, b9849,
`translategemma-12b-it.Q4_K_M`, the shipping `translationServerArgs('auto')` at ctx 4096):**

- ~13 GB VRAM free → **full offload, 7.8 GB VRAM, 75.7 tok/s decode / 140 tok/s prompt** — vs the
  §11.2 ~3–4 tok/s CPU calibration (≈20× decode).
- **VRAM contention:** with a large chat model resident (gemma-4-26b-q4, ~16 GB), `--fit` squeezes
  TranslateGemma into the ~7 GB remainder → **partial offload at roughly CPU speed**, silently.
  The split is pinned per COLD START — freeing VRAM mid-session helps only once the 2-min idle
  teardown forces a fresh fit. This is the case the observability bullet above makes visible;
  `known-limitations.md` (Document translation) records the user-facing shape + remedy.

**OPEN — the GPU-decode re-smoke (owner, PAID/GPU drive).** The §11.2 tokens/sec are CPU numbers;
no GPU decode of TranslateGemma has been measured on the owner harness yet — the community
datapoint above answers the architecture-risk question, but the recorded §11.2-grade evidence
should still come from the owner run. On a drive with the b9849 binary + the TranslateGemma GGUF
and a real GPU:

```powershell
$env:HILBERTRAUM_TRANSLATEGEMMA_SMOKE = "<root with runtime/llama.cpp/<os>/llama-server + models/translation/*.gguf>"
# default device posture = 'auto' (the shipping GPU auto-offload); no extra env needed
cd apps\desktop
npx vitest run tests/manual/translategemma-smoke.test.ts
```

Record here: tokens/sec per leg (vs the ~3–4 CPU), peak RSS/VRAM split, cold-load time, and whether
`--fit` partial offload engages beside a resident chat model (the D9 co-residency shape — the field
datapoint above already demonstrates both sides of it). Until this lands, the ladder's safety net
(CPU fallback + session latch) is what ships the risk down: a machine where GPU translation
misbehaves degrades to exactly the TG-6 CPU behavior after one failed start.

---

## 12. Document redaction / edit locate pass — gold set + the real-model manual harness

The format-preserving document transforms (redaction v2 + targeted edits — architecture.md "Skills —
design record" §21/§22/§23, beta-feedback wave 1) rest on a LOCAL-MODEL **locate pass**: the model
proposes spans/edits, the app VERIFIES each verbatim and splices mechanically (it never generates
output text, D73). Two guards, the same split as §10 (skills) and §8/§11 (vision/translation): a
deterministic CI gold set that pins the PIPELINE, and an opt-in real-model harness that measures the
MODEL's locate quality — public NER/instruction-following scores are **not** a promotion signal here.

### 12.1 The CI gold set (always on, zero model / zero network)

[`tests/fixtures/gold-set/legal-corpus.ts`](../apps/desktop/tests/fixtures/gold-set/legal-corpus.ts)
holds SYNTHETIC, lawyer-shaped German documents (a Vollmacht, a Mandantenbrief carrying
names/addresses/IBAN/email/phone/dates — **never real user data**, same rule as the §10.1 real-layout
corpus), each with the exact model reply a scripted (mock) runtime replays.
[`tests/integration/skills-gold-set.test.ts`](../apps/desktop/tests/integration/skills-gold-set.test.ts)
drives them through the FULL redaction and edit pipelines — at the pure level
(`redactWithEntities` / `verifyAndSpliceEdits`, which expose the drop-unverifiable count + the span
union) AND through the run seam with the scripted runtime, incl. the Phase-9 same-format DOCX
round-trip. It pins the STRUCTURAL guarantees only: verbatim verify, every-occurrence sweep (D75),
occurrence precision (D76), the drop-unverifiable path, per-char masks preserving line length (D74),
and every non-`document.xml` DOCX part byte-identical (D77). It **never** asserts model judgement —
the scripted reply IS the "model", so this proves the app around the model, not the model.

### 12.2 The real-model manual harness (`PAID_*`, not CI)

A human pre-promotion gate — a real chat GGUF must actually FIND the names/addresses in these
documents before we claim the locate pass earns its keep. This is a `PAID_*` manual harness on the
smoke drive (a locally provisioned drive with the b9585/b9849 binary + a real chat GGUF; the D:\ root
convention of §8/§10.2/§11.1), run offline, results recorded in BUILD_STATE. There is no committed
`e2e-model` file yet (the pipeline is exercised end-to-end by the gold set with a scripted runtime);
until one is added, run it by hand through the APP per the checklist below.

**Acceptance bar — the locate pass, over the §12.1 gold documents through the running model:**
- [ ] **names + street addresses located** — the Vollmacht's `Maria Huber` / `Johann Berger` /
      `Ringstraße 12` and the letter's `Elisabeth Klein` / `Hauptstraße 5` / `Franz Gruber` are all
      proposed (the deterministic floor cannot find these — the model must).
- [ ] **steerability holds** — with "…, keep city names" the city (`Wien` / `Linz`) is NOT proposed;
      widening/narrowing the instruction changes what is proposed, never what the app interprets.
- [ ] **sweep coverage** — a name reported once is masked at EVERY occurrence in the saved file (D75).
- [ ] **no hallucination reaches the output** — anything the model proposes that is not present
      verbatim is dropped and counted; the saved bytes outside a mask are byte-identical to the source.
- [ ] **the regex floor still runs** — IBAN/email/phone/date are masked whether or not the model ran;
      model-missing DEGRADES to the floor with the honest note, never a silent partial.
- [ ] **the edit locate pass** — "Vollmachtgeber → Vollmachtgeberin incl. the article" changes only the
      anchored occurrences (the defined-term line stays), no whole-document regeneration (#23).

### 12.3 End-to-end eyeball (owner manual harness — POSIX + a running model)

The real-app "redact + edit a DOCX and a PDF and look at the result" eyeball needs a running model
AND is POSIX-only (the `screenshot-verify` / electron-eyeball path is nix+xvfb; this is a Windows dev
box) — so it is an **owner manual harness**, not run in CI. Through `npm run dev` with a chat model
started on the AI-Model screen:

1. Import a DOCX and a PDF that carry names + addresses + an IBAN (a copy of the §12.1 fixtures saved
   as real `.docx` / `.pdf` works).
2. In chat, ask to redact each ("Entferne alle Namen und Adressen, die Stadt darfst du behalten"),
   confirm the export, save the copy.
3. In chat, ask a targeted edit on the DOCX ("Ändere Vollmachtgeber zu Vollmachtgeberin samt Artikel"),
   confirm, save.

**Acceptance (the #22/#23 criteria):**
- [ ] names + addresses masked; the kept city survives; IBAN/email/phone/date masked by the floor.
- [ ] the redacted `.docx` **opens in Word** with styles/numbering/tables/headers intact; only the
      masked text changed (a diff of the extracted text shows only the located spans changed).
- [ ] the PDF/`.txt` output preserves line layout (per-char `█`), extraction-faithful.
- [ ] the edit changed ONLY the requested occurrences — no rewritten paragraphs, no hallucinated prose.
- [ ] the run bar shows the honest report (counts, dropped-unverifiable, "review before sharing").

**Status (2026-07-07):** the CI gold set (§12.1) is committed and green. The real-model harness
(§12.2) and the e2e eyeball (§12.3) are **deferred to the owner** — a real chat model + a running app
(and, for the eyeball, a POSIX host) are required and neither can run in CI on this Windows dev box.
The run-bar wiring itself is covered by the descriptor/i18n-parity + `SkillRunBar` renderer tests
(architecture.md §21/§22 "Tests"); no renderer surface changed in Phase 10.
