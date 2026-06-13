# Known limitations & accepted trade-offs

_Last updated: 2026-06-13 (Phase 42: added the Internationalization section)._

The MVP (Phases 0–13) is feature-complete. Four post-MVP multi-persona audit rounds (2026-06-09)
found and fixed every Critical, High, and Medium finding plus the actionable Lows — see
BUILD_STATE §8 for the remediation summary; the full final audit report is preserved in git history
(`docs/audit-2026-06-09-multi-persona.md`, removed after remediation). What remains below are the
**consciously-accepted** product/architecture decisions and inherent limitations.

## Security & privacy

The encrypted-workspace limitations — a decrypted working copy on disk while unlocked, unencrypted
logs, best-effort shredding on SSDs, no password recovery — are documented in
[`security-model.md`](security-model.md) ("Threat notes / known limitations"). In addition:

- **The offline guard is detection-only and Node-socket-scoped.** It wraps
  `net.Socket.prototype.connect`, logs remote connection attempts, and never blocks (blocking
  app-wide risks breaking loopback IPC and the sidecars). Electron's own `net` module would bypass
  it. The offline guarantee is a property of the code + CSP + deny-by-default policy; the guard is
  a tripwire, not an enforcement layer.
- **`importDocuments` accepts caller-supplied paths.** The IPC handler trusts renderer-supplied
  file paths rather than honouring only picker-returned ones. Hardening against a compromised
  renderer is deferred (the renderer is already sandboxed with context isolation).
- **Archive extraction trusts verified archives.** `fetch-runtime` rejects `extract_to` escapes,
  and archives are SHA-256-verified before extraction — but member paths inside an archive are only
  as trustworthy as the pinned hash in `runtime-sources.yaml`.
- **A pre-Phase-32 build cannot open a v2 (envelope) vault.** New vaults — and any vault after
  its first password change — use the descriptor-v2 envelope (`security-model.md`). An older
  app version derives the correct KEK and even passes the verifier, but then tries to decrypt
  the data files with it and fails the GCM tag, surfacing "Could not open the workspace".
  Nothing is harmed or written; opening the drive with a current build works. Accepted: drives
  ship the app alongside the data, so version skew requires deliberately mixing an old app
  with a new workspace.
- **Password-change edge: a post-commit swap interruption can briefly wedge one document.**
  If the one-time v1→v2 migration is interrupted AFTER its descriptor commit but mid file-swap
  (e.g. a transiently locked file on Windows), a not-yet-swapped document sidecar stays under
  the retired key until the next app start, whose recovery rolls it forward; previewing or
  re-indexing exactly that document in the SAME session fails with a friendly error. No data
  loss; self-heals on restart.
- **The persisted checksum cache trusts size+mtime.** Model weights are SHA-256-hashed once and the
  result is cached (in memory and in `AppSettings.checksumCache`) keyed by `(path, size, mtime)` —
  re-hashing multi-GB GGUFs on every visit/launch cost minutes of USB I/O. A same-size,
  mtime-preserving in-place tamper is therefore not re-detected by the app's routine checks (mtime
  is attacker-forgeable anyway). Mitigations: the AI Model screen's **Verify checksum** forces a real
  re-hash, and the ship-time gates (`verify-models --strict`, `assertCommercialDrive`) always hash
  fully.

## Spec features intentionally not built (MVP scope)

- **No dedicated Onboarding wizard (spec §7.1).** The `WorkspaceGate` (create-password / unlock),
  the automatic first-run benchmark, and the Home screen together cover the spec §17 first-run flow.
- **Answer-depth accepted edges** (the modes themselves shipped — architecture.md
  "Chat & streaming"): the depth choice is per-conversation **per session** (not persisted
  to the DB), and document answers always run Balanced (deep-grounded answering is an open
  question).
- **Model states `ready` / `not_recommended` are declared but never produced.**
- **Settings lacks the spec §10.6 Models/Performance/About sections** (Models has its own screen;
  Diagnostics shows version/runtime/model info).
