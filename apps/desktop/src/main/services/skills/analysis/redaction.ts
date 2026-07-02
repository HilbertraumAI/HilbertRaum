import { skillInstallId } from '../registry'
import { documentsInScope } from '../scope-documents'
import { routeMatch } from '../vocabulary'
import type {
  SkillAnalysisContext,
  SkillAnalysisHandler,
  SkillAnalysisInput,
  SkillAnalysisResult
} from './types'

// The document-redaction ROUTING handler (skills redaction-routing fix). Unlike bank-statement/invoice
// — which are `exhaustive` handlers that READ the whole document and synthesise a grounded answer —
// redaction is an ACTION skill: its one tool WRITES a redacted copy to a user-chosen path and is
// confirm-gated, so it must stay USER-INITIATED (the model never auto-runs it). On a redaction-shaped
// request over a selected document this handler therefore returns a short, localized answer that
// points the user at the skill's own run affordance (the "Redact personal data" button the SkillRunBar
// already offers) — instead of the old behaviour where the relevance path produced a top-k Q&A that
// (a) lectured/refused instead of acting and (b) stamped the misleading "based on the most relevant
// passages, NOT the whole document" badge, even though the tool reads the whole document.
//
// It reads NO content: `mode:'routing'` makes the chat path skip the fully-chunked refusal gate, and
// the result carries no citations/coverage, so no breadth badge is shown (the meter renders only for
// answers with citations). No model call, no tool run, no audit event — the run happens later, only
// when the user clicks the button and confirms the save.

/** The bundled redaction skill's install id (`"app:document-redaction"`) — the registry key. */
export const DOCUMENT_REDACTION_INSTALL_ID = skillInstallId('app', 'document-redaction')

// Redaction-shaped intent now reads the ONE canonical redaction vocabulary (W5, audit §3.2/§4.1): its
// `route|both` entries — the ACTION verbs + strong PII phrases (EN + DE) — word-boundary matched for single
// tokens (`schwärzen` never a compound). The informational-topic words `datenschutz`/`dsgvo`/`gdpr` are
// vocabulary `suggest`-only (they OFFER the skill but its tool WRITES a masked copy, so routing must not
// deflect "Was regelt die DSGVO?" to the button — the §4.4 manifest↔handler alignment is U4). Conservative:
// an OFF-TOPIC question with redaction active keeps the normal grounded path.
function isRedactionShaped(question: string): boolean {
  return routeMatch('document-redaction', question)
}

// The indexed, answerable documents in scope come from the ONE shared helper (X-1 / audit §4.6): the
// redaction handler reads the stored `chunks`, so it takes `requireChunks: true` — the same predicate
// the invoice/bank/whole-doc handlers use — instead of a private copy of the query.

export const documentRedactionAnalysisHandler: SkillAnalysisHandler = {
  mode: 'routing',

  applies(input: SkillAnalysisInput): boolean {
    // A redaction-shaped request with at least one selectable document in scope. The redaction tool
    // runs on a single selected document; the routing answer simply points at the button, so one or
    // more in-scope docs is enough (the run UI is per-document). With NO doc in scope there is
    // nothing to redact, so keep the normal path (the model asks the user to select a document).
    if (!isRedactionShaped(input.question)) return false
    return documentsInScope(input.db, input.scope, { requireChunks: true }).length >= 1
  },

  async run(ctx: SkillAnalysisContext): Promise<SkillAnalysisResult> {
    // Deterministic, localized, content-free copy (no model call, no content read). It names the
    // run button via the SAME catalog key the SkillRunBar uses, so the wording always matches the
    // affordance the user sees. No citations ⇒ no coverage badge. With MORE THAN ONE document in
    // scope (U-1) the single-doc tool targets one document, so the copy stays honest about that —
    // it tells the user to choose which document on the run button (the COUNT only, never a title).
    const button = ctx.tr('chat.skill.tool.redactDocument')
    const multiDoc = documentsInScope(ctx.db, ctx.scope, { requireChunks: true }).length > 1
    const answer = ctx.tr(multiDoc ? 'skills.redactionRouting.answerMulti' : 'skills.redactionRouting.answer', {
      button
    })
    return { answer, citations: [] }
  }
}
