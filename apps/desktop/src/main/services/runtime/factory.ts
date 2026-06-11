import { existsSync } from 'node:fs'
import type { GpuDevice } from '../../../shared/types'
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
import { probeGpuDevices } from './gpu'
import {
  resolveCpuFallbackServerPath,
  resolveLlamaServerPath,
  type UnexpectedExitInfo
} from './sidecar'

// Availability-aware runtime selector (Phase 10 / graceful-fallback rule) + the GPU
// start LADDER (Phase 15, architecture.md GPU record §5.2). The app MUST still launch —
// and the test suite MUST still pass — with zero model files, zero binaries, and zero
// GPUs, so the real `LlamaRuntime` is opt-in by availability (binary + weights present)
// and every GPU decision degrades automatically:
//
//   rung 1  default binary, NO device args   (b9585: ngl=auto + fit=on → VRAM-aware
//           offload; on a GPU-less machine this IS CPU mode — the ladder ends here
//           for almost everyone)
//   rung 2  same binary, forced CPU          (`--device none` — NEVER `-ngl`, locked)
//   rung 3  pure-CPU safety-net binary       (`runtime/llama.cpp/<os>/cpu/`, if present)
//   rung 4  MockRuntime                      (the existing graceful-fallback rule —
//           the app can never be *stuck*)
//
// `gpuMode: 'off'` (Settings) and `gpuAutoDisabled` (a previously detected problem)
// skip rung 1. A rung-1 failure reports through `onGpuFailure` so the caller persists
// `gpuAutoDisabled` + `gpuLastError` — no repeated GPU health timeouts on later starts.
// GPU state is INJECTED (read-callbacks), never read from the DB here — keeps the
// ladder pure and unit-testable with the existing fake seams.

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
}

/** Extra knobs `makeLlama` receives per rung. */
export interface LlamaRungOptions {
  extraArgs: string[]
  onUnexpectedExit: (info: UnexpectedExitInfo) => void
}

export interface RuntimeSelectionDeps {
  /** Drive root used to resolve `runtime/llama.cpp/<os>/llama-server`. */
  rootPath: string
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
  /** GPU ladder hooks (Phase 15). Omitted → defaults (gpuMode 'auto', no persistence). */
  gpu?: GpuLadderDeps
}

interface Rung {
  /** Reason fragment for onSelect/logging. */
  label: string
  binPath: string
  extraArgs: string[]
  /** True only for rung 1 — the attempt whose failure auto-disables GPU. */
  gpuAttempt: boolean
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

  constructor(
    private readonly opts: RuntimeStartOptions,
    private readonly rungs: Rung[],
    private readonly deps: {
      makeLlama: NonNullable<RuntimeSelectionDeps['makeLlama']>
      makeMock: NonNullable<RuntimeSelectionDeps['makeMock']>
      onSelect?: RuntimeSelectionDeps['onSelect']
      gpu: GpuLadderDeps
    }
  ) {
    this.modelId = opts.modelId
  }

