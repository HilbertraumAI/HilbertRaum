import type { ExtractedSegment } from '../ingestion/parsers'
import { normalizeMath } from './math'

// ZIM article HTML → ExtractedSegment[] (knowledge packs, query-time retrieval arm).
//
// Input is mwoffliner/Parsoid output served by the kiwix-serve sidecar: machine-generated,
// well-formed HTML with a stable shape — `<section>` blocks, `<h2>`–`<h4>` headings inside
// `.mw-heading` wrappers, `<sup class="mw-ref">` reference markers, MathML `<math alttext>`
// carrying the LaTeX source, and (maxi flavours) figures/images. We extract readable text
// the same way MarkdownParser does for headings: one segment per heading section, heading
// text kept in the segment body AND as `sectionLabel`, intro text before the first heading
// as a leading label-less segment. ZIM archives also carry zimit crawls, DevDocs and Stack
// Exchange dumps, so the scanner must survive ordinary hand-written web HTML too.
//
// A hand-rolled scanner (no HTML-parser dependency) is deliberate: the pure-JS/no-new-deps
// parser rule (parsers/index.ts header) applies, and the output feeds retrieval text and a
// plain-text viewer, never innerHTML, so a permissive scanner cannot become an injection
// surface.
//
// Dropped subtrees: head, script/style/noscript (raw-text aware), tables (infoboxes and
// data tables scramble into `header: value` noise without geometry), figures/images, nav,
// and `<sup class="mw-ref">` citation brackets ([1][2] — noise for retrieval; other <sup>
// like m<sup>2</sup> keeps its text). `<math>` emits its alttext normalised to plain text
// (`math.ts`, #340) and skips the MathML subtree; the `<img>` fallback that follows is
// dropped with all images, so each formula appears exactly once.
//
// ---------------------------------------------------------------------------------------
// LINEAR FORWARD SCANNER — complexity record (PR #294 review H1)
// ---------------------------------------------------------------------------------------
// The previous implementation tokenised with one global regex whose attribute group
// `(?:[^>"']|"[^"]*"|'[^']*')*` also matches `<`, so a run of unclosed `<` tags made the
// engine rescan the whole remaining suffix once per start position: O(n²) (measured
// 30k chars → 651 ms, 60k → 2.2 s on Node 22). `maxChars` bounded the INPUT, not the WORK,
// and the converter runs synchronously on the main process for every fetched article
// (up to 60 per ask at the 12-pack cap) and for the viewer, where no AbortSignal can
// interrupt it.
//
// This is now a single-cursor forward scanner. Its states, and how many times one input
// index can be examined in each:
//
//   S1 data          `indexOf('<', cursor)` hops over a text run — each index once.
//   S2 tag-open      one char after `<` decides tag / end tag / declaration / literal text.
//   S3 name          ASCII name chars, stepped once each.
//   S4 attributes    stepped once each, quote-aware: a quoted value is skipped by ONE
//                    `indexOf` hop, so its bytes are examined once.
//   S5 raw text      script/style: forward `indexOf('</')` hops (disjoint); after each hop
//                    at most `name.length + 1` chars are compared ASCII-case-insensitively
//                    and are then re-covered by the next hop → at most 2 examinations.
//   S6 comment       `<!--` → one `indexOf('-->')` hop.
//   S7 cdata         `<![CDATA[` → one `indexOf(']]>')` hop.
//   S8 declaration   `<!…` (DOCTYPE, `<![if]>`/`<![endif]>`), `<?…` and a `</` with no
//                    name → bogus comment: one `indexOf('>')` hop.
//
// Bounded lookahead. Every lookahead goes through `find()`, which MEMOISES FAILURES per
// needle: a failed `indexOf(needle, i)` proves the needle occurs at no index ≥ i, so every
// later query for the same needle is answered from the memo in O(1) instead of rescanning
// the suffix. That is what makes N unmatched quotes (or N unterminated comments) linear
// instead of N × suffix. Needles: `<`, `>`, `"`, `'`, `-->`, `]]>`, `</`. A failure of `<`,
// `>`, `-->`, `]]>` or `</` also ends the scan (the remainder is plain text, or is
// HTML5-discarded), so at most one of those ever fires; only the two quote needles can fail
// and let the scan continue. The input is never lowercased to find `</script` / `</style`
// (`toLowerCase()` can change a string's length and would shift every index the scanner
// holds) — the bytes after `</` are compared ASCII-case-insensitively instead.
//
// Recovery choices for malformed input. Each keeps the cursor monotone and none rescans a
// consumed suffix; where two recoveries were possible we took the one that keeps the most
// useful text, because fast output of nothing is not a fix:
//   • `<` not followed by an ASCII letter, `/`, `!` or `?` is ordinary text and the cursor
//     advances exactly ONE char, so `<<<<` runs and `< x` / `<1` cost O(1) each.
//   • `<` inside a tag's attribute region abandons the malformed tag: its text is discarded
//     and the scan RESUMES AT THAT `<` (examined once as a terminator, once as a tag-open —
//     2×, never a suffix rescan). This is why `<x <x <x <p>tail</p>` still yields "tail",
//     where an HTML5 tokeniser swallows everything to EOF as one tag.
//   • An attribute quote that never closes is treated as an ordinary attribute character
//     and the scan continues, so `<p t="x> lead</p>` and any markup after it stay reachable.
//     Nothing is reported unless the tag then runs to EOF.
//   • A tag that reaches EOF without `>` is discarded HTML5-style (a tag is not text) and
//     reported as `unterminated` — `what: 'quote'` when a quote lookahead failed inside it,
//     otherwise `'tag'`.
//   • `</` with no name is a bogus comment, discarded to the next `>` (HTML5).
//   • An unterminated comment / CDATA / script / style cannot be interpreted: the remainder
//     is discarded, but it is BUDGETED (the failed lookahead is charged) and REPORTED
//     through `truncated`. The segments produced before it are still returned; we never
//     throw.
//
// Therefore every input index is examined at most K = 5 times, and work ≤ K·n + c with a
// small constant c (per-tag bookkeeping):
//   ≤ 2n  ordinary consumption — every index is stepped or hopped over once (S1–S8), and
//         only the resync `<` and the ≤ name.length+1 chars compared after a `</` are seen
//         a second time;
//   ≤ 2n  the two quote needles, each of which can fail at most once (memoised) and lets
//         the scan continue;
//   ≤ 1n  the single terminal failed lookahead (`<`, `>`, `-->`, `]]>` or `</`), after which
//         the scan is over.
// So the converter is strictly linear in the converted input length. Measured on the
// pathology families the tests pin, work/n is 0.50–1.48; the deliberately stacked worst
// case (both quote needles failing, a resync, then an unterminated declaration) reaches
// 3.00. The `work` counter below measures exactly those examinations, so CI asserts the
// bound deterministically instead of by wall-clock time.
//
// ---------------------------------------------------------------------------------------
// COOPERATIVE SLICING (P1b) — why the linear scanner still yields (PR #294 review H1)
// ---------------------------------------------------------------------------------------
// Linear is not the same as short. The scanner loop is the floor at 13–16 ms per MiB on a
// desktop P-core, and on the owner's laptop-class hardware a worst-case 1 MiB article costs
// 55–63 ms — one uninterruptible main-process stall, since the converter runs on the main
// thread for every fetched article and an AbortSignal cannot interrupt a synchronous loop.
// No constant-factor fix removes that: the remedy is to stop making it ONE stall.
//
// `zimArticleSlices` is therefore the real implementation — a generator that yields every
// `sliceWork` work units (default `DEFAULT_SLICE_WORK`). `zimArticleToSegments` drains it in
// one go (unchanged behaviour, for tests, tooling and off-ask-path callers);
// `zimArticleToSegmentsAsync` awaits a `setImmediate` between slices, so the event loop turns
// — IPC, socket reads and timers all get through — and checks the caller's AbortSignal at
// every slice boundary.
//
// What this does and does not change:
//   • CPU totals are unchanged. Slicing does not make conversion cheaper; it makes the stall
//     bounded. The gate is per-slice (max slice ≤ 5 ms on the reference laptop), not total.
//   • Work accounting, the truncation contract, extraction semantics and the complexity
//     record above are untouched — the same loop, with one `yield` at the top.
//   • Overshoot: the slice check sits at the top of the loop, so the current iteration always
//     completes first. One iteration costs at most one `find` hop, so a slice can exceed
//     `sliceWork` by at most that hop (bounded by the input length) — a failed lookahead near
//     the start of a 1 MiB input is the worst case, and it ends the scan anyway.
//   • `slices` (yields + 1) is reported on `ZimArticle` and is identical on both paths.
//   • TWO SLICE TRIGGERS, because `sliceWork` counts scanner examinations and the first
//     measurement showed the scan was never the problem. Ordinary scan slices came in at
//     0.1–1.1 ms per MiB, but two post-processing steps were indivisible and dominated:
//     `decodeEntities` over one enormous text run (a 1 MiB page containing no `<` at all
//     was a single `indexOf` hop and a single decode — ~13 ms, all inside the first slice)
//     and the trailing whole-buffer `tidy()` at flush (~2.2 ms for a `<<<<` page). Both are
//     now divisible:
//       – character data is emitted in pieces of at most `TEXT_PIECE_CHARS`, and every piece
//         that is not the last of its run ends a slice. The cut is backed up to the last `&`
//         in the piece so that `&` starts the NEXT piece: an entity always begins with `&`,
//         so none can straddle a cut. (A lone `&` at a piece’s very start is left in place —
//         an "entity" longer than `TEXT_PIECE_CHARS` decodes verbatim on either path, so the
//         concatenation is unchanged.)
//       – the segment body is tidied AS IT IS BUILT by `IncrementalTidy`, which is exactly
//         `tidyWhole` re-associated over pieces (see its own note). `tidyWhole` survives for
//         headings — short by construction — and as the property test’s oracle.
//     The emission trigger deliberately does NOT touch `work`: those chars were already
//     charged by the `find` hop that skipped the run, so charging them again would move the
//     H1 oracle and the K·n + c bound. `work`, `truncated`, `title` and the segments are
//     byte-identical to the pre-slicing implementation (checked article by article against
//     it on every committed fixture, every pathology family at 30k and 1 MiB, and the
//     malformed-input cases). What does change is `slices`: with two triggers of equal size,
//     and every emitted char charged to `work` first, the bound becomes
//     slices ≤ 2·work/sliceWork + 1 (it was work/sliceWork + 1).
//
// `decodeEntities` and the tidy are the only post-processing; both were checked for their
// own super-linear risks and are linear. `decodeEntities` is hand-rolled (see its own note):
// each `&` is located by one forward `indexOf` and the digit/letter run after it is examined
// once — a run belongs to at most one preceding `&` — so `&`-heavy and entity-heavy input
// stays O(n) with no backtracking at all. `tidyWhole`'s five passes are simple
// character-class or `\n{3,}` scans with no nested quantifier, and the incremental form walks
// each piece exactly once; `emitBreak` also drops a block boundary that would only lengthen a
// whitespace run the rules already cap, so whitespace-heavy input can never build a large
// buffer for a tiny result. Neither is counted in `work`, which measures the
// scanner's own examinations.

