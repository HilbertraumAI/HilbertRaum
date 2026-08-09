import { statSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
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
  imageSessionExists,
  imagesDir,
  listImageSessions
} from '../services/vision/history'
import { imageExtensionOf, isSupportedImagePath, VISION_MAX_IMAGE_BYTES } from '../services/vision/limits'
import { tMain } from '../services/i18n'
import { workspaceAdmitsWork } from '../services/workspace-vault'
import { log } from '../services/logging'

// Image-understanding IPC (image-understanding plan §9/§10). A separate lazy vision sidecar
// answers a question about ONE image. Privacy posture (§12/§13):
//   • getStatus is WORKSPACE-AGNOSTIC (no requireUnlocked); the file/runtime handlers require
//     an unlocked workspace.
//   • The image bytes are base64-inlined into the loopback sidecar request — never on disk.
//   • NO image/prompt/answer content is logged or audited; errors to the renderer are codes.
//   • chooseImage returns {token,name,sizeBytes} (IPC-2); the renderer NEVER sees the absolute
//     path. readBytes accepts only that opaque main-held token and resolves it to the path the
//     OS picker already vetted (D2, vuln-scan-2026-06-21) — closing the confused-deputy gap
//     where a code-exec'd renderer (threat #1) could read ANY supported-extension file by
//     handing back an arbitrary path. The byte cap is re-checked on the open fd (no TOCTOU).

// #120 item 4: the refusal strings are LOCALIZED at throw time (tMain — the sibling
// `main.docs.locked` precedent), no longer hard-coded English constants. They are near-dead
// text (the renderer swallows the thrown message and shows its own coded copy) but a caller
// that surfaces raw IPC errors now sees the user's language.
/** Friendly refusal for an unsupported picked file (the renderer pre-filters; this is a backstop). */
const imageUnsupportedMessage = (): string => tMain('main.images.unsupportedType')
/** Friendly refusal for an over-cap image. */
const imageTooLargeMessage = (): string => tMain('main.images.tooLarge')

// #120 item 2: persistence-field clamps. The title is a filename (basename-sized — 255 is the
// common filesystem component limit); dimensions are decoded pixel sizes, so anything beyond
// ~1e6 px per side (≫ the 50 MP D4 budget allows) is junk.
const MAX_IMAGE_TITLE_CHARS = 255
const MAX_IMAGE_DIM = 1_000_000
/** Coerce a renderer-supplied dimension to a finite positive integer, or null. */
const clampImageDim = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= MAX_IMAGE_DIM ? Math.floor(v) : null

