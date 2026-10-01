import { spawn as nodeSpawn } from 'node:child_process'
import type { GpuDevice } from '../../../shared/types'
import { verifyBinaryBeforeSpawn, type BinaryVerifyResult } from '../binary-verifier'
import { log } from '../logging'
import {
  classifyLoadFailure,
  classifySpawnError,
  clearEngineProblemFor,
  describeLoadFailure,
  reportEngineProblem,
  type LoadFailure
} from './engine-load'
import type { ChildProcessLike, SpawnFn } from './sidecar'

// GPU device probe (architecture.md GPU record §5.1). Spawns the drive's OWN
// `llama-server --list-devices` — an offline, no-model, sub-second subprocess that
// prints ggml's truth about which devices the backend will actually use — and parses
// the output. No new deps, no registry/wmic scraping, no sockets (the probe is a child
// process, NOT a network call; the no-network assertions are untouched).
//
// The probe can prove enumeration only, never stable inference — the start LADDER in
// factory.ts is the actual guarantee; this feeds the UI label, Diagnostics, and the
// conservative classifyProfile bump. Never throws: any failure → `[]` (an ANSWER: "this
// machine enumerates no device") EXCEPT the kill-timeout → `null` (UNKNOWN: the driver
// never answered), which is never cached and never persisted (#380), and a program the OS
// loader refused → `null` too, recorded as the session's engine verdict (#530).

/**
 * Kill the probe child after this long; a wedged driver must not stall startup.
 * Generous (10 s, not ~3 s) because a COLD Vulkan driver init under disk load can take
 * that long, and a false-empty probe mislabels a working GPU machine as CPU. Still
 * once per session, off the start's critical path, and a real wedge is still killed.
 *
 * #380: hitting this bound is NOT "no GPU" — the probe resolves `null` ("unknown"), the
 * cache drops the entry so the next caller re-probes, and nothing is persisted. On the
 * #330 round trip a `--list-devices` that normally takes 1.07 s took 7.7 s under the
 * concurrent weight upload; a slower drive would have crossed this bound and stamped a
 * card machine as "None".
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

// The usefulness rules — `looksIntegrated`, the `GPU_BUMP_MIN_VRAM_MB` gate (5 GiB since #321) and
// `gpuUsefulForProfile` (GPU record §8) — moved VERBATIM to `shared/gpu-rules.ts` with the
// PR #303 audit (M8 / N3): the Performance screen must rate a device by the same definition
// the profile bump and the memory class use, and the renderer cannot import this module (it
// spawns). Re-exported here so every existing import site is unchanged; the bump's semantics
// are untouched (owner decision G4).
export { GPU_BUMP_MIN_VRAM_MB, gpuUsefulForProfile, looksIntegrated } from '../../../shared/gpu-rules'

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
  /** #530: the OS the load-failure classifier reports (default `process.platform`). */
  platform?: NodeJS.Platform
  /** #530: the Windows System32 DLL check the classifier consults after a DLL-shaped exit code. */
  systemDllExists?: (dll: string) => boolean
}

/** #530: keep this much of the probe's stderr — enough for the loader's one-line refusal. */
const PROBE_STDERR_MAX = 4000

/**
 * Spawn `<binPath> --list-devices`, parse stdout, and resolve the device list. Bounded
 * by a kill-timeout; NEVER throws/rejects — a missing binary, spawn error, non-zero exit
 * or a failed pre-spawn integrity check all resolve to `[]`, which reads as "no usable
 * GPU" because that is what those cases MEAN: the machine answered, and the answer was
 * nothing.
 *
 * The kill-timeout is the one case that is not an answer, so it resolves `null` — UNKNOWN
 * (#380). Callers must not read `null` as "no GPU": the session cache drops it (the next
 * caller re-probes), `probeAndPersistGpu` writes nothing (the stored probe stands) and the
 * start ladder labels the rung from the load log instead.
 *
 * #530: a program the OS loader REFUSED (a missing system library, a system too old, a missing
 * Windows runtime, a code-integrity block) is not an answer either — the engine never ran, so it
 * could not have enumerated anything. It resolves `null` like the timeout, and the refusal is
 * recorded as the session's engine verdict (`engine-load.ts`). Before #530 it was cached and
 * persisted as "no graphics card", which fed the Performance tile, the ★ pick and the profile.
 */