- **No `sample-contract.pdf` fixture** for the canonical spec §17 demo script.
- **Manifest fields `supports_tools` / `bundled_on_preconfigured_drive` are unused**
  (`supports_thinking_mode` is load-bearing — it gates the Deep answer mode).
  In particular the bundled flag's intent (don't preload the big models on a commercial drive) is
  unimplemented — the pipeline fetches all six weights (~37 GB); curate with
  `fetch-models --only <id>`.
- **In-app downloader accepted edges** (the downloader shipped — architecture.md
  "In-app model downloader"):
  - **The startup offline tripwire is not re-evaluated mid-session.** Toggling `allowNetwork` on
    and downloading in the same session leaves the (detection-only, never-blocking) guard
    installed, so the sanctioned download is logged as a remote-connection notice. Cosmetic;
    a restart re-derives the posture.
  - **Download progress display is per-renderer-session.** The job itself runs in the main
    process and survives navigation; after an app restart the progress card is gone but the kept
    `.part` resumes on the next Download click.
- **Drive updates are manual — Phase 22 (signed offline update bundles, spec §12.3) is still
  OPEN.** There is no update mechanism yet; the `updates/` and `workspace/backups/` directories
  are not created. The manual procedure is documented in [`drive-layout.md`](drive-layout.md)
  ("Updating a drive"). **Blocker: the key-management design** — who holds the signing key and
  where it lives (dev-machine key vs. an offline-born production key; HSM/hardware-token class
  questions), what public key drives trust (and whether DIY drives trust a repo key or generate
  their own), offline key rotation/continuity, and rollback protection. Deliberately **not yet
  decided** (discussed 2026-06-10, decision deferred); Phase 22 needs its own short design doc
  (`docs/update-bundles-plan.md`, outline in
  BUILD_STATE §5 item 3) before any code.
  One constraint already understood from that discussion: a trust anchor cannot be
  retroactively strengthened, so whatever key signs during development must never anchor
  commercial drives — the production key would be a different, offline-generated key.

## Engineering trade-offs (noted, intentionally unchanged)

- The per-import `jobs` map in `registerDocsIpc` is never pruned (tiny, ephemeral, per-process).
- `getSettings` does not type-guard stored JSON values (the privacy-critical network path is
  double-gated by the policy AND).
- `expandPaths` follows directory symlinks during import expansion.
- Sidecar port selection has a small TOCTOU window between `findFreePort()` and the spawn (no
  retry-on-bind-failure); the startup error is diagnosable via the captured stderr tail.
