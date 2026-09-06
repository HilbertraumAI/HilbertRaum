# Changelog

All notable changes to **HilbertRaum** are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
from its first public `1.0.0` release onward.

> **Pre-1.0.** HilbertRaum has been public since **2026-07-12** and has shipped releases
> since that day: **v0.1.50** was the first, **v0.1.59** is current. Versions stay in the
> `0.1.x` line and SemVer applies from `1.0.0` on — a `0.1.x` bump is a release checkpoint,
> not a compatibility promise. Tags below `v0.1.50` (and `v0.1.51`) have no GitHub release
> page today and no notes here; one of them, `v0.1.46` (2026-07-10), was a pre-release
> handed to testers while the repository was still private; its release page has since been
> removed (#241).

> **What belongs in this file:** what changed **for the person using the app**, one section
> per released version. **What does not:** the product's overall feature list (see the
> [README](README.md) and [`docs/product-vision.md`](docs/product-vision.md)) and the
> engineering history — waves, audits, design records, internal decisions — which lives in
> [`BUILD_STATE.md`](BUILD_STATE.md) and [`docs/build-log.md`](docs/build-log.md). Each
> release page is built from the section matching the version being tagged
> (`.github/workflows/release.yml`), so entries are written for someone using HilbertRaum,
> not for a contributor.

## [Unreleased]

### Added
- **A quieter left navigation.** The sidebar now has three groups: Chat, Documents, Translate
  and Images for everyday work; AI Model and Performance for the machine; Settings at the
  bottom. The HilbertRaum mark at the top is the Home button and lights up when you are on
  Home, so the separate Home entry is gone. Skills moved into Settings as its own tab; the
  skill picker in the chat composer is unchanged.
- **A new Performance page in the left navigation.** It answers, in plain words, what this
  computer can run and how fast: one sentence, then four tiles for speed, memory, graphics
  memory and drive, each with a rating word, and a "Your model" line that says where your
  current model lands on this computer: in graphics memory, partly on the graphics card with
  the rest in RAM, on the processor, or too large, with the sizes behind the verdict once the
  model has started. Apple Silicon shows one unified memory figure. A "Models on this computer"
  card lists every model the app can hold (chat, translation, images, document search, voice),
  where each runs and whether it is loaded right now, and sums what the graphics card and the
  RAM would need with everything loaded at once. Below it, figures from real use (your last answer, the last model
  start, the last file check) and one result for every computer this drive has been plugged
  into. The check runs on its own the first time and whenever the drive lands on a different
  computer; on a computer it already knows, the earlier result is restored so the recommended
  model follows the machine. While a check runs you see its steps instead of a plain "Running…"
  button, and if no model has run yet the page offers to start the recommended one and measure.
  The technical table stays on Settings → Diagnostics. English and German.
- **A new computer's first check never borrows another computer's drive-speed reading.**
  Plugging this drive into a computer it hasn't seen before measures that computer's own read
  speed from scratch; a warning about a slow drive, or the lack of one, always reflects this
  computer, never whichever computer the drive was in last.
- **The Performance page refreshes itself and stays precise about what it measured.** It updates
  in place the moment a check finishes, a model starts, or a file is verified, with no need to
  leave and come back. A speed reading counted from streamed chunks rather than the model's own
  timing is marked Approximate everywhere it appears, including another computer's row and the
  copied report, which also always names the computer it describes. The graphics-memory tile
  says plainly when a chip's memory is Integrated and shared with the rest of the computer, and
  shows Not recorded, instead of guessing, for a computer this drive visited before the check
  could record its card. When a model only partly fits in graphics memory, the explanation now
  states the exact safety margin the AI engine reserves. After a check you started with the
  keyboard, focus returns to Check again.
- **Checking your computer's speed no longer competes with starting a model.** The automatic
  first-time check now waits for a model that is already starting up to finish loading before it
  measures your drive, instead of reading and loading at the same time.
