import type { Db } from '../../db'
import type { RetrievalScope } from '../../../../shared/types'
import { buildScopeFilter } from '../../retrieval-scope'
import { skillInstallId } from '../registry'
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

// Redaction-shaped intent: the ACTION verbs + the strong PII phrases (EN + DE for the de-AT target).
// Conservative by design — when the active redaction skill is asked an OFF-TOPIC question, `applies()`
// is false and the turn keeps the normal grounded path (the rewritten SKILL.md body still steers the
// model toward the button). Bare, substring-ambiguous tokens are avoided. Matching is
// case-insensitive `question.includes(keyword)` (the suggestion-heuristic convention).
const REDACTION_KEYWORDS: readonly string[] = [
  'redact', 'redaction', 'anonymize', 'anonymise', 'anonymized', 'anonymised',
  'anonymisieren', 'anonymisierung', 'anonymisiere', 'pseudonymisieren',
  'schwärzen', 'schwärzung', 'schwärze', 'geschwärzt',
  'remove personal data', 'mask personal data', 'personenbezogene daten entfernen',
  'personenbezogene daten'
]

function isRedactionShaped(question: string): boolean {
  const q = question.toLowerCase()
  return REDACTION_KEYWORDS.some((k) => q.includes(k))
}

/** The indexed, answerable documents within a scope (mirrors invoice/bank `inScopeDocuments`). */
function inScopeDocuments(db: Db, scope: RetrievalScope): Array<{ id: string }> {
  const filter = buildScopeFilter(scope, 'd.id')
  const where = filter ? ` AND ${filter.sql}` : ''
  const params = filter ? filter.params : []
  return db
    .prepare(
      `SELECT d.id AS id FROM documents d
       WHERE d.status = 'indexed'
         AND EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id)${where}`
    )
    .all(...params) as Array<{ id: string }>
}

export const documentRedactionAnalysisHandler: SkillAnalysisHandler = {
  mode: 'routing',

  applies(input: SkillAnalysisInput): boolean {
    // A redaction-shaped request with at least one selectable document in scope. The redaction tool
    // runs on a single selected document; the routing answer simply points at the button, so one or
    // more in-scope docs is enough (the run UI is per-document). With NO doc in scope there is
    // nothing to redact, so keep the normal path (the model asks the user to select a document).
    if (!isRedactionShaped(input.question)) return false
    return inScopeDocuments(input.db, input.scope).length >= 1
  },

  async run(ctx: SkillAnalysisContext): Promise<SkillAnalysisResult> {
    // Deterministic, localized, content-free copy (no model call, no content read). It names the
    // run button via the SAME catalog key the SkillRunBar uses, so the wording always matches the
    // affordance the user sees. No citations ⇒ no coverage badge. With MORE THAN ONE document in
    // scope (U-1) the single-doc tool targets one document, so the copy stays honest about that —
    // it tells the user to choose which document on the run button (the COUNT only, never a title).
    const button = ctx.tr('chat.skill.tool.redactDocument')
    const multiDoc = inScopeDocuments(ctx.db, ctx.scope).length > 1
    const answer = ctx.tr(multiDoc ? 'skills.redactionRouting.answerMulti' : 'skills.redactionRouting.answer', {
      button
    })
    return { answer, citations: [] }
  }
}
