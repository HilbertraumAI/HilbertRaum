import { LlamaServer, combineSignals, type LlamaServerOptions } from '../runtime/sidecar'
import { readChatSSE } from '../runtime/llama'

// The lazily-started vision sidecar (image-understanding plan §7 Option A, §10 `runtime.ts`).
// It composes `LlamaServer` DIRECTLY — like `E5Embedder`, NOT the chat `RuntimeManager` — so it
// does NOT inherit the chat slot's `CHAT_SERVER_ARGS` (RUNTIME-2). The V1 research gate
// (BUILD_STATE 2026-06-20) resolved the exact arg set on the pinned b9585:
//   • `--mmproj <projector>`  loads multimodal cleanly
//   • `--device none`         CPU-pin (mirrors the embedder; avoids VRAM contention)
//   • `--jinja` is DEFAULT-ENABLED on b9585 — do NOT pass it; and do NOT pass
//     `--reasoning-format deepseek` (Qwen2.5-VL is non-reasoning, emits no reasoning frames)
// The request is an OpenAI `content:[{type:'text'},{type:'image_url',image_url:{url:'data:…'}}]`
// with `cache_prompt:true` (the image prefill is cached across follow-ups), streamed back as SSE
// byte-identical to chat — so `readChatSSE` parses the frames unchanged (V1-confirmed).
//
// V4 SCOPE: this is the hardened runtime. Besides the V2 lazy start + analyze + stop it now
// owns the NET-NEW idle-teardown interlock (RUNTIME-4): the sidecar is torn down after an idle
// timeout so it does not sit co-resident with the chat model + E5 embedder forever (PROD-1
// bounds the WINDOW, not the active-use peak). The interlock is the heart of V4 —
//   • every `ensureStarted()`/`analyze()` entry CANCELS the pending idle timer;
//   • the timer is (re)armed only when the LAST in-flight analyze settles (inFlight===0);
//   • the idle teardown is a SOFT teardown (unlike `stop()`): it kills the child but does NOT
//     latch `stopped`, so the next `analyze()` re-pays a clean cold start;
//   • the teardown is GUARDED against a `starting`/in-flight job (`this.starting`/`inFlight>0`)
//     so it can never tear down under a running analyze; an analyze arriving mid-teardown just
//     sees `this.server === null` and cold-starts a fresh child (the two server instances are
//     independent — the old one finishes stopping while the new one starts).
// e5.ts is the precedent for the lazy-start/`startFailed`/no-orphan plumbing but has NO idle
// timer, so the interlock above is genuinely new code, not a copy.

/** The vision sidecar's extra CLI args BESIDES `--mmproj <path>` (V1-resolved, RUNTIME-2). */
export const VISION_DEVICE_ARGS = ['--device', 'none'] as const

/** Default context window for the vision sidecar (V1 measured peak RSS ~4.6 GB at ctx 4096). */
const DEFAULT_VISION_CONTEXT_TOKENS = 4096
/** Per-analyze bound so a wedged sidecar fails the job instead of hanging it. */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000

/**
 * Idle-teardown timeout default (RUNTIME-4 / plan §19.13). The window the sidecar may sit idle,
 * co-resident with the chat + embedder sidecars, before it is torn down to give the RAM back.
 * Env-overridable (`HILBERTRAUM_VISION_IDLE_MS`) for tuning/tests.
 *
 * TUNED to 120 000 ms (2 min — the LOWER end of the §19.13 2–5 min band) in Phase V5 against the
 * V1 numbers (BUILD_STATE / model-benchmarks §8): the per-image follow-up prefill is already
 * CACHED across questions (`cache_prompt:true`), so a warm sidecar's only saved cost is the model
 * *load* (seconds off USB), a cheap re-pay — whereas an idle sidecar holds ~4.6 GB co-resident
 * with a 12B chat (PROD-1 pushes a real machine >16 GB), so reclaiming that RAM promptly is the
 * higher-value trade. 2 min comfortably spans a burst of follow-ups about one image, then frees
 * the RAM once the user moves on; the next image cold-restarts cleanly (a soft teardown).
 */
const DEFAULT_VISION_IDLE_MS = 120_000

function readIdleTimeoutMs(): number {
  const raw = process.env.HILBERTRAUM_VISION_IDLE_MS?.trim()
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_VISION_IDLE_MS
}

/** A scheduled idle-teardown timer handle (the global `setTimeout`'s, or a test's fake clock). */
export interface IdleTimerHandle {
  /** Cancel the pending fire. */
  clear(): void
  /** Detach from the event loop so it can never block a clean quit (the real timer's `unref`). */
  unref?(): void
}

/**
 * The idle-teardown clock (RUNTIME-4). Production uses the global timer; tests inject a
 * controllable clock so the teardown interleavings are DETERMINISTIC (fire on demand) instead
 * of `sleep`-ordered — the `this.starting`/`inFlight` guard branches can then be raced exactly.
 */
