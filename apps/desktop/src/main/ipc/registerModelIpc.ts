import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { AppSettings, ModelInfo, RuntimeStatus } from '../../shared/types'
import {
  buildModelList,
  computeInstallState,
  discoverManifests,
  selectModel,
  weightPath
} from '../services/models'
import { getSettings } from '../services/settings'
import { loadPolicy } from '../services/policy'
import { log } from '../services/logging'

// Phase 2 IPC: model discovery/selection + runtime start/stop (spec §9.1).
// The hardware profile comes from the persisted Phase-7 benchmark (`lastBenchmark`),
// falling back to UNKNOWN until the user runs the benchmark for the first time.

export function registerModelIpc(ctx: AppContext): void {
  /**
   * Effective checksum leniency (M10): "developer" is the user toggle OR a dev build —
   * but the drive POLICY is authoritative and can only restrict. On a commercial drive
   * (`require_sha256_match: true` / `allow_unverified_models: false`) unverified weights
   * are rejected no matter what the toggle says; this also disables the mock fallback.
   */
  const developerLeniency = (s: AppSettings): boolean => {
    const { policy } = loadPolicy(ctx.paths.configPath)
    const developer = s.developerMode || ctx.isDev
    return developer && policy.models.allowUnverifiedModels && !policy.models.requireSha256Match
  }

  ipcMain.handle(IPC.listModels, async (): Promise<ModelInfo[]> => {
    if (!ctx.manifestsDir) {
      log.warn('No model-manifests directory found; returning empty model list')
      return []
    }
    const s = getSettings(ctx.db)
    const { models, manifestErrors } = await buildModelList({
      manifestsDir: ctx.manifestsDir,
      rootPath: ctx.paths.rootPath,
      profile: s.lastBenchmark?.profile ?? 'UNKNOWN',
      developerMode: developerLeniency(s),
      runningModelId: ctx.runtime.activeModelId()
    })
    if (manifestErrors.length > 0) {
      log.warn('Invalid model manifests skipped', manifestErrors)
    }
    return models
  })

  ipcMain.handle(IPC.selectModel, (_e, modelId: string) => {
    if (!ctx.manifestsDir) throw new Error('No model-manifests directory found')
    log.info('Select model', { modelId })
    return selectModel(ctx.db, ctx.manifestsDir, modelId)
  })

  ipcMain.handle(IPC.startRuntime, async (_e, modelId: string): Promise<RuntimeStatus> => {
    if (!ctx.manifestsDir) throw new Error('No model-manifests directory found')
    const { manifests } = discoverManifests(ctx.manifestsDir)
    const found = manifests.find((m) => m.manifest.id === modelId)
    if (!found) throw new Error(`Unknown model id: ${modelId}`)
    // The chat runtime loads chat models only; an embeddings model here would start
    // llama-server in chat mode over a 384-dim embedder and produce garbage.
    if (found.manifest.role !== 'chat') {
      throw new Error(`Model "${modelId}" is a ${found.manifest.role} model, not a chat model.`)
    }

    const s = getSettings(ctx.db)
    // Enforce the spec §7.4 gate in the MAIN process (not just a disabled button): only
    // an installed (verified) model may start. One exception keeps the zero-weights
    // first-run journey alive — for a developer (toggle or dev build, when the drive
    // policy permits unverified models) a MISSING model may start, because the selecting
    // runtime factory then falls back to the built-in mock runtime.
    const lenient = developerLeniency(s)
    const state = await computeInstallState(found.manifest, ctx.paths.rootPath, {
      developerMode: lenient
    })
    const mockFallback = state === 'missing' && lenient
    if (state !== 'installed' && !mockFallback) {
      throw new Error(`Model "${modelId}" cannot be started (state: ${state}).`)
    }

    log.info('Start runtime', { modelId, state })
    return ctx.runtime.start({
      modelId,
      modelPath: weightPath(ctx.paths.rootPath, found.manifest),
      contextTokens: found.manifest.recommendedContextTokens || s.contextTokens
    })
  })

  ipcMain.handle(IPC.stopRuntime, async (): Promise<void> => {
    log.info('Stop runtime')
    await ctx.runtime.stop()
  })

  // Read-only runtime state for the Diagnostics screen (spec §7.11 — audit M14).
  ipcMain.handle(IPC.getRuntimeStatus, (): RuntimeStatus => ctx.runtime.status())
}
