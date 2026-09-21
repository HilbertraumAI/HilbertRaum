// The superscript/subscript convention shared by the ZIM converter and the retrieval matchers
// (issue #488; `docs/rag-design.md` §17).
//
// mwoffliner/Parsoid prose is full of `m<sup>2</sup>`, `10<sup>6</sup>` and `H<sub>2</sub>O`.
// The prose scanner used to drop those tags silently, so a reader and the model saw `m2`,
// `106` and `H2O` — an exponent fused into its base, `10<sup>6</sup>` reading as a hundred and
// six. Table-derived text already kept them readable (#478, `tables.ts`); this module is what
// lets the SAME convention reach ordinary prose without moving retrieval. Two sides:
//
//   • EMITTING — `html.ts` (prose, headings) and `tables.ts` (cells, captions) write
//     `SUP_MARK` / `SUB_MARK` immediately before the sup/sub's own text: a bare marker, no
//     braces, no spaces, so `g/cm<sup>3</sup>` reads `g/cm^3` and `H<sub>2</sub>O` reads
//     `H_2O`. `REF_SUP_CLASS_RE` is the shared predicate for the one `<sup>` kind both drop
//     instead of marking: `<sup class="mw-ref">` citation brackets ([1], [note 2]) are
//     retrieval noise.
//   • FOLDING — `foldSupSub` removes exactly the shapes that convention emits, and the
//     matchers run it over BOTH sides before they compare: `arm.ts`'s `queryTerms` /
//     `overlapScore` (question and chunk text) and `admit.ts`'s question/lead/wide inputs.
//     INVARIANT: the matchers see the flattened text they saw before #488, so every question
//     that matched an article then still matches it now. The markers change what is READ
//     (the packet, and `packs:getArticle`'s viewer text), never what is RETRIEVED.
//
// Emitting and folding live in ONE file on purpose: the two sides cannot drift apart, and a
// third shape can only be added by adding it to both.
//
// `_` is folded only before a DIGIT — deliberately narrower than `^`, which folds between any
// two alphanumerics. `_` is an ordinary identifier character in the code-oriented archives the
// packs carry (devdocs, gobyexample): folding `snake_case` into `snakecase` would change how
// those articles tokenise today, for no gain, since a chemistry subscript is always a digit.
// Letter subscripts (`x_i`) are left marked; both halves are below the matchers' 3-character
// term floor anyway, so nothing turns on them.
//
// See `math.ts`'s header for the sibling rule that is NOT changed by this: `<math alttext>`
// still normalises to PLAIN characters (`mv^{2}` → `mv2`, never `mv²`), because the tokeniser
// counts `₂`/`²` as `\p{N}` and a typed "CO2" could never match them. Folding a marker back
// out is cheap; folding a superscript codepoint back out is not.

/** Reference/citation superscripts: the `<sup>` kind both the prose and the table path drop
 *  whole rather than marking. Shared so the two paths cannot disagree about what a citation
 *  bracket is. */
export const REF_SUP_CLASS_RE = /\b(?:mw-ref|reference)\b/

/** Written immediately before an ordinary `<sup>`'s own text. */
export const SUP_MARK = '^'

/** Written immediately before a `<sub>`'s own text. */
export const SUB_MARK = '_'

/** A `^` BETWEEN two alphanumerics — exactly `m^2`, `10^6`, `g/cm^3`, `20^th`. A caret that
 *  starts a run (`^[note 1]`, `^®`) or stands alone (`a ^ b`) is not one this converter wrote
 *  in that position, so it is left alone. */
const SUP_FOLD_RE = /(?<=[\p{L}\p{N}])\^(?=[\p{L}\p{N}])/gu

/** A `_` after an alphanumeric and before a DIGIT — `H_2O`, `CO_2`, `Fe_2O_3`. Never before a
 *  letter (`snake_case`, `x_i`) and never at the start of a run (`_foo`). */
const SUB_FOLD_RE = /(?<=[\p{L}\p{N}])_(?=\p{N})/gu

/**
 * Remove the sup/sub markers the converter emits, so a matcher compares the same flattened
 * text it compared before #488 (`m^2` → `m2`, `10^6` → `106`, `H_2O` → `H2O`). Total and
 * allocation-free on text that carries neither marker — it runs per chunk on the ask path.
 */
export function foldSupSub(text: string): string {
  if (!text.includes(SUP_MARK) && !text.includes(SUB_MARK)) return text
  return text.replace(SUP_FOLD_RE, '').replace(SUB_FOLD_RE, '')
}
