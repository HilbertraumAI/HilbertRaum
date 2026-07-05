import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  documentsDir,
  getDocument,
  getDocumentOrigin,
  listDocuments,
  processDocument,
  readStoredDocumentText,
  reindexDocument,
  type IngestionDeps
} from '../../src/main/services/ingestion'
import {
  DocTaskManager,
  TASK_GENERIC_FAILURE_MESSAGE,
  TASK_TRANSLATION_NO_MODEL_MESSAGE,
  TASK_TRANSLATION_TARGET_MESSAGE,
  failedWindowNotice,
  translationAttributionLine,
  translationBudgetWords,
  type DocTaskDeps
} from '../../src/main/services/doctasks'
import type { Translator } from '../../src/main/services/translation'
import type { TranslateOptions } from '../../src/main/services/translation'
import {
  VaultBusyError,
  decryptFile,
  encryptFile,
  decryptFileAsync,
  encryptFileAsync,
  type DocumentCipher
} from '../../src/main/services/workspace-vault'
import { recordEvent, listAuditEvents } from '../../src/main/services/audit'
import {
  addToCollection,
  createCollection,
  getBuiltinCollection
} from '../../src/main/services/collections'
import type { AuditEventType, GeneratedProvenance } from '../../src/shared/types'
import type { Embedder } from '../../src/main/services/embeddings'
import type { ModelRuntime } from '../../src/main/services/runtime'

// Phase 34 — the translation document task (wave-3 plan §7, decisions D27 + D36), REROUTED at
// TG-3 (translategemma plan §2 D3/D9): translation runs on the TranslateGemma SIDECAR (a
// `Translator` injected via `DocTaskDeps.getTranslator`), never the chat runtime. Covered here:
// param/kind validation over the widened 10-language set (source + target, both server-side),
// the D3 guards (no-translation-model refusal even WITH a chat model; success with NO chat
// model), the segments-not-chunks input (the D36 overlap regression), window ordering +
// stitching against the SIDECAR's context window, sourceLang/targetLang plumbed into every
// sidecar call, the R-T2 retry-then-mark policy, the materialized import end-to-end (plaintext
// AND encrypted), origin_json provenance stamped with the TRANSLATION model's id, the Phase-32
// lease held around exactly the materialize step, cancel-persists-nothing, the busy-document
// guard covering the freshly created output document, and the ids-only audit events. CI
// posture: zero model, zero network — scripted translators throughout.

let tmp: string
let db: Db
let storeDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hilbertraum-doctr-'))
  db = openDatabase(join(tmp, 'test.sqlite'))
  storeDir = documentsDir(join(tmp, 'workspace'))
})

/** Import a .txt of `words` unique whitespace words through the REAL ingestion pipeline. */
async function importDoc(
  words: number,
  name = 'doc.txt',
  deps: IngestionDeps = {}
): Promise<string> {
  const text = Array.from({ length: words }, (_, i) => `word${i}`).join(' ')
  const p = join(tmp, name)
  writeFileSync(p, text, 'utf8')
  const info = createQueuedDocument(db, p)
  const done = await processDocument(db, storeDir, info.id, deps)
  expect(done.status).toBe('indexed')
  return info.id
}

interface ScriptedTranslatorOptions {
  /** Reply per call; throwing fails that call. Default: a perfect echo translator. */
  reply?: (call: TranslateOptions, index: number) => string
  /** The sidecar's launched context window (`contextWindow()`). Default 4096 (the manifest). */
  contextTokens?: number
  /** Delay (ms) before each streamed token — lets cancel land mid-window. */
  tokenDelayMs?: number
}

interface ScriptedTranslator extends Translator {
  calls: TranslateOptions[]
}

/**
 * A scripted Translator (the TG-3 sidecar seam). The default reply is a "perfect
 * translator": it returns the window text verbatim, so the stitched output is
 * byte-comparable to the source — exactly what the D36 regression needs.
 */