  async start(): Promise<void> {
    let lastError: unknown = null
    for (const rung of this.rungs) {
      // Kick the (cached) probe off BEFORE the server start so the two run
      // concurrently — the model load dominates, so by the time the server is healthy
      // the backend label is normally already known (audit fix: a cold probe used to
      // stall the first start by up to its 10 s bound AFTER the server was healthy,
      // and a crash inside that window was mislabeled 'cpu').
      const probe = this.deps.gpu.probeDevices ?? ((bin: string) => probeGpuDevices(bin))
      const probePromise = rung.gpuAttempt
        ? probe(rung.binPath).catch(() => [] as GpuDevice[])
        : null
      const runtime = this.deps.makeLlama(this.opts, rung.binPath, {
        extraArgs: rung.extraArgs,
        // Only a crash of a runtime that actually landed on the GPU triggers the
        // auto-fallback; CPU-mode crashes keep today's behavior (error + manual restart).
        onUnexpectedExit: (info) => {
          if (this.backend === 'gpu') this.deps.gpu.onGpuCrash?.(this.opts, info)
        }
      })
      try {
        await runtime.start()
      } catch (err) {
        lastError = err
        try {
          await runtime.stop()
        } catch {
          /* best-effort cleanup; the start error is what matters */
        }
        if (rung.gpuAttempt) {
          // Persist so later starts skip straight to rung 2 — no repeated GPU timeouts.
          const reason = err instanceof Error ? err.message : String(err)
          this.deps.gpu.onGpuFailure?.(reason)
        }
        continue
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
      return
    }

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

  async stop(): Promise<void> {
    const inner = this.inner
    this.inner = null
    if (inner) await inner.stop()
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
    return this.inner.chatStream(messages, options)
  }
}

/**
 * Build a `RuntimeFactory` that returns the GPU-ladder runtime when the sidecar binary
 * + the model weights are present, else `MockRuntime`. Pure + dependency-injected so
 * the selection + ladder logic is unit-testable without spawning anything.
 */
export function createSelectingRuntimeFactory(deps: RuntimeSelectionDeps): RuntimeFactory {
  const resolveBin = deps.resolveBin ?? ((root: string) => resolveLlamaServerPath(root))
  const modelExists = deps.modelExists ?? existsSync
  const makeLlama =
    deps.makeLlama ??
    ((opts: RuntimeStartOptions, binPath: string, rung?: LlamaRungOptions) =>
      createLlamaRuntime(opts, {
        binPath,
        extraArgs: rung?.extraArgs,
        onUnexpectedExit: rung?.onUnexpectedExit
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
    // Rung 3: the pure-CPU safety-net build, when the drive ships one (Phase 14).
    const cpuBin = resolveCpuBin(deps.rootPath)
    if (cpuBin && cpuBin !== binPath) {
      rungs.push({ label: 'rung 3 (pure-CPU safety-net build)', binPath: cpuBin, extraArgs: [], gpuAttempt: false })
    }

    return new LadderRuntime(opts, rungs, { makeLlama, makeMock, onSelect: deps.onSelect, gpu })
  }
}

/**
 * Friendly §11.4 copy for the mid-generation auto-fallback. Never "GPU failed" /
 * "your hardware is bad" — CPU mode is normal, not degraded.
 */
export const COMPATIBILITY_MODE_NOTICE =
  'Switched to compatibility mode for stability. Everything keeps working — responses may be a bit slower.'

export interface GpuCrashFallbackDeps {
  /** Restart the same model (the ladder now starts at rung 2 — CPU). */
  restart: (opts: RuntimeStartOptions) => Promise<unknown>
  /** Persist `gpuAutoDisabled` + `gpuLastError`; must never throw. */
  persistFailure: (reason: string) => void
  /** Surface the friendly one-line notice (renderer broadcast + log). */
  notify?: (message: string) => void
}

/**
 * The §5.3 mid-generation crash handler: persist the auto-disable flag, restart the
 * same model ONCE at CPU, and surface the compatibility-mode notice — so the user's
 * *next* message just works. Re-entrancy guarded: overlapping crash reports while a
 * restart is in flight are ignored (a single restart, never a loop — after it, the
 * backend is CPU and the ladder no longer routes crashes here).
 */
export function createGpuCrashAutoFallback(
  deps: GpuCrashFallbackDeps
): (opts: RuntimeStartOptions, info: UnexpectedExitInfo) => void {
  let restarting = false
  return (opts, info) => {
    if (restarting) return
    restarting = true
    const code = info.exitCode != null ? `code ${info.exitCode}` : `signal ${info.exitSignal}`
    const tail = info.stderrTail.trim()
    deps.persistFailure(`crashed mid-session (${code})${tail ? ` — last output: ${tail}` : ''}`)
    deps.notify?.(COMPATIBILITY_MODE_NOTICE)
    void deps
      .restart(opts)
      .catch(() => undefined) // a failed CPU restart surfaces on the user's next start
      .finally(() => {
        restarting = false
      })
  }
}
