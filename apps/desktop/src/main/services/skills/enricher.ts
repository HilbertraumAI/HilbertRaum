import type { JsonSchema } from '../../../shared/types'
import type { ChatMessage, ModelRuntime } from '../runtime'
import { stripThinkBlocks } from '../chat'
import { buildBatchPrompt } from './categorizer'
import type { TransactionInput } from './tools/bank-statement'

// The derived-column ENRICHER (result-tables plan §5, Phase 3): the categorizer generalized to
// N user-requested columns. Two grammar-constrained (D55) model surfaces:
//
//   1. `parseTableRequest` — ONE call that turns a tabular ask into the columns the user asked
//      for BEYOND the fixed transaction shape ("… als CSV mit einer Spalte Empfänger" →
//      [{ name: 'Empfänger' }]). Schema-forced, then validated all-or-nothing (D65 posture).
//   2. `enrichRows` — batched per-row calls that fill EVERY requested column for EVERY extracted
//      row (whole-statement by construction — the rows come from the deterministic extractor).
//      Free-text values are length-capped by the schema; a column with `enumValues` is
//      enum-constrained. The model may always answer "unknown"; an unknown/invalid/dropped cell
//      serializes as a BLANK — absent, never invented (§22-D1).
//
// Cost posture: `wantsExtraColumns` is the cheap deterministic PRE-GATE — a plain "als CSV" turn
// never pays the parse call, so the Phase-1 0-model short-circuit is unchanged unless the user
// actually asked for extra columns. Honesty posture: a derived value is a MODEL-FILLED label,
// never a parser figure — the handler appends a note saying exactly that.

/** A user-requested derived column: the emitted key/label, an optional description (fed to the
 *  model prompt, like a taxonomy gloss), and optional enum values that constrain the cells. */
export interface DerivedColumn {
  name: string
  description?: string
  enumValues?: readonly string[]
}

/** The sentinel the model uses for "cannot determine" — serialized as a blank cell, never a value. */
export const ENRICH_UNKNOWN = 'unknown'

/** Bounds: ≤ 4 derived columns per ask (a table stays readable; the per-batch schema stays small);
 *  cell values ≤ 60 chars (a cell is a label/name, not a sentence). */
export const MAX_DERIVED_COLUMNS = 4
const MAX_CELL_CHARS = 60

/** Rows per enrichment call — smaller than the categorizer's 20 (each row now carries N values). */
export const ENRICH_BATCH_SIZE = 12

/** A plausible column name — same shape as a file-taxonomy label. */
const COLUMN_NAME_RE = /^[\p{L}][\p{L}\p{N}&+\-/. ]{0,39}$/u

/** The fixed transaction columns (EN keys + common DE phrasings) a "derived" column must not
 *  duplicate — those already ride every table; the parse treating them as new would double them. */
const FIXED_COLUMN_NAMES: ReadonlySet<string> = new Set([
  'date', 'valuedate', 'description', 'amount', 'currency', 'balanceafter', 'sourcepage', 'category',
  'datum', 'valuta', 'beschreibung', 'betrag', 'währung', 'saldo', 'seite', 'kategorie'
])

/**
 * The deterministic PRE-GATE: does the question even SUGGEST extra columns? Only then is the
 * TableRequest parse (a model call) paid — a plain "als CSV" stays the 0-model short-circuit.
 * Deliberately broad-ish (the model decides WHAT the columns are; a false positive costs one
 * small parse call that returns an empty list), but never fires on the plain format ask.
 */
export function wantsExtraColumns(question: string): boolean {
  return /\bspalten?\b|\bcolumns?\b|\bunterkategor\w*|subcategor\w*|counterpart\w*|\bempfänger\w*|\brecipient\w*|\bpayee\w*/i.test(
    question
  )
}

/** The grammar contract for the TableRequest parse: ≤ MAX_DERIVED_COLUMNS columns, each a short
 *  name + optional description/enum. The model cannot emit anything outside this shape. */
export function tableRequestSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['derivedColumns'],
    properties: {
      derivedColumns: {
        type: 'array',
        maxItems: MAX_DERIVED_COLUMNS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 40 },
            description: { type: 'string', maxLength: 120 },
            enumValues: {
              type: 'array',
              maxItems: 12,
              items: { type: 'string', minLength: 1, maxLength: 40 }
            }
          }
        }
      }
    }
  }
}

