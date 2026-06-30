import { join } from 'node:path'
import type { OcrEngine, OcrRecognizeOptions, OcrResult } from './index'

// tesseract.js OCR backend. Node mode only: the worker script
// and the WASM core load from the app's own pinned npm packages; image bytes are
// decoded inside the WASM core (no canvas anywhere in the main process).
//
// The offline wiring is the load-bearing part — tesseract.js's DEFAULTS phone a
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

/** OEM 1 = LSTM_ONLY. The vendored traineddata is LSTM-only (the WASM core
 * cannot run legacy/float models — `tessdata_best` float crashes it). */
const OEM_LSTM_ONLY = 1

/**
 * Per-PAGE recognition timeout ceiling (REL-2). A tesseract.js WASM job cannot be
 * cooperatively cancelled — once `worker.recognize()` is in flight a crafted/huge image
 * could spin for the whole session, and because recognitions are serialized through one
 * worker chain, one wedged page would block every later page. So a page that exceeds this
 * ceiling terminates the worker (recreated lazily) and rejects, freeing the chain. 2 min is
 * generous for a single ≤4096px page even on slow hardware. Override with
 * `HILBERTRAUM_OCR_PAGE_TIMEOUT_MS` or per instance via `recognizeTimeoutMs` (tests).
 */
export const DEFAULT_OCR_PAGE_TIMEOUT_MS = 2 * 60 * 1000

function resolveOcrPageTimeoutMs(explicit?: number): number {
  if (typeof explicit === 'number' && explicit > 0) return explicit
  const env = Number(process.env.HILBERTRAUM_OCR_PAGE_TIMEOUT_MS)
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_OCR_PAGE_TIMEOUT_MS
}

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
  /**
   * Per-page recognition timeout in ms (REL-2). Default `DEFAULT_OCR_PAGE_TIMEOUT_MS`
   * (env-overridable). Injected small in tests to exercise the terminate-on-timeout path.
   */
  recognizeTimeoutMs?: number
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
 * reads, which cannot see inside the archive (packaged-app caveat). Exported for
 * the vendored-path unit test.
 */
export function resolveWorkerScriptPath(resolved: string): string {
  return resolved.replace(/\bapp\.asar([\\/])/, 'app.asar.unpacked$1')
}

async function loadRealTesseract(): Promise<TesseractModule> {
  // Lazy import: the package only loads when a recognition
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
  private readonly recognizeTimeoutMs: number
  private worker: TesseractWorker | null = null
  private starting: Promise<TesseractWorker> | null = null
  /** Serializes recognitions — a tesseract worker handles one job at a time. */
  private chain: Promise<unknown> = Promise.resolve()
  private stopped = false

  constructor(opts: TesseractOcrEngineOptions) {
    this.opts = opts
    this.recognizeTimeoutMs = resolveOcrPageTimeoutMs(opts.recognizeTimeoutMs)
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
          // Every path explicit and LOCAL — never the CDN/cache defaults.
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
      return this.recognizeWithTimeout(worker, image, opts.signal)
    })
    // The chain must survive a failed job (keep serializing, swallow for the chain only).
    this.chain = run.catch(() => undefined)
    return run
  }

  /**
   * Race `worker.recognize` against the per-page timeout and the abort signal (REL-2). A
   * tesseract.js WASM job is not cooperatively cancellable, so on timeout OR abort the only
   * real recovery is to TERMINATE the worker (recreated lazily on the next page) and reject
   * — that frees the serialized chain so one wedged image can't block the rest of the scan.
   * A plain recognition error leaves the worker intact (its existing behaviour).
   */
  private async recognizeWithTimeout(
    worker: TesseractWorker,
    image: Buffer,
    signal?: AbortSignal
  ): Promise<OcrResult> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    let interrupted: 'timeout' | 'abort' | null = null
    try {
      const result = await new Promise<{ data: { text: string; confidence: number } }>(
        (resolve, reject) => {
          timer = setTimeout(() => {
            interrupted = 'timeout'
            reject(new Error(`OCR recognition timed out after ${this.recognizeTimeoutMs} ms`))
          }, this.recognizeTimeoutMs)
          onAbort = (): void => {
            interrupted = 'abort'
            reject(new DOMException('OCR recognition aborted', 'AbortError'))
          }
          if (signal?.aborted) onAbort()
          else signal?.addEventListener('abort', onAbort, { once: true })
          // The WASM job keeps running after a timeout/abort win; terminate() (below)
          // discards it. Its late settle resolves into the void — harmless.
          worker.recognize(image).then(resolve, reject)
        }
      )
      const confidence =
        typeof result.data.confidence === 'number' && Number.isFinite(result.data.confidence)
          ? result.data.confidence
          : null
      return { text: result.data.text ?? '', confidence }
    } catch (err) {
      if (interrupted) await this.terminateWorker()
      throw err
    } finally {
      if (timer) clearTimeout(timer)
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Terminate the warm worker (best-effort) and clear it so it is recreated lazily.
   *
   * REL-1 (full-audit-2026-06-29 follow-up): an init may be IN FLIGHT when this runs out of band
   * — `stop()` (workspace lock / quit) calls this directly, NOT through `this.chain`, so it can
   * interleave with an `ensureWorker()` started inside a chained `recognize()`. The old code nulled
   * `this.starting` unconditionally; a still-PENDING init was then orphaned — it later resolved and
   * installed a worker that OUTLIVED this teardown (a leaked WASM worker), and a concurrent
   * `ensureWorker()` seeing a null latch could spawn a SECOND worker. Mirror the e5/reranker
   * teardown: AWAIT the in-flight init so the worker it produces is the one we terminate, and only
   * clear the latch if it is still that same promise (a fresh init started meanwhile is left to run).
   */
  private async terminateWorker(): Promise<void> {
    // Capture the init promise; if one is in flight, wait for it to settle so the worker it spawns
    // cannot survive this teardown (it assigns `this.worker` on success — we terminate that below).
    const starting = this.starting
    if (starting) {
      await starting.catch(() => undefined)
    }
    const worker = this.worker
    this.worker = null
    // Only clear the latch if it is STILL the init we awaited — a concurrent ensureWorker() may have
    // replaced it with a newer attempt during the await, which must be allowed to proceed (not orphaned).
    if (this.starting === starting) this.starting = null
    if (worker) {
      try {
        await worker.terminate()
      } catch {
        // Best-effort: a timeout/abort/quit terminate that throws still leaves us
        // with a null worker, so the next recognition starts a fresh one.
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.terminateWorker()
  }
}

export function createTesseractOcrEngine(opts: TesseractOcrEngineOptions): TesseractOcrEngine {
  return new TesseractOcrEngine(opts)
}
