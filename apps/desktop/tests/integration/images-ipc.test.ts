import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

// IPC-layer tests for registerImagesIpc (image-understanding plan §9/§17): the images:*
// handlers return the right DTOs, an unknown jobId is a terminal failed, a second analyze is
// busy-REJECTED (not queued), validation rejects bad input with a code, and readBytes
// re-validates the extension + byte cap in MAIN (SEC-3). No real binary/model is involved.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
const dialogState = vi.hoisted(() => ({ result: { canceled: true, filePaths: [] as string[] } }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => dialogState.result }
}))

import {
  IMAGE_TOO_LARGE_MESSAGE,
  IMAGE_UNSUPPORTED_MESSAGE,
  registerImagesIpc
} from '../../src/main/ipc/registerImagesIpc'
import { VisionService, type VisionAnalyzer } from '../../src/main/services/vision'
import { IPC, STREAM } from '../../src/shared/ipc'
import type {
  ImageAnalyzeRequest,
  ImageJob,
  ImageSessionDetail,
  ImageSessionSummary,
  VisionStatus
} from '../../src/shared/types'
import type { AppContext } from '../../src/main/services/context'
import { openDatabase, type Db } from '../../src/main/services/db'
import { encryptFile, decryptFile } from '../../src/main/services/workspace-vault'
import { invoke, invokeWithEvent, makeEvent, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

function ctxFor(rootPath: string, unlocked = true): AppContext {
  return {
    paths: { rootPath },
    manifestsDir: null,
    isDev: false,
    workspace: { isUnlocked: () => unlocked }
  } as unknown as AppContext
}

const AVAILABLE: VisionStatus = {
  available: true,
  modelId: 'vlm',
  modelDisplayName: 'Test VLM'
}

/** A controllable fake analyzer: streams one token, then resolves with `answer` when released. */
function gatedAnalyzer(answer = 'a local answer'): {
  analyzer: VisionAnalyzer
  release: () => void
  calls: number
} {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let calls = 0
  return {
    release,
    get calls() {
      return calls
    },
    analyzer: {
      async analyze(opts) {
        calls++
        opts.onToken?.('tok ')
        await gate
        return answer
      }
    }
  }
}

/** An ungated analyzer that streams one token and resolves immediately (no release needed). */
function immediateAnalyzer(answer = 'a local answer'): VisionAnalyzer {
  return {
    async analyze(opts) {
      opts.onToken?.('tok ')
      return answer
    }
  }
}

const goodReq = (): ImageAnalyzeRequest => ({
  imageBytes: new Uint8Array([1, 2, 3, 4]),
  mimeType: 'image/png',
  question: 'What is in this image?'
})

async function waitForTerminal(jobId: string): Promise<ImageJob> {
  for (let i = 0; i < 200; i++) {
    const { result } = await invoke(handlers, IPC.imageGetJob, jobId)
    const job = result as ImageJob
    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return job
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('analyze job never reached a terminal state')
}

beforeEach(() => {
  ipcState.handlers.clear()
  dialogState.result = { canceled: true, filePaths: [] }
})

describe('registerImagesIpc — analyze job contract', () => {
  it('analyze returns an initial queued job and streams to done with the answer', async () => {
    const { analyzer, release } = gatedAnalyzer('the answer')
    const service = new VisionService({ getStatus: async () => AVAILABLE, createRuntime: () => analyzer })
    registerImagesIpc(ctxFor(mkdtempSync(join(tmpdir(), 'hr-img-'))), service)

    const event = makeEvent()
    const initial = (await invokeWithEvent(handlers, IPC.imageAnalyze, event, goodReq())) as ImageJob
    expect(initial.state).toBe('queued')
    expect(typeof initial.jobId).toBe('string')

    release()
    const done = await waitForTerminal(initial.jobId)
    expect(done.state).toBe('done')
    expect(done.answer).toBe('the answer')
    // The streamed token reached the renderer on the per-job channel.
    expect(event.sender.send).toHaveBeenCalledWith(STREAM.imgToken(initial.jobId), 'tok ')
    expect(event.sender.send).toHaveBeenCalledWith(
      STREAM.imgDone(initial.jobId),
      expect.objectContaining({ state: 'done' })
    )
  })

  it('busy-REJECTS a second analyze while one is in flight (never queued)', async () => {
    const { analyzer, release } = gatedAnalyzer()
    const service = new VisionService({ getStatus: async () => AVAILABLE, createRuntime: () => analyzer })
    registerImagesIpc(ctxFor(mkdtempSync(join(tmpdir(), 'hr-img-'))), service)

    const first = (await invoke(handlers, IPC.imageAnalyze, goodReq())).result as ImageJob
    expect(first.state).toBe('queued')
    const second = (await invoke(handlers, IPC.imageAnalyze, goodReq())).result as ImageJob
    expect(second.state).toBe('failed')
    expect(second.error).toBe('busy')

    // After the first finishes the slot frees and a new analyze is accepted again.
    release()
    await waitForTerminal(first.jobId)
    const third = (await invoke(handlers, IPC.imageAnalyze, goodReq())).result as ImageJob
    expect(third.state).toBe('queued')
  })

  it('getJob on an unknown jobId is a terminal failed', async () => {
    const service = new VisionService({ getStatus: async () => AVAILABLE, createRuntime: () => gatedAnalyzer().analyzer })
    registerImagesIpc(ctxFor(mkdtempSync(join(tmpdir(), 'hr-img-'))), service)
    const job = (await invoke(handlers, IPC.imageGetJob, 'no-such-job')).result as ImageJob
    expect(job.state).toBe('failed')
    expect(job.jobId).toBe('no-such-job')
  })

  it('rejects an unsupported MIME with unsupportedType and never starts a job', async () => {
    const { analyzer } = gatedAnalyzer()
    const service = new VisionService({ getStatus: async () => AVAILABLE, createRuntime: () => analyzer })
    registerImagesIpc(ctxFor(mkdtempSync(join(tmpdir(), 'hr-img-'))), service)
    const bad = (await invoke(handlers, IPC.imageAnalyze, { ...goodReq(), mimeType: 'image/gif' }))
      .result as ImageJob
    expect(bad.state).toBe('failed')
    expect(bad.error).toBe('unsupportedType')
  })

  it('rejects an over-cap image with tooLarge', async () => {
    const service = new VisionService({
      getStatus: async () => AVAILABLE,
      createRuntime: () => gatedAnalyzer().analyzer,
      maxImageBytes: 8
    })
    registerImagesIpc(ctxFor(mkdtempSync(join(tmpdir(), 'hr-img-'))), service)
    const big = (await invoke(handlers, IPC.imageAnalyze, {
      ...goodReq(),
      imageBytes: new Uint8Array(16)
    })).result as ImageJob
    expect(big.state).toBe('failed')
    expect(big.error).toBe('tooLarge')
  })

  it('fails the job with runtimeFailed when vision is unavailable (no fabricated answer)', async () => {
    const service = new VisionService({
      getStatus: async () => ({ available: false, reason: 'no-model' }),
      createRuntime: () => {
        throw new Error('should not build a runtime when unavailable')
      }
    })
    registerImagesIpc(ctxFor(mkdtempSync(join(tmpdir(), 'hr-img-'))), service)
    const job = (await invoke(handlers, IPC.imageAnalyze, goodReq())).result as ImageJob
    const terminal = await waitForTerminal(job.jobId)
    expect(terminal.state).toBe('failed')
    expect(terminal.error).toBe('runtimeFailed')
  })

  it('cancel marks an in-flight job cancelled', async () => {
    const { analyzer } = gatedAnalyzer()
    const service = new VisionService({ getStatus: async () => AVAILABLE, createRuntime: () => analyzer })
    registerImagesIpc(ctxFor(mkdtempSync(join(tmpdir(), 'hr-img-'))), service)
    const job = (await invoke(handlers, IPC.imageAnalyze, goodReq())).result as ImageJob
    const cancelled = (await invoke(handlers, IPC.imageCancel, job.jobId)).result as ImageJob
    expect(cancelled.state).toBe('cancelled')
  })

  // V4 lock/quit teardown mechanism: service.stop() aborts any in-flight job AND tears the
  // runtime down so a fresh analyze cold-starts. Since vuln-scan-2026-06-21 it ALSO purges the
  // job map (no answer residue survives lock), so a job is no longer queryable after stop().
  // This is exactly what registerWorkspaceIpc (lock) + will-quit call.
  it('stop() aborts the in-flight job, tears down the runtime, and purges the job map (lock/quit path)', async () => {
    let runtimeStopped = false
    let sawSignal: AbortSignal | undefined
    const analyzer = {
      async analyze(opts: { signal?: AbortSignal }) {
        sawSignal = opts.signal
        await new Promise<void>((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          )
        })
        return 'never reached'
      },
      async stop() {
        runtimeStopped = true
      }
    }
    const service = new VisionService({ getStatus: async () => AVAILABLE, createRuntime: () => analyzer })
    registerImagesIpc(ctxFor(mkdtempSync(join(tmpdir(), 'hr-img-'))), service)

    const job = (await invoke(handlers, IPC.imageAnalyze, goodReq())).result as ImageJob
    expect(job.state).toBe('queued')
    while (!sawSignal) await new Promise((r) => setTimeout(r, 1)) // analyze is now in flight

    await service.stop()
    expect(runtimeStopped).toBe(true)
    expect(sawSignal?.aborted).toBe(true)
    // The in-flight analyze was aborted, and stop() purged the job map — so the job is no longer
    // queryable (unknown ⇒ failed) and no answer text lingers past the lock.
    const purged = (await invoke(handlers, IPC.imageGetJob, job.jobId)).result as ImageJob
    expect(purged.state).toBe('failed')
    expect(purged.answer).toBeUndefined()
  })
})

describe('registerImagesIpc — readBytes token + main-side re-validation (SEC-3 / D2)', () => {
  // Mint a one-time picker token for `file` via the chooseImage handler (the only producer).
  async function tokenFor(file: string): Promise<string> {
    dialogState.result = { canceled: false, filePaths: [file] }
    const chosen = (await invoke(handlers, IPC.imageChooseImage)).result as { token: string } | null
    if (!chosen) throw new Error('chooseImage returned null')
    return chosen.token
  }

  it('reads a supported picked image (by its token) and returns its bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hr-img-'))
    const file = join(dir, 'pic.png')
    writeFileSync(file, Buffer.from([9, 8, 7]))
    registerImagesIpc(ctxFor(dir))
    const token = await tokenFor(file)
    const { result } = await invoke(handlers, IPC.imageReadBytes, token)
    expect(Buffer.from(result as Uint8Array).equals(Buffer.from([9, 8, 7]))).toBe(true)
  })

  it('refuses an unsupported extension (even via a real token)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hr-img-'))
    const file = join(dir, 'note.txt')
    writeFileSync(file, 'hi')
    registerImagesIpc(ctxFor(dir))
    const token = await tokenFor(file)
    await expect(invoke(handlers, IPC.imageReadBytes, token)).rejects.toThrow(IMAGE_UNSUPPORTED_MESSAGE)
  })

  it('refuses an over-cap image (the cap is the default 20 MiB constant)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hr-img-'))
    const file = join(dir, 'big.jpg')
    // Just over the 20 MiB default `VISION_MAX_IMAGE_BYTES`.
    writeFileSync(file, Buffer.alloc(20 * 1024 * 1024 + 1))
    registerImagesIpc(ctxFor(dir))
    const token = await tokenFor(file)
    await expect(invoke(handlers, IPC.imageReadBytes, token)).rejects.toThrow(IMAGE_TOO_LARGE_MESSAGE)
  })

  it('refuses readBytes when the workspace is locked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hr-img-'))
    const file = join(dir, 'pic.jpg')
    writeFileSync(file, Buffer.from([1]))
    registerImagesIpc(ctxFor(dir, false))
    await expect(invoke(handlers, IPC.imageReadBytes, 'any-token')).rejects.toThrow()
  })

  // D2 regression: the confused-deputy gap is closed. A code-exec'd renderer handing back an
  // arbitrary ABSOLUTE PATH (not a main-minted token) reads NOTHING — even an existing,
  // supported-extension file is refused because it was never vetted through the picker.
  it('refuses an arbitrary (non-token) path — the confused-deputy gap is closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hr-img-'))
    const file = join(dir, 'real.png')
    writeFileSync(file, Buffer.from([1, 2, 3]))
    registerImagesIpc(ctxFor(dir))
    await expect(invoke(handlers, IPC.imageReadBytes, file)).rejects.toThrow(IMAGE_UNSUPPORTED_MESSAGE)
  })

  it('treats a token as single-use (a replay reads nothing)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hr-img-'))
    const file = join(dir, 'once.png')
    writeFileSync(file, Buffer.from([5, 6]))
    registerImagesIpc(ctxFor(dir))
    const token = await tokenFor(file)
    await invoke(handlers, IPC.imageReadBytes, token) // consumes it
    await expect(invoke(handlers, IPC.imageReadBytes, token)).rejects.toThrow(IMAGE_UNSUPPORTED_MESSAGE)
  })
})

