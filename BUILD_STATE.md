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

_2026-09-06 — **ZIM knowledge packs (PR #294 → #301) — Phases 0–6 CLOSED, Phase 7 (records, real acceptance, merge) in progress.**_
The PR's review remediation — 28 findings (H1–H4, M1–M11, L1–L9 with L10 withdrawn, DOC-1–DOC-4; three assessed High, H3 and DOC-1/DOC-2 Medium) — closed across P0–P6 on the integration branch `feat/zim-knowledge-packs`;
master merged in at P0 (`bfdb514a`) and again at P7 (`ddd704ad`). Durable records: `rag-design.md` §17 D-Z1–D-Z14 (with a §-anchor legend),
`data-contracts.md` "Knowledge packs", `security-model.md` "kiwix-serve — the one unauthenticated sidecar", `design-guidelines.md` §11.15. Correction to
the 2026-09-04 MVP entry below: its "Suite green (5660+)" and "no-arm path byte-identical, pinned" were the PR author's own claims — P0 replaced the
tautological byte-identity test with a fixture captured from master `bfdb514a` (L6) and counted 409 / 5,824 at the merge. Per-phase suite deltas: P0
411/5,841 → P1 5,854 → P1b 5,866 → P2 5,870 → P3a 5,918 → P3b 5,958 → P5 6,001 → P4 6,035 → P6 6,060 (5,980 / 79). Phase PRs (verified via `gh pr list
--state merged --base feat/zim-knowledge-packs`): #304 P0, #305 P1, #306 P1b, #307 P2, #309 P3a, #316 P3b, #317 P5, #328 P4, #336 P6. The ten per-phase
dated entries (P0–P6 + the 2026-09-04 MVP entry) are verbatim in `docs/build-log.md` under the 2026-09-06 P7 heading.
P7 (2026-09-06, this machine): master merged in (`f3d45517`, baseline 421 / 6,170 (6,088 / 79 / 2 = the preamble budget + the known OCR load race, green alone)); the T19 real-tool run found
a redirect-entry defect (fix `a4967594`, +10 tests) and the stale last assertion of the real smoke; final code tree `bcff9a17`: build + typecheck green, **421 files / 6,180 tests (6,100 passed
/ 79 skipped), exit 0** — the later commits are records-only; the Opus review found no defect candidate; T19's owner legs + T18-b pending — owner.

_2026-09-05 — **Model library UX fix wave (PR #302, `feat/model-library-ux`), ready for merge
(owner squash-merge; keep the branch):** searchable On this drive / Browse views, task/family
filters and expandable quantization groups (`docs/design-guidelines.md` §15, user-guide §5/§6);
F2 keeps a failed/unverified download's named result with Retry/Dismiss; F3 keeps repair-state
models visible and auto-expands their groups; F5 fronts a tied group with an obtainable variant;
a catalog guard plus F7 cleanup retire dead keys/CSS and add an unused-i18n-key guard. Rebuilt
on master as UX-only: Flash-Next (`feat/qwen38-flash-next-manifest`) split out, contained here
only, tracked as follow-ups #310/#311/#312 (shards, Flash-Next landing, GPU ladder) plus
#313/#314 (family filter, renderer-reload recovery) and #315 (review residuals). Final head =
the PR #302 tip (CI green on every phase); 379 / 5,784 passed, 74 skipped locally._

_2026-09-03 — **Audit 2026-09-02 Phase 9b — round close-out (PR #282): the durable ledger
`docs/architecture.md` §52 (every finding ID → issue, disposition, PR and the facts as fixed; the 46
non-findings; containment items 1–8; the 14 decisions on their defaults; B1..B9 ports; a §-anchor
legend for the deleted working papers); §5 item 19 → ROUND COMPLETE with the open residuals; the
round's eleven dated entries archived verbatim to `docs/build-log.md`; containment items 4 and 7
promoted verbatim to `known-limitations.md` (decisions #221/#222/#226 still unanswered); the three
Phase 0 doc lines that still carried audit IDs now cite issues; decision issues #218–#231 and
#262/#263/#264 closed "default stands — re-open on request" / "accepted — §52"; #217 closed after the
merge; the five `tmp/` working papers deleted after the merge.**_ Open Phase F: #236, #240, #243, #247,
#248, #250, #274 (each self-sufficient — its plan detail was copied to the issue). Docs-only, no launch
smoke. Suite: 371 / 5,570 / 74 excluding the Electron smoke (raw 372 / 5,576 / 74; the smoke ran).

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
budget) —
citations of the form "BUILD_STATE <date> entry" / "BUILD_STATE V1" /
"Skills — Sn handoff" resolve there._

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
         `finish_reason` (`stop`/`length`), and error-frame shapes. The parser is well covered but
         only against hand-authored fixtures, now provenance-pinned to the b9849 output shape in
         `read-chat-sse.test.ts` + `llama-runtime.test.ts` (**re-verify those frames on a runtime
         pin bump**).
       - (b) **real-model + RAG answer quality** (grounding, citations, refusal discipline).
       - (c) **`ragMinSimilarity` vs the real E5 distance distribution** (the mock embedder's
         distances are synthetic).
       - (d) **server concurrency** (multiple slots / overlapping requests on one sidecar).
       - (e) **per-model bring-up + prompt-template / stop-token leak** (each GGUF's chat template).
       - (f) **all perf numbers** (tok/s, peak RSS, model load time).
       - (g) **real GPU behavior** — the fake-spawn unit tests cover the ladder LOGIC, not drivers;
         see item 1b's ①–⑨ hardware matrix for the driver-level legs.
       - (h) **b9849 verbatim-capture re-take (F-40, audit-2026-07-16)** — the GPU `--list-devices`
         fixture (`list-devices-b9585-vulkan-rtx3080ti.txt`) and the vision SSE sample
         (`vision-sse-sample.txt`, still `system_fingerprint b9585-…`) were captured on b9585; the
         runtime pin is b9849. On the next smoke session re-run `llama-server --list-devices` + one
         vision stream, commit b9849-named captures, and MOVE the byte-pinned assertions with them
         (`gpu.test.ts` freeMb 11525 / the CRLF check; `vision-sse.test.ts` the split-UTF-8
         "Müller & Söhne" reconstruction — a fresh capture must preserve a multibyte-split frame).
         If the parse fails, that parser fix is the real payload. Until then the b9585 fixtures
         guard the b9585 shape only (M-A5 is observation-triggered — see the `gpu.test.ts` header).
       - (i) **real-server mid-stream error-frame smoke (F-02 / §Q Q-2, audit-2026-07-16)** —
         Phase 4 made `readChatSSE` REJECT on an in-band error frame (`data: {"error":{…}}` or a
         bare `error: {…}` field line), pinned only against hand-authored b9849-shaped fixtures.
         Force a REAL llama-server mid-stream failure (tiny `--ctx-size` + context-shift disabled,
         `HILBERTRAUM_*` env) and verify the reader rejects and the friendly `main.chat.streamError`
         copy surfaces (never raw model/runtime text). Also watch the PARTIAL-frame case: an error
         frame truncated mid-write (`data: {"error":{"mess` + close, no `[DONE]`) must parse as a
         keep-alive and end the stream CLEANLY (Phase 4's scoped close-without-`[DONE]` semantics).
   - **TS-7 (owner call — CI minutes):** add a `macos-latest` CI leg. The suite is offline and
     Electron-binary-free, and cross-platform path bugs have historically been caught only by the
     Ubuntu leg.
   - **TS-9 (pending owner D1):** the S13a suggestion-selector eval tier measures + prints its
     baseline without a hard bar (the AUTO-FIRE precision bar IS a live CI gate); ratify the
     suggestion bar (record: [`docs/architecture.md`](docs/architecture.md) §18 "Suggestion-selector
     baseline", the durable home since `docs/skills-s13-plan.md` §3.3 was deleted at S13 close) so
     measurement-without-assertion doesn't silently become permanent.
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
      restart-required mid-session installs for transcriber/reranker/embedder · the open GPU
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
      (the labelled (a)–(g) sub-list; SSE fixtures carry b9849 provenance comments —
      re-verify on a runtime pin bump);
    - **fix-when-touched polish candidates** (all Low; mechanisms in §47): mock-backend engine
      first-install refusal exemption (CODE-13) · SettingsScreen mounted-guard narrowing
      (CODE-7) · the `generateGroundedAnswer` canned-answer persist guard (CODE-18) ·
      PreviewModal `key={preview.id}` (CODE-35) · SkillsTab `setAutoFire` failure key (CODE-37) ·
      the `diag.bench.cores` plural pair (CODE-8 net allowlist) · the older DE ASCII-quote
      closers sweep (CODE-25) · a direct GAP-5 batch-skip test · exporting `TOKENS_PER_WORD` for
      the compare-budget tests;
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
    family, exposure nil); ① GAP-1 push + tag decision; TS-7 (macOS CI leg) — item 7.

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
    (a) **mid-session OCR-asset refresh** — the engine is composed once at startup; installing
    `ocr/` files mid-session needs a relaunch (documented). Options: the translator-#40
    `onModelInstalled` re-composition analogue for the `ocr` role, or a "Check again" affordance
    on the `ocrMissing` banner — owner UX call. (b) **packaged OCR smoke, recognition leg** —
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
    protocol level). (f) **PreviewModal `ocrInfo` line renderer test** and a
    **two-queued-OCR-tasks-on-one-doc pin** (P6 review residuals; the behavior is benign —
    serialize + overwrite = the D33 redo — but unpinned).
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
    (a) **`.github/dependabot.yml`** — DEP-1 §5 #4, owner-APPROVED during this wave (D-4) to
    land as its **own PR**; this was the fourth hand-rolled dependency batch. Supersedes item
    16(d).
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
    init load from `app.asar.unpacked`. STILL OPEN (owner-runnable on the packaged build): the
    interactive recognition leg (photo import + "Make searchable (OCR)" on a scanned PDF) and the
    OCR window's runtime CSP leg; record machine/date/outcome here when run.**
    (d) ⚠️ **Electron 44 is a CUSTOMER-FACING decision, not a routine bump** — it removes macOS 12
    support and drops 32-bit Windows (ia32) + Linux armv7l. **E43 is the last series shipping
    prebuilt 32-bit binaries, supported until January 2027.** Decide deliberately with the drive
    product's OS matrix in hand; do not let it arrive as a Dependabot PR.
    (e) **electron-builder air-gapped builds** (upstream #10039) — eb fails in air-gapped
    environments even with a seeded cache, because `@electron/get` always fetches
    `SHASUMS256.txt`; fixed on master only, not in any 26.15.x. Affects BUILD machines, not the
    shipped app, but it rubs against the offline-first posture.
    (f) **Manual legs still owed by the owner** (P4's human-only items): the `defaultPath`
    dialog probe that decides whether Electron 43 pre-selects the host Downloads folder
    (owner decision D-2, conditional — if it fires, pass an explicit root at the
    `save-export.ts` seam), a real OS drag-and-drop onto the composer (`webUtils`), and a
    double-click launch of the portable `.exe`.
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
      `skills-installer`, `third-party-notices`, `ocr`, `rail-labels` tests), the katex hoist
      compare, `as unknown as` private-field injection — convert to behavioural assertions when
      touched; `FullSuiteGuard` cannot see dropped individual tests.

20. **#290/#291 — server `timings` → Diagnostics decode speed + per-answer speed line — CLOSED
    2026-09-04** (PRs #295/#300/#297/#299; #290/#291/#298 closed). Records: `architecture.md`
    "Per-answer speed line" §1–§3, `benchmark.md` / `model-benchmarks.md` §6.5. Text as it stood: `docs/build-log.md`, retired 2026-09-06 (P6). Residuals: none.

---
21. **ZIM knowledge packs — follow-up register (registered at the 2026-09-04 MVP; durable
    record: [`docs/rag-design.md`](docs/rag-design.md) §17 "Deliberately not built").**
    (a) **kiwix_tools provisioning** — P8 successor issue #339.
    (b) **Tier 2** (persistent import of selected articles into the corpus) — P9 successor issue #340.
    (c) **Evidence identity for archive citations — CLOSED.** Identity resolution: P2, record rag-design D-Z5; the "Open article from a review" residual: closed P6, record design-guidelines §11.15.
    (d) **Manual acceptance leg — CLOSED 2026-09-06:** the airplane-mode demo (the real K: drive, `wikipedia_de_*` packs + kiwix-tools 3.8.1, network off) passed as T19 (viii); record rag-design §17 "Real acceptance".
    (e) Observation for item 1b's matrix, measured 2026-09-04 on the i7-8550U + UHD 620: GPU auto-offload gains nothing on pp (56 vs 57 t/s) and LOSES 45 percent on tg (11 vs 19.6) — on this iGPU
    class `gpuMode: off` would be the better default.
    (f) **D2 parser hardware gate — CLOSED (re-ruled P1b).** Gate is the per-slice main-thread stall (≤5 ms on the i7-8550U); cooperative slicing shipped, `DEFAULT_SLICE_WORK` = 16 Ki, T02-c recorded
    (laptop leg 3, 16 Ki); P7 re-check via the 14900K P-core ÷ 3 proxy (laptop not re-run — not within 20% of a gate). Record: rag-design D-Z3.
    (g) **R-1 registered (P3a, 2026-09-05) — still open until (a):** `kiwix-manage` on a hashless install marker runs as `skip-legacy` (one logged warning) — no integrity claim for the manager
    until (a) proves install hashes for serve AND manage. Record: rag-design D-Z10.
    (h) **R-7 — CLOSED with recorded limits (P3b).** Record: known-limitations `zim-transient/` bullet.
    (i) **R-9 accepted (owner ruling 2026-09-05; recorded by P5 on 2026-09-06):** kiwix-serve is the one sidecar without request authentication; bounded by the `withServer` alive/generation guard + one admitted retry; recorded in
    security-model / PRIVACY / known-limitations. R-8 (`--urlRootLocation`) stays a documented unused option.
    (j) **P4 — CLOSED (2026-09-06):** M3/M6/M7/M8/M10 — effective documents-off scope, reranker-failure interleave, fair pack allocation under a per-ask deadline, refreshable searchability, per-ask
    pack outcomes. Record: rag-design D-Z4/D-Z11/D-Z12.
    (k) **P6 — CLOSED (2026-09-06):** T18-a implemented (design/frontend review); the (c) "Open article from a review" residual closed. Record: design-guidelines §11.15.
    (l) **P7 residual register (2026-09-06):** the collision surface (`packs:status.excluded` addition — P9 issue; served-library fact, not a pack-row fact — the per-answer "not-served" row covers it
    today); PacksPanel: an unavailable pack can only be removed, not disabled (low, P9); every row's action buttons disable while one row is busy (low, P9); ChatScreen refetches on both
    `reconcile-start` and `-end` of one epoch (cosmetic, P9); the pack meta line shows the raw ISO 639-3 code unlabelled (copy nit, P9); `.footer-menu-btn` has no overflow rule of its own (low, P9);
    accepted deviation: the ScopePopover is non-modal (design-guidelines §11.15 decision 1, P6); T18-b — RECORDED 2026-09-06 (run by the orchestrator at the owner's request in real Electron against the real packs; rag-design §17 "Real acceptance" → "T18-b"; it surfaced T19 finding 3: kiwix-serve 3.8.1 win-x86_64 cuts ~5–20 % of large /raw reads short (the body's last part never arrives) — upstream, mitigated by the P7 fix PR 2, upstream report on #339); T19 the owner's Electron/drive legs — (vi) the relocated drive with
    persisted citations and (vii) live lock/unlock/failed lock PASSED 2026-09-06 on the real K: drive (rag-design §17 "Real acceptance" → "The owner's legs"; observations: a failed lock leaves the chat
    engine stopped until a model is re-selected — own follow-up; a pack added via Add packs… stays searchability-unknown until Refresh; LaTeX echoed in answers — #340), (viii) the offline ask + viewer PASSED
    (item (d) closed) — T19 complete; the orchestrator's machine legs are recorded in rag-design §17 "Real acceptance"; R-1 open
    until P8 (the acceptance bundle has no install marker ⇒ `skip-legacy`); R-2 multipart unsupported; R-4 Authenticode — result recorded at P7 in model-policy.md; R-6 → P9; R-9 accepted
    (2026-09-05). From P7's T19: kiwix-manage 3.8.1 refuses non-ASCII archive paths on Windows (registration-only — kiwix-serve serves such a file from UTF-8 XML; documented in
    known-limitations / troubleshooting; a reason-specific message or metadata without kiwix-manage — P9); the retrieval-quality levers L1 (title-index `/suggest` arm), L2
    (`ARTICLES_PER_PACK` scaling with archive size), L3 (question→keywords rewrite before `/search`) — P9 (L4, the aggregation-question expectation, landed in known-limitations).

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
