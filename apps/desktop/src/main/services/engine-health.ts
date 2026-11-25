import { waitForEngineSpawns } from './runtime/spawn-gate'
import { engineChildEnv } from './runtime/engine-env'
import { spawn as nodeSpawn } from 'node:child_process'
import type { EngineBuildStamp, EngineProblemFamily } from '../../shared/types'
import type { AppContext } from './context'
import { isDamagedFilesVerdict, verifyBinaryBeforeSpawn, type BinaryVerifyResult } from './binary-verifier'
import { rewriteEngineFailureRows, rewriteSearchModelFailureRows } from './ingestion/engine-failure'
import { log } from './logging'
import {
  classifyLoadFailure,
  classifyLoadFailureMessage,
  classifySpawnError,
  describeLoadFailure,
  reportEngineProblem,
  reportDamagedEngineFiles,
  type LoadFailure,
  type LoadFailureInput
} from './runtime/engine-load'
import { guardChildStdio, resolveLlamaServerPath, type ChildProcessLike, type SpawnFn } from './runtime/sidecar'
import { ownEngineBuild } from './runtime/gpu-failure'
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

export interface EngineHealResult {
  /** A `gpuAutoDisabled` that a load refusal had set was cleared. */
  gpuFlagCleared: boolean
  /** Failed documents whose row held the raw loader line, rewritten to the canonical text. */
  rowsRewritten: number
  /** #634: failed documents whose row held the search model's raw failure, rewritten likewise. */
  searchModelRowsRewritten: number
}

/**
 * Heal what the app wrote before #530 and #634 at every session start (unlock, create, plaintext
 * startup) — BEFORE the auto-start reads the GPU flags:
 *  - `gpuAutoDisabled` whose `gpuLastError` classifies as a load refusal is cleared with it. The
 *    flag claimed a GPU fault; the library was missing. A genuine GPU fault never matches (its
 *    reason is llama.cpp's own output or a crash), and the flag carries no machine stamp, so it
 *    would otherwise follow the drive to every computer and keep the GPU off there too.
 *  - failed documents whose row holds the loader's raw line (with the absolute drive path) are
 *    rewritten to the canonical, display-mapped text.
 *  - W-70 (app-update plan, T3.11): otherwise, a set `gpuAutoDisabled` whose stamp names another engine build than
 *    the drive's own (`rearmGpuForOtherEngine`) is cleared with its stamp and error: the card gets a new try.
 *  - #634: then those whose row holds the search model's raw failure (a timeout's bare English, a
 *    start failure's stderr tail with the weight file's absolute path) — after #530's pass, so a
 *    load refusal keeps its own text.
 * Idempotent and admission-gated; never throws (a locked or locking workspace is simply skipped).
 */
export function healEngineLoadState(
  ctx: Pick<AppContext, 'db' | 'workspace' | 'paths' | 'isDev'>,
  opts: Pick<LoadFailureInput, 'platform' | 'systemDllExists'> = {}
): EngineHealResult {
  const result: EngineHealResult = { gpuFlagCleared: false, rowsRewritten: 0, searchModelRowsRewritten: 0 }
  try {
    if (!workspaceAdmitsWork(ctx.workspace)) return result
    const s = getSettings(ctx.db)
    if (s.gpuAutoDisabled && s.gpuLastError && classifyLoadFailureMessage(s.gpuLastError, opts) !== null) {
      // W-70 (review R1-2): a clear writes the flag first and its stamp last (`rearmGpuForOtherEngine`).
      updateSettings(ctx.db, { gpuAutoDisabled: false, gpuLastError: null, gpuAutoDisabledEngine: null })
      result.gpuFlagCleared = true
      log.info('Cleared a compatibility-mode flag that an engine load failure had set (not a GPU fault)')
    } else if (s.gpuAutoDisabled && s.gpuAutoDisabledEngine !== null) {
      rearmGpuForOtherEngine(ctx, s.gpuAutoDisabledEngine)
    }
    result.rowsRewritten = rewriteEngineFailureRows(ctx.db, opts)
    result.searchModelRowsRewritten = rewriteSearchModelFailureRows(ctx.db, opts)
  } catch (err) {
    log.warn('Healing engine load-failure state failed', { error: String(err) })
  }
  return result
}

