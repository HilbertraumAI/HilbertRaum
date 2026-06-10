import { spawn as nodeSpawn } from 'node:child_process'
import type { GpuDevice } from '../../../shared/types'
import type { ChildProcessLike, SpawnFn } from './sidecar'

// GPU device probe (Phase 15, docs/gpu-support-plan.md §5.1). Spawns the drive's OWN
// `llama-server --list-devices` — an offline, no-model, sub-second subprocess that
// prints ggml's truth about which devices the backend will actually use — and parses
// the output. No new deps, no registry/wmic scraping, no sockets (the probe is a child
// process, NOT a network call; the no-network assertions are untouched).
//
// The probe can prove enumeration only, never stable inference — the start LADDER in
// factory.ts is the actual guarantee; this feeds the UI label, Diagnostics, and the
// conservative classifyProfile bump (§8). Never throws: any failure → [].

/**
 * Kill the probe child after this long; a wedged driver must not stall startup.
 * (The plan's §5.1 sketch said 3 s, but a COLD Vulkan driver init under disk load was
 * measured exceeding that on the dev box — a false-empty probe mislabels a working GPU
 * machine as CPU, so the bound is 10 s. Still once per session, off the start's
 * critical path, and a real wedge is still killed.)
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000

/**
 * Parse `llama-server --list-devices` stdout. Pure (fixture-tested). Expected lines:
 *
 *   Available devices:
 *     Vulkan0: NVIDIA GeForce RTX 3080 Ti (12300 MiB, 11511 MiB free)
 *
 * Anything not matching the `<Id>: <name> (<total> MiB, <free> MiB free)` shape is
 * ignored, so headers, blank lines, and localized noise cannot break the parse.
 */
export function parseListDevices(stdout: string): GpuDevice[] {
  const devices: GpuDevice[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+):\s+(.+?)\s*\((\d+)\s+MiB,\s+(\d+)\s+MiB free\)\s*$/.exec(raw)
    if (!m) continue
    devices.push({
      id: m[1],
      name: m[2],
      totalMb: Number(m[3]),
      freeMb: Number(m[4])
    })
  }
  return devices
}

/**
 * Name-based heuristic for "this is an integrated GPU sharing system RAM" — used to
 * keep classifyProfile's GPU bump conservative (§8). Deliberately biased toward
 * matching (NOT bumping): an Iris Xe reporting 16 GB of *shared* memory must never
 * push a laptop a profile step up and get recommended a model it cannot run. A false
 * positive only costs a too-small recommendation, never a too-big one.
 */
export function looksIntegrated(name: string): boolean {
  // Patterns cover the names real Vulkan drivers report (audit fix — the original
  // plan-§8 regex missed Linux/RADV APUs and Meteor-Lake Intel):
  //   - "Intel(R) Iris(R) Xe Graphics", "Intel(R) UHD Graphics 770", "Intel(R) HD ..."
  //   - "Intel(R) Arc(TM) Graphics"          (Meteor/Lunar-Lake iGPU — NO model number;
  //     discrete is "Arc(TM) A770 Graphics" and must NOT match)
  //   - "AMD Radeon(TM) Graphics" / "AMD Radeon Graphics (RADV REMBRANDT)"  (APUs)
  //   - "AMD Radeon(TM) 780M Graphics" and other "...Graphics"-suffixed APU names
  //   - "AMD Radeon Vega 8 Graphics", "Vega 11" APUs (also catches old discrete
  //     RX Vega 56/64 — an accepted false positive; see the bias note above)
  return /iris|uhd|intel\(r\) (hd|arc.*integrated)|arc\(tm\) graphics|radeon(\(tm\))? graphics|radeon.*graphics$|vega \d+/i.test(
    name
  )
}

/** Minimum dedicated VRAM (MiB) before a GPU may bump the hardware profile (§8). */
export const GPU_BUMP_MIN_VRAM_MB = 6144

/**
 * The conservative profile-bump gate (Phase 16, §8): bump only when some probed device
 * has ≥ 6 GiB AND does not look integrated. An iGPU reporting 16 GB of *shared* RAM
 * must never push a laptop a profile step up; a false negative only costs a too-small
 * model recommendation, never a too-big one.
 */
export function gpuUsefulForProfile(devices: GpuDevice[]): boolean {
  return devices.some((d) => d.totalMb >= GPU_BUMP_MIN_VRAM_MB && !looksIntegrated(d.name))
}

export interface GpuProbeDeps {
  /** Injected spawn (the same `SpawnFn` seam the sidecar uses) — tests fake it. */
  spawn?: SpawnFn
  timeoutMs?: number
}

/**
 * Spawn `<binPath> --list-devices`, parse stdout, and resolve the device list. Bounded
 * by a kill-timeout; NEVER throws/rejects — a missing binary, spawn error, non-zero
 * exit, or timeout all resolve to `[]` (which simply reads as "no usable GPU").
 */
export function probeGpuDevices(binPath: string, deps: GpuProbeDeps = {}): Promise<GpuDevice[]> {
  const spawn = deps.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts))
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS

  return new Promise((resolve) => {
    let child: ChildProcessLike
    try {
      child = spawn(binPath, ['--list-devices'], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve([])
      return
    }

    let stdout = ''
    let settled = false
    const finish = (devices: GpuDevice[]): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(devices)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* best-effort */
      }
      finish([])
    }, timeoutMs)

    child.stdout?.on('data', (chunk: unknown) => {
      stdout += String(chunk)
    })
    child.once('error', () => finish([]))
    // Resolve on 'close', not 'exit': 'exit' can fire while probe output is still
    // buffered in the pipe (Node delivers it afterwards), which would truncate the
    // parse into a false-empty device list. 'close' fires only after stdio drained.
    child.once('close', (code: unknown) => {
      finish(code === 0 ? parseListDevices(stdout) : [])
    })
  })
}

/** The session probe cache: callable like `probeGpuDevices`, plus invalidation. */
export interface CachedGpuProbe {
  (binPath: string): Promise<GpuDevice[]>
  /**
   * Drop every cached result so the next call re-probes. Wired to "Try GPU again"
   * (audit fix): a probe that timed out once (cold/wedged driver) must not stay
   * cached as "no GPU" after the user explicitly asks for a retry.
   */
  invalidate(): void
}

/**
 * Session-cached probe: at most one real `--list-devices` subprocess per binary per app
 * session (§5.1 "cached"), until `invalidate()`. The same cached fn feeds the start
 * ladder, Diagnostics, and the benchmark injection so they never disagree in-session.
 */
export function createCachedGpuProbe(deps: GpuProbeDeps = {}): CachedGpuProbe {
  const cache = new Map<string, Promise<GpuDevice[]>>()
  const probe = (binPath: string): Promise<GpuDevice[]> => {
    let pending = cache.get(binPath)
    if (!pending) {
      pending = probeGpuDevices(binPath, deps)
      cache.set(binPath, pending)
    }
    return pending
  }
  return Object.assign(probe, { invalidate: () => cache.clear() })
}
