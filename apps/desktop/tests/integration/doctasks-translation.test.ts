import { describe, it, expect, beforeEach } from 'vitest'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createQueuedDocument,
  getDocument,
  listDocuments,
  processDocument,
  readStoredDocumentText,
  reindexDocument
} from '../../src/main/services/ingestion'
import {
  TASK_GENERIC_FAILURE_MESSAGE,
  TASK_TRANSLATION_NO_MODEL_MESSAGE,
  TASK_TRANSLATION_TARGET_MESSAGE,
  failedWindowNotice,
  missingPageNotice,
  translationAttributionLine,
  translationBudgetWords,
  type DocTaskManager,
  type PageGap
} from '../../src/main/services/doctasks'
import { makeMixedPdf } from '../helpers/fixtures'
import type { CompletionFinal, TranslateOptions, Translator } from '../../src/main/services/translation'
import { TRANSLATION_STOP_TOKEN, TranslationStartError } from '../../src/main/services/translation'
import { VaultBusyError } from '../../src/main/services/workspace-vault'
import { listAuditEvents } from '../../src/main/services/audit'
import {
  addToCollection,
  createCollection,
  documentIdsInCollection,
  fileDocumentByDestination,
  getBuiltinCollection
} from '../../src/main/services/collections'
import type {
  GeneratedProvenance,
  StartDocTaskRequest,
  TranslationSourceLang,
  TranslationTargetLang
} from '../../src/shared/types'
import type { Embedder } from '../../src/main/services/embeddings'
import type { ModelRuntime } from '../../src/main/services/runtime'
import type { OcrEngine } from '../../src/main/services/ocr'
import { applyUiLanguageSetting } from '../../src/main/services/i18n'
import { t } from '../../src/shared/i18n'
import { EngineCannotRunError } from '../../src/main/services/runtime/engine-load'
import { RuntimeUnresponsiveError } from '../../src/main/services/runtime/llama'
import { until } from '../helpers/hang-budget'
import {
  dbAudit,
  docTaskManager,
  docTaskWorld,
  importWords,
  scriptedTranslator,
  waitTerminal,
  type DocTaskStatusOf,
  type DocTaskWorld,
  type ScriptedTranslator,
  type ScriptedTranslatorOptions
} from '../helpers/doctask-fixtures'
import { testCipher } from '../helpers/test-cipher'

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

let w: DocTaskWorld
beforeEach(() => {
  w = docTaskWorld('doctr')
})

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

/** The translation request for one document (en → de unless the pair is given). */
function translateReq(
  documentId: string,
  sourceLang: TranslationSourceLang = 'en',
  targetLang: TranslationTargetLang = 'de'
): StartDocTaskRequest {
  return { kind: 'translation', documentIds: [documentId], params: { sourceLang, targetLang } }
}

/** Resolve once `jobId` is running and the translator has received a new call (its window is in flight). */
async function waitRunning(manager: DocTaskManager, jobId: string, translator: ScriptedTranslator): Promise<void> {
  const before = translator.calls.length
  await until(
    () => manager.getDocTask(jobId).state === 'running' && translator.calls.length > before,
    `task ${jobId} to start a window`
  )
}

