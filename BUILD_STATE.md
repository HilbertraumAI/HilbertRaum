# BUILD STATE — HilbertRaum

> **This is the handoff/transport file between build steps and sessions.**
> Read this FIRST at the start of every session. Update it at the END of every phase
> (see "Per-phase ritual" in [`CLAUDE.md`](CLAUDE.md)).
> It carries: current status, decisions, next actions, open issues — plus dated entries for
> the **currently-open waves only**. Shared data contracts live in
> [`docs/data-contracts.md`](docs/data-contracts.md) (§4 below is a pointer stub).

> **Retention rule (2026-07-12, reworked 2026-08-20):** this file must stay readable in one
> pass. The 2026-07-12 budget capped the WHOLE file and drained only the dated entries — but the
> dated entries were never what grew. By 2026-08-20 §3 and §5 were **1,574 of 1,968 lines (80 %)**
> and nothing drained them, so a section titled "Next actions (do these next)" held ~540 lines of
> finished work and item 14 sat headed "REMEDIATION IN PROGRESS" for a month while its own body
> said the wave was complete. The budget is therefore now **per section**
> (`repo-hygiene.test.ts`), and the rule that makes it hold is:
>
> - **§5 holds OPEN work only.** When a wave or audit round closes, its item collapses to
>   **outcome + ledger pointer + any residuals that are genuinely still open** — the narrative
>   moves to the durable record and, verbatim, to [`docs/build-log.md`](docs/build-log.md).
>   Item NUMBERS are never reused or renumbered: `§5 item 12`-style citations are load-bearing.
> - **Dated entries** for closed waves move verbatim, newest-first, to the top of
>   [`docs/build-log.md`](docs/build-log.md), as before.
> - **New entries stay short:** outcome + pointers to the design record and commits, not a full
>   narrative — the narrative belongs in the record.