/**
 * W-70 (app-update plan, T3.11; frozen: release 1 is the only version that runs after a "Go back"): a GPU auto-disable
 * set under one engine build says nothing about another, so the card is tried again when the drive's own build
 * (`ownEngineBuild`) differs from the flag's stamp in `version` OR `backend`, as exact text. Inequality, not F-24's
 * order: an older, a newer and a tag this version cannot order are all another build. An unknown own build (no marker
 * this app can read, a dev binary outside the folder) and a missing engine keep the flag until the next session
 * start; so does a flag with no stamp this app can read (every workspace flagged before release 1), as decided by the
 * owner on 2026-11-25. The same version built for another OS is another build too (the Mac's Metal against Vulkan
 * elsewhere): one Kit moved between a Mac and a Windows or Linux computer re-arms on each move (owner, 2026-11-25: "the
 * Mac gets its GPU back"; a known limit). One patch, the flag first and the stamp last (review R1-2): the store writes
 * key by key with no transaction, so a write cut short leaves at worst a stamp beside a false flag, which nothing reads,
 * never a set flag without its stamp, which would never re-arm. The #530 clear and "Try GPU again" keep the same order.
 * No audit event (the #530 clear writes none either). A wrong re-arm costs one failed GPU start, which sets the flag
 * again with this build's stamp. Runs in its own try: a failure here never stops the row heal.
 */
function rearmGpuForOtherEngine(ctx: Pick<AppContext, 'db' | 'paths' | 'isDev'>, stamped: EngineBuildStamp): void {
  try {
    const own = ownEngineBuild(ctx.paths.rootPath, ctx.isDev)
    if (own === null || (own.version === stamped.version && own.backend === stamped.backend)) return
    updateSettings(ctx.db, { gpuAutoDisabled: false, gpuLastError: null, gpuAutoDisabledEngine: null })
    log.info('Cleared a compatibility-mode flag set under another engine build: the graphics card gets a new try', {
      stamped,
      own
    })
  } catch (err) {
    log.warn('Checking the engine build of a compatibility-mode flag failed', { error: String(err) })
  }
}

/** The outcome of starting a program just far enough to know whether the OS loader accepts it. */
export type LoadCheck = 'loads' | 'refused' | 'unchecked'

export interface LoadCheckDeps {
  spawn?: SpawnFn
  verify?: (binPath: string) => Promise<BinaryVerifyResult>
  timeoutMs?: number
  platform?: NodeJS.Platform
  systemDllExists?: (dll: string) => boolean
}

const LOAD_CHECK_TIMEOUT_MS = 10_000

/**
 * Start `binPath args` and report whether the OS loader accepted it (#530 "Check again", both
 * engines). `refused` also records the verdict — a classified exit, a Windows spawn refusal by
 * policy / security software, or (#1012) a copy whose install marker records a file that is still
 * missing or changed, which is never started. `loads` covers any exit the classifier does not recognise (a usage
 * error is still a program that ran) and a program still running at the bound. `unchecked`: (#1012
 * review R-2) a file of its copy could not be read just
 * now — retried on the next "Check again", no damage recorded — or could not be spawned for a reason
 * that says nothing about the loader, or (#790) its stderr stream failed before an exit the
 * classifier does not recognise — the verdict is left as it was. Never throws.
 */
export async function checkProgramLoads(
  family: EngineProblemFamily,
  binPath: string,
  args: string[],
  deps: LoadCheckDeps = {}
): Promise<LoadCheck> {
  const verify = deps.verify ?? verifyBinaryBeforeSpawn
  await waitForEngineSpawns(family) // #516: never check a program an install is replacing
  let verdict: BinaryVerifyResult
  try {
    verdict = await verify(binPath)
  } catch {
    return 'unchecked'
  }
  // `unreadable` (#1012 review R-2): not checked, nothing recorded — the user can choose Check again.
  if (verdict === 'unreadable') return 'unchecked'
  // #1012: a file of the copy is still gone or changed (round 6: a changed one too) — still refused, and
  // the engine-files verdict stands (a run of the program could start fine without it and drop the
  // "Install again" offer).
  if (isDamagedFilesVerdict(verdict)) {
    reportDamagedEngineFiles(family, binPath, deps.platform)
    return 'refused'
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
      child = spawn(binPath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        // #730: llama-server reads the host's llama.cpp variables and config files even for
        // `--version`; whisper-cli has no such loader.
        ...(family === 'llama_cpp' ? { env: engineChildEnv(binPath) } : {})
      })
    } catch (err) {
      // A Windows refusal by policy / security software is a refusal; any other spawn error
      // says nothing about the loader.
      const failure = classifySpawnError(err, deps.platform)
      if (failure) refused(failure, String(err))
      resolve(failure ? 'refused' : 'unchecked')
      return
    }
    // #790: the stderr stream of a spawn that failed before its pipes were open errors too; the
    // child's own 'error' below settles the check. stderr is what a non-zero exit is read from, so a
    // check whose stderr failed cannot say the loader accepted the program (as the GPU probe's stdout).
    let stderrFailed = false
    guardChildStdio(child, `the engine check (${family})`, (stream) => {
      if (stream === 'stderr') stderrFailed = true
    })
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
        // #790: with its stderr cut short, an unrecognised exit may be a refusal whose text never
        // arrived: leave the verdict as it was.
        finish(stderrFailed ? 'unchecked' : 'loads')
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
