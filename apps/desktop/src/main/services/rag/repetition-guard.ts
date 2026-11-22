// Repetition guard for whole-document answers (#994, follow-ups wave 7, owner calls G-3, G-4, G-5;
// rag-design.md §14.10, measured in §14.10.2).
//
// At temperature 0.3 a small model can fall into a loop: one table row written 60 times until the output cap and
// both continuations are used up (20–38k characters, 67–435 s). Nothing read the stream. Sampler penalties are not
// the fix (DRY corrupted quoted dates on b9849 and missed the loop on b12110), so the whole-document engine watches
// the text it streams instead, line by line, and stops a pass the moment one line repeats.
//
// The guard is pure and deterministic: it sees only COMPLETE lines (text up to a '\n') and trips on run(6), the same
// line six times in a row. Lines are compared with their numbers: a number cell, a year, a list number or a counter
// makes a line a different line, so a year table, a numbered list with the same text or ten leases' "| N | Not stated
// | … |" rows never trip it. Evaluated offline over 413 stored real answers, 440 map notes and the GPU session's 59
// answers, plus every multi-entity answer of the wave's review: 3 of the 18 recorded loops caught (the identical-row
// runaways), no false trip, 3 of 440 notes tripped (each a pure loop to its cap). The same rule watches answers and
// notes.
//
// Not caught (documented in known-limitations.md): the Meeting Minutes recursion (a report that restarts itself; two
// heading rules were evaluated and left out, rag-design.md §14.10.2), two lines that alternate, a line whose counter
// cell changes every time, a loop with no newline, near-copies that differ in a word, and a block restated three to
// five times.
//
// Which lines take part (`lineKey`): trimmed; heading, blockquote and emphasis marks off; a table row split into its
// cells; up to two bullet markers stripped (list numbers stay); lower-cased. A line takes part only when it carries at
// least 20 letters of information: in a table only cells of 12 letters or more count (every "Not stated", "-",
// "Tenant" and their translations in the ten UI languages is shorter), in a "Label: value" line only the value counts,
// and a table separator row never does. A blank line or a separator row does not break a run; any other line that
// takes no part does, so a filler line repeated under six entities whose other lines are short ("Lease F:",
// "### Break option", "None stated in the document.") is no run.

const SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const BULLET_RE = /^[-*+•]\s+/
const LIST_PREFIX_RE = /^(?:[-*+•]\s+|\d{1,3}[.)]\s+|[a-z][.)]\s+)/i
/** A table cell that is only a row number. */
const ROW_NUMBER_CELL_RE = /^#?\d{1,4}[.)]?$/
/** A code fence line: its indentation and its marker (three or more backticks or tildes). */
const FENCE_RE = /^(\s*)(`{3,}|~{3,})/
/** A heading line: a markdown heading, or a line that is one bold span (optionally with a colon after it). */
const HEADING_LINE_RE = /^\s*(?:#{1,6}\s+\S.*|\*\*[^*]+\*\*:?)\s*$/
const LETTER_RE = /\p{L}/gu
/** A "label: value" line (the list style of Deadline & Obligation Finder and Meeting Minutes). */
const LABEL_VALUE_RE = /^([^:|]{1,40}):\s+(.+)$/

/** A line takes part in run(6) only with at least this many letters of information. */
export const LINE_INFO_LETTERS = 20
/** In a table row only cells with at least this many letters count as information. */
export const CELL_INFO_LETTERS = 12
/** run(6): the same line this many times in a row trips the guard. */
export const EXACT_RUN = 6

const letterCount = (s: string): number => (s.match(LETTER_RE) ?? []).length

/**
 * One line as both comparisons see it: trimmed; heading, blockquote and emphasis marks off; a table row as its
 * trimmed cells joined by " | "; otherwise up to two bullet markers off; spaces collapsed; lower-cased. With
 * `stripNumbers` (the cut only) a leading row-number cell and up to two list numbers go too, so the copies of a row
 * are one line however they are numbered. `cells` is the table row's cells, else null; `marked` is the text before
 * spaces collapse and case folds.
 */
function normalizeLine(line: string, stripNumbers: boolean): { text: string; cells: string[] | null; marked: string } {
  let s = line.trim().replace(/^#{1,6}\s+/, '').replace(/^>\s*/, '')
  s = s.replace(/[*_`]+/g, '')
  let cells: string[] | null = null
  if (s.startsWith('|')) {
    cells = s
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c.length > 0)
    if (stripNumbers && cells.length > 1 && ROW_NUMBER_CELL_RE.test(cells[0])) cells = cells.slice(1)
    s = cells.join(' | ')
  } else {
    const prefix = stripNumbers ? LIST_PREFIX_RE : BULLET_RE
    s = s.replace(prefix, '').replace(prefix, '')
  }
  return { text: s.replace(/\s+/g, ' ').trim().toLowerCase(), cells, marked: s }
}

/** The run(6) key of one line, or null when the line takes part in no run (see the module note). */
export function lineKey(line: string): string | null {
  const t = line.trim()
  if (t.length === 0 || SEPARATOR_RE.test(t)) return null
  const { text, cells, marked } = normalizeLine(line, false)
  let info: number
  if (cells !== null) {
    info = cells.filter((c) => letterCount(c) >= CELL_INFO_LETTERS).reduce((sum, c) => sum + letterCount(c), 0)
  } else {
    // The label is read before spaces collapse, as it always was (a label of more than 40 characters is no label).
    const labelValue = marked.match(LABEL_VALUE_RE)
    info = labelValue ? letterCount(labelValue[2]) : letterCount(text)
  }
  return info < LINE_INFO_LETTERS ? null : text
}

/** A line as the cut compares it with the lines before it: `lineKey`'s normalisation without the information floor,
 *  and without a leading row-number cell or a list number. */
