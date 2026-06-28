// Geometry-aware layout reconstruction for the PDF parser (PDF geometry-extraction plan §3.1, Stage 1,
// D50/D51). Pure, deterministic, OFFLINE — no model, no new dependency. pdf.js already hands every
// text item its position (`transform[4]`=x, `transform[5]`=y) and advance `width`; the default text
// mode discards them and concatenates in reading order, which scrambles a COLUMNAR bank statement
// (date · description · amount) into interleaved lines so almost no transaction survives the
// line-oriented `parseLine`. This module rebuilds the VISUAL rows from those coordinates and emits one
// clean `<date> <description> <amount> [<balance>]` line per row, with the page-header YEAR already
// resolved into a full `DD.MM.YYYY` token — so the existing `parseDate`/`parseLine` consume the rows
// UNCHANGED (the non-breaking guarantee, §3.2: `parseDate` is shared with invoice + redaction and is
// never touched).
//
// Honesty posture (§7): column clustering is heuristic, so this stage can mis-read a row. It is the
// DETERMINISTIC half of the plan; the statement-level completeness gate (D56) — not this module — is
// what prevents a partial/mis-read extraction from ever becoming a confident wrong total. Here we only
// drop a row we cannot confidently shape (no resolvable date, or no amount), never invent one.

/** One positioned text fragment from `page.getTextContent()` (the geometry the text mode throws away). */
export interface LayoutWord {
  str: string
  /** Text-space x of the fragment's left edge (`item.transform[4]`). */
  x: number
  /** Text-space y of the baseline (`item.transform[5]`); HIGHER is further UP the page. */
  y: number
  /** Advance width of the fragment (`item.width`); right edge ≈ `x + w`. Unused by clustering today. */
  w: number
}

/**
 * A day-first dotted date token as printed on a German statement: `31.12.`, `31.12`, `31.12.24`,
 * `31.12.2024`. The trailing year is OPTIONAL (bare day.month is the common per-row form; the year
 * lives in the page header). Plausibility (month 1–12, day 1–31) is checked by the caller so a
 * dot-decimal amount like `12.50` — which matches this shape but has an impossible "month" 50 — is NOT
 * misread as a date and is left to be classified as money instead.
 */
const DATE_TOKEN_RE = /^(\d{1,2})\.(\d{1,2})\.?(\d{2,4})?$/

/**
 * A pure money token (anchored): an optional sign/paren, digits with `.`/`,` grouping, and a 2-digit
 * minor unit. Anchored so only a STANDALONE figure matches — a date like `31.12.2024` does not (it
 * ends in a 4-digit run with no separable 2-digit decimal tail), which keeps dates and amounts in
 * separate token classes. Mirrors the accepted set of the shared `MONEY_RE` for a single token.
 */
const MONEY_TOKEN_RE = /^[-+(]?\d[\d.,]*[.,]\d{2}\)?-?$/

/** A standalone 4-digit calendar year (1900–2099) — the page-header year fallback. */
const YEAR_TOKEN_RE = /^(19|20)\d{2}$/

/**
 * A standalone per-row CURRENCY token: an ISO-4217 code (the de-AT/EU set the shared `money.ts`
 * allowlist accepts) or a known symbol. HVB's online "Umsätze" export prints the currency code as its
 * own cell on every booking row (`<date> <type> EUR <amount>`); classifying it as TEXT lets it pollute
 * the reconstructed description (the reported `… EUR` symptom). A dedicated class keeps it OUT of the
 * description — `reconstructLine` re-emits a single currency code at the END of the line (after the
 * amount) so the line parser's currency detection still sees it without reading it as the payee. The
 * set is duplicated (not imported) so this ingestion-layer module keeps its zero-dependency stance —
 * importing the skills-layer `money.ts` would be a wrong-direction layer dependency. */
const CURRENCY_TOKEN_RE = /^(?:EUR|USD|GBP|CHF|JPY|CAD|AUD|NZD|SEK|NOK|DKK|PLN|CZK|HUF|[€$£¥])$/

