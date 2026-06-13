import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  deleteDocument,
  documentsDir,
  getDocument,
  getDocumentSummary,
  listDocuments,
  processDocument,
  reindexDocument
} from '../../src/main/services/ingestion'
import {
  DocTaskManager,
  TASK_DOCUMENT_NOT_READY_MESSAGE,
  TASK_EXPIRED_MESSAGE,
  TASK_NEEDS_RUNTIME_MESSAGE,
  TASK_REFUSED_CHAT_STREAMING_MESSAGE,
  SUMMARY_MAP_CALL_CEILING,
  SUMMARY_TEMPERATURE
} from '../../src/main/services/doctasks'
import { recordEvent, listAuditEvents } from '../../src/main/services/audit'
import type { AuditEventType } from '../../src/shared/types'
import type {
  ChatMessage,
  ModelRuntime,
  RuntimeChatOptions
} from '../../src/main/services/runtime'

// Phase 33 — the document task engine (wave-3 plan §6): state machine (serialized
// queue, refuse-while-chat-streams, cancel mid-stream, runtime-absent friendly
// failure), the MockRuntime-style end-to-end summary, persistence + re-index
// invalidation + delete, and the ids-only audit events. CI posture: zero model, zero
// network — scripted fake runtimes drive every path.

let tmp: string
let db: Db
let storeDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hilbertraum-doctasks-'))
  db = openDatabase(join(tmp, 'test.sqlite'))
  storeDir = documentsDir(join(tmp, 'workspace'))
})

/** Import a .txt of `words` whitespace words through the REAL ingestion pipeline. */
async function importDoc(words: number, name = 'doc.txt'): Promise<string> {
  const text = Array.from({ length: words }, (_, i) => `word${i}`).join(' ')
  const p = join(tmp, name)
  writeFileSync(p, text, 'utf8')
  const info = createQueuedDocument(db, p)
  const done = await processDocument(db, storeDir, info.id)
  expect(done.status).toBe('indexed')
  return info.id
}

interface ScriptedRuntimeOptions {
  /** Reply text per call (default: a fixed summary line). */
  reply?: (call: { messages: ChatMessage[]; options?: RuntimeChatOptions }) => string
  /** Delay (ms) before each token — lets cancel land mid-stream. */
  tokenDelayMs?: number
  /** Resolved before each call starts streaming (a gate for queue tests). */
  gate?: () => Promise<void>
}

interface ScriptedRuntime extends ModelRuntime {
  calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }>
  concurrent: number
  maxConcurrent: number
}

/** A scripted ModelRuntime that records calls and honours the abort signal. */
function scriptedRuntime(opts: ScriptedRuntimeOptions = {}): ScriptedRuntime {
  const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      const t = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(t)
        resolve()
      })
    })
  const runtime: ScriptedRuntime = {
    modelId: 'scripted-model',
    calls: [],
    concurrent: 0,
    maxConcurrent: 0,
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
      const call = { messages, options }
      runtime.calls.push(call)
      runtime.concurrent += 1
      runtime.maxConcurrent = Math.max(runtime.maxConcurrent, runtime.concurrent)
      try {
        if (opts.gate) await opts.gate()
        const text = opts.reply
          ? opts.reply(call)
          : 'A concise summary of the document with its key points.'
        for (const token of text.match(/\S+\s*/g) ?? [text]) {
          if (options?.signal?.aborted) return
          if (opts.tokenDelayMs) await delay(opts.tokenDelayMs, options?.signal)
          yield token
        }
      } finally {
        runtime.concurrent -= 1
      }
    }
  }
  return runtime
}

interface ManagerOptions {
  runtime?: ModelRuntime | null
  contextTokens?: number
  chatStreaming?: () => boolean
  audit?: boolean
  /** Override the Phase-32 lease seam (default: a counting no-op lease). */
  beginDocumentWork?: () => () => void
}

function makeManager(opts: ManagerOptions = {}): DocTaskManager {
  return new DocTaskManager({
    getDb: () => db,
    getRuntime: () => (opts.runtime === undefined ? null : opts.runtime),
    isChatStreaming: opts.chatStreaming ?? (() => false),
    getContextTokens: () => opts.contextTokens ?? 4096,
    getStoreDir: () => storeDir,
    getIngestionDeps: () => ({}),
    beginDocumentWork: opts.beginDocumentWork ?? (() => () => {}),
    audit: opts.audit
      ? (type, message, metadata) => recordEvent(db, type as AuditEventType, message, metadata)
      : undefined
  })
}

