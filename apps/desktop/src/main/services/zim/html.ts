import type { ExtractedSegment } from '../ingestion/parsers'
import { normalizeMath } from './math'
import { REF_SUP_CLASS_RE, SUB_MARK, SUP_MARK, lastCharOf, shouldMark } from './supsub'
import {
  hasDeliverableContent,
  isLayoutTableClass,
  parseTableBody,
  serializeTable
} from './tables'

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
// Dropped subtrees: head, script/style/noscript (raw-text aware), figures/images, nav, a
// `p`/`div`/`section` whose class token names site furniture (`FURNITURE_CLASS_TOKENS`, #627 —
// German Wikipedia's navigation boxes too, #662, and its sister-project links, #673) or whose id
// is a furniture id (`FURNITURE_IDS`, #673), mwoffliner's license line (dropped from the
// segments but returned as `ZimArticle.notice`, #662),
// and `<sup class="mw-ref">` citation brackets ([1][2] — noise for retrieval; other <sup> like
// m<sup>2</sup> keeps its text, now marked — see the sup/sub rule below). A `<pre>` keeps its
// indentation (PREFORMATTED TEXT, below) while every other whitespace run is collapsed.
// `<math>` emits its alttext normalised to plain text
// (`math.ts`, #340) and skips the MathML subtree; the `<img>` fallback that follows is
// dropped with all images, so each formula appears exactly once.
//
// Tables are DELIVERED, not dropped (#478) — an infobox or data table used to disappear at
// parse time, so its fact was never merely unranked, it was never retrievable at all.
// `tables.ts` owns the geometry: a
// class-based classifier (`navbox`, `vertical-navbox`, `metadata`, `ambox`, `toc`,
// `sistersitebox` and the like) still drops layout/navigation tables unchanged, and a
// structural test drops a table with no header cell and no real tabular content; everything
// else is parsed into a bounded grid (rowspan/colspan expanded, multi-row and mid-table
// headers rebound, captions kept once) and serialised into one or more retrievable segments,
// capped so a large table cannot explode the unit count or the scan.
//
// Superscripts/subscripts are kept readable EVERYWHERE (#488): prose, headings and
// table-derived text share one convention, owned by `supsub.ts` — an ordinary `<sup>` emits a
// literal `^` and a `<sub>` a literal `_` immediately before its own text, so `m<sup>2</sup>`
// reads `m^2`, `10<sup>6</sup>` reads `10^6` and `H<sub>2</sub>O` reads `H_2O` instead of
// fusing into `m2` / `106` / `H2O`. Table-derived text had this since #478; prose was left
// flattened then as a deliberate scoping decision and is now aligned. A marker is written only
// where `supsub.ts`'s `shouldMark` holds — BETWEEN two alphanumerics (a sign, `+ - − ±`, counts
// as a valid right-hand side, since it already splits the run) — which is why a `<sup>` opened
// here only ARMS the marker and `emit` below decides: a reference back-link (`↑ <sup>a</sup>`,
// preceded by a space), a paragraph-initial `<sup>` sentence and an empty `<sup></sup>` are all
// left unmarked. Retrieval does NOT move with the markers: the matchers (`arm.ts`, `admit.ts`)
// run `foldSupSub` over both the question and the article text, so every alphanumeric run of
// the pre-#488 text is still a substring of what they compare — the markers change what is
// read, never what is retrieved. The one heading that takes no marker is the TITLE (#711): it is
// the citation, the viewer's heading and the per-pack de-duplication key, so it keeps the
// archive's own spelling (`CO2-Steuer`, never `CO_2-Steuer`).
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
// TABLE-DERIVED WORK (issue #478) is charged to the SAME counter but is deliberately NOT folded
// into K·n + c above: it is bounded by tables.ts's own fixed caps (`TABLE_MAX_COLUMNS`,
// `TABLE_MAX_GRID_CELLS`, `TABLE_MAX_RAW_CHARS`), not by the input length, so it needs its own,
// additive bound rather than a larger K that would loosen the prose bound for every article that
// has no tables at all. Per admitted (delivered) table: work_table ≤ (end - tableStart), the
// source bytes the table's own sub-scan examined (unchanged from before table delivery), PLUS
// `cellsPlaced + charsUsed + nestedWork` from `serializeTable`'s `workUnits`. The outermost
// table's own share is bounded by `TABLE_MAX_GRID_CELLS + TABLE_MAX_RAW_CHARS` (~56,000)
// regardless of how the caps are reached; every NESTED table it absorbs draws from one shared,
// global `TABLE_MAX_RAW_CHARS` budget (tables.ts's `nestedWorkUsed`), so a nested table past
// that budget is dropped before its grid is even built — the last nested table admitted can
// still spend up to its own local `TABLE_MAX_GRID_CELLS + TABLE_MAX_RAW_CHARS` ceiling, so the
// combined bound on one outermost table's `workUnits` is `2 × (TABLE_MAX_GRID_CELLS +
// TABLE_MAX_RAW_CHARS) + TABLE_MAX_RAW_CHARS`, ~162,000: still fixed and independent of n and
// of how many nested tables the input actually contains — see `zim-html.test.ts`'s "table cost
// pathology" suite for the measured worst case against the reviewer's own crafted inputs (a
// 1 MiB max-colspan/rowspan single cell, a 400×100 plain grid, and a 1 MiB wrapper containing
// thousands of small nested max-span tables): all three complete in low milliseconds with
// bounded heap, where before this fix the single-cell case took seconds and gigabytes and the
// nested case was charged (and bounded) not at all.
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
//     the start of a 1 MiB input is the worst case, and it ends the scan anyway — or, for a
//     kept table, that table's whole bounded pass (see TABLE-DERIVED WORK above and
//     `docs/known-limitations.md`); `maxWork` is therefore checked at table granularity.
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

/** Elements whose entire subtree is dropped. `<math>` is handled separately (alttext);
 *  `table` is handled separately too (`tables.ts` — layout/navbox tables are still dropped,
 *  a kept table is parsed and delivered instead of skipped). Exported so `tables.ts` can apply
 *  the identical membership inside a KEPT table instead of re-listing the names (#485/#490):
 *  adding `export` to an existing `const` is behaviour-neutral here. */
export const SKIP_SUBTREE = new Set(['head', 'figure', 'nav', 'noscript', 'template', 'svg'])

/** Raw-text elements: their content is not markup and is skipped to the matching close tag.
 *  Exported for the same reason as `SKIP_SUBTREE` above. */
export const RAW_TEXT = new Set(['script', 'style'])

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