/** Symbol → ISO code so a re-emitted currency is always a 3-letter code the line parser allowlists. */
const CURRENCY_SYMBOL: Readonly<Record<string, string>> = { '€': 'EUR', $: 'USD', '£': 'GBP', '¥': 'JPY' }

/**
 * A standalone debit/credit SIGN marker printed in its OWN cell: a bare `+`/`-`, or the German Soll/Haben
 * single-letter code `S` (Soll = debit = negative) / `H` (Haben = credit = positive). Some statements
 * (HVB "Umsätze") carry the amount's sign in a separate sign column rather than gluing it to the figure,
 * and pdf.js then surfaces it as its own token; left as text it is lost and a debit reads as positive
 * (the reported `3,99` Lastschrift shown as income). `reconstructLine` folds such a marker into the
 * amount's sign ONLY when it sits in the money column zone (so a stray dash inside a description is never
 * mistaken for a sign). NOTE: the EXACT HVB encoding (sign column vs glued trailing minus) must be
 * confirmed on the real statement via the local gold-set harness (D57) — this handles the sign-column
 * case safely without guessing at a mid-line dash. */
const SIGN_TOKEN_RE = /^(?:[-+]|[SH])$/

/** How close (points) a standalone sign marker must sit to the amount column to count as the amount's
 *  sign — wide enough for a trailing sign cell, narrow enough to never grab a dash mid-description. */
const SIGN_ZONE_SLACK = 40

type TokenClass = 'date' | 'money' | 'currency' | 'sign' | 'text'

/** Classify one whitespace-delimited token. Date is tried first (with a plausibility check) so a
 *  value-date column never masquerades as the amount; then money; then a standalone currency code /
 *  sign marker (kept out of the description); else free text. */
function classifyToken(token: string): TokenClass {
  const dm = DATE_TOKEN_RE.exec(token)
  if (dm) {
    const day = +dm[1]
    const month = +dm[2]
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return 'date'
  }
  if (MONEY_TOKEN_RE.test(token)) return 'money'
  if (CURRENCY_TOKEN_RE.test(token)) return 'currency'
  if (SIGN_TOKEN_RE.test(token)) return 'sign'
  return 'text'
}

/** Re-apply a sign marker to a money token: strip ALL existing sign decoration to the bare magnitude,
 *  then prefix `-` for a debit marker (`-`/`S`) or leave positive for a credit marker (`+`/`H`). Strips
 *  one-or-more leading `+`/`-`/`(` and trailing `)`/`+`/`-` so a doubly-decorated token (e.g.
 *  `(1.234,56)-`, both accepted by `MONEY_TOKEN_RE`) never leaves a stray `)` or `-` behind. */
function applySignMarker(moneyToken: string, marker: string): string {
  const debit = marker === '-' || marker === 'S'
  const bare = moneyToken.replace(/^[+\-(]+/, '').replace(/[)+\-]+$/, '').trim()
  return debit ? `-${bare}` : bare
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * The x-band of a statement's booking-DATE column (`transaction.date`), in text-space points. A
 * transaction row's LEAD date must fall inside this band; a date outside it (the Valuta/value-date
 * column, or a date printed mid-line inside a label like `Kontostand per 31.03.2026`) does NOT qualify
 * the row as a transaction. This is the column model §3.1.3 always called for but never built: without
 * it, `reconstructLine` would emit a spurious "transaction" for any visual row that merely happens to
 * carry a date token and a money token (a Valuta line whose description hides a foreign-currency
 * reference amount, or an opening/closing balance line).
 */
export interface DatumColumn {
  /** Left edge x of the booking-date column band. */
  min: number
  /** Right edge x of the booking-date column band (largest date-token x still within the band). */
  max: number
}

/** Membership slack (points) so float jitter at a band edge never drops a real booking date. */
const DATUM_X_EPS = 1

