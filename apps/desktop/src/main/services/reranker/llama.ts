import type { Reranker, RerankedHit, RerankOptions } from './index'
import {
  LlamaServer,
  combineSignals,
  isBindRaceError,
  isStartAbortError,
  type LlamaServerOptions,
  type UnexpectedExitInfo
} from '../runtime/sidecar'
import { maxInputApproxTokens } from '../runtime/context-budget'
import { truncateToApproxTokens, CHUNK_DEFAULTS } from '../ingestion/chunker'
import { GPU_RERANK_SCOPE, type RerankerDevice } from '../rag/rerank-profile'
import { log } from '../logging'

// Real on-device reranker (rag-design §11). The THIRD `LlamaServer`
// composition (after the chat runtime and the E5 embedder): the SAME shipped b9585
// `llama-server` binary, spawned with `--rerank`, serving `/v1/rerank` over loopback.
// Verified against the pinned b9585 SOURCE: `--rerank` sets
// embedding mode + RANK pooling (common/arg.cpp L2964–2971); the endpoint takes
// `{ query, documents }` and returns `results: [{ index, relevance_score }]` sorted by
// score DESC — results map back to inputs by `index`, never by order
// (tools/server/server-context.cpp L4592–4671, server-common.cpp L1213–1258).
//
// Composing `LlamaServer` directly (not `LlamaRuntime`) keeps `CHAT_SERVER_ARGS`
// (--jinja / --reasoning-format) off this sidecar — those are chat-only. Zero new npm
// deps, loopback only, lazy-started on first rerank() and reused; stop() kills it
// (wired into will-quit AND workspace lock — the sidecar's memory holds recent queries
// and chunk text).
//
// Step 4-4 (Wave 4 ruling (a)): device posture — CPU-pinned on the `cpu-hi` and `default`
// rerank profiles (byte-identical to before this step: `--device none`), on the GPU on the
// `gpu` profile (`llama-server`'s default `ngl`-auto + `--fit`, the SAME rung-1 semantics the
// chat runtime uses — NEVER `-ngl`; `--device none` stays the only device argument the app
// ever passes). Wave 8 ruling (b)(Q) (step 4-8): the posture is no longer read once per cold
// start — `rerank()` resolves it fresh before starting/joining/reusing the sidecar, and again
// after every await inside `rerank()`, in the same synchronous section that acts on it, so a
// cold start always launches with exactly the value just resolved. A resident or starting
// sidecar recorded under a different posture is restarted (four race rules — see `resolveServer`
// below); the LAUNCH posture stays fixed for the life of each sidecar process, which is the
// part of the old "once per cold start" contract that is still true. This supersedes Wave 7
// ruling (a)'s premise that `settings.activeModelId` is a posture input at all: the chat-model
// input is now the RUNTIME's committed model (`RuntimeManager.activeModelId()`,
// `rag/device-posture.ts`, Wave 8 ruling (a)), never the setting. Wave 7's three event-time
// suspends (`gpuMode`/`gpuAutoDisabled` via `settings:update`; `activeModelId` via
// `settings:update`/`models:select`/`models:use`) stay as EARLY release — a head start before
// the next `rerank()` would have noticed on its own — not what makes the posture correct.
// `gpuAutoDisabled` also moves through two further seams no suspend covers (`tryGpuAgain`,
// `persistGpuFailure`) — reported, not fixed, for a separate owner ruling; see `channels.json`.

