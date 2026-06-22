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

/** Split a row's words (already x-sorted) into whitespace-delimited tokens in reading order. */
function rowTokens(row: readonly LayoutWord[]): string[] {
  const out: string[] = []
  for (const w of row) {
    for (const tok of w.str.split(/\s+/)) {
      if (tok) out.push(tok)
    }
  }
  return out
}

/**
 * Reconstruct ONE transaction line from a visual row, or null when the row is not a transaction
 * (no resolvable lead date, or no amount). The emitted shape is exactly what `parseLine` accepts:
 * `<DD.MM.YYYY> <description> <amount> [<balance>]`. The transform that makes this safe:
 *   - the LEAD date column is resolved to a full date (year from the page header);
 *   - any SECONDARY date token (e.g. a value-date column) is DROPPED, so it can never be mistaken for
 *     the amount by `parseLine`'s "first money token" rule;
 *   - money-class tokens are appended in column order, so `parseLine` reads the first as the amount and
 *     the last as the running balance — exactly as today.
 * Description text is the remaining free-text tokens. A row whose description would be empty is dropped
 * (a bare date+amount with no label is almost always a summary/header line, and `parseLine` drops it
 * anyway).
 */
export function reconstructLine(row: readonly LayoutWord[], year: number | null): string | null {
  const tokens = rowTokens(row)
  if (tokens.length === 0) return null

  let leadDate: string | null = null
  const description: string[] = []
  const money: string[] = []
  for (const tok of tokens) {
    const cls = classifyToken(tok)
    if (cls === 'date') {
      if (leadDate === null) {
        const full = toFullDate(tok, year)
        if (full) leadDate = full
        // a date we cannot resolve (bare, no page year) is dropped — never guessed
      }
      // secondary dates are dropped entirely (kept out of description so they aren't read as money)
      continue
    }
    if (cls === 'money') {
      money.push(tok)
      continue
    }
    description.push(tok)
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
  const lines: string[] = []
  for (const row of rows) {
    const tx = reconstructLine(row, year)
    if (tx) {
      lines.push(tx)
      continue
    }
    // Not a transaction row — emit its RAW left-to-right text so the non-row content survives:
    // statement headers, the currency code, and (critically for the §3.5 completeness gate) the
    // opening/closing BALANCE labels, which carry no booking date and so are not transactions. These
    // lines all lack a leading date, so the downstream `parseLine` drops them from extraction — they
    // influence only currency detection and the balance gate, never the transaction rows. Visual rows
    // are already grouped + ordered, so this is faithful page text, not the scrambled reading order.
    const raw = rowTokens(row).join(' ').trim()
    if (raw) lines.push(raw)
  }
  return { text: lines.join('\n'), year }
}