/** True when a date token at `x` sits in the booking-date column (or no column was resolved). */
function inDatumColumn(x: number, datum: DatumColumn | null | undefined): boolean {
  if (!datum) return true // no column model → fall back to "any lead date qualifies" (legacy behaviour)
  return x >= datum.min - DATUM_X_EPS && x <= datum.max + DATUM_X_EPS
}

/**
 * Resolve a printed date token to a full `DD.MM.YYYY` string using the page-resolved `year` for the
 * bare/2-digit forms, or null when it cannot be resolved (no year for a bare date → the row is dropped,
 * not guessed). A 2-digit year is expanded into the century of the page year (or 2000s when unknown).
 * The output is exactly the `DD.MM.YYYY` shape `parseDate` already accepts — `parseDate` is untouched.
 */
export function toFullDate(token: string, year: number | null): string | null {
  const m = DATE_TOKEN_RE.exec(token)
  if (!m) return null
  const day = +m[1]
  const month = +m[2]
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  let resolvedYear: number
  if (m[3] && m[3].length === 4) {
    resolvedYear = +m[3]
  } else if (m[3] && m[3].length === 2) {
    const century = year != null ? Math.floor(year / 100) * 100 : 2000
    resolvedYear = century + +m[3]
  } else if (year != null) {
    resolvedYear = year
  } else {
    return null // bare day.month with no page year — drop, don't guess
  }
  return `${pad2(day)}.${pad2(month)}.${resolvedYear}`
}

/**
 * Cluster positioned words into visual ROWS by baseline y, within a tolerance band (handles sub-pixel
 * jitter and superscripts). Rows are returned TOP-to-BOTTOM (descending y, PDF's up-is-positive); the
 * words inside each row are sorted LEFT-to-right by x. A word with a non-finite coordinate is skipped.
 */
export function clusterRows(words: readonly LayoutWord[], yTolerance: number): LayoutWord[][] {
  const usable = words.filter((w) => Number.isFinite(w.x) && Number.isFinite(w.y) && w.str !== '')
  const byY = [...usable].sort((a, b) => b.y - a.y)
  const rows: LayoutWord[][] = []
  let current: LayoutWord[] = []
  let rowY = Number.NaN
  for (const w of byY) {
    if (current.length === 0 || Math.abs(w.y - rowY) <= yTolerance) {
      if (current.length === 0) rowY = w.y
      current.push(w)
    } else {
      rows.push(current)
      current = [w]
      rowY = w.y
    }
  }
  if (current.length > 0) rows.push(current)
  for (const row of rows) row.sort((a, b) => a.x - b.x)
  return rows
}

/** One whitespace-delimited token with the x of the word it came from (the geometry the column model needs). */
interface PositionedToken {
  str: string
  /** Left edge x of the source word. A leading date cell is its own word, so its date token's x is exact. */
  x: number
}

/**
 * Split a row's words (already x-sorted) into whitespace-delimited tokens in reading order, each
 * tagged with the x of its source word. When a word holds several tokens they share the word's left x;
 * a booking-date cell is its own word (its first token IS at the word's x), so the lead-date column
 * test stays exact for the only token whose x the column model relies on.
 */
function rowTokens(row: readonly LayoutWord[]): PositionedToken[] {
  const out: PositionedToken[] = []
  for (const w of row) {
    for (const tok of w.str.split(/\s+/)) {
      if (tok) out.push({ str: tok, x: w.x })
    }
  }
  return out
}

/**
 * A non-transaction row's raw left-to-right text (headers, currency, balance labels), with any
 * out-of-Datum-column DATE token dropped. Dropping it matters: the downstream line parser keys only on
 * the line's FIRST token being a parseable date, so a Valuta row whose leftmost token is a full
 * value-date (`02.04.2026 Zahlungsreferenz … 56,27`) would otherwise be RE-EXTRACTED as a spurious
 * transaction even though `reconstructLine` already rejected it. A balance line leads with TEXT
 * (`Kontostand per 31.03.2026 35.037,04`) and its mid-line date is also out-of-column, so dropping it
 * leaves the label + the money the gate reads fully intact. An in-column date (e.g. a bare `07.02.`
 * section line with no amount) is kept — `parseDate` rejects the bare form, so it never misfires.
 */
