# BUILD STATE — HilbertRaum

> **This is the handoff/transport file between build steps and sessions.**
> Read this FIRST at the start of every session. Update it at the END of every phase
> (see "Per-phase ritual" in [`CLAUDE.md`](CLAUDE.md)).
> It carries: current status, decisions, next actions, open issues — plus dated entries for
> the **currently-open waves only**. Shared data contracts live in
> [`docs/data-contracts.md`](docs/data-contracts.md) (§4 below is a pointer stub).

> **Retention rule (2026-07-12):** this file must stay readable in one pass — a hard budget
> (≤ 300 KB / ≤ 2,000 lines) is enforced by `repo-hygiene.test.ts`. At each wave close-out,
> after the durable design record is folded into the topic doc (CLAUDE.md doc lifecycle rule),
> move the wave's dated entries **verbatim, newest-first** to the top of
> [`docs/build-log.md`](docs/build-log.md). New entries stay short: outcome + pointers to the
> design record and commits, not a full narrative — the narrative belongs in the record.

> **Snapshot correction (2026-07-10):** the "UNPUSHED" / "UNMERGED" state notes inside earlier log
> entries were true when written but are snapshots — as of 2026-07-10 `master` is pushed (in sync
> with origin through `ac4f315`) and the 2026-06-30 audit branch stack is merged. Only the branches
> named in §5's branch analysis still carry unmerged work.

