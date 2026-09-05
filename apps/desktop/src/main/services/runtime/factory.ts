import { existsSync } from 'node:fs'
import { t } from '../../../shared/i18n'
import { tMain } from '../i18n'
import type { GpuDevice } from '../../../shared/types'
import type { SpeculativeDecoding } from '../../../shared/manifest'
import type {
  ChatMessage,
  HealthStatus,
  ModelRuntime,
  RuntimeBackend,
  RuntimeChatOptions,
  RuntimeFactory,
  RuntimeStartOptions
} from './index'
import { createMockRuntime } from './mock'
import { createLlamaRuntime } from './llama'
import { createPlacementParser, recordModelPlacement } from './placement'
import { probeGpuDevices } from './gpu'
import { startModelPrefetch, type ModelPrefetch } from './prefetch'
import { isNextModelLoadSuppressed, recordModelLoadRead } from '../read-speed'
import {
  isBindRaceError,
  resolveCpuFallbackServerPath,
  resolveLlamaServerPath,
  type UnexpectedExitInfo
} from './sidecar'

// Availability-aware runtime selector + the GPU start LADDER (architecture.md GPU
// record §5.2). The app MUST still launch —
// and the test suite MUST still pass — with zero model files, zero binaries, and zero
// GPUs, so the real `LlamaRuntime` is opt-in by availability (binary + weights present)
// and every GPU decision degrades automatically:
//
//   rung 1a default binary + the MTP speculative-decoding flags (#182) — ONLY for a
//           manifest that opts in AND a machine the probe proves can hold the model
//           plus the draft head in one device's VRAM. Skipped, never failed, otherwise.
//   rung 1  default binary, NO device args   (b9585: ngl=auto + fit=on → VRAM-aware
//           offload; on a GPU-less machine this IS CPU mode — the ladder ends here
//           for almost everyone)
//   rung 2  same binary, forced CPU          (`--device none` is the ONLY CPU-forcing
//           mechanism — NEVER pass `-ngl`)
//   rung 3  pure-CPU safety-net binary       (`runtime/llama.cpp/<os>/cpu/`, if present)
//   rung 4  MockRuntime                      (the existing graceful-fallback rule —
//           the app can never be *stuck*)
//
// `gpuMode: 'off'` (Settings) and `gpuAutoDisabled` (a previously detected problem)
// skip rung 1. A rung-1 failure reports through `onGpuFailure` so the caller persists
// `gpuAutoDisabled` + `gpuLastError` — no repeated GPU health timeouts on later starts.
// GPU state is INJECTED (read-callbacks), never read from the DB here — keeps the
// ladder pure and unit-testable with the existing fake seams.

/**
 * The #109 hidden warm-up generation. `waitForHealthy` resolves as soon as llama-server
 * answers `/health`, but the FIRST generation still pays a one-time prefill/graph warm-up
 * that measured 6–8× the settled TTFT (10–30 s on CPU-only machines) — so "ready" wasn't
 * ready. After a real rung comes up (and its backend label is set), the ladder runs one
 * tiny content-free generation against the inner runtime and discards the output, so the
 * user's real first prompt lands on a warmed path. The extra seconds live inside the
 * existing "Starting…" state, where the user already expects to wait.
 *
 * Deliberate decisions (design record: architecture.md "First-answer warm-up hint (#39)"):
 *  - `inner.chatStream` is called DIRECTLY, so the #39 `served` flag does NOT flip: the
 *    real first prompt still pays the full system-prompt prefill (the warm-up shares no
 *    `cache_prompt` prefix with it), so the #39 warm-up hint stays armed as a safety net.
 *  - Thinking off (omitted mode = 'balanced' → `enable_thinking: false`), tiny cap,
 *    loopback-only, output discarded — never persisted, never audited as a chat.
 *  - A warm-up failure that is NOT a cancel never fails the start: the server IS healthy.
 *    A mid-warm-up crash still reports via `onUnexpectedExit` (§5.3 GPU auto-fallback).
 */
export const WARMUP_PROMPT = 'Hi'
export const WARMUP_MAX_TOKENS = 8
/**
 * Overall cap on the warm-up window. The worst #109 measurement was ~28 s (9B, 16 GB
 * CPU-only laptop), so 90 s is ~3× headroom for bigger models/slower machines while
 * guaranteeing a pathological warm-up cannot dominate the start (the health wait itself
 * budgets 180 s). On expiry the request is aborted, a warning is logged, and the start
 * proceeds to ready — the cap trades a possibly-cold first prompt for a bounded start.
 */
export const WARMUP_TIMEOUT_MS = 90_000

/**
 * Server flags that switch ON the trained-in MTP draft head some GGUFs already carry
 * (issue #182; measured evidence in model-benchmarks.md §9.4 "MTP speculative decoding",
 * design record: architecture.md "MTP speculative decoding"). CODE-OWNED and constant —
 * the manifest names a scheme, it never supplies arguments (see `SpeculativeDecoding`).
 *
 * `--spec-draft-n-max 2` is the measured pick: n=2 gave 77–91 % draft acceptance and
 * +38–45 % decode; n=3/4 neither broke nor helped (acceptance falls to 64 % at n=4).
 * Deliberately NOT included: the `--spec-draft-type-k/v q8_0` + `--cache-type-k/v q8_0`
 * quartet — it recovers ~1.6 GiB of VRAM but quantizes the MAIN KV cache, whose long-context
 * quality is unvalidated on our harness, and it still does not make Q6_K fit 24 GB.
 */