function rowText(row: readonly LayoutWord[], datum?: DatumColumn | null): string {
  return rowTokens(row)
    .filter((t) => !(classifyToken(t.str) === 'date' && !inDatumColumn(t.x, datum)))
    .map((t) => t.str)
    .join(' ')
    .trim()
}

/** Default x gap (points) that separates two columns when clustering date tokens into bands. Within a
 *  left-aligned column the x is near-constant (sub-point jitter); the Datum→Valuta gap is tens of
 *  points, so this cleanly splits them without merging a column. */
export const DEFAULT_COLUMN_GAP = 12

/**
 * Resolve the booking-DATE column from all date tokens on the page (§3.1.3). Cluster the date-token x
 * values into contiguous bands (a gap > `columnGap` starts a new band), then pick the band with the
 * MOST date tokens — the booking column prints one date per transaction row, so it is the densest —
 * breaking ties by the leftmost band (the Datum column is left of Valuta). Returns null when the page
 * has no date tokens. Density-first (not pure leftmost) so a single stray header/period date further
 * left than the booking column cannot define a phantom column and suppress every real row.
 */
export function detectDatumColumn(
  rows: readonly (readonly LayoutWord[])[],
  columnGap: number = DEFAULT_COLUMN_GAP
): DatumColumn | null {
  const xs: number[] = []
  for (const row of rows) {
    for (const tok of rowTokens(row)) {
      if (classifyToken(tok.str) === 'date') xs.push(tok.x)
    }
  }
  if (xs.length === 0) return null
  xs.sort((a, b) => a - b)
  const bands: Array<{ min: number; max: number; count: number }> = []
  let cur = { min: xs[0], max: xs[0], count: 1 }
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] - cur.max <= columnGap) {
      cur.max = xs[i]
      cur.count++
    } else {
      bands.push(cur)
      cur = { min: xs[i], max: xs[i], count: 1 }
    }
  }
  bands.push(cur)
  // Bands are left-to-right; replace only on a STRICTLY greater count so a tie keeps the leftmost.
  let best = bands[0]
  for (const b of bands) if (b.count > best.count) best = b
  return { min: best.min, max: best.max }
}

/**
 * Reconstruct ONE transaction line from a visual row, or null when the row is not a transaction
 * (no resolvable lead date, or no amount). The emitted shape is exactly what `parseLine` accepts:
 * `<DD.MM.YYYY> <description> <amount> [<balance>]`. The transform that makes this safe:
 *   - the LEAD date must fall in the booking-date column (`datum`) — a date in the Valuta column or
 *     printed mid-line inside a label (e.g. `Kontostand per 31.03.2026`) does NOT qualify the row, so
 *     a Valuta line whose description hides a foreign-currency reference amount, and an opening/closing
 *     balance line, are no longer mis-emitted as transactions (they survive as raw text instead);
 *   - the booking date is resolved to a full date (year from the page header);
 *   - any other date token (a value-date column, or an out-of-column date) is DROPPED, so it can never
 *     be mistaken for the amount by `parseLine`'s "first money token" rule;
 *   - money-class tokens are appended in column order, so `parseLine` reads the first as the amount and
 *     the last as the running balance — exactly as today.
 * Description text is the remaining free-text tokens. A row whose description would be empty is dropped
 * (a bare date+amount with no label is almost always a summary/header line, and `parseLine` drops it
 * anyway). `datum` null/omitted keeps the legacy "any lead date qualifies" behaviour (e.g. direct unit
 * calls); `reconstructPage` always resolves and passes the page's column.
 */
export function reconstructLine(
  row: readonly LayoutWord[],
  year: number | null,
  datum?: DatumColumn | null
): string | null {
  const parsed = parseTransactionRow(row, year, datum)
  if (!parsed) return null
  return formatTransaction(parsed.date, parsed.description, parsed.money, parsed.currency)
}