/** Elements whose entire subtree is dropped. `<math>` is handled separately (alttext). */
const SKIP_SUBTREE = new Set([
  'head',
  'table',
  'figure',
  'nav',
  'noscript',
  'template',
  'svg'
])

/** Raw-text elements: their content is not markup and is skipped to the matching close tag. */
const RAW_TEXT = new Set(['script', 'style'])

/** Void elements (never pushed on the open stack). Images are dropped; br becomes a newline. */
const VOID = new Set(['br', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])

/** Block-level boundaries: a newline on open and close so text does not run together. */
const BLOCK = new Set([
  'p',
  'div',
  'section',
  'blockquote',
  'ul',
  'ol',
  'dl',
  'dd',
  'dt',
  'pre',
  'article',
  'main',
  'header',
  'footer',
  'caption',
  'tr'
])

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  middot: '·',
  deg: '°',
  times: '×',
  minus: '−',
  prime: '′',
  Prime: '″',
  thinsp: ' ',
  ensp: ' ',
  emsp: ' '
}

/**
 * Decode numeric and common named entities; unknown named entities are left verbatim.
 * Recognised forms, unchanged from the regex this replaces: `&#<decimal>;`, `&#x<hex>;`
 * (lower-case `x` only) and `&<letters>;`. Anything else — including an unterminated
 * `&aaaa` run or an unknown name — is copied through untouched.
 *
 * Hand-rolled for the same reason as the scanner (PR #294 review H1): this runs once per
 * text run of every converted article, and the regex form allocated a match object and
 * called a closure per entity. Linear: each `&` is located by one forward `indexOf`, and the
 * candidate after it is examined once — a digit/letter run belongs to at most one `&`.
 */
