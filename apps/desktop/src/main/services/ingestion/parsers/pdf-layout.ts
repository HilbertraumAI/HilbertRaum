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

type TokenClass = 'date' | 'money' | 'text'

/** Classify one whitespace-delimited token. Date is tried first (with a plausibility check) so a
 *  value-date column never masquerades as the amount; only then money, else free text. */
function classifyToken(token: string): TokenClass {
  const dm = DATE_TOKEN_RE.exec(token)
  if (dm) {
    const day = +dm[1]
    const month = +dm[2]
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return 'date'
  }
  if (MONEY_TOKEN_RE.test(token)) return 'money'
  return 'text'
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
  const tokens = rowTokens(row)
  if (tokens.length === 0) return null

  let leadDate: string | null = null
  const description: string[] = []
  const money: string[] = []
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
      money.push(tok.str)
      continue
    }
    description.push(tok.str)
  }

  if (leadDate === null) return null // not a dated transaction row
  if (money.length === 0) return null // no amount → not a transaction (header/section line)
  const desc = description.join(' ').trim()
  if (!desc) return null // no description → drop (parseLine requires one)
  return `${leadDate} ${desc} ${money.join(' ')}`
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
  // Header band: the top quarter of the page by y.
  const ys = words.map((w) => w.y).filter((y) => Number.isFinite(y))
  if (ys.length === 0) return null
  const maxY = Math.max(...ys)
  const minY = Math.min(...ys)
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
  for (const row of rows) {
    const tx = reconstructLine(row, year, datum)
    if (tx) {
      lines.push(tx)
      continue
    }
    // Not a transaction row — emit its RAW left-to-right text so the non-row content survives:
    // statement headers, the currency code, and (critically for the §3.5 completeness gate) the
    // opening/closing BALANCE labels (e.g. `Kontostand per 31.03.2026 35.037,04` — a mid-line date,
    // not a booking-date column entry, so not a transaction). Such lines lack a booking-column lead
    // date, so the downstream `parseLine` drops them from extraction — they influence only currency
    // detection and the balance gate, never the transaction rows. Visual rows are already grouped +
    // ordered, so this is faithful page text, not the scrambled reading order.
    const raw = rowText(row, datum)
    if (raw) lines.push(raw)
  }
  return { text: lines.join('\n'), year }
}
