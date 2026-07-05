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
import { wordIncludes } from './tools/money'

// The bank-statement LLM categorizer (Phase 33; architecture.md "Skills — design record" §22). It
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

/**
 * One USER-DEFINED category (result-tables plan, Phase 1.5/1.6): the persisted label plus an
 * optional GLOSS shown to the model in the prompt (never persisted, never an enum value) — a
 * taxonomy CSV's keyword column ("Kinder;Schule, Kita, Taschengeld") rides here, the single
 * biggest accuracy lever for custom labels on a small model (the fixed taxonomy's DE glosses
 * play the same role).
 */
export interface CustomCategory {
  name: string
  gloss?: string
}

/** The custom-category input shape: bare labels (the inline prompt parse) or label+gloss objects
 *  (a taxonomy CSV). Normalized internally via `normalizeCustom`. */
export type CustomCategoryInput = readonly (string | CustomCategory)[]

/**
 * Normalize a USER-SUPPLIED custom set (result-tables plan, Phase 1.5): bare strings become
 * gloss-less entries, and `Uncategorized` is always appended — the honest drop target must exist
 * in every enum, so an unsure/unparseable row can never be forced into one of the user's labels.
 * Returns undefined for an absent/empty input (→ the fixed taxonomy).
 */
function normalizeCustom(custom?: CustomCategoryInput): CustomCategory[] | undefined {
  if (!custom || custom.length === 0) return undefined
  const list = custom.map((c) => (typeof c === 'string' ? { name: c } : c))
  return list.some((c) => c.name === UNCATEGORIZED) ? list : [...list, { name: UNCATEGORIZED }]
}

/** The ACTIVE category NAMES for one run: the fixed taxonomy, or the normalized custom set. */
function activeCategories(custom?: CustomCategoryInput): readonly string[] {
  const normalized = normalizeCustom(custom)
  return normalized ? normalized.map((c) => c.name) : CATEGORIZER_CATEGORIES
}

/** Rows per model call — bounded so one statement stays a handful of small, fast completions. */
export const CATEGORIZER_BATCH_SIZE = 20

/**
 * Output-token budget for one batch — generous room for `{index, category}` per row plus framing. The
 * per-row term carries a small DESCRIPTION-LENGTH allowance (audit L-1): a verbose batch can nudge a
 * non-grammar-constrained model toward a longer reply (echoes / reasoning), so a long-description batch
 * gets more headroom before the JSON truncates and the WHOLE batch silently drops to `Uncategorized`.
 * Bounded (the prompt itself truncates each description to 160 chars) so it can never run away.
 */
function batchMaxTokens(rows: readonly TransactionInput[]): number {
  const perRow = rows.reduce((acc, r) => {
    const descLen = Math.min(r.description.length, 160) // the prompt truncates to 160 chars
    return acc + 24 + Math.ceil(descLen / 16) // up to ~+10 tokens of headroom for a long description
  }, 0)
  return 64 + perRow
}

/**
 * A defensive char-cap multiplier over `batchMaxTokens` (audit L-2): a well-behaved reply is a few
 * chars per token, so `maxTokens * 8` chars is generous slack while still bounding a LOOPING local
 * runtime that ignores `maxTokens` — past it the batch is dropped (to `Uncategorized`) rather than
 * accumulating output unbounded into memory.
 */
const BATCH_OUTPUT_CHAR_CAP_PER_TOKEN = 8

/**
 * The grammar contract for ONE batch: an array of `{index, category}` where `category` is an ENUM of
 * the active set (so the model cannot emit an off-list label) and `index` is the batch-local row
 * index. With no argument this is the fixed taxonomy (byte-identical to before Phase 1.5); with a
 * custom list the enum is the user's labels + `Uncategorized`.
 */
export function batchOutputSchema(categories?: CustomCategoryInput): JsonSchema {
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
            category: { type: 'string', enum: [...activeCategories(categories)] }
          }
        }
      }
    }
  }
}

/** The per-run system prompt. The fixed taxonomy carries its DE glosses; a custom set lists the
 *  user's labels verbatim, each with its OWN gloss when the taxonomy supplied one (Phase 1.6) —
 *  the drop-to-Uncategorized rule and the never-invent rule are identical on both paths. */
