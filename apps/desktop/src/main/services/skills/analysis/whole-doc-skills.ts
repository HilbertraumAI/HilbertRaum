import type { Db } from '../../db'
import type { RetrievalScope } from '../../../../shared/types'
import type { SkillAnalysisMode, SkillKind } from '../../../../shared/skill-manifest'
import { documentsInScope } from '../scope-documents'
import { skillInstallId } from '../registry'
import { isSmallTalk, routeMatch, type SkillVocabId } from '../vocabulary'
import { singleInScopeDocument } from './common'
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
// A3 GATE INVERSION (audit §6.3/§8.2): the whole-doc engine is now the DEFAULT for an analysis-mode skill
// active over a matching fully-chunked SINGLE-doc scope — no longer gated on the question matching a
// per-skill, per-language keyword list (the recurring incident class: every phrasing gap silently degraded
// a whole-document ask to top-k-with-fence). `applies()` is `!isSmallTalk(question)` over a single (resp.
// exactly-two) in-scope doc — any non-chatter question defaults to the engine. The needle-vs-deliverable
// classification (the other half of §8.2) lives in the chat path, where W1's truncation calculus can decide
// whether a NEEDLE ask over an over-budget doc is better served by top-k.
//
// A4 GATE COMPOSITION (SKA-8, audit §3.2): `intends()` — the W2 COUNT-MISMATCH routing predicate, consulted
// ONLY at the wrong doc count — is now VOCABULARY-shaped (`routeMatch` of the skill's OWN vocabulary), NOT
// `!isSmallTalk`. Post-A3 the broad `!isSmallTalk` intent made the W2 pre-pass intercept EVERY non-chatter
// question at MULTI-doc scope, so a sticky instruction skill over a Library turned "who is Angela Merkel?"
// into a "pick one document" dead-end and the relevance/coverage-extract engines became unreachable. Now the
// pre-pass narrows/routes ONLY a question that matches this skill's routing vocabulary; a general/off-topic
// question at the wrong count falls through to the ordinary engines. This DECOUPLES `intends()` from
// `applies()` (the A3 single-doc inversion stays in `applies()`; see the factories). A user-imported skill
// carries no routing vocabulary (`vocabId` undefined) — it never W2-routes (falls through) but still gets
// the single-doc engine via `applies()`. Multi-doc compare stays on the `compare` engine (`what-changed`).
//
// Because the gate is skill-agnostic, these handlers are also the ENGINE for a USER-imported instruction
// skill that declares `analysis: whole-doc`/`compare` in its SKILL.md — resolved via `manifestAnalysisHandler`
// below (the fix for "any user-imported skill silently gets top-k-with-fence", §6.3). Tool registration stays
// app-only (SEC-1): this adds no capability, only which context the model reads.

export const MEETING_PROTOCOL_INSTALL_ID = skillInstallId('app', 'meeting-protocol')
export const CONTRACT_BRIEF_INSTALL_ID = skillInstallId('app', 'contract-brief')
export const SHARE_SAFE_REVIEW_INSTALL_ID = skillInstallId('app', 'share-safe-review')
export const DEADLINE_OBLIGATION_INSTALL_ID = skillInstallId('app', 'deadline-obligation-finder')
export const WHAT_CHANGED_INSTALL_ID = skillInstallId('app', 'what-changed')

// The whole-document handlers read the stored `chunks` (the model answers OVER them), so they take the
// shared helper's `requireChunks: true` predicate (X-1) — an indexed-but-unchunked document is runnable
// via the button but not answerable here. These handlers only need the existence check (`!== null`); the
// shared `analysis/common.ts` `singleInScopeDocument` (A1) is that helper (its title/mimeType go unused
// here). The count check below is the two-document compare gate.

/** True when the scope holds EXACTLY TWO in-scope documents (what-changed compare — Follow-up B). */
function exactlyTwoInScopeDocuments(db: Db, scope: RetrievalScope): boolean {
  return documentsInScope(db, scope, { requireChunks: true }).length === 2
}

/** Build a `grounded-whole-doc-compare` handler. `applies()` (A3-inverted gate): ANY non-small-talk question
 *  over EXACTLY TWO in-scope documents. `intends()` (A4/SKA-8): the VOCABULARY-shaped W2 count-mismatch
 *  routing predicate (empty for a user skill with no `vocabId` → never W2-routes). No `run()` — the chat
 *  path streams a model answer over BOTH documents read whole (budget split across the two). */
