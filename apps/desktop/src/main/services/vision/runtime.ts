import { LlamaServer, combineSignals, type LlamaServerOptions } from '../runtime/sidecar'
import { readChatSSE } from '../runtime/llama'

// The lazily-started vision sidecar (image-understanding plan §7 Option A, §10 `runtime.ts`).
// It composes `LlamaServer` DIRECTLY — like `E5Embedder`, NOT the chat `RuntimeManager` — so it
// does NOT inherit the chat slot's `CHAT_SERVER_ARGS` (RUNTIME-2). The V1 research gate
// (BUILD_STATE 2026-06-20) resolved the exact arg set on the pinned b9585:
//   • `--mmproj <projector>`  loads multimodal cleanly
//   • `--device none` + `--no-mmproj-offload`  FULL CPU-pin (LM *and* projector). RUNTIME-6,
//     2026-07-01: on b9849 the mmproj offloads to GPU BY DEFAULT even under `--device none`, so
//     `--device none` alone leaves the projector on the (shared-memory iGPU) GPU where contention
//     with the chat model can miscompute the image embeddings → token-salad. See VISION_DEVICE_ARGS.
//   • `--parallel 1`          single server slot — RUNTIME-5, added 2026-07-01. Vision is strictly
//     one-at-a-time, and the b9849 runtime defaults to n_slots=4 + a UNIFIED KV cache, which splits
//     the 4096-cell context across slots so a large image starves it (see VISION_SLOT_ARGS below).
//   • `--jinja` is DEFAULT-ENABLED on b9585 AND b9849 — do NOT pass it (A/B-verified 2026-07-01, it
//     changes nothing); and do NOT pass `--reasoning-format deepseek` (Qwen2.5-VL is non-reasoning,
//     emits no reasoning frames)
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

/**
 * FULL CPU-pin for the vision sidecar (RUNTIME-2 base + RUNTIME-6 hardening, 2026-07-01).
 * `--device none` runs the LANGUAGE model on CPU; `--no-mmproj-offload` keeps the MULTIMODAL
 * PROJECTOR (clip) on CPU too. On b9849 the projector defaults to GPU offload EVEN under
 * `--device none` (`llama-server --help`: mmproj-offload default = on), so `--device none` alone
 * does NOT fulfil the design's "avoid VRAM contention" intent: on this project's target hardware
 * (a shared-memory Intel Iris Xe iGPU, Vulkan default backend, co-resident with a 6–8 GB chat
 * model on a 16 GB machine) the projector's GPU compute can be starved and miscompute the image
 * embeddings, which the LM then decodes as multilingual token-salad. Pinning the projector to CPU
 * makes the whole vision path contention-immune. CONFIRMED as the fix in-app by the owner
 * (2026-07-01): the salad reproduced ONLY in the full app, never in an isolated sidecar, because
 * the projector only contends for the shared iGPU when the chat model is co-resident — pinning it
 * to CPU resolved it. (Diagnosed the hard way: the b9849 sidecar returns coherent output for every
 * valid image driven directly, so the model↔runtime pairing is sound; this was b9849 default drift.)
 */
export const VISION_DEVICE_ARGS = ['--device', 'none', '--no-mmproj-offload'] as const

/**
 * Pin the vision sidecar to a SINGLE server slot (RUNTIME-5, added 2026-07-01). Vision is strictly
 * one-at-a-time — `VisionService` busy-rejects a concurrent analyze — so extra slots are never used.
 * More than a no-op though: on the b9849 runtime `llama-server` defaults to `n_slots = 4` with a
 * UNIFIED KV cache (`kv_unified = true`), which SPLITS the 4096-cell context across the four slots.
 * A 1536-px image (the renderer's `DOWNSCALE_TARGET`) is ~1700–3000 vision tokens, and because the
 * warm sidecar is reused with `cache_prompt` across images, two large images oversubscribe the
 * shared pool → llama-server logs `failed to find a memory slot for batch` / `failed to restore kv
 * cache`, and the request either 500s or runs on truncated/half-restored image embeddings, which
 * the LM decodes as multilingual token-salad. This regressed silently in the b9585→b9849 pin bump
 * (commit 26133b0): the vision path was never re-smoked on b9849, and b9585 did not share the KV
 * pool this way. Empirically A/B-confirmed live on the drive 2026-07-01 — with `--parallel 1` the
 * server starts `n_slots = 1, kv_unified = false`, the one in-flight request gets the full context
 * with a cleanly-reset KV, and the large-image failures disappear. See docs/architecture.md §-record.
 */
export const VISION_SLOT_ARGS = ['--parallel', '1'] as const

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
        extraArgs: ['--mmproj', this.opts.projectorPath, ...VISION_SLOT_ARGS, ...VISION_DEVICE_ARGS],
        spawn: this.opts.spawn,
        fetchImpl: this.opts.fetchImpl,
        findPort: this.opts.findPort,
        threads: this.opts.threads,
        healthTimeoutMs: this.opts.healthTimeoutMs,
        healthIntervalMs: this.opts.healthIntervalMs,
        host: this.opts.host,
        // M1 (ported verbatim from translation/runtime.ts TA-6, F-14): a mid-session sidecar
        // crash — the child dies on its OWN after becoming healthy (OOM is the named realistic
        // cause: the three-process RAM peak makes 12 GB machines likely-OOM) — otherwise leaves
        // `this.server` pointing at a dead handle. Every later `analyze()` then dials the closed
        // loopback port and fails 'runtimeFailed', and each failure re-arms the idle clock, so
        // the outage persists as long as retries arrive < the idle window apart. Drop the dead
        // handle here so the NEXT `analyze()` cold-starts a fresh child. Identity-compared so a
        // late crash notification can never clobber a NEWER instance a soft idle teardown +
        // restart already installed. `LlamaServer` fires this only for a healthy child dying
        // outside `stop()`, so a lock/quit kill never trips it. (No device-fallback twin: unlike
        // translation, the vision sidecar has no GPU/CPU ladder — the CPU pin is fixed.)
        onUnexpectedExit: () => {
          if (this.server === server) this.server = null
        }
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
    // REL-4: own the (long, 300 s) timeout so it is cleared the instant the stream finishes,
    // rather than living out its full duration after an early-completing analysis.
    const combined = combineSignals(opts.signal, timeoutMs)
    try {
      const res = await server.fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: combined.signal
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
    } finally {
      combined.clear()
    }
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
    // R7 (full-audit-2026-06-30, Phase C) — re-cancel AFTER the awaits so stop()'s postcondition
    // ("no idle timer is live when I return") holds LOCALLY, without relying on armIdleTimer's
    // guards. The literal race is ALREADY closed there — armIdleTimer returns early on BOTH
    // `this.stopped` AND `!this.server`, and stop() sets both synchronously before any await, so a
    // concurrent `analyze()` finally cannot arm a surviving timer today. This is a third,
    // defense-in-depth backstop (it only becomes load-bearing if a future refactor weakens both of
    // those checks). Idempotent no-op when nothing is armed.
    this.cancelIdleTimer()
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