const DEFAULT_CONTEXT_TOKENS = 2048
/**
 * Approx-token caps per rerank FIELD (rag-design §11 / §12.3). A rerank task is ONE query+document
 * pair the server combines into a SINGLE sequence, so the combined cost must fit the context:
 * (160 + 500) approx tokens × REAL_TOKENS_PER_APPROX_TOKEN ≈ 1452 real tokens — under the 2048
 * context AND the 2048 physical batch. The constructor additionally CLAMPS both caps to the context
 * budget (usable − queryCap ≈ 754 at the default ctx, ≥ 500), so they can never exceed `n_ctx` even
 * at a smaller configured context.
 *
 * RAG-N3 (full audit 2026-06-28): the doc cap is the WHOLE chunk window
 * (`CHUNK_DEFAULTS.chunkSizeTokens`), not the former 320, so the reranker scores every chunk in
 * full. At 320 the last ~36 % of a 500-token chunk was invisible to the load-bearing relevance
 * separator (§12.3), and that truncated score drove BOTH the final order AND the dedup-by-page
 * winner (`rag/index.ts`). Cost: the worst-case CPU latency per candidate rises with the larger doc
 * budget (reasoned ~+38 %; §12.3) — bounded by the small candidate cap, CPU-pinned, and opt-in by
 * provisioning. Tightening this cap (or the candidate cap) stays the lever if latency proves high.
 *
 * EMB-1 (backend audit 2026-06-27): inputs are truncated by the CJK/Thai-aware
 * `truncateToApproxTokens` (shared with the E5 embedder), NOT a whitespace word split. The old
 * split treated a space-less passage (CJK/Thai) as ONE "word" and never truncated it, so it
 * overflowed `n_ctx`, the sidecar 500'd, and the rerank silently fell back to the fused order.
 */
const MAX_QUERY_APPROX_TOKENS = 160
/** The reranker scores the WHOLE chunk: the doc cap equals the chunk window so a chunk's tail is
 *  never dropped before scoring (RAG-N3). Keyed off the chunker's source of truth, so a future
 *  chunk-size change carries the rerank budget with it. */
const MAX_DOC_APPROX_TOKENS = CHUNK_DEFAULTS.chunkSizeTokens
/** Approx-token headroom reserved for BOS/EOS + the query↔document separator the server inserts. */
const RERANK_SPECIALS_APPROX_TOKENS = 16
/** Per-request bound so a wedged sidecar fails the question's rerank pass, not the app. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

export type LlamaRerankerDeps = Pick<
  LlamaServerOptions,
  'spawn' | 'fetchImpl' | 'findPort' | 'threads' | 'healthTimeoutMs' | 'healthIntervalMs' | 'host'
>

export interface LlamaRerankerOptions extends LlamaRerankerDeps {
  /** Reranker model id (the manifest id). */
  id: string
  binPath: string
  /** Absolute path to the reranker GGUF weight file. */
  modelPath: string
  contextTokens?: number
  requestTimeoutMs?: number
  /**
   * Wave 8 ruling (b)(Q): which device the sidecar should use — resolved by `rerank()` before
   * starting, joining or reusing the sidecar, and again after every await inside `rerank()` (see
   * `resolveServer`). A cold start launches with exactly the value resolved at that moment; the
   * LAUNCH posture then stays fixed for the life of the sidecar PROCESS (never re-read mid-load).
   * Absent ⇒ `'cpu'` (today's behaviour, byte-identical). Tests fake it; production's default
   * (wired through `compose-services.ts` → `main/index.ts`'s exported posture-callback factory,
   * `rag/device-posture.ts`) resolves it from the committed chat model, the pending/in-flight
   * chat-start state and the translator's occupancy — never `settings.activeModelId`.
   */
  devicePosture?: () => RerankerDevice
  /**
   * Wave 8 ruling (b)(G): on the `cpu` posture, `rerank()` refuses a request with more documents
   * than this ceiling — computed by the caller from settings with the existing pure functions
   * (`2 × ragTopKInitial + totalCandidateCapFor(rerankScopeFor(profile, input, 'cpu'))`), never a
   * literal 48/72 here. Consulted fresh on every call, in the same synchronous section as the
   * posture (so re-applied after any await), and thrown BEFORE any start — it never arms
   * `startFailed`. Absent ⇒ every request is admitted (what keeps the acceptance harness, which
   * injects no callback, inert by default — ruling (f)).
   */
  cpuRequestCeiling?: () => number
}

interface RerankResponse {
  results?: Array<{ index?: number; relevance_score?: number }>
}

