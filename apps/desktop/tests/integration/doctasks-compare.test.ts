import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  documentsDir,
  getDocument,
  getDocumentOrigin,
  listDocuments,
  processDocument,
  readStoredDocumentText,
  type IngestionDeps
} from '../../src/main/services/ingestion'
import {
  COMPARE_MAP_CALL_CEILING,
  COMPARE_OUTPUT_TOKENS,
  COMPARE_TEMPERATURE,
  DocTaskManager,
  TASK_COMPARE_PICK_TWO_MESSAGE,
  TASK_COMPARE_REINDEX_MESSAGE,
  TASK_DOCUMENT_NOT_READY_MESSAGE,
  compareAttributionLine,
  compareBudgetWords,
  compareTruncationNotice,
  type DocTaskDeps
} from '../../src/main/services/doctasks'
import { recordEvent, listAuditEvents } from '../../src/main/services/audit'
import type { AuditEventType } from '../../src/shared/types'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import type { Embedder } from '../../src/main/services/embeddings'
import type {
  ChatMessage,
  ModelRuntime,
  RuntimeChatOptions
} from '../../src/main/services/runtime'

// Phase 35 — the compare document task (wave-3 plan §8, decisions D28 + D37):
// two-document validation, the auto mode switch by token math (single-pass full
// compare vs section-matched map/reduce), the D37 segments-not-chunks input, the
// embedder-visibility (staleEmbeddings) guard, deterministic vector pairing, the map
// ceiling + honest truncation notice, report materialization with both-source
// provenance, cancel-persists-nothing, the lease around exactly the materialize step,
// and the ids-only audit events. CI posture: zero model, zero network.

let tmp: string
let db: Db
let storeDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hilbertraum-doccmp-'))
  db = openDatabase(join(tmp, 'test.sqlite'))
  storeDir = documentsDir(join(tmp, 'workspace'))
})

/** Import a .txt of `words` unique whitespace words through the REAL ingestion pipeline. */
async function importDoc(
  words: number,
  name: string,
  prefix: string,
  deps: IngestionDeps = {}
): Promise<string> {
  const text = Array.from({ length: words }, (_, i) => `${prefix}${i}`).join(' ')
  const p = join(tmp, name)
  writeFileSync(p, text, 'utf8')
  const info = createQueuedDocument(db, p)
  const done = await processDocument(db, storeDir, info.id, deps)
  expect(done.status).toBe('indexed')
  return info.id
}

const REPORT =
  '## What both documents share\n- A shared point.\n\n## What differs between them\n- A difference.'

interface ScriptedRuntimeOptions {
  /** Reply per call; throwing fails that call. Default: per-prompt-kind canned replies. */
  reply?: (call: { messages: ChatMessage[]; options?: RuntimeChatOptions }) => string
  /** Delay (ms) before each token — lets cancel land mid-stream. */
  tokenDelayMs?: number
}

interface ScriptedRuntime extends ModelRuntime {
  calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }>
}

function promptOf(call: { messages: ChatMessage[] }): string {
  return call.messages[call.messages.length - 1]?.content ?? ''
}

/** Canned replies per call shape: pair notes for map calls, the REPORT otherwise. */
function defaultReply(call: { messages: ChatMessage[] }): string {
  return promptOf(call).includes('section by section') ? '- Same: a note.' : REPORT
}

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
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
      const call = { messages, options }
      runtime.calls.push(call)
      const text = opts.reply ? opts.reply(call) : defaultReply(call)
      for (const token of text.match(/\S+\s*/g) ?? [text]) {
        if (options?.signal?.aborted) return
        if (opts.tokenDelayMs) await delay(opts.tokenDelayMs, options?.signal)
        yield token
      }
    }
  }
  return runtime
}

interface ManagerOptions {
  runtime?: ModelRuntime | null
  contextTokens?: number
  audit?: boolean
  ingestionDeps?: () => IngestionDeps
  beginDocumentWork?: DocTaskDeps['beginDocumentWork']
}

function makeManager(opts: ManagerOptions = {}): DocTaskManager {
  return new DocTaskManager({
    getDb: () => db,
    getRuntime: () => (opts.runtime === undefined ? null : opts.runtime),
    isChatStreaming: () => false,
    getContextTokens: () => opts.contextTokens ?? 4096,
    getStoreDir: () => storeDir,
    getIngestionDeps: opts.ingestionDeps ?? (() => ({})),
    beginDocumentWork: opts.beginDocumentWork ?? (() => () => {}),
    audit: opts.audit
      ? (type, message, metadata) => recordEvent(db, type as AuditEventType, message, metadata)
      : undefined
  })
}

