// The superscript/subscript convention shared by the ZIM converter and the retrieval matchers
// (issue #488; `docs/rag-design.md` §17).
//
// mwoffliner/Parsoid prose is full of `m<sup>2</sup>`, `10<sup>6</sup>` and `H<sub>2</sub>O`.
// The prose scanner used to drop those tags silently, so a reader and the model saw `m2`,
// `106` and `H2O` — an exponent fused into its base, `10<sup>6</sup>` reading as a hundred and
// six. Table-derived text already kept them readable (#478, `tables.ts`); this module is what
// lets the SAME convention reach ordinary prose without moving retrieval. Two sides:
//
//   • EMITTING — `html.ts` (prose, headings) and `tables.ts` (cells, captions) ARM
//     `SUP_MARK` / `SUB_MARK` on an ordinary `<sup>`/`<sub>` open tag and write it immediately
//     before the element's own text, but ONLY where `shouldMark` holds: a bare marker, no
//     braces, no spaces, so `g/cm<sup>3</sup>` reads `g/cm^3` and `H<sub>2</sub>O` reads
//     `H_2O`. `REF_SUP_CLASS_RE` is the shared predicate for the one `<sup>` kind both drop
//     instead of marking: `<sup class="mw-ref">` citation brackets ([1], [note 2]) are
//     retrieval noise.
//   • FOLDING — `foldSupSub` removes a marker that sits BETWEEN two alphanumerics, and the
//     matchers run it over BOTH sides before they compare: `arm.ts`'s `queryTerms` /
//     `overlapScore` (question and chunk text) and `admit.ts`'s question/lead/wide inputs.
//
// Emitting and folding live in ONE file on purpose: the two sides cannot drift apart, and a
// third shape can only be added by adding it to both.
//
// WHERE A MARKER IS WRITTEN — `shouldMark`, and why it exists (revised after the first census).
// The first cut of #488 marked EVERY ordinary `<sup>`/`<sub>`. A census over 949 cached German
// Wikipedia articles plus 488 from seven other archives then counted 12,483 insertions of which
// only 18 % were a shape the fold removes. 63 % landed in the reference-list back-link runs —
// `↑ a b c` became `↑ ^a ^b ^c`, because those `<sup>` elements carry no `mw-ref`/`reference`
// class and each is preceded by a SPACE — and Greek Wikivoyage puts a whole sentence in a
// paragraph-initial `<sup>`, so 88 of its 100 sampled articles began `^Πατήστε…`. A marker that
// does not sit between two alphanumerics is noise for the reader and folds to nothing for the
// matchers, so it is simply not written: `shouldMark` is the emit predicate, and the emitted
// shapes are (bar one deliberate exception, below) exactly the folded shapes.
//
// THE INVARIANT the matchers actually need. Both compare by SUBSTRING (`overlapScore`'s
// `hay.includes(term)` and `admit.ts`'s `lex`, over terms that are alphanumeric runs of ≥ 3
// characters), so REMOVING characters from the haystack can never break a term that matched
// before — only a marker that SURVIVES between two alphanumerics can, by splitting a run in
// two. Hence the invariant, in the form that is true of this design: every alphanumeric run of
// the pre-#488 text is still a substring of the folded new text. The one shape `shouldMark`
// admits that the fold does NOT remove is a sign-suffixed exponent (`10^−6`, `Na^+`, `10^±3`):
// the sign already splits the run, so the marker beside it can move no term, and it is what
// makes the value read as an exponent rather than as `106`.
//
// `_` FOLDS SYMMETRICALLY WITH `^` (also revised by the census). The first cut folded `_` only
// before a DIGIT, so that `snake_case` in the code-oriented archives (devdocs, gobyexample)
// kept tokenising as two words. Measured, that rule cost 86 real match terms in 36 articles,
// every one of them a `_` followed by a letter: `NO_x`, `SO_x`, `pK_S`, `pK_b`, `kW_p`,
// `MW_th`, `MW_therm`, `T_krit`, `k_BT`, `C_org`, `U_max`, … — a question typing `NOx` stopped
// matching the article that writes `NO<sub>x</sub>` — while the two packs the rule was written
// to protect carry no `<sub>` at all in that sample. The consequence of dropping the digit-only
// clause, stated plainly: a typed `snake_case` now yields the single term `snakecase`, and so
// does an article that writes it the same way, so a code identifier still matches ITSELF; what
// it no longer matches is an article that writes it as `snake case`. That is the accepted price
// of the 86 terms above.
//
// See `math.ts`'s header for the sibling rule that is NOT changed by this: `<math alttext>`
// still normalises to PLAIN characters (`mv^{2}` → `mv2`, never `mv²`), because the tokeniser
// counts `₂`/`²` as `\p{N}` and a typed "CO2" could never match them. Folding a marker back
// out is cheap; folding a superscript codepoint back out is not.

