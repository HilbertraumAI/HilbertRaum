// Per-kind doc-task handler REGISTRY (DX-1 split, full-audit-2026-06-29 follow-up Phase 8).
// The manager's `run()` keeps only queue/pump/arbiter/retry orchestration; the actual work for
// each kind lives in its own sibling module and is dispatched through this map. Adding a kind is
// a one-line registry entry, not another `else if` branch in the orchestrator.

import type { DocTaskKind } from '../../../../shared/types'
import type { ModelTaskHandler } from '../context'
import { runTreeBuild, runExtract } from './tree'
import { runSummary } from './summary'
import { runCompare } from './compare'

export { runOcr } from './ocr'
export { runCategorize } from './categorize'
export { runTranslation } from './translation'

/**
 * The CHAT-runtime-requiring kinds — every kind except `ocr` (the recognition engine),
 * `categorize` (runtime-optional), and `translation` (since TG-3 it runs on the TranslateGemma
 * sidecar via `DocTaskDeps.getTranslator`, dispatched directly like `ocr`). The manager re-checks
 * the runtime once at dequeue time, then dispatches through this map — so the `if (!runtime)
 * throw` guard stays centralized in the orchestrator exactly as before, and each handler can
 * assume a live runtime.
 */
export const MODEL_TASK_HANDLERS: Record<
  Exclude<DocTaskKind, 'ocr' | 'categorize' | 'translation'>,
  ModelTaskHandler
> = {
  summary: runSummary,
  compare: runCompare,
  tree: runTreeBuild,
  extract: runExtract
}
