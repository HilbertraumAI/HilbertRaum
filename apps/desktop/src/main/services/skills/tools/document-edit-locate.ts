import type { JsonSchema } from '../../../../shared/types'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../runtime'
import { stripThinkBlocks } from '../../chat'
import { buildLocateWindows } from './locate-windows'

// LLM locate pass for format-preserving TARGETED EDITS (beta-feedback-2026-07 Phase 8, decision D76;
// architecture.md "Skills — design record" §22, beside the §20 span engine + §21 redaction locate). The
// local model ONLY LOCATES occurrence-anchored find→replace edits — it never regenerates the document
// (D73). It reads line-numbered document text in overlapping windows under a grammar-constrained JSON
// schema (D55) at temperature 0, and returns a list of proposed edits `{ line, find, occurrence, replace }`.
// The app then VERIFIES each `find` verbatim at its `{line, occurrence}` anchor and SPLICES the `replace`
// mechanically (`verifyAndSpliceEdits` in document-edit.ts, via span-transform's `locateOccurrences` +
// `applySpans`), so:
//   - hallucination is STRUCTURALLY impossible: the output is source bytes everywhere outside a verified
//     span, and a proposed `find` that is not present verbatim at its anchor is DROPPED (and counted);
//   - agreement edits are expressible: because an edit is anchored to ONE occurrence (D76 precision, unlike
//     redaction's every-occurrence sweep), "der → die only where it refers to X" is one edit per occurrence.
//
// This module holds the runtime-touching half (the model call + reply parse; the windows come from
// locate-windows.ts, shared with the redaction pass). It is pure main-side TS otherwise — no
// fs/net/native (CLAUDE.md §0). The deterministic verify+splice lives in document-edit.ts so it stays
// runtime-free and unit-testable without a model.
//
// PRIVACY: the proposed find/replace strings are CONTENT. They stay in-process (the seam hands them to the
// pure tool as structured input, which `runSkillTool` never logs/audits) and NEVER reach a log, the audit
// stream, `skill_runs`, or an error message — the same content boundary as every other skill seam.

/** One model-proposed edit: the verbatim substring to find, its 1-based line, which occurrence on that
 *  line (1-based), and the exact replacement text. The app verifies `find` at `{line, occurrence}` and
 *  splices `replace`; a proposal that does not match verbatim there is dropped. */
export interface LocatedEdit {
  line: number
  find: string
  occurrence: number
  replace: string
}

/** Global cap on UNIQUE collected proposals (#134) — equals the `apply_document_edits` schema's `edits`
 *  maxItems (the tool gate's hard input bound), so the seam can never hand the gate an overflowing list
 *  after the full locate pass. The schema cites this constant; keep the two in lockstep. */
export const MAX_LOCATED_EDITS = 4096

/** The `find` / `replace` maxLength (UTF-16 units) of the locate grammar and the `apply_document_edits`
 *  schema, which cites it. `parseEditReply` re-checks it (#583): the grammar may bound code points instead. */
export const MAX_LOCATED_EDIT_CHARS = 200

/** Per-window generation ceiling (tokens) — enough for a JSON list of the edits a 40-line window can
 *  plausibly hold. The char cap (below) is the runaway backstop. */
const EDIT_MAX_TOKENS = 768
/** Char cap multiplier — the same runaway-runtime bound the redaction locate + the enricher use (audit L-2). */
const OUTPUT_CHAR_CAP_PER_TOKEN = 8

/**
 * The grammar contract (D55) for one window's locate reply: a list of edits, each a verbatim `find`
 * substring, its 1-based line + 1-based occurrence-on-that-line, and the `replace` text. The model cannot
 * emit an off-schema token; the mock runtime IGNORES the schema, so `parseEditReply` re-validates in code.
 */
export function editLocateSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['edits'],
    properties: {
      edits: {
        type: 'array',
        maxItems: 256,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['line', 'find', 'occurrence', 'replace'],
          properties: {
            // `find` is a short run of source text — a word/phrase, not a paragraph.
            find: { type: 'string', minLength: 1, maxLength: MAX_LOCATED_EDIT_CHARS },
            // The replacement (may be empty ⇒ a deletion). Bounded so one edit can't emit a document.
            replace: { type: 'string', minLength: 0, maxLength: MAX_LOCATED_EDIT_CHARS },
            line: { type: 'integer', minimum: 1 },
            occurrence: { type: 'integer', minimum: 1 }
          }
        }
      }
    }
  }
}

function buildEditSystemPrompt(instruction: string): string {
  return [
    'You LOCATE the exact find-and-replace edits a user asked for, so an app can splice them in. You never',
    'rewrite or output the document — you only report which exact substrings to change and where.',
    'The change the user wants:',
    instruction,
    '',
    'For every place that must change, return an object with:',
    '  - find: the EXACT substring from the document to replace, copied character-for-character (so the',
    '    app can find it). Do not paraphrase, translate, re-case, or trim punctuation differently.',
    '  - replace: the EXACT replacement text (use an empty string to delete).',
    '  - line: the 1-based line number (shown as "N\\t…") the substring is on.',
    '  - occurrence: which occurrence of `find` on that line to change (1 = the first, 2 = the second, …).',
    'Report ONE edit per occurrence you want changed — this is how grammatical agreements (change der→die',
    'only where it refers) are expressed precisely. Do not report a place that should stay unchanged. When a',
    'line needs no change, return no edit for it. Reply with JSON only.'
  ].join('\n')
}

/** Stream a grammar-constrained JSON reply (temp 0), or null on a runaway reply. Aborts propagate as an
 *  AbortError so the seam maps them to a calm cancel (mirrors the redaction locate surface). */