export function decodeEntities(text: string): string {
  let at = text.indexOf('&')
  // Most text runs carry no entity at all.
  if (at < 0) return text
  const n = text.length
  let out = ''
  let last = 0
  while (at >= 0) {
    let i = at + 1
    let value: string | null = null
    if (i < n && text.charCodeAt(i) === CH_HASH) {
      i += 1
      const hex = i < n && text.charCodeAt(i) === CH_LOWER_X
      if (hex) i += 1
      const digitsAt = i
      while (i < n && isRadixDigit(text.charCodeAt(i), hex)) i += 1
      if (i > digitsAt && i < n && text.charCodeAt(i) === CH_SEMI) {
        const raw = text.slice(at, i + 1)
        value = safeFromCodePoint(Number.parseInt(text.slice(digitsAt, i), hex ? 16 : 10), raw)
      }
    } else {
      const nameAt = i
      while (i < n && isAlpha(text.charCodeAt(i))) i += 1
      if (i > nameAt && i < n && text.charCodeAt(i) === CH_SEMI) {
        const name = text.slice(nameAt, i)
        if (name in NAMED_ENTITIES) value = NAMED_ENTITIES[name]
      }
    }
    if (value === null) {
      // Not an entity: the next candidate starts at the next `&` (which may be inside this
      // one's failed run, exactly as the regex engine's one-char advance would find it).
      at = text.indexOf('&', at + 1)
      continue
    }
    out += text.slice(last, at) + value
    last = i + 1
    at = text.indexOf('&', last)
  }
  return last === 0 ? text : out + text.slice(last)
}

function isRadixDigit(cc: number, hex: boolean): boolean {
  if (cc >= 48 && cc <= 57) return true
  if (!hex) return false
  return (cc >= 97 && cc <= 102) || (cc >= 65 && cc <= 70)
}

function safeFromCodePoint(cp: number, fallback: string): string {
  // Guard the RangeError on out-of-range/surrogate code points in crafted input.
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return fallback
  }
  return String.fromCodePoint(cp)
}

const CH_TAB = 9
const CH_LF = 10
const CH_FF = 12
const CH_CR = 13
const CH_SPACE = 32
const CH_BANG = 33
const CH_QUOT = 34
const CH_APOS = 39
const CH_HYPHEN = 45
const CH_SLASH = 47
const CH_LT = 60
const CH_EQ = 61
const CH_GT = 62
const CH_QUESTION = 63
const CH_AMP = 38
const CH_HASH = 35
const CH_SEMI = 59
const CH_LOWER_X = 120

function isSpace(cc: number): boolean {
  return cc === CH_SPACE || cc === CH_TAB || cc === CH_LF || cc === CH_CR || cc === CH_FF
}

/** ASCII letter — the HTML5 tag-open condition (a tag name must start with one). */
function isAlpha(cc: number): boolean {
  return (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)
}

/** Tag-name continuation, matching the previous tokeniser's `[a-zA-Z0-9-]`. */
function isNameChar(cc: number): boolean {
  return isAlpha(cc) || (cc >= 48 && cc <= 57) || cc === CH_HYPHEN
}

/**
 * Pull one attribute value out of a raw attribute string (both quote styles).
 * Shared with the library-XML parser (client.ts) — kiwix output is machine-generated,
 * always-quoted markup, which is all this reader supports.
 *
 * Hand-rolled rather than a regex: the previous form
 * `(?:^|\s)name\s*=\s*("[^"]*"|'([^']*)')` re-scans the tail once per candidate start
 * position, which is quadratic on a single pathological tag carrying many ` name=`
 * prefixes and no closing quote (PR #294 review H1). This walks the attribute list once —
 * O(attrs.length) — and keeps the old contract: only a QUOTED value is returned, an
 * unquoted or valueless occurrence is skipped and the search continues, `null` when the
 * name never carries a quoted value.
 */
