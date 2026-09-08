# #334 — auto-start / benchmark sequencing on slow USB (protocol + evidence index)

Issue #334 (I6 of the PR #303 audit, `docs/benchmark.md` "Audit remediation record" §4) asks for
real-hardware proof of the P7 sequencing in `registerBenchmarkIpc.ts`: the cheap
`prepareFirstBenchmark` runs first, the automatic model start second, and the measurement
(`scheduleFirstBenchmark`) waits for that start to settle before any drive or speed I/O. Five
boxes: a slow-USB round trip with hash + load observable; no benchmark I/O beside them; a failed
start still permits the check (no speed leg); a start past the 120 s bound defers and the one
continuation completes; and whether a MANUAL start beside the automatic check measurably
overlaps. Nothing here is synthetic: every workspace is created by the app on the stick.

## Machines, drive, build

| | B | S |
|---|---|---|
| machine | `DESKTOPDIT`, desktop, i7-8700, 12 logical, 31.9 GB → key `win32\|x64\|Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz\|12\|32` (the #330 computer B) | Surface laptop, 11th Gen i7-1185G7, 8 logical, 15.8 GB → key `win32\|x64\|11th Gen Intel(R) Core(TM) i7-1185G7 @ 3.00GHz\|8\|16` |
| graphics | GTX 1070 Ti 8 GB | Iris Xe (shared, 7.9 GB reported) |
| stick, cold sequential read (`readspeed.mjs`, 8 MiB reads) | 28.3 MB/s on the port used for B1 ("slow port"); 116–153 MB/s on a USB 3 port (used to create F and U) | 133 MB/s; the app hashes at 87–91 MB/s there |

- **Drive:** "SSK Drive", SSK USB3.2 stick, 58.2 GB exFAT, the lite drive layout of 2026-08-31
  (`config/drive.json` edition `lite`; `runtime/llama.cpp/win` = `version: 9849 (799fcc04a)`, the
  pinned build; `model-manifests/` byte-identical to the repo's at `c227c63e`). Chat weights on
  it: Qwen3.5 9B UD-Q4_K_XL (5.97 GB, `recommended_min_ram_gb` 12), Qwen3 14B Q4 (9.0 GB, 14),
  Qwen3 4B (2.5 GB, 8); plus e5, reranker, whisper small, the vision pair. Leftovers of an earlier
  vault-timing session (24 GB ballast, seeds, a stale 2026-08-16 vault descriptor) were deleted
  before the run. Mounted as `E:` on B and `D:` on S.
- **Build under test:** `HilbertRaum-0.1.59-portable.exe` packaged on B from master `c227c63e`
  (PR #385 merge) with `npm run package:win`; sha256 in `build.txt`. **Unsigned** (no
  `WIN_CSC_LINK` on B; the "signing with signtool" build lines are no-ops without a certificate).
  SmartScreen's "More info → Run anyway" sufficed on B and S; a third Windows 11 machine with an
  application-control policy ("blockiert durch die Device Guard-Richtlinie Ihrer Organisation")
  refused it outright and was not used (packaging.md "Code signing", risk R7).
- **Launch:** the repo launcher `Start HilbertRaum.cmd` on the root, wrapped by
  `_334-start-perf.cmd` (`HILBERTRAUM_PERF_LOG=1`), so every session appended perf marks to
  `logs/perf.log` — `unlock_done`, `install_state_done` (with `cacheHit`), `model_prefetch`,
  `sidecar_healthy`, `runtime_ready`, `drive_benchmark`. That file is the timing instrument of
  this folder (copied here as `perf-marks.txt` — `*.log` is git-ignored).
- **Helpers (in `_334\` on the stick, copied here):** `readspeed.mjs` (the port probe),
  `leg3-prepare.cmd` / `leg5-prepare.cmd` (hide/restore a weight file + put a workspace in place
  through the #330 `swap.cmd`, which lives beside them on the stick), `build.txt`.

## Three workspaces, one stick

Each automatic check is owed exactly once per (computer, workspace): a computer that has a stored
result for the workspace is restored, never re-measured. So every leg that needs the automatic
check on S uses a workspace created on B with the 9B already "used" (selected + started), and
the workspaces are swapped by renaming as in #330 (`workspace/` + `config/workspace.json` +
`logs/app.log.enc` ↔ `*.W1` / `*.F` / `*.U`).

- **W1** — legs B1 and S1 (the main round trip).
- **U** — leg S3 (the failed start). Its active model became the 14B after the owner's
  extra run on B (below), so `leg3-prepare.cmd` hides the 14B, not the 9B.
- **F** — leg S5 (the manual overlap).

Before each move the 9B's (and for S5 the 14B's) mtime was touched on B, so the per-workspace
size+mtime checksum cache misses on S and the auto-start there HASHES cold before it loads —
#330's F-B1 unlock had been a cache hit, i.e. load-only.

## Sessions (UTC in the logs; the screen shows local time, +2 h)

- **B1 — W1 created on B, slow port (28 MB/s).** `First run: …` at create, the measurement ran
  0.9 s later (no model to wait for). The Models-screen visit hashed every weight, 21.6 GB in
  15.5 min at 23–25 MB/s (#382 as filed). "Use model" on the 9B: install check `cacheHit: true`
  (the Models screen had just hashed it), prefetch 5.97 GB in 1.5 s (page cache), ready in 10 s,
  `backend: gpu`. Manual check 23:29:06 → PRO / 4B pick / 21.3 tok/s. The report's
  "Laufwerk: 589,1 MB/s lesen" is finding 1. Evidence `B1.report.txt`, `W1.log.txt` (first
  session), `perf-marks.txt` lines 1–31.
- **S1 — W1 unlocked on S (133 MB/s port).** 23:56:05.8 unlock → `Drive is on a new computer …`
  + auto-start of the 9B → 23:57:14 `Model checksum hashed` 68.2 s (`cacheHit: false`, 87.5 MB/s)
  → `Model prefetch skipped … page-cache-warm` → 23:58:05.9 `First-run benchmark deferred`
  (120 s) → 23:58:45.9 `Runtime backend selected … gpu`, 23:58:48.5 warm-up done → `drive_benchmark`
  mark 23:58:48.849 (0.33 s after `runtime_ready`) → 23:58:59.0 `Benchmark complete` LITE / 9B,
  8 tok/s measured with the 9B. One more `drive_benchmark` mark at 23:56:06.200 = the Home
  screen's preflight (finding 3). Evidence `S1.report.txt`, `W1.log.txt` (second session),
  `perf-marks.txt` lines 37–53.
- **F and U created on B, USB 3 port (153 MB/s).** Both: create, first-run check at once, the
  Models visit hashed everything (2.5–2.8 min), "Use model" 9B (cache hit, page-cache prefetch,
  ready in 10 s), clean quit. Logs: the first sessions of `S5.log.txt` (F) and `S3.log.txt` (U).
- **U on B (owner's extra run, not a leg; 00:38–00:44).** With the 9B hidden and U in place the
  owner unlocked on B: no `new computer` line and no automatic check (B is U's home computer —
  the reason legs 3 and 5 need S), the auto-start failed fast (`isn't installed`), "Use model"
  on the 14B (57.7 s prefetch, ready in 63.6 s, gpu), manual check 00:42:52 → PRO / 4B / 5.9 tok/s
  with the 14B, 146 MB/s read. Side effect: the 14B became U's active model.
- **S3 — U unlocked on S, 14B hidden.** 00:46:21.227 unlock → `.245 Drive is on a new computer`
  → `.246` auto-start 14B → `.283` `Auto-start … failed … isn't installed on this drive yet` →
  00:46:22.936 `Benchmark complete` LITE / 9B pick, **"Geschwindigkeit: Noch nicht gemessen"**
  (no runtime, no speed leg). Two `drive_benchmark` marks: 21.672 (preflight), 22.922 (the
  check). The 9B hash at 00:47:42 (65.5 s, 91.1 MB/s) is the owner's Models visit afterwards; its
  sample folded into the headline ("Laufwerk: 91,1 MB/s") with "Letzter Lauf" unchanged.
  Evidence `S3.report.txt`, `S3.log.txt`, `perf-marks.txt` lines 137–140.
- **S5 — F unlocked on S, both weights cold, Models screen + "Use model" 14B by hand.**
  00:49:12.8 unlock → `new computer` + auto-start 9B (cold hash) → the owner opened Models at
  ≈00:49:20, which hashed the (touched) 14B BESIDE the auto-start's 9B hash: 14B 318 s
  (28.3 MB/s), 9B 213.5 s (27.9 MB/s — 68 s / 87.5 MB/s alone in S1; the two streams shared the
  port at ≈56 MB/s) → 00:51:12.9 deferred (120 s) → 00:52:46.4 9B installed, prefetch skipped →
  load 132.6 s to `sidecar_healthy` (91 s in S1; the 14B hash ran until 00:54:38) → 00:55:01.6
  `runtime_ready` → `drive_benchmark` 00:55:02.013 (write 35.2 MB/s) → 00:55:04.4 `Use model
  (select + start)` 14B (`cacheHit: true`, its hash done; `RuntimeManager.start` enqueues, and its
  `doStart` stops the current 9B) → 00:55:05.4 `Benchmark complete` LITE / 9B. The run took
  3.4 s from `runtime_ready`; 64 tokens at the 9B's 8 tok/s need ≥ 8 s, so the speed leg was cut
  when the 9B was stopped under it — the reading is then `null` (a thrown stream) or the
  chunk-count fallback over the tokens received. Which one the 00:55:05 result held is not
  recoverable: the owner's manual check at 00:58:46 (4 tok/s with the 14B, 56.7 MB/s = the 14B's
  own load sample) replaced both the headline and S's history entry. The 14B then loaded
  (prefetch 57.6 s, ready 163.6 s). Evidence `S5.report.txt`, `S5.log.txt`, `perf-marks.txt`
  lines 150–168.

## Checklist mapping (issue #334)

| box | evidence | result |
|---|---|---|
| slow-USB round trip: new machine, multi-GB model, hash AND load observable, auto-start + automatic check eligible on one unlock | S1 (hash 68 s, load 91 s; 28 MB/s port on B for the creation legs) | pass |
| no overlapping drive I/O between the automatic hash/load and the check's drive probe | S1 + S5 perf marks: `drive_benchmark` 0.33 s / 0.37 s AFTER `runtime_ready`, none during `install_state_done` … `sidecar_healthy` | pass (the un-sequenced probes are the Home preflight's — finding 3) |
| a load failure still permits the check, without a speed leg | S3: failure at +56 ms, `Benchmark complete` at +1.7 s, "Noch nicht gemessen" | pass |
| a load past the timeout defers; the continuation completes | S1: deferred at 120.05 s, the continuation measured the started 9B (8 tok/s) 10.5 s after settlement; S5: deferred at 120.05 s, the continuation ran at settlement | pass — and, unlike #330 F-B1, the continuation RAN instead of skipping |
| manual start in flight vs the automatic check, confirmed or refuted | S5: confirmed twice over (a Models-screen hash beside the auto-start; a "Use model" press that stopped the measured model under the speed leg); harm bounded — profile LITE and ★ 9B identical to the clean S1 | confirmed, measurement on record; fix filed as #393 (finding 2) |

## Findings

1. **A Models-screen hash lets the page-cache load sample through the #108 honesty guard**
   (B1, and again at the F/U creations). `startModelRuntime` suppresses the model-load sample only
   when ITS install check hashed the file (`if (!cacheHit) suppressNextModelLoadSample()`,
   `registerModelIpc.ts`). After a Models-screen visit the start hits the cache, the ladder's
   prefetch reads RAM (5.97 GB in 1.46 s), `recordModelLoadRead` files 589 MB/s as `model_load`,
   and `preferCandidate` (`read-speed.ts`) never lets a `checksum` sample displace it. Effects: the
   report says "589,1 MB/s lesen" on a 28 MB/s stick beside its own "eher langsam" write warning;
   the #110 slow-read warning cannot fire on that machine; the #107 next-start estimate assumes
   RAM speed. S1/S3/S5 show the guard working when the start's own check hashes (87.5 / 91.1 /
   56.7 MB/s, all honest). This is the default first-run journey (#382 hashes everything before a
   model can be chosen). Defect; filed as issue #392.
