import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
import type { ImageAnalyzeRequest, ImageJob, VisionStatus } from '../../src/shared/types'
import type { AppContext } from '../../src/main/services/context'
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

  // V4 lock/quit teardown mechanism: service.stop() aborts any in-flight job (so it ends
  // `cancelled`, not a scary `runtimeFailed`) AND tears the runtime down so a fresh analyze
  // cold-starts. This is exactly what registerWorkspaceIpc (lock) + will-quit call.
  it('stop() aborts the in-flight job and tears down the runtime (lock/quit path)', async () => {
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
    const terminal = await waitForTerminal(job.jobId)
    expect(terminal.state).toBe('cancelled')
  })
})

describe('registerImagesIpc — readBytes main-side re-validation (SEC-3)', () => {
  it('reads a supported picked image and returns its bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hr-img-'))
    const file = join(dir, 'pic.png')
    writeFileSync(file, Buffer.from([9, 8, 7]))
    registerImagesIpc(ctxFor(dir))
    const { result } = await invoke(handlers, IPC.imageReadBytes, file)
    expect(Buffer.from(result as Uint8Array).equals(Buffer.from([9, 8, 7]))).toBe(true)
  })

  it('refuses an unsupported extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hr-img-'))
    const file = join(dir, 'note.txt')
    writeFileSync(file, 'hi')
    registerImagesIpc(ctxFor(dir))
    await expect(invoke(handlers, IPC.imageReadBytes, file)).rejects.toThrow(IMAGE_UNSUPPORTED_MESSAGE)
  })

  it('refuses an over-cap image (the cap is the default 20 MiB constant)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hr-img-'))
    const file = join(dir, 'big.jpg')
    // Just over the 20 MiB default `VISION_MAX_IMAGE_BYTES`.
    writeFileSync(file, Buffer.alloc(20 * 1024 * 1024 + 1))
    registerImagesIpc(ctxFor(dir))
    await expect(invoke(handlers, IPC.imageReadBytes, file)).rejects.toThrow(IMAGE_TOO_LARGE_MESSAGE)
  })

  it('refuses readBytes when the workspace is locked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hr-img-'))
    const file = join(dir, 'pic.jpg')
    writeFileSync(file, Buffer.from([1]))
    registerImagesIpc(ctxFor(dir, false))
    await expect(invoke(handlers, IPC.imageReadBytes, file)).rejects.toThrow()
  })
})

describe('registerImagesIpc — chooseImage', () => {
  it('returns null when the picker is cancelled', async () => {
    registerImagesIpc(ctxFor(mkdtempSync(join(tmpdir(), 'hr-img-'))))
    const { result } = await invoke(handlers, IPC.imageChooseImage)
    expect(result).toBeNull()
  })

  it('returns {path,name,sizeBytes} for a chosen file (IPC-2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hr-img-'))
    const file = join(dir, 'chosen.png')
    writeFileSync(file, Buffer.from([1, 2, 3, 4, 5]))
    dialogState.result = { canceled: false, filePaths: [file] }
    registerImagesIpc(ctxFor(dir))
    const { result } = await invoke(handlers, IPC.imageChooseImage)
    expect(result).toEqual({ path: file, name: 'chosen.png', sizeBytes: 5 })
  })
})
