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

// ---- Unicode normalization pre-pass (audit §5.3) ----

/**
 * Normalize the Unicode "side doors" that make the money/date regexes silently MISREAD a figure — run at
 * every extractor entry point BEFORE any `MONEY_RE` / `parseAmount` / date scan sees the text, so all
 * downstream regexes operate on clean ASCII. A de-AT PDF routinely prints all three classes:
 *  - MINUS-like dashes → ASCII '-': U+2212 MINUS SIGN, U+2013 EN DASH, U+2011 NON-BREAKING HYPHEN.
 *    `MONEY_RE`'s sign class is ASCII-only, so an un-normalized debit '−45,90' (U+2212) loses its sign and
 *    reads +45.90 — debits parse as credits (audit §5.3, first bullet).
 *  - NO-BREAK SPACE family → ASCII space: U+00A0 NBSP, U+202F NARROW NBSP, U+2007 FIGURE SPACE. These are
 *    the thousands separators a German layout prints ('1 234,56'); left un-normalized `MONEY_RE`'s
 *    space-grouped alternative (which matches an ASCII space) never fires and the figure truncates to its
 *    last group — a 1000× magnitude error (audit §5.3, second bullet).
 *  - U+2019 RIGHT SINGLE QUOTATION MARK → ASCII apostrophe "'": the Swiss thousands separator ('1’234.56'),
 *    which `MONEY_RE`'s apostrophe-grouping alternative reads (it accepts the ASCII apostrophe only).
 *
 * PURE and IDEMPOTENT: ASCII-only input is returned byte-identical (so ASCII fixtures are unaffected), and
 * applying it twice equals applying it once (entry points may normalize text a downstream reader also
 * normalizes). The geometry path (`pdf-layout.ts`) carries a PRIVATE copy of these rules — it must not
 * import this skills-layer module (same wrong-direction-dependency rationale as its duplicated
 * `CURRENCY_TOKEN_RE`); keep the two in sync.
 */
export function normalizeExtractionText(s: string): string {
  return s
    .replace(/[\u2212\u2013\u2011]/g, '-') // MINUS SIGN / EN DASH / NON-BREAKING HYPHEN
    .replace(/[\u00A0\u202F\u2007]/g, ' ') // NBSP / NARROW NBSP / FIGURE SPACE
    .replace(/\u2019/g, "'") // RIGHT SINGLE QUOTATION MARK
}

// ---- Extraction text quality (invoice-hardening-2026-07-04 P3) ----

/**
 * A line is GLYPH-SOUP-shaped when its tokens fragment into single glyphs: a run of \u2265 3 single-character
 * tokens ("1 0 % 3", "P O S I T I O N"), or a token-rich line (\u2265 6 tokens) where nearly half the tokens
 * are single glyphs. A per-glyph or column-fused PDF text layer (the reading-order concatenation of
 * fragmented pdf.js text items) produces exactly this shape; a clean invoice line \u2014 even a columnar
 * "Widget   2   50,00   100,00" \u2014 does not (its column tokens are multi-character figures).
 */
function isGlyphSoupLine(line: string): boolean {
  const tokens = line.split(/\s+/)
  let run = 0
  let maxRun = 0
  let single = 0
  for (const t of tokens) {
    if (t.length === 1) {
      run++
      single++
      if (run > maxRun) maxRun = run
    } else {
      run = 0
    }
  }
  if (maxRun >= 3) return true
  return tokens.length >= 6 && single / tokens.length >= 0.45
}

/**
 * Whether a document's extracted text layer looks GLYPH-MANGLED \u2014 enough soup-shaped lines that the
 * line-oriented extractors read fragments, not fields (the real-transcript incident: line-item
 * descriptions like "1   0 % 3   Article" and totals scraped from "$   914   =   $"). Deterministic and
 * deliberately CONSERVATIVE (an absolute floor AND a ratio, so one decorative spaced-out heading never
 * flags a clean document): at least 3 soup-shaped non-empty lines AND \u2265 20% of all non-empty lines.
 * Shared here (beside `normalizeExtractionText`) so any extraction entry point can assess its input;
 * the invoice extractor stamps the verdict as `textQuality: 'suspect'` for the answer layer.
 */
