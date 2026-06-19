import { registerSkillAnalysisHandler } from './registry'
import { BANK_STATEMENT_INSTALL_ID, bankStatementAnalysisHandler } from './bank-statement'
import { INVOICE_INSTALL_ID, invoiceAnalysisHandler } from './invoice'

// The analysis-handler seam barrel (full-doc-skills plan §3.1, Phase 2). Re-exports the registry +
// types and exposes the EXPLICIT registration of the app-owned handlers (no import-time side
// effects — app init calls `registerBuiltinSkillAnalysisHandlers()` once, before the chat path
// consults the registry). Adoption is per-skill (D49): `bank-statement` and `invoice` both ship a
// handler on this seam; `document-redaction` intentionally never registers — it is an ACTION skill
// (it redacts a document), not an analysis-question skill, so a plain chat question is never
// force-routed through it (it keeps the relevance path).

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
export { INVOICE_INSTALL_ID, invoiceAnalysisHandler, buildInvoiceAnswer } from './invoice'

/** Register every app-owned analysis handler (called once at app init; the chat path consults it). */
export function registerBuiltinSkillAnalysisHandlers(): void {
  registerSkillAnalysisHandler(BANK_STATEMENT_INSTALL_ID, bankStatementAnalysisHandler)
  registerSkillAnalysisHandler(INVOICE_INSTALL_ID, invoiceAnalysisHandler)
  // `document-redaction` intentionally does NOT register (D49): it is an action skill, not an
  // analysis-question skill, so a plain chat question keeps the relevance path.
}
