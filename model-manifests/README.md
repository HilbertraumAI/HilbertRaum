# Model manifests

Each YAML file here describes one model. Manifests are committed to git; **model weights are not**
(weights live under `models/` on the drive). The app reads these manifests to discover, verify
(SHA-256), recommend, and select models without code changes.

- `chat/` — chat/instruct models
- `embeddings/` — embedding models

See [`../docs/model-policy.md`](../docs/model-policy.md) for required fields and the license-review
gate. Set `sha256` to the real hash of the GGUF file before bundling on a commercial drive.
