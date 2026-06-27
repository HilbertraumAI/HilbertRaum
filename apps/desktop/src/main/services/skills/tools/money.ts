// Shared, PURE money/date/CSV helpers for the Tier-2 content-class tools (architecture.md "Skills —
// design record" §8). Extracted so the bank-statement and invoice tools parse figures the SAME way
// rather than duplicating subtly-divergent regexes — the de-AT target locale's "1.234,56"/day-first
// dates and the §22-D1 honesty posture (quote only what parses; drop the ambiguous) must be identical
// across domains. No node:fs, no network, no native deps (CLAUDE.md §0); the bank/invoice tools
// re-export these so existing import sites keep working.

// ---- Currency detection ----

const SYMBOL_TO_CODE: Record<string, string> = { '€': 'EUR', '$': 'USD', '£': 'GBP', '¥': 'JPY' }
// A small allowlist so a random 3-letter word in a description is not mistaken for a currency code.
const ISO_CODES: ReadonlySet<string> = new Set([
  'EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF'
])

/**
 * Detect an ISO-4217 currency from text (an allowlisted 3-letter code or a known symbol), else null.
 * It scans ALL 3-letter uppercase tokens for the first allowlisted code, so a non-currency token like
 * an invoice number's "INV" never blocks a later "EUR"; a random 3-letter word is still ignored.
 */
export function detectCurrency(text: string): string | null {
  for (const m of text.matchAll(/\b([A-Z]{3})\b/g)) {
    if (ISO_CODES.has(m[1])) return m[1]
  }
  for (const [sym, c] of Object.entries(SYMBOL_TO_CODE)) if (text.includes(sym)) return c
  return null
}

// ---- Amounts ----

// A money token MUST end in a 2-digit minor unit (e.g. ",56" / ".56"), so plain integers embedded
// in a description are not mistaken for amounts. Optional leading sign / paren and trailing minus.
//
// ReDoS hardening (S12 audit / vuln-scan 2026-06-21): every repeating quantifier is BOUNDED so the
// scan is provably linear. The earlier `\s*\d[\d.,]*` form backtracked quadratically (O(N²)) on a
// long digit/separator (or whitespace) run lacking a valid decimal tail — a hostile statement/invoice
// whose chunk is one giant line could freeze the main process. Bounding the integer/grouping run to 30
// chars (a 30-digit figure is ~10²³ — far beyond any real printed amount) and the leading gap to 4
// spaces makes each match attempt O(1), so the global `matchAll` is O(N). The trailing `\s*` is left
// unbounded: only OPTIONAL atoms follow it, so it can never drive a failure-backtrack. The accepted
// token set is unchanged for every realistic figure (the unit tests pin the parse behaviour).
export const MONEY_RE = /[-+(]?\s{0,4}\d[\d.,]{0,30}[.,]\d{2}\s*\)?-?/g

/** Money equality within half a cent (printed figures carry 2 minor digits). */
export const MONEY_EPS = 0.005

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

// ---- Dates ----

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
 * Split the LEADING date column(s) off a printed transaction/line-item row (backend audit 2026-06-27,
 * BL-1). Returns the ISO dates found at the very start of the line (in order — typically a booking date
 * then an optional value/settlement date) and the remaining text after them.
 *
 * **Why this exists.** A DACH statement row often prints BOTH a booking date (Buchungstag) and a value
 * date (Wertstellung/Valuta) as its first two columns. Reading only the FIRST whitespace token as the
 * date left the value date in the text handed to the `MONEY_RE` scan — where `MONEY_RE` reads its
 * `dd.mm.20yy` tail as a 2-decimal amount (`07.06.2026` → `07.06.20` → 706.20). That either made the
 * value date the row's first "money" match (empty description → the row silently DROPPED) or fed a wrong
 * figure into the amount. Consuming the WHOLE leading run of date tokens (not just the first) keeps the
 * value-date column out of the money scan; it also handles either column ORDER (booking-first or
 * value-first) since both sit in the leading date region.
 *
 * Conservative by construction: it stops at the first NON-date token, so a description is never consumed,
 * and it is capped at two dates (booking + value) so a date-shaped FIRST word of a description cannot eat
 * the whole row. `dates` is empty when the line does not begin with a date (the caller then drops it).
 * The money scanner's other users (`lastMoneyOnLine`/balance/invoice-total readers) take the LAST token,
 * not the first, so they were never affected and are deliberately left untouched.
 */
export function splitLeadingDates(line: string): { dates: string[]; rest: string } {
  const dates: string[] = []
  let rest = line
  // Cap at two leading dates (booking + value) — a third date-shaped leading token is not a real column.
  while (dates.length < 2) {
    const m = /^(\S+)\s+(.*)$/.exec(rest)
    if (!m) break
    const d = parseDate(m[1])
    if (!d) break
    dates.push(d)
    rest = m[2]
  }
  return { dates, rest }
}

// ---- Word-bounded substring test (shared by both categorization paths) ----

/**
 * A WORD-bounded substring test (case-folded by the caller): the needle must be flanked by a
 * non-letter/digit (or a string edge) on both sides. `\b` is ASCII-only and would mishandle the German
 * keywords (`gebühr`, `überweisung`), so the boundary is checked against the Unicode letter/number
 * classes. This stops a coincidental substring from a confident WRONG match (`fee` ⊂ `coffee`,
 * `atm` ⊂ `atmos`, `lohn` ⊂ `mühlohn`). Shared so the DETERMINISTIC categorizer (`categorizeRow`) and
 * the LLM PRE-FILTER (`prefilterCategory`) agree on every description rule (audit C-1).
 */
export function wordIncludes(haystack: string, needle: string): boolean {
  const isLetterDigit = (c: string): boolean => c !== '' && /[\p{L}\p{N}]/u.test(c)
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) {
    const before = i === 0 ? '' : haystack[i - 1]
    const after = i + needle.length >= haystack.length ? '' : haystack[i + needle.length]
    if (!isLetterDigit(before) && !isLetterDigit(after)) return true
  }
  return false
}

// ---- CSV escaping + formula-injection neutralization (the export-file boundary) ----

// A field that can be executed as a FORMULA when the CSV is opened in Excel / LibreOffice / Google
// Sheets (CSV / spreadsheet "formula injection"). The extracted text is the user's OWN document, but
// a crafted document could embed a payload that only surfaces at the one real FS-write boundary, so
// the export seam neutralizes it (S12 audit, F4). Two shapes are caught: a leading control char
// (`\t`/`\r`, the DDE/auto-exec vector), and a formula trigger (`= + - @`) after OPTIONAL leading
// whitespace — some importers trim leading spaces before evaluating, so `"  =cmd"` is dangerous too.
const CSV_FORMULA_LEAD = /^[\t\r]|^\s*[=+\-@]/

/**
 * RFC-4180-ish field escaping with formula-injection neutralization. A value that begins with a
 * spreadsheet formula trigger (`= + - @`, tab, CR) is prefixed with a single quote so the cell is
 * read as text; then the value is quoted when it carries a comma, quote, or newline. Numeric columns
 * are formatted separately (`toFixed`) and never pass through here, so a negative amount is
 * unaffected — only free-text fields (descriptions et al.) are neutralized.
 */
export function csvField(value: string): string {
  const safe = CSV_FORMULA_LEAD.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}
