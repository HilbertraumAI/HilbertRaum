# Changelog

All notable changes to **HilbertRaum** are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
from its first public `1.0.0` release onward.

> **Pre-1.0.** HilbertRaum has been public since **2026-07-12** and has shipped releases
> since that day: **v0.1.50** was the first, **v0.1.59** is current. Versions stay in the
> `0.1.x` line and SemVer applies from `1.0.0` on — a `0.1.x` bump is a release checkpoint,
> not a compatibility promise. Tags below `v0.1.50` (and `v0.1.51`) are internal development
> checkpoints with no GitHub release and no notes.

> **What belongs in this file:** what changed **for the person using the app**, one section
> per released version. **What does not:** the product's overall feature list (see the
> [README](README.md) and [`docs/product-vision.md`](docs/product-vision.md)) and the
> engineering history — waves, audits, design records, internal decisions — which lives in
> [`BUILD_STATE.md`](BUILD_STATE.md) and [`docs/build-log.md`](docs/build-log.md). Each
> release page is built from the section matching the version being tagged
> (`.github/workflows/release.yml`), so entries are written for someone using HilbertRaum,
> not for a contributor.

## [Unreleased]

### Fixed

- **Quitting can no longer leave your workspace unencrypted.** Pressing Quit a second time while
  the app was still shutting down (for example while it waited on a slow AI-engine start) used to
  let the app exit before the workspace was re-encrypted, and the next start then discarded every
  change since the last lock. A second Quit now waits for the shutdown to finish, and the shutdown
  itself is capped at 30 seconds, after which the workspace is locked regardless.
- **Lock now and Quit no longer wait up to three minutes on a stuck engine start.** If the
  embedding, reranking or image-understanding engine was still starting up (a slow USB read of a
  large model file, say), locking or quitting waited for the whole start-up window and the engine
  then refused to start again until the app was restarted. Locking now cancels the start and
  finishes within a few seconds; the engine starts normally after the next unlock.
- **A text-recognition (OCR) failure no longer closes the app.** In the packaged app, importing a
  photo or running "Make searchable (OCR)" could exit the whole app when the recognizer failed to
  start. Such a failure now affects only that document: the photo is stored without readable text
  and its row says why, and the app checks once at start-up whether recognition can run at all —
  when it cannot, OCR is not offered and the Documents screen says so.
- **Text recognition (OCR) starts again in the packaged app.** The packaged app was missing some
  of the files the recognizer needs at start-up, which is why it failed (and, before the fix above,
  closed the app). Those files are now shipped, and a test keeps the list complete. Verified on a
  Windows build with the German and English language files; if recognition still cannot start on
  your machine, the app now tells you instead of closing.

### Changed

- **Spell-checking in the message box is switched off.** The built-in browser engine would
  otherwise download a spelling dictionary from a Google server on Windows and Linux the first
  time you type — against the promise that nothing leaves the space. Shipping dictionaries on the
  drive instead is under consideration.
- **A kit is only called sellable when it really carries the app.** The check that clears a
  prepared drive for sale now runs as one program for every builder and requires, for each system
  the kit is sold for, exactly one app of the version being built plus its launcher, and an
  engine binary whose recorded checksum still matches. A leftover older app build, an engine
  downloaded without a verifiable checksum, or an engine with no recorded checksum now stops the
  drive from being cleared (drive builders only; nothing changes for an app already in use).
- **Updating the app on a drive now means deleting the old one first.** The launchers refuse to
  start while more than one app version sits on the drive (two portable `.exe` files, two
  AppImages, or an extracted `HilbertRaum.app` beside a `.app.zip`) and list the files so you can
  delete the older one — nothing is deleted for you. An older build running beside a newer one
  could destroy the workspace (the 0.1.59 fix for issue #208 only protects when both copies are
  0.1.59 or newer). Each launcher also accepts `--check` (`/check` on Windows) to show which app
  it would start without starting it.

## [0.1.59] — 2026-08-21