/** The structured parts of one booking row — `reconstructLine` formats it; `reconstructPage` carries it
 *  while it appends continuation-baseline description text (§3.1, multi-baseline association). */
interface TransactionParse {
  date: string
  /** Free-text description tokens (currency/sign/date/money already separated out). */
  description: string[]
  /** Money tokens in column order, with the amount's sign already folded in. */
  money: string[]
  /** The per-row currency code (re-emitted at the line's end), or null when none was printed on the row. */
  currency: string | null
}

/** Join a transaction's parts into the `<DD.MM.YYYY> <description> <amount> [<balance>] [<CUR>]` line the
 *  line parser accepts. The currency trails the figures so it is never read as the payee or the amount;
 *  a row whose description is empty (a bare `<date> <CUR> <balance>` running-balance row, or a no-payee
 *  row) returns null — dropped, never invented. */
function formatTransaction(date: string, description: string[], money: string[], currency: string | null): string | null {
  const desc = description.join(' ').trim()
  if (!desc) return null
  const cur = currency ? ` ${currency}` : ''
  return `${date} ${desc} ${money.join(' ')}${cur}`
}

/**
 * Parse one visual row into its booking-transaction parts, or null when it is not a booking row (no
 * lead date in the Datum column, or no amount). Separates the per-row currency code and a standalone
 * debit/credit sign marker out of the description: the currency is carried for re-emission at the line's
 * end (kept out of the payee text), and a sign marker in the money column zone is folded into the
 * amount's sign (a debit printed with its sign in a separate column is no longer read as positive).
 */
function parseTransactionRow(
  row: readonly LayoutWord[],
  year: number | null,
  datum?: DatumColumn | null
): TransactionParse | null {
  const tokens = rowTokens(row)
  if (tokens.length === 0) return null

  let leadDate: string | null = null
  const description: string[] = []
  const money: PositionedToken[] = []
  const signs: Array<{ x: number; descIndex: number }> = []
  let currency: string | null = null
  for (const tok of tokens) {
    const cls = classifyToken(tok.str)
    if (cls === 'date') {
      // Only a date in the booking-date column can lead the row; everything else (Valuta column,
      // mid-line label date, or a secondary date) is dropped — kept out of description so it is never
      // read as money, and never allowed to qualify the row as a transaction.
      if (leadDate === null && inDatumColumn(tok.x, datum)) {
        const full = toFullDate(tok.str, year)
        if (full) leadDate = full
        // a date we cannot resolve (bare, no page year) is dropped — never guessed
      }
      continue
    }
    if (cls === 'money') {
      money.push(tok)
      continue
    }
    if (cls === 'currency') {
      // Keep the FIRST per-row currency code (re-emitted after the amount); never in the description.
      if (currency === null) currency = CURRENCY_SYMBOL[tok.str] ?? tok.str
      continue
    }
    if (cls === 'sign') {
      // Provisionally keep the marker in the description in reading order; it is spliced back out below
      // ONLY if it proves to be the amount column's own sign cell. A real `-`/`S`/`H` token in the payee
      // text is then never silently lost, and a far/mid-description marker never flips the amount.
      signs.push({ x: tok.x, descIndex: description.length })
      description.push(tok.str)
      continue
    }
    description.push(tok.str)
  }

  if (leadDate === null) return null // not a dated transaction row
  if (money.length === 0) return null // no amount → not a transaction (header/section line)

  const moneyStrs = money.map((m) => m.str)
  // Fold a standalone sign marker into the AMOUNT's sign ONLY when it is the amount column's own sign
  // cell: at/right of the amount (a dash mid-description sits left of it) AND nearer the amount than any
  // later money column (so a `+`/`-`/`S`/`H` printed beside the running BALANCE never flips the amount —
  // the conservative A3 fix). The folded marker is spliced out of the description; any other sign token
  // stays as text.
  const amountX = Math.min(...money.map((m) => m.x))
  const fold = signs.find((s) => {
    if (s.x < amountX - SIGN_ZONE_SLACK) return false
    const nearest = money.reduce((best, m) => (Math.abs(m.x - s.x) < Math.abs(best.x - s.x) ? m : best))
    return nearest.x === amountX
  })
  if (fold) {
    moneyStrs[0] = applySignMarker(moneyStrs[0], description[fold.descIndex])
    description.splice(fold.descIndex, 1)
  }

  return { date: leadDate, description, money: moneyStrs, currency }
}

