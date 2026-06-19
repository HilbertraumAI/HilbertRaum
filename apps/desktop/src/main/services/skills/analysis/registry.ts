import type { SkillAnalysisHandler } from './types'

// The analysis-handler registry (full-doc-skills plan §3.1, Phase 2). A small map keyed by skill
// `install_id` → handler, following the precedent of `tool-registry.ts` (`getRegisteredTool`): a
// skill can never register itself; handlers are app-owned and added by EXPLICIT registration only
// (no import-time side effects). Phase 3's chat wiring looks up `getSkillAnalysisHandler(installId)`
// for the resolved turn skill; an unregistered skill returns `undefined` and keeps the relevance
// path verbatim (R5).

const REGISTRY = new Map<string, SkillAnalysisHandler>()

/** Register an app-owned analysis handler for a skill `install_id` (last registration wins). */
export function registerSkillAnalysisHandler(installId: string, handler: SkillAnalysisHandler): void {
  REGISTRY.set(installId, handler)
}

/** Look up the analysis handler for a skill `install_id`, or `undefined` when none is registered. */
export function getSkillAnalysisHandler(installId: string): SkillAnalysisHandler | undefined {
  return REGISTRY.get(installId)
}

/** Drop all registrations (tests only — keeps a suite's registry state isolated). */
export function clearSkillAnalysisHandlers(): void {
  REGISTRY.clear()
}
