import { statSync } from 'node:fs'
import type { ChatDepthMode, JsonSchema, RuntimeStatus } from '../../../shared/types'
import { ModelOccupancy } from './occupancy'
import type { SpeculativeDecoding } from '../../../shared/manifest'

export { ModelOccupancy } from './occupancy'
export type { OccupancyLane } from './occupancy'

// Runtime manager (spec §7.5). Defines the swappable ModelRuntime interface so the
// mock runtime and the real llama.cpp sidecar are interchangeable behind the same
// contract. The manager owns exactly one active runtime and restarts it on model
// switch. Real runtimes MUST bind 127.0.0.1 only.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Which admission lane a generation belongs to. 'in-app' (the default) covers every one
 * of the app's own surfaces — chat/RAG, doc tasks, skill runs, compaction, the benchmark.
 * 'external' is reserved for local-API requests. The manager's generation gate counts
 * both lanes and lets an ENTERING in-app generation pre-empt the external lane, never
 * the reverse (D8: in-app wins).
 *
 * CONSUMER CONTRACT for the external lane: the consumer MUST guarantee the stream
 * generator settles — `try { for await … } finally { await gen.return() }` — on every
 * exit path including client disconnects. The gate's counter decrements in the
 * generator's `finally`, which only a pull or `return()` can reach; an abandoned
 * generator leaks the count until the next model start/stop heals it (gate epoch), and
 * in the meantime external admission stays refused.
 */
export type GenerationLane = 'in-app' | 'external'

/** Thrown synchronously-on-first-pull when an external-lane stream would run alongside an
 *  in-app generation — the caller (local API) maps it to a 429 busy response. */
export class ExternalGenerationBusyError extends Error {
  constructor() {
    super('An in-app generation is active — external request refused')
    this.name = 'ExternalGenerationBusyError'
  }
}

/**
 * llama-server's per-request timing block, as carried on a streamed chat completion's final
 * chunk(s) (issues #290/#291). Decode figures (`predicted_*`) cover generation only — prompt
 * processing (prefill) is the separate `prompt_*` pair — and count TOKENS, not SSE chunks, so
 * they stay honest under MTP speculative decoding (#182), where one chunk can carry an accepted
 * draft run of several tokens. Every field is optional: the shape is upstream-defined and a
 * runtime that sends none (the mock; an older server) simply reports no timings. This is the
 * ONE shared timings type for the chat runtime boundary (spec §9.2) — the translation sidecar's
 * `CompletionTimings` describes the native `/completion` shape and is deliberately not reused.
 */
export interface RuntimeTimings {
  /** Generated (decode) tokens in this completion. */
  predicted_n?: number
  /** Wall milliseconds spent generating them. */
  predicted_ms?: number
  /** Prompt tokens processed (prefill). */
  prompt_n?: number
  /** Wall milliseconds spent on prefill. */
  prompt_ms?: number
  /** Decode throughput, tokens per second — the headline speed figure. */
  predicted_per_second?: number
  /** Prefill throughput, tokens per second. */
  prompt_per_second?: number
}

export interface RuntimeChatOptions {
  /** Explicit caps/sampling; when set they WIN over anything `mode` would derive. */
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  /** Admission lane (see `GenerationLane`). Omitted = 'in-app'. */
  lane?: GenerationLane
  /**
   * Answer-depth mode (spec §10.3). Real runtimes map it to the model's thinking
   * switch + sampling (see `requestParamsForMode` in `llama.ts`); the mock runtime
   * ignores it. Omitted = 'balanced'.
   */
  mode?: ChatDepthMode
  /**
   * Receives reasoning ("thinking") deltas, which stream SEPARATELY from the answer
   * tokens the generator yields (llama-server `--reasoning-format deepseek` puts them
   * in `delta.reasoning_content`). Live-display affordance only — reasoning is never
   * part of the yielded content and is never persisted (architecture.md "Chat & streaming").
   */
  onReasoning?: (delta: string) => void
  /**
   * Receives the completion's `finish_reason` once, when the model stops: 'stop' (EOS / a stop
   * token — a complete reply), 'length' (the reply hit the token/context ceiling and is CUT OFF),
   * or another server-defined reason. Lets the chat service flag a length-truncated answer so the
   * UI can say the reply was cut off instead of stopping mid-word silently. Never fired on a user
   * abort (an aborted request carries no final chunk). The mock runtime reports 'stop' on a clean
   * finish; a runtime that can't report one simply never calls it (callers treat that as 'stop').
   *
   * The optional second argument carries the server's per-request `timings` when the stream
   * had them (#290/#291 — the last top-level `timings` object seen on any chunk, handed up once
   * at the `[DONE]` sentinel / clean close). Undefined when the runtime sent none (the mock).
   * Existing callers that take only the reason stay source-compatible.
   */
  onFinish?: (finishReason: string, timings?: RuntimeTimings) => void
  /**
   * Grammar-constrained decoding (D55): when set, the runtime constrains the model's output to
   * this JSON Schema via llama-server's OpenAI-compatible `response_format: { type: 'json_schema' }`,
   * so the completion is GUARANTEED to be JSON matching the schema (the model cannot emit an
   * off-schema token). The bank-statement LLM categorizer is the first consumer — it constrains the
   * reply to a fixed category enum so a category is never invented. Loopback-only, offline; the mock
   * runtime ignores it. `responseSchemaName` is the schema's label llama-server echoes (cosmetic).
   */
  responseSchema?: JsonSchema
  responseSchemaName?: string
}

