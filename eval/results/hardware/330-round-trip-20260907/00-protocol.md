# #330 — two-computer encrypted-drive round trip (protocol + evidence index)

Issue #330 (HW1 of the PR #303 audit, `docs/benchmark.md` "Audit remediation record" §4) asks for
a physical A→B→A move of one encrypted workspace between two real computers, in two variants:
a **fresh** workspace and an **upgraded** one (a `lastBenchmark` for A, no `benchmarkHistory`).
This file is the step list the session follows and the index of what each step captured.
Nothing here is synthetic: both workspaces are created by the app on the drive, and the
upgraded one is produced by the real pre-history build (0.1.57).

## Machines and builds

| | A | B |
|---|---|---|
| machine | `ps-work`, desktop, i9-14900K, 32 logical, 63.68 GB → key `win32\|x64\|Intel(R) Core(TM) i9-14900K\|32\|64` | desktop, i7-8700, 12 logical, 31.9 GB → key `win32\|x64\|Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz\|12\|32` (the #318 leg-2 machine) |
| graphics | RTX 3080 Ti 12 GB (+ UHD 770 iGPU) | GTX 1070 Ti 8 GB |

- **Drive:** SanDisk Extreme SSD (exFAT, 1.86 TB), mounted as H: on A. Prepared layout from
  2026-08-22 (`config/drive.json`, `models/`, `runtime/llama.cpp/win` b9849, manifests, ocr). It
  carried **no** `workspace/` and no app exe at the start of the session, so every workspace
  below is created by the run itself.
- **Old build (stages the upgraded variant):** `HilbertRaum-0.1.57-portable.exe` (2026-08-18,
  sha256 prefix `b589ed027af21534`). It persists a keyed `lastBenchmark` (os/arch/cpuModel/
  cpuCores/ramGb were already fields) and has no `benchmarkHistory` at all — exactly the M4
  upgrade shape. Started only against a workspace it created itself, never against the new
  build's workspaces (#235).
- **New build (the build under test):** `HilbertRaum-0.1.59-portable.exe` packaged on A from
  master `28692184` (PR #377 merge, 2026-09-07) with `npm run package:win` — sha256 recorded in
  `build.txt` beside this file. Only ONE `HilbertRaum-*-portable.exe` is ever on the drive root
  (the launcher refuses otherwise).
- **Launcher:** the repo's `launchers/Start HilbertRaum.cmd` copied to the drive root; it sets
  `HILBERTRAUM_DRIVE_ROOT` from its own location. `"Start HilbertRaum.cmd" /check` before each
  start names the app it would run.

## Two workspaces, swapped by renaming

One encrypted workspace on the drive = `workspace/` (the `.enc` DB, documents, images) **plus**
`config/workspace.json` (the vault descriptor), and its `logs/app.log.enc` is sealed with that
workspace's data key, so it travels with it. The two test workspaces live side by side as
`workspace.F` + `config/workspace.F.json` + `logs/app.F.log.enc` (fresh variant) and
`workspace.U` + `config/workspace.U.json` + `logs/app.U.log.enc` (upgraded variant); "put F in
place" means renaming the three to `workspace/` + `config/workspace.json` + `logs/app.log.enc`,
and "set aside" the reverse. `swap.cmd` (this folder; on the drive as `_330swap.cmd`) does the
renames: `swap.cmd F`, `swap.cmd U`, `swap.cmd aside`, `swap.cmd status`; it refuses while the app
runs or `-wal`/`-shm` sidecars are present, and `_330inplace.txt` remembers which one is in place. Only ever rename after a
clean quit (no `-wal`/`-shm` sidecars in `workspace/`). Both use a test-only passphrase that is
not recorded anywhere.

## Evidence captured at every unlock

1. Performance screen → **Copy report** → `<W>-<step>.report.txt` (its "This computer" and
   "Other computers" sections ARE the persisted headline and history entries).
2. Settings → Diagnostics → **Export log** → `<W>-<step>.log.txt`, redacted of nothing but the
   passphrase never appears in it. The decisive lines (`registerBenchmarkIpc.ts`
   `prepareFirstBenchmark` / `scheduleFirstBenchmark`):
   - `First run: benchmarking hardware in the background once the model start settles`
   - `Drive is on a new computer: benchmarking it in the background once the model start settles`
   - `Drive is back on a known computer: restored its benchmark result`
   - `Filed the last benchmark result under this computer in the history` (same-machine seed —
     must NOT appear in this protocol, see 1c)
   - `Benchmark complete` / `New-computer benchmark skipped: …`
3. The **"Last run"** timestamp of "This computer" — unchanged across a restore, advanced by a run.
4. On the 0.1.57 step only the Diagnostics benchmark card exists: paste its figures.

## Step list (4 sessions, 3 physical moves)

**Session 1 — on A**

- 1a `U-A1` (0.1.57 only on the drive): start via the launcher, create the encrypted workspace,
  wait for the first-run benchmark (Diagnostics shows read/write figures and the profile), record
  the Diagnostics card as `U-A1-v0.1.57.diagnostics.txt`, quit cleanly. Set U aside.
- 1b swap builds: delete `HilbertRaum-0.1.57-portable.exe`, copy the new exe in, `/check`.
- 1c `F-A1`: start, create the fresh workspace, wait for the first-run benchmark
  (`First run: …` then `Benchmark complete`). Capture report + log. Note the "Last run" time.
  Quit. Set F aside.
  **Do not open U with the new build on A** before it has been to B: that would take the
  same-machine seed path (`Filed the last benchmark result …`), not the upgrade path under test.

**Session 2 — on B** (expect the new-computer path twice; the check runs in the background
and must not compete with a model start — no model is active on a fresh workspace)

- 2a `F-B1`: put F in place, unlock. Expect `Drive is on a new computer …` then
  `Benchmark complete`. Wait for B's own figures. Capture. Checks: "This computer" is the
  i7-8700 with B's own read figure; "Other computers" has ONE row, the i9 with the `F-A1`
  figures and "Last run" time; no A read-speed figure, warning or recommendation in B's headline.
  Quit, set F aside.
- 2b `U-B1`: put U in place, unlock. Same path, plus the M4 backfill: "Other computers" shows
  the i9 row carrying the 0.1.57 result (its "Last run" = the 1a time) although no history
  existed before this unlock. Capture. Quit, set U aside.

**Session 3 — on A**

- 3a `F-A2`: put F in place, unlock. Expect `Drive is back on a known computer: restored …`,
  NO benchmark run, "Last run" = the `F-A1` time, "Other computers" = the i7 row with the
  `F-B1` figures. Capture.
- 3b `F-A3` (later sample): on the Performance screen press **Check again** (or start a model).
  After it finishes: "Last run" advanced; the i7 row is byte-for-byte the same as in `F-A2`.
  Capture. Quit, set F aside.
- 3c `U-A2`: put U in place, unlock. Expect the restore of A's 0.1.57 result ("Last run" = the
  1a time, restored from the entry 2b backfilled), the i7 row from `U-B1` beside it. Capture.
  Quit, set U aside.

**Session 4 — on B** (cross-check that 3b updated headline AND history together)

- 4a `F-B2`: put F in place, unlock. Expect a restore of B's own result (`F-B1` figures,
  "Last run" unchanged); "Other computers" i9 row now shows the `F-A3` figures and time, not the
  `F-A1` ones. Capture. Quit.

