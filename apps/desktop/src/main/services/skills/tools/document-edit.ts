import type { DocumentChunkRead, JsonSchema, SkillTool, ToolResult } from '../../../../shared/types'
import { applySpans, locateOccurrences, type TransformSpan } from './span-transform'
import type { LocatedEdit } from './document-edit-locate'

// Document-edit Tier-2 tool (beta-feedback-2026-07 Phase 8, #23, D76; architecture.md "Skills — design
// record" §22). The verify+splice half of format-preserving targeted edits — kept HERE (runtime-free) so
// the model call lives only in `document-edit-locate.ts`. The model proposes occurrence-anchored
// find→replace edits; this code CONFIRMS each `find` verbatim at its anchor and SPLICES `replace`:
//   - VERIFY (D75): a proposed `find` that is not present verbatim at its `{line, occurrence}` anchor is
//     DROPPED (and counted). Hallucination is impossible — a substring that isn't literally there at that
//     anchor can't be replaced.
//   - PRECISION (D76): an edit replaces ONLY its anchored occurrence (unlike redaction, which sweeps ALL
//     occurrences of a confirmed string). This is what makes grammatical-agreement edits — der→die only
//     where it refers — expressible: the model emits one edit per occurrence it wants changed.
// Splicing is mechanical (span-transform's `applySpans`), so the output stays byte-identical outside the
// edited spans (D58) — the "diff-verifiable, unchanged elsewhere" acceptance criterion holds by construction.
//
// Pure main-side TS: no node:fs, no network, no native deps (CLAUDE.md §0). The tool's WHOLE reach is
// `ctx.readDocumentChunks` over the frozen selected-document scope. It produces the EDITED text + the
// applied/dropped counts; the orchestration seam (`run.ts`) does the confirm-gated, MAIN-side file write.
// It persists nothing itself — the gate stays content-free.
//
// PRIVACY: the find/replace strings and the edited text are CONTENT. They NEVER appear in any
// log/audit/run metadata — the tool returns only the edited text (written solely to the user-chosen file)
// plus the applied/dropped COUNTS (which are counts, not content, and are safe to surface).

// Re-export the located-edit shape so callers migrating to the shared vocabulary import it from one place.
export type { LocatedEdit } from './document-edit-locate'

/**
 * Verify each proposed edit's `find` verbatim at its `{line, occurrence}` anchor (D75) and build the
 * replacement span for that ONE occurrence (D76 precision — never a sweep). A proposal whose `find` is
 * not present at that anchor is dropped; an overlapping span that `applySpans` cannot place is also a drop.
 * The caller applies the returned spans; overlap resolution is deterministic (leftmost-longest wins,
 * the rest skipped) — a same-occurrence duplicate edit therefore drops rather than double-splicing.
 */
export function verifyAndSpliceEdits(
  text: string,
  edits: readonly LocatedEdit[]
): { text: string; applied: number; dropped: number; spans: TransformSpan[] } {
  const spans: TransformSpan[] = []
  let unverifiable = 0
  for (const e of edits) {
    // Anchored verify: the nth (1-based) occurrence of `find` on its line (D76). Empty ⇒ drop (D75).
    const occ = locateOccurrences(text, e.find, { line: e.line, nth: e.occurrence })
    if (occ.length === 0) {
      unverifiable++ // proposed but not present verbatim at its anchor ⇒ a hallucination / paraphrase (D75)
      continue
    }
    spans.push({ start: occ[0].start, length: occ[0].length, replacement: e.replace })
  }
  const result = applySpans(text, spans)
  // A span dropped by `applySpans` (it overlapped an already-applied edit) is a drop too — the change was
  // requested but could not be placed. `dropped` = unverifiable finds + overlap-skipped spans. `spans`
  // returns the APPLIED spans (Phase 9 — the DOCX writer distributes these across the `<w:t>` node map
  // instead of splicing the flat string; `applySpansToDocx(bytes, spans)` mirrors `result.text`).
  return {
    text: result.text,
    applied: result.applied.length,
    dropped: unverifiable + result.skipped.length,
    spans: result.applied
  }
}

