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
| D21 | Big/opt-in slot + embeddings | **Phase 30, outline only** — Gemma 4 26B-A4B vs the incumbent Qwen3 30B-A3B; Granite Embedding R2 small as the only near-drop-in embedder | MoE comparisons need Phase-29 numbers first; an embedder swap forces a reindex story — separate, later. Now drafted as [`big-slot-embeddings-plan.md`](big-slot-embeddings-plan.md) (D38–D43) |
| D22 | License gate posture | Every new manifest lands with a **real `license_review` record** (approved, with source URLs) before merge | Licensing is the #1 disqualifier; the review work is cheap now (all picks verified Apache-2.0) and mandatory before any drive bundles them |

**Outcomes (as built):** D16 — all three challengers shipped + license-reviewed. **D17
evolved**: the challengers kept `recommended_profiles: []`, but Phase 29 found the
production recommender was *quality-blind* (RAM-best-fit, ignores `recommended_profiles`;
the legacy picker is one-model-per-profile), so promotion is now carried by the
**`recommendation_rank`** manifest field that makes RAM-best-fit quality-aware (§6.2).
**D18 resolved**: 2507 shipped (via the unsloth fallback) and beat the original 4B on
*every* Phase-29 metric, but the original stays the **bundled default** (it has hybrid
thinking → keeps Deep working out of the box); 2507 is ranked just below it. D19/D20 — the
judge-free harness + protocol shipped and ran (§2–§6). D21 — Phase 30 outline →
`big-slot-embeddings-plan.md`. D22 — all four `license_review`s approved Apache-2.0.

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
Unsloth wave"). **No wins are claimed here.** They have NOT been through the §2–§6 harness and the
runtime pin they need (**b9849**, bumped from b9585) has not been smoked on this project's drive.

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
> bundled). The §4 `recommended_min_ram_gb` values for these are **placeholders pending a real peak-RSS
> measurement** (24 GB for the 27B/35B is a conservative guess, not a measured floor).

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
capable 16 GB machines).

Issue #48 (2026-07-10) extends this wave's scope, still under the same gate: the fast-tier
`qwen3.5-2b-ud-q4kxl` / `qwen3.5-0.8b-q6` have no incumbent to displace (low-risk promotions once
evaled), and the eval should record **context length** and **thinking-mode support** as
first-class criteria alongside grounded QA / citations / speed — the Qwen3.5 generation's native
262k window and hybrid thinking are product-relevant differences the §2 score alone does not
capture (the shipped `recommended_context_tokens` stays the safe local budget either way; a
promotion may raise it deliberately, per the D69/#43 context policy). Candidates that exist only
as local manifests elsewhere (e.g. a Qwen3.6 27B) need productizing first: a `download:` block,
a real upstream sha256, and a license review — same bar as the wave above.

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
  [ ] `qwen3.5-27b-ud-q4kxl` (32 GB+ machine) · [ ] `qwen3.5-35b-a3b-ud-q4kxl` (32 GB+ machine)

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

**OPEN — the GPU-decode re-smoke (owner, PAID/GPU drive).** The §11.2 tokens/sec are CPU numbers;
no GPU decode of TranslateGemma has been measured locally yet. On a drive with the b9849 binary +
the TranslateGemma GGUF and a real GPU:

```powershell
$env:HILBERTRAUM_TRANSLATEGEMMA_SMOKE = "<root with runtime/llama.cpp/<os>/llama-server + models/translation/*.gguf>"
# default device posture = 'auto' (the shipping GPU auto-offload); no extra env needed
cd apps\desktop
npx vitest run tests/manual/translategemma-smoke.test.ts
```

Record here: tokens/sec per leg (vs the ~3–4 CPU), peak RSS/VRAM split, cold-load time, and whether
`--fit` partial offload engages beside a resident chat model (the D9 co-residency shape). The
issue-#42 reporter offered RTX 3090 numbers — a community datapoint is welcome but the recorded
evidence should come from the owner harness. Until this lands, the ladder's safety net (CPU
fallback + session latch) is what ships the risk down: a machine where GPU translation misbehaves
degrades to exactly the TG-6 CPU behavior after one failed start.

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