/** Wave 8 ruling (c)(i): the M5 single-flight teardown pass (`translation/runtime.ts:341-349`,
 *  `:701-722`, ported). `requesterCount` lives on THIS per-pass object, not on a field the
 *  shared promise's `finally` clears — a field cleared together with the promise reads 0 by the
 *  time an awaiting requester resumes, silently disabling Q's race rule (ii) (NF-5, the Wave 8
 *  analysis's re-check). The requester that started the pass reads it after `promise` settles. */
interface TeardownPass {
  promise: Promise<void>
  requesterCount: number
}

export class LlamaReranker implements Reranker {
  readonly id: string
  /** Per-field approx-token truncation caps, clamped to the context so query+doc can't exceed
   *  n_ctx (EMB-1). Computed once from `contextTokens` in the constructor. */
  private readonly queryApproxTokens: number
  private readonly docApproxTokens: number
  private server: LlamaServer | null = null

  /** Resident right now? (Lazy-started, then held for the session.) */
  isLoaded(): boolean {
    return this.server !== null
  }

  /**
   * Wave 8 ruling (d): the resident sidecar's ACTUAL device posture, or — when nothing is
   * resident — the posture a cold start would take right now (the same value `rerank()` would
   * resolve on its next call). The Performance screen's reranker row reads this instead of a
   * hard-coded `'cpu'`; a `Reranker` without this optional member reports `'cpu'` at the call
   * site (the `isLoaded?`-pattern default).
   */
  devicePosture(): RerankerDevice {
    if (this.server) return this.recordedPosture ?? 'cpu'
    return this.opts.devicePosture?.() ?? 'cpu'
  }

  /** The sidecar's captured stderr tail (diagnostics; '' before any start or once stopped) — a
   *  passthrough to `LlamaServer.redactedTail()`, so a caller can confirm what a `gpu`-posture
   *  start actually logged (device offload, a fit spill) without this class growing a bespoke
   *  event for every such question. Diagnostics-only; no in-repo caller today. */
  stderrTail(): string {
    return this.server?.redactedTail() ?? ''
  }
  private starting: Promise<void> | null = null
  /** Set by `stop()`; a racing lazy start must not resurrect the sidecar after quit. */
  private stopped = false
  /**
   * Set WHILE a teardown pass is in flight (the lock/quit/Q-restart kill path) and cleared
   * together with `teardownPass` when the shared pass settles — the `suspend()` analogue of
   * `stopped` (F19, full-audit-2026-06-29-postmerge). `stop()` arms the permanent `stopped`
   * latch before tearing down so a racing `ensureStarted` can't spawn an orphan; `suspend()`
   * (workspace lock, and Wave 8's Q restart) does NOT, so without this flag a `suspend()` that
   * interleaves with a concurrent `rerank()` could stop the OLD sidecar while a fresh
   * `ensureStarted` spawns and RETAINS a new one — surviving the lock with query/chunk-text-derived
   * state in process memory. `ensureStarted` refuses while it is set (Q's race rule (i): never
   * join a teardown this call did not start); cleared when the pass settles so a post-suspend
   * `rerank()` still lazily restarts.
   */
  private tearingDown = false
  /**
   * The in-flight single-flight teardown pass (Wave 8 ruling (c)(i), the M5 pattern). Every
   * overlapping `suspend()`/`stop()`/Q-restart call SHARES this one promise; a counter in its
   * place is not acceptable — a second caller would resolve at once, so a caller awaiting the
   * suspend before a chat-model load could return while the GPU process is still exiting (a
   * quit could exit with the kill pending). Null when no teardown is in flight.
   */
  private teardownPass: TeardownPass | null = null
  /**
   * Failed-start latch: a sidecar that could not start for a PERMANENT fault (e.g. an
   * incompatible GGUF quantization) must not be re-spawned and re-awaited for
   * the full health timeout on EVERY question. First failure disables this instance
   * for the session; rerank() then fails fast and retrieval keeps the fused order. A
   * TRANSIENT port-bind race does NOT arm it (F7 — see `ensureStarted`'s `.catch`): the latch
   * SURVIVES `suspend()` (unlike the embedder's), so latching a race would silently disable
   * reranking for the whole session — leaving it null lets the next rerank() retry on a fresh port.
   * Wave 8 ruling (c)(ii): a SECOND unexpected mid-session exit also arms this latch (see
   * `onUnexpectedExit` below) — a deterministic fault must not cost a fresh cold start on every
   * ask forever, but a single crash must not disable reranking either.
   */
  private startFailed: Error | null = null
  /**
   * Aborts the IN-FLIGHT lazy start on lock/quit/Q-restart (#244 — the translation
   * runtime's #159 / BE-1 pattern, ported): the child is killed inside the health wait and the
   * start rejects with an AbortError, instead of the teardown awaiting the full health window
   * (180 s by default) of a wedged cold start it is about to kill anyway. Matters doubly here:
   * the latch SURVIVES `suspend()`, so a timed-out start that latched would refuse every rerank
   * for the rest of the session. One per start.
   */
  private startAbort: AbortController | null = null
  /**
   * Wave 8 ruling (b)(Q): the posture recorded when the CURRENT resident/starting sidecar's
   * cold start began — never re-read after that point. `rerank()` compares its freshly resolved
   * posture against this value to decide whether a restart is due; null when nothing is
   * resident or starting (an unexpected exit or a settled teardown leaves it stale but harmless,
   * since the mismatch check also requires a resident/starting sidecar to fire on).
   */
  private recordedPosture: RerankerDevice | null = null
  /**
   * Wave 8 ruling (c)(ii): count of unexpected exits (a healthy child dying on its own — driver
   * reset, VRAM/RAM exhaustion) this instance has observed. A teardown NEVER counts as one
   * (`LlamaServer.stop()` arms `stopping` before the kill, gating the hook — `sidecar.ts:675`,
   * `:692`). The first exit just drops the dead handle so the next `rerank()` cold-starts fresh;
   * a second one in the same session latches `startFailed` like a permanent load fault.
   */
  private unexpectedExitCount = 0
  /** Residency listeners (`onResidencyChange`): fired after `isLoaded()` flips. */
  private readonly residencyListeners = new Set<() => void>()