## Checklist mapping (issue #330)

| box | evidence |
|---|---|
| fresh A→B→A round trip | `F-A1`, `F-B1`, `F-A2` |
| upgraded variant, outgoing backfilled on first replacement | `U-A1` (0.1.57), `U-B1`, `U-A2` |
| nothing of A carried onto B | `F-B1`, `U-B1` headlines + logs |
| return to A is a restore, newest sample, no measurement | `F-A2`, `U-A2` logs + "Last run" |
| later sample updates headline + matching entry, other entry untouched | `F-A3` (i7 row unchanged) + `F-B2` (i9 row updated) |
| headline / "Other computers" / Copy report attribution at every step | every `.report.txt` |

## Session notes

- **1a, first attempt (18:08):** the 0.1.57 app offered *unlock* instead of *create* and no
  passphrase opened it. Cause: the drive still carried a stale `config/workspace.json` (vault
  descriptor dated 2026-08-16) whose database folder had been removed; the app treats a present
  descriptor as an existing vault (`vaultExistsOnDisk`, `workspace-vault.ts`) and refuses the
  create flow so it can never overwrite user data. Not a defect. Fix on A: renamed the descriptor
  to `config/workspace.stale-20260816.json`, the leftover eval logs to
  `logs/app.stale-20260906.log.enc` / `logs/perf.stale-20260906.log`, left the empty
  `workspace/documents` folder the attempt had created in place (harmless: the create flow
  reuses it). Retry from a clean start.
