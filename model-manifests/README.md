# Model manifests

Each YAML file here describes one model. Manifests are committed to git; **model weights are not**
(weights live under `models/` on the drive). The app reads these manifests to discover, verify
(SHA-256), recommend, and select models without code changes.

- `chat/` — chat/instruct models (Qwen3 1.7B / 4B / 8B / 14B Q4 + 30B-A3B MoE)
- `embeddings/` — embedding models (Multilingual E5 Small example)
- `runtime-sources.yaml` — the `llama-server` sidecar download manifest (Phase 12). **Not a model
  manifest** (it is excluded from model discovery); validated by `shared/runtime-sources.ts`.

Manifests are **YAML**, discovered recursively and validated at startup (invalid files are skipped
and logged, not fatal). See [`../docs/model-policy.md`](../docs/model-policy.md) for the field
reference, the model-state model, and the license-review gate.

Key points when authoring a manifest:
- `local_path` is **relative to the drive root** (e.g. `models/chat/qwen3-4b-instruct-q4.gguf`).
- `sha256` is lower-case hex; leave the `REPLACE_WITH_REAL_HASH` placeholder during development and
  set the real GGUF hash before bundling on a commercial drive (a placeholder hash is only usable in
  developer mode).
- `recommended_profiles` (optional) lists the hardware profiles the model is recommended for
  (`TINY`/`LITE`/`BALANCED`/`PRO`/`UNKNOWN`) and drives the recommendation badge on the Models
  screen. `id` must be unique across all manifests.
- `download` (optional, Phase 12) — `{ url, sha256, size_bytes?, license_url? }`. When present, the
  `fetch-models` scripts download + SHA-256-verify the weight. A real `download.sha256` must equal a
  real top-level `sha256`. See [`../docs/model-policy.md`](../docs/model-policy.md).
