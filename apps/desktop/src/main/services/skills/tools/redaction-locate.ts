import type { JsonSchema } from '../../../../shared/types'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../runtime'
import { stripThinkBlocks } from '../../chat'

// LLM locate pass for document redaction v2 (beta-feedback-2026-07 Phase 7, decisions D73/D75/D78;
// architecture.md "Skills — design record" §21, beside the §20 span-transform engine). The local model
// ONLY LOCATES spans — it never generates output text (D73). It reads line-numbered document text in
// overlapping windows under a grammar-constrained JSON schema (D55) at temperature 0, and returns a list
// of proposed entities `{ text, category, line }`. The app then VERIFIES each proposed string verbatim
// against the source and SWEEPS all its occurrences mechanically (`verifyAndSweepEntities` in
// redaction.ts, via span-transform's `locateOccurrences` + `applySpans`), so:
//   - hallucination is STRUCTURALLY impossible: the output is source bytes everywhere outside a verified
//     span, and a proposed string that is not present verbatim is DROPPED (and counted as dropped);
//   - misses shrink: the model contributes JUDGEMENT (names/addresses the deterministic regex floor
//     cannot detect), and the sweep turns one confirmation into every-occurrence coverage (D75).
//
// This module holds the runtime-touching half (the model call + windowing + reply parse). It is pure
// main-side TS otherwise — no fs/net/native (CLAUDE.md §0). The deterministic verify+sweep lives in
// redaction.ts so it stays runtime-free and unit-testable without a model.
//
// PRIVACY: the proposed entity strings are CONTENT. They stay in-process (the seam hands them to the
// pure tool as structured input, which `runSkillTool` never logs/audits) and NEVER reach a log, the
// audit stream, `skill_runs`, or an error message — same content boundary as every other skill seam.

/** The FIXED category set the locate schema constrains the model to. The user's instruction can only
 *  widen/narrow what the model PROPOSES within these — the app never interprets prose (D73). */
export type LocateCategory = 'name' | 'address' | 'org' | 'other'
export const LOCATE_CATEGORIES: readonly LocateCategory[] = ['name', 'address', 'org', 'other']

/** One model-proposed entity: the verbatim span text, its category, and the 1-based line it sits on
 *  (a soft anchor — the app sweeps ALL verbatim occurrences document-wide, so a windowing-offset line
 *  never loses an entity; the field aids the verify heuristic and the schema shape). */
export interface LocatedEntity {
  text: string
  category: LocateCategory
  line: number
}

/** The default scoping directive when the caller supplies no instruction: the legal-vertical baseline
 *  (#22 — names + addresses + organisations). A user instruction ("…, keep city names") replaces it. */
export const DEFAULT_LOCATE_DIRECTIVE =
  'Personal names, postal and street addresses, and organisation names.'

/** Window sizing: line-numbered windows with overlap so an entity straddling a window edge is seen
 *  whole in at least one window. Lines-based (not char-based) so line numbers stay stable + reportable. */
export const LOCATE_WINDOW_LINES = 40
export const LOCATE_WINDOW_OVERLAP_LINES = 8

/** Per-window generation ceiling (tokens) — enough for a JSON list of the entities a 40-line window
 *  can plausibly hold. The char cap (below) is the runaway backstop the categorizer/enricher use. */
const LOCATE_MAX_TOKENS = 768
/** Char cap multiplier — the same runaway-runtime bound the enricher uses (audit L-2). */
const OUTPUT_CHAR_CAP_PER_TOKEN = 8

/**
 * The grammar contract (D55) for one window's locate reply: a list of entities, each a short verbatim
 * span, a fixed-enum category, and a 1-based line. The model cannot emit an off-schema token; the mock
 * runtime IGNORES the schema, so `parseLocateReply` re-validates every field in code.
 */
export function entityLocateSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['entities'],
    properties: {
      entities: {
        type: 'array',
        maxItems: 128,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'category', 'line'],
          properties: {
            // A span is a short run of source text — a name/address/org, not a paragraph.
            text: { type: 'string', minLength: 1, maxLength: 160 },
            category: { type: 'string', enum: [...LOCATE_CATEGORIES] },
            line: { type: 'integer', minimum: 1 }
          }
        }
      }
    }
  }
}

function buildLocateSystemPrompt(directive: string): string {
  return [
    'You LOCATE sensitive spans in a document so an app can mask them. You never rewrite or output the',
    'document — you only report the exact substrings to mask and where they are.',
    'Mask, per the user scope below:',
    directive,
    '',
    'For every span you find, return an object with:',
    '  - text: the EXACT substring from the document, copied character-for-character (so the app can',
    '    find it). Do not paraphrase, translate, re-case, or trim punctuation differently.',
    '  - category: one of name, address, org, other.',
    '  - line: the 1-based line number (shown as "N\\t…") the span is on.',
    'Report only spans the scope asks for. If the scope says to KEEP something (e.g. city names), do not',
    'report it. When a line has nothing to mask, return no entity for it. Reply with JSON only.'
  ].join('\n')
}

/** Number the given lines with their GLOBAL 1-based line number, tab-separated (`12\ttext`). The
 *  global numbering lets the model's reported line map to the whole document across windows. */
