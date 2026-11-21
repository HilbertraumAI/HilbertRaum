import { guardedHandleFor } from './guarded-handle'
import { refreshGpuProbeAfterRuntimeInstall } from './registerBenchmarkIpc'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type {
  AuditEventType,
  EngineDownloadJob,
  EngineDownloadPreview,
  EngineProblemFamily,
  EngineRecheckResult,
  EngineStatus,
  OcrInstallJob,
  OcrInstallStatus
} from '../../shared/types'
import {
  EngineDownloadManager,
  engineStatus,
  parseEngineDownloadRequest,
  previewEngineDownload,
  type EngineFamily,
  type EngineJobEnd
} from '../services/runtime-download'
import { OcrInstallManager, assertNoOcrInstallPayload } from '../services/ocr-install'
import { registeredSidecarPids } from '../services/runtime/sidecar'
import {
  engineInstalled,
  engineProblemBuilds,
  engineProblemFor,
  type EngineProblemBuilds
} from '../services/runtime/engine-load'
import { engineProblemOffersReinstall } from '../../shared/engine-problem'
import { rearmLlamaConsumers, recheckEngines, restartChatOnRealEngine } from './engine-recheck'
import { modelBusyLane } from './model-busy'
import { startModelRuntime } from './registerModelIpc'
import { refreshOcrSlot, refreshTranscriberSlot } from '../services/compose-services'
import { workspaceAdmitsWork } from '../services/workspace-vault'
import { getSettings } from '../services/settings'
import { loadPolicy } from '../services/policy'
import { log } from '../services/logging'
import { zimErrorClass } from '../services/zim/error-class'
import { tMain } from '../services/i18n'
import type { RuntimeManager } from '../services/runtime'
import type { DownloadGates } from '../services/downloads'
import { isModelStarting } from '../../shared/runtime-status'

// IPC for the in-app engine (llama.cpp sidecar) downloader. Without the engine binary a
// started model falls back to the built-in demo runtime — this lets the user install the
// real engine from inside the app. The gates mirror the model downloader exactly (the
// policy ceiling AND the user's allowNetwork setting), re-checked HERE on every start.
// The OCR language-file installer (#410) lives here too — it shares the gates, but it is its
// own narrow service, not an engine family (`services/ocr-install.ts`).

/**
 * Is the chat engine's install dir in LIVE use? True while a model runtime is RUNNING or
 * still STARTING (full-audit 2026-07-11 CODE-13, review follow-up): `activeModelId()` is
 * null during a multi-GB load — the manager commits `current` only after health — but the
 * loading child is ALREADY executing from the llama_cpp dir, so an engine install begun
 * mid-start would still replace it. `status().startingModelId` names the in-flight start.
 * A model answering on the built-in DEMO runtime does not count (#532, the CODE-13 polish
 * candidate): the mock never executes the engine dir, and it is exactly what runs while the
 * engine is missing or refused — so the install or the repair the user needs is no longer
 * refused with "stop the model first". A start still counts: its ladder spawns the real binary.
 * Exported for the engine-download suite; the downloadEngine handler is the one consumer.
 */
export function chatEngineInUse(runtime: Pick<RuntimeManager, 'activeModelId' | 'status'>): boolean {
  const status = runtime.status()
  if (status.startingModelId != null) return true
  return runtime.activeModelId() !== null && status.backend !== 'mock'
}

/**
 * #516: is work running that an engine update's pause would cut off? On the chat engine: any
 * generation in either lane (an in-app answer, a local-API completion), a document task, a skill
 * run or the benchmark (`modelBusyLane`), a model that is still starting, a document translation,
 * or an image analysis. On either engine: an import, a re-index or a knowledge-pack article save
 * (the embedder; for audio, the voice engine). On the voice engine: a transcription or dictation.
 * Exported for the engine IPC suite.
 */
export function engineUpdateBusy(
  ctx: Pick<AppContext, 'runtime' | 'docTasks' | 'translateJobs' | 'ingestionActive' | 'vision'>,
  families: readonly string[]
): boolean {
  if (families.includes('llama_cpp')) {
    if (modelBusyLane(ctx) !== null) return true
    if (ctx.runtime.isGenerating?.() === true) return true
    // #599: a start still checking its weights counts too — an update then would resume the
    // previous model behind the user's back (`resumeChatModel`) and could undo their switch.
    if (isModelStarting(ctx.runtime.status())) return true
    if (ctx.translateJobs?.getActiveJob()) return true
    if (ctx.vision?.hasActiveJob?.() === true) return true
  }
  if (ctx.ingestionActive?.() === true) return true
  return families.includes('whisper_cpp') && whisperSidecarInUse()
}