export function attrValue(attrs: string, name: string): string | null {
  const want = name.toLowerCase()
  const n = attrs.length
  let i = 0
  while (i < n) {
    const cc = attrs.charCodeAt(i)
    // Separators between attributes, plus the stray `/` of a self-closing tag.
    if (isSpace(cc) || cc === CH_SLASH || cc === CH_EQ) {
      i += 1
      continue
    }
    const start = i
    while (i < n) {
      const c = attrs.charCodeAt(i)
      if (isSpace(c) || c === CH_EQ || c === CH_SLASH) break
      i += 1
    }
    const attrName = attrs.slice(start, i).toLowerCase()
    let j = i
    while (j < n && isSpace(attrs.charCodeAt(j))) j += 1
    // No `=` — a valueless attribute; `i` already sits on the next separator.
    if (j >= n || attrs.charCodeAt(j) !== CH_EQ) continue
    j += 1
    while (j < n && isSpace(attrs.charCodeAt(j))) j += 1
    const q = j < n ? attrs.charCodeAt(j) : -1
    if (q === CH_QUOT || q === CH_APOS) {
      const close = attrs.indexOf(q === CH_QUOT ? '"' : "'", j + 1)
      // An unterminated quote swallows the rest of this one tag's attribute string.
      if (close < 0) return attrName === want ? attrs.slice(j + 1) : null
      if (attrName === want) return attrs.slice(j + 1, close)
      i = close + 1
      continue
    }
    // Unquoted value: outside the supported contract — skip it and keep looking.
    while (j < n && !isSpace(attrs.charCodeAt(j))) j += 1
    i = j
  }
  return null
}

/** Default input cap: 1 MiB of markup. */
const DEFAULT_MAX_CHARS = 1_048_576

/**
 * Work units per cooperative slice (P1b), and the size of one emitted text piece — kept
 * equal so the two slice triggers have the same granularity. 16_384 measures at ~0.3 ms
 * median / 0.5 ms p95 per slice on a desktop P-core and 1.2 ms median / 2.4–2.7 ms p95 on the
 * i7-8550U reference — inside the ruled 5 ms per-slice stall with margin — while a whole 1 MiB
 * article still costs only ~60 macrotask hops and an ordinary ~30 KB article is two slices.
 * Set from measurement, twice: 65_536 → 32_768 on the i9-14900K (the busiest family sat at
 * 1.1 ms median with a jitter tail past the 1.67 ms early-warning third), then 32_768 →
 * 16_384 on the i7-8550U reference itself (2026-09-05: at 32 Ki the 1 MiB families' median-of-
 * three max reached 5.2 ms and p95 3.2–3.7 ms; at 16 Ki max 2.7–3.0 ms and p95 2.4–2.7 ms —
 * inside the 5 ms bound with margin, at ~0 % overhead). The residual 6–9 ms spikes that
 * machine shows at a random article of the batch do NOT shrink with the slice size and are
 * therefore not scan work (see the perf script's GC columns).
 */
export const DEFAULT_SLICE_WORK = 16_384

/**
 * Longest run of character data handed to `decodeEntities` (and to the incremental tidy)
 * in one step — kept equal to DEFAULT_SLICE_WORK so both slice triggers have one granularity. A 1 MiB page containing no `<` at all used to be one hop, one decode and
 * one tidy — 13 ms of main thread nobody could interrupt. Emitting in pieces makes a slice
 * boundary reachable inside a single text run (P1b follow-up).
 */
export const TEXT_PIECE_CHARS = 16_384

/** JS `\s`, by code unit — the set `tidyWhole`'s character classes operate on. */
function isWhitespaceCode(cc: number): boolean {
  return (
    cc === 32 ||
    (cc >= 9 && cc <= 13) ||
    cc === 0xa0 ||
    cc === 0x1680 ||
    (cc >= 0x2000 && cc <= 0x200a) ||
    cc === 0x2028 ||
    cc === 0x2029 ||
    cc === 0x202f ||
    cc === 0x205f ||
    cc === 0x3000 ||
    cc === 0xfeff
  )
}

const INVISIBLES = /[\u00AD\u200B-\u200D\uFEFF]/g
const WHITESPACE_RUN = /\s+/g

/** Newlines in `text[from, to)`, capped at 2 — the only distinction the rules make. */
function countNewlines(text: string, from = 0, to = text.length): number {
  let k = 0
  for (let i = from; i < to && k < 2; i += 1) if (text.charCodeAt(i) === CH_LF) k += 1
  return k
}

/** The canonical form `tidyWhole` gives one maximal whitespace run, by newline count. */
function canonicalWhitespace(newlines: number): string {
  return newlines >= 2 ? '\n\n' : newlines === 1 ? '\n' : ' '
}

const canonicalRun = (run: string): string => canonicalWhitespace(countNewlines(run))

