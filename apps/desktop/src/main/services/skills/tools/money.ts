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

// A money token is either a figure ending in a 2-digit minor unit (",56" / ".56") OR a bare GROUPED
// integer (a thousands-grouped figure with no decimal tail, e.g. de-AT "1.000" = 1000). A plain
// UNGROUPED integer ("2026", "100") is never a money token, so an account/reference number embedded in
// a description is not mistaken for an amount. Optional leading sign / paren and trailing minus.
//
// THREE alternatives, tried in order (full-audit-2026-06-28 DECISION 2 / TEST-N2 — grouping support):
//   (A) space-grouped:  `\d{1,3}( \d{3})+` with an optional ",dd"/".dd" decimal → "1 234 567,89", "1 234"
//   (B) decimal form:   a digit run (incl. '.'/','/apostrophe grouping) ending in `[.,]\d{2}` →
//                       "1.234,56", "1'234.56", "100,00" (the original form + the Swiss apostrophe sep)
//   (C) bare thousands: `\d{1,3}([.,']\d{3})+` with NO decimal tail → "1.000", "2.500", "1.234.000"
// The trailing `(?!\d)` makes (B) REJECT "1.00" out of "1.000" (it would be followed by a digit), so the
// figure falls through to (C) and reads 1000 — fixing the 1000× understatement where a de-AT "1.000"
// read as €1. The leading `(?<!\d)` anchors a match to a non-digit boundary so a token can never START in
// the MIDDLE of a digit run; the space-grouped form (A) additionally carries `(?<![A-Za-z0-9])` so its
// leading 1–3-digit group only fires at a clean WORD boundary. Together they stop (A) from grabbing the
// 3-digit TAIL of a preceding token and fusing it across the space — whether that tail follows a digit
// (`778899 300.00` → "899 300.00" → 899300, the pdf-layout continuation hazard) or a letter
// (`ref123 456,78` → "123 456,78" → 123456.78, a reference column abutting the amount). `parseAmount`
// then normalises any of these (it already strips spaces/apostrophes and applies the 3-trailing-digit
// thousands rule), so the parse side is unchanged.
//
// Trailing sign/paren — the de-AT negative conventions, SPACE-DISAMBIGUATED (full-audit-2026-06-29 BL-1).
// The trailing region matches ONE of three mutually-exclusive shapes after the magnitude:
//   `-`                    a GLUED trailing minus ("45,90-") — the de-AT debit sign; ALWAYS consume it.
//   `\s*\)`                a close paren ("(45,00)", "(45,00 )") — parens-negative.
//   `\s+-(?!\s*[-+(]?\d)`  a SPACED trailing minus ("45,90 -") only when NOT followed by a figure.
// WHY space-aware (and not the simpler blanket `\s*\)?-?` or `\s*\)?(?:-(?!\s*[-+(]?\d))?`): the old form
// let the trailing `-?` reach ACROSS the column gap and steal the leading minus of the NEXT figure, so
// "2.500,00 -500,00" parsed as amount −2500 / balance +500 (BOTH signs flipped) — and the running-balance
// chain stayed self-consistent, so reconcileBalances reported `ok` on confidently-wrong figures (BL-1).
// The disambiguator is the SPACE: a glued "-" belongs to the figure on its LEFT (a de-AT debit), whereas a
// "-<digit>" after a space is the next figure's leading sign. A first-pass fix that only added the
// `(?!\s*[-+(]?\d)` lookahead to the unconditional trailing `-?` would have REGRESSED the common de-AT row
// "45,90- 1.908,20" (glued debit + running balance) to +45,90, because that lookahead also fires on the
// glued case once `\s*` has run — hence the explicit glued-vs-spaced split here. (The residual genuinely-
// ambiguous "45,90 - 1.908,20" — a spaced trailing minus immediately before a balance figure — reads as a
// positive amount; recorded in docs/known-limitations.md, as no parser can tell it from subtraction.)
//
// ReDoS hardening (S12 audit / vuln-scan 2026-06-21; PRESERVED here): every repeating quantifier is
// BOUNDED or unambiguous, so the scan stays provably linear. The earlier `\s*\d[\d.,]*` form backtracked
// quadratically (O(N²)) on a long digit/separator run lacking a valid decimal tail — a hostile chunk on
// one giant line could freeze the main process. (B)'s grouping run is bounded to 30 chars (a 30-digit
// figure is ~10²³, far beyond any real amount); (A) and (C) repeat a group PINNED by its separator +
// exactly three digits, so the `+` cannot backtrack ambiguously; the leading gap is bounded to 4 spaces.
// The trailing region runs ONLY after a magnitude match (which consumes input, so matches are
// non-overlapping); its `\s*`/`\s+` runs are UNAMBIGUOUS (each is followed by a disjoint atom — `)`,`-`,
// or `[-+(]\d` — so the whitespace class cannot overlap what follows) and the lookahead is zero-width, so
// each trailing scan is bounded by the local whitespace run and the global `matchAll` stays O(N) (the
// ReDoS regression tests pin this on 200k-char adversarial lines). The accepted token set is unchanged
// for every realistic 2-dp figure; only the cross-column sign theft is removed.
export const MONEY_RE =
  /(?<!\d)[-+(]?\s{0,4}(?:(?<![A-Za-z0-9])\d{1,3}(?: \d{3})+(?:[.,]\d{2})?|\d[\d.,']{0,30}[.,]\d{2}|\d{1,3}(?:[.,']\d{3})+)(?!\d)(?:-|\s*\)|\s+-(?!\s*[-+(]?\d))?/g

