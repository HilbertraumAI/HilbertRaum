import type {
  DocumentChunkRead,
  JsonSchema,
  SkillTool,
  ToolResult
} from '../../../../shared/types'

// Bank-statement Tier-2 tools (docs/skills-s11-plan.md §5, Phase S11a). Kept OUT of the generic
// `tool-registry.ts` so bank specifics never leak into the skills infrastructure (skills-plan §13);
// the registry merely imports the finished `SkillTool` and lists it. S11a ships ONLY
// `extract_transactions`; validate/categorize/summarize/export arrive at S11c.
//
// Pure main-side TS: no node:fs, no network, no native deps (CLAUDE.md §0). The tool's WHOLE reach
// is `ctx.readDocumentChunks` over the frozen selected-document scope (it cannot widen scope or
// touch a DB/FS/net handle — §14); it persists nothing (the gate stays content-free — the
// `run.ts` orchestration seam writes the rows). The extractor is DETERMINISTIC and OFFLINE: it
// quotes only what it can confidently parse and DROPS ambiguous rows rather than invent figures
// (the §22-D1 honesty posture; parse quality is a known limitation that improves later).

// ---- The output contract (the `JsonSchema` subset, mirroring the committed transaction.schema.json) ----

/** One extracted transaction row — the shape of `app-skills/bank-statement/schemas/transaction.schema.json`. */
const TRANSACTION_ROW_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['date', 'description', 'amount', 'currency'],
  properties: {
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    valueDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    description: { type: 'string', minLength: 1 },
    amount: { type: 'number' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    balanceAfter: { type: 'number' },
    sourcePage: { type: 'integer', minimum: 1 }
  }
}

/** A hard cap so a pathological document can never produce an unbounded array (the gate also validates). */
export const MAX_TRANSACTIONS = 10000

const EXTRACT_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['transactions'],
  properties: {
    transactions: { type: 'array', items: TRANSACTION_ROW_SCHEMA, maxItems: MAX_TRANSACTIONS },
    // The detected statement currency, if any — a convenience for the orchestration seam (optional).
    currency: { type: 'string', pattern: '^[A-Z]{3}$' }
  }
}

export interface ExtractedTransaction {
  date: string
  valueDate?: string
  description: string
  amount: number
  currency: string
  balanceAfter?: number
  sourcePage?: number
}

export interface ExtractTransactionsOutput {
  transactions: ExtractedTransaction[]
  currency?: string
}

// ---- Deterministic parsing helpers (pure) ----

const SYMBOL_TO_CODE: Record<string, string> = { '€': 'EUR', '$': 'USD', '£': 'GBP', '¥': 'JPY' }
// A small allowlist so a random 3-letter word in a description is not mistaken for a currency code.
const ISO_CODES: ReadonlySet<string> = new Set([
  'EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF'
])

// A money token MUST end in a 2-digit minor unit (e.g. ",56" / ".56"), so plain integers embedded
// in a description are not mistaken for amounts. Optional leading sign / paren and trailing minus.
const MONEY_RE = /[-+(]?\s*\d[\d.,]*[.,]\d{2}\s*\)?-?/g

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/**
 * Normalize a printed date to ISO `YYYY-MM-DD`, or null if unsupported/invalid. ISO passes through;
 * dotted/slashed forms are read DAY-FIRST (the de-AT target locale). Two-digit years are unsupported
 * (dropped) rather than guessed.
 */
export function parseDate(token: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token)
  if (iso) return isValidYmd(+iso[1], +iso[2], +iso[3]) ? token : null
  const dmy = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(token)
  if (dmy) {
    const d = +dmy[1]
    const m = +dmy[2]
    const y = +dmy[3]
    return isValidYmd(y, m, d) ? `${y}-${pad2(m)}-${pad2(d)}` : null
  }
  return null
}

/**
 * Parse a printed money token to a signed number, or null. Handles leading/trailing sign,
 * parentheses-negative, and `.`/`,` thousand/decimal separators: with both present (or a single
 * separator followed by 1–2 digits) the LAST separator is the decimal point; a single separator
 * followed by exactly 3 digits is treated as a thousands separator.
 */