export interface RuntimeStartOptions {
  modelId: string
  /** Absolute path to the weight file. */
  modelPath: string
  contextTokens: number
  /**
   * Total on-disk bytes the load window will read (#107): the GGUF plus, for a vision
   * model, its mmproj projector. Optional — supplied by `startModelRuntime` (which has
   * the manifest); when absent the manager stats `modelPath` alone, which under-counts
   * vision loads by the projector's size.
   */
  weightBytes?: number | null
  /**
   * Absolute paths of every file the load window reads (the GGUF plus, for a vision
   * model, its mmproj projector) — the #114 concurrent prefetch reads them sequentially
   * alongside the first rung's load. Optional — supplied by `startModelRuntime` (which
   * has the manifest); when absent the ladder prefetches `modelPath` alone.
   */
  weightPaths?: string[]
  /**
   * The model manifest's `speculative_decoding` opt-in (#182), or null/absent for the
   * models that do not declare it — which is all of them but the two Qwen3.8 chat quants.
   * Supplied by `startModelRuntime` (which has the manifest); the START LADDER decides
   * whether the hardware actually permits it and maps the name to server flags. Nothing
   * downstream of the ladder reads it.
   */
  speculativeDecoding?: SpeculativeDecoding | null
  /**
   * The model manifest's `disable_prompt_cache` (#512): true when llama-server cannot restore this
   * model's evicted prompt on the pinned runtime. Supplied by `startModelRuntime` (which has the
   * manifest); the chat argv builder maps true to the code-owned `--cache-ram 0`
   * (`shared/prompt-cache-rules.ts`). Absent/false ⇒ the cache stays on with its RAM-scaled
   * ceiling.
   */
  disablePromptCache?: boolean
}

export interface HealthStatus {
  healthy: boolean
  message: string
  /** Local port the runtime listens on, or null for runtimes without a server. */
  port: number | null
}

/** Which inference backend a runtime landed on (the start ladder in factory.ts). */
export type RuntimeBackend = 'gpu' | 'cpu' | 'mock'

/**
 * Backend reported for a runtime that carries no label. Only a bare `LlamaRuntime`
 * (injected directly in tests) lacks one — the production factory always returns the
 * labelled ladder runtime or the mock — and a bare LlamaRuntime with no GPU args
 * runs on the CPU.
 */
const UNLABELLED_BACKEND: RuntimeBackend = 'cpu'

/** The contract every inference backend implements (spec §9.2). */
export interface ModelRuntime {
  readonly modelId: string
  /** Backend label after start() (ladder/probe-derived); optional for bare runtimes. */
  readonly backend?: RuntimeBackend
  /** Probed GPU name when backend === 'gpu'. */
  readonly gpuName?: string | null
  start(): Promise<void>
  stop(): Promise<void>
  health(): Promise<HealthStatus>
  /** Stream assistant tokens (answer text only — reasoning goes via `onReasoning`). */
  chatStream(messages: ChatMessage[], options?: RuntimeChatOptions): AsyncGenerator<string, void, unknown>
  /**
   * The token window the runtime was launched with (llama-server's `--ctx-size`) — the
   * real budget chat/RAG assembly trims against (context-compaction record §L0). Optional:
   * a runtime that can't report one (e.g. a bare test stub) lets callers fall back to
   * `settings.contextTokens` via `effectiveContextWindow`. The three production runtimes
   * (llama, mock, ladder) all report it; it is fixed for a runtime's lifetime (the window
   * is set at start and never changes without a restart).
   */
  contextWindow?(): number
  /**
   * Whether this runtime has already streamed at least one REAL model generation since it
   * started (#39): the first generation after a model start/switch pays the one-time costs
   * (weights into memory, the long system-prompt prefill that `cache_prompt` then reuses),
   * so the Chat screen shows a calm "warming up" hint only while this is still false.
   * Flips on the first streamed chunk (answer token OR reasoning delta — either proves the
   * prefill is done). Optional: a bare test stub without it reports no `warmedUp` status
   * and the hint simply never shows. Deterministic no-model answers (routing/refusal/
   * listing) never call `chatStream`, so they leave this untouched.
   */
  warmedUp?(): boolean
}

export type RuntimeFactory = (opts: RuntimeStartOptions) => ModelRuntime

/** The CODE-3 latch refusal — content-free; auto-start logs it, users never see it. */
function shutdownError(): Error {
  return new Error('Runtime manager is shut down (the app is quitting)')
}

/**
 * Bound on the in-app pre-emption wait for the external stream's teardown. The abort
 * fired by the pre-emption hook cancels the external request's sidecar socket
 * IMMEDIATELY (the KV slot frees), so past this bound only a misbehaving consumer's
 * never-resumed generator is left — proceed rather than wedge every in-app turn behind
 * it (its leaked count self-heals on the next start/stop via the gate epoch).
 */
const EXTERNAL_TEARDOWN_TIMEOUT_MS = 5_000

/**
 * #599: how long a `/health` re-probe result stands (`refreshHealth`). The status read that asks
 * runs every 2.5 s while a screen polls; one probe per 10 s keeps a frozen process visible within
 * seconds without a probe per poll (each costs one loopback request, ~60 ms on b11146).
 */
const HEALTH_PROBE_TTL_MS = 10_000