export const MTP_SERVER_ARGS: readonly string[] = ['--spec-type', 'draft-mtp', '--spec-draft-n-max', '2']

/**
 * Free VRAM (MiB) an MTP start needs ON TOP of the weight file's own bytes, before the
 * ladder will try rung 1a. Two measured components (§9.4, i9-9900X + RTX 3090, ctx 8192):
 * a full-offload llama-server peaks ~1.3–1.4 GiB above the GGUF's size (KV + compute
 * buffers), and the draft head plus its own KV costs ~2 GiB more. 3.5 GiB is that sum with
 * no padding, so the guard reproduces the measured verdicts exactly: Q4 (15.9 GiB) and Q5
 * (18.5 GiB) clear a 24 GB card, Q6_K (21.3 GiB) does NOT — which is precisely why the q6
 * manifest does not opt in.
 *
 * The guard exists because llama.cpp's `--fit` does not FAIL when VRAM is short: it silently
 * offloads fewer layers, so an unaffordable MTP start would look healthy while decoding at
 * partial-offload speed (the issue-#42 class). A skipped rung 1a costs nothing; a silent
 * partial offload costs everything the flag was added to buy.
 */
export const MTP_VRAM_HEADROOM_MB = 3584

/**
 * Model ids whose speculative rung has been proven unviable ON THIS MACHINE, for the rest
 * of the app session. Module-level and session-scoped on purpose (the `read-speed.ts`
 * suppression idiom), never persisted: the reasons are hardware/driver state, and a wrong
 * latch must not outlive the process.
 *
 * Without it, a machine where the flag fails would pay a doomed multi-GB model load on
 * EVERY start before falling through to rung 1. Cleared by "Try GPU again" (the user
 * explicitly asking for the accelerated path back) — see `tryGpuAgain`.
 */
const speculativeSuppressed = new Set<string>()

/** Latch this model's speculative rung off for the rest of the session. */
export function suppressSpeculative(modelId: string): void {
  speculativeSuppressed.add(modelId)
}

/** True once {@link suppressSpeculative} has latched this model off this session. */
export function isSpeculativeSuppressed(modelId: string): boolean {
  return speculativeSuppressed.has(modelId)
}

/** Re-arm every latched model (wired to "Try GPU again"; also the test reset). */
export function clearSpeculativeSuppression(): void {
  speculativeSuppressed.clear()
}

/** GPU-ladder hooks; all optional — omitting them yields plain rung-1-only behavior. */
export interface GpuLadderDeps {
  /** User intent from Settings ('auto' default). */
  getGpuMode?: () => 'auto' | 'off'
  /** The persisted auto-disable flag (a previously detected GPU problem). */
  getGpuAutoDisabled?: () => boolean
  /** Persist a rung-1 (GPU attempt) failure; must never throw. */
  onGpuFailure?: (reason: string) => void
  /** Probe used to label a rung-1 start 'gpu' vs 'cpu' (inject the session cache). */
  probeDevices?: (binPath: string) => Promise<GpuDevice[]>
  /** Resolve the rung-3 safety-net binary (default: `<os>/cpu/llama-server[.exe]`). */
  resolveCpuBin?: (rootPath: string) => string | null
  /**
   * Fired when a runtime whose backend label is 'gpu' dies mid-session (§5.3). The
   * caller persists the flags, restarts the model ONCE (the ladder then starts at
   * rung 2), and surfaces the friendly compatibility-mode notice.
   */
  onGpuCrash?: (opts: RuntimeStartOptions, info: UnexpectedExitInfo) => void
  /**
   * #182: fired INSTEAD of {@link onGpuCrash} when the runtime that died mid-session was
   * the speculative rung. The GPU itself is not the suspect — the extra flags are — so the
   * caller must NOT persist `gpuAutoDisabled` (that would exile the machine to CPU over an
   * optional speed-up). The ladder has already latched the model off speculative for the
   * session, so the caller's restart comes back on the plain GPU rung.
   */
  onSpeculativeCrash?: (opts: RuntimeStartOptions, info: UnexpectedExitInfo) => void
}

/** Extra knobs `makeLlama` receives per rung. */
export interface LlamaRungOptions {
  extraArgs: string[]
  onUnexpectedExit: (info: UnexpectedExitInfo) => void
  /** The placement parser's stderr feed for this attempt (benchmark.md "Your model"). */
  onStderrData?: (text: string) => void
}