  /**
   * Subscribe to residency transitions (PR #303 P3): the lazy start landing and the
   * suspend/stop teardown — everything that flips `isLoaded()`. Fired synchronously after
   * the flip, before the kill is awaited. Observability only; a throwing listener never
   * breaks the sidecar's lifecycle. Returns the unsubscribe.
   */
  onResidencyChange(cb: () => void): () => void {
    this.residencyListeners.add(cb)
    return () => {
      this.residencyListeners.delete(cb)
    }
  }

  private emitResidencyChange(): void {
    for (const cb of this.residencyListeners) {
      try {
        cb()
      } catch {
        /* observability only */
      }
    }
  }

  constructor(private readonly opts: LlamaRerankerOptions) {
    this.id = opts.id
    // Query+document ride ONE sequence server-side, so derive the per-field caps from the SHARED
    // context budget (so they can never exceed n_ctx), then clamp to the latency-oriented
    // defaults. At the default 2048 context this yields 160/500 (query cap / whole-chunk doc cap,
    // RAG-N3); a smaller configured context shrinks the caps so a rerank can't 500.
    const contextTokens = opts.contextTokens ?? DEFAULT_CONTEXT_TOKENS
    const usable = Math.max(2, maxInputApproxTokens(contextTokens) - RERANK_SPECIALS_APPROX_TOKENS)
    this.queryApproxTokens = Math.min(MAX_QUERY_APPROX_TOKENS, Math.max(1, Math.floor(usable / 3)))
    this.docApproxTokens = Math.min(MAX_DOC_APPROX_TOKENS, Math.max(1, usable - this.queryApproxTokens))
  }