function buildSystemPrompt(categories?: CustomCategoryInput): string {
  const custom = normalizeCustom(categories)
  const cats = custom ?? CATEGORIZER_CATEGORIES.map((name) => ({ name }) as CustomCategory)
  const line = (c: CustomCategory): string => {
    if (custom && c.name !== UNCATEGORIZED) return c.gloss ? `- ${c.name} (${c.gloss})` : `- ${c.name}`
    return `- ${c.name} (${CATEGORY_GLOSS[c.name] ?? ''})`
  }
  // The fixed-taxonomy rules line names the actual Income/Transfer categories (kept byte-identical to
  // the Phase-33 prompt); a custom set gets the generic phrasing — its labels are the user's.
  const signHint = categories
    ? 'usually an income-like category; a negative amount is a payment'
    : 'usually Income or a Transfer in; a negative amount is a payment'
  return [
    'You categorize bank-statement transactions. For each transaction pick EXACTLY ONE category',
    categories
      ? 'from this fixed list (use the name exactly as written):'
      : 'from this fixed list (use the English name exactly as written):',
    cats.map(line).join('\n'),
    '',
    'Rules: choose the single best fit from the signed amount and the description (a positive amount is',
    `${signHint}). If you are unsure, use`,
    `"${UNCATEGORIZED}". Never invent a category outside the list. Reply with JSON only.`
  ].join('\n')
}

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
 * Confident PRE-FILTER: a deterministic, WORD-bounded description rule match (Fees/Income/Transfer/Cash)
 * skips the model entirely (it is already unambiguous and in the taxonomy). Word-bounded (shared
 * `wordIncludes`, not a raw substring) so a coincidental match (`fee` inside `coffee`) never wrongly
 * skips the model — and so this PRE-FILTER and the deterministic `categorizeRow` agree on the same
 * description rules (audit C-1). The amount-sign fallback is NOT confident, so those rows still go to
 * the model. Nor are `confident: false` rules (transfer-BOILERPLATE `sepa`/`überweisung` — R3 / audit
 * §5.5): they describe the payment rails, not the merchant, so they must reach the model here even
 * though `categorizeRow` still applies them as the deterministic no-model fallback. Returns the
 * category or null (→ ask the model).
 */
export function prefilterCategory(row: TransactionInput): string | null {
  const desc = row.description.toLowerCase()
  for (const rule of BUILTIN_CATEGORY_RULES) {
    if (
      rule.matchKind === 'description-substring' &&
      rule.confident !== false && // transfer-boilerplate (sepa/überweisung) goes to the model, not the prefilter (§5.5)
      wordIncludes(desc, rule.pattern, rule.compound) && // honour the BL-3 German-compound flag (C-1 agreement)
      CATEGORY_SET.has(rule.category)
    ) {
      return rule.category
    }
  }
  return null
}

/**
 * Stream ONE model completion for a batch and return the accumulated reply text, or `null` if the
 * output blew the defensive char cap (audit L-2 — a looping runtime ignoring `maxTokens`). Aborts
 * propagate as an `AbortError`.
 */
async function streamBatchReply(
  messages: ChatMessage[],
  runtime: ModelRuntime,
  signal: AbortSignal,
  maxTokens: number,
  categories?: CustomCategoryInput
): Promise<string | null> {
  let text = ''
  const charCap = maxTokens * BATCH_OUTPUT_CHAR_CAP_PER_TOKEN
  const stream = runtime.chatStream(messages, {
    signal,
    maxTokens,
    temperature: 0,
    responseSchema: batchOutputSchema(categories),
    responseSchemaName: 'transaction_categories'
  })
  for await (const token of stream) {
    if (signal.aborted) throw new DOMException('Categorization cancelled', 'AbortError')
    text += token
    if (text.length > charCap) return null // L-2: bound memory — drop the batch rather than grow unbounded
  }
  if (signal.aborted) throw new DOMException('Categorization cancelled', 'AbortError')
  return text
}

/**
 * Parse a batch reply into a batch-local index→category map, or `null` if the JSON is UNPARSEABLE
 * (truncated / prose) — distinct from a parsed-but-empty result (every assignment off-list/out-of-range),
 * which returns an empty map. The `null` signals the caller to RETRY once before dropping (audit L-1).
 */
function parseBatchAssignments(
  text: string,
  rowCount: number,
  categorySet: ReadonlySet<string> = CATEGORY_SET
): Map<number, string> | null {
  try {
    const parsed = JSON.parse(stripThinkBlocks(text).trim()) as {
      assignments?: Array<{ index?: unknown; category?: unknown }>
    }
    const assignments = Array.isArray(parsed?.assignments) ? parsed.assignments : []
    const out = new Map<number, string>()
    for (const a of assignments) {
      const idx = typeof a.index === 'number' ? a.index : NaN
      const cat = typeof a.category === 'string' ? a.category : ''
      if (Number.isInteger(idx) && idx >= 0 && idx < rowCount && categorySet.has(cat) && !out.has(idx)) {
        out.set(idx, cat)
      }
    }
    return out
  } catch {
    return null // unparseable
  }
}