/**
 * `tidyWhole` applied piece by piece instead of to a finished buffer (P1b follow-up).
 *
 * Why it is exact rather than an approximation: composed, `tidyWhole`'s five passes rewrite
 * every MAXIMAL whitespace run to a form that depends only on how many newlines it holds —
 * two or more → '\\n\\n', exactly one → '\\n', none → ' ' — after invisible characters have
 * been removed, and then trim the first and last run away. Removing invisibles is
 * position-independent, so it can be done per piece. The only run that can straddle a piece
 * boundary is the one at the end of a piece, so that run is held back as the CARRY and
 * merged with the next piece's leading run before being canonicalised. Newline counts are
 * capped at two, which is exactly the information the canonical form preserves, so the carry
 * loses nothing. The leading trim is "emit nothing until the first non-whitespace" and the
 * trailing trim is "drop the final carry".
 *
 * The result is byte-identical to `tidyWhole` over the concatenation of the pieces, for any
 * split — pinned by a property test over random inputs and random split sizes down to 1.
 */
export class IncrementalTidy {
  private out = ''
  /** True once a non-whitespace character has been appended (the leading trim is over). */
  private started = false
  /** A whitespace run is pending at the end of the text so far. */
  private pending = false
  private pendingNewlines = 0

  /** Newlines held in the pending trailing run (0, 1 or 2 — capped like the rules). */
  get carryNewlines(): number {
    return this.pending ? this.pendingNewlines : 0
  }

  /** The canonical text so far. The pending run is dropped: that is the trailing trim. */
  result(): string {
    return this.out
  }

  /** Start a new segment, optionally seeded with already-canonical text plus a pending run. */
  reset(seed = '', seedTrailingNewlines = 0): void {
    this.out = seed
    this.started = seed.length > 0
    this.pending = seedTrailingNewlines > 0
    this.pendingNewlines = seedTrailingNewlines
  }

  push(raw: string): void {
    if (raw.length === 0) return
    const text = raw.replace(INVISIBLES, '')
    const n = text.length
    if (n === 0) return

    let a = 0
    while (a < n && isWhitespaceCode(text.charCodeAt(a))) a += 1
    if (a === n) {
      // All whitespace: it merges into the pending run and nothing is decided yet.
      this.pendingNewlines = Math.min(2, this.pendingNewlines + countNewlines(text))
      this.pending = true
      return
    }
    let b = n
    while (b > a && isWhitespaceCode(text.charCodeAt(b - 1))) b -= 1

    // The carry and this piece's leading run are ONE run of the concatenated text.
    if (this.started && (this.pending || a > 0)) {
      this.out += canonicalWhitespace(Math.min(2, this.pendingNewlines + countNewlines(text, 0, a)))
    }
    this.out += text.slice(a, b).replace(WHITESPACE_RUN, canonicalRun)
    this.started = true
    this.pending = b < n
    this.pendingNewlines = b < n ? countNewlines(text, b, n) : 0
  }
}

export interface ZimConvertOptions {
  /** Input cap in chars (default 1 MiB = 1_048_576): everything past it is not converted. */
  maxChars?: number
  /** Scan-work cap in work units (default 4 × maxChars); the scanner stops at the cap and
   *  reports partial output rather than stalling the ask path. */
  maxWork?: number
}

export interface ZimSliceOptions extends ZimConvertOptions {
  /** Work units per slice before the generator yields (default `DEFAULT_SLICE_WORK`). */
  sliceWork?: number
}

export interface ZimAsyncOptions extends ZimSliceOptions {
  /** Checked before every slice; on abort the promise rejects and no further slice runs. */
  signal?: AbortSignal
}

/** What an `unterminated` truncation ran out of. */
export type ZimUnterminated = 'comment' | 'cdata' | 'script' | 'style' | 'tag' | 'quote'

/** Why an article's conversion stopped short of the whole input. */
export type ZimTruncation =
  | { reason: 'maxChars'; at: number } // input longer than maxChars; at = chars actually converted
  | { reason: 'workBudget'; at: number } // budget exhausted at input index `at`
  | { reason: 'unterminated'; what: ZimUnterminated; at: number }

export interface ZimArticle {
  /** Article title from the first <h1>, or null when the page has none. */
  title: string | null
  segments: ExtractedSegment[]
  /** null = the whole input was converted; otherwise why the output is partial. */
  truncated: ZimTruncation | null
  /**
   * Instrumented scan work in "input positions examined" (see the complexity record in the
   * header). Accounting: +1 for every char the scanner steps over or inspects directly,
   * +(j − i) for a successful `indexOf` hop from i to j, +(input.length − i) for a lookahead
   * that fails from i, and +1 for a lookahead answered from the failure memo. Monotone,
   * deterministic, machine-independent and > 0 for any non-empty input — this is the CI
   * oracle for H1, never wall-clock time.
   */
  work: number
  /**
   * Cooperative slices the conversion took (P1b) = generator yields + 1. Deterministic for a
   * given input and `sliceWork`, and identical on the sync and async paths — they drain the
   * same generator. 1 means the whole article fitted in one slice.
   */
  slices: number
}

/**
 * The scanner as a cooperative generator: it yields (returning the main thread to the event
 * loop) roughly every `sliceWork` work units and returns the finished `ZimArticle`. Both
 * public entry points below drive this one implementation, so the sync and async results are
 * identical by construction. Never throws: malformed input degrades to the best text the
 * recovery rules can reach.
 */
