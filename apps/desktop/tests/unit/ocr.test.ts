import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { PdfParser, PDF_SCAN_DETECTED_MESSAGE } from '../../src/main/services/ingestion/parsers/pdf'
import {
  ImageParser,
  IMAGE_NEEDS_OCR_MESSAGE,
  IMAGE_NO_TEXT_MESSAGE,
  IMAGE_OCR_FAILED_MESSAGE,
  IMAGE_OCR_UNAVAILABLE_MESSAGE
} from '../../src/main/services/ingestion/parsers/image'
import {
  createSelectedOcrEngine,
  listOcrLanguages,
  ocrAssetsDir,
  TesseractOcrEngine,
  type OcrAvailability,
  type OcrEngine
} from '../../src/main/services/ocr'
import {
  DEFAULT_OCR_PAGE_TIMEOUT_MS,
  DEFAULT_OCR_REPROBE_DELAY_MS,
  DEFAULT_OCR_WORKER_START_TIMEOUT_MS,
  resolveWorkerScriptPath,
  type TesseractModule
} from '../../src/main/services/ocr/tesseract'
import { imageOrientation } from '../../src/main/services/ocr/orientation'
import { makeMixedPdf, makeScanOnlyPdf, makeHybridPdf, TINY_PNG } from '../helpers/fixtures'
import { hangBudgetMs, until, within } from '../helpers/hang-budget'
import { fakeOcrEngine } from '../helpers/ocr-fixtures'

// Phase 38 — scanned-PDF detection (step 0), the OCR engine seam + offline wiring
// (R-O2), the factory's availability rule (D14/D9: null, never a mock), and the no-CDN
// sentinel. CI posture: zero network, zero models — the real tesseract.js module is never
// loaded here.

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-ocr-'))
}

describe('image-only PDF detection (step 0)', () => {
  it('does NOT detect a hybrid text+scan PDF — its text pages index normally', async () => {
    const dir = tmp()
    const p = join(dir, 'hybrid.pdf')
    writeFileSync(p, makeHybridPdf())
    const parsed = await PdfParser.parse(p)
    expect(parsed.segments.length).toBe(1)
    expect(parsed.segments[0].pageNumber).toBe(1)
    expect(parsed.segments[0].text).toContain('real text layer')
  })

  // #575 — a text PDF's scanned pages: under the text threshold AND painting an image. A blank page
  // and a short title page paint none and are not offered OCR. Reported only when import asks.
  const LETTER: Parameters<typeof makeMixedPdf>[0] = [
    { kind: 'text', lines: ['Dear customer, this letter confirms your annual statement.'] },
    { kind: 'image' },
    { kind: 'blank' },
    { kind: 'text', lines: ['Anhang'] },
    { kind: 'image' }
  ]

  it('#575: reports a text PDF’s scanned pages — not its blank or short title pages — when asked', async () => {
    const p = join(tmp(), 'letter.pdf')
    writeFileSync(p, makeMixedPdf(LETTER))
    expect((await PdfParser.parse(p, { detectScannedPages: true })).scannedPages).toEqual([2, 5])
    expect((await PdfParser.parse(p)).scannedPages).toBeUndefined()
  })

  it('#575: a scanned page that OCR read contributes its recognition; text pages keep their own text', async () => {
    const p = join(tmp(), 'letter.pdf')
    writeFileSync(p, makeMixedPdf(LETTER))
    const parsed = await PdfParser.parse(p, {
      ocrPages: [
        { pageNumber: 1, text: 'NOT USED: page 1 has a text layer' },
        { pageNumber: 2, text: 'Unterschrift Max Mustermann' },
        { pageNumber: 5, text: '' } // read, nothing found: the page stays without a segment
      ]
    })
    expect(parsed.segments.map((s) => [s.pageNumber, s.text])).toEqual([
      [1, 'Dear customer, this letter confirms your annual statement.'],
      [2, 'Unterschrift Max Mustermann'],
      [4, 'Anhang']
    ])
  })

  it('still fails friendly when the stored OCR pages are all empty', async () => {
    const dir = tmp()
    const p = join(dir, 'scan.pdf')
    writeFileSync(p, makeScanOnlyPdf(1))
    await expect(
      PdfParser.parse(p, { ocrPages: [{ pageNumber: 1, text: '   ' }] })
    ).rejects.toThrow(PDF_SCAN_DETECTED_MESSAGE)
  })
})