- **Knowledge packs: ask an offline Wikipedia (or any ZIM archive).** Register ZIM
  files — e.g. from the Kiwix library — as knowledge packs (Documents → Knowledge
  packs, or just drop them into the drive’s `zim/` folder), tick them as sources in a
  documents chat, and answers draw on them with citations that name the archive and
  open the article offline. Fully local: the pack server binds to 127.0.0.1 only,
  archives are used in place and never copied. Needs the kiwix-tools binaries on the
  drive — still a manual step in this release (see the user guide §7b).
- **Knowledge packs are found once, not on every open.** The list is discovered when you
  unlock and by an explicit **Refresh** in *Documents → Knowledge packs*, instead of a
  fresh drive scan every time the panel opens or a message is sent — packs load
  instantly, and copying a new archive onto the drive shows up after Refresh. A pack
  whose file was replaced by a different archive is now shown as such ("Different
  archive") instead of quietly answering from the wrong one. Locking or quitting the app
  stops the pack server and removes its small generated index file. Opening an alias article
  (a redirect entry — about half of a Wikipedia archive's titles) shows the article it points
  to instead of an error. A large article that the bundled Windows pack server occasionally
  delivers only in part is re-requested instead of being reported as unavailable or dropped from
  the answer. Known limit on Windows: an archive can only be added from a path
  without umlauts or accents (the bundled kiwix-manage cannot read such paths) — the drive's
  `zim/` folder always works.
- **Evidence reviews now name the knowledge pack, not a same-named document.** Reviewing an
  answer that cites a knowledge-pack article records the archive, the article and its pack
  id honestly, and shows identity as not verifiable against the workspace instead of
  matching it to a similarly named document — the review, its HTML/PDF evidence pack and
  the Markdown transcript export all name the pack. Reviews created on a pre-release
  knowledge-pack build that cite an archive must be re-run.
- **Adding several knowledge packs at once now reports exactly what happened.** If some of
  the chosen archives could not be added, you are told how many were added and how many
  were not — never the technical reason a file failed. Answers and the article viewer now
  double-check with the pack server that it is still the same one that was running a moment
  ago, and retry once if it was restarted mid-question, instead of silently trusting
  whatever answers on that port. One privacy limit to know: other programs running under
  your own user account can read the enabled packs while the workspace is unlocked, through
  the pack server, which has no password of its own; locking or quitting the app stops it.
- **Answer from knowledge packs alone, and see what each one did.** A new **Search my
  documents** toggle in the sources picker lets you answer from ticked knowledge packs
  only — files attached to the chat are still used either way — and every answer now
  shows a "Knowledge packs:" line reporting whether each ticked pack was searched, and why
  not when it wasn't (over the pack limit, no full-text search index, timed out, …), even
  when nothing was cited. Search is now shared fairly across up to 12 ticked packs within
  a time limit, so one slow or empty pack no longer crowds out the others, and a pack with
  no full-text search index is now detected and skipped instead of returning nothing on
  every question.
- **Knowledge-pack review, picker and accessibility polish.** An evidence review that cites
  a knowledge-pack article now has its own *Open article* button, same as in chat. A
  greyed-out pack in the sources picker always says why it can't be ticked — file missing,
  a different archive at that location, disabled, or no full-text search index — and the
  Knowledge packs panel now shows a "No full-text index" badge on such a pack directly.
  Enable/Disable/Remove and *Open article* buttons name the pack or article they act on to a
  screen reader. The evidence-pack export's source column is now labelled "Source" (was
  "Document"), since it lists both documents and archives.- **Each finished chat answer now shows how fast it was generated.** A small line under the
  answer reads, for example, "42 tok/s · 1.8 s to first token · 615 tokens": the model's decode
  speed as reported by the AI engine, how long you waited for the first word, and how many
  tokens the answer took. It appears for answers generated in the current session only — nothing
  is saved, so older answers show no line after a restart — and only for plain chat answers with
  the real AI engine (not for document answers, and not for a stopped answer). English and German.

- **A searchable model library:** switch between models on this drive and the full catalog,
  filter by task or family, and expand quantization variants under one model entry. Compact
  rows keep model actions visible; descriptions and technical details expand when needed. A
  failed or unverifiable download keeps its named result, with Retry and Dismiss, above the
  list; models the app can't verify stay listed under On this drive and their group opens
  automatically; when several variants are equally good picks, the group shows one you can
  actually download.

### Fixed

- **A knowledge pack you just added is checked for full-text search right away.** Until now the
  check ran only when you unlocked or pressed Refresh, so a pack added through *Add packs…* (or
  enabled after being added) showed no "No full-text index" badge until then, and a question asked
  in between reported such a pack as "search failed". The check now runs by itself a moment after
  adding or enabling, and the badge and the sources picker update without a Refresh.
- **A lock that could not finish no longer leaves the chat without a model.** When "Lock now"
  fails (for example on a nearly-full drive) the workspace stays open, as before — but the app
  used to stop the AI model on the way and never start it again, so the next question was met
  with "No model is running" until you started the model by hand on the AI Model screen. The
  model now restarts by itself after a failed lock (when "Start the selected model automatically"
  is on, exactly as after an unlock), and the local API, if you have it switched on, comes back
  too.
- **The speed figure on Settings → Diagnostics is now the model's real decode speed.** The
  benchmark used to count streamed chunks over the whole request, including the time the model
  spent reading the prompt, so on the recommended Qwen3.8 models — which can produce several
  tokens per chunk — it showed roughly half the true speed. The row is now labelled "Decode
  speed", takes the number from the AI engine's own timing (generation only, counted in tokens)
  and shows how many tokens it was measured over. A result that could not use the engine's timing
  is marked approximate; results saved by earlier versions show as approximate too, since they
  were all measured the old way. Re-run the benchmark to get the new figure.
- **Answers from your documents now tell the model more firmly that document text is not
  instructions.** The excerpts an answer is built from are marked as document content, so a
  passage that reads like a command ("ignore the rules above …") is something to quote, not to
  obey. Citations, sources and the answer format are unchanged.
- **An older HilbertRaum now refuses a workspace written by a newer one instead of opening it
  half-understood.** The workspace database carries a version stamp; a copy of the app that
  finds a newer stamp says "This workspace was written by a newer HilbertRaum — update the app"
  and changes nothing. Existing workspaces are stamped the next time they open. Copies up to
  0.1.59 do not read the stamp, so the protection starts with this release.
- **A link in an answer or a model's licence link now asks before it opens your browser.** The
  app shows the site and the address first; Cancel is the default, and only Open hands the
  link to your browser. If several links try to open at once, only the first asks and the rest
  are dropped. In the download dialog, the licence link also names its site and is offered only
  for an `https://` address.
- **Shutting down or logging off Windows with the app open no longer loses the session.** The
  app now locks the workspace itself as the Windows session ends, so the changes since the last
  lock survive. It is a best-effort safety net — a very large workspace may not finish locking in
  the time Windows allows — so quitting the app first is still the sure way. On a Mac the same
  hook is in place but not yet verified; quit the app before shutting down there, as before.
- **The confirmation before a skill writes or exports a file now names the document.** You can
  see which document the tool will run on before you confirm, and the run is pinned to that
  document — if it is no longer in the chat by the time you press Run, the app says so instead of
  running on a different one.
- **A tampered engine list can no longer write outside the engine folder.** The file that
  names where to download the AI engine from lives on the drive. If it had been edited to
  carry a download address whose file name walked up the folder tree, the downloaded archive
  could land anywhere on that disk on Windows. The archive is now always saved under its own
  engine folder, and the list only accepts secure `https://` addresses.
- **Exported evidence packs carry a content-security policy.** An exported pack opened in a
  web browser now tells the browser to load and run nothing beyond the pack's own embedded
  styling, as a second safeguard on top of the escaping the pack already applies.
- **A slow upload to the local API is cut off.** A client that sent a request body one byte at a
  time could hold one of the sixteen connection slots for as long as it liked. Uploads now have a
  two-minute total limit in addition to the existing thirty-second inactivity limit.
- **Large exports no longer stall the window.** Saving a big chat transcript, audit log or
  document export to a slow USB drive used to freeze the app for the duration of the write. The
  write now runs in the background and the file appears only once it is complete.
- **A held file can no longer make the app lose your newest data after a failed lock.** When
  locking the workspace fails (for example on a nearly-full drive), the app keeps that
  session's newest data as a recovery file and secures it at the next unlock. If another
  program was holding an earlier recovery file open — antivirus or a search indexer scanning
  the drive is the usual cause — the app could previously delete the newest copy while trying
  to set it aside. It now detects that case, leaves your data in place, and **refuses to open
  the workspace until the hold clears** rather than falling back to the older copy. Close
  whatever is scanning the drive and unlock again; nothing is lost. A new message on the unlock
  screen explains this when it happens.
- **Changing the password of an older encrypted workspace no longer strands its image history.**
  Workspaces created with a development build older than 11 June 2026 use an older vault
  format that is migrated to the current one on their first password change; no released
  version ever created one. That migration re-encrypted the database and the document files,
  but not the saved images of the image-analysis history, nor document copies kept at an older
  location, so those became unreadable after the change. All of them are now re-encrypted
  together (copies at an older location only when they are reachable at the time of the
  change), a crash at any point still leaves everything on either the old or the new password,
  and an image being saved while the password changes is refused instead of being written
  half-way. The previous generation of the encrypted diagnostics log is deleted by that
  migration (nothing reads it).
- **Adding a skill is bound to the file picker, and a huge drop can no longer freeze the app.**
  The Settings → Skills picker now hands the app a one-time ticket for the file or folder you chose,
  and the preview and the import only accept that ticket, so nothing but your own pick can be read.
  Dropping or picking documents is capped at 512 items per action, and scanning a dropped folder
  stops after a bounded amount of work instead of hanging on an enormous or looped tree (what it
  reached is imported). Network-share paths are handled as before; a stricter rule for them is
  still under discussion.
- **Locking or quitting during a document preview, re-index, import, dictation or export no
  longer leaves a decrypted copy on the drive.** Those operations decrypt the document to a
  temporary file while they read it. Lock now and Quit used to finish while such a read was still
  running, so the temporary file stayed on the drive (until the next start cleaned it up) and a
  preview started before the lock could still show its text afterwards. Both now stop these
  operations, wait a few seconds for them to finish, and remove any temporary file that is still
  there before the workspace is re-encrypted; a preview that was cut off reports the workspace as
  locked instead of showing text.
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

- **On a computer with a graphics card, the recommended chat model only changes when your
  computer's usual RAM-based pick would not fit on the card.** A model only runs at card speed
  when it fits the card, so the star pick on the AI Model screen and the check on the Performance
  page now check whether the RAM-based pick also fits the graphics card's current free memory
  (with room for the runtime's working buffers); if it does, nothing changes, and if it does not,
  the best model that does fit takes its place. RAM is still respected either way: a model that
  needs more RAM than the computer has is never recommended. The graphics card that counts is the
  single largest one that is not a shared on-chip graphics chip; a shared on-chip chip, and
  graphics acceleration switched off in Settings, are both treated as having no card, which keeps
  the RAM-based pick — as do Apple Silicon computers.
- **Every request from the app window to the main process now checks where it came from.**
  Only the app's own window can invoke the internal commands (opening documents, reading
  settings, running the models); a request from anywhere else is refused before it runs. Nothing
  else can send such requests today, so nothing changes in use — this closes the door before it
  is ever needed.
- **Two small hardening steps with no visible effect.** The app window's content policy now
  also forbids form submissions, plugins, base-address changes and framing in its built-in
  fallback layer, and the settings store ignores inherited object names and caps the size of
  every stored object or list rather than only three of them.
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
- **The user guide now says what an unclean stop costs.** Pulling the drive without quitting, a
  power cut or a forced kill loses the changes made since the workspace last locked or quit; the
  workspace itself reopens fine from that point. The
  privacy notice and the security documentation now also say which small things live outside the
  drive: display preferences in the computer's browser profile, and anything you copy on its
  clipboard.
- **A drive on an unfamiliar computer keeps checking itself until it succeeds, once per unlock.**
  A failed automatic check on a computer this drive doesn't recognize now tries again once each
  time you unlock, rather than repeatedly for the rest of that session; Check again on the
  Performance page always works right away in the meantime.

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
