import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC, STREAM } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type {
  ImageAnalyzeRequest,
  ImageJob,
  ImageSessionDetail,
  ImageSessionSummary,
  VisionStatus
} from '../../shared/types'
import {
  createVisionRuntimeFromContext,
  getVisionStatus,
  VisionService,
  type VisionStreamEmitter
} from '../services/vision'
import {
  addImageTurn,
  createImageSession,
  deleteImageSession,
  getImageSession,
  imagesDir,
  listImageSessions
} from '../services/vision/history'
import { imageExtensionOf, isSupportedImagePath, VISION_MAX_IMAGE_BYTES } from '../services/vision/limits'
import { tMain } from '../services/i18n'
import { log } from '../services/logging'

// Image-understanding IPC (image-understanding plan §9/§10). A separate lazy vision sidecar
// answers a question about ONE image. Privacy posture (§12/§13):
//   • getStatus is WORKSPACE-AGNOSTIC (no requireUnlocked); the file/runtime handlers require
//     an unlocked workspace.
//   • The image bytes are base64-inlined into the loopback sidecar request — never on disk.
//   • NO image/prompt/answer content is logged or audited; errors to the renderer are codes.
//   • chooseImage returns {path,name,sizeBytes} (a NEW richer shape — IPC-2); readBytes +
//     analyze re-validate the extension + byte cap in MAIN (the authoritative guard — SEC-3).

/** Friendly refusal for an unsupported picked file (the renderer pre-filters; this is a backstop). */
export const IMAGE_UNSUPPORTED_MESSAGE =
  'That file type isn’t supported. Choose a PNG or JPEG.'
/** Friendly refusal for an over-cap image. */
export const IMAGE_TOO_LARGE_MESSAGE = 'That image is too large to analyze. Try a smaller image.'