  /**
   * Start or join the single-flight teardown pass (Wave 8 ruling (c)(i)) and return the PASS
   * object, not just its promise: `resolveServer`'s Q restart needs `requesterCount` once the
   * pass settles (race rule (ii)), which must live on this per-pass object rather than a field
   * `doTeardown`'s `finally` clears together with `tearingDown` (that field would already read 0
   * by the time an awaiting requester resumes — NF-5).
   */
  private beginOrJoinTeardown(): TeardownPass {
    if (this.teardownPass) {
      this.teardownPass.requesterCount++
      return this.teardownPass
    }
    this.tearingDown = true
    const pass: TeardownPass = { promise: Promise.resolve(), requesterCount: 1 }
    pass.promise = this.doTeardown().finally(() => {
      // Cleared together, only when THIS shared pass has fully settled — never by an earlier
      // caller's `finally` while a later joiner is still inside it (single-flight, M5).
      this.tearingDown = false
      this.teardownPass = null
    })
    this.teardownPass = pass
    return pass
  }

  private async teardown(): Promise<void> {
    await this.beginOrJoinTeardown().promise
  }

  /**
   * The actual kill, run exactly once per pass regardless of how many callers joined it
   * (Wave 8 ruling (c)(i), the M5 pattern ported from `translation/runtime.ts:701-722`).
   */
  private async doTeardown(): Promise<void> {
    // A lazy start may be in flight (first rerank() racing app quit, a lock, or a Q restart).
    // #244: abort it rather than wait it out — the abort kills the child inside the health wait
    // (the normal stop path, no orphan), the start rejects AbortError (never latches
    // `startFailed`), and the await below settles in about one health-poll interval instead of
    // the 180 s window.
    this.startAbort?.abort()
    if (this.starting) {
      await this.starting.catch(() => undefined)
    }
    const server = this.server
    this.server = null
    this.recordedPosture = null
    if (server) {
      this.emitResidencyChange()
      await server.stop()
    }
  }

  /**
   * Wave 8 ruling (b)(Q): resolve this call's posture, apply G's CPU ceiling, and start, join or
   * reuse the sidecar — all in the ONE synchronous section that begins here, re-run after every
   * `await` below, so a cold start always launches with the value JUST resolved (never a second,
   * later `devicePosture()` read). The posture is recorded when a cold start BEGINS; a resident
   * or starting sidecar recorded under a DIFFERENT posture is restarted, under four race rules:
   *
   *  (i)   never join a teardown this call did not start (F19) — refuse instead;
   *  (ii)  after awaiting its OWN teardown, refuse if its own signal aborted or if any OTHER
   *        caller joined that same pass (so a lock that joins a Q-initiated teardown still
   *        leaves nothing resident — the pass's own `requesterCount`, not a re-derived guess);
   *  (iii) at most one restart per call — a second flip inside the same call refuses;
   *  (iv)  a start-abort NOT caused by this call's own signal is rethrown as a non-abort error
   *        (see `ensureStarted`), so the ask lands on the capped fallback instead of ending.
   *
   * Refusals under (i)–(iii) likewise throw non-abort errors. No flap: the comparison is on the
   * RESOLVED posture, so an input change that leaves it unchanged restarts nothing.
   */
  private async resolveServer(documentCount: number, callerSignal?: AbortSignal): Promise<LlamaServer> {
    let restarted = false
    for (;;) {
      const posture: RerankerDevice = this.opts.devicePosture?.() ?? 'cpu'
      // G (ruling (b)(G)): thrown before any start, in the same synchronous section as the
      // posture it tests — so it is re-applied after the await below too. Absent callback ⇒
      // admit everything (what keeps the acceptance harness inert, ruling (f)).
      if (posture === 'cpu') {
        const ceiling = this.opts.cpuRequestCeiling?.()
        if (ceiling != null && documentCount > ceiling) {
          throw new Error(
            `Rerank request refused: ${documentCount} documents exceeds the CPU posture's ceiling of ${ceiling}`
          )
        }
      }
      const somethingToReconcile = this.server !== null || this.starting !== null
      const mismatched = somethingToReconcile && this.recordedPosture !== null && this.recordedPosture !== posture
      if (mismatched) {
        if (restarted) {
          // Rule (iii): a second flip inside the same call refuses rather than looping.
          throw new Error('Rerank refused: the reranker device posture changed again during this call')
        }
        if (this.tearingDown) {
          // Rule (i): never join a teardown this call did not start — the existing F19 refusal.
          throw new Error('Reranker is suspending (workspace is locking, or a posture-affecting settings change)')
        }
        restarted = true
        const pass = this.beginOrJoinTeardown()
        await pass.promise
        // Rule (ii): refuse if OUR OWN signal aborted (the ask ends — correct, a lock/Stop
        // aborts the ask's own signal first) or if ANY OTHER caller joined this pass (so a lock
        // that joined a Q-initiated teardown leaves nothing resident afterwards).
        if (callerSignal?.aborted) {
          throw new DOMException('The operation was aborted', 'AbortError')
        }
        if (pass.requesterCount > 1) {
          throw new Error('Reranker is suspending (another caller requested a teardown during this pass)')
        }
        continue // Re-resolve from the top: fresh posture, fresh G check, fresh residency read.
      }
      return await this.ensureStarted(posture, callerSignal)
    }
  }