/**
 * The free-text tokens of a CONTINUATION baseline (a payee/purpose line that wraps below a booking row),
 * or null when the row is not a pure continuation. A continuation carries NO money token (that excludes
 * a printed balance label and a foreign-currency reference line — both are summaries/annotations, not the
 * payee; and absorbing a stray figure would put it BEFORE the real amount in the merged line, where the
 * line parser would mis-read it as the amount) and NO booking-column date (that would make it its own
 * transaction). Out-of-column dates (a Valuta date), the currency code, and a sign marker are dropped;
 * the remaining free text is the payee/purpose the booking row's own baseline did not carry (§3.1).
 */
function continuationText(row: readonly LayoutWord[], datum?: DatumColumn | null): string[] | null {
  const tokens = rowTokens(row)
  if (tokens.length === 0) return null
  const text: string[] = []
  for (const tok of tokens) {
    const cls = classifyToken(tok.str)
    if (cls === 'money') return null // a figure ⇒ a balance/FX line, not a pure payee continuation
    if (cls === 'date') {
      if (inDatumColumn(tok.x, datum)) return null // an in-column date ⇒ a (failed) booking row, not a continuation
      continue // an out-of-column Valuta date is dropped
    }
    if (cls === 'currency' || cls === 'sign') continue
    text.push(tok.str)
  }
  return text.length > 0 ? text : null
}

/**
 * Resolve the calendar year for a page from its words: prefer the year of the FIRST fully-printed
 * `DD.MM.YYYY` date anywhere on the page (the statement period or a fully-dated row), else a standalone
 * 4-digit year token in the page's TOP band (the header), else null. A null result means bare per-row
 * dates on this page cannot be completed and their rows are dropped (honesty) unless a document-level
 * fallback year is supplied by the caller.
 */
export function resolvePageYear(words: readonly LayoutWord[]): number | null {
  for (const w of words) {
    for (const tok of w.str.split(/\s+/)) {
      const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(tok)
      if (m) {
        const month = +m[2]
        const day = +m[1]
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return +m[3]
      }
    }
  }
  // Header band: the top quarter of the page by y. REL-10: fold the page's y-range in ONE pass
  // instead of `Math.max(...ys)` / `Math.min(...ys)` — the spread passes every fragment's y as a
  // function argument, and a crafted page with hundreds of thousands of fragments overflows the
  // call stack (`RangeError`). A loop is O(n) with no arg-count limit. (Contrast the per-row
  // `Math.min(...money.map(...))` above, which is bounded by tokens-per-row and stays a spread.)
  let maxY = -Infinity
  let minY = Infinity
  let anyY = false
  for (const w of words) {
    if (!Number.isFinite(w.y)) continue
    anyY = true
    if (w.y > maxY) maxY = w.y
    if (w.y < minY) minY = w.y
  }
  if (!anyY) return null
  const bandFloor = maxY - (maxY - minY) * 0.25
  for (const w of words) {
    if (w.y < bandFloor) continue
    for (const tok of w.str.split(/\s+/)) {
      if (YEAR_TOKEN_RE.test(tok)) return +tok
    }
  }
  return null
}

/** Default baseline tolerance (PDF points) for grouping words into one visual row. */
export const DEFAULT_ROW_TOLERANCE = 3

/** How many continuation baselines a single booking row may absorb (§3.1 multi-baseline association).
 *  A bound so a mis-fired column model (or a footer note below the last row) cannot make one transaction
 *  swallow an unbounded run of text — past it, a dateless text row is emitted raw instead. */
export const MAX_CONTINUATION_ROWS = 4