/** Reference/citation superscripts: the `<sup>` kind both the prose and the table path drop
 *  whole rather than marking. Shared so the two paths cannot disagree about what a citation
 *  bracket is. */
export const REF_SUP_CLASS_RE = /\b(?:mw-ref|reference)\b/

/** Written immediately before an ordinary `<sup>`'s own text, where `shouldMark` holds. */
export const SUP_MARK = '^'

/** Written immediately before a `<sub>`'s own text, where `shouldMark` holds. */
export const SUB_MARK = '_'

/** The `prev` half: exactly ONE code point, and it must be a letter or a digit. Anchored at
 *  both ends because callers pass a single character (`lastCharOf` below), never a buffer —
 *  the `u` flag makes an astral letter one unit rather than two surrogates. */
const MARK_PREV_RE = /^[\p{L}\p{N}]$/u

/** The `next` half: a letter or a digit, or one of the four signs an exponent may carry —
 *  `+`, `-` (ASCII hyphen-minus), `−` (U+2212 MINUS SIGN) and `±` (U+00B1). Only the FIRST code
 *  point is examined, so a caller may pass the whole text run that follows. */
const MARK_NEXT_RE = /^[\p{L}\p{N}+\-−±]/u

/**
 * Should a `<sup>`/`<sub>` marker be written between these two characters? True only where it
 * will sit BETWEEN alphanumerics — `prev` a letter or digit, `next` a letter, a digit or a sign
 * (`10^−6`, `Na^+`, which split no alphanumeric run and read as exponents). Whitespace,
 * punctuation, a block or segment boundary (`prev` is then the empty string) and an empty
 * element all answer false, which is what keeps a reference back-link (`↑ <sup>a</sup>`, always
 * preceded by a space) and a paragraph-initial `<sup>` unmarked.
 */
export function shouldMark(prev: string, next: string): boolean {
  return MARK_PREV_RE.test(prev) && MARK_NEXT_RE.test(next)
}

/** The last CODE POINT of `text` as a string, `''` when empty — the `prev` argument of
 *  `shouldMark`. Surrogate-pair aware (a lone low surrogate is neither a letter nor a digit,
 *  so slicing one character off blindly would silently suppress a real mark), and O(1): a
 *  converter buffer must never be re-scanned to find its own last character. */
export function lastCharOf(text: string): string {
  const n = text.length
  if (n === 0) return ''
  const cc = text.charCodeAt(n - 1)
  if (n > 1 && cc >= 0xdc00 && cc <= 0xdfff) {
    const hi = text.charCodeAt(n - 2)
    if (hi >= 0xd800 && hi <= 0xdbff) return text.slice(n - 2)
  }
  return text.slice(n - 1)
}

/** A `^` or `_` BETWEEN two alphanumerics — exactly `m^2`, `10^6`, `g/cm^3`, `20^th`, `H_2O`,
 *  `NO_x`, `pK_S`, `x_i`. A marker that starts a run (`^[note 1]`, `_foo`), stands alone
 *  (`a ^ b`) or precedes a non-alphanumeric (`a^®`, `10^−6`) splits no alphanumeric run, so it
 *  is left alone. */
const SUPSUB_FOLD_RE = /(?<=[\p{L}\p{N}])[\^_](?=[\p{L}\p{N}])/gu

/**
 * Remove the sup/sub markers the converter emits, so a matcher compares text in which every
 * alphanumeric run of the pre-#488 text is still a substring (`m^2` → `m2`, `10^6` → `106`,
 * `H_2O` → `H2O`, `NO_x` → `NOx`). Total and allocation-free on text that carries neither
 * marker — it runs per chunk on the ask path.
 */
export function foldSupSub(text: string): string {
  if (!text.includes(SUP_MARK) && !text.includes(SUB_MARK)) return text
  return text.replace(SUPSUB_FOLD_RE, '')
}
