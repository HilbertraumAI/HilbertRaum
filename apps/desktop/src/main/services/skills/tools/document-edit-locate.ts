import type { JsonSchema } from '../../../../shared/types'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../runtime'
import { stripThinkBlocks } from '../../chat'

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
// This module holds the runtime-touching half (the model call + windowing + reply parse). It is pure
// main-side TS otherwise — no fs/net/native (CLAUDE.md §0). The deterministic verify+splice lives in
// document-edit.ts so it stays runtime-free and unit-testable without a model.
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

/** Window sizing: line-numbered windows with overlap so an edit whose `find` straddles a window edge is
 *  seen whole in at least one window. Lines-based (not char-based) so line numbers stay stable + reportable.
 *  Kept identical to the redaction locate pass so the two share one mental model. */
export const EDIT_WINDOW_LINES = 40
export const EDIT_WINDOW_OVERLAP_LINES = 8

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
            find: { type: 'string', minLength: 1, maxLength: 200 },
            // The replacement (may be empty ⇒ a deletion). Bounded so one edit can't emit a document.
            replace: { type: 'string', minLength: 0, maxLength: 200 },
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

/** Number the given lines with their GLOBAL 1-based line number, tab-separated (`12\ttext`). The global
 *  numbering lets the model's reported line map to the whole document across windows. */
function numberWindow(lines: readonly string[], startLine: number): string {
  return lines.map((text, i) => `${startLine + i}\t${text}`).join('\n')
}

/** One overlapping window over the document's lines: the global start/end line (1-based, inclusive) and the
 *  line-numbered text to feed the model. */
export interface EditWindow {
  startLine: number
  endLine: number
  numbered: string
}

/**
 * Split `text` into overlapping, line-numbered windows (EDIT_WINDOW_LINES per window, stepping by
 * EDIT_WINDOW_LINES - EDIT_WINDOW_OVERLAP_LINES). The overlap means an edit whose `find` would straddle a
 * plain window boundary appears WHOLE in at least one window. Empty text ⇒ no windows.
 */
export function buildEditWindows(text: string): EditWindow[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  const step = Math.max(1, EDIT_WINDOW_LINES - EDIT_WINDOW_OVERLAP_LINES)
  const windows: EditWindow[] = []
  for (let start = 0; start < lines.length; start += step) {
    const slice = lines.slice(start, start + EDIT_WINDOW_LINES)
    windows.push({
      startLine: start + 1,
      endLine: start + slice.length,
      numbered: numberWindow(slice, start + 1)
    })
    if (start + EDIT_WINDOW_LINES >= lines.length) break // the last window reached the end
  }
  return windows
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
 *  occurrence defaults to 1; an empty `find` is dropped (there is nothing to anchor). */
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
    if (find.length === 0) continue
    const replace = typeof e.replace === 'string' ? e.replace : ''
    const line = typeof e.line === 'number' && Number.isInteger(e.line) && e.line >= 1 ? e.line : 1
    const occurrence =
      typeof e.occurrence === 'number' && Number.isInteger(e.occurrence) && e.occurrence >= 1 ? e.occurrence : 1
    out.push({ line, find, occurrence, replace })
  }
  return out
}

/**
 * Run the locate pass over the whole document: build overlapping line-numbered windows, ask the model
 * (grammar-constrained, temp 0) for the find→replace edits the instruction asks for in each, and collect
 * the proposals. This is LOCATE ONLY — the returned edits are UNVERIFIED proposals; the caller verifies
 * each `find` verbatim at its `{line, occurrence}` anchor and splices `replace` (`verifyAndSpliceEdits`).
 * The `instruction` (the user's edit request) rides into the system prompt; there is no default directive
 * (an edit with no instruction is meaningless — the seam refuses that before calling here).
 *
 * A single window's malformed reply is skipped (that window contributes no edit); an ABORT throws (the
 * seam maps it to a calm cancel). `onProgress` ticks per window.
 */
export async function locateDocumentEdits(
  text: string,
  instruction: string,
  deps: { runtime: ModelRuntime; signal: AbortSignal; onProgress?: (done: number, total: number) => void }
): Promise<LocatedEdit[]> {
  const system = buildEditSystemPrompt(instruction.trim())
  const windows = buildEditWindows(text)
  const found: LocatedEdit[] = []
  for (let i = 0; i < windows.length; i++) {
    if (deps.signal.aborted) throw new DOMException('Document edit locate cancelled', 'AbortError')
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: windows[i].numbered }
    ]
    const reply = await streamEditJson(messages, deps)
    if (reply !== null) found.push(...parseEditReply(reply))
    deps.onProgress?.(i + 1, windows.length)
  }
  return found
}