export function parseAmount(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  const negative = /^\(.*\)$/.test(s) || /^[-]/.test(s) || /-\s*$/.test(s)
  const digits = s.replace(/[^0-9.,]/g, '')
  if (!/[0-9]/.test(digits)) return null
  const lastDot = digits.lastIndexOf('.')
  const lastComma = digits.lastIndexOf(',')
  let normalized: string
  if (lastDot === -1 && lastComma === -1) {
    normalized = digits
  } else {
    const decPos = Math.max(lastDot, lastComma)
    const trailing = digits.length - decPos - 1
    if ((lastDot === -1 || lastComma === -1) && trailing === 3) {
      // single separator type with 3 trailing digits ⇒ thousands, not a decimal point
      normalized = digits.replace(/[.,]/g, '')
    } else {
      const intPart = digits.slice(0, decPos).replace(/[.,]/g, '')
      const fracPart = digits.slice(decPos + 1).replace(/[.,]/g, '')
      normalized = `${intPart}.${fracPart}`
    }
  }
  const value = Number(normalized)
  if (!Number.isFinite(value)) return null
  return negative ? -Math.abs(value) : value
}

/** Detect an ISO-4217 currency from text (an allowlisted 3-letter code or a known symbol), else null. */
export function detectCurrency(text: string): string | null {
  const code = /\b([A-Z]{3})\b/.exec(text)
  if (code && ISO_CODES.has(code[1])) return code[1]
  for (const [sym, c] of Object.entries(SYMBOL_TO_CODE)) if (text.includes(sym)) return c
  return null
}

function parseLine(line: string, page: number | null, statementCurrency: string | null): ExtractedTransaction | null {
  const m = /^(\S+)\s+(.*)$/.exec(line)
  if (!m) return null
  const date = parseDate(m[1])
  if (!date) return null
  const rest = m[2]
  const matches = [...rest.matchAll(MONEY_RE)]
  if (matches.length === 0) return null
  const first = matches[0]
  const description = rest.slice(0, first.index).trim()
  if (!description) return null
  const amount = parseAmount(first[0])
  if (amount === null) return null
  const currency = detectCurrency(line) ?? statementCurrency
  if (!currency) return null
  const row: ExtractedTransaction = { date, description, amount, currency }
  if (matches.length >= 2) {
    const bal = parseAmount(matches[matches.length - 1][0])
    if (bal !== null) row.balanceAfter = bal
  }
  if (page != null) row.sourcePage = page
  return row
}

/** Pure extractor over already-read chunks — emits only fully-valid rows (ambiguous lines dropped). */
export function extractTransactionRows(
  chunks: DocumentChunkRead[],
  statementCurrency: string | null
): ExtractedTransaction[] {
  const rows: ExtractedTransaction[] = []
  for (const chunk of chunks) {
    for (const rawLine of chunk.text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      const row = parseLine(line, chunk.page, statementCurrency)
      if (row) {
        rows.push(row)
        if (rows.length >= MAX_TRANSACTIONS) return rows
      }
    }
  }
  return rows
}

// ---- The tool ----

/**
 * `extract_transactions` (S11a) — read-only over the selected document scope. Reads the document's
 * page-addressable chunks via the narrow `ctx.readDocumentChunks`, parses transaction rows
 * deterministically and offline, and returns the schema-validated rows. It persists nothing (the
 * `run.ts` seam writes the rows); a wrong-shape result fails the run at the gate.
 */
export const extractTransactionsTool: SkillTool = {
  name: 'extract_transactions',
  description:
    'Read the selected bank statement and return its transaction rows (date, description, signed amount, currency) exactly as printed. Read-only; sees only the selected document.',
  permissions: ['read-selected-docs'],
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['documentId'],
    properties: { documentId: { type: 'string', minLength: 1 } }
  },
  outputSchema: EXTRACT_OUTPUT_SCHEMA,
  async run(input, ctx): Promise<ToolResult> {
    if (ctx.signal.aborted) return { ok: false, error: 'This action was cancelled.' }
    const { documentId } = input as { documentId: string }
    let chunks: DocumentChunkRead[]
    try {
      chunks = ctx.readDocumentChunks(documentId)
    } catch {
      // Out-of-scope / unreadable — friendly + content-free; the technical reason is the seam's log.
      return { ok: false, error: 'This statement could not be read.' }
    }
    const statementCurrency = detectCurrency(chunks.map((c) => c.text).join('\n'))
    const transactions = extractTransactionRows(chunks, statementCurrency)
    ctx.onProgress?.({ done: chunks.length, total: chunks.length })
    const output: ExtractTransactionsOutput = { transactions }
    if (statementCurrency) output.currency = statementCurrency
    return { ok: true, output }
  }
}
