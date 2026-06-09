import { existsSync } from 'node:fs'
import type { ModelRuntime, RuntimeFactory, RuntimeStartOptions } from './index'
import { createMockRuntime } from './mock'
import { createLlamaRuntime } from './llama'
import { resolveLlamaServerPath } from './sidecar'

// Availability-aware runtime selector (Phase 10 / graceful-fallback rule). The app
// MUST still launch — and the test suite MUST still pass — with zero model files, so
// the real `LlamaRuntime` is opt-in by availability: it is chosen only when BOTH the
// platform `llama-server` binary AND the model's GGUF weights are present. Otherwise
// we fall back to the `MockRuntime`. The selection happens per `start()` (when the
// concrete model path is known), behind the unchanged `RuntimeManager`/`RuntimeFactory`.

export interface RuntimeSelectionDeps {
  /** Drive root used to resolve `runtime/llama.cpp/<os>/llama-server`. */
  rootPath: string
  /** Resolve the sidecar binary (defaults to `resolveLlamaServerPath`). */
  resolveBin?: (rootPath: string) => string | null
  /** Check whether the model weight file exists (defaults to `existsSync`). */
  modelExists?: (modelPath: string) => boolean
  /** Build the real runtime (defaults to `createLlamaRuntime`). */
  makeLlama?: (opts: RuntimeStartOptions, binPath: string) => ModelRuntime
  /** Build the mock runtime (defaults to `createMockRuntime`). */
  makeMock?: (opts: RuntimeStartOptions) => ModelRuntime
  /** Hook fired with the chosen backend (used for logging). */
  onSelect?: (kind: 'llama' | 'mock', opts: RuntimeStartOptions, reason: string) => void
}

/**
 * Build a `RuntimeFactory` that returns `LlamaRuntime` when the sidecar binary + the
 * model weights are present, else `MockRuntime`. Pure + dependency-injected so the
 * selection logic is unit-testable without spawning anything or touching real files.
 */
export function createSelectingRuntimeFactory(deps: RuntimeSelectionDeps): RuntimeFactory {
  const resolveBin = deps.resolveBin ?? ((root: string) => resolveLlamaServerPath(root))
  const modelExists = deps.modelExists ?? existsSync
  const makeLlama =
    deps.makeLlama ?? ((opts: RuntimeStartOptions, binPath: string) => createLlamaRuntime(opts, { binPath }))
  const makeMock = deps.makeMock ?? createMockRuntime

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
    deps.onSelect?.('llama', opts, 'binary + weights present')
    return makeLlama(opts, binPath)
  }
}