export interface IdleClock {
  set(cb: () => void, ms: number): IdleTimerHandle
}

/** The default clock — a real `setTimeout`, unref'd so it never keeps the process alive. */
const REAL_IDLE_CLOCK: IdleClock = {
  set(cb, ms) {
    const t = setTimeout(cb, ms)
    return { clear: () => clearTimeout(t), unref: () => void t.unref?.() }
  }
}

export type VisionRuntimeDeps = Pick<
  LlamaServerOptions,
  'spawn' | 'fetchImpl' | 'findPort' | 'threads' | 'healthTimeoutMs' | 'healthIntervalMs' | 'host'
>

export interface VisionRuntimeOptions extends VisionRuntimeDeps {
  /** The vision model id (the manifest id) sent as the request `model`. */
  modelId: string
  binPath: string
  /** Absolute path to the language GGUF weight. */
  modelPath: string
  /** Absolute path to the mmproj projector (`--mmproj`). */
  projectorPath: string
  contextTokens?: number
  /** Per-analyze timeout in ms (default 300 000 — CPU prefill of a full image is slow). */
  requestTimeoutMs?: number
  /** Idle-teardown timeout in ms (default `HILBERTRAUM_VISION_IDLE_MS` / 120 000 — §19.13, tuned V5). */
  idleTimeoutMs?: number
  /** Idle-teardown clock (default: the global `setTimeout`). Tests inject a controllable clock. */
  idleClock?: IdleClock
}

export interface VisionAnalyzeOptions {
  imageBytes: Uint8Array
  mimeType: string
  question: string
  /** A user "Stop" — combined with the per-request timeout (M-C5 pattern). */
  signal?: AbortSignal
  /** Streamed answer-token sink (the STREAM.imgToken forwarder). */
  onToken?: (delta: string) => void
}

/** Owns one lazily-started vision `llama-server` and answers one image question over loopback. */
export class VisionRuntime {
  readonly modelId: string
  private server: LlamaServer | null = null
  private starting: Promise<void> | null = null
  /** Set by `stop()`; a racing lazy start must not resurrect the sidecar after teardown. */
  private stopped = false
  /** Failed-start latch (the reranker/embedder pattern) — a corrupt GGUF mustn't re-spawn +
   *  re-await the full health timeout on every analyze. INTENTIONALLY sticky: `stop()` makes
   *  the instance permanently dead (the orchestrator discards it and builds a fresh runtime),
   *  so the latch is never cleared/reused — `ensureStarted` checks `stopped` first regardless
   *  (corrected from a stale "Cleared by stop()" note — BUG vuln-scan-2026-06-21). */
  private startFailed: Error | null = null
  /** Number of analyses currently using the sidecar. Guards the idle teardown (RUNTIME-4):
   *  while >0 a job is running and the sidecar must NOT be torn down. */
  private inFlight = 0
  /** The pending idle-teardown timer handle (armed only when `inFlight===0`), or null. */
  private idleHandle: IdleTimerHandle | null = null
  /** An in-flight SOFT idle teardown, tracked so `stop()` can await it (no orphan on quit). */
  private idleTeardownPromise: Promise<void> | null = null
  private readonly idleTimeoutMs: number
  private readonly idleClock: IdleClock

  constructor(private readonly opts: VisionRuntimeOptions) {
    this.modelId = opts.modelId
    this.idleTimeoutMs = opts.idleTimeoutMs ?? readIdleTimeoutMs()
    this.idleClock = opts.idleClock ?? REAL_IDLE_CLOCK
  }

  /** Lazily spawn the vision sidecar (once). Concurrent callers share one start (single-flight). */
  private async ensureStarted(): Promise<LlamaServer> {
    // Any use of the sidecar resets the idle clock (RUNTIME-4): a teardown must never fire
    // out from under an imminent request.
    this.cancelIdleTimer()
    if (this.stopped) throw new Error('Vision runtime is stopped')
    if (this.startFailed) throw this.startFailed
    if (this.server) return this.server
    if (!this.starting) {
      const server = new LlamaServer({
        binPath: this.opts.binPath,
        modelPath: this.opts.modelPath,
        contextTokens: this.opts.contextTokens ?? DEFAULT_VISION_CONTEXT_TOKENS,
        // V1-resolved: `--mmproj` loads multimodal; `--device none` CPU-pins. The b9585
        // default-on `--jinja` gives the multimodal chat-template path without inheriting
        // CHAT_SERVER_ARGS; `--reasoning-format` is left at default (non-reasoning VLM).
        extraArgs: ['--mmproj', this.opts.projectorPath, ...VISION_DEVICE_ARGS],
        spawn: this.opts.spawn,
        fetchImpl: this.opts.fetchImpl,
        findPort: this.opts.findPort,
        threads: this.opts.threads,
        healthTimeoutMs: this.opts.healthTimeoutMs,
        healthIntervalMs: this.opts.healthIntervalMs,
        host: this.opts.host
      })
      this.starting = server
        .start()
        .then(() => {
          this.server = server
        })
        .catch((err) => {
          this.startFailed = err instanceof Error ? err : new Error(String(err))
          throw this.startFailed
        })
        .finally(() => {
          this.starting = null
        })
    }
    await this.starting
    if (!this.server) throw new Error('Vision server failed to start')
    return this.server
  }