- **1a done (18:11:41):** 0.1.57 created U and ran the first-run benchmark; card in
  `U-A1-v0.1.57.diagnostics.txt` (PRO, write 281.4 MB/s, no read sample, no model). Clean quit
  (only `hilbertraum.sqlite.enc` at rest, 483,364 bytes). U set aside; 0.1.57 moved off the
  drive root into `.old-build/` (the launcher scans the root only, so the #235 rule holds); the
  new build copied in (sha256 matches `build.txt`) and `/check` names it.
- **1c done (18:13–18:16):** F created, `First run: …` logged at creation and the measurement ran
  0.4 s later (no model to wait for); the owner then used the Performance screen's "Start … and
  measure" (9B, `Use model (select + start)`), which ran the check again at 18:15:01 with the
  speed leg (98.4 tok/s). The mmproj checksum sample (119.9 MB/s, 1.3 GB) landed at 18:15:12,
  after the run, and shows in the headline with "Last run" unchanged — L2 on one machine. No
  "Filed the last benchmark result …" line. Evidence `F-A1.report.txt`, `F-A1.log.txt`. Clean
  quit; F set aside, then put back in place for session 2a.
- **2a done on B (18:23–18:28, drive mounted as E: there):** `Drive is on a new computer …` at
  unlock, auto-start of the 9B, the 120 s bound expired (`First-run benchmark deferred`, the slow
  path: 5.97 GB prefetch at ~42 MB/s), a manual-looking run completed at 18:25:57, and the
  retained continuation resolved `skipped: a result for this computer was saved meanwhile` at
  18:26:12; a second run at 18:28:02 added the speed leg. Attribution correct in both report
  pastes (`F-B1.report.txt`, `F-B1.log.txt`, raw `F-B1.results-raw.txt`). Artefact: Norton ran
  the exe in its sandbox on B (`Norton sandbox\…` folder on the drive root), so B saw no graphics
  card (cpu backend, 22 tok/s) and a slow read path — irrelevant to the identity/persistence
  checks. **2b (U-B1) not done yet:** the owner brought the drive back after the helper looked
  missing (it was there; the drive was fine). Revised trips: 3a/3b on A now → `swap.cmd U` →
  B: U-B1 then F-B2 → A: U-A2.
- **3a done on A (18:52):** unlock of F → `Drive is back on a known computer: restored its
  benchmark result` (PRO / 9B), no run, "Last run" still 18:15:01; the auto-start's prefetch
  produced a newer read sample (346.1 MB/s) folded into the restored headline in place. Evidence
  `F-A2.report.txt`, `F-A2.log.txt`. This launch double-clicked the exe (log:
  `detectedFromAppLocation: true`, root `H:` WITHOUT a separator, manifests from the exe's
  bundled copy) — see the findings; the owner did not paste the "Andere Computer" section.
- **3b done on A (19:09–19:11, again a direct exe launch):** same-machine unlock (no moved-drive
  line, correct), auto-start, then "Erneut prüfen" → `Benchmark complete` 19:11:29 (PRO). "Last
  run" advanced 18:15:01 → 19:11:29; the i7 row in "Andere Computer" unchanged (22 tok/s with the
  9B, i7-8700, 31.9 GB). Evidence `F-A3.report.txt`, `F-A3.log.txt`. The report says
  "Grafikspeicher: Keine" (empty session probe, see the finding) while the 9B decodes at 99.7
  tok/s, i.e. on the card.
