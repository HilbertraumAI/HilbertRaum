import { ipcMain } from 'electron'
import { EVENTS, IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { AppSettings, ModelInfo, ModelState, RuntimeInstallInfo, RuntimeStatus } from '../../shared/types'
import { readRuntimeMarker } from '../services/assets'
import { llamaServerDir } from '../services/runtime/sidecar'
import {
  buildModelList,
  computeInstallState,
  createSettingsHashStore,
  discoverManifests,
  invalidateChecksum,
  machineRamGb,
  selectModel,
  weightPath
} from '../services/models'
import { getSettings } from '../services/settings'
import { loadPolicy } from '../services/policy'
import { tMain } from '../services/i18n'
import { log } from '../services/logging'

// IPC for model discovery/selection + runtime start/stop (spec §9.1).
// The hardware profile comes from the persisted benchmark (`lastBenchmark`),
// falling back to UNKNOWN until the user runs the benchmark for the first time.

/**
 * Effective checksum leniency: "developer" is the user toggle OR a dev build —
 * but the drive POLICY is authoritative and can only restrict. On a commercial drive
 * (`require_sha256_match: true` / `allow_unverified_models: false`) unverified weights
 * are rejected no matter what the toggle says; this also disables the mock fallback.
 */
function developerLeniency(ctx: AppContext, s: AppSettings): boolean {
  const { policy } = loadPolicy(ctx.paths.configPath, undefined, { isDev: ctx.isDev })
  const developer = s.developerMode || ctx.isDev
  return developer && policy.models.allowUnverifiedModels && !policy.models.requireSha256Match
}

/**
 * Start the runtime for a chat model, enforcing the spec §7.4 install gate (shared by
 * the `startRuntime` IPC handler and the startup auto-start). Throws on any refusal.
 */
export async function startModelRuntime(ctx: AppContext, modelId: string): Promise<RuntimeStatus> {
  if (!ctx.manifestsDir) throw new Error(tMain('main.models.noManifests'))
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
  const lenient = developerLeniency(ctx, s)
  const state = await computeInstallState(found.manifest, ctx.paths.rootPath, {
    developerMode: lenient,
    hashStore: createSettingsHashStore(ctx.db)
  })
  const mockFallback = state === 'missing' && lenient
  if (state !== 'installed' && !mockFallback) {
    // §7 voice: the problem and the next step; the raw state code stays in Diagnostics/logs.
    throw new Error(
      state === 'checksum_failed'
        ? `"${found.manifest.displayName}" can't be started — we couldn't verify its file. ` +
          'It may be incomplete; try downloading it again.'
        : `"${found.manifest.displayName}" can't be started — its model file isn't installed ` +
          'on this drive yet.'
    )
  }

  // RAM gate: loading real weights that exceed this machine's memory would
  // thrash or OOM mid-chat — refuse with a friendly, spec §11.4-toned message. Only
  // real weights are gated; the zero-weights mock fallback uses no real memory.
  if (state === 'installed' && found.manifest.recommendedMinRamGb > machineRamGb()) {
    throw new Error(
      `"${found.manifest.displayName}" needs at least ${found.manifest.recommendedMinRamGb} GB RAM; ` +
        `this computer has about ${machineRamGb()} GB. Pick a smaller model — quality stays great.`
    )
  }

  log.info('Start runtime', { modelId, state })
  const status = await ctx.runtime.start({
    modelId,
    modelPath: weightPath(ctx.paths.rootPath, found.manifest),
    // The user's context-size pick (AI Model screen) wins; automatic (null) = the model's
    // recommended window, falling back to the legacy setting for a manifest without one.
    // Every downstream budget follows the LAUNCHED window via ModelRuntime.contextWindow() (§L0).
    contextTokens:
      s.contextTokensOverride ?? (found.manifest.recommendedContextTokens || s.contextTokens)
  })
  ctx.audit?.('runtime_started', `Model runtime started: ${modelId}`, {
    modelId,
    backend: status.backend ?? null
  })
  return status
}

/**
 * Auto-start the selected (active) chat model in the background once the workspace is
 * usable (app launch for plaintext_dev; unlock/create for encrypted) — a restarted app
 * used to show an "active" model whose runtime silently was not running until the user
 * visited Models and pressed Start. Mirrors `maybeRunFirstBenchmark`: never throws,
 * never blocks; a failure is logged and the manual start path still works.
 */
export function maybeAutoStartActiveModel(ctx: AppContext): void {
  let modelId: string | null = null
  try {
    if (!ctx.workspace.isUnlocked()) return
    const s = getSettings(ctx.db)
    if (!s.autoStartActiveModel) return
    modelId = s.activeModelId
    if (!modelId) return
    if (ctx.runtime.activeModelId()) return // something is already running — keep it
  } catch {
    return // settings unreadable (e.g. just locked again) — manual start still works
  }
  if (!modelId) return
  log.info('Auto-starting the active model runtime in the background', { modelId })
  void startModelRuntime(ctx, modelId).catch((err) =>
    log.warn('Auto-start of the active model failed (start it from the AI Model screen)', {
      modelId,
      error: String(err)
    })
  )
}

export function registerModelIpc(ctx: AppContext): void {
  // F16 (audit-postmerge-2026-06-29): the DB-touching model handlers (list/select/verify/start all
  // read ctx.db via getSettings/selectModel/computeInstallState) fail-close when locked but throw
  // the raw English vault string; gate them with the localized copy (parity). stopRuntime + the two
  // read-only runtime channels (status/install) touch the in-memory runtime / disk marker, never
  // ctx.db, and must stay usable at the gate, so they are intentionally NOT gated.
  const requireUnlocked = (): void => {
    if (!ctx.workspace.isUnlocked()) throw new Error(tMain('main.models.locked'))
  }

  ipcMain.handle(IPC.listModels, async (event, lazyVerify?: boolean): Promise<ModelInfo[]> => {
    requireUnlocked()
    if (!ctx.manifestsDir) {
      log.warn('No model-manifests directory found; returning empty model list')
      return []
    }
    const s = getSettings(ctx.db)
    const { models, manifestErrors } = await buildModelList({
      manifestsDir: ctx.manifestsDir,
      rootPath: ctx.paths.rootPath,
      profile: s.lastBenchmark?.profile ?? 'UNKNOWN',
      developerMode: developerLeniency(ctx, s),
      runningModelId: ctx.runtime.activeModelId(),
      hashStore: createSettingsHashStore(ctx.db),
      machineRamGb: machineRamGb(),
      // RT-3: the chat path (the workspace gate into Chat) passes lazyVerify so only the
      // active model is hashed on a cold cache — the full corpus of multi-GB GGUFs is
      // hashed only on an explicit Models-screen visit. Display-only; the start gate
      // (startModelRuntime) re-verifies the model it actually launches.
      ...(lazyVerify ? { onlyVerifyModelId: s.activeModelId } : {}),
      // First-run weight hashing can take a while on a fresh drive — stream progress back
      // to the calling renderer so the gate + Models screen show a determinate bar. Guard
      // against a closed/destroyed window (navigation away mid-hash).
      onProgress: (p) => {
        if (!event.sender.isDestroyed()) event.sender.send(EVENTS.modelVerifyProgress, p)
      }
    })
    if (manifestErrors.length > 0) {
      log.warn('Invalid model manifests skipped', manifestErrors)
    }
    return models
  })

  ipcMain.handle(IPC.selectModel, (_e, modelId: string) => {
    requireUnlocked()
    if (!ctx.manifestsDir) throw new Error(tMain('main.models.noManifests'))
    log.info('Select model', { modelId })
    const result = selectModel(ctx.db, ctx.manifestsDir, modelId)
    ctx.audit?.('model_selected', `Model selected: ${modelId}`, { modelId })
    return result
  })

  // Forced re-verify (the "Verify checksum" button): drop the cached hash for this
  // model's weight file and re-hash it for real. `listModels` alone would read the
  // cache back and confirm nothing.
  ipcMain.handle(IPC.verifyModel, async (_e, modelId: string): Promise<ModelState> => {
    requireUnlocked()
    if (!ctx.manifestsDir) throw new Error(tMain('main.models.noManifests'))
    const { manifests } = discoverManifests(ctx.manifestsDir)
    const found = manifests.find((m) => m.manifest.id === modelId)
    if (!found) throw new Error(`Unknown model id: ${modelId}`)
    const store = createSettingsHashStore(ctx.db)
    invalidateChecksum(weightPath(ctx.paths.rootPath, found.manifest), store)
    const state = await computeInstallState(found.manifest, ctx.paths.rootPath, {
      developerMode: developerLeniency(ctx, getSettings(ctx.db)),
      hashStore: store
    })
    log.info('Model re-verified', { modelId, state })
    ctx.audit?.('model_verified', `Model checksum re-verified: ${modelId}`, { modelId, state })
    return state
  })

  ipcMain.handle(IPC.startRuntime, (_e, modelId: string): Promise<RuntimeStatus> => {
    requireUnlocked()
    // Starting/switching the runtime tears down the current llama-server. A yielding
    // deep-index build holds that slot and is pinned to the current model (M12) — abort it
    // first so it doesn't keep calling a stopped/replaced runtime, and a parked build (waiting
    // on a chat handoff) doesn't hang. No-op when no build is running; the build is left
    // resumable (it rebuilds from the warm cache under the new model).
    ctx.docTasks?.abortActiveBuild()
    return startModelRuntime(ctx, modelId)
  })

  // The Models screen's one primary action per installed chat card (beta #27, D70): select the
  // model (persist the active chat slot + emit `model_selected`) AND start its runtime, both here
  // so the §7.4 install gate + RAM gate run once and the audit trail is a single event chain. A
  // first-time user had a "Select" AND a "Start runtime" button and couldn't tell which led to
  // chatting; collapsing them removes the ambiguity. Selected models already auto-start at launch,
  // and chat-send never auto-starts (registerChatIpc contract), so the merged action MUST start the
  // runtime — a select alone would still leave the runtime down mid-session.
  ipcMain.handle(IPC.useModel, async (_e, modelId: string): Promise<RuntimeStatus> => {
    requireUnlocked()
    if (!ctx.manifestsDir) throw new Error(tMain('main.models.noManifests'))
    // Reject a non-chat role BEFORE any persist (mirrors startModelRuntime's guard): an automatic
    // role (embeddings/reranker/transcriber/vision/translation) has no chat slot to claim, and
    // selecting an embeddings model here would silently touch its separate slot. The UI never
    // reaches this for those roles, but the handler stays honest for non-UI callers.
    const { manifests } = discoverManifests(ctx.manifestsDir)
    const found = manifests.find((m) => m.manifest.id === modelId)
    if (!found) throw new Error(`Unknown model id: ${modelId}`)
    if (found.manifest.role !== 'chat') {
      throw new Error(`Model "${modelId}" is a ${found.manifest.role} model, not a chat model.`)
    }
    // Select first so a refresh mid-load reflects the choice on the Active badge; selectModel
    // persists the active slot + emits its own `model_selected` audit event.
    log.info('Use model (select + start)', { modelId })
    selectModel(ctx.db, ctx.manifestsDir, modelId)
    ctx.audit?.('model_selected', `Model selected: ${modelId}`, { modelId })
    // Mirror startRuntime: free the runtime slot from any yielding deep-index build before the
    // start tears down / replaces llama-server.
    ctx.docTasks?.abortActiveBuild()
    // No rollback on a start failure: selecting persisted (matching the old Select button, which
    // always persisted regardless of a later Start), and the freshly-selected model auto-starts at
    // the next launch + can be retried — so a transient start failure keeps the user's choice
    // rather than silently reverting it. The install/RAM gates inside startModelRuntime still throw
    // and DON'T start (the UI already disables the button for those, so this is the non-UI guard).
    return startModelRuntime(ctx, modelId)
  })

  ipcMain.handle(IPC.stopRuntime, async (): Promise<void> => {
    log.info('Stop runtime')
    const modelId = ctx.runtime.activeModelId()
    ctx.docTasks?.abortActiveBuild()
    await ctx.runtime.stop()
    if (modelId) {
      ctx.audit?.('runtime_stopped', `Model runtime stopped: ${modelId}`, { modelId })
    }
  })

  // Read-only runtime state for the Diagnostics screen (spec §7.11),
  // enriched with the active model's `supports_thinking_mode` manifest flag
  // so the Chat composer knows whether to offer the Deep answer mode. Manifest reads
  // happen only while a runtime is actually running (the ChatScreen's not-running
  // poll stays I/O-free), and a read failure just leaves the flag absent.
  ipcMain.handle(IPC.getRuntimeStatus, (): RuntimeStatus => {
    const status = ctx.runtime.status()
    if (status.running && status.modelId && ctx.manifestsDir) {
      try {
        const { manifests } = discoverManifests(ctx.manifestsDir)
        const found = manifests.find((m) => m.manifest.id === status.modelId)
        if (found) status.supportsThinkingMode = found.manifest.supportsThinkingMode
      } catch {
        /* Diagnostics/Chat still get the plain status */
      }
    }
    // #36: whether CPU is the crash-fallback latch ("compatibility mode") — the Chat header
    // hint says so instead of a bare "CPU". Best-effort like the manifest read above.
    if (status.running) {
      try {
        status.gpuAutoDisabled = getSettings(ctx.db).gpuAutoDisabled
      } catch {
        /* settings unreadable (e.g. just locked) — the plain status still serves */
      }
    }
    return status
  })

  // Which sidecar build the drive carries (the .hilbertraum-runtime.json install marker) —
  // the Diagnostics "runtime build" line. Null on unmarked/DIY drives.
  ipcMain.handle(
    IPC.getRuntimeInstall,
    (): RuntimeInstallInfo | null => readRuntimeMarker(llamaServerDir(ctx.paths.rootPath))
  )
}