/**
 * Run one model batch and return a batch-local index→category map. A parse failure (the mock runtime,
 * or a model that — absent grammar constraint — replied with prose, or a TRUNCATED reply that overran
 * the token budget) is RETRIED once (audit L-1) before the WHOLE batch drops to `Uncategorized` (every
 * row falls to it at the merge step — the honest final fallback). An over-long reply (L-2 char cap) is
 * dropped without a retry (retrying an unbounded reply would only repeat the cost). An out-of-range
 * index or an off-list category is ignored (parsed, so no retry — that is a deliberate drop, not a fault).
 */
async function categorizeBatch(
  rows: TransactionInput[],
  runtime: ModelRuntime,
  signal: AbortSignal,
  categories?: CustomCategoryInput
): Promise<Map<number, string>> {
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(categories) },
    { role: 'user', content: buildBatchPrompt(rows) }
  ]
  const categorySet = new Set(activeCategories(categories))
  const maxTokens = batchMaxTokens(rows)
  const MAX_ATTEMPTS = 2 // one initial try + a single retry on an unparseable (e.g. truncated) reply
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const text = await streamBatchReply(messages, runtime, signal, maxTokens, categories)
    if (text === null) break // L-2 cap blown — drop the batch (no retry on a runaway reply)
    const parsed = parseBatchAssignments(text, rows.length, categorySet)
    if (parsed) return parsed // parsed OK (possibly empty after validation) — accept, do not retry
    // Unparseable — retry once, then fall through to the empty-map drop.
  }
  return new Map<number, string>() // drop the whole batch to Uncategorized (honest)
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
 *
 * `categories` (result-tables Phase 1.5) switches the run to a USER-SUPPLIED category set: the enum,
 * prompt, and validation all use the custom labels (+ the appended `Uncategorized` drop target), and
 * the deterministic PRE-FILTER is SKIPPED — its rule names live in the fixed taxonomy, not the user's.
 * A custom set with no runtime returns every row `Uncategorized` (the rules cannot know the user's
 * labels; the CALLER should refuse with friendly copy before it gets here).
 */
