import type { JsonSchema } from '../../../shared/types'
import type { ChatMessage, ModelRuntime } from '../runtime'
import { stripThinkBlocks } from '../chat'
import {
  BUILTIN_CATEGORY_RULES,
  UNCATEGORIZED,
  categorizeRows,
  type CategorizationRow,
  type TransactionInput
} from './tools/bank-statement'

// The bank-statement LLM categorizer (Phase 33; architecture.md "Skills — design record" §21). It
// assigns each transaction a category from a FIXED set, picking ONLY from that set — the reply is
// grammar-constrained to a `json_schema` whose category field is an enum, so the model can never emit
// a category outside the list. Anything the model leaves out, returns out of range, or that comes back
// unparseable DROPS to `Uncategorized` (a whole batch drops on a parse failure) — never an invented
// label. The module is pure-ish: it takes an injected `runtime` + `signal` and is unit-testable with
// the MockRuntime (which ignores `responseSchema`, so the drop-to-Uncategorized parse is exercised).
//
// WHY this is defensible under the honesty posture (and why no `grounding_quote` is needed, unlike a
// Stage-2 figure extraction): a CATEGORY is not a figure. A mislabel only shifts the per-category
// breakdown — it never moves the verified statement total or the D56 completeness gate (which read the
// signed amounts, not the labels). The breakdown is always presented as MODEL-ASSISTED. When no model
// is loaded the module degrades to the deterministic rule pass (`categorizeRows`).

/**
 * The FIXED category taxonomy (canonical EN identifiers — the persisted `bank_categories.name`). The
 * DE gloss is for the model prompt only; the enum values stay canonical so persistence is stable
 * across UI locale. `Uncategorized` is the always-available drop target. The richer everyday-spending
 * categories (Groceries…Tax) are what the deterministic rules can't reach — the reason a model helps.
 */
export const CATEGORIZER_CATEGORIES: readonly string[] = [
  'Groceries',
  'Dining',
  'Transport',
  'Utilities',
  'Rent',
  'Insurance',
  'Subscriptions',
  'Health',
  'Shopping',
  'Income',
  'Transfer',
  'Fees',
  'Cash',
  'Tax',
  UNCATEGORIZED
]

/** DE glosses shown in the prompt so a German statement's payees map well (display-only, not the enum). */
const CATEGORY_GLOSS: Record<string, string> = {
  Groceries: 'Lebensmittel/Supermarkt',
  Dining: 'Restaurant/Gastronomie/Café',
  Transport: 'Transport/Verkehr/Tanken/ÖPNV',
  Utilities: 'Nebenkosten/Strom/Gas/Wasser/Internet/Telefon',
  Rent: 'Miete',
  Insurance: 'Versicherung',
  Subscriptions: 'Abonnement/Streaming/Mitgliedschaft',
  Health: 'Gesundheit/Arzt/Apotheke',
  Shopping: 'Einkauf/Elektronik/Bekleidung',
  Income: 'Einkommen/Gehalt/Lohn',
  Transfer: 'Überweisung/Umbuchung',
  Fees: 'Gebühren/Entgelte',
  Cash: 'Bargeld/Geldautomat',
  Tax: 'Steuer/Finanzamt',
  [UNCATEGORIZED]: 'Nicht eindeutig zuordenbar'
}

const CATEGORY_SET: ReadonlySet<string> = new Set(CATEGORIZER_CATEGORIES)

/** Rows per model call — bounded so one statement stays a handful of small, fast completions. */
export const CATEGORIZER_BATCH_SIZE = 20

/** Output-token budget for one batch — generous room for `{index, category}` per row plus framing. */
function batchMaxTokens(rowsInBatch: number): number {
  return 64 + rowsInBatch * 24
}

/**
 * The grammar contract for ONE batch: an array of `{index, category}` where `category` is an ENUM of
 * the fixed set (so the model cannot emit an off-list label) and `index` is the batch-local row index.
 */
export function batchOutputSchema(): JsonSchema {
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
          required: ['index', 'category'],
          properties: {
            index: { type: 'integer', minimum: 0 },
            category: { type: 'string', enum: [...CATEGORIZER_CATEGORIES] }
          }
        }
      }
    }
  }
}

const SYSTEM_PROMPT = [
  'You categorize bank-statement transactions. For each transaction pick EXACTLY ONE category',
  'from this fixed list (use the English name exactly as written):',
  CATEGORIZER_CATEGORIES.map((c) => `- ${c} (${CATEGORY_GLOSS[c] ?? ''})`).join('\n'),
  '',
  'Rules: choose the single best fit from the signed amount and the description (a positive amount is',
  'usually Income or a Transfer in; a negative amount is a payment). If you are unsure, use',
  `"${UNCATEGORIZED}". Never invent a category outside the list. Reply with JSON only.`
].join('\n')

