import type { Db } from '../../db'
import type { RetrievalScope } from '../../../../shared/types'
import { documentsInScope } from '../scope-documents'
import { skillInstallId } from '../registry'
import type { SkillAnalysisHandler, SkillAnalysisInput } from './types'

// Skill-aware WHOLE-DOCUMENT handlers (skill-whole-doc engine, Wave 2 — architecture.md §19/§20).
//
// These are the Tier-1 INSTRUCTION skills whose deliverable is the MODEL's answer over the WHOLE
// document, formatted to the SKILL.md body (minutes, contract brief, share-safe review, deadlines).
// Before Wave 2 they hit a structural gap: the SKILL.md fence is applied ONLY on the top-k relevance
// engine, while every whole-document engine ignores it — so they could be whole-document OR
// formatted-to-spec, never both (worst case: meeting minutes built from ~5 retrieved passages miss
// decisions/action items). A `grounded-whole-doc` handler closes that: on an analysis-shaped request
// over a single in-scope document the chat path streams a model answer over the WHOLE document WITH
// the fence applied and stamps honest `capped` coverage (`registerRagIpc` → `generateGroundedAnswer
// ({ wholeDocument })`). These handlers therefore carry NO `run()` — only `mode` + `applies()` (the
// intent + single-doc gate). The fully-chunked refusal (D45) still gates the turn in `registerRagIpc`.
//
// Conservative by design (the bank/invoice `applies()` precedent): an OFF-TOPIC question, or a
// multi-document scope, returns false and keeps the ordinary relevance path. Wave 2 is single-document
// (the run UI + budget reason about one document); multi-doc compare stays on the `compare` engine
// (`what-changed`). Matching is case-insensitive `question.includes(keyword)`; bare ambiguous tokens
// are avoided (the same bilingual discipline as the SKILL.md triggers).

export const MEETING_PROTOCOL_INSTALL_ID = skillInstallId('app', 'meeting-protocol')
export const CONTRACT_BRIEF_INSTALL_ID = skillInstallId('app', 'contract-brief')
export const SHARE_SAFE_REVIEW_INSTALL_ID = skillInstallId('app', 'share-safe-review')
export const DEADLINE_OBLIGATION_INSTALL_ID = skillInstallId('app', 'deadline-obligation-finder')
export const WHAT_CHANGED_INSTALL_ID = skillInstallId('app', 'what-changed')

// The whole-document handlers read the stored `chunks` (the model answers OVER them), so they take the
// shared helper's `requireChunks: true` predicate (X-1) — an indexed-but-unchunked document is runnable
// via the button but not answerable here. These handlers only count the in-scope documents (1 or 2), so
// the helper's id projection is enough; the deterministic ordering is harmless here.

/** The single in-scope answerable document, or null when the scope is not exactly one (Wave 2 scope). */
function singleInScopeDocument(db: Db, scope: RetrievalScope): { id: string } | null {
  const docs = documentsInScope(db, scope, { requireChunks: true })
  return docs.length === 1 ? { id: docs[0].id } : null
}

/** True when the scope holds EXACTLY TWO in-scope documents (what-changed compare — Follow-up B). */
function exactlyTwoInScopeDocuments(db: Db, scope: RetrievalScope): boolean {
  return documentsInScope(db, scope, { requireChunks: true }).length === 2
}

/** Build a `grounded-whole-doc-compare` handler: applies on a compare-shaped question (any of
 *  `keywords`) over EXACTLY TWO in-scope documents. No `run()` — the chat path streams a model
 *  answer over BOTH documents read whole (budget split across the two). */
function makeCompareHandler(keywords: readonly string[]): SkillAnalysisHandler {
  const isShaped = (question: string): boolean => {
    const q = question.toLowerCase()
    return keywords.some((k) => q.includes(k))
  }
  return {
    mode: 'grounded-whole-doc-compare',
    applies(input: SkillAnalysisInput): boolean {
      if (!isShaped(input.question)) return false
      return exactlyTwoInScopeDocuments(input.db, input.scope)
    }
  }
}

/** Build a `grounded-whole-doc` handler that applies on an analysis-shaped question (any of
 *  `keywords`) over a single in-scope document. No `run()` — the chat path streams the model
 *  answer over the whole document directly. */