function scriptedTranslator(opts: ScriptedTranslatorOptions = {}): ScriptedTranslator {
  const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      const t = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(t)
        resolve()
      })
    })
  const translator: ScriptedTranslator = {
    modelId: 'scripted-translator',
    calls: [],
    contextWindow: () => opts.contextTokens ?? 4096,
    stop: async () => {},
    async translate(call: TranslateOptions): Promise<string> {
      const index = translator.calls.length
      translator.calls.push(call)
      const text = opts.reply ? opts.reply(call, index) : call.text
      if (opts.tokenDelayMs) {
        for (const token of text.match(/\S+\s*/g) ?? [text]) {
          // The real runtime rejects on abort; a clean return exercises the handler's
          // aborted-normalization the same way the old mock chat runtime did.
          if (call.signal?.aborted) return ''
          await delay(opts.tokenDelayMs, call.signal)
          call.onToken?.(token)
        }
      }
      return text
    }
  }
  return translator
}

/** A chat runtime that PROVES the reroute: translation must never touch `chatStream`. */
function stubChatRuntime(): ModelRuntime {
  return {
    modelId: 'chat-model',
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(): AsyncGenerator<string> {
      throw new Error('translation must never call the chat runtime')
    }
  }
}

interface ManagerOptions {
  translator?: Translator | null
  runtime?: ModelRuntime | null
  contextTokens?: number
  audit?: boolean
  ingestionDeps?: () => IngestionDeps
  beginDocumentWork?: DocTaskDeps['beginDocumentWork']
}