export function registerImagesIpc(ctx: AppContext, service?: VisionService): void {
  // WARNING (#119): this `??` fallback constructs a VisionService WITHOUT the
  // `isWorkspaceLocking` latch (AUD-02). Production always wires the LATCHED instance via
  // `ctx.vision` (main/index.ts), so the fallback is TEST-ONLY today — do not "simplify" the
  // call site to rely on it, or an analyze landing during the multi-second lock teardown could
  // rebuild a fresh vision sidecar that outlives the vault re-encrypt.
  const vision =
    service ??
    new VisionService({
      getStatus: () => getVisionStatus(ctx),
      createRuntime: (status) => createVisionRuntimeFromContext(ctx, status)
    })

  // File/runtime handlers require an unlocked workspace; surface a clean message instead of
  // the raw "Workspace is locked" the `ctx.db` getter would throw mid-operation.
  const requireUnlocked = (): void => {
    // AUD-02: `workspaceAdmitsWork`, never a bare `isUnlocked()` — the workspace DB stays
    // OPEN for the whole multi-second lock teardown, so a bare check admits work that then
    // lazily respawns the sidecars that teardown just killed. This module's copy is unchanged.
    if (!workspaceAdmitsWork(ctx.workspace)) throw new Error(tMain('main.docs.locked'))
  }

  // D2 (vuln-scan-2026-06-21): a one-time capability map for the picker path. chooseImage
  // records the OS-vetted absolute path under an unguessable token and hands ONLY the token to
  // the renderer; readBytes resolves+consumes it. The renderer can never name a path, so a
  // code-exec'd renderer cannot turn main into a confused deputy that reads an arbitrary file.
  // Bounded (a stray choose-without-read can't grow it without bound) and single-use.
  const PICKED_IMAGE_TOKEN_CAP = 8
  const pickedImageTokens = new Map<string, string>()
  const mintImageToken = (path: string): string => {
    const token = randomUUID()
    pickedImageTokens.set(token, path)
    while (pickedImageTokens.size > PICKED_IMAGE_TOKEN_CAP) {
      const oldest = pickedImageTokens.keys().next().value
      if (oldest === undefined) break
      pickedImageTokens.delete(oldest)
    }
    return token
  }
  const consumeImageToken = (token: unknown): string | null => {
    if (typeof token !== 'string' || token === '') return null
    const path = pickedImageTokens.get(token)
    if (path === undefined) return null
    pickedImageTokens.delete(token)
    return path
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
    async (): Promise<{ token: string; name: string; sizeBytes: number } | null> => {
      // #119: chooseImage is a FILE handler and follows the module's documented invariant
      // (file/runtime handlers requireUnlocked) like its siblings. Nothing legitimate calls it
      // locked (the Images screen never mounts then); ungated it would pop the OS dialog and
      // bank D2 tokens for a compromised renderer to redeem the moment the workspace unlocks.
      requireUnlocked()
      const win = BrowserWindow.getFocusedWindow()
      const options = {
        title: tMain('main.dialog.chooseImage'),
        properties: ['openFile'] as Array<'openFile'>,
        filters: [
          // #124: WEBP joins the intake filter (normalized to PNG renderer-side).
          { name: tMain('main.dialog.filterImages'), extensions: ['png', 'jpg', 'jpeg', 'webp'] },
          { name: tMain('main.dialog.filterAll'), extensions: ['*'] }
        ]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      const filePath = result.canceled ? undefined : result.filePaths[0]
      if (!filePath) return null
      // IPC-2 / D2: name via basename, sizeBytes via a stat in main, and a one-time token that
      // readBytes resolves back to this exact (main-vetted) path. The absolute path stays in
      // main — the renderer only ever holds the token.
      let sizeBytes = 0
      try {
        sizeBytes = statSync(filePath).size
      } catch {
        return null
      }
      return { token: mintImageToken(filePath), name: basename(filePath), sizeBytes }
    }
  )

  // PICKER path only (IPC-1): drag-drop reads the File's bytes in the renderer and never calls
  // this. D2 (vuln-scan-2026-06-21): the renderer hands back the opaque token from chooseImage,
  // NOT a path — so it cannot make main read an arbitrary file (confused deputy, threat #1).
  // We still re-validate extension + byte cap in MAIN (SEC-3), now on the OPEN fd so the cap
  // can't be bypassed by growing the file between stat and read (TOCTOU).
  ipcMain.handle(IPC.imageReadBytes, async (_e, token: unknown): Promise<Uint8Array> => {
    requireUnlocked()
    const path = consumeImageToken(token)
    if (path === null || !isSupportedImagePath(path)) {
      throw new Error(imageUnsupportedMessage())
    }
    let fh: FileHandle
    try {
      fh = await open(path, 'r')
    } catch (err) {
      // SEC-1 / §12: keep vision logs to a content-free minimum — the file EXTENSION and the
      // errno code only. `String(err)` of an fs error embeds the full path; never log that.
      const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined
      log.warn('Vision readBytes open failed', { ext: imageExtensionOf(path), code })
      throw new Error(imageUnsupportedMessage())
    }
    try {
      // PERF-1: read off the main thread with fs/promises (mirrors the ING-8 async conversion in
      // doctasks/manager.ts) so a slow drive can't block the event loop on an up-to-~20 MiB read.
      // The SEC-3/TOCTOU invariant is unchanged — we fstat THIS handle then read THE SAME handle, so
      // the size guard is authoritative for these exact bytes; a concurrent truncation yields fewer.
      const st = await fh.stat()
      if (!st.isFile()) throw new Error(imageUnsupportedMessage())
      if (st.size > VISION_MAX_IMAGE_BYTES) throw new Error(imageTooLargeMessage())
      const buf = Buffer.allocUnsafe(st.size)
      let off = 0
      while (off < st.size) {
        const { bytesRead } = await fh.read(buf, off, st.size - off, off)
        if (bytesRead === 0) break
        off += bytesRead
      }
      return off === st.size ? buf : buf.subarray(0, off)
    } finally {
      await fh.close()
    }
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
    //
    // #120 item 2: the persistence fields are renderer input (threat #1) and were the module's
    // one unclamped surface — clamp them here at the IPC boundary. The title is length-capped,
    // width/height coerced to finite positive ints or null, and a sessionId that names no
    // existing row is treated as absent (a fresh session) instead of trusted for the append.
    const name =
      typeof req.name === 'string' ? req.name.trim().slice(0, MAX_IMAGE_TITLE_CHARS) : undefined
    const width = clampImageDim(req.width)
    const height = clampImageDim(req.height)
    let sessionId: string | null =
      typeof req.sessionId === 'string' && imageSessionExists(ctx.db, req.sessionId)
        ? req.sessionId
        : null
    // ASYNC (audit 2026-07-16 F-12): createImageSession now runs the ~20 MiB write+encrypt+shred off the
    // main thread. The `done` wrapper AWAITS this before `base.done` so the sessionId still rides the
    // done event (the renderer's follow-up contract, pinned by images-ipc.test.ts). Best-effort — a
    // persistence failure is logged content-free and the live answer still surfaces.
    const ensureSession = async (): Promise<string | null> => {
      if (sessionId) return sessionId
      try {
        sessionId = await createImageSession(
          ctx.db,
          imagesDir(ctx.paths.workspacePath),
          // The CLAMPED persistence fields (#120 item 2) — never the raw renderer values.
          {
            imageBytes: req.imageBytes,
            mimeType: req.mimeType,
            name,
            width: width ?? undefined,
            height: height ?? undefined
          },
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
      // Async-tolerant: the service fires `emit.done` without awaiting; we await persistence so the
      // done EVENT is sent only once the session/turn are stored and sessionId is known.
      done: async (jobId, job) => {
        const answer = job.answer
        if (answer && answer.trim()) {
          const sid = await ensureSession()
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

  ipcMain.handle(IPC.imageGetSession, (_e, id: unknown): Promise<ImageSessionDetail | null> => {
    requireUnlocked()
    if (typeof id !== 'string') return Promise.resolve(null)
    // ASYNC (audit 2026-07-16 F-12): decrypt+read off the main thread.
    return getImageSession(
      ctx.db,
      imagesDir(ctx.paths.workspacePath),
      id,
      ctx.workspace.documentCipher()
    )
  })

  ipcMain.handle(IPC.imageDeleteSession, async (_e, id: unknown): Promise<void> => {
    requireUnlocked()
    // ASYNC (audit 2026-07-16 F-12): the post-commit shred runs off the main thread.
    if (typeof id === 'string') await deleteImageSession(ctx.db, imagesDir(ctx.paths.workspacePath), id)
  })
}
