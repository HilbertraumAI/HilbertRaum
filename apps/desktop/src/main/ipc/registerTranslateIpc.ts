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

  // FA-1 F-4: the `destroyed` listener wired at start is detached on the job's terminal state so a
  // long-lived window running many translations does not pile up one listener per call (Node's
  // MaxListenersExceededWarning at 11). `emit.done`/`emit.error` detach inline, but a CANCELLED job
  // emits neither — so the detach for each queued job is also registered here by jobId and invoked
  // from the two cancel terminals (the translateCancel handler and the destroyed-cancel path).
  const detachers = new Map<string, () => void>()

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
    // L3: the stream events (trToken/trDone/trError) are bound to THIS sender for the job's life.
    // The app is multi-window: if the starting window is destroyed, those events would drop
    // silently while the job keeps decoding up to the 45-min per-request timeout, holding the
    // one-at-a-time busy lane (and another window adopting via getActive would see a frozen
    // snapshot). Bind the job's lifetime to the sender: cancel it when the window is destroyed —
    // parity with the lock/quit purge. (A full emitter-REBIND onto another window via getActive is
    // deliberately deferred — see the TA-wave deferred backlog.) The 'destroyed' listener is
    // detached on terminal state so a long-lived window running many translations does not pile up
    // one listener per call (Node's MaxListenersExceededWarning).
    const base = emitterFor(event)
    let onDestroyed: (() => void) | null = null
    let boundJobId: string | null = null
    const detach = (): void => {
      if (onDestroyed) {
        event.sender.removeListener('destroyed', onDestroyed)
        onDestroyed = null
      }
      if (boundJobId) {
        detachers.delete(boundJobId)
        boundJobId = null
      }
    }
    const emit: TranslateStreamEmitter = {
      token: base.token,
      done: (jobId, job) => {
        detach()
        base.done(jobId, job)
      },
      error: (jobId, job) => {
        detach()
        base.error(jobId, job)
      }
    }
    // The service validates (model present, curated langs, source ≠ target, non-empty), enforces
    // the one-at-a-time lane + doc-task/busy reject, and returns the initial job immediately;
    // tokens stream via the emitter, terminal state via trDone/trError.
    const job = jobs.start(req, emit)
    if (job.state === 'queued') {
      const { jobId } = job
      boundJobId = jobId
      // Detach on the destroyed-cancel terminal too (F-4): the aborted run emits neither done nor
      // error, so without this the listener + map entry would leak on a window-destroy cancel.
      onDestroyed = () => {
        jobs.cancel(jobId)
        detach()
      }
      event.sender.once('destroyed', onDestroyed)
      detachers.set(jobId, detach)
    }
    return job
  })

  ipcMain.handle(IPC.translateCancel, (_e, jobId: unknown): TranslateJob => {
    const id = typeof jobId === 'string' ? jobId : ''
    const result = jobs.cancel(id)
    // The cancel terminal emits nothing, so detach the destroyed listener here (F-4).
    detachers.get(id)?.()
    return result
  })

  // Remount recovery (the chat `getActiveStream` precedent): a Translate screen that mounts fresh
  // after a full renderer reload has lost its module store — this returns the still-running job
  // (accumulated text + window progress) so it can re-adopt and re-subscribe. Null when idle.
  ipcMain.handle(IPC.translateGetActive, (): TranslateJob | null => jobs.getActiveJob())
}
