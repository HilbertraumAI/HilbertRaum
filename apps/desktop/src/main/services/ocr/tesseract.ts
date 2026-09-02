import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { Worker } from 'node:worker_threads'
import type { OcrAvailability, OcrEngine, OcrRecognizeOptions, OcrResult } from './index'

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
// are single-job. Two teardowns (BE-5): `stop()` is the PERMANENT will-quit teardown — it
// terminates the worker and LATCHES (later recognitions reject); `suspend()` is the
// non-latching workspace-lock teardown — it terminates the warm worker so no decoded page
// bytes linger in a WASM worker across the re-encrypt, but the next recognition lazily
// respawns a fresh worker.

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

/**
 * Bound on ONE worker start — module load + WASM core + language init (REL-6, audit 2026-09-02
 * Phase 1). tesseract.js's `createWorker()` never settles when its worker dies while loading (its
 * load chain ends `.catch(() => {})`), so without a bound a hung start would park every later
 * recognition behind `starting` forever. 30 s covers a cold USB read of the ~4 MB language files
 * plus the WASM core on slow hardware; the packaged load failure this guards against fails in
 * well under a second (the worker's `'error'` event, caught through the `process.on('worker')`
 * hook below, rejects long before the timer). Injectable small in tests.
 */
export const DEFAULT_OCR_WORKER_START_TIMEOUT_MS = 30_000

/**
 * Delay before a proved-then-died engine re-proves itself (REL-6). A LIVE worker death (one WASM
 * abort on one page) is not evidence that the build cannot run OCR — the startup probe already
 * proved it can — so the engine returns to `'probing'` and starts one bounded re-probe after this
 * delay: success restores `'available'`, a start failure latches `'unavailable'`. Without this a
 * single transient death would disable OCR for the rest of the session (reviewer finding, PR 1-a).
 */
export const DEFAULT_OCR_REPROBE_DELAY_MS = 1_000

function resolveOcrPageTimeoutMs(explicit?: number): number {
  if (typeof explicit === 'number' && explicit > 0) return explicit
  const env = Number(process.env.HILBERTRAUM_OCR_PAGE_TIMEOUT_MS)
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_OCR_PAGE_TIMEOUT_MS
}

/**
 * The tesseract.js Node worker entry this engine spawns. Exported so the packaging closure test
 * (`tests/integration/asar-unpack-closure.test.ts`, REL-6) walks the SAME entry's require graph —
 * a path change here turns that test's walk red instead of leaving it validating a stale entry.
 */
export const TESSERACT_WORKER_ENTRY = 'tesseract.js/src/worker-script/node/index.js'

function toError(err: unknown, fallback: string): Error {
  if (err instanceof Error) return err
  const text = typeof err === 'string' ? err : ''
  return new Error(text.length > 0 ? text : fallback)
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
  /**
   * Injection seam for tests (BE-9): returns the tesseract.js version stamped into the engine id.
   * Default derives it from the installed `tesseract.js/package.json`.
   */
  resolveVersion?: () => string
  /**
   * REL-6: start in the `'probing'` state — the engine reports unavailable until `probe()` (or a
   * first recognition) proves the worker can run in this build. Set for PACKAGED builds, where
   * the `asarUnpack` closure is the thing being proven; a dev build starts `'available'`.
   */
  probeRequired?: boolean
  /** REL-6: bound on one worker start. Default `DEFAULT_OCR_WORKER_START_TIMEOUT_MS`. */
  workerStartTimeoutMs?: number
  /** REL-6: delay before the re-probe after a live worker death. Default `DEFAULT_OCR_REPROBE_DELAY_MS`. */
  reprobeDelayMs?: number
}

/**
 * The installed tesseract.js version, for the engine id (BE-9). `createRequire` reads the
 * package's own `package.json` — the packaged-safe idiom (a JSON read needs no
 * `app.asar.unpacked` rewrite, unlike the worker_threads script). A future version bump then
 * stamps the RIGHT `ocr_json.engineId` provenance instead of a stale hardcoded string.
 */
