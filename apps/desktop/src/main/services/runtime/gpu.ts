import { spawn as nodeSpawn } from 'node:child_process'
import type { GpuDevice } from '../../../shared/types'
import { verifyBinaryBeforeSpawn, type BinaryVerifyResult } from '../binary-verifier'
import type { ChildProcessLike, SpawnFn } from './sidecar'

// GPU device probe (architecture.md GPU record §5.1). Spawns the drive's OWN
// `llama-server --list-devices` — an offline, no-model, sub-second subprocess that
// prints ggml's truth about which devices the backend will actually use — and parses
// the output. No new deps, no registry/wmic scraping, no sockets (the probe is a child
// process, NOT a network call; the no-network assertions are untouched).
//
// The probe can prove enumeration only, never stable inference — the start LADDER in
// factory.ts is the actual guarantee; this feeds the UI label, Diagnostics, and the
// conservative classifyProfile bump. Never throws: any failure → [].

/**
 * Kill the probe child after this long; a wedged driver must not stall startup.
 * Generous (10 s, not ~3 s) because a COLD Vulkan driver init under disk load can take
 * that long, and a false-empty probe mislabels a working GPU machine as CPU. Still
 * once per session, off the start's critical path, and a real wedge is still killed.
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
 * keep classifyProfile's GPU bump conservative (GPU record §8). Deliberately biased toward
 * matching (NOT bumping): an Iris Xe reporting 16 GB of *shared* memory must never
 * push a laptop a profile step up and get recommended a model it cannot run. A false
 * positive only costs a too-small recommendation, never a too-big one.
 */
export function looksIntegrated(name: string): boolean {
  // Patterns cover the names real Vulkan drivers report (including Linux/RADV APUs
  // and Meteor-Lake Intel, which a name-only "Iris/UHD" check would miss):
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

/** Minimum dedicated VRAM (MiB) before a GPU may bump the hardware profile. */
export const GPU_BUMP_MIN_VRAM_MB = 6144

/**
 * The conservative profile-bump gate (GPU record §8): bump only when some probed device
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
  /**
   * Re-hash the binary before the probe spawns it (vuln-scan B). Defaults to the shared
   * `verifyBinaryBeforeSpawn`. A `mismatch` resolves `[]` (no GPU) — the probe's contract
   * is that it NEVER throws — so a tampered binary is simply never executed for the probe.
   */
  verify?: (binPath: string) => Promise<BinaryVerifyResult>
}

/**
 * Spawn `<binPath> --list-devices`, parse stdout, and resolve the device list. Bounded
 * by a kill-timeout; NEVER throws/rejects — a missing binary, spawn error, non-zero
 * exit, timeout, or a failed pre-spawn integrity check all resolve to `[]` (which simply
 * reads as "no usable GPU").
 */
export async function probeGpuDevices(binPath: string, deps: GpuProbeDeps = {}): Promise<GpuDevice[]> {
  const spawn = deps.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts))
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const verify = deps.verify ?? verifyBinaryBeforeSpawn

  // Refuse a tampered binary the same way a missing one reads: no GPU. Never throws.
  let verification: BinaryVerifyResult
  try {
    verification = await verify(binPath)
  } catch {
    return []
  }
  if (verification === 'mismatch') return []

  return new Promise((resolve) => {
    let child: ChildProcessLike
    try {
      // REL-7: windowsHide so the once-per-session probe never flashes a console window on
      // Windows (matching the sidecar / tar / transcriber spawns). No-op off Windows.
      child = spawn(binPath, ['--list-devices'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
      })
    } catch {
      resolve([])
      return
    }
    // REL-8: detach from the parent event loop so a wedged probe (cold/hung driver) can never
    // delay or block app quit — shutdown() doesn't track this child, and Electron must be able
    // to exit without waiting on it. The probe's own kill-timeout (below) still reaps it.
    child.unref?.()

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
   * Drop every cached result so the next call re-probes. Wired to "Try GPU again":
   * a probe that timed out once (cold/wedged driver) must not stay cached as
   * "no GPU" after the user explicitly asks for a retry.
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
  // R5 (full-audit-2026-06-30, Phase C): binaries whose probe child is still alive. A probe's
  // timeout `SIGKILL`s but does NOT await the reap, and the child is `unref`'d — so dropping an
  // in-flight entry and re-probing (rapid "Try GPU again" mashing during a slow/cold driver init)
  // would STACK a second short-lived child for the SAME binary, N clicks → N children. Fix:
  // `invalidate()` drops only SETTLED entries; while a probe is in flight a re-probe COALESCES onto
  // the existing promise (no second child), and the entry becomes invalidate-able once it settles.
  const inFlight = new Set<string>()
  const probe = (binPath: string): Promise<GpuDevice[]> => {
    let pending = cache.get(binPath)
    if (!pending) {
      pending = probeGpuDevices(binPath, deps)
      cache.set(binPath, pending)
      inFlight.add(binPath)
      // probeGpuDevices never rejects (its contract), but `finally` is correct regardless.
      void pending.finally(() => inFlight.delete(binPath))
    }
    return pending
  }
  const invalidate = (): void => {
    for (const bin of [...cache.keys()]) {
      if (!inFlight.has(bin)) cache.delete(bin) // keep an in-flight probe; a re-probe coalesces onto it
    }
  }
  return Object.assign(probe, { invalidate })
}
