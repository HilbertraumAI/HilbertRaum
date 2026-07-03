import { skillInstallId } from '../registry'
import { documentsInScope } from '../scope-documents'
import { routeMatch } from '../vocabulary'
import { scanRedactionCandidates } from '../tools/redaction'
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
// It reads NO content on the ACTION path: `mode:'routing'` makes the chat path skip the fully-chunked
// refusal gate, and the result carries no citations/coverage, so no breadth badge is shown (the meter
// renders only for answers with citations). No model call, no tool run, no audit event — the run happens
// later, only when the user clicks the button and confirms the save.
//
// U2 dry-run (audit §3.4): an INFORMATIONAL ask ("welche personenbezogenen Daten enthält das Dokument?",
// "what personal data is in here?") — which the deterministic detectors CAN answer — no longer gets the
// button deflection. The handler runs the same offline detectors the tool would (`scanRedactionCandidates`)
// over the single in-scope document and reports the per-category COUNTS only ("a whole-document scan found
// N e-mails, M IBANs…"), never a detected value (§6 content boundary). Still no model call, no tool run,
// no audit event, no file write — just a read-only count. An ACTION ask (redact/anonymize/schwärzen) keeps
// the button deflection (the write tool stays user-initiated).

/** The bundled redaction skill's install id (`"app:document-redaction"`) — the registry key. */
export const DOCUMENT_REDACTION_INSTALL_ID = skillInstallId('app', 'document-redaction')

// Redaction-shaped intent now reads the ONE canonical redaction vocabulary (W5, audit §3.2/§4.1): its
// `route|both` entries — the ACTION verbs + strong PII phrases (EN + DE) — word-boundary matched for single
// tokens (`schwärzen` never a compound). U4/§4.4 completed the manifest↔handler alignment: the pure legal
// words `datenschutz`/`dsgvo`/`gdpr` are GONE from the redaction vocabulary (the handler acts on neither
// `routeMatch` nor the informational `PII_TOPIC_RE` for them — "Was regelt die DSGVO?" is about the LAW, not
// the document), so redaction no longer suggests OR auto-fires on them. Conservative: an OFF-TOPIC question
// with redaction active keeps the normal grounded path.
function isRedactionShaped(question: string): boolean {
  return routeMatch('document-redaction', question)
}

// A PII-CONTENT topic (EN + DE, declension-tolerant): the subject of an informational "what personal
// data is in here?" ask. Deliberately does NOT include the general legal/topic words `datenschutz`/`dsgvo`/
// `gdpr` — "Was regelt die DSGVO?" is a question about the LAW, not about the document, and must not be
// deflected/answered as a document scan (audit §4.4). Matched under an already-active redaction skill only.
const PII_TOPIC_RE =
  /personenbezog\w*|persönliche daten|\bpersonal data\b|\bpii\b|sensitive (data|information)|sensible daten/i

// An explicit ACTION request ("do the masking") — the WRITE-tool verbs. When present the handler keeps the
// button deflection (the confirm-gated write stays user-initiated); when ABSENT and the question is a PII
// topic, it is informational ⇒ the read-only dry-run.
const REDACT_ACTION_RE =
  /\b(redact|redaction|anonymi[sz]\w*|pseudonymi[sz]\w*|mask)\b|schwärz\w*|geschwärzt|\bentfern\w*|\bremove\b/i

/** An informational PII ask ("welche personenbezogenen Daten…", "what personal data…") — a PII topic with
 *  NO redaction action verb. This is the dry-run trigger; a request carrying an action verb is NOT. */
function isInformationalPiiQuestion(question: string): boolean {
  return PII_TOPIC_RE.test(question) && !REDACT_ACTION_RE.test(question)
}

// The indexed, answerable documents in scope come from the ONE shared helper (X-1 / audit §4.6): the
// redaction handler reads the stored `chunks`, so it takes `requireChunks: true` — the same predicate
// the invoice/bank/whole-doc handlers use — instead of a private copy of the query.

/** The whole document's text for the offline dry-run scan: the faithful newline-preserving parser
 *  segments (`readDocumentSegments`, injected by the IPC — the SAME reader the redaction run uses), or a
 *  direct ordered read of the stored chunks when no segment reader is supplied (the unit tests). Null on
 *  any read failure — the caller then falls back to the button deflection. */
async function readWholeDocumentText(ctx: SkillAnalysisContext, documentId: string): Promise<string | null> {
  try {
    if (ctx.readDocumentSegments) {
      const segments = await ctx.readDocumentSegments(documentId)
      return segments.map((s) => s.text).join('\n')
    }
    const rows = ctx.db
      .prepare('SELECT text FROM chunks WHERE document_id = ? ORDER BY chunk_index')
      .all(documentId) as Array<{ text: string }>
    return rows.map((r) => r.text).join('\n')
  } catch {
    return null
  }
}

export const documentRedactionAnalysisHandler: SkillAnalysisHandler = {
  mode: 'routing',

  applies(input: SkillAnalysisInput): boolean {
    // A redaction-shaped request OR an informational PII ask (U2 dry-run, §3.4), with at least one
    // selectable document in scope. The redaction tool runs on a single selected document; the routing/
    // dry-run answer simply points at the button (or reports counts), so one or more in-scope docs is
    // enough. With NO doc in scope there is nothing to redact/scan, so keep the normal path.
    if (!isRedactionShaped(input.question) && !isInformationalPiiQuestion(input.question)) return false
    return documentsInScope(input.db, input.scope, { requireChunks: true }).length >= 1
  },

  async run(ctx: SkillAnalysisContext): Promise<SkillAnalysisResult> {
    // Deterministic, localized copy (no model call). It names the run button via the SAME catalog key the
    // SkillRunBar uses, so the wording always matches the affordance the user sees. No citations ⇒ no
    // coverage badge.
    const button = ctx.tr('chat.skill.tool.redactDocument')
    const inScope = documentsInScope(ctx.db, ctx.scope, { requireChunks: true })

    // U2 dry-run (§3.4): an INFORMATIONAL PII ask over exactly ONE in-scope document gets the offline
    // per-category counts — the deterministic detectors CAN answer "what personal data is in here?". Counts
    // ONLY (never a detected value, §6). An action ask, a multi-doc scope (which document?), or an
    // unreadable document falls through to the button deflection below.
    if (isInformationalPiiQuestion(ctx.question) && inScope.length === 1) {
      const text = await readWholeDocumentText(ctx, inScope[0].id)
      if (text !== null) {
        const counts = scanRedactionCandidates(text)
        const answer = ctx.tr('skills.redactionRouting.scan', {
          button,
          email: counts.email,
          phone: counts.phone,
          iban: counts.iban,
          card: counts.card,
          date: counts.date,
          url: counts.url
        })
        return { answer, citations: [] }
      }
    }

    // Button deflection. With MORE THAN ONE document in scope (U-1) the single-doc tool targets one
    // document, so the copy stays honest about that — it tells the user to choose which document on the
    // run button (the COUNT only, never a title).
    const multiDoc = inScope.length > 1
    const answer = ctx.tr(multiDoc ? 'skills.redactionRouting.answerMulti' : 'skills.redactionRouting.answer', {
      button
    })
    return { answer, citations: [] }
  }
}