function makeCompareHandler(vocabId?: SkillVocabId): SkillAnalysisHandler {
  return {
    mode: 'grounded-whole-doc-compare',
    // A4 (SKA-8, §3.2): vocabulary-shaped intent — the pre-pass emits "select exactly two documents" ONLY
    // for a compare-vocabulary question at ≠2 docs; a general/off-topic question at the wrong count falls
    // through to the ordinary engines. `applies()` (below) keeps A3's inversion at exactly two docs.
    intends(input: SkillAnalysisInput): boolean {
      return vocabId ? routeMatch(vocabId, input.question) : false
    },
    applies(input: SkillAnalysisInput): boolean {
      if (isSmallTalk(input.question)) return false
      return exactlyTwoInScopeDocuments(input.db, input.scope)
    }
  }
}

/** Build a `grounded-whole-doc` handler. `applies()` (A3-inverted gate): ANY non-small-talk question over a
 *  single in-scope document. `intends()` (A4/SKA-8): the VOCABULARY-shaped W2 count-mismatch routing
 *  predicate (empty for a user skill with no `vocabId`). No `run()` — the chat path streams the model answer
 *  over the whole document directly. The same factory serves the bundled instruction skills AND a
 *  user-imported skill declaring `analysis: whole-doc` (`manifestAnalysisHandler`, no vocabId). */
function makeWholeDocHandler(vocabId?: SkillVocabId): SkillAnalysisHandler {
  return {
    mode: 'grounded-whole-doc',
    // A4 (SKA-8, §3.2): vocabulary-shaped intent — the W2 pre-pass narrows/routes ONLY a question matching
    // this skill's routing vocabulary at multi-doc scope; a general/off-topic question there falls through
    // to the ordinary engines (no "pick one document" dead-end). `applies()` (below) keeps A3's single-doc
    // inversion: any non-chatter question over ONE doc still defaults to the whole-doc engine.
    intends(input: SkillAnalysisInput): boolean {
      return vocabId ? routeMatch(vocabId, input.question) : false
    },
    applies(input: SkillAnalysisInput): boolean {
      if (isSmallTalk(input.question)) return false
      return singleInScopeDocument(input.db, input.scope) !== null
    }
  }
}

// The bundled Tier-1 instruction skills. Each declares its engine in SKILL.md (`analysis: whole-doc` /
// `compare`) — a consistency test pins each registered handler's `mode` to that declaration — and the app
// registers these singletons so `getSkillAnalysisHandler(installId)` resolves them (a USER skill with the
// same field is served by `manifestAnalysisHandler` below, the SAME engine, minus the app-only PII scan).
// Each bundled instruction skill passes its canonical `vocabId` so `intends()` (the A4/SKA-8 W2
// count-mismatch routing predicate) is vocabulary-shaped against that skill's own routing terms.
export const meetingProtocolAnalysisHandler: SkillAnalysisHandler = makeWholeDocHandler('meeting-protocol')
export const contractBriefAnalysisHandler: SkillAnalysisHandler = makeWholeDocHandler('contract-brief')
// share-safe review's verdict is a PRIVACY gate — so its whole-doc turn additionally runs the
// deterministic PII detectors over the WHOLE document and injects their counts into the prompt, and gates
// the low-risk verdict on non-truncated coverage (U2, audit §3.5). This is APP behaviour (the detectors are
// app code), keyed to the app share-safe install id — a user whole-doc skill never gets it (SEC-1 posture).
export const shareSafeReviewAnalysisHandler: SkillAnalysisHandler = {
  ...makeWholeDocHandler('share-safe-review'),
  injectPiiScan: true
}
export const deadlineObligationAnalysisHandler: SkillAnalysisHandler = makeWholeDocHandler('deadline-obligation-finder')
export const whatChangedAnalysisHandler: SkillAnalysisHandler = makeCompareHandler('what-changed')

/**
 * A3 (audit §6.3/§8.2) — resolve the whole-document ANALYSIS ENGINE for a skill from its MANIFEST, so an
 * instruction skill of ANY source (not just the bundled ones with a registered handler) reaches the engine
 * it declares. Called by the chat path ONLY when no app handler is registered for the turn skill (the
 * bundled instruction skills keep their singletons above; the bank/invoice/redaction TOOL skills keep their
 * app-registered exhaustive/routing handlers — SEC-1). Honored only for `kind:'instruction'`; a tool skill's
 * whole-document behaviour is app-owned, never manifest-driven. Adds NO capability — it selects which
 * context the model reads, nothing else. Returns `undefined` when the skill declares no analysis engine.
 */
export function manifestAnalysisHandler(
  kind: SkillKind,
  analysis: SkillAnalysisMode | undefined
): SkillAnalysisHandler | undefined {
  if (kind !== 'instruction') return undefined
  if (analysis === 'whole-doc') return makeWholeDocHandler()
  if (analysis === 'compare') return makeCompareHandler()
  return undefined
}