/**
 * #599: a runtime's watchdog verdict — "the model stopped responding" — is an Error named
 * `RuntimeUnresponsiveError` (llama.ts's CB-5 class). Matched by name so the manager stays free of
 * any concrete runtime (spec §9.2): another backend signals the same verdict the same way.
 */
function isUnresponsiveVerdict(err: unknown): boolean {
  return err instanceof Error && err.name === 'RuntimeUnresponsiveError'
}

/**
 * Holds the single active runtime. The factory lets us swap mock → llama.cpp
 * without touching callers (the IPC layer just sees start/stop/status).
 */
export class RuntimeManager {
  private current: ModelRuntime | null = null
  private last: HealthStatus | null = null
  /**
   * Serializes every start/stop. A real GGUF start can take up to the health timeout;
   * without this, a second `start()` in that window saw `current == null`, skipped the
   * stop, and spawned a SECOND llama-server the manager never stopped (an orphan), and
   * a `stop()` during an in-flight start was a no-op the start then overrode. Queueing
   * makes those calls wait for the in-flight operation and act on its committed result.
   */
  private op: Promise<unknown> = Promise.resolve()
  /**
   * The model id whose start is currently in flight (set synchronously when `start()` is
   * called, cleared when that start settles). Surfaced via `status().startingModelId` so
   * the UI can show a disabled "Starting…" state across screen remounts, and used to make
   * `start()` idempotent — a second start for the SAME model (a double-click or a revisit
   * while the first is still loading) must not stop-and-restart the runtime.
   */
  private startingModelId: string | null = null
  /**
   * #599: who owns the "starting" window — the last `start()` / `forceRestart()` that claimed it.
   * Only the owner clears it. Comparing model ids let a start whose warm-up crashed clear the flag
   * of the crash restart queued behind it (same model), so the restart read "Stopped" throughout.
   */
  private startingClaim: object | null = null
  /** #107: Date.now() when the in-flight start began; null outside a start window.
   *  Stamped synchronously with `startingModelId` and RE-stamped at queue-drain inside
   *  `doStart` so a switch's elapsed measures THIS load, not the old model's stop. */
  private startingSince: number | null = null
  /** #107: on-disk bytes the in-flight load reads; resolved once per window in doStart. */
  private startingBytesTotal: number | null = null
  /**
   * The runtime instance a start is currently bringing up INSIDE the queue (full-audit
   * 2026-07-11 CODE-2) — set by `doStart` before `next.start()`, cleared when that await
   * settles. `stop()` uses it to cancel the in-flight start directly: the queue
   * deliberately runs stop AFTER start settles (that ordering prevents orphans), but a
   * start loading a 20 GB GGUF — or walking a failing ladder for up to ~9 min of serial
   * health timeouts — used to be uncancellable, so quit and "Lock now" froze behind it.
   */
  private startingRuntime: ModelRuntime | null = null
  /**
   * Permanent shutdown latch (full-audit 2026-07-11 CODE-3), mirroring
   * `TranslationRuntime.stopped`: armed by `shutdown()` at the very top of the quit
   * teardown (`performShutdown`) and never cleared. Without it, a background auto-start
   * that spends a long pre-start window hashing a multi-GB weight (`startModelRuntime`)
   * could complete DURING the teardown and enqueue a fresh start AFTER the stop —
   * `app.exit(0)` then kills the parent mid-start and the child survives as an orphan
   * (loopback port + GBs of RAM held, especially on Windows). Once set,
   * `start()`/`forceRestart()` reject WITHOUT invoking the factory, and a start already
   * sitting in the queue refuses inside `doStart` before it can spawn.
   */
  private stopped = false

  /**
   * The background-job occupancy spans (issues #185/#186 — see `occupancy.ts`). It lives on
   * the manager because the manager is the authority on who has the model: the generation
   * gate below answers "is a `chatStream` pull in flight RIGHT NOW", this answers "is a
   * multi-step background job holding the model across its own gaps". Every guard that has
   * to refuse a second job reads this one; `isExternallyBusy` folds it in so the local API
   * waits on a doc task / skill run / benchmark honestly instead of slipping into a gap
   * between two of its model calls.
   */
  readonly occupancy = new ModelOccupancy()