- **2b done on B (20:12–22:24, U-B1):** `Drive is on a new computer …` at unlock, the check ran
  at once (no model active in U), then manual checks and a 9B start ("backend: gpu" — Norton
  allowed the exe this time). B's headline carries nothing of A's 0.1.57 result. The on-screen
  "Andere Computer" row was not transcribed; M4 is proven by U-A2 instead. Evidence
  `U-B1.report-and-log.txt`, raw `U-B1.results-raw.txt`.
- **4a done on B (22:25, F-B2):** `Drive is back on a known computer: restored …` (BALANCED /
  27B), no run, "Last run" 18:28:02 unchanged; the owner confirmed the i9 row showed the F-A3
  figures (99.7 tok/s, 19:11:29). Evidence `F-B2.report-and-log.txt`, raw
  `F-B2.results-raw.txt`. Remaining: U-A2 on A.
- **Observation (owner, B, U-B1):** choosing a model was blocked for ~20 min while every weight on
  the drive was hashed at ~25–28 MB/s (the 27B alone 648 s) — the Models screen's verification on
  a slow path. Not a #330 check; see the findings.
- **U-A2 done on A (22:35–22:38, launcher):** unlock → `Drive is back on a known computer:
  restored its benchmark result` (PRO / 27B = the 0.1.57 run; "Geprüft 18:11:41" on screen), the
  i7 row (22.2 tok/s, 8.1 GB VRAM, 22:24) beside it — the upgrade backfill (M4) proven end to
  end. Evidence `U-A2.report.txt`, `U-A2.log.txt`, `U-A2.system-events.txt`. The first session's
  auto-start died with the USB SSD's device reset (see the findings); the owner quit and started
  again; the second unlock restored again (the first restore write had been lost with the WAL)
  and a manual check at 22:37:59 persisted A's new — degraded — sample (2.7 tok/s, BALANCED, its
  own warnings) without touching the i7's entry.

## Findings so far

- **Report line attribution (minor, Copy report):** with the headline still another computer's
  (the moment between unlock on a new machine and its own result), the report heads the block
  "Anderer Computer: <cpu>, <ram>" (L6) but still appends "Empfohlen für den nächsten Start: …"
  — the LIVE pick for the machine the app runs on (`buildReport` appends `live` regardless of
  `currentMachine`). Under that heading a support reader attributes the pick to the other
  computer. Seen in `F-B1.report.txt` ("Qwen3.6 27B Q5_K_M (Arbeitsspeicher)" under the i9 row,
  which on A is a 9B-on-GPU machine). Fix candidate: omit the live line, or label it as this
  computer's, when `currentMachine` is false.