  /**
   * Analyze ONE image: base64-inline the bytes into an OpenAI `image_url` data-URL request
   * (no disk write), stream the answer through `onToken`, and return the full text. Honours
   * `signal` (a user "Stop") combined with the per-request timeout.
   */
  async analyze(opts: VisionAnalyzeOptions): Promise<string> {
    // RUNTIME-4: cancel the idle timer and mark a job in flight BEFORE the (possibly slow,
    // cold-start) `ensureStarted` await, so a teardown can't fire during the start either.
    this.cancelIdleTimer()
    this.inFlight++
    try {
      return await this.runAnalyze(opts)
    } finally {
      this.inFlight--
      // The last job to settle re-arms the idle clock; a still-running job leaves it disarmed
      // (its own finally will arm it when it finishes).
      if (this.inFlight === 0) this.armIdleTimer()
    }
  }

  private async runAnalyze(opts: VisionAnalyzeOptions): Promise<string> {
    const server = await this.ensureStarted()
    const dataUrl = `data:${opts.mimeType};base64,${Buffer.from(opts.imageBytes).toString('base64')}`
    const body = JSON.stringify({
      model: this.modelId,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: opts.question },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ],
      stream: true,
      // V1: the image prefill is CACHED across follow-ups (cache_n measured) — the per-image
      // thread pays the (slow CPU) image prefill once, not per question. Loopback compute hint.
      cache_prompt: true
    })
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const res = await server.fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: combineSignals(opts.signal, timeoutMs)
    })
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined)
      throw new Error(`Vision request failed: HTTP ${res.status}`)
    }
    if (!res.body) throw new Error('Vision request returned an empty response body')
    // The vision SSE frames are byte-identical to chat (V1-confirmed) — readChatSSE parses
    // them unchanged. A non-reasoning VLM emits no reasoning frames, so no onReasoning sink.
    let answer = ''
    for await (const delta of readChatSSE(res.body, opts.signal)) {
      answer += delta
      opts.onToken?.(delta)
    }
    return answer
  }

  /** Kill the sidecar (no-op if never started). Permanent for this instance; the orchestrator
   *  builds a fresh runtime on the next analyze if it cleared its reference. Used by the
   *  workspace-lock / quit / cancel teardown wiring (VisionService.stop). */
  async stop(): Promise<void> {
    this.stopped = true
    this.cancelIdleTimer()
    // Wait out an in-flight lazy start (e5.ts no-orphan precedent) AND an in-flight soft idle
    // teardown, so neither leaves an orphaned child after the app quits.
    if (this.starting) await this.starting.catch(() => undefined)
    if (this.idleTeardownPromise) await this.idleTeardownPromise.catch(() => undefined)
    const server = this.server
    this.server = null
    if (server) await server.stop()
  }

  // ---- Idle-teardown interlock (RUNTIME-4) --------------------------------------------

  private cancelIdleTimer(): void {
    if (this.idleHandle) {
      this.idleHandle.clear()
      this.idleHandle = null
    }
  }

  /** Arm the idle teardown — but only when there is a live, idle sidecar to reclaim. */
  private armIdleTimer(): void {
    this.cancelIdleTimer()
    if (this.stopped || this.starting || this.inFlight > 0 || !this.server) return
    this.idleHandle = this.idleClock.set(() => {
      this.idleHandle = null
      void this.idleTeardown()
    }, this.idleTimeoutMs)
    // Never let the idle timer keep the process alive (it would block a clean quit).
    this.idleHandle.unref?.()
  }

  /**
   * SOFT teardown fired by the idle timer: kill the child but do NOT latch `stopped`, so the
   * next `analyze()` cold-starts cleanly. Guarded so it can never run under a `starting`/
   * in-flight job (RUNTIME-4) — if a job slipped in after the timer fired, we simply skip and
   * that job's `finally` re-arms the clock.
   */
  private async idleTeardown(): Promise<void> {
    if (this.stopped || this.starting || this.inFlight > 0 || !this.server) return
    const server = this.server
    // Null the reference SYNCHRONOUSLY before awaiting the kill: an `analyze()` arriving
    // mid-teardown then sees `server === null` and cold-starts a fresh, independent child.
    this.server = null
    this.idleTeardownPromise = server.stop().finally(() => {
      this.idleTeardownPromise = null
    })
    await this.idleTeardownPromise
  }
}