describe('photo parser (.png/.jpg OCR on import)', () => {
  it('recognizes a photo into one page-less segment', async () => {
    const dir = tmp()
    const p = join(dir, 'page.png')
    writeFileSync(p, TINY_PNG)
    const parsed = await ImageParser.parse(p, { ocrEngine: fakeOcrEngine({ text: 'Hello recognized world' }) })
    expect(parsed.segments).toEqual([
      { text: 'Hello recognized world', pageNumber: null, sectionLabel: null }
    ])
  })

  // BE-8 (ocr-audit 2026-07-18): the parse context's abort signal must reach the engine so a
  // cancelled import aborts recognition instead of waiting it out (bounded by the 2-min ceiling).
  // Watched fail pre-fix: `engine.recognize(image)` forwarded no options, so `seenSignal` was
  // undefined and the aborting engine ran to completion.
  it('forwards the parse context abort signal to the OCR engine (BE-8)', async () => {
    const dir = tmp()
    const p = join(dir, 'page.png')
    writeFileSync(p, TINY_PNG)
    const controller = new AbortController()
    let seenSignal: AbortSignal | undefined
    const observing: OcrEngine = {
      id: 'fake',
      languages: ['eng'],
      recognize: async (_img, opts) => {
        seenSignal = opts?.signal
        return { text: 'recognized', confidence: 90 }
      }
    }
    await ImageParser.parse(p, { ocrEngine: observing, signal: controller.signal })
    expect(seenSignal).toBe(controller.signal)
  })

  it('fails friendly when no text is found / when recognition throws', async () => {
    const dir = tmp()
    const p = join(dir, 'page.jpg')
    writeFileSync(p, TINY_PNG)
    await expect(ImageParser.parse(p, { ocrEngine: fakeOcrEngine({ text: '   ' }) })).rejects.toThrow(
      IMAGE_NO_TEXT_MESSAGE
    )
    const failing: OcrEngine = {
      id: 'fake',
      languages: ['eng'],
      recognize: async () => {
        throw new Error('wasm exploded: technical detail')
      }
    }
    await expect(ImageParser.parse(p, { ocrEngine: failing })).rejects.toThrow(
      IMAGE_OCR_FAILED_MESSAGE
    )
  })

  // #232 / #219: in a packaged build whose
  // OCR worker cannot run, a photo is imported WITHOUT recognition and the row carries the
  // "could not run in this build" note. This is a NEW path — before the fix an engine was either
  // present (auto-OCR, which crashed the packaged app) or null (`IMAGE_NEEDS_OCR_MESSAGE`, whose
  // copy says the OCR files are not on the drive — FALSE for a kit that carries them). Watched
  // fail pre-fix: the parser ignores `availability()` and calls `recognize()`.
  it('#232 interim: an engine that cannot run in this build skips OCR and records the unavailable note', async () => {
    const dir = tmp()
    const p = join(dir, 'page.png')
    writeFileSync(p, TINY_PNG)
    let recognized = 0
    const degraded: OcrEngine = {
      id: 'fake',
      languages: ['eng'],
      availability: () => 'unavailable',
      recognize: async () => {
        recognized += 1
        return { text: 'never used', confidence: 90 }
      }
    }
    await expect(ImageParser.parse(p, { ocrEngine: degraded })).rejects.toThrow(
      IMAGE_OCR_UNAVAILABLE_MESSAGE
    )
    expect(recognized).toBe(0)
    // A distinct message: never the "not on this drive" copy, never the generic retry copy.
    expect(IMAGE_OCR_UNAVAILABLE_MESSAGE).not.toBe(IMAGE_NEEDS_OCR_MESSAGE)
    expect(IMAGE_OCR_UNAVAILABLE_MESSAGE).not.toBe(IMAGE_OCR_FAILED_MESSAGE)
    expect(IMAGE_OCR_UNAVAILABLE_MESSAGE).not.toMatch(/not on this drive/)

    // A recognition that fails WHILE the engine flips to unavailable (the worker died under it)
    // reports the same note, not "re-index to try again" — a retry would fail identically.
    let state: OcrAvailability = 'available'
    const flipping: OcrEngine = {
      id: 'fake',
      languages: ['eng'],
      availability: () => state,
      recognize: async () => {
        state = 'unavailable'
        throw new Error('worker module load failed')
      }
    }
    await expect(ImageParser.parse(p, { ocrEngine: flipping })).rejects.toThrow(
      IMAGE_OCR_UNAVAILABLE_MESSAGE
    )
    // While the startup probe is still running the import attempts recognition (it shares the
    // in-flight worker start) — only a FAILED probe degrades.
    const probing: OcrEngine = {
      id: 'fake',
      languages: ['eng'],
      availability: () => 'probing',
      recognize: async () => ({ text: 'recognized during probe', confidence: 90 })
    }
    const parsed = await ImageParser.parse(p, { ocrEngine: probing })
    expect(parsed.segments[0].text).toBe('recognized during probe')
  })
})

describe('OCR factory (availability-driven, D9: null — never a mock)', () => {
  it('selects an engine over the languages actually present (sorted)', () => {
    const root = tmp()
    const dir = ocrAssetsDir(root)
    mkdirSync(dir, { recursive: true })
    // #538: the orientation data is not a language — read with, it would fail the LSTM-only start.
    writeFileSync(join(dir, 'osd.traineddata.gz'), 'x')
    expect(createSelectedOcrEngine({ rootPath: root })).toBeNull()
    writeFileSync(join(dir, 'eng.traineddata.gz'), 'x')
    writeFileSync(join(dir, 'deu.traineddata.gz'), 'x')
    writeFileSync(join(dir, 'notes.txt'), 'not a language file')
    expect(listOcrLanguages(dir)).toEqual(['deu', 'eng'])
    let got: { langDir: string; languages: string[] } | null = null
    const engine = createSelectedOcrEngine({
      rootPath: root,
      makeEngine: (langDir, languages) => {
        got = { langDir, languages }
        return { id: 'fake', languages, recognize: async () => ({ text: '', confidence: null }) }
      }
    })
    expect(engine).not.toBeNull()
    expect(got).toEqual({ langDir: dir, languages: ['deu', 'eng'] })
  })
})

