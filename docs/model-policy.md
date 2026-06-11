# Model Policy — Private AI Drive Lite

_Last updated: 2026-06-11 (Phase 29: first benchmark run — Ministral/Gemma/Qwen3-2507 promoted,
Granite held, min-RAM recalibrated from measured peak RSS; see
[`model-benchmarks.md`](model-benchmarks.md) §6. Phase 28: four challenger manifests added per
[`model-catalog-expansion-plan.md`](model-catalog-expansion-plan.md) D16–D18; runtime pinned to
llama.cpp b9585; all license reviews approved)_

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
| Chat default | Qwen3 4B Instruct Q4 | ~2.7 GB | 8 GB | TINY / LITE / UNKNOWN | Smallest bundled chat model; default + weak-laptop fallback. Kept as default (has hybrid thinking → Deep) despite 2507 scoring higher (Phase-29 user decision) |
| Chat better | Qwen3 8B Instruct Q4 | ~5.0 GB | 12 GB | BALANCED | 12 GB+ laptops (RAM recalibrated from measured ~8.3 GiB peak) |
| Chat best dense | Qwen3 14B Instruct Q4 | ~9.3 GB | 14 GB | PRO | 32 GB+; the spec §7.3 PRO model — slower on CPU (slowest decode of all 8). RAM recalibrated from measured ~10.6 GiB |
| Chat MoE | Qwen3 30B-A3B (MoE) Q4 | ~18.6 GB | 24 GB | — (opt-in) | ~30B quality at ~3.3B *active*/token → near-3B speed; needs ~20 GB RAM |
| Chat (winner, 8B) | Ministral 3 8B Instruct (2512) Q4 | ~5.2 GB | 12 GB | — (deferred‡) | **Phase-29 winner at 8B**: 0/15 hallucinations (only model that never fabricated) + fastest 8B decode |
| Chat challenger | Granite 4.1 8B Q4 | ~5.3 GB | 12 GB | — (not promoted) | Phase-29: lost its tier (most 8B hallucinations 3/15, lowest F1); kept selectable for its IBM provenance story |
| Chat (winner, 12–14B) | Gemma 4 12B Instruct QAT Q4_0 | ~7.0 GB | 14 GB | — (rank‡) | **Phase-29 winner at 12–14B**: beats Qwen3 14B on every axis (fewer hallucinations, faster). `supports_thinking_mode` **flipped on** — only thinking-capable challenger |
| Chat (better 4B) | Qwen3 4B Instruct 2507 Q4 | ~2.5 GB | 8 GB | — (deferred‡) | **Phase-29 (D18)**: beats the original 4B on every axis; the quality alternative at the 4B tier (orig 4B stays the bundled default for Deep). Instruct-only — no thinking |
| Embeddings | Multilingual E5 Small (F16) | ~0.24 GB | 4 GB | all | Local document search (needed for Q&A) |
| Reranker (optional) | BGE Reranker v2 M3 (F16) | ~1.08 GB | 6 GB | LITE+ (never bundled by default) | Retrieval-quality pass over document search (Phase 21) — search works fully without it |

> Qwen3 **1.7B** was in the original spec §7.3 (the TINY/UNKNOWN "small" model) but was **dropped**:
> the official `Qwen/Qwen3-1.7B-GGUF` repo publishes no Q4_K_M. 4B now covers TINY/UNKNOWN too.
> The embeddings model uses an **F16** GGUF, not Q8 — the q8_0 conversions of this BERT/XLM-R model
> crash llama.cpp b9585 (`binary_op: unsupported types … q8_0`). See BUILD_STATE §9. The
> **reranker** (also XLM-R family) is pinned to **F16 for the same reason**; its live load on b9585
> is verified by the `PAID_RERANK_SMOKE` manual harness. License review (recorded in its manifest):
> base model `BAAI/bge-reranker-v2-m3` = Apache-2.0 (HF API, 2026-06-10); GGUF from
> `gpustack/bge-reranker-v2-m3-GGUF` (also Apache-2.0, mechanical conversion — same provenance
> posture as the E5 entry). `Qwen3-Reranker-0.6B` was rejected: no official GGUF.

