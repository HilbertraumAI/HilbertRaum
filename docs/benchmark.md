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
   (`services/runtime/gpu.ts` — an offline subprocess, kill-timeout-bounded, never throws; every
   failure resolves `[]`, but a probe that hits the bound answers `null` (unknown) and is neither
   cached nor persisted, #380) and
   **injects** the summary into `runBenchmark` (`RunBenchmarkDeps.gpu: { name, useful, totalMb,
   budgetMb, memoryClass }` — `name`, `totalMb` and `budgetMb` describe ONE device, the BUDGET
   device `nextStartMemory` selects for the next start (the largest usable card by the
   `shared/gpu-rules.ts` rule, see "Which card" below; null with no usable card or the GPU
   switched off); `useful` is
   `gpuUsefulForProfile` over ALL devices, unchanged by the PR #303 audit — owner decision G4).
   `benchmark.ts` itself keeps its **zero-`child_process` purity** — it never probes. The probe
   result is also persisted to `settings.gpuProbe` for Diagnostics, **stamped with `machineKey`**
   since the PR #303 audit (M8.3, owner decision G3): a probe stamped with another machine's key
   supplies nothing to the Performance screen, the Models ★ or the benchmark (a drive moved to a
   machine whose probe cannot run — no binary for that OS — used to keep the previous machine's
   devices as if they were local: they decided the memory class, the VRAM budget and the graphics
   tile there); an UNSTAMPED probe from an older build stays eligible, unverifiable until a
   successful local refresh replaces it, and is never re-stamped. Write rules
   (`probeAndPersistGpu`, the two audits merged): every path that reaches the write persists
   THIS session's stamped answer — a probe that resolves (an empty list included, which is the
   probe's own "nothing usable" answer), a probe that cannot run (no binary) and a probe that
   threw alike persist `{ devices, probedAt, machineKey }` and push `performance:changed` (PR #308
   audit decision 6: a card recorded on a previous session of the SAME machine never outlives a
   refresh that could not see it, so the Models badge, the benchmark and the tile agree; an empty
   stamped result re-stamps no old device, so #303's "never re-stamp old devices as local" holds
   either way, and the foreign-machine case is covered by the stamp). **The one exception (#380,
   2026-09-08):** a probe that TIMED OUT is not an answer but the absence of one, so it writes
   nothing and pushes nothing — the stored stamped probe stands until the next start, the next
   check or "Try GPU again" — and the summary injected into that run is built from what this
   machine already has on record (`eligibleDevicesFor`), so decision 6's real requirement (the ★,
   the benchmark's `gpu` and the tile agree) still holds. Persisting the empty stamped probe there
   was exactly the #330 failure: the driver was busy with the weight upload, and a card machine
   was recorded as having none. The key and the workspace
   session epoch are captured before the probe and admission is re-checked after it, for every
   path (the AUD-03 seam `startModelRuntime` uses), so a probe that outlives a lock, or a lock and
   a re-unlock, never writes. With no binary / no devices / a failed probe, `gpu` stays `null`
   and nothing blocks. The persisted probe is additionally refreshed **once per session** in the
   background (even when a benchmark already exists — `prepareFirstBenchmark`, the cheap half of
   the first-run benchmark, fires it, and the auto-start waits for it (#380, 2026-09-08), PR #303
   P7), so a drive moved to another machine re-labels itself; Diagnostics' "Try GPU again"
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
   must not dominate the window), a start of a weight hashed anywhere in this session records no
   load sample (#392, 2026-09-08) — the start's own install-state pass, a Models-screen verify or
   a background hash all warm the page cache, so the window would read RAM; the #114 prefetch skip
   stays tied to the start's own hash only — and the download
   verify never samples (it reads bytes the app just wrote). A start right after an **in-app
   download** therefore records no read sample at all: the verify is excluded by design and the
   page-cache-warm load after it is dropped too (#392) — honest absence rather than a wrong figure,
   and the next cold start records the medium. The #392 guard is process-scoped and **does not
   survive a relaunch**: the checksum store is persistent, so on the next launch nothing hashes,
   the warmed-path set is empty, and on a big-RAM machine a warm start records a `model_load`
   sample that overwrites the honest checksum figure (`preferCandidate` lets `model_load` beat a
   `checksum` incumbent unconditionally) — the figure oscillates with the cache's warmth until a
   cold start. The ranking-rule amendment that would fix it is issue **#404**.
   A fresh install has no sample yet —
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
   runtime is running. The automatic first-run / new-computer measurement is scheduled **behind
   the model auto-start** since PR #303 P7 ("History per machine" → "Scheduling behind the
   auto-start"), so on a machine with an active model it measures the freshly started runtime;
   before, it ran ahead of the start and always skipped this leg. **What the number is (since
   #291):** llama-server's own
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
  device has **≥ 5 GiB** (`GPU_BUMP_MIN_VRAM_MB = 5120` — 6,144 until the 2026-09-07 decision on
  #321 brought it down so the common 6 GB laptop card, which Vulkan reports at 5,7xx–5,9xx MiB,
  counts; `model-benchmarks.md` §6.6 N8) **and** does not look integrated
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

**The primary picker is memory-best-fit, not profile lookup.** `runBenchmark` and `listModels`
both call `recommendChatModelId(manifests, { memoryClass, ramGb: round(ramGb), budgetMb },
speedSignal)` (model-benchmarks.md §6.6 rule C, **2026-09-06 amendment, PR #308 audit**): on a
computer with a usable **discrete card** the pick is the best model that FITS THE CARD
(`recommendModelIdByVram`: the RAM pick stands wherever it also fits the card; otherwise the
fittest eligible model by rank, then RAM tier, then size) — "fits" means `(weights − the measured
host-mapped share) × 1.15 + the
model's own context-cache estimate (a per-model manifest field, default 0.5 GiB) + the fit's
1 GiB margin ≤ the budget device's FREE memory` (the probe's free figure, else its total minus
1,024 MiB), RAM always a hard gate. `budgetMb` comes from the **budget device**
(`selectBudgetDevice` / `nextStartMemory` in `services/performance.ts`: the largest probed card at
or above the runtime's own 5,120 MiB gate and not integrated by name — never the first device the
driver listed); on **unified memory** (Apple Silicon) and on a machine **without a usable card**
— including one with graphics acceleration switched off in Settings, or auto-disabled after a
crash — it is RAM-best-fit (`recommendModelIdByRam`: the largest model whose comfortable RAM
fits, ties on `recommendation_rank`). The profile-based `recommendModelId(manifests, profile,
'chat')` is only the **fallback** when RAM can't be detected (`ramGb = 0`). With the committed
manifests and RAM ample (32 GB), the live recommendations by card are 6 GB → `qwen3.5-4b-ud-q4kxl`,
8 GB → `qwen3.5-4b-ud-q4kxl`, 12–20 GB → `qwen3.5-9b-ud-q4kxl`, 24 GB → `qwen3.8-27b-ud-q4km`, 32 GB
and up → `qwen3.8-27b-ud-q5km` (§6.6's 30-point grid; the 6, 8, 12 and 24 GB points were verified
on real starts 2026-09-07 — issue #318, §6.6 "Hardware verification" — while the 20 GB point and the
Gemma 12B / MoE estimate bands remain predicted, no such card being available); by RAM:

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

**The Performance screen shows the LIVE recommendation (PR #308 audit decision 8, finding R4;
2026-09-06).** `BenchmarkResult.recommendedModelId` is what the check said at the time it ran and is
never rewritten, so a fresh GPU probe, a flipped GPU toggle or a new speed sample used to leave the
Performance verdict and its "Start … and measure" offer on a stale pick while the Models ★ had
already moved (audit A4: a same-machine result is never re-benchmarked). `buildPerformanceSnapshot`
therefore carries `PerformanceSnapshot.recommendation: { modelId, basis } | null`, computed by
`liveChatRecommendation(settings, manifests)` (registerModelIpc.ts) from the SAME inputs the
`listModels` handler feeds `buildModelList` — `pickerMemoryFor(s)` (class + budget), `machineRamGb()`
and `speedSignalFor(s)` (the persisted pairing; the handler calls the same function) — so the two
surfaces cannot diverge; `basis` is the memory class the pick was judged against (`discrete` = the
card's budget, `unified`, `cpu` = RAM). The screen's verdict sentence names that basis ("… is the
best fit for this computer's graphics memory / unified memory / RAM"); the saved
`recommendedModelId` stays visible only where it differs from the live pick, labelled "Recommended
at the time of the check" (also the Copy report's label). The Copy report additionally carries the
live pick on its own line, "Recommended for the next start: \<model\> (\<basis\>)", ahead of the
saved one, so a report compared with someone else's shows what the app would actually pick
(issue #325, 2026-09-06; omitted when `recommendation` is null). The context-size line follows that
live line in BOTH cases — this computer's record and another's — because it is the LIVE pick's
launch context; after the saved line it read as the saved pick's window. Under an "Another
computer: …" heading the live line additionally reads "Recommended for the next start **on this
computer**" (`perf.recommendation.nextOnThisComputer`), because both lines are THIS machine's and
unlabelled they read as the headline machine's (issue #381, 2026-09-08). `null` only without a
catalog — and `recommendedContextTokens` derives from the same live id, so "no live pick" and "no
context line" always travel together. A "recommendation changed since this check" note was
deliberately omitted (audit gate G4).

**Speed-signal step-down (issue #95, since 2026-08-09).** The picker optionally consumes the
persisted probe pairing (`tokensPerSecond` + `measuredModelId`): a probe strictly under
`SLOW_PICK_TOKENS_PER_SECOND = 5` tok/s, measured on a model whose `recommended_ram_gb` is at or
below the would-be pick's, steps the recommendation down ONE capacity tier (ranked models only,
never onto rank 0; with no lower ranked tier the pick keeps). An oversized loaded model crawling
is expected and never moves the pick. `runBenchmark` applies it with the just-measured values and
`listModels` with the persisted ones, so Diagnostics and the Models screen ★ always agree; when
the step fires, the persisted warnings gain `main.benchmark.warnRecommendationLowered` (canonical
English) naming the measured model and figure. Since issue #322 (2026-09-06, §6.5 "Sample
identity" amendment, owner-confirmed) the persisted sample also carries
`BenchmarkResult.speedIdentity` (the next-start class, the budget device, the launched context,
the backend at measurement time) and `speedSignalFor` consumes it only when the next start runs
on a path no faster than the measured one — the same card, or the processor after a card
measurement; never a card start after a processor measurement, a different card, or the mock;
the context is recorded, not matched; a legacy sample without the field steers as before. Full
design record: `model-benchmarks.md` §6.5.

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

### The media-bound checksum rule (§6, issue #404, 2026-09-08)

**§6.1 — what was wrong.** `preferCandidate` (`services/read-speed.ts`, one function, four call
sites through `effectiveReadOrPersisted`, `rankSamples` and `effectiveReadPatch`) let a
`model_load` sample beat a `checksum` incumbent unconditionally. On a warm relaunch nothing
hashes — the checksum store answers from `(size, mtime)` — so #392's warmed-path set is empty and
the auto-start's load window times the OS page cache. That page-cache figure then displaced the
honest checksum sample on both destinations and took the #110 slow-read warning with it, every
launch, for as long as the drive stayed slow (#334 leg B1: **589 MB/s persisted for a 28 MB/s
stick**).

**§6.2 — the fact the amendment rests on.** The rank existed because a checksum sample can be
hash-CPU-bound and under-report the medium — but only down to the SHA-256 floor, **measured at
~136 MB/s** ("Slow read", above). A checksum sample below `SLOW_READ_MBPS = 100` therefore cannot
be CPU-bound: the medium set that figure. Call such a sample **media-bound**.

**§6.3 — the rule as built.** Both halves, complementary rather than alternative:

1. A media-bound `checksum` candidate **may displace** a `model_load` incumbent. This repairs a
   machine that already carries a page-cache figure — one cold hash, or one "Check all model
   files" pass, corrects it.
2. Symmetrically, a `model_load` candidate **does not displace** a media-bound `checksum`
   incumbent. This is what stops the relaunch oscillation.

Strict `<`, matching `upsertSlowReadWarning` and the Performance screen's drive rating: a sample
at exactly 100 MB/s keeps the pre-#404 ranking in both directions. `preferCandidate` remains the
**single** ranking rule — no call site adds a second one — so the live latch, the two persisted
destinations and `eligiblePersistedSample` cannot disagree. Machine identity is still decided
before the ranking (G3 below); nothing here loosens that.

**§6.4 — accepted failure mode.** Move the drive to a FASTER USB port on the same machine and the
slow figure stands until something hashes again, because the port is not part of `machineKey`
(measured spread on one box: 28–133 MB/s by port, #334). Accepted **because it self-heals**: a
newer `checksum` sample still beats a `checksum` incumbent, and since #382 every new model pick
hashes at the start gate. The opposite failure — a fast port persisting an inflated figure over an
honest slow one — is the one that actually misled users, and half 1 closes it.

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
(`preferCandidate`: same-machine `model_load` beats `checksum` — unless that `checksum` is
media-bound, see "The media-bound checksum rule" below — else the newer sample). **G3:**
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
A sample is identified by its `at` throughout — the handled memo, each destination's "already
carries it" check, the ranking's tie order — so `read-speed.ts` stamps `at` **strictly increasing
per process**: a clock reading that repeats or runs backwards is bumped to the previous accepted
sample's `at` + 1 ms (A-D4; a model load landing in the same millisecond as the checksum before
it used to read as the same sample, and the memo dropped it).
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

**The moved-drive check** lives in `prepareFirstBenchmark` (`ipc/registerBenchmarkIpc.ts`), the
cheap half of the first-run benchmark, which runs after every unlock. If `lastBenchmark` exists
and its key differs from this machine's:

- a history entry for this machine is **restored** into `lastBenchmark` (so the ★ pick and the
  profile follow the machine, not the drive) and nothing is re-measured;
- with no entry, this is a first run on a new computer and the measurement is **owed**: it runs in
  the background exactly as on a fresh workspace — scheduled behind the model auto-start, see
  "Scheduling behind the auto-start" below.

Either way the per-session GPU probe refresh still happens first, and settles before the
auto-start begins (#380). The `benchmarkHistory` write
gate accepts an array of VALID results only (junk and unkeyed elements dropped, one record per
machine, newest first, length capped; the 256 KB serialized cap applies to the list) — see
"Schemas and legacy records" above.

**The user is told which of the two happened** (§5 item 22 (a), owner decision 2026-09-08). Both
branches used to be SILENT, and they are different facts that must not share a message: a restore
re-measures **nothing**, so the figures the user is about to read are as old as the restored
result; a new computer has a measurement already under way. `MovedDriveNotice`
(`benchmark:movedDriveNotice`) carries the distinction to Home:

| kind | set by | Home says | offers the check? |
|---|---|---|---|
| `restored` (+ the result's own `ranAt`) | the restore branch | the figures are from an earlier check on that date, nothing was measured just now | **yes** |
| `measuring` | an accepted `new-machine` decision | a check is running in the background | **no** — one is already under way |
| `owed` | that scheduling ending in anything but a run | this computer has not been checked yet | **yes** |

It is **session state, not settings**, and deliberately so: once a restore has happened,
`lastBenchmark` is this machine's and nothing persisted distinguishes "restored just now" from an
ordinary same-machine launch. The memo is keyed exactly like SD2's `attemptMemo` — the workspace
DB handle AND the unlock epoch — so a lock/unlock retires it and a new session decides afresh.
`runOnceSettled` moves `measuring` → `owed` on every terminal outcome that is not a run
(`skipped-busy`, `failed`, `skipped-admission`, …) and pushes `performance:changed` for it,
because the run's own idle push fires BEFORE the notice moves; `'deferred'` keeps `measuring`
(a continuation is still pending) and a persisted run clears the notice inside
`runAndPersistBenchmark`, so its existing push already carries the cleared state and no second
push is emitted. Any successful check clears it, which is what the notice's own action leads to.
A **`first-run` on a fresh workspace sets nothing**: that is not a moved drive, and "this drive has
not been used on this computer before" would be a lie about a workspace never used anywhere.

On Home the notice is an informational `Banner` (nothing is wrong — the drive moved), following
`runPreflight`'s precedent for a friendly non-blocking note, read once on mount and re-read on
`performance:changed` so an open Home corrects itself when the background check finishes. Its
action **navigates to Performance** rather than running the check from Home: every Home button
navigates ("Choose a model" opens AI Model rather than choosing one), and since item 22 (b)
Performance is the one place the check is started from. It reuses `perf.check` for its label.

**The readiness row is NOT part of this** (the other half of letter (a) — "This computer:
Balanced, about 12 tokens/s" — deferred deliberately, 2026-09-08). It would put a NUMBER on the
first screen that can be stale, absent, or from another computer: the exact defect class the PR
#303 audit spent M2/M4/A4 fixing on Performance, where the fix cost a provenance rule, a
same-machine gate and a heading that names the machine. Home has none of that scaffolding. Item 22
(c) also still carries an open residual about German rail label width at the 600 weight, so the
row would land on a surface whose sizing is not settled.

**Scheduling behind the auto-start (PR #303 audit L1 / SD2, owner decision G5).** The three
post-unlock seams (the plaintext startup in `main/index.ts`, unlock and create in
`registerWorkspaceIpc`) used to fire the first-run benchmark and `maybeAutoStartActiveModel`
back to back. A model start is not an occupancy lane, so the benchmark's 8 MiB write/fsync probe
contended with the start's multi-GB weight hash + load on the same drive, and `runtime.active()`
was captured before the drive probe, so a start that reached ready seconds later never got its
speed leg; the moved-drive check made that reachable on every unlock of a moved drive. The
first-run benchmark is therefore **two halves**, run in this order at every seam:

1. `prepareFirstBenchmark(ctx)` — synchronous, **before** the auto-start is even called: the
   AUD-02 admission guard, the session-epoch capture, the per-session GPU probe refresh, and the
   restore / same-machine seed / new-machine backfill writes with their `performance:changed`
   pushes — a known computer's profile and ★ pick come back promptly, before anything heavy
   starts. It returns a **decision**: `run: 'first-run' | 'new-machine' | null`, plus the epoch,
   this machine's key, and `probed` — the promise of the probe refresh it just fired (#380;
   already resolved when none was fired, and it never rejects).
2. **The probe settles** (#380, 2026-09-08). The seams gate the auto-start on `decision.probed`:
   about 1 s on an idle driver, nothing at all on a machine with no `llama-server` (the probe is
   never called then), and on a wedged driver the probe's 10 s bound plus the one-time
   sidecar-binary verification, which the start itself would wait on anyway. (That verification —
   a SHA-256 of the sidecar, `binary-verifier.ts` — runs BEFORE the kill-timer is armed and has no
   bound of its own; bounding it here would buy nothing, because the server's own pre-spawn
   verify shares the same session-cached promise for that path.) Before this the
   `--list-devices` child and the multi-GB weight upload competed for the same driver, and the
   start ladder — which shares the probe's in-flight promise — labelled the rung from whatever
   that race produced (#330: a card decoding at 98–100 tok/s reported as `cpu`, with an empty
   stamped probe persisted behind it). `maybeAutoStartActiveModel` re-checks admission and
   `startModelRuntime` re-checks the epoch, so a lock landing inside that window is handled
   exactly as before.
3. `maybeAutoStartActiveModel(ctx)` — returns a promise that settles when the start completed,
   was skipped (no model, toggle off, a runtime already up, locked) or failed (caught; it never
   rejects).
4. `scheduleFirstBenchmark(ctx, decision, started)` — the **measurement** half, `void`ed by the
   seams (the handlers never block on it). With nothing owed it resolves `'not-needed'` at once.
   Otherwise it waits for the start to settle — success **or** failure: a failed start still
   permits the benchmark, just without the speed leg — then re-checks the world and runs
   `runAndPersistBenchmark`, whose speed leg now sees the runtime the start brought up. The
   settlement re-checks mirror `startModelRuntime`'s post-hash guards: `workspaceAdmitsWork`
   (`'skipped-admission'`), the captured epoch (`'skipped-epoch'` — a lock AND a re-unlock
   meanwhile; the new session re-checks on its own), the quit latch (`'skipped-shutdown'`), any
   lane holding the model — a benchmark span, a chat, a doc task, a skill run
   (`'skipped-busy'`, the same predicate the run itself refuses on, read in the same tick), and a
   result for this computer persisted meanwhile by a manual run or another window
   (`'skipped-already-current'`). A thrown run is `'failed'` with the warn log. No outcome is
   retried within the session (below); the Performance screen runs the benchmark on demand at any time.
   The speed leg's per-chunk predicate additionally watches a model **start in flight**
   (`startingModelId`) and whether the manager still holds the runtime the run captured
   (`active() !== runtime` — a start that COMPLETED between the capture and the leg puts the flag
   back to null and commits a new one) (#393, 2026-09-08) — a manual "Use model" beside the run
   stops the streamed model, so the leg skips with `warnSpeedSkipped` instead of persisting a cut
   reading; the settlement re-check itself is unchanged (a start is not a lane).

The wait is **bounded** by `FIRST_BENCHMARK_SETTLE_TIMEOUT_MS` (120 s — sized to the common slow
case: a ~5 GB GGUF on the ~70 MB/s stick #108 measured is hashed and then loaded, roughly a minute
each; the pathological starts — a ladder walk of serial 180 s health timeouts plus the 90 s
warm-up — are what the continuation exists for), but the bound is a **deferral boundary, not
permission to overlap the load**: at the ceiling the scheduler resolves `'deferred'` and leaves
exactly **one continuation** on the same settlement, which runs the settlement re-checks and then
the measurement once the start actually settles; a session or process that ends first runs
nothing (the next launch re-checks), and a start that never settles leaves it to the next launch
too. Nothing cancels the user's model start, and no new occupancy lane exists. The timer is
injectable (`deps.timer`) so the timeout is testable without real time; production passes no deps.
Measured 2026-09-08 (#334, `eval/results/hardware/334-slow-usb-20260908/`): a healthy 9B start on
an 87 MB/s stick path with 15.8 GB RAM took 68 s to hash and 91 s to load, so the bound fired and
the continuation ran 10 s after settlement — the deferral is the ordinary outcome on such media,
not the pathological one, and it is benign by construction (no production caller consumes the
`'deferred'` outcome; only the log line differs).

**One automatic attempt per unlock session (SD2).** Since the moved-drive check, a key mismatch
re-triggered a background run at every unlock until a same-machine result persisted, with no
bound on a machine whose run keeps failing (no sidecar binary, an unwritable workspace). A
module-level memo keyed on the workspace **DB handle and the session epoch** (the shape of the
persisted-sample memo in `registerModelIpc`) records the attempt when a scheduling is
**accepted**; a second prepare/schedule in the same session — a failed run included — resolves
`'skipped-attempted'`; a lock + unlock (a new `Db`, a new epoch) re-checks; and a successful
**manual** run persists a same-machine `lastBenchmark`, so the next `prepare` owes nothing and
the re-check ends. The moved-drive re-check therefore repeats **once per unlock** until a
same-machine result persists (`known-limitations.md`). `resetFirstBenchmarkForTests()` clears the
memo; `maybeRunFirstBenchmark(ctx)` survives as the pre-split shape for tests (prepare, then
schedule against an already-settled promise) and resolves to the outcome.

**The late-write guard.** `runAndPersistBenchmark` captures the session epoch before its first
await and, after the drive and speed legs, re-checks admission and the epoch **before** the one
`updateSettings`: a lock (completed or under way), or a lock AND a re-unlock, completing during
the legs makes it reject without writing — the result is deliberately not returned either, since
the resolved value is documented as "the reconciled object that was written" (M6) — while the
`finally` still releases the occupancy span and pushes the idle `performance:changed`. The busy
refusal is the typed `BenchmarkBusyError` (the friendly localized lane copy as its message, the
lane as a field), so the scheduler can tell it from a failure.

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
screen answers the user's question in plain words. Four cards:

1. **This computer** — a verdict sentence and four tiles, plus a "Your model" row underneath.
2. **Observed while you worked** — session-only figures from real use.
3. **Models on this computer** — one row per role the app can hold, with card and processor summaries.
4. **Other computers this drive has been used on** — the history minus this machine.

**This computer.** One verdict sentence ("Runs \<model\> at about \<n\> tokens per second.
   Model starts from this drive are fast/slow.") and four tiles, each with a rating WORD, never a
   colour alone: Speed (decode tokens/s, the measured model and date; "Approximate" on a
   chunk-basis result), Memory (RAM, the profile as the pill, the model the RAM fits together with
   the context it launches with: the user's `contextTokensOverride` or the model's recommended
   window, plus CPU), Graphics memory (`BenchmarkResult.gpuVramMb` with `gpu`: ONE device's
   memory and name, recorded at benchmark time so the history rows carry it too — the **budget
   device** for the next start, `nextStartMemory` below; since the PR #308 audit `BenchmarkResult.gpu`
   / `gpuVramMb` and `PerformanceSnapshot.currentGpu` all name that device, never the first device
   the driver listed. The rating is the shared `isUsefulDevice` rule of `shared/gpu-rules.ts` — the
   same VRAM-floor + not-integrated gate the profile bump and the memory class use, never the
   memory figure alone (PR #303 audit M8.1): "Usable" for a useful discrete card, "Small" for a
   discrete card under the floor with the plain consequence "models run on the processor" (the copy
   interpolates the constant, so it reads "Under 5 GB" since #321), "Integrated" for a
   RECORDED integrated device (a legacy result written by the old `devices[0]` rule, or another
   computer's) — its figure shown as "GB shared" with the copy "integrated, shared memory: models
   run on the processor", never blamed on size — and "None" without a device. For the computer the
   app is on, the ELIGIBLE probe's DISPLAY device (`PerformanceSnapshot.graphicsDevice`, with its
   `useful` flag: the budget device when there is one, else the LARGEST card that does not look
   integrated even when it is under the gate — a 4 GB card; until #321 lowered the gate to 5,120
   this also caught every 6 GB laptop card — else the integrated one; `displayDevice`, owner
   decision 2026-09-07: the tile
   names the real card and its memory regardless of the gate, and the rating says whether it is
   used; `currentGpu` stays the budget device) is the freshest truth and wins; a result persisted
   before the field existed, or whose probe came back empty, gets the BUDGET device folded in by
   `buildPerformanceSnapshot` — name
   AND memory together, never an old iGPU name with a dGPU's figure — for the current machine
   only, and an already-mixed older row (an iGPU name and figure recorded by the old `devices[0]`
   rule) is replaced by the next local check. The screen never reads the raw `settings.gpuProbe`
   (it could be another machine's, M8.3; and on a hybrid laptop its first device is the iGPU's
   shared-RAM figure) — it reads `getSettings` for the two GPU flags only: with the GPU switched
   off or auto-disabled the snapshot names no card and the tile reads "Graphics acceleration is
   off. Models run on the processor." instead of "No usable graphics card". That off state wins
   over a card the result RECORDED while the GPU was on (issue #325, 2026-09-06): with the flags
   set and no live device, `graphicsFigure` never falls back to the result's own `gpuVramMb` /
   `gpu`, so the tile, the verdict, the ★ and the "Your model" row all say RAM for the next
   start (it used to read "Usable / \<card\>" until the next check re-recorded it); the Copy
   report's Graphics line carries the same off copy. A result from ANOTHER computer that predates the field says "Not
   recorded" — the app never probed that machine for it (N1) — while an explicit `null` is a
   recorded "None"; its other-computers row lists VRAM only for a usable card), Drive
   (`effectiveRead` with its source and date; "Pending" until a model start **or a full file
   check** measured it — both produce a sample, so the empty state credits both, PR #303 audit N4). The verdict sentence and the **Start \<model\> and measure** offer name the **live**
   recommendation (`PerformanceSnapshot.recommendation`, see "Recommendation" above — the same pick
   the AI Model screen stars), never the id saved with the result; where the saved
   `recommendedModelId` differs it is shown under the verdict as "Recommended at the time of the
   check". Actions: **Check again** (or **Start \<model\> and measure** when speed is unmeasured,
   the live pick is installed and nothing runs: `useModel` then `runBenchmark`), **Change
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
where the old heading misattributed every figure under it. Two lines under that heading are NOT the
record's, and #381 (2026-09-08) settled both: the live "next start" line and the context size
beside it are this computer's either way, so there they are labelled "on this computer" rather than
left to be read as the other machine's; and the Graphics memory tile's "Graphics acceleration is
off" — this machine's setting (`gpuMode: 'off'` / `gpuAutoDisabled`), not the record's — is now
shown only for a record measured HERE (`graphicsFigure` gates it on `snapshot.currentMachine`;
`live` is null for a foreign record too, so it used to replace that machine's own recorded card).
One `graphicsFigure` call feeds the tile and the report, so the gate fixes both. And an
**other-computer row** whose figure is approximate is rated with the neutral "Approximate" pill
(`perf.rating.approx`, neutral tone) instead of Good/Slow, with the qualifier appended to its sub
line. Good/Slow is a claim about the machine, and a chunk count over wall time (prefill included)
cannot support one. `speedIsApprox` / `speedBasisNote` in `PerformanceScreen.tsx` are the single
source for all three.
**Your model** (a row under the tiles; 2026-09-05, owner direction): whether the ACTIVE model fits
is not a property of RAM or of VRAM alone, so neither tile says it. The row names the model, its
size on disk and the context it launches with, then gives one verdict against this computer's
**memory class** (`nextStartMemory` in `services/performance.ts`; `memoryClassOf` is its
flags-at-default wrapper): `discrete` = a usable graphics card whose VRAM is the budget;
`unified` = Apple Silicon (darwin + arm64), one pool shared by CPU and GPU, budget = Metal's
`recommendedMaxWorkingSetSize` when the load log printed it, else 75 % of RAM (the Memory tile is
labelled "Unified memory" and the graphics tile is hidden); `cpu` = no usable card, budget = RAM.
**Which card — one eligible source** (PR #308 audit decision 9, merged with PR #303 audit M8,
owner decisions G3/G4): the class, the VRAM budget (`placement.vramMb`), the picker budget, the
device the copy names and the observed free/working figures all come from the ELIGIBLE
`settings.gpuProbe` (`eligibleGpuProbe` in `shared/gpu-rules.ts`: stamped with this machine's key,
or unstamped; a probe stamped elsewhere supplies nothing — the class is then `cpu` or `unified`,
with no budget, no `currentGpu` and no fold-in) and, of it, ONE device: the **budget device**,
the LARGEST probed device that passes the shared usable-card rule (`isUsefulDevice`: at or above
`USABLE_VRAM_MB` — 5 GiB since #321 — and not integrated by name — `primaryUsefulDevice`, which `selectBudgetDevice` in
`services/performance.ts` is), never `devices[0]` — the pinned Vulkan build lists an integrated
GPU beside the discrete one in driver order, so on a hybrid laptop the first device is as often
the iGPU reporting 11–36 GiB of shared RAM as it is the card, where `devices[0]` used to hand the
class to the dGPU but the budget and the name to the iGPU; with two usable cards the bigger one
(#303 P5 took the first useful device; the two rules were unified at the merge of the two
branches). `looksIntegrated` knows the current names (`Intel(R) Graphics (ARL)`, `Arc(TM) 1xxV`,
`Radeon 780M/890M Graphics`, `Radeon 8060S Graphics`). An integrated-only box has no budget device
at all (its shared figure is not the card's own): null everywhere, the RAM pick. The same helper
(`nextStartMemoryFor`) feeds `probeAndPersistGpu` (so `BenchmarkResult.gpu` / `gpuVramMb` name
it), `pickerMemoryFor` (the `listModels` ★ and the live recommendation) and this row, so the
Performance and Models screens can never mean different cards. `memoryClassOf` itself and the
hardware-profile bump (`gpuUsefulForProfile`) are unchanged — as is the runtime, which still never
passes `-ngl` and lets `--fit` decide. The `displayDevice` rule (the budget device when there
is one, else the largest discrete-looking card even under the gate, else the integrated one — since
2026-09-07; before that, `devices[0]` whenever nothing was usable, i.e. the iGPU on a hybrid laptop)
NAMES a GPU start (`RuntimeStatus.gpuName`, set in `runtime/factory.ts` — the Chat runtime hint)
and feeds the graphics tile as `PerformanceSnapshot.graphicsDevice`; before P5 both took
`devices[0]` unconditionally, so a hybrid box credited the iGPU for work the dGPU did. The Diagnostics **"Acceleration" line does NOT
use it**: it reads the snapshot's `currentGpu` — the BUDGET device — so "\<name\> (GPU available)"
only ever announces a card the next start can actually use (PR #303 P6, the source narrowed to
`currentGpu` by issue #327 / PR #303 P10). On a hybrid laptop whose card is under the gate the two
therefore differ ON PURPOSE: the tile names the card and rates it "Small", Diagnostics announces no
acceleration, and both are true. That device comes from the snapshot (`performance:get`), not from
`settings.gpuProbe` (issue #327, fixed by PR #303 P10): the renderer has no `hereKey`, so applying
`eligibleGpuProbe` there was impossible and the line skipped the machine-stamp check — a probe
stamped for another computer had Diagnostics announcing a card the Performance screen correctly
said this machine does not have. `currentGpu` null (no eligible probe, no device, or a failed
read) is the plain "CPU" wording; a running GPU runtime still wins over both, and a successful
"Try GPU again" re-reads it. Label only: rung selection, `--fit` and the "never -ngl" policy are
untouched, and nothing that ENUMERATES the probe's devices is filtered. **Next start, not
hardware** (decision 6, with #303's DR1): with the GPU switched off in Settings (`gpuMode: 'off'`)
or auto-disabled after a crash (`gpuAutoDisabled`) the ladder skips every GPU rung, so the class
is `cpu` for the next start (`nextStartMemory` says so as `cpuForced`), the budget is RAM and the
★ is the RAM pick, whatever the probe lists; the probe itself is still persisted (Diagnostics
lists the card, "Try GPU again" re-arms it). The verdict is asked for that EFFECTIVE class — `cpu`
as well when the matching observed start landed on the CPU backend — so the estimate reads "Will
run on the processor from RAM", never "Should fit in graphics memory" for a card the start would
not use; the resident rows follow the same class (chat and translation say 'cpu' under it,
translation also when its sidecar runs `--device none`). A placement OBSERVED on the card is kept
(a settings change never restarts a running model) but no longer counts for the row once the
configuration forces the processor: it travels as `placement.observedMismatch` and the row shows
the weights-only estimate for the RAM start the settings now ask for (the configuration match
below, PR #303 audit P4); under a `cpu` class that merely has no usable card an observed GPU start
still counts (the ladder may put layers on an iGPU under 'auto'). **Free/compute attribution
(DR2)**: the parser keeps every GPU row of the `device_info` block with the compute buffer
reserved on it (`ModelPlacement.devices`, label ↔ name, filed by label), and
`attributedGpuFigures` takes `freeAtStartMb` / `workingMb` from the row whose name is the budget
device's — with one row as much as with several (PR #303 P10, A-D3: an iGPU-only log beside a
selected dGPU attributes nothing; a lone row used to be trusted whatever it was called); only a
record persisted before the rows existed attributes as before (the first row's free figure, the
summed compute); when the budget device is not in the log, or none is selected, both stay null
and the copy falls back to the plain partial-offload sentence, never explaining a dGPU's spill
with the iGPU's free memory.

**The context it launches with** is resolved main-side by the launch path's own helper,
`launchContextTokens(settings, manifest)` — the user's `contextTokensOverride`, else the manifest's
`recommended_context_tokens` when it states one, else `settings.contextTokens`. The screen used to
recompute it with `??`, which differs in one real case: a manifest whose window is missing or `0`
(the parser returns `0`) showed a "0-token context" while the runtime starts that very model on
the settings default (PR #303 audit, M5 residual). The snapshot carries the resolved figure for
the ACTIVE model (`placement.model.contextTokens`) and for the RECOMMENDED one — the live
`recommendation.modelId` the CTA starts, not the id saved with the check (PR #308 decision 8) —
(`placement.recommendedContextTokens`), so the screen and the Copy report never recompute either.

**Observed first**: after a start, llama.cpp's own load log says where the model landed, and the
chat ladder now reads it (`runtime/placement.ts`, one parser per attempt, fed by the sidecar's
`onStderrData`; the chat server runs with `-lv 4` because the pinned build prints these lines
only from log verbosity 4 up, verified 2026-09-05: 3 prints none, 5 adds the `--fit` dry-run
pass): `offloaded X/Y layers to GPU`, every `<device> model buffer size` (CPU* devices and the
backends' `<Backend>_Host` buffers are the CPU side), every `<device> KV buffer size`, the Metal
budget line. The reading is recorded once the rung is healthy (`recordModelPlacement`, stamped
with the backend, the launched context
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
the current settings.") instead of presenting a fit the settings never asked for. **Running there
right now** (issue #325, 2026-09-06): the row adds one line, "Running on the graphics card right
now." (`perf.model.runningOnCard`), when the runtime status reports the ACTIVE model running on the
`gpu` backend AND the placement evidence for it — `observed`, else the record `observedMismatch`
dates — says `backend: 'gpu'`; so after the GPU toggle flips off while the model keeps running,
"measured earlier, on the card" and "still running there" no longer read the same. The mismatch
rule itself is unchanged; a CPU rung, a stopped runtime, another model running, or a record that
says the processor never shows the line. **Verdict**
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
trade that margin for a full offload is an owner decision (BUILD_STATE §5 item 22 (f)). Units: every size on the
screen is GiB (RAM, VRAM, the buffers), so the manifest's decimal "size on disk" is converted
once in the snapshot (19.8 GB → 18.4; display-only — the verdict gets the unrounded weights via
`weightsMib`). Before the first start → an ESTIMATE (the copy says so and that the context cache is
measured on the first start). **On a discrete card the estimate IS the picker's fit** (PR #308 audit
decision 8, finding §4.1; 2026-09-06): `placementVerdict` calls `estimateGraphicsNeedMib(manifest)`
— the OFFLOADABLE weights (unrounded, less the manifest's measured `host_mapped_weights_mib` where
it has one) × 1.15 + the model's `estimated_context_cache_gib` (default 0.5) + the fit's
1 GiB margin — against the picker's budget `graphicsBudgetMib(device)` (the probe's free figure,
else total − 1024), exactly as the Models ★ does, so the row and the star can never call the same
(model, card) pair differently; before, the row compared the one-decimal-rounded weights alone
against 92 % of the card's TOTAL and said "gpu" for Gemma 12B on 8 GiB, the MoE on 16, the Qwen3.6
Q5 on 20 and the 35B-A3B on 24 while the picker refused each. `needMb` on an estimate stays the
weights alone; the verdict's `budgetMb` stays the card's total (the figure the tile quotes). A card
that cannot hold the need is 'partial' if RAM + VRAM can hold the weights (with 8 % headroom; the
spill is the estimated need over the budget, capped at the weights), else 'too_large'; a model
outside the catalog on a card is 'unknown' (no cache term). Unified and cpu are unchanged: the
weights against the budget with 8 % headroom → 'gpu'/'cpu' or 'too_large'. An observed start
always wins over the estimate. 'too_large' offers "Choose a smaller model" (AI Model). Pills: On
GPU / Partly on GPU / On processor / Too large / Not measured. Phase 2 (not built): the
context-cache estimate from the GGUF header (BUILD_STATE §5 item 22 (e)).

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

**Observed while you worked.** Figures from real use — SESSION latches only (PR #303 audit
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
holds the card, or reclaim the card when translation goes idle) is an owner decision (§5 item 22
(g)).

**Other computers this drive has been used on.** The history minus the key behind the currently
displayed result (`currentKey ?? here`: the displayed `lastBenchmark`'s own key when it has one,
else this machine's key — PR #303 audit N7), newest
first, each with its speed/model, CPU/RAM/date and rating pills ("Slow drive" under 100 MB/s;
the speed pill is Good/Slow only for a runtime-timings figure — see "Speed provenance travels
with the figure" above — and the neutral "Approximate" otherwise).

**The read sample's duration on those rows** (§5 item 22 (d), owner decision 2026-09-08). "How
long does a model take to start on that machine" was answerable for the CURRENT machine only, in
"Observed while you worked". **No schema change was needed** — every persisted per-machine row is a
`BenchmarkResult` and already carries `effectiveRead: EffectiveReadSample` (`{ mbps, bytes, ms,
source, modelId, at }`); the row was already reading it for the "Slow drive" pill. So this is a
renderer change alone (`otherLoadNote` in `PerformanceScreen.tsx`), and `data-contracts.md` is
untouched. Three branches, and the middle one is the honesty of it:

- `source: 'model_load'` → "model start {seconds} s" (`perf.others.load`) — a model start;
- `source: 'checksum'` → "file check {seconds} s" (`perf.others.check`) — a FULL FILE CHECK, which
  reads the same bytes but is not a model start and is never labelled one. This is the same split
  the current machine's rows have made with two separate keys since #108;
- **absent or null** → nothing rendered. Not a placeholder and not a "0.0 s", which would read as
  "it started instantly"; a row persisted before the field existed simply does not claim.

The fragment sits between the machine's identity/date and the speed-basis qualifier, so the
machine's own facts stay together and the qualifier on the headline figure stays trailing. The
**Copy report carries none of this, because it has no other-computers section at all**:
`buildReport` renders the "This computer" card from one `BenchmarkResult` (heading itself
"Another computer: …" when that result is foreign, L6). Adding one was not part of the decision.

**Data path**: one IPC read, `performance:get` → `PerformanceSnapshot` (`buildPerformanceSnapshot`
in `registerBenchmarkIpc.ts`): `current`, `recommendation` (the live pick, see "Recommendation"),
`currentMachine`, `currentGpu` (`{ name, totalMb, useful } | null` — the eligible probe's budget
device for the next start, one device's name and memory; null with no usable card or the GPU
switched off), `otherMachines`,
`running` (the `benchmark` occupancy span read directly, `occupancy.held('benchmark')` — not
through `modelBusyLane`, which answers "chat" first and hid a held span behind a permitted
foreground answer, PR #303 audit M1), `placement` (memory class, RAM/VRAM, the active model, the
context the live recommendation would launch with, the observed placement or its configuration
mismatch, the verdict, the per-role `models` rows, `totals`), `observed`. The read is
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
`prepareFirstBenchmark`; every GPU probe write (`probeAndPersistGpu`: a completed probe, incl.
an empty device list, so "Try GPU again" pushes through it, and the EMPTY probe persisted when the
probe cannot run or threw — PR #308 decision 6 — so the tile and the ★ drop a stale card at once;
a probe that TIMED OUT writes and pushes NOTHING, because it is unknown rather than an answer and
the stored probe stands (#380, 2026-09-08);
and, since issue #323 (2026-09-06), the refresh a completed chat-engine install triggers:
`EngineDownloadManager.onInstalled` → `refreshGpuProbeAfterRuntimeInstall`, which re-runs the
same `probeAndPersistGpu` — cache invalidated first, the same admission / unlock-epoch checks —
only when this machine's eligible probe lists no device, so a benchmark run before the binary
existed no longer leaves the RAM-only answer frozen until a manual re-check; an eligible probe
with a device, a whisper-only install, or a failed one refreshes nothing, and the check itself
is never re-run)
and, before it, "Try GPU again" clearing `gpuAutoDisabled` / `gpuLastError` — that write pushes
on its own (PR #303 P10, A-D1), so the processor-forced rows and verdict clear as soon as the
flags do, without waiting for the probe; the re-probe's own write then pushes a second time
(a successful list and the empty probe alike — the renderer serialises its refetches); the chat
runtime's transitions
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
when the leg was skipped as busy — `warnSpeedSkipped` — and not when the probe failed); since #393
a probe that FAILED while something was busy (the stop that killed the stream) raises
`warnSpeedSkipped` as well — only a failure with nothing busy stays silent;
`'done'` always. A later step never implies an omitted earlier one succeeded. `'done'` means
the PROBES are complete: it precedes the persist and the occupancy release, so it is not the
idle signal — the terminal `performance:changed` after both is. The IPC handler forwards the
steps to the requesting window only, as `benchmark:progress`, and the screen shows a step
list instead of an opaque "Running…" button. The first-run path passes no callback — so the
step list is shown for a run THIS window started, and any other run (first-run, moved-drive,
another window) gets a single "Checking this computer in the background." line in the same live
region instead of a list nothing could advance (#438; see "An automatic run's step list" below).
The drive
step is labelled **"Drive speed"**, not "Drive write speed" (PR #303 audit N5): the step's write
probe is one input, and the tile the user reads next to it reports MB/s *read* — naming the step
after the write leg contradicted the figure it leads to.

### An automatic run's step list (#438, owner decision 2026-09-12)

Found by #331 leg 2 on the E: stick: a moved-drive check ran for 13.7 s with the Performance
screen mounted, the step list frozen on step 1 for the whole run, then gone. A manual "Erneut
prüfen" advanced normally in the same session — the contrast case.

**Cause: two correct decisions multiplying.** Progress is emitted only from the `benchmark:run`
IPC handler and addressed to `event.sender`, the window that invoked it; the automatic scheduler
calls `runAndPersistBenchmark(ctx)` with no callback at all. The screen meanwhile renders the list
on `busy`, which follows the BACKEND span (`snap.running`), not "a run this window started" —
deliberately so, per audit **M1**: merging the two locked the screen into "Running…" for a foreign
run and never let it out. So the list was shown for a run whose progress can never arrive.

**Options weighed.** (1) Broadcast the steps to every window and have the scheduler pass a
callback. (2) Show the steps only for an own action, and give any other run one honest line.
(3) Carry the completed steps in `PerformanceSnapshot`, so the screen reconstructs them on any
mount.

**Decided: (2).** (1) was rejected as a HALF-fix, on a fact the issue's own framing missed: the
automatic check fires about a minute after unlock, once the model start settles, so the common
path is the user arriving on Performance **mid-run** — and a late-joining window has already
missed the earlier one-shot messages. It would render "Hardware detected: in progress · Drive
speed: waiting · Generation speed: done", which is worse than frozen. The cheap patch — a step
marks every earlier one done — is barred by the **L3** honesty rule: a step is reported only when
it SUCCEEDED, so back-filling would claim a skipped drive probe had passed. (3) fixes the
late-join case properly and stays the option if per-step detail for automatic runs is ever
wanted; it was not worth a shared-shape change plus a push per step for a case nobody reported.

**As built.** `showOwnSteps = ownActionInFlight || doneSteps.length > 0` gates the items; any
other held span renders one `<li>` carrying `perf.running.background` ("Checking this computer in
the background." / "Dieser Computer wird im Hintergrund geprüft."). Three things that look
incidental and are not:

- The line goes **inside** the always-mounted `.perf-steps` live region of #437, not beside it.
  An empty region would have left the automatic check silent to a screen reader — a regression
  against #437 rather than a neutral subtraction. Inside it, the line is a text change in a region
  that was already there, which is what makes it audible. It carries no live-region role of its
  own (#436).
- `doneSteps.length > 0` is the second term because `ownActionInFlight` is cleared in the action's
  `finally`, one snapshot read BEFORE `backendRunning` catches up; on the flag alone the region
  would blink to the background line at the tail of the user's own run.
- A foreign run cannot fake that term: it delivers no steps, and `applySnapshot` clears whatever
  an earlier own run left as the span is taken — which is what makes `doneSteps` a sound "these
  steps are MINE" marker.

**The IPC contract is unchanged** — steps still go to the requesting window only. This is a
renderer-side decision about what to DRAW for a run that has none. Pinned by
`PerformanceScreen.test.tsx` "M1 + #438: an external run shows as running with the background
line, never the last run's steps", "#438: the background line sits IN the step region, so an
automatic check is still announced" and "#438: at the tail of our own run the list stays ours,
never blinking to the background line".

**Residual:** an automatic check reports no per-step detail, and the outstanding by-ear leg now
has this line to hear as well.

### The Diagnostics benchmark card — a support artifact (§5 item 22 (b), owner decision 2026-09-08)

When the Performance screen took the answer (2026-09-05), the intended split was already recorded
above — "Diagnostics keeps the raw table and its Copy button as the support surface" — but the card
itself was not trimmed to it. It still ran the check and still repeated two INTERPRETIVE rows.
**Performance owns both the answer and the action**: "Check this computer" / "Check again"
(`perf.check` / `perf.checkAgain`) call the very `runBenchmark()` this card duplicated, and it is
now the only renderer caller of it. The card is therefore the RAW MEASUREMENT plus Copy, and
nothing else.

**Dropped.** The Run / Re-run button and its handler; **"Assigned profile"** (`diag.bench.profile`
as a row here — the key itself stays, the Performance Copy report uses it); and **"Recommended
model"**, which was the check's HISTORICAL pick and which the PR #303 audit identified as a
live-vs-history confusion source. `diag.bench.run` / `.rerun` / `.running` / `.failed` /
`.recommended` are deleted; `.profile` and `.noMatch` are NOT (both live on in `buildReport`).

**Kept.** RAM, CPU, OS/arch, GPU, Measured read speed, Drive write, Decode speed, Last run, the
warnings list, and Copy.

**The `ErrorBanner` goes with the button** — checked deliberately rather than left standing. SH-2
(#145) mounts a banner unconditionally so the FIRST failure of an ACTION is announced instead of
swallowed; this one's `message` was fed only by the `runBenchmark` catch, so with no action it
could never fill, and an always-mounted banner that cannot fill is dead markup. The SH-2 property
is not lost: it holds for "Try GPU again", now the only action in the tab that can fail (and the
only remaining `error`-shaped state there), and Performance carries its own `perf.failed` line for
the action it took over. The FE-8 case that exercised `friendlyIpcError` through the benchmark
button is replaced by an absence assertion; FE-8's actual property is still asserted on
"Try GPU again", which routes through the same `runAndSurface` / `friendlyIpcError` path.

**An empty state, because the card would otherwise be a dead end.** With no check ever run
(`lastBenchmark === null`) the card previously rendered a heading, a hint and — once the button
went — nothing. `diag.bench.empty` names where the check lives: "No check has run on this computer
yet. Open the Performance screen to run one." A TEXT pointer, not a button: `SettingsScreen` takes
no navigation prop and no Settings tab navigates today, so wiring one through for a single sentence
would cost more than the pointer is worth, and Diagnostics is deliberately quieter than a
destination screen. `diag.bench.hint` is rewritten to match — it described a button that is gone.

**The Copy report MIRRORS the card; the dropped rows are not kept "for bug reports".** Three
reasons, in order of weight. (1) A stale *recommended model* pasted into a support message is worse
than an absent one — a reader takes it for what the app recommends now, which is the confusion the
#303 audit named; the LIVE pick is in the Performance Copy report, which already heads itself
"This computer" / "Another computer: …". (2) The *assigned profile* is not lost from the tab at
all: the App & runtime card and its own Copy report carry `hardwareProfile`, and that one is live
rather than recorded. (3) This file's standing invariant is that a card row and its Copy text
render from the same helper "so the two can never disagree" — rows kept only in the report break
it, and nobody could then tell which set the card was supposed to show.


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
weight|mmproj|extra|download}` (`extra` = a #310 `files:` entry), bytes, ms, ok; each real hash also writes one plain `app.log`
line, visible without the perf log), `sidecar_healthy`, `runtime_selected`,
`model_prefetch` (issue #114: one mark per event of the concurrent weight prefetch riding
the load window — `started`/`skipped`, then the settle outcome `done`/`aborted`/`failed`;
`started` → settle times the window), `runtime_ready`, `first_token`, `stream_done`,
`embedder_selected`, `drive_benchmark`,
`discover_manifests` / `performance_get` (issue #333 — see below),
and the `ingest_*` phase marks (`start`, `copy_done`, `parse_done`, `chunks_committed`,
`embed_done`, `indexed`).

### `discover_manifests` / `performance_get` — the #333 pair

`discover_manifests` fires once per `discoverManifests` call — all thirteen call sites, not just
the Performance screen — with `{files, ok, bytes, ms, walkMs, readMs}`. The three-way split is the
point: `walkMs` is the recursive `readdirSync` (directory metadata), `readMs` the `readFileSync`
bytes, and the remainder (`ms − walkMs − readMs`) YAML parse + `validateManifest`, which is pure
CPU. Computing those fields costs extra clocks, so unlike every other mark the surrounding
measurement code is itself gated — on `perfEnabled()`, a predicate `perf.ts` exports for exactly
this case. With the log off, an instrumented scan costs one env-var read.

`performance_get` wraps the IPC handler, not `buildPerformanceSnapshot`, so it spans exactly what
the renderer awaits. The scan's share is the `discover_manifests` line immediately before it: the
two are synchronous and adjacent, which is how `scripts/measure-manifest-read.mjs --log` pairs
them (a scan with anything in between is reported as another caller's).

**Reading these marks honestly.** The manifests are ~90–140 KiB and stay page-cache resident once
read, so the first mark of a run and every later one measure different things — and this project
has three recorded cases of a warm cache corrupting a drive figure (#392, #404, and #414, where an
external `Get-FileHash` in the protocol itself reported 1,008 MB/s for a 407.9 MB/s drive). Cold
means the first read since the drive's cache was dropped: eject the drive, re-insert it, then run.
The warm figure is not the lesser one — it is what the screen's push-driven refetch actually pays,
once per finished chat answer and once per model start while the screen sits open.

Content rule, stricter than `app.log`: a mark carries only phase names, model and
backend ids, byte counts, and millisecond durations. Never file names, paths of user
files, document titles, or chat text; documents appear only as their random UUID. That
is why the file may rest in plaintext even on an encrypted workspace.

## Audit remediation record — PR #303 (2026-09-06)

This section is the durable record of the PR #303 review-and-fix wave: what was found, what
shipped, and what is still open. It is written to stand on its own — every disposition below
cites a commit SHA, a test file and test name, or a doc heading, never the private working
papers (`tmp/pr-303-audit.md`, `tmp/pr-303-fix-plan.md`, `tmp/pr-303-fix-plan-ledger.md`) that
produced it. Anyone resolving an old citation to one of those IDs should start at §5.

### §1 Scope and decisions

The audit (three passes, last-reviewed head `db7e816a`) found **M1–M8, L1–L8, H1, D1–D5** and
**T1–T12** plus nits **N1–N7**, and its own §6 left three manual-acceptance legs open (a
physical A→B→A drive move, mounted-screen behaviour during a live check, and EN/DE layout at
the app's supported widths). The fix plan added a self-review pass (**R1–R15**, corrections to
its own first draft before any code changed), scoped the work as phases P0–P11 behind owner
gates **G1–G8**, and its findings inventory added **DX1–DX2** (doc contradictions), **SD1–SD2**
(undefined scope questions), **HW1–HW4** (hardware acceptance legs) and **TH1–TH2** (test
hygiene). Phase P0's source-delta review — the PR had gained a fifth commit, `ce741533`, after
the audit's last pass — found eleven more defects in that commit, **DR1–DR11**.

Owner gates G1–G8, each resting on a specific fact:

- **G1** (fix on-branch before merge) — the audit's verdict was "Request changes."
- **G2** (observed rows are session latches, session = main-process lifetime) — M3 found a
  persisted, possibly weeks-old or foreign sample shown under copy that promised session-only
  figures.
- **G3** (unknown identity stays eligible as "this machine") — `machineKey` already returns
  null for legacy or failed-detection records (M4, L5); this is a compatibility policy, not
  proof of provenance.
- **G4** (repair M8 in this PR, not as a follow-up) — the audit found three disagreeing "usable
  GPU" rules describing the same hardware differently on the same screen.
- **G5** (auto-start settles before background benchmark I/O) — L1 found the drive probe could
  contend with an active multi-GB model load on the same drive.
- **G6** (push, not poll) — M1 found no signal ever reached a screen that did not start the
  run it was watching.
- **G7** (validate/normalize malformed history and placements) — H1 found a `{}` history entry
  crashes the screen.
- **G8** (a separate git worktree for this wave) — CLAUDE.md's concurrent-sessions rule, not a
  finding.

Three gate rulings made at the P0 checkpoint (2026-09-06): **`origin/master` was merged into
the branch at the start of P1** as a separate merge commit, before the BUILD_STATE archive
edit — its only conflict was BUILD_STATE.md itself, resolved by keeping both dated entries.
**DR5 uses a class-aware RAM total** in `loadedAtOnceMb`: a plain sum on the `cpu` memory
class, processor-pinned rows plus the active model's *observed* partial-offload spill on
`discrete`, and the full sum against the unified budget on `unified` — so a `discrete`-class
machine's card-resident weights are no longer counted twice, once by the card line and once
against RAM. **L7 keeps the shape `kind: 'unknown', estimated: false`** for an observed start
whose log printed none of the parsed lines, rather than the audit's alternative repair (falling
back to the weights-only estimate) — an unreadable log is presented as unmeasured, never as a
guess.

### §2 Disposition matrix

| ID | Disposition | Facts as fixed | Evidence |
|---|---|---|---|
| M1 | fixed P3 `3fbc51d0` | Snapshot `running` reads `occupancy.held('benchmark')` directly (not the chat-first refusal helper); the renderer assigns it verbatim from each push instead of `r \|\| next.running`. | `performance-ipc.test.ts` "`running` reads the benchmark span itself: a foreground chat does not hide it (M1)"; `PerformanceScreen.test.tsx` push-lifecycle cases |
| M2 | fixed P2 `86fa8e10` | `sampleEligible`/`eligiblePersistedSample` (`services/benchmark-persistence.ts`) gate a persisted read sample by `machineKey` before source ranking. | `performance-persistence.test.ts` "a NEW computer does not inherit a foreign persisted model-load sample, nor its warning"; "a local checksum sample beats a foreign persisted model-load sample" |
| M3 | fixed P3 `3fbc51d0` | `observed.lastModelLoad` is the session latch only, same-machine and foreign alike; the persisted fallback is gone. | `performance-ipc.test.ts` "a same-machine persisted-only model_load sample is NOT an observed model start"; "another computer's persisted model_load sample is not one either"; "a model start THIS session is" |
| M4 | fixed P2 `86fa8e10` | `backfillOutgoing` seeds the outgoing computer into history before it is replaced, on the startup, restore, run and manual paths. | `performance-persistence.test.ts` "a manual first move (runAndPersistBenchmark, no history) keeps the old computer"; "restore (A→B→A) brings back the NEWEST outgoing sample, the one that landed mid-run" |
| M5 | pre-wave fix pinned P1 `5121af46`; residual fixed P4 `9530b2a5` | The Memory tile's fit claim was removed before this wave (`db7e816a`); the zero-context-manifest residual now resolves via the launch path's own `launchContextTokens`, main-side, for both the active and recommended model. | `performance-schema.test.ts` "falls back to the settings default for a manifest that states NO window (never \"0-token\")"; "the user override wins over both, up to the 131 072 ceiling" |
| M6 | fixed P2 `86fa8e10` | `runAndPersistBenchmark` re-resolves the eligible sample after both the drive and speed legs and folds the newest one in (`mergeSampleIntoResult`) before persisting. | `performance-persistence.test.ts` "at the drive step boundary — the result, the headline and the history carry it, with its warning"; "at the speed step boundary (a runtime is up, so the speed leg runs)" |
| M7 | pre-wave fix pinned P1 `5121af46`; real-log capture done 2026-09-08 (#329) | `isCpuDevice` treats `CPU*` OR `*_HOST` as CPU-side (ggml's pinned host buffers); already shipped in the PR's own `ce741533`. The captured b9849 logs sharpen the claim rather than change it: they witness `CPU_Mapped` model buffers (32 logs) and `<Backend>_Host` COMPUTE buffers (54 lines), and where a partial offload spills the KV cache at all it lands in a plain `CPU KV` buffer (5 of the 10 captured partial offloads spill only the recurrent state — 31/33 ×3, 64/66, 65/66 print no `CPU KV` line); a `*_Host` **KV** buffer appears in no capture, so that branch of M7 stays convention-pinned (ggml's naming rule, not an observation) and keeps its handwritten test. | `placement-parser.test.ts` "files the GPU backend's _Host KV buffer under the CPU side (the partial-offload spill)"; "files a CUDA_Host model buffer (--no-mmap CPU-side weights) under the CPU side"; "reads a REAL 20/33 partial offload on a hybrid iGPU + dGPU laptop, whole reading (b9849)" |
| M8 | fixed P5 `be177a34` | One shared `isUsefulDevice`/`gpuUsefulForProfile`/`primaryUsefulDevice`/`displayDevice` rule (`shared/gpu-rules.ts`); `GpuProbeResult.machineKey` stamped and checked before any fold-in. | `performance-gpu.test.ts` "a hybrid [iGPU, dGPU] probe: currentGpu, the VRAM budget, the class and the fold-in all describe the dGPU"; "a probe stamped with ANOTHER machine supplies nothing…" |
| L1 | fixed P7 `566a1043` | `prepareFirstBenchmark` (cheap restore/backfill) runs before `maybeAutoStartActiveModel`; the scheduler awaits the start before any drive/speed probe. | `first-benchmark-scheduler.test.ts` "no benchmark I/O while the start is pending; once it resolves the run measures the started runtime" |
| L2 | fixed P2 `86fa8e10` | `persistEffectiveRead` (via `effectiveReadPatch`) writes a qualifying sample to `lastBenchmark` AND the matching history entry. | `performance-persistence.test.ts` "updates both lastBenchmark and the matching history entry"; "repairs a stale history entry beside a headline that already carries the sample" |
| L3 | fixed P3 `3fbc51d0` | `benchmark.ts` reports the `'drive'`/`'speed'` steps only when they produced a figure; a busy or failed leg is silently omitted, never ticked. | `performance-ipc.test.ts` "a runtime that was busy elsewhere (the leg skipped, #185): no speed step"; "a drive probe that failed (unwritable workspace): no drive step, and no later step implies it" |
| L4 | documented limitation (this phase) | Retained-hardware-records inventory, in user words and in the security/privacy inventories. | `security-model.md` SEC-N2; `PRIVACY.md` "What data is stored, and where"; `user-guide.md` §10 |
| L5 | documented limitation (this phase) | Fingerprint-collision, RAM-rounding and OS/arch-split limitations. | `known-limitations.md` "Performance screen and per-computer history (PR #303 audit)" |
| L6 | fixed P6 `9f703b87` | `speedIsApprox`/`speedBasisNote`/`buildReport` are the single provenance source for the Copy report and the Other-computers rows. | `PerformanceScreen.test.tsx` "L6: the report preserves the approximation qualifier and the chunk window"; "L6: an other-computer row measured from chunks reads \"Approximate\", never Good or Slow" |
| L7 | pre-wave fix pinned P1 `5121af46` | `placementVerdict` already returned `kind:'unknown'` for an all-null reading at `ce741533`; the owner gate kept that shape and P1 pinned it plus the renderer's no-"all  layers" rendering. | `performance.test.ts` "an EMPTY reading is unknown on a gpu backend and cpu on a cpu backend, never a measured \"On GPU\""; `PerformanceScreen.test.tsx` "an observed start whose log said nothing reads as Not measured, never \"all  layers on the GPU\"" |
| L8 | fixed P4 `9530b2a5` (schema) + P6 `9f703b87` (copy) + P8 `4baec2be` (wiring) | `normalizeModelPlacement`/`normalizeModelPlacements` validate the map; `perf.model.unknown`/`perf.model.perDrive` name "on this computer" and the per-drive replacement rule; the ladder-to-persister path is now tested end to end. | `performance-schema.test.ts` "T10 / L8: `{ m: {} }` is not a placement map, and a `{}` record never reaches the verdict"; `placement-wiring.test.ts` "a ladder start lands in settings through the registered observer, end to end" |
| H1 | fixed P4 `9530b2a5` | `shared/benchmark-schema.ts` validates `lastBenchmark`/`benchmarkHistory`/`modelPlacements` field by field on both `getSettings` and `updateSettings`. | `performance-schema.test.ts` "H1: a `{}` history entry is neither stored nor exposed as another computer"; "H1: a partially valid history keeps the real machines and drops the blobs" |
| D1 | fixed P9 (this phase) | New Performance section covering the verdict, tiles, Your model, Models on this computer, Check again/Start and measure, observed rows, Other computers, and privacy. | `user-guide.md` §5a "Performance" |
| D2 | fixed P9 (this phase) | Supersession notes beside the two historical rail-count paragraphs, pointing at the current design without erasing the dated history. | `architecture.md` (the two "N primary + 1 utility" paragraphs) |
| D3 | fixed P9 (this phase) | `performance:get`/`performance:changed` added to the current protected-IPC inventory; the retained-records inventory added beside it. | `security-model.md` SEC-N2 |
| D4 | verify-only (DR9 at P0; reconfirmed this phase) | `navigation.ts`'s header and `App.tsx`'s nav comment already describe the current three-group rail; no stale text found at either check. | `apps/desktop/src/renderer/navigation.ts`; `apps/desktop/src/renderer/App.tsx` |
| D5 | fixed P9 (this phase) | One plain-language sentence naming the retained hardware/benchmark records. | `PRIVACY.md` "What data is stored, and where" |
| T1 | fixed P3 `3fbc51d0` | Covered by M1's fix and evidence: an external run's completion now clears the screen without a poll. | see M1 |
| T2 | fixed P2 `86fa8e10` | Covered by M2's fix and evidence. | see M2 |
| T3 | fixed P3 `3fbc51d0` | Covered by M3's fix and evidence. | see M3 |
| T4 | fixed P3 `3fbc51d0` | Covered by L3's fix and evidence. | see L3 |
| T5 | fixed P3 `3fbc51d0` | Handler-level progress forwarding, destroyed-sender isolation and an end-to-end `performance:get` read, tested directly. | `performance-notify.test.ts` (22 cases) |
| T6 | fixed P6 `9f703b87` | German component smoke added for the Performance screen; rail-label coverage itself was already fixed pre-wave. | `GermanSmoke.test.tsx` "PerformanceScreen renders German (PR #303 audit T6)" |
| T7 | fixed P8 `4baec2be` | The history-replace test now uses a distinct `tokensPerSecond` per machine and asserts identity and order, not just a resolved value. | `performance.test.ts` "replaces the entry for the same machine, newest first, keeps other machines" |
| T8 | fixed P8 `4baec2be` | Pins that `initBackend` wires `setAnswerSpeedObserver` through `observeAnswerSpeed`, never `recordAnswerSpeed` directly. | `answer-speed-wiring.test.ts` "setAnswerSpeedObserver, inside initBackend, is given a callback that calls observeAnswerSpeed" |
| T9 | CLOSED 2026-09-08 (#329) | 32 verbosity-4 load logs captured from the pinned build (b9849 `799fcc04a`) across four machines (i7-8700 5 logs, i9-14900K 10, i9-9900X 12, Ryzen 7 5800H 5) now live under `eval/results/hardware/`; four are promoted to byte-for-byte fixtures — `placement-b9849-partial-20of33-hybrid.txt` (a hybrid Radeon-iGPU + RTX-3060 laptop, the partial offload the issue asked for), `-partial-18of33-np4.txt` (the same box at four slots, the per-sequence regression case), `-partial-62of66-mtp.txt` (two llama_contexts and three reserve blocks on an RTX 3090) and `-full-49of49-swa.txt` (Gemma's two-buffer SWA cache on an RTX 3080 Ti). The surviving handwritten fixtures cover only what no capture witnesses: CUDA and Metal devices, the legacy `llm_load_tensors:`/`llama_kv_cache_unified:` prefixes, chunk reassembly at pathological boundaries, two GPUs both holding weights, and the `*_Host` KV buffer (M7). Promoting them found — and this change fixed — two parser gaps: the `RS buffer size` line (the hybrid models' per-sequence recurrent state, 29–1,795 MiB on the card and 17–112 MiB CPU-side, in 26 of the 32 logs) matched no regex, and an MTP start's draft-context compute buffer was summed a third time when llama.cpp reprints its unchanged size on the speculative re-reserve. With both fixed, the parsed total lands within +28.6…+36.6 MiB of the heap-measured VRAM on all seven measured 3090 runs. | `placement-parser.test.ts` (the four "REAL …" cases); `placement-wiring.test.ts` (both logs are captures now) |
| T10 | fixed P1 `5121af46` (L7 half) + P4 `9530b2a5` (L8 half) | Covered by L7's and L8's fixes and evidence. | see L7, L8 |
| T11 | fixed P8 `4baec2be` | Ladder-to-persister wiring: backend, context and machine stamp latch before warm-up ends; a retried rung never sums two loads. | `placement-wiring.test.ts` "gives every attempt its OWN parser: a retried rung never sums the failed load" |
| T12 | fixed P5 `be177a34` | Covered by M8's fix and evidence (the integrated-device and hybrid-order cases). | `PerformanceScreen.test.tsx` "T12: an integrated device reporting 16 GB of shared memory is \"Integrated\", never \"Usable\", beside \"On processor\" (M8.1)" |
| N1 | fixed P5 `be177a34` | "Not recorded" replaces "No usable graphics card" for a foreign result that merely predates `gpuVramMb`. | `PerformanceScreen.test.tsx` "shows the graphics memory from the result, or from this machine's eligible probe when the result predates the field" |
| N2 | fixed P3 `3fbc51d0` | The `onBenchmarkProgress?.()` optional chain dropped; both preload calls are unguarded and typed. | `PerformanceScreen.tsx` (source) |
| N3 | fixed P5 `be177a34` | `SLOW_TOKENS_PER_SECOND`/`SLOW_READ_MBPS`/`USABLE_VRAM_MB` moved to `shared/gpu-rules.ts` and `shared/performance-rules.ts`; the renderer's own copies deleted. | `gpu-rules.test.ts`; `shared/performance-rules.ts` |
| N4 | fixed P6 `9f703b87` | `perf.tile.drive.noneHint` reads "…or file check". | `shared/i18n/en.ts` `perf.tile.drive.noneHint`; `PerformanceScreen.test.tsx` "N4: the empty Drive tile credits a file check as well as a model start" |
| N5 | fixed P6 `9f703b87` | `perf.step.drive` renamed "Drive speed". | `shared/i18n/en.ts` `perf.step.drive`; `PerformanceScreen.test.tsx` "N5: the drive step is \"Drive speed\", not \"Drive write speed\" beside a tile reading MB/s read" |
| N6 | CLOSED 2026-09-09 (issue #333) | Measured on the drive, cold and end to end: 27 ms warm median, ~90 ms cold once per session. Acceptable as measured — no cache (owner decision). Instrumentation kept (`discover_manifests` / `performance_get` marks + `scripts/measure-manifest-read.mjs`). §4 I5 carries the figures and the reasoning. | — |
| N7 | documented (this phase) | This file's "Other computers" paragraph now names `currentKey ?? here` explicitly; the field already behaved this way. | `benchmark.md` "Other computers this drive has been used on." (this file) |
| DX1 | fixed P3 `3fbc51d0` | The "session-only, never persisted" vs. "falls back to the persisted sample" contradiction is gone; this file and `data-contracts.md` agree. | `benchmark.md` "Observed while you worked."; `data-contracts.md` |
| DX2 | fixed P9 (this phase) | This file's "Performance screen" section is a clean four-item list; "Your model" and "Models on this computer" no longer sit between numbered items. | `benchmark.md` "Performance screen" (this file) |
| SD1 | fixed P3 `3fbc51d0` (defined) | "Session" = main-process lifetime, documented; the latch has no reset path besides an app restart or the test-only `resetPerformanceForTests()`. | `benchmark.md` "Observed while you worked." (this file) |
| SD2 | fixed P7 `566a1043` | A module-level memo keyed on the DB handle and the unlock epoch allows exactly one scheduled attempt per unlock. | `first-benchmark-scheduler.test.ts` "a failed new-computer run is not retried in the session; the next session re-checks and runs"; "a successful MANUAL run ends the re-check…" |
| TH1 | fixed P8 `4baec2be` | The legacy-blob test's fixed 300 ms sleep replaced by an awaited scheduler outcome. | `performance-ipc.test.ts` (legacy-blob case) |
| TH2 | fixed P8 `4baec2be` | `closePerformanceFixture()` tears down every DB/root/observer the performance test helper registered; a leak check showed zero growth across a targeted run. The other suites' ~2,500 leaked roots per full run (#335, 2026-09-06) are now recorded and removed by the harness itself — `tests/setup-temp-roots.ts` per file, `tests/global-temp-roots.ts` after the forks exit; design in `tests/helpers/temp-roots.ts`, rule in CONTRIBUTING.md. | `tests/helpers/performance-fixture.ts`; `tests/unit/temp-roots.test.ts` |
| HW1 | verified 2026-09-07 (issue #330) | Physical encrypted-drive A→B→A move on two real computers (i9-14900K / RTX 3080 Ti and i7-8700 / GTX 1070 Ti, one exFAT SSD) for a fresh workspace AND an upgraded one created by 0.1.57 (keyed `lastBenchmark`, no history): new-computer background run on B, instant restore on A, the outgoing result backfilled, later samples update the headline and the matching entry only. Side findings are not persistence defects (§4). | `eval/results/hardware/330-round-trip-20260907/` (`00-protocol.md` + every report and log) |
| HW2 | CLOSED 2026-09-08 (#329) | Same gap as T9, closed by the same capture: real partial-offload load logs from the pinned build now exist (20/33 and 18/33 on a hybrid laptop, 62/66 on an RTX 3090) and are committed as fixtures. | `apps/desktop/tests/fixtures/placement-b9849-*.txt`; `eval/results/hardware/` |
| HW3 | performed P10 (live, CDP-driven, at `07dd9085`); the four blocked legs CLOSED 2026-09-09 (issue #331) | Passed in the dev app: EN/DE layout at 880/1024/1280 px in both themes with no horizontal overflow, the German rail label at font weight 600 on one line, the keyboard focus order (a real Tab walk in visual order, no trap) and Enter activation. The one failure it found — focus lost after an own run — is the HW3-focus row below (fixed P10). The four legs not exercisable on the review box (no screen reader, no runtime, a first run that finishes in ~120 ms) were performed 2026-09-09 on the E: stick with a moved-drive workspace and a real 14B: **chat-during-a-span and mounted-screen refresh PASSED; both live regions were SILENT under a screen reader (#436, #437 — code fixed 2026-09-10, by-ear re-verification still outstanding) and an automatic run's step list never advances (#438 — decided and fixed 2026-09-12, owner call for option 2: the step list belongs to a run this window started, any other run gets one announced background line; record "An automatic run's step list" above)**. | `GermanSmoke.test.tsx` "PerformanceScreen renders German (PR #303 audit T6)"; `rail-labels.test.ts`; `PerformanceScreen.test.tsx` describe "PerformanceScreen: focus survives the run"; `eval/results/hardware/i7-8700-gtx-1070-ti-8gb-32gb/331-hw3-acceptance-legs.md` |
| HW4 | follow-up issue #332 | Hybrid `[iGPU, dGPU]` Vulkan order and Apple Silicon unified memory: synthetic fixtures only. | — |
| DR1 | fixed P5 `be177a34` | Chat/translation "on the card" rows now respect `gpuMode`, `gpuAutoDisabled` and the matching observed backend, not the hardware class alone. | `performance-gpu.test.ts` "gpuMode 'off': both rows say cpu, the verdict is the processor estimate against RAM, bothOnCard is false — the hardware class is untouched"; "a matching start OBSERVED on the CPU backend puts the chat row on the processor and judges it against RAM" |
| DR2 | fixed P5 `be177a34` | `ModelPlacement.devices` keeps every GPU row of the `device_info` block; `attributedGpuFigures` matches by device name, never the first row's. | `placement-parser.test.ts` "keeps every GPU row of a hybrid device_info block with its own compute buffer, by label (DR2)"; `performance-gpu.test.ts` "a hybrid log: the figures are the selected dGPU's, by name — never the first row's" |
| DR3 | VERIFIED 2026-09-08 (#329) | No code change. Checked across all 32 captured verbosity-4 logs (re-checked on the 33rd, the MoE start added under #391, by the same criteria and with the same result): no `POST /` or `GET /` request line, no `"content"` or `"messages"` JSON body, no prompt or completion text, every `conv_id=` occurrence is `conv_id= (empty=1)`, 163 `<drive>` redactions and zero home paths (`C:\Users`, `/home/`, `/Users/`). Precisely: verbosity 4 raises load-time AND per-request DIAGNOSTIC logging (slot ids, token counts, timings, sampler parameters, cache state — every fixture carries a complete request cycle's metadata, `launch_slot_` through `print_timing` and `release`); it prints no prompt or completion text and no request body. Two caveats: (1) the only conversational-looking text is llama.cpp's own canned `example_format` template probe (`You are a helpful assistant` / `Hello` / `Hi there`), a fixed string it renders through the model's Jinja template at load time, before the server listens — the standing test allows it only inside that block, so a future capture that leaks a real prompt reddens; (2) these committed logs are HAND-redacted raw captures of the app's argv, not sidecar output — the sidecar's own guarantee is the in-memory 4,000-char tail cap plus `redactExactKey`/`redactSidecarSecrets` (`src/main/services/runtime/sidecar.ts:418`, `:436-442`), and it never writes stderr to disk. | `placement-parser.test.ts` describe "the committed load logs carry no request or prompt content (DR3)" |
| DR4 | fixed P6 `9f703b87` | `FIT_TARGET_MARGIN_MB`/`CARD_FREE_SLACK_MB` are named constants in `shared/performance-rules.ts`, interpolated into the copy instead of a hard-coded "1 GB". | `PerformanceScreen.test.tsx` "DR4: all three partial copies state the runtime margin from the shared constant, never a literal" |
| DR5 | fixed P5 `be177a34` (owner ruling) | `loadedAtOnceMb` sums per memory class — see §1's third gate ruling. | `performance.test.ts` "discrete: the chat adds its OBSERVED partial-offload spill; an estimate, a full offload or an unknown split add 0"; `performance-gpu.test.ts` "cpu class: every row counts" |
| DR6 | fixed P3 `3fbc51d0` | The chat row's `loaded` flag comes from `chatModelResident()` (runtime state), not `active() != null`. | `performance-ipc.test.ts` "the chat row is \"loaded\" only once the ACTIVE model is running and ready (DR6)" |
| DR7 | fixed P9 (this phase), with DX2 | "Three cards" corrected to "Four cards". | `benchmark.md` "Performance screen" (this file) |
| DR8 | fixed P1 `5121af46` | `skills.title` (EN/DE), orphaned once `SkillsScreen.tsx` was deleted, removed ahead of the master merge that added the unused-i18n-key guard. | `shared/i18n/en.ts`, `de.ts` (no `skills.title` key) |
| DR9 | verify-only, no action | `navigation.ts`/`App.tsx`/`InformationArchitecture.test.tsx`/`rail-labels.test.ts`/`design-guidelines.md` §2/`user-guide.md` §4 were already consistent at `ce741533`; reconfirmed this phase. | `apps/desktop/src/renderer/navigation.ts`; `apps/desktop/src/renderer/App.tsx` |
| DR10 | verify-only, no action | The optional `isLoaded()` interface members compile safely for every mock/fake implementation; no Electron import added to a service module. | `apps/desktop/src/main/services/*` (interface definitions) |
| DR11 | fixed P9 (the docs commit) | Planned for P8 but missed there, caught by the P9 doc review: the resident-rows test asserted `bothOnCard` against `memoryClass !== 'cpu'` — host-conditional by construction, and wrong on an Apple Silicon host (probe-less class `unified`) where it would have demanded `true` for a model the stub runtime never marks resident. Now a fixed `false`. | `performance-ipc.test.ts` "lists every model the app can hold, with liveness from each service and the totals" |
| R1–R15 | superseded | Corrections to the fix-plan's own first draft, folded into the phase briefs before P1–P8 executed. Each correction's actual resolution is verifiable from the finding row it corrects: R1→M3, R2→M1, R3→M8, R4→H1, R5→M2/M6, R6→L1, R7→L8, R8→the DR1–DR11 rows, R9/R10/R14→procedural (phase sequencing, no doc-visible artifact), R11/R12→§4 (P10, not yet run), R13→this record, R15→M7's doc sentence and SD2's row. | see the cross-referenced rows |

#### Repair rounds after the P10 cross-review

Findings from the two independent reviewers (A = Opus, B = Fable; see "Independent review" in the
working ledger, not reproduced here) and the orchestrator's own HW3 mounted-screen checks, fixed
in the repair round(s) that followed candidate `07dd9085`. IDs keep each reviewer's own prefix
(`A-`, `B-`) or the finding's own tag; none renumbers or replaces an R1–R15 row or an original
audit row above.

| ID | Disposition | Facts as fixed | Evidence |
|---|---|---|---|
| A-D1 | fixed P10 `ab01e14b` | `tryGpuAgain` now pushes `performance:changed` right after it clears `gpuAutoDisabled`/`gpuLastError`, before the re-probe, so the cleared flags reach the screen even when the re-probe cannot run; the probe's own successful-write push follows as a second, idempotent notification. | `performance-notify.test.ts` `it.each`: "\"Try GPU again\" pushes the cleared flags even when the probe cannot run — %s (A-D1)" (cases "no binary for this OS (the probe is never called)", "a rejecting probe") |
| A-D2 | fixed P10 `ab01e14b` | The late-write guard's rejection (a lock, a lock in progress, or a lock-and-re-unlock landing between the benchmark legs and the persist) now throws the localized `tMain('main.benchmark.lockedDuringRun')` message (new EN/DE pair), never a raw English string; the pre-run refusal keeps its own separate `main.benchmark.locked` key. | `first-benchmark-scheduler.test.ts` describe "the late-write guard (runAndPersistBenchmark)": `it.each` "%s between the legs and the persist: rejects, writes nothing, the idle push still follows the release" (cases "a lock completed", "a lock under way (DB open, latch armed)"); "a lock AND a re-unlock between the legs and the persist: rejects (the epoch moved); the same session persists"; "through the scheduler, a refused late persist is a \"failed\" outcome" |
| A-D3 | fixed P10 `ab01e14b` | `attributedGpuFigures` falls back to the legacy first-device figures only when `rows == null` (a placement persisted before per-device rows existed); with any `devices` array present — one row or several — it matches strictly by the selected device's name, returning nulls rather than another device's figures on a mismatch or no selection. | `performance.test.ts` "a lone row that IS the selected device: its own figures, not the legacy summary (A-D3)"; "a lone row that is NOT the selected device (an iGPU-only log beside a selected dGPU), or none selected: null (A-D3)" |
| A-D4 | fixed P10 `ab01e14b` | `read-speed.ts`'s `record()` stamps samples from a monotonically increasing clock: a reading at or before the previously accepted sample's `at` is bumped forward by 1 ms, so two real samples landing in the same millisecond stay distinct to every downstream identity check (`persistedSampleMemo`, `effectiveReadPatch`, `mergeSampleIntoResult`); rejected samples never advance the clock. | `read-speed.test.ts` describe "strictly increasing sample timestamps (PR #303 audit A-D4)"; `performance-persistence.test.ts` describe "strictly increasing sample timestamps (A-D4): same-millisecond samples stay distinct to the persister" — "a model load in the same millisecond as the checksum before it reaches BOTH destinations"; "a checksum in the same millisecond as the model load before it is a distinct, lower-ranked sample: both destinations keep the load" |
| B-G1 | fixed P10 `ab01e14b` | `hasMachineIdentity` now requires `os` and `arch` to be non-empty alongside `cpuModel`/`ramGb` (not just the latter two), so a record missing OS/arch normalizes to a valid dated observation but never yields a half key (`machineKey` null, dropped from history, kept only as an unkeyed current record); `cpuCores === 0` still counts as identity present (a legitimate `os.cpus()` result) — it just cannot veto one. | `benchmark-schema.test.ts` describe "hasMachineIdentity — every field a real detection fills, or none (B-G1)": "a record without os/arch has no identity: machineKey null, dropped from history, kept as an unkeyed current record"; "each identity field is required on its own — os, arch, cpuModel, ramGb"; "a zero core count still identifies a machine: os.cpus() can legitimately be empty" |
| HW3-focus | fixed P10 `ab01e14b` | The busy branch still renders its own subtree (a disabled "Running…" button), so the focused node is unmounted during a run; the screen now REMEMBERS that an own action ("Check again" or "Start … and measure") was activated and, on the busy→idle edge, RESTORES focus to the idle "Check again" button (edge-triggered, once). A run this window did NOT start never moves focus. Mid-run the active element is the body — the tests assert exactly that — and focus returns to "Check again" only, never to "Start … and measure". | `PerformanceScreen.test.tsx` describe "PerformanceScreen: focus survives the run": "returns focus to \"Check again\" after a run this window started"; "returns focus after \"Start … and measure\" too — to the action the idle row keeps"; "a run this window did NOT start never steals focus" |
| #327 | fixed P10 `ab01e14b` | The Diagnostics "Acceleration" line now names the device from the Performance snapshot's eligible `currentGpu` (the same machine-eligible, stamped source `shared/gpu-rules.ts` selects for the screen) instead of the raw probe's `devices[0]`, so a probe stamped for another computer, or a failed snapshot read, leaves the line on the honest CPU wording instead of naming a foreign card. | `GpuSurface.test.tsx` "#327: a probe stamped for ANOTHER computer names no card — the line says CPU"; "#327: a failed performance read leaves the line on the CPU wording, never a throw" |
| B-D1 | fixed P10 `ab01e14b` | `docs/user-guide.md` §5a's "Memory" bullet no longer claims the tile shows which model fits; it now names RAM, processor and the profile only, and points the fit/context claim at the "Your model" row below it (the fit claim was removed from the tile itself at `db7e816a`, M5). | `user-guide.md` §5a "Performance" ("Memory" bullet) |
| B-D2 | fixed P10 `ab01e14b` | The DR2 and DR5 rows above now cite the file that actually holds the quoted test (DR2's hybrid-rows title is in `placement-parser.test.ts`, not `performance.test.ts`; DR5's discrete-spill title is in `performance.test.ts`, not `performance-gpu.test.ts`). | `docs/benchmark.md` §2 DR2, DR5 rows (this file) |
| B-D3 | fixed P10 `ab01e14b` | `docs/user-guide.md` §5a now describes "Start … and measure" as a second button appearing beside "Check again" (never a replacement), and the "Models on this computer" parenthetical names document search, voice AND images as always processor-pinned by design (the vision row's `device` is hardcoded `'cpu'` in `registerBenchmarkIpc.ts`). | `user-guide.md` §5a "Performance" |
| B-D4 | fixed P10 `ab01e14b` | §3 P8's parenthetical no longer calls `4baec2be` "current HEAD" (P9's `07dd9085` is the HEAD at review time); the renderer header comment "Three cards:" → "Four cards" (the four named), the renderer test file's top-of-file comment "three tiles" → "four tiles", and the one stale test title "the three tiles with ratings" → "the four tiles with ratings" — all in this repair round. | `docs/benchmark.md` §3 P8 (this file); `PerformanceScreen.test.tsx` "renders the verdict, the four tiles with ratings, and the context the pick assumes" |
| B-G2 | fixed P10 `ab01e14b` | The L7 row above now cites its renderer half alongside the main-process test; the §5 legend now points DR3 at the "Observed first" paragraph and `security-model.md`'s verbosity note instead of the loosely-resolving "§3 P1". | `docs/benchmark.md` §2 L7 row, §5 legend (this file) |

### §3 Design as built

**P1** (`5121af46`) pinned the two findings the PR's own fifth commit had already resolved (M7,
L7) as maintained regression tests, corrected the one doc sentence that still claimed only
`CPU*` devices were CPU-side, and removed the `skills.title` i18n key that the master merge's
unused-key guard would otherwise have flagged as an orphan. Modules:
`tests/unit/placement-parser.test.ts`, `tests/unit/performance.test.ts`,
`tests/renderer/PerformanceScreen.test.tsx`. Doc: "Observed first" above.

**P2** (`86fa8e10`) added `apps/desktop/src/main/services/benchmark-persistence.ts`, a pure
module of identity/backfill/merge helpers (`sampleEligible`, `eligiblePersistedSample`,
`backfillOutgoing`, `mergeSampleIntoResult`, `effectiveReadPatch`), and rewired
`registerModelIpc.ts`/`registerBenchmarkIpc.ts` to gate every persisted read sample by
`machineKey` before source ranking, write to every eligible destination, and re-resolve after
both benchmark legs. Doc: "Persistence" (Identity-gated carry-forward, Every eligible
destination, Commit-time re-resolution) and "History per machine" (Upgrade backfill, Write
ordering) above.

**P3** (`3fbc51d0`) replaced polling with a payload-free `performance:changed` push
(`main/ipc/performance-notify.ts`), emitted after every relevant mutation (benchmark occupancy,
read-speed samples, placement observations, GPU-probe writes, runtime/residency transitions,
the performance-relevant settings keys); the renderer separates the backend's `running` state
from its own in-flight action and serialises refetches by generation. Doc: "Push, not poll",
"The screen's half of that contract", "Progress", "Observed while you worked" above.

**P4** (`9530b2a5`) added `shared/benchmark-schema.ts`, validating `lastBenchmark`,
`benchmarkHistory` and `modelPlacements` field by field on both `getSettings` and
`updateSettings`, and reused the launch path's own `launchContextTokens` main-side for the
active AND recommended model, plus `placement.observedMismatch` for a measurement whose context
or backend no longer matches the configured launch. Doc: "Schemas and legacy records", "Your
model" (the context-resolution paragraph) above.

**P5** (`be177a34`, CI-green follow-up `f62c4f53` for a test-clock hazard) added
`shared/gpu-rules.ts` (`isUsefulDevice`, `gpuUsefulForProfile`, `primaryUsefulDevice`,
`displayDevice`, `eligibleGpuProbe`) and `shared/performance-rules.ts` (the moved `SLOW_*`/
`USABLE_VRAM_MB` constants), stamped `GpuProbeResult.machineKey`, and made the resident-models
summary class-aware (DR5, the owner ruling in §1). Doc: "Your model" (One eligible source,
Configured execution, Free/compute attribution), "Models on this computer" (the class-aware
summary), the Graphics memory tile paragraph in "This computer." above.

**P6** (`9f703b87`) made `speedIsApprox`/`speedBasisNote`/`buildReport` the single source of
measurement provenance in the renderer, moved the partial-offload margin numbers into named
constants, and reworded the placement copy to say "on this computer" and name the per-drive
replacement rule. Doc: "Speed provenance travels with the figure", "Where the measurement
lives, in the copy" above.

**P7** (`566a1043`) split `maybeRunFirstBenchmark` into a synchronous `prepareFirstBenchmark`
(restore/backfill, runs before auto-start) and an awaitable `scheduleFirstBenchmark` (the
measurement, bounded by `FIRST_BENCHMARK_SETTLE_TIMEOUT_MS`, one continuation on timeout, one
attempt per unlock epoch). Doc: "Scheduling behind the auto-start", "One automatic attempt per
unlock session", "The late-write guard" above.

**P8** (`4baec2be`, P8's commit) closed the remaining wiring and hygiene gaps:
`placement-wiring.test.ts` (the ladder-to-persister path), `answer-speed-wiring.test.ts`, a
shared `closePerformanceFixture()` teardown, and a strengthened `upsertHistory` assertion.
Test-only; no doc section of its own.

**P10** (`ab01e14b`) applied the independent cross-review's repairs, itemized in §2 under
"Repair rounds after the P10 cross-review": the "Try GPU again" push before the re-probe, the
localized late-write refusal, per-device figure attribution for any device list, strictly
increasing sample timestamps, the full machine-identity gate, the keyboard-focus restore on the
busy→idle edge, and the Diagnostics acceleration line reading the snapshot's `currentGpu`
(#327). The design sections above already describe the resulting behaviour.

**P11** (this close-out commit) changed no source: it filed the follow-up issues (#329–#334
for the open acceptance, #335 for test hygiene outside this wave), filled this record's issue and
commit references, and added the changelog entry.

### §4 Not verified here

- **HW1** — **verified 2026-09-07** (issue #330): the physical A→B→A move ran on two real
  computers with one encrypted exFAT SSD, for a fresh workspace and for an upgraded one created
  by 0.1.57 (keyed `lastBenchmark`, no history). Every acceptance box passed; the step record and
  evidence live in `eval/results/hardware/330-round-trip-20260907/00-protocol.md`. Side findings
  from the run, none of them a persistence defect: the unlock-time GPU probe could race the
  auto-start and cache an empty answer for the session (#380, fixed 2026-09-08, PR #407); the Copy report's live "next
  start" line under an "Another computer" heading (#381); a fresh workspace hashing every weight
  before a model can be chosen (#382, FIXED 2026-09-08 — the Models screen verifies lazily and the
  full pass moved to an explicit "Check all model files" action; `architecture.md` RT-3
  amendment); `gpuAutoDisabled` is workspace-wide, not machine-stamped;
  a USB bus reset drops the decrypted WAL and the next unlock simply restores again
  (`known-limitations.md` "Performance screen and per-computer history").
- **HW2 / T9** (closed 2026-09-08, #329): real b9849 partial- and full-offload load logs are
  captured and pinned as `apps/desktop/tests/fixtures/placement-b9849-*.txt`, and both
  `placement-parser.test.ts` and `placement-wiring.test.ts` read them. Still unwitnessed by any
  capture, so still handwritten from ggml's naming convention: CUDA and Metal devices, a
  `<Backend>_Host` **KV** buffer (M7), and two GPUs both holding weights (HW4 / #332).
- **HW3** — the P10 review passed EN/DE layout at 880/1024/1280 px in both themes, the German
  rail label at font weight 600, the keyboard focus order and Enter activation; the focus loss it
  found is fixed (HW3-focus). Its four unexercisable legs are **CLOSED 2026-09-09** (issue #331),
  performed on the E: stick against a workspace created on a SECOND computer with the 14B active
  — so the check really was a moved-drive `new-machine` run behind a 66 s model start, not the
  ~120 ms first run the review box could never observe (reproduced here: a fresh workspace would
  not have helped either, since `activeModelId` starts null and nothing precedes the check).
  Evidence + protocol:
  `eval/results/hardware/i7-8700-gtx-1070-ti-8gb-32gb/331-hw3-acceptance-legs.md`.

  **Passed.** A moved-drive check observed from window-open through completion (13.7 s), the
  screen moving from the outgoing computer's result to this one's with no navigation. A
  foreground chat inside a benchmark span: both halves of M1 hold — a chat never masquerades as a
  span (1,345 samples, `running` false) and never hides a real one (`streaming` and `running`
  both true). The overlap is only ~130–270 ms, and that is STRUCTURAL, not a defect: `modelBusy`
  is re-checked inside the speed leg, so a chat arriving during it ends the span. A model load
  (120.3 MB/s, 9.0 GB) and a full file verification (85.5 s forced re-hash; 242 s for the whole
  #382/#420 pass on a cold cache) each refreshed the observed rows and the drive tile in place,
  matching what was persisted.

  **Failed — three defects, filed separately.** Under Narrator, against a positive control that
  proved live regions DO work in this window, **neither** live region on the screen was announced.
  The progress steps were inserted already containing their content, and progress rode only on a
  CSS class and an `aria-hidden` icon, so there was nothing to announce even once that was fixed
  (#437). Worse, the FAILURE BANNER was silent too (#436): `ErrorBanner`'s always-mounted
  `role="alert"` wrapper was defeated by the `Banner` nested inside it, whose `role="status"` is
  itself a live region mounted WITH its text — M-U1 reintroduced one level down, on a component
  11 screens and the workspace gate's #145 fix depend on. A control isolated the fix: an inner
  `aria-live="off"` does NOT help; the inner role has to go. And an automatic run's step list
  never advances, because progress is addressed to the window that pressed the button while the
  screen renders the list for any held span (#438).

  **#436 and #437 fixed 2026-09-10** (`fix/436-437-live-region-announce`). `Banner`'s `role` prop
  now takes `null` — no role at all — and `ErrorBanner` passes it, so its wrapper is the only live
  region in the subtree; the same defect in `ModelsScreen`'s hand-rolled copy of that wrapper (two
  more nested `role="status"` Banners, beyond the blast radius #436 stated) went with it. The step
  list is mounted unconditionally and each step's state now lives in its accessible text — an
  `aria-hidden` visible label beside an sr-only "<step>: <state>" twin, so an advance is a
  whole-line text change rather than a CSS class — plus `aria-current="step"` on the active step.
  A repo-wide guard (`tests/unit/live-region-nesting.test.ts`) parses every renderer `.tsx` and
  fails on any live-region role nested inside another; it flags all three pre-fix sites.
  **The acceptance is not complete:** both issues require re-verification BY EAR (a real failure
  and a wrong-password unlock for #436; a real multi-second check for #437), and that needs a
  screen reader on this box. What is pinned so far is the DOM, not the sound.

  **#438 decided and fixed 2026-09-12 (owner call, option 2).** Design record: "An automatic run's
  step list" under "Performance screen" above. It lands on the same subtree, so its by-ear leg
  folds into the one session #436/#437 still owe — the automatic check now SAYS something where it
  previously said nothing, and that line is what the session has to hear.
- **HW3-focus**: the keyboard-focus-after-a-run fix (`PerformanceScreen.test.tsx` "PerformanceScreen:
  focus survives the run") is pinned in jsdom and was re-verified live at P11 in the dev app
  built from `ab01e14b`: with "Check again" focused, a real Enter press ran the check (the
  "Checked" time advanced) and the active element was the "Check again" button again once the
  idle row returned — twice in a row. Announcements were audible-tested separately on
  2026-09-09 (HW3 above, issue #331): the focus behaviour is unaffected, but neither live region
  on the screen was announced (#436, #437 — both fixed 2026-09-10, by-ear re-verification still
  outstanding; see HW3 above).
- **HW4** (follow-up issue #332): a hybrid `[iGPU, dGPU]` Vulkan enumeration order and Apple
  Silicon `unified` memory. P5's device-pairing logic is exercised only by synthetic
  two-device fixtures.
- **I5** — **CLOSED 2026-09-09** (issue #333): `performance:get`'s synchronous `discoverManifests`
  scan measured about 100 ms in one dev-build launch smoke (P3) — on the INTERNAL disk, while the
  launchers set `HILBERTRAUM_MANIFESTS_DIR` to the drive's own copy, so the figure on record was
  of the wrong medium. Instrumented 2026-09-08 (`discover_manifests` + `performance_get` marks,
  above, and `scripts/measure-manifest-read.mjs`) and **measured 2026-09-09 on the drive**, cold
  and end to end — evidence
  `eval/results/hardware/i7-8700-gtx-1070-ti-8gb-32gb/manifest-read-333-measurement.txt`
  (i7-8700 idle, E: stick, 28 manifests / 90.6 KiB; each cold sample took a software eject plus a
  physical unplug/replug, with no Explorer access to the drive in between).

  **Cold** (3 samples): 90.3 / 75.6 / 92.2 ms — reads at ~1.6 ms per file open, i.e. per-open
  LATENCY, since 90.6 KiB is ~3.6 ms of bandwidth even at 25 MB/s. A catalog's FILE COUNT
  therefore drives this, not its size (relevant to #311, which would add manifests). Paid once
  per session, beside a model load that moves gigabytes.
  **Warm, end to end through the real app** (20 reads in one session — three checks, a
  "Start … and measure" with a real model start, several re-mounts): median **27 ms**, of which
  the scan is 18 ms and the settings read + `detectSystem()` the other ~9 ms; 82 % of the scan's
  own warm cost is YAML parse + `validateManifest`, CPU that no drive speed moves.

  **Decision (owner, 2026-09-09): the cost is acceptable as measured — closed, NO cache.** Three
  findings carried it. A perfect manifest cache takes the median 27 ms → ~9 ms, so the available
  saving is 18 ms on a screen that is pushed, not polled. The session's slowest read (116 ms) had
  a 15 ms scan inside it — the rest was the settings read contending with the benchmark's own
  drive probe, so a cache would not have touched the tail. And the Performance screen is a
  minority caller: 66 scans in the session against 20 `performance_get`, the other 46 from the
  twelve remaining call sites. Against that, a cache would land on all 13 (the spec §7.4 install
  gate and the ship-time commercial gate among them) and reverse the recorded PF-4 ruling
  ("deliberately NO stateful module cache", `docs/build-log.md` 2026-07-10).
  **Not measured, and accepted:** a genuinely slow stick (E: reads ~116 MB/s; the #334 SSK stick
  is 28 MB/s). The cold cost here is per-open latency and the warm cost is CPU, and neither
  scales with sequential speed — a 4× slower medium moves the ~40 ms read component of the cold
  sample, not the 27 ms warm median the decision rests on. A correction to the pre-measurement
  analysis, recorded because it narrowed the exposure: the app has ONE main window, so the
  answer-speed push only causes a read while Performance is actually mounted, which cannot
  coincide with chatting on another screen.
- **I6** — **verified 2026-09-08** (issue #334): the P7 sequencing ran on real slow media — an
  SSK USB stick (28 MB/s cold read on the i7-8700's slow port, 133 MB/s on a Surface's; 87–91 MB/s
  as the app hashes there) carrying the 9B, moved from the #330 computer B to an i7-1185G7 /
  Iris Xe Surface with 15.8 GB. Every box: hash and load observable (68 s + 91 s), no benchmark
  I/O inside either (the continuation's drive probe 0.4 s after `runtime_ready`), the 120 s
  deferral fired and the continuation measured the started runtime (8 tok/s), a missing-file
  start failure let the check run at once without a speed leg, and the manual-overlap gap was
  MEASURED: a Models-screen hash beside the auto-start slowed its hash 3.3× and its load 1.5×,
  and a "Use model" press 2.8 s after settlement stopped the auto-started model under the speed
  leg (the run ended in 3.4 s) — bounded harm, profile and ★ unchanged. Side findings: a
  Models-screen hash lets the page-cache load sample through the #108 guard (589 MB/s persisted
  for a 28 MB/s stick); the Home preflight's 8 MiB probe runs at unlock beside the hash; a healthy
  start at 87 MB/s on a 16 GB machine settles at 159 s, past the bound.
  Follow-ups: #392 (the read sample — fixed 2026-09-08, PR #406: a start of a weight hashed anywhere
  in the session records no load sample), #393 (the overlap fix — FIXED 2026-09-08, PR #405: the
  speed leg's busy predicate also reads `startingModelId` and the identity of the runtime it
  captured, and a stream the stop cuts warns instead of returning null silently). Record:
  `eval/results/hardware/334-slow-usb-20260908/00-protocol.md` (+ reports, logs, perf marks).

### §5 §-anchor legend

For a citation to an ID that is not self-explanatory from §2 alone:

- **M1, M3, L3, DR6, N2, SD1, T1, T3, T4, T5** → §3 P3; doc: "Push, not poll", "The screen's
  half of that contract", "Progress", "Observed while you worked."
- **M2, M4, M6, L2, T2** → §3 P2; doc: "Persistence", "History per machine."
- **M7, L7, T9 (fixtures), T10 (L7 half)** → §3 P1; doc: "Observed first."
- **DR3** → doc: the "Observed first" paragraph under "Your model" (this file) and
  `docs/security-model.md`'s "The chat sidecar's `-lv 4` verbosity" paragraph — not §3 P1.
- **H1, L8 (schema half), T10 (L8 half), M5 (residual)** → §3 P4; doc: "Schemas and legacy
  records", "Your model" (context/configuration-match paragraphs).
- **M8, N1, N3, DR1, DR2, DR5, DR10, T12** → §3 P5; doc: "Your model" (One eligible source,
  Configured execution, Free/compute attribution), "Models on this computer", the Graphics
  memory tile paragraph in "This computer."
- **L6, L8 (copy half), N4, N5, DR4, T6** → §3 P6; doc: "Speed provenance travels with the
  figure", "Where the measurement lives, in the copy."
- **L1, SD2** → §3 P7; doc: "Scheduling behind the auto-start", "The late-write guard", "One
  automatic attempt per unlock session."
- **T7, T8, T11, TH1, TH2** → §3 P8 (test-only; no doc section).
- **DR11** → its own §2 row only: planned for P8, missed there, fixed in the P9 commit (a
  test-hygiene gap, not a product defect; no doc section).
- **D1** → `docs/user-guide.md` §5a. **D2** → `docs/architecture.md` (the two historical
  rail-count paragraphs). **D3** → `docs/security-model.md` SEC-N2. **D4, DR9** → verify-only;
  `apps/desktop/src/renderer/navigation.ts` and `App.tsx` (unchanged). **D5, L4** →
  `PRIVACY.md` "What data is stored, and where."
- **L5, part of SD2** → `docs/known-limitations.md` "Performance screen and per-computer
  history (PR #303 audit)."
- **DX1** → §3 P3 (contradiction removed). **DX2, DR7, N7** → this file, the "Four cards" list
  and "Other computers this drive has been used on."
- **DR8** → §3 P1 (the master merge and the orphaned i18n key).
- **N6, I5** → §4 (measured once, not yet cached).
- **HW1–HW4, R11, R12** → §4 (acceptance: HW3 performed at P10; the rest, and HW3's blocked legs, are issues #329–#334).
- **R1–R15** → §1 (the three gate rulings) and the §2 row each correction maps to (see the
  R1–R15 row's cross-references).
