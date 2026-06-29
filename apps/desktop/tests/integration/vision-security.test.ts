import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import * as ocrFactory from '../../src/main/services/ocr/factory'

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
import { openDatabase } from '../../src/main/services/db'
import { encryptFile, decryptFile } from '../../src/main/services/workspace-vault'
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
// A valid PNG header (8-byte signature + IHDR width@16/height@20) so the analyze passes the
// main-side guard — SEC-6 (backend-audit-2026-06-27) rejects a claimed png/jpeg with an
// unparseable header — followed by a unique marker tail kept distinct for the leak checks.
const SENTINEL_BYTES = (() => {
  const b = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0, 0, 0, 0, 0, 0, 0, 0, // IHDR length + "IHDR" tag (not parsed by the header guard)
    0, 0, 0, 2, 0, 0, 0, 2, // width@16 = 2, height@20 = 2
    0xab, 0xcd, 0xef, 0x10, 0x20, 0x30 // unique sentinel tail
  ])
  return b
})()

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

// A real (temp) workspace + db + cipher so the NEW history persistence runs for real (the
// content-free-log + no-audit guarantees must hold even WITH persistence — see TEST-3, which
// asserts the stored image rests ENCRYPTED). A fresh temp root per call keeps tests isolated.
function ctxFor(
  audit: ReturnType<typeof vi.fn>,
  rootPath = mkdtempSync(join(tmpdir(), 'hilbertraum-vision-sec-')),
  unlocked = true
): AppContext {
  const key = randomBytes(32)
  return {
    paths: { rootPath, workspacePath: rootPath },
    db: openDatabase(join(rootPath, 'hilbertraum.sqlite')),
    manifestsDir: null,
    isDev: false,
    workspace: {
      isUnlocked: () => unlocked,
      documentCipher: () => ({
        encryptFile: (s: string, d: string) => encryptFile(s, d, key),
        decryptFile: (s: string, d: string) => decryptFile(s, d, key)
      })
    },
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
/** The raw (method, msg, meta) of every diagnostics-log call — lets a test assert the exact
 *  SHAPE of a log line (e.g. that a warn carries ONLY {jobId, error}, no content field). */
let logRecords: Array<{ method: 'info' | 'warn' | 'error'; msg: string; meta?: unknown }>
const logSpies: Array<{ mockRestore: () => void }> = []

beforeEach(() => {
  ipcState.handlers.clear()
  logCalls = []
  logRecords = []
  // Capture every diagnostics-log argument WITHOUT writing anything (no real sink needed).
  for (const method of ['info', 'warn', 'error'] as const) {
    logSpies.push(
      vi.spyOn(log, method).mockImplementation((msg: string, meta?: unknown): void => {
        logCalls.push(meta === undefined ? msg : `${msg} ${JSON.stringify(meta)}`)
        logRecords.push({ method, msg, meta })
      })
    )
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

  // TEST-1 (non-vacuous): the answer ACTUALLY flows through the system (streamed via onToken),
  // then the analyze fails — so we exercise the REAL `index.ts` catch→log.warn path with content
  // present, and assert the warn carries ONLY a content-free {jobId, error}. A regression that
  // logged `req.question` or the answer (an extra meta key, or a content-bearing error) reddens.
  it('a failure AFTER the answer streamed logs ONLY a content-free {jobId, error}', async () => {
    const audit = vi.fn()
    const service = new VisionService({
      getStatus: async () => AVAILABLE,
      // Allowed test seam: the answer really flows through onToken, then a content-free throw.
      createRuntime: () => ({
        analyze: async (o: { onToken?: (d: string) => void }) => {
          o.onToken?.(SENTINEL_ANSWER)
          throw new Error('Vision request failed: HTTP 500') // content-free, like the real runtime
        }
      })
    })
    registerImagesIpc(ctxFor(audit), service)

    const initial = (await invoke(handlers, IPC.imageAnalyze, sentinelReq())).result as ImageJob
    const terminal = await waitForTerminal(initial.jobId)
    expect(terminal.state).toBe('failed')
    expect(terminal.error).toBe('runtimeFailed')

    const warns = logRecords.filter((r) => r.method === 'warn' && r.msg === 'Vision analyze failed')
    expect(warns).toHaveLength(1)
    const meta = warns[0].meta as Record<string, unknown>
    // The meta shape is EXACTLY {jobId, error} — no `question`/`answer`/`imageBytes` smuggled in.
    expect(Object.keys(meta).sort()).toEqual(['error', 'jobId'])
    expect(meta.jobId).toBe(initial.jobId)
    expect(JSON.stringify(meta)).not.toContain('ZZSENTINELZZ')
    expect(logCalls.join('\n')).not.toContain('ZZSENTINELZZ')
    expect(audit).not.toHaveBeenCalled()
  })

  // TEST-5 (full-audit-2026-06-29, Phase 3): the success-path no-leak guarantee, routed through the
  // REAL VisionRuntime (recording fetch + an SSE body) instead of a hand-written fake `analyze`. The
  // earlier version replaced `createRuntime` with a fake, so the real runtime's request construction
  // (base64-inlining the image into the data-URL body) + SSE parsing were NOT exercised by this no-leak
  // assertion — a leak inside those internals would have slipped through. This drives the real
  // `runAnalyze` (`server.fetch('/v1/chat/completions', …)` → `readChatSSE`), so the prompt + image
  // bytes genuinely pass through the runtime layer, then asserts NO diagnostics-log call (any level)
  // carries the prompt, the answer, or the base64 image bytes.
  // TEETH: log `opts.question` or the image data-URL at the runtime layer (vision/runtime.ts
  // runAnalyze) → the spy captures it and this test reddens.
  it('logs NOTHING containing content on the SUCCESS path — through the REAL VisionRuntime (TEST-5)', async () => {
    const urls: string[] = []
    const recordingFetch = (async (url: string | URL) => {
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
    // The answer genuinely streamed back through the REAL SSE parser (proving the runtime ran)…
    expect(done.answer).toBe(SENTINEL_ANSWER)
    // …and the request really went to loopback (the runtime built + sent the data-URL body).
    expect(urls.some((u) => u.endsWith('/v1/chat/completions'))).toBe(true)

    // …yet NO diagnostics-log call (any level) carries the prompt, the answer, or the image bytes.
    const imageB64 = Buffer.from(SENTINEL_BYTES).toString('base64')
    for (const r of logRecords) {
      const line = `${r.msg} ${JSON.stringify(r.meta ?? {})}`
      expect(line).not.toContain('ZZSENTINELZZ')
      expect(line).not.toContain(imageB64)
    }
    expect(logCalls.join('\n')).not.toContain('ZZSENTINELZZ')
    expect(logCalls.join('\n')).not.toContain(imageB64)
    expect(audit).not.toHaveBeenCalled()
  })

  // TEST-3 / plan §17 row 11: Images is cleanly separate from OCR/Documents — a vision analyze
  // must NOT construct the OCR engine and must NOT touch documents/ocr_json. The image-history
  // feature DOES persist the analyzed image, but ENCRYPTED AT REST (the old "writes nothing to
  // disk" guarantee is intentionally replaced — see security-model.md): the stored copy is a
  // .enc sidecar under images/ and the raw image bytes never appear in plaintext on disk.
  it('never invokes the OCR engine; stores the image ENCRYPTED under images/ (no plaintext leak)', async () => {
    const ocrSpy = vi.spyOn(ocrFactory, 'createSelectedOcrEngine')
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-vision-iso-'))
    const audit = vi.fn()
    const service = new VisionService({
      getStatus: async () => AVAILABLE,
      createRuntime: () => ({
        analyze: async (o: { onToken?: (d: string) => void }) => {
          o.onToken?.('a bar chart')
          return 'a bar chart'
        }
      })
    })
    registerImagesIpc(ctxFor(audit, root), service)

    const initial = (await invoke(handlers, IPC.imageAnalyze, sentinelReq())).result as ImageJob
    const done = await waitForTerminal(initial.jobId)
    expect(done.state).toBe('done')

    expect(ocrSpy).not.toHaveBeenCalled() // no OCR engine ever built on the vision path
    expect(existsSync(join(root, 'documents'))).toBe(false) // never the documents pipeline
    expect(existsSync(join(root, 'ocr_json'))).toBe(false)

    // The image rests encrypted: a .enc sidecar under images/, no transient temp, no plaintext.
    const imagesPath = join(root, 'images')
    expect(existsSync(imagesPath)).toBe(true)
    const stored = readdirSync(imagesPath)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatch(/\.enc$/)
    expect(readFileSync(join(imagesPath, stored[0])).includes(Buffer.from(SENTINEL_BYTES))).toBe(false)
    ocrSpy.mockRestore()
  })

  // MEDIUM vuln-scan-2026-06-21: a completed answer (content derived from the private image)
  // must not linger in the per-process job map after the workspace locks. stop() (wired to lock)
  // must purge it, like the lock path purges resident RAG vectors and zeroes the vault key.
  it('stop() purges completed-answer residue from the job map (lock-time RAM purge)', async () => {
    const audit = vi.fn()
    const service = new VisionService({
      getStatus: async () => AVAILABLE,
      createRuntime: () => ({
        analyze: async (o: { onToken?: (d: string) => void }) => {
          o.onToken?.(SENTINEL_ANSWER)
          return SENTINEL_ANSWER
        }
      })
    })
    registerImagesIpc(ctxFor(audit), service)

    const initial = (await invoke(handlers, IPC.imageAnalyze, sentinelReq())).result as ImageJob
    const done = await waitForTerminal(initial.jobId)
    expect(done.answer).toBe(SENTINEL_ANSWER) // the answer is resident…

    await service.stop() // …workspace lock / quit teardown
    const after = service.getJob(initial.jobId)
    expect(after.state).toBe('failed') // unknown job ⇒ purged
    expect(after.answer).toBeUndefined() // no answer text survives the lock
  })

  // BUG vuln-scan-2026-06-21: terminal jobs (each holding its answer) accumulated for the
  // process lifetime. The map is now bounded — old terminal jobs are evicted.
  it('bounds the job map: old terminal jobs are evicted (no unbounded growth)', async () => {
    const audit = vi.fn()
    const service = new VisionService({
      getStatus: async () => AVAILABLE,
      createRuntime: () => ({ analyze: async () => 'ok' })
    })
    registerImagesIpc(ctxFor(audit), service)

    const ids: string[] = []
    for (let i = 0; i < 20; i++) {
      const initial = (await invoke(handlers, IPC.imageAnalyze, sentinelReq())).result as ImageJob
      await waitForTerminal(initial.jobId)
      ids.push(initial.jobId)
    }
    // The earliest jobs were evicted (cap 16); the most recent are still retained.
    expect(service.getJob(ids[0]).state).toBe('failed') // evicted ⇒ unknown
    expect(service.getJob(ids[ids.length - 1]).state).toBe('done') // recent ⇒ kept
  })

  // MEDIUM vuln-scan-2026-06-21: imageGetJob/imageCancel are gated on unlock, like imageAnalyze
  // and the history handlers — a locked workspace exposes no job (or its answer) over IPC.
  it('imageGetJob/imageCancel refuse while the workspace is locked', async () => {
    const audit = vi.fn()
    const service = new VisionService({
      getStatus: async () => AVAILABLE,
      createRuntime: () => ({ analyze: async () => 'ok' })
    })
    registerImagesIpc(ctxFor(audit, undefined, false), service) // locked

    await expect(invoke(handlers, IPC.imageGetJob, 'any-job-id')).rejects.toThrow()
    await expect(invoke(handlers, IPC.imageCancel, 'any-job-id')).rejects.toThrow()
  })
})