> **Snapshot correction (2026-07-10):** the "UNPUSHED" / "UNMERGED" state notes inside earlier log
> entries were true when written but are snapshots — as of 2026-07-10 `master` is pushed (in sync
> with origin through `ac4f315`) and the 2026-06-30 audit branch stack is merged. Only the branches
> named in §5's branch analysis still carry unmerged work.
_2026-11-11 — **UI languages wave (Russian, French, Spanish, Italian; interface only): PR-A foundation in progress (`feat/ui-languages-foundation`).** P1: a language registry (`shared/i18n/languages.ts`) replaces the closed `'en' | 'de'` type; each language has its own plural rule (en/de keep `n === 1`, new languages `Intl.PluralRules`) and a catalog type derived from its entry; the OS locale matches by primary subtag. P2: every consumer of the closed set goes through the registry: the settings gate and mirror, the doc-task friendly errors and the chat's stale-refusal check (§3.3 Rule 3), the pack language (packs stay en/de), the Translate default pair, the picker (a `<select>` built from the registry), and the lock screen's unlock/create errors (now in the lock screen's language). The registry is `[en, de]`: en/de text unchanged apart from those errors (real-app `innerText` diff against the pre-wave baseline: identical apart from two environment lines, the network indicator and free disk space). The lazy-screen test waits got an explicit bound (a pre-existing flake). P3: the catalog guards iterate the registry (per-language parity, typography, rail labels, plural-form layout, `t` wired to each catalog file; the unused-key guard can't be disabled by an unregistered catalog) plus an AST ban on hard-coded en/de pairs in `src/`; an independent teeth review's gaps closed. P4: five keys whose number agrees with a noun become plural pairs (English text unchanged except "(1 core)" on a single-core machine, owner call), and every key the AST net finds showing a number is now a pair or on a reviewed list whose reasons hold in every language. Owner calls 2026-11-11/12: every catalog complete and typecheck-enforced, packs stay en/de, *System* follows the OS, no review note; English "1 transactions"-type slips in answer sentences → a follow-up. Record: architecture.md i18n record D-L1–D-L3, D-L9–D-L12, §3.1–§3.3, §5; CONTRIBUTING "UI text". Open: PR-A review + CI (P5), then PR-B (the four catalogs)._
_2026-11-10 — **#792 — Dependabot's production group (pdf.js 6.4.299 → 6.5.438, react-virtual 3.14.25), repaired and reviewed before the merge (`dependabot/npm_and_yarn/production-a796742bfe`).** CI failed only on the stale notices (regenerated; they now carry QuickJS's licence, a file 6.4 already shipped without one). The review `dependabot.yml` asks for: the changelog and code diff; a differential over 54 PDFs (byte-identical text on 53, the 54th loses five spaces on one page, bisected to upstream #22350; 482 image decodes pixel-identical); the warning pins; the real-Electron smoke 11/11; a packaged build OCRing a G4 office scan and its JBIG2 twin, with OCR text identical to a pdf.js 6.4 package of the same tree. New constraint: the JS decoder fallbacks only work with their own pdf.js version. Gold set not run (corpus not here). Record: architecture.md DEP-6 §14. Open: none._
_2026-11-10 — **#793 — Dependabot's Electron 43.8.3 → 43.8.6, repaired and checked (`dependabot/npm_and_yarn/electron-43.8.6`).** CI failed only on `packaging.test.ts` (`electronVersion` still 43.8.3); the lockfile is what the pinned npm writes. 43.8.6 brings Node 24.22.1 with undici 7.30.1, closing DEP-8's GHSA-xjj6 residual (a download server could crash the main process); Chromium, V8 and SQLite unchanged, fuse wire `001011001`, first paint unchanged (§5 item 18(g)). A `--win dir` package passed `packaged-app-probe.mjs` (10 checks, OCR from `app.asar.unpacked` among them), after the probe was repaired: it had not loaded since #769. Full suite green. Record: architecture.md DEP-5 §3 "43.8.6". Open: none._
_2026-11-10 — **#795 — `npm test` never downloads Electron; CI makes a test that tries fail at once (`fix/795-test-electron-download`).** Since 2026-09-17 `reranker-callbacks-composition` reached `ipcMain` unmocked, so on every CI leg the real `electron` package downloaded its ~100 MB binary from GitHub mid-run (Electron >= 42 fetches lazily); a GitHub 504 on 2026-11-08 turned four of #791's legs red. Reproduced with no binary and no network: exactly that file failed. It mocks `electron` now, and `ci.yml` points the download at a dead port (`ELECTRON_MIRROR`, `force_no_cache`). The full suite passes in those conditions; the file without its mock fails at once. Record: packaging.md CI section. Open: none._
_2026-11-08 — **#790 — every spawn site gives each piped stdio stream an `'error'` listener; the GPU probe reads a failed stdout as no answer (`fix/790-child-stdio-guard`).** A piped stream can emit an `'error'` of its own, and unhandled that is a main-process crash; #789 guarded kiwix-serve only. Measured in Node 24.13 and Electron 43.8.3 (12 spawn failures, both stdio shapes): only a `cwd` of MAX_PATH or more reaches it (libuv opens the pipes after the cwd step), no other site passes one, and Windows caps the inherited cwd at 258 characters, so this is hardening with no trigger reaching those sites today.
Now `guardChildStdio` (`runtime/sidecar.ts`) is called by `LlamaServer`, the GPU probe, the engine check, whisper-cli and kiwix-serve. Owner calls 2026-11-08, as recommended: a probe whose stdout failed resolves `null` (an exit 0 could persist a cut list as "no graphics card"); a started child's failed pipe is logged with its code only; a repo-hygiene rule lists the modules that spawn and wants the guard per piped spawn. Review: the engine check likewise reads `unchecked`, not `loads`, when its stderr failed before an unrecognised exit.
10 new rows, all failing on master; 21/21 mutations red. Real binary (b9849 from D:): the guard on a real late failure, both shapes; the probe, the engine check and an e5 start log no pipe line. The dev app (scratch root, D: junctions): the probe found the card, a 4B chat ran on it, clean quit, no pipe line. Records: architecture.md "Engine load failures" §12; rag-design.md §17 D-Z1 "#787 amendment". Open: none (whisper-cli not run on a real binary, none on this machine; macOS/Linux by source reading)._
_2026-11-08 — **#787 — on Windows each kiwix child gets an ASCII command line wherever one exists, so packs work under a non-ASCII drive or app-data root (`fix/787-kiwix-non-ascii-paths`).** libkiwix decodes the ANSI narrow argv as UTF-8; it reads a relative path through the wide cwd exactly. Measured on the real 3.8.1 (win, and linux in WSL): the issue's sketch, a relative library alone, still failed for the drive's own `zim/` folder (its archive path is non-ASCII too). Owner calls 2026-11-08: the bare-name launch on every platform; the archive's folder as a second cwd was taken, then dropped after review (Windows searches the cwd for DLLs; the build needs the unbundled Visual C++ runtime, #530).
Now `zim/argv.ts` plans each spawn: the cwd is always the library's own folder, the library by its bare name, a non-ASCII archive relative to it when that is ASCII; no ASCII spelling (a non-ASCII file name, a non-ASCII folder outside the app's own) → `KiwixManageError.nonAsciiArgv`, which `path-unsupported` and the `manage:exit:non-ascii-path` log class key on (`exit` only). Found and guarded: a `cwd` over MAX_PATH made Node emit an unhandled `ENOTCONN` on kiwix-serve's stderr pipe, a main-process crash (reproduced in Electron 43.8.3); both commands spawn absolute. Copy EN/DE reworded.
21 rows fail on master, 17/17 mutations red; the app's service on the real binaries (two served non-ASCII layouts, two refusals); the dev app under `…\Jürgen 山田\…\HilbertRaum`: master skipped `zim\example.zim` (`manage:exit`), the fix registered and searched it (9 admitted), kiwix-serve's OS argv `--library library.2.xml`, `zim-transient` empty after quit. Records: rag-design.md §17 D-Z1 "#787 amendment"; known-limitations.md; data-contracts.md `path-unsupported`. Open: none (a network-share root is not measured, documented); the other spawn sites: #790, fixed by the #790 entry above._
_2026-11-08 — **#712 — a failed kiwix-serve start is logged as its class, never with the path kiwix-serve printed; its bind-race retry fires again (`fix/712-kiwix-start-error-paths`).** The start error ended in kiwix-serve's stderr, which names the library file it could not load (`<workspace>\zim-transient\library.<n>.xml`); the session pass, Refresh, the post-install reconcile and every ask under the latched revision logged it. Reproduced on the real binary and in the dev app (the issue had read the sources); the root is in the log anyway (`Workspace resolved`), so what broke was D-Z1's rule, raw tool output in the log and one copy per ask.
Now `KiwixServeStartError` carries the kind, codes and a class of the output (`library-unreadable`, `port-unavailable`, `unrecognised`, `none`), `KiwixManageError` likewise, and every knowledge-pack log line goes through one `zimErrorClass`. Found beside it and fixed: kiwix-serve's bind failure never matched the shared `isBindRaceError` wording, so its one retry never fired and a lost port latched packs off (the fake carried llama-server's text). Measured, documented, not fixed: on Windows any non-ASCII character in the drive or app-data path makes both tools fail.
The class is read once the child's pipe has closed (#530's bounded wait; review finding). 18 rows fail on master, 23/23 mutations red; the app's `KiwixServer` on the real binary and the dev app (session pass, Refresh, an ask), master vs fix. Records: rag-design.md §17 D-Z1 "#712 amendment"; known-limitations.md. Open: none; #787 is fixed by the #787 entry above._
_2026-11-07 — **#729 — the llama.cpp pin moves to b12110 (v0.9.0); `llama-connect` is never installed (`feat/729-llama-cpp-b12110`).** b11146 kept a context checkpoint at position 0 across requests, so a Gemma 4 request opening with a user turn was prefilled in other batch shapes after an unrelated one (upstream #30666): on the GTX 1070 Ti b11146 changes R after X, b12110 never. Owner calls 2026-11-07: v0.9.0 not v0.8.0, merged no earlier than 2026-11-11, the gate on this box's models, an N-prompt mode for the cache smoke.
Every archive now carries `llama-connect` (the `--connect` tunnel): `neverInstalled` (`assets.ts`) removes it in the in-app installer and both `fetch-runtime` twins (any case, a dangling link too, and on a twin's skip path), and the sell gate refuses a Kit holding one anywhere; 16/16 mutations red after a review pass. Against b11146: the gate identical on EM / citation / grounded / abstention (5 models, the 14B included), auth, error bodies, E5 (cosine 1.0), rerank (±0.004), SSE shape and pings, non-ASCII paths, the smokes, 30/30 cache restores; Gemma 4 E2B prefill 2.5× faster, decode 1–4 % slower; a processor start's CPU-side weights now match llama.cpp's breakdown. Records: architecture.md GPU §3 "PIN BUMPED 2026-11-07", model-benchmarks.md §6.6 "#729 amendment", model-policy.md b12110 record.
Open: a non-commercial drive whose current install already holds `llama-connect` keeps it in the app until reinstalled (documented); the MTP draft-acceptance drop, #800 (rig legs done 2026-11-10 on the i9-9900X / RTX 3090: qwen3.6/3.8 cache restore PASSED 20/20 ×3; the 27B MTP start passes 66/66 but accepts 0.697 against b11146's 0.754, decode with MTP −4.4 %, without MTP unchanged; model-benchmarks.md §6.6 "Rig legs"; owner call 2026-11-11: shipped in v0.1.65 with the cost recorded, re-measured at the next pin bump), the macOS asset (the other five models' gate and the bring-up smoke are done: PASSED 2026-11-10 on the i9-9900X / RTX 3090 box instead of ps-work, model-benchmarks.md §6.6 "Second-machine leg"); Windows 10 before 1903 with exotic path characters (known-limitations.md, not measured); from #730: `/etc/llama.cpp/config.ini` (documented), the AMD/Intel, Linux and macOS GPU legs._
_2026-11-04 — **#782 — switching internet access off stops a running download or install (`fix/782-network-off-stops-jobs`).** The switch says "When off, the app makes no internet calls", yet the three downloaders read their gates only at the start, so a model, engine or OCR job kept fetching under a **Local · Offline** indicator. `settings:update` now reports each real flip of the switch to each manager's `networkSwitched` (one shared `NetworkSwitch`): a transfer stops at once, a job in its local check or extraction runs on and stops at its next request unless the switch is back on first (a fully downloaded model still installs), a start that planned across a switch-off still in force is refused. A notice says so (`ctx.runtimeNotice`, the AI Model button); the model card reads `stoppedBy`.
Owner calls as recommended (on #782): stop; network part only; notice, no confirmation; a mid-session policy edit is documented, not handled. Found and fixed: an engine job stopped while `queued` read as failed. Review: switching back on now withdraws a stop not yet due, and a start across off → on goes ahead. 24/24 mutations red, control green; full suite 479 files / 9,253 passed (master 9,225). A lock still leaves jobs running (BE-2).
Records: architecture.md "In-app model downloader" #782; data-contracts.md `networkSwitched`, `stoppedBy`; known-limitations.md; security-model.md "Detection-only"; PRIVACY.md; user-guide §10. Open: none._
_2026-11-04 — **#758 — the offline tripwire asks at every remote connect whether the app is offline (`fix/758-tripwire-live-posture`).** It was decided once in `initBackend`: an encrypted workspace starts locked, so the guard stayed armed after the unlock and recorded every download the user accepted; a plaintext workspace online at startup was never watched, even after its setting went off. Both reproduced on master in the real app, the first through the real downloader. Now installed for the session; `isOffline` is read at the connect, loopback first, a throw counting as offline, through `currentPolicyStatus`, which `getPolicy` returns too (a locked workspace reads as offline).
Owner calls as recommended: locked = offline, so a download that outlives a lock records its new connections (documented); switching network off does not stop a running job → #782. 9/9 mutations red, control green. Real app (dev build, scratch roots): encrypted, the accepted download not recorded, no vault / network off / locked recorded; plaintext, online not, offline recorded; a real 4B chat online and offline, no loopback row. Full suite 479 files / 9,225 passed (master 9,222); the real-Chromium PDF smoke ran with the guard silent.
Records: security-model.md §2 "Offline is read at the connect" and "Detection-only"; known-limitations.md (the old "accepted edge" claimed a restart helped, never true on an encrypted workspace); data-contracts.md `currentPolicyStatus`. Open: none; #782 is fixed by the #782 entry above._
_2026-11-03 — **#779 / #768 / #743 (+ #734) — the chat + RAG router's leftovers, the catalog and download-dialog defects, every listed chat-ui gap (`fix/779-768-743-leftovers`).** #779: with no model running the memory meter fills against the window the next start launches with (`contextWindowOrNextLaunch`, one spelling shared with the doc-task budget); an aborted re-ask resolves with its restored answer, so `chat:done` carries it (a Stop while parked behind a deep-index build still sends an empty one: nothing was deleted, and nothing reads `done`);
a fence-only skill is no longer offered on the fixed no-context reply (a skill whose engine engages still is); rows a pre-#737 create lost get no repair (owner call: no handed-out build can be in that state, rag-design.md §11). #734 folded in (owner call): the coverage listing and the template answer record `skipped / mode`; the D45 refusal and the W2 routing answer record none. #768: disk sizes are decimal GB with one decimal everywhere (`shared/format`; the dialog offered "13 GB" for a 14.4 GB card, and documents, images, OCR and packs counted in 1024s too);
a model download that cannot fit is refused before any job or request (no headroom, owner call; the two figures never read alike); the withdrawal notes name their successor; the Gemma stubs are `pending` and their notice lines stop promising a URL; the vision manifest declares both `size_bytes` (HF LFS metadata, OIDs equal the pinned hashes), and the dialog sums a model's files. #743: all 21 boxes pinned at their owners or proven pinned, each row red under its mutation;
MessageBlock's memo without an export; `groupByProject`, `ProjectSection` and `LIST_AUTO_COLLAPSE_PX` lose their dead exports; one `matchMedia` fake. Owner calls as recommended. Full suite 478 files / 9,222 passed (master 9,146). Real app (dev build, GTX 1070 Ti, the 9B selected; master on the same setup): the no-model meter read 4096 then 8192 once started on master, 8192 both here; the 26B button offered 13 GB on master, 14,4 GB here; a 1 PB download onto D: (37.6 GB free) started a job on master, here was refused before any job. Records: rag-design.md §11, the #80 cascade, D-Z4; architecture.md §5.2, the #600 guard, the downloader; data-contracts; model-policy.md; design-guidelines.md "Disk sizes are decimal".
Open: Images' picker-open failure reads the decode-failed copy (left unpinned: wording); the stubs still list as uninstallable catalog entries (accepted); a vision model with only its projector missing offers both files' 3.3 GB in its dialog while the job fetches 1.3 (errs safe; master shows the card's 3.3 too)._
_2026-11-03 — **#767 / #769 / #770 (+ three of #768) — the models-drive campaign's twin defects are fixed, its listed gaps pinned, its doc drift corrected (`fix/767-769-scripts`).** All nine open #767 defects reproduced on master, both legs, and are fixed: the `.Count` that let a model with one absent `files:` member past the license gate and the withdrawn skip,
`--only` naming nothing, tab-collapsed `files:` records, the empty `--generate`, a manifest with no runtime, a projector's `size_bytes` deleting the primary's resumable partial, the gate tool's `--json`, BSD `seq`, and a `[` in the drive root (non-literal paths across all five drive `.ps1`; PS 5.1 also ignores `-Include` beside `-LiteralPath`). Found beside them and fixed: half a download pair is a BLOCK (owner call: continue, exit 1),
not a GGUF the app never lists or another file's URL in the GGUF's path; `fetch-runtime.ps1`'s bare `tar` (Git's GNU tar from a Git-Bash shell), the `.sh` tar on a drive letter, a total tar failure blamed on the layout, a link member escaping the extract dir; the `.command` cache published with no `.app`; `-AppArtifact` checked after the downloads, and never split in the `.ps1`; a failed `gh` call dropping issues from the release notes; zim notices stopping at a CR.
#769: every script row runs on a `Kit [1]` root; real `file://` downloads and archive installs on both legs (`script-fetch-models`, `script-fetch-runtime`), `script-orchestration`, `zim-notices`; the THIRD-PARTY-NOTICES byte gate; flag parity; download hosts and runtime hashes held to model-policy.md; release.yml checks the packaged asar, notices and fuse wire after `package:win` (owner call). Owner calls as recommended:
`planCommercialDrive` deleted, the caret row dropped, TranslateGemma's `pending` pinned, a peer-only package fails closed. About 200 mutations red. Two incidents shaped the harness: a pre-fix `fetch-models.ps1` on a bracketed root fell back to the repo catalog and started a real 1.6 GB download (killed), so download rows run `isolatedScripts()` behind dead proxies; Norton quarantined a copy carrying a
`WebClient` download line (IDP.HELU.PSD11), so the `.ps1` fetchers require curl.exe and carry no PowerShell download line (owner call; script-drift holds it). Records: packaging.md scripts table, "Extracting a runtime archive (#767)", the build-win step; model-policy.md "Download hosts (#769)"; data-contracts.md `assertCommercialDrive`.
Open: none; #768 is fixed by the #779/#768/#743 entry above._
_2026-11-03 — **#736 / #737 / #733 / #738 — the chat + RAG campaign's follow-ups: a tree route the deep index cannot answer is labelled as top-k, a keyword index is created in one transaction, every listed gap is pinned (`fix/736-737-chat-rag-router`).** #736 was one of five shapes: the router picks `tree-summary` whenever a ready deep index is in scope, but the tree answers only for ONE answerable document, no packs, its own usable tree; elsewhere top-k answered as a confident tree answer, so "Fasse jeden Abschnitt zusammen" lost #641's heads-up and the #80 classification (a re-indexing or failed document, a second indexed document with a deep index, a pack chat, a degenerate tree). Such a turn is now labelled and classified as without the deep index; the tree count reads indexed documents; both sides of the heads-up's section count read the indexed documents (a failed re-index's old sections hid it).
#733: no document-skill offer without an answerable document, no classification with no section in scope and no pack. #737: every box pinned at its owner, each row red under its mutation; the meter's copy of `effectiveContextWindow` and `MAX_REDUCE_CONTINUATIONS`' export are gone. Its suspected defect was real and wider: a fresh keyword index committed statement by statement, so a kill during the fill of a pre-v0.1.3 workspace lost its older rows from keyword search for good; each create is one transaction now, and the heal check reads all five triggers. #738 and the drift beside it fixed; #743's ask-site box.
Owner calls as recommended (the route actually taken; indexed documents on both sides; atomic create + full check; one PR). Real app (4B, GTX 1070 Ti): a two-document chat with a deep-indexed 12-section report read 4/13 sections with no heads-up on master, with it here; documents off: master offered "Meeting Minutes" on the no-context reply, here no offer and no model call.
Records: rag-design.md "A tree route the deep index cannot answer" (#736), §11 "One transaction per index create"; architecture.md #133 (#733), CODE-4 correction. Open: none; its three residuals became #779, fixed by the #779/#768/#743 entry above._
_2026-11-03 — **#745 — the chat-ui campaign's leftovers: the suites outside it run on its helpers, a test-only seam and two copies are gone, one drop zone (`test/745-chat-ui-leftovers`).** Nine ChatScreen suites and GermanSmoke's two chat rows use `chatScreenStubs` and end on
`assertNoUnexpectedApiCalls()` (494 `stubApi: unmocked` warning lines → 0); five transcript suites render through `helpers/transcript`; the lock suites and GermanSmoke take typed vision fixtures. `resetReviewSessionForTests` is gone (`purgeReviewSession()`, after `cleanup()`). `ImageDropZone` / `TranslateDropZone` are one `components/FileDropZone`; `STREAM_FLUSH_MS` is
shared from `lib/polling.ts`, as is the attach poll's `ATTACH_POLL_MS`. CR-5 fails the re-select's own fetch; #743's two re-select guards are proved apart. Owner calls as recommended: visionSession's blank-`done` branch stays, and main's blank-answer rule is now pinned (images-ipc); no `jest` shim (measured: it frees `findBy*`, not `userEvent`; CONTRIBUTING says so); #744's last four
bullets fixed here. Mutations found the Translate zone's busy wiring unpinned (now pinned). No behaviour change. Open: the `window.api` `?.` tolerance in ChatScreen (28 sites), DiagnosticsTab, WorkspaceGate, `useOcrInstall`, visionSession (#749/#755's residual; ChatScreen's suites now all stub what it calls)._
_2026-11-02 — **#742 — the chat screen's five small defects from the chat-ui campaign are fixed (`fix/742-chat-screen-defects`).** The memory meter's tone and heads-up read the percent
it shows (74.6 % said "75%" calm). A file dragged over a chat that is answering, or still adding a file (the twin the issue missed), is refused with the no-drop cursor instead of dropped without a
word. "Send again" stays shut after the recovery poll's sustained failure (CH-4). The "Stopped" toast skips a send that failed. `persistAssistantMessage` never stamps "Reply stopped" on a truncated
reply: unreachable today (only microtasks separate a stream's end from its persist), now by construction. 7 new rows fail on master, 4 mutations red. With #743's failed-Stop row and #744's meter and
toast-comment bullets. Records: `architecture.md` FE-C "#742", CB-5 #613/#612; design-guidelines §11.9/§11.21; data-contracts `ended_early`. Open: none._
_2026-11-02 — **#766 — a Kit preloads its bundled set and lists the rest for in-app download; the sell gate checks what the Kit ships (`fix/766-kit-bundled-set`).** The gate demanded every manifest VERIFIED and approved (310 GB over 31 manifests), and TranslateGemma's deliberately `pending` review blocked every Kit for good. Owner call 2026-11-02, as recommended: a model ships when it is bundled (`bundled_on_preconfigured_drive`, now parsed) or has any file on the drive; each shipped model must verify and be approved, at least one must be bundled, and the rest is catalog.
Step 2 fetches `--bundled` (3.2 GB: Qwen3 4B, E5 small, Whisper small) and fails when that plans nothing; the pre-flight runs `verify-models --kit`. Same rule in `assertCommercialDrive` and both twins; 34/34 mutations red over two runs (controls green), both legs. Record: packaging.md "What a Kit ships". Open: the three `local-unverified` stubs ride every drive, a Kit now included, as uninstallable catalog entries (#768's "non-real hash keeps them off a sold drive" no longer holds)._
_2026-11-02 — **#765 — `build-commercial-drive.sh` reaches its verdict with the committed OCR files (`fix/765-builder-ocr`).** `check_ocr_file` ran its own `=~` between the caller's match and its `BASH_REMATCH` read, so the second OCR file, or a key after the `ocr:` block, ended the script under `set -u`; it now tests the hash with `grep`, which leaves the capture alone and keeps the one spelling of the real-hash regex, and hashes from stdin (#767's filename-hash item: a backslash target read every file as a mismatch). Four SELLABLE rows (one, two, the committed three, a key after the block), and a `script-drift` row that finds the shape in every script. Open: none; #766 is fixed by the entry above._
_2026-11-02 — **Models-drive campaign, part 2 — the catalog, the shipped scripts and launchers, the notices and the packaging config (`test/models-drive-2`).** No row had ever reached `SELLABLE:`, `fetch-models` had no execution row, and the default-set parity row compared 1 id of 5 (its parser stopped at a `)` in a comment). Now `fetch-models`, `fetch-runtime`'s refusals and the builder's verdict run on both legs, the chat manifests are one facts table plus rules, and `repo-files`, `catalog` and `script-legs` replace five spellings of each reader. `launcher.ts` (no caller since Phase 13) and twelve other seams are gone; no behaviour change.
281 → 431 tests in the 11 files; 241 lane mutations and 163 review reruns, every green a planned control; preservation review on another model: no contract lost. `script-legs`' child kill now widens on CI (#458): under 16 parallel runs the gate tool never passed 2.1 s, so the `status: null` runs were a starved runner, not a hang. Real asar joins packaging.md's manual checklist.
Open: the catalog and notice defects of #768. The twin defects (#767), the gaps (#769), the doc drift (#770), the step-7 crash (#765) and the sell gate the committed catalog could not pass (#766) are fixed by the entries above._
_2026-11-02 — **#752 — the models-drive campaign's seven defects are fixed (`fix/752-download-defects`).** Cancel stops the verify hash, so `activeJob()` is held until the run settles without refusing restarts for minutes; the card's Cancel was disabled in `verifying` since Phase 18, so BE-4 was out of reach until now. Failure copy and the audit `reason` carry no paths, and a resume is promised only with bytes on the drive; a complete `.part` is fsynced before it settles; an abandoned hash leaves the map at the abort; a failed engine install leaves nothing installed; a policy warning waits for a reader that can hear it.
Owner calls as recommended: the validator refuses half a vision `download` pair, both ways; two new EN/DE messages. Real app, master vs branch, a real 2.4 GB hash: 80 s after a cancel vs stopped at 1.3 s; a path with the user's name in copy and audit vs none. Record: architecture.md "Mechanics", "A failed install leaves nothing installed"; model-policy.md vision rules.
Open: `main.engine.interrupted` still carries a raw reason (no false promise, no audit record); past the 5 s close bound a stalled stream can overlap the next run (the SHA-256 still guards it); `flushToDevice` blocks the main process, as it always did; #758 is fixed by the #758 entry above._
_2026-11-01 — **#753's last box / TS-7 — the suite runs on a Mac at PR time; `macos-14` is gone (`ci/753-macos-leg`).** No test had ever run on a Mac: `build-mac` packages without `npm test`. New `macos 24.x` leg (`macos-15`, unsharded, 6.7 min). Its first run: 8,855 passed, 1 failed, a fixture assuming an x64 host, not a product bug. With #762 on top: 473 files, 8,869 passed, the 17 `.sh` rows under stock Bash 3.2 among them.
The very first attempt was cancelled by a brownout: GitHub retires `macos-14` on 2026-11-02 and `build-mac` used it, so the next release would have failed at the Mac build. Both now use `macos-15`, pinned and shared, so the next retirement shows on PRs months before a tag; release pre-flight green (run 41351784698). Record: packaging.md CI section. Open: packaged-app checks on a Mac stay manual; a brownout reads as a cancelled leg and a red `ci-success`, not a test failure._
_2026-11-01 — **#753 / #754 — the models-drive campaign's listed gaps are pinned at their owners, its doc drift is fixed (`test/753-models-drive-gaps`).** Every listed mutation stayed green on master and is red here (23/23, control green), the two `missing` branches and the hash store's live handle included. The engine's cancel-during-the-hash row passed with both of its guards deleted: `runToEnd` polled a status `cancel()` flips at once. One shared `runToEnd` now waits for the run too (engine, OCR). `download-fail-close`'s probe is keyed by path, so its rows stop covering for each other, and the shipped 5 s bound is pinned on fake timers from both sides.
No behaviour change. Production: `variantGroupOrder`'s dead guard and one comment; real app (built, the committed catalog): 34/34 models render once, every group expands, no exception. #754: every box checked against the code, three were already right; found beside them and fixed: `parsePolicy`'s and `buildPolicyStatus`' signatures, SEC-2's placeholder line.
Open: none; #752 and #758 are closed by the entries above._
_2026-11-01 — **#747 / #746 / #748 — the perf campaign's rest: the step list ends with the run, Apple Silicon honours the GPU flags, every listed gap is pinned, the docs say what the code does (`test/747-perf-gaps`).** #746: `doneSteps` outlives the run and the list rendered on it alone, so every check with no model up left "Generation speed (no model running, skipped): in progress" with `aria-current` on the idle card (real app, GTX 1070 Ti, master 3 items, the fix 0, with and without a model); a failed run left its step too (not in the issue). On a Mac the GPU flags stop the ladder but not `nextStartMemory`: class stays `unified`, `cpuForced` and a null device follow the flags, `buildPlacement` and the speed sample ask one `nextStartUsesGpu`; card lines need `discrete` (#332 settles that call). No change on Windows or Linux by construction. `buildReport` survives a record with no warnings.
#747: every box pinned at its owner, 82/82 mutations red; `VisionRuntime`'s real flips had no row either. `persistGpuFailure` moved into `createGpuFailureRecorder` (name kept, citations stand): its write is what ends a crash at one restart. `initBackend`'s subscriptions take `answer-speed-wiring`'s source pin. The `performance_get` row reads its log with the real `--log` script. #748: all but one box fixed; `registerBenchmarkIpc`'s comment was already right; #754's moved-drive line with it.
Record: benchmark.md "#746: the list ends with the run", "Next start, not hardware". Open: no Mac has run the Apple rows (#332); a foreign run that takes the span before the screen's idle read sees no edge, so our finished list stays up for that run (pre-existing, narrow: the read's round-trip)._
_2026-11-01 — **#739 — the chat + RAG campaign's leftovers: the window and `sendTimings` are required, `ANY_SENDER` is out of `src/main` (`test/739-chat-rag-leftovers`).** `buildChatMessages` and `buildGroundedChatMessages` require the window, `sendTimings` is required, `ANY_SENDER` lives in the test harness and `repo-hygiene` now refuses it anywhere in `src/main`, three dead exports. Copies: four `seedDocument` (one the issue missed; they stored word counts, production stores `approxTokenCount`), two `throwingRuntime`, `seedReadyTree` in four suites, one SSE helper family that keeps each builder's chunk boundaries; two rows moved home.
Kept: `benchmark.test`'s `throwingRuntime` (fails after a chunk, #393); `data-layer-hardening`, `document-delete-derivatives`, `whole-doc-analysis`, `rag-whole-doc-tree` tree seeds (other shapes). No behaviour change; one new row pins `onTimings`, a wire nothing tested. 24/24 mutations red; `wave3.realmodel`'s two tree rows pass on the real 4B.
Real app (4B, GTX 1070 Ti): chat, speed payload, context meter, regenerate, document ask, every screen: 18/18, no `TypeError`. Open: none on #739; `withChatStream`'s `acquireSlot?` is the same kind of seam (all 8 production calls pass it, 19 test calls omit it) and was not on its list._
_2026-11-01 — **#749 — the perf campaign's leftovers: the start, occupancy and engine-verdict reads lose their test-only `?.`, and the copies move onto shared helpers (`test/749-perf-leftovers`).** Gone: `beginStartRequest?.`, `isShutdown?.` (both sites), `invalidate?.`, `snapshotRerankerOccupancy`'s `status?.`/`active?.` and its three optional fields, `useEngineProblemsRead`'s `?.`, `settleMovedDriveNotice`'s dead guard (a narrower return type now proves it), three dead exports. Folded in: #739's occupancy box and GPU-fixture box (`gpu-fixtures.ts`; of the 23 hand-written card literals 11 were exact copies, the rest stay as their own captures; 9 catalog paths).
No behaviour change. A census of tests reaching a read without the member: 234 hits on master, 0 here (its control fires), so no catch-all hides a `TypeError`. 19/22 mutations red; two gaps got rows (`useEngineProblems.test.tsx`), the third is equivalent (a persisted run clears the notice first). Real app (4B, GTX 1070 Ti): start, chat, document ask, benchmark, Try GPU again, recheck, every screen twice: no exception, no `TypeError`.
Kept on evidence: `Transcript`'s `answerSpeeds?` (the preview is a real caller), `rerankerDemoted?` (two of three callers cannot read the latch). `stubChatRuntime` gained `finish`: its `'length'` reads as a cut-off locate reply, which no occupancy row can see. Open: the same tolerance on `isStarting`, `isGenerating`, `unlockEpoch`, `occupancy`, and in `useOcrInstall`, ChatScreen, DiagnosticsTab, WorkspaceGate._
_2026-11-01 — **#755 / #751 — the models-drive campaign's leftovers are done; the offline tripwire sees plain HTTP (`test/755-models-drive-leftovers`).** #751: `net.connect`, `http.request` and plain-http `fetch` hand `connect` Node's normalized array, so the guard read no host and only TLS was seen. Fixed, pinned through the public APIs; the four evidence suites' proofs stay clean.
Real app (Electron 43.8.3, offline policy, a real 4B chat on the processor): the old guard flagged 2 of 5 remote routes, the fix 5 of 5 and no loopback call. Gone as dead or test-only: `planPrepareDrive`, `PreparePlan*`, `driveLayoutDirs`, `fetchAndVerify`, `buildModelList`'s `profile`, `checkOutboundHost`, `_resetBinaryVerificationForTests`, the Models memory's `seed` (preview takes the #314 adopt path, screenshots byte-identical), Home's and Models' `?.` tolerance.
Shared: new `app-shell`, `binary-fixtures`, `seeded-db`; two timezone traps fixed; 18/18 mutations red. Owner calls as recommended: #751 in this PR, `planPrepareDrive` now rather than in part 2, the tolerance out with #745's shell stubs. Kept: `registerDownloadIpc`'s `manager?` (`registerEngineIpc` has the same; rows need the instance).
Items of #745, #749, #753 and #754 close here. Open: the same tolerance in ChatScreen, DiagnosticsTab, WorkspaceGate, `useOcrInstall` (not in #755; `useEngineProblems`: #749, above); the tripwire was decided once at startup, so it logged a consented download after an unlock (#758, fixed by the #758 entry above)._
_2026-10-27 — **#716 — the planner's 12 s bound on a processor: measured and kept; the real-tools smoke starts llama-server the way the app does (`fix/716-planner-cpu-budget`).** The issue's 2-of-6 timeouts (qwen3.5-4b, i9-14900K) came from the smoke's launch: llama-server's default 24 threads and `-ngl 0` beside a graphics card. The app's processor start (`--device none`, 16 threads) took 5.8–10.1 s, 0 of 34 past the bound; the cost is decode (64–92 tokens at ~10 tok/s, 32 of them qwen3.5's JSON indentation).
Owner calls, taken in turn: keep a cut-off plan's finished entries, then write the queries first — each measured on the smoke at an emulated 2.4×/4× slower processor and dropped (list 2/6 either way, the same as no plan; queries first pushed 3 of 6 plans past the bound); a whitespace-free grammar garbled 5–6 of 17 plans. The owner's fallback: document. Record: `rag-design.md` §17 "The twelve seconds on a processor (#716)". Open: a processor ≳ 1.2× slower than the i9 loses qwen3.5-4b's longest plans._
_2026-10-27 — **#711 — a knowledge-pack article's title keeps the archive's spelling, without #488's sup/sub markers (`fix/711-title-markers`).** The first heading is the citation, the viewer's heading and the per-pack dedup key; since #488 German DISPLAYTITLE formulas read `CO_2-Steuer`. Owner call as recommended: the heading that becomes the title is written without markers (later headings and prose keep them); folding the finished title was refused (`snake_case` → `snakecase`).
Stage A: 1 of 949 / 1 of 1,024 articles, its title only (`δ^18O` → `δ18O`); 488/488 of seven other archives identical. Acceptance read: all six floors pass, delivery identical to master's (109 / 151 / 151, same chunks 200/200). The same night's master read discharges #662's and #673's owed reads (all six pass). Record: `rag-design.md` §17 "#711". Open: none._
_2026-10-27 — **#715 — every coverage gap the October ZIM test campaign listed is pinned at its owner (`test/715-zim-coverage-gaps`).** New rows: `packs:add`'s not-a-zim / tools-missing / manager reasons, reconcile past a bad header, `suggestTitles` parsing, the grounded-data pack outcome, `packs:changed` from main through the real preload, the article-save holder, the post-install reconcile's lock guard and AbortError, the latch's abort belt, the top48 cap wiring, the head-noun probe bound, the shipped kiwix kill / health / manage bounds on fake timers; the source-bundle installer end to end into its gate, the notices script's parser mirrored, one shared import resolver for the perf and word-check scripts, a perf-script load smoke.
The broadcast moved to `ipc/packs-notify.ts` and isolates each window (a throwing renderer could fail a pack change after its write). Each new row red under its mutation. Left: the route-F ruling on a multi-word plan title's rank-0 hit (owner), three shadowed guards (`getArticle`'s post-read assert joins the two recorded); OCR's reset seam belongs to an OCR pass._
_2026-10-27 — **#713 — a transient kept for a kiwix child whose stop was not confirmed goes the moment that child is seen to exit (`fix/713-kept-transient-release`).** It stayed until the next app start, through any number of locks and unlocks (plaintext pack titles and paths in `zim-transient/`).
Now the serve child reports itself (`onUnconfirmedChild`) and a manager child its `'uncertain'` error, each with its own terminal event; the service keeps the path, counted per child, and on the last observed exit removes it through the contained cleanup scoped to that entry. A failed start and a library build with an unconfirmed manager keep their file too (both deleted it under the child). `lastStopUncertain`/`unconfirmedChildren()` gone; the report's `unconfirmedChildren` counts serve and manager children still unconfirmed.
Owner calls as recommended (release on the exit event, not a PID probe; remove at once). 5 rows fail on master; 8/8 mutations red. Record: `rag-design.md` §17 D-Z8. Open: none._
_2026-10-27 — **DEP-8 — Dependabot #708–#710 repaired and merged; the ten alerts opened the same day fixed: #131–#139 in the lockfile (`fix/dep8-alerts-131-139`), #130 by Electron 43.8.3 (`fix/dep8-electron-43-8-3`).** #710 (vitest 4.1.12,
alerts #128/#129): Dependabot installed vitest under `apps/desktop/node_modules`, so jest-dom could not import it; the pinned npm 11.6.2 redid the four bumps in one install. #709: notices regenerated; the streamdown 2.7.1 render comparison: finished output identical,
link references resolve while streaming. #708: `electronVersion` 43.8.0, merged after #710 with the bump redone (exact version: a caret picks the newest 43.x). undici 6.29.1/7.30.1 and fast-uri 3.1.9: build and test tools only, lockfile only. Electron 43.8.3 blocks
the compromised eMudhra intermediates in Chromium and Node TLS (the app downloads through Node's `fetch`); fuse wire unchanged, first paint unchanged. Record: architecture.md "Dependabot triage — design record (wave DEP-8)", DEP-5 §3, DEP-6 §5/§13. Open: the packaged perf-log A/B (§5 item 18(g)); Electron's Node bundling undici 7.29.1 (GHSA-xjj6) is fixed by the #793 entry above._
_2026-10-15 — **#701 — a streamed `$$ …` formula typesets as it arrives; a `$$` pair on lines of its own is display math with all its TeX (`fix/701-display-dollar-math`).** A dangling `$$` went to remend's own katex handler, which
appends the closer without a parse check: KaTeX's error box until the TeX parsed. It now takes the `\[` / `\(` / `$` path (`completePartialTex`, or hidden for that flush). Found on the way, in persisted answers: TeX on a `$$` fence's
opening line was dropped as "meta", TeX glued to the closer kept the block open (`\end{aligned}$$`: a permanent error box), a one-line `$$ x $$` paragraph was inline; while streaming, a `[` in a formula became remend's unfinished
link, `\\[2pt]` was read as `\[` (hiding the rest of the answer), and a `\[` formula left its list item. 28 rows fail on master; 17/18 mutations red (the 18th has no visible effect). Real app (4B, GTX 1070 Ti, dev build): master showed the error box in 6/28 and
33/51 streaming samples and settled inline and as a permanent error box; the fix 0/27 and 0/51, display both. Record: architecture.md chat "Display `$$` and the live bubble (#701)". Open: an environment or `\left` streams hidden until it closes._
_2026-10-14 — **#673 — German Wikipedia's sister-project links and legal-topics notice leave the article text; its authority data becomes a segment of its own (`fix/673-wikipedia-boxes`).** On 1,500 sampled pages
`div.sisterproject` (394 pages, 4,187 words), `div#Vorlage_Rechtshinweis` (16, 96) and `div#normdaten` (227, 1,549, always the last text, mostly in `Einzelnachweise`) were delivered as article text. Owner calls as
recommended: the first is a furniture token, the second dropped by id, the third a `Normdaten` segment where the box stands, on the ordinary text path (a review pass moved it off the license line's side channel). The viewer now drops only a heading's own line
(it cut ` (Person): GND`, and a real word on 14 other sections). 2,672 pages: 2,182 byte-identical; the 490 with a box read master's words with the boxes cut (490/490), Normdaten words exact (227/227); lead unchanged;
chunks +229. Real app: master filed all three under `Einzelnachweise`/`Weblinks`, the fix as designed. Record: `rag-design.md` §17 "#673". Acceptance read 2026-10-27 (master, with #662's): all six floors pass. Open: none (residuals there)._
_2026-10-14 — **#698 — the renderer bundles KaTeX once (`fix/698-katex-dedupe`).** Since `ce7e87b1` the lockfile held four nested katex 0.16.47 installs (each with commander 8.3.0) and the math chunk bundled two of
them: the app's (the partial-TeX check) and rehype-katex's (the renderer). One top-level `node_modules/katex` now serves every dependent: a lockfile-only edit of those ten entries, accepted unchanged by the pinned npm
11.6.2 (`npm dedupe` would also have moved semver, lru-cache, entities and ci-info). The renderer is not minified, so a copy was 490,779 bytes, not the issue's ~270 KB: the chunk 2,006,578 → 1,511,459 bytes, `app.asar`
−493 KB, its 3,425 `node_modules` files and THIRD-PARTY-NOTICES unchanged. The "single, deduped version" test compared versions: it now checks one install, plus the build carrying KaTeX once (each red under its regression).
Real app (packaged, 4B, GTX 1070 Ti): the probe's KaTeX fonts load, streamed TeX typesets. Record: architecture.md DEP-7 "#698". Open: a streamed `$$ …` partial shows a KaTeX error box until it parses (pre-existing, #701; fixed, above)._
_2026-10-14 — **#678 — "Install the AI engine again" replaces what the OS refused, the `cpu/` net included; Check again checks the `cpu/` net (`fix/678-cpu-net-reinstall`).** On a Kit, rungs 1–2 dying of
the model (a damaged weight) and rung 3 refused left a verdict only the `cpu/` net reported. The reinstall re-fetched the main build and the verdict came back with its offer (the loop); with an import done,
the embedder on the healthy main build refused it outright; Check again checked the main build and said "runs again". Now the reinstall replaces the refused builds (owner call taken as the issue recommended),
a helper never blocks a `cpu/`-only repair, a fresh `cpu/` copy counts for `afterInstall`, Check again checks `cpu/` when it is the only reporter, and the IPC gate refuses an `afterInstall` verdict (#670's residual).
Real app (scratch Kit roots, b11146, a truncated 4B): master failed all three; the fix replaced `cpu/` only and closed the loop. Record: "Engine load failures" §11. Open: none (residuals there)._
_2026-10-14 — **DEP-7 — Dependabot alerts #124–#127 triaged: one fixed, three dismissed with written reasons (`fix/dep7-alerts-124-127`).** #125 (high): source-map-js 1.2.1 → 1.2.2, lockfile only, one entry, build tooling
only (nothing ships). #127: sprintf-js has no patched release; the Kit carries it only for mammoth's CLI, and `extractRawText` from the packaged `app.asar` loads 154 modules, none from argparse or sprintf-js. #124/#126: katex
0.16.47 has no patch on its line, every dependent's range stops before 0.17, and nothing sets KaTeX's `trust`; the advisory needs a prototype-pollution bug the renderer is not known to have. Owner calls: dismiss #127 as not used
and #124/#126 as a tolerable risk (posted by the owner), no `overrides`, the `~0.16.47` pin stays. Two pins guard those premises (each red under its mutation). Found: KaTeX's output skips rehype-sanitize (`trust` is its gate;
security-model), and the renderer bundles KaTeX twice (#698). Record: architecture.md "Dependabot triage — design record (wave DEP-7)". Open: the PDF gold set (corpus not on this machine); #698 fixed, above._
_Older dated entries (the closed waves through 2026-08-22) and the Skills S2–S12 handoff sections were
moved **verbatim** to [`docs/build-log.md`](docs/build-log.md) — 2026-07-09-and-earlier plus the
Skills handoffs on 2026-07-12, the 2026-07-10 block on 2026-08-09 (images-wave close-out, for the
retention budget), the 2026-07-11…2026-08-16 closed-wave block on 2026-08-18 (pre-wave archive
ritual), and the four CLOSED waves of 2026-08-18/19 (local API #184, portable stored copies #188,
MTP speculative decoding #182, model occupancy #185/#186) on 2026-08-20 for the retention budget,
and the four 2026-08-20 entries of the same now-CLOSED #188/#190 stored-copy wave at the #194
close-out, and the #194 close-out entry itself on 2026-08-22 (preamble budget, making room for
the CI-flake entry), and the eight closed 2026-08-20…2026-08-22 entries (#196 catalog fix and its
successor wave (PR #199), local API docs, #202 sizes, the docs/code-comment audit, #201 checkpoint,
#208 second-instance guard, the #212 CI-flake fix) on 2026-09-02 (preamble budget, making room for
the full-audit 2026-09-02 remediation round — §5 item 19), and the eleven entries of that round
(2026-09-02 Phase 0 … 2026-09-03 Phase 9a, PRs #265–#281) on 2026-09-03 at its close-out (Phase 9b;
ledger `docs/architecture.md` §52), and the five 2026-09-04 Phase F entries (PRs #283–#289) on
2026-09-04 at the Phase F close-out (PR #292; §52 "Phase F close-out"), and the three closed 2026-09-04
entries of the #290/#291 wave (PRs #295/#300/#297/#299) and Phase F PR 6 + close-out (#293, #292) on
2026-09-05 at ZIM Phase 3a (preamble budget), and the ten ZIM knowledge-packs wave entries
(Phases 0–6 + the 2026-09-04 MVP entry, PRs #304–#336) on 2026-09-06 at the P7 close-out (preamble
budget), and the Phase 9b close-out (PR #282), Model library UX (PR #302) and #286 save-a-code-block
entries on 2026-09-09 (preamble budget, making room for the knowledge-packs docs and #331
HW3-acceptance entries), and the three closed 2026-09-06 entries (the #303 follow-up wave, the PR #308
audit remediation, the PR #303 audit remediation) on 2026-09-10 (preamble budget, making room for the
#436/#437 accessibility entry), and the two oldest closed entries (#333 manifest-read cost, #318
hardware session) on 2026-09-12 (preamble budget, making room for the #458 CI entry), and the two
closed 2026-09-07 models/runtime entries (#372, and the #310/#312/#313/#314/#315 wave of PR #371 —
its residuals stay live in §5 item 23) on 2026-09-12 (preamble budget, making room for the #438
entry), and the #339 Range-first article-reads entry on 2026-09-13 (preamble budget, making room for
the #460 test-harness entry), and the closed #331 HW3-acceptance entry on 2026-09-13 (preamble budget,
making room for the #467 test-fixture entry), and the closed #399 prompt-cache entry on 2026-09-18
(preamble budget, making room for the §11.16 Documents-declutter entry), and the Phase 4 PR-A
discovery-port entry on 2026-09-19 (preamble budget, making room for the knowledge-pack
retrieval-research record entry), and the closed 2026-09-09 knowledge-packs-docs entry on
2026-09-20 (preamble budget, making room for the wave-13 entry), and the two closed 2026-09-10
dependency-advisory entries (PR #451 xmldom, PR #452 build chain) on 2026-09-21 (preamble
budget, making room for the #497 dictation entry), and the closed 2026-09-10 #436/#437 live-region entry on
2026-09-21 (preamble budget, making room for the #488/#498/#501 entry), and the closed #446 and #413 entries on
2026-09-22 (preamble budget, making room for the #410 entry), and the closed 2026-09-12 #438 entry on
2026-09-27 (preamble budget, making room for the #515 entry), and the closed 2026-09-13 #460 test-harness entry on
2026-09-27 (preamble budget, making room for the #517 scorer entry), and the closed 2026-09-13 #467 entry on 2026-10-01
(preamble budget, making room for the #527 entry), and the closed 2026-09-18 #444 Documents-declutter entry on
2026-10-01 (preamble budget, making room for the #530 entry), and the closed 2026-09-18 #478 table-delivery entry on
2026-10-02 (preamble budget, making room for the DEP-6 entry), and the closed 2026-09-27 #518 fixtures entry on 2026-10-02
(preamble budget, making room for the #548–#551 entry), and the closed 2026-09-27 #517 scorer entry on 2026-10-02 (preamble
budget, making room for the streamdown 2.6 entry), and the closed 2026-09-18 #447 expander-cache entry on 2026-10-03
(preamble budget, making room for the OCR-rasterizer-CSP entry), and the closed 2026-09-19 knowledge-pack research entry on
2026-10-03 (preamble budget, making room for the #562 / #563 / #560-platform entries), and the closed 2026-10-02 #551 entry on
2026-10-04 (preamble budget, making room for the #567 entry), and the closed 2026-09-20 wave-13 entry on 2026-10-05 (preamble budget, making
room for the #539 entry), and the closed 2026-09-21 #497 dictation entry on 2026-10-05 (preamble budget, making room
for the #570–#573 entry), and the closed 2026-09-21 #488/#498/#501 entry on 2026-10-05 (preamble budget, making room
for the #516 entry), and the closed 2026-09-27 #515 and #512-decision-3 entries on 2026-10-06 (preamble budget, making room for
the #612 entry), and the closed 2026-09-22 #410 entry on 2026-10-06 (preamble budget, making room for the #606 entry), and the closed 2026-09-27 #512 entry on 2026-10-06 (preamble budget, making room for the #622 entry), and the closed 2026-10-05 #585 mammoth entry on 2026-10-06 (preamble budget, making room for the #613 entry), and the closed 2026-10-02 #554/#555 entry on 2026-10-06 (preamble budget, making room for the #581 entry), and the closed 2026-10-02 DEP-6 entry on 2026-10-07 (preamble budget, making room for the #582 entry), and the closed 2026-10-01 #527 entry on 2026-10-07 (preamble budget, making room for the #634 entry), and the closed 2026-10-01 #530 entry on 2026-10-07 (preamble budget, making room for the #635 entry), and the closed 2026-10-02 #548–#551 entry on 2026-10-07 (preamble budget, making room for the #637 entry), and the closed 2026-10-02 streamdown 2.6 entry on 2026-10-08 (preamble budget, making room for the #605 entry), and the closed 2026-10-03 OCR-rasterizer-CSP entry on 2026-10-11 (preamble budget, making room for the #641 entry), and the closed 2026-10-03 #560 app-scheme entry on 2026-10-12 (preamble budget, making room for the #646 entry), and the closed 2026-10-03 #562 fuses entry on 2026-10-12 (preamble budget, making room for the #643 entry), and the closed 2026-10-03 #563 print-from-memory entry on 2026-10-12 (preamble budget, making room for the #644 entry), and the closed 2026-10-03 #560/#562 platform-round entry on 2026-10-12 (preamble budget, making room for the #649 entry; its open Mac run moved to `packaging.md` "Platform verification"), and the closed 2026-10-04 #567 and 2026-10-05 #539 entries on 2026-10-12 (preamble budget, making room for the #473 Phase 0 entry), and the closed 2026-10-05 #570–#573 entry on 2026-10-13 (preamble budget, making room for the #656 entry), and the closed 2026-10-05 #538/#574/#575/#576 OCR entry on 2026-10-13 (preamble budget, making room for the #654/#655/#658 entry), and the closed 2026-10-05 #532 entry on 2026-10-13 (preamble budget, making room for the #653 entry), and the closed 2026-10-05 #516 and #580 entries on 2026-10-13 (preamble budget, making room for the #627 entry), and the closed 2026-10-06 #599 entry on 2026-10-13 (preamble budget, making room for the #663 entry), and the closed 2026-10-06 #598 entry on 2026-10-13 (preamble budget, making room for the #662 entry), and the closed 2026-10-06 #600 entry on 2026-10-13 (preamble budget, making room for the #660 entry), and the closed 2026-10-06 #612 entry on 2026-10-13 (preamble budget, making room for the #670 entry), and the closed 2026-10-06 #606 entry on 2026-10-13 (preamble budget, making room for the #671 entry), and the closed 2026-10-06 #620 entry on 2026-10-14 (preamble budget, making room for the #680 entry), and the closed 2026-10-06 #622 entry on 2026-10-14 (preamble budget, making room for the #684 entry), and the closed 2026-10-06 #581 entry on 2026-10-14 (preamble budget, making room for the #681 entry), and the closed 2026-10-06 #613 entry on 2026-10-14 (preamble budget, making room for the #689 entry), and the closed 2026-10-07 #607 and #582 entries on 2026-10-14 (preamble budget, making room for the #682/#687 entry), and the closed 2026-10-07 #634 entry on 2026-10-14 (preamble budget, making room for the #685 entry), and the closed 2026-10-07 #635 entry on 2026-10-14 (preamble budget, making room for the DEP-7 entry), and the closed 2026-10-07 #637 entry on 2026-10-14 (preamble budget, making room for the #678 entry), and the closed 2026-10-08 #605 entry on 2026-10-14 (preamble budget, making room for the #698 and #673 entries), and the closed 2026-10-11 #641 entry on 2026-10-15 (preamble budget, making room for the #673 entry), and the closed 2026-10-12 #646 entry on 2026-10-15 (preamble budget, making room for the #701 entry), and the closed 2026-10-12 #643 / #642 entry on 2026-10-27 (preamble budget, making room for the DEP-8 entry), and the closed 2026-10-12 #644 entry on 2026-10-27 (preamble budget, making room for the #713 entry), and the closed 2026-10-12 #649 entry on 2026-10-27 (preamble budget, making room for the #715 entry), and the closed 2026-10-12 #473 entry on 2026-10-27 (preamble budget, making room for the #711 entry), and the closed 2026-10-13 #656 entry on 2026-10-27 (preamble budget, making room for the #716 entry), and the closed 2026-10-13 #654/#655/#658 entry on 2026-11-01 (preamble budget, making room for the #749 entry), and the closed 2026-10-13 #653 entry on 2026-11-01 (preamble budget, making room for the #747 entry), and the closed 2026-10-13 #627 entry on 2026-11-01 (preamble budget, making room for the #753 entry), and the closed 2026-10-13 #662 entry on 2026-11-02 (preamble budget, making room for the #766 entry), and the closed 2026-10-13 #660 entry on 2026-11-02 (preamble budget, making room for the #742 entry), and the closed 2026-10-13 #670 entry on 2026-11-03 (preamble budget, making room for the #745 entry), and the closed 2026-10-13 #671 entry on 2026-11-03 (preamble budget, making room for the #736 entry), and the closed 2026-10-14 #681, #684 and #680 entries on 2026-11-03 (preamble budget, making room for the #767/#769 entry), and the closed 2026-10-14 #689 entry on 2026-11-03 (preamble budget, making room for the #779/#768/#743 entry), and the closed 2026-10-29 #730 and #714 entries on 2026-11-07 (preamble budget, making room for the #729 entry), and the closed 2026-10-14 #682/#687 entry on 2026-11-08 (preamble budget, making room for the #712 entry), and the closed 2026-10-14 #685 entry on 2026-11-08 (preamble budget, making room for the #790 entry) — citations of the form "BUILD_STATE <date> entry" /
"BUILD_STATE V1" / "Skills — Sn handoff" resolve there._

---
## 1. Current status

**Phases 0–43: all done.** The per-phase table (43 rows, every one 🟢, each pointing at the design
record that absorbed it) was retired to [`docs/build-log.md`](docs/build-log.md) on 2026-08-20 —
it had been a completed-history table for months. Phase 22 (signed offline update bundles) is the
one exception and is 🔴 blocked on key-management design; it lives in §5 item 3.

What each phase built is in the topic docs' §-numbered design records
([`docs/architecture.md`](docs/architecture.md) is the index); what it cost and how it went is in
[`docs/build-log.md`](docs/build-log.md).

> Remaining for *release* = **manual acceptance only** (§5): a real signed/notarized build +
> a USB spec-§17 demo (R5/R7), the GPU hardware matrix (§5 item 1b), the Activity-panel
> live-UI eyeball, the packaged-app OCR smoke.

---

## 2. Environment — the constraints that shape decisions

Only what changes a design choice. (A dated snapshot of one machine's tool versions lived here
until 2026-08-20; it was never a project fact, and `package.json` `engines` +
`packageManager` are the authority on what the repo requires.)

- **Rust / Cargo: NOT installed.** This is why the stack is Electron rather than Tauri (§3, now in
  [`docs/build-log.md`](docs/build-log.md)).
- **Python: NOT installed.** No build or tooling step may assume it — the fetch/verify scripts are
  PowerShell + bash on purpose.
- **Windows is first class**, macOS/Linux supported in the architecture. Shell: PowerShell and
  bash both available.
- **Repo root: any path or drive.** No path assumptions, ever (spec §0).

---

## 3. Decisions log

> **Retired verbatim to [`docs/build-log.md`](docs/build-log.md)** (2026-08-20) — 768 lines
> whose dated content was 31 × `2026-06` and 1 × `2026-07`: the MVP build period's decisions,
> made before most of the design records that now carry them existed. Existing "BUILD_STATE §3"
> citations resolve via this stub.
>
> **Where a decision lives now:** the durable ones are in the topic docs' §-numbered design
> records ([`docs/architecture.md`](docs/architecture.md) and its §-anchor legends) and in
> [`CLAUDE.md`](CLAUDE.md)'s hard rules; the standing shape/constraint decisions are in
> [`docs/data-contracts.md`](docs/data-contracts.md). A NEW decision goes in the record for the
> thing it decides — not here.

---

## 4. Shared data contracts (the actual "transported data")

> **Moved verbatim to [`docs/data-contracts.md`](docs/data-contracts.md)** (2026-07-12) — the
> per-phase contract sections (IPC command surface, DB schema, streaming contract, workspace
> paths, model/runtime, RAG, encryption, …) live there now; existing "BUILD_STATE §4"
> citations resolve via this stub. When a phase changes shared shapes, update them THERE.

---

---

## 5. Next actions (do these next) — POST-MVP

**Everything shipped is summarized in §1/§3 and detailed in the design records. What remains:
manual release acceptance, one blocked phase (22), one drafted phase (30).** In rough priority:

> **Definition of Done (MVP, spec §22 — folded in from the retired `docs/IMPLEMENTATION_PLAN.md`):**
> app builds on ≥1 OS; architecture supports Win/macOS/Linux; local model chat works; local doc
> Q&A with citations works; manifests work; drive layout works; user data local; privacy docs
> exist; setup scripts exist; benchmark recommendation exists; non-technical demo possible; no
> cloud API; no model weights in git; README explains DIY; commercial drive layout documented.
> All code-verifiable items are ✅; the demo items are the manual acceptance below.

1. **Commercial-drive manual acceptance (needs certs + a real USB run, R5/R7):** obtain the
   code-signing certs (Windows OV/EV + Apple Developer ID), produce a **signed** Windows
   portable `.exe` + a **signed & notarized** macOS `.app`, run `build-commercial-drive`
   end-to-end onto a real drive (`-AppArtifact` the signed build), then do the spec §17 demo on
   a **fresh laptop with Wi-Fi off** + the **second-laptop continuity** check (same encrypted
   workspace, different drive letter). **Gate note (2026-09-02, PR #271):** the SELLABLE verdict now
   comes from `assertCommercialDrive` alone (both builder scripts call it) and requires the app
   artifact + launcher per declared platform; the demo stays a manual acceptance step, not a recorded
   gate input — it becomes one only when the gate requires a per-batch smoke record (#233). **⚠️ 2026-08-19, wave 188 — this check has already
   FIRED once, from a real drive, before it was ever run deliberately:** issue #188 was exactly the
   failure it exists to catch (`documents.stored_path` absolute ⇒ every stored copy stale under a
   different mount point, and "Delete document" silently not deleting). **✅ ANSWERED 2026-08-20 —
   the continuity half is DONE** (`G:\` → `K:\`, diagnostic → functional walk → diagnostic, app quit
   cleanly in between because the healed rows sit in the plaintext working DB until the vault
   teardown re-encrypts it). Export original, preview and re-index all work on the relocated drive;
   **14 of 24 rows self-healed on first read** (`stored_name` populated 0 → 14, stale 24 → 10, and
   the 10 still stale are exactly the documents never opened — D3's lazy heal, no migration burst);
   an import + delete left **no new orphan** (count stayed 1), which is **D-1 proven fixed on
   hardware**; the teardown left nothing at rest under the new letter. Record:
   `architecture.md` §9.4. **Residual:** the delete leg used a post-#189 throwaway row, so D-1's
   *original* condition — a legacy row whose absolute `stored_path` names the old mount point — is
   still not exercised directly; 10 such rows remain on that drive if it is ever worth one real
   document. **Filed out of scope, then FIXED (2026-08-20): #194** — the re-index leg succeeded but
   gave NO feedback at all (the single-document path returned silently from `run()` while bulk
   "Re-index all" toasts and shows progress; its failure path was the unnamed screen banner — D-3
   recurring on a neighbouring action). Fixed the same day: toast + per-row spinner + named banner,
   `architecture.md` §10 of the stored-copies record. What is still owed on THIS item is the rest
   of it: certs, a signed/notarized build, and the fresh-laptop Wi-Fi-off demo.
   **✅ The diagnostic half of issue #190 is DISCHARGED (2026-08-20).** The read-only stored-copy
   diagnostic was RUN on the reporting drive (`G:\`) and the drive came back byte-identical:
   **24 rows, 24 stale, 24 healable**, `stored_name` column absent (pre-#189 schema), **1 orphan
   `.enc` (115.2 KiB)** on a **v2** descriptor, zero parse-transients, zero staged rekey files,
   audio rows **0**. That confirms #188 outright and makes this drive a valid **"before" snapshot**
   for the continuity check below — re-run the same command after the relocation and the
   `stale` / `healable` / `stored_name populated` triple is the self-heal proof in pasteable form
   (it should read 0 stale / 24 populated once the app has read each document once). From
   `apps/desktop/` (the prompt is hidden and reads the console device, not stdin — `npx` is blocked
   by this machine's execution policy, so use the `.cmd` shim):
   `$env:HILBERTRAUM_STORED_COPY_AUDIT = "G:\"; ..\..\node_modules\.bin\vitest.cmd run tests/manual/stored-copy-diagnostic.test.ts`
   Its output is public-issue-safe by construction — paste it into #190. **What it settled:**
   checkbox 1 (yes, stale — all of them), the checkbox-2 number (one orphan), and checkbox 3 — for
   which it **refuted** the record's leading "one AUDIO document" hypothesis (audio rows = 0). The
   surviving answer is temporal: under pre-#189 code 24/24 stale means preview failed for every
   document too, so the "Vorschau works" observation predates the relocation. See
   `architecture.md` §9. The `electron-builder.yml` hooks + the pipeline are
   wired; only the secrets + hardware are missing. **GPU additions:** a SmartScreen sanity
   re-check (the Vulkan build adds one more unsigned DLL of the same class) and re-running
   `build-commercial-drive` end-to-end with the two-build fetch. **Phase-38 addition:** a
   packaged-app OCR smoke (worker_threads cannot read asar — the `asarUnpack`/workerPath
   rewrite must be exercised in the built app).
1b. **GPU manual hardware matrix (THIS list is canonical — release acceptance, cannot be CI'd):**
   ① Win11 + discrete NVIDIA (dev box RTX 3080 Ti — ✅ done via the Phase-15 smoke; capture tok/s
   for release notes) · ② Win + discrete AMD (Adrenalin) · ③ Win laptop, Intel Iris Xe only
   (modest gain; profile does NOT bump) — **✅ done 2026-06-10 (i7-1185G7 + Iris Xe, `HILBERTRAUM_GPU_SMOKE`
   on `D:\`): probe sees "Intel(R) Iris(R) Xe Graphics" (8108 MiB), rung-1 starts as backend=gpu and
   streams, `gpuMode:off`→cpu, simulated rung-1 failure lands on the rung-3 CPU safety net; Iris Xe is
   integrated so `gpuUsefulForProfile` keeps the profile from bumping (unit-tested)** · ④ Win with no
   GPU / Server VM / RDP session (empty probe → silent CPU, no scary UI) · ⑤ Win with a pre-Vulkan-1.2
   GPU (clean rung-1 degradation) ·
   ⑥ Linux + NVIDIA and/or AMD (symlink-materialized libs load from exFAT) · ⑦ mac arm64
   regression (Metal unchanged) · ⑧ any GPU box: kill the driver mid-generation
   (`dxcap -forcetdr`) → §5.3 auto-fallback + friendly notice + next-message-works · ⑨ a
   `build-commercial-drive` drive moved between machines ①↔④ (flags/probe re-evaluate per machine;
   encrypted workspace continuity). The fake-spawn unit tests cover the *logic*; this matrix covers
   the *drivers*. Both are required before the release checkbox ticks.
1c. **Security + CoC contact — ✅ RESOLVED 2026-07-10 (docs-audit DOC-009).** `SECURITY.md`
   ("Reporting a vulnerability") and `CODE_OF_CONDUCT.md` (Enforcement) now name
   **security@hilbertraum.ai** as the private channel (same mailbox for both, owner decision
   2026-07-10). Remaining owner actions: create/monitor the mailbox, and enable **GitHub private
   vulnerability reporting** at flip time (confirmed NOT enabled as of 2026-07-06 —
   `GET /repos/comilionas/AI_Drive/private-vulnerability-reporting` → 404; re-confirmed still 404
   on the renamed `HilbertraumAI/HilbertRaum` 2026-07-11 — the enable-at-flip action now lives in
   item 10; SECURITY.md phrases it as "where available" so the doc stays honest until then).
2. **Small live-UI leftovers:** the Diagnostics **Activity-panel eyeball** on a real drive
   (events appear; export saves — the last wave-1 live-UI item); an icon/`buildResources` for
   electron-builder; the **optional** Phase-29 dev-box speed sweep (completeness only — QA +
   RSS are machine-independent).
3. **Phase 22 — signed offline update bundles** (spec §12.3): 🔴 blocked. Outline (kept here
   from the retired wave-1 record): a signed bundle (manifests + optionally weights/runtime/
   app) dropped into `updates/incoming/`, verified (ed25519 via the already-shipped `@noble`
   family — no new dep class), applied atomically, recorded in `updates/applied/` + the audit
   log. **Blocking decision = key management** (who holds the signing key, rotation, whether
   DIY drives trust a repo key) — needs its own short design doc before any code. The
   commercial pitch ("signed update bundles", spec §1.3) makes this the first priority once
   drives actually ship.
4. **Embedder swap (ex-Phase-30 Track B) — deferred post-MVP; write a fresh short plan when it
   actually starts.** The 2026-06-11 big-slot plan was retired unimplemented on 2026-07-12 (file
   deleted; disposition + the durable Track-B facts: `model-benchmarks.md` §9.2; full text
   `git show 1e5d17e:docs/big-slot-embeddings-plan.md`). Track A (a bigger chat model) is
   superseded by item 8's Qwen3.5/3.6 promotion pipeline. Reopen prerequisites: item 8's scorer
   fix + eval-set hardening (ex-D42), the b9849 embedder-compat re-check (the F16/q8_0 hazard,
   §9.2 fact 3), and a fresh embedder-candidate survey.
5. **ANN vector index** only if a real corpus outgrows the linear scan (rag-design §12.2 D15 —
   explicitly not built).
6. **Format-preserving PDF output for redact/edit (issue #45 stages 1–2 — OWNER DECISION needed).**
   Stage 3 (the confirm dialog states the `.txt` output up front) shipped 2026-07-10; the format
   cliff itself stands (D77: "writing PDFs is a separate problem"). Going further means: (a) a
   **PDF-writing dependency** — `pdf-lib`-class, MIT, offline-capable; only the reader `pdfjs-dist`
   is in the tree — and, for the regenerated-copy path, (b) a **shipped embeddable Unicode font**
   (none in repo; the pdfjs `standard_fonts` are WinAnsi-bound, which can't encode the `█` masks —
   mask runs would render as drawn rects instead). Redaction-first is the tractable slice (the
   segment-faithful masked text already contains no leakable original — regenerating from it is
   TRUE redaction by construction); full in-place PDF text replacement (reflow/fonts/kerning) stays
   out. Needs its own short plan + the dependency sign-off before any code.
7. **Full-audit 2026-07-10 residuals (registered at the Phase-14 close-out; ledger + §-legend:
   [`docs/architecture.md`](docs/architecture.md) §46):**
   - **TS-3 (owner design):** make the real-model smoke gate mechanical — e.g. a release-workflow
     step that fails unless a smoke-run record (date + env fingerprint) is newer than the last
     model/runtime-affecting commit; today the `HILBERTRAUM_*` matrix is human-remembered.
     - **Manual-smoke-only coverage inventory (CODE-9/TQ-6, full-audit 2026-07-11):** the release
       checklist must name exactly which behaviors a green CI does **NOT** evidence. Everything
       above the runtime rides mocks/fakes (the mock never emits `reasoning_content`, always
       finishes `stop`; `finish_reason:'length'` is fake-driven), so these are covered ONLY by the
       env-gated `HILBERTRAUM_*` manual smokes — a pin bump or a new model manifest can change any
       of them while CI stays green:
       - (a) the **real llama-server SSE wire contract** — `reasoning_content` deltas,
         `finish_reason` (`stop`/`length`), and error-frame shapes. Content + `stop` frames are pinned
         by real b11146 captures (`chat-sse-timings-b11146.txt` #512, `vision-sse-b11146.txt` #518) and their b12110
         re-captures (#729, with the progress/ping captures for chat and translation);
         reasoning, `length` and error frames only by hand-authored fixtures in `read-chat-sse.test.ts`
         + `llama-runtime.test.ts` (**re-verify those frames on a runtime pin bump**).
       - (b) **real-model + RAG answer quality** (grounding, citations, refusal discipline).
       - (c) **`ragMinSimilarity` vs the real E5 distance distribution** (the mock embedder's
         distances are synthetic).
       - (d) **server concurrency** (multiple slots / overlapping requests on one sidecar).
       - (e) **per-model bring-up + prompt-template / stop-token leak** (each GGUF's chat template).
       - (f) **all perf numbers** (tok/s, peak RSS, model load time).
       - (g) **real GPU behavior** — the fake-spawn unit tests cover the ladder LOGIC, not drivers;
         see item 1b's ①–⑨ hardware matrix for the driver-level legs.
       - (h) **verbatim-capture re-take (F-40, audit-2026-07-16) — DONE 2026-09-27 (#518):**
         `list-devices-b11146-vulkan-rtx3080ti.txt` (two devices: the card + the UHD 770 iGPU) and
         `vision/vision-sse-b11146.txt` replace the b9585 captures; the `gpu.test.ts` / `vision-sse.test.ts`
         assertions moved with them. Standing rule: re-capture on every runtime pin bump (TS-3(a)). Re-taken
         on b12110 (#729, GTX 1070 Ti) beside the b11146 ones, which stay for drives without the update.
       - (i) **real-server mid-stream error-frame smoke (F-02 / §Q Q-2, audit-2026-07-16)** —
         Phase 4 made `readChatSSE` REJECT on an in-band error frame (`data: {"error":{…}}` or a
         bare `error: {…}` field line), pinned only by hand-authored fixtures (shapes from b9849, TA-4).
         Force a REAL llama-server mid-stream failure (tiny `--ctx-size` + context-shift disabled,
         `HILBERTRAUM_*` env) and verify the reader rejects and the friendly `main.chat.streamError`
         copy surfaces (never raw model/runtime text). Also watch the PARTIAL-frame case: an error
         frame truncated mid-write (`data: {"error":{"mess` + close, no `[DONE]`) must parse as a
         keep-alive and end the stream CLEANLY (Phase 4's scoped close-without-`[DONE]` semantics).
   - **TS-7 — decided 2026-11-01 (#753):** a per-PR `macos 24.x` CI leg (`macos-15`, shared with
     `build-mac`: `macos-14` retired 2026-11-02), packaging.md CI section. Packaged-app checks on a
     Mac stay manual.
   - **BE-1 rider:** the `rag*` numeric settings knobs remain deliberately unclamped (they flow
     into retrieval via `ragSettingsFrom`; clamping changes behavior for extreme-value users —
     needs its own small decision before any bound).
   - **SC-1 (owner-observed):** the SHA-pinned workflow actions are validated by the next tag /
     `workflow_dispatch` run (the packaging tests don't execute workflows).
   - Watch-items **PF-5** (listDocuments load-all at ~10k docs — known-limitations, with DB-8) and
     **PF-8** (resident-cache RAM at the 1M-chunk bound — the architecture P4b deferral record)
     are recorded at those sites.
8. **Qwen3.5/3.6 + Gemma 4 QAT wave promotion — CLOSED 2026-08-03 (issues #48/#53/#82 closed;
   record: model-benchmarks §9.3 "Wave outcome — RATIFIED" + the 2026-08-03 entry above).**
   Steps (a)–(e) are done: (a) scorer v3 + all-dump rescore (canonical numbers), (b) both i9
   runs ratified as the §9 record, (c) §3/§4 speed/RSS rows for the promoted set + wave
   (RAM lines confirmed on the vulkan basis, kept), (d) §9.1 smokes for the 9B + both 27Bs +
   26B-A4B + 31B, (e) Qwen3.6 productized 2026-07-12. Coupled edits landed together (ranks
   26B-A4B 2 / 35B-A3B 1, wave test pins, manifest eval-standing notes; picker mapping
   unchanged). The rescored table did NOT contradict the §6.4 promoted ranks. The STR-1 §5.4
   thinking-checkpoint criterion is discharged for these families: every Gemma 4 size + the
   promoted Qwen set honor `enable_thinking` with clean suppression (structured surfaces safe;
   §9.3 "Thinking per size"). **Remaining work moved to the wave follow-up issue #95** (filed
   at close). *(Update 2026-08-09, `feat/issue-95-close-out` — the 2026-08-09 entry above:
   the option-2 signal-aware picker is BUILT (§6.5 design record, resolves #52's downgrade
   question) and the 35B-A3B §9.1 smoke PASSED. Still open on #95: the weak-16 GB-box
   measured-tok/s leg (decides E2B's rank; needs the designated weak-iGPU box) and the
   Windows-basis peak-RSS re-measure standing rule (§9.3 "§4 RSS") for any RAM-line retune.)*
8b. **MTP speculative decoding — the two hardware gates: BOTH PASSED 2026-08-19 (issue #182;
   adoption shipped 2026-08-19, record: architecture.md "MTP speculative decoding"; full figures:
   model-benchmarks.md §9.4 "Gate results").** Run on the i9-9900X + RTX 3090 rig with
   `speculative_decoding: mtp` active on `qwen3.8-27b-q4` + `qwen3.8-27b-q5`:
   - **§2 grounded-QA re-run, both quants: PASSED.** Score parity inside cross-run tolerance vs
     the committed pre-MTP baseline (the gate was parity, NOT byte identity: MTP breaks temp-0
     byte-reproducibility by construction). q4 F1 .3499 vs .3500, q5 .3518 vs .3523; EM,
     citation-correct, grounded columns unchanged; hallucinations 0 and unanswerable-abstention
     1.0000 held on both. Flags argv-verified on every scored server; item dumps audited (92/100
     resp. 91/100 byte-identical, the rest near-tie token flips). Committed:
     `eval/results/i9-9900X-qwen38-mtp-q{4,5}-vulkan-{quality.csv,items.jsonl}`.
   - **§9.1 smoke legs on the b9849 pin, both quants: PASSED** through the app's real IPC path
     (CDP/Playwright `_electron`). Rung 1a selected (log + argv), full offload with 24 GB
     headroom (peak VRAM 19.7 / 21.5 GiB, no spill), balanced chat zero reasoning frames, Deep
     32 / 31 frames, grounded DE ask exact fact + `[S1]`, abort 3 ms, stop + quit teardown
     clean. Fall-through leg (shim rejecting `--spec-type`): rung 1a fails, plain rung 1 comes
     up at `backend: gpu`, `gpuAutoDisabled` NOT persisted, session latch skips 1a, "Try GPU
     again" re-arms it.
   - **STILL OPEN:** re-measure §4 peak RSS/VRAM with the flag on before touching any
     `recommended_min_ram_gb` (§9.3 Windows-basis standing rule; the manifests deliberately
     still carry the PRE-MTP numbers). Data point from the smokes: `VmHWM` with MTP on matched
     the pre-MTP record byte-for-byte (17.14 / 19.68 GiB); the draft head lives in VRAM.
9. **Issue #51 residuals (owner decisions — the app-side quit close + docs shipped 2026-07-11):**
   - **Idle posture:** checkpoint + release the DB when the app is idle, so an unplug while "open
     but not in use" is harmless. New machinery (no app-level idle detector exists); the
     injected-clock idle-teardown in `translation/runtime.ts` is the pattern to mirror.
   - **In-app "Eject drive" button** (flush everything, then trigger the OS eject) — the safest
     UX for non-technical kit customers; needs per-OS eject plumbing.
   - **Downloads on quit:** a running model download's `.part` write stream is not torn down by
     `performShutdown` (the process exit closes the fd; `.part` resume re-validates) — harmless
     today, but a `downloads.cancelAll()`-style teardown would make quit-mid-download tidy.
   - **Kit quick-start card:** the printed "Before unplugging" note (quit → wait → eject) is a
     kit-material task, not a repo doc — the wording now exists in user-guide §13.
10. **Public flip checklist (folded from the launch working papers at the 2026-07-11 close-out —
    the papers are deleted, NEVER committed, no git-history copy; this item is the durable record.
    Owner executes at flip time.)** Repo state as of 2026-07-11: transferred + renamed
    **`comilionas/AI_Drive` → `HilbertraumAI/HilbertRaum`** (the checklist's repo-name item is
    thereby DONE; the hardcoded cla.yml URLs updated the same day); still **private**; **v0.1.46
    is published** (pre-release, 5 assets) — the Phase-7 release-flow test PASSED end-to-end
    (tag → three build legs + SHA256SUMS → draft → owner smoke → Publish; testers filed #48–#53
    against the shipped build).
    - [x] **Push `master` to origin BEFORE flipping** (full-audit 2026-07-12 GAP-1) —
      **DONE 2026-07-12**: the owner's push surfaced 3 remote-only commits (two staged-preview
      commits + a remote djuro-agent allowlist restore duplicating flip-batch item 5); merged
      (sole conflict `cla.yml`, local commented version kept) and pushed with the v0.1.48
      checkpoint. The `v0.1.47` tag was already on origin (decision resolved). Still open, as
      its own deliberate decision: pushing the **v0.1.48** tag triggers `release.yml`'s draft
      build.
    - [ ] **Branch cleanup** (2026-07-10 interim owner call was keep-ALL; decide at flip).
      Real unmerged work — decide keep/kill, don't blind-delete: `origin/mkg` (5 commits — the
      conversation-folders feature: nested collections, folder browser, rail tree; the only
      genuinely unmerged feature) and `origin/loader-integration` (23 commits — alternate nix/
      USB-image packaging track incl. an in-app "Updates tab"; superseded in spirit by the
      Phase-12/18 loaders but never formally killed). Stale, safe to delete after re-verifying
      0-ahead immediately beforehand: local `pr-13`, local `backend-audit-2026-06-27-fixes` (its
      only delta is the `full-audit` skill doc — cherry-pick that file first if wanted), remotes
      `models/qwen35-fast-tier`, `mkg-public`, `mkg2`, `nix-dev-shell`,
      `chore/portable-build-cleanup`, `full-audit-2026-06-28-fixes`, `screenshot-verify`,
      `performance-tuning`, plus ~25 merged locals; probably-stale CI experiments `ci/mac-build`,
      `ci/mac-build-042`, `ci/win-build-042` (verify, then delete — their function lives in
      release.yml now). **CORRECTION to the original analysis: `origin/cla-signatures` is
      LOAD-BEARING, not stale** — it is cla.yml's `branch:` for storing CLA signatures (and the
      action can't recreate it); never delete it.
    - [ ] **File the known open work as GitHub issues** (good first public-tracker content; then
      add issue cross-references where the Phase-4 readability sweep left plain-language gap
      descriptions): signed offline update bundles (item 3, blocked on key management) · big slot
      + embeddings (item 4) · PDF→PDF output for redact/edit (item 6, #45) ·
      generic result-tables residuals (architecture.md result-tables record §6: invoice
      `TableSpec` port, derived-column eval, no-skill tabular routing, remaining §5 deferrals) ·
      security-hardening lows L-4/L-5/L-7 (§8; L-8 is closed
      — `npm ci` everywhere) · the `IBAN_CANDIDATE_RE` backtracking hazard (known-limitations) ·
      restart-required mid-session installs for reranker/embedder (transcriber: #497; OCR: #410) · the open GPU
      hardware-matrix legs (item 1b: ② ④ ⑤ ⑥ ⑦ ⑧ ⑨).
    - [x] **Flip to public** — **DONE 2026-07-12** (observed via the GitHub API 2026-07-13 at
      the PR #57 merge review): repo public, **private vulnerability reporting ENABLED** (item
      1c satisfied — SECURITY.md's "where available" phrasing is fully true), `master` ruleset
      active (changes via PR + required **`ci-success`**, no deletion/force-push), Projects
      disabled (wiki was already off). Issue templates = nice-to-have, still open.
    - [ ] **Hygiene re-grep immediately before the flip** (a full-tree sweep for dev
      paths/secrets, not just deltas since the 2026-07-10 scan; that scan verified NO secrets/PII anywhere in the working tree or git
      history — history publishes as-is, owner decision 2026-07-10).
    - Owner sidebars (any time, not flip-gated): monitor `security@hilbertraum.ai` · Apple
      Developer enrollment (packaging.md signing stage 1; when the `APPLE_*`/`CSC_*` secrets land,
      remove the one `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` line from release.yml) · restore
      `djuro-agent` to cla.yml's allowlist once the post-launch CLA smoke-test PR is green (the
      removal note sits in cla.yml).

11. **Full-audit 2026-07-11 — ROUND COMPLETE** (close-out 2026-07-11). Nine-pass pre-release
    audit at `dda1d25`: 1 High code + 2 High docs + 13 Medium + ~46 Low/Info, 0 Critical; the
    security pass found no new vulnerabilities. Suite 4053 → **4165/47**. Durable ledger +
    §-anchor legend: [`docs/architecture.md`](docs/architecture.md) **§47**, which is the ONLY
    record — both working papers were uncommitted for their whole life and deleted at close-out.
    Wave narrative: [`docs/build-log.md`](docs/build-log.md). Still open:

    - the **CODE-9/TQ-6 manual-smoke-only coverage inventory** lives in item 7's TS-3 bullet
      (the labelled (a)–(g) sub-list; SSE fixtures carry provenance comments, pin b12110 since #729 —
      re-verify on a runtime pin bump);
    - **fix-when-touched polish candidates** (all Low; mechanisms in §47): SettingsScreen mounted-guard narrowing
      (CODE-7) · the `generateGroundedAnswer` canned-answer persist guard (CODE-18) ·
      PreviewModal `key={preview.id}` (CODE-35) · SkillsTab `setAutoFire` failure key (CODE-37) ·
      ~~the `diag.bench.cores` plural pair~~ (done 2026-11-12, UI languages wave) · the older DE ASCII-quote
      closers sweep (CODE-25) · ~~a direct GAP-5 batch-skip test~~ · ~~exporting `TOKENS_PER_WORD` for
      the compare-budget tests~~ (both done 2026-10-14, #682);
    - **accepted/no-action residuals** are recorded in §47's rows (CODE-1 F3 double-failure,
      CODE-2 triple-overlap, CODE-11 crash-bypass orphan, CODE-13 cancel-during-extract +
      download-vs-start race, the torn-FTS-content-backfill observation, the CODE-48 watch trio,
      DOC-13 PVR-at-flip → item 10).
12. **Full-audit 2026-07-12 — ROUND COMPLETE** (close-out 2026-07-12). Durable ledger +
    §-anchor legend: [`docs/architecture.md`](docs/architecture.md) **§48**. Six phases, final
    gate **4190/47**. Wave narrative AND the executed residual register (owner batch ①–⑥ with
    ②③④⑤⑥ executed 2026-07-12, the README default-set fix, the nuance notes):
    [`docs/build-log.md`](docs/build-log.md) (register moved 2026-09-03, PR #275). **Still
    open:** the SEC-1 orphan-`.enc` sweep (Info, deferred — the startup sweep runs LOCKED and
    cannot know live ids; a crash mid-lock-encrypt leaves a partial-CIPHERTEXT `<enc>.tmp`, same
    family, exposure nil); ① GAP-1 push + tag decision.

13. **Full-audit 2026-07-12b — ROUND COMPLETE** (close-out 2026-07-12; working paper DELETED,
    never committed, no history copy). Baseline `06920c1`; 24 findings (23 fixed across
    Phases 1–5, SEC-2 owner-declined → §8 L-7 watch item); gate 4195/47 → **4216/49**. Durable
    ledger: [`docs/architecture.md`](docs/architecture.md) **§49**. Wave narrative:
    [`docs/build-log.md`](docs/build-log.md). Residuals/watch-items (all also in §49):

    ① SEC-2 hardlink hypothesis — §8 L-7 watch clause, re-open on extraction-path/tar change;
    ② DRIVE-NOTICES.md's GPL source-availability URL assumes the public repo — true at flip
    (couple with §5 item 10); ③ LIC-2 LICENSE.txt presence in the packaged artifact rides the
    next manual R2 package smoke; ④ `.ps1`/`.sh` remain outside the hygiene-net extension
    filter (Phase-2 reviewer nit — candidate for a future net widening).
14. **Full-audit 2026-07-16 — ROUND COMPLETE** (wave opened 2026-07-17, closed the same day;
    **this item was still headed "REMEDIATION IN PROGRESS" until 2026-08-20** — a month after its
    own body recorded the wave complete, which is the clearest evidence the file had grown past
    being re-read). Baseline `4e02a48` (v0.1.50); 41 findings (0 Critical/High, 14 Medium,
    27 Low), all 41 remediated across a nine-branch chain, merged as **PR #60**, gate
    **4271/49**, version checkpoint **v0.1.51** tagged 2026-07-17. Durable ledger:
    [`docs/architecture.md`](docs/architecture.md) **§50**. Wave narrative:
    [`docs/build-log.md`](docs/build-log.md). The §50 "pending owner actions" (delete both
    working papers + restore the CLAUDE.md doc-lifecycle sentence, open/merge the stacked PR,
    tag the checkpoint) are all discharged — **nothing open here.**


15. **OCR-R wave deferrals (registered at the 2026-07-18 close-out; durable ledger =
    `architecture.md` "OCR audit (2026-07-18) — remediation ledger", PR #75):**
    (a) **mid-session OCR-asset refresh** — the IN-APP install activates OCR without a restart
    (#410, `refreshOcrSlot`). Left: files copied onto the drive by hand, and a download that grows
    a live recognizer's language set, still need a relaunch (documented); a "Check again" affordance
    would cover the first — owner UX call. (b) **packaged OCR smoke, recognition leg** —
    the wave's machine carries no `*.traineddata.gz`; the CSP-exposed rasterizer leg WAS
    verified inside a packaged build (P5 probe). Run the full `tests/manual/ocr-smoke.test.ts`
    flow on an asset-carrying drive before the next release. **SUPERSEDED 2026-07-19 (DEP-1 P4):
    this deferral fired and the answer is a CRASH** — packaged OCR kills the whole app (the
    `asarUnpack` list omits the worker's hoisted deps, which stay inside `app.asar`) while
    `ocrAvailable` still reports true; pre-existing, version-independent, dev mode unaffected.
    **Do NOT run this smoke as a release step**; it is blocked behind item 16(b)'s fix bundle.
    (c) **macOS/Linux packaged CSP + OCR smoke** (P5 measured Windows
    only). (d) **BE-7 memory profile** of a real 300+-page
    scan (confirms `page.cleanup()` keeps the hidden renderer flat). (e) **pdfjs-side
    `renderer/ocr/main.ts` automated tests** (audit test-gap #4; the P5 harness covers the
    protocol level). (f) ~~**PreviewModal `ocrInfo` line renderer test**~~ (done 2026-10-05, the #576
    cases in `DocumentsScreen.test.tsx`) and a
    ~~**two-queued-OCR-tasks-on-one-doc pin**~~ (P6 review residuals; the behavior is benign —
    serialize + overwrite = the D33 redo; pinned 2026-10-14 by #687, `ocr-task.test.ts`).
16. **DEP-1 follow-up register (owner-facing; registered at the 2026-07-19 close-out; durable
    ledger = `docs/architecture.md` "Dependency remediation — design record (wave DEP-1, PR
    #77)"):** (a) **`electron-builder.yml`/`electron` devDep parity test** — nothing guards that
    `electronVersion:` tracks the installed `electron` version; its absence let the first P4
    `package:win` silently ship Electron 37 after the npm bump. (b) **Packaged-OCR fix bundle** —
    `asarUnpack` the tesseract.js worker's hoisted deps, add graceful task-failure degradation,
    make `ocrAvailable` honest, and re-check the OCR window's header∩meta `blob:` intersection
    once the packaged path is reachable again (a pre-existing, version-independent crash found
    by the P4 packaged smoke). **⟶ 2026-09-02 (audit 2026-09-02 Phase 1, PRs #268 + #269): the
    three code items LANDED — hoisted deps unpacked per the require-graph closure test, worker
    failures degrade per document, `ocrAvailable` reads execution state; packaged Windows startup
    probe passed (277 ms). Residual → 18(c): the `blob:` header∩meta re-check + the interactive
    recognition leg.** (c) **`test:coverage` parallelism cap or a documented RAM floor**
    — full-width coverage starves this 16 GB machine; `--maxWorkers=2` is the current workaround
    (script/CI unchanged). (d) **Recommend `.github/dependabot.yml`** with grouped weekly npm
    updates so the next wave arrives as PRs, not an audit (recommendation only — not
    implemented).
18. **DEP-4 follow-up register (owner-facing; registered at the 2026-08-18 close-out; durable
    ledger = `docs/architecture.md` "Electron 39 → 43 — design record (wave DEP-4, PR #187)"):**
    Wave DEP-4 cleared the LAST open Dependabot alert (#83 / issue #179) by moving Electron
    39.8.10 → 43.4.0 — Chromium 142 → 150, Node 22.22.1 → 24.18.1, SQLite 3.51.2 → 3.53.1;
    `extract-zip` is gone from the tree and `npm audit` is clean. OS floors unchanged
    (Win 10+/macOS 12+), no on-disk format change. Open items:
    (a) ~~**`.github/dependabot.yml`**~~ **LANDED 2026-10-02** (DEP-6 PR C; record "Dependabot
    triage — wave DEP-6" §6): weekly grouped npm minor/patch PRs, every major ignored (owner
    ruling), Electron outside the groups. Supersedes item 16(d).
    (b) **Packaged-OCR fix bundle** — unchanged, still open; see item 16(b). DEP-4 did not touch
    it (the defect is an `asarUnpack` gap, not a runtime-version effect). **⟶ LANDED 2026-09-02
    (audit Phase 1, PRs #268 + #269; see 16(b)); what remains is the 18(c) measurement.**
    (c) **OCR assets on a build machine** — two DEP-4 measurement gaps exist ONLY because this
    machine carries no `*.traineddata`: dev-mode OCR recognize, and the OCR window's RUNTIME
    CSP leg (its baked meta WAS verified byte-exact from the shipped asar; the header is
    page-agnostic, so the mechanism is proven by the main window). Running the packaged
    measurement on an asset-carrying drive closes both. **⟶ 2026-09-02 (audit Phase 1, PR #269):
    the packaged Windows build's startup OCR execution probe PASSED against a scratch root with
    `deu`+`eng` files (`ok: true`, 277 ms) — worker script, hoisted deps, WASM core and language
    init load from `app.asar.unpacked`. ⟶ 2026-10-01 (DEP-5, packaged 43.7.7, i9-14900K): the OCR
    window's runtime CSP leg PASSED, and "Make searchable (OCR)" on a scanned PDF recognised its
    text, both IPC-driven. ⟶ 2026-10-05 (#538 wave, packaged `--win dir`, DesktopDiT, SAC off): photo
    import, scan OCR and the OSD worker, IPC-driven. STILL OPEN (owner, packaged build): the UI clicks.**
    (d) ⚠️ **Electron 44 is a CUSTOMER-FACING decision, not a routine bump** — it removes macOS 12
    support and drops 32-bit Windows (ia32) + Linux armv7l. **E43 is the last series shipping
    prebuilt 32-bit binaries, supported until January 2027.** Decide deliberately with the drive
    product's OS matrix in hand; do not let it arrive as a Dependabot PR.
    (e) **electron-builder air-gapped builds** (upstream #10039) — eb fails in air-gapped
    environments even with a seeded cache, because `@electron/get` always fetches
    `SHASUMS256.txt`; fixed on master only, not in any 26.15.x. Affects BUILD machines, not the
    shipped app, but it rubs against the offline-first posture.
    (f) ~~Manual legs owed by the owner~~ **DONE 2026-08-19** (owner-run; DEP-4 record §3):
    `defaultPath` resolves to the drive, not Downloads (D-2 void); a real drag-and-drop imports;
    the portable `.exe` starts by double-click on a prepared drive.
    (g) **DEP-5 (2026-10-01, Electron 43.7.7; record "Electron 43.4.0 → 43.7.7" §3):** from 43.7.2
    the first window paints later (packaged +64 ms, dev +435 ms). Re-measure at every 43.x bump. 43.8.0 (#708, 2026-10-27): probe equal to 43.7.7 (374 vs 383 ms), the stall itself not reproduced, the perf-log A/B owed (§3). 43.8.3 (alert #130): equal to 43.8.0 (391 vs 386 ms). 43.8.6 (#793, 2026-11-10): equal to 43.8.3 on DesktopDiT (1,245 vs 1,238 ms, occlusion tracking off on both; record DEP-5 §3).
    #560 (2026-10-03): any non-stock binary paints ~600 ms later on that desktop; compare like binaries.
17. **STR-1 follow-up register (owner-facing; registered at the 2026-07-20 close-out; durable
    ledger = `docs/architecture.md` "Skills & tools architecture review (2026-07-19) — design
    record (wave STR-1, 2026-07-20)"):** (a) **Issue #80** — the constrained
    model-classification router fallback (review §5.2, the #54 intent class): hybrid cascade,
    single-shot grammar-constrained enum classification at temp 0 on the low-confidence residue
    only, suggest-never-activate; owner decisions are whether a model call on the fallback path
    is acceptable at all, the enum's member set, and the confidence boundary — wants a short
    design note first (couples with item 8's option-2 signal-aware-picker note). (b)
    **Suggestion scale-up revisit trigger** (review §5.3, recorded in the Skills record §6):
    re-evaluate embedding-based suggestion when the skill catalog approaches ~10–20 entries.
    (c) **`supports_tools` watch item** (review §5.6): if a future wave makes 14B–27B models
    primary, native tool calls only as single-shot grammar-constrained selection with app-side
    argument validation — never an agent loop; the capability flag lands on the
    currently-ignored `supports_tools` manifest key (model-policy.md). (d) The §5.4
    thinking-checkpoint criterion is folded into item 8's ratify sequence, not a separate action.

**Current gate (2026-07-12, full-audit 2026-07-12 Phase 6 close-out — round complete, durable ledger `docs/architecture.md` §48, both working papers deleted; the round moved the suite 4168 → 4190 across Phases 1–5): typecheck clean, 4190 tests pass (47 skipped —
the manual tests behind `HILBERTRAUM_*`/`PAID_*` env vars: GPU/thinking/rerank/minsim/RAG-quality/
bring-up/eval/concurrency-probe/translategemma/categorizer/compare/whisper/dictation/OCR/vision/
real-data smokes — skipped in CI), `npm run build` green. The historical loaded-machine 1–2
timeout flakes were retired by the fixed-sleep sweep (full-audit 2026-07-10 TS-1; three
consecutive full runs, zero flakes).** Per-phase gate history (test counts, bundle sizes,
per-phase test inventories) lives in git history. (This gate paragraph sits above item 19 so the
open round's item stays the last block of §5.)

19. **Full-audit 2026-09-02 (security/reliability) — ROUND COMPLETE; Phase F COMPLETE**
    (close-out 2026-09-03; Phase F close-out 2026-09-04 + PR 6 the same day; ledger `docs/architecture.md` §52 — the ONLY
    durable copy: the working papers lived under the git-ignored `tmp/` and were deleted after the
    ledger merged; tracker #217 closed). Phases 0-a…9b = PRs #265, #267 (0), #268 + #269 (1), #270
    (comment sweep), #271 (2), #272 (3), #273 (4), #275 (5b-a), #276 (6), #277 (7), #278 + #279 (8),
    #280 + #281 (9a), #282 (9b). Every owner decision #218–#231 ran on its plan default — a default is
    never upgraded to a ruling; the owner then ruled on #221/#222/#223/#225/#226/#227/#228 on
    2026-09-03 and Phase F ran five PRs on 2026-09-04: PR 1 (#283) the autonomous #274 async walk;
    PR 2 (#284) #240/#243/#250 declined / documented + one exFAT crash-cut / documented (#222/#223/
    #227); PR 3 (#285) #248 the OS session-end lock (#226; Windows; macOS registered, unverified);
    PR 4 (#287) #236 the consenting external opener + https-only `license_url` (#221); PR 5 (#289)
    #247 `PRAGMA user_version` (#225). §52: the seven addendum rows, the "F — PR n" phase-table
    rows, the "Phase F close-out" paragraph; PR 6 (#293) #228 the RAG excerpt framing, shipped on a
    before/after grounded-QA eval (level within noise on the ranked models; the #228 addendum row +
    the "Phase F addendum" paragraph). Still open:
    - **Owner-only:** the macOS live check of the session-end lock (#226; Linux registers nothing,
      not ruled); the exFAT crash-cut (`packaging.md` checklist item 9, #223);
      `REFUSE_HASHLESS_MARKERS_ON_COMMERCIAL_DRIVES = false` (`binary-verifier.ts` — wired, tested,
      OFF; flipping the constant is the whole enablement).
    - **Chromium egress outside CSP (#254, closed as a confirmed residual):** WebRTC and
      dns-prefetch/preconnect unused by the renderer, reachable only after a compromise; no flag.
    - **OS-backed workspace lock (#263, accepted; decision #224):** not built.
      **`clearStorageData()` on lock (#231 rider; #249)**: documented only.
    - **Nine owner-runnable manual smokes never run** (recipes in §52): packaged OCR recognition
      (18(c)), double quit, the Windows update-walk GUI leg, lock mid-preview, skills pick/import,
      image + password change, evidence-pack PDF export, one IPC action after the sender guard;
      plus the macOS/Linux packaged-OCR and update-walk legs before those kits ship.
    - **Test-suite watch (no ID):** source-text wiring pins (`window-security`, `packaging`,
      `skills-installer`, `third-party-notices`, `ocr`, `rail-labels` tests), the KaTeX copy count
      in the build output (`KaTeX parse error`, #698), `as unknown as` private-field injection — convert to behavioural assertions when
      touched; `FullSuiteGuard` cannot see dropped individual tests.

20. **#290/#291 — server `timings` → Diagnostics decode speed + per-answer speed line — CLOSED    2026-09-04** (PRs #295/#300/#297/#299; #290/#291/#298 closed). Records: `architecture.md`
    "Per-answer speed line" §1–§3, `benchmark.md` / `model-benchmarks.md` §6.5. Text as it stood: `docs/build-log.md`, retired 2026-09-06 (P6). Residuals: none.
---
21. **ZIM knowledge packs — follow-up register (registered at the 2026-09-04 MVP; durable
    record: [`docs/rag-design.md`](docs/rag-design.md) §17 "Deliberately not built").**
    (a) **kiwix_tools provisioning** — P8 successor issue #339. The whole P8 build MERGED 2026-09-07 (P8-1..P8-5, PRs
    #354/#355/#363/#365/#364, rulings 1–6 on #339; ledger rag-design §17 D-Z17/D-Z19 + "Deliberately not built") and the
    `/raw` cut-short MITIGATION 2026-09-08 (PR #415, `84e97f3c`, record **D-Z22**).
    **Nothing engineering is left on #339; the four remaining legs are the OWNER's:** P8-6 file the `/raw`
    report at kiwix/kiwix-tools (win-x86_64 only — humaniser's Linux probe 0/40; draft final) and record the URL in
    known-limitations, rag-design finding 3 and a #339 comment; R-4 mac/linux code-signing inspection; T20-d's second
    half — `build-commercial-drive --kiwix-source-dir` against the real Kit drive on K:, all three platform bundles: the KIWIX HALF IS DONE 2026-09-08 — all three
    bundles installed with markers + the five source archives, and the gate reports kiwixSourceBundle/optionalRuntimesConsistent TRUE (`required-checks.json` T20-d row);
    only the (non-kiwix) sellability of K: is left; the GPL-3-via-root-`LICENSE` cross-reference and
    the libmicrohttpd version-from-recipe pin in model-policy. (T20-a is implemented, not pending.)
    (b) **#340 — CLOSED 2026-09-08, split into three successors; everything ruled was built.** Outcome + ledger: rag-design §17 D-Z16/D-Z18/D-Z20/D-Z21 and
    its "Owner rulings of 2026-09-06" paragraph (C3 (a), L1, L3 + the #353 ladder, L3-b, `path-unsupported`, LaTeX, the collision surface, the six renderer nits;
    PRs #351/#360/#361/#366, `feat/340-tier2-save-article`). **#418** — the citation-card save shortcut, the last piece of ruling C3 — is **BUILT 2026-09-08**
    (`feat/418-citation-card-save`; record rag-design **D-Z23** + design-guidelines §11.15 "Citation-card save shortcut"): renderer-only, no IPC/schema/contract
    change (the count stays 147); gated on an optional `onSaveArticle` only `ChatScreen` supplies, plus the guard "Open article" already carries; two ids and
    nothing else cross it; per-card state, so a second card citing the same article gets the main side’s own `alreadySaved` answer; the viewer’s five copy keys are
    reused verbatim (no drift, no second German string); the review boundary is structural (`EvidencePane` never mounts `SourcesDisclosure`). Doc gap closed on the
    way past: the SHIPPED D-Z21 viewer button had never reached user-guide §7b or the changelog — both now cover the pair. **Still OPEN, one issue each, both
    unruled:** **#416** C2 link expansion (closed by accident 2026-09-08 — GitHub read PR #424’s “Does not close #416” as a closing keyword; reopened 2026-10-07) — unblocked by D-Z22 (the defect-route traffic argument is void); needs the owner’s scope ruling and an `<a href>`-preserving
    converter (`html.ts` drops targets today). Its **L2 revisit is DONE 2026-09-08** — keep 5, measured (rag-design §17 "L2 REVISIT"); its side finding **#423 is FIXED 2026-09-08** — measured on the reference i9-14900K (evidence `cold-expand-2026-09-08/`), the cause is decode length, not warmth: `EXPAND_TIMEOUT_MS` 6→12 s (it could never afford `EXPAND_MAX_TOKENS = 96` on any machine measured; a 1.5× slower CPU lost 3 of 7 list questions permanently, not just cold), the two constants now pinned against each other and against `EXTERNAL_RETRIEVAL_DEADLINE_MS`; record rag-design §17 D-Z20 "#423 amendment". So #416's budget ruling is now taken against the corrected picture. Found validating it and **#429 is FIXED 2026-09-08** (PR #430): `servingNameFor` faithfully mirrors libkiwix's win32 backslash-only branch, so a forward-slash path made the WHOLE path the serving name — `/search` (`books.id`) kept working while every `/raw/<name>/…` 404'd, and the pack reported `searched, found 0`. The INPUT is normalised (`nativeArchivePath` at registration + in `resolvePack`), never the mirror; a pack whose every hit the L4 guard refuses now settles the existing `read-failed`; the smoke's tautological serving-name assertion now asks the running server. Record: rag-design §17 D-Z11 "#429 amendment".
    **#417** C4 acquisition — **CLOSED 2026-09-09, NOT BUILT** (owner ruling, taken on the blast-radius analysis of 2026-09-08 posted on the issue): the app downloads the TOOLS that run Kiwix and nothing else; archives are the user's to fetch and place (already whole — D-Z19 installs `kiwix_tools`, `zim/` + *Add packs…* take the file, `user-guide.md` §7b documents it as the normal workflow). It buys more than saved work: the four-doc network-inventory sentence stays true unchanged, and a live catalog could never be pinned the way every other download is, so the app would have had to show facts it had not verified. Records: rag-design §17 "Deliberately not built" C4, known-limitations. Revisit only on evidence, not for symmetry with the model downloader.
    (c) **Evidence identity for archive citations — CLOSED.** Identity resolution: P2, record rag-design D-Z5; the "Open article from a review" residual: closed P6, record design-guidelines §11.15.
    (d) **Manual acceptance leg — CLOSED 2026-09-06:** the airplane-mode demo (the real K: drive, `wikipedia_de_*` packs + kiwix-tools 3.8.1, network off) passed as T19 (viii); record rag-design §17 "Real acceptance".
    (e) **CORRECTED 2026-09-11 (PR #454, the E2B session on that machine).** The 2026-09-04 observation — auto-offload "gains nothing on pp (56 vs 57 t/s) and LOSES 45 percent on tg (11 vs 19.6)" — named no model and cited no committed evidence. Re-measured under one harness (ctx 8192, `--threads 4`, 512 tokens behind a ~2,000-token prefill, every start run twice): the tg DIRECTION holds, auto-offload does lose; the pp PARITY does NOT — both models lose prefill too (E2B −14.8 %, 9B −12.4 %); the 45 % does not transfer (E2B −18.0 %, 9B −30.7 %); and neither model comes near those absolutes (decode auto/cpu: E2B 5.600/6.826, 9B 1.723/2.488 tok/s). Two findings the entry did not have: on shared memory the offload COSTS host RAM rather than saving it (the 9B's auto start peaked 2,056.8 MiB above its processor start, 41 MiB free), and llama.cpp offloads onto the UHD 620 unasked (36/36 and 33/33) — the name gate governs the ★ and the tile basis, never placement. `gpuMode: off` on this iGPU class is better supported than before, and this stays an observation for item 1b's matrix; no ruling taken. Qualifier: Windows power mode "Best power efficiency" (the operator's setting), so every absolute is a floor — all six starts shared it, so the comparisons are unaffected. Evidence
    `eval/results/hardware/i7-8550u-uhd-620-shared-8gb-laptop-16gb/02-e2b.comment.md` + per-start JSON/stderr/RSS; record `model-benchmarks.md` §6.6 "2026-09-11 addition (the integrated class measured)".
    (i) **R-9 accepted (owner ruling 2026-09-05; recorded by P5 on 2026-09-06):** kiwix-serve is the one sidecar without request authentication; bounded by the `withServer` alive/generation guard + one admitted retry; recorded in
    security-model / PRIVACY / known-limitations. R-8 (`--urlRootLocation`) stays a documented unused option.
    (j) **P4 — CLOSED (2026-09-06):** M3/M6/M7/M8/M10 — effective documents-off scope, reranker-failure interleave, fair pack allocation under a per-ask deadline, refreshable searchability, per-ask pack outcomes. Record: rag-design D-Z4/D-Z11/D-Z12.
    (k) **P6 — CLOSED (2026-09-06):** T18-a implemented (design/frontend review); the (c) "Open article from a review" residual closed. Record: design-guidelines §11.15.
    (l) **P7 residual register — CLOSED 2026-09-06**, every leg landed (collision surface D-Z16, UI nits, T18-b/T19, #344, the post-add probe D-Z15, LaTeX, the non-ASCII add message, L3 + the #353 ladder; R-1 closed by P8-2, R-2 multipart unsupported, R-6 → L1 kept). Full text: `docs/build-log.md` "2026-09-06 — ZIM open-issues wave: item 21 (l) retired verbatim". T18-b’s owner visual leg is the only piece of the register still open.
    (m) **Phase 4 PR-A/PR-B — discovery port + rerank profiles, steps 4-2 through 4-8 — CLOSED 2026-09-18, both draft PRs MERGED (#469, #470, v0.1.60).** Every floor held at every step; record `rag-design.md` §17 "Discovery port (Phase 4 PR-A)" + "PR-B". Full text: `docs/build-log.md` "2026-09-20 — BUILD_STATE §5 item 21 (m) retired verbatim". Residual: the follow-up issues PR-B’s review drafted were opened as #473–#477; #474–#477 closed via PR #495, #473 (VRAM arbitration) via PR #631 — all five closed.

22. **Performance screen residuals (opened 2026-09-05, `feat/performance-screen`; numbered 21 on the branch until the PR #294 merge of 2026-09-06 — master's 21 is the ZIM register above; every "§5 item 21 (a)–(k)" citation of the Performance wave now reads 22).** Shipped: the rail destination, per-machine history + moved-drive restore, observed rows, step progress, "Start \<model\> and measure", plus (PR #308, 2026-09-06) the graphics-memory picker rule C on the free budget and the Performance snapshot's live recommendation. Still open, owner call each: (a) PARTIAL, 2026-09-08 → PR #397, record `benchmark.md` "The user is told which of the two happened". SHIPPED: the moved-drive notice on Home (`MovedDriveNotice`, session state) — a restore and an owed background check are told apart, and only the states that need one offer "Check this computer". DEFERRED (still open): the readiness row ("This computer: Balanced, about 12 tokens/s") — it puts a number on the FIRST screen that can be stale, absent, or from another computer, the defect class the #303 audit spent M2/M4/A4 fixing on Performance, and (c) still has the German rail-label-width residual open; (b) decided 2026-09-08 → PR #396, record `benchmark.md` "The Diagnostics benchmark card — a support artifact": raw rows + Copy, the run action / ErrorBanner / profile / recommended-model rows dropped, new empty state; (c) the hardware legs on the rig: the moved-drive round trip is DONE 2026-09-07 — #330 verified on two machines for a fresh and an upgraded (0.1.57-created) workspace, evidence `eval/results/hardware/330-round-trip-20260907/`, side findings (probe/auto-start race, report line, workspace-wide `gpuAutoDisabled`, USB reset) → #380–#382 + known-limitations, ALL THREE now closed, the report line (#381) FIXED 2026-09-08 → PR #403 (labelled as this computer's pick under an other-computer heading, the context line beside it), the probe race (#380) FIXED 2026-09-08 → PR #407 (auto-start waits for the probe; a timed-out probe is unknown, not cached, not persisted — decision 6 amended in `benchmark.md`; the rung labels from the load log when the probe is unknown), and #382 — the LAST unresolved #330 side finding — FIXED 2026-09-08 → PR #421: the Models screen passes `lazyVerify` like every other caller and the full pass became an explicit "Check all model files" action with its own in-place bar (the corrected cost it removes: 39.44 GB / 25.5 min at 25.8 MB/s, the 27B 43 % of it on a box whose ★ is the 9B). Owner-accepted: no passive `checksum_failed` discovery for un-started models; a cold ACTIVE model still blocks for that one file. Record: `architecture.md` RT-3 amendment. Its residual #420 is CLOSED 2026-09-08 → PR (this wave): the pass takes a renderer-minted run id that is both the progress tag and the `models:cancelVerify` handle, a **Stop checking** button sits beside the bar, and a cancelled pass returns a complete list in which what finished is verified and the rest is unchecked — no error. Two traps resolved: a bare `stream.destroy()` emits only `close`, so the abort destroys WITH an error and the promise rejects rather than hanging; and the #106 single-flight read is refcounted, so it stops only when the LAST waiter has abandoned it and an uncancellable caller (the §7.4 gate, `verifyModel`, the ship-time gates) is never collateral. `verifyModel` and the gate Skip deliberately unchanged; the pass still survives navigation but the screen now re-attaches to it. Record: `architecture.md` "Cancelling a verification pass (#420)"; residual (partly-warm file, no warm mark) in known-limitations; the slow-USB sequencing leg is DONE 2026-09-08 — #334 verified on B + an i7-1185G7 Surface with an SSK stick (28–133 MB/s by port), all five boxes, evidence `eval/results/hardware/334-slow-usb-20260908/`, record `benchmark.md` §4 I6; side findings (a Models-screen hash lets the page-cache load sample through the #108 guard; the manual-start overlap is measurable but harmless to profile/★; the Home preflight probe at unlock) → #392 (read sample — FIXED 2026-09-08 → PR #406: any weight hashed this session suppresses the load sample; the prefetch skip stays on the start's own hash; the warm-relaunch overwrite → #404 — FIXED 2026-09-08 → PR #421: `preferCandidate` gains the media-bound-checksum rule in BOTH directions (a `checksum` under `SLOW_READ_MBPS` may displace a `model_load`, and is not displaced by one; strict `<`; still the single ranking rule over all four call sites). Accepted, self-healing: a faster USB port on the same machine is outside `machineKey`. Record: `benchmark.md` §6 "The media-bound checksum rule"), #393 (overlap fix — FIXED 2026-09-08 → PR #405: the speed leg also watches a start in flight and whether the manager still holds the runtime it measures, and a cut stream warns) + known-limitations; #329 DONE 2026-09-08 → PR #408 (four b9849 captures promoted to tests/fixtures, RS buffer parsed, MTP compute de-duplicated, DR3 verified); still open: the German rail label width at the 600 weight; (d) decided 2026-09-08 → PR #396, record `benchmark.md` "The read sample's duration on those rows": renderer-only (no schema change), `model_load` / `checksum` / absent are three distinct renderings; (e) "Your model" — the fit estimate's three structural over-counts are FIXED: the context-cache term is per-slot since #319 (PR #386), and the measured host-mapped weights (`host_mapped_weights_mib`) leave the 15 % working share since #321 (PR #387) and the BASE since 2026-09-08 (PR #390) — the E2B falls 4,746 → 2,271 MiB against 1,998 measured, i.e. 2.4× → 1.14×, and every model stays conservative. **The GGUF-header plan is RETIRED, decided on the analysis in `model-benchmarks.md` §6.6 rule 3:** the picker judges models the user has NOT downloaded (the ★ is set on a `missing` model on purpose; exactly one of the 29 chat manifests ships on a prepared drive), so a parser answers for one model and goes silent for the 28 the recommendation exists to choose between — and where a model IS installed and has started, the measured `ModelPlacement` already beats any estimate. **Still open, narrower:** (1) **CLOSED 2026-09-08 (#391).** `qwen3.5-4b-ud-q4kxl` carries a MEASURED **497.31** MiB off a 33/33 start on the RTX 3060 Laptop (need 4,410 → 3,838 against 3,261 projected, 1.18×), its `estimated_context_cache_gib` derivation confirmed within 2.25 MiB at the same time; and `gemma4-26b-a4b-it-qat-q4` carries **577.50** MiB off a **31/31** rung-1 start on the RTX 3090 (need 18,353 → 17,689 against 14,943 projected, 1.18×), its first hardware start ever after the weight was fetched onto the rig. Every model rule C can ever STAR now has a measured figure — the five rank-3 models, plus the two rank-2 tier winners (Gemma 12B, the MoE); no grid row or boundary moved. NOT every ranked model, a claim #409 and the #391 close both overstated and this corrects: 8 of the 15 ranked manifests still carry none (`qwen3-4b-instruct-q4` and `ministral3-8b-instruct-2512-q4` at rank 2, six more at rank 1 — exactly the 8 §6.6's threshold table omits as unable to win rule C) and keep the whole-file base. Harmless for the ★, which never lands on them; live for the "Your model" estimate of one a user installs by hand. Side finding, CLOSED 2026-09-09 (#412): that start measured the MoE's context cache at 760.00 MiB (160.00 non-SWA + 600.00 SWA, both `1/1 seqs`) against the 1,536 its derived `estimated_context_cache_gib: 1.5` claimed, i.e. 2.02× high. TAKEN — the term is the measurement rounded to 0.8 (819.2 MiB, 59 above; 0.7 would sit 43 below, and the file's rounding precedent splits, the 27B pair being 39 under its own figure), threshold 17,689 → 16,972. The ★ moves NOWHERE: swept over every budget 1,000–49,152 MiB × ten RAM sizes, with and without a crawl on each chat model — identical picks, and the MoE wins rule C at no point in that sweep, now asserted (`committed-catalog.test.ts` "#412"). Two rule-C branches bypass the rank argument and needed the sweep: `base && eligible(base)` precedes the ranked pool, and `applySpeedSignal` gates a crawl on `eligible(measured)`. The 4-bytes-per-element CAUSE the issue proposed is NOT recorded: the 12B twin's derivation, written the same way, is 4× high on its full-attention half and exact on its sliding-window half, so no single per-element error explains the family and a K/V double-count fits equally. Live effect: the "Your model" row for a hand-installed, never-started MoE stops overstating the card by 717 MiB. **Owner call this opened, CLOSED 2026-09-10 (#413):** the 4B's new 3,838 clears the ~3,900 probe-free budget §6.6 N8 attributed to a 4 GB card, which looked like it halved the argument for keeping `USABLE_VRAM_MB` at 5,120. It does not: 3,900 is a FIXTURE (invented in `c3247fe5` alongside the gate change), not a reading — no 4 GB card has ever been probed, and every card that HAS been idles ~768 MiB down (3060 Laptop 768, 1070 Ti 769, 3080 Ti 768, 3090 1,014, all FLOORS — the same 1070 Ti has been seen at 1,686), so a real one's budget is ≈ 4,096 − 768 = 3,328 and the 4B misses it by 510. The E2B is alone at BOTH forms a real card produces, the argument is intact, and the record is restated on the measured reserve rather than the fixture (§6.6 N8 + its grid-note pointer, `architecture.md`'s profile-bump rule, the `USABLE_VRAM_MB` comment, and the comments in `gpu-rules`/`performance`/`picker-seams`; `committed-catalog.test.ts` drops its ⚠ WEAKENED flag and pins all three forms — 3,072, 3,328 and the 3,900 fixture — plus the 3,837/3,838 boundary the whole question turns on). **Whether to lower the floor — DECIDED 2026-09-11 (owner, #413 closed): no, and without a 4 GB measurement** (the project owns no such card and will not buy one). Keeping it self-corrects (placement ignores the floor; a crawl on the RAM pick steps the ★ down, §6.5); a lowered floor would pin the E2B at every RAM size with no step back up. Reopen only on a contributed 4 GB measurement; the "4,096 is not the value" note stays in §6.6 N8 "What would reopen it". The constant is UNCHANGED; (2) nothing recomputes the field when a manifest's weights change; (3) the 15 % working share is a poor model of the compute buffer (measured 316–664 MiB per llama_context across the six models in the 33 captured logs, 2.9–19.8 GB on disk — near-flat in file size and set instead by ubatch, context size and the layer split: 316 on the 4B at ctx 4,096, 664 on the 27B Q5 at ctx 32,768, and 174 on that same Q5 under a --ubatch-size 512 probe; an MTP start pays a second ~520 MiB draft-context buffer, and the parser summed its re-reserve reprint a third time until #329 → PR #408), and replacing it with a flat term is REJECTED for now because it flips the 8 GB row to the 9B against #318 leg 2's measured 31/33; (4) a real 8 GB card (GTX 1070 Ti, 7,504 free) now stars the 9B — MEASURED 2026-09-08 (#391 leg 2, PR #401): **33/33** on two starts, the fit read 7,350 MiB free under `-np 1` (the reading moves with the slot count on every card measured, §6.6 finding 1), projected 5,856, margin 470 MiB, 29.0 tok/s against 20.2 at 31/33 — #390's 8 GB behaviour is CONFIRMED, no follow-up. **The app-screen half is CLOSED 2026-09-08 (#414):** the leg-2 star was computed with the picker functions, not read off the screen; a `npm run dev` build on a checkout containing #390, drive root at the prepared drive, now shows `Empfohlen für den nächsten Start: Qwen3.5 9B (UD-Q4_K_XL) (Grafikspeicher)` with profile PRO and 30 tok/s, on a live probe reading the same `8273 / 7504` the picker test pins — evidence `eval/results/hardware/i7-8700-gtx-1070-ti-8gb-32gb/app-report-20260908-performance-screen.txt`, §6.6's `2 fu` row now cites it. Side finding, recorded as §6.6 finding 7: that report's `Laufwerk` row (1,008 MB/s on a 407.9 MB/s drive) was contaminated by the leg's own pre-flight `Get-FileHash` warming the page cache — the #392 class from an EXTERNAL hasher, which PR #406's in-app guard cannot see; no verdict depends on it. The card estimate itself is rule C on the free budget (PR #308, §6.6 2026-09-06 amendment), signed off 2026-09-06 and VERIFIED on six machines 2026-09-07 (#318); (f) the fit margin on a 24 GB card — decided 2026-09-07 → PR #386, record `model-benchmarks.md` §6.6 "2026-09-07 amendment (#319)": the Q5 shortfall was MTP at four slots, and `-np 1` is the fix (62/66 at 30.4 tok/s → 66/66 at 51.0); the app now stars Q5 on a real 24 GB card, the grid row waits on #321. **VERIFIED on hardware 2026-09-08 (#391 leg 7, app-started):** the Copy report's live pick reads Q5 (graphics memory) and the app's own rung-1a launch offloads it **66/66** at ctx 8,192 and again at 32,768; `model-benchmarks.md` §6.6 "Hardware confirmation (issue #391)" carries the table and the decode caveat; (g) start-order contention between chat and translation on one card — decided 2026-09-08 → PR #395, record `architecture.md` GPU record §8.1: NO runtime change (both proposals refused on the record), the starved Translate lines name the cause; (h) iGPU naming / `looksIntegrated` completeness — decided 2026-09-07 → PR #385, record `model-benchmarks.md` §6.6 "2026-09-07 amendment (#320)": one ANCHORED bare-name alternative for "Intel(R) Graphics" (a model-numbered discrete Arc still does not match); narrative in `docs/build-log.md` 2026-09-07; (i) `-np 1` for a single-user session — decided 2026-09-07 → PR #386, same record: YES, `CHAT_SERVER_ARGS` passes it (chat only). `--ctx-size` is the total cache either way (window unchanged); KV is cell-sized and counted once, only the recurrent state is per-sequence, so four of the seven cache terms shrank and the three Gemma ones did not. `MTP_VRAM_HEADROOM_MB` stays 3,584 (measured at four slots, now conservative); narrative for (f)+(i) in `docs/build-log.md` 2026-09-07; (j) `--device` to exclude a hybrid laptop's iGPU — decided 2026-09-07 → PR #385, same record: NO, the never-`--device` rule stands; b9849's fit drops the integrated device BY TYPE before the filling pass (the "spreads over every listed device" premise measured false on both hybrid machines), so `--device` would change nothing and would break the ladder's "`--device none` is the only device argument" contract; Intel-first hybrid unmeasured (none in the project); (k) the 6,144 MiB `discrete` gate on 6 GB laptop cards — decided 2026-09-07 → PR #387, record `model-benchmarks.md` §6.6 N8 (rewritten) + "2026-09-07 amendment (#321)": LOWERED to 5,120 (`USABLE_VRAM_MB`), admitting every measured 6 GB laptop card (5,746 / 5,921 / 5,994) and still excluding 4 GB ones; the gate never affected placement, only the ★, the basis wording, the profile bump and the tile; narrative in `docs/build-log.md` 2026-09-07; (l) the graphics tile on such a laptop read "No usable graphics card" (and on a hybrid box the old `displayDevice` fallback named the iGPU) although the probe listed the card — decided 2026-09-07 (owner): the tile NAMES the real card and its memory regardless of the gate and the rating says whether it is used; shipped as `PerformanceSnapshot.graphicsDevice` (`displayDevice`: budget device, else the largest discrete-looking card even under the gate, else the integrated one; `currentGpu`, the record, the budget and the ★ unchanged) — the gate itself (k) stays open — its RATIONALE was rewritten 2026-09-08 (PR #395, record §6.6 N8 "Why 5,120 — RESTATED"): the constant is unchanged, #321's reason for it was void.    **Audit remediation register (PR #303 review of 2026-09-05: M1–M8, L1–L8, H1, D1–D5, T1–T12; fixed on the same branch before merge from 2026-09-06; durable disposition record lands in `docs/benchmark.md` at P9, one commit per phase, CI green each):** P1 ✅ M7/L7 pins, stale `_Host` prose, item 20 archived, `skills.title` orphan removed after the master merge; P2 ✅ M2/M4/M6/L2 persistence (identity before ranking, upgrade backfill, mid-run samples); P3 ✅ M1/M3/L3 `performance:changed` push + honest steps; P4 ✅ H1/L8/M5-residual schemas + launch context; P5 ✅ M8/N1/N3 one GPU source + the resident rows' device/RAM total; P6 ✅ L6/L8/N4/N5/T6 provenance + copy + German smoke; P7 ✅ L1/SD2 auto-start sequencing; P8 ✅ T7/T8/T11/TH1/TH2; P9 ✅ D1–D5/L4/L5 docs — durable record `docs/benchmark.md` "Audit remediation record — PR #303" §1–§5; P10 ✅ cross-review + the local half of (c) (repairs `ab01e14b`); P11 ✅ close-out: issues #329–#334 (open acceptance) + #335 (temp-root hygiene elsewhere), record / changelog final. Residual (c) above is the audit's HW1–HW3 acceptance (→ #329–#334); (a)–(k) stand.

23. **Models/runtime wave residuals (2026-09-07, PR #371 for #310/#312/#313/#314/#315; owner rulings 2026-09-07):** (a) #312 per-model "cannot load" session latch + the model-named notice when acceleration is off → **#372, fixed 2026-09-07** on `fix/372-model-load-latch` (GPU record §5.2 "#372" paragraph; residual: the latch is cause-blind for the session — a transient cause latches too; "Verify checksum" / re-download / engine install / restart re-arm, "Try GPU again" does not — `known-limitations.md` #312 entry (a)); (b) #310 no older-build fence for `files:` manifests — **accepted** (owner: no old versions in use; a `format` marker stays #311's call); no per-file view in `ModelInfo`/the Models screen; the shard-completeness rule covers `local_path`, not `mmproj.local_path` — owner: leave; (c) #314 download jobs die with the app process — owner: leave, dedicated issue only on request; (d) #315 item 5 (name shown twice) — **fixed in PR #371** (the panel names the model only while its row is off screen).
## 6. Open issues / risks

- **R1 `node:sqlite` ✅ RESOLVED** — works in Electron 37 (Node 22.21) main process and in
  vitest (system Node); bundler resolution via `createRequire` in `db.ts`; the `sql.js`
  fallback was never needed.
- **R2 Electron binary download** — `npm i electron` and electron-builder packaging need
  dev-time network; the *app* stays offline. ⚠️ npm-workspace hoisting: prod deps live in the
  **root** `node_modules`; if electron-builder can't collect them, build from `apps/desktop`
  or adjust hoisting.
- **R3 PDF/DOCX parsers ✅ RESOLVED** — pdfjs legacy build runs in the Node main process (no
  worker/DOM); `mammoth`/`papaparse` pure-JS; all three externalized
  (`externalizeDepsPlugin`). Ambient typings in `parsers/pdfjs.d.ts`.
- **R4 Argon2id ✅ RESOLVED** — new vaults use pure-JS `@noble/hashes` Argon2id; scrypt vaults
  unlock unchanged forever (the descriptor records `algo` + params; see the §3 KDF decision).
- **R5 Real llama.cpp ⚠️ PARTIALLY RESOLVED** — all mechanics are implemented + tested against
  mocked processes/fetch, and every real-hardware smoke (`HILBERTRAUM_*`) has passed on provisioned
  drives; but binaries/weights are not in the repo, so the live spec-§17 demo from a real
  commercial drive remains the one manual acceptance step.
- **R6 TLS-intercepting proxy on this machine** — `npm install` fails with
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (corporate root CA). Workaround:
  `NODE_OPTIONS=--use-system-ca npm install` (Node 24 reads the Windows cert store). Dev-only;
  the app stays offline.
- **R7 Code-signing certificates — PROCUREMENT, blocks only the *commercial* acceptance.**
  The `electron-builder.yml` hooks are wired (win signtool, mac notarize + hardened runtime +
  entitlements) and driven by env vars / a git-ignored secrets file; the OV/EV Windows cert +
  Apple Developer ID cost money + lead time. The green gate does NOT sign; the DIY path uses
  the unsigned "Run anyway" fallback (`docs/troubleshooting.md`).

---
## 7. Conventions

- IDs: UUID v4 (`crypto.randomUUID()`). Timestamps: ISO-8601 UTC.
- No network in core path. No telemetry. Models/workspace/logs are git-ignored.
- Every service hides behind an interface from spec §9.2 to keep the Tauri/Rust swap open.
- Tests: under fake timers, never wait for real I/O by counting event-loop turns — a turn is not
  a unit of time (1000 `advanceTimersByTimeAsync(0)` ≈ 4 ms). Poll a real deadline with a real
  timer captured before `useFakeTimers()` (2026-08-22 entry).
- Tests (audit 2026-09-02, #258 / #242): a helper that waits on real file I/O ticks with a real
  macrotask — `setTimeout(r, 1)`, never a `setImmediate` loop, which starves the libuv poll phase
  where fs callbacks land (a real async decrypt never left its `.tmp` stage under it). And for
  filesystem fault injection use the pass-through `vi.mock('node:fs', async (importOriginal) => …)`
  wrapper (`workspace-vault-durability.test.ts`), never `vi.spyOn(fs, …)` — it records nothing
  for an ESM-namespace binder, so the injection is silently never reached.

---
## 8. Post-MVP audits & hardening (2026-06-09 → 2026-06-10)

> **The REMEDIATED half was retired verbatim to [`docs/build-log.md`](docs/build-log.md)**
> (2026-08-20) — its own heading had said "ALL REMEDIATED" since 2026-06-10. Existing
> "BUILD_STATE §8" citations resolve via this stub; the L-7 watch clause those citations most
> often mean is below, where it is still open.


### Open hardening items — security audit 2026-06-13 (deferred, NOT yet fixed)

The 2026-06-13 hardening wave fixed every MEDIUM + the quick-win LOWs (see the entry at the
top of this file; the full audit report is in git history at commit `f99bc86`). These four
LOW items were consciously deferred — they are defense-in-depth / build-pipeline, none blocks
the offline/privacy guarantees:

- **L-4 — renderer-supplied source paths (restated 2026-09-03, #240 / PR #275).** The PICKER half
  is done: `pickDocuments` has minted a one-time token that `importDocuments` redeems since D1
  (vuln-scan 2026-06-21), and `pickSkillPackage` does the same for `previewSkillPackage` /
  `importSkill` since PR #275 (`src/main/ipc/picker-tokens.ts`). The DROP half still passes raw
  paths (an OS drop reaches the renderer, untokenizable): each path is `lstat`-checked, symlinks
  refused, canonicalized, the array capped at `MAX_DROP_PATHS` (512) and the walk bounded — but a
  UNC/device path still reaches `lstat` before any lexical check. Lexical rejection would change
  the drop contract for network-share users: **declined 2026-09-03 (owner decision #222) — an
  accepted residual** (`security-model.md` residual egress (ii); #240 closed, Phase F PR 2).
- **L-5 — `expandPaths` follows directory symlinks (restated 2026-09-03, #240 / PR #275).** A
  visited-realpath CYCLE guard exists (backend-audit 2026-06-27 REL-9 `onPath`, `architecture.md`
  §-ledger) and the walk is now bounded (entries / depth / wall clock, `limits.ts`); the walk still
  FOLLOWS a symlink to a distinct directory by design, so a picked folder linking to e.g.
  `C:\Windows` still traverses outside the selection (supported extensions only, not RCE).
  Off-thread walk: done (#274, PR #283).
- **L-7 — Runtime-archive extraction doesn't prevent member traversal (build-time AND in-app;
  scope corrected 2026-07-12, full-audit SEC-2 — the earlier "build-time only" framing was
  wrong).** `Expand-Archive` / `tar -xzf` in `scripts/fetch-runtime.{ps1,sh}` run on the drive
  **builder's** trusted machine — but the shipped app's engine installer performs the same
  extraction (`runtime-download.ts` `extractWithTar`: `tar -xf … -C extractTo` via the OS
  `tar`) of an archive whose source list (`runtime-sources.yaml`) lives on the user-writable
  drive. Current in-app posture: the archive's sha256 is verified **before** extraction
  (tampering needs drive write access to both the archive/URL and the matching hash; a
  placeholder hash extracted flagged `unverified` — RT-02, 2026-09-02, made that a hard
  FAILURE: an unverifiable engine archive is discarded, never installed), and the OS `tar`
  refuses `..` members by default — containment rests on tar's *implicit* behavior rather
  than the explicit member check this fix calls for; symlink members are the residual soft
  spot; the archive's own *name* is guarded since #245 (audit 2026-09-02 SEC-2, Phase 8).
  (The skills importer does NOT share this gap — it enumerates and validates every
  member's path/symlink before inflating, arch §22-A2.) Fix: list/extract members with an
  explicit containment check.
  **Update (close-out 2026-07-12):** Phase 5 (`032b014`) added the explicit in-app containment
  check L-7's fix called for: `install()` now runs a post-extract symlink/junction containment
  sweep (`assertExtractedSymlinksContained`, over the final post-flatten layout — an escaping
  member fails the install, no marker written), closing the symlink residual; the
  `--no-same-owner --no-same-permissions -k` tar flags were deliberately dropped (GNU tar `-k`
  hard-errors on the legitimately-retained archive `cpu/` dir). The build-time
  `scripts/fetch-runtime.*` half of L-7 remains as previously recorded. (2026-09-02, PR #271:
  `fetch-runtime --commercial` now refuses a placeholder hash before any download and records the
  marker's binary hash only after a verified archive — the sell-gate side of #234; the
  member-traversal half of L-7 is unchanged.)
  **Watch-item (full-audit 2026-07-12b SEC-2, owner-declined probe):** the sweep covers
  symlink/junction dirents but not tar HARDLINK members (a hardlink is not a symlink dirent) —
  labeled hypothesis, likely moot (libarchive/bsdtar checks linknames; hardlinks need an
  existing same-volume target; the archive hash is owner-pinned). Owner ratified 2026-07-12:
  skip the one-time fixture probe; re-open only if the extraction path or tar binary changes.
- **L-8 — Lockfile / `npm ci` discipline — CLOSED 2026-09-03 (#260).** `package-lock.json` is
  committed; `setup-dev.{ps1,sh}`, CI and the release workflow run `npm ci` (issue #49); the one
  stale `npm install` instruction (`data-contracts.md`) was corrected. Anchor = the lockfile.

---
## 9. First real Windows `D:\` drive bring-up — durable lessons (2026-06-10)

> **Folded into [`docs/drive-layout.md`](docs/drive-layout.md)** as the §-numbered design record
> "First real-drive bring-up — durable lessons" (2026-08-20), per the CLAUDE.md doc-lifecycle
> rule: these are durable provisioning/path/manifest facts, not handoff state. Existing
> "BUILD_STATE §9" citations resolve via this stub.