function numberWindow(lines: readonly string[], startLine: number): string {
  return lines.map((text, i) => `${startLine + i}\t${text}`).join('\n')
}

/** One overlapping window over the document's lines: the global start/end line (1-based, inclusive)
 *  and the line-numbered text to feed the model. */
export interface LocateWindow {
  startLine: number
  endLine: number
  numbered: string
}

/**
 * Split `text` into overlapping, line-numbered windows (LOCATE_WINDOW_LINES per window, stepping by
 * LOCATE_WINDOW_LINES - LOCATE_WINDOW_OVERLAP_LINES). The overlap means an entity that would straddle
 * a plain window boundary appears WHOLE in at least one window. Empty text ⇒ no windows.
 */
export function buildLocateWindows(text: string): LocateWindow[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  const step = Math.max(1, LOCATE_WINDOW_LINES - LOCATE_WINDOW_OVERLAP_LINES)
  const windows: LocateWindow[] = []
  for (let start = 0; start < lines.length; start += step) {
    const slice = lines.slice(start, start + LOCATE_WINDOW_LINES)
    windows.push({
      startLine: start + 1,
      endLine: start + slice.length,
      numbered: numberWindow(slice, start + 1)
    })
    if (start + LOCATE_WINDOW_LINES >= lines.length) break // the last window reached the end
  }
  return windows
}

/** Stream a grammar-constrained JSON reply (temp 0), or null on a runaway reply. Aborts propagate as an
 *  AbortError so the seam maps them to a calm cancel (mirrors the enricher/categorizer surfaces). */
async function streamLocateJson(
  messages: ChatMessage[],
  deps: { runtime: ModelRuntime; signal: AbortSignal }
): Promise<string | null> {
  let text = ''
  const charCap = LOCATE_MAX_TOKENS * OUTPUT_CHAR_CAP_PER_TOKEN
  const options: RuntimeChatOptions = {
    signal: deps.signal,
    maxTokens: LOCATE_MAX_TOKENS,
    temperature: 0,
    responseSchema: entityLocateSchema(),
    responseSchemaName: 'redaction_entities'
  }
  for await (const token of deps.runtime.chatStream(messages, options)) {
    if (deps.signal.aborted) throw new DOMException('Redaction locate cancelled', 'AbortError')
    text += token
    if (text.length > charCap) return null
  }
  if (deps.signal.aborted) throw new DOMException('Redaction locate cancelled', 'AbortError')
  return text
}

/** Parse + in-code re-validate one window's reply into entities (the mock runtime ignores the schema).
 *  A malformed reply ⇒ [] (that window contributes nothing; the floor still runs — never a hard fail). */
export function parseLocateReply(text: string): LocatedEntity[] {
  let parsed: { entities?: unknown }
  try {
    parsed = JSON.parse(stripThinkBlocks(text).trim()) as { entities?: unknown }
  } catch {
    return []
  }
  const raw = Array.isArray(parsed.entities) ? parsed.entities : []
  const out: LocatedEntity[] = []
  for (const e of raw as Array<{ text?: unknown; category?: unknown; line?: unknown }>) {
    const value = typeof e.text === 'string' ? e.text : ''
    const category = e.category
    const line = typeof e.line === 'number' ? e.line : NaN
    if (value.length === 0) continue
    if (!LOCATE_CATEGORIES.includes(category as LocateCategory)) continue
    out.push({ text: value, category: category as LocateCategory, line: Number.isInteger(line) && line >= 1 ? line : 1 })
  }
  return out
}

/**
 * Run the locate pass over the whole document: build overlapping line-numbered windows, ask the model
 * (grammar-constrained, temp 0) for the spans to mask in each, and collect the proposals. This is
 * LOCATE ONLY — the returned strings are UNVERIFIED proposals; the caller verifies each verbatim and
 * sweeps all occurrences (`verifyAndSweepEntities`). Steerability: `instruction` (the user's scope, or
 * the default directive when empty) rides into the system prompt; the schema's category set is fixed,
 * so the instruction only widens/narrows what is proposed — the app never interprets prose.
 *
 * A single window's malformed reply is skipped (that window contributes no entity, the floor still
 * covers it); an ABORT throws (the seam maps it to a calm cancel). `onProgress` ticks per window.
 */
export async function locateEntities(
  text: string,
  instruction: string,
  deps: { runtime: ModelRuntime; signal: AbortSignal; onProgress?: (done: number, total: number) => void }
): Promise<LocatedEntity[]> {
  const directive = instruction.trim().length > 0 ? instruction.trim() : DEFAULT_LOCATE_DIRECTIVE
  const system = buildLocateSystemPrompt(directive)
  const windows = buildLocateWindows(text)
  const found: LocatedEntity[] = []
  for (let i = 0; i < windows.length; i++) {
    if (deps.signal.aborted) throw new DOMException('Redaction locate cancelled', 'AbortError')
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: windows[i].numbered }
    ]
    const reply = await streamLocateJson(messages, deps)
    if (reply !== null) found.push(...parseLocateReply(reply))
    deps.onProgress?.(i + 1, windows.length)
  }
  return found
}
