import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import { createQueuedDocument, documentsDir, processDocument } from '../../src/main/services/ingestion'
import {
  DocTaskManager,
  TASK_DOCUMENT_NOT_READY_MESSAGE,
  TASK_NEEDS_OCR_MESSAGE,
  TASK_SOURCE_UNREADABLE_MESSAGE
} from '../../src/main/services/doctasks'
import { refreshOcrSlot, type OcrSlot } from '../../src/main/services/compose-services'
import type { OcrAvailability, OcrEngine } from '../../src/main/services/ocr'
import type { RasterizePdf } from '../../src/main/services/ocr/rasterizer'
import { createMockEmbedder } from '../../src/main/services/embeddings'
import type { Translator, TranslateOptions } from '../../src/main/services/translation'
import { TRANSLATION_STOP_TOKEN } from '../../src/main/services/translation'
import { makeScanOnlyPdf } from '../helpers/fixtures'
import { hangBudgetMs } from '../helpers/hang-budget'

// Issue #410 — before this wave, `DocTaskManager`'s ingestion deps and OCR-engine getter were
// built ONCE at wiring time off the startup `ctx.ocrEngine` const. `refreshOcrSlot` (also #410)
// fills a null slot mid-session after an in-app OCR install, but a doc-task deps object built
// from the old startup value never saw it — the "split brain": the 'ocr' kind admission, a
// photo document's translation re-extraction, and its categorize auto-extraction all stayed
// stuck on null until an app restart, even though the drive now carries working OCR files.
// `main/index.ts` now wires `getIngestionDeps` / `getOcrEngine` to read `ctx.ocrEngine` LIVE
// (`ocrEngine: ctx?.ocrEngine ?? null` / `() => ctx?.ocrEngine ?? null`) per call, never captured.
// This file proves all three consumers see `refreshOcrSlot`'s new engine on the SAME manager
// instance — the one shape a captured startup value could not pass.

let tmp: string
let db: Db
let storeDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hilbertraum-ocrslot-'))
  db = openDatabase(join(tmp, 'test.sqlite'))
  storeDir = documentsDir(join(tmp, 'workspace'))
})

/** A temp DRIVE root carrying the two language files `refreshOcrSlot`'s null-slot rule reads. */
function driveWithOcrFiles(): string {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-ocrslot-drive-'))
  mkdirSync(join(root, 'ocr'), { recursive: true })
  writeFileSync(join(root, 'ocr', 'deu.traineddata.gz'), 'deu-bytes')
  writeFileSync(join(root, 'ocr', 'eng.traineddata.gz'), 'eng-bytes')
  return root
}

interface FakeInstallEngine extends OcrEngine {
  probe: ReturnType<typeof vi.fn>
  recognizeCalls: number
}

/**
 * The engine `refreshOcrSlot`'s `makeEngine` seam constructs "after the in-app install" — the
 * compose-ocr.test.ts `fakeEngine` shape (a probe that flips `availability()`, #410 D2 rule 1),
 * extended with fixed recognized text and a call counter so a consumer reaching it is provable.
 */
function fakeInstallEngine(languages: readonly string[], text: string): FakeInstallEngine {
  let state: OcrAvailability = 'probing'
  const engine: FakeInstallEngine = {
    id: 'fake-tesseract-410',
    languages,
    recognizeCalls: 0,
    recognize: async () => {
      engine.recognizeCalls += 1
      return { text, confidence: 90 }
    },
    availability: () => state,
    probe: vi.fn(async () => {
      state = 'available'
      return true
    })
  }
  return engine
}

/** The engine an "earlier session" imported the photo with — indexing needs no probe/availability. */
function earlierSessionEngine(text: string): OcrEngine {
  return {
    id: 'earlier-session-engine',
    languages: ['deu', 'eng'],
    recognize: async () => ({ text, confidence: 88 })
  }
}

/** Import a photo (JPEG bytes) through the REAL ingestion pipeline — "an earlier session". */
async function importPhoto(name: string, text: string): Promise<string> {
  const p = join(tmp, name)
  writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]))
  const info = createQueuedDocument(db, p)
  const done = await processDocument(db, storeDir, info.id, { ocrEngine: earlierSessionEngine(text) })
  expect(done.status).toBe('indexed')
  return info.id
}