export function* zimArticleSlices(
  html: string,
  opts: ZimSliceOptions = {}
): Generator<void, ZimArticle, void> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  const maxWork = opts.maxWork ?? maxChars * 4
  const sliceWork = opts.sliceWork ?? DEFAULT_SLICE_WORK
  const sliced = html.length > maxChars
  const input = sliced ? html.slice(0, maxChars) : html
  const n = input.length

  let work = 0
  let truncated: ZimTruncation | null = null

  // Memoised failed lookaheads: once `indexOf(needle, i)` fails, the needle occurs at no
  // index ≥ i, so every later query for it is answered in O(1) — no suffix is rescanned.
  const noneFrom = new Map<string, number>()
  const find = (needle: string, from: number): number => {
    if (from >= n) return -1
    const known = noneFrom.get(needle)
    if (known !== undefined && from >= known) {
      work += 1
      return -1
    }
    const at = input.indexOf(needle, from)
    if (at < 0) {
      work += n - from
      noneFrom.set(needle, from)
      return -1
    }
    work += at - from
    return at
  }

  const segments: ExtractedSegment[] = []
  let title: string | null = null
  let currentLabel: string | null = null
  // The segment body is tidied AS IT IS BUILT (P1b follow-up), so no buffer ever has to be
  // normalised in one uninterruptible step at flush, and a run of block boundaries costs
  // O(1) instead of a character each.
  const body = new IncrementalTidy()

  // Heading capture: while > 0 we are inside <hN> and text goes to headingBuf instead.
  // Headings keep the whole-string tidy: they are short, and the trailing-newline counter
  // below is what stops a pathological page nesting blocks inside one from growing it.
  let headingLevel = 0
  let headingBuf = ''
  let headingNewlines = 0
  const trailingNewlines = (text: string, before: number): number => {
    let k = 0
    while (k < text.length && text.charCodeAt(text.length - 1 - k) === CH_LF) k += 1
    return k === text.length ? before + k : k
  }

  // Subtree skipping: depth counters rather than a full open-tag stack — Parsoid output
  // is balanced, and a counter survives the odd unbalanced tag without corrupting state.
  let skipDepth = 0
  let supSkipDepth = 0
  let mathDepth = 0

  const flush = (): void => {
    const text = body.result()
    if (text.length > 0) segments.push({ text, pageNumber: null, sectionLabel: currentLabel })
    body.reset()
  }

  const emit = (text: string): void => {
    if (text.length === 0) return
    if (headingLevel > 0) {
      headingBuf += text
      headingNewlines = trailingNewlines(text, headingNewlines)
    } else {
      body.push(text)
    }
  }

  /** A block boundary: one newline, unless two already terminate the text. */
  const emitBreak = (): void => {
    if ((headingLevel > 0 ? headingNewlines : body.carryNewlines) >= 2) return
    emit('\n')
  }

  // Character data between the previous token and `upto`, in pieces of at most
  // TEXT_PIECE_CHARS so that a slice boundary is reachable INSIDE one long run. Advancing
  // the text cursor is what guarantees no region is emitted twice and a discarded region is
  // never emitted. A generator, not a plain closure, because `yield` cannot cross a function
  // boundary — every call site drives it with `yield*`.
  let textStart = 0
  const emitTextUpTo = function* (upto: number): Generator<void, void, void> {
    if (upto <= textStart) return
    if (skipDepth === 0 && supSkipDepth === 0 && mathDepth === 0) {
      let from = textStart
      while (from < upto) {
        let to = from + TEXT_PIECE_CHARS
        if (to < upto) {
          // Cut back to the last `&` in the piece so that `&` starts the NEXT piece: an
          // entity always begins with `&`, so no entity can straddle the cut. Bounded by
          // the piece length, and skipped when the piece holds no `&` (decoding is then a
          // no-op across the boundary anyway). A single `&` at the very start of a piece is
          // left alone — an "entity" longer than TEXT_PIECE_CHARS decodes verbatim either
          // way (out-of-range code point, or a name no table holds).
          for (let k = to - 1; k > from; k -= 1) {
            if (input.charCodeAt(k) === CH_AMP) {
              to = k
              break
            }
          }
        } else {
          to = upto
        }
        emit(decodeEntities(input.slice(from, to)))
        from = to
        // One piece is the indivisible unit of emission work, so every piece that is not the
        // last of the run ends a slice. A run of at most TEXT_PIECE_CHARS is one piece and
        // yields nothing, which is why ordinary articles are still single-slice.
        if (from < upto) {
          noteSlice()
          yield
        }
      }
    }
    textStart = upto
  }

  /** Record why the remainder was discarded (the first cut wins; we never throw). */
  const cut = (what: ZimUnterminated, at: number): void => {
    truncated = { reason: 'unterminated', what, at }
  }

  let cursor = 0
  let slices = 1
  let workAtLastYield = 0
  // Two independent slice triggers, and `work` is deliberately NOT changed by the second:
  // scan work bounds the loop (below), and TEXT_PIECE_CHARS bounds emission, which is
  // post-processing (`decodeEntities` + the incremental tidy) whose cost `work` never
  // modelled and which is what used to dominate a slice. Charging emitted chars to `work`
  // would double-count them — the `find` hop that skipped the run charged them already — and
  // would move the H1 oracle. Both triggers are deterministic, so `slices` is too.
  const sliceDue = (): boolean => work - workAtLastYield >= sliceWork
  const noteSlice = (): void => {
    workAtLastYield = work
    slices += 1
  }
  while (cursor < n) {
    // ---- cooperative slice boundary (P1b) --------------------------------------
    // The check sits at the TOP of the loop, so one iteration always runs to completion
    // before we yield: a single `find` hop over a long suffix can overshoot the budget by
    // that hop, and by at most that one hop (see the header's slicing section).
    if (sliceDue()) {
      noteSlice()
      yield
    }

    if (work > maxWork) {
      yield* emitTextUpTo(cursor)
      truncated = { reason: 'workBudget', at: cursor }
      textStart = n
      break
    }

    // ---- S1 data ----------------------------------------------------------------
    const lt = find('<', cursor)
    if (lt < 0) {
      cursor = n
      break
    }

    // ---- S2 tag-open ------------------------------------------------------------
    work += 1
    const c1 = lt + 1 < n ? input.charCodeAt(lt + 1) : -1

    if (c1 === CH_BANG) {
      work += 2
      if (input.charCodeAt(lt + 2) === CH_HYPHEN && input.charCodeAt(lt + 3) === CH_HYPHEN) {
        // ---- S6 comment --------------------------------------------------------
        const end = find('-->', lt + 4)
        yield* emitTextUpTo(lt)
        if (end < 0) {
          if (lt + 4 < n) cut('comment', lt)
          textStart = n
          cursor = n
          break
        }
        cursor = end + 3
        textStart = cursor
        continue
      }
      if (input.startsWith('[CDATA[', lt + 2)) {
        // ---- S7 CDATA ----------------------------------------------------------
        work += 7
        const end = find(']]>', lt + 9)
        yield* emitTextUpTo(lt)
        if (end < 0) {
          if (lt + 9 < n) cut('cdata', lt)
          textStart = n
          cursor = n
          break
        }
        cursor = end + 3
        textStart = cursor
        continue
      }
      // ---- S8 declaration / bogus comment: DOCTYPE, `<![endif]>`, `<!x` ---------
      const end = find('>', lt + 2)
      yield* emitTextUpTo(lt)
      if (end < 0) {
        if (lt + 2 < n) cut('comment', lt)
        textStart = n
        cursor = n
        break
      }
      cursor = end + 1
      textStart = cursor
      continue
    }

    const isClose = c1 === CH_SLASH
    const nameAt = isClose ? lt + 2 : lt + 1
    if (isClose) work += 1
    const first = nameAt < n ? input.charCodeAt(nameAt) : -1

    if (c1 === CH_QUESTION || (isClose && !isAlpha(first))) {
      // ---- S8 bogus comment: `<?…`, `</>`, `</ x` ------------------------------
      const end = find('>', nameAt)
      yield* emitTextUpTo(lt)
      if (end < 0) {
        if (nameAt < n) cut('comment', lt)
        textStart = n
        cursor = n
        break
      }
      cursor = end + 1
      textStart = cursor
      continue
    }

    if (!isClose && !isAlpha(c1)) {
      // A `<` that starts nothing is ordinary text (`<<<<`, `< x`, `<1`, a trailing `<`):
      // advance exactly one char and leave it in the pending text run.
      cursor = lt + 1
      continue
    }

    // ---- S3 tag name ------------------------------------------------------------
    let p = nameAt
    while (p < n && isNameChar(input.charCodeAt(p))) {
      work += 1
      p += 1
    }
    const name = input.slice(nameAt, p).toLowerCase()

    // ---- S4 attributes (quote aware) --------------------------------------------
    const attrStart = p
    let tagEnd = -1
    let resync = -1
    let quoteFailAt = -1
    while (p < n) {
      const cc = input.charCodeAt(p)
      work += 1
      if (cc === CH_GT) {
        tagEnd = p
        break
      }
      if (cc === CH_LT) {
        resync = p
        break
      }
      if (cc === CH_QUOT || cc === CH_APOS) {
        const close = find(cc === CH_QUOT ? '"' : "'", p + 1)
        if (close < 0) {
          if (quoteFailAt < 0) quoteFailAt = p
          p += 1
          continue
        }
        p = close + 1
        continue
      }
      p += 1
    }

    if (tagEnd < 0) {
      yield* emitTextUpTo(lt)
      if (resync >= 0) {
        // Malformed tag abandoned at the `<`: drop the tag text, resume at that `<`.
        textStart = resync
        cursor = resync
        continue
      }
      // EOF inside a tag: HTML5 discards it, and the rest of the input with it.
      if (quoteFailAt >= 0) cut('quote', quoteFailAt)
      else cut('tag', lt)
      textStart = n
      cursor = n
      break
    }

    const attrs = input.slice(attrStart, tagEnd)
    const selfClosing = attrs.endsWith('/') || VOID.has(name)
    yield* emitTextUpTo(lt)
    cursor = tagEnd + 1
    textStart = cursor

    // ---- S5 raw text: script/style bodies are not markup ------------------------
    if (!isClose && RAW_TEXT.has(name) && !selfClosing) {
      let probe = cursor
      let end = -1
      for (;;) {
        const idx = find('</', probe)
        if (idx < 0) break
        work += name.length + 1
        if (matchesEndTagName(input, idx + 2, name)) {
          end = idx
          break
        }
        probe = idx + 2
      }
      if (end < 0) {
        if (cursor < n) cut(name === 'script' ? 'script' : 'style', lt)
        textStart = n
        cursor = n
        break
      }
      // Resume at the end tag itself so the ordinary path consumes it.
      cursor = end
      textStart = end
      continue
    }

    // ---- token handling (extraction semantics unchanged) ------------------------
    if (mathDepth > 0) {
      if (name === 'math') mathDepth += isClose ? -1 : 1
      continue
    }
    if (skipDepth > 0) {
      if (SKIP_SUBTREE.has(name) && !selfClosing) skipDepth += isClose ? -1 : 1
      continue
    }
    if (supSkipDepth > 0) {
      if (name === 'sup' && !selfClosing) supSkipDepth += isClose ? -1 : 1
      continue
    }

    if (!isClose && SKIP_SUBTREE.has(name)) {
      if (!selfClosing) skipDepth = 1
      continue
    }
    if (!isClose && name === 'math') {
      // The LaTeX source rides in alttext; emit it once, skip the MathML rendering tree.
      const alt = attrValue(attrs, 'alttext')
      if (alt) emit(` ${normalizeMath(decodeEntities(alt))} `)
      if (!selfClosing) mathDepth = 1
      continue
    }
    if (!isClose && name === 'sup') {
      // Reference brackets ([1], [note 2]) are retrieval noise; other superscripts keep text.
      const cls = attrValue(attrs, 'class') ?? ''
      if (/\b(?:mw-ref|reference)\b/.test(cls)) {
        if (!selfClosing) supSkipDepth = 1
        continue
      }
    }

    const h = /^h([1-6])$/.exec(name)
    if (h) {
      if (!isClose) {
        headingLevel = Number(h[1])
        headingBuf = ''
        headingNewlines = 0
      } else if (headingLevel > 0) {
        const heading = tidyWhole(headingBuf)
        headingLevel = 0
        if (heading.length > 0) {
          if (title === null) {
            // The first heading is the page <h1> (article title); it labels the intro
            // segment implicitly via `title`, not via sectionLabel.
            title = heading
          } else {
            flush()
            currentLabel = heading
            body.reset(heading, 1)
          }
        }
      }
      continue
    }

    if (name === 'br' || BLOCK.has(name)) emitBreak()
    if (!isClose && name === 'li') emit('\n- ')
    if (isClose && name === 'li') emit('\n')
  }

  // Trailing character data (a well-formed page ends in tags, but stay total). Any
  // scan-level truncation already parked `textStart` at the end of the input.
  yield* emitTextUpTo(n)
  flush()

  // An input longer than `maxChars` was sliced mid-markup, so the scan almost always ends in
  // some "unterminated" construct that is only an artifact of the slice: the cap is the
  // honest reason then, with `at` recording how far conversion actually got. A work-budget
  // stop is the more alarming signal and keeps precedence over the cap.
  // (`truncated` is assigned inside closures, so read it through a local for the narrowing.)
  const scanCut = truncated as ZimTruncation | null
  if (sliced && (scanCut === null || scanCut.reason === 'unterminated')) {
    truncated = { reason: 'maxChars', at: scanCut === null ? input.length : scanCut.at }
  }

  return { title, segments, truncated, work, slices }
}

