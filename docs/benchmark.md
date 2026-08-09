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
4. **Tokens/sec** (`measureTokensPerSecond`): **optional**. Only runs when a runtime is
   active — it streams the prompt *"Write one sentence about privacy."* and times up to 64
   tokens. It is `null` when no runtime is running. Because `measureTokensPerSecond`
   drives off `runtime.chatStream`, this is now a **real** figure whenever the real `LlamaRuntime`
   is streaming (it remains a simulated figure under the mock runtime). The low-tokens/sec profile
   **downgrade** and the GPU **bump** therefore become live with real local inference.
   **The number measures the CURRENTLY LOADED model, not the recommended one** (issue #52):
   `runBenchmark` records the loaded model's id as `BenchmarkResult.measuredModelId` (null when
   nothing was measured; absent on results persisted before the field existed), and the
   Diagnostics card + its Copy text render the value as *"30 (measured with the loaded model
   \<id\>)"* so the tok/s can't be misread as a property of the recommended model.

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
  step (never below `TINY`). Since issue #52 this is **no longer silent**: when the reading
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
| ≤ 12 GB | `qwen3.5-4b-ud-q4kxl` |
| 16–20 GB | `qwen3.5-9b-ud-q4kxl` |
| 24 GB | `qwen3.6-27b-q4` |
| ≥ 32 GB | `qwen3.6-27b-q5` |

(This is the newest-Qwen promotion, owner decision 2026-07-12; see `model-benchmarks.md` §6.4.
The **bundled** default on a preconfigured drive stays `qwen3-4b-instruct-q4` — the promotion
deliberately did NOT change the bundled model; the tiers above are the RAM-best-fit
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
`runBenchmark()` writes it after each run. Downstream reads use `lastBenchmark.profile`,
falling back to **`UNKNOWN`** until the user runs the benchmark for the first time:

- `getAppStatus().hardwareProfile` (Home screen).
- `buildModelList({ profile, … })` (AI Model screen `recommended` flag).

The Diagnostics screen surfaces a **Run benchmark** button and renders RAM / CPU / OS-arch /
measured read speed (`effectiveRead`, with its source + GB context, or "not measured yet") /
drive write / tokens-sec / assigned profile / recommended model + the warnings, and re-loads the
last result from settings on mount. The `effectiveRead` field is additionally **updated in
place** on the persisted result outside benchmark runs (`persistEffectiveRead` in
`registerModelIpc`) as model starts / Models-screen visits / forced re-verifies observe fresh
samples, and `runBenchmark` receives the latest sample **injected**
(`RunBenchmarkDeps.effectiveRead`, the GPU-probe injection pattern — this module measures
nothing itself), carried forward from the previous result so a re-run never loses it.

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