describe('validation (kind + params, the widened 10-language set)', () => {
  it('refuses missing/invalid/same source+target languages with friendly copy', async () => {
    const docId = await importWords(w, 50)
    const translator = scriptedTranslator()
    const manager = docTaskManager(w, { getTranslator: () => translator })
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
    // 'ja' joined the supported set at issue #31 — 'xy' stays a non-code on both ends.
    expect(() =>
      manager.startDocTask({
        kind: 'translation',
        documentIds: [docId],
        params: { sourceLang: 'de', targetLang: 'xy' }
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
    const docId = await importWords(w, 30)
    const translator = scriptedTranslator()
    const manager = docTaskManager(w, { getTranslator: () => translator })
    const { jobId } = manager.startDocTask(translateReq(docId, 'fr', 'uk'))
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    expect(translator.calls[0]).toMatchObject({ sourceLang: 'fr', targetLang: 'uk' })
    // The materialized title carries the target's native name.
    const created = getDocument(w.db, status.resultRef?.documentId as string)
    expect(created?.title).toBe('doc (Українська).md')
  })

  it('requires exactly one source document', async () => {
    const a = await importWords(w, 50, { name: 'a.txt' })
    const b = await importWords(w, 50, { name: 'b.txt' })
    const translator = scriptedTranslator()
    const manager = docTaskManager(w, { getTranslator: () => translator })
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

describe('TG-5: translating a document imported into Temporary (plan §2 D7)', () => {
  it('materializes a Generated translation and leaves the temporary source in Temporary', async () => {
    // The Translate view's drop/pick path imports the source with `destination: {kind:'temporary'}`
    // (fileDocumentByDestination is exactly what the IPC layer runs), then runs THIS same doc-task.
    const docId = await importWords(w, 40, { name: 'dropped.txt' })
    fileDocumentByDestination(w.db, docId, { kind: 'temporary' })
    expect(getDocument(w.db, docId)?.lifecycle).toBe('temporary')

    const translator = scriptedTranslator()
    const manager = docTaskManager(w, { getTranslator: () => translator })
    const { jobId } = manager.startDocTask(translateReq(docId, 'de', 'en'))
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')

    // The materialized translation is a Generated document (provenance stamped, source recorded).
    const newId = status.resultRef?.documentId as string
    const origin = getDocument(w.db, newId)?.origin as GeneratedProvenance
    expect(origin.kind).toBe('translation')
    expect(origin.sourceDocumentIds).toEqual([docId])

    // The temporary source is untouched by the translation — it stays in Temporary (its own
    // retention lifecycle governs cleanup, TG-5 D7). The Generated output carries NO membership.
    expect(getDocument(w.db, docId)?.lifecycle).toBe('temporary')
    const tempId = getBuiltinCollection(w.db, 'temporary')!.id
    expect(documentIdsInCollection(w.db, tempId)).toContain(docId)
    expect(documentIdsInCollection(w.db, tempId)).not.toContain(newId)
  })
})

describe('the D3 guards (TG-3): the translation model, not the chat runtime', () => {
  it('refuses to start without the translation model — even with a chat model running', async () => {
    const docId = await importWords(w, 50)
    const runtime = stubChatRuntime()
    const manager = docTaskManager(w, { getRuntime: () => runtime }) // no translator
    expect(() => manager.startDocTask(translateReq(docId))).toThrow(TASK_TRANSLATION_NO_MODEL_MESSAGE)
  })

  it('runs to done with NO chat model, and never calls a chat runtime that IS present', async () => {
    const docId = await importWords(w, 50)
    // A translator + a booby-trapped chat runtime: chatStream throws if ever touched.
    const translator = scriptedTranslator()
    const runtime = stubChatRuntime()
    const manager = docTaskManager(w, { getTranslator: () => translator, getRuntime: () => runtime })
    const { jobId } = manager.startDocTask(translateReq(docId, 'de', 'en'))
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    expect(translator.calls.length).toBeGreaterThan(0)
  })

  it('fails friendly when the translator disappears while QUEUED (quit teardown re-check)', async () => {
    const a = await importWords(w, 60, { name: 'a.txt' })
    const b = await importWords(w, 60, { name: 'b.txt' })
    // B is queued behind A in the same tick; A captured its translator synchronously at its own dequeue.
    let available: Translator | null = scriptedTranslator()
    const manager = docTaskManager(w, { getTranslator: () => available })
    const first = manager.startDocTask(translateReq(a))
    const second = manager.startDocTask(translateReq(b))
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
    const docId = await importWords(w, 600)
    // The SIDECAR's context (1024) drives the window budget — deps.getContextTokens (the
    // chat window) is deliberately different (4096) and must be ignored since TG-3.
    const translator = scriptedTranslator({ contextTokens: 1024 })
    const manager = docTaskManager(w, {
      getTranslator: () => translator,
      getContextTokens: () => 4096,
      audit: dbAudit(w.db)
    })

    const { jobId } = manager.startDocTask(translateReq(docId))
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    expect(status.gaps ?? null).toBeNull() // a page-less .txt: no page accounting, nothing failed

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
    const created = getDocument(w.db, newId)
    expect(created?.status).toBe('indexed')
    expect(created?.chunkCount).toBeGreaterThan(0)
    expect(created?.title).toBe('doc (Deutsch).md')

    // Windows were sent in document order (window 1 starts at word0).
    const firstWords = translator.calls.map((c) => c.text.split(/\s+/)[0])
    expect(firstWords[0]).toBe('word0')
    const starts = firstWords.map((fw) => Number(fw.replace('word', '')))
    expect([...starts].sort((x, y) => x - y)).toEqual(starts)

    // Stored output: attribution line (the TRANSLATION model's id) + the stitched translation.
    const { text } = await readStoredDocumentText(w.db, w.storeDir, newId)
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

    // Audit: ids-only document_task_completed (with the SOURCE id) + a
    // document_imported for the materialized document.
    const events = listAuditEvents(w.db, { limit: 100 })
    const completed = events.find((e) => e.type === 'document_task_completed')
    expect(completed?.metadata).toEqual({ kind: 'translation', documentId: docId })
    const imported = events.find((e) => e.type === 'document_imported')
    expect(imported?.metadata).toMatchObject({ documentId: newId, status: 'indexed' })
    // S1 (full-audit-2026-06-30): the materialized output's title is CONTENT — the
    // message is a fixed string and must NOT carry the translated filename.
    expect(imported?.message).toBe('Document imported')
    expect(imported?.message).not.toContain('Deutsch')

    // The materialize transient is gone (shredded) — nothing `.parse*` lingers.
    expect(readdirSync(w.storeDir).filter((n) => n.includes('.parse'))).toHaveLength(0)
  })

  it('origin survives a re-index (provenance, not sync) and malformed origin_json reads as null', async () => {
    const docId = await importWords(w, 60)
    const translator = scriptedTranslator()
    const manager = docTaskManager(w, { getTranslator: () => translator })
    const { jobId } = manager.startDocTask(translateReq(docId, 'de', 'en'))
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    const newId = status.resultRef?.documentId as string

    // Re-index the translated document: chunks rebuild, origin stays.
    const reinfo = await reindexDocument(w.db, w.storeDir, newId)
    expect(reinfo.status).toBe('indexed')
    expect(getDocument(w.db, newId)?.origin).toEqual({
      kind: 'translation',
      sourceDocumentIds: [docId],
      modelId: 'scripted-translator',
      createdAt: expect.any(String)
    })

    // Malformed origin_json must never break a listing — it reads as null.
    w.db.prepare('UPDATE documents SET origin_json = ? WHERE id = ?').run('{not json', newId)
    expect(getDocument(w.db, newId)?.origin).toBeNull()
    expect(listDocuments(w.db).find((d) => d.id === newId)?.origin).toBeNull()
  })
})

describe('generated provenance + membership (Phase D — §15.1/§15.2, D3/N1)', () => {
  it('writes structured provenance, snapshots the SOURCE collections, and files NO membership', async () => {
    const docId = await importWords(w, 80, { name: 'source.txt' })
    // The SOURCE lives in Library + a project; the generated output must NOT inherit them.
    const lib = getBuiltinCollection(w.db, 'library')!
    const project = createCollection(w.db, 'Tax 2025')
    addToCollection(w.db, [docId], lib.id)
    addToCollection(w.db, [docId], project.id)

    const translator = scriptedTranslator()
    const manager = docTaskManager(w, { getTranslator: () => translator })
    const { jobId } = manager.startDocTask(translateReq(docId))
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    const newId = status.resultRef?.documentId as string

    // Structured provenance persisted: kind + source id + model + a snapshot of the
    // source's collections at creation time (display/forward-use only).
    const origin = getDocument(w.db, newId)?.origin as GeneratedProvenance
    expect(origin.kind).toBe('translation')
    expect(origin.sourceDocumentIds).toEqual([docId])
    expect(origin.modelId).toBe('scripted-translator')
    expect(origin.createdAt.length).toBeGreaterThan(0)
    expect([...(origin.sourceCollectionIds ?? [])].sort()).toEqual([lib.id, project.id].sort())

    // N1/D3: the generated row gets ZERO document_collections rows of its own — it is
    // structurally excluded from every collection-derived (Library/project) scope.
    const memberships = w.db
      .prepare('SELECT collection_id FROM document_collections WHERE document_id = ?')
      .all(newId) as unknown as Array<{ collection_id: string }>
    expect(memberships).toHaveLength(0)
    // The source keeps its memberships untouched.
    const sourceMemberships = w.db
      .prepare('SELECT collection_id FROM document_collections WHERE document_id = ?')
      .all(docId) as unknown as Array<{ collection_id: string }>
    expect(sourceMemberships.map((r) => r.collection_id).sort()).toEqual([lib.id, project.id].sort())
  })
})

describe('failed windows (R-T2 retry-then-mark policy)', () => {
  // Window 2 of a 600-word doc on the sidecar's 1024 context starts exactly where window 1's budget ended.
  const W2 = `word${translationBudgetWords(1024)}`
  const isWindow2 = (call: TranslateOptions): boolean => call.text.split(/\s+/)[0] === W2

  it.each([
    // R-T2: a thrown window is the transient class — one retry, then the visible marker.
    ['a thrown window: one retry, then marked (R-T2)', {
      reply: (call: TranslateOptions) => {
        if (isWindow2(call)) throw new Error('boom: model refused')
        return call.text
      }
    }, 2],
    // An empty reply is transient too — one retry, then the marker (never an empty part).
    ['an empty reply: one retry, then marked', { reply: (call: TranslateOptions) => (isWindow2(call) ? '   ' : call.text) }, 2],
    // M6/FA-2 F-2: non-empty text with NO clean stop is a deterministic limit stop (greedy decode reproduces the identical
    // clip), so it is marked on the FIRST attempt instead of burning a second ~30-min decode.
    ['a limit stop (no clean stop): marked IMMEDIATELY, no futile retry (M6/FA-2 F-2)', {
      final: (call: TranslateOptions): CompletionFinal => (isWindow2(call) ? {} : { stoppingWord: TRANSLATION_STOP_TOKEN })
    }, 1]
  ] satisfies Array<[string, Pick<ScriptedTranslatorOptions, 'reply' | 'final'>, number]>)(
    'a failing window is retried per its class, then MARKED with the original text kept: %s',
    async (_label, opts, attempts) => {
      const docId = await importWords(w, 600)
      const translator = scriptedTranslator({ contextTokens: 1024, ...opts })
      const manager = docTaskManager(w, { getTranslator: () => translator })
      const status = await waitTerminal(manager, manager.startDocTask(translateReq(docId)).jobId)
      expect(status.state).toBe('done') // one bad window never loses the document
      expect(translator.calls.filter(isWindow2)).toHaveLength(attempts)
      expect(status.gaps).toEqual({ missingPageRanges: [], failedWindows: 1 }) // #58: the count reaches the UI
      const { text } = await readStoredDocumentText(w.db, w.storeDir, status.resultRef?.documentId as string)
      expect(text).toContain(failedWindowNotice(2, Math.ceil(600 / translationBudgetWords(1024))))
      expect(text).toContain(W2) // window 2's ORIGINAL text kept below its notice
      expect(text).toContain('word0') // the clean windows are intact
    }
  )

  // Test-gap #4: a per-request timeout aborts the COMBINED signal with a `TimeoutError` while the task's OWN signal stays
  // unaborted, so `isAbortError(err, taskSignal)` is false — a FAILED window (one window here → the task fails friendly),
  // never mistaken for a user cancel. #160 (BE-2) then splits it by whether tokens flowed: a live decode that ran out of
  // time is as deterministic as a limit stop (no retry); a wedged server with no tokens gets the transient retry.
  it.each([
    ['#160 (BE-2): tokens flowed (a live, too-slow decode) → marked with NO retry', true, 1],
    ['#160 (BE-2) control: no tokens (a wedged server) → its one transient retry', false, 2]
  ])('a per-request TimeoutError is a FAILED window, NOT a task cancel: %s', async (_label, tokensFlowed, attempts) => {
    const docId = await importWords(w, 40) // one window
    let calls = 0
    const translator: Translator = {
      modelId: 'scripted-translator',
      contextWindow: () => 4096,
      stop: async () => {},
      async translate(o) {
        calls += 1
        if (tokensFlowed) o.onToken?.('slow ')
        throw new DOMException('The operation timed out.', 'TimeoutError')
      }
    }
    const manager = docTaskManager(w, { getTranslator: () => translator })
    const status = await waitTerminal(manager, manager.startDocTask(translateReq(docId)).jobId)
    expect(status.state).toBe('failed') // never 'cancelled'
    expect(status.error).toBe(TASK_GENERIC_FAILURE_MESSAGE)
    expect(calls).toBe(attempts)
  })

  it('#605: a hung sidecar keeps its one retry even after tokens flowed — the runtime stopped it, the retry runs on a fresh one', async () => {
    const docId = await importWords(w, 40) // one window
    let calls = 0
    const translator: Translator = {
      modelId: 'hung-translator',
      contextWindow: () => 4096,
      async translate(o) {
        calls += 1
        if (calls === 1) {
          o.onToken?.('Gu') // tokens flowed, then the decode clock ended the window
          throw new RuntimeUnresponsiveError(120_000)
        }
        o.onFinal?.({ stopType: 'eos' })
        return 'Guten Tag.'
      },
      async stop() {}
    }
    const manager = docTaskManager(w, { getTranslator: () => translator })
    const { jobId } = manager.startDocTask(translateReq(docId))
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    expect(status.gaps).toBeUndefined() // no window marked failed
    expect(calls).toBe(2) // unlike BE-2's too-slow decode, which is marked without a retry
  })

  // L12: the attribution line + failed-window notice are PERSISTED into the generated document,
  // so they localize to the app language at materialization time (via tMain), not the
  // canonical-English DB strings. With German selected, the materialized Markdown is German.
  it('L12: persists the attribution + failed-window notice in the app language (de)', async () => {
    const docId = await importWords(w, 600)
    const budget = translationBudgetWords(1024)
    const translator = scriptedTranslator({
      contextTokens: 1024,
      reply: (call) => {
        if (isWindow2(call)) throw new Error('boom: model refused')
        return call.text
      }
    })
    const manager = docTaskManager(w, { getTranslator: () => translator })
    applyUiLanguageSetting('de')
    try {
      const { jobId } = manager.startDocTask(translateReq(docId))
      const status = await waitTerminal(manager, jobId)
      expect(status.state).toBe('done')

      const total = Math.ceil(600 / budget)
      const newId = status.resultRef?.documentId as string
      const { text } = await readStoredDocumentText(w.db, w.storeDir, newId)
      // The German catalog strings are present…
      expect(text).toContain(t('de', 'main.translation.attributionLine', { modelId: 'scripted-translator' }))
      expect(text).toContain(t('de', 'main.translation.failedWindowNotice', { part: 2, total }))
      // …and the canonical English forms are NOT.
      expect(text).not.toContain(t('en', 'main.translation.attributionLine', { modelId: 'scripted-translator' }))
    } finally {
      applyUiLanguageSetting('en') // restore for the rest of the suite
    }
  })

  // A start fault latches inside the runtime and reaches the handler as a TranslationStartError: it fails the WHOLE task
  // with friendly, content-free copy — never the generic failure, never N marked windows — after ONE attempt (a retry
  // re-throws the latch identically). #530: when the OS loader refused the engine, the engine copy, not the memory one.
  it.each([
    ['F-7: a start fault (memory pressure) → the restart/free-memory copy',
      () => new Error('llama-server exited before becoming healthy (code 3221226505)'), 'main.translation.startFailed'],
    ['#530: the OS loader refused the engine → the engine copy, not the memory one',
      () => new EngineCannotRunError('llama-server', {
        family: 'llama_cpp', reason: 'library-missing', os: 'linux', name: 'libgomp.so.1', exit: 'exit code 127'
      }), 'main.engine.cannotRun']
  ] as const)('a LATCHED sidecar start failure fails the task with its own friendly copy — one attempt, no per-window retry: %s',
    async (_label, cause, key) => {
      const docId = await importWords(w, 60)
      let calls = 0
      const translator: Translator = {
        modelId: 'scripted-translator',
        contextWindow: () => 4096,
        stop: async () => {},
        async translate() {
          calls += 1
          throw new TranslationStartError(cause())
        }
      }
      const manager = docTaskManager(w, { getTranslator: () => translator })
      const status = await waitTerminal(manager, manager.startDocTask(translateReq(docId)).jobId)
      expect(status.state).toBe('failed')
      expect(status.error).toBe(t('en', key))
      expect(calls).toBe(1)
    })

  it('fails the whole task (and persists nothing) when EVERY window fails', async () => {
    const docId = await importWords(w, 100)
    const translator = scriptedTranslator({
      reply: () => {
        throw new Error('boom')
      }
    })
    const manager = docTaskManager(w, { getTranslator: () => translator })
    const { jobId } = manager.startDocTask(translateReq(docId))
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('failed')
    expect(status.error).toBe(TASK_GENERIC_FAILURE_MESSAGE)
    expect(listDocuments(w.db)).toHaveLength(1) // only the source — no half-born output
  })
})

describe('cancellation persists nothing', () => {
  it('cancel mid-translation leaves no output document and no transient files', async () => {
    const docId = await importWords(w, 600)
    const translator = scriptedTranslator({ contextTokens: 1024, tokenDelayMs: 5 })
    const manager = docTaskManager(w, { getTranslator: () => translator })
    const { jobId } = manager.startDocTask(translateReq(docId))
    // Wait until it is actually translating, then cancel.
    await waitRunning(manager, jobId, translator)
    manager.cancelDocTask(jobId)
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('cancelled')
    expect(listDocuments(w.db)).toHaveLength(1) // the source only
    expect(readdirSync(w.storeDir).filter((n) => n.includes('.parse'))).toHaveLength(0)
  })
})

describe('lifecycle flush (TA-1: lock/quit cancel the running task AND the queue)', () => {
  it('cancelAllDocTasks flushes the running task AND every queued task; a queued task never runs', async () => {
    const a = await importWords(w, 600, { name: 'a.txt' })
    const b = await importWords(w, 60, { name: 'b.txt' })
    // Slow token delay so A is still mid-window (running) and B still queued when we flush.
    const translator = scriptedTranslator({ contextTokens: 1024, tokenDelayMs: 5 })
    const manager = docTaskManager(w, { getTranslator: () => translator })
    const first = manager.startDocTask(translateReq(a))
    const second = manager.startDocTask(translateReq(b))

    // Wait until A is actually running and B is still queued behind it.
    await waitRunning(manager, first.jobId, translator)
    expect(manager.getDocTask(second.jobId).state).toBe('queued')

    manager.cancelAllDocTasks()
    // B is dequeued to terminal `cancelled` SYNCHRONOUSLY — it never transitioned to `running`,
    // so its handler (and its plaintext-decrypting translate call) never ran. This is exactly
    // the queued-translation-into-the-lock-window respawn the flush closes.
    expect(manager.getDocTask(second.jobId).state).toBe('cancelled')

    expect((await waitTerminal(manager, first.jobId)).state).toBe('cancelled')
    expect((await waitTerminal(manager, second.jobId)).state).toBe('cancelled')

    // No permanent latch — the manager is fully usable again after the flush (post-unlock parity).
    const c = await importWords(w, 40, { name: 'c.txt' })
    const third = manager.startDocTask(translateReq(c))
    expect((await waitTerminal(manager, third.jobId)).state).toBe('done')
  })

  it('awaitActiveTaskSettled resolves after the running task settles, and immediately when idle', async () => {
    const translator = scriptedTranslator()
    const manager = docTaskManager(w, { getTranslator: () => translator })
    // Idle → resolves immediately (nothing running).
    await expect(manager.awaitActiveTaskSettled()).resolves.toBeUndefined()

    const docId = await importWords(w, 60)
    const { jobId } = manager.startDocTask(translateReq(docId))
    // The settle resolves only once the running task has reached a terminal state.
    await manager.awaitActiveTaskSettled()
    expect(['done', 'failed', 'cancelled']).toContain(manager.getDocTask(jobId).state)
  })
})

describe('targeted cancel + active-task read (FA-3: F-6 stale cancel, F-3 reload adoption)', () => {
  it('a targeted cancel with a STALE jobId never kills the newer active task (the F-6 race pin)', async () => {
    const a = await importWords(w, 600, { name: 'a.txt' })
    const b = await importWords(w, 40, { name: 'b.txt' })
    const translator = scriptedTranslator({ contextTokens: 1024, tokenDelayMs: 5 })
    const manager = docTaskManager(w, { getTranslator: () => translator })

    // Task A runs, then we cancel it — the "our own task went terminal" half of the race.
    const first = manager.startDocTask(translateReq(a))
    await waitRunning(manager, first.jobId, translator)
    manager.cancelDocTask(first.jobId)
    expect((await waitTerminal(manager, first.jobId)).state).toBe('cancelled')

    // A NEW task B takes the lane. A stale Stop still carrying A's OLD jobId must NOT kill B —
    // exact-id (#157 DT-2): A is TERMINAL, so the targeted cancel no-ops; B has a different id.
    const second = manager.startDocTask(translateReq(b))
    await waitRunning(manager, second.jobId, translator)
    manager.cancelDocTask(first.jobId) // stale (terminal) id → no-op
    // B is untouched and reaches its OWN terminal state (done), not cancelled by the stale id.
    expect((await waitTerminal(manager, second.jobId)).state).toBe('done')
  })

  it('#157 (DT-5): listActiveDocTasks surfaces a translation QUEUED behind a foreign running task; getActiveDocTask stays running-only', async () => {
    const a = await importWords(w, 600, { name: 'a.txt' })
    const b = await importWords(w, 40, { name: 'b.txt' })
    const translator = scriptedTranslator({ contextTokens: 1024, tokenDelayMs: 5 })
    const manager = docTaskManager(w, { getTranslator: () => translator })

    expect(manager.listActiveDocTasks()).toEqual([]) // idle
    expect(manager.getActiveDocTask()).toBeNull() // idle — nothing to adopt (FA-3 / F-3)

    const foreign = manager.startDocTask(translateReq(a))
    await waitRunning(manager, foreign.jobId, translator)
    const ours = manager.startDocTask(translateReq(b))

    // getActiveDocTask keeps its running-only contract (the #38 chain-adopt caller)…
    expect(manager.getActiveDocTask()).toMatchObject({ jobId: foreign.jobId, kind: 'translation', state: 'running' })
    // …while the list carries the QUEUED translation too, in lane order — the state the reload adopt needs (a task becomes
    // `running` in the same tick it becomes runningId, so `queued` was structurally unreachable through getActiveDocTask).
    const lane = manager.listActiveDocTasks()
    expect(lane.map((t) => t.jobId)).toEqual([foreign.jobId, ours.jobId])
    expect(lane[1].state).toBe('queued')

    manager.cancelAllDocTasks()
    await manager.awaitActiveTaskSettled()
    expect(manager.listActiveDocTasks()).toEqual([])
    expect(manager.getActiveDocTask()).toBeNull() // back to idle once terminal
  })
})

describe('the Phase-32 lease (held around exactly the materialize step)', () => {
  it('acquires the lease AFTER the last window, releases it after import', async () => {
    const docId = await importWords(w, 600)
    const translator = scriptedTranslator({ contextTokens: 1024 })
    let acquired = 0
    let released = 0
    let callsAtAcquire = -1
    const manager = docTaskManager(w, {
      getTranslator: () => translator,
      beginDocumentWork: () => {
        acquired += 1
        callsAtAcquire = translator.calls.length
        return () => {
          released += 1
        }
      }
    })
    const { jobId } = manager.startDocTask(translateReq(docId))
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
    const docId = await importWords(w, 60)
    const busyMessage = 'The workspace password is being changed right now. Try again in a moment.'
    const translator = scriptedTranslator()
    const manager = docTaskManager(w, {
      getTranslator: () => translator,
      beginDocumentWork: () => {
        throw new VaultBusyError(busyMessage)
      }
    })
    const { jobId } = manager.startDocTask(translateReq(docId))
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('failed')
    expect(status.error).toBe(busyMessage) // the friendly copy, not the generic one
    expect(listDocuments(w.db)).toHaveLength(1) // nothing persisted
    expect(readdirSync(w.storeDir).filter((n) => n.includes('.parse'))).toHaveLength(0)
  })
})

describe('busy-document guard covers the freshly created output document', () => {
  it('isDocumentBusy(outputId) is true while the materialize import runs', async () => {
    const docId = await importWords(w, 60)
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
    const translator = scriptedTranslator()
    const manager = docTaskManager(w, {
      getTranslator: () => translator,
      getIngestionDeps: () => ({ embedder: gatedEmbedder })
    })
    const { jobId } = manager.startDocTask(translateReq(docId))

    // Wait until the output row exists (the import is gated on the embedder).
    const outputRow = (): string | undefined => listDocuments(w.db).find((d) => d.id !== docId)?.id
    await until(() => outputRow() !== undefined, 'the output document row to appear')
    const outputId = outputRow() as string
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
    const docId = await importWords(w, 60, { name: 'memo.txt', deps: { cipher } })
    const translator = scriptedTranslator()
    const manager = docTaskManager(w, {
      getTranslator: () => translator,
      getIngestionDeps: () => ({ cipher })
    })
    const { jobId } = manager.startDocTask(translateReq(docId))
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    const newId = status.resultRef?.documentId as string
    const created = getDocument(w.db, newId)
    expect(created?.status).toBe('indexed')
    expect(created?.title).toBe('memo (Deutsch).md')

    // On disk: ONLY `.enc` files — no plaintext copy, no `.parse*` transient survived.
    const names = readdirSync(w.storeDir)
    expect(names.length).toBeGreaterThanOrEqual(2)
    expect(names.every((n) => n.endsWith('.enc'))).toBe(true)

    // Export path: decrypts to a transient, returns the text, shreds the transient.
    const { text } = await readStoredDocumentText(w.db, w.storeDir, newId, { cipher })
    expect(text).toContain(translationAttributionLine('scripted-translator'))
    expect(text).toContain('word0')
    expect(readdirSync(w.storeDir).every((n) => n.endsWith('.enc'))).toBe(true)

    // Without the cipher (locked context) the export refuses, never garbles.
    await expect(readStoredDocumentText(w.db, w.storeDir, newId)).rejects.toThrow(/unlock the workspace/)
  })
})

describe('issue #58 — a source page with no extractable text must never vanish silently', () => {
  /** Write a synthetic PDF buffer and run it through the REAL ingestion pipeline. */
  async function importPdf(buf: Buffer, name: string): Promise<string> {
    const p = join(w.root, name)
    writeFileSync(p, buf)
    const info = createQueuedDocument(w.db, p)
    const done = await processDocument(w.db, w.storeDir, info.id, {})
    expect(done.status).toBe('indexed')
    return info.id
  }

  /** One distinctive text page for makeMixedPdf — long enough to clear PDF_TEXT_PAGE_MIN_CHARS. */
  const textPage = (n: number): { kind: 'text'; lines: string[] } => ({
    kind: 'text',
    lines: [`UNIQUEPAGE${n}MARKER this page carries enough real prose to count as text-bearing.`]
  })

  async function translate(docId: string): Promise<{ status: DocTaskStatusOf; text: string }> {
    const translator = scriptedTranslator()
    const manager = docTaskManager(w, { getTranslator: () => translator })
    const { jobId } = manager.startDocTask(translateReq(docId, 'de', 'en'))
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    const newId = status.resultRef?.documentId as string
    const { text } = await readStoredDocumentText(w.db, w.storeDir, newId)
    return { status, text }
  }

  it.each([
    // REPRO (the issue-#58 shape): a hybrid PDF — pages 1,2,4,5 carry text, page 3 is a scan (image XObject, empty
    // text layer). Scan detection does NOT fire (4 text pages).
    ['an image-only page 3 of 5 (REPRO)', [1, 2, 'img', 4, 5], { from: 3, to: 3 }, 2, 4],
    ['the consecutive empty pages 2–3, as ONE range notice', [1, 'img', 'img', 4], { from: 2, to: 3 }, 1, 4]
  ] satisfies Array<[string, Array<number | 'img'>, PageGap, number, number]>)(
    'issue #58: %s is marked in place AND reported on the status',
    async (_label, shape, gap, before, after) => {
      const pages = shape.map((p) => (p === 'img' ? { kind: 'image' as const } : textPage(p)))
      const { status, text } = await translate(await importPdf(makeMixedPdf(pages), 'gappy.pdf'))
      // The gap reaches the UI: honest completeness accounting on the task status…
      expect(status.gaps).toEqual({ missingPageRanges: [gap], failedWindows: 0 })
      // …and the document marks it IN PLACE, exactly once (a run of pages is one range, never a notice per page).
      const notice = missingPageNotice(gap)
      expect(text.split('⚠')).toHaveLength(2)
      expect(text.indexOf(notice)).toBeGreaterThan(text.indexOf(`UNIQUEPAGE${before}MARKER`))
      expect(text.indexOf(notice)).toBeLessThan(text.indexOf(`UNIQUEPAGE${after}MARKER`))
      // Every text-bearing page made it into the output (nothing else was dropped).
      for (const p of shape) if (p !== 'img') expect(text).toContain(`UNIQUEPAGE${p}MARKER`)
    }
  )

  it('detects a TRAILING empty page — page numbering alone could never reveal it', async () => {
    const docId = await importPdf(
      makeMixedPdf([textPage(1), textPage(2), { kind: 'image' }]),
      'trailing.pdf'
    )
    const { status, text } = await translate(docId)
    expect(status.gaps).toEqual({ missingPageRanges: [{ from: 3, to: 3 }], failedWindows: 0 })
    const notice = missingPageNotice({ from: 3, to: 3 })
    // The notice sits AFTER the last translated text.
    expect(text.indexOf(notice)).toBeGreaterThan(text.indexOf('UNIQUEPAGE2MARKER'))
  })

  it('a complete PDF reports NO gaps and carries no notice', async () => {
    const docId = await importPdf(makeMixedPdf([textPage(1), textPage(2)]), 'complete.pdf')
    const { status, text } = await translate(docId)
    expect(status.gaps ?? null).toBeNull()
    expect(text).not.toContain('⚠')
  })

  it('L12: the gap notice persists in the app language (de) at materialization time', async () => {
    const docId = await importPdf(
      makeMixedPdf([textPage(1), { kind: 'image' }, textPage(3)]),
      'lokalisiert.pdf'
    )
    applyUiLanguageSetting('de')
    try {
      const { text } = await translate(docId)
      expect(text).toContain(t('de', 'main.translation.missingPageNotice', { page: 2 }))
      expect(text).not.toContain(t('en', 'main.translation.missingPageNotice', { page: 2 }))
    } finally {
      applyUiLanguageSetting('en')
    }
  })
})

describe('#156 (DT-1) — image-source documents: re-extraction gets the OCR engine', () => {
  /** The docs-ipc fake-engine shape: recognition is deterministic, no real decode. */
  const fakeOcrEngine: OcrEngine = {
    id: 'fake-tesseract',
    languages: ['deu', 'eng'],
    recognize: async () => ({ text: 'Hallo Welt aus dem Foto.', confidence: 92 }),
    availability: () => 'available',
    probe: async () => true,
    stop: async () => {},
    suspend: async () => {}
  }

  async function importPhoto(): Promise<string> {
    // The image parser hands the raw bytes to the injected engine (no in-process decode),
    // so arbitrary bytes under a .jpg name exercise the REAL photo ingest path.
    const p = join(w.root, 'letter.jpg')
    writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]))
    const info = createQueuedDocument(w.db, p)
    const done = await processDocument(w.db, w.storeDir, info.id, { ocrEngine: fakeOcrEngine })
    expect(done.status).toBe('indexed')
    return info.id
  }

  it('translates a photographed page end to end (was: fails "sourceUnreadable")', async () => {
    const docId = await importPhoto()
    const translator = scriptedTranslator()
    // The REAL ingestion deps carry the engine (main/index.ts getIngestionDeps) — the doc-task
    // re-extraction must forward it, or parsers/image.ts throws and the task fails
    // "sourceUnreadable" for a file the app just OCR'd and indexed. (The compare handler's
    // extractSegmentTexts rides the same extractTranslationSource, so this covers both.)
    const manager = docTaskManager(w, {
      getTranslator: () => translator,
      getIngestionDeps: () => ({ ocrEngine: fakeOcrEngine })
    })
    const { jobId } = manager.startDocTask(translateReq(docId, 'de', 'en'))
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    // The window text is the re-recognized photo text — the engine reached the re-parse.
    expect(translator.calls.length).toBe(1)
    expect(translator.calls[0].text).toContain('Hallo Welt aus dem Foto.')
    const newId = status.resultRef?.documentId as string
    const { text } = await readStoredDocumentText(w.db, w.storeDir, newId)
    expect(text).toContain('Hallo Welt aus dem Foto.')
  })
})