async function streamEditJson(
  messages: ChatMessage[],
  deps: { runtime: ModelRuntime; signal: AbortSignal }
): Promise<string | null> {
  let text = ''
  const charCap = EDIT_MAX_TOKENS * OUTPUT_CHAR_CAP_PER_TOKEN
  const options: RuntimeChatOptions = {
    signal: deps.signal,
    maxTokens: EDIT_MAX_TOKENS,
    temperature: 0,
    responseSchema: editLocateSchema(),
    responseSchemaName: 'document_edits'
  }
  for await (const token of deps.runtime.chatStream(messages, options)) {
    if (deps.signal.aborted) throw new DOMException('Document edit locate cancelled', 'AbortError')
    text += token
    if (text.length > charCap) return null
  }
  if (deps.signal.aborted) throw new DOMException('Document edit locate cancelled', 'AbortError')
  return text
}

/** Parse + in-code re-validate one window's reply into edits (the mock runtime ignores the schema). A
 *  malformed reply ⇒ [] (that window contributes nothing — never a hard fail). A missing/invalid line or
 *  occurrence defaults to 1; an empty `find` is dropped (there is nothing to anchor). An over-long `find` or
 *  `replace` is dropped, never clipped: a clipped `find` splices the wrong text, and one over-long edit would
 *  make the gate refuse them all (#583). */
export function parseEditReply(text: string): LocatedEdit[] {
  let parsed: { edits?: unknown }
  try {
    parsed = JSON.parse(stripThinkBlocks(text).trim()) as { edits?: unknown }
  } catch {
    return []
  }
  const raw = Array.isArray(parsed.edits) ? parsed.edits : []
  const out: LocatedEdit[] = []
  for (const e of raw as Array<{ line?: unknown; find?: unknown; occurrence?: unknown; replace?: unknown }>) {
    const find = typeof e.find === 'string' ? e.find : ''
    if (find.length === 0 || find.length > MAX_LOCATED_EDIT_CHARS) continue
    const replace = typeof e.replace === 'string' ? e.replace : ''
    if (replace.length > MAX_LOCATED_EDIT_CHARS) continue
    const line = typeof e.line === 'number' && Number.isInteger(e.line) && e.line >= 1 ? e.line : 1
    const occurrence =
      typeof e.occurrence === 'number' && Number.isInteger(e.occurrence) && e.occurrence >= 1 ? e.occurrence : 1
    out.push({ line, find, occurrence, replace })
  }
  return out
}

/** The locate pass result (#134): the UNIQUE proposals (capped at MAX_LOCATED_EDITS) plus an honest
 *  truncation flag — true when the cap dropped proposals or cut the window walk short. */
export interface LocateEditsResult {
  edits: LocatedEdit[]
  truncated: boolean
}

/**
 * Run the locate pass over the whole document: build overlapping line-numbered windows, ask the model
 * (grammar-constrained, temp 0) for the find→replace edits the instruction asks for in each, and collect
 * the proposals. This is LOCATE ONLY — the returned edits are UNVERIFIED proposals; the caller verifies
 * each `find` verbatim at its `{line, occurrence}` anchor and splices `replace` (`verifyAndSpliceEdits`).
 * The `instruction` (the user's edit request) rides into the system prompt; there is no default directive
 * (an edit with no instruction is meaningless — the seam refuses that before calling here).
 *
 * Collection discipline (#134): proposals de-duplicate on their `{line, find, occurrence}` ANCHOR (the
 * 8-line window overlap re-proposes boundary edits; a same-anchor duplicate would be dropped by the
 * splice's overlap rule anyway — `replace` is deliberately NOT part of the key, so a same-anchor
 * conflict resolves to the FIRST proposal, matching the splice's first-wins discipline), and the unique
 * list is capped at MAX_LOCATED_EDITS (== the tool schema's `edits` maxItems, so the gate can never
 * refuse the seam's input). A full cap stops the window walk early and reports `truncated`.
 *
 * A single window's malformed reply is skipped (that window contributes no edit); an ABORT throws (the
 * seam maps it to a calm cancel). `onProgress` ticks per window.
 */
export async function locateDocumentEdits(
  text: string,
  instruction: string,
  deps: { runtime: ModelRuntime; signal: AbortSignal; onProgress?: (done: number, total: number) => void }
): Promise<LocateEditsResult> {
  const system = buildEditSystemPrompt(instruction.trim())
  const windows = buildLocateWindows(text)
  const found: LocatedEdit[] = []
  const seen = new Set<string>()
  let truncated = false
  for (let i = 0; i < windows.length; i++) {
    if (deps.signal.aborted) throw new DOMException('Document edit locate cancelled', 'AbortError')
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: windows[i].numbered }
    ]
    const reply = await streamEditJson(messages, deps)
    if (reply !== null) {
      for (const e of parseEditReply(reply)) {
        const key = `${e.line}\u0000${e.find}\u0000${e.occurrence}`
        if (seen.has(key)) continue // the same anchor again — the splice would drop it as an overlap
        if (found.length >= MAX_LOCATED_EDITS) {
          truncated = true
          break
        }
        seen.add(key)
        found.push(e)
      }
    }
    deps.onProgress?.(i + 1, windows.length)
    if (found.length >= MAX_LOCATED_EDITS && i + 1 < windows.length) {
      // The cap is full and windows remain: stop paying for locate calls whose proposals could only be
      // dropped, and report the walk as truncated.
      truncated = true
      break
    }
  }
  return { edits: found, truncated }
}
