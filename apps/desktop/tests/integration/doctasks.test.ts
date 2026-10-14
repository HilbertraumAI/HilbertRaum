import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createQueuedDocument,
  deleteDocument,
  getDocument,
  getDocumentSummary,
  listDocuments,
  reindexDocument
} from '../../src/main/services/ingestion'
import {
  DOC_TASK_MAX_TERMINAL_HISTORY,
  TASK_DOCUMENT_NOT_READY_MESSAGE,
  TASK_EXPIRED_MESSAGE,
  TASK_NEEDS_RUNTIME_MESSAGE,
  TASK_REFUSED_CHAT_STREAMING_MESSAGE,
  SUMMARY_MAP_CALL_CEILING,
  SUMMARY_TEMPERATURE
} from '../../src/main/services/doctasks'
import { listAuditEvents } from '../../src/main/services/audit'
import type { DocTaskKind } from '../../src/shared/types'
import { until } from '../helpers/hang-budget'
import {
  dbAudit,
  docTaskManager,
  docTaskRuntime,
  docTaskWorld,
  importWords,
  userPromptOf,
  waitTerminal,
  type DocRuntime,
  type DocTaskWorld
} from '../helpers/doctask-fixtures'
import { t } from '../../src/shared/i18n'

// Phase 33 — the document task engine (wave-3 plan §6): state machine (serialized
// queue, refuse-while-chat-streams, cancel mid-stream, runtime-absent friendly
// failure), the MockRuntime-style end-to-end summary, persistence + re-index
// invalidation + delete, and the ids-only audit events. CI posture: zero model, zero
// network — scripted fake runtimes drive every path.

let w: DocTaskWorld
beforeEach(() => {
  w = docTaskWorld('doctasks')
})

describe('end-to-end summary (single pass)', () => {
  it('summarizes a small document and persists { text, modelId, createdAt, truncated:false }', async () => {
    const docId = await importWords(w, 300)
    const runtime = docTaskRuntime()
    const manager = docTaskManager(w, { getRuntime: () => runtime, audit: dbAudit(w.db) })

    const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
    expect(['queued', 'running']).toContain(manager.getDocTask(jobId).state)

    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    expect(status.resultRef).toEqual({ documentId: docId })
    expect(status.progress).toEqual({ stepsDone: 1, stepsTotal: 1 })

    const summary = getDocumentSummary(w.db, docId)
    expect(summary?.text).toContain('concise summary')
    expect(summary?.modelId).toBe('scripted-model')
    expect(summary?.truncated).toBe(false)
    expect(Date.parse(summary?.createdAt ?? '')).not.toBeNaN()

    // The listing surface carries it too (what the renderer reads).
    const listed = listDocuments(w.db).find((d) => d.id === docId)
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
    const events = listAuditEvents(w.db, { limit: 100 })
    const completed = events.find((e) => e.type === 'document_task_completed')
    expect(completed?.metadata).toEqual({ kind: 'summary', documentId: docId })
  })

  it('strips think blocks from the produced summary (defense-in-depth, D6)', async () => {
    const docId = await importWords(w, 50)
    const runtime = docTaskRuntime({
      reply: () => '<think>secret chain of thought</think>The actual summary text here.'
    })
    const manager = docTaskManager(w, { getRuntime: () => runtime })
    const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    const summary = getDocumentSummary(w.db, docId)
    expect(summary?.text).toBe('The actual summary text here.')
    expect(summary?.text).not.toContain('chain of thought')
  })
})