All models are **Apache-2.0** (Qwen3, the Phase-28 challengers, BGE reranker) / **MIT** (E5).
Sizes/RAM come from each manifest
(`size_on_disk_gb` / `recommended_min_ram_gb`); download URLs live in the manifests' `download.url`
(catalog with source links in the [README](../README.md)). **Auto-tier** is the
`recommended_profiles` list each manifest declares.
> ‡ **Promotions are LIVE via `recommendation_rank`, not `recommended_profiles`.** The
> production picker is **RAM-best-fit** (`recommendModelIdByRam`) and ignores `recommended_
> profiles` (that list is only the legacy no-RAM path, which is one-model-per-profile). Rather
> than mis-encode the **Phase-29** winners there, each manifest carries a `recommendation_rank`
> (higher = preferred) that the picker now uses as the tiebreak among models that fit the
> machine's RAM (the **quality-aware recommender** follow-up — `model-benchmarks.md` §6.2). Net
> effect on real hardware: **≤12 GB → Qwen3-4B (default, keeps Deep), 16 GB → Ministral 8B,
> ≥32 GB → Gemma 4 12B**; Granite (loser) and the 30B MoE (opt-in) are never auto-recommended.
> The "Auto-tier" column above is the declared `recommended_profiles` (kept as-is); the live
> recommendation is `recommendation_rank` + RAM-best-fit.
Min-RAM values were **recalibrated from measured peak RSS** in the Phase-29 run (8B: 16→12,
12–14B: 16→14). Adding a model is
**manifest-only** (no code change): drop a YAML in
`model-manifests/chat/` with a `download` block + a `recommended_profiles` list.