/** A "true scan" PDF — needs the 'ocr' task ("Make searchable"), not the photo import path. */
async function importScan(): Promise<string> {
  const p = join(tmp, 'scan.pdf')
  writeFileSync(p, makeScanOnlyPdf(1))
  const info = createQueuedDocument(db, p)
  const done = await processDocument(db, storeDir, info.id)
  expect(done.status).toBe('failed')
  expect(done.scanDetected).toBe(true)
  return info.id
}

/** A fake rasterizer: N pages, each "PNG" = Buffer([pageNumber]) (copied from ocr-task.test.ts). */
function fakeRasterizer(pages = 1): RasterizePdf {
  return async (_pdf, o) => {
    o.onPageCount?.(pages)
    for (let n = 1; n <= pages; n++) {
      if (o.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      await o.onPage(n, Buffer.from([n]))
    }
    return { pageCount: pages }
  }
}

interface ScriptedTranslator extends Translator {
  calls: TranslateOptions[]
}

/** A perfect-echo translator (copied/simplified from doctasks-translation.test.ts). */
function scriptedTranslator(): ScriptedTranslator {
  const translator: ScriptedTranslator = {
    modelId: 'scripted-translator',
    calls: [],
    contextWindow: () => 4096,
    stop: async () => {},
    async translate(call: TranslateOptions): Promise<string> {
      translator.calls.push(call)
      call.onFinal?.({ stoppingWord: TRANSLATION_STOP_TOKEN })
      return call.text
    }
  }
  return translator
}

async function waitTerminal(
  manager: DocTaskManager,
  jobId: string
): Promise<ReturnType<DocTaskManager['getDocTask']>> {
  const start = Date.now()
  for (;;) {
    const status = manager.getDocTask(jobId)
    if (status.state === 'done' || status.state === 'failed' || status.state === 'cancelled') return status
    if (Date.now() - start > hangBudgetMs(10_000)) throw new Error(`task ${jobId} never finished: ${status.state}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('#410 — the OCR slot is read LIVE by every doc-task consumer', () => {
  it("the 'ocr' kind admission stops refusing needsOcr, and the SAME manager completes the task", async () => {
    const slot: OcrSlot = { ocrEngine: null, paths: { rootPath: driveWithOcrFiles() }, isDev: true }
    const docId = await importScan()
    const manager = new DocTaskManager({
      getDb: () => db,
      getRuntime: () => null,
      getTranslator: () => null,
      isChatStreaming: () => false,
      getContextTokens: () => 4096,
      getStoreDir: () => storeDir,
      // Mirrors main/index.ts exactly: both seams read the mutable slot per call, never a
      // captured startup value.
      getIngestionDeps: () => ({ embedder: createMockEmbedder(), ocrEngine: slot.ocrEngine ?? null }),
      beginDocumentWork: () => () => {},
      getOcrEngine: () => slot.ocrEngine ?? null,
      rasterizePdf: fakeRasterizer(1)
    })

    // Before the install: the slot is null — admission refuses with the friendly needsOcr copy
    // (manager.ts's kind === 'ocr' guard).
    expect(() => manager.startDocTask({ kind: 'ocr', documentIds: [docId] })).toThrow(TASK_NEEDS_OCR_MESSAGE)

    const outcome = await refreshOcrSlot(slot, {
      makeEngine: (_dir, languages) => fakeInstallEngine(languages, 'Scan recognized after the install.')
    })
    expect(outcome).toBe('activated')

    // SAME manager instance, no restart: the admission no longer throws needsOcr, and the task
    // — now handed a live engine + the rasterizer — actually runs to completion.
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [docId] })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    expect(status.resultRef?.documentId).toBe(docId)
  })

  it('translation of a photo fails sourceUnreadable while the slot is null, then completes on the SAME manager', async () => {
    const slot: OcrSlot = { ocrEngine: null, paths: { rootPath: driveWithOcrFiles() }, isDev: true }
    const docId = await importPhoto('letter.jpg', 'Der Brief wurde in einer früheren Sitzung erkannt.')
    const translator = scriptedTranslator()
    const manager = new DocTaskManager({
      getDb: () => db,
      getRuntime: () => null,
      getTranslator: () => translator,
      isChatStreaming: () => false,
      getContextTokens: () => 4096,
      getStoreDir: () => storeDir,
      getIngestionDeps: () => ({ ocrEngine: slot.ocrEngine ?? null }),
      beginDocumentWork: () => () => {},
      getOcrEngine: () => slot.ocrEngine ?? null
    })

    // Before the install: `extractTranslationSource` re-parses the stored photo through the
    // image parser, which throws without an engine even though the photo is already indexed
    // (handlers/shared.ts) — the task ends failed with the friendly sourceUnreadable copy.
    const before = manager.startDocTask({
      kind: 'translation',
      documentIds: [docId],
      params: { sourceLang: 'de', targetLang: 'en' }
    })
    const beforeStatus = await waitTerminal(manager, before.jobId)
    expect(beforeStatus.state).toBe('failed')
    expect(beforeStatus.error).toBe(TASK_SOURCE_UNREADABLE_MESSAGE)

    const recognizedText = 'Der Brief wurde nach der Installation neu erkannt.'
    const outcome = await refreshOcrSlot(slot, {
      makeEngine: (_dir, languages) => fakeInstallEngine(languages, recognizedText)
    })
    expect(outcome).toBe('activated')

    // SAME manager, SAME document: the re-extraction now reaches the just-installed engine and
    // the translator sees the RE-recognized text (proving the live read, not a cached value).
    const after = manager.startDocTask({
      kind: 'translation',
      documentIds: [docId],
      params: { sourceLang: 'de', targetLang: 'en' }
    })
    const afterStatus = await waitTerminal(manager, after.jobId)
    expect(afterStatus.state).toBe('done')
    expect(translator.calls.length).toBe(1)
    expect(translator.calls[0].text).toContain(recognizedText)
  })

  it('categorize auto-extract of a photo fails documentNotReady while the slot is null, then reaches the engine on the SAME manager', async () => {
    const slot: OcrSlot = { ocrEngine: null, paths: { rootPath: driveWithOcrFiles() }, isDev: true }
    const docId = await importPhoto('statement.jpg', 'Kontoauszug aus einer früheren Sitzung.')
    const manager = new DocTaskManager({
      getDb: () => db,
      getRuntime: () => null, // categorize is model-optional; the point here is the OCR re-extraction
      getTranslator: () => null,
      isChatStreaming: () => false,
      getContextTokens: () => 4096,
      getStoreDir: () => storeDir,
      getIngestionDeps: () => ({ ocrEngine: slot.ocrEngine ?? null }),
      beginDocumentWork: () => () => {},
      getOcrEngine: () => slot.ocrEngine ?? null
    })

    // No prior bank-statement extraction exists, so categorize AUTO-EXTRACTS first
    // (handlers/categorize.ts). With the slot null, `readDocumentSegments`'s re-extraction of the
    // photo fails the same way translation's does, and the extraction tool reports !ok — the task
    // ends failed with the friendly documentNotReady copy.
    const before = manager.startDocTask({ kind: 'categorize', documentIds: [docId] })
    const beforeStatus = await waitTerminal(manager, before.jobId)
    expect(beforeStatus.state).toBe('failed')
    expect(beforeStatus.error).toBe(TASK_DOCUMENT_NOT_READY_MESSAGE)

    const engine = fakeInstallEngine(['deu', 'eng'], 'Kontoauszug nach der Installation erkannt.')
    const outcome = await refreshOcrSlot(slot, { makeEngine: () => engine })
    expect(outcome).toBe('activated')

    // SAME manager, SAME document: the auto-extract's re-extraction now reaches the installed
    // engine (proven by the call count) and the task no longer fails for "not ready".
    const after = manager.startDocTask({ kind: 'categorize', documentIds: [docId] })
    const afterStatus = await waitTerminal(manager, after.jobId)
    expect(afterStatus.error).not.toBe(TASK_DOCUMENT_NOT_READY_MESSAGE)
    expect(engine.recognizeCalls).toBeGreaterThan(0)
  })
})
