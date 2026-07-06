import { LlamaServer, combineSignals, isBindRaceError, type LlamaServerOptions } from '../runtime/sidecar'
import { readCompletionSSE, type CompletionFinal } from './completion'
import { buildTranslationPrompt, TRANSLATION_STOP_TOKEN, type TranslationLangCode } from './prompt'

// The lazily-started TranslateGemma sidecar (TG wave, plan §2 D1). It composes `LlamaServer`
// DIRECTLY — like the E5 embedder / reranker / vision, NOT the chat `RuntimeManager` — so it does
// NOT inherit the chat slot's `CHAT_SERVER_ARGS` (which hard-code `--jinja`). That matters here for
// a hard reason, not just cleanliness: the `--jinja` embedded-template path is REGRESSED for
// TranslateGemma (issue #20305, fix PR #20956 still open — re-verified 2026-07-05), so this sidecar
// launches WITHOUT `--jinja` and formats the trained prompt in app code (`prompt.ts`), calling the
// raw `/completion` endpoint (`completion.ts`). See docs/model-policy.md "The translation role".
//
// The lifecycle is a HYBRID of two established precedents:
//   • vision/runtime.ts — the SOFT idle-teardown interlock (a 12B model must not sit ~10 GB
//     co-resident with a resident chat model + embedder forever; plan §2 D9). Every use cancels
//     the idle timer; it re-arms only when the LAST in-flight translate settles.
//   • reranker/llama.ts — `stop()` (permanent, quit) vs `suspend()` (soft, workspace lock →
//     lazy restart on next translate), the `tearingDown` latch that bars a racing start from
//     orphaning a child across a lock, and the bind-race-forgiving `startFailed` latch.
// This instance is held on `AppContext` for the whole session (unlike vision, whose orchestrator
// rebuilds the runtime), so it needs the reranker's suspend/restart distinction, not vision's
// discard-and-rebuild.

/**
 * Pin the translation sidecar to a SINGLE server slot (plan §2 D8/D9). Translation windows are run
 * STRICTLY SEQUENTIALLY (the doc-task FIFO at TG-3, one window at a time in the view at TG-4), so a
 * single slot is correct — and it contains the Windows-Vulkan hang under PARALLEL translation load
 * (#25142, seen 2026-06-29 on Intel Arc). It also avoids the b9849 `n_slots = 4` + unified-KV
 * context split that starved the vision sidecar (RUNTIME-5).
 */
export const TRANSLATION_SLOT_ARGS = ['--parallel', '1'] as const

/**
 * CPU-pin the translation sidecar for TG-2 (plan §2 D8). D8 asked TG-2 to first try reusing the
 * chat GPU ladder (`runtime/factory.ts` rung-1 auto-offload / rung-2 `--device none`); that
 * factory's seams are chat-specific — `createSelectingRuntimeFactory` yields a `chatStream`-based
 * `ModelRuntime` wired to `RuntimeManager`, not a raw-`/completion` sidecar composing `LlamaServer`
 * — so they do not fit here. Per D8's fallback, TG-2 ships `--device none` (CPU) and the smoke's
 * tokens/sec (printed artifact) decides at TG-6 whether to pull GPU work forward. Keeping it a
 * single named constant makes that a one-line flip when the measurement lands. `--parallel 1`
 * contains #25142 either way.
 *
 * TG-6 OUTCOME (2026-07-05) — KEEP CPU-pinned for v1. The measured CPU decode (~3–4 tok/s nominal;
 * 1.1–4.4 across the run, slowest under memory pressure) is tolerable for a BACKGROUND doc-task with
 * per-window progress + instant cancel, and the only smoke drive is Windows Vulkan where #25142 (the
 * parallel-translation hang) is the live risk — a GPU flip needs its own GPU-decode re-smoke on a
 * paid GPU drive before it can ship. GPU is deferred, NOT rejected: flip this constant to `[]`
 * (the runtime auto-offloads with `--fit`) and re-run the smoke on a GPU drive. See
 * model-benchmarks.md §11.
 */