export interface RuntimeSelectionDeps {
  /** Drive root used to resolve `runtime/llama.cpp/<os>/llama-server`. */
  rootPath: string
  /** The current machine's fingerprint, stamped on every placement record (optional). */
  machineKey?: () => string | null
  /** Dev build — gates the dev-only `HILBERTRAUM_LLAMA_BIN` override (M-5). Default false. */
  isDev?: boolean
  /** Resolve the sidecar binary (defaults to `resolveLlamaServerPath`). */
  resolveBin?: (rootPath: string) => string | null
  /** Check whether the model weight file exists (defaults to `existsSync`). */
  modelExists?: (modelPath: string) => boolean
  /** Build the real runtime (defaults to `createLlamaRuntime`). */
  makeLlama?: (opts: RuntimeStartOptions, binPath: string, rung?: LlamaRungOptions) => ModelRuntime
  /** Build the mock runtime (defaults to `createMockRuntime`). */
  makeMock?: (opts: RuntimeStartOptions) => ModelRuntime
  /** Hook fired with the chosen backend (used for logging). */
  onSelect?: (kind: 'llama' | 'mock', opts: RuntimeStartOptions, reason: string) => void
  /**
   * Observability for the #109 warm-up generation; never affects control flow.
   * 'done' = the warm-up completed, 'timeout' = the {@link WARMUP_TIMEOUT_MS} cap
   * aborted it, 'failed' = it errored for a non-cancel reason — in every case the
   * start proceeds to ready.
   */
  onWarmup?: (opts: RuntimeStartOptions, event: 'done' | 'timeout' | 'failed', detail?: string) => void
  /** Test seam: override the {@link WARMUP_TIMEOUT_MS} cap. */
  warmupTimeoutMs?: number
  /**
   * Observability for the #114 concurrent prefetch; never affects control flow.
   * 'started' = the reader began alongside the first rung's load, 'skipped' = the
   * weights were just hashed (page-cache-warm — reading them again buys nothing),
   * 'done' = the reader reached EOF before the load finished, 'aborted' = the load
   * (or a stop) ended the window first — the normal outcome, 'failed' = a read
   * error; the load proceeds unassisted.
   */
  onPrefetch?: (
    opts: RuntimeStartOptions,
    event: 'started' | 'skipped' | 'done' | 'aborted' | 'failed',
    detail?: string
  ) => void
  /**
   * #182 observability for the speculative rung; never affects control flow.
   * 'enabled' = rung 1a was SPAWNED with the MTP flags (a 'failed' follows if it would not
   * come up), 'skipped' = the precondition said no — reason in `detail`, nothing spawned,
   * 'failed' = rung 1a would not start and the walk continues on the plain GPU rung,
   * 'crashed' = a running MTP rung died mid-session. The last two latch the model off for
   * the rest of the session.
   */
  onSpeculative?: (
    opts: RuntimeStartOptions,
    event: 'enabled' | 'skipped' | 'failed' | 'crashed',
    detail?: string
  ) => void
  /** Test seam: override the prefetch reader (default {@link startModelPrefetch}). */
  makePrefetch?: (paths: string[]) => ModelPrefetch
  /** GPU ladder hooks. Omitted → defaults (gpuMode 'auto', no persistence). */
  gpu?: GpuLadderDeps
}

interface Rung {
  /** Reason fragment for onSelect/logging. */
  label: string
  binPath: string
  extraArgs: string[]
  /** True for the GPU attempts — the rung whose failure auto-disables GPU (rung 1). */
  gpuAttempt: boolean
  /**
   * #182: rung 1a — the same binary and the same auto-offload as rung 1, plus
   * {@link MTP_SERVER_ARGS}. Its failure is NEVER a GPU fault (rung 1 follows immediately
   * and is the real GPU verdict), so it never persists `gpuAutoDisabled`.
   */
  speculative?: boolean
}

/**
 * The CODE-2 cancellation outcome (full-audit 2026-07-11): thrown out of a ladder
 * `start()` that was cancelled by `stop()` (quit / "Lock now" / a manual model stop).
 * Content-free; the auto-start path logs it, users never see it.
 */
function cancelledStartError(): Error {
  return new Error('Model start was cancelled (stopped while loading)')
}

/**
 * The ladder runtime: presents one `ModelRuntime` to the `RuntimeManager`, walking the
 * rungs inside `start()`. `backend`/`gpuName` expose where it landed (→ RuntimeStatus).
 */
class LadderRuntime implements ModelRuntime {
  readonly modelId: string
  backend: RuntimeBackend = 'cpu'
  gpuName: string | null = null
  private inner: ModelRuntime | null = null
  /** #39: flips on the first streamed chunk of the first real generation since start(). */
  private served = false
  /**
   * Set by `stop()` (full-audit 2026-07-11 CODE-2): a quit / "Lock now" / model stop must
   * not wait out the remaining rungs' health timeouts (up to ~9 min serial on a failing
   * ladder). The flag aborts the walk at the next rung boundary; the in-flight rung's
   * runtime is stopped directly (`startingInner`), which unblocks its `waitForHealthy`
   * via the existing exit-check throw — never a bare timeout race, which would orphan the
   * loading child (report §2.3). Permanent for this instance: the manager builds a fresh
   * `LadderRuntime` per start, so a cancelled ladder is never restarted.
   */
  private cancelled = false
  /** The rung runtime whose `start()` is currently in flight (CODE-2), if any. */
  private startingInner: ModelRuntime | null = null
  /** The #114 concurrent prefetch riding the first rung's load window, if any. */
  private prefetch: ModelPrefetch | null = null

