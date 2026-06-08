import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { ModelInfo, RuntimeStatus } from '../../shared/types'
import { buildModelList, discoverManifests, selectModel, weightPath } from '../services/models'
import { getSettings } from '../services/settings'
import { log } from '../services/logging'

// Phase 2 IPC: model discovery/selection + runtime start/stop (spec §9.1).
// Hardware profile is stubbed to LITE until the Phase 7 benchmark lands.
const STUB_PROFILE = 'LITE' as const

export function registerModelIpc(ctx: AppContext): void {
  ipcMain.handle(IPC.listModels, async (): Promise<ModelInfo[]> => {
    if (!ctx.manifestsDir) {
      log.warn('No model-manifests directory found; returning empty model list')
      return []
    }
    const s = getSettings(ctx.db)
    const { models, manifestErrors } = await buildModelList({
      manifestsDir: ctx.manifestsDir,
      rootPath: ctx.paths.rootPath,
      profile: STUB_PROFILE,
      developerMode: s.developerMode,
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

    const s = getSettings(ctx.db)
    log.info('Start runtime', { modelId })
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
}
