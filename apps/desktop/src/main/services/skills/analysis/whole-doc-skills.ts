import type { Db } from '../../db'
import type { RetrievalScope } from '../../../../shared/types'
import { documentsInScope } from '../scope-documents'
import { skillInstallId } from '../registry'
import { routeMatch, type SkillVocabId } from '../vocabulary'
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
// (`what-changed`). Since W5 the shape gate reads the ONE canonical per-skill vocabulary (`routeMatch`,
// audit §3.2/§4.1): word-boundary for single tokens, substring for phrases/German stems — single-sourced
// with the SKILL.md suggestion keywords (parity-tested), so "Summarize this meeting" now BOTH earns the
// offer and routes to the whole-doc engine (it was offered, then produced minutes from ~2-4 top-k chunks).

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

/** Build a `grounded-whole-doc-compare` handler: applies on a compare-shaped question (the skill's
 *  `route|both` vocabulary) over EXACTLY TWO in-scope documents. No `run()` — the chat path streams a
 *  model answer over BOTH documents read whole (budget split across the two). */
function makeCompareHandler(skillId: SkillVocabId): SkillAnalysisHandler {
  const isShaped = (question: string): boolean => routeMatch(skillId, question)
  return {
    mode: 'grounded-whole-doc-compare',
    // Doc-count-agnostic intent (W2, §2.1): a compare-shaped question, regardless of how many docs are
    // in scope. When `applies()` fails only on the count (≠2), the chat path emits the deterministic
    // "select exactly two documents" routing answer instead of falling through silently.
    intends(input: SkillAnalysisInput): boolean {
      return isShaped(input.question)
    },
    applies(input: SkillAnalysisInput): boolean {
      if (!isShaped(input.question)) return false
      return exactlyTwoInScopeDocuments(input.db, input.scope)
    }
  }
}

/** Build a `grounded-whole-doc` handler that applies on an analysis-shaped question (the skill's
 *  `route|both` vocabulary) over a single in-scope document. No `run()` — the chat path streams the model
 *  answer over the whole document directly. */
function makeWholeDocHandler(skillId: SkillVocabId): SkillAnalysisHandler {
  const isShaped = (question: string): boolean => routeMatch(skillId, question)
  return {
    mode: 'grounded-whole-doc',
    // Doc-count-agnostic intent (W2, §2.1): an analysis-shaped question, regardless of how many docs are
    // in scope. When `applies()` fails only on the count, the chat path narrows to the skill's best-
    // matching document (with an honest scope notice) or routes, instead of falling through silently.
    intends(input: SkillAnalysisInput): boolean {
      return isShaped(input.question)
    },
    applies(input: SkillAnalysisInput): boolean {
      if (!isShaped(input.question)) return false
      return singleInScopeDocument(input.db, input.scope) !== null
    }
  }
}

// Each Tier-1 instruction skill's shape gate reads its canonical vocabulary (`vocabulary.ts`) — the SAME
// source the SKILL.md suggestion keywords are generated from, so the offer and the routing can no longer
// disagree (audit §4.1). meeting-protocol produces structured minutes from the WHOLE transcript; the
// vocabulary's word-matched `meeting` + `summarize meeting`/`minutes` route entries close the "Summarize
// this meeting" gap. what-changed compares BOTH whole versions over EXACTLY TWO in-scope documents.
export const meetingProtocolAnalysisHandler: SkillAnalysisHandler = makeWholeDocHandler('meeting-protocol')
export const contractBriefAnalysisHandler: SkillAnalysisHandler = makeWholeDocHandler('contract-brief')
export const shareSafeReviewAnalysisHandler: SkillAnalysisHandler = makeWholeDocHandler('share-safe-review')
export const deadlineObligationAnalysisHandler: SkillAnalysisHandler =
  makeWholeDocHandler('deadline-obligation-finder')
export const whatChangedAnalysisHandler: SkillAnalysisHandler = makeCompareHandler('what-changed')
