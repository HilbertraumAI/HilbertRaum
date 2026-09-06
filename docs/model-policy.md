# Model Policy — HilbertRaum

## Principles
- **No model weights in git.** Weights live under `models/` on the drive (git-ignored).
- Every model is described by a **manifest** (YAML) under `model-manifests/`, so models can change
  without code changes (spec §3.3).
- Models are verified by **SHA-256** before use (spec §7.4). Unverified models are rejected unless
  developer mode is on.

## Default model family
**Qwen3 dense instruct**, quantized **GGUF**, run via `llama.cpp`. Apache-2.0 for many variants.

| Role | Candidate | Size | Min RAM | Auto-tier | Purpose |
|---|---|---|---|---|---|
| Chat default | Qwen3 4B Instruct Q4 | ~2.7 GB | 8 GB | TINY / LITE / UNKNOWN | Smallest chat model; **catalog / weak-laptop-fallback default** and the model bundled on the preconfigured commercial drive (`bundled_on_preconfigured_drive:true`) — distinct from the **DIY `--with-assets` default-set chat model, which is Ministral 3 8B**. Kept as the catalog default (has hybrid thinking → Deep) despite 2507 scoring higher (Phase-29 user decision) |
| Chat better | Qwen3 8B Instruct Q4 | ~5.0 GB | 12 GB | BALANCED | 12 GB+ laptops (RAM recalibrated from measured ~8.3 GiB peak) |
| Chat best dense | Qwen3 14B Instruct Q4 | ~9.3 GB | 14 GB | PRO | 32 GB+; the spec §7.3 PRO model — slower on CPU (slowest decode of all 8). RAM recalibrated from measured ~10.6 GiB |
| Chat MoE | Qwen3 30B-A3B (MoE) Q4 | ~18.6 GB | 24 GB | — (opt-in) | ~30B quality at ~3.3B *active*/token → near-3B speed; needs ~20 GB RAM |
| Chat (winner, 8B) | Ministral 3 8B Instruct (2512) Q4 | ~5.2 GB | 12 GB | — (deferred‡) | **Phase-29 winner at 8B**: 0/15 hallucinations (only model that never fabricated) + fastest 8B decode |
| Chat challenger | Granite 4.1 8B Q4 | ~5.3 GB | 12 GB | — (not promoted) | Phase-29: lost its tier (most 8B hallucinations 3/15, lowest F1); kept selectable for its IBM provenance story |
| Chat (winner, 12–14B) | Gemma 4 12B Instruct QAT Q4_0 | ~7.0 GB | 14 GB | — (rank‡) | **Phase-29 winner at 12–14B**: beats Qwen3 14B on every axis (fewer hallucinations, faster). `supports_thinking_mode` **flipped on** — only thinking-capable challenger |
| Chat (better 4B) | Qwen3 4B Instruct 2507 Q4 | ~2.5 GB | 8 GB | — (deferred‡) | **Phase-29 (D18)**: beats the original 4B on every axis; the quality alternative at the 4B tier (orig 4B stays the bundled default for Deep). Instruct-only — no thinking |
| Chat (fast-tier 0.8B) | Qwen3.5 0.8B Q6_K | ~0.6 GB | 8 GB | — (rank 0) | **Qwen3.5 fast-tier (issue #48).** Smallest runnable; Q6_K (not UD-Q4_K_XL — quant error bites hardest at 0.8B). Text-only, not bundled. **§9 eval (ratified 2026-08-03, §9.3): the surviving fast-tier candidate — the honest floor (better F1 + abstention than the 2B); stays unranked.** b9849 load evidence via the tester eval; §9.1 in-app smoke still informal. |
| Chat (fast-tier 2B) | Qwen3.5 2B (UD-Q4_K_XL) | ~1.3 GB | 8 GB | — (rank 0) | **Qwen3.5 fast-tier (issue #48).** CPU-only speed tier. Text-only, not bundled. **§9 eval (ratified 2026-08-03, §9.3): FAILED — worst unanswerable-discipline of all models scored (should not be recommended anywhere, rank stays 0); the 0.8B dominates it.** |
| Chat (new 4B) | Qwen3.5 4B (UD-Q4_K_XL) | ~2.9 GB | 8 GB | — (rank 3) | **Recommended ≤12 GB since the newest-Qwen promotion (owner decision 2026-07-12, `model-benchmarks.md` §6.4).** unsloth Dynamic-2.0 quant; thinking-by-default (Deep applies). §9 eval standing recorded honestly in the manifest (F1 under the Qwen3-4B incumbent, EM comparable); b9849 load observed through the app 2026-07-12. Vision model run text-only. |
| Chat (Qwen3.5 9B) | Qwen3.5 9B (UD-Q4_K_XL) | ~6.0 GB | 12 GB | — (rank 3) | **Recommended 16–20 GB since the newest-Qwen promotion (2026-07-12, §6.4).** unsloth Dynamic-2.0 quant. §9 eval standing recorded in the manifest (edges Ministral on F1/EM within cross-run tolerance, ranked under it only on the hallucination-trap axis); ran on the b9849 binary in the #48 tester eval; **§9.1 in-app smoke PASSED all legs 2026-07-30** (peak RSS 6.57 GiB vulkan). Text-only, not bundled. |
| Chat (Qwen3.5 27B) | Qwen3.5 27B (UD-Q4_K_XL) | ~17.6 GB | 24 GB | — (rank 0) | **Qwen3.5 wave (2026-07-01).** High-end dense challenger; superseded at its tier by the Qwen3.6 27B pair (below) before ever being promoted. Text-only, opt-in (not bundled). |
| Chat (Qwen3.6 27B Q4) | Qwen3.6 27B Q4_K_M | ~16.8 GB | 20 GB | — (rank 1) | **Ranked and selectable, not the auto-pick.** Tier history: held 24 GB 2026-07-12..2026-08-16, lost it to the Qwen3.8 handover (§9.4), took it back on 2026-08-20 when upstream deleted the Qwen3.8 files, and handed it to `qwen3.8-27b-ud-q4km` the same day when the §9.5 successor wave measured the replacement and the owner ratified the handover — so rank 3 → 1. NOTE it still out-decodes the successor (tg 40.1 vs 32.4 t/s) at quality inside cross-run uncertainty; its own URL + LFS hash re-verified live 2026-08-20. Productized 2026-07-12 from a local-test stub: unsloth Q4_K_M, real HF-LFS hash, apache-2.0 review; hallucinations 0 on the v3 rescore; **§9.1 in-app smoke PASSED all legs 2026-07-30** (peak RSS 16.87 GiB vulkan). Still ranked + selectable. Text-only, not bundled. |
| Chat (Qwen3.6 27B Q5) | Qwen3.6 27B Q5_K_M | ~19.5 GB | 24 GB | — (rank 1) | **Ranked and selectable, not the auto-pick** — same tier history as the Q4 sibling (rank 3 → 1 when the §9.5 successor wave gave ≥32 GB to `qwen3.8-27b-ud-q5km`), and it never stopped being the harness top scorer. Still the all-time top scorer of the grounded-QA harness (F1 .3573, zero unanswerable-set hallucinations) — the handover is the §6.4 generational call, not a quality verdict. **§9.1 smoke PASSED 2026-07-30** (peak RSS 19.38 GiB vulkan). Text-only, not bundled. |
| Chat (Qwen3.8 27B Q4) | Qwen3.8 27B Q4_K_M | ~17.1 GB | 21 GB | — (rank 0) | **UPSTREAM FILE DELETED 2026-08-20 (issue #196, §9.5): `download.withdrawn`, rank 3 → 0 — installed copies keep working and verifying, but a fresh drive cannot obtain it, so it is never auto-recommended. The 24 GB tier went to Qwen3.6 Q4 for the interim and then, the same day, to the measured successor `qwen3.8-27b-ud-q4km` (§9.5 successor wave, owner-ratified). Was the recommended 24 GB pick 2026-08-16..2026-08-20 (§6.4 + §9.4).** unsloth Q4_K_M, real HF-LFS hash confirmed on-disk, apache-2.0 review (private/legal addendum 2026-08-16). §9.4 eval: F1 .3500 (ties the 3.6-Q4 inside cross-run noise), EM .9765, ZERO hallucinations, perfect abstention; tg 39.9 t/s vulkan / 2.83 cpu (b10430 basis). Text-only, not bundled. |
| Chat (Qwen3.8 27B Q5) | Qwen3.8 27B Q5_K_M | ~19.8 GB | 23 GB | — (rank 0) | **UPSTREAM FILE DELETED 2026-08-20 (issue #196, §9.5): `download.withdrawn`, rank 3 → 0; the ≥32 GB tier went to Qwen3.6 Q5 for the interim and then, the same day, to the measured successor `qwen3.8-27b-ud-q5km` (§9.5 successor wave, owner-ratified). Was the recommended ≥32 GB pick 2026-08-16..2026-08-20 (§6.4 + §9.4).** Same productization posture as the Q4. §9.4 eval: F1 .3523, zero hallucinations; tg 35.9 t/s vulkan — out-decodes the smaller UD-Q4_K_XL, which therefore got no manifest. Text-only, not bundled. |
| Chat (Qwen3.8 27B Q6) | Qwen3.8 27B Q6_K | ~22.9 GB | 26 GB | — (rank 0) | **UPSTREAM FILE DELETED 2026-08-20 (issue #196, §9.5): `download.withdrawn` — selectable only where the weight is already on the drive. Qwen3.8 wave (2026-08-16, §9.4): the 24 GB-GPU quality ceiling — rank 0 BY DESIGN** (the q5 sibling wins the ≥32 GB RAM tier; this quant's niche — fully fits a 24 GB GPU at ctx 8192, 22.7 GiB peak VRAM, no spill — is not expressible in the RAM-tier picker; gemma4-31b selectable-ceiling precedent). F1 .3503, zero hallucinations. Text-only, not bundled. |
| Chat (Qwen3.8 27B UD-Q4) | Qwen3.8 27B UD-Q4_K_M | ~16.5 GB | 21 GB | — (rank 3) | **The recommended 24 GB pick since the §9.5 successor wave (2026-08-20, issue #196, PR #199, owner-RATIFIED).** unsloth Dynamic-3.0 UD-Q4_K_M, the closest published successor of the withdrawn static Q4_K_M; real HF-LFS hash confirmed on-disk. Full per-quant rig wave: F1 .3529 (ABOVE the withdrawn file's .3500), EM .9765, zero hallucinations, abstention 1.0000; peak RSS 16.56 GiB, peak VRAM 16.9 GiB. **Speed caveat, measured and accepted: tg 32.4 t/s vs the withdrawn 39.9 (−19 %)** — the known Dynamic-quant trade; quality deltas sit inside cross-run uncertainty and the owner call weighs the newest generation ahead. MTP draft head re-verified in-GGUF (§9.5 gate). Text-only, not bundled. |
| Chat (Qwen3.8 27B UD-Q5) | Qwen3.8 27B UD-Q5_K_M | ~19.8 GB | 23 GB | — (rank 3) | **The recommended ≥32 GB pick since the §9.5 successor wave (2026-08-20, owner-RATIFIED).** Reproduces the withdrawn Q5_K_M's envelope: F1 .3511 vs .3523 (inside tolerance), EM .9765, zero hallucinations, peak VRAM 20.0 GiB *identical*, tg 34.5 vs 35.9 t/s (−4 %). MTP draft head re-verified in-GGUF (acceptance 0.67). Text-only, not bundled. |
| Chat (Qwen3.8 27B UD-Q6) | Qwen3.8 27B UD-Q6_K | ~22.0 GB | 26 GB | — (rank 0) | **Rank 0 BY DESIGN**, same reasoning as the withdrawn Q6_K it succeeds (§9.4): the q5 successor wins the ≥32 GB RAM tier, and this file's niche — fully fitting a 24 GB GPU at ctx 8192 — is not expressible in the RAM-tier picker. The niche got STRONGER: 21.8 GiB peak VRAM leaves 2.2 GiB headroom where the withdrawn file left 1.3. F1 .3518, zero hallucinations, tg 32.6 t/s. **No `speculative_decoding`, deliberate** — MTP costs ~2 GiB VRAM and the VRAM fit is this quant's entire reason to exist (the draft head IS present in the file; it must never be enabled here). Text-only, not bundled. |
| Chat (Qwen3.5 35B-A3B) | Qwen3.5 35B-A3B (UD-Q4_K_XL) MoE | ~22.2 GB | 24 GB | — (rank 1) | **Qwen3.5 wave (2026-07-01); rank 1 since the 2026-08-03 ratification (`model-benchmarks.md` §9.3).** ~35B total / ~3B active MoE (256 experts, 8+1 active); beat the incumbent MoE `qwen3-30b-a3b-q4` on hallucinations (0 real vs 2, EM parity) with the speed case confirmed (140.9 t/s vulkan / 12.1 cpu tg). Ranked alternative for ≥32 GB — never the auto-pick (`qwen3.8-27b-ud-q5km` holds ≥32 since the §9.5 successor wave; before it, the withdrawn Qwen3.8 Q5 from 2026-08-16). Text-only, not bundled; §9.1 in-app smoke PASSED 2026-08-09 (§9.3 smokes record). |
| Chat (Gemma E2B) | Gemma 4 E2B Instruct QAT Q4_0 | ~3.3 GB | 8 GB | 12–15 GB boxes + the §6.5 step-down landing tier (rank 3) | **Gemma 4 QAT wave (2026-07-23, issue #82); eval ratified 2026-08-03 (§9.3); PROMOTED 2026-08-09 (issue #153).** Official Google QAT; MatFormer effective-2B. Eval: F1 .3373 edges the bundled Qwen3 4B with equal hallucinations (3) and the fastest cpu decode measured (24.3 t/s); the #153 weak-16 GB-box leg confirmed 17.0 tok/s settled vs the prior 12 GB pick's 9.0 (iGPU basis) → rank 3, rec-RAM retuned to 12 (`model-benchmarks.md` §6.5 #153 amendment). Text-only. In-app b9849 smoke PASSED 2026-07-23. |
| Chat (Gemma E4B) | Gemma 4 E4B Instruct QAT Q4_0 | ~5.2 GB | 12 GB | — (rank 0) | **Gemma 4 QAT wave; eval ratified 2026-08-03 (§9.3): F1 .2999 misses the 8B bar — no promotion.** MatFormer effective-4B. Text-only; thinks by default, `enable_thinking: false` suppression verified per size. In-app b9849 smoke PASSED 2026-07-23. |
| Chat (Gemma 26B-A4B) | Gemma 4 26B-A4B Instruct QAT Q4_0 MoE | ~14.4 GB | 20 GB | — (rank 2) | **Gemma 4 QAT wave; rank 2 since the 2026-08-03 ratification (§9.3).** MoE, ~3.8B active (8 of 128 experts): EM parity with the then-24 GB pick Qwen3.6 27B Q4, ZERO audited hallucinations, ~4× its decode speed at 2.5 GB less disk — F1 .3307 vs .3523 kept the Qwen the pick, so this is the ranked runner-up / MoE speed alternative (never the auto-pick; the 24 GB tier has since moved on to `qwen3.8-27b-ud-q4km`, §9.5). Supersedes the `gemma-4-26b-q4` local-test stub for distribution. All §9.1 legs PASSED 2026-07-30 (in-app peak RSS 14.28 GiB, vulkan). |
| Chat (Gemma 31B) | Gemma 4 31B Instruct QAT Q4_0 | ~17.7 GB | 24 GB | — (rank 0) | **Gemma 4 QAT wave; eval ratified 2026-08-03 (§9.3): DO NOT PROMOTE — the issue-#82 drop condition met** (ties the 26B-A4B within .003 F1 at 4.2–6× slower decode, +3.3 GB disk). Stays a selectable opt-in — the Apache-2.0 dense quality ceiling for 32 GB GPU boxes. All §9.1 legs PASSED 2026-07-30 incl. the first load smoke. |
| Embeddings | Multilingual E5 Small (F16) | ~0.25 GB | 4 GB | all | Local document search (needed for Q&A) |
| Reranker (optional) | BGE Reranker v2 M3 (F16) | ~1.16 GB | 6 GB | LITE+ (in the DIY `--with-assets` set; **not** on a preconfigured commercial drive — `bundled_on_preconfigured_drive:false`, advisory/unused) | Retrieval-quality pass over document search — search works fully without it |
| Transcriber | Whisper Small (multilingual) | ~0.49 GB | 4 GB | all (bundled) | Audio transcription + voice dictation; whisper.cpp GGML; MIT |
| Vision (optional) | Qwen2.5-VL 3B Instruct Q4 + f16 mmproj | ~3.27 GB (2 files) | 12 GB | in the `--with-assets` default set (2026-07-01); **not** auto-recommended in-app (`recommended_profiles: []`, rank 0) — availability-driven, used on demand by the Images screen | Image understanding — the Images screen (Phases V1–V5). Two files: GGUF + the `mmproj` projector. CPU-pinned; ~4.6 GB peak RSS. **Co-resident with a 12B chat ⇒ >16 GB (PROD-1)** — see "The vision role" below. Apache-2.0 |

> Qwen3 **1.7B** was in the original spec §7.3 (the TINY/UNKNOWN "small" model) but was **dropped**:
> the official `Qwen/Qwen3-1.7B-GGUF` repo publishes no Q4_K_M. 4B now covers TINY/UNKNOWN too.
> The embeddings model uses an **F16** GGUF, not Q8 — the q8_0 conversions of this BERT/XLM-R model
> crash llama.cpp b9585 (`binary_op: unsupported types … q8_0`). See BUILD_STATE §9. The
> **reranker** (also XLM-R family) is pinned to **F16 for the same reason**; its live load on b9585
> is verified by the `HILBERTRAUM_RERANK_SMOKE` manual harness. _(These were verified on b9585; the
> b9849 pin bump re-opens them — the manual smoke re-confirms the embedder + reranker sidecars load
> on b9849, or records explicitly if deferred.)_ License review (recorded in its manifest):
> base model `BAAI/bge-reranker-v2-m3` = Apache-2.0 (HF API, 2026-06-10); GGUF from
> `gpustack/bge-reranker-v2-m3-GGUF` (also Apache-2.0, mechanical conversion — same provenance
> posture as the E5 entry). `Qwen3-Reranker-0.6B` was rejected: no official GGUF.

All models are **Apache-2.0** (Qwen3, the Phase-28 challengers, BGE reranker) / **MIT** (E5, Whisper transcriber).
Sizes/RAM come from each manifest
(`size_on_disk_gb` / `recommended_min_ram_gb`); download URLs live in the manifests' `download.url`
(catalog with source links in the [README](../README.md)). **Auto-tier** is the
`recommended_profiles` list each manifest declares.
> ‡ **Promotions are LIVE via `recommendation_rank`, not `recommended_profiles`.** The
> production picker is **RAM-best-fit** (`recommendModelIdByRam`) on unified memory, on a machine
> without a usable discrete graphics card, and with graphics acceleration off — and it ignores
> `recommended_profiles` (that list is only the legacy no-RAM path, which is one-model-per-profile).
> **2026-09-06 amendment (PR #308 audit):** on a machine with a usable discrete card,
> `recommendChatModelId` dispatches instead to `recommendModelIdByVram`, which reuses the exact
> same `recommendation_rank` tiebreak and RAM floor, judged against the card's free graphics
> memory instead of RAM (`model-benchmarks.md` §6.6) — the RAM pick above stands wherever it also
> fits the card, and only steps down when it does not. Rather than mis-encode the **Phase-29**
> winners in `recommended_profiles`, each manifest carries a `recommendation_rank`
> (higher = preferred) that the picker now uses as the tiebreak among models that fit the
> machine's RAM (the **quality-aware recommender** follow-up — `model-benchmarks.md` §6.2, tiers
> since recalibrated by §6.3). Net effect on real hardware, RAM path (newest-Qwen promotion, owner
> decision 2026-07-12; handed to the Qwen3.8 pair 2026-08-16; reverted 2026-08-20 when upstream
> deleted the Qwen3.8 files (issue #196) and RESTORED the same day to their measured `UD-*`
> successors, `model-benchmarks.md` §6.4 + §9.4 + §9.5; asserted in `benchmark.test.ts` and
> `committed-catalog.test.ts`): **≤12 GB → Qwen3.5 4B, 12–15 GB → Gemma 4 E2B (#153),
> 16–23 GB → Qwen3.5 9B, 24 GB → Qwen3.8 27B UD-Q4_K_M, ≥32 GB → Qwen3.8 27B UD-Q5_K_M**;
> Granite, both MoEs, the three withdrawn Qwen3.8 static K-quants, and the superseded former
> winners (Ministral, Gemma 4 12B, the Qwen3.6 pair — all still ranked and selectable) are never
> the RAM-path auto-pick — nor the card-path one, which honors the same rank guard, except that a
> very small card budget (below the smallest ranked model's threshold) can fall through to the
> smallest RANK-0 model as the honest fit (`model-benchmarks.md` §6.6 rule 6; an owner-open
> question, not a change made here). The "Auto-tier" column above is the declared
> `recommended_profiles` (kept as-is); the live recommendation is `recommendation_rank` +
> RAM-best-fit (or the card's free-memory-best-fit on a discrete GPU).
Min-RAM values were **recalibrated from measured peak RSS** in the Phase-29 run (8B: 16→12,
12–14B: 16→14). Adding a model is
**manifest-only** (no code change): drop a YAML in
`model-manifests/chat/` with a `download` block + a `recommended_profiles` list.

## Qwen3.5 Unsloth wave (2026-07-01)

Four **text-only** chat manifests in the `qwen3.5` family, all third-party **Unsloth Dynamic 2.0**
GGUF requants of **Apache-2.0** Qwen weights (the Qwen org publishes no official GGUF for the 3.5
refresh — same established-quantizer posture as `qwen3-4b-instruct-2507-q4`):

| Manifest | Size | Min RAM | Quant | Challenges |
|---|---|---|---|---|
| `qwen3.5-4b-ud-q4kxl` (existing) | ~2.9 GB | 8 GB | UD-Q4_K_XL | the 4B tier (`qwen3-4b-instruct-q4`) |
| `qwen3.5-9b-ud-q4kxl` (new) | ~6.0 GB | 12 GB | UD-Q4_K_XL | the 8B tier (Ministral 3 8B, Qwen3 8B) |
| `qwen3.5-27b-ud-q4kxl` (new) | ~17.6 GB | 24 GB | UD-Q4_K_XL | dense 12–14B + Qwen3 30B-A3B |
| `qwen3.5-35b-a3b-ud-q4kxl` (new, MoE) | ~22.2 GB | 24 GB | UD-Q4_K_XL | the opt-in MoE (`qwen3-30b-a3b-q4`) |

- **Text-only in HilbertRaum.** Upstream Qwen3.5 are hybrid reasoning / vision-language models, but
  every manifest here ships ONLY the language GGUF and **no `mmproj`/projector** (chat does not use
  vision). Each carries `supports_thinking_mode: true` — the smaller models (≤9B) have reasoning
  *disabled by default* in Unsloth's llama.cpp examples unless `enable_thinking=true`, while the
  larger models think by default; the chat template honours the switch either way, so the Deep
  answer mode applies. **Verify the live thinking-toggle behaviour by smoke test.**
- **Native context is 262,144 tokens** (extensible to ~1,010,000 via YaRN), but every manifest sets
  `recommended_context_tokens` to a small **local runtime budget** (8192 for the new three; the
  incumbent 4B keeps 4096). That field is the *recommended runtime context for normal laptops*, not
  the theoretical native window — revisit only after KV-cache/RAM budgeting + a long-context eval.
  Since 2026-07-04 the user can override it: the chat sidecar launches with
  `settings.contextTokensOverride ?? (recommended_context_tokens || settings.contextTokens)` — the
  AI Model screen's "Context size" card (presets 4k–128k, default Automatic; rag-design §15.8).
- **Runtime pin bumped to b9849** (see "runtime-sources.yaml" below) specifically because Qwen3.5 is
  a newer architecture than the old b9585 build. The **4B load smoke is SATISFIED (2026-07-12)** — it
  loaded + streamed through the app from the portable drive, and the #48 tester eval ran all four on
  the b9849 binary; the §9.1 through-the-app smokes for the 9B, the 27Bs, and the 35B-A3B remain
  open — see the manual-smoke checklist in `model-benchmarks.md` §9 / the BUILD_STATE "Qwen3.5
  Unsloth wave" entry.
- **None are auto-recommended (RAM path; the card path honors the same rank-0 exclusion — §6.6).**
  All four carry `recommendation_rank: 0` + `recommended_profiles: []`
  and `bundled_on_preconfigured_drive: false`: selectable manually on the AI Model screen, never the
  RAM-best-fit auto-pick, never bundled — **until the offline benchmark harness promotes them** with
  a real rank (`model-benchmarks.md` §9 promotion criteria). Public benchmark scores do not count;
  only the local German/English grounded-QA eval + manual smoke do.

  _(Superseded 2026-07-12: the `qwen3.5-4b-ud-q4kxl` and `qwen3.5-9b-ud-q4kxl` were promoted to
  `recommendation_rank: 3` by owner decision — they are the ≤12 GB / 16–20 GB auto-picks now, see
  the catalog table above and `model-benchmarks.md` §6.4. `qwen3.5-27b-ud-q4kxl` and
  `qwen3.5-35b-a3b-ud-q4kxl` remain rank 0.)_

  _(Update 2026-08-03, wave ratification — `model-benchmarks.md` §9.3 "Wave outcome": the
  **35B-A3B's deferred rank resolved to rank 1** (ranked MoE alternative for ≥32 GB — §2 eval
  hallucination-clean vs the incumbent MoE's 2 real, EM parity, and the 3B-active speed case
  confirmed at 140.9 t/s vulkan / 12.1 cpu; never the auto-pick, `qwen3.6-27b-q5` holds ≥32 GB;
  its §9.1 in-app smoke is the recorded residual). The 27B stays rank 0 (superseded at its tier
  by the Qwen3.6 pair); the fast-tier pair stays rank 0 per the ratified eval — the 0.8B remains
  the honest floor, the 2B should not be recommended anywhere. The 9B + both Qwen3.6 27Bs also
  cleared their owed §9.1 through-the-app smokes 2026-07-30.)_

## Gemma 4 QAT wave (2026-07-23, issue #82)

Four **text-only** chat manifests in the `gemma4` family — the rest of the [Gemma 4
collection](https://huggingface.co/collections/google/gemma-4) evaluated after the 12B (the
Phase-29 12–14B winner). All four are **official Google QAT Q4_0 GGUFs** from the Google HF org
(vendor quantization-aware trained, NOT third-party requants — the same first-party provenance as
the approved `gemma4-12b-it-qat-q4`), all **Apache-2.0** (HF API card tags verified 2026-07-23,
repos ungated), 140+ languages:

| Manifest | Size | Min RAM | Challenges |
|---|---|---|---|
| `gemma4-e2b-it-qat-q4` | ~3.3 GB | 8 GB | the promoted Qwen3.5 4B / the 4B tier — the #53 weak-hardware case |
| `gemma4-e4b-it-qat-q4` | ~5.2 GB | 12 GB | the promoted Qwen3.5 9B, Ministral 3 8B, Qwen3 8B |
| `gemma4-26b-a4b-it-qat-q4` (MoE) | ~14.4 GB | 20 GB | the promoted Qwen3.6 27B Q4 at 24 GB, `gemma4-12b`, and both Qwen MoEs — ~3.8B active/token at 4–8 GB less disk |
| `gemma4-31b-it-qat-q4` | ~17.7 GB | 24 GB | the Qwen3.6 27B pair as the dense Apache-2.0 Gemma quality ceiling (weakest case: slow CPU decode; mainly GPU offload) |

- **Evaluated and NOT added:** `google/diffusiongemma-26B-A4B-it` (diffusion decoder — llama.cpp
  cannot run it; do not revisit without llama.cpp support); the `gemma-4-*-it-assistant` models
  (78M–0.5B **speculative-decoding drafts**, not standalone chat — still parked; the shipped
  speculative decoding (issue #182) is the Qwen3.8 in-GGUF draft head, which needs no second
  weight and no `--model-draft`. Parked until the chat sidecar
  wires `--model-draft`); base non-`-it` variants.
- **Relation to the local-test stubs:** `gemma-4-26b-q4` (Unsloth UD Q4_K_M of the same base
  model, `sha256: local-unverified`, no download block) and `gemma4-coding-q8` are user-added
  local-test manifests. The wave's `gemma4-26b-a4b-it-qat-q4` **supersedes the 26B stub for any
  distribution purpose** (official QAT, verified hash, download block, Apache-2.0 review); the
  stubs stay as-is for the owner's local models. NOTE: the stubs' comment "Gemma has no runtime
  thinking-mode toggle" contradicts the 12B's verified `enable_thinking` behaviour — the wave
  manifests follow the 12B precedent; the suppression smoke below decides.
- **Text-only in HilbertRaum.** E2B/E4B are any-to-any upstream (image/audio in), 26B/31B
  image-text-to-text; every repo ships an mmproj projector we deliberately do not reference (the
  12B posture). E2B/E4B are MatFormer effective-2B/-4B slices.
- **Thinking:** every manifest carries `supports_thinking_mode: true` (the Gemma 4 template honours
  `enable_thinking`, verified live on the 12B). Smoke finding (2026-07-23): **E4B and 26B-A4B
  think BY DEFAULT** (reasoning first on the `reasoning_content` channel — unlike the shipped 12B),
  so a short output cap can return empty content (the #50 class); the per-size check that
  `enable_thinking: false` suppresses it is part of the promotion smoke.
- **Hashes are real**: pinned from HF LFS OIDs (the qwen3.5-27b posture) and **confirmed against
  real downloads** — `fetch-models` fetched + SHA-256-verified E2B/E4B/26B-A4B on 2026-07-23.
- **Runtime**: Gemma 4 needs llama.cpp ~b8680+ (MoE included); the pinned **b9849** loads all
  three smoked sizes (E-series MatFormer + the Gemma MoE were arch firsts for the catalog). The
  31B (same dense arch string as the 12B) is un-smoked but lowest-risk.
- **Smoke status (2026-07-23):** E2B + E4B **in-app smoke PASSED** (0.1.48 portable, DIY test
  drive, b9849 win-vulkan). The 26B-A4B loads + answers via CLI but needs a **≥24 GB** machine for
  in-app use + peak-RSS measurement (on a 16 GB box it mmap-thrashes at ~170 s/reply — the RAM
  gate is doing its job). RAM values are ESTIMATES pending measured RSS (the 26B's rests on the
  #42 field datapoint). The E2B's `recommended_ram_gb` deliberately sits on the small-tier **16
  floor**: a unique lower value would make a rank-0 model the only "comfortable fit" at that RAM
  level and slip past the picker's preferRanked guard (caught by the wave-invariant tests).
  *(Superseded 2026-08-09 by the #153 promotion: ranked 3, the E2B now carries its honest
  rec-RAM 12 and that "hijack" is the ratified pick — see the amendment below.)*
- **None are auto-recommended (RAM path; the card path honors the same rank-0 exclusion — §6.6).**
  All four carry `recommendation_rank: 0` + `recommended_profiles:
  []` + `bundled_on_preconfigured_drive: false` — selectable manually, never the RAM-best-fit
  auto-pick, never bundled, **until the local German/English grounded-QA eval promotes them**
  (`model-benchmarks.md` §9; public scores do not count). Wave tracking + full research record:
  issue #82.

  _(Wave outcome, ratified 2026-08-03 — full record: `model-benchmarks.md` §9.3 "Wave outcome";
  evidence: the 2026-07-30 i9 run, PR #92. **26B-A4B → rank 2** (ranked runner-up to the rank-3
  `qwen3.6-27b-q4`: EM parity + zero audited hallucinations at ~4× the speed and 2.5 GB less
  disk; F1 .3307 vs .3523 keeps the Qwen the 24 GB pick — still never the auto-pick).
  **31B → never promote** (the issue-#82 drop condition met: quality ties the 26B-A4B at 4.2–6×
  slower decode; stays a selectable opt-in GPU-box ceiling). **E4B → stays 0** (F1 .2999 misses
  the 8B bar). **E2B → stays 0 for now** (edges the bundled `qwen3-4b` on F1 with equal
  hallucinations and the fastest cpu decode measured, but `qwen3-4b-2507` keeps the tier quality
  lead and the issue-#53 weak-16 GB-box datapoint is still owed — that leg decides, wave
  follow-up issue). Thinking verified per size (all suppress cleanly; E2B Deep 7/8 — flip rule
  NO); §9.1 smokes complete for 26B-A4B + 31B; RAM lines confirmed on the vulkan basis and kept
  (the Linux-cpu values are a non-comparable mmap basis). Smoke-status and RAM-estimate bullets
  above describe the wave-open state.)_

  _(#153 amendment, 2026-08-09, owner-ratified: **E2B → rank 3**. The owed weak-16 GB-box
  in-app Diagnostics leg landed on the designated class (i7-1185G7 / Iris Xe / 15.8 GB, Vulkan
  b9849): E2B 17.0 tok/s settled vs `qwen3.5-4b` 9.0 and bundled `qwen3-4b` 14.6 — the big-rig
  ~2× cpu ratio reproduces (iGPU basis; full table on issue #153). `recommended_ram_gb` retuned
  16 → 12: E2B is the sub-16 comfortable band (12–15 GB boxes) and the §6.5 step-down's landing
  tier for 16–20 GB crawls. `qwen3-4b-2507` keeps the tier quality lead but stays rank 1;
  E2B beats the previous 12 GB pick `qwen3.5-4b` on both F1 (.3373 vs .2728) and speed.
  Full record: `model-benchmarks.md` §6.5 "#153 amendment".)_

## Manifest format & parsing
Manifests are **YAML**, parsed with the pure-JS [`yaml`](https://www.npmjs.com/package/yaml) package
(boring, reliable, no native deps, works fully offline). The schema and a
hand-written validator live in `apps/desktop/src/shared/manifest.ts` (one source of truth shared by
main + renderer). Validation collects **all** errors per file and is pure (no I/O) for easy testing.

## Manifest fields (required)
`id, display_name, family, role, format, runtime, license, size_on_disk_gb,
recommended_min_ram_gb, recommended_ram_gb, recommended_context_tokens, local_path, sha256` plus a
`license_review` block. Optional: `recommended_profiles` (a list of hardware profiles — the legacy
no-RAM picker), `recommendation_rank` (integer, default 0; higher = preferred among models that fit
the machine's RAM — the Phase-29 quality-aware tiebreak in `recommendModelIdByRam`),
`supports_thinking_mode` (below), `speculative_decoding` (below), a `download` block (below),
`estimated_context_cache_gib` (number ≥ 0; the graphics-memory picker's per-model context-cache
term, PR #308 §6.6 rule C — absent defaults to 0.5 GiB in code, so the field is set only for the
seven models whose figure was actually measured), and — for a `role: vision`
model — an **`mmproj` projector sub-block** + an informational `input_modalities` list (see "The
vision role + mmproj projector" below). Unknown extra keys (e.g. `supports_tools`, `dimensions`,
`bundled_on_preconfigured_drive`) are ignored by the validator.

- **`local_path`** is resolved **relative to the drive root**, so a value of
  `models/chat/foo.gguf` points at `<drive-root>/models/chat/foo.gguf`.
- **`sha256`** is lower-case hex (64 chars). A non-hex placeholder (e.g. `REPLACE_WITH_REAL_HASH`)
  marks a model whose hash is not yet known; such a file is only usable in developer mode.
- **`runtime`/`format`**: the supported pairs are `llama_cpp`/`gguf` (chat, embeddings, reranker,
  vision) and `whisper_cpp`/`ggml` (the transcriber); any other runtime/format pair yields the
  `unsupported` state.
- **`supports_thinking_mode`** (optional boolean, default `false`) is **load-bearing**:
  it declares that the model's chat template implements the `enable_thinking`
  switch (Qwen3-style native reasoning). The chat UI offers the **Deep** answer mode only for
  a running model whose manifest sets it `true` (surfaced via `RuntimeStatus.supportsThinkingMode`).
  Setting it on a model whose template ignores `enable_thinking` is harmless at the request
  level (the kwarg is inert) but misleading — Deep would behave exactly like Balanced.
  The four original Qwen3 chat models are the hybrid-thinking releases (`Qwen/Qwen3-*-GGUF`)
  and correctly declare `true`. Of the Phase-28 challengers, **Gemma 4 also declares `true`** —
  its template honours `enable_thinking` and the Phase-29 thinking-quality check (run #2,
  `tests/manual/gemma-thinking.test.ts`) confirmed Deep deliberates coherently and never regresses
  (8/8 = Balanced), so the flag was flipped. Ministral 3, Granite 4.1, and the "Qwen3 4B Instruct
  **2507**" refresh are instruct-only and declare `false`: Deep behaves like Balanced on them, by
  design.

- **`speculative_decoding`** (optional, issue #182) is a **closed enum** — today only `mtp` —
  and it is **chat-role only** (a value on any other role is a validation error, because only the
  chat start ladder consumes it). It declares that the WEIGHT ships a trained-in multi-token-
  prediction draft head (Qwen3.8's `blk.64.nextn.*` tensors, which llama-server otherwise loads
  and ignores); the runtime maps that ONE name to a fixed, code-owned flag pair
  (`--spec-type draft-mtp --spec-draft-n-max 2`). **A manifest never supplies arguments** — an
  `extra_server_args`-style field would let a hand-edited on-drive manifest inject any
  llama-server flag, and a smuggled `--host 0.0.0.0` would defeat the loopback-only invariant
  (extras are appended last, and a later flag wins).
  Declaring it is an **opt-in, not a decision**: the start ladder tries it on a dedicated rung
  above the plain GPU rung, only when a device probe shows one card with the weight's bytes plus
  3.5 GiB free, and falls back to exactly today's behavior otherwise — so setting it on a model
  without the head costs one failed start attempt per session, never a broken model. Carried
  today by four manifests: `qwen3.8-27b-q4` / `qwen3.8-27b-q5` (kept as rank-0 installed-base
  records after their source was withdrawn — a local file still starts with MTP) and their
  measured successors `qwen3.8-27b-ud-q4km` / `qwen3.8-27b-ud-q5km`. Deliberately NOT by either
  Q6 — `qwen3.8-27b-q6` peaks at 22.7 GiB and `qwen3.8-27b-ud-q6k` at 21.8 GiB on a 24 GB card at
  ctx 8192, and that VRAM fit is their whole reason to exist. Design record: `architecture.md`
  "MTP speculative decoding"; measured evidence: `model-benchmarks.md` §9.4 and §9.5.
  **Never copy the flag onto a successor manifest on family resemblance** (issue #196): upstream's
  Dynamic 3.0 rebuild publishes the MTP module as a SEPARATE file for quants below 8.37 GB, while
  this enum member means an in-GGUF head with no second model file. Re-verify per file, by
  spawning it with the flag pair and reading draft acceptance back — done for the two UD
  successors on 2026-08-20 (acceptance 0.79 / 0.67, head PRESENT; §9.5), which is why they keep
  the field and why nothing keeps it unverified.

## Model states (spec §7.4)
Computed by `services/models.ts` with this precedence:
`unsupported` → `missing` (file absent) → `checksum_failed` (hash mismatch, or placeholder hash
outside developer mode) → `installed`. The active running model is shown as `running`.

## License review gate
```yaml
license_review:
  status: pending | approved | rejected
  reviewed_by: null
  reviewed_at: null
  notes: ""
```
- **DIY / developer**: `status: pending` allowed.
- **Preconfigured commercial drive**: `status: approved` required, with reviewed license,
  commercial-use status, attribution requirements, and quantization source recorded.

Do not bundle a model unless its license has been reviewed.

**How the recorded attribution requirements are discharged (LIC-1, full-audit 2026-07-12b).**
The approved review notes record "ship the LICENSE/NOTICE attribution with the drive" — a
`license_url` in YAML is not a license copy, and resolving one needs network on an offline
product. The mechanism: the committed, **GENERATED** root file `DRIVE-NOTICES.md`
(`node scripts/generate-drive-notices.mjs`) carries one attribution line per model manifest
(id, upstream repo, declared license, `download.license_url`, plus any non-`approved`
`license_review.status`), the full Apache-2.0 text once, and the MIT / zlib texts for the
llama.cpp + whisper.cpp binaries and the SDL2.dll the whisper Windows archive bundles — those
texts are **pinned in-repo under `licenses/`** at review time because the upstream release
archives ship no license file (see `licenses/README.md`). `prepare-drive` copies
`LICENSE` + `THIRD-PARTY-NOTICES.md` + `DRIVE-NOTICES.md` to the drive **root**, and the sell
gate (`assertCommercialDrive` + `build-commercial-drive.{ps1,sh}` step 7) fails a drive where
any of the three is missing or empty. Freshness + coverage (every runtime family in
`runtime-sources.yaml`, every manifest) are enforced by
`apps/desktop/tests/integration/drive-notices.test.ts` — regenerate + commit the file together
with any manifest or runtime-pin change. The TranslateGemma commercial flow-down items (a
Gemma Terms copy on the drive, the verbatim Gemma notice, the sale-terms clause) fold into
this same mechanism when that separate review closes; until then its `pending` status keeps
it off sold drives while its attribution line is already carried.

### Disqualified / parked candidates (Phase-28 license research, 2026-06-10)

**Disqualified (do not revisit without new facts):** EXAONE 4.x (NC license); Ministral
8B-Instruct-**2410** (Mistral Research License, non-commercial — the `-2512` name-twin
trap); Phi-4 (MIT but not multilingual → fails German); Mistral Large 3 (Apache but 675B).
**Parked:** Llama 3.x (community license, encumbered vs all-Apache alternatives), GLM-4
(MIT, German unproven), Gemma 3 (custom Gemma Terms — superseded by Apache-2.0 Gemma 4).
Full research record: [`model-benchmarks.md`](model-benchmarks.md) §7.

## Optional `download` block (the DIY asset loader)

The schema gained an **optional** `download` block describing where the `fetch-models` scripts pull
the weight from and what to verify it against. It is **additive** — manifests with no `download:`
stay valid, and the validator only checks the sub-fields when the block is present.

```yaml
download:
  url: https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf?download=true
  sha256: REPLACE_WITH_REAL_HASH   # when a real hash, MUST equal the top-level sha256 (same file)
  size_bytes: 2497280256           # optional; progress + a DRIFT-TOLERANT in-app download body cap
  license_url: https://huggingface.co/Qwen/Qwen3-4B-GGUF/blob/main/LICENSE   # optional
```

Rules (validated in `shared/manifest.ts`):
- `download.url` is required + non-empty when the block is present.
- `download.sha256` is required (a real lower-case hash, or a `REPLACE_WITH_REAL_HASH` placeholder).
  A **real** `download.sha256` must equal a **real** top-level `sha256` — they describe one file.
- `download.size_bytes` (≥ 0) and `download.license_url` are optional.

`size_bytes` feeds the progress bar AND the in-app downloader's disk-fill body cap
(`modelWeightMaxBytes`). The cap is **drift-tolerant** — `size_bytes` grown by a comfortable headroom
(25 %, floor 128 MiB; BUG dl-size-cap-2026-07-03) — so a file a little larger than the declared size
still downloads; the SHA verify is the integrity control.

**Field scope: `size_bytes` is DRIFT-TOLERANT by design — it is the one manifest number the code
does not assume is exact.** Everywhere else the rule holds without qualification (manifest numbers
are measured, never estimated), and `size_bytes` should still be the real byte count: capture it with
`verify-models --generate`, and correct it when a drift check finds it stale — four Qwen3 manifests
carried hand-rounded values until issue #202 replaced them with measured ones on 2026-08-20. But the
downloader must survive the case where it is *not* exact, because upstream can change the file's size
underneath a pinned manifest without our knowing: **issue #201 is the proof** — Google's corrected
gemma4-12B checkpoint arrived 1,568 bytes larger at the same URL. That is why `assets.ts`'s cap
carries headroom rather than being keyed exactly to `size_bytes`, and the headroom is not arbitrary:
an exact cap is what truncated a legitimate download at ~95 % once already. Integrity is enforced by
`sha256` regardless, so a wrong `size_bytes` costs a wrong progress estimate, never a wrong file.
Keep the two facing directions straight: **declare it exactly, consume it tolerantly** — and never
understate it by more than the headroom, which is the failure the cap was widened to end.

Leave `sha256` as the placeholder until a real drive is built; fetch the weight, then run
`verify-models --generate` to capture the real hash **and the exact `size_bytes`** and promote them
into the manifest. A 64-hex value the code treats as a **verified** hash, so never transcribe a hash
you have not computed from the actual downloaded file — an unverified guess hard-fails the checksum.

### Withdrawn upstream sources (`download.withdrawn`, issue #196)

Publishers delete and restructure their repos. On 2026-08-20 unsloth removed the static K-quants
from `Qwen3.8-27B-GGUF` (their Dynamic 3.0 rollout) and the three files our Qwen3.8 manifests pin
began returning HTTP 404 (model-benchmarks.md §9.5). Hash pinning means we can never be handed
substituted weights — but everyone downstream rediscovers the dead link the expensive way: a
multi-GB request that ends in an error reading like a broken connection.

An optional string inside the `download` block records the fact once, in the manifest:

```yaml
download:
  url: https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-Q4_K_M.gguf?download=true
  sha256: 7e78da5d…
  size_bytes: 17106775008
  withdrawn: "2026-08-20: unsloth removed the static K-quants … (HTTP 404 verified 2026-08-20)."
```

Rules and behaviour:
- **A non-empty, dated string** — never a bare `true`. The note is shown to the user and read by a
  maintainer months later; the validator rejects an empty value or a boolean.
- **The rest of the block stays.** `url`/`sha256`/`size_bytes`/`license_url` remain the provenance
  record of the file existing drives carry, and that local copy keeps verifying normally. A
  withdrawn source **never** disturbs an installed weight (the planner still reports
  `present-verified`).
- **Planner** (`assets.ts` `planModelDownloads`, the source of truth): a file that would need
  fetching plans **`source-withdrawn`** instead of `download` — checked *before* the license gate,
  since no acknowledgement can conjure a deleted file back.
- **In-app**: the AI Model card shows the reason in place of the Download button, and the main
  process refuses `downloadModel` for such a manifest anyway (a renderer bug must never cost the
  user a doomed multi-GB request). The network-gate banner does not fire for a model that is
  unfetchable for reasons that have nothing to do with the drive's policy.
- **Fetch scripts**: `fetch-models.{ps1,sh}` print a loud `SKIP … upstream source withdrawn` line
  and continue — one retired file must not fail a whole drive build. Both twins are pinned against
  the TS behaviour by `script-drift.test.ts`. Their flat-YAML parser strips inline comments at
  `" #"`, so **a withdrawal note must not contain `" #"`** (write "issue 196", not "issue #196") —
  also asserted in CI.
- **Ranking**: a withdrawn manifest carries `recommendation_rank: 0` — selectable, never
  auto-recommended. `committed-catalog.test.ts` pins the general invariant ("no committed manifest
  is both recommended and unobtainable"), so a fresh drive is never pointed at a model it cannot
  obtain. Hand the tier to the best-measured model whose source is still live.

### Re-verifying the catalog against upstream (the drift check)

A deleted file is the *loud* upstream failure. The quiet one is a **live URL that now serves
different bytes** — the publisher re-uploaded the weight, so the download still runs to completion
and then fails SHA-256 verification, at the end of several GB, with a message the user cannot act
on. Hash pinning stops us being handed substituted weights silently; it does not tell us the
substitution happened.

So the periodic catalog check compares the **upstream hash**, not just the status code. For every
committed `download.url`:

1. **URL alive?** `HEAD`, redirects followed. A 404 means the file is gone → `download.withdrawn`.
2. **Same bytes?** Compare the upstream git-LFS OID (which, for a HuggingFace LFS object, *is* the
   file's SHA-256) against the manifest's `sha256`. A mismatch on a live URL is the quiet failure.
   Repointing the manifest at the new bytes is a **substitution**, and manifest numbers are
   measured, never estimated — so it needs its own measurement wave, exactly like the successor
   of a withdrawn file (below).

**Repoint in place, or enter a successor id?** The wave decides, and the two precedents differ on
one fact: whether the pinned file still exists upstream. Issue #196 (deleted files) used
**successor ids** — the old manifests had to stay valid for drives that still hold those exact
bytes. Issue #201 (a file **superseded** at the same path, 2026-08-20) repointed **in place**,
because the wave measured the old and corrected checkpoints as indistinguishable on every shipped
surface — all 100 §2 answers byte-identical, memory envelope unmoved — so a successor id would
have put two provably indistinguishable entries in the catalog. The cost of an in-place repoint is
real and must be stated where users see it: every installed copy of the old bytes reports
`checksum_failed` until it re-downloads. Weigh that blast radius explicitly
(`bundled_on_preconfigured_drive`, the `--with-assets` default set, the model's rank) and record
the decision in the wave's design record. Full reasoning: model-benchmarks.md §9.6.

**The trap that makes step 2 easy to get wrong:** a `HEAD` that *follows* redirects returns the
CDN's own ETag, which is never the LFS OID — every HuggingFace manifest then reads as a mismatch.
Read the OID off the `huggingface.co` 302 itself — `x-linked-etag` / `x-linked-size`, i.e. a
request with redirects NOT followed — or ask the API
(`https://huggingface.co/api/models/<repo>/tree/main`) and read the entry's `lfs.oid` and
`lfs.size`. Cross-checking both ways is cheap and worth it: they are independent paths to the
same number.

History worth keeping: the issue-#196 blast-radius sweep checked step 1 across the whole catalog
and step 2 for the Qwen3.6 pair only. That was enough for #196 and left one drifted manifest
undetected for five weeks (issue #201, found by the 2026-08-20 docs/code audit). Both steps, every
manifest.

When a successor file is eventually measured and productized, the withdrawn manifest is retired
(or kept as an installed-base record) per the wave that promotes the successor — that decision
belongs to the wave, not to this field. **Precedent set by the first such wave** (issue #196,
2026-08-20): the three withdrawn Qwen3.8 manifests were **kept**, at rank 0 with their dated
note, and the successors entered as NEW ids (`qwen3.8-27b-ud-*`) rather than as an in-place URL
+ hash swap. Reason: a drive that already carries a withdrawn weight keeps a manifest whose hash
its file still matches, so it verifies, starts and keeps MTP — an in-place swap would have turned
every installed copy into `checksum_failed` overnight.

### The DIY download flow + license gate (spec §13)
`scripts/fetch-models.{ps1,sh}` downloads each weight with a `download` block, **resumes** partials,
and **SHA-256-verifies against the manifest before counting it installed** (a real-hash mismatch
deletes the partial and exits non-zero; a placeholder hash downloads but reports *UNVERIFIED*).
`scripts/fetch-runtime.{ps1,sh}` does the same for the `llama-server` sidecar from
`model-manifests/runtime-sources.yaml`.

Before the first download, the **license gate** refuses any model whose `license_review.status` is
not `approved` unless `--accept-license`/`-AcceptLicense` is passed (the license + `license_url` are
printed first). The DIY path pulls from the **upstream source**, which sidesteps redistribution; a
*sold* drive still needs a redistribution-permitting license recorded as `approved`.

> **Network is explicit, never automatic.** The `fetch-*` scripts run on the drive-**builder's**
> online machine. The app itself never auto-downloads — the in-app downloader below runs only when
> every gate passes, per explicit user click.

### The in-app downloader

A model that is **missing** (or failed its checksum) and whose manifest carries a `download` block
can be fetched from the **AI Model screen**. Three gates, ALL required, re-checked in the main
process on every start (architecture.md "In-app model downloader"):

1. **Policy ceiling** — `policy.network.allow_model_downloads`. Downloads are policy-permitted
   everywhere by default: the no-`policy.json` default allows them (wave-1 decision D3, resolved
   (a)), and since 2026-07-01 `prepare-drive` writes **allow** in BOTH its postures (dev and
   commercial), so the user toggle below is the effective gate on prepared drives too. A drive
   builder who wants a download-locked drive hand-edits `config/policy.json` to
   `allow_model_downloads: false`. Policy only restricts, never expands — and update checks +
   telemetry remain **always denied** in every posture (the app never phones home).
2. **User setting** — the spec §3.6 Settings checkbox ("Allow internet access for model
   downloads and updates"), **default ON** for a fresh DIY/developer install
   (`DEFAULT_SETTINGS.allowNetwork: true`); the policy ceiling in gate 1 still wins — on a drive
   whose `policy.json` denies downloads, the toggle cannot re-enable them. While the workspace is
   locked the setting is unreadable and treated as off.
3. **Per-download confirmation** — a dialog showing size, license (+ `license_url` link), and the
   upstream URL. When `license_review.status != approved`, an explicit license-acknowledgement
   checkbox is additionally required (the in-app mirror of `--accept-license`).

When gate 1 or 2 fails, the AI Model screen says **why** (disabled by the drive's policy vs. the
Settings toggle). Mechanics (`services/downloads.ts`, reusing the `assets.ts` seams):
async-with-polling job (`downloadModel`/`getDownloadJob`/`cancelDownload` IPC), **one download at a
time**, bytes land in `<weight>.part` and are renamed into place **only after the SHA-256
verifies**; a mismatch deletes the partial and fails the job; a placeholder manifest hash completes
the download but leaves the model **UNVERIFIED** (checksum honesty — capture a real hash with
`verify-models --generate`). Cancel keeps the `.part`; the next attempt resumes with a `Range`
header (best-effort — a server without range support restarts cleanly). A `.part` that is already
COMPLETE (a cancel/crash during the verify, or a failed rename) is verified **in place** instead of
re-requested — a match renames into place, a mismatch discards it for a clean restart (F-13,
full-audit 2026-07-16; no HTTP 416 dead-end). On success the persisted
checksum-cache entry for that path is invalidated so the fresh file is re-hashed. The offline
guarantee is unchanged: no update checks, no catalog/browsing (only manifests already on the
drive), no background anything.

### `runtime-sources.yaml` (the sidecar, not a model)
`model-manifests/runtime-sources.yaml` pins one `ggml-org/llama.cpp` release and lists one prebuilt
build per OS/arch/backend (`os`, `arch`, `backend`, `url`, `sha256`, `extract_to`). The
ordering is **vulkan-first**: the default build on win/linux is the **Vulkan full build**
(extracted to `runtime/llama.cpp/<os>/`), which is safe as a default because the upstream Vulkan
release archives are standalone full builds carrying every CPU backend variant — on a GPU-less
machine the same binary simply runs on its bundled CPU backends (verified against b9585; this
supersedes the earlier "a GPU build fails or runs worse on a non-GPU machine" assumption, which is
false for Vulkan-the-archive). A **pure-CPU safety net** is additionally pinned per win/linux,
extracted to `runtime/llama.cpp/<os>/cpu/` (`--backend cpu`); mac arm64 stays Metal-only. Licensing
is unchanged: both Vulkan archives are built from the same MIT-licensed llama.cpp source at the
already-approved pinned tag, and the Vulkan *loader* is not redistributed (it comes with the user's
GPU driver) — no new licenses enter the product. The file is validated by
`shared/runtime-sources.ts` (duplicate `(os, arch, backend)` triples are rejected) and is
**excluded from model discovery** (it is not a model manifest). After each verified extraction
`fetch-runtime` writes a `.hilbertraum-runtime.json` install marker; skips are marker-based
(version + backend), never mere binary presence. Re-fetches **pre-clean the previous install**
(everything except the downloaded archive + the `cpu/` safety net) so an upgrade can never mix
two builds or keep a stale binary under a fresh marker (GPU audit round).

**License-review record — llama.cpp b9849 runtime assets (the CURRENT pin; status: approved,
reviewed 2026-07-01):** the pin was bumped b9585 → **b9849** (2026-06-30, upstream commit
`799fcc0`) as the **Qwen3.5 compatibility gate**. Licensing is unchanged from the b9585 review
below: all five pinned assets build from the same **MIT**-licensed `ggml-org/llama.cpp` source at
tag `b9849`, the Vulkan archives redistribute no Vulkan SDK/loader (it ships with the user's GPU
driver), and the win/win-cpu zips ship the same MS OpenMP redistributable as before — **no new
license class enters the product.** The SHA-256 values are the **official GitHub Releases API
`digest`** metadata for tag `b9849` (cross-checked twice); `fetch-runtime` re-verifies every
archive against them before extraction, so the REQUIRED manual smoke (download + install on a real
drive) is also the hash confirmation — a wrong/changed digest fails the run, never installs a bad
binary.

| Asset | SHA-256 | Notes |
|---|---|---|
| `llama-b9849-bin-win-vulkan-x64.zip` | `ed6156dec5303748fdf13d0056c5fb29aa504210e01d949e72ce20e3d680e4d6` | MIT; Vulkan full build (default win build) |
| `llama-b9849-bin-win-cpu-x64.zip` | `fa7d9d93fa86979c5b44ba176cadae1167b5b054d4c467d184d81def4d714352` | MIT; pure-CPU safety net |
| `llama-b9849-bin-macos-arm64.tar.gz` | `fccd749707c0fb0bbcee1682a0097f0d7a6e4adb6ce7fc8c6151d9e1d4b3c830` | MIT; Metal (mac arm64) |
| `llama-b9849-bin-ubuntu-vulkan-x64.tar.gz` | `0fb2491604cbc468321bcaaa56991cfbc27fb0ac58b9597fd290a81b86da06d4` | MIT; Vulkan full build (default linux build) |
| `llama-b9849-bin-ubuntu-x64.tar.gz` | `9ce3b4db4535fd68efb272b7159ffbe0748884c2db3525e68ae4315ba2df2a4d` | MIT; pure-CPU safety net |

**License-review record — llama.cpp b9585 runtime assets (HISTORICAL — the prior pin; extends the
original b9585 review, commit `8bdeb2e`; status: approved, reviewed 2026-06-10):** all five pinned
assets build from the same MIT-licensed `ggml-org/llama.cpp` source at tag `b9585`. The two
later-added assets (Vulkan default + CPU safety net) are explicitly part of this record:

| Asset | SHA-256 | Notes |
|---|---|---|
| `llama-b9585-bin-win-vulkan-x64.zip` | `af6b1b94377b9f78dbb2285b878fb696d36766391499d65e055ecd622b69018a` | MIT; ships `libomp140.x86_64.dll` (MS OpenMP redistributable — same file as the win-cpu zip, no new artifact class); embedded SPIR-V shaders compiled from llama.cpp source (MIT) |
| `llama-b9585-bin-ubuntu-vulkan-x64.tar.gz` | `5f5467e5d9827b27eda17ee39b35fd2b7c8aa298f144e8836491ccec76160fdf` | MIT; no Vulkan SDK/loader content redistributed (the loader ships with the user's GPU driver) |

The win-cpu / ubuntu-cpu / macos-arm64 assets keep their hashes from the original b9585 review
(unchanged in `runtime-sources.yaml`). **No new licenses enter the product.**

> ✅ **Pinned to a real release: `b9849`** (2026-06-30, bumped from b9585 as the Qwen3.5
> compatibility gate), with real per-OS URLs and SHA-256 checksums from the official GitHub
> Releases API `digest` metadata — `fetch-runtime` re-verifies before extracting (a wrong/changed
> hash fails the run). **The b9849 fetch + a one-old-model / one-Qwen3.5-model load are a REQUIRED
> manual smoke** (BUILD_STATE "Qwen3.5 Unsloth wave"; `model-benchmarks.md` §9).
> Notes on the current release format:
> - The **Windows** asset is a `.zip` with the binaries at the archive root; **macOS/Linux** assets
>   are `.tar.gz` nested under `llama-<tag>/`. `fetch-runtime` handles both, **flattens** nested
>   layouts so `llama-server[.exe]` lands at `runtime/llama.cpp/<os>/`, and **materializes the
>   `lib*.so`/`.dylib` version symlinks as copies** (exFAT drives and Windows hosts cannot hold
>   symlinks).
> - **To bump the release:** pick a new tag from the
>   [ggml-org/llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases), update `version`
>   + the per-OS asset `url`s (asset names vary per release), download each asset, and promote its
>   real SHA-256 into `sha256` as a deliberate, reviewed change. A real-hash mismatch makes
>   `fetch-runtime` delete the archive and fail.

## The whisper.cpp transcriber family

`runtime-sources.yaml` additionally pins the **`whisper_cpp:`** block — the audio
transcriber CLI (`whisper-cli`), fetched with `fetch-runtime --family whisper_cpp` into
`runtime/whisper.cpp/<os>/` with the same verify-before-trust + marker discipline.

**License-review record — whisper.cpp v1.8.6 runtime asset (status: approved, reviewed
2026-06-11):** whisper.cpp is **MIT** ("the ggml authors", verified in `LICENSE` at tag
`v1.8.6`). The upstream release ships prebuilt binaries for **Windows only** (R-W1); the
pinned asset:

| Asset | SHA-256 | Notes |
|---|---|---|
| `whisper-bin-x64.zip` (v1.8.6) | `b07ea0b1b4115a38e1a7b07debf581f0b77d999925f8acb8f39d322b0ba0a822` | MIT; plain-CPU build; binaries nest under `Release/` (the fetch scripts flatten); ships `SDL2.dll` (zlib license — permissive, attribution-free; used only by the demo tools, redistributed as part of the upstream archive) |

mac/linux whisper builds are compiled from the same MIT source at the pinned tag by the
drive builder (no new licenses; see `drive-layout.md`).

**License-review record — Whisper model weights (status: approved, reviewed 2026-06-11):**
OpenAI's Whisper models are **MIT** (github.com/openai/whisper LICENSE). The shipped
`whisper-small-multilingual` manifest (`models/transcriber/ggml-small.bin`,
`1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`) uses the GGML
conversion from `huggingface.co/ggerganov/whisper.cpp` (declares MIT; mechanical format
conversion — the E5/reranker provenance posture). Full notes in the manifest's
`license_review` block. The weight rides the NORMAL manifest pipeline (`fetch-models`,
in-app downloader, `verify-models`).

## The OCR asset class

`runtime-sources.yaml` additionally pins the **`ocr:`** block — the vendored OCR
language files, fetched with `fetch-runtime --family ocr` into `ocr/` as plain
sha256-verified files (no extraction, no marker — the hash is the install state).
The OCR engine itself (tesseract.js + its WASM core) ships INSIDE the app as pinned
npm dependencies, not as drive assets.

**License-review record — tesseract.js 7.0.0 npm dependency (status: approved,
reviewed 2026-06-11):** **Apache-2.0** (npm + repo `naptha/tesseract.js`). Pure
JS/WASM, no native build. Pinned EXACT (`"tesseract.js": "7.0.0"` — the D-UI1/Radix
precedent). Its runtime CDN defaults (worker/core/langPath from cdn.jsdelivr.net) are
fully disabled in our wiring (R-O2; sentinel-tested) — the dependency never fetches at
runtime.

**License-review record — tesseract.js-core 7.0.0 (status: approved, reviewed
2026-06-11):** **Apache-2.0** (the Emscripten/WASM build of the Apache-2.0 tesseract
engine; transitive dependency of tesseract.js, ships inside the app, `asarUnpack`ed in
packaged builds).

**License-review record — OCR traineddata (status: approved, reviewed 2026-06-11):**
tesseract language data is **Apache-2.0** (the tesseract-ocr project's tessdata
licensing). Shipped variant per R-O3: the **integerized tessdata_best** (`best_int`) —
the float `tessdata_best` cannot run on the WASM core, and `best_int` clearly beat
`fast` on degraded German scans (3 vs 7 misses of 104 words) at ~+1.6 MB. Pinned
artifacts (repackaged by the tesseract.js project as `@tesseract.js-data/*@1.0.0`,
`4.0.0_best_int`; the npm wrapper declares MIT, the data itself is Apache-2.0
upstream):

| Asset | SHA-256 | Size |
|---|---|---|
| `ocr/deu.traineddata.gz` | `306c4280d0cbed46fbff727486bd43b92730181bae80f56941a091f363bdf28b` | 1.27 MB |
| `ocr/eng.traineddata.gz` | `45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91` | 2.82 MB |

## Sidecar binaries — kiwix-tools (knowledge packs, #301; family contract #339 P8-1)

**Status: INVENTORY, not clearance (D5 part 1; plan §6.1).** Nothing here authorizes shipping
kiwix-tools inside a commercial Kit — the owner's review below is still open, and it (not this
inventory) is what would confirm any conveyance.

`runtime-sources.yaml` pins the **`kiwix_tools:`** block — the THIRD sidecar family and the
first **`optional: true`** one: it is never part of the default engine-install selection and
never counted toward `engineStatus().installed`/`missingFamilies` — only an explicit
`families: ['kiwix_tools']` request installs it. The consent surface that sends that request
landed at P8-2: the Knowledge-packs panel's tools-missing notice and a mirror row on the AI
Model screen, each requiring the user to accept the GPL-3.0-or-later license before the request
goes out, gated by the same `policy.network.allowModelDownloads ∧ allowNetwork` check as models
and the engine. `EngineStatus.missingOptionalFamilies` reports the family separately, additive
and optional so a pre-#339 renderer simply ignores it. The family also ships **more than one
executable**: `executables: [kiwix-serve, kiwix-manage, kiwix-search]`, base names only
(`sidecarBinaryName` adds `.exe` on win; the first entry is the primary binary,
`plan.binaryPath`). Per build, `runtime_files` lists non-executable files the executables cannot
start without — on Windows, the five ICU DLLs the win zip ships flat beside the three exes (the
mac/linux tarballs are statically linked and declare no `runtime_files`). Validated by
`shared/runtime-sources.ts` exactly like `llama_cpp`/`whisper_cpp` (duplicate `(os, arch,
backend)` triples rejected); the two macOS builds legitimately share one
`extract_to: runtime/kiwix-tools/mac` (the `arch` key tells them apart, and `kiwixToolsDir`
resolves exactly one directory per OS regardless). After extraction the installer checks every
declared file is present — `kiwix-serve`/`kiwix-manage` are a code-side floor a drive's yaml
cannot lower; `kiwix-search` and every `runtime_files` entry are required too, because the
archive's own verified hash already proves the bundle contains them — and writes a
`.hilbertraum-runtime.json` install marker recording a SHA-256 **per executable and per ICU
DLL**, all-or-nothing: a hashing failure leaves no `binaries` map at all rather than a partial
one, so the family falls back to the hashless `skip-legacy` verifier path instead of looking
"hashed" while one file is not.

The pinned release is **kiwix-tools 3.8.1** (upstream build 2025-12-02). The kiwix download
server (`download.kiwix.org`, which 301s to `mirror.download.kiwix.org`) is the only binary
distribution for 3.8.1 — the GitHub release carries source archives only — and it publishes
**MD5 sidecars only** (`<file>.md5`; no `.sha256`). So, exactly like `whisper_cpp` above, every
SHA-256 below was **computed from a fresh download on 2026-09-06** whose MD5 matched the
published upstream sidecar:

| Build (OS/arch) | URL | Bytes | Upstream MD5 | SHA-256 (computed) |
|---|---|---|---|---|
| win / x64 | `https://download.kiwix.org/release/kiwix-tools/kiwix-tools_win-x86_64-3.8.1.zip` | 18,301,924 | `95f953f726aac8f320c7038f85785df9` | `fcd01ed2b93e9a68632c7863c83b9f66bf64406a66357be1df7b8b75596f3e45` |
| mac / arm64 | `https://download.kiwix.org/release/kiwix-tools/kiwix-tools_macos-arm64-3.8.1.tar.gz` | 10,254,751 | `300d29d6ea02a9353092f29b8fabf76a` | `222e8398ca50ac005a7e92cf0116e0c83e3c44c79cab0bb7f6537943d517e8d3` |
| mac / x64 | `https://download.kiwix.org/release/kiwix-tools/kiwix-tools_macos-x86_64-3.8.1.tar.gz` | 10,768,392 | `7032160e0c4dbabc11830e27f82a9c4f` | `70219e56f7c274e1fc0db8487abdcc91bde9a6f2923958894c0c81ee24b06c01` |
| linux / x64 | `https://download.kiwix.org/release/kiwix-tools/kiwix-tools_linux-x86_64-3.8.1.tar.gz` | 21,503,420 | `ab0e372a814fde612ed79fd2a0b82d5a` | `46557f9a3c3eaada2556a957cf5bc662c07dc6286e8924e04fa3a173f83ff6dd` |

(The yaml's `arch` key is HilbertRaum's own — `x64` for both win and the macOS x86_64 asset, to
match `hostRuntimeArch()` — while the filename keeps upstream's `x86_64` spelling.) The win
build's own per-file inventory (Authenticode + per-file SHA-256, inspected 2026-09-06 on Windows
11 with `Get-AuthenticodeSignature`; residual R-4 answered for this build): `kiwix-serve.exe`,
`kiwix-manage.exe` and `kiwix-search.exe` are **Valid**, signer `CN=Association Kiwix,
O=Association Kiwix, L=Lausanne, S=Canton of Vaud, C=CH`; the five ICU DLLs are **NotSigned**.
Per-file SHA-256: `kiwix-serve.exe` `619ECCC76C112A57538E3CEB001D75E71CAF5A040171B2C1399C4D19F8E9BC95`,
`kiwix-manage.exe` `43E9A19D3BF66D6D158A187B1799AEE75B1797C06F8F17C6DD2BDEBAE56E177C`,
`kiwix-search.exe` `EBE683AB03D50BC6893E6D69D7F1753E5FD6EBDF89488ADFFD900574C24CDBB9`,
`icudt74.dll` `CE6F56B89F3C7163A166210977642559C87033B579FF129C61443DE57FBD771B`,
`icuin74.dll` `A80EFBE7966ECD99A86B9F1694BAD6995C8B43FEBC1B42FBFF5A3F5E9A6E36FF`,
`icuio74.dll` `FEBDA93002C9E70A2DEE1DA316A799B5416A6EC5430FA88AA9AF82BBA3ADA0A6`,
`icutu74.dll` `E533BD62973D215F5306B24C2BD473CC3B161C7F88819812284EE18132CA9560`,
`icuuc74.dll` `0E3EC2D0D821B6244B78129334AED0E7EBE3CDE51F00D2FF77170C4900AF7F67`. The mac/linux archives
carry no equivalent per-file inspection yet (their code-signing is R-4's remaining manual leg,
owner's).

The linux-x86_64 build's per-binary inventory is humaniser's measurement of 2026-09-06 on
Ubuntu 22.04 (#352), not re-measured by the maintainer; `--version` reported kiwix-tools
3.8.1, libkiwix 14.1.1, libzim 9.4.0, libxapian 1.4.23. Per-binary SHA-256:
`kiwix-serve` `a4efa19354e52a2b4a3c6567d363897140d35fbec6b10b9843ee1f511434042c`,
`kiwix-manage` `d5ea144a87418d15245d73280ec92084f7878860a7d3d8e80252e83c3f709ccb`,
`kiwix-search` pending (asked on #352).

Transitive components, with grants **read from the pinned source trees** (`COPYING` files + the
per-file headers under `src/`, not assumed from upstream README prose):

| Component | Version | Grant, as the source tree states it |
|---|---|---|
| kiwix-tools | 3.8.1 | GPL-3.0-or-later (`COPYING` = GPL-3; every header "version 3 … or (at your option) any later version") |
| libkiwix | 14.1.1 | GPL-3.0-or-later, with **one** file GPL-2.0-or-later (`COPYING` = GPL-3; 43 headers v3-or-later, 1 header v2-or-later) |
| libzim | 9.4.0 | **GPL-2.0-or-later, with GPL-3.0-or-later files** (`COPYING` = GPL-2; 74 headers v2-or-later, 16 headers v3-or-later — never "all GPL-3") |
| Xapian (`xapian-core`) | 1.4.23 | GPL-2.0-or-later |
| libmicrohttpd | 0.9.76 | LGPL-2.1-or-later, statically linked into `kiwix-serve` (version from the kiwix-build recipe's dependency pin — `--version` does not report it) |
| libcurl | 8.4.0 | the curl license (MIT-style) |
| ICU | 74 | the Unicode/ICU license (the five `icu*74.dll` in the win bundle) |
| docopt.cpp | 0.6.3 | MIT/Boost dual, taken under MIT |
| pugixml | 1.15 | MIT |
| zlib | 1.3.1 | the zlib license |
| Zstandard (zstd) | 1.5.7 | BSD-3-Clause/GPL-2 dual, taken under BSD-3 |
| xz / liblzma | 5.2.6 | public domain (the 5.2.6 `COPYING`; the 0BSD relicensing came in a later xz release) |

The five copyleft components — kiwix-tools, libkiwix, libzim, Xapian, libmicrohttpd — are also
the five whose corresponding source a preloaded Kit must carry. Their source tarballs, pinned
against the same kiwix-build recipe (`github.com/kiwix/kiwix-build`) that produced the 3.8.1
binaries:

| Tarball | Bytes | SHA-256 | Upstream URL |
|---|---|---|---|
| `kiwix-tools-3.8.1.tar.xz` | 531,416 | `dd769c9bd3d75b59ad9e451b128187b128da6a10b1241bb2d0325fe4aafe51a3` | `https://download.kiwix.org/release/kiwix-tools/kiwix-tools-3.8.1.tar.xz` |
| `libkiwix-14.1.1.tar.xz` | 1,123,600 | `e232f42bba33561493e2d7318c3be60d8508e83a8891a8358135519dedc5ff5a` | `https://download.kiwix.org/release/libkiwix/libkiwix-14.1.1.tar.xz` |
| `libzim-9.4.0.tar.xz` | 217,752 | `7fa374f4714b23c43afa3fb406d7e21c483d77e8218895e1408e2f037969b6ea` | `https://download.openzim.org/release/libzim/libzim-9.4.0.tar.xz` |
| `xapian-core-1.4.23.tar.xz` | 3,024,644 | `30d3518172084f310dab86d262b512718a7f9a13635aaa1a188e61dc26b2288c` | `https://oligarchy.co.uk/xapian/1.4.23/` |
| `libmicrohttpd-0.9.76.tar.gz` | 2,199,858 | `f0b1547b5a42a6c0f724e8e1c1cb5ce9c4c35fb495e7d780b9930d35011ceb4c` | `https://dev.kiwix.org/kiwix-build/` (a GNU mirror carries the same release) |

All five are **in hand**, archived by the maintainer outside the repo. The on-drive bundle lands
at `runtime/kiwix-tools/source/` (the owner's layout ruling, 2026-09-06, **#339 P8-4**):
`scripts/install-kiwix-source-bundle.mjs` copies, re-verifies and writes a generated `SOURCES.md`;
`build-commercial-drive --kiwix-source-dir <archive dir>` runs it, SOURCE FIRST, before fetching
the `kiwix_tools` binaries; and `assertCommercialDrive`'s `checkSourceBundle`
(`checks.kiwixSourceBundle`) fails the sell gate when any `kiwix_tools` binary — a hand-placed,
marker-less one included — is present without a complete, hash-matching bundle.

**License-review record — kiwix-tools 3.8.1 runtime assets (status: PENDING the owner's review;
nothing here authorizes conveyance):** kiwix-tools is the product's **first copyleft third-party
native binary** — every prior sidecar (llama.cpp, whisper.cpp, the OCR traineddata) is permissive,
and both llama.cpp review records above say "no new license class enters the product"; that
sentence does not hold for kiwix-tools, and this record says so plainly rather than repeating it.
Five components above are copyleft; on a preloaded Kit their corresponding-source duty **is
discharged** by the P8-4 source bundle at `runtime/kiwix-tools/source/` next to the binaries
(#339 P8-4 — `scripts/install-kiwix-source-bundle.mjs` + the `checkSourceBundle` sell-gate leg).
GPL-3.0-or-later text is proposed to be satisfied by cross-referencing the drive's own root
`LICENSE` (HilbertRaum is itself GPL-3.0-or-later) rather than inlining the ~35 KB text a second
time — **owner confirmation pending** on that cross-reference specifically; not settled here.
Open for the owner: the GPL-3.0-via-root-`LICENSE` cross-reference itself (confirmation pending);
the libmicrohttpd version-from-recipe pin (not observable from the binary, so it rests on
trusting the kiwix-build history); Authenticode/code-signing inspection of the mac/linux archives
(R-4's remaining leg — win is done, above); and the consent (P8-2) ruling that gates any
conveyance.

> **To bump the release:** pick a new tag from the
> [kiwix/kiwix-tools releases](https://github.com/kiwix/kiwix-tools/releases) (the GitHub release
> ships source archives only; binaries still come from `download.kiwix.org`), re-download all
> four platform archives, re-verify each against its upstream `.md5` sidecar, recompute each real
> SHA-256 and promote it into `runtime-sources.yaml`, and re-read the `COPYING` file plus the
> per-file headers of all five copyleft source trees (re-fetching the source tarballs too) before
> promoting any of it. A version bump here is a licence re-review, not a mechanical edit.

The user path is the in-app **consent dialog** (#339 P8-2, `downloadEngine({ families:
['kiwix_tools'] })`): the Knowledge-packs panel's tools-missing notice, or the mirror row on the
AI Model screen, states the size, the GPL-3.0-or-later license and the source, and installs the
family once accepted — writing the marker described above, so both `kiwix-serve` and
`kiwix-manage` verify normally. The builder/DIY path is `fetch-runtime --family kiwix_tools`
(#339 P8-3, same marker). Hand-placing the bundle under `runtime/kiwix-tools/<os>/` remains a
**last-resort fallback**: it carries no install marker and resolves through the hashless
`skip-legacy` verifier path (residual R-1) rather than integrity verification, and is replaced
wholesale by the first in-app or scripted install.

## The vision role + mmproj projector (image understanding, Phases V1–V5)

The `vision` role powers the **Images** screen (design record: [`architecture.md`](architecture.md)
"Image understanding — design record"). A vision model is **two files** — the language GGUF (the
top-level `local_path`/`sha256`/`download`, like any model) **plus** a multimodal **`mmproj`
projector** that `llama-server --mmproj` loads. The schema additions (`shared/manifest.ts`):

```yaml
role: vision
input_modalities: [text, image]        # informational only — capability comes from role + mmproj
local_path: models/vision/qwen2.5-vl-3b-instruct-q4.gguf
sha256: d02fe9b69ad8cadbbd228e387667af66612c44bed29ffc8eb1e7caf9ac486c12
mmproj:                                 # REQUIRED iff role: vision
  local_path: models/vision/mmproj-qwen2.5-vl-3b-instruct-f16.gguf
  sha256: b9160fe9d814d1fadf68395677468534778b39ac33c2e7561b7b218626e60d5e
  download:                             # same atomic single-file fetch as the GGUF (two jobs, one modelId)
    url: https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf?download=true
    sha256: b9160fe9d814d1fadf68395677468534778b39ac33c2e7561b7b218626e60d5e
download:
  url: https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf?download=true
  sha256: d02fe9b69ad8cadbbd228e387667af66612c44bed29ffc8eb1e7caf9ac486c12
```

Validator rules (added in `shared/manifest.ts`): `mmproj` is **required iff `role: vision`**;
`mmproj.local_path` non-empty; `mmproj.sha256` a real lower-case hash or `REPLACE_WITH_REAL_HASH`;
a **real** `mmproj.download.sha256` must equal a **real** `mmproj.sha256` (same file). Install state
(`services/models.ts`) requires **both** files present + SHA-256-verified. An older build that
doesn't know `vision`/`mmproj` simply treats the manifest as `unsupported` (forward-compatible).

**RAM tiering (PROD-1).** Min RAM is **12 GB** for the model alone (~4.6 GB peak RSS), but the
honest co-residency bar is higher: vision + a 12B chat (~7 GB) + the E5 embedder = three
`llama-server` processes ⇒ **>16 GB** at peak. The idle teardown bounds the *window*, not the
active-use peak (model-benchmarks §8.4). So vision is realistically co-resident only with a small
chat model, or after the chat sidecar idles out; the `recommended_min_ram_gb` / RAM-best-fit gate
keeps it off machines that can't hold it. **In the `--with-assets` default set (2026-07-01)** — `prepare-drive --with-assets` pulls the
vision model's two files by default (it is in `$DefaultModelIds`/`DEFAULT_MODEL_IDS`), but it is
**never auto-recommended in-app** (`recommended_profiles: []`, rank 0) — availability-driven, used
on demand by the Images screen. On a hand-built drive, `fetch-models --only <vision-id>` or
`--all-models` pulls both files.

**License-review record — Qwen2.5-VL-3B-Instruct (status: approved, reviewed 2026-06-20):** the base
model **`Qwen/Qwen2.5-VL-3B-Instruct` is Apache-2.0** (the all-permissive posture — same as the Qwen3
chat catalog and the E5/reranker entries). The shipped GGUF + f16 `mmproj` come from
**`ggml-org/Qwen2.5-VL-3B-Instruct-GGUF`** — the official llama.cpp org — which declares `apache-2.0`
via its HF card tag (mechanical GGUF/projector conversion, the same provenance posture as the E5 and
reranker GGUF entries). No new license class enters the product. Live-loaded on the pinned **b9585**
during the V1 gate (it read a real German invoice correctly); the runtime-arg resolution + the SSE
reuse are in the architecture design record §3. The reference mechanics-proof artifact **SmolVLM-256M**
(ggml-org, Apache-2.0) is recorded in BUILD_STATE V1 but is **not** a product candidate.

## The translation role + TranslateGemma (TG wave, 2026-07-05)

The `translation` role powers HilbertRaum's **dedicated translation model**,
**`google/translategemma-12b-it`** served by its **own `llama-server` sidecar** — the same
availability-driven, opt-in posture as vision/reranker/transcriber, not a chat slot. This section is
the **license + model-policy record** for the role (license-review, architecture facts, the
`--jinja` research note); the full engineering design record — sidecar, doc-task reroute, Translate
view, and the TG-6 measurements — lives in [`architecture.md`](architecture.md) "Translation sidecar
— design record" and [`model-benchmarks.md`](model-benchmarks.md) §11. The TG wave plan was folded
into those and deleted at TG-6 (git history keeps it).

The schema addition is minimal — `translation` is a **single-file GGUF** (`shared/manifest.ts`
`ModelRole` + `ROLES`), no `mmproj`:

```yaml
role: translation
input_modalities: [text]               # TEXT-ONLY: the model is image-text→text and the repo ships
                                       #   mmproj projectors, but we deliberately reference only the GGUF
local_path: models/translation/translategemma-12b-it.Q4_K_M.gguf
sha256: b7aac4b4be7ab0c49b6556c29c4467e74313df7f1e95d9f9676bb2adf0afa528
recommended_context_tokens: 4096       # the sidecar's --ctx-size (2K input budget + output), NOT a chat window
download:
  url: https://huggingface.co/mradermacher/translategemma-12b-it-GGUF/resolve/main/translategemma-12b-it.Q4_K_M.gguf?download=true
  sha256: b7aac4b4be7ab0c49b6556c29c4467e74313df7f1e95d9f9676bb2adf0afa528
  size_bytes: 7300794112
  license_url: https://ai.google.dev/gemma/terms
```

Everything else rides the existing schema. Install state (`services/models.ts`) is role-agnostic
(present + SHA-256-verified ⇒ `installed`); `selectModel` **refuses** it ("used automatically") — it
activates by **presence** via `resolveModelByRole('translation')` once the weight is verified, exactly
like reranker/vision. An older build that predates the role treats the manifest as `unsupported`
(forward-compatible, the same rollout as vision/transcriber). On the Models screen it renders as an
automatic-role card (no Select/Start), downloadable behind the license-acknowledgement gate below.

**Architecture facts this rests on (verified 2026-07-05).** TranslateGemma is **plain Gemma 3**
(`Gemma3ForConditionalGeneration`, `model_type: gemma3`) — no new architecture string, so the pinned
**b9849** runtime (which has loaded `gemma3` since 2025) loads it with **no pin bump**. The model card
states a **2K-token input budget** (the fine-tune's trained window, though the arch supports 128K) →
document translation must chunk to ≤~2K tokens (enforced structurally at TG-3). The GGUF is from
**`mradermacher/translategemma-12b-it-GGUF`** — the de-facto standard community quant (no Google QAT
or Apache-2.0 variant exists; unsloth/bartowski/ggml-org/lmstudio-community/QuantFactory published
nothing, verified via author-scoped HF API queries). The `Q4_K_M` file is **7,300,794,112 bytes**;
its **git-LFS OID = the file SHA-256** (`b7aac4b4…a528`), cross-checked against the resolve endpoint's
`X-Linked-ETag` + `X-Linked-Size`, and the repo is **public** (tree API + resolve both readable
unauthenticated, though Google's base repo is gated).

**Research note — the `--jinja` regression (why the sidecar is prompt-in-app, not template-driven).**
llama.cpp's dedicated TranslateGemma support (request-level `chat_template_kwargs`) merged 2026-01-24,
inside the pin — but a later chat-parsing rework (**PR #19419**) **regressed the `--jinja`
embedded-template path** for this template ("Unable to generate parser … std::bad_alloc", issue
**#20305**; fix **PR #20956 re-verified STILL OPEN at TG-2, 2026-07-05** — the PR adds a
`--skip-chat-parsing` flag + extra content-part fields, but a commenter reported it did not resolve
the user-role template error, so it stands unmerged). **Therefore the translation sidecar must NOT
use `--jinja`**: it formats the trained single-turn prompt in app code (`services/translation/prompt.ts`)
and calls the raw **`/completion`** endpoint (the endorsed workaround, `services/translation/completion.ts`).
This also rules out running TranslateGemma as a `role: chat` model (the chat sidecar hard-codes
`--jinja`). The design is built at TG-2 (plan §2 D2); the no-jinja choice is simpler and deterministic
and stands even if a future pin lands the #20305 fix (V5 re-checks this on each pin bump).

**TG-2 smoke finding (2026-07-05) — #20305 crashes at STARTUP, not just per-request.** On the real
b9849 pin the server CRASHES during init (Windows `0xC0000409`/std::bad_alloc) even with **no
`--jinja`**: it validates the model's embedded chat template at startup, and TranslateGemma's
template (typed `{source_lang_code,target_lang_code}` content) crashes the probe
(`render_message_to_json: Neither string content nor typed content is supported by the template`).
**Fix: the sidecar launches with `--chat-template gemma`** (the built-in legacy, non-jinja template)
so the startup probe has something renderable — SAFE because the raw `/completion` path never applies
the chat template (`/props` then reports `chat_template: "gemma"`). With that override the model
loads + translates cleanly (DE↔EN, injection-resistant, ~4 tok/s CPU, ~9.5 GiB peak RSS). Drop the
override if a future pin lands the #20305 fix — the smoke re-decides.

**License-review record — TranslateGemma 12B (O1 in-app review CLOSED — approved 2026-07-10;
manifest `status` stays `pending`).** The base model `google/translategemma-{4b,12b,27b}-it` is
under the **Gemma Terms of Use** (`https://ai.google.dev/gemma/terms`) — a **non-permissive**
license, the same class that kept **Gemma 3 parked** (only Gemma 4 moved to Apache-2.0; see
"Disqualified / parked candidates" above). The owner review of the **in-app, license-gated download
path closed as APPROVED** on 2026-07-10, resting on four verified provisions of the Terms:
the §3.1 distribution flow-down binds the *distributor* of the weights (for the in-app path that is
Hugging Face → the user; the app is the conduit behind the explicit license-acknowledgement
checkbox, `license_url` = the Gemma Terms, not bundled, not auto-recommended); commercial **use**
is allowed; outputs are unencumbered (§3.3 — a user's translated document is theirs); and the
Prohibited Use Policy is incorporated by reference and updateable by Google. **Commercial-drive
preloading remains a separate open review** — preloading *is* redistribution, so it carries a
four-point flow-down checklist before any drive bundles this model: a copy of the Gemma Terms on
the drive, the verbatim Gemma NOTICE line, an enforceable use-restriction clause in the sale terms,
and the quantization-provenance notice. **The manifest's `license_review.status` deliberately stays
`pending`**: in the manifest schema `approved` expresses the *redistribution* review — the sell gate
(`assertCommercialDrive` + the `build-commercial-drive` scripts) requires `approved` for **every**
manifest on the drive while `bundled_on_preconfigured_drive` is advisory/unused, so the `pending`
status is the only mechanical guard keeping the model off a sellable drive; flipping it would also
remove the in-app acknowledgement checkbox (`ModelDownloadInfo.licenseApproved`). It flips to
`approved` only together with the flow-down artifacts and a license-class acknowledgement gate.
**Third-party quantizer provenance:** the GGUF is a community requant (mradermacher) inheriting the
Gemma license — the same established-quantizer posture as the unsloth entries; the hash is pinned
via the LFS OID and re-verified with `verify-models --generate` after the first fetch.
