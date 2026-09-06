# Hardware benchmark & model recommendation

> **Not to be confused with** [`model-benchmarks.md`](model-benchmarks.md) — that doc is the
> offline **model-quality** protocol and measured results; this doc is the in-app **hardware**
> probe that recommends which model a given machine can run.

The benchmark answers the spec §11.1 questions — *can this machine run a model, which
model, what context is safe, is the drive fast enough* — using **only local signals**. It
touches **zero network**: `node:os` + `node:fs` + `node:crypto` only, no `child_process`,
no remote probes, no telemetry. A no-network assertion guards the whole path in the test
suite.

Source: [`apps/desktop/src/main/services/benchmark.ts`](../apps/desktop/src/main/services/benchmark.ts).
IPC: `runBenchmark()` (`benchmark:run`) in
[`registerBenchmarkIpc.ts`](../apps/desktop/src/main/ipc/registerBenchmarkIpc.ts).

## Detection steps (spec §11.2)

1. **System** (`detectSystem`, `node:os`): `os` (platform), `arch`, `cpuModel` + `cpuCores`
   (`os.cpus()`), `ramGb` (`os.totalmem()` ÷ GiB, rounded to 0.1). Every probe is wrapped —
   a failure falls back to `''` / `0` and never throws.
2. **GPU** ([`architecture.md`](architecture.md) GPU record §5.1/§8): the IPC layer runs
   the **session-cached `llama-server --list-devices` probe** on the drive's own sidecar binary
   (`services/runtime/gpu.ts` — an offline subprocess, kill-timeout-bounded, never throws) and
   **injects** the summary into `runBenchmark` (`RunBenchmarkDeps.gpu: { name, useful }`).
   `benchmark.ts` itself keeps its **zero-`child_process` purity** — it never probes. The probe
   result is also persisted to `settings.gpuProbe` for Diagnostics. With no binary / no devices /
   a failed probe, `gpu` stays `null` and nothing blocks. The persisted probe is additionally
   refreshed **once per session** in the background (even when a benchmark already exists), so a
   drive moved to another machine re-labels itself; Diagnostics' "Try GPU again"
   (`gpu:try-again` IPC) invalidates the session cache and re-probes immediately.
3. **Drive speed** (`measureDriveSpeed`): writes a small temp file
   (`DRIVE_PROBE_BYTES = 8 MB` of random bytes) **inside the workspace**, times a sequential
   write (with `fsync`) then a read, and reports MB/s. The temp file is **always removed**
   (`try/finally`), the probe is **bounded** (8 MB) so it never hangs the UI, and any failure
   returns `null` Mbps + an `error` string instead of throwing.
   **`driveWriteMbps` is the honest probe figure** (the write is `fsync`-bound, so it times real
   device I/O). **`driveReadMbps` is CACHED, not a drive speed** (audit 2026-07-16 F-35): the read
   reads back the 8 MB file the write just flushed, which is still resident in the OS page cache
   (`fsync` flushes dirty pages to the device but does not evict them), so on any OS the read is
   served from RAM — it runs ~100× inflated on slow media. `node:fs` exposes no
   cache-bypassing/unbuffered read, so a genuine cold read is not measurable *by this probe*.
   **F-35 resolution (issues #108/#110, 2026-08-08):** #108's measurements showed the cached figure
   carries **zero** information (1672–2846 MB/s on both a 70 MB/s USB stick and internal NVMe), so it
   is **retired from display entirely** — Diagnostics now shows **`BenchmarkResult.effectiveRead`**,
   an honest read sample measured as a **byproduct of real multi-GB reads** the app performs anyway
   (`services/read-speed.ts`): the model-load window (file size over the first ladder rung's
   spawn-to-healthy elapsed) or a completed checksum pass (bytes hashed over elapsed; hash-CPU-bound
   on fast media, so a `model_load` sample always replaces a `checksum` one, never vice versa).
   Measured separation: ~70 MB/s on the stick vs 430+ on SSDs. Honesty guards (adversarial-review
   round 2026-08-09): a `model_load` sample needs ≥ 2 GiB (parse/KV-alloc/graph-init fixed costs
   must not dominate the window), a start whose install-state pass just HASHED the file records
   no load sample (the hash warmed the page cache — the window would read RAM), and the download
   verify never samples (it reads bytes the app just wrote). A fresh install has no sample yet —
   Diagnostics shows *"not measured yet — starting a model measures it"*; once present the row
   carries the sample's own date (the card's "Last run" describes the benchmark, not this row).
   `driveReadMbps` itself is still computed and persisted (continuity for old blobs + the probe's
   own `drive_benchmark` perf mark) but never displayed and never gates anything. Old persisted
   `lastBenchmark` values (no `effectiveRead` field) render the "not measured" state — no
   migration.
