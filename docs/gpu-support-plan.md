# GPU Support Plan — llama.cpp sidecar acceleration

_Status: **ACCEPTED 2026-06-10 — ready to implement (Phases 14–16, §12); nothing implemented
yet.** Written against the pinned llama.cpp **b9585** and the Phase-13-complete codebase. All
§13 review questions are **decided**; do not re-litigate them during implementation — note
deviations in §13 and BUILD_STATE if reality forces a change._

---

## 1. Summary (the decisions, in one screen)

| Decision | Choice | Why (short) |
|---|---|---|
| GPU backend (Win + Linux) | **Vulkan** | One ~37 MB build covers NVIDIA + AMD + Intel with standard drivers; CUDA is NVIDIA-only and ~620 MB |
| Build shipped per OS | **The Vulkan release build replaces the CPU build as the default** in `runtime/llama.cpp/<os>/` — it *contains* the full CPU backend set, so it degrades to today's CPU behavior on GPU-less machines | Verified by unpacking the b9585 assets: the win/linux Vulkan archives ship `llama-server` + **all** `ggml-cpu-*` variant libraries + the Vulkan backend, loaded dynamically (`GGML_BACKEND_DL`) |
| CPU-only safety net | Additionally ship the pure-CPU build at `runtime/llama.cpp/<os>/cpu/` (+17 MB win / +15 MB linux) — **decided: yes** | Last-resort escape if the mere presence of `ggml-vulkan` destabilizes a machine (broken loader/AV edge cases) |
| User control | **GPU is always the default.** Only a detected problem (the fallback ladder) moves a machine to CPU. A "Use GPU acceleration" toggle lives in **Settings** (default on), plus a "Try GPU again" reset in Diagnostics | Review decision Q2 |
| `-ngl` strategy | **Pass nothing.** b9585 defaults to `-ngl auto` + `--fit on` (VRAM-aware auto-offload, 1 GiB margin) | Upstream already solved VRAM fitting; we force CPU with `--device none` instead of `-ngl 0` |
| GPU detection | **Both**: an upfront `llama-server --list-devices` probe (Diagnostics + profile) **and** try-GPU-then-health-check-fallback at start (the actual guarantee) | The probe can't prove inference works; the fallback ladder can't name the GPU for the UI |
| Fallback mechanism | Start normally → on failure restart with `--device none` → on failure use `<os>/cpu/` build → mock (existing rule) | Worst case is exactly today's behavior; the app can never be *stuck* |
| macOS | **No change.** arm64 already runs Metal with auto-offload; Intel-x64 Macs stay CPU (upstream disables Metal there) | Verified: mac arm64 build has Metal; `-ngl` defaults to auto |
| Embedder (E5) | **Forced CPU** (`--device none`) | 384-dim/~0.24 GB model gains little; keeps ingestion immune to GPU flakiness and VRAM contention — see §7 |
| New npm deps | **None.** Probe + fallback use `node:child_process` on our own shipped binary | Project theme: no native/fragile deps |

**Size delta per drive:** Windows +56 MB download / +166 MB on disk; Linux +58 MB / +185 MB;
macOS 0. Negligible next to multi-GB weights. Details in §10.1.

**Two corrections to the Phase-12-era assumptions** (verified against b9585 — see §3):
1. `-ngl` is **no longer needed**: since upstream PR #15434 (Aug 2025) `llama-server` defaults to
   maximum GPU offload with VRAM auto-fit. "A GPU build would still run CPU-only without `-ngl`"
   is no longer true — *drop a Vulkan build in and the GPU lights up with our current spawn args.*
2. The Windows/Linux **Vulkan release archives are standalone full builds including every CPU
   backend variant** (dynamic backend loading). "GPU build fails or runs worse on a non-GPU
   machine" does not apply to Vulkan-the-archive: with no usable Vulkan device it *is* the CPU
   build, ~70 MB heavier.

---

## 2. Hard rules (restated — these bound every choice below)

- **100% offline at runtime.** GPU builds are fetched at drive-build time by `fetch-runtime` like
  every other asset. The GPU capability check is a local subprocess of a binary already on the
  drive — no network, no remote probes, no telemetry, ever.
- **Plug-and-play, zero technical knowledge.** No driver installs, no settings required. GPU is
  automatic when it works, invisible when it doesn't. A failed GPU attempt must never leave the
  user stuck; worst case is the current CPU experience.
- **No new native npm dependencies; no fragile native builds.** The probe spawns our own
  `llama-server` (pure `child_process`), the same way the sidecar already spawns it.
- **`ModelRuntime`/`Embedder` interfaces and the graceful-fallback rule stay intact.** The app
  must launch and the full suite must pass with zero model files, zero binaries, and zero GPUs
  (the CI default).
- **Localhost-only sidecar binding** is untouched (`--host 127.0.0.1`).
- **Friendly copy per spec §11.4** — never "your hardware is bad"; CPU mode is presented as
  normal, not degraded.
