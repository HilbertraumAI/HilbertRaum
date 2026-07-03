import type { Db } from '../../db'
import type { RetrievalScope } from '../../../../shared/types'
import type { SkillAnalysisMode, SkillKind } from '../../../../shared/skill-manifest'
import { documentsInScope } from '../scope-documents'
import { skillInstallId } from '../registry'
import { isSmallTalk } from '../vocabulary'
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
// active over a matching fully-chunked scope — it is no longer gated on the question matching a per-skill,
// per-language keyword list (the recurring incident class: every phrasing gap silently degraded a
// whole-document ask to top-k-with-fence). The shape gate SHRANK to ONE skill-agnostic opt-out: `intends`
// is `!isSmallTalk(question)` — anything that is not clearly off-topic chatter (a greeting / thanks /
// assistant-meta) intends the engine, regardless of phrasing. The needle-vs-deliverable classification (the
// other half of §8.2) lives in the chat path, where W1's truncation calculus can decide whether a NEEDLE
// ask over an over-budget doc is better served by top-k. Conservative still: a multi-document scope fails
// the count precondition (`applies()` false → W2 narrows/routes); Wave-2 whole-doc is single-document, and
// multi-doc compare stays on the `compare` engine (`what-changed`).
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

/** Build a `grounded-whole-doc-compare` handler (A3-inverted gate): applies on ANY non-small-talk question
 *  over EXACTLY TWO in-scope documents. No `run()` — the chat path streams a model answer over BOTH
 *  documents read whole (budget split across the two). Skill-agnostic (no per-skill vocabulary). */
function makeCompareHandler(): SkillAnalysisHandler {
  return {
    mode: 'grounded-whole-doc-compare',
    // Doc-count-agnostic intent (W2, §2.1 + A3 §8.2): any question that is not off-topic chatter, regardless
    // of how many docs are in scope. When `applies()` fails only on the count (≠2), the chat path emits the
    // deterministic "select exactly two documents" routing answer instead of falling through silently.
    intends(input: SkillAnalysisInput): boolean {
      return !isSmallTalk(input.question)
    },
    applies(input: SkillAnalysisInput): boolean {
      if (isSmallTalk(input.question)) return false
      return exactlyTwoInScopeDocuments(input.db, input.scope)
    }
  }
}

/** Build a `grounded-whole-doc` handler (A3-inverted gate): applies on ANY non-small-talk question over a
 *  single in-scope document. No `run()` — the chat path streams the model answer over the whole document
 *  directly. Skill-agnostic: the same factory serves the bundled instruction skills AND a user-imported
 *  skill declaring `analysis: whole-doc` (`manifestAnalysisHandler`). */
function makeWholeDocHandler(): SkillAnalysisHandler {
  return {
    mode: 'grounded-whole-doc',
    // Doc-count-agnostic intent (W2, §2.1 + A3 §8.2): any non-chatter question, regardless of how many docs
    // are in scope. When `applies()` fails only on the count, the chat path narrows to the skill's best-
    // matching document (with an honest scope notice) or routes, instead of falling through silently.
    intends(input: SkillAnalysisInput): boolean {
      return !isSmallTalk(input.question)
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
export const meetingProtocolAnalysisHandler: SkillAnalysisHandler = makeWholeDocHandler()
export const contractBriefAnalysisHandler: SkillAnalysisHandler = makeWholeDocHandler()
// share-safe review's verdict is a PRIVACY gate — so its whole-doc turn additionally runs the
// deterministic PII detectors over the WHOLE document and injects their counts into the prompt, and gates
// the low-risk verdict on non-truncated coverage (U2, audit §3.5). This is APP behaviour (the detectors are
// app code), keyed to the app share-safe install id — a user whole-doc skill never gets it (SEC-1 posture).
export const shareSafeReviewAnalysisHandler: SkillAnalysisHandler = {
  ...makeWholeDocHandler(),
  injectPiiScan: true
}
export const deadlineObligationAnalysisHandler: SkillAnalysisHandler = makeWholeDocHandler()
export const whatChangedAnalysisHandler: SkillAnalysisHandler = makeCompareHandler()

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