describe('map-reduce path + the hard ceiling', () => {
  it('cuts over to map windows + one reduce when the text exceeds the budget', async () => {
    // contextTokens 1024 → word budget 200: a 700-word doc spans multiple windows.
    const docId = await importWords(w, 700)
    const runtime = docTaskRuntime({ reply: () => 'Partial summary.' })
    const manager = docTaskManager(w, { getRuntime: () => runtime, getContextTokens: () => 1024 })

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
    expect(getDocumentSummary(w.db, docId)?.truncated).toBe(false)
  })

  it('honours the map-call ceiling and flags the summary truncated', async () => {
    // 6000 words at a 200-word budget wants ~30 windows → capped at the ceiling.
    const docId = await importWords(w, 6000)
    const runtime = docTaskRuntime({ reply: () => 'Partial summary.' })
    const manager = docTaskManager(w, { getRuntime: () => runtime, getContextTokens: () => 1024 })

    const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    expect(runtime.calls).toHaveLength(SUMMARY_MAP_CALL_CEILING + 1)
    expect(getDocumentSummary(w.db, docId)?.truncated).toBe(true)
  })

  // #682: at a small window the 128-token map floor lets the partials outgrow the reduce input, so the reduce belt
  // cuts their joined text, and the cut always drops the END of the document (the partials run in document order).
  // The summary must say it covers the beginning, as compare's belt does (H8); it used to be stored as complete.
  it('flags the summary truncated when the reduce belt cuts the partials', async () => {
    // ctx 1024 → word budget 200 and a 128-token map floor: four ~98-word partials overflow the reduce input.
    const docId = await importWords(w, 700)
    let maps = 0
    const runtime = docTaskRuntime({
      tokens: 'whole',
      reply: (call) => {
        if (userPromptOf(call).includes('partial summaries')) return 'The final summary.'
        maps += 1
        // A model writing up to its cap: maxTokens ÷ 1.3 words, each tagged with its partial and position.
        const words = Math.floor((call.options?.maxTokens ?? 0) / 1.3)
        return Array.from({ length: words }, (_, i) => `P${maps}w${i}`).join(' ')
      }
    })
    const manager = docTaskManager(w, { getRuntime: () => runtime, getContextTokens: () => 1024 })

    const status = await waitTerminal(manager, manager.startDocTask({ kind: 'summary', documentIds: [docId] }).jobId)
    expect(status.state).toBe('done')
    expect(maps).toBeGreaterThanOrEqual(3) // under the map ceiling: only the belt can cut
    const reduce = userPromptOf(runtime.calls[runtime.calls.length - 1])
    expect(reduce).toContain('P1w0') // the beginning reached the reduce…
    expect(reduce).not.toContain(`P${maps}w0`) // …the last partial did not
    expect(getDocumentSummary(w.db, docId)?.truncated).toBe(true)
  })
})