- The shell scripts re-implement logic whose canonical source is TypeScript (`drive.ts`,
  `assets.ts`, `commercial-drive.ts`, `launcher.ts`). Parity is maintained by convention + review,
  not code generation — see the rule in [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
- Docs copied onto a prepared drive (user-guide, troubleshooting) contain repo-relative links that
  do not resolve when read from the drive.
- **Audit log (Phase 19) accepted edges:** events recorded while the vault is locked are
  buffered in memory only — quitting the app before the next unlock drops them (bounded buffer,
  oldest dropped past 100). Lock-on-**quit** and the implicit stop during a model *switch* are
  not audited (only the explicit "Lock now" / stop actions are). A download that completes
  against a placeholder manifest hash records no `model_download_verified` event (checksum
  honesty — the AI Model screen shows UNVERIFIED).

## Retrieval quality (Phase 21, [`rag-design.md`](rag-design.md) §11)

- **`ragMinSimilarity` stays 0 — a positive cosine floor is impossible under prefix-less E5
  (MEASURED 2026-06-10, [`rag-design.md`](rag-design.md) §12.1 R3).** On the real `D:\` drive the
  relevant and irrelevant best-chunk cosine distributions OVERLAP (everything compresses into a
  ~0.87–0.94 band because E5 runs without its `query:`/`passage:` prefixes), so any positive floor
  drops real hits. Relevance separation is delegated to RRF + the reranker (D12). Latent
  improvement: a prefix migration would spread the distribution and make a floor meaningful, but
  forces re-embedding every corpus — revisit only as a deliberate migration.
- **Reranker latency on CPU is significant (MEASURED): ≈ 24.7 s worst case** for a 12-candidate
  batch at the full truncation budget on a CPU-pinned i7-1185G7 (~2 s/candidate;
  `PAID_RERANK_SMOKE`, 2026-06-10) — a documents query visibly lengthens on a low-end laptop when
  the reranker is provisioned. Bounded by the candidate cap (≤ 2×`topKInitial`) + word-truncation
  budgets (the tuning levers); the reranker stays an opt-in (provision-the-GGUF) feature, never
  bundled by default. The `PAID_RAG_QUALITY` run is the evidence it earns the cost
  (rag-design §12.3).
- **The FTS5 index duplicates chunk text inside the workspace DB** (a self-contained table was
  chosen over external-content on `chunks`' implicit rowid, which VACUUM may renumber). Bounded by
  the 1 000-chunk/file cap; encrypted at rest with the same DB file.
- **Keyword search is embedder-visibility-scoped by design**: a document whose vectors were
  produced by a different embedder is not keyword-searchable either, until re-indexed — that is
  the Phase-17 honesty rule, not a gap (`REINDEX_NEEDED_ANSWER` tells the user what to do).

## Document tasks & summaries (Phase 33, wave-3 plan §6)

- **Very long documents get a beginning-only summary (the map-call ceiling).** The
  budgeted map-reduce caps at **12 map calls** (≈ a ~50-page document at the default
  4096-token context) — Deep map-reduce over a 1000-chunk corpus on a CPU laptop is not a
  v1 promise (D25). The summary is flagged `truncated` and the UI says so honestly; the
  whole document remains searchable/answerable in RAG. A smaller `contextTokens` setting
  shrinks the per-call budget and hits the ceiling sooner.
- **Summary input is the stored chunks, not a re-parse (D25).** Adjacent chunks overlap by
  ~80 tokens, so stitched windows repeat a little text (harmless for summarization), and
  text beyond the 1 000-chunk ingestion cap was never chunked — so it is not summarized
  either (it is also not searchable; the same pre-existing cap).
- **Strictly one job at a time (D26).** While a summary runs, chat is refused with a
  friendly message + a cancel option, and vice versa — the one local model serves one
  request. The R-T1 probe confirmed the pinned b9585 WOULD serve concurrent requests on
  parallel slots, so this is an app-side product decision (predictable latency, no
  context-memory splitting), not a server constraint; revisit only with evidence.
- **Re-index clears the summary and nothing regenerates it automatically** — the content
  may have changed, so a stale summary must not survive; the user presses Summarize again.
  Accepted edge, mirrored in the user guide.
- **Word≈token budgeting is conservative, not exact.** The window math reuses the
  chunker's whitespace-word estimate with a 1.3 words→tokens safety factor; real token
  counts vary by language/model. Worst case is smaller-than-necessary windows (more map
  calls), never a context overflow.

## Document translation (Phase 34, wave-3 plan §7)

- **v1 targets are German and English only** (decided, plan §7). The bundled models and the
  Phase-29 eval set cover DE/EN; a free-text language field would invite silent quality
  failures. Widen only with evidence per language.
- **A translation is a snapshot, not a synced copy (accepted staleness edge).** The
  `origin_json` link records where the document CAME from — re-importing or re-indexing
  the SOURCE does not update an existing translation; the user re-runs Translate. If the
  source is later deleted, the provenance line says so ("a removed document") but the
  translation keeps working.
- **A window the model refuses/garbles is marked, never dropped.** After one retry the
  output carries a visible "could not be translated" notice with the ORIGINAL text kept
  below it; only an all-windows failure fails the whole task. Honesty over silent gaps.
- **Number/date FORMATS may localize even though values survive.** The R-T2 smoke on the
  real Qwen3-4B showed values, names, and invoice-style codes preserved, but formats
  adapted to the target language (*14.03.2026* → *March 14, 2026*; *39,90* → *39.90*).
  Correct translation behavior, stated honestly rather than promised away.
- **Long documents take time — linearly.** There is deliberately NO window ceiling (a
  faithful translation may not cover "the beginning" only, unlike the summary), so a
  100-page document is many model calls on a CPU laptop. Progress is visible per window
  and cancel always works (a cancelled translation persists nothing).
- **Export covers text documents only.** The Export action saves the STORED text
  (materialized translations are Markdown, so it is exact); PDFs/DOCX stored copies are
  original binaries and are not exported through this path.

## Document comparison (Phase 35, wave-3 plan §8)

- **Section-matched comparison is A-driven (accepted asymmetry).** When two documents are
  too long to compare in full, each section of document A is matched with the most
  RELATED excerpts of document B (stored vectors, no new index). That direction makes
  "only in A" findings reliable, but content that exists **only in document B** is seen
  only when it happens to be retrieved as a neighbor — it can be missed. The reduce is
  instructed to report only what the per-section notes support. A symmetric second pass
  would double the model calls; revisit with evidence.
- **The report covers the BEGINNING of document A when it is very long.** The map ceiling
  (12 calls, the summary's bounded-latency rationale) caps coverage; the report itself
  carries a visible notice when that happens. Both documents stay fully searchable.
- **Report section headings are English even for German documents.** The four headings
  are dictated verbatim so the report structure is deterministic (R-T2-probed: the 4B
  keeps them); the findings under them follow the documents' language. Cosmetic, accepted
  for v1.
- **One-sided clauses may ALSO appear under "What differs" in small-doc compares.** The
  R-T2 smoke showed the 4B sometimes lists a fact present in only one document both as a
  difference ("…while document B does not mention this") and under its "Only in" section
  — accurate but redundant; prompt-tightening fixed the reduce path, the full-compare
  duplication is accepted (visible, never wrong).
- **Mixed-language pairs get a single-language report.** The prompt says "write in the
  language of the documents"; for a German/English pair the model picks one. Compare
  like-language documents (or translate one first — Phase 34 exists for this).
- **A comparison is a snapshot, not a synced copy** — the same `origin_json` staleness
  edge as translations; re-run Compare after the sources change.

## Audio transcription (Phase 36, wave-3 plan §9)

- **m4a/aac recordings are not supported.** The pinned whisper.cpp binary decodes
  WAV/MP3/FLAC/OGG only (probed with real files, R-W2); decoding m4a would require
  bundling ffmpeg (license + surface we deliberately avoid). The friendly failure asks
  to convert the file to WAV or MP3 — most voice-recorder apps offer this.
- **Transcription runs on the CPU at roughly real-time ÷ 1.5.** Measured (R-W4, small
  model, 4 threads): a 52-minute meeting took ~35 minutes; peak memory ~1.2 GB. The
  import shows honest "Transcribing… N%" progress and the app stays usable meanwhile.
  GPU-accelerated whisper is a possible later opt-in, never a default risk.
- **Re-indexing an audio document is a FULL re-transcription** (D35). The stored copy is
  the audio itself (the locked copy-into-workspace contract — also what makes the drive
  self-contained), and there is no separate transcript cache; a sha256-keyed cache is the
  recorded follow-up if re-index proves common. Preview/translate/compare do NOT
  re-transcribe — they read the stored transcript chunks.
- **Audio costs real drive space, twice the size on encrypted workspaces transiently.**
  The recording is copied into the workspace (encrypted at rest); imports >50 MB of
  audio ask first. Recordings also re-encrypt on every vault password change like any
  document sidecar.
- **mac/linux drives need a source-built whisper-cli.** Upstream ships a prebuilt binary
  for Windows only (R-W1); on other OSes audio import fails friendly until the drive
  builder compiles the pinned tag (see `drive-layout.md`). Windows-first, by the
  project's platform priority.
- **Transcription quality is the small model's.** Proper nouns and unusual terms can be
  misheard (R-W3: "LibriVox" → "Librebox"); numbers, names of people/places, and dates
  held up well in the German probes. The transcript is searchable text, not a notarized
  record.

## Voice dictation (Phase 37, wave-3 plan §10)

- **Dictation is click-to-start / click-to-stop, then transcribe — not live.** Streaming
  ASR (words appearing while you speak) is explicitly out of scope (D30); the per-file
  whisper CLI transcribes only a finished recording. The wait after stopping is the
  whisper small model's real-time factor (~0.5× on the reference CPU), so a 15-second
  dictation takes a few seconds to land. A warm whisper-server mode is the recorded
  follow-up if dictation latency ever warrants it (D34's revisit clause).
- **The mic appears only when the speech model is installed** (the same
  availability-driven gate as audio import — no settings key). On a drive without the
  whisper binary + weights there is no dictation affordance at all, by design.
- **Whisper, not the OS, decides what was said.** Dictation quality is the small model's
  (see "Audio transcription" above); the text always lands in the message box for review
  and is never auto-sent — that review step is the accuracy backstop.
- **No interim cancel-without-transcribe control.** Stopping the recording always
  transcribes and inserts; deleting unwanted text is one Ctrl+Z / selection away
  (the insert participates in the input's normal undo history). Leaving the screen
  mid-recording discards the recording and releases the microphone.

## Scanned-PDF / photo OCR (Phase 38, wave-3 plan §11)

- **OCR runs on the CPU at a couple of seconds per page** (R-O3: ~1.3 s recognition +
  ~0.4 s rendering per A4 page on the reference CPU with the shipped `best_int` data).
  That is exactly why it is **never automatic for PDFs** (D33): detection marks the
  scan, the user starts "Make searchable (OCR)" deliberately, sees per-page progress,
  and can cancel. A 200-page scanned book is a ~10-minute, user-chosen job.
- **Language coverage is German + English** — the two shipped traineddata files. Other
  languages will recognize poorly or not at all. Coverage is availability-driven (the
  engine uses whatever `ocr/*.traineddata.gz` the drive carries), so a future language
  is one vendored file away — but only deu+eng are pinned, reviewed, and tested.
- **Recognition quality is the scan's quality.** Clean 150-DPI office scans came back
  near-perfect in the R-O3 probes (103/104 words, umlauts/ß exact); a degraded ~80-DPI
  JPEG still lost 3 of 104 words. The per-page text is searchable content, not a
  notarized record — Preview shows exactly what was recognized.
- **Hybrid PDFs (some text pages, some scanned pages) are not detected as scans.**
  Their real text pages index normally; the scanned pages stay invisible to search.
  Detection only catches documents with NO readable text — per-page hybrid OCR is a
  possible follow-up, not shipped.
- **The recognized text survives re-index; re-running OCR is the explicit redo.**
  Re-index (e.g. after an embedder switch) reuses the stored recognition rather than
  silently re-OCRing for minutes; if the recognition itself was bad, run "Make
  searchable (OCR)" again — it overwrites.
- **Photos are read on import** (the D33 asymmetry — one image, seconds). A photo
  import without the OCR files on the drive fails per-file with friendly copy.
- **Packaged-app OCR needs the asar-unpacked tesseract packages** (worker_threads
  cannot load scripts from inside `app.asar`). Wired in `electron-builder.yml`;
  verifying a real OCR run from the produced portable .exe is a release-acceptance
  item (the green gate never packages — the R2 posture).

## Internationalization (Phases 39–42, [`architecture.md`](architecture.md) i18n record)

- **Task/summary output language follows the model, not the UI (D-L6 — RESOLVED as
  documented).** LLM prompts are pinned English (Phase-29 benchmark comparability; models
  follow the language of the user's question naturally), so a one-click summary of a German
  document may come back in English depending on the model. Making task-output language
  explicit is a separate future feature — it belongs with the existing
  `TranslationTargetLang` machinery, not with UI i18n.
- **Audit-log messages and the activity export stay English.** `runtime_events.message` is
  written and exported as-is (the export is a diagnostic artifact); only the friendly TYPE
  labels in the Diagnostics Activity panel are translated. Per the Phase-19 privacy rule the
  messages carry ids/filenames/counts, never content — a stable English diagnostic record was
  chosen over translated DB rows.
- **Interpolated and library-origin error strings render as-is under German.** The D-L4
  display map is exact-match over the finite persist-canonical set by design, so
  `documents.error_message` values like `Unsupported file type: .xyz` and raw parser-library
  errors (e.g. a pdfjs exception message) show English in a German UI. Rare failure-path
  remnants, accepted.
- **`user-guide.md`, `READ ME FIRST.txt`, and the drive docs are English-only for now.**
  Translating them is content work, tracked separately from UI i18n.
- **A conversation transcript can legitimately mix languages.** Old answers, model output,
  and the fixed RAG answers translate (or don't) independently of the current UI language —
  accepted.

## GPU acceleration (Phases 14–16, [`architecture.md`](architecture.md) GPU record)

- **Integrated GPUs (Intel Iris Xe / UHD, AMD APU "Radeon Graphics") gain little.** They share
  system RAM, so token generation is often near CPU speed (~1–2×); prompt processing improves
  more (2–4×). This is honest physics, not a bug — the app still uses them automatically when
  the driver is stable, but the hardware-profile bump deliberately ignores them so the model
  recommendation stays RAM-based.
- **Vulkan slower than CPU is possible** on weak-iGPU + fast-CPU machines. v1 does **not**
  auto-benchmark CPU vs GPU and pick a winner (decided, GPU record §1); the Settings
  "Use GPU acceleration" toggle covers that case.
- **`win/arm64` and `mac/x64` ship no sidecar build** (decided, GPU record §1). mac/x64 = Intel
  Macs: upstream builds them with Metal **off** and macOS has no Vulkan, so GPU acceleration is
  impossible there regardless; Apple discontinued the line in 2023.
- **Intel Macs are not supported by prepared drives at all** (pre-existing gap surfaced while
  planning the GPU work, not introduced by it): a drive's `mac/` dir holds an **arm64** binary
  that exists but cannot execute on x64, so the runtime selector picks the real backend and
  `start()` fails with a spawn error instead of falling back to the mock — and the fallback
  ladder's rungs 2–3 reuse the same wrong-arch binary. A DIY Intel-Mac user could drop a
  self-built x64 `llama-server` into `runtime/llama.cpp/mac/`; prepared drives do not.
- **A failed first GPU start auto-disables GPU persistently** (`gpuAutoDisabled`) even when the
  underlying cause was not the GPU (e.g. a corrupt model file failing rung 1). Harmless — the
  CPU rungs still run and Diagnostics → "Try GPU again" clears the flag in one click.
- **The probe labels; the ladder guarantees.** `--list-devices` proves enumeration, not stable
  inference — a driver can enumerate fine and crash on the first compute submit. That case is
  handled by the crash auto-fallback (one CPU restart + a friendly notice); the in-flight reply
  is lost, same as today's crash handling.

## Accessibility (Phase-27 WCAG 2.2 AA sweep — consciously accepted)

The Phase-27 sweep contrast-audited every role-token pairing in both themes (fix applied:
`--border-strong` → `--n-500`, the only sub-3:1 non-text boundary that was the SOLE component
identifier), added forced-colors (Windows High Contrast) rules for the two custom-drawn
controls (Switch, strength meter), and verified the reduced-motion kill-switch. Accepted
as-is, with reasons:

- **Hairline `--border` separators are ~1.3:1.** They are decorative row/card separators,
  never the sole identifier of a component (cards pair them with surface fill + shadow;
  inputs use `--border-strong`). WCAG 1.4.11 applies to required boundaries only.
- **The fatal "app could not start" screen shows the raw error string.** §7 keeps error
  codes inside Diagnostics, but when the backend never came up Diagnostics is unreachable —
  the raw string (plus the log pointer) is the only diagnostic the user can relay.
- **The Documents screen's per-row selection checkbox is 15px.** Under the 24px target
  minimum, but WCAG 2.5.8 is satisfied via the spacing exception: the row is ≥40px tall and
  no other target falls within the 24px circle around it.
- **The bundled main process can contain a duplicated, tree-shaken copy of a module**
  (observed: `workspace-vault`'s `WrongPasswordError`/`shredFile`), which breaks cross-copy
  `instanceof`. The wrong-password mapping now also matches `err.name`; other duplications
  are benign (pure functions). Root cause in electron-vite/rollup module ids — not chased
  in this phase.