/** Render one batch's rows for the prompt: a batch-local index, the signed amount, and the description. */
export function buildBatchPrompt(rows: TransactionInput[]): string {
  const lines = rows.map((r, i) => {
    const sign = r.amount < 0 ? '-' : '+'
    const desc = r.description.replace(/\s+/g, ' ').trim().slice(0, 160)
    return `${i}\t${sign}${Math.abs(r.amount).toFixed(2)} ${r.currency}\t${desc}`
  })
  return [
    'Categorize these transactions. Reply with {"assignments":[{"index","category"}]} covering every index.',
    'index\tamount\tdescription',
    ...lines
  ].join('\n')
}

/**
 * Confident PRE-FILTER: a deterministic description-substring rule match (Fees/Income/Transfer/Cash)
 * skips the model entirely (it is already unambiguous and in the taxonomy). The amount-sign fallback
 * is NOT confident, so those rows still go to the model. Returns the category or null (→ ask the model).
 */
export function prefilterCategory(row: TransactionInput): string | null {
  const desc = row.description.toLowerCase()
  for (const rule of BUILTIN_CATEGORY_RULES) {
    if (rule.matchKind === 'description-substring' && desc.includes(rule.pattern) && CATEGORY_SET.has(rule.category)) {
      return rule.category
    }
  }
  return null
}

/** Run one model batch and return a batch-local index→category map (drops the whole batch on failure). */
async function categorizeBatch(
  rows: TransactionInput[],
  runtime: ModelRuntime,
  signal: AbortSignal
): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildBatchPrompt(rows) }
  ]
  let text = ''
  const stream = runtime.chatStream(messages, {
    signal,
    maxTokens: batchMaxTokens(rows.length),
    temperature: 0,
    responseSchema: batchOutputSchema(),
    responseSchemaName: 'transaction_categories'
  })
  for await (const token of stream) {
    if (signal.aborted) throw new DOMException('Categorization cancelled', 'AbortError')
    text += token
  }
  if (signal.aborted) throw new DOMException('Categorization cancelled', 'AbortError')

  // Parse → validate each assignment. A parse failure (the mock runtime, or a model that — absent
  // grammar constraint — replied with prose) drops the WHOLE batch: every row falls to Uncategorized
  // at the merge step. An out-of-range index or an off-list category is ignored (same drop).
  try {
    const parsed = JSON.parse(stripThinkBlocks(text).trim()) as { assignments?: Array<{ index?: unknown; category?: unknown }> }
    const assignments = Array.isArray(parsed?.assignments) ? parsed.assignments : []
    for (const a of assignments) {
      const idx = typeof a.index === 'number' ? a.index : NaN
      const cat = typeof a.category === 'string' ? a.category : ''
      if (Number.isInteger(idx) && idx >= 0 && idx < rows.length && CATEGORY_SET.has(cat) && !out.has(idx)) {
        out.set(idx, cat)
      }
    }
  } catch {
    // Unparseable — leave `out` empty so the whole batch drops to Uncategorized (honest).
  }
  return out
}

export interface CategorizeResult {
  assignments: CategorizationRow[]
  /** True when the model was consulted (any row went to the LLM) — drives the "model-assisted" label. */
  modelAssisted: boolean
}

/**
 * Categorize every row. With no runtime → the deterministic rule pass (`categorizeRows`,
 * `modelAssisted:false`). With a runtime → confident rule matches are kept as a pre-filter and the rest
 * are sent to the model in batches; anything the model omits / returns invalid drops to `Uncategorized`.
 * Progress is reported as rows resolved (pre-filtered + each completed batch). Aborts propagate.
 */
export async function categorizeTransactions(
  rows: TransactionInput[],
  deps: { runtime: ModelRuntime | null; signal: AbortSignal; onProgress?: (done: number, total: number) => void }
): Promise<CategorizeResult> {
  const { runtime, signal, onProgress } = deps
  if (rows.length === 0) return { assignments: [], modelAssisted: false }
  if (!runtime) {
    onProgress?.(rows.length, rows.length)
    return { assignments: categorizeRows(rows), modelAssisted: false }
  }

  const total = rows.length
  const result: string[] = new Array<string>(total).fill(UNCATEGORIZED)
  const toModel: number[] = []
  for (let i = 0; i < rows.length; i++) {
    const pre = prefilterCategory(rows[i])
    if (pre) result[i] = pre
    else toModel.push(i)
  }
  let done = total - toModel.length
  onProgress?.(done, total)

  for (let start = 0; start < toModel.length; start += CATEGORIZER_BATCH_SIZE) {
    const batchIdx = toModel.slice(start, start + CATEGORIZER_BATCH_SIZE)
    const batchRows = batchIdx.map((i) => rows[i])
    const assigned = await categorizeBatch(batchRows, runtime, signal)
    batchIdx.forEach((globalIdx, localIdx) => {
      const cat = assigned.get(localIdx)
      if (cat) result[globalIdx] = cat // else stays UNCATEGORIZED (dropped)
    })
    done += batchIdx.length
    onProgress?.(done, total)
  }

  return {
    assignments: result.map((category, index) => ({ index, category })),
    modelAssisted: true
  }
}