  constructor(
    private readonly opts: RuntimeStartOptions,
    private readonly rungs: Rung[],
    private readonly deps: {
      makeLlama: NonNullable<RuntimeSelectionDeps['makeLlama']>
      /** The current machine's fingerprint for the placement record (services/performance.ts). */
      machineKey?: () => string | null
      makeMock: NonNullable<RuntimeSelectionDeps['makeMock']>
      onSelect?: RuntimeSelectionDeps['onSelect']
      onWarmup?: RuntimeSelectionDeps['onWarmup']
      onSpeculative?: RuntimeSelectionDeps['onSpeculative']
      warmupTimeoutMs: number
      onPrefetch?: RuntimeSelectionDeps['onPrefetch']
      makePrefetch: NonNullable<RuntimeSelectionDeps['makePrefetch']>
      gpu: GpuLadderDeps
    }
  ) {
    this.modelId = opts.modelId
  }

  async start(): Promise<void> {
    let lastError: unknown = null
    // #182: the #108 read sample and the #114 prefetch belong to the first rung we actually
    // SPAWN, which is no longer the same thing as `rungs[0]`: a skipped speculative rung
    // consumes index 0 without opening a load window, and gating on the index would have
    // silently switched both off on every machine that skips it.
    let attempted = 0
    for (const rung of this.rungs) {
      // CODE-2: cancelled between rungs — abort the walk instead of paying the next
      // rung's health timeout.
      if (this.cancelled) throw cancelledStartError()
      // Kick the (cached) probe off BEFORE the server start so the two run
      // concurrently — the model load dominates, so by the time the server is healthy
      // the backend label is normally already known. Probing only after health would
      // stall the first start by up to the probe's 10 s bound and mislabel a crash
      // inside that window as 'cpu'.
      const probe = this.deps.gpu.probeDevices ?? ((bin: string) => probeGpuDevices(bin))
      // #182: the speculative rung is the ONE rung that must know the device BEFORE it
      // spawns — its whole justification is measured on a fully offloaded GPU start, and
      // llama.cpp answers a VRAM shortfall by silently offloading fewer layers rather than
      // failing. So this await is deliberate, and deliberately narrow: it happens only for
      // a manifest that opted in, the probe is the session-cached one (sub-second after the
      // first call, hard-capped at 10 s, never rejects), and the very next rung reuses the
      // same cached answer. Every other model keeps the concurrent probe below untouched.
      if (rung.speculative) {
        const verdict = await this.speculativeVerdict(probe, rung.binPath)
        // CODE-2: an await inside the walk is a cancellation point like any other.
        if (this.cancelled) throw cancelledStartError()
        if (!verdict.ok) {
          this.deps.onSpeculative?.(this.opts, 'skipped', verdict.reason)
          continue
        }
      }
      const probePromise = rung.gpuAttempt
        ? probe(rung.binPath).catch(() => [] as GpuDevice[])
        : null
      if (rung.speculative) this.deps.onSpeculative?.(this.opts, 'enabled')
      // One placement reading per attempt (a retried rung must not sum two loads).
      const placement = createPlacementParser()
      const runtime = this.deps.makeLlama(this.opts, rung.binPath, {
        extraArgs: rung.extraArgs,
        onStderrData: placement.onStderrData,
        // Only a crash of a runtime that actually landed on the GPU triggers the
        // auto-fallback; CPU-mode crashes keep today's behavior (error + manual restart).
        onUnexpectedExit: (info) => {
          if (this.backend !== 'gpu') return
          // #182: on the speculative rung the extra flags are the prime suspect, not the
          // device — latch MTP off for the session and route to the speculative handler,
          // which restarts on the plain GPU rung instead of exiling the machine to CPU.
          if (rung.speculative) {
            suppressSpeculative(this.opts.modelId)
            this.deps.onSpeculative?.(this.opts, 'crashed', describeExit(info))
            this.deps.gpu.onSpeculativeCrash?.(this.opts, info)
            return
          }
          this.deps.gpu.onGpuCrash?.(this.opts, info)
        }
      })
      // Visible to stop() so a cancel can reach the in-flight LlamaServer (CODE-2).
      this.startingInner = runtime
      // #114: concurrent sequential prefetch of the weights, riding the FIRST rung's load
      // window (a later rung re-reads a file the failed attempt already pulled through the
      // page cache — prefetching again buys nothing, same reasoning as the #108 sample
      // rule below). Skipped when the install-state pass just hashed the file (the page
      // cache is already warm — the same one-shot signal that suppresses the #108 sample,
      // peeked here without consuming it). Evidence + design record: prefetch.ts header.
      // Aborted the moment the load window ends (either way), on a CODE-2 stop, and never
      // awaited — a prefetch failure means the load proceeds unassisted, nothing more.
      const firstAttempt = attempted++ === 0
      if (firstAttempt) {
        if (isNextModelLoadSuppressed()) {
          this.deps.onPrefetch?.(this.opts, 'skipped', 'weights just hashed — page-cache-warm')
        } else {
          const prefetch = this.deps.makePrefetch(this.opts.weightPaths ?? [this.opts.modelPath])
          this.prefetch = prefetch
          this.deps.onPrefetch?.(this.opts, 'started')
          void prefetch.done.then((outcome) => this.deps.onPrefetch?.(this.opts, outcome))
        }
      }
      const loadT0 = performance.now()
      try {
        await runtime.start()
      } catch (err) {
        this.abortPrefetch()
        this.startingInner = null
        lastError = err
        try {
          await runtime.stop()
        } catch {
          /* best-effort cleanup; the start error is what matters */
        }
        // CODE-2: a start that failed because the cancel KILLED it must abort the walk —
        // and must never be persisted as a GPU fault (the child was loading, not broken),
        // so this check runs before the gpuAttempt persist below.
        if (this.cancelled) throw cancelledStartError()
        // #182: rung 1a failing says nothing about the GPU — the plain GPU rung is next in
        // the walk and IS the device verdict. Never persist `gpuAutoDisabled` here (an
        // unsupported flag on an older runtime would otherwise exile the machine to CPU),
        // but do latch the model off so later starts skip the doomed multi-GB load attempt.
        if (rung.speculative) {
          const reason = err instanceof Error ? err.message : String(err)
          suppressSpeculative(this.opts.modelId)
          this.deps.onSpeculative?.(this.opts, 'failed', reason)
          continue
        }
        if (rung.gpuAttempt) {
          // Persist so later starts skip straight to rung 2 — no repeated GPU timeouts.
          const reason = err instanceof Error ? err.message : String(err)
          // REL-1: a port-bind race is a transient TOCTOU collision, NOT a GPU/device fault
          // (LlamaServer already retried once on a fresh port). Don't auto-disable GPU for the
          // whole session over one unlucky port steal — only a genuine device/driver/model
          // failure persists `gpuAutoDisabled`.
          if (!isBindRaceError(reason)) this.deps.gpu.onGpuFailure?.(reason)
        }
        continue
      }
      this.abortPrefetch()
      this.startingInner = null
      // #108: the load window just read the model's files start-to-finish — bytes over
      // elapsed is an honest effective media read speed, as a byproduct. FIRST rung of
      // the walk only: a later rung re-reads a file the failed attempt already pulled
      // through the page cache, so its number would be inflated. (A start whose
      // install-state pass just hashed the file is suppressed inside read-speed.ts for
      // the same page-cache reason.) Excludes the #109 warm-up (which runs below) and
      // never throws; a mock rung never reaches here. `weightBytes` covers a vision
      // model's mmproj too — the bare modelPath stat under-counts it. Since #114 the
      // window is prefetch-assisted — the figure remains the honest effective rate the
      // user FELT for this load (this module's contract), now closer to what the medium
      // can actually deliver.
      if (firstAttempt) {
        recordModelLoadRead(
          this.opts.modelPath,
          performance.now() - loadT0,
          this.opts.modelId,
          this.opts.weightBytes
        )
      }

      // CODE-2: cancelled while THIS rung came up but the kill missed it (the pre-spawn
      // window: verify/findPort run before `this.child` exists, and `doStart` resets the
      // `stopping` flag) — stop the fresh server and abort rather than hand it back.
      if (this.cancelled) {
        try {
          await runtime.stop()
        } catch {
          /* best-effort — the queued manager stop re-stops idempotently */
        }
        throw cancelledStartError()
      }

      this.inner = runtime
      if (probePromise) {
        // The rung-1 binary auto-offloads when a device exists; the (cached) probe is
        // what names the backend for the UI. Empty probe ⇒ this start IS CPU mode.
        const devices = await probePromise
        this.backend = devices.length > 0 ? 'gpu' : 'cpu'
        this.gpuName = devices[0]?.name ?? null
      } else {
        this.backend = 'cpu'
        this.gpuName = null
      }
      this.deps.onSelect?.('llama', this.opts, `started via ${rung.label} (backend: ${this.backend})`)
      // benchmark.md "Your model": what this start's log said about where the model landed.
      // Recorded after the backend label so the observation carries the same verdict the UI
      // shows; the observer (IPC layer) persists it. Never throws into the start.
      recordModelPlacement({
        modelId: this.opts.modelId,
        contextTokens: this.opts.contextTokens,
        backend: this.backend === 'gpu' ? 'gpu' : 'cpu',
        ...placement.reading(),
        machineKey: this.deps.machineKey?.() ?? null,
        at: new Date().toISOString()
      })

      // #109: pay the one-time prefill/graph warm-up NOW, inside the "Starting…" window,
      // so start() only resolves once the user's real first prompt lands on a warmed path.
      // Ordering matters: the backend label above is already set, so a GPU crash during
      // the warm-up routes through the §5.3 onGpuCrash auto-fallback (gated on
      // backend === 'gpu'). Real llama rungs only — the rung-4 mock below streams
      // instantly and must keep starting instantly (zero-assets suites rely on it).
      await this.warmUp(runtime)
      // CODE-2: a stop()/quit during the warm-up window stopped the inner server (the
      // warm-up stream then erred and was swallowed above) — the ladder must settle as
      // CANCELLED, never proceed to ready or fall through to another rung.
      if (this.cancelled) {
        try {
          await runtime.stop()
        } catch {
          /* best-effort — stop() already stopped it; the queued manager stop re-stops */
        }
        throw cancelledStartError()
      }
      return
    }

    // CODE-2: a cancelled start must settle as CANCELLED, not commit the rung-4 mock —
    // the queued stop would then have to undo a runtime nobody asked for.
    if (this.cancelled) throw cancelledStartError()

    // Rung 4 — the existing graceful fallback: the app can never be stuck. The mock's
    // replies are visibly simulated, and the next start retries the ladder (from rung 2,
    // since a rung-1 failure persisted the auto-disable flag).
    const mock = this.deps.makeMock(this.opts)
    await mock.start()
    this.inner = mock
    this.backend = 'mock'
    this.gpuName = null
    const reason = lastError instanceof Error ? lastError.message : String(lastError)
    this.deps.onSelect?.('mock', this.opts, `all llama-server start attempts failed: ${reason}`)
  }