- All current tests stay green; per-phase ritual applies (tests → build → docs → BUILD_STATE →
  commit) for each phase in §12.

---

## 3. What the research established (b9585, verified 2026-06-10)

### 3.1 Release assets that matter (sizes from the GitHub API)

| Asset | Download | Extracted | Notes |
|---|---|---|---|
| `llama-b9585-bin-win-cpu-x64.zip` | 16.0 MB | 47.5 MB | **current pin** — hash re-verified today, matches `runtime-sources.yaml` |
| `llama-b9585-bin-win-vulkan-x64.zip` | 36.6 MB | 118.0 MB | full build: `llama-server.exe`, 12× `ggml-cpu-*.dll`, `ggml-vulkan.dll` (73.8 MB) |
| `llama-b9585-bin-ubuntu-x64.tar.gz` | 14.7 MB | 43.1 MB | **current pin** — hash re-verified today |
| `llama-b9585-bin-ubuntu-vulkan-x64.tar.gz` | 36.5 MB | 114.3 MB | full build incl. all CPU variants + `libggml-vulkan.so` (74.7 MB) |
| `llama-b9585-bin-macos-arm64.tar.gz` | 10.1 MB | — | **current pin**; Metal enabled upstream — Macs already use GPU today |
| `llama-b9585-bin-win-cuda-12.4-x64.zip` | 248.9 MB | — | + requires `cudart-…-12.4.zip` (373.3 MB) — rejected, see §4.2 |
| `llama-b9585-bin-win-cuda-13.3-x64.zip` | 151.5 MB | — | + `cudart-…-13.3.zip` (372.8 MB) — rejected |
| `llama-b9585-bin-win-hip-radeon-x64.zip` | 306.2 MB | — | AMD-only (HIP) — rejected; Vulkan covers AMD |
| `llama-b9585-bin-ubuntu-rocm-7.2-x64.tar.gz` | 124.9 MB | — | AMD-only — rejected |
| `llama-b9585-bin-macos-x64.tar.gz` | 10.3 MB | — | CPU-only (upstream builds it with `GGML_METAL=OFF`); we currently ship no mac-x64 build at all — unchanged, see §6 |

SHA-256 captured from today's downloads (promote into `runtime-sources.yaml` during
implementation as the deliberate, reviewed pin this repo requires):

```
af6b1b94377b9f78dbb2285b878fb696d36766391499d65e055ecd622b69018a  llama-b9585-bin-win-vulkan-x64.zip
5f5467e5d9827b27eda17ee39b35fd2b7c8aa298f144e8836491ccec76160fdf  llama-b9585-bin-ubuntu-vulkan-x64.tar.gz
```

### 3.2 Behavior of b9585 `llama-server` (from `common/arg.cpp` at the tag + server README)