/**
 * Class tokens that name page furniture, dropped with their subtree.
 *
 * - A hand-written site's own footer, menu and the like (#627). zimit/warc2zim archives keep
 *   the crawled site's markup, and its footer is an ordinary element with a class —
 *   `<p class="footer">` closes all 86 gobyexample pages — so no tag-name rule can see it.
 * - German Wikipedia's navigation boxes built as `div`s (#662; `Vorlage:Navigationsleiste` and
 *   its extended form), each a long list of related article titles: a question about Windows XP
 *   matched the Windows 7 article's box. `tables.ts` drops the ones built as tables (`navbox`).
 *   On 1,500 sampled German Wikipedia pages, `erweiterte-navigationsleiste` always comes with
 *   `navileiste` (99 of 99) and `erw-nav-leiste` only ever marks a row inside one (45 of 45);
 *   all three are named so a box carrying only one of them is still a box. The generic
 *   MediaWiki class those boxes also carry, `navigation-not-searchable`, is deliberately NOT a
 *   token: it also marks the Normdaten (authority data) and Rechtshinweis (legal notice) boxes
 *   (`FURNITURE_IDS`, `SEGMENT_BOX_IDS`), inline pronunciation spans in running prose and boxes on
 *   other wikis (20 on 9 of 150 Alpine Linux pages). Nor is `klappleiste`, the collapsible box.
 * - German Wikipedia's sister-project links (#673; `Vorlage:Schwesterprojekt`, "Commons: … –
 *   Sammlung von Bildern, Videos und Audiodateien"), `div.sisterproject`, the only class it carries
 *   (480 boxes on 394 of 1,500 pages, nearly all heading the `Weblinks` section): navigation to
 *   Wikimedia's other projects, none of it in the archive.
 *
 * A whole class TOKEN must match, never a word inside one: `nav` inside `wy-nav-content` is the
 * Read the Docs theme's wrapper around the entire article, and `footer` inside `zim-footer` is
 * the license line mwoffliner appends to every Wikipedia article (`NOTICE_CLASS_TOKENS`, kept as
 * text) — the #627 draft's `\b(?:…)\b` pattern matched both. Measured over 2,672 sampled pages
 * from 15 archives (1,500 of them German Wikipedia), exact tokens drop gobyexample's footer
 * (86/86), lesscss.org's docs menu and the German navigation boxes (197 on 171 pages), and
 * nothing else. Applied to the prose path only; `tables.ts` keeps its own classifier.
 */
const FURNITURE_CLASS_TOKENS = new Set([
  'footer',
  'site-footer',
  'nav',
  'navbar',
  'menu',
  'sidebar',
  'breadcrumb',
  'cookie',
  'navileiste',
  'erweiterte-navigationsleiste',
  'erw-nav-leiste',
  'sisterproject'
])

/**
 * Furniture named by its element id, for a box with no class of its own (#673): German
 * Wikipedia's legal-topics notice ("Bitte den Hinweis zu Rechtsthemen beachten!", 16 of 1,500
 * sampled pages), whose template sets the id and only generic classes. It points to Wikipedia's
 * legal-topics notice, which is not in the archive, and is an instruction to the reader that a
 * model could repeat (owner call, 2026-10-14). An id must match exactly: ids are case-sensitive.
 */
const FURNITURE_IDS = new Set(['Vorlage_Rechtshinweis'])

/**
 * Boxes delivered as a segment of their own, by element id → the segment's label (#673): German
 * Wikipedia's authority data (`Normdaten (Person): GND: … | LCCN: … | VIAF: …`, 227 of 1,500
 * sampled pages, always the article's last text) used to be text of the last section
 * (`Einzelnachweise` on 196 of them). Owner call of 2026-10-14: keep its identifiers answerable,
 * out of the references' last chunk. The box's classes vary with its kind (`normdaten-typ-p`,
 * `-s`, …), so the template's id names it. Honoured on a `div`/`section`, never a `p`.
 */
const SEGMENT_BOX_IDS: ReadonlyMap<string, string> = new Map([['normdaten', 'Normdaten']])

/**
 * The license line mwoffliner appends to every article it writes (#662): `div.zim-footer`,
 * "Dieser Artikel wurde von Wikipedia herausgegeben. Der Text ist unter Creative Commons
 * Attribution-Share Alike 4.0 verfügbar …" on 1,322 of 1,500 sampled German Wikipedia pages
 * (the rest are redirect stubs) and on Alpine Linux's wiki too. It sits after the last section,
 * so it used to be delivered as that section's text (`Weblinks`) — into the last chunk, the
 * viewer and a saved copy. It is the only CC BY-SA notice the app shows for an article, so it
 * leaves the segments like furniture but its text is kept as `ZimArticle.notice`, for the viewer
 * and a saved copy to show apart from the article (owner call, 2026-10-13).
 */
const NOTICE_CLASS_TOKENS = new Set(['zim-footer'])

/** Every furniture and notice token, and every id above, contains one of these: a cheap test on
 *  the raw attributes, so the class and id are parsed only where one could match (most `div`s
 *  carry other classes). */
const FURNITURE_HINT = /footer|nav|menu|sidebar|breadcrumb|cookie|sister|rechtshinweis|normdaten/i

/** The elements a furniture class is honoured on (#627). */
const FURNITURE_ELEMENTS = new Set(['p', 'div', 'section'])

/** Elements that can hold a dropped `div`/`section` and whose end tag, when no element of that
 *  name was opened inside the drop, closes it as well (#662 review). Only elements with a
 *  required end tag, plus the cells and items a box sits in, and never `p`: a stray `</p>` is
 *  common and HTML5 does not let it close a `div`. */
const FURNITURE_HOLDER_TAGS = new Set([
  'section', 'article', 'main', 'aside', 'blockquote', 'details', 'li', 'dd', 'td', 'th', 'body', 'html'
])

/** `'notice'` when a token is a license line's (it wins over a furniture token beside it),
 *  `'drop'` for furniture (a class token or a furniture id), null otherwise. */
function furnitureKind(classAttr: string | null, idAttr: string | null): 'drop' | 'notice' | null {
  if (idAttr !== null && FURNITURE_IDS.has(idAttr)) return 'drop'
  if (classAttr === null) return null
  let kind: 'drop' | null = null
  for (const token of classAttr.split(/\s+/)) {
    const lower = token.toLowerCase()
    if (NOTICE_CLASS_TOKENS.has(lower)) return 'notice'
    if (FURNITURE_CLASS_TOKENS.has(lower)) kind = 'drop'
  }
  return kind
}

/** The longest notice kept (#662): the real line is ~230 characters. The raw text gathered for it
 *  is bounded too, so a page that puts megabytes inside the element costs no more than this. */
const NOTICE_MAX_CHARS = 1500
const NOTICE_RAW_MAX_CHARS = 4 * NOTICE_MAX_CHARS

/** Start tags that end an open `<p>` (every start tag HTML5's tree builder answers with "close a
 *  p element"), so a dropped furniture `<p>` whose end tag is missing cannot swallow the rest of
 *  the page. */
const P_ENDING_START_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'dd', 'details', 'dialog', 'dir', 'div',
  'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hgroup', 'hr', 'li', 'listing', 'main', 'menu', 'nav', 'ol', 'p', 'plaintext',
  'pre', 'search', 'section', 'summary', 'table', 'ul', 'xmp'
])