describe('registerImagesIpc — chooseImage', () => {
  it('returns null when the picker is cancelled', async () => {
    registerImagesIpc(ctxFor(mkdtempSync(join(tmpdir(), 'hr-img-'))))
    const { result } = await invoke(handlers, IPC.imageChooseImage)
    expect(result).toBeNull()
  })

  it('returns {token,name,sizeBytes} for a chosen file (IPC-2 / D2 — token, not path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hr-img-'))
    const file = join(dir, 'chosen.png')
    writeFileSync(file, Buffer.from([1, 2, 3, 4, 5]))
    dialogState.result = { canceled: false, filePaths: [file] }
    registerImagesIpc(ctxFor(dir))
    const { result } = (await invoke(handlers, IPC.imageChooseImage)) as {
      result: { token: string; name: string; sizeBytes: number }
    }
    expect(result.name).toBe('chosen.png')
    expect(result.sizeBytes).toBe(5)
    expect(typeof result.token).toBe('string')
    expect(result.token.length).toBeGreaterThan(0)
    // The absolute path must NOT leak to the renderer.
    expect(result).not.toHaveProperty('path')
  })
})

// Image-analysis history (image-understanding history): analyze persists the image (encrypted)
// + the completed turn; a follow-up reuses the session; the list/get/delete handlers behave;
// a busy reject persists nothing; and everything requires an unlocked workspace.
describe('registerImagesIpc — history persistence', () => {
  const SENTINEL = new Uint8Array([0xab, 0xcd, 0xef, 0x10, 0x20, 0x30, 0x40, 0x50])

  function ctxWithDb(unlocked = true): { ctx: AppContext; db: Db; workspacePath: string; imagesPath: string } {
    const workspacePath = mkdtempSync(join(tmpdir(), 'hr-imghist-'))
    const db = openDatabase(join(workspacePath, 'hilbertraum.sqlite'))
    const key = randomBytes(32)
    const ctx = {
      paths: { rootPath: workspacePath, workspacePath },
      db,
      manifestsDir: null,
      isDev: false,
      workspace: {
        isUnlocked: () => unlocked,
        documentCipher: () => ({
          encryptFile: (s: string, d: string) => encryptFile(s, d, key),
          decryptFile: (s: string, d: string) => decryptFile(s, d, key)
        })
      }
    } as unknown as AppContext
    return { ctx, db, workspacePath, imagesPath: join(workspacePath, 'images') }
  }

  const histReq = (over: Partial<ImageAnalyzeRequest> = {}): ImageAnalyzeRequest => ({
    imageBytes: SENTINEL,
    mimeType: 'image/png',
    question: 'What is in this image?',
    name: 'pic.png',
    ...over
  })

  it('persists the image (encrypted) + a turn on done, and surfaces the sessionId', async () => {
    const { analyzer, release } = gatedAnalyzer('a local answer')
    const service = new VisionService({ getStatus: async () => AVAILABLE, createRuntime: () => analyzer })
    const { ctx, imagesPath } = ctxWithDb()
    registerImagesIpc(ctx, service)

    const event = makeEvent()
    const initial = (await invokeWithEvent(handlers, IPC.imageAnalyze, event, histReq())) as ImageJob
    release()
    const done = await waitForTerminal(initial.jobId)
    expect(done.state).toBe('done')

    // The streamed done EVENT carries the sessionId (the renderer's contract for follow-ups).
    const doneSend = event.sender.send.mock.calls.find(
      (c: unknown[]) => c[0] === STREAM.imgDone(initial.jobId)
    )
    expect(typeof (doneSend?.[1] as ImageJob | undefined)?.sessionId).toBe('string')

    // One session listed, with the turn recorded.
    const list = (await invoke(handlers, IPC.imageListSessions)).result as ImageSessionSummary[]
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('pic.png')
    expect(list[0].turnCount).toBe(1)
    expect(list[0].firstQuestion).toBe('What is in this image?')

    // Encrypted at rest: a .enc copy with no plaintext image bytes on disk.
    const stored = readdirSync(imagesPath)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatch(/\.enc$/)
    expect(readFileSync(join(imagesPath, stored[0])).includes(Buffer.from(SENTINEL))).toBe(false)

    // Open it back: decrypted bytes + the turn.
    const detail = (await invoke(handlers, IPC.imageGetSession, list[0].id)).result as ImageSessionDetail
    expect(Buffer.from(detail.imageBytes).equals(Buffer.from(SENTINEL))).toBe(true)
    expect(detail.turns).toHaveLength(1)
    expect(detail.turns[0].answer).toBe('a local answer')
  })

  it('a follow-up analyze with the sessionId APPENDS (one session, one stored image)', async () => {
    const service = new VisionService({ getStatus: async () => AVAILABLE, createRuntime: () => immediateAnalyzer('ans') })
    const { ctx, imagesPath } = ctxWithDb()
    registerImagesIpc(ctx, service)

    const first = (await invoke(handlers, IPC.imageAnalyze, histReq())).result as ImageJob
    expect((await waitForTerminal(first.jobId)).state).toBe('done')
    const afterFirst = (await invoke(handlers, IPC.imageListSessions)).result as ImageSessionSummary[]
    expect(afterFirst).toHaveLength(1)
    const sessionId = afterFirst[0].id

    const second = (await invoke(handlers, IPC.imageAnalyze, histReq({ question: 'and now?', sessionId })))
      .result as ImageJob
    await waitForTerminal(second.jobId)

    const list = (await invoke(handlers, IPC.imageListSessions)).result as ImageSessionSummary[]
    expect(list).toHaveLength(1)
    expect(list[0].turnCount).toBe(2)
    // Still a single stored image (the follow-up reused the session).
    expect(readdirSync(imagesPath)).toHaveLength(1)
  })

  it('a busy-REJECTED analyze persists nothing', async () => {
    const { analyzer, release } = gatedAnalyzer()
    const service = new VisionService({ getStatus: async () => AVAILABLE, createRuntime: () => analyzer })
    const { ctx } = ctxWithDb()
    registerImagesIpc(ctx, service)

    const first = (await invoke(handlers, IPC.imageAnalyze, histReq())).result as ImageJob
    const busy = (await invoke(handlers, IPC.imageAnalyze, histReq())).result as ImageJob
    expect(busy.error).toBe('busy')
    release()
    await waitForTerminal(first.jobId)

    // Only the first (completed) analyze created a session.
    const list = (await invoke(handlers, IPC.imageListSessions)).result as ImageSessionSummary[]
    expect(list).toHaveLength(1)
  })

  it('deleteImageSession removes the entry and shreds the stored image', async () => {
    const service = new VisionService({ getStatus: async () => AVAILABLE, createRuntime: () => immediateAnalyzer('a') })
    const { ctx, imagesPath } = ctxWithDb()
    registerImagesIpc(ctx, service)

    const job = (await invoke(handlers, IPC.imageAnalyze, histReq())).result as ImageJob
    await waitForTerminal(job.jobId)
    const list = (await invoke(handlers, IPC.imageListSessions)).result as ImageSessionSummary[]
    expect(readdirSync(imagesPath)).toHaveLength(1)

    await invoke(handlers, IPC.imageDeleteSession, list[0].id)
    expect((await invoke(handlers, IPC.imageListSessions)).result).toHaveLength(0)
    expect(existsSync(imagesPath) ? readdirSync(imagesPath) : []).toHaveLength(0)
  })

  it('the history handlers reject a locked workspace', async () => {
    const service = new VisionService({ getStatus: async () => AVAILABLE, createRuntime: () => gatedAnalyzer().analyzer })
    const { ctx } = ctxWithDb(false)
    registerImagesIpc(ctx, service)
    await expect(invoke(handlers, IPC.imageListSessions)).rejects.toThrow()
    await expect(invoke(handlers, IPC.imageGetSession, 'x')).rejects.toThrow()
    await expect(invoke(handlers, IPC.imageDeleteSession, 'x')).rejects.toThrow()
  })
})