- `-ngl / --n-gpu-layers` **default = `auto`** ("max. number of layers to store in VRAM, either an
  exact number, 'auto', or 'all'"). Upstream PR #15434 (merged 2025-08-30) made max-GPU-layers the
  default.
- `--fit` **default = `on`** ("whether to adjust unset arguments to fit in device memory") with
  `--fit-target` (default 1024 MiB per-device margin) and `--fit-ctx` (min context the fitter may
  shrink to, default 4096). I.e. **VRAM-aware partial offload is upstream's job now.**
- `--device <list>` accepts **`none`** ("don't offload") → forces pure-CPU inference *in the same
  binary*. This is our CPU-fallback switch.
- `--list-devices` prints the device list **and exits** — an offline, no-model, sub-second probe.
  Verified live on the dev machine with the b9585 Vulkan build:

  ```
  Available devices:
    Vulkan0: NVIDIA GeForce RTX 3080 Ti (12300 MiB, 11511 MiB free)
  ```

  On a machine with no usable Vulkan (missing `vulkan-1.dll`/`libvulkan.so.1`, no 1.2-capable
  driver, RDP session without GPU), the dynamic backend library simply fails to load or
  enumerates zero devices → the list is empty → the same binary runs on its bundled CPU backends.

### 3.3 Driver baseline for Vulkan (what "works on a standard machine" means)

ggml's Vulkan backend needs a **Vulkan 1.2-capable driver**. In practice: NVIDIA Kepler/Maxwell+
(any driver from ~2019 on), AMD GCN+ (Adrenalin on Windows, Mesa RADV on Linux), Intel Gen9/
Skylake+ (Windows driver or Mesa ANV). These ship with the OS's normal GPU driver — **no SDK, no
runtime install**: the Vulkan loader (`vulkan-1.dll`) is installed by every GPU driver on
Windows 10/11. Machines older than that fail the probe cleanly and stay on CPU. (Treat the exact
generation cut-offs as estimates to confirm on the manual matrix, §11.2.)

---

## 4. Recommended approach and alternatives considered

### 4.1 Recommended: Vulkan-default single binary + CPU safety net + `--device none` ladder

Ship the **Vulkan full build** where the CPU build sits today (`runtime/llama.cpp/<os>/`), keep
the **pure CPU build** in `runtime/llama.cpp/<os>/cpu/` as a last resort, and let the app walk a
three-rung fallback ladder (§5). macOS is already done (Metal, auto-offload).

Why this shape:

- **Plug-and-play is preserved by construction.** The default binary *is* a CPU binary on
  machines without a GPU — no decision logic has to run before first token for the common cases.
- The fallback ladder turns the remaining edge cases (flaky driver, mid-generation crash) into
  the current CPU experience automatically.
- `resolveLlamaServerPath` keeps resolving the same flat path → **existing DIY drives keep
  working untouched** (their flat dir holds a CPU build; no GPU, no change).

### 4.2 Alternatives considered (and why not)

| Alternative | Verdict | Rationale |
|---|---|---|
| **CUDA (Windows/Linux NVIDIA)** | Rejected as default; schema leaves the door open | +~620 MB (build + cudart) per drive for **NVIDIA-only**; needs driver ≥ the CUDA 12.4/13.3 baseline; cudart/cuBLAS are proprietary redistributables → real license-review burden. Vulkan reaches ~85–95 % of CUDA token-generation speed on NVIDIA in current llama.cpp; the gap is mostly prompt-processing. Not worth 17× the bytes and a third of the hardware. |
| **HIP/ROCm (AMD)** | Rejected | AMD-only, 125–306 MB, narrow officially-supported GPU list. Vulkan covers AMD with the standard Adrenalin/Mesa driver. |
| **CPU-build default + separate opt-in GPU build dir** (the original Phase-12 sketch) | Rejected | Requires the app to *choose* a binary before knowing if GPU works, doubles the health-check matrix, and contradicts "automatic and invisible". The Vulkan build's built-in CPU backends make the two-dir split unnecessary for the default path. |
| **Vulkan build only, no `<os>/cpu/` safety net** | Viable, −17/−15 MB | Rung 2 (`--device none`) already covers everything except "process can't even start because the Vulkan backend library wedges on load" — rare (AV interference, corrupt loader). I recommend paying ~32 MB total for the guarantee; **flagged as open question Q1**. |
| **Upfront probe decides everything (no try-then-fallback)** | Rejected as sole mechanism | `--list-devices` proves enumeration, not stable inference. A driver can list fine and crash on the first compute submit. The health-check ladder is the actual guarantee; the probe is for UI/profile. |
| **In-house GPU detection (registry/wmic/`navigator.gpu`/native module)** | Rejected | Either native deps, platform-specific scraping, or renderer-side info the main process can't trust for spawning. `--list-devices` *is* ggml's own truth about what it will use — zero extra deps. |

---

## 5. Detection & fallback design

### 5.1 New module: `services/runtime/gpu.ts`

```ts
export interface GpuDevice {
  id: string            // "Vulkan0"
  name: string          // "NVIDIA GeForce RTX 3080 Ti"
  totalMb: number       // 12300
  freeMb: number        // 11511
}

// Spawns `<binPath> --list-devices`, parses stdout, kills on timeout (3 s).
// Never throws: any failure → []. Pure parsing split out for unit tests.
export async function probeGpuDevices(binPath: string, deps?: { spawn?, timeoutMs? }): Promise<GpuDevice[]>
export function parseListDevices(stdout: string): GpuDevice[]          // pure, fixture-tested
export function looksIntegrated(name: string): boolean                 // heuristic, see §8
```

Probe properties: offline (subprocess of a drive-local binary), no model needed, sub-second,
bounded by a kill-timeout, cached — run at most once per app session and persisted (§5.4).
`benchmark.ts` keeps its "no `child_process`" purity: the probe result is **injected** into
`runBenchmark` via deps (§9), never probed inside the benchmark module.

### 5.2 The start ladder (in `createSelectingRuntimeFactory` / `LlamaServer` orchestration)

```
start(model) requested, settings.gpuMode = 'auto' (default)
│
├─ Rung 1 — GPU: spawn <os>/llama-server, NO -ngl/-device args
│            (b9585 defaults: ngl=auto + fit=on → VRAM-aware offload; on a GPU-less
│             machine this IS CPU mode already — ladder ends here for almost everyone)
│   └─ healthy within timeout? → done. backend = gpu|cpu per probe result.
│
├─ Rung 2 — same binary, forced CPU: respawn with `--device none`
│            (triggered by: spawn error, exit-before-healthy, health timeout)
│   └─ healthy? → done. backend = cpu. Record gpuFallbackReason (stderr tail).
│
├─ Rung 3 — pure CPU build: <os>/cpu/llama-server (if present)
│            (triggered by: rung 2 also failed — implies the binary itself is the problem)
│   └─ healthy? → done. backend = cpu.
│
└─ Rung 4 — existing graceful fallback: MockRuntime (unchanged rule)
```

- `gpuMode = 'off'` (settings) skips straight to rung 2 behavior (default binary +
  `--device none`); the pinned-build behavior of today. **GPU (`'auto'`) is always the default**
  — `'off'` exists only as an explicit user choice in Settings or as the automatic result of a
  detected problem (`gpuAutoDisabled`), never as a shipped default.
- **Persistence:** a rung-1 failure sets `settings.gpuAutoDisabled = true` with
  `gpuLastError` (timestamped, stderr tail). Subsequent starts begin at rung 2 — no
  repeated 60 s GPU health timeouts. Diagnostics shows this state with a friendly note and a
  "Try GPU again" action that clears the flag (e.g. after a driver update).
- **Why not probe-then-decide for rung 1?** The probe runs anyway (UI/profile), and if it
  returns zero devices we *know* rung 1 ≡ CPU, so we can skip persisting anything. But a
  non-empty probe still doesn't guarantee inference works — the ladder stays.

### 5.3 Mid-generation failures (driver crash / VRAM exhaustion while running)

Today: sidecar dies → in-flight `chatStream` fetch rejects → `chat:error:<id>` → user sees an
error; next `startRuntime` respawns. New behavior on top:

- `LlamaServer` already records unexpected exit (`exited`, `exitCode`, stderr tail). Add an
  `onUnexpectedExit` hook. When the active backend was GPU:
  1. Set `gpuAutoDisabled = true` + `gpuLastError`.
  2. `RuntimeManager` auto-restarts the same model at rung 2 (CPU) **once**, so the *next*
     message just works.
  3. Surface a one-line, friendly notice (spec §11.4 tone):
     *"Switched to compatibility mode for stability. Everything keeps working — responses may
     be a bit slower."* Never "your GPU crashed".
- The in-flight generation is lost (same as today's crash handling); the partial reply is
  persisted by the existing cancellation path.
- **VRAM exhaustion at load** is upstream-handled (`--fit` partial offload, min-ctx guard).
  **VRAM exhaustion mid-run** (another app grabs VRAM) presents as a server error/exit → the
  flow above. No special casing.

### 5.4 Where GPU state lives

| Datum | Home | Why |
|---|---|---|
| `gpuMode: 'auto' \| 'off'` (user intent) | `AppSettings` (encrypted DB); **exposed as a Settings toggle** ("Use GPU acceleration", default on) | user-changeable, survives reload; default `'auto'` (GPU) |
| `gpuAutoDisabled: boolean`, `gpuLastError: string \| null` | `AppSettings` | written by the ladder; cleared by "Try GPU again" |
| Probe result (`GpuDevice[]`, `probedAt`) | `AppSettings` (alongside `lastBenchmark`) | feeds Diagnostics + `classifyProfile` without re-probing every launch |
| Active backend + GPU name this session | `RuntimeStatus` (in-memory, via `getRuntimeStatus` IPC) | live truth for the UI |

Note settings live inside the (possibly encrypted) DB → all GPU decisions happen **post-unlock**,
which is fine: both sidecars only ever start post-unlock (chat = explicit start; embedder = lazy
on first `embed()`).

---

## 6. Per-OS build matrix (what ships on the drive)

| OS/arch | `runtime/llama.cpp/...` | Backend(s) inside | GPU path | CPU path |
|---|---|---|---|---|
| win/x64 | `win/` ← **`…win-vulkan-x64.zip`** (new default) | Vulkan + 12 CPU variants | NVIDIA/AMD/Intel via Vulkan, auto | same binary, auto or `--device none` |
| win/x64 | `win/cpu/` ← `…win-cpu-x64.zip` (safety net) | CPU variants only | — | rung 3 |
| linux/x64 | `linux/` ← **`…ubuntu-vulkan-x64.tar.gz`** (new default) | Vulkan + CPU variants | same | same |
| linux/x64 | `linux/cpu/` ← `…ubuntu-x64.tar.gz` (safety net) | CPU only | — | rung 3 |
| mac/arm64 | `mac/` ← `…macos-arm64.tar.gz` (**unchanged**) | Metal + CPU | already active today (ngl auto) | Metal failure → llama.cpp falls back internally; ladder rung 2 applies if start fails |
| mac/x64 | **not shipped** (unchanged — decided, see Q4) | — | impossible: upstream builds mac/x64 with `GGML_METAL=OFF` and macOS has no Vulkan; Intel Macs (discontinued by Apple in 2023, final macOS release already announced) are a shrinking legacy minority | out of scope; documented in `known-limitations.md` |
| win/arm64 | **not shipped** (unchanged) | — | out of scope (Q4) | — |

> Known pre-existing gap surfaced while planning (not introduced here, not fixed here): on an
> Intel Mac, a drive's `mac/` dir holds an **arm64** binary that exists but cannot execute, so
> the factory selects `LlamaRuntime` and `start()` fails with a spawn error instead of falling
> back to the mock. The new ladder doesn't change this (rungs 2–3 reuse the same wrong-arch
> binary). Record it in `known-limitations.md` ("Intel Macs are not supported by prepared
> drives") during Phase 16.

The ladder code is identical on all three OSes — mac simply never has a `cpu/` subdir and its
rung 1 is Metal.

---

## 7. The embedder (E5) — decided: stays on CPU

`E5Embedder` composes the same `LlamaServer`, so with the Vulkan build it would *also*
auto-offload. We explicitly **pin it to CPU** by adding `--device none` to its `extraArgs`:

- The model is multilingual-E5-small (**F16 since 2026-06-10** — the q8_0 GGUF crashes
  llama-server b9585 at warmup, see the manifest's `license_review.notes`): ~242 MB, 384 dims,
  512-token context, same manifest id/`local_path`. CPU embeds hundreds of chunks/second;
  ingestion is dominated by parsing, not embedding. GPU upside ≈ seconds on a large import.
- Downside of GPU for it: a *second* GPU context competing for VRAM with the chat model, and a
  second process exposed to driver flakiness — during **ingestion**, where a crash fails a whole
  document (M7 history).
- Verdict: not worth it. Revisit only if a future, larger embedding model lands.

This also gives the codebase a permanent, tested example of the forced-CPU spawn path.

---

## 8. Honest expectations per hardware class (feeds UI copy + docs)

| Hardware | Today (CPU pin) | With this plan | Notes |
|---|---|---|---|
| Discrete NVIDIA (RTX 2060+) | 5–15 tok/s | **40–100+ tok/s** (4B Q4); 25–60 (8B Q4) | plus ~10× faster prompt processing — long-document Q&A feels dramatically better |
| Discrete AMD (RX 6600+) | 5–15 tok/s | 35–90 tok/s | Vulkan on RADV/Adrenalin is mature in 2026 |
| Intel iGPU (Iris Xe / Arc iGPU) | 5–15 tok/s | **~1–2× token generation** (sometimes ≈ CPU), 2–4× prompt processing | shared DDR memory bounds it — say so honestly |
| Old/no GPU, no Vulkan 1.2 driver | 5–15 tok/s | unchanged (automatic CPU) | the probe finds nothing; nothing changes |
| Apple Silicon | already GPU (Metal) | unchanged | already shipped |

Numbers are order-of-magnitude estimates from llama.cpp community benchmarks; the §11.2 manual
matrix replaces them with measured values before release notes claim anything.

**Profile bump rule (waking the dormant branch):** `classifyProfile` currently bumps one step for
any truthy `gpu` hint. Wake it conservatively:

- bump **only** when the probed device has `totalMb ≥ 6144` **and** `!looksIntegrated(name)`
  (name-based heuristic: `/iris|uhd|intel\(r\) (hd|arc.*integrated)|radeon.*graphics$|vega \d+$/i`
  — fixture-tested, biased toward *not* bumping).
- Rationale: an Iris Xe reporting 16 GB of *shared* memory must not push a 16 GB-RAM laptop into
  BALANCED→PRO and get recommended a 14B model. Discrete-GPU detection via Vulkan device names is
  imperfect; being conservative only costs a too-small recommendation, never a too-big one.
- `BenchmarkResult.gpu` (already in the shape, always `null` today) gets the probed name —
  additive, old persisted results stay valid.

UI surfacing (spec §11.4 tone):
- **Settings:** a "Use GPU acceleration" toggle (default **on** = `gpuMode:'auto'`), with one
  friendly sentence: *"Uses your graphics card to speed up responses when available. Turn off
  only if you notice stability problems."*
- **Diagnostics:** "Acceleration: NVIDIA GeForce RTX 3080 Ti (GPU)" / "Acceleration: CPU" +
  runtime build (b9585, vulkan) + the `gpuAutoDisabled` notice + "Try GPU again" button (clears
  the auto-disable flag without touching the Settings toggle).
- **Benchmark card:** tokens/sec already reflects the real backend automatically (it streams via
  the active runtime); add the GPU line to the system summary.
- Never: "GPU failed", "your hardware is bad". Always: "compatibility mode", "works on every
  machine".

---

## 9. Change inventory (file-by-file)

**Schema / manifests**
- `model-manifests/runtime-sources.yaml` — add `win/x64/vulkan` + `linux/x64/vulkan` entries with
  the §3.1 hashes; re-point `extract_to` so vulkan → `runtime/llama.cpp/<os>` and cpu →
  `runtime/llama.cpp/<os>/cpu`; header comment rewritten (default = vulkan-first ordering;
  document the §3 correction). mac entry unchanged.
- `apps/desktop/src/shared/runtime-sources.ts` — `validateRuntimeSources`: add duplicate
  `(os, arch, backend)` rejection; (optional) constrain `backend` to a known set with a warning,
  not an error. No breaking shape change — `selectRuntimeBuild`'s "first match wins" still
  drives defaults, now vulkan-first.

**Asset/provisioning layer**
- `apps/desktop/src/main/services/assets.ts` — `selectRuntimeBuilds` (plural) for the
  commercial pipeline (primary + `cpu` fallback per OS); **new install marker**: after extract,
  write `<extract_to>/.paid-runtime.json` `{ version, backend, os, arch }`. Fixes the idempotency
  hole (today's skip checks only "binary exists", which would silently keep a CPU build when
  upgrading a drive to vulkan) and tells the app/Diagnostics which build is installed.
- `scripts/fetch-runtime.{ps1,sh}` — mirror: marker-based skip (version+backend match), default
  build = first match (now vulkan), `-Backend cpu` fetches the safety net; keep symlink
  materialization (the linux vulkan tarball has the same symlink chains — verified).
- `apps/desktop/src/main/services/commercial-drive.ts` + `scripts/build-commercial-drive.{ps1,sh}`
  — fetch both builds per shipped OS; `assertCommercialDrive` additionally asserts the runtime
  marker matches the yaml pin (version + backend).

**Runtime layer**
- `apps/desktop/src/main/services/runtime/gpu.ts` — **new** (§5.1).
- `apps/desktop/src/main/services/runtime/sidecar.ts` — add `resolveCpuFallbackServerPath`
  (`<os>/cpu/llama-server[.exe]`); `LlamaServerOptions` unchanged (`extraArgs` already exists);
  add `onUnexpectedExit` hook.
- `apps/desktop/src/main/services/runtime/factory.ts` — the ladder (§5.2): selection now also
  reads `gpuMode`/`gpuAutoDisabled` (passed in as deps, not read from the DB here — keep it
  pure/injected) and chooses binPath + extraArgs; `onSelect` reason strings extended.
- `apps/desktop/src/main/services/runtime/llama.ts` — pass through device/extraArgs; expose
  `backend`/`gpuName` on health/status.
- `apps/desktop/src/main/services/runtime/index.ts` — `RuntimeStatus` carries
  `backend: 'gpu' | 'cpu' | 'mock'` + `gpuName?: string`.
- `apps/desktop/src/main/services/embeddings/e5.ts` — append `'--device', 'none'` to
  `extraArgs` (§7).

**Settings / benchmark / IPC / UI**
- `apps/desktop/src/shared/types.ts` — `AppSettings.gpuMode` (`'auto' | 'off'`, default
  `'auto'`), `gpuAutoDisabled`, `gpuLastError`, `gpuProbe` (cached devices + timestamp);
  `RuntimeStatus.backend/gpuName`; `BenchmarkResult.gpu` already exists (stays `string | null`).
- `apps/desktop/src/main/services/settings.ts` — defaults for the new keys.
- `apps/desktop/src/main/services/benchmark.ts` — `RunBenchmarkDeps.gpu?: string | null`
  (injected probe summary); `classifyProfile` bump rule per §8 (new optional
  `hints.gpuVramMb` + integrated flag, or a pre-computed `gpuUseful: boolean` — decide at
  implementation; keep the function pure). Module keeps zero `child_process`.
- `apps/desktop/src/main/ipc/registerBenchmarkIpc.ts` — runs/caches the probe (via
  `gpu.ts`), injects into `runBenchmark`.
- `apps/desktop/src/main/ipc/registerModelIpc.ts` (`getRuntimeStatus`) — backend fields.
- `apps/desktop/src/renderer/.../DiagnosticsScreen.tsx` — Acceleration line, runtime-build
  line, `gpuAutoDisabled` notice + "Try GPU again"; benchmark card GPU row.
- `apps/desktop/src/renderer/.../SettingsScreen.tsx` — "Use GPU acceleration" toggle bound to
  `gpuMode` (default on; §8 copy).

**Docs (per-phase ritual)**
- `docs/drive-layout.md` (new `<os>/cpu/` subdir + marker file), `docs/packaging.md`,
  `docs/model-policy.md` (runtime-sources section: default is now vulkan-first + why that is
  safe), `docs/benchmark.md` (GPU probe + bump rule), `docs/troubleshooting.md` ("chat said it
  switched to compatibility mode"), `docs/known-limitations.md` (iGPU expectations, no win-arm64/
  mac-x64 GPU), `docs/user-guide` perf section, `README` catalog if it mentions runtime,
  `BUILD_STATE.md` (status/decisions/contracts/next/risks), and **this file** flipped from DRAFT
  to ACCEPTED with deltas noted.

---

## 10. Consequences

### 10.1 Download / drive-size deltas

| OS | Today (zip / disk) | New (zip / disk) | Delta |
|---|---|---|---|
| Windows | 16.0 / 47.5 MB | 52.6 / 165.5 MB (vulkan + cpu net) | **+36.6 MB dl, +118 MB disk** (+16.0/+47.5 of that is the optional Q1 safety net) |
| Linux | 14.7 / 43.1 MB | 51.2 / ~172 MB (incl. symlink-copy overhead on exFAT, ~+15 MB) | **+36.5 MB dl, +129 MB disk** |
| macOS | 10.1 MB | unchanged | 0 |

Context: the smallest shipped chat model is ~1–2 GB; a BALANCED drive carries ~5–20 GB of
weights. The GPU delta is < 2 % of drive content. `build-commercial-drive` time grows by two
downloads (~73 MB total).

### 10.2 Licensing (the license-review gate)

- Both Vulkan archives are built from the **same MIT-licensed llama.cpp source** at the same
  pinned tag already approved in the b9585 review (commit `8bdeb2e`). The Vulkan backend embeds
  its compiled SPIR-V shaders — also llama.cpp source, MIT. The win zip ships
  `libomp140.x86_64.dll` (MS OpenMP runtime, redistributable) — **same file already shipped in
  the win-cpu zip**, so no new third-party artifact class.
- The Vulkan **loader is not shipped** — it comes from the user's GPU driver. We redistribute
  nothing from the Vulkan SDK.
- Action: extend the existing llama.cpp license-review record to name the two new asset files +
  hashes. **No new licenses enter the product.** (This is the strongest licensing argument for
  Vulkan over CUDA, whose cudart/cuBLAS redistribution would add a proprietary NVIDIA EULA
  review.)

### 10.3 New failure modes and their handling

| Failure | When | What happens | Recovery |
|---|---|---|---|
| No Vulkan loader / no 1.2 driver / RDP session | rung 1 spawn | backend lib fails to load or 0 devices; server runs on bundled CPU backends | nothing to do — this *is* CPU mode; probe shows "CPU" |
| Driver enumerates but crashes at model load | rung 1 health wait | exit-before-healthy with stderr tail | ladder → rung 2 (`--device none`), persist `gpuAutoDisabled` |
| Driver hangs (accepts, never healthy) | rung 1 | existing 60 s health timeout + 3 s per-probe bound | ladder → rung 2; *cost: one slow first start on that machine, then never again (flag persisted)* |
| Driver crash mid-generation | runtime | sidecar exits; in-flight stream errors (existing path) | auto-restart at rung 2 + friendly notice (§5.3) |
| VRAM exhausted at load (model > VRAM) | rung 1 | upstream `--fit` partially offloads within the 1 GiB margin | none needed; worst case slower-than-expected GPU mode |
| VRAM stolen mid-run by another app | runtime | server error/exit | same as mid-generation crash |
| Vulkan present but *slower* than CPU (weak iGPU + fast CPU) | steady state | no crash — just modest numbers | honest docs (§8); `gpuMode: 'off'` exists in Diagnostics; **we do not auto-benchmark-and-choose in v1** (Q3) |
| Both rungs 1–2 fail (binary-level breakage) | start | rung 3 pure-CPU build | the Q1 safety net |
| Stale flag after user upgrades GPU/driver | any | GPU stays off | "Try GPU again" in Diagnostics clears `gpuAutoDisabled` |

### 10.4 Release-acceptance checklist impact

Adds to the existing manual acceptance (BUILD_STATE §5): the §11.2 hardware matrix, a
SmartScreen sanity re-check (the portable exe is unchanged; `llama-server.exe` + DLLs were
already unsigned upstream binaries — the Vulkan build adds one more unsigned DLL of the same
class), and re-running `build-commercial-drive` end-to-end with the two-build fetch.

---

## 11. Testing strategy

### 11.1 CI / unit (zero GPUs, zero binaries — the suite stays green as-is)

- `parseListDevices`: fixtures — the real RTX 3080 Ti line above, multi-device, empty list,
  garbage, localized/odd names. `looksIntegrated` table tests.
- `probeGpuDevices`: fake spawn (existing `SpawnFn` seam) — success, non-zero exit, timeout-kill,
  binary missing.
- Ladder: fake spawn that fails rung 1 / rungs 1–2 / succeeds; assert arg lists (`--device none`
  exactly on rungs 2+, **no** `-ngl` ever), persistence writes, single-restart-on-crash, and that
  `gpuMode:'off'` starts at rung 2. Assert loopback-only args still hold (existing test extends).
- `selectRuntimeBuild(s)`: vulkan-first default, `cpu` override, marker-based idempotency
  (upgrade CPU-drive → vulkan actually re-fetches).
- `validateRuntimeSources`: dup `(os,arch,backend)` rejection; updated yaml validates; committed
  yaml hashes are real (existing pattern).
- `classifyProfile`: bump only on ≥ 6 GiB non-integrated; iGPU-16GB-shared does **not** bump.
- E5: spawn args include `--device none`.
- Existing no-network assertions untouched (probe is a subprocess, not a socket).

### 11.2 Manual hardware matrix (release acceptance — cannot be CI'd)

| # | Machine | What it proves |
|---|---|---|
| 1 | Windows 11 + discrete NVIDIA (the dev box, RTX 3080 Ti) | rung 1 GPU happy path; measured tok/s for release notes |
| 2 | Windows + discrete AMD (Adrenalin) | Vulkan-on-AMD happy path |
| 3 | Windows laptop, Intel Iris Xe only | iGPU modest-gain reality; profile does NOT bump |
| 4 | Windows with no GPU / Server VM / **RDP session** | empty probe → silent CPU; no scary UI |
| 5 | Windows, very old GPU (pre-Vulkan-1.2 driver) | clean rung-1 degradation |
| 6 | Linux + NVIDIA (proprietary) and/or AMD (Mesa RADV) | linux vulkan build + symlink-materialized libs load from exFAT |
| 7 | mac arm64 | regression: Metal still active, no behavior change |
| 8 | Any GPU box: kill the driver mid-generation (or TDR via `dxcap -forcetdr`) | §5.3 auto-fallback + friendly notice + next-message-works |
| 9 | Drive built by `build-commercial-drive`, moved between machines 1↔4 | flags/probe re-evaluate per machine; encrypted workspace continuity |

A GPU-less CI cannot fake rungs: the fake-spawn unit tests cover the *logic*; the matrix covers
the *drivers*. Both are required before the release checkbox ticks.

---

## 12. Phased implementation plan (per-phase ritual applies to each)

### Phase 14 — Distribution: ship the Vulkan builds (no app behavior change yet)
yaml entries + hashes, validator tweaks, `assets.ts` selection/marker, `fetch-runtime` +
`build-commercial-drive` scripts, drive-layout/packaging/model-policy docs.
**Green gate:** full suite green with zero binaries; `fetch-runtime` on a scratch dir produces
`win/` (vulkan) + `win/cpu/` with verified hashes + markers; a drive provisioned this way runs
the app **unchanged** (rung-1 default args already auto-offload — this phase alone lights up
GPUs, with upstream's own CPU degradation as the only fallback). BUILD_STATE updated.

### Phase 15 — Runtime: probe, ladder, persistence, embedder pin
`gpu.ts`, sidecar/factory/llama changes, settings keys, crash auto-fallback, E5 `--device none`.
**Green gate:** all §11.1 unit tests; suite green with zero binaries/GPUs (mock path untouched);
manual smoke on the dev box: GPU start, forced `gpuMode:'off'`, simulated rung-1 failure (point
`PAID_LLAMA_BIN` at a stub that exits 1 → lands on rung 2/3). BUILD_STATE updated.

### Phase 16 — Surface: Settings toggle, Diagnostics, benchmark, copy, docs
RuntimeStatus fields → UI, the Settings "Use GPU acceleration" toggle, probe injection into
benchmark, `classifyProfile` wake-up, friendly copy, troubleshooting/known-limitations (incl.
the Intel-Mac note from §6)/user-guide updates.
**Green gate:** suite green; Diagnostics shows correct backend on the dev box and "CPU" with all
binaries deleted; §11.4-compliant copy reviewed. BUILD_STATE updated; release-acceptance
checklist gains §11.2.

(Phases 14+15 could merge if you prefer fewer commits; 14 is independently shippable and
already delivers most of the user value.)

---

## 13. Review decisions (resolved 2026-06-10, review round 1)

1. **Ship the `<os>/cpu/` safety-net build?** → **YES.** (+16.0 MB win, +14.7 MB linux
   download; rung 3 of the ladder.)
2. **`gpuMode` exposure** → **GPU is always the default**; only a detected problem moves a
   machine to CPU (the ladder + `gpuAutoDisabled`). Additionally expose a **Settings toggle**
   ("Use GPU acceleration", default on) for explicit user choice; Diagnostics keeps the
   "Try GPU again" reset.
3. **CPU-vs-GPU first-start auto-benchmark** → **NOT needed.** v1 trusts llama.cpp's
   auto-offload even on weak iGPUs; the honest-expectations copy (§8) covers the modest-gain
   case.
4. **win/arm64 and mac/x64** → **out of scope.** mac/x64 = Intel Macs: discontinued by Apple
   in 2023, the final Intel-supporting macOS is already announced, and GPU acceleration is
   impossible there regardless (upstream ships mac/x64 with Metal off; macOS has no Vulkan) —
   it fails the "common architecture used today" test. Documented in `known-limitations.md`
   during Phase 16 (including the pre-existing arch-mismatch note in §6). Revisit only if a
   real Intel-Mac buyer materializes.

**Implementation note (not a question):** the two new hashes in §3.1 were computed from
2026-06-10 downloads on the dev machine. Re-verify them on the build machine during Phase 14
before committing (same procedure as the b9585 pin), per the yaml header rule.

**Docs scope reminder:** this plan is the only document touched during planning. All other doc
updates (`drive-layout.md`, `packaging.md`, `model-policy.md`, `benchmark.md`,
`troubleshooting.md`, `known-limitations.md`, user guide, `BUILD_STATE.md`) happen inside
Phases 14–16 per the per-phase ritual, as inventoried in §9 — updating them now would describe
a state of the repo that doesn't exist yet.