function makeManager(opts: ManagerOptions = {}): DocTaskManager {
  return new DocTaskManager({
    getDb: () => db,
    // Translation ignores the chat runtime since TG-3 — most tests here run WITHOUT one
    // (the O2 "chat model absent" posture); the guard test injects one explicitly.
    getRuntime: () => (opts.runtime === undefined ? null : opts.runtime),
    getTranslator: () => (opts.translator === undefined ? null : opts.translator),
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

/** A cipher equivalent to the unlocked vault's (fixed key) — the encrypted-docs pattern. */
function testCipher(): DocumentCipher {
  const key = randomBytes(32)
  return {
    encryptFile: (src, dest) => encryptFile(src, dest, key),
    decryptFile: (src, dest) => decryptFile(src, dest, key),
    encryptFileAsync: (src, dest) => encryptFileAsync(src, dest, key),
    decryptFileAsync: (src, dest) => decryptFileAsync(src, dest, key)
  }
}

describe('validation (kind + params, the widened 10-language set)', () => {
  it('refuses missing/invalid/same source+target languages with friendly copy', async () => {
    const docId = await importDoc(50)
    const manager = makeManager({ translator: scriptedTranslator() })
    // No params at all.
    expect(() => manager.startDocTask({ kind: 'translation', documentIds: [docId] })).toThrow(
      TASK_TRANSLATION_TARGET_MESSAGE
    )
    // Target without the (required) source — TranslateGemma has no auto-detect.
    expect(() =>
      manager.startDocTask({
        kind: 'translation',
        documentIds: [docId],
        params: { targetLang: 'de' }
      })
    ).toThrow(TASK_TRANSLATION_TARGET_MESSAGE)
    // A code outside the curated set.
    expect(() =>
      manager.startDocTask({
        kind: 'translation',
        documentIds: [docId],
        params: { sourceLang: 'xx', targetLang: 'de' }
      })
    ).toThrow(TASK_TRANSLATION_TARGET_MESSAGE)
    expect(() =>
      manager.startDocTask({
        kind: 'translation',
        documentIds: [docId],
        params: { sourceLang: 'de', targetLang: 'ja' }
      })
    ).toThrow(TASK_TRANSLATION_TARGET_MESSAGE)
    // Same language on both ends — a multi-gigabyte no-op, refused.
    expect(() =>
      manager.startDocTask({
        kind: 'translation',
        documentIds: [docId],
        params: { sourceLang: 'de', targetLang: 'de' }
      })
    ).toThrow(TASK_TRANSLATION_TARGET_MESSAGE)
  })

  it('accepts the widened codes beyond de/en (fr→uk runs to done)', async () => {
    const docId = await importDoc(30)
    const translator = scriptedTranslator()
    const manager = makeManager({ translator })
    const { jobId } = manager.startDocTask({
      kind: 'translation',
      documentIds: [docId],
      params: { sourceLang: 'fr', targetLang: 'uk' }
    })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    expect(translator.calls[0]).toMatchObject({ sourceLang: 'fr', targetLang: 'uk' })
    // The materialized title carries the target's native name.
    const created = getDocument(db, status.resultRef?.documentId as string)
    expect(created?.title).toBe('doc (Українська).md')
  })

  it('requires exactly one source document', async () => {
    const a = await importDoc(50, 'a.txt')
    const b = await importDoc(50, 'b.txt')
    const manager = makeManager({ translator: scriptedTranslator() })
    expect(() =>
      manager.startDocTask({
        kind: 'translation',
        documentIds: [a, b],
        params: { sourceLang: 'en', targetLang: 'de' }
      })
    ).toThrow('Pick exactly one document to translate.')
    expect(() =>
      manager.startDocTask({
        kind: 'translation',
        documentIds: [],
        params: { sourceLang: 'en', targetLang: 'de' }
      })
    ).toThrow('Pick exactly one document to translate.')
  })
})

describe('the D3 guards (TG-3): the translation model, not the chat runtime', () => {
  it('refuses to start without the translation model — even with a chat model running', async () => {
    const docId = await importDoc(50)
    const manager = makeManager({ translator: null, runtime: stubChatRuntime() })
    expect(() =>
      manager.startDocTask({
        kind: 'translation',
        documentIds: [docId],
        params: { sourceLang: 'en', targetLang: 'de' }
      })
    ).toThrow(TASK_TRANSLATION_NO_MODEL_MESSAGE)
  })

  it('runs to done with NO chat model, and never calls a chat runtime that IS present', async () => {
    const docId = await importDoc(50)
    // A translator + a booby-trapped chat runtime: chatStream throws if ever touched.
    const translator = scriptedTranslator()
    const manager = makeManager({ translator, runtime: stubChatRuntime() })
    const { jobId } = manager.startDocTask({
      kind: 'translation',
      documentIds: [docId],
      params: { sourceLang: 'de', targetLang: 'en' }
    })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    expect(translator.calls.length).toBeGreaterThan(0)
  })

  it('fails friendly when the translator disappears while QUEUED (quit teardown re-check)', async () => {
    const a = await importDoc(60, 'a.txt')
    const b = await importDoc(60, 'b.txt')
    // Slow enough that task B is still queued when the sidecar "stops" (quit teardown).
    let available: Translator | null = scriptedTranslator({ tokenDelayMs: 5 })
    const manager = new DocTaskManager({
      getDb: () => db,
      getRuntime: () => null,
      getTranslator: () => available,
      isChatStreaming: () => false,
      getContextTokens: () => 4096,
      getStoreDir: () => storeDir,
      getIngestionDeps: () => ({}),
      beginDocumentWork: () => () => {}
    })
    const first = manager.startDocTask({
      kind: 'translation',
      documentIds: [a],
      params: { sourceLang: 'en', targetLang: 'de' }
    })
    const second = manager.startDocTask({
      kind: 'translation',
      documentIds: [b],
      params: { sourceLang: 'en', targetLang: 'de' }
    })
    available = null // quit stops the sidecar while B waits in the FIFO
    // A captured its translator at ITS dequeue and completes; B re-checks at dequeue
    // time and fails with the friendly install copy — never a raw error.
    expect((await waitTerminal(manager, first.jobId)).state).toBe('done')
    const statusB = await waitTerminal(manager, second.jobId)
    expect(statusB.state).toBe('failed')
    expect(statusB.error).toBe(TASK_TRANSLATION_NO_MODEL_MESSAGE)
  })
})

describe('end-to-end translation (the D36 overlap regression + stitching)', () => {
  it('materializes ONE new indexed document: segments in order, no duplicated overlap text', async () => {
    // 600 unique words: more than one 500-token chunk, so the STORED chunks overlap by
    // ~80 tokens (words 420–499 appear in BOTH chunk rows). The translation must read
    // the parser's segments instead — every word appears exactly once in the output.
    const docId = await importDoc(600)
    // The SIDECAR's context (1024) drives the window budget — deps.getContextTokens (the
    // chat window) is deliberately different (4096) and must be ignored since TG-3.
    const translator = scriptedTranslator({ contextTokens: 1024 })
    const manager = makeManager({ translator, contextTokens: 4096, audit: true })

    const { jobId } = manager.startDocTask({
      kind: 'translation',
      documentIds: [docId],
      params: { sourceLang: 'en', targetLang: 'de' }
    })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')

    // Multiple windows ran (600 words > the 1024-context budget) + materialize.
    const budget = translationBudgetWords(1024)
    const expectedWindows = Math.ceil(600 / budget)
    expect(translator.calls.length).toBe(expectedWindows)
    expect(status.progress.stepsTotal).toBe(expectedWindows + 1)
    expect(status.progress.stepsDone).toBe(status.progress.stepsTotal)

    // Every sidecar call carried the chosen language pair + the plan's output cap.
    for (const call of translator.calls) {
      expect(call.sourceLang).toBe('en')
      expect(call.targetLang).toBe('de')
      expect(call.maxTokens).toBeGreaterThan(0)
      expect(call.signal).toBeDefined()
    }

    // The result is a NEW document, indexed with chunks, named "<original> (Deutsch)".
    const newId = status.resultRef?.documentId as string
    expect(newId).toBeTruthy()
    expect(newId).not.toBe(docId)
    const created = getDocument(db, newId)
    expect(created?.status).toBe('indexed')
    expect(created?.chunkCount).toBeGreaterThan(0)
    expect(created?.title).toBe('doc (Deutsch).md')

    // Windows were sent in document order (window 1 starts at word0).
    const firstWords = translator.calls.map((c) => c.text.split(/\s+/)[0])
    expect(firstWords[0]).toBe('word0')
    const starts = firstWords.map((w) => Number(w.replace('word', '')))
    expect([...starts].sort((x, y) => x - y)).toEqual(starts)

    // Stored output: attribution line (the TRANSLATION model's id) + the stitched translation.
    const { text } = readStoredDocumentText(db, storeDir, newId)
    expect(text.startsWith(`> ${translationAttributionLine('scripted-translator')}`)).toBe(true)
    const body = text.slice(text.indexOf('\n\n') + 2)
    const tokens = body.split(/\s+/).filter((t) => t.length > 0)
    // THE D36 regression: every source word exactly once — chunk concatenation would
    // duplicate the words inside the ~80-token overlap (e.g. word450).
    expect(tokens).toHaveLength(600)
    expect(tokens.filter((t) => t === 'word450')).toHaveLength(1)
    expect(tokens.filter((t) => t === 'word480')).toHaveLength(1)
    // …and in the original order.
    expect(tokens).toEqual(Array.from({ length: 600 }, (_, i) => `word${i}`))

    // Provenance round-trip (Phase D: structured GeneratedProvenance — kind + source id +
    // the TRANSLATION model; no sourceCollectionIds because this source is filed nowhere).
    const expectedOrigin = {
      kind: 'translation',
      sourceDocumentIds: [docId],
      modelId: 'scripted-translator',
      createdAt: expect.any(String)
    }
    expect(created?.origin).toEqual(expectedOrigin)
    expect(getDocumentOrigin(db, newId)).toEqual(expectedOrigin)

    // Audit: ids-only document_task_completed (with the SOURCE id) + a
    // document_imported for the materialized document.
    const events = listAuditEvents(db, { limit: 100 })
    const completed = events.find((e) => e.type === 'document_task_completed')
    expect(completed?.metadata).toEqual({ kind: 'translation', documentId: docId })
    const imported = events.find((e) => e.type === 'document_imported')
    expect(imported?.metadata).toMatchObject({ documentId: newId, status: 'indexed' })
    // S1 (full-audit-2026-06-30): the materialized output's title is CONTENT — the
    // message is a fixed string and must NOT carry the translated filename.
    expect(imported?.message).toBe('Document imported')
    expect(imported?.message).not.toContain('Deutsch')

    // The materialize transient is gone (shredded) — nothing `.parse*` lingers.
    expect(readdirSync(storeDir).filter((n) => n.includes('.parse'))).toHaveLength(0)
  })

  it('origin survives a re-index (provenance, not sync) and malformed origin_json reads as null', async () => {
    const docId = await importDoc(60)
    const manager = makeManager({ translator: scriptedTranslator() })
    const { jobId } = manager.startDocTask({
      kind: 'translation',
      documentIds: [docId],
      params: { sourceLang: 'de', targetLang: 'en' }
    })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    const newId = status.resultRef?.documentId as string

    // Re-index the translated document: chunks rebuild, origin stays.
    const reinfo = await reindexDocument(db, storeDir, newId)
    expect(reinfo.status).toBe('indexed')
    expect(getDocumentOrigin(db, newId)).toEqual({
      kind: 'translation',
      sourceDocumentIds: [docId],
      modelId: 'scripted-translator',
      createdAt: expect.any(String)
    })

    // Malformed origin_json must never break a listing — it reads as null.
    db.prepare('UPDATE documents SET origin_json = ? WHERE id = ?').run('{not json', newId)
    expect(getDocumentOrigin(db, newId)).toBeNull()
    expect(listDocuments(db).find((d) => d.id === newId)?.origin).toBeNull()
  })
})

describe('generated provenance + membership (Phase D — §15.1/§15.2, D3/N1)', () => {
  it('writes structured provenance, snapshots the SOURCE collections, and files NO membership', async () => {
    const docId = await importDoc(80, 'source.txt')
    // The SOURCE lives in Library + a project; the generated output must NOT inherit them.
    const lib = getBuiltinCollection(db, 'library')!
    const project = createCollection(db, 'Tax 2025')
    addToCollection(db, [docId], lib.id)
    addToCollection(db, [docId], project.id)

    const manager = makeManager({ translator: scriptedTranslator() })
    const { jobId } = manager.startDocTask({
      kind: 'translation',
      documentIds: [docId],
      params: { sourceLang: 'en', targetLang: 'de' }
    })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    const newId = status.resultRef?.documentId as string

    // Structured provenance persisted: kind + source id + model + a snapshot of the
    // source's collections at creation time (display/forward-use only).
    const origin = getDocumentOrigin(db, newId) as GeneratedProvenance
    expect(origin.kind).toBe('translation')
    expect(origin.sourceDocumentIds).toEqual([docId])
    expect(origin.modelId).toBe('scripted-translator')
    expect(origin.createdAt.length).toBeGreaterThan(0)
    expect([...(origin.sourceCollectionIds ?? [])].sort()).toEqual([lib.id, project.id].sort())

    // N1/D3: the generated row gets ZERO document_collections rows of its own — it is
    // structurally excluded from every collection-derived (Library/project) scope.
    const memberships = db
      .prepare('SELECT collection_id FROM document_collections WHERE document_id = ?')
      .all(newId) as unknown as Array<{ collection_id: string }>
    expect(memberships).toHaveLength(0)
    // The source keeps its memberships untouched.
    const sourceMemberships = db
      .prepare('SELECT collection_id FROM document_collections WHERE document_id = ?')
      .all(docId) as unknown as Array<{ collection_id: string }>
    expect(sourceMemberships.map((r) => r.collection_id).sort()).toEqual([lib.id, project.id].sort())
  })

  it('round-trips the new shape and STILL parses the old Translation/CompareOrigin shapes', async () => {
    const docId = await importDoc(40, 'rt.txt')

    // Old translation shape (pre-discriminator, no `type`) still parses unchanged.
    db.prepare('UPDATE documents SET origin_json = ? WHERE id = ?').run(
      JSON.stringify({ translatedFrom: 'src-1', targetLang: 'en' }),
      docId
    )
    expect(getDocumentOrigin(db, docId)).toEqual({
      type: 'translation',
      translatedFrom: 'src-1',
      targetLang: 'en'
    })
    // Old compare shape still parses.
    db.prepare('UPDATE documents SET origin_json = ? WHERE id = ?').run(
      JSON.stringify({ type: 'compare', comparedFrom: ['a', 'b'] }),
      docId
    )
    expect(getDocumentOrigin(db, docId)).toEqual({ type: 'compare', comparedFrom: ['a', 'b'] })

    // New GeneratedProvenance round-trips exactly.
    const prov: GeneratedProvenance = {
      kind: 'compare',
      sourceDocumentIds: ['a', 'b'],
      sourceCollectionIds: ['c1'],
      modelId: 'm',
      createdAt: '2026-06-14T00:00:00.000Z'
    }
    db.prepare('UPDATE documents SET origin_json = ? WHERE id = ?').run(JSON.stringify(prov), docId)
    expect(getDocumentOrigin(db, docId)).toEqual(prov)

    // A `kind` with no source ids is malformed ⇒ null (never throws).
    db.prepare('UPDATE documents SET origin_json = ? WHERE id = ?').run(
      JSON.stringify({ kind: 'translation', sourceDocumentIds: [] }),
      docId
    )
    expect(getDocumentOrigin(db, docId)).toBeNull()
  })
})

describe('failed windows (R-T2 retry-then-mark policy)', () => {
  it('retries a failing window once, then MARKS it visibly with the original text kept', async () => {
    const docId = await importDoc(600)
    const budget = translationBudgetWords(1024)
    const translator = scriptedTranslator({
      contextTokens: 1024,
      reply: (call) => {
        // Window 2 starts exactly where window 1's budget ended.
        if (call.text.split(/\s+/)[0] === `word${budget}`) throw new Error('boom: model refused')
        return call.text
      }
    })
    const manager = makeManager({ translator })
    const { jobId } = manager.startDocTask({
      kind: 'translation',
      documentIds: [docId],
      params: { sourceLang: 'en', targetLang: 'de' }
    })
    const status = await waitTerminal(manager, jobId)
    // The task still completes — one bad window must not lose the document.
    expect(status.state).toBe('done')

    const total = Math.ceil(600 / budget)
    // The failing window was tried exactly twice (one retry).
    const failingCalls = translator.calls.filter(
      (c) => c.text.split(/\s+/)[0] === `word${budget}`
    )
    expect(failingCalls).toHaveLength(2)

    const newId = status.resultRef?.documentId as string
    const { text } = readStoredDocumentText(db, storeDir, newId)
    expect(text).toContain(failedWindowNotice(2, total))
    // The window's ORIGINAL text is kept below the notice (window 2 starts where
    // window 1's budget ended).
    expect(text).toContain(`word${budget}`)
  })

  it('an empty reply counts as a failure: one retry, then the marked window', async () => {
    const docId = await importDoc(60)
    const translator = scriptedTranslator({ reply: () => '   ' })
    const manager = makeManager({ translator })
    const { jobId } = manager.startDocTask({
      kind: 'translation',
      documentIds: [docId],
      params: { sourceLang: 'en', targetLang: 'de' }
    })
    const status = await waitTerminal(manager, jobId)
    // The single window failed twice → all windows failed → the task fails friendly.
    expect(status.state).toBe('failed')
    expect(translator.calls).toHaveLength(2)
  })

  it('fails the whole task (and persists nothing) when EVERY window fails', async () => {
    const docId = await importDoc(100)
    const translator = scriptedTranslator({
      reply: () => {
        throw new Error('boom')
      }
    })
    const manager = makeManager({ translator })
    const { jobId } = manager.startDocTask({
      kind: 'translation',
      documentIds: [docId],
      params: { sourceLang: 'en', targetLang: 'de' }
    })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('failed')
    expect(status.error).toBe(TASK_GENERIC_FAILURE_MESSAGE)
    expect(listDocuments(db)).toHaveLength(1) // only the source — no half-born output
  })
})

describe('cancellation persists nothing', () => {
  it('cancel mid-translation leaves no output document and no transient files', async () => {
    const docId = await importDoc(600)
    const translator = scriptedTranslator({ contextTokens: 1024, tokenDelayMs: 5 })
    const manager = makeManager({ translator })
    const { jobId } = manager.startDocTask({
      kind: 'translation',
      documentIds: [docId],
      params: { sourceLang: 'en', targetLang: 'de' }
    })
    // Wait until it is actually translating, then cancel.
    const start = Date.now()
    while (manager.getDocTask(jobId).state !== 'running' || translator.calls.length === 0) {
      if (Date.now() - start > 5000) throw new Error('task never started')
      await new Promise((r) => setTimeout(r, 5))
    }
    manager.cancelDocTask(jobId)
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('cancelled')
    expect(listDocuments(db)).toHaveLength(1) // the source only
    expect(readdirSync(storeDir).filter((n) => n.includes('.parse'))).toHaveLength(0)
  })
})

describe('the Phase-32 lease (held around exactly the materialize step)', () => {
  it('acquires the lease AFTER the last window, releases it after import', async () => {
    const docId = await importDoc(600)
    const translator = scriptedTranslator({ contextTokens: 1024 })
    let acquired = 0
    let released = 0
    let callsAtAcquire = -1
    const manager = makeManager({
      translator,
      beginDocumentWork: () => {
        acquired += 1
        callsAtAcquire = translator.calls.length
        return () => {
          released += 1
        }
      }
    })
    const { jobId } = manager.startDocTask({
      kind: 'translation',
      documentIds: [docId],
      params: { sourceLang: 'en', targetLang: 'de' }
    })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    expect(acquired).toBe(1)
    expect(released).toBe(1)
    // Every sidecar call had already happened when the lease was taken: the long
    // translation loop runs lease-free (a password change is never blocked by it).
    const budget = translationBudgetWords(1024)
    expect(callsAtAcquire).toBe(Math.ceil(600 / budget))
  })

  it('a password change in progress fails the task friendly (VaultBusyError passes through)', async () => {
    const docId = await importDoc(60)
    const busyMessage = 'The workspace password is being changed right now. Try again in a moment.'
    const manager = makeManager({
      translator: scriptedTranslator(),
      beginDocumentWork: () => {
        throw new VaultBusyError(busyMessage)
      }
    })
    const { jobId } = manager.startDocTask({
      kind: 'translation',
      documentIds: [docId],
      params: { sourceLang: 'en', targetLang: 'de' }
    })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('failed')
    expect(status.error).toBe(busyMessage) // the friendly copy, not the generic one
    expect(listDocuments(db)).toHaveLength(1) // nothing persisted
    expect(readdirSync(storeDir).filter((n) => n.includes('.parse'))).toHaveLength(0)
  })
})

describe('busy-document guard covers the freshly created output document', () => {
  it('isDocumentBusy(outputId) is true while the materialize import runs', async () => {
    const docId = await importDoc(60)
    let releaseEmbed!: () => void
    const embedGate = new Promise<void>((r) => (releaseEmbed = r))
    // The embedder runs INSIDE processDocument during materialize — gating it holds
    // the import open while the output row already exists.
    const gatedEmbedder: Embedder = {
      id: 'gated-embedder',
      dimensions: 4,
      embed: async (texts: string[]) => {
        await embedGate
        return texts.map(() => new Float32Array(4))
      }
    }
    const manager = makeManager({
      translator: scriptedTranslator(),
      ingestionDeps: () => ({ embedder: gatedEmbedder })
    })
    const { jobId } = manager.startDocTask({
      kind: 'translation',
      documentIds: [docId],
      params: { sourceLang: 'en', targetLang: 'de' }
    })

    // Wait until the output row exists (the import is gated on the embedder).
    const start = Date.now()
    let outputId: string | null = null
    while (!outputId) {
      if (Date.now() - start > 5000) throw new Error('output document never appeared')
      outputId = listDocuments(db).find((d) => d.id !== docId)?.id ?? null
      if (!outputId) await new Promise((r) => setTimeout(r, 5))
    }
    expect(manager.isDocumentBusy(outputId)).toBe(true)
    expect(manager.isDocumentBusy(docId)).toBe(true)

    releaseEmbed()
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    expect(manager.isDocumentBusy(outputId)).toBe(false)
  })
})

describe('encrypted workspace', () => {
  it('the materialized translation rests encrypted; export decrypts transiently', async () => {
    const cipher = testCipher()
    const docId = await importDoc(60, 'memo.txt', { cipher })
    const manager = makeManager({
      translator: scriptedTranslator(),
      ingestionDeps: () => ({ cipher })
    })
    const { jobId } = manager.startDocTask({
      kind: 'translation',
      documentIds: [docId],
      params: { sourceLang: 'en', targetLang: 'de' }
    })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    const newId = status.resultRef?.documentId as string
    const created = getDocument(db, newId)
    expect(created?.status).toBe('indexed')
    expect(created?.title).toBe('memo (Deutsch).md')

    // On disk: ONLY `.enc` files — no plaintext copy, no `.parse*` transient survived.
    const names = readdirSync(storeDir)
    expect(names.length).toBeGreaterThanOrEqual(2)
    expect(names.every((n) => n.endsWith('.enc'))).toBe(true)

    // Export path: decrypts to a transient, returns the text, shreds the transient.
    const { text } = readStoredDocumentText(db, storeDir, newId, { cipher })
    expect(text).toContain(translationAttributionLine('scripted-translator'))
    expect(text).toContain('word0')
    expect(readdirSync(storeDir).every((n) => n.endsWith('.enc'))).toBe(true)

    // Without the cipher (locked context) the export refuses, never garbles.
    expect(() => readStoredDocumentText(db, storeDir, newId)).toThrow(/unlock the workspace/)
  })
})