async function waitTerminal(manager: DocTaskManager, jobId: string): Promise<ReturnType<DocTaskManager['getDocTask']>> {
  const start = Date.now()
  for (;;) {
    const status = manager.getDocTask(jobId)
    if (status.state === 'done' || status.state === 'failed' || status.state === 'cancelled') {
      return status
    }
    if (Date.now() - start > 10_000) throw new Error(`task ${jobId} never finished: ${status.state}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('end-to-end summary (single pass)', () => {
  it('summarizes a small document and persists { text, modelId, createdAt, truncated:false }', async () => {
    const docId = await importDoc(300)
    const runtime = scriptedRuntime()
    const manager = makeManager({ runtime, audit: true })

    const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
    expect(['queued', 'running']).toContain(manager.getDocTask(jobId).state)

    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    expect(status.resultRef).toEqual({ documentId: docId })
    expect(status.progress).toEqual({ stepsDone: 1, stepsTotal: 1 })

    const summary = getDocumentSummary(db, docId)
    expect(summary?.text).toContain('concise summary')
    expect(summary?.modelId).toBe('scripted-model')
    expect(summary?.truncated).toBe(false)
    expect(Date.parse(summary?.createdAt ?? '')).not.toBeNaN()

    // The listing surface carries it too (what the renderer reads).
    const listed = listDocuments(db).find((d) => d.id === docId)
    expect(listed?.summary?.text).toBe(summary?.text)

    // One model call, explicit params, no depth mode (the D26/§6 contract).
    expect(runtime.calls).toHaveLength(1)
    expect(runtime.calls[0].options?.maxTokens).toBeGreaterThan(0)
    expect(runtime.calls[0].options?.temperature).toBe(SUMMARY_TEMPERATURE)
    expect(runtime.calls[0].options?.mode).toBeUndefined()
    // The document text reached the model; the prompt carries the title.
    expect(runtime.calls[0].messages[1].content).toContain('word42')
    expect(runtime.calls[0].messages[1].content).toContain('doc.txt')

    // Audit: ids-only completion event.
    const events = listAuditEvents(db, { limit: 100 })
    const completed = events.find((e) => e.type === 'document_task_completed')
    expect(completed?.metadata).toEqual({ kind: 'summary', documentId: docId })
  })

  it('strips think blocks from the produced summary (defense-in-depth, D6)', async () => {
    const docId = await importDoc(50)
    const runtime = scriptedRuntime({
      reply: () => '<think>secret chain of thought</think>The actual summary text here.'
    })
    const manager = makeManager({ runtime })
    const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    const summary = getDocumentSummary(db, docId)
    expect(summary?.text).toBe('The actual summary text here.')
    expect(summary?.text).not.toContain('chain of thought')
  })
})

describe('map-reduce path + the hard ceiling', () => {
  it('cuts over to map windows + one reduce when the text exceeds the budget', async () => {
    // contextTokens 1024 → word budget 200: a 700-word doc spans multiple windows.
    const docId = await importDoc(700)
    const runtime = scriptedRuntime({ reply: () => 'Partial summary.' })
    const manager = makeManager({ runtime, contextTokens: 1024 })

    const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')

    const mapCalls = runtime.calls.slice(0, -1)
    const reduceCall = runtime.calls[runtime.calls.length - 1]
    expect(mapCalls.length).toBeGreaterThanOrEqual(2)
    expect(status.progress.stepsTotal).toBe(mapCalls.length + 1)
    expect(status.progress.stepsDone).toBe(status.progress.stepsTotal)
    expect(mapCalls[0].messages[1].content).toMatch(/part 1 of \d+/i)
    expect(reduceCall.messages[1].content).toContain('partial summaries')
    expect(getDocumentSummary(db, docId)?.truncated).toBe(false)
  })

  it('honours the map-call ceiling and flags the summary truncated', async () => {
    // 6000 words at a 200-word budget wants ~30 windows → capped at the ceiling.
    const docId = await importDoc(6000)
    const runtime = scriptedRuntime({ reply: () => 'Partial summary.' })
    const manager = makeManager({ runtime, contextTokens: 1024 })

    const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    expect(runtime.calls).toHaveLength(SUMMARY_MAP_CALL_CEILING + 1)
    expect(getDocumentSummary(db, docId)?.truncated).toBe(true)
  })
})

describe('state machine guards (D26)', () => {
  it('refuses to start while a chat answer is streaming', async () => {
    const docId = await importDoc(50)
    const manager = makeManager({ runtime: scriptedRuntime(), chatStreaming: () => true })
    expect(() => manager.startDocTask({ kind: 'summary', documentIds: [docId] })).toThrow(
      TASK_REFUSED_CHAT_STREAMING_MESSAGE
    )
  })

  it('refuses to start with no runtime (never auto-starts one)', async () => {
    const docId = await importDoc(50)
    const manager = makeManager({ runtime: null })
    expect(() => manager.startDocTask({ kind: 'summary', documentIds: [docId] })).toThrow(
      TASK_NEEDS_RUNTIME_MESSAGE
    )
  })

  it('fails friendly when the runtime is stopped while the task is queued', async () => {
    const doc1 = await importDoc(50, 'a.txt')
    const doc2 = await importDoc(50, 'b.txt')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let runtime: ModelRuntime | null = scriptedRuntime({ gate: () => gate })
    const manager = new DocTaskManager({
      getDb: () => db,
      getRuntime: () => runtime,
      isChatStreaming: () => false,
      getContextTokens: () => 4096,
      getStoreDir: () => storeDir,
      getIngestionDeps: () => ({}),
      beginDocumentWork: () => () => {}
    })

    const first = manager.startDocTask({ kind: 'summary', documentIds: [doc1] })
    const second = manager.startDocTask({ kind: 'summary', documentIds: [doc2] })
    expect(manager.getDocTask(second.jobId).state).toBe('queued')

    runtime = null // the model is stopped while task 2 waits
    release()
    // Task 1 already held its runtime reference and finishes; task 2 re-checks and fails.
    await waitTerminal(manager, first.jobId)
    const failed = await waitTerminal(manager, second.jobId)
    expect(failed.state).toBe('failed')
    expect(failed.error).toBe(TASK_NEEDS_RUNTIME_MESSAGE)
  })

  it('serializes tasks: one queue, never two model calls in flight', async () => {
    const doc1 = await importDoc(60, 'a.txt')
    const doc2 = await importDoc(60, 'b.txt')
    const runtime = scriptedRuntime({ tokenDelayMs: 1 })
    const manager = makeManager({ runtime })

    const first = manager.startDocTask({ kind: 'summary', documentIds: [doc1] })
    const second = manager.startDocTask({ kind: 'summary', documentIds: [doc2] })
    expect(manager.hasActiveTask()).toBe(true)
    expect(manager.getDocTask(second.jobId).state).toBe('queued')

    expect((await waitTerminal(manager, first.jobId)).state).toBe('done')
    expect((await waitTerminal(manager, second.jobId)).state).toBe('done')
    expect(runtime.maxConcurrent).toBe(1)
    expect(manager.hasActiveTask()).toBe(false)
    expect(getDocumentSummary(db, doc1)).toBeTruthy()
    expect(getDocumentSummary(db, doc2)).toBeTruthy()
  })

  it('cancels a RUNNING task mid-stream: state cancelled, nothing persisted, no audit event', async () => {
    const docId = await importDoc(300)
    const runtime = scriptedRuntime({ tokenDelayMs: 25 })
    const manager = makeManager({ runtime, audit: true })

    const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
    // Let the stream start, then cancel mid-generation.
    await new Promise((r) => setTimeout(r, 40))
    manager.cancelDocTask(jobId)

    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('cancelled')
    expect(getDocumentSummary(db, docId)).toBeNull()
    const types = listAuditEvents(db, { limit: 100 }).map((e) => e.type)
    expect(types).not.toContain('document_task_completed')
    expect(types).not.toContain('document_task_failed')
  })

  it('cancels a QUEUED task without running it; no-arg cancel hits the active task', async () => {
    const doc1 = await importDoc(50, 'a.txt')
    const doc2 = await importDoc(50, 'b.txt')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const runtime = scriptedRuntime({ gate: () => gate, tokenDelayMs: 5 })
    const manager = makeManager({ runtime })

    const first = manager.startDocTask({ kind: 'summary', documentIds: [doc1] })
    const second = manager.startDocTask({ kind: 'summary', documentIds: [doc2] })

    manager.cancelDocTask(second.jobId) // queued → dequeued immediately
    expect(manager.getDocTask(second.jobId).state).toBe('cancelled')

    manager.cancelDocTask() // no jobId → the running task
    release()
    expect((await waitTerminal(manager, first.jobId)).state).toBe('cancelled')
    expect(manager.hasActiveTask()).toBe(false)
  })

  it('rejects not-ready documents, unknown kinds, and not-yet-available kinds', async () => {
    const manager = makeManager({ runtime: scriptedRuntime() })
    // Unknown document.
    expect(() => manager.startDocTask({ kind: 'summary', documentIds: ['nope'] })).toThrow(
      TASK_DOCUMENT_NOT_READY_MESSAGE
    )
    // A queued (not yet indexed) document.
    const p = join(tmp, 'pending.txt')
    writeFileSync(p, 'hello world', 'utf8')
    const queued = createQueuedDocument(db, p)
    expect(() => manager.startDocTask({ kind: 'summary', documentIds: [queued.id] })).toThrow(
      TASK_DOCUMENT_NOT_READY_MESSAGE
    )
    // Kind validation. (Translation shipped in Phase 34, compare in Phase 35 — see
    // doctasks-translation.test.ts / doctasks-compare.test.ts.)
    expect(() =>
      manager.startDocTask({ kind: 'nonsense' as never, documentIds: ['x'] })
    ).toThrow('Unknown document task.')
  })

  it('reports unknown job ids as terminal so pollers stop', () => {
    const manager = makeManager({ runtime: scriptedRuntime() })
    const status = manager.getDocTask('never-existed')
    expect(status.state).toBe('failed')
    expect(status.error).toBe(TASK_EXPIRED_MESSAGE)
  })

  it('records the ids-only failure audit event on a crashing model call', async () => {
    const docId = await importDoc(50)
    const runtime = scriptedRuntime()
    runtime.chatStream = async function* () {
      yield 'a'
      throw new Error('HTTP 500 from llama-server: secret internal details')
    }
    const manager = makeManager({ runtime, audit: true })
    const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('failed')
    // Friendly copy, never the raw error.
    expect(status.error).not.toContain('HTTP 500')
    expect(status.error).toMatch(/try again/i)
    const events = listAuditEvents(db, { limit: 100 })
    const failed = events.find((e) => e.type === 'document_task_failed')
    expect(failed?.metadata).toEqual({ kind: 'summary', documentId: docId })
    expect(JSON.stringify(events)).not.toContain('HTTP 500')
  })

  it('flags the busy document while a task is active (isDocumentBusy)', async () => {
    const docId = await importDoc(100)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const manager = makeManager({ runtime: scriptedRuntime({ gate: () => gate }) })
    const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
    expect(manager.isDocumentBusy(docId)).toBe(true)
    expect(manager.isDocumentBusy('other')).toBe(false)
    release()
    await waitTerminal(manager, jobId)
    expect(manager.isDocumentBusy(docId)).toBe(false)
  })
})

describe('summary persistence lifecycle (D25)', () => {
  it('re-index clears the summary (content may have changed)', async () => {
    const docId = await importDoc(100)
    const manager = makeManager({ runtime: scriptedRuntime() })
    const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
    await waitTerminal(manager, jobId)
    expect(getDocumentSummary(db, docId)).toBeTruthy()

    const info = await reindexDocument(db, storeDir, docId)
    expect(info.status).toBe('indexed')
    expect(getDocumentSummary(db, docId)).toBeNull()
    expect(getDocument(db, docId)?.summary ?? null).toBeNull()
  })

  it('delete removes the summary with the document row', async () => {
    const docId = await importDoc(100)
    const manager = makeManager({ runtime: scriptedRuntime() })
    const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
    await waitTerminal(manager, jobId)

    deleteDocument(db, docId)
    expect(getDocument(db, docId)).toBeNull()
    expect(getDocumentSummary(db, docId)).toBeNull()
  })

  it('a malformed stored summary reads as null instead of breaking the listing', async () => {
    const docId = await importDoc(50)
    db.prepare('UPDATE documents SET summary_json = ? WHERE id = ?').run('{not json', docId)
    expect(getDocumentSummary(db, docId)).toBeNull()
    expect(listDocuments(db).find((d) => d.id === docId)?.summary ?? null).toBeNull()
  })
})
