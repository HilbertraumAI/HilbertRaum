import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { EngineDownloadJob, EngineStatus } from '../../shared/types'
import { EngineDownloadManager, engineStatus } from '../services/runtime-download'
import { registeredSidecarPids } from '../services/runtime/sidecar'
import { getSettings } from '../services/settings'
import { loadPolicy } from '../services/policy'
import { log } from '../services/logging'
import type { RuntimeManager } from '../services/runtime'
import type { DownloadGates } from '../services/downloads'

// IPC for the in-app engine (llama.cpp sidecar) downloader. Without the engine binary a
// started model falls back to the built-in demo runtime — this lets the user install the
// real engine from inside the app. The gates mirror the model downloader exactly (the
// policy ceiling AND the user's allowNetwork setting), re-checked HERE on every start.

/**
 * Is the chat engine's install dir in LIVE use? True while a model runtime is RUNNING or
 * still STARTING (full-audit 2026-07-11 CODE-13, review follow-up): `activeModelId()` is
 * null during a multi-GB load — the manager commits `current` only after health — but the
 * loading child is ALREADY executing from the llama_cpp dir, so an engine install begun
 * mid-start would still rimraf it. `status().startingModelId` names the in-flight start.
 * Exported for the engine-download suite; the downloadEngine handler is the one consumer.
 */
export function chatEngineInUse(runtime: Pick<RuntimeManager, 'activeModelId' | 'status'>): boolean {
  return runtime.activeModelId() !== null || runtime.status().startingModelId != null
}

/**
 * Is ANY llama-server-backed sidecar's install dir in live use (F-32)? The E5 embedder, reranker,
 * vision and translation sidecars all execute the SAME `runtime/llama.cpp/<os>/` binary a
 * llama_cpp (re-)install pre-cleans — not just the chat runtime CODE-13 covered. The CODE-11
 * per-family sidecar PID registry is the cheap unified signal (a live child ⇒ its family is in
 * use). Exported for the engine-download suite.
 */
export function llamaSidecarInUse(): boolean {
  return registeredSidecarPids('llama_cpp').length > 0
}

/** Is a whisper transcription/dictation child executing from `runtime/whisper.cpp/<os>/` (F-32)? */
export function whisperSidecarInUse(): boolean {
  return registeredSidecarPids('whisper_cpp').length > 0
}

export function registerEngineIpc(ctx: AppContext, manager?: EngineDownloadManager): void {
  const engine =
    manager ?? new EngineDownloadManager({ fetchImpl: fetch, log: (m, meta) => log.info(m, meta) })

  const gates = (): DownloadGates => {
    const { policy } = loadPolicy(ctx.paths.configPath, (m) => log.warn(m), { isDev: ctx.isDev })
    const settingAllows = ctx.workspace.isUnlocked() && getSettings(ctx.db).allowNetwork
    return { policyAllows: policy.network.allowModelDownloads, settingAllows }
  }

  ipcMain.handle(
    IPC.getEngineStatus,
    (): EngineStatus => engineStatus(ctx.paths.rootPath, ctx.manifestsDir ?? null)
  )

  ipcMain.handle(
    IPC.downloadEngine,
    (): Promise<EngineDownloadJob> =>
      engine.start({
        rootPath: ctx.paths.rootPath,
        manifestsDir: ctx.manifestsDir ?? null,
        gates: gates(),
        // CODE-13 (full-audit 2026-07-11): a llama_cpp (re-)install pre-cleans the dir the
        // LIVE chat sidecar executes from — the manager refuses a job that would touch it
        // while a model runtime is up OR still starting (friendly copy; stop the model first).
        chatRuntimeActive: chatEngineInUse(ctx.runtime),
        // F-32 (full-audit 2026-07-16): widen the guard per family — refuse a llama_cpp install
        // while ANY llama-server sidecar (embedder/reranker/vision/translation) has a live child,
        // and a whisper_cpp install mid-transcription/dictation. Installs touching only the other
        // family still proceed.
        llamaSidecarActive: llamaSidecarInUse(),
        whisperActive: whisperSidecarInUse()
      })
  )

  ipcMain.handle(IPC.getEngineJob, (_e, jobId: string): EngineDownloadJob => engine.get(jobId))

  ipcMain.handle(
    IPC.cancelEngineDownload,
    (_e, jobId: string): EngineDownloadJob => engine.cancel(jobId)
  )
}