/**
 * #516: stop everything that runs from the engine folders an update is about to replace. The
 * helpers come back by themselves on their next use (the lock teardown's `suspend()`s, never the
 * latching `stop()`; vision lets its idle sidecar go without the lock's purge of finished answers);
 * the chat model is brought back by the update's resume. Until the swap is over, any of them that
 * restarts waits at the spawn gate (`runtime/spawn-gate.ts`).
 */
async function pauseEngineUsers(ctx: AppContext, families: readonly string[]): Promise<void> {
  const stops: Array<Promise<unknown>> = []
  if (families.includes('llama_cpp')) {
    stops.push(
      ctx.runtime.stop({ startFollows: true }), // the update's resume starts it again (#600)
      ctx.embedder.suspend?.() ?? Promise.resolve(),
      ctx.reranker?.suspend?.() ?? Promise.resolve(),
      ctx.vision?.releaseRuntime?.() ?? Promise.resolve(),
      ctx.translator?.suspend?.() ?? Promise.resolve()
    )
  }
  if (families.includes('whisper_cpp')) stops.push(ctx.transcriber?.suspend?.() ?? Promise.resolve())
  await Promise.allSettled(stops)
}

/** #516: start `modelId` again after an update, unless the session moved on (locked, or another start). */
async function resumeChatModel(ctx: AppContext, modelId: string | null): Promise<void> {
  if (!modelId || !workspaceAdmitsWork(ctx.workspace)) return
  const status = ctx.runtime.status()
  if (status.running || isModelStarting(status)) return
  log.info('Engine update finished — starting the model again', { modelId })
  await startModelRuntime(ctx, modelId)
}

/**
 * #532: may `family` be installed again? Only while it holds a "files damaged" verdict this session —
 * the one refusal a fresh copy can fix — and not once a fresh copy was refused too (`afterInstall`,
 * #678: the renderer's own rule, so the check that holds matches what the screen offers). Engines the
 * verdict store does not cover (the knowledge-pack tools) never qualify.
 */
function repairable(family: EngineFamily): boolean {
  const problem = hasVerdicts(family) ? engineProblemFor(family) : null
  return problem !== null && engineProblemOffersReinstall(problem)
}

/** The engine families the verdict store covers (#530); the knowledge-pack tools are not one. */
function hasVerdicts(family: EngineFamily): family is EngineProblemFamily {
  return family === 'llama_cpp' || family === 'whisper_cpp'
}

/**
 * #678: the builds a reinstall of `families` replaces — the ones the OS refused. On a Kit a verdict
 * only the `cpu/` net reported is about the `cpu/` net: re-fetching the main build left it damaged
 * and brought the same offer back. Read after {@link repairable} admitted every family.
 */
function refusedBuilds(families: readonly EngineFamily[]): Partial<Record<EngineFamily, EngineProblemBuilds>> {
  const builds: Partial<Record<EngineFamily, EngineProblemBuilds>> = {}
  for (const family of families) {
    const refused = hasVerdicts(family) ? engineProblemBuilds(family) : null
    if (refused) builds[family] = refused
  }
  return builds
}

/**
 * Is ANY llama-server-backed sidecar's install dir in live use (F-32)? The E5 embedder, reranker,
 * vision and translation sidecars all execute the SAME `runtime/llama.cpp/<os>/` binary a
 * llama_cpp (re-)install replaces — not just the chat runtime CODE-13 covered. The CODE-11
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

/**
 * #843: what starts a job this registrar audits. Every engine and OCR job started here is one the user
 * confirmed in a dialog; an in-app updater will record the same audit types with its own trigger.
 */
const AUDIT_TRIGGER = 'user'

/**
 * #843: an engine job's audit metadata — code names, versions and counts only, from what the job
 * set out to fetch (`preview`, the same plan its dialog showed when it opened). Never the job's
 * `error`, which is friendly copy and can carry a drive path or a URL's failure text.
 */