export function registerImagesIpc(ctx: AppContext, service?: VisionService): void {
  const vision =
    service ??
    new VisionService({
      getStatus: () => getVisionStatus(ctx),
      createRuntime: (status) => createVisionRuntimeFromContext(ctx, status)
    })

  // File/runtime handlers require an unlocked workspace; surface a clean message instead of
  // the raw "Workspace is locked" the `ctx.db` getter would throw mid-operation.
  const requireUnlocked = (): void => {
    if (!ctx.workspace.isUnlocked()) throw new Error(tMain('main.docs.locked'))
  }

  // Build a per-renderer streaming emitter, isDestroyed-guarded (the chat-stream precedent).
  const emitterFor = (event: { sender: { send: (ch: string, p: unknown) => void; isDestroyed: () => boolean } }): VisionStreamEmitter => {
    const guard = (ch: string, payload: unknown): void => {
      if (!event.sender.isDestroyed()) event.sender.send(ch, payload)
    }
    return {
      token: (jobId, delta) => guard(STREAM.imgToken(jobId), delta),
      done: (jobId, job) => guard(STREAM.imgDone(jobId), job),
      error: (jobId, job) => guard(STREAM.imgError(jobId), job)
    }
  }

  ipcMain.handle(IPC.imageGetStatus, (): Promise<VisionStatus> => getVisionStatus(ctx))

  ipcMain.handle(
    IPC.imageChooseImage,
    async (): Promise<{ path: string; name: string; sizeBytes: number } | null> => {
      const win = BrowserWindow.getFocusedWindow()
      const options = {
        title: tMain('main.dialog.chooseImage'),
        properties: ['openFile'] as Array<'openFile'>,
        filters: [
          { name: tMain('main.dialog.filterImages'), extensions: ['png', 'jpg', 'jpeg'] },
          { name: tMain('main.dialog.filterAll'), extensions: ['*'] }
        ]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      const filePath = result.canceled ? undefined : result.filePaths[0]
      if (!filePath) return null
      // A new richer return shape (IPC-2): name via basename, sizeBytes via a stat in main.
      let sizeBytes = 0
      try {
        sizeBytes = statSync(filePath).size
      } catch {
        return null
      }
      return { path: filePath, name: basename(filePath), sizeBytes }
    }
  )

  // PICKER path only (IPC-1): drag-drop reads the File's bytes in the renderer and never calls
  // this. Re-validate the extension + byte cap in MAIN (SEC-3) before reading.
  ipcMain.handle(IPC.imageReadBytes, (_e, path: unknown): Uint8Array => {
    requireUnlocked()
    if (typeof path !== 'string' || !isSupportedImagePath(path)) {
      throw new Error(IMAGE_UNSUPPORTED_MESSAGE)
    }
    let size: number
    try {
      size = statSync(path).size
    } catch (err) {
      // SEC-1 / §12: keep vision logs to a content-free minimum — the file EXTENSION and the
      // errno code only. `String(err)` of an fs error embeds the full path; never log that.
      const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined
      log.warn('Vision readBytes stat failed', { ext: imageExtensionOf(path), code })
      throw new Error(IMAGE_UNSUPPORTED_MESSAGE)
    }
    if (size > VISION_MAX_IMAGE_BYTES) throw new Error(IMAGE_TOO_LARGE_MESSAGE)
    return readFileSync(path)
  })

  // Content-free error code for the (rare) history-persistence failure path — NEVER the
  // image/prompt/answer (§12). A persistence failure must not break the live analysis.
  const errCode = (err: unknown): string | undefined =>
    err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? err.name) : undefined

  ipcMain.handle(IPC.imageAnalyze, (event, req: ImageAnalyzeRequest): ImageJob => {
    requireUnlocked()

    // History persistence (image-understanding history): a NEW image (no sessionId) stores the
    // image encrypted-at-rest and creates a session; a follow-up reuses it. The session is
    // created lazily and at most once; a busy/failed reject persists nothing. Persistence is
    // best-effort — any failure is logged content-free and the live analysis still runs.
    let sessionId: string | null = typeof req.sessionId === 'string' ? req.sessionId : null
    const ensureSession = (): string | null => {
      if (sessionId) return sessionId
      try {
        sessionId = createImageSession(
          ctx.db,
          imagesDir(ctx.paths.workspacePath),
          req,
          ctx.workspace.documentCipher()
        )
      } catch (err) {
        log.warn('Vision history create failed', { code: errCode(err) })
        sessionId = null
      }
      return sessionId
    }

    const base = emitterFor(event)
    const emitter: VisionStreamEmitter = {
      token: base.token,
      done: (jobId, job) => {
        const answer = job.answer
        if (answer && answer.trim()) {
          const sid = ensureSession()
          if (sid) {
            try {
              addImageTurn(ctx.db, sid, req.question, answer)
            } catch (err) {
              log.warn('Vision history append failed', { code: errCode(err) })
            }
          }
        }
        base.done(jobId, { ...job, sessionId })
      },
      error: (jobId, job) => base.error(jobId, { ...job, sessionId })
    }

    // The service validates (extension/MIME, cap, question), enforces one-at-a-time +
    // busy-reject, and returns the initial job immediately; tokens stream via the emitter.
    // The session is created lazily on the FIRST completed answer (see the `done` wrapper), so
    // a busy/failed/cancelled/empty job persists nothing — no turnless sessions. The renderer
    // captures the id from the `done` event for any follow-up turn.
    const job = vision.analyze(req, emitter)
    return { ...job, sessionId }
  })

  // Gated on unlock (MEDIUM vuln-scan-2026-06-21), consistent with imageAnalyze and the history
  // handlers: a job (and its answer) is workspace-scoped, so it must not be reachable once the
  // vault is locked. (stop() also clears the job map at lock, so there is nothing to return.)
  ipcMain.handle(IPC.imageGetJob, (_e, jobId: unknown): ImageJob => {
    requireUnlocked()
    return vision.getJob(typeof jobId === 'string' ? jobId : '')
  })

  ipcMain.handle(IPC.imageCancel, (_e, jobId: unknown): ImageJob => {
    requireUnlocked()
    return vision.cancel(typeof jobId === 'string' ? jobId : '')
  })

  // --- Image-analysis history (local-only, encrypted at rest, user-deletable) ---
  ipcMain.handle(IPC.imageListSessions, (): ImageSessionSummary[] => {
    requireUnlocked()
    return listImageSessions(ctx.db)
  })

  ipcMain.handle(IPC.imageGetSession, (_e, id: unknown): ImageSessionDetail | null => {
    requireUnlocked()
    if (typeof id !== 'string') return null
    return getImageSession(
      ctx.db,
      imagesDir(ctx.paths.workspacePath),
      id,
      ctx.workspace.documentCipher()
    )
  })

  ipcMain.handle(IPC.imageDeleteSession, (_e, id: unknown): void => {
    requireUnlocked()
    if (typeof id === 'string') deleteImageSession(ctx.db, imagesDir(ctx.paths.workspacePath), id)
  })
}