## Manifest format & parsing
Manifests are **YAML**, parsed with the pure-JS [`yaml`](https://www.npmjs.com/package/yaml) package
(added in Phase 2 — boring, reliable, no native deps, works fully offline). The schema and a
hand-written validator live in `apps/desktop/src/shared/manifest.ts` (one source of truth shared by
main + renderer). Validation collects **all** errors per file and is pure (no I/O) for easy testing.

## Manifest fields (required)
`id, display_name, family, role, format, runtime, license, size_on_disk_gb,
recommended_min_ram_gb, recommended_ram_gb, recommended_context_tokens, local_path, sha256` plus a
`license_review` block. Optional: `recommended_profiles` (a list of hardware profiles — the legacy
no-RAM picker), `recommendation_rank` (integer, default 0; higher = preferred among models that fit
the machine's RAM — the Phase-29 quality-aware tiebreak in `recommendModelIdByRam`),
`supports_thinking_mode` (below), and a `download` block (Phase 12, below). Unknown extra keys (e.g.
`supports_tools`, `dimensions`, `bundled_on_preconfigured_drive`) are ignored by the validator.

- **`local_path`** is resolved **relative to the drive root**, so a value of
  `models/chat/foo.gguf` points at `<drive-root>/models/chat/foo.gguf`.
- **`sha256`** is lower-case hex (64 chars). A non-hex placeholder (e.g. `REPLACE_WITH_REAL_HASH`)
  marks a model whose hash is not yet known; such a file is only usable in developer mode.
- **`runtime`/`format`**: currently `llama_cpp` + `gguf` are supported; anything else yields the
  `unsupported` state.
- **`supports_thinking_mode`** (optional boolean, default `false`) is **load-bearing since
  Phase 20**: it declares that the model's chat template implements the `enable_thinking`
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

## Optional `download` block (Phase 12 — the DIY asset loader)

The schema gained an **optional** `download` block describing where the `fetch-models` scripts pull
the weight from and what to verify it against. It is **additive** — manifests with no `download:`
stay valid, and the validator only checks the sub-fields when the block is present.

```yaml
download:
  url: https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf?download=true
  sha256: REPLACE_WITH_REAL_HASH   # when a real hash, MUST equal the top-level sha256 (same file)
  size_bytes: 2700000000           # optional, informational (progress + sanity check)
  license_url: https://huggingface.co/Qwen/Qwen3-4B-GGUF/blob/main/LICENSE   # optional
```

Rules (validated in `shared/manifest.ts`):
- `download.url` is required + non-empty when the block is present.
- `download.sha256` is required (a real lower-case hash, or a `REPLACE_WITH_REAL_HASH` placeholder).
  A **real** `download.sha256` must equal a **real** top-level `sha256` — they describe one file.
- `download.size_bytes` (≥ 0) and `download.license_url` are optional.

Leave `sha256` as the placeholder until a real drive is built; fetch the weight, then run
`verify-models --generate` to capture the real hash and promote it into the manifest.

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

### The in-app downloader (Phase 18 — plan §12.3 revived)

A model that is **missing** (or failed its checksum) and whose manifest carries a `download` block
can be fetched from the **AI Model screen**. Three gates, ALL required, re-checked in the main
process on every start (post-mvp-functionality-plan §6.1):

1. **Policy ceiling** — `policy.network.allow_model_downloads`. Since Phase 18 the **default**
   (no `policy.json`) permits downloads (plan §13 D3, resolved (a)) so the user toggle below is the
   effective gate on DIY/developer setups; `prepare-drive` keeps writing **deny** in both its
   postures, so prepared drives stay download-disabled unless the drive builder edits
   `config/policy.json`. Policy only restricts, never expands.
2. **User setting** — the spec §3.6 Settings checkbox ("Allow internet access for model
   downloads and updates"), **default OFF**. While the workspace is locked the setting is
   unreadable and treated as off.
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
build per OS/arch/backend (`os`, `arch`, `backend`, `url`, `sha256`, `extract_to`). Since Phase 14
the ordering is **vulkan-first**: the default build on win/linux is the **Vulkan full build**
(extracted to `runtime/llama.cpp/<os>/`), which is safe as a default because the upstream Vulkan
release archives are standalone full builds carrying every CPU backend variant — on a GPU-less
machine the same binary simply runs on its bundled CPU backends (verified against b9585; this
supersedes the Phase-12 "a GPU build fails or runs worse on a non-GPU machine" assumption, which is
false for Vulkan-the-archive). A **pure-CPU safety net** is additionally pinned per win/linux,
extracted to `runtime/llama.cpp/<os>/cpu/` (`--backend cpu`); mac arm64 stays Metal-only. Licensing
is unchanged: both Vulkan archives are built from the same MIT-licensed llama.cpp source at the
already-approved pinned tag, and the Vulkan *loader* is not redistributed (it comes with the user's
GPU driver) — no new licenses enter the product. The file is validated by
`shared/runtime-sources.ts` (duplicate `(os, arch, backend)` triples are rejected) and is
**excluded from model discovery** (it is not a model manifest). After each verified extraction
`fetch-runtime` writes a `.paid-runtime.json` install marker; skips are marker-based
(version + backend), never mere binary presence. Re-fetches **pre-clean the previous install**
(everything except the downloaded archive + the `cpu/` safety net) so an upgrade can never mix
two builds or keep a stale binary under a fresh marker (GPU audit round).

**License-review record — llama.cpp b9585 runtime assets (extends the original b9585 review,
commit `8bdeb2e`; status: approved, reviewed 2026-06-10):** all five pinned assets build from
the same MIT-licensed `ggml-org/llama.cpp` source at tag `b9585`. The two assets added by
Phase 14 are explicitly part of this record:

| Asset | SHA-256 | Notes |
|---|---|---|
| `llama-b9585-bin-win-vulkan-x64.zip` | `af6b1b94377b9f78dbb2285b878fb696d36766391499d65e055ecd622b69018a` | MIT; ships `libomp140.x86_64.dll` (MS OpenMP redistributable — same file as the win-cpu zip, no new artifact class); embedded SPIR-V shaders compiled from llama.cpp source (MIT) |
| `llama-b9585-bin-ubuntu-vulkan-x64.tar.gz` | `5f5467e5d9827b27eda17ee39b35fd2b7c8aa298f144e8836491ccec76160fdf` | MIT; no Vulkan SDK/loader content redistributed (the loader ships with the user's GPU driver) |

The win-cpu / ubuntu-cpu / macos-arm64 assets keep their hashes from the original b9585 review
(unchanged in `runtime-sources.yaml`). **No new licenses enter the product.**

> ✅ **Pinned to a real release: `b9585`** (2026-06-10), with real per-OS URLs and SHA-256
> checksums computed from the downloaded assets — `fetch-runtime` verifies before extracting.
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

## The whisper.cpp transcriber family (Phase 36)

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
