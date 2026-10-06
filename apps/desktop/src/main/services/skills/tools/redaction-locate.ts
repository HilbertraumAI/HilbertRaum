import type { JsonSchema } from '../../../../shared/types'
import { stripThinkBlocks } from '../../chat'
import { walkLocateWindows, type LocateWalkDeps } from './locate-walk'

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
// This module holds the runtime-touching half (the prompt, the schema, the reply parse; the windows and
// the model calls are the walk in locate-walk.ts, shared with the document-edit pass — #622 sizes both to
// the model's context). It is pure main-side TS otherwise — no
// fs/net/native (CLAUDE.md §0). The deterministic verify+sweep lives in redaction.ts so it stays
// runtime-free and unit-testable without a model.
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

/** Global cap on UNIQUE collected proposals (#134) — equals the `redact_document` schema's `entities`
 *  maxItems (the tool gate's hard input bound), so the seam can never hand the gate an overflowing
 *  list ("This tool was given input it cannot accept." AFTER the full multi-minute locate pass). The
 *  schema cites this constant; keep the two in lockstep. */
export const MAX_LOCATED_ENTITIES = 4096

/** The entity `text` maxLength (UTF-16 units) of the locate grammar and the `redact_document` schema, which
 *  cites it. `parseLocateReply` re-checks it (#583): the grammar may bound code points instead. */
export const MAX_LOCATED_ENTITY_CHARS = 160

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
            text: { type: 'string', minLength: 1, maxLength: MAX_LOCATED_ENTITY_CHARS },
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

/** Parse + in-code re-validate one window's reply into entities (the mock runtime ignores the schema).
 *  A malformed reply ⇒ [] (that window contributes nothing; the floor still runs — never a hard fail).
 *  An over-long text is dropped, never clipped: one would make the gate refuse the whole list (#583). */
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
    if (value.length === 0 || value.length > MAX_LOCATED_ENTITY_CHARS) continue
    if (!LOCATE_CATEGORIES.includes(category as LocateCategory)) continue
    out.push({ text: value, category: category as LocateCategory, line: Number.isInteger(line) && line >= 1 ? line : 1 })
  }
  return out
}

/** The locate pass result (#134): the UNIQUE proposals (capped at MAX_LOCATED_ENTITIES) plus an honest
 *  truncation flag — true when the cap dropped proposals or cut the window walk short, so the seam can
 *  say so instead of silently under-masking. */
export interface LocateEntitiesResult {
  entities: LocatedEntity[]
  truncated: boolean
}

/**
 * Run the locate pass over the whole document: build overlapping line-numbered windows, ask the model
 * (grammar-constrained, temp 0) for the spans to mask in each, and collect the proposals. This is
 * LOCATE ONLY — the returned strings are UNVERIFIED proposals; the caller verifies each verbatim and
 * sweeps all occurrences (`verifyAndSweepEntities`). Steerability: `instruction` (the user's scope, or
 * the default directive when empty) rides into the system prompt; the schema's category set is fixed,
 * so the instruction only widens/narrows what is proposed — the app never interprets prose.
 *
 * Collection discipline (#134): proposals de-duplicate on their exact STRING (the sweep is text-keyed
 * and document-wide, so a re-proposal from the 8-line window overlap — or from a repeated entity —
 * adds nothing), and the unique list is capped at MAX_LOCATED_ENTITIES (== the tool schema's
 * `entities` maxItems, so the gate can never refuse the seam's input). A full cap stops the window
 * walk early — further model calls could only produce droppable proposals — and reports `truncated`.
 *
 * A single window's malformed reply is skipped (that window contributes no entity, the floor still
 * covers it). #622: the windows fit the model's context and a reply cut short splits its window
 * (`locate-walk.ts`); a window that cannot fit throws `LocateTooLongError`. An ABORT throws (the seam
 * maps it to a calm cancel). `onProgress` ticks per window.
 */
export async function locateEntities(
  text: string,
  instruction: string,
  deps: LocateWalkDeps
): Promise<LocateEntitiesResult> {
  const directive = instruction.trim().length > 0 ? instruction.trim() : DEFAULT_LOCATE_DIRECTIVE
  const found: LocatedEntity[] = []
  const seen = new Set<string>()
  let truncated = false
  const walk = await walkLocateWindows(
    text,
    {
      system: buildLocateSystemPrompt(directive),
      schema: entityLocateSchema(),
      schemaName: 'redaction_entities',
      parse: parseLocateReply,
      cancelledMessage: 'Redaction locate cancelled'
    },
    deps,
    (entities) => {
      for (const e of entities) {
        if (seen.has(e.text)) continue // already collected — the sweep masks every occurrence anyway
        if (found.length >= MAX_LOCATED_ENTITIES) {
          truncated = true
          break
        }
        seen.add(e.text)
        found.push(e)
      }
      // A full cap stops paying for locate calls whose proposals could only be dropped.
      return found.length < MAX_LOCATED_ENTITIES
    }
  )
  return { entities: found, truncated: truncated || walk.stoppedEarly }
}
