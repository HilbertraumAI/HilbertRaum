import { spawn as nodeSpawn } from 'node:child_process'
import type { EngineProblemFamily } from '../../shared/types'
import type { AppContext } from './context'
import { verifyBinaryBeforeSpawn } from './binary-verifier'
import { rewriteEngineFailureRows } from './ingestion/engine-failure'
import { log } from './logging'
import {
  classifyLoadFailure,
  classifyLoadFailureMessage,
  classifySpawnError,
  describeLoadFailure,
  reportEngineProblem,
  type LoadFailure,
  type LoadFailureInput
} from './runtime/engine-load'
import { resolveLlamaServerPath, type ChildProcessLike, type SpawnFn } from './runtime/sidecar'
import { getSettings, updateSettings } from './settings'
import { resolveWhisperCliPath } from './transcriber/cli'
import { workspaceAdmitsWork } from './workspace-vault'

// The session side of #530 (architecture.md "Engine load failures"): when the engine check runs,
// how state written before the fix heals, and how a "can't run" verdict is re-checked. The
// classifier, the typed error and the verdict store live in `runtime/engine-load.ts`; the spawn
// sites feed the store themselves, so this module only decides WHEN to look.

/**
 * The startup check: run the session's GPU device probe NOW, before any unlock — it already
 * spawns the chat engine once per session (`--list-devices`), and since #530 it records a load
 * refusal as the engine verdict instead of "no graphics card". Reusing it costs no extra spawn on a
 * healthy machine: the cached probe is what the post-unlock refresh and the start ladder read
 * anyway. Before #530 the probe did not run at startup on a never-benchmarked drive at all, so the
 * first sign of a missing library was a failed chat start. Fire-and-forget; never throws.
 */
export function startEngineCheck(ctx: Pick<AppContext, 'paths' | 'isDev' | 'probeGpu'>): void {
  try {
    const binPath = resolveLlamaServerPath(ctx.paths.rootPath, process.platform, process.env, { isDev: ctx.isDev })
    if (!binPath || !ctx.probeGpu) return
    void ctx.probeGpu(binPath).catch(() => undefined)
  } catch (err) {
    log.warn('Engine check at startup could not run', { error: String(err) })
  }
}

/** Does this stored `gpuLastError` describe the OS refusing the engine, not a GPU fault? */
export function isLoaderCausedGpuError(
  gpuLastError: string | null | undefined,
  opts: Pick<LoadFailureInput, 'platform' | 'systemDllExists'> = {}
): boolean {
  if (!gpuLastError) return false
  return classifyLoadFailureMessage(gpuLastError, opts) !== null
}

export interface EngineHealResult {
  /** A `gpuAutoDisabled` that a load refusal had set was cleared. */
  gpuFlagCleared: boolean
  /** Failed documents whose row held the raw loader line, rewritten to the canonical text. */
  rowsRewritten: number
}

/**
 * Heal what the app wrote before #530 at every session start (unlock, create, plaintext startup)
 * — BEFORE the auto-start reads the GPU flags:
 *  - `gpuAutoDisabled` whose `gpuLastError` classifies as a load refusal is cleared with it. The
 *    flag claimed a GPU fault; the library was missing. A genuine GPU fault never matches (its
 *    reason is llama.cpp's own output or a crash), and the flag carries no machine stamp, so it
 *    would otherwise follow the drive to every computer and keep the GPU off there too.
 *  - failed documents whose row holds the loader's raw line (with the absolute drive path) are
 *    rewritten to the canonical, display-mapped text.
 * Idempotent and admission-gated; never throws (a locked or locking workspace is simply skipped).
 */