function engineAuditMetadata(
  job: EngineDownloadJob,
  preview: EngineDownloadPreview,
  end?: Pick<EngineJobEnd, 'reason' | 'cause' | 'space'>
): Record<string, unknown> {
  const versions: Record<string, string> = {}
  for (const item of preview.items) versions[item.family] = item.version
  return {
    jobId: job.jobId,
    // The plan's kind, never rebuilt from the job's flags: one rule (`planEngineSteps`), so a kind
    // an in-app updater adds is recorded as planned.
    kind: preview.kind,
    families: [...(job.families ?? [])],
    versions,
    sizeBytes: preview.totalBytes,
    trigger: AUDIT_TRIGGER,
    ...(end?.reason ? { reason: end.reason } : {}),
    ...(end?.cause ? { cause: end.cause } : {}),
    // #986: a `noSpace` end's two byte counts, the figures its message named.
    ...(end?.space ? { neededBytes: end.space.neededBytes, freeBytes: end.space.freeBytes } : {})
  }
}

export interface RegisterEngineIpcOptions {
  /** The OCR installer (#410); tests inject one with a fake fetch and fake pins. */
  ocrInstaller?: OcrInstallManager
}

export function registerEngineIpc(
  ctx: AppContext,
  manager?: EngineDownloadManager,
  options: RegisterEngineIpcOptions = {}
): void {
  const ipcHandle = guardedHandleFor(ctx)
  const engine =
    manager ?? new EngineDownloadManager({ fetchImpl: fetch, log: (m, meta) => log.info(m, meta) })
  const ocrInstaller =
    options.ocrInstaller ?? new OcrInstallManager({ fetchImpl: fetch, log: (m, meta) => log.info(m, meta) })
  // Issue #323: a benchmark run BEFORE the chat engine existed persisted an empty stamped GPU
  // probe (PR #308 decision 6 — an honest "no card"), and nothing re-ran the probe until the
  // next unlock, the next check or "Try GPU again". Installing the chat engine is the moment
  // that answer can change, so it re-runs the once-per-session probe refresh — the benchmark
  // itself is not re-run, and a probe that already lists a device is left alone.
  // #516: the update in flight (the manager runs one job at a time), and what its pause stopped.
  // `resumed`: the install hook brought the model back, so the settle listener leaves it alone.
  let pendingUpdate: { jobId: string; modelId: string | null; paused: boolean; resumed: boolean } | null =
    null

  engine.onInstalled((families, programs) => {
    if (families.includes('llama_cpp')) {
      // #372: a new runtime binary may load what the old one could not (a pin that adds an
      // architecture) — every model the ladder latched as unloadable this session is re-armed.
      // #530: and every other consumer's failed-start latch with it (the embedder's used to need
      // a lock/unlock), and the old binary's load verdict no longer describes the new one — a
      // refusal of the new binary re-reports itself on its first spawn (the probe just below).
      // #532: one that still says "files damaged" is then marked as about this fresh copy (#678:
      // either fresh copy, when the job replaced the `cpu/` net too).
      // #654: this call is the install's re-arm, verdict or not — the store's `installed` drop
      // heals nothing on its own (`rearmWhenChatEngineHeals` answers `started` only).
      engineInstalled('llama_cpp', programs.llama_cpp)
      rearmLlamaConsumers(ctx)
      // #532: a model the demo runtime stands in for comes back on the real engine, as after a
      // healed "Check again" — after the probe refresh, so the ladder reads this computer's answer.
      // #516: after an update, the model its pause stopped comes back the same way.
      const update = pendingUpdate?.paused ? pendingUpdate : null
      if (update) update.resumed = true
      void refreshGpuProbeAfterRuntimeInstall(ctx)
        .then(() => (update ? resumeChatModel(ctx, update.modelId) : restartChatOnRealEngine(ctx)))
        .catch((err: unknown) => {
          log.warn('Restarting the model after the engine install failed', { error: String(err) })
        })
    }
    // #497: the voice engine just arrived — when the speech model is already on the drive the
    // transcriber selects NOW, so the composer mic appears without a restart (the model-download
    // twin of this hook is `AppContext.onModelInstalled`). Never throws; a null slot only.
    if (families.includes('whisper_cpp')) {
      engineInstalled('whisper_cpp', programs.whisper_cpp) // #530/#532: a new binary; a refusal re-reports
      refreshTranscriberSlot(ctx)
    }
    // #339 P8-2: the knowledge-pack tools just arrived — the packs panel's status re-resolves
    // the binaries on its next read, and the searchability cache key carries the tools
    // fingerprint (rag-design §17 D-Z11/D-Z15), so one background reconcile re-probes every
    // pack with the new bundle and announces the result through `packs:changed`. Only while
    // the workspace still admits work: a lock that landed mid-download owns the teardown.
    if (families.includes('kiwix_tools') && ctx.zim && workspaceAdmitsWork(ctx.workspace)) {
      ctx.zim.reconcile(ctx.db).catch((err) => {
        // A lock that lands mid-pass aborts it by design — not a failure worth a warning.
        if (err instanceof Error && err.name === 'AbortError') return
        // The class, never `String(err)`: a failed start or an fs error names a path (#712).
        log.warn('Knowledge-pack reconcile after the tools install failed', { error: zimErrorClass(err) })
      })
    }
  })

  // #843: every engine job the user confirmed is recorded — once when it starts, once when it ends
  // (finished, or failed with a content-free reason: `cancelled` and `networkOff` included). A job
  // refused before it exists (a closed gate, nothing to do) records nothing, as a model download's.
  // The recorder buffers while the workspace is locked, so a lock in the middle needs nothing here.
  // The start is recorded when `start()` resolves. A job cannot settle before that: `start()` returns
  // before its run's first file operation completes, and the handler resumes on the next microtask.
  // `start()` stores every job's plan before it returns, so `preview` is always there; the null arm is
  // a type guard, never a second rule. Never throws: an audit fault must not fail the install it records.
  const auditEngine = (
    type: AuditEventType,
    job: EngineDownloadJob,
    preview: EngineDownloadPreview | null,
    end?: EngineJobEnd
  ): void => {
    try {
      if (!preview) {
        log.warn('Engine job audit skipped: no plan recorded for the job', { jobId: job.jobId, type })
        return
      }
      const metadata = engineAuditMetadata(job, preview, end)
      const verb = type === 'engine_install_started' ? 'started' : type === 'engine_install_finished' ? 'finished' : 'failed'
      ctx.audit?.(type, `Engine ${preview.kind} ${verb}: ${(metadata.families as string[]).join(', ')}`, metadata)
    } catch (err) {
      log.warn('Engine job audit failed', { jobId: job.jobId, type, error: String(err) })
    }
  }
  engine.onSettled((job, end) => {
    auditEngine(job.status === 'done' ? 'engine_install_finished' : 'engine_install_failed', job, end.preview, end)
  })

  // #516: a failed or cancelled update (or one the install hook did not resume) brings back the
  // model its pause stopped. The helpers need nothing: they restart on their next use.
  engine.onSettled((job) => {
    const update = pendingUpdate
    if (!update || update.jobId !== job.jobId) return
    pendingUpdate = null
    if (!update.paused || update.resumed) return
    void resumeChatModel(ctx, update.modelId).catch((err: unknown) => {
      log.warn('Restarting the model after the engine update failed', { error: String(err) })
    })
  })

  // #782: switching internet access off stops the running engine and OCR installs (settings:update
  // calls this). Each manager runs one job at a time; both can run at once.
  ctx.installsNetworkSwitched = (on, onStopped) => {
    engine.networkSwitched(on, onStopped)
    ocrInstaller.networkSwitched(on, onStopped)
  }

  // #842: every engine call below (the status, the install and repair, the update) reads the pins
  // from `ctx.bundledManifestsDir`, the app's own `runtime-sources.yaml`, never `ctx.manifestsDir`,
  // which a launcher start points at the drive's copy. A new app on a drive whose manifests were not
  // refreshed then compared the engine with the drive's old pin, found it current, and never offered
  // its update. One source for all of them, so the notice never offers what the update would refuse.
  const gates = (): DownloadGates => {
    const { policy } = loadPolicy(ctx.paths.configPath, (m) => log.warn(m), { isDev: ctx.isDev })
    const settingAllows = ctx.workspace.isUnlocked() && getSettings(ctx.db).allowNetwork
    return { policyAllows: policy.network.allowModelDownloads, settingAllows }
  }

  /**
   * #516 "Update the AI engine": download and verify the pinned build(s) while everything keeps
   * running, then — in the manager's `beforeReplace`, after the last archive verified — refuse if
   * work started meanwhile, pause what runs from the folders being replaced, check that nothing
   * still does, and let the swap happen. Whatever happens next, the model comes back (the install
   * hook on success, the settle listener otherwise).
   */
  const startEngineUpdate = async (families: EngineFamily[]): Promise<EngineDownloadJob> => {
    if (engineUpdateBusy(ctx, families)) throw new Error(tMain('main.engine.updateBusy'))
    const update = { jobId: '', modelId: null as string | null, paused: false, resumed: false }
    const job = await engine.start({
      rootPath: ctx.paths.rootPath,
      manifestsDir: ctx.bundledManifestsDir,
      gates: gates(),
      families,
      update: true,
      beforeReplace: async () => {
        // What this job replaces (an update skips families that are already current).
        const replacing = (update.jobId && engine.get(update.jobId).families) || families
        if (!workspaceAdmitsWork(ctx.workspace)) throw new Error(tMain('main.settings.locked'))
        if (engineUpdateBusy(ctx, replacing)) throw new Error(tMain('main.engine.updateBusy'))
        if (replacing.includes('llama_cpp')) {
          // A start in flight was refused just above; `startingModelId` is the belt to that brace.
          const status = ctx.runtime.status()
          update.modelId = status.running ? status.modelId : (status.startingModelId ?? null)
        }
        update.paused = true
        await pauseEngineUsers(ctx, replacing)
        const stillInUse =
          (replacing.includes('llama_cpp') && (chatEngineInUse(ctx.runtime) || llamaSidecarInUse())) ||
          (replacing.includes('whisper_cpp') && whisperSidecarInUse())
        if (stillInUse) throw new Error(tMain('main.engine.updateBusy'))
      }
    })
    update.jobId = job.jobId
    pendingUpdate = update
    return job
  }

  // #530 "Check again": no payload; drive-local spawns only. Admission-gated like every
  // engine action — a re-check that re-arms sidecars must not run under a lock teardown.
  ipcHandle(IPC.recheckEngine, async (): Promise<EngineRecheckResult> => {
    if (!workspaceAdmitsWork(ctx.workspace)) throw new Error(tMain('main.settings.locked'))
    return recheckEngines(ctx)
  })

  ipcHandle(
    IPC.getEngineStatus,
    (): EngineStatus => engineStatus(ctx.paths.rootPath, ctx.bundledManifestsDir)
  )

  /**
   * The request the renderer sent, validated — the same for `engine:plan` and `engine:download`, so
   * the preview a dialog shows and the job its Confirm starts are selected from one request. #532:
   * "Install … again" re-fetches an engine that is on the drive and current by its marker — admitted
   * only for a family whose files the OS loader found damaged this session.
   */
  const admittedRequest = (raw: unknown): ReturnType<typeof parseEngineDownloadRequest> => {
    const request = parseEngineDownloadRequest(raw)
    if (request.reinstall && !(request.families ?? []).every(repairable)) {
      throw new Error(tMain('main.engine.nothingToRepair'))
    }
    return request
  }

  // #843: what a request would fetch, for its confirmation dialog — the step selection `start()`
  // runs (`planEngineSteps`), with the same pins and, for a reinstall, the same refused builds. The
  // payload is the one Confirm then sends to `engine:download` unchanged: main keeps no consent
  // token, it checks the gates on every start. Read-only: no network, no write.
  ipcHandle(IPC.getEnginePlan, (_e, raw?: unknown): EngineDownloadPreview => {
    const request = admittedRequest(raw)
    return previewEngineDownload({
      rootPath: ctx.paths.rootPath,
      manifestsDir: ctx.bundledManifestsDir,
      ...request,
      ...(request.reinstall ? { reinstallBuilds: refusedBuilds(request.families ?? []) } : {})
    })
  })

  const startEngineJob = (request: ReturnType<typeof parseEngineDownloadRequest>): Promise<EngineDownloadJob> => {
    // #516: an update downloads first and pauses the engine's users only for the swap.
    if (request.update) return startEngineUpdate(request.families ?? [])
    return engine.start({
      rootPath: ctx.paths.rootPath,
      manifestsDir: ctx.bundledManifestsDir,
      gates: gates(),
      ...request,
      // #678: what the reinstall replaces — the builds the OS refused, the `cpu/` net included.
      ...(request.reinstall ? { reinstallBuilds: refusedBuilds(request.families ?? []) } : {}),
      // CODE-13 (full-audit 2026-07-11): a llama_cpp (re-)install replaces the dir the
      // LIVE chat sidecar executes from — the manager refuses a job that would touch it
      // while a model runtime is up OR still starting (friendly copy; stop the model first).
      // The demo runtime is not "up" here (#532): it never executes that dir.
      chatRuntimeActive: chatEngineInUse(ctx.runtime),
      // F-32 (full-audit 2026-07-16): widen the guard per family — refuse a llama_cpp install
      // while ANY llama-server sidecar (embedder/reranker/vision/translation) has a live child,
      // and a whisper_cpp install mid-transcription/dictation. Installs touching only the other
      // family still proceed, and so does a repair of the `cpu/` net alone (#678: no sidecar runs it).
      llamaSidecarActive: llamaSidecarInUse(),
      whisperActive: whisperSidecarInUse(),
      // #339 P8-1 R-e / P8-2: a kiwix_tools (re-)install replaces the dir a live
      // kiwix-serve / kiwix-manage child executes from — refused while one is registered.
      kiwixToolsActive: kiwixToolsInUse()
    })
  }

  ipcHandle(IPC.downloadEngine, async (_e, raw?: unknown): Promise<EngineDownloadJob> => {
    // #339 P8-2: the OPTIONAL argument. Absent = the default install (required families
    // only — the manager never reaches an optional family without it). The consent dialog
    // sends `{ families: ['kiwix_tools'] }` after the licence acknowledgement; the payload
    // is renderer input and is validated against the code's own family names.
    const request = admittedRequest(raw)
    const job = await startEngineJob(request)
    auditEngine('engine_install_started', job, engine.jobPreview(job.jobId))
    return job
  })

  ipcHandle(IPC.getEngineJob, (_e, jobId: string): EngineDownloadJob => engine.get(jobId))

  ipcHandle(
    IPC.cancelEngineDownload,
    (_e, jobId: string): EngineDownloadJob => engine.cancel(jobId)
  )

  // ---- In-app OCR language-file install (#410) ----
  // OCR is not an engine family: its own installer (`services/ocr-install.ts`) fetches the
  // code-pinned language files into `ocr/`, then `refreshOcrSlot` activates the engine without a
  // restart. Same gates as the engine (re-checked on every start); pre-unlock like the rest of
  // this registrar (the setting reads as off while locked, so a locked install is refused).
  const ocrSources = () => ({
    rootPath: ctx.paths.rootPath,
    manifestsDir: ctx.manifestsDir ?? null,
    bundledManifestsDir: ctx.bundledManifestsDir
  })

  ipcHandle(IPC.getOcrInstallStatus, (): Promise<OcrInstallStatus> => ocrInstaller.status(ocrSources()))

  ipcHandle(IPC.installOcr, (_e, ...args: unknown[]): Promise<OcrInstallJob> => {
    // The install takes NO payload — what is installed is pinned in code, never renderer input.
    assertNoOcrInstallPayload(args)
    return ocrInstaller.start({
      ...ocrSources(),
      gates: gates(),
      activate: () => refreshOcrSlot(ctx),
      // #843: the job's start and end reach the activity log (language codes and counts only), with
      // the trigger the engine rows carry: the rows are permanent, and an app update records its own.
      audit: (type, message, metadata) => ctx.audit?.(type, message, { ...metadata, trigger: AUDIT_TRIGGER })
    })
  })

  ipcHandle(IPC.getOcrInstallJob, (_e, jobId: unknown): OcrInstallJob =>
    ocrInstaller.get(typeof jobId === 'string' ? jobId : '')
  )

  ipcHandle(IPC.cancelOcrInstall, (_e, jobId: unknown): OcrInstallJob =>
    ocrInstaller.cancel(typeof jobId === 'string' ? jobId : '')
  )
}