/**
 * A tesseract.js-shaped module whose workers start at once and read the n-th image as `text-<n>`.
 * `starts` records every `createWorker` call; `terminated.count` every worker terminated.
 */
function fakeTesseract(): {
  mod: TesseractModule
  starts: Array<{ langs: string[]; oem: number; options: Record<string, unknown> }>
  recognized: Buffer[]
  terminated: { count: number }
} {
  const starts: Array<{ langs: string[]; oem: number; options: Record<string, unknown> }> = []
  const recognized: Buffer[] = []
  const terminated = { count: 0 }
  const mod: TesseractModule = {
    createWorker: async (langs, oem, options) => {
      starts.push({ langs, oem, options })
      return {
        recognize: async (img: Buffer) => {
          recognized.push(img)
          return { data: { text: `text-${recognized.length}`, confidence: 90 } }
        },
        terminate: async () => {
          terminated.count += 1
        }
      }
    }
  }
  return { mod, starts, recognized, terminated }
}

describe('TesseractOcrEngine (offline wiring — R-O2)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('passes the explicit offline options: local langPath, gzip, no cache, LSTM-only', async () => {
    const { mod, starts } = fakeTesseract()
    const engine = new TesseractOcrEngine({
      langDir: 'X:/drive/ocr',
      languages: ['deu', 'eng'],
      loadTesseract: async () => mod
    })
    await engine.recognize(Buffer.from('img'))
    expect(starts.length).toBe(1)
    expect(starts[0].langs).toEqual(['deu', 'eng'])
    expect(starts[0].oem).toBe(1) // LSTM_ONLY — the vendored data is LSTM-only (R-O3)
    expect(starts[0].options.langPath).toBe('X:/drive/ocr')
    expect(starts[0].options.gzip).toBe(true)
    expect(starts[0].options.cacheMethod).toBe('none')
  })

  it('reuses one worker across recognitions and terminates on stop()', async () => {
    const { mod, starts, recognized, terminated } = fakeTesseract()
    const engine = new TesseractOcrEngine({
      langDir: '/ocr',
      languages: ['eng'],
      loadTesseract: async () => mod
    })
    const [a, b] = await Promise.all([
      engine.recognize(Buffer.from('1')),
      engine.recognize(Buffer.from('2'))
    ])
    expect(starts.length).toBe(1) // one warm worker
    expect(recognized.length).toBe(2)
    expect([a.text, b.text].sort()).toEqual(['text-1', 'text-2'])
    await engine.stop()
    expect(terminated.count).toBe(1)
    await expect(engine.recognize(Buffer.from('3'))).rejects.toThrow('stopped')
  })

  // BE-5(a) (ocr-audit 2026-07-18): `recognize()` checks `stopped` at CALL time, but a recognition
  // queued before stop() runs its ensureWorker() from the serialized chain AFTER stop() latches —
  // without the ensureWorker `stopped` guard that queued job lazily RESPAWNS a worker past the
  // will-quit teardown. TEETH: pre-fix ensureWorker ignores `stopped`, so a SECOND worker is
  // created (created===2) and the queued job resolves instead of rejecting.
  it('a recognition queued before stop() rejects when it runs — no worker respawned (BE-5)', async () => {
    let created = 0
    let releaseFirst!: () => void
    const firstGate = new Promise<{ data: { text: string; confidence: number } }>((resolve) => {
      releaseFirst = () => resolve({ data: { text: 'first', confidence: 90 } })
    })
    let markParked!: () => void
    const firstParked = new Promise<void>((r) => (markParked = r))
    let firstStarted = false
    const mod: TesseractModule = {
      createWorker: async () => {
        created++
        return {
          recognize: (_img: Buffer) => {
            if (!firstStarted) {
              firstStarted = true
              markParked()
              return firstGate // the first recognition PARKS, holding the chain
            }
            return Promise.resolve({ data: { text: 'later', confidence: 90 } })
          },
          terminate: async () => {}
        }
      }
    }
    const engine = new TesseractOcrEngine({
      langDir: '/ocr',
      languages: ['eng'],
      loadTesseract: async () => mod
    })
    // A first recognition starts and parks in the worker, holding the serialized chain.
    const first = engine.recognize(Buffer.from('1')).then(() => 'ok', () => 'failed')
    await within(firstParked, 'the first recognition parking in the worker')
    // A SECOND recognition queued while `stopped` is still false — it passes the top-level check
    // and parks in the chain, so its ensureWorker() runs AFTER stop() latches below.
    const second = engine.recognize(Buffer.from('2')).then(() => 'ok', (e) => (e as Error).message)
    await engine.stop() // terminates the first worker and latches `stopped`
    releaseFirst()
    const secondResult = await second
    await first
    expect(created).toBe(1) // no worker respawned after stop()
    expect(secondResult).toMatch(/stopped/)
  })

  // BE-5(b): the non-latching lock teardown. `suspend()` terminates the warm worker (no decoded
  // page bytes linger across the vault re-encrypt) but does NOT latch — the next recognition
  // lazily respawns a fresh worker and succeeds (unlike after `stop()`).
  it('suspend() terminates the warm worker without latching; next recognize respawns (BE-5)', async () => {
    const { mod, starts, terminated } = fakeTesseract()
    const engine = new TesseractOcrEngine({
      langDir: '/ocr',
      languages: ['eng'],
      loadTesseract: async () => mod
    })
    const first = await engine.recognize(Buffer.from('1'))
    expect(first.text).toBe('text-1')
    expect(starts.length).toBe(1)

    await engine.suspend()
    expect(terminated.count).toBe(1) // the warm worker was terminated

    // Non-latching: a fresh worker respawns and the recognition succeeds.
    const second = await engine.recognize(Buffer.from('2'))
    expect(second.text).toBe('text-2')
    expect(starts.length).toBe(2) // a SECOND worker was spawned (unlike after stop())
  })

  // REL-2 (TEST-4): a per-page recognition that exceeds the timeout terminates the worker
  // (a tesseract.js WASM job is not cooperatively cancellable) and rejects — so one wedged
  // image can't block the serialized chain for the rest of the scan. The next page gets a
  // fresh worker and succeeds. Teeth: just short of the shipped 2 min the worker still runs; just
  // past it, it is terminated.
  it('terminates the worker on a per-page timeout and recovers on the next page (REL-2)', async () => {
    vi.stubEnv('HILBERTRAUM_OCR_PAGE_TIMEOUT_MS', '') // the shipped default, not a developer's override
    let created = 0
    let terminated = 0
    let markEntered!: () => void
    const page1Entered = new Promise<void>((r) => (markEntered = r))
    type FakeResult = { data: { text: string; confidence: number } }
    const mod: TesseractModule = {
      createWorker: async () => {
        const myIndex = ++created
        return {
          recognize: (_img: Buffer): Promise<FakeResult> => {
            if (myIndex !== 1) return Promise.resolve({ data: { text: 'recovered', confidence: 88 } })
            markEntered()
            return new Promise<FakeResult>(() => undefined) // first worker: wedge forever
          },
          terminate: async () => {
            terminated += 1
          }
        }
      }
    }
    // setImmediate stays real: the engine's worker start waits one real macrotask (its capture hop).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const engine = new TesseractOcrEngine({
      langDir: '/ocr',
      languages: ['eng'],
      loadTesseract: async () => mod
    })
    // Page 1 wedges → times out → worker #1 terminated → rejects.
    const p1 = engine.recognize(Buffer.from('p1')).then(
      () => null,
      (e: unknown) => e
    )
    await within(page1Entered, 'page 1 reaching the worker')
    await vi.advanceTimersByTimeAsync(DEFAULT_OCR_PAGE_TIMEOUT_MS - 1)
    expect(terminated).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    const err = await within(p1, 'page 1 timing out')
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/timed out/i)
    expect(terminated).toBe(1)
    // The serialized chain recovered: page 2 lazily creates a fresh worker and succeeds.
    const r = await engine.recognize(Buffer.from('p2'))
    expect(r.text).toBe('recovered')
    expect(created).toBe(2)
  })

  // REL-2 (TEST-4): an abort mid-recognition also terminates the worker and rejects, so the
  // OCR task's Cancel takes effect WITHIN a page, not only between pages.
  it('terminates the worker when a recognition is aborted in flight (REL-2)', async () => {
    let terminated = 0
    let markEntered!: () => void
    const entered = new Promise<void>((r) => (markEntered = r))
    type FakeResult = { data: { text: string; confidence: number } }
    const mod: TesseractModule = {
      createWorker: async () => ({
        recognize: (_img: Buffer): Promise<FakeResult> => {
          markEntered()
          return new Promise<FakeResult>(() => undefined) // the page never finishes by itself
        },
        terminate: async () => {
          terminated += 1
        }
      })
    }
    const engine = new TesseractOcrEngine({
      langDir: '/ocr',
      languages: ['eng'],
      loadTesseract: async () => mod
    })
    const controller = new AbortController()
    const call = engine.recognize(Buffer.from('p'), { signal: controller.signal })
    // The abort lands while the page is IN the worker — the in-flight listener, not the entry check.
    await within(entered, 'the page reaching the worker')
    controller.abort()
    await expect(within(call, 'the cancelled page settling')).rejects.toMatchObject({ name: 'AbortError' })
    expect(terminated).toBe(1)
  })

  // REL-1 (full-audit-2026-06-29 follow-up): stop() (workspace lock / quit) calls terminateWorker()
  // OUT OF BAND — not through this.chain — so it can race an ensureWorker() init started inside a
  // chained recognize(). The old terminateWorker nulled this.starting unconditionally and never
  // awaited a PENDING init, so the worker that init later produced OUTLIVED the teardown (a leaked
  // WASM worker holding decoded page bytes). The fix awaits the in-flight init (the e5/reranker
  // teardown mirror) so the worker it spawns is the one terminated. TEETH: drop the `await starting`
  // → the late-born worker is never terminated (`terminated[0]` stays false → red).
  it('stop() during an in-flight worker init terminates the worker it spawns — no leak (REL-1)', async () => {
    let created = 0
    const terminated: boolean[] = []
    let releaseInit!: () => void
    const initGate = new Promise<void>((r) => (releaseInit = r))
    let markInitEntered!: () => void
    const initEntered = new Promise<void>((r) => (markInitEntered = r))
    const mod: TesseractModule = {
      createWorker: async () => {
        const myIndex = created++
        // Gate the FIRST init so it is still in flight when stop() fires.
        if (myIndex === 0) {
          markInitEntered()
          await initGate
        }
        terminated[myIndex] = false
        return {
          recognize: async (): Promise<{ data: { text: string; confidence: number } }> => ({
            data: { text: 'x', confidence: 90 }
          }),
          terminate: async () => {
            terminated[myIndex] = true
          }
        }
      }
    }
    const engine = new TesseractOcrEngine({
      langDir: '/ocr',
      languages: ['eng'],
      loadTesseract: async () => mod
    })

    // A recognize() drives ensureWorker() → createWorker enters and parks (init #0 in flight).
    const rec = engine.recognize(Buffer.from('p')).then(
      () => 'ok',
      () => 'failed'
    )
    await within(initEntered, 'worker init #0 entering')
    expect(created).toBe(1)

    // stop() fires while init #0 is parked. terminateWorker must await it, then terminate worker #0.
    // stop() captures the in-flight init (`this.starting`) synchronously, so no hop is needed here.
    const stopP = engine.stop()

    releaseInit() // init #0 resolves → worker #0 is born
    await stopP
    await rec

    expect(created).toBe(1) // no second worker was spawned
    expect(terminated[0]).toBe(true) // the late-born worker was terminated, not leaked past the lock
  })

  // BE-9 (ocr-audit 2026-07-18): the engine id must be DERIVED from the installed tesseract.js
  // version, not a hardcoded literal — a future bump would otherwise stamp a wrong
  // `ocr_json.engineId` provenance. A version bump that meets a hardcoded id reds here (pre-fix
  // `this.id` was the frozen string 'tesseract.js-7.0.0' regardless).
  it('derives the engine id from the tesseract.js version (BE-9)', async () => {
    // The real installed package version flows through.
    const { createRequire } = await import('node:module')
    const { version } = createRequire(import.meta.url)('tesseract.js/package.json') as {
      version: string
    }
    const real = new TesseractOcrEngine({ langDir: '/ocr', languages: ['eng'] })
    expect(real.id).toBe(`tesseract.js-${version}`)
  })

  // #538 — orientation detection runs in a SECOND worker: the legacy-capable core over the drive's
  // `osd.traineddata.gz`. It is optional in every sense: no file, no worker; its answer becomes the
  // turn the recognizer applies to the bytes; and the will-quit teardown ends both workers.
  it('orientation detection: a lazily started legacy-core worker over osd, its turn applied to the reading (#538)', async () => {
    const langDir = tmp()
    const calls: Array<{ langs: string[]; oem: number; options: Record<string, unknown> }> = []
    const recognized: Buffer[] = []
    let terminated = 0
    const mod: TesseractModule = {
      createWorker: async (langs, oem, options) => {
        calls.push({ langs, oem, options })
        return {
          recognize: async (img: Buffer) => {
            recognized.push(img)
            return { data: { text: 'ok', confidence: 90 } }
          },
          detect: async () => ({ data: { orientation_degrees: 270, orientation_confidence: 2.4 } }),
          terminate: async () => {
            terminated += 1
          }
        }
      }
    }
    const engine = new TesseractOcrEngine({ langDir, languages: ['deu', 'eng'], loadTesseract: async () => mod })

    // No orientation file on the drive: no answer, and no worker is started for it.
    expect(await engine.detectOrientation(TINY_PNG)).toBeNull()
    expect(calls).toEqual([])

    writeFileSync(join(langDir, 'osd.traineddata.gz'), 'x') // installed mid-session: used at once
    expect(await engine.detectOrientation(TINY_PNG)).toEqual({ turn: 270, confidence: 2.4 })
    expect(calls).toHaveLength(1)
    expect(calls[0].langs).toEqual(['osd'])
    expect(calls[0].oem).toBe(0) // the legacy engine — OSD runs on nothing else
    expect(calls[0].options).toMatchObject({
      legacyCore: true,
      legacyLang: true,
      langPath: langDir,
      gzip: true,
      cacheMethod: 'none'
    })

    // The recognizer applies the turn to the bytes it reads (an orientation marker).
    await engine.recognize(TINY_PNG, { turn: 270 })
    expect(recognized[0]).not.toBe(TINY_PNG)
    expect(imageOrientation(recognized[0])).toBe(8)

    await engine.stop()
    expect(terminated).toBe(2) // the recognizer AND the orientation worker
    expect(await engine.detectOrientation(TINY_PNG)).toBeNull()
  })

  it('an orientation worker that cannot start switches detection off and leaves text recognition available (#538)', async () => {
    const langDir = tmp()
    writeFileSync(join(langDir, 'osd.traineddata.gz'), 'x')
    let osdStarts = 0
    const mod: TesseractModule = {
      createWorker: async (langs) => {
        if (langs[0] === 'osd') {
          osdStarts += 1
          throw new Error('legacy core missing from this build')
        }
        return {
          recognize: async () => ({ data: { text: 'ok', confidence: 50 } }),
          terminate: async () => undefined
        }
      }
    }
    const engine = new TesseractOcrEngine({ langDir, languages: ['eng'], loadTesseract: async () => mod })
    // Two detections in flight at once (a photo import during an OCR task): the one queued behind
    // the failed start does not start the worker again.
    expect(await Promise.all([engine.detectOrientation(TINY_PNG), engine.detectOrientation(TINY_PNG)])).toEqual([null, null])
    expect(await engine.detectOrientation(TINY_PNG)).toBeNull()
    expect(osdStarts).toBe(1) // not retried for every page
    expect(engine.availability()).toBe('available')
    expect((await engine.recognize(TINY_PNG)).text).toBe('ok')
    await engine.stop()
  })

  it('rewrites app.asar worker paths to app.asar.unpacked (packaged app)', () => {
    expect(
      resolveWorkerScriptPath('C:\\app\\resources\\app.asar\\node_modules\\tesseract.js\\w.js')
    ).toBe('C:\\app\\resources\\app.asar.unpacked\\node_modules\\tesseract.js\\w.js')
    expect(resolveWorkerScriptPath('/opt/app/resources/app.asar/node_modules/t/w.js')).toBe(
      '/opt/app/resources/app.asar.unpacked/node_modules/t/w.js'
    )
    expect(resolveWorkerScriptPath('/dev/checkout/node_modules/t/w.js')).toBe(
      '/dev/checkout/node_modules/t/w.js'
    )
  })
})

