import { skillInstallId } from '../registry'
import { documentsInScope } from '../scope-documents'
import { routeMatch } from '../vocabulary'
import type {
  SkillAnalysisContext,
  SkillAnalysisHandler,
  SkillAnalysisInput,
  SkillAnalysisResult
} from './types'

// The document-edit ROUTING handler (beta-feedback-2026-07 Phase 8, #23, D76). Like document-redaction
// (§21 routing handler) — and UNLIKE the exhaustive bank/invoice handlers — document-edit is an ACTION
// skill: its one tool WRITES an edited copy to a user-chosen path and is confirm-gated, so it must stay
// USER-INITIATED (a chat ask never silently rewrites the document — the #23 failure mode). On an
// edit-shaped request over a selected document this handler returns a short, localized answer that points
// the user at the skill's own run affordance (the "Apply text edits" button the SkillRunBar offers) —
// instead of the generic chat path REGENERATING the prose (which hallucinates, #23). The chat path's
// whole-document regeneration is NOT removed; this only surfaces the tool when the ask is edit-shaped.
//
// It reads NO content: `mode:'routing'` makes the chat path skip the fully-chunked refusal gate, and the
// result carries no citations/coverage, so no breadth badge is shown. No model call, no tool run, no audit
// event — the run happens later, only when the user clicks the button and confirms the save (which then
// runs the locate→verify→splice pipeline, `runDocumentEdit`).

/** The bundled document-edit skill's install id (`"app:document-edit"`) — the registry key. */
export const DOCUMENT_EDIT_INSTALL_ID = skillInstallId('app', 'document-edit')

// An edit-shaped ask reads the ONE canonical document-edit vocabulary (its `route|both` entries — the
// find-and-replace phrases + edit verbs, EN + DE — word-boundary matched for single tokens). `routeMatch`
// is compile-guarded to the skill id, so a mis-wired handler is a COMPILE error (the vocabulary-drift guard).
function isEditShaped(question: string): boolean {
  return routeMatch('document-edit', question)
}

export const documentEditAnalysisHandler: SkillAnalysisHandler = {
  mode: 'routing',

  applies(input: SkillAnalysisInput): boolean {
    // An edit-shaped request with at least one selectable document in scope. The edit tool runs on a single
    // selected document; the routing answer simply points at the button, so one or more in-scope docs is
    // enough. With NO doc in scope there is nothing to edit, so keep the normal path.
    if (!isEditShaped(input.question)) return false
    return documentsInScope(input.db, input.scope, { requireChunks: true }).length >= 1
  },

  async run(ctx: SkillAnalysisContext): Promise<SkillAnalysisResult> {
    // Deterministic, localized copy (no model call). It names the run button via the SAME catalog key the
    // SkillRunBar uses, so the wording always matches the affordance the user sees. No citations ⇒ no
    // coverage badge. With MORE THAN ONE document in scope the single-doc tool targets one document, so the
    // copy stays honest about that — it tells the user to choose which document on the run button.
    const button = ctx.tr('chat.skill.tool.applyDocumentEdits')
    const multiDoc = documentsInScope(ctx.db, ctx.scope, { requireChunks: true }).length > 1
    const answer = ctx.tr(multiDoc ? 'skills.editRouting.answerMulti' : 'skills.editRouting.answer', { button })
    return { answer, citations: [] }
  }
}
