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
   **injects** the summary into `runBenchmark` (`RunBenchmarkDeps.gpu: { name, useful, totalMb }`
   — `name` and `totalMb` describe ONE device, the one `displayDevice` in `shared/gpu-rules.ts`
   selects: the first useful discrete device, else the first listed; `useful` is
   `gpuUsefulForProfile` over ALL devices, unchanged by the PR #303 audit — owner decision G4).
   `benchmark.ts` itself keeps its **zero-`child_process` purity** — it never probes. The probe
   result is also persisted to `settings.gpuProbe` for Diagnostics, **stamped with `machineKey`**
   since the PR #303 audit (M8.3, owner decision G3): a probe stamped with another machine's key
   supplies nothing to the Performance screen (a drive moved to a machine whose probe cannot run
   — no binary for that OS — used to keep the previous machine's devices as if they were local:
   they decided the memory class, the VRAM budget and the graphics tile there); an UNSTAMPED
   probe from an older build stays eligible, unverifiable until a successful local refresh
   replaces it, and is never re-stamped. Write rules (`probeAndPersistGpu`): no binary or a
   rejecting probe writes nothing; a probe that resolves — an empty list included, which is the
   probe's own "nothing usable" answer — replaces the old result with the current stamped one and
   pushes `performance:changed`; the key and the workspace session epoch are captured before the
   probe and admission is re-checked after it (the AUD-03 seam `startModelRuntime` uses), so a
   probe that outlives a lock, or a lock and a re-unlock, never writes. With no binary / no
   devices / a failed probe, `gpu` stays `null` and nothing blocks. The persisted probe is
   additionally refreshed **once per session** in the background (even when a benchmark already
   exists), so a drive moved to another machine re-labels itself; Diagnostics' "Try GPU again"
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

**Schemas and legacy records (PR #303 audit, H1/L8, owner decision G7).** `lastBenchmark`,
`benchmarkHistory` and `modelPlacements` are JSON rows: they used to be parsed straight over the
defaults, and the write gate checked only the TOP-LEVEL shape, so `{}` was an accepted history
entry — it reached the startup fingerprinting, `maybeRunFirstBenchmark`, the #107 start-estimate
memo, Diagnostics and the Performance screen, where the number formatter threw and blanked the
screen. The pure validators now live in `shared/benchmark-schema.ts` (importable by main AND
renderer, so both agree on what a trustworthy record is) and run on WRITE (`updateSettings`) and
on READ (`getSettings`) — the read repairs in memory only and never rewrites the DB, so a row from
an older build, a hand-edited workspace or a half-written blob can never crash a reader.
`machineKey` moved into that module for the same reason (`services/performance.ts` re-exports it).

- **Rejected**: anything that is not a plain object, and any object that carries neither a
  parseable `ranAt` nor a real `HardwareProfile` — it says nothing about any machine. A placement
  missing its `modelId` / backend / positive `contextTokens` / parseable `at`, filed under another
  model's id, or claiming more GPU layers than total layers, goes the same way.
- **Repaired, not rejected**: a figure that cannot be trusted becomes `null`; a malformed identity
  becomes the unknown one, so `machineKey` returns `null` rather than half a key; an unrecognised
  `profile` on a DATED record reads as `UNKNOWN` rather than discarding a real run.
- **Legacy shapes that survive**: the `{ profile: 'BALANCED' }` blob an old workspace can still
  hold stays a valid `lastBenchmark` with an unknown identity (G3: it keeps counting as "this
  machine", never earns a history entry, never acquires a fabricated key) and an unknown DATE —
  `ranAt` is the empty string, never a fabricated "now", and readers print "unknown" for it
  (Diagnostics "Last run", the Performance screen's date formatters). A complete older result
  keeps its ABSENT optional fields absent (`gpuVramMb`, `speedBasis`, `measuredModelId`,
  `effectiveRead`): the screens read absence as "approximate" / "not recorded", so a fabricated
  `null` would change what the copy claims.
- **The history** additionally drops UNKEYED entries (they could never be matched again), keeps
  one record per machine (newest `ranAt`), orders newest first and caps at
  `MAX_BENCHMARK_HISTORY`. On write, garbage is ignored rather than stored: a `lastBenchmark`
  that normalizes to nothing leaves the previous result standing.

The screen's formatters are defensive anyway (a missing figure renders as the tiles' unknown dash
instead of throwing): validation is the fix, but a data path must never be one bad row away from a
blank page.

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
gate accepts an array of VALID results only (junk and unkeyed elements dropped, one record per
machine, newest first, length capped; the 256 KB serialized cap applies to the list) — see
"Schemas and legacy records" above.

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
   window, plus CPU), Graphics memory (`BenchmarkResult.gpuVramMb` with `gpu`: ONE device's
   memory and name, recorded at benchmark time so the history rows carry it too — the device
   `displayDevice` selects. The rating is the shared `isUsefulDevice` rule of
   `shared/gpu-rules.ts` — the same 6 GiB + not-integrated gate the profile bump and the memory
   class use, never the memory figure alone (PR #303 audit M8.1): "Usable" for a useful discrete
   card, "Small" for a discrete card under 6 GiB with the plain consequence "models run on the
   processor", "Integrated" for an integrated device — its figure shown as "GB shared" with the
   copy "integrated, shared memory: models run on the processor", never blamed on size — and
   "None" without a device. For the computer the app is on, the ELIGIBLE probe's device
   (`PerformanceSnapshot.currentGpu`, with its `useful` flag) is the freshest truth and wins; a
   result persisted before the field existed, or whose probe came back empty, gets that device
   folded in by `buildPerformanceSnapshot` — name AND memory together, never an old iGPU name
   with a dGPU's figure — for the current machine only, and an already-mixed older row (an iGPU
   name and figure recorded by the old `devices[0]` rule) is replaced by the next local check.
   The screen never reads the raw `settings.gpuProbe`: it could be another machine's (M8.3). A
   result from ANOTHER computer that predates the field says "Not recorded" — the app never
   probed that machine for it (N1) — while an explicit `null` is a recorded "None"; its
   other-computers row lists VRAM only for a usable card), Drive (`effectiveRead` with its source and date; "Pending" until a model start
   **or a full file check** measured it — both produce a sample, so the empty state credits
   both, PR #303 audit N4). Actions: **Check again** (or **Start \<model\> and measure** when speed is unmeasured,
   the recommended model is installed and nothing runs: `useModel` then `runBenchmark`), **Change
   context size** (opens AI Model, the one place the context is set), **Copy report**. A "Why this
   model?" link to AI Model was tried and dropped (2026-09-05, owner: it led nowhere useful). A
   result measured on another computer says so.

**Speed provenance travels with the figure** (PR #303 audit L6): a decode figure is never shown
without HOW it was measured, on every surface, not just the Speed tile. `BenchmarkResult.speedBasis`
(#291) decides: `basis: 'timings'` is the runtime's own decode window and is named as such ("over
N tokens" — `diag.bench.tokensOver`, the wording Diagnostics already uses); `basis: 'chunks'` and
an ABSENT basis (every result persisted before the field existed, all of them chunk-based) are
marked with the tile's own qualifier, "Approximate: counted chunks, not runtime timings", plus
"N chunks" when the record carries the window. A legacy result with no basis gets NO window — the
app never invents one. Two consequences beyond the tile: the **Copy report** carries the qualifier
in the Speed line and heads itself "This computer" only when `snapshot.currentMachine` — otherwise
"Another computer: \<cpu\>, \<ram\> GB RAM", because the report is pasted into a support message
where the old heading misattributed every figure under it; and an **other-computer row** whose
figure is approximate is rated with the neutral "Approximate" pill (`perf.rating.approx`, neutral
tone) instead of Good/Slow, with the qualifier appended to its sub line. Good/Slow is a claim
about the machine, and a chunk count over wall time (prefill included) cannot support one.
`speedIsApprox` / `speedBasisNote` in `PerformanceScreen.tsx` are the single source for all three.
**Your model** (a row under the tiles; 2026-09-05, owner direction): whether the ACTIVE model fits
is not a property of RAM or of VRAM alone, so neither tile says it. The row names the model, its
size on disk and the context it launches with, then gives one verdict against this computer's
**memory class** (`memoryClassOf` in `services/performance.ts`): `discrete` = a usable graphics
card (the runtime's own 6 GiB, not-integrated gate) whose VRAM is the budget; `unified` = Apple
Silicon (darwin + arm64), one pool shared by CPU and GPU, budget = Metal's
`recommendedMaxWorkingSetSize` when the load log printed it, else 75 % of RAM (the Memory tile is
labelled "Unified memory" and the graphics tile is hidden); `cpu` = no usable card, budget = RAM.
**One eligible source** (PR #303 audit M8, owner decisions G3/G4): the class, the VRAM budget
(`placement.vramMb`), the device the copy names and the observed free/working figures all come
from the ELIGIBLE `settings.gpuProbe` (`eligibleGpuProbe` in `shared/gpu-rules.ts`: stamped with
this machine's key, or unstamped; a probe stamped elsewhere supplies nothing — the class comes
from `memoryClassOf(platform, arch, [])`, so `cpu` or `unified`, with no budget, no `currentGpu`
and no fold-in) and, of it, ONE device: `primaryUsefulDevice`, the first useful discrete one — on
a hybrid `[iGPU, dGPU]` box the dGPU, where `devices[0]` used to hand the class to the dGPU but
the budget and the name to the iGPU. An integrated-only box has no VRAM budget at all (its shared
figure is not the card's own). `memoryClassOf` itself and the hardware-profile bump
(`gpuUsefulForProfile`) are unchanged — as is the runtime, which still never passes `-ngl` and
lets `--fit` decide. The same `displayDevice` rule also NAMES a GPU start
(`RuntimeStatus.gpuName`, set in `runtime/factory.ts` — the Chat runtime hint) and the
Diagnostics "Acceleration" line's "\<name\> (GPU available)"; both took `devices[0]`, so a hybrid
box credited the iGPU for work the dGPU did. Label only: rung selection, `--fit` and the "never
-ngl" policy are untouched, and nothing that ENUMERATES the probe's devices is filtered.
**Configured execution (DR1)**: the verdict is asked for the EFFECTIVE
class — `cpu` when `gpuMode: 'off'` or `gpuAutoDisabled` forces the processor, or when the
matching observed start landed on the CPU backend — so the estimate reads "Will run on the
processor from RAM", never "Should fit in graphics memory" for a card the start would not use;
the snapshot's `memoryClass` stays the hardware class (the tiles describe the machine).
**Free/compute attribution (DR2)**: the parser keeps every GPU row of the `device_info` block
with the compute buffer reserved on it (`ModelPlacement.devices`, label ↔ name, filed by label),
and `attributedGpuFigures` takes `freeAtStartMb` / `workingMb` from the row whose name is the
selected device's — a lone row, or a record persisted before the rows existed, attributes as
before (the first row's free figure, the summed compute); when the selected device is not in the
log both stay null and the copy falls back to the plain partial-offload sentence, never
explaining a dGPU's spill with the iGPU's free memory.
**The context it launches with** is resolved main-side by the launch path's own helper,
`launchContextTokens(settings, manifest)` — the user's `contextTokensOverride`, else the manifest's
`recommended_context_tokens` when it states one, else `settings.contextTokens`. The screen used to
recompute it with `??`, which differs in one real case: a manifest whose window is missing or `0`
(the parser returns `0`) showed a "0-token context" while the runtime starts that very model on
the settings default (PR #303 audit, M5 residual). The snapshot carries the resolved figure for
the ACTIVE model (`placement.model.contextTokens`) and for the RECOMMENDED one
(`placement.recommendedContextTokens`), so the screen and the Copy report never recompute either.

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
only for the active model and only when the record's machine is this one. **Measured evidence must
match the configuration** (PR #303 audit): a placement measures ONE start — this model, this
machine, with a specific context and on a specific backend — so it counts as OBSERVED only while
its `contextTokens` equal the context the model would launch with now AND its backend agrees with
the configured execution (`gpuMode: 'off'` or `gpuAutoDisabled` admits a `cpu` record only;
`'auto'` admits either, because the ladder decides per start). On a mismatch the record is KEPT in
settings (the next matching start restores it, and it is still the truth about that start), the
row falls back to the weights-only ESTIMATE — which is what the current settings would actually do
— and the snapshot carries `placement.observedMismatch` so the copy can date the earlier
measurement ("Measured earlier with a {context}-token context on {when}; the estimate above is for
the current settings.") instead of presenting a fit the settings never asked for. **Verdict**
(`placementVerdict`, pure): observed → 'gpu' when every layer is on the GPU (unified reads the
same), 'partial' otherwise with the CPU-side bytes as the spill (CPU, CPU_Mapped and the
backends' `*_Host` buffers), 'cpu' for a CPU backend, 'unknown' for a GPU start whose log carried
no offload line (never a guess); the size shown is weights + context cache as measured. A
partial offload on a card that would hold the model is the normal `--fit` outcome when the card
was not empty at start: the parser also reads the `device_info` "N MiB free" figure
(`gpuFreeAtStartMb`), and, with the `sched_reserve` compute-buffer line (`gpuComputeMb`), the copy tells the two
cases apart: a card that was NOT free at start ("only N GB was free, restart once the card is
free") versus a card that WAS free, where the fit's own reservations are the reason (model +
cache + working buffers + the fixed `--fit-target` margin came within a whole layer of the
free memory, and the fit moves whole layers, ~430 MB each on a 27B). **Both figures behind that
split are NAMED CONSTANTS in `shared/performance-rules.ts`** (PR #303 audit DR4):
`FIT_TARGET_MARGIN_MB = 1024`, llama.cpp's `--fit-target` default which the app does not
override, interpolated into all three partial-offload sentences as `{margin}` GB instead of the
literal "1 GB" they used to hard-code; and `CARD_FREE_SLACK_MB = 1536`, how much of the card may
already be in use and still count as "free at start" (it was a renderer-local literal beside the
hard-coded margin). Change either constant and the copy follows. Whether the app should
trade that margin for a full offload is an owner decision (BUILD_STATE §5 item 21 (f)). Units: every size on the
screen is GiB (RAM, VRAM, the buffers), so the manifest's decimal "size on disk" is converted
once in the snapshot (19.8 GB → 18.4). Before the first start → an ESTIMATE from the
weights alone (the file size; the copy says so and that the context cache is measured on the first
start) against the budget with 8 % headroom: a discrete card too small for the weights is 'partial'
if RAM + VRAM can hold them, else 'too_large'; unified and cpu are 'gpu'/'cpu' or 'too_large'.
'too_large' offers "Choose a smaller model" (AI Model). Pills: On GPU / Partly on GPU / On
processor / Too large / Not measured. Phase 2 (not built): the context-cache estimate from the GGUF
header, and a VRAM-aware ★ picker (today's picker is RAM-best-fit).

**Where the measurement lives, in the copy** (PR #303 audit L8 and owner gate (c)). A placement
record is per model id in the DRIVE's settings (`settings.modelPlacements`) and is read back only
on the machine that wrote it, so the row says so rather than leaving the user to infer it: the
estimate reads "Where the model lands is measured the first time it starts **on this computer**"
(`perf.model.unknown`), and under any estimate a hint adds the drive rule once —
"The drive keeps one record per model, so a start on another computer replaces the one measured
here" (`perf.model.perDrive`; suppressed when `observedMismatch` is set, because that note says
something more specific about the same record). The two 'unknown' states are no longer one
sentence: an ESTIMATE unknown keeps the first-start wording, while an OBSERVED unknown
(`estimated: false` — the start happened and the log said nothing) reads "The runtime did not
report where the model landed" (`perf.model.unknownObserved`), since telling a user to start the
model when they already did invites a restart that changes nothing. The 'gpu' branch renders the
layer count only when it has one (`totalLayers == null` → the estimate wording), so no state can
render "all {layers} layers on the GPU" with nothing where the count belongs.

**Models on this computer** (a card between the observed rows and the other computers; 2026-09-05,
owner direction, placed BELOW "Observed while you worked" because what the machine actually did
outranks what it could hold): the card is shared and the processor's RAM is shared, so the screen lists EVERY model
the app can hold, one row per role (`PerformanceSnapshot.placement.models`, `ResidentModelRow`):
chat and translation auto-fit onto the card (`device: 'gpu'`) — under the CURRENT configuration
(PR #303 audit DR1; the memory class alone used to decide): the row says `'cpu'` on a machine
without a usable card, when the GPU is switched off (`gpuMode: 'off'`) or auto-disabled, when the
chat's matching observed start landed on the CPU backend, or when the translation sidecar's
posture is the forced `--device none` (`deviceStatus().device === 'cpu'`, its session fallback
latch); the copy then says "processor", not "processor, by design" — images / document search
(reranker + embedder) / voice are pinned to the processor
by design (`--device none`, see vision/runtime.ts, embeddings/e5.ts, reranker/llama.ts; whisper is
a CLI) and say so. Lifetime: chat / reranker / embedder stay for the session, translation and
vision unload after their idle window, whisper runs only while transcribing. Liveness comes from
each service's own handle (`isLoaded()` on `E5Embedder`, `LlamaReranker`, `VisionRuntime` /
`VisionService`; `Translator.deviceStatus().live`; for chat the runtime STATE —
`RuntimeManager.status()` running + healthy + no start in flight + the active model, never
`active() != null` or the placement latch, which is recorded before the #109 warm-up finishes
(PR #303 audit DR6: a loading model reads "not loaded" until it is ready)); the translation
row carries its observed layer split when live. Two summary lines: the card (chat + translation
sizes against VRAM, shown only while a row actually goes to the card, with the START-ORDER
warning when both are resident on it — `bothOnCard` needs both rows to say `'gpu'`, the active
chat model resident with its observed start on the GPU and at least one layer offloaded (or no
observation under a GPU-eligible configuration), and the translation sidecar live with layers on
the card; a live sidecar at 0 offloaded layers, or a chat observed on the CPU, is not "both":
whichever started second got the leftovers and runs slower; stop and start it once the other has
unloaded) and the processor: everything loadable at once against RAM, **class-aware since the PR
#303 audit (DR5, owner ruling; `loadedAtOnceMb` in `services/performance.ts`)** — on the `cpu`
class every row's size; on `discrete` the rows that run on the processor plus the active model's
OBSERVED partial-offload spill (the CPU-side model + cache bytes of a measured partial start; an
estimate, a full offload or an unknown split add 0) plus the live translation sidecar's spill
(size × the share of layers off the card; not live or all on the card → 0), so card-resident
weights are no longer counted against RAM; on `unified` the full sum, with the copy saying
"memory" and the "Fits" / "Too much at once" pill comparing against the unified budget rather
than RAM. What
the app should DO about the start-order contention (force translation to the processor while chat
holds the card, or reclaim the card when translation goes idle) is an owner decision (§5 item 21
(g)).

2. **Observed while you worked**: figures from real use — SESSION latches only (PR #303 audit
   M3, owner decision G2), where "session" is the **main-process lifetime**: the latches survive
   a workspace lock/unlock and are cleared by an app restart, nothing else. The rows: the last
   finished answer (the #290 `chat:speed` payload, latched by the `setAnswerSpeedObserver`
   wiring — `observeAnswerSpeed` in `registerBenchmarkIpc.ts` — with the model that produced
   it; a local-API answer does not pass through the chat observer and never latches), the last
   model start (the newest `model_load` read sample: bytes, elapsed, MB/s), the last full file
   check (the newest `checksum` sample). `read-speed.ts` keeps an unranked newest-per-source
   latch for this (`latestEffectiveReadBySource`); the ranked `latestEffectiveRead` is
   unchanged. The rows never fall back to a persisted sample — not a foreign one and not this
   machine's own weeks-old one: the answer figures are never persisted at all, and the read
   samples persist SEPARATELY into the benchmark records (`effectiveRead` on `lastBenchmark`
   and this machine's history entry, `persistEffectiveRead`; that persistence is unchanged by
   the push model) where the Drive tile shows them with their own source and date. The
   observed rows are presentation-only latches on top of that — and the card's hint copy says
   exactly that split (PR #303 audit L8), so "these rows last for this session" is never read as
   "none of this is kept": only the answer figure and the latches are session-only.
3. **Other computers this drive has been used on**: the history minus this machine, newest
   first, each with its speed/model, CPU/RAM/date and rating pills ("Slow drive" under 100 MB/s;
   the speed pill is Good/Slow only for a runtime-timings figure — see "Speed provenance travels
   with the figure" above — and the neutral "Approximate" otherwise).

**Data path**: one IPC read, `performance:get` → `PerformanceSnapshot` (`buildPerformanceSnapshot`
in `registerBenchmarkIpc.ts`): `current`, `currentMachine`, `currentGpu` (`{ name, totalMb,
useful } | null` — the eligible probe's display device, one device's name and memory),
`otherMachines`,
`running` (the `benchmark` occupancy span read directly, `occupancy.held('benchmark')` — not
through `modelBusyLane`, which answers "chat" first and hid a held span behind a permitted
foreground answer, PR #303 audit M1), `placement` (memory class, RAM/VRAM, the active model, the
observed placement, the verdict, the per-role `models` rows, `totals`), `observed`. The read is
a getter: it never emits anything.

**Push, not poll** (PR #303 audit, owner decision G6): the screen re-reads the snapshot when the
main process sends the payload-free **`performance:changed`** (`EVENTS.performanceChanged`,
preload `api.onPerformanceChanged`) to every live window — `notifyPerformanceChanged()` in
`ipc/performance-notify.ts`, each send isolated so a destroyed window or a throwing recipient
never blocks the next one, the persist that triggered it, or startup. No interval polling. It is
emitted only AFTER a mutation, by these sites: a benchmark run taking its occupancy span
(`running` → true: the screen learns about a run it did not start — the first-run benchmark,
the moved-drive re-benchmark, a run pressed in another window) and again in the run's `finally`
after BOTH the persist and the release, on success and on failure (a run REFUSED as busy emits
nothing — the span it saw belongs to the running benchmark, whose own release announces the
idle state); every accepted read-speed sample, including a lower-ranked per-source one (a
checksum after a model load updates the checksum row while the ranked latch and the persisted
sample stay the model load — `read-speed.ts` fires its observer for every accepted sample, and
the persister applies the ranking per destination); a retry persist that actually wrote; the
answer latch; a placement observation (after its persist, or after the skipped persist while
locked); the moved-drive restore, the upgrade seed and the new-machine backfill in
`maybeRunFirstBenchmark`; a completed GPU probe write (`probeAndPersistGpu`, incl. an empty
device list, so "Try GPU again" pushes through it); the chat runtime's transitions
(`RuntimeManager.onChange` — starting, ready, stopped, subscribed in `initBackend`);
resident-sidecar transitions for the "Models on this computer" rows (`onResidencyChange` on
`E5Embedder`, `LlamaReranker`, `TranslationRuntime`, `VisionRuntime` forwarded by
`VisionService`: lazy start landed, idle teardown, suspend/stop, unexpected exit — the services
stay Electron-free, the subscriptions live in `initBackend`); and the settings keys the snapshot
reads when they change through `models:select` / `models:use` or `settings:update`
(`PERFORMANCE_SETTINGS_KEYS`: the active slots, `contextTokens`, `contextTokensOverride`,
`gpuMode` — not every settings write). No coalescing main-side; the renderer serialises its
refetches.

**The screen's half of that contract** (`PerformanceScreen.tsx`): it subscribes to
`onPerformanceChanged` BEFORE issuing the first `performance:get`, and unsubscribes on unmount
(one registration per mount). Reads are serialised behind one flag — a push that lands while a
read is out raises a "wanted" flag and buys exactly ONE more pass when that read settles, so a
burst of pushes costs a single extra read and no push is dropped — and every issued read carries
a generation stamp: only the newest may apply its reply (the snapshot, and the `getRuntimeStatus`
/ `getSettings` metadata each pass re-reads alongside it), and unmount bumps the stamp so a late
reply touches nothing. `listModels` stays MOUNT-ONLY (a display-name lookup; the screen remounts
on navigation). Two states, never merged: the snapshot's `running` is assigned verbatim from each
read, and a separate local flag covers the action THIS window started — the card reads busy when
either is set, and the action's `finally` clears only its own flag, so a run that still holds the
lane keeps the screen busy while a foreign run's terminal push releases it. `'done'` triggers a
re-read but never sets idle. A failed read keeps the last snapshot on screen, adds
`perf.loadFailed` to the banner with a `perf.retry` button, and is cleared by the next successful
read; a failed action's `perf.failed` line stands until the user starts another one, so neither
failure can hide the other.

**Progress** (honest step semantics, PR #303 audit L3): `RunBenchmarkDeps.onProgress` reports a
step only when it SUCCEEDED — `'system'` always; `'drive'` only when the write/fsync probe
produced figures (a failed probe reports nothing, the result carries `warnDriveProbe`);
`'speed'` only when a tokens/sec reading was actually obtained (not when no runtime was up, not
when the leg was skipped as busy — `warnSpeedSkipped` — and not when the probe failed);
`'done'` always. A later step never implies an omitted earlier one succeeded. `'done'` means
the PROBES are complete: it precedes the persist and the occupancy release, so it is not the
idle signal — the terminal `performance:changed` after both is. The IPC handler forwards the
steps to the requesting window only, as `benchmark:progress`, and the screen shows a step
list instead of an opaque "Running…" button. The first-run path passes no callback. The drive
step is labelled **"Drive speed"**, not "Drive write speed" (PR #303 audit N5): the step's write
probe is one input, and the tile the user reads next to it reports MB/s *read* — naming the step
after the write leg contradicted the figure it leads to.


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
