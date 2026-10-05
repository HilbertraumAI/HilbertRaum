import { describe, it, expect } from 'vitest'
import {
  BANK_STATEMENT_INSTALL_ID,
  CONTRACT_BRIEF_INSTALL_ID,
  DEADLINE_OBLIGATION_INSTALL_ID,
  DOCUMENT_EDIT_INSTALL_ID,
  DOCUMENT_REDACTION_INSTALL_ID,
  INVOICE_INSTALL_ID,
  MEETING_PROTOCOL_INSTALL_ID,
  SHARE_SAFE_REVIEW_INSTALL_ID,
  WHAT_CHANGED_INSTALL_ID,
  bankStatementAnalysisHandler,
  contractBriefAnalysisHandler,
  deadlineObligationAnalysisHandler,
  documentEditAnalysisHandler,
  documentRedactionAnalysisHandler,
  getSkillAnalysisHandler,
  invoiceAnalysisHandler,
  meetingProtocolAnalysisHandler,
  registerBuiltinSkillAnalysisHandlers,
  shareSafeReviewAnalysisHandler,
  whatChangedAnalysisHandler
} from '../../src/main/services/skills/analysis'

// One table over every app-owned analysis handler: app init calls `registerBuiltinSkillAnalysisHandlers()`
// once and the chat path resolves a skill's engine by install id, so a missing or swapped registration
// silently drops a skill to the relevance path.
describe('registerBuiltinSkillAnalysisHandlers — every builtin skill resolves to its handler (D49)', () => {
  it.each([
    ['bank-statement', BANK_STATEMENT_INSTALL_ID, bankStatementAnalysisHandler],
    ['invoice', INVOICE_INSTALL_ID, invoiceAnalysisHandler],
    ['document-redaction', DOCUMENT_REDACTION_INSTALL_ID, documentRedactionAnalysisHandler],
    ['document-edit', DOCUMENT_EDIT_INSTALL_ID, documentEditAnalysisHandler],
    ['meeting-protocol', MEETING_PROTOCOL_INSTALL_ID, meetingProtocolAnalysisHandler],
    ['contract-brief', CONTRACT_BRIEF_INSTALL_ID, contractBriefAnalysisHandler],
    ['share-safe-review', SHARE_SAFE_REVIEW_INSTALL_ID, shareSafeReviewAnalysisHandler],
    ['deadline-obligation', DEADLINE_OBLIGATION_INSTALL_ID, deadlineObligationAnalysisHandler],
    ['what-changed', WHAT_CHANGED_INSTALL_ID, whatChangedAnalysisHandler]
  ])('%s', (_name, installId, handler) => {
    registerBuiltinSkillAnalysisHandlers()
    expect(getSkillAnalysisHandler(installId)).toBe(handler)
  })

  it('an unknown install id has no handler', () => {
    registerBuiltinSkillAnalysisHandlers()
    expect(getSkillAnalysisHandler('app:not-a-skill')).toBeUndefined()
  })
})
