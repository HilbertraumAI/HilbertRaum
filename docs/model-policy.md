# Model Policy — Private AI Drive Lite

_Last updated: 2026-06-09 (Phase 12)_

## Principles
- **No model weights in git.** Weights live under `models/` on the drive (git-ignored).
- Every model is described by a **manifest** (YAML) under `model-manifests/`, so models can change
  without code changes (spec §3.3).
- Models are verified by **SHA-256** before use (spec §7.4). Unverified models are rejected unless
  developer mode is on.

## Default model family
**Qwen3 dense instruct**, quantized **GGUF**, run via `llama.cpp`. Apache-2.0 for many variants.

| Role | Candidate | Purpose |
|---|---|---|
| Chat small | Qwen3 1.7B Instruct Q4 | Weak laptops (TINY) |
| Chat balanced | Qwen3 4B Instruct Q4 | Default (LITE) |
| Chat better | Qwen3 8B Instruct Q4 | 16 GB+ (BALANCED/PRO) |
| Embeddings | small multilingual model | Local document search |

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
build per OS/arch/backend (`os`, `arch`, `backend`, `url`, `sha256`, `extract_to`). The **default
backend is CPU** (AVX2 on Windows x64, Metal on mac arm64, plain CPU on Linux x64) — the
broadest-compatible choice for an unknown laptop; GPU builds are an opt-in `--backend` override. It
is validated by `shared/runtime-sources.ts` and is **excluded from model discovery** (it is not a
model manifest).