const PARSE_SYSTEM_PROMPT = [
  'The user asked for a table of bank-statement transactions. Identify ONLY the ADDITIONAL',
  'per-transaction columns the user EXPLICITLY requested beyond the standard ones (date, value',
  'date, description, amount, currency, balance, page, category). For each: its name exactly as',
  'the user phrased it, optionally a one-line description of what to fill in, and optionally the',
  'fixed values the user listed for it. When the user requested no additional column, return an',
  'empty list. Never invent a column. Reply with JSON only.'
].join('\n')

/** Char cap multiplier — the same runaway-runtime bound the categorizer uses (audit L-2). */
const OUTPUT_CHAR_CAP_PER_TOKEN = 8

async function streamJson(
  messages: ChatMessage[],
  runtime: ModelRuntime,
  signal: AbortSignal,
  maxTokens: number,
  schema: JsonSchema,
  schemaName: string
): Promise<string | null> {
  let text = ''
  const charCap = maxTokens * OUTPUT_CHAR_CAP_PER_TOKEN
  const stream = runtime.chatStream(messages, {
    signal,
    maxTokens,
    temperature: 0,
    responseSchema: schema,
    responseSchemaName: schemaName
  })
  for await (const token of stream) {
    if (signal.aborted) throw new DOMException('Enrichment cancelled', 'AbortError')
    text += token
    if (text.length > charCap) return null
  }
  if (signal.aborted) throw new DOMException('Enrichment cancelled', 'AbortError')
  return text
}

/**
 * Parse the user's tabular ask into derived columns (ONE model call), or null when the reply is
 * unusable. Validation is ALL-OR-NOTHING (the D65 posture): an invalid/duplicate/fixed-shadowing
 * name rejects the whole request — the caller falls back to the plain (un-enriched) table, never
 * to a half-understood one. An empty list is a VALID outcome (the user asked for no extra column).
 */
export async function parseTableRequest(
  question: string,
  deps: { runtime: ModelRuntime; signal: AbortSignal }
): Promise<DerivedColumn[] | null> {
  const messages: ChatMessage[] = [
    { role: 'system', content: PARSE_SYSTEM_PROMPT },
    { role: 'user', content: question }
  ]
  const text = await streamJson(messages, deps.runtime, deps.signal, 320, tableRequestSchema(), 'table_request')
  if (text === null) return null
  let parsed: { derivedColumns?: unknown }
  try {
    parsed = JSON.parse(stripThinkBlocks(text).trim()) as { derivedColumns?: unknown }
  } catch {
    return null
  }
  const raw = Array.isArray(parsed.derivedColumns) ? parsed.derivedColumns : null
  if (!raw) return null
  const out: DerivedColumn[] = []
  const seen = new Set<string>()
  for (const c of raw as Array<{ name?: unknown; description?: unknown; enumValues?: unknown }>) {
    const name = typeof c.name === 'string' ? c.name.trim() : ''
    const lower = name.toLowerCase()
    if (!COLUMN_NAME_RE.test(name) || FIXED_COLUMN_NAMES.has(lower) || lower === ENRICH_UNKNOWN) return null
    if (seen.has(lower)) continue
    seen.add(lower)
    const col: DerivedColumn = { name }
    if (typeof c.description === 'string' && c.description.trim().length > 0) {
      col.description = c.description.trim().slice(0, 120)
    }
    if (Array.isArray(c.enumValues)) {
      const values = c.enumValues.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      if (values.length > 0) col.enumValues = values.map((v) => v.trim().slice(0, 40))
    }
    out.push(col)
  }
  return out.slice(0, MAX_DERIVED_COLUMNS)
}

/** The per-batch grammar contract for enrichment: for each batch-local index, ONE value per
 *  requested column — enum-constrained where the column carries enumValues (+ the unknown drop
 *  target), length-capped free text otherwise. */
export function enrichBatchSchema(columns: readonly DerivedColumn[]): JsonSchema {
  const valueProps: Record<string, JsonSchema> = {}
  for (const c of columns) {
    valueProps[c.name] = c.enumValues
      ? { type: 'string', enum: [...new Set([...c.enumValues, ENRICH_UNKNOWN])] }
      : { type: 'string', maxLength: MAX_CELL_CHARS }
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['assignments'],
    properties: {
      assignments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'values'],
          properties: {
            index: { type: 'integer', minimum: 0 },
            values: {
              type: 'object',
              additionalProperties: false,
              required: columns.map((c) => c.name),
              properties: valueProps
            }
          }
        }
      }
    }
  }
}