async function waitTerminal(
  manager: DocTaskManager,
  jobId: string
): Promise<ReturnType<DocTaskManager['getDocTask']>> {
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

async function runCompare(
  manager: DocTaskManager,
  a: string,
  b: string
): Promise<ReturnType<DocTaskManager['getDocTask']>> {
  const { jobId } = manager.startDocTask({ kind: 'compare', documentIds: [a, b] })
  return waitTerminal(manager, jobId)
}

describe('validation (exactly two distinct ready documents)', () => {
  it('refuses one, three, or duplicate document ids with friendly copy', async () => {
    const a = await importDoc(50, 'a.txt', 'alpha')
    const b = await importDoc(50, 'b.txt', 'beta')
    const manager = makeManager({ runtime: scriptedRuntime() })
    for (const ids of [[a], [a, b, a], [a, a], []]) {
      expect(() => manager.startDocTask({ kind: 'compare', documentIds: ids })).toThrow(
        TASK_COMPARE_PICK_TWO_MESSAGE
      )
    }
  })

  it('refuses when either document is not ready', async () => {
    const a = await importDoc(50, 'a.txt', 'alpha')
    const p = join(tmp, 'pending.txt')
    writeFileSync(p, 'hello world', 'utf8')
    const queued = createQueuedDocument(db, p)
    const manager = makeManager({ runtime: scriptedRuntime() })
    expect(() =>
      manager.startDocTask({ kind: 'compare', documentIds: [a, queued.id] })
    ).toThrow(TASK_DOCUMENT_NOT_READY_MESSAGE)
    expect(() => manager.startDocTask({ kind: 'compare', documentIds: [a, 'nope'] })).toThrow(
      TASK_DOCUMENT_NOT_READY_MESSAGE
    )
  })
})

describe('mode (a) — small-docs full compare (D37: re-extracted segments)', () => {
  it('one model call over both FULL texts → a materialized report with both-source provenance', async () => {
    // 600 unique words each: more than one 500-token chunk, so the STORED chunks
    // overlap by ~80 tokens — but the prompt must carry each word exactly ONCE (D37:
    // segments, not chunks). At ctx 4096 the budget is 2526 words, so 1200 total
    // still fits a single pass.
    const a = await importDoc(600, 'a.txt', 'alpha')
    const b = await importDoc(600, 'b.txt', 'beta')
    const runtime = scriptedRuntime()
    const manager = makeManager({ runtime, audit: true })

    const status = await runCompare(manager, a, b)
    expect(status.state).toBe('done')
    expect(runtime.calls).toHaveLength(1)
    expect(status.progress).toEqual({ stepsDone: 2, stepsTotal: 2 })
    expect(runtime.calls[0].options?.maxTokens).toBe(COMPARE_OUTPUT_TOKENS)
    expect(runtime.calls[0].options?.temperature).toBe(COMPARE_TEMPERATURE)

    // The single prompt carries both documents' full texts — every word exactly once
    // (chunk concatenation would duplicate the ~80-token overlap, e.g. alpha450).
    const prompt = promptOf(runtime.calls[0])
    expect(prompt).toContain('Document A ("a.txt")')
    expect(prompt).toContain('Document B ("b.txt")')
    for (const probe of ['alpha450 ', 'alpha0 ', 'beta450 ']) {
      expect(prompt.split(probe)).toHaveLength(2) // exactly one occurrence
    }

    // The result: a NEW indexed document "Comparison: a vs b.md" with attribution,
    // the report body, NO truncation notice, and compare provenance for BOTH ids.
    const newId = status.resultRef?.documentId as string
    expect(newId).toBeTruthy()
    const created = getDocument(db, newId)
    expect(created?.status).toBe('indexed')
    expect(created?.chunkCount).toBeGreaterThan(0)
    expect(created?.title).toBe('Comparison: a vs b.md')
    expect(created?.origin).toEqual({ type: 'compare', comparedFrom: [a, b] })
    expect(getDocumentOrigin(db, newId)).toEqual({ type: 'compare', comparedFrom: [a, b] })
    const { text } = readStoredDocumentText(db, storeDir, newId)
    expect(text.startsWith(`> ${compareAttributionLine('scripted-model')}`)).toBe(true)
    expect(text).toContain(REPORT)
    expect(text).not.toContain('covers the beginning')

    // Audit: ids-only completion with BOTH source ids + the import of the report.
    const events = listAuditEvents(db, { limit: 100 })
    const completed = events.find((e) => e.type === 'document_task_completed')
    expect(completed?.metadata).toEqual({ kind: 'compare', documentId: a, documentIdB: b })
    const imported = events.find((e) => e.type === 'document_imported')
    expect(imported?.metadata).toMatchObject({ documentId: newId, status: 'indexed' })

    // No transient survived.
    expect(readdirSync(storeDir).filter((n) => n.includes('.parse'))).toHaveLength(0)
  })

  it('mode (a) needs NO vectors — two small docs without an embedder still compare', async () => {
    const a = await importDoc(80, 'a.txt', 'alpha')
    const b = await importDoc(80, 'b.txt', 'beta')
    const manager = makeManager({ runtime: scriptedRuntime() })
    const status = await runCompare(manager, a, b)
    expect(status.state).toBe('done')
  })
})

describe('the mode switch (token math boundary)', () => {
  it('exactly at the budget stays single-pass; one word over switches to section-matched', async () => {
    const ctx = 1024
    const budget = compareBudgetWords(ctx) // 200 at the floor
    const embedder = createMockEmbedder()
    const deps = (): IngestionDeps => ({ embedder: createMockEmbedder() })

    // wordsA + wordsB == budget → mode (a): exactly one model call.
    const half = Math.floor(budget / 2)
    const a1 = await importDoc(half, 'a1.txt', 'alpha', { embedder })
    const b1 = await importDoc(budget - half, 'b1.txt', 'beta', { embedder })
    const rt1 = scriptedRuntime()
    const status1 = await runCompare(
      makeManager({ runtime: rt1, contextTokens: ctx, ingestionDeps: deps }),
      a1,
      b1
    )
    expect(status1.state).toBe('done')
    expect(rt1.calls).toHaveLength(1)
    expect(promptOf(rt1.calls[0])).toContain('Compare document A')

    // One word more → mode (b): map call(s) + a reduce.
    const a2 = await importDoc(half + 1, 'a2.txt', 'gamma', { embedder })
    const b2 = await importDoc(budget - half, 'b2.txt', 'delta', { embedder })
    const rt2 = scriptedRuntime()
    const status2 = await runCompare(
      makeManager({ runtime: rt2, contextTokens: ctx, ingestionDeps: deps }),
      a2,
      b2
    )
    expect(status2.state).toBe('done')
    expect(rt2.calls.length).toBeGreaterThan(1)
    expect(promptOf(rt2.calls[0])).toContain('section by section')
    expect(promptOf(rt2.calls[rt2.calls.length - 1])).toContain('comparison notes')
  })
})

describe('mode (b) — section-matched compare (vectors + map/reduce)', () => {
  it('pairs each A window with retrieved doc-B excerpts; pairing is deterministic', async () => {
    const ctx = 1024
    const embedder = createMockEmbedder()
    const a = await importDoc(150, 'a.txt', 'alpha', { embedder })
    const b = await importDoc(150, 'b.txt', 'beta', { embedder })
    const deps = (): IngestionDeps => ({ embedder: createMockEmbedder() })

    const run = async (): Promise<string[]> => {
      const rt = scriptedRuntime()
      const status = await runCompare(
        makeManager({ runtime: rt, contextTokens: ctx, ingestionDeps: deps }),
        a,
        b
      )
      expect(status.state).toBe('done')
      return rt.calls.map(promptOf)
    }

    const first = await run()
    const mapPrompts = first.slice(0, -1)
    expect(mapPrompts.length).toBeGreaterThanOrEqual(1)
    for (const p of mapPrompts) {
      // Each map call shows an A window and B excerpts retrieved from doc B only.
      expect(p).toContain('Section of document A:')
      expect(p).toContain('Related excerpts of document B:')
      const bSide = p.slice(p.indexOf('Related excerpts of document B:'))
      expect(bSide).toContain('beta')
      expect(bSide).not.toContain('alpha')
    }
    // The reduce merges the notes into the report shape.
    expect(first[first.length - 1]).toContain('comparison notes')

    // Determinism: a second identical run produces byte-identical prompts
    // (stored-vector pairing — no re-embedding, stable tie-breaks).
    const second = await run()
    expect(second).toEqual(first)
  })

  it('caps the map calls at the ceiling and adds the honest truncation notice', async () => {
    const ctx = 1024
    const embedder = createMockEmbedder()
    // ~1640 words of chunk text → far more A windows than the ceiling permits.
    const a = await importDoc(1400, 'a.txt', 'alpha', { embedder })
    const b = await importDoc(150, 'b.txt', 'beta', { embedder })
    const rt = scriptedRuntime()
    const status = await runCompare(
      makeManager({
        runtime: rt,
        contextTokens: ctx,
        ingestionDeps: () => ({ embedder: createMockEmbedder() })
      }),
      a,
      b
    )
    expect(status.state).toBe('done')
    expect(rt.calls).toHaveLength(COMPARE_MAP_CALL_CEILING + 1) // capped maps + reduce
    expect(status.progress.stepsTotal).toBe(COMPARE_MAP_CALL_CEILING + 2)
    const { text } = readStoredDocumentText(db, storeDir, status.resultRef?.documentId as string)
    expect(text).toContain(compareTruncationNotice('a.txt'))
  })

  it('fails friendly when either document is invisible to the active embedder (stale vectors)', async () => {
    const ctx = 1024
    // Vectors exist, but under a LEGACY embedder id — the active (mock) embedder
    // cannot see them, so the pairing would silently come up empty. Fail friendly.
    const legacy: Embedder = {
      id: 'legacy-embedder',
      dimensions: 4,
      embed: async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0, 0]))
    }
    const a = await importDoc(150, 'a.txt', 'alpha', { embedder: legacy })
    const b = await importDoc(150, 'b.txt', 'beta', { embedder: legacy })
    const rt = scriptedRuntime()
    const status = await runCompare(
      makeManager({
        runtime: rt,
        contextTokens: ctx,
        ingestionDeps: () => ({ embedder: createMockEmbedder() })
      }),
      a,
      b
    )
    expect(status.state).toBe('failed')
    expect(status.error).toBe(TASK_COMPARE_REINDEX_MESSAGE)
    expect(rt.calls).toHaveLength(0) // failed BEFORE any model call
    expect(listDocuments(db)).toHaveLength(2) // nothing materialized

    // Same answer when the documents have no vectors at all.
    const c = await importDoc(150, 'c.txt', 'gamma')
    const d = await importDoc(150, 'd.txt', 'delta')
    const status2 = await runCompare(
      makeManager({
        runtime: scriptedRuntime(),
        contextTokens: ctx,
        ingestionDeps: () => ({ embedder: createMockEmbedder() })
      }),
      c,
      d
    )
    expect(status2.state).toBe('failed')
    expect(status2.error).toBe(TASK_COMPARE_REINDEX_MESSAGE)
  })
})