export function looksLikeGlyphSoup(texts: readonly string[]): boolean {
  let nonEmpty = 0
  let soupy = 0
  for (const text of texts) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      nonEmpty++
      if (isGlyphSoupLine(line)) soupy++
    }
  }
  return soupy >= 3 && soupy / nonEmpty >= 0.2
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

/**
 * Detect the DOCUMENT/statement-level currency by MAJORITY VOTE over the figure-adjacent currency of
 * money-bearing lines (full-audit-2026-06-29 follow-up, FIN-1). It exists because the per-row extractors
 * fall back to a document currency when a bare-amount row prints no figure-adjacent code (the de-AT norm),
 * and the old fallback — `detectCurrency(joined)`, "first allowlisted code anywhere wins over the WHOLE
 * text" — let a stray `USD`/`CHF` in a payee MEMO stamp a whole EUR statement (and its VERIFIED total)
 * with the wrong ISO code: the mislabel was UNIFORM, so the mixed-currency guard never tripped.
 *
 * The rule, per line:
 *  - a MONEY-bearing line votes only on its FIGURE REGION (the text from the first money token onward) —
 *    a currency word in the description/memo sits LEFT of the amount and is excluded (mirrors the per-row
 *    BL-2/F3 figure-region scoping);
 *  - a NON-money line (a header/label like `Währung EUR`, `Currency: USD`) votes on its whole text, so a
 *    statement that declares its currency only in the header (and prints bare amounts) is still detected.
 * The winner is the most-voted code; a tie is broken by FIRST appearance (document order). A genuinely
 * foreign statement (code adjacent to its amounts) is detected; a truly-mixed statement still reaches the
 * mixed/unverified path because the PER-ROW detection tags each row's own figure-region currency — this
 * function only supplies the fallback for bare rows. Returns null when no allowlisted code/symbol appears
 * in any voting region (the extractor then drops currency-less rows rather than invent one — §22-D1).
 */
