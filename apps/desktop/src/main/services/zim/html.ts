import type { ExtractedSegment } from '../ingestion/parsers'

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
// like m<sup>2</sup> keeps its text). `<math>` emits its `alttext` LaTeX and skips the
// MathML subtree; the `<img>` fallback that follows is dropped with all images, so each
// formula appears exactly once.
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
// `decodeEntities` and `tidy` are the only post-processing; both were checked for their own
// super-linear risks and are linear. `decodeEntities` is hand-rolled (see its own note):
// each `&` is located by one forward `indexOf` and the digit/letter run after it is examined
// once — a run belongs to at most one preceding `&` — so `&`-heavy and entity-heavy input
// stays O(n) with no backtracking at all. `tidy`'s five passes are simple character-class or
// `\n{3,}` scans (no nested quantifier) over disjoint per-segment buffers, and `emit`
// suppresses newline runs beyond the two `tidy` would keep, so whitespace-heavy input cannot
// build a huge buffer for a tiny result. Neither is counted in `work`, which measures the
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

export interface ZimConvertOptions {
  /** Input cap in chars (default 1 MiB = 1_048_576): everything past it is not converted. */
  maxChars?: number
  /** Scan-work cap in work units (default 4 × maxChars); the scanner stops at the cap and
   *  reports partial output rather than stalling the ask path. */
  maxWork?: number
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
}

/**
 * Extract readable text segments from one ZIM article's HTML. Pure and synchronous.
 * `maxChars` bounds the input and `maxWork` the scan itself, so no page — however
 * malformed — can stall the ask path; `truncated` says when the output is partial and why.
 * Never throws: malformed input degrades to the best text the recovery rules can reach.
 */
export function zimArticleToSegments(html: string, opts: ZimConvertOptions = {}): ZimArticle {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  const maxWork = opts.maxWork ?? maxChars * 4
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
  let buffer = ''

  // Heading capture: while > 0 we are inside <hN> and text goes to headingBuf instead.
  let headingLevel = 0
  let headingBuf = ''

  // Subtree skipping: depth counters rather than a full open-tag stack — Parsoid output
  // is balanced, and a counter survives the odd unbalanced tag without corrupting state.
  let skipDepth = 0
  let supSkipDepth = 0
  let mathDepth = 0

  // Trailing-newline counters. `tidy` collapses any run of three or more newlines to two,
  // so a block boundary that would only lengthen an existing run is dropped at emit time:
  // a page of 200k nested <div>s otherwise builds a 200k-char buffer for two characters of
  // output. Counted rather than tested with `endsWith`, which can flatten the rope.
  let bufferNewlines = 0
  let headingNewlines = 0
  const trailingNewlines = (text: string, before: number): number => {
    let k = 0
    while (k < text.length && text.charCodeAt(text.length - 1 - k) === CH_LF) k += 1
    return k === text.length ? before + k : k
  }

  const flush = (): void => {
    const text = tidy(buffer)
    if (text.length > 0) segments.push({ text, pageNumber: null, sectionLabel: currentLabel })
    buffer = ''
    bufferNewlines = 0
  }

  const emit = (text: string): void => {
    if (text.length === 0) return
    if (headingLevel > 0) {
      headingBuf += text
      headingNewlines = trailingNewlines(text, headingNewlines)
    } else {
      buffer += text
      bufferNewlines = trailingNewlines(text, bufferNewlines)
    }
  }

  /** A block boundary: one newline, unless two already terminate the buffer. */
  const emitBreak = (): void => {
    if ((headingLevel > 0 ? headingNewlines : bufferNewlines) >= 2) return
    emit('\n')
  }

  // Character data between the previous token and `upto`. Advancing the text cursor here
  // is what guarantees no region is emitted twice and a discarded region is never emitted.
  let textStart = 0
  const emitTextUpTo = (upto: number): void => {
    if (upto <= textStart) return
    if (skipDepth === 0 && supSkipDepth === 0 && mathDepth === 0) {
      emit(decodeEntities(input.slice(textStart, upto)))
    }
    textStart = upto
  }

  /** Record why the remainder was discarded (the first cut wins; we never throw). */
  const cut = (what: ZimUnterminated, at: number): void => {
    truncated = { reason: 'unterminated', what, at }
  }

  let cursor = 0
  while (cursor < n) {
    if (work > maxWork) {
      emitTextUpTo(cursor)
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
        emitTextUpTo(lt)
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
        emitTextUpTo(lt)
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
      emitTextUpTo(lt)
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
      emitTextUpTo(lt)
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
      emitTextUpTo(lt)
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
    emitTextUpTo(lt)
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
      if (alt) emit(` ${decodeEntities(alt)} `)
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
        const heading = tidy(headingBuf)
        headingLevel = 0
        if (heading.length > 0) {
          if (title === null) {
            // The first heading is the page <h1> (article title); it labels the intro
            // segment implicitly via `title`, not via sectionLabel.
            title = heading
          } else {
            flush()
            currentLabel = heading
            buffer = `${heading}\n`
            bufferNewlines = 1
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
  emitTextUpTo(n)
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

  return { title, segments, truncated, work }
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

/** Collapse intra-line whitespace, strip invisible characters, cap blank runs. */
function tidy(text: string): string {
  return text
    .replace(/[­​-‍﻿]/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
