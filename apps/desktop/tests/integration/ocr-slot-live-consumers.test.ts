import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createQueuedDocument, processDocument } from '../../src/main/services/ingestion'
import {
  TASK_DOCUMENT_NOT_READY_MESSAGE,
  TASK_NEEDS_OCR_MESSAGE,
  TASK_SOURCE_UNREADABLE_MESSAGE
} from '../../src/main/services/doctasks'
import { refreshOcrSlot, type OcrSlot } from '../../src/main/services/compose-services'
import { createMockEmbedder } from '../../src/main/services/embeddings'
import {
  docTaskManager,
  docTaskWorld,
  scriptedTranslator,
  waitTerminal,
  type DocTaskWorld
} from '../helpers/doctask-fixtures'
import { fakeOcrEngine, fakeRasterizer, importScan, ocrDrive } from '../helpers/ocr-fixtures'

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

let w: DocTaskWorld

beforeEach(() => {
  w = docTaskWorld('ocrslot')
})

/**
 * The engine `refreshOcrSlot`'s `makeEngine` seam constructs "after the in-app install": a probe
 * that flips `availability()` (#410 D2 rule 1), fixed recognized text and a call counter so a
 * consumer reaching it is provable.
 */
const installedEngine = (languages: readonly string[], text: string) =>
  fakeOcrEngine({ id: 'fake-tesseract-410', languages, text, state: 'probing' })

/** Import a photo (JPEG bytes) through the REAL ingestion pipeline — "an earlier session". */
async function importPhoto(name: string, text: string): Promise<string> {
  const p = join(w.root, name)
  writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]))
  const info = createQueuedDocument(w.db, p)
  const done = await processDocument(w.db, w.storeDir, info.id, {
    // The engine an "earlier session" imported the photo with — indexing needs no probe.
    ocrEngine: fakeOcrEngine({ id: 'earlier-session-engine', text, confidence: 88 })
  })
  expect(done.status).toBe('indexed')
  return info.id
}

describe('#410 — the OCR slot is read LIVE by every doc-task consumer', () => {
  it("the 'ocr' kind admission stops refusing needsOcr, and the SAME manager completes the task", async () => {
    const slot: OcrSlot = { ocrEngine: null, paths: { rootPath: ocrDrive(['deu', 'eng']) }, isDev: true }
    const docId = await importScan(w, { pages: 1 })
    const manager = docTaskManager(w, {
      // Mirrors main/index.ts exactly: both seams read the mutable slot per call, never a
      // captured startup value.
      getIngestionDeps: () => ({ embedder: createMockEmbedder(), ocrEngine: slot.ocrEngine ?? null }),
      getOcrEngine: () => slot.ocrEngine ?? null,
      rasterizePdf: fakeRasterizer({ pages: 1 })
    })

    // Before the install: the slot is null — admission refuses with the friendly needsOcr copy
    // (manager.ts's kind === 'ocr' guard).
    expect(() => manager.startDocTask({ kind: 'ocr', documentIds: [docId] })).toThrow(TASK_NEEDS_OCR_MESSAGE)

    const outcome = await refreshOcrSlot(slot, {
      makeEngine: (_dir, languages) => installedEngine(languages, 'Scan recognized after the install.')
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
    const slot: OcrSlot = { ocrEngine: null, paths: { rootPath: ocrDrive(['deu', 'eng']) }, isDev: true }
    const docId = await importPhoto('letter.jpg', 'Der Brief wurde in einer früheren Sitzung erkannt.')
    const translator = scriptedTranslator()
    const manager = docTaskManager(w, {
      getTranslator: () => translator,
      getIngestionDeps: () => ({ ocrEngine: slot.ocrEngine ?? null }),
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
      makeEngine: (_dir, languages) => installedEngine(languages, recognizedText)
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
    const slot: OcrSlot = { ocrEngine: null, paths: { rootPath: ocrDrive(['deu', 'eng']) }, isDev: true }
    const docId = await importPhoto('statement.jpg', 'Kontoauszug aus einer früheren Sitzung.')
    // categorize is model-optional (no runtime here); the point is the OCR re-extraction.
    const manager = docTaskManager(w, {
      getIngestionDeps: () => ({ ocrEngine: slot.ocrEngine ?? null }),
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

    const engine = installedEngine(['deu', 'eng'], 'Kontoauszug nach der Installation erkannt.')
    const outcome = await refreshOcrSlot(slot, { makeEngine: () => engine })
    expect(outcome).toBe('activated')

    // SAME manager, SAME document: the auto-extract's re-extraction now reaches the installed
    // engine (proven by the call count) and the task completes.
    const after = manager.startDocTask({ kind: 'categorize', documentIds: [docId] })
    const afterStatus = await waitTerminal(manager, after.jobId)
    expect(afterStatus.state).toBe('done')
    expect(engine.calls).toBeGreaterThan(0)
  })
})