export function detectDocumentCurrency(text: string): string | null {
  const counts = new Map<string, number>()
  const order: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    // Scrub date tokens first (as the last-money readers do): a leading `dd.mm.yyyy` booking date would
    // otherwise be read by MONEY_RE as a 2-dp amount (`05.03.2026` → `05.03.20`), making the "figure
    // region" start at the date and re-include the very memo we mean to exclude.
    const scrubbed = stripDateTokens(line)
    const matches = [...scrubbed.matchAll(MONEY_RE)]
    // Money line → figure region (right of the first amount, excluding a left memo); else the whole line.
    const region = matches.length > 0 ? scrubbed.slice(matches[0].index) : scrubbed
    let cur = detectCurrency(region)
    // A code IMMEDIATELY left of the first figure (`<desc> EUR 19,15-` — the per-row currency-CELL
    // layout HVB-style exports print) is figure-ADJACENT, not a memo, so it votes too (R7 review): the
    // SKA-2 scrub widening removed such dd.mm.yy lines' only vote by accident (the unscrubbed date used
    // to BE the first "money" match, so the region started left of the code). Adjacency — only
    // whitespace between the code and the figure — keeps the FIN-1 memo exclusion intact (`USD Memo
    // -12,00 …` still never votes).
    if (!cur && matches.length > 0) {
      const adjacent = /\b([A-Z]{3})\s*$/.exec(scrubbed.slice(0, matches[0].index))
      if (adjacent) cur = detectCurrency(adjacent[1])
    }
    if (!cur) continue
    if (!counts.has(cur)) order.push(cur)
    counts.set(cur, (counts.get(cur) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const cur of order) {
    const c = counts.get(cur) as number
    if (c > bestCount) {
      best = cur
      bestCount = c
    }
  }
  return best
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

/**
 * A document-level YEAR anchor for completing dates that print no 4-digit year (R5, audit §5.7). It is the
 * first fully-printed `dd.mm.yyyy` / ISO date in the document (`inferDateAnchor`), and it supplies:
 *  - the CENTURY for a 2-digit year `dd.mm.yy` (→ `century + yy`), and
 *  - the YEAR + MONTH for a BARE `dd.mm.` date, whose year is chosen by cross-year month-rollover
 *    (`rollAnchorYear`): a December row on a January-anchored statement is the PREVIOUS year.
 * Without an anchor `parseDate` keeps DROPPING 2-digit/bare dates (drop-don't-guess stands, §22-D1). This
 * ports the geometry path's `toFullDate`/`resolvePageAnchor` behaviour to the plain/CSV path (which had none
 * — a `dd.mm.yy` CSV statement extracted ZERO rows).
 */
export interface DateAnchor {
  year: number
  /** The anchor date's month (1–12) — the cross-year rollover reference. */
  month: number
}

/**
 * The result of `inferDateOrderResult`: the chosen order plus WHETHER that choice rests on evidence. The
 * `inferred` flag is persisted (`bank_statements`/`invoices`.`date_order_inferred`) and drives the answer's
 * one honest date caveat. It is `'default'` — the caveat-worthy state — ONLY when the order was NOT cleanly
 * established by an unambiguous date AND the document actually carries an order-AMBIGUOUS dotted/slashed
 * date (both fields ≤ 12), whose reading therefore depended on the day-first guess. A document with only
 * ISO or only unambiguous dates is `'evidence'` (the day-first guess changed nothing), so the caveat never
 * fires spuriously. (The single additive column thus encodes exactly "should the day-first caveat show?".)
 */
export interface DateOrderResult {
  order: DateOrder
  inferred: 'evidence' | 'default'
}

// A dotted/slashed `nn[./]nn[./](yy|yyyy)?` token (ISO `yyyy-mm-dd` is unambiguous, so excluded). Used ONLY
// to sniff the document's date ordering AND its order-ambiguity in `inferDateOrderResult` — never to
// validate a date. Two forms: ANCHORED (a whole leading token, for a transaction row's booking-date column)
// and GLOBAL (any date on a money-less header/label line).
//
// The ANCHORED form accepts an OPTIONAL 2-digit / absent year (R5, audit §5.7): the year field mirrors
// `parseDate`'s `(\d{2}|\d{4})?`, keeping the SECOND separator required (so a decimal `28.12` is never a
// date). Without this, the `dd.mm.yy` / bare `dd.mm.` dates R5 newly PARSES (day-first) would never register
// in the vote — so a genuinely day-first-GUESSED statement would neither infer the right order (a US
// `12/31/26` row) nor flag `date_order_inferred='default'` (the honesty caveat would silently miss the exact
// cohort it protects). The GLOBAL form stays 4-digit-year: a bare/2-digit date's `dd.mm` is money-shaped, so
// it is classified as a transaction row and only ever reaches the ANCHORED leading-token path — a money-LESS
// header/label line that carries a date carries a fully-printed 4-digit year (an invoice `Invoice date …`).
const AMBIGUOUS_DATE_TOKEN_RE = /^(\d{1,2})[./](\d{1,2})[./](?:\d{2}|\d{4})?$/
const AMBIGUOUS_DATE_GLOBAL_RE = /\b(\d{1,2})[./](\d{1,2})[./]\d{4}\b/g

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
 * **A payee/description MEMO date must not vote (full-audit-2026-06-29 follow-up, FIN-4).** The earlier
 * whole-text scan let a SINGLE foreign-format date inside a transaction MEMO (`… ORDER 03/15/2026 …`,
 * second field 15 → US) flip an entire de-AT statement to month-first → every dotted `dd.mm.yyyy` booking
 * date with day ≤ 12 silently day/month-swapped (all still valid dates → none dropped → fully silent; the
 * completeness gate checks balances, not dates). The vote is therefore scoped by line KIND:
 *  - a line that carries a MONEY token is a transaction-style row → only its LEADING run of date-shaped
 *    tokens may vote (the booking + optional value-date columns — the region `splitLeadingDates` consumes,
 *    capped at two); the scan stops at the first non-date token, so a memo date deeper in the row never
 *    votes. A genuine US statement (whose ROWS lead with `mm/dd/yyyy`) still flips on its leading column.
 *  - a MONEY-less line is a header/label/period line — an invoice `Invoice date 06/15/2026`, a statement
 *    period — where a date is legitimate context, not a payee memo. ANY date on it votes (the invoice's
 *    header dates are NOT leading the line, so the leading-column rule alone would miss them and break US
 *    invoice detection — the reason the rule is split by line kind, not applied uniformly).
 *
 * NB: the audit's BL-N1 prose stated the trigger with the fields SWAPPED ("first field > 12 → mm/dd"),
 * which is logically inverted — a first field > 12 can only be a DAY, forcing day-first. The
 * mechanically-correct rule (a SECOND field > 12 forces month-first) is implemented here; the
 * discrepancy is recorded in architecture.md §24 so it is not re-litigated.
 */
export function inferDateOrder(text: string): DateOrder {
  return inferDateOrderResult(text).order
}

/**
 * Like `inferDateOrder`, but also reports whether the day-first/month-first choice rests on EVIDENCE or on
 * the conservative DEFAULT (R5, audit §5.7-low — ambiguous-date honesty). The `inferred` flag is persisted
 * and drives the answer's single date caveat (see {@link DateOrderResult}). It is `'default'` only when the
 * order was NOT determined by a clean single-sided unambiguous vote AND at least one order-ambiguous
 * dotted/slashed date (both fields ≤ 12) was present — the exact case where the reader silently applied
 * day-first with nothing in the document to justify it.
 */
export function inferDateOrderResult(text: string): DateOrderResult {
  let us = 0
  let eu = 0
  let ambiguous = 0
  const vote = (a: number, b: number): void => {
    if (a <= 12 && b <= 12) ambiguous++ // both fields could be the month ⇒ order-ambiguous (needs the guess)
    if (b > 12 && b <= 31 && a <= 12) us++ // second field can only be a day ⇒ month-first
    else if (a > 12 && a <= 31 && b <= 12) eu++ // first field can only be a day ⇒ day-first
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.match(MONEY_RE)) {
      // Transaction-style row: only the LEADING date column(s) vote — a memo date deeper in the row can't.
      const tokens = line.split(/\s+/)
      for (let i = 0; i < Math.min(2, tokens.length); i++) {
        const m = AMBIGUOUS_DATE_TOKEN_RE.exec(tokens[i])
        if (!m) break // not (or no longer) a leading date column → don't scan into the description
        vote(+m[1], +m[2])
      }
    } else {
      // Header/label/period line (no money) — a date here is legitimate context, so any date votes.
      for (const m of line.matchAll(AMBIGUOUS_DATE_GLOBAL_RE)) vote(+m[1], +m[2])
    }
  }
  const order: DateOrder = us > 0 && eu === 0 ? 'mdy' : 'dmy'
  // Clean single-sided evidence (exactly one side voted) ⇒ 'evidence'. Otherwise the order is the de-AT
  // DEFAULT (no unambiguous dates, or a self-contradictory mix); flag it 'default' — caveat-worthy — only
  // if an order-ambiguous date was actually read, so a doc with only ISO/unambiguous dates never caveats.
  const cleanEvidence = (us > 0) !== (eu > 0)
  const inferred: 'evidence' | 'default' = !cleanEvidence && ambiguous > 0 ? 'default' : 'evidence'
  return { order, inferred }
}

// The first fully-printed 4-digit-year date anywhere in the document (dotted/slashed or ISO), used as the
// year ANCHOR for completing 2-digit / bare dates in `parseDate` (R5). `(?<!\d)`/`(?!\d)` pin the match to
// a clean numeric boundary so it can't start mid-digit-run; the alternation is BOUNDED (fixed digit
// counts), so the scan stays linear. A grouped amount like `1.234,56` is NOT matched (its tail is a
// 2-digit minor unit, not a 4-digit year).
const FULL_YEAR_DATE_SCAN_RE = /(?<!\d)\d{1,2}[./]\d{1,2}[./]\d{4}(?!\d)|(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g

/**
 * Infer the document's YEAR anchor (R5, audit §5.7) — the year+month of the FIRST fully-printed 4-digit-year
 * date in the document, order-aware so the month is read per the document's own `dmy`/`mdy` ordering. Mirrors
 * the geometry path's `resolvePageAnchor` (first full date wins). Returns null when the document prints no
 * 4-digit-year date at all — then `parseDate` keeps dropping 2-digit/bare dates (drop-don't-guess).
 */
export function inferDateAnchor(text: string, order: DateOrder = 'dmy'): DateAnchor | null {
  for (const m of text.matchAll(FULL_YEAR_DATE_SCAN_RE)) {
    const iso = parseDate(m[0], order)
    if (iso) {
      const [y, mo] = iso.split('-')
      return { year: +y, month: +mo }
    }
  }
  return null
}

/**
 * Cross-year statement month-rollover (R5, audit §5.7): a BARE date (no printed year) belongs to the
 * adjacent year when its month sits on the far side of a year boundary from the document's anchor month — a
 * Nov/Dec row on a Jan/Feb-anchored statement is the PREVIOUS year, and the mirror case (a Jan/Feb row on a
 * Nov/Dec-anchored statement) is the NEXT year. A mid-year anchor (month 3–10), or a row month near the
 * anchor, keeps the anchor year. Symmetric with the geometry path's private copy in `pdf-layout.ts` (which
 * must not import this skills-layer module — same wrong-direction-dependency rule as `normalizeExtractionText`).
 */
function rollAnchorYear(month: number, anchor: DateAnchor): number {
  if (month >= 11 && anchor.month <= 2) return anchor.year - 1
  if (month <= 2 && anchor.month >= 11) return anchor.year + 1
  return anchor.year
}

/**
 * Normalize a printed date to ISO `YYYY-MM-DD`, or null if unsupported/invalid. ISO passes through.
 * Dotted/slashed forms are read DAY-FIRST by default (the de-AT target locale); pass `order: 'mdy'` to
 * read them month-first (the US ordering inferred per-document by `inferDateOrder`, BL-N1).
 *
 * **Year completion (R5, audit §5.7 — port of the geometry path's `toFullDate`).** A full 4-digit-year date
 * always parses. A 2-digit-year `dd.mm.yy` or a BARE `dd.mm.` date parses ONLY when an `anchor` is supplied
 * (the document's own year, from `inferDateAnchor`): the century is taken from the anchor for `yy`, and a
 * bare date takes the anchor year with cross-year month-rollover (`rollAnchorYear`). Without an anchor a
 * 2-digit/bare date is DROPPED (drop-don't-guess, §22-D1) — exactly the prior behaviour, so every existing
 * anchor-less call site is byte-identical. The second separator is REQUIRED (`28.12.`, not `28.12`) so a
 * decimal price is never read as a date on the plain/CSV path.
 */
export function parseDate(token: string, order: DateOrder = 'dmy', anchor?: DateAnchor | null): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token)
  if (iso) return isValidYmd(+iso[1], +iso[2], +iso[3]) ? token : null
  const m = /^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})?$/.exec(token)
  if (m) {
    const f1 = +m[1]
    const f2 = +m[2]
    const d = order === 'mdy' ? f2 : f1
    const mo = order === 'mdy' ? f1 : f2
    const yRaw = m[3]
    let y: number
    if (yRaw !== undefined && yRaw.length === 4) {
      y = +yRaw
    } else if (anchor) {
      if (yRaw !== undefined) {
        y = Math.floor(anchor.year / 100) * 100 + +yRaw // 2-digit year → the anchor's century window
      } else {
        y = rollAnchorYear(mo, anchor) // bare date → the anchor year, with cross-year month-rollover
      }
    } else {
      return null // 2-digit / bare year with no document anchor → drop, don't guess
    }
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
 * `order` (default day-first) is the per-document ordering from `inferDateOrder` (BL-N1). `anchor` (R5) is
 * the document year anchor; without it a leading 2-digit/bare date parses to null and the run stops there.
 *
 * The money scanner's OTHER users (`lastMoneyOnLine` / balance / invoice-total readers) take the LAST
 * token, which a TRAILING date can corrupt — a balance line shaped `Endsaldo 1.234,56 EUR per 30.06.2026`
 * read `30.06.20` → 3006.20 (full-audit-2026-06-28 BL-N2, correcting the earlier "never affected" claim).
 * Those readers therefore scrub ALL date tokens via `stripDateTokens` BEFORE the money scan (handling a
 * date at EITHER end), rather than splitting only leading dates here. Since R7 (SKA-1) the ROW parsers
 * (`parseLine`/`parseLineItem`) also scrub — over the SAME-LENGTH `blankDateTokens` copy, so their
 * description/figure-region byte offsets survive — closing the old asymmetry where only the last-money
 * readers were date-safe and a MID-LINE date became an invented row amount.
 */
export function splitLeadingDates(
  line: string,
  order: DateOrder = 'dmy',
  anchor?: DateAnchor | null
): { dates: string[]; rest: string } {
  const dates: string[] = []
  let rest = line
  // Cap at two leading dates (booking + value) — a third date-shaped leading token is not a real column.
  while (dates.length < 2) {
    const m = /^(\S+)\s+(.*)$/.exec(rest)
    if (!m) break
    const d = parseDate(m[1], order, anchor)
    if (!d) break
    dates.push(d)
    rest = m[2]
  }
  return { dates, rest }
}

// A date-shaped token: dotted/slashed `d?d[./]m?m[./](yy|yyyy)` or ISO `yyyy-mm-dd`. Order-agnostic — it
// removes the whole token regardless of dmy/mdy (it never parses the fields). It is intentionally
// stricter than a money token: a grouped figure like `1.234,56` / `35.037,04` is NOT a date (its third
// group is not a bare year), so scrubbing dates never eats a real amount.
//
// The 2-DIGIT-YEAR alternative (SKA-2, skills-audit-2026-07-03): `31.03.26` is money-shaped (`MONEY_RE`
// reads its `.26` tail as a minor unit → 3103.26), and the old 4-digit-only scrub left it in place — so a
// balance/total line `Endsaldo 1.234,56 EUR per 31.03.26` read the DATE as the figure, a `Datum: 15.03.26`
// invoice line fell through as a phantom item, and money-less dd.mm.yy period lines inflated
// `droppedRowCount` — even though R5 made dd.mm.yy documents a first-class parsed cohort. The alternative
// is guarded on BOTH sides so it can never eat part of a real amount: `\b` refuses to start mid-digit-run,
// and the `(?!\d)(?![.,']\d)` lookahead refuses a "year" that CONTINUES into more digits (`31.03.265`, the
// 4-digit form's `01.04.20` prefix — the 4-digit alternative then takes that token whole) or into a
// separator-plus-digit (`31.03.26,50`, `26'000` Swiss grouping, dotted numeric codes `12.34.56.78`) —
// while accepting terminal PUNCTUATION (`per 31.03.26.` / `vom 15.03.26,` mid-sentence), which the
// adversarial R7 review showed a plain `(?![\d.,'])` wrongly treated as a continuation, un-fixing SKA-2
// on any punctuation-trailed date. `1.234,56`, `35.037,04`, `1'234.56` are structurally unreachable
// (separator classes + `\b`), lookahead aside.
const DATE_TOKEN_RE =
  /\b\d{1,2}[./]\d{1,2}[./]\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}[./]\d{2}(?!\d)(?![.,']\d)/g

/**
 * Remove every date-shaped token from a line, replacing it with a space (BL-N2). The LAST-money balance/
 * total readers (`lastMoneyOnLine`, invoice `lastMoney`) call this first, so a date at EITHER end of the
 * line — the de-AT `Kontostand per <date> <figure>` (date leads) AND the `Endsaldo <figure> EUR per
 * <date>` (date trails) — can never be the token the money scan reads.
 */
export function stripDateTokens(line: string): string {
  return line.replace(DATE_TOKEN_RE, ' ')
}

/**
 * Like `stripDateTokens`, but SAME-LENGTH: every date-shaped token is overwritten with spaces, so byte
 * OFFSETS into the original line stay valid (SKA-1, skills-audit-2026-07-03). The row parsers
 * (`parseLine` / `parseLineItem`) run their `MONEY_RE` scan over the blanked copy — a MID-LINE date
 * (`01.04.2026 bis 30.04.2026`, or its dd.mm.yy twin) can then never be read as an amount — while the
 * `description` slice and the figure-region currency slice keep using the ORIGINAL text at the matched
 * indices; a scrub that changed the length would silently shift both.
 */
export function blankDateTokens(line: string): string {
  return line.replace(DATE_TOKEN_RE, (m) => ' '.repeat(m.length))
}

/** One money match from `scanMoneyWithBlankedDates`: the (possibly tail-truncated) token + its index —
 *  both valid in the blanked AND the original text (same length). */
export interface BlankedMoneyMatch {
  token: string
  index: number
}

/**
 * The SKA-1 row money scan: `MONEY_RE` over the same-length date-BLANKED copy of `rest`, with each
 * match's TRAILING sign/paren re-validated against the ORIGINAL bytes. The trailing region's whitespace
 * runs (`\s*\)`, `\s+-`) are unbounded, so on the blanked text they can span a BLANKED DATE — the
 * adversarial R7 review showed `Miete 1.500,00 01.04.2026 - 30.06.2026` (an amount followed by a billing-
 * period RANGE) reading the range dash as a spaced trailing debit minus → a silent −1500 sign flip (the
 * blanked digits also blinded the "not followed by a figure" lookahead). A trailing decoration whose gap
 * covers any blanked byte is therefore stripped back to the magnitude (the figure reads positive-as-
 * printed); a decoration over GENUINE whitespace keeps the BL-1 spaced/glued-minus semantics unchanged.
 * The LEADING side needs no such check: a blanked date is ≥6 chars, longer than the `\s{0,4}` gap, so a
 * sign can never bridge one (the leading spaces a match may absorb are handled by the callers'
 * `figureStart` trim). Returns the blanked text too (the callers' `afterLast` region test reads it).
 */
export function scanMoneyWithBlankedDates(rest: string): { scanRest: string; matches: BlankedMoneyMatch[] } {
  const scanRest = blankDateTokens(rest)
  const matches: BlankedMoneyMatch[] = []
  for (const m of scanRest.matchAll(MONEY_RE)) {
    let token = m[0]
    const start = m.index ?? 0
    // Everything after the LAST DIGIT is trailing decoration (whitespace/sign/paren).
    let lastDigit = token.length - 1
    while (lastDigit >= 0 && !/\d/.test(token[lastDigit])) lastDigit--
    for (let k = lastDigit + 1; k < token.length; k++) {
      if (scanRest[start + k] !== rest[start + k]) {
        token = token.slice(0, lastDigit + 1) // the gap crossed a blanked date → not this figure's sign
        break
      }
    }
    matches.push({ token, index: start })
  }
  return { scanRest, matches }
}

// ---- Currency-adjacent bare-integer read + money-presence test (U1, audit §2.3) ----

// The currency symbols a money figure prints with (mirrors SYMBOL_TO_CODE keys), and a BARE integer
// (a whole number MONEY_RE deliberately rejects so a reference/account number is never read as an
// amount). Shared so the currency-adjacent fallback is identical for a labelled invoice total
// (`totalsMoney`) and a bank balance line (`lastMoneyOnLine`), audit §2.3 (the gate gap where
// "Opening balance 914 $" lost its completeness figure because `lastMoneyOnLine` used MONEY_RE only).
const CURRENCY_SYMBOLS = '€$£¥'
const BARE_INTEGER_RE = /(?<![\d.,'])\d{1,9}(?![\d.,'])/g

/**
 * The LAST bare integer on a (date-scrubbed) line that TOUCHES a currency marker — a symbol glued or
 * spaced (`€914`, `914 $`) or a spaced ISO code (`914 EUR`) — as a signed number, else null. A ROUND
 * total/balance is frequently printed with NO decimal and NO grouping, which MONEY_RE rejects; this is
 * the currency-anchored fallback the totals/balance readers use AFTER the normal `MONEY_RE` last-token
 * scan fails. Currency-adjacency is the safety anchor: a stray reference/registration integer that does
 * NOT touch a currency marker is never read as the amount (the §22-D1 honesty posture). SIGN-aware (R1):
 * a credit-note `-914`/`(914)`/`914-` keeps its sign via `parseAmount`. Dates are scrubbed first so a
 * `dd.mm.yyyy` token's digits are never mistaken for a currency-adjacent integer.
 */
export function lastCurrencyAdjacentInteger(line: string): number | null {
  const text = stripDateTokens(line)
  let last: number | null = null
  for (const m of text.matchAll(BARE_INTEGER_RE)) {
    const start = m.index ?? 0
    const before = text.slice(0, start)
    const after = text.slice(start + m[0].length)
    const symbolAdjacent =
      new RegExp(`[${CURRENCY_SYMBOLS}]\\s*$`).test(before) ||
      new RegExp(`^\\s*[${CURRENCY_SYMBOLS}]`).test(after)
    const codeAfter = /^\s+([A-Z]{3})\b/.exec(after)
    const codeBefore = /\b([A-Z]{3})\s+$/.exec(before)
    const codeAdjacent =
      (codeAfter !== null && detectCurrency(codeAfter[1]) !== null) ||
      (codeBefore !== null && detectCurrency(codeBefore[1]) !== null)
    if (symbolAdjacent || codeAdjacent) {
      // Keep the SIGN (R1): rebuild the token with a leading `-`/`(` at the end of `before` (a symbol may
      // sit further left, `€-914`) or a trailing `)`/`-` at the start of `after` and reuse parseAmount.
      const lead = /[-(]\s*$/.exec(before)
      const trail = /^\s*[-)]/.exec(after)
      const signed = `${lead ? lead[0].trim() : ''}${m[0]}${trail ? trail[0].trim() : ''}`
      const n = parseAmount(signed)
      if (n !== null) last = n
    }
  }
  return last
}

/**
 * Whether a line carries a money-SHAPED token (a `MONEY_RE` match, after date-scrubbing so a `dd.mm.yyyy`
 * fragment is never counted). Used by the extractors' `droppedRowCount` (U1, audit §2.3): a line the
 * parser rejected that STILL contains such a token is a "line with figures I could not parse" — the
 * honesty signal that gates the "whole invoice/statement" claim. A bare integer is intentionally NOT
 * money-shaped here (MONEY_RE rejects it), matching the parser's own "there is a figure here" definition.
 */
export function hasMoneyToken(line: string): boolean {
  return stripDateTokens(line).match(MONEY_RE) !== null
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
