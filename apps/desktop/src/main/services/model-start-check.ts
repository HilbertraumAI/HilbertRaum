import type { AppContext } from './context'
import type { Db } from './db'
import type { AppSettings } from '../../shared/types'
import {
  checkModelBeforeStart,
  createSettingsHashStore,
  findManifestById,
  knownFileVerdict,
  type ModelStartCheck
} from './models'
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
  /**
   * #959: called once when a check changed what the cache knows about the model's files (a file found
   * damaged). `main/index.ts` passes the Performance push, so the screen follows without a reopen. A
   * check that only confirms the cache never calls it. Services never import electron: it is injected.
   */
  onVerdictChanged?: () => void
}

/**
 * #913 (C §913.3): the start check by model id. The manifest by id, the policy-aware developer leniency
 * the chat start uses, and the workspace hash store (lock-aware: a cache miss while locked). A model id no
 * manifest names answers `ok`: there is nothing to check against, so the start goes on as before. A check that
 * comes with its service's manifest reads no folder; one without (vision) reads it synchronously, once per cold
 * start (a few tens of ms on a Kit, #333).
 */
export function createModelStartCheck(deps: ModelStartCheckDeps): ModelStartCheck {
  const hashStore = createSettingsHashStore(deps.getDb, deps.paths.rootPath)
  return async (modelId, { hash, signal, manifest: bound }) => {
    // The composers bind the manifest their service was built from (#913 code review), so a transcription
    // reads no manifest folder; vision names its model per status read and looks it up here.
    const manifest = bound ?? findManifestById(deps.manifestsDir, modelId)
    if (!manifest) return 'ok'
    const developerMode = developerLeniency(deps, deps.getSettings()?.developerMode ?? false)
    const verdict = (): ReturnType<typeof knownFileVerdict> | null => {
      if (!deps.onVerdictChanged) return null
      try {
        return knownFileVerdict(manifest, deps.paths.rootPath, { developerMode, hashStore })
      } catch {
        return null // a locked workspace has no cache to read; nothing to announce
      }
    }
    const before = verdict()
    try {
      return await checkModelBeforeStart(manifest, deps.paths.rootPath, { developerMode, hashStore, hash, signal })
    } finally {
      const after = before === null ? null : verdict()
      if (after !== null && after !== before) deps.onVerdictChanged?.()
    }
  }
}

/** The consumers a repair re-arms: every non-chat role that can hold a start refusal. */
export type RearmTargets = Pick<AppContext, 'embedder' | 'reranker' | 'vision' | 'refreshTranslatorSlot'>

/** A model a check found intact, or a download just put on the drive: its manifest id and role. */
export interface CheckedModel {
  id: string
  role: string
}

/**
 * Re-arm the start refusals the non-chat roles latched: the search model's and the reranker's failed-start latch, the
 * images cooldown, and a latched translator (`refreshTranslatorSlot` replaces it with a fresh instance). Never throws.
 * - Without `checked`: every role. The engine heal (`rearmLlamaConsumers`, #530 / #654): the program they all run
 *   starts again.
 * - With `checked` (#913 review S1): only the roles whose model is in it. A clean "Verify checksum" or "Check all
 *   model files", or a download (`afterModelInstalled`). The search model and the reranker by their id; the images
 *   and translation roles by role (their services name no single model; an empty translator slot is filled the
 *   issue-#40 way). A check of an unrelated model leaves a latch alone, so a translator latched for memory pressure,
 *   and its session GPU fallback, survive a check of the chat model.
 * Each re-armed service checks its files again at its next cold start, so a file still damaged is refused again in
 * about 1 ms.
 */
export function rearmStartRefusals(ctx: RearmTargets, checked?: Iterable<CheckedModel>): void {
  const models = checked ? [...checked] : null
  const named = (id: string | undefined): boolean => models === null || models.some((m) => m.id === id)
  const hasRole = (role: string): boolean => models === null || models.some((m) => m.role === role)
  try {
    // `embedder` is always set in the app; a partial context (a handler row) may leave it out.
    if (ctx.embedder && named(ctx.embedder.id)) ctx.embedder.resetStartFailure?.()
    if (ctx.reranker && named(ctx.reranker.id)) ctx.reranker.resetStartFailure?.()
    if (hasRole('vision')) ctx.vision?.resetStartFailure()
    if (hasRole('translation')) ctx.refreshTranslatorSlot?.()
  } catch (err) {
    log.warn('Re-arming the model starts failed', { error: String(err) })
  }
}
