import { guardedHandleFor } from './guarded-handle'
import { refreshGpuProbeAfterRuntimeInstall } from './registerBenchmarkIpc'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { EngineDownloadJob, EngineStatus } from '../../shared/types'
import { EngineDownloadManager, engineStatus, parseEngineDownloadRequest } from '../services/runtime-download'
import { registeredSidecarPids } from '../services/runtime/sidecar'
import { workspaceAdmitsWork } from '../services/workspace-vault'
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

/** Is a kiwix-serve / kiwix-manage child executing from `runtime/kiwix-tools/<os>/` (#339 P8-2)? */
export function kiwixToolsInUse(): boolean {
  return registeredSidecarPids('kiwix_tools').length > 0
}

export function registerEngineIpc(ctx: AppContext, manager?: EngineDownloadManager): void {
  const ipcHandle = guardedHandleFor(ctx)
  const engine =
    manager ?? new EngineDownloadManager({ fetchImpl: fetch, log: (m, meta) => log.info(m, meta) })
  // Issue #323: a benchmark run BEFORE the chat engine existed persisted an empty stamped GPU
  // probe (PR #308 decision 6 — an honest "no card"), and nothing re-ran the probe until the
  // next unlock, the next check or "Try GPU again". Installing the chat engine is the moment
  // that answer can change, so it re-runs the once-per-session probe refresh — the benchmark
  // itself is not re-run, and a probe that already lists a device is left alone.
  engine.onInstalled((families) => {
    if (families.includes('llama_cpp')) void refreshGpuProbeAfterRuntimeInstall(ctx)
    // #339 P8-2: the knowledge-pack tools just arrived — the packs panel's status re-resolves
    // the binaries on its next read, and the searchability cache key carries the tools
    // fingerprint (rag-design §17 D-Z11/D-Z15), so one background reconcile re-probes every
    // pack with the new bundle and announces the result through `packs:changed`. Only while
    // the workspace still admits work: a lock that landed mid-download owns the teardown.
    if (families.includes('kiwix_tools') && ctx.zim && workspaceAdmitsWork(ctx.workspace)) {
      ctx.zim.reconcile(ctx.db).catch((err) => {
        // A lock that lands mid-pass aborts it by design — not a failure worth a warning.
        if (err instanceof Error && err.name === 'AbortError') return
        log.warn('Knowledge-pack reconcile after the tools install failed', String(err))
      })
    }
  })

  const gates = (): DownloadGates => {
    const { policy } = loadPolicy(ctx.paths.configPath, (m) => log.warn(m), { isDev: ctx.isDev })
    const settingAllows = ctx.workspace.isUnlocked() && getSettings(ctx.db).allowNetwork
    return { policyAllows: policy.network.allowModelDownloads, settingAllows }
  }

  ipcHandle(
    IPC.getEngineStatus,
    (): EngineStatus => engineStatus(ctx.paths.rootPath, ctx.manifestsDir ?? null)
  )

  ipcHandle(
    IPC.downloadEngine,
    (_e, raw?: unknown): Promise<EngineDownloadJob> =>
      engine.start({
        rootPath: ctx.paths.rootPath,
        manifestsDir: ctx.manifestsDir ?? null,
        gates: gates(),
        // #339 P8-2: the OPTIONAL argument. Absent = the default install (required families
        // only — the manager never reaches an optional family without it). The consent dialog
        // sends `{ families: ['kiwix_tools'] }` after the licence acknowledgement; the payload
        // is renderer input and is validated against the code's own family names.
        ...parseEngineDownloadRequest(raw),
        // CODE-13 (full-audit 2026-07-11): a llama_cpp (re-)install pre-cleans the dir the
        // LIVE chat sidecar executes from — the manager refuses a job that would touch it
        // while a model runtime is up OR still starting (friendly copy; stop the model first).
        chatRuntimeActive: chatEngineInUse(ctx.runtime),
        // F-32 (full-audit 2026-07-16): widen the guard per family — refuse a llama_cpp install
        // while ANY llama-server sidecar (embedder/reranker/vision/translation) has a live child,
        // and a whisper_cpp install mid-transcription/dictation. Installs touching only the other
        // family still proceed.
        llamaSidecarActive: llamaSidecarInUse(),
        whisperActive: whisperSidecarInUse(),
        // #339 P8-1 R-e / P8-2: a kiwix_tools (re-)install pre-cleans the dir a live
        // kiwix-serve / kiwix-manage child executes from — refused while one is registered.
        kiwixToolsActive: kiwixToolsInUse()
      })
  )

  ipcHandle(IPC.getEngineJob, (_e, jobId: string): EngineDownloadJob => engine.get(jobId))

  ipcHandle(
    IPC.cancelEngineDownload,
    (_e, jobId: string): EngineDownloadJob => engine.cancel(jobId)
  )
}
