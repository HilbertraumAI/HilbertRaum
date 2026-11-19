import type { AppContext } from './context'
import type { Db } from './db'
import type { AppSettings } from '../../shared/types'
import { checkModelBeforeStart, createSettingsHashStore, findManifestById, type ModelStartCheck } from './models'
import { developerLeniency } from './policy'
import { log } from './logging'

// #913: the start check every non-chat role runs before it spawns its model, and what re-arms a
// role that refused once its model is put right. The services take the check as a dependency
// (`compose-services.ts`, `VisionServiceDeps`); `main/index.ts` builds it here, once.

export interface ModelStartCheckDeps {
  /** The drive's model manifests (re-read per check: a download may have changed one). */
  manifestsDir: string | null
  /** The drive root (weight paths) and the config folder (the drive policy). */
  paths: { rootPath: string; configPath: string }
  /** A dev build: developer mode, unless the drive policy says no. */
  isDev: boolean
  /** The workspace settings, or null while the workspace is locked: the developer toggle then reads as off. */
  getSettings: () => AppSettings | null
  /**
   * The live workspace database (it throws while locked). The checksum cache lives there, so a
   * "Check all model files" verdict outlives an app restart, and the search and voice models are
   * hashed once per workspace, not once per app start.
   */
  getDb: () => Db
}

/**
 * #913 (C §913.3): the start check by model id. The manifest by id, the policy-aware developer leniency
 * the chat start uses, and the workspace hash store (lock-aware: a cache miss while locked). A model id no
 * manifest names answers `ok`: there is nothing to check against, so the start goes on as before. The
 * manifest read is synchronous, once per cold start (a few tens of ms on a Kit, #333): acceptable.
 */
export function createModelStartCheck(deps: ModelStartCheckDeps): ModelStartCheck {
  const hashStore = createSettingsHashStore(deps.getDb, deps.paths.rootPath)
  return async (modelId, { hash, signal }) => {
    const manifest = findManifestById(deps.manifestsDir, modelId)
    if (!manifest) return 'ok'
    return checkModelBeforeStart(manifest, deps.paths.rootPath, {
      developerMode: developerLeniency(deps, deps.getSettings()?.developerMode ?? false),
      hashStore,
      hash,
      signal
    })
  }
}

/** The consumers a repair re-arms: every non-chat role that can hold a start refusal. */
export type RearmTargets = Pick<AppContext, 'embedder' | 'reranker' | 'vision' | 'refreshTranslatorSlot'>

/**
 * #913 review S1: re-arm the start refusals the models in `modelIds` may have left behind, after a
 * check found them intact (a clean "Verify checksum" or "Check all model files") or a download put them
 * on the drive. Before, only the chat ladder and the search model were re-armed, so a translation or
 * re-ranking model put right by hand stayed refused until a restart. The search model and the reranker
 * by their id; the images cooldown and the translator slot (a latched instance is replaced) always:
 * each service checks its files again at its next cold start, so a file that is still damaged is
 * refused again in about 1 ms. Never throws.
 */
export function rearmCheckedModels(ctx: RearmTargets, modelIds: Iterable<string>): void {
  const ids = new Set(modelIds)
  try {
    // `embedder` is always set in the app; a partial context (a handler row) may leave it out.
    if (ctx.embedder && ids.has(ctx.embedder.id)) ctx.embedder.resetStartFailure?.()
    if (ctx.reranker && ids.has(ctx.reranker.id)) ctx.reranker.resetStartFailure?.()
    ctx.vision?.resetStartFailure()
    ctx.refreshTranslatorSlot?.()
  } catch (err) {
    log.warn('Re-arming the model starts after a check failed', { error: String(err) })
  }
}
