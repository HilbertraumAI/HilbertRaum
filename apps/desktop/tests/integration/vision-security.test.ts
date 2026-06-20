import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

// Security sentinel for the vision path (image-understanding plan §13/§17, CLAUDE.md §0):
//   1. LOOPBACK ONLY — the sidecar fetch must only ever connect to 127.0.0.1; no remote host is
//      introduced (the offline guard exempts loopback precisely so this local socket is allowed).
//   2. NO CONTENT IN THE LOG — a recognizable prompt + answer + image byte pattern pushed through
//      analyze must NOT appear in any diagnostics-log call (only friendly codes / stderr tails).
//   3. NO VISION AUDIT ROWS — the vision path writes ZERO audit events (ctx.audit is never called).

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
}))

import { registerImagesIpc } from '../../src/main/ipc/registerImagesIpc'
import { VisionService } from '../../src/main/services/vision'
import { VisionRuntime } from '../../src/main/services/vision/runtime'
import { log } from '../../src/main/services/logging'
import { IPC } from '../../src/shared/ipc'
import type { ImageAnalyzeRequest, ImageJob, VisionStatus } from '../../src/shared/types'
import type { AppContext } from '../../src/main/services/context'
import { invoke, invokeWithEvent, makeEvent, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

// Recognizable sentinels — no real prompt/answer/image would contain these exact strings.
const SENTINEL_PROMPT = 'ZZSENTINELZZ what is the secret account number in this image'
const SENTINEL_ANSWER = 'ZZSENTINELZZ the secret account number is 4444-3333-2222'
const SENTINEL_BYTES = new Uint8Array([0xab, 0xcd, 0xef, 0x10, 0x20, 0x30])

class FakeChild extends EventEmitter {
  pid = 9
  killed = false
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  }
}

function sseBody(answer: string): ReadableStream<Uint8Array> {
  // A minimal byte-identical-to-chat SSE stream carrying the sentinel answer in one delta.
  const frame =
    `data: {"choices":[{"finish_reason":null,"index":0,"delta":{"content":${JSON.stringify(answer)}}}]}\n\n` +
    'data: [DONE]\n\n'
  const bytes = new TextEncoder().encode(frame)
  let sent = false
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return controller.close()
      sent = true
      controller.enqueue(bytes)
    }
  })
}

const AVAILABLE: VisionStatus = { available: true, modelId: 'vlm', modelDisplayName: 'VLM' }

function ctxFor(audit: ReturnType<typeof vi.fn>): AppContext {
  return {
    paths: { rootPath: '/r' },
    manifestsDir: null,
    isDev: false,
    workspace: { isUnlocked: () => true },
    audit
  } as unknown as AppContext
}

const sentinelReq = (): ImageAnalyzeRequest => ({
  imageBytes: SENTINEL_BYTES,
  mimeType: 'image/png',
  question: SENTINEL_PROMPT
})

async function waitForTerminal(jobId: string): Promise<ImageJob> {
  for (let i = 0; i < 200; i++) {
    const { result } = await invoke(handlers, IPC.imageGetJob, jobId)
    const job = result as ImageJob
    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return job
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('vision job never reached a terminal state')
}

let logCalls: string[]
const logSpies: Array<{ mockRestore: () => void }> = []

beforeEach(() => {
  ipcState.handlers.clear()
  logCalls = []
  // Capture every diagnostics-log argument WITHOUT writing anything (no real sink needed).
  const record = (msg: string, meta?: unknown): void => {
    logCalls.push(meta === undefined ? msg : `${msg} ${JSON.stringify(meta)}`)
  }
  for (const method of ['info', 'warn', 'error'] as const) {
    logSpies.push(vi.spyOn(log, method).mockImplementation(record))
  }
})

afterEach(() => {
  for (const s of logSpies) s.mockRestore()
  logSpies.length = 0
})

describe('vision security sentinel', () => {
  it('connects only to loopback (127.0.0.1) and logs/audits NO image/prompt/answer content', async () => {
    const urls: string[] = []
    const recordingFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      urls.push(u)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      if (u.endsWith('/v1/chat/completions')) {
        return { ok: true, status: 200, body: sseBody(SENTINEL_ANSWER) } as unknown as Response
      }
      throw new Error(`unexpected url ${u}`)
    }) as typeof fetch

    const audit = vi.fn()
    const service = new VisionService({
      getStatus: async () => AVAILABLE,
      createRuntime: () =>
        new VisionRuntime({
          modelId: 'vlm',
          binPath: '/bin/llama-server',
          modelPath: '/m/vlm.gguf',
          projectorPath: '/m/mmproj.gguf',
          spawn: (() => new FakeChild()) as never,
          fetchImpl: recordingFetch,
          findPort: async () => 51234,
          healthIntervalMs: 1,
          idleTimeoutMs: 100_000
        })
    })
    registerImagesIpc(ctxFor(audit), service)

    const event = makeEvent()
    const initial = (await invokeWithEvent(handlers, IPC.imageAnalyze, event, sentinelReq())) as ImageJob
    const done = await waitForTerminal(initial.jobId)
    expect(done.state).toBe('done')
    expect(done.answer).toBe(SENTINEL_ANSWER)

    // 1. LOOPBACK ONLY — every connection targeted 127.0.0.1, nothing remote.
    expect(urls.length).toBeGreaterThan(0)
    for (const u of urls) expect(new URL(u).hostname).toBe('127.0.0.1')

    // 2. NO CONTENT IN THE LOG — neither the prompt, the answer, nor the image bytes leaked.
    const allLog = logCalls.join('\n')
    expect(allLog).not.toContain('ZZSENTINELZZ')
    expect(allLog).not.toContain(Buffer.from(SENTINEL_BYTES).toString('base64'))

    // 3. NO VISION AUDIT ROWS — the vision path records nothing on the audit log.
    expect(audit).not.toHaveBeenCalled()
  })

  it('a runtime FAILURE logs a friendly code only — never the prompt/answer (failure path)', async () => {
    const failingFetch = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      // Server rejects the request: VisionService logs warn — assert it carries no content.
      return { ok: false, status: 500, body: null } as unknown as Response
    }) as typeof fetch

    const audit = vi.fn()
    const service = new VisionService({
      getStatus: async () => AVAILABLE,
      createRuntime: () =>
        new VisionRuntime({
          modelId: 'vlm',
          binPath: '/bin/llama-server',
          modelPath: '/m/vlm.gguf',
          projectorPath: '/m/mmproj.gguf',
          spawn: (() => new FakeChild()) as never,
          fetchImpl: failingFetch,
          findPort: async () => 51234,
          healthIntervalMs: 1
        })
    })
    registerImagesIpc(ctxFor(audit), service)

    const initial = (await invoke(handlers, IPC.imageAnalyze, sentinelReq())).result as ImageJob
    const terminal = await waitForTerminal(initial.jobId)
    expect(terminal.state).toBe('failed')
    expect(terminal.error).toBe('runtimeFailed') // a friendly code, not raw runtime text

    expect(logCalls.join('\n')).not.toContain('ZZSENTINELZZ')
    expect(audit).not.toHaveBeenCalled()
  })
})
