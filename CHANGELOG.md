# Changelog

All notable changes to **HilbertRaum** are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
from its first public `1.0.0` release onward.

> **No public release yet.** HilbertRaum is a pre-1.0 MVP. Internal development
> checkpoints were tagged `v0.1.0` … `v0.1.34` (2026-06-10 → 2026-06-22, mirrored
> by the `version` field in `package.json`, currently `0.1.55`); these are rapid
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
  and deletable — per-entry and total sizes are shown, a confirmed "Clear
  history" removes everything at once (issue #122), and the history's disk
  footprint appears in Settings → Diagnostics.
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
- **Windows engine build attached to releases** (issue #102 item 1). Each release
  now carries `llama-runtime-win-x64.zip` beside the existing mac Metal zip: the
  same SHA-256-verified llama.cpp build the in-app installer fetches, packaged so
  it unzips straight into the drive's `runtime/llama.cpp/` folder — an offline /
  air-gapped install path that needs no repo scripts.
- **Opt-in perf mark log** for measurement runs: with `HILBERTRAUM_PERF_LOG=1` set in
  the environment, the app appends timestamped timing marks (startup phases, vault
  unlock/lock split, model checksum vs. load split, time to first token, document
  ingestion phases) to `logs/perf.log`. Off by default; no file is created without the
  variable. Records the cold-load figures `docs/model-benchmarks.md` §11.4 lists as
  still missing. See `docs/benchmark.md` "Perf marks".
- **Model checksum passes are visible now** (issue #106). Verifying a model's
  multi-GB file — which can take minutes from a slow USB stick and used to run
  with no trace anywhere — now writes one diagnostics-log line per real
  verification (which model, how many bytes, how long), plus `checksum_start` /
  `checksum_done` marks in the opt-in perf log. Overlapping verifications of the
  same file (for example a start racing an AI Model screen visit) also no longer
  each read the whole file — they share one pass.
- **Honest progress while a model starts** (issue #107). Once the app has
  measured your drive's real read speed, the Chat screen's "your model is
  starting" panel shows the model file size and an approximate percentage read
  instead of an indefinite spinner. Fresh installs (no measurement yet) keep the
  plain message rather than showing a made-up number.
- **Cold model starts are much faster on slow drives** (issue #114). While a
  model loads, the app now also reads the model file front-to-back in the
  background, which lines the operating system's file cache up with what the
  load is about to need. Measured on a 16 GB laptop: a 6.65 GB model from a slow
  USB stick started in 5:46 instead of 11:20 (−49%), and from a portable SSD in
  10 s instead of 15 s (−36%). Starts that are already fast stay as they are —
  the helper is skipped when the file was just verified (its content is already
  in the cache) and stops the moment the load finishes or is cancelled.
- **One-click skill offers on document answers** (issue #80). When a document
  answer cannot serve the *shape* you asked for — "categorize the transactions
  and sum per category" answered by an engine that can only list values — the
  answer now carries a one-click "Run "Bank Statement Analysis" for this
  question" action instead of only a prose pointer; clicking re-answers the
  same question with the skill (nothing ever runs without the click). On the
  residue the deterministic router provably cannot classify, a bounded,
  grammar-constrained on-device model pick (marked "Suggested by the local
  model") may fill the same offer; ordinary questions keep their zero-model-call
  routing, and every failure quietly falls back to today's answer.
- **Export your original files from the workspace** (issue #90). Every imported
  document's ⋯ menu now offers **Export original file**, which saves the stored
  original — PDF, Word, recording, photo, any format — byte-for-byte to a
  location you choose, even when the file you imported it from is long gone.
  Imported documents previously had no export action at all (only generated
  documents did). The export shows the encryption-boundary warning first (the
  saved copy is not protected by your workspace password), writes atomically,
  and records only the document id in the activity log. One document per export
  for now; bulk export is a possible follow-up.

### Changed

- **The Images screen now takes WEBP pictures and big phone photos** (issues
  #124, #118). WEBP files are converted on the fly (nothing new touches the
  security-sensitive parsers), and the old hidden 4096-pixel rejection is gone
  — a routine 48 MP phone photo now simply downscales like everything else,
  with the real safety cap (~50 megapixels) checked *before* any decoding
  work is spent. iPhone HEIC photos are still unsupported, but now get a
  specific "convert to JPEG first" message instead of a generic refusal.
- **Image-analysis errors now say what to do** (issue #123). A too-slow
  answer ("try a smaller image or ask again"), an over-long conversation
  about one image ("ask a shorter question or start a new analysis"), and an
  empty question each get their own message instead of the generic "the
  vision model had a problem".
- **Diagnostics now shows a real read speed** (issue #108). The old "Drive read
  (cached)" figure came from the operating system's memory cache and showed
  four-digit MB/s numbers even on a slow USB stick — it is gone. In its place,
  "Measured read speed" reports the throughput of the last real multi-GB read
  the app performed (a model load or a full file check), the number that
  actually decides how long model starts take. Shown as "not measured yet" until
  the first model start.
- **The slow-drive warning now keys on read speed** (issue #110). The warning
  used to fire on slow *writes*, but what makes a slow drive painful is
  *reading* — every model start reads the whole model file. It now fires when
  the measured read speed is below 100 MB/s and says what that means ("model
  starts will be slow on this drive"), naming the measured speed. The old
  write-based warning remains as a secondary check for genuinely broken media.

- **The recommended model now leads the picker** (issue #93 item 3). The AI Model
  screen's RAM-best-fit recommendation always ran unprompted, but the ★ card sat
  wherever catalog order placed it inside the runnable block — on a fresh install
  with nothing downloaded, the one actionable answer to "which model should I
  get?" could be below other cards. The picker now orders installed → recommended
  → runnable-on-this-machine → catalog, and the badge says "Recommended for this
  computer" so it reads as machine-specific advice, not marketing. Models that
  exceed this machine's RAM keep sinking with their "needs X GB — this computer
  has about Y GB" flag, unchanged.
- **Release notes and README now name the engine step** (issue #93 item 2). The
  quickstart and the generated release-note preamble said only "the AI models are
  fetched separately"; a release-exe user who downloaded a model had no written
  hint that chat also needs the in-app **AI engine** (`llama.cpp`) install and
  would stay in demo mode without it. Both surfaces (plus the troubleshooting
  "where are the models?" entry) now spell out the two-download path — engine
  first, then a model — matching the install banner the AI Model screen already
  shows.
- **The model picker leads with models that run on your machine** — on a fresh
  workspace it used to list alphabetically, so a 16 GB laptop opened on several
  models flagged "needs more RAM"; runnable models now come first (full audit
  2026-07-23; see the `docs/architecture.md` §51 remediation ledger). The
  drop-down selects on the AI Model and Translate screens now use the app's own
  typography and colours in both light and dark themes instead of the raw
  operating-system control, and a handful of German quotation marks were
  corrected.
- **Evidence-review chips and bulk actions are faster** — opening a documents
  conversation now loads all its review chips in a single database round-trip
  instead of one per message, and the "mark headings N/A / clear decisions /
  mark undecided" bulk actions apply in one atomic transaction (so an
  interrupted bulk action can no longer leave a half-changed review).
- **Continuous integration now exercises the versions the release is built on** —
  the test matrix runs on both supported Node majors on Windows and Linux with
  the pinned npm, closing a gap where the declared toolchain floor was never
  actually run in CI.
- **Deep-index extraction is more reliable under reasoning-prone models** — the
  "Build deep index" structured-extract pass now grammar-constrains the model's
  reply (the same JSON-schema mechanism the bank-statement categorizer uses), so
  sections can no longer come back unreadable because the model answered in
  prose or code fences; "unparsed" sections in listing answers should now be
  rare, and the existing retry/salvage safety net is unchanged (wave STR-1; see
  the `docs/architecture.md` "Skills & tools architecture review (2026-07-19) —
  design record").

### Fixed

- **One failed vision start no longer disables image understanding until
  restart** (issue #117). If the vision model failed to start once (for
  example under memory pressure), every later attempt failed instantly for
  the rest of the session and "Try again" could never succeed. A retry now
  starts fresh.
- **Reopening a saved image analysis no longer degrades the picture** (issue
  #121). Every reopen used to re-compress the stored image (JPEG quality
  0.9, compounding per open), quietly blurring receipts and forms for
  follow-up questions. The stored image is now used exactly as saved.
- **The macOS launcher now works on exFAT drives** (PR #104, contributed). exFAT
  cannot store the symlinks inside a Mac `.app` bundle, so a prepared drive
  carries the app as a zip — but the launcher only looked for an unpacked
  `.app` and always failed. It now unpacks the zip once into the local user
  cache (`~/Library/Caches/HilbertRaum`, keyed by version so updates on the
  drive take effect) and starts the app from there; workspace, models and
  runtime all stay on the drive. A drive with an unpacked `.app` beside the
  launcher behaves exactly as before. Not yet smoke-tested on Apple hardware —
  the extract path replaces a launcher that could never succeed on exFAT.
- **"Ready" now means ready — the first prompt after a model start no longer
  stalls** (issue #109). The first generation after a start paid a one-time
  warm-up that measured 6–8× the settled response time (10–30 s on CPU-only
  machines) while the UI already showed the model as ready, which read as a
  hang. The model start now runs a small hidden warm-up generation (content-free,
  thinking off, output discarded, never stored) before reporting ready, so the
  wait moves into the existing "Starting…" state and the first real answer
  arrives at normal speed. The warm-up is bounded (a slow one is abandoned after
  90 s and the model still becomes ready), never runs in demo mode, and a stop
  or quit during it still cancels the start promptly; the one-time "the model is
  warming up" note stays as a fallback for a first answer that is still slow.
- **Standalone portable installs can download models again** (issue #93). A
  packaged build run without a prepared drive (the GitHub-release `.exe`
  double-clicked standalone) lands on an app-data fallback root that never had a
  `config/policy.json`; the M-4 fail-closed rule treated that like a drive whose
  policy went missing and locked model downloads to OFF permanently — the
  Settings toggle can only enable what the policy ceiling allows, so every
  release user was blocked. The fail-closed scope is now a *provisioned* config
  dir (a `policy.json` — even malformed — or the prepared-drive marker
  `drive.json`); an unprovisioned dir gets a standalone posture that permits
  model downloads (still behind the Settings toggle + per-download confirmation,
  SHA-256-verified) while keeping workspace encryption and model-integrity
  enforcement at the strict value. A prepared drive missing its `policy.json`
  still fails closed via its `drive.json` marker.
- **A reviewed answer can no longer be silently destroyed by re-answering it**
  (full audit 2026-07-23, wave `fix/audit-2026-07-23-remediation`; see the
  `docs/architecture.md` §51 remediation ledger). The documents "Answer without
  it" undo regenerated the turn, which deleted the answer and — via a foreign-key
  cascade — its entire evidence review (decisions, notes, links, export history),
  even on the paths designed to lose nothing; it is now refused with the affected
  affordance disabled and explained. The same class was closed one table over for
  an answer's structured "Export CSV" table, which is now replayed when a failed
  or stopped regenerate restores the answer.
- **"Lock now" (and quit) no longer leave a content-bearing model running** — a
  document task, translation, image analysis, or model auto-start that landed
  during the seconds-long lock teardown used to respawn the multi-gigabyte
  sidecar the teardown had just stopped, so it outlived the lock; a lock-in-progress
  latch now refuses such starts across every content surface, and the quit path
  arms it too (closing a vision-sidecar orphan and a plaintext-transient window).
- **The Translate screen no longer discards a finished translation or adopts a
  document-list translation** when you navigate back to it, and neither translate
  panel re-seeds content that a workspace lock had just purged.
- **Provisioning scripts degrade gracefully again on Windows** — under
  PowerShell's stop-on-error mode a `Write-Error` aborted the whole script, so a
  single transient download failure killed `-WithAssets` provisioning instead of
  warning and continuing (on macOS/Linux the whisper step, which has no prebuilt
  binary, aborted before OCR on every run); the tolerant paths now warn and
  continue as documented, and a checksum-mismatch redownload deletes a complete-
  but-corrupt file first instead of resuming past its end (an aria2c-preallocated
  partial — full-length on disk but still mid-download, with its `.aria2` control
  file beside it — is recognized and kept for aria2's own control-file resume).
- **Evidence-pack exports** no longer show a source excerpt twice, can no longer
  swap two concurrent same-destination exports' content or provenance, no longer
  stall the whole app on a synchronous multi-megabyte write, and log (rather than
  silently swallow) a failed cleanup of a temporary decrypted file. Review-screen
  fixes: an export toggle no longer reports "expanded" on a disabled control, the
  narrow-mode evidence drawer no longer re-opens with a focus trap, and the
  reveal control names sources rather than "sections".
- **Documentation now states that packaged-app OCR crashes** (a verified,
  version-independent packaging defect — dev-mode OCR is unaffected) instead of
  presenting it as an unverified release-acceptance item; broken relative links
  in the data-contracts doc and two model-catalog omissions are corrected.
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

- **All 19 open Dependabot alerts cleared (wave DEP-3, PR #115, 2026-08-09)** — one
  patch/minor-only batch, no dismissals: pdfjs-dist 6.2.108 (CVE-2026-16633,
  arbitrary JS on a malicious PDF — the app was never exposed: no annotation
  scripting, and the OCR window enforces `script-src 'self'`; bump verified
  against the real-data PDF gold-set), mermaid 11.16.1 + DOMPurify 3.4.13 (all
  six alerts unreachable — the Streamdown mermaid plugin is never wired, the
  chain is tree-shaken from the renderer bundle and excluded from the packaged
  app; production-scope in the dependency graph only, a correction to the DEP-2
  entry's "ships in the renderer" framing — plus a new test pinning that a
  mermaid code fence stays a plain code block), and dev/build-tooling hygiene:
  undici 7.29.0 + 6.28.0, fast-uri 3.1.5, postcss 8.5.26, js-yaml 4.3.1, plus
  all seven brace-expansion copies and nanoid 3.3.18 — clearing seven further
  high alerts Dependabot's auto-triage had auto-dismissed as dev-scope.
  `npm audit`: 0 vulnerabilities. Triage ledger:
  `docs/architecture.md` "Dependabot triage — design record (wave DEP-3)".
- **Hardened the workspace-lock confidentiality contract (full audit 2026-07-23)**
  — closed the "Lock now"/quit races above (a content-bearing sidecar could keep
  user-derived text in memory after the workspace reported locked), and stopped a
  workspace lock from re-seeding just-purged plaintext translation content back
  into the renderer. Widened the repository's byte-hygiene checks to the shipped
  launcher and shell scripts (a stray byte-order mark before a `#!` line silently
  stops the macOS/Linux launchers), and restored the packaged Content-Security-
  Policy build check that had been degrading to a silent skip. See the
  `docs/architecture.md` §51 remediation ledger.
- **Post-DEP-1 advisory batch cleared (wave DEP-2, 2026-07-23)** — five transitive
  dev/build-tooling packages patched lockfile-only, semver-compatible, no manifest
  changes: node-tar 7.5.21 (decompression/parse DoS CRITICAL + infinite-loop,
  PAX-crash and NUL-byte advisories), js-yaml 4.3.0 (merge-key quadratic CPU;
  electron-builder's copy — the app's own manifest parser is the separate `yaml`
  package and was never affected), fast-uri 3.1.4 (host confusion ×2),
  brace-expansion 1.1.16 / 2.1.2 / 5.0.8 (exponential-time `{}` expansion DoS,
  CVE-2026-13149 — Dependabot alert #56), and DOMPurify 3.4.12 (the one
  production-scope member — in the dependency graph; DEP-3 later verified it
  ships in neither the renderer bundle nor the packaged app;
  `CUSTOM_ELEMENT_HANDLING` sanitizer bypass, low severity, config not used by
  mermaid). `npm audit`: 0 vulnerabilities again.
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