function resolveTesseractVersion(): string {
  try {
    const req = createRequire(import.meta.url)
    const pkg = req('tesseract.js/package.json') as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
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
  private readonly workerStartTimeoutMs: number
  private worker: TesseractWorker | null = null
  private starting: Promise<TesseractWorker> | null = null
  /** Serializes recognitions — a tesseract worker handles one job at a time. */
  private chain: Promise<unknown> = Promise.resolve()
  /** Recognitions enqueued and not yet settled (the probe releases the worker only at 0). */
  private queued = 0
  private stopped = false
  /** REL-6 execution state — see `OcrAvailability`. */
  private state: OcrAvailability
  /**
   * The raw `worker_threads.Worker`(s) behind the LIVE tesseract worker, captured through Node's
   * `process.on('worker')` hook at start (tesseract.js exposes the raw Worker only on its
   * resolved object — too late for a load failure). Membership means "ours and expected alive":
   * `terminateWorker()` clears the set BEFORE terminating, so the exit our own teardown causes
   * is never mistaken for a death.
   */
  private readonly liveRaw = new Set<Worker>()
  /** Rejecters of the recognitions in flight on the live worker — a worker death rejects them. */
  private readonly inflight = new Set<(err: Error) => void>()
  private readonly reprobeDelayMs: number
  private reprobeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: TesseractOcrEngineOptions) {
    this.opts = opts
    this.recognizeTimeoutMs = resolveOcrPageTimeoutMs(opts.recognizeTimeoutMs)
    this.workerStartTimeoutMs =
      typeof opts.workerStartTimeoutMs === 'number' && opts.workerStartTimeoutMs > 0
        ? opts.workerStartTimeoutMs
        : DEFAULT_OCR_WORKER_START_TIMEOUT_MS
    this.reprobeDelayMs =
      typeof opts.reprobeDelayMs === 'number' && opts.reprobeDelayMs >= 0
        ? opts.reprobeDelayMs
        : DEFAULT_OCR_REPROBE_DELAY_MS
    this.state = opts.probeRequired ? 'probing' : 'available'
    this.languages = [...opts.languages]
    // BE-9: derived from the installed package version, never a hardcoded literal.
    this.id = `tesseract.js-${(opts.resolveVersion ?? resolveTesseractVersion)()}`
  }

  private async ensureWorker(): Promise<TesseractWorker> {
    // BE-5: refuse to (re)spawn a worker once stopped. `recognize()` checks `stopped` at call
    // time, but a recognition QUEUED before stop() runs its `ensureWorker()` from the chain
    // AFTER the latch is set — without this guard that queued job would lazily respawn a worker
    // past the will-quit teardown. (suspend() does not set `stopped`, so it still respawns.)
    if (this.stopped) throw new Error('OCR engine is stopped')
    if (this.worker) return this.worker
    if (!this.starting) {
      this.starting = this.startWorker()
      this.starting.catch(() => {
        this.starting = null // a failed init must not poison later attempts
      })
    }
    return this.starting
  }

  /**
   * One bounded worker start (REL-6, audit 2026-09-02 Phase 1). The mechanism this contains:
   * tesseract.js 7.0.0 spawns a `worker_threads.Worker` synchronously inside `createWorker()`
   * (`src/worker/node/spawnWorker.js`) and sets `worker.onerror` — the BROWSER idiom, inert on a
   * Node Worker; no `on('error')` exists anywhere in the package. A module-load failure inside the
   * worker (the packaged `asarUnpack` gap: `src/worker-script/node/index.js` top-level `require`s)
   * therefore emits `'error'` with zero listeners, which Node rethrows on the main thread as
   * `uncaughtException` → the crash lock → `process.exit(1)`, while `createWorker()`'s own promise
   * never settles (its load chain ends `.catch(() => {})`). Three guards, all needed:
   *   (1a) `process.on('worker')` — Node emits it (on the tick after construction) for EVERY new
   *        Worker, so subscribing around the `createWorker` call captures the raw worker before
   *        tesseract exposes it, and attaching `'error'`/`'exit'` there turns the death into a
   *        rejection of `starting` (and, once live, of the recognitions in flight);
   *   (1b) a start timeout, so a hung load rejects instead of parking every later page;
   *   (1c) tesseract's `errorHandler` option — without it a `status: 'reject'` message makes its
   *        `onMessage` handler `throw`, another `uncaughtException` (the load/job promises already
   *        reject on their own, so the handler has nothing left to do).
   * Any of these latches `'unavailable'`; a healthy start sets `'available'`.
   */
  private async startWorker(): Promise<TesseractWorker> {
    const tesseract = await (this.opts.loadTesseract ?? loadRealTesseract)()
    let workerPath: string | undefined
    try {
      workerPath = resolveWorkerScriptPath(
        require.resolve(TESSERACT_WORKER_ENTRY)
      )
    } catch {
      workerPath = undefined // fake module in tests / exotic layout: use its default
    }

    const raws: Worker[] = []
    let rejectStart: (err: Error) => void = () => undefined
    const startFailed = new Promise<never>((_resolve, reject) => {
      rejectStart = reject
    })
    const onRawError = (err: unknown): void =>
      rejectStart(toError(err, 'OCR worker failed while starting'))
    const onRawExit = (code: number): void =>
      rejectStart(new Error(`OCR worker exited while starting (code ${code})`))
    // (1a) Attach INSIDE the hook: the event arrives on the tick after construction, before the
    // thread can post anything back, so the listeners are in place ahead of any 'error'.
    const onWorker = (raw: Worker): void => {
      raws.push(raw)
      raw.on('error', onRawError)
      raw.on('exit', onRawExit)
    }
    process.on('worker', onWorker)
    // A synchronous throw from the module becomes a rejection; a rejection settled before the
    // race below is observed must not surface as an unhandled rejection (the `.catch` branch).
    const created = (async () =>
      tesseract.createWorker([...this.opts.languages], OEM_LSTM_ONLY, {
        // Every path explicit and LOCAL — never the CDN/cache defaults.
        langPath: this.opts.langDir,
        gzip: true,
        cacheMethod: 'none',
        // (1c) — see above. A no-op is enough: for `action === 'load'` tesseract rejects
        // `createWorker()` itself (createWorker.js:213); a reject on `loadLanguage`/`initialize`
        // (corrupt traineddata) is swallowed by its `.catch(() => {})` and only the start timeout
        // below settles it; a job reject already rejects that job's promise. The handler's one
        // job is to replace the `throw Error(data)` that would be a second uncaughtException.
        errorHandler: (): void => undefined,
        ...(workerPath ? { workerPath } : {})
      }))()
    created.catch(() => undefined)
    // The spawn happened synchronously inside createWorker; its 'worker' event lands one tick
    // later — wait one macrotask so the capture window closes with the set complete.
    await new Promise<void>((resolve) => setImmediate(resolve))
    process.off('worker', onWorker)

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const worker = await Promise.race([
        created,
        startFailed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`OCR worker did not start within ${this.workerStartTimeoutMs} ms`)
              ),
            this.workerStartTimeoutMs
          )
          ;(timer as { unref?: () => void }).unref?.()
        })
      ])
      // Healthy: OUR raw worker becomes the LIVE set; a later death rejects the in-flight page
      // and re-arms (see `onLiveWorkerFailure`) instead of surfacing as an uncaught exception.
      // tesseract.js exposes the raw Worker on its resolved object (createWorker.js `resolveObj.
      // worker`) — adopt only that one, so a foreign Worker constructed in the same tick (none
      // exists in this app today) is never mistaken for ours; a fake without the field is adopted
      // as-is. (On the FAILURE path below every captured raw is reaped — createWorker never
      // resolved, so ours cannot be told apart; the same latent caveat, accepted.)
      const own = (worker as unknown as { worker?: unknown }).worker
      for (const raw of raws) {
        raw.off('error', onRawError)
        raw.off('exit', onRawExit)
        if (own != null && raw !== own) continue
        this.liveRaw.add(raw)
        raw.on('error', (err) => this.onLiveWorkerFailure(raw, toError(err, 'OCR worker error')))
        raw.on('exit', (code) =>
          this.onLiveWorkerFailure(raw, new Error(`OCR worker exited unexpectedly (code ${code})`))
        )
      }
      this.worker = worker
      this.state = 'available'
      return worker
    } catch (err) {
      // Load error, tesseract reject, or timeout: reap whatever was spawned (a hung worker would
      // otherwise linger) and latch. The rejection reaches the caller as a per-document error.
      for (const raw of raws) {
        raw.off('error', onRawError)
        raw.off('exit', onRawExit)
        raw.on('error', () => undefined)
        void raw.terminate().catch(() => undefined)
      }
      this.state = 'unavailable'
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * A LIVE worker died (error or unexpected exit): fail the pages in flight, drop the worker,
   * and RE-ARM — back to `'probing'` with one bounded re-probe scheduled. A live worker exists
   * only after a healthy start, so this death is "proved, then died": one page's WASM abort must
   * not disable OCR for the session. The re-probe decides: healthy → `'available'`; a start
   * failure → `'unavailable'` (latched by `startWorker`). Until it settles the engine reports
   * unavailable (`isAvailable() === false`) and the UI offers nothing.
   */
  private onLiveWorkerFailure(raw: Worker, err: Error): void {
    if (!this.liveRaw.has(raw)) return // our own terminate — expected
    this.liveRaw.delete(raw)
    this.state = 'probing'
    const dead = this.worker
    this.worker = null
    if (this.starting) this.starting = null
    if (dead) void dead.terminate().catch(() => undefined)
    for (const reject of this.inflight) reject(err)
    this.inflight.clear()
    if (!this.stopped && !this.reprobeTimer) {
      this.reprobeTimer = setTimeout(() => {
        this.reprobeTimer = null
        void this.probe()
      }, this.reprobeDelayMs)
      ;(this.reprobeTimer as { unref?: () => void }).unref?.()
    }
  }

  async recognize(image: Buffer, opts: OcrRecognizeOptions = {}): Promise<OcrResult> {
    if (this.stopped) throw new Error('OCR engine is stopped')
    this.queued += 1
    const run = this.chain.then(async (): Promise<OcrResult> => {
      if (opts.signal?.aborted) {
        throw new DOMException('OCR recognition aborted', 'AbortError')
      }
      const worker = await this.ensureWorker()
      return this.recognizeWithTimeout(worker, image, opts.signal)
    })
    // The chain must survive a failed job (keep serializing, swallow for the chain only).
    this.chain = run.catch(() => undefined).finally(() => {
      this.queued -= 1
    })
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
    let onWorkerDeath: ((err: Error) => void) | undefined
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
          // REL-6: a worker death mid-page rejects THIS page now (tesseract's job promise would
          // never settle) — `onLiveWorkerFailure` has already dropped the dead worker.
          onWorkerDeath = reject
          this.inflight.add(onWorkerDeath)
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
      if (onWorkerDeath) this.inflight.delete(onWorkerDeath)
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
    // REL-6: the exit this teardown causes is expected — forget the raw workers FIRST so
    // `onLiveWorkerFailure` ignores it (membership means "expected alive").
    this.liveRaw.clear()
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
    if (this.reprobeTimer) {
      clearTimeout(this.reprobeTimer)
      this.reprobeTimer = null
    }
    await this.terminateWorker()
  }

  /**
   * BE-5 non-latching teardown for the workspace lock (REL-2 machinery, no latch): terminate the
   * warm worker so no decoded page bytes linger in a WASM worker while the vault re-encrypts, but
   * do NOT set `stopped` — the next recognition lazily respawns a fresh worker (unlike `stop()`,
   * which permanently latches for the will-quit path). Restores the sidecar parity on lock.
   */
  async suspend(): Promise<void> {
    await this.terminateWorker()
  }

  /** REL-6 execution state (see `OcrAvailability`); a stopped engine is unavailable. */
  availability(): OcrAvailability {
    return this.stopped ? 'unavailable' : this.state
  }

  /**
   * `availability() === 'available'` — the same predicate `ocrAvailable` in the app status applies
   * (the IPC reads the optional interface method `availability()` directly; this is the engine's
   * own convenience form, used by the tests).
   */
  isAvailable(): boolean {
    return this.availability() === 'available'
  }

  /**
   * Packaged-mode execution probe (REL-6): prove the worker can run in THIS build by starting it
   * once under the bounded start (module load + WASM core + language init — exactly the chain the
   * `asarUnpack` gap breaks), then release it again so a feature most sessions never use holds no
   * warm WASM worker; the first real recognition respawns lazily (~0.3 s). No image fixture: a
   * successful `createWorker()` already covers every step the packaged failure class can break
   * (recognition itself is pure WASM compute). Cheap no-op once proven. Never throws.
   */
  async probe(): Promise<boolean> {
    if (this.stopped) return false
    if (this.state === 'available') return true
    try {
      await this.ensureWorker()
    } catch {
      return false // `startWorker` has latched 'unavailable'
    }
    // Narrow race, accepted: a recognize() enqueued after this check and before terminateWorker()
    // takes the worker would run against a worker being torn down and fail that ONE page (the
    // worker respawns for the next); it can only happen in the seconds around startup/re-probe.
    if (this.queued === 0) await this.terminateWorker()
    return true
  }
}

export function createTesseractOcrEngine(opts: TesseractOcrEngineOptions): TesseractOcrEngine {
  return new TesseractOcrEngine(opts)
}
