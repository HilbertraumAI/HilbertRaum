# Changelog

All notable changes to **HilbertRaum** are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
from its first public `1.0.0` release onward.

> **No public release yet.** HilbertRaum is a pre-1.0 MVP. Internal development
> checkpoints were tagged `v0.1.0` … `v0.1.34` (2026-06-10 → 2026-06-22, mirrored
> by the `version` field in `package.json`, currently `0.1.34`); these are rapid
> per-phase development checkpoints, **not** published releases, and have no
> per-tag notes. The detailed, chronological development log of record is
> **[`BUILD_STATE.md`](BUILD_STATE.md)**. The first public release will get its
> own dated entry below; this file is curated by hand from then on.

## [Unreleased]

The accumulated, feature-complete MVP — plus the GPU-acceleration,
retrieval-quality, UI-polish, and office-functionality waves — to be cut as the
first public release. Consciously-accepted gaps are tracked in
[`docs/known-limitations.md`](docs/known-limitations.md).

### Added

- **Local chat** — a `llama.cpp` runtime running GGUF models entirely on-device
  (CPU or GPU), with a curated open-weight catalog (Qwen3, Ministral, Gemma,
  Granite) and an on-machine benchmark that recommends the best-fit model for
  available RAM. A built-in **demo mode** runs the whole UI with no model files
  and no network.
- **Document Q&A with citations** — import PDF / Word / text, ask questions, and
  get answers grounded in your files. Hybrid (vector + keyword) retrieval with a
  reranker, scoped by **collections**.
- **Image understanding** — ask questions about a picture with a local vision
  model (Qwen2.5-VL); the analysis history is stored locally, encrypted at rest,
  and deletable.
- **Audio & voice** — transcribe audio files (Whisper), dictate prompts, and run
  on-device OCR ("Make searchable") on scanned pages (bundled German + English
  language files; no cloud OCR).
- **Document tasks & skills** — summarize, translate, and compare documents;
  install reusable **skills** for structured extraction (bank statements,
  invoices, meeting minutes, contract briefs, deadlines, redaction / share-safe).
- **Encrypted, portable workspace** — an optional password-encrypted workspace
  (AES-256-GCM with Argon2id key derivation) covering the database, imported-document
  copies, and the diagnostics log; keep models plus the workspace on an external
  drive and move between laptops.
- **Privacy & security posture** — no cloud, telemetry, or analytics; a sandboxed,
  context-isolated renderer; a strict Content-Security-Policy; deny-by-default
  renderer permissions; an offline guard that trips on any non-loopback connection
  attempt; and a tamper-evident local audit log (ids/counts only, never content).
- **Cross-platform & distribution** — Windows-first, with macOS and Linux supported
  in the architecture; portable / preconfigured-drive distribution via
  `scripts/build-commercial-drive.*`.
- **Standard project docs** — this `CHANGELOG.md` and a
  [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