  /**
   * #182: may rung 1a run on THIS machine, right now? Conservative by construction — every
   * "don't know" answers no, because a skipped speculative rung costs nothing while a wrong
   * yes costs a silent partial offload (or, off-GPU, an unmeasured configuration).
   *
   * Ordered cheapest-first so the common no-op paths never touch the probe.
   */
  private async speculativeVerdict(
    probe: (binPath: string) => Promise<GpuDevice[]>,
    binPath: string
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (isSpeculativeSuppressed(this.opts.modelId)) {
      return { ok: false, reason: 'latched off for this session by an earlier attempt' }
    }
    const bytes = this.opts.weightBytes
    if (bytes == null || !(bytes > 0)) {
      // `startModelRuntime` always supplies this; a null means a file stat failed, i.e. the
      // VRAM check below cannot be made. Refuse rather than guess.
      return { ok: false, reason: 'weight size unknown — cannot check VRAM headroom' }
    }
    const devices = await probe(binPath).catch(() => [] as GpuDevice[])
    if (devices.length === 0) {
      return { ok: false, reason: 'no GPU device (the measured gain is a full-offload GPU result)' }
    }
    const neededMb = Math.ceil(bytes / (1024 * 1024)) + MTP_VRAM_HEADROOM_MB
    // ONE device must hold all of it: a multi-device split with a draft head is unmeasured,
    // so free VRAM is never summed across cards.
    const best = devices.reduce((a, d) => (d.freeMb > a.freeMb ? d : a))
    if (best.freeMb < neededMb) {
      return {
        ok: false,
        reason: `not enough free VRAM (${best.freeMb} MiB free on ${best.name}, ${neededMb} MiB needed)`
      }
    }
    return { ok: true }
  }

