# Model Policy — Private AI Drive Lite

_Last updated: 2026-06-10 (runtime pinned to llama.cpp b9585; all license reviews approved)_

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
| Chat default | Qwen3 4B Instruct Q4 | ~2.7 GB | 8 GB | TINY / LITE / UNKNOWN | Smallest bundled chat model; default + weak-laptop fallback |
| Chat better | Qwen3 8B Instruct Q4 | ~5.0 GB | 16 GB | BALANCED | 16 GB+ laptops |
| Chat best dense | Qwen3 14B Instruct Q4 | ~9.3 GB | 16 GB | PRO | 32 GB+; the spec §7.3 PRO model — slower on CPU |
| Chat MoE | Qwen3 30B-A3B (MoE) Q4 | ~18.6 GB | 24 GB | — (opt-in) | ~30B quality at ~3.3B *active*/token → near-3B speed; needs ~20 GB RAM |
| Embeddings | Multilingual E5 Small (F16) | ~0.24 GB | 4 GB | all | Local document search (needed for Q&A) |

> Qwen3 **1.7B** was in the original spec §7.3 (the TINY/UNKNOWN "small" model) but was **dropped**:
> the official `Qwen/Qwen3-1.7B-GGUF` repo publishes no Q4_K_M. 4B now covers TINY/UNKNOWN too.
> The embeddings model uses an **F16** GGUF, not Q8 — the q8_0 conversions of this BERT/XLM-R model
> crash llama.cpp b9585 (`binary_op: unsupported types … q8_0`). See BUILD_STATE §9.

All models are **Apache-2.0** (Qwen3) / **MIT** (E5). Sizes/RAM come from each manifest
(`size_on_disk_gb` / `recommended_min_ram_gb`); download URLs live in the manifests' `download.url`
(catalog with source links in the [README](../README.md)). **Auto-tier** is the hardware profile the
benchmark auto-recommends the model for (`recommended_profiles`); the **30B-A3B MoE** has an empty
list — it is selectable on the Models screen but never auto-recommended, since its download + RAM cost
should be a deliberate choice. Adding a model is **manifest-only** (no code change): drop a YAML in
`model-manifests/chat/` with a `download` block + a `recommended_profiles` list.

## Manifest format & parsing
Manifests are **YAML**, parsed with the pure-JS [`yaml`](https://www.npmjs.com/package/yaml) package
(added in Phase 2 — boring, reliable, no native deps, works fully offline). The schema and a
hand-written validator live in `apps/desktop/src/shared/manifest.ts` (one source of truth shared by
main + renderer). Validation collects **all** errors per file and is pure (no I/O) for easy testing.

## Manifest fields (required)
`id, display_name, family, role, format, runtime, license, size_on_disk_gb,
recommended_min_ram_gb, recommended_ram_gb, recommended_context_tokens, local_path, sha256` plus a
`license_review` block. Optional: `recommended_profiles` (a list of hardware profiles this model is
recommended for — drives the §7.3 picker) and a `download` block (Phase 12, below). Unknown extra
keys (e.g. `supports_tools`, `dimensions`, `bundled_on_preconfigured_drive`) are ignored by the
validator.

- **`local_path`** is resolved **relative to the drive root**, so a value of
  `models/chat/foo.gguf` points at `<drive-root>/models/chat/foo.gguf`.
- **`sha256`** is lower-case hex (64 chars). A non-hex placeholder (e.g. `REPLACE_WITH_REAL_HASH`)
  marks a model whose hash is not yet known; such a file is only usable in developer mode.
- **`runtime`/`format`**: currently `llama_cpp` + `gguf` are supported; anything else yields the
  `unsupported` state.

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

> **Build-time network, not runtime.** The `fetch-*` scripts run on the drive-**builder's** online
> machine. The app itself never auto-downloads — the optional in-app downloader (plan §12.3,
> deferred) stays policy-gated (`network.allow_model_downloads`, deny-by-default) **and** behind the
> user `allowNetwork` setting. The offline guarantee is unchanged.

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
(version + backend), never mere binary presence.

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