/** End tags of elements that can hold a `<p>`: their end also ends it. */
const P_ENDING_END_TAGS = new Set([
  ...BLOCK, 'aside', 'body', 'details', 'dialog', 'fieldset', 'figcaption', 'figure', 'form',
  'html', 'li', 'nav', 'td', 'th'
])

/** End tags that close a `<pre>` they hold when its own end tag is missing (#627). */
const PRE_ANCESTOR_END_TAGS = new Set(['li', 'td', 'th', 'body', 'html'])

// NAMED ENTITIES (#663) — the 252 of HTML 4.01 (its three entity sets) plus `apos`.
// Hand-written pages, which zimit archives keep as they are, write typographic entities
// (`&rsquo;` 785 times in 15 pages of htdp.org, `&raquo;` on every PEP page); mwoffliner/Parsoid
// writes the characters themselves. Every name measured undecoded on 15 archives is in this set.
// HTML5's ~2,000 further names (`&ZeroWidthSpace;`, `&lbrack;`, the math names) stay verbatim, as
// any unknown name does: a curated table, not the full one (owner call, 2026-10-13).
//
// HTMLlat1: U+00A0–U+00FF in order, one name per code point.
const HTML401_LATIN1 =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 ' +
  'acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml ' +
  'Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde ' +
  'Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ' +
  'ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide ' +
  'oslash ugrave uacute ucirc uuml yacute thorn yuml'
// HTMLsymbol and HTMLspecial (`name:decimal code point`), plus `apos`. `lang`/`rang` take HTML5's
// code points (U+27E8/U+27E9, what browsers decode), not HTML 4.01's deprecated U+2329/U+232A.
const HTML401_OTHERS =
  'fnof:402 Alpha:913 Beta:914 Gamma:915 Delta:916 Epsilon:917 Zeta:918 Eta:919 Theta:920 Iota:921 ' +
  'Kappa:922 Lambda:923 Mu:924 Nu:925 Xi:926 Omicron:927 Pi:928 Rho:929 Sigma:931 Tau:932 Upsilon:933 ' +
  'Phi:934 Chi:935 Psi:936 Omega:937 alpha:945 beta:946 gamma:947 delta:948 epsilon:949 zeta:950 eta:951 ' +
  'theta:952 iota:953 kappa:954 lambda:955 mu:956 nu:957 xi:958 omicron:959 pi:960 rho:961 sigmaf:962 ' +
  'sigma:963 tau:964 upsilon:965 phi:966 chi:967 psi:968 omega:969 thetasym:977 upsih:978 piv:982 ' +
  'bull:8226 hellip:8230 prime:8242 Prime:8243 oline:8254 frasl:8260 weierp:8472 image:8465 real:8476 ' +
  'trade:8482 alefsym:8501 larr:8592 uarr:8593 rarr:8594 darr:8595 harr:8596 crarr:8629 lArr:8656 ' +
  'uArr:8657 rArr:8658 dArr:8659 hArr:8660 forall:8704 part:8706 exist:8707 empty:8709 nabla:8711 ' +
  'isin:8712 notin:8713 ni:8715 prod:8719 sum:8721 minus:8722 lowast:8727 radic:8730 prop:8733 ' +
  'infin:8734 ang:8736 and:8743 or:8744 cap:8745 cup:8746 int:8747 there4:8756 sim:8764 cong:8773 ' +
  'asymp:8776 ne:8800 equiv:8801 le:8804 ge:8805 sub:8834 sup:8835 nsub:8836 sube:8838 supe:8839 ' +
  'oplus:8853 otimes:8855 perp:8869 sdot:8901 lceil:8968 rceil:8969 lfloor:8970 rfloor:8971 lang:10216 ' +
  'rang:10217 loz:9674 spades:9824 clubs:9827 hearts:9829 diams:9830 ' +
  'quot:34 amp:38 lt:60 gt:62 apos:39 OElig:338 oelig:339 Scaron:352 scaron:353 Yuml:376 circ:710 ' +
  'tilde:732 ensp:8194 emsp:8195 thinsp:8201 zwnj:8204 zwj:8205 lrm:8206 rlm:8207 ndash:8211 ' +
  'mdash:8212 lsquo:8216 rsquo:8217 sbquo:8218 ldquo:8220 rdquo:8221 bdquo:8222 dagger:8224 ' +
  'Dagger:8225 permil:8240 lsaquo:8249 rsaquo:8250 euro:8364'
// The five names that decoded to something other than their code point before #663, unchanged: a
// no-break or typographic space is an ordinary space, a soft hyphen nothing. Every other name —
// the zero-width joiners and direction marks included — decodes to its code point, exactly as its
// numeric form and the literal character do (the tidy's invisible-character rule then treats all
// three alike).
const ENTITY_OVERRIDES: ReadonlyArray<[string, string]> = [
  ['nbsp', ' '],
  ['ensp', ' '],
  ['emsp', ' '],
  ['thinsp', ' '],
  ['shy', '']
]

/** A `Map`, never a plain object: `name in {}` is true for `constructor` or `toString`, which made
 *  `&toString;` decode to that function's source text (#663). */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ...HTML401_LATIN1.split(' ').map((name, i): [string, string] => [name, String.fromCodePoint(0xa0 + i)]),
  ...HTML401_OTHERS.split(' ').map((pair): [string, string] => {
    const [name, cp] = pair.split(':')
    return [name, String.fromCodePoint(Number(cp))]
  }),
  ...ENTITY_OVERRIDES
])

/** No known name is longer (`thetasym`): a longer run after `&` is never looked up. */
const LONGEST_ENTITY_NAME = Math.max(...[...NAMED_ENTITIES.keys()].map((name) => name.length))

/**
 * Decode numeric and named entities (`NAMED_ENTITIES`); unknown named entities are left verbatim.
 * Recognised forms: `&#<decimal>;`, `&#x<hex>;` (lower-case `x` only) and `&<name>;`, a name
 * being a letter followed by letters and digits (`&sup2;`, `&frac12;`). Anything else —
 * including an unterminated `&aaaa` run or an unknown name — is copied through untouched.
 * Single pass: `&amp;rsquo;` reads `&rsquo;`, the literal text a page about HTML means.
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
      if (i < n && isAlpha(text.charCodeAt(i))) {
        i += 1
        while (i < n && isAlnum(text.charCodeAt(i))) i += 1
      }
      if (i > nameAt && i - nameAt <= LONGEST_ENTITY_NAME && i < n && text.charCodeAt(i) === CH_SEMI) {
        value = NAMED_ENTITIES.get(text.slice(nameAt, i)) ?? null
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

/** ASCII letter or digit — an entity name's continuation (`sup2`, `frac12`, #663). */
function isAlnum(cc: number): boolean {
  return isAlpha(cc) || (cc >= 48 && cc <= 57)
}