function cutKey(line: string): string {
  return normalizeLine(line, true).text
}

/**
 * The text before its repeated tail: walking back from the end, every blank line, table separator row, or line that
 * already occurred earlier in the text (`cutKey`) is dropped, until a line that is new. So the first copy of
 * everything stays, and new content right before the repeat (a short line, new table rows) stays too. Then a heading
 * left at the very end with nothing under it goes as well, but never the first copy of `trippedLine` (the line whose
 * repeats tripped the guard) or anything before it: that copy is the answer's content, even as a wholly bold line.
 * The result is a prefix of `text` ending in '\n', or ''.
 */
export function dropRepeatedTail(text: string, trippedLine?: string): string {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const keys = lines.map(cutKey)
  const firstAt = new Map<string, number>()
  keys.forEach((k, i) => {
    if (k !== '' && !firstAt.has(k)) firstAt.set(k, i)
  })
  let cut = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim()
    const repeat = t === '' || SEPARATOR_RE.test(t) || (firstAt.get(keys[i]) ?? i) < i
    if (!repeat) break
    cut = i
  }
  // A heading (or several) left at the end with no content under it is no part of the answer, down to (never past)
  // the first copy of the tripped line.
  const firstCopy = trippedLine === undefined ? undefined : firstAt.get(cutKey(trippedLine))
  const floor = firstCopy !== undefined && firstCopy < cut ? firstCopy + 1 : 0
  while (cut > floor && (lines[cut - 1].trim() === '' || HEADING_LINE_RE.test(lines[cut - 1]))) cut--
  const kept = lines.slice(0, cut)
  return kept.length > 0 ? `${kept.join('\n')}\n` : ''
}

/** The closing fence a text needs when it ends inside a code block (its opening fence's indentation and marker),
 *  else ''. */
function openFenceCloser(text: string): string {
  let open: { indent: string; marker: string } | null = null
  for (const line of text.split('\n')) {
    const m = line.match(FENCE_RE)
    if (!m) continue
    if (open === null) open = { indent: m[1], marker: m[2] }
    else if (m[2][0] === open.marker[0] && m[2].length >= open.marker.length && line.trim() === m[2]) open = null
  }
  return open === null ? '' : `${open.indent}${open.marker}\n`
}

/** Which detector tripped (one detector since round 4 of the wave's review; the type stays for the dumps). */
export type RepetitionTripKind = 'run'

export interface RepetitionTrip {
  kind: RepetitionTripKind
  /** Offset in `text` where the line that tripped starts. */
  start: number
  /** Offset in `text` just after that line's '\n'. */
  end: number
}

/** What `cutAtTrip` did: how many characters to remove from the end of the text, then what to append (the closing
 *  fence of a code block the cut lands in, else ''). */
export interface RepetitionCut {
  removed: number
  append: string
}

export interface RepetitionGuard {
  /** Every piece of text fed so far, in order (after `cutAtTrip`, the text it kept). */
  readonly text: string
  /** The first trip, or null. Once tripped, the guard ignores further text until `cutAtTrip`. */
  readonly trip: RepetitionTrip | null
  /** Feed the next streamed text; returns the trip when a line in it (or the line it completes) trips. */
  push(piece: string): RepetitionTrip | null
  /** After a trip: cut `text` back to before its repeated tail (from the line that tripped, `dropRepeatedTail`),
   *  close a code block the cut left open, restart the detector on the text kept and clear the trip. A caller cuts
   *  its own copy the same way: drop `removed` characters from its end, then add `append`. */
  cutAtTrip(): RepetitionCut
}

class LineGuard implements RepetitionGuard {
  private all = ''
  /** Offset in `all` where the line not yet terminated by '\n' starts. */
  private lineStart = 0
  private tripped: RepetitionTrip | null = null
  private runLast: string | null = null
  private runLength = 0

  get text(): string {
    return this.all
  }

  get trip(): RepetitionTrip | null {
    return this.tripped
  }

  push(piece: string): RepetitionTrip | null {
    if (this.tripped !== null) return this.tripped
    if (piece === '') return null
    this.all += piece
    let nl = this.all.indexOf('\n', this.lineStart)
    while (nl >= 0) {
      const start = this.lineStart
      this.lineStart = nl + 1
      if (this.step(this.all.slice(start, nl))) {
        this.tripped = { kind: 'run', start, end: this.lineStart }
        return this.tripped
      }
      nl = this.all.indexOf('\n', this.lineStart)
    }
    return null
  }

  cutAtTrip(): RepetitionCut {
    const trip = this.tripped
    if (trip === null) return { removed: 0, append: '' }
    const kept = dropRepeatedTail(this.all.slice(0, trip.start), this.all.slice(trip.start, trip.end - 1))
    const append = openFenceCloser(kept)
    const removed = this.all.length - kept.length
    this.all = ''
    this.lineStart = 0
    this.tripped = null
    this.runLast = null
    this.runLength = 0
    this.push(kept + append)
    return { removed, append }
  }

  /** One complete line through run(6); true when it trips. */
  private step(line: string): boolean {
    const key = lineKey(line)
    if (key === null) {
      const trimmed = line.trim()
      if (trimmed !== '' && !SEPARATOR_RE.test(trimmed)) {
        this.runLast = null
        this.runLength = 0
      }
      return false
    }
    if (key === this.runLast) this.runLength++
    else {
      this.runLast = key
      this.runLength = 1
    }
    return this.runLength >= EXACT_RUN
  }
}

/** A fresh guard for one map or fold call, or for one whole-document answer (shared by its reduce pass and every
 *  continuation, so the answer is judged as one text). */
export function createRepetitionGuard(): RepetitionGuard {
  return new LineGuard()
}