function buildEnrichSystemPrompt(columns: readonly DerivedColumn[]): string {
  const lines = columns.map((c) => {
    const parts = [`- ${c.name}`]
    if (c.description) parts.push(`: ${c.description}`)
    if (c.enumValues) parts.push(` (one of: ${c.enumValues.join(', ')})`)
    return parts.join('')
  })
  return [
    'You fill additional columns for bank-statement transactions. For each transaction return a',
    'value for EVERY requested column, derived only from the signed amount and the description.',
    'Requested columns:',
    ...lines,
    '',
    `If a value cannot be determined from the transaction line, use "${ENRICH_UNKNOWN}" — never`,
    'guess and never invent. Reply with JSON only.'
  ].join('\n')
}

/** Token budget per enrichment batch: framing + per row roughly one short value per column. */
function enrichMaxTokens(rowCount: number, columnCount: number): number {
  return 64 + rowCount * (16 + columnCount * 24)
}

function parseEnrichBatch(
  text: string,
  rowCount: number,
  columns: readonly DerivedColumn[]
): Map<number, Record<string, string>> | null {
  try {
    const parsed = JSON.parse(stripThinkBlocks(text).trim()) as {
      assignments?: Array<{ index?: unknown; values?: unknown }>
    }
    const assignments = Array.isArray(parsed?.assignments) ? parsed.assignments : []
    const out = new Map<number, Record<string, string>>()
    for (const a of assignments) {
      const idx = typeof a.index === 'number' ? a.index : NaN
      if (!Number.isInteger(idx) || idx < 0 || idx >= rowCount || out.has(idx)) continue
      const values = (typeof a.values === 'object' && a.values !== null ? a.values : {}) as Record<string, unknown>
      const row: Record<string, string> = {}
      for (const c of columns) {
        const v = typeof values[c.name] === 'string' ? (values[c.name] as string).trim() : ''
        // Enum columns: an off-enum value drops to blank (the schema should prevent it; the mock
        // runtime ignores schemas, so validate here too). Free text: cap + unknown→blank.
        const valid = c.enumValues ? c.enumValues.includes(v) : v.length > 0 && v.length <= MAX_CELL_CHARS
        row[c.name] = valid && v.toLowerCase() !== ENRICH_UNKNOWN ? v : ''
      }
      out.set(idx, row)
    }
    return out
  } catch {
    return null // unparseable → the caller may retry once
  }
}

/**
 * Fill the requested columns for every row (batched, grammar-constrained). Returns one record per
 * input row (same order): column name → value, '' where the model was unsure / the batch dropped.
 * WHOLE-statement by construction — the caller hands the full extracted row set. Aborts propagate.
 */
export async function enrichRows(
  rows: readonly TransactionInput[],
  columns: readonly DerivedColumn[],
  deps: { runtime: ModelRuntime; signal: AbortSignal; onProgress?: (done: number, total: number) => void }
): Promise<Array<Record<string, string>>> {
  const blank = (): Record<string, string> => Object.fromEntries(columns.map((c) => [c.name, '']))
  const result: Array<Record<string, string>> = rows.map(() => blank())
  if (rows.length === 0 || columns.length === 0) return result

  const schema = enrichBatchSchema(columns)
  const system = buildEnrichSystemPrompt(columns)
  for (let start = 0; start < rows.length; start += ENRICH_BATCH_SIZE) {
    const batch = rows.slice(start, start + ENRICH_BATCH_SIZE)
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: buildBatchPrompt([...batch]) }
    ]
    const maxTokens = enrichMaxTokens(batch.length, columns.length)
    const MAX_ATTEMPTS = 2 // one retry on an unparseable reply (the categorizer's L-1 posture)
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const text = await streamJson(messages, deps.runtime, deps.signal, maxTokens, schema, 'table_enrichment')
      if (text === null) break // runaway reply — drop the batch to blanks, no retry
      const parsed = parseEnrichBatch(text, batch.length, columns)
      if (parsed) {
        parsed.forEach((values, localIdx) => {
          result[start + localIdx] = values
        })
        break
      }
    }
    deps.onProgress?.(Math.min(start + batch.length, rows.length), rows.length)
  }
  return result
}