  /** Lazily spawn the rerank sidecar with EXACTLY `posture` (once). Concurrent callers share one
   *  start. `callerSignal` is this caller's own abort signal — used only to tell "my own Stop
   *  aborted this start" from "some other caller's teardown aborted it" (rule (iv) below). */
  private async ensureStarted(posture: RerankerDevice, callerSignal?: AbortSignal): Promise<LlamaServer> {
    if (this.stopped) throw new Error('Reranker is stopped (app is shutting down)')
    // F19 / rule (i): refuse to spawn while a teardown (lock/quit/Q-restart) is in progress — a
    // sidecar started here would survive it. The `suspend()` analogue of the `stopped` guard.
    if (this.tearingDown) throw new Error('Reranker is suspending (workspace is locking, or a posture-affecting settings change)')
    if (this.startFailed) throw this.startFailed
    if (this.server) return this.server
    if (!this.starting) {
      const abort = new AbortController()
      this.startAbort = abort
      const contextTokens = this.opts.contextTokens ?? DEFAULT_CONTEXT_TOKENS
      // Wave 8 ruling (b)(Q): recorded the instant a cold start BEGINS — the exact value this
      // launch uses, never re-read from `opts.devicePosture` a second time.
      this.recordedPosture = posture
      const server = new LlamaServer({
        binPath: this.opts.binPath,
        modelPath: this.opts.modelPath,
        contextTokens,
        // `--rerank` switches llama-server to embedding mode + RANK pooling and enables
        // /v1/rerank (b9585 common/arg.cpp L2964–2971 — the one flag is the whole
        // switch). On the `cpu`/`default` posture `--device none` PINS the reranker to CPU,
        // exactly like the E5 embedder (architecture.md GPU record §7): a sub-1B scorer gains
        // little from a GPU and must never contend for VRAM with the chat model. On the `gpu`
        // posture (step 4-4, a usable card and no reason not to use it) `--device` is OMITTED —
        // llama-server's own default (`ngl` auto + `--fit`), never `-ngl`: `--device none` stays
        // the only device argument this app ever passes anywhere.
        //
        // `--batch-size`/`--ubatch-size` = the context: in embedding/rerank mode
        // llama-server FORCES n_batch = n_ubatch and defaults them to 512 (b9585 logs
        // "embeddings enabled
        // with n_batch (2048) > n_ubatch (512) ... setting n_batch = n_ubatch = 512").
        // A rerank input is query+document in ONE sequence — up to
        // (MAX_QUERY_APPROX_TOKENS + MAX_DOC_APPROX_TOKENS) approx tokens ≈ 1452 real tokens — so
        // the 512 default makes the server 500 the WHOLE request ("input (… tokens) is too large to
        // process. increase the physical batch size"), which would silently drop every
        // rerank pass back to the fused order on real-length chunks. Sizing the physical
        // batch to the context guarantees any in-context input decodes in one ubatch (a
        // single rerank input cannot exceed n_ctx anyway). Unaffected by the posture.
        extraArgs: [
          '--rerank',
          ...(posture === 'cpu' ? ['--device', 'none'] : []),
          '--batch-size',
          String(contextTokens),
          '--ubatch-size',
          String(contextTokens)
        ],
        spawn: this.opts.spawn,
        fetchImpl: this.opts.fetchImpl,
        findPort: this.opts.findPort,
        threads: this.opts.threads,
        healthTimeoutMs: this.opts.healthTimeoutMs,
        healthIntervalMs: this.opts.healthIntervalMs,
        host: this.opts.host,
        // #244: let a lock/quit/Q-restart teardown abort this start mid-health-wait (the child is
        // killed via the normal stop path; start() rejects AbortError — reclassified below unless
        // it came from THIS call's own signal).
        startAbortSignal: abort.signal,
        // Wave 8 ruling (c)(ii), the translation runtime's M1 pattern (`translation/runtime.ts:527`):
        // an unexpected exit (a healthy child dying on its own — driver reset, VRAM/RAM
        // exhaustion) drops the dead handle so the NEXT rerank() cold-starts with a freshly
        // resolved posture, instead of failing against a dead port for the rest of the session.
        // Identity-compared so a late crash notification can never clobber a NEWER instance a
        // restart already installed. `LlamaServer` fires this only for a healthy child dying
        // outside `stop()` (`sidecar.ts:675`, `:692` — a teardown never counts as an unexpected
        // exit). A SECOND exit in the same session latches like a permanent load fault: a
        // deterministic fault must not cost a fresh cold start on every ask forever.
        onUnexpectedExit: (info: UnexpectedExitInfo) => {
          if (this.server !== server) return
          this.server = null
          this.emitResidencyChange()
          this.unexpectedExitCount++
          if (this.unexpectedExitCount >= 2) {
            this.startFailed = new Error(
              `Reranker sidecar exited unexpectedly twice this session (last exit code ${info.exitCode ?? 'unknown'})`
            )
          }
        }
      })
      this.starting = server
        .start()
        .then(() => {
          this.server = server
          this.emitResidencyChange()
          // Which posture (and, on `gpu`, the run-L-selected scope constant — the per-ask
          // scope itself depends on the opt-in setting too, which this module never reads)
          // this start actually took.
          log.info('Reranker sidecar started', {
            posture,
            scope: posture === 'gpu' ? GPU_RERANK_SCOPE : undefined
          })
        })
        .catch((err) => {
          const error = err instanceof Error ? err : new Error(String(err))
          // #244: a teardown-ABORTED start is not a load fault — never latch
          // `startFailed` (it survives suspend(), so it would disable reranking for the session).
          if (isStartAbortError(err) || abort.signal.aborted) throw error
          // F7 (post-merge audit): a TRANSIENT port-bind race must NOT arm the latch (same fix as
          // the embedder, F4). This latch is more persistent than the embedder's — `suspend()`
          // KEEPS it (a bad GGUF won't load after unlock either) — so arming it for a race killed
          // reranking for the whole session (a silent quality regression: retrieval falls back to
          // fused order, rag/index.ts). Forgiving the race makes the keep-on-suspend policy correct:
          // only a genuine load fault persists. Leave it null so the next rerank() re-attempts.
          if (!isBindRaceError(error.message)) this.startFailed = error
          throw error
        })
        .finally(() => {
          this.starting = null
          if (this.startAbort === abort) this.startAbort = null
        })
    }
    try {
      await this.starting
    } catch (err) {
      // Wave 8 ruling (b)(Q)(iv) / (c)(iii): a start-abort NOT caused by THIS call's own signal
      // came from another caller's teardown (Q from a concurrent ask, ruling (a)'s awaited
      // suspend, or a Wave 7 event-time hook) — reclassify as a non-abort error so the waiting
      // ask lands on the capped fallback (Wave 5 ruling (e)(i)) instead of ending as if the user
      // had pressed Stop (F12). When it WAS caused by this call's own signal (a lock aborts the
      // ask's own signal first; so does a user Stop), let it propagate as the abort it is — the
      // ask correctly ends either way, because `isAbortError` checks `signal.aborted` first.
      if (isStartAbortError(err) && callerSignal?.aborted !== true) {
        throw new Error('Reranker cold start was aborted by another operation')
      }
      throw err
    }
    // F19: a teardown (lock/quit/Q-restart) may have begun during the await above and already
    // nulled the server we'd return — re-check rather than hand back a sidecar that's being /
    // about to be stopped (mirrors the top-of-function guards).
    if (this.stopped) throw new Error('Reranker is stopped (app is shutting down)')
    if (this.tearingDown) throw new Error('Reranker is suspending (workspace is locking, or a posture-affecting settings change)')
    if (!this.server) throw new Error('Rerank server failed to start')
    return this.server
  }