  /**
   * The #109 hidden warm-up generation (see the constants above for the design record
   * pointer). Runs against the INNER runtime so the #39 `served` flag stays false —
   * the warm-up is not a real generation and must not disarm the warm-up hint. Never
   * throws: a cancel is detected by the caller via `this.cancelled`; any other failure
   * (including the cap abort) is logged through `onWarmup` and the start proceeds —
   * the server is healthy, a cold first prompt is strictly better than a failed start.
   */
  private async warmUp(runtime: ModelRuntime): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.deps.warmupTimeoutMs)
    try {
      // No `mode` = 'balanced' → `enable_thinking: false` (requestParamsForMode) — the
      // warm-up must never burn seconds on reasoning tokens. Content-free, tiny cap,
      // loopback-only; the output is discarded, never persisted, never audited as a chat.
      const stream = runtime.chatStream([{ role: 'user', content: WARMUP_PROMPT }], {
        maxTokens: WARMUP_MAX_TOKENS,
        signal: controller.signal
      })
      for await (const _token of stream) {
        /* discard — the request exists only to pay the one-time warm-up cost */
      }
      this.deps.onWarmup?.(this.opts, 'done')
    } catch (err) {
      // A cancel (stop()/quit killed the server mid-warm-up) is handled by the caller's
      // re-check of `this.cancelled` — don't log it as a warm-up fault.
      if (!this.cancelled) {
        const detail = err instanceof Error ? err.message : String(err)
        this.deps.onWarmup?.(this.opts, controller.signal.aborted ? 'timeout' : 'failed', detail)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** #114: end the prefetch window. Idempotent; safe when no prefetch ran. */
  private abortPrefetch(): void {
    this.prefetch?.abort()
    this.prefetch = null
  }

  async stop(): Promise<void> {
    // CODE-2: flag first so the walk aborts at the next rung boundary…
    this.cancelled = true
    // …and the #114 prefetch reader must not keep the drive busy past a stop/lock.
    this.abortPrefetch()
    // …then unblock an in-flight rung: `LlamaServer.stop()` during `waitForHealthy` makes
    // the readiness loop throw via its exit check (the layer that already worked — this
    // makes it reachable). Best-effort: the walk's catch path re-stops idempotently.
    const starting = this.startingInner
    this.startingInner = null
    if (starting) {
      try {
        await starting.stop()
      } catch {
        /* best-effort — the ladder's own failure path re-stops the rung runtime */
      }
    }
    const inner = this.inner
    this.inner = null
    if (inner && inner !== starting) await inner.stop()
  }

  async health(): Promise<HealthStatus> {
    if (!this.inner) return { healthy: false, message: 'Not started', port: null }
    return this.inner.health()
  }

  chatStream(
    messages: ChatMessage[],
    options?: RuntimeChatOptions
  ): AsyncGenerator<string, void, unknown> {
    if (!this.inner) throw new Error('Runtime is not started')
    // #39: the first streamed chunk — an answer token, or in Deep mode a reasoning delta
    // that arrives before any answer token — proves the one-time prefill is done, so the
    // Chat warm-up hint must stop claiming the model is still warming up. Mark on either.
    const markServed = (): void => {
      this.served = true
    }
    const inner = this.inner.chatStream(
      messages,
      options?.onReasoning
        ? {
            ...options,
            onReasoning: (delta) => {
              markServed()
              options.onReasoning?.(delta)
            }
          }
        : options
    )
    return (async function* () {
      for await (const token of inner) {
        markServed()
        yield token
      }
    })()
  }

  /** #39: true once ANY real generation has streamed since this runtime started. */
  warmedUp(): boolean {
    return this.served
  }

  /**
   * The launched context window (§L0). Every rung (and the mock fallback) starts with the
   * SAME `opts.contextTokens`, so this is rung-independent and valid before/after `start()`.
   */
  contextWindow(): number {
    return this.opts.contextTokens
  }
}

/**
 * Build a `RuntimeFactory` that returns the GPU-ladder runtime when the sidecar binary
 * + the model weights are present, else `MockRuntime`. Pure + dependency-injected so
 * the selection + ladder logic is unit-testable without spawning anything.
 */
export function createSelectingRuntimeFactory(deps: RuntimeSelectionDeps): RuntimeFactory {
  const resolveBin =
    deps.resolveBin ??
    ((root: string) => resolveLlamaServerPath(root, process.platform, process.env, { isDev: deps.isDev }))
  const modelExists = deps.modelExists ?? existsSync
  const makeLlama =
    deps.makeLlama ??
    ((opts: RuntimeStartOptions, binPath: string, rung?: LlamaRungOptions) =>
      createLlamaRuntime(opts, {
        binPath,
        extraArgs: rung?.extraArgs,
        onUnexpectedExit: rung?.onUnexpectedExit,
        onStderrData: rung?.onStderrData
      }))
  const makeMock = deps.makeMock ?? createMockRuntime
  const gpu = deps.gpu ?? {}
  const resolveCpuBin = gpu.resolveCpuBin ?? ((root: string) => resolveCpuFallbackServerPath(root))

  return (opts: RuntimeStartOptions): ModelRuntime => {
    const binPath = resolveBin(deps.rootPath)
    if (!binPath) {
      deps.onSelect?.('mock', opts, 'no llama-server binary on the drive')
      return makeMock(opts)
    }
    if (!modelExists(opts.modelPath)) {
      deps.onSelect?.('mock', opts, 'model weights not present')
      return makeMock(opts)
    }

    const tryGpu = (gpu.getGpuMode?.() ?? 'auto') === 'auto' && !(gpu.getGpuAutoDisabled?.() ?? false)
    const rungs: Rung[] = []
    if (tryGpu) {
      // Rung 1a (#182): rung 1 plus the MTP flags, for a manifest that opts in. Listed
      // BEFORE rung 1 so the plain GPU attempt is its automatic fallback — a rung 1a that
      // will not start (an older runtime that rejects the flag, a weight without the draft
      // head, a VRAM refusal) costs one attempt and lands on exactly today's behavior. The
      // rung is DECLARED here and gated at walk time, where the device probe can be awaited.
      if (opts.speculativeDecoding === 'mtp') {
        rungs.push({
          label: 'rung 1a (GPU auto-offload + MTP speculative decoding)',
          binPath,
          extraArgs: [...MTP_SERVER_ARGS],
          gpuAttempt: true,
          speculative: true
        })
      }
      // Rung 1: NO -ngl / --device args — b9585 defaults to ngl=auto + fit=on.
      rungs.push({ label: 'rung 1 (default args, GPU auto-offload)', binPath, extraArgs: [], gpuAttempt: true })
    }
    // Rung 2: same binary, forced CPU. `--device none` is the ONLY way we force CPU.
    rungs.push({
      label: tryGpu ? 'rung 2 (--device none)' : 'rung 2 (--device none; GPU off/auto-disabled)',
      binPath,
      extraArgs: ['--device', 'none'],
      gpuAttempt: false
    })
    // Rung 3: the pure-CPU safety-net build, when the drive ships one.
    const cpuBin = resolveCpuBin(deps.rootPath)
    if (cpuBin && cpuBin !== binPath) {
      rungs.push({ label: 'rung 3 (pure-CPU safety-net build)', binPath: cpuBin, extraArgs: [], gpuAttempt: false })
    }

    return new LadderRuntime(opts, rungs, {
      makeLlama,
      machineKey: deps.machineKey,
      makeMock,
      onSelect: deps.onSelect,
      onWarmup: deps.onWarmup,
      onSpeculative: deps.onSpeculative,
      warmupTimeoutMs: deps.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS,
      onPrefetch: deps.onPrefetch,
      makePrefetch: deps.makePrefetch ?? startModelPrefetch,
      gpu
    })
  }
}

/**
 * Friendly §11.4 copy for the mid-generation auto-fallback. Never "GPU failed" /
 * "your hardware is bad" — CPU mode is normal, not degraded. The canonical-English
 * constant stays exported for tests (D-L8); the notify site below emits via tMain()
 * (i18n record §3.3 rule 2 — runtime:notice is ephemeral).
 */
export const COMPATIBILITY_MODE_NOTICE = t('en', 'main.runtime.compatibilityMode')
/** #182 sibling of {@link COMPATIBILITY_MODE_NOTICE} — the speculative-rung restart notice. */
export const SPEED_UP_DISABLED_NOTICE = t('en', 'main.runtime.speedUpDisabled')

export interface GpuCrashFallbackDeps {
  /** Restart the same model (the ladder now starts at rung 2 — CPU). */
  restart: (opts: RuntimeStartOptions) => Promise<unknown>
  /** Persist `gpuAutoDisabled` + `gpuLastError`; must never throw. */
  persistFailure: (reason: string) => void
  /** Surface the friendly one-line notice (renderer broadcast + log). */
  notify?: (message: string) => void
}

/** One-line human summary of an unexpected sidecar exit, used by the crash handlers. */
function describeExit(info: UnexpectedExitInfo): string {
  const code = info.exitCode != null ? `code ${info.exitCode}` : `signal ${info.exitSignal}`
  const tail = info.stderrTail.trim()
  return `crashed mid-session (${code})${tail ? ` — last output: ${tail}` : ''}`
}

/**
 * Shared shape of the mid-generation auto-restart handlers: react once, restart the same
 * model ONCE, and never loop. Re-entrancy guarded — overlapping crash reports while a
 * restart is in flight are ignored.
 */
function createCrashAutoRestart(
  react: (opts: RuntimeStartOptions, info: UnexpectedExitInfo) => void,
  restart: (opts: RuntimeStartOptions) => Promise<unknown>
): (opts: RuntimeStartOptions, info: UnexpectedExitInfo) => void {
  let restarting = false
  return (opts, info) => {
    if (restarting) return
    restarting = true
    react(opts, info)
    // restart() may throw SYNCHRONOUSLY (before returning a promise). Without this
    // try/catch the throw escapes before `.finally` is attached, `restarting` stays
    // true forever, and EVERY future crash auto-fallback is silently suppressed (M-C3).
    try {
      void restart(opts)
        .catch(() => undefined) // a failed restart surfaces on the user's next start
        .finally(() => {
          restarting = false
        })
    } catch {
      restarting = false // a sync throw surfaces on the user's next start; re-arm the guard
    }
  }
}

/**
 * The §5.3 mid-generation crash handler: persist the auto-disable flag, restart the
 * same model ONCE at CPU, and surface the compatibility-mode notice — so the user's
 * *next* message just works. (After the restart the backend is CPU and the ladder no
 * longer routes crashes here.)
 */
export function createGpuCrashAutoFallback(
  deps: GpuCrashFallbackDeps
): (opts: RuntimeStartOptions, info: UnexpectedExitInfo) => void {
  return createCrashAutoRestart((_opts, info) => {
    deps.persistFailure(describeExit(info))
    deps.notify?.(tMain('main.runtime.compatibilityMode'))
  }, deps.restart)
}

/**
 * #182: the same handler for a crash of the SPECULATIVE rung. Two deliberate differences
 * from its GPU sibling — the reason both exist:
 *
 *  - it does NOT persist `gpuAutoDisabled`. The device is not the suspect; the optional
 *    extra flags are, and the ladder has already latched them off for this session. Exiling
 *    a working GPU to CPU over a speed-up would be a far worse outcome than losing the
 *    speed-up, and would need a Diagnostics visit ("Try GPU again") to undo.
 *  - its notice says what actually happened: the restart lands back on the GPU, so the
 *    compatibility-mode copy ("responses may be a bit slower") would be a plain lie.
 */
export function createSpeculativeCrashAutoFallback(deps: {
  restart: (opts: RuntimeStartOptions) => Promise<unknown>
  /** Observability only — never persisted as a GPU fault. */
  onCrash?: (reason: string) => void
  notify?: (message: string) => void
}): (opts: RuntimeStartOptions, info: UnexpectedExitInfo) => void {
  return createCrashAutoRestart((_opts, info) => {
    deps.onCrash?.(describeExit(info))
    deps.notify?.(tMain('main.runtime.speedUpDisabled'))
  }, deps.restart)
}
