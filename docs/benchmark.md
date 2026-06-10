# Hardware benchmark & model recommendation (Phase 7)

_Last updated: 2026-06-09 — Phase 7 (updated Phase 10: real tokens/sec)._

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
2. **GPU** (Phase 16, [`gpu-support-plan.md`](gpu-support-plan.md) §5.1/§8): the IPC layer runs
   the **session-cached `llama-server --list-devices` probe** on the drive's own sidecar binary
   (`services/runtime/gpu.ts` — an offline subprocess, kill-timeout-bounded, never throws) and
   **injects** the summary into `runBenchmark` (`RunBenchmarkDeps.gpu: { name, useful }`).
   `benchmark.ts` itself keeps its **zero-`child_process` purity** — it never probes. The probe
   result is also persisted to `settings.gpuProbe` for Diagnostics. With no binary / no devices /
   a failed probe, `gpu` stays `null` and nothing blocks.
3. **Drive speed** (`measureDriveSpeed`): writes a small temp file
   (`DRIVE_PROBE_BYTES = 8 MB` of random bytes) **inside the workspace**, times a sequential
   write (with `fsync`) then a read, and reports MB/s. The temp file is **always removed**
   (`try/finally`), the probe is **bounded** (8 MB) so it never hangs the UI, and any failure
   returns `null` Mbps + an `error` string instead of throwing.
4. **Tokens/sec** (`measureTokensPerSecond`): **optional**. Only runs when a runtime is
   active — it streams the prompt *"Write one sentence about privacy."* and times up to 64
   tokens. It is `null` when no runtime is running. **Phase 10:** because `measureTokensPerSecond`
   drives off `runtime.chatStream`, this is now a **real** figure whenever the real `LlamaRuntime`
   is streaming (it remains a simulated figure under the mock runtime). The low-tokens/sec profile
   **downgrade** and the GPU **bump** therefore become live with real local inference.

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
  step (never below `TINY`).

## Recommendation

The profile is fed to the existing `recommendModelId(manifests, profile, 'chat')`, which
matches a manifest whose `recommended_profiles` includes the profile. With the committed
manifests:

| Profile | Chat model |
|---|---|
| TINY / LITE / UNKNOWN | `qwen3-4b-instruct-q4` |
| BALANCED | `qwen3-8b-instruct-q4` |
| PRO | `qwen3-14b-instruct-q4` (spec §7.3 "8B or 14B") |

(`qwen3-1.7b-instruct-q4` was the TINY/UNKNOWN model in the original spec §7.3 table, but it was
dropped — the official `Qwen/Qwen3-1.7B-GGUF` repo ships no Q4_K_M — so `qwen3-4b-instruct-q4`,
the smallest bundled chat model, now also covers TINY + UNKNOWN. See BUILD_STATE §9.)

The larger `qwen3-30b-a3b-q4` (MoE) carries an **empty** `recommended_profiles`, so it is never
auto-recommended — it stays selectable on the Models screen as a deliberate opt-in (it needs ~20 GB
RAM but runs near-3B speed). Each profile is claimed by exactly one chat model, so the first-match
`recommendModelId` is unambiguous.

## Warnings (spec §11.3 + §11.4)

`buildWarnings(...)` is **encouraging, never judgmental** — it never says "your hardware is
bad":

- **TINY** → *"This device is best suited for Fast Mode. Larger models may run slowly."*
- **UNKNOWN** → a friendly "we picked a safe, lightweight model" note.
- **Slow drive** (read or write `< SLOW_DRIVE_MBPS = 30` MB/s) → a non-blocking "models will
  still work, but loading may take longer" note. Slow drives **warn, never block**.
- **Drive un-measurable** → "drive speed could not be measured; recommendation uses RAM + CPU
  only."

## Persistence

Spec §8 defines **no `benchmarks` table**, so the last result is persisted via the **settings
store** as `AppSettings.lastBenchmark` (a JSON `BenchmarkResult`, default `null`).
`runBenchmark()` writes it after each run. Downstream reads use `lastBenchmark.profile`,
falling back to **`UNKNOWN`** until the user runs the benchmark for the first time:

- `getAppStatus().hardwareProfile` (Home screen).
- `buildModelList({ profile, … })` (Models screen `recommended` flag).

The Diagnostics screen surfaces a **Run benchmark** button and renders RAM / CPU / OS-arch /
drive read-write / tokens-sec / assigned profile / recommended model + the warnings, and
re-loads the last result from settings on mount.