describe('state machine guards (D26)', () => {
  it('refuses to start while a chat answer is streaming', async () => {
    const docId = await importWords(w, 50)
    const runtime = docTaskRuntime()
    const manager = docTaskManager(w, { getRuntime: () => runtime, isChatStreaming: () => true })
    expect(() => manager.startDocTask({ kind: 'summary', documentIds: [docId] })).toThrow(
      TASK_REFUSED_CHAT_STREAMING_MESSAGE
    )
  })

  it.each([
    ['no model is running', false, TASK_NEEDS_RUNTIME_MESSAGE],
    ['a model is starting — says so (#599)', true, t('en', 'main.modelStarting')]
  ])('refuses to start with no runtime (never auto-starts one): %s', async (_label, modelStarting, message) => {
    const docId = await importWords(w, 50)
    const manager = docTaskManager(w, { isModelStarting: () => modelStarting })
    expect(() => manager.startDocTask({ kind: 'summary', documentIds: [docId] })).toThrow(message)
  })

  it.each([
    ['stopped', false, TASK_NEEDS_RUNTIME_MESSAGE],
    // #599: a crash restart (or a switch) is under way — the friendly filter keeps this copy too.
    ['restarting', true, t('en', 'main.modelStarting')]
  ])('fails friendly when the runtime is %s while the task is queued', async (_label, modelStarting, message) => {
    const doc1 = await importWords(w, 50, { name: 'a.txt' })
    const doc2 = await importWords(w, 50, { name: 'b.txt' })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let runtime: DocRuntime | null = docTaskRuntime({ gate: () => gate })
    const manager = docTaskManager(w, {
      getRuntime: () => runtime,
      isModelStarting: () => runtime == null && modelStarting
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
    expect(failed.error).toBe(message)
  })

  it('serializes tasks: one queue, never two model calls in flight', async () => {
    const doc1 = await importWords(w, 60, { name: 'a.txt' })
    const doc2 = await importWords(w, 60, { name: 'b.txt' })
    const runtime = docTaskRuntime({ tokenDelayMs: 1 })
    const manager = docTaskManager(w, { getRuntime: () => runtime })

    const first = manager.startDocTask({ kind: 'summary', documentIds: [doc1] })
    const second = manager.startDocTask({ kind: 'summary', documentIds: [doc2] })
    expect(manager.hasActiveTask()).toBe(true)
    expect(manager.getDocTask(second.jobId).state).toBe('queued')

    expect((await waitTerminal(manager, first.jobId)).state).toBe('done')
    expect((await waitTerminal(manager, second.jobId)).state).toBe('done')
    expect(runtime.maxConcurrent).toBe(1)
    expect(manager.hasActiveTask()).toBe(false)
    expect(getDocumentSummary(w.db, doc1)).toBeTruthy()
    expect(getDocumentSummary(w.db, doc2)).toBeTruthy()
  })

  it('cancels a RUNNING task mid-stream: state cancelled, nothing persisted, no audit event', async () => {
    const docId = await importWords(w, 300)
    const runtime = docTaskRuntime({ tokenDelayMs: 25 })
    const manager = docTaskManager(w, { getRuntime: () => runtime, audit: dbAudit(w.db) })

    const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
    // DX-6 (Phase 7): poll (bounded) until the model stream is actively running (chatStream
    // entered its loop → concurrent>0) instead of a fixed 40 ms "let it start" sleep, then cancel
    // mid-generation. The scripted stream parks in its per-token delay honouring the abort signal,
    // so the cancel lands while a generation is genuinely in flight (not before start / after done).
    await until(() => runtime.concurrent > 0, 'the summary stream to start')
    manager.cancelDocTask(jobId)

    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('cancelled')
    expect(getDocumentSummary(w.db, docId)).toBeNull()
    const types = listAuditEvents(w.db, { limit: 100 }).map((e) => e.type)
    expect(types).not.toContain('document_task_completed')
    expect(types).not.toContain('document_task_failed')
  })

  it('cancels a QUEUED task without running it; no-arg cancel hits the active task', async () => {
    const doc1 = await importWords(w, 50, { name: 'a.txt' })
    const doc2 = await importWords(w, 50, { name: 'b.txt' })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const runtime = docTaskRuntime({ gate: () => gate, tokenDelayMs: 5 })
    const manager = docTaskManager(w, { getRuntime: () => runtime })

    const first = manager.startDocTask({ kind: 'summary', documentIds: [doc1] })
    const second = manager.startDocTask({ kind: 'summary', documentIds: [doc2] })

    manager.cancelDocTask(second.jobId) // queued → dequeued immediately
    expect(manager.getDocTask(second.jobId).state).toBe('cancelled')
    // #682: the cancelled task frees its document at once, so re-index and delete work again
    // without waiting for the running task; that one still holds its own.
    expect(manager.isDocumentBusy(doc2)).toBe(false)
    expect(manager.isDocumentBusy(doc1)).toBe(true)

    manager.cancelDocTask() // no jobId → the running task
    release()
    expect((await waitTerminal(manager, first.jobId)).state).toBe('cancelled')
    expect(manager.hasActiveTask()).toBe(false)
  })

  it('rejects not-ready documents and unknown kinds', async () => {
    const runtime = docTaskRuntime()
    const manager = docTaskManager(w, { getRuntime: () => runtime })
    // Unknown document.
    expect(() => manager.startDocTask({ kind: 'summary', documentIds: ['nope'] })).toThrow(
      TASK_DOCUMENT_NOT_READY_MESSAGE
    )
    // A queued (not yet indexed) document.
    const p = join(w.root, 'pending.txt')
    writeFileSync(p, 'hello world', 'utf8')
    const queued = createQueuedDocument(w.db, p)
    expect(() => manager.startDocTask({ kind: 'summary', documentIds: [queued.id] })).toThrow(
      TASK_DOCUMENT_NOT_READY_MESSAGE
    )
    // Kind validation. (Translation shipped in Phase 34, compare in Phase 35 — see
    // doctasks-translation.test.ts / doctasks-compare.test.ts.)
    expect(() =>
      manager.startDocTask({ kind: 'nonsense' as unknown as DocTaskKind, documentIds: ['x'] })
    ).toThrow('Unknown document task.')
  })

  it('reports unknown job ids as terminal so pollers stop', () => {
    const runtime = docTaskRuntime()
    const manager = docTaskManager(w, { getRuntime: () => runtime })
    const status = manager.getDocTask('never-existed')
    expect(status.state).toBe('failed')
    expect(status.error).toBe(TASK_EXPIRED_MESSAGE)
  })

  it('records the ids-only failure audit event on a crashing model call', async () => {
    const docId = await importWords(w, 50)
    const runtime = docTaskRuntime()
    runtime.chatStream = async function* () {
      yield 'a'
      throw new Error('HTTP 500 from llama-server: secret internal details')
    }
    const manager = docTaskManager(w, { getRuntime: () => runtime, audit: dbAudit(w.db) })
    const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('failed')
    // Friendly copy, never the raw error.
    expect(status.error).not.toContain('HTTP 500')
    expect(status.error).toMatch(/try again/i)
    const events = listAuditEvents(w.db, { limit: 100 })
    const failed = events.find((e) => e.type === 'document_task_failed')
    expect(failed?.metadata).toEqual({ kind: 'summary', documentId: docId })
    expect(JSON.stringify(events)).not.toContain('HTTP 500')
  })

  it('flags the busy document while a task is active (isDocumentBusy)', async () => {
    const docId = await importWords(w, 100)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const runtime = docTaskRuntime({ gate: () => gate })
    const manager = docTaskManager(w, { getRuntime: () => runtime })
    const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
    expect(manager.isDocumentBusy(docId)).toBe(true)
    expect(manager.isDocumentBusy('other')).toBe(false)
    release()
    await waitTerminal(manager, jobId)
    expect(manager.isDocumentBusy(docId)).toBe(false)
  })
})

describe('summary persistence lifecycle (D25)', () => {
  it('re-index clears the summary (content may have changed); delete removes it with the document row', async () => {
    const docId = await importWords(w, 100)
    const runtime = docTaskRuntime()
    const manager = docTaskManager(w, { getRuntime: () => runtime })
    const summarize = async (): Promise<void> => {
      const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
      expect((await waitTerminal(manager, jobId)).state).toBe('done')
      expect(getDocumentSummary(w.db, docId)).toBeTruthy()
    }
    await summarize()
    const info = await reindexDocument(w.db, w.storeDir, docId)
    expect(info.status).toBe('indexed')
    expect(getDocumentSummary(w.db, docId)).toBeNull()
    expect(getDocument(w.db, docId)?.summary ?? null).toBeNull()

    await summarize() // a fresh summary right before the delete, so the delete leg has one to remove
    deleteDocument(w.db, w.storeDir, docId)
    expect(getDocument(w.db, docId)).toBeNull()
    expect(getDocumentSummary(w.db, docId)).toBeNull()
  })

  it('a malformed stored summary reads as null instead of breaking the listing', async () => {
    const docId = await importWords(w, 50)
    w.db.prepare('UPDATE documents SET summary_json = ? WHERE id = ?').run('{not json', docId)
    expect(getDocumentSummary(w.db, docId)).toBeNull()
    expect(listDocuments(w.db).find((d) => d.id === docId)?.summary ?? null).toBeNull()
  })
})

// L11 — the tasks map is bounded (no session-long growth), and an evicted task's poll echoes
// the REAL kind (never the old hardcoded `summary` fallback).
describe('terminal-task eviction + kind recovery (L11)', () => {
  it('evicts the oldest terminal tasks past the history cap and keeps recent ones', async () => {
    const docId = await importWords(w, 100)
    const runtime = docTaskRuntime()
    const manager = docTaskManager(w, { getRuntime: () => runtime })

    const jobIds: string[] = []
    // Run one more task than the cap allows, serially (await each to terminal).
    for (let i = 0; i < DOC_TASK_MAX_TERMINAL_HISTORY + 1; i++) {
      const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
      await waitTerminal(manager, jobId)
      jobIds.push(jobId)
    }

    // The very first task has been evicted → its poll reports the terminal expired fallback…
    const first = manager.getDocTask(jobIds[0])
    expect(first.state).toBe('failed')
    expect(first.error).toBe(TASK_EXPIRED_MESSAGE)
    // …but its kind is RECOVERED (a summary here — not a lie either way), and the most recent
    // task is still fully tracked with its real terminal state.
    expect(first.kind).toBe('summary')
    expect(manager.getDocTask(jobIds[jobIds.length - 1]).state).toBe('done')

    // The manager stays fully usable after eviction.
    const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
    expect((await waitTerminal(manager, jobId)).state).toBe('done')
  })

  it('an evicted NON-summary task keeps its real kind on a late poll (not a false summary)', async () => {
    const docId = await importWords(w, 100)
    const runtime = docTaskRuntime()
    const manager = docTaskManager(w, { getRuntime: () => runtime })

    // A running summary keeps the categorize task QUEUED; cancelling it while queued lands a
    // terminal `cancelled` of kind `categorize` WITHOUT running the handler — deterministic.
    const running = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
    const categorize = manager.startDocTask({ kind: 'categorize', documentIds: [docId] })
    manager.cancelDocTask(categorize.jobId)
    expect(manager.getDocTask(categorize.jobId).state).toBe('cancelled')
    expect(manager.getDocTask(categorize.jobId).kind).toBe('categorize')
    await waitTerminal(manager, running.jobId)

    // Push the categorize task out of the (bounded) tasks map.
    for (let i = 0; i < DOC_TASK_MAX_TERMINAL_HISTORY; i++) {
      const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
      await waitTerminal(manager, jobId)
    }

    const evicted = manager.getDocTask(categorize.jobId)
    expect(evicted.state).toBe('failed') // the expired fallback
    expect(evicted.error).toBe(TASK_EXPIRED_MESSAGE)
    expect(evicted.kind).toBe('categorize') // recovered — NOT the old hardcoded 'summary'
  })
})
