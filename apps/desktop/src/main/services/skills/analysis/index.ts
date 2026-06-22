import { registerSkillAnalysisHandler } from './registry'
import { BANK_STATEMENT_INSTALL_ID, bankStatementAnalysisHandler } from './bank-statement'
import { INVOICE_INSTALL_ID, invoiceAnalysisHandler } from './invoice'
import { DOCUMENT_REDACTION_INSTALL_ID, documentRedactionAnalysisHandler } from './redaction'
import {
  CONTRACT_BRIEF_INSTALL_ID,
  DEADLINE_OBLIGATION_INSTALL_ID,
  MEETING_PROTOCOL_INSTALL_ID,
  SHARE_SAFE_REVIEW_INSTALL_ID,
  WHAT_CHANGED_INSTALL_ID,
  contractBriefAnalysisHandler,
  deadlineObligationAnalysisHandler,
  meetingProtocolAnalysisHandler,
  shareSafeReviewAnalysisHandler,
  whatChangedAnalysisHandler
} from './whole-doc-skills'

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
export {
  CONTRACT_BRIEF_INSTALL_ID,
  DEADLINE_OBLIGATION_INSTALL_ID,
  MEETING_PROTOCOL_INSTALL_ID,
  SHARE_SAFE_REVIEW_INSTALL_ID,
  WHAT_CHANGED_INSTALL_ID,
  contractBriefAnalysisHandler,
  deadlineObligationAnalysisHandler,
  meetingProtocolAnalysisHandler,
  shareSafeReviewAnalysisHandler,
  whatChangedAnalysisHandler
} from './whole-doc-skills'

/** Register every app-owned analysis handler (called once at app init; the chat path consults it). */
export function registerBuiltinSkillAnalysisHandlers(): void {
  registerSkillAnalysisHandler(BANK_STATEMENT_INSTALL_ID, bankStatementAnalysisHandler)
  registerSkillAnalysisHandler(INVOICE_INSTALL_ID, invoiceAnalysisHandler)
  // `document-redaction` registers a `routing` handler (not an exhaustive one): a redaction-shaped
  // request points the user at its run button; an off-topic question keeps the relevance path.
  registerSkillAnalysisHandler(DOCUMENT_REDACTION_INSTALL_ID, documentRedactionAnalysisHandler)
  // The Tier-1 INSTRUCTION skills register `grounded-whole-doc` handlers (skill-whole-doc engine,
  // Wave 2): an analysis-shaped request over a single in-scope doc streams a model answer over the
  // WHOLE document with the SKILL.md fence applied; an off-topic/multi-doc turn keeps the relevance
  // path.
  registerSkillAnalysisHandler(MEETING_PROTOCOL_INSTALL_ID, meetingProtocolAnalysisHandler)
  registerSkillAnalysisHandler(CONTRACT_BRIEF_INSTALL_ID, contractBriefAnalysisHandler)
  registerSkillAnalysisHandler(SHARE_SAFE_REVIEW_INSTALL_ID, shareSafeReviewAnalysisHandler)
  registerSkillAnalysisHandler(DEADLINE_OBLIGATION_INSTALL_ID, deadlineObligationAnalysisHandler)
  // `what-changed` registers a `grounded-whole-doc-compare` handler (Follow-up B): a compare-shaped
  // request over EXACTLY TWO in-scope docs streams a model answer over BOTH documents read whole
  // (budget split across the two) with the SKILL.md format applied; otherwise keeps the relevance path.
  registerSkillAnalysisHandler(WHAT_CHANGED_INSTALL_ID, whatChangedAnalysisHandler)
}