  /**
   * Score every document against `query` via `/v1/rerank`. Inputs are truncated to the
   * context/latency budget by the CJK/Thai-aware `truncateToApproxTokens` (EMB-1 — a space-less
   * passage can't slip past and overflow n_ctx); the response's `results[].index` maps each score
   * back to its input (the server sorts by score desc — order is NOT input order).
   * Throws unless every input received exactly one score. `opts.signal` (a user "Stop")
   * is combined with the timeout so the CPU-slow rerank cancels promptly (M-C5).
   */
  async rerank(query: string, documents: string[], opts?: RerankOptions): Promise<RerankedHit[]> {
    if (documents.length === 0) return []
    const server = await this.resolveServer(documents.length, opts?.signal)
    // REL-4: own the timeout so it is cleared the instant the request settles (no lingering timer).
    const combined = combineSignals(opts?.signal, this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    let json!: RerankResponse
    try {
      const res = await server.fetch('/v1/rerank', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.id,
          query: truncateToApproxTokens(query, this.queryApproxTokens),
          documents: documents.map((d) => truncateToApproxTokens(d, this.docApproxTokens))
        }),
        signal: combined.signal
      })
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined) // release the connection
        throw new Error(`Rerank request failed: HTTP ${res.status}`)
      }
      json = (await res.json()) as RerankResponse
    } finally {
      combined.clear()
    }
    const results = json.results ?? []
    const hits: RerankedHit[] = []
    const seen = new Set<number>()
    for (const r of results) {
      const index = r.index
      const score = r.relevance_score
      if (typeof index !== 'number' || typeof score !== 'number') continue
      if (index < 0 || index >= documents.length || seen.has(index)) continue
      seen.add(index)
      hits.push({ index, score })
    }
    if (hits.length !== documents.length) {
      throw new Error(`Rerank result mismatch: expected ${documents.length} scores, got ${hits.length}`)
    }
    return hits
  }

  /**
   * Kill the rerank sidecar (no-op if it was never started). PERMANENT — used on
   * `will-quit`, where a racing lazy start must not resurrect the child as an orphan.
   */
  async stop(): Promise<void> {
    this.stopped = true
    await this.teardown()
  }

  /**
   * Kill the sidecar but allow a lazy restart on the next `rerank()` — used on workspace lock
   * and Wave 7/8's posture-affecting suspends. A PERMANENT failed-start latch survives
   * a suspend: a GGUF the server could not load will not load any better after unlock. A transient
   * bind race never armed the latch (F7), so a port race no longer wrongly disables reranking past
   * a lock/unlock — only a genuine load fault (or a second unexpected exit, ruling (c)(ii))
   * persists.
   */
  async suspend(): Promise<void> {
    await this.teardown()
  }
}

/** Factory mirroring `createE5Embedder`; selected when the binary + reranker weights exist. */
export function createLlamaReranker(opts: LlamaRerankerOptions): LlamaReranker {
  return new LlamaReranker(opts)
}