  // ---- Generation gate ------------------------------------------------------------------
  //
  // Generation reaches the model through several lanes (chat/RAG streams, doc tasks, skill
  // runs, the benchmark, chat compaction, classification) — all via `active().chatStream`.
  // No per-lane registry sees them all, so the busy signal lives HERE: `doStart` wraps the
  // factory-returned runtime (ladder AND mock — the gate CI exercises is the shipped one)
  // in a decorator whose chatStream counts per-lane in-flight generations. External
  // admission (the local API) reads `isGenerating()` and FAILS CLOSED: no active runtime
  // (which includes the whole start window — the #109 warm-up generation runs against the
  // inner rung runtime while `active()` is still null) means "busy", never "idle".
  /** In-flight generation count per lane; mutated only inside the gate wrapper. */
  private readonly laneCounts: Record<GenerationLane, number> = { 'in-app': 0, external: 0 }
  /** Parked settle-functions of in-app entries awaiting the external lane's teardown. */
  private externalIdleWaiters: Array<() => void> = []
  /**
   * Gate generation counter: bumped (and lane counts zeroed, waiters flushed) on every
   * model start/stop, so a count leaked by an abandoned external generator — whose
   * `finally` only a pull or `return()` can reach — self-heals on the next runtime
   * transition instead of wedging admission forever. In-flight streams of the old epoch
   * skip their decrement (their count was already zeroed with the epoch).
   */
  private gateEpoch = 0
  /**
   * Fired synchronously whenever an in-app generation enters (D8) — the local-API
   * admission registers a hook that aborts its active AND queued/admitted-but-unstarted
   * requests (firing even when no external stream is counted yet is what cancels the
   * admitted-but-unstarted class). The gate then awaits the active external stream's
   * actual teardown (count → 0) before the in-app generation issues — bounded, because
   * the abort already cancels the sidecar socket (freeing the KV slot) even when a
   * misbehaving consumer never resumes its generator.
   */
  private externalPreemptionHook: ((reason: string) => void) | null = null
  private readonly externalTeardownTimeoutMs: number
  /**
   * Narrow change seam (PR #303 P3): fired synchronously AFTER every transition `status()`
   * reports differently — a start admitted (`startingModelId` set), a start committed
   * (`current` set, ready), a start settled without a commit (failed or cancelled), and a
   * stop (`current` cleared). The main layer subscribes to push the Performance screen; the
   * manager itself imports nothing Electron. Listeners are isolated: one that throws never
   * fails a start or a stop.
   */
  private readonly changeListeners = new Set<() => void>()
  /**
   * #600: ends the work in flight on the model about to be killed — the composition seam registers
   * one (`endWorkOnModelStop`: the local API's request, a deep-index build, the chat and document
   * answers). Called from `doStop` for every stop and switch EXCEPT the crash restart
   * (`forceRestart`: that sidecar is already dead and its answers have already failed):
   *   - AFTER `current` is cleared, so nothing new can start on the dying model meanwhile;
   *   - synchronously and BEFORE the kill, with no wait in between. Aborting is instant and an
   *     answer's partial persists with no help from the sidecar, while a wait would open a window
   *     in which a GPU crash queues a `forceRestart` of the model the user just stopped.
   * Lock and quit abort their work first anyway; the second abort is a no-op (first reason wins).
   * `kind` says whether a start follows ('switch') or not ('stop'). A throwing hook never blocks
   * the stop.
   */
  private modelStopHook: ((kind: 'stop' | 'switch') => void) | null = null

  // ---- Liveness of the running model (#599) ---------------------------------------------
  //
  // `last` used to be the start's health check, never re-read: a frozen sidecar (the #594 hang
  // answered neither chat nor `/health`) stayed "running, healthy" on every surface. Two signals now
  // feed `status().unresponsive`: a `/health` re-probe on status reads (a frozen or suspended
  // process), and an answer the CB-5 watchdog ended (a wedged compute loop, which `/health` — served
  // by the HTTP thread — cannot see).
  /** #599: the options the running model was started with — what a user Restart starts again. */
  private currentOpts: RuntimeStartOptions | null = null
  /** #599: an answer ended on the CB-5 watchdog. Sticky: a passing `/health` cannot clear it — only
   *  the next completed answer or a new runtime does. */
  private wedged = false
  /** #599: when the last `/health` re-probe settled (`performance.now()`), and the one in flight. */
  private probedAt = 0
  private probeInFlight: Promise<void> | null = null
  private readonly healthProbeTtlMs: number
  /** #599: starts requested and not yet settled (`beginStartRequest`), the weight check included. */
  private startRequests = 0

  constructor(
    private readonly factory: RuntimeFactory,
    opts?: { externalTeardownTimeoutMs?: number; healthProbeTtlMs?: number }
  ) {
    this.externalTeardownTimeoutMs = opts?.externalTeardownTimeoutMs ?? EXTERNAL_TEARDOWN_TIMEOUT_MS
    this.healthProbeTtlMs = opts?.healthProbeTtlMs ?? HEALTH_PROBE_TTL_MS
  }

  /** True while ANY lane has an in-flight generation. For external admission use
   *  {@link isExternallyBusy} — this narrower read is NOT fail-closed on its own. */
  isGenerating(): boolean {
    return this.laneCounts['in-app'] > 0 || this.laneCounts.external > 0
  }

  /**
   * THE busy predicate for external (local-API) admission: any in-flight generation, OR
   * no active runtime — fail closed. `active()` is null through the whole start window,
   * which is exactly when the #109 warm-up generation streams against the inner rung
   * runtime, invisible to the gate; treating that window as busy closes it.
   *
   * #185/#186: a held occupancy span counts too. Without it a doc task, a skill run, or the
   * benchmark would look idle in the gap between two of its own model calls, and an external
   * request admitted into that gap would then interleave with the job's next call — the same
   * defect the spans exist to close in-app, appearing on the external lane.
   */
  isExternallyBusy(): boolean {
    return this.current == null || this.isGenerating() || this.occupancy.isBusy()
  }

  /** Register/clear the external pre-emption hook (one consumer: local-API admission). */
  setExternalPreemption(hook: ((reason: string) => void) | null): void {
    this.externalPreemptionHook = hook
  }

  /** #600: register/clear the hook that ends in-flight work when the model is stopped (see field). */
  setModelStopHook(hook: ((kind: 'stop' | 'switch') => void) | null): void {
    this.modelStopHook = hook
  }