/**
 * Extract readable text segments from one ZIM article's HTML, synchronously. `maxChars`
 * bounds the input and `maxWork` the scan itself, so no page — however malformed — can stall
 * the ask path unboundedly; `truncated` says when the output is partial and why. Drains
 * `zimArticleSlices` in one go, so the whole conversion is one main-thread stall: keep this
 * for tests, tooling and off-ask-path callers, and use the async form on the ask path.
 */
export function zimArticleToSegments(html: string, opts: ZimConvertOptions = {}): ZimArticle {
  const run = zimArticleSlices(html, opts)
  for (;;) {
    const step = run.next()
    if (step.done) return step.value
  }
}

/**
 * The ask-path form: the same conversion, but the main thread is handed back to the event
 * loop between slices and the caller's `AbortSignal` is honoured at every slice boundary.
 *
 * The hop is `setImmediate`, not a microtask (`queueMicrotask` / `await Promise.resolve()`):
 * microtasks drain before the loop turns at all, so IPC messages, socket reads and timers
 * would still be starved by a long conversion. `setImmediate` runs in the check phase, after
 * the poll phase has delivered pending I/O — which is exactly where the ask's HTTP reads and
 * the renderer's IPC live.
 *
 * Abort contract: the signal is checked BEFORE every slice, so an already-aborted signal
 * rejects before any work is done, and an abort during the conversion rejects with
 * `signal.reason` (a plain `AbortError` when the reason is undefined) and runs no further
 * slice. Rejection propagates to the caller; it is never turned into a partial article.
 *
 * A single-slice article (the common ~30 KB case) never awaits a macrotask: the generator
 * returns on its first `next()` and this resolves in the same tick.
 */