/** Tag-name continuation, matching the previous tokeniser's `[a-zA-Z0-9-]`. */
function isNameChar(cc: number): boolean {
  return isAlnum(cc) || cc === CH_HYPHEN
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
 * name never carries a quoted value. `unquoted: true` also returns an unquoted value — a
 * minified page writes `<p class=footer>`, and the furniture rule (#627) must still see it.
 */
export function attrValue(attrs: string, name: string, opts?: { unquoted?: boolean }): string | null {
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
    // Unquoted value: outside the default contract — skip it and keep looking.
    const valueAt = j
    while (j < n && !isSpace(attrs.charCodeAt(j))) j += 1
    if (opts?.unquoted === true && attrName === want) return attrs.slice(valueAt, j)
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

  /** `restore`: the text carries kept preformatted whitespace (#627), restored once tidied. */
  push(raw: string, restore = false): void {
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
    // Kept preformatted whitespace (#627) is content to the rules above and is restored only
    // now, piece by piece, so it never needs a whole-segment pass at flush.
    const kept = text.slice(a, b).replace(WHITESPACE_RUN, canonicalRun)
    this.out += restore ? restorePreformatted(kept) : kept
    this.started = true
    this.pending = b < n
    this.pendingNewlines = b < n ? countNewlines(text, b, n) : 0
  }
}

// ---------------------------------------------------------------------------------------
// PREFORMATTED TEXT (#627) — code blocks keep their indentation
// ---------------------------------------------------------------------------------------
// Every whitespace run used to be collapsed, `<pre>` included, so a code block kept its line
// breaks but lost every leading space: 0 of 1,720 indented Go lines on gobyexample, 0 of 38
// indented JavaScript lines on devdocs_en_q. The whitespace a `<pre>` needs is now carried
// through the tidy as two placeholder code units that no whitespace rule touches, and
// restored to real spaces and tabs once the text is final (`IncrementalTidy.push` in prose,
// `serializeTable` in a kept table).
//
// The invariant this rests on: with the placeholders removed, the text is exactly what the
// collapse produced before. A line's indentation and its trailing whitespace become
// placeholders or nothing (the collapse deleted both), and a run inside a line keeps one real
// space and carries the rest. So every consumer that splits on whitespace — the chunker,
// admission, the overlap picker, the reranker, the prompt, citation snippets — reads the same
// words as before; only the article viewer and a saved copy show the indentation. Code also
// stays inside its own segment: flushing it as a segment of its own would repeat the heading
// in the viewer and the saved Markdown, and would narrow the admission lead
// (`segments.slice(0, 1)` in arm.ts) on a page whose code sits before its first heading.

/** Stands for a kept space inside preformatted text: a noncharacter (U+FDD0), reserved for
 *  internal use by Unicode and never valid in interchanged text. */
export const PRE_SPACE = '﷐'
/** Stands for a kept tab inside preformatted text (U+FDD1, also a noncharacter). */
export const PRE_TAB = '﷑'
const PRE_PLACEHOLDERS = /[﷐﷑]/g
const restorePlaceholder = (ch: string): string => (ch === PRE_SPACE ? ' ' : '\t')

/** Two `indexOf` probes rather than a regex: on a one-byte string (most text) V8 answers a
 *  search for a two-byte character without scanning, and every table length pays this check. */
function hasPlaceholder(text: string): boolean {
  return text.indexOf(PRE_SPACE) !== -1 || text.indexOf(PRE_TAB) !== -1
}

/** Turns kept-whitespace placeholders back into the spaces and tabs they stand for. */
export function restorePreformatted(text: string): string {
  return hasPlaceholder(text) ? text.replace(PRE_PLACEHOLDERS, restorePlaceholder) : text
}

/** Removes the two placeholder code units from page text before it is encoded, so a page that
 *  happens to contain them can never inject whitespace. */
export function dropPlaceholders(text: string): string {
  return hasPlaceholder(text) ? text.replace(PRE_PLACEHOLDERS, '') : text
}

/** The length the table caps see: kept preformatted whitespace is not charged, so a cap cuts a
 *  table exactly where it cut it before #627. */
export function visibleLength(text: string): number {
  if (!hasPlaceholder(text)) return text.length
  let kept = 0
  for (let i = 0; i < text.length; i += 1) {
    const cc = text.charCodeAt(i)
    if (cc === 0xfdd0 || cc === 0xfdd1) kept += 1
  }
  return text.length - kept
}

/** The index in `text` at which `budget` visible characters have been passed — the raw cut a
 *  visible-length budget maps to. */
export function indexAtVisible(text: string, budget: number): number {
  if (!hasPlaceholder(text)) return Math.min(budget, text.length)
  let seen = 0
  let i = 0
  while (i < text.length && seen < budget) {
    const cc = text.charCodeAt(i)
    if (cc !== 0xfdd0 && cc !== 0xfdd1) seen += 1
    i += 1
  }
  return i
}

/** Longest kept whitespace run: real indentation never comes near it, and the cap keeps a
 *  whitespace-only pathology from turning into an equally large output. */
export const PRE_MAX_KEPT_RUN = 256

const isPreSpace = (cc: number): boolean => cc === CH_SPACE || cc === CH_TAB || cc === 0xa0

/**
 * Encodes the text runs of one preformatted block (#627). Spaces and tabs are held until the
 * next visible character says what they are: indentation at the start of a line (kept whole),
 * a gap inside a line (one real space plus the rest kept), or trailing whitespace (dropped —
 * a line break or the end of the block follows). State carries across text runs, so a run of
 * indentation that a syntax highlighter's `<span>` closes is still indentation.
 *
 * `indentFirstLine` is false in a table cell, where the first line follows a column key
 * (`docs: code`), so only later lines keep their indentation there.
 */
export class PreformattedWhitespace {
  private lineStart = true
  private seenText = false
  private pending = ''
  private afterCR = false
  private absorbNewline = false
  private readonly indentFirstLine: boolean
  private readonly budget: { left: number } | null

  /** `budget`, when given, is shared and spent by every placeholder written: once it is gone,
   *  whitespace is ordinary again (collapsed), so a kept table stays bounded (#627). */
  constructor(indentFirstLine: boolean, budget: { left: number } | null = null) {
    this.indentFirstLine = indentFirstLine
    this.budget = budget
  }

  /** One decoded text run of the block, encoded. */
  encode(text: string): string {
    let out = ''
    const n = text.length
    let i = 0
    while (i < n) {
      const cc = text.charCodeAt(i)
      if (cc === CH_LF || cc === CH_CR) {
        // CRLF is one line break, even when a piece boundary or a tag falls between the two;
        // and a newline that only follows a block tag's own break is that break, not a second.
        if (!(cc === CH_LF && this.afterCR)) {
          this.pending = ''
          if (this.absorbNewline) this.absorbNewline = false
          else out += '\n'
          this.lineStart = true
        }
        this.afterCR = cc === CH_CR
        i += 1
        continue
      }
      this.afterCR = false
      if (isPreSpace(cc)) {
        let j = i
        while (j < n && isPreSpace(text.charCodeAt(j))) j += 1
        const room = PRE_MAX_KEPT_RUN - this.pending.length
        if (room > 0) this.pending += text.slice(i, Math.min(j, i + room))
        i = j
        continue
      }
      let j = i + 1
      while (j < n) {
        const c = text.charCodeAt(j)
        if (c === CH_LF || c === CH_CR || isPreSpace(c)) break
        j += 1
      }
      out += this.settle() + text.slice(i, j)
      this.lineStart = false
      this.seenText = true
      this.absorbNewline = false
      i = j
    }
    return out
  }

  /** A line break that comes from markup. A block boundary (`soft`) ends the line, so a source
   *  newline right after it adds nothing; a `<br>` is a break of its own — two make a blank line. */
  lineBreak(soft: boolean): void {
    this.pending = ''
    this.lineStart = true
    this.afterCR = false
    this.absorbNewline = soft
  }

  private settle(): string {
    const ws = this.pending
    if (ws.length === 0) return ''
    this.pending = ''
    const atLineStart = this.lineStart
    // At a line start the whole run is kept (bar a table cell's first line); inside a line, one
    // real space stays so the words stay apart, and the rest is kept.
    const kept = atLineStart ? (this.indentFirstLine || this.seenText ? ws.length : 0) : ws.length - 1
    if (kept === 0) return ' '
    if (this.budget !== null) {
      if (this.budget.left < kept) return ' '
      this.budget.left -= kept
    }
    return atLineStart ? toPlaceholders(ws) : ` ${toPlaceholders(ws.slice(1))}`
  }
}

function toPlaceholders(ws: string): string {
  let out = ''
  for (let i = 0; i < ws.length; i += 1) out += ws.charCodeAt(i) === CH_TAB ? PRE_TAB : PRE_SPACE
  return out
}

export interface ZimConvertOptions {
  /** Input cap in chars (default 1 MiB = 1_048_576): everything past it is not converted. */
  maxChars?: number
  /** Scan-work cap in work units (default 4 × maxChars); the scanner stops at the cap and
   *  reports partial output rather than stalling the ask path. */
  maxWork?: number
  /**
   * Default true. Set false to reproduce the pre-table-delivery behaviour (every `<table>`
   * dropped whole, `SKIP_SUBTREE`-style) — used only to measure the table-delivery change's
   * own cost and non-table invariant (comparing a `true`/`false` conversion of the same
   * article is how a table-derived segment is told apart from a prose one, without adding a
   * `kind` field to `ExtractedSegment`). Product call sites never set this.
   */
  emitTables?: boolean
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
  /**
   * The archive's own license line (mwoffliner's `zim-footer`, #662), whitespace collapsed, or
   * null when the page has none. Never part of `segments`, so retrieval never reads it; the
   * article viewer and a saved copy show it apart from the article text.
   */
  notice: string | null
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
  const emitTables = opts.emitTables ?? true
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
  // A table dropped by its class (layout/navbox — `tables.ts`'s `isLayoutTableClass`) is
  // skipped exactly like SKIP_SUBTREE, but `table` is no longer in that shared set (a kept
  // table needs its own branch below), so it gets its own depth counter.
  let tableDropDepth = 0
  // Site furniture (#627): a `p`/`div`/`section` whose class names the page's own footer,
  // navigation, menu, sidebar, breadcrumb or cookie notice is dropped with its subtree.
  // `furnitureTag` is the element that opened the drop; a `div`/`section` closes on its own
  // matching end tag (same-name depth) or on the end tag of an element holding it (below), a `p`
  // also on anything HTML5 lets close it.
  let furnitureDepth = 0
  let furnitureTag: string | null = null
  // Holder elements (`FURNITURE_HOLDER_TAGS`) opened INSIDE the dropped element, per name: an end
  // tag of one that was not opened inside belongs to an element holding the furniture, and closes
  // it too, as HTML5 closes an open `div` at its section's end — so a box whose own end tag is
  // missing costs the rest of its section, never the rest of the page (#662 review).
  const furnitureHeld = new Map<string, number>()
  // The license line (#662) is dropped the same way, but while `furnitureNotice` is set its text
  // is gathered into `noticeBuf` (bounded by NOTICE_RAW_MAX_CHARS) instead of being discarded;
  // `noticeClipped` records that the bound cut it.
  let furnitureNotice = false
  let noticeBuf = ''
  let noticeClipped = false
  const endFurniture = (): void => {
    furnitureDepth = 0
    furnitureTag = null
    furnitureNotice = false
    furnitureHeld.clear()
  }
  /** Appends to the notice until the bound has cut it (text runs are sized to it by the caller;
   *  a separator past it is simply not written). */
  const gatherNotice = (text: string): void => {
    if (!noticeClipped && noticeBuf.length < NOTICE_RAW_MAX_CHARS) noticeBuf += text
  }
  // A box delivered as a segment of its own (#673, `SEGMENT_BOX_IDS`): its text takes every
  // ordinary text rule under the box's label, while what came before it and what follows it in
  // its section keep the section's label (`boxOuterLabel`). `boxTag` is the element that opened
  // it; like a dropped box it closes on its own matching end tag or on the end tag of an element
  // holding it (`boxHeld`, as `furnitureHeld`), and also at a heading, which starts a section.
  let boxTag: string | null = null
  let boxDepth = 0
  let boxOuterLabel: string | null = null
  const boxHeld = new Map<string, number>()
  const endBox = (): void => {
    flush()
    currentLabel = boxOuterLabel
    boxTag = null
    boxDepth = 0
    boxHeld.clear()
  }
  // Preformatted text (#627): `preDepth` counts open `<pre>`s, `pre` encodes their whitespace
  // while one is open (prose only — never into a heading), and `preInner` names the block
  // elements opened inside it, so the end tag of an element that HOLDS the `<pre>` can close a
  // `<pre>` left unclosed — an inner `<p>` or `<li>` whose end tag is missing included. Each
  // entry is popped at most once, so the stack is linear in the tags it saw.
  let preDepth = 0
  let pre: PreformattedWhitespace | null = null
  let preInner: string[] = []
  const closePre = (): void => {
    preDepth = 0
    pre = null
    preInner = []
  }
  // A figure's caption text should reach a segment even though the
  // image and the rest of the figure subtree stay dropped — mirrors the kept-table path's own
  // `<caption>` handling. `skipIsFigure` is true only while the CURRENTLY OPEN skip (skipDepth
  // > 0) was opened by a `<figure>` (set at the SKIP_SUBTREE-open branch below, reset once
  // skipDepth returns to 0). `figureCaptionDepth` is > 0 while a `<figcaption>` is open inside
  // that figure skip (a capture, not a suppression: `emitTextUpTo` below routes its text into
  // `captionBuf` instead of dropping it). `figureInnerSkipDepth` counts the non-`figure`
  // SKIP_SUBTREE elements (svg/template — script/style are already stepped over by S5 before
  // this branch ever runs) open inside that figure, whether or not a caption is open: a
  // `<figcaption>` inside one of THOSE never starts a capture, and text inside one never reaches
  // the buffer. A nested `<figure>` does NOT arm this counter — its own `<figcaption>` is
  // content the capture is meant to deliver, so it is handled exactly like any figure's caption.
  let skipIsFigure = false
  let figureCaptionDepth = 0
  let figureInnerSkipDepth = 0
  let captionBuf = ''
  // The caption's own copy of the sup/sub state (#488's convention, the one `emit` and
  // `tables.ts` apply). The capture appends to `captionBuf` directly, never through `emit`, so it
  // arms, resolves and disarms its own marker against the caption's last character, and skips
  // its own `mw-ref` citation brackets. Without it a caption read `H2O` where the prose beside
  // it reads `H_2O`.
  let captionPendingMark: string | null = null
  let captionRefSkipDepth = 0
  const resetCaption = (): void => {
    captionBuf = ''
    captionPendingMark = null
    captionRefSkipDepth = 0
  }
  // Mirrors tables.ts's TABLE_SEGMENT_MAX_CHARS (1500) by value, not by import — html.ts does
  // not depend on tables.ts (the dependency runs the other way).
  const FIGURE_CAPTION_MAX_CHARS = 1500

  // The sup/sub marker an ordinary `<sup>`/`<sub>` open tag ARMED, still waiting for the
  // element's own text (#488). It is written only if that text turns out to start where a
  // marker would sit between alphanumerics; anything else — a close tag, a block boundary, a
  // citation skip, a table — disarms it. `lastEmittedChar` is the last code point actually
  // written into whichever buffer is current (body or heading): maintained at the single `emit`
  // funnel below and cleared at every block/segment boundary by `endMarkRun`, so a
  // paragraph-initial `<sup>` has no `prev` to mark against and never marks.
  let pendingMark: string | null = null
  let lastEmittedChar = ''

  /** A block or segment boundary: an armed marker cannot cross it, and nothing written before
   *  it can be the character a marker follows. */
  const endMarkRun = (): void => {
    pendingMark = null
    lastEmittedChar = ''
  }

  const flush = (): void => {
    const text = body.result()
    if (text.length > 0) segments.push({ text, pageNumber: null, sectionLabel: currentLabel })
    body.reset()
    endMarkRun()
  }

  /** `preformatted`: `raw` is encoded preformatted text whose placeholders the body restores. */
  const emit = (raw: string, preformatted = false): void => {
    if (raw.length === 0) return
    let text = raw
    if (pendingMark !== null) {
      // The armed marker is resolved by the FIRST text emitted after it — the sup/sub's own
      // text — and is consumed either way, so it can never attach to a later run. The heading
      // that becomes the TITLE never takes one (#711): a title is a label, a citation and a
      // de-duplication key, so `CO<sub>2</sub>-Steuer` stays `CO2-Steuer`; every later heading
      // marks like prose.
      const mark = pendingMark
      pendingMark = null
      const inTitle = headingLevel > 0 && title === null
      if (!inTitle && shouldMark(lastEmittedChar, text)) text = mark + text
    }
    if (headingLevel > 0) {
      headingBuf += text
      headingNewlines = trailingNewlines(text, headingNewlines)
    } else {
      body.push(text, preformatted)
    }
    lastEmittedChar = lastCharOf(text)
  }

  /** A block boundary: one newline, unless two already terminate the text. Inside
   *  preformatted text a block boundary ends the line, never adds a blank one, while a `<br>`
   *  (`hard`) is always a line break of its own (#627). */
  const emitBreak = (hard = false): void => {
    endMarkRun()
    if (pre !== null && headingLevel === 0) {
      pre.lineBreak(!hard)
      if (!hard && body.carryNewlines >= 1) return
      emit('\n')
      return
    }
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
    if (skipDepth === 0 && supSkipDepth === 0 && mathDepth === 0 && tableDropDepth === 0 && furnitureDepth === 0) {
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
        const text = decodeEntities(input.slice(from, to))
        if (pre !== null && headingLevel === 0) emit(pre.encode(dropPlaceholders(text)), true)
        else emit(text)
        from = to
        // One piece is the indivisible unit of emission work, so every piece that is not the
        // last of the run ends a slice. A run of at most TEXT_PIECE_CHARS is one piece and
        // yields nothing, which is why ordinary articles are still single-slice.
        if (from < upto) {
          noteSlice()
          yield
        }
      }
    } else if (skipDepth > 0 && skipIsFigure && figureCaptionDepth > 0 && figureInnerSkipDepth === 0) {
      // A figure's caption text is captured into its own buffer while the rest of the
      // figure subtree stays dropped. Not piece-wise like the ordinary path above — a caption
      // is short by construction (capped at flush, below) — so one decode call is enough,
      // exactly like `headingBuf`'s own whole-string accumulation via `emit`.
      if (captionRefSkipDepth === 0) {
        let text = decodeEntities(input.slice(textStart, upto))
        if (text.length > 0 && captionPendingMark !== null) {
          // Resolved by the first text after the open tag and consumed either way, as in `emit`.
          if (shouldMark(lastCharOf(captionBuf), text)) text = captionPendingMark + text
          captionPendingMark = null
        }
        captionBuf += text
      }
    } else if (furnitureNotice && !noticeClipped) {
      // The license line's text (#662). Only what the notice still has room for is decoded, so
      // a huge text run inside the element is never one long decode. Where the bound cuts, the
      // last word goes too — it can be part of an entity or of a surrogate pair.
      const to = Math.min(upto, textStart + Math.max(0, NOTICE_RAW_MAX_CHARS - noticeBuf.length))
      let text = decodeEntities(input.slice(textStart, to))
      if (to < upto) {
        const lastBreak = text.search(/\s\S*$/)
        text = lastBreak >= 0 ? text.slice(0, lastBreak) : ''
      }
      gatherNotice(text)
      if (to < upto) noticeClipped = true
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
    if (furnitureDepth > 0) {
      // Nothing else can be open while furniture is dropped: it starts only from the plain
      // prose state, and every tag inside it is consumed here. The break taken where it opened
      // already separates what follows it.
      if (furnitureTag !== 'p') {
        let holderEnds = false
        if (name === furnitureTag) {
          if (!selfClosing) {
            furnitureDepth += isClose ? -1 : 1
            if (furnitureDepth === 0) {
              endFurniture()
              continue
            }
          }
        } else if (FURNITURE_HOLDER_TAGS.has(name) && !selfClosing) {
          const held = furnitureHeld.get(name) ?? 0
          if (!isClose) furnitureHeld.set(name, held + 1)
          else if (held > 0) furnitureHeld.set(name, held - 1)
          else holderEnds = true
        }
        if (!holderEnds) {
          // Inside a license line a block boundary still keeps two words apart (#662).
          if (furnitureNotice && (name === 'br' || BLOCK.has(name))) gatherNotice(' ')
          continue
        }
        // The end tag of an element holding the furniture ends it too, and is then handled as
        // itself, below.
        endFurniture()
      } else {
        if (isClose && name === 'p') {
          endFurniture()
          continue
        }
        // A `p` has an optional end tag: a block start tag, or the end tag of an element that
        // can hold the `p`, ends it — and is then handled as itself, below.
        if (!(isClose ? P_ENDING_END_TAGS.has(name) : P_ENDING_START_TAGS.has(name))) {
          if (furnitureNotice && name === 'br') gatherNotice(' ')
          continue
        }
        endFurniture()
      }
    }
    if (mathDepth > 0) {
      if (name === 'math') mathDepth += isClose ? -1 : 1
      continue
    }
    if (skipDepth > 0) {
      // A <figcaption> inside a <figure> skip opens/closes the caption capture; the
      // text itself is routed by `emitTextUpTo` above, this only tracks the state. Guarded on
      // `figureInnerSkipDepth === 0` so a `<figcaption>` occurring (invalidly) inside a nested
      // svg/template never starts a capture at all — that subtree stays dropped whole.
      if (name === 'figcaption' && skipIsFigure && figureInnerSkipDepth === 0) {
        // A self-closing `<figcaption/>` is neither an open nor a close: ignored on BOTH sides
        // of the split, exactly as the SKIP_SUBTREE branch below ignores one. Otherwise it
        // would fall into the close branch, end an open caption early and drop the rest of it.
        if (selfClosing) continue
        if (!isClose) {
          figureCaptionDepth += 1
        } else if (figureCaptionDepth > 0) {
          figureCaptionDepth -= 1
          if (figureCaptionDepth === 0) {
            // On the matching close: decode already happened per chunk above, so only tidy
            // (the same whole-string helper ordinary text uses) and cap — mirrors the
            // kept-table path's own `Caption: ` line and its TABLE_SEGMENT_MAX_CHARS cap.
            const tidied = tidyWhole(captionBuf)
            resetCaption()
            const capped =
              tidied.length <= FIGURE_CAPTION_MAX_CHARS ? tidied : capChars(tidied, FIGURE_CAPTION_MAX_CHARS)
            if (capped.length > 0) {
              // Byte-for-byte the shape and flush order the kept-table path uses: flush the
              // pending prose first so the caption never fuses into the surrounding paragraph,
              // then push the caption straight into `segments` (never through `emit`/`body`).
              flush()
              segments.push({ text: `Caption: ${capped}`, pageNumber: null, sectionLabel: currentLabel })
            }
          }
        }
        continue
      }
      if ((name === 'sup' || name === 'sub') && skipIsFigure && figureCaptionDepth > 0 && figureInnerSkipDepth === 0) {
        // Inside an open caption: the prose branch's sup/sub handling below, on the caption's
        // own state. While a citation bracket is skipped, every nested `<sup>` is counted on
        // open and close, so a plain one inside it cannot end the skip early.
        if (captionRefSkipDepth > 0) {
          if (name === 'sup' && !selfClosing) captionRefSkipDepth += isClose ? -1 : 1
          continue
        }
        if (isClose) {
          captionPendingMark = null
        } else if (!selfClosing) {
          if (name === 'sup' && REF_SUP_CLASS_RE.test(attrValue(attrs, 'class') ?? '')) {
            captionPendingMark = null
            captionRefSkipDepth = 1
          } else {
            captionPendingMark = name === 'sup' ? SUP_MARK : SUB_MARK
          }
        }
        continue
      }
      if (SKIP_SUBTREE.has(name) && !selfClosing) {
        skipDepth += isClose ? -1 : 1
        if (skipDepth === 0) {
          skipIsFigure = false
          figureCaptionDepth = 0
          figureInnerSkipDepth = 0
          resetCaption()
        } else if (skipIsFigure && name !== 'figure') {
          // Counts only the non-`figure` skipped subtrees (svg/template/nav/noscript/head) open
          // INSIDE the figure, incremented/decremented on their own opens/closes and never
          // below zero: a `<figcaption>` nested in one of THOSE would otherwise start a real
          // capture and leak the dropped subtree's text. `figure` is excluded on purpose — a
          // `<figure>` nested inside a `<figure>` is valid HTML5 flow content and its OWN
          // `<figcaption>` is content the capture is meant to deliver, handled by the branch
          // above exactly as any figure's caption is; only `skipDepth` (not this counter) tracks
          // the nested figure's own open/close, so the outer figure's skip still closes
          // correctly once both have closed.
          figureInnerSkipDepth += isClose ? -1 : 1
          if (figureInnerSkipDepth < 0) figureInnerSkipDepth = 0
        }
      }
      continue
    }
    if (tableDropDepth > 0) {
      if (name === 'table' && !selfClosing) tableDropDepth += isClose ? -1 : 1
      continue
    }
    if (supSkipDepth > 0) {
      if (name === 'sup' && !selfClosing) supSkipDepth += isClose ? -1 : 1
      continue
    }
    const hinted =
      !isClose &&
      !selfClosing &&
      headingLevel === 0 &&
      pre === null && // inside a code block it is code, and its end tag must reach the `<pre>`
      FURNITURE_ELEMENTS.has(name) &&
      FURNITURE_HINT.test(attrs)
    const id = hinted ? attrValue(attrs, 'id', { unquoted: true }) : null
    const boxLabel = id !== null && boxTag === null && name !== 'p' ? SEGMENT_BOX_IDS.get(id) : undefined
    if (boxLabel !== undefined) {
      // A box that becomes a segment of its own (#673) where it stands: what came before it ends
      // here, under its section's label.
      flush()
      boxOuterLabel = currentLabel
      currentLabel = boxLabel
      boxTag = name
      boxDepth = 1
      continue
    }
    const furniture = hinted ? furnitureKind(attrValue(attrs, 'class', { unquoted: true }), id) : null
    if (furniture !== null) {
      // Still a block boundary, so the text before and after the dropped element stays apart.
      emitBreak()
      furnitureDepth = 1
      furnitureTag = name
      furnitureNotice = furniture === 'notice'
      // A second license line on one page is kept too, after the first (#662).
      if (furnitureNotice && noticeBuf.length > 0) gatherNotice(' ')
      continue
    }
    if (boxTag !== null && !selfClosing) {
      if (name === boxTag) {
        boxDepth += isClose ? -1 : 1
        if (boxDepth === 0) {
          endBox()
          continue
        }
      } else if (FURNITURE_HOLDER_TAGS.has(name)) {
        const held = boxHeld.get(name) ?? 0
        if (!isClose) boxHeld.set(name, held + 1)
        else if (held > 0) boxHeld.set(name, held - 1)
        // The end tag of an element holding the box ends it too, and is then handled as itself.
        else endBox()
      } else if (!isClose && /^h[1-6]$/.test(name)) {
        endBox() // a heading starts the next section, and is then handled as itself
      }
    }

    if (!isClose && SKIP_SUBTREE.has(name)) {
      if (!selfClosing) {
        skipDepth = 1
        skipIsFigure = name === 'figure'
      }
      continue
    }
    if (!isClose && name === 'table') {
      if (selfClosing) continue // no body — nothing to classify or capture
      // A table's text is delivered as its own segments (or dropped): either way it is a
      // segment break, so no armed marker and no `prev` character crosses it (#488) — nor
      // whitespace a `<pre>` holding it had read but not yet placed (#627).
      endMarkRun()
      pre?.lineBreak(true)
      const cls = attrValue(attrs, 'class')
      if (!emitTables || isLayoutTableClass(cls)) {
        tableDropDepth = 1
        continue
      }
      // `cursor` already sits right after this opening tag's `>` (set above, unconditionally,
      // for every tag) — exactly where the table's own small tokenizer needs to start.
      const tableStart = cursor
      const { table, end } = parseTableBody(input, tableStart)
      // Charge the bytes this sub-scan examined to the same `work` counter the outer loop is
      // bounded by (html.ts's header note, "the linear-scanner contract holds" — a kept table
      // is examined once here and never revisited by the outer loop, so the whole conversion
      // stays linear in the input length; see docs/known-limitations.md for the one residual
      // this leaves, an unsliced synchronous stall for a single huge kept table).
      work += Math.max(1, end - tableStart)
      if (hasDeliverableContent(table)) {
        flush()
        // Grid expansion and serialisation are their own cost, independent of the table's own
        // source bytes (a small span-heavy table can expand into a much larger grid) — charged
        // here as `workUnits`, on top of the byte charge above, and INCLUDES every nested table
        // this one absorbed (#478: a nested table's own grid/line-building cost used to be
        // charged nowhere at all). Both are bounded by tables.ts's own fixed caps, not by the
        // input length, which is exactly why the LINEAR SCANNER — complexity record above
        // states a separate, additive bound for table-derived work instead of folding it into
        // the prose K·n + c formula.
        const { segments: texts, workUnits } = serializeTable(table)
        work += workUnits
        for (const text of texts) {
          segments.push({ text, pageNumber: null, sectionLabel: currentLabel })
        }
      }
      cursor = end
      textStart = end
      continue
    }
    if (!isClose && name === 'math') {
      // The LaTeX source rides in alttext; emit it once, skip the MathML rendering tree.
      const alt = attrValue(attrs, 'alttext')
      if (alt) emit(` ${normalizeMath(decodeEntities(alt))} `)
      if (!selfClosing) mathDepth = 1
      continue
    }
    if (name === 'sup') {
      // Reference brackets ([1], [note 2]) are retrieval noise and stay dropped whole; every
      // other superscript keeps its text and ARMS a `^` (#488 — the shared convention in
      // `supsub.ts`, the one `tables.ts` has used since #478). The marker is not written here:
      // `emit` writes it only if the element's own text starts where `shouldMark` holds, which
      // is what leaves a reference back-link (`↑ <sup>a</sup>`) and a paragraph-initial `<sup>`
      // unmarked. The text run before this tag was already emitted above (`emitTextUpTo(lt)`),
      // which is what makes `lastEmittedChar` the character the marker would follow; `emit`
      // routes the marked text exactly like ordinary character data, so a `<sup>` inside a
      // heading marks the heading and one in a paragraph marks the body. A self-closing
      // `<sup/>` has no text and arms nothing, exactly as the citation branch ignores one, and
      // the close tag disarms — so an EMPTY `<sup></sup>` now leaves nothing at all.
      if (isClose) {
        pendingMark = null
        continue
      }
      const cls = attrValue(attrs, 'class') ?? ''
      if (REF_SUP_CLASS_RE.test(cls)) {
        pendingMark = null
        if (!selfClosing) supSkipDepth = 1
        continue
      }
      if (!selfClosing) pendingMark = SUP_MARK
      continue
    }
    if (name === 'sub') {
      // Same convention, `_value` — `H<sub>2</sub>O` reads `H_2O` and `NO<sub>x</sub>` reads
      // `NO_x`. There is no citation kind of `<sub>`, so no skip-depth counterpart.
      if (isClose) pendingMark = null
      else if (!selfClosing) pendingMark = SUB_MARK
      continue
    }

    const h = /^h([1-6])$/.exec(name)
    if (h) {
      // Both halves switch which buffer `emit` writes into, so both end the current mark run
      // (#488): the heading starts with nothing to its left, and the body resumes after one.
      // The same holds for a `<pre>`'s unplaced whitespace (#627).
      endMarkRun()
      pre?.lineBreak(true)
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

    if (name === 'pre' && !selfClosing) {
      // #627: a `<pre>` is still a block boundary, taken OUTSIDE the block on both sides.
      if (!isClose) {
        emitBreak()
        preDepth += 1
        if (pre === null) pre = new PreformattedWhitespace(true)
      } else {
        if (preDepth > 0) preDepth -= 1
        if (preDepth === 0) closePre()
        emitBreak()
      }
      continue
    }
    if (pre !== null && !selfClosing && (BLOCK.has(name) || PRE_ANCESTOR_END_TAGS.has(name))) {
      // Block markup inside a `<pre>` (a highlighter's line `<div>`s) is matched to its own end
      // tag; an end tag nothing inside opened belongs to an element holding the `<pre>`.
      if (!isClose) {
        preInner.push(name)
      } else {
        const at = preInner.lastIndexOf(name)
        if (at >= 0) preInner.length = at
        else closePre()
      }
    }
    if (name === 'br' || BLOCK.has(name)) emitBreak(name === 'br')
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

  // One line of text: the source's own line breaks and block boundaries are only layout here. A
  // notice the bounds cut ends in an ellipsis, so it is never shown as the whole line.
  const noticeText = tidyWhole(noticeBuf).replace(WHITESPACE_RUN, ' ')
  const notice =
    noticeText.length === 0
      ? null
      : noticeClipped || noticeText.length > NOTICE_MAX_CHARS
        ? `${capChars(noticeText, NOTICE_MAX_CHARS - 2).trimEnd()} …`
        : noticeText

  return { title, segments, notice, truncated, work, slices }
}

/**
 * The article viewer's sections (and a saved copy's), one per segment. A heading's segment
 * starts with the heading's own line, which the viewer renders as the section label, so that line
 * is dropped from the text. Only a whole first line equal to the label is one (#673): a segment
 * whose text merely starts with the label's words keeps its text whole. The Normdaten box
 * (`Normdaten (Person): GND: …`) used to read ` (Person): GND: …`, indented under `pre-wrap`, and
 * a section's later text that started with its name lost that word (`FAT16 ist ein …`).
 */
export function articleSections(
  segments: readonly ExtractedSegment[]
): Array<{ label: string | null; text: string }> {
  return segments.map((s) => {
    let text = s.text
    if (s.sectionLabel && (text === s.sectionLabel || text.startsWith(`${s.sectionLabel}\n`))) {
      text = text.slice(s.sectionLabel.length).replace(/^\n+/, '')
    }
    return { label: s.sectionLabel ?? null, text }
  })
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

/** Truncates a figure caption or a license notice to `max` characters, never inside a UTF-16
 *  surrogate pair — the same care tables.ts's own segment caps take (its `truncateToBudget`),
 *  duplicated rather than imported since that helper is not exported. */
function capChars(text: string, max: number): string {
  let cut = max
  const prev = text.charCodeAt(cut - 1)
  const next = text.charCodeAt(cut)
  if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) cut -= 1
  return text.slice(0, cut)
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
