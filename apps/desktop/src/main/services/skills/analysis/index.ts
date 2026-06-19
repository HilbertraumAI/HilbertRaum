import { registerSkillAnalysisHandler } from './registry'
import { BANK_STATEMENT_INSTALL_ID, bankStatementAnalysisHandler } from './bank-statement'

// The analysis-handler seam barrel (full-doc-skills plan §3.1, Phase 2). Re-exports the registry +
// types and exposes the EXPLICIT registration of the app-owned handlers (no import-time side
// effects — Phase 3's app init calls `registerBuiltinSkillAnalysisHandlers()` once, before the chat
// path consults the registry). Adoption is per-skill (D49): `bank-statement` ships now; `invoice`
// follows on the same seam (Phase 4); `document-redaction` intentionally never registers.

export type {
  SkillAnalysisContext,
  SkillAnalysisHandler,
  SkillAnalysisInput,
  SkillAnalysisResult
} from './types'
export {
  getSkillAnalysisHandler,
  registerSkillAnalysisHandler,
  clearSkillAnalysisHandlers
} from './registry'
export { BANK_STATEMENT_INSTALL_ID, bankStatementAnalysisHandler, buildBankAnswer } from './bank-statement'

/** Register every app-owned analysis handler (called once at app init; Phase 3 wires the chat path). */
export function registerBuiltinSkillAnalysisHandlers(): void {
  registerSkillAnalysisHandler(BANK_STATEMENT_INSTALL_ID, bankStatementAnalysisHandler)
}