2. **The manual-overlap gap is real and reachable, with bounded harm** (S5). Two mechanisms,
   neither visible to the scheduler: (a) `listModels` hashing on a Models visit shares the port
   with the auto-start's hash and load (3.3× / 1.5× slower), which only delays the check; (b) a
   "Use model" on another model at or after settlement is queued behind the auto-start in
   `RuntimeManager` and its `doStart` stops the auto-started runtime while `measureTokensPerSecond`
   streams on it — the reading is lost or chunk-based, never wrong by more than the truncation,
   and the persisted profile/★ did not move. The drive probe itself was not distorted (35.2 MB/s
   vs 27.9–29.2 in the other S probes; it ran before the 14B prefetch began). Fix candidate with
   a small radius: the speed leg's `modelBusy` predicate (already re-checked per chunk, #185) also
   treats `ctx.runtime.status().startingModelId != null` as busy, so the leg yields the existing
   `warnSpeedSkipped` instead of a cut stream; filed as issue #393.
3. **The Home screen's launch preflight probe runs at unlock beside the hash.** `runPreflight`
   (`services/preflight.ts`) reuses `measureDriveSpeed` — the same 8 MiB write + fsync — 0.4 s
   after `unlock_done` in S1 (43.0 MB/s vs 43.8 after the load), S3 (28.7 vs 29.2) and S5. It
   persists nothing; noted in known-limitations, not sequenced.