- **Unlock-time GPU probe races the auto-start and can time out; the empty answer is then
  cached for the session (outside the #330 checks; needs its own issue):** in both A sessions
  that had an active model to auto-start (18:52, 19:09) the 9B started `rung 1 … (backend:
  cpu)` on the 3080 Ti, the tile read "Keine" once the session's own probe was persisted, and the
  live pick fell to the RAM basis — while the 9B decoded at 99.7 tok/s (card speed). The
  launcher-started 18:13 session (fresh workspace, no auto-start) read "gpu". Code: rung 1 only
  runs with acceleration on (so no `gpuAutoDisabled` leak from the i7 — that flag is
  workspace-wide, not machine-stamped, a note for #330's spirit); the label is
  `devices.length > 0` of the session-cached `--list-devices` probe; the probe is fired by
  `prepareFirstBenchmark` in the same tick as `maybeAutoStartActiveModel`; a probe that hits
  its 10 s timeout resolves `[]` silently and stays cached until "GPU erneut versuchen"
  (`createCachedGpuProbe.invalidate`), so the manual check at 19:11 re-used it. Measured here
  (`probe-race.txt`): the probe takes ~1 s idle and 7.7 s when it overlaps the server's own
  Vulkan init / weight upload. Ruled out: a drive-relative binary path from the direct launch
  (`probe-shape.mjs` under Node 24 and Electron 43's node: both devices from every cwd), the
  verifier (it logs a warning when it refuses; none in the exports). The direct launch
  (`detectedFromAppLocation: true`, root `H:` without a separator from NSIS `$EXEDIR`) only
  explains the catalogue (the exe's bundled manifests, hence "Qwen3.8 27B"), not the probe. Fix
  candidates: await the (≈1 s) probe before the auto-start, or never cache a timed-out probe as
  an answer, or a longer bound while a start is in flight.
- **USB device reset during the U-A2 auto-start (hardware, not the app):** Windows logged a
  UASPStor 129 reset on the SanDisk Extreme with 19 retried I/Os at 22:35:41 and an exFAT
  "Datenverlust beim Schreiben" on `workspace/hilbertraum.sqlite-wal` at 22:35:45; the app saw the
  prefetch read fail and llama-server exit 0xC0000020 (the weight file could not be mapped) and
  fell to the mock with the #372 notice. The lost WAL write took the session's restore with it —
  the next unlock simply restored again (the restore is idempotent and history-first), so no
  machine's result was lost. The volume's dirty bit is set (`fsutil dirty query`); a `chkdsk /f`
  after the last clean quit is due. Worth a known-limitations line: on a bus reset the
  DECRYPTED working copy's WAL is what exFAT drops, and the seal-at-lock is what carries the
  state back into the `.enc`.
- **2.7 tok/s on the 3080 Ti (22:36 session):** `nvidia-smi` shows the app's llama-server holding
  ~9.5 GB on the card, so the 9B was resident there, yet it decoded at 2.7 tok/s (99.7 tok/s in
  the 18:52/19:09 sessions). Placement (BUILD_STATE §5 item 22 (j): `--fit` may spread layers
  over the iGPU) or a driver state after the bus reset are the candidates; the owner's "Dein
  Modell" placement line for that session is requested. Persistence-wise it is simply A's newest
  sample and behaved correctly (profile downgraded with its own warnings, i7 entry untouched).
- **Deferral path exercised for real:** the 120 s settle bound expired on B's slow path and the
  continuation ran the re-checks and skipped correctly (a real-hardware observation for #334).

## Outcome

All six acceptance boxes of #330 are covered by real-hardware evidence in this folder (build
0.1.59 @ master 28692184; A = i9-14900K/RTX 3080 Ti, B = i7-8700/GTX 1070 Ti; one SanDisk
Extreme SSD, exFAT, encrypted workspaces created by the app):

| box | evidence | result |
|---|---|---|
| fresh A→B→A round trip | F-A1 → F-B1 → F-A2 | pass: new-computer run on B, instant restore on A |
| upgraded variant (0.1.57 workspace, no history), outgoing backfilled on first replacement | U-A1 → U-B1 → U-A2 | pass: A's 0.1.57 result restored on A after B had replaced it |
| nothing of A carried onto B | F-B1, U-B1 headlines + logs | pass: B's own figures, its own warning, no A figure |
| return to A is a restore of A's newest sample, no measurement | F-A2, U-A2 logs + "Last run" | pass: restore lines, no run, timestamps unchanged; a later same-machine read sample folds in without a run |
| later sample updates headline + matching entry, other entry untouched | F-A3 (i7 row unchanged) + F-B2 (i9 row updated to F-A3) | pass |
| headline / "Other computers" / Copy report attribution at every step | every report/on-screen capture | pass, with one minor wording finding (the live "next start" line under an other-computer heading) |

Side findings, each outside the #330 checks and listed above: the unlock-time GPU probe racing
the auto-start (timeout cached as "no GPU") → issue #380; the Copy report's live-pick line under
the "Anderer Computer" heading → #381; full-drive weight hashing blocking model choice for
~20 min on a ~25 MB/s path → #382; `gpuAutoDisabled` being workspace-wide rather than
machine-stamped and the USB bus reset / dropped WAL → `known-limitations.md` lines; the
2.7 tok/s run on A after the reset (placement unknown, the session was closed before the
"Dein Modell" line was captured). The volume was repaired with `chkdsk /f` afterwards (clean, no
lost clusters).