_2026-07-23 — **Full-audit 2026-07-23 remediation wave OPENED (branch `fix/audit-2026-07-23-remediation`, P0): a whole-repo eight-persona audit of `master` `bbf26add` (v0.1.55) confirmed 26 findings (0 Critical / 0 High / 7 Medium / 19 Low) + 4 design observations; the working papers are committed verbatim by this wave-open commit and retired at close-out.**_
Wave scope: AUD-01 (documents "Answer without it" undo silently CASCADE-deletes an evidence review — the only data-loss item), AUD-02/AUD-03 (the "Lock now" teardown window admits fresh content-surface starts / a post-lock `llama-server` auto-start; one shared lock-in-progress latch fixes both), AUD-04 (Translate adopt clobbers a held terminal result / hijacks a Documents-row translation), AUD-05 + AUD-24 (PowerShell provisioning scripts: `Write-Error` under `$ErrorActionPreference='Stop'` makes the tolerant continue paths dead code; mismatch redo re-downloads without deleting), AUD-06 + AUD-18 + AUD-20 (hygiene NUL/BOM nets skip `launchers/` and all shell/launcher extensions; the packaged-CSP guard degrades to a green skip; script-drift covers only the `.ps1` matrix), AUD-07 + AUD-21/22/23 (docs still present packaged OCR as "verify at release" though it is a verified app-killing crash; four broken `docs/docs/…` links; two catalog omissions), AUD-08…AUD-17 (evidence-pack/review correctness, a11y/i18n, and the O(N)-per-open review-chip IPC fan-out class), AUD-19/25/26 (exhaustiveness tooth, dead exports, CI Node/npm below the engines floor), and DV-1/DV-2 (native `<select>`s bypass the token system; the model picker leads with un-runnable models when no recommendation exists). Verified-and-dismissed, NOT in this wave: a refuted rank-0 RAM-sampling candidate, and an engine-download tar-child-on-quit sighting that is a live extension of §5 item 9 (recorded for a future downloads-teardown wave). Convention: ONE branch, one commit per phase, single PR at close (the OCR-R/DEP-1 audit-wave convention). Baseline at open: typecheck ✓, repo-hygiene 12/12, `tests/unit` 1656/102 files; the full suite runs once at the verification phase per the weak-box discipline.
**Phase log** (one line per phase — the retention budget is tight, so this wave keeps ONE dated entry instead of one per phase): P0 wave open — branch created, working papers committed verbatim, baseline recorded. · P1 **AUD-01** — the documents "Answer without it" undo could silently CASCADE-delete an answer's whole evidence review (head, per-block decisions + notes, links, export history), and neither restore leg carried it back; now REFUSED at the one shared regenerate choke point both channels pass through, with the affordance disabled-and-explained in the transcript. RED→GREEN on four legs (successful re-answer, failure-restore, plain-chat channel, Stop-before-first-token); fresh-context adversarial verifier signed off (only two `DELETE FROM messages` exist in `src/`, the other is the warn-and-count conversation delete; 400-transcript fuzz found no target-row divergence; mutation-check reddens the data assertions). Durable record: the EP-1 record's post-wave amendment in `docs/architecture.md`. · P4 **AUD-05 + AUD-24** — under `$ErrorActionPreference = 'Stop'` a `Write-Error` is script-TERMINATING, which made the PowerShell provisioning scripts' deliberately-tolerant paths dead code: the OCR loop aborted at the first failed language file instead of attempting the rest, every `Write-Error …; exit 2` exited 1, and a child's error propagated out through `prepare-drive.ps1`'s `&` call and killed it before its own "a whisper miss is a warning, not a failure" branch — so on mac/linux, where the whisper family deterministically has no prebuilt build, `-WithAssets` provisioning aborted before the OCR step on EVERY run. All tolerant/config paths now use `Write-Host -ForegroundColor Red` + an explicit `exit` (the pattern the same scripts already used), child invocations are try/catch-wrapped, and the documented exit-2 codes fire again; `verify-models.ps1` carried the same dead-`exit 2` bug at an unlisted site (it would have killed the drive build before its NOT SELLABLE verdict printed). AUD-24: a checksum-mismatch redo resumed onto the corrupt file (unsatisfiable range → HTTP 416, a guaranteed no-op) — now deletes first, but ONLY when the bytes on disk already reach the manifest's `size_bytes`, so a part-downloaded multi-GB weight still resumes across runs as documented. Verified on the real host against a local range-aware server (complete-but-wrong → full refetch in one run; short partial → `Range: bytes=1000-` → 206, tail only). · P3 **AUD-04** — `adoptActiveFileTranslation` guarded on `busy`, which is false in every TERMINAL state, so a Translate-screen mount wiped a COMPLETED translation's held output/gaps/truncated/resultDocumentId with a fresh "Translating…" frame; and because it never consulted the global doc-task store (unlike `guardStart`), plain navigation pulled a **Documents-row** translation into the panel — Stop then cancelled that foreign task and its output loaded as if it were a file translation. Guard is now "this store is idle" on BOTH the entry check and the post-await re-check (a rejected drop lands `failed` synchronously, so the busy-only re-check would have replaced the banner the user just triggered), plus a foreign-task check against the global store. Three RED cases, each isolating one component so no single change makes all three pass; the genuine post-reload recovery keeps a new explicit pin. Residual recorded in `known-limitations.md`: after a real reload the global store is empty too, so a Documents-started translation is still adopted — benign (the user's own task, real progress/Stop/result). · P2 **AUD-02 + AUD-03** — "Lock now" runs a multi-second AWAITED teardown before `lock()` nulls the DB, and every admission guard was a bare `isUnlocked()` (literally "the DB handle is non-null"), so a doc task / translate / image analyze / import landing in that window was admitted and — because the suspends are deliberately non-latching — lazily RESPAWNED the multi-GB sidecar the teardown had just killed, outliving the lock; separately, a model auto-start parked minutes in `computeInstallState` hashing a multi-GB weight spawned `llama-server` after the lock completed. Fixed with one `beginLock()`/`isLocking()` latch armed as the handler's first act, a shared `workspaceAdmitsWork()` predicate behind all 15 IPC guards + 3 service-level guards (each keeping its own localized copy), and a post-hash unlocked/not-locking + **unlock-epoch** re-check so a lock-and-re-unlock during the hash refuses too. Fresh-context adversarial verification enumerated all 128 `ipcMain.handle` registrations and found no missed content-bearing surface, and found two defects that were then fixed: the failed-lock disarm had a **tautological** test (deleting the disarm left 65 tests green — an ENOSPC lock would have left the workspace open and permanently latched), and a throw anywhere in the teardown could strand that same state, so the disarm is now **structural** (`beginLock()` → `try { … } catch { if (isUnlocked()) cancelLock(); throw }`, one disarm point). The QUIT teardown had the same window and now arms the same latch: refuted for translate/embedder/OCR/chat (quit latches permanently), but CONFIRMED for **vision** (a fresh ~4.6 GB `llama-server` orphaning at `app.exit(0)`) and for **import** (a plaintext transient stranded between write and shred). `architecture.md`'s "sidecars only ever start post-unlock" claim is now true and says what enforces it, naming the remaining `forceRestart` seam as a gap. · P5 **AUD-06 + AUD-18 + AUD-20** (test-only) — the NUL/BOM nets' shared extension filter excluded `.sh`/`.ps1`/`.cmd`/`.command` and neither net walked `launchers/` at all, so the byte-0-sensitive artifacts copied onto every commercial drive were unguarded: one BOM'd save (PowerShell 5.1 writes BOM'd UTF-8 by default on this dev box) and the mac/linux launchers silently stop executing for a buyer, through a green gate. Filter widened + `launchers/` added to both roots; every tracked script/launcher in the repo is now inside a net (verified by exclusion). The packaged-CSP guard's `describe.skipIf(!built)` degraded to a green skip of BOTH real security assertions on any output-layout drift — CI positive control added, plus a page-set pin closing the half the finding missed (an ADDED renderer page left `built` true and its baked CSP never inspected). `script-drift` gained the `.sh` runtime matrix, and the guards handed over by the provisioning phase: no `Write-Error` in the provisioning `.ps1`, the mismatch delete stays nested inside its size guard, and both call sites still pass the size argument (that guard fails OPEN, so a dropped argument would silently disable it). Also a new latch pinning every bare `isUnlocked()` under `src/main/` against a 12-entry allowlist, so the wave's `workspaceAdmitsWork()` conversion cannot silently drift back. Ten teeth checks, each planted and removed.

_2026-07-23 — **Issue #84 FIXED (branch `fix/issue-84-fts-timing-budget`): the CODE-4 FTS-delete timing test no longer flakes on starved CI runners — bound 100 → 500 ms + an explicit 60 s per-test timeout for the 50k-corpus seeding.**_
The 100 ms budget ("wide CI headroom" over the ~3 ms post-fix measurement) flaked 4× in 5 days across both OS legs in two modes: the timing assertion itself (112.57 ms, ubuntu, PR #83's first run) and the whole-test 15 s vitest timeout during `seedLargeCorpus` (windows 2026-07-19 DEP-1-merge run; windows again in PR #85's second run). Fix per the #84 proposal, test-only: the bound rises to **500 ms** (still fails the ~3 500 ms scan-regression signature by 7×; the sibling EXPLAIN-QUERY-PLAN assertions remain the noise-free structural guard that the AD/AU triggers stay rowid-targeted), and the timing `it()` gets an explicit **60 s** timeout so seeding can't hit the global 15 s budget on a slow runner. No src change; the regression the test guards is unchanged in detectability.

_2026-07-23 — **DEP-2 mini-wave: the post-DEP-1 advisory batch cleared — Dependabot alert #56 (brace-expansion, the only open alert) + the four packages `npm audit` already saw ahead of Dependabot's scanner; lockfile-only, `npm audit` 0 vulnerabilities again.**_
Trigger: alert #56 surfaced 2026-07-21 (GHSA-3jxr-9vmj-r5cp / CVE-2026-13149, brace-expansion exponential-time `{}` DoS, dev-scope) — analysis found `npm audit` flagging four MORE packages Dependabot had not yet alerted on (advisory-DB lag): **tar 7.5.16 CRITICAL cluster** (4 advisories incl. decompression/parse DoS; electron-builder/node-gyp chains), js-yaml 4.2.0 HIGH (merge-key quadratic CPU; electron-builder's copy — the app's own manifest parser is the separate `yaml` prod dep, never affected), fast-uri 3.1.2 HIGH ×2 (ajv chain), and **dompurify 3.4.11 LOW — the one PRODUCTION-scope member** (streamdown → mermaid, ships in the renderer; `CUSTOM_ELEMENT_HANDLING` bypass, a config mermaid doesn't use). Fix per the DEP-1 §2 decisions: `npx npm@11.6.2 audit fix --package-lock-only` (every lockfile write through the pinned npm; hash-verified stable across a second run), exactly 10 version entries moved, ALL semver-compatible patch/minor, no manifest edits, no majors: tar **7.5.21**, js-yaml **4.3.0**, fast-uri **3.1.4**, dompurify **3.4.12**, brace-expansion **1.1.16 / 2.1.2 / 5.0.8** (all seven in-tree copies now patched). Gates (DEP-1 order, fresh `npm ci` in an isolated worktree): audit 0 ✓, typecheck ✓, build ✓, full suite ✓. Branch `fix/dependabot-2026-07-23`, single commit, squash-merged once green; alert #56 auto-resolves on Dependabot's master rescan (the DEP-1 merge-minute precedent) — verified via API at close-out, recorded in the PR. CHANGELOG "Security" DEP-2 bullet added. The DEP-1 §5 follow-up register is unchanged (its item 4 — a grouped-weekly `dependabot.yml` — would have turned this batch into ordinary PRs; still owner-gated).

_2026-07-23 — **Gemma 4 QAT wave (issue #82): four official-Google QAT Q4_0 chat manifests added — E2B / E4B / 26B-A4B (MoE) / 31B — all rank 0, text-only, license-approved; E2B + E4B in-app-smoked on b9849.**_
The rest of the Gemma 4 collection evaluated around the shipped 12B winner (full record: issue #82 + model-policy.md "Gemma 4 QAT wave"). Added: `gemma4-{e2b,e4b,26b-a4b,31b}-it-qat-q4` — official Google QAT GGUFs (first-party provenance, Apache-2.0 via HF API card tags, ungated), real LFS-OID hashes, `recommendation_rank: 0` + not bundled until the local grounded-QA eval promotes them (§9 gate); the 26B-A4B MoE (~3.8B active) is the headline challenger to the promoted Qwen3.6 27B Q4 at 24 GB, and supersedes the `gemma-4-26b-q4` local-test stub for distribution. NOT added: diffusiongemma (no llama.cpp support), the `-it-assistant` speculative-decoding drafts (parked — no `--model-draft` wiring), base variants. Smokes on a local DIY test drive (0.1.48 `package:win` + b9849 win-vulkan): hashes CONFIRMED by real fetch+verify (E2B/E4B/26B); b9849 LOADS all three smoked archs (MatFormer E-series + first Gemma MoE); **E2B + E4B in-app smoke PASSED** (owner, 2026-07-23); finding — **E4B/26B think by default** (unlike the 12B; `enable_thinking:false` suppression check joins the promotion smoke; the #50 short-cap class applies; also contradicts the local-stubs' "no thinking toggle" comment — the smoke decides). Open: 26B in-app smoke + peak-RSS on a ≥24 GB box (16 GB mmap-thrashes, gate works), 31B load smoke, RAM recalibration from measured RSS, owner-gated eval → rank decisions. Docs: model-policy (wave section + table rows), READMEs; tests: `committed-catalog.test.ts` gains the wave-invariant block (E2B pinned to the small-tier 16 rec-RAM floor after the wave test caught a rank-0 comfortable-fit hijack at 12 GB). Merge review (PR #83, 2026-07-23, adversarially verified 6-dimension pass): all four hashes/sizes/licenses independently re-confirmed against HF (tree-API LFS OIDs + resolve-endpoint headers; repos official-google, ungated, apache-2.0); review fixes landed pre-merge — model-benchmarks **§9.3** added (the wave's must-beat table + per-size smoke state; §9.2 D38 gains the fetched-after-all update marker), wave test block hardened (RAM + displayName + thinking-flag pins per the Qwen3.6 precedent; never-recommend RAM sample +14/+20 in both wave blocks), the "4–6 GB" MoE disk-delta corrected to **4–8 GB** (the 35B-A3B is 22.2 GB decimal, not 20.6), and the riding CLAUDE.md design-system section RESCOPED (design-guidelines.md stays canonical for in-app UI — light-default dual theme, token-contrast-pinned accents; the `hilbertraum-design` skill + dark-only brand rules scoped to maintainer marketing surfaces; "Kit" naming tied to TRADEMARKS.md, lower-case "drive" prose unaffected). Known flake, not this wave: `fts-rowid-sync` 100 ms timing leg reddened the first ubuntu CI run (112.6 ms; second flake in 5 days) — follow-up issue filed at merge.

_2026-07-20 — **STR-1 wave CLOSED (P0–P5): the 2026-07-19 skills/tools architecture review executed and retired — §5.1 IMPLEMENTED (ingest extract pass grammar-constrained), §5.2 filed as issue #80 (owner-gated, not built), §5.3–§5.5 doc notes landed; single PR #81.**_
Outcome only — the narrative lives in the record. Branch `fix/skills-review-2026-07`, phase commits P0 `246dc028` (review committed verbatim — the git-history copy) → P2 `f4b8ca2d` (extract pass onto the D55 `responseSchema` contract: `EXTRACT_RESPONSE_SCHEMA`, top-level `{type,value}[]`, enum tracks `EXTRACT_RECORD_TYPES`, schema on BOTH attempts, prompt still describes the shape; **#50 hardening retained in full** — grammar stops neither reasoning-burn nor cap-truncation nor the mock; tests RED→GREEN, +2 pins) → P3 `103d9deb` (§5.3 revisit trigger → Skills record §6; §5.4 thinking-checkpoint criterion → model-benchmarks §9 + item 8 below; §5.5 interop note; the condensed record) → P5 (this close-out). Durable record: **`docs/architecture.md` "Skills & tools architecture review (2026-07-19) — design record (wave STR-1, 2026-07-20)"** (verdict: state of the art for the constraints, no architecture change; the deliberate no-change decisions on native tool calling/MCP/locate/suggestion/permissioning with external evidence; §5.1–§5.6 disposition table; the §5.6 `supports_tools` watch item; §-anchor legend — `STR-1 §5.N` citations resolve there). Review working paper DELETED (`git rm`; full text = the single `docs/` file added by wave-open commit `246dc028`); repo-wide filename/link sweep: **zero hits in the tree**. CHANGELOG "Changed" entry added; rag-design §14.5 + known-limitations updated as-built at P2 (docs and code agree at every commit); two pre-existing stale architecture.md claims ("GBNF not plumbed through the runtime seam") reconciled in passing. Deferral register: **§5 item 17**. Gates (this close-out): typecheck ✓, build ✓ (4.73s), full suite **4680 pass / 50 skip / 4730 total, 334 files** — baseline 4678/50 + exactly the 2 new §5.1 pins.

_2026-07-19 — **DEP-1 wave CLOSED (P0–P5): all critical/high Dependabot alerts cleared — PR #77 merged as squash commit `a09d0939`; API-verified 0 open / 55 fixed (0 dismissed); `npm audit` 0 vulnerabilities.**_
Outcome only — the full narrative lives in the record. Branch `fix/dependabot-2026-07`, six phase commits `0e496aa4`→`9f26ab8a`→`b2adef9c`→`4bf3249b`→`606796c2`→`ee9f02b8` (P0–P4 + the csp-meta interlude fix), merged once (2026-07-19T07:57Z). Durable record: **`docs/architecture.md` "Dependency remediation — design record (wave DEP-1, PR #77)"** (§1 scope/outcome, §2 decisions, §3 the Electron-39 re-verification ledger — supersedes the OCR-R BE-2 Electron-37 CSP measurement — §4 wave discoveries, §5 follow-up register + §-anchor legend; the register is also mirrored below at this file's own §5 item 16). CHANGELOG "Security" entry added. Gates (this close-out, docs-only): typecheck ✓, build ✓ (5.08s), full suite **4678 pass / 50 skip / 4728 total, 334 files** (170.87s) — exact parity, no retry needed. Plan file (`docs/dependabot-remediation-plan.md`, never committed) deleted by the orchestrator after this record landed.

_2026-07-18 — **New `docs/skills-overview.md`: the 9 bundled skills at a glance (what each can do, for users + coding agents), pinned in sync by test.**_
Owner-requested docs addition. The overview lists every `app-skills/` skill with id · version · capabilities and carries the keep-in-sync rule (review it on every skill add/remove/change); the rule has teeth — a new `skills-skillmd-parity.test.ts` block (+11 tests) enumerates `app-skills/` from disk and pins each id + current version into the doc both ways (added skill / version bump / removed skill each fail until the overview is reviewed). README links it (feature bullet + Documentation table). Suite parity file 46/46, repo-hygiene 12/12, typecheck green.

_2026-07-18 — **OCR-R wave CLOSED (P0–P6 + close-out): all 18 findings + 5 test gaps of the 2026-07-18 OCR audit Fixed or Deferred-with-registration — scanned-PDF OCR is startable from the UI again (FE-1 Critical). Both working papers retired per the doc-lifecycle rule.**_
Outcome: ONE branch `fix/ocr-remediation-2026-07-18` (owner-amended from the stacked per-phase audit-wave convention), six phase commits (P0 `0b6951ea` wave open, P1 `6fa66995` initiation interlock, P2 `f2d5b550` Translate handoff, P3 `0687a437` docs truth, P4 `f8f3dc29` backend hardening, P5 `d0579d25` packaged CSP + harness) + this close-out, merged once as **PR #75**. Suite 4625/49 → **4664/50** across the wave (the +1 skip is the build-output test's deliberate no-build-present guard leg); typecheck + build green at every phase gate; every behavioral fix landed RED→GREEN with the pre-fix failure captured. Durable record: **architecture.md "OCR audit (2026-07-18) — remediation ledger (wave OCR-R, PR #75)"** — self-contained per-finding dispositions, the design decisions with their declined alternatives, the deferral register, and the §-anchor legend (`ocr-audit 2026-07-18 <ID>` / `OCR-R P<n>` / `test-gap #n` citations in commits/comments/tests resolve there). **P6 independent adversarial verification** (fresh-context, re-derived every fix from the wave diff against the audit's mechanism descriptions, 272 OCR-relevant tests re-run green): all 18 + 5 verified Fixed or properly Deferred, NO wave-introduced regressions; its residuals are recorded in the ledger (BE-7 microtask-gap single-timeout degradation, FE-5 remount cosmetic) and its two BUILD_STATE count nits were corrected before this archive rotation. Headline P5 measurement: on Electron 37 the `onHeadersReceived` CSP header DOES attach and enforce on `file://` in both windows — measured on a real packaged build, not guessed; the meta was the second layer still advertising the dev localhost relaxation, now generated strict at build time from one source of truth. Working papers DELETED (`git rm`; full text on wave-open commit `0b6951ea` — `git show 0b6951ea --name-only` lists both under `docs/`); repo-wide reference sweep to the deleted paths: zero hits in the tree. The wave's six dated entries moved newest-first to the top of `docs/build-log.md` — verbatim except the two working-paper path strings in the wave-open entry neutralized to prose (the close-out zero-reference rule); no relative markdown links needed de-linkifying. CHANGELOG "Fixed" entry added; design-guidelines' present-tense §11.6 guidance updated to the inline-button reality (dated records left as historical snapshots, noted in the ledger). Deferrals registered in **§5 item 15** (a–f: mid-session asset refresh · packaged recognition-leg smoke · macOS/Linux packaged smoke · BE-7 memory profile · pdfjs-side tests · PreviewModal `ocrInfo` + two-queued-tasks pins).

_2026-07-18 — **EP-1 Evidence Pack / Review Mode wave CLOSED (P0–P6 + close-out): feature COMPLETE — review a document-grounded answer, record explicit decisions, export evidence packs as self-contained HTML or PDF, fully local and offline. Both working papers retired per the doc-lifecycle rule.**_
Outcome: 7 PRs merged (#66 wave-open docs, #67–#72 P0–P5) + branch `feat/ep1-p6-pdf-closeout` (stage A PDF `30826191`+`a3b4d8b8`, stage B = this close-out; PR at close). Suite 4300/49 → **4625/49** across the wave; typecheck + build green. Durable record: **architecture.md "Evidence Pack / Review Mode — design record (EP-1, §1–§8)"** with the closing §-anchor legend (built from the citations actually in the tree — `spec §N`/`plan §N`/`D-N`/`FR-N`/`review FIX-N`/watch-outs all resolve there); shapes stay in data-contracts.md, honesty read-model rag-design §16, UI rollout design-guidelines §11.12/§11.13, export boundary security-model.md, honesty entries known-limitations.md, user-guide §7. Working papers DELETED (`git rm`): `docs/evidence-pack-implementation-plan.md` + `docs/evidence-pack-review-mode-feature-spec.md` — full text at `git show b77295c0:docs/evidence-pack-implementation-plan.md` (fullest state, Handoff Log P0–P5) and `git show b77295c0:docs/evidence-pack-review-mode-feature-spec.md`; every live reference re-pointed (CLAUDE.md parenthetical → "none are currently open"; data-contracts/rag-design/known-limitations headers → the design record). The wave's dated entries (stage A + P5…P0 + wave-open) moved VERBATIM, newest-first, to the top of `docs/build-log.md` — byte-verified against the pre-move file; the ONE relative markdown link in the wave-open entry de-linkified to inline code per the DOC-1/F6 recipe (the archive's no-relative-links rule), prose otherwise byte-identical. CHANGELOG feature entry + product-vision roadmap line added. **Spec §35 DoD 1–12 verified before deletion, per item:** (1) eligible answers expose Review evidence — `ReviewEntryPoints` visibility matrix ✓; (2) review created entirely from persisted local data — `evidence-reviews-ipc` under runtime tripwire ✓; (3) direct citations vs whole-doc provenance semantically distinct — kind map + exact-key wording pins ✓; (4) decisions, links, notes recordable — P2 store + suite ✓; (5) survives restart + encrypted lock/unlock — integration legs ✓; (6) missing/changed/partial/legacy/truncated honestly represented — P4 freshness states, `identity:'unresolved'`, `answerTruncated` ✓; (7) ready review exports deterministic self-contained HTML and PDF (as resolved by D-1: HTML input golden-deterministic, PDF via `printToPDF` smoke-verified) ✓; (8) pack carries question/answer/decisions/evidence register/source register/coverage/limitations/generation metadata — the nine §16.1 sections, 1×h1+8×h2 pin + 6 goldens ✓; (9) exports atomic + hashed — atomic tail, read-back sha256, failure legs ✓; (10) no model or network call for review or export — tripwire + real offline guard across every flow ✓; (11) a11y/EN-DE/security/offline test gates pass — §11.13 recorded audit, P5 German native pass, audit sentinel sweeps, suite green ✓; (12) documentation states the pack supports human review and is not a certification — known-limitations entry + the in-pack `packExport.support` line ✓. No unmet items; no standalone plan files remain.

_2026-07-17 — **Issue #54 FIXED (branch `fix/issue-54-aggregation-hint`, owner-signed-off option 1 of 3): a no-skill aggregation ask ("kategorisiere alle transaktionen … summe pro kategorie") no longer presents the raw amounts frequency list as if it were the requested categories-with-sums — the listing now LEADS with an honest shape hint + the bank-statement-skill pointer.**_
Root cause (verified against the as-built docs — this was the documented rag-design §14.5 "v1 caveat, still open"): the #37 `AGGREGATION_RE` deliberately routes categorization/sum asks to coverage-extract (never a lossy top-k sum), `mapQuestionToRecordType` collapses "summe" to the `amount` type, and `aggregateExtractions` can only `GROUP BY normalized_value` with counts — the categorize+sum intent is structurally unrepresentable on this path, the only engine that CAN serve it (the bank skill's `categoryTotals`) is unreachable without a turn skill (the A4 class-match inversion requires one; auto-fire is ratified opt-in default-OFF), and no hint fired because the #50 hint pair is empty-listing-only. Owner decision 2026-07-17 (options presented: hint on the listing / auto-route to the skill — reverses the S13b D4 posture / redirect instead of listing — withholds data): **option 1, hint on the listing**. Fix, minimal + routing-unchanged: new pure `isAggregationShaped` (router.ts, exposes the existing `AGGREGATION_RE`); `buildListingAnswer` gains additive `opts.aggregationAsk` — a NON-EMPTY listing then leads with `analysis.listing.aggregationHint` ("you asked for categories or sums, but this answer can only list the values found…") + `analysis.listing.aggregationHintAmountSkill` for `amount` (enable the skill, ask again); the EMPTY branch keeps its #50 pair (never a double pointer); `rag:ask` threads the flag at the coverage-extract branch. Plain list/count asks (`COVERAGE_RE` only, e.g. "Zähle die Ausgaben") are byte-unchanged; still 0 model calls. Tests +7 (teeth mutation-checked: wiring disabled → the IPC regression reddens): rag-skill-analysis IPC ×2 (the #54 repro leads with hint+pointer over the intact listing; plain-count control byte-unchanged), whole-doc-extract ×3 (amount hint+pointer lead + no-flag control, party → generic hint only, empty branch un-doubled), extract-router ×2 (`isAggregationShaped` EN+DE positives incl. both repro phrasings verbatim; list/count/ordinary negatives). Docs: rag-design §14.5 caveat updated AS-BUILT (incl. the declined alternatives), known-limitations "List every X" bullet. The structural fix (no-skill tabular routing over a generic row extractor) stays the result-tables §5/§6 deferral. Suite + typecheck green.

_2026-07-17 — **Issue #58 FIXED (branch `fix/issue-58-translation-page-gaps`): a source page with no extractable text can no longer vanish silently from a document translation — page-completeness accounting + inline gap markers + UI warnings.**_
Root cause (reproduced first with a synthetic 5-page hybrid PDF, `makeMixedPdf` text/text/image/text/text): a PDF page whose text-layer trims empty pushes NO segment (`parsers/pdf.ts`), page numbers were discarded before windowing (`extractSegmentTexts` kept only `s.text`), and nothing compared input pages to output — a 5-page document materialized as a seamless 4-page translation with no warning (scan detection deliberately ignores hybrids). Fix, all additive: (1) `ParsedDocument`/`DocumentPreview` gain `pageCount` (PDF: the DECLARED total — capped/empty pages count as content the output lost); (2) new `extractTranslationSource` keeps `{text, pageNumber}` + `pageCount` (compare's `extractSegmentTexts` now delegates to it); (3) `planTranslationBlocks` (pure, doctasks/translation.ts) plans windows interleaved with `gap` blocks from `computeMissingPageRanges` (O(segments), RANGES not lists — an M-2 crafted page count can't balloon memory; leading/middle/trailing gaps incl. the trailing case segment numbering alone can't see); gaps materialize as inline `missingPageNotice` markers at their true reading position (L12: localized at materialization, en+de, the `> ⚠` failed-window idiom); with no gaps the plan degenerates to EXACTLY `planTranslationWindows` (pinned); (4) `assertNoTextDropped` enforces the per-segment packing invariant (non-whitespace chars in == out) — a future planner drop fails the task loudly instead of shipping silently incomplete output; (5) `DocTaskStatus.gaps { missingPageRanges, failedWindows }` (additive, set only when incomplete; deep-copied in `getDocTask`; recorded in data-contracts.md) → `fileTranslateSession.gaps` → Translate-screen `hint warn` lines (`translate.file.gapPages.one/other` with formatted ranges "3–4, 7", `translate.file.failedParts.one/other` — the failed-window count reaches the UI for the first time, it was in-document only). Out of scope, recorded in known-limitations: per-page OCR for hybrid PDFs (scan detection + OCR offer still fire only for FULLY image-only PDFs); page accounting exists only for formats WITH pages — page-less sources rely on the packing invariant. Tests +22 (all watched fail pre-fix where applicable): integration ×7 (the repro, trailing gap, range collapse, no-gap/-txt negatives, failed-window status surfacing, German L12 notice), unit ×12 (`computeMissingPageRanges` edges incl. the 1M-page M-2 shape, block placement, degenerate-equality, `assertNoTextDropped` teeth, notice framing), renderer ×3. Docs: known-limitations "Document translation" (+the new bullet), architecture Document-tasks translation record (+the accounting paragraph), data-contracts (DocTaskStatus/DocumentPreview), user-guide honest-notes bullet. Suite **4293/49** + typecheck green.

_2026-07-13 — **PR #57: the no-direct-master-pushes rule stated prominently in CLAUDE.md (new top section) + CONTRIBUTING.md ("Commits & pull requests") — the repo is PUBLIC since 2026-07-12.**_
Docs-only contributor PR (`humaniser`; this ritual entry added at merge review). The rule codifies what the 2026-07-12 `master` ruleset already enforces (changes via PR, required `ci-success`, no deletion/force-push): never commit or push to `master` directly, even with bypass rights, docs included. In the same review pass, §5 item 10's "Flip to public" sub-item is checked off — observed done 2026-07-13 via the GitHub API (repo public, private vulnerability reporting ENABLED, the ruleset active, Projects disabled). Still open in item 10: branch cleanup, filing the open work as issues, and the pre-flip hygiene re-grep (overtaken by the flip having happened — needs an owner disposition note, not a re-run gate).

_2026-07-12: **Newest-Qwen promotion (owner decision): the recommendation tiers now point at the newest Qwen generation; the Qwen3.6 27B pair productized from local-test stubs; the stub [PRO] profile hijack fixed.**_
Owner decision 2026-07-12, durable record in **`model-benchmarks.md` §6.4** (rationale: a subjective owner judgment that newer model generations improve on the ones they replace; the §9 tester eval is treated as directional, its F1 being length-confounded, EM near-tied, single-run; follow-up quality + speed benchmarks recorded as open work in §5 item 8). This partially front-runs §5 item 8's ratify-and-complete sequence BY DESIGN: the rank/RAM/test/README edits land now on product grounds; the scorer fixes, owner ratification, §3/§4 speed+RSS rows for the promoted set (the tester runs were QUALITY-ONLY), and the §9.1 smokes for the 9B and both 27Bs stay open in item 8. Changes: (1) ranks: `qwen3.5-4b-ud-q4kxl` and `qwen3.5-9b-ud-q4kxl` 0→3 (eval standing recorded honestly in each manifest: the 4B FAILED its §9 F1 bar, the 9B sat under Ministral); (2) `qwen3.6-27b-q4`/`-q5` PRODUCTIZED (unsloth GGUF download blocks, real HF-LFS hashes, apache-2.0 reviews superseding the 2026-06-22 local-test scope, ram_gb 24/32, ctx 8192) and promoted to rank 3 (here the eval AGREES: they top the §9 quality table); (3) the five 2026-06-22 local-test stubs committed earlier today carried `recommended_profiles: [PRO]`, which HIJACKED the legacy profile picker from qwen3-14b and broke `benchmark.test.ts` on master (the push had bypassed the ci-success gate) — all five emptied per D17, the gemma stub pair (`gemma-4-26b-q4`, `gemma4-coding-q8`) and `qwen3.5-9b-q8` otherwise untouched (still rank 0, license G3 provenance issues still open in the private preload review). New mapping (asserted in `benchmark.test.ts` + `committed-catalog.test.ts`, incl. a new Qwen3.6 promotion-facts pin): **≤12 GB → Qwen3.5 4B, 16–20 GB → Qwen3.5 9B, 24 GB → Qwen3.6 27B Q4, ≥32 GB → Qwen3.6 27B Q5**. Docs: README tiers+table, model-policy catalog rows + ‡ footnote, model-benchmarks §6.3 superseded-note + new §6.4. NOT changed (follow-ups, deliberate): the bundled drive default (`qwen3-4b-instruct-q4`), the DIY `--with-assets` default set (Ministral), DRIVE-NOTICES regeneration if a Qwen3.6 model is ever preloaded.

_2026-07-12 — **`docs/design-review/` DELETED (contributor-clarity sweep, third item): the stale S6 composer-picker PNGs + the S12 run-surface recipe README.**_
Owner decision 2026-07-12. The 20 `skills-s6/` PNGs (2026-06-18) predate the composer/picker changes since (#46 SkillInfoCard/ⓘ among them) and had escaped the existing delete-captures-after-review convention (commits `5e53749`/`b8020b5`/`ecd58d5` deleted every other capture set). The `skills-s12/README.md` was NOT stale — it is the recipe for the OPEN R-2 run-surface eyeball residual — so its essentials were folded into the R-2 bullet in architecture.md (§23 skills-audit ledger) with a `git show f549ce8:` pointer to the full text. Breaks nothing: the six `walk-*.mjs` capture scripts `mkdirSync` their output dir on demand; design-guidelines' capture mentions are dated design-record narrative (kept verbatim per the Phase-4 sweep's bucket (b)). Docs-only.

_2026-07-12 — **Result-tables plan retired IMPLEMENTED: `docs/result-tables-plan.md` DELETED, condensed into the new architecture.md "Generic result tables — design record" (§1–§6 + D59–D67; §-numbers match the plan 1:1 so the ~25 in-code `result-tables plan §N`/`D59`–`D67` citations resolve unchanged, zero code churn).**_
Owner decision 2026-07-12 (same contributor-clarity sweep as the big-slot retirement below): all phases (1/1.5/1.6/2/3 v1) had shipped 2026-07-05 via PRs #14/#16 — the "plan" was a finished design record wearing a plan costume. Residuals (invoice `TableSpec` port, derived-column eval, no-skill tabular routing, remaining §5 deferrals) → record §6 + §5 item 10's issue-filing list; known-limitations' two plan links re-pointed to the record; CLAUDE.md's open-plan example → "none currently open" (no standalone plan file remains in the repo). Full original: `git show f2b628c:docs/result-tables-plan.md`. Docs-only.

_2026-07-12 — **Phase-30 plan retired unimplemented: `docs/big-slot-embeddings-plan.md` DELETED (contributor-clarity: neither track had started and the plan had drifted — stale b9585 pin, a Track-A candidate list overtaken by the §9 tester evidence).**_
Owner decision 2026-07-12, retired per the CLAUDE.md doc-lifecycle rule instead of rewritten. Disposition + the durable Track-B facts → **`model-benchmarks.md` §9.2** (D38 superseded by the Qwen3.5/3.6 evidence; D39 carried forward as §9's must-beat table; D42 merged into §5 item 8 step (a); D43 still open inside item 8's speed/RSS step; D40/D41 deferred with the F16/q8_0 compat hazard + reindex-UX notes). Open-work registration → §5 item 4 (rewritten: deferred post-MVP, reopen prerequisites listed); the D1 rider now lives solely in rag-design §10; CLAUDE.md's sanctioned-open-plan example → `result-tables-plan.md`; Phase-table row 30 updated. Full original: `git show 1e5d17e:docs/big-slot-embeddings-plan.md`. Docs-only.

_2026-07-12 — **BUILD_STATE restructure: the file had grown to 1.48 MB / ~11,200 lines — unreadable in one pass, defeating its "read this FIRST" purpose.**_
Split three ways, all moved content **byte-verified verbatim** against `git show HEAD`: (1) the 260+ closed-wave dated entries (2026-07-09 and earlier) + the Skills S2–S12 handoffs → new archive [`docs/build-log.md`](docs/build-log.md); (2) §4 data contracts → new [`docs/data-contracts.md`](docs/data-contracts.md) (pointer stub kept, so "BUILD_STATE §4" citations resolve); (3) this file keeps the header, open-wave entries, and live §1–§9 (§8/§9 stay — cited by `BUILD_STATE §9`/`R6` and §8 holds open deferred items). Retention rule added to the header + CLAUDE.md; budget (≤ 300 KB / ≤ 2,000 lines) enforced by a new `repo-hygiene.test.ts` block. README doc table gains both files. Cross-doc citations need NO churn: date-cited entries resolve via the archive pointer below.

_2026-07-11 — **Docs-consistency verification fix round (F1–F9): the post-housekeeping audit's findings remediated — literal-NUL in architecture.md fixed + docs/ added to the CODE-24 hygiene net, false CUDA-shipped claim corrected, legend rows repaired/extended, dead journal links de-linkified.**_
The audit that verified the housekeeping wave below found 9 issues; all fixed, none skipped (uncommitted on master alongside the wave):
- **F1 (HIGH):** docs/architecture.md carried a literal U+0000 inside the §47 CODE-24/DOC-12 ledger row (the same authoring-tool escape trap that row describes) — plain `rg`/`grep` treated the file as binary and silently stopped at line ~6966, hiding everything after it INCLUDING the spec-retirement §-anchor legend. Replaced byte-level with the intended 6-char `\u0000` text; the CODE-24 NUL-ban net in `repo-hygiene.test.ts` now also walks the repo `docs/` tree, with this file as the proof case. The class then recurred a FOURTH time — a literal NUL landed in THIS entry's F1 bullet while writing it up — so the net additionally scans repo-root `*.md` (non-recursive; node_modules never walked). +2 tests.
- **F2:** product-vision.md wrongly said Vulkan/Metal/**CUDA** builds "have since shipped" — the GPU record REJECTED CUDA as a default (~620 MB, NVIDIA-only; manifest schema leaves the door open). Corrected.
- **F3/F4/F5/F7:** retirement-legend row repairs — §18.1 now names the real i18n key `privacy.statement.offline`; §3.2 points at the "Swappable interfaces (spec §9.2)" heading (no "Sidecars" heading exists); §3.3's model-policy parenthetical reworded to the inline dropped-models note; §1.2-row extended with the live §1.1/§19 product-intent anchors.
- **F6:** 39 markdown links in HISTORICAL journal entries below pointed at since-deleted plan/audit files (and the removed `filing-suggestions` engine) — de-linkified to inline code, text otherwise byte-identical; the entries' prose is untouched.
- **F8:** packaging.md's USB-demo intro now notes step 4 assumes drive preparation selected the default model once (a factory-fresh tree bakes no `activeModelId`).
- **F9:** the skills §-anchor legend gained the four plan anchors still cited from shipping code (§22-H2 fence placement, §22-A2 safe extractor, §22-E2 magic-byte sniff, §22-E4 provisioning-script parity), sourced from the retired `skills-plan.md` §22 via git history.
Verification set re-run clean (NUL scan, dead-link scan, the stale i18n-key / "Sidecars"-heading strings zero-hit, `_Last updated` only in exempt journal/ledger prose). Suite **4167/47** (+2 = the F1 net extensions) + typecheck green.

_2026-07-11 — **Docs housekeeping: `_Last updated` stamps removed everywhere + the original MVP spec `CLAUDE_HilbertRaum_MVP.md` RETIRED (deleted; product intent → new `docs/product-vision.md`, §17 demo → packaging.md, `spec §N` anchors → architecture.md legend).**_
Two owner-directed structural cleanups, docs-only:
- **`_Last updated:` stamps deleted from every living doc** (SECURITY.md, PRIVACY.md, and all of docs/ — architecture/rag-design/security-model/model-policy/user-guide/troubleshooting/drive-layout/packaging/known-limitations/benchmark/design-guidelines; the last two kept their descriptive text, only the stamp clause dropped). Rationale: they duplicated git history and drifted (DOC-109 had to refresh five of them). **This supersedes the DOC-109 refresh-stamps practice — do not reintroduce or audit-flag missing stamps.** Deliberately kept: BUILD_STATE's dated journal-entry headers (a log, not freshness stamps) and, at the time, the frozen spec's stamp (file since deleted, below).
- **`CLAUDE_HilbertRaum_MVP.md` retired per the CLAUDE.md doc-lifecycle rule** (the last remaining working paper; it anchored 247 `spec §N` citations across 60+ files). A five-way parallel coverage audit of all 23 spec sections against the as-built docs found everything COVERED or SUPERSEDED except: product intent (§1.2–§1.4 thesis/persona/commercial-monetization list, §2.2 scope exclusions, §0.2/§3.1 "the drive is not RAM / honest about hardware limits" guardrails, §3.2 future backends, §19 future editions, §23 contrastive framing, §1.5 success definition incl. "success criterion #10") → condensed into **new `docs/product-vision.md`**; and the §17 canonical 14-step USB demo script (4 live cites) → **packaging.md "The canonical USB demo (original spec §17)"** (active-model name tracks the drive default; the spec's example was Qwen3 4B). All other `spec §N` cites stay byte-unchanged and resolve via the new **"Original MVP spec — retirement record & §-anchor legend"** at the end of architecture.md (after the Module ↔ spec map; full text: `git show ed1332c:CLAUDE_HilbertRaum_MVP.md`). CLAUDE.md read-first item 2 now points at product-vision.md; the Chat-&-streaming §7.6-prompt record's "retained in" sentence re-pointed to git history. Verification: zero dead links to the deleted file (remaining mentions are this journal, the retirement notes, and the legend — all intentional); the `git show` pointer resolves; suite **4165/47** + unchanged (docs-only). Uncommitted alongside the stamp removals.
The 2026-07-10 launch plan is complete: **the Phase-7 release-flow test PASSED end-to-end** — the `v0.1.46` tag drove `release.yml` through all three build legs to a draft, the owner smoked + **published** the release (pre-release flag on, 5 assets: win portable `.exe`, mac `.app.zip` + Metal runtime zip, AppImage, `SHA256SUMS.txt`), and the post-launch tester wave (#48–#53) filed against the shipped build — the channel demonstrably works. **The owner also transferred + renamed the repo to `HilbertraumAI/HilbertRaum` (2026-07-11)**, which resolves the flip checklist's repo-name item ahead of schedule: the three hardcoded `comilionas/AI_Drive` URLs in `cla.yml` now point at the canonical location (the old ones only worked via the transfer redirect), and a stale folder-name mention in a test-path comment rode along; the remaining `comilionas` hits are GitHub *account* names (CLA signatories, manifest `reviewed_by`) and dated log entries here — correct as-is. Close-out steps per the plan: (1) the **Deferred flip checklist + the report-§1.3 branch analysis + the report-§3 issue-filing table are folded into §5 item 10** — with one CORRECTION found while folding: the report listed `origin/cla-signatures` among stale-deletable branches, but it is cla.yml's signature-storage `branch:` (and the action cannot recreate it) — flagged load-bearing, never delete; (2) packaging.md's Phase-5c release-flow record re-verified complete (trigger, four jobs, draft→smoke→publish ritual, staged signing table — no gaps to fold); the TranslateGemma manifest's `notes` citation of the report reworded self-contained (the four Gemma-Terms provisions + the commercial flow-down checklist were already restated verbatim in the note; §5 item 1c gains the dated PVR re-check: still 404 on the renamed repo); (3) **both working papers deleted** (`docs/public-launch-plan.md`, `docs/release-readiness-2026-07-10.md` — uncommitted their whole life, NO git-history copy; everything durable now lives in §5 item 10, packaging.md's release record, the manifest note, and the 2026-07-10 phase entries below). Also resolved in passing: architecture.md §46's DOC-112 row ("resolves with the owner's launch close-out") is now true. Still open from the launch context: the flip itself (§5 item 10), the mailbox + Apple-enrollment sidebars, and the model-eval owner gates (§5 item 8). Suite + typecheck green (docs/workflow-URL-only changes).
The reporter verified the #42 device ladder works as designed (and delivered the §11.4 GPU datapoint: RTX 3090, ~13 GB free → full offload, 7.8 GB VRAM, **75.7 tok/s decode / 140 prompt** vs the ~3–4 CPU calibration), but found the gap: with a large chat model resident (gemma-4-26b-q4, ~16 GB of 24), `--fit` squeezes TranslateGemma into the remainder → **partial offload at roughly CPU speed** — a llama.cpp fit decision, not a fault, so `onDeviceFallback` (correctly) never fires, the sidecar logged NOTHING at cold start, the split stays pinned until the 2-min idle teardown re-fits, and the Translate screen had no device surface: "GPU enabled but slow" was indistinguishable from "GPU not working". Fix along the reporter's three asks:
- **Cold-start log (symmetric with chat's `"started via rung …"`):** `LlamaServer` gains an optional `onStderrData` tap (the capped `stderrTail` can age the load lines out — the tap sees every chunk; guarded, observability-only); `TranslationRuntime.startAttempt` parses `load_tensors: offloaded X/Y layers to GPU` (rolling 512-char window across chunk boundaries; last match wins; the ONLY place the real fit outcome is reported — `/props` doesn't carry it) and fires a new `onStarted` hook once per successful cold start → compose-services logs `"Translation sidecar started" {device, offload: "X/Y layers" | "not reported"}`.
- **Translate-screen device hint (the chat-#36 analogue):** new `TranslationRuntime.deviceStatus()` (posture + split + `live`; LAST-KNOWN survives the idle teardown so a finished run stays explainable; null before the first start) → optional on the `Translator` seam → `getAppStatus().translationDevice` (new optional `AppStatus` field + shared `TranslationDeviceStatus` type) → a muted caption under the Translate language bar: GPU with the layer split / **"runs only partly on the graphics card ({done}/{total}) — about processor speed"** with cause+remedy tooltip / CPU; no line before the first start. The screen re-polls `getAppStatus` every 4 s while busy (the cold start lands mid-translate) and once when a run settles. i18n EN+DE (`translate.device.*`).
- **Docs:** model-benchmarks **§11.4** (+observability bullet, +the field datapoint incl. the contention case; owner harness re-smoke stays the open recorded-evidence action, the architecture-risk question is now answered); known-limitations "Document translation" (+the contention bullet: what it looks like, why nothing latches, per-cold-start pin, smaller-chat-model remedy); architecture "Translation sidecar" record (+#42-reopen bullet).
Tests +8: `translation-runtime.test.ts` new "cold-start device observability" suite ×4 (chunk-split parse → deviceStatus+onStarted once per start, last-known across suspend; forced-CPU honest null split; GPU→CPU fallback lands as 'cpu'; throwing onStarted harmless), `core-model-ipc.test.ts` ×1+1 (status feed; null without a translator), `TranslateScreen.test.tsx` ×3 (full/partial+tooltip/CPU + absent-before-first-start). Suite: typecheck clean, **4053 tests pass** (47 skipped), `npm run build` green. Issue: commented + closed via API (the fix commit references it).

_2026-07-11 — **Docs reconciliation: the #48 tester eval runs (2026-07-09) are now recorded in model-benchmarks §9 — the repo no longer claims the Qwen3.5 wave is un-evaled.**_
Yesterday's #53 close-out (and §9 itself) still said the wave "has NOT been through the harness" — but issue #48's COMMENTS contain two §2-protocol grounded-QA runs by a tester (i9-9900X + RTX 3090, b9849 binary, 13 chat GGUFs incl. all six wave candidates, hand-audited hallucination flags, cross-run calibration vs Phase-29 within tolerance). Recorded as **quality evidence pending owner ratification** (raw CSVs uncommitted; ranks unmoved): new §9 block "Tester eval runs (2026-07-09)" with per-model verdicts — Qwen3.6 27B Q5/Q4 sweep 20–24 GB (blocked on productizing), **the 4B FAILS its bar** (F1 .2728 vs qwen3-4b's .3277 → #53's weak-hardware case reduces to the option-2 signal-aware picker), the 2B never recommendable, the 9B under Ministral, the 35B-A3B clean-after-audit awaiting the speed rows — plus the scorer follow-ups the tester flagged as prerequisites for canonizing numbers (refusal-detector phrase list + `rescore.mjs`; length-confounded F1 → read EM + audited hallucinations as primary). §9's header + the #53 field-signal paragraph gained dated update notes; §5 item 8 REWRITTEN from "run the eval" to the ratify-and-complete sequence (scorer fix → ratify → §3/§4 speed/RSS → §9.1 app smoke → productize Qwen3.6 → coupled rank/RAM/test edits). Cross-reference comment posted on #53. Docs-only — suite 4045/47 + typecheck green (unchanged, as expected).

_2026-07-11 — **Beta feedback issues #51 + #52 + #53 (exFAT "scan and fix" prompt / at-rest WAL sidecars; Diagnostics tok/s measures the loaded model unlabeled + silently steers the profile; Qwen3.5 4B low-end promotion request) — #51/#52 FIXED, #53 groundwork recorded (rank stays owner-gated).**_
Second post-launch tester wave, each analyzed to root cause before any fix:
- **#51 (Windows "scan and fix" on plug-in — exFAT dirty bit):** the report's framing ("app-side WAL/log handles make it routine") was PARTIALLY stale: the encrypted quit path already checkpoints+closes+shreds via `workspace.lock()`, and the log holds no persistent handle (memory-buffered, whole-file atomic replace per flush). The REAL gap: `lock()` is a documented no-op for `plaintext_dev`, so every clean quit of a plaintext workspace left `-wal`/`-shm` at rest (what the reporter's dev drive shows). Fix: new **`WorkspaceController.shutdown()`** — `lock()` for encrypted, plus `wal_checkpoint(TRUNCATE)` + `close()` for plaintext — wired into `performShutdown` AND the `uncaughtException` handler; quit now leaves a bare `hilbertraum.sqlite` in BOTH modes (crash-left plaintext sidecars are deliberately KEPT — they hold committed transactions SQLite replays on next open). Tests: shutdown ordering updated (`workspace.shutdown()`, event label kept); +2 integration (on-disk `-wal`/`-shm` absence after shutdown, both modes, with relaunch round-trip). Docs: troubleshooting gains the "Windows asks to scan and fix" entry (scan is safe; quit-then-eject habit; `FOUND.000` meaning); user-guide §13 "Before unplugging"; drive-layout names the sidecars; security-model records the design INCLUDING the declined alternative (**`journal_mode=DELETE` on exFAT: declined** — WAL is the deliberate USB-perf choice, a mid-session unplug dirties the volume regardless, DELETE doubles fsync cost). Residuals → §5 item 9 (idle checkpoint posture, in-app eject button, download `.part` stream not torn down on quit, kit quick-start card).
- **#52 (Diagnostics "Tokens / sec" names no model + silently steers the recommendation):** confirmed as reported, plus one aggravation — the tok/s profile downgrade emitted NO warning at all. Fix in [`benchmark.ts`](apps/desktop/src/main/services/benchmark.ts): **`BenchmarkResult.measuredModelId`** (loaded model at measure time; null when unmeasured; absent pre-field → readers treat as null, old cards render unchanged; no settings-validation change — `lastBenchmark` is shape-checked as a plain object); the card + Copy text render `30 (measured with the loaded model <id>)` via ONE shared helper; new persisted warning `main.benchmark.warnVeryLowTokens` NAMES the model, emitted only when the reading ACTUALLY moved the profile ("with-tps ≠ without-tps" classification — an already-TINY box never over-claims). The warning is the display map's second INTERPOLATED persist-canonical key (template-regex round-trip keeps the id verbatim in German). Deliberately NOT done: suppressing the downgrade for oversized measured models — that is #53's signal-aware-picker follow-up, now unblocked data-wise. Tests +6 across benchmark (incl. a deliberately-slow fake runtime driving the warning end-to-end, machine-independent consistency assertion), display-map, DiagnosticsCopySave (+legacy-result rendering). Record: benchmark.md (steps/classification/warnings).
- **#53 (promote Qwen3.5 4B to the standard low-end pick):** the rank edit is owner-gated in five places (manifest gate, model-policy, model-benchmarks §9/§6.3, §5 item 8) on the local grounded-QA eval + §9.1 b9849 smoke — field datapoints deliberately don't count, so **rank stays 0**; issue left OPEN like #48. NEW mechanics finding recorded (manifest + §9 + §5 item 8): **the issue's option 1 doesn't work as written** — at rank 1–2 the 4B wins NOTHING (qwen3-4b rank 2 + smaller-disk takes ≤12 GB; Ministral holds 16–20), and at rank ≥3 it ALSO steals 16/20 GB from Ministral (shared `recommended_ram_gb: 16`) — so the promotion needs a peak-RSS-based RAM retune or the option-2 signal-aware picker (which #52's `measuredModelId` now feeds). The ~2 tok/s field report is recorded as eval input + an informal b9849 load observation.
Suite: typecheck clean, **4053 tests pass** (47 skipped), `npm run build` green — HEAD gate after the subsequent #42-reopen wave (`ef99ced`, +8 tests); the #51/#52/#53 wave itself landed at 4045 (full-audit 2026-07-11 DOC-7). Issue disposition: #51 + #52 commented + closed via API; **#53 commented but left OPEN** (owner-gated §9 eval, §5 item 8).

_2026-07-11 — **Beta feedback issues #48 + #49 + #50 (stale model recommendations / 20–24 GB tier gap; lockfile peer-flag churn; reasoning models zero out the coverage-extract pass) — FIXED on local `master`.**_
Three post-launch tester reports, each analyzed to root cause before any fix:
- **#50 (the severe one — coverage-extract yields 0 items under reasoning models):** the ingest-time
  extract pass already sends `enable_thinking: false` (omitted mode → balanced), but Qwen3.5 reasons
  anyway; `DocTaskManager.generate` discards `reasoning_content` deltas, so a model that spends the
  whole `EXTRACT_OUTPUT_TOKENS = 384` cap thinking collapses to `''` → `parseExtraction` → `null`,
  and the temperature-0 "retry" was byte-identical — every chunk landed a permanent `unparsed`
  marker (cache keyed on `(chunk_id, content_hash)` only; markers of any outcome were hits). Fix in
  [`extract.ts`](apps/desktop/src/main/services/analysis/extract.ts): (1) the retry escalates to
  `EXTRACT_RETRY_OUTPUT_TOKENS = 2048` (a cap, not a target — non-reasoning models never pay it);
  (2) `parseExtraction({salvageTruncated})` recovers the complete leading items of a cap-truncated
  array on the **final attempt only** (salvaging attempt 1 would commit a silently partial list as
  a permanent `ok`); (3) an `unparsed` marker is **no longer a cache hit** — retried on the next
  explicit "Build deep index" run (marker replaced by commitChunk's delete-then-insert; `ok` scans
  stay 0-call; no schema change — pure query change); (4) an **empty** listing where ≥ half the
  scanned sections are unparsed appends `analysis.listing.unparsedHint` (+ the bank-statement-skill
  pointer for `amount`, EN+DE) instead of a bare "No amounts found". Record: rag-design **§14.5**
  ("Reasoning-model hardening (#50)"). Note: tree-build was already guarded (its summary cache is
  model-keyed and refuses to cache empty generations) — extract now matches that posture.
- **#48 (model recommendations stale; "20–24 GB recommends nothing"):** precisely, a 20–24 GB
  machine got the same 8B as 16 GB — every 12–14B winner carried `recommended_ram_gb: 32`, so the
  comfortable-fit stage never reached the tier winner. Fixed the in-policy half (record:
  model-benchmarks **§6.3**): honest comfortable-RAM recalibration (`gemma4-12b` + `qwen3-14b`
  32→**24** — measured ~10.6 GiB RSS; `qwen3-8b` 32→**16** — 8.3 GiB, Ministral's tier) + a
  **ranked-only guard** in `recommendModelIdByRam` (a rank-0 model is considered only when no
  ranked model fits the stage — the §9 "never auto-recommend rank 0" invariant is now structural,
  not RAM-line-alignment luck). Net mapping asserted at 8/12/16/20/24/32: ≤12 → Qwen3-4B, 16–20 →
  Ministral, **≥24 → Gemma 4** (only 24 changed — every Phase-29 winner preserved). The rest of
  #48 is NOT a rank edit and stays owner-gated per §9: run the grounded-QA eval + §9.1 b9849 smoke
  for the six rank-0 Qwen3.5 manifests (§5 item 8; §9 now also names context length + thinking
  support as first-class criteria, and the productizing bar for local-only candidates like a
  Qwen3.6). Also closed the test gap: `committed-catalog.test.ts` wave invariants now cover all
  six `qwen3.5-*` ids (the fast-tier 2B/0.8B had shipped outside them).
- **#49 (package-lock.json always dirty after `npm install`):** unpinned npm — different npm
  versions compute the lockfile `peer` flags differently. Verified the committed lockfile is
  **canonical under npm 11.6.2** (`npm install --package-lock-only` → zero diff), so no
  regeneration: pinned `"packageManager": "npm@11.6.2"` + `engines.npm: ">=11"` (advisory),
  switched `setup-dev.{ps1,sh}` to **`npm ci`** (lockfile-exact, never rewrites — the dev half of
  hardening L-8; CI already used it), documented `npm ci` as the standard fresh-clone/post-pull
  install (README, CONTRIBUTING incl. the `git checkout -- package-lock.json && npm ci` unwedge,
  CLAUDE.md, packaging.md), and pinned the discipline in `repo-hygiene.test.ts`.
Suite: typecheck clean, **4037 tests pass** (47 skipped). Issue disposition: #49 + #50 commented +
closed via API; **#48 commented but left OPEN** — its promotion half is the owner-gated §9 eval.

_2026-07-10 — **full-audit 2026-07-10 close-out (Phase 14 of 14): §46 remediation ledger folded into architecture.md; open items registered; working papers deleted. THE ROUND IS COMPLETE.**_
The 2026-07-10 full-audit + docs-audit round (43 finding ids — BE-1…BE-7, RD-1…RD-6, SC-1, PF-1…PF-8, TS-1…TS-9, DOC-101…DOC-112; 0 Critical) is closed. **Durable record:** new `architecture.md` **§46** ("Full audit (2026-07-10) — remediation ledger + close-out", after §45) — the per-finding disposition table (fixed@phase+commit / deferred / watch / superseded), the audit's headline clean verdicts (hard rules verified clean; every prior ledger residual re-verified accurate — carried PERF-5 is the one item the wave CLOSED, via PF-7c), and the §-anchor legend keeping every `full-audit 2026-07-10 <ID>` citation in commits/comments/tests resolvable. **§46 is the ONLY durable artifact of the round** — the three working papers (the full report, the docs-audit report, the remediation plan) were uncommitted for their whole life and are deleted at this close-out (plain `rm`, no git-history copy; finding detail survives in §46 + these dated entries + the phase commits `16ccbbc`…`19dfbc9`). **Open items registered where they belong:** §5 below gains item 7 — TS-3 (mechanical smoke-record release gate, owner design), TS-7 (macOS CI leg, owner call on minutes), TS-9 (S13a suggestion-bar ratification, owner D1), BE-1's deliberately unclamped `rag*` knobs, SC-1's owner-observed pin validation on the next tag/`workflow_dispatch` run; PF-5 is a watch clause on known-limitations' windowed-documents-list bullet (revisit with DB-8 at ~10k docs); PF-8 is folded into the architecture P4b deferral record (the residency axis joins the P4b design when its trigger fires); known-limitations' audit-log bullet de-staled in passing ("pruned on every insert" → slack-gated, PF-3). **Reference sweep clean:** no tracked file references the three working papers — the repo-wide grep hits are historical entries about OLDER, already-retired audits plus the owner's two launch papers (out of scope); phases 1–13's entries and code comments cite plain ids per the ground rules (verified). **Docs-audit verified complete:** DOC-101…DOC-111 Fixed; DOC-112 Superseded (resolves with the owner's launch close-out, which deletes the release-readiness paper). Also repaired in this file: the Phase-7 (PF-1/PF-2/PF-3) entry's missing dated header line; §5's embedded current-gate count 3956 → 4024. The owner's two launch papers (`docs/public-launch-plan.md`, `docs/release-readiness-2026-07-10.md`) stay untouched on disk pending the launch flip. Suite **4024/47** + typecheck green (docs-only close-out — count unchanged, as expected).

_2026-07-10 — **full-audit 2026-07-10 SC-1 + TS-6 + TS-8: infra odds and ends — workflow actions SHA-pinned, optional coverage script, screenshot harness polls instead of sleeping.**_
**SC-1 (supply chain):** every third-party action in `ci.yml` + `release.yml` was tag-pinned (`@v4`/`@v2` — movable refs a compromised action repo could redirect); all now pinned to **full commit SHAs + `# vX.Y.Z` comments**, the repo's own `cla.yml` idiom (checkout→v4.3.1, setup-node→v4.4.0, upload-artifact→v4.6.2, download-artifact→v4.3.0, and — the priority, it runs in the `contents: write` release job — softprops/action-gh-release→v2.6.2). Each SHA resolved from the exact tag via `git ls-remote` (all five are lightweight tags — the listed SHA IS the commit); **no other workflow semantics changed** (verified: the diff touches only `uses:` lines). No test pins action refs (checked — packaging.test.ts and the suite are clean of workflow-file assertions). The pins are validated by the next tag/`workflow_dispatch` run (owner-observed — the packaging tests don't execute workflows). packaging.md CI record gains the one-sentence pin note. **TS-6:** optional **`npm run test:coverage`** (`vitest run --coverage`, V8 provider) in `apps/desktop` + root passthrough; `@vitest/coverage-v8@^2.1.9` devDependency (matches the installed vitest 2.1.9; `npm install` ran fine with `NODE_USE_SYSTEM_CA=1`). Deliberately NOT wired into CI, no thresholds — a local inspection tool; the generated `coverage/` dir is gitignored (never-commit-generated-files rule) and the invocation is documented in CONTRIBUTING's dev-setup block. Smoke-verified against one test file (report renders; the sourcemap warnings over prebuilt `out/` artifacts are cosmetic). **TS-8 (dev tooling):** `scripts/screenshot.mjs`'s fixed settles (1.8 s per case / 4.5 s for the full-`<App/>` `brand-home*` cases) → a **polled per-case ready condition**: `document.fonts.status === 'loaded'` + the harness root has rendered children + a per-case `READY` selector that only exists once the case's async chain completed (`.doc-row`, `.model-card`, `.chat-runtime-hint`, `.chat-warmup-hint`, `.skill-info-card`, `.skill-run-bar`, `.chat-conv-group`), and for the App-shell cases every `.brand img` `complete` with `naturalWidth > 0` (the end of the workspace → settings → language re-render → brand-fetch chain); after ready, two `requestAnimationFrame`s let the offscreen frame paint. The old values are kept as **timeout CEILINGS** — on expiry it warns and captures anyway (identical worst-case), so the CONTRIBUTING "gate on observable state, ceiling on top" rule now holds in the dev tooling too. The documented Windows invocation is unchanged and re-verified: full 11-case walk in **19.3 s total** (the fixed sleeps alone were 25.2 s), four PNGs eyeballed correct (documents rows+chips, brand-home shell with the real mark — German expected there, `language: auto` on the de-AT box —, models-de, chat-runtime-compat's "CPU (compatibility mode)" hint). Suite **4024/47** + typecheck green (workflow/docs/script-only — count unchanged from Phase 12, as expected).

_2026-07-10 — **full-audit 2026-07-10 PF-6: route-level code split — six screens load as async chunks; init renderer bundle 1,255 → 998 kB (−20.5%).**_
After the ESM/code-split work the init `index-*.js` still eagerly parsed every screen. Six screens — Documents, Settings, Models, Images, Skills, Translate — are now `React.lazy` in `App.tsx`, each its own async chunk fetched on first navigation (DocumentsScreen 124 kB, SettingsScreen 41 kB, ModelsScreen 31 kB, ImagesScreen 27 kB, SkillsScreen 24 kB, TranslateScreen 15 kB; measured baseline first: init 1,255.22 kB → 998.08 kB). **Deliberately eager:** the workspace gate + HomeScreen (the first frame, per the finding) and **ChatScreen** — Chat is the primary surface (first-run lands there) and lazy-loading it would de-facto pull the shared chat components out of the init chunk, which the finding explicitly reserves as a separate decision (same for the two i18n catalogs, the other big initial resident — ~290 kB of unminifiable string tables; **the finding's −30% aspiration is therefore not reachable screens-only — −20.5% is the honest scope result**, remaining headroom = exactly those two exclusions). The suspense point sits INSIDE the existing per-screen ErrorBoundary: a quiet localized `aria-busy` `.screen` fallback (new `app.loadingScreen` key en+de; hint-text idiom of `app.loadingWorkspace` — guidelines §6 bans unlabeled spinners; a failed chunk import rejects into the boundary's localized retry fallback). The preview/screenshot harness (`vite.preview.config.ts`) statically imports screens in its OWN standalone build — unaffected, verified. Test: new `tests/renderer/LazyScreens.test.tsx` pins fallback → content deterministically — a SYNCHRONOUS `fireEvent.click` is the gate (a dynamic import can never resolve synchronously, so the fallback is guaranteed visible immediately after the click; no sleeps), then `findByRole` for the screen and the fallback gone; the four full-`<App/>` suites (AppLock, I18n, InformationArchitecture, GermanSmoke) exercise navigation across every screen and stay green unchanged (they already `findBy*` after navigation). screenshot-verify walk run (full-`<App/>` brand-home case + documents/models/chat cases) — every capture renders correctly, no console errors. Docs: packaging.md "Module format & renderer bundle" record gains the route-split paragraph (sizes before/after). Suite **4024/47** (+1) + typecheck + `npm run build` green.

_2026-07-10 — **full-audit 2026-07-10 PF-4 + PF-7(a–d): startup discovery threaded once; renderer poll/stream churn gates — closes the carried-forward PERF-5.**_
Behavior-identical perf sweep (Medium/low-risk; every fix landed with its gate test). **PF-4 (initBackend re-walked the manifests dir per role):** `composeServices` ran a fresh synchronous `discoverManifests` walk + YAML parse per role resolution, back-to-back before the window exists. It now discovers ONCE per composition pass and threads the result into its role resolvers — `resolveModelByRole` gains an optional `opts.discovered` (pre-discovered list; omitted ⇒ re-discover, so the per-IPC callers and the issue-#40 `onModelInstalled` → `composeTranslator` refresh stay fresh), and `ComposeServicesDeps.discovered` carries it into `composeTranslator` from the one call site. **Deliberately NO stateful module cache** (the plan's explicit trap — it could serve stale results to the per-action callers). An unreadable dir degrades to "no models" for every role, exactly what each resolver's own catch produced before. New `compose-services-discovery.test.ts` (real temp drive + a spy WRAPPER that keeps real discovery and counts walks): exactly ONE walk per `composeServices`, the per-action `composeTranslator` still re-discovers, null dir walks nothing; `resolve-model.test.ts` +1 pins that a provided `discovered` list skips the walk. **PF-7a (Home runtime poll never stopped + fresh object per tick):** an unchanged 2.5 s tick now keeps the PREVIOUS state object (`sameRuntime` compares the consumed fields `running`/`modelId` — React bails out of the re-render), and once the model runs the interval stops with a window-focus re-check instead (the ChatScreen poll-while-not-running pattern). New `HomeScreenPoll.test.tsx` ×2 with the `__docRowRenderCounts`-pattern probe (`__homeScreenRenderCount`, DEV-only): unchanged ticks → zero re-renders (one warm-up tick absorbs React's one-time bailout-confirmation render); running → no interval, focus re-checks. **PF-7b (doc-task 400 ms poll set unconditionally):** `setActive({...current, status})` per tick re-rendered every subscribed screen ~2.5×/s for a task's whole duration; the skillruns `sameRun` gate (SKA-39 precedent) is ported as `sameStatus` (state/stepsDone/stepsTotal/error/resultRef?.documentId) — an identical tick sets nothing and the snapshot identity stays stable. `doctasksStore.test.ts` +2 (fake timers, mirroring skillRunStore's SKA-39 cases): identical ticks → no notify + same snapshot reference; a progress advance and the terminal transition still notify/stop. **PF-7c — closes carried-forward PERF-5 (2026-06-30 ledger):** `visionSession` notified PER TOKEN with a freshly mapped `turns` array; tokens now buffer through a 40 ms flush (the ChatScreen `STREAM_FLUSH_MS` precedent — `translateSession` keeps documented per-token at its ~4 tok/s, comment de-staled). Settle paths flush FIRST so no token is lost (done's accumulated-answer fallback, error's partial-answer retention, Stop) — discard paths (new image / Remove / lock purge) drop the buffer unsent inside `teardownStream`. ImagesScreen got the FE-3 `useEventCallback` sweep over `onCopy`/`onTryAgain`/`onStop` exactly as the PERF-5 carry note prescribed. `visionSession.test.ts` +3 (burst → ONE notify + untouched snapshot identity mid-window, fake timers; done-flushes-first; Stop-flushes-first) and the F8 test's token assert now gates on the observable store state; `ImagesScreen.test.tsx` +1 render-count case (new `__turnRowRenderCounts` probe in `AnswerThread`, DX-2 DEV-only): a settled TurnRow's memo holds through a sibling turn's stream flush; 2 existing token asserts → `findByText` (tokens land on the flush, not synchronously). **PF-7d (ScopePopover re-filtered per keystroke while closed):** the composer-footer popover re-ran `indexed`/`addableDocs`/`library`+`projects` filters on every parent keystroke/stream flush; now `useMemo`'d on `[docs]`/`[indexed, docIds]`/`[collections]` (with a module-level `EMPTY_IDS` so a null scope can't bust the deps; `addableDocs` hoisted above the empty-corpus early return — hooks must run unconditionally). `memo(ScopePopover)` deliberately NOT forced (its handler props are parent-inline; the plan's own caveat). Docs: architecture perf record gains the PF-4/PF-7 wave paragraph; the PERF-5 row + carried-forward note in the 2026-06-30 ledger marked CLOSED pointing at it. Suite **4023/47** (+12) + typecheck + `npm run build` green (PF-4 touches startup composition).

_2026-07-10 — **full-audit 2026-07-10 TS-1: fixed-sleep sweep — flake retirement; every test wait is now a deterministic gate or a justified fixed sleep.**_
Sweep of every fixed-sleep in `apps/desktop/tests` (located by grep — the audit's line refs had drifted; also swept `sleep(`/`delay(` helper spellings). Ground truth: the suite was already mostly gated by earlier waves (bounded poll helpers, `while (!flag)` state-polls, the injected-clock idle-teardown interlocks) — **six raw fixed-sleep sync points remained, all converted**: (1+2) `docs-ipc.test.ts` DB-6-in-flight + T-3-processing — both `gatedEmbedder` helpers (module-scope and Session-6-local) now expose a `reached()` probe flipped the moment the import loop enters the gated embed; the two `sleep(20)` "let the loop reach the gated embed" become `while (!reached())` polls (the ocr-task `rasterizeReached` exemplar). (3) `vision-runtime.test.ts` + (4) `translation-runtime.test.ts` abort-forwarding — `sleep(2)` "let the request reach the fetch" → state-poll on the captured `seenSignal` (the reranker/e5 idiom; a fixed sleep could abort PRE-flight under CPU starvation and exercise the wrong path). (5) `core-model-ipc.test.ts` `maybeAutoStartActiveModel` negative ("does nothing without/when…") — the `sleep(50)`-then-`expect(starts).toBe(0)` vacuous-pass window is closed by a positive-control SENTINEL: a fifth, legitimate auto-start driven through the SAME background path (discover → computeInstallState → runtime.start) and awaited — any stray start wrongly launched by the four guarded calls was enqueued on that path earlier, so it has landed by the time the sentinel lands; the assertion is unchanged. (6) `SkillRunLifecycle.test.tsx` C1 negative — a (wrongly) firing relay effect calls `askDocuments` SYNCHRONOUSLY (`stream` has no await before that call) and every effect for the store update flushed inside `act`, so `sleep(50)` → one empty `act` flush, conclusive. **Every surviving fixed sleep now carries a justifying comment** (the acceptance grep is self-evident): timestamp-ordering clock advances (`chat.test.ts`, `image-history.test.ts` — updated_at has ISO-8601 ms resolution; the sleep IS the semantics), timeout simulations (`ingestion-limits.test.ts` ×2 — the timer IS the simulated slow parse/long transcription; timer-expiry ordering makes the race deterministic), single-macrotask hops over pure microtask chains with no observable seam (`ocr.test.ts`, `e5-embedder.test.ts`, `reranker.test.ts` — a lost race only weakens the exercised interleave, never the assertions; the `killed`/release polls below them are the real gates), and the manual PAID probe's 1.5 s mid-stream stagger (the probe's semantics). Everything else the grep returns is a poll interval inside a bounded gate. `vitest.config.ts`: the 15 s `testTimeout` KEPT deliberately as cheap headroom for genuinely CPU-starved forks; its comment now records the sweep (the "1–2 flakes per run" note is historical, the timeout is no longer a flake mitigation). Docs: CONTRIBUTING gains the "no fixed sleeps — gate on observable state" rule with the ocr-task/vision-runtime exemplar pointers (beside the TS-2 window-security bullet). No assertion changed anywhere (byte-identical); no behavior under test changed. Acceptance ran as specified: FULL suite 3× consecutively from repo root — **4011/47 ×3, zero flakes** — + typecheck green.

_2026-07-10 — **full-audit 2026-07-10 TS-2 + TS-4 + TS-5: test-infra hardening I — the renderer security wiring is pin-tested; stubApi spies are stable; query-plan assertions stop matching planner strings.**_
**TS-2 (Medium — a one-character `sandbox: false` shipped green through ~4,000 tests):** the BrowserWindow hardening flags (`contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` / `webSecurity: true`), the prod+dev CSP strings, and the main-window window-open policy moved VERBATIM (literal-move refactor; a pre-refactor pin test read the literals out of the source and proved neutrality) from `main/index.ts` + `ocr/rasterizer.ts` into new **`src/main/window-security.ts`** — the `shutdown.ts`/`navigation-guard.ts` extract-a-seam pattern, no runtime `electron` import so it unit-tests under plain vitest. Exports: **`SECURE_WINDOW_WEB_PREFERENCES`** (frozen; shared by BOTH windows — checked before unifying: they differed only in each window's `preload` path, which stays at the call site and is spread BEFORE the flags), **`buildCsp(isDev)`**, **`createWindowOpenPolicy(openExternal)`** (injected `shell.openExternal`; http/https → external-open, everything incl. malformed → dropped; the in-app open is ALWAYS denied — the OCR window's inline deny-all stays put). `tests/unit/window-security.test.ts` (13 tests) pins every flag by name/value via exact `toEqual` (a dropped flag, flipped value, or smuggled extra key fails), both CSP strings EXACTLY (they are the contract) plus a semantic localhost-only check on the dev relaxation (every `scheme://host` source in either CSP must be `ws|http://localhost:*`; prod carries no origin at all, no `unsafe-eval`, no `localhost`), the window-open policy across http/https/file/smb/javascript/chrome/malformed/empty, AND the call-site wiring at source level (the ocr.test.ts preload-channel-contract idiom: both files spread the shared object, `index.ts` uses `buildCsp(isDev)`+`createWindowOpenPolicy(`, and NO inline `contextIsolation:`/`nodeIntegration:`/`sandbox:`/`webSecurity:`/`default-src` literal survives at either call site — so the unit pins can't be bypassed by re-inlining, and a post-spread override would trip the scan). **Mutation check done as specified:** a deliberate `sandbox: false` in the module reddened exactly the flag-pin test; reverted. **TS-4 (stubApi minted a FRESH `vi.fn()` per property access):** unmocked `window.api.*` calls rendered as success-with-`undefined` and a repeat-lookup assertion (`expect(window.api.x).not.toHaveBeenCalled()`) passed vacuously against a spy nobody had ever held (grep: no current test uses that pattern — the fix is prophylactic for the NEXT one). `tests/helpers/renderer.ts` now caches ONE spy per accessed name (stable identity across lookups; overrides pass through untouched), `console.warn`s once per name when an unmocked method is actually CALLED (lookups alone stay silent — existence probes are harmless), and exports opt-in **`assertNoUnexpectedApiCalls()`** (throws with names + call counts; bookkeeping resets per `stubApi()` install). Renderer tier swept for fresh-spy reliance as planned: 67 files / 607 tests green, zero adjustments needed. Self-test `tests/renderer/stubApi.test.ts` (5 tests) pins stable identity, override passthrough, warn-once-per-name, the assert's teeth, and the per-install reset. **TS-5 (planner-string coupling):** `data-layer-hardening.test.ts`'s PERF-3 happy-path assertion dropped its `no SCAN`/`TEMP B-TREE` planner-phrasing matches — EXPLAIN QUERY PLAN detail strings shift with the SQLite bundled by the pinned Node (`node:sqlite`) — and asserts the index NAME only (`idx_messages_conv_kind`; which index the planner picks IS the PERF-3 contract). The TEETH counterfactual kept unchanged (drop the index → the planner falls back to `idx_messages_conversation`, both index-name checks); a comment marks the Node/SQLite coupling so a failure right after a Node/Electron bump triages as expected planner drift first. Docs: CONTRIBUTING gains the security-wiring-is-pin-tested bullet (don't edit CSP/webPreferences inline; change the module next to its tests). Suite **4011/47** (+13 window-security, +5 stubApi) + typecheck + `npm run build` green (the TS-2 refactor touches startup).

_2026-07-10 — **full-audit 2026-07-10 RD-1 + RD-2 + RD-3 + RD-4 + RD-5 + RD-6: renderer correctness polish — the first-send optimistic bubble survives its own history load; unresolved run targets stop asserting ".txt"; Models screen locale/blank-select/FE-4 fixes; a pending confirm can no longer re-open itself.**_
**RD-1 (Medium, timing-dependent; characterization test written FIRST and watched fail):** on the FIRST send of a new conversation, `ChatScreen`'s history-load effect flushes DURING `ensureConversation`'s `await refreshConversations()` — its `listMessages` reaches main BEFORE the send IPC, main answers `[]`, and that `[]` lands AFTER `onSend`'s optimistic append, wiping the user's bubble for the whole first answer (the CR-7 `activeIdRef` guard passes: it IS the active conversation). Fix = the plan's option 2, guard-style: new `selfCreatedIdRef` is stamped in `ensureConversation` right before `setActiveId`, and the history effect skips exactly ONE `listMessages` for that id (a just-created conversation has no history; the context-info refresh still runs; switching away and back loads normally — the ref is consumed by the first firing). Test (`ChatSendFailure.test.tsx` +1): `listMessages` gated to resolve `[]` only after `sendChatMessage` was invoked (the production interleave made deterministic), send parks in flight, the bubble must survive the settle — failed on the old code, and the file's CR-1 draft-restore ×3 + CR-2 remount cases pin no regression. **RD-2:** `SkillRunTarget.name` is now `string | null` (null = unresolved) — `docNameForId` returns null instead of the localized "this document" placeholder, so `confirmFormatKey`'s `!name` fallback to `chat.skill.confirm.outputMatrix` is genuinely reachable and an unresolved target no longer asserts a plain-text `.txt` copy for what may be a `.docx` source (the placeholder is truthy + extension-less, so the #45 line always took the `.txt` branch). No display regression: `TargetMenu` applies the placeholder at render time (`displayName`), and ChatScreen's busy/result-row sites (`resolvedRunDocName`, `setRunTargetName`) keep it — only the DATA carried by `targetDocuments` changed; the in-code #45 comment now matches behavior. Test (`SkillRunBar.test.tsx` +1 in the #45 block): `name: null` → chooser shows the placeholder, confirm shows the matrix line, never the `.txt` assertion. **RD-3:** the tech-details context row now interpolates `m.recommendedContextTokens.toLocaleString(lang)` (matching the picker's call sites — a German UI reads "32.768"); `de.ts` `models.tech.contextValue` "Tokens" → **"Token"** (German plural, matching the neighboring `autoResolved` key). Test (+1, D-L8 catalog lookups, never re-typed literals): EN grouping + DE grouping-and-plural asserted via `t()`. **RD-4:** an override outside `CONTEXT_SIZE_PRESETS` (an older release's rung, a hand-edited settings file) matched no `<option>`, so the context-size select rendered BLANK; it now renders an extra option for the current value (same `models.tech.contextValue` label style, locale-formatted). Test (+1): `contextTokensOverride: 24576` → option present AND selected. **RD-5 (no test — consistency):** the mount-refresh `.catch` in `ModelsScreen` gets the file's one missing `mountedRef.current` guard (FE-4 discipline — every other async setState there already has it). **RD-6 (hardening):** `confirmTool` is state, so a pending confirm survived the offer row unmounting (tools emptied by a scope change) and silently RE-OPENED the dialog when the offer returned — unreachable today only by accident of modality; a small effect clears it once the tool is no longer in `runnableTools`. Test (+1): open confirm → tools emptied → restored → dialog stays closed; teeth revert-confirmed (disabling the effect reddens exactly this case). Docs: none — this phase makes the #43/#45 records true as written. Suite **3993/47** + typecheck green.

_2026-07-10 — **full-audit 2026-07-10 PF-1 + PF-2 + PF-3: streaming hot path + audit-log write path — announcer tail-scan, incremental word tally, slack-gated indexed prune.**_ (Header restored at the Phase-14 close-out — it was dropped when this entry was written.)
**PF-1 (StreamAnnouncer O(n²)):** the announcer effect (`Transcript.tsx`, also mounted by TranslateScreen) runs per ~40 ms flush and `lastSentenceBoundary(text)` regex-scanned the WHOLE growing buffer from index 0 every time (`lastWordBoundary` already scanned only the tail). Now it scans from `announcedLenRef.current` (safe by definition — a NEW boundary can only appear at/after the previous announce point; matches entirely before it never changed the outcome). The non-obvious part, stated in the function comment: to stay BYTE-IDENTICAL the tail scan backs up over the contiguous terminator/closing-quote-class run immediately before the announce point — a match can SPAN it (`\n` is both whitespace, i.e. a valid F6 word boundary, and a terminator; closing quotes extend a match) and appended text can retroactively grow a match whose `$` lookahead used to hold; every spanning-match char before the announce point is in that class, so the backup provably re-syncs with a whole-buffer scan (no match crosses a non-class char). Regex semantics untouched. **PF-2 (live meter re-split the whole answer per flush):** `ChatScreen.tsx`'s `liveUsage` recomputed `text.trim().split(/\s+/).filter(Boolean).length` over the growing answer every flush. New exported `LiveWordTally`/`advanceWordTally` scans ONLY the chars appended since the last flush, `endedInWord` carrying the mid-word chunk-boundary state; a shorter text = new turn → tally resets (streamText only ever appends within a turn — verified incl. the recovery poll, which sets monotone-growing snapshots and resets through `''`); idempotent for unchanged text (memo re-runs/StrictMode). `estimateLiveTokens` (user-turn one-shot) now routes through a fresh tally — same count by construction. **PF-3 (audit log pruned on EVERY insert):** `recordEvent` ran the `ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 5000` prune subquery per event with NO index on `runtime_events.created_at` (full scan + temp B-tree) and INSERT + DELETE were two auto-commit fsyncs. Fix: additive `idx_runtime_events_created` in `openDatabase`'s ensure-on-open perf-index block (the `idx_summary_cache_created` idiom — applies to existing workspaces); prune now slack-gated (new `AUDIT_PRUNE_SLACK` 250 — cheap index-only `COUNT(*)` per insert; prune back to `AUDIT_MAX_ROWS` only when post-insert count exceeds cap+slack) and insert+prune run in ONE transaction when it fires; never-throws contract untouched (try/catch stays outermost, ROLLBACK rethrows into it). Readers never see the slack (`listAuditEvents` clamps to the cap). Tests **+7**, oracle-style per the plan: `StreamAnnouncer.test.tsx` ×1 — a long scripted stream (300+ LCG-chunked flushes of adversarial content: ellipsis runs, quotes after terminators, `\n"` spans, F6 terminator-less stretches, markdown, a mid-stream reset) asserts the live region equals a test-local verbatim copy of the OLD whole-buffer implementation after EVERY flush (teeth revert-confirmed: disabling the class-run backup reddens exactly this test); new `live-token-estimate.test.tsx` ×4 — per-flush equivalence vs the old split-based count over fixture chunks (words split across chunks, whitespace-only/empty chunks, leading/trailing whitespace) + 5×200-chunk deterministic LCG streams + reset/idempotence; `audit.test.ts` ×2 net — prune-at-threshold converges to exactly the cap with ordering preserved (newest incl. the triggering event survive, oldest dropped), below-threshold insert does NOT prune then the crossing insert does, `idx_runtime_events_created` asserted by NAME via `sqlite_master` (never planner-string matching); the existing closed-DB never-throws/returns-false test still covers the new path. Docs: arch Wave-P2 perf record closure line + the Audit log record's retention sentence de-staled (prune-on-insert → slack-gated). Suite **3988/47** + typecheck green.

_2026-07-10 — **full-audit 2026-07-10 DOC-105 + DOC-106 + DOC-107 + DOC-108 + DOC-109(rest) + DOC-110 + DOC-111: docs-accuracy sweep II — §-pointers, skill count, L-2/L-3 ledger entries, user-guide completeness.**_
Docs plus comment/title-only code edits (no behavior change; UI/code re-read as source of truth before wording). **DOC-105:** architecture.md's three "curated 10-language set" spots (translation doc-task, Translate modal, TG-3 record) each carry the append-only pointer "(widened to 51 by issue #31 — see D5/#31b)" — records untouched otherwise; the D5 decision row + #31b bullet already documented the widening. **DOC-106:** drive-layout "eight today" → **nine** with `document-edit` added to the Tier-2 tool triple→quadruple; README repo-layout comment likewise (`ls app-skills/` = 9 verified). **DOC-107 (the L-2/L-3 dead finding-ids):** investigation showed the ids were never renumbered — the 2026-06-13 hardening round's lows simply never got ledger entries (its report was condensed + deleted; only M-1…M-5 and L-1 have doc homes). New security-model.md section "Low-severity hardenings from the 2026-06-13 audit (L-2, L-3)" (after the M-5 section) defines **L-2** (https-only download URLs — `isHttpsUrl` in `shared/manifest.ts` gating `validateManifest` + `downloadToFile`, later extended per-redirect-hop by D3) and **L-3** (`importPreflight` unlock gate + string filter in `registerDocsIpc.ts`); the 4 citing code comments now resolve, unchanged. The **SEC-4 id overload** is disambiguated at BOTH sites (security-model.md's backend-audit-2026-06-27 session-cached-verification residual vs architecture.md §38's 2026-06-29-follow-up `extract_to` fix — each now names the other). **DOC-108 (user-guide):** §5 gains "Technical details: context size" (Automatic labeled with its resolved number, presets 4k…128k, next-start apply, ≥64k memory note — wording checked against `ModelsScreen.tsx` `CONTEXT_SIZE_PRESETS`/`CONTEXT_SIZE_WARNING_MIN`, the i18n catalog, and rag-design §15.8); §6 gains the one-time #39 warm-up note; §10 gains Developer-mode + chat-compaction sentences (drive policy stays authoritative; compaction on by default, off = trim-only); §11 gains the interface-Language paragraph (System/English/Deutsch, immediate). **DOC-109 (rest):** stamps refreshed ONLY where this phase edited or re-verified: drive-layout, rag-design (verification pass — no content drift found), security-model, benchmark.md (content re-verified: RAM table matches the committed manifests); user-guide's existing 2026-07-10 stamp EXTENDED (no second entry). **DOC-110:** big-slot plan's reconcile note now names the Qwen3.5 `27b-ud-q4kxl`/`35b-a3b-ud-q4kxl` manifests as new, unpromoted big-slot-class candidates (gated on the model-benchmarks §9.1 owner smoke). **DOC-111:** troubleshooting's data/logs list says `app.log(.enc)` encrypted at rest (mirrors drive-layout); user-guide §7 import list gains `tsv`; §-citation precision (comment-only): `chat.ts` keeps its CORRECT §15.1 cite for the RAG ÷1.5 German safety it mirrors (verified: §15.7 itself cites §15.1 for it) and adds "(this chat-side mirror is recorded in §15.7)"; `legal-corpus.ts` §12 → **§12.2** (PAID harness) / **§12.1** (this corpus — it IS the redaction gold set; the audit's "RAG corpus" characterization was wrong). **`context.ts:86` deliberately UNCHANGED:** the audit's §14.5→§14.7 re-point is INVALID — §14.5 contains the "no surprise CPU spend at import" invariant verbatim and §14.7 never mentions it; re-pointing would have created the very drift the finding class targets (recorded in the audit working paper). **Phase-5 residual swept (was registered for close-out):** the stale "default-off" download remarks — `assets.ts` header comment (→ "ON by default since 2026-06-13") and `policy.test.ts`'s test TITLE + two same-claim inline comments (assertions byte-identical). Validation: every `curated 10` doc hit now carries the widened-to-51 pointer (the #31b definition bullet aside); `L-2`/`L-3` grep over apps/+docs/ resolves everywhere; suite **3981/47** + typecheck green (docs + comment/title-only edits — count unchanged from Phase 5, as expected).

_2026-07-10 — **full-audit 2026-07-10 DOC-101 + DOC-102 + DOC-103 + DOC-104 (+ DOC-109 stamps): docs-accuracy sweep I — the download-posture flip is finally documented; user-guide corrections.**_
Docs-only (plus two comment-only edits in one code file); code re-read as source of truth before wording. **DOC-101 (the 2026-07-01 download-posture flip was still described PRE-change in four docs + code comments):** `prepare-drive` writes `allow_model_downloads: true` in BOTH its postures (`drive.ts` `buildPolicyJson`) — model downloads are policy-permitted on prepared commercial drives too; a drive builder who wants a download-locked drive hand-edits `config/policy.json` to deny; update-checks + telemetry stay always denied in every posture. Corrected: `model-policy.md` §"The in-app downloader" gates 1+2 (the CANONICAL gate-semantics section — it claimed prepare-drive writes deny in both postures and prepared drives stay download-disabled); `packaging.md`'s build-time-vs-runtime note ("default-off setting … hidden entirely on commercial drives" contradicted the same doc's commercial final check "downloads OK" — now aligned with it and pointing at the canonical model-policy.md section instead of re-telling the gate story); `troubleshooting.md`'s offline-mode answer ("is off on a prepared commercial drive" → permitted, every download still asks first); `user-guide.md` ×3 (§5 download steps ×2, §10 privacy line "ships with it off" → on by default including prepared commercial drives); ONE leftover clause in `architecture.md`'s downloader gate 2 ("prepared drives stay download-disabled" — gate 1 directly above it was already corrected with the 2026-07-01 flip, so the section contradicted itself and would have failed the posture grep); `policy.ts` module header + `DEFAULT_POLICY` doc comment (comment-only, no behavior: deny is a builder's hand-edit, not "the commercial prepare-drive posture"; the user setting is no longer "default-off"). **DOC-102:** user-guide §7 claimed **ten** document-translation languages with a stale list — now **51**, deferring to §7a's list (matches `TRANSLATION_LANGUAGE_CODES`, issue #31). **DOC-103:** user-guide's "restart the app so the Translate action picks it up" → Translate activates as soon as the download finishes (issue #40 `onModelInstalled` → `composeTranslator`); the speech/search models (transcriber/reranker/embedder) still need a restart after a mid-session install (matches known-limitations). **DOC-104:** onboarding step 2 claimed "Model files and local logs are not encrypted — they contain no document contents" — the diagnostics log IS `app.log.enc` on an encrypted workspace (`logging.ts`); reworded (model files = public weights, not your data; the log is encrypted along with the workspace) to match SECURITY.md/PRIVACY.md and the guide's own §10. **DOC-109 (partial):** `_Last updated_` stamps refreshed on user-guide/troubleshooting/model-policy (packaging.md was already stamped 2026-07-10). **Residual for the close-out phase:** two stale "default-off" download remarks survive outside this phase's one-code-file scope — `assets.ts:21` (comment) and `policy.test.ts:166` (test TITLE; the test body is correct) — register or sweep at close-out. Validation: the posture grep over `docs/` is clean (working papers aside; the remaining "default-off"/"hidden entirely" hits are unrelated features — skills auto-fire, plaintext_dev UI); no doc-pinning test touches the swept sentences. Suite **3981/47** + typecheck green (docs + comment-only edits — count unchanged from Phase 4, as expected).

_2026-07-10 — **full-audit 2026-07-10 BE-5 + BE-6: no-runtime doc-task budgets follow the next launch's window; the tree build parks at level boundaries.**_
**BE-5 (no-runtime `getContextTokens` diverged from the next start):** `main/index.ts`'s fallback returned `contextTokensOverride ?? contextTokens` while its comment claimed it matched the next start — which actually launches with `contextTokensOverride ?? (manifest.recommendedContextTokens || contextTokens)` (`startModelRuntime`). The precedence was spelled independently in two places (the root cause), so with no runtime up `maybeEnqueueTreeBuild`'s size gate planned against the legacy 4096 default instead of the 32k+ window the next start would use and over-marked documents `tree_status='pending'`. Fix: ONE spelling — new **`launchContextTokens(settings, manifest)`** in `services/models.ts` (override ?? recommended || legacy; `recommended_context_tokens: 0` or no manifest ⇒ legacy) — `startModelRuntime` launches with it and the fallback mirrors it over the ACTIVE model's manifest via new never-throwing **`findManifestById`** (the `resolveModelByRole` precedent: no dir/no id/no match/unreadable dir all read as null ⇒ today's `contextTokens` fallback stands). Stale comment corrected. **BE-6 (level-boundary yield gap):** `analysis/tree-build.ts`'s in-level `if (g < groups.length) await maybeYield()` never fired after a level's LAST node, so a chat-slot request landing during that node waited that node PLUS the first node of the next level — while `acquireChatSlot` promises "worst case ≈ one node". Fix: `buildTree` also parks at the TOP of the level loop (before each level's first `summarizeGroup`), deliberately OUTSIDE the #41 halve-and-re-pack retry (which only regroups the level's REMAINING children) so an overflow retry can't double-yield; after the true root the loop breaks — still no yield just to finalize. Tests **+5** (`models.test.ts` "launchContextTokens (BE-5)" ×4: manifest recommended window preferred over the legacy setting; `recommended_context_tokens: 0` falls back; unresolvable manifest — field missing (fails validation), unknown id, null dir/id, missing dir — resolves null and falls back; the user override wins over both — pinning the precedence for BOTH callers since `startModelRuntime` routes through the helper; `model-slot-arbiter.test.ts` "builder parks at the level boundary (BE-6)" ×1: drives the REAL `buildTree` over a temp DB — a probe run counts the level-1 nodes, then a chat request landing DURING the final level-1 generation parks the builder BEFORE the first level-2 generation (call count pinned) and the released build resumes in-session to a complete tree; deterministic promise gates, no sleeps; revert-confirmed — removing the hoisted yield reddens exactly this test). `whole-doc-analysis.test.ts` untouched and green (happy-path behavior otherwise byte-identical). Suite **3981/47** + typecheck green.

_2026-07-10 — **full-audit 2026-07-10 BE-2 + BE-4 + BE-7: download-manager robustness — lock-proof checksum cache, cancel honoured during verify, latched translator repairable without restart.**_
**BE-2 (a workspace lock mid-download made a SUCCESSFUL download report failed):** `registerDownloadIpc` evaluated the `ctx.db` getter ONCE at registration and the closure held that raw handle across a multi-hour job; locking the encrypted vault closes the DB, so on completion `primeChecksum → store.set → getSettings(closedDb)` threw "database is not open" AFTER the verified weight was renamed into place — `runOne`'s generic catch marked the job `failed`, `onModelInstalled` never fired (#40 activation lost), the `model_download_verified` audit event was lost, and a two-file vision job never fetched its mmproj. Fixed at BOTH layers (belt + suspenders): (1) `runOne` wraps the `primeChecksum`/`invalidateChecksum` calls in try/catch — the checksum cache is an OPTIMIZATION and its fault never changes job outcome (log carries modelId/jobId only, S1); (2) `createSettingsHashStore` now takes a **getter (`() => Db`)** — never a pinned handle — and get/set/delete catch DB errors, degrading to a store-local in-memory fallback (consulted ONLY when the DB is unreachable, so cross-instance "Verify checksum" invalidations are never shadowed). ALL call sites migrated to the one construction (`registerDownloadIpc` — its unlock guard dropped, the store is lock-aware itself; `registerModelIpc` ×3; `vision/status.ts`; no divergent constructions — the `composeTranslator` drift-trap lesson). **Lock policy decided + recorded (architecture downloader section): downloads keep RUNNING through a workspace lock** (weights live outside the vault; safe now because of 1–2). **BE-4 (cancel during `verifying` silently dropped):** `cancel()` only acted on queued/downloading, so a cancel during the minutes-long SHA-256 over a multi-GB weight on USB was a no-op and a two-task job then started downloading its next file. `verifying` is now a cancellable state; `runOne` re-checks `controller.signal.aborted` after the verify returns (BEFORE acting on the result/renaming — status set explicitly, since a cancel racing the `verifying` transition could be overwritten) and `run()` re-checks between files. The pinned contracts hold unchanged: nothing renamed, `.part` KEPT for resume, mid-download-cancel and resume tests untouched. New injectable `DownloadManagerDeps.verifyImpl` seam (the `downloadImpl` precedent) makes the test deterministic — gate-released fake verify, no sleeps. **BE-7 (startFailed-latched translator blocked the re-download repair):** `onModelInstalled` re-composed only a NULL slot, so a `startFailed`-latched instance (corrupt GGUF) blocked the delete-and-re-download repair until app restart. `TranslationRuntime` exposes **`isStartFailed()`** (optional on the `Translator` interface — fakes read as live); new `shouldReplaceTranslator` (compose-services.ts) holds the rule: replace null OR latched (a latched instance is lazy/dead — construction spawns nothing, no child to orphan), NEVER a live sidecar; main/index.ts consumes it. Tests **+7** (`downloads.test.ts` ×2: throwing store → two-file job still `done` + `onModelInstalled` once + both files in place; cancel-during-gated-verify → terminal `cancelled`, `.part` kept, task 2 never requested; `models.test.ts` ×2: closed-DB degrade round-trip, live-handle-per-call across a DB swap; `compose-translator.test.ts` ×3: null/undefined replaced, live never (with or without reporter), latched replaced + re-composition yields a fresh un-latched selection; `translation-runtime.test.ts`: `isStartFailed` pinned true on the F-7 latch, false on healthy + bind-race, in place). Teeth revert-confirmed: un-cancellable `verifying` and a rethrowing cache belt each redden exactly their new test. Docs: architecture downloader section (cancel-in-every-live-state + the lock-policy paragraph), #40 record wording ("only when the slot is null" → + the latched case), known-limitations F-7 bullet (re-download now also clears the latch). Suite **3976/47** + typecheck green.

_2026-07-10 — **full-audit 2026-07-10 BE-1: settings write gate rejects null/junk; checksum-cache reader self-repairs.**_
`updateSettings`' generic type gate (`settings.ts`) had two holes: `value === null` bypassed the check for EVERY key — `{ checksumCache: null }` persisted over the non-nullable `{}` default and `createSettingsHashStore.get`'s `.checksumCache[path]` then threw out of `listModels`/`verifyModel`/`startModelRuntime`/`downloadModel` until the row was repaired (Models screen brickable via one IPC call) — and the five null-default keys (`activeModelId`, `activeEmbeddingModelId`, `lastBenchmark`, `gpuLastError`, `gpuProbe`) carried no type information, so ANY JSON of any size persisted into the encrypted blob. Fix (characterization-first; the 6 new desired-behaviour cases failed on the old code): null is accepted only where the default is null (that is how the active model is cleared — verified against call sites; the "Try GPU again" `gpuLastError: null` clear keeps working); non-null values for the null-default keys are shape-checked (bounded strings — ids ≤ `MAX_SETTINGS_ID_LENGTH` 512, `gpuLastError` ≤ `MAX_SETTINGS_ERROR_LENGTH` 4096, SEC-1 bounding style; `persistGpuFailure` truncates to 2 000 chars well under it — plain objects for `lastBenchmark`/`gpuProbe`); `contextTokensOverride`'s existing clamp untouched. `registerCoreIpc`'s updateSettings handler now shape-checks the patch (non-null object, not array) BEFORE `Object.keys` — a null patch used to escape as a raw TypeError; junk rejects with the friendly localized copy (new `main.settings.invalidPatch`, en+de). Read-side belt: `createSettingsHashStore.get` reads `checksumCache ?? {}`, so a pre-fix corrupted row degrades to a cache miss and the next `set()` self-repairs it (tested by hand-corrupting the row via SQL); known-limitations read-side note extended. Call-site grep: every production writer already sends valid shapes — nothing legitimate is newly rejected. **Note: the `rag*` numeric knobs remain unclamped** (they flow into retrieval via `ragSettingsFrom`; clamping would change behaviour for extreme-value users — recorded open item). Suite 3969/47 + typecheck green.

_2026-07-10 — **full-audit 2026-07-10 BE-3: German router regexes — verb stems now match inflected forms.**_
The German alternatives in the task router's `COVERAGE_RE`/`SUMMARY_RE`/`COMPARE_RE` (`analysis/router.ts`) were verb stems behind a **trailing `\b`** that inflected forms can never satisfy (`auflist\b` never matched "Auflistung", `zähl\b` never "Zähle", `zusammenfass\b` never "Zusammenfassung", `vergleich\b`/`unterschied\b` never "Vergleiche"/"Unterschiede"), and `\büberblick` never matched "Überblick" (JS `\b` is ASCII-defined — the position before "Ü" is not a boundary). Realistic inflected German list/count questions therefore silently took top-k relevance and the issue-#38 deep-index hint never fired — the exact class #37/#38 were shipped to close (`SUMMARY_RE`/`COMPARE_RE` were latent but fixed to the same standard). Fix mirrors `AGGREGATION_RE` (the #37 regex that got it right): stems in their own alternation group with **no trailing `\b`**, **leading `\b` kept** (all stems ASCII-initial; it is what stops `\bzähl` firing inside "erzählen"), `überblick` unbounded, plus a `fass(e|t|en)…zusammen` alternative for the separable imperative ("Fasse das Dokument zusammen"); the rules are now stated in the comment above the regexes for future entries. `TYPE_SYNONYMS` audited for both mistakes: clean (all full words, none umlaut-initial), unchanged. Characterization-first tests: an 8-row inflected-DE table + EN controls (byte-identical English behaviour) + the "Erzähle" negative in `extract-router.test.ts`, and an end-to-end inflected German count question in `rag-skill-analysis.test.ts` (with extract data → deterministic coverage-extract listing, 0 model calls; without → answer leads with the deep-index hint). EN alternation groups character-identical. Suite 3962/47 + typecheck green.

_2026-07-10 — **Public-launch prep: v0.1.46 release commit prepared (Phase-7 flow test — owner tags + pushes).**_
Version bumped `0.1.45` → **`0.1.46`** (root + `apps/desktop` + lockfile, `npm version --workspaces --include-workspace-root`). CHANGELOG `[Unreleased]` curated: the stale "curated ten languages" translation bullet → the real **51 languages** + the GPU-accelerated/CPU-fallback sentence (both shipped in the v0.1.45 wave); header note now names `0.1.46`. The block stays `[Unreleased]` deliberately — `release.yml` extracts it as the draft-release notes at tag time. **Owner ritual from here (the Phase-7 flow test, on the still-private repo):** push master, optionally prove the build legs once via `workflow_dispatch`, then `git tag v0.1.46` + push the tag → CI builds the three artifacts + a DRAFT prerelease → owner downloads artifacts and runs the packaging.md post-package smoke (incl. the first-ever packaged-app OCR run and the CPU safety-net case if on a CPU-only box) → **Publish** (or delete draft, fix, re-tag). Suite 3956/47 + typecheck green.

_2026-07-10 — **Public-launch prep Phase 5: `release.yml` — tag-triggered prebuilt win/mac/linux packages, draft-first.**_
**Decision (release-readiness report §5, owner 2026-07-10):** prebuilt packages ship from GitHub Releases via ONE workflow, [`release.yml`](.github/workflows/release.yml) — trigger = `v*` tag push (+ `workflow_dispatch` for ad-hoc builds that skip the tag-gated release job). Jobs: `build-win` (windows-latest: `npm ci` → typecheck → **full suite** (first-class OS only) → `package:win` → portable `.exe`), `build-mac` (macos-14: package `dir` → ad-hoc sign → ditto-zip `.app.zip` (must stay zipped on exFAT) → fetch-runtime Metal → symlink-dereferenced `llama-runtime-mac-arm64.zip`), `build-linux` (AppImage), `release` (tag==package-version assertion → `SHA256SUMS.txt` → notes from the CHANGELOG `[Unreleased]` block prefixed with the "app only — models fetched separately" line → **DRAFT** release, `prerelease: true` while 0.x). **The new owner ritual: bump → tag → CI builds a draft → owner downloads artifacts + runs the packaging.md post-package smoke → Publish** (failed smoke = delete draft, fix, re-tag). Signing = stage 0 unsigned; the `APPLE_*`/`CSC_*` then `WIN_CSC_*` secrets upgrade in place (remove the one `CSC_IDENTITY_AUTO_DISCOVERY` line when Apple certs land) — staged table in packaging.md. Hard rules untouched: release builds are dev-infrastructure network (ci.yml class); the app ships no update checks and no weights; `npm ci` closes the CI half of hardening L-8. **`win-build.yml` + `mac-build.yml` DELETED** (superseded; their `ci/mac-build*`/`ci/win-build*` trigger branches are KEPT per the Phase-6 deferral — they carry their own copies, harmless). No test asserted the workflow files (checked). Docs: packaging.md "Packaging workflows" section → the release-flow record (jobs, draft→smoke→publish ritual, signing table); README "Getting started" gains step 0 **Download** (honest before the first release exists); user-guide §2 + troubleshooting gain the "installed from a GitHub release" path incl. the macOS-15 "Open Anyway" flow + models-arrive-separately. **Validation pending on the owner:** after push, one `workflow_dispatch` run must produce all three artifacts (proves the build legs before the first tag). Suite + typecheck green.

_2026-07-10 — **Public-launch prep Phase 4: docs readability sweep — retired-plan/audit remarks out of the reader-facing docs; §-anchor legends and design records untouched.**_
The sweep (owner decision 2026-07-10) worked the three-bucket rule: **(a) decorative history deleted/compressed** — README's "phased plan retired" clause; known-limitations' giant changelog header + ~35 audit-round provenance tags (`full-audit-2026-06-29-postmerge F1`-style; the surviving short ids like `D77`/`C1`/`H7` resolve via the design-record legends, said in a new History footnote); packaging/drive-layout/model-policy/benchmark's "(Phase N)"/"Since Phase N" framing and the packaging `git show`-the-retired-provisioning-plan pointer; architecture.md's changelog header → a §-record orientation note. **(b) KEPT verbatim** — every §-numbered design record + §-anchor legend (architecture/rag-design/design-guidelines), security-model.md wholesale (it IS the security ledger; code cites its finding ids), model-benchmarks' history footer, the `SKA-N`/`audit §N.M` citations in known-limitations' skills residuals (arch §44's legend example SKA-24 is cited from 6+ source files — spot-checked SKA-24/§39/rag-design §14.5 all resolve). **(c) open work de-phased into plain words** — "Phase 22" → "signed offline update bundles are not built yet; there is no update mechanism" (known-limitations); result-tables narration ("closed by Phase 2 (same day)" strikethroughs) rewritten as current behavior with the residuals pointed at the still-open `result-tables-plan.md` (that file and `big-slot-embeddings-plan.md` legitimately stay). **BUILD_STATE §2.5 fixes:** §5's embedded "current gate" 1083/25 (2026-06-13) → 3956/47 (2026-07-10); a single snapshot-correction note under the header covers the stale "UNPUSHED"/"UNMERGED" remarks in earlier entries (one-line correction, no history rewriting). user-guide/troubleshooting/CONTRIBUTING were already clean; CLAUDE.md deliberately untouched (contributor-facing lifecycle rule). Suite + typecheck green.

_2026-07-10 — **Public-launch prep Phase 3: TranslateGemma O1 license review closed (in-app path APPROVED; manifest status deliberately stays `pending`).**_
The Gemma Terms analysis (release-readiness working paper §7, owner decision 2026-07-10) closed the O1 review's in-app half: the **in-app, license-gated download path is APPROVED** — the §3.1 flow-down binds the weight's distributor (HF → the user; the app is the conduit behind the ack checkbox + `license_url`), commercial USE is allowed, outputs are unencumbered (§3.3), and the Prohibited Use Policy is incorporated by reference + updateable. **Commercial-drive preloading stays a separate OPEN review** carrying the four-point flow-down checklist (Terms copy on the drive, verbatim NOTICE line, enforceable use-restriction clause in sale terms, quantization-provenance notice), recorded in the manifest notes + model-policy.md. **Deliberate deviation from the plan's literal "status: approved":** the plan's own step-2 check ("confirm the flip doesn't accidentally authorize commercial bundling") FAILED for a plain flip — `bundled_on_preconfigured_drive` is advisory/UNUSED by the validator (known-limitations), so `license_review.status: pending` is the ONLY mechanical guard in `assertCommercialDrive` + both `build-commercial-drive` scripts (they require `approved` for EVERY manifest on the drive), and the flip would additionally remove the in-app license-acknowledgement checkbox (`ModelDownloadInfo.licenseApproved` → `needsAck`) that the §7 compliance verdict leans on. So the review CLOSURE is recorded in `reviewed_by`/`reviewed_at`/`notes` (+ a yaml comment stating the flip precondition: flow-down artifacts + a license-class ack gate) while `status: pending` keeps both gates closed. RUNTIME NOTE (no `--jinja`) kept verbatim. No code change; suite + typecheck green.

_2026-07-10 — **Public-launch prep Phase 2: dev-machine paths scrubbed + CHANGELOG version fixed.**_
`CHANGELOG.md` header note now states the real current `package.json` version (`0.1.45`, was a stale `0.1.41`). The dev box's smoke-drive path was removed from every tracked file (owner decision 2026-07-10 — "from everywhere", incl. the two BUILD_STATE log lines below): `docs/model-benchmarks.md` (×3), `docs/packaging.md`, `apps/desktop/tests/real-data/README.md` (×2), `tests/manual/categorizer-smoke.test.ts`, and this file's 2026-07-07/2026-06-20 entries — replaced by `<your-smoke-drive>` in runnable snippets and "a locally provisioned smoke drive (llama.cpp binary + a small chat GGUF)" in prose; the real location stays with the owner off-repo. The lawyer-machine fixture path in `tests/unit/skills-categorizer.test.ts` (basename-extraction test — asserts parsing, not the path) → neutral `/home/user/Documents/bank/taxonomie.csv`. Docs/tests-only; suite + typecheck green.

_2026-07-10 — **Public-launch prep Phase 1: security/CoC contact published.**_
`SECURITY.md` ("Reporting a vulnerability") and `CODE_OF_CONDUCT.md` (Enforcement) now name **security@hilbertraum.ai** as the private reporting channel (owner decision 2026-07-10; one mailbox for both). SECURITY.md additionally mentions GitHub private vulnerability reporting "where available" (PVR is enabled at flip time, not yet) and sets a modest response expectation (acknowledgement within a few business days). §5 item 1c marked resolved — the remaining halves (create the mailbox; enable PVR) are owner actions. Docs-only change; suite + typecheck green.

_2026-07-10 — **Beta feedback issues #44 + #45 + #46 (skills discoverability/honesty wave: stale result row hid the "Apply text edits" button; PDF edit/redact's `.txt` output was a save-dialog surprise; skills unexplained at selection) — SHIPPED on local `master`; issues commented + closed via API.**_
**#44 (offer suppressed by a terminal result):** `SkillRunBar`'s strict `if/else if` ladder made the OFFER row (the only place the run buttons exist) unreachable while ANY un-dismissed run existed — but the deterministic edit-routing answer (`analysis/document-edit.ts`, `skills.editRouting.answer`) names the button unconditionally and main can never see run-bar state, so users were sent hunting for a button that wasn't rendered. Fix = the issue's suggestion 1 (renderer-only): only an IN-FLIGHT run (`running`/`stateUnknown`) suppresses the offer; a terminal (done/failed/cancelled) result row now renders ABOVE the restored offer until dismissed — exactly the pre-run UI plus the result line. Auto-dismiss-on-send (suggestion 1b/2) was deliberately NOT taken: a failure row must not vanish unread because the user sent an unrelated message. **#45 (PDF in → .txt out, discovered too late):** shipped the issue's stage 3 — the pre-run `ConfirmDialog` for the two transform tools (the descriptors with a `docxDialog`) appends an output-format line derived renderer-side from the selected target's extension (the SAME title-extension signal main's `buildOriginalDocumentReader` branches on): `.docx` → keeps Word format; else → "will be plain text (.txt) — layout/formatting not kept"; unknown target name → the full matrix line, never a guess (`chat.skill.confirm.outputDocx/outputText/outputMatrix`, EN+DE). Behavior unchanged — the honesty moved BEFORE the run. Stages 1–2 (true-redaction PDF / regenerated attributed PDF) stay OPEN as an owner decision (§5): both need a PDF-writing dependency (`pdf-lib`-class; only the reader `pdfjs-dist` is in the tree) and regeneration additionally a shipped embeddable font (none in repo) — deliberately not smuggled into a fix wave against the D77 record. **#46 (skills unexplained at the decisive moment):** new first-selection **`SkillInfoCard`** above the composer — three one-sentence lines (what it does / what it **needs** to apply / key honesty **limit**, incl. the #44 button location and the #45 format matrix said up front) + pick-lifetime footer + **Learn more**. Content = new pure-data catalog `shared/skill-info.ts` (manifest-id → `skills.info.<id>.what/needs/limits` i18n keys, EN+DE, all 9 app skills; user skills fall back to their own description — no invented claims). Once-per-skill memory = new `AppSettings.skillInfoSeen: string[]` (declared ids, content-free; the settings service's generic string[] sanitizer already covers it; unresolved seen-state shows nothing — a missed card, never a re-nag); afterwards the ⓘ next to the picker chip (`SkillPicker.onInfo`) re-opens it; card hides when it no longer matches the ACTIVE pick. Learn-more deep-links the Skills screen's existing detail modal via a one-shot renderer mailbox (`lib/skillDetailRequest.ts`, consumed in `SkillsTab`'s list-load effect — nothing crosses the IPC). Stale user-guide §9 "remembers it as that conversation's default" corrected to the real U3 per-turn/keep semantics. Tests **+17** (`SkillRunBar.test.tsx` ×6: offer coexists with done/failed/cancelled result, in-flight suppression pinned, PDF-target `.txt` warning, `.docx`-target keep-format line, no-target matrix fallback, plain-export has NO format line; new `SkillInfoCard.test.tsx` ×4: catalog lines incl. button-location + format-cliff copy, user-skill description fallback, close/learn-more handlers, no-handler omits link; new `SkillInfoFirstPick.test.tsx` ×4: first pick shows card + persists `['bank-statement']` by DECLARED id, seen skill silent + ⓘ round-trip, clear hides, learn-more navigates; `SkillsTab.test.tsx` ×2: deep-link opens the modal / unknown id opens nothing; `db-settings.test.ts` ×1: `skillInfoSeen` round-trip + element-wise junk sanitization) → **suite 3956/47**; typecheck + build green. Docs: architecture (run-bar §22 paragraph: in-flight-only suppression + confirm format line; routing-handler record: the #44 closure note; §23 record: the #45 said-up-front bullet + open stages; new "First-selection skill info card (#46)" record after §6), user-guide §9 (picker semantics de-staled, info card + ⓘ, result-row-plus-buttons, confirm-names-the-format), known-limitations (same-format bullet gains the said-up-front + still-open-PDF-out note).

_Older dated entries (2026-07-09 and earlier) and the Skills S2–S12 handoff sections were
moved **verbatim** to [`docs/build-log.md`](docs/build-log.md) on 2026-07-12 — citations of
the form "BUILD_STATE <date> entry" / "BUILD_STATE V1" / "Skills — Sn handoff" resolve there._

---

## 1. Current status

| Phase | Name | Status |
|---|---|---|
| 0 | Repo skeleton & tooling | 🟢 done |
| 1 | App shell, workspace & settings | 🟢 done |
| 2 | Model manifests & runtime contract | 🟢 done |
| 3 | Basic chat (mock runtime) | 🟢 done |
| 4 | Document ingestion & chunking | 🟢 done |
| 5 | Embeddings & vector search (mock) | 🟢 done |
| 6 | RAG chat with citations | 🟢 done |
| 7 | Hardware benchmark & recommendation | 🟢 done |
| 8 | Privacy & offline hardening | 🟢 done |
| 9 | Encrypted workspace | 🟢 done |
| 10 | Real llama.cpp runtime & embeddings | 🟢 done |
| 11 | Drive layout, scripts & packaging | 🟢 done |
| 12 | DIY asset loader (`fetch-assets`) | 🟢 done |
| 13 | Plug-and-play distribution (commercial drive) | 🟢 done |
| 14–16 | GPU acceleration (Vulkan distribution · probe/ladder runtime · surface) | 🟢 done 2026-06-10 — `architecture.md` GPU record §1–§8 |
| 17 | RAG trust & document-scoped asking | 🟢 done 2026-06-10 — `rag-design.md` §10 |
| 18 | In-app model downloader | 🟢 done 2026-06-10 — `architecture.md` "In-app model downloader" |
| 19 | Audit log (`runtime_events`) | 🟢 done 2026-06-10 — `architecture.md` "Audit log" + `security-model.md` |
| 20 | Answer-depth modes (Fast/Balanced/Deep) | 🟢 done 2026-06-10 — `architecture.md` "Chat & streaming" |
| 21 | Retrieval quality (reranker + hybrid FTS5 search) | 🟢 done 2026-06-10 — `rag-design.md` §11 (as built) + §12 (record); both manual measurements done |
| 22 | Signed offline update bundles | 🔴 blocked (key-management design) — outline in §5 item 3 |
| 23–27 | UI polish wave (tokens/theming · components · chat restructure · IA regroup · microcopy/ambient signal/first-run) | 🟢 done, merged to master 2026-06-10 — `docs/design-guidelines.md` (+ its §11 rollout record) |
| 28 | Model catalog wave 1 (challenger manifests, D16–D18/D22) | 🟢 done 2026-06-10 — 4 Apache-2.0 challengers, real hashes, all 10 catalog weights VERIFIED on `D:\`, bring-up smokes PASS |
| 29 | Benchmark protocol + first comparison run (D19/D20) | 🟢 done 2026-06-11 — judge-free QA+speed+RSS protocol run on all 8 models; RAM mins recalibrated, recommender quality-aware (`recommendation_rank`), Gemma thinking flag ON. Optional dev-box speed sweep = completeness only |
| 30 | Opt-in big slot + embeddings (D21 → D38–D43) | ⚪ retired 2026-07-12 unimplemented — Track A superseded by the Qwen3.5/3.6 pipeline (§5 item 8), Track B deferred post-MVP (§5 item 4); disposition `model-benchmarks.md` §9.2 |
| 31 | Conversation search + permission-handler rider | 🟢 done 2026-06-11 — wave-3 record §4 |
| 32 | Vault password change (descriptor v2 envelope) | 🟢 done 2026-06-11 — wave-3 record §5 |
| 33 | Document tasks foundation + one-click summary | 🟢 done 2026-06-11 — wave-3 record §6 |
| 34 | Document translation workflow | 🟢 done 2026-06-11 — wave-3 record §7 |
| 35 | Compare two documents | 🟢 done 2026-06-11 — wave-3 record §8 |
| 36 | Audio transcription as ingestion (whisper.cpp sidecar family) | 🟢 done 2026-06-11 — wave-3 record §9 |
| 37 | Voice dictation in the composer | 🟢 done 2026-06-11 — wave-3 record §10 |
| 38 | Scanned-PDF / photo OCR (tesseract.js + `ocr/` assets) | 🟢 done 2026-06-11 — wave-3 record §11; **wave 3 COMPLETE** |
| 39 | i18n foundation + proof slice (shared `t()` + catalogs, `uiLanguage` + picker, pre-unlock language) | 🟢 done 2026-06-13 — `architecture.md` i18n record (§3.1/§3.2 + R-L1 finding) |
| 40 | i18n renderer string sweep (all screens/components, plurals, dates/numbers, shared-component `t` prop) | 🟢 done 2026-06-13 — `architecture.md` i18n record §5 |
| 41 | i18n main-process boundary (emissions via `tMain()`, persist-canonical English + D-L4 display map, dialog titles) | 🟢 done 2026-06-13 — `architecture.md` i18n record §3.3 |
| 42 | i18n German QA + closeout (de review, text-expansion audit, eyeball walk, docs) | 🟢 done 2026-06-13 — **wave COMPLETE**; record + Phase-42 QA notes in `architecture.md`; German human review (D-L7) handed to the user |
| 43 | Invoice hardening (incident 2026-07-04: format-negation replay, reconciliation gating, glyph-soup refusal + geometry retry, recipient field, export BOM) | 🟢 done 2026-07-04 — `architecture.md` Skills record §42 |

Legend: ⚪ not started · 🟡 in progress · 🟢 done · 🔴 blocked

> Remaining for *release* = **manual acceptance only** (§5): a real signed/notarized build +
> a USB spec-§17 demo (R5/R7), the GPU hardware matrix (§5 item 1b), the Activity-panel
> live-UI eyeball, the packaged-app OCR smoke.

---

## 2. Environment (verified 2026-06-09)

| Tool | Status |
|---|---|
| Node | v24.13.0 ✅ |
| npm | 11.6.2 ✅ |
| corepack | 0.34.5 ✅ (pnpm available if needed) |
| git | 2.54.0.windows.1 ✅ |
| winget | available ✅ |
| Rust / Cargo / rustup | ❌ NOT installed |
| Python | ❌ NOT installed |

OS: Windows 11 Pro (10.0.26200). Shell: PowerShell + bash both available.
Repo root: the repo checkout (any path/drive — no path assumptions).

---

## 3. Decisions log

- **Stack = Electron + React + TS + Vite** (user choice; Rust not installed). Spec §4 permits Electron fallback.
- **Package manager = npm** with workspaces.
- **SQLite = `node:sqlite`** → fallback `sql.js` (WASM) if unstable. Avoid native `better-sqlite3`.
  ⚠️ **`node:sqlite` lives in the bundled Node of *Electron's main process*, not the system Node.**
  It needs Node ≥ 22.5. Electron 33 bundles Node 20 (no `node:sqlite`), so **Electron is pinned to
  `^37` (Node 22.x)**. Validate `node:sqlite` *inside Electron* at the start of Phase 1, not against
  system Node.
- **Mock-first:** `MockRuntime` + `MockEmbedder` so the app runs with zero model files. Real llama.cpp/embeddings deferred to Phase 10, behind the same interfaces.
- **Vector search = cosine over SQLite-stored vectors** for MVP.
- **Plaintext dev workspace allowed in dev**; encrypted is the commercial default (Phase 9).
- **YAML parsing = `yaml` npm package** (Phase 2 decision). Pure JS, no native deps, MIT, offline.
  Chosen over hand-rolling for reliability; parsing happens in the main process only. Validation is a
  hand-written pure function in `shared/manifest.ts` so it is shared with the renderer and unit-tested
  without I/O.
- **Manifest `local_path` is relative to the drive root** (existing Phase 0 manifests already include
  the `models/` prefix), so weight files resolve to `<root>/models/...`. Recommendation is data-driven
  via an optional `recommended_profiles` list on each manifest.
- **Ingestion parser libs (Phase 4): pure-JS, lazy-imported, externalized.** `pdfjs-dist` (PDF),
  `mammoth` (DOCX), `papaparse` (CSV) — no native deps, consistent with the `node:sqlite` choice.
  Imported lazily inside `parse()`. Marked **external** via `externalizeDepsPlugin` in
  `electron.vite.config.ts` (also externalizes `yaml`) so the large pdfjs ESM bundle is
  `require`/`import`-ed from `node_modules` instead of bundled (resolves R3). Main bundle shrank
  253 kB → 47 kB as a result.
- **PDF parsing approach (Phase 4):** use pdfjs-dist's **legacy** build
  (`pdfjs-dist/legacy/build/pdf.mjs`), which runs in the Node main process with **no Web Worker /
  no DOM** (validated). The `standardFontDataUrl` warning is harmless (rendering-only). Minimal
  ambient typings in `parsers/pdfjs.d.ts` (pdfjs ships no `exports` map for the legacy path).
- **Imported files are copied into the workspace** (`workspace/documents/`, `stored_path`), keeping
  `original_path` too → self-contained, re-indexable drive (spec privacy ethos). See Phase-4 contract.
- **Import = async with polling** (not the chat stream): documents table is per-file truth, job
  aggregate is in-memory via `getImportJob`. See Phase-4 contract for rationale.
- **Embedder placement (Phase 5):** `services/embeddings/` behind an `Embedder` interface
  (spec §9.2), mirroring `ModelRuntime`. A single `embedder` lives on `AppContext` (created in
  `main/index.ts` as `createMockEmbedder()`); the real E5/llama.cpp embedder is a localized
  Phase-10 swap. Ingestion takes the embedder as **optional deps** (`{ embedder?,
  embeddingModelId? }`) so Phase-4 callers/tests stay valid (no embedder → pass-through).
- **Vectors = `Float32Array`** (not `number[][]`) so BLOB encoding is a direct byte view and the
  real GGUF embedder fills typed arrays without conversion. **Dimensions = 384**, matching the
  E5-small manifest (`multilingual-e5-small-q8`) so the real swap is drop-in.
- **Embedding BLOB encoding (LOCKED):** `vector_blob` = raw little-endian Float32 bytes
  (`Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)`). Decode **copies** into a fresh
  4-byte-aligned buffer first (SQLite blobs can be unaligned → `Float32Array` view would
  otherwise `RangeError`). Tagged with `settings.activeEmbeddingModelId`, falling back to
  `embedder.id`.
- **Vector search = linear scan cosine** over the `embeddings` table for MVP (`VectorIndex`),
  with an ANN (sqlite-vec/HNSW) upgrade path behind the same `search` signature.
- **MockEmbedder = feature hashing** (SHA-256 tokens → signed buckets → L2-normalize),
  deterministic + fully offline (uses only `node:crypto`).
- **RAG service placement (Phase 6):** `services/rag/` (separate from `chat.ts`) holds the
  whole grounded path — `retrieve`, `buildGroundedPrompt`, `buildGroundedChatMessages`,
  `generateGroundedAnswer`, and the retrieval-settings mapper — reusing chat helpers
  (`appendMessage`/`listMessages`/`BASE_SYSTEM_PROMPT`) so the Phase-3 chat path is
  untouched. `askDocuments` is its own IPC module (`registerRagIpc.ts`).
- **Retrieval defaults (spec §7.8, LOCKED on `AppSettings`):** `ragTopKInitial = 12`,
  `ragTopKFinal = 6`, `ragMaxContextTokens = 2500`, `ragMinSimilarity = 0`. Read per request
  via `ragSettingsFrom(settings)`.
- **Dedup strategy:** dedup retrieved chunks by `(document_id, page_number)`, keeping the
  highest-scoring chunk per page. Page-less chunks (txt/md) are keyed by chunk id so they are
  **not** collapsed (page dedup would otherwise drop all but one window of a text file). The
  token budget always includes the single top chunk before enforcing `maxContextTokens`.
- **`[Sn]` labels assigned per query, never stored** (confirmed). Only the resolved
  `Citation[]` is persisted in `messages.citations_json`. **Retrieval is the source of truth
  for citations** — the mock runtime's echo has no real `[Sn]` markers, so computed citations
  are persisted directly (a real model emitting inline `[Sn]` still resolves against them).
- **`Citation.snippet` (additive):** `Citation` gained an optional `snippet` (truncated chunk
  text, ≤ `SNIPPET_MAX_CHARS` = 600) so the renderer's source panel shows the cited text and
  it survives reload via `citations_json`. Additive + optional → old rows are unaffected.
- **Grounding / empty-corpus copy:** when retrieval finds no usable chunks, the runtime is
  **not called**; a fixed `NO_DOCUMENT_CONTEXT_ANSWER` ("I couldn't find anything about that
  in your documents…") is persisted with no citations. Makes the no-hallucination guarantee
  deterministic + testable.
- **Grounded-prompt placement:** the grounded template (rules + question + numbered excerpts)
  replaces the **last user turn** sent to the runtime; the system message stays
  `BASE_SYSTEM_PROMPT`. The DB keeps the raw question (transcript/title).
- **Shared in-flight registry (`ipc/inflight.ts`):** chat + RAG share one
  `Map<conversationId, AbortController>` so the existing `stopGeneration` cancels either path.
- **Benchmark is strictly local (Phase 7):** `services/benchmark.ts` uses only `node:os` +
  `node:fs` + `node:crypto` — no `child_process`, no remote/GPU probes, no telemetry. A
  no-network assertion guards the whole path. Every probe is independently resilient: a
  failure yields a `null` value + a friendly warning, never a throw (a machine where
  everything fails still yields a valid `UNKNOWN` result).
- **Profile thresholds (spec §11.3, LOCKED):** RAM in **GiB** (`totalmem()/1024³`, rounded
  0.1); `≤8 → TINY`, `≤16 → LITE`, `≤32 → BALANCED`, else `PRO`; invalid RAM → `UNKNOWN`.
  **Downgrade rule:** `tokensPerSecond < VERY_LOW_TOKENS_PER_SECOND (3)` drops one step (never
  below TINY). **GPU rule:** a useful GPU bumps one step toward PRO (capped) — ~~GPU
  detection is best-effort `null` for now, dormant~~ **superseded by Phase 16**: the
  `--list-devices` probe feeds a precomputed `gpuUseful` hint (≥ 6144 MiB AND not
  integrated — `gpuUsefulForProfile`); `benchmark.ts` itself still never probes.
- **Drive-test bounds:** writes `DRIVE_PROBE_BYTES = 8 MB` of random bytes **inside the
  workspace**, times write (`fsync`) then read → MB/s; **always cleaned up** (`try/finally`);
  failure → `null` Mbps + `error`. **Slow-drive warning** at `< SLOW_DRIVE_MBPS (30)` MB/s —
  warn, never block.
- **Tokens/sec is optional in the mock era:** measured only when a runtime is active (prompt
  *"Write one sentence about privacy."*, up to 64 tokens); `null` otherwise. Real numbers land
  in Phase 10.
- **Benchmark persistence:** spec §8 has **no `benchmarks` table**, so the last result lives in
  the settings store as `AppSettings.lastBenchmark` (JSON `BenchmarkResult`, default `null`).
  **"Never benchmarked yet" default = `UNKNOWN`.** Both former stubs now read
  `lastBenchmark?.profile ?? 'UNKNOWN'`: `getAppStatus().hardwareProfile` and
  `buildModelList`'s `profile` (the `LITE` stub is gone). User-facing copy follows spec §11.4
  (never "your hardware is bad").
- **Policy shape + deny-by-default (Phase 8):** `services/policy.ts` models the spec §6
  `network`/`workspace`/`models` blocks as a camelCase `PrivacyPolicy`. `DEFAULT_POLICY` is
  **deny-by-default for network + telemetry** (both off); workspace/model defaults are
  developer-friendly (plaintext dev + unverified models allowed) since encryption enforcement is
  Phase 9 and model verification already gates on the `developerMode` setting. `config/policy.json`
  + `config/drive.json` are **optional**; missing/malformed → safe defaults **+ a warning, never a
  throw** (`bool()` only accepts real booleans, so junk fields can't weaken the policy).
- **Effective-network rule (LOCKED, Phase 8):** `networkAllowedByPolicy =
  allowModelDownloads || allowUpdateChecks`; `networkAllowed = networkAllowedByPolicy ∧
  user.allowNetwork`; `offlineMode = !networkAllowed`. A (future signed) policy is **authoritative**
  — it can only **restrict**, never expand, the user toggle. With no policy file the deny-by-default
  ceiling keeps the app offline even if `allowNetwork` is on (no network features ship before
  Phase 11 anyway). **Telemetry is always off** (no toggle, hardcoded `telemetryAllowed: false`).
- **`AppStatus.offlineMode` is now policy-aware** (was `!allowNetwork`); added
  `AppStatus.networkAllowed`. New `getPolicy` IPC (`policy:get`) returns `PolicyStatus` (effective
  policy + derived flags) so the UI distinguishes "off by choice" from "disabled by policy"
  (spec §3.6).
- **Loopback exception (LOCKED, Phase 8):** the offline self-check treats `127.0.0.0/8`, `::1`, and
  `localhost`/`*.localhost` as **not** network (dev renderer now; llama.cpp sidecar on 127.0.0.1 in
  Phase 10). Only remote origins are violations. `services/offlineGuard.ts`
  `installOfflineNetworkGuard` wraps `net.Socket.prototype.connect` and **only logs** a remote
  attempt — it never blocks or throws (a wrong host guess must not break local IPC/sidecar). The
  guard is installed in ALL builds when offline (an audit-round fix superseded the original
  dev-only gating); `assertOfflinePosture()` always logs the posture.
- **CSP dev-vs-prod split (Phase 8):** strict CSP applied as a response header
  (`session.webRequest.onHeadersReceived`) on top of the `index.html` meta tag. **Prod:**
  `default-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`,
  `frame-ancestors 'none'`. **Dev:** relaxes `connect-src` to `ws://localhost:* http://localhost:*`
  and adds `'unsafe-inline'`/`'unsafe-eval'` to **`script-src`** (+ `'unsafe-inline'` on `style-src`)
  for Vite HMR (a strict policy breaks `npm run dev`).
- **Logs-local guarantee (Phase 8):** confirmed `services/logging.ts` is the only log writer
  (rotating `app.log` under `logsPath`); nothing writes logs/crash data off-device. Stated as fact
  on the Privacy screen + PRIVACY.md. **Superseded 2026-06-13 (encrypted-log change):** still the
  only writer, but on an encrypted workspace it writes `app.log.enc` (sealed under the vault key),
  not plaintext — see the "Encrypt the diagnostics log at rest" entry at the top + `security-model.md`.
- **KDF = Argon2id (default for new vaults), scrypt still supported (Phase 9 → audit round 2, R4):**
  NEW vaults derive the key with **Argon2id** (OWASP-recommended) via the pure-JS, audited
  **`@noble/hashes`** — no fragile native `argon2` build (the original R4 blocker). Default params
  `m=19456 KiB (19 MiB), t=2, p=1, keyLen=32` (~0.5 s/unlock). `node:crypto` **`scrypt`** is fully
  supported still (`SCRYPT_KDF` = `N=2^15, r=8, p=1`) so any vault created under the earlier scrypt
  default unlocks unchanged: the descriptor records `algo` + params and `deriveKey` dispatches on them
  — **no on-disk format change**. `KdfParams` fields are per-algo (`scrypt: N/r/p` · `argon2id: m/t/p`),
  validated in `deriveKey`. New dep: `@noble/hashes` (pure-JS, externalized like the parser libs).
- **Whole-DB-FILE encryption-at-rest (Phase 9, plan §4b):** `node:sqlite` has no SQLCipher, so the
  whole file is encrypted (AES-256-GCM, fresh 12-byte IV/encryption, 16-byte tag) — **the spec §8
  schema is identical in both modes**. At-rest artifact = `hilbertraum.sqlite.enc` (framed
  `MAGIC|iv|tag|ciphertext`). **On unlock:** verify password against an authenticated verifier (no
  DB touched) → decrypt `.enc` → `hilbertraum.sqlite` **on the drive** → `openDatabase`. **On lock/quit:**
  `PRAGMA wal_checkpoint(TRUNCATE)` + close → re-encrypt → `.enc` → **shred** the plaintext working
  file + `-wal`/`-shm`. The plaintext working copy on disk while unlocked is a **documented
  limitation**; secure-erase is **best-effort** on SSDs (wear-levelling).
- **Vault descriptor = unencrypted `config/workspace.json` (Phase 9):** settings (incl.
  `workspaceMode`) live INSIDE the encrypted DB, so the app can't read them pre-unlock. The
  descriptor `{ version, mode:'encrypted', kdf{algo,N,r,p,keyLen}, saltB64, verifier{iv,tag,ct} }` is
  the **only** pre-unlock artifact; it holds salt + KDF params + an AES-GCM **verifier** (known
  plaintext under the key) — **never** the password or key (both memory-only). Tests scan the
  descriptor + `.enc` and assert the password is absent.
- **Plaintext gating now ENFORCED (Phase 9):** `plaintextAllowed(policy, {isDev, developerMode})` —
  `workspace.encryptionRequired` is an absolute veto; `allowPlaintextDevMode` must be true; AND the
  caller must be a developer (dev build / developer mode). Pre-unlock `developerMode` is unreadable
  (in the encrypted DB) so `isDev` is the proxy. ⇒ a commercial build (not dev, encryptionRequired
  or no policy file) **defaults to encrypted** and onboarding never offers plaintext.
- **Lock-on-quit + Lock-now (Phase 9):** `WorkspaceController.lock()` runs on `will-quit` (alongside
  `runtime.stop()`) and from a sidebar **Lock now** button. `lock()` is a **no-op for plaintext_dev**
  (nothing to protect; closing it would wedge the app back into onboarding) — the plaintext DB just
  stays open until process exit. `db` on `AppContext` is a **getter** over the controller
  (`requireDb()` throws while locked), so all existing `ctx.db` call sites are unchanged and track
  unlock/lock at call time.
- **Sidecar discovery + env override (Phase 10):** `resolveLlamaServerPath(rootPath, platform, env)`
  finds `runtime/llama.cpp/<os>/llama-server[.exe]` (`win`/`mac`/`linux` sub-dirs, spec §6); a
  `HILBERTRAUM_LLAMA_BIN` env var overrides for dev. Pure `existsSync` — the "binary present?" check has no
  I/O surprises. `findFreePort()` picks a free **loopback** port (listen `127.0.0.1:0` → read → close;
  an inbound bind, not the outbound `connect` the offline guard watches).
- **Localhost-only binding (LOCKED, Phase 10):** every sidecar is spawned with `--host 127.0.0.1` and
  every fetch targets `http://127.0.0.1:<port>`. **Never** `0.0.0.0`/a routable interface. The Phase-8
  offline guard exempts loopback for exactly this; the no-network assertions assume loopback-only. A
  unit test asserts the spawn args + fetch URLs are `127.0.0.1`, never `0.0.0.0`.
- **OpenAI-compatible streaming endpoint (Phase 10):** `LlamaRuntime.chatStream` POSTs to
  `/v1/chat/completions` with `stream:true`, sending `messages` as plain role/content (**the server
  applies the model's chat template** — we never hand-roll Qwen's prompt format) and mapping
  `maxTokens`/`temperature`. `readChatSSE` parses `data:` frames (partial-line buffering, ignore
  keep-alives, stop on `[DONE]`), `yield`s each delta, honours `options.signal`. Feeds the **locked
  Phase-3 streaming contract** unchanged ⇒ `measureTokensPerSecond` reports **real** tokens/sec once a
  real runtime streams.
- **Real-embedder backend = `llama-server --embedding` (Phase 10, R6):** `E5Embedder` composes the
  **same** prebuilt `llama-server` binary (`--embedding --pooling mean`) over loopback `/v1/embeddings`.
  Chosen over ONNX (onnxruntime-node + tokenizer = a heavier **native** add) because it adds **zero new
  npm deps** and no fragile native build — consistent with the `node:sqlite`/pure-JS theme. **Lazy-
  started on first `embed()`** and reused; an additive optional `Embedder.stop()` kills it (wired into
  `will-quit`). Same **id (manifest) + 384 dims + L2-normalized** output ⇒ drop-in behind the
  `Embedder` interface; the locked Float32 BLOB encoding + `VectorIndex` are unchanged.
- **Embedding-model-mismatch handling = filter by id (LOCKED, Phase 10):** mock (`mock-embedder`) and
  real E5 vectors are **both 384-dim**, so the dimension guard can't separate them — mixing them
  silently corrupts ranking. `VectorIndex` takes an optional `{ embeddingModelId }` that scopes the
  cosine scan to `WHERE embedding_model_id = ?`; `rag.retrieve` passes the **active embedder's id**.
  Chosen over a forced reindex-on-switch (cheaper, no re-embed pass; a reindex still re-embeds with the
  active model). Default (no id) scans all rows ⇒ existing callers/tests unchanged. A test proves a
  mock↔real switch can't blend vector spaces.
- **Script logic in a tested TS module + self-contained shell scripts (Phase 11):** the canonical
  layout/config/checksum logic lives in `services/drive.ts` and is unit-tested by vitest; the
  `scripts/*.{ps1,sh}` **re-implement the same plan natively** rather than shelling out to Node.
  Rationale: a drive must be preparable on a **fresh machine with no Node/npm** (and no TS runner is
  installed — tsx/ts-node absent), and tests must run in CI without PowerShell/bash. `drive.ts` is the
  documented source of truth; the small drift surface (dir list + JSON shapes) is cross-checked (the
  PS + bash + TS emit **semantically-equivalent** config — valid JSON the app parses identically).
  ⚠️ Not literally byte-identical: timestamps differ per run, and `ConvertTo-Json` whitespace differs
  from the bash here-docs. The PS scripts now write **UTF-8 without a BOM** (`Set-Content -Encoding
  UTF8` on PS 5.1 would emit a BOM that breaks Node's `JSON.parse`) — audit fix.
- **Drive-layout naming reconciliation (LOCKED, Phase 11):** the prepared-drive dirs follow the
  **code**, not the spec's prose. Sidecar OS sub-dirs are **`win`/`mac`/`linux`** (`sidecar.ts`
  `llamaOsDir`), and manifests live in a **top-level `model-manifests/`** (`models.ts`
  `resolveManifestsDir`) — NOT `windows/macos/linux` or `models/manifests/`. `drive.ts`
  `DRIVE_LAYOUT_DIRS` is canonical; `docs/drive-layout.md` was corrected to match.
- **Config-generator defaults (Phase 11):** `prepare-drive` writes `config/drive.json` (the
  prepared-drive marker `resolvePaths` keys off) + `config/policy.json`. **Network is ALWAYS
  deny-by-default** (the offline guarantee — `resolveNetwork` is policy ∧ user setting). The default
  posture is **commercial** (spec §6 example: encryption required, no plaintext, models must verify);
  a `-Dev`/`--dev` flag flips to a developer-friendly drive (plaintext + unverified allowed) but
  **still denies network**. JSON shapes are exactly what `parsePolicy`/`mergePolicyObject` accept
  (snake_case booleans). Files are written onto the **drive**, never committed.
- **checksums.json shape (Phase 11):** `{ drive_format_version, generated_at, algorithm:'sha256',
  entries:[{ id, local_path, sha256|null, size_bytes|null, present }] }`. Written by `verify-models
  --generate` from the weights present on the drive. **Informational** — the app still verifies
  against the manifest `sha256`; checksums.json records what a drive builder captured. Placeholder
  manifest hashes report **UNVERIFIED** (not pass, not fail), mirroring `computeInstallState`'s
  developer-mode gate (R5 checksum honesty).
- **Portable Windows target via electron-builder (Phase 11):** `electron-builder.yml` defines a
  `portable` Windows `.exe` (launch-from-drive) + `mac`(dir)/`linux`(AppImage) for parity.
  `model-manifests/` ship as `extraResources` (found via `resolveManifestsDir(app.getAppPath())` →
  `resources/model-manifests`; `HILBERTRAUM_MANIFESTS_DIR` overrides); prod deps (the externalized parser
  libs) ship inside `app.asar`; Electron stays **≥37** so `node:sqlite` exists. `npm run package` /
  `package:win` wired. **Building the real artifact is a MANUAL step** (R2 Electron download; npm
  workspace dep-hoisting may need attention) — it is NOT part of the green gate.
- **Graceful-fallback rule (LOCKED, Phase 10):** the real backends are **opt-in by availability**.
  `createSelectingRuntimeFactory` (per `start()`, when the model path is known) and
  `createSelectedEmbedder` return the real `LlamaRuntime`/`E5Embedder` **only when BOTH** the
  `llama-server` binary **and** the GGUF weights exist; else the mock. ⇒ the app launches and the whole
  suite passes with **zero model files** (the repo/CI default). The embedder reads its model from the
  **manifest** (settings live in the possibly-encrypted DB, unreadable pre-unlock).
- **Optional manifest `download` block (Phase 12, additive):** `shared/manifest.ts` gained an
  **optional** `download: { url, sha256, size_bytes?, license_url? }` validated **only when present**,
  so every existing manifest stays valid. A **real** `download.sha256` must equal a **real** top-level
  `sha256` (same file); placeholders pass through. The four committed model manifests now carry real
  upstream URLs (Qwen3 GGUF + multilingual-E5) with `sha256` left as the `REPLACE_WITH_REAL_HASH`
  placeholder (a placeholder = "fetch then capture via `verify-models --generate`"). The legacy
  `download_url: null` field was removed.
- **`runtime-sources.yaml` (Phase 12):** the `llama-server` sidecar is NOT a model, so it gets a
  committed `model-manifests/runtime-sources.yaml` (`llama_cpp: { version, builds:[{os,arch,backend,
  url,sha256,extract_to}] }`) validated by `shared/runtime-sources.ts` (`validateRuntimeSources`,
  mirroring `validateManifest`). **Excluded from model discovery** via `RESERVED_MANIFEST_FILES` in
  `models.ts` (it would fail `validateManifest`). **Default backend = CPU** (AVX2 win/x64, Metal
  mac/arm64, plain CPU linux/x64) — broadest-compatible for an unknown laptop; GPU is an opt-in
  `--backend` override. `selectRuntimeBuild` returns the **first** os/arch match when no backend is
  given (the CPU build is listed first per OS).
- **Build-time network ≠ runtime network (LOCKED, Phase 12):** the `fetch-*` scripts make the
  project's first deliberate network access, but run on the **drive-builder's online machine at build
  time, NOT in the app at runtime**. The app stays 100% offline by default; the optional in-app
  downloader (the then-deferred provisioning item, later Phase 18) stays policy-gated (`network.allow_model_downloads`, deny-by-default) **and**
  behind the user `allowNetwork` setting. The offline guarantee is unchanged. The in-app downloader
  was **DEFERRED** (not required for the DIY acceptance criteria).
- **Verify-before-trust + license gate (LOCKED, Phase 12):** every downloaded artifact is
  SHA-256-verified **before** it counts as installed — a real-hash mismatch deletes the partial and
  exits non-zero; a **placeholder** expected hash downloads but reports *UNVERIFIED* (never a silent
  pass). The license gate refuses to plan/fetch a model whose `license_review.status != approved`
  unless `--accept-license`/`-AcceptLicense` is set (license + `license_url` printed first). Downloads
  are **resumable** (`curl -C -` / `aria2c`) and **idempotent** (present + verified → skip fast).
- **`services/assets.ts` is the canonical asset-loader logic (Phase 12):** mirrors `drive.ts` — the
  scripts re-implement the same plan natively (self-contained, no Node/npm). Pure/testable:
  `planModelDownloads` (fs reads, NO network), `selectRuntimeBuild`, `planRuntimeDownload`
  (escape-guarded paths reusing `weightPath` semantics), `verifyDownloadedFile`, and an injected-fetch
  `downloadToFile`/`fetchAndVerify` seam (the network seam a future §12.3 downloader reuses; tests
  drive it with a fake `fetch` so the **no-network assertion holds**). The scripts' `.ps1` files are
  **pure ASCII** (Windows PowerShell 5.1 reads non-BOM scripts in the ANSI codepage; a UTF-8 em-dash's
  `0x94` byte decodes to `"` and breaks a double-quoted string — same class of bug as the Phase-11
  BOM issue).
- **Launcher resolves the drive root from its OWN location (LOCKED, Phase 13):** the per-OS launcher
  (`Start HilbertRaum.{cmd,command}` / `start-hilbertraum.sh`) sets `HILBERTRAUM_DRIVE_ROOT` from
  where it sits (`%~dp0` / `dirname "$0"`), **never** a hardcoded drive letter — drive letters/mounts
  change per machine, and the same drive must continue the **same encrypted workspace** on a second
  laptop (success criterion #10; `resolvePaths` already redirects all state onto the drive). Canonical,
  unit-tested resolver = `services/launcher.ts` `resolveDriveRootFromLauncher(launcherPath, flavor?)`
  (handles Windows drive-letter + POSIX paths, rejects empty/relative). The launcher scripts mirror it.
  **Autorun is dead** (Windows disabled `autorun.inf` from removable drives) — the app cannot
  auto-launch on plug-in and must not try; the drive opens a window and the buyer double-clicks the
  well-named launcher (+ a root `READ ME FIRST.txt`).
- **Signing/notarization is a documented MANUAL step; the green gate never signs (LOCKED, Phase 13):**
  `electron-builder.yml` wires `win.signtoolOptions` + `mac.notarize`/`hardenedRuntime` +
  `build/entitlements.mac.plist`, but ALL secrets come from **env vars / a git-ignored secrets file on
  the build machine** (`WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`; `CSC_LINK`/`APPLE_ID`/
  `APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`) and **never enter the repo** (`.gitignore` excludes
  `*.pfx`/`*.p12`/`*.cer`/`*.key`/`signing.env`/`*.provisionprofile`). The green gate
  (`typecheck`/`test`/`build`) does not invoke electron-builder, so signing is off the critical path
  (like the R2 Electron download). EV (Windows) builds SmartScreen reputation fastest; macOS without
  notarization is quarantined. The unsigned DIY "Run anyway" / right-click→Open fallback stays in
  `docs/troubleshooting.md`. New procurement risk **R7** (cert cost/lead-time) blocks only the
  *commercial* acceptance.
- **`build-commercial-drive` = plan + final posture assertion, mirrored by scripts (LOCKED, Phase 13):**
  `services/commercial-drive.ts` is the canonical, unit-tested reference (like `drive.ts`/`assets.ts`):
  `planCommercialDrive(opts) → CommercialStep[]` + `formatPlan` (the ordered steps: prepare → fetch-
  models → fetch-runtime → **package/sign [manual]** → copy launcher+app+docs → verify-models --generate
  → assert) and `assertCommercialDrive(root, manifests) → { ok, problems[], checks, modelResults }`
  which **reuses `loadPolicy` + `verifyDriveModels`** to assert the **commercial posture** (encryption
  required, plaintext off, models must verify, **network denied**) + **every weight VERIFIED** + **no
  user data present** (spec §12.2 — fails loudly otherwise). `scripts/build-commercial-drive.{ps1,sh}`
  orchestrate the existing Phase-11/12 scripts (NOT re-implementing them) + a native cross-check of the
  same invariants. ⚠️ PS gotcha fixed: invoke sibling scripts via **hashtable** splatting
  (`& $path @{Target=…}`), not array splatting (array splat binds positionally → `-Target` is rejected);
  reset `$global:LASTEXITCODE = 0` before each call so a stale code isn't misread.
- **Launch preflight reuses the benchmark; non-blocking (LOCKED, Phase 13):** `services/preflight.ts`
  `runPreflight({ rootPath, measureSpeed?, minFreeBytes? }) → PreflightResult` reuses
  `buildDriveStatus` (writable + free space) + `measureDriveSpeed`/`buildWarnings` (the spec §11.4
  slow-drive copy) — it does NOT add a second drive probe. Friendly + **non-blocking** (read-only / low
  space → `problems[]`, slow drive → `slowDriveWarning`; never "bad hardware", never blocks). The
  drive-speed fn is **injected** in tests (deterministic, no real I/O, no network). Surfaced on Home via
  the `preflight:run` IPC (`registerCoreIpc`, preload `api.runPreflight`). **Encrypted-by-default kept:**
  the commercial first-run still lands on the existing `WorkspaceGate` (no plaintext offered when the
  policy forbids it); only the copy was softened for zero-technical-knowledge users.

- **GPU acceleration (Phases 14–16, 2026-06-10) — design record now `docs/architecture.md`
  "GPU acceleration — design record" (§1–§8):** Vulkan-first distribution +
  `cpu/` safety net + `.hilbertraum-runtime.json` install markers (§1/§4), the 4-rung start ladder +
  `--list-devices` probe (§5 — never pass `-ngl`; `--device none` is the only CPU-forcing
  mechanism), mid-generation crash auto-fallback over the `runtime:notice` channel (§5.3),
  E5 embedder pinned to CPU (§7), conservative profile bump via `gpuUsefulForProfile` (§8),
  Settings toggle + Diagnostics Acceleration/runtime-build/"Try GPU again" surface, and the
  `HILBERTRAUM_GPU_SMOKE` manual harness. New `AppSettings` keys: `gpuMode 'auto'|'off'` (default
  `'auto'`), `gpuAutoDisabled`, `gpuLastError`, `gpuProbe`.
- **GPU audit round (2026-06-10, post-Phase-16 — all findings remediated; commit `4549934`):**
  ① fetch-runtime upgrade bug (HIGH): re-fetching over an existing install never re-flattened
  the nested tarballs (old root binary survived under a fresh vulkan marker) — both scripts now
  pre-clean the extract dir (everything except the fresh archive + `cpu/`); ② sell gate
  hardened: binary required (not just a marker), backend verified natively, `extract_to`
  escape-guarded; ③ probe correctness: resolve on the child's `close` (not `exit`),
  `invalidate()` added, probe runs concurrently with the rung-1 start; ④ "Try GPU again" became
  a dedicated `gpu:try-again` IPC (clears flags AND invalidates AND re-probes; hidden while the
  Settings toggle is OFF); ⑤ `gpuProbe` refreshed once per session, not benchmark-only (a drive
  moved between machines kept the old GPU); ⑥ `looksIntegrated` broadened for real driver
  strings (RADV APUs, "AMD Radeon(TM) 780M", Meteor-Lake "Intel(R) Arc(TM) Graphics" — discrete
  Arc "A###" still bumps); ⑦ small: `gpuMode` enum-guarded, `fetch-runtime.ps1` pure ASCII,
  stale docstrings fixed.
- **Post-MVP UX polish round (2026-06-10)** — four user-reported issues, all behind existing
  contracts (tests in `chat-ipc`, `core-model-ipc`, `models`, `tests/renderer/ChatHomeNav`):
  1. **Conversation deletion:** `deleteConversation` (`chat:deleteConversation`) removes a
     conversation — chat AND documents mode — plus its messages (messages first; the FK has no
     CASCADE). Refused while a stream is in flight for that conversation (the persisted assistant
     turn would resurrect/FK-violate after the delete). UI: a ✕ per sidebar row with a confirm.
  2. **Persisted checksum cache:** the H5 in-memory cache died with the session, so the FIRST
     Models/Chat visit after every launch still re-hashed multi-GB GGUFs with no feedback. New
     `AppSettings.checksumCache` (`path → {size, mtimeMs, sha256}`, default `{}`) is the L2
     behind the in-memory L1 — `HashStore` is injected (`createSettingsHashStore(db)`) through
     `verifyChecksum`/`computeInstallState`/`buildModelList`, so an unchanged weight is hashed
     **once ever**; size/mtime changes re-hash. Living in settings (lastBenchmark precedent — no
     schema change) it is encrypted at rest on encrypted workspaces. **"Verify checksum" is now a
     true re-verify** via the new `verifyModel` IPC (`models:verify`): `invalidateChecksum`
     (memory + store) then a fresh `computeInstallState`. Models screen got a spinner +
     first-check copy; the accepted same-size/mtime-tamper limitation is recorded in
     `docs/known-limitations.md`.
  3. **Active-model auto-start:** a restarted app showed an "active" model whose runtime wasn't
     running. The `startRuntime` handler's §7.4 gate logic moved to an exported
     `startModelRuntime(ctx, modelId)`; new `maybeAutoStartActiveModel(ctx)` (mirrors
     `maybeRunFirstBenchmark` — background, never throws/blocks) fires at startup (plaintext dev)
     and after unlock/create (encrypted). Opt-out: `AppSettings.autoStartActiveModel` (default
     `true`) + a Settings toggle. ChatScreen's "no model" empty state now polls
     `getRuntimeStatus` every 2.5 s (and says the model may still be loading) so it flips to the
     composer by itself; its runtime check uses `getRuntimeStatus` instead of `listModels`
     (cheaper, no hashing).
  4. **Home navigation fix:** "Ask My Documents" used to land on the import screen. App.tsx now
     has a central `navigate()` with a virtual `'ask-documents'` target → Chat screen with
     `initialMode='documents'` (new optional `ChatScreen` prop); sidebar "Chat" resets to chat
     mode.
- **Post-MVP UX polish round 2 (2026-06-10):**
  1. **Chat output renders Markdown:** assistant replies (persisted AND the live streaming
     bubble) render GFM via **`react-markdown` + `remark-gfm`** (new RENDERER deps — pure JS,
     MIT, bundled by Vite into the renderer; NOT main-process/externalized). Safe by
     construction: react-markdown builds React elements (no `innerHTML`) and raw HTML in model
     output renders as **literal text** (renderer test proves no `<img>` injection). Links get
     `target="_blank"` → the existing window-open handler (http/https → OS browser, else deny).
     **User turns stay plain text** (`.msg-content` pre-wrap); assistant bubbles use
     `.msg-content.md` (white-space normal + scoped element styles in styles.css).
  2. **"Lock now" stops the sidecars:** `lockWorkspace` now aborts all in-flight generations
     (`inFlightStreams`), `Promise.allSettled`-stops the chat runtime AND the E5 embedder (a
     llama-server holds recent prompts in its KV cache), THEN `workspace.lock()` — a wedged
     sidecar never blocks the re-encrypt. Unlock restarts the chat runtime via the existing
     `maybeAutoStartActiveModel`; the embedder restarts lazily on next `embed()`.
- **Post-MVP UX polish round 3 (2026-06-10):**
  1. **RAM gate + RAM-best-fit recommendation:** `machineRamGb()` (totalmem, **whole-GB
     `Math.round`** so a "16 GB" machine reading 15.9 GiB still counts as 16) feeds
     `buildModelList` → new `ModelInfo.insufficientRam` (min RAM > machine RAM). UI: a
     "Needs ≥N GB RAM" badge + disabled Select/Start (§11.4 copy: "pick a smaller model —
     quality stays great"); MAIN gate: `startModelRuntime` refuses to load INSTALLED weights
     that don't fit (mock fallback ungated — uses no real RAM). **Recommendation is now
     RAM-best-fit** (`recommendModelIdByRam`): largest model whose `recommended_ram_gb` fits,
     else lightest meeting its minimum, else none — used by `listModels` AND the benchmark
     (same whole-GB rounding ⇒ the surfaces can never disagree); profile-table lookup stays
     as the no-RAM fallback. `AppStatus.machineRamGb` added (badge copy).
  2. **Read-only in-app document preview:** new `extractDocumentPreview` + `previewDocument`
     IPC (`docs:preview`) + a Documents-screen modal. RE-PARSES the stored copy (chunks
     overlap ~80 tokens — concatenating them duplicates boundary text); falls back to the
     original file if the copy is gone. Encrypted workspaces decrypt to a transient
     `.parse-preview` file shredded on the way out (the `.parse` infix keeps it under the
     startup crash sweep); without a cipher an `.enc` copy is refused. Deliberately TEXT-only
     (never `shell.openPath`): the original bytes must never reach an external viewer in
     plaintext. Tested: ingestion + encrypted-leak tests + renderer modal tests.
- **Post-MVP UX polish round 4 (2026-06-11) — two frontend issues:**
  1. **Password "Show" toggle → eye icon:** the password-reveal control in the shared
     `PasswordField` was a text "Show"/"Hide" Button; now an inline eye / eye-off SVG
     (`currentColor`, muted→full on hover, decorative `aria-hidden`). A11y
     preserved/improved: the Button keeps `aria-pressed` and carries a descriptive
     `aria-label`/`title` ("Show password"/"Hide password"). Test name-queries updated.
     (Merge note: the PR targeted the pre-Phase-32 copy inside `WorkspaceGate`; the change
     was ported to the extracted `renderer/components/PasswordField.tsx`, so the Unlock,
     first-run AND Settings → Change-password fields all get the icon.)
  2. **Filename auto-scope for document chat:** other documents were cited as sources when a
     question named one file, because document retrieval is **corpus-wide by default** —
     nothing parsed the question for a filename (the scope plumbing itself was correct
     end-to-end). New pure `detectFilenameScope(question, docs)` (`services/rag/scope.ts`,
     unit-tested) matches a file by its title/stem as a whole-token run (token-boundary, lone
     generic words ignored, whole-corpus match = no match). `askDocuments` applies it **only**
     when the conversation has no explicit "ask selected documents" scope, as the per-request
     `scopeDocumentIds` — narrows only, never widens; explicit scope always wins. Visible +
     honest: a one-shot non-persisted `STREAM.scope` notice (`api.onScopeNotice`) → an
     *"Answering from contract.pdf only"* toast in Chat. Tests: `tests/unit/rag-scope.test.ts`
     + a `tests/integration/rag.test.ts` case proving unscoped surfaces both docs while the
     detected scope returns only the named file. Design record: `docs/rag-design.md` §10.
- **Doc lifecycle: finished plans become design records (2026-06-10):** implemented plan docs
  are condensed to short design records (decisions + load-bearing facts + the design as built)
  or deleted, with the full original in git history — finished plans otherwise drift and
  contradict code (the GPU audit proved it). Applied: `docs/IMPLEMENTATION_PLAN.md` **deleted**
  (per-phase ritual lives in CLAUDE.md; spec-§22 Definition of Done folded into §5; the dead
  Phase-0 `PlaceholderScreen.tsx` went with it); `docs/gpu-support-plan.md` and
  `docs/provisioning-and-distribution-plan.md` **condensed** with their cited section anchors
  kept stable (gpu §1–§8; provisioning §0/§12/§12.3/§13). In the 2026-06-12 housekeeping both
  were folded onward and deleted: provisioning → `docs/packaging.md`; the GPU record →
  `docs/architecture.md` "GPU acceleration — design record" (§-anchors preserved). Rule recorded in
  CLAUDE.md ("Doc lifecycle rule"). Full originals: `git show 4549934:docs/<file>`. **Also applied at
  wave-1 closeout (2026-06-10): `docs/post-mvp-functionality-plan.md` condensed** to the
  wave-1 design record (full original: `git show 2a46ca3:docs/post-mvp-functionality-plan.md`);
  in the 2026-06-12 housekeeping that record — and `docs/retrieval-quality-plan.md` +
  `docs/model-catalog-expansion-plan.md` — were folded into the topic docs (rag-design §10/§12,
  architecture, model-benchmarks §7, model-policy) and deleted.
- **Functionality wave 1 — Phases 17–20 (2026-06-10) — design record folded into the topic
  docs (full original: `git show 2a46ca3:docs/post-mvp-functionality-plan.md`):**
  **Phase 17** RAG trust & document-scoped asking (`docs/rag-design.md` §10 incl. D1/D2 —
  ask-selected-documents scope, plain-chat document-awareness notice, vector-tag fix,
  reindex-needed answer). **Phase 18** in-app model downloader (`docs/architecture.md`
  "In-app model downloader" incl. D3 — triple-gated:
  policy ∧ default-off setting ∧ per-download confirmation; `.part` + verify-before-rename,
  Range resume, async-with-polling IPC). **Phase 19** audit log on `runtime_events`
  (`docs/architecture.md` "Audit log" incl. D7
  + `docs/security-model.md` — never-throws recorder with locked-vault buffering, hard
  privacy rule ids/filenames/counts never content (sentinel-grep-tested), 5 000-row
  prune-on-insert, Diagnostics Activity panel + export). **Phase 20** answer-depth modes
  (`docs/architecture.md` "Chat & streaming" incl. D4–D6 — per-request
  `chat_template_kwargs.enable_thinking`,
  the ADDITIVE `chat:reasoning:<id>` stream channel, reasoning stripped from persistence;
  the `--reasoning auto` silent-delta research finding and the `CHAT_SERVER_ARGS` pin are
  recorded there).
- **Phase 21 — retrieval quality: reranker + hybrid keyword search (2026-06-10) — design
  record `docs/rag-design.md` §12 (decisions
  D8–D15 + research facts, incl. the rerank-mode `n_ubatch=512` HTTP-500 trap and its
  batch-size fix, §12.1 R1) + §11 (as built):** FTS5 keyword pass + RRF
  fusion in `retrieve()`; optional CPU-pinned `bge-reranker-v2-m3` sidecar behind a
  `Reranker` interface whose absent default keeps retrieval byte-identical. Real-hardware
  smokes on `D:\` (i7-1185G7): F16 loads on b9585, relevance correct, worst-case
  12-candidate batch ≈ 24.7 s CPU; `ragMinSimilarity` measured → stays 0 (§12.1 R3 —
  prefix-less E5 compresses all cosines into ~0.87–0.94, separation is the reranker's job);
  the `HILBERTRAUM_RAG_QUALITY` end-to-end run validated the reranker rescuing the true clause
  from #3-behind-distractors to #1 (the concrete justification for its ~25 s worst case).
- **UI polish wave — Phases 23–27 (2026-06-10, branch `ui-phase-23-tokens-theming`, merged
  to master same day) — durable reference [`docs/design-guidelines.md`](docs/design-guidelines.md)
  (ADOPTED), rollout record + decisions D-UI1–4 + the eyeball-walk verification pattern in
  its §11:** Phase 23 tokens + theming (additive `AppSettings.theme`; the gate always follows
  the OS theme, D-UI2) · 24 shared component layer on four pinned, license-reviewed Radix
  primitives (D-UI1) · 25 chat restructure per guidelines §3 (the wave's priority) · 26 IA
  regroup nav 7→5 + Privacy/Diagnostics as Settings tabs (legacy `privacy`/`diagnostics` nav
  aliases kept working; Home stays as the readiness hub, D-UI3) · 27 copy sweep + the
  "Local · Offline" ambient indicator + the 3-step first-run create flow + the WCAG 2.2 AA
  sweep (accepted items and the bundled-app `WrongPasswordError` instanceof/tree-shake quirk
  are recorded in `docs/known-limitations.md`).
- **Phases 28–29 — model catalog wave 1 + benchmark (2026-06-10/11) — design record
  [`docs/model-benchmarks.md`](docs/model-benchmarks.md) §7 (D16–D22) + its §0–§6
  (protocol, tooling, first-run
  results) + `docs/model-policy.md` (catalog table, license reviews, recommendation,
  disqualified candidates):**
  four Apache-2.0 challenger manifests landed with vendor-verified sources and real hashes
  (all 10 catalog weights VERIFIED on `D:\`; bring-up smokes PASS on real b9585). The
  judge-free benchmark (scorer `tests/eval/score.ts`, harness `tests/manual/model-eval.test.ts`,
  100-item `eval/{corpus,rag}_de_en.jsonl`) ran on the i7-1185G7 for all 8 models (QA
  reproduced bit-for-bit on the dev box). Applied live: `recommended_min_ram_gb` recalibrated
  from measured peak RSS, the recommender made quality-aware via the new `recommendation_rank`
  manifest field (≤12 GB → Qwen3-4B / 16 GB → Ministral / ≥32 GB → Gemma 4; Granite + 30B
  never auto-recommended), Gemma's `supports_thinking_mode` flipped ON after its thinking
  check. Headline discriminator: hallucination resistance on unanswerables (Ministral 0/15
  best); grounded EM saturates (~96–98 %) — the D27 eval-hardening motivation. Only the
  optional dev-box speed sweep remains (QA + RSS are machine-independent).
- **Functionality wave 3 — Phases 31–38 (2026-06-11) — design record
  [`docs/architecture.md`](docs/architecture.md) "Functionality wave 3 — design record"
  (decisions D23–D37 in §13, research-gate findings banked in §14, plus the §-anchor legend
  mapping the retired plan's per-phase §4–§11 to their topic-doc homes):**
  **31** conversation search (`messages_fts` mirroring the D13 index shape, bm25 ranking,
  `chat:search`, ConversationList search UI; + the deny-by-default
  `setPermissionRequestHandler` session-hardening rider) · **32** vault password change
  (descriptor v2 envelope with a wrapped data key — new vaults v2, O(1) re-wrap per change
  with a free scrypt→argon2id upgrade, one-time journaled v1→v2 migration on first change
  with crash-cut recovery tests, `workspace:changePassword` + Settings card, import↔change
  race guard) · **33** document-task engine + one-click summary (`DocTaskManager` queue/
  cancel/polling reused by 34–35; strict one-at-a-time vs chat both ways; budgeted map-reduce
  summary in `documents.summary_json`; R-T1: b9585 serves concurrent requests on PARALLEL
  slots — the app-side guard is the only serialization) · **34** translation (re-extracted
  parser segments, never the overlapping chunks — D36; R-T2-measured window math, German out
  ≈ 2.0 tok/word; retry-once-then-mark; materialized corpus document under the Phase-32
  lease + `documents.origin_json` provenance; new `docs:export`) · **35** compare two
  documents (auto mode-switch by token math — D37 segments for input AND decision;
  section-matched mode pairs windows via the existing `VectorIndex`, deterministic, ceiling
  12 with an honest in-report notice; embedder-visibility guard fails friendly before any
  model call; two smoke rounds hardened the prompts against silent per-pair omission) ·
  **36** audio transcription as ingestion (whisper.cpp **v1.8.6** as the SECOND sidecar
  family — `whisper_cpp:` yaml block, `fetch-runtime --family`, commercial gates; the
  `whisper-small-multilingual` manifest, `role: transcriber`, covered by the Phase-18
  downloader with zero new code; `services/transcriber/` + `AudioParser` packing
  time-labeled segments → `"mm:ss–mm:ss"` citations, 1 chunk = 1 segment; D35 = keep the
  audio copy, re-index = re-transcription; the runtime↔format pair matrix in
  `computeInstallState` and the `selectModel` non-chat-role refusal shipped with it) ·
  **37** voice dictation (renderer MediaRecorder → 16 kHz mono WAV → `dictation:transcribe`
  → transient `.parse-dictation.wav`, shredded in `finally` → insert-at-cursor, NEVER
  auto-sent; the single scoped audio-only own-WebContents `media` permission allow;
  availability-driven `AppStatus.dictationAvailable`) · **38** scanned-PDF / photo OCR
  (R-O1 SPLIT design: hidden-window pdfjs-LEGACY rasterization behind a pull-based
  `OCR_RASTER` protocol + MAIN-side tesseract.js **Node mode** on Buffers, pinned 7.0.0 +
  `asarUnpack`; R-O3 → **best_int** traineddata (float `tessdata_best` crashes the WASM
  core); step-0 scan detection with friendly copy; D33 "Make searchable (OCR)" task →
  `documents.ocr_json` → re-ingest via the PdfParser `ocrPages` hook ⇒ page citations
  unchanged; photos OCR on import; `ocr:` asset class + `fetch-runtime --family ocr` +
  commercial gates; `AppStatus.ocrAvailable`). Wave close: **968/968 tests green** (+25
  `HILBERTRAUM_*` manual skips), `HILBERTRAUM_OCR_SMOKE` + built-app eyeball walks PASSED on real assets.
- **Docs-vs-code audit + comment quality pass (2026-06-13):** a full systematic comparison of
  every doc against `apps/desktop/src` (8 parallel read-only audits, findings re-verified before
  changes) found the docs largely accurate; the real doc bugs fixed were: a never-shipped TINY
  warning string in `benchmark.md`, the user-guide's "all chat models support Thorough" claim
  (Ministral/Granite/2507 don't), troubleshooting's pre-Phase-38 "OCR is not included", stale
  §4 contract lines here (DEFAULT_KDF, `selectModel` return, AuditEventType count), and the
  architecture "Data flow" pipeline that predated hybrid retrieval. A **comments-only quality
  pass** over all of `apps/desktop/src` (~100 files) trimmed history/provenance narration
  (Phase/D/R/H/M ids, audit stories) while keeping every LOCKED/security/platform constraint;
  verified mechanically — esbuild-stripped output of every changed file is byte-identical to
  the pre-pass HEAD. Dead-info pass: resolved `~~strikethrough~~` entries deleted from
  `known-limitations.md`; dangling §-references to retired plan files repointed
  (model-benchmarks, security-model, rag-design); future-tense "lands in Phase N" rewritten as
  shipped behavior. The test-infra nuisance noted here (1–2 timeout flakes under the FULL
  parallel suite on a loaded machine) was mitigated in the remediation entry below.
- **Audit-findings remediation (2026-06-13):** the code findings banked by the audit are
  fixed (commits "Audit fix A/B/C"). A — user-visible strings: phase jargon retired from the
  mock-runtime reply, the DiagnosticsTab fallbacks, and the commercial-drive step
  descriptions; the doctasks materialize-failure log is kind-aware. B — robustness: orphaned
  `OCR_RASTER.error` frames are logged; the E5 embedder gained the reranker's failed-start
  latch with ONE deliberate difference — it **clears on `suspend()`** (the embedder has no
  graceful degradation, so replace-the-GGUF + lock/unlock must make imports retryable;
  architecture.md updated); `plaintextAllowed` is now honestly `(policy, { isDev })` — the
  old `developerMode` parameter was always fed `isDev` (the proxy rule is documented;
  `encryptionRequired` stays the absolute veto; security-model.md updated); `ensureColumn`
  asserts identifier/DDL shape before interpolating; downloads detect a cancel race via the
  AbortSignal (cast removed) and prune terminal jobs beyond the most recent 20; preflight
  selects the slow-drive warning by content, not `[0]`; `rag.retrieve` joins fused candidates
  in one `IN (…)` query (placeholders, fused order preserved); `RUNTIME_POLL_MS` is shared
  (`renderer/lib/polling.ts`); the triplicated export save-dialog step is one helper
  (`ipc/save-export.ts` — audit calls stay per-site, per the privacy rule); the runtime
  status `'cpu'` fallback is a named default (`UNLABELLED_BACKEND`). C — test infra: the
  parallel-suite timeout flakes were CPU starvation tripping vitest's 5 s default, so
  `testTimeout: 15_000` (3× headroom) in `vitest.config.ts` — chosen over capping
  `maxWorkers` because it leaves a clean run's wall time unchanged. Suite: **969 tests
  green** (968 + the new e5 failed-start-latch test).
- **Multi-persona audit + MEDIUM remediation (2026-06-13, branch `audit-2026-06-13-high-fixes`,
  NOT yet merged):** a fresh five-persona audit (`docs/audit-2026-06-13.md`, a working report
  outside the doc-lifecycle rule). No CRITICAL. **Round 1** fixed the 4 code HIGHs + M-S3 (H1
  import lease-leak, H2 RAG token budget ×1.3, H3 truncated-blob guard, H4 OCR rasterizer
  busy-flag, M-S3 OCR-window nav guards). **Round 2** added the H5/M-A1 drift test
  (`tests/integration/script-drift.test.ts`) + the M-D1/2/3 stale-doc fixes. **Round 3** banked
  the prioritized MEDIUMs: M-C1/2/3 sidecar lifecycle (a post-ready `'error'` without `'exit'`
  now fires the GPU crash auto-fallback **and** resolves `stop()`; `stop()` escalates to SIGKILL
  even when `child.kill()` throws; the auto-fallback re-arms on a synchronous `restart()` throw —
  the fix surfaced a secondary bug: `stop()` clears `ready`, so the `'error'` handler must record
  the exit during teardown too or the SIGKILL escalation double-fires `kill()`); M-C4 RRF
  tiebreak on best-rank-across-both-lists (exact-term keyword-only hits no longer suppressed);
  M-C5 caller abort signal plumbed `retrieve → embed/rerank` via a shared `combineSignals`
  (`runtime/sidecar.ts`); M-S2 per-handler IPC arg-shape guards (`createWorkspace` `password.length`
  TypeError + unlock/changePassword/importDocuments); M-S1 offline guard kept **detection-only by
  decision** (`security-model.md` §2 "Detection-only, not enforcement" — enforcing via the
  process-wide `net.Socket.connect` shim would turn a host-extraction edge case into a hard offline
  failure breaking loopback IPC/sidecar; the guarantee rests on the no-remote-code posture + the
  prod CSP). **Round 4** banked the a11y trio + the M-A1 follow-up: L8 (composer `aria-label`
  mirroring the mode prompt), M-U1 (new `ErrorBanner` — an always-mounted `role="alert"`
  `display:contents` wrapper that swaps text; Banner took a `role` override so the inner one is
  `status` not a nested alert; chat/documents/models error banners migrated), L7 (the visible
  streaming markdown is no longer a live region — a separate `.sr-only` `StreamAnnouncer` announces
  only newly-completed sentences, markdown-stripped, resetting per stream), and M-A1 **completed**
  (drift test extended to the `config/{drive,policy}.json` payloads vs `buildDriveJson`/`buildPolicyJson`
  for both editions, plus the `verify-models.{ps1,sh}` sha256 regex vs `isRealSha256` and the
  runtime/format gate vs the now-exported `SUPPORTED_RUNTIMES`/`SUPPORTED_FORMATS`). Suite **1043 green**,
  typecheck + build clean. **Round 5** banked the remaining LOWs (except L16–L19). Correctness: L2
  (`cosineSimilarity` throws `RangeError` on a length mismatch — the only caller dimension-guards first,
  so a mismatch is a real bug not a prefix to score); L3 (E5 batch reorder handles all-indexed → sort,
  none-indexed → trust array order, and **throws** on a partial mix that would silently misalign
  vectors↔chunks); L4 (embedder `suspend()` clears the failed-start latch **after** teardown — teardown
  awaits an in-flight start, so a racing failure during it would otherwise re-arm the latch and force a
  second lock/unlock); L5 (transcriber `suspend()`/`stop()` track each child against a promise that
  resolves only after its transient-transcript shred runs, then **await** them — the parent can no longer
  exit on quit leaving an un-shredded transcript in `tmpdir()`, which the workspace crash-sweep never
  reaches); L6 (`parseCitations`/`isCitation` validate the `citations_json` shape on read, mirroring
  `parseScope`). a11y: L1 (markdown `a` renderer whitelists http(s), else inert text); L9 (`docs` literal
  → single `home.preflight.continue` key with a `{folder}` placeholder the UI splits to bold); L10
  (`friendlyIpcError` at the remaining `String(e)` sites in Chat/Documents/Models screens); L11
  (`<Spinner>` with `aria-hidden` baked in, replacing every bare `.spinner` span); L12 (`aria-describedby`
  on the ConfirmDialog body via `useId`); L13 (strength meter is no longer a `role="status"` live region —
  a separate debounced `.sr-only` region announces the word only after typing settles); L14
  (search-results `aria-live="polite"` + an `.sr-only` count); L15 (Thinking `<button aria-expanded>`
  instead of a `preventDefault`-driven `<details>`, reasoning kept mounted-but-`hidden` when collapsed).
  Suite **1058 green**, typecheck + build clean. **Round 6 — batch 1 (branch
  `audit-2026-06-13-high-fixes`):** the deps/test-gap LOWs + one locale MEDIUM. L17 (`logging.ts` had
  zero tests — added `tests/unit/logging.test.ts`: MAX_BYTES rotation, circular-meta non-throw,
  `readLogTail`); L18 (`@napi-rs/canvas` native `.node` excluded from app.asar via a `!**/@napi-rs/
  canvas*/**` `files` glob in `electron-builder.yml` + `tests/integration/packaging.test.ts` asserting
  it); L19 (captured the real **b9585** `--list-devices` stdout into `tests/fixtures/` — CRLF kept
  binary — and parse it as a `gpu.test.ts` regression); L16 (extracted `resolveSidecarSelection` in
  `services/select-sidecar-backed.ts` — the shared model→binary→weights ladder behind the three
  sidecar factories); M-U5 (tech-disclosure GB / Diagnostics MB-s + tokens-s / Settings context-tokens
  now route through locale `toLocaleString` helpers). Suite **1070 green**, typecheck + build clean.
  **Round 6 — batch 2 (branch `audit-2026-06-13-high-fixes`):** the UX + architecture MEDIUMs, closing
  the audit. UX: M-U2 (a stopped chat stream now toasts `chat.stopped` — a truncated reply is no longer
  mistaken for a complete one); M-U3 (the no-model chat state routed through the shared `EmptyState`);
  M-U4 (offline state lifted to App as the single ambient truth — the chat header `LocalIndicator` takes
  it as a prop instead of self-fetching, so it can't disagree with the sidebar); M-U6 (`Re-index all
  stale` gated behind a `ConfirmDialog` + a determinate `Progress` bar). Architecture: M-A2
  (`ipc/chat-stream.ts` — `assertChatStreamReady` + `withChatStream` collapse the duplicated guard
  preamble + stream lifecycle that registerChatIpc/registerRagIpc kept in hand-synced lockstep); M-A3
  (`resolveModelByRole` + `composeServices` extracted from `initBackend`); M-A4 (the 1582-line
  `doctasks.ts` split into `doctasks/{summary,translation,compare,manager}.ts` behind a byte-identical
  re-export barrel); M-A5 (the `HILBERTRAUM_*` manual-harness matrix documented as a required pre-release gate
  in `packaging.md` + the canned-real-output regression-fixture policy). **The 2026-06-13 audit is now
  fully remediated** (every HIGH, MEDIUM, and LOW closed; the `docs/audit-2026-06-13.md` working report
  was deleted per its own lifecycle rule — the full annotated report, incl. the "Confirmed NON-issues"
  list of accepted limitations, stays recoverable from git history). Suite **1083 green**, typecheck +
  build clean.
- **D1 re-affirmed — unified auto-RAG chat stays NOT built (2026-06-12):** the Phase-21 data
  the original deferral waited for is in, and it argues AGAINST unifying now: no cheap
  relevance gate exists under prefix-less E5 (the measured-floor overlap, rag-design �12.1
  R3), the reranker gate is optional equipment at up to ~25 s worst-case CPU per message, and
  the wrong-tab failure is already triple-defended (awareness notice, mode subtitles,
  filename auto-scope). **Revisit trigger = Phase 30 Track B** (a prefix-using embedder with
  a measurable floor) — rider + full rationale recorded in `rag-design.md` §10 (D1); the Phase-30 plan that
  also carried the rider was retired 2026-07-12 (model-benchmarks §9.2).

- **Phase 39 — i18n foundation + proof slice (2026-06-13; condensed record:
  `architecture.md` "Internationalization — design record"; full original plan
  `git show 5059ed8:docs/i18n-plan.md` §4):** hand-rolled typed i18n in `shared/i18n/` — `en.ts` flat
  source-of-truth catalog (`MessageKey = keyof typeof en`), `de.ts` typed
  `Record<MessageKey, string>` so **typecheck enforces catalog parity**, `t`/`tCount`
  (`.one`/`.other`, n === 1 rule)/`resolveUiLanguage` — synchronous, **zero new deps**
  (D-L1 LOCKED). New `AppSettings.uiLanguage: 'system'|'en'|'de'` (default `'system'`,
  theme-style enum guard; D-L2 LOCKED) + a Settings → General SegmentedControl picker
  (System/English/Deutsch — language names untranslated). Renderer `renderer/i18n.tsx`
  `I18nProvider`/`useT()`: re-resolves on settings load/patch, sets `<html lang>`, mirrors
  the RESOLVED language to `localStorage('hilbertraum.uiLanguage')`; the pre-unlock gate resolves
  mirror → `navigator.language` (D-L3 LOCKED). Main `services/i18n.ts`: cached language
  from `app.getLocale()` (set after whenReady), re-resolved at plaintext startup, after
  unlock/create, and on `uiLanguage` patches; `tMain()` localizes ephemeral emissions —
  first use = the gate's wrong-password message, English byte-identical (D-L5 LOCKED).
  Proof slice migrated: App shell (nav/lock/notice chrome), SettingsScreen (tabs + General
  tab fully), WorkspaceGate (all steps); German copy is informal „du" (D-L7) with the §3.5
  glossary pinned atop `de.ts`. **R-L1 finding:** on this de-AT Windows 11 machine
  `app.getLocale()` returns the BARE tag `'de'` (not `de-*`) and `navigator.language`
  matches — `resolveUiLanguage` accepts bare `'de'`; the dev machine is German-locale
  (not EN as the plan assumed), but the suite is locale-independent (jsdom pins
  `navigator.language` to `en-US`). Tests: 990 green from `apps/desktop`; new
  `tests/unit/i18n.test.ts`, `tests/unit/main-i18n.test.ts`, `tests/renderer/I18n.test.tsx`
  (picker patch + mirror + German gate smoke); one scoping edit in `Theme.test.tsx` (the
  General tab now has two "System" radios — scope by radiogroup, don't rename). Persisted
  DB strings and LLM prompts untouched (D-L4/D-L6 wait for Phases 41/42).
- **Phase 40 — i18n renderer string sweep (2026-06-13; sweep conventions kept as
  `architecture.md` i18n record §5; grep-audit result in the original plan §5,
  `git show 5059ed8:docs/i18n-plan.md`):** every remaining renderer screen/component migrated to the
  shared catalogs in five batch commits (① Home + chat components + App leftovers ②
  Documents ③ Models ④ Privacy/Diagnostics tabs ⑤ shared components), catalogs now
  ~440 keys/language with **English values byte-identical** (D-L8 — the pre-existing
  role+name assertions passed unchanged). Label maps kept their structure with
  `labelKey: MessageKey` values (`STATUS_BADGE`, `STATE_BADGE`, `AUDIT_TYPE_LABELS`,
  `TASK_BUSY_*`, `DEPTH_LABEL_KEYS`, `ConversationGroup.labelKey`); hand-rolled plurals
  → `tCount`; the two `toLocale*String()` date sites + file-size/RAM formatting take the
  resolved locale from `useT().lang` (`useGrouping: false` keeps EN output identical).
  **Shared components RECEIVE a bound `t` prop/argument** (`components/translator.ts`:
  `Translator` type + `englishTranslator` default for provider-less tests) — Banner
  Dismiss, Modal Close, ConfirmDialog Cancel, Chip Remove, PasswordField Show/Hide +
  strength `labelKey`/`hintKey`, LocalIndicator label/detail. Phase-41 boundary
  untouched: persisted `documents.error_message` renders as-is, `DOC_TASK_BUSY_MESSAGE`
  recognition unchanged, raw IPC/job/audit error strings pass through;
  `MIC_BLOCKED_MESSAGE` stays canonical in `lib/dictation.ts` and is exact-matched +
  localized at display in `DictationButton`. Untranslated by design: product name/"Lite",
  picker language names, technical ids/paths. Tests: 997 green from `apps/desktop`; new
  `tests/renderer/GermanSmoke.test.tsx` (German render smoke per migrated screen + the
  shared-component built-ins); grep audit clean (remaining capitalized literals =
  comments, dev-internal throws, `e.key` names — recorded in plan §5).
- **Phase 41 — i18n main-process boundary (2026-06-13; condensed as `architecture.md`
  i18n record §3.3; fact-5 classification findings in the original plan §6,
  `git show 5059ed8:docs/i18n-plan.md`; D-L4 LOCKED):** the §3.3 two-rule
  boundary applied across the main process in four step commits. **Rule 1 (persist
  canonical, LOCKED D-L4):** everything written to the DB / settings stays canonical
  English via explicit `t('en', …)` + a §3.3 comment — the 7 parser-failure constants
  (`scanDetected` exact-match contract untouched), source-missing + reconcile messages,
  `NO_DOCUMENT_CONTEXT_ANSWER` **and `REINDEX_NEEDED_ANSWER`** (fact-5 correction:
  also persisted into `messages.content`), `DOC_TASK_BUSY_MESSAGE` (canonical ON THE
  WIRE — ChatScreen's `error.includes` recognition), and `buildWarnings` (persisted in
  `settings.lastBenchmark`). The renderer translates them at display via the new
  exact-match **display map** (`renderer/lib/displayMap.ts`, `localizeServerCopy`) in
  DocumentsScreen failure rows, Transcript (persisted + live bubble), the ChatScreen
  banner (busy-message substring case), DiagnosticsTab warnings, and Home preflight
  notes; unknown strings (raw library errors, the interpolated `Unsupported file
  type: …`) render as-is — accepted. Old pre-i18n rows re-translate retroactively on a
  language switch (byte-identical English, D-L8). **Rule 2 (emit localized, D-L5):**
  `tMain()` at every emission site — doc-task guards/status errors (**verified
  in-memory only**, never persisted), download refusals + job errors, the IPC guards
  (docs/chat/rag/doctasks/models/downloads), preview/export throws, preflight problems
  (transient; the slow-drive note stays canonical — shared with persisted benchmark
  warnings — and is display-mapped), the GPU compatibility-mode notice, the remaining
  workspace gate/change-password results, the `VaultBusyError` lease message, and the
  five native dialog titles + picker filters (window title stays the product name).
  `FRIENDLY_TASK_ERRORS` became the exported `isFriendlyTaskError()` checking both
  catalogs (guard throws are now localized). Audit-log messages stay English in DB +
  export (privacy rule, accepted); LLM prompts untouched (D-L6). Tests: full suite
  **1007 green**; new `tests/integration/i18n-boundary.test.ts` +
  `tests/unit/display-map.test.ts`; built bundle launch-smoked on this de-AT machine
  (German home, German no-model IPC refusal in vivo).
- **Phase 42 — i18n German QA + closeout (2026-06-13) ⇒ i18n wave (39–42) COMPLETE;
  plan condensed to `architecture.md` "Internationalization — design record" +
  `design-guidelines.md` §7 "German microcopy" and DELETED
  (`git show 5059ed8:docs/i18n-plan.md`); ~51 code comments retargeted from
  "i18n-plan §" to "i18n record §" (§-numbers preserved):**
  ① full `de.ts` review pass — 9 value fixes (imperative consistency prüfe→prüf,
  Mock→Demo-Runtime, grammar/idiom fixes; commit `a4d91de`), the user holds the final
  D-L7 human-review pass. ② German eyeball walk (`%TEMP%\hilbertraum-eyeball\walk-phase42.mjs`,
  shots in `shots-p42`): encrypted first-run gate flow + every screen at BOTH window
  extremes (880×600 / 1920×1040) with a programmatic overflow scan, plus an English
  regression leg via the picker. Three text-expansion findings, all fixed with LAYOUT:
  `.chat-header` wraps (the German mode label + ambient indicator clipped at 880),
  chat empty-state example chips wrap instead of ellipsizing at the 240px chip cap,
  `.kv dd` uses `overflow-wrap: anywhere` (break-all cut German words mid-word).
  ③ Untranslated-string finding fixed: the persisted default conversation title
  `'New chat'` is persist-canonical with a behavioral exact-match
  (`maybeSetTitleFromFirstMessage`) ⇒ new `main.chat.defaultTitle` key (persist-canonical
  section), `DEFAULT_TITLE = t('en', …)`, display-map entry, `ConversationList` passes
  titles through `localizeServerCopy` (real user titles pass through). ④ Catalog hygiene
  tests extended: plural-pair completeness + `DISPLAY_MAP_KEYS` ↔ persist-canonical
  section pinned key-for-key (`display-map.test.ts`). ⑤ **All seven acceptance criteria
  verified explicitly:** (1) instant System/English/Deutsch switch + `<html lang>` in
  vivo; (2) German gate/first-run/post-unlock with zero stored state in vivo (cleared
  localStorage + reload); (3) no English remnant in the German walk (product
  name/technical values excepted — the one finding was ③, fixed); (4) scanned-PDF under
  German UI: scanDetected intact, German failure row, OCR offer present, same row
  canonical English after switching (display map works both ways); (5) wrong-password +
  no-model refusals German in vivo, download/policy refusal copy pinned by
  main-i18n/boundary tests; (6) suite 1010 green + typecheck green, removing a de.ts key
  ⇒ TS2741 (demonstrated); (7) zero new deps / no network / audit-log untouched (phase
  diff inspected). ⑥ `known-limitations.md` "Internationalization" section added (D-L6
  documented ⇒ RESOLVED; audit-log English; interpolated/library errors render as-is;
  user-guide/README English-only for now; mixed-language transcripts accepted).

---

## 4. Shared data contracts (the actual "transported data")

> **Moved verbatim to [`docs/data-contracts.md`](docs/data-contracts.md)** (2026-07-12) — the
> per-phase contract sections (IPC command surface, DB schema, streaming contract, workspace
> paths, model/runtime, RAG, encryption, …) live there now; existing "BUILD_STATE §4"
> citations resolve via this stub. When a phase changes shared shapes, update them THERE.

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
   workspace, different drive letter). The `electron-builder.yml` hooks + the pipeline are
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
8. **Qwen3.5/3.6 wave promotion (owner — issue #48's open half + issue #53; model-benchmarks
   §9/§9.1): the QUALITY half now EXISTS as tester evidence — remaining work is ratify + the
   missing axes, not "run the eval from scratch".** *(Update 2026-07-12: steps (e) and the
   coupled rank/RAM/test/README edits LANDED EARLY by owner decision, see the 2026-07-12
   newest-Qwen entry + model-benchmarks §6.4; the promotion deliberately did not wait for
   (a)-(d), which stay open exactly as written. The raw tester CSVs are now committed under
   `eval/results/i9-9900X-vulkan-*`. Note the eval-vs-decision divergence recorded in §6.4:
   the promoted 4B/9B ranks contradict the tester verdicts below; revisit §6.4 first if
   (a)-(d) produce contradicting evidence.)* A tester ran the §2 grounded-QA harness over
   13 chat GGUFs incl. all six wave candidates (2026-07-09, i9-9900X + RTX 3090, b9849 binary;
   full tables in issue #48's comments; recorded in model-benchmarks §9 "Tester eval runs",
   2026-07-11). Verdicts as reported: **Qwen3.6 27B Q5/Q4 sweep the 20–24 GB tier** (rank 2/1
   proposal — blocked on productizing: no manifests in the repo, need `download:` block + real
   sha256 + license review); **the 4B FAILS its bar** vs `qwen3-4b-instruct-q4` (F1 .2728 vs
   .3277; 2507 dominates both) — so issue #53's case reduces to the compute axis = option 2;
   **the 2B should never be recommended** (worst unanswerable-discipline of all 13); the 9B
   proposed rank 1 under Ministral; **the 35B-A3B is hallucination-clean after audit, rank
   deferred to the speed rows**. Owner steps, in order: (a) fix the scorer first — refusal
   detector missed 4 abstentions (incl. the German "kein/keine … erwähnt" family) → extend the
   phrase list + `rescore.mjs` re-score (no model re-runs), and treat EM + audited hallucinations
   as primary over the length-confounded F1 (Qwen3.5's verbose house style); (b) RATIFY the
   tester run as the §9 record (or re-run locally); (c) the §3/§4 speed/RSS sweep (decides the
   35B-A3B; supplies the measured peak RSS for RAM-line retunes); (d) the §9.1 through-the-app
   smoke (abort/teardown/thinking toggles — the tester runs are strong informal b9849
   load+stream evidence but exercise the RAG path, not the app UI); (e) productize Qwen3.6 27B;
   then the coupled edits land together: `recommendation_rank`s, honest RAM lines for the
   2B/0.8B (safe now — the §6.3 ranked-only guard), `committed-catalog.test.ts` wave invariants,
   `benchmark.test.ts` RAM mapping. The 20–24 GB tier gap half of #48 is already FIXED (§6.3,
   2026-07-11). **Issue #53 mechanics (verified against `recommendModelIdByRam`, recorded in the
   manifest + §9):** rank 1–2 wins the 4B nothing (qwen3-4b takes ≤12 GB on the rank/disk-size
   tiebreaks); rank ≥ 3 also steals 16/20 GB from Ministral (shared `recommended_ram_gb: 16`) —
   with the failed quality bar, the weak-hardware case is served by option 2 (signal-aware
   picker: feed the benchmark's measured tok/s — persisted with `measuredModelId` since #52 —
   into the recommendation; also resolves #52's remaining downgrade question), which needs its
   own short design note before code. **Added criterion (STR-1 review §5.4, 2026-07-20):** during
   step (b)/(d), record each manifest's thinking-mode behavior (split Instruct/Thinking checkpoint
   vs `enable_thinking` kwarg honored) as a first-class criterion for **structured-surface
   suitability** — the D55 grammar surfaces incl. the ingest extract pass need non-thinking
   behavior or they pay the #50 escalated retry per chunk; the checkpoint choice, not a template
   kwarg, is the robust control (model-benchmarks §9, "Thinking-checkpoint criterion").
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

11. **Full-audit 2026-07-11 — ROUND COMPLETE (close-out 2026-07-11; durable ledger + §-anchor
    legend: [`docs/architecture.md`](docs/architecture.md) **§47**).** Nine-pass pre-release audit
    at `dda1d25`: 1 High code (CODE-1 vault-lock silent data loss) + 2 High docs (DOC-1/2 stale
    RAM tiers) + 13 Medium + ~46 Low/Info, 0 Critical; the dedicated security pass found no new
    vulnerabilities. Remediated across phases A–I + close-out J, commits `e7cda05` → `815b3c0`
    (+ six in-wave review follow-ups), suite 4053 → **4165/47**, typecheck + build green
    throughout. Both working papers were deleted at close-out (uncommitted for their whole life —
    NO git-history copy; §47 is the only durable record: per-finding dispositions, the executed
    owner decisions GAP-1 provenance-survives / CODE-31 relabel / CODE-15+16 approved, premise
    corrections, and the complete residuals register). Actionable leftovers:
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
12. **Full-audit 2026-07-12 — ROUND COMPLETE (close-out 2026-07-12; durable ledger + §-anchor
    legend: [`docs/architecture.md`](docs/architecture.md) **§48**).** Final pre-public-flip
    audit at baseline `b4017be`: **0 Critical, 0 High**; 4 Medium (SEC-1 zero-key sidecar on
    lock-during-import, GAP-1 no push-first flip step, DOC-1 relocation-dead archive links,
    DOC-2 inverted `allowNetwork` default) + a Low/Info tail; the dedicated security,
    vault/shutdown, manifest-chain and cross-platform passes all returned clean (verdicts
    preserved in §48). Remediated across Phases 1–5, commits `9ca8b79` → `032b014` (every phase
    independently reviewer-approved BEFORE landing; one repair round all wave), suite
    4168 → **4190/47**, typecheck + build green throughout. Both working papers were deleted at
    close-out (uncommitted for their whole life — NO git-history copy; §48 is the only durable
    record).
    - _2026-07-12 Phase 1 (vault correctness & reliability), two commits:_ **SEC-1** fixed
      `9ca8b79` — "Lock now" mid-import can no longer write a zero-key document sidecar:
      `documentCipher()` closures re-read the live key per invocation and throw a typed
      `VaultLockedError`; the drained prepare fails clean (row reconciles `failed`). Red-verified
      characterization + gated-`sha256File` integration tests; security-model "Lock failure &
      durability" lock-during-import bullet; the optional orphan-`.enc` sweep stays OUT (the
      startup sweep runs while the DB is locked — known-limitations note). **REL-1 / REL-2 /
      REL-4 / REL-3 / CODE-1** fixed `6a33f25` (commit 2) — `preserveNewerPlaintext` pre-shreds a spent
      `.recovery` before the salvage rename; unlock's roll-forward freshness probe is
      exception-guarded (probe error → leave `.recovery`, unlock normally, retry next unlock);
      the in-flight-stream settle await is bounded (`STREAM_SETTLE_TIMEOUT_MS` 5 s in
      `awaitInFlightStreamsSettled`, covering quit AND interactive lock); security-model's
      `.recovery` confidentiality window qualified "under this app version or newer";
      `cleanRelative` persists posix separators (display-only `source_relative_path`). All five
      forced-failure tests watched red pre-fix (src stashed) then green. Suite 4168 → 4178/47.
    - _2026-07-12 Phase 2 (docs-only, `docs/build-log.md`):_ **DOC-1** fixed — the BUILD_STATE
      restructure relocated the archive from repo root to `docs/`, breaking its relative markdown
      links. One scripted pass de-linkified **258** relative links to inline code (F6 recipe: the
      already-`` `code` `` link text kept, only the `](target)` wrapper dropped, prose otherwise
      byte-identical); the `../BUILD_STATE.md` header link stays live and **6** non-link `](…)`
      sequences are untouched (2 regex/call-syntax false positives + 4 inside a stray-backtick
      paragraph — all confirmed non-links by rendering through `marked`/CommonMark, the ground
      truth vs the audit's naive 264/265 regex count). Archive header gains a relocation note.
      Byte-verified NUL-free + LF, line count unchanged; `marked` re-parse shows 0 relative links
      left. Suite unchanged **4178/47** (docs-only, no new tests). The optional
      `repo-hygiene.test.ts` link-resolvability assertion is DEFERRED to Phase 5 (owns that file).
    - _2026-07-12 Phase 3 (BUILD_STATE prose + owner batch — docs/process only, suite unchanged
      4178/47):_ **GAP-1** (checklist half) — item 10 gained "push `master` first / decide the
      `v0.1.47` tag push deliberately" as its first unchecked step. **SEC-2** (doc half) — §8's
      L-7 row corrected from "build-time only" to cover the in-app `extractWithTar` path
      (tar-implicit `..` refusal + pre-extraction sha256 recorded as the current posture;
      optional explicit-containment hardening is Phase 5's call — the close-out appends its
      outcome). **Owner-decision batch (surfaced here, NOT executed — audit §3):**
      ① **GAP-1 execution** — the actual `git push` (local `master` 5 ahead of origin as of this
      entry) and the tag-push decision. ② **PF-2** — optionally reword the unpushed `41acc47`
      "docs update" commit (a 2,125-deletion structural commit: spec retirement + stamp removal
      + architecture.md NUL fix); verified 2026-07-12 that no tracked file cites `41acc47` or
      its restructure successor. ⚠️ Trade-off: a rebase-reword rewrites the hashes of ALL later
      commits (the restructure commit + this round's three so far) — the hashes cited by this
      item's Phase 1/2 entries would then be stale and need updating; only possible while
      unpushed, so couple with ①. ③ **LIC-2** — generate/ship a THIRD-PARTY-NOTICES for bundled
      npm deps (pdfjs-dist/tesseract.js are Apache-2.0, which asks for NOTICE preservation) or
      defer past the flip. ④ normalize `reviewed_by: comilionas` →
      "project maintainer" in `model-manifests/translation/translategemma-12b-it-q4.yaml` (as
      the other manifests) or keep the handle. ⑤ restore `djuro-agent` to cla.yml's allowlist —
      confirm the post-launch CLA smoke PR is green first (item 10 sidebar). ⑥ confirm the
      tracked `.claude/skills/screenshot-verify/SKILL.md` is deliberately published at flip.
    - _2026-07-12 Phase 4 (docs-only accuracy sweep, suite unchanged 4178/47):_ **DOC-2..DOC-11**
      fixed — all numbers/names re-derived from code/repo at edit time. `data-contracts.md`:
      `allowNetwork` default false→**true** (+ policy-ceiling caveat, mirroring `types.ts:301-303`);
      catalog "11 manifests"→**19 model manifests across 6 role dirs** (14 chat + E5 + reranker +
      whisper + translation + vision, both occurrences); runtime pin `b9585`→**b9849**; launcher
      names → `Start HilbertRaum.cmd` / `Start HilbertRaum.command` / `start-hilbertraum.sh` /
      `READ ME FIRST.txt`; `AuditEventType` "25"→**42** (enum authoritative). `README.md`: disk
      upgrade figures ~10/~19→**~11/~21 GB** (7 GB default set + swap 8B→14B/30B, manifest
      `size_bytes` + sidecars); added a **product-vision.md** Documentation-table row; offline-guard
      sentence aligned with PRIVACY.md ("logs, never blocks … while offline"); Qwen3-4B row
      relabeled "preconfigured-drive default" to break the "default" collision with the DIY
      `--with-assets` chat model (Ministral). `product-vision.md`: voice "input/output"→**input**
      only (no TTS — grep-verified). `model-policy.md`: Chat-default purpose disambiguates
      catalog/preconfigured default vs the DIY default-set model. `architecture.md` **§22 legend
      row ONLY** re-pointed directly at `data-contracts.md` "MVP Definition of Done" (drops the
      BUILD_STATE §4 hop) — §47 ledger untouched, file byte-verified NUL-free. No doc-pinning test
      asserts any changed sentence; every edited doc byte-verified NUL-free. Docs-only ⇒ build
      unaffected.
    - _2026-07-12 Phase 5 (test-net, coverage, licensing — suite 4178 → **4190/47**):_ **TQ-1**
      fixed — the hygiene NUL net now also walks `app-skills/**` + `.github/**` (same extension
      filter; skill frontmatter is the class a stray byte breaks silently), and a new UTF-8 BOM
      ban (first-3-bytes EF BB BF) covers every NUL-net root + root `*.md` (642 files, all
      verified clean first). **TQ-2** fixed — `qwen3-4b-instruct-2507-q4` joined the incumbents
      presence pin + gained a Phase-29 invariant block (rank 1 AND original-4B rank 2 pinned as a
      pair, apache-2.0 approved, real sha256 = download hash, no mmproj); the five non-chat roles
      get a one-manifest-per-role presence + real-hash pin (license posture deliberately NOT
      pinned — TranslateGemma `pending` is the standing sell-gate decision). **SEC-2 (code half)**
      landed as the containment sweep ONLY: `install()` now runs an exported
      `assertExtractedSymlinksContained` over the FINAL post-flatten layout — any symlink/junction
      member resolving outside `extractTo` fails the install (job `failed`, no marker; lexical
      `readlink` resolution so broken links are still caught). The `--no-same-owner
      --no-same-permissions -k` tar flags were DROPPED per the plan's criterion: bsdtar 3.8.4
      (Windows) accepts them (verified live), but GNU tar's `-k` makes an existing file a HARD
      error and no GNU tar exists on this machine to verify against — sweep-only avoids the
      untestable flag semantics. `placeholder`-verify still extracts with `job.unverified` (posture
      unchanged). **DOC-1 hand-off** done — `repo-hygiene.test.ts` pins docs/build-log.md to
      exactly one relative markdown link (`../BUILD_STATE.md`, must resolve) after stripping
      code fences + CommonMark-paired inline spans (the archive's 6 non-link `](…)` false
      positives stay invisible to it). **LIC-1** fixed — `apps/desktop/package.json` declares
      `"license": "GPL-3.0-or-later"` (matches root; electron-builder.yml carries no conflicting
      field). Teeth demonstrated live for all new nets: planted BOM + NUL files and a dead
      archive link each failed their assertion; disabling the sweep call turned the escaping-link
      job `done` — all reverted/restored byte-verified. New `engine-extract-containment.test.ts`
      (7 tests, junction-based so unprivileged on Windows); typecheck + build green.
    - _2026-07-12 Phase 6 (close-out):_ round complete — the audit folded into
      [`docs/architecture.md`](docs/architecture.md) **§48** (per-finding dispositions, the
      clean verdicts, §-anchor legend: every `full-audit 2026-07-12 <ID>` citation in
      code/tests/commits resolves there); both working papers deleted (never committed, no
      history copy); **PF-1** fixed here (the `flake.nix` garbled comment word); §8's L-7 row
      gained the Phase-5 containment-sweep outcome. Final gate **4190/47**, typecheck clean,
      build unaffected (no `apps/desktop/src` touch this phase). **Round residuals (register of
      record):**
      - **Owner batch ①–⑥** (the Phase-3 entry above) — **④⑤⑥ EXECUTED 2026-07-12
        post-close-out (owner-directed):** ④ `reviewed_by` normalized to "project maintainer
        (Claude-assisted review, HF card/LFS verification)" · ⑤ `djuro-agent` restored to
        cla.yml's allowlist (smoke PR #55 verified green: block → sign → ✅, signature recorded
        on `cla-signatures`) · ⑥ owner decided **NOT** to publish —
        `.claude/skills/screenshot-verify/SKILL.md` untracked via `git rm --cached` (file stays
        on disk for local dev; `.gitignore`'s `.claude` rule, which never applied to the
        already-tracked file, now covers it). ② PF-2 **EXECUTED 2026-07-12** (owner-approved,
        while still unpushed): the spec-retirement commit reworded from "docs update" to a
        message naming the retirement + stamp removal + NUL fix (now `41acc47`; rebase rewrote
        all 11 unpushed hashes) and the stale-hash sweep applied — 28 citations across
        BUILD_STATE (§5 item 12, §8 L-7 row) + architecture.md §48 updated to the post-reword
        hashes; trees byte-identical before/after. Still open: ① GAP-1 push + tag decision
        ONLY. ③ LIC-2 **EXECUTED 2026-07-12** (owner-approved): committed generated
        `THIRD-PARTY-NOTICES.md` (226 shipped packages — asar prod closure minus the yml
        negations; no NOTICE files exist in the set; KaTeX OFL font notice included) +
        `scripts/generate-third-party-notices.mjs` (+ shared `scripts/lib/shipped-packages.mjs`),
        shipped via `extraResources`, freshness-gated by
        `tests/integration/third-party-notices.test.ts` (suite 4190 → 4195/47).
      - **SEC-1 orphan-`.enc` sweep — deferred (Info):** the startup sweep runs while the DB is
        LOCKED, so it cannot know which document ids are live; a pre-fix zero-key sidecar
        self-heals only on re-index (known-limitations note shipped with Phase 1). Same family,
        also unswept: a hard crash mid-lock-encrypt leaves a partial-CIPHERTEXT `<enc>.tmp`
        (exposure nil, overwritten next lock; one `rmSync` in the sweep would tidy).
      - **README default-set vision omission — FIXED 2026-07-12 (full-audit 2026-07-12b DOC-1):**
        README + packaging.md corrected (default set ≈10.4 GB incl. `qwen2.5-vl-3b-instruct-q4`,
        vision row + 3 packaging.md spots + model-policy.md "Opt-in only" line), swap figures
        recomputed on the corrected basis (~14 GB 14B / ~24 GB 30B-A3B).
      - **Nuance notes (recorded in the §48 rows):** REL-1's in-code "spent or garbage"
        justification slightly overstates (a REL-2 probe-error corner can leave an
        unconsumed-FRESH `.recovery`); REL-3's confidentiality window can extend one unlock
        further under an active probe error; SEC-2 reviewer N1 — the containment sweep removes
        only the FIRST offender before throwing (the next install's pre-clean removes the rest).
      - **TS-7 (macOS CI leg)** remains the standing owner call — item 7.

13. **Full-audit 2026-07-12b — ROUND COMPLETE (close-out 2026-07-12; durable ledger + §-anchor
    legend: `docs/architecture.md` §49; working paper DELETED, never committed, no history
    copy).** Baseline `06920c1`; 24 findings (23 fixed across Phases 1–5, SEC-2 owner-declined
    → §8 L-7 watch-item); phase commits `015c9d9`/`a93e970`/`e49630e`/`486c96c`/`c16f433` +
    close-out; gate 4195/47 → **4216/49**. Residuals/watch-items (all also in §49):
    ① SEC-2 hardlink hypothesis — §8 L-7 watch clause, re-open on extraction-path/tar change;
    ② DRIVE-NOTICES.md's GPL source-availability URL assumes the public repo — true at flip
    (couple with §5 item 10); ③ LIC-2 LICENSE.txt presence in the packaged artifact rides the
    next manual R2 package smoke; ④ `.ps1`/`.sh` remain outside the hygiene-net extension
    filter (Phase-2 reviewer nit — candidate for a future net widening).
    - _2026-07-12 Phase 1 (docs accuracy + onboarding sweep, docs-only, suite unchanged 4195/47):_
      **DOC-1..DOC-6, DOC-8, GAP-1, PF-1** fixed — all numbers re-derived from manifests/scripts at
      edit time. **DOC-1:** vision (`qwen2.5-vl-3b-instruct-q4`) IS in the `--with-assets` default set
      (≈**10.4 GB**, not ~7 GB) — corrected across `packaging.md` (3 spots), `README.md` (basis +
      vision row), and `model-policy.md`'s stale "Opt-in only" line; README swap figures recomputed
      **~14 GB** (14B) / **~24 GB** (30B-A3B). **DOC-2:** Qwen3.5 27B/35B `16.7/20.6`→**17.6/22.2 GB**
      (README + model-policy, 6 cells). **DOC-3:** model-policy catalog gains the two fast-tier rows
      (0.8B surviving §9 candidate / 2B failed). **DOC-4:** `translation` role added to README repo-tree.
      **DOC-5:** data-contracts b9585 present-tense reworded (verified b9585 / expected b9849).
      **DOC-6:** architecture R-2 walk-script path qualified `apps/desktop/scripts/` (line 5334 only;
      §47/§48 untouched). **DOC-8:** CONTRIBUTING spec §9.2 → architecture.md pointer. **GAP-1:**
      corporate-proxy `setup-dev`/`--use-system-ca` note in CONTRIBUTING + README. **PF-1:** §2 dev
      absolute path neutralized + item-10 re-grep widened to a full-tree sweep. Docs-only ⇒ build
      unaffected; every edited file byte-verified NUL + BOM clean.
    - _2026-07-12 Phase 2 (packaging + test-net hardening, suite 4195/47 → 4199/49, +6 tests):_
      **CODE-1** `!out/preview/**` negation in electron-builder.yml (+ packaging.md sentence),
      pinned in packaging.test.ts. **TQ-1** hygiene nets widened to `mjs|cjs|mts|yml|yaml` + both
      scripts/ roots + model-manifests/ (all pre-verified clean); teeth ritual done (planted
      BOM + NUL under scripts/ each failed the net, deleted, re-green). **TQ-2** 3 containment
      tests (relative escape, contained relative, dangling link — the 2 relative ones probe-gated,
      skip on this box, run on the Ubuntu leg); red-verified: root-anchor / drop-target / realpath
      mutations each flipped exactly one new test red while the old 7 stayed green, reverted
      byte-identical. **TQ-4** license pin apps/desktop = root = GPL-3.0-or-later.
    - _2026-07-12 Phase 3 (notices-generator robustness + logging belt, suite 4199/49 → 4201/49,
      +2 tests):_ **REL-1** both notices sorts localeCompare → deterministic code-unit order
      (license-file sort case-folded to reproduce the committed ICU-primary order); regeneration
      byte-identical ("unchanged"). **REL-2** not-installed shipped package (platform-gated
      optional) now emits a lockfile-metadata fallback section + warning instead of ENOENT — the
      package stays in the list so the gate stays in sync. **TQ-3** non-optional peerDependencies
      folded into the closure walk (byte-identical today) + an independent lockfile-derived belt
      test (red-verified by mutation) + the packaging.test.ts mirror copy kept exact. **SEC-1**
      diagnostics-log belt: `persistEncrypted`/`rotateEncryptedIfNeeded` refuse an all-zero vault
      key (the changePassword v1→v2 in-place-zero window; the refused line flushes after
      `rekeyVaultLog`), red-verified unit test + security-model.md clause. Reviewer pass: 1 real
      catch repaired pre-commit (peer fold had silently broken the documented shipped-packages ↔
      packaging.test.ts closure-mirror invariant).
    - _2026-07-12 Phase 4 (LIC-1 drive attribution, owner-ratified; suite 4201/49 → 4214/49,
      +13 tests):_ **LIC-1** the sold drive now carries LICENSE + THIRD-PARTY-NOTICES.md +
      **DRIVE-NOTICES.md** at drive root (copied by `prepare-drive.{ps1,sh}`); DRIVE-NOTICES.md
      is committed + generated (`scripts/generate-drive-notices.mjs` from runtime-sources.yaml +
      all 19 manifests + pinned texts in the new `licenses/` dir — upstream zips ship no LICENSE),
      deterministic, drift+coverage-gated (`drive-notices.test.ts`, coverage leg YAML-independent);
      the step-7 SELLABLE gate (both scripts) **and** the TS canonical `assertCommercialDrive`
      fail on a missing/empty artifact (red-verified: the old assert passed a zero-attribution
      drive green); `script-drift.test.ts` pins all 4 scripts to `DRIVE_LICENSE_ARTIFACTS`;
      hygiene nets +`txt`+`licenses/`. **LIC-2** root LICENSE ships as `LICENSE.txt` beside
      app.asar (extraResources + test pin). Reviewer APPROVE, 1 should-fix repaired pre-commit
      (MIT weights' upstream copyright lines pinned offline). ⚠️ DRIVE-NOTICES.md's GPL
      source-availability URL assumes the public repo — true once §5 item 10 flips.
    - _2026-07-12 Phase 5 (owner-batch execution, suite 4214/49 → 4216/49, +2 tests):_ **PF-2**
      preview marketing header id → `ministral3-8b-instruct-2512-q4` (ranked, shipping;
      owner-ratified swap). **LIC-3** `scripts/lib/extra-notices.mjs`: pinned verbatim texts for
      the 6 no-license-file packages + the leptonica license appended to tesseract.js-core
      (pinned-from-upstream convention; map applies only on the no-license-file path so a future
      shipped file wins); THIRD-PARTY-NOTICES.md regenerated (+~200 lines, zero pointer-only
      sections left), 2 test pins. **GAP-2** architecture.md gains a 15-line "layout of this
      file" block (pure insertion, ledgers untouched, whole-file byte-verified). **DOC-7** the
      two present-tense design-review pointers tense-fixed (596, 802); the three
      verbatim-keep mentions untouched. **SEC-2** owner ratified SKIP probe → registered as a
      close-out watch-item. Reviewer APPROVE (2 nits applied: provenance-sentence precision,
      test-comment sequencing).
    - _2026-07-12 Phase 6 (close-out):_ round folded into `docs/architecture.md` **§49**
      (24-finding disposition table, owner-batch ratifications, per-phase reviewer outcomes,
      clean verdicts, §-anchor legend — every `full-audit 2026-07-12b <ID>` citation in
      code/tests/docs resolves there); architecture.md layout block updated §24–§48 → §24–§49;
      §8 L-7 gains the SEC-2 hardlink watch clause; working paper deleted after verifying no
      tracked file references it; final gate green.
14. **Full-audit 2026-07-16 — REMEDIATION IN PROGRESS (wave opened 2026-07-17).** Baseline
    `4e02a48` (v0.1.50); 41 verified findings (F-01…F-41; 0 Critical/High, 14 Medium, 27 Low).
    Report: `git show 886be68:docs/audit-2026-07-16.md` (frozen working paper, deleted at
    close-out); executable plan + wave ledger:
    `git show bb2da00:docs/audit-2026-07-16-remediation-plan.md` (deleted at close-out; §D owner
    decisions recorded 2026-07-17 — D-A add CSV BOM, D-B relabel/drop cached read figure,
    D-C approve async image-history port, D-D CSP investigation pre-authorized both ways,
    D-E stacked branches + one wave-close PR). Branch chain `fix/audit-2026-07-16-p1…p9`,
    merged once at Phase 10; both working papers deleted at close-out after the durable
    record is folded into `architecture.md` §50.
    **Phase 1 done 2026-07-17** (branch `fix/audit-2026-07-16-p1`): model-catalog + eval
    docs/comment accuracy — F-08 (corrected the incumbent eval figures misattributed in §6.4 /
    the two promoted manifests / model-policy row 26), F-07 (benchmark.md tier table → the four
    §6.4 tiers), F-09 (supersede annotations on the pre-promotion model-policy/§9 wave text),
    F-20 (data-contracts manifest counts → model-policy pointer), F-21 (presets 4k–128k), F-17
    (dated promotion append to both license_review.notes), F-27 (preload 51-code comment), F-37
    (stale soft-hyphen comment). Docs/comments only; gate unchanged at **4217/49**, typecheck +
    build green. Details: plan §L Phase-1 ledger entry.
    **Phase 2 done 2026-07-17** (branch `fix/audit-2026-07-16-p2`): model-catalog data hygiene —
    F-06 (qwen3.5-9b-q8 `recommended_context_tokens` 98304→8192, the catalog's safe-local
    convention: the 14 GB hard start-gate no longer admits machines a 96k f16 KV cache can't fit;
    capable owners restore a big context via the in-app Settings override), F-16 (Qwen3.6 27B
    Q4/Q5 `size_on_disk_gb` normalized GiB→decimal GB, 15.7→16.8 / 18.2→19.5 = `size_bytes/1e9`;
    README + model-policy display cells + the manifests' own GiB-labelled comments follow). Two new
    `committed-catalog.test.ts` invariants (ctx ≤ 2048 tok/GB of hard-min RAM; `|size_on_disk_gb −
    size_bytes/1e9| < 0.15` for real download blocks), both red-green-demonstrated. Recommendation
    mapping unchanged (`benchmark.test.ts` byte-identical). Gate **4219/49** (+2 invariants),
    typecheck green, build n/a (tests/manifests/docs only). Details: plan §L Phase-2 ledger entry.
    **Phase 3 done 2026-07-17** (branch `fix/audit-2026-07-16-p3`): DIY drive & script parity —
    F-05 (added the `ocr` family fetch to `--with-assets` in BOTH prepare-drive siblings, so DIY
    drives now ship scanned-PDF/photo OCR; new sh↔ps1 parity net pins it; ~10.4 GB figure
    unchanged, OCR data ≈4 MB; #59 provisioning root cause fixed — its in-app warning-copy half
    queued §Q Q-1 → Phase 7, and a ready-to-post #59 comment left for Phase 10 in §L), F-03
    (`prepare-drive.sh` empty-array expansion made bash-3.2/`set -u`-safe via the M23 idiom — the
    macOS DIY abort), F-04 (`fetch-models.sh` continues past a mid-batch download failure + prints
    the summary + exits 1, matching the .ps1), F-18 (`setup-dev.ps1` `--use-system-ca` probe → a
    redirect-free `node -p` introspection, no more EAP-Stop crash on Node < 22.15), F-19
    (`fetch-runtime.sh` archive name strips `?query`/`#fragment`, converging with the ps1/TS
    siblings). Dry-run ps1↔sh parity + F-04/F-18 teeth verified manually (win32; bash 3.2 not
    available — F-03 argued by idiom + M23 precedent). Gate **4221/49** (+2 F-05 parity assertions),
    typecheck green, build n/a (scripts/docs/one test only). Details: plan §L Phase-3 ledger entry.
    **Phase 4 done 2026-07-17** (branch `fix/audit-2026-07-16-p4`): streaming honesty & extract
    freshness — F-02 (`readChatSSE`/`parseSseLine` now REJECT with a typed `ChatStreamError` on
    llama-server's two in-band mid-stream error carriers — `data: {"error":{…}}` frame and bare
    `error: {…}` field line — instead of ending cleanly; a failed generation can never persist
    as a clean answer. Consumer sweep pinned by tests: main chat turn propagates (partial never
    silently persisted), a mid-way-failed compaction summary writes NO checkpoint, both grounded
    paths propagate; new friendly `main.chat.streamError` EN+DE copy via `withChatStream`,
    content-free. Real-server error-frame smoke queued §Q → Phase 9's consolidated smoke
    checklist), F-01 (extract scan-cache hit lookup now carries `AND model_id = ?` — a chat-model
    swap re-extracts on the next explicit run; hash pinned byte-identical, same-model re-run
    stays 0-call, #50 economy holds). All red-green-demonstrated. Gate **4233/49** (+12),
    typecheck + build green. Details: plan §L Phase-4 ledger entry.

    **Phase 5 done 2026-07-17** (branch `fix/audit-2026-07-16-p5`): download & sidecar recovery
    dead-ends closed — F-13 (a COMPLETE `.part` is verified in place instead of re-requesting an
    unsatisfiable `Range` → the HTTP 416 loop with no in-app remedy is gone; typed
    `RangeNotSatisfiableError`), F-34 (the `.part` is fsynced to the device before rename — the
    post-completion power-cut/unplug torn-weight window is closed; CODE-10 wiring pin), F-14 (vision
    sidecar gains the TA-6 M1 identity-compared `onUnexpectedExit` so a mid-session OOM crash
    cold-starts the next analyze instead of failing for a full idle window), F-33 (`extractWithTar`
    gains a 5-min deadline + SIGKILL escalation + abort-signal threading, and a cancelled-but-unsettled
    `run()` counts as busy — the only unbounded child is bounded and the concurrent-install window
    narrows to the ≤2 s kill grace, an accepted residual),
    F-32 (the engine in-use guard is widened per family via a family-partitioned sidecar PID registry:
    a `llama_cpp` install is refused while ANY llama-server sidecar — embedder/reranker/vision/
    translation — is live, a `whisper_cpp` install mid-transcription; new EN+DE
    `main.engine.transcriptionRunning`). All red-green-demonstrated. Gate **4247/49** (+14),
    typecheck + build green. Details: plan §L Phase-5 ledger entry.

    **Phase 6 done 2026-07-17** (branch `fix/audit-2026-07-16-p6`): ingestion & export
    correctness — F-11 (docx-rewrite parses a self-closing `<w:t …/>` as an EMPTY node instead of
    swallowing following markup into the text layer — the D77 corruption on POI/lxml-produced
    files is gone), F-22 (md/txt parsers strip one leading UTF-8 BOM — the app's own BOM'd `.md`
    exports re-import with correct section labels, round-trip proven), F-24 (chunker slice cuts
    are surrogate-pair-aligned, boundary-only — no more lone surrogates at chunk edges for glued
    emoji/astral runs; chunk counts pinned unchanged for non-astral corpora), F-23 (`wordDiff`
    of two zero-word texts returns identical instead of null via an OOB Int32Array read), F-15
    (citation snippets at coverage.ts/common.ts cut by CODE POINT via the new shared
    `services/text.ts`; compare.ts `oneLine` too; RAG-2 pin byte-identical), F-10 (per owner
    decision **D-A**: `.csv` exports carry the UTF-8 BOM — Excel-friendly; the two no-BOM pins +
    one audit-unlisted anchored header pin flipped WITH the fix; BOM'd-CSV re-import round-trip
    proven through papaparse). All red-green-demonstrated. Gate **4264/49** (+16), typecheck +
    build green. Independent review: ACCEPT; its one nit (the F-24 degenerate extend branch was
    untested) closed with a coprime-config test, mutation-red-proven → **4265/49**. Details:
    plan §L Phase-6 ledger entry (incl. the review note).

    **Phase 7 done 2026-07-17** (branch `fix/audit-2026-07-16-p7`): renderer & IPC correctness
    polish — F-25 (translate IPC now detaches each job's `destroyed` listener on the lock/quit
    purge — the third stream terminal the F-4 detach missed, via `TranslateJobService.onStop`;
    no more one-listener-per-lock leak), F-26 (visionSession.analyze ports translate's L6a busy
    guard `activeJobId || analyzing` — a second analyze during the start round-trip no longer
    clobbers the live job's flag), F-28 (preload `listDocuments` smart filter typed as the shared
    `SmartListView`; dead `ChatOptions.useDocuments` removed — type-only), F-36 (marketing
    `getWorkspaceState` override is now case-aware `encrypted` under `isMkt()`, so shell captures
    show the Lock-now rail control that matches the encrypted privacy card — captures re-run +
    eyeballed), F-38 (StagedShell keeps observing after readiness and clears the sticky
    `data-marketing-ready` flag if the goal vanishes, so a post-readiness remount can't yield a
    silently-wrong capture; give-up path now prints — verified). Plus **Q-1** (#59 copy half): the
    scanned-PDF/OCR dead-end warnings (`docs.scan.ocrMissing`, `main.task.needsOcr`) gained an
    actionable EN+DE "how to get the OCR files" hint (`--with-assets` / `fetch-runtime --family
    ocr`); user-guide + troubleshooting cross-refs added. F-25/F-26 red-green-demonstrated. Gate
    **4267/49** (+2), typecheck + build green. Details: plan §L Phase-7 ledger entry (incl. the
    updated #59 comment for Phase 10 and the §Q Q-1 disposition).

    **Phase 8 done 2026-07-17** (branch `fix/audit-2026-07-16-p8`): performance & posture —
    F-29 (skill-suggestion whole-corpus doc signals now memoized in `scope-signals` by a
    `(scope, indexed-COUNT/MAX-rowid, document_collections-COUNT/MAX-rowid)` signature — 5 typing
    pauses → 1 materialization, invalidates on import/delete/membership; `documentsInScope`
    untouched), F-30 (`loadPolicy` caches the parsed policy per config dir keyed by each file's
    mtime/size — the 4 s TranslateScreen poll stops re-reading policy.json+drive.json off the drive;
    a live edit still re-reads), F-31 (Documents `watchJob`+`watchReindex` completion refreshes
    coalesced by a leading+trailing throttle `REFRESH_THROTTLE_MS=1500` — a rapid small-file import
    no longer re-derives the whole library ~2.5×/s; FE-7 pins preserved, new coalescing test),
    F-35⟨D-B⟩ (drive-READ probe relabelled "(cached)" EN+DE — it reads the OS page cache, ~100×
    inflated; `driveWriteMbps` is the honest headline; slow-drive warning gated on write only; old
    persisted values render sanely), F-39⟨D-D⟩ (**verdict: KEEP** `style-src 'unsafe-inline'` —
    KaTeX emits per-expression inline `style=` attributes with no nonce/hash alternative, e.g.
    `x^2 + y^2` → 11; documented in the buildCsp header + security-model.md; CSP string/pin test
    UNCHANGED), F-12⟨D-C⟩ (image-history store/open/delete now ASYNC — `encryptFileAsync`/
    `decryptFileAsync` + `fs.promises` + new `shredFileAsync` twin; analyze handler awaits
    `ensureSession` before `done` so sessionId still rides the event; retires the §35 PERF-1
    sync carve-out. Dev-box `monitorEventLoopDelay`, 16 MiB encrypted store: main-thread stall
    mean 22.4 ms → 3.4 ms, max ~95 → ~24 ms; USB run not reproducible on the dev box). F-29/F-30/
    F-31 red-green-demonstrated; **NF-1** (unlisted F-12 pinning test `vision-security.test.ts`
    waited on job state → now waits on the streamed done event) fixed in-phase. Gate **4270/49**
    (+3), typecheck + build green. Details: plan §L Phase-8 ledger entry.

    **Phase 9 done 2026-07-17** (branch `fix/audit-2026-07-16-p9`): test-infra hygiene + §Q sweep —
    F-40 (corrected the stale `gpu.test.ts` comment — the `--list-devices` fixture was captured on
    b9585, the pin is b9849, a re-capture is owed; the false "fails in CI" guarantee is gone), F-41
    (converted the five heaviest `as never` stub-cast files to typed builders/narrow named casts —
    `fileTranslateSession` 28, `ImagesScreen` 23, `TranslateScreen` 21, `AppLock` 12,
    `translateSession` 9 → all real casts removed; the outer `stubApi(...)` payloads are now checked
    against `Partial<PreloadApi>`. New one-way ratchet `as-never-ratchet.test.ts` (baseline **110**,
    comments stripped) fails if the tests/ cast count ever climbs — TEETH shown 110→111 red→110).
    **§Q swept EMPTY:** Q-2 (real-server error-frame smoke, incl. the partial-frame case) resolved
    by registration into item 7's consolidated smoke checklist above (new items (h) b9849 re-capture
    / (i) mid-stream error-frame smoke, coupling F-40 + F-02). Cast conversions changed no assertion.
    Gate **4271/49** (+1 = the ratchet test), typecheck green (test-only phase — no
    `apps/desktop/src` touched, build n/a). Details: plan §L Phase-9 ledger entry.

    **Phase 10 (close-out folding) done 2026-07-17** (on branch `fix/audit-2026-07-16-p9`):
    **round COMPLETE pending the owner confirmations below.** Durable ledger folded into
    `docs/architecture.md` **§50** (41-finding disposition table, §D decisions as executed,
    Q-1/Q-2/NF-1 + review outcomes + deviations, clean verdicts, residuals, §-anchor legend —
    every `audit 2026-07-16 F-xx` citation resolves there; layout block updated §24–§49 →
    §24–§50). Final wave gate **4271/49** (kickoff baseline 4217/49; +54), typecheck clean.
    **Owner confirmations received 2026-07-17 — ALL THREE EXECUTED, ITEM CLOSED:** ① both
    working papers deleted (full text: `git show 886be68:docs/audit-2026-07-16.md`,
    `git show bb2da00:docs/audit-2026-07-16-remediation-plan.md`; §50 carries the pointers) and
    the CLAUDE.md doc-lifecycle sentence restored; ② **PR #60 rebase-merged to `master`**
    (head `ae6d588`) after green `ci-success` (both OS legs + CLA), the #59 both-halves comment
    posted and **#59 closed**; ③ version checkpoint below (PR #61, tag v0.1.51 local until
    owner-pushed). Final post-merge gates on `master`: **4271/49**, typecheck clean, build
    green. ⚠️ **Branch note (load-bearing, like `cla-signatures`):**
    `origin/fix/audit-2026-07-16-p9` must be KEPT — the rebase-merge rewrote the wave's commit
    shas onto master, so §50's per-finding commit citations and the two `git show` paper
    pointers (`886be68`, `bb2da00`) resolve ONLY through that branch's history; deleting it
    would orphan them. The local p1–p8 labels are ancestors of p9 (redundant, cleaned up);
    `release/v0.1.51` cleaned up after merge (nothing cites its pre-rebase sha).

Version checkpoint: **v0.1.47 tagged 2026-07-11** (0.1.46 → 0.1.47, root + apps/desktop +
lockfile; CHANGELOG header mention updated) — marks the full-audit 2026-07-11 remediation
round complete at the 4165/47 gate. The tag is on origin (observed 2026-07-12), so the
push-the-tag decision from the flip checklist is resolved.

Version checkpoint: **v0.1.48 tagged 2026-07-12** (0.1.47 → 0.1.48, root + apps/desktop +
lockfile; CHANGELOG header mention updated) — marks the full-audit 2026-07-12 round complete
at the 4195/47 gate, plus the merge of the three remote-only commits that had landed on
origin/master beside the local round (two staged-preview commits + the remote's own
djuro-agent allowlist restore, which duplicated flip-batch item 5 — the sole conflict,
resolved by keeping the commented local version of `cla.yml`). Tag is local until the owner
pushes it (a pushed tag triggers the release workflow's draft build).

Version checkpoint: **v0.1.49 tagged 2026-07-12** (0.1.48 → 0.1.49, root + apps/desktop +
lockfile version fields only; CHANGELOG header mention updated) — marks the full-audit
2026-07-12b pre-public-release round complete at the **4216/49** gate (durable ledger
architecture.md §49; LIC-1 drive-attribution mechanism + SELLABLE-gate artifact check
landed). Like v0.1.48, the tag is local until the owner pushes it (a pushed tag triggers
the release workflow's draft build).

Version checkpoint: **v0.1.50 tagged 2026-07-12** (0.1.49 → 0.1.50, root + apps/desktop +
lockfile version fields only; CHANGELOG header mention updated) — marks the **PR #56 merge**
(newest-Qwen promotion, owner decision 2026-07-12, model-benchmarks.md §6.4: recommendation
tiers now Qwen3.5 4B / 9B / Qwen3.6 27B Q4 / Q5, the Qwen3.6 pair productized, the stub
`[PRO]` profile hijack that had broken master CI at `0883020` fixed), rebase-merged as
`a42254f` after all four checks (incl. the now-required `ci-success` — master is ruleset-
protected since 2026-07-12) went green. Like its predecessors, the tag is local until the
owner pushes it (a pushed tag triggers the release workflow's draft build).

Version checkpoint: **v0.1.51 tagged 2026-07-17** (0.1.50 → 0.1.51, root + apps/desktop +
lockfile version fields only; CHANGELOG header mention updated; bump PR #61 rebase-merged as
`7448942` after green `ci-success`) — marks the **full-audit 2026-07-16 remediation wave
complete** (PR #60, 41/41 findings, durable ledger `docs/architecture.md` §50) at the
**4271/49** gate. Like its predecessors, the tag is local until the owner pushes it (a pushed
tag triggers the release workflow's draft build).

15. **OCR-R wave deferrals (registered at the 2026-07-18 close-out; durable ledger =
    `architecture.md` "OCR audit (2026-07-18) — remediation ledger", PR #75):**
    (a) **mid-session OCR-asset refresh** — the engine is composed once at startup; installing
    `ocr/` files mid-session needs a relaunch (documented). Options: the translator-#40
    `onModelInstalled` re-composition analogue for the `ocr` role, or a "Check again" affordance
    on the `ocrMissing` banner — owner UX call. (b) **packaged OCR smoke, recognition leg** —
    the wave's machine carries no `*.traineddata.gz`; the CSP-exposed rasterizer leg WAS
    verified inside a packaged build (P5 probe). Run the full `tests/manual/ocr-smoke.test.ts`
    flow on an asset-carrying drive before the next release. (c) **macOS/Linux packaged CSP +
    OCR smoke** (P5 measured Windows only). (d) **BE-7 memory profile** of a real 300+-page
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
    by the P4 packaged smoke). (c) **`test:coverage` parallelism cap or a documented RAM floor**
    — full-width coverage starves this 16 GB machine; `--maxWorkers=2` is the current workaround
    (script/CI unchanged). (d) **Recommend `.github/dependabot.yml`** with grouped weekly npm
    updates so the next wave arrives as PRs, not an audit (recommendation only — not
    implemented).
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
per-phase test inventories) lives in git history.

---

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

---

## 8. Post-MVP audits & hardening (2026-06-09 → 2026-06-10) — ALL REMEDIATED

After Phase 13, four multi-persona audit rounds (security/privacy · spec-compliance · bug-hunt ·
docs-vs-code · release/build engineering) reviewed the full repo. **Every Critical, High, and Medium
finding plus the actionable Lows were fixed** across six remediation waves. The detailed
per-finding records and the final audit report were removed in the 2026-06-10 docs cleanup — they
live in git history (`docs/audit-2026-06-09-multi-persona.md` and BUILD_STATE §8–§14 before this
commit). Highlights of what was fixed:

- **Security / data-loss:** encrypted document cache (spec §3.5 — stored copies are `.enc` in an
  encrypted workspace, with transient decrypts shredded after parsing); vault-wipe guards (`create`
  refuses over any existing vault artifact; a corrupt descriptor reports `locked`, never
  `uninitialized`); streaming file crypto + chunked shred (> 2 GiB safe); KDF param bounds-checking;
  key zeroing on lock; startup sweep of crash leftovers (`.tmp`/`.parse*`/WAL/SHM).
- **Process lifecycle:** `RuntimeManager` start/stop serialized through an op queue;
  `E5Embedder.stop()` awaits an in-flight lazy start; SIGKILL escalation gated on actual exit;
  awaited `will-quit` stops — every orphaned-`llama-server` path closed.
- **Commercial pipeline:** `fetch-runtime` sha256 parsing fixed (the key regex was structurally
  dead in both shells); `verify-models --strict` weight gate wired into `build-commercial-drive`
  step 7 (a placeholder-hash drive now exits 1); per-OS sidecar loop (one drive ships win+mac+linux);
  license-review ship gate (`checks.licensesApproved`, NOT overridable by `--accept-license`).
- **Correctness cluster:** regenerate-after-failure, conversation-switch-mid-stream,
  per-document concurrency, and lock-while-importing races; DOCX chunk packing (coalesce
  same-label segments); E5 context truncation + batching + request timeouts; checksum verification
  cached on `(path, size, mtimeMs)` (no more multi-GB re-hashing per screen mount); the spec §7.4
  model gate enforced in the MAIN process (role + install state + policy); `developerMode` defaults
  to **false**.
- **Spec completions:** automatic first-run benchmark (§2.1); chat transcript export (§7.6); full
  Diagnostics incl. local log viewer (§7.11); drive detection without the launcher
  (`config/drive.json` marker walk-up from the exe location, §7.2).
- **Manual-acceptance prep (2026-06-10):** `runtime-sources.yaml` pinned to the REAL release
  **`ggml-org/llama.cpp@b9585`** (real per-OS URLs + SHA-256 checksums, verified end-to-end from a
  Windows host for all three OSes; tar.gz + symlink-materialization + flatten handling in
  `fetch-runtime`; schannel `--ssl-revoke-best-effort` proxy fix). **License reviews COMPLETED**
  (spec §13): all six manifests are `license_review.status: approved` (Qwen3 GGUFs = apache-2.0;
  E5 = MIT via the base model, caveat recorded in the manifest notes).

Final gate: typecheck clean, **361/361 tests**, build green, no new runtime deps.

**Still open by choice:** the consciously-accepted items are documented in
[`docs/known-limitations.md`](docs/known-limitations.md) (that list is live; several
MVP-era examples from this audit — the depth-mode plumbing, `runtime_events` — have
since shipped in Phases 19–20).

### Open hardening items — security audit 2026-06-13 (deferred, NOT yet fixed)

The 2026-06-13 hardening wave fixed every MEDIUM + the quick-win LOWs (see the entry at the
top of this file; the full audit report is in git history at commit `f99bc86`). These four
LOW items were consciously deferred — they are defense-in-depth / build-pipeline, none blocks
the offline/privacy guarantees:

- **L-4 — `importDocuments` trusts renderer-supplied source paths.** The handler type-filters +
  unlock-gates, but the path *values* are not constrained to the OS-picker output, so a
  compromised renderer could ingest any user-readable absolute path (arbitrary local-file *read*,
  no traversal *write*). Fix: have `pickDocuments` return **opaque tokens** that `importDocuments`
  redeems, instead of trusting renderer-supplied paths. (Discuss before implementing — it changes
  the import IPC contract.)
- **L-5 — `expandPaths` follows directory symlinks.** `walk()` uses `statSync` (follows links) with
  no cycle guard, so a picked folder with a symlink to e.g. `C:\Windows` traverses outside the
  selection. Blast radius: "indexes files the user didn't intend" (supported extensions only), not
  RCE. Fix: `lstatSync` for directory entries (skip symlinks) or a visited-realpath cycle guard.
- **L-7 — Runtime-archive extraction doesn't prevent member traversal (build-time AND in-app;
  scope corrected 2026-07-12, full-audit SEC-2 — the earlier "build-time only" framing was
  wrong).** `Expand-Archive` / `tar -xzf` in `scripts/fetch-runtime.{ps1,sh}` run on the drive
  **builder's** trusted machine — but the shipped app's engine installer performs the same
  extraction (`runtime-download.ts` `extractWithTar`: `tar -xf … -C extractTo` via the OS
  `tar`) of an archive whose source list (`runtime-sources.yaml`) lives on the user-writable
  drive. Current in-app posture: the archive's sha256 is verified **before** extraction
  (tampering needs drive write access to both the archive/URL and the matching hash; a
  placeholder hash extracts flagged `unverified`), and the OS `tar` refuses `..` members by
  default — containment rests on tar's *implicit* behavior rather than the explicit member
  check this fix calls for; symlink members are the residual soft spot. (The skills importer
  does NOT share this gap — it enumerates and validates every member's path/symlink before
  inflating, arch §22-A2.) Fix: list/extract members with an explicit containment check.
  **Update (close-out 2026-07-12):** Phase 5 (`032b014`) added the explicit in-app containment
  check L-7's fix called for: `install()` now runs a post-extract symlink/junction containment
  sweep (`assertExtractedSymlinksContained`, over the final post-flatten layout — an escaping
  member fails the install, no marker written), closing the symlink residual; the
  `--no-same-owner --no-same-permissions -k` tar flags were deliberately dropped (GNU tar `-k`
  hard-errors on the legitimately-retained archive `cpu/` dir). The build-time
  `scripts/fetch-runtime.*` half of L-7 remains as previously recorded.
  **Watch-item (full-audit 2026-07-12b SEC-2, owner-declined probe):** the sweep covers
  symlink/junction dirents but not tar HARDLINK members (a hardlink is not a symlink dirent) —
  labeled hypothesis, likely moot (libarchive/bsdtar checks linknames; hardlinks need an
  existing same-volume target; the archive hash is owner-pinned). Owner ratified 2026-07-12:
  skip the one-time fixture probe; re-open only if the extraction path or tar binary changes.
- **L-8 — Lockfile / `npm ci` discipline.** Confirm `package-lock.json` is committed and the
  provisioning/build scripts use `npm ci` (not `npm install`) so a build can't float a caret range
  to a newer minor. Integrity anchor = the committed lockfile.

---

## 9. First real Windows `D:\` drive bring-up — durable lessons (2026-06-10)

The first real-drive provisioning + RAG run surfaced a cluster of provisioning, path,
manifest-source and embedding bugs — all fixed same-day (the full narrative is in git
history). What still matters:

- **PowerShell arg forwarding = hashtable splatting, never array splatting.**
  `@('-Target', $t, '-AcceptLicense')` binds positionally (the `-`-prefixed string is NOT a
  parameter name), which broke `prepare-drive -WithAssets`. Convention recorded in §3;
  both call sites use hashtables now.
- **Bare-drive-root containment false positive:** `resolve('D:\')` keeps the trailing
  separator, so the `base + sep` prefix check doubled it (`D:\\`) and rejected every
  legitimate weight — latent because only a real drive-root launch hits it.
  `weightPath`/`resolveWithinRoot` normalize (`prefix = base.endsWith(sep) ? base : base + sep`);
  regression-tested with a real root (`parse(process.cwd()).root`).
- **Hash promotion is durable only in the REPO manifests:** `verify-models --generate` writes
  `config/checksums.json`, never the manifest `sha256`, and any `prepare-drive` re-run
  overwrites drive-local manifest edits. Promote real hashes into the repo manifest, then
  re-sync to the drive.
- **Broken upstream sources found by the fetch:** `qwen3-1.7b-instruct-q4` → 404 (the official
  repo ships no Q4_K_M) — manifest **dropped**; the 4B took over TINY/UNKNOWN
  (`recommended_profiles`). `multilingual-e5-small` quant repo went 401 — switched to the
  `cstr/` mirror, provenance recorded in the manifest license note.
- **The E5 embedder GGUF must be F16 on b9585** (the failure mode
  `tests/manual/rerank-smoke.test.ts` guards against): q8_0 builds either lack
  `token_type_count` (BERT/XLM-R metadata) or crash warmup
  (`binary_op: unsupported types: dst f32, src1 q8_0`). Shipped
  `keisuke-miyako/multilingual-e5-small-gguf-f16` (242 MB, 384-dim, VERIFIED); the `-q8`
  manifest id is kept as the opaque vector tag.
- **The first real-drive hallucination was the plain-Chat tab, not the RAG engine** — the
  question never reached retrieval (the grounded path has a hard empty-corpus guard). This
  finding motivated Phase 17 (rag-design.md §10). Related: a document ingested under the
  mock embedder is invisible to E5 retrieval (vectors are scoped by `embedder.id`) —
  re-upload/re-index after an embedder change.