4. **The 120 s bound is the ordinary outcome on such media, not the pathological one.** A healthy
   start at 87 MB/s on a 16 GB machine took 68 + 91 = 159 s (S1); with a Models visit beside it
   346 s (S5). Benign: no production caller consumes `'deferred'`. Doc sizing note added to
   benchmark.md "Scheduling behind the auto-start".
5. **The load after a cold hash is not warm on a 16 GB machine.** The prefetch is skipped as
   "page-cache-warm", yet the 9B load took 91 s on S (10 s on B with 31.9 GB): the Iris Xe upload
   and the hash's own pass evict part of the file (the #114 memory-pressure effect). Expected; it
   is why hash + load both count toward the bound.
6. **#380 did not bite when a cold hash preceded the load.** The graphics tile named the Iris Xe in
   S1, S3 and S5: the unlock-time probe finished long before the server's Vulkan init, which is
   the phase the #330 race overlapped. The race window is the cache-hit start (no hash) — the
   common moved-drive case — so #380 stands as filed.
7. **Artefacts.** Norton wrapped the very first launch on B (a `Norton sandbox\…` folder on the
   stick dated 01:09:50 local, one minute before B1's `app_ready`; card seen, 21 tok/s, no visible
   effect this time — same class as #330's finding). The unsigned exe: see "Build under test".

## Outcome

All five acceptance boxes of #334 are covered by real-hardware evidence in this folder (build
0.1.59 @ master `c227c63e`; B = i7-8700 / GTX 1070 Ti, S = i7-1185G7 / Iris Xe / 15.8 GB; one SSK
stick, exFAT, 28–133 MB/s by port; encrypted workspaces created by the app). The sequencing holds
as designed for the automatic path; the manual path overlaps measurably with bounded harm
(finding 2 → #393); one new defect outside the sequencing (finding 1 → #392).