4. **Decode speed** (`measureTokensPerSecond`): **optional**. Only runs when a runtime is
   active — it streams the prompt *"Write a short paragraph about privacy."* under a 64-token
   `max_tokens` cap (the paragraph wording fills the cap reliably; a one-sentence prompt finished in
   ~20 tokens, a window dominated by per-request overhead — issue #291). It is `null` when no
   runtime is running. **What the number is (since #291):** llama-server's own
   `timings.predicted_per_second` from the stream's final chunk — **decode tokens over decode
   time**, prefill and the first-token latency excluded, and TOKENS rather than SSE chunks (under
   MTP speculative decoding, #182, one chunk carries an accepted draft run of several tokens, which
   halved the old chunk-count reading on the recommended Qwen3.8 entries). The result records the
   basis and the token window (`BenchmarkResult.speedBasis = { basis: 'timings', tokens }`), and
   the card shows the count ("48 (over 64 tokens, …)"). A runtime that sends no `timings` (the mock;
   an older server) falls back to the old **approximation** — streamed chunks over wall time
   measured from before the request, so prefill-inclusive — flagged `basis: 'chunks'` and rendered
   "≈ 30 (approximate — counted chunks, not runtime timings; …)". Results persisted before the
   field existed were all chunk-based and render as approximate too; no migration. The probe
   consumes the whole capped stream (no early exit at 64 chunks — that used to cancel the reader
   before the timings chunk arrived) and still DISCARDS a reading that became contended mid-probe
   (#185). The low-tokens/sec profile **downgrade** and the GPU **bump** are live with real local
   inference.
   **The number measures the CURRENTLY LOADED model, not the recommended one** (issue #52):
   `runBenchmark` records the loaded model's id as `BenchmarkResult.measuredModelId` (null when
   nothing was measured; absent on results persisted before the field existed), and the
   Diagnostics card + its Copy text render the value as *"48 (over 64 tokens; measured with the
   loaded model \<id\>)"* so the tok/s can't be misread as a property of the recommended model.

## Profile classification (spec §11.3)

`classifyProfile(ramGb, { tokensPerSecond?, gpuUseful? })` — pure:

```text
ramGb <= 8   → TINY
ramGb <= 16  → LITE
ramGb <= 32  → BALANCED
else         → PRO
invalid ram  → UNKNOWN   (detection failed)
```

Adjustments, in order:
- A **useful GPU** bumps one step toward `PRO` (capped at `PRO`). "Useful" is the
  **conservative Phase-16 gate** (`gpuUsefulForProfile` in `runtime/gpu.ts`): some probed
  device has **≥ 6 GiB** (`GPU_BUMP_MIN_VRAM_MB = 6144`) **and** does not look integrated
  (`looksIntegrated` name heuristic, biased toward *not* bumping). Rationale: an Iris Xe
  reporting 16 GB of *shared* memory must never push a 16 GB laptop into BALANCED→PRO and a
  14B recommendation — a false negative only costs a too-small recommendation, never a
  too-big one.
- **Very low** throughput (`tokensPerSecond < VERY_LOW_TOKENS_PER_SECOND = 3`) downgrades one
  step (never below `TINY`). **Basis shift (issue #291, 2026-09-04):** the threshold was
  calibrated when the figure was a prefill-inclusive chunk rate; it now compares the runtime's
  decode-only tokens/sec, which reads higher (the #291 rig on the pinned b9849: the old probe's
  25 vs 28.2 / 25.9 measured with MTP, 21.8 without — verified against `print_timing` on #298;
  the issue's 47.9 came from a newer `-fa` build). It is an
  order-of-magnitude gate far below any figure the change moves, so it was deliberately **not
  retuned** — the same applies to the §6.5 picker step-down (`SLOW_PICK_TOKENS_PER_SECOND = 5`)
  and the local API's Retry-After heuristic. Since issue #52 this is **no longer silent**: when the reading
  actually moved the profile (computed as "profile with the tps hint ≠ profile without it", so
  an already-TINY machine never over-claims), the result carries a warning that **names the
  measured model** — a crawl measured on an oversized loaded model is evidence about that
  pairing, and the user can re-run with the recommended model loaded. *(Resolved 2026-08-09,
  issue #95: the profile downgrade stays as-is, and the RECOMMENDATION now applies the §6.5
  predicate instead — an oversized crawl never moves the pick, a right-sized crawl steps it
  one tier down. See "Recommendation" below and `model-benchmarks.md` §6.5.)*

## Recommendation

**The primary picker is RAM-best-fit, not profile lookup.** `runBenchmark` calls
`recommendModelIdByRam(manifests, round(ramGb), 'chat', speedSignal)`, which chooses the largest model
that fits the measured RAM, breaking ties on each manifest's `recommendation_rank`. The profile-based
`recommendModelId(manifests, profile, 'chat')` is only the **fallback** when RAM can't be detected
(`ramGb = 0`). With the committed manifests the live, real-hardware recommendations are:

| Measured RAM | Chat model |
|---|---|
| < 12 GB | `qwen3.5-4b-ud-q4kxl` |
| 12–15 GB | `gemma4-e2b-it-qat-q4` |
| 16–23 GB | `qwen3.5-9b-ud-q4kxl` |
| 24 GB | `qwen3.8-27b-ud-q4km` |
| ≥ 32 GB | `qwen3.8-27b-ud-q5km` |

(This is the newest-Qwen promotion, owner decision 2026-07-12; handed to the Qwen3.8 pair 2026-08-16;
handed BACK on 2026-08-20 when upstream deleted the Qwen3.8 files; and RESTORED the same day to
their measured `UD-*` successors once the §9.5 successor wave ran the full per-quant rig and the
owner ratified the ranks (issue #196, PR #199) — see `model-benchmarks.md` §6.4, the §9.4 wave
record and §9.5 — plus the E2B promotion,
owner decision 2026-08-09, issue #153 (the 12–15 GB row; §6.5 "#153 amendment"). The **bundled** default on a preconfigured drive stays `qwen3-4b-instruct-q4` — the
promotions deliberately did NOT change the bundled model; the tiers above are the RAM-best-fit
recommendation the picker offers, not the bundled pick.)

The profile fallback maps TINY/LITE/UNKNOWN → `qwen3-4b-instruct-q4`, BALANCED → `qwen3-8b-instruct-q4`,
PRO → `qwen3-14b-instruct-q4` (it matches a manifest whose `recommended_profiles` includes the profile).
Full benchmark detail and the rank rationale: [`model-benchmarks.md`](model-benchmarks.md) §6.2–§6.4.

(`qwen3-1.7b-instruct-q4` was the TINY/UNKNOWN model in the original spec §7.3 table, but it was
dropped — the official `Qwen/Qwen3-1.7B-GGUF` repo ships no Q4_K_M — so `qwen3-4b-instruct-q4`,
the smallest bundled chat model, now also covers TINY + UNKNOWN. See BUILD_STATE §9.)

The larger `qwen3-30b-a3b-q4` (MoE) carries an **empty** `recommended_profiles` and is never
auto-recommended — it stays selectable on the AI Model screen as a deliberate opt-in (it needs ~20 GB
RAM but runs near-3B speed).

**Speed-signal step-down (issue #95, since 2026-08-09).** The picker optionally consumes the
persisted probe pairing (`tokensPerSecond` + `measuredModelId`): a probe strictly under
`SLOW_PICK_TOKENS_PER_SECOND = 5` tok/s, measured on a model whose `recommended_ram_gb` is at or
below the would-be pick's, steps the recommendation down ONE capacity tier (ranked models only,
never onto rank 0; with no lower ranked tier the pick keeps). An oversized loaded model crawling
is expected and never moves the pick. `runBenchmark` applies it with the just-measured values and
`listModels` with the persisted ones, so Diagnostics and the Models screen ★ always agree; when
the step fires, the persisted warnings gain `main.benchmark.warnRecommendationLowered` (canonical
English) naming the measured model and figure. Full design record: `model-benchmarks.md` §6.5.

## Warnings (spec §11.3 + §11.4)

`buildWarnings(...)` is **encouraging, never judgmental** — it never says "your hardware is
bad":

- **TINY** → *"This device is best suited for the smallest, quickest model. Larger models may run slowly."*
- **UNKNOWN** → a friendly "we picked a safe, lightweight model" note.
- **Slow read** (issue #110, the PRIMARY drive warning) → fires when the honest
  `effectiveReadMbps` (see the Drive-speed step: a real model-load/checksum read, never the
  page-cached probe leg) is `< SLOW_EFFECTIVE_READ_MBPS = 100` MB/s. The felt cost of a slow drive
  is read-bound — every model start reads the whole GGUF at media speed (on RAM-constrained
  machines even warm starts do, issue #107; measured 88–99 s per 9B start at ~70 MB/s vs 12–14 s
  from an SSD) — so the copy names the consequence: *"Reading from this drive measured about
  \<mbps\> MB/s. Starting a model reads its whole file at that speed, so model starts will be slow
  on this drive."* Interpolated persist-canonical (the `{mbps}` value is baked in;
  `INTERPOLATED_MAP_KEYS`). **No sample → no warning**: a fresh install never warns on missing
  data. The 100 MB/s threshold separates the measured USB-stick class (~70) from SSDs (430+) and
  stays above worst-case hash-CPU-bound checksum samples (136 measured).
- **Slow drive** (write `< SLOW_DRIVE_MBPS = 30` MB/s) → the SECONDARY check for genuinely broken
  media, unchanged copy: a non-blocking "models will still work, but loading may take longer"
  note. Gated on the `fsync`-bound **write** figure only (audit 2026-07-16 F-35): the probe's read
  leg is page-cached and never gates anything. Slow drives **warn, never block**.
- **Drive un-measurable** → "drive speed could not be measured; recommendation uses RAM + CPU
  only." The slow-read warning is independent of this branch — a failed probe can ride alongside a
  real read sample.
- **Very low tok/s downgrade** (issue #52) → *"Text generation was very slow with the loaded
  model (\<id\>), so the assigned profile was stepped down one level. …"* Interpolated
  persist-canonical like the slow-read warning: stored with the model id baked in, reverse-matched
  via a template regex (`INTERPOLATED_MAP_KEYS`) instead of the exact-match set.

**Between benchmark runs** the slow-read warning is re-keyed IN PLACE by
`persistEffectiveRead` (`upsertSlowReadWarning`): the only automatic benchmark runs on a fresh
workspace — before any model (and thus any sample) exists — so without this the primary #110
warning could never appear on the default journey, and a stale one could contradict the freshly
updated "Measured read speed" row beside it. A fast sample removes it again; every other warning
is a benchmark-time fact and is never touched.

**Preflight reuse:** `runPreflight` feeds `buildWarnings` its 8 MB probe figures only — never an
effective-read sample — so the Home-screen preflight note can only ever be one of the two
probe-based drive notes. It selects that note by **exact canonical-English match** (a `/drive/i`
word-regex would silently mis-bind once two drive-worded warnings can co-fire, and
`PreflightResult.slowDriveWarning` holds a single string).

## Persistence

Spec §8 defines **no `benchmarks` table**, so the last result is persisted via the **settings
store** as `AppSettings.lastBenchmark` (a JSON `BenchmarkResult`, default `null`).
`runBenchmark()` writes it after each run, and files the same result under this machine in
`AppSettings.benchmarkHistory` (see "History per machine" below). Downstream reads use `lastBenchmark.profile`,
falling back to **`UNKNOWN`** until the user runs the benchmark for the first time:

- `getAppStatus().hardwareProfile` (Home screen).
- `buildModelList({ profile, … })` (AI Model screen `recommended` flag).

The Diagnostics screen surfaces a **Run benchmark** button and renders RAM / CPU / OS-arch /
measured read speed (`effectiveRead`, with its source + GB context, or "not measured yet") /
drive write / decode speed (with its basis and token window, #291) / assigned profile /
recommended model + the warnings, and re-loads the last result from settings on mount. The `effectiveRead` field is additionally **updated in
place** on the persisted result outside benchmark runs (`persistEffectiveRead` in
`registerModelIpc`) as model starts / Models-screen visits / forced re-verifies observe fresh
samples, and `runBenchmark` receives the latest sample **injected**
(`RunBenchmarkDeps.effectiveRead`, the GPU-probe injection pattern — this module measures
nothing itself), carried forward from the previous result so a re-run never loses it.

**Identity-gated carry-forward (PR #303 audit, M2).** A persisted sample describes the computer
it was measured on, so it is carried forward — into a fresh run, its slow-read warning, and the
#107 start estimate — only when it is **this machine's**: `sampleEligible` in
`services/benchmark-persistence.ts` compares the result's `machineKey` with the current one.
Known, unequal keys are foreign and never a candidate, so a NEW computer's first benchmark starts
with no read figure rather than the previous computer's; a local `checksum` sample beats a
foreign persisted `model_load` one because identity is decided **before** the source ranking
(`preferCandidate`: same-machine `model_load` beats `checksum`, else the newer sample). **G3:**
an unknown identity on **either** side (a `null` key — a legacy blob, a failed detection) stays
eligible as "this machine". That is a compatibility policy, not proof of provenance: an old
workspace keeps behaving as before, and an unkeyed result never acquires a fabricated key or a
history entry. The eligible persisted sample is `lastBenchmark`'s when that result is eligible,
plus this machine's own history entry's (the only same-machine record when `lastBenchmark` is
foreign), ranked together (`eligiblePersistedSample`).

**Every eligible destination (L2).** `persistEffectiveRead` writes a sample to `lastBenchmark`
when it is eligible **and** to this machine's `benchmarkHistory` entry when one exists
(`effectiveReadPatch`); with a foreign `lastBenchmark` only the history entry is written, and a
local sample never rides another computer's result. Each destination is compared on its own —
a headline that already carries the sample does not excuse a stale history copy — and each keeps
a sample that outranks the new one. With no eligible destination nothing is written and the
sample stays **un-handled** (a benchmark is never fabricated just to store it); the handled memo
is set only after a successful write to every eligible destination, scoped to the workspace DB
handle and the machine key, so a failed write, a locked workspace, a lock/unlock, or a drive on
another computer re-evaluates on the next observer call or the post-start/list/verify retry.
A sample-only update never touches `ranAt` — it is not a new run. Only the slow-read warning is
re-keyed; every other warning is a benchmark-time fact.

**Commit-time re-resolution (M6).** `runAndPersistBenchmark` resolves the eligible sample before
the run (so the warning derivation sees it) and **again after both the drive and the speed legs**
— a model start or a cold hash can land a newer sample meanwhile, which the observer has already
persisted onto the outgoing result — and folds the newest eligible one into the result
(`mergeSampleIntoResult`) before persisting. The returned result is the reconciled object that
was written.

## History per machine (2026-09-05)

A portable drive travels, and a benchmark result describes the computer it ran on, not the
drive. Since the performance wave the settings store also keeps **one result per computer**:
`AppSettings.benchmarkHistory` (`BenchmarkResult[]`, newest first, default `[]`, capped at
`MAX_BENCHMARK_HISTORY = 8`; `services/performance.ts`). Every persisted run calls
`upsertHistory`: the entry for the same machine is replaced, other machines stay, the oldest
other machine falls off the cap.

**The machine fingerprint** (`machineKey`) is OS, arch, CPU model, core count and RAM rounded to
whole GB (`os.totalmem()` drifts by a few MB between boots of one machine; the Models screen
rounds the same way). A result with no usable identity (an empty `cpuModel`, `ramGb` of 0, or a
blob persisted before these fields were reliably filled) has a **null key**: it is never filed in
the history and never counts as "another computer", so an old workspace keeps behaving as before.

**The moved-drive check** lives in `maybeRunFirstBenchmark`, which already runs after every
unlock. If `lastBenchmark` exists and its key differs from this machine's:

- a history entry for this machine is **restored** into `lastBenchmark` (so the ★ pick and the
  profile follow the machine, not the drive) and nothing is re-measured;
- with no entry, this is a first run on a new computer and the benchmark runs in the background
  exactly as on a fresh workspace.

Either way the per-session GPU probe refresh still happens first. The `benchmarkHistory` write
gate accepts only an array of plain objects (junk elements dropped, length capped; the 256 KB
serialized cap applies to the list).

**Upgrade backfill (PR #303 audit, M4).** A workspace from before the history existed holds the
previous computer's result only in `lastBenchmark`, so whatever replaces that headline first
files the **outgoing** result into the history (`backfillOutgoing`): the same-machine startup
branch seeds a keyed `lastBenchmark` that the history lacks (no re-run; an unkeyed legacy result
is left alone entirely), the restore branch backfills the foreign outgoing result before writing
the restored one, the new-machine branch seeds it before the background run, and the run itself
(manual or first-run) backfills once more — a no-op when already filed, so the entry is never
duplicated. Rules: a history observation for that machine that is as new or newer (by `ranAt`,
then by the sample's `at`) is never overwritten with an older outgoing copy; the entry lands at
its `ranAt` position (newest first); and at the cap the **oldest OTHER machine** is evicted, never
this machine's entry — the restore destination is captured before the backfill and survives it.

**Write ordering.** The settings store upserts one row per key with no multi-key transaction, so
every persist that touches both writes them in **one `updateSettings` call with `benchmarkHistory`
first, then `lastBenchmark`** (the run, the restore, the observer): a crash between the two rows
loses at most the headline copy, never a machine's only result.

## Performance screen (2026-09-05)

The check's answer moved out of the Diagnostics tab onto a primary rail destination,
**Performance** (`renderer/screens/PerformanceScreen.tsx`; design-guidelines §2, the machine
group beside AI Model). Diagnostics keeps the raw table and its Copy button as the support surface; the
screen answers the user's question in plain words. Three cards:

1. **This computer**: one verdict sentence ("Runs \<model\> at about \<n\> tokens per second.
   Model starts from this drive are fast/slow.") and four tiles, each with a rating WORD, never a
   colour alone: Speed (decode tokens/s, the measured model and date; "Approximate" on a
   chunk-basis result), Memory (RAM, the profile as the pill, the model the RAM fits together with
   the context it launches with: the user's `contextTokensOverride` or the model's recommended
   window, plus CPU), Graphics memory (`BenchmarkResult.gpuVramMb`, the primary probed device's
   total MiB recorded at benchmark time so the history rows carry it too; "Usable" at or above the
   runtime's 6 GiB GPU gate, "Small" below it with the plain consequence "models run on the
   processor", "None" without a device; a result persisted before the field existed, or whose probe
   came back empty, gets the stored `settings.gpuProbe` figure folded in by
   `buildPerformanceSnapshot`, for the current machine only, and the screen keeps
   `PerformanceSnapshot.currentGpu` plus the settings probe as last-resort fallbacks, so the
   tile never waits for a re-run), Drive (`effectiveRead` with its source and date; "Pending" until a model start measured
   it). Actions: **Check again** (or **Start \<model\> and measure** when speed is unmeasured,
   the recommended model is installed and nothing runs: `useModel` then `runBenchmark`), **Change
   context size** (opens AI Model, the one place the context is set), **Copy report**. A "Why this
   model?" link to AI Model was tried and dropped (2026-09-05, owner: it led nowhere useful). A
   result measured on another computer says so.
**Your model** (a row under the tiles; 2026-09-05, owner direction): whether the ACTIVE model fits
is not a property of RAM or of VRAM alone, so neither tile says it. The row names the model, its
size on disk and the context it launches with, then gives one verdict against this computer's
**memory class** (`memoryClassOf` in `services/performance.ts`): `discrete` = a usable graphics
card (the runtime's own 6 GiB, not-integrated gate) whose VRAM is the budget; `unified` = Apple
Silicon (darwin + arm64), one pool shared by CPU and GPU, budget = Metal's
`recommendedMaxWorkingSetSize` when the load log printed it, else 75 % of RAM (the Memory tile is
labelled "Unified memory" and the graphics tile is hidden); `cpu` = no usable card, budget = RAM.
**Observed first**: after a start, llama.cpp's own load log says where the model landed, and the
chat ladder now reads it (`runtime/placement.ts`, one parser per attempt, fed by the sidecar's
`onStderrData`; the chat server runs with `-lv 4` because the pinned build prints these lines
only from log verbosity 4 up, verified 2026-09-05: 3 prints none, 5 adds the `--fit` dry-run
pass): `offloaded X/Y layers to GPU`, every `<device> model buffer size` (CPU* devices and the
backends' `<Backend>_Host` buffers are the CPU side), every `<device> KV buffer size`, the Metal
budget line. The reading is recorded
once the rung is healthy (`recordModelPlacement`, stamped with the backend, the launched context
and `machineKey`), latched for the session, and persisted per model id in
`settings.modelPlacements` by the observer `registerBenchmarkIpc` registers; the snapshot uses it
only for the active model and only when the record's machine is this one. **Verdict**
(`placementVerdict`, pure): observed → 'gpu' when every layer is on the GPU (unified reads the
same), 'partial' otherwise with the CPU-side bytes as the spill (CPU, CPU_Mapped and the
backends' `*_Host` buffers), 'cpu' for a CPU backend, 'unknown' for a GPU start whose log carried
no offload line (never a guess); the size shown is weights + context cache as measured. A
partial offload on a card that would hold the model is the normal `--fit` outcome when the card
was not empty at start: the parser also reads the `device_info` "N MiB free" figure
(`gpuFreeAtStartMb`), and, with the `sched_reserve` compute-buffer line (`gpuComputeMb`), the copy tells the two
cases apart: a card that was NOT free at start ("only N GB was free, restart once the card is
free") versus a card that WAS free, where the fit's own reservations are the reason (model +
cache + working buffers + the fixed 1 GiB `--fit-target` margin came within a whole layer of the
free memory, and the fit moves whole layers, ~430 MB each on a 27B). Whether the app should
trade that margin for a full offload is an owner decision (BUILD_STATE §5 item 21 (f)). Units: every size on the
screen is GiB (RAM, VRAM, the buffers), so the manifest's decimal "size on disk" is converted
once in the snapshot (19.8 GB → 18.4). Before the first start → an ESTIMATE from the
weights alone (the file size; the copy says so and that the context cache is measured on the first
start) against the budget with 8 % headroom: a discrete card too small for the weights is 'partial'
if RAM + VRAM can hold them, else 'too_large'; unified and cpu are 'gpu'/'cpu' or 'too_large'.
'too_large' offers "Choose a smaller model" (AI Model). Pills: On GPU / Partly on GPU / On
processor / Too large / Not measured. Phase 2 (not built): the context-cache estimate from the GGUF
header, and a VRAM-aware ★ picker (today's picker is RAM-best-fit).

**Models on this computer** (a card between the observed rows and the other computers; 2026-09-05,
owner direction, placed BELOW "Observed while you worked" because what the machine actually did
outranks what it could hold): the card is shared and the processor's RAM is shared, so the screen lists EVERY model
the app can hold, one row per role (`PerformanceSnapshot.placement.models`, `ResidentModelRow`):
chat and translation auto-fit onto the card (`device: 'gpu'`; `'cpu'` on a machine without a
usable card), images / document search (reranker + embedder) / voice are pinned to the processor
by design (`--device none`, see vision/runtime.ts, embeddings/e5.ts, reranker/llama.ts; whisper is
a CLI) and say so. Lifetime: chat / reranker / embedder stay for the session, translation and
vision unload after their idle window, whisper runs only while transcribing. Liveness comes from
each service's own handle (`isLoaded()` on `E5Embedder`, `LlamaReranker`, `VisionRuntime` /
`VisionService`; `Translator.deviceStatus().live`; `runtime.active()` for chat); the translation
row carries its observed layer split when live. Two summary lines: the card (chat + translation
sizes against VRAM, with the START-ORDER warning when both are resident: whichever started second
got the leftovers and runs slower; stop and start it once the other has unloaded) and the
processor (everything loadable at once against RAM, "Too much at once" when it exceeds it). What
the app should DO about the start-order contention (force translation to the processor while chat
holds the card, or reclaim the card when translation goes idle) is an owner decision (§5 item 21
(g)).

2. **Observed while you worked**: figures from real use, session-only, never persisted: the last
   finished answer (the #290 `chat:speed` payload, latched by `setAnswerSpeedObserver` in
   `chat-stream.ts` with the model that produced it), the last model start (the `model_load`
   read sample: bytes, elapsed, MB/s; falls back to the persisted sample), the last full file
   check (the `checksum` sample). `read-speed.ts` keeps an unranked newest-per-source latch for
   this (`latestEffectiveReadBySource`); the ranked `latestEffectiveRead` is unchanged.
3. **Other computers this drive has been used on**: the history minus this machine, newest
   first, each with its speed/model, CPU/RAM/date and rating pills ("Slow drive" under 100 MB/s).

**Data path**: one IPC read, `performance:get` → `PerformanceSnapshot` (`buildPerformanceSnapshot`
in `registerBenchmarkIpc.ts`): `current`, `currentMachine`, `currentGpu`, `otherMachines`,
`running` (the `benchmark` occupancy lane), `placement` (memory class, RAM/VRAM, the active
model, the observed placement, the verdict, the per-role `models` rows, `totals`), `observed`. **Progress**: `RunBenchmarkDeps.onProgress` reports
`'system' | 'drive' | 'speed' | 'done'` as each step lands ('speed' only when a runtime was up);
the IPC handler forwards them to the requesting window as `benchmark:progress`, and the screen
shows a step list instead of an opaque "Running…" button. The first-run path passes no callback.

## Perf marks (opt-in, `HILBERTRAUM_PERF_LOG=1`)

`src/main/services/perf.ts` writes an opt-in timing log for measurement runs: set the
environment variable `HILBERTRAUM_PERF_LOG=1` before launch (a launcher or terminal
decision, never a setting) and the app appends one line per mark to `logs/perf.log`,
beside `app.log`. With the variable unset (the default for every normal user) each mark
is a no-op and no `perf.log` is ever created.

This exists because the felt costs of a slow drive are otherwise invisible: the
model-checksum hash (`computeInstallState`, minutes on a cold cache from USB), the
llama-server spawn-to-healthy span, and time to first token appear nowhere in `app.log`,
and on an encrypted workspace the diagnostics log buffers in memory, which makes it
unusable for timing a packaged Windows launch. `docs/model-benchmarks.md` §11.4 lists
cold-load time as a still-unrecorded datum; these marks are how it gets recorded.

Line format: `<ISO-8601 wall clock> <monotonic ms since process start> <event> <json>`.
The wall-clock column correlates with timestamps written outside the process (for
example a launcher stamp file); the monotonic column gives clean intra-process deltas.

Events: `app_ready`, `backend_init_done`, `window_ready_to_show`, `gate_visible` (the
one renderer mark, allowlisted at the IPC boundary), `vault_unlocked` (kdf / decrypt
split + DB bytes), `unlock_done`, `vault_lock_done` (checkpoint / encrypt / shred
split), `install_state_done` (with `cacheHit`, separating a real multi-GB hash from a
size+mtime cache hit), `checksum_start` / `checksum_done` (issue #106: one pair per
REAL full-file hash wherever it runs — the cached model-weight path and the download
verify alike — with a shared `seq` to pair interleaved hashes, `{modelId, file:
weight|mmproj|download}`, bytes, ms, ok; each real hash also writes one plain `app.log`
line, visible without the perf log), `sidecar_healthy`, `runtime_selected`,
`model_prefetch` (issue #114: one mark per event of the concurrent weight prefetch riding
the load window — `started`/`skipped`, then the settle outcome `done`/`aborted`/`failed`;
`started` → settle times the window), `runtime_ready`, `first_token`, `stream_done`,
`embedder_selected`, `drive_benchmark`,
and the `ingest_*` phase marks (`start`, `copy_done`, `parse_done`, `chunks_committed`,
`embed_done`, `indexed`).

Content rule, stricter than `app.log`: a mark carries only phase names, model and
backend ids, byte counts, and millisecond durations. Never file names, paths of user
files, document titles, or chat text; documents appear only as their random UUID. That
is why the file may rest in plaintext even on an encrypted workspace.
