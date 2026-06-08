# Model Policy — Private AI Drive Lite

_Last updated: 2026-06-09_

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

## Manifest fields (required)
`id, display_name, family, role, format, runtime, license, size_on_disk_gb,
recommended_min_ram_gb, recommended_ram_gb, recommended_context_tokens, local_path, sha256` plus a
`license_review` block.

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