export const TRANSLATION_DEVICE_ARGS = ['--device', 'none'] as const

/**
 * Override the model's embedded chat template with the built-in `gemma` one (TG-2 smoke finding,
 * 2026-07-05). This is NOT cosmetic — WITHOUT it the b9849 `llama-server` CRASHES AT STARTUP on
 * TranslateGemma (Windows exit 0xC0000409 / std::bad_alloc), even with NO `--jinja`: the server
 * VALIDATES the model's embedded chat template during init, and TranslateGemma's template requires
 * typed `{source_lang_code,target_lang_code}` content the probe can't render
 * ("render_message_to_json: Neither string content nor typed content is supported by the
 * template") → the #20305 minja crash, biting at init rather than per-request. Confirmed on the
 * real pin: with `--chat-template gemma` the server loads + serves cleanly and `/props` reports
 * `chat_template: "gemma"`.
 *
 * SAFE because the translation sidecar drives the RAW `/completion` endpoint with a fully-formed
 * prompt (`prompt.ts`) — the chat template is NEVER applied to our requests (only `/v1/chat/*` and
 * `/apply-template` use it, which we don't call). The built-in `gemma` name selects the LEGACY
 * (non-jinja) template path, so this stays consistent with the no-jinja design (D2): it sidesteps
 * the very minja parser that #20305 breaks. If a future pin lands the #20305 fix (PR #20956, V5),
 * this override can be dropped — the smoke re-decides.
 */
export const TRANSLATION_TEMPLATE_ARGS = ['--chat-template', 'gemma'] as const

/**
 * The full extra-arg set the translation sidecar launches with (composed from the named constants
 * above so the runtime AND the manual smoke stay byte-identical — no drift). NO `--jinja`, NOT the
 * chat `CHAT_SERVER_ARGS`.
 */
export const TRANSLATION_SERVER_ARGS = [
  ...TRANSLATION_SLOT_ARGS,
  ...TRANSLATION_DEVICE_ARGS,
  ...TRANSLATION_TEMPLATE_ARGS
] as const

/** Launch context window (plan §2 D4). Overridden by the manifest's `recommendedContextTokens`
 *  (4096: the model card's 2K input budget + output headroom). Read back via `contextWindow()`. */
const DEFAULT_TRANSLATION_CONTEXT_TOKENS = 4096

/**
 * Per-window bound so a WEDGED sidecar fails the window instead of hanging the job — sized
 * for the real CPU decode. TG-6 re-measured the Gemma tokenizer: a near-budget window at the
 * launched 4096 ctx carries a ~2,070-token output cap (`windowMaxTokens`), and CPU decode ran
 * 1.1–4.4 tok/s across the TG-6 run (the low end under memory pressure) — so a full window can
 * be ~30 min at ~1.1 tok/s before prefill. 45 min never kills such a live slow decode (the old
 * 300 s did — every full window timed out twice into a failed-window notice; the interim TG-3
 * 30 min would clip a ~1.1 tok/s full window) while still bounding a true hang; user cancel stays
 * instant via the task's own abort signal.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 2_700_000

/**
 * Idle-teardown timeout default (plan §2 D1, the vision §19.13 precedent). The window the 12B
 * sidecar may sit idle — co-resident with the chat + embedder sidecars — before it is torn down to
 * give the RAM back. 120 000 ms (2 min) mirrors vision's tuned value: it spans a burst of windows
 * for one document, then frees ~10 GB once the user moves on; the next translate cold-restarts
 * cleanly (a SOFT teardown). Env-overridable (`HILBERTRAUM_TRANSLATION_IDLE_MS`) for tuning/tests.
 */
const DEFAULT_TRANSLATION_IDLE_MS = 120_000

function readIdleTimeoutMs(): number {
  const raw = process.env.HILBERTRAUM_TRANSLATION_IDLE_MS?.trim()
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TRANSLATION_IDLE_MS
}

