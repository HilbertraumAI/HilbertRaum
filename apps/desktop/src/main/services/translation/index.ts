import type { TranslateOptions } from './runtime'

// The translation sidecar family (TG wave, plan §2 D1). A SEPARATE lazy `llama-server` serving
// TranslateGemma over the raw `/completion` endpoint — the fifth `LlamaServer` composition after
// chat, the E5 embedder, the reranker, and vision. TG-2 shipped the runtime + availability
// wiring; since TG-3 the document-translation doc-task consumes it (`DocTaskDeps.getTranslator`
// — the chat runtime is no longer involved in translation); the Translate view lands at TG-4/5.

export { TranslationRuntime } from './runtime'
export type { TranslateOptions } from './runtime'
export { isCleanStop } from './completion'
export type { CompletionFinal } from './completion'
export { createSelectedTranslator } from './factory'
export type { TranslationModelInfo, TranslatorSelectionDeps } from './factory'
export {
  buildTranslationPrompt,
  TRANSLATION_LANGUAGE_CODES,
  TRANSLATION_ENGLISH_NAMES,
  TRANSLATION_NATIVE_NAMES,
  TRANSLATION_STOP_TOKEN,
  type TranslationLangCode
} from './prompt'

/**
 * What a translation backend must do — `TranslationRuntime` satisfies it (and tests fake it). The
 * INTERFACE, not the concrete runtime, is what `AppContext` carries + what TG-3/TG-4 consume, so
 * the sidecar stays swappable behind the spec §9.2 seam. (The `createSelectedTranslator` factory
 * returns `Translator`, so the runtime's conformance is compile-checked there.)
 */
export interface Translator {
  /** The manifest id of the loaded translation model. */
  readonly modelId: string
  /** The launched context window (`--ctx-size`) — TG-3's window planner clamps against it (§L0). */
  contextWindow(): number
  /** Translate ONE window, streaming deltas via `opts.onToken`; resolves with the full text. */
  translate(opts: TranslateOptions): Promise<string>
  /** Permanent teardown (quit) — no orphan on a racing lazy start. */
  stop(): Promise<void>
  /** Soft teardown (workspace lock) — the sidecar lazily restarts on the next `translate()`. */
  suspend?(): Promise<void>
}