/** Money equality within half a cent (printed figures carry 2 minor digits). */
export const MONEY_EPS = 0.005

/**
 * Parse a printed money token to a signed number, or null. Handles leading/trailing sign,
 * parentheses-negative, and `.`/`,` thousand/decimal separators: with both present (or a single
 * separator followed by 1–2 digits) the LAST separator is the decimal point; a single separator
 * followed by exactly 3 digits is treated as a thousands separator.
 *
 * **2-dp integer-cent invariant (full-audit-2026-06-29-postmerge T5).** Every returned figure is
 * normalised to the nearest cent (`Math.round(value*100)/100`), so `Math.round(x*100)` is its EXACT
 * cent value — the load-bearing premise of `assessCompleteness`/`reconcileBalances` (which tie out in
 * integer cents) and of CSV `toFixed(2)`. Almost every printed money token is already 2-dp (MONEY_RE's
 * decimal alternative ends in `[.,]\d{2}`); the ONLY way a 3rd decimal reaches here is the
 * both-separator form `1.234,567` (`.` thousands + `,` decimal with a 3-digit minor group), which now
 * reads as 1234.57 rather than 1234.567. **Decision (T5): a >2-dp printed figure is read to the nearest
 * cent — a sub-cent normalisation, never a confidently-wrong magnitude — not dropped.** (The
 * single-separator 3-digit-group thousands forms `1.000`/`12.345` are integers, unaffected — DECISION 2.)
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
  // Pin the 2-dp integer-cent invariant (T5): collapse any sub-cent residue (a >2-dp `1.234,567` form,
  // or float-representation noise) so every emitted figure is exactly k/100 for an integer k.
  const cents = Math.round(Math.abs(value) * 100)
  return (negative ? -cents : cents) / 100
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
 * Whether dotted/slashed dates in a document are day-first (de-AT default) or month-first (US). Inferred
 * per-document by `inferDateOrder`; `parseDate` / `splitLeadingDates` take it as a parameter (BL-N1).
 */
export type DateOrder = 'dmy' | 'mdy'

// A dotted/slashed `nn[./]nn[./]yyyy` token (ISO `yyyy-mm-dd` is unambiguous, so excluded). Used ONLY to
// sniff the document's date ordering in `inferDateOrder` — never to validate a date.
const AMBIGUOUS_DATE_RE = /\b(\d{1,2})[./](\d{1,2})[./]\d{4}\b/g

/**
 * Infer a document's date ordering (full-audit-2026-06-28 BL-N1, DECISION 1a — per-document locale
 * inference). de-AT day-first (`'dmy'`) is the DEFAULT, overridden to month-first (`'mdy'`) ONLY when the
 * document contains at least one UNAMBIGUOUSLY US-ordered date (its SECOND field is 13–31, so it can only
 * be a day → the token must be mm/dd) AND no unambiguously EU-ordered date contradicts it (a token whose
 * FIRST field is 13–31 can only be dd/mm). A document with only fully-ambiguous tokens (every field ≤ 12)
 * — or a self-contradictory mix — keeps the conservative de-AT default. This stops the silent row-drop
 * (a US `12/31/2026` no longer parses to null) and the confidently-wrong month (`03/05/2026` reads as the
 * doc's inferred locale), without guessing on a genuinely ambiguous document.
 *
 * NB: the audit's BL-N1 prose stated the trigger with the fields SWAPPED ("first field > 12 → mm/dd"),
 * which is logically inverted — a first field > 12 can only be a DAY, forcing day-first. The
 * mechanically-correct rule (a SECOND field > 12 forces month-first) is implemented here; the
 * discrepancy is recorded in architecture.md §24 so it is not re-litigated.
 */
export function inferDateOrder(text: string): DateOrder {
  let us = 0
  let eu = 0
  for (const m of text.matchAll(AMBIGUOUS_DATE_RE)) {
    const a = +m[1]
    const b = +m[2]
    if (b > 12 && b <= 31 && a <= 12) us++ // second field can only be a day ⇒ month-first
    else if (a > 12 && a <= 31 && b <= 12) eu++ // first field can only be a day ⇒ day-first
  }
  return us > 0 && eu === 0 ? 'mdy' : 'dmy'
}

/**
 * Normalize a printed date to ISO `YYYY-MM-DD`, or null if unsupported/invalid. ISO passes through.
 * Dotted/slashed forms are read DAY-FIRST by default (the de-AT target locale); pass `order: 'mdy'` to
 * read them month-first (the US ordering inferred per-document by `inferDateOrder`, BL-N1). Two-digit
 * years are unsupported (dropped) rather than guessed.
 */