/** A scheduled idle-teardown timer handle (the global `setTimeout`'s, or a test's fake clock). */
export interface IdleTimerHandle {
  clear(): void
  /** Detach from the event loop so it can never block a clean quit (the real timer's `unref`). */
  unref?(): void
}

/**
 * The idle-teardown clock. Production uses the global timer; tests inject a controllable clock so
 * the teardown interleavings are DETERMINISTIC (fire on demand) rather than `sleep`-ordered (the
 * vision RUNTIME-4 / TEST-2 pattern).
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

export type TranslationRuntimeDeps = Pick<
  LlamaServerOptions,
  'spawn' | 'fetchImpl' | 'findPort' | 'threads' | 'healthTimeoutMs' | 'healthIntervalMs' | 'host'
>

export interface TranslationRuntimeOptions extends TranslationRuntimeDeps {
  /** The translation model id (the manifest id). */
  modelId: string
  binPath: string
  /** Absolute path to the GGUF weight. */
  modelPath: string
  contextTokens?: number
  /** Per-window timeout in ms (default 2 700 000 — a full window's CPU decode can run ~30+ min under load). */
  requestTimeoutMs?: number
  /** Idle-teardown timeout in ms (default `HILBERTRAUM_TRANSLATION_IDLE_MS` / 120 000). */
  idleTimeoutMs?: number
  /** Idle-teardown clock (default: the global `setTimeout`). Tests inject a controllable clock. */
  idleClock?: IdleClock
}

export interface TranslateOptions {
  sourceLang: TranslationLangCode
  targetLang: TranslationLangCode
  /** The source text for ONE window. Translated as data, never obeyed (plan §2 D2). */
  text: string
  /** A user "Stop" — combined with the per-request timeout (M-C5 pattern). */
  signal?: AbortSignal
  /** Streamed translation-token sink. */
  onToken?: (delta: string) => void
  /** Optional `n_predict` cap. Omitted ⇒ generate until `<end_of_turn>` or the context fills. */
  maxTokens?: number
  /** Final-frame timings sink — the smoke's tokens/sec artifact (plan §7 → D10). */
  onFinal?: (info: CompletionFinal) => void
}

/** Owns one lazily-started TranslateGemma `llama-server` and translates one window over loopback. */
export class TranslationRuntime {
  readonly modelId: string
  private readonly ctxTokens: number
  private server: LlamaServer | null = null
  private starting: Promise<void> | null = null
  /** Set by `stop()` (permanent, quit); a racing lazy start must not resurrect the sidecar. */
  private stopped = false
  /**
   * Set WHILE `suspend()`/`stop()` tear the child down (the lock/quit kill path), cleared in the
   * teardown's `finally` — the reranker's `tearingDown` analogue. `suspend()` (workspace lock) does
   * NOT arm the permanent `stopped` latch, so without this a racing `ensureStarted` could spawn a
   * fresh ~10 GB sidecar that outlives the lock, co-resident with the vault re-encrypt. A
   * translate() arriving after a suspend still lazily restarts (the flag is cleared).
   */
  private tearingDown = false
  /**
   * Failed-start latch (the reranker/embedder pattern): a permanent load fault (e.g. an
   * incompatible GGUF) must not re-spawn + re-await the full health timeout on every window. A
   * TRANSIENT port-bind race does NOT arm it (see `ensureStarted`'s `.catch`) — the latch SURVIVES
   * `suspend()`, so latching a race would silently disable translation for the whole session.
   */
  private startFailed: Error | null = null
  /** Number of translate() calls currently using the sidecar. Guards the idle teardown. */
  private inFlight = 0
  /** The pending idle-teardown timer handle (armed only when `inFlight === 0`), or null. */
  private idleHandle: IdleTimerHandle | null = null
  /** An in-flight SOFT idle teardown, tracked so `stop()` can await it (no orphan on quit). */
  private idleTeardownPromise: Promise<void> | null = null
  /**
   * The in-flight HARD teardown (`suspend()`/`stop()`), held so overlapping calls SHARE one pass
   * (M5). Without it a second, overlapping teardown sees `this.server` already nulled by the first,
   * runs a no-op body, and its `finally` clears `tearingDown` while the first is STILL inside
   * `server.stop()`'s SIGTERM→2 s→SIGKILL window — a racing `translate()` then cold-starts during the
   * vault re-encrypt, and a quit can exit with the escalation pending (orphan on POSIX). `tearingDown`
   * clears — together with this promise — only when the shared pass has fully settled.
   */
  private teardownPromise: Promise<void> | null = null
  private readonly idleTimeoutMs: number
  private readonly idleClock: IdleClock