export interface ApplyDocumentEditsOutput {
  /** The full document text with each verified edit's anchored occurrence spliced — byte-identical
   *  outside the edited spans (D58). */
  editedText: string
  /** How many edits were applied (counts only — never the find/replace values). */
  applied: number
  /** How many proposed edits were dropped as unverifiable (find not present at its anchor) or unplaceable
   *  (overlapping an already-applied edit) — surfaced honestly (D78). */
  dropped: number
  /** The total number of edits the seam handed in (applied + dropped == totalEdits by construction). */
  totalEdits: number
}

const APPLY_EDITS_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['editedText', 'applied', 'dropped', 'totalEdits'],
  properties: {
    editedText: { type: 'string' },
    applied: { type: 'integer', minimum: 0 },
    dropped: { type: 'integer', minimum: 0 },
    totalEdits: { type: 'integer', minimum: 0 }
  }
}

/**
 * `apply_document_edits` (Phase 8) — read the selected document's page-addressable chunks via the narrow
 * `ctx.readDocumentChunks`, verify + splice the seam-located edits (`verifyAndSpliceEdits`), and return
 * the edited text + applied/dropped counts. It writes nothing itself; the `run.ts` seam does the
 * confirm-gated, MAIN-side, user-chosen file write. It declares `export-file`, so the gate requires the
 * user's confirmation before it runs. A wrong-shape result fails the run at the gate.
 *
 * The model NEVER reaches this tool — only its VERIFIED-SHAPE proposals do, as structured `edits` input
 * (which `runSkillTool` never logs/audits). `edits` empty ⇒ nothing to apply (applied 0), which is how the
 * seam surfaces a "no matching text" run.
 */
export const applyDocumentEditsTool: SkillTool = {
  name: 'apply_document_edits',
  description:
    'Read the selected document and produce a copy with the exact find-and-replace edits you asked for applied — only where the text is found verbatim, everything else byte-identical. Requires your confirmation; you choose where the file is written.',
  permissions: ['read-selected-docs', 'export-file'],
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['documentId'],
    // `edits` (Phase 8, D76) are the LLM-LOCATED occurrence-anchored find→replace pairs the seam's locate
    // pass proposed — the tool VERIFIES each `find` verbatim at its anchor and splices `replace`; the model
    // never generates output text. Omitted / empty ⇒ no changes (the seam's "no matching text" path).
    properties: {
      documentId: { type: 'string', minLength: 1 },
      edits: {
        type: 'array',
        maxItems: 4096,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['line', 'find', 'occurrence', 'replace'],
          properties: {
            find: { type: 'string', minLength: 1, maxLength: 200 },
            replace: { type: 'string', minLength: 0, maxLength: 200 },
            line: { type: 'integer', minimum: 1 },
            occurrence: { type: 'integer', minimum: 1 }
          }
        }
      }
    }
  },
  outputSchema: APPLY_EDITS_OUTPUT_SCHEMA,
  async run(input, ctx): Promise<ToolResult> {
    if (ctx.signal.aborted) return { ok: false, error: 'This action was cancelled.' }
    const { documentId, edits } = input as { documentId: string; edits?: LocatedEdit[] }
    let chunks: DocumentChunkRead[]
    try {
      chunks = ctx.readDocumentChunks(documentId)
    } catch {
      // Out-of-scope / unreadable — friendly + content-free; the technical reason is the seam's log.
      return { ok: false, error: 'This document could not be read.' }
    }
    const joined = chunks.map((c) => c.text).join('\n')
    const list = edits ?? []
    const { text, applied, dropped } = verifyAndSpliceEdits(joined, list)
    ctx.onProgress?.({ done: chunks.length, total: chunks.length })
    const output: ApplyDocumentEditsOutput = {
      editedText: text,
      applied,
      dropped,
      totalEdits: list.length
    }
    return { ok: true, output }
  }
}