export function healEngineLoadState(
  ctx: Pick<AppContext, 'db' | 'workspace'>,
  opts: Pick<LoadFailureInput, 'platform' | 'systemDllExists'> = {}
): EngineHealResult {
  const result: EngineHealResult = { gpuFlagCleared: false, rowsRewritten: 0 }
  try {
    if (!workspaceAdmitsWork(ctx.workspace)) return result
    const s = getSettings(ctx.db)
    if (s.gpuAutoDisabled && isLoaderCausedGpuError(s.gpuLastError, opts)) {
      updateSettings(ctx.db, { gpuAutoDisabled: false, gpuLastError: null })
      result.gpuFlagCleared = true
      log.info('Cleared a compatibility-mode flag that an engine load failure had set (not a GPU fault)')
    }
    result.rowsRewritten = rewriteEngineFailureRows(ctx.db, opts)
  } catch (err) {
    log.warn('Healing engine load-failure state failed', { error: String(err) })
  }
  return result
}

/** The outcome of starting a program just far enough to know whether the OS loader accepts it. */
export type LoadCheck = 'loads' | 'refused' | 'unchecked'

export interface LoadCheckDeps {
  spawn?: SpawnFn
  verify?: (binPath: string) => Promise<'verified' | 'mismatch' | string>
  timeoutMs?: number
  platform?: NodeJS.Platform
  systemDllExists?: (dll: string) => boolean
}

const LOAD_CHECK_TIMEOUT_MS = 10_000

/**
 * Start `binPath args` and report whether the OS loader accepted it (#530 "Check again", both
 * engines). `refused` also records the verdict — a classified exit, or a Windows spawn refusal by
 * policy / security software. `loads` covers any exit the classifier does not recognise (a usage
 * error is still a program that ran) and a program still running at the bound. `unchecked`: the
 * binary failed its integrity check, or could not be spawned for a reason that says nothing about
 * the loader — the verdict is left as it was. Never throws.
 */
export async function checkProgramLoads(
  family: EngineProblemFamily,
  binPath: string,
  args: string[],
  deps: LoadCheckDeps = {}
): Promise<LoadCheck> {
  const verify = deps.verify ?? verifyBinaryBeforeSpawn
  try {
    if ((await verify(binPath)) === 'mismatch') return 'unchecked'
  } catch {
    return 'unchecked'
  }
  const spawn = deps.spawn ?? ((cmd, a, o) => nodeSpawn(cmd, a, o))
  return new Promise<LoadCheck>((resolve) => {
    const refused = (failure: LoadFailure, detail: string): void => {
      log.warn('Engine check: the operating system still refuses to start it', {
        family,
        problem: describeLoadFailure(failure),
        binPath,
        detail
      })
      reportEngineProblem({ family, ...failure }, binPath)
    }
    let child: ChildProcessLike
    try {
      child = spawn(binPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (err) {
      // A Windows refusal by policy / security software is a refusal; any other spawn error
      // says nothing about the loader.
      const failure = classifySpawnError(err, deps.platform)
      if (failure) refused(failure, String(err))
      resolve(failure ? 'refused' : 'unchecked')
      return
    }
    child.unref?.()
    let stderr = ''
    let settled = false
    const finish = (outcome: LoadCheck): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* best-effort */
      }
      finish('loads') // it ran this long, so the loader accepted it
    }, deps.timeoutMs ?? LOAD_CHECK_TIMEOUT_MS)
    child.stderr?.on('data', (chunk: unknown) => {
      stderr = (stderr + String(chunk)).slice(-4000)
    })
    child.once('error', (err: unknown) => {
      const failure = classifySpawnError(err, deps.platform)
      if (failure) refused(failure, String(err))
      finish(failure ? 'refused' : 'unchecked')
    })
    child.once('close', (code: unknown, signal: unknown) => {
      if (code === 0) {
        finish('loads')
        return
      }
      const failure = classifyLoadFailure({
        exitCode: typeof code === 'number' ? code : null,
        signal: typeof signal === 'string' ? signal : null,
        stderr,
        platform: deps.platform,
        systemDllExists: deps.systemDllExists
      })
      if (!failure) {
        finish('loads')
        return
      }
      refused(failure, stderr.trim().slice(-1000))
      finish('refused')
    })
  })
}

/** The voice engine's program, resolved like the transcriber does. */
export function resolveVoiceEngine(ctx: Pick<AppContext, 'paths' | 'isDev'>): string | null {
  return resolveWhisperCliPath(ctx.paths.rootPath, process.platform, process.env, { isDev: ctx.isDev })
}