### Fixed

- **A second running copy of the app can no longer destroy your encrypted workspace
  (issue #208).** Starting the app while another copy was already running — the natural
  upgrade flow: launch the new version, then close the old one — could silently and
  permanently corrupt an encrypted workspace on Windows, and the damage only surfaced at
  the next unlock, looking like a wrong password. Three fixes ship together: the app now
  refuses to start a second copy (the running copy's window comes to the front instead);
  the workspace re-encryption on lock/quit refuses to overwrite the vault with anything
  that is not actually your database; and a workspace whose encrypted data is damaged now
  says so plainly at unlock — with backup guidance — instead of implying the password was
  wrong. See the new troubleshooting entry "Your password is correct, but the workspace
  data on the drive is damaged".
- Failing to open the workspace database no longer leaves the decrypted file behind on the
  drive, and no longer holds an invisible open file handle to it.

### Changed

- **Developer runs (`npm run dev`) now use their own app-data folder** (`…\@hilbertraum\
  desktop-dev`) instead of sharing the released app's production workspace. A workspace
  previously created from a dev run stays on disk under the old path; point the dev run at
  it with `HILBERTRAUM_DRIVE_ROOT` if you still need it.

## [0.1.58] — 2026-08-20

### Added

- **Local API (optional, off by default).** Other programs on the same computer can be
  allowed to use the running chat model over a loopback-only, OpenAI-compatible endpoint
  (`http://127.0.0.1:4980/v1` — `GET /v1/models` and `POST /v1/chat/completions`, streaming
  or not, with JSON-schema-constrained output). It is off until switched on behind a consent
  dialog, requires an access key by default, never reaches the internet, exposes no documents
  or conversations, keeps no record of what was asked or answered, exists only while the
  workspace is unlocked, gives your own chat priority over any outside caller, and can be
  forbidden by drive policy. Tutorial, client examples and the wire contract:
  [`docs/local-api.md`](docs/local-api.md).
- **Faster answers from the large Qwen3.8 models on a capable GPU** (issue #182). These model
  files always carried a small built-in "draft" head that the engine loaded and ignored; it is
  now used, worth a measured **38–45 % faster text generation** on the reference machine. It
  engages only when one GPU has room for the model plus ~3.5 GiB, and any refusal falls back
  to exactly the previous behaviour — a model can be slower to start once, never broken.

### Changed

- **New recommended chat models for 24 GB and ≥32 GB machines** (issue #196). Unsloth removed
  the Qwen3.8 files the previous recommendations pinned, so those downloads had begun failing
  with a 404. Two things changed. A model whose upstream source has been withdrawn now **says
  so on the AI Model screen**, with the reason and the date, instead of offering a Download
  button that cannot work — and the drive-provisioning scripts skip it with a clear line
  instead of retrying a dead link. And the closest published successors were re-measured on
  the reference machine before taking over the tiers: **Qwen3.8 27B UD-Q4_K_M** at 24 GB and
  **UD-Q5_K_M** at ≥32 GB. Answer quality is unchanged within measurement noise; the 24 GB
  pick generates about **19 % slower** than the withdrawn file, which is recorded in the
  catalog rather than glossed over. **Already-downloaded copies of the old files keep
  working** — they still verify, still start, and keep the speed-up above.

### Fixed

- **Downloading "Gemma 4 12B Instruct QAT Q4" works again** (issue #201). Google replaced that
  model file on their servers in July with a corrected version, at the same address. The app
  checks every download against the exact file it expects, so it was transferring the full ~7 GB
  and only then reporting a checksum failure — with nothing you could do about it. The catalog
  now points at the corrected file, which was measured against the old one first and answers
  identically. **If you already downloaded this model, your copy will now report a checksum
  failure and needs downloading again** (~7 GB) — press Download on the AI Model screen and it
  replaces itself. No other model in the catalog is affected: all the rest were re-checked
  against their sources in the same pass.
- **Deleting a document really deletes its stored copy after a drive changes letter**
  (issue #188). The workspace recorded each imported copy by absolute path, so moving the
  drive between computers — or just getting a different drive letter — left every stored copy
  unreachable: "Delete document" removed the entry while the encrypted copy stayed on disk,
  and exporting or previewing the original failed. Paths are now resolved relative to the
  drive, and existing entries heal themselves the first time each document is opened.
- **Re-indexing or deleting a single document now tells you what happened** (issue #194).
  The action worked but reported nothing at all — no confirmation, no progress, no error. It
  now shows a spinner on that row, confirms with the document's name, and names the document
  in the message if it fails. "Re-index all" already behaved this way.
- **One AI job at a time, across every part of the app** (issues #185, #186). Starting the
  Diagnostics benchmark, or a skill run, could put a second job on the model while an answer
  was still streaming — each part of the app tracked "busy" separately and none of them
  agreed. They now share one signal. A speed measurement taken while something else was
  running is **discarded rather than saved**, so a contended reading can no longer push your
  machine's model recommendation down permanently; when that happens, the benchmark says so.

### Security

- **Electron 39.8.10 → 43.4.0** (issue #179), clearing the last open dependency alert:
  GHSA-jmr9-qjv8-65gv (CVE-2026-56876, high) in `extract-zip`, which is abandoned at its last
  version and could only be cleared by moving Electron. Chromium 142 → 150, Node 22 → 24,
  SQLite 3.51.2 → 3.53.1. **Minimum operating systems are unchanged** (Windows 10+, macOS 12+)
  and **no stored format changed**, so existing workspaces open exactly as before. `npm audit`
  reports 0 vulnerabilities.

## [0.1.57] — 2026-08-17

### Changed

- **Qwen3.8 27B became the recommended chat model for 24 GB and ≥32 GB machines** (issue
  #178), with three new catalog entries and verified upstream hashes. *Superseded 2026-08-20:
  upstream removed those files from its repository; issue #196 and the release that followed
  replaced them with re-measured successors.*
- **Release pages now open with a "which file do I need?" table** (issue #177), so a
  first-time visitor is not left guessing which of the assets is the app.

### Fixed

- **Drive provisioning verifies checksums again on Windows** (issue #176). A shell difference
  on git-bash paths made the checksum helper return a mangled hash, which broke verification
  during drive builds.

## [0.1.56] — 2026-08-10

### Added

- **Export your original files from the workspace** (issue #90). Every imported document's ⋯
  menu now offers **Export original file**, saving the stored original — PDF, Word, recording,
  photo, any format — byte-for-byte to a location you choose, even when the file you imported
  it from is long gone. The export warns that the saved copy is not protected by your
  workspace password, and writes atomically.
- **One-click skill offers on document answers** (issue #80). When a document answer cannot
  serve the *shape* you asked for — "categorize the transactions and sum per category"
  answered by a plain list — the answer now carries a one-click "Run *Bank Statement Analysis*
  for this question" action instead of only a prose pointer. Nothing ever runs without the
  click, and ordinary questions are unaffected.
- **Cold model starts are much faster on slow drives** (issue #114). While a model loads, the
  app now reads the file ahead in the background so the operating system's cache is ready for
  what the load needs next. Measured on a 16 GB laptop: a 6.65 GB model from a slow USB stick
  started in **5:46 instead of 11:20** (−49 %), and from a portable SSD in 10 s instead of
  15 s (−36 %). Starts that are already fast are left alone.
- **Model checksum passes are visible** (issue #106). Verifying a multi-GB model file — which
  can take minutes from a slow stick and used to run with no trace anywhere — now writes one
  diagnostics line per verification (which model, how many bytes, how long). Two overlapping
  verifications of the same file also share one pass instead of each reading it whole.
- **Honest progress while a model starts** (issue #107). Once your drive's real read speed is
  known, the "your model is starting" panel shows the file size and an approximate percentage
  read instead of an indefinite spinner. Fresh installs keep the plain message rather than
  showing a made-up number.
- **Windows engine build attached to every release** (issue #102). Each release now carries
  `llama-runtime-win-x64.zip` beside the macOS Metal zip: the same verified llama.cpp build
  the in-app installer fetches, packaged to unzip straight into the drive's
  `runtime/llama.cpp/` folder — an offline / air-gapped install path needing no repo scripts.
- **Opt-in timing log for measurement runs.** With `HILBERTRAUM_PERF_LOG=1` set, the app
  appends timestamped marks (startup phases, unlock, checksum vs. load, time to first token,
  ingestion phases) to `logs/perf.log`. Off by default; no file is created without it.

### Changed

- **Gemma 4 E2B is now recommended for 12–15 GB machines** (issue #153). On the weak-hardware
  class this rank was gated on, it generates about **1.9× faster** than the previous pick with
  better grounded-answer quality.
- **The model recommendation listens to measured speed** (issue #95). When the Diagnostics
  benchmark measures generation under 5 tokens per second on a model that is right-sized for
  your machine or smaller, the recommendation steps down one size tier and a warning names the
  measured model and figure. A crawl measured on an oversized, manually started model never
  moves the pick.
- **The recommended model leads the picker** (issue #93). The ★ card used to sit wherever
  catalog order placed it, so on a fresh install the one actionable answer to "which model
  should I get?" could be below others. The order is now installed → recommended → runnable on
  this machine → the rest, and the badge reads "Recommended for this computer".
- **Every screen shares one content width** (issues #166, #171). All screens now use the same
  centred width with symmetric gutters, explanatory text is capped at a readable line length,
  and the content no longer shifts sideways by the scrollbar's width when moving between
  scrolling and non-scrolling pages.
- **The Images screen takes WEBP pictures and big phone photos** (issues #118, #124). WEBP is
  converted on the fly, and the old hidden 4096-pixel rejection is gone — a routine 48 MP
  phone photo now downscales like everything else, with the real safety cap checked *before*
  any decoding work is spent. iPhone HEIC photos are still unsupported but now say "convert to
  JPEG first" instead of refusing generically.
- **Image-analysis errors say what to do** (issue #123). A too-slow answer, an over-long
  conversation about one image, and an empty question each get their own message instead of
  the generic "the vision model had a problem".
- **Diagnostics shows a real read speed** (issue #108). The old "Drive read (cached)" figure
  came from the operating system's memory cache and showed four-digit MB/s even on a slow USB
  stick. In its place, "Measured read speed" reports the throughput of the last real multi-GB
  read — the number that actually decides how long model starts take.
- **The slow-drive warning keys on read speed** (issue #110). What makes a slow drive painful
  is *reading*: every model start reads the whole file. The warning now fires below 100 MB/s
  read and says what that means, naming the measured speed.
- **The README and release notes name the engine step** (issue #93). Both said only that "the
  AI models are fetched separately", leaving a release-exe user with no written hint that chat
  also needs the in-app **AI engine** install and would otherwise stay in demo mode.

### Fixed

- **Translation wave** (issues #156–#165). Translating or comparing an indexed photo no longer
  fails "source unreadable"; Stop really cancels a translation waiting behind another job
  instead of running on and saving an unwanted document; a single failed progress check no
  longer abandons a running translation behind a "failed" panel, and a reload re-attaches
  progress and Stop; locking or quitting during a translation model's cold start no longer
  hangs for up to three minutes; a same-language document drop is declined before the import
  rather than after; Copy no longer silently copies only the first page of a long result; and
  translation errors are reliably announced to screen readers.
- **Frontend wave** (issues #137–#151). Rapid edits in the chat scope picker no longer
  overwrite each other; the skill run button appears as soon as an attached file finishes;
  Documents import progress survives navigating away and back; typing review notes no longer
  lags on long reviews; the AI-engine download gained a Cancel; error messages — wrong
  password included — are announced to screen readers and focus returns to the password field.
- **Skills wave** (issues #128–#136). A redacted Word copy can no longer leak masked text when
  a link contains an e-mail address, and no longer carries personal data outside the visible
  body — headers and footers, footnotes, comments, tracked-changes text, link targets and
  author metadata are now masked or scrubbed, with the pre-run dialog stating what automatic
  masking cannot reach. Redacting a very large document no longer fails at the end of a
  multi-minute run. Skill packages zipped with macOS Finder now import. Skill auto-fire really
  requires a matching document in scope, and suggestions are only offered when the skill could
  actually help.
- **Images wave** (issues #117–#124). One failed vision start no longer disables image
  understanding until restart, and reopening a saved analysis no longer re-compresses the
  stored picture a little more each time.
- **"Ready" now means ready** (issue #109). The first answer after a model start used to pay a
  one-time warm-up worth 6–8× the settled response time — 10–30 s on CPU-only machines — while
  the app already showed the model as ready, which read as a hang. That warm-up now runs
  during "Starting…", hidden and discarded, so the first real answer arrives at normal speed.
- **Standalone portable installs can download models again** (issue #93). A packaged build run
  without a prepared drive was permanently locked out of model downloads by a fail-closed rule
  meant for a drive whose policy file had gone missing.
- **The macOS launcher works on exFAT drives** (PR #104, contributed). exFAT cannot store the
  symlinks inside a Mac `.app`, so a prepared drive carries the app as a zip — but the launcher
  only looked for an unpacked `.app` and always failed.
- **A reviewed answer can no longer be silently destroyed by re-answering it.** The documents
  "Answer without it" undo regenerated the turn, deleting the answer and, through a cascade,
  its entire evidence review — decisions, notes, links, export history. It is now refused, with
  the affordance disabled and explained.
- **"Lock now" and quit no longer leave a content-bearing model running.** A document task,
  translation, image analysis or auto-start landing during the seconds-long teardown could
  respawn the sidecar that had just been stopped, so it outlived the lock.
- **Provisioning scripts degrade gracefully again on Windows.** A single transient download
  failure used to kill `-WithAssets` provisioning instead of warning and continuing, and a
  checksum-mismatch redownload now deletes a corrupt file first instead of resuming past its
  end.
- **Evidence-pack exports** no longer show a source excerpt twice, can no longer swap two
  concurrent same-destination exports' content, and no longer stall the app on a synchronous
  multi-megabyte write.

### Security

- **All 19 open dependency alerts cleared**, patch/minor only, no dismissals — including
  `pdfjs-dist` 6.2.108 (CVE-2026-16633, arbitrary JavaScript from a malicious PDF; the app was
  never exposed — annotation scripting is off and the OCR window restricts scripts), plus
  build-tooling hygiene across `undici`, `fast-uri`, `postcss`, `js-yaml`, `brace-expansion`
  and `nanoid`. `npm audit`: 0 vulnerabilities.

## [0.1.55] — 2026-07-23

### Added

- **Gemma 4 QAT models in the catalog** (issue #82) — Google's official quantization-aware
  E2B / E4B / 26B-A4B / 31B builds, selectable but not auto-recommended.

### Changed

- **Deep-index extraction is more reliable under reasoning-prone models.** The "Build deep
  index" pass now constrains the model's reply to the expected structure, so sections can no
  longer come back unreadable because the model answered in prose or code fences.

### Security

- **Post-remediation advisory batch cleared** — `node-tar` (decompression and parse
  denial-of-service), `js-yaml`, `fast-uri`, `brace-expansion` (CVE-2026-13149) and
  `dompurify`, all lockfile-only. `npm audit`: 0 vulnerabilities.

## [0.1.54] — 2026-07-19

### Added

- **[`docs/skills-overview.md`](docs/skills-overview.md)** — the bundled skills at a glance,
  kept in sync with the shipped set by a test.

### Fixed

- **Scanned-PDF OCR is startable again from the Documents row.** It had become unreachable
  after a refactor: "Make searchable (OCR)" is an inline button on the scan's row again,
  already-recognized PDFs can be re-run, Translate explains scanned PDFs instead of calling
  them unsupported, and progress is honest through the final "Finishing" step. Packaged builds
  also no longer carry a development-only security-policy relaxation in their HTML.

### Security

- **All critical- and high-severity dependency alerts cleared** — Vitest (CVE-2026-47429),
  Electron (command-line switch injection, use-after-free classes, permission-origin
  confusion), Vite, `form-data` (CVE-2026-12143), `undici` and `esbuild`. The packaged build's
  security policy was re-verified on the new Electron runtime. `npm audit`: 0 vulnerabilities.

## [0.1.53] — 2026-07-18

### Added

- **Evidence packs (review mode).** Review a document-grounded answer block by block against
  its sources, record explicit decisions and notes, and export the review as a self-contained
  **evidence pack** in HTML or PDF — generated locally and offline, with honest coverage,
  freshness and limitation notes. A pack supports human review; it is not a correctness
  certification.

## [0.1.52] — 2026-07-17

### Fixed

- **An empty page in a translated document is marked in place, never a silent gap** (issue
  #58), and the finished translation reports what was incomplete.
- **Aggregation-shaped questions get an honest answer shape** (issue #54). Asking for totals
  per category from an engine that can only list values now leads with a hint saying so,
  instead of quietly answering a different question.
- **The 2026-07-16 audit remediation** (shipped as the internal `v0.1.51` checkpoint): CSV
  exports carry a UTF-8 marker so Excel opens them correctly; citation snippets, document
  chunking and the comparison view no longer split characters mid-symbol on emoji and
  non-Latin scripts; an interrupted model download recovers instead of looping; a crashed
  vision model no longer leaves a dead handle behind; and engine installs are refused while a
  model is in use rather than half-applied.

## [0.1.50] — 2026-07-12

**First public release** — the repository went public the same day. This release is the
accumulated MVP: local chat on a `llama.cpp` runtime with a curated open-weight catalog and a
hardware benchmark that recommends a model; document Q&A with citations over hybrid retrieval;
image understanding; audio transcription, dictation and on-device OCR; document tasks and
skills; a Translate screen with a dedicated on-device translation model across 51 languages;
an optional password-encrypted, portable workspace; and a no-cloud, no-telemetry privacy
posture with a tamper-evident local audit log. Windows-first, with macOS and Linux supported
in the architecture.

For what the product *is*, see the [README](README.md) and
[`docs/product-vision.md`](docs/product-vision.md); consciously-accepted gaps are tracked in
[`docs/known-limitations.md`](docs/known-limitations.md). Every release since has its own
section in [`CHANGELOG.md`](CHANGELOG.md).

[Unreleased]: https://github.com/HilbertraumAI/HilbertRaum/compare/v0.1.59...HEAD
[0.1.59]: https://github.com/HilbertraumAI/HilbertRaum/compare/v0.1.58...v0.1.59
[0.1.58]: https://github.com/HilbertraumAI/HilbertRaum/compare/v0.1.57...v0.1.58
[0.1.57]: https://github.com/HilbertraumAI/HilbertRaum/compare/v0.1.56...v0.1.57
[0.1.56]: https://github.com/HilbertraumAI/HilbertRaum/compare/v0.1.55...v0.1.56
[0.1.55]: https://github.com/HilbertraumAI/HilbertRaum/compare/v0.1.54...v0.1.55
[0.1.54]: https://github.com/HilbertraumAI/HilbertRaum/compare/v0.1.53...v0.1.54
[0.1.53]: https://github.com/HilbertraumAI/HilbertRaum/compare/v0.1.52...v0.1.53
[0.1.52]: https://github.com/HilbertraumAI/HilbertRaum/compare/v0.1.50...v0.1.52
[0.1.50]: https://github.com/HilbertraumAI/HilbertRaum/releases/tag/v0.1.50