  constructor(private readonly opts: TranslationRuntimeOptions) {
    this.modelId = opts.modelId
    this.ctxTokens = opts.contextTokens ?? DEFAULT_TRANSLATION_CONTEXT_TOKENS
    this.idleTimeoutMs = opts.idleTimeoutMs ?? readIdleTimeoutMs()
    this.idleClock = opts.idleClock ?? REAL_IDLE_CLOCK
  }

  /** The launched context window (`--ctx-size`) — the budget TG-3's window planner clamps against. */
  contextWindow(): number {
    return this.ctxTokens
  }

  /** Lazily spawn the translation sidecar (once). Concurrent callers share one start (single-flight). */
  private async ensureStarted(): Promise<LlamaServer> {
    // Any use of the sidecar resets the idle clock: a teardown must never fire out from under an
    // imminent request.
    this.cancelIdleTimer()
    if (this.stopped) throw new Error('Translation runtime is stopped (app is shutting down)')
    if (this.tearingDown) throw new Error('Translation runtime is suspending (workspace is locking)')
    if (this.startFailed) throw this.startFailed
    if (this.server) return this.server
    // A SOFT idle teardown may be mid-kill: `idleTeardown` nulled `this.server` SYNCHRONOUSLY and is
    // now awaiting the child's exit. Wait it out before cold-starting so a translate racing the soft
    // teardown never briefly holds TWO ~10 GB sidecars co-resident (the double-load — M5 improvement).
    // Re-check the latches after the await: a lock/quit may have begun, or another caller may have
    // already restarted the sidecar, while we waited.
    if (this.idleTeardownPromise) {
      await this.idleTeardownPromise.catch(() => undefined)
      if (this.stopped) throw new Error('Translation runtime is stopped (app is shutting down)')
      if (this.tearingDown) throw new Error('Translation runtime is suspending (workspace is locking)')
      if (this.server) return this.server
    }
    if (!this.starting) {
      const server = new LlamaServer({
        binPath: this.opts.binPath,
        modelPath: this.opts.modelPath,
        contextTokens: this.ctxTokens,
        // NO `--jinja` (the #20305 regression, plan §2 D2) and NOT CHAT_SERVER_ARGS. `--parallel 1`
        // (sequential windows; #25142) + `--device none` (CPU-pinned for TG-2, plan §2 D8) +
        // `--chat-template gemma` (avoids the #20305 STARTUP crash — see TRANSLATION_TEMPLATE_ARGS).
        extraArgs: [...TRANSLATION_SERVER_ARGS],
        spawn: this.opts.spawn,
        fetchImpl: this.opts.fetchImpl,
        findPort: this.opts.findPort,
        threads: this.opts.threads,
        healthTimeoutMs: this.opts.healthTimeoutMs,
        healthIntervalMs: this.opts.healthIntervalMs,
        host: this.opts.host,
        // M1: a mid-session sidecar crash (the child dies on its own AFTER becoming healthy — driver
        // crash, VRAM/RAM exhaustion) otherwise leaves `this.server` pointing at a dead handle: every
        // subsequent `translate()` fails with a connection error, and each failed attempt re-arms the
        // idle clock, so the outage persists as long as attempts arrive < the idle window apart. Drop
        // the dead handle here so the NEXT `translate()` cold-starts (the doc-task's one retry then
        // gets a fresh spawn). Identity-compared so a late crash notification can never clobber a
        // NEWER instance that a soft teardown + restart already installed. `LlamaServer` fires this
        // only for a healthy child dying outside `stop()`, so a lock/quit kill never trips it.
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
          const error = err instanceof Error ? err : new Error(String(err))
          // A TRANSIENT port-bind race must NOT arm the latch (the reranker F7 fix): the latch
          // survives suspend(), so latching a race would kill translation for the whole session.
          if (!isBindRaceError(error.message)) this.startFailed = error
          throw error
        })
        .finally(() => {
          this.starting = null
        })
    }
    await this.starting
    // A teardown (lock/quit) may have begun during the await above and nulled the server we'd
    // return — re-check rather than hand back a sidecar that's being / about to be stopped.
    if (this.stopped) throw new Error('Translation runtime is stopped (app is shutting down)')
    if (this.tearingDown) throw new Error('Translation runtime is suspending (workspace is locking)')
    if (!this.server) throw new Error('Translation server failed to start')
    return this.server
  }

