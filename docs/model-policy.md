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
| Chat (fast-tier 0.8B) | Qwen3.5 0.8B Q6_K | ~0.6 GB | 8 GB | — (rank 0) | **Qwen3.5 fast-tier (issue #48).** Smallest runnable; Q6_K (not UD-Q4_K_XL — quant error bites hardest at 0.8B). Text-only, not bundled. **§9 eval: the surviving fast-tier candidate — the honest floor (better F1 + abstention than the 2B).** Pending b9849 smoke + owner ratification. |
| Chat (fast-tier 2B) | Qwen3.5 2B (UD-Q4_K_XL) | ~1.3 GB | 8 GB | — (rank 0) | **Qwen3.5 fast-tier (issue #48).** CPU-only speed tier. Text-only, not bundled. **§9 eval: FAILED — worst unanswerable-discipline of all models scored (should not be recommended anywhere); the 0.8B dominates it.** Pending b9849 smoke + owner ratification. |
| Chat (new 4B) | Qwen3.5 4B (UD-Q4_K_XL) | ~2.9 GB | 8 GB | — (rank 0) | Added 2026-06-18 (user request). unsloth Dynamic-2.0 quant; thinking-by-default (Deep applies). **Not auto-recommended/benchmarked; runtime pin bumped to b9849 (Qwen3.5 gate) but b9849 load smoke still PENDING before promotion.** Vision model run text-only. |
| Chat (Qwen3.5 9B) | Qwen3.5 9B (UD-Q4_K_XL) | ~6.0 GB | 12 GB | — (rank 0) | **Qwen3.5 wave (2026-07-01).** unsloth Dynamic-2.0 quant; balanced-tier challenger to Ministral 3 8B / Qwen3 8B. Text-only. Not bundled/benchmarked; needs b9849 load smoke + offline eval before promotion. |
| Chat (Qwen3.5 27B) | Qwen3.5 27B (UD-Q4_K_XL) | ~17.6 GB | 24 GB | — (rank 0) | **Qwen3.5 wave (2026-07-01).** High-end dense challenger to Gemma 4 12B / Qwen3 14B / Qwen3 30B-A3B on 32 GB machines. Text-only, opt-in (not bundled). Pending b9849 smoke + offline eval. |
| Chat (Qwen3.5 35B-A3B) | Qwen3.5 35B-A3B (UD-Q4_K_XL) MoE | ~22.2 GB | 24 GB | — (rank 0) | **Qwen3.5 wave (2026-07-01).** ~35B total / ~3B active MoE (256 experts, 8+1 active); opt-in challenger to `qwen3-30b-a3b-q4`. Text-only, not bundled. Pending b9849 smoke + offline eval. |
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
> production picker is **RAM-best-fit** (`recommendModelIdByRam`) and ignores `recommended_
> profiles` (that list is only the legacy no-RAM path, which is one-model-per-profile). Rather
> than mis-encode the **Phase-29** winners there, each manifest carries a `recommendation_rank`
> (higher = preferred) that the picker now uses as the tiebreak among models that fit the
> machine's RAM (the **quality-aware recommender** follow-up — `model-benchmarks.md` §6.2, tiers
> since recalibrated by §6.3). Net effect on real hardware (§6.3 / issue #48, 2026-07-11; asserted
> in `benchmark.test.ts`): **≤12 GB → Qwen3-4B (default, keeps Deep), 16–20 GB → Ministral 8B,
> ≥24 GB → Gemma 4 12B**; Granite (loser) and the 30B MoE (opt-in) are never auto-recommended.
> The "Auto-tier" column above is the declared `recommended_profiles` (kept as-is); the live
> recommendation is `recommendation_rank` + RAM-best-fit.
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
  AI Model screen's "Context size" card (presets 4k–32k, default Automatic; rag-design §15.8).
- **Runtime pin bumped to b9849** (see "runtime-sources.yaml" below) specifically because Qwen3.5 is
  a newer architecture than the old b9585 build. b9849 *should* load these models, but that is not
  yet confirmed by a local smoke — see the manual-smoke checklist in `model-benchmarks.md` §9 / the
  BUILD_STATE "Qwen3.5 Unsloth wave" entry.
- **None are auto-recommended.** All four carry `recommendation_rank: 0` + `recommended_profiles: []`
  and `bundled_on_preconfigured_drive: false`: selectable manually on the AI Model screen, never the
  RAM-best-fit auto-pick, never bundled — **until the offline benchmark harness promotes them** with
  a real rank (`model-benchmarks.md` §9 promotion criteria). Public benchmark scores do not count;
  only the local German/English grounded-QA eval + manual smoke do.

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
`supports_thinking_mode` (below), a `download` block (below), and — for a `role: vision`
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
  size_bytes: 2700000000           # optional; progress + a DRIFT-TOLERANT in-app download body cap
  license_url: https://huggingface.co/Qwen/Qwen3-4B-GGUF/blob/main/LICENSE   # optional
```

Rules (validated in `shared/manifest.ts`):
- `download.url` is required + non-empty when the block is present.
- `download.sha256` is required (a real lower-case hash, or a `REPLACE_WITH_REAL_HASH` placeholder).
  A **real** `download.sha256` must equal a **real** top-level `sha256` — they describe one file.
- `download.size_bytes` (≥ 0) and `download.license_url` are optional.

`size_bytes` feeds the progress bar AND the in-app downloader's disk-fill body cap
(`modelWeightMaxBytes`). The cap is **drift-tolerant** — `size_bytes` grown by a comfortable headroom
(BUG dl-size-cap-2026-07-03) — so a file a little larger than the declared size still downloads; the
SHA verify is the integrity control. Do **not** understate `size_bytes` by more than the headroom:
an exact cap keyed to a too-small `size_bytes` previously truncated a legitimate download near ~95%
and then failed the checksum on resume. It is informational, not a hard integrity gate — the **real**
trust anchor is `sha256`.

Leave `sha256` as the placeholder until a real drive is built; fetch the weight, then run
`verify-models --generate` to capture the real hash **and the exact `size_bytes`** and promote them
into the manifest. A 64-hex value the code treats as a **verified** hash, so never transcribe a hash
you have not computed from the actual downloaded file — an unverified guess hard-fails the checksum.

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
header (best-effort — a server without range support restarts cleanly). On success the persisted
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