  /**
   * Subscribe to runtime transitions (starting, ready, stopped — see `changeListeners`);
   * returns the unsubscribe. Fired after the state is committed, so `status()` read inside
   * the callback already reports the new state.
   */
  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb)
    return () => {
      this.changeListeners.delete(cb)
    }
  }

  private emitChange(): void {
    for (const cb of this.changeListeners) {
      try {
        cb()
      } catch {
        /* a listener is an observer of the runtime, never a participant in its lifecycle */
      }
    }
  }

  /**
   * #599: re-check the running model's `/health`, at most once per `healthProbeTtlMs`. Called by the
   * status read (`getRuntimeStatus`), never by a timer, so an idle app probes nothing. A failed
   * probe marks the model unresponsive until a later probe passes; concurrent reads share one
   * probe, and a probe that outlives a stop or switch is discarded.
   */
  refreshHealth(): Promise<void> {
    const runtime = this.current
    if (!runtime) return Promise.resolve()
    if (this.probeInFlight) return this.probeInFlight
    if (performance.now() - this.probedAt < this.healthProbeTtlMs) return Promise.resolve()
    const probe = (async () => {
      let health: HealthStatus
      try {
        health = await runtime.health()
      } catch (err) {
        health = { healthy: false, port: this.last?.port ?? null, message: `Health check failed: ${String(err)}` }
      }
      if (this.current !== runtime) return
      const changed = (this.last?.healthy ?? false) !== health.healthy
      this.last = health
      if (changed) this.emitChange()
    })().finally(() => {
      this.probedAt = performance.now()
      this.probeInFlight = null
    })
    this.probeInFlight = probe
    return probe
  }

  /** #599: set the watchdog mark; a change is a status transition. */
  private setWedged(wedged: boolean): void {
    if (this.wedged === wedged) return
    this.wedged = wedged
    this.emitChange()
  }

  /**
   * #599: a model start was requested — from the top of `startModelRuntime`, before its weight check
   * (minutes on a freshly copied drive) and before `start()` sets `startingModelId`. Returns the
   * release (idempotent). While any is open, `status().startRequested` is true and the "no model is
   * running" refusals say "is starting" instead.
   */
  beginStartRequest(): () => void {
    this.startRequests++
    if (this.startRequests === 1) this.emitChange()
    let released = false
    return () => {
      if (released) return
      released = true
      this.startRequests--
      if (this.startRequests === 0) this.emitChange()
    }
  }

  /** #599: a start is requested or loading — the "is starting" predicate of the no-model refusals. */
  isStarting(): boolean {
    return this.startRequests > 0 || this.startingModelId != null
  }

  /**
   * #599: the AI Model card's "Restart" — start the running model again with the options it was
   * started with, past `start()`'s same-model guard (`forceRestart`). The user acted on the model, so
   * its in-flight answers end as a switch ends them (#600). Null when nothing runs. A start already
   * in flight (a crash restart, a switch) replaces the runtime anyway: the Restart joins it instead
   * of loading the model twice — or undoing the switch.
   */
  async restartCurrent(): Promise<RuntimeStatus | null> {
    const opts = this.currentOpts
    if (!opts) return null
    if (this.startingModelId != null) return this.enqueue(() => Promise.resolve(this.status()))
    return this.forceRestart(opts, 'switch')
  }

  /**
   * #599: a CPU-mode crash the app does not restart (its one restart this session is spent): drop
   * the dead runtime so every surface says stopped. No model-stop hook — its answers already failed
   * on the dead socket. A no-op when another model runs by now, or when the runtime answers its
   * health check — a late or duplicate crash report must not take down the healthy runtime that
   * replaced the crashed one.
   */
  stopCrashed(modelId: string): Promise<void> {
    return this.enqueue(async () => {
      const runtime = this.current
      if (runtime?.modelId !== modelId) return
      const health = await runtime.health().catch(() => ({ healthy: false }))
      if (health.healthy || this.current !== runtime) return
      await this.doStop('restart')
    })
  }

  /** Zero the gate for a new runtime epoch (see {@link gateEpoch}). */
  private resetGenerationGate(): void {
    this.gateEpoch++
    this.laneCounts['in-app'] = 0
    this.laneCounts.external = 0
    this.flushExternalIdleWaiters()
  }

  private flushExternalIdleWaiters(): void {
    const waiters = this.externalIdleWaiters
    this.externalIdleWaiters = []
    for (const settle of waiters) settle()
  }

  /**
   * Resolves when the external lane's count reaches 0, the caller aborts, or the
   * teardown bound elapses — never parks forever. Kin to the model-slot arbiter's
   * `handoffWaiters` pattern (analysis/model-slot-arbiter.ts), but refuse/abort
   * semantics rather than cooperative pause/resume.
   */
  private waitExternalIdle(signal?: AbortSignal): Promise<void> {
    if (this.laneCounts.external === 0 || signal?.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', settle)
        this.externalIdleWaiters = this.externalIdleWaiters.filter((w) => w !== settle)
        resolve()
      }
      const timer = setTimeout(settle, this.externalTeardownTimeoutMs)
      ;(timer as { unref?: () => void }).unref?.()
      signal?.addEventListener('abort', settle, { once: true })
      this.externalIdleWaiters.push(settle)
    })
  }

  /** Wrap the factory's runtime so every `chatStream` pull passes the generation gate. */
  private decorateWithGenerationGate(inner: ModelRuntime): ModelRuntime {
    return {
      get modelId() {
        return inner.modelId
      },
      // Live getters: the ladder resolves backend/gpuName during start and flips
      // warmedUp on the first stream — static copies would freeze pre-start values.
      get backend() {
        return inner.backend
      },
      get gpuName() {
        return inner.gpuName
      },
      start: () => inner.start(),
      stop: () => inner.stop(),
      health: () => inner.health(),
      contextWindow: inner.contextWindow?.bind(inner),
      warmedUp: inner.warmedUp?.bind(inner),
      chatStream: (messages, options) => this.gatedChatStream(inner, messages, options)
    }
  }

  /**
   * The gate itself. Counter discipline: increment as the FIRST act of the generator body
   * (so a created-but-never-iterated generator holds no count) and decrement in `finally`
   * (success, error, abandonment via `return()`, and pre-yield throws all release it),
   * epoch-guarded so a stale stream never corrupts a later runtime's counts.
   * Lane rules (D8): an external entry refuses — same synchronous frame as its increment,
   * closing the admit→stream TOCTOU — while the in-app lane is active OR another external
   * stream runs (the external slot is single by design; admission's serialization is
   * advisory, this check is structural). An in-app entry increments first (blocking new
   * externals), cancels the external lane via the hook, then awaits its bounded teardown.
   */
  private async *gatedChatStream(
    inner: ModelRuntime,
    messages: ChatMessage[],
    options?: RuntimeChatOptions
  ): AsyncGenerator<string, void, unknown> {
    const lane: GenerationLane = options?.lane ?? 'in-app'
    const epoch = this.gateEpoch
    this.laneCounts[lane]++
    try {
      if (lane === 'external') {
        if (this.laneCounts['in-app'] > 0 || this.laneCounts.external > 1) {
          throw new ExternalGenerationBusyError()
        }
      } else if (options?.signal?.aborted) {
        // #600: an in-app call whose turn is already aborted generates nothing, so it pre-empts
        // nothing either. A turn the model-stop hook ended inside its compaction pre-pass still
        // reaches here (compaction swallows the abort); without this it would have labelled the
        // local API's request `preempted_by_user` and stamped `lastPreemptedAt`.
        return
      } else {
        try {
          this.externalPreemptionHook?.('in-app generation entered')
        } catch {
          /* abort plumbing must never fail an in-app turn */
        }
        if (this.laneCounts.external > 0) {
          await this.waitExternalIdle(options?.signal)
          // A user Stop during the pre-emption wait ends the turn cleanly (the same
          // yield-nothing shape every runtime uses for an abort).
          if (options?.signal?.aborted) return
        }
      }
      try {
        yield* inner.chatStream(messages, options)
      } catch (err) {
        // #599: the CB-5 watchdog gave up on the model — the status says so until it answers again.
        if (isUnresponsiveVerdict(err) && epoch === this.gateEpoch) this.setWedged(true)
        throw err
      }
      // #599: a completed answer proves the compute loop works again.
      if (!options?.signal?.aborted && epoch === this.gateEpoch) this.setWedged(false)
    } finally {
      if (epoch === this.gateEpoch) {
        this.laneCounts[lane]--
        if (lane === 'external' && this.laneCounts.external === 0) {
          this.flushExternalIdleWaiters()
        }
      }
    }
  }

  /**
   * Arm the permanent shutdown latch (CODE-3). Synchronous and latch-only so the quit
   * teardown can set it before anything else runtime-related without disturbing the
   * queue's stop-in-progress semantics — `performShutdown` still calls `stop()` (which
   * also cancels an in-flight start, CODE-2) in its awaited sidecar-stop block.
   */
  shutdown(): void {
    this.stopped = true
  }

  /** True once `shutdown()` ran. Long pre-start work re-checks this (CODE-3). */
  isShutdown(): boolean {
    return this.stopped
  }

  /** Run `task` after every previously queued start/stop, success or failure. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.op.then(task, task)
    this.op = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async start(opts: RuntimeStartOptions): Promise<RuntimeStatus> {
    // CODE-3: after shutdown() nothing may spawn — reject before the queue/factory.
    if (this.stopped) throw shutdownError()
    // Idempotent for the same model: if it is already running, or a start for it is
    // already in flight (a double-click, or a revisit to the AI Model screen before the
    // GGUF finished loading), do NOT stop-and-restart it — just resolve with the
    // current/forthcoming status once the queue drains. The old behavior spawned a
    // disruptive restart (two "Start runtime" log lines, two backend selections).
    if (this.startingModelId === opts.modelId || this.current?.modelId === opts.modelId) {
      return this.enqueue(() => Promise.resolve(this.status()))
    }
    // Set synchronously so a concurrent caller sees the in-flight model immediately.
    this.startingModelId = opts.modelId
    const claim = {}
    this.startingClaim = claim
    // #107: when the start actually began — status() derives the elapsed time of the
    // "Starting…" window from it, so the renderer can show honest load progress.
    this.startingSince = Date.now()
    this.emitChange()
    try {
      return await this.enqueue(() => this.doStart(opts))
    } finally {
      // Only clear if no newer start (a switch, or a crash restart of this model) has since
      // claimed the slot.
      if (this.startingClaim === claim) {
        this.startingClaim = null
        this.startingModelId = null
        this.startingSince = null
        this.startingBytesTotal = null
        // The window closed — ready (doStart already announced the commit) or not.
        this.emitChange()
      }
    }
  }

  /**
   * `startFollows`: the app stops the model only to start it again itself (an engine update, the
   * demo → real engine restart). In-flight work then hears "switch", so a local-API client is told
   * to retry (`model_starting`) rather than that a person must start a model (#600).
   */
  async stop(opts?: { startFollows?: boolean }): Promise<void> {
    // CODE-2 (full-audit 2026-07-11): cancel an in-flight start so it settles PROMPTLY
    // instead of holding the queue for the remaining health timeouts. The queue semantics
    // stay untouched (the doStop below still runs only after the start settles and acts on
    // its committed result) — and never a bare timeout race, which would orphan the loading
    // child (report §2.3). `LadderRuntime.stop()` aborts the ladder walk and forwards to the
    // in-flight `LlamaServer.stop()`, whose exit check unblocks `waitForHealthy`.
    const starting = this.startingRuntime
    if (starting) {
      // Fire-and-forget is safe: the enqueued doStop already awaits the start's settle,
      // and the ladder's own failure path re-stops its inner runtime idempotently.
      void Promise.resolve()
        .then(() => starting.stop())
        .catch(() => undefined)
    }
    return this.enqueue(() => this.doStop(opts?.startFollows === true ? 'switch' : 'stop'))
  }

  /**
   * Crash-only restart that DELIBERATELY bypasses the same-model idempotency guard in
   * `start()` (REL-1, audit 2026-06-28). `start()` no-ops when the requested model is
   * already `this.current` — correct for a double-click or an AI-Model-screen revisit, but
   * fatal for the GPU mid-session crash auto-fallback (architecture.md GPU record §5.3): the
   * crashed `LadderRuntime` is still `this.current` (the manager never observes the child's
   * exit — `this.last` is the start's health check, re-probed only on status reads since #599),
   * so wiring the crash restart to
   * `start(sameModel)` early-returns a stale status read, never stops-and-restarts, and leaves
   * `status()` reporting the DEAD server as running/healthy while the next chat/RAG turn routes
   * to it and fails.
   *
   * `forceRestart` instead does `doStop()` (if a runtime is live) then `doStart(opts)` inside
   * ONE enqueued op (`doStart` already stops a live `current` first), so `current`/`last` are
   * cleared atomically — no concurrent queued op can interleave between the stop and the start,
   * and `doStop` nulls `this.last` so `status()` immediately stops reporting the dead server as
   * healthy. `startingModelId` is set synchronously (exactly as `start()` does) so a concurrent
   * user `start(sameModel)` JOINS this restart via the idempotency guard rather than queueing a
   * second one. Normal `start()` idempotency is untouched — only this crash path bypasses it.
   *
   * Retry bound (no restart loop): the caller (`createGpuCrashAutoFallback`) persists
   * `gpuAutoDisabled` BEFORE invoking this, so the ladder rebuilt inside `doStart` skips rung 1
   * and lands on CPU; a later CPU crash does NOT route through `onGpuCrash` (the ladder's
   * `onUnexpectedExit` gates it on `backend === 'gpu'`), so a GPU session auto-falls-back at most
   * once. A CPU-mode crash goes to `onCpuCrash` instead (#599): one restart per model per session,
   * then `stopCrashed`.
   */
  async forceRestart(opts: RuntimeStartOptions, stopKind: 'restart' | 'switch' = 'restart'): Promise<RuntimeStatus> {
    // CODE-3: a crash restart racing the quit teardown must not respawn either.
    if (this.stopped) throw shutdownError()
    this.startingModelId = opts.modelId
    const claim = {}
    this.startingClaim = claim
    // #107: the crash-restart window carries load progress too (it is the slowest start
    // the app performs — a full cold ladder re-walk); doStart re-stamps at queue-drain.
    this.startingSince = Date.now()
    this.emitChange()
    try {
      // #600: the crashed runtime's answers already failed — no model-stop hook on this stop. A user
      // Restart (#599, `restartCurrent`) passes 'switch': its answers end cleanly first.
      return await this.enqueue(() => this.doStart(opts, stopKind))
    } finally {
      // Clear ALL THREE (paired with startingModelId, here and in start()) — a stale
      // startingSince would attribute an old window's elapsed to the next start.
      if (this.startingClaim === claim) {
        this.startingClaim = null
        this.startingModelId = null
        this.startingSince = null
        this.startingBytesTotal = null
        this.emitChange()
      }
    }
  }

  private async doStart(opts: RuntimeStartOptions, stopKind: 'switch' | 'restart' = 'switch'): Promise<RuntimeStatus> {
    // CODE-3: a start that was already IN the queue when shutdown() armed the latch
    // (e.g. enqueued behind an in-flight start/stop) must not spawn either — re-check
    // before touching anything, so the factory is never invoked past the latch.
    if (this.stopped) throw shutdownError()
    // Restart cleanly on a model switch (spec §7.5).
    if (this.current) await this.doStop(stopKind)
    // Fresh gate epoch for the new runtime: zeroes any count a misbehaving external
    // consumer leaked in the previous session (see gateEpoch).
    this.resetGenerationGate()
    // #107: re-stamp the progress clock now that the queue drained (a switch waits out
    // the old model's stop first — elapsed must measure THIS load, not that wait) and
    // resolve the weight's size once per window, here rather than per status() poll
    // (the IPC layer used to re-scan manifests + stat the file on every 2.5 s tick,
    // against the same drive the load is saturating). `weightBytes` (when the caller
    // passed it) covers ALL files the window reads — a vision model also loads its
    // mmproj projector, which the bare GGUF stat under-counts.
    if (this.startingModelId === opts.modelId) {
      this.startingSince = Date.now()
      this.startingBytesTotal = opts.weightBytes ?? statSizeOrNull(opts.modelPath)
    }
    // CODE-3 review follow-up: the internal doStop above can take seconds (SIGTERM →
    // grace → SIGKILL on the old runtime), and in that window the TOP check has already
    // passed while `startingRuntime` is not yet set — a quit arming the latch there is
    // missed by both the check above and stop()'s CODE-2 cancel. Re-check before the
    // factory is invoked, or the switch would spawn and the quit's queued stop would
    // wait out the full model load/health timeout (the CODE-2 freeze, reintroduced).
    if (this.stopped) throw shutdownError()
    // Commit to `this.current`/`this.last` only on a FULLY successful start. A failed
    // start (e.g. the real sidecar's health timeout) must not leave a half-started
    // runtime as "active" — callers gate chat/RAG on `active() != null`, so a stale
    // `current` would route requests to a server that never came up. Clean up + reset.
    const next = this.factory(opts)
    // Visible to stop() so a quit/lock can cancel this start while it is in flight (CODE-2).
    this.startingRuntime = next
    try {
      await next.start()
      const health = await next.health()
      // Commit the GATED runtime: `active()` hands out the decorator, so every caller's
      // chatStream passes the generation gate with zero call-site changes.
      this.current = this.decorateWithGenerationGate(next)
      this.last = health
      // #599: a fresh runtime — its start just proved `/health`, and no answer has failed on it.
      this.currentOpts = opts
      this.wedged = false
      this.probedAt = performance.now()
      this.emitChange()
    } catch (err) {
      try {
        await next.stop()
      } catch {
        /* best-effort cleanup; the start error is what matters */
      }
      this.current = null
      this.last = null
      throw err
    } finally {
      this.startingRuntime = null
    }
    return this.status()
  }

  private async doStop(kind: 'stop' | 'switch' | 'restart'): Promise<void> {
    if (!this.current) return
    const stopping = this.current
    this.current = null
    this.last = null
    this.currentOpts = null
    this.wedged = false
    this.emitChange()
    // #600: end the in-flight work first — after `current` is cleared, before the kill, no wait.
    if (kind !== 'restart') {
      try {
        this.modelStopHook?.(kind)
      } catch {
        /* ending the answers is a courtesy to them; it must never block the stop itself */
      }
    }
    await stopping.stop()

    // The runtime is gone — no stream of its epoch can legitimately still count.
    this.resetGenerationGate()
  }

  activeModelId(): string | null {
    return this.current?.modelId ?? null
  }

  /** The active runtime instance (used by the chat service). */
  active(): ModelRuntime | null {
    return this.current
  }

  status(): RuntimeStatus {
    const startingModelId = this.startingModelId
    // #107: elapsed time + byte total of the in-flight "Starting…" window (both resolved
    // here, once per window — never per poll tick). The IPC layer adds only `expectedMs`
    // (from the honest effective-read sample) so the renderer can show determinate load
    // progress instead of an indeterminate spinner.
    const starting =
      startingModelId && this.startingSince != null
        ? {
            elapsedMs: Math.max(0, Date.now() - this.startingSince),
            bytesTotal: this.startingBytesTotal
          }
        : undefined
    // #599: a start requested but still checking the weights (`startingModelId` not set yet).
    const startRequested = this.startRequests > 0 ? { startRequested: true } : {}
    if (!this.current) {
      return {
        running: false,
        modelId: null,
        port: null,
        healthy: false,
        message: startingModelId ? 'Starting' : 'Stopped',
        startingModelId,
        starting,
        ...startRequested
      }
    }
    // #599: a failed `/health` re-probe, or an answer the CB-5 watchdog ended.
    const unresponsive = this.wedged || this.last?.healthy === false
    // A start in flight for a DIFFERENT model than the running one = a switch underway.
    const switchingId = startingModelId !== this.current.modelId ? startingModelId : null
    return {
      running: true,
      modelId: this.current.modelId,
      port: this.last?.port ?? null,
      healthy: (this.last?.healthy ?? false) && !this.wedged,
      message: this.wedged ? 'Not responding: an answer timed out' : (this.last?.message ?? 'Running'),
      ...(unresponsive ? { unresponsive: true } : {}),
      ...startRequested,
      backend: this.current.backend ?? UNLABELLED_BACKEND,
      gpuName: this.current.gpuName ?? null,
      // The real launched context window (§L0) — the budget chat/RAG assembly trims
      // against. Absent for a runtime that can't report one.
      contextWindow: this.current.contextWindow?.(),
      // #39: false until the FIRST real generation streams after this start (a model
      // switch/restart builds a fresh runtime instance, so it resets naturally). Absent
      // for a runtime that can't report one — the Chat warm-up hint then never shows.
      warmedUp: this.current.warmedUp?.(),
      startingModelId: switchingId,
      starting: switchingId ? starting : undefined
    }
  }
}

/** File size for the #107 progress denominator, or null — a stat failure (mock rung
 *  paths, vanished weight) must never break a start. */
function statSizeOrNull(path: string): number | null {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}