  /**
   * Translate ONE window: format the trained prompt (`buildTranslationPrompt`), POST it to the raw
   * `/completion` endpoint with `temperature 0` (greedy — deterministic MT) + `stop:
   * ["<end_of_turn>"]`, stream the translation through `onToken`, and return the full text. Honours
   * `signal` (a user "Stop") combined with the per-request timeout.
   */
  async translate(opts: TranslateOptions): Promise<string> {
    // Cancel the idle timer and mark a job in flight BEFORE the (possibly slow, cold-start)
    // ensureStarted await, so a teardown can't fire during the start either.
    this.cancelIdleTimer()
    this.inFlight++
    try {
      return await this.runTranslate(opts)
    } finally {
      this.inFlight--
      // The last job to settle re-arms the idle clock; a still-running job leaves it disarmed.
      if (this.inFlight === 0) this.armIdleTimer()
    }
  }

  private async runTranslate(opts: TranslateOptions): Promise<string> {
    const server = await this.ensureStarted()
    const prompt = buildTranslationPrompt({
      sourceLang: opts.sourceLang,
      targetLang: opts.targetLang,
      text: opts.text
    })
    const body = JSON.stringify({
      prompt,
      stream: true,
      // Greedy decode — MT wants deterministic output (plan §2 D2). Stop at the turn boundary so
      // `<end_of_turn>` never leaks into the translation (a smoke assertion).
      temperature: 0,
      stop: [TRANSLATION_STOP_TOKEN],
      // Loopback compute hint: reuse the KV prefix across windows that share the instruction
      // prefix. Purely local, no telemetry (the chat-stream precedent).
      cache_prompt: true,
      ...(opts.maxTokens != null ? { n_predict: opts.maxTokens } : {})
    })
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    // Own the (long) timeout so it is cleared the instant the window finishes (REL-4).
    const combined = combineSignals(opts.signal, timeoutMs)
    try {
      const res = await server.fetch('/completion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: combined.signal
      })
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined)
        throw new Error(`Translation request failed: HTTP ${res.status}`)
      }
      if (!res.body) throw new Error('Translation request returned an empty response body')
      let out = ''
      for await (const delta of readCompletionSSE(res.body, opts.signal, opts.onFinal)) {
        out += delta
        opts.onToken?.(delta)
      }
      return out
    } finally {
      combined.clear()
    }
  }

  /**
   * Kill the sidecar PERMANENTLY (no-op if never started). Used on `will-quit`, where a racing
   * lazy start must not resurrect the child as an orphan. Awaits an in-flight lazy start AND an
   * in-flight soft idle teardown so neither leaves an orphaned child after the app quits.
   */
  async stop(): Promise<void> {
    this.stopped = true
    await this.teardown()
    // Re-cancel AFTER the awaits so stop()'s postcondition ("no idle timer is live on return")
    // holds locally, independent of armIdleTimer's guards (the vision R7 defense-in-depth backstop).
    this.cancelIdleTimer()
  }

  /**
   * Kill the sidecar but allow a lazy restart on the next `translate()` — used on workspace LOCK,
   * like the reranker/E5 `suspend()`. The 12B keeps recent source/translation text in its KV cache,
   * so it must die before the vault re-encrypts; it comes back lazily after unlock. A PERMANENT
   * `startFailed` latch survives a suspend (a GGUF the server could not load won't load after
   * unlock either); a transient bind race never armed it, so a port race can't wrongly disable
   * translation past a lock/unlock.
   */
  async suspend(): Promise<void> {
    await this.teardown()
  }

  private teardown(): Promise<void> {
    // Single-flight (M5): an overlapping teardown — two suspends racing, or a quit `stop()` arriving
    // while a suspend's kill is still in its SIGTERM→SIGKILL window — SHARES this pass rather than
    // starting a second one. A second pass would see `this.server` already nulled, run a no-op body,
    // and its `finally` would clear `tearingDown` prematurely (see the field comment). `tearingDown`
    // + `teardownPromise` therefore clear together, only when the shared promise settles below.
    if (this.teardownPromise) return this.teardownPromise
    // Bar a racing ensureStarted from spawning a sidecar that would outlive this teardown (and
    // survive a lock). `stop()` also arms the permanent `stopped` latch before calling this.
    this.tearingDown = true
    this.cancelIdleTimer()
    // The `.finally` runs on a microtask, never synchronously — so the `this.teardownPromise = run`
    // assignment below always wins the race even when `doTeardown()` completes without awaiting.
    const run = this.doTeardown().finally(() => {
      // Cleared so a post-suspend translate() can lazily restart (suspend permits a fresh start;
      // only stop()'s separate, permanent `stopped` latch blocks that).
      this.tearingDown = false
      this.teardownPromise = null
    })
    this.teardownPromise = run
    return run
  }

  private async doTeardown(): Promise<void> {
    // A lazy start may be in flight (first translate() racing quit/lock) — wait it out so the
    // spawned child can't outlive the app as an orphan. Likewise an in-flight soft idle teardown.
    if (this.starting) await this.starting.catch(() => undefined)
    if (this.idleTeardownPromise) await this.idleTeardownPromise.catch(() => undefined)
    const server = this.server
    this.server = null
    if (server) await server.stop()
  }

  // ---- Idle-teardown interlock (the vision RUNTIME-4 pattern) --------------------------

  private cancelIdleTimer(): void {
    if (this.idleHandle) {
      this.idleHandle.clear()
      this.idleHandle = null
    }
  }

  /** Arm the idle teardown — but only when there is a live, idle sidecar to reclaim. */
  private armIdleTimer(): void {
    this.cancelIdleTimer()
    if (this.stopped || this.tearingDown || this.starting || this.inFlight > 0 || !this.server) return
    this.idleHandle = this.idleClock.set(() => {
      this.idleHandle = null
      void this.idleTeardown()
    }, this.idleTimeoutMs)
    // Never let the idle timer keep the process alive (it would block a clean quit).
    this.idleHandle.unref?.()
  }

  /**
   * SOFT teardown fired by the idle timer: kill the child but do NOT latch `stopped`, so the next
   * `translate()` cold-starts cleanly. Guarded so it can never run under a `starting`/in-flight job
   * — if a job slipped in after the timer fired, we skip and that job's `finally` re-arms the clock.
   */
  private async idleTeardown(): Promise<void> {
    if (this.stopped || this.tearingDown || this.starting || this.inFlight > 0 || !this.server) return
    const server = this.server
    // Null the reference SYNCHRONOUSLY before awaiting the kill: a translate() arriving
    // mid-teardown then sees `server === null` and cold-starts a fresh, independent child.
    this.server = null
    this.idleTeardownPromise = server.stop().finally(() => {
      this.idleTeardownPromise = null
    })
    await this.idleTeardownPromise
  }
}
