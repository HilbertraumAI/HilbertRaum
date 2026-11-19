// Shared code-point-safe string cutting (audit 2026-07-16 F-15; the RAG-2 defect class), and the
// one rule for a suggested export file name (#899).
//
// A raw `String.slice(0, n)` counts UTF-16 CODE UNITS and can cut inside a surrogate pair (emoji,
// CJK ext-B, math symbols), leaving the string ending in a lone surrogate that renders as `�` and
// is mangled by every downstream UTF-8 conversion (SQLite, JSON/IPC well-formed-unicode passes).
// These helpers count and slice by CODE POINT, so the cut always lands on a code-point boundary.
// (`codePointSlice` and `truncateByCodePoints` cut code points, not graphemes — a combining mark can
// still be split, but that never produces an invalid string; their goal is only "never end
// mid-code-point". `fileNameStem` cuts between whole graphemes: a file name that ends in a letter
// without its vowel sign is misspelt.)
//
// A LEAF module by design: it is shared by rag/index.ts (truncateSnippet), analysis/coverage.ts and
// skills/analysis/common.ts (persisted citation snippets), doctasks/handlers/compare.ts, and the
// chat, document and evidence-pack exports (fileNameStem) — some of which rag/index.ts itself
// imports, so this must not import from any of them. `Intl.Segmenter` is a global, not an import.

/**
 * The leading `maxCodePoints` code points of `text` (never cutting a surrogate pair). Returns
 * `text` unchanged when it already fits.
 */
export function codePointSlice(text: string, maxCodePoints: number): string {
  const codePoints = [...text] // spreading iterates whole code points
  if (codePoints.length <= maxCodePoints) return text
  return codePoints.slice(0, maxCodePoints).join('')
}

/**
 * Cap `text` at `maxCodePoints` code points, appending `…` when it was cut — the shared
 * citation-snippet truncation shape (`length > cap ? head + '…' : text`), pair-safe.
 */
export function truncateByCodePoints(text: string, maxCodePoints: number): string {
  const cut = codePointSlice(text, maxCodePoints)
  return cut === text ? text : `${cut}…`
}


/** The longest suggested file-name stem, in code points. A cap in graphemes would be unbounded (one
 *  letter can carry any number of marks). 60 astral code points plus `-summary.md` are 251 UTF-8
 *  bytes, within the 255-byte name limit of ext4 and APFS, and at most 120 UTF-16 units on NTFS. */
export const FILE_NAME_STEM_MAX_CODE_POINTS = 60
/** Built on first use: only a user-started export needs it, and this leaf module loads with the RAG stack. */
let graphemes: Intl.Segmenter | undefined
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u
/** A letter, a combining mark (a vowel sign, an accent, a virama) or a number. */
const WORD_CHARACTER = /[\p{L}\p{M}\p{N}]/u
/** Any space, tab, line break or no-break space: it separates words, so it becomes a plain space. */
const WHITE_SPACE = /\p{White_Space}/gu
/** What a name does not start with: a space, `_` or `-` (a name starting with `-` reads as an option). */
const LEADING_SEPARATOR = ' _-'
/** What a name does not end with, right before its extension: a space, `_`, `-` or an opening `(`. */
const TRAILING_SEPARATORS = /[ _(-]+$/u
/** The names Windows reserves for devices, also when an extension follows (Microsoft's naming rules:
 *  `NUL.txt` is `NUL`). `\p{N}` keeps superscript digits, and `COM¹`–`COM³`, `LPT¹`–`LPT³` are
 *  reserved too. */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i

/**
 * The stem of a suggested export file name, built from a title (#899; the chat transcript, the
 * three document exports and the evidence pack). The title is CONTENT, which is why no caller
 * logs or audits the name. The rule:
 * - the title is composed first (NFC), so a decomposed one (macOS hands file names over that way)
 *   keeps its accents, and every space, tab, line break or no-break space becomes a plain space, so
 *   words never run together;
 * - it keeps letters, numbers, space, `_` and `-`, plus `(` `)` with `keepParens` (the document
 *   exports: a translation's title ends in "(Deutsch)"). A combining mark is kept only inside a
 *   character that holds a letter or number: a vowel sign stays, and so does the selector of a
 *   keycap (`1️⃣`) or of `ℹ️`, whose base is a number or letter; a mark whose base was stripped (a
 *   stripped emoji's variation selector, a leading accent) goes with it. Format characters go, ZWJ
 *   and ZWNJ included (a Sinhala or Persian joiner is lost; the letters stay);
 * - it holds at most `maxCodePoints` (60) code points, cut between whole characters (graphemes), so
 *   the cut never leaves half an astral letter or a letter without its vowel sign. A character that
 *   alone carries more marks than the whole cap keeps only its letter, so the rest of the title
 *   still counts;
 * - it never starts with a space, `_` or `-`, and never ends with one or with an opening `(` (the cut
 *   can land right after one), so nothing odd stands before the extension (#839);
 * - it is composed (NFC) again once built: dropping a joiner or a stripped character can leave a
 *   letter and a mark that compose. Composing never adds code points here (the title was composed
 *   before the cut, so no character NFC would decompose is in it), so the cap still holds;
 * - `fallback` when no letter or number is left;
 * - `_` appended to a name Windows reserves for a device (`CON`, `NUL`, `COM1`, …).
 */
export function fileNameStem(
  title: string,
  opts: { fallback: string; keepParens?: boolean; maxCodePoints?: number }
): string {
  const max = opts.maxCodePoints ?? FILE_NAME_STEM_MAX_CODE_POINTS
  const punctuation = opts.keepParens ? ' _-()' : ' _-'
  graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  let stem = ''
  let count = 0
  for (const { segment } of graphemes.segment(title.normalize('NFC').replace(WHITE_SPACE, ' '))) {
    const inWord = LETTER_OR_NUMBER.test(segment)
    let kept = [...segment].filter((c) => punctuation.includes(c) || (inWord && WORD_CHARACTER.test(c)))
    if (kept.length > max) kept = kept.filter((c) => LETTER_OR_NUMBER.test(c))
    if (kept.length === 0 || (count === 0 && kept.every((c) => LEADING_SEPARATOR.includes(c)))) continue
    if (count + kept.length > max) break
    stem += kept.join('')
    count += kept.length
  }
  stem = stem.normalize('NFC').replace(TRAILING_SEPARATORS, '')
  if (!LETTER_OR_NUMBER.test(stem)) return opts.fallback
  return WINDOWS_DEVICE_NAME.test(stem) ? `${stem}_` : stem
}