export async function categorizeTransactions(
  rows: TransactionInput[],
  deps: {
    runtime: ModelRuntime | null
    signal: AbortSignal
    onProgress?: (done: number, total: number) => void
    categories?: CustomCategoryInput
  }
): Promise<CategorizeResult> {
  const { runtime, signal, onProgress, categories } = deps
  if (rows.length === 0) return { assignments: [], modelAssisted: false }
  if (!runtime) {
    onProgress?.(rows.length, rows.length)
    return {
      assignments: categories
        ? rows.map((_, index) => ({ index, category: UNCATEGORIZED })) // rules can't know custom labels
        : categorizeRows(rows),
      modelAssisted: false
    }
  }

  const total = rows.length
  const result: string[] = new Array<string>(total).fill(UNCATEGORIZED)
  const toModel: number[] = []
  for (let i = 0; i < rows.length; i++) {
    const pre = categories ? null : prefilterCategory(rows[i]) // no prefilter on a custom set
    if (pre) result[i] = pre
    else toModel.push(i)
  }
  let done = total - toModel.length
  onProgress?.(done, total)

  for (let start = 0; start < toModel.length; start += CATEGORIZER_BATCH_SIZE) {
    const batchIdx = toModel.slice(start, start + CATEGORIZER_BATCH_SIZE)
    const batchRows = batchIdx.map((i) => rows[i])
    const assigned = await categorizeBatch(batchRows, runtime, signal, categories)
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

// ---- Prompt-supplied custom category sets (result-tables plan, Phase 1.5) ----

/** Bounds for a parsed custom set: at least 2 labels (a single "category" is almost always a false
 *  parse — "in diesem Auszug"), at most 24 (a grammar enum, a prompt list, and a breakdown all stay
 *  readable), each ≤ 40 chars and ≤ 4 words (a longer token is a swallowed clause, not a label). */
export const CUSTOM_CATEGORIES_MIN = 2
export const CUSTOM_CATEGORIES_MAX = 24

// "Kategorisiere (die Transaktionen) in Miete, Lebensmittel und Kinder …" / "categorize into rent,
// groceries and kids …". Requires a categorize STEM before the preposition (so a bare "in X, Y" never
// fires) and captures up to the sentence end; longer preposition phrases are tried first. The stems
// deliberately ⊂ the handler's CATEGORY_KEYWORDS ('kategor'/'categor'), so a parsed custom list is
// always category-shaped for the routing above it.
const CUSTOM_LIST_RE =
  /\b(?:kategorisier\w*|categori[sz]e\w*|categori[sz]ation)\b[^.:!?\n]*?\b(?:in die kategorien|in folgende kategorien|into (?:the )?categories|using (?:the )?categories|with (?:the )?categories|nach den kategorien|mit den kategorien|into|nach|in)\b:?\s+([^.!?\n]+)/i

// Cut the captured list at a trailing DELIVERABLE clause ("… und exportiere als CSV", "… and give me
// a CSV", "… als JSON") so the export half of a combined ask never becomes a "category".
const LIST_TAIL_CUT_RE =
  /\s*(?:,|;)?\s*\b(?:und|and|dann|then)\b\s+(?:gib|exportier\w*|zeig\w*|erstell\w*|mach\w*|speicher\w*|give|export\w*|show|output|create|save)[\s\S]*$|\s*\b(?:als|as)\s+(?:csv|json)\b[\s\S]*$/i

/** One plausible LABEL: starts with a letter, then letters/digits/space/&/-, ≤ 40 chars, ≤ 4 words. */
const LABEL_RE = /^[\p{L}][\p{L}\p{N}&\- ]{0,39}$/u

/**
 * Parse a USER-SUPPLIED category list out of a chat question, or null when the question carries none.
 * Deliberately conservative: it requires a categorize stem + a list of ≥ 2 plausible labels, cuts a
 * trailing deliverable clause, and REJECTS the whole parse when any remaining token fails the label
 * shape (a half-understood list must not silently categorize into garbage — the caller falls back to
 * the fixed taxonomy then). Deduped case-insensitively, first casing kept; `csv`/`json` and
 * `Uncategorized` are never accepted as labels.
 */
export function parseRequestedCategories(question: string): string[] | null {
  const m = CUSTOM_LIST_RE.exec(question)
  if (!m) return null
  const list = m[1].replace(LIST_TAIL_CUT_RE, '').trim()
  if (!list) return null
  const tokens = list
    .split(/,|;|\/|\bund\b|\band\b|\boder\b|\bor\b/i)
    .map((t) => t.replace(/^["'„“]+|["'„“]+$/g, '').trim())
    .filter((t) => t.length > 0)
  if (tokens.length < CUSTOM_CATEGORIES_MIN) return null
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of tokens) {
    const lower = t.toLowerCase()
    if (lower === 'csv' || lower === 'json' || lower === UNCATEGORIZED.toLowerCase()) return null
    if (!LABEL_RE.test(t) || t.split(/\s+/).length > 4) return null // one bad token ⇒ reject the parse
    if (!seen.has(lower)) {
      seen.add(lower)
      out.push(t)
    }
  }
  if (out.length < CUSTOM_CATEGORIES_MIN || out.length > CUSTOM_CATEGORIES_MAX) return null
  return out
}

// ---- Taxonomy CSV referenced from the prompt (result-tables plan, Phase 1.6) ----

/** Label ceiling for a taxonomy FILE — higher than the inline prompt bound (a file is explicit and
 *  unambiguous), still small enough that the grammar enum + the prompt list stay cheap. */
export const TAXONOMY_CATEGORIES_MAX = 40

/** Gloss ceiling per label — a keyword hint, not a paragraph (the prompt stays bounded). */
const TAXONOMY_GLOSS_MAX_CHARS = 120

/** Header cells that mark a first line as a HEADER row (skipped), lowercase. */
const TAXONOMY_HEADER_CELLS = new Set(['kategorie', 'kategorien', 'category', 'categories', 'name', 'label'])

/** A plausible FILE-taxonomy label. Wider than the inline `LABEL_RE`: a file is explicit, so
 *  common real-world label shapes like `Kfz/Auto`, `Essen & Trinken` or `Vers. + Vorsorge` are
 *  accepted (`/`, `+`, `.` allowed); the inline prompt parse stays strict — there those characters
 *  signal a swallowed clause, not a label. */
const TAXONOMY_LABEL_RE = /^[\p{L}][\p{L}\p{N}&+\-/. ]{0,39}$/u

/**
 * Detect a taxonomy-FILE reference in a categorize-shaped question ("Kategorisiere nach den
 * Kategorien in taxonomie.csv", 'categorize using "my taxonomy.csv"'). Requires the categorize stem
 * (same gate as the inline parse) and a `.csv` token — quoted first (spaces allowed inside quotes),
 * else the bare non-space token. A FULL PATH (`/home/…/HVB/taxonomie.csv`, `C:\…\taxonomie.csv`) is
 * reduced to its BASENAME: the library lookup matches document titles (imported files carry no
 * path), and echoing a user's directory structure back in an answer would be needless content.
 * Returns the referenced name or null.
 */
export function parseTaxonomyFileRef(question: string): string | null {
  if (!/\b(?:kategorisier\w*|categori[sz]e\w*|categori[sz]ation)\b/i.test(question)) return null
  const quoted = /["'„“«]([^"'„“«»\n]{1,160}?\.csv)["'“«»]/i.exec(question)
  const bare = quoted ? null : /(?:^|\s)([^\s"'„“«»]{1,160}\.csv)\b/i.exec(question)
  const raw = (quoted ?? bare)?.[1]
  if (!raw) return null
  const basename = raw.replace(/^[([{]+/, '').trim().split(/[\\/]/).pop() ?? ''
  return basename.length > 0 ? basename : null
}

/**
 * Parse a taxonomy CSV's text into labels + optional glosses, or null when it is not a plausible
 * category list. One category per line: the FIRST cell is the label, the remaining cells join into
 * the gloss shown to the model ("Kinder;Schule, Kita, Taschengeld"). The delimiter is the first of
 * `;` / tab / `,` that appears in the file (a DE CSV is usually `;`); a gloss-less plain list (one
 * word per line) needs no delimiter at all. A leading header row ("Kategorie;Stichworte") and
 * `#`-comment lines are skipped. All-or-nothing like the inline parse (D65): ONE invalid label
 * rejects the whole file — never a silent partial taxonomy. Labels are deduped case-insensitively.
 */
export function parseTaxonomyCsv(text: string): CustomCategory[] | null {
  let lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
  if (lines.length === 0) return null

  // The app's CSV IMPORTER does not store the raw file: a header-ful CSV is linearized into
  // "Header: value; Header2: value2" lines (ingestion/parsers/csv.ts — good for retrieval, but it
  // is what we read here). Detect that shape — every line opens with the SAME "<first header>: "
  // key — and reconstruct the original rows: the constant keys are the header row (re-emitted
  // first, so the header-skip below applies), each line's VALUES re-join into a `;`-delimited row.
  // A German semicolon-CSV comma-imported (the importer pins `.csv` to ',') collapses its cells
  // into the first value ("Kategorie;Stichworte: Miete;Hausverwaltung") — the `;`-rejoin puts the
  // label/gloss split back together for that shape too. `colN` overflow keys are importer
  // artefacts, dropped from the reconstructed header. A raw list (the unit-test path / a pasted
  // plain file) has no ": " pairs and passes through untouched.
  const pairKey = (p: string): string => p.slice(0, p.indexOf(': '))
  const pairValue = (p: string): string => {
    const i = p.indexOf(': ')
    return (i >= 0 ? p.slice(i + 2) : p).trim()
  }
  const PAIR_RE = /^[^:]{1,80}: /
  if (lines.every((l) => PAIR_RE.test(l))) {
    const firstKey = pairKey(lines[0].split('; ')[0])
    if (firstKey.length > 0 && lines.every((l) => pairKey(l.split('; ')[0]) === firstKey)) {
      const headerKeys = lines[0]
        .split('; ')
        .map(pairKey)
        .filter((k) => k.length > 0 && !/^col\d+$/.test(k))
      const reconstructed = lines.map((l) =>
        l
          .split('; ')
          .map(pairValue)
          .filter((v) => v.length > 0)
          .join(';')
      )
      lines = [headerKeys.join(';'), ...reconstructed].filter((l) => l.length > 0)
    }
  }

  const joined = lines.join('\n')
  const delimiter = joined.includes(';') ? ';' : joined.includes('\t') ? '\t' : ','
  const cells = (line: string): string[] =>
    line.split(delimiter).map((c) => c.replace(/^["'„“]+|["'“”]+$/g, '').trim())
  let start = 0
  const first = cells(lines[0])
  if (first.length > 0 && TAXONOMY_HEADER_CELLS.has(first[0].toLowerCase())) start = 1
  const out: CustomCategory[] = []
  const seen = new Set<string>()
  for (const line of lines.slice(start)) {
    const parts = cells(line)
    const name = parts[0] ?? ''
    if (!TAXONOMY_LABEL_RE.test(name) || name.split(/\s+/).length > 4) return null // one bad label ⇒ reject the file
    const lower = name.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    const gloss = parts.slice(1).filter((p) => p.length > 0).join(', ').slice(0, TAXONOMY_GLOSS_MAX_CHARS)
    out.push(gloss ? { name, gloss } : { name })
  }
  if (out.length < CUSTOM_CATEGORIES_MIN || out.length > TAXONOMY_CATEGORIES_MAX) return null
  return out
}
