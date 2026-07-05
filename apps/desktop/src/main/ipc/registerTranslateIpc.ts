import { ipcMain } from 'electron'
import { IPC, STREAM } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { TranslateJob, TranslateRequest } from '../../shared/types'
import { TranslateJobService, type TranslateStreamEmitter } from '../services/translation/jobs'
import { tMain } from '../services/i18n'

// Translate-view IPC (TG wave, plan §2 D6). The Translate screen's live TEXT translation runs on
// the SAME TranslateGemma sidecar (`ctx.translator`) the document-translation doc-task uses — a
// per-job streaming job (STREAM.tr* channels), keyed by jobId, mirroring the vision image-job IPC.
// Privacy posture (security-model.md): the source text + its translation are TRANSIENT (held only
// in the job service's per-process map, dropped on lock/quit); NOTHING content-bearing is logged
// or audited — the audit sweep stays green because these handlers never call ctx.audit and the
// service logs ids/kinds only.

export function registerTranslateIpc(ctx: AppContext, service?: TranslateJobService): void {
  const jobs =
    service ??
    new TranslateJobService({
      getTranslator: () => ctx.translator ?? null,
      // D9: the view job yields the one-at-a-time lane to document tasks (RAM co-residency).
      hasActiveDocTask: () => ctx.docTasks?.hasActiveTask() ?? false
    })

  // A running translation lazily (re)starts the ~10 GB sidecar via translator.translate(); a
  // locked workspace must never trigger that (the vault is re-encrypting) — refuse with the
  // localized "locked" copy rather than let a start slip through. cancel/getActive are safe
  // reads either way. Mirrors registerImagesIpc's requireUnlocked on analyze.
  const requireUnlocked = (): void => {
    if (!ctx.workspace.isUnlocked()) throw new Error(tMain('main.docs.locked'))
  }

  // Per-renderer streaming emitter, isDestroyed-guarded (the chat-stream / vision precedent).
  const emitterFor = (event: {
    sender: { send: (ch: string, p: unknown) => void; isDestroyed: () => boolean }
  }): TranslateStreamEmitter => {
    const guard = (ch: string, payload: unknown): void => {
      if (!event.sender.isDestroyed()) event.sender.send(ch, payload)
    }
    return {
      token: (jobId, delta) => guard(STREAM.trToken(jobId), delta),
      done: (jobId, job) => guard(STREAM.trDone(jobId), job),
      error: (jobId, job) => guard(STREAM.trError(jobId), job)
    }
  }

  ipcMain.handle(IPC.translateStart, (event, req: TranslateRequest): TranslateJob => {
    requireUnlocked()
    // The service validates (model present, curated langs, source ≠ target, non-empty), enforces
    // the one-at-a-time lane + doc-task/busy reject, and returns the initial job immediately;
    // tokens stream via the emitter, terminal state via trDone/trError.
    return jobs.start(req, emitterFor(event))
  })

  ipcMain.handle(IPC.translateCancel, (_e, jobId: unknown): TranslateJob =>
    jobs.cancel(typeof jobId === 'string' ? jobId : '')
  )

  // Remount recovery (the chat `getActiveStream` precedent): a Translate screen that mounts fresh
  // after a full renderer reload has lost its module store — this returns the still-running job
  // (accumulated text + window progress) so it can re-adopt and re-subscribe. Null when idle.
  ipcMain.handle(IPC.translateGetActive, (): TranslateJob | null => jobs.getActiveJob())
}