export async function probeGpuDevices(binPath: string, deps: GpuProbeDeps = {}): Promise<GpuDevice[] | null> {
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

  return new Promise<GpuDevice[] | null>((resolve) => {
    /** #530: the OS refused the program — log once (local, path included) and record the verdict. */
    const recordRefusal = (failure: LoadFailure, detail: string): void => {
      log.warn('The device probe could not start the AI engine — the operating system refused it', {
        problem: describeLoadFailure(failure),
        binPath,
        detail
      })
      reportEngineProblem({ family: 'llama_cpp', ...failure }, binPath)
    }
    let child: ChildProcessLike
    try {
      // REL-7: windowsHide so the once-per-session probe never flashes a console window on
      // Windows (matching the sidecar / tar / transcriber spawns). No-op off Windows.
      child = spawn(binPath, ['--list-devices'], {
        // #530: stderr piped (it was ignored) — the loader's refusal is only ever written there.
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (err) {
      // #530: a Windows refusal by policy / security software is the engine verdict, not "no GPU".
      const refused = classifySpawnError(err, deps.platform)
      if (refused) {
        recordRefusal(refused, String(err))
        resolve(null)
        return
      }
      resolve([])
      return
    }
    // REL-8: detach from the parent event loop so a wedged probe (cold/hung driver) can never
    // delay or block app quit — shutdown() doesn't track this child, and Electron must be able
    // to exit without waiting on it. The probe's own kill-timeout (below) still reaps it.
    child.unref?.()

    let stdout = ''
    let settled = false
    const finish = (devices: GpuDevice[] | null): void => {
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
      // #380: the driver never answered — UNKNOWN, not "no GPU". The child is still killed.
      finish(null)
    }, timeoutMs)

    child.stdout?.on('data', (chunk: unknown) => {
      stdout += String(chunk)
    })
    let stderr = ''
    // Drained either way (a piped-but-unread stream can fill and block the child).
    child.stderr?.on('data', (chunk: unknown) => {
      stderr = (stderr + String(chunk)).slice(-PROBE_STDERR_MAX)
    })
    child.once('error', (err: unknown) => {
      const refused = classifySpawnError(err, deps.platform)
      if (refused) {
        recordRefusal(refused, String(err))
        finish(null)
        return
      }
      finish([])
    })
    // Resolve on 'close', not 'exit': 'exit' can fire while probe output is still
    // buffered in the pipe (Node delivers it afterwards), which would truncate the
    // parse into a false-empty device list. 'close' fires only after stdio drained.
    child.once('close', (code: unknown, signal: unknown) => {
      if (code === 0) {
        // #530: the program ran — a refusal recorded against THIS binary is stale.
        clearEngineProblemFor('llama_cpp', binPath)
        finish(parseListDevices(stdout))
        return
      }
      const failure = classifyLoadFailure({
        exitCode: typeof code === 'number' ? code : null,
        signal: typeof signal === 'string' ? signal : null,
        stderr,
        platform: deps.platform,
        systemDllExists: deps.systemDllExists
      })
      if (failure) {
        // #530: the engine never ran — UNKNOWN, not "no device"; the refusal becomes the verdict.
        recordRefusal(failure, stderr.trim().slice(-1000))
        finish(null)
        return
      }
      finish([])
    })
  })
}

/** The session probe cache: callable like `probeGpuDevices`, plus invalidation. */
export interface CachedGpuProbe {
  (binPath: string): Promise<GpuDevice[] | null>
  /**
   * Drop every cached result so the next call re-probes. Wired to "Try GPU again":
   * a probe whose answer is stale or wrong (a driver that has since come up, a card
   * plugged in) must not survive the user explicitly asking for a retry.
   *
   * #380: a probe that TIMED OUT no longer needs this button — it resolves `null`
   * ("unknown") and drops itself from the cache the moment it settles, so the next
   * caller re-probes on its own. `invalidate()` remains the user's override for a
   * cached ANSWER (`[]` or a device list).
   */
  invalidate(): void
}

/**
 * Session-cached probe: at most one real `--list-devices` subprocess per binary per app
 * session (§5.1 "cached"), until `invalidate()`. The same cached fn feeds the start
 * ladder, Diagnostics, and the benchmark injection so they never disagree in-session.
 *
 * An ANSWER is cached (a device list, or `[]`); an UNKNOWN (`null`, the kill-timeout) is
 * NOT — the entry is dropped once it settles so the next caller re-probes (#380). The
 * drop is identity-guarded, so it can never remove a NEWER entry filed for the same
 * binary in between.
 */
export function createCachedGpuProbe(deps: GpuProbeDeps = {}): CachedGpuProbe {
  const cache = new Map<string, Promise<GpuDevice[] | null>>()
  // R5 (full-audit-2026-06-30, Phase C): binaries whose probe child is still alive. A probe's
  // timeout `SIGKILL`s but does NOT await the reap, and the child is `unref`'d — so dropping an
  // in-flight entry and re-probing (rapid "Try GPU again" mashing during a slow/cold driver init)
  // would STACK a second short-lived child for the SAME binary, N clicks → N children. Fix:
  // `invalidate()` drops only SETTLED entries; while a probe is in flight a re-probe COALESCES onto
  // the existing promise (no second child), and the entry becomes invalidate-able once it settles.
  const inFlight = new Set<string>()
  const probe = (binPath: string): Promise<GpuDevice[] | null> => {
    let pending = cache.get(binPath)
    if (!pending) {
      const created = probeGpuDevices(binPath, deps)
      pending = created
      cache.set(binPath, created)
      inFlight.add(binPath)
      // probeGpuDevices never rejects (its contract), but `finally` is correct regardless.
      void created.finally(() => inFlight.delete(binPath))
      // #380: an UNKNOWN answer must not be the session's answer. Dropped only AFTER it
      // settles — R5's in-flight coalescing is untouched, so a re-probe during the wedge
      // still rides the one child — and only if this entry is still the cached one.
      void created.then((devices) => {
        if (devices === null && cache.get(binPath) === created) cache.delete(binPath)
      })
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