export async function zimArticleToSegmentsAsync(
  html: string,
  opts: ZimAsyncOptions = {}
): Promise<ZimArticle> {
  const { signal } = opts
  const run = zimArticleSlices(html, opts)
  for (;;) {
    if (signal?.aborted) {
      // The generator is simply abandoned — it holds no resource and has no finally block.
      throw signal.reason ?? new DOMException('The conversion was aborted', 'AbortError')
    }
    const step = run.next()
    if (step.done) return step.value
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/** ASCII-case-insensitive `name` at `at`, followed by a tag-name terminator (or EOF).
 *  The input is never lowercased: `toLowerCase()` can change a string's length, which
 *  would shift every index the scanner holds. */
function matchesEndTagName(input: string, at: number, name: string): boolean {
  if (at + name.length > input.length) return false
  for (let k = 0; k < name.length; k += 1) {
    let cc = input.charCodeAt(at + k)
    if (cc >= 65 && cc <= 90) cc += 32
    if (cc !== name.charCodeAt(k)) return false
  }
  const after = at + name.length
  if (after >= input.length) return true
  const cc = input.charCodeAt(after)
  return isSpace(cc) || cc === CH_GT || cc === CH_SLASH
}

/**
 * Collapse intra-line whitespace, strip invisible characters, cap blank runs — over a
 * whole string. Still used for headings (short by construction) and kept exported as the
 * ORACLE the incremental tidy below is tested against (PR #294 review H1, P1b follow-up).
 */
export function tidyWhole(text: string): string {
  return text
    .replace(/[­​-‍﻿]/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