function makeWholeDocHandler(keywords: readonly string[]): SkillAnalysisHandler {
  const isShaped = (question: string): boolean => {
    const q = question.toLowerCase()
    return keywords.some((k) => q.includes(k))
  }
  return {
    mode: 'grounded-whole-doc',
    applies(input: SkillAnalysisInput): boolean {
      if (!isShaped(input.question)) return false
      return singleInScopeDocument(input.db, input.scope) !== null
    }
  }
}

// meeting-protocol — produce structured minutes from the WHOLE transcript/notes (EN + DE).
export const meetingProtocolAnalysisHandler: SkillAnalysisHandler = makeWholeDocHandler([
  'meeting minutes', 'meeting notes', 'meeting protocol', 'meeting transcript', 'minutes',
  'action item', 'action items', 'decisions', 'decisions made', 'write minutes', 'summarize meeting',
  'summarise meeting', 'agenda',
  'besprechungsprotokoll', 'sitzungsprotokoll', 'meetingprotokoll', 'gesprächsprotokoll', 'protokoll',
  'besprechung', 'sitzung', 'tagesordnung', 'aktionspunkte', 'aufgaben', 'beschlüsse', 'entscheidungen',
  'offene punkte', 'zusammenfassung der besprechung'
])

// contract-brief — a plain-language brief of the WHOLE contract (EN + DE). Includes the bare domain
// NOUNS: when the user mentions the contract/agreement while THIS skill is selected, they want the
// brief — `includes` can't span "summarize <this> contract", so the noun is the robust trigger.
export const contractBriefAnalysisHandler: SkillAnalysisHandler = makeWholeDocHandler([
  'contract', 'agreement', 'lease', 'terms and conditions',
  'contract brief', 'contract summary', 'review contract', 'summarize contract', 'summarise contract',
  'before signing', 'key terms', 'contract risks', 'termination clause', 'renewal clause',
  'liability clause', 'indemnity',
  'vertrag', 'vereinbarung', 'mietvertrag', 'dienstleistungsvertrag', 'agb',
  'vertragsübersicht', 'vertrag zusammenfassen', 'vertrag prüfen', 'vertragsanalyse',
  'vor der unterschrift', 'wichtige klauseln', 'pflichten im vertrag', 'risiken im vertrag',
  'kündigung', 'verlängerung', 'haftung'
])

// share-safe-review — advisory pre-share review across the WHOLE document (EN + DE).
export const shareSafeReviewAnalysisHandler: SkillAnalysisHandler = makeWholeDocHandler([
  'safe to share', 'share-safe', 'review before sharing', 'before sharing', 'privacy review',
  'disclosure review', 'sensitive information', 'confidential information', 'remove private information',
  'sicher teilen', 'vor dem teilen prüfen', 'vor dem teilen', 'datenschutz prüfen', 'sensible daten',
  'vertrauliche informationen', 'private informationen'
])

// deadline-obligation-finder — find deadlines/obligations across the WHOLE document (EN + DE).
export const deadlineObligationAnalysisHandler: SkillAnalysisHandler = makeWholeDocHandler([
  'deadline', 'deadlines', 'due date', 'due dates', 'notice period', 'renewal date',
  'cancellation deadline', 'obligation', 'obligations', 'duties', 'what do i have to do', 'by when',
  'action required', 'payment date', 'payment dates',
  'frist', 'fristen', 'fälligkeit', 'fälligkeiten', 'stichtag', 'kündigungsfrist', 'pflicht',
  'pflichten', 'verpflichtung', 'verpflichtungen', 'zahlungsfrist', 'bis wann', 'wiedervorlage'
])

// what-changed — material-change compare over BOTH whole document versions (EN + DE; Follow-up B).
// Compare-shaped intent over EXACTLY TWO in-scope documents. Mirrors the SKILL.md triggers but as
// `includes` substrings (the bilingual discipline: multi-word/domain terms, no bare ambiguous tokens).
export const whatChangedAnalysisHandler: SkillAnalysisHandler = makeCompareHandler([
  'what changed', 'what has changed', 'compare versions', 'compare documents', 'compare the two',
  'version difference', 'differences between', 'difference between', 'changed between', 'old and new',
  'redline', 'compare contract', 'compare these',
  'was hat sich geändert', 'änderungen', 'unterschiede', 'unterschied zwischen', 'versionen vergleichen',
  'dokumente vergleichen', 'alte version', 'neue version', 'gegenüberstellung', 'vertragsänderung',
  'vergleiche', 'vergleich'
])