describe('cancellation persists nothing', () => {
  it('cancel mid-compare leaves no output document and no transient files', async () => {
    const a = await importDoc(600, 'a.txt', 'alpha')
    const b = await importDoc(600, 'b.txt', 'beta')
    const runtime = scriptedRuntime({ tokenDelayMs: 5 })
    const manager = makeManager({ runtime })
    const { jobId } = manager.startDocTask({ kind: 'compare', documentIds: [a, b] })
    const start = Date.now()
    while (manager.getDocTask(jobId).state !== 'running' || runtime.calls.length === 0) {
      if (Date.now() - start > 5000) throw new Error('task never started')
      await new Promise((r) => setTimeout(r, 5))
    }
    manager.cancelDocTask(jobId)
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('cancelled')
    expect(listDocuments(db)).toHaveLength(2) // the two sources only
    expect(readdirSync(storeDir).filter((n) => n.includes('.parse'))).toHaveLength(0)
  })
})

describe('the Phase-32 lease (held around exactly the materialize step)', () => {
  it('acquires the lease AFTER the model call(s), releases it after import', async () => {
    const a = await importDoc(80, 'a.txt', 'alpha')
    const b = await importDoc(80, 'b.txt', 'beta')
    const runtime = scriptedRuntime()
    let acquired = 0
    let released = 0
    let callsAtAcquire = -1
    const manager = makeManager({
      runtime,
      beginDocumentWork: () => {
        acquired += 1
        callsAtAcquire = runtime.calls.length
        return () => {
          released += 1
        }
      }
    })
    const status = await runCompare(manager, a, b)
    expect(status.state).toBe('done')
    expect(acquired).toBe(1)
    expect(released).toBe(1)
    expect(callsAtAcquire).toBe(1) // mode (a): the single compare call had finished
  })
})
