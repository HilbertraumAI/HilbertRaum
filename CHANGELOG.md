# Changelog

All notable changes to **HilbertRaum** are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
from its first public `1.0.0` release onward.

> **No public release yet.** HilbertRaum is a pre-1.0 MVP. Internal development
> checkpoints were tagged `v0.1.0` … `v0.1.34` (2026-06-10 → 2026-06-22, mirrored
> by the `version` field in `package.json`, currently `0.1.54`); these are rapid
> per-phase development checkpoints, **not** published releases, and have no
> per-tag notes. **Per-tag/`version` checkpointing was paused `v0.1.34` → 2026-06-30**
> (the audit-remediation rounds were tracked in `BUILD_STATE.md`, not version bumps), then
> **resumed at `v0.1.35` (2026-07-01)** with the b9849 vision-projector fix (RUNTIME-6/5);
> later phases remain tracked in `BUILD_STATE.md` until the first public release sets a real
> version. The detailed, chronological development
> log of record is **[`BUILD_STATE.md`](BUILD_STATE.md)**. The first public release will get its
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
- **Evidence packs (review mode)** — review a document-grounded answer block by
  block against its sources, record explicit decisions and notes, and export the
  review as a self-contained **evidence pack** in HTML or PDF — generated
  locally and offline, with honest coverage, freshness, and limitation notes. A
  pack supports human review; it is not a correctness certification.
- **Translate view + dedicated translation model (TranslateGemma)** — a top-level
  **Translate** screen for live text translation and drag-and-drop document
  translation across **51 languages**, source **and** target (the model's full
  production tier — from German and English to Arabic, Chinese, Swahili, and
  Vietnamese). Translation runs on a dedicated on-device **TranslateGemma 12B**
  sidecar (downloaded on demand behind the license acknowledgement; not
  bundled) — never the chat model; document translations materialize as
  searchable, exportable local documents. GPU-accelerated when the machine
  allows it, with an automatic CPU fallback. Calibrated against the real model
  (per-language round-trip evidence + measured tokenizer weights) so a window
  can only over-chunk, never overflow.
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

### Changed

- **Deep-index extraction is more reliable under reasoning-prone models** — the
  "Build deep index" structured-extract pass now grammar-constrains the model's
  reply (the same JSON-schema mechanism the bank-statement categorizer uses), so
  sections can no longer come back unreadable because the model answered in
  prose or code fences; "unparsed" sections in listing answers should now be
  rare, and the existing retry/salvage safety net is unchanged (wave STR-1; see
  the `docs/architecture.md` "Skills & tools architecture review (2026-07-19) —
  design record").

### Fixed

- **Scanned-PDF OCR is startable again from the Documents row** (it had become
  unreachable after a row-actions refactor): "Make searchable (OCR)" is an inline
  button on the scan's row, already-recognized PDFs can be re-run via
  "Read again (OCR)", Translate now explains scanned PDFs (make searchable
  first) instead of calling them unsupported, and progress is honest through the
  final "Finishing" step. Packaged builds no longer carry the dev-only localhost
  CSP relaxation in their HTML meta tags (wave OCR-R, PR #75; see the
  `docs/architecture.md` "OCR audit (2026-07-18) — remediation ledger").
- **`npm run dev` no longer 500s on the first page load** — a false "no CSP meta
  tag" throw during dev serve (the guard mis-read a deliberate, byte-identical
  no-op rewrite as a missing tag) is fixed; packaged builds were never affected
  (wave DEP-1, PR #77).

### Security

- **All critical- and high-severity Dependabot alerts cleared (wave DEP-1, PR #77)**
  — Vitest 3.2.6 (CVE-2026-47429, UI-server arbitrary file read/execute), Electron
  39.8.10 (command-line switch injection, four use-after-free classes,
  permission-origin confusion, header injection), Vite 6.4.3 + electron-vite 3.1.0
  (`server.fs.deny` bypass on Windows, path traversal), form-data 4.0.6 (CRLF
  injection, CVE-2026-12143), undici 7.28.0 + 6.27.0 (TLS-bypass and cross-origin
  routing via a SOCKS5 proxy, header injection), and esbuild 0.25.12 (dev-server
  CORS). `npm audit` now reports 0 vulnerabilities. Packaged-build security was
  re-verified on the new Electron 39 runtime: the strict Content-Security-Policy
  response header still attaches and enforces on `file://` in both windows (see
  `docs/architecture.md` "Dependency remediation — design record (wave DEP-1,
  PR #77)").
