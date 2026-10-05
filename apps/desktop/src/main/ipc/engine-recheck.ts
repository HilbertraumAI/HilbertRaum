import type { EngineProblemFamily, EngineRecheckResult } from '../../shared/types'
import type { AppContext } from '../services/context'
import {
  checkProgramLoads,
  healEngineLoadState,
  resolveVoiceEngine,
  type LoadCheck,
  type LoadCheckDeps
} from '../services/engine-health'
import { clearEngineProblem, engineProblems } from '../services/runtime/engine-load'
import { clearModelLoadLatches } from '../services/runtime/factory'
import { resolveLlamaServerPath } from '../services/runtime/sidecar'
import { workspaceAdmitsWork } from '../services/workspace-vault'
import { log } from '../services/logging'
import { probeAndPersistGpu } from './registerBenchmarkIpc'
import { startModelRuntime } from './registerModelIpc'

// "Check again" (#530, `engine:recheck`; architecture.md "Engine load failures"): the user
// installed the missing library (or the Visual C++ runtime) and wants the engine back without a
// restart. Each family with a verdict is started once more; the ones the OS now accepts lose their
// verdict, and every latch a refusal left behind is re-armed — so the next start, import, question
// or translation simply works. A restart heals too: the verdict is never persisted.

/**
 * Re-arm every chat-engine consumer that latched a failed start: the #372 model latches, the
 * embedder's and reranker's `startFailed`, the vision cooldown and a latched translator slot. Run
 * after a chat-engine install (a new binary — before #530 that re-armed the model latches only, so
 * a repaired engine still failed every import until a restart) and after a successful re-check.
 */
export function rearmLlamaConsumers(ctx: AppContext): void {
  clearModelLoadLatches()
  try {
    ctx.embedder?.resetStartFailure?.()
    ctx.reranker?.resetStartFailure?.()
    ctx.vision?.resetStartFailure()
    ctx.refreshTranslatorSlot?.()
  } catch (err) {
    log.warn('Re-arming the AI engine consumers failed', { error: String(err) })
  }
}

/**
 * Bring the selected model back on the real engine when the demo runtime is standing in for it
 * (the walk ended on the mock because every rung was refused, or the engine was missing). Run
 * fire-and-forget by the re-check and, since #532, after a chat-engine install: a model load takes
 * as long as it takes, and the screens follow the runtime status as usual. The same discipline as
 * the IPC start paths: an active deep-index build is aborted first. A start already in flight is
 * left alone — it walks the ladder on the engine as it now is, and a second start would cut it off.
 */
export async function restartChatOnRealEngine(ctx: AppContext): Promise<void> {
  const status = ctx.runtime.status()
  const modelId = status.modelId
  if (status.backend !== 'mock' || !modelId || status.startingModelId) return
  if (!workspaceAdmitsWork(ctx.workspace)) return
  log.info('The real AI engine is on the drive — restarting the selected model on it', { modelId })
  ctx.docTasks?.abortActiveBuild()
  await ctx.runtime.stop()
  await startModelRuntime(ctx, modelId)
}

export interface RecheckDeps extends LoadCheckDeps {
  /** Test seam: the restart that follows a healed chat engine (default: fire-and-forget restart). */
  restartChat?: (ctx: AppContext) => Promise<void>
}

/**
 * Single flight: two "Check again" buttons can be on screen at once (the chat banner and the voice
 * hint), and a second concurrent pass would stop/start the model a second time — possibly cancelling
 * the first restart or a start the user just made. A click while a pass runs joins it.
 */
let inFlight: Promise<EngineRecheckResult> | null = null

/** Re-check every engine with a verdict; see the module note. Never throws. */
export function recheckEngines(ctx: AppContext, deps: RecheckDeps = {}): Promise<EngineRecheckResult> {
  if (inFlight) return inFlight
  const run = runRecheck(ctx, deps).finally(() => {
    inFlight = null
  })
  inFlight = run
  return run
}

async function runRecheck(ctx: AppContext, deps: RecheckDeps): Promise<EngineRecheckResult> {
  const healed: EngineProblemFamily[] = []
  for (const problem of engineProblems()) {
    const family = problem.family
    try {
      const outcome = await recheckFamily(ctx, family, deps)
      // 'gone': the program left the drive — its verdict no longer describes anything (the
      // missing-engine banner speaks now), but nothing was healed, so nothing is re-armed.
      // 'unchecked': it could not be started at all (integrity check, a spawn error that says
      // nothing about the loader) — the verdict stands.
      if (outcome === 'loads' || outcome === 'gone') clearEngineProblem(family)
      if (outcome === 'loads') healed.push(family)
    } catch (err) {
      log.warn('Engine re-check failed', { family, error: String(err) })
    }
  }
  if (healed.length > 0) log.info('Engine re-check: the operating system now starts it', { healed })
  if (healed.includes('llama_cpp')) {
    rearmLlamaConsumers(ctx)
    // A compatibility-mode flag the refusal had set, and rows that still carry its raw line.
    healEngineLoadState(ctx, deps)
    // The device probe the refusal left unanswered: re-probe and persist the real answer for this
    // computer (the cache is dropped first so no earlier answer stands in for it).
    if (workspaceAdmitsWork(ctx.workspace)) {
      ctx.probeGpu?.invalidate()
      await probeAndPersistGpu(ctx)
    }
    const restart = deps.restartChat ?? restartChatOnRealEngine
    void restart(ctx).catch((err: unknown) => {
      log.warn('Restarting the model after the engine re-check failed', { error: String(err) })
    })
  }
  return { problems: engineProblems() }
}

/**
 * Start the family's program just far enough to know whether the OS accepts it. An explicit spawn
 * rather than the GPU probe: the probe answers `[]` for a binary it could not even run (a failed
 * integrity check, a spawn error), which would read as "loads" — `checkProgramLoads` tells those
 * apart as 'unchecked'.
 */
async function recheckFamily(
  ctx: AppContext,
  family: EngineProblemFamily,
  deps: RecheckDeps
): Promise<LoadCheck | 'gone'> {
  const binPath =
    family === 'llama_cpp'
      ? resolveLlamaServerPath(ctx.paths.rootPath, process.platform, process.env, { isDev: ctx.isDev })
      : resolveVoiceEngine(ctx)
  // The program is gone (deleted, or the drive changed).
  if (!binPath) return 'gone'
  return checkProgramLoads(family, binPath, family === 'llama_cpp' ? ['--version'] : ['--help'], deps)
}
