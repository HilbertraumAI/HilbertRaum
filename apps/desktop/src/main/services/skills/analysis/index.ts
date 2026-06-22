import { registerSkillAnalysisHandler } from './registry'
import { BANK_STATEMENT_INSTALL_ID, bankStatementAnalysisHandler } from './bank-statement'
import { INVOICE_INSTALL_ID, invoiceAnalysisHandler } from './invoice'
import { DOCUMENT_REDACTION_INSTALL_ID, documentRedactionAnalysisHandler } from './redaction'

// The analysis-handler seam barrel (full-doc-skills plan §3.1, Phase 2). Re-exports the registry +
// types and exposes the EXPLICIT registration of the app-owned handlers (no import-time side
// effects — app init calls `registerBuiltinSkillAnalysisHandlers()` once, before the chat path
// consults the registry). Adoption is per-skill (D49): `bank-statement` and `invoice` ship
// `exhaustive` handlers (they READ the whole document and synthesise a grounded answer);
// `document-redaction` ships a `routing` handler — it is an ACTION skill (it WRITES a redacted copy
// via a confirm-gated, user-initiated run), so on a redaction-shaped request it points the user at
// its run button instead of producing a misleading top-k Q&A. An off-topic question with redaction
// active still keeps the relevance path (the routing handler's `applies()` is false).

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
export { DOCUMENT_REDACTION_INSTALL_ID, documentRedactionAnalysisHandler } from './redaction'

/** Register every app-owned analysis handler (called once at app init; the chat path consults it). */
export function registerBuiltinSkillAnalysisHandlers(): void {
  registerSkillAnalysisHandler(BANK_STATEMENT_INSTALL_ID, bankStatementAnalysisHandler)
  registerSkillAnalysisHandler(INVOICE_INSTALL_ID, invoiceAnalysisHandler)
  // `document-redaction` registers a `routing` handler (not an exhaustive one): a redaction-shaped
  // request points the user at its run button; an off-topic question keeps the relevance path.
  registerSkillAnalysisHandler(DOCUMENT_REDACTION_INSTALL_ID, documentRedactionAnalysisHandler)
}
