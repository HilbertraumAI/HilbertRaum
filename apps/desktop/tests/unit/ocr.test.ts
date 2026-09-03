import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
import { isImagePath, isPdfPath, selectParser, supportedExtensions } from '../../src/main/services/ingestion/parsers'
import {
  createSelectedOcrEngine,
  listOcrLanguages,
  ocrAssetsDir,
  TesseractOcrEngine,
  type OcrAvailability,
  type OcrEngine
} from '../../src/main/services/ocr'
import { resolveWorkerScriptPath, type TesseractModule } from '../../src/main/services/ocr/tesseract'
import { validateRuntimeSources } from '../../src/shared/runtime-sources'
import { planOcrDownloads, sha256Of } from '../../src/main/services/assets'
import { makePdf, makeScanOnlyPdf, makeHybridPdf, TINY_PNG } from '../helpers/fixtures'
import { sha256File } from '../../src/main/services/models'

// Phase 38 — scanned-PDF detection (step 0), the OCR engine seam + offline wiring
// (R-O2), the factory's availability rule (D14/D9: null, never a mock), the ocr:
// asset class on runtime-sources.yaml (D32), and the no-CDN sentinel. CI posture:
// zero network, zero models — the real tesseract.js module is never loaded here.

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-ocr-'))
}

describe('image-only PDF detection (step 0)', () => {
  it('fails a true scan with the friendly notice', async () => {
    const dir = tmp()
    const p = join(dir, 'scan.pdf')
    writeFileSync(p, makeScanOnlyPdf(2))
    await expect(PdfParser.parse(p)).rejects.toThrow(PDF_SCAN_DETECTED_MESSAGE)
  })

  it('does NOT detect a hybrid text+scan PDF — its text pages index normally', async () => {
    const dir = tmp()
    const p = join(dir, 'hybrid.pdf')
    writeFileSync(p, makeHybridPdf())
    const parsed = await PdfParser.parse(p)
    expect(parsed.segments.length).toBe(1)
    expect(parsed.segments[0].pageNumber).toBe(1)
    expect(parsed.segments[0].text).toContain('real text layer')
  })

  it('parses a normal text PDF unchanged', async () => {
    const dir = tmp()
    const p = join(dir, 'normal.pdf')
    writeFileSync(p, makePdf('An ordinary text page with plenty of readable words on it.'))
    const parsed = await PdfParser.parse(p)
    expect(parsed.segments.length).toBe(1)
    expect(parsed.segments[0].text).toContain('ordinary text page')
  })

  it('uses stored OCR pages for a scan instead of failing (re-index/preview hook)', async () => {
    const dir = tmp()
    const p = join(dir, 'scan.pdf')
    writeFileSync(p, makeScanOnlyPdf(2))
    const parsed = await PdfParser.parse(p, {
      ocrPages: [
        { pageNumber: 1, text: 'Recognized page one text.' },
        { pageNumber: 2, text: 'Recognized page two text.' }
      ]
    })
    expect(parsed.segments.map((s) => s.pageNumber)).toEqual([1, 2])
    expect(parsed.segments[1].text).toBe('Recognized page two text.')
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
  const fakeEngine = (text: string): OcrEngine => ({
    id: 'fake-ocr',
    languages: ['deu', 'eng'],
    recognize: async () => ({ text, confidence: 92 })
  })

  it('registers png/jpg/jpeg and the path helpers agree', () => {
    const exts = supportedExtensions()
    for (const e of ['.png', '.jpg', '.jpeg']) expect(exts).toContain(e)
    expect(selectParser('photo.PNG')?.name).toBe('image')
    expect(isImagePath('a/b/photo.jpeg')).toBe(true)
    expect(isImagePath('a/b/doc.pdf')).toBe(false)
    expect(isPdfPath('a/b/doc.PDF')).toBe(true)
  })

  it('recognizes a photo into one page-less segment', async () => {
    const dir = tmp()
    const p = join(dir, 'page.png')
    writeFileSync(p, TINY_PNG)
    const parsed = await ImageParser.parse(p, { ocrEngine: fakeEngine('Hello recognized world') })
    expect(parsed.segments).toEqual([
      { text: 'Hello recognized world', pageNumber: null, sectionLabel: null }
    ])
  })

  it('fails friendly without an engine (no OCR files on the drive)', async () => {
    const dir = tmp()
    const p = join(dir, 'page.png')
    writeFileSync(p, TINY_PNG)
    await expect(ImageParser.parse(p, {})).rejects.toThrow(IMAGE_NEEDS_OCR_MESSAGE)
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
    await expect(ImageParser.parse(p, { ocrEngine: fakeEngine('   ') })).rejects.toThrow(
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
  it('returns null when the ocr/ dir is absent or empty', () => {
    const root = tmp()
    const reasons: string[] = []
    expect(
      createSelectedOcrEngine({ rootPath: root, onSelect: (_k, r) => reasons.push(r) })
    ).toBeNull()
    expect(reasons[0]).toContain('no OCR language files')
  })

  it('selects an engine over the languages actually present (sorted)', () => {
    const root = tmp()
    const dir = ocrAssetsDir(root)
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(dir, { recursive: true })
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

describe('TesseractOcrEngine (offline wiring — R-O2)', () => {
  function fakeModule(): {
    mod: { createWorker: (...a: unknown[]) => Promise<unknown> }
    calls: Array<{ langs: string[]; oem: number; options: Record<string, unknown> }>
    recognized: Buffer[]
    terminated: { value: boolean }
  } {
    const calls: Array<{ langs: string[]; oem: number; options: Record<string, unknown> }> = []
    const recognized: Buffer[] = []
    const terminated = { value: false }
    const mod = {
      createWorker: async (langs: unknown, oem: unknown, options: unknown) => {
        calls.push({
          langs: langs as string[],
          oem: oem as number,
          options: options as Record<string, unknown>
        })
        return {
          recognize: async (img: Buffer) => {
            recognized.push(img)
            return { data: { text: `text-${recognized.length}`, confidence: 90 } }
          },
          terminate: async () => {
            terminated.value = true
          }
        }
      }
    }
    return { mod, calls, recognized, terminated }
  }

  it('passes the explicit offline options: local langPath, gzip, no cache, LSTM-only', async () => {
    const { mod, calls } = fakeModule()
    const engine = new TesseractOcrEngine({
      langDir: 'X:/drive/ocr',
      languages: ['deu', 'eng'],
      loadTesseract: async () => mod as never
    })
    await engine.recognize(Buffer.from('img'))
    expect(calls.length).toBe(1)
    expect(calls[0].langs).toEqual(['deu', 'eng'])
    expect(calls[0].oem).toBe(1) // LSTM_ONLY — the vendored data is LSTM-only (R-O3)
    expect(calls[0].options.langPath).toBe('X:/drive/ocr')
    expect(calls[0].options.gzip).toBe(true)
    expect(calls[0].options.cacheMethod).toBe('none')
  })

  it('reuses one worker across recognitions and terminates on stop()', async () => {
    const { mod, calls, recognized, terminated } = fakeModule()
    const engine = new TesseractOcrEngine({
      langDir: '/ocr',
      languages: ['eng'],
      loadTesseract: async () => mod as never
    })
    const [a, b] = await Promise.all([
      engine.recognize(Buffer.from('1')),
      engine.recognize(Buffer.from('2'))
    ])
    expect(calls.length).toBe(1) // one warm worker
    expect(recognized.length).toBe(2)
    expect([a.text, b.text].sort()).toEqual(['text-1', 'text-2'])
    await engine.stop()
    expect(terminated.value).toBe(true)
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
    let firstStarted = false
    const mod = {
      createWorker: async () => {
        created++
        return {
          recognize: (_img: Buffer) => {
            if (!firstStarted) {
              firstStarted = true
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
    while (!firstStarted) await new Promise((r) => setImmediate(r))
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
    const { mod, calls, terminated } = fakeModule()
    const engine = new TesseractOcrEngine({
      langDir: '/ocr',
      languages: ['eng'],
      loadTesseract: async () => mod as TesseractModule
    })
    const first = await engine.recognize(Buffer.from('1'))
    expect(first.text).toBe('text-1')
    expect(calls.length).toBe(1)

    await engine.suspend()
    expect(terminated.value).toBe(true) // the warm worker was terminated

    // Non-latching: a fresh worker respawns and the recognition succeeds.
    const second = await engine.recognize(Buffer.from('2'))
    expect(second.text).toBe('text-2')
    expect(calls.length).toBe(2) // a SECOND worker was spawned (unlike after stop())
  })

  // REL-2 (TEST-4): a per-page recognition that exceeds the timeout terminates the worker
  // (a tesseract.js WASM job is not cooperatively cancellable) and rejects — so one wedged
  // image can't block the serialized chain for the rest of the scan. The next page gets a
  // fresh worker and succeeds. Teeth: a huge recognizeTimeoutMs makes page 1 hang forever.
  it('terminates the worker on a per-page timeout and recovers on the next page (REL-2)', async () => {
    let created = 0
    let terminated = 0
    type FakeResult = { data: { text: string; confidence: number } }
    const mod = {
      createWorker: async () => {
        const myIndex = ++created
        return {
          recognize: (_img: Buffer): Promise<FakeResult> =>
            myIndex === 1
              ? new Promise<FakeResult>(() => undefined) // first worker: wedge forever
              : Promise.resolve({ data: { text: 'recovered', confidence: 88 } }),
          terminate: async () => {
            terminated += 1
          }
        }
      }
    }
    const engine = new TesseractOcrEngine({
      langDir: '/ocr',
      languages: ['eng'],
      loadTesseract: async () => mod as never,
      recognizeTimeoutMs: 20
    })
    // Page 1 wedges → times out → worker #1 terminated → rejects.
    await expect(engine.recognize(Buffer.from('p1'))).rejects.toThrow(/timed out/i)
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
    type FakeResult = { data: { text: string; confidence: number } }
    const mod = {
      createWorker: async () => ({
        recognize: (_img: Buffer): Promise<FakeResult> => new Promise<FakeResult>(() => undefined),
        terminate: async () => {
          terminated += 1
        }
      })
    }
    const engine = new TesseractOcrEngine({
      langDir: '/ocr',
      languages: ['eng'],
      loadTesseract: async () => mod as never,
      recognizeTimeoutMs: 60_000 // long — the abort, not the timeout, is what fires
    })
    const controller = new AbortController()
    const call = engine.recognize(Buffer.from('p'), { signal: controller.signal })
    await new Promise((r) => setImmediate(r))
    controller.abort()
    await expect(call).rejects.toThrow(/abort/i)
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
    const mod = {
      createWorker: async () => {
        const myIndex = created++
        // Gate the FIRST init so it is still in flight when stop() fires.
        if (myIndex === 0) await initGate
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
      loadTesseract: async () => mod as never
    })

    // A recognize() drives ensureWorker() → createWorker enters and parks (init #0 in flight).
    const rec = engine.recognize(Buffer.from('p')).then(
      () => 'ok',
      () => 'failed'
    )
    while (created === 0) await new Promise((r) => setTimeout(r, 1))
    expect(created).toBe(1)

    // stop() fires while init #0 is parked. terminateWorker must await it, then terminate worker #0.
    const stopP = engine.stop()
    // Let terminateWorker register its await on this.starting: one macrotask hop over a pure
    // microtask chain — deterministic; a lost race only weakens the interleave, never the
    // assertions (releaseInit()/await stopP below are the real gates) (TS-1: justified fixed sleep).
    await new Promise((r) => setTimeout(r, 2))

    releaseInit() // init #0 resolves → worker #0 is born
    await stopP
    await rec

    expect(created).toBe(1) // no second worker was spawned
    expect(terminated[0]).toBe(true) // the late-born worker was terminated, not leaked past the lock
  })

  // BE-9 (ocr-audit 2026-07-18): the engine id must be DERIVED from the installed tesseract.js
  // version, not a hardcoded literal — a future bump would otherwise stamp a wrong
  // `ocr_json.engineId` provenance. TEETH: an injected version proves the id is derived (pre-fix
  // `this.id` was the frozen string 'tesseract.js-7.0.0' regardless).
  it('derives the engine id from the tesseract.js version (BE-9)', async () => {
    const injected = new TesseractOcrEngine({
      langDir: '/ocr',
      languages: ['eng'],
      resolveVersion: () => '9.9.9-test'
    })
    expect(injected.id).toBe('tesseract.js-9.9.9-test')

    // By default the real installed package version flows through (byte-identical today).
    const { createRequire } = await import('node:module')
    const { version } = createRequire(import.meta.url)('tesseract.js/package.json') as {
      version: string
    }
    const real = new TesseractOcrEngine({ langDir: '/ocr', languages: ['eng'] })
    expect(real.id).toBe(`tesseract.js-${version}`)
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
// the pending recognition per document, and report `isAvailable() === false`.
describe('TesseractOcrEngine — worker boundary (#232)', () => {
  const base = { langDir: '/ocr', languages: ['eng'] }

  /**
   * Run `fn` with vitest's own `uncaughtException` handlers parked, capturing what would have
   * reached them. Before the fix the worker's load failure lands here (the pinned crash); after
   * it nothing must — the engine's own `'error'` listener consumes the event.
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
      // Let a straggling 'error' event land before the real handlers come back.
      await new Promise((r) => setTimeout(r, 50))
      process.removeListener('uncaughtException', capture)
      for (const l of previous) process.on('uncaughtException', l as NodeJS.UncaughtExceptionListener)
    }
  }

  /** A tesseract.js-shaped module whose worker throws while LOADING (the packaged asar gap). */
  function loadFailingModule(): TesseractModule {
    return {
      createWorker: async () => {
        const worker = new Worker(
          'throw new Error("worker module load failed: cannot find hoisted dependency")',
          { eval: true }
        )
        // The browser idiom tesseract.js sets — inert on a Node Worker.
        ;(worker as unknown as { onerror: unknown }).onerror = (): void => undefined
        return new Promise<never>(() => undefined) // never settles, like createWorker.js:243
      }
    }
  }

  /** A module whose worker starts fine and then dies on its first recognition message. */
  function crashOnRecognizeModule(): { mod: TesseractModule; spawned: Worker[] } {
    const spawned: Worker[] = []
    const mod: TesseractModule = {
      createWorker: async () => {
        const raw = new Worker(
          "const { parentPort } = require('node:worker_threads');" +
            "parentPort.on('message', () => { throw new Error('worker crashed mid-recognition') });",
          { eval: true }
        )
        spawned.push(raw)
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
    return { mod, spawned }
  }

  function healthyModule(): {
    mod: TesseractModule
    calls: Array<Record<string, unknown>>
    terminated: { count: number }
  } {
    const calls: Array<Record<string, unknown>> = []
    const terminated = { count: 0 }
    const mod: TesseractModule = {
      createWorker: async (_langs, _oem, options) => {
        calls.push(options)
        return {
          recognize: async () => ({ data: { text: 'ok', confidence: 90 } }),
          terminate: async () => {
            terminated.count += 1
          }
        }
      }
    }
    return { mod, calls, terminated }
  }

  it('a worker that fails at LOAD rejects recognize() per document, reports unavailable, and never escapes as an uncaught exception', async () => {
    await withUncaughtCapture(async (captured) => {
      const engine = new TesseractOcrEngine({
        ...base,
        loadTesseract: async () => loadFailingModule(),
        workerStartTimeoutMs: 5_000
      })
      // Pre-fix the recognition HANGS (createWorker never settles) while the load failure
      // reaches the process as uncaughtException — race it against a short clock so the pin
      // fails fast instead of at the vitest budget.
      const outcome = await Promise.race([
        engine.recognize(Buffer.from('img')).then(
          () => 'resolved' as const,
          (err: unknown) => err
        ),
        new Promise<'hung'>((r) => setTimeout(() => r('hung'), 2_000))
      ])
      expect(outcome).toBeInstanceOf(Error)
      expect((outcome as Error).message).toMatch(/hoisted dependency/)
      expect(engine.isAvailable()).toBe(false)
      expect(engine.availability()).toBe('unavailable')
      expect(captured.map((e) => e.message)).toEqual([])
      await engine.stop()
    })
  })

  /** Poll a real deadline for an engine state (real timers — the re-probe is a real setTimeout). */
  async function waitForState(
    engine: TesseractOcrEngine,
    want: OcrAvailability,
    timeoutMs = 3_000
  ): Promise<void> {
    const t0 = Date.now()
    while (engine.availability() !== want) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`state stayed ${engine.availability()}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('a worker failure AT RECOGNIZE TIME after a successful probe flips isAvailable() to false, rejects the in-flight page, and re-arms with one re-probe', async () => {
    await withUncaughtCapture(async (captured) => {
      const { mod, spawned } = crashOnRecognizeModule()
      const engine = new TesseractOcrEngine({
        ...base,
        loadTesseract: async () => mod,
        probeRequired: true,
        reprobeDelayMs: 20
      })
      // Packaged posture: unproven until the execution probe passes.
      expect(engine.availability()).toBe('probing')
      expect(engine.isAvailable()).toBe(false)
      expect(await engine.probe()).toBe(true)
      expect(engine.isAvailable()).toBe(true)
      // A startup-only probe would leave `ocrAvailable` lying from here on (PR #268 review).
      await expect(engine.recognize(Buffer.from('img'))).rejects.toThrow(/crashed mid-recognition/)
      expect(engine.isAvailable()).toBe(false)
      // "Proved, then died" re-arms rather than latching: one page's WASM abort must not disable
      // OCR for the session (PR #268 review). The re-probe's fresh worker is healthy
      // until its first message, so availability comes back.
      expect(engine.availability()).toBe('probing')
      await waitForState(engine, 'available')
      expect(spawned.length).toBe(3) // probe worker, the one that died, the re-probe worker
      expect(captured.map((e) => e.message)).toEqual([])
      await engine.stop()
    })
  })

  it('a re-probe whose start FAILS latches unavailable (a transient death is retried once, a broken build is not)', async () => {
    await withUncaughtCapture(async (captured) => {
      const { mod } = crashOnRecognizeModule()
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
        probeRequired: true,
        reprobeDelayMs: 20
      })
      expect(await engine.probe()).toBe(true) // start 1
      await expect(engine.recognize(Buffer.from('img'))).rejects.toThrow(/crashed/) // start 2, dies
      expect(engine.availability()).toBe('probing')
      await waitForState(engine, 'unavailable') // start 3 rejects → latched
      expect(starts).toBe(3)
      // Latched: the parser skips (`availability() === 'unavailable'`), nothing respawns by itself.
      await new Promise((r) => setTimeout(r, 60))
      expect(starts).toBe(3)
      expect(captured.map((e) => e.message)).toEqual([])
      await engine.stop()
    })
  })

  it('probe(): a healthy start proves availability and releases the warm worker; a rejecting or hung start reports unavailable within the bound', async () => {
    const healthy = healthyModule()
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
    expect(healthy.calls.length).toBe(1)
    await proven.recognize(Buffer.from('img'))
    expect(healthy.calls.length).toBe(2)
    expect(proven.isAvailable()).toBe(true)
    // A second probe on a proven engine is a cheap no-op (no third worker).
    expect(await proven.probe()).toBe(true)
    expect(healthy.calls.length).toBe(2)
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

    // A start that never settles (and spawns nothing) is bounded by the start timeout.
    const hung: TesseractModule = { createWorker: () => new Promise<never>(() => undefined) }
    const timedOut = new TesseractOcrEngine({
      ...base,
      loadTesseract: async () => hung,
      probeRequired: true,
      workerStartTimeoutMs: 200
    })
    const t0 = Date.now()
    expect(await timedOut.probe()).toBe(false)
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(timedOut.availability()).toBe('unavailable')
  })

  it('passes tesseract.js’s errorHandler option (a status:reject must never throw from its message handler) and a dev engine needs no probe', async () => {
    const healthy = healthyModule()
    const dev = new TesseractOcrEngine({ ...base, loadTesseract: async () => healthy.mod })
    // No probe required (dev build): available before any worker starts — today's behaviour.
    expect(dev.availability()).toBe('available')
    expect(dev.isAvailable()).toBe(true)
    await dev.recognize(Buffer.from('img'))
    expect(typeof healthy.calls[0].errorHandler).toBe('function')
    // The handler itself never throws (tesseract calls it with the rejection payload).
    expect(() => (healthy.calls[0].errorHandler as (d: unknown) => void)('bad image')).not.toThrow()
    await dev.stop()
  })
})

describe('runtime-sources.yaml ocr: block (D32)', () => {
  const base = {
    llama_cpp: {
      version: 'b1',
      builds: [
        { os: 'win', arch: 'x64', backend: 'cpu', url: 'https://x/f.gz', sha256: 'h', extract_to: 'runtime/llama.cpp/win' }
      ]
    }
  }

  it('absent block stays valid (forward compatibility)', () => {
    const r = validateRuntimeSources(base)
    expect(r.ok).toBe(true)
    expect(r.ocr).toBeUndefined()
  })

  it('parses a valid ocr block', () => {
    const r = validateRuntimeSources({
      ...base,
      ocr: {
        version: '4.0.0_best_int',
        files: [
          { lang: 'deu', url: 'https://x/deu.gz', sha256: 'A'.repeat(64), dest: 'ocr/deu.traineddata.gz' },
          { lang: 'eng', url: 'https://x/eng.gz', sha256: 'b'.repeat(64), dest: 'ocr/eng.traineddata.gz' }
        ]
      }
    })
    expect(r.ok).toBe(true)
    expect(r.ocr?.files.map((f) => f.lang)).toEqual(['deu', 'eng'])
    expect(r.ocr?.files[0].sha256).toBe('a'.repeat(64)) // normalized lower-case
  })

  it('rejects malformed blocks: missing fields, dup langs, escaping dest', () => {
    expect(
      validateRuntimeSources({ ...base, ocr: { version: 'v', files: [{ lang: 'deu' }] } }).ok
    ).toBe(false)
    expect(
      validateRuntimeSources({
        ...base,
        ocr: {
          version: 'v',
          files: [
            { lang: 'deu', url: 'https://x/f.gz', sha256: 'h', dest: 'ocr/a.gz' },
            { lang: 'deu', url: 'https://x/f.gz', sha256: 'h', dest: 'ocr/b.gz' }
          ]
        }
      }).ok
    ).toBe(false)
    expect(
      validateRuntimeSources({
        ...base,
        ocr: { version: 'v', files: [{ lang: 'deu', url: 'https://x/f.gz', sha256: 'h', dest: '../escape.gz' }] }
      }).ok
    ).toBe(false)
  })

  it('the committed runtime-sources.yaml carries a fully-pinned ocr block', async () => {
    const yaml = await import('yaml')
    const raw = yaml.parse(
      readFileSync(join(__dirname, '../../../../model-manifests/runtime-sources.yaml'), 'utf8')
    )
    const r = validateRuntimeSources(raw)
    expect(r.ok).toBe(true)
    expect(r.ocr).toBeDefined()
    expect(r.ocr?.files.map((f) => f.lang).sort()).toEqual(['deu', 'eng'])
    for (const f of r.ocr?.files ?? []) {
      expect(f.sha256).toMatch(/^[a-f0-9]{64}$/) // real pins, no placeholders
      expect(f.dest.startsWith('ocr/')).toBe(true)
    }
  })
})

describe('planOcrDownloads (assets.ts)', () => {
  const sources = (sha: string) => ({
    version: 'v',
    files: [{ lang: 'deu', url: 'https://x/deu.gz', sha256: sha, dest: 'ocr/deu.traineddata.gz' }]
  })

  it('absent file → download; matching file → present-verified; mismatch → download', async () => {
    const root = tmp()
    const data = Buffer.from('traineddata-bytes')
    const sha = sha256Of(data)

    let plan = await planOcrDownloads(root, sources(sha))
    expect(plan[0].status).toBe('download')

    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(join(root, 'ocr'), { recursive: true })
    writeFileSync(join(root, 'ocr', 'deu.traineddata.gz'), data)
    plan = await planOcrDownloads(root, sources(sha))
    expect(plan[0].status).toBe('present-verified')

    writeFileSync(join(root, 'ocr', 'deu.traineddata.gz'), 'tampered')
    plan = await planOcrDownloads(root, sources(sha))
    expect(plan[0].status).toBe('download')

    plan = await planOcrDownloads(root, sources('REPLACE_WITH_REAL_HASH'))
    expect(plan[0].status).toBe('present-unverified')
  })

  it('rejects a dest escaping the drive root', async () => {
    const root = tmp()
    await expect(
      planOcrDownloads(root, {
        version: 'v',
        files: [{ lang: 'deu', url: 'https://x/f.gz', sha256: 'h', dest: '../outside.gz' }]
      })
    ).rejects.toThrow(/escapes the drive root/)
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
