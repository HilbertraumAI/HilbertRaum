import { join } from 'node:path'
import type { OcrEngine, OcrRecognizeOptions, OcrResult } from './index'

// tesseract.js OCR backend (Phase 38). Node mode only (D31/R-O1): the worker script
// and the WASM core load from the app's own pinned npm packages; image bytes are
// decoded inside the WASM core (no canvas anywhere in the main process).
//
// The R-O2 offline wiring is the load-bearing part — tesseract.js's DEFAULTS phone a
// CDN and write a cache into the current directory, so every option here is explicit:
//   - `langPath`  → the drive's `ocr/` dir (never the remote-CDN default)
//   - `gzip: true` → reads the vendored `<lang>.traineddata.gz` exactly as shipped
//   - `cacheMethod: 'none'` → no surprise `./{lang}.traineddata` writes
//   - `workerPath` → resolved explicitly, with the packaged-app `app.asar` →
//     `app.asar.unpacked` rewrite (worker_threads cannot load a script out of asar;
//     electron-builder.yml unpacks both tesseract packages)
//
// One worker is created lazily on first use and reused across pages/files (init costs
// ~0.3 s); recognitions are serialized through a promise chain — tesseract.js workers
// are single-job. `stop()` terminates the worker (will-quit / lock).

/** OEM 1 = LSTM_ONLY. The vendored traineddata is LSTM-only (R-O3: the WASM core
 * cannot run legacy/float models — `tessdata_best` float crashes it). */
const OEM_LSTM_ONLY = 1

export interface TesseractOcrEngineOptions {
  /** Directory containing the vendored `<lang>.traineddata.gz` files. */
  langDir: string
  /** Languages to recognize with (files proven present by the factory). */
  languages: string[]
  /**
   * Injection seam for tests: returns the tesseract.js module (its `createWorker`).
   * Default lazily `require`s the real pinned package on first recognition.
   */
  loadTesseract?: () => Promise<TesseractModule>
}

/** The slice of tesseract.js this engine touches (kept narrow for the fake). */
export interface TesseractModule {
  createWorker(
    langs: string[],
    oem: number,
    options: Record<string, unknown>
  ): Promise<TesseractWorker>
}

export interface TesseractWorker {
  recognize(image: Buffer): Promise<{ data: { text: string; confidence: number } }>
  terminate(): Promise<unknown>
}

/**
 * Resolve the Node worker script tesseract.js spawns, rewriting an `app.asar` path to
 * its `app.asar.unpacked` twin: `worker_threads` loads scripts via real filesystem
 * reads, which cannot see inside the archive (R-O2 packaged-app caveat). Exported for
 * the vendored-path unit test.
 */
export function resolveWorkerScriptPath(resolved: string): string {
  return resolved.replace(/\bapp\.asar([\\/])/, 'app.asar.unpacked$1')
}

async function loadRealTesseract(): Promise<TesseractModule> {
  // Lazy import (the parser-lib precedent): the package only loads when a recognition
  // actually happens. `tesseract.js` is CJS; the dynamic import interops fine.
  const mod = (await import('tesseract.js')) as unknown as
    | TesseractModule
    | { default: TesseractModule }
  return 'createWorker' in mod ? mod : (mod as { default: TesseractModule }).default
}

export class TesseractOcrEngine implements OcrEngine {
  readonly id: string
  readonly languages: readonly string[]

  private readonly opts: TesseractOcrEngineOptions
  private worker: TesseractWorker | null = null
  private starting: Promise<TesseractWorker> | null = null
  /** Serializes recognitions — a tesseract worker handles one job at a time. */
  private chain: Promise<unknown> = Promise.resolve()
  private stopped = false

  constructor(opts: TesseractOcrEngineOptions) {
    this.opts = opts
    this.languages = [...opts.languages]
    this.id = 'tesseract.js-7.0.0'
  }

  private async ensureWorker(): Promise<TesseractWorker> {
    if (this.worker) return this.worker
    if (!this.starting) {
      this.starting = (async () => {
        const tesseract = await (this.opts.loadTesseract ?? loadRealTesseract)()
        let workerPath: string | undefined
        try {
          workerPath = resolveWorkerScriptPath(
            require.resolve('tesseract.js/src/worker-script/node/index.js')
          )
        } catch {
          workerPath = undefined // fake module in tests / exotic layout: use its default
        }
        const worker = await tesseract.createWorker([...this.opts.languages], OEM_LSTM_ONLY, {
          // R-O2: every path explicit and LOCAL — never the CDN/cache defaults.
          langPath: this.opts.langDir,
          gzip: true,
          cacheMethod: 'none',
          ...(workerPath ? { workerPath } : {})
        })
        this.worker = worker
        return worker
      })()
      this.starting.catch(() => {
        this.starting = null // a failed init must not poison later attempts
      })
    }
    return this.starting
  }

  async recognize(image: Buffer, opts: OcrRecognizeOptions = {}): Promise<OcrResult> {
    if (this.stopped) throw new Error('OCR engine is stopped')
    const run = this.chain.then(async (): Promise<OcrResult> => {
      if (opts.signal?.aborted) {
        throw new DOMException('OCR recognition aborted', 'AbortError')
      }
      const worker = await this.ensureWorker()
      const result = await worker.recognize(image)
      const confidence =
        typeof result.data.confidence === 'number' && Number.isFinite(result.data.confidence)
          ? result.data.confidence
          : null
      return { text: result.data.text ?? '', confidence }
    })
    // The chain must survive a failed job (keep serializing, swallow for the chain only).
    this.chain = run.catch(() => undefined)
    return run
  }

  async stop(): Promise<void> {
    this.stopped = true
    const worker = this.worker
    this.worker = null
    this.starting = null
    if (worker) {
      try {
        await worker.terminate()
      } catch {
        // Termination is best-effort — the process is quitting/locking anyway.
      }
    }
  }
}

export function createTesseractOcrEngine(opts: TesseractOcrEngineOptions): TesseractOcrEngine {
  return new TesseractOcrEngine(opts)
}
