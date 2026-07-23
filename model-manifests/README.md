# Model manifests

Each YAML file here describes one model. Manifests are committed to git; **model weights are not**
(weights live under `models/` on the drive). The app reads these manifests to discover, verify
(SHA-256), recommend, and select models without code changes.

- `chat/` — chat/instruct models (Qwen3 4B / 8B / 14B Q4 + 30B-A3B MoE, Qwen3-4B-2507, the Qwen3.5
  wave, the Qwen3.6 27B pair, Granite 4.1 8B, Ministral 8B, Gemma 4 12B + the Gemma 4 QAT wave
  E2B / E4B / 26B-A4B / 31B)
- `embeddings/` — embedding models (Multilingual E5 Small, F16; the manifest `id`/`local_path`
  keep a `-q8` suffix for historical stability — it tags stored vectors and is referenced across
  tests/docs, **not** a quant claim. Q8 is *not* the shipping quant — its q8_0 conversion crashes
  the pinned runtime; see [`../docs/model-policy.md`](../docs/model-policy.md).)
- `reranker/` — reranker models (BGE Reranker v2 m3)
- `transcriber/` — speech-to-text models (Whisper Small multilingual; `whisper_cpp`/`ggml`)
- `vision/` — vision models (Qwen2.5-VL 3B Instruct Q4; GGUF + mmproj projector)
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