// #232 — the worker boundary. tesseract.js sets the browser-only `worker.onerror` on its Node
// Worker and never settles `createWorker()` on a load failure, so a worker that died while
// loading surfaced as `uncaughtException` and killed the app. The fakes below reproduce that
// with a REAL eval-Worker (no mock of `node:worker_threads`): the engine must catch it, reject
// the pending recognition per document, and report `availability() === 'unavailable'`.
describe('TesseractOcrEngine — worker boundary (#232)', () => {
  const base = { langDir: '/ocr', languages: ['eng'] }

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * Run `fn` with vitest's own `uncaughtException` handlers parked, capturing what would have
   * reached them. Before the fix the worker's load failure lands here (the pinned crash); after
   * it nothing must — the engine's own `'error'` listener consumes the event. `fn` returns only
   * after every worker it started has exited (its own observable), so nothing can land after the
   * capture ends.
   */
  async function withUncaughtCapture<T>(fn: (captured: Error[]) => Promise<T>): Promise<T> {
    const captured: Error[] = []
    const previous = process.listeners('uncaughtException')
    process.removeAllListeners('uncaughtException')
    const capture = (err: Error): void => {
      captured.push(err)
    }
    process.on('uncaughtException', capture)
    try {
      return await fn(captured)
    } finally {
      process.removeListener('uncaughtException', capture)
      for (const l of previous) process.on('uncaughtException', l as NodeJS.UncaughtExceptionListener)
    }
  }

  /**
   * A tesseract.js-shaped module whose worker throws while LOADING (the packaged asar gap).
   * `exited` settles when that worker has died, so a test can time the engine's reaction from the
   * failure rather than from the spawn: starting a thread is what full-suite load slows down (#549).
   */
  function loadFailingModule(): { mod: TesseractModule; exited: Promise<void> } {
    let markExited: () => void = () => undefined
    const exited = new Promise<void>((resolve) => {
      markExited = resolve
    })
    const mod: TesseractModule = {
      createWorker: async () => {
        const worker = new Worker(
          'throw new Error("worker module load failed: cannot find hoisted dependency")',
          { eval: true }
        )
        // The browser idiom tesseract.js sets — inert on a Node Worker.
        ;(worker as unknown as { onerror: unknown }).onerror = (): void => undefined
        // 'exit' only: an 'error' listener here would hide the pinned crash from the capture.
        worker.once('exit', () => markExited())
        return new Promise<never>(() => undefined) // never settles, like createWorker.js:243
      }
    }
    return { mod, exited }
  }

  /**
   * A module whose worker starts fine and then dies on its first recognition message. `exits`
   * holds one promise per spawned worker, settled when that worker has exited.
   */
  function crashOnRecognizeModule(): { mod: TesseractModule; spawned: Worker[]; exits: Promise<void>[] } {
    const spawned: Worker[] = []
    const exits: Promise<void>[] = []
    const mod: TesseractModule = {
      createWorker: async () => {
        const raw = new Worker(
          "const { parentPort } = require('node:worker_threads');" +
            "parentPort.on('message', () => { throw new Error('worker crashed mid-recognition') });",
          { eval: true }
        )
        spawned.push(raw)
        // 'exit' only: an 'error' listener here would hide the pinned crash from the capture.
        exits.push(new Promise<void>((r) => raw.once('exit', () => r())))
        return {
          recognize: () => {
            raw.postMessage('go')
            return new Promise<never>(() => undefined) // the job promise never settles either
          },
          terminate: async () => {
            await raw.terminate()
          }
        }
      }
    }
    return { mod, spawned, exits }
  }

  it('a worker that fails at LOAD rejects recognize() per document, reports unavailable, and never escapes as an uncaught exception', async () => {
    await withUncaughtCapture(async (captured) => {
      const { mod, exited } = loadFailingModule()
      const engine = new TesseractOcrEngine({
        ...base,
        loadTesseract: async () => mod
      })
      // Pre-fix the recognition HANGS (createWorker never settles) while the load failure
      // reaches the process as uncaughtException — race it against a short clock so the pin
      // fails fast instead of at the vitest budget. The clock starts once the worker has DIED
      // (#549): the engine rejects on the worker's 'error', which comes before its 'exit', so the
      // fixed version has settled by then however long the thread took to start.
      const outcome = await Promise.race([
        engine.recognize(Buffer.from('img')).then(
          () => 'resolved' as const,
          (err: unknown) => err
        ),
        exited.then(() => new Promise<'hung'>((r) => setTimeout(() => r('hung'), hangBudgetMs(2_000))))
      ])
      expect(outcome).toBeInstanceOf(Error)
      expect((outcome as Error).message).toMatch(/hoisted dependency/)
      expect(engine.availability()).toBe('unavailable')
      await within(exited, 'the load-failing worker exiting')
      expect(captured.map((e) => e.message)).toEqual([])
      await engine.stop()
    })
  })

  it('a worker failure AT RECOGNIZE TIME after a successful probe takes OCR out of service, rejects the in-flight page, and re-arms with one re-probe at the shipped delay', async () => {
    // setImmediate stays real: the engine's worker start waits one real macrotask (its capture hop).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await withUncaughtCapture(async (captured) => {
      const { mod, spawned, exits } = crashOnRecognizeModule()
      const engine = new TesseractOcrEngine({
        ...base,
        loadTesseract: async () => mod,
        probeRequired: true
      })
      // Packaged posture: unproven until the execution probe passes.
      expect(engine.availability()).toBe('probing')
      expect(await engine.probe()).toBe(true)
      expect(engine.availability()).toBe('available')
      // A startup-only probe would leave `ocrAvailable` lying from here on (PR #268 review).
      await expect(engine.recognize(Buffer.from('img'))).rejects.toThrow(/crashed mid-recognition/)
      // "Proved, then died" re-arms rather than latching: one page's WASM abort must not disable
      // OCR for the session (PR #268 review). The re-probe's fresh worker is healthy
      // until its first message, so availability comes back.
      expect(engine.availability()).toBe('probing')
      await vi.advanceTimersByTimeAsync(DEFAULT_OCR_REPROBE_DELAY_MS - 1)
      expect(spawned).toHaveLength(2) // no re-probe yet
      expect(engine.availability()).toBe('probing')
      await vi.advanceTimersByTimeAsync(1)
      await until(() => engine.availability() === 'available', 'the re-probe proving the engine again', 10_000)
      expect(spawned).toHaveLength(3) // probe worker, the one that died, the re-probe worker
      await engine.stop()
      await within(Promise.all(exits), 'every test worker exiting', 10_000)
      expect(captured.map((e) => e.message)).toEqual([])
    })
  })

  it('a re-probe whose start FAILS latches unavailable (a transient death is retried once, a broken build is not)', async () => {
    // setImmediate stays real: the engine's worker start waits one real macrotask (its capture hop).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await withUncaughtCapture(async (captured) => {
      const { mod, exits } = crashOnRecognizeModule()
      let starts = 0
      const brokenAfterDeath: TesseractModule = {
        createWorker: async (langs, oem, options) => {
          starts += 1
          if (starts >= 3) throw new Error('worker module load failed on respawn')
          return mod.createWorker(langs, oem, options)
        }
      }
      const engine = new TesseractOcrEngine({
        ...base,
        loadTesseract: async () => brokenAfterDeath,
        probeRequired: true
      })
      expect(await engine.probe()).toBe(true) // start 1
      await expect(engine.recognize(Buffer.from('img'))).rejects.toThrow(/crashed/) // start 2, dies
      expect(engine.availability()).toBe('probing')
      await vi.advanceTimersByTimeAsync(DEFAULT_OCR_REPROBE_DELAY_MS)
      await until(() => engine.availability() === 'unavailable', 'the failed re-probe latching unavailable') // start 3 rejects
      expect(starts).toBe(3)
      // Latched: the parser skips (`availability() === 'unavailable'`), nothing respawns by itself —
      // the engine arms no further re-probe.
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(DEFAULT_OCR_REPROBE_DELAY_MS * 2)
      expect(starts).toBe(3)
      await engine.stop()
      await within(Promise.all(exits), 'every test worker exiting', 10_000)
      expect(captured.map((e) => e.message)).toEqual([])
    })
  })

  it('probe(): a healthy start proves availability and releases the warm worker; a rejecting or hung start reports unavailable within the bound', async () => {
    const healthy = fakeTesseract()
    const proven = new TesseractOcrEngine({
      ...base,
      loadTesseract: async () => healthy.mod,
      probeRequired: true
    })
    expect(proven.availability()).toBe('probing')
    expect(await proven.probe()).toBe(true)
    expect(proven.availability()).toBe('available')
    // The probe holds no warm worker for a feature most sessions never use — released after
    // the proof, lazily respawned by the first real recognition.
    expect(healthy.terminated.count).toBe(1)
    expect(healthy.starts.length).toBe(1)
    await proven.recognize(Buffer.from('img'))
    expect(healthy.starts.length).toBe(2)
    // A second probe on a proven engine is a cheap no-op (no third worker).
    expect(await proven.probe()).toBe(true)
    expect(healthy.starts.length).toBe(2)
    await proven.stop()

    // tesseract's own `status: 'reject'` load path → createWorker rejects (a corrupt traineddata).
    const rejecting: TesseractModule = {
      createWorker: async () => {
        throw new Error('traineddata unreadable')
      }
    }
    const failed = new TesseractOcrEngine({
      ...base,
      loadTesseract: async () => rejecting,
      probeRequired: true
    })
    expect(await failed.probe()).toBe(false)
    expect(failed.availability()).toBe('unavailable')
    await expect(failed.recognize(Buffer.from('img'))).rejects.toThrow(/traineddata unreadable/)

    // A start that never settles (and spawns nothing) is bounded by the shipped start timeout.
    // setImmediate stays real: the engine's worker start waits one real macrotask (its capture hop).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const hung: TesseractModule = { createWorker: () => new Promise<never>(() => undefined) }
    const timedOut = new TesseractOcrEngine({
      ...base,
      loadTesseract: async () => hung,
      probeRequired: true
    })
    let settled = false
    const probed = timedOut.probe().finally(() => {
      settled = true
    })
    // Armed after the start's real capture hop — `createWorker` being entered is not enough.
    await until(() => vi.getTimerCount() > 0, 'the worker start timer arming')
    await vi.advanceTimersByTimeAsync(DEFAULT_OCR_WORKER_START_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    expect(timedOut.availability()).toBe('probing')
    await vi.advanceTimersByTimeAsync(1)
    expect(await within(probed, 'the hung start timing out')).toBe(false)
    expect(timedOut.availability()).toBe('unavailable')
  })

  it('passes tesseract.js’s errorHandler option (a status:reject must never throw from its message handler) and a dev engine needs no probe', async () => {
    const healthy = fakeTesseract()
    const dev = new TesseractOcrEngine({ ...base, loadTesseract: async () => healthy.mod })
    // No probe required (dev build): available before any worker starts — today's behaviour.
    expect(dev.availability()).toBe('available')
    await dev.recognize(Buffer.from('img'))
    const { errorHandler } = healthy.starts[0].options
    expect(typeof errorHandler).toBe('function')
    // The handler itself never throws (tesseract calls it with the rejection payload).
    expect(() => (errorHandler as (d: unknown) => void)('bad image')).not.toThrow()
    await dev.stop()
  })
})

describe('no-CDN sentinel (R-O2: zero remote hosts in app code)', () => {
  it('no tesseract/pdfjs CDN host appears anywhere under src/', () => {
    const SRC = join(__dirname, '../../src')
    const offenders: string[] = []
    const HOSTS = ['cdn.jsdelivr.net', 'tessdata.projectnaptha.com', 'unpkg.com']
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|tsx|html|css|json)$/.test(name)) continue
        const text = readFileSync(full, 'utf8')
        for (const host of HOSTS) {
          if (text.includes(host)) offenders.push(`${full}: ${host}`)
        }
      }
    }
    walk(SRC)
    expect(offenders).toEqual([])
  })
})

describe('OCR preload channel contract', () => {
  it('the sandboxed preload literals match shared/ipc OCR_RASTER', async () => {
    // The preload hardcodes the channel names (a sandboxed preload must be a single
    // file — importing shared/ipc would split a chunk it cannot require). Keep them
    // in lockstep here.
    const src = readFileSync(join(__dirname, '../../src/preload/ocr.ts'), 'utf8')
    const { OCR_RASTER } = await import('../../src/shared/ipc')
    for (const channel of Object.values(OCR_RASTER)) {
      expect(src).toContain(`'${channel}'`)
    }
  })
})