export function parseDate(token: string, order: DateOrder = 'dmy'): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token)
  if (iso) return isValidYmd(+iso[1], +iso[2], +iso[3]) ? token : null
  const m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(token)
  if (m) {
    const f1 = +m[1]
    const f2 = +m[2]
    const y = +m[3]
    const d = order === 'mdy' ? f2 : f1
    const mo = order === 'mdy' ? f1 : f2
    return isValidYmd(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : null
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
 * `order` (default day-first) is the per-document ordering from `inferDateOrder` (BL-N1).
 *
 * The money scanner's OTHER users (`lastMoneyOnLine` / balance / invoice-total readers) take the LAST
 * token, which a TRAILING date can corrupt — a balance line shaped `Endsaldo 1.234,56 EUR per 30.06.2026`
 * read `30.06.20` → 3006.20 (full-audit-2026-06-28 BL-N2, correcting the earlier "never affected" claim).
 * Those readers therefore scrub ALL date tokens via `stripDateTokens` BEFORE the money scan (handling a
 * date at EITHER end), rather than splitting only leading dates here.
 */
export function splitLeadingDates(line: string, order: DateOrder = 'dmy'): { dates: string[]; rest: string } {
  const dates: string[] = []
  let rest = line
  // Cap at two leading dates (booking + value) — a third date-shaped leading token is not a real column.
  while (dates.length < 2) {
    const m = /^(\S+)\s+(.*)$/.exec(rest)
    if (!m) break
    const d = parseDate(m[1], order)
    if (!d) break
    dates.push(d)
    rest = m[2]
  }
  return { dates, rest }
}

// A date-shaped token: dotted/slashed `d?d[./]m?m[./]yyyy` or ISO `yyyy-mm-dd`. Order-agnostic — it
// removes the whole token regardless of dmy/mdy (it never parses the fields). It is intentionally
// stricter than a money token: a grouped figure like `1.234,56` / `35.037,04` is NOT a date (its third
// group is not a bare 4-digit year), so scrubbing dates never eats a real amount.
const DATE_TOKEN_RE = /\b\d{1,2}[./]\d{1,2}[./]\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/g

/**
 * Remove every date-shaped token from a line, replacing it with a space (BL-N2). The LAST-money balance/
 * total readers (`lastMoneyOnLine`, invoice `lastMoney`) call this first, so a date at EITHER end of the
 * line — the de-AT `Kontostand per <date> <figure>` (date leads) AND the `Endsaldo <figure> EUR per
 * <date>` (date trails) — can never be the token the money scan reads.
 */
export function stripDateTokens(line: string): string {
  return line.replace(DATE_TOKEN_RE, ' ')
}

// ---- Word-bounded substring test (shared by both categorization paths) ----

/**
 * A WORD-bounded substring test (case-folded by the caller). `\b` is ASCII-only and would mishandle the
 * German keywords (`gebühr`, `überweisung`), so the boundary is checked against the Unicode letter/number
 * classes. Shared so the DETERMINISTIC categorizer (`categorizeRow`) and the LLM PRE-FILTER
 * (`prefilterCategory`) agree on every description rule (audit C-1).
 *
 * Two modes (full-audit-2026-06-29 BL-3):
 *  - STRICT (default): the needle must be flanked by a non-letter/digit (or a string edge) on BOTH sides
 *    — a standalone word. Required for short, ambiguous tokens where a coincidental substring would be a
 *    confident WRONG match (`fee` ⊂ `coffee`, `atm` ⊂ `atmos`, and `lohn` ⊂ `muehlohn`/`Belohnung`).
 *  - COMPOUND (`compound=true`): a boundary on EITHER side suffices. German forms CLOSED compounds, so a
 *    keyword sits at a morpheme seam that is a word edge on only one side (`kontoführungs+GEBÜHR`,
 *    `BARGELD+behebung`, `GEHALTS+zahlung`). The C-1 strict rule made these never match, dropping de-AT
 *    fees/transfers into the generic Spending bucket. One-sided (not raw substring) still rejects a
 *    keyword buried with letters on BOTH sides, so it is the conservative relaxation. Reserved for the
 *    unambiguous DE compound-prone keywords (the rule table opts in per-keyword) — NOT the short English
 *    tokens, which keep STRICT.
 */
export function wordIncludes(haystack: string, needle: string, compound = false): boolean {
  const isLetterDigit = (c: string): boolean => c !== '' && /[\p{L}\p{N}]/u.test(c)
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) {
    const before = i === 0 ? '' : haystack[i - 1]
    const after = i + needle.length >= haystack.length ? '' : haystack[i + needle.length]
    const beforeOk = !isLetterDigit(before)
    const afterOk = !isLetterDigit(after)
    if (compound ? beforeOk || afterOk : beforeOk && afterOk) return true
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