export interface ReconstructOptions {
  /** Baseline y tolerance (points) for row clustering. Defaults to {@link DEFAULT_ROW_TOLERANCE}. */
  yTolerance?: number
  /**
   * A document-level fallback year for pages whose own header carries none (a multi-page statement
   * usually prints the year only on page 1). When the page resolves its own year that wins.
   */
  fallbackYear?: number | null
  /** x gap (points) separating columns when resolving the booking-date column. Defaults to {@link DEFAULT_COLUMN_GAP}. */
  columnGap?: number
}

export interface ReconstructResult {
  /** The reconstructed, newline-separated transaction lines for the page (may be empty). */
  text: string
  /** The year resolved for this page (for the caller to carry forward as the next page's fallback). */
  year: number | null
}

/**
 * Reconstruct a page's layout-preserved text from its positioned words. Resolves the page year (own
 * header first, then the caller's document-level fallback), clusters rows, and emits one clean
 * transaction line per row. Returns the joined text plus the resolved year so the caller can thread it
 * onto subsequent pages.
 */
export function reconstructPage(
  words: readonly LayoutWord[],
  opts: ReconstructOptions = {}
): ReconstructResult {
  const tol = opts.yTolerance ?? DEFAULT_ROW_TOLERANCE
  const ownYear = resolvePageYear(words)
  const year = ownYear ?? opts.fallbackYear ?? null
  const rows = clusterRows(words, tol)
  // Resolve the booking-date column from the page's date geometry first, so `reconstructLine` can
  // reject a row whose only date is a Valuta column or a mid-line label date (§3.1.3).
  const datum = detectDatumColumn(rows, opts.columnGap ?? DEFAULT_COLUMN_GAP)
  const lines: string[] = []

  // Multi-baseline row association (§3.1): a booking row OPENS a transaction; the payee/purpose that
  // HVB-style layouts print on continuation baselines below it (dateless, money-less text rows) is
  // appended to that transaction's description, so the row keeps its real description instead of just
  // the booking-line fragment (the reported `… EUR` / lost-payee symptom). The pending transaction is
  // flushed when the next booking row opens, a non-continuation row intervenes, or the page ends.
  let pending: { parse: TransactionParse; continuation: string[]; absorbed: number } | null = null
  const flush = (): void => {
    if (!pending) return
    const line = formatTransaction(
      pending.parse.date,
      [...pending.parse.description, ...pending.continuation],
      pending.parse.money,
      pending.parse.currency
    )
    // A null line means the merged description is still empty — a bare `<date> <CUR> <balance>`
    // running-balance row with NO payee continuation below it. Dropped (honest recall loss, gate-safe):
    // the combination of the currency-token class (empty booking description) AND association (no payee
    // followed) is exactly what distinguishes a phantom balance row from a real row whose payee wrapped.
    if (line) lines.push(line)
    pending = null
  }

  for (const row of rows) {
    const parse = parseTransactionRow(row, year, datum)
    if (parse) {
      flush()
      pending = { parse, continuation: [], absorbed: 0 }
      continue
    }
    const cont = continuationText(row, datum)
    if (pending && cont && pending.absorbed < MAX_CONTINUATION_ROWS) {
      pending.continuation.push(...cont)
      pending.absorbed++
      continue
    }
    // Not a transaction and not a continuation of one — flush any pending transaction, then emit this
    // row's RAW left-to-right text so non-row content survives: statement headers, the currency code,
    // and (critically for the §3.5 completeness gate) the opening/closing BALANCE labels (e.g.
    // `Kontostand per 31.03.2026 35.037,04` — a mid-line date, not a booking-date column entry, so not a
    // transaction). Such lines lack a booking-column lead date, so the downstream `parseLine` drops them
    // from extraction — they influence only currency detection and the balance gate, never the
    // transaction rows. Visual rows are already grouped + ordered, so this is faithful page text.
    flush()
    const raw = rowText(row, datum)
    if (raw) lines.push(raw)
  }
  flush()
  return { text: lines.join('\n'), year }
}
